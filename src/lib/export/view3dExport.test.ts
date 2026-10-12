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

// @vitest-environment jsdom
// The export barrel pulls the store/automerge chain, which touches `window` at
// DEV module load — so this browser-side wiring test runs under jsdom.
import { beforeAll, afterEach, describe, expect, it } from 'vitest'
import type { Diagram } from '../../types'
import type { ExportBundle } from './types'
import { exportFileName } from './index'
import { renderView3dPngBlob } from './image'
import { setActiveScene3D, getActiveScene3D, type Capturable3DScene } from '../../canvas3d/activeScene'
import i18n from '../i18n'

// Error copy is pulled from i18next (locale-detected) — pin English so the throw
// assertion is deterministic on any machine (the off-environment stability rule).
beforeAll(async () => {
  await i18n.changeLanguage('en')
})

afterEach(() => setActiveScene3D(null))

function bundle(): ExportBundle {
  const diagrams: Diagram[] = [
    { id: 'd1', name: 'Storefront · Context', type: 'context', objectIds: [], connectionIds: [], groupIds: [] },
  ]
  return {
    landscapeName: 'Acme',
    generatedAt: '',
    diagrams,
    activeDiagramId: 'd1',
    flowsByDiagram: {},
    objects: [],
    connections: [],
    groups: [],
    domains: [],
    tags: [],
    decisionRecords: [],
  }
}

describe('activeScene registry (P6.0 — export reaches the live 3D board)', () => {
  it('registers and clears the mounted scene', () => {
    expect(getActiveScene3D()).toBeNull()
    const scene: Capturable3DScene = { capturePng: () => new Blob() }
    setActiveScene3D(scene)
    expect(getActiveScene3D()).toBe(scene)
    setActiveScene3D(null)
    expect(getActiveScene3D()).toBeNull()
  })
})

describe('renderView3dPngBlob (live GL readback wiring)', () => {
  it('throws a friendly error when no 3D board is mounted', () => {
    expect(() => renderView3dPngBlob(2)).toThrow('Open the 3D view before exporting it')
  })

  it('captures the live scene at the requested scale', () => {
    const calls: number[] = []
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    setActiveScene3D({
      capturePng: (scale?: number) => {
        calls.push(scale ?? -1)
        return png
      },
    })
    const out = renderView3dPngBlob(3)
    expect(out).toBe(png)
    expect(calls).toEqual([3])
  })
})

describe('exportFileName — 3D PNG gets a -3d suffix so it never collides with the 2D PNG', () => {
  it('suffixes the 3D capture', () => {
    expect(exportFileName({ type: 'png', theme: 'light', source: '3d' }, bundle())).toBe('storefront-context-3d.png')
  })
  it('leaves the 2D PNG and SVG unsuffixed', () => {
    expect(exportFileName({ type: 'png', theme: 'light', source: '2d' }, bundle())).toBe('storefront-context.png')
    expect(exportFileName({ type: 'png', theme: 'light' }, bundle())).toBe('storefront-context.png')
    expect(exportFileName({ type: 'svg', theme: 'light' }, bundle())).toBe('storefront-context.svg')
  })
})
