/**
 * Two operator instances, one shared Postgres — the shape that produced the
 * 2026-08-23 incident and the only shape that can prove the fix.
 *
 * The operator's session registry used to be `Arc<RwLock<HashMap<..>>>`, i.e.
 * per-process. chat-ws runs 2-6 replicas with `sessionAffinity=None`, so a
 * session created while one pod served the request was invisible to the next,
 * and roughly half of returning visitors got `SESSION_NOT_FOUND`. smooth-operator
 * #529 made `AppState::load_session` fall back to `StorageAdapter::get_session`
 * and prime the local map, behind `scoped_session` — the chokepoint every
 * session-id-taking handler goes through. `e2e/widget.live.spec.ts` spawns
 * exactly ONE server, so it cannot see any of this: a single instance always
 * finds its own session in its own memory.
 *
 * Here the widget creates a session against instance A, then the page reloads
 * pointed at instance B — a different process that has never seen that session
 * and can only learn it from shared storage, exactly as when the load balancer
 * picks a different pod.
 *
 * The sharp assertion is that the SESSION ID DOES NOT CHANGE. Since chat-widget
 * #48 the widget silently recovers from a dead session, so a cross-pod
 * regression no longer shows as a visible error — it shows as the visitor's
 * conversation being abandoned. A spec asserting only "no error on screen"
 * would pass against the unfixed server.
 *
 * Gating (skips cleanly, live/credential tier):
 *   - SMOOTH_AGENT_E2E=1
 *   - SMOOTH_AGENT_DATABASE_URL=<postgres url both instances share>
 *   - SMOOAI_GATEWAY_KEY  — needed ONLY by the turn test below (an LLM call).
 *     The cross-instance session assertion needs no model, so it is not gated on
 *     a key it does not use.
 */
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { SERVER_BIN, spawnOperator, stopOperator } from './operator-server';

const PORT_A = 8841;
const PORT_B = 8842;

const GATEWAY_KEY = process.env.SMOOAI_GATEWAY_KEY ?? '';
const DATABASE_URL = process.env.SMOOTH_AGENT_DATABASE_URL ?? '';
const E2E_ENABLED = process.env.SMOOTH_AGENT_E2E === '1' && DATABASE_URL.length > 0;
const SKIP_REASON = 'Set SMOOTH_AGENT_E2E=1 and SMOOTH_AGENT_DATABASE_URL (a Postgres both instances share) to run the multi-instance e2e.';
const SKIP_TURN = 'Set SMOOAI_GATEWAY_KEY as well to run the cross-instance turn (it calls the LLM gateway).';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';

let serverA: ChildProcess | null = null;
let serverB: ChildProcess | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    test.skip(!E2E_ENABLED, SKIP_REASON);

    if (!existsSync(SERVER_BIN)) {
        throw new Error(
            `smooth-operator-server binary not found at ${SERVER_BIN}. Build it with: ` +
                'cargo build -p smooai-smooth-operator-server --bin smooth-operator-server --no-default-features --features postgres',
        );
    }

    // Both instances share ONE database and NOTHING else — no backplane, no
    // shared memory. That is the production topology (`sessionAffinity=None`),
    // and it is what makes storage hydration the only way B can know about a
    // session A created.
    const shared: Record<string, string> = {
        SMOOTH_AGENT_STORAGE: 'postgres',
        SMOOTH_AGENT_DATABASE_URL: DATABASE_URL,
        SMOOTH_AGENT_MODEL: process.env.SMOOTH_AGENT_MODEL ?? 'claude-haiku-4-5',
    };
    if (GATEWAY_KEY) shared.SMOOAI_GATEWAY_KEY = GATEWAY_KEY;
    serverA = await spawnOperator('operator-A', PORT_A, shared);
    serverB = await spawnOperator('operator-B', PORT_B, shared);
});

test.afterAll(async () => {
    await stopOperator(serverA);
    await stopOperator(serverB);
    serverA = null;
    serverB = null;
});

/** Read the widget's persisted session pointer out of localStorage. */
async function persistedSessionId(page: import('@playwright/test').Page): Promise<string | null> {
    return page.evaluate((agentId) => {
        const raw = localStorage.getItem(`smoo-chat-widget:${agentId}`);
        return raw ? ((JSON.parse(raw).state?.sessionId as string | null) ?? null) : null;
    }, AGENT_ID);
}

