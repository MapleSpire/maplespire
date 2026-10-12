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
import { Repo } from '@automerge/automerge-repo'
import { getHeads } from '@automerge/automerge'
import { repairSparseDraftPhantomConnections } from './sparseDraftPhantomConnections.js'

async function fixture() {
  const repo = new Repo({})
  const diagram = repo.create({ connectionIds: ['false-delete', 'unchanged'] })
  const meta = repo.create({
    deletedConnectionIds: ['false-delete', 'off-window-false-delete', 'real-delete'],
  })
  await Promise.all([diagram.whenReady(), meta.whenReady()])
  const root = repo.create({ modelMetaUrl: meta.url })
  await root.whenReady()
  const manifest = {
    schema: 2 as const,
    mode: 'sparse-static' as const,
    createdAt: new Date(0).toISOString(),
    rootUrl: 'automerge:parent',
    parentVersionId: 'parent',
    diagramBases: {
      diagram: { docUrl: diagram.url, sourceDocUrl: 'automerge:source', heads: getHeads(diagram.doc()!) },
    },
  }
  const query = async (sql: string) => {
    if (sql.includes('FROM versions')) return {
      rows: [{ root_url: root.url, status: 'active', base_manifest: manifest }],
    }
    if (sql.includes('draft_sparse_base_entities captured')) return {
      rows: [{ id: 'false-delete' }, { id: 'off-window-false-delete' }],
    }
    throw new Error(`unexpected query: ${sql}`)
  }
  return { repo, meta, query }
}

describe('repairSparseDraftPhantomConnections', () => {
  it('restores only a captured connection still referenced by the cloned diagram', async () => {
    const { repo, meta, query } = await fixture()
    const result = await repairSparseDraftPhantomConnections(
      { query } as never,
      repo,
      'landscape',
      'draft',
      { apply: true, expectedRepairCount: 1 },
    )

    expect(result).toMatchObject({
      auditedTombstones: 3,
      structurallyProvenIds: ['false-delete'],
      operatorConfirmedIds: [],
      repairableIds: ['false-delete'],
      retainedIds: ['off-window-false-delete', 'real-delete'],
      applied: 1,
    })
    expect(meta.doc()?.deletedConnectionIds).toEqual(['off-window-false-delete', 'real-delete'])
  })

  it('restores captured off-window tombstones only with explicit layout-only confirmation', async () => {
    const { repo, meta, query } = await fixture()
    const result = await repairSparseDraftPhantomConnections(
      { query } as never,
      repo,
      'landscape',
      'draft',
      { apply: true, expectedRepairCount: 2, includeCapturedUnreferenced: true },
    )

    expect(result.structurallyProvenIds).toEqual(['false-delete'])
    expect(result.operatorConfirmedIds).toEqual(['off-window-false-delete'])
    expect(meta.doc()?.deletedConnectionIds).toEqual(['real-delete'])
  })

  it('fails closed when the audited candidate count changed', async () => {
    const { repo, meta, query } = await fixture()
    await expect(repairSparseDraftPhantomConnections(
      { query } as never,
      repo,
      'landscape',
      'draft',
      { apply: true, expectedRepairCount: 3, includeCapturedUnreferenced: true },
    )).rejects.toThrow('expected 3, actual 2')
    expect(meta.doc()?.deletedConnectionIds).toEqual([
      'false-delete', 'off-window-false-delete', 'real-delete',
    ])
  })
})
