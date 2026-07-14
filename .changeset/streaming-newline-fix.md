---
'@smooai/chat-widget': patch
---

Fix a transient double-newline (extra blank line) during streaming. The streamed
token render and the finalized `responseParts` render now share one paragraph
separator and normalizer, so mid-stream no longer shows an extra blank line that
vanishes when the message finalizes. The finalized output is unchanged for
well-formed responses.
