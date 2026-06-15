import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initChatWidgetLoader } from './loader-core.js';

const MODULE_SRC = 'https://cdn.example/chat-widget.global.js';

type TestWindow = typeof window & {
    SmoothAgentChat?: { mount: ReturnType<typeof vi.fn> };
    SmoothAgentChatConfig?: Record<string, unknown> & { src?: string };
};

function moduleScript(): HTMLScriptElement | null {
    return document.querySelector<HTMLScriptElement>(`script[src="${MODULE_SRC}"]`);
}

describe('initChatWidgetLoader', () => {
    beforeEach(() => {
        document.head.innerHTML = '';
        const w = window as TestWindow;
        delete w.SmoothAgentChat;
        delete w.SmoothAgentChatConfig;
    });

    it('defers module injection until user intent, then mounts with config (src stripped)', () => {
        const w = window as TestWindow;
        w.SmoothAgentChatConfig = { src: MODULE_SRC, endpoint: 'wss://x/ws', agentId: 'agent-1' };
        const mount = vi.fn();
        w.SmoothAgentChat = { mount };

        initChatWidgetLoader();

        // Nothing injected yet — deferred.
        expect(moduleScript()).toBeNull();

        // User intent triggers the load immediately.
        window.dispatchEvent(new Event('pointerdown'));
        const tag = moduleScript();
        expect(tag).not.toBeNull();

        // Module finishes loading → mount called with the config, minus `src`.
        tag?.onload?.(new Event('load'));
        expect(mount).toHaveBeenCalledTimes(1);
        expect(mount).toHaveBeenCalledWith({ endpoint: 'wss://x/ws', agentId: 'agent-1' });
    });

    it('injects the module only once across multiple intent triggers', () => {
        const w = window as TestWindow;
        w.SmoothAgentChatConfig = { src: MODULE_SRC, endpoint: 'wss://x/ws' };
        w.SmoothAgentChat = { mount: vi.fn() };

        initChatWidgetLoader();
        window.dispatchEvent(new Event('pointerdown'));
        window.dispatchEvent(new Event('scroll'));
        window.dispatchEvent(new Event('keydown'));

        expect(document.querySelectorAll(`script[src="${MODULE_SRC}"]`).length).toBe(1);
    });

    it('with no real config (src only), loads the module but does not mount — a markup element upgrades itself', () => {
        const w = window as TestWindow;
        w.SmoothAgentChatConfig = { src: MODULE_SRC };
        const mount = vi.fn();
        w.SmoothAgentChat = { mount };

        initChatWidgetLoader();
        window.dispatchEvent(new Event('pointerdown'));
        const tag = moduleScript();
        expect(tag).not.toBeNull();

        tag?.onload?.(new Event('load'));
        expect(mount).not.toHaveBeenCalled();
    });
});
