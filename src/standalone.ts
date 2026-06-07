/**
 * Standalone IIFE entry. Bundled (with the protocol client inlined) into
 * `dist/chat-widget.global.js` for a plain `<script src="…">` embed.
 *
 * On load it:
 *   - registers the `<smooth-agent-chat>` custom element, and
 *   - exposes the programmatic API on the IIFE global `SmoothAgentChat`
 *     (`window.SmoothAgentChat.mount({ endpoint, agentId })`).
 *
 * A host page can then either drop the element in markup:
 *   <smooth-agent-chat endpoint="wss://…/ws" agent-id="…"></smooth-agent-chat>
 * or mount it programmatically:
 *   SmoothAgentChat.mount({ endpoint: 'wss://…/ws', agentId: '…' });
 */
import type { ChatWidgetConfig } from './config.js';
import { defineChatWidget, mountChatWidget, SmoothAgentChatElement } from './element.js';

defineChatWidget();

export { defineChatWidget, mountChatWidget, SmoothAgentChatElement };

/** Convenience alias matching the global API surface. */
export function mount(config: ChatWidgetConfig, target?: HTMLElement): SmoothAgentChatElement {
    return mountChatWidget(config, target);
}
