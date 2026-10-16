import type { ReactNode } from 'react'
import type { VisibleFetchState } from '../fetch/resource.ts'

type FetchStateViewProps<T> = {
  state: VisibleFetchState<T>
  noun: string
  idleMessage: string
  children: (data: T) => ReactNode
}

const PLACEHOLDER_CLASS = 'text-sm text-muted'

export function FetchStateView<T>({
  state,
  noun,
  idleMessage,
  children,
}: FetchStateViewProps<T>) {
  if (state.status === 'idle') return <p className={PLACEHOLDER_CLASS}>{idleMessage}</p>
  if (state.status === 'loading') return <p className={PLACEHOLDER_CLASS}>Loading {noun}…</p>
  if (state.status === 'unavailable') {
    return (
      <p className={PLACEHOLDER_CLASS}>
        {capitalize(noun)} unavailable: {state.reason}
      </p>
    )
  }
  return (
    <>
      {children(state.data)}
      {state.refreshError !== null && <RefreshFailedNote noun={noun} error={state.refreshError} />}
    </>
  )
}

export function RefreshFailedNote({ noun, error }: { noun: string; error: string }) {
  return (
    <p className="text-xs text-faint">
      Showing earlier {noun}; refresh failed: {error}
    </p>
  )
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}
