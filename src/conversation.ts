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
import { type ConsentState, createWidgetStore, isStorageDurable, type WidgetStore } from './persistence.js';

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
     * Ephemeral "what I'm about to do" sentence from the fast-model preamble
     * (`stream_preamble`), shown in the typing slot while `text` is still empty
     * to cover the main model's time-to-first-token. Cleared the moment the real
     * answer starts streaming (first `stream_token`). Absent unless the server
     * emits a preamble (`SMOOTH_AGENT_PREAMBLE_MODEL`).
     */
    preamble?: string;
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

/**
 * Outcome of the `/internal/resume-by-fingerprint` probe.
 *
 * `reason` is ALWAYS populated: the server's own string when the response carries
 * one, a locally-derived label when it does not. It exists so a `sessionId: null`
 * is legible — see {@link ConversationController.lastResumeReason}.
 */
export interface ResumeProbeResult {
    /** The session the wrapper says is resumable, or null when there is none. */
    sessionId: string | null;
    /** Why. Low-cardinality, log-safe, never parsed — displayed/logged verbatim. */
    reason: string;
}

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

/**
 * Paragraph separator the server uses to join `responseParts`. The streaming
 * render (raw-token accumulation) and the finalized render (this join) MUST use
 * the same separation, or a transient extra blank line flickers mid-stream and
 * then vanishes when the terminal `eventual_response` re-renders (SMOODEV-2534).
 */
const PARAGRAPH_SEP = '\n\n';

/**
 * Collapse any run of 3+ newlines down to a single paragraph break. Idempotent,
 * and a no-op on text already separated by exactly `\n\n` — so applying it to the
 * finalized `responseParts.join(PARAGRAPH_SEP)` leaves well-formed responses
 * byte-identical, while the streaming accumulator (which sees whatever raw
 * newlines the model emits token-by-token) is held to the same paragraph shape
 * the finalized render will use. That keeps mid-stream from showing an extra
 * blank line the finalized message doesn't.
 */
export function normalizeParagraphs(text: string): string {
    return text.replace(/\n{3,}/g, PARAGRAPH_SEP);
}

