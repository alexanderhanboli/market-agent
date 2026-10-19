import './installDomBeforeReact.ts'

import assert from 'node:assert/strict'
import test from 'node:test'

import { act } from 'react'

import { FakeServer, deferred, renderChat, TWO_THREADS } from './chatPageHarness.tsx'

function sidebar(h: { query: (selector: string) => Element | null }): Element {
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
