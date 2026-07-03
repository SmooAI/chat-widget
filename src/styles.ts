import type { ChatWidgetMode, ResolvedTheme } from './config.js';

/**
 * Render the widget's scoped stylesheet — the "Aurora Glass" design system.
 *
 * Every brand value is injected as a CSS custom property on `:host` so a host
 * page can override colors per-instance and the rules below stay static. Two
 * extra tokens are *derived in CSS* from the brand vars so they adapt to any
 * theme (light or dark) without the caller supplying them:
 *
 *   --sac-primary-2  a darker shade of `primary`, used as the second stop of the
 *                    launcher / send / user-bubble gradients (depth without a
 *                    second brand input).
 *   --sac-surface-2  a faint wash derived from `text`, used for inset chrome
 *                    (composer field, close button, source cards). On a dark
 *                    panel it reads as a light overlay; on a light panel, dark.
 *
 * Deliberately framework-light: no Tailwind, no runtime CSS-in-JS — just a string
 * the web component drops into its shadow root. Modern color features
 * (`color-mix`) are used intentionally; the widget targets evergreen browsers.
 *
 * `mode` switches host positioning + panel sizing between the floating popover
 * (default) and the full-page layout (fills its container/viewport).
 */
export function buildStyles(theme: ResolvedTheme, mode: ChatWidgetMode = 'popover'): string {
    return `
:host {
    --sac-text: ${theme.text};
    --sac-bg: ${theme.background};
    --sac-primary: ${theme.primary};
    --sac-primary-text: ${theme.primaryText};
    --sac-assistant-bubble: ${theme.assistantBubble};
    --sac-assistant-bubble-text: ${theme.assistantBubbleText};
    --sac-user-bubble: ${theme.userBubble};
    --sac-user-bubble-text: ${theme.userBubbleText};
    --sac-border: ${theme.border};

    /* Derived tokens — adapt to any brand color without a second input. */
    --sac-primary-2: color-mix(in srgb, var(--sac-primary) 78%, #000 22%);
    --sac-surface-2: color-mix(in srgb, var(--sac-text) 5%, transparent);
    --sac-radius: 22px;
    --sac-ease: cubic-bezier(.16, 1, .3, 1);

    ${
        mode === 'fullpage'
            ? `/* Full-page: fill the host's box (sized by its container, else the viewport). */
    display: flex;
    flex-direction: column;
    position: relative;
    width: 100%;
    height: 100%;`
            : `/* Popover: float in the bottom-right corner. */
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483000;`
    }
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
}
${
    mode === 'fullpage'
        ? `
/* Viewport fallback — the element sets this attribute only when the host's
   container gives it no resolved height (e.g. mounted straight into an
   auto-height <body>). A sized container always wins, so an embed inside a
   fixed-height box never overflows it (composer stays visible). */
:host([data-viewport-fallback]) { min-height: 100dvh; }
/* The render wrapper passes the host's box down to the panel via flex. */
.wrap {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
}
`
        : ''
}
* { box-sizing: border-box; }

/* ───────────────────────────── Launcher ───────────────────────────── */
.launcher {
    position: relative;
    width: 62px;
    height: 62px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    padding: 0;
    background: radial-gradient(120% 120% at 30% 20%,
        color-mix(in srgb, var(--sac-primary) 78%, #fff 22%) 0%,
        var(--sac-primary) 42%,
        var(--sac-primary-2) 130%);
    color: var(--sac-primary-text);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow:
        0 1px 0 rgba(255, 255, 255, .25) inset,
        0 10px 24px -6px color-mix(in srgb, var(--sac-primary) 55%, transparent),
        0 18px 50px -12px rgba(0, 0, 0, .6);
    transition: transform .45s var(--sac-ease), box-shadow .45s var(--sac-ease), opacity .3s ease;
    isolation: isolate;
}
/* Breathing presence ring. */
.launcher::before {
    content: '';
    position: absolute;
    inset: -6px;
    border-radius: 50%;
    z-index: -1;
    background: radial-gradient(closest-side, color-mix(in srgb, var(--sac-primary) 45%, transparent), transparent 75%);
    animation: sac-breathe 3.4s ease-in-out infinite;
}
@keyframes sac-breathe { 0%, 100% { transform: scale(1); opacity: .55 } 50% { transform: scale(1.28); opacity: 0 } }
.launcher:hover {
    transform: translateY(-3px) scale(1.06);
    box-shadow:
        0 1px 0 rgba(255, 255, 255, .3) inset,
        0 16px 30px -6px color-mix(in srgb, var(--sac-primary) 60%, transparent),
        0 26px 60px -14px rgba(0, 0, 0, .7);
}
.launcher:active { transform: translateY(-1px) scale(.98); }
.launcher .ico { width: 27px; height: 27px; display: block; transition: transform .4s var(--sac-ease); }
.launcher:hover .ico { transform: rotate(-6deg) scale(1.04); }
.launcher.hidden { opacity: 0; transform: scale(.4) translateY(10px); pointer-events: none; }

/* ─────────────────────────────── Panel ────────────────────────────── */
.panel {
    width: 390px;
    max-width: calc(100vw - 40px);
    height: 600px;
    max-height: calc(100vh - 56px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: var(--sac-radius);
    background: linear-gradient(180deg, color-mix(in srgb, var(--sac-bg) 92%, #fff 8%) 0%, var(--sac-bg) 22%);
    color: var(--sac-text);
    border: 1px solid color-mix(in srgb, var(--sac-border) 80%, transparent);
    box-shadow:
        0 0 0 1px rgba(255, 255, 255, .03) inset,
        0 40px 80px -24px rgba(0, 0, 0, .65),
        0 16px 40px -20px rgba(0, 0, 0, .5);
    transform-origin: bottom right;
    animation: sac-panel-in .5s var(--sac-ease) both;
    position: relative;
}
@keyframes sac-panel-in { from { opacity: 0; transform: translateY(16px) scale(.92) } to { opacity: 1; transform: none } }
.panel.hidden { display: none; }
/* Ambient brand glow bleeding from the top of the panel. */
.panel::before {
    content: '';
    position: absolute;
    left: 0; right: 0; top: 0;
    height: 140px;
    pointer-events: none;
    background: radial-gradient(120% 100% at 50% 0%, color-mix(in srgb, var(--sac-primary) 22%, transparent), transparent 70%);
}
/* Full-page: the panel becomes the whole surface — it follows the host's box
   (via the .wrap flex chain), never a hardcoded viewport unit. */
.panel.fullpage {
    width: 100%;
    flex: 1;
    height: auto;
    min-height: 0;
    max-width: none;
    max-height: none;
    border: none;
    border-radius: 0;
    box-shadow: none;
    animation: none;
}

/* ─────────────────────────────── Header ───────────────────────────── */
.header {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 16px 14px;
}
.avatar {
    width: 40px;
    height: 40px;
    border-radius: 13px;
    flex: none;
    background: linear-gradient(140deg, var(--sac-primary), var(--sac-primary-2));
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--sac-primary-text);
    box-shadow:
        0 6px 16px -6px color-mix(in srgb, var(--sac-primary) 60%, transparent),
        0 1px 0 rgba(255, 255, 255, .25) inset;
}
.avatar svg { width: 22px; height: 22px; }
.avatar .logo-wrap { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
.avatar .logo { height: 22px; width: auto; display: block; }
.avatar .logo-img { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; display: block; border-radius: 9px; }
.meta { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.title { font-weight: 650; font-size: 15.5px; letter-spacing: -.01em; line-height: 1.1; }
.status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: color-mix(in srgb, var(--sac-text) 62%, transparent);
}
.dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    flex: none;
    background: #34d399;
    color: #34d399;
    box-shadow: 0 0 0 0 rgba(52, 211, 153, .6);
    animation: sac-pulse 2.4s ease-out infinite;
}
.dot.connecting { background: #fbbf24; color: #fbbf24; animation: sac-pulse 1.1s ease-out infinite; }
.dot.error { background: #f87171; color: #f87171; animation: none; }
.dot.off { background: #94a3b8; color: #94a3b8; animation: none; }
@keyframes sac-pulse {
    0% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 55%, transparent) }
    70% { box-shadow: 0 0 0 6px transparent }
    100% { box-shadow: 0 0 0 0 transparent }
}
.close {
    margin-left: auto;
    width: 32px; height: 32px;
    border-radius: 10px;
    border: none;
    cursor: pointer;
    background: var(--sac-surface-2);
    color: inherit;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background .2s ease, transform .2s ease;
}
.close:hover { background: color-mix(in srgb, var(--sac-text) 12%, transparent); transform: translateY(1px); }
.close svg { width: 16px; height: 16px; opacity: .8; }
.powered { margin-left: auto; font-size: 10.5px; letter-spacing: .02em; opacity: .6; color: inherit; text-decoration: none; }
.powered:hover { opacity: .85; text-decoration: underline; }
.header-sep { height: 1px; margin: 0 16px; background: linear-gradient(90deg, transparent, var(--sac-border), transparent); }

/* Full-page header: taller, logo-led, no close. */
.panel.fullpage .header { padding: 18px 22px; }
.panel.fullpage .avatar { width: 44px; height: 44px; }
.panel.fullpage .avatar .logo { height: 26px; }
.panel.fullpage .avatar svg { width: 28px; height: 28px; }

/* ────────────────────────────── Messages ──────────────────────────── */
.messages {
    flex: 1;
    overflow-y: auto;
    padding: 18px 16px 8px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    scroll-behavior: smooth;
}
.messages::-webkit-scrollbar { width: 8px; }
.messages::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--sac-text) 14%, transparent);
    border-radius: 99px;
    border: 2px solid transparent;
    background-clip: padding-box;
}
.messages::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--sac-text) 24%, transparent);
    background-clip: padding-box;
}

.row {
    display: flex;
    gap: 9px;
    max-width: 88%;
    animation: sac-msg-in .42s var(--sac-ease) both;
}
@keyframes sac-msg-in { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
.row.user { align-self: flex-end; flex-direction: row-reverse; }
.row.assistant { align-self: flex-start; }
.mini {
    width: 26px; height: 26px;
    border-radius: 9px;
    flex: none;
    align-self: flex-end;
    background: linear-gradient(140deg, var(--sac-primary), var(--sac-primary-2));
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--sac-primary-text);
}
.mini svg { width: 15px; height: 15px; }

.bubble {
    padding: 11px 14px;
    border-radius: 16px;
    font-size: 14px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    position: relative;
}
.bubble.assistant {
    background: linear-gradient(180deg, color-mix(in srgb, var(--sac-assistant-bubble) 86%, #fff 5%), var(--sac-assistant-bubble));
    color: var(--sac-assistant-bubble-text);
    border: 1px solid color-mix(in srgb, var(--sac-text) 8%, transparent);
    border-bottom-left-radius: 5px;
    box-shadow: 0 2px 8px -4px rgba(0, 0, 0, .4);
}
.bubble.user {
    background: linear-gradient(165deg,
        color-mix(in srgb, var(--sac-user-bubble) 88%, #fff 12%),
        var(--sac-user-bubble) 60%,
        color-mix(in srgb, var(--sac-user-bubble) 80%, var(--sac-primary-2) 20%));
    color: var(--sac-user-bubble-text);
    border-bottom-right-radius: 5px;
    box-shadow: 0 6px 16px -8px color-mix(in srgb, var(--sac-primary) 50%, transparent);
}
.bubble.greeting {
    background: transparent;
    border: 1px dashed color-mix(in srgb, var(--sac-text) 14%, transparent);
    color: color-mix(in srgb, var(--sac-text) 80%, transparent);
    box-shadow: none;
}

/* Typing indicator (assistant bubble with no text yet). */
.bubble.typing { display: flex; gap: 4px; padding: 14px 15px; }
.bubble.typing i {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--sac-assistant-bubble-text) 55%, transparent);
    animation: sac-typing 1.3s ease-in-out infinite;
}
.bubble.typing i:nth-child(2) { animation-delay: .18s; }
.bubble.typing i:nth-child(3) { animation-delay: .36s; }
@keyframes sac-typing { 0%, 60%, 100% { transform: translateY(0); opacity: .4 } 30% { transform: translateY(-5px); opacity: 1 } }

.cursor::after {
    content: '';
    display: inline-block;
    width: 2px; height: 1.05em;
    margin-left: 2px;
    vertical-align: -2px;
    border-radius: 2px;
    background: currentColor;
    animation: sac-blink 1s steps(2, start) infinite;
}
@keyframes sac-blink { to { opacity: 0 } }

/* ─────────────── Rendered markdown (assistant bubbles / snippets) ─────────── */
/* The renderer (markdown.ts) emits a small allowlisted set of tags; these rules
   keep them legible inside the tight Aurora-Glass bubble + citation card. */
/* Block-level markdown drives its own spacing/wrapping, so opt out of the
   bubble's pre-wrap (which would otherwise add stray blank lines). */
.bubble.md { white-space: normal; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 8px; }
.md ul, .md ol { margin: 6px 0 8px; padding-left: 20px; }
.md li { margin: 2px 0; }
.md li::marker { color: color-mix(in srgb, var(--sac-primary) 75%, transparent); }
.md a {
    color: color-mix(in srgb, var(--sac-primary) 92%, #fff);
    text-decoration: underline;
    text-underline-offset: 2px;
    word-break: break-word;
}
.md a:hover { text-decoration: none; }
.md strong { font-weight: 700; }
.md em { font-style: italic; }
.md code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: .9em;
    padding: 1px 5px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--sac-text) 10%, transparent);
}
.md pre {
    margin: 6px 0 8px;
    padding: 9px 11px;
    border-radius: 9px;
    overflow-x: auto;
    background: color-mix(in srgb, var(--sac-text) 9%, transparent);
    border: 1px solid color-mix(in srgb, var(--sac-text) 8%, transparent);
}
.md pre code { padding: 0; background: none; font-size: 12px; line-height: 1.45; }
.md blockquote {
    margin: 6px 0;
    padding: 2px 0 2px 11px;
    border-left: 2px solid color-mix(in srgb, var(--sac-primary) 55%, transparent);
    color: color-mix(in srgb, var(--sac-text) 78%, transparent);
}

/* Full-page: center the conversation in a readable column. */
.panel.fullpage .messages { padding: 26px 20px; }
.panel.fullpage .row { max-width: 760px; width: 100%; margin-left: auto; margin-right: auto; }
.panel.fullpage .row.user { max-width: 80%; margin-right: 0; }

/* ───────────────── Sources (grounding citations) ──────────────────── */
.sources {
    align-self: flex-start;
    max-width: 88%;
    margin: -4px 0 0 35px;
}
.panel.fullpage .sources { max-width: 760px; width: 100%; margin-left: auto; margin-right: auto; }
.sources summary {
    cursor: pointer;
    list-style: none;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    font-weight: 600;
    color: color-mix(in srgb, var(--sac-text) 70%, transparent);
    padding: 5px 0;
    user-select: none;
}
.sources summary::-webkit-details-marker { display: none; }
.sources .chev { transition: transform .2s var(--sac-ease); flex: none; }
.sources details[open] .chev { transform: rotate(90deg); }
.sources .count {
    background: color-mix(in srgb, var(--sac-primary) 18%, transparent);
    color: color-mix(in srgb, var(--sac-primary) 92%, #fff);
    font-size: 10.5px;
    font-weight: 700;
    padding: 1px 7px;
    border-radius: 99px;
}
.sources ol { list-style: none; margin: 6px 0 2px; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.sources li {
    background: var(--sac-surface-2);
    border: 1px solid color-mix(in srgb, var(--sac-border) 70%, transparent);
    border-left: 2px solid var(--sac-primary);
    border-radius: 9px;
    padding: 8px 10px;
}
.sources .src-title {
    color: color-mix(in srgb, var(--sac-primary) 92%, #fff);
    font-weight: 600;
    font-size: 12.5px;
    text-decoration: none;
    word-break: break-word;
}
.sources a.src-title:hover { text-decoration: underline; }
.sources span.src-title { color: var(--sac-text); opacity: .95; }
.sources .src-snippet {
    display: block;
    margin-top: 3px;
    font-size: 11.5px;
    line-height: 1.45;
    color: color-mix(in srgb, var(--sac-text) 55%, transparent);
    white-space: normal;
}

/* ────────────────────────────── Composer ──────────────────────────── */
.composer-wrap { padding: 12px 14px calc(12px + env(safe-area-inset-bottom)); }
.composer {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 7px 7px 7px 14px;
    border-radius: 18px;
    background: var(--sac-surface-2);
    border: 1px solid color-mix(in srgb, var(--sac-border) 80%, transparent);
    transition: border-color .25s ease, box-shadow .25s ease, background .25s ease;
}
.composer:focus-within {
    border-color: color-mix(in srgb, var(--sac-primary) 60%, transparent);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--sac-primary) 14%, transparent);
}
.composer textarea {
    flex: 1;
    resize: none;
    border: none;
    background: transparent;
    color: var(--sac-text);
    font-family: inherit;
    font-size: 14px;
    line-height: 1.45;
    max-height: 120px;
    padding: 6px 0;
    outline: none;
}
.composer textarea::placeholder { color: color-mix(in srgb, var(--sac-text) 42%, transparent); }
.send {
    width: 38px; height: 38px;
    flex: none;
    border: none;
    border-radius: 13px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(150deg, var(--sac-primary), var(--sac-primary-2));
    color: var(--sac-primary-text);
    box-shadow:
        0 6px 14px -6px color-mix(in srgb, var(--sac-primary) 65%, transparent),
        0 1px 0 rgba(255, 255, 255, .25) inset;
    transition: transform .2s var(--sac-ease), box-shadow .2s var(--sac-ease), opacity .2s ease;
}
.send svg { width: 18px; height: 18px; }
.send:hover { transform: translateY(-1px) scale(1.05); }
.send:active { transform: scale(.94); }
.send:disabled { opacity: .4; cursor: default; transform: none; box-shadow: none; }
.footer {
    text-align: center;
    margin-top: 9px;
    font-size: 10.5px;
    letter-spacing: .04em;
    color: color-mix(in srgb, var(--sac-text) 38%, transparent);
}
.footer b { font-weight: 600; color: color-mix(in srgb, var(--sac-text) 55%, transparent); }
.footer a { color: inherit; text-decoration: none; }
.footer a:hover { text-decoration: underline; }

/* ─────────────────── Pre-chat identity form ───────────────────────── */
.prechat { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 18px; padding: 22px 20px; }
.pc-head { text-align: center; }
.pc-title { font-size: 17px; font-weight: 650; letter-spacing: -.01em; }
.pc-sub { margin-top: 4px; font-size: 13px; color: color-mix(in srgb, var(--sac-text) 60%, transparent); }
.pc-form { display: flex; flex-direction: column; gap: 12px; }
.pc-field { display: flex; flex-direction: column; gap: 5px; }
.pc-field span { font-size: 12px; font-weight: 600; color: color-mix(in srgb, var(--sac-text) 70%, transparent); }
.pc-field input {
    border: 1px solid color-mix(in srgb, var(--sac-border) 80%, transparent);
    background: var(--sac-surface-2);
    color: var(--sac-text);
    border-radius: 12px;
    padding: 11px 13px;
    font-family: inherit;
    font-size: 14px;
    outline: none;
    transition: border-color .2s ease, box-shadow .2s ease;
}
.pc-field input::placeholder { color: color-mix(in srgb, var(--sac-text) 42%, transparent); }
.pc-field input:focus {
    border-color: color-mix(in srgb, var(--sac-primary) 60%, transparent);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--sac-primary) 14%, transparent);
}
/* Inline phone validity — subtle, themed. Empty stays neutral (optional field). */
.pc-field.valid input {
    border-color: color-mix(in srgb, var(--sac-primary) 55%, #2faa6a 45%);
}
.pc-field.invalid input {
    border-color: color-mix(in srgb, #e2566b 62%, var(--sac-border) 38%);
}
.pc-field.invalid input:focus {
    box-shadow: 0 0 0 4px color-mix(in srgb, #e2566b 16%, transparent);
}
.pc-field .pc-hint {
    min-height: 13px;
    margin-top: 1px;
    font-size: 11.5px;
    font-weight: 500;
    line-height: 1.2;
    color: color-mix(in srgb, #e2566b 78%, var(--sac-text) 22%);
}
.pc-submit {
    margin-top: 4px;
    border: none;
    border-radius: 13px;
    padding: 12px;
    cursor: pointer;
    background: linear-gradient(150deg, var(--sac-primary), var(--sac-primary-2));
    color: var(--sac-primary-text);
    font-weight: 650;
    font-size: 14px;
    box-shadow: 0 6px 14px -6px color-mix(in srgb, var(--sac-primary) 65%, transparent), 0 1px 0 rgba(255, 255, 255, .25) inset;
    transition: transform .2s var(--sac-ease);
}
.pc-submit:hover { transform: translateY(-1px); }
.pc-submit:active { transform: scale(.98); }
.pc-consents { display: flex; flex-direction: column; gap: 9px; margin-top: 2px; }
.pc-consent { display: flex; align-items: flex-start; gap: 9px; cursor: pointer; }
.pc-consent input {
    margin-top: 2px;
    width: 16px;
    height: 16px;
    flex: 0 0 auto;
    accent-color: var(--sac-primary);
    cursor: pointer;
}
.pc-consent span { font-size: 12px; line-height: 1.4; color: color-mix(in srgb, var(--sac-text) 72%, transparent); }

/* ─────────────────── Starter-prompt chips ─────────────────────────── */
.prompts { display: flex; flex-wrap: wrap; gap: 8px; margin: 2px 0 2px 35px; }
.panel.fullpage .prompts { margin-left: auto; margin-right: auto; max-width: 760px; width: 100%; }
.chip {
    border: 1px solid color-mix(in srgb, var(--sac-border) 80%, transparent);
    background: var(--sac-surface-2);
    color: var(--sac-text);
    border-radius: 999px;
    padding: 8px 13px;
    font-family: inherit;
    font-size: 12.5px;
    cursor: pointer;
    text-align: left;
    transition: border-color .2s ease, background .2s ease, transform .2s ease;
}
.chip:hover {
    border-color: color-mix(in srgb, var(--sac-primary) 50%, transparent);
    background: color-mix(in srgb, var(--sac-primary) 10%, var(--sac-surface-2));
    transform: translateY(-1px);
}

/* ───────────── Mid-conversation suggested-reply chips ─────────────── */
.reply-suggestions { padding: 0 14px 4px; }
.reply-suggestions:empty { display: none; }

/* ─────────────── OTP / tool-confirmation interrupt ────────────────── */
.interrupt { padding: 0 14px; }
.int-card {
    border: 1px solid color-mix(in srgb, var(--sac-primary) 35%, var(--sac-border));
    background: color-mix(in srgb, var(--sac-primary) 8%, var(--sac-surface-2));
    border-radius: 14px;
    padding: 12px 13px;
    animation: sac-msg-in .3s var(--sac-ease) both;
}
.int-head { display: flex; align-items: center; gap: 8px; }
.int-ico { display: flex; color: var(--sac-primary); }
.int-ico svg { width: 17px; height: 17px; }
.int-title { font-size: 13.5px; font-weight: 650; }
.int-desc { margin-top: 5px; font-size: 12.5px; line-height: 1.45; color: color-mix(in srgb, var(--sac-text) 80%, transparent); }
.int-sent { margin-top: 6px; font-size: 11.5px; color: color-mix(in srgb, var(--sac-text) 60%, transparent); }
.int-row { display: flex; gap: 8px; margin-top: 10px; }
.int-input {
    flex: 1;
    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--sac-border) 80%, transparent);
    background: var(--sac-bg);
    color: var(--sac-text);
    border-radius: 10px;
    padding: 9px 11px;
    font-family: inherit;
    font-size: 14px;
    letter-spacing: .14em;
    outline: none;
    transition: border-color .2s ease, box-shadow .2s ease;
}
.int-input:focus {
    border-color: color-mix(in srgb, var(--sac-primary) 60%, transparent);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--sac-primary) 14%, transparent);
}
.int-btn {
    border: 1px solid color-mix(in srgb, var(--sac-border) 80%, transparent);
    background: var(--sac-surface-2);
    color: var(--sac-text);
    border-radius: 10px;
    padding: 9px 14px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: transform .2s var(--sac-ease), background .2s ease, border-color .2s ease;
}
.int-btn:hover { transform: translateY(-1px); }
.int-btn.primary {
    border: none;
    background: linear-gradient(150deg, var(--sac-primary), var(--sac-primary-2));
    color: var(--sac-primary-text);
    box-shadow: 0 6px 14px -6px color-mix(in srgb, var(--sac-primary) 65%, transparent);
}
.int-row .int-btn { flex: 1; }
.int-row .int-input + .int-btn { flex: 0 0 auto; }
.int-error { margin-top: 8px; font-size: 12px; color: #f87171; }
.int-card { position: relative; }
.int-close {
    position: absolute;
    top: 8px;
    right: 9px;
    border: none;
    background: transparent;
    color: color-mix(in srgb, var(--sac-text) 55%, transparent);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 6px;
    transition: color .2s ease, background .2s ease;
}
.int-close:hover { color: var(--sac-text); background: color-mix(in srgb, var(--sac-text) 8%, transparent); }

/* ─────────────── Cross-device "Restore my chats" ──────────────────── */
.restore-link {
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    font-size: 10.5px;
    letter-spacing: .04em;
    color: color-mix(in srgb, var(--sac-primary) 80%, var(--sac-text));
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
}
.restore-link:hover { color: var(--sac-primary); }
.restore-list { display: flex; flex-direction: column; gap: 7px; margin-top: 9px; }
.restore-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    text-align: left;
    border: 1px solid color-mix(in srgb, var(--sac-border) 80%, transparent);
    background: var(--sac-bg);
    color: var(--sac-text);
    border-radius: 10px;
    padding: 9px 11px;
    font-family: inherit;
    font-size: 12.5px;
    cursor: pointer;
    transition: border-color .2s ease, background .2s ease, transform .2s ease;
}
.restore-item:hover {
    border-color: color-mix(in srgb, var(--sac-primary) 50%, transparent);
    background: color-mix(in srgb, var(--sac-primary) 8%, var(--sac-bg));
    transform: translateY(-1px);
}
.restore-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.restore-when { flex: 0 0 auto; font-size: 11px; color: color-mix(in srgb, var(--sac-text) 55%, transparent); }

.hidden { display: none !important; }

@media (prefers-reduced-motion: reduce) {
    .launcher::before, .dot, .bubble.typing i { animation: none !important; }
    .panel, .row, .launcher, .send, .close { animation: none !important; transition: none !important; }
}
`;
}
