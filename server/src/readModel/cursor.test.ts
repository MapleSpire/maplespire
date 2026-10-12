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

import { afterEach, describe, expect, it } from 'vitest'
import {
  ReadModelCursorError,
  decodeReadModelCursor,
  encodeReadModelCursor,
  readModelQueryHash,
} from './cursor.js'

const previousSecret = process.env.AUTH_SECRET
afterEach(() => {
  if (previousSecret === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = previousSecret
})
describe('signed read-model cursors', () => {
  it('round-trips only for the bound query contract', () => {
    process.env.AUTH_SECRET = 'cursor-test-secret'
    const queryHash = readModelQueryHash({ q: 'checkout', workspace: 'a::b' })
    const cursor = encodeReadModelCursor({ kind: 'objects', queryHash, score: 3, name: 'checkout', id: 'o1' })
    expect(decodeReadModelCursor(cursor, { kind: 'objects', queryHash })).toMatchObject({ id: 'o1', score: 3 })
    expect(() => decodeReadModelCursor(cursor, { kind: 'objects', queryHash: 'other' })).toThrow(ReadModelCursorError)
  })

  it('rejects tampering', () => {
    process.env.AUTH_SECRET = 'cursor-test-secret'
    const queryHash = 'q'
    const cursor = encodeReadModelCursor({ kind: 'tree', queryHash, name: 'a', id: '1' })
    expect(() => decodeReadModelCursor(`${cursor}x`, { kind: 'tree', queryHash })).toThrow(ReadModelCursorError)
  })
})
