---
'@smooai/chat-widget': minor
---

Voice: speak-and-read mode + seamless voice→text continuity (SMOODEV-2674). A speaker toggle beside the mic lets visitors turn agent speech off — sessions start STT-only (`tts:false` on the browser-voice start frame; the server skips TTS entirely) while replies still arrive as chat bubbles. New `voice.tts` config sets the default. Starting voice now connects the text session first, so a voice-first visitor lands in a real conversation that continues seamlessly when they switch back to typing.
