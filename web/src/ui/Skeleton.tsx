import type { HTMLAttributes, ReactElement } from 'react'

type SkeletonProps = {
  label: string
  className?: string
} & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'role' | 'aria-busy' | 'aria-label'>

export function Skeleton({ label, className = 'h-4', ...rest }: SkeletonProps): ReactElement {
  return (
    <div
      {...rest}
      role="status"
      aria-busy="true"
      aria-label={label}
      className={`${className} animate-pulse rounded-md bg-surface-2`}
    />
  )
}
