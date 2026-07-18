/**
 * Public configuration surface for the chat widget.
 *
 * A host page configures the widget either declaratively (HTML attributes on the
 * `<smooth-agent-chat>` element) or programmatically (passing this object to
 * {@link mountChatWidget} / `element.configure(...)`).
 */
import { safeHttpUrl } from './markdown.js';
import { DEFAULT_VOICE_URL } from './voice-session.js';

/**
 * Browser voice input/output (SMOODEV-2534). OFF by default — when disabled the
 * widget renders zero voice UI. When enabled, a mic toggle appears in the
 * composer and speech flows over the browser-voice WebSocket.
 */
export interface ChatWidgetVoiceConfig {
    /** Turn the voice feature on. Default `false`. */
    enabled?: boolean;
    /** Browser-voice WS endpoint. Defaults to the hosted SmooAI voice service. */
    url?: string;
    /**
     * Whether the agent SPEAKS its replies (SMOODEV-2674). `false` starts voice
     * sessions in STT-only mode: the visitor talks, the replies arrive as text
     * only. The visitor can flip this per-session with the speaker toggle.
     * Default `true`.
     */
    tts?: boolean;
}

export interface ChatWidgetTheme {
    /** Foreground text color for the widget chrome. */
    text?: string;
    /** Panel background color. */
    background?: string;
    /** Primary accent (launcher button, send button, outbound bubble). */
    primary?: string;
    /** Text color rendered on top of `primary`. */
    primaryText?: string;
    /** A secondary accent (used for subtle highlights). */
    secondary?: string;
    /** Inbound (assistant) chat bubble background. */
    assistantBubble?: string;
    /** Inbound (assistant) chat bubble text color. */
    assistantBubbleText?: string;
    /** Outbound (user) chat bubble background. Defaults to `primary`. */
    userBubble?: string;
    /** Outbound (user) chat bubble text color. Defaults to `primaryText`. */
    userBubbleText?: string;
    /** Border color for the panel and input. */
    border?: string;

    // ── Aliases for the dashboard's 10-color model (SmooAI agent widget config).
    //    When provided, these take precedence over the canonical keys above, so a
    //    config exported from the agent dashboard themes the widget directly.
    /** Alias for {@link assistantBubble}. */
    chatBubbleInbound?: string;
    /** Alias for {@link assistantBubbleText}. */
    chatBubbleInboundText?: string;
    /** Alias for {@link userBubble}. */
    chatBubbleOutbound?: string;
    /** Alias for {@link userBubbleText}. */
    chatBubbleOutboundText?: string;
}

/**
 * Layout mode for the widget.
 *
 * - `"popover"` (default) — the embeddable launcher bubble + floating panel.
 * - `"fullpage"` — no launcher; the chat fills its container/viewport with a
 *   branded header, a scrollable message list, and an input bar. Ideal for a
 *   dedicated support page (`/chat`, a docs site sidebar, an iframe, …).
 */
export type ChatWidgetMode = 'popover' | 'fullpage';

export interface ChatWidgetConfig {
    /**
     * smooth-operator WebSocket endpoint, e.g.
     * `ws://localhost:8787/ws` (local dev) or your deployed `wss://…/ws` URL.
     */
    endpoint: string;
    /**
     * Layout mode — `"popover"` (default, launcher + floating panel) or
     * `"fullpage"` (chat fills its container; no launcher). See {@link ChatWidgetMode}.
     */
    mode?: ChatWidgetMode;
    /** UUID of the agent to start a conversation session with. */
    agentId: string;
    /** Display name for the agent (header label). Defaults to "Assistant". */
    agentName?: string;
    /**
     * Brand logo shown in the full-page header avatar tile; falls back to the
     * Smooth icon. SECURITY: only absolute `http(s)` URLs are honored — any other
     * scheme (`javascript:`/`data:`/…) is ignored, so a hostile config can't
     * inject script.
     */
    logoUrl?: string;
    /** Optional display name for the user participant. */
    userName?: string;
    /** Optional email address for the user participant. */
    userEmail?: string;
    /** Optional phone number for the user participant (passed via session metadata). */
    userPhone?: string;
    /**
     * Optional pre-auth HMAC context. When the host page has a shared secret with
     * the agent, it can sign `{ userId, signature, timestamp }` so the chat-ws
     * wrapper's `/internal/*` identity routes (and the WS create path) verify the
     * caller without an OTP round-trip (ADR-046/ADR-048). Passed through verbatim.
     */
    authContext?: { userId: string; signature: string; timestamp: number };
    /** Placeholder text for the message input. */
    placeholder?: string;
    /** Greeting rendered when the conversation opens (before any messages). */
    greeting?: string;
    /** Message shown when the connection cannot be (re)established. */
    connectionErrorMessage?: string;
    /** Start the panel open instead of collapsed to the launcher. */
    startOpen?: boolean;
    /**
     * Hide the "powered by smooth-operator" branding in the header tag and the
     * composer footer. Defaults to `false` (branding shown). The `hide-branding`
     * HTML attribute maps to this.
     */
    hideBranding?: boolean;
    /**
     * Suggested starter prompts shown as clickable chips before the first message.
     * Clicking one sends it. Capped at 5 for layout.
     */
    examplePrompts?: string[];
    /**
     * Show mid-conversation suggested-reply chips ("quick replies") under the
     * latest assistant message when the agent returns follow-up suggestions.
     * Clicking one sends it. Defaults to `true` (shown unless explicitly `false`).
     */
    showSuggestedReplies?: boolean;
    /** Require the visitor's name before chatting. */
    requireName?: boolean;
    /** Require the visitor's email before chatting. */
    requireEmail?: boolean;
    /** Require the visitor's phone before chatting. */
    requirePhone?: boolean;
    /**
     * Show the phone field on the pre-chat form (optional unless {@link requirePhone}).
     * Defaults to `true` for this widget — phone rides the session metadata as
     * `userPhone` so the agent can follow up by SMS. Set `false` to hide it.
     */
    collectPhone?: boolean;
    /**
     * Show the email + SMS marketing-consent checkboxes on the pre-chat form.
     * Explicit opt-in, default UNCHECKED; a `consentAt` timestamp is stamped when
     * a box is ticked. Defaults to `true`. The consent record is threaded into the
     * session metadata (ADR-048).
     */
    collectConsent?: boolean;
    /**
     * Offer the cross-device "Restore my chats" affordance — an explicit link that
     * runs the identity-OTP → resolve → replay flow. Defaults to `true`.
     */
    allowChatRestore?: boolean;
    /**
     * Let visitors chat without providing any identity. When `true`, the
     * `require*` flags are ignored and the pre-chat form is skipped.
     */
    allowAnonymous?: boolean;
    /**
     * Show the agent's tool activity (grep / read_file / bash / knowledge_search…)
     * as inline chips interleaved with its prose, mirroring the smooth daemon SPA.
     *
     * Defaults to **`false`**: for a customer-facing support widget, surfacing raw
     * tool calls to an end-user is usually undesirable, so tool activity is hidden
     * and only the assistant's prose renders. Enable it for internal / power-user
     * surfaces where seeing what the agent did mid-turn is valuable.
     */
    showToolActivity?: boolean;
    /** Browser voice input/output. OFF by default (zero UI when off). */
    voice?: ChatWidgetVoiceConfig;
    /** Theme overrides. */
    theme?: ChatWidgetTheme;
}

