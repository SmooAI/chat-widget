/**
 * `<smooth-agent-chat>` — a framework-light embeddable chat web component.
 *
 * A clean, dependency-light web component that preserves a familiar embedding
 * model — a launcher + popover panel, declarative HTML attributes, and a
 * programmatic API — while talking to the `@smooai/smooth-operator` protocol
 * client. The visual layer is the "Aurora Glass" design system (see
 * {@link buildStyles}): a spring launcher with a live presence pulse, a
 * glass-depth panel, a gradient brand avatar + status dot, an animated typing
 * indicator, message rise-in, refined source cards, and an icon composer. Every
 * color is driven by `--sac-*` custom properties so a host's brand flows through.
 *
 * Embedding model:
 *   <smooth-agent-chat endpoint="ws://localhost:8787/ws" agent-id="…"></smooth-agent-chat>
 * or programmatically via {@link mountChatWidget}.
 */
import { AsYouType, isValidPhoneNumber, parsePhoneNumber } from 'libphonenumber-js/min';
import type { ChatWidgetConfig, ChatWidgetMode, ChatWidgetTheme } from './config.js';
import { needsUserInfo, resolveConfig } from './config.js';
import { type ChatMessage, type Citation, type ConnectionStatus, ConversationController, type IdentityRestore, type Interrupt } from './conversation.js';
import { SMOOTH_ICON_SVG } from './logo.js';
import { cleanCitationSnippet, escapeHtml, renderMarkdown, safeHttpUrl } from './markdown.js';
import { buildStyles } from './styles.js';

export const ELEMENT_TAG = 'smooth-agent-chat';

/**
 * Default region for phone parsing/formatting on the pre-chat form. The widget
 * is US-first; the backend does the authoritative E.164 normalization (SMOODEV-2153),
 * so this only governs the as-you-type display + the inline validity hint and the
 * best-effort E.164 we send when the number already parses as valid.
 */
const PHONE_DEFAULT_REGION = 'US' as const;

/**
 * Best-effort E.164 for an as-typed phone number. Returns the canonical
 * `+1…` form when the value parses to a valid number in {@link PHONE_DEFAULT_REGION},
 * otherwise `null` (caller falls back to sending the raw value — the backend
 * re-parses and normalizes/nulls authoritatively).
 */
function phoneToE164(value: string): string | null {
    const v = value.trim();
    if (!v) return null;
    try {
        if (!isValidPhoneNumber(v, PHONE_DEFAULT_REGION)) return null;
        return parsePhoneNumber(v, PHONE_DEFAULT_REGION).number;
    } catch {
        return null;
    }
}

/** Public smooth-operator repo — the "powered by" header tag + footer link here. */
const SMOOTH_OPERATOR_URL = 'https://github.com/SmooAI/smooth-operator';

const OBSERVED = ['endpoint', 'agent-id', 'agent-name', 'logo-url', 'placeholder', 'greeting', 'start-open', 'mode', 'hide-branding'] as const;

/**
 * Inline SVG icons (static, trusted strings — never interpolated with user data).
 * Kept here so the IIFE bundle is self-contained: no icon-font or network fetch.
 */
const ICON = {
    /** Launcher — a speech bubble carrying a spark (chat + AI). */
    spark: `<svg class="ico" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 3.5c-4.7 0-8.5 3.2-8.5 7.2 0 2.2 1.2 4.2 3 5.5v3.3l3.2-1.7c.7.1 1.5.2 2.3.2 4.7 0 8.5-3.2 8.5-7.3S16.7 3.5 12 3.5Z" fill="currentColor" opacity=".22"/><path d="M13.4 7.2 9 12.6h2.6l-1 4.2 4.4-5.4h-2.6l1-4.2Z" fill="currentColor"/></svg>`,
    /** Small assistant avatar used beside each assistant message. */
    bot: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4.5" y="7.5" width="15" height="11" rx="3.5" stroke="currentColor" stroke-width="1.6"/><path d="M12 4.5v3M8.5 12.2h.01M15.5 12.2h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M9.5 15.4c.7.6 1.5.9 2.5.9s1.8-.3 2.5-.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    /** Close (collapse panel) — a downward chevron. */
    close: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="m7 10 5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    /** Send — an upward arrow. */
    send: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 19V6M12 6l-5.5 5.5M12 6l5.5 5.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    /** Sources disclosure caret. */
    chev: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    /** OTP interrupt — a padlock. */
    lock: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="10.5" width="14" height="9.5" rx="2.2" stroke="currentColor" stroke-width="1.7"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" stroke="currentColor" stroke-width="1.7"/></svg>`,
    /** Tool-confirmation interrupt — a shield. */
    shield: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 3 5 6v5c0 4.4 3 7.2 7 8.5 4-1.3 7-4.1 7-8.5V6l-7-3Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m9 11.5 2 2 4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
} as const;

// `safeHttpUrl` / `escapeHtml` live in `./markdown.js` (the markdown renderer
// needs them too); re-exported here for back-compat with existing importers.
export { escapeHtml, safeHttpUrl } from './markdown.js';

export class SmoothAgentChatElement extends HTMLElement {
    static get observedAttributes(): readonly string[] {
        return OBSERVED;
    }

    private readonly root: ShadowRoot;
    private controller: ConversationController | null = null;
    private overrides: Partial<ChatWidgetConfig> = {};
    private open = false;
    private messages: ChatMessage[] = [];
    private status: ConnectionStatus = 'idle';
    private mounted = false;
    /** True once the visitor has cleared the pre-chat identity gate (or it's not needed). */
    private userInfoSatisfied = false;
    /** True after the visitor has sent their first message (hides starter chips). */
    private hasSent = false;
    /** Starter prompts shown as chips in the empty state. */
    private examplePrompts: string[] = [];
    /** Whether mid-conversation suggested-reply chips are shown (config). */
    private showSuggestedReplies = true;
    /** Resolved greeting text, cached so async (rAF) renders can reuse it. */
    private greeting = '';
    /** Current mid-turn interrupt (OTP / tool-confirmation), or null. */
    private interrupt: Interrupt | null = null;
    private interruptEl: HTMLElement | null = null;
    /** Cross-device "restore my chats" flow state (ADR-048 §c). */
    private identityRestore: IdentityRestore = { phase: 'idle' };
    /** Whether the cross-device restore affordance is offered (config). */
    private allowChatRestore = true;
    /** True while the pre-chat identity gate is showing (blocks premature connect). */
    private gating = false;

