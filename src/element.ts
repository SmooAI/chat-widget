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
import type { ChatWidgetConfig, ChatWidgetMode, ChatWidgetTheme } from './config.js';
import { resolveConfig } from './config.js';
import { type ChatMessage, type Citation, type ConnectionStatus, ConversationController } from './conversation.js';
import { SMOOTH_LOGO_SVG } from './logo.js';
import { buildStyles } from './styles.js';

export const ELEMENT_TAG = 'smooth-agent-chat';

const OBSERVED = ['endpoint', 'agent-id', 'agent-name', 'placeholder', 'greeting', 'start-open', 'mode'] as const;

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
} as const;

/**
 * Return `url` only if it is a valid absolute `http(s)` URL, else `null`.
 *
 * SECURITY: citation URLs originate from indexed content (web / GitHub
 * connectors), which can be attacker-influenceable. Assigning an arbitrary
 * string to `<a>.href` allows `javascript:`/`data:`/`vbscript:` URLs that
 * execute on click — a stored-XSS vector. Only http(s) links are rendered as
 * anchors; anything else falls back to plain text.
 */
export function safeHttpUrl(url: string | undefined | null): string | null {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
    } catch {
        return null;
    }
}

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

    // Cached DOM refs (populated in render()).
    private panelEl: HTMLElement | null = null;
    private launcherEl: HTMLElement | null = null;
    private messagesEl: HTMLElement | null = null;
    private statusEl: HTMLElement | null = null;
    private dotEl: HTMLElement | null = null;
    private inputEl: HTMLTextAreaElement | null = null;
    private sendBtn: HTMLButtonElement | null = null;

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
        void this.controller?.connect().catch(() => {});
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
            userName: this.overrides.userName,
            userEmail: this.overrides.userEmail,
            placeholder: this.overrides.placeholder ?? this.getAttribute('placeholder') ?? undefined,
            greeting: this.overrides.greeting ?? this.getAttribute('greeting') ?? undefined,
            connectionErrorMessage: this.overrides.connectionErrorMessage,
            startOpen: this.overrides.startOpen ?? this.hasAttribute('start-open'),
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

        // (Re)create the controller only when there isn't one yet. Attribute churn
        // (e.g. theme tweaks) re-renders the view without dropping the session.
        if (!this.controller) {
            this.controller = new ConversationController(config, {
                onMessages: (messages) => {
                    this.messages = messages;
                    this.renderMessages(resolved.greeting);
                },
                onStatus: (status) => {
                    this.status = status;
                    this.renderStatus();
                    this.renderComposerState();
                },
            });
            if (resolved.startOpen) this.open = true;
        }

        const fullpage = resolved.mode === 'fullpage';
        // Full-page mode is always "open" — it fills its container and has no
        // launcher to toggle.
        if (fullpage) this.open = true;

        const style = document.createElement('style');
        style.textContent = buildStyles(resolved.theme, resolved.mode);

        // Header: in full-page mode lead with the Smooth logo in the avatar tile
        // and a subtle "powered by" tag; in popover mode show a brand-colored
        // monogram avatar + a compact close (collapse) button.
        const monogram = escapeHtml((resolved.agentName.trim().charAt(0) || 'A').toUpperCase());
        const header = fullpage
            ? `<div class="header">
                    <div class="avatar"><span class="logo-wrap">${SMOOTH_LOGO_SVG}</span></div>
                    <div class="meta">
                        <span class="title">${escapeHtml(resolved.agentName)}</span>
                        <span class="status"><span class="dot off"></span><span class="status-text"></span></span>
                    </div>
                    <span class="powered">powered by smooth-operator</span>
                </div>`
            : `<div class="header">
                    <div class="avatar">${monogram}</div>
                    <div class="meta">
                        <span class="title">${escapeHtml(resolved.agentName)}</span>
                        <span class="status"><span class="dot off"></span><span class="status-text"></span></span>
                    </div>
                    <button class="close" aria-label="Close chat">${ICON.close}</button>
                </div>`;

        const container = document.createElement('div');
        container.innerHTML = `
            ${fullpage ? '' : `<button class="launcher" part="launcher" aria-label="Open chat">${ICON.spark}</button>`}
            <div class="panel${fullpage ? ' fullpage' : ' hidden'}" part="panel" role="${fullpage ? 'region' : 'dialog'}" aria-label="${escapeHtml(resolved.agentName)} chat">
                ${header}
                <div class="header-sep"></div>
                <div class="messages"></div>
                <div class="composer-wrap">
                    <div class="composer">
                        <textarea rows="1" placeholder="${escapeHtml(resolved.placeholder)}"></textarea>
                        <button class="send" type="button" aria-label="Send message">${ICON.send}</button>
                    </div>
                    <div class="footer">powered by <b>smooth&#8209;operator</b></div>
                </div>
            </div>
        `;

        // Tag the logo <svg> so styles can size it (the inlined SVG has its own id).
        const logoSvg = container.querySelector('.logo-wrap svg');
        if (logoSvg) logoSvg.setAttribute('class', 'logo');

        this.root.replaceChildren(style, container);

        this.launcherEl = container.querySelector('.launcher');
        this.panelEl = container.querySelector('.panel');
        this.messagesEl = container.querySelector('.messages');
        this.statusEl = container.querySelector('.status-text');
        this.dotEl = container.querySelector('.dot');
        this.inputEl = container.querySelector('textarea');
        this.sendBtn = container.querySelector('.send');

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

        // Full-page mode connects eagerly (there's no launcher click to trigger it).
        if (fullpage) void this.controller?.connect().catch(() => {});

        this.syncOpenState();
        this.renderMessages(resolved.greeting);
        this.renderStatus();
        this.renderComposerState();
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

    private renderMessages(greeting: string): void {
        if (!this.messagesEl) return;
        this.messagesEl.replaceChildren();

        if (this.messages.length === 0 && greeting) {
            this.messagesEl.appendChild(this.buildRow('assistant', this.greetingBubble(greeting)));
        }

        for (const msg of this.messages) {
            const bubble = document.createElement('div');
            bubble.className = `bubble ${msg.role}`;
            if (msg.role === 'assistant' && msg.streaming && !msg.text) {
                // No text yet → animated typing indicator.
                bubble.classList.add('typing');
                bubble.append(this.typingDot(), this.typingDot(), this.typingDot());
            } else if (msg.streaming) {
                bubble.classList.add('cursor');
                bubble.textContent = msg.text;
            } else {
                bubble.textContent = msg.text;
            }
            this.messagesEl.appendChild(this.buildRow(msg.role, bubble));

            // Render a "Sources (N)" section under any assistant message whose
            // terminal eventual_response carried citations.
            if (msg.role === 'assistant' && !msg.streaming && msg.citations && msg.citations.length > 0) {
                this.messagesEl.appendChild(this.renderSources(msg.citations));
            }
        }
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
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
                a.rel = 'noopener noreferrer';
                titleEl = a;
            } else {
                titleEl = document.createElement('span');
                titleEl.className = 'src-title';
            }
            titleEl.textContent = c.title || c.id || 'Source';
            li.appendChild(titleEl);

            if (c.snippet) {
                const snip = document.createElement('span');
                snip.className = 'src-snippet';
                snip.textContent = c.snippet;
                li.appendChild(snip);
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
        this.autosize();
        void this.controller.send(text);
    }
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => {
        switch (c) {
            case '&':
                return '&amp;';
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '"':
                return '&quot;';
            default:
                return '&#39;';
        }
    });
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
