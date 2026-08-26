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
import { ConversationController, type ConversationEvents, httpBaseFromWsEndpoint, type IdentityRestore, normalizeParagraphs } from './conversation.js';
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
    credentials?: RequestCredentials;
}
const fetchCalls: FetchCall[] = [];
/** Per-test responder: path → JSON body (+ optional status). Default = resume:false. */
let fetchRouter: (path: string, body: Record<string, unknown>) => { status?: number; json: Record<string, unknown> } = () => ({ json: { resumable: false } });

function installMockFetch(): void {
    fetchCalls.length = 0;
    fetchRouter = () => ({ json: { resumable: false } });
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: { body?: string; credentials?: RequestCredentials }) => {
        const u = new URL(url);
        const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        fetchCalls.push({ path: u.pathname, body, origin: u.origin, credentials: init?.credentials });
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

describe('ConversationController — suggested replies (from eventual_response)', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
        MockSocket.onFrame = defaultOnFrame;
    });
    afterEach(() => localStorage.clear());

    /** Reply to send_message with a custom `response` object on the eventual_response. */
    function withSendResponse(response: Record<string, unknown>): void {
        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'send_message') {
                reply({ type: 'immediate_response', requestId, status: 202, data: {} });
                reply({ type: 'stream_token', requestId, token: 'Hi' });
                reply({ type: 'eventual_response', requestId, status: 200, data: { requestId, status: 200, data: { messageId: 'm1', response } } });
            } else {
                defaultOnFrame(frame, reply);
            }
        };
    }

    it('attaches suggestedNextActions from the terminal event to the finalized assistant message', async () => {
        withSendResponse({ responseParts: ['Sure'], suggestedNextActions: ['Book a demo', 'See pricing'] });
        const { controller, onMessages } = makeController();
        await controller.connect();
        await controller.send('hello');
        const snap = onMessages.mock.calls.at(-1)?.[0] as Array<{ role: string; streaming: boolean; suggestions?: string[] }>;
        const assistant = snap.at(-1)!;
        expect(assistant.role).toBe('assistant');
        expect(assistant.streaming).toBe(false);
        expect(assistant.suggestions).toEqual(['Book a demo', 'See pricing']);
    });

    it('caps suggestions at 4 and drops non-string / blank entries', async () => {
        withSendResponse({
            responseParts: ['Sure'],
            suggestedNextActions: ['one', 2, '', '  ', 'two', null, 'three', 'four', 'five'],
        });
        const { controller, onMessages } = makeController();
        await controller.connect();
        await controller.send('hello');
        const snap = onMessages.mock.calls.at(-1)?.[0] as Array<{ suggestions?: string[] }>;
        expect(snap.at(-1)?.suggestions).toEqual(['one', 'two', 'three', 'four']);
    });

    it('leaves suggestions undefined when the response carries none (or a non-array)', async () => {
        withSendResponse({ responseParts: ['Sure'] });
        const { controller, onMessages } = makeController();
        await controller.connect();
        await controller.send('hello');
        expect((onMessages.mock.calls.at(-1)?.[0] as Array<{ suggestions?: string[] }>).at(-1)?.suggestions).toBeUndefined();

        withSendResponse({ responseParts: ['Sure'], suggestedNextActions: 'not-an-array' });
        await controller.send('again');
        expect((onMessages.mock.calls.at(-1)?.[0] as Array<{ suggestions?: string[] }>).at(-1)?.suggestions).toBeUndefined();
    });
});

describe('normalizeParagraphs', () => {
    it('collapses 3+ newlines to a single paragraph break', () => {
        expect(normalizeParagraphs('A\n\n\nB')).toBe('A\n\nB');
        expect(normalizeParagraphs('A\n\n\n\n\nB')).toBe('A\n\nB');
    });
    it('is a no-op on well-formed text (single break or paragraph break)', () => {
        expect(normalizeParagraphs('A\nB')).toBe('A\nB');
        expect(normalizeParagraphs('A\n\nB')).toBe('A\n\nB');
        // Idempotent — the finalized join it wraps stays byte-identical.
        const joined = ['A', 'B'].join('\n\n');
        expect(normalizeParagraphs(joined)).toBe(joined);
    });
});

describe('ConversationController — streaming render matches finalized render (SMOODEV-2534)', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
        MockSocket.onFrame = defaultOnFrame;
    });
    afterEach(() => localStorage.clear());

    it('never shows an extra blank line mid-stream: streamed text agrees with the finalized join', async () => {
        // The model streams paragraph one, then an extra blank line (a `\n\n\n` run
        // split across tokens), then paragraph two. The finalized `responseParts`
        // join uses `\n\n`. Mid-stream must never render more blank lines than the
        // finalized message.
        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'send_message') {
                reply({ type: 'immediate_response', requestId, status: 202, data: {} });
                for (const token of ['Para one.', '\n\n', '\n', 'Para two.']) {
                    reply({ type: 'stream_token', requestId, token });
                }
                reply({
                    type: 'eventual_response',
                    requestId,
                    status: 200,
                    data: { requestId, status: 200, data: { messageId: 'm1', response: { responseParts: ['Para one.', 'Para two.'] } } },
                });
            } else {
                defaultOnFrame(frame, reply);
            }
        };

        const { controller, onMessages } = makeController();
        await controller.connect();
        await controller.send('hello');

        type Snap = Array<{ role: string; streaming: boolean; text: string }>;
        const assistantSnaps = onMessages.mock.calls
            .map((c) => (c[0] as Snap).at(-1))
            .filter((m): m is { role: string; streaming: boolean; text: string } => m?.role === 'assistant');

        // No emitted assistant snapshot — streaming or final — carries a 3+ newline run.
        for (const snap of assistantSnaps) {
            expect(snap.text).not.toMatch(/\n{3,}/);
        }

        const finalText = ['Para one.', 'Para two.'].join('\n\n');
        // Finalized output is byte-identical to the raw `responseParts.join('\n\n')`.
        const finalized = assistantSnaps.at(-1)!;
        expect(finalized.streaming).toBe(false);
        expect(finalized.text).toBe(finalText);
        // The last mid-stream render already agrees with the finalized render — no
        // jump / flicker when the terminal event lands.
        const lastStreaming = assistantSnaps.filter((s) => s.streaming).at(-1)!;
        expect(lastStreaming.text).toBe(finalText);
    });
});

