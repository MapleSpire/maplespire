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

import { describe, expect, it, vi } from 'vitest'
import { clipGroupAccentToBox, clipObjectAccentToBox } from './objectBox'

type RecordedCall = [string, ...number[]]

function recordingContext() {
  const calls: RecordedCall[] = []
  const record = (name: string) => (...args: number[]) => calls.push([name, ...args])
  const ctx = {
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arcTo: record('arcTo'),
    ellipse: record('ellipse'),
    closePath: record('closePath'),
    clip: vi.fn(() => calls.push(['clip'])),
  } as unknown as CanvasRenderingContext2D

  return { ctx, calls }
}

describe('clipObjectAccentToBox', () => {
  it('clips a 2D accent bar to the exact rounded object silhouette', () => {
    const { ctx, calls } = recordingContext()

    clipObjectAccentToBox(ctx, {
      x: 12.5,
      y: 20.25,
      w: 180,
      h: 96,
      cornerRadius: 14,
      isStore: false,
    })

    expect(calls).toEqual([
      ['beginPath'],
      ['moveTo', 26.5, 20.25],
      ['lineTo', 178.5, 20.25],
      ['arcTo', 192.5, 20.25, 192.5, 34.25, 14],
      ['lineTo', 192.5, 102.25],
      ['arcTo', 192.5, 116.25, 178.5, 116.25, 14],
      ['lineTo', 26.5, 116.25],
      ['arcTo', 12.5, 116.25, 12.5, 102.25, 14],
      ['lineTo', 12.5, 34.25],
      ['arcTo', 12.5, 20.25, 26.5, 20.25, 14],
      ['closePath'],
      ['clip'],
    ])
  })
})

describe('clipGroupAccentToBox', () => {
  it('clips a group accent bar to the exact 12px group silhouette', () => {
    const { ctx, calls } = recordingContext()

    clipGroupAccentToBox(ctx, {
      x: 40,
      y: 60,
      w: 240,
      h: 160,
      cornerRadius: 12,
    })

    expect(calls).toEqual([
      ['beginPath'],
      ['moveTo', 52, 60],
      ['lineTo', 268, 60],
      ['arcTo', 280, 60, 280, 72, 12],
      ['lineTo', 280, 208],
      ['arcTo', 280, 220, 268, 220, 12],
      ['lineTo', 52, 220],
      ['arcTo', 40, 220, 40, 208, 12],
      ['lineTo', 40, 72],
      ['arcTo', 40, 60, 52, 60, 12],
      ['closePath'],
      ['clip'],
    ])
  })
})
