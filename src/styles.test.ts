import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';
import { buildStyles } from './styles.js';

const theme = resolveConfig({ endpoint: 'wss://e/ws', agentId: 'a', theme: { primary: '#abcdef' } }).theme;

describe('buildStyles', () => {
    it('injects every brand value as a --sac-* custom property', () => {
        const css = buildStyles(theme);
        expect(css).toContain('--sac-primary: #abcdef');
        expect(css).toContain('--sac-bg:');
        expect(css).toContain('--sac-text:');
        expect(css).toContain('--sac-assistant-bubble:');
        expect(css).toContain('--sac-user-bubble:');
    });

    it('derives primary-2 and surface-2 from the brand tokens (no second input needed)', () => {
        const css = buildStyles(theme);
        expect(css).toContain('--sac-primary-2: color-mix(in srgb, var(--sac-primary)');
        expect(css).toContain('--sac-surface-2: color-mix(in srgb, var(--sac-text)');
    });

    it('positions fixed (bottom-right) in popover mode', () => {
        const css = buildStyles(theme, 'popover');
        expect(css).toContain('position: fixed');
        expect(css).toContain('bottom: 24px');
    });

    it('fills its container (not fixed) in fullpage mode — no unconditional viewport unit', () => {
        const css = buildStyles(theme, 'fullpage');
        // The fullpage :host fills its container instead of pinning to the viewport.
        expect(css).not.toContain('position: fixed');
        // Regression (composer clipped inside fixed-height containers): fullpage
        // must NOT hardcode a viewport min-height on the host or panel …
        expect(css).not.toContain('min-height: 100vh');
        // … only the attribute-gated fallback for auto-height mounts remains,
        expect(css).toContain(':host([data-viewport-fallback]) { min-height: 100dvh; }');
        // and the .wrap flex chain hands the host's box down to the panel.
        expect(css).toContain('.wrap {');
        expect(css).toMatch(/\.panel\.fullpage \{[^}]*flex: 1/);
    });

    it('always ships the launcher, panel, typing indicator, and reduced-motion guard', () => {
        const css = buildStyles(theme);
        expect(css).toContain('.launcher');
        expect(css).toContain('.panel');
        expect(css).toContain('.bubble.typing');
        expect(css).toContain('prefers-reduced-motion');
    });
});
