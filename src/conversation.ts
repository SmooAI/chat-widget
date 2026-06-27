/**
 * ConversationController — the bridge between the widget UI and the
 * `@smooai/smooth-operator` protocol client.
 *
 * This is the piece that was rewired: the original smooai widget spoke to
 * `@smooai/realtime`; here every protocol action goes through {@link SmoothAgentClient}.
 * The wire shapes are identical (the protocol was lifted from `@smooai/realtime`),
 * so the swap is purely at the client-library boundary.
 *
 * Flow:
 *   1. `connect()`        → opens the WebSocket transport and `create_conversation_session`
 *                           (or RESUMES a persisted session via `get_session`/`get_messages`).
 *   2. `send(text)`       → `send_message`, streaming `stream_token` deltas into the
 *                           in-progress assistant message, then the terminal
 *                           `eventual_response`.
 *
 * 0.7.0 (SMOODEV-2129e) adds the identity / persistence / consent client layer:
 *   - `browserFingerprint` computed once + sent on every `create_conversation_session`.
 *   - identity + marketing consent threaded into the session `metadata`.
 *   - same-session RESUME on load (no engine change — `get_session` + `get_messages`).
 *   - cross-device "restore my chats" (`request_identity_otp` / `verify_identity_otp`
 *     / `resolve_identity`) sent as raw frames over a shared transport.
 *
 * The controller is UI-agnostic: it emits typed events and the view renders them.
 */
import { type Citation, ProtocolError, type ServerEvent, SmoothAgentClient, type Transport, type TransportState } from '@smooai/smooth-operator';
import type { StoreApi } from 'zustand/vanilla';
import type { ChatWidgetConfig } from './config.js';
import { getOrCreateFingerprint } from './fingerprint.js';
import { type ConsentState, createWidgetStore, type WidgetStore } from './persistence.js';

/**
 * A tiny browser `WebSocket` transport implementing the engine's {@link Transport}
 * contract. We inject our own (rather than letting the client build its default)
 * for two reasons: (1) it keeps a reference to `send()` so we can emit the custom
 * cross-device frames the engine client doesn't model, and (2) it sidesteps a
 * bundling quirk — the IIFE build aliases `@smooai/smooth-operator` to its
 * `client.js`, which imports but does not RE-export `WebSocketTransport`, so the
 * package's own transport isn't reachable from the global bundle. This class is a
 * faithful, minimal equivalent of `WebSocketTransport` over the global socket.
 */
class BrowserWebSocketTransport implements Transport {
    private socket: WebSocket | null = null;
    private readonly messageHandlers = new Set<(data: string) => void>();
    private readonly closeHandlers = new Set<(info: { code?: number; reason?: string }) => void>();
    private readonly errorHandlers = new Set<(err: unknown) => void>();

    constructor(private readonly url: string) {}

    get state(): TransportState {
        const s = this.socket;
        if (!s) return 'closed';
        switch (s.readyState) {
            case WebSocket.CONNECTING:
                return 'connecting';
            case WebSocket.OPEN:
                return 'open';
            case WebSocket.CLOSING:
                return 'closing';
            default:
                return 'closed';
        }
    }

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const socket = new WebSocket(this.url);
                this.socket = socket;
                socket.addEventListener('open', () => resolve());
                socket.addEventListener('error', (ev) => {
                    for (const h of this.errorHandlers) h(ev);
                    if (socket.readyState !== WebSocket.OPEN) reject(new Error('WebSocket connection failed'));
                });
                socket.addEventListener('message', (ev: MessageEvent) => {
                    const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
                    for (const h of this.messageHandlers) h(data);
                });
                socket.addEventListener('close', (ev: CloseEvent) => {
                    for (const h of this.closeHandlers) h({ code: ev.code, reason: ev.reason });
                });
            } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    send(data: string): void {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            throw new Error('Transport is not open');
        }
        this.socket.send(data);
    }

    close(code?: number, reason?: string): void {
        try {
            this.socket?.close(code, reason);
        } catch {
            /* closing an already-closed socket is non-fatal */
        }
    }

    onMessage(handler: (data: string) => void): () => void {
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
    }

    onClose(handler: (info: { code?: number; reason?: string }) => void): () => void {
        this.closeHandlers.add(handler);
        return () => this.closeHandlers.delete(handler);
    }

    onError(handler: (err: unknown) => void): () => void {
        this.errorHandlers.add(handler);
        return () => this.errorHandlers.delete(handler);
    }
}

