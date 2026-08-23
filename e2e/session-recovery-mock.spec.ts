/**
 * Credential-free browser e2e for the prod incident of 2026-08-23: a visitor on
 * smoo.ai was shown `Error: session '<uuid>' not found` in what looks like an
 * AGENT BUBBLE, and every retry re-sent into the same dead session.
 *
 * The unit tests in src/conversation.test.ts cover the controller. Nothing
 * covered the thing the visitor actually saw — the RENDERED transcript of the
 * built bundle — and the CI e2e (`E2E_CREDENTIAL_FREE=1`) excludes every spec
 * that can see backend error behaviour, so no PR check could have caught it.
 *
 * These specs load the BUILT global bundle into real Chromium, drive the REAL
 * shadow-DOM UI, and impersonate an operator that fails `send_message`. A
 * MutationObserver records EVERY render of the widget (not just the end state),
 * because the bug was visible text — a snapshot that only inspects the settled
 * DOM would miss a bad frame that later gets overwritten.
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

// Session ids shaped like the real ones (UUIDs), so "the transcript never leaks
// a session UUID" is a meaningful assertion rather than a string-length accident.
const DEAD_SESSION = '3f7c1a92-0b44-4d17-9c2e-8ad51e6b0f31';
const FRESH_SESSION = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const LIVE_SESSION = '7d2e9f01-4c88-4b3a-9f21-16c0d8e4a7b9';
const ANSWER = 'Yes — I can help you build that.';

/**
 * Boot a page with the mock installed, the built bundle loaded, the given
 * operator script in place, a transcript recorder attached, and one visitor
 * message sent. Returns everything the assertions need.
 */
