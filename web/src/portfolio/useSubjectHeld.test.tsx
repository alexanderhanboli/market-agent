import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import { JSDOM } from 'jsdom'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { resetResourcesForTests } from '../fetch/resource.ts'
import { AuthProvider } from '../shell/AuthContext.tsx'
import { useAuth } from '../shell/useAuth.ts'
import type { SubjectRef } from '../symbol/search.ts'
import type { OverlayContribution, SubjectOverlay } from './overlays.ts'
import { useSubjectHeld } from './useSubjectHeld.ts'

const LISTING: SubjectRef = { kind: 'listing', id: '11111111-1111-4111-a111-111111111111' }
const OTHER_LISTING: SubjectRef = { kind: 'listing', id: '44444444-4444-4444-a444-444444444444' }
const USER = { userId: '00000000-0000-4000-8000-000000000001', displayName: 'U1' }

const OPEN: OverlayContribution = {
  portfolio_id: 'p1',
  portfolio_name: 'Main',
  base_currency: 'USD',
  quantity: 10,
  cost_basis: 100,
  held_state: 'open',
  opened_at: '2026-01-02T00:00:00Z',
  closed_at: null,
}

let dom: JSDOM
let root: Root
let restore: () => void
let overlayRequests: string[]
let overlays: SubjectOverlay[]

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const globals = globalThis as unknown as {
    IS_REACT_ACT_ENVIRONMENT?: boolean
    document?: Document
    window?: Window
  }
  const previous = { ...globals }
  const originalFetch = globalThis.fetch
  globals.IS_REACT_ACT_ENVIRONMENT = true
  globals.document = dom.window.document
  globals.window = dom.window as unknown as Window
  overlayRequests = []
  overlays = []
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/v1/portfolios/overlays')
    overlayRequests.push(new Headers(init?.headers).get('x-user-id') ?? '<none>')
    return new Response(JSON.stringify({ overlays }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  restore = () => {
    globalThis.fetch = originalFetch
    globals.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT
    globals.document = previous.document
    globals.window = previous.window
  }
  root = createRoot(dom.window.document.getElementById('root')!)
})

afterEach(async () => {
  await act(async () => root.unmount())
  resetResourcesForTests()
  dom.window.close()
  restore()
})

function HeldProbe({ subjectRef }: { subjectRef: SubjectRef }): ReactElement {
  const { session, signIn, signOut } = useAuth()
  const held = useSubjectHeld(subjectRef, session?.userId ?? null)
  return (
    <>
      <button data-testid="sign-in" onClick={() => signIn(USER)} />
      <button data-testid="sign-out" onClick={() => signOut()} />
      <span>
        {held.status === 'ready'
          ? `ready:${String(held.data)}`
          : held.status === 'unavailable'
            ? `unavailable:${held.reason}`
            : held.status}
      </span>
    </>
  )
}

async function click(testId: 'sign-in' | 'sign-out'): Promise<void> {
  const button = dom.window.document.querySelector(`[data-testid="${testId}"]`)
  assert.ok(button, `expected the ${testId} button`)
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function text(): string {
  return dom.window.document.getElementById('root')?.textContent ?? ''
}

test('held state reads the overlay for the requested subject, not the first one returned', async () => {
  overlays = [
    { subject_ref: { kind: 'listing', id: OTHER_LISTING.id }, contributions: [OPEN] },
    { subject_ref: { kind: 'listing', id: LISTING.id }, contributions: [] },
  ]
  await act(async () => root.render(<AuthProvider initialSession={USER}><HeldProbe subjectRef={LISTING} /></AuthProvider>))
  await flush()

  assert.equal(text(), 'ready:false')
})

test('held state is unavailable when the response omits the requested subject', async () => {
  overlays = [{ subject_ref: { kind: 'listing', id: OTHER_LISTING.id }, contributions: [OPEN] }]
  await act(async () => root.render(<AuthProvider initialSession={USER}><HeldProbe subjectRef={LISTING} /></AuthProvider>))
  await flush()

  assert.equal(text(), 'unavailable:overlays response did not include this subject')
})

test('signing out and back in reloads held state instead of reusing the cached answer', async () => {
  overlays = [{ subject_ref: { kind: 'listing', id: LISTING.id }, contributions: [OPEN] }]
  await act(async () => root.render(<AuthProvider><HeldProbe subjectRef={LISTING} /></AuthProvider>))
  assert.equal(text(), 'idle')

  await click('sign-in')
  await flush()
  assert.equal(text(), 'ready:true')

  await click('sign-out')
  assert.equal(text(), 'idle')

  await click('sign-in')
  await flush()
  assert.equal(text(), 'ready:true')
  assert.deepEqual(overlayRequests, [USER.userId, USER.userId])
})
