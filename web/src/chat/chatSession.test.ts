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
const A1_SEALED: ChatMessage = {
  ...A1,
  block_proofs: { 'a1-b': { evidence: 'unknown', calculation: 'not_verified', public_by_cutoff: 'unknown' } },
}

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

function completedT1(payload: Record<string, unknown> = { message_id: 'a1', message: A1_SEALED }): ChatSessionState {
  return reduceChatSession(streamingT1(), streamEvent(sse('turn.completed', 5, payload)))
}

function streamedText(turn: TurnState): string {
  if (!('stream' in turn)) return ''
  return turn.stream.block_order
    .map((id) => turn.stream.blocks_by_id.get(id) as StreamingRichTextBlock)
    .flatMap((block) => block.segments.map((segment) => (segment.type === 'text' ? segment.text : '')))
    .join('')
}

const ids = (state: ChatSessionState) => selectThreadView(state).messages.map((m) => m.message_id)

test('a full turn hands off on its completion in one state, with no history load', () => {
  const handedOff = completedT1()
  assert.equal(handedOff.turn.phase, 'idle')
  assert.deepEqual(ids(handedOff), ['u1', 'a1'])
  assert.deepEqual(selectThreadView(handedOff).messages[1], A1_SEALED)
  assert.equal(handedOff.sealedTurns, 1)
  assert.equal(handedOff.history.requested, 1)
  assert.equal(selectThreadView(handedOff).needsLoad, null)
  assert.equal(selectThreadView(handedOff).canAsk, true)
})

test('a replayed completion after the hand-off returns the same reference', () => {
  const handedOff = completedT1()
  assert.equal(reduceChatSession(handedOff, streamEvent(sse('turn.completed', 5, { message_id: 'a1', message: A1_SEALED }))), handedOff)
})

test('a thread-open load in flight at the hand-off neither drops nor duplicates the answer', () => {
  const handedOff = run(INITIAL_CHAT_SESSION, [
    { type: 'thread.opened', threadId: 'T1' },
    { type: 'ask.started', turn: TURN },
    { type: 'message.persisted', threadId: 'T1', message: U1 },
    ...STREAM_TO_TEXT,
    streamEvent(sse('turn.completed', 5, { message_id: 'a1', message: A1_SEALED })),
  ])
  assert.deepEqual(ids(handedOff), ['u1', 'a1'])

  const withoutAnswer = reduceChatSession(handedOff, { type: 'history.loaded', threadId: 'T1', gen: 1, messages: [U1] })
  assert.deepEqual(ids(withoutAnswer), ['u1', 'a1'])

  const withAnswer = reduceChatSession(handedOff, { type: 'history.loaded', threadId: 'T1', gen: 1, messages: [U1, A1_SEALED] })
  assert.deepEqual(ids(withAnswer), ['u1', 'a1'])
  assert.deepEqual(withAnswer.history.local, [])
})

test('a completion without a valid sealed message fails with Reload thread, which loads the thread', () => {
  const failed = completedT1({ message_id: 'a1' })
  assert.equal(failed.turn.phase, 'failed')
  assert.deepEqual(
    failed.turn.phase === 'failed' ? [failed.turn.recovery, failed.turn.error] : null,
    ['reload_thread', "Couldn't show the saved copy of this answer."],
  )
  assert.equal(streamedText(failed.turn), "NVIDIA's revenue rose")
  assert.deepEqual(ids(failed), ['u1'])
  assert.equal(failed.sealedTurns, 0)
  assert.equal(selectThreadView(failed).needsLoad, null)
  assert.equal(reduceChatSession(failed, { type: 'stream.reopened' }), failed)

  const reloading = reduceChatSession(failed, { type: 'history.requested' })
  assert.deepEqual(selectThreadView(reloading).needsLoad, { threadId: 'T1', gen: 2 })
})

const answerShown = (state: ChatSessionState) =>
  [streamedText(state.turn) === "NVIDIA's revenue rose", ids(state).includes('a1')]

