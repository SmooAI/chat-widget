/**
 * ConversationController integration tests (jsdom + a deterministic mock
 * WebSocket + a mocked `fetch`).
 *
 * The engine WS verbs (create/send/get_session/get_conversation_messages) are
 * exercised through a scriptable mock WebSocket. The 0.7.0 cross-device identity
 * flow + fingerprint resume are HTTP POST routes on the chat-ws wrapper (the
 * engine `/ws` rejects unknown verbs — ADR-048), so those are exercised through a
 * mocked `fetch` that routes by `/internal/*` path.
 *
 * Coverage:
 *   - createConversationSession carries browserFingerprint + identity + consent
 *     + phone-on-metadata,
 *   - same-session resume hydrates history and reuses the sessionId,
 *   - an ended session clears the pointer and starts fresh,
 *   - fingerprint resume (POST /internal/resume-by-fingerprint) adopts a session,
 *   - cross-device request → verify → resolve → replay over the HTTP routes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationController, type ConversationEvents, httpBaseFromWsEndpoint, type IdentityRestore } from './conversation.js';
import { createWidgetStore } from './persistence.js';

const ENDPOINT = 'wss://example.test/ws';
const AGENT = 'agent-xyz';

interface Listeners {
    open: Array<() => void>;
    message: Array<(ev: { data: string }) => void>;
    close: Array<(ev: { code?: number; reason?: string }) => void>;
    error: Array<(ev: unknown) => void>;
}

/** A scriptable mock socket. `onFrame` decides the replies for each outbound frame. */
class MockSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    static onFrame: (frame: Record<string, unknown>, reply: (obj: unknown) => void) => void = () => {};
    static instances: MockSocket[] = [];
    static sentFrames: Record<string, unknown>[] = [];

    readyState = 0;
    private listeners: Listeners = { open: [], message: [], close: [], error: [] };

    constructor(public url: string) {
        MockSocket.instances.push(this);
        queueMicrotask(() => {
            this.readyState = 1;
            for (const fn of this.listeners.open.slice()) fn();
        });
    }
    addEventListener(type: keyof Listeners, fn: (ev: never) => void): void {
        (this.listeners[type] as Array<typeof fn>).push(fn);
    }
    removeEventListener(): void {
        /* not needed for these tests */
    }
    private reply(obj: unknown): void {
        for (const fn of this.listeners.message.slice()) fn({ data: JSON.stringify(obj) });
    }
    send(raw: string): void {
        const frame = JSON.parse(raw) as Record<string, unknown>;
        MockSocket.sentFrames.push(frame);
        MockSocket.onFrame(frame, (obj) => this.reply(obj));
    }
    close(): void {
        this.readyState = 3;
        for (const fn of this.listeners.close.slice()) fn({ code: 1000, reason: '' });
    }
}

function installMockWs(): void {
    MockSocket.instances = [];
    MockSocket.sentFrames = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockSocket;
}

/** Default operator behaviour: create → immediate_response, send → token+eventual. */
function defaultOnFrame(frame: Record<string, unknown>, reply: (obj: unknown) => void): void {
    const requestId = frame.requestId;
    if (frame.action === 'create_conversation_session') {
        reply({ type: 'immediate_response', requestId, status: 202, data: { sessionId: 'sess-new', conversationId: 'conv-1', agentId: frame.agentId } });
    } else if (frame.action === 'send_message') {
        reply({ type: 'immediate_response', requestId, status: 202, data: {} });
        reply({ type: 'stream_token', requestId, token: 'Hi' });
        reply({ type: 'eventual_response', requestId, status: 200, data: { requestId, status: 200, data: { messageId: 'm1', response: { responseParts: ['Hi there'] } } } });
    }
}

// --- mocked fetch for the chat-ws `/internal/*` routes -----------------------

