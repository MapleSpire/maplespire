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

import { useThemeStore } from '../../stores/themeStore'

interface BrandMarkProps {
  className?: string
  size?: number
}

export function BrandMark({ className, size = 32 }: BrandMarkProps) {
  const theme = useThemeStore((state) => state.resolved)
  const width = Math.round(size * (122 / 140))

  return (
    <img
      src={theme === 'dark' ? '/brand/maplespire-mark-dark.svg' : '/brand/maplespire-mark.svg'}
      alt=""
      aria-hidden="true"
      width={width}
      height={size}
      className={['block shrink-0', className].filter(Boolean).join(' ')}
    />
  )
}
