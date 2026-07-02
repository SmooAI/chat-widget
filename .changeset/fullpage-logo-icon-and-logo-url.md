---
'@smooai/chat-widget': minor
---

Full-page header: square Smooth icon default + customizable `logoUrl`.

**New default icon.** The full-page header avatar previously rendered the full "smooth" wordmark (a wide 550×135 SVG) crammed into the square tile, so it overflowed and looked broken — and it stamped Smoo branding onto customers' pages. It now renders the square Smooth icon (the stylized `th` glyph, `assets/smooth-icon.svg`, 150×150) which sits cleanly `contain`ed and centered in the tile.

**New `logoUrl` config key.** Host pages can now brand the full-page header with their own logo:

```js
mountFullPageChat({ endpoint: 'wss://ai.smoo.ai/ws', agentId: '…', logoUrl: 'https://cdn.acme.com/logo.svg' });
// or declaratively:
// <smooth-agent-chat mode="fullpage" logo-url="https://cdn.acme.com/logo.svg" …></smooth-agent-chat>
```

When set, the header renders `<img class="logo-img">` sized to `contain` within the tile; otherwise it falls back to the Smooth icon. **Security:** `logoUrl` is validated to absolute `http(s)` only (via the existing `safeHttpUrl` guard) — `javascript:`/`data:`/relative URLs are dropped — and escaped into the `src` attribute, so a hostile config can't inject script.
