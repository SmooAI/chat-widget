/**
 * Browser fingerprint — a stable, privacy-light identifier used by the
 * smooth-operator server to correlate an anonymous visitor's sessions across
 * page loads (and, server-side, to match an anonymous fingerprint to a known
 * CRM contact). It rides every `create_conversation_session` as
 * `browserFingerprint` (see ADR-048).
 *
 * ## Why not ThumbmarkJS
 *
 * The ADR floats ThumbmarkJS as the reference implementation. For an *embed*
 * that is injected onto arbitrary host pages, ThumbmarkJS is too heavy: its
 * full build pulls in extensive device-detection tables and async
 * component collection, adding tens of kilobytes (and async surface) to a
 * bundle whose whole selling point is staying out of the host page's
 * LCP/TBT budget. The fingerprint here is a few hundred bytes.
 *
 * ## What this is (and the tradeoff)
 *
 * The correlation that actually matters — "is this the same browser as last
 * time?" — is carried by a **persisted random UUID** (the `browserFingerprint`
 * field in the persisted store). That UUID is generated once and reused for
 * the life of the localStorage entry, so same-browser resume is exact and
 * deterministic. The signal hash below is a best-effort entropy *supplement*
 * mixed into that UUID's derivation seed on first generation — it gives the
 * server-side resolver a soft signal for the (rare) cross-storage case where
 * the UUID was cleared but the device is unchanged. It is intentionally NOT a
 * high-entropy device fingerprint: no canvas/WebGL/audio probes, no font
 * enumeration, nothing that reads as invasive tracking. The tradeoff is weaker
 * cross-storage matching in exchange for a tiny, transparent, no-network,
 * XSS-safe implementation. The server's resolver (SMOODEV-2129d) is the source
 * of truth for any fuzzy matching; the client just supplies a stable token.
 */

/** Collect a small set of stable, non-invasive browser signals. */
function collectSignals(): string {
    const parts: string[] = [];
    try {
        const nav = typeof navigator !== 'undefined' ? navigator : undefined;
        if (nav) {
            parts.push(`ua:${nav.userAgent ?? ''}`);
            parts.push(`lang:${nav.language ?? ''}`);
            parts.push(`langs:${Array.isArray(nav.languages) ? nav.languages.join(',') : ''}`);
            // `platform` is deprecated but still widely present and stable.
            parts.push(`plat:${(nav as Navigator & { platform?: string }).platform ?? ''}`);
            parts.push(`hc:${(nav as Navigator & { hardwareConcurrency?: number }).hardwareConcurrency ?? ''}`);
            parts.push(`dm:${(nav as Navigator & { deviceMemory?: number }).deviceMemory ?? ''}`);
        }
        if (typeof screen !== 'undefined') {
            parts.push(`scr:${screen.width}x${screen.height}x${screen.colorDepth}`);
        }
        if (typeof Intl !== 'undefined') {
            try {
                parts.push(`tz:${Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''}`);
            } catch {
                /* resolvedOptions can throw in locked-down environments */
            }
        }
        parts.push(`tzo:${new Date().getTimezoneOffset()}`);
    } catch {
        /* a hostile/locked-down navigator must never break widget boot */
    }
    return parts.join('|');
}

/**
 * A small, fast, non-cryptographic string hash (FNV-1a, 32-bit) rendered as
 * an unsigned hex string. Stable across runs for the same input. Not used for
 * any security decision — only to derive a deterministic seed from the signal
 * string above.
 */
function fnv1a(input: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        // 32-bit FNV prime multiply via shifts to stay in int range.
        h = Math.imul(h, 0x01000193);
    }
    // >>> 0 → unsigned; pad to 8 hex chars.
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** Generate a UUID, preferring `crypto.randomUUID`, falling back to a v4-shaped string. */
function generateUuid(): string {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch {
        /* fall through to the manual generator */
    }
    // RFC 4122 v4 shape from Math.random — only reached when crypto.randomUUID
    // is unavailable (very old engines). Sufficient for a correlation token.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * Compute a fresh fingerprint token: a stable random UUID, suffixed with the
 * FNV hash of the device signals so the server can recover a soft device
 * signal even if it only has the token. Called ONCE per browser (the result is
 * persisted and reused) — see {@link getOrCreateFingerprint}.
 */
export function computeFingerprint(): string {
    const signalHash = fnv1a(collectSignals());
    return `${generateUuid()}.${signalHash}`;
}

/**
 * Return the cached fingerprint if one was already computed for this browser,
 * otherwise compute + persist a new one via the provided accessors. The
 * persistence layer owns storage; this function owns the "compute once" policy.
 */
export function getOrCreateFingerprint(get: () => string | null, set: (fp: string) => void): string {
    const existing = get();
    if (existing) return existing;
    const fp = computeFingerprint();
    set(fp);
    return fp;
}
