import { describe, expect, it } from 'vitest';
import { cleanCitationSnippet, escapeHtml, renderMarkdown, safeHttpUrl } from './markdown.js';

describe('safeHttpUrl', () => {
    it('accepts absolute http(s) URLs and returns the normalized href', () => {
        expect(safeHttpUrl('https://example.com/docs')).toBe('https://example.com/docs');
        expect(safeHttpUrl('http://example.com')).toBe('http://example.com/');
    });

    it('rejects dangerous and non-absolute schemes', () => {
        // eslint-disable-next-line no-script-url
        expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
        expect(safeHttpUrl('data:text/html,<script>')).toBeNull();
        expect(safeHttpUrl('vbscript:msgbox')).toBeNull();
        expect(safeHttpUrl('/relative')).toBeNull();
        expect(safeHttpUrl('')).toBeNull();
        expect(safeHttpUrl(null)).toBeNull();
    });
});

describe('escapeHtml', () => {
    it('escapes the five HTML-significant characters', () => {
        expect(escapeHtml(`<a href="x" o='y'>&`)).toBe('&lt;a href=&quot;x&quot; o=&#39;y&#39;&gt;&amp;');
    });
});

describe('renderMarkdown — formatting', () => {
    it('renders bold, italic, and inline code', () => {
        expect(renderMarkdown('**bold**')).toBe('<p><strong>bold</strong></p>');
        expect(renderMarkdown('_em_')).toBe('<p><em>em</em></p>');
        expect(renderMarkdown('`x = 1`')).toBe('<p><code>x = 1</code></p>');
    });

    it('renders unordered lists', () => {
        const html = renderMarkdown('- one\n- two\n- three');
        expect(html).toBe('<ul><li>one</li><li>two</li><li>three</li></ul>');
    });

    it('renders ordered (numbered) lists', () => {
        const html = renderMarkdown('1. first\n2. second');
        expect(html).toBe('<ol><li>first</li><li>second</li></ol>');
    });

    it('renders safe http(s) links with target + hardened rel', () => {
        const html = renderMarkdown('see [docs](https://smoo.ai/docs)');
        expect(html).toContain('<a href="https://smoo.ai/docs" target="_blank" rel="noopener noreferrer nofollow">docs</a>');
    });

    it('downgrades headings to bold lines (no <h1>)', () => {
        const html = renderMarkdown('# Big Title\n\n## Smaller');
        expect(html).not.toMatch(/<h[1-6]/);
        expect(html).toContain('<strong>Big Title</strong>');
        expect(html).toContain('<strong>Smaller</strong>');
    });

    it('renders fenced code blocks', () => {
        const html = renderMarkdown('```\nlet a = 1;\n```');
        expect(html).toBe('<pre><code>let a = 1;</code></pre>');
    });

    it('renders blockquotes', () => {
        const html = renderMarkdown('> quoted');
        expect(html).toBe('<blockquote>quoted</blockquote>');
    });

    it('separates paragraphs on blank lines and soft-breaks within a paragraph', () => {
        expect(renderMarkdown('a\nb\n\nc')).toBe('<p>a<br>b</p><p>c</p>');
    });
});

describe('renderMarkdown — XSS / security bar', () => {
    // The security property is that no *live* markup survives. Escaped entities
    // (`&lt;img onerror=…&gt;`) are inert text and are perfectly fine — what must
    // never happen is that a `<script>`/`<img onerror>` becomes a real element.
    //
    // Two layers of proof:
    //  1. On the raw HTML string, no *unescaped* dangerous tag-open survives
    //     (a real `<script`/`<img`/`<iframe` left intact would be a hole). This
    //     deliberately checks for a tag-open (`<name`) — escaped output reads
    //     `&lt;script` so it won't match.
    //  2. Parse the output into a real DOM and assert the *live* tree carries no
    //     forbidden elements, no event-handler attributes, and only http(s)
    //     hrefs. This is the strongest check — it's what the browser actually
    //     builds.
    const assertInert = (html: string) => {
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/<img/i);
        expect(html).not.toMatch(/<iframe/i);

        const host = document.createElement('div');
        host.innerHTML = html;
        expect(host.querySelector('script, img, iframe, object, embed')).toBeNull();
        for (const el of host.querySelectorAll('*')) {
            for (const attr of el.attributes) {
                expect(attr.name.toLowerCase()).not.toMatch(/^on/); // no event handlers
                if (attr.name.toLowerCase() === 'href') {
                    expect(attr.value.toLowerCase()).toMatch(/^https?:/);
                }
            }
        }
    };

    it('escapes a raw <script> payload to inert text', () => {
        const html = renderMarkdown('<script>alert(1)</script>');
        assertInert(html);
        expect(html).toContain('&lt;script&gt;');
    });

    it('escapes a raw <img onerror> payload', () => {
        const html = renderMarkdown('<img src=x onerror=alert(1)>');
        assertInert(html);
        expect(html).toContain('&lt;img');
    });

    it('renders a markdown image as alt text only — never an <img>', () => {
        const html = renderMarkdown('![y](http://evil/x.png)');
        assertInert(html);
        expect(html).not.toContain('evil');
        expect(html).toContain('y');
    });

    it('strips a javascript: link to plain text (no anchor, no scheme)', () => {
        // eslint-disable-next-line no-script-url
        const html = renderMarkdown('[x](javascript:alert(1))');
        assertInert(html);
        expect(html).not.toContain('<a');
        expect(html).toContain('x');
    });

    it('escapes a raw <a onclick=…> payload', () => {
        const html = renderMarkdown('<a onclick="steal()">click</a>');
        assertInert(html);
        expect(html).toContain('&lt;a');
    });

    it('rejects a data: URL link', () => {
        const html = renderMarkdown('[x](data:text/html,<script>alert(1)</script>)');
        assertInert(html);
        expect(html).not.toContain('<a');
    });

    it('escapes HTML smuggled inside link text and code spans', () => {
        assertInert(renderMarkdown('[<img onerror=x>](https://ok.com)'));
        assertInert(renderMarkdown('`<script>alert(1)</script>`'));
    });

    it('escapes HTML inside list items and headings', () => {
        assertInert(renderMarkdown('- <script>alert(1)</script>'));
        assertInert(renderMarkdown('# <img src=x onerror=alert(1)>'));
    });
});

describe('cleanCitationSnippet', () => {
    it('strips a leading logo link + image and trailing boilerplate', () => {
        const raw = '[![Logo](https://x/logo.png)](https://x/) # Our Work We build great things for clients.';
        const out = cleanCitationSnippet(raw);
        expect(out).not.toContain('Logo');
        expect(out).not.toContain('logo.png');
        expect(out).not.toMatch(/^#/);
        expect(out.startsWith('Our Work') || out.startsWith('We build')).toBe(true);
    });

    it('strips a bare leading image', () => {
        expect(cleanCitationSnippet('![hero](https://x/h.png) Welcome to the site')).toBe('Welcome to the site');
    });

    it('collapses whitespace', () => {
        expect(cleanCitationSnippet('a   b\n\n  c')).toBe('a b c');
    });

    it('truncates long text at a word boundary with an ellipsis', () => {
        const long = 'word '.repeat(120).trim();
        const out = cleanCitationSnippet(long);
        expect(out.length).toBeLessThanOrEqual(262);
        expect(out.endsWith('…')).toBe(true);
        expect(out).not.toMatch(/\Sword…$/); // ended on a boundary, not mid-word
    });

    it('leaves an already-clean short snippet intact', () => {
        expect(cleanCitationSnippet('A clean excerpt.')).toBe('A clean excerpt.');
    });
});
