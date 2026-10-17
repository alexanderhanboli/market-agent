import type { ChatSseEvent } from './sseEventTypes.ts'

type ChatTurnStreamCallbacks = {
  onEvent(event: ChatSseEvent): void
  // The server answered, so the turn exists: closing now can't cancel its start.
  onOpen?(): void
  onCompleted?(): void
  onError(): void
}

export function openChatTurnStream(
  input: {
    threadId: string
    runId: string
    turnId?: string
    userId: string
  } & (
    // Starts the turn when the server has none with these ids.
    | { userIntent: string; attach?: never }
    // Follows a turn the server already has; never starts one.
    | { attach: true; userIntent?: never }
  ),
  callbacks: ChatTurnStreamCallbacks,
  EventSourceCtor: typeof EventSource = EventSource,
): EventSource {
  const params = new URLSearchParams({
    run_id: input.runId,
    turn_id: input.turnId ?? input.runId,
    ...(input.attach ? {} : { user_intent: input.userIntent }),
    user_id: input.userId,
    ...(input.attach ? { attach: '1' } : {}),
  })
  const source = new EventSourceCtor(`/v1/chat/threads/${encodeURIComponent(input.threadId)}/stream?${params}`)
  source.onopen = () => callbacks.onOpen?.()
  source.onmessage = (event) => {
    callbacks.onEvent(JSON.parse(event.data) as ChatSseEvent)
  }
  for (const type of [
    'turn.started',
    'tool.started',
    'tool.completed',
    'snapshot.staged',
    'snapshot.sealed',
    'block.began',
    'block.delta',
    'block.completed',
    'turn.completed',
    'turn.error',
  ] as const) {
    source.addEventListener(type, (event) => {
      callbacks.onEvent(JSON.parse((event as MessageEvent).data) as ChatSseEvent)
      if (type === 'turn.completed') {
        callbacks.onCompleted?.()
        source.close()
      }
      // The turn ended: the event said how, and nothing reopens it.
      if (type === 'turn.error') source.close()
    })
  }
  source.onerror = () => {
    callbacks.onError()
    source.close()
  }
  return source
}
