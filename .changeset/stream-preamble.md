---
'@smooai/chat-widget': minor
---

Render the new `stream_preamble` frame: when the operator streams a fast-model preamble ("what I'm about to do") ahead of the answer, show it in the assistant bubble's typing slot (muted + italic) instead of the bare typing dots, then swap in the real answer the moment it starts streaming. A late preamble frame (after the answer began) is ignored. Requires `@smooai/smooth-operator` ≥ 1.22.15 (adds `stream_preamble` to the event union so the client forwards it).
