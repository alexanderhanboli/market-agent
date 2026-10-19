import type { ReactElement } from 'react'

import { Skeleton } from '../ui/Skeleton.tsx'
import { DEFAULT_SKELETON_HEIGHT, SKELETON_HEIGHT_BY_KIND } from './blockSkeletonHeights.ts'

type BlockSkeletonProps = {
  blockId: string
  kind: string
}

export function BlockSkeleton({ blockId, kind }: BlockSkeletonProps): ReactElement {
  return (
    <Skeleton
      data-testid={`block-skeleton-${blockId}`}
      data-block-kind={kind}
      data-block-status="pending"
      label={`Loading ${kind} block`}
      className={SKELETON_HEIGHT_BY_KIND[kind] ?? DEFAULT_SKELETON_HEIGHT}
    />
  )
}