interface FetchCall {
    path: string;
    body: Record<string, unknown>;
    origin: string;
}
const fetchCalls: FetchCall[] = [];
/** Per-test responder: path → JSON body (+ optional status). Default = resume:false. */
let fetchRouter: (path: string, body: Record<string, unknown>) => { status?: number; json: Record<string, unknown> } = () => ({ json: { resumable: false } });

function installMockFetch(): void {
    fetchCalls.length = 0;
    fetchRouter = () => ({ json: { resumable: false } });
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: { body?: string }) => {
        const u = new URL(url);
        const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        fetchCalls.push({ path: u.pathname, body, origin: u.origin });
        const { status = 200, json } = fetchRouter(u.pathname, body);
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => json,
        };
    };
}

function makeController(events: Partial<ConversationEvents> = {}, config: Record<string, unknown> = {}) {
    const store = createWidgetStore(AGENT);
    const onMessages = vi.fn();
    const onStatus = vi.fn();
    const onInterrupt = vi.fn();
    const onIdentityRestore = vi.fn();
    const controller = new ConversationController(
        { endpoint: ENDPOINT, agentId: AGENT, ...config },
        { onMessages, onStatus, onInterrupt, onIdentityRestore, ...events },
        store,
    );
    return { controller, store, onMessages, onStatus, onIdentityRestore };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ConversationController — session creation (ADR-048 §a)', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
        MockSocket.onFrame = defaultOnFrame;
    });
    afterEach(() => localStorage.clear());

    it('sends browserFingerprint + identity + consent + phone-on-metadata', async () => {
        const { controller, store } = makeController();
        controller.setUserInfo({
            name: 'Ada',
            email: 'ada@example.com',
            phone: '+15551234567',
            consent: { emailOptIn: true, smsOptIn: false },
        });
        await controller.connect();

        const create = MockSocket.sentFrames.find((f) => f.action === 'create_conversation_session') as Record<string, unknown>;
        expect(create).toBeTruthy();
        expect(create.userName).toBe('Ada');
        expect(create.userEmail).toBe('ada@example.com');
        expect(typeof create.browserFingerprint).toBe('string');
        expect((create.browserFingerprint as string).length).toBeGreaterThan(10);

        const meta = create.metadata as Record<string, unknown>;
        // Phone rides metadata.userPhone (no first-class engine field).
        expect(meta.userPhone).toBe('+15551234567');
        const consent = meta.consent as Record<string, unknown>;
        expect(consent.emailOptIn).toBe(true);
        expect(consent.smsOptIn).toBe(false);
        expect(consent.consentSource).toBe('chat-widget-prechat');
        expect(typeof consent.consentAt).toBe('string');

        // The fingerprint + session pointer are persisted.
        expect(store.getState().browserFingerprint).toBe(create.browserFingerprint);
        expect(store.getState().sessionId).toBe('sess-new');
    });

    it('reuses the SAME fingerprint across two sessions', async () => {
        const { controller, store } = makeController();
        await controller.connect();
        const fp1 = store.getState().browserFingerprint;
        controller.disconnect();
        // Clear the session pointer so the next connect creates a fresh session.
        store.getState().clearSession();
        await controller.connect();
        const creates = MockSocket.sentFrames.filter((f) => f.action === 'create_conversation_session');
        expect(creates).toHaveLength(2);
        expect(creates[0]?.browserFingerprint).toBe(creates[1]?.browserFingerprint);
        expect(store.getState().browserFingerprint).toBe(fp1);
    });

    it('omits consent metadata when no opt-in was given', async () => {
        const { controller } = makeController();
        controller.setUserInfo({ name: 'Bob', consent: { emailOptIn: false, smsOptIn: false } });
        await controller.connect();
        const create = MockSocket.sentFrames.find((f) => f.action === 'create_conversation_session') as Record<string, unknown>;
        // No consentAt stamped → no consent block in metadata.
        expect(create.metadata).toBeUndefined();
    });
});

