import { useCallback, useEffect, useState } from 'react'
import {
  addManualWatchlistMember,
  listManualWatchlistMembers,
  mergeMemberIntoList,
  removeManualWatchlistMember,
  removeMemberFromList,
  type SubjectRef,
  type WatchlistMember,
} from './membership'

export type ManualWatchlistLoad =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; reason: string }

export type ManualWatchlistState = {
  members: WatchlistMember[]
  load: ManualWatchlistLoad
  // A failed add or remove; kept apart so it never hides a failed load.
  editError: string | null
  addSubject: (subjectRef: SubjectRef) => Promise<void>
  removeSubject: (subjectRef: SubjectRef) => Promise<void>
  reload: () => void
}

// Single owner of membership state for the default manual watchlist
// (fra-6al.6.1). WatchlistSlot renders the sidebar chrome + SymbolSearch
// and ManualWatchlist renders the member rows — both call this hook so
// add/remove from either surface stay consistent.
export function useManualWatchlist(userId: string | null): ManualWatchlistState {
  const [members, setMembers] = useState<WatchlistMember[]>([])
  const [load, setLoad] = useState<ManualWatchlistLoad>(() =>
    userId ? { status: 'loading' } : { status: 'idle' },
  )
  const [editError, setEditError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)

  useEffect(() => {
    if (!userId) return
    const controller = new AbortController()
    listManualWatchlistMembers({ userId, signal: controller.signal })
      .then((next) => {
        if (controller.signal.aborted) return
        setMembers(next)
        setLoad({ status: 'idle' })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setLoad({ status: 'error', reason: error instanceof Error ? error.message : 'Failed to load watchlist' })
      })
    return () => controller.abort()
  }, [userId, loadAttempt])

  const reload = useCallback(() => {
    setLoad((current) => current.status === 'idle' ? current : { status: 'loading' })
    setLoadAttempt((attempt) => attempt + 1)
  }, [])

  const addSubject = useCallback(
    async (subjectRef: SubjectRef) => {
      if (!userId) return
      setEditError(null)
      try {
        const result = await addManualWatchlistMember({ userId, subject_ref: subjectRef })
        setMembers((current) => mergeMemberIntoList(current, result))
      } catch (error) {
        setEditError(error instanceof Error ? error.message : 'Failed to add')
      }
    },
    [userId],
  )

  const removeSubject = useCallback(
    async (subjectRef: SubjectRef) => {
      if (!userId) return
      setEditError(null)
      let previous: WatchlistMember[] = []
      setMembers((current) => {
        previous = current
        return removeMemberFromList(current, subjectRef)
      })
      try {
        await removeManualWatchlistMember({ userId, subject_ref: subjectRef })
      } catch (error) {
        setMembers(previous)
        setEditError(error instanceof Error ? error.message : 'Failed to remove')
      }
    },
    [userId],
  )

  return { members, load, editError, addSubject, removeSubject, reload }
}
