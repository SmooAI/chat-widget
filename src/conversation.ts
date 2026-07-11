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
 *   - returning-visitor RESUME via `POST /internal/resume-by-fingerprint`, and
 *     cross-device "restore my chats" via the `POST /internal/identity/{request-otp,
 *     verify-otp,resolve}` routes on the chat-ws wrapper. The engine (smooth-operator
 *     1.8.0) owns the `/ws` dispatch and REJECTS unknown verbs, so these are HTTP
 *     `fetch()` calls (origin-allowlisted + optional authContext, per ADR-046/048) —
 *     NOT WS frames.
 *
 * The controller is UI-agnostic: it emits typed events and the view renders them.
 */
import { type Citation, ProtocolError, type ServerEvent, SmoothAgentClient } from '@smooai/smooth-operator';
import type { StoreApi } from 'zustand/vanilla';
import type { ChatWidgetConfig } from './config.js';
import { getOrCreateFingerprint } from './fingerprint.js';
import { type ConsentState, createWidgetStore, type WidgetStore } from './persistence.js';

/**
 * Derive the HTTP base for the chat-ws wrapper's `/internal/*` REST routes from
 * the WS endpoint:  `wss://ai.smoo.ai/ws` → `https://ai.smoo.ai`. The engine
 * (smooth-operator 1.8.0) owns the `/ws` dispatch and REJECTS unknown verbs, so
 * the cross-device identity flow + fingerprint resume are HTTP POST routes on the
 * wrapper (origin-allowlisted + authContext, per ADR-046/ADR-048) — NOT WS frames.
 */
export function httpBaseFromWsEndpoint(endpoint: string): string | null {
    try {
        const u = new URL(endpoint);
        u.protocol = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
        // The REST routes live at the host root (`/internal/*`), not under `/ws`.
        return `${u.protocol}//${u.host}`;
    } catch {
        // FAIL LOUD on a non-absolute endpoint. A relative fallback (e.g.
        // `string.replace`) would yield a relative base, and `fetch(\`${base}/internal/...\`)`
        // would then POST identity/OTP data to the HOST page origin (e.g. smoo.ai)
        // instead of the operator host (ai.smoo.ai) — leaking it to the wrong origin.
        // Returning null forces the controller into an error state and refuses the
        // `/internal/*` calls rather than mis-targeting them.
        return null;
    }
}

export type { Citation };

export type Role = 'user' | 'assistant';

/**
 * One tool invocation within an assistant turn. Mirrors the smooth daemon SPA's
 * `ToolCall` (`crates/smooth-web/web/src/operator.ts`): opens `done: false` on the
 * tool call and resolves on the tool result.
 */
export interface ToolCall {
    /** Stable id for keyed rendering (assigned when the call opens). */
    id: string;
    name: string;
    /** Raw arguments, JSON-stringified. */
    args: string;
    /** Present once the tool resolves. */
    result?: string;
    isError?: boolean;
    done: boolean;
}

/**
 * One ordered segment of an assistant turn: a run of prose, or a tool call.
 * Preserves the interleave order the model produced (say a bit → call a tool →
 * say a bit → …) so the UI can render tool chips INLINE where the model called
 * them. Mirrors the daemon SPA's `MessageBlock`. Only populated when the widget
 * is configured with `showToolActivity: true`.
 */
export type MessageBlock = { kind: 'text'; text: string } | { kind: 'tool'; tool: ToolCall };

export interface ChatMessage {
    id: string;
    role: Role;
    /** Accumulated text (assistant messages grow as tokens stream in). */
    text: string;
    /** True while an assistant message is still streaming. */
    streaming: boolean;
    /**
     * Ordered text + tool segments, interleaved as the model produced them. Present
     * only on assistant messages when `showToolActivity` is enabled (absent
     * otherwise — the default popover renders `text` alone, byte-for-byte unchanged).
     */
    blocks?: MessageBlock[];
    /**
     * Sources that grounded an assistant answer, when the terminal
     * `eventual_response` carried any. Optional + back-compatible: absent when
     * the turn used no knowledge sources (or for user messages). Read
     * defensively off the terminal event — see {@link extractCitations}.
     */
    citations?: Citation[];
    /**
     * Suggested follow-up replies ("quick replies") the agent offered on the
     * terminal `eventual_response`. Set ONLY on the finalized assistant message —
     * never mid-stream. Read defensively (see {@link extractSuggestions}); capped
     * at 4 for layout. Absent when the turn offered none.
     */
    suggestions?: string[];
}

