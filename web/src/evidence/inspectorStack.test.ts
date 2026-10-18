import assert from 'node:assert/strict'
import test from 'node:test'

import { inspectorStackReducer, type InspectorPage, type InspectorStack } from './inspectorStack.ts'
import type { EvidenceBlockInspection, EvidenceInspection } from './inspectionTypes.ts'

const SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111'
const FACT_ID = '22222222-2222-4222-8222-222222222222'
const SOURCE_ID = '33333333-3333-4333-8333-333333333333'

function loadingFact(request: number): InspectorPage {
  return { kind: 'evidence', request, snapshotId: SNAPSHOT_ID, ref: { kind: 'fact', id: FACT_ID }, load: { kind: 'loading' } }
}

function loadingSource(request: number): InspectorPage {
  return { kind: 'evidence', request, snapshotId: SNAPSHOT_ID, ref: { kind: 'source', id: SOURCE_ID }, load: { kind: 'loading' } }
}

const SOURCE_INSPECTION: EvidenceInspection = {
  snapshot_id: SNAPSHOT_ID,
  ref: { kind: 'source', id: SOURCE_ID },
  kind: 'source',
  title: 'sec filing',
  subtitle: null,
  badges: [],
  rows: [],
  links: [],
  related_refs: [],
}

const BLOCK: EvidenceBlockInspection = {
  snapshot_id: SNAPSHOT_ID,
  block_id: 'rich-text-1',
  block_kind: 'rich_text',
  title: 'Summary',
  subtitle: null,
  badges: [],
  rows: [],
  related_refs: [],
}

test('open replaces whatever stack was showing with the one page', () => {
  const stack: InspectorStack = [loadingFact(1), loadingSource(2)]

  assert.deepEqual(inspectorStackReducer(stack, { type: 'open', page: { kind: 'block', inspection: BLOCK } }), [
    { kind: 'block', inspection: BLOCK },
  ])
})

test('push keeps earlier pages beneath the new one', () => {
  assert.deepEqual(inspectorStackReducer([loadingFact(1)], { type: 'push', page: loadingSource(2) }), [
    loadingFact(1),
    loadingSource(2),
  ])
})

test('back pops one page, or returns to a breadcrumb index, and never pops the first page', () => {
  const stack: InspectorStack = [loadingFact(1), loadingSource(2), loadingFact(3)]

  assert.deepEqual(inspectorStackReducer(stack, { type: 'back' }), [loadingFact(1), loadingSource(2)])
  assert.deepEqual(inspectorStackReducer(stack, { type: 'back', to: 0 }), [loadingFact(1)])
  assert.deepEqual(inspectorStackReducer([loadingFact(1)], { type: 'back' }), [loadingFact(1)])
})

test('close empties the stack', () => {
  assert.deepEqual(inspectorStackReducer([loadingFact(1), loadingSource(2)], { type: 'close' }), [])
})

test('settled fills the page that made the request even when it is no longer on top', () => {
  const stack: InspectorStack = [loadingSource(1), loadingFact(2)]

  const next = inspectorStackReducer(stack, {
    type: 'settled',
    request: 1,
    settlement: { kind: 'evidence', load: { kind: 'ready', inspection: SOURCE_INSPECTION } },
  })

  assert.deepEqual(next, [
    { ...loadingSource(1), load: { kind: 'ready', inspection: SOURCE_INSPECTION } },
    loadingFact(2),
  ])
})

test('settled for a page that was popped or replaced leaves the stack as it is', () => {
  const stack: InspectorStack = [loadingFact(1)]

  const next = inspectorStackReducer(stack, {
    type: 'settled',
    request: 2,
    settlement: { kind: 'evidence', load: { kind: 'error', message: 'gone' } },
  })

  assert.equal(next, stack)
})

test('settled updates a financial page with its calculation load', () => {
  const stack: InspectorStack = [{ kind: 'financial', request: 4, load: { kind: 'loading', resultId: 'result-1' } }]

  const next = inspectorStackReducer(stack, {
    type: 'settled',
    request: 4,
    settlement: { kind: 'financial', load: { kind: 'error', resultId: 'result-1', message: 'This calculation is not available to inspect.' } },
  })

  assert.deepEqual(next, [
    { kind: 'financial', request: 4, load: { kind: 'error', resultId: 'result-1', message: 'This calculation is not available to inspect.' } },
  ])
})
