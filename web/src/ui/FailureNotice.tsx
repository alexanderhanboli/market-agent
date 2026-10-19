import { useId, type ReactElement } from 'react'

type FailureNoticeProps = {
  message: string
  detail: string
  onRetry?: () => void
  // The parent speaks the message through its own live region.
  announced?: boolean
}

export function FailureNotice({ message, detail, onRetry, announced = false }: FailureNoticeProps): ReactElement {
  const messageId = useId()
  return (
    <div className="flex flex-col gap-1 text-sm text-muted">
      <div className="flex flex-wrap items-center gap-2">
        <p id={messageId} aria-hidden={announced || undefined}>{message}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            aria-describedby={messageId}
            className="rounded-md border border-line-strong px-2 py-0.5 text-xs font-medium text-fg hover:bg-surface-2"
          >
            Retry
          </button>
        )}
      </div>
      {detail !== '' && (
        <details className="text-xs text-faint">
          <summary className="cursor-pointer select-none">Details</summary>
          <p className="mt-1 break-words">{detail}</p>
        </details>
      )}
    </div>
  )
}