/** Pull the final assistant text out of an `eventual_response` data payload. */
function extractFinalText(response: unknown): string | null {
    if (!response || typeof response !== 'object') return null;
    const r = response as { responseParts?: unknown };
    if (Array.isArray(r.responseParts)) {
        return normalizeParagraphs(r.responseParts.filter((p): p is string => typeof p === 'string').join(PARAGRAPH_SEP));
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

/**
 * The one protocol error code that means "the session id we hold is dead" — the
 * server has no such session (expired, evicted, or it isn't ours). The pointer is
 * stale, so the correct recovery is to drop it and create a fresh session.
 *
 * Deliberately a SINGLE code, matched on `code` and never on the message text:
 *
 * - The operator emits a distinct code for every other failure mode
 *   (`STORAGE_ERROR`, `INTERNAL_ERROR`, `AUTH_CONTEXT_INVALID`,
 *   `ORIGIN_NOT_ALLOWED`, `LLM_UNAVAILABLE`, `AGENT_ERROR`, `VALIDATION_ERROR`, …).
 *   A storage blip or an auth failure must NOT spin up a new session — that would
 *   abandon a live conversation the visitor can still return to. Only a session
 *   the server says does not exist gets replaced.
 * - The message string is internal (it interpolates the session UUID), so
 *   pattern-matching it would break the moment the server rewords it — and a
 *   backend fix is in flight to stop reporting storage FAILURES as not-found,
 *   which changes the string but not this code.
 */
const DEAD_SESSION_CODE = 'SESSION_NOT_FOUND';

/**
 * True when `err` says the session id we're holding no longer exists server-side.
 * Anything else — including every transient/auth/storage failure — is false, so
 * the caller leaves the existing session (and its history) intact.
 */
export function isDeadSessionError(err: unknown): boolean {
    return err instanceof ProtocolError && err.code === DEAD_SESSION_CODE;
}

let toolSeq = 0;
const nextToolId = (): string => `tool-${++toolSeq}`;

/** Grow the trailing text block, or open a new one if the last block was a tool. */
function growTextBlock(blocks: MessageBlock[], text: string): void {
    if (!text) return;
    const last = blocks[blocks.length - 1];
    // Same paragraph normalization as the plain-text stream path (SMOODEV-2534).
    if (last && last.kind === 'text') last.text = normalizeParagraphs(last.text + text);
    else blocks.push({ kind: 'text', text: normalizeParagraphs(text) });
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
    /** Reason from the last fingerprint probe; null until one has run. */
    private resumeReason: string | null = null;
    /** How this connect reached `createSession()`. Rides the session metadata. */
    private pointerState: 'none' | 'dead' | 'recovery' = 'none';
    /** The in-flight connect, so concurrent callers await the SAME one. See {@link connect}. */
    private connecting: Promise<void> | null = null;
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

    /**
     * Why the last fingerprint resume probe did or did not adopt a session, or
     * null before one has run. Diagnostic surface for "this visitor got a second
     * conversation, why?" — the same string that went to `console.debug`.
     */
    get lastResumeReason(): string | null {
        return this.resumeReason;
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
        // Why this create happened, in three low-cardinality strings. `metadata_json`
        // is persisted on the session row, so the NEXT duplicate pair can be
        // explained from Postgres — where the audit already looks — instead of from
        // a browser console nobody was watching (SMOODEV-3057).
        //
        // `storage: 'memory'` is the one that answers "was this one page load or
        // two": a memory-only store cannot recognise its own previous visit, so
        // EVERY page load starts from scratch and mints. Sandboxed iframes and
        // privacy mode land here silently.
        meta.resumeDiagnostics = {
            storage: isStorageDurable() ? 'durable' : 'memory',
            pointer: this.pointerState,
            probe: this.resumeReason ?? 'not_probed',
        };
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
     * 2. No LIVE pointer (none stored, or the stored one just turned out to be
     *    dead): POST `/internal/resume-by-fingerprint`; if `resumable`, adopt the
     *    returned session (the wrapper has primed the operator registry), reuse
     *    the sessionId, and hydrate via get_session/get_messages — rather than
     *    relying on createConversationSession to resume.
     * 3. Otherwise create a fresh session.
     */
    async connect(): Promise<void> {
        // Concurrent callers share ONE connect, and every caller's `await`
        // resolves when THAT connect finishes.
        //
        // This used to `return` bare while a connect was in flight. The guard was
        // right — one connect, not two — but returning an already-resolved promise
        // made `await connect()` a lie: it resolved BEFORE any session existed, so
        // `send()` fell straight through to its `!this.sessionId` throw. Four of
        // the six call sites are fire-and-forget `void connect()` (launcher click,
        // pre-chat submit, full-page mount, voice hand-off), so an awaiting caller
        // racing an in-flight one is the NORMAL case, not an edge: on smoo.ai the
        // pre-chat submit fires one and the visitor's first send awaits another
        // milliseconds later.
        if (this.connecting) return this.connecting;
        // Already connected — but only if a session actually came out of it. A
        // 'ready' status with no sessionId is a wedge: `send()` calls connect()
        // precisely because the id is missing, so early-returning on status alone
        // would send it back to the same throw on EVERY turn, forever.
        // ponytail: the `&& this.sessionId` half is belt-and-braces and has NO
        // failing test — `createSession()` now refuses to reach 'ready' without an
        // id, so nothing can currently construct that state. Kept because it is one
        // condition and it is the difference between "retry" and "wedged forever"
        // if another path ever sets 'ready' on its own. Delete it with that guard.
        if (this.status === 'ready' && this.sessionId) return;
        this.connecting = this.openSession().finally(() => {
            this.connecting = null;
        });
        return this.connecting;
    }

    /** The actual connect body. Serialized by {@link connect}; never call directly. */
    private async openSession(): Promise<void> {
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
                    this.pointerState = 'dead';
                    this.store.getState().clearSession();
                }
                // A DEAD pointer falls through to the fingerprint probe too. This
                // used to sit in an `else`, so a visitor whose stored session had
                // died went straight to createSession() and minted a brand-new
                // conversation even when a resumable one existed — one visitor,
                // several inbox rows (SMOODEV-3057). The wrapper is authoritative
                // about what is resumable; a stale local pointer is not.
                const { sessionId: fpSessionId } = await this.resumeByFingerprint();
                // Re-probing the id we just failed on is fine and sometimes the
                // point: the wrapper primes the operator registry, so a resume that
                // failed on a registry miss can succeed on this second attempt. An
                // `ended` session is excluded server-side, so it can't come back.
                if (fpSessionId && (await this.tryResume(fpSessionId))) {
                    this.store.getState().setSessionId(fpSessionId);
                    this.setStatus('ready');
                    return;
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
     * null — plus, always, the REASON.
     *
     * Failures stay swallowed: a resume probe must never break `connect()`. What
     * is fixed here is only their invisibility. "No prior visit", "blocked by the
     * CRM link", "session ended" and "the lookup 500'd" all used to arrive as a
     * bare `null` out of a bare `catch {}`, which is why SMOODEV-3057 went
     * undiagnosed for weeks.
     */
    private async resumeByFingerprint(): Promise<ResumeProbeResult> {
        try {
            const json = await this.postInternal('/internal/resume-by-fingerprint', { browserFingerprint: this.fingerprint() });
            // Tolerate BOTH response shapes. The server-side half of this fix makes
            // `{resumable:false}` carry a `reason`; wrappers without it (every one
            // deployed today) send none, so derive a local fallback rather than
            // waiting on the two halves to land together.
            const served = typeof json.reason === 'string' ? json.reason : null;
            if (json.resumable === true) {
                return typeof json.sessionId === 'string'
                    ? this.noteResumeProbe(json.sessionId, served ?? 'resumable')
                    : this.noteResumeProbe(null, served ?? 'resumable_without_session_id');
            }
            return this.noteResumeProbe(null, served ?? 'not_resumable_no_reason');
        } catch (err) {
            return this.noteResumeProbe(null, `probe_failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /** Record + log a probe outcome, and hand it back. */
    private noteResumeProbe(sessionId: string | null, reason: string): ResumeProbeResult {
        this.resumeReason = reason;
        // `debug`, not `warn`: a non-resumable probe is the ordinary first-visit
        // path, not a fault. Console verbose shows it; nobody else's console is
        // touched. This is the line that would have named the cause on day one.
        console.debug(`[chat-widget] resume-by-fingerprint: ${sessionId ? `resumed ${sessionId}` : 'not resumed'} (${reason})`);
        return { sessionId, reason };
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
        // Refuse a create that produced no session id. `request()` resolves on the
        // FIRST frame carrying the requestId, so a wrapper that ACKs before the
        // session exists resolves this call with an empty payload — and assigning
        // `undefined` here then flipping the status to 'ready' wedges the widget
        // permanently: every later `send()` hits `!this.sessionId`, calls
        // `connect()`, is early-returned by the 'ready' status, and throws again.
        // Failing here keeps that honest and retryable instead of silent.
        if (!session?.sessionId) {
            throw new Error('create_conversation_session returned no sessionId');
        }
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
        // `| undefined` is load-bearing, not defensive noise. The client's
        // `extractImmediateData` hands back `event.data` for ANY
        // `immediate_response` without checking its status, so an error-status
        // reply that carries no `data` (auth rejection, 5xx) RESOLVES as
        // `undefined` instead of rejecting. Typing this non-optional is what let
        // `snap.status` throw a TypeError OUTSIDE the catch below — which
        // propagated out of `connect()` and took the whole chat down for a
        // returning visitor, over a resume that was only ever an enhancement.
        let snap: { status?: 'active' | 'idle' | 'ended'; conversationId?: string } | undefined;
        try {
            snap = await this.client.getSession({ sessionId });
        } catch {
            return false; // 404 / SESSION_NOT_FOUND / network — start fresh.
        }
        // No snapshot, or an ended one → not resumable. Start fresh.
        if (!snap || snap.status === 'ended') return false;

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

        // 1. User bubble.
        this.messages.push({ id: this.nextId('u'), role: 'user', text: trimmed, streaming: false });

        // 2. Placeholder assistant bubble we grow as tokens arrive.
        const showTools = this.config.showToolActivity === true;
        const assistant: ChatMessage = { id: this.nextId('a'), role: 'assistant', text: '', streaming: true, blocks: showTools ? [] : undefined };
        this.messages.push(assistant);
        this.emitMessages();

        // Connecting happens INSIDE the try, after the bubbles are on screen, so a
        // genuinely fatal connect (no transport at all) renders the one human
        // sentence like any other failed turn. Previously it rejected out of
        // `send()`: the visitor's typed text vanished with an empty transcript,
        // and the caller's un-caught `void send()` raised an unhandled rejection
        // on the host page.
        try {
            if (!this.client || !this.sessionId || this.status !== 'ready') {
                await this.connect();
            }
            if (!this.client || !this.sessionId) {
                throw new Error('Conversation is not connected');
            }
            await this.streamTurn(trimmed, assistant, showTools);
        } catch (err) {
            let failure = err;
            if (isDeadSessionError(err)) {
                // The session id we held is gone server-side. Drop the stale pointer,
                // create a fresh session on the SAME open socket, and re-send once —
                // transparently, so the visitor's message still gets answered instead
                // of the widget wedging and every retry landing in the dead session.
                // A second failure is NOT retried (this path runs once), so a server
                // that keeps saying not-found can't spin sessions in a loop.
                try {
                    await this.recreateSession();
                    assistant.text = '';
                    assistant.blocks = showTools ? [] : undefined;
                    await this.streamTurn(trimmed, assistant, showTools);
                    return;
                } catch (retryErr) {
                    failure = retryErr;
                }
            }
            this.renderTurnFailure(assistant, failure);
        } finally {
            this.activeRequestId = null;
            this.setInterrupt(null);
        }
    }

    /**
     * Replace a dead session with a fresh one, in place. Reuses the recovery
     * machinery `connect()` already uses when a resume probe fails — `clearSession()`
     * on the persisted pointer (identity/consent survive) then `createSession()` —
     * rather than a second, divergent recovery path. It calls `createSession()`
     * directly instead of re-entering `connect()` because the socket is fine (only
     * the session id was dead) and `connect()` early-returns while the status is
     * already `ready`.
     */
    private async recreateSession(): Promise<void> {
        this.pointerState = 'recovery';
        this.store.getState().clearSession();
        this.sessionId = null;
        this.conversationId = null;
        await this.ensureClient();
        // ASK before minting. A dead session id does not mean there is nothing to
        // resume: the wrapper reads storage, so a session the per-pod registry lost
        // (the 2026-08-23 SESSION_NOT_FOUND incident) comes back here — and gets
        // primed — instead of the visitor's conversation splitting in two mid-chat.
        // Bounded: send() retries this whole path exactly once, so a server that
        // keeps saying not-found still cannot spin sessions.
        const { sessionId: fpSessionId } = await this.resumeByFingerprint();
        if (fpSessionId && (await this.tryResume(fpSessionId))) {
            this.store.getState().setSessionId(fpSessionId);
            return;
        }
        await this.createSession();
    }

    /**
     * Render a failed turn. NEVER surfaces the raw error text: a protocol error
     * message is an internal string — it interpolates the session UUID, and on
     * 2026-08-23 a live visitor on smoo.ai was shown `Error: session '<uuid>' not
     * found` in what looks like an agent bubble. This text renders as agent
     * dialogue, so it gets one short human sentence whatever the failure was. The
     * machine detail goes to the status channel instead, which the UI renders as a
     * fixed "Connection issue" label rather than echoing it.
     */
    private renderTurnFailure(assistant: ChatMessage, err: unknown): void {
        assistant.streaming = false;
        const message = this.config.connectionErrorMessage ?? "We couldn't reach the chat.";
        assistant.text = assistant.text ? `${assistant.text}\n\n${message}` : message;
        this.emitMessages();
        this.setStatus('error', err instanceof Error ? err.message : String(err));
    }

    /**
     * Drive one `send_message` turn into `assistant`, streaming tokens in and
     * finalizing on `eventual_response`. Throws on protocol failure — the caller
     * decides whether that is recoverable (see {@link isDeadSessionError}).
     */
    private async streamTurn(trimmed: string, assistant: ChatMessage, showTools: boolean): Promise<void> {
        if (!this.client || !this.sessionId) {
            throw new Error('Conversation is not connected');
        }
        const turn = this.client.sendMessage({ sessionId: this.sessionId, message: trimmed, stream: true });
        this.activeRequestId = turn.requestId;

        for await (const event of turn) {
            if (event.type === 'stream_token') {
                const token = event.token ?? event.data?.token ?? '';
                if (token) {
                    // The real answer has begun — retire the ephemeral preamble.
                    if (assistant.preamble) assistant.preamble = undefined;
                    // Hold the streamed text to the same paragraph shape the finalized
                    // render uses (PARAGRAPH_SEP) so no transient extra blank line
                    // flickers mid-stream then vanishes on finalize (SMOODEV-2534).
                    // ponytail: O(n) re-scan per token; fine for chat-length replies.
                    assistant.text = normalizeParagraphs(assistant.text + token);
                    // Grow the trailing text block so prose interleaves with any
                    // tool chips in the order the model produced them.
                    if (showTools && assistant.blocks) growTextBlock(assistant.blocks, token);
                    this.emitMessages();
                }
            } else if ((event as { type?: string }).type === 'stream_preamble') {
                // Fast-model preamble: show it in the typing slot ONLY while no
                // answer text has arrived yet (a late frame after the answer
                // started is ignored — the server also guards this). Cast because
                // the pinned SDK's union may predate `stream_preamble` (added in
                // @smooai/smooth-operator 1.22.15); shape mirrors stream_token.
                const pre = event as { token?: string; data?: { token?: string } };
                const token = pre.token ?? pre.data?.token ?? '';
                if (token && !assistant.text) {
                    assistant.preamble = (assistant.preamble ?? '') + token;
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