async function runVisitorTurn(
    page: import('@playwright/test').Page,
    script: string,
): Promise<{ renders: string[]; sent: Array<Record<string, unknown>>; finalText: string; persistedSessionId: string | null }> {
    await page.addInitScript(MOCK_WS);
    // A real origin (not about:blank) so the widget's localStorage persistence,
    // which is what holds the session pointer, actually works.
    await page.goto(`${STATIC_ORIGIN}/e2e/fixtures/blank.html`);
    await page.addScriptTag({ content: GLOBAL_BUNDLE });

    return page.evaluate(
        async ({ endpoint, agentId, scriptSrc }) => {
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            const w = window as unknown as { __sent: Array<Record<string, unknown>>; __script: unknown; SmoothAgentChat: { mount: (o: unknown) => Element } };
            localStorage.clear();
            // eslint-disable-next-line no-eval
            w.__script = eval(scriptSrc);

            const el = w.SmoothAgentChat.mount({ endpoint, agentId, greeting: '' });
            const shadow = (el as unknown as { shadowRoot: ShadowRoot }).shadowRoot;

            // Record EVERY render, not just the settled one. `textContent` of the
            // whole shadow tree covers bubbles, the typing slot AND the status
            // label — a raw backend string must not surface in any of them.
            // (`<style>` is skipped — it is constant, and dumping ~10kB of CSS
            // per snapshot on failure buries the text that actually matters.)
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

            // Settle: wait until the assistant bubble stops streaming AND the
            // frame traffic has gone quiet, so a recovery re-send is included.
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
        { endpoint: ENDPOINT, agentId: AGENT_ID, scriptSrc: script },
    );
}

/** Assert no render — ever — leaked backend internals into the widget UI. */
function expectNoLeakedInternals(renders: string[], ...forbidden: string[]): void {
    const all = renders.join('\n---\n');
    for (const needle of [...forbidden, 'Error:']) {
        expect(all.includes(needle), `no render may contain ${JSON.stringify(needle)}; renders:\n${all}`).toBe(false);
    }
}

/**
 * Operator impersonation. `create_conversation_session` hands out ids from
 * `ids` in order; `send_message` fails with `code` while the frame targets a
 * session in `deadSessions`, and otherwise answers normally.
 */
function operatorScript(opts: { ids: string[]; deadSessions: string[]; code: string; message: string }): string {
    return `
(() => {
  const ids = ${JSON.stringify(opts.ids)};
  const dead = ${JSON.stringify(opts.deadSessions)};
  let created = 0;
  return (f, reply) => {
    if (f.action === 'create_conversation_session') {
      const sessionId = ids[Math.min(created++, ids.length - 1)];
      reply({ type: 'immediate_response', requestId: f.requestId, status: 202,
        data: { sessionId, conversationId: 'conv-' + sessionId, agentId: f.agentId } });
      return;
    }
    if (f.action === 'send_message') {
      reply({ type: 'immediate_response', requestId: f.requestId, status: 202, data: {} });
      if (dead.includes(f.sessionId)) {
        reply({ type: 'error', requestId: f.requestId,
          data: { requestId: f.requestId, error: { code: ${JSON.stringify(opts.code)}, message: ${JSON.stringify(opts.message)} } } });
        return;
      }
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

test('a dead session is replaced and the turn re-sent — the visitor is answered, never shown the raw error', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

    const { renders, sent, finalText, persistedSessionId } = await runVisitorTurn(
        page,
        operatorScript({
            ids: [DEAD_SESSION, FRESH_SESSION],
            deadSessions: [DEAD_SESSION],
            code: 'SESSION_NOT_FOUND',
            message: `session '${DEAD_SESSION}' not found`,
        }),
    );

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);

    // The stale pointer was replaced with a fresh session…
    expect(sent.filter((f) => f.action === 'create_conversation_session')).toHaveLength(2);
    expect(persistedSessionId).toBe(FRESH_SESSION);
    // …and the visitor's turn was re-sent into it rather than the dead one.
    expect(sent.filter((f) => f.action === 'send_message').map((f) => f.sessionId)).toEqual([DEAD_SESSION, FRESH_SESSION]);
    // The visitor got an actual answer.
    expect(finalText).toContain(ANSWER);

    // And at NO point did the transcript show the backend string, the dead
    // session UUID, or an `Error:` prefix — this is the bit the visitor saw.
    expectNoLeakedInternals(renders, 'not found', DEAD_SESSION);
});

// A storage blip is not "this session is dead". Spinning up a new session there
// would abandon a live conversation the visitor can still come back to.
for (const code of ['STORAGE_ERROR', 'INTERNAL_ERROR']) {
    test(`${code} keeps the existing session — no new session, no re-send, no raw error on screen`, async ({ page }) => {
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

        const rawMessage = `boom: ${code} on session '${LIVE_SESSION}'`;
        const { renders, sent, finalText, persistedSessionId } = await runVisitorTurn(
            page,
            operatorScript({ ids: [LIVE_SESSION, FRESH_SESSION], deadSessions: [LIVE_SESSION, FRESH_SESSION], code, message: rawMessage }),
        );

        expect(pageErrors, pageErrors.join('\n')).toEqual([]);

        // The session survives, pointer and all — and the turn is not re-sent
        // (a retry would double-charge a turn that may have run server-side).
        expect(sent.filter((f) => f.action === 'create_conversation_session')).toHaveLength(1);
        expect(persistedSessionId).toBe(LIVE_SESSION);
        expect(sent.filter((f) => f.action === 'send_message')).toHaveLength(1);

        // The visitor sees one short human sentence, not the internal string.
        // Leak first: it is the assertion the incident was about, and a failure
        // here must be what the report shows rather than being masked by the
        // friendly-text check that fails for the same reason.
        expectNoLeakedInternals(renders, 'boom', LIVE_SESSION);
        expect(finalText).toContain("We couldn't reach the chat.");
    });
}

test('a server that keeps saying not-found is retried exactly once, and still never leaks the error', async ({ page }) => {
    // The prod shape with recovery ALSO failing: this is the only scenario where
    // the visitor reaches renderTurnFailure holding a SESSION_NOT_FOUND, i.e. the
    // exact string (`session '<uuid>' not found`) they were shown on 2026-08-23.
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

    const { renders, sent, finalText } = await runVisitorTurn(
        page,
        operatorScript({
            ids: [DEAD_SESSION, FRESH_SESSION],
            deadSessions: [DEAD_SESSION, FRESH_SESSION],
            code: 'SESSION_NOT_FOUND',
            message: `session '${DEAD_SESSION}' not found`,
        }),
    );

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);

    // Exactly one recovery attempt — a not-found loop must not spin sessions.
    expect(sent.filter((f) => f.action === 'create_conversation_session')).toHaveLength(2);
    expect(sent.filter((f) => f.action === 'send_message')).toHaveLength(2);

    expectNoLeakedInternals(renders, 'not found', DEAD_SESSION);
    expect(finalText).toContain("We couldn't reach the chat.");
});
