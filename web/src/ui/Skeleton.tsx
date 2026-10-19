import type { HTMLAttributes, ReactElement } from 'react'

type SkeletonProps = {
  // Unlabelled skeletons are decorative, so a group of rows announces once.
  label?: string
  className?: string
} & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'role' | 'aria-busy' | 'aria-label' | 'aria-hidden'>

export function Skeleton({ label, className = 'h-4', ...rest }: SkeletonProps): ReactElement {
  const a11y = label === undefined
    ? { 'aria-hidden': true }
    : { role: 'status', 'aria-busy': true, 'aria-label': label }
  return <div {...rest} {...a11y} className={`${className} animate-pulse rounded-md bg-surface-2`} />
}
