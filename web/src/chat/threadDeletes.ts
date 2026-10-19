import { useSyncExternalStore } from 'react'

import { deleteThread } from './threadActions.ts'

// Long enough to reach Undo, short enough that the chat doesn't linger.
export const UNDO_DELETE_MS = 5000

type PendingDelete = {
  userId: string
  threadId: string
  name: string
  timer: ReturnType<typeof setTimeout>
}

export type ThreadDeletes = {
  pending: PendingDelete | null
  // Sent and not failed: the row stays hidden even when a list read races the DELETE.
  sent: ReadonlySet<string>
  error: string | null
  // Bumped when a DELETE settles, so a mounted list re-reads.
  settled: number
}

const INITIAL: ThreadDeletes = { pending: null, sent: new Set(), error: null, settled: 0 }

// Module scope so a pending delete outlives the sidebar that started it.
let state = INITIAL
let generation = 0
const listeners = new Set<() => void>()

function publish(next: ThreadDeletes): void {
  state = next
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getSnapshot = () => state

export function useThreadDeletes(): ThreadDeletes {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function startThreadDelete(userId: string, threadId: string, name: string): void {
  if (state.pending !== null) commit(state.pending)
  const timer = setTimeout(() => commit(pending), UNDO_DELETE_MS)
  const pending = { userId, threadId, name, timer }
  publish({ ...state, pending, error: null })
}

export function cancelThreadDelete(threadId: string): void {
  if (state.pending?.threadId !== threadId) return
  clearTimeout(state.pending.timer)
  publish({ ...state, pending: null })
}

// Called on identity change. A pending delete is dropped rather than sent: the
// session that could show its outcome is ending, and the chat stays deletable.
export function forgetThreadDeletes(): void {
  if (state.pending !== null) clearTimeout(state.pending.timer)
  generation += 1
  publish(INITIAL)
}

function commit(pending: PendingDelete): void {
  clearTimeout(pending.timer)
  const sentIn = generation
  publish({ ...state, pending: null, sent: new Set(state.sent).add(pending.threadId) })
  void deleteThread(pending.userId, pending.threadId).then(
    () => settle(sentIn, state.sent, null),
    (error: unknown) => {
      const sent = new Set(state.sent)
      sent.delete(pending.threadId)
      settle(sentIn, sent, error instanceof Error ? error.message : String(error))
    },
  )
}

function settle(sentIn: number, sent: ReadonlySet<string>, error: string | null): void {
  if (sentIn !== generation) return
  publish({ ...state, sent, error: error ?? state.error, settled: state.settled + 1 })
}
