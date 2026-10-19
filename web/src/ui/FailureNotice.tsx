import { useId, type ReactElement } from 'react'

type FailureNoticeProps = {
  message: string
  detail: string
  onRetry?: () => void
}

export function FailureNotice({ message, detail, onRetry }: FailureNoticeProps): ReactElement {
  const messageId = useId()
  return (
    <div className="flex flex-col gap-1 text-sm text-muted">
      <div className="flex flex-wrap items-center gap-2">
        <p id={messageId}>{message}</p>
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
