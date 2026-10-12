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

import * as React from "react"
import { cn } from "../../lib/utils"

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

/** Design-system text input — the exact field style the login page introduced
 * (dense 13px, hairline border, soft accent focus ring), factored out so every
 * form uses one source of truth. */
const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, ...props }, ref) => {
  return (
    <input
      ref={ref}
      className={cn(
        "h-9 rounded-md border border-line bg-surface-50 px-3 text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-40",
        className
      )}
      {...props}
    />
  )
})
Input.displayName = "Input"

export { Input }
