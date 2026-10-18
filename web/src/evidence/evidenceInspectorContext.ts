import { createContext } from 'react'

import type { EvidenceBlockInspection, EvidenceInspectionRef } from './inspectionTypes.ts'

export type EvidenceInspectorContextValue = {
  /** `shownAs` is the exact text the clicked control displayed; the panel heads with it over the server title. */
  openInspection(input: { snapshotId: string; ref: EvidenceInspectionRef; shownAs?: string }): void
  openBlockInspection(inspection: EvidenceBlockInspection): void
  /** Opens the shared inspector for one certified financial result. Absent where the host cannot fetch one. */
  openFinancialResult?(resultId: string): void
  closeInspection(): void
}

export const EvidenceInspectorContext = createContext<EvidenceInspectorContextValue | null>(null)