export type ConnectionStatus = 'idle' | 'connecting' | 'ready' | 'error' | 'closed';

/**
 * A mid-turn pause that needs the visitor to act before the agent can continue:
 *
 * - `otp` — the agent requested OTP verification before an authenticated action.
 *   Resume with {@link ConversationController.verifyOtp}.
 * - `confirm` — the agent wants to run a state-mutating tool and needs approval.
 *   Resume with {@link ConversationController.confirmTool}.
 * - `interaction` — the agent raised a Rich Interaction (structured card, e.g.
 *   identity intake). Resume with {@link ConversationController.submitInteraction}
 *   or {@link ConversationController.declineInteraction}.
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
    | { kind: 'confirm'; toolId?: string; actionDescription?: string }
    | {
          kind: 'interaction';
          /** Server-generated interaction instance id (echoed on submit). */
          interactionId: string;
          /** The Rich Interaction kind (e.g. `identity_intake`) — selects the card. */
          interactionKind: string;
          /** Kind-specific render spec (identity_intake: `{ fields: [...] }`). */
          spec: Record<string, unknown>;
          /** Why the agent raised it (card header copy). */
          reason?: string;
          /** Per-field server-side validation errors (from `interaction_invalid`). */
          errors?: { field: string; message: string }[];
      };

/**
 * The Rich-Interaction render capabilities this widget declares at session
 * create (`supports`). Must stay aligned with the card registry in
 * `element.ts` (`INTERACTION_CARDS`) — registering a card IS declaring its
 * capability; a test asserts the two match.
 */
export const SUPPORTED_INTERACTION_CAPABILITIES: readonly string[] = ['identity_form'];

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
 * State machine for the cross-device "restore my chats" flow. Driven by the three
 * HTTP POST routes on the chat-ws wrapper — `/internal/identity/request-otp` →
 * `/internal/identity/verify-otp` → `/internal/identity/resolve` (ADR-048 §c).
 * The view renders a panel off this.
 */
export type IdentityRestore =
    | { phase: 'idle' }
    /** UI-local: the email-entry step before any request is sent. */
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

/**
 * Pull the suggested follow-up replies out of a terminal `eventual_response`'s
 * `response` object (`response.suggestedNextActions`). Optional + back-compatible
 * like citations — read defensively (tolerating absence, non-array shapes, and
 * non-string / blank entries) and capped at 4 so a chatty agent can't overflow
 * the composer chip row.
 */
function extractSuggestions(response: unknown): string[] {
    if (!response || typeof response !== 'object') return [];
    const raw = (response as { suggestedNextActions?: unknown }).suggestedNextActions;
    if (!Array.isArray(raw)) return [];
    return raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 4);
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

let toolSeq = 0;
const nextToolId = (): string => `tool-${++toolSeq}`;

/** Grow the trailing text block, or open a new one if the last block was a tool. */
function growTextBlock(blocks: MessageBlock[], text: string): void {
    if (!text) return;
    const last = blocks[blocks.length - 1];
    if (last && last.kind === 'text') last.text += text;
    else blocks.push({ kind: 'text', text });
}

/**
 * Fold a `stream_chunk` node-state into the ordered block list, returning `true`
 * when the chunk carried tool activity.
 *
 * Tool activity rides `state.rawResponse.toolCall` / `state.rawResponse.toolResult`
 * — **NOT** `state.toolResult`. Reading the wrong path leaves every chip stuck on
 * "running…" forever (the exact bug the daemon SPA hit and this mirror avoids).
 */
function applyToolChunk(blocks: MessageBlock[], state: unknown): boolean {
    const raw = (state as { rawResponse?: unknown } | null | undefined)?.rawResponse;
    if (!raw || typeof raw !== 'object') return false;
    const call = (raw as { toolCall?: { name?: string; arguments?: unknown } }).toolCall;
    const res = (raw as { toolResult?: { name?: string; isError?: boolean; result?: unknown } }).toolResult;
    if (call) {
        const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
        blocks.push({ kind: 'tool', tool: { id: nextToolId(), name: call.name ?? '', args, done: false } });
        return true;
    }
    if (res) {
        const result = typeof res.result === 'string' ? res.result : JSON.stringify(res.result ?? '');
        // Complete the most-recent still-open tool block matching this name.
        for (let i = blocks.length - 1; i >= 0; i--) {
            const b = blocks[i];
            if (b && b.kind === 'tool' && b.tool.name === (res.name ?? '') && !b.tool.done) {
                b.tool.done = true;
                b.tool.isError = !!res.isError;
                b.tool.result = result;
                break;
            }
        }
        return true;
    }
    return false;
}

