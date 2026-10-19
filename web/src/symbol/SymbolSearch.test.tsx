import '../pages/installDomBeforeReact.ts'

import assert from 'node:assert/strict'
import test from 'node:test'

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import { SymbolSearch } from './SymbolSearch.tsx'

test('a search with no match says No match for the query, while typing and on submit', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ subjects: [], unresolved: ['ZZZZ'] }), { status: 200 })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 200)))
  try {
    await act(async () => root.render(<MemoryRouter><SymbolSearch /></MemoryRouter>))
    const input = container.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'ZZZZ')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await settle()
    assert.equal(container.querySelector('form')?.lastElementChild?.textContent, 'No match for "ZZZZ".')

    await act(async () => container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
    await settle()
    assert.equal(container.querySelector('form')?.lastElementChild?.textContent, 'No match for "ZZZZ".')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = originalFetch
  }
})
