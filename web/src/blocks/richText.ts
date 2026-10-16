import type { RefSegment, RichTextSegment, TextSegment } from './types.ts'

export function isTextSegment(segment: RichTextSegment): segment is TextSegment {
  return segment.type === 'text'
}

export function isRefSegment(segment: RichTextSegment): segment is RefSegment {
  return segment.type === 'ref'
}

export function refSegmentText(segment: RefSegment): string {
  if (segment.format && segment.format.length > 0) return segment.format
  return `[${segment.ref_kind}:${segment.ref_id.slice(0, 8)}]`
}