describe('ConversationController — same-session resume (ADR-048 §b)', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
    });
    afterEach(() => localStorage.clear());

    it('resumes a live persisted session, hydrates history, and reuses the sessionId', async () => {
        // Seed a persisted pointer + identity (returning visitor).
        const seed = createWidgetStore(AGENT);
        seed.getState().setSessionId('sess-resume');
        seed.getState().mergeIdentity({ name: 'Ada' });

        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'get_session') {
                expect(frame.sessionId).toBe('sess-resume');
                reply({ type: 'immediate_response', requestId, status: 200, data: { sessionId: 'sess-resume', status: 'active', agentId: AGENT } });
            } else if (frame.action === 'get_conversation_messages') {
                // Server returns newest-first.
                reply({
                    type: 'immediate_response',
                    requestId,
                    status: 200,
                    data: {
                        messages: [
                            { id: 'm2', direction: 'outbound', content: { text: 'Reply two' }, createdAt: '2026-01-02T00:00:00Z' },
                            { id: 'm1', direction: 'inbound', content: { text: 'Hello one' }, createdAt: '2026-01-01T00:00:00Z' },
                        ],
                        hasMore: false,
                    },
                });
            } else {
                defaultOnFrame(frame, reply);
            }
        };

        const { controller, onMessages } = makeController();
        await controller.connect();

        // No new session was created — we resumed.
        expect(MockSocket.sentFrames.find((f) => f.action === 'create_conversation_session')).toBeUndefined();
        expect(MockSocket.sentFrames.find((f) => f.action === 'get_session')).toBeTruthy();

        // History hydrated chronologically (oldest first).
        const lastSnapshot = onMessages.mock.calls.at(-1)?.[0] as Array<{ role: string; text: string }>;
        expect(lastSnapshot.map((m) => m.text)).toEqual(['Hello one', 'Reply two']);
        expect(lastSnapshot.map((m) => m.role)).toEqual(['user', 'assistant']);

        // A follow-up message reuses sess-resume (no createConversationSession).
        await controller.send('next');
        const sendFrame = MockSocket.sentFrames.find((f) => f.action === 'send_message') as Record<string, unknown>;
        expect(sendFrame.sessionId).toBe('sess-resume');
        expect(MockSocket.sentFrames.find((f) => f.action === 'create_conversation_session')).toBeUndefined();
    });

    it('clears the pointer (keeps identity) and starts fresh when the session has ended', async () => {
        const seed = createWidgetStore(AGENT);
        seed.getState().setSessionId('sess-dead');
        seed.getState().mergeIdentity({ name: 'Ada' });

        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'get_session') {
                reply({ type: 'immediate_response', requestId, status: 200, data: { sessionId: 'sess-dead', status: 'ended', agentId: AGENT } });
            } else {
                defaultOnFrame(frame, reply);
            }
        };

        const { controller, store } = makeController();
        await controller.connect();

        // Fell through to a fresh create_conversation_session.
        const create = MockSocket.sentFrames.find((f) => f.action === 'create_conversation_session') as Record<string, unknown>;
        expect(create).toBeTruthy();
        // New pointer persisted; identity preserved across the clear.
        expect(store.getState().sessionId).toBe('sess-new');
        expect(store.getState().identity.name).toBe('Ada');
    });

    it('starts fresh when get_session 404s (SESSION_NOT_FOUND)', async () => {
        const seed = createWidgetStore(AGENT);
        seed.getState().setSessionId('sess-gone');

        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'get_session') {
                reply({ type: 'error', requestId, data: { requestId, error: { code: 'SESSION_NOT_FOUND', message: 'gone' } } });
            } else {
                defaultOnFrame(frame, reply);
            }
        };

        const { controller, store } = makeController();
        await controller.connect();
        expect(MockSocket.sentFrames.find((f) => f.action === 'create_conversation_session')).toBeTruthy();
        expect(store.getState().sessionId).toBe('sess-new');
    });
});

