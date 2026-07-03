---
'@smooai/chat-widget': minor
---

Add mid-conversation suggested-reply chips ("quick replies"). When the terminal `eventual_response` carries `response.suggestedNextActions`, they attach to the finalized assistant message and render as tappable chips under the latest assistant turn (styled like the empty-state starter prompts). Tapping one sends it; a new turn or a manual message clears them. Chips are hidden while an OTP / tool-confirmation / restore overlay is active. New config option `showSuggestedReplies` (default `true`) toggles the feature in both popover and full-page modes.
