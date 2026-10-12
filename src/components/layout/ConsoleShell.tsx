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

import { Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'

/**
 * Shared shell for the router-based admin consoles (Org admin, Platform admin) so
 * they read as siblings of the workspace pages (Model objects / Connections /
 * Drafts) instead of an older docked-nav layout:
 *
 * - a floating **rounded-20** left nav panel, inset 14px, `border-line` + the DS
 *   `--shadow-xl` (same chrome as WorkspaceShell's nav) — NOT a hard `border-r`;
 * - a full-height content plane whose content clears the sidebar via `--pad-l`;
 * - a 40px footer bar carrying the console identity.
 *
 * The content backdrop stays `bg-app` (warm stone) because the console pages are
 * card dashboards — surface-100 cards need the warm plane to read (the workspace
 * table pages sit on a surface-100 plane instead). The root does NOT clip, so the
 * floating panel's shadow halo isn't cut (same rule as the editor/workspace shells).
 */

export interface ConsoleNavItem {
  to: string
  params?: Record<string, string>
  label: string
  Icon: React.ElementType
  active: boolean
}

interface ConsoleShellProps {
  /** Panel header title — the org's name, or "Platform". */
  title: string
  /** Optional second line under the title (mono id, or a short descriptor). */
  subtitle?: React.ReactNode
  /** Optional distinct signal in the header (e.g. the Platform-admin badge). */
  signal?: React.ReactNode
  nav: ConsoleNavItem[]
  /** Left side of the footer bar (console identity). */
  footer?: React.ReactNode
  children: React.ReactNode
}

const PAD_L = 334 // 14 (inset) + 312 (panel) + 8 (gap)

export function ConsoleShell({ title, subtitle, signal, nav, footer, children }: ConsoleShellProps) {
  const { t } = useTranslation()
  return (
    <div
      className="relative h-full min-h-screen w-full bg-app text-fg"
      style={{ '--pad-l': `${PAD_L}px` } as React.CSSProperties}
    >
      {/* Content plane + footer (content padded to clear the floating nav). */}
      <div className="absolute inset-0 flex flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto" style={{ paddingLeft: 'var(--pad-l)' }}>
          {children}
        </div>
        <div
          className="flex h-10 shrink-0 items-center gap-3 border-t border-line bg-surface-100 text-[11px] text-fg-subtle"
          style={{ paddingLeft: 'var(--pad-l)', paddingRight: '20px' }}
        >
          {footer}
        </div>
      </div>

      {/* Floating rounded-20 left nav — the workspace-shell sidebar chrome. */}
      <aside className="absolute bottom-3.5 left-3.5 top-3.5 z-30 flex w-[312px] flex-col overflow-hidden rounded-[20px] border border-line bg-surface-100 shadow-xl">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line pl-3 pr-3.5">
          <Link
            to="/app"
            title={t('layoutChrome.consoleShell.backToApp')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Link>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-fg" title={title}>
              {title}
            </p>
            {subtitle && <p className="truncate text-[10px] text-fg-subtle">{subtitle}</p>}
          </div>
          {signal}
        </div>

        <nav className="flex flex-col gap-0.5 p-2">
          {nav.map((item) => {
            const Icon = item.Icon
            return (
              <Link
                key={item.to}
                to={item.to}
                params={item.params}
                className={cn(
                  'flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13px] font-medium transition-colors',
                  item.active
                    ? 'bg-accent-subtle text-accent'
                    : 'text-fg-secondary hover:bg-surface-hover hover:text-fg'
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            )
          })}
        </nav>
      </aside>
    </div>
  )
}
