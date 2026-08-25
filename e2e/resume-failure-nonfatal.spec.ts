/**
 * Credential-free browser e2e: an OPTIONAL resume failure must never take the
 * chat down.
 *
 * Prod, 2026-08-23: a visitor on smoo.ai saw "We couldn't reach the chat." under
 * a "Connection issue" header while the backend was fully healthy — driving
 * wss://ai.smoo.ai/ws by hand streamed replies every time. The failure was
 * entirely in the widget's connect path, on the RESUME probe, which is only ever
 * an enhancement: it recovers a returning anonymous visitor's prior thread.
 *
 * Two prod-shaped failures are pinned here, in the REAL rendered shadow DOM of
 * the BUILT bundle — which is where the visitor actually met the bug, and what
 * the controller unit tests could not see:
 *
 *   1. `/internal/resume-by-fingerprint` answers 401 `AUTH_CONTEXT_REQUIRED`.
 *      That route is fail-closed for any agent with a `public_key`, and the
 *      anonymous marketing widget sends no authContext — so 401 is the NORMAL
 *      steady state for a public agent, not an anomaly.
 *   2. The probe succeeds, and the follow-up `get_session` answers with an
 *      error-status `immediate_response` carrying no `data`. The operator client
 *      resolves that as `undefined` rather than rejecting, so the snapshot read
 *      threw a TypeError past `tryResume`'s catch and out of `connect()`.
 *
 * Either way the visitor must end up on a working session with a real reply, and
 * no error text may reach any render.
 *
 * Runs on every PR: no gateway key, no operator, no network.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { MOCK_WS } from './mock-ws';

const root = fileURLToPath(new URL('..', import.meta.url));
const GLOBAL_BUNDLE = readFileSync(`${root}/dist/chat-widget.global.js`, 'utf8');

const AGENT_ID = '2590dfd6-7ed5-484b-bfb4-6d83a97d5a8e';
const ENDPOINT = 'wss://ai.smoo.ai/ws';
const STATIC_ORIGIN = `http://127.0.0.1:${process.env.STATIC_PORT ?? 4830}`;

const FRESH_SESSION = 'b8e4f0a2-71c3-4d59-9a06-2f5c7d1e83b4';
const PROBED_SESSION = 'c9f5a1b3-82d4-4e6a-8b17-3a6d8e2f94c5';
const ANSWER = 'Yes — I can help you build that.';

/** The operator half of the mock: hand out a session id, then answer normally. */
function operatorScript(opts: { getSessionReply?: string; slowCreate?: boolean } = {}): string {
    return `
(() => {
  return (f, reply) => {
    if (f.action === 'get_session') {
      ${opts.getSessionReply ?? `reply({ type: 'immediate_response', requestId: f.requestId, status: 200, data: { sessionId: f.sessionId, status: 'active', agentId: f.agentId } });`}
      return;
    }
    if (f.action === 'get_conversation_messages') {
      reply({ type: 'immediate_response', requestId: f.requestId, status: 200, data: { messages: [], hasMore: false } });
      return;
    }
    if (f.action === 'create_conversation_session') {
      // A real create is not instantaneous. The delay is what opens the window
      // an awaiting caller used to resolve straight through.
      setTimeout(() => {
        reply({ type: 'immediate_response', requestId: f.requestId, status: 202,
          data: { sessionId: ${JSON.stringify(FRESH_SESSION)}, conversationId: 'conv-1', agentId: f.agentId } });
      }, ${opts.slowCreate ? 40 : 0});
      return;
    }
    if (f.action === 'send_message') {
      reply({ type: 'immediate_response', requestId: f.requestId, status: 202, data: {} });
      setTimeout(() => {
        reply({ type: 'stream_token', requestId: f.requestId, token: ${JSON.stringify(ANSWER)} });
        setTimeout(() => {
          reply({ type: 'eventual_response', requestId: f.requestId, status: 200,
            data: { data: { response: { responseParts: [${JSON.stringify(ANSWER)}] } } } });
        }, 5);
      }, 5);
      return;
    }
  };
})()`;
}

/**
 * Boot the built bundle against the mock with a given `/internal/*` responder,
 * open the panel, send one visitor message, and report every render along the
 * way (a bad frame that is later overwritten still reached the visitor's eyes).
 */
