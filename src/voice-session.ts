/**
 * VoiceSession — framework-free browser voice for the chat widget.
 *
 * Speaks the FROZEN browser-voice WebSocket protocol (SMOODEV-2534 / ADR-084):
 *
 *   client → server:
 *     - first frame, JSON: `{"type":"start","agent_id":"…","conversation_id":"…?","token":"…?"}`
 *       (public-agent auth is the `Origin` header the browser sends automatically;
 *       `token` only for authenticated contexts)
 *     - binary frames: raw PCM linear16 mono @ 16 kHz mic chunks
 *     - JSON `{"type":"interrupt"}` (user barged in), `{"type":"stop"}`
 *   server → client:
 *     - JSON `transcript_partial` / `transcript_final` / `reply_text` /
 *       `speaking_started` / `speaking_done` / `handoff` / `error {code}`
 *     - binary frames: PCM linear16 mono @ 16 kHz TTS audio chunks
 *
 * The class owns: the WS lifecycle, mic capture (getUserMedia → AudioWorklet or
 * ScriptProcessor fallback → downsample to 16 kHz mono Int16 → binary frames),
 * gapless playback of incoming PCM through a 16 kHz AudioContext, and barge-in
 * (RMS speech detection while the agent is speaking → `interrupt` + playback
 * flush). Browser audio + WebSocket are thin injectable seams so unit tests run
 * under jsdom/happy-dom with no real audio.
 */

export const DEFAULT_VOICE_URL = 'wss://twilio-voice.smoo.ai/browser-voice/ws';

/** Target wire format: PCM linear16 mono @ 16 kHz. */
export const VOICE_SAMPLE_RATE = 16000;

// ─────────────────────────── Pure DSP helpers ───────────────────────────────

/**
 * Downsample Float32 mic samples at `inputRate` to 16 kHz mono Int16 (linear16).
 * Bucket-averaging decimation: each output sample averages its source bucket,
 * which is a cheap low-pass that's plenty for speech (and handles non-integer
 * ratios like 44.1k → 16k). Values are clamped to the Int16 range.
 */
export function downsampleTo16k(samples: Float32Array, inputRate: number): Int16Array {
    const ratio = inputRate / VOICE_SAMPLE_RATE;
    const outLen = ratio <= 1 ? samples.length : Math.floor(samples.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
        let v: number;
        if (ratio <= 1) {
            v = samples[i]!;
        } else {
            const start = Math.floor(i * ratio);
            const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
            let sum = 0;
            for (let j = start; j < end; j++) sum += samples[j]!;
            v = sum / (end - start);
        }
        out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    }
    return out;
}

/** Root-mean-square level of a Float32 frame (0..1) — the barge-in speech gate. */
export function rmsLevel(samples: Float32Array): number {
    if (samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
    return Math.sqrt(sum / samples.length);
}

// ──────────────────────────── Injectable seams ──────────────────────────────

/** The subset of WebSocket the session needs (mockable in tests). */
export interface VoiceWebSocket {
    binaryType: string;
    readyState: number;
    send(data: string | ArrayBuffer): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (ev: never) => void): void;
}

/** Playback sink for incoming 16 kHz PCM chunks (mockable in tests). */
export interface VoicePlayer {
    /** Queue a linear16 chunk for gapless playback. */
    enqueue(chunk: ArrayBuffer): void;
    /** Stop everything queued/playing immediately (barge-in). */
    flush(): void;
    /** Flush + release the audio device. */
    close(): void;
}

/**
 * Start mic capture, invoking `onFrame(samples, sampleRate)` with raw Float32
 * frames until the returned stop function is called.
 */
export type StartCapture = (onFrame: (samples: Float32Array, sampleRate: number) => void) => Promise<() => void>;

export interface VoiceSessionSeams {
    createWebSocket?: (url: string) => VoiceWebSocket;
    startCapture?: StartCapture;
    createPlayer?: () => VoicePlayer;
}

// ─────────────────────── Default (real-browser) seams ───────────────────────

/**
 * The minimal AudioContext surface {@link PcmPlayer} uses — injectable so the
 * scheduling/flush logic is unit-testable without real audio hardware.
 */
