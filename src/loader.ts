/**
 * Standalone IIFE entry for the **deferred loader** — built to
 * `dist/chat-widget-loader.global.js`.
 *
 * This is the recommended embed: include it eagerly (it's tiny) and it lazily
 * injects the real `chat-widget.global.js` module only once the host page is
 * past its critical render (idle / user intent / 8s fallback), so the widget
 * never competes with the host's LCP/TBT. See {@link initChatWidgetLoader}.
 *
 * ```html
 * <script>window.SmoothAgentChatConfig = { endpoint: 'wss://…/ws', agentId: '…' };</script>
 * <script src="https://cdn/…/chat-widget-loader.global.js" async></script>
 * ```
 */
import { initChatWidgetLoader } from './loader-core.js';

initChatWidgetLoader();
