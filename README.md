# @smooai/chat-widget

An embeddable chat widget for [**smooth-operator-agent**](https://github.com/SmooAI/smooth-operator-agent) — a framework-light web component that speaks the schema-driven WebSocket protocol via [`@smooai/smooth-operator-agent`](https://github.com/SmooAI/smooth-operator-agent), built with [tsdown](https://tsdown.dev).

Drop a `<smooth-agent-chat>` element on any page (or mount it programmatically), point it at a running smooth-operator-agent WebSocket service, and it handles the full conversation flow: open the connection, create a session, send a message, and render the streamed assistant reply token-by-token.

## Install

```bash
pnpm add @smooai/chat-widget
```

## Usage

### Plain `<script>` (standalone IIFE bundle)

The standalone bundle auto-registers the custom element and exposes `window.SmoothAgentChat`.

```html
<script src="https://unpkg.com/@smooai/chat-widget/dist/chat-widget.global.js"></script>
<smooth-agent-chat
    endpoint="wss://realtime.prod.smooth-agent.dev/ws"
    agent-id="00000000-0000-0000-0000-000000000000"
    agent-name="Support"
></smooth-agent-chat>
```

Or programmatically:

```html
<script src="https://unpkg.com/@smooai/chat-widget/dist/chat-widget.global.js"></script>
<script>
    SmoothAgentChat.mount({
        endpoint: 'wss://realtime.prod.smooth-agent.dev/ws',
        agentId: '00000000-0000-0000-0000-000000000000',
        agentName: 'Support',
        theme: { primary: '#7c3aed' },
    });
</script>
```

### ESM (bundler-based hosts)

```ts
import { defineChatWidget, mountChatWidget } from '@smooai/chat-widget';

// Declarative: register the element, then use it in markup.
defineChatWidget();

// Or programmatic:
const widget = mountChatWidget({
    endpoint: 'wss://realtime.prod.smooth-agent.dev/ws',
    agentId: '00000000-0000-0000-0000-000000000000',
});
widget.openChat();
```

## Embedding API

| Surface                                     | Description                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `<smooth-agent-chat>` element               | Custom element. Configure via HTML attributes (below).                      |
| `defineChatWidget()`                        | Register the custom element (idempotent).                                   |
| `mountChatWidget(config, target?)`          | Create + configure + append the element programmatically; returns it.       |
| `element.configure(partialConfig)`          | Merge config overrides (precedence over attributes); re-renders.            |
| `element.openChat()` / `element.closeChat()`| Open/collapse the popover panel.                                            |

### Attributes

| Attribute     | Maps to                  | Required |
| ------------- | ------------------------ | -------- |
| `endpoint`    | `config.endpoint` (WS URL) | ✅       |
| `agent-id`    | `config.agentId`         | ✅       |
| `agent-name`  | `config.agentName`       |          |
| `placeholder` | input placeholder        |          |
| `greeting`    | opening assistant line   |          |
| `start-open`  | start with panel open    |          |

### Config (`ChatWidgetConfig`)

```ts
interface ChatWidgetConfig {
    endpoint: string; // smooth-operator-agent WS URL
    agentId: string; // UUID of the agent
    agentName?: string;
    userName?: string;
    userEmail?: string;
    placeholder?: string;
    greeting?: string;
    connectionErrorMessage?: string;
    startOpen?: boolean;
    theme?: ChatWidgetTheme; // color overrides
}
```

## How it talks to the agent

The widget drives the [`SmoothAgentClient`](https://github.com/SmooAI/smooth-operator-agent) from `@smooai/smooth-operator-agent`:

1. **On open** → `client.connect()` then `createConversationSession({ agentId })`.
2. **On send** → `sendMessage({ sessionId, message })`, which returns a streaming `MessageTurn`.
   The widget async-iterates the turn, appending each `stream_token` to the in-progress
   assistant bubble, then awaits the terminal `eventual_response` for the authoritative
   final text.

The protocol shapes are identical to `@smooai/realtime` (the protocol was lifted from it),
so this is purely a client-library swap, not a protocol redesign.

## Develop

```bash
pnpm install
pnpm build      # tsdown → ESM lib (dist/index.js) + IIFE bundle (dist/chat-widget.global.js) + d.ts
pnpm dev        # tsdown --watch
pnpm typecheck  # tsc --noEmit
```

Open `index.html` after a build to see the embed (point it at a live service to chat).

## Build outputs

| File                            | Format | Use                                           |
| ------------------------------- | ------ | --------------------------------------------- |
| `dist/index.js`                 | ESM    | bundler hosts (`import …`)                     |
| `dist/index.d.ts`               | types  | TypeScript consumers                          |
| `dist/chat-widget.global.js`    | IIFE   | plain `<script>` embed (`window.SmoothAgentChat`) |

## Follow-ups

- **Publish `@smooai/smooth-operator-agent` to npm.** This package currently depends on it via a
  local path dep (`"file:../smooth-operator-agent/typescript"`). Once the protocol client is
  published, switch to a semver range (`"@smooai/smooth-operator-agent": "^0.1.0"`) so
  `@smooai/chat-widget` installs cleanly outside the monorepo checkout.
- **ESM barrel pulls in the Node-only validator.** The agent package's root barrel re-exports its
  `ProtocolValidator` (`validate.js`), which statically imports `ajv` + `node:*`. A tree-shaking
  bundler (Vite/webpack/rolldown) drops it since this widget only imports `SmoothAgentClient` /
  `ProtocolError`, but a bare-Node `import` of the ESM entry will try to resolve `ajv`. The IIFE
  bundle already sidesteps this by aliasing to the client entry. Cleanest fix upstream: add a
  `./client` export subpath (and/or `"sideEffects": false`) to the agent package.
- **Dogfood back into smooai.** Replace `packages/ui-chat-widget` consumers (apps/web, customer
  sites) with `@smooai/chat-widget` once the smooth-operator-agent service is the live chat backend.
  The embedding API differs intentionally (`endpoint` + `agentId` vs. `clientId`/`clientPublicKey`);
  a thin adapter or a config-mapping shim will smooth the migration.

## What was ported vs. simplified

Ported from smooai's `@smooai/ui-chat-widget`: the embedding model (a custom element with a launcher
+ popover panel, declarative HTML attributes, a programmatic mount/open/close API, themeable colors
via a config object). Simplified for a framework-light, dependency-light embed:

- **Vanilla web component instead of React.** The original mounts the heavyweight `@smooai/ui`
  `ChatWidget` and transitively pulls in the whole monorepo (Tailwind, shadcn, Supabase auth,
  react-phone-number-input, MSW, …). This rewrite is a plain `HTMLElement` rendering into a shadow
  root — no React, no Tailwind, no monorepo coupling.
- **Transport rewired** from `@smooai/realtime` to `@smooai/smooth-operator-agent` (`SmoothAgentClient`).
- **Dropped (for now):** the user-info intake form (name/email gating), OTP / write-confirmation
  HITL dialogs, phone input, example-prompt chips, icon variants, and CDN-stylesheet injection. The
  protocol client already exposes `confirmToolAction` / `verifyOtp` and the streaming events for
  these, so they can be layered back on without touching the transport.

## License

MIT
