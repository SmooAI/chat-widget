/**
 * VoiceSession unit tests (jsdom + injected seams — no real audio, no real WS).
 *
 * Coverage against the FROZEN browser-voice protocol (SMOODEV-2534):
 *   - start frame framing (`{"type":"start","agent_id",…}` first, conversation_id
 *     / token only when provided),
 *   - mic frames downsampled to 16 kHz Int16 binary passthrough,
 *   - barge-in: RMS speech during agent TTS → `{"type":"interrupt"}` + playback
 *     flush; mic-button interrupt does the same,
 *   - downsampler correctness on a synthetic 48 kHz sine,
 *   - PcmPlayer gapless scheduling + flush,
 *   - server JSON events fan out to the right callbacks,
 *   - stop sends `{"type":"stop"}` and teardown fires `ended` exactly once.
 */
import { describe, expect, it } from 'vitest';
import {
    downsampleTo16k,
    PcmPlayer,
    type PlayerAudioContext,
    rmsLevel,
    VOICE_SAMPLE_RATE,
    type VoicePlayer,
    VoiceSession,
    type VoiceSessionEvents,
    type VoiceWebSocket,
} from './voice-session.js';

// ─────────────────────────── Mock seams ─────────────────────────────────────

type Listener = (ev: never) => void;

/** Scriptable mock voice WebSocket (same idiom as conversation.test.ts's MockSocket). */
class MockVoiceSocket implements VoiceWebSocket {
    binaryType = 'blob';
    readyState = 0;
    sent: (string | ArrayBuffer)[] = [];
    closed: { code?: number; reason?: string } | null = null;
    private listeners: Record<string, Listener[]> = { open: [], message: [], close: [], error: [] };

    addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: Listener): void {
        this.listeners[type]!.push(fn);
    }
    send(data: string | ArrayBuffer): void {
        this.sent.push(data);
    }
    close(code?: number, reason?: string): void {
        this.readyState = 3;
        this.closed = { code, reason };
        this.emit('close', {});
    }
    // test drivers
    open(): void {
        this.readyState = 1;
        this.emit('open', {});
    }
    serverJson(obj: unknown): void {
        this.emit('message', { data: JSON.stringify(obj) });
    }
    serverBinary(buf: ArrayBuffer): void {
        this.emit('message', { data: buf });
    }
    serverClose(): void {
        this.readyState = 3;
        this.emit('close', {});
    }
    private emit(type: string, ev: unknown): void {
        for (const fn of this.listeners[type]!.slice()) (fn as (e: unknown) => void)(ev);
    }
    /** The JSON control frames sent so far, parsed. */
    jsonFrames(): Record<string, unknown>[] {
        return this.sent.filter((f): f is string => typeof f === 'string').map((f) => JSON.parse(f) as Record<string, unknown>);
    }
    binaryFrames(): ArrayBuffer[] {
        return this.sent.filter((f): f is ArrayBuffer => typeof f !== 'string');
    }
}

class MockPlayer implements VoicePlayer {
    chunks: ArrayBuffer[] = [];
    flushes = 0;
    closes = 0;
    enqueue(chunk: ArrayBuffer): void {
        this.chunks.push(chunk);
    }
    flush(): void {
        this.flushes += 1;
    }
    close(): void {
        this.closes += 1;
    }
}

/** Build a session wired to mocks. `harness.mic(samples, rate)` injects a mic frame. */
function makeSession(
    opts: { conversationId?: string; token?: string; bargeInThreshold?: number } = {},
    events: VoiceSessionEvents = {},
): { session: VoiceSession; ws: MockVoiceSocket; player: MockPlayer; mic: (samples: Float32Array, rate: number) => void; captureStopped: () => boolean } {
    const ws = new MockVoiceSocket();
    const player = new MockPlayer();
    let onFrame: ((samples: Float32Array, rate: number) => void) | null = null;
    let stopped = false;
    const session = new VoiceSession(
        {
            url: 'wss://voice.test/browser-voice/ws',
            agentId: 'agent-123',
            ...opts,
            seams: {
                createWebSocket: () => ws,
                startCapture: (cb) => {
                    onFrame = cb;
                    return Promise.resolve(() => {
                        stopped = true;
                    });
                },
                createPlayer: () => player,
            },
        },
        events,
    );
    return { session, ws, player, mic: (s, r) => onFrame?.(s, r), captureStopped: () => stopped };
}