export type { Citation };

export type Role = 'user' | 'assistant';

export interface ChatMessage {
    id: string;
    role: Role;
    /** Accumulated text (assistant messages grow as tokens stream in). */
    text: string;
    /** True while an assistant message is still streaming. */
    streaming: boolean;
    /**
     * Sources that grounded an assistant answer, when the terminal
     * `eventual_response` carried any. Optional + back-compatible: absent when
     * the turn used no knowledge sources (or for user messages). Read
     * defensively off the terminal event — see {@link extractCitations}.
     */
    citations?: Citation[];
}

export type ConnectionStatus = 'idle' | 'connecting' | 'ready' | 'error' | 'closed';

/**
 * A mid-turn pause that needs the visitor to act before the agent can continue:
 *
 * - `otp` — the agent requested OTP verification before an authenticated action.
 *   Resume with {@link ConversationController.verifyOtp}.
 * - `confirm` — the agent wants to run a state-mutating tool and needs approval.
 *   Resume with {@link ConversationController.confirmTool}.
 */
export type Interrupt =
    | {
          kind: 'otp';
          toolId?: string;
          actionDescription?: string;
          availableChannels: ('email' | 'sms')[];
          /** Set once the server confirms an OTP was dispatched. */
          sent?: { channel?: string; maskedDestination?: string };
          /** Set when a submitted code was rejected. */
          error?: string;
          attemptsRemaining?: number;
      }
    | { kind: 'confirm'; toolId?: string; actionDescription?: string };

export interface UserInfo {
    name?: string;
    email?: string;
    phone?: string;
    /** Marketing-consent opt-ins captured at the pre-chat form (ADR-048). */
    consent?: { emailOptIn: boolean; smsOptIn: boolean };
}

/** One conversation surfaced by `resolve_identity` for the cross-device picker. */
export interface RestorableConversation {
    conversationId: string;
    sessionId: string;
    lastActivityAt?: string;
    preview?: string;
}

/**
 * State machine for the cross-device "restore my chats" flow. Mirrors the
 * `request_identity_otp` → `verify_identity_otp` → `resolve_identity` verbs
 * (ADR-048 §c). The view renders a panel off this.
 */
export type IdentityRestore =
    | { phase: 'idle' }
    /** UI-local: the email-entry step before any frame is sent. */
    | { phase: 'awaiting_email'; error?: string }
    | { phase: 'requesting'; email: string; channel: 'email' | 'sms' }
    | { phase: 'awaiting_code'; email: string; channel: 'email' | 'sms'; maskedDestination?: string; error?: string; attemptsRemaining?: number }
    | { phase: 'verifying'; email: string; channel: 'email' | 'sms' }
    | { phase: 'resolving'; email: string }
    | { phase: 'resolved'; email: string; conversations: RestorableConversation[] }
    | { phase: 'error'; message: string };

export interface ConversationEvents {
    /** Fired whenever the message list changes (append, token delta, finalize). */
    onMessages: (messages: ChatMessage[]) => void;
    /** Fired on connection-status transitions. */
    onStatus: (status: ConnectionStatus, detail?: string) => void;
    /** Fired when a turn pauses for OTP / tool-confirmation, and `null` when it clears. */
    onInterrupt?: (interrupt: Interrupt | null) => void;
    /** Fired on cross-device identity-restore state transitions. */
    onIdentityRestore?: (state: IdentityRestore) => void;
}

/** Pull the final assistant text out of an `eventual_response` data payload. */
function extractFinalText(response: unknown): string | null {
    if (!response || typeof response !== 'object') return null;
    const r = response as { responseParts?: unknown };
    if (Array.isArray(r.responseParts)) {
        return r.responseParts.filter((p): p is string => typeof p === 'string').join('\n\n');
    }
    return null;
}

/**
 * Pull the grounding {@link Citation}s out of a terminal `eventual_response`.
 *
 * The protocol client types these (`eventual_response.data.data.citations`),
 * but they're optional and back-compatible — absent when the turn used no
 * knowledge sources. We read them defensively (tolerating their total absence,
 * non-array shapes, and missing fields) so a server that doesn't emit them, or
 * an older client, can't break rendering. Each citation always carries
 * `id`/`title`/`snippet`/`score`; `url` is present only for web-sourced docs.
 */
