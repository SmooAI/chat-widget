---
'@smooai/chat-widget': minor
---

Identity, persistence & consent client layer (ADR-048) — same-session resume, cross-device "restore my chats", marketing consent, and a stable browser fingerprint.

**Persisted state (Zustand).** A framework-agnostic `zustand/vanilla` store with the `persist` middleware now keeps a small per-agent blob in localStorage (`smoo-chat-widget:<agentId>`): the session **pointer**, visitor identity (name/email/phone), marketing consent, a verified email, and the browser fingerprint. The **transcript is never persisted** — the smooth-operator server stays the source of truth and history is re-hydrated via `get_conversation_messages`. A `version` field drives `persist.migrate` so future shape changes upgrade old blobs in place; the storage adapter tolerates missing/locked-down localStorage (SSR, privacy mode) and never throws on boot.

**Browser fingerprint.** Every `create_conversation_session` now carries a stable `browserFingerprint` for anonymous-visitor correlation (and server-side CRM matching). Computed once and cached in the persisted store. Rather than pull in ThumbmarkJS — tens of KB and async device-probing, too heavy for an embed whose whole point is staying out of the host's LCP/TBT budget — the fingerprint is a persisted random UUID (the exact same-browser correlator) suffixed with a small FNV hash of a few non-invasive, stable signals (UA, language, timezone, screen). No canvas/WebGL/audio probes, no network, XSS-safe. Tradeoff: weaker cross-storage matching than a full device fingerprint, deferred to the server resolver, in exchange for a tiny, transparent, privacy-light token.

**Same-session resume.** On load, if a session pointer is persisted the widget calls `get_session`; when the session isn't `ended` it reuses the `sessionId`, replays history (`get_conversation_messages`, newest-first → reversed to chronological), skips the pre-chat form, and continues the conversation. An ended/404 session clears **only** the pointer (identity & consent survive) and starts fresh.

**Pre-chat form: phone + marketing consent.** The phone field is now shown by default (optional; rides session `metadata.userPhone`). Two explicit, default-unchecked consent checkboxes (email + SMS) capture marketing opt-in; ticking one stamps a `consentAt` ISO timestamp, and the consent record (`{ emailOptIn, smsOptIn, consentSource: 'chat-widget-prechat', consentAt }`) threads into the session metadata. New config flags: `collectPhone`, `collectConsent`, `allowChatRestore` (all default `true`).

**Cross-device "Restore my chats."** An explicit footer affordance (not a mid-turn agent pause) runs `request_identity_otp` → `verify_identity_otp` → `resolve_identity`, reusing the existing OTP UI. On a resolved list the visitor picks a conversation to replay (`get_session` + `get_conversation_messages`); the verified email is persisted. The new verbs are sent as raw frames over a shared transport so they integrate the moment the server side (SMOODEV-2129d) lands.

All server-supplied strings (masked destinations, conversation previews, history) are rendered via `textContent`, keeping the 0.6.0 XSS guarantees intact, and the new UI follows the Aurora-Glass styling.
