import { useSyncExternalStore } from 'react'

export type Politeness = 'polite' | 'assertive'

type Announcements = Readonly<Record<Politeness, string>>

// Long enough for a screen reader to register the cleared region before the new text.
export const ANNOUNCE_DELAY_MS = 100
// A region left holding old text is found again by browse-mode reading, beside newer messages.
export const ANNOUNCE_CLEAR_MS = 10_000

const EMPTY: Announcements = { polite: '', assertive: '' }
const POLITENESS = ['polite', 'assertive'] as const

// Module scope so code outside React, such as a delete that fails off-screen, can speak.
let regions = EMPTY
// One object per call, so withdrawing one call leaves another with the same text queued.
const queued: Record<Politeness, Array<{ text: string }>> = { polite: [], assertive: [] }
let timer: ReturnType<typeof setTimeout> | null = null
const clearTimers: Record<Politeness, ReturnType<typeof setTimeout> | null> = { polite: null, assertive: null }
const listeners = new Set<() => void>()

function publish(next: Announcements): void {
  regions = next
  for (const listener of [...listeners]) listener()
}

// Messages announced within one delay of the first are spoken together, each once.
// The returned function withdraws the message if it has not been spoken yet.
export function announce(text: string, politeness: Politeness = 'polite'): () => void {
  const entry = { text }
  queued[politeness].push(entry)
  // Clearing first makes a repeat of the same text a change the reader hears.
  if (regions[politeness] !== '') publish({ ...regions, [politeness]: '' })
  timer ??= setTimeout(flush, ANNOUNCE_DELAY_MS)
  return () => {
    const index = queued[politeness].indexOf(entry)
    if (index !== -1) queued[politeness].splice(index, 1)
  }
}

function flush(): void {
  timer = null
  const next = { ...regions }
  for (const politeness of POLITENESS) {
    if (queued[politeness].length === 0) continue
    next[politeness] = [...new Set(queued[politeness].map((entry) => entry.text))].join(' ')
    queued[politeness] = []
    const clearTimer = clearTimers[politeness]
    if (clearTimer !== null) clearTimeout(clearTimer)
    clearTimers[politeness] = setTimeout(() => {
      clearTimers[politeness] = null
      publish({ ...regions, [politeness]: '' })
    }, ANNOUNCE_CLEAR_MS)
  }
  publish(next)
}

export function resetAnnouncerForTests(): void {
  for (const pending of [timer, ...Object.values(clearTimers)]) if (pending !== null) clearTimeout(pending)
  timer = null
  for (const politeness of POLITENESS) {
    queued[politeness] = []
    clearTimers[politeness] = null
  }
  publish(EMPTY)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getSnapshot = () => regions

export function useAnnouncements(): Announcements {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
