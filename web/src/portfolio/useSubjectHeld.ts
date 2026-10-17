// Per-subject held-state lookup for the subject-detail header.
//
// The portfolio service exposes overlays as a bulk read: one POST returns
// contributions for an array of subject_refs. The header only cares about
// one subject, so we send a one-element array. A future surface (e.g. a
// list of N subjects with held badges) should batch through `fetchOverlays`
// directly and pass the array — don't loop this hook.

import { useResource, type VisibleFetchState } from '../fetch/resource.ts'
import type { SubjectRef } from '../symbol/search.ts'
import { isHeldSubjectRef, subjectHeld } from './overlays.ts'

export type SubjectHeldState = VisibleFetchState<boolean>

// Returns 'idle' for subjects that can't be held by contract (issuer, theme,
// macro_topic, portfolio, screen) — those never reach the network.
export function useSubjectHeld(subjectRef: SubjectRef, userId: string | null): SubjectHeldState {
  const heldKindRef = isHeldSubjectRef(subjectRef) ? subjectRef : null
  return useResource(
    subjectHeld,
    userId && heldKindRef ? { userId, subjectRef: heldKindRef } : null,
  )
}
