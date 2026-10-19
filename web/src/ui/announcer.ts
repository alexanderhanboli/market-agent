import { useSyncExternalStore } from 'react'

export type Politeness = 'polite' | 'assertive'

type Announcements = Readonly<Record<Politeness, string>>

// Long enough for a screen reader to register the cleared region before the new text.
export const ANNOUNCE_DELAY_MS = 100

const EMPTY: Announcements = { polite: '', assertive: '' }

// Module scope so code outside React, such as a delete that fails off-screen, can speak.
let regions = EMPTY
const queued: Record<Politeness, Set<string>> = { polite: new Set(), assertive: new Set() }
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function publish(next: Announcements): void {
  regions = next
  for (const listener of [...listeners]) listener()
}

// Messages announced within one delay are spoken together, each once.
export function announce(text: string, politeness: Politeness = 'polite'): void {
  queued[politeness].add(text)
  // Clearing first makes a repeat of the same text a change the reader hears.
  if (regions[politeness] !== '') publish({ ...regions, [politeness]: '' })
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(flush, ANNOUNCE_DELAY_MS)
}

function flush(): void {
  timer = null
  const next = { ...regions }
  for (const politeness of ['polite', 'assertive'] as const) {
    if (queued[politeness].size === 0) continue
    next[politeness] = [...queued[politeness]].join(' ')
    queued[politeness].clear()
  }
  publish(next)
}

export function resetAnnouncerForTests(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  queued.polite.clear()
  queued.assertive.clear()
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
