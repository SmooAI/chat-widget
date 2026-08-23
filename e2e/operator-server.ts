/**
 * Spawn/teardown helpers for a locally-built `smooth-operator-server`, shared by
 * the credential-gated live specs (a spec that needs TWO instances should not
 * grow its own copy of this).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Overridable so CI (which builds into the checkout's own `target/`) can point
 * at its binary; the default is this repo's documented local build location.
 */
export const SERVER_BIN = process.env.SMOOTH_AGENT_SERVER_BIN ?? join(homedir(), '.cargo', 'shared-target', 'debug', 'smooth-operator-server');

/** Resolve once a TCP connect to host:port succeeds, polling up to `timeoutMs`. */
export async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const ok = await new Promise<boolean>((resolve) => {
            const sock = createConnection({ host, port }, () => {
                sock.destroy();
                resolve(true);
            });
            sock.on('error', () => {
                sock.destroy();
                resolve(false);
            });
        });
        if (ok) return;
        if (Date.now() > deadline) throw new Error(`port ${host}:${port} not ready within ${timeoutMs}ms`);
        await new Promise((r) => setTimeout(r, 250));
    }
}

/**
 * Start one operator instance on `port` with `env` merged over the process env,
 * and wait for it to accept connections. Output is prefixed with `label` so two
 * instances are distinguishable in the log; the env (which carries the gateway
 * key) is never echoed.
 */
export async function spawnOperator(label: string, port: number, env: Record<string, string>): Promise<ChildProcess> {
    const proc = spawn(SERVER_BIN, [], {
        env: { ...process.env, SMOOTH_AGENT_BIND: '127.0.0.1', SMOOTH_AGENT_PORT: String(port), ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[${label}] ${d}`));
    proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[${label}] ${d}`));
    proc.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) process.stderr.write(`[${label}] exited code=${code} signal=${signal}\n`);
    });
    await waitForPort('127.0.0.1', port, 30_000);
    return proc;
}

/** SIGTERM then SIGKILL. Safe to call with `null`. */
export async function stopOperator(proc: ChildProcess | null): Promise<void> {
    if (!proc || proc.killed) return;
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!proc.killed) proc.kill('SIGKILL');
}