describe('httpBaseFromWsEndpoint', () => {
    it('derives the HTTP base from a wss /ws endpoint', () => {
        expect(httpBaseFromWsEndpoint('wss://ai.smoo.ai/ws')).toBe('https://ai.smoo.ai');
        expect(httpBaseFromWsEndpoint('ws://localhost:8787/ws')).toBe('http://localhost:8787');
        expect(httpBaseFromWsEndpoint('wss://ai.smoo.ai:9000/ws')).toBe('https://ai.smoo.ai:9000');
    });

    it('FAILS LOUD (returns null) on a non-absolute endpoint instead of a relative base', () => {
        // A relative base would make fetch(`${base}/internal/...`) POST identity data
        // to the HOST page origin instead of the operator host. Null forces a refusal.
        expect(httpBaseFromWsEndpoint('/ws')).toBeNull();
        expect(httpBaseFromWsEndpoint('not a url')).toBeNull();
        expect(httpBaseFromWsEndpoint('')).toBeNull();
    });
});

describe('ConversationController — fail-loud on a non-absolute endpoint', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
        MockSocket.onFrame = defaultOnFrame;
    });
    afterEach(() => localStorage.clear());

    it('enters error status and refuses /internal/* calls (no fetch) when the endpoint is not absolute', async () => {
        const store = createWidgetStore(AGENT);
        const onStatus = vi.fn();
        const onIdentityRestore = vi.fn();
        const controller = new ConversationController(
            { endpoint: '/ws', agentId: AGENT },
            { onMessages: vi.fn(), onStatus, onInterrupt: vi.fn(), onIdentityRestore },
            store,
        );
        await tick();
        // The constructor flagged the controller in error via a microtask.
        expect(onStatus).toHaveBeenCalledWith('error', expect.stringContaining('/ws'));

        // request-otp must NOT fire a fetch — it refuses with an identity-restore error.
        await controller.requestIdentityOtp('ada@example.com');
        expect(fetchCalls.length).toBe(0);
        const last = onIdentityRestore.mock.calls.at(-1)?.[0] as IdentityRestore | undefined;
        expect(last?.phase).toBe('error');
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

describe('ConversationController — a DEAD persisted pointer still probes the fingerprint (SMOODEV-3057)', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
        MockSocket.onFrame = defaultOnFrame;
    });
    afterEach(() => localStorage.clear());

    /** get_session says `ended` for `deadId`, `active` for anything else. */
    function deadPointerFrames(deadId: string): void {
        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'get_session') {
                const status = frame.sessionId === deadId ? 'ended' : 'active';
                reply({ type: 'immediate_response', requestId, status: 200, data: { sessionId: frame.sessionId, status, agentId: AGENT } });
            } else if (frame.action === 'get_conversation_messages') {
                reply({
                    type: 'immediate_response',
                    requestId,
                    status: 200,
                    data: { messages: [{ id: 'fp1', direction: 'outbound', content: { text: 'Welcome back' }, createdAt: '2026-01-01T00:00:00Z' }], hasMore: false },
                });
            } else {
                defaultOnFrame(frame, reply);
            }
        };
    }

    it('adopts the resumable session instead of minting a duplicate conversation', async () => {
        // The exact SMOODEV-3057 shape: a stored pointer that has died, while the
        // wrapper still has a resumable session for this fingerprint. Before the
        // fix the probe sat in an `else` and never ran, so this visitor got a
        // brand-new conversation — a second inbox row for one visitor.
        const seed = createWidgetStore(AGENT);
        seed.getState().setSessionId('sess-dead');
        seed.getState().mergeIdentity({ name: 'Ada' });
        deadPointerFrames('sess-dead');
        fetchRouter = (path) => (path === '/internal/resume-by-fingerprint' ? { json: { resumable: true, sessionId: 'sess-FP' } } : { json: {} });

        const { controller, store, onMessages } = makeController();
        await controller.connect();

        expect(fetchCalls.some((c) => c.path === '/internal/resume-by-fingerprint')).toBe(true);
        // No duplicate: the resumable session was adopted, not a fresh one created.
        expect(MockSocket.sentFrames.find((f) => f.action === 'create_conversation_session')).toBeUndefined();
        expect(store.getState().sessionId).toBe('sess-FP');
        expect(store.getState().identity.name).toBe('Ada');
        const snap = onMessages.mock.calls.at(-1)?.[0] as Array<{ text: string }>;
        expect(snap.some((m) => m.text === 'Welcome back')).toBe(true);
    });

    it('still creates a fresh session when the probe has nothing to resume', async () => {
        const seed = createWidgetStore(AGENT);
        seed.getState().setSessionId('sess-dead');
        deadPointerFrames('sess-dead');
        fetchRouter = () => ({ json: { resumable: false } });

        const { controller, store } = makeController();
        await controller.connect();

        expect(fetchCalls.some((c) => c.path === '/internal/resume-by-fingerprint')).toBe(true);
        expect(MockSocket.sentFrames.find((f) => f.action === 'create_conversation_session')).toBeTruthy();
        expect(store.getState().sessionId).toBe('sess-new');
    });
});

