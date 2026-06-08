import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

// Alias the smooth-operator package's compiled client entry for bundling, so
// rolldown follows only the browser-clean client graph (transport + types) and
// never pulls in the package's `validate.js` (which statically imports ajv +
// node:fs/url/path for the Node-only `ProtocolValidator` the widget doesn't use).
// The package's `exports` only exposes `.`, so we point at the on-disk file.
const agentClientEntry = fileURLToPath(
    new URL('./node_modules/@smooai/smooth-operator/dist/client.js', import.meta.url),
);

export default defineConfig([
    // ESM library entry — for bundler-based hosts that `import` the widget and
    // call `defineChatWidget()` / `mountChatWidget(...)` programmatically. The
    // smooth-operator client is kept external so the host dedupes it.
    {
        entry: { index: 'src/index.ts' },
        format: ['esm'],
        platform: 'browser',
        dts: true,
        sourcemap: true,
        clean: true,
        outDir: 'dist',
    },
    // Standalone IIFE bundle — for a plain `<script src="chat-widget.global.js">`
    // embed. Everything (including the protocol client) is bundled in via
    // `deps.alwaysBundle`; on load it auto-registers the `<smooth-agent-chat>`
    // custom element and exposes the programmatic API on `window.SmoothAgentChat`.
    {
        entry: { 'chat-widget': 'src/standalone.ts' },
        format: ['iife'],
        platform: 'browser',
        globalName: 'SmoothAgentChat',
        deps: { alwaysBundle: [/@smooai\/smooth-operator/] },
        alias: {
            '@smooai/smooth-operator': agentClientEntry,
        },
        dts: false,
        sourcemap: true,
        clean: false,
        outDir: 'dist',
        outputOptions: {
            entryFileNames: 'chat-widget.global.js',
        },
    },
]);
