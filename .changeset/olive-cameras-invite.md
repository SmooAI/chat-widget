---
'@smooai/chat-widget': patch
---

Fix: an optional resume failure no longer takes the chat down

A returning visitor was shown "We couldn't reach the chat." under a "Connection issue" header while the backend was entirely healthy. Two defects on the resume path, which is only ever an enhancement:

- `tryResume()` read the session snapshot's `status` outside its `try`/`catch`. The operator client returns an `immediate_response`'s `data` without checking its status, so an error-status reply carrying no `data` resolves as `undefined` rather than rejecting — and the property read threw a `TypeError` past the catch and out of `connect()`.
- `send()` awaited `connect()` before pushing the transcript bubbles and outside the failure-rendering `try`. A genuinely fatal connect therefore rejected out of `send()`: the visitor's typed text vanished with an empty transcript, and the caller's uncaught `void send()` raised an unhandled rejection on the host page.

A failure reaching the optional resume probe is now recoverable by starting a fresh session; a failure reaching the transport itself is still fatal and surfaces the one human error sentence.