function extractCitations(inner: unknown): Citation[] {
    if (!inner || typeof inner !== 'object') return [];
    const raw = (inner as { citations?: unknown }).citations;
    if (!Array.isArray(raw)) return [];
    const out: Citation[] = [];
    for (const c of raw) {
        if (!c || typeof c !== 'object') continue;
        const obj = c as Record<string, unknown>;
        const id = typeof obj.id === 'string' ? obj.id : '';
        const title = typeof obj.title === 'string' ? obj.title : id || 'Source';
        const snippet = typeof obj.snippet === 'string' ? obj.snippet : '';
        const url = typeof obj.url === 'string' && obj.url ? obj.url : undefined;
        const score = typeof obj.score === 'number' ? obj.score : 0;
        out.push({ id, title, snippet, score, url });
    }
    return out;
}

/** A `get_conversation_messages` row, narrowed defensively off the wire. */
interface WireMessage {
    id?: string;
    direction?: 'inbound' | 'outbound';
    content?: { text?: string };
    createdAt?: string;
}

/** Convert a server message row into a finalized {@link ChatMessage}. */
function wireMessageToChat(m: WireMessage, idx: number): ChatMessage | null {
    const text = typeof m.content?.text === 'string' ? m.content.text : '';
    if (!text) return null;
    const role: Role = m.direction === 'outbound' ? 'assistant' : 'user';
    return { id: typeof m.id === 'string' ? m.id : `hist-${idx}`, role, text, streaming: false };
}

export class ConversationController {
    private readonly config: ChatWidgetConfig;
    private readonly events: ConversationEvents;
    private readonly store: StoreApi<WidgetStore>;
    private client: SmoothAgentClient | null = null;
    /** Shared transport — kept so we can send the custom cross-device frames. */
    private transport: BrowserWebSocketTransport | null = null;
    private sessionId: string | null = null;
    private readonly messages: ChatMessage[] = [];
    private status: ConnectionStatus = 'idle';
    private seq = 0;
    /** requestId of the in-flight turn — used to resume OTP / tool confirmations. */
    private activeRequestId: string | null = null;
    private interrupt: Interrupt | null = null;
    private identityRestore: IdentityRestore = { phase: 'idle' };
    /** Pending cross-device verb resolvers, keyed by the requestId we minted. */
    private readonly identityWaiters = new Map<string, (event: ServerEvent) => void>();
    private unsubscribeEvents: (() => void) | null = null;

    constructor(config: ChatWidgetConfig, events: ConversationEvents, store?: StoreApi<WidgetStore>) {
        this.config = config;
        this.events = events;
        this.store = store ?? createWidgetStore(config.agentId);
        // Seed identity from config into the persisted store (config wins on first
        // load; the persisted values survive across reloads thereafter).
        const seed: { name?: string; email?: string; phone?: string } = {};
        if (config.userName) seed.name = config.userName;
        if (config.userEmail) seed.email = config.userEmail;
        if (config.userPhone) seed.phone = config.userPhone;
        if (Object.keys(seed).length > 0) this.store.getState().mergeIdentity(seed);
    }

    get connectionStatus(): ConnectionStatus {
        return this.status;
    }

    /** The persisted store, exposed so the view can read identity for the pre-chat gate. */
    getStore(): StoreApi<WidgetStore> {
        return this.store;
    }

    /** True when a persisted session pointer exists (drives the resume path). */
    hasPersistedSession(): boolean {
        return !!this.store.getState().sessionId;
    }

    /** True when persisted identity exists (lets the view skip the pre-chat form). */
    hasPersistedIdentity(): boolean {
        const id = this.store.getState().identity;
        return !!(id.name || id.email || id.phone);
    }

    /** Merge in visitor identity + consent (from the pre-chat form). Applied on next connect. */
    setUserInfo(info: UserInfo): void {
        const { name, email, phone, consent } = info;
        this.store.getState().mergeIdentity({ name, email, phone });
        if (consent) {
            const consentAt = consent.emailOptIn || consent.smsOptIn ? new Date().toISOString() : undefined;
            this.store.getState().setConsent({
                emailOptIn: consent.emailOptIn,
                smsOptIn: consent.smsOptIn,
                consentSource: 'chat-widget-prechat',
                consentAt,
            });
        }
    }

