# Contributing to @smooai/chat-widget

Thanks for your interest! This is a small, focused package — the embeddable
`<smooth-agent-chat>` web component for the
[smooth-operator](https://github.com/SmooAI/smooth-operator) protocol.

## Setup

```bash
pnpm install
pnpm check     # typecheck + unit tests + build — run this before pushing
```

## Project layout

| Path                 | What it is                                                        |
| -------------------- | ---------------------------------------------------------------- |
| `src/element.ts`     | The custom element — render, DOM wiring, security, public API.   |
| `src/styles.ts`      | The "Aurora Glass" scoped stylesheet (`buildStyles`).            |
| `src/config.ts`      | `ChatWidgetConfig` / `ChatWidgetTheme` + `resolveConfig` defaults.|
| `src/conversation.ts`| `ConversationController` — bridges the UI to the protocol client. |
| `src/standalone.ts`  | IIFE entry: auto-registers the element + exposes `SmoothAgentChat`.|
| `index.html`         | Backend-free interactive showcase (in-page protocol mock).        |
| `e2e/`               | Playwright live e2e (gated on a real server + gateway key).       |

## Ground rules

- **Keep it framework-light.** No runtime UI framework, no CSS framework, no icon
  fonts. The widget must stay tiny and embeddable anywhere.
- **The protocol lives in smooth-operator.** Don't reimplement wire shapes here;
  consume `@smooai/smooth-operator`. UI-only changes belong in this repo.
- **Security:** never assign untrusted strings to `innerHTML` or to a link `href`.
  Message/citation text → `textContent`; citation URLs → `safeHttpUrl` (http/https
  only). There are tests guarding this — keep them green.
- **Theme through tokens.** New colors should be `--sac-*` custom properties driven
  by the theme, not hard-coded, so brand adaptation keeps working.
- **Add a test.** Pure helpers get unit tests; rendered structure gets a jsdom
  smoke test (see `src/*.test.ts`).

## Pull requests

1. Branch, make your change, add/adjust tests.
2. `pnpm check` must pass (CI runs the same).
3. Add a `CHANGELOG.md` entry under the next version.
4. Open the PR with a clear before/after — a screenshot or GIF for visual changes.

## License

By contributing you agree your contributions are licensed under the MIT License.
