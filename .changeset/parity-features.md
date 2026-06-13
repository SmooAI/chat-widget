---
'@smooai/chat-widget': minor
---

Feature-parity pass toward retiring `@smooai/ui-chat-widget`: starter-prompt chips (`examplePrompts`), a pre-chat identity form (`requireName`/`requireEmail`/`requirePhone`/`allowAnonymous`), full dashboard theming parity (10-color model via `secondary` + `chatBubble*` aliases), and OTP + tool-confirmation (HITL) support in `ConversationController` (`onInterrupt` + `verifyOtp`/`confirmTool`). Voice remains out of scope (no smooth-operator protocol support yet).