    private setInterrupt(interrupt: Interrupt | null): void {
        this.interrupt = interrupt;
        this.events.onInterrupt?.(interrupt);
    }

    private setIdentityRestore(state: IdentityRestore): void {
        this.identityRestore = state;
        this.events.onIdentityRestore?.(state);
    }

    get currentIdentityRestore(): IdentityRestore {
        return this.identityRestore;
    }

    /** Submit an OTP code to resume the paused turn. No-op if not awaiting OTP. */
    verifyOtp(code: string): void {
        if (!this.client || !this.sessionId || !this.activeRequestId || this.interrupt?.kind !== 'otp') return;
        this.client.verifyOtp({ sessionId: this.sessionId, requestId: this.activeRequestId, code });
    }

    /** Approve or reject a pending tool write to resume the paused turn. */
    confirmTool(approved: boolean): void {
        if (!this.client || !this.sessionId || !this.activeRequestId || this.interrupt?.kind !== 'confirm') return;
        this.client.confirmToolAction({ sessionId: this.sessionId, requestId: this.activeRequestId, approved });
        this.setInterrupt(null);
    }

    private nextId(prefix: string): string {
        this.seq += 1;
        return `${prefix}-${this.seq}-${Date.now().toString(36)}`;
    }

    private setStatus(status: ConnectionStatus, detail?: string): void {
        this.status = status;
        this.events.onStatus(status, detail);
    }

    private emitMessages(): void {
        // Hand out a shallow copy so the view can't mutate internal state.
        this.events.onMessages(this.messages.map((m) => ({ ...m })));
    }

    /** Compute (once) + return the persisted browser fingerprint. */
    private fingerprint(): string {
        const state = this.store.getState();
        return getOrCreateFingerprint(
            () => state.browserFingerprint,
            (fp) => this.store.getState().setBrowserFingerprint(fp),
        );
    }

    /**
     * Build the `metadata` payload threaded into `create_conversation_session`:
     * phone (no first-class engine field), consent, and a verified email when known.
     */
    private sessionMetadata(): Record<string, unknown> | undefined {
        const state = this.store.getState();
        const meta: Record<string, unknown> = {};
        if (state.identity.phone) meta.userPhone = state.identity.phone;
        const consent = state.consent;
        if (consent.emailOptIn || consent.smsOptIn || consent.consentAt) {
            const c: ConsentState = {
                emailOptIn: consent.emailOptIn,
                smsOptIn: consent.smsOptIn,
                consentSource: consent.consentSource ?? 'chat-widget-prechat',
            };
            if (consent.consentAt) c.consentAt = consent.consentAt;
            meta.consent = c;
        }
        if (state.verifiedEmail) meta.verifiedEmail = state.verifiedEmail;
        return Object.keys(meta).length > 0 ? meta : undefined;
    }

    /** Lazily open the shared transport + client. Idempotent within a connect. */
    private async ensureClient(): Promise<void> {
        if (this.client) return;
        this.transport = new BrowserWebSocketTransport(this.config.endpoint);
        this.client = new SmoothAgentClient({ url: this.config.endpoint, transport: this.transport });
        // Route custom cross-device frames (and any unsolicited event) here.
        this.unsubscribeEvents = this.client.onEvent((event) => this.handleUnsolicited(event));
        await this.client.connect();
    }

    /**
     * Open the transport and either RESUME a persisted session or create a new one.
     *
     * Resume (ADR-048 §b): if a persisted `sessionId` exists → `get_session`; when
     * its `status !== 'ended'` we reuse it and hydrate the transcript from
     * `get_messages` (newest-first page, reversed to chronological). On `ended`/404
     * we clear ONLY the session pointer (identity/consent survive) and create fresh.
     */
    async connect(): Promise<void> {
        if (this.status === 'connecting' || this.status === 'ready') return;
        this.setStatus('connecting');
        try {
            await this.ensureClient();
            const persistedSessionId = this.store.getState().sessionId;
            if (persistedSessionId) {
                const resumed = await this.tryResume(persistedSessionId);
                if (resumed) {
                    this.setStatus('ready');
                    return;
                }
                // Resume failed (ended/404/gone) — clear the pointer, keep identity.
                this.store.getState().clearSession();
            }
            await this.createSession();
            this.setStatus('ready');
        } catch (err) {
            this.setStatus('error', err instanceof Error ? err.message : String(err));
            throw err;
        }
    }

