import type { ChatMessage } from './messageTypes.ts'
import type { ChatSseEvent } from './sseEventTypes.ts'
import { INITIAL_STREAM_STATE, applyChatStreamEvent, type StreamState } from './streamReducer.ts'

export type TurnIds = { runId: string; messageId: string; snapshotId: string; text: string }

// "handed_off" collapses into idle: once the sealed message is in history there
// is nothing left to render.
export type TurnState =
  | { phase: 'idle' }
  | { phase: 'persisting'; turn: TurnIds }
  | { phase: 'not_sent'; text: string; error: string }
  | { phase: 'streaming'; turn: TurnIds; stream: StreamState }
  // A failed turn's way back: reopen its stream, or, when the stream completed
  // without a sealed message, reload the thread (replaying it changes nothing)
  // until a load returns messageId, the saved answer the completion named.
  | { phase: 'failed'; turn: TurnIds; stream: StreamState; error: string; recovery: 'retry_stream' }
  | { phase: 'failed'; turn: TurnIds; stream: StreamState; error: string; recovery: 'reload_thread'; messageId: string | null }
  | { phase: 'unverified'; turn: TurnIds; stream: StreamState }

type LoadedHistory =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; messages: ReadonlyArray<ChatMessage> }

export type HistoryState = {
  // The generation the shell must load; bumping it means "refetch".
  requested: number
  // The last generation that resolved, ok or failed.
  settled: number
  loaded: LoadedHistory
  // Messages the server returned outside a history load (the POSTed question,
  // the sealed answer from turn.completed) that no load has returned yet.
  local: ReadonlyArray<ChatMessage>
}

export type Reconcile =
  | { kind: 'none' }
  | { kind: 'awaiting_hand_off' }
  | { kind: 'awaiting_load'; gen: number }

const RECONCILED: Reconcile = { kind: 'none' }

export type ChatSessionState = {
  threadId: string | null
  history: HistoryState
  turn: TurnState
  sealedTurns: number
  // A turn failed and another was asked after it. The failed turn's answer may
  // still commit, unseen, but the server runs a thread's turns in order, so it
  // has committed by the time the next turn hands off. Only the load that
  // hand-off requests, or a later one, can show it.
  reconcile: Reconcile
  // A send on this thread that is not the session's turn is still going.
  backgroundRun: boolean
  // Bumped by every thread.opened that changes the thread, but not by
  // thread.created, so ask-first keeps one message list into its new thread.
  opens: number
}

export type ChatSessionAction =
  | { type: 'thread.opened'; threadId: string | null }
  | { type: 'ask.started'; turn: TurnIds }
  | { type: 'thread.created'; threadId: string }
  | { type: 'message.persisted'; threadId: string; message: ChatMessage }
  | { type: 'ask.failed'; error: string }
  | { type: 'stream.event'; threadId: string; event: ChatSseEvent }
  | { type: 'stream.disconnected'; threadId: string; runId: string }
  | { type: 'stream.reopened' }
  | { type: 'background.changed'; threadId: string; running: boolean }
  | { type: 'history.requested' }
  | { type: 'history.loaded'; threadId: string; gen: number; messages: ReadonlyArray<ChatMessage> }
  | { type: 'history.failed'; threadId: string; gen: number; message: string }

export const STREAM_DISCONNECTED = 'The analyst stream disconnected.'
export const NOT_SEALED = "Couldn't show the saved copy of this answer."
export const NOT_IN_THREAD = "The saved copy of this answer isn't in the thread yet."
export const RELOAD_FAILED = "Couldn't load the saved copy of this answer."

const IDLE: TurnState = { phase: 'idle' }
const EMPTY_READY: LoadedHistory = { kind: 'ready', messages: [] }

export const INITIAL_CHAT_SESSION: ChatSessionState = {
  threadId: null,
  history: { requested: 0, settled: 0, loaded: EMPTY_READY, local: [] },
  turn: IDLE,
  sealedTurns: 0,
  reconcile: RECONCILED,
  backgroundRun: false,
  opens: 0,
}

function openedSession(threadId: string | null, opens: number): ChatSessionState {
  if (threadId === null) return { ...INITIAL_CHAT_SESSION, opens }
  return {
    threadId,
    history: { requested: 1, settled: 0, loaded: { kind: 'loading' }, local: [] },
    turn: IDLE,
    sealedTurns: 0,
    reconcile: RECONCILED,
    backgroundRun: false,
    opens,
  }
}

const ASKABLE_PHASES: ReadonlySet<TurnState['phase']> = new Set(['idle', 'not_sent', 'failed', 'unverified'])

