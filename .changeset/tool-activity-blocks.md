---
'@smooai/chat-widget': minor
---

Add an opt-in `showToolActivity` option that renders the agent's tool activity (grep / read_file / bash / knowledge_search…) as inline chips interleaved with its prose, mirroring the smooth daemon SPA's `blocks` model.

- Defaults to **`false`** — a customer-facing support widget stays byte-for-byte unchanged (prose bubble only). Enable via the `show-tool-activity` HTML attribute or `showToolActivity: true` in the config.
- When enabled, an assistant turn that invokes a tool renders as an ordered strip of prose bubbles + tool chips (running… / done ✓ / error), in the order the model produced them. Tool activity is read from `state.rawResponse.toolCall` / `state.rawResponse.toolResult` (the correct nested path — reading `state.toolResult` leaves chips stuck "running…").
- Tool name/args are rendered via `textContent` (never `innerHTML`), so a tool payload can't inject markup. New public `MessageBlock` / `ToolCall` types.
