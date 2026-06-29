/**
 * Headless mock-WS coverage for the 0.7.0 identity / persistence / consent layer
 * (ADR-048, SMOODEV-2129e). Loads the BUILT global bundle into a real Chromium
 * page, drives the REAL shadow-DOM UI, and asserts:
 *
 *   1. consent checkboxes + phone produce the exact metadata payload, and the
 *      fingerprint rides create_conversation_session;
 *   2. persist → reload → resume replays server history and reuses the sessionId;
 *   3. an ended session clears the pointer and starts a fresh session;
 *   4. the cross-device request → verify → resolve → replay flow.
 *
 * A scriptable mock WebSocket (installed via addInitScript) captures outbound
 * frames on `window.__sent` and replays operator-shaped responses keyed by
 * action. localStorage persists across the in-page "reload" (same origin), which
 * is what the resume path reads.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const GLOBAL_BUNDLE = readFileSync(`${root}/dist/chat-widget.global.js`, 'utf8');

const AGENT_ID = '2590dfd6-7ed5-484b-bfb4-6d83a97d5a8e';
const ENDPOINT = 'wss://ai.smoo.ai/ws';

/**
 * The mock WebSocket (records WS frames on window.__sent, routes via
 * window.__script) PLUS a mocked fetch for the chat-ws `/internal/*` routes
 * (records calls on window.__http, routes via window.__httpScript(path, body) →
 * { status?, json }; default = resume:false).
 */
const MOCK_WS = `
(() => {
  window.__sent = [];
  window.__http = [];
  class MockWS {
    constructor(url) {
      this.url = url; this.readyState = 0;
      this._l = { open: [], message: [], close: [], error: [] };
      setTimeout(() => { this.readyState = 1; this._emit('open', {}); }, 3);
    }
    addEventListener(t, fn) { (this._l[t] ||= []).push(fn); }
    removeEventListener(t, fn) { const a = this._l[t]; if (a) { const i = a.indexOf(fn); if (i>=0) a.splice(i,1); } }
    _emit(t, ev) { for (const fn of (this._l[t]||[]).slice()) fn(ev); }
    _msg(o) { this._emit('message', { data: JSON.stringify(o) }); }
    send(raw) {
      let f; try { f = JSON.parse(raw); } catch { return; }
      window.__sent.push(f);
      (window.__script || (()=>{}))(f, (o) => this._msg(o));
    }
    close() { this.readyState = 3; this._emit('close', { code: 1000, reason: '' }); }
  }
  MockWS.CONNECTING=0; MockWS.OPEN=1; MockWS.CLOSING=2; MockWS.CLOSED=3;
  window.WebSocket = MockWS;

  window.fetch = async (url, init) => {
    const u = new URL(url, location.href);
    const body = init && init.body ? JSON.parse(init.body) : {};
    window.__http.push({ path: u.pathname, body, origin: u.origin, credentials: init && init.credentials });
    const route = (window.__httpScript || (() => ({ json: { resumable: false } })));
    const { status = 200, json = {} } = route(u.pathname, body) || {};
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
})();
`;

const sleep = `(ms) => new Promise((r) => setTimeout(r, ms))`;

