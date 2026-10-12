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

/**
 * Canonical deterministic PRNG for the rendering engine and theme plugins.
 *
 * The algorithm (cyrb128 hash → sfc32 generator) and the shared `seedCache`
 * MUST NOT change: seeded geometry (imperfect paths, scratch overlays, group
 * texture) depends on producing bit-identical sequences. The Theme SDK exposes
 * this through `RenderContext.rng(seedKey)` so official and community themes get
 * the exact same noise the engine used when the effects were inlined.
 */

// Seeds are cached so repeated lookups for the same key are stable & cheap.
const seedCache = new Map<string, number>()

function cyrb128(str: string): number {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i)
    h1 ^= k
    h2 ^= k << 8
    h3 ^= k << 16
    h4 ^= k << 24
    h1 = (h1 << 13 | h1 >>> 19) + h2 | 0
    h2 = (h2 << 17 | h2 >>> 15) + h3 | 0
    h3 = (h3 << 5 | h3 >>> 27) + h4 | 0
    h4 = (h4 << 9 | h4 >>> 23) + h1 | 0
  }
  h1 = (h1 ^ h1 >>> 16) >>> 0
  return h1
}

function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0
    let t = (a + b) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    d = (d + 1) | 0
    t = (t + d) | 0
    c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }
}

export function createRng(seed: string): () => number {
  let s = seedCache.get(seed)
  if (s === undefined) {
    s = cyrb128(seed)
    seedCache.set(seed, s)
  }
  return sfc32(s, s + 12345, s + 67890, s + 99999)
}
