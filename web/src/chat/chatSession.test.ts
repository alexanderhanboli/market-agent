import assert from 'node:assert/strict'
import test from 'node:test'

import {
  INITIAL_CHAT_SESSION,
  reduceChatSession,
  selectThreadView,
  type ChatSessionAction,
  type ChatSessionState,
  type TurnIds,
  type TurnState,
} from './chatSession.ts'
import type { ChatMessage } from './messageTypes.ts'
import type { ChatSseEvent } from './sseEventTypes.ts'
import type { StreamingRichTextBlock } from './streamReducer.ts'

const TURN: TurnIds = { runId: 'run-1', messageId: 'u1', snapshotId: 'snap-1', text: 'Analyze NVDA' }

function message(id: string, role: ChatMessage['role'], text: string): ChatMessage {
  return {
    message_id: id,
    thread_id: 'T1',
    role,
    snapshot_id: 'snap-1',
    blocks: [{
      id: `${id}-b`,
      kind: 'rich_text',
      snapshot_id: 'snap-1',
      data_ref: { kind: 'chat_turn', id },
      source_refs: [],
      as_of: '2026-05-06T00:00:00.000Z',
      segments: [{ type: 'text', text }],
    }],
    content_hash: `sha256:${id}`,
    created_at: '2026-05-06T00:00:00.000Z',
  }
}

const U1 = message('u1', 'user', 'Analyze NVDA')
const A1 = message('a1', 'assistant', "NVIDIA's revenue rose")

function sse(type: ChatSseEvent['type'], seq: number, payload: Record<string, unknown> = {}): ChatSseEvent {
  return { type, seq, thread_id: 'T1', run_id: 'run-1', turn_id: 'u1', ...payload }
}

function streamEvent(event: ChatSseEvent, threadId = 'T1'): ChatSessionAction {
  return { type: 'stream.event', threadId, event }
}

function run(state: ChatSessionState, actions: ReadonlyArray<ChatSessionAction>): ChatSessionState {
  return actions.reduce(reduceChatSession, state)
}

const STREAM_TO_TEXT: ReadonlyArray<ChatSessionAction> = [
  streamEvent(sse('turn.started', 1)),
  streamEvent(sse('block.began', 2, { block_id: 'b1', kind: 'rich_text' })),
  streamEvent(sse('block.delta', 3, { block_id: 'b1', delta: { segment: { type: 'text', text: "NVIDIA's revenue rose" } } })),
  streamEvent(sse('block.completed', 4, { block_id: 'b1', content_hash: 'h1' })),
]

function streamingT1(): ChatSessionState {
  return run(INITIAL_CHAT_SESSION, [
    { type: 'thread.opened', threadId: 'T1' },
    { type: 'history.loaded', threadId: 'T1', gen: 1, messages: [] },
    { type: 'ask.started', turn: TURN },
    { type: 'message.persisted', threadId: 'T1', message: U1 },
    ...STREAM_TO_TEXT,
  ])
}

function sealingT1(): ChatSessionState {
  return reduceChatSession(streamingT1(), streamEvent(sse('turn.completed', 5, { message_id: 'a1' })))
}

function streamedText(turn: TurnState): string {
  if (!('stream' in turn)) return ''
  return turn.stream.block_order
    .map((id) => turn.stream.blocks_by_id.get(id) as StreamingRichTextBlock)
    .flatMap((block) => block.segments.map((segment) => (segment.type === 'text' ? segment.text : '')))
    .join('')
}

const ids = (state: ChatSessionState) => selectThreadView(state).messages.map((m) => m.message_id)

test('a full turn seals, then the history load that contains the sealed id hands off in one state', () => {
  const sealing = sealingT1()
  assert.equal(sealing.turn.phase, 'sealing')
  assert.equal(streamedText(sealing.turn), "NVIDIA's revenue rose")
  assert.equal(sealing.history.requested, 2)
  assert.deepEqual(ids(sealing), ['u1'])
  assert.deepEqual(selectThreadView(sealing).needsLoad, { threadId: 'T1', gen: 2 })

  const handedOff = reduceChatSession(sealing, { type: 'history.loaded', threadId: 'T1', gen: 2, messages: [U1, A1] })
  assert.equal(handedOff.turn.phase, 'idle')
  assert.deepEqual(ids(handedOff), ['u1', 'a1'])
  assert.equal(handedOff.sealedTurns, 1)
  assert.equal(selectThreadView(handedOff).needsLoad, null)
})

test('a stale gen-1 load arriving while sealing at gen 2 returns the same reference', () => {
  const sealing = sealingT1()
  const after = reduceChatSession(sealing, { type: 'history.loaded', threadId: 'T1', gen: 1, messages: [U1, A1] })
  assert.equal(after, sealing)
})