test('consent + phone + fingerprint produce the exact create_conversation_session payload', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

    await page.addInitScript(MOCK_WS);
    await page.goto(`http://127.0.0.1:${process.env.STATIC_PORT ?? 4830}/e2e/fixtures/demo.html`).catch(async () => {
        await page.goto('about:blank');
    });
    await page.addScriptTag({ content: GLOBAL_BUNDLE });

    const result = await page.evaluate(
        async ({ endpoint, agentId }) => {
            const sleepFn = (ms: number) => new Promise((r) => setTimeout(r, ms));
            try {
                localStorage.clear();
            } catch {
                /* ignore */
            }
            (window as unknown as { __script: unknown }).__script = (f: Record<string, unknown>, reply: (o: unknown) => void) => {
                if (f.action === 'create_conversation_session') {
                    reply({ type: 'immediate_response', requestId: f.requestId, status: 202, data: { sessionId: 'sess-A', conversationId: 'c', agentId: f.agentId } });
                }
            };
            // Require name+email so the pre-chat form gates; phone + consent ride along.
            // @ts-expect-error injected global
            const el = window.SmoothAgentChat.mount({ endpoint, agentId, greeting: '', requireName: true, requireEmail: true });
            const root = (el as { shadowRoot: ShadowRoot }).shadowRoot;
            (root.querySelector('.launcher') as HTMLElement | null)?.click();
            await sleepFn(30);

            // Fill the pre-chat form: name, email, phone, tick both consent boxes.
            (root.querySelector('input[name=name]') as HTMLInputElement).value = 'Ada';
            (root.querySelector('input[name=email]') as HTMLInputElement).value = 'ada@example.com';
            (root.querySelector('input[name=phone]') as HTMLInputElement).value = '+15551234567';
            (root.querySelector('input[name=emailOptIn]') as HTMLInputElement).checked = true;
            (root.querySelector('input[name=smsOptIn]') as HTMLInputElement).checked = true;
            // Dispatch a real submit event the handler listens for.
            (root.querySelector('.pc-form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

            for (let i = 0; i < 80; i++) {
                if ((window as unknown as { __sent: Record<string, unknown>[] }).__sent.some((s) => s.action === 'create_conversation_session')) break;
                await sleepFn(25);
            }
            const sent = (window as unknown as { __sent: Record<string, unknown>[] }).__sent;
            return sent.find((s) => s.action === 'create_conversation_session') ?? null;
        },
        { endpoint: ENDPOINT, agentId: AGENT_ID },
    );

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    expect(result, 'create_conversation_session was sent').toBeTruthy();
    const create = result as Record<string, unknown>;
    expect(create.userName).toBe('Ada');
    expect(create.userEmail).toBe('ada@example.com');
    expect(typeof create.browserFingerprint).toBe('string');
    const meta = create.metadata as Record<string, unknown>;
    expect(meta.userPhone).toBe('+15551234567');
    const consent = meta.consent as Record<string, unknown>;
    expect(consent.emailOptIn).toBe(true);
    expect(consent.smsOptIn).toBe(true);
    expect(consent.consentSource).toBe('chat-widget-prechat');
    expect(typeof consent.consentAt).toBe('string');
});

test('persist → reload → resume replays history and reuses the sessionId', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

    await page.addInitScript(MOCK_WS);
    // Serve a real origin so localStorage persists across the reload.
    await page.goto(`http://127.0.0.1:${process.env.STATIC_PORT ?? 4830}/e2e/fixtures/demo.html`).catch(async () => {
        await page.goto('about:blank');
    });
    await page.addScriptTag({ content: GLOBAL_BUNDLE });

    // --- First visit: create a session + exchange one turn. ---
    await page.evaluate(
        async ({ endpoint, agentId }) => {
            const s = (ms: number) => new Promise((r) => setTimeout(r, ms));
            (window as unknown as { __script: unknown }).__script = (f: Record<string, unknown>, reply: (o: unknown) => void) => {
                if (f.action === 'create_conversation_session') reply({ type: 'immediate_response', requestId: f.requestId, status: 202, data: { sessionId: 'sess-RESUME', conversationId: 'c', agentId: f.agentId } });
                else if (f.action === 'send_message') {
                    reply({ type: 'immediate_response', requestId: f.requestId, status: 202, data: {} });
                    reply({ type: 'eventual_response', requestId: f.requestId, status: 200, data: { requestId: f.requestId, status: 200, data: { messageId: 'm1', response: { responseParts: ['First answer'] } } } });
                }
            };
            // @ts-expect-error injected global
            const el = window.SmoothAgentChat.mount({ endpoint, agentId, greeting: '' });
            const root = (el as { shadowRoot: ShadowRoot }).shadowRoot;
            (root.querySelector('.launcher') as HTMLElement | null)?.click();
            for (let i = 0; i < 60; i++) {
                if (/online|ready/i.test((root.querySelector('.status-text') as HTMLElement | null)?.textContent ?? '')) break;
                await s(25);
            }
            const input = root.querySelector('textarea') as HTMLTextAreaElement;
            input.value = 'hi';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            (root.querySelector('.send') as HTMLElement | null)?.click();
            await s(120);
            el.remove();
        },
        { endpoint: ENDPOINT, agentId: AGENT_ID },
    );

    // --- Second visit (simulated reload): a NEW widget reads persisted state. ---
    const result = await page.evaluate(
        async ({ endpoint, agentId }) => {
            const s = (ms: number) => new Promise((r) => setTimeout(r, ms));
            (window as unknown as { __sent: Record<string, unknown>[] }).__sent = [];
            (window as unknown as { __script: unknown }).__script = (f: Record<string, unknown>, reply: (o: unknown) => void) => {
                if (f.action === 'get_session') reply({ type: 'immediate_response', requestId: f.requestId, status: 200, data: { sessionId: f.sessionId, status: 'active', agentId } });
                else if (f.action === 'get_conversation_messages')
                    reply({ type: 'immediate_response', requestId: f.requestId, status: 200, data: { messages: [
                        { id: 'm1', direction: 'inbound', content: { text: 'hi' }, createdAt: '2026-01-01T00:00:00Z' },
                        { id: 'm2', direction: 'outbound', content: { text: 'First answer' }, createdAt: '2026-01-01T00:00:01Z' },
                    ].reverse(), hasMore: false } });
                else if (f.action === 'send_message') {
                    reply({ type: 'immediate_response', requestId: f.requestId, status: 202, data: {} });
                    reply({ type: 'eventual_response', requestId: f.requestId, status: 200, data: { requestId: f.requestId, status: 200, data: { messageId: 'm3', response: { responseParts: ['Second answer'] } } } });
                }
            };
            // @ts-expect-error injected global
            const el = window.SmoothAgentChat.mount({ endpoint, agentId, greeting: '' });
            const root = (el as { shadowRoot: ShadowRoot }).shadowRoot;
            // Returning visitor: pre-chat form skipped. Open + resume.
            (root.querySelector('.launcher') as HTMLElement | null)?.click();
            for (let i = 0; i < 80; i++) {
                const txt = Array.from(root.querySelectorAll('.bubble')).map((b) => b.textContent ?? '').join(' ');
                if (/First answer/.test(txt)) break;
                await s(25);
            }
            const sent = (window as unknown as { __sent: Record<string, unknown>[] }).__sent;
            // Send a follow-up; assert it reuses sess-RESUME.
            const input = root.querySelector('textarea') as HTMLTextAreaElement | null;
            if (input) {
                input.value = 'more';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                (root.querySelector('.send') as HTMLElement | null)?.click();
                await s(120);
            }
            const after = (window as unknown as { __sent: Record<string, unknown>[] }).__sent;
            return {
                hadCreate: sent.some((x) => x.action === 'create_conversation_session'),
                resumed: sent.some((x) => x.action === 'get_session'),
                history: Array.from(root.querySelectorAll('.bubble')).map((b) => b.textContent ?? ''),
                sendSessionId: (after.find((x) => x.action === 'send_message') as Record<string, unknown> | undefined)?.sessionId ?? null,
            };
        },
        { endpoint: ENDPOINT, agentId: AGENT_ID },
    );

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    expect(result.hadCreate, 'resume must NOT create a new session').toBe(false);
    expect(result.resumed, 'resume must call get_session').toBe(true);
    expect(result.history.join(' ')).toContain('First answer');
    expect(result.sendSessionId, 'follow-up reuses the resumed sessionId').toBe('sess-RESUME');
});