/** A Float32 sine at `freq` Hz sampled at `rate` for `n` samples. */
function sine(freq: number, rate: number, n: number, amplitude = 0.5): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
    return out;
}

// ───────────────────────── Protocol framing ─────────────────────────────────

describe('VoiceSession protocol framing', () => {
    it('sends the start frame first on open, with agent_id only (public agent)', async () => {
        const { session, ws } = makeSession();
        await session.start();
        expect(ws.binaryType).toBe('arraybuffer');
        expect(ws.sent).toHaveLength(0); // nothing before open
        ws.open();
        expect(ws.jsonFrames()).toEqual([{ type: 'start', agent_id: 'agent-123' }]);
    });

    it('threads conversation_id and token into the start frame when provided', async () => {
        const { session, ws } = makeSession({ conversationId: 'conv-9', token: 'jwt-abc' });
        await session.start();
        ws.open();
        expect(ws.jsonFrames()[0]).toEqual({ type: 'start', agent_id: 'agent-123', conversation_id: 'conv-9', token: 'jwt-abc' });
    });

    it('streams mic frames as 16 kHz Int16 binary after the start frame', async () => {
        const { session, ws, mic } = makeSession();
        await session.start();
        ws.open();
        mic(sine(440, 48000, 480), 48000);
        const bins = ws.binaryFrames();
        expect(bins).toHaveLength(1);
        // 480 samples @ 48k → 160 samples @ 16k → 320 bytes of linear16.
        expect(new Int16Array(bins[0]!)).toHaveLength(160);
        // start frame stays first on the wire.
        expect(typeof ws.sent[0]).toBe('string');
    });

    it('drops mic frames until the socket is open + started (no early binary)', async () => {
        const { session, ws, mic } = makeSession();
        await session.start();
        mic(sine(440, 48000, 480), 48000); // before open
        expect(ws.sent).toHaveLength(0);
        ws.open();
        mic(sine(440, 48000, 480), 48000);
        expect(ws.binaryFrames()).toHaveLength(1);
    });

    it('routes incoming binary frames to the playback queue', async () => {
        const { session, ws, player } = makeSession();
        await session.start();
        ws.open();
        const tts = new Int16Array([100, -100, 200]).buffer as ArrayBuffer;
        ws.serverBinary(tts);
        expect(player.chunks).toEqual([tts]);
    });

    it('stop() sends {"type":"stop"}, stops capture, closes playback + socket, fires ended once', async () => {
        let endedCount = 0;
        const { session, ws, player, captureStopped } = makeSession({}, { onEnded: () => endedCount++ });
        await session.start();
        ws.open();
        session.stop();
        expect(ws.jsonFrames().at(-1)).toEqual({ type: 'stop' });
        expect(captureStopped()).toBe(true);
        expect(player.closes).toBe(1);
        expect(ws.closed).not.toBeNull();
        expect(endedCount).toBe(1);
        session.stop(); // idempotent
        expect(endedCount).toBe(1);
    });

    it('a server close tears down and fires ended', async () => {
        let ended = false;
        const { session, ws, captureStopped } = makeSession({}, { onEnded: () => (ended = true) });
        await session.start();
        ws.open();
        ws.serverClose();
        expect(ended).toBe(true);
        expect(captureStopped()).toBe(true);
    });
});

// ───────────────────────── Server events fan-out ────────────────────────────

describe('VoiceSession server events', () => {
    it('fans transcript_partial/final, reply_text, and speaking state to callbacks', async () => {
        const partials: string[] = [];
        const finals: string[] = [];
        const replies: string[] = [];
        const speaking: boolean[] = [];
        const { session, ws } = makeSession(
            {},
            {
                onTranscriptPartial: (t) => partials.push(t),
                onTranscriptFinal: (t) => finals.push(t),
                onReplyText: (t) => replies.push(t),
                onSpeaking: (s) => speaking.push(s),
            },
        );
        await session.start();
        ws.open();
        ws.serverJson({ type: 'transcript_partial', text: 'hel' });
        ws.serverJson({ type: 'transcript_partial', text: 'hello th' });
        ws.serverJson({ type: 'transcript_final', text: 'hello there' });
        ws.serverJson({ type: 'reply_text', text: 'Hi! How can I help?' });
        ws.serverJson({ type: 'speaking_started' });
        ws.serverJson({ type: 'speaking_done' });
        expect(partials).toEqual(['hel', 'hello th']);
        expect(finals).toEqual(['hello there']);
        expect(replies).toEqual(['Hi! How can I help?']);
        expect(speaking).toEqual([true, false]);
    });

    it('error event surfaces the code and ends the session', async () => {
        const codes: string[] = [];
        let ended = false;
        const { session, ws } = makeSession({}, { onError: (c) => codes.push(c), onEnded: () => (ended = true) });
        await session.start();
        ws.open();
        ws.serverJson({ type: 'error', code: 'agent_unavailable' });
        expect(codes).toEqual(['agent_unavailable']);
        expect(ended).toBe(true);
        // stop frame went out before teardown.
        expect(ws.jsonFrames().at(-1)).toEqual({ type: 'stop' });
    });

    it('handoff ends the voice session (back to text)', async () => {
        let ended = false;
        const { session, ws } = makeSession({}, { onEnded: () => (ended = true) });
        await session.start();
        ws.open();
        ws.serverJson({ type: 'handoff' });
        expect(ended).toBe(true);
    });
});

