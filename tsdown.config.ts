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

// Explicit BROWSER transpile target for every output. Without this, tsdown
// derives `node22.0.0` from the package `engines` — a *Node* target for what is
// actually a browser `<script>`/ESM bundle. A Node target is the kind of setting
// that can silently downlevel the protocol client's async generators / `for await`
// over the streaming `MessageTurn` (`Symbol.asyncIterator`) into regenerator/helper
// shims, which mangles the streamed chat turn in older or stricter engines. Pinning
// an explicit `es2020` browser target keeps native async iteration intact (es2018+
// has `for await` / async iterators) and matches what the ESM build emits, so the
// IIFE global bundle and the ESM build stay byte-faithful on the streaming path.
const browserTarget = 'es2020';

export default defineConfig([
    // ESM library entry — for bundler-based hosts that `import` the widget and
    // call `defineChatWidget()` / `mountChatWidget(...)` programmatically. The
    // smooth-operator client is kept external so the host dedupes it.
    {
        entry: { index: 'src/index.ts' },
        format: ['esm'],
        platform: 'browser',
        target: browserTarget,
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
        target: browserTarget,
        globalName: 'SmoothAgentChat',
        // Bundle the protocol client AND zustand into the standalone global — a
        // plain `<script>` embed has no module resolver, so every runtime dep must
        // be inlined or it resolves to an undefined global at load.
        deps: { alwaysBundle: [/@smooai\/smooth-operator/, /^zustand/] },
        alias: {
            '@smooai/smooth-operator': agentClientEntry,
        },
        // zustand's persist middleware reads `import.meta.env.MODE` for a dev-only
        // warning. The IIFE format has no `import.meta`; define it explicitly so the
        // bundle is deterministic (production) and the EMPTY_IMPORT_META warning is
        // suppressed, rather than relying on rolldown's `{}` fallback.
        define: { 'import.meta.env': JSON.stringify({ MODE: 'production' }) },
        dts: false,
        sourcemap: true,
        clean: false,
        outDir: 'dist',
        outputOptions: {
            entryFileNames: 'chat-widget.global.js',
        },
    },
    // Tiny deferred loader IIFE — the *recommended* embed. Included eagerly, it
    // lazily injects `chat-widget.global.js` only past the host's critical render
    // (idle / user intent / 8s fallback), so the widget never competes with the
    // host page's LCP/TBT. Imports nothing from the widget itself, so it stays a
    // few hundred bytes.
    {
        entry: { 'chat-widget-loader': 'src/loader.ts' },
        format: ['iife'],
        platform: 'browser',
        target: browserTarget,
        globalName: 'SmoothAgentChatLoader',
        dts: false,
        sourcemap: true,
        clean: false,
        outDir: 'dist',
        outputOptions: {
            entryFileNames: 'chat-widget-loader.global.js',
        },
    },
]);
