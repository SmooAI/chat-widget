/**
 * Unit tests for the smooth streaming reveal (rAF typewriter) in element.ts.
 *
 * We mount the real custom element, then drive its private `handleMessages`
 * hook (the same entry point the ConversationController calls on every
 * `stream_token`). A fake `requestAnimationFrame` lets us pump frames
 * deterministically and assert the reveal converges on the full text with no
 * dropped/duplicated characters, and that reduced-motion snaps instantly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from './conversation.js';
import { defineChatWidget, ELEMENT_TAG } from './element.js';

interface RevealHarness extends HTMLElement {
    handleMessages(messages: ChatMessage[], greeting: string): void;
}

// Deterministic rAF: queue callbacks, flush on demand.
let rafQueue: FrameRequestCallback[] = [];
function flushFrames(n = 200): void {
    for (let i = 0; i < n && rafQueue.length; i++) {
        const cbs = rafQueue;
        rafQueue = [];
        for (const cb of cbs) cb(performance.now());
    }
}

function assistant(id: string, text: string, streaming: boolean): ChatMessage {
    return { id, role: 'assistant', text, streaming };
}

function mount(reducedMotion: boolean): RevealHarness {
    vi.stubGlobal('matchMedia', (q: string) => ({
        matches: reducedMotion && /reduced-motion/.test(q),
        media: q,
        addEventListener() {},
        removeEventListener() {},
    }));
    defineChatWidget();
    const el = document.createElement(ELEMENT_TAG) as RevealHarness;
    el.setAttribute('endpoint', 'wss://e/ws');
    el.setAttribute('agent-id', 'a1');
    el.setAttribute('greeting', '');
    document.body.appendChild(el);
    return el;
}

function bubbleText(el: HTMLElement): string {
    const b = el.shadowRoot!.querySelector('.bubble.assistant');
    return b?.textContent ?? '';
}

describe('smooth streaming reveal', () => {
    beforeEach(() => {
        rafQueue = [];
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
            rafQueue.push(cb);
            return rafQueue.length;
        });
        vi.stubGlobal('cancelAnimationFrame', () => {});
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.unstubAllGlobals();
    });

    it('reveals the complete final text across a burst of tokens (no dropped/dup chars)', () => {
        const el = mount(false);
        const full = 'Hello, this is a streamed reply that arrives in uneven bursts of tokens.';

        // Simulate variable-size bursts: empty (typing) → growing chunks.
        el.handleMessages([assistant('m1', '', true)], '');
        el.handleMessages([assistant('m1', 'Hello, this', true)], '');
        el.handleMessages([assistant('m1', 'Hello, this is a streamed reply', true)], '');
        el.handleMessages([assistant('m1', full, true)], '');

        // Pump frames until the reveal catches up to the buffered target.
        flushFrames();
        expect(bubbleText(el)).toBe(full);

        // Finalize → markdown render snaps to the full text, no loss.
        el.handleMessages([assistant('m1', full, false)], '');
        const finalBubble = el.shadowRoot!.querySelector('.bubble.assistant.md');
        expect(finalBubble?.textContent).toBe(full);
    });

    it('mid-reveal does not show more than the buffered target', () => {
        const el = mount(false);
        el.handleMessages([assistant('m1', '', true)], '');
        el.handleMessages([assistant('m1', 'abcdefghij', true)], '');
        // After a single frame, displayed length must never exceed the target.
        flushFrames(1);
        const shown = bubbleText(el);
        expect('abcdefghij'.startsWith(shown)).toBe(true);
        expect(shown.length).toBeLessThanOrEqual(10);
    });

    it('reduced-motion snaps to the full text immediately (no animation needed)', () => {
        const el = mount(true);
        el.handleMessages([assistant('m1', '', true)], '');
        el.handleMessages([assistant('m1', 'Snap to full instantly', true)], '');
        // No frames pumped — reduced-motion must have shown everything already.
        expect(bubbleText(el)).toBe('Snap to full instantly');
        expect(rafQueue.length).toBe(0);
    });

    it('keeps the blinking cursor on the streaming bubble', () => {
        const el = mount(false);
        el.handleMessages([assistant('m1', '', true)], '');
        el.handleMessages([assistant('m1', 'partial', true)], '');
        expect(el.shadowRoot!.querySelector('.bubble.assistant.cursor')).not.toBeNull();
    });
});
