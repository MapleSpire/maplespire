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

import type { C4Type } from '../../types'
import type { FrameSnapshot, SnapshotConnection, WorkerToHost } from './snapshot'

/**
 * Render a faithful preview of a community theme by running it in a one-shot
 * sandbox worker (the only place untrusted theme code may execute) and reading
 * back an ImageBitmap. Used by the shop's Community tab. Returns null on
 * failure/timeout/unsupported so the UI can fall back gracefully.
 */

function sampleConnection(id: string, fx: number, fy: number, tx: number, ty: number): SnapshotConnection {
  const cp1x = fx + (tx - fx) * 0.5
  const cp2x = fx + (tx - fx) * 0.5
  return {
    id, type: 'solid',
    fromX: fx, fromY: fy, cp1x, cp1y: fy, cp2x, cp2y: ty, toX: tx, toY: ty,
    fromEdgeX: fx, fromEdgeY: fy, toEdgeX: tx, toEdgeY: ty,
    hovered: false, highlighted: false, alpha: 1,
  }
}

/** A small User → API → DB scene (with a group) laid out to fit the thumbnail. */
function buildSampleSnapshot(width: number, height: number, dpr: number, bg: string): FrameSnapshot {
  const objects = [
    { id: 'a', type: 'actor' as C4Type, name: 'User', x: 0, y: 34, w: 84, h: 56, cornerRadius: 8, selected: false, hovered: false, external: false, alpha: 1 },
    { id: 'b', type: 'system' as C4Type, name: 'API', x: 150, y: 20, w: 100, h: 64, cornerRadius: 8, selected: false, hovered: false, external: false, alpha: 1 },
    { id: 'c', type: 'store' as C4Type, name: 'DB', x: 312, y: 32, w: 84, h: 56, cornerRadius: 8, selected: false, hovered: false, external: false, alpha: 1 },
  ]
  const connections = [
    sampleConnection('ab', 84, 62, 150, 52),
    sampleConnection('bc', 250, 52, 312, 60),
  ]
  const groups = [
    { id: 'g', isParentWrapper: false, x: -14, y: 6, w: 424, h: 96, cornerRadius: 12, selected: false },
  ]
  // World content box, fit + center into the thumbnail.
  const cMinX = -14, cMaxX = 410, cMinY = 6, cMaxY = 102
  const pad = 10
  const scale = Math.min((width - pad * 2) / (cMaxX - cMinX), (height - pad * 2) / (cMaxY - cMinY))
  return {
    viewport: {
      x: width / 2 - ((cMinX + cMaxX) / 2) * scale,
      y: height / 2 - ((cMinY + cMaxY) / 2) * scale,
      scale,
    },
    dpr,
    canvas: { width, height },
    timeMs: 0,
    fastMode: false,
    bg,
    objects,
    groups,
    connections,
  }
}

export type ThumbnailResult = { bitmap: ImageBitmap } | { error: string }

/** Detailed variant — resolves a bitmap or the compile/run error message. */
export function renderThemeThumbnailDetailed(
  code: string,
  width: number,
  height: number,
  bg = '#0b1220',
): Promise<ThumbnailResult> {
  return new Promise((resolve) => {
    if (typeof OffscreenCanvas === 'undefined') {
      resolve({ error: 'This browser does not support OffscreenCanvas.' })
      return
    }
    let worker: Worker
    try {
      worker = new Worker(new URL('./themeWorker.ts', import.meta.url), { type: 'module' })
    } catch {
      resolve({ error: 'Could not start the theme sandbox.' })
      return
    }
    const dpr = window.devicePixelRatio || 1
    const finish = (result: ThumbnailResult) => {
      clearTimeout(timer)
      worker.terminate()
      resolve(result)
    }
    const timer = setTimeout(() => finish({ error: 'Timed out (the theme took too long).' }), 3000)
    worker.onmessage = (e: MessageEvent<WorkerToHost>) => {
      if (e.data.type === 'thumbnail') finish({ bitmap: e.data.bitmap })
      else if (e.data.type === 'error') finish({ error: e.data.message })
    }
    worker.onerror = (e) => finish({ error: e.message || 'Worker error' })
    worker.postMessage({
      type: 'thumbnail',
      code,
      width,
      height,
      dpr,
      snapshot: buildSampleSnapshot(width, height, dpr, bg),
    })
  })
}

export async function renderThemeThumbnail(
  code: string,
  width: number,
  height: number,
  bg = '#0b1220',
): Promise<ImageBitmap | null> {
  const result = await renderThemeThumbnailDetailed(code, width, height, bg)
  return 'bitmap' in result ? result.bitmap : null
}
