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

import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

/** Design-system `Kbd`: a keyboard hint chip in JetBrains Mono on a soft inset
 *  surface. One combo per chip; modifiers as plain words or symbols. Styled by
 *  `.ms-kbd` in index.css (the kit's exact 3px/5px padding is off the Tailwind
 *  spacing scale the lint rule allows). */
export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cn('ms-kbd', className)} {...rest} />
}
