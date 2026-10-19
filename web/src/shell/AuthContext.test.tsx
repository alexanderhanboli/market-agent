import '../pages/installDomBeforeReact.ts'

import assert from 'node:assert/strict'
import test from 'node:test'

import { act, useContext } from 'react'
import { createRoot } from 'react-dom/client'

import { startThreadDelete, UNDO_DELETE_MS } from '../chat/threadDeletes.ts'
import { AuthProvider } from './AuthContext.tsx'
import { AuthContext, DEFAULT_MOCK_SESSION, type AuthContextValue } from './authTypes.ts'

test('signing out drops a pending chat delete instead of sending it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`)
    return new Response('{}', { status: 200 })
  }
  let auth: AuthContextValue | null = null
  function Probe() {
    auth = useContext(AuthContext)
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(<AuthProvider initialSession={DEFAULT_MOCK_SESSION}><Probe /></AuthProvider>))
    startThreadDelete(DEFAULT_MOCK_SESSION.userId, 'T1', 'Chips')
    await act(async () => auth!.signOut())
    t.mock.timers.tick(UNDO_DELETE_MS * 2)
    await act(async () => new Promise((resolve) => setImmediate(resolve)))
    assert.deepEqual(requests, [])

    startThreadDelete(DEFAULT_MOCK_SESSION.userId, 'T2', 'Rates')
    t.mock.timers.tick(UNDO_DELETE_MS)
    await act(async () => new Promise((resolve) => setImmediate(resolve)))
    assert.deepEqual(requests, ['DELETE /v1/chat/threads/T2'])
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
  }
})
