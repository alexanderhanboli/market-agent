import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { FetchStateView } from './FetchStateView.tsx'

function render(refreshError: string | null): string {
  return renderToStaticMarkup(
    <FetchStateView
      state={{ status: 'ready', data: 'AAPL 196.58', refreshing: true, refreshError }}
      noun="quote"
      idleMessage="idle"
    >
      {(data) => <span>{data}</span>}
    </FetchStateView>,
  )
}

test('ready data renders unchanged while a refresh is in flight', () => {
  assert.equal(render(null), '<span>AAPL 196.58</span>')
})

test('a failed refresh keeps the earlier data and says it is stale', () => {
  assert.equal(
    render('HTTP 503'),
    '<span>AAPL 196.58</span><p class="text-xs text-faint">Showing earlier quote; refresh failed: HTTP 503</p>',
  )
})
