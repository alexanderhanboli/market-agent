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
  | { phase: 'sealing'; turn: TurnIds; stream: StreamState; sealedId: string }
  | { phase: 'kept'; turn: TurnIds; stream: StreamState; sealedId: string; reason: 'not_in_history' | 'history_failed' }
  | { phase: 'failed'; turn: TurnIds; stream: StreamState; error: string }
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
  // Locally POSTed messages that no load has returned yet.
  unconfirmed: ReadonlyArray<ChatMessage>
}

export type ChatSessionState = {
  threadId: string | null
  history: HistoryState
  turn: TurnState
  sealedTurns: number
  // A send on this thread that is not the session's turn is still going.
  backgroundRun: boolean
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

const IDLE: TurnState = { phase: 'idle' }
const EMPTY_READY: LoadedHistory = { kind: 'ready', messages: [] }

export const INITIAL_CHAT_SESSION: ChatSessionState = {
  threadId: null,
  history: { requested: 0, settled: 0, loaded: EMPTY_READY, unconfirmed: [] },
  turn: IDLE,
  sealedTurns: 0,
  backgroundRun: false,
}

function openedSession(threadId: string | null): ChatSessionState {
  if (threadId === null) return INITIAL_CHAT_SESSION
  return {
    threadId,
    history: { requested: 1, settled: 0, loaded: { kind: 'loading' }, unconfirmed: [] },
    turn: IDLE,
    sealedTurns: 0,
    backgroundRun: false,
  }
}

const ASKABLE_PHASES: ReadonlySet<TurnState['phase']> = new Set(['idle', 'not_sent', 'kept', 'failed', 'unverified'])

function askable(s: ChatSessionState): boolean {
  return ASKABLE_PHASES.has(s.turn.phase) && !s.backgroundRun
}

export function reduceChatSession(s: ChatSessionState, a: ChatSessionAction): ChatSessionState {
  switch (a.type) {
    case 'thread.opened':
      return a.threadId === s.threadId ? s : openedSession(a.threadId)

    case 'ask.started':
      return askable(s) ? { ...s, turn: { phase: 'persisting', turn: a.turn } } : s

    case 'thread.created':
      if (s.threadId !== null || s.turn.phase !== 'persisting') return s
      return {
        ...s,
        threadId: a.threadId,
        history: { requested: 0, settled: 0, loaded: EMPTY_READY, unconfirmed: [] },
      }

    case 'message.persisted': {
      if (a.threadId !== s.threadId || s.turn.phase !== 'persisting') return s
      const history = withUnconfirmed(s.history, a.message)
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
      return { ...s, turn: { phase: 'failed', turn: s.turn.turn, stream: s.turn.stream, error: STREAM_DISCONNECTED } }

    case 'stream.reopened':
      if (s.turn.phase !== 'failed') return s
      return {
        ...s,
        turn: { phase: 'streaming', turn: s.turn.turn, stream: { ...s.turn.stream, turn_status: 'started', error: null } },
      }

    case 'background.changed':
      if (a.threadId !== s.threadId || a.running === s.backgroundRun) return s
      return { ...s, backgroundRun: a.running }

    case 'history.requested': {
      if (s.threadId === null) return s
      const requested = s.history.requested + 1
      const loaded: LoadedHistory = s.history.loaded.kind === 'error' ? { kind: 'loading' } : s.history.loaded
      const turn: TurnState = s.turn.phase === 'kept'
        ? { phase: 'sealing', turn: s.turn.turn, stream: s.turn.stream, sealedId: s.turn.sealedId }
        : s.turn
      return { ...s, history: { ...s.history, requested, loaded }, turn }
    }

    case 'history.loaded': {
      if (a.threadId !== s.threadId || a.gen !== s.history.requested) return s
      const loadedIds = new Set(a.messages.map((m) => m.message_id))
      const history: HistoryState = {
        requested: s.history.requested,
        settled: a.gen,
        loaded: { kind: 'ready', messages: a.messages },
        unconfirmed: s.history.unconfirmed.filter((m) => !loadedIds.has(m.message_id)),
      }
      if (s.turn.phase === 'sealing' || s.turn.phase === 'kept') {
        if (loadedIds.has(s.turn.sealedId)) return { ...s, history, turn: IDLE, sealedTurns: s.sealedTurns + 1 }
        if (s.turn.phase === 'sealing') {
          return { ...s, history, turn: { ...keptFrom(s.turn), reason: 'not_in_history' } }
        }
      }
      return { ...s, history }
    }

    case 'history.failed': {
      if (a.threadId !== s.threadId || a.gen !== s.history.requested) return s
      const loaded: LoadedHistory = s.history.loaded.kind === 'ready' ? s.history.loaded : { kind: 'error', message: a.message }
      const turn: TurnState = s.turn.phase === 'sealing' ? { ...keptFrom(s.turn), reason: 'history_failed' } : s.turn
      return { ...s, history: { ...s.history, settled: a.gen, loaded }, turn }
    }
  }
}

function withUnconfirmed(history: HistoryState, message: ChatMessage): HistoryState {
  const known = (m: ChatMessage) => m.message_id === message.message_id
  if (history.unconfirmed.some(known)) return history
  if (history.loaded.kind === 'ready' && history.loaded.messages.some(known)) return history
  return { ...history, unconfirmed: [...history.unconfirmed, message] }
}

function keptFrom(turn: Extract<TurnState, { phase: 'sealing' }>) {
  return { phase: 'kept' as const, turn: turn.turn, stream: turn.stream, sealedId: turn.sealedId }
}

function reduceStreamEvent(s: ChatSessionState, threadId: string, event: ChatSseEvent): ChatSessionState {
  const { turn } = s
  if (threadId !== s.threadId || turn.phase !== 'streaming' || event.run_id !== turn.turn.runId) return s
  const stream = applyChatStreamEvent(turn.stream, event)
  if (stream === turn.stream) return s
  if (stream.turn_status === 'completed' && stream.completed_message_id !== null) {
    const requested = s.history.requested + 1
    return {
      ...s,
      history: { ...s.history, requested },
      turn: { phase: 'sealing', turn: turn.turn, stream, sealedId: stream.completed_message_id },
    }
  }
  switch (stream.turn_status) {
    case 'unverified':
      return { ...s, turn: { phase: 'unverified', turn: turn.turn, stream } }
    case 'error':
      return { ...s, turn: { phase: 'failed', turn: turn.turn, stream, error: `Stream error: ${stream.error ?? 'unknown'}` } }
    default:
      return { ...s, turn: { ...turn, stream } }
  }
}

export type ThreadView = {
  threadId: string | null
  history: 'loading' | 'error' | 'ready'
  historyError: string | null
  messages: ReadonlyArray<ChatMessage>
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
const mergedMessages = new WeakMap<object, { unconfirmed: ReadonlyArray<ChatMessage>; messages: ReadonlyArray<ChatMessage> }>()

function visibleMessages(history: HistoryState): ReadonlyArray<ChatMessage> {
  const loaded = history.loaded.kind === 'ready' ? history.loaded.messages : []
  if (history.unconfirmed.length === 0) return loaded
  const cached = mergedMessages.get(history.loaded)
  if (cached?.unconfirmed === history.unconfirmed) return cached.messages
  const messages = [...loaded, ...history.unconfirmed]
  mergedMessages.set(history.loaded, { unconfirmed: history.unconfirmed, messages })
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