function askable(s: ChatSessionState): boolean {
  return ASKABLE_PHASES.has(s.turn.phase) && !s.backgroundRun
}

export function reduceChatSession(s: ChatSessionState, a: ChatSessionAction): ChatSessionState {
  switch (a.type) {
    case 'thread.opened':
      return a.threadId === s.threadId ? s : openedSession(a.threadId, s.opens + 1)

    case 'ask.started':
      if (!askable(s)) return s
      return {
        ...s,
        reconcile: s.turn.phase === 'failed' ? { kind: 'awaiting_hand_off' } : s.reconcile,
        turn: { phase: 'persisting', turn: a.turn },
      }

    case 'thread.created':
      if (s.threadId !== null || s.turn.phase !== 'persisting') return s
      return {
        ...s,
        threadId: a.threadId,
        history: { requested: 0, settled: 0, loaded: EMPTY_READY, local: [] },
      }

    case 'message.persisted': {
      if (a.threadId !== s.threadId || s.turn.phase !== 'persisting') return s
      const history = withLocal(s.history, a.message)
      return {
        ...s,
        history: { ...history, loaded: history.loaded.kind === 'ready' ? history.loaded : EMPTY_READY },
        turn: { phase: 'streaming', turn: s.turn.turn, stream: INITIAL_STREAM_STATE },
      }
    }

    case 'ask.failed':
      if (s.turn.phase !== 'persisting') return s
      return { ...s, turn: { phase: 'not_sent', text: s.turn.turn.text, error: a.error } }

    case 'stream.event':
      return reduceStreamEvent(s, a.threadId, a.event)

    case 'stream.disconnected':
      if (a.threadId !== s.threadId || s.turn.phase !== 'streaming' || s.turn.turn.runId !== a.runId) return s
      return { ...s, turn: { phase: 'failed', turn: s.turn.turn, stream: s.turn.stream, error: STREAM_DISCONNECTED, recovery: 'retry_stream' } }

    case 'stream.reopened':
      if (s.turn.phase !== 'failed' || s.turn.recovery !== 'retry_stream') return s
      return {
        ...s,
        turn: { phase: 'streaming', turn: s.turn.turn, stream: { ...s.turn.stream, turn_status: 'started', error: null } },
      }

    case 'background.changed':
      if (a.threadId !== s.threadId || a.running === s.backgroundRun) return s
      return { ...s, backgroundRun: a.running }

    case 'history.requested':
      if (s.threadId === null) return s
      return { ...s, history: requestHistory(s.history) }

    case 'history.loaded': {
      if (a.threadId !== s.threadId || a.gen !== s.history.requested) return s
      const loadedIds = new Set(a.messages.map((m) => m.message_id))
      const history: HistoryState = {
        requested: s.history.requested,
        settled: a.gen,
        loaded: { kind: 'ready', messages: a.messages },
        local: s.history.local.filter((m) => !loadedIds.has(m.message_id)),
      }
      // A reload of a failed turn was requested after that turn ended, so it
      // reconciles; any other load counts only if a hand-off requested it.
      if (s.turn.phase !== 'failed' || s.turn.recovery !== 'reload_thread') return { ...s, history, reconcile: reconciledBy(s.reconcile, a.gen) }
      // The reload's hand-off: the saved answer replaces the streamed one in this state.
      if (s.turn.messageId === null || loadedIds.has(s.turn.messageId)) {
        return { ...s, history, turn: IDLE, sealedTurns: s.sealedTurns + 1, reconcile: RECONCILED }
      }
      return { ...s, history, turn: { ...s.turn, error: NOT_IN_THREAD }, reconcile: RECONCILED }
    }

    case 'history.failed': {
      if (a.threadId !== s.threadId || a.gen !== s.history.requested) return s
      const loaded: LoadedHistory = s.history.loaded.kind === 'ready' ? s.history.loaded : { kind: 'error', message: a.message }
      const turn = s.turn.phase === 'failed' && s.turn.recovery === 'reload_thread' ? { ...s.turn, error: RELOAD_FAILED } : s.turn
      return { ...s, history: { ...s.history, settled: a.gen, loaded }, turn }
    }
  }
}

function reconciledBy(reconcile: Reconcile, gen: number): Reconcile {
  return reconcile.kind === 'awaiting_load' && gen >= reconcile.gen ? RECONCILED : reconcile
}

function requestHistory(history: HistoryState): HistoryState {
  const loaded: LoadedHistory = history.loaded.kind === 'error' ? { kind: 'loading' } : history.loaded
  return { ...history, requested: history.requested + 1, loaded }
}

