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

    it('full-page header defaults to the square Smooth icon (not the wide wordmark)', () => {
        const sr = mount({ endpoint: 'wss://e/ws', 'agent-id': 'a1', mode: 'fullpage' }).shadowRoot!;
        const svg = sr.querySelector('.header .avatar .logo-wrap svg');
        expect(svg).not.toBeNull();
        // The square icon has a 150×150 viewBox; the retired wordmark was 550×135.
        expect(svg?.getAttribute('viewBox')).toBe('0 0 150 150');
        // No brand <img> when no logoUrl is set.
        expect(sr.querySelector('.header .logo-img')).toBeNull();
    });

    it('full-page header renders a brand <img> when a safe logoUrl is set', () => {
        const sr = mountCfg({ mode: 'fullpage', logoUrl: 'https://cdn.example.com/logo.png' }).shadowRoot!;
        const img = sr.querySelector('.header .avatar .logo-img') as HTMLImageElement | null;
        expect(img).not.toBeNull();
        expect(img?.getAttribute('src')).toBe('https://cdn.example.com/logo.png');
        // The default icon is not rendered when a logo image takes over.
        expect(sr.querySelector('.header .avatar .logo-wrap svg')).toBeNull();
    });

    it('ignores a javascript:/data: logoUrl (XSS guard) and falls back to the icon', () => {
        // eslint-disable-next-line no-script-url
        const sr = mountCfg({ mode: 'fullpage', logoUrl: 'javascript:alert(1)' }).shadowRoot!;
        expect(sr.querySelector('.header .logo-img')).toBeNull();
        expect(sr.querySelector('.header .avatar .logo-wrap svg')?.getAttribute('viewBox')).toBe('0 0 150 150');

        const sr2 = mountCfg({ mode: 'fullpage', logoUrl: 'data:text/html,<script>alert(1)</script>' }).shadowRoot!;
        expect(sr2.querySelector('.header .logo-img')).toBeNull();
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

    describe('pre-chat phone field (libphonenumber-js, US default)', () => {
        // Mount with the phone field present (requireName forces the gate; phone
        // shows by default via collectPhone). Returns the input + its field wrapper.
        function mountPhone(cfg: Record<string, unknown> = {}): {
            el: HTMLElement;
            sr: ShadowRoot;
            input: HTMLInputElement;
            field: HTMLElement;
            hint: HTMLElement;
        } {
            const el = mountCfg({ requireName: true, ...cfg });
            const sr = el.shadowRoot!;
            const input = sr.querySelector('input[name="phone"]') as HTMLInputElement;
            const field = input.closest('.pc-field') as HTMLElement;
            const hint = field.querySelector('.pc-hint') as HTMLElement;
            return { el, sr, input, field, hint };
        }

        // jsdom doesn't synthesize InputEvent.inputType; pass it explicitly.
        function type(input: HTMLInputElement, value: string, inputType = 'insertText'): void {
            input.value = value;
            input.setSelectionRange(value.length, value.length);
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
        }

        // Stub the controller seam so submit captures setUserInfo without a real
        // WebSocket. `disconnect` is needed for the afterEach teardown (the element's
        // disconnectedCallback calls it).
        function stubController(el: HTMLElement): Array<Record<string, unknown>> {
            const captured: Array<Record<string, unknown>> = [];
            (el as unknown as { controller: unknown }).controller = {
                setUserInfo: (i: Record<string, unknown>) => captured.push(i),
                connect: () => Promise.resolve(),
                disconnect: () => {},
            };
            return captured;
        }

        it('preserves autofill-critical attributes: type=tel, autocomplete=tel, and the implicit <label>', () => {
            const { input, field } = mountPhone();
            expect(input.type).toBe('tel');
            expect(input.getAttribute('autocomplete')).toBe('tel');
            // Implicit label association: the input is nested inside its <label>.
            expect(field.tagName).toBe('LABEL');
            expect(field.querySelector('span')?.textContent).toBe('Phone');
            expect(field.contains(input)).toBe(true);
        });

        it('formats a US number as-you-type when typing at the end', () => {
            const { input } = mountPhone();
            type(input, '2133734253');
            // libphonenumber-js AsYouType('US') → "(213) 373-4253".
            expect(input.value).toBe('(213) 373-4253');
        });

        it('flags a garbage number invalid and a good number valid via the inline hint', () => {
            const { input, field, hint } = mountPhone();
            type(input, '12'); // too short → invalid
            expect(field.classList.contains('invalid')).toBe(true);
            expect(field.classList.contains('valid')).toBe(false);
            expect(hint.textContent).toBeTruthy();

            type(input, '2133734253'); // valid US number
            expect(field.classList.contains('valid')).toBe(true);
            expect(field.classList.contains('invalid')).toBe(false);
            expect(hint.textContent).toBe('');
        });

        it('empty phone is neutral (no valid/invalid) — the field is optional', () => {
            const { input, field } = mountPhone();
            type(input, '2133734253');
            type(input, '', 'deleteContentBackward');
            expect(field.classList.contains('valid')).toBe(false);
            expect(field.classList.contains('invalid')).toBe(false);
        });

        it('does not reformat while the user is deleting characters', () => {
            const { input } = mountPhone();
            type(input, '2133734253'); // → "(213) 373-4253"
            // Simulate a backspace that removed the trailing digit.
            type(input, '(213) 373-425', 'deleteContentBackward');
            // Value is left as the user typed it — we don't re-add formatting.
            expect(input.value).toBe('(213) 373-425');
        });

        it('reformats + validates a browser-autofilled value on `change`', () => {
            const { input, field } = mountPhone();
            input.value = '2133734253';
            input.dispatchEvent(new Event('change', { bubbles: true }));
            expect(input.value).toBe('(213) 373-4253');
            expect(field.classList.contains('valid')).toBe(true);
        });

        it('sends E.164 on submit when the (formatted) number is valid', () => {
            const { el, sr, input } = mountPhone();
            const captured = stubController(el);
            (sr.querySelector('input[name="name"]') as HTMLInputElement).value = 'Ada';
            type(input, '(213) 373-4253');
            (sr.querySelector('.pc-form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            expect(captured).toHaveLength(1);
            expect(captured[0]?.phone).toBe('+12133734253');
        });

        it('blocks submit on an invalid number when requirePhone is set', () => {
            const { el, sr, input, field } = mountPhone({ requirePhone: true });
            const captured = stubController(el);
            (sr.querySelector('input[name="name"]') as HTMLInputElement).value = 'Ada';
            type(input, '12'); // invalid
            const form = sr.querySelector('.pc-form') as HTMLFormElement;
            // reportValidity is unavailable in jsdom for this path; stub to true so we
            // exercise our own phone gate rather than the native required check.
            form.reportValidity = () => true;
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            expect(captured).toHaveLength(0);
            expect(field.classList.contains('invalid')).toBe(true);
        });

        it('allows submit with the raw value when phone is optional + unparseable', () => {
            const { el, sr, input } = mountPhone();
            const captured = stubController(el);
            (sr.querySelector('input[name="name"]') as HTMLInputElement).value = 'Ada';
            type(input, '12'); // invalid but optional — formatter renders it "1 2"
            const form = sr.querySelector('.pc-form') as HTMLFormElement;
            form.reportValidity = () => true;
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            // Optional → submit proceeds; the unparseable value is forwarded as-is
            // (the field's current, as-you-type-formatted text) so the backend
            // normalizes/nulls authoritatively.
            expect(captured).toHaveLength(1);
            expect(captured[0]?.phone).toBe(input.value);
            expect(captured[0]?.phone).not.toMatch(/^\+/); // not E.164 — it didn't parse
        });
    });
});

describe('mid-conversation suggested-reply chips', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    interface Msg {
        id: string;
        role: 'user' | 'assistant';
        text: string;
        streaming: boolean;
        suggestions?: string[];
    }
    interface Internals {
        messages: Msg[];
        interrupt: unknown;
        controller: { send: (t: string) => void; disconnect: () => void } | null;
        renderMessages(): void;
        renderSuggestions(): void;
    }

    // Anonymous mount → no pre-chat gate, so the composer + suggestions slot exist.
    function mountAnon(cfg: Record<string, unknown> = {}): { el: HTMLElement; sr: ShadowRoot; api: Internals } {
        defineChatWidget();
        const el = document.createElement(ELEMENT_TAG) as HTMLElement & { configure: (c: Record<string, unknown>) => void };
        el.setAttribute('endpoint', 'wss://e/ws');
        el.setAttribute('agent-id', 'a1');
        el.configure({ allowAnonymous: true, ...cfg });
        document.body.appendChild(el);
        return { el, sr: el.shadowRoot!, api: el as unknown as Internals };
    }

    const finalized = (id: string, text: string, suggestions?: string[]): Msg => ({ id, role: 'assistant', text, streaming: false, suggestions });
    const user = (id: string, text: string): Msg => ({ id, role: 'user', text, streaming: false });

    it('renders chips for the latest assistant message with suggestions', () => {
        const { sr, api } = mountAnon();
        api.messages = [user('u1', 'hi'), finalized('a1', 'Hello!', ['Book a demo', 'See pricing'])];
        api.renderMessages();
        const chips = sr.querySelectorAll('.reply-suggestions .chip');
        expect(chips.length).toBe(2);
        expect(chips[0]?.textContent).toBe('Book a demo');
        expect(chips[1]?.textContent).toBe('See pricing');
    });

    it('only shows suggestions for the LATEST message (not an earlier assistant turn)', () => {
        const { sr, api } = mountAnon();
        // Assistant turn with suggestions is followed by a newer user message.
        api.messages = [finalized('a1', 'Hello!', ['Book a demo']), user('u2', 'thanks')];
        api.renderMessages();
        expect(sr.querySelectorAll('.reply-suggestions .chip').length).toBe(0);
    });

    it('does not show suggestions while the latest assistant message is still streaming', () => {
        const { sr, api } = mountAnon();
        api.messages = [user('u1', 'hi'), { id: 'a1', role: 'assistant', text: 'Hel', streaming: true, suggestions: ['x'] }];
        api.renderMessages();
        expect(sr.querySelectorAll('.reply-suggestions .chip').length).toBe(0);
    });

    it('tapping a chip sends its text and the chips clear on the next turn', () => {
        const { sr, api } = mountAnon();
        const sent: string[] = [];
        api.controller = { send: (t: string) => sent.push(t), disconnect: () => {} };
        api.messages = [user('u1', 'hi'), finalized('a1', 'Hello!', ['Book a demo'])];
        api.renderMessages();
        (sr.querySelector('.reply-suggestions .chip') as HTMLButtonElement).click();
        expect(sent).toEqual(['Book a demo']);
        // A new turn (streaming assistant appended) replaces them → chips clear.
        api.messages = [...api.messages, user('u2', 'Book a demo'), { id: 'a2', role: 'assistant', text: '', streaming: true }];
        api.renderSuggestions();
        expect(sr.querySelectorAll('.reply-suggestions .chip').length).toBe(0);
    });

    it('hides chips while an interrupt overlay is active', () => {
        const { sr, api } = mountAnon();
        api.messages = [user('u1', 'hi'), finalized('a1', 'Hello!', ['Book a demo'])];
        api.renderMessages();
        expect(sr.querySelectorAll('.reply-suggestions .chip').length).toBe(1);
        api.interrupt = { kind: 'confirm', actionDescription: 'Do the thing' };
        api.renderSuggestions();
        expect(sr.querySelectorAll('.reply-suggestions .chip').length).toBe(0);
    });

    it('renders no chips when showSuggestedReplies is false', () => {
        const { sr, api } = mountAnon({ showSuggestedReplies: false });
        api.messages = [user('u1', 'hi'), finalized('a1', 'Hello!', ['Book a demo'])];
        api.renderMessages();
        expect(sr.querySelectorAll('.reply-suggestions .chip').length).toBe(0);
    });
});

describe('powered-by branding (link + hide-branding toggle)', () => {
    const REPO_URL = 'https://github.com/SmooAI/smooth-operator';

    afterEach(() => {
        document.body.innerHTML = '';
    });

    function mount(attrs: Record<string, string>): HTMLElement {
        defineChatWidget();
        const el = document.createElement(ELEMENT_TAG);
        el.setAttribute('endpoint', 'wss://e/ws');
        el.setAttribute('agent-id', 'a1');
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        document.body.appendChild(el);
        return el;
    }
    function mountCfg(cfg: Record<string, unknown>): HTMLElement {
        defineChatWidget();
        const el = document.createElement(ELEMENT_TAG) as HTMLElement & { configure: (c: Record<string, unknown>) => void };
        el.setAttribute('endpoint', 'wss://e/ws');
        el.setAttribute('agent-id', 'a1');
        el.configure(cfg);
        document.body.appendChild(el);
        return el;
    }

    it('by default links the composer footer to the smooth-operator repo (new tab)', () => {
        const link = mount({}).shadowRoot!.querySelector('.footer a') as HTMLAnchorElement | null;
        expect(link).not.toBeNull();
        expect(link?.getAttribute('href')).toBe(REPO_URL);
        expect(link?.getAttribute('target')).toBe('_blank');
        expect(link?.getAttribute('rel')).toContain('noopener');
        expect(link?.textContent).toContain('smooth');
    });

    it('by default shows a linked "powered by" tag in the full-page header', () => {
        const tag = mount({ mode: 'fullpage' }).shadowRoot!.querySelector('.powered') as HTMLAnchorElement | null;
        expect(tag).not.toBeNull();
        expect(tag?.tagName).toBe('A');
        expect(tag?.getAttribute('href')).toBe(REPO_URL);
        expect(tag?.getAttribute('target')).toBe('_blank');
    });

    it('hide-branding attribute drops the header tag and the footer branding link (full-page)', () => {
        const sr = mount({ mode: 'fullpage', 'hide-branding': '' }).shadowRoot!;
        expect(sr.querySelector('.powered')).toBeNull();
        // No link to the repo anywhere in the footer.
        expect(sr.querySelector('.footer a')).toBeNull();
    });

    it('hideBranding via configure() hides branding but keeps the "Restore my chats" affordance', () => {
        const sr = mountCfg({ hideBranding: true }).shadowRoot!;
        expect(sr.querySelector('.footer a')).toBeNull();
        expect(sr.querySelector('.restore-link')).not.toBeNull();
    });

    it('hide-branding with restore disabled omits the footer entirely (popover)', () => {
        const sr = mountCfg({ hideBranding: true, allowChatRestore: false }).shadowRoot!;
        expect(sr.querySelector('.powered')).toBeNull();
        expect(sr.querySelector('.footer')).toBeNull();
    });
});

describe('fullpage container sizing (composer-clip regression)', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    function mountFullpage(clientHeight: number): HTMLElement {
        defineChatWidget();
        const el = document.createElement(ELEMENT_TAG);
        // jsdom has no layout: emulate what a sized container (positive) vs an
        // auto-height <body> mount (0) resolves the host's box to.
        Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
        el.setAttribute('endpoint', 'wss://e/ws');
        el.setAttribute('agent-id', 'a1');
        el.setAttribute('mode', 'fullpage');
        document.body.appendChild(el);
        return el;
    }

    it('renders the .wrap flex chain that hands the host box to the panel', () => {
        const el = mountFullpage(600);
        expect(el.shadowRoot!.querySelector('.wrap .panel.fullpage')).not.toBeNull();
    });

    it('does NOT apply the viewport fallback when the container gives the host a box', () => {
        const el = mountFullpage(600);
        expect(el.hasAttribute('data-viewport-fallback')).toBe(false);
    });

    it('applies the viewport fallback when the container gives the host no height (bare body mount)', () => {
        const el = mountFullpage(0);
        expect(el.hasAttribute('data-viewport-fallback')).toBe(true);
    });
});