test('Reload thread keeps the streamed answer until the load that has it hands off in one state', () => {
  const failed = completedT1({ message_id: 'a1' })
  const reloading = reduceChatSession(failed, { type: 'history.requested' })
  assert.deepEqual(answerShown(reloading), [true, false])
  assert.equal(reloading.turn.phase === 'failed' ? reloading.turn.recovery : null, 'reload_thread')

  const loaded = reduceChatSession(reloading, { type: 'history.loaded', threadId: 'T1', gen: 2, messages: [U1, A1_SEALED] })
  assert.equal(loaded.turn.phase, 'idle')
  assert.deepEqual(answerShown(loaded), [false, true])
  assert.deepEqual(ids(loaded), ['u1', 'a1'])
  assert.equal(loaded.sealedTurns, 1)
})

test('a failed reload keeps the streamed answer and Reload thread, and says the load failed', () => {
  const reloading = reduceChatSession(completedT1({ message_id: 'a1' }), { type: 'history.requested' })
  const failedLoad = reduceChatSession(reloading, { type: 'history.failed', threadId: 'T1', gen: 2, message: 'HTTP 503' })
  assert.deepEqual(answerShown(failedLoad), [true, false])
  assert.deepEqual(
    failedLoad.turn.phase === 'failed' ? [failedLoad.turn.recovery, failedLoad.turn.error] : null,
    ['reload_thread', "Couldn't load the saved copy of this answer."],
  )
  assert.equal(selectThreadView(failedLoad).needsLoad, null)
  assert.deepEqual(selectThreadView(reduceChatSession(failedLoad, { type: 'history.requested' })).needsLoad, { threadId: 'T1', gen: 3 })
})

test('a reload whose thread lacks the answer keeps the streamed answer and Reload thread', () => {
  const reloading = reduceChatSession(completedT1({ message_id: 'a1' }), { type: 'history.requested' })
  const loaded = reduceChatSession(reloading, { type: 'history.loaded', threadId: 'T1', gen: 2, messages: [U1] })
  assert.deepEqual(answerShown(loaded), [true, false])
  assert.deepEqual(
    loaded.turn.phase === 'failed' ? [loaded.turn.recovery, loaded.turn.error] : null,
    ['reload_thread', "The saved copy of this answer isn't in the thread yet."],
  )
  assert.equal(loaded.sealedTurns, 0)
})

