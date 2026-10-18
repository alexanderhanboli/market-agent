import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'
import { act, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'

import { installDomGlobals } from '../analyst-grids/testDom.ts'
import { EvidenceInspectorContext, type EvidenceInspectorContextValue } from '../evidence/evidenceInspectorContext.ts'
import { MetricRow } from './MetricRow.tsx'
import { RevenueBars } from './RevenueBars.tsx'
import { metricRowFixture, revenueBarsFixture } from './fixtures.ts'

async function shownAsOfFirstFact(view: ReactElement): Promise<unknown> {
  const opened: Array<Parameters<EvidenceInspectorContextValue['openInspection']>[0]> = []
  const inspector: EvidenceInspectorContextValue = {
    openInspection(input) { opened.push(input) },
    openBlockInspection() {},
    closeInspection() {},
  }
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const restoreGlobals = installDomGlobals(dom.window as unknown as Window)
  try {
    const root = createRoot(dom.window.document.getElementById('root')!)
    await act(async () => {
      root.render(<EvidenceInspectorContext.Provider value={inspector}>{view}</EvidenceInspectorContext.Provider>)
    })
    await act(async () => dom.window.document.querySelector<HTMLElement>('button[data-inspection-kind="fact"]')!.click())
    await act(async () => root.unmount())
    return opened.map((input) => input.shownAs)
  } finally {
    restoreGlobals()
  }
}

test('a metric row chip opens the inspector with the text it shows', async () => {
  assert.deepEqual(await shownAsOfFirstFact(<MetricRow block={metricRowFixture} />), ['$85.8B'])
})

test('a revenue bar opens the inspector with the text it shows', async () => {
  assert.deepEqual(await shownAsOfFirstFact(<RevenueBars block={revenueBarsFixture} />), ['$3.0B'])
})
