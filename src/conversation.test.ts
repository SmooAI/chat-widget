/**
 * ConversationController integration tests (jsdom + a deterministic mock
 * WebSocket). The controller builds its own browser transport over the global
 * `WebSocket`, so we install a scriptable mock that captures outbound frames and
 * replays operator-shaped responses correlated by `requestId`.
 *
 * These cover the 0.7.0 identity / persistence / consent contract (ADR-048):
 *   - createConversationSession carries browserFingerprint + identity + consent
 *     + phone-on-metadata,
 *   - same-session resume hydrates history and reuses the sessionId,
 *   - an ended session clears the pointer and starts fresh,
 *   - the cross-device request → verify → resolve → replay flow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationController, type ConversationEvents, type IdentityRestore } from './conversation.js';
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

describe('ConversationController — cross-device restore (ADR-048 §c)', () => {
    beforeEach(() => {
        localStorage.clear();
        installMockWs();
    });
    afterEach(() => localStorage.clear());

    it('runs request → verify → resolve → replay and persists verifiedEmail', async () => {
        const restoreStates: IdentityRestore[] = [];
        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            switch (frame.action) {
                case 'create_conversation_session':
                    reply({ type: 'immediate_response', requestId, status: 202, data: { sessionId: 'sess-new', conversationId: 'c', agentId: AGENT } });
                    break;
                case 'request_identity_otp':
                    expect(frame.email).toBe('ada@example.com');
                    reply({ type: 'otp_sent', requestId, data: { requestId, data: { channel: 'email', maskedDestination: 'a***@example.com' } } });
                    break;
                case 'verify_identity_otp':
                    expect(frame.code).toBe('123456');
                    reply({ type: 'otp_verified', requestId, data: { requestId, data: { message: 'ok' } } });
                    break;
                case 'resolve_identity':
                    reply({
                        type: 'immediate_response',
                        requestId,
                        status: 200,
                        data: { resolved: true, crmContactId: 'crm-1', conversations: [{ conversationId: 'conv-9', sessionId: 'sess-9', lastActivityAt: '2026-01-01T00:00:00Z', preview: 'Past chat' }] },
                    });
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

        const { controller, store, onMessages } = makeController({ onIdentityRestore: (s) => restoreStates.push(s) });
        await controller.connect();

        controller.requestIdentityOtp('ada@example.com', 'email');
        await tick();
        expect(restoreStates.at(-1)?.phase).toBe('awaiting_code');

        controller.verifyIdentityOtp('123456');
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
        MockSocket.onFrame = (frame, reply) => {
            const requestId = frame.requestId;
            if (frame.action === 'create_conversation_session') {
                reply({ type: 'immediate_response', requestId, status: 202, data: { sessionId: 'sess-new', conversationId: 'c', agentId: AGENT } });
            } else if (frame.action === 'request_identity_otp') {
                reply({ type: 'otp_sent', requestId, data: { requestId, data: { channel: 'email', maskedDestination: 'a***@x.com' } } });
            } else if (frame.action === 'verify_identity_otp') {
                reply({ type: 'otp_invalid', requestId, data: { requestId, data: { error: 'INVALID_CODE', attemptsRemaining: 2, message: 'nope' } } });
            }
        };
        const { controller } = makeController({ onIdentityRestore: (s) => restoreStates.push(s) });
        await controller.connect();
        controller.requestIdentityOtp('ada@example.com');
        await tick();
        controller.verifyIdentityOtp('000000');
        await tick();
        const last = restoreStates.at(-1);
        expect(last?.phase).toBe('awaiting_code');
        expect(last?.phase === 'awaiting_code' ? last.attemptsRemaining : null).toBe(2);
    });
});
