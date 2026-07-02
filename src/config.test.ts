import { describe, expect, it } from 'vitest';
import { needsUserInfo, resolveConfig } from './config.js';

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

    it('folds the dashboard chatBubble* aliases into the canonical theme keys', () => {
        const r = resolveConfig({
            ...base,
            theme: {
                chatBubbleInbound: '#111111',
                chatBubbleInboundText: '#222222',
                chatBubbleOutbound: '#333333',
                chatBubbleOutboundText: '#444444',
            },
        });
        expect(r.theme.assistantBubble).toBe('#111111');
        expect(r.theme.assistantBubbleText).toBe('#222222');
        expect(r.theme.userBubble).toBe('#333333');
        expect(r.theme.userBubbleText).toBe('#444444');
        // Aliases don't leak into the resolved theme shape.
        expect((r.theme as Record<string, unknown>).chatBubbleInbound).toBeUndefined();
    });

    it('caps example prompts at 5 and drops blanks', () => {
        const r = resolveConfig({ ...base, examplePrompts: ['a', '  ', 'b', 'c', 'd', 'e', 'f'] });
        expect(r.examplePrompts).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('keeps a safe http(s) logoUrl and drops dangerous/relative ones (XSS guard)', () => {
        expect(resolveConfig({ ...base, logoUrl: 'https://cdn.example.com/l.png' }).logoUrl).toBe('https://cdn.example.com/l.png');
        // eslint-disable-next-line no-script-url
        expect(resolveConfig({ ...base, logoUrl: 'javascript:alert(1)' }).logoUrl).toBeUndefined();
        expect(resolveConfig({ ...base, logoUrl: 'data:text/html,<script>' }).logoUrl).toBeUndefined();
        expect(resolveConfig({ ...base, logoUrl: '/relative/logo.png' }).logoUrl).toBeUndefined();
        expect(resolveConfig(base).logoUrl).toBeUndefined();
    });
});

describe('needsUserInfo', () => {
    const resolve = (extra: Partial<Parameters<typeof resolveConfig>[0]>) => resolveConfig({ ...base, ...extra });

    it('is false by default (no requirements)', () => {
        expect(needsUserInfo(resolve({}))).toBe(false);
    });

    it('is true when any field is required', () => {
        expect(needsUserInfo(resolve({ requireEmail: true }))).toBe(true);
        expect(needsUserInfo(resolve({ requireName: true }))).toBe(true);
        expect(needsUserInfo(resolve({ requirePhone: true }))).toBe(true);
    });

    it('is false when anonymous chat is allowed, even with requirements set', () => {
        expect(needsUserInfo(resolve({ requireName: true, requireEmail: true, allowAnonymous: true }))).toBe(false);
    });
});