describe('ConversationController — dead-session recovery asks before minting (SMOODEV-3057)', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
        MockSocket.onFrame = defaultOnFrame;
    });
    afterEach(() => localStorage.clear());

    /** Live persisted session whose send_message comes back SESSION_NOT_FOUND. */
    function deadOnSend(deadFor: string): void {
        const seed = createWidgetStore(AGENT);
        seed.getState().setSessionId(deadFor);
        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'get_session') {
                reply({ type: 'immediate_response', requestId, status: 200, data: { sessionId: frame.sessionId, status: 'active', agentId: AGENT } });
            } else if (frame.action === 'get_conversation_messages') {
                reply({ type: 'immediate_response', requestId, status: 200, data: { messages: [], hasMore: false } });
            } else if (frame.action === 'send_message' && frame.sessionId === deadFor) {
                reply({ type: 'immediate_response', requestId, status: 202, data: {} });
                reply({ type: 'error', requestId, data: { requestId, error: { code: 'SESSION_NOT_FOUND', message: `session '${deadFor}' not found` } } });
            } else {
                defaultOnFrame(frame, reply);
            }
        };
    }

    it('recovers a registry-lost session from the wrapper instead of splitting the conversation', async () => {
        // The 2026-08-23 shape: the id is gone from the pod's registry but alive in
        // storage. Recovery used to mint unconditionally — a second conversation
        // mid-chat, which is the "first row holds one turn, second holds the rest"
        // screenshot. Now it asks first.
        deadOnSend('sess-dead');
        fetchRouter = (path) => (path === '/internal/resume-by-fingerprint' ? { json: { resumable: true, sessionId: 'sess-RECOVERED' } } : { json: {} });

        const { controller, store } = makeController();
        await controller.connect();
        await controller.send('hello');

        // Nothing minted at all: resumed on connect, recovered on the dead send.
        expect(MockSocket.sentFrames.filter((f) => f.action === 'create_conversation_session')).toHaveLength(0);
        expect(store.getState().sessionId).toBe('sess-RECOVERED');
    });

    it('still mints when the wrapper has nothing to recover — the turn is never dropped', async () => {
        deadOnSend('sess-dead');
        fetchRouter = () => ({ json: { resumable: false, reason: 'crm_linked' } });

        const { controller, onMessages } = makeController();
        await controller.connect();
        await controller.send('hello');

        expect(MockSocket.sentFrames.filter((f) => f.action === 'create_conversation_session')).toHaveLength(1);
        expect(controller.lastResumeReason).toBe('crm_linked');
        // The visitor's turn still got answered on the fresh session.
        const snap = onMessages.mock.calls.at(-1)?.[0] as Array<{ role: string; text: string }>;
        expect(snap.at(-1)?.role).toBe('assistant');
        expect(snap.at(-1)?.text).toBe('Hi there');
    });
});

describe('ConversationController — resume probe reason (SMOODEV-3057 observability)', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
        MockSocket.onFrame = defaultOnFrame;
    });
    afterEach(() => localStorage.clear());

    it("reports the SERVER's reason verbatim when the response carries one", async () => {
        fetchRouter = () => ({ json: { resumable: false, reason: 'crm_linked' } });
        const { controller } = makeController();
        await controller.connect();
        expect(controller.lastResumeReason).toBe('crm_linked');
    });

    it('derives a reason when the wrapper sends none (old + new shapes both tolerated)', async () => {
        fetchRouter = () => ({ json: { resumable: false } });
        const { controller } = makeController();
        await controller.connect();
        expect(controller.lastResumeReason).toBe('not_resumable_no_reason');
    });

    it('names a FAILED probe — and keeps it non-fatal: connect() still yields a session', async () => {
        // The bare `catch {}` made a 500 indistinguishable from "no prior visit".
        fetchRouter = () => ({ status: 500, json: { error: { message: 'boom' } } });
        const { controller, store } = makeController();
        await controller.connect();
        expect(controller.lastResumeReason).toMatch(/^probe_failed: /);
        expect(controller.lastResumeReason).toContain('boom');
        // Non-fatal: a failed probe must never break connect().
        expect(store.getState().sessionId).toBe('sess-new');
        expect(controller.connectionStatus).toBe('ready');
    });

    it('logs the outcome so it is legible from a live page', async () => {
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
        fetchRouter = () => ({ json: { resumable: true, sessionId: 'sess-FP', reason: 'ok' } });
        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'get_session') {
                reply({ type: 'immediate_response', requestId, status: 200, data: { sessionId: frame.sessionId, status: 'active', agentId: AGENT } });
            } else if (frame.action === 'get_conversation_messages') {
                reply({ type: 'immediate_response', requestId, status: 200, data: { messages: [], hasMore: false } });
            } else {
                defaultOnFrame(frame, reply);
            }
        };
        const { controller } = makeController();
        await controller.connect();
        expect(controller.lastResumeReason).toBe('ok');
        expect(debug).toHaveBeenCalledWith(expect.stringContaining('resume-by-fingerprint: resumed sess-FP (ok)'));
        debug.mockRestore();
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

