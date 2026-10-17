import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { authenticatedJson } from '../http/authFetch.ts'
import {
  INITIAL_CHAT_SESSION,
  reduceChatSession,
  selectThreadView,
  type ChatSessionAction,
  type ChatSessionState,
  type ThreadView,
  type TurnIds,
} from './chatSession.ts'
import type { ChatMessage } from './messageTypes.ts'
import { openChatTurnStream } from './openChatTurnStream.ts'
import { persistUserChatTurn } from './persistUserChatTurn.ts'
import { createThread } from './threadActions.ts'

const HISTORY_TIMEOUT_MS = 10_000

export type ChatSession = {
  view: ThreadView
  // Claims the turn synchronously against the store; false means rejected
  // (a turn is in flight), and the caller keeps its draft.
  ask(text: string): boolean
  retry(): void
  reload(): void
}

type SessionStore = {
  getState(): ChatSessionState
  dispatch(action: ChatSessionAction): void
  subscribe(listener: () => void): () => void
}

function createSessionStore(initial: ChatSessionState): SessionStore {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduceChatSession(state, action)
      if (next === state) return
      state = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

// A send from the moment ask claims it until its POST fails or its stream
// settles. An attached run feeds the session's turn. A detached run dispatches
// nothing and is left to close itself on its first terminal event or error:
// closing it at once could cancel the request before the server starts the run.
type PendingRun = { runId: string; threadId: string | null; source: EventSource | null; detached: boolean }

function createSessionStreams(store: SessionStore) {
  const runs = new Set<PendingRun>()
  let disposed = false
  const sync = () => {
    const state = store.getState()
    if (state.threadId === null) return
    const own = 'turn' in state.turn ? state.turn.turn.runId : null
    const running = [...runs].some((run) => run.threadId === state.threadId && run.runId !== own)
    store.dispatch({ type: 'background.changed', threadId: state.threadId, running })
  }
  // A detached run's answer reaches the thread through a history load, never
  // through a replay of its stream.
  const settle = (run: PendingRun, reload: boolean) => {
    if (!runs.delete(run)) return
    sync()
    if (reload && run.detached && run.threadId === store.getState().threadId) store.dispatch({ type: 'history.requested' })
  }
  return {
    claim(threadId: string | null, runId: string): PendingRun {
      const run: PendingRun = { runId, threadId, source: null, detached: false }
      runs.add(run)
      return run
    },
    place(run: PendingRun, threadId: string) {
      run.threadId = threadId
      sync()
    },
    drop(run: PendingRun) {
      settle(run, false)
    },
    open(run: PendingRun, input: { threadId: string; turn: TurnIds; userId: string; attached: boolean }) {
      const { threadId, turn } = input
      run.threadId = threadId
      run.detached = !input.attached
      run.source = openChatTurnStream({
        threadId,
        runId: turn.runId,
        turnId: turn.messageId,
        userIntent: turn.text,
        userId: input.userId,
      }, {
        onEvent: (event) => {
          if (!run.detached) store.dispatch({ type: 'stream.event', threadId, event })
        },
        onCompleted: () => settle(run, true),
        onError: () => {
          if (!run.detached) store.dispatch({ type: 'stream.disconnected', threadId, runId: turn.runId })
          settle(run, true)
        },
      })
    },
    // Runs on every thread switch, before paint, so Send is never enabled on
    // a thread that still has a run going.
    activate() {
      const active = store.getState().threadId
      for (const run of runs) {
        if (run.threadId !== active) run.detached = true
      }
      sync()
    },
    get disposed() {
      return disposed
    },
    mount() {
      disposed = false
    },
    dispose() {
      disposed = true
      for (const run of runs) run.source?.close()
      runs.clear()
    },
  }
}

type ChatSessionDeps = {
  userId: string
  threadId: string | null
  navigate: (to: string) => void
  onThreadCreated: () => void
}

export function useChatSession({ userId, threadId, navigate, onThreadCreated }: ChatSessionDeps): ChatSession {
  const [store] = useState(() =>
    createSessionStore(reduceChatSession(INITIAL_CHAT_SESSION, { type: 'thread.opened', threadId })))
  const [streams] = useState(() => createSessionStreams(store))
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState)
  const view = useMemo(() => selectThreadView(state), [state])

  useLayoutEffect(() => {
    store.dispatch({ type: 'thread.opened', threadId })
    streams.activate()
  }, [store, streams, threadId])

  useEffect(() => {
    streams.mount()
    return () => streams.dispose()
  }, [streams])

  const ask = useCallback((raw: string): boolean => {
    const text = raw.trim()
    const before = store.getState()
    if (text === '' || !userId || !selectThreadView(before).canAsk) return false
    const turn: TurnIds = { runId: makeId(), messageId: makeId(), snapshotId: makeId(), text }
    store.dispatch({ type: 'ask.started', turn })
    const run = streams.claim(before.threadId, turn.runId)

    // A disposed session has no UI left to update or navigate from.
    const owns = () => {
      const current = store.getState().turn
      return !streams.disposed && current.phase === 'persisting' && current.turn.runId === turn.runId
    }
    const fail = (caught: unknown) => {
      if (owns()) store.dispatch({ type: 'ask.failed', error: errorText(caught) })
      streams.drop(run)
    }
    const send = async () => {
      let sendThreadId = before.threadId
      if (sendThreadId === null) {
        let created
        try {
          created = await createThread(userId)
        } catch (caught) {
          fail(caught)
          return
        }
        sendThreadId = created.thread_id
        streams.place(run, sendThreadId)
        onThreadCreated()
        if (owns()) {
          store.dispatch({ type: 'thread.created', threadId: sendThreadId })
          navigate(`/chat/${sendThreadId}`)
        }
      }
      let message: ChatMessage
      try {
        message = await persistUserChatTurn({
          threadId: sendThreadId,
          userId,
          messageId: turn.messageId,
          snapshotId: turn.snapshotId,
          content: turn.text,
        })
      } catch (caught) {
        fail(caught)
        return
      }
      // A user who left mid-send still gets the run started; its stream is detached.
      const attached = owns() && store.getState().threadId === sendThreadId
      if (attached) store.dispatch({ type: 'message.persisted', threadId: sendThreadId, message })
      streams.open(run, { threadId: sendThreadId, turn, userId, attached })
    }
    void send()
    return true
  }, [store, streams, userId, navigate, onThreadCreated])

  const retry = useCallback(() => {
    const current = store.getState()
    if (current.turn.phase !== 'failed' || current.threadId === null) return
    const { turn } = current.turn
    store.dispatch({ type: 'stream.reopened' })
    streams.open(streams.claim(current.threadId, turn.runId), { threadId: current.threadId, turn, userId, attached: true })
  }, [store, streams, userId])

  const reload = useCallback(() => store.dispatch({ type: 'history.requested' }), [store])

  const loadThreadId = view.needsLoad?.threadId ?? null
  const loadGen = view.needsLoad?.gen ?? 0
  useEffect(() => {
    if (loadThreadId === null || !userId) return
    const controller = new AbortController()
    authenticatedJson<{ messages?: ChatMessage[] }>(`/v1/chat/threads/${encodeURIComponent(loadThreadId)}/messages`, {
      userId,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(HISTORY_TIMEOUT_MS)]),
    }).then(
      (body) => store.dispatch({ type: 'history.loaded', threadId: loadThreadId, gen: loadGen, messages: body.messages ?? [] }),
      (caught: unknown) => {
        if (controller.signal.aborted) return
        store.dispatch({ type: 'history.failed', threadId: loadThreadId, gen: loadGen, message: errorText(caught) })
      },
    )
    return () => controller.abort()
  }, [store, userId, loadThreadId, loadGen])

  return useMemo(() => ({ view, ask, retry, reload }), [view, ask, retry, reload])
}

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
}

function makeId(): string {
  if ('randomUUID' in crypto) return crypto.randomUUID()
  return `00000000-0000-4000-8000-${Math.floor(Math.random() * 1e12).toString().padStart(12, '0')}`
}