test('a gen-2 load without the sealed id keeps the streamed answer', () => {
  const kept = reduceChatSession(sealingT1(), { type: 'history.loaded', threadId: 'T1', gen: 2, messages: [U1] })
  assert.equal(kept.turn.phase, 'kept')
  assert.equal(kept.turn.phase === 'kept' ? kept.turn.reason : null, 'not_in_history')
  assert.equal(streamedText(kept.turn), "NVIDIA's revenue rose")
  assert.equal(kept.sealedTurns, 0)
})

test('a failed reload keeps the list and the answer, and Reload goes back to sealing', () => {
  const kept = reduceChatSession(sealingT1(), { type: 'history.failed', threadId: 'T1', gen: 2, message: 'HTTP 500' })
  assert.equal(kept.turn.phase, 'kept')
  assert.equal(kept.turn.phase === 'kept' ? kept.turn.reason : null, 'history_failed')
  assert.deepEqual(ids(kept), ['u1'])
  assert.deepEqual(kept.history.loaded, { kind: 'ready', messages: [] })
  assert.equal(selectThreadView(kept).canAsk, true)

  const resealing = reduceChatSession(kept, { type: 'history.requested' })
  assert.equal(resealing.turn.phase, 'sealing')
  assert.equal(resealing.history.requested, 3)
  assert.deepEqual(selectThreadView(resealing).needsLoad, { threadId: 'T1', gen: 3 })

  const handedOff = reduceChatSession(resealing, { type: 'history.loaded', threadId: 'T1', gen: 3, messages: [U1, A1] })
  assert.equal(handedOff.turn.phase, 'idle')
  assert.deepEqual(handedOff.history.loaded, { kind: 'ready', messages: [U1, A1] })
})

test('canAsk is true only when no turn is in flight', () => {
  const opened = reduceChatSession(INITIAL_CHAT_SESSION, { type: 'thread.opened', threadId: 'T1' })
  const persisting = reduceChatSession(opened, { type: 'ask.started', turn: TURN })
  const streaming = streamingT1()
  const sealing = sealingT1()
  const kept = reduceChatSession(sealing, { type: 'history.loaded', threadId: 'T1', gen: 2, messages: [U1] })
  const failed = reduceChatSession(streaming, { type: 'stream.disconnected', threadId: 'T1', runId: 'run-1' })
  const unverified = reduceChatSession(streaming, streamEvent(sse('turn.completed', 5, {
    unverified: { persisted: false, failures: [], blocks: [] },
  })))
  const notSent = reduceChatSession(persisting, { type: 'ask.failed', error: 'HTTP 500' })

  const table = { opened, persisting, streaming, sealing, kept, failed, unverified, notSent }
  assert.deepEqual(
    Object.fromEntries(Object.entries(table).map(([name, state]) => [name, [state.turn.phase, selectThreadView(state).canAsk]])),
    {
      opened: ['idle', true],
      persisting: ['persisting', false],
      streaming: ['streaming', false],
      sealing: ['sealing', false],
      kept: ['kept', true],
      failed: ['failed', true],
      unverified: ['unverified', true],
      notSent: ['not_sent', true],
    },
  )
  assert.equal(reduceChatSession(persisting, { type: 'ask.started', turn: { ...TURN, runId: 'run-2' } }), persisting)
})

test('stream events for another run or another thread return the same reference', () => {
  const streaming = streamingT1()
  const delta = { block_id: 'b1', delta: { segment: { type: 'text', text: ' late' } } }
  assert.equal(reduceChatSession(streaming, streamEvent(sse('block.delta', 9, { ...delta, run_id: 'other' }))), streaming)
  assert.equal(reduceChatSession(streaming, streamEvent(sse('block.delta', 9, delta), 'T2')), streaming)
  assert.equal(reduceChatSession(streaming, { type: 'stream.disconnected', threadId: 'T1', runId: 'other' }), streaming)
  const sameRun = run(streaming, [
    streamEvent(sse('block.began', 9, { block_id: 'b2', kind: 'rich_text' })),
    streamEvent(sse('block.delta', 10, { ...delta, block_id: 'b2' })),
  ])
  assert.equal(streamedText(sameRun.turn), "NVIDIA's revenue rose late")
})

test('opening the same thread is a no-op and opening another starts a fresh session', () => {
  const opened = reduceChatSession(INITIAL_CHAT_SESSION, { type: 'thread.opened', threadId: 'T1' })
  assert.equal(reduceChatSession(opened, { type: 'thread.opened', threadId: 'T1' }), opened)

  const t2 = reduceChatSession(sealingT1(), { type: 'thread.opened', threadId: 'T2' })
  assert.equal(t2.threadId, 'T2')
  assert.equal(t2.turn.phase, 'idle')
  assert.deepEqual(t2.history.loaded, { kind: 'loading' })
  assert.equal(t2.history.requested, 1)
  assert.deepEqual(selectThreadView(t2).needsLoad, { threadId: 'T2', gen: 1 })
  assert.equal(selectThreadView(t2).history, 'loading')
  assert.equal(reduceChatSession(t2, { type: 'history.loaded', threadId: 'T1', gen: 1, messages: [U1] }), t2)
})

