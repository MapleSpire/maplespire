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

import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

const gzipAsync = promisify(gzip)
const encodedBodies = new WeakMap<object, Promise<Buffer>>()

/** Cache gzip by serialized payload identity. DiagramRenderCache deliberately
 * reuses the same value object for L1 hits and coalesced misses, so one burst
 * performs one async compression instead of queueing one libuv job per client.
 * Weak keys make eviction follow the render cache without a second LRU. */
export function gzipSerializedBody(value: object, body: string): Promise<Buffer> {
  const cached = encodedBodies.get(value)
  if (cached) return cached
  const running = gzipAsync(body).catch((error) => {
    encodedBodies.delete(value)
    throw error
  })
  encodedBodies.set(value, running)
  return running
}
