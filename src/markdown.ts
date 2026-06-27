/**
 * A tiny, safe-by-default Markdown → HTML renderer for the chat widget.
 *
 * ## Why a hand-rolled renderer (and not markdown-it / snarkdown)?
 *
 * The widget renders **untrusted** text in two places: the assistant's reply
 * (LLM output, which can echo attacker-supplied content) and citation snippets
 * (raw scraped page chunks). Today both are written via `textContent`, so
 * `**bold**`, numbered lists, and `[links](url)` show up literally. We want
 * them rendered — without re-opening the XSS hole that `textContent` was
 * guarding against.
 *
 * markdown-it with `html:false` is safe-by-default but ships ~30 kB min into
 * what is an embeddable **global** bundle, where every kilobyte is on the host
 * page's critical path. snarkdown is ~1 kB but emits raw HTML, so it would
 * require bolting on a separate sanitizer. Instead, this renderer is
 * **safe-by-construction**:
 *
 *   1. It is a *tokenizer*, not an HTML passthrough. It only ever emits a
 *      fixed allowlist of tags (`p`, `br`, `strong`, `em`, `ul`/`ol`/`li`,
 *      `code`/`pre`, `a`, `blockquote`). There is no code path that copies a
 *      tag out of the input — a literal `<script>` in the input is treated as
 *      plain text.
 *   2. **Every** text run is HTML-escaped via {@link escapeHtml} before it
 *      reaches the output. Raw `<`, `>`, `&`, `"`, `'` can never become markup.
 *   3. **Images are dropped entirely** — `![alt](src)` renders as its alt text,
 *      no `<img>` is ever produced (a scraped tracking pixel must not load).
 *   4. **Links** are gated through {@link safeHttpUrl}: only absolute `http(s)`
 *      URLs become anchors (with `target="_blank"` + a hardened `rel`);
 *      `javascript:`/`data:`/relative/etc. fall back to plain (escaped) text.
 *   5. **Headings** (`#`..`######`) are *downgraded* to bold lines — a full
 *      `<h1>` is far too large inside a chat bubble or citation card.
 *
 * The output is a string of HTML that is only ever assigned to `innerHTML` of
 * an element the caller controls; because of (1)–(4) it can only contain the
 * allowlisted, attribute-sanitized tags.
 *
 * Supported subset (deliberately small):
 *   - Paragraphs (blank-line separated) and hard/soft line breaks
 *   - `**bold**` / `__bold__`, `*italic*` / `_italic_`
 *   - `` `inline code` `` and fenced ``` ```code blocks``` ```
 *   - `- ` / `* ` / `+ ` unordered lists, `1.` ordered lists
 *   - `> ` blockquotes
 *   - `[text](http(s)://url)` links (images dropped to alt text)
 *   - `#`..`######` headings → bold line
 */

/** Escape the five HTML-significant characters so a text run can never be markup. */
export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => {
        switch (c) {
            case '&':
                return '&amp;';
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '"':
                return '&quot;';
            default:
                return '&#39;';
        }
    });
}

/**
 * Return `url` only if it is a valid absolute `http(s)` URL, else `null`.
 *
 * SECURITY: link targets here originate from untrusted content (LLM output /
 * scraped citation chunks). Allowing an arbitrary string as an `href` permits
 * `javascript:`/`data:`/`vbscript:` URLs that execute on click — a stored-XSS
 * vector. Only absolute http(s) links are rendered as anchors; anything else
 * falls back to plain text upstream.
 */
export function safeHttpUrl(url: string | undefined | null): string | null {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
    } catch {
        return null;
    }
}

// ───────────────────────────── Inline rendering ─────────────────────────────

/**
 * Render the inline span grammar of a single line/segment to safe HTML.
 *
 * Order matters: code spans are extracted first (their contents are *not*
 * further parsed), then images are stripped to alt text, then links, then
 * emphasis. Every literal text run is escaped on the way out.
 */
