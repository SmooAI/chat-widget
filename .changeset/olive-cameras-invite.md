---
'@smooai/chat-widget': patch
---

Fix: the widget could report "Online" and then fail every send

A visitor on smoo.ai completed the pre-chat form, saw the status go "Online", and then got "We couldn't reach the chat." on every turn while the backend was entirely healthy. Three defects, all on the connect path:

- `connect()` early-returned while a connect was in flight. The guard was right — one connect, not two — but it returned an already-resolved promise, so every `await connect()` resolved *before* a session existed and `send()` fell through to its "not connected" throw. Four of the six call sites are fire-and-forget `void connect()` (launcher click, pre-chat submit, full-page mount, voice hand-off), so an awaiting caller racing an in-flight one is the normal case, not an edge. Concurrent callers now share one connect and each `await` resolves when that connect finishes.
- A `create_conversation_session` that resolved without a session id was accepted, assigning `undefined` and still flipping the status to `ready`. That is a permanent wedge: every later send hits the missing id, calls `connect()`, is early-returned by the `ready` status, and throws again. It now fails honestly and retryably.
- `tryResume()` read the session snapshot's `status` outside its `try`/`catch`. The operator client returns an `immediate_response`'s `data` without checking its status, so an error-status reply carrying no `data` resolves as `undefined` rather than rejecting — and the property read threw a `TypeError` past the catch and out of `connect()`.

Also hardened: `send()` now renders the one human error sentence when a connect is genuinely fatal, instead of rejecting out of `send()` — which dropped the visitor's typed text into an empty transcript and raised an unhandled rejection on the host page. A failure reaching the optional resume probe is recoverable by starting a fresh session; a failure reaching the transport itself stays fatal.
