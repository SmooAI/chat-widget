---
'@smooai/chat-widget': patch
---

Bump `@smooai/smooth-operator` to `^1.8.0` to restore chat against the deployed smooth-operator 1.8.0.

The widget bundled the `^0.2.0` protocol client, which threw while iterating the 1.8.0 turn stream — the newer wire frames (`immediate_response` status 202, `stream_token`, terminal `eventual_response` with `data.data.citations`) were unrecognized by the old client, so every `send_message` surfaced "We couldn't reach the chat." even though the operator was streaming a correct grounded response. The 1.8.0 client understands those frames; the `ConversationController` extraction logic (stream-token accumulation, `final.data.data.{response,citations}`, OTP + tool-confirmation HITL handling) already matched the 1.8.0 protocol and needed no changes. Live-verified a full streaming turn (12 tokens + 1 citation) against the prod operator at `wss://ai.smoo.ai/ws`.
