import './installDomBeforeReact.ts'

import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { resetResourcesForTests } from '../fetch/resource.ts'
import { AuthContext } from '../shell/authTypes.ts'
import { AnalyzePage } from './AnalyzePage.tsx'

afterEach(resetResourcesForTests)

const ISSUER_ID = '11111111-1111-4111-a111-111111111111'
const ISSUER_REF = { kind: 'issuer', id: ISSUER_ID }
const DEEP_LINK = `/analyze?subject=issuer:${ISSUER_ID}`

type Reply = { status: number; body: unknown }

async function renderAnalyze(entry: string | { pathname: string; search: string; state: unknown }, hydrate: () => Promise<Reply>) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const originalFetch = globalThis.fetch
  const requests: unknown[] = []
  globalThis.fetch = async (input, init) => {
    requests.push([init?.method, String(input), JSON.parse(String(init?.body))])
    const reply = await hydrate()
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(
    <AuthContext.Provider value={{ session: null, signIn: () => undefined, signOut: () => undefined }}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/analyze" element={<AnalyzePage />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  ))
  const carried = () => container.querySelector('[data-testid="analyze-carried-subject"]')!
  return {
    requests,
    heading: () => carried().querySelector('h2')!,
    back: () => carried().querySelector('[data-testid="analyze-back-to-symbol"]')!.textContent,
    text: () => container.textContent ?? '',
    settle: () => act(async () => new Promise((resolve) => setTimeout(resolve, 0))),
    cleanup: async () => {
      await act(async () => root.unmount())
      container.remove()
      globalThis.fetch = originalFetch
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('a deep-linked subject shows a skeleton name while it hydrates, then the hydrated name', async () => {
  const reply = deferred<Reply>()
  const page = await renderAnalyze(DEEP_LINK, () => reply.promise)
  try {
    assert.deepEqual(page.requests, [['POST', '/v1/subjects/hydrate', { subject_ref: ISSUER_REF }]])
    assert.equal(page.heading().querySelector('[role="status"]')?.textContent, 'Loading subject name')
    assert.doesNotMatch(page.text(), /Unknown symbol/)

    await act(async () => reply.resolve({
      status: 200,
      body: { subject: { subject_ref: ISSUER_REF, display_name: 'Apple Inc.', confidence: 1 } },
    }))
    await page.settle()
    assert.equal(page.heading().textContent, 'Apple Inc.')
    assert.equal(page.back(), 'Back to Apple Inc.')
    assert.match(page.text(), /Memo canvasApple Inc\. · /)
  } finally {
    await page.cleanup()
  }
})

test('a deep-linked subject reads "Unknown symbol" only once hydration fails', async () => {
  const page = await renderAnalyze(DEEP_LINK, async () => ({ status: 503, body: {} }))
  try {
    await page.settle()
    assert.equal(page.heading().textContent, 'Unknown symbol')
    assert.match(page.text(), /Memo canvasUnknown symbol · /)
  } finally {
    await page.cleanup()
  }
})

test('a carried subject without display_name keeps its label and needs no hydration', async () => {
  const subject = { subject_ref: ISSUER_REF, confidence: 1, display_labels: { primary: 'Apple' } }
  const page = await renderAnalyze(
    { pathname: '/analyze', search: `?subject=issuer:${ISSUER_ID}`, state: { subject } },
    async () => ({ status: 503, body: {} }),
  )
  try {
    await page.settle()
    assert.equal(page.heading().textContent, 'Apple')
    assert.deepEqual(page.requests, [])
  } finally {
    await page.cleanup()
  }
})