test('ended session clears the pointer and starts fresh', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

    await page.addInitScript(MOCK_WS);
    await page.goto(`http://127.0.0.1:${process.env.STATIC_PORT ?? 4830}/e2e/fixtures/demo.html`).catch(async () => {
        await page.goto('about:blank');
    });
    await page.addScriptTag({ content: GLOBAL_BUNDLE });

    const result = await page.evaluate(
        async ({ endpoint, agentId }) => {
            const s = (ms: number) => new Promise((r) => setTimeout(r, ms));
            // Pre-seed a persisted pointer for a session the server will report ended.
            localStorage.setItem(`smoo-chat-widget:${agentId}`, JSON.stringify({ state: { version: 1, sessionId: 'sess-ENDED', identity: { name: 'Ada' }, consent: { emailOptIn: false, smsOptIn: false }, verifiedEmail: null, browserFingerprint: 'fp-keep' }, version: 1 }));
            (window as unknown as { __script: unknown }).__script = (f: Record<string, unknown>, reply: (o: unknown) => void) => {
                if (f.action === 'get_session') reply({ type: 'immediate_response', requestId: f.requestId, status: 200, data: { sessionId: f.sessionId, status: 'ended', agentId } });
                else if (f.action === 'create_conversation_session') reply({ type: 'immediate_response', requestId: f.requestId, status: 202, data: { sessionId: 'sess-FRESH', conversationId: 'c', agentId: f.agentId } });
            };
            // @ts-expect-error injected global
            const el = window.SmoothAgentChat.mount({ endpoint, agentId, greeting: '' });
            const root = (el as { shadowRoot: ShadowRoot }).shadowRoot;
            (root.querySelector('.launcher') as HTMLElement | null)?.click();
            for (let i = 0; i < 80; i++) {
                if ((window as unknown as { __sent: Record<string, unknown>[] }).__sent.some((x) => x.action === 'create_conversation_session')) break;
                await s(25);
            }
            const persisted = JSON.parse(localStorage.getItem(`smoo-chat-widget:${agentId}`) ?? '{}');
            const create = (window as unknown as { __sent: Record<string, unknown>[] }).__sent.find((x) => x.action === 'create_conversation_session') as Record<string, unknown> | undefined;
            return {
                createdFresh: !!create,
                fingerprintSent: create?.browserFingerprint,
                persistedSession: persisted.state?.sessionId,
                persistedName: persisted.state?.identity?.name,
            };
        },
        { endpoint: ENDPOINT, agentId: AGENT_ID },
    );

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    expect(result.createdFresh, 'ended session → fresh create_conversation_session').toBe(true);
    // Pointer rolled forward to the new session; identity + fingerprint preserved.
    expect(result.persistedSession).toBe('sess-FRESH');
    expect(result.persistedName).toBe('Ada');
    expect(result.fingerprintSent).toBe('fp-keep');
});