export class ConversationController {
    private readonly config: ChatWidgetConfig;
    private readonly events: ConversationEvents;
    private readonly store: StoreApi<WidgetStore>;
    private client: SmoothAgentClient | null = null;
    private sessionId: string | null = null;
    /** Conversation id of the live session (create or resume) — lets voice join the same thread. */
    private conversationId: string | null = null;
    private readonly messages: ChatMessage[] = [];
    private status: ConnectionStatus = 'idle';
    private seq = 0;
    /** requestId of the in-flight turn — used to resume OTP / tool confirmations. */
    private activeRequestId: string | null = null;
    private interrupt: Interrupt | null = null;
    /** Values from the last interaction submit, merged into the persisted
     *  identity (identity_intake only) once the server acks them. */
    private pendingInteractionValues: { kind: string; values: Record<string, unknown> } | null = null;
    private identityRestore: IdentityRestore = { phase: 'idle' };
    /**
     * True once the resume probe (persisted-pointer get_session OR the
     * `/internal/resume-by-fingerprint` POST) has run for this controller. Makes
     * `connect()` idempotent: re-entering after a transient `error` status (e.g. a
     * retried `send()`) creates a fresh session rather than re-running the resume
     * probe — which would fire another `resumeByFingerprint` POST and could adopt a
     * session we already decided not to resume.
     */
    private resumeAttempted = false;
    /**
     * HTTP base for the chat-ws wrapper's `/internal/*` REST routes. `null` when
     * the configured WS endpoint could not be parsed into an absolute origin — in
     * that case the `/internal/*` routes are refused (rather than mis-targeted at
     * the host page origin). See {@link httpBaseFromWsEndpoint}.
     */
    private readonly httpBase: string | null;

    constructor(config: ChatWidgetConfig, events: ConversationEvents, store?: StoreApi<WidgetStore>) {
        this.config = config;
        this.events = events;
        this.httpBase = httpBaseFromWsEndpoint(config.endpoint);
        if (this.httpBase === null) {
            // A non-absolute endpoint means the identity / resume `/internal/*` routes
            // have no safe target. Flag the controller in error so the UI surfaces it
            // and the routes refuse (see postInternal) rather than mis-targeting the
            // host page origin. Deferred to a microtask so listeners attached after
            // construction still observe the transition.
            queueMicrotask(() => this.setStatus('error', `Invalid chat endpoint: ${config.endpoint}`));
        }
        this.store = store ?? createWidgetStore(config.agentId);
        // Seed identity from config into the persisted store. `mergeIdentity` is
        // applied on EVERY construct, so a config-provided field always wins over
        // the persisted value (config is authoritative when present). Fields the
        // config does NOT provide keep their persisted value — those survive across
        // reloads; explicitly-configured ones are re-applied each load.
        const seed: { name?: string; email?: string; phone?: string } = {};
        if (config.userName) seed.name = config.userName;
        if (config.userEmail) seed.email = config.userEmail;
        if (config.userPhone) seed.phone = config.userPhone;
        if (Object.keys(seed).length > 0) this.store.getState().mergeIdentity(seed);
    }

    get connectionStatus(): ConnectionStatus {
        return this.status;
    }

    /** Conversation id of the live session, or null before connect (voice passes this as `conversation_id`). */
    get currentConversationId(): string | null {
        return this.conversationId;
    }

