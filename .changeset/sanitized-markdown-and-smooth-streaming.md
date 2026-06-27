---
'@smooai/chat-widget': minor
---

Render sanitized Markdown in assistant replies and citation snippets, and smooth out the streaming reveal.

**Sanitized Markdown rendering.** Assistant responses and citation snippets previously showed Markdown literally (`**bold**`, numbered lists, `[links](url)` rendered as raw text). They now render to formatted HTML through a tiny, safe-by-default renderer (`markdown.ts`) that:

- escapes **all** text — raw `<script>`, `<img onerror=…>`, `<iframe>` etc. render as inert text, never markup;
- **drops images entirely** (a scraped tracking pixel can't load) — `![alt](src)` becomes its alt text;
- allows **only `http(s)` links** (`javascript:`/`data:`/relative fall back to plain text) with `target="_blank"` + `rel="noopener noreferrer nofollow"`;
- emits only an allowlisted tag set (`p`, `br`, `strong`, `em`, `ul`/`ol`/`li`, `code`/`pre`, `a`, `blockquote`) and **downgrades headings** to bold lines so they fit a chat bubble.

User bubbles stay plain text; mid-stream text stays plain (partial Markdown renders ugly) and only the final assistant turn is rendered as Markdown. Citation snippets are also cleaned first — leading page boilerplate (logo image/link, nav, whitespace) is trimmed and the excerpt is truncated to ~260 chars at a word boundary.

**Smooth streaming reveal.** The assistant bubble no longer jumps in jerky, uneven chunks as `stream_token` bursts arrive. Incoming token text is buffered and revealed via a `requestAnimationFrame` typewriter at an adaptive rate (chars-per-frame scales with the pending backlog, so it never falls behind the network); only the single streaming bubble is updated per frame (no full list rebuild), and the final turn snaps to the full Markdown render. Respects `prefers-reduced-motion` (snaps instantly) and keeps auto-scroll without fighting a visitor who has scrolled up.
