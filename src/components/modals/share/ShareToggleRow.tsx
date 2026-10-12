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

import type { ReactNode } from 'react'
import { HelpCircle } from 'lucide-react'
import { Switch } from '../../ui/switch'

export interface ShareToggleRowProps {
  label: string
  badge?: ReactNode
  /** Shown as a native tooltip on a (?) icon. */
  help?: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  /** Stable hook for E2E — every label here is translated copy. */
  testid?: string
}

/** A labelled row: switch + label (+ optional badge / help icon). Mirrors the
 * two toggles in the Share modal. */
export function ShareToggleRow({ label, badge, help, checked, onChange, disabled, testid }: ShareToggleRowProps) {
  return (
    <div className="flex items-center gap-2 py-1">
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} aria-label={label} data-testid={testid} />
      <span className="text-[13px] text-fg">{label}</span>
      {badge}
      {help && (
        <span title={help} className="cursor-help text-fg-subtle" aria-label={help}>
          <HelpCircle className="h-3.5 w-3.5" />
        </span>
      )}
    </div>
  )
}