/** The fully-resolved theme (canonical keys only — aliases are folded in). */
export type ResolvedTheme = Required<Omit<ChatWidgetTheme, 'chatBubbleInbound' | 'chatBubbleInboundText' | 'chatBubbleOutbound' | 'chatBubbleOutboundText'>>;

export type ResolvedConfig = Required<Omit<ChatWidgetConfig, 'theme' | 'userName' | 'userEmail' | 'userPhone' | 'authContext' | 'logoUrl' | 'voice'>> & {
    theme: ResolvedTheme;
    voice: { enabled: boolean; url: string; tts: boolean };
    userName?: string;
    userEmail?: string;
    userPhone?: string;
    authContext?: { userId: string; signature: string; timestamp: number };
    /** Sanitized brand logo URL (`http(s)` only) or `undefined` — see {@link ChatWidgetConfig.logoUrl}. */
    logoUrl?: string;
};

/** Resolve a partial config against the built-in defaults. */
export function resolveConfig(config: ChatWidgetConfig): ResolvedConfig {
    const theme = config.theme ?? {};
    const primary = theme.primary ?? '#00a6a6';
    const primaryText = theme.primaryText ?? '#f8fafc';
    // Dashboard aliases win over canonical keys when present.
    const assistantBubble = theme.chatBubbleInbound ?? theme.assistantBubble ?? '#06134b';
    const assistantBubbleText = theme.chatBubbleInboundText ?? theme.assistantBubbleText ?? '#f8fafc';
    const userBubble = theme.chatBubbleOutbound ?? theme.userBubble ?? primary;
    const userBubbleText = theme.chatBubbleOutboundText ?? theme.userBubbleText ?? primaryText;
    return {
        endpoint: config.endpoint,
        mode: config.mode ?? 'popover',
        agentId: config.agentId,
        agentName: config.agentName ?? 'Assistant',
        // Only absolute http(s) URLs survive — anything else (javascript:/data:/
        // relative) is dropped so the header can never render a hostile logo src.
        logoUrl: safeHttpUrl(config.logoUrl) ?? undefined,
        userName: config.userName,
        userEmail: config.userEmail,
        userPhone: config.userPhone,
        authContext: config.authContext,
        placeholder: config.placeholder ?? 'Type a message…',
        greeting: config.greeting ?? 'Hi! How can I help you today?',
        connectionErrorMessage: config.connectionErrorMessage ?? "We couldn't reach the chat. Please try again in a moment.",
        startOpen: config.startOpen ?? false,
        hideBranding: config.hideBranding ?? false,
        examplePrompts: (config.examplePrompts ?? []).filter((p) => p.trim().length > 0).slice(0, 5),
        showSuggestedReplies: config.showSuggestedReplies ?? true,
        requireName: config.requireName ?? false,
        requireEmail: config.requireEmail ?? false,
        requirePhone: config.requirePhone ?? false,
        collectPhone: config.collectPhone ?? true,
        collectConsent: config.collectConsent ?? true,
        allowChatRestore: config.allowChatRestore ?? true,
        allowAnonymous: config.allowAnonymous ?? false,
        showToolActivity: config.showToolActivity ?? false,
        voice: { enabled: config.voice?.enabled ?? false, url: config.voice?.url ?? DEFAULT_VOICE_URL, tts: config.voice?.tts ?? true },
        theme: {
            text: theme.text ?? '#f8fafc',
            background: theme.background ?? '#040d30',
            primary,
            primaryText,
            secondary: theme.secondary ?? '#ff6b6c',
            assistantBubble,
            assistantBubbleText,
            userBubble,
            userBubbleText,
            border: theme.border ?? 'rgba(255, 255, 255, 0.1)',
        },
    };
}

/**
 * Whether the pre-chat identity form should gate the conversation: at least one
 * field is required and anonymous chat is not allowed.
 */
export function needsUserInfo(resolved: ResolvedConfig): boolean {
    return !resolved.allowAnonymous && (resolved.requireName || resolved.requireEmail || resolved.requirePhone);
}