export interface PlayerAudioContext {
    readonly currentTime: number;
    readonly destination: unknown;
    readonly sampleRate: number;
    createBuffer(channels: number, length: number, sampleRate: number): { getChannelData(channel: number): Float32Array };
    createBufferSource(): {
        buffer: unknown;
        connect(dest: unknown): void;
        start(when?: number): void;
        stop(): void;
        onended: (() => void) | null;
    };
    close?(): Promise<void>;
}

/** Half-width of the {@link StreamUpsampler} sinc kernel, in input samples. */
export const SINC_HALF_TAPS = 12;

/** Hann-windowed normalized sinc over ±{@link SINC_HALF_TAPS} input samples. */
function sincWin(v: number): number {
    if (v === 0) return 1;
    const pv = Math.PI * v;
    return (Math.sin(pv) / pv) * (0.5 + 0.5 * Math.cos(pv / SINC_HALF_TAPS));
}

/**
 * Streaming band-limited upsampler `inRate` → `outRate` (windowed-sinc
 * interpolation). Filter history and fractional phase carry across chunks, so
 * a stream split at arbitrary chunk boundaries resamples identically to the
 * unsplit stream — no boundary clicks.
 *
 * Exists because playing 16 kHz buffers through a forced-16 kHz AudioContext
 * leaves the 16k→hardware-rate conversion to the browser's output resampler,
 * and cheap interpolation there mirrors speech energy above 8 kHz — audible as
 * harsh static riding the agent's voice (SMOODEV-2668).
 */
export class StreamUpsampler {
    /** Input samples advanced per output sample (< 1 when upsampling). */
    private readonly step: number;
    private tail = new Float32Array(2 * SINC_HALF_TAPS);
    private phase = 0;

    constructor(inRate: number, outRate: number) {
        this.step = inRate / outRate;
    }

    /** Resample one chunk; returns output samples ready to schedule. */
    process(input: Float32Array): Float32Array {
        const x = new Float32Array(this.tail.length + input.length);
        x.set(this.tail);
        x.set(input, this.tail.length);
        const maxT = x.length - SINC_HALF_TAPS;
        const outLen = Math.max(0, Math.ceil((maxT - SINC_HALF_TAPS - this.phase) / this.step));
        const out = new Float32Array(outLen);
        let t = this.phase + SINC_HALF_TAPS;
        for (let o = 0; o < outLen; o++) {
            const i0 = Math.floor(t);
            const frac = t - i0;
            let acc = 0;
            // ponytail: per-sample sinc eval (~24 sin() per output sample);
            // precompute a phase table if profiling ever cares.
            for (let k = 1 - SINC_HALF_TAPS; k <= SINC_HALF_TAPS; k++) {
                acc += x[i0 + k]! * sincWin(k - frac);
            }
            out[o] = acc;
            t += this.step;
        }
        this.phase = t - maxT;
        this.tail = x.slice(x.length - 2 * SINC_HALF_TAPS);
        return out;
    }
}

/**
 * Seconds of audio pre-buffered when scheduling against a drained queue. A
 * chunk that arrives just-in-time otherwise starts exactly at the playhead and
 * the next network hiccup opens an audible gap (click).
 */
export const PLAYBACK_PRIME_S = 0.1;

/**
 * Gapless PCM playback: each incoming linear16 chunk becomes an AudioBuffer
 * scheduled back-to-back (`nextTime`) so consecutive chunks butt together with
 * no gaps. `flush()` stops every scheduled source (barge-in / mic-button stop).
 *
 * The wire is one continuous 16 kHz linear16 byte stream — frames may split
 * mid-sample, so a dangling byte is carried into the next frame (an odd-length
 * `Int16Array` view would throw and every later frame would decode one byte
 * off: pure noise). Chunks are resampled to the context's native rate via
 * {@link StreamUpsampler} rather than trusting the browser's output resampler.
 */
export class PcmPlayer implements VoicePlayer {
    private nextTime = 0;
    private pendingByte: number | null = null;
    private resampler: StreamUpsampler | null;
    private readonly live = new Set<ReturnType<PlayerAudioContext['createBufferSource']>>();

