<div align="center">

# @smooai/chat-widget

### Embeddable AI chat as a framework-light web component.

**Streaming replies · grounded sources · popover or full-page · inherits _your_ brand color.**

[![npm](https://img.shields.io/npm/v/@smooai/chat-widget?color=00a6a6&label=npm)](https://www.npmjs.com/package/@smooai/chat-widget)
[![CI](https://github.com/SmooAI/chat-widget/actions/workflows/ci.yml/badge.svg)](https://github.com/SmooAI/chat-widget/actions/workflows/ci.yml)
[![bundle](https://img.shields.io/badge/gzip-~19%20kB-4f8bff)](https://github.com/SmooAI/chat-widget)
[![license](https://img.shields.io/badge/license-MIT-8b5cf6)](./LICENSE)

</div>

---

`<smooth-agent-chat>` is a self-contained chat web component for the
[smooth-operator](https://github.com/SmooAI/smooth-operator) protocol. Drop in one
`<script>` tag (or import the ESM module) and you get a polished, streaming,
shadow-DOM-isolated chat experience — **the "Aurora Glass" design** — that adapts
to any host brand from a single accent color.

No React on the host page. No CSS to import. ~19 kB gzipped, protocol client included.

```html
<script src="https://unpkg.com/@smooai/chat-widget/dist/chat-widget.global.js"></script>
<smooth-agent-chat endpoint="wss://your-host/ws" agent-id="…" agent-name="Support"></smooth-agent-chat>
```

> **Live demo:** open [`index.html`](./index.html) (it runs entirely in the browser
> against an in-page mock of the protocol — no backend needed).

## Why this widget

- **Aurora Glass design** — a spring launcher with a live presence pulse, a
  glass-depth panel, gradient brand avatar + status dot, an animated typing
  indicator, message rise-in, refined source cards, and an icon composer.
- **Brand-adaptive** — pass one `primary` color and the gradients, bubbles, glow,
  and depth shades derive themselves. Works light or dark.
- **Streaming + sources** — token-by-token replies with a typing indicator and a
  collapsible "Sources" disclosure for knowledge-grounded answers.
- **Popover or full-page** — a floating launcher, or a full-bleed `/chat` surface.
  Same component, one attribute.
- **Framework-light & isolated** — a standard custom element with Shadow-DOM style
  isolation. Use it with React, Vue, Svelte, Astro, or no framework at all.
- **Secure by construction** — message + citation text is rendered via
  `textContent`, and citation links are restricted to `http(s)` (no
  `javascript:`/`data:` XSS).

## Install

```bash
pnpm add @smooai/chat-widget
# or: npm i @smooai/chat-widget  ·  yarn add @smooai/chat-widget
```

`@smooai/smooth-operator` (the protocol client) is a runtime dependency and is
installed automatically.

## Quick start

### 1. Declarative — a `<script>` tag + the element

```html
<script src="https://unpkg.com/@smooai/chat-widget/dist/chat-widget.global.js"></script>

<smooth-agent-chat
    endpoint="wss://your-host/ws"
    agent-id="11111111-1111-4111-8111-111111111111"
    agent-name="Support"
    greeting="Hi! How can I help?"
></smooth-agent-chat>
```

The IIFE bundle auto-registers the element on load.

### 2. Programmatic — bundler / ESM

```ts
import { mountChatWidget } from '@smooai/chat-widget';

const widget = mountChatWidget({
    endpoint: 'wss://your-host/ws',
    agentId: '11111111-1111-4111-8111-111111111111',
    agentName: 'Support',
    theme: { primary: '#8b5cf6' },
});

// Drive it imperatively:
widget.openChat();
widget.closeChat();
```

Or register the element and place it yourself:

```ts
import { defineChatWidget } from '@smooai/chat-widget';
defineChatWidget(); // now <smooth-agent-chat> works anywhere in your markup
```

## Theming

Every color is a CSS custom property under the hood, so the simplest possible
theme is a single `primary` — the launcher gradient, send button, user bubbles,
ambient glow, and derived depth shades all follow from it.

```ts
mountChatWidget({
    endpoint, agentId,
    theme: {
        primary: '#ff5d6e',        // the one color most brands need to set
        background: '#ffffff',     // light panel
        text: '#1f2430',
    },
});
```

| Token                  | Drives                                              | Default            |
| ---------------------- | --------------------------------------------------- | ------------------ |
| `primary`              | Launcher, send button, user bubble, glow, avatar    | `#00a6a6`          |
| `primaryText`          | Text/icon on top of `primary`                       | `#f8fafc`          |
| `background`           | Panel background                                    | `#040d30`          |
| `text`                 | Foreground text + derived inset surfaces            | `#f8fafc`          |
| `assistantBubble`      | Inbound (assistant) bubble background               | `#06134b`          |
| `assistantBubbleText`  | Inbound bubble text                                 | `#f8fafc`          |
| `userBubble`           | Outbound (user) bubble background                   | `primary`          |
| `userBubbleText`       | Outbound bubble text                                | `primaryText`      |
| `border`               | Panel + input hairline                              | `rgba(255,255,255,.1)` |

Two further tokens — a darker `primary-2` (gradient depth) and a `surface-2`
inset wash — are **derived in CSS** from `primary`/`text`, so you never have to
supply them and they adapt automatically to light or dark themes.

> **Dashboard parity:** the theme also accepts the SmooAI agent dashboard's
> 10-color model — `secondary` plus `chatBubbleInbound` / `chatBubbleInboundText`
> / `chatBubbleOutbound` / `chatBubbleOutboundText` (aliases that win over the
> canonical keys) — so a config exported from the dashboard themes the widget
> directly.

## Visitor identity & starter prompts

```ts
mountChatWidget({
    endpoint, agentId,
    examplePrompts: ['How do I get started?', 'Do you integrate with HubSpot?'],
    requireName: true,
    requireEmail: true,   // gate the chat behind a pre-chat form…
    // allowAnonymous: true, // …or let visitors skip it entirely
});
```

- **`examplePrompts`** render as clickable chips in the empty state (max 5).
- **`requireName` / `requireEmail` / `requirePhone`** show a styled pre-chat form;
  the collected name/email are attached to the conversation session (phone rides
  session metadata). Set **`allowAnonymous: true`** to skip the form.

### OTP & tool confirmation (programmatic)

The `ConversationController` surfaces mid-turn pauses via an `onInterrupt`
callback — `otp_verification_required` and `write_confirmation_required` — and
resumes them with `verifyOtp(code)` / `confirmTool(approved)`. (A built-in dialog
UI for these is on the roadmap; the protocol plumbing ships today.)

## Full-page mode

Render the chat as a full-bleed surface (a `/chat` route, a docs sidebar, an
iframe) instead of a floating launcher:

```html
<smooth-agent-chat mode="fullpage" endpoint="wss://…/ws" agent-id="…"></smooth-agent-chat>
```

```ts
import { mountFullPageChat } from '@smooai/chat-widget';
mountFullPageChat({ endpoint, agentId, agentName: 'Support' }, document.getElementById('chat'));
```

## Configuration

Declarative attributes mirror the programmatic [`ChatWidgetConfig`](./src/config.ts):

| Attribute       | Config key       | Notes                                              |
| --------------- | ---------------- | -------------------------------------------------- |
| `endpoint`      | `endpoint`       | **Required.** smooth-operator WebSocket URL.       |
| `agent-id`      | `agentId`        | **Required.** UUID of the agent.                   |
| `agent-name`    | `agentName`      | Header label + monogram. Default `Assistant`.      |
| `placeholder`   | `placeholder`    | Composer placeholder.                              |
| `greeting`      | `greeting`       | Shown before the first message.                    |
| `mode`          | `mode`           | `popover` (default) or `fullpage`.                 |
| `start-open`    | `startOpen`      | Open the panel immediately (no launcher click).    |
| —               | `theme`          | Brand colors (see [Theming](#theming)).            |
| —               | `userName` / `userEmail` | Optional participant identity.             |

### Programmatic API

`mountChatWidget(config, target?)` and `mountFullPageChat(config, target?)` return
the element, which exposes:

- `configure(partialConfig)` — merge overrides (e.g. live theme tweaks) and re-render.
- `openChat()` / `closeChat()` — toggle the popover panel.

## How it works

The widget is pure view + a thin `ConversationController` that speaks the
smooth-operator protocol via [`@smooai/smooth-operator`](https://github.com/SmooAI/smooth-operator):

```
connect()  →  WebSocket + create_conversation_session
send(text) →  send_message  →  stream_token … (live) …  →  eventual_response (+ citations)
```

The wire protocol is owned by smooth-operator; this package only renders it. That
keeps one source of truth for the protocol and lets the widget stay tiny.

## Browser support

Evergreen browsers (Chrome/Edge 111+, Safari 16.4+, Firefox 113+). The design uses
`color-mix()` to derive brand shades and `::part()` for host-side customization.

## Local development

```bash
pnpm install
pnpm build          # tsdown → dist/ (ESM + IIFE)
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest (jsdom) unit + render smoke tests
pnpm check          # typecheck + test + build
pnpm test:e2e       # Playwright live e2e (gated — see e2e/)
```

Open `index.html` (e.g. `pnpm dlx serve .`) after a build for the interactive,
backend-free showcase.

## License

MIT © [SmooAI](https://github.com/SmooAI)
