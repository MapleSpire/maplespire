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

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "icon"
  size?: "sm" | "md" | "lg"
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center gap-1.5 font-medium transition-all duration-150 rounded-md cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed",
          {
            "bg-inverse text-on-inverse hover:bg-inverse-hover active:bg-inverse": variant === "primary",
            "bg-surface-100 text-fg border border-line hover:bg-surface-50 active:bg-surface-200": variant === "secondary",
            "bg-transparent text-fg-secondary hover:bg-surface-hover hover:text-fg": variant === "ghost",
            "bg-error-bg text-error-text hover:opacity-80": variant === "danger",
            "bg-transparent text-fg-secondary hover:bg-surface-hover hover:text-fg p-1.5": variant === "icon",
          },
          {
            "h-7 px-2 text-xs": size === "sm",
            "h-8 px-3 text-[13px]": size === "md",
            "h-9 px-4 text-sm": size === "lg",
          },
          className
        )}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button }
