/**
 * Headless reproduction of the global-bundle streaming bug.
 *
 * We replace window.WebSocket with a deterministic mock that emits the EXACT
 * frame sequence the live operator sends for a grounded turn:
 *   immediate_response{status:202}  (create_conversation_session)
 *   immediate_response{status:202}  (send_message ack)
 *   stream_token x3
 *   eventual_response{ data.data.{ response.responseParts, citations } }
 *
 * The test loads the BUILT bundle into a real Chromium page, mounts the widget,
 * drives the REAL shadow-DOM UI (open launcher, type, click send), and asserts
 * the streamed assistant text + citation render. Both the IIFE global bundle and
 * the ESM build are exercised with the same mock to isolate the divergence.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const GLOBAL_BUNDLE = readFileSync(`${root}/dist/chat-widget.global.js`, 'utf8');

const AGENT_ID = '2590dfd6-7ed5-484b-bfb4-6d83a97d5a8e';
const ENDPOINT = 'wss://ai.smoo.ai/ws';

// Mock WebSocket installed before any widget code runs. It parses outbound
// frames, correlates by requestId, and replays the operator's frame sequence.
const MOCK_WS = `
(() => {
  const TOKENS = ['Hello', ', this is ', 'a streamed reply.'];
  class MockWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      this._listeners = { open: [], message: [], close: [], error: [] };
      setTimeout(() => {
        this.readyState = 1; // OPEN
        this._emit('open', {});
      }, 5);
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
          data: { sessionId: 'sess-mock-1', agentId: frame.agentId } });
        return;
      }
      if (frame.action === 'send_message') {
        this._msg({ type: 'immediate_response', requestId, status: 202, data: {} });
        let i = 0;
        const next = () => {
          if (i < TOKENS.length) {
            this._msg({ type: 'stream_token', requestId, token: TOKENS[i] });
            i++;
            setTimeout(next, 5);
          } else {
            this._msg({ type: 'eventual_response', requestId, status: 200, data: { data: {
              response: { responseParts: ['Hello, this is a streamed reply.'] },
              citations: [{ id: 'c1', title: 'Knowledge Doc', snippet: 'grounding', score: 0.9, url: 'https://smoo.ai/doc' }],
            } } });
          }
        };
        setTimeout(next, 5);
        return;
      }
    }
    close() { this.readyState = 3; this._emit('close', { code: 1000, reason: '' }); }
  }
  MockWS.CONNECTING = 0; MockWS.OPEN = 1; MockWS.CLOSING = 2; MockWS.CLOSED = 3;
  window.WebSocket = MockWS;
})();
`;

test('GLOBAL bundle streams a grounded turn end-to-end (real UI)', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}\n${e.stack ?? ''}`));
    page.on('console', (m) => {
        if (m.type() === 'error') pageErrors.push(`console.error: ${m.text()}`);
    });

    await page.addInitScript(MOCK_WS);
    await page.goto('about:blank');
    await page.addScriptTag({ content: GLOBAL_BUNDLE });

    // Mount + drive the REAL shadow-DOM UI exactly as a visitor would.
    const result = await page.evaluate(
        async ({ endpoint, agentId }) => {
            const out: { error?: string; text?: string; citations?: number; status?: string } = {};
            try {
                // @ts-expect-error injected global
                const el = window.SmoothAgentChat.mount({ endpoint, agentId, greeting: '' });
                const root = (el as any).shadowRoot as ShadowRoot;
                const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

                // Open the panel.
                (root.querySelector('.launcher') as HTMLElement | null)?.click();
                // Wait for status to reach ready (session created).
                for (let i = 0; i < 100; i++) {
                    const status = (root.querySelector('.status-text') as HTMLElement | null)?.textContent ?? '';
                    if (/ready|online/i.test(status)) break;
                    await sleep(50);
                }
                const input = root.querySelector('textarea') as HTMLTextAreaElement | null;
                if (!input) {
                    out.error = 'no-input';
                    return out;
                }
                input.value = 'hi';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                (root.querySelector('.send') as HTMLElement | null)?.click();

                // Wait for the streamed assistant text to settle.
                for (let i = 0; i < 100; i++) {
                    const bubbles = Array.from(root.querySelectorAll('.bubble.assistant'));
                    const text = bubbles.map((b) => b.textContent ?? '').join(' ');
                    if (/streamed reply/.test(text)) break;
                    await sleep(50);
                }
                const bubbles = Array.from(root.querySelectorAll('.bubble.assistant'));
                out.text = bubbles.map((b) => (b as HTMLElement).textContent ?? '').join(' ');
                out.citations = root.querySelectorAll('.sources a, .source, .citation').length;
                out.status = (root.querySelector('.status-text') as HTMLElement | null)?.textContent ?? '';
                return out;
            } catch (e: any) {
                out.error = `${e?.name}: ${e?.message}\n${e?.stack}`;
                return out;
            }
        },
        { endpoint: ENDPOINT, agentId: AGENT_ID },
    );

    console.log('GLOBAL result:', JSON.stringify(result, null, 2));
    console.log('PAGE ERRORS:', JSON.stringify(pageErrors, null, 2));

    expect(pageErrors, `page errors:\n${pageErrors.join('\n---\n')}`).toEqual([]);
    expect(result.error, `controller error: ${result.error}`).toBeUndefined();
    expect(result.text ?? '').toContain('streamed reply');
});