describe('ConversationController — adversarial-review hardening (SMOODEV-2129e)', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
        MockSocket.onFrame = defaultOnFrame;
    });
    afterEach(() => localStorage.clear());

    it("posts every /internal/* route with credentials: 'omit' (CORS allowlist auth, not cookies)", async () => {
        fetchRouter = (path) => {
            if (path === '/internal/identity/request-otp') return { json: { event: 'otp_sent', maskedDestination: 'a***@x.com' } };
            return { json: { resumable: false } };
        };
        const { controller } = makeController();
        // connect() with no pointer fires /internal/resume-by-fingerprint.
        await controller.connect();
        // and the identity route fires too.
        await controller.requestIdentityOtp('ada@example.com');

        expect(fetchCalls.length).toBeGreaterThan(0);
        for (const call of fetchCalls) {
            expect(call.credentials, `${call.path} must omit credentials`).toBe('omit');
        }
    });

    it('does NOT thread verifiedEmail into a brand-new create_conversation_session', async () => {
        // Seed a verifiedEmail bound to some OTHER session — it must not leak onto a
        // freshly created session (which on a shared browser could be a new visitor).
        const seed = createWidgetStore(AGENT);
        seed.getState().setSessionId('sess-other');
        seed.getState().setVerifiedEmail('verified@example.com', 'sess-other');
        seed.getState().clearSession(); // clearing leaves no pointer → fresh create path

        // After clearSession the proof is gone; even if it weren't, a fresh create
        // must never carry it. Re-seed it post-clear to prove the create path itself
        // refuses to stamp it.
        seed.getState().setVerifiedEmail('verified@example.com', 'sess-other');

        const { controller } = makeController();
        await controller.connect();
        const create = MockSocket.sentFrames.find((f) => f.action === 'create_conversation_session') as Record<string, unknown>;
        expect(create).toBeTruthy();
        const meta = (create.metadata ?? {}) as Record<string, unknown>;
        expect(meta.verifiedEmail).toBeUndefined();
    });

    it('cross-device verify binds verifiedEmail to the live session id', async () => {
        MockSocket.onFrame = defaultOnFrame;
        fetchRouter = (path) => {
            switch (path) {
                case '/internal/resume-by-fingerprint':
                    return { json: { resumable: false } };
                case '/internal/identity/request-otp':
                    return { json: { event: 'otp_sent', maskedDestination: 'a***@x.com' } };
                case '/internal/identity/verify-otp':
                    return { json: { event: 'otp_verified' } };
                case '/internal/identity/resolve':
                    return { json: { resolved: true, conversations: [] } };
                default:
                    return { json: {} };
            }
        };
        const { controller, store } = makeController();
        await controller.connect(); // creates sess-new
        await controller.requestIdentityOtp('ada@example.com');
        await controller.verifyIdentityOtp('123456');
        await tick();
        expect(store.getState().verifiedEmail).toBe('ada@example.com');
        // Bound to the live session, not left unbound.
        expect(store.getState().verifiedEmailSessionId).toBe('sess-new');
    });

    it('requestIdentityOtp establishes a session first, so request-otp carries a sessionId (no "No active session" on verify)', async () => {
        // Simulate the restore-link race: the visitor submits the email BEFORE any
        // prior connect(). requestIdentityOtp must connect, then send sessionId.
        fetchRouter = (path) => {
            if (path === '/internal/identity/request-otp') return { json: { event: 'otp_sent', maskedDestination: 'a***@x.com' } };
            return { json: { resumable: false } };
        };
        const { controller } = makeController();
        // No connect() called first — straight to requestIdentityOtp.
        await controller.requestIdentityOtp('ada@example.com');

        const otpCall = fetchCalls.find((c) => c.path === '/internal/identity/request-otp');
        expect(otpCall, 'request-otp was sent').toBeTruthy();
        // A session was established and threaded through.
        expect(typeof otpCall?.body.sessionId).toBe('string');
        expect(otpCall?.body.sessionId).toBe('sess-new');
    });

    it('resume probe runs at most once: re-entering connect() after an error does not re-POST resume-by-fingerprint', async () => {
        let createCalls = 0;
        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'create_conversation_session') {
                createCalls += 1;
                if (createCalls === 1) {
                    // First create fails → controller goes to error.
                    reply({ type: 'error', requestId, data: { requestId, error: { code: 'BOOM', message: 'transient' } } });
                } else {
                    reply({ type: 'immediate_response', requestId, status: 202, data: { sessionId: 'sess-2', conversationId: 'c', agentId: frame.agentId } });
                }
            }
        };
        fetchRouter = () => ({ json: { resumable: false } });

        const { controller } = makeController();
        await expect(controller.connect()).rejects.toBeTruthy();
        // One resume-by-fingerprint probe on the first connect.
        const probesAfterFirst = fetchCalls.filter((c) => c.path === '/internal/resume-by-fingerprint').length;
        expect(probesAfterFirst).toBe(1);

        // Re-enter connect() after the error — must NOT re-run the resume probe.
        await controller.connect();
        const probesAfterSecond = fetchCalls.filter((c) => c.path === '/internal/resume-by-fingerprint').length;
        expect(probesAfterSecond, 'resume probe must run at most once').toBe(1);
    });
});

