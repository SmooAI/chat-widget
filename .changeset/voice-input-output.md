---
'@smooai/chat-widget': minor
---

Voice input/output (SMOODEV-2534): mic capture + TTS playback over the browser-voice WebSocket, shipped dark behind the new `voice: { enabled, url? }` config option (OFF by default — zero UI when off). Adds `VoiceSession` (framework-free WS lifecycle, getUserMedia → AudioWorklet/ScriptProcessor → 16 kHz linear16 mic streaming, gapless PCM playback, RMS barge-in with `interrupt` + playback flush), an Aurora Glass mic toggle in the composer with listening/speaking indicators and a live partial transcript in the input, and voice turns (`transcript_final` / `reply_text`) rendered through the normal chat message path. The text session's conversation id is passed as `conversation_id` so voice resumes the same thread.
