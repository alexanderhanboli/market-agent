import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CHAT_ROLES, parseSealedMessage } from './messageTypes.ts'
import type { ChatSseEvent } from './sseEventTypes.ts'

const CHAT_DIR = dirname(fileURLToPath(import.meta.url))
const BACKEND_MESSAGES_PATH = join(CHAT_DIR, '../../../services/chat/src/messages.ts')
const GOLDEN_REPLAY_PATH = join(CHAT_DIR, '../../../services/app/fixtures/golden-conversation.replay.json')

test('CHAT_ROLES mirrors the backend ChatRole union exactly', () => {
  // Static text scan because node:test --experimental-strip-types cannot pull
  // the backend tsconfig into the web build.
  const source = readFileSync(BACKEND_MESSAGES_PATH, 'utf-8')
  const match = source.match(/export type ChatRole\s*=\s*([^;]+);/)
  assert.ok(match, 'could not locate `export type ChatRole = …;` in backend messages.ts')

  const backendRoles = Array.from(match[1].matchAll(/["']([a-zA-Z0-9._]+)["']/g))
    .map((m) => m[1])
    .sort()
  // Fail loud if the regex matches nothing — silent zero-match would still
  // pass deepEqual against an empty CHAT_ROLES, hiding both drifts.
  assert.ok(
    backendRoles.length > 0,
    'backend ChatRole regex matched zero roles — quote/syntax drift',
  )

  assert.deepEqual(
    [...CHAT_ROLES].sort(),
    backendRoles,
    'frontend CHAT_ROLES drifted from backend ChatRole union',
  )
})

function goldenCompletions(): ChatSseEvent[] {
  const replay = JSON.parse(readFileSync(GOLDEN_REPLAY_PATH, 'utf-8')) as { exchanges: Array<{ path: string; body: string }> }
  return replay.exchanges
    .filter((exchange) => exchange.path.endsWith('/stream'))
    .map((exchange) => {
      const frame = exchange.body.split('\n\n').find((chunk) => chunk.includes('event: turn.completed'))
      const data = frame?.split('\n').find((line) => line.startsWith('data: '))
      assert.ok(data, `no turn.completed in ${exchange.path}`)
      return JSON.parse(data.slice('data: '.length)) as ChatSseEvent
    })
}

test('every recorded golden completion carries a sealed message the client accepts', () => {
  const completions = goldenCompletions()
  assert.equal(completions.length, 3)
  assert.deepEqual(
    completions.map((event) => parseSealedMessage(event.message, { threadId: event.thread_id, messageId: event.message_id })?.message_id),
    completions.map((event) => event.message_id),
  )
})
