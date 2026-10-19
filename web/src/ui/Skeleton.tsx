import type { HTMLAttributes, ReactElement } from 'react'

type SkeletonProps = {
  // Unlabelled skeletons are decorative, so a group of rows announces once.
  label?: string
  className?: string
} & Omit<HTMLAttributes<HTMLSpanElement>, 'className' | 'role' | 'aria-hidden' | 'children'>

// A span, so it can stand in for text inside a heading or a paragraph.
export function Skeleton({ label, className = 'h-4', ...rest }: SkeletonProps): ReactElement {
  const classes = `block ${className} animate-pulse rounded-md bg-surface-2`
  if (label === undefined) return <span {...rest} aria-hidden="true" className={classes} />
  return (
    <span {...rest} role="status" className={classes}>
      <span className="sr-only">{label}</span>
    </span>
  )
}
