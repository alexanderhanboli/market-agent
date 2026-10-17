import './installDomBeforeReact.ts'

import assert from 'node:assert/strict'
import test from 'node:test'

import { act } from 'react'

import {
  USER_ID,
  ANSWER,
  FakeEventSource,
  chatMessage,
  sealedAnswer,
  answerMessage,
  FakeServer,
  renderChat,
  occurrences,
  streamAnswer,
  complete,
  consecutive,
  HISTORY_T1,
  SEALED_TEXT,
  TWO_THREADS,
  T2_QUESTION,
  STILL_ANSWERING,
  UUID_PATTERN,
  openThread,
  streamParams,
  threadRead,
  type Harness,
  type RunJson,
} from './chatPageHarness.tsx'

async function dropStream(h: Harness, source: FakeEventSource) {
  await act(async () => source.onerror?.())
  await h.flush()
}

const runOf = (source: FakeEventSource) => ({ run_id: source.params.get('run_id')!, turn_id: source.params.get('turn_id')! })

test('an own stream that opened and dropped, whose run the server no longer lists, shows the thread as it is with no stream that could start it again', async () => {
  const server = new FakeServer()
  server.history = (id) => threadRead(server.posted.size === 0 ? [] : [server.postedUser(id), sealedAnswer(id)])
  const h = await renderChat('/chat/T1', server)
  try {
    await h.ask('Analyze NVDA')
    const own = FakeEventSource.instances[0]
    await act(async () => own.open())
    await dropStream(h, own)

    assert.equal(FakeEventSource.instances.length, 1)
    assert.equal(server.gets(HISTORY_T1), 2)
    assert.equal(occurrences(h.text(), ANSWER), 1)
    assert.equal(h.query('[data-role="assistant"]')?.textContent, SEALED_TEXT)
    assert.equal(h.query('[data-testid="streaming-turn"]'), null)
    assert.doesNotMatch(h.text(), /didn't answer/)
    assert.equal(h.button('Send').disabled, false)
  } finally {
    await h.cleanup()
  }
})

test("an own run listed in flight after another tab's answered run is attached, and that tab's answer is never taken as ours", async () => {
  const server = new FakeServer()
  let reads = 0
  let own: RunJson | null = null
  server.history = (id) => (++reads === 1
    ? threadRead([])
    : threadRead(
      [chatMessage(id, 'u0', 'user', 'What did the Fed do?'), server.postedUser(id), answerMessage(id, 'a0', 'The Fed held rates')],
      [{ run_id: 'r0', turn_id: 'u0', status: 'completed', message_id: 'a0' }, own!],
    ))
  const h = await renderChat('/chat/T1', server)
  try {
    await h.ask('Analyze NVDA')
    const first = FakeEventSource.instances[0]
    own = { ...runOf(first), status: 'in_flight' }
    await act(async () => first.emit('turn.started', 1))
    await dropStream(h, first)

    assert.equal(FakeEventSource.instances.length, 2)
    const attached = FakeEventSource.instances[1]
    assert.deepEqual(streamParams(attached), { ...runOf(first), user_id: USER_ID, attach: '1' })
    assert.equal(server.gets(HISTORY_T1), 2)
    assert.equal(occurrences(h.text(), 'The Fed held rates'), 1)
    assert.match(h.text(), STILL_ANSWERING)
    assert.equal(h.button('Send').disabled, true)

    await streamAnswer(h, attached)
    assert.equal(h.button('Send').disabled, true)
    await complete(h, attached)
    assert.equal(occurrences(h.text(), ANSWER), 1)
    assert.equal(occurrences(h.text(), 'The Fed held rates'), 1)
    assert.equal(h.button('Send').disabled, false)
  } finally {
    await h.cleanup()
  }
})

// A's first connection stalls; the user leaves, comes back and sends B; A's
// released stream then reaches the server, so A queues behind B.
async function releasedBehindAnother(aDone: 'in_flight' | 'completed') {
  const server = new FakeServer()
  server.threads = TWO_THREADS
  const runs: RunJson[] = []
  const answers: ReturnType<typeof answerMessage>[] = []
  server.history = (id) => (id === 'T2'
    ? threadRead([T2_QUESTION])
    : threadRead([...[...server.posted.values()].filter((m) => m.thread_id === id), ...answers], runs))
  const h = await renderChat('/chat/T1', server)
  await h.ask('First question')
  const a = FakeEventSource.instances[0]
  await openThread(h, 'T2')
  await openThread(h, 'T1')
  assert.equal(a.closed, false)
  assert.equal(h.button('Send').disabled, false)

  await h.ask('Second question')
  const b = FakeEventSource.instances[1]
  assert.equal(b.params.get('user_intent'), 'Second question')
  runs.push({ ...runOf(b), status: 'in_flight' })
  await act(async () => b.emit('turn.started', 1))
  runs.push({ ...runOf(a), status: 'in_flight' })
  await act(async () => a.open())
  await h.flush()
  assert.equal(a.closed, true)
  assert.equal(FakeEventSource.instances.length, 2)

  const bAnswer = answerMessage('T1', 'aB', 'Second answer')
  answers.push(bAnswer)
  runs[0] = { ...runOf(b), status: 'completed', message_id: 'aB' }
  if (aDone === 'completed') {
    answers.push(answerMessage('T1', 'aA', 'First answer'))
    runs[1] = { ...runOf(a), status: 'completed', message_id: 'aA' }
  }
  await act(async () => b.emit('turn.completed', 2, { message_id: 'aB', message: bAnswer }))
  await h.flush()
  return { h, server, a, answers, runs }
}

test('a released run that reached the server behind the next question is attached by the load after that question completes', async () => {
  const { h, server, a, answers, runs } = await releasedBehindAnother('in_flight')
  try {
    assert.equal(server.gets(HISTORY_T1), 3)
    assert.equal(FakeEventSource.instances.length, 3)
    const attached = FakeEventSource.instances[2]
    assert.deepEqual(streamParams(attached), { ...runOf(a), user_id: USER_ID, attach: '1' })
    assert.equal(h.button('Send').disabled, true)
    assert.match(h.text(), STILL_ANSWERING)

    const aAnswer = answerMessage('T1', 'aA', 'First answer')
    answers.push(aAnswer)
    runs[1] = { ...runOf(a), status: 'completed', message_id: 'aA' }
    await act(async () => {
      attached.emit('turn.started', 1)
      attached.emit('turn.completed', 2, { message_id: 'aA', message: aAnswer })
    })
    await h.flush()
    assert.deepEqual([occurrences(h.text(), 'First answer'), occurrences(h.text(), 'Second answer')], [1, 1])
    assert.equal(h.button('Send').disabled, false)
  } finally {
    await h.cleanup()
  }
})

test('a released run that completed behind the next question shows its saved answer once after that question completes', async () => {
  const { h, server } = await releasedBehindAnother('completed')
  try {
    assert.equal(server.gets(HISTORY_T1), 3)
    assert.equal(FakeEventSource.instances.length, 2)
    assert.deepEqual([occurrences(h.text(), 'First answer'), occurrences(h.text(), 'Second answer')], [1, 1])
    assert.equal(h.query('[data-testid="streaming-turn"]'), null)
    assert.equal(h.button('Send').disabled, false)
  } finally {
    await h.cleanup()
  }
})

test("Retry on a failed run starts the same question as a fresh run: a new run id, the same turn and question, no attach", async () => {
  const server = new FakeServer()
  const h = await renderChat('/chat/T1', server)
  try {
    await h.ask('Analyze NVDA')
    const failed = FakeEventSource.instances[0]
    await act(async () => {
      failed.emit('turn.started', 1)
      failed.emit('turn.error', 2, { error: 'upstream_500' })
    })
    await h.flush()
    assert.match(h.text(), /Stream error: upstream_500/)

    await act(async () => h.button('Retry').click())
    await h.flush()
    assert.equal(FakeEventSource.instances.length, 2)
    const retried = FakeEventSource.instances[1]
    assert.match(retried.params.get('run_id')!, UUID_PATTERN)
    assert.notEqual(retried.params.get('run_id'), failed.params.get('run_id'))
    assert.deepEqual(
      [retried.params.get('turn_id'), retried.params.get('user_intent'), retried.params.get('attach')],
      [failed.params.get('turn_id'), 'Analyze NVDA', null],
    )
    assert.equal(h.button('Send').disabled, true)

    await streamAnswer(h, retried)
    await complete(h, retried)
    assert.equal(occurrences(h.text(), ANSWER), 1)
    assert.equal(h.button('Send').disabled, false)
  } finally {
    await h.cleanup()
  }
})

test('replayed events never refill the drop budget: twelve cycles of a replayed turn.started and a drop end offline after three reattaches', async () => {
  const server = new FakeServer()
  let reads = 0
  let own: RunJson | null = null
  server.history = (id) => (++reads === 1 ? threadRead([]) : threadRead([server.postedUser(id)], [own!]))
  const h = await renderChat('/chat/T1', server)
  try {
    await h.ask('Analyze NVDA')
    own = { ...runOf(FakeEventSource.instances[0]), status: 'in_flight' }
    for (let cycle = 0; cycle < 12; cycle++) {
      const source = FakeEventSource.instances.at(-1)!
      if (source.closed) break
      await act(async () => source.emit('turn.started', 1))
      await dropStream(h, source)
    }

    assert.match(h.text(), /Lost the connection to the analyst\./)
    assert.equal(FakeEventSource.instances.length, 4)
    assert.deepEqual(FakeEventSource.instances.slice(1).map((source) => source.params.get('attach')), ['1', '1', '1'])
    assert.equal(server.gets(HISTORY_T1), 4)
    assert.equal(h.button('Send').disabled, true)
  } finally {
    await h.cleanup()
  }
})

test("an own stream's turn.error opens no other stream", async () => {
  const server = new FakeServer()
  const h = await renderChat('/chat/T1', server)
  try {
    await h.ask('Analyze NVDA')
    const own = FakeEventSource.instances[0]
    await act(async () => {
      own.emit('turn.started', 1)
      own.emit('turn.error', 2, { error: 'upstream_500' })
    })
    await h.flush()

    assert.equal(FakeEventSource.instances.length, 1)
    assert.equal(own.closed, true)
    assert.equal(server.gets(HISTORY_T1), 1)
    assert.equal(h.button('Send').disabled, false)
  } finally {
    await h.cleanup()
  }
})

// display_unverified: the run's turn.completed carries the answer and names no saved message.
const unverifiedCompletion = (threadId: string) => ({
  unverified: { persisted: false, failures: [{ reason_code: 'missing_fact_ref' }], blocks: chatMessage(threadId, 'x1', 'assistant', ANSWER).blocks },
})

test('an unverified run that completed while its own stream was down is attached, and its answer shows once', async () => {
  const server = new FakeServer()
  let own: RunJson | null = null
  server.history = (id) => threadRead(server.posted.size === 0 ? [] : [server.postedUser(id)], own ? [own] : [])
  const h = await renderChat('/chat/T1', server)
  try {
    await h.ask('Analyze NVDA')
    const first = FakeEventSource.instances[0]
    await act(async () => first.open())
    await streamAnswer(h, first)
    own = { ...runOf(first), status: 'completed' }
    await dropStream(h, first)

    assert.equal(FakeEventSource.instances.length, 2)
    const attached = FakeEventSource.instances[1]
    assert.deepEqual(streamParams(attached), { ...runOf(first), user_id: USER_ID, attach: '1' })
    await streamAnswer(h, attached)
    await act(async () => attached.emit('turn.completed', 5, unverifiedCompletion('T1')))
    await h.flush()

    assert.equal(h.query('[data-testid="streaming-turn"]')?.getAttribute('data-turn-status'), 'unverified')
    assert.equal(occurrences(h.text(), ANSWER), 1)
    assert.match(h.text(), /This answer failed verification and was not saved\./)
    assert.equal(server.gets(HISTORY_T1), 2)
    assert.equal(FakeEventSource.instances.length, 2)
    assert.equal(h.button('Send').disabled, false)
  } finally {
    await h.cleanup()
  }
})

// The attach stream replays the run from its first event, one event per task as a browser delivers them.
async function replayAnswer(h: Harness, source: FakeEventSource) {
  await act(async () => source.emit('turn.started', 1))
  await act(async () => source.emit('block.began', 2, { block_id: 'b1', kind: 'rich_text' }))
  await act(async () => source.emit('block.delta', 3, { block_id: 'b1', delta: { segment: { type: 'text', text: ANSWER } } }))
  await act(async () => source.emit('block.completed', 4, { block_id: 'b1', content_hash: 'h1' }))
  await h.flush()
}

async function reattachedOwnRun(server: FakeServer) {
  let own: RunJson | null = null
  server.history = (id) => threadRead(server.posted.size === 0 ? [] : [server.postedUser(id)], own ? [own] : [])
  const h = await renderChat('/chat/T1', server)
  await h.ask('Analyze NVDA')
  const first = FakeEventSource.instances[0]
  await act(async () => first.open())
  await streamAnswer(h, first)
  const streamed = h.frames.length - 1
  own = { ...runOf(first), status: 'in_flight' }
  await dropStream(h, first)
  assert.equal(FakeEventSource.instances.length, 2)
  const attached = FakeEventSource.instances[1]
  assert.equal(attached.params.get('attach'), '1')
  await replayAnswer(h, attached)
  return { h, attached, sinceStreamed: () => h.frames.slice(streamed).map((frame) => occurrences(frame, ANSWER)) }
}

test('an own run keeps its streamed answer on screen in every commit through a drop, the reattach and the hand-off', async () => {
  const server = new FakeServer()
  const { h, attached, sinceStreamed } = await reattachedOwnRun(server)
  try {
    await complete(h, attached)
    assert.deepEqual(consecutive(sinceStreamed()), [1])
    assert.equal(h.query('[data-role="assistant"]')?.textContent, SEALED_TEXT)
    assert.equal(h.query('[data-testid="streaming-turn"]'), null)
    assert.equal(h.button('Send').disabled, false)
  } finally {
    await h.cleanup()
  }
})

test('a reattached own run that ends without its answer in the thread keeps the streamed answer beside the failure', async () => {
  for (const [ending, payload, notice] of [
    ['turn.error', { error: 'upstream_500' }, /Stream error: upstream_500/],
    ['turn.completed', { message_id: 'a1' }, /The saved copy of this answer isn't in the thread yet\./],
  ] as const) {
    const server = new FakeServer()
    const { h, attached, sinceStreamed } = await reattachedOwnRun(server)
    try {
      await act(async () => attached.emit(ending, 5, payload))
      await h.flush()
      assert.deepEqual(consecutive(sinceStreamed()), [1], ending)
      assert.equal(h.query('[data-testid="streaming-turn"]')?.getAttribute('data-turn-status'), 'failed', ending)
      assert.match(h.text(), notice)
    } finally {
      await h.cleanup()
    }
  }
})
