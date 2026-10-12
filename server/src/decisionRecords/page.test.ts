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
import { readDecisionRecordDetail, readDecisionRecordPage } from './page.js'

const adr = (number: number) => ({
  id: `adr-${number}`, number, title: `ADR ${number}`, summary: '',
  status: 'approved' as const, author: 'Seed', createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z', content: '', related: [],
})

describe('decision record pages', () => {
  it('opens only the shards intersecting a bounded page', async () => {
    const docs = new Map<string, unknown>([
      ['meta', {
        decisionRecordShardUrls: ['s0', 's1', 's2'],
        decisionRecordCount: 6,
        decisionRecordShardSize: 2,
        decisionRecords: { 'adr-3': { ...adr(3), title: 'Edited' } },
        deletedDecisionRecordIds: ['adr-4'],
      }],
      ['s0', { decisionRecords: { 'adr-1': adr(1), 'adr-2': adr(2) } }],
      ['s1', { decisionRecords: { 'adr-3': adr(3), 'adr-4': adr(4) } }],
      ['s2', { decisionRecords: { 'adr-5': adr(5), 'adr-6': adr(6) } }],
    ])
    const resolved: string[] = []
    const page = await readDecisionRecordPage(
      { modelMetaUrl: 'meta' },
      async (url) => { resolved.push(url); return docs.get(url) },
      2,
      2,
    )

    expect(resolved).toEqual(['meta', 's1'])
    expect(page).toMatchObject({ paged: true, total: 5, offset: 2, limit: 2, nextOffset: 4 })
    expect(page?.items.map((item) => [item.id, item.title])).toEqual([['adr-3', 'Edited']])
  })

  it('keeps ordinary inline workspaces backward compatible', async () => {
    const page = await readDecisionRecordPage(
      { modelUrl: 'model' },
      async () => ({ decisionRecords: { 'adr-1': adr(1), 'adr-2': adr(2) } }),
      1,
      1,
    )
    expect(page).toMatchObject({ paged: false, total: 2, nextOffset: null })
    expect(page?.items[0].id).toBe('adr-2')
  })

  it('resolves overlay details first and respects ADR tombstones', async () => {
    const docs = new Map<string, unknown>([
      ['meta', {
        decisionRecordShardUrls: ['s0'],
        decisionRecords: { 'adr-1': { ...adr(1), title: 'Edited detail' } },
        deletedDecisionRecordIds: ['adr-2'],
      }],
      ['s0', { decisionRecords: { 'adr-1': adr(1), 'adr-2': adr(2) } }],
    ])
    const resolved: string[] = []
    const resolve = async (url: string) => { resolved.push(url); return docs.get(url) }

    await expect(readDecisionRecordDetail({ modelMetaUrl: 'meta' }, resolve, 'adr-1'))
      .resolves.toMatchObject({ title: 'Edited detail' })
    await expect(readDecisionRecordDetail({ modelMetaUrl: 'meta' }, resolve, 'adr-2'))
      .resolves.toBeUndefined()
    expect(resolved).toEqual(['meta', 'meta'])
  })
})
