import '../pages/installDomBeforeReact.ts'

import assert from 'node:assert/strict'
import test from 'node:test'

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { useWatchlist } from '../watchlists/watchlistContext.ts'
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

const ISSUER_REF = { kind: 'issuer', id: '11111111-1111-4111-a111-111111111111' } as const

async function renderRail(reply: (method: string, path: string) => Response) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => reply(init?.method ?? 'GET', String(input))
  let watchlist: ReturnType<typeof useWatchlist> | null = null
  function Probe() {
    watchlist = useWatchlist()
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  await act(async () => {
    root.render(
      <AuthContext.Provider value={{ session: DEFAULT_MOCK_SESSION, signIn: () => undefined, signOut: () => undefined }}>
        <MemoryRouter>
          <WatchlistProvider userId={DEFAULT_MOCK_SESSION.userId}>
            <WatchlistSection />
            <Probe />
          </WatchlistProvider>
        </MemoryRouter>
      </AuthContext.Provider>,
    )
  })
  await settle()
  const section = () => container.querySelector('section[aria-label="Watchlist"]')!
  return {
    section,
    add: async () => {
      await act(async () => watchlist!.addSubject(ISSUER_REF))
      await settle()
    },
    cleanup: async () => {
      await act(async () => root.unmount())
      container.remove()
      globalThis.fetch = originalFetch
    },
  }
}

test('a failed add on an empty watchlist keeps the empty state and says the update failed', async () => {
  const rail = await renderRail((method) => method === 'GET'
    ? new Response(JSON.stringify({ members: [] }), { status: 200 })
    : new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
  try {
    await rail.add()
    assert.match(
      rail.section().textContent ?? '',
      /No saved symbols yet\. Add one from the search above\.Couldn't update your watchlist\.Detailsadd watchlist member failed with HTTP 500$/,
    )
  } finally {
    await rail.cleanup()
  }
})

test('a failed watchlist load keeps its notice and Retry after a symbol is added', async () => {
  const rail = await renderRail((method) => method === 'GET'
    ? new Response(JSON.stringify({ error: 'bad gateway' }), { status: 502 })
    : new Response(JSON.stringify({ status: 'created', member: { subject_ref: ISSUER_REF, created_at: '2026-10-19T00:00:00.000Z' } }), { status: 201 }))
  try {
    await rail.add()
    assert.equal(rail.section().querySelectorAll('ul[aria-label="Watchlist members"] > li').length, 1)
    assert.match(rail.section().textContent ?? '', /Couldn't load your watchlist\.RetryDetailslist watchlist members failed with HTTP 502/)
    const row = rail.section().querySelector('ul[aria-label="Watchlist members"] > li')!
    assert.equal(row.textContent, 'Unknown symbolQuote unavailable—×')
    assert.equal(row.querySelector('button')?.getAttribute('aria-label'), 'Remove from watchlist')
  } finally {
    await rail.cleanup()
  }
})