async function runVisitorTurn(
    page: import('@playwright/test').Page,
    opts: { httpScript: string; script: string },
): Promise<{ renders: string[]; sent: Array<Record<string, unknown>>; finalText: string; persistedSessionId: string | null }> {
    await page.addInitScript(MOCK_WS);
    await page.goto(`${STATIC_ORIGIN}/e2e/fixtures/blank.html`);
    await page.addScriptTag({ content: GLOBAL_BUNDLE });

    return page.evaluate(
        async ({ endpoint, agentId, scriptSrc, httpSrc }) => {
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            const w = window as unknown as {
                __sent: Array<Record<string, unknown>>;
                __script: unknown;
                __httpScript: unknown;
                SmoothAgentChat: { mount: (o: unknown) => Element };
            };
            localStorage.clear();
            // eslint-disable-next-line no-eval
            w.__script = eval(scriptSrc);
            // eslint-disable-next-line no-eval
            w.__httpScript = eval(httpSrc);

            const el = w.SmoothAgentChat.mount({ endpoint, agentId, greeting: '' });
            const shadow = (el as unknown as { shadowRoot: ShadowRoot }).shadowRoot;

            const renders: string[] = [];
            const snap = () =>
                renders.push(
                    Array.from(shadow.childNodes)
                        .filter((n) => n.nodeName !== 'STYLE')
                        .map((n) => n.textContent ?? '')
                        .join(' '),
                );
            new MutationObserver(snap).observe(shadow, { childList: true, subtree: true, characterData: true });
            snap();

            (shadow.querySelector('.launcher') as HTMLElement | null)?.click();
            for (let i = 0; i < 100; i++) {
                const status = (shadow.querySelector('.status-text') as HTMLElement | null)?.textContent ?? '';
                if (/ready|online/i.test(status)) break;
                await sleep(50);
            }

            const input = shadow.querySelector('textarea') as HTMLTextAreaElement;
            input.value = 'can you help me build a website';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            (shadow.querySelector('.send') as HTMLElement | null)?.click();

            let quiet = 0;
            let lastLen = -1;
            for (let i = 0; i < 200; i++) {
                await sleep(50);
                const streaming = !!shadow.querySelector('.bubble.assistant.streaming, .typing');
                if (!streaming && w.__sent.length === lastLen) {
                    if (++quiet >= 6) break;
                } else {
                    quiet = 0;
                }
                lastLen = w.__sent.length;
            }
            snap();

            const bubbles = Array.from(shadow.querySelectorAll('.bubble.assistant'));
            const persisted = localStorage.getItem(`smoo-chat-widget:${agentId}`);
            return {
                renders,
                sent: w.__sent,
                finalText: bubbles.map((b) => b.textContent ?? '').join(' '),
                persistedSessionId: persisted ? ((JSON.parse(persisted).state?.sessionId as string | null) ?? null) : null,
            };
        },
        { endpoint: ENDPOINT, agentId: AGENT_ID, scriptSrc: opts.script, httpSrc: opts.httpScript },
    );
}

/** No render — ever — may show the visitor that the chat is unavailable. */
function expectNoConnectionError(renders: string[]): void {
    const all = renders.join('\n---\n');
    for (const needle of ["couldn't reach the chat", 'Connection issue', 'Error:', 'AUTH_CONTEXT_REQUIRED']) {
        expect(all.includes(needle), `no render may contain ${JSON.stringify(needle)}; renders:\n${all}`).toBe(false);
    }
}

test('a 401 from /internal/resume-by-fingerprint still gives the visitor a working chat', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

    const { renders, sent, finalText, persistedSessionId } = await runVisitorTurn(page, {
        // The literal live-prod response for an agent with a public_key.
        httpScript: `(() => (path) => path === '/internal/resume-by-fingerprint'
            ? { status: 401, json: { error: { code: 'AUTH_CONTEXT_REQUIRED', message: 'this agent requires a signed authContext' } } }
            : { json: {} })()`,
        script: operatorScript(),
    });

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    // Degraded to a fresh session rather than failing the connect…
    expect(sent.filter((f) => f.action === 'create_conversation_session')).toHaveLength(1);
    expect(persistedSessionId).toBe(FRESH_SESSION);
    // …and the visitor got a real answer, with nothing scary on screen.
    expect(finalText).toContain(ANSWER);
    expectNoConnectionError(renders);
});

test('a data-less error reply to get_session on the probed session still gives the visitor a working chat', async ({ page }) => {
    // The prod defect: the probe resolves a session, `get_session` answers with an
    // error status and NO `data`, the client resolves `undefined` instead of
    // rejecting, and reading the snapshot threw past the resume path's catch.
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

    const { renders, sent, finalText, persistedSessionId } = await runVisitorTurn(page, {
        httpScript: `(() => (path) => path === '/internal/resume-by-fingerprint'
            ? { json: { resumable: true, sessionId: ${JSON.stringify(PROBED_SESSION)}, conversationId: 'conv-p' } }
            : { json: {} })()`,
        script: operatorScript({
            getSessionReply: `reply({ type: 'immediate_response', requestId: f.requestId, status: 500 });`,
        }),
    });

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    expect(sent.filter((f) => f.action === 'get_session')).toHaveLength(1);
    // Resume gave up and the visitor got a fresh session instead of an error.
    expect(sent.filter((f) => f.action === 'create_conversation_session')).toHaveLength(1);
    expect(persistedSessionId).toBe(FRESH_SESSION);
    expect(finalText).toContain(ANSWER);
    expectNoConnectionError(renders);
});

