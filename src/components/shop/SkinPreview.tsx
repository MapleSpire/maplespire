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

import { useRef, useEffect, useState } from 'react'
import type { SkinConfig } from '../../skins/types'
import { renderSkinPreview } from './previewRenderer'

interface SkinPreviewProps {
  skin: SkinConfig
  /** Width / height ratio of the preview area. */
  aspectRatio?: number
  animate?: boolean
}

/**
 * Responsive theme preview — fills the width of its container and renders the
 * sample scene scaled to fit (so every theme reads the same regardless of card
 * size). The renderer (previewRenderer) draws into CSS-pixel space; we track the
 * measured size and dpr here.
 */
export function SkinPreview({ skin, aspectRatio = 16 / 9, animate = true }: SkinPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = (w: number) => setSize({ w, h: w / aspectRatio })
    update(el.clientWidth)
    const ro = new ResizeObserver((entries) => update(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [aspectRatio])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.w < 1) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)

    const draw = (time: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      renderSkinPreview(ctx, skin, time, size.w, size.h)
    }

    if (!animate) {
      draw(0)
      return
    }
    const start = performance.now()
    const loop = (now: number) => {
      draw(now - start)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [skin, size, animate])

  return (
    <div ref={containerRef} style={{ width: '100%', aspectRatio: String(aspectRatio) }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  )
}
