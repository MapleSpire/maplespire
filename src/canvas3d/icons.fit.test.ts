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

/**
 * Regression, defect 2026-10-18: the 3D technology-icon texture drew the logo
 * with drawImage(img, 0, 0, 128, 128), stretching a non-square logo into the
 * square. It must be aspect-fit and centred, like the 2D renderer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { techIconTexture } from './icons'

const drawImage = vi.fn()

class FakeImage {
  static created: FakeImage[] = []
  src = ''
  crossOrigin = ''
  naturalWidth = 0
  naturalHeight = 0
  onload: (() => void) | null = null
  constructor() {
    FakeImage.created.push(this)
  }
}

let contextSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  drawImage.mockClear()
  FakeImage.created = []
  vi.stubGlobal('Image', FakeImage)
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get: (_target, key) => (key === 'drawImage' ? drawImage : vi.fn()),
    set: () => true,
  })
  contextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
})

afterEach(() => {
  contextSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe('3D technology icon texture', () => {
  it('draws a wide logo aspect-fit and centred in the 128 px texture', () => {
    const tex = techIconTexture({
      icon: 'Wide Fit Test',
      iconAssignment: {
        source: 'generic', mode: 'explicit', displayName: 'Wide Fit Test',
        iconLightPath: '/icons/light/wide-fit-test.png',
      },
    })
    expect(tex).not.toBeNull()
    const image = FakeImage.created.find((img) => img.src === '/icons/light/wide-fit-test.png')
    expect(image, `requested: ${FakeImage.created.map((i) => i.src).join(', ')}`).toBeDefined()
    image!.naturalWidth = 400
    image!.naturalHeight = 100
    image!.onload?.()
    expect(drawImage).toHaveBeenCalledWith(image, 0, 48, 128, 32)
  })
})