describe('ConversationController — Rich Interactions (identity_intake card)', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
        MockSocket.onFrame = defaultOnFrame;
    });
    afterEach(() => localStorage.clear());

    it('declares the card registry capabilities at session create', async () => {
        const { controller } = makeController();
        await controller.connect();
        const create = MockSocket.sentFrames.find((f) => f.action === 'create_conversation_session') as Record<string, unknown>;
        expect(create.supports).toEqual(['identity_form']);
    });

    it('parks on interaction_required, re-renders on invalid, resumes + persists identity on the ack', async () => {
        const interrupts: unknown[] = [];
        // Scripted operator: the turn raises the interaction; the first submit is
        // invalid (server-side validation), the second is acked and resumes.
        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'create_conversation_session') {
                reply({ type: 'immediate_response', requestId, status: 202, data: { sessionId: 'sess-1', conversationId: 'conv-1', agentId: frame.agentId } });
            } else if (frame.action === 'send_message') {
                reply({ type: 'immediate_response', requestId, status: 202, data: {} });
                reply({
                    type: 'interaction_required',
                    requestId,
                    data: {
                        requestId,
                        data: {
                            interactionId: 'int-1',
                            kind: 'identity_intake',
                            spec: {
                                fields: [
                                    { key: 'email', required: true, label: 'Work email' },
                                    { key: 'name', required: false },
                                ],
                            },
                            reason: 'to send you the quote',
                        },
                    },
                });
            } else if (frame.action === 'submit_interaction') {
                const values = frame.values as Record<string, unknown> | undefined;
                if (values?.email === 'nope') {
                    reply({
                        type: 'interaction_invalid',
                        requestId,
                        data: {
                            requestId,
                            data: {
                                interactionId: 'int-1',
                                kind: 'identity_intake',
                                errors: [{ field: 'email', message: 'must be a valid email address' }],
                                message: 'Some fields need attention.',
                            },
                        },
                    });
                } else {
                    // Valid: ack, then the parked turn resumes and completes.
                    reply({ type: 'immediate_response', requestId, status: 200, message: 'Interaction submitted', data: {} });
                    reply({ type: 'stream_token', requestId, token: 'Thanks!' });
                    reply({ type: 'eventual_response', requestId, status: 200, data: { requestId, status: 200, data: { messageId: 'm1', response: { responseParts: ['Thanks!'] } } } });
                }
            }
        };

        const { controller, store } = makeController({ onInterrupt: (i) => interrupts.push(i) });
        await controller.connect();
        const sent = controller.send('I want a quote');
        await tick();

        // 1. The card interrupt surfaced with the kind + spec + reason.
        const first = interrupts.at(-1) as { kind: string; interactionId: string; interactionKind: string; spec: Record<string, unknown>; reason?: string };
        expect(first?.kind).toBe('interaction');
        expect(first?.interactionId).toBe('int-1');
        expect(first?.interactionKind).toBe('identity_intake');
        expect(first?.reason).toBe('to send you the quote');
        expect(first?.spec.fields).toEqual([
            { key: 'email', required: true, label: 'Work email' },
            { key: 'name', required: false },
        ]);

        // 2. An invalid submit re-renders the SAME interrupt with per-field errors.
        controller.submitInteraction({ email: 'nope' });
        await tick();
        const submitted = MockSocket.sentFrames.find((f) => f.action === 'submit_interaction') as Record<string, unknown>;
        expect(submitted.interactionId).toBe('int-1');
        expect(submitted.kind).toBe('identity_intake');
        const invalid = interrupts.at(-1) as { kind: string; errors?: { field: string; message: string }[] };
        expect(invalid?.kind).toBe('interaction');
        expect(invalid?.errors).toEqual([{ field: 'email', message: 'must be a valid email address' }]);
        // Rejected values are NOT persisted.
        expect(store.getState().identity.email).toBeUndefined();

        // 3. A valid submit clears the interrupt, persists the accepted identity,
        //    and the turn resumes to completion.
        controller.submitInteraction({ email: 'ada@example.com', name: 'Ada' });
        await tick();
        await sent;
        expect(interrupts.at(-1)).toBeNull();
        expect(store.getState().identity.email).toBe('ada@example.com');
        expect(store.getState().identity.name).toBe('Ada');
    });

    it('decline sends declined: true and clears the interrupt without persisting anything', async () => {
        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'create_conversation_session') {
                reply({ type: 'immediate_response', requestId, status: 202, data: { sessionId: 'sess-1', conversationId: 'conv-1', agentId: frame.agentId } });
            } else if (frame.action === 'send_message') {
                reply({ type: 'immediate_response', requestId, status: 202, data: {} });
                reply({
                    type: 'interaction_required',
                    requestId,
                    data: {
                        requestId,
                        data: { interactionId: 'int-2', kind: 'identity_intake', spec: { fields: [{ key: 'email', required: true }] }, reason: 'to follow up' },
                    },
                });
            } else if (frame.action === 'submit_interaction') {
                reply({ type: 'immediate_response', requestId, status: 200, message: 'Interaction declined', data: {} });
                reply({ type: 'eventual_response', requestId, status: 200, data: { requestId, status: 200, data: { messageId: 'm1', response: { responseParts: ['No problem.'] } } } });
            }
        };

        const interrupts: unknown[] = [];
        const { controller, store } = makeController({ onInterrupt: (i) => interrupts.push(i) });
        await controller.connect();
        const sent = controller.send('quote please');
        await tick();
        expect((interrupts.at(-1) as { kind?: string })?.kind).toBe('interaction');

        controller.declineInteraction();
        await tick();
        await sent;
        const decline = MockSocket.sentFrames.find((f) => f.action === 'submit_interaction') as Record<string, unknown>;
        expect(decline.declined).toBe(true);
        expect(decline.interactionId).toBe('int-2');
        expect(decline.values).toBeUndefined();
        expect(interrupts.at(-1)).toBeNull();
        expect(store.getState().identity.email).toBeUndefined();
    });
});


describe('ConversationController — fast-model preamble (stream_preamble)', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
        MockSocket.onFrame = defaultOnFrame;
    });
    afterEach(() => localStorage.clear());

    it('shows the preamble in the typing slot, then the answer replaces it', async () => {
        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'create_conversation_session') {
                reply({ type: 'immediate_response', requestId, status: 202, data: { sessionId: 'sess-new', conversationId: 'conv-1', agentId: frame.agentId } });
            } else if (frame.action === 'send_message') {
                reply({ type: 'immediate_response', requestId, status: 202, data: {} });
                // Preamble arrives BEFORE any answer token (the whole point).
                reply({ type: 'stream_preamble', requestId, token: 'Let me check that.', data: { requestId, token: 'Let me check that.' } });
                reply({ type: 'stream_token', requestId, token: 'Hi' });
                reply({ type: 'eventual_response', requestId, status: 200, data: { requestId, status: 200, data: { messageId: 'm1', response: { responseParts: ['Hi there'] } } } });
            }
        };
        const { controller, onMessages } = makeController();
        await controller.connect();
        await controller.send('hello');
        await tick();

        type Snap = Array<{ role: string; text: string; preamble?: string }>;
        const snaps = onMessages.mock.calls.map((c) => c[0] as Snap);

        // At some point the assistant bubble carried the preamble with NO answer text yet.
        const showedPreamble = snaps.some((s) => {
            const a = s.find((m) => m.role === 'assistant');
            return a?.preamble === 'Let me check that.' && a.text === '';
        });
        expect(showedPreamble).toBe(true);

        // The final assistant message is the real answer, and the preamble is gone.
        const finalAssistant = snaps.at(-1)!.find((m) => m.role === 'assistant')!;
        expect(finalAssistant.text).toBe('Hi there');
        expect(finalAssistant.preamble).toBeUndefined();
    });

    it('ignores a preamble frame that arrives after the answer already started', async () => {
        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'create_conversation_session') {
                reply({ type: 'immediate_response', requestId, status: 202, data: { sessionId: 'sess-new', conversationId: 'conv-1', agentId: frame.agentId } });
            } else if (frame.action === 'send_message') {
                reply({ type: 'immediate_response', requestId, status: 202, data: {} });
                reply({ type: 'stream_token', requestId, token: 'Answer' });
                // A late preamble must NOT clobber the in-flight answer.
                reply({ type: 'stream_preamble', requestId, token: 'too late', data: { requestId, token: 'too late' } });
                reply({ type: 'eventual_response', requestId, status: 200, data: { requestId, status: 200, data: { messageId: 'm1', response: { responseParts: ['Answer'] } } } });
            }
        };
        const { controller, onMessages } = makeController();
        await controller.connect();
        await controller.send('hello');
        await tick();

        type Snap = Array<{ role: string; text: string; preamble?: string }>;
        const snaps = onMessages.mock.calls.map((c) => c[0] as Snap);
        const anyPreamble = snaps.some((s) => s.find((m) => m.role === 'assistant')?.preamble);
        expect(anyPreamble).toBeFalsy();
    });
});

