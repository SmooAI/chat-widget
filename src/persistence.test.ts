import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
        expect(s.verifiedEmailSessionId).toBeNull();
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
        expect(keys).toEqual(['browserFingerprint', 'consent', 'identity', 'sessionId', 'verifiedEmail', 'verifiedEmailSessionId', 'version'].sort());
        // No message/transcript field leaks into storage.
        expect(JSON.stringify(parsed.state)).not.toContain('messages');
    });

    it('clearSession drops the pointer AND the session-scoped verifiedEmail, keeps identity/consent/fingerprint', () => {
        const store = createWidgetStore(AGENT);
        store.getState().setSessionId('sess-1');
        store.getState().mergeIdentity({ name: 'Ada' });
        store.getState().setConsent({ emailOptIn: true, smsOptIn: true });
        store.getState().setVerifiedEmail('ada@example.com', 'sess-1');
        store.getState().setBrowserFingerprint('fp-abc');

        store.getState().clearSession();
        const s = store.getState();
        expect(s.sessionId).toBeNull();
        expect(s.identity.name).toBe('Ada');
        expect(s.consent.emailOptIn).toBe(true);
        // verifiedEmail is a PER-SESSION OTP proof — it must NOT survive a clear,
        // or it would leak onto the next (possibly different) visitor's session.
        expect(s.verifiedEmail).toBeNull();
        expect(s.verifiedEmailSessionId).toBeNull();
        expect(s.browserFingerprint).toBe('fp-abc');
    });

    it('setVerifiedEmail binds the proof to a session and clears the binding when nulled', () => {
        const store = createWidgetStore(AGENT);
        store.getState().setSessionId('sess-live');
        // Explicit session binding.
        store.getState().setVerifiedEmail('ada@example.com', 'sess-X');
        expect(store.getState().verifiedEmail).toBe('ada@example.com');
        expect(store.getState().verifiedEmailSessionId).toBe('sess-X');
        // Omitted session falls back to the live pointer (never left unbound).
        store.getState().setVerifiedEmail('bob@example.com');
        expect(store.getState().verifiedEmailSessionId).toBe('sess-live');
        // Nulling the email also clears the binding.
        store.getState().setVerifiedEmail(null);
        expect(store.getState().verifiedEmail).toBeNull();
        expect(store.getState().verifiedEmailSessionId).toBeNull();
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

    it('falls back to an explicit in-memory store when localStorage throws (privacy mode), never touching real localStorage', () => {
        // Privacy-mode: the probe write throws. The guard must hand zustand an
        // explicit in-memory store — NOT return undefined (which makes zustand v5
        // re-engage its own createJSONStorage(()=>localStorage) and throw again).
        const realSetItem = Storage.prototype.setItem;
        const setSpy = vi.fn(() => {
            throw new DOMException('denied', 'SecurityError');
        });
        Storage.prototype.setItem = setSpy as unknown as typeof realSetItem;
        try {
            // Construction must not throw despite setItem throwing on the probe.
            const store = createWidgetStore('agent-privacy');
            // The store still works in memory.
            store.getState().setSessionId('sess-mem');
            store.getState().mergeIdentity({ name: 'Ada' });
            expect(store.getState().sessionId).toBe('sess-mem');
            expect(store.getState().identity.name).toBe('Ada');
            // Nothing was persisted to real localStorage (the in-memory fallback
            // never touches it). getItem returns null for this agent's key.
            expect(localStorage.getItem(storageKey('agent-privacy'))).toBeNull();
        } finally {
            Storage.prototype.setItem = realSetItem;
        }
    });

    it('a fresh in-memory-fallback store does NOT see another store\'s persisted blob', () => {
        // Persist a blob via the normal (working) localStorage path first.
        const real = createWidgetStore(AGENT);
        real.getState().setSessionId('sess-real');

        // Now force the fallback for the SAME agent key. Because the fallback is a
        // private Map (not real localStorage), it must start empty — proving it
        // truly bypasses real localStorage rather than silently reading it.
        const realGetItem = Storage.prototype.getItem;
        const realSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = (() => {
            throw new DOMException('denied', 'SecurityError');
        }) as unknown as typeof realSetItem;
        try {
            const fallback = createWidgetStore(AGENT);
            expect(fallback.getState().sessionId).toBeNull();
        } finally {
            Storage.prototype.getItem = realGetItem;
            Storage.prototype.setItem = realSetItem;
        }
    });
});