    /** `create_conversation_session` with fingerprint + identity + consent metadata. */
    private async createSession(): Promise<void> {
        if (!this.client) throw new Error('Conversation is not connected');
        const state = this.store.getState();
        const metadata = this.sessionMetadata();
        const session = await this.client.createConversationSession({
            agentId: this.config.agentId,
            userName: state.identity.name,
            userEmail: state.identity.email,
            browserFingerprint: this.fingerprint(),
            ...(metadata ? { metadata } : {}),
        });
        this.sessionId = session.sessionId;
        this.store.getState().setSessionId(session.sessionId);
    }

    /**
     * Attempt to resume `sessionId`: returns true and hydrates the transcript when
     * the session is live, false when it has ended / can't be fetched.
     */
    private async tryResume(sessionId: string): Promise<boolean> {
        if (!this.client) return false;
        let snap: { status?: 'active' | 'idle' | 'ended' };
        try {
            snap = await this.client.getSession({ sessionId });
        } catch {
            return false; // 404 / SESSION_NOT_FOUND / network — start fresh.
        }
        if (snap.status === 'ended') return false;

        this.sessionId = sessionId;
        await this.hydrateHistory(sessionId);
        return true;
    }

    /** Page recent history (newest-first), reverse to chronological, and render. */
    private async hydrateHistory(sessionId: string): Promise<void> {
        if (!this.client) return;
        try {
            const page = await this.client.getMessages({ sessionId, limit: 50 });
            const rows = Array.isArray(page.messages) ? page.messages : [];
            // The server returns newest-first; reverse to chronological for the UI.
            const chronological = [...rows].reverse();
            const hydrated: ChatMessage[] = [];
            chronological.forEach((m, i) => {
                const chat = wireMessageToChat(m as WireMessage, i);
                if (chat) hydrated.push(chat);
            });
            this.messages.length = 0;
            this.messages.push(...hydrated);
            this.emitMessages();
        } catch {
            // History fetch is best-effort: a resumable session with no fetchable
            // history just shows an empty transcript rather than failing the resume.
        }
    }

    /**
     * Submit a user message. Appends the user bubble immediately, then streams the
     * assistant reply token-by-token, finalizing on `eventual_response`.
     */
    async send(text: string): Promise<void> {
        const trimmed = text.trim();
        if (!trimmed) return;
        if (!this.client || !this.sessionId || this.status !== 'ready') {
            await this.connect();
        }
        if (!this.client || !this.sessionId) {
            throw new Error('Conversation is not connected');
        }

        // 1. User bubble.
        this.messages.push({ id: this.nextId('u'), role: 'user', text: trimmed, streaming: false });

        // 2. Placeholder assistant bubble we grow as tokens arrive.
        const assistant: ChatMessage = { id: this.nextId('a'), role: 'assistant', text: '', streaming: true };
        this.messages.push(assistant);
        this.emitMessages();

        try {
            const turn = this.client.sendMessage({ sessionId: this.sessionId, message: trimmed, stream: true });
            this.activeRequestId = turn.requestId;

            for await (const event of turn) {
                if (event.type === 'stream_token') {
                    const token = event.token ?? event.data?.token ?? '';
                    if (token) {
                        assistant.text += token;
                        this.emitMessages();
                    }
                } else {
                    // OTP / tool-confirmation pauses surface here; the loop keeps
                    // iterating once the visitor resumes via verifyOtp/confirmTool.
                    this.handleTurnEvent(event);
                }
            }

            const final = await turn;
            const inner = final.data?.data;
            const finalText = extractFinalText(inner?.response);
            if (finalText && finalText.length > assistant.text.length) {
                assistant.text = finalText;
            }
            if (!assistant.text) {
                assistant.text = '(no response)';
            }
            // Attach grounding sources from the terminal event, when present.
            const citations = extractCitations(inner);
            if (citations.length > 0) {
                assistant.citations = citations;
            }
            assistant.streaming = false;
            this.emitMessages();
        } catch (err) {
            assistant.streaming = false;
            const message =
                err instanceof ProtocolError
                    ? `Error: ${err.message}`
                    : (this.config.connectionErrorMessage ?? "We couldn't reach the chat.");
            assistant.text = assistant.text ? `${assistant.text}\n\n${message}` : message;
            this.emitMessages();
            this.setStatus('error', err instanceof Error ? err.message : String(err));
        } finally {
            this.activeRequestId = null;
            this.setInterrupt(null);
        }
    }

