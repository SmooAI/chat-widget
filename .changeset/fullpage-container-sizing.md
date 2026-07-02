---
'@smooai/chat-widget': patch
---

Full-page mode now sizes to its **container**, never a hardcoded viewport unit. Previously `:host` and the inner `.panel.fullpage` both pinned `min-height: 100vh`, so `mountFullPageChat` into a fixed-height (`overflow: hidden`) box overflowed it and clipped the composer out of view — visitors saw only the example-prompt chips with no way to type (hit live on chakrabpc.com/transformation-posture). The host now hands its box down through a `.wrap` flex chain (`.panel.fullpage { flex: 1 }`), and a `data-viewport-fallback` attribute — set only when a layout probe finds the container gives the host no resolved height (e.g. mounted straight into an auto-height `<body>`) — restores the `min-height: 100dvh` viewport fill for bare full-page routes. Page-side `::part(panel)` overrides remain compatible.
