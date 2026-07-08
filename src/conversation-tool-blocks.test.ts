/**
 * Tests for interleaved tool-activity blocks in the ConversationController.
 *
 * Drives `send()` with a scripted turn (a thenable async-iterable of ServerEvents,
 * mirroring `@smooai/smooth-operator`'s turn handle) and asserts the emitted
 * `ChatMessage.blocks` — verifying the gate (`showToolActivity`), the interleave
 * order, tool resolution from the correct `state.rawResponse.toolResult` path, and
 * the wrong-path guard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the operator client. `send()` uses: new SmoothAgentClient(), connect(),
//    createConversationSession() → {sessionId}, sendMessage() → turn handle.
const scriptedEvents: unknown[] = [];
let scriptedFinal: unknown = { data: { data: { response: { responseParts: [] } } } };

function makeTurn() {
    return {
        requestId: 'r1',
        async *[Symbol.asyncIterator]() {
            for (const ev of scriptedEvents) yield ev;
        },
        then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
            return Promise.resolve(scriptedFinal).then(onFulfilled, onRejected);
        },
    };
}

vi.mock('@smooai/smooth-operator', () => ({
    ProtocolError: class ProtocolError extends Error {},
    SmoothAgentClient: class {
        connect = vi.fn(async () => {});
        createConversationSession = vi.fn(async () => ({ sessionId: 's1' }));
        sendMessage = vi.fn(() => makeTurn());
        disconnect = vi.fn();
    },
}));

import { type ChatMessage, ConversationController } from './conversation.js';

const token = (t: string) => ({ type: 'stream_token', token: t });
const toolCall = (name: string, args: unknown) => ({ type: 'stream_chunk', data: { state: { rawResponse: { toolCall: { name, arguments: args } } } } });
const toolResult = (name: string, result: unknown, isError = false) => ({
    type: 'stream_chunk',
    data: { state: { rawResponse: { toolResult: { name, isError, result } } } },
});

/** Run a full turn and return the final assistant message. */
async function runTurn(showToolActivity: boolean, events: unknown[]): Promise<ChatMessage> {
    scriptedEvents.length = 0;
    scriptedEvents.push(...events);
    let latest: ChatMessage[] = [];
    const controller = new ConversationController({ endpoint: 'wss://e/ws', agentId: 'a1', showToolActivity }, { onMessages: (m) => (latest = m), onStatus: () => {} });
    await controller.send('hi');
    return latest.filter((m) => m.role === 'assistant').at(-1)!;
}

describe('ConversationController tool-activity blocks', () => {
    beforeEach(() => {
        scriptedFinal = { data: { data: { response: { responseParts: ['done'] } } } };
    });

    it('does not populate blocks when showToolActivity is off (default behavior unchanged)', async () => {
        const msg = await runTurn(false, [token('Hello '), toolCall('grep', { q: 'x' }), toolResult('grep', 'ok'), token('there')]);
        expect(msg.blocks).toBeUndefined();
        expect(msg.text).toBe('Hello there');
    });

    it('interleaves prose and tool chips in order when enabled', async () => {
        const msg = await runTurn(true, [token('Let me look. '), toolCall('search', { q: 'x' }), toolResult('search', 'found'), token('Got it.')]);
        expect(msg.blocks?.map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
        const tool = msg.blocks!.find((b) => b.kind === 'tool')!;
        expect(tool).toMatchObject({ kind: 'tool', tool: { name: 'search', done: true, isError: false, result: 'found' } });
    });

    it('drops blocks for a prose-only turn even when enabled (no tool invoked)', async () => {
        const msg = await runTurn(true, [token('Just talking, no tools.')]);
        expect(msg.blocks).toBeUndefined();
    });

    it('marks a tool errored when the result is an error', async () => {
        const msg = await runTurn(true, [toolCall('bash', 'ls /nope'), toolResult('bash', 'no such dir', true)]);
        const tool = msg.blocks!.find((b) => b.kind === 'tool')!;
        expect(tool).toMatchObject({ kind: 'tool', tool: { done: true, isError: true } });
    });

    it('leaves a chip running when the result is (wrongly) at state.toolResult', async () => {
        // Guards the daemon's hard-won bug: results live at rawResponse.toolResult.
        const wrongPathResult = { type: 'stream_chunk', data: { state: { toolResult: { name: 'grep', result: 'x' } } } };
        const msg = await runTurn(true, [toolCall('grep', {}), wrongPathResult]);
        const tool = msg.blocks!.find((b) => b.kind === 'tool')!;
        expect(tool).toMatchObject({ kind: 'tool', tool: { done: false } });
    });
});
