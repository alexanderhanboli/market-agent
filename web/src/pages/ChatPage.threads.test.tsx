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
    assert.equal(sidebar(h).textContent, '+ New chatChatsLoading chats')
    assert.equal(sidebar(h).querySelector('span[role="status"]')?.textContent, 'Loading chats')

    await act(async () => list.resolve({ body: { threads: [] } }))
    await h.flush()
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
    assert.equal(sidebar(h).textContent, "+ New chatChatsCouldn't load your chats.RetryDetailsHTTP 502")

    await act(async () => h.button('Retry').click())
    await h.flush()
    assert.equal(server.gets('/v1/chat/threads'), 2)
    assert.deepEqual([...sidebar(h).querySelectorAll('a span:first-child')].map((span) => span.textContent), ['Chips', 'Rates'])
  } finally {
    await h.cleanup()
  }
})

test('Retry swaps the failure for loading rows while the list reloads', async () => {
  const server = new FakeServer()
  const second = deferred<{ body: unknown }>()
  let reads = 0
  server.listReply = () => (++reads === 1 ? { status: 503, body: {} } : second.promise)
  const h = await renderChat('/chat', server)
  try {
    assert.equal(sidebar(h).textContent, "+ New chatChatsCouldn't load your chats.RetryDetailsHTTP 503")

    await act(async () => h.button('Retry').click())
    await h.flush()
    assert.equal(sidebar(h).textContent, '+ New chatChatsLoading chats')

    await act(async () => second.resolve({ body: { threads: TWO_THREADS } }))
    await h.flush()
    assert.deepEqual([...sidebar(h).querySelectorAll('a span:first-child')].map((span) => span.textContent), ['Chips', 'Rates'])
  } finally {
    await h.cleanup()
  }
})

const UNDO_MS = 5000
const DELETE_T1: [string, string, string] = ['DELETE', '/v1/chat/threads/T1', '']
const DELETE_T2: [string, string, string] = ['DELETE', '/v1/chat/threads/T2', '']

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
    await tick(h, t, UNDO_MS * 2)
    assert.deepEqual(server.writes(), [])
  } finally {
    await h.cleanup()
  }
})

test('delete announces through the sidebar\'s standing status region and focuses Undo', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h } = await chatsWithTwoThreads()
  try {
    const region = sidebar(h).querySelector('p[role="status"]')
    assert.equal(region?.textContent, '')

    await act(async () => h.button('Delete Chips').click())
    assert.ok(sidebar(h).querySelector('p[role="status"]') === region, 'the same region announces')
    assert.equal(region?.textContent, 'Chat deleted.')
    assert.equal(h.dom.window.document.activeElement?.getAttribute('aria-label'), 'Undo deleting Chips')

    await tick(h, t, UNDO_MS)
    assert.equal(region?.textContent, '')
  } finally {
    await h.cleanup()
  }
})

function focused(h: Harness): string {
  const element = h.dom.window.document.activeElement
  if (element === null || element.tagName === 'BODY') return 'BODY'
  return element?.getAttribute('aria-label') ?? element?.querySelector('span')?.textContent ?? element?.textContent ?? ''
}

test('Undo puts focus on the restored chat link', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h } = await chatsWithTwoThreads()
  try {
    await act(async () => h.button('Delete Chips').click())
    assert.equal(focused(h), 'Undo deleting Chips')

    await act(async () => h.button('Undo').click())
    assert.equal(focused(h), 'Chips')
  } finally {
    await h.cleanup()
  }
})

test('the undo window elapsing moves focus from Undo to the next chat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h } = await chatsWithTwoThreads()
  try {
    await act(async () => h.button('Delete Chips').click())
    await tick(h, t, UNDO_MS)
    assert.equal(focused(h), 'Rates')
  } finally {
    await h.cleanup()
  }
})

test('the undo window elapsing on the last chat moves focus to New chat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const server = new FakeServer()
  server.threads = [TWO_THREADS[0]]
  const h = await renderChat('/chat', server)
  try {
    await act(async () => h.button('Delete Chips').click())
    await tick(h, t, UNDO_MS)
    assert.equal(focused(h), '+ New chat')
  } finally {
    await h.cleanup()
  }
})

