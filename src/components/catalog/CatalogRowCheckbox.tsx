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

import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * Staged/not-staged indicator for a catalog row in multi-select mode.
 *
 * Deliberately NOT `SelectionCheckbox`: that primitive renders a real
 * `<input type="checkbox">`, and interactive content nested inside a `<button>`
 * is invalid HTML. The row itself is the button and carries `aria-pressed`, so
 * this is presentation only — hence `aria-hidden`.
 *
 * The unchecked border is `fg-muted`, not `line`. `--color-line` against a row
 * is 1.2:1, which fails WCAG 1.4.11 for a control whose state has to be
 * identifiable — and this box is the only thing that tells the user the picker
 * is in multi-select mode at all.
 */
export function CatalogRowCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
        checked ? 'border-accent bg-accent text-accent-text' : 'border-fg-muted bg-surface-50',
      )}
    >
      {checked && <Check className="h-3 w-3" />}
    </span>
  )
}
