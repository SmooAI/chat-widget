# Changelog

## 0.5.1

### Patch Changes

- 00ca492: Bump `@smooai/smooth-operator` to `^1.8.0` to restore chat against the deployed smooth-operator 1.8.0.

  The widget bundled the `^0.2.0` protocol client, which threw while iterating the 1.8.0 turn stream — the newer wire frames (`immediate_response` status 202, `stream_token`, terminal `eventual_response` with `data.data.citations`) were unrecognized by the old client, so every `send_message` surfaced "We couldn't reach the chat." even though the operator was streaming a correct grounded response. The 1.8.0 client understands those frames; the `ConversationController` extraction logic (stream-token accumulation, `final.data.data.{response,citations}`, OTP + tool-confirmation HITL handling) already matched the 1.8.0 protocol and needed no changes. Live-verified a full streaming turn (12 tokens + 1 citation) against the prod operator at `wss://ai.smoo.ai/ws`.

## 0.5.0

### Minor Changes

- 2095d4c: Add a tiny deferred **loader** entry (`@smooai/chat-widget/loader`, ~2 KB gzipped) as the recommended embed, so the widget never competes with the host page's LCP/TBT. Included eagerly, it defers injecting the full `chat-widget.global.js` module until the page is past its critical render — `requestIdleCallback` after `load`, the visitor's first pointer/keydown/scroll, or an 8 s fallback — then registers `<smooth-agent-chat>` and mounts with the host config. Config comes from `window.SmoothAgentChatConfig` (or `data-*` attributes on the loader tag); the module URL resolves as a sibling of the loader script (`data-src` override). Also exported from the ESM entry as `initChatWidgetLoader()` for bundler hosts. The eager `<script src="chat-widget.global.js">` embed still works and is documented as the simpler alternative.

## 0.4.0

### Minor Changes

- 3204137: OTP and tool-confirmation (HITL) **dialog UI**: when a turn pauses for OTP
  verification or a tool-write approval, the widget now shows an inline overlay
  above the composer — an OTP code prompt (with masked destination + retry/error
  state) or an Approve/Decline confirmation — wired to `verifyOtp`/`confirmTool`.
  Completes the OTP/HITL parity whose protocol plumbing shipped in 0.3.0.

All notable changes to `@smooai/chat-widget` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.0

Feature-parity pass toward retiring the legacy `@smooai/ui-chat-widget`.

### Added

- **Starter prompts** — `examplePrompts` renders clickable chips in the empty
  state; tapping one sends it. Capped at 5.
- **Pre-chat identity form** — `requireName` / `requireEmail` / `requirePhone`
  gate the conversation behind a styled form (skipped when `allowAnonymous`).
  Collected name/email flow into the session; phone rides session `metadata`.
- **Full theming parity** — the theme now accepts the agent dashboard's 10-color
  model: `secondary` plus `chatBubbleInbound` / `chatBubbleInboundText` /
  `chatBubbleOutbound` / `chatBubbleOutboundText` aliases (they win over the
  canonical keys), so a config exported from the dashboard themes the widget
  directly.
- **OTP + tool-confirmation (HITL) support** in `ConversationController`: it now
  surfaces `otp_verification_required` / `otp_sent` / `otp_verified` /
  `otp_invalid` and `write_confirmation_required` as an `onInterrupt` event, with
  `verifyOtp(code)` / `confirmTool(approved)` to resume the paused turn.
  (Built-in dialog UI for these lands next; the protocol plumbing is in place.)
- npm publishing wired via changesets (`release.yml`).

### Not included

- **Voice** is intentionally absent — the smooth-operator protocol has no audio
  surface yet, so voice parity is blocked on a backend/protocol feature.

## 0.2.0

The widget is back as a standalone package — and got a complete visual redesign.

### Added

- **"Aurora Glass" design system** — a full rebuild of the widget's visual layer:
  - Spring launcher with a live "presence pulse" breathing ring and a crafted
    chat-spark icon (no more emoji).
  - Glass-depth panel with layered ambient shadows, a brand-tinted top glow, and
    a spring entrance animation.
  - Header with a gradient brand avatar (agent monogram), a live connection
    status dot (green online / amber connecting / red error), and an icon close.
  - Message rows with assistant mini-avatars, a real animated **typing
    indicator**, message rise-in, and a refined streaming cursor.
  - Refined **Sources** disclosure with a count pill and accent cards.
  - Icon composer: a focus-lit field with a circular gradient send button,
    auto-growing textarea, and a "powered by smooth-operator" footer.
- **Derived theme tokens** — `primary-2` (gradient depth) and `surface-2` (inset
  wash) are computed in CSS from `primary`/`text`, so a single `primary` color
  themes the whole widget and adapts to light or dark automatically.
- Unit + render test suite (vitest + jsdom) covering config resolution, style
  injection, the XSS-safe citation URL guard, and the rendered shadow tree.
- GitHub Actions CI (typecheck · test · build) and a backend-free interactive
  showcase (`index.html`) driven by an in-page protocol mock.

### Changed

- Default `theme.border` is now a translucent value (`rgba(255,255,255,.1)`) for
  the glass aesthetic.
- Depends on `@smooai/smooth-operator@^0.2.0`.

### Notes

This release reverses the brief deprecation in which the widget shipped only as a
subpath of `@smooai/smooth-operator`. The widget is once again its own package,
consuming `@smooai/smooth-operator` purely for the protocol client — one source of
truth for the wire protocol, one dedicated home for the embeddable UI.
