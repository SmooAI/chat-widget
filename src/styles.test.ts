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

    it('fills its container (not fixed) in fullpage mode', () => {
        const css = buildStyles(theme, 'fullpage');
        // The fullpage :host fills its container instead of pinning to the viewport.
        expect(css).not.toContain('position: fixed');
        expect(css).toContain('min-height: 100vh');
    });

    it('always ships the launcher, panel, typing indicator, and reduced-motion guard', () => {
        const css = buildStyles(theme);
        expect(css).toContain('.launcher');
        expect(css).toContain('.panel');
        expect(css).toContain('.bubble.typing');
        expect(css).toContain('prefers-reduced-motion');
    });
});