    constructor(private readonly ctx: PlayerAudioContext) {
        this.resampler = ctx.sampleRate !== VOICE_SAMPLE_RATE ? new StreamUpsampler(VOICE_SAMPLE_RATE, ctx.sampleRate) : null;
    }

    enqueue(chunk: ArrayBuffer): void {
        // Re-align to sample boundaries across frames.
        let bytes = new Uint8Array(chunk);
        if (this.pendingByte !== null) {
            const joined = new Uint8Array(bytes.length + 1);
            joined[0] = this.pendingByte;
            joined.set(bytes, 1);
            this.pendingByte = null;
            bytes = joined;
        }
        const evenLen = bytes.length & ~1;
        if (evenLen < bytes.length) this.pendingByte = bytes[bytes.length - 1]!;
        if (evenLen === 0) return;
        const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, evenLen / 2);
        let samples: Float32Array = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) samples[i] = int16[i]! / 32768;
        if (this.resampler) samples = this.resampler.process(samples);
        if (samples.length === 0) return;
        const buf = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
        buf.getChannelData(0).set(samples);
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.ctx.destination);
        const now = this.ctx.currentTime;
        const start = this.nextTime > now ? this.nextTime : now + PLAYBACK_PRIME_S;
        src.start(start);
        this.nextTime = start + samples.length / this.ctx.sampleRate;
        this.live.add(src);
        src.onended = () => this.live.delete(src);
    }

    flush(): void {
        for (const src of this.live) {
            try {
                src.stop();
            } catch {
                /* already stopped */
            }
        }
        this.live.clear();
        this.nextTime = 0;
        this.pendingByte = null;
        if (this.resampler) this.resampler = new StreamUpsampler(VOICE_SAMPLE_RATE, this.ctx.sampleRate);
    }

    close(): void {
        this.flush();
        void this.ctx.close?.();
    }
}

/** AudioWorklet processor source — posts each 128-sample mic block to the main thread. */
const CAPTURE_WORKLET_SRC = `
registerProcessor('sac-mic-capture', class extends AudioWorkletProcessor {
    process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch && ch.length > 0) {
            const copy = new Float32Array(ch);
            this.port.postMessage(copy.buffer, [copy.buffer]);
        }
        return true;
    }
});
`;

/** Real mic capture: getUserMedia → AudioWorklet (or ScriptProcessor fallback). */
const defaultStartCapture: StartCapture = async (onFrame) => {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctx) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('AudioContext is not available');
    }
    const ctx = new Ctx();
    const sampleRate = ctx.sampleRate;
    const source = ctx.createMediaStreamSource(stream);
    let disconnectNode: () => void;
    if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
        const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SRC], { type: 'text/javascript' }));
        try {
            await ctx.audioWorklet.addModule(url);
        } finally {
            URL.revokeObjectURL(url);
        }
        const node = new AudioWorkletNode(ctx, 'sac-mic-capture');
        node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => onFrame(new Float32Array(ev.data), sampleRate);
        source.connect(node);
        disconnectNode = () => node.disconnect();
    } else {
        // ponytail: deprecated ScriptProcessor fallback for browsers without AudioWorklet
        const node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (ev) => onFrame(new Float32Array(ev.inputBuffer.getChannelData(0)), sampleRate);
        source.connect(node);
        node.connect(ctx.destination); // ScriptProcessor only fires while connected
        disconnectNode = () => node.disconnect();
    }
    return () => {
        disconnectNode();
        source.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
    };
};

const defaultCreatePlayer = (): VoicePlayer => {
    const Ctx = (globalThis as { AudioContext?: new (opts?: { sampleRate?: number }) => AudioContext }).AudioContext;
    if (!Ctx) throw new Error('AudioContext is not available');
    // Native device rate — PcmPlayer upsamples 16 kHz → hardware itself
    // (SMOODEV-2668). A sub-16 kHz device rate (exotic) would need a
    // band-limiting DOWNsampler instead; force a 16 kHz context there.
    let ctx = new Ctx();
    if (ctx.sampleRate < VOICE_SAMPLE_RATE) {
        void ctx.close();
        ctx = new Ctx({ sampleRate: VOICE_SAMPLE_RATE });
    }
    return new PcmPlayer(ctx as unknown as PlayerAudioContext);
};

