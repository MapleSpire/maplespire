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

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as A from '@automerge/automerge'
import * as browser from './modelMetaUrls'
import { planBfsWriteMode, planOverlayWriteHeads } from './overlayWriteHead'

/**
 * G4-16f: the browser's copy of `server/src/modelMetaUrls.ts` (the
 * server's `rootDir` forbids a shared import). Since the in-place cut-over was
 * removed (with model epochs) the two files
 * are IDENTICAL, byte for byte. Compared as TEXT, so any drift — a field
 * name, the element reader, the edit — goes red here, not in production.
 */
const here = dirname(fileURLToPath(import.meta.url))

describe('modelMetaUrls: browser copy = server copy', () => {
  it('byte for byte', () => {
    const server = readFileSync(join(here, '../../../server/src/modelMetaUrls.ts'), 'utf8')
    const client = readFileSync(join(here, 'modelMetaUrls.ts'), 'utf8')
    expect(client).toBe(server)
  })

  it('no write cuts a text document over, whatever its process environment says (the switch is gone)', () => {
    process.env.AM_META_URL_SCALAR = 'on'
    try {
      expect('scalarSwitchOn' in browser).toBe(false)
      const doc = A.change(A.from<Record<string, unknown>>({ objectShardUrls: ['a'] }), (d) => {
        browser.appendMetaUrl(d, 'objectShardUrls', 'b')
        browser.writeMetaUrl(d, 'editsObjectShardUrl', 'b')
      })
      expect(doc.metaUrlFormat).toBeUndefined()
      expect(doc.objectShardRefs).toBeUndefined()
      expect(doc.objectShardUrls).toEqual(['a', 'b'])
    } finally {
      delete process.env.AM_META_URL_SCALAR
    }
  })

  it('the browser follows a marker it did not set', () => {
    const doc = A.change(A.from<Record<string, unknown>>({ objectShardUrls: ['a'] }), (d) => {
      browser.adoptScalarMetaUrls(d)
      browser.appendMetaUrl(d, 'objectShardUrls', 'b')
    })
    expect(doc.objectShardUrls).toEqual(['a'])
    expect(browser.readMetaUrls(doc, 'objectShardUrls')).toEqual(['a', 'b'])
  })
})

describe('the browser write-mode planners read scalar heads (an old build sends them to bfs-degraded)', () => {
  const head = 'automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ'
  const conn = 'automerge:3j9knpCseyhnK8izDmLpGP5WMdZQ'
  const scalarMeta = A.from<Record<string, unknown>>({
    metaUrlFormat: 2,
    editsOverlayWriteHeadVersion: 1,
    // Frozen text heads, deliberately different from the ruling scalars.
    editsObjectShardUrl: 'automerge:frozen',
    editsConnectionShardUrl: 'automerge:frozen',
    editsObjectShardRef: new A.ImmutableString(head),
    editsConnectionShardRef: new A.ImmutableString(conn),
    editsObjectShardRefs: [new A.ImmutableString(head)],
    editsConnectionShardRefs: [new A.ImmutableString(conn)],
  })
  const valid = (url: string) => url.startsWith('automerge:') && url.length > 30

  it('planBfsWriteMode: bfs on the scalar heads', () => {
    expect(planBfsWriteMode(scalarMeta as never, valid)).toEqual({ mode: 'bfs' })
  })

  it('planOverlayWriteHeads: the scalar heads, not the frozen text', () => {
    const plan = planOverlayWriteHeads(scalarMeta as never, valid)
    expect(plan.objectUrl).toBe(head)
    expect(plan.connectionUrl).toBe(conn)
  })
})