function renderInline(input: string): string {
    let out = '';
    let i = 0;
    const n = input.length;

    // Accumulate escaped literal text, flushing on each recognized token.
    let buf = '';
    const flush = () => {
        if (buf) {
            out += escapeHtml(buf);
            buf = '';
        }
    };

    while (i < n) {
        const ch = input[i]!;

        // Inline code: `...` — contents are literal (escaped), no nested parsing.
        if (ch === '`') {
            const end = input.indexOf('`', i + 1);
            if (end > i) {
                flush();
                out += `<code>${escapeHtml(input.slice(i + 1, end))}</code>`;
                i = end + 1;
                continue;
            }
        }

        // Image: ![alt](src) — DROPPED. Emit only the (escaped) alt text; never
        // produce an <img> (a scraped tracking pixel must not load).
        if (ch === '!' && input[i + 1] === '[') {
            const m = imageAt(input, i);
            if (m) {
                flush();
                out += renderInline(m.alt); // alt may itself contain emphasis
                i = m.end;
                continue;
            }
        }

        // Link: [text](href)
        if (ch === '[') {
            const m = linkAt(input, i);
            if (m) {
                flush();
                const safe = safeHttpUrl(m.href);
                const inner = renderInline(m.text);
                if (safe) {
                    out += `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer nofollow">${inner}</a>`;
                } else {
                    // Unsafe scheme → render as plain (already-escaped) text, no anchor.
                    out += inner;
                }
                i = m.end;
                continue;
            }
        }

        // Bold: **...** or __...__
        if ((ch === '*' && input[i + 1] === '*') || (ch === '_' && input[i + 1] === '_')) {
            const marker = ch + ch;
            const end = input.indexOf(marker, i + 2);
            if (end > i + 1) {
                flush();
                out += `<strong>${renderInline(input.slice(i + 2, end))}</strong>`;
                i = end + 2;
                continue;
            }
        }

        // Italic: *...* or _..._ (single marker, non-empty, not touching the other marker)
        if (ch === '*' || ch === '_') {
            const end = input.indexOf(ch, i + 1);
            if (end > i + 1 && input[i + 1] !== ch) {
                flush();
                out += `<em>${renderInline(input.slice(i + 1, end))}</em>`;
                i = end + 1;
                continue;
            }
        }

        buf += ch;
        i++;
    }

    flush();
    return out;
}

/** Parse a `[text](href)` link starting at `start` (`input[start] === '['`). */
function linkAt(input: string, start: number): { text: string; href: string; end: number } | null {
    const close = matchBracket(input, start);
    if (close < 0 || input[close + 1] !== '(') return null;
    const paren = input.indexOf(')', close + 2);
    if (paren < 0) return null;
    const text = input.slice(start + 1, close);
    // href is the first whitespace-delimited token inside (...) — ignore any
    // markdown "title" portion; we never render titles.
    const href = input.slice(close + 2, paren).trim().split(/\s+/)[0] ?? '';
    return { text, href, end: paren + 1 };
}

/** Parse a `![alt](src)` image starting at `start` (`input[start] === '!'`). */
function imageAt(input: string, start: number): { alt: string; end: number } | null {
    const link = linkAt(input, start + 1);
    if (!link) return null;
    return { alt: link.text, end: link.end };
}

