/**
 * Live-prod reproduction of the global-bundle streaming bug.
 *
 * Drives the BUILT dist/chat-widget.global.js against the real prod operator
 * (wss://ai.smoo.ai/ws, agent 2590dfd6-…) from a page whose Origin is spoofed to
 * https://smoo.ai (so the operator's Origin allowlist passes). It mounts the
 * widget, opens the panel, types, clicks Send, and asserts a streamed reply
 * renders — the exact path that fails in prod with "Connection issue".
 *
 * Gated on SMOOTH_AGENT_PROD_E2E=1 (hits live prod, no key needed for this agent).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const GLOBAL_BUNDLE = readFileSync(`${root}/dist/chat-widget.global.js`, 'utf8');

const AGENT_ID = '2590dfd6-7ed5-484b-bfb4-6d83a97d5a8e';
const ENDPOINT = 'wss://ai.smoo.ai/ws';
const ORIGIN = 'https://smoo.ai';

const ENABLED = process.env.SMOOTH_AGENT_PROD_E2E === '1';

test('GLOBAL bundle streams against live prod operator', async ({ page }) => {
    test.skip(!ENABLED, 'Set SMOOTH_AGENT_PROD_E2E=1 to hit the live prod operator.');

    const consoleLines: string[] = [];
    page.on('console', (m) => consoleLines.push(`[console:${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

    // Serve a blank document AT the smoo.ai origin so the WS handshake's Origin
    // header is https://smoo.ai (operator allowlist).
    await page.route(`${ORIGIN}/`, (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' }),
    );
    await page.goto(`${ORIGIN}/`);
    await page.addScriptTag({ content: GLOBAL_BUNDLE });

    const result = await page.evaluate(
        async ({ endpoint, agentId }) => {
            const out: { error?: string; text?: string; status?: string; sources?: number } = {};
            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
            try {
                // @ts-expect-error injected global
                const el = window.SmoothAgentChat.mount({ endpoint, agentId, greeting: '' });
                const r = (el as any).shadowRoot as ShadowRoot;
                (r.querySelector('.launcher') as HTMLElement | null)?.click();
                for (let i = 0; i < 200; i++) {
                    const s = (r.querySelector('.status-text') as HTMLElement | null)?.textContent ?? '';
                    if (/ready|online/i.test(s)) break;
                    await sleep(100);
                }
                const input = r.querySelector('textarea') as HTMLTextAreaElement | null;
                if (!input) return { error: 'no-input' };
                input.value = 'What is SmooAI? Answer briefly.';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                (r.querySelector('.send') as HTMLElement | null)?.click();

                for (let i = 0; i < 300; i++) {
                    const bubbles = Array.from(r.querySelectorAll('.bubble.assistant'));
                    const text = bubbles.map((b) => (b as HTMLElement).textContent ?? '').join(' ').trim();
                    // Stop once we have a non-empty, non-error assistant reply.
                    if (text.length > 0 && !/connection issue|couldn.t reach|^error:/i.test(text)) {
                        // give the stream a moment to finish
                        await sleep(800);
                        break;
                    }
                    if (/connection issue|couldn.t reach|^error:/i.test(text)) break;
                    await sleep(200);
                }
                const bubbles = Array.from(r.querySelectorAll('.bubble.assistant'));
                out.text = bubbles.map((b) => (b as HTMLElement).textContent ?? '').join(' | ').trim();
                out.sources = r.querySelectorAll('.sources a, .source').length;
                out.status = (r.querySelector('.status-text') as HTMLElement | null)?.textContent ?? '';
                return out;
            } catch (e: any) {
                return { error: `${e?.name}: ${e?.message}\n${e?.stack}` };
            }
        },
        { endpoint: ENDPOINT, agentId: AGENT_ID },
    );

    console.log('PROD result:', JSON.stringify(result, null, 2));
    console.log('CONSOLE:\n' + consoleLines.join('\n'));

    expect(result.error, `error: ${result.error}`).toBeUndefined();
    expect(result.text ?? '', 'assistant reply should not be a connection error').not.toMatch(/connection issue|couldn.t reach/i);
    expect((result.text ?? '').length, 'assistant reply should be non-empty').toBeGreaterThan(5);
});
