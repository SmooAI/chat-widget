---
'@smooai/chat-widget': minor
---

OTP and tool-confirmation (HITL) **dialog UI**: when a turn pauses for OTP
verification or a tool-write approval, the widget now shows an inline overlay
above the composer — an OTP code prompt (with masked destination + retry/error
state) or an Approve/Decline confirmation — wired to `verifyOtp`/`confirmTool`.
Completes the OTP/HITL parity whose protocol plumbing shipped in 0.3.0.