    /**
     * Append an already-finalized message to the transcript and emit — the voice
     * path reuses this so `transcript_final` (user) and `reply_text` (assistant)
     * turns land in the same message list / render pipeline as typed chat.
     */
    appendLocalMessage(role: Role, text: string): void {
        const trimmed = text.trim();
        if (!trimmed) return;
        this.messages.push({ id: this.nextId(role === 'user' ? 'u' : 'a'), role, text: trimmed, streaming: false });
        this.emitMessages();
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

    /**
     * Submit a Rich Interaction card to resume the parked turn. The server
     * routes to the kind's validator: invalid values come back as an
     * `interaction_invalid` event (the card re-renders with per-field errors —
     * the turn stays parked); a valid submit is acked and the turn resumes.
     * No-op if not awaiting an interaction.
     */
    submitInteraction(values: Record<string, unknown>): void {
        if (!this.client || !this.sessionId || !this.activeRequestId || this.interrupt?.kind !== 'interaction') return;
        // Stash the values so the ack (immediate_response) can merge accepted
        // identity values into the persisted store.
        this.pendingInteractionValues = { kind: this.interrupt.interactionKind, values };
        this.client.submitInteraction({
            sessionId: this.sessionId,
            requestId: this.activeRequestId,
            interactionId: this.interrupt.interactionId,
            kind: this.interrupt.interactionKind,
            values,
        });
    }

    /** Decline the pending Rich Interaction; the agent continues without it. */
    declineInteraction(): void {
        if (!this.client || !this.sessionId || !this.activeRequestId || this.interrupt?.kind !== 'interaction') return;
        this.client.submitInteraction({
            sessionId: this.sessionId,
            requestId: this.activeRequestId,
            interactionId: this.interrupt.interactionId,
            kind: this.interrupt.interactionKind,
            declined: true,
        });
        this.pendingInteractionValues = null;
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
     * phone (no first-class engine field) and consent.
     *
     * NOTE: `verifiedEmail` is deliberately NOT stamped here. It is a per-session
     * OTP proof bound to the session it was verified against
     * (`verifiedEmailSessionId`), and the server only treats an actual OTP `verify`
     * as proof — metadata `verifiedEmail` is just a hint. Auto-stamping it onto
     * every brand-new `create_conversation_session` would mislabel a fresh
     * visitor's session with a prior (possibly different) visitor's email on a
     * shared browser. The verified email is only used when RESUMING the exact
     * session it was proven for — see {@link verifiedEmailForSession}.
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
        return Object.keys(meta).length > 0 ? meta : undefined;
    }

    /**
     * The verified-email hint, but ONLY when the OTP proof is bound to the session
     * being resumed (`verifiedEmailSessionId === sessionId`). Returns null
     * otherwise so a stale/cross-visitor proof is never threaded onto a session it
     * wasn't proven for.
     */
    private verifiedEmailForSession(sessionId: string): string | null {
        const state = this.store.getState();
        if (state.verifiedEmail && state.verifiedEmailSessionId === sessionId) {
            return state.verifiedEmail;
        }
        return null;
    }

    /** Lazily open the WS client (default transport). Idempotent within a connect. */
    private async ensureClient(): Promise<void> {
        if (this.client) return;
        this.client = new SmoothAgentClient({ url: this.config.endpoint });
        await this.client.connect();
    }

    /**
     * Open the connection and either RESUME or create a session.
     *
     * 1. Persisted pointer (ADR-048 §b): `get_session` → if not `ended`, reuse +
     *    hydrate from `get_messages` (newest-first, reversed). On ended/404 clear
     *    ONLY the pointer (identity/consent survive).
     * 2. No persisted pointer: POST `/internal/resume-by-fingerprint` FIRST; if
     *    `resumable`, adopt the returned session (the wrapper has primed the
     *    operator registry), reuse the sessionId, and hydrate via get_session/
     *    get_messages — rather than relying on createConversationSession to resume.
     * 3. Otherwise create a fresh session.
     */
    async connect(): Promise<void> {
        if (this.status === 'connecting' || this.status === 'ready') return;
        this.setStatus('connecting');
        try {
            await this.ensureClient();
            // The resume probe (persisted-pointer get_session OR the fingerprint
            // resume POST) runs AT MOST ONCE per controller lifecycle. Re-entering
            // connect() after a transient error (e.g. a retried send()) must not
            // re-run the probe — that would re-fire resumeByFingerprint and could
            // adopt a session we already chose not to resume. After the first
            // attempt, fall straight through to creating a fresh session.
            if (!this.resumeAttempted) {
                this.resumeAttempted = true;
                const persistedSessionId = this.store.getState().sessionId;
                if (persistedSessionId) {
                    const resumed = await this.tryResume(persistedSessionId);
                    if (resumed) {
                        this.setStatus('ready');
                        return;
                    }
                    // Resume failed (ended/404/gone) — clear the pointer, keep identity.
                    this.store.getState().clearSession();
                } else {
                    // Returning anonymous visitor with no stored pointer: ask the
                    // wrapper to resolve a recent session for this fingerprint.
                    const fpSessionId = await this.resumeByFingerprint();
                    if (fpSessionId) {
                        const resumed = await this.tryResume(fpSessionId);
                        if (resumed) {
                            this.store.getState().setSessionId(fpSessionId);
                            this.setStatus('ready');
                            return;
                        }
                    }
                }
            }
            await this.createSession();
            this.setStatus('ready');
        } catch (err) {
            this.setStatus('error', err instanceof Error ? err.message : String(err));
            throw err;
        }
    }

    // ─────────────────────── chat-ws `/internal/*` HTTP ─────────────────────────

    /**
     * Build the auth fields every `/internal/*` route shares: `agentId` (required
     * for the agent-policy lookup), `agentName` (used as the OTP email sender), and
     * the optional pre-auth `authContext` the host page may have configured. The
     * `Origin` header is sent automatically by the browser and checked server-side.
     */
    private authBody(): Record<string, unknown> {
        const body: Record<string, unknown> = { agentId: this.config.agentId };
        if (this.config.agentName) body.agentName = this.config.agentName;
        if (this.config.authContext) body.authContext = this.config.authContext;
        return body;
    }

    /** POST JSON to a `/internal/*` route; returns the parsed body (or throws). */
    private async postInternal(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (this.httpBase === null) {
            // No absolute origin could be derived from the WS endpoint — refuse the
            // call loudly rather than POST identity data to a relative (host-page) URL.
            throw new Error(`Cannot reach ${path}: the chat endpoint is not an absolute URL.`);
        }
        const res = await fetch(`${this.httpBase}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // Auth is the `Origin` allowlist + the `authContext` body field — NOT
            // cookies. `credentials: 'include'` would force the server to reply with
            // `Access-Control-Allow-Credentials: true` AND a reflected origin (a
            // wildcard `*` is illegal with credentials), so a plain origin-allowlisted
            // CORS config would fail the preflight and break EVERY `/internal/*` call.
            // Omit credentials so the cross-origin POST works against an allowlist
            // that doesn't (and shouldn't need to) opt into credentialed CORS.
            credentials: 'omit',
            body: JSON.stringify({ ...this.authBody(), ...payload }),
        });
        let json: Record<string, unknown> = {};
        try {
            json = (await res.json()) as Record<string, unknown>;
        } catch {
            json = {};
        }
        if (!res.ok) {
            const err = json.error as { code?: string; message?: string } | undefined;
            throw new Error(err?.message ?? `${path} failed (${res.status})`);
        }
        return json;
    }

    /**
     * POST `/internal/resume-by-fingerprint`. Returns the resumable sessionId when
     * the wrapper found (and primed) a recent session for this fingerprint, else
     * null. Network/route failures are swallowed → null (fall through to create).
     */
    private async resumeByFingerprint(): Promise<string | null> {
        try {
            const json = await this.postInternal('/internal/resume-by-fingerprint', { browserFingerprint: this.fingerprint() });
            if (json.resumable === true && typeof json.sessionId === 'string') {
                return json.sessionId;
            }
        } catch {
            // Resume is best-effort; any failure just means a fresh session.
        }
        return null;
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
            // Declare the Rich-Interaction cards this widget can render (derived
            // from the card registry), so the server emits `interaction_required`
            // for those kinds instead of the conversational fallback.
            supports: [...SUPPORTED_INTERACTION_CAPABILITIES],
            ...(metadata ? { metadata } : {}),
        });
        this.sessionId = session.sessionId;
        this.conversationId = session.conversationId ?? null;
        this.store.getState().setSessionId(session.sessionId);
    }

    /**
     * Attempt to resume `sessionId`: returns true and hydrates the transcript when
     * the session is live, false when it has ended / can't be fetched.
     */
    private async tryResume(sessionId: string): Promise<boolean> {
        if (!this.client) return false;
        let snap: { status?: 'active' | 'idle' | 'ended'; conversationId?: string };
        try {
            snap = await this.client.getSession({ sessionId });
        } catch {
            return false; // 404 / SESSION_NOT_FOUND / network — start fresh.
        }
        if (snap.status === 'ended') return false;

        this.sessionId = sessionId;
        this.conversationId = snap.conversationId ?? null;
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
        const showTools = this.config.showToolActivity === true;
        const assistant: ChatMessage = { id: this.nextId('a'), role: 'assistant', text: '', streaming: true, blocks: showTools ? [] : undefined };
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
                        // Grow the trailing text block so prose interleaves with any
                        // tool chips in the order the model produced them.
                        if (showTools && assistant.blocks) growTextBlock(assistant.blocks, token);
                        this.emitMessages();
                    }
                } else if (showTools && event.type === 'stream_chunk') {
                    // Tool activity (gated). Read state.rawResponse.toolCall/.toolResult.
                    if (assistant.blocks && applyToolChunk(assistant.blocks, event.data?.state)) {
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
            // Suggested follow-up replies from the terminal event, when present.
            const suggestions = extractSuggestions(inner?.response);
            if (suggestions.length > 0) {
                assistant.suggestions = suggestions;
            }
            // Only keep blocks for turns that actually invoked a tool — a prose-only
            // turn drops back to the normal markdown text path (with the final text).
            if (assistant.blocks && !assistant.blocks.some((b) => b.kind === 'tool')) {
                assistant.blocks = undefined;
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
            case 'interaction_required': {
                const interactionId = str(inner.interactionId);
                const kind = str(inner.kind);
                const spec = inner.spec && typeof inner.spec === 'object' ? (inner.spec as Record<string, unknown>) : {};
                if (!interactionId || !kind) break; // not renderable — ignore
                this.pendingInteractionValues = null;
                this.setInterrupt({
                    kind: 'interaction',
                    interactionId,
                    interactionKind: kind,
                    spec,
                    reason: str(inner.reason),
                });
                break;
            }
            case 'interaction_invalid':
                if (this.interrupt?.kind === 'interaction' && this.interrupt.interactionId === str(inner.interactionId)) {
                    const errors: { field: string; message: string }[] = [];
                    if (Array.isArray(inner.errors)) {
                        for (const e of inner.errors) {
                            if (!e || typeof e !== 'object') continue;
                            const o = e as Record<string, unknown>;
                            const field = str(o.field);
                            if (field) errors.push({ field, message: str(o.message) ?? 'Invalid value' });
                        }
                    }
                    this.pendingInteractionValues = null;
                    this.setInterrupt({ ...this.interrupt, errors });
                }
                break;
            case 'immediate_response':
                // Mid-turn immediate_response while an interaction card is showing
                // is the submit/decline ack: the park resolved — clear the card
                // and, for accepted identity values, persist them.
                if (this.interrupt?.kind === 'interaction') {
                    const pending = this.pendingInteractionValues;
                    if (pending && pending.kind === 'identity_intake') {
                        const v = pending.values as { name?: string; email?: string; phone?: string };
                        this.store.getState().mergeIdentity({ name: v.name, email: v.email, phone: v.phone });
                    }
                    this.pendingInteractionValues = null;
                    this.setInterrupt(null);
                }
                break;
                        default:
                break;
        }
    }

    // ─────────────────── Cross-device "restore my chats" (§c) ───────────────────
    //
    // Three HTTP POST routes on the chat-ws wrapper (the engine `/ws` dispatch
    // rejects unknown verbs): request-otp → verify-otp → resolve. ALL THREE are
    // session-scoped — they require a live `sessionId` (a uuid). request-otp
    // establishes the session itself (idempotent connect) before sending, so the
    // whole flow shares one session and verify-otp can't hit "No active session"
    // even if the email was submitted before the initial connect() resolved.

    /**
     * Begin the cross-device restore: POST `/internal/identity/request-otp` for
     * `email` over `channel`. The view collects the email via an explicit affordance.
     */
    async requestIdentityOtp(email: string, channel: 'email' | 'sms' = 'email'): Promise<void> {
        const trimmed = email.trim();
        if (!trimmed) return;
        this.setIdentityRestore({ phase: 'requesting', email: trimmed, channel });
        // request-otp must be SESSION-CONSISTENT with verify-otp (which hard-requires
        // a sessionId). If the restore affordance fired request-otp before connect()
        // resolved, there'd be no sessionId here and verify-otp would later error
        // "No active session." Establish a session first (idempotent connect), then
        // require it — so the whole request → verify flow shares one live session.
        if (!this.sessionId) {
            try {
                await this.connect();
            } catch {
                /* fall through: handled by the sessionId check below */
            }
        }
        if (!this.sessionId) {
            this.setIdentityRestore({ phase: 'error', message: 'No active session to verify against.' });
            return;
        }
        try {
            const json = await this.postInternal('/internal/identity/request-otp', {
                sessionId: this.sessionId,
                email: trimmed,
                channel,
            });
            const masked = typeof json.maskedDestination === 'string' ? json.maskedDestination : undefined;
            this.setIdentityRestore({ phase: 'awaiting_code', email: trimmed, channel, maskedDestination: masked });
        } catch (err) {
            this.setIdentityRestore({ phase: 'error', message: err instanceof Error ? err.message : 'Could not send a verification code.' });
        }
    }

    /** Submit the code: POST `/internal/identity/verify-otp`, then resolve on success. */
    async verifyIdentityOtp(code: string): Promise<void> {
        const state = this.identityRestore;
        const trimmed = code.trim();
        if (!trimmed || state.phase !== 'awaiting_code') return;
        const { email, channel } = state;
        if (!this.sessionId) {
            this.setIdentityRestore({ phase: 'error', message: 'No active session to verify against.' });
            return;
        }
        this.setIdentityRestore({ phase: 'verifying', email, channel });
        try {
            const json = await this.postInternal('/internal/identity/verify-otp', { sessionId: this.sessionId, email, code: trimmed });
            if (json.event === 'otp_verified') {
                // Bind the OTP proof to the session it was verified against, so it
                // can't leak onto a different visitor's session on a shared browser.
                this.store.getState().setVerifiedEmail(email, this.sessionId);
                await this.resolveIdentity(email);
            } else if (json.event === 'otp_invalid') {
                const remaining = typeof json.attemptsRemaining === 'number' ? json.attemptsRemaining : undefined;
                this.setIdentityRestore({ phase: 'awaiting_code', email, channel, error: 'That code was incorrect.', attemptsRemaining: remaining });
            } else {
                this.setIdentityRestore({ phase: 'error', message: 'Verification failed.' });
            }
        } catch (err) {
            this.setIdentityRestore({ phase: 'error', message: err instanceof Error ? err.message : 'Verification failed.' });
        }
    }

    /** Resolve the verified identity → restorable conversations via POST `/internal/identity/resolve`. */
    private async resolveIdentity(email: string): Promise<void> {
        if (!this.sessionId) return;
        this.setIdentityRestore({ phase: 'resolving', email });
        try {
            const json = await this.postInternal('/internal/identity/resolve', { sessionId: this.sessionId, email });
            if (json.resolved !== true) {
                this.setIdentityRestore({ phase: 'resolved', email, conversations: [] });
                return;
            }
            const raw = json.conversations;
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
        } catch (err) {
            this.setIdentityRestore({ phase: 'error', message: err instanceof Error ? err.message : 'Could not load your chats.' });
        }
    }

    /**
     * Replay a chosen restorable conversation: point the live session at its
     * sessionId, hydrate its transcript (get_session + get_messages), and persist
     * the new pointer so the next `sendMessage` continues it.
     */
    async restoreConversation(sessionId: string): Promise<void> {
        if (!this.client) await this.ensureClient();
        // Capture the OTP proof bound to the CURRENT live session BEFORE tryResume
        // repoints this.sessionId to the restored one. The visitor proved ownership
        // of this email in this very flow, so the proof legitimately follows the
        // conversation they chose to restore.
        const proven = this.sessionId ? this.verifiedEmailForSession(this.sessionId) : null;
        const resumed = await this.tryResume(sessionId);
        if (resumed) {
            this.store.getState().setSessionId(sessionId);
            // Rebind the proof to the restored session (keeps verifiedEmail
            // session-scoped, just now to the session it's actually used on). Only a
            // proof from the just-verified session follows — never an unrelated stale one.
            if (proven) this.store.getState().setVerifiedEmail(proven, sessionId);
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

    /** Tear down the underlying client. */
    disconnect(): void {
        this.client?.disconnect('widget closed');
        this.client = null;
        this.sessionId = null;
        this.conversationId = null;
        this.activeRequestId = null;
        // A full teardown ends the controller lifecycle: a subsequent connect() is a
        // genuine re-open and may resume again, so re-arm the resume probe.
        this.resumeAttempted = false;
        this.setInterrupt(null);
        this.setStatus('closed');
    }
}
