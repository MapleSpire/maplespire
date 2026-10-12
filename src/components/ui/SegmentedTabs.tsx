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

import { cn } from '../../lib/utils'

export interface SegmentedTab<T extends string> {
  id: T
  label: string
  testid?: string
  badge?: React.ReactNode
}

// The design draws the control in two sizes: the left panel (Shapes/Flows) uses
// an 11px track / 8px pill / 12.5px text; the right panel (Details/Connections)
// uses a slightly tighter 10px / 7px / 12px. The 3px gap + 3px padding are
// off the 4px spacing scale, so they go through inline style (eslint forbids the
// arbitrary `gap-[3px]` utility form).
//
// RADIUS RULE (design-system ruling): a segmented control's track radius is
// DERIVED — pill radius + track padding (md: 8+3=11, sm: 7+3=10) — so the pill
// sits optically concentric inside the track. These are the only sanctioned
// radii outside the global ladder; don't "fix" them to a ladder step.
const SIZES = {
  md: { track: 'rounded-[11px]', pill: 'rounded-[8px]', text: 'text-[12.5px]' },
  sm: { track: 'rounded-[10px]', pill: 'rounded-[7px]', text: 'text-[12px]' },
} as const

/**
 * The design's segmented pill tab control: a tinted track with a raised active
 * pill. Shared by the left sidebar (Shapes/Flows) and the right sidebar
 * (Properties/Comments, Details/Connections) so they all read identically.
 */
export function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
  size = 'md',
  className,
}: {
  tabs: SegmentedTab<T>[]
  value: T
  onChange: (id: T) => void
  size?: keyof typeof SIZES
  className?: string
}) {
  const s = SIZES[size]
  return (
    <div style={{ gap: 3, padding: 3 }} className={cn('flex bg-surface-200', s.track, className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          data-testid={t.testid}
          onClick={() => onChange(t.id)}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 py-1.5 font-semibold transition-colors',
            s.text,
            s.pill,
            value === t.id ? 'bg-surface-100 text-fg shadow-sm' : 'text-fg-subtle hover:text-fg-secondary'
          )}
        >
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  )
}