describe('ConversationController — dead-session recovery on send', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
        MockSocket.onFrame = defaultOnFrame;
    });
    afterEach(() => localStorage.clear());

    /**
     * Seed a live persisted session and script the operator so `send_message`
     * into `deadFor` fails with `code`. Everything else is the default behaviour
     * (so a retry into a NEW session succeeds).
     */
    function seedLiveSessionThatFailsOnSend(sessionId: string, code: string, message: string, deadFor: string | null = sessionId): void {
        const seed = createWidgetStore(AGENT);
        seed.getState().setSessionId(sessionId);
        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'get_session') {
                reply({ type: 'immediate_response', requestId, status: 200, data: { sessionId, status: 'active', agentId: AGENT } });
            } else if (frame.action === 'get_conversation_messages') {
                reply({ type: 'immediate_response', requestId, status: 200, data: { messages: [], hasMore: false } });
            } else if (frame.action === 'send_message' && (deadFor === null || frame.sessionId === deadFor)) {
                reply({ type: 'immediate_response', requestId, status: 202, data: {} });
                reply({ type: 'error', requestId, data: { requestId, error: { code, message } } });
            } else {
                defaultOnFrame(frame, reply);
            }
        };
    }

    /** Every text the widget ever rendered, across all snapshots (not just the last). */
    function everyRenderedText(onMessages: ReturnType<typeof vi.fn>): string {
        return onMessages.mock.calls
            .flatMap((c) => (c[0] as Array<{ text: string }>).map((m) => m.text))
            .join('\n');
    }

    it('replaces a dead session and re-sends the turn — the visitor gets an answer, never the raw error', async () => {
        // The exact prod failure (2026-08-23): the widget connected fine, then
        // send_message came back `SESSION_NOT_FOUND` for the session it had just
        // resumed, and the raw string was rendered as an agent bubble.
        seedLiveSessionThatFailsOnSend('sess-dead', 'SESSION_NOT_FOUND', "session 'sess-dead' not found");

        const { controller, store, onMessages } = makeController();
        await controller.connect();
        expect(store.getState().sessionId).toBe('sess-dead');

        await controller.send('hi can you help me build a website');

        // The stale pointer was cleared and replaced with a fresh session…
        expect(MockSocket.sentFrames.filter((f) => f.action === 'create_conversation_session')).toHaveLength(1);
        expect(store.getState().sessionId).toBe('sess-new');
        // …and the turn was re-sent into it, so the visitor's message got answered.
        expect(MockSocket.sentFrames.filter((f) => f.action === 'send_message').map((f) => f.sessionId)).toEqual(['sess-dead', 'sess-new']);

        const last = onMessages.mock.calls.at(-1)?.[0] as Array<{ role: string; text: string; streaming: boolean }>;
        expect(last.map((m) => m.text)).toEqual(['hi can you help me build a website', 'Hi there']);
        expect(last.at(-1)?.streaming).toBe(false);

        // No snapshot ever carried the backend string, the session UUID, or an
        // `Error:` prefix — not even for one frame mid-recovery.
        const rendered = everyRenderedText(onMessages);
        expect(rendered).not.toContain('not found');
        expect(rendered).not.toContain('sess-dead');
        expect(rendered).not.toContain('Error:');
    });

    // A storage blip, an internal fault, or an auth rejection must NOT be treated
    // as "this session is dead" — spinning up a new session there would abandon a
    // live conversation the visitor can still come back to.
    for (const code of ['STORAGE_ERROR', 'INTERNAL_ERROR', 'AUTH_CONTEXT_INVALID', 'LLM_UNAVAILABLE']) {
        it(`keeps the session on ${code} — no fresh session, no retry, no raw error text`, async () => {
            seedLiveSessionThatFailsOnSend('sess-live', code, `boom: ${code} on session 'sess-live'`, null);

            const { controller, store, onMessages } = makeController();
            await controller.connect();
            await controller.send('hello');

            // The session survives, pointer and all.
            expect(MockSocket.sentFrames.find((f) => f.action === 'create_conversation_session')).toBeUndefined();
            expect(store.getState().sessionId).toBe('sess-live');
            // And the turn is NOT re-sent (a retry would double-charge a turn that
            // may well have run server-side).
            expect(MockSocket.sentFrames.filter((f) => f.action === 'send_message')).toHaveLength(1);

            const last = onMessages.mock.calls.at(-1)?.[0] as Array<{ text: string }>;
            expect(last.at(-1)?.text).toBe("We couldn't reach the chat.");
            const rendered = everyRenderedText(onMessages);
            expect(rendered).not.toContain('boom');
            expect(rendered).not.toContain('sess-live');
            expect(rendered).not.toContain('Error:');
        });
    }

    it('retries at most once — a server that always says not-found cannot spin sessions in a loop', async () => {
        seedLiveSessionThatFailsOnSend('sess-dead', 'SESSION_NOT_FOUND', "session 'sess-dead' not found", null);

        const { controller, onMessages } = makeController();
        await controller.connect();
        await controller.send('hello');

        expect(MockSocket.sentFrames.filter((f) => f.action === 'create_conversation_session')).toHaveLength(1);
        expect(MockSocket.sentFrames.filter((f) => f.action === 'send_message')).toHaveLength(2);

        const last = onMessages.mock.calls.at(-1)?.[0] as Array<{ text: string; streaming: boolean }>;
        expect(last.at(-1)?.text).toBe("We couldn't reach the chat.");
        expect(last.at(-1)?.streaming).toBe(false);
        expect(everyRenderedText(onMessages)).not.toContain('not found');
    });

    it('drops the OTP proof bound to the dead session when recovering', async () => {
        // `verifiedEmail` is proof-of-ownership bound to ONE session id. The session
        // it was proven for is gone, so the proof goes with it (clearSession) rather
        // than lingering in storage next to a brand-new session.
        seedLiveSessionThatFailsOnSend('sess-dead', 'SESSION_NOT_FOUND', "session 'sess-dead' not found");
        const seed = createWidgetStore(AGENT);
        seed.getState().setVerifiedEmail('ada@example.com', 'sess-dead');

        const { controller, store } = makeController();
        await controller.connect();
        await controller.send('hello');

        expect(store.getState().sessionId).toBe('sess-new');
        expect(store.getState().verifiedEmail).toBeNull();
        expect(store.getState().verifiedEmailSessionId).toBeNull();
    });

    it('honours a configured connectionErrorMessage for the give-up case', async () => {
        seedLiveSessionThatFailsOnSend('sess-live', 'INTERNAL_ERROR', 'internal detail', null);
        const { controller, onMessages } = makeController({}, { connectionErrorMessage: 'Something went wrong — try again?' });
        await controller.connect();
        await controller.send('hello');
        const last = onMessages.mock.calls.at(-1)?.[0] as Array<{ text: string }>;
        expect(last.at(-1)?.text).toBe('Something went wrong — try again?');
    });
});

