/**
 * Feature gap G5 — the streaming guarantee, credential-free.
 *
 * `repro-stream-mock.spec.ts` asserts the FINAL assistant text renders. That
 * assertion passes even if the widget ignores every `stream_token` frame and
 * paints only the `eventual_response` blob — i.e. it cannot detect the single
 * most likely silent regression: streaming stopping.
 *
 * This spec closes that hole. The mock operator emits `stream_token` frames on
 * a timer and withholds `eventual_response` for FINAL_DELAY_MS. Everything the
 * test asserts is sampled INSIDE that window, so the only frames that can have
 * produced on-screen text are the stream tokens. A widget that batches to the
 * final response renders nothing here and the test fails.
 *
 * No credentials, no network, no Rust server — runs on every PR.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const GLOBAL_BUNDLE = readFileSync(`${root}/dist/chat-widget.global.js`, 'utf8');

const AGENT_ID = '2590dfd6-7ed5-484b-bfb4-6d83a97d5a8e';
const ENDPOINT = 'wss://ai.smoo.ai/ws';

const TOKENS = ['Streaming', ' arrives', ' one token', ' at a time.'];
const STREAMED_TEXT = TOKENS.join('');
/** Gap between tokens; wide enough that sampling sees partial states. */
const TOKEN_GAP_MS = 120;
/** `eventual_response` is withheld this long — all assertions sample before it. */
const FINAL_DELAY_MS = 6000;
/** How long the in-page sampler records for. Must stay < FINAL_DELAY_MS. */
const SAMPLE_MS = 2000;

const MOCK_WS = `
(() => {
  const TOKENS = ${JSON.stringify(TOKENS)};
  class MockWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this._listeners = { open: [], message: [], close: [], error: [] };
      setTimeout(() => { this.readyState = 1; this._emit('open', {}); }, 5);
    }
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) {
      const a = this._listeners[type]; if (!a) return;
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    }
    _emit(type, ev) { for (const fn of (this._listeners[type] || []).slice()) fn(ev); }
    _msg(obj) { this._emit('message', { data: JSON.stringify(obj) }); }
    send(raw) {
      let frame; try { frame = JSON.parse(raw); } catch { return; }
      const requestId = frame.requestId;
      if (frame.action === 'create_conversation_session') {
        this._msg({ type: 'immediate_response', requestId, status: 202,
          data: { sessionId: 'sess-stream-1', agentId: frame.agentId } });
        return;
      }
      if (frame.action === 'send_message') {
        this._msg({ type: 'immediate_response', requestId, status: 202, data: {} });
        let i = 0;
        const next = () => {
          if (i < TOKENS.length) {
            this._msg({ type: 'stream_token', requestId, token: TOKENS[i] });
            i++;
            setTimeout(next, ${TOKEN_GAP_MS});
          }
        };
        setTimeout(next, ${TOKEN_GAP_MS});
        // Withheld: anything on screen before this fires came from stream_token.
        setTimeout(() => {
          this._msg({ type: 'eventual_response', requestId, status: 200, data: { data: {
            response: { responseParts: [${JSON.stringify(STREAMED_TEXT)}] },
            citations: [],
          } } });
        }, ${FINAL_DELAY_MS});
        return;
      }
    }
    close() { this.readyState = 3; this._emit('close', { code: 1000, reason: '' }); }
  }
  MockWS.CONNECTING = 0; MockWS.OPEN = 1; MockWS.CLOSING = 2; MockWS.CLOSED = 3;
  window.WebSocket = MockWS;
})();
`;

test.beforeEach(async ({ page }) => {
    // Keep the spec hermetic: the widget POSTs /internal/resume-by-fingerprint
    // on mount, which would otherwise be a real request to production.
    await page.route('**/internal/**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ resumable: false }) }),
    );
});

test('assistant tokens render incrementally, before the final response arrives', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
    page.on('console', (m) => {
        if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`);
    });

    await page.addInitScript(MOCK_WS);
    await page.goto('about:blank');
    await page.addScriptTag({ content: GLOBAL_BUNDLE });

    const snapshots = await page.evaluate(
        async ({ endpoint, agentId, sampleMs }) => {
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            // @ts-expect-error injected global
            const el = window.SmoothAgentChat.mount({ endpoint, agentId, greeting: '' });
            const root = (el as { shadowRoot: ShadowRoot }).shadowRoot;

            (root.querySelector('.launcher') as HTMLElement | null)?.click();
            for (let i = 0; i < 100; i++) {
                const status = (root.querySelector('.status-text') as HTMLElement | null)?.textContent ?? '';
                if (/ready|online/i.test(status)) break;
                await sleep(20);
            }

            const input = root.querySelector('textarea') as HTMLTextAreaElement | null;
            if (!input) return { error: 'no-input', seen: [] as string[] };
            input.value = 'hi';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            (root.querySelector('.send') as HTMLElement | null)?.click();

            // Sample the assistant bubble; record each distinct non-empty state.
            const seen: string[] = [];
            const deadline = Date.now() + sampleMs;
            while (Date.now() < deadline) {
                const bubbles = Array.from(root.querySelectorAll('.bubble.assistant'));
                const text = (bubbles[bubbles.length - 1]?.textContent ?? '').trim();
                if (text && text !== seen[seen.length - 1]) seen.push(text);
                await sleep(20);
            }
            return { seen };
        },
        { endpoint: ENDPOINT, agentId: AGENT_ID, sampleMs: SAMPLE_MS },
    );

    console.log('streaming snapshots:', JSON.stringify(snapshots, null, 2));

    expect(pageErrors, `page errors:\n${pageErrors.join('\n---\n')}`).toEqual([]);
    expect(snapshots.error, `controller error: ${snapshots.error}`).toBeUndefined();

    const seen = snapshots.seen ?? [];

    // 1. Tokens rendered at all — and they did so before `eventual_response`.
    expect(seen.length, 'assistant text must appear from stream_token frames alone').toBeGreaterThan(0);

    // 2. INCREMENTAL: more than one distinct state was on screen. A widget that
    //    waits and paints once would produce exactly one snapshot.
    expect(seen.length, `expected growing partial states, saw: ${JSON.stringify(seen)}`).toBeGreaterThan(1);

    // 3. At least one state was a STRICT PREFIX of the full text — i.e. the user
    //    genuinely saw a partial reply, not the completed string twice.
    const strictPrefixes = seen.filter((s) => STREAMED_TEXT.startsWith(s) && s.length < STREAMED_TEXT.length);
    expect(strictPrefixes.length, `no strict prefix of the reply was ever rendered; saw: ${JSON.stringify(seen)}`).toBeGreaterThan(0);

    // 4. Monotonic growth — each state extends the previous one.
    for (let i = 1; i < seen.length; i++) {
        const prev = seen[i - 1] ?? '';
        const cur = seen[i] ?? '';
        expect(cur.startsWith(prev), `snapshot ${i} ("${cur}") must extend ("${prev}")`).toBe(true);
    }

    // 5. The stream completed to the full text, still before the final frame.
    expect(seen[seen.length - 1]).toBe(STREAMED_TEXT);
});
