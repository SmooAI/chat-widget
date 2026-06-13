import { describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';

const base = { endpoint: 'wss://example/ws', agentId: 'agent-1' };

describe('resolveConfig', () => {
    it('fills the documented defaults', () => {
        const r = resolveConfig(base);
        expect(r.mode).toBe('popover');
        expect(r.agentName).toBe('Assistant');
        expect(r.placeholder).toBe('Type a message…');
        expect(r.greeting).toBe('Hi! How can I help you today?');
        expect(r.startOpen).toBe(false);
        expect(r.theme.primary).toBe('#00a6a6');
        // The redesign defaults the border to a translucent value for the glass look.
        expect(r.theme.border).toBe('rgba(255, 255, 255, 0.1)');
    });

    it('passes endpoint + agentId straight through', () => {
        const r = resolveConfig(base);
        expect(r.endpoint).toBe('wss://example/ws');
        expect(r.agentId).toBe('agent-1');
    });

    it('derives userBubble / userBubbleText from primary when unset', () => {
        const r = resolveConfig({ ...base, theme: { primary: '#ff0000', primaryText: '#fefefe' } });
        expect(r.theme.userBubble).toBe('#ff0000');
        expect(r.theme.userBubbleText).toBe('#fefefe');
    });

    it('honors explicit theme overrides over derived/default values', () => {
        const r = resolveConfig({
            ...base,
            theme: { primary: '#ff0000', userBubble: '#123456', border: '#abcdef' },
        });
        expect(r.theme.userBubble).toBe('#123456');
        expect(r.theme.border).toBe('#abcdef');
    });

    it('preserves caller-provided copy + mode', () => {
        const r = resolveConfig({ ...base, mode: 'fullpage', agentName: 'Nova', greeting: 'Hey!', placeholder: 'Ask…', startOpen: true });
        expect(r.mode).toBe('fullpage');
        expect(r.agentName).toBe('Nova');
        expect(r.greeting).toBe('Hey!');
        expect(r.placeholder).toBe('Ask…');
        expect(r.startOpen).toBe(true);
    });
});
