export type EvidenceInspectionRefKind = 'source' | 'document' | 'claim' | 'event' | 'fact' | 'series'

export type EvidenceInspectionRef = {
  kind: EvidenceInspectionRefKind
  id: string
}

/** A ref the inspector links to, with a readable name when the server has one. */
export type EvidenceInspectionRelatedRef = EvidenceInspectionRef & {
  label?: string
}

export type EvidenceInspectionRow = {
  label: string
  value: string
}

export type EvidenceInspectionLink = {
  label: string
  href: string
}

export type EvidenceInspection = {
  snapshot_id: string
  ref: EvidenceInspectionRef
  kind: EvidenceInspectionRefKind
  title: string
  subtitle: string | null
  badges: ReadonlyArray<string>
  rows: ReadonlyArray<EvidenceInspectionRow>
  links: ReadonlyArray<EvidenceInspectionLink>
  related_refs: ReadonlyArray<EvidenceInspectionRelatedRef>
}

export type EvidenceBlockInspection = {
  snapshot_id: string
  block_id: string
  block_kind: string
  title: string
  subtitle: string | null
  badges: ReadonlyArray<string>
  rows: ReadonlyArray<EvidenceInspectionRow>
  related_refs: ReadonlyArray<EvidenceInspectionRelatedRef>
}
