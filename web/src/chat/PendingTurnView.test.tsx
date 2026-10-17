import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { BlockRegistryProvider, createDefaultBlockRegistry } from '../blocks/index.ts'
import type { TurnIds } from './chatSession.ts'
import { PendingTurnView } from './PendingTurnView.tsx'
import type { StreamState } from './streamReducer.ts'

const TURN: TurnIds = { runId: 'run-1', messageId: 'u1', snapshotId: 'snap-1', text: 'Analyze NVDA' }
const noop = () => undefined
const handlers = { backgroundRun: false, onRetry: noop, onReload: noop, onAsk: () => true }

test('PendingTurnView renders the agent plan panel above streamed blocks', () => {
  const state: StreamState = {
    turn_status: 'started',
    blocks_by_id: new Map([
      [
        'b1',
        {
          block_id: 'b1',
          kind: 'rich_text',
          status: 'streaming',
          segments: [{ type: 'text', text: 'Partial answer.' }],
        },
      ],
    ]),
    block_order: ['b1'],
    plan_steps: [
      {
        step_id: 'planner',
        label: 'Planner',
        detail: 'Planning single subject analysis.',
        status: 'done',
      },
      {
        step_id: 'tool:fundamentals-1',
        label: 'Fundamentals',
        detail: 'Running compose analyst blocks.',
        status: 'running',
      },
      {
        step_id: 'composer',
        label: 'Composer',
        detail: 'Awaiting evidence.',
        status: 'waiting',
      },
    ],
    completed_message_id: null,
    error: null,
  }

  const html = renderToStaticMarkup(<PendingTurnView turn={{ phase: 'streaming', turn: TURN, stream: state }} {...handlers} />)

  assert.match(html, /data-testid="agent-plan-panel"/)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, /Agent plan/)
  assert.match(html, /Planner/)
  assert.match(html, /Fundamentals/)
  assert.match(html, /running/)
  assert.ok(html.indexOf('Agent plan') < html.indexOf('Partial answer.'))
})

test('PendingTurnView shows an unverified turn with a per-block label and collapsible reasons', () => {
  const block = {
    id: 'b-unverified',
    kind: 'rich_text',
    snapshot_id: '11111111-1111-4111-a111-111111111111',
    data_ref: { kind: 'chat_turn', id: 'turn-1' },
    source_refs: [],
    as_of: '2026-05-06T00:00:00.000Z',
    segments: [{ type: 'text', text: 'Revenue rose every quarter.' }],
  }
  const state: StreamState = {
    turn_status: 'unverified',
    blocks_by_id: new Map(),
    block_order: [],
    plan_steps: [],
    completed_message_id: null,
    error: null,
    unverified: {
      failures: [{ reason_code: 'missing_fact_ref', details: { fact_id: 'f-1' } }],
      blocks: [block],
    },
  }

  const html = renderToStaticMarkup(
    <BlockRegistryProvider registry={createDefaultBlockRegistry()}>
      <PendingTurnView turn={{ phase: 'unverified', turn: TURN, stream: state }} {...handlers} />
    </BlockRegistryProvider>,
  )

  assert.match(html, /data-turn-status="unverified"/)
  assert.match(html, /not saved/)
  assert.match(html, /data-verification="unverified"/)
  assert.match(html, /Revenue rose every quarter\./)
  assert.match(html, /<details[^>]*data-testid="unverified-reasons"/)
  assert.match(html, /Why unverified/)
  assert.match(html, /missing_fact_ref/)
})

const COMPLETED_STREAM: StreamState = {
  turn_status: 'completed',
  blocks_by_id: new Map([
    ['b1', { block_id: 'b1', kind: 'rich_text', status: 'completed', segments: [{ type: 'text', text: "NVIDIA's revenue rose" }] }],
  ]),
  block_order: ['b1'],
  plan_steps: [],
  completed_message_id: 'a1',
  error: null,
}

test('PendingTurnView keeps rendering the streamed blocks while the turn is sealing', () => {
  const html = renderToStaticMarkup(
    <PendingTurnView turn={{ phase: 'sealing', turn: TURN, stream: COMPLETED_STREAM, sealedId: 'a1' }} {...handlers} />,
  )
  assert.match(html, /data-turn-status="sealing"/)
  assert.match(html, /NVIDIA&#x27;s revenue rose/)
})

test('PendingTurnView offers Reload when the sealed copy could not be loaded', () => {
  const html = renderToStaticMarkup(
    <PendingTurnView
      turn={{ phase: 'kept', turn: TURN, stream: COMPLETED_STREAM, sealedId: 'a1', reason: 'history_failed' }}
      {...handlers}
    />,
  )
  assert.match(html, /NVIDIA&#x27;s revenue rose/)
  assert.match(html, /Couldn&#x27;t load the saved copy of this answer\./)
  assert.match(html, />Reload<\/button>/)
})

test('PendingTurnView shows the optimistic question while it is being saved', () => {
  const html = renderToStaticMarkup(<PendingTurnView turn={{ phase: 'persisting', turn: TURN }} {...handlers} />)
  assert.match(html, /Analyze NVDA/)
  assert.match(html, /Starting…/)
  assert.doesNotMatch(html, /data-testid="streaming-turn"/)
})