test('cross-device restore: request → verify → resolve → replay', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

    await page.addInitScript(MOCK_WS);
    await page.goto(`http://127.0.0.1:${process.env.STATIC_PORT ?? 4830}/e2e/fixtures/demo.html`).catch(async () => {
        await page.goto('about:blank');
    });
    await page.addScriptTag({ content: GLOBAL_BUNDLE });

    const result = await page.evaluate(
        async ({ endpoint, agentId }) => {
            const s = (ms: number) => new Promise((r) => setTimeout(r, ms));
            try {
                localStorage.clear();
            } catch {
                /* ignore */
            }
            // WS verbs: create the live session + serve the replayed history.
            (window as unknown as { __script: unknown }).__script = (f: Record<string, unknown>, reply: (o: unknown) => void) => {
                switch (f.action) {
                    case 'create_conversation_session':
                        reply({ type: 'immediate_response', requestId: f.requestId, status: 202, data: { sessionId: 'sess-A', conversationId: 'c', agentId: f.agentId } });
                        break;
                    case 'get_session':
                        reply({ type: 'immediate_response', requestId: f.requestId, status: 200, data: { sessionId: f.sessionId, status: 'active', agentId } });
                        break;
                    case 'get_conversation_messages':
                        reply({ type: 'immediate_response', requestId: f.requestId, status: 200, data: { messages: [{ id: 'h1', direction: 'inbound', content: { text: 'Replayed pricing chat' }, createdAt: '2026-01-01T00:00:00Z' }], hasMore: false } });
                        break;
                }
            };
            // HTTP /internal/* routes: the cross-device identity flow.
            (window as unknown as { __httpScript: unknown }).__httpScript = (path: string, body: Record<string, unknown>) => {
                switch (path) {
                    case '/internal/resume-by-fingerprint':
                        return { json: { resumable: false } };
                    case '/internal/identity/request-otp':
                        return { json: { event: 'otp_sent', maskedDestination: 'a***@example.com' } };
                    case '/internal/identity/verify-otp':
                        return { json: body.code === '123456' ? { event: 'otp_verified' } : { event: 'otp_invalid', attemptsRemaining: 2 } };
                    case '/internal/identity/resolve':
                        return { json: { resolved: true, crmContactId: 'crm', conversations: [{ conversationId: 'conv-9', sessionId: 'sess-9', lastActivityAt: '2026-01-01T00:00:00Z', preview: 'Past chat about pricing' }] } };
                    default:
                        return { json: {} };
                }
            };
            // @ts-expect-error injected global
            const el = window.SmoothAgentChat.mount({ endpoint, agentId, greeting: '' });
            const root = (el as { shadowRoot: ShadowRoot }).shadowRoot;
            (root.querySelector('.launcher') as HTMLElement | null)?.click();
            await s(40);

            // Click the "Restore my chats" affordance in the footer.
            (root.querySelector('.restore-link') as HTMLElement | null)?.click();
            await s(30);
            // Email entry.
            const emailInput = root.querySelector('.int-card .int-input') as HTMLInputElement;
            emailInput.value = 'ada@example.com';
            (root.querySelector('.int-card .int-btn.primary') as HTMLElement).click();
            await s(40);
            // Code entry.
            const codeInput = root.querySelector('.int-card .int-input') as HTMLInputElement;
            codeInput.value = '123456';
            (root.querySelector('.int-card .int-btn.primary') as HTMLElement).click();
            await s(60);
            // The resolved conversation list appears — pick it.
            const item = root.querySelector('.restore-item') as HTMLElement | null;
            const hadList = !!item;
            item?.click();
            await s(80);

            return {
                hadList,
                verifiedEmailPersisted: JSON.parse(localStorage.getItem(`smoo-chat-widget:${agentId}`) ?? '{}').state?.verifiedEmail,
                replayed: Array.from(root.querySelectorAll('.bubble')).map((b) => b.textContent ?? '').join(' '),
            };
        },
        { endpoint: ENDPOINT, agentId: AGENT_ID },
    );

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    expect(result.hadList, 'resolve_identity produced a conversation list').toBe(true);
    expect(result.verifiedEmailPersisted, 'verifiedEmail persisted after verify').toBe('ada@example.com');
    expect(result.replayed).toContain('Replayed pricing chat');
});