/**
 * The pre-chat race, in the REAL rendered UI (prod, smoo.ai, 2026-08-24).
 *
 * A clean visitor completed the pre-chat form, the status went "Online", and
 * every send then failed with "We couldn't reach the chat." The pre-chat submit
 * fires a fire-and-forget `void connect()`, and the visitor's first send awaited
 * another one milliseconds later — which resolved immediately, before any
 * session existed, so the turn went out (or died) against a session id the
 * server had never issued.
 *
 * smoo.ai's live config is `requireName: true, requireEmail: true`, so the
 * pre-chat gate is on the path every real visitor takes.
 */
test('the pre-chat submit → immediate send sequence never outruns its session', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

    await page.addInitScript(MOCK_WS);
    await page.goto(`${STATIC_ORIGIN}/e2e/fixtures/blank.html`);
    await page.addScriptTag({ content: GLOBAL_BUNDLE });

    const out = await page.evaluate(
        async ({ endpoint, agentId, scriptSrc }) => {
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            const w = window as unknown as {
                __sent: Array<Record<string, unknown>>;
                __script: unknown;
                SmoothAgentChat: { mount: (o: unknown) => Element };
            };
            localStorage.clear();
            // eslint-disable-next-line no-eval
            w.__script = eval(scriptSrc);

            // smoo.ai's live gate.
            const el = w.SmoothAgentChat.mount({ endpoint, agentId, greeting: '', requireName: true, requireEmail: true });
            const shadow = (el as unknown as { shadowRoot: ShadowRoot }).shadowRoot;

            (shadow.querySelector('.launcher') as HTMLElement).click();
            await sleep(150);
            for (const input of Array.from(shadow.querySelectorAll('.pc-form input')) as HTMLInputElement[]) {
                if (input.type === 'checkbox') continue;
                input.value = input.name === 'email' ? 'visitor@example.test' : 'Test Visitor';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            // Submit the gate and send AS SOON AS the composer accepts it — the
            // window in which the pre-chat's `void connect()` is still in flight.
            (shadow.querySelector('.pc-submit') as HTMLElement).click();
            let textarea: HTMLTextAreaElement | null = null;
            for (let i = 0; i < 200; i++) {
                textarea = shadow.querySelector('textarea');
                const send = shadow.querySelector('.send') as HTMLButtonElement | null;
                if (textarea && send && !send.disabled) break;
                await sleep(10);
            }
            if (!textarea) return { error: 'still gated' };
            textarea.value = 'can you help me build a website';
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            (shadow.querySelector('.send') as HTMLElement).click();

            let quiet = 0;
            let lastLen = -1;
            for (let i = 0; i < 200; i++) {
                await sleep(50);
                const streaming = !!shadow.querySelector('.bubble.assistant.streaming, .typing');
                if (!streaming && w.__sent.length === lastLen) {
                    if (++quiet >= 6) break;
                } else quiet = 0;
                lastLen = w.__sent.length;
            }

            return {
                order: w.__sent.map((f) => f.action as string),
                sendSessionIds: w.__sent.filter((f) => f.action === 'send_message').map((f) => f.sessionId as string),
                transcript: (shadow.querySelector('.messages') as HTMLElement | null)?.innerText ?? '',
                status: (shadow.querySelector('.status-text') as HTMLElement | null)?.textContent ?? '',
            };
        },
        { endpoint: ENDPOINT, agentId: AGENT_ID, scriptSrc: operatorScript({ slowCreate: true }) },
    );

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    expect(out.error).toBeUndefined();
    // Exactly one session, created BEFORE the turn that references it — not the
    // inverted order the live socket trace showed.
    expect(out.order).toEqual(['create_conversation_session', 'send_message']);
    // The turn carried the id the server actually issued, so no SESSION_NOT_FOUND
    // and therefore no recovery loop.
    expect(out.sendSessionIds).toEqual([FRESH_SESSION]);
    expect(out.transcript).toContain(ANSWER);
    expect(out.transcript).not.toContain("couldn't reach the chat");
    expect(out.status).not.toContain('Connection issue');
});
