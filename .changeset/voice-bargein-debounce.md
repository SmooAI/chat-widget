---
'@smooai/chat-widget': patch
---

Voice: stop the agent's opening greeting from cutting itself off. Barge-in was firing on a single mic frame (~2.67ms) over the RMS threshold, so residual acoustic echo from the greeting (browser AEC is imperfect on speakers), a cough, or a noise blip would interrupt the agent mid-sentence — most visibly, the greeting never finished. Barge-in now requires ~200ms of *sustained* above-threshold audio (new `bargeInMinMs` option, default 200); real speech crosses it easily, transient blips don't. The run resets on any quiet frame and on each new agent utterance.
