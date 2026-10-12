// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Olivier Albertini
//
// This file is part of MapleSpire.
// MapleSpire is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// MapleSpire is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.

import * as React from 'react'
import { cn } from '../../lib/utils'

export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Optional leading icon (lucide), rendered at 12px. */
  icon?: React.ComponentType<{ className?: string }>
  /** `xs` = text-[10px] (tag/tech labels), `sm` = text-[11px] (level/type pills). */
  size?: 'xs' | 'sm'
  /** Adds the surface-200 hairline border used by the level/type pills. */
  bordered?: boolean
  /** `pill` = rounded-full (default), `rect` = soft rounded-md used by C4-level chips. */
  shape?: 'pill' | 'rect'
}

/**
 * Neutral pill chip — one source of truth for the rounded-full `bg-surface-200`
 * label so the neutral pills (diagram level, diagram type, technology tags, …)
 * share exactly one shape, padding and font rhythm.
 *
 * Data-coloured chips (per-tag colour) intentionally stay bespoke for now; this
 * primitive covers the neutral surface pills. See badge.tsx for semantic-tone
 * status pills.
 */
export const Chip = React.forwardRef<HTMLSpanElement, ChipProps>(
  ({ icon: Icon, size = 'sm', bordered = false, shape = 'pill', className, children, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1.5 bg-surface-200 px-2 py-0.5 font-medium text-fg-secondary',
        shape === 'rect' ? 'rounded-md' : 'rounded-full',
        size === 'xs' ? 'text-[10px]' : 'text-[11px]',
        bordered && 'border border-line',
        className
      )}
      {...props}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {children}
    </span>
  )
)
Chip.displayName = 'Chip'
