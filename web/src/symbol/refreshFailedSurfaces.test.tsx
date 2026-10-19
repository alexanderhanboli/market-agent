import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import { JSDOM } from 'jsdom'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'

import { PerfComparison } from '../blocks/PerfComparison.tsx'
import type { PerfComparisonBlock } from '../blocks/types.ts'
import { resetResourcesForTests } from '../fetch/resource.ts'
import { OverviewSection } from '../pages/symbol/OverviewSection.tsx'
import { SubjectNewsRail } from '../shell/SubjectNewsRail.tsx'
import type { SubjectDetailOutletContext } from '../shell/subjectDetailOutletContext.ts'
import type { QuoteSnapshot as QuoteSnapshotData } from './quote.ts'
import { QuoteSnapshot } from './QuoteSnapshot.tsx'
import type { ResolvedSubject } from './search.ts'
import type { NormalizedSeriesQuery } from './series.ts'

const ISSUER_ID = '22222222-2222-4222-a222-222222222222'
const PAST_INTRADAY_MS = 5 * 60_000 + 1

let dom: JSDOM
let root: Root
let restoreGlobals: () => void
let failing: boolean
let originalFetch: typeof fetch

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const globals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean; document?: Document; window?: Window }
  const previous = { ...globals }
  globals.IS_REACT_ACT_ENVIRONMENT = true
  globals.document = dom.window.document
  globals.window = dom.window as unknown as Window
  restoreGlobals = () => {
    globals.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT
    globals.document = previous.document
    globals.window = previous.window
  }
  failing = false
  originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = input.toString()
    if (failing) return new Response('{}', { status: 503 })
    if (url.startsWith('/v1/evidence/issuer-news')) {
      return json({
        items: [
          { document_id: 'd1', kind: 'article', title: 'Apple ships', published_at: null, provider: 'wire', provider_doc_id: null },
        ],
      })
    }
    if (url.startsWith('/v1/fundamentals/stats')) {
      return json({ stats: { subject: { kind: 'issuer', id: ISSUER_ID }, stats: [] } })
    }
    if (url === '/v1/market/series') {
      const query = JSON.parse(String(init?.body)) as NormalizedSeriesQuery
      const results = query.subject_refs.map((listing, i) =>
        i === 0
          ? {
              listing,
              outcome: {
                outcome: 'available',
                data: { listing, bars: [{ ts: '2026-08-02T00:00:00Z', close: 0 }, { ts: '2026-08-03T00:00:00Z', close: 3 }] },
              },
            }
          : { listing, outcome: { outcome: 'unavailable', reason: 'missing_coverage' } },
      )
      return json({ query, results })
    }
    return new Response('{}', { status: 404 })
  }
  root = createRoot(dom.window.document.getElementById('root')!)
})

afterEach(async () => {
  await act(async () => root.unmount())
  resetResourcesForTests()
  globalThis.fetch = originalFetch
  dom.window.close()
  restoreGlobals()
})

async function mount(element: ReactElement): Promise<void> {
  await act(async () => root.render(element))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function notes(): Array<[string, string | null]> {
  return [...dom.window.document.querySelectorAll('p')]
    .filter((p) => (p.textContent ?? '').startsWith('Showing earlier'))
    .map((p) => [p.textContent ?? '', p.getAttribute('title')])
}

test('the news rail says when its latest documents failed to refresh', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  await mount(<SubjectNewsRail issuerId={ISSUER_ID} />)
  assert.deepEqual(notes(), [])

  await mount(<></>)
  t.mock.timers.tick(PAST_INTRADAY_MS)
  failing = true
  await mount(<SubjectNewsRail issuerId={ISSUER_ID} />)

  assert.match(dom.window.document.body.textContent ?? '', /Apple ships/)
  assert.deepEqual(notes(), [["Showing earlier news. Couldn't refresh.", 'issuer news fetch failed: HTTP 503']])
})

test('the overview key-stats grid says when its stats failed to refresh', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const subject: ResolvedSubject = {
    subject_ref: { kind: 'issuer', id: ISSUER_ID },
    display_name: 'Apple Inc.',
    confidence: 1,
  }
  function SubjectOutlet(): ReactElement {
    return <Outlet context={{ subject, quote: null } satisfies SubjectDetailOutletContext} />
  }
  const page = (
    <MemoryRouter initialEntries={['/overview']}>
      <Routes>
        <Route element={<SubjectOutlet />}>
          <Route path="/overview" element={<OverviewSection />} />
        </Route>
      </Routes>
    </MemoryRouter>
  )

  await mount(page)
  assert.deepEqual(notes(), [])

  await mount(<></>)
  t.mock.timers.tick(PAST_INTRADAY_MS)
  failing = true
  await mount(page)

  assert.deepEqual(notes(), [["Showing earlier key stats. Couldn't refresh.", 'fundamentals stats fetch failed: HTTP 503']])
})

test('a live perf comparison says when its retry failed and keeps the chart', async () => {
  const block: PerfComparisonBlock = {
    id: 'perf-1',
    kind: 'perf_comparison',
    snapshot_id: '11111111-1111-4111-9111-111111111111',
    data_ref: { kind: 'perf_comparison', id: 'perf-1' },
    source_refs: [],
    as_of: '2026-09-01T00:00:00.000Z',
    subject_refs: [
      { kind: 'listing', id: '62000000-0000-4000-8000-000000000001' },
      { kind: 'listing', id: '62000000-0000-4000-8000-000000000002' },
    ],
    default_range: '1M',
    basis: 'split_and_div_adjusted',
    normalization: 'pct_return',
  }
  await mount(<PerfComparison block={block} />)
  assert.deepEqual(notes(), [])

  await mount(<></>)
  failing = true
  await mount(<PerfComparison block={block} />)

  assert.notEqual(dom.window.document.querySelector('[data-testid="block-perf-comparison-perf-1-chart"]'), null)
  assert.deepEqual(notes(), [["Showing earlier series. Couldn't refresh.", 'market series fetch failed: HTTP 503']])
})

test('the header quote says when its price failed to refresh', () => {
  const quote = {
    listing: { kind: 'listing', id: '11111111-1111-4111-a111-111111111111', ticker: 'AAPL', mic: 'XNAS', timezone: 'America/New_York' },
    latest_price: 196.58,
    prev_close: 195,
    absolute_move: 1.58,
    percent_move: 0.0081,
    currency: 'USD',
    as_of: '2026-04-26T15:30:00.000Z',
    delay_class: 'delayed_15m',
    session_state: 'regular',
    provider: 'polygon',
    source_id: '00000000-0000-4000-a000-000000000001',
  } as unknown as QuoteSnapshotData
  const subject: ResolvedSubject = {
    subject_ref: { kind: 'listing', id: '11111111-1111-4111-a111-111111111111' },
    display_name: 'Apple Inc.',
    confidence: 1,
  }
  const html = renderToStaticMarkup(
    <QuoteSnapshot
      subject={subject}
      title="Apple Inc."
      quoteState={{ status: 'ready', data: quote, refreshing: false, refreshError: 'HTTP 503' }}
    />,
  )

  assert.match(html, /<p class="text-xs text-faint" title="HTTP 503">Showing earlier quote\. Couldn&#x27;t refresh\.<\/p>/)
})