    // Cached DOM refs (populated in render()).
    private panelEl: HTMLElement | null = null;
    private launcherEl: HTMLElement | null = null;
    private messagesEl: HTMLElement | null = null;
    private statusEl: HTMLElement | null = null;
    private dotEl: HTMLElement | null = null;
    private inputEl: HTMLTextAreaElement | null = null;
    private sendBtn: HTMLButtonElement | null = null;
    private suggestionsEl: HTMLElement | null = null;

    // ── Smooth streaming reveal ──
    // Tokens arrive in variable-size bursts at uneven rates, so revealing text in
    // lockstep with arrival looks jerky. Instead we buffer the full target text
    // and reveal it via a requestAnimationFrame "typewriter" at an adaptive rate
    // (chars/frame scales with the pending backlog so it never falls behind the
    // network). State below tracks the single in-flight streaming bubble.
    /** The live streaming assistant bubble whose textContent the rAF loop drives. */
    private streamBubbleEl: HTMLElement | null = null;
    /** Message id the reveal is bound to (guards against stale frames after rebuilds). */
    private streamMsgId: string | null = null;
    /** Full buffered target text for the streaming message (grows as tokens arrive). */
    private streamTarget = '';
    /** How many chars of {@link streamTarget} are currently shown. */
    private displayedLength = 0;
    private rafId = 0;

    constructor() {
        super();
        this.root = this.attachShadow({ mode: 'open' });
    }

    connectedCallback(): void {
        this.mounted = true;
        this.render();
    }

    disconnectedCallback(): void {
        this.mounted = false;
        this.resetReveal();
        this.controller?.disconnect();
        this.controller = null;
    }

    attributeChangedCallback(): void {
        if (this.mounted) this.render();
    }

    /**
     * Programmatically merge config overrides (endpoint, agentId, theme, …). Values
     * set here take precedence over HTML attributes. Re-renders the widget.
     */
    configure(config: Partial<ChatWidgetConfig>): void {
        this.overrides = { ...this.overrides, ...config };
        if (config.theme) {
            this.overrides.theme = { ...(this.overrides.theme ?? {}), ...config.theme };
        }
        if (this.mounted) this.render();
    }

    /** Open the chat panel. */
    openChat(): void {
        this.open = true;
        this.syncOpenState();
        // Don't connect while the pre-chat identity gate is unsatisfied — connecting
        // here would create a session BEFORE the visitor submits their name/email/
        // consent, sending an empty identity. The form's submit handler connects.
        if (!this.gating) void this.controller?.connect().catch(() => {});
    }

    /** Collapse the chat panel back to the launcher. */
    closeChat(): void {
        this.open = false;
        this.syncOpenState();
    }

    // ─────────────────────────── Config resolution ─────────────────────────────

    private readConfig(): ChatWidgetConfig | null {
        const endpoint = this.overrides.endpoint ?? this.getAttribute('endpoint') ?? '';
        const agentId = this.overrides.agentId ?? this.getAttribute('agent-id') ?? '';
        if (!endpoint || !agentId) return null;

        const theme: ChatWidgetTheme | undefined = this.overrides.theme;
        const modeAttr = this.getAttribute('mode');
        const mode: ChatWidgetMode = this.overrides.mode ?? (modeAttr === 'fullpage' ? 'fullpage' : modeAttr === 'popover' ? 'popover' : undefined) ?? 'popover';
        return {
            endpoint,
            mode,
            agentId,
            agentName: this.overrides.agentName ?? this.getAttribute('agent-name') ?? undefined,
            logoUrl: this.overrides.logoUrl ?? this.getAttribute('logo-url') ?? undefined,
            userName: this.overrides.userName,
            userEmail: this.overrides.userEmail,
            userPhone: this.overrides.userPhone,
            authContext: this.overrides.authContext,
            placeholder: this.overrides.placeholder ?? this.getAttribute('placeholder') ?? undefined,
            greeting: this.overrides.greeting ?? this.getAttribute('greeting') ?? undefined,
            connectionErrorMessage: this.overrides.connectionErrorMessage,
            startOpen: this.overrides.startOpen ?? this.hasAttribute('start-open'),
            hideBranding: this.overrides.hideBranding ?? this.hasAttribute('hide-branding'),
            examplePrompts: this.overrides.examplePrompts,
            showSuggestedReplies: this.overrides.showSuggestedReplies,
            requireName: this.overrides.requireName,
            requireEmail: this.overrides.requireEmail,
            requirePhone: this.overrides.requirePhone,
            collectPhone: this.overrides.collectPhone,
            collectConsent: this.overrides.collectConsent,
            allowChatRestore: this.overrides.allowChatRestore,
            allowAnonymous: this.overrides.allowAnonymous,
            theme,
        };
    }

    // ───────────────────────────────── Render ──────────────────────────────────