test('fingerprint resume: no persisted pointer → POST /internal/resume-by-fingerprint → adopt + replay', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

    await page.addInitScript(MOCK_WS);
    await page.goto(`http://127.0.0.1:${process.env.STATIC_PORT ?? 4830}/e2e/fixtures/demo.html`).catch(async () => {
        await page.goto('about:blank');
    });
    await page.addScriptTag({ content: GLOBAL_BUNDLE });

    const result = await page.evaluate(
        async ({ endpoint, agentId }) => {
            const s = (ms: number) => new Promise((r) => setTimeout(r, ms));
            try {
                localStorage.clear();
            } catch {
                /* ignore */
            }
            // No persisted pointer. The wrapper resolves a recent session for this
            // fingerprint and primes the registry; the widget adopts it.
            (window as unknown as { __httpScript: unknown }).__httpScript = (path: string) => {
                if (path === '/internal/resume-by-fingerprint') {
                    return { json: { resumable: true, sessionId: 'sess-FP', conversationId: 'c', agentId } };
                }
                return { json: {} };
            };
            (window as unknown as { __script: unknown }).__script = (f: Record<string, unknown>, reply: (o: unknown) => void) => {
                if (f.action === 'get_session') reply({ type: 'immediate_response', requestId: f.requestId, status: 200, data: { sessionId: f.sessionId, status: 'active', agentId } });
                else if (f.action === 'get_conversation_messages') reply({ type: 'immediate_response', requestId: f.requestId, status: 200, data: { messages: [{ id: 'fp1', direction: 'outbound', content: { text: 'Welcome back' }, createdAt: '2026-01-01T00:00:00Z' }], hasMore: false } });
                else if (f.action === 'create_conversation_session') reply({ type: 'immediate_response', requestId: f.requestId, status: 202, data: { sessionId: 'sess-SHOULD-NOT-HAPPEN', conversationId: 'c', agentId: f.agentId } });
            };
            // @ts-expect-error injected global
            const el = window.SmoothAgentChat.mount({ endpoint, agentId, greeting: '' });
            const root = (el as { shadowRoot: ShadowRoot }).shadowRoot;
            (root.querySelector('.launcher') as HTMLElement | null)?.click();
            for (let i = 0; i < 80; i++) {
                const txt = Array.from(root.querySelectorAll('.bubble')).map((b) => b.textContent ?? '').join(' ');
                if (/Welcome back/.test(txt)) break;
                await s(25);
            }
            const sent = (window as unknown as { __sent: Record<string, unknown>[] }).__sent;
            const http = (window as unknown as { __http: { path: string; body: Record<string, unknown> }[] }).__http;
            return {
                hitFingerprintRoute: http.some((h) => h.path === '/internal/resume-by-fingerprint'),
                fingerprintSent: http.find((h) => h.path === '/internal/resume-by-fingerprint')?.body.browserFingerprint,
                createdSession: sent.some((x) => x.action === 'create_conversation_session'),
                persistedSession: JSON.parse(localStorage.getItem(`smoo-chat-widget:${agentId}`) ?? '{}').state?.sessionId,
                replayed: Array.from(root.querySelectorAll('.bubble')).map((b) => b.textContent ?? '').join(' '),
            };
        },
        { endpoint: ENDPOINT, agentId: AGENT_ID },
    );

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    expect(result.hitFingerprintRoute, 'POST /internal/resume-by-fingerprint was called').toBe(true);
    expect(typeof result.fingerprintSent).toBe('string');
    // Adopted the resumed session — did NOT create a fresh one.
    expect(result.createdSession, 'must NOT create a session when fingerprint resumes').toBe(false);
    expect(result.persistedSession).toBe('sess-FP');
    expect(result.replayed).toContain('Welcome back');
});