/**
 * The optional resume probe must never take the chat down (SMOODEV, 2026-08-23).
 *
 * `/internal/resume-by-fingerprint` is an ENHANCEMENT — it recovers a returning
 * anonymous visitor's prior thread. Against prod it answers 401
 * (`AUTH_CONTEXT_REQUIRED`: the route is fail-closed for any agent with a
 * `public_key`, and the anonymous marketing widget sends no authContext) while
 * the WS create path stays permissive and healthy. So the probe failing is the
 * NORMAL steady state for a public agent, and every failure of it — 401, 5xx, a
 * network rejection, a malformed body — must degrade to "start a fresh session",
 * never to "the chat is unavailable".
 *
 * The boundary these tests pin: a failure REACHING THE OPTIONAL PROBE is
 * recoverable by starting fresh; a failure reaching the TRANSPORT ITSELF (no
 * socket) is genuinely fatal and must still surface the one human sentence.
 */
describe('ConversationController — an optional resume failure is never fatal', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
        MockSocket.onFrame = defaultOnFrame;
    });
    afterEach(() => localStorage.clear());

    /** Every way the probe can fail. Each must land on a fresh, working session. */
    const probeFailures: Array<[label: string, router: typeof fetchRouter]> = [
        ['401 AUTH_CONTEXT_REQUIRED (the live prod response)', () => ({ status: 401, json: { error: { code: 'AUTH_CONTEXT_REQUIRED', message: 'this agent requires a signed authContext' } } })],
        ['500 from the wrapper', () => ({ status: 500, json: { error: { code: 'INTERNAL_ERROR', message: 'boom' } } })],
        [
            'a network rejection (fetch itself throws)',
            () => {
                throw new TypeError('Failed to fetch');
            },
        ],
        ['a malformed 200 body (no resumable/sessionId)', () => ({ json: { unexpected: true } })],
    ];

    for (const [label, router] of probeFailures) {
        it(`falls through to a fresh working session on ${label}`, async () => {
            fetchRouter = router;
            const { controller, store, onMessages } = makeController();

            await expect(controller.connect()).resolves.toBeUndefined();
            expect(fetchCalls.some((c) => c.path === '/internal/resume-by-fingerprint')).toBe(true);
            // Degraded gracefully: a brand-new session, not an error.
            expect(MockSocket.sentFrames.find((f) => f.action === 'create_conversation_session')).toBeTruthy();
            expect(store.getState().sessionId).toBe('sess-new');
            expect(controller.connectionStatus).toBe('ready');

            // And the visitor gets a real answer, with no error text in the transcript.
            await controller.send('hello');
            const last = onMessages.mock.calls.at(-1)?.[0] as Array<{ role: string; text: string }>;
            expect(last.at(-1)?.text).toBe('Hi there');
            expect(last.some((m) => /couldn't reach the chat/i.test(m.text))).toBe(false);
        });
    }

    it('a persisted pointer whose get_session REJECTS still recovers into a fresh session', async () => {
        // Regression guard for the sibling path: the persisted-pointer branch has
        // always cleared the pointer and created fresh; keep it that way.
        const seed = createWidgetStore(AGENT);
        seed.getState().setSessionId('sess-old');
        MockSocket.onFrame = (frame, reply) => {
            if (frame.action === 'get_session') {
                reply({ type: 'immediate_response', requestId: frame.requestId, status: 500, error: { code: 'STORAGE_ERROR', message: 'db down' } });
            } else {
                defaultOnFrame(frame, reply);
            }
        };

        const { controller, store, onMessages } = makeController();
        await expect(controller.connect()).resolves.toBeUndefined();
        expect(store.getState().sessionId).toBe('sess-new');
        expect(controller.connectionStatus).toBe('ready');

        await controller.send('hello');
        const last = onMessages.mock.calls.at(-1)?.[0] as Array<{ text: string }>;
        expect(last.at(-1)?.text).toBe('Hi there');
    });

    it('a genuinely unreachable endpoint is STILL fatal — the visitor sees the one human sentence', async () => {
        // The other side of the boundary: no transport at all is not recoverable by
        // starting fresh, so it must NOT be swallowed. It renders the human sentence
        // in the transcript (never the raw machine error) and flags the status channel.
        (globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
            constructor() {
                throw new Error('ECONNREFUSED wss://example.test/ws');
            }
        };

        const { controller, onMessages, onStatus } = makeController();
        // `send()` must not reject: a dropped promise means the visitor's typed text
        // vanishes with nothing in the transcript (and an unhandled rejection on the
        // host page).
        await expect(controller.send('hello')).resolves.toBeUndefined();

        const last = onMessages.mock.calls.at(-1)?.[0] as Array<{ role: string; text: string }>;
        expect(last.at(-1)?.text).toBe("We couldn't reach the chat.");
        // The user's own message is still in the transcript — it wasn't silently eaten.
        expect(last.some((m) => m.role === 'user' && m.text === 'hello')).toBe(true);
        // Raw machine detail goes to the status channel, never the bubble.
        expect(last.some((m) => /ECONNREFUSED/.test(m.text))).toBe(false);
        expect(onStatus.mock.calls.some(([s]) => s === 'error')).toBe(true);
    });
});