    private render(): void {
        const config = this.readConfig();
        if (!config) {
            this.root.innerHTML = '';
            return;
        }
        const resolved = resolveConfig(config);

        this.allowChatRestore = resolved.allowChatRestore;

        // (Re)create the controller only when there isn't one yet. Attribute churn
        // (e.g. theme tweaks) re-renders the view without dropping the session.
        if (!this.controller) {
            this.controller = new ConversationController(config, {
                onMessages: (messages) => {
                    this.handleMessages(messages, resolved.greeting);
                },
                onStatus: (status) => {
                    this.status = status;
                    this.renderStatus();
                    this.renderComposerState();
                },
                onInterrupt: (interrupt) => {
                    this.interrupt = interrupt;
                    this.renderInterrupt();
                    // Suggestion chips are hidden while an interrupt overlay is up.
                    this.renderSuggestions();
                },
                onIdentityRestore: (state) => {
                    this.identityRestore = state;
                    this.renderInterrupt();
                    // The restore overlay reuses the interrupt slot — hide chips too.
                    this.renderSuggestions();
                },
            });
            if (resolved.startOpen) this.open = true;
            // Returning visitor: a persisted session or identity lets us skip the
            // pre-chat gate and resume straight into the conversation (ADR-048 §b).
            if (this.controller.hasPersistedSession() || this.controller.hasPersistedIdentity()) {
                this.userInfoSatisfied = true;
            }
        }

        const fullpage = resolved.mode === 'fullpage';
        // Full-page mode is always "open" — it fills its container and has no
        // launcher to toggle.
        if (fullpage) this.open = true;

        const style = document.createElement('style');
        style.textContent = buildStyles(resolved.theme, resolved.mode);

        // Header: in full-page mode lead with the brand logo in the avatar tile
        // and a subtle "powered by" tag; in popover mode show a brand-colored
        // monogram avatar + a compact close (collapse) button. The logo defaults
        // to the square Smooth icon, but a host page can override it with
        // `logoUrl` (already sanitized to http(s)-only by resolveConfig; escaped
        // here so it can't break out of the src attribute).
        const monogram = escapeHtml((resolved.agentName.trim().charAt(0) || 'A').toUpperCase());
        const headerLogo = resolved.logoUrl
            ? `<img src="${escapeHtml(resolved.logoUrl)}" alt="" class="logo-img" />`
            : SMOOTH_ICON_SVG;
        const header = fullpage
            ? `<div class="header">
                    <div class="avatar"><span class="logo-wrap">${headerLogo}</span></div>
                    <div class="meta">
                        <span class="title">${escapeHtml(resolved.agentName)}</span>
                        <span class="status"><span class="dot off"></span><span class="status-text"></span></span>
                    </div>
                    ${
                        resolved.hideBranding
                            ? ''
                            : `<a class="powered" href="${SMOOTH_OPERATOR_URL}" target="_blank" rel="noopener noreferrer">powered by smooth-operator</a>`
                    }
                </div>`
            : `<div class="header">
                    <div class="avatar">${monogram}</div>
                    <div class="meta">
                        <span class="title">${escapeHtml(resolved.agentName)}</span>
                        <span class="status"><span class="dot off"></span><span class="status-text"></span></span>
                    </div>
                    <button class="close" aria-label="Close chat">${ICON.close}</button>
                </div>`;

        // Remember starter prompts + greeting for the empty-state chips / async renders.
        this.examplePrompts = resolved.examplePrompts;
        this.showSuggestedReplies = resolved.showSuggestedReplies;
        this.greeting = resolved.greeting;

        // Gate the conversation behind a pre-chat identity form when required.
        const gating = needsUserInfo(resolved) && !this.userInfoSatisfied;
        this.gating = gating;
        // Phone is collected by default (optional unless requirePhone). Consent
        // checkboxes default to shown, explicit + unchecked (ADR-048 §a/§3).
        const showPhone = resolved.requirePhone || resolved.collectPhone;
        const field = (name: string, type: string, label: string, autocomplete: string, required: boolean, hint = false) =>
            `<label class="pc-field"><span>${escapeHtml(label)}</span><input name="${name}" type="${type}" autocomplete="${autocomplete}"${required ? ' required' : ''} />${
                hint ? '<span class="pc-hint" aria-live="polite"></span>' : ''
            }</label>`;
        const consentBox = (name: string, label: string) =>
            `<label class="pc-consent"><input name="${name}" type="checkbox" /><span>${escapeHtml(label)}</span></label>`;
        const consentHtml = resolved.collectConsent
            ? `<div class="pc-consents">
                    ${consentBox('emailOptIn', 'Email me product news and offers.')}
                    ${consentBox('smsOptIn', 'Text me updates by SMS. Message/data rates may apply.')}
                </div>`
            : '';
        const prechatHtml = `
            <div class="prechat">
                <div class="pc-head">
                    <div class="pc-title">Before we chat</div>
                    <div class="pc-sub">A couple details so ${escapeHtml(resolved.agentName)} can help.</div>
                </div>
                <form class="pc-form" novalidate>
                    ${resolved.requireName ? field('name', 'text', 'Name', 'name', true) : ''}
                    ${resolved.requireEmail ? field('email', 'email', 'Email', 'email', true) : ''}
                    ${showPhone ? field('phone', 'tel', 'Phone', 'tel', resolved.requirePhone, true) : ''}
                    ${consentHtml}
                    <button type="submit" class="pc-submit">Start chat</button>
                </form>
            </div>`;
        // Footer: optional "powered by" branding (hidden by hide-branding) and an
        // optional "Restore my chats" affordance. The " · " separator only appears
        // when both are present, and the footer is omitted entirely when neither is.
        const brandingHtml = resolved.hideBranding
            ? ''
            : `<a href="${SMOOTH_OPERATOR_URL}" target="_blank" rel="noopener noreferrer">powered by <b>smooth&#8209;operator</b></a>`;
        const restoreBtn = this.allowChatRestore ? `<button type="button" class="restore-link">Restore my chats</button>` : '';
        const footerInner = [brandingHtml, restoreBtn].filter(Boolean).join(' · ');
        const footerHtml = footerInner ? `<div class="footer">${footerInner}</div>` : '';
        const chatHtml = `
                <div class="messages"></div>
                <div class="reply-suggestions"></div>
                <div class="interrupt hidden"></div>
                <div class="composer-wrap">
                    <div class="composer">
                        <textarea rows="1" placeholder="${escapeHtml(resolved.placeholder)}"></textarea>
                        <button class="send" type="button" aria-label="Send message">${ICON.send}</button>
                    </div>
                    ${footerHtml}
                </div>`;

        const container = document.createElement('div');
        container.className = 'wrap';
        container.innerHTML = `
            ${fullpage ? '' : `<button class="launcher" part="launcher" aria-label="Open chat">${ICON.spark}</button>`}
            <div class="panel${fullpage ? ' fullpage' : ' hidden'}" part="panel" role="${fullpage ? 'region' : 'dialog'}" aria-label="${escapeHtml(resolved.agentName)} chat">
                ${header}
                <div class="header-sep"></div>
                ${gating ? prechatHtml : chatHtml}
            </div>
        `;

        // Tag the logo <svg> so styles can size it (the inlined SVG has its own id).
        const logoSvg = container.querySelector('.logo-wrap svg');
        if (logoSvg) logoSvg.setAttribute('class', 'logo');

        // A full DOM rebuild invalidates any cached streaming-bubble ref; cancel
        // the in-flight reveal loop so renderMessages can re-bind cleanly.
        this.resetReveal();
        this.root.replaceChildren(style, container);

        this.launcherEl = container.querySelector('.launcher');
        this.panelEl = container.querySelector('.panel');
        this.messagesEl = container.querySelector('.messages');
        this.statusEl = container.querySelector('.status-text');
        this.dotEl = container.querySelector('.dot');
        this.inputEl = container.querySelector('textarea');
        this.sendBtn = container.querySelector('.send');
        this.interruptEl = container.querySelector('.interrupt');
        this.suggestionsEl = container.querySelector('.reply-suggestions');

        this.launcherEl?.addEventListener('click', () => this.openChat());
        container.querySelector('.close')?.addEventListener('click', () => this.closeChat());
        this.sendBtn?.addEventListener('click', () => this.submit());
        this.inputEl?.addEventListener('input', () => this.autosize());
        this.inputEl?.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) {
                ev.preventDefault();
                this.submit();
            }
        });

        const pcForm = container.querySelector('.pc-form');
        pcForm?.addEventListener('submit', (ev) => {
            ev.preventDefault();
            this.handlePrechatSubmit(pcForm as HTMLFormElement);
        });

        // Live phone formatting + validity hint (libphonenumber-js, US default).
        // The implicit <label>, type="tel", and autocomplete="tel" from field()
        // are preserved — autofill keeps working — and we also reformat on
        // `change` so a browser-autofilled value gets formatted/validated too.
        this.wirePhoneField(pcForm as HTMLFormElement | null);

        // Cross-device "Restore my chats": open the panel + start the email entry.
        // AWAIT connect() before showing the email step so a `sessionId` exists by
        // the time the visitor submits — otherwise request-otp could go out with no
        // session and verify-otp would then hard-error "No active session." The
        // request-otp/verify-otp paths in the controller also require a session, so
        // gating here keeps the affordance race-free.
        container.querySelector('.restore-link')?.addEventListener('click', () => {
            void (async () => {
                this.identityRestore = { phase: 'awaiting_email' };
                this.renderInterrupt();
                // Establish a live session before the email entry can fire request-otp.
                await this.controller?.connect().catch(() => {});
            })();
        });

        // Full-page mode sizes to the host's box; fall back to the viewport only
        // when the container gives the host no height.
        if (fullpage) this.syncViewportFallback();

        // Full-page mode connects eagerly (there's no launcher click to trigger it) —
        // but only once any identity gate is cleared.
        if (fullpage && !gating) void this.controller?.connect().catch(() => {});

        this.syncOpenState();
        if (!gating) this.renderMessages();
        this.renderStatus();
        this.renderComposerState();
        this.renderInterrupt();
    }

    /**
     * Render (or clear) the mid-turn interrupt overlay above the composer:
     * an OTP code prompt or a tool-write confirmation. Server-supplied text is
     * set via `textContent` (never innerHTML); only static icons use innerHTML.
     */
    private renderInterrupt(): void {
        const el = this.interruptEl;
        if (!el) return;
        el.replaceChildren();
        const it = this.interrupt;
        if (!it) {
            // No mid-turn interrupt — but the cross-device restore flow may be
            // active, which reuses this same overlay slot.
            if (this.identityRestore.phase !== 'idle') {
                el.classList.remove('hidden');
                el.appendChild(this.buildRestoreCard());
                return;
            }
            el.classList.add('hidden');
            return;
        }
        el.classList.remove('hidden');

        const card = document.createElement('div');
        card.className = 'int-card';

        const head = document.createElement('div');
        head.className = 'int-head';
        const ico = document.createElement('span');
        ico.className = 'int-ico';
        ico.innerHTML = it.kind === 'otp' ? ICON.lock : ICON.shield; // static, trusted
        const title = document.createElement('span');
        title.className = 'int-title';
        title.textContent = it.kind === 'otp' ? 'Verification required' : 'Confirm this action';
        head.append(ico, title);
        card.appendChild(head);

        if (it.actionDescription) {
            const desc = document.createElement('div');
            desc.className = 'int-desc';
            desc.textContent = it.actionDescription;
            card.appendChild(desc);
        }

        if (it.kind === 'otp') {
            if (it.sent?.maskedDestination) {
                const sent = document.createElement('div');
                sent.className = 'int-sent';
                sent.textContent = `Code sent to ${it.sent.maskedDestination}${it.sent.channel ? ` via ${it.sent.channel}` : ''}.`;
                card.appendChild(sent);
            }
            const row = document.createElement('div');
            row.className = 'int-row';
            const input = document.createElement('input');
            input.className = 'int-input';
            input.type = 'text';
            input.inputMode = 'numeric';
            input.autocomplete = 'one-time-code';
            input.placeholder = 'Enter code';
            const submit = () => {
                const code = input.value.trim();
                if (code) this.controller?.verifyOtp(code);
            };
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    submit();
                }
            });
            const verify = document.createElement('button');
            verify.className = 'int-btn primary';
            verify.type = 'button';
            verify.textContent = 'Verify';
            verify.addEventListener('click', submit);
            row.append(input, verify);
            card.appendChild(row);
            if (it.error) {
                const err = document.createElement('div');
                err.className = 'int-error';
                err.textContent = it.attemptsRemaining != null ? `${it.error} (${it.attemptsRemaining} left)` : it.error;
                card.appendChild(err);
            }
            queueMicrotask(() => input.focus());
        } else {
            const row = document.createElement('div');
            row.className = 'int-row';
            const decline = document.createElement('button');
            decline.className = 'int-btn';
            decline.type = 'button';
            decline.textContent = 'Decline';
            decline.addEventListener('click', () => this.controller?.confirmTool(false));
            const approve = document.createElement('button');
            approve.className = 'int-btn primary';
            approve.type = 'button';
            approve.textContent = 'Approve';
            approve.addEventListener('click', () => this.controller?.confirmTool(true));
            row.append(decline, approve);
            card.appendChild(row);
        }

        el.appendChild(card);
    }

    /**
     * Build the cross-device "Restore my chats" card (ADR-048 §c). Reuses the
     * same overlay slot + visual language as the OTP interrupt. All server-supplied
     * strings (masked destination, conversation previews) are set via `textContent`
     * — never innerHTML — so they can't inject markup; only the static lock icon
     * uses innerHTML.
     */
    private buildRestoreCard(): HTMLElement {
        const state = this.identityRestore;
        const card = document.createElement('div');
        card.className = 'int-card';

        const head = document.createElement('div');
        head.className = 'int-head';
        const ico = document.createElement('span');
        ico.className = 'int-ico';
        ico.innerHTML = ICON.lock; // static, trusted
        const title = document.createElement('span');
        title.className = 'int-title';
        title.textContent = 'Restore your chats';
        head.append(ico, title);
        card.appendChild(head);

        const close = document.createElement('button');
        close.className = 'int-close';
        close.type = 'button';
        close.setAttribute('aria-label', 'Cancel');
        close.textContent = '×';
        close.addEventListener('click', () => {
            this.controller?.cancelIdentityRestore();
            this.identityRestore = { phase: 'idle' };
            this.renderInterrupt();
        });
        card.appendChild(close);

        if (state.phase === 'awaiting_email') {
            const desc = document.createElement('div');
            desc.className = 'int-desc';
            desc.textContent = "Enter your email and we'll send a code to find your previous chats.";
            card.appendChild(desc);

            const row = document.createElement('div');
            row.className = 'int-row';
            const input = document.createElement('input');
            input.className = 'int-input';
            input.type = 'email';
            input.autocomplete = 'email';
            input.placeholder = 'you@example.com';
            const go = () => {
                const email = input.value.trim();
                if (email) void this.controller?.requestIdentityOtp(email, 'email');
            };
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    go();
                }
            });
            const send = document.createElement('button');
            send.className = 'int-btn primary';
            send.type = 'button';
            send.textContent = 'Send code';
            send.addEventListener('click', go);
            row.append(input, send);
            card.appendChild(row);
            if (state.error) {
                const err = document.createElement('div');
                err.className = 'int-error';
                err.textContent = state.error;
                card.appendChild(err);
            }
            queueMicrotask(() => input.focus());
        } else if (state.phase === 'requesting' || state.phase === 'verifying' || state.phase === 'resolving') {
            const msg = document.createElement('div');
            msg.className = 'int-sent';
            msg.textContent = state.phase === 'requesting' ? 'Sending a code…' : state.phase === 'verifying' ? 'Verifying…' : 'Finding your chats…';
            card.appendChild(msg);
        } else if (state.phase === 'awaiting_code') {
            if (state.maskedDestination) {
                const sent = document.createElement('div');
                sent.className = 'int-sent';
                sent.textContent = `Code sent to ${state.maskedDestination}.`;
                card.appendChild(sent);
            }
            const row = document.createElement('div');
            row.className = 'int-row';
            const input = document.createElement('input');
            input.className = 'int-input';
            input.type = 'text';
            input.inputMode = 'numeric';
            input.autocomplete = 'one-time-code';
            input.placeholder = 'Enter code';
            const submit = () => {
                const code = input.value.trim();
                if (code) void this.controller?.verifyIdentityOtp(code);
            };
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    submit();
                }
            });
            const verify = document.createElement('button');
            verify.className = 'int-btn primary';
            verify.type = 'button';
            verify.textContent = 'Verify';
            verify.addEventListener('click', submit);
            row.append(input, verify);
            card.appendChild(row);
            if (state.error) {
                const err = document.createElement('div');
                err.className = 'int-error';
                err.textContent = state.attemptsRemaining != null ? `${state.error} (${state.attemptsRemaining} left)` : state.error;
                card.appendChild(err);
            }
            queueMicrotask(() => input.focus());
        } else if (state.phase === 'resolved') {
            if (state.conversations.length === 0) {
                const none = document.createElement('div');
                none.className = 'int-desc';
                none.textContent = 'No previous chats found for that email.';
                card.appendChild(none);
            } else {
                const pick = document.createElement('div');
                pick.className = 'int-desc';
                pick.textContent = 'Pick a conversation to continue:';
                card.appendChild(pick);
                const list = document.createElement('div');
                list.className = 'restore-list';
                for (const conv of state.conversations) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'restore-item';
                    const preview = document.createElement('span');
                    preview.className = 'restore-preview';
                    preview.textContent = conv.preview || 'Conversation';
                    btn.appendChild(preview);
                    if (conv.lastActivityAt) {
                        const when = document.createElement('span');
                        when.className = 'restore-when';
                        when.textContent = this.formatWhen(conv.lastActivityAt);
                        btn.appendChild(when);
                    }
                    btn.addEventListener('click', () => {
                        void this.controller?.restoreConversation(conv.sessionId);
                    });
                    list.appendChild(btn);
                }
                card.appendChild(list);
            }
        } else if (state.phase === 'error') {
            const err = document.createElement('div');
            err.className = 'int-error';
            err.textContent = state.message;
            card.appendChild(err);
        }

        return card;
    }

    /** Format an ISO timestamp as a short, locale-aware label (best-effort). */
    private formatWhen(iso: string): string {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        try {
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        } catch {
            return '';
        }
    }

    /**
     * Wire as-you-type formatting + an inline validity hint onto the pre-chat
     * phone input (libphonenumber-js, US default region). Autofill is preserved:
     * the input keeps its `type="tel"` + `autocomplete="tel"` + implicit <label>,
     * and we also reformat on `change` so a browser-autofilled value gets
     * formatted/validated too.
     *
     * As-you-type caret note: `AsYouType` reformats the entire string, which
     * moves the caret to the end on a mid-string edit. To avoid fighting the
     * user, we only rewrite the value when the caret is at the end (the typical
     * append-a-digit case) and never on a deletion — so backspacing the
     * formatting characters works naturally.
     */
    private wirePhoneField(form: HTMLFormElement | null): void {
        const input = form?.querySelector('input[name="phone"]') as HTMLInputElement | null;
        if (!input) return;
        const hint = input.parentElement?.querySelector('.pc-hint') as HTMLElement | null;

        const updateHint = () => {
            const v = input.value.trim();
            const field = input.closest('.pc-field');
            if (!v) {
                // Empty is neutral — the field is optional unless requirePhone.
                field?.classList.remove('valid', 'invalid');
                if (hint) hint.textContent = '';
                return;
            }
            const ok = isValidPhoneNumber(v, PHONE_DEFAULT_REGION);
            field?.classList.toggle('valid', ok);
            field?.classList.toggle('invalid', !ok);
            if (hint) hint.textContent = ok ? '' : 'Enter a valid phone number';
        };

        const reformat = () => {
            const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
            // Only reformat when appending at the end; never fight a mid-string
            // edit or a deletion (see the caret note above).
            if (atEnd) {
                const formatted = new AsYouType(PHONE_DEFAULT_REGION).input(input.value);
                // Avoid clobbering when the user is deleting: only grow/normalize,
                // not when the formatter would re-add a character they just removed.
                if (formatted.length >= input.value.length) {
                    input.value = formatted;
                }
            }
            updateHint();
        };

        input.addEventListener('input', (ev) => {
            const ie = ev as InputEvent;
            // Don't reformat while deleting — let the user clear characters freely.
            if (typeof ie.inputType === 'string' && ie.inputType.startsWith('delete')) {
                updateHint();
                return;
            }
            reformat();
        });
        // Browser autofill / paste-then-blur lands here; format + validate it too.
        input.addEventListener('change', reformat);
    }

    /** Collect identity + consent from the pre-chat form, then drop into the chat view. */
    private handlePrechatSubmit(form: HTMLFormElement): void {
        if (!form.reportValidity()) return;
        const data = new FormData(form);
        const val = (k: string) => ((data.get(k) as string | null)?.trim() || undefined);
        const checked = (k: string) => data.get(k) === 'on';

        // Phone: when required, block on an invalid number and surface the hint.
        // When optional, allow submit — the backend normalizes/nulls authoritatively.
        const rawPhone = val('phone');
        const phoneInput = form.querySelector('input[name="phone"]') as HTMLInputElement | null;
        if (rawPhone && phoneInput && !isValidPhoneNumber(rawPhone, PHONE_DEFAULT_REGION)) {
            const required = phoneInput.hasAttribute('required');
            const field = phoneInput.closest('.pc-field');
            field?.classList.add('invalid');
            const hint = field?.querySelector('.pc-hint');
            if (hint) hint.textContent = 'Enter a valid phone number';
            if (required) {
                phoneInput.focus();
                return;
            }
        }
        // Prefer canonical E.164 when it parses; fall back to the raw value
        // otherwise (the backend re-parses + normalizes either way).
        const phone = rawPhone ? (phoneToE164(rawPhone) ?? rawPhone) : undefined;

        this.controller?.setUserInfo({
            name: val('name'),
            email: val('email'),
            phone,
            consent: { emailOptIn: checked('emailOptIn'), smsOptIn: checked('smsOptIn') },
        });
        this.userInfoSatisfied = true;
        this.render();
        void this.controller?.connect().catch(() => {});
    }

    /** Send a starter prompt (from a chip click). */
    private submitPrompt(text: string): void {
        if (!this.inputEl) return;
        this.inputEl.value = text;
        this.submit();
    }

    private syncOpenState(): void {
        // In full-page mode the panel always fills the host; nothing to toggle.
        if (this.panelEl?.classList.contains('fullpage')) {
            this.inputEl?.focus();
            return;
        }
        this.panelEl?.classList.toggle('hidden', !this.open);
        this.launcherEl?.classList.toggle('hidden', this.open);
        if (this.open) this.inputEl?.focus();
    }

    /** Grow the textarea with its content, up to the CSS max-height. */
    private autosize(): void {
        const ta = this.inputEl;
        if (!ta) return;
        ta.style.height = 'auto';
        ta.style.height = `${ta.scrollHeight}px`;
    }

    /**
     * Receive a new message snapshot from the controller and update the view.
     *
     * `onMessages` fires on *every* `stream_token` delta. Rebuilding the whole
     * list each frame is wasteful and fights the smooth reveal, so we take the
     * cheap path when the only change is the trailing streaming assistant message
     * growing: just bump the reveal *target* (the rAF loop drains it). Any
     * structural change (new message, finalize, citations) triggers a full
     * rebuild via {@link renderMessages}.
     */
    private handleMessages(messages: ChatMessage[], greeting: string): void {
        this.greeting = greeting;
        const prev = this.messages;
        const last = messages[messages.length - 1];
        const prevLast = prev[prev.length - 1];

        const structural =
            messages.length !== prev.length ||
            !last ||
            !prevLast ||
            last.id !== prevLast.id ||
            last.role !== prevLast.role ||
            // finalize transition (streaming → done) needs the markdown render + sources
            last.streaming !== prevLast.streaming ||
            // first token after the typing indicator needs the bubble swapped in
            (!!last.streaming && !prevLast.text && !!last.text);

        this.messages = messages;

        if (!structural && last && last.streaming && last.id === this.streamMsgId) {
            // Fast path: the streaming tail just grew. Bump the reveal target and
            // let the rAF loop catch up — no DOM rebuild, no per-token reflow.
            this.streamTarget = last.text;
            this.ensureRevealLoop();
            return;
        }

        this.renderMessages();
    }

    private renderMessages(): void {
        if (!this.messagesEl) return;
        this.resetReveal();
        this.messagesEl.replaceChildren();

        const greeting = this.greeting;
        if (this.messages.length === 0 && greeting) {
            this.messagesEl.appendChild(this.buildRow('assistant', this.greetingBubble(greeting)));
        }

        // Starter-prompt chips: shown until the visitor sends their first message.
        if (!this.hasSent && this.messages.length === 0 && this.examplePrompts.length > 0) {
            const chips = document.createElement('div');
            chips.className = 'prompts';
            for (const prompt of this.examplePrompts) {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'chip';
                chip.textContent = prompt;
                chip.addEventListener('click', () => this.submitPrompt(prompt));
                chips.appendChild(chip);
            }
            this.messagesEl.appendChild(chips);
        }

        for (const msg of this.messages) {
            const bubble = document.createElement('div');
            bubble.className = `bubble ${msg.role}`;
            if (msg.role === 'assistant' && msg.streaming && !msg.text) {
                // No text yet → animated typing indicator.
                bubble.classList.add('typing');
                bubble.append(this.typingDot(), this.typingDot(), this.typingDot());
            } else if (msg.streaming) {
                // Mid-stream: partial/unclosed markdown renders ugly (half-open
                // `**`, dangling `[`), so keep plain text + the blinking cursor.
                // The text is revealed gradually by the rAF typewriter; seed the
                // bubble with whatever is already displayed and bind the reveal.
                bubble.classList.add('cursor');
                this.bindReveal(msg, bubble);
            } else if (msg.role === 'assistant') {
                // Final assistant turn → render the sanitized markdown subset.
                // `renderMarkdown` escapes all text, drops images, gates links to
                // http(s), and only emits an allowlisted set of tags, so this
                // `innerHTML` cannot inject markup (see markdown.ts).
                bubble.classList.add('md');
                bubble.innerHTML = renderMarkdown(msg.text);
            } else {
                // User bubbles stay plain text.
                bubble.textContent = msg.text;
            }
            this.messagesEl.appendChild(this.buildRow(msg.role, bubble));

            // Render a "Sources (N)" section under any assistant message whose
            // terminal eventual_response carried citations.
            if (msg.role === 'assistant' && !msg.streaming && msg.citations && msg.citations.length > 0) {
                this.messagesEl.appendChild(this.renderSources(msg.citations));
            }
        }
        this.scrollToBottom(true);
        this.renderSuggestions();
    }

    /**
     * Render (or clear) the mid-conversation suggested-reply chips under the
     * composer. Shown ONLY when: the feature is enabled, no interrupt / restore
     * overlay is active (those reuse the slot above the composer), and the LATEST
     * message is a finalized assistant turn that carried suggestions. A new turn
     * (agent or the visitor typing) appends messages, so the latest is no longer
     * that assistant message and the chips clear on the next render. Chips reuse
     * the empty-state `.prompts`/`.chip` styling and send via the same path.
     */
    private renderSuggestions(): void {
        const el = this.suggestionsEl;
        if (!el) return;
        el.replaceChildren();
        if (!this.showSuggestedReplies) return;
        // Hidden while an OTP / tool-confirmation / restore overlay is active.
        if (this.interrupt || this.identityRestore.phase !== 'idle') return;
        const last = this.messages[this.messages.length - 1];
        if (!last || last.role !== 'assistant' || last.streaming || !last.suggestions || last.suggestions.length === 0) return;

        const chips = document.createElement('div');
        chips.className = 'prompts';
        for (const suggestion of last.suggestions) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'chip';
            chip.textContent = suggestion;
            chip.addEventListener('click', () => this.submitPrompt(suggestion));
            chips.appendChild(chip);
        }
        el.appendChild(chips);
    }

    // ─────────────────────── Smooth streaming reveal ───────────────────────────

    /** True when the host/user prefers reduced motion (snap, no typewriter). */
    private prefersReducedMotion(): boolean {
        return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    /**
     * Bind the rAF typewriter to a freshly built streaming bubble. Preserves the
     * already-revealed prefix across rebuilds (so a structural rebuild mid-stream
     * doesn't restart the reveal from zero), then resumes the loop.
     */
    private bindReveal(msg: ChatMessage, bubble: HTMLElement): void {
        const carryOver = msg.id === this.streamMsgId ? Math.min(this.displayedLength, msg.text.length) : 0;
        this.streamBubbleEl = bubble;
        this.streamMsgId = msg.id;
        this.streamTarget = msg.text;
        this.displayedLength = carryOver;

        if (this.prefersReducedMotion()) {
            // No animation: show everything immediately.
            this.displayedLength = msg.text.length;
            bubble.textContent = msg.text;
            return;
        }
        bubble.textContent = msg.text.slice(0, this.displayedLength);
        this.ensureRevealLoop();
    }

    /** Start the rAF loop if it isn't already running. */
    private ensureRevealLoop(): void {
        if (this.prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
            // No animation (reduced-motion or no rAF): snap to the full buffer.
            this.snapReveal();
            return;
        }
        if (this.rafId) return; // already running
        this.rafId = requestAnimationFrame(() => this.tickReveal());
    }

    /**
     * One animation frame of the reveal. Advances `displayedLength` toward the
     * buffered target at an ADAPTIVE rate — the deeper the backlog, the more
     * chars per frame — so the reveal stays smooth yet never falls behind the
     * network. Updates ONLY the bound bubble's textContent (no list rebuild).
     */
    private tickReveal(): void {
        this.rafId = 0;
        const bubble = this.streamBubbleEl;
        if (!bubble) return;

        const target = this.streamTarget;
        const remaining = target.length - this.displayedLength;

        if (remaining <= 0) {
            // Caught up to everything buffered so far → idle. A later token bump
            // (handleMessages → ensureRevealLoop) restarts the loop; the finalize
            // structural rebuild snaps to the full markdown render.
            return;
        }

        // Adaptive speed: ~1/8 of the backlog per frame (≈ catch up over a few
        // frames), clamped to a readable floor so short bursts still animate and
        // an aggressive ceiling so a deep buffer drains fast. At ~60fps this
        // comfortably outruns the wire — the reveal is steady, never bursty.
        const step = Math.max(2, Math.min(remaining, Math.ceil(remaining / 8)));
        this.displayedLength = Math.min(target.length, this.displayedLength + step);
        bubble.textContent = target.slice(0, this.displayedLength);
        this.scrollToBottom(false);

        this.rafId = requestAnimationFrame(() => this.tickReveal());
    }

    /** Snap the bound bubble to the full buffered text immediately (reduced-motion / no-rAF). */
    private snapReveal(): void {
        if (this.streamBubbleEl) {
            this.displayedLength = this.streamTarget.length;
            this.streamBubbleEl.textContent = this.streamTarget;
        }
    }

    /**
     * Full-page sizing probe: decide whether the host's container gives it a
     * real box. With the `.wrap` flex chain hidden, `height: 100%` of a SIZED
     * container still resolves (clientHeight > 0), while an auto-height parent
     * (e.g. mounted straight into `<body>`) collapses to ~0. Only the latter
     * gets `data-viewport-fallback`, whose CSS applies `min-height: 100dvh` —
     * so an embed inside a fixed-height box never overflows it (the composer
     * stays visible), and a bare full-page route still fills the viewport.
     */
    private syncViewportFallback(): void {
        const wrap = this.shadowRoot?.querySelector<HTMLElement>('.wrap');
        if (!wrap) return;
        const prev = wrap.style.display;
        wrap.style.display = 'none';
        const heightless = this.clientHeight < 8;
        wrap.style.display = prev;
        this.toggleAttribute('data-viewport-fallback', heightless);
    }

    /** Cancel any in-flight reveal loop and clear its state (called on full rebuild). */
    private resetReveal(): void {
        if (this.rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.rafId);
        this.rafId = 0;
        this.streamBubbleEl = null;
        // streamMsgId/displayedLength are intentionally kept so bindReveal can
        // carry the revealed prefix across a structural rebuild of the same msg;
        // they're reset when a different message binds.
    }

    /**
     * Auto-scroll the message list to the bottom — but don't fight a visitor who
     * has scrolled up to read history. When `force` (a structural rebuild) we
     * always pin to bottom; during the streaming reveal we only follow if the
     * viewport is already near the bottom.
     */
    private scrollToBottom(force: boolean): void {
        const el = this.messagesEl;
        if (!el) return;
        if (force) {
            el.scrollTop = el.scrollHeight;
            return;
        }
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (nearBottom) el.scrollTop = el.scrollHeight;
    }

    /** Wrap a bubble in a `.row`, prefixing assistant rows with a mini avatar. */
    private buildRow(role: 'user' | 'assistant', bubble: HTMLElement): HTMLElement {
        const row = document.createElement('div');
        row.className = `row ${role}`;
        if (role === 'assistant') {
            const mini = document.createElement('div');
            mini.className = 'mini';
            mini.innerHTML = ICON.bot; // static, trusted
            row.appendChild(mini);
        }
        row.appendChild(bubble);
        return row;
    }

    private greetingBubble(greeting: string): HTMLElement {
        const b = document.createElement('div');
        b.className = 'bubble assistant greeting';
        b.textContent = greeting;
        return b;
    }

    private typingDot(): HTMLElement {
        return document.createElement('i');
    }

    /**
     * Build the collapsible "Sources (N)" block for an assistant message's
     * citations. Title/snippet are set via `textContent` (never innerHTML) so
     * citation text can't inject markup; only the static chevron + numeric count
     * use innerHTML.
     */
    private renderSources(citations: Citation[]): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'sources';
        wrap.setAttribute('part', 'sources');

        const details = document.createElement('details');
        details.open = true;

        const summary = document.createElement('summary');
        const chev = document.createElement('span');
        chev.className = 'chev';
        chev.innerHTML = ICON.chev; // static, trusted
        const label = document.createElement('span');
        label.textContent = 'Sources';
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = String(citations.length);
        summary.append(chev, label, count);
        details.appendChild(summary);

        const list = document.createElement('ol');
        for (const c of citations) {
            const li = document.createElement('li');

            let titleEl: HTMLElement;
            // SECURITY: only absolute http(s) URLs may become a link href. A
            // citation URL comes from indexed content (web/GitHub connectors), so
            // an attacker-influenceable doc could carry `javascript:`/`data:`/
            // `vbscript:` — assigning those to `a.href` is a one-click XSS. Anything
            // that isn't a valid absolute http(s) URL renders as plain text.
            const safeUrl = safeHttpUrl(c.url);
            if (safeUrl) {
                const a = document.createElement('a');
                a.className = 'src-title';
                a.href = safeUrl;
                a.target = '_blank';
                a.rel = 'noopener noreferrer nofollow';
                titleEl = a;
            } else {
                titleEl = document.createElement('span');
                titleEl.className = 'src-title';
            }
            titleEl.textContent = c.title || c.id || 'Source';
            li.appendChild(titleEl);

            if (c.snippet) {
                // The snippet is the raw scraped chunk — often led by page
                // boilerplate (logo link, nav, whitespace). Trim it to a clean
                // excerpt, then render the sanitized markdown subset. Both steps
                // escape text + drop images/unsafe links (see markdown.ts), so
                // this `innerHTML` is safe.
                const cleaned = cleanCitationSnippet(c.snippet);
                if (cleaned) {
                    const snip = document.createElement('span');
                    snip.className = 'src-snippet md';
                    snip.innerHTML = renderMarkdown(cleaned);
                    li.appendChild(snip);
                }
            }
            list.appendChild(li);
        }
        details.appendChild(list);
        wrap.appendChild(details);
        return wrap;
    }

    private renderStatus(): void {
        const label: Record<ConnectionStatus, string> = {
            idle: '',
            connecting: 'Connecting…',
            ready: 'Online',
            error: 'Connection issue',
            closed: 'Disconnected',
        };
        if (this.statusEl) this.statusEl.textContent = label[this.status];
        if (this.dotEl) {
            // ready → green (no modifier); connecting → amber; error → red; else grey.
            const mod = this.status === 'ready' ? '' : this.status === 'connecting' ? ' connecting' : this.status === 'error' ? ' error' : ' off';
            this.dotEl.className = `dot${mod}`;
        }
    }

    private renderComposerState(): void {
        const busy = this.status === 'connecting';
        if (this.sendBtn) this.sendBtn.disabled = busy;
        if (this.inputEl) this.inputEl.disabled = busy;
    }

    private submit(): void {
        if (!this.inputEl || !this.controller) return;
        const text = this.inputEl.value;
        if (!text.trim()) return;
        this.inputEl.value = '';
        this.hasSent = true;
        this.autosize();
        void this.controller.send(text);
    }
}