// ────────────────────────────── VoiceSession ────────────────────────────────

export interface VoiceSessionOptions {
    /** Full browser-voice WS endpoint (default {@link DEFAULT_VOICE_URL}). */
    url?: string;
    /** UUID of the agent to talk to. */
    agentId: string;
    /** Existing conversation id so voice resumes the same thread. */
    conversationId?: string;
    /** Optional JWT for authenticated contexts (public agents auth by Origin). */
    token?: string;
    /**
     * Agent speech (SMOODEV-2674). `false` = STT-only: the visitor speaks and
     * READS the replies — the server skips TTS entirely (no audio frames, no
     * speaking events) and only streams `reply_text`. Default `true`.
     */
    tts?: boolean;
    /**
     * RMS level (0..1) above which a mic frame counts as speech for barge-in
     * while the agent is speaking. Default 0.02 — comfortably above room noise
     * post-AGC, well below speech.
     */
    bargeInThreshold?: number;
    /**
     * Milliseconds of SUSTAINED above-threshold audio required before barge-in
     * fires. Default 200. Without this, a single 2.67ms mic frame of residual
     * echo (browser AEC is imperfect on speakers) or a cough interrupts the
     * agent — which cut off the opening greeting every time. Real speech easily
     * sustains 200ms; transient blips don't.
     */
    bargeInMinMs?: number;
    /** Injectable browser seams (tests). */
    seams?: VoiceSessionSeams;
}

export interface VoiceSessionEvents {
    onTranscriptPartial?: (text: string) => void;
    onTranscriptFinal?: (text: string) => void;
    onReplyText?: (text: string) => void;
    /** Agent TTS started/stopped playing. */
    onSpeaking?: (speaking: boolean) => void;
    onError?: (code: string) => void;
    /** The session is over (stop, server close, handoff, or error). Fires once. */
    onEnded?: () => void;
}

export type VoiceSessionState = 'idle' | 'connecting' | 'active' | 'ended';

export class VoiceSession {
    private readonly opts: VoiceSessionOptions;
    private readonly events: VoiceSessionEvents;
    private ws: VoiceWebSocket | null = null;
    private player: VoicePlayer | null = null;
    private stopCapture: (() => void) | null = null;
    private speaking = false;
    /** Sustained above-threshold audio (ms) accumulated toward a barge-in. */
    private speechRunMs = 0;
    private ended = false;
    state: VoiceSessionState = 'idle';

    constructor(opts: VoiceSessionOptions, events: VoiceSessionEvents = {}) {
        this.opts = opts;
        this.events = events;
    }

    /** Open the WS, send the start frame, and begin streaming mic audio. */
    async start(): Promise<void> {
        if (this.state !== 'idle') return;
        this.state = 'connecting';
        const url = this.opts.url ?? DEFAULT_VOICE_URL;
        const createWs = this.opts.seams?.createWebSocket ?? ((u: string) => new WebSocket(u) as unknown as VoiceWebSocket);
        const startCapture = this.opts.seams?.startCapture ?? defaultStartCapture;
        const createPlayer = this.opts.seams?.createPlayer ?? defaultCreatePlayer;

        // Mic permission FIRST — if the visitor denies it, no socket ever opens.
        this.stopCapture = await startCapture((samples, rate) => this.handleMicFrame(samples, rate));
        try {
            this.player = createPlayer();
            const ws = createWs(url);
            ws.binaryType = 'arraybuffer';
            this.ws = ws;
            ws.addEventListener('open', () => {
                const start: Record<string, unknown> = { type: 'start', agent_id: this.opts.agentId };
                if (this.opts.conversationId) start.conversation_id = this.opts.conversationId;
                if (this.opts.token) start.token = this.opts.token;
                if (this.opts.tts === false) start.tts = false;
                ws.send(JSON.stringify(start));
                this.state = 'active';
            });
            ws.addEventListener('message', (ev: MessageEvent) => this.handleServerFrame(ev.data as string | ArrayBuffer));
            ws.addEventListener('close', () => this.teardown());
            ws.addEventListener('error', () => {
                this.events.onError?.('connection_error');
                this.teardown();
            });
        } catch (err) {
            this.teardown();
            throw err;
        }
    }