describe('httpBaseFromWsEndpoint', () => {
    it('derives the HTTP base from a wss /ws endpoint', () => {
        expect(httpBaseFromWsEndpoint('wss://ai.smoo.ai/ws')).toBe('https://ai.smoo.ai');
        expect(httpBaseFromWsEndpoint('ws://localhost:8787/ws')).toBe('http://localhost:8787');
        expect(httpBaseFromWsEndpoint('wss://ai.smoo.ai:9000/ws')).toBe('https://ai.smoo.ai:9000');
    });
});

describe('ConversationController — fingerprint resume (ADR-048 §b, HTTP)', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
        MockSocket.onFrame = defaultOnFrame;
    });
    afterEach(() => localStorage.clear());

    it('POSTs /internal/resume-by-fingerprint FIRST when there is no persisted pointer, then adopts the session', async () => {
        // Wrapper resolves a recent session for this fingerprint and primes the registry.
        fetchRouter = (path) => {
            if (path === '/internal/resume-by-fingerprint') {
                return { json: { resumable: true, sessionId: 'sess-FP', conversationId: 'c', agentId: AGENT } };
            }
            return { json: {} };
        };
        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'get_session') {
                reply({ type: 'immediate_response', requestId, status: 200, data: { sessionId: frame.sessionId, status: 'active', agentId: AGENT } });
            } else if (frame.action === 'get_conversation_messages') {
                reply({ type: 'immediate_response', requestId, status: 200, data: { messages: [{ id: 'fp1', direction: 'outbound', content: { text: 'Welcome back' }, createdAt: '2026-01-01T00:00:00Z' }], hasMore: false } });
            } else {
                defaultOnFrame(frame, reply);
            }
        };

        const { controller, store, onMessages } = makeController();
        await controller.connect();

        // The fingerprint resume route was hit with the persisted fingerprint + agentId.
        const fpCall = fetchCalls.find((c) => c.path === '/internal/resume-by-fingerprint');
        expect(fpCall).toBeTruthy();
        expect(fpCall?.body.browserFingerprint).toBe(store.getState().browserFingerprint);
        expect(fpCall?.body.agentId).toBe(AGENT);

        // Adopted the session via get_session/get_messages — NOT createConversationSession.
        expect(MockSocket.sentFrames.find((f) => f.action === 'create_conversation_session')).toBeUndefined();
        expect(store.getState().sessionId).toBe('sess-FP');
        const snap = onMessages.mock.calls.at(-1)?.[0] as Array<{ text: string }>;
        expect(snap.some((m) => m.text === 'Welcome back')).toBe(true);
    });

    it('falls through to createConversationSession when the fingerprint is not resumable', async () => {
        fetchRouter = () => ({ json: { resumable: false } });
        const { controller, store } = makeController();
        await controller.connect();
        expect(fetchCalls.some((c) => c.path === '/internal/resume-by-fingerprint')).toBe(true);
        expect(MockSocket.sentFrames.find((f) => f.action === 'create_conversation_session')).toBeTruthy();
        expect(store.getState().sessionId).toBe('sess-new');
    });
});