/**
 * `send()` must never emit a turn before the session it references exists.
 *
 * Prod, smoo.ai: a clean visitor completed the pre-chat form, the status went
 * "Online", and then EVERY send failed with "We couldn't reach the chat." An
 * instrumented socket showed `send_message` leaving BEFORE the
 * `create_conversation_session` response came back.
 *
 * Four of the six `connect()` call sites are fire-and-forget `void connect()`
 * (launcher click, pre-chat submit, full-page mount, voice hand-off), so an
 * awaiting caller racing an in-flight one is the NORMAL case. `connect()` used
 * to `return` bare while one was in flight — the right guard (one connect, not
 * two) returning the wrong thing (an already-resolved promise), which made every
 * `await connect()` resolve before a session existed.
 */
describe('ConversationController — connect races (send never outruns its session)', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
        installMockFetch();
        MockSocket.onFrame = defaultOnFrame;
    });
    afterEach(() => localStorage.clear());

    /** Operator whose `create_conversation_session` answers only after a tick. */
    function slowCreate(sessionId = 'sess-new'): void {
        MockSocket.onFrame = (frame, reply) => {
            if (frame.action === 'create_conversation_session') {
                setTimeout(() => {
                    reply({ type: 'immediate_response', requestId: frame.requestId, status: 202, data: { sessionId, conversationId: 'conv-1', agentId: frame.agentId } });
                }, 5);
                return;
            }
            defaultOnFrame(frame, reply);
        };
    }

    /** The frame order the live instrumentation printed, as a comparable list. */
    const frameOrder = () => MockSocket.sentFrames.map((f) => f.action as string);

    it('a send racing an in-flight connect waits for it, and carries the created session id', async () => {
        // Exactly the pre-chat submit → visitor sends immediately sequence.
        slowCreate('sess-created');
        const { controller } = makeController();

        void controller.connect(); // the fire-and-forget one (pre-chat submit)
        await controller.send('hello'); // the visitor's first turn, milliseconds later

        // ONE session was created — the in-flight guard still holds…
        expect(frameOrder().filter((a) => a === 'create_conversation_session')).toHaveLength(1);
        // …the create was ordered BEFORE the send (never the inverted order the
        // live socket trace showed)…
        expect(frameOrder()).toEqual(['create_conversation_session', 'send_message']);
        // …and the turn went into the session that create actually produced.
        expect(MockSocket.sentFrames.filter((f) => f.action === 'send_message').map((f) => f.sessionId)).toEqual(['sess-created']);
    });

    it('concurrent connects share one connect and one session', async () => {
        slowCreate();
        const { controller } = makeController();
        await Promise.all([controller.connect(), controller.connect(), controller.connect()]);
        expect(frameOrder().filter((a) => a === 'create_conversation_session')).toHaveLength(1);
        expect(controller.connectionStatus).toBe('ready');
    });

    it('a create that yields no sessionId FAILS instead of reporting ready', async () => {
        // `request()` resolves on the FIRST frame carrying the requestId, so a
        // wrapper that ACKs before the session exists resolves the create with an
        // empty payload. Accepting that assigned `undefined` and flipped the
        // status to 'ready' — the permanent wedge behind "status went Online, then
        // every send fails": each later send hits `!this.sessionId`, calls
        // `connect()`, is early-returned by the 'ready' status, and throws again.
        MockSocket.onFrame = (frame, reply) => {
            if (frame.action === 'create_conversation_session') {
                reply({ type: 'immediate_response', requestId: frame.requestId, status: 202, data: {} });
                return;
            }
            defaultOnFrame(frame, reply);
        };
        const { controller } = makeController();

        await expect(controller.connect()).rejects.toThrow(/no sessionId/);
        expect(controller.connectionStatus).toBe('error');
        // No turn was emitted into a session that does not exist.
        expect(frameOrder()).not.toContain('send_message');
    });

    it('a wedged connect cannot spin: repeated sends make a BOUNDED number of attempts', async () => {
        // The loop the live trace showed — send fails, recovery creates, the retry
        // fails again — must not be unbounded. Each send is allowed to try to
        // establish a session; none may retry within itself forever.
        MockSocket.onFrame = (frame, reply) => {
            if (frame.action === 'create_conversation_session') {
                reply({ type: 'immediate_response', requestId: frame.requestId, status: 202, data: {} });
                return;
            }
            defaultOnFrame(frame, reply);
        };
        const { controller, onMessages } = makeController();

        for (let i = 0; i < 3; i++) await controller.send(`attempt ${i}`);

        // One create attempt per visitor send — never a self-feeding loop.
        expect(frameOrder().filter((a) => a === 'create_conversation_session')).toHaveLength(3);
        expect(frameOrder()).not.toContain('send_message');
        // And every attempt told the visitor the same one human sentence.
        const last = onMessages.mock.calls.at(-1)?.[0] as Array<{ text: string }>;
        expect(last.at(-1)?.text).toBe("We couldn't reach the chat.");
        expect(last.some((m) => /sessionId/.test(m.text))).toBe(false);
    });

    it('a send after a successful connect reuses the session — no reconnect, no second create', async () => {
        slowCreate('sess-created');
        const { controller } = makeController();
        await controller.connect();
        await controller.send('one');
        await controller.send('two');
        expect(frameOrder().filter((a) => a === 'create_conversation_session')).toHaveLength(1);
        expect(MockSocket.sentFrames.filter((f) => f.action === 'send_message').map((f) => f.sessionId)).toEqual(['sess-created', 'sess-created']);
    });
});
