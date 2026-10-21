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

import { useLayoutEffect, useRef, useState } from 'react'

/**
 * Keeps a context menu inside the viewport. The menu is measured after mount
 * and its position is nudged so it never overflows the right/bottom (or top/left)
 * edges of the window. Returns a ref to attach to the menu element and the
 * clamped left/top to apply.
 */
export function useClampedMenuPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 8
    const { width, height } = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = x
    let top = y
    if (left + width > vw - margin) left = Math.max(margin, vw - width - margin)
    if (top + height > vh - margin) top = Math.max(margin, vh - height - margin)
    setPos({ left, top })
  }, [x, y])

  return { ref, pos }
}
