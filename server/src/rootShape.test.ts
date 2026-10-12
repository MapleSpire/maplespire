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
import {
  ROOT_SHAPE_FIELDS,
  buildEmptyRootShape,
  copyRootShape,
  type WorkspaceRootShape,
} from './rootShape.js'

// Every field set, every value distinct — so a field dropped from the copy
// loop cannot hide behind a shared default.
const fullSource: Required<WorkspaceRootShape> = {
  modelUrl: 'automerge:2NfEPRV1awVEULnJRWDBSPaxZd4e',
  modelMetaUrl: 'automerge:4PEGVNPywgd47har7UezSo36zco1',
  shardUrls: ['automerge:2SYiG2XrfrJcpXKAUHPmxomFJ4PW', 'automerge:2dAXDzyxSuQwSs9Qe7dPT8C34Q3A'],
  registryWriteUrl: 'automerge:2dAXDzyxSuQwSs9Qe7dPT8C34Q3A',
  registrySummaryOnly: true,
  diagramCount: 12_345,
  sparseDraftBaseVersionId: 'parent-version',
  sparseDraftBaseRootUrl: 'automerge:3Gv8m8A7Ym5MCv71jGAXvfXZ47RC',
}

describe('copyRootShape', () => {
  it('round-trips every ROOT_SHAPE_FIELDS entry', () => {
    const copy = copyRootShape(fullSource, {})
    // Field by field, so the failure NAMES the dropped field if one is
    // removed from the copy loop.
    for (const field of ROOT_SHAPE_FIELDS) {
      expect(copy[field], `field ${field} must round-trip`).toEqual(fullSource[field])
    }
    expect(Object.keys(copy).sort()).toEqual([...ROOT_SHAPE_FIELDS].sort())
  })

  it('lets an override win over the source', () => {
    const copy = copyRootShape(fullSource, { diagramCount: 7, shardUrls: ['automerge:x'] })
    expect(copy.diagramCount).toBe(7)
    expect(copy.shardUrls).toEqual(['automerge:x'])
    expect(copy.registrySummaryOnly).toBe(true) // untouched fields still flow
  })

  it('an override key explicitly present but undefined REMOVES the field instead of falling back', () => {
    // forkRoot depends on this: a registryWriteUrl whose remap failed must not
    // fall back to the SOURCE's write head — that would share a document
    // between the source and the twin.
    const copy = copyRootShape(fullSource, { registryWriteUrl: undefined })
    expect(Object.prototype.hasOwnProperty.call(copy, 'registryWriteUrl')).toBe(false)
  })

  it('never emits a key outside the closed list (a corrupted source key does not propagate)', () => {
    const corrupted = { ...fullSource, legacyDiagrams: { d1: {} }, evil: 'x' }
    const copy = copyRootShape(corrupted as Partial<WorkspaceRootShape>, {})
    expect(Object.keys(copy).sort()).toEqual([...ROOT_SHAPE_FIELDS].sort())
  })

  it('drops undefined values entirely — Automerge rejects undefined map values', () => {
    const copy = copyRootShape(
      { modelUrl: 'automerge:m', shardUrls: [] },
      { registrySummaryOnly: undefined },
    )
    for (const value of Object.values(copy)) expect(value).not.toBeUndefined()
    expect(Object.keys(copy).sort()).toEqual(['modelUrl', 'shardUrls'])
  })

  it('returns a deep plain clone, never live references into the source', () => {
    const source = { modelUrl: '', shardUrls: ['automerge:a'] }
    const copy = copyRootShape(source, {})
    copy.shardUrls.push('automerge:b')
    expect(source.shardUrls).toEqual(['automerge:a'])
  })

  it('floors to the canonical empty root when both inputs are empty', () => {
    expect(copyRootShape(undefined, {})).toEqual({ modelUrl: '', shardUrls: [] })
  })
})

describe('buildEmptyRootShape', () => {
  it('is exactly the canonical empty root (mirrors the client emptyRootDoc)', () => {
    expect(buildEmptyRootShape()).toEqual({ modelUrl: '', shardUrls: [] })
  })
})

// The COMPILE-TIME pin (interface field missing from the list → does not
// compile) lives in rootShape.ts itself, as a `@ts-expect-error` self-test.
// It cannot live here: the server tsconfig excludes `src/**/*.test.ts` and
// vitest transpiles without typechecking, so a negative type assertion in this
// file would never be verified by anything.
