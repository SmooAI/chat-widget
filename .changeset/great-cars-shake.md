---
'@smooai/chat-widget': patch
---

Fix a returning visitor with a dead session pointer getting a brand-new conversation (SMOODEV-3057)

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
