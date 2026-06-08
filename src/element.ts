/**
 * `<smooth-agent-chat>` — a framework-light embeddable chat web component.
 *
 * Ported (and simplified) from smooai's `@smooai/ui-chat-widget`. The original is a
 * React custom element that mounts the heavyweight `@smooai/ui` ChatWidget and
 * pulls in the whole monorepo (Tailwind, shadcn, react-phone-number-input, MSW,
 * Supabase auth …). This is a clean, dependency-light rewrite that preserves the
 * embedding model — a custom element with a launcher + popover panel, declarative
 * HTML attributes, and a programmatic API — while talking to the
 * `@smooai/smooth-operator` protocol client instead of `@smooai/realtime`.
 *
 * Embedding model:
 *   <smooth-agent-chat endpoint="ws://localhost:8787/ws" agent-id="…"></smooth-agent-chat>
 * or programmatically via {@link mountChatWidget}.
 */
import type { ChatWidgetConfig, ChatWidgetTheme } from './config.js';
import { resolveConfig } from './config.js';
import { ConversationController, type ChatMessage, type ConnectionStatus } from './conversation.js';
import { buildStyles } from './styles.js';

export const ELEMENT_TAG = 'smooth-agent-chat';

const OBSERVED = ['endpoint', 'agent-id', 'agent-name', 'placeholder', 'greeting', 'start-open'] as const;

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
        return {
            endpoint,
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

        const style = document.createElement('style');
        style.textContent = buildStyles(resolved.theme);

        const container = document.createElement('div');
        container.innerHTML = `
            <button class="launcher" part="launcher" aria-label="Open chat">💬</button>
            <div class="panel hidden" part="panel" role="dialog" aria-label="${resolved.agentName} chat">
                <div class="header">
                    <div>
                        <div class="title">${escapeHtml(resolved.agentName)}</div>
                        <div class="status"></div>
                    </div>
                    <button class="close" aria-label="Close chat">×</button>
                </div>
                <div class="messages"></div>
                <div class="composer">
                    <textarea rows="1" placeholder="${escapeHtml(resolved.placeholder)}"></textarea>
                    <button class="send" type="button">Send</button>
                </div>
            </div>
        `;

        this.root.replaceChildren(style, container);

        this.launcherEl = container.querySelector('.launcher');
        this.panelEl = container.querySelector('.panel');
        this.messagesEl = container.querySelector('.messages');
        this.statusEl = container.querySelector('.status');
        this.inputEl = container.querySelector('textarea');
        this.sendBtn = container.querySelector('.send');

        this.launcherEl?.addEventListener('click', () => this.openChat());
        container.querySelector('.close')?.addEventListener('click', () => this.closeChat());
        this.sendBtn?.addEventListener('click', () => this.submit());
        this.inputEl?.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) {
                ev.preventDefault();
                this.submit();
            }
        });

        this.syncOpenState();
        this.renderMessages(resolved.greeting);
        this.renderStatus();
        this.renderComposerState();
    }

    private syncOpenState(): void {
        this.panelEl?.classList.toggle('hidden', !this.open);
        this.launcherEl?.classList.toggle('hidden', this.open);
        if (this.open) this.inputEl?.focus();
    }

    private renderMessages(greeting: string): void {
        if (!this.messagesEl) return;
        this.messagesEl.replaceChildren();

        if (this.messages.length === 0 && greeting) {
            const g = document.createElement('div');
            g.className = 'bubble assistant greeting';
            g.textContent = greeting;
            this.messagesEl.appendChild(g);
        }

        for (const msg of this.messages) {
            const el = document.createElement('div');
            el.className = `bubble ${msg.role}`;
            if (msg.streaming && !msg.text) {
                el.classList.add('cursor');
            } else if (msg.streaming) {
                el.classList.add('cursor');
                el.textContent = msg.text;
            } else {
                el.textContent = msg.text;
            }
            this.messagesEl.appendChild(el);
        }
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }

    private renderStatus(): void {
        if (!this.statusEl) return;
        const label: Record<ConnectionStatus, string> = {
            idle: '',
            connecting: 'Connecting…',
            ready: 'Online',
            error: 'Connection issue',
            closed: 'Disconnected',
        };
        this.statusEl.textContent = label[this.status];
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
