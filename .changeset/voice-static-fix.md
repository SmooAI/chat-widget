---
'@smooai/chat-widget': patch
---

Fix heavy static on browser-voice TTS playback (SMOODEV-2668): re-align linear16 frames that split mid-sample (an odd-length frame made every later frame decode one byte off — pure noise), resample 16 kHz audio to the AudioContext's native rate with a proper band-limited streaming upsampler instead of forcing a 16 kHz context (whose browser-side output resampling mirrored speech energy above 8 kHz as harsh imaging static), and prime playback ~100 ms off the playhead when the queue drains so just-in-time chunks don't click.