// ─────────────────────────────── Barge-in ───────────────────────────────────

describe('VoiceSession barge-in', () => {
    it('speech (RMS above threshold) during agent TTS sends interrupt and flushes playback', async () => {
        const speaking: boolean[] = [];
        const { session, ws, player, mic } = makeSession({}, { onSpeaking: (s) => speaking.push(s) });
        await session.start();
        ws.open();
        ws.serverJson({ type: 'speaking_started' });

        mic(sine(440, 48000, 480, 0.5), 48000); // loud speech while agent talks
        const interrupts = ws.jsonFrames().filter((f) => f.type === 'interrupt');
        expect(interrupts).toHaveLength(1);
        expect(player.flushes).toBe(1);
        expect(speaking).toEqual([true, false]); // barge-in clears speaking locally

        // The mic frame itself still streams (the server transcribes the barge-in).
        expect(ws.binaryFrames()).toHaveLength(1);
    });

    it('quiet mic frames during TTS do NOT interrupt', async () => {
        const { session, ws, player, mic } = makeSession();
        await session.start();
        ws.open();
        ws.serverJson({ type: 'speaking_started' });
        mic(sine(440, 48000, 480, 0.001), 48000); // room noise
        expect(ws.jsonFrames().filter((f) => f.type === 'interrupt')).toHaveLength(0);
        expect(player.flushes).toBe(0);
    });

    it('speech while the agent is NOT speaking does not interrupt', async () => {
        const { session, ws, mic } = makeSession();
        await session.start();
        ws.open();
        mic(sine(440, 48000, 480, 0.5), 48000);
        expect(ws.jsonFrames().filter((f) => f.type === 'interrupt')).toHaveLength(0);
    });

    it('manual interrupt() (mic button mid-playback) sends the frame and flushes', async () => {
        const { session, ws, player } = makeSession();
        await session.start();
        ws.open();
        ws.serverJson({ type: 'speaking_started' });
        expect(session.isSpeaking).toBe(true);
        session.interrupt();
        expect(ws.jsonFrames().at(-1)).toEqual({ type: 'interrupt' });
        expect(player.flushes).toBe(1);
        expect(session.isSpeaking).toBe(false);
    });
});

// ────────────────────────────── Downsampler ─────────────────────────────────

describe('downsampleTo16k', () => {
    it('decimates 48 kHz → 16 kHz preserving a synthetic sine (frequency + amplitude)', () => {
        const freq = 440;
        const input = sine(freq, 48000, 4800, 0.5); // 100 ms
        const out = downsampleTo16k(input, 48000);
        expect(out).toHaveLength(1600); // 3:1

        // Compare each output sample against the ideal 16 kHz sine. Averaging
        // input samples 3i..3i+2 centers each output on input sample 3i+1 — a
        // 1/48000 s phase shift — and attenuates a hair; allow a small tolerance.
        const phaseShift = 1 / 48000;
        let maxErr = 0;
        for (let i = 0; i < out.length; i++) {
            const ideal = 0.5 * Math.sin(2 * Math.PI * freq * (i / VOICE_SAMPLE_RATE + phaseShift)) * 32767;
            maxErr = Math.max(maxErr, Math.abs(out[i]! - ideal));
        }
        expect(maxErr).toBeLessThan(0.01 * 32767); // within 1% of full scale
    });

    it('handles non-integer ratios (44.1 kHz) with the right output length', () => {
        const out = downsampleTo16k(sine(440, 44100, 4410), 44100);
        expect(out).toHaveLength(1600); // 4410 / (44100/16000)
    });

    it('passes 16 kHz input through sample-for-sample (converted to Int16)', () => {
        const input = new Float32Array([0, 0.5, -0.5, 1, -1]);
        const out = downsampleTo16k(input, 16000);
        // Math.round is half-up: 16383.5 → 16384, -16383.5 → -16383.
        expect(Array.from(out)).toEqual([0, 16384, -16383, 32767, -32767]);
    });

    it('clamps out-of-range samples to the Int16 range', () => {
        const out = downsampleTo16k(new Float32Array([1.5, -1.5]), 16000);
        expect(Array.from(out)).toEqual([32767, -32768]);
    });
});

