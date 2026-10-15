import type { ReactElement } from 'react'
import { InspectableRef } from '../evidence/InspectableRef.tsx'
import type { RefSegment, RichTextBlock, TextSegmentTone } from './types.ts'
import { isRefSegment, refSegmentPlaceholder } from './richText.ts'
import { resolveRefSegment, type SnapshotManifest } from './snapshotManifest.ts'
import { useSnapshotManifest } from './snapshotManifestContext.ts'
import { Markdown } from './Markdown.tsx'

type RichTextProps = { block: RichTextBlock }

// Inline emphasis for toned text runs (the video's green "+127% YoY" deltas).
// Neutral tone is intentionally unstyled: it exists so emitters can be
// explicit without changing rendering.
const TONE_CLASS: Readonly<Record<Exclude<TextSegmentTone, 'neutral'>, string>> = {
  positive: 'font-medium text-positive',
  negative: 'font-medium text-negative',
}

// The block is one Markdown document. Plain text runs are Markdown source,
// concatenated verbatim; refs and toned runs are embedded inline, so a ref's
// format and a toned delta render literally wherever the Markdown puts them.
export function RichText({ block }: RichTextProps): ReactElement {
  const manifest = useSnapshotManifest()
  const parts = block.segments.map((segment, index) => {
    if (isRefSegment(segment)) {
      return (
        <RefSegmentSpan
          snapshotId={block.snapshot_id}
          blockId={block.id}
          index={index}
          segment={segment}
          manifest={manifest}
        />
      )
    }
    if (segment.tone === undefined || segment.tone === 'neutral') return segment.text
    return { inline: <span data-tone={segment.tone} className={TONE_CLASS[segment.tone]}>{segment.text}</span> }
  })
  return (
    <div
      data-testid={`block-rich-text-${block.id}`}
      data-block-kind="rich_text"
      className="text-sm leading-6 text-fg-soft"
    >
      <Markdown text={parts} />
    </div>
  )
}

type RefSegmentSpanProps = {
  snapshotId: string
  blockId: string
  index: number
  segment: RefSegment
  manifest: SnapshotManifest | null
}

function RefSegmentSpan({ snapshotId, blockId, index, segment, manifest }: RefSegmentSpanProps): ReactElement {
  const baseAttrs = {
    'data-ref-kind': segment.ref_kind,
    'data-ref-id': segment.ref_id,
  }
  const inspectionRef = { kind: segment.ref_kind, id: segment.ref_id }
  if (manifest === null) {
    return (
      <InspectableRef
        snapshotId={snapshotId}
        inspectionRef={inspectionRef}
        testId={`block-rich-text-${blockId}-ref-${index}`}
        dataAttrs={{ ...baseAttrs, 'data-ref-state': 'placeholder' }}
        className="rounded bg-surface-2 px-1 text-fg-soft underline decoration-dotted"
      >
        {refSegmentPlaceholder(segment)}
      </InspectableRef>
    )
  }
  const resolved = resolveRefSegment(manifest, segment)
  if (resolved.state === 'unresolved') {
    return (
      <InspectableRef
        snapshotId={snapshotId}
        inspectionRef={inspectionRef}
        testId={`block-rich-text-${blockId}-ref-${index}`}
        dataAttrs={{ ...baseAttrs, 'data-ref-state': 'unresolved' }}
        className="rounded bg-negative-soft px-1 text-negative"
      >
        [unresolved {segment.ref_kind}]
      </InspectableRef>
    )
  }
  return (
    <InspectableRef
      snapshotId={snapshotId}
      inspectionRef={inspectionRef}
      testId={`block-rich-text-${blockId}-ref-${index}`}
      dataAttrs={{ ...baseAttrs, 'data-ref-state': 'resolved' }}
      className="rounded px-1 text-fg-soft underline decoration-dotted underline-offset-2"
    >
      {resolved.value}
    </InspectableRef>
  )
}
