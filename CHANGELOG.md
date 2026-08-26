# Changelog

## 0.16.5

### Patch Changes

- eb336f4: Fix a returning visitor with a dead session pointer getting a brand-new conversation (SMOODEV-3057)

  `connect()` probed `/internal/resume-by-fingerprint` only when there was NO
  persisted `sessionId`. A persisted-but-dead pointer cleared itself and went
  straight to `create_conversation_session`, skipping the probe — so a visitor
  whose stored session had ended minted a fresh conversation even when a resumable
  one existed, and one visitor showed up as several inbox rows. The dead-pointer
  path now falls through to the same probe.

  Also makes the probe legible. It swallowed every failure in a bare `catch {}`
  and `{ resumable: false }` carried no reason, so "no prior visit", "blocked by
  the CRM link", "session ended" and "the lookup 500'd" were indistinguishable —
  which is why this went undiagnosed. The probe now always yields a reason (the
  server's when the response carries one, a derived label when it does not),
  logs it at `console.debug`, and exposes it as
  `ConversationController.lastResumeReason`. Failures stay non-fatal: a resume
  probe still never breaks `connect()`.

  Dead-session recovery (`send()` → `recreateSession()`) now runs the same probe
  before minting. A session id the pod's registry has lost is often still alive in
  storage, and the wrapper reads storage — so the visitor's conversation is
  recovered instead of splitting in two mid-chat. Bounded as before: `send()`
  retries this path exactly once.

  Every `create_conversation_session` now carries a `resumeDiagnostics` block in
  its metadata — `storage` (durable/memory), `pointer` (none/dead/recovery) and
  `probe` (the resume reason). `metadata_json` is persisted on the session row, so
  the next duplicate pair can be explained from Postgres rather than from a
  browser console nobody was watching. `storage: 'memory'` is the notable one: a
  sandboxed iframe or privacy mode silently drops the widget to an in-memory
  store, so it cannot recognise its own previous visit and every page load starts
  from scratch.

## 0.16.4

### Patch Changes

- f1048ba: Fix: the widget could report "Online" and then fail every send

  A visitor on smoo.ai completed the pre-chat form, saw the status go "Online", and then got "We couldn't reach the chat." on every turn while the backend was entirely healthy. Three defects, all on the connect path:

  - `connect()` early-returned while a connect was in flight. The guard was right — one connect, not two — but it returned an already-resolved promise, so every `await connect()` resolved _before_ a session existed and `send()` fell through to its "not connected" throw. Four of the six call sites are fire-and-forget `void connect()` (launcher click, pre-chat submit, full-page mount, voice hand-off), so an awaiting caller racing an in-flight one is the normal case, not an edge. Concurrent callers now share one connect and each `await` resolves when that connect finishes.
  - A `create_conversation_session` that resolved without a session id was accepted, assigning `undefined` and still flipping the status to `ready`. That is a permanent wedge: every later send hits the missing id, calls `connect()`, is early-returned by the `ready` status, and throws again. It now fails honestly and retryably.
  - `tryResume()` read the session snapshot's `status` outside its `try`/`catch`. The operator client returns an `immediate_response`'s `data` without checking its status, so an error-status reply carrying no `data` resolves as `undefined` rather than rejecting — and the property read threw a `TypeError` past the catch and out of `connect()`.

  Also hardened: `send()` now renders the one human error sentence when a connect is genuinely fatal, instead of rejecting out of `send()` — which dropped the visitor's typed text into an empty transcript and raised an unhandled rejection on the host page. A failure reaching the optional resume probe is recoverable by starting a fresh session; a failure reaching the transport itself stays fatal.

## 0.16.3

### Patch Changes

- f3e48d8: Never render a raw backend error as agent dialogue, and recover from a dead session.

  A visitor on a live marketing site was shown `Error: session '<uuid>' not found`
  in what looks like an agent chat bubble: `send()`'s catch rendered
  `ProtocolError.message` verbatim. That was the only seam where an error frame
  could reach the transcript; every failure now renders one short human sentence
  (`connectionErrorMessage`), with the machine detail going to the connection-status
  channel instead.

  The turn also had no recovery once the session died mid-conversation — the widget
  wedged and every retry re-sent into the same dead session. A `SESSION_NOT_FOUND`
  on send now clears the stale pointer (dropping any OTP proof bound to it),
  creates a fresh session on the same socket, and re-sends the turn once, so the
  visitor's message still gets answered. Matched on the protocol `code` and on that
  code alone: `STORAGE_ERROR`, `INTERNAL_ERROR`, auth and rate-limit failures leave
  the live session and its history intact.

## 0.16.2

### Patch Changes

- 535d47b: Run the Playwright e2e suite in CI, and add a real streaming guarantee (feature gap G5).

  The e2e specs existed but **no CI job ever invoked them** — `ci.yml` ran typecheck/unit/build only, so the suite was reported coverage that had never executed. Two of its specs were in fact red.

  - `ci.yml` gains an `E2E (credential-free)` job that builds the bundle and runs the hermetic specs on every PR.
  - New `e2e-live.yml` (nightly) builds a lean in-memory `smooth-operator-server` and runs the credentialed, knowledge-grounded specs. A missing `SMOOAI_GATEWAY_KEY` **fails** the job rather than skipping silently.
  - New `e2e/streaming.spec.ts` asserts assistant tokens render _incrementally_, before `eventual_response` arrives. The previous spec asserted only the final text, so a widget that dropped streaming entirely still passed it.
  - Fixed `repro-stream-mock.spec.ts`, which made a real request to production (`/internal/resume-by-fingerprint` → 403) and failed on the resulting page error; it is now hermetic.
  - `SMOOTH_AGENT_SERVER_BIN` overrides the hardcoded local server path so the live specs can run on a CI runner.

## 0.16.1

### Patch Changes

- a5225bc: Voice: stop the agent's opening greeting from cutting itself off. Barge-in was firing on a single mic frame (~2.67ms) over the RMS threshold, so residual acoustic echo from the greeting (browser AEC is imperfect on speakers), a cough, or a noise blip would interrupt the agent mid-sentence — most visibly, the greeting never finished. Barge-in now requires ~200ms of _sustained_ above-threshold audio (new `bargeInMinMs` option, default 200); real speech crosses it easily, transient blips don't. The run resets on any quiet frame and on each new agent utterance.

## 0.16.0

### Minor Changes

- 6436692: Voice: speak-and-read mode + seamless voice→text continuity (SMOODEV-2674). A speaker toggle beside the mic lets visitors turn agent speech off — sessions start STT-only (`tts:false` on the browser-voice start frame; the server skips TTS entirely) while replies still arrive as chat bubbles. New `voice.tts` config sets the default. Starting voice now connects the text session first, so a voice-first visitor lands in a real conversation that continues seamlessly when they switch back to typing.

## 0.15.2

### Patch Changes

- eb7717c: Suggested-reply chips now render inline in the message flow, directly under the latest assistant reply (previously a fixed slot above the composer, visually detached), and the strip is removed the instant a chip is tapped. Chips remain optional shortcuts — the composer stays live.

## 0.15.1

### Patch Changes

- dc17f25: Fix heavy static on browser-voice TTS playback (SMOODEV-2668): re-align linear16 frames that split mid-sample (an odd-length frame made every later frame decode one byte off — pure noise), resample 16 kHz audio to the AudioContext's native rate with a proper band-limited streaming upsampler instead of forcing a 16 kHz context (whose browser-side output resampling mirrored speech energy above 8 kHz as harsh imaging static), and prime playback ~100 ms off the playhead when the queue drains so just-in-time chunks don't click.

## 0.15.0

### Minor Changes

- c492c54: Render the new `stream_preamble` frame: when the operator streams a fast-model preamble ("what I'm about to do") ahead of the answer, show it in the assistant bubble's typing slot (muted + italic) instead of the bare typing dots, then swap in the real answer the moment it starts streaming. A late preamble frame (after the answer began) is ignored. Requires `@smooai/smooth-operator` ≥ 1.22.15 (adds `stream_preamble` to the event union so the client forwards it).

## 0.14.1

### Patch Changes

- db9a07a: Fix a transient double-newline (extra blank line) during streaming. The streamed
  token render and the finalized `responseParts` render now share one paragraph
  separator and normalizer, so mid-stream no longer shows an extra blank line that
  vanishes when the message finalizes. The finalized output is unchanged for
  well-formed responses.

## 0.14.0

### Minor Changes

- 1295007: Voice input/output (SMOODEV-2534): mic capture + TTS playback over the browser-voice WebSocket, shipped dark behind the new `voice: { enabled, url? }` config option (OFF by default — zero UI when off). Adds `VoiceSession` (framework-free WS lifecycle, getUserMedia → AudioWorklet/ScriptProcessor → 16 kHz linear16 mic streaming, gapless PCM playback, RMS barge-in with `interrupt` + playback flush), an Aurora Glass mic toggle in the composer with listening/speaking indicators and a live partial transcript in the input, and voice turns (`transcript_final` / `reply_text`) rendered through the normal chat message path. The text session's conversation id is passed as `conversation_id` so voice resumes the same thread.

## 0.13.0

### Minor Changes

- 92b31ad: Add an opt-in `showToolActivity` option that renders the agent's tool activity (grep / read_file / bash / knowledge_search…) as inline chips interleaved with its prose, mirroring the smooth daemon SPA's `blocks` model.

  - Defaults to **`false`** — a customer-facing support widget stays byte-for-byte unchanged (prose bubble only). Enable via the `show-tool-activity` HTML attribute or `showToolActivity: true` in the config.
  - When enabled, an assistant turn that invokes a tool renders as an ordered strip of prose bubbles + tool chips (running… / done ✓ / error), in the order the model produced them. Tool activity is read from `state.rawResponse.toolCall` / `state.rawResponse.toolResult` (the correct nested path — reading `state.toolResult` leaves chips stuck "running…").
  - Tool name/args are rendered via `textContent` (never `innerHTML`), so a tool payload can't inject markup. New public `MessageBlock` / `ToolCall` types.

## 0.12.0

### Minor Changes

- 7180b52: Rich Interactions card registry + the identity_intake card. The widget now speaks the smooth-operator Rich Interactions protocol: it declares its render capabilities (`supports: ['identity_form']`, derived from the card registry) at session create, renders `interaction_required` interrupts as overlay cards above the composer, and resumes the parked turn via the generic `submit_interaction` verb. The identity card reuses the pre-chat form's field pattern (same classes, libphonenumber as-you-type phone formatting, E.164 canonicalization) with per-field server-side validation errors (`interaction_invalid` re-renders the card — the turn stays parked), known-identity pre-fill, and a decline affordance; accepted values merge into the persisted visitor identity. Adding a future interaction kind (date picker, choice chips, …) = one card builder + one `INTERACTION_CARDS` entry. Requires a smooth-operator server hosting Rich Interactions (client `@smooai/smooth-operator` pinned ^1.21.1); older servers simply never emit interaction events.

## 0.11.0

### Minor Changes

- 12f8636: Add mid-conversation suggested-reply chips ("quick replies"). When the terminal `eventual_response` carries `response.suggestedNextActions`, they attach to the finalized assistant message and render as tappable chips under the latest assistant turn (styled like the empty-state starter prompts). Tapping one sends it; a new turn or a manual message clears them. Chips are hidden while an OTP / tool-confirmation / restore overlay is active. New config option `showSuggestedReplies` (default `true`) toggles the feature in both popover and full-page modes.

## 0.10.2

### Patch Changes

- 4b55dfe: The "powered by smooth-operator" tag (full-page header) and footer now link to the smooth-operator GitHub repo (opens in a new tab). Added a `hide-branding` element attribute (`hideBranding` config key) to hide the branding in both render paths; branding is shown by default. The "Restore my chats" footer affordance is preserved independently of the toggle.

## 0.10.1

### Patch Changes

- 4de7ec2: Full-page mode now sizes to its **container**, never a hardcoded viewport unit. Previously `:host` and the inner `.panel.fullpage` both pinned `min-height: 100vh`, so `mountFullPageChat` into a fixed-height (`overflow: hidden`) box overflowed it and clipped the composer out of view — visitors saw only the example-prompt chips with no way to type (hit live on chakrabpc.com/transformation-posture). The host now hands its box down through a `.wrap` flex chain (`.panel.fullpage { flex: 1 }`), and a `data-viewport-fallback` attribute — set only when a layout probe finds the container gives the host no resolved height (e.g. mounted straight into an auto-height `<body>`) — restores the `min-height: 100dvh` viewport fill for bare full-page routes. Page-side `::part(panel)` overrides remain compatible.

## 0.10.0

### Minor Changes

- a98d7a1: Full-page header: square Smooth icon default + customizable `logoUrl`.

  **New default icon.** The full-page header avatar previously rendered the full "smooth" wordmark (a wide 550×135 SVG) crammed into the square tile, so it overflowed and looked broken — and it stamped Smoo branding onto customers' pages. It now renders the square Smooth icon (the stylized `th` glyph, `assets/smooth-icon.svg`, 150×150) which sits cleanly `contain`ed and centered in the tile.

  **New `logoUrl` config key.** Host pages can now brand the full-page header with their own logo:

  ```js
  mountFullPageChat({
    endpoint: "wss://ai.smoo.ai/ws",
    agentId: "…",
    logoUrl: "https://cdn.acme.com/logo.svg",
  });
  // or declaratively:
  // <smooth-agent-chat mode="fullpage" logo-url="https://cdn.acme.com/logo.svg" …></smooth-agent-chat>
  ```

  When set, the header renders `<img class="logo-img">` sized to `contain` within the tile; otherwise it falls back to the Smooth icon. **Security:** `logoUrl` is validated to absolute `http(s)` only (via the existing `safeHttpUrl` guard) — `javascript:`/`data:`/relative URLs are dropped — and escaped into the `src` attribute, so a hostile config can't inject script.

## 0.9.0

### Minor Changes

- 6b8a36e: Pre-chat phone field now formats and validates as you type (libphonenumber-js, US default region).

  - **As-you-type formatting** via `AsYouType('US')` — appended digits are formatted live (e.g. `(213) 373-4253`). The formatter only rewrites when the caret is at the end and never while deleting, so backspacing the formatting characters works naturally.
  - **Inline validity hint** driven by `isValidPhoneNumber(value, 'US')` — a subtle, themed valid/invalid state on the field plus a small hint span. An empty field stays neutral (the field is optional unless `requirePhone`).
  - **On submit**: when `requirePhone` is set and the number is invalid, submission is blocked and the hint is shown; when optional, submission proceeds. A valid number is sent as canonical **E.164** (`parsePhoneNumber(value, 'US').number`), falling back to the raw value when it does not parse (the backend re-parses and normalizes/nulls authoritatively — SMOODEV-2153).
  - Autofill is preserved: `type="tel"`, `autocomplete="tel"`, and the implicit `<label>` are unchanged, and the value is also reformatted/validated on `change` so a browser-autofilled number gets handled too.

  The standalone IIFE bundle now inlines `libphonenumber-js/min` (added to `deps.alwaysBundle`) so a plain `<script>` embed has no undefined-global reference at load.

## 0.7.0

### Minor Changes

- 9ea1dfc: Identity, persistence & consent client layer (ADR-048) — same-session resume, cross-device "restore my chats", marketing consent, and a stable browser fingerprint.

  **Persisted state (Zustand).** A framework-agnostic `zustand/vanilla` store with the `persist` middleware now keeps a small per-agent blob in localStorage (`smoo-chat-widget:<agentId>`): the session **pointer**, visitor identity (name/email/phone), marketing consent, a verified email, and the browser fingerprint. The **transcript is never persisted** — the smooth-operator server stays the source of truth and history is re-hydrated via `get_conversation_messages`. A `version` field drives `persist.migrate` so future shape changes upgrade old blobs in place; the storage adapter tolerates missing/locked-down localStorage (SSR, privacy mode) and never throws on boot.

  **Browser fingerprint.** Every `create_conversation_session` now carries a stable `browserFingerprint` for anonymous-visitor correlation (and server-side CRM matching). Computed once and cached in the persisted store. Rather than pull in ThumbmarkJS — tens of KB and async device-probing, too heavy for an embed whose whole point is staying out of the host's LCP/TBT budget — the fingerprint is a persisted random UUID (the exact same-browser correlator) suffixed with a small FNV hash of a few non-invasive, stable signals (UA, language, timezone, screen). No canvas/WebGL/audio probes, no network, XSS-safe. Tradeoff: weaker cross-storage matching than a full device fingerprint, deferred to the server resolver, in exchange for a tiny, transparent, privacy-light token.

  **Same-session resume.** On load, if a session pointer is persisted the widget calls `get_session`; when the session isn't `ended` it reuses the `sessionId`, replays history (`get_conversation_messages`, newest-first → reversed to chronological), skips the pre-chat form, and continues the conversation. An ended/404 session clears **only** the pointer (identity & consent survive) and starts fresh.

  **Returning-visitor resume by fingerprint (HTTP).** When there is no persisted pointer, the widget first `POST`s `/internal/resume-by-fingerprint` on the chat-ws wrapper with the browser fingerprint; if the wrapper resolves (and primes) a recent session it returns `{ resumable: true, sessionId, … }` and the widget adopts that session (then `get_session` + `get_conversation_messages` to hydrate) instead of creating a new one. `{ resumable: false }` falls through to a normal create.

  **Pre-chat form: phone + marketing consent.** The phone field is now shown by default (optional; rides session `metadata.userPhone`). Two explicit, default-unchecked consent checkboxes (email + SMS) capture marketing opt-in; ticking one stamps a `consentAt` ISO timestamp, and the consent record (`{ emailOptIn, smsOptIn, consentSource: 'chat-widget-prechat', consentAt }`) threads into the session metadata. New config flags: `collectPhone`, `collectConsent`, `allowChatRestore` (all default `true`).

  **Cross-device "Restore my chats."** An explicit footer affordance (not a mid-turn agent pause) runs the identity OTP flow over the chat-ws wrapper's HTTP routes — `POST /internal/identity/request-otp` → `verify-otp` → `resolve` — reusing the existing OTP UI. On a resolved list the visitor picks a conversation to replay (`get_session` + `get_conversation_messages`); the verified email is persisted.

  **HTTP, not WS frames.** The smooth-operator engine (1.8.0) owns the `/ws` dispatch and rejects unknown verbs, so the cross-device identity flow and fingerprint resume are `fetch()` (POST, JSON) calls to the chat-ws wrapper, with the HTTP base derived from the WS endpoint (`wss://ai.smoo.ai/ws` → `https://ai.smoo.ai`). The browser sends `Origin` automatically (origin-allowlisted server-side) and each request carries `agentId`/`agentName` plus an optional pre-auth `authContext` (`{ userId, signature, timestamp }`) from the new `authContext` config option.

  All server-supplied strings (masked destinations, conversation previews, history) are rendered via `textContent`, keeping the 0.6.0 XSS guarantees intact, and the new UI follows the Aurora-Glass styling.

## 0.6.0

### Minor Changes

- 586003c: Render sanitized Markdown in assistant replies and citation snippets, and smooth out the streaming reveal.

  **Sanitized Markdown rendering.** Assistant responses and citation snippets previously showed Markdown literally (`**bold**`, numbered lists, `[links](url)` rendered as raw text). They now render to formatted HTML through a tiny, safe-by-default renderer (`markdown.ts`) that:

  - escapes **all** text — raw `<script>`, `<img onerror=…>`, `<iframe>` etc. render as inert text, never markup;
  - **drops images entirely** (a scraped tracking pixel can't load) — `![alt](src)` becomes its alt text;
  - allows **only `http(s)` links** (`javascript:`/`data:`/relative fall back to plain text) with `target="_blank"` + `rel="noopener noreferrer nofollow"`;
  - emits only an allowlisted tag set (`p`, `br`, `strong`, `em`, `ul`/`ol`/`li`, `code`/`pre`, `a`, `blockquote`) and **downgrades headings** to bold lines so they fit a chat bubble.

  User bubbles stay plain text; mid-stream text stays plain (partial Markdown renders ugly) and only the final assistant turn is rendered as Markdown. Citation snippets are also cleaned first — leading page boilerplate (logo image/link, nav, whitespace) is trimmed and the excerpt is truncated to ~260 chars at a word boundary.

  **Smooth streaming reveal.** The assistant bubble no longer jumps in jerky, uneven chunks as `stream_token` bursts arrive. Incoming token text is buffered and revealed via a `requestAnimationFrame` typewriter at an adaptive rate (chars-per-frame scales with the pending backlog, so it never falls behind the network); only the single streaming bubble is updated per frame (no full list rebuild), and the final turn snaps to the full Markdown render. Respects `prefers-reduced-motion` (snaps instantly) and keeps auto-scroll without fighting a visitor who has scrolled up.

## 0.5.2

### Patch Changes

- Build: pin an explicit `es2020` browser transpile target for all bundles (ESM + both IIFE globals) instead of letting tsdown derive a Node target (`node22.0.0`) from `engines`. A Node target is wrong for a browser `<script>`/ESM embed and is exactly the setting that can silently downlevel the smooth-operator protocol client's async generators / `for await` over the streaming `MessageTurn` (`Symbol.asyncIterator`) into regenerator/helper shims — which mangles the streamed chat turn in stricter engines. Pinning a browser target keeps native async iteration intact and keeps the IIFE global bundle byte-faithful to the ESM build on the streaming path. Verified end-to-end against the live prod operator (`wss://ai.smoo.ai/ws`) in headless Chromium: a full grounded turn streams and renders.

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
