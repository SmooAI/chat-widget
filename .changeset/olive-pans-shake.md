---
'@smooai/chat-widget': patch
---

Never render a raw backend error as agent dialogue, and recover from a dead session.

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
