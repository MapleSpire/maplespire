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

/** A Details-panel row: label on the left, value on the right. */
export function FieldRow({
  label,
  children,
  align = 'center',
}: {
  label: string
  children: React.ReactNode
  // `top` first-line-aligns the label with multi-line / wrapping values (e.g. a
  // flex-wrap chip cloud) instead of centering it against the whole block.
  align?: 'center' | 'top'
}) {
  const items = align === 'top' ? 'items-start' : 'items-center'
  return (
    <div className={cn('flex justify-between', items)}>
      <span className="text-[12px] text-fg-subtle">{label}</span>
      <div className={cn('flex', items)}>{children}</div>
    </div>
  )
}