function withLocal(history: HistoryState, message: ChatMessage): HistoryState {
  const known = (m: ChatMessage) => m.message_id === message.message_id
  if (history.local.some(known)) return history
  if (history.loaded.kind === 'ready' && history.loaded.messages.some(known)) return history
  return { ...history, local: [...history.local, message] }
}

function reduceStreamEvent(s: ChatSessionState, threadId: string, event: ChatSseEvent): ChatSessionState {
  const { turn } = s
  if (threadId !== s.threadId || turn.phase !== 'streaming' || event.run_id !== turn.turn.runId) return s
  const stream = applyChatStreamEvent(turn.stream, event)
  if (stream === turn.stream) return s
  switch (stream.turn_status) {
    case 'completed':
      // The hand-off: the sealed answer joins the thread in the state that drops the stream.
      return {
        ...s,
        history: s.reconcile.kind === 'none' ? withLocal(s.history, stream.sealed) : requestHistory(withLocal(s.history, stream.sealed)),
        reconcile: s.reconcile.kind === 'none' ? RECONCILED : { kind: 'awaiting_load', gen: s.history.requested + 1 },
        turn: IDLE,
        sealedTurns: s.sealedTurns + 1,
      }
    case 'unsealed':
      return { ...s, turn: { phase: 'failed', turn: turn.turn, stream, error: NOT_SEALED, recovery: 'reload_thread', messageId: stream.message_id } }
    case 'unverified':
      return { ...s, turn: { phase: 'unverified', turn: turn.turn, stream } }
    case 'error':
      return { ...s, turn: { phase: 'failed', turn: turn.turn, stream, error: `Stream error: ${stream.error ?? 'unknown'}`, recovery: 'retry_stream' } }
    default:
      return { ...s, turn: { ...turn, stream } }
  }
}

export type ThreadView = {
  threadId: string | null
  history: 'loading' | 'error' | 'ready'
  historyError: string | null
  messages: ReadonlyArray<ChatMessage>
  // The session, not the route, picks the canvas: ask-first streams and hands
  // off before react-router commits /chat/<id> on a slow CPU.
  canvas: 'empty' | 'thread'
  listKey: number
  listMounted: boolean
  turn: TurnState
  backgroundRun: boolean
  canAsk: boolean
  firstQuestion: string | null
  sealedTurns: number
  needsLoad: { threadId: string; gen: number } | null
}

// Keyed on the loaded history so the list keeps one messages array across
// turn-only updates and its memoized rows don't re-render on every delta.
const mergedMessages = new WeakMap<object, { local: ReadonlyArray<ChatMessage>; messages: ReadonlyArray<ChatMessage> }>()

function visibleMessages(history: HistoryState): ReadonlyArray<ChatMessage> {
  const loaded = history.loaded.kind === 'ready' ? history.loaded.messages : []
  if (history.local.length === 0) return loaded
  const cached = mergedMessages.get(history.loaded)
  if (cached?.local === history.local) return cached.messages
  const messages = [...loaded, ...history.local]
  mergedMessages.set(history.loaded, { local: history.local, messages })
  return messages
}

export function selectThreadView(s: ChatSessionState): ThreadView {
  const { history, turn } = s
  const messages = visibleMessages(history)
  const firstUser = messages.find((m) => m.role === 'user')
  const pendingText = turn.phase === 'persisting' ? turn.turn.text : turn.phase === 'not_sent' ? turn.text : null
  return {
    threadId: s.threadId,
    history: history.loaded.kind,
    historyError: history.loaded.kind === 'error' ? history.loaded.message : null,
    messages,
    canvas: s.threadId !== null || turn.phase !== 'idle' ? 'thread' : 'empty',
    listKey: s.opens,
    listMounted: history.loaded.kind === 'ready' || turn.phase !== 'idle',
    turn,
    backgroundRun: s.backgroundRun,
    canAsk: askable(s),
    firstQuestion: (firstUser ? messageText(firstUser) : null) || pendingText,
    sealedTurns: s.sealedTurns,
    needsLoad: s.threadId !== null && history.requested > history.settled
      ? { threadId: s.threadId, gen: history.requested }
      : null,
  }
}

function messageText(message: ChatMessage): string {
  return message.blocks
    .flatMap((block) => (block.kind === 'rich_text' && 'segments' in block ? block.segments : []))
    .map((segment) => (segment.type === 'text' ? segment.text : ''))
    .join('')
}
