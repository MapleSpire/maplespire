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

import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { gzipSerializedBody } from './serializedGzipCache.js'

describe('serialized gzip cache', () => {
  it('coalesces concurrent encodes for one cached value identity', async () => {
    const value = { body: JSON.stringify({ rows: Array(1_000).fill('same payload') }) }
    const first = gzipSerializedBody(value, value.body)
    const second = gzipSerializedBody(value, value.body)

    expect(second).toBe(first)
    const encoded = await first
    expect(gunzipSync(encoded).toString('utf8')).toBe(value.body)
  })

  it('does not alias distinct cache values that happen to have the same body', async () => {
    const body = '{"ok":true}'
    const first = gzipSerializedBody({ body }, body)
    const second = gzipSerializedBody({ body }, body)

    expect(second).not.toBe(first)
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })
})
