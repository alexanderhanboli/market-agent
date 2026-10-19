import { useSyncExternalStore } from 'react'

import { announce } from '../ui/announcer.ts'
import { authenticatedFetch } from '../http/authFetch.ts'
import { deleteThread, type ChatThread } from './threadActions.ts'

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
  // An object, so two failures with the same message stay distinct.
  error: { message: string } | null
  // Bumped when a DELETE succeeds, so a mounted list re-reads.
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
  // A reload inside the window keeps the chat: the timer dies with the page.
  const timer = setTimeout(() => commit(pending), UNDO_DELETE_MS)
  const pending = { userId, threadId, name, timer }
  publish({ ...state, pending, error: null })
  announce('Chat deleted.')
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

// A delete error stays until a list read started after it succeeds.
export function beginThreadListRead(): () => void {
  const error = state.error
  return () => {
    if (error !== null && state.error === error) publish({ ...state, error: null })
  }
}

function commit(pending: PendingDelete): void {
  clearTimeout(pending.timer)
  const sentIn = generation
  publish({ ...state, pending: null, sent: new Set(state.sent).add(pending.threadId) })
  const settle = () => {
    if (sentIn === generation) publish({ ...state, settled: state.settled + 1 })
  }
  void deleteThread(pending.userId, pending.threadId).then(settle, async (error: unknown) => {
    if (sentIn !== generation) return
    // A DELETE that timed out may still have gone through, so the list decides.
    // An unreadable list proves nothing, so the delete counts as failed.
    const listed = await threadIsListed(pending).catch(() => true)
    if (!listed) return settle()
    if (sentIn !== generation) return
    const sent = new Set(state.sent)
    sent.delete(pending.threadId)
    publish({ ...state, sent, error: { message: error instanceof Error ? error.message : String(error) } })
    // Announced here, not by the sidebar, so it is heard with the sidebar collapsed or off /chat.
    announce("Couldn't delete the chat.", 'assertive')
  })
}

async function threadIsListed({ userId, threadId }: PendingDelete): Promise<boolean> {
  const response = await authenticatedFetch('/v1/chat/threads', { userId })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = (await response.json()) as { threads: ChatThread[] }
  return body.threads.some((thread) => thread.thread_id === threadId)
}
