---
'@smooai/chat-widget': patch
---

Carry the browser's OTP proof on the fingerprint resume probe (SMOODEV-3066)

The probe now sends `verifiedSessionId` + `email` when the widget holds an OTP
proof, so the server-side identity-scoped resume can allow a CRM-linked match
for the *same* contact. Both fields are optional and only meaningful together;
`chat-ws` parses this body as an untyped JSON value, so a wrapper without the
server half ignores them.

Read before `clearSession()`, which drops the session-scoped proof by design.
Both probe sites — the dead pointer and the dead-session recovery — clear before
probing, so reading afterwards would always find nothing, silently, on exactly
the visitors the server change exists to help.
