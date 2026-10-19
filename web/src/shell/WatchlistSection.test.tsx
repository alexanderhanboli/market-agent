import '../pages/installDomBeforeReact.ts'

import assert from 'node:assert/strict'
import test from 'node:test'

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { WatchlistProvider } from '../watchlists/WatchlistProvider.tsx'
import { AuthContext, DEFAULT_MOCK_SESSION } from './authTypes.ts'
import { WatchlistSection } from './WatchlistSection.tsx'

const MEMBERS_PATH = '/v1/watchlists/default/members'

test('a failed first watchlist load says so, keeps the reason in details, and Retry reloads it', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const originalFetch = globalThis.fetch
  const gets: string[] = []
  globalThis.fetch = async (input) => {
    const path = String(input)
    gets.push(path)
    if (path === MEMBERS_PATH && gets.length === 1) {
      return new Response(JSON.stringify({ error: 'bad gateway' }), { status: 502 })
    }
    return new Response(JSON.stringify({ members: [] }), { status: 200 })
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const section = () => container.querySelector('section[aria-label="Watchlist"]')!
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

  try {
    await act(async () => {
      root.render(
        <AuthContext.Provider value={{ session: DEFAULT_MOCK_SESSION, signIn: () => undefined, signOut: () => undefined }}>
          <MemoryRouter>
            <WatchlistProvider userId={DEFAULT_MOCK_SESSION.userId}>
              <WatchlistSection />
            </WatchlistProvider>
          </MemoryRouter>
        </AuthContext.Provider>,
      )
    })
    await settle()

    assert.equal(section().querySelector('p')?.textContent, "Couldn't load your watchlist.")
    assert.equal(section().querySelector('details')?.textContent, 'Detailslist watchlist members failed with HTTP 502')
    assert.equal(section().querySelector('details')?.open, false)

    const retry = [...section().querySelectorAll('button')].find((button) => button.textContent === 'Retry')!
    await act(async () => retry.click())
    await settle()

    assert.deepEqual(gets, [MEMBERS_PATH, MEMBERS_PATH])
    assert.equal(section().querySelector('details')?.textContent, undefined)
    assert.match(section().textContent ?? '', /No saved symbols yet\. Add one from the search above\.$/)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = originalFetch
  }
})
