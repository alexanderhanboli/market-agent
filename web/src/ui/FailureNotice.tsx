import { useEffect, useId, type ReactElement } from 'react'

import { announce as announceText } from './announcer.ts'

type FailureNoticeProps = {
  message: string
  detail: string
  onRetry?: () => void
  // False when the caller announces the failure itself.
  announce?: boolean
}

export function FailureNotice({ message, detail, onRetry, announce = false }: FailureNoticeProps): ReactElement {
  const messageId = useId()
  useEffect(() => {
    if (announce) announceText(message)
  }, [announce, message])
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