/** Register the custom element once. Safe to call multiple times. */
export function defineChatWidget(): void {
    if (typeof customElements !== 'undefined' && !customElements.get(ELEMENT_TAG)) {
        customElements.define(ELEMENT_TAG, SmoothAgentChatElement);
    }
}

/**
 * Programmatically create, configure, and append a widget to the page.
 * Returns the element so the host can drive `openChat()` / `closeChat()`.
 */
export function mountChatWidget(config: ChatWidgetConfig, target: HTMLElement = document.body): SmoothAgentChatElement {
    defineChatWidget();
    const el = document.createElement(ELEMENT_TAG) as SmoothAgentChatElement;
    el.configure(config);
    target.appendChild(el);
    return el;
}

/**
 * Ergonomic helper for the full-page layout: mounts a `<smooth-agent-chat>` in
 * `mode: "fullpage"` (no launcher — the chat fills its container/viewport with a
 * Smooth-branded header, a scrollable message list, and an input bar) and
 * returns the element.
 *
 * `target` defaults to `document.body`; pass a sized container to embed the
 * full-page chat inside a layout region (e.g. a `/chat` route shell or an
 * iframe). The `mode` is forced to `"fullpage"` regardless of the passed config.
 *
 * ```ts
 * mountFullPageChat({ endpoint: 'wss://…/ws', agentId: '…', agentName: 'Support' });
 * ```
 */
export function mountFullPageChat(config: Omit<ChatWidgetConfig, 'mode'>, target: HTMLElement = document.body): SmoothAgentChatElement {
    return mountChatWidget({ ...config, mode: 'fullpage' }, target);
}