test('a GET that started before the POST landed does not drop the posted user message', () => {
  const state = run(INITIAL_CHAT_SESSION, [
    { type: 'thread.opened', threadId: 'T1' },
    { type: 'ask.started', turn: TURN },
    { type: 'message.persisted', threadId: 'T1', message: U1 },
    { type: 'history.loaded', threadId: 'T1', gen: 1, messages: [] },
  ])
  assert.deepEqual(ids(state), ['u1'])
  assert.equal(selectThreadView(state).firstQuestion, 'Analyze NVDA')
})

test('Retry reopens a failed stream and the replayed turn.started resets the blocks', () => {
  const failed = reduceChatSession(streamingT1(), { type: 'stream.disconnected', threadId: 'T1', runId: 'run-1' })
  assert.equal(failed.turn.phase, 'failed')
  assert.equal(failed.turn.phase === 'failed' ? failed.turn.error : null, 'The analyst stream disconnected.')

  const reopened = reduceChatSession(failed, { type: 'stream.reopened' })
  assert.equal(reopened.turn.phase, 'streaming')
  assert.equal(reopened.turn.phase === 'streaming' ? reopened.turn.stream.error : 'unset', null)
  assert.equal(reopened.turn.phase === 'streaming' ? reopened.turn.turn.runId : null, 'run-1')

  const replayed = reduceChatSession(reopened, streamEvent(sse('turn.started', 1)))
  assert.equal(replayed.turn.phase === 'streaming' ? replayed.turn.stream.block_order.length : -1, 0)
})

test('a server turn.error fails the turn with its reason', () => {
  const failed = reduceChatSession(streamingT1(), streamEvent(sse('turn.error', 5, { error: 'upstream_500' })))
  assert.equal(failed.turn.phase === 'failed' ? failed.turn.error : null, 'Stream error: upstream_500')
  assert.equal(streamedText(failed.turn), "NVIDIA's revenue rose")
})

test('an unverified completion requests no history load', () => {
  const streaming = streamingT1()
  const unverified = reduceChatSession(streaming, streamEvent(sse('turn.completed', 5, {
    unverified: { persisted: false, failures: [{ reason_code: 'missing_fact_ref' }], blocks: [] },
  })))
  assert.equal(unverified.turn.phase, 'unverified')
  assert.equal(unverified.history.requested, 1)
  assert.equal(selectThreadView(unverified).needsLoad, null)
})

test('ask first: the created thread starts ready and empty with no load', () => {
  const state = run(INITIAL_CHAT_SESSION, [
    { type: 'ask.started', turn: TURN },
    { type: 'thread.created', threadId: 'T1' },
  ])
  const view = selectThreadView(state)
  assert.equal(view.threadId, 'T1')
  assert.equal(view.history, 'ready')
  assert.equal(view.listMounted, true)
  assert.equal(view.needsLoad, null)
  assert.equal(view.firstQuestion, 'Analyze NVDA')
  assert.equal(reduceChatSession(state, { type: 'thread.opened', threadId: 'T1' }), state)
})

test('a history load that returns the user message before the POST response shows it once', () => {
  const state = run(INITIAL_CHAT_SESSION, [
    { type: 'thread.opened', threadId: 'T1' },
    { type: 'ask.started', turn: TURN },
    { type: 'history.loaded', threadId: 'T1', gen: 1, messages: [U1] },
    { type: 'message.persisted', threadId: 'T1', message: U1 },
  ])
  assert.deepEqual(ids(state), ['u1'])
  assert.equal(state.turn.phase, 'streaming')
})

test('background.changed blocks asking on the active thread only while its run is going', () => {
  const opened = run(INITIAL_CHAT_SESSION, [
    { type: 'thread.opened', threadId: 'T1' },
    { type: 'history.loaded', threadId: 'T1', gen: 1, messages: [U1] },
  ])
  assert.equal(selectThreadView(opened).canAsk, true)

  const running = reduceChatSession(opened, { type: 'background.changed', threadId: 'T1', running: true })
  assert.equal(selectThreadView(running).backgroundRun, true)
  assert.equal(selectThreadView(running).canAsk, false)
  assert.equal(reduceChatSession(running, { type: 'ask.started', turn: TURN }).turn.phase, 'idle')
  assert.equal(reduceChatSession(running, { type: 'background.changed', threadId: 'T1', running: true }), running)

  assert.equal(reduceChatSession(opened, { type: 'background.changed', threadId: 'T2', running: true }), opened)
  assert.equal(reduceChatSession(opened, { type: 'background.changed', threadId: 'T1', running: false }), opened)

  const settled = reduceChatSession(running, { type: 'background.changed', threadId: 'T1', running: false })
  assert.equal(selectThreadView(settled).backgroundRun, false)
  assert.equal(selectThreadView(settled).canAsk, true)

  const switched = reduceChatSession(running, { type: 'thread.opened', threadId: 'T2' })
  assert.equal(selectThreadView(switched).backgroundRun, false)
})
