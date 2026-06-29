import { describe, expect, it, vi } from 'vitest';
import { computeFingerprint, getOrCreateFingerprint } from './fingerprint.js';

describe('computeFingerprint', () => {
    it('produces a non-empty UUID.signalHash token', () => {
        const fp = computeFingerprint();
        expect(fp.length).toBeGreaterThan(10);
        // Shape: <uuid>.<8-hex>
        const [uuid, hash] = fp.split('.');
        expect(uuid).toMatch(/^[0-9a-f-]{36}$/i);
        expect(hash).toMatch(/^[0-9a-f]{8}$/i);
    });

    it('generates a fresh UUID each call (the persisted value is what stabilizes it)', () => {
        expect(computeFingerprint()).not.toBe(computeFingerprint());
    });

    it('keeps a stable signal-hash suffix across calls (same browser env)', () => {
        const a = computeFingerprint().split('.')[1];
        const b = computeFingerprint().split('.')[1];
        expect(a).toBe(b);
    });
});

describe('getOrCreateFingerprint', () => {
    it('computes + stores once, then returns the cached value', () => {
        let stored: string | null = null;
        const set = vi.fn((fp: string) => {
            stored = fp;
        });
        const get = () => stored;

        const first = getOrCreateFingerprint(get, set);
        expect(set).toHaveBeenCalledTimes(1);
        const second = getOrCreateFingerprint(get, set);
        // No second write; same value returned.
        expect(set).toHaveBeenCalledTimes(1);
        expect(second).toBe(first);
    });

    it('returns the existing value without recomputing', () => {
        const set = vi.fn();
        const fp = getOrCreateFingerprint(() => 'pre-existing.deadbeef', set);
        expect(fp).toBe('pre-existing.deadbeef');
        expect(set).not.toHaveBeenCalled();
    });
});