test('canAsk is true only when no turn is in flight', () => {
  const opened = reduceChatSession(INITIAL_CHAT_SESSION, { type: 'thread.opened', threadId: 'T1' })
  const persisting = reduceChatSession(opened, { type: 'ask.started', turn: TURN })
  const streaming = streamingT1()
  const failed = reduceChatSession(streaming, { type: 'stream.disconnected', threadId: 'T1', runId: 'run-1' })
  const unsealed = completedT1({ message_id: 'a1' })
  const unverified = reduceChatSession(streaming, streamEvent(sse('turn.completed', 5, {
    unverified: { persisted: false, failures: [], blocks: [] },
  })))
  const notSent = reduceChatSession(persisting, { type: 'ask.failed', error: 'HTTP 500' })

  const table = { opened, persisting, streaming, failed, unsealed, unverified, notSent }
  assert.deepEqual(
    Object.fromEntries(Object.entries(table).map(([name, state]) => [name, [state.turn.phase, selectThreadView(state).canAsk]])),
    {
      opened: ['idle', true],
      persisting: ['persisting', false],
      streaming: ['streaming', false],
      failed: ['failed', true],
      unsealed: ['failed', true],
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

  const t2 = reduceChatSession(streamingT1(), { type: 'thread.opened', threadId: 'T2' })
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
  assert.deepEqual(failed.turn.phase === 'failed' ? [failed.turn.recovery, failed.turn.error] : null, ['retry_stream', 'The analyst stream disconnected.'])

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

const sealed = (id: string, text: string, threadId = 'T1'): ChatMessage =>
  ({ ...message(id, 'assistant', text), thread_id: threadId, block_proofs: {} })
const U2 = message('u2', 'user', 'Compare with AMD')
const A2 = sealed('a2', 'AMD trails on margin')

function nextTurn(runId: string, messageId: string, answer: ChatMessage): ReadonlyArray<ChatSessionAction> {
  const ev = (type: ChatSseEvent['type'], seq: number, payload: Record<string, unknown> = {}) =>
    streamEvent(sse(type, seq, { run_id: runId, turn_id: messageId, ...payload }))
  return [
    { type: 'ask.started', turn: { ...TURN, runId, messageId } },
    { type: 'message.persisted', threadId: 'T1', message: message(messageId, 'user', 'Compare with AMD') },
    ev('turn.started', 1),
    ev('turn.completed', 2, { message_id: answer.message_id, message: answer }),
  ]
}

const dropT1: ChatSessionAction = { type: 'stream.disconnected', threadId: 'T1', runId: 'run-1' }

test('an answer that commits after its stream dropped is loaded when the next turn hands off, not when it is asked', () => {
  const dropped = reduceChatSession(streamingT1(), dropT1)
  const [ask, persisted, ...turn2] = nextTurn('run-2', 'u2', A2)
  const asked = run(dropped, [ask, persisted])
  assert.equal(selectThreadView(asked).needsLoad, null)

  const handedOff = run(asked, turn2)
  assert.equal(handedOff.turn.phase, 'idle')
  assert.deepEqual(ids(handedOff), ['u1', 'u2', 'a2'])
  assert.deepEqual(selectThreadView(handedOff).needsLoad, { threadId: 'T1', gen: 2 })

  const loaded = reduceChatSession(handedOff, { type: 'history.loaded', threadId: 'T1', gen: 2, messages: [U1, A1, U2, A2] })
  assert.deepEqual(ids(loaded), ['u1', 'a1', 'u2', 'a2'])
  assert.equal(selectThreadView(loaded).needsLoad, null)

  const third = run(loaded, nextTurn('run-3', 'u3', sealed('a3', 'Both')))
  assert.equal(selectThreadView(third).needsLoad, null)
})

test('the hand-off after a failed turn of either kind loads the thread; after a handed-off turn it does not', () => {
  const loads = Object.fromEntries(Object.entries({
    dropped: reduceChatSession(streamingT1(), dropT1),
    unsealed: completedT1({ message_id: 'a1' }),
    handedOff: completedT1(),
  }).map(([name, state]) => [name, selectThreadView(run(state, nextTurn('run-2', 'u2', A2))).needsLoad]))
  assert.deepEqual(loads, {
    dropped: { threadId: 'T1', gen: 2 },
    unsealed: { threadId: 'T1', gen: 2 },
    handedOff: null,
  })
})

test('when the next turn also fails, the hand-off after it still loads the thread', () => {
  const [ask2, persisted2] = nextTurn('run-2', 'u2', A2)
  const twiceFailed = run(streamingT1(), [dropT1, ask2, persisted2, { type: 'stream.disconnected', threadId: 'T1', runId: 'run-2' }])
  assert.equal(twiceFailed.turn.phase, 'failed')
  assert.equal(selectThreadView(twiceFailed).needsLoad, null)

  const handedOff = run(twiceFailed, nextTurn('run-3', 'u3', sealed('a3', 'Both')))
  assert.deepEqual(selectThreadView(handedOff).needsLoad, { threadId: 'T1', gen: 2 })
})

test('switching threads drops the pending reconcile of a failed turn', () => {
  const [ask2] = nextTurn('run-2', 'u2', A2)
  const switched = run(streamingT1(), [
    dropT1,
    ask2,
    { type: 'thread.opened', threadId: 'T2' },
    { type: 'history.loaded', threadId: 'T2', gen: 1, messages: [] },
  ])
  const t2Turn: ReadonlyArray<ChatSessionAction> = [
    { type: 'ask.started', turn: { ...TURN, runId: 'run-9', messageId: 'u9' } },
    { type: 'message.persisted', threadId: 'T2', message: message('u9', 'user', 'Hi') },
    streamEvent(sse('turn.started', 1, { run_id: 'run-9', turn_id: 'u9', thread_id: 'T2' }), 'T2'),
    streamEvent(sse('turn.completed', 2, { run_id: 'run-9', turn_id: 'u9', thread_id: 'T2', message_id: 'a9', message: sealed('a9', 'Hello', 'T2') }), 'T2'),
  ]
  const handedOff = run(switched, t2Turn)
  assert.equal(handedOff.turn.phase, 'idle')
  assert.deepEqual(ids(handedOff), ['u9', 'a9'])
  assert.equal(selectThreadView(handedOff).needsLoad, null)
})

test('a Reload thread hand-off after a failed turn is the reconciling load, so the next hand-off makes none', () => {
  const [ask2, persisted2, started2] = nextTurn('run-2', 'u2', A2)
  const unsealed2 = run(streamingT1(), [
    dropT1, ask2, persisted2, started2,
    streamEvent(sse('turn.completed', 2, { run_id: 'run-2', turn_id: 'u2', message_id: 'a2' })),
    { type: 'history.requested' },
  ])
  assert.deepEqual(selectThreadView(unsealed2).needsLoad, { threadId: 'T1', gen: 2 })
  const reloaded = reduceChatSession(unsealed2, { type: 'history.loaded', threadId: 'T1', gen: 2, messages: [U1, A1, U2, A2] })
  assert.equal(reloaded.turn.phase, 'idle')
  assert.deepEqual(ids(reloaded), ['u1', 'a1', 'u2', 'a2'])

  const third = run(reloaded, nextTurn('run-3', 'u3', sealed('a3', 'Both')))
  assert.deepEqual(ids(third), ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
  assert.equal(selectThreadView(third).needsLoad, null)
})

test('a reconciling load that fails keeps the mark, so the next hand-off loads the thread again', () => {
  const dropped = reduceChatSession(streamingT1(), dropT1)
  const handedOff = run(dropped, nextTurn('run-2', 'u2', A2))
  assert.deepEqual(selectThreadView(handedOff).needsLoad, { threadId: 'T1', gen: 2 })

  const failed = reduceChatSession(handedOff, { type: 'history.failed', threadId: 'T1', gen: 2, message: 'HTTP 502' })
  assert.equal(selectThreadView(failed).needsLoad, null)

  const third = run(failed, nextTurn('run-3', 'u3', sealed('a3', 'Both')))
  assert.deepEqual(selectThreadView(third).needsLoad, { threadId: 'T1', gen: 3 })
  const loaded = reduceChatSession(third, { type: 'history.loaded', threadId: 'T1', gen: 3, messages: [U1, A1, U2, A2] })
  assert.deepEqual(ids(loaded), ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
  assert.equal(selectThreadView(run(loaded, nextTurn('run-4', 'u4', sealed('a4', 'Done')))).needsLoad, null)
})

test('an opening history load that lands after asking does not count as reconciling the failed turn', () => {
  const openingPending = run(INITIAL_CHAT_SESSION, [
    { type: 'thread.opened', threadId: 'T1' },
    { type: 'ask.started', turn: TURN },
    { type: 'message.persisted', threadId: 'T1', message: U1 },
    ...STREAM_TO_TEXT,
    dropT1,
  ])
  const [ask2, persisted2, ...turn2] = nextTurn('run-2', 'u2', A2)
  const asked = run(openingPending, [ask2, persisted2])
  const openingLanded = reduceChatSession(asked, { type: 'history.loaded', threadId: 'T1', gen: 1, messages: [U1] })

  const handedOff = run(openingLanded, turn2)
  assert.deepEqual(selectThreadView(handedOff).needsLoad, { threadId: 'T1', gen: 2 })
  const loaded = reduceChatSession(handedOff, { type: 'history.loaded', threadId: 'T1', gen: 2, messages: [U1, A1, U2, A2] })
  assert.deepEqual(ids(loaded), ['u1', 'a1', 'u2', 'a2'])
  assert.equal(selectThreadView(run(loaded, nextTurn('run-3', 'u3', sealed('a3', 'Both')))).needsLoad, null)
})