/** Find the matching `]` for a `[` at `open`, honoring one level of nesting. */
function matchBracket(input: string, open: number): number {
    let depth = 0;
    for (let i = open; i < input.length; i++) {
        const c = input[i];
        if (c === '[') depth++;
        else if (c === ']') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

// ───────────────────────────── Block rendering ──────────────────────────────

const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*(.*)$/;

/**
 * Render a full Markdown string to safe HTML.
 *
 * @returns a string containing only the allowlisted tags described in the
 * module doc. Safe to assign to `innerHTML` of a caller-owned element.
 */
export function renderMarkdown(src: string): string {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out: string[] = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i]!;

        // Fenced code block: ```lang ... ```
        const fence = FENCE_RE.exec(line);
        if (fence) {
            const marker = fence[1]!;
            const body: string[] = [];
            i++;
            while (i < lines.length && !lines[i]!.trimStart().startsWith(marker)) {
                body.push(lines[i]!);
                i++;
            }
            if (i < lines.length) i++; // consume closing fence
            out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
            continue;
        }

        // Blank line → paragraph boundary.
        if (line.trim() === '') {
            i++;
            continue;
        }

        // Heading → downgraded to a bold line (an <h1> is too big in a bubble).
        const heading = HEADING_RE.exec(line);
        if (heading) {
            out.push(`<p><strong>${renderInline(heading[2]!)}</strong></p>`);
            i++;
            continue;
        }

        // Unordered / ordered list — consume the contiguous run.
        if (UL_RE.test(line) || OL_RE.test(line)) {
            const ordered = OL_RE.test(line) && !UL_RE.test(line);
            const re = ordered ? OL_RE : UL_RE;
            const items: string[] = [];
            while (i < lines.length) {
                const m = re.exec(lines[i]!);
                if (!m) break;
                items.push(`<li>${renderInline(m[1]!)}</li>`);
                i++;
            }
            out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
            continue;
        }

        // Blockquote — consume the contiguous run.
        if (QUOTE_RE.test(line)) {
            const quoted: string[] = [];
            while (i < lines.length) {
                const m = QUOTE_RE.exec(lines[i]!);
                if (!m) break;
                quoted.push(m[1]!);
                i++;
            }
            out.push(`<blockquote>${renderInline(quoted.join('\n')).replace(/\n/g, '<br>')}</blockquote>`);
            continue;
        }

        // Paragraph — gather consecutive non-blank, non-block lines; soft breaks → <br>.
        const para: string[] = [];
        while (i < lines.length) {
            const l = lines[i]!;
            if (
                l.trim() === '' ||
                FENCE_RE.test(l) ||
                HEADING_RE.test(l) ||
                UL_RE.test(l) ||
                OL_RE.test(l) ||
                QUOTE_RE.test(l)
            ) {
                break;
            }
            para.push(l);
            i++;
        }
        out.push(`<p>${renderInline(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }

    return out.join('');
}

// ───────────────────────── Citation-snippet cleanup ─────────────────────────

const SNIPPET_MAX = 260;

/**
 * Clean a raw scraped citation snippet into a short, readable excerpt.
 *
 * Scraped chunks frequently begin with page boilerplate — a logo image wrapped
 * in a link, standalone nav, repeated whitespace — e.g.
 * `[![Logo](…)](…) # Our Work We build…`. The source itself is already linked
 * from the citation card, so the snippet only needs to be a clean teaser.
 *
 * Steps:
 *   1. Strip a leading image / logo-link (`[![…](…)](…)` or `![…](…)`).
 *   2. Drop a leading standalone heading marker (`#`/`##`).
 *   3. Collapse all runs of whitespace to single spaces.
 *   4. Truncate to ~{@link SNIPPET_MAX} chars at a word boundary, adding `…`.
 *
 * The result is still rendered through {@link renderMarkdown} downstream, so any
 * remaining inline markup (bold/links) stays safe.
 */
export function cleanCitationSnippet(raw: string): string {
    let s = raw ?? '';

    // Repeatedly peel leading boilerplate tokens.
    let changed = true;
    while (changed) {
        changed = false;
        const before = s;
        // Leading linked image: [![alt](imgsrc)](href)
        s = s.replace(/^\s*\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*/, '');
        // Leading bare image: ![alt](src)
        s = s.replace(/^\s*!\[[^\]]*\]\([^)]*\)\s*/, '');
        // Leading heading marker(s): "# ", "## " (keep the heading text)
        s = s.replace(/^\s*#{1,6}\s+/, '');
        if (s !== before) changed = true;
    }

    // Collapse whitespace.
    s = s.replace(/\s+/g, ' ').trim();

    // Truncate at a word boundary.
    if (s.length > SNIPPET_MAX) {
        const cut = s.slice(0, SNIPPET_MAX);
        const lastSpace = cut.lastIndexOf(' ');
        s = (lastSpace > SNIPPET_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
    }

    return s;
}
