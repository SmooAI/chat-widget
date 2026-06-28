/**
 * Persisted widget state — the identity / consent / session-pointer client layer
 * (ADR-048, SMOODEV-2129e).
 *
 * Built on Zustand's framework-agnostic `vanilla` store + the `persist`
 * middleware (the user explicitly chose Zustand; it's ~1KB and has no React
 * dependency, so it works inside the web component). The store is keyed per
 * agent — localStorage key `smoo-chat-widget:<agentId>` — so two agents embedded
 * on the same origin don't clobber each other.
 *
 * ## What persists (and, deliberately, what does NOT)
 *
 * Only a **pointer** to the conversation plus the visitor's identity + marketing
 * consent + verified email + browser fingerprint. The transcript is **never**
 * persisted: the smooth-operator server is the source of truth and the widget
 * re-hydrates history via `getMessages` on resume. This keeps localStorage small
 * and avoids stale/divergent transcripts.
 *
 * `version` drives `persist.migrate` so future shape changes can upgrade old
 * blobs in place instead of silently dropping them.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { persist, type PersistStorage } from 'zustand/middleware';

/** Current persisted-shape version. Bump when the shape below changes incompatibly. */
export const PERSIST_VERSION = 1 as const;

/** Marketing-consent record captured at the pre-chat form. */
export interface ConsentState {
    emailOptIn: boolean;
    smsOptIn: boolean;
    /** Where the consent was captured. The widget always stamps `chat-widget-prechat`. */
    consentSource?: string;
    /** ISO 8601 timestamp stamped when the visitor ticked a consent box. */
    consentAt?: string;
}

/** Visitor identity collected from config or the pre-chat form. */
export interface IdentityState {
    name?: string;
    email?: string;
    phone?: string;
}

/**
 * The exact persisted shape (ADR-048 §d). Only the pointer + identity + consent
 * persist — never the transcript.
 */
export interface PersistedWidgetState {
    version: typeof PERSIST_VERSION;
    /** Pointer to the active conversation session; cleared on ended/404. */
    sessionId: string | null;
    identity: IdentityState;
    consent: ConsentState;
    /**
     * Email proven via OTP for the CURRENT session. Session-scoped: cleared on
     * `clearSession()` so it can't leak across visitors on a shared browser, and
     * only threaded into session metadata when {@link verifiedEmailSessionId}
     * matches the live session (i.e. on resume of the verified session) — never
     * auto-stamped onto a brand-new session.
     */
    verifiedEmail: string | null;
    /** The sessionId the {@link verifiedEmail} was proven against (binds the proof to one session). */
    verifiedEmailSessionId: string | null;
    /** Stable per-browser correlation token (see fingerprint.ts). */
    browserFingerprint: string | null;
}

/** Store actions layered on top of the persisted state. */
export interface WidgetStoreActions {
    setSessionId: (sessionId: string | null) => void;
    /** Merge identity fields (undefined values don't clobber existing ones). */
    mergeIdentity: (identity: IdentityState) => void;
    /** Replace consent wholesale (the pre-chat form computes the full record). */
    setConsent: (consent: ConsentState) => void;
    /** Record an OTP-proven email bound to a specific session. */
    setVerifiedEmail: (email: string | null, sessionId?: string | null) => void;
    setBrowserFingerprint: (fp: string) => void;
    /**
     * Clear the session pointer (and the session-scoped `verifiedEmail` proof) but
     * KEEP identity / consent / fingerprint — used when a persisted session has
     * ended or 404s so the next turn starts a fresh session for a known visitor.
     * `verifiedEmail` is deliberately cleared here: it is a per-session OTP proof,
     * not a durable identity, so it must NOT survive onto a new session (which on a
     * shared browser could be a different visitor).
     */
    clearSession: () => void;
}

export type WidgetStore = PersistedWidgetState & WidgetStoreActions;

const EMPTY_CONSENT: ConsentState = { emailOptIn: false, smsOptIn: false };

function initialPersisted(): PersistedWidgetState {
    return {
        version: PERSIST_VERSION,
        sessionId: null,
        identity: {},
        consent: { ...EMPTY_CONSENT },
        verifiedEmail: null,
        verifiedEmailSessionId: null,
        browserFingerprint: null,
    };
}

/** localStorage key for an agent's persisted widget state. */
export function storageKey(agentId: string): string {
    return `smoo-chat-widget:${agentId}`;
}

/**
 * An explicit in-memory (Map-backed) `PersistStorage`. Used as the fallback when
 * real localStorage is unavailable.
 *
 * IMPORTANT: we must NOT return `undefined` from {@link safeStorage} in that case.
 * zustand v5's `persist` treats a missing `storage` option by falling back to its
 * OWN `createJSONStorage(() => localStorage)` — i.e. it re-engages the very
 * localStorage the guard was trying to avoid (throwing again in privacy mode).
 * Handing it this no-op storage keeps the store working purely in memory and
 * guarantees the fallback can't touch real localStorage.
 */
function memoryStorage(): PersistStorage<PersistedWidgetState> {
    const mem = new Map<string, string>();
    return {
        getItem: (name) => {
            const raw = mem.get(name);
            if (!raw) return null;
            try {
                return JSON.parse(raw) as ReturnType<PersistStorage<PersistedWidgetState>['getItem']>;
            } catch {
                return null;
            }
        },
        setItem: (name, value) => {
            mem.set(name, JSON.stringify(value));
        },
        removeItem: (name) => {
            mem.delete(name);
        },
    };
}

