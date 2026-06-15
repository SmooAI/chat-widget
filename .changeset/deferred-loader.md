---
'@smooai/chat-widget': minor
---

Add a tiny deferred **loader** entry (`@smooai/chat-widget/loader`, ~2 KB gzipped) as the recommended embed, so the widget never competes with the host page's LCP/TBT. Included eagerly, it defers injecting the full `chat-widget.global.js` module until the page is past its critical render — `requestIdleCallback` after `load`, the visitor's first pointer/keydown/scroll, or an 8 s fallback — then registers `<smooth-agent-chat>` and mounts with the host config. Config comes from `window.SmoothAgentChatConfig` (or `data-*` attributes on the loader tag); the module URL resolves as a sibling of the loader script (`data-src` override). Also exported from the ESM entry as `initChatWidgetLoader()` for bundler hosts. The eager `<script src="chat-widget.global.js">` embed still works and is documented as the simpler alternative.