    /** One raw mic frame: barge-in check, then downsample → binary frame. */
    private handleMicFrame(samples: Float32Array, sampleRate: number): void {
        const ws = this.ws;
        if (!ws || ws.readyState !== 1 /* OPEN */ || this.state !== 'active') return;
        // Barge-in: the visitor speaking over the agent's TTS interrupts it —
        // but only after SUSTAINED speech, so residual echo/coughs (a few ms)
        // don't cut off the agent (esp. the opening greeting).
        if (this.speaking) {
            if (rmsLevel(samples) > (this.opts.bargeInThreshold ?? 0.02)) {
                this.speechRunMs += (samples.length / sampleRate) * 1000;
                if (this.speechRunMs >= (this.opts.bargeInMinMs ?? 200)) {
                    this.speechRunMs = 0;
                    this.interrupt();
                }
            } else {
                this.speechRunMs = 0; // gap resets the run — echo/noise is bursty
            }
        }
        const pcm = downsampleTo16k(samples, sampleRate);
        ws.send(pcm.buffer as ArrayBuffer);
    }

    /** Route a server frame: binary = TTS audio, string = JSON control event. */
    private handleServerFrame(data: string | ArrayBuffer): void {
        if (typeof data !== 'string') {
            this.player?.enqueue(data);
            return;
        }
        let msg: { type?: string; text?: string; code?: string };
        try {
            msg = JSON.parse(data) as typeof msg;
        } catch {
            return; // not ours — ignore
        }
        switch (msg.type) {
            case 'transcript_partial':
                this.events.onTranscriptPartial?.(msg.text ?? '');
                break;
            case 'transcript_final':
                this.events.onTranscriptFinal?.(msg.text ?? '');
                break;
            case 'reply_text':
                this.events.onReplyText?.(msg.text ?? '');
                break;
            case 'speaking_started':
                this.setSpeaking(true);
                break;
            case 'speaking_done':
                this.setSpeaking(false);
                break;
            case 'handoff':
                // The agent handed the caller off — voice is over; back to text.
                this.stop();
                break;
            case 'error':
                this.events.onError?.(msg.code ?? 'unknown');
                this.stop();
                break;
            default:
                break;
        }
    }

    private setSpeaking(speaking: boolean): void {
        if (this.speaking === speaking) return;
        this.speaking = speaking;
        this.speechRunMs = 0; // fresh barge-in window per agent utterance
        this.events.onSpeaking?.(speaking);
    }

    /** True while agent TTS is playing (between speaking_started/done). */
    get isSpeaking(): boolean {
        return this.speaking;
    }

    /**
     * Barge in: tell the server the user interrupted and flush queued TTS so the
     * agent goes silent immediately. Called automatically on mic speech during
     * playback; the widget also calls it when the visitor hits the mic button
     * mid-playback.
     */
    interrupt(): void {
        if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify({ type: 'interrupt' }));
        }
        this.player?.flush();
        this.setSpeaking(false);
    }

    /** Graceful end: send `stop`, then tear everything down. */
    stop(): void {
        if (this.ws && this.ws.readyState === 1) {
            try {
                this.ws.send(JSON.stringify({ type: 'stop' }));
            } catch {
                /* socket already going down */
            }
        }
        this.teardown();
    }

    /** Idempotent teardown: capture, playback, socket, `ended` event. */
    private teardown(): void {
        if (this.ended) return;
        this.ended = true;
        this.state = 'ended';
        this.stopCapture?.();
        this.stopCapture = null;
        this.player?.close();
        this.player = null;
        const ws = this.ws;
        this.ws = null;
        if (ws && ws.readyState <= 1) {
            try {
                ws.close(1000, 'voice ended');
            } catch {
                /* already closed */
            }
        }
        this.setSpeaking(false);
        this.events.onEnded?.();
    }
}
