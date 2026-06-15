/**
 * Tiny, dependency-free deferred loader for `@smooai/chat-widget`.
 *
 * The recommended embed: a host includes this *small* script eagerly, and it
 * defers injecting the real (heavier) `chat-widget.global.js` module until the
 * page is past its critical render — so the widget never competes with the host
 * page's LCP/TBT. It triggers the real load on the **first** of:
 *
 *   - `window` `load` → `requestIdleCallback` (idle time), or
 *   - user intent (`pointerdown` / `keydown` / `scroll`), or
 *   - an 8s fallback.
 *
 * After the module loads (which registers `<smooth-agent-chat>` and exposes
 * `window.SmoothAgentChat`), it mounts the widget with the host's config.
 *
 * Deliberately imports nothing from the widget itself — this file must stay a
 * few hundred bytes so including it eagerly is free.
 *
 * ## Config
 * Set a global before/with the loader (any `ChatWidgetConfig`, plus an optional
 * `src` pointing at the module bundle):
 *
 * ```html
 * <script>window.SmoothAgentChatConfig = { endpoint: 'wss://…/ws', agentId: '…' };</script>
 * <script src="https://cdn/…/chat-widget-loader.global.js" async></script>
 * ```
 *
 * Or, for the simplest installs, `data-*` attributes on the loader's own tag
 * (`data-endpoint`, `data-agent-id`, `data-primary`, `data-mode`, `data-src`).
 * If no config is found, the module is still loaded (registering the element) so
 * a `<smooth-agent-chat …>` placed directly in markup upgrades itself.
 */

/** Must match `ELEMENT_TAG` in `element.ts`; inlined to avoid importing it. */
const ELEMENT_TAG = 'smooth-agent-chat';
/** Default module filename, resolved as a sibling of the loader script. */
const DEFAULT_MODULE = 'chat-widget.global.js';

type MountFn = (config: Record<string, unknown>, target?: HTMLElement) => unknown;

interface LoaderWindow extends Window {
    SmoothAgentChat?: { mount: MountFn };
    SmoothAgentChatConfig?: Record<string, unknown> & { src?: string };
}

/**
 * Resolve the module URL: explicit `src` (config or `data-src`) wins, else a
 * sibling of the loader script, else the bare default filename.
 */
function resolveModuleSrc(win: LoaderWindow, script: HTMLScriptElement | null): string {
    const fromConfig = win.SmoothAgentChatConfig?.src;
    if (fromConfig) return fromConfig;
    const fromAttr = script?.getAttribute('data-src');
    if (fromAttr) return fromAttr;
    const selfSrc = script?.src;
    if (selfSrc) return selfSrc.replace(/[^/]*$/, DEFAULT_MODULE);
    return DEFAULT_MODULE;
}

/**
 * The widget mount config: the `SmoothAgentChatConfig` global (minus the
 * loader-only `src`), or `data-*` attributes. `undefined` ⇒ no programmatic
 * mount (a markup element will upgrade itself once the module registers it).
 */
function resolveMountConfig(win: LoaderWindow, script: HTMLScriptElement | null): Record<string, unknown> | undefined {
    if (win.SmoothAgentChatConfig) {
        const { src: _src, ...config } = win.SmoothAgentChatConfig;
        // Only `src` (no real fields) ⇒ no programmatic mount; a markup element
        // upgrades itself once the module registers it.
        return Object.keys(config).length > 0 ? config : undefined;
    }
    if (!script) return undefined;
    const endpoint = script.getAttribute('data-endpoint');
    const agentId = script.getAttribute('data-agent-id');
    if (!endpoint && !agentId) return undefined;
    const config: Record<string, unknown> = {};
    if (endpoint) config.endpoint = endpoint;
    if (agentId) config.agentId = agentId;
    const primary = script.getAttribute('data-primary');
    if (primary) config.theme = { primary };
    const mode = script.getAttribute('data-mode');
    if (mode) config.mode = mode;
    return config;
}

/**
 * Install the deferred loader. Idempotent per call; the IIFE entry
 * (`loader.ts`) invokes it once on script execution.
 */
export function initChatWidgetLoader(): void {
    const win = window as LoaderWindow;
    const script = (document.currentScript as HTMLScriptElement | null) ?? null;
    const moduleSrc = resolveModuleSrc(win, script);

    let loaded = false;
    let idleId: number | undefined;
    let fallbackId: number | undefined;

    function mountWhenReady(): void {
        const config = resolveMountConfig(win, script);
        if (!config) return; // markup element upgrades itself; nothing to mount
        const apply = () => {
            try {
                win.SmoothAgentChat?.mount(config);
            } catch (error) {
                console.error('[chat-widget loader] mount failed', error);
            }
        };
        if (win.SmoothAgentChat) {
            apply();
        } else if (window.customElements?.whenDefined) {
            window.customElements.whenDefined(ELEMENT_TAG).then(apply, apply);
        } else {
            apply();
        }
    }

    function teardown(): void {
        if (idleId !== undefined) {
            // The id is either an idle handle or (fallback path) a timeout id;
            // both cancels are no-ops on the wrong kind, so calling both is safe.
            window.cancelIdleCallback?.(idleId);
            window.clearTimeout(idleId);
        }
        if (fallbackId !== undefined) window.clearTimeout(fallbackId);
        window.removeEventListener('pointerdown', load);
        window.removeEventListener('keydown', load);
        window.removeEventListener('scroll', load);
    }

    function load(): void {
        if (loaded) return;
        loaded = true;
        teardown();
        const tag = document.createElement('script');
        tag.src = moduleSrc;
        tag.onload = mountWhenReady;
        tag.onerror = () => console.error('[chat-widget loader] failed to load', moduleSrc);
        document.head.appendChild(tag);
    }

    function schedule(): void {
        if (window.requestIdleCallback) {
            idleId = window.requestIdleCallback(() => load(), { timeout: 5000 });
        } else {
            idleId = window.setTimeout(load, 2500) as unknown as number;
        }
        fallbackId = window.setTimeout(load, 8000) as unknown as number;
    }

    // User intent loads immediately (they're about to want the widget).
    window.addEventListener('pointerdown', load, { once: true, passive: true });
    window.addEventListener('keydown', load, { once: true });
    window.addEventListener('scroll', load, { once: true, passive: true });

    if (document.readyState === 'complete') {
        schedule();
    } else {
        window.addEventListener('load', schedule, { once: true });
    }
}
