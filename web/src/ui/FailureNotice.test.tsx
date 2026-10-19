import '../pages/installDomBeforeReact.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JSDOM } from 'jsdom'
import { act, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'

import { defineResource, resetResourcesForTests, useResource } from '../fetch/resource.ts'
import { Announcer } from './Announcer.tsx'
import { ANNOUNCE_DELAY_MS, resetAnnouncerForTests } from './announcer.ts'
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

// Mounts next to the app announcer and records every non-empty text its status region takes.
async function mountWithAnnouncer(t: test.TestContext) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const heard: string[] = []
  const mount = (element: ReactElement | null) => act(async () => root.render(<>{element}<Announcer /></>))
  await mount(null)
  const region = container.querySelector('[role="status"]')!
  new window.MutationObserver(() => {
    if (region.textContent) heard.push(region.textContent)
  }).observe(region, { childList: true, characterData: true, subtree: true })
  t.after(async () => {
    await act(async () => root.unmount())
    container.remove()
    resetAnnouncerForTests()
    resetResourcesForTests()
  })
  return { heard, mount, wait: (ms = ANNOUNCE_DELAY_MS) => act(async () => t.mock.timers.tick(ms)) }
}

test('a FailureNotice announces on mount and when its message changes, not on a plain re-render', async (t) => {
  const { heard, mount, wait } = await mountWithAnnouncer(t)
  await mount(<FailureNotice message="Couldn't load the quote." detail="HTTP 503" />)
  await wait()
  assert.deepEqual(heard, ["Couldn't load the quote."])

  await mount(<FailureNotice message="Couldn't load the quote." detail="HTTP 502" />)
  await wait()
  assert.deepEqual(heard, ["Couldn't load the quote."])

  await mount(<FailureNotice message="Couldn't load the profile." detail="HTTP 502" />)
  await wait()
  assert.deepEqual(heard, ["Couldn't load the quote.", "Couldn't load the profile."])
})

test('a FailureNotice with announce={false} stays silent', async (t) => {
  const { heard, mount, wait } = await mountWithAnnouncer(t)
  await mount(<FailureNotice message="Couldn't delete the chat." detail="" announce={false} />)
  await wait()
  assert.deepEqual(heard, [])
  assert.equal(document.body.textContent?.includes("Couldn't delete the chat."), true)
})

test('a cached failure that remounts into its automatic retry is not announced', async (t) => {
  const { heard, mount, wait } = await mountWithAnnouncer(t)
  let release: (ticker: string) => void = () => {}
  let calls = 0
  const quote = defineResource<string, string>({
    freshness: 'live',
    load: async () => {
      calls += 1
      if (calls === 1) return { kind: 'unavailable', reason: 'HTTP 503' }
      return { kind: 'ready', data: await new Promise<string>((resolve) => (release = resolve)) }
    },
  })
  function Quote() {
    const state = useResource(quote, 'AAPL')
    if (state.status === 'unavailable') return <FailureNotice message="Couldn't load the quote." detail={state.reason} />
    return <p>{state.status === 'ready' ? state.data : 'Loading'}</p>
  }

  await mount(<Quote />)
  await wait()
  assert.deepEqual(heard, ["Couldn't load the quote."])

  await mount(null)
  await mount(<Quote />)
  await wait(ANNOUNCE_DELAY_MS + 50)
  await act(async () => release('AAPL 184.32'))
  await wait()
  assert.equal(calls, 2)
  assert.equal(document.body.textContent?.includes('AAPL 184.32'), true)
  assert.deepEqual(heard, ["Couldn't load the quote."])
})