    /** Map a non-token turn event (OTP / tool-confirmation lifecycle) to interrupt state. */
    private handleTurnEvent(event: ServerEvent): void {
        const inner = ((event as { data?: { data?: Record<string, unknown> } }).data?.data ?? {}) as Record<string, unknown>;
        const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
        const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
        switch (event.type) {
            case 'otp_verification_required': {
                const channels: ('email' | 'sms')[] = Array.isArray(inner.availableChannels)
                    ? inner.availableChannels.filter((c): c is 'email' | 'sms' => c === 'email' || c === 'sms')
                    : ['email'];
                this.setInterrupt({
                    kind: 'otp',
                    toolId: str(inner.toolId),
                    actionDescription: str(inner.actionDescription),
                    availableChannels: channels.length > 0 ? channels : ['email'],
                });
                break;
            }
            case 'otp_sent':
                if (this.interrupt?.kind === 'otp') {
                    this.setInterrupt({ ...this.interrupt, sent: { channel: str(inner.channel), maskedDestination: str(inner.maskedDestination) }, error: undefined });
                }
                break;
            case 'otp_verified':
                if (this.interrupt?.kind === 'otp') this.setInterrupt(null);
                break;
            case 'otp_invalid':
                if (this.interrupt?.kind === 'otp') {
                    this.setInterrupt({ ...this.interrupt, error: str(inner.message) ?? 'That code was incorrect.', attemptsRemaining: num(inner.attemptsRemaining) });
                }
                break;
            case 'write_confirmation_required':
                this.setInterrupt({ kind: 'confirm', toolId: str(inner.toolId), actionDescription: str(inner.actionDescription) });
                break;
            default:
                break;
        }
    }

    // ─────────────────── Cross-device "restore my chats" (§c) ───────────────────

    /**
     * Send a raw frame over the shared transport for a custom verb the engine
     * client doesn't model (`request_identity_otp` etc.), then route the matching
     * response back via {@link handleUnsolicited}. Returns the minted requestId.
     */
    private sendIdentityFrame(action: string, payload: Record<string, unknown>, onReply: (event: ServerEvent) => void): string {
        const requestId = this.nextId('idreq');
        this.identityWaiters.set(requestId, onReply);
        this.transport?.send(JSON.stringify({ action, requestId, ...payload }));
        return requestId;
    }

    /** Read a field from either the flat event or its nested `data` / `data.data`. */
    private static readField(event: ServerEvent, key: string): unknown {
        const top = (event as unknown as Record<string, unknown>)[key];
        if (top !== undefined) return top;
        const data = (event as { data?: { data?: Record<string, unknown>; [k: string]: unknown } }).data;
        if (data) {
            if (data[key] !== undefined) return data[key];
            if (data.data && data.data[key] !== undefined) return data.data[key];
        }
        return undefined;
    }

    /**
     * Begin the cross-device restore: request an OTP to `email` over `channel`.
     * The view should already have collected the email via an explicit affordance.
     */
    requestIdentityOtp(email: string, channel: 'email' | 'sms' = 'email'): void {
        const trimmed = email.trim();
        if (!trimmed || !this.transport) return;
        this.setIdentityRestore({ phase: 'requesting', email: trimmed, channel });
        this.sendIdentityFrame('request_identity_otp', { sessionId: this.sessionId ?? null, email: trimmed, channel }, (event) => {
            if (event.type === 'otp_sent') {
                const masked = ConversationController.readField(event, 'maskedDestination');
                this.setIdentityRestore({ phase: 'awaiting_code', email: trimmed, channel, maskedDestination: typeof masked === 'string' ? masked : undefined });
            } else if (event.type === 'error') {
                const msg = ConversationController.readField(event, 'message');
                this.setIdentityRestore({ phase: 'error', message: typeof msg === 'string' ? msg : 'Could not send a verification code.' });
            }
        });
    }

