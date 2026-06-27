import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWidgetStore, PERSIST_VERSION, type PersistedWidgetState, storageKey } from './persistence.js';

const AGENT = 'agent-123';

describe('persistence store', () => {
    beforeEach(() => {
        localStorage.clear();
    });
    afterEach(() => {
        localStorage.clear();
    });

    it('uses the per-agent localStorage key', () => {
        expect(storageKey(AGENT)).toBe('smoo-chat-widget:agent-123');
    });

    it('starts empty with the current version', () => {
        const store = createWidgetStore(AGENT);
        const s = store.getState();
        expect(s.version).toBe(PERSIST_VERSION);
        expect(s.sessionId).toBeNull();
        expect(s.identity).toEqual({});
        expect(s.consent).toEqual({ emailOptIn: false, smsOptIn: false });
        expect(s.verifiedEmail).toBeNull();
        expect(s.browserFingerprint).toBeNull();
    });

    it('mergeIdentity only overwrites provided fields', () => {
        const store = createWidgetStore(AGENT);
        store.getState().mergeIdentity({ name: 'Ada', email: 'ada@example.com' });
        store.getState().mergeIdentity({ phone: '+15551234567' });
        expect(store.getState().identity).toEqual({ name: 'Ada', email: 'ada@example.com', phone: '+15551234567' });
        // undefined must NOT clobber an existing value.
        store.getState().mergeIdentity({ name: undefined });
        expect(store.getState().identity.name).toBe('Ada');
    });

    it('persists ONLY the pointer/identity/consent shape (never a transcript)', () => {
        const store = createWidgetStore(AGENT);
        store.getState().setSessionId('sess-1');
        store.getState().mergeIdentity({ name: 'Ada' });
        store.getState().setConsent({ emailOptIn: true, smsOptIn: false, consentSource: 'chat-widget-prechat', consentAt: '2026-01-01T00:00:00.000Z' });
        store.getState().setVerifiedEmail('ada@example.com');
        store.getState().setBrowserFingerprint('fp-abc');

        const raw = localStorage.getItem(storageKey(AGENT));
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw as string) as { state: PersistedWidgetState };
        const keys = Object.keys(parsed.state).sort();
        expect(keys).toEqual(['browserFingerprint', 'consent', 'identity', 'sessionId', 'verifiedEmail', 'version'].sort());
        // No message/transcript field leaks into storage.
        expect(JSON.stringify(parsed.state)).not.toContain('messages');
    });

    it('clearSession drops the pointer but keeps identity/consent/verifiedEmail/fingerprint', () => {
        const store = createWidgetStore(AGENT);
        store.getState().setSessionId('sess-1');
        store.getState().mergeIdentity({ name: 'Ada' });
        store.getState().setConsent({ emailOptIn: true, smsOptIn: true });
        store.getState().setVerifiedEmail('ada@example.com');
        store.getState().setBrowserFingerprint('fp-abc');

        store.getState().clearSession();
        const s = store.getState();
        expect(s.sessionId).toBeNull();
        expect(s.identity.name).toBe('Ada');
        expect(s.consent.emailOptIn).toBe(true);
        expect(s.verifiedEmail).toBe('ada@example.com');
        expect(s.browserFingerprint).toBe('fp-abc');
    });

    it('rehydrates a persisted blob on a fresh store (resume across reload)', () => {
        const a = createWidgetStore(AGENT);
        a.getState().setSessionId('sess-keep');
        a.getState().setBrowserFingerprint('fp-keep');
        // A brand-new store for the same agent reads the persisted blob.
        const b = createWidgetStore(AGENT);
        expect(b.getState().sessionId).toBe('sess-keep');
        expect(b.getState().browserFingerprint).toBe('fp-keep');
    });

    it('migrates an unversioned/old blob into the current shape', () => {
        // Simulate an old persisted blob with missing fields + a stray transcript.
        localStorage.setItem(
            storageKey(AGENT),
            JSON.stringify({ state: { sessionId: 'old-sess', messages: [{ text: 'leak' }] }, version: 0 }),
        );
        const store = createWidgetStore(AGENT);
        const s = store.getState();
        expect(s.version).toBe(PERSIST_VERSION);
        expect(s.sessionId).toBe('old-sess');
        // Missing fields backfilled to safe defaults.
        expect(s.consent).toEqual({ emailOptIn: false, smsOptIn: false });
        expect(s.identity).toEqual({});
        // The stray transcript must not survive migration.
        expect((s as unknown as Record<string, unknown>).messages).toBeUndefined();
    });
});
