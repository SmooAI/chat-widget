import { afterEach, describe, expect, it } from 'vitest';
import { defineChatWidget, ELEMENT_TAG, safeHttpUrl } from './element.js';

describe('safeHttpUrl', () => {
    it('accepts absolute http(s) URLs and returns the normalized href', () => {
        expect(safeHttpUrl('https://example.com/docs')).toBe('https://example.com/docs');
        expect(safeHttpUrl('http://example.com')).toBe('http://example.com/');
    });

    it('rejects dangerous and non-absolute schemes (XSS guard)', () => {
        // eslint-disable-next-line no-script-url
        expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
        expect(safeHttpUrl('data:text/html,<script>')).toBeNull();
        expect(safeHttpUrl('vbscript:msgbox')).toBeNull();
        expect(safeHttpUrl('/relative/path')).toBeNull();
        expect(safeHttpUrl('not a url')).toBeNull();
        expect(safeHttpUrl(undefined)).toBeNull();
        expect(safeHttpUrl(null)).toBeNull();
        expect(safeHttpUrl('')).toBeNull();
    });
});

describe('<smooth-agent-chat> render', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    function mount(attrs: Record<string, string>): HTMLElement {
        defineChatWidget();
        const el = document.createElement(ELEMENT_TAG);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        document.body.appendChild(el);
        return el;
    }

    it('renders nothing until endpoint + agent-id are both set', () => {
        const el = mount({ endpoint: 'wss://e/ws' }); // missing agent-id
        expect(el.shadowRoot?.querySelector('.panel')).toBeNull();
    });

    it('renders the popover chrome: launcher, hidden panel, composer, footer', () => {
        const el = mount({ endpoint: 'wss://e/ws', 'agent-id': 'a1' });
        const sr = el.shadowRoot!;
        expect(sr.querySelector('.launcher')).not.toBeNull();
        expect(sr.querySelector('.panel')?.classList.contains('hidden')).toBe(true);
        expect(sr.querySelector('.composer textarea')).not.toBeNull();
        expect(sr.querySelector('.send')).not.toBeNull();
        expect(sr.querySelector('.footer')?.textContent).toContain('smooth');
    });

    it('uses the agent name for the title and its initial for the monogram avatar', () => {
        const el = mount({ endpoint: 'wss://e/ws', 'agent-id': 'a1', 'agent-name': 'Nova' });
        const sr = el.shadowRoot!;
        expect(sr.querySelector('.title')?.textContent).toBe('Nova');
        expect(sr.querySelector('.avatar')?.textContent?.trim()).toBe('N');
    });

    it('shows the greeting as an assistant bubble before any messages', () => {
        const el = mount({ endpoint: 'wss://e/ws', 'agent-id': 'a1', greeting: 'Welcome aboard' });
        const greet = el.shadowRoot!.querySelector('.bubble.greeting');
        expect(greet?.textContent).toBe('Welcome aboard');
    });

    it('escapes a hostile agent name instead of injecting markup', () => {
        const el = mount({ endpoint: 'wss://e/ws', 'agent-id': 'a1', 'agent-name': '<img src=x onerror=alert(1)>' });
        const sr = el.shadowRoot!;
        // No injected <img> — the name is rendered as text.
        expect(sr.querySelector('img')).toBeNull();
        expect(sr.querySelector('.title')?.textContent).toBe('<img src=x onerror=alert(1)>');
    });

    it('full-page mode drops the launcher and starts open', () => {
        const el = mount({ endpoint: 'wss://e/ws', 'agent-id': 'a1', mode: 'fullpage' });
        const sr = el.shadowRoot!;
        expect(sr.querySelector('.launcher')).toBeNull();
        expect(sr.querySelector('.panel')?.classList.contains('fullpage')).toBe(true);
        expect(sr.querySelector('.close')).toBeNull();
    });

    // Configure non-attribute options (examplePrompts / require*) before mount.
    function mountCfg(cfg: Record<string, unknown>): HTMLElement {
        defineChatWidget();
        const el = document.createElement(ELEMENT_TAG) as HTMLElement & { configure: (c: Record<string, unknown>) => void };
        el.setAttribute('endpoint', 'wss://e/ws');
        el.setAttribute('agent-id', 'a1');
        el.configure(cfg);
        document.body.appendChild(el);
        return el;
    }

    it('shows starter-prompt chips in the empty state', () => {
        const el = mountCfg({ examplePrompts: ['How do I start?', 'Pricing?'] });
        const chips = el.shadowRoot!.querySelectorAll('.chip');
        expect(chips.length).toBe(2);
        expect(chips[0]?.textContent).toBe('How do I start?');
    });

    it('gates behind the pre-chat form when a field is required', () => {
        const sr = mountCfg({ requireEmail: true }).shadowRoot!;
        expect(sr.querySelector('.pc-form')).not.toBeNull();
        expect(sr.querySelector('input[name="email"]')).not.toBeNull();
        // No composer is rendered while the gate is up.
        expect(sr.querySelector('.composer textarea')).toBeNull();
    });

    it('skips the form when anonymous chat is allowed', () => {
        const sr = mountCfg({ requireEmail: true, allowAnonymous: true }).shadowRoot!;
        expect(sr.querySelector('.pc-form')).toBeNull();
        expect(sr.querySelector('.composer textarea')).not.toBeNull();
    });

    it('ships an interrupt overlay container, hidden until a turn pauses', () => {
        const sr = mount({ endpoint: 'wss://e/ws', 'agent-id': 'a1' }).shadowRoot!;
        const overlay = sr.querySelector('.interrupt');
        expect(overlay).not.toBeNull();
        expect(overlay?.classList.contains('hidden')).toBe(true);
        expect(overlay?.childElementCount).toBe(0);
    });
});
