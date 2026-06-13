import { defineConfig } from 'vitest/config';

/**
 * Unit tests run under jsdom because the web component (`element.ts`) extends
 * `HTMLElement` and uses `customElements` / `attachShadow` at module-eval time —
 * none of which exist in a bare Node environment. jsdom gives us a DOM so we can
 * both unit-test the pure helpers and smoke-test the rendered shadow tree.
 *
 * Live e2e (Playwright, `*.live.spec.ts`) is a separate suite — see
 * `playwright.config.ts` — and is excluded here.
 */
export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['src/**/*.test.ts'],
        exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    },
});
