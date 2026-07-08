/**
 * Render tests for interleaved tool-activity blocks in element.ts.
 *
 * Drives the element's `handleMessages` hook with `ChatMessage.blocks` (as the
 * ConversationController produces when `showToolActivity` is on) and asserts the
 * DOM: prose bubbles + inline tool chips in order, chip status classes, and that
 * a plain-prose message (no blocks) is untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, MessageBlock } from './conversation.js';
import { defineChatWidget, ELEMENT_TAG } from './element.js';

interface Harness extends HTMLElement {
    handleMessages(messages: ChatMessage[], greeting: string): void;
}

function mount(): Harness {
    // Reduced-motion so the reveal snaps (no rAF pumping needed for these assertions).
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: /reduced-motion/.test(q), media: q, addEventListener() {}, removeEventListener() {} }));
    defineChatWidget();
    const el = document.createElement(ELEMENT_TAG) as Harness;
    el.setAttribute('endpoint', 'wss://e/ws');
    el.setAttribute('agent-id', 'a1');
    el.setAttribute('greeting', '');
    document.body.appendChild(el);
    return el;
}

function assistantWithBlocks(id: string, blocks: MessageBlock[], streaming: boolean): ChatMessage {
    const text = blocks.filter((b): b is Extract<MessageBlock, { kind: 'text' }> => b.kind === 'text').map((b) => b.text).join('');
    return { id, role: 'assistant', text, streaming, blocks };
}

describe('tool-activity block rendering', () => {
    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', () => 1);
        vi.stubGlobal('cancelAnimationFrame', () => {});
    });
    afterEach(() => {
        document.body.innerHTML = '';
        vi.unstubAllGlobals();
    });

    it('renders prose bubbles and tool chips interleaved in order', () => {
        const el = mount();
        el.handleMessages(
            [
                assistantWithBlocks(
                    'm1',
                    [
                        { kind: 'text', text: 'Let me check. ' },
                        { kind: 'tool', tool: { id: 't1', name: 'search', args: '{"q":"x"}', done: true, isError: false, result: 'ok' } },
                        { kind: 'text', text: 'Found it.' },
                    ],
                    false,
                ),
            ],
            '',
        );
        const strip = el.shadowRoot!.querySelector('.blocks')!;
        expect(strip).not.toBeNull();
        const kinds = [...strip.children].map((c) => (c.classList.contains('toolchip') ? 'chip' : 'bubble'));
        expect(kinds).toEqual(['bubble', 'chip', 'bubble']);
        expect(strip.querySelector('.toolchip .tn')?.textContent).toBe('search');
        expect(strip.querySelector('.toolchip')?.classList.contains('done')).toBe(true);
    });

    it('shows a running chip with a "running…" status while the tool is in flight', () => {
        const el = mount();
        el.handleMessages(
            [assistantWithBlocks('m1', [{ kind: 'tool', tool: { id: 't1', name: 'read_file', args: '{}', done: false } }], true)],
            '',
        );
        const chip = el.shadowRoot!.querySelector('.toolchip')!;
        expect(chip.classList.contains('running')).toBe(true);
        expect(chip.querySelector('.ts')?.textContent).toContain('running');
    });

    it('marks an errored tool with the error class', () => {
        const el = mount();
        el.handleMessages(
            [assistantWithBlocks('m1', [{ kind: 'tool', tool: { id: 't1', name: 'bash', args: 'ls', done: true, isError: true, result: 'boom' } }], false)],
            '',
        );
        expect(el.shadowRoot!.querySelector('.toolchip')?.classList.contains('error')).toBe(true);
    });

    it('leaves a plain-prose message on the normal single-bubble path (no .blocks strip)', () => {
        const el = mount();
        el.handleMessages([{ id: 'm1', role: 'assistant', text: 'just prose', streaming: false }], '');
        expect(el.shadowRoot!.querySelector('.blocks')).toBeNull();
        expect(el.shadowRoot!.querySelector('.bubble.assistant.md')?.textContent).toBe('just prose');
    });
});
