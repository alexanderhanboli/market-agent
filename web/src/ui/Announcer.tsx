import type { ReactElement } from 'react'

import { useAnnouncements } from './announcer.ts'

// Mounted once at the app root. The regions stay in the DOM so readers track them from load.
export function Announcer(): ReactElement {
  const { polite, assertive } = useAnnouncements()
  return (
    <div data-testid="announcer" className="sr-only">
      <p role="status">{polite}</p>
      <p role="alert">{assertive}</p>
    </div>
  )
}
