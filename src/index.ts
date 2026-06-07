/**
 * @smooai/chat-widget — an embeddable chat widget for the smooth-operator-agent
 * protocol. Framework-light web component that speaks the schema-driven WebSocket
 * protocol via `@smooai/smooth-operator-agent`.
 *
 * ESM library entry. For bundler-based hosts:
 *
 * ```ts
 * import { defineChatWidget, mountChatWidget } from '@smooai/chat-widget';
 *
 * // Declarative: register the element, then drop <smooth-agent-chat …> in markup.
 * defineChatWidget();
 *
 * // Or programmatic:
 * const widget = mountChatWidget({ endpoint: 'wss://…/ws', agentId: '…' });
 * widget.openChat();
 * ```
 *
 * For a plain `<script>` embed, use the standalone IIFE bundle
 * (`dist/chat-widget.global.js`), which auto-registers the element on load.
 */
export {
    SmoothAgentChatElement,
    ELEMENT_TAG,
    defineChatWidget,
    mountChatWidget,
} from './element.js';
export type { ChatWidgetConfig, ChatWidgetTheme } from './config.js';
export {
    ConversationController,
    type ChatMessage,
    type ConnectionStatus,
    type ConversationEvents,
    type Role,
} from './conversation.js';