test("hardening: every /internal/* POST omits credentials, restore-link awaits connect, and request-otp carries a sessionId", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));

    await page.addInitScript(MOCK_WS);
    await page.goto(`http://127.0.0.1:${process.env.STATIC_PORT ?? 4830}/e2e/fixtures/demo.html`).catch(async () => {
        await page.goto('about:blank');
    });
    await page.addScriptTag({ content: GLOBAL_BUNDLE });

    const result = await page.evaluate(
        async ({ endpoint, agentId }) => {
            const s = (ms: number) => new Promise((r) => setTimeout(r, ms));
            try {
                localStorage.clear();
            } catch {
                /* ignore */
            }
            (window as unknown as { __script: unknown }).__script = (f: Record<string, unknown>, reply: (o: unknown) => void) => {
                switch (f.action) {
                    case 'create_conversation_session':
                        reply({ type: 'immediate_response', requestId: f.requestId, status: 202, data: { sessionId: 'sess-A', conversationId: 'c', agentId: f.agentId } });
                        break;
                    case 'get_session':
                        reply({ type: 'immediate_response', requestId: f.requestId, status: 200, data: { sessionId: f.sessionId, status: 'active', agentId } });
                        break;
                    case 'get_conversation_messages':
                        reply({ type: 'immediate_response', requestId: f.requestId, status: 200, data: { messages: [], hasMore: false } });
                        break;
                }
            };
            (window as unknown as { __httpScript: unknown }).__httpScript = (path: string) => {
                switch (path) {
                    case '/internal/resume-by-fingerprint':
                        return { json: { resumable: false } };
                    case '/internal/identity/request-otp':
                        return { json: { event: 'otp_sent', maskedDestination: 'a***@example.com' } };
                    default:
                        return { json: {} };
                }
            };
            // @ts-expect-error injected global
            const el = window.SmoothAgentChat.mount({ endpoint, agentId, greeting: '' });
            const root = (el as { shadowRoot: ShadowRoot }).shadowRoot;
            (root.querySelector('.launcher') as HTMLElement | null)?.click();
            await s(30);

            // Click "Restore my chats" then IMMEDIATELY submit the email — racing the
            // (now awaited) connect(). The hardened flow must still have a sessionId on
            // the request-otp POST.
            (root.querySelector('.restore-link') as HTMLElement | null)?.click();
            await s(10);
            const emailInput = root.querySelector('.int-card .int-input') as HTMLInputElement;
            emailInput.value = 'ada@example.com';
            (root.querySelector('.int-card .int-btn.primary') as HTMLElement).click();

            // Wait for the request-otp call to land.
            for (let i = 0; i < 80; i++) {
                if ((window as unknown as { __http: { path: string }[] }).__http.some((h) => h.path === '/internal/identity/request-otp')) break;
                await s(25);
            }
            const http = (window as unknown as { __http: { path: string; body: Record<string, unknown>; credentials?: string }[] }).__http;
            const otp = http.find((h) => h.path === '/internal/identity/request-otp');
            return {
                allOmit: http.length > 0 && http.every((h) => h.credentials === 'omit'),
                requestOtpHasSession: typeof otp?.body.sessionId === 'string' && (otp.body.sessionId as string).length > 0,
                sentSession: otp?.body.sessionId,
            };
        },
        { endpoint: ENDPOINT, agentId: AGENT_ID },
    );

    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    expect(result.allOmit, "every /internal/* POST must use credentials: 'omit'").toBe(true);
    expect(result.requestOtpHasSession, 'request-otp must carry a sessionId even when racing the restore-link connect()').toBe(true);
    expect(result.sentSession).toBe('sess-A');
});
