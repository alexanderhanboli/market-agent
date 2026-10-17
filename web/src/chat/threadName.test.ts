import assert from 'node:assert/strict'
import test from 'node:test'

import { threadDisplayName } from './threadName.ts'

const thread = (title: string | null) => ({ thread_id: 'T1', title, updated_at: '2026-01-01T00:00:00Z' })

test('threadDisplayName prefers the trimmed server title', () => {
  assert.equal(threadDisplayName(thread('  NVIDIA Analysis '), 'Analyze NVDA'), 'NVIDIA Analysis')
})

test('threadDisplayName falls back to the first question with whitespace collapsed', () => {
  assert.equal(threadDisplayName(thread('   '), '  Analyze\n  NVDA  '), 'Analyze NVDA')
  assert.equal(threadDisplayName(undefined, 'Analyze NVDA'), 'Analyze NVDA')
})

test('threadDisplayName truncates a long question to 60 characters plus an ellipsis', () => {
  const question = 'Compare NVIDIA, AMD and Intel revenue growth, margins and valuation over five years'
  assert.equal(threadDisplayName(thread(null), question), 'Compare NVIDIA, AMD and Intel revenue growth, margins and va…')
  assert.equal(threadDisplayName(thread(null), 'x'.repeat(60)), 'x'.repeat(60))
})

test('threadDisplayName is "New chat" with neither a title nor a question', () => {
  assert.equal(threadDisplayName(thread(null), null), 'New chat')
  assert.equal(threadDisplayName(undefined, '  '), 'New chat')
})