    /** Submit the code for the cross-device restore. */
    verifyIdentityOtp(code: string): void {
        const state = this.identityRestore;
        const trimmed = code.trim();
        if (!trimmed || !this.transport) return;
        if (state.phase !== 'awaiting_code') return;
        const { email, channel } = state;
        this.setIdentityRestore({ phase: 'verifying', email, channel });
        this.sendIdentityFrame('verify_identity_otp', { sessionId: this.sessionId ?? null, email, code: trimmed }, (event) => {
            if (event.type === 'otp_verified') {
                this.store.getState().setVerifiedEmail(email);
                this.resolveIdentity(email);
            } else if (event.type === 'otp_invalid') {
                const remaining = ConversationController.readField(event, 'attemptsRemaining');
                this.setIdentityRestore({
                    phase: 'awaiting_code',
                    email,
                    channel,
                    error: 'That code was incorrect.',
                    attemptsRemaining: typeof remaining === 'number' ? remaining : undefined,
                });
            } else if (event.type === 'error') {
                const msg = ConversationController.readField(event, 'message');
                this.setIdentityRestore({ phase: 'error', message: typeof msg === 'string' ? msg : 'Verification failed.' });
            }
        });
    }

    /** Resolve the verified identity → list of restorable conversations. */
    private resolveIdentity(email: string): void {
        if (!this.transport) return;
        this.setIdentityRestore({ phase: 'resolving', email });
        this.sendIdentityFrame('resolve_identity', { sessionId: this.sessionId ?? null, email }, (event) => {
            const resolved = ConversationController.readField(event, 'resolved');
            if (resolved === false) {
                this.setIdentityRestore({ phase: 'resolved', email, conversations: [] });
                return;
            }
            const raw = ConversationController.readField(event, 'conversations');
            const conversations: RestorableConversation[] = Array.isArray(raw)
                ? raw
                      .map((c): RestorableConversation | null => {
                          if (!c || typeof c !== 'object') return null;
                          const o = c as Record<string, unknown>;
                          const conversationId = typeof o.conversationId === 'string' ? o.conversationId : '';
                          const sessionId = typeof o.sessionId === 'string' ? o.sessionId : '';
                          if (!sessionId) return null;
                          return {
                              conversationId,
                              sessionId,
                              lastActivityAt: typeof o.lastActivityAt === 'string' ? o.lastActivityAt : undefined,
                              preview: typeof o.preview === 'string' ? o.preview : undefined,
                          };
                      })
                      .filter((c): c is RestorableConversation => c !== null)
                : [];
            this.setIdentityRestore({ phase: 'resolved', email, conversations });
        });
    }

    /**
     * Replay a chosen restorable conversation: point the live session at its
     * sessionId, hydrate its transcript, and persist the new pointer so the next
     * `sendMessage` continues it.
     */
    async restoreConversation(sessionId: string): Promise<void> {
        if (!this.client) await this.ensureClient();
        const resumed = await this.tryResume(sessionId);
        if (resumed) {
            this.store.getState().setSessionId(sessionId);
            this.setIdentityRestore({ phase: 'idle' });
            this.setStatus('ready');
        } else {
            this.setIdentityRestore({ phase: 'error', message: 'That conversation is no longer available.' });
        }
    }

    /** Dismiss the cross-device restore panel. */
    cancelIdentityRestore(): void {
        this.setIdentityRestore({ phase: 'idle' });
    }

    /**
     * Route an unsolicited / custom-verb frame to its waiting handler. The engine
     * client surfaces every frame it can't correlate to a pending request or turn
     * here; we match by the echoed `requestId` of our identity frames.
     */
    private handleUnsolicited(event: ServerEvent): void {
        const requestId = (event as { requestId?: string }).requestId ?? (event as { data?: { requestId?: string } }).data?.requestId;
        if (typeof requestId === 'string' && this.identityWaiters.has(requestId)) {
            const handler = this.identityWaiters.get(requestId);
            // otp_invalid / otp_sent keep the flow alive (retry / interim ack);
            // other terminals end it, so drop the waiter.
            if (event.type !== 'otp_invalid' && event.type !== 'otp_sent') {
                this.identityWaiters.delete(requestId);
            }
            handler?.(event);
        }
    }

    /** Tear down the underlying client. */
    disconnect(): void {
        this.unsubscribeEvents?.();
        this.unsubscribeEvents = null;
        this.identityWaiters.clear();
        this.client?.disconnect('widget closed');
        this.client = null;
        this.transport = null;
        this.sessionId = null;
        this.activeRequestId = null;
        this.setInterrupt(null);
        this.setStatus('closed');
    }
}