describe('rmsLevel', () => {
    it('is ~amplitude/√2 for a sine and 0 for silence', () => {
        expect(rmsLevel(sine(440, 48000, 4800, 0.5))).toBeCloseTo(0.5 / Math.SQRT2, 2);
        expect(rmsLevel(new Float32Array(480))).toBe(0);
        expect(rmsLevel(new Float32Array(0))).toBe(0);
    });
});

// ──────────────────────────── Playback queue ────────────────────────────────

interface ScheduledSource {
    startedAt: number | undefined;
    stopped: boolean;
    length: number;
}

/** Fake 16 kHz AudioContext capturing scheduling for assertions. */
function makeFakeCtx(): { ctx: PlayerAudioContext; scheduled: ScheduledSource[]; setTime: (t: number) => void; closed: () => boolean } {
    let now = 0;
    let closed = false;
    const scheduled: ScheduledSource[] = [];
    const ctx: PlayerAudioContext = {
        get currentTime() {
            return now;
        },
        destination: {},
        createBuffer: (_ch, length) => ({ getChannelData: () => new Float32Array(length) }),
        createBufferSource: () => {
            const rec: ScheduledSource = { startedAt: undefined, stopped: false, length: 0 };
            scheduled.push(rec);
            return {
                buffer: null as unknown,
                connect: () => {},
                start: (when?: number) => {
                    rec.startedAt = when ?? now;
                },
                stop: () => {
                    rec.stopped = true;
                },
                onended: null,
            };
        },
        close: () => {
            closed = true;
            return Promise.resolve();
        },
    };
    return { ctx, scheduled, setTime: (t) => (now = t), closed: () => closed };
}

describe('PcmPlayer', () => {
    const chunk = (samples: number): ArrayBuffer => new Int16Array(samples).buffer as ArrayBuffer;

    it('schedules consecutive chunks back-to-back (gapless)', () => {
        const { ctx, scheduled } = makeFakeCtx();
        const player = new PcmPlayer(ctx);
        player.enqueue(chunk(1600)); // 100 ms
        player.enqueue(chunk(800)); // 50 ms
        player.enqueue(chunk(1600));
        const starts = scheduled.map((s) => s.startedAt!);
        expect(starts[0]).toBe(0);
        expect(starts[1]).toBeCloseTo(0.1, 10);
        expect(starts[2]).toBeCloseTo(0.15, 10);
    });

    it('re-anchors to currentTime after the queue drains (no scheduling in the past)', () => {
        const { ctx, scheduled, setTime } = makeFakeCtx();
        const player = new PcmPlayer(ctx);
        player.enqueue(chunk(1600)); // plays 0 → 0.1
        setTime(0.5); // long silence; next reply arrives later
        player.enqueue(chunk(1600));
        expect(scheduled[1]!.startedAt).toBe(0.5);
    });

    it('flush() stops every live source and resets the schedule', () => {
        const { ctx, scheduled, setTime } = makeFakeCtx();
        const player = new PcmPlayer(ctx);
        player.enqueue(chunk(1600));
        player.enqueue(chunk(1600));
        player.flush();
        expect(scheduled.every((s) => s.stopped)).toBe(true);
        // After a flush the next chunk anchors to now, not the stale nextTime.
        setTime(0.05);
        player.enqueue(chunk(1600));
        expect(scheduled[2]!.startedAt).toBe(0.05);
    });

    it('close() flushes and closes the context; empty chunks are ignored', () => {
        const { ctx, scheduled, closed } = makeFakeCtx();
        const player = new PcmPlayer(ctx);
        player.enqueue(new ArrayBuffer(0));
        expect(scheduled).toHaveLength(0);
        player.enqueue(chunk(160));
        player.close();
        expect(scheduled[0]!.stopped).toBe(true);
        expect(closed()).toBe(true);
    });
});
