import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JSDOM } from 'jsdom'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { FailureNotice } from './FailureNotice.tsx'

function render(element: ReactElement): Document {
  return new JSDOM(`<body>${renderToStaticMarkup(element)}</body>`).window.document
}

test('each Retry is described by the sentence it retries', () => {
  const doc = render(
    <>
      <FailureNotice message="Couldn't load the quote." detail="HTTP 503" onRetry={() => {}} />
      <FailureNotice message="Couldn't load the profile." detail="HTTP 502" onRetry={() => {}} />
    </>,
  )
  const described = [...doc.querySelectorAll('button')].map((button) => [
    button.textContent,
    doc.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
  ])
  assert.deepEqual(described, [
    ['Retry', "Couldn't load the quote."],
    ['Retry', "Couldn't load the profile."],
  ])
})

test('the reason sits behind Details only when there is one', () => {
  assert.equal(render(<FailureNotice message="Couldn't load the quote." detail="HTTP 503" />).querySelector('details')?.textContent, 'DetailsHTTP 503')
  assert.equal(render(<FailureNotice message="Couldn't load the quote." detail="" />).body.textContent, "Couldn't load the quote.")
})