/**
 * A `persist` storage adapter that tolerates the *absence* of localStorage
 * (SSR, privacy-mode throwing on access, sandboxed iframes). When storage is
 * unavailable the store still works in-memory; nothing is persisted, but the
 * widget never throws on boot.
 */
function safeStorage(): PersistStorage<PersistedWidgetState> {
    let ls: Storage | null = null;
    try {
        ls = typeof localStorage !== 'undefined' ? localStorage : null;
        // Probe: some environments expose localStorage but throw on access.
        if (ls) {
            const probe = '__smoo_probe__';
            ls.setItem(probe, '1');
            ls.removeItem(probe);
        }
    } catch {
        ls = null;
    }
    // Fall back to an explicit in-memory store — NEVER `undefined` (see memoryStorage).
    if (!ls) return memoryStorage();
    const storage = ls;
    return {
        getItem: (name) => {
            try {
                const raw = storage.getItem(name);
                return raw ? (JSON.parse(raw) as ReturnType<PersistStorage<PersistedWidgetState>['getItem']>) : null;
            } catch {
                return null;
            }
        },
        setItem: (name, value) => {
            try {
                storage.setItem(name, JSON.stringify(value));
            } catch {
                /* quota / privacy-mode write failures are non-fatal */
            }
        },
        removeItem: (name) => {
            try {
                storage.removeItem(name);
            } catch {
                /* non-fatal */
            }
        },
    };
}

/**
 * Migrate a persisted blob from an older `version` to the current shape. Today
 * v1 is the only version, so this just backfills any missing fields onto an
 * unknown old blob; future versions add `case` branches here.
 */
function migrate(persisted: unknown): PersistedWidgetState {
    const base = initialPersisted();
    if (!persisted || typeof persisted !== 'object') return base;
    const p = persisted as Partial<PersistedWidgetState>;
    return {
        version: PERSIST_VERSION,
        sessionId: typeof p.sessionId === 'string' ? p.sessionId : null,
        identity: {
            name: typeof p.identity?.name === 'string' ? p.identity.name : undefined,
            email: typeof p.identity?.email === 'string' ? p.identity.email : undefined,
            phone: typeof p.identity?.phone === 'string' ? p.identity.phone : undefined,
        },
        consent: {
            emailOptIn: p.consent?.emailOptIn === true,
            smsOptIn: p.consent?.smsOptIn === true,
            consentSource: typeof p.consent?.consentSource === 'string' ? p.consent.consentSource : undefined,
            consentAt: typeof p.consent?.consentAt === 'string' ? p.consent.consentAt : undefined,
        },
        verifiedEmail: typeof p.verifiedEmail === 'string' ? p.verifiedEmail : null,
        verifiedEmailSessionId: typeof p.verifiedEmailSessionId === 'string' ? p.verifiedEmailSessionId : null,
        browserFingerprint: typeof p.browserFingerprint === 'string' ? p.browserFingerprint : null,
    };
}

/**
 * Create the per-agent persisted Zustand store. The `partialize` step ensures
 * only the persisted shape (never any future transient action/UI state) is
 * written to localStorage.
 */
export function createWidgetStore(agentId: string): StoreApi<WidgetStore> {
    return createStore<WidgetStore>()(
        persist(
            (set) => ({
                ...initialPersisted(),
                setSessionId: (sessionId) => set({ sessionId }),
                mergeIdentity: (identity) =>
                    set((state) => ({
                        identity: {
                            ...state.identity,
                            ...(identity.name !== undefined ? { name: identity.name } : {}),
                            ...(identity.email !== undefined ? { email: identity.email } : {}),
                            ...(identity.phone !== undefined ? { phone: identity.phone } : {}),
                        },
                    })),
                setConsent: (consent) => set({ consent: { ...consent } }),
                setVerifiedEmail: (verifiedEmail, sessionId) =>
                    set((state) => ({
                        verifiedEmail,
                        // Bind the proof to the session it was verified against. When the
                        // caller omits sessionId, fall back to the live pointer so the
                        // proof is never left unbound.
                        verifiedEmailSessionId: verifiedEmail === null ? null : (sessionId ?? state.sessionId),
                    })),
                setBrowserFingerprint: (browserFingerprint) => set({ browserFingerprint }),
                // Drop the pointer AND the session-scoped OTP proof; keep durable identity.
                clearSession: () => set({ sessionId: null, verifiedEmail: null, verifiedEmailSessionId: null }),
            }),
            {
                name: storageKey(agentId),
                version: PERSIST_VERSION,
                storage: safeStorage(),
                migrate,
                // Persist ONLY the data shape — never the action functions.
                partialize: (state): PersistedWidgetState => ({
                    version: PERSIST_VERSION,
                    sessionId: state.sessionId,
                    identity: state.identity,
                    consent: state.consent,
                    verifiedEmail: state.verifiedEmail,
                    verifiedEmailSessionId: state.verifiedEmailSessionId,
                    browserFingerprint: state.browserFingerprint,
                }),
            },
        ),
    );
}
