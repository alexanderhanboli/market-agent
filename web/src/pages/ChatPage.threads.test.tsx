import './installDomBeforeReact.ts'

import assert from 'node:assert/strict'
import test from 'node:test'

import { act } from 'react'

import { FakeServer, deferred, renderChat, TWO_THREADS, type Harness } from './chatPageHarness.tsx'

function sidebar(h: Harness): Element {
  const nav = h.query('nav[aria-label="Chats"]')
  assert.ok(nav, 'the chat sidebar is rendered')
  return nav
}

test('while the first list loads the sidebar shows row skeletons, not the empty state', async () => {
  const server = new FakeServer()
  const list = deferred<{ body: unknown }>()
  server.listReply = () => list.promise
  const h = await renderChat('/chat', server)
  try {
    assert.notEqual(sidebar(h).querySelector('[role="status"][aria-label="Loading chats"]'), null)
    assert.equal(sidebar(h).textContent, '+ New chatChats')

    await act(async () => list.resolve({ body: { threads: [] } }))
    await h.flush()
    assert.equal(sidebar(h).querySelector('[aria-label="Loading chats"]'), null)
    assert.equal(sidebar(h).textContent, '+ New chatChatsNo chats yet.')
  } finally {
    await h.cleanup()
  }
})

test('a failed first list load says so, keeps the reason in details, and Retry reloads it', async () => {
  const server = new FakeServer()
  let reads = 0
  server.listReply = () => (++reads === 1 ? { status: 502, body: { error: 'bad gateway' } } : { body: { threads: TWO_THREADS } })
  const h = await renderChat('/chat', server)
  try {
    assert.equal(sidebar(h).querySelector('p')?.textContent, "Couldn't load your chats.")
    assert.equal(sidebar(h).querySelector('details')?.textContent, 'DetailsHTTP 502')

    await act(async () => h.button('Retry').click())
    await h.flush()
    assert.equal(server.gets('/v1/chat/threads'), 2)
    assert.deepEqual([...sidebar(h).querySelectorAll('a span:first-child')].map((span) => span.textContent), ['Chips', 'Rates'])
  } finally {
    await h.cleanup()
  }
})

const UNDO_MS = 5000

function shownChats(h: Harness): string[] {
  return [...sidebar(h).querySelectorAll('a span:first-child')].map((span) => span.textContent ?? '')
}

async function chatsWithTwoThreads(path = '/chat'): Promise<{ h: Harness; server: FakeServer }> {
  const server = new FakeServer()
  server.threads = [...TWO_THREADS]
  return { h: await renderChat(path, server), server }
}

async function tick(h: Harness, t: test.TestContext, ms: number): Promise<void> {
  await act(async () => t.mock.timers.tick(ms))
  await h.flush()
}

test('delete hides the row at once, and Undo restores it without a DELETE', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h, server } = await chatsWithTwoThreads()
  try {
    await act(async () => h.button('Delete Chips').click())
    assert.deepEqual(shownChats(h), ['Rates'])
    assert.match(sidebar(h).textContent ?? '', /Chat deleted\.Undo/)

    await act(async () => h.button('Undo').click())
    assert.deepEqual(shownChats(h), ['Chips', 'Rates'])
    await tick(h, t, UNDO_MS)
    assert.deepEqual(server.writes(), [])
  } finally {
    await h.cleanup()
  }
})

test('the undo window elapsing sends one DELETE and drops the chat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h, server } = await chatsWithTwoThreads()
  try {
    await act(async () => h.button('Delete Chips').click())
    await tick(h, t, UNDO_MS - 1)
    assert.deepEqual(server.writes(), [])

    await tick(h, t, 1)
    await tick(h, t, UNDO_MS)
    assert.deepEqual(server.writes(), [['DELETE', '/v1/chat/threads/T1', '']])
    assert.deepEqual(shownChats(h), ['Rates'])
    assert.doesNotMatch(sidebar(h).textContent ?? '', /Chat deleted/)
  } finally {
    await h.cleanup()
  }
})

test('starting a second delete sends the first one at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h, server } = await chatsWithTwoThreads()
  try {
    await act(async () => h.button('Delete Chips').click())
    await act(async () => h.button('Delete Rates').click())
    await h.flush()
    assert.deepEqual(server.writes(), [['DELETE', '/v1/chat/threads/T1', '']])
    assert.deepEqual(shownChats(h), [])
    assert.match(sidebar(h).textContent ?? '', /Chat deleted\.Undo/)
  } finally {
    await h.cleanup()
  }
})

test('collapsing the sidebar sends a pending delete', async () => {
  const { h, server } = await chatsWithTwoThreads('/chat/T2')
  try {
    await act(async () => h.button('Delete Chips').click())
    assert.deepEqual(server.writes(), [])
    await act(async () => h.button('Collapse sidebar').click())
    await h.flush()
    assert.deepEqual(server.writes(), [['DELETE', '/v1/chat/threads/T1', '']])
  } finally {
    await h.cleanup()
  }
})

test('deleting the open chat leaves it for /chat at once', async () => {
  const { h } = await chatsWithTwoThreads('/chat/T1')
  try {
    assert.equal(h.path(), '/chat/T1')
    await act(async () => h.button('Delete Chips').click())
    await h.flush()
    assert.equal(h.path(), '/chat')
  } finally {
    await h.cleanup()
  }
})

test('a failed delete restores the row and says it could not delete', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h, server } = await chatsWithTwoThreads()
  server.deleteReply = () => ({ status: 500, body: { error: 'boom' } })
  try {
    await act(async () => h.button('Delete Chips').click())
    await tick(h, t, UNDO_MS)
    assert.deepEqual(shownChats(h), ['Chips', 'Rates'])
    assert.equal(sidebar(h).querySelector('p')?.textContent, "Couldn't delete the chat.")
    assert.equal(sidebar(h).querySelector('details')?.textContent, 'DetailsHTTP 500')
  } finally {
    await h.cleanup()
  }
})
