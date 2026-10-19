import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { authenticatedFetch } from '../http/authFetch.ts'
import type { ChatThread } from './threadActions.ts'
import { beginThreadListRead, useThreadDeletes } from './threadDeletes.ts'

export type ThreadListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; threads: ReadonlyArray<ChatThread> }

export type ThreadList = { state: ThreadListState; refresh: () => void }

export function useThreadList(userId: string): ThreadList {
  const [state, setState] = useState<ThreadListState>({ kind: 'loading' })
  const [refreshKey, setRefreshKey] = useState(0)
  const { sent, settled } = useThreadDeletes()

  useEffect(() => {
    if (!userId) return
    const controller = new AbortController()
    const readSucceeded = beginThreadListRead()
    authenticatedFetch('/v1/chat/threads', { userId, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return (await response.json()) as { threads: ChatThread[] }
      })
      .then(
        (body) => {
          setState({ kind: 'ready', threads: body.threads })
          readSucceeded()
        },
        (error: unknown) => {
          if (controller.signal.aborted) return
          // A failed refresh, such as a title poll, keeps the last good list.
          setState((current) => current.kind === 'ready'
            ? current
            : { kind: 'error', message: error instanceof Error ? error.message : String(error) })
        },
      )
    return () => controller.abort()
  }, [userId, refreshKey, settled])

  const refresh = useCallback(() => {
    setState((current) => current.kind === 'ready' ? current : { kind: 'loading' })
    setRefreshKey((key) => key + 1)
  }, [])
  const visible = useMemo<ThreadListState>(
    () => state.kind === 'ready' ? { kind: 'ready', threads: state.threads.filter((thread) => !sent.has(thread.thread_id)) } : state,
    [state, sent],
  )
  return { state: visible, refresh }
}

// The server titles a thread after the turn completes and sends no event for
// it, so the list is re-read on this schedule after each hand-off.
export const TITLE_FOLLOW_UP_DELAYS_MS = [0, 2000, 5000, 10000] as const

export function useTitleFollowUp(input: {
  threadId: string | null
  sealedTurns: number
  titled: boolean
  refresh: () => void
}): void {
  const { threadId, sealedTurns, titled, refresh } = input
  const titledRef = useRef(titled)
  useEffect(() => {
    titledRef.current = titled
  }, [titled])

  useEffect(() => {
    if (threadId === null || sealedTurns === 0) return
    let step = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const scheduleNext = () => {
      const previous = step === 0 ? 0 : TITLE_FOLLOW_UP_DELAYS_MS[step - 1]
      timer = setTimeout(() => {
        if (step > 0 && titledRef.current) return
        refresh()
        step += 1
        if (step < TITLE_FOLLOW_UP_DELAYS_MS.length) scheduleNext()
      }, TITLE_FOLLOW_UP_DELAYS_MS[step] - previous)
    }
    scheduleNext()
    return () => clearTimeout(timer)
  }, [threadId, sealedTurns, refresh])
}