/**
 * Load the demo page pointed at one instance and send `message`.
 *
 * The widget connects LAZILY — nothing touches the server until the visitor
 * sends — so the send is what makes a session exist (on a fresh page) or makes
 * the persisted one be resumed (on a reload). It deliberately does NOT wait for
 * a reply: `create_conversation_session` and the session resume both complete
 * before the model is ever called, which is why the cross-instance assertion
 * needs no gateway key.
 */
async function openAndSend(page: import('@playwright/test').Page, port: number, message: string): Promise<void> {
    await page.goto(`/e2e/fixtures/demo.html?endpoint=${encodeURIComponent(`ws://127.0.0.1:${port}/ws`)}`);
    await page.waitForLoadState('load');
    const widget = page.locator('smooth-agent-chat');
    await expect(widget).toBeAttached();
    await expect(widget.locator('textarea')).toBeVisible();
    await expect(widget.locator('button.send')).toBeEnabled();
    await widget.locator('textarea').fill(message);
    await widget.locator('button.send').click();

    // Wait for the visitor's own bubble to appear. `send()` pushes it only AFTER
    // `connect()` resolves — i.e. after the persisted session has been resumed or
    // replaced — so it is a monotone signal that the pointer is final, and it
    // lands before the model is ever called (no gateway key needed).
    //
    // Three tempting alternatives are all false greens, and all were tried:
    // polling the pointer for non-null returns the PREVIOUS instance's id
    // instantly on the second page load; waiting for the reply bubble hangs when
    // there is no key (the gateway call never returns); and polling for status
    // `ready` misses it, because a failed turn overwrites it with the error
    // status before the poll samples.
    await expect(widget.locator('.bubble.user').filter({ hasText: message })).toBeVisible({ timeout: 30_000 });

    expect(await persistedSessionId(page), 'the widget must hold a session once connected').not.toBeNull();
}

test('a session created on instance A is resumed by instance B, not replaced', async ({ page }) => {
    test.skip(!E2E_ENABLED, SKIP_REASON);

    const consoleLines: string[] = [];
    page.on('console', (m) => consoleLines.push(`[console:${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));

    try {
        await openAndSend(page, PORT_A, 'Hello from the first pod.');
        const sessionOnA = await persistedSessionId(page);
        expect(sessionOnA, 'instance A must have created a session').toBeTruthy();

        // Reload against B. The widget resumes its persisted pointer with
        // `get_session`, which on B goes through `scoped_session` -> storage
        // hydration. A pod that cannot see the session answers SESSION_NOT_FOUND,
        // the widget clears the pointer and creates a new one -- so a CHANGED id
        // is the cross-pod regression, whether or not anything looked broken.
        await openAndSend(page, PORT_B, 'And hello from the second pod.');
        expect(await persistedSessionId(page), "instance B must resume A's session, not replace it").toBe(sessionOnA);

        // Whatever else happens to the turn (no gateway key => it fails at the
        // model, which is fine here), the incident string must never render.
        const transcript = (await page.locator('smooth-agent-chat').textContent()) ?? '';
        expect(transcript).not.toContain('not found');
    } catch (err) {
        console.log('\n--- browser console ---\n' + consoleLines.join('\n') + '\n--- end console ---\n');
        throw err;
    }
});

test('a turn sent to instance B lands in the session instance A created', async ({ page }) => {
    test.skip(!E2E_ENABLED, SKIP_REASON);
    test.skip(GATEWAY_KEY.length === 0, SKIP_TURN);

    const consoleLines: string[] = [];
    page.on('console', (m) => consoleLines.push(`[console:${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));

    try {
        await openAndSend(page, PORT_A, 'Hello, my name is Ada.');
        const sessionOnA = await persistedSessionId(page);

        await openAndSend(page, PORT_B, 'Please reply with a short greeting.');
        const widget = page.locator('smooth-agent-chat');
        const bubble = widget.locator('.bubble.assistant').last();
        await expect
            .poll(async () => ((await bubble.textContent()) ?? '').trim(), { message: 'instance B should answer', timeout: 90_000 })
            .not.toBe('');

        // The turn ran in A's session -- `send_message` resolves the session
        // through the same hydration chokepoint, so a per-pod registry fails here
        // with SESSION_NOT_FOUND and the widget's recovery swaps the pointer.
        expect(await persistedSessionId(page), 'the turn must run in the session A created').toBe(sessionOnA);
        const transcript = (await widget.textContent()) ?? '';
        expect(transcript).not.toContain('not found');
        expect(transcript).not.toContain("We couldn't reach the chat.");
    } catch (err) {
        console.log('\n--- browser console ---\n' + consoleLines.join('\n') + '\n--- end console ---\n');
        throw err;
    }
});