describe('ConversationController — cross-device restore (ADR-048 §c, HTTP)', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
    });
    afterEach(() => localStorage.clear());

    it('runs request → verify → resolve → replay over the HTTP routes and persists verifiedEmail', async () => {
        const restoreStates: IdentityRestore[] = [];
        // A live session must exist before the cross-device affordance — create one.
        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            switch (frame.action) {
                case 'create_conversation_session':
                    reply({ type: 'immediate_response', requestId, status: 202, data: { sessionId: 'sess-new', conversationId: 'c', agentId: AGENT } });
                    break;
                case 'get_session':
                    reply({ type: 'immediate_response', requestId, status: 200, data: { sessionId: frame.sessionId, status: 'active', agentId: AGENT } });
                    break;
                case 'get_conversation_messages':
                    reply({ type: 'immediate_response', requestId, status: 200, data: { messages: [{ id: 'h1', direction: 'inbound', content: { text: 'Restored history' }, createdAt: '2026-01-01T00:00:00Z' }], hasMore: false } });
                    break;
                default:
                    break;
            }
        };
        fetchRouter = (path, body) => {
            switch (path) {
                case '/internal/resume-by-fingerprint':
                    return { json: { resumable: false } };
                case '/internal/identity/request-otp':
                    expect(body.email).toBe('ada@example.com');
                    expect(body.agentId).toBe(AGENT);
                    return { json: { event: 'otp_sent', maskedDestination: 'a***@example.com' } };
                case '/internal/identity/verify-otp':
                    expect(body.sessionId).toBe('sess-new');
                    expect(body.code).toBe('123456');
                    return { json: { event: 'otp_verified' } };
                case '/internal/identity/resolve':
                    expect(body.sessionId).toBe('sess-new');
                    return { json: { resolved: true, crmContactId: 'crm-1', conversations: [{ conversationId: 'conv-9', sessionId: 'sess-9', lastActivityAt: '2026-01-01T00:00:00Z', preview: 'Past chat' }] } };
                default:
                    return { json: {} };
            }
        };

        const { controller, store, onMessages } = makeController({ onIdentityRestore: (s) => restoreStates.push(s) });
        await controller.connect();

        await controller.requestIdentityOtp('ada@example.com', 'email');
        expect(restoreStates.at(-1)?.phase).toBe('awaiting_code');

        await controller.verifyIdentityOtp('123456');
        await tick();
        // verifiedEmail persisted on success.
        expect(store.getState().verifiedEmail).toBe('ada@example.com');

        const resolved = restoreStates.find((s) => s.phase === 'resolved');
        expect(resolved && resolved.phase === 'resolved' ? resolved.conversations[0]?.sessionId : null).toBe('sess-9');

        // Picking the conversation replays its history + repoints the session.
        await controller.restoreConversation('sess-9');
        await tick();
        expect(store.getState().sessionId).toBe('sess-9');
        const snap = onMessages.mock.calls.at(-1)?.[0] as Array<{ text: string }>;
        expect(snap.some((m) => m.text === 'Restored history')).toBe(true);
    });

    it('surfaces otp_invalid with attemptsRemaining and stays on the code step', async () => {
        const restoreStates: IdentityRestore[] = [];
        MockSocket.onFrame = defaultOnFrame;
        fetchRouter = (path) => {
            switch (path) {
                case '/internal/resume-by-fingerprint':
                    return { json: { resumable: false } };
                case '/internal/identity/request-otp':
                    return { json: { event: 'otp_sent', maskedDestination: 'a***@x.com' } };
                case '/internal/identity/verify-otp':
                    return { json: { event: 'otp_invalid', attemptsRemaining: 2 } };
                default:
                    return { json: {} };
            }
        };
        const { controller } = makeController({ onIdentityRestore: (s) => restoreStates.push(s) });
        await controller.connect();
        await controller.requestIdentityOtp('ada@example.com');
        await controller.verifyIdentityOtp('000000');
        await tick();
        const last = restoreStates.at(-1);
        expect(last?.phase).toBe('awaiting_code');
        expect(last?.phase === 'awaiting_code' ? last.attemptsRemaining : null).toBe(2);
    });

    it('passes authContext through to the identity routes when configured', async () => {
        MockSocket.onFrame = defaultOnFrame;
        fetchRouter = () => ({ json: { resumable: false } });
        const ac = { userId: 'u1', signature: 'sig', timestamp: 123 };
        const { controller } = makeController({}, { authContext: ac });
        await controller.connect();
        await controller.requestIdentityOtp('ada@example.com');
        const otpCall = fetchCalls.find((c) => c.path === '/internal/identity/request-otp');
        expect(otpCall?.body.authContext).toEqual(ac);
    });
});
