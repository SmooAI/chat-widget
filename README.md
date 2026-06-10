# chat-widget — DEPRECATED ⚠️

> This repo is **deprecated and archived.** The embeddable chat widget now ships
> as a **subpath export of the single `@smooai/smooth-operator` SDK**, not as a
> standalone package.

## Where it went

The widget source moved into the smooth-operator repo at
[`typescript/src/widget/`](https://github.com/SmooAI/smooth-operator/tree/main/typescript/src/widget)
and is published as part of `@smooai/smooth-operator`:

```bash
pnpm add @smooai/smooth-operator
```

```ts
// Programmatic mount (any framework, with a bundler):
import { mountChatWidget } from '@smooai/smooth-operator/widget';
mountChatWidget({ endpoint: 'wss://your-host/ws', agentId });
```

```html
<!-- Or a no-build <script> embed (the prebuilt IIFE bundle): -->
<script src="https://unpkg.com/@smooai/smooth-operator/dist/widget/chat-widget.iife.js"></script>
<smooth-agent-chat endpoint="wss://your-host/ws" agent-id="…"></smooth-agent-chat>
```

The web component (`<smooth-agent-chat>`), its config/theme surface, and the
full-page mode are unchanged — only the package boundary moved.

## Why

One package, one version, one install. The client (`.`), React bindings
(`./react`), and this widget (`./widget`) are now subpath exports of
`@smooai/smooth-operator` so they never drift out of lockstep. See the
[React Components and Custom UIs guide](https://github.com/SmooAI/smooth-operator/blob/main/docs/Guides/React%20Components%20and%20Custom%20UIs.md).
