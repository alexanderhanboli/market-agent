import { QuoteRow } from '../symbol/QuoteRow'
import { FailureNotice } from '../ui/FailureNotice.tsx'
import { Skeleton } from '../ui/Skeleton.tsx'
import type { SubjectRef, WatchlistMember } from './membership'
import type { ManualWatchlistLoad } from './useManualWatchlist'

type ManualWatchlistProps = {
  members: WatchlistMember[]
  load: ManualWatchlistLoad
  editError: string | null
  onRemove: (subjectRef: SubjectRef) => void
  onRetry: () => void
  // Closes-by-listing-id for the inline row sparklines; rows without an entry
  // (non-listing members, missing coverage) render without a sparkline.
  sparklines?: ReadonlyMap<string, ReadonlyArray<number>>
}

// Each row hydrates its own quote through the shared QuoteRow component
// (cw0.10.1) so watchlist members and held holdings render identically
// for the same subject. Members whose subject_ref is not listing-kind
// have no quote and are named by subject hydration — the rule from fra-6al.6.2.
export function ManualWatchlist({ members, load, editError, onRemove, onRetry, sparklines }: ManualWatchlistProps) {
  if (load.status === 'loading' && members.length === 0) {
    return (
      <div className="px-1.5 py-3">
        <Skeleton label="Loading watchlist" className="h-8" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {load.status === 'error' ? (
        <div className="px-1.5 py-3">
          <FailureNotice message="Couldn't load your watchlist." detail={load.reason} onRetry={onRetry} />
        </div>
      ) : null}
      {members.length > 0 ? (
        <ul aria-label="Watchlist members" className="flex flex-col">
          {members.map((member, index) => (
            <QuoteRow
              key={`${member.subject_ref.kind}:${member.subject_ref.id}`}
              subjectRef={member.subject_ref}
              sparkline={
                member.subject_ref.kind === 'listing'
                  ? sparklines?.get(member.subject_ref.id)
                  : undefined
              }
              trailing={(label) => (
                <button
                  type="button"
                  onClick={() => onRemove(member.subject_ref)}
                  aria-label={`Remove ${label ?? `symbol ${index + 1}`} from watchlist`}
                  className="shrink-0 px-2 text-xs text-faint hover:text-negative"
                >
                  ×
                </button>
              )}
            />
          ))}
        </ul>
      ) : load.status === 'error' ? null : (
        <div className="px-1.5 py-3 text-xs text-muted">No saved symbols yet. Add one from the search above.</div>
      )}
      {editError ? (
        <div className="px-1.5">
          <FailureNotice message="Couldn't update your watchlist." detail={editError} />
        </div>
      ) : null}
    </div>
  )
}
