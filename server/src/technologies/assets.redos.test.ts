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

import { describe, expect, it } from 'vitest'
import { startsWithSvgRoot, validateTechnologyIcon } from './assets.js'

/**
 * The root check runs FIRST, before every size and complexity ceiling, on the
 * whole decoded body of an upload — and Node evaluates it synchronously on the
 * one event loop. A superlinear implementation there is not a slow validator,
 * it is a fleet-wide outage from a sub-kilobyte request.
 */
describe('SVG root detection is linear', () => {
  it('rejects a pathological comment run in milliseconds, not minutes', () => {
    // The old regex `(?:<!--[\s\S]*?-->\s*)*<svg` backtracked exponentially over
    // a comment run NOT followed by <svg. Measured against it: 140 bytes 46 ms,
    // 196 bytes 1.2 s, ~240 bytes over a minute — each token roughly doubling.
    // 64 tokens would have been astronomically worse than any of those.
    const payload = '<!---->'.repeat(64)
    const started = performance.now()
    expect(startsWithSvgRoot(payload)).toBe(false)
    const elapsed = performance.now() - started
    // Two orders of magnitude below the old 28-token time, on an input more
    // than twice as long.
    expect(elapsed).toBeLessThan(50)
  })

  it('stays fast through the whole upload validator, not just the helper', () => {
    const payload = Buffer.from('<!---->'.repeat(64))
    const started = performance.now()
    expect(() => validateTechnologyIcon(payload, 'image/svg+xml')).toThrow(/<svg> root/)
    expect(performance.now() - started).toBeLessThan(100)
  })

  it('still accepts the prologs a real icon has', () => {
    expect(startsWithSvgRoot('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe(true)
    expect(startsWithSvgRoot('<svg>')).toBe(true)
    expect(startsWithSvgRoot('<svg/>')).toBe(true)
    expect(startsWithSvgRoot('\uFEFF  <svg >')).toBe(true)
    expect(startsWithSvgRoot('<?xml version="1.0"?>\n<svg >')).toBe(true)
    expect(startsWithSvgRoot('<?xml version="1.0"?>\n<!-- Generator -->\n<svg >')).toBe(true)
    expect(startsWithSvgRoot('<!-- a --> <!-- b --> <svg >')).toBe(true)
  })

  it('still rejects what is not an svg root', () => {
    expect(startsWithSvgRoot('<html><svg></svg></html>')).toBe(false)
    expect(startsWithSvgRoot('<svgfoo>')).toBe(false)
    expect(startsWithSvgRoot('<!-- unterminated <svg >')).toBe(false)
    expect(startsWithSvgRoot('<?xml unterminated <svg >')).toBe(false)
    expect(startsWithSvgRoot('')).toBe(false)
    expect(startsWithSvgRoot('<svg')).toBe(false)
    // Past the prolog ceiling: a logo does not open with 33 comments.
    expect(startsWithSvgRoot(`${'<!---->'.repeat(33)}<svg >`)).toBe(false)
  })
})

describe('sanitizer deny-list gaps', () => {
  const reject = (svg: string, pattern: RegExp) =>
    expect(() => validateTechnologyIcon(Buffer.from(svg), 'image/svg+xml')).toThrow(pattern)

  it('rejects XML Events <handler>, which the element list used to miss', () => {
    reject(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:ev="http://www.w3.org/2001/xml-events">'
      + '<handler ev:event="load" type="application/ecmascript">alert(1)</handler></svg>',
      /active or externally loaded/,
    )
  })

  it('rejects a slash-separated event handler', () => {
    // `\son[a-z]+=` required leading WHITESPACE; a tag may separate attributes
    // with a slash, so this form walked past it.
    reject(
      '<svg xmlns="http://www.w3.org/2000/svg"/onload="alert(1)"><path d="M0 0"/></svg>',
      /active or externally loaded/,
    )
  })

  it('still accepts an ordinary logo', () => {
    expect(validateTechnologyIcon(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
        + '<path d="M1 1h14v14H1z" fill="#2b7"/></svg>'),
      'image/svg+xml',
    )).toEqual({ contentType: 'image/svg+xml', extension: 'svg' })
  })
})