test('the undo window elapsing leaves focus alone once it has left Undo', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h } = await chatsWithTwoThreads()
  try {
    await act(async () => h.button('Delete Chips').click())
    const composer = h.query('textarea') as HTMLTextAreaElement
    composer.focus()
    await tick(h, t, UNDO_MS)
    assert.equal(h.dom.window.document.activeElement?.tagName, 'TEXTAREA')
  } finally {
    await h.cleanup()
  }
})

test('the undo window elapsing sends exactly one DELETE and drops the chat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h, server } = await chatsWithTwoThreads()
  try {
    await act(async () => h.button('Delete Chips').click())
    await tick(h, t, UNDO_MS - 1)
    assert.deepEqual(server.writes(), [])

    await tick(h, t, 1)
    await tick(h, t, UNDO_MS * 2)
    assert.deepEqual(server.writes(), [DELETE_T1])
    assert.deepEqual(shownChats(h), ['Rates'])
    assert.doesNotMatch(sidebar(h).textContent ?? '', /Chat deleted/)
  } finally {
    await h.cleanup()
  }
})

test('a second delete sends the first at once and keeps its own undo window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h, server } = await chatsWithTwoThreads()
  try {
    await act(async () => h.button('Delete Chips').click())
    await tick(h, t, 1000)
    await act(async () => h.button('Delete Rates').click())
    await h.flush()
    assert.deepEqual(server.writes(), [DELETE_T1])

    await tick(h, t, UNDO_MS - 500)
    assert.deepEqual(server.writes(), [DELETE_T1])
    assert.equal(h.button('Undo').getAttribute('aria-label'), 'Undo deleting Rates')

    await tick(h, t, 500)
    await tick(h, t, UNDO_MS * 2)
    assert.deepEqual(server.writes(), [DELETE_T1, DELETE_T2])
    assert.equal(sidebar(h).textContent, '+ New chatChatsNo chats yet.')
  } finally {
    await h.cleanup()
  }
})

test('collapsing the sidebar keeps the pending delete and its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h, server } = await chatsWithTwoThreads('/chat/T2')
  try {
    await act(async () => h.button('Delete Chips').click())
    await act(async () => h.button('Collapse sidebar').click())
    await h.flush()
    assert.deepEqual(server.writes(), [])

    await act(async () => h.button('Expand sidebar').click())
    assert.equal(h.button('Undo').getAttribute('aria-label'), 'Undo deleting Chips')
    await tick(h, t, UNDO_MS)
    await tick(h, t, UNDO_MS)
    assert.deepEqual(server.writes(), [DELETE_T1])
  } finally {
    await h.cleanup()
  }
})

test('leaving and coming back while the DELETE is in flight keeps the chat hidden until the list drops it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h, server } = await chatsWithTwoThreads()
  const held = deferred<{ body: unknown }>()
  server.deleteReply = () => held.promise
  try {
    await act(async () => h.button('Delete Chips').click())
    await h.navigate('/home')
    await tick(h, t, UNDO_MS)
    assert.deepEqual(server.writes(), [DELETE_T1])

    await h.navigate('/chat')
    assert.deepEqual(shownChats(h), ['Rates'])

    server.threads = server.threads.filter((thread) => thread.thread_id !== 'T1')
    await act(async () => held.resolve({ body: {} }))
    await h.flush()
    assert.equal(server.gets('/v1/chat/threads'), 3)
    assert.deepEqual(shownChats(h), ['Rates'])
    await tick(h, t, UNDO_MS * 2)
    assert.deepEqual(server.writes(), [DELETE_T1])
  } finally {
    await h.cleanup()
  }
})

test('Back to a chat deleted while open reopens it and cancels the delete', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const server = new FakeServer()
  server.threads = [...TWO_THREADS]
  const h = await renderChat('/home', server)
  try {
    await h.navigate('/chat/T1')
    await act(async () => h.button('Delete Chips').click())
    await h.flush()
    assert.equal(h.path(), '/chat')

    await h.back()
    assert.equal(h.path(), '/chat/T1')
    assert.deepEqual(shownChats(h), ['Chips', 'Rates'])
    await tick(h, t, UNDO_MS * 2)
    assert.deepEqual(server.writes(), [])
  } finally {
    await h.cleanup()
  }
})

