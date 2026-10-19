import '../pages/installDomBeforeReact.ts'

import assert from 'node:assert/strict'
import test from 'node:test'

import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { Announcer } from './Announcer.tsx'
import { ANNOUNCE_CLEAR_MS, ANNOUNCE_DELAY_MS, announce, resetAnnouncerForTests } from './announcer.ts'

async function mountAnnouncer(t: test.TestContext) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<Announcer />))
  t.after(async () => {
    await act(async () => root.unmount())
    container.remove()
    resetAnnouncerForTests()
  })
  return {
    status: () => container.querySelector('[role="status"]')?.textContent,
    alert: () => container.querySelector('[role="alert"]')?.textContent,
    say: (text: string, politeness?: 'polite' | 'assertive') => {
      let withdraw = () => {}
      act(() => {
        withdraw = announce(text, politeness)
      })
      return () => act(() => withdraw())
    },
    tick: (ms: number) => act(() => t.mock.timers.tick(ms)),
  }
}

test('messages announced within one delay are spoken together, each once', async (t) => {
  const regions = await mountAnnouncer(t)
  regions.say("Couldn't load the quote.")
  regions.say("Couldn't load the profile.")
  regions.say("Couldn't load the quote.")
  regions.tick(ANNOUNCE_DELAY_MS - 1)
  assert.equal(regions.status(), '')
  regions.tick(1)
  assert.equal(regions.status(), "Couldn't load the quote. Couldn't load the profile.")
})

test('a repeat clears the region first, so the same text is heard again', async (t) => {
  const regions = await mountAnnouncer(t)
  regions.say('Chat deleted.')
  regions.tick(ANNOUNCE_DELAY_MS)
  assert.equal(regions.status(), 'Chat deleted.')

  regions.say('Chat deleted.')
  assert.equal(regions.status(), '')
  regions.tick(ANNOUNCE_DELAY_MS)
  assert.equal(regions.status(), 'Chat deleted.')
})

test('polite and assertive regions are filled and cleared independently', async (t) => {
  const regions = await mountAnnouncer(t)
  regions.say('Chat deleted.')
  regions.say("Couldn't delete the chat.", 'assertive')
  regions.tick(ANNOUNCE_DELAY_MS)
  assert.deepEqual([regions.status(), regions.alert()], ['Chat deleted.', "Couldn't delete the chat."])

  regions.say("Couldn't delete the chat.", 'assertive')
  regions.tick(ANNOUNCE_DELAY_MS)
  assert.deepEqual([regions.status(), regions.alert()], ['Chat deleted.', "Couldn't delete the chat."])
})

test('an assertive message does not postpone a polite one already waiting', async (t) => {
  const regions = await mountAnnouncer(t)
  regions.say('Chat deleted.')
  regions.tick(ANNOUNCE_DELAY_MS - 10)
  regions.say("Couldn't delete the chat.", 'assertive')
  regions.tick(10)
  assert.deepEqual([regions.status(), regions.alert()], ['Chat deleted.', "Couldn't delete the chat."])
})

test('a withdrawn message is not spoken, and the same text announced elsewhere still is', async (t) => {
  const regions = await mountAnnouncer(t)
  const withdrawQuote = regions.say("Couldn't load the quote.")
  regions.say("Couldn't load the profile.")
  withdrawQuote()
  regions.tick(ANNOUNCE_DELAY_MS)
  assert.equal(regions.status(), "Couldn't load the profile.")

  const withdrawFirst = regions.say("Couldn't load the news.")
  regions.say("Couldn't load the news.")
  withdrawFirst()
  regions.tick(ANNOUNCE_DELAY_MS)
  assert.equal(regions.status(), "Couldn't load the news.")
})

test('withdrawing after the message was spoken changes nothing', async (t) => {
  const regions = await mountAnnouncer(t)
  const withdraw = regions.say('Chat deleted.')
  regions.tick(ANNOUNCE_DELAY_MS)
  withdraw()
  regions.say("Couldn't load the quote.")
  regions.tick(ANNOUNCE_DELAY_MS)
  assert.equal(regions.status(), "Couldn't load the quote.")
})

test('each region empties once it has been idle, so browse mode finds no stale message', async (t) => {
  const regions = await mountAnnouncer(t)
  regions.say('Chat deleted.')
  regions.tick(ANNOUNCE_DELAY_MS)
  regions.tick(ANNOUNCE_CLEAR_MS / 2)
  regions.say("Couldn't delete the chat.", 'assertive')
  regions.tick(ANNOUNCE_DELAY_MS)
  regions.tick(ANNOUNCE_CLEAR_MS / 2 - ANNOUNCE_DELAY_MS - 1)
  assert.deepEqual([regions.status(), regions.alert()], ['Chat deleted.', "Couldn't delete the chat."])

  regions.tick(1)
  assert.deepEqual([regions.status(), regions.alert()], ['', "Couldn't delete the chat."])
  regions.tick(ANNOUNCE_CLEAR_MS)
  assert.deepEqual([regions.status(), regions.alert()], ['', ''])
})

test('a message spoken just before the region would clear stays its full time', async (t) => {
  const regions = await mountAnnouncer(t)
  regions.say("Couldn't load the quote.")
  regions.tick(ANNOUNCE_DELAY_MS)
  regions.tick(ANNOUNCE_CLEAR_MS - 200)
  regions.say("Couldn't load the profile.")
  regions.tick(ANNOUNCE_DELAY_MS)
  regions.tick(200)
  assert.equal(regions.status(), "Couldn't load the profile.")

  regions.tick(ANNOUNCE_CLEAR_MS - 200 - 1)
  assert.equal(regions.status(), "Couldn't load the profile.")
  regions.tick(1)
  assert.equal(regions.status(), '')
})
