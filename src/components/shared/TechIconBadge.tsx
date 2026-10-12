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

import { useEffect, useState } from 'react'
import type { IconDefinition } from '../../lib/techIcons'
import { resolveTechnologyIconPath } from '../../lib/technologies/iconPath'
import { useThemeStore } from '../../stores/themeStore'

interface TechIconBadgeProps {
  name: string
  size?: 'sm' | 'md' | 'lg'
  iconLightPath?: string
  iconDarkPath?: string
  /** Allow the legacy built-in catalog fallback. Governed catalog views turn
   * this off so opening them never downloads the generic icon bundle. */
  allowCatalogFallback?: boolean
  /** Hide the artwork from assistive technology when an adjacent label names it. */
  decorative?: boolean
}

export function TechIconBadge({
  name,
  size = 'md',
  iconLightPath,
  iconDarkPath,
  allowCatalogFallback = false,
  decorative = false,
}: TechIconBadgeProps) {
  const resolvedTheme = useThemeStore((state) => state.resolved)
  const [failedPath, setFailedPath] = useState<string | null>(null)
  const [icon, setIcon] = useState<IconDefinition | null>(null)

  useEffect(() => {
    if (!allowCatalogFallback || iconLightPath || iconDarkPath) {
      setIcon(null)
      return
    }
    let active = true
    void import('../../lib/techIcons').then(({ getIconByName }) => {
      if (active) setIcon(getIconByName(name) ?? null)
    })
    return () => { active = false }
  }, [allowCatalogFallback, iconDarkPath, iconLightPath, name])
  const bg = icon?.bg ?? '#94A3B8'
  const text = icon?.text ?? '#FFFFFF'
  const abbr = icon?.abbr ?? (name.length <= 2 ? name : name.charAt(0))
  const dims = size === 'sm'
    ? 'w-4 h-4 text-[8px]'
    : size === 'lg'
      ? 'w-8 h-8 text-[11px]'
      : 'w-5 h-5 text-[9px]'
  const snapshotPath = resolveTechnologyIconPath(resolvedTheme, iconLightPath, iconDarkPath)
  const imagePath = snapshotPath ?? (resolvedTheme === 'dark'
    ? icon?.iconDark ?? icon?.iconLight
    : icon?.iconLight ?? icon?.iconDark)

  useEffect(() => {
    const retryAfterReconnect = () => setFailedPath(null)
    window.addEventListener('online', retryAfterReconnect)
    return () => window.removeEventListener('online', retryAfterReconnect)
  }, [])

  if (imagePath && failedPath !== imagePath) {
    return (
      <img
        src={imagePath}
        alt={decorative ? '' : name}
        aria-hidden={decorative || undefined}
        className={`rounded object-contain ${dims}`}
        loading="lazy"
        onError={() => setFailedPath(imagePath)}
      />
    )
  }

  return (
    <span
      aria-hidden={decorative || undefined}
      className={`inline-flex items-center justify-center rounded font-bold ${dims}`}
      style={{ backgroundColor: bg, color: text }}
    >
      {abbr}
    </span>
  )
}