test('Back to a chat whose delete already went out lands on /chat instead of a dead chat', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const server = new FakeServer()
  server.threads = [...TWO_THREADS]
  const h = await renderChat('/home', server)
  try {
    await h.navigate('/chat/T1')
    await act(async () => h.button('Delete Chips').click())
    await tick(h, t, UNDO_MS + 1000)
    assert.deepEqual(server.writes(), [DELETE_T1])
    server.history = () => ({ status: 404, body: { error: 'not found' } })

    await h.back()
    assert.equal(h.path(), '/chat')
    assert.deepEqual(shownChats(h), ['Rates'])
    assert.doesNotMatch(h.text(), /Couldn't load this chat\./)
  } finally {
    await h.cleanup()
  }
})

test('opening the chat that is pending delete cancels the delete', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h, server } = await chatsWithTwoThreads('/chat/T2')
  try {
    await act(async () => h.button('Delete Chips').click())
    await h.navigate('/chat/T1')
    assert.deepEqual(shownChats(h), ['Chips', 'Rates'])
    assert.doesNotMatch(sidebar(h).textContent ?? '', /Chat deleted/)

    await tick(h, t, UNDO_MS * 2)
    assert.deepEqual(server.writes(), [])
  } finally {
    await h.cleanup()
  }
})

const alertText = (h: Harness) => sidebar(h).querySelector('[role="alert"]')?.textContent
const shownDeleteError = (h: Harness) =>
  [...sidebar(h).querySelectorAll('p:not([role])')].find((p) => p.textContent === "Couldn't delete the chat.")

test('a failed delete restores the row and says it could not delete', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h, server } = await chatsWithTwoThreads()
  server.deleteReply = () => ({ status: 500, body: { error: 'boom' } })
  try {
    const region = sidebar(h).querySelector('[role="alert"]')
    assert.equal(region?.textContent, '')

    await act(async () => h.button('Delete Chips').click())
    await tick(h, t, UNDO_MS)
    assert.deepEqual(shownChats(h), ['Chips', 'Rates'])
    assert.ok(sidebar(h).querySelector('[role="alert"]') === region, 'the same region announces')
    assert.equal(region?.textContent, "Couldn't delete the chat.")
    assert.equal(shownDeleteError(h)?.getAttribute('aria-hidden'), 'true', 'readers hear the sentence once')
    assert.match(sidebar(h).textContent ?? '', /Couldn't delete the chat\.DetailsHTTP 500Chats/)
    assert.deepEqual(server.writes(), [DELETE_T1])
  } finally {
    await h.cleanup()
  }
})

test('a delete error is gone once the list re-reads, and a remounted sidebar raises no alert', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h, server } = await chatsWithTwoThreads()
  server.deleteReply = () => ({ status: 500, body: { error: 'boom' } })
  server.createdThreadId = 'T3'
  try {
    await act(async () => h.button('Delete Chips').click())
    await tick(h, t, UNDO_MS)
    assert.equal(alertText(h), "Couldn't delete the chat.")
    const reads = server.gets('/v1/chat/threads')

    await h.ask('Analyze NVDA')
    assert.equal(server.gets('/v1/chat/threads'), reads + 1)
    assert.doesNotMatch(sidebar(h).textContent ?? '', /Couldn't delete/)

    await act(async () => h.button('Collapse sidebar').click())
    await act(async () => h.button('Expand sidebar').click())
    assert.equal(alertText(h), '')
    assert.doesNotMatch(sidebar(h).textContent ?? '', /Couldn't delete/)
  } finally {
    await h.cleanup()
  }
})

test('a sidebar remounted before the list re-reads still shows the delete error but does not raise it again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { h, server } = await chatsWithTwoThreads('/chat/T2')
  server.deleteReply = () => ({ status: 500, body: { error: 'boom' } })
  try {
    await act(async () => h.button('Delete Chips').click())
    await tick(h, t, UNDO_MS)
    assert.equal(alertText(h), "Couldn't delete the chat.")

    await act(async () => h.button('Collapse sidebar').click())
    await act(async () => h.button('Expand sidebar').click())
    assert.equal(alertText(h), '')
    assert.equal(shownDeleteError(h)?.getAttribute('aria-hidden'), null, 'with the region quiet, readers find the shown sentence')
    assert.match(sidebar(h).textContent ?? '', /Couldn't delete the chat\.DetailsHTTP 500Chats/)
  } finally {
    await h.cleanup()
  }
})
