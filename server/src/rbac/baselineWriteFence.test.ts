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

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import {
  BASELINE_FENCE_MAX_ENTRIES,
  BASELINE_FENCE_STALE_BIT_GRACE_MS,
  BASELINE_FENCE_TTL_MS,
  buildBaselineWriteFence,
  isBaselineDocumentKind,
} from './docScope.js'
import { performanceWorkspaceTransportDocuments } from '../performanceSeed/readModel.js'
import type { PerformanceWorkspaceResult } from '../performanceSeed/workspace.js'
import { createSparseDraftRoot } from '../draft/sparse.js'
import { publishRotatedRoot, type DegenerateRootAudit } from '../maintenance/degenerateRootRepair.js'
import { ensureReadModelSchema } from '../readModel/schema.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { asLegacyStaticOrphan } from '../testing/legacyStaticOrphan.js'
import { openBootstrapScope } from '../bootstrapScope.js'

/**
 * The BASELINE WRITE FENCE predicate (summary migration): on a workspace
 * with a `read_model_static_workspaces` row, inbound mutations of the frozen
 * baseline documents (`registry` + `*-base` kinds in
 * `read_model_static_documents`) must be refused, while the write head
 * (`registry-shard`), the edit overlays, diagrams, root and model-meta — the
 * documents sparse drafts and performance fixtures write in production — must
 * keep passing. The liveness half (hang/reject fault modes) lives
 * in docScope.gateLiveness.test.ts; the wire half (drop = heads never acked)
 * in baselineWriteFence.integration.test.ts. This file pins the VERDICT and
 * its COST against fakes, then the same matrix against real Postgres rows.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

/** The full kind inventory, hand-copied from the real producers
 * (performanceSeed/readModel.ts, draft/sparse.ts,
 * maintenance/degenerateRootRepair.ts) for the matrix tests below. The
 * "versus the REAL allow-list producers" describe RUNS each executable
 * producer against the predicate, so a producer drifting from this list fails
 * there. */
const BASELINE_KINDS = ['registry', 'object-base', 'connection-base', 'decision-record-base'] as const
const WRITABLE_KINDS = [
  'root', 'model-meta', 'model-legacy',
  'object-overlay', 'connection-overlay',
  'registry-shard', 'diagram',
] as const

describe('isBaselineDocumentKind — the ONE kind predicate', () => {
  it('refuses exactly the baseline kinds and accepts every writable kind', () => {
    for (const kind of BASELINE_KINDS) expect(isBaselineDocumentKind(kind), kind).toBe(true)
    for (const kind of WRITABLE_KINDS) expect(isBaselineDocumentKind(kind), kind).toBe(false)
  })

  it('laisse passer une écriture ModelMeta et clôture le registre baseline qui porte l\'entrée (T6)', () => {
    // A summary-only workspace has exactly ONE door for "this diagram is
    // deleted": `ModelMeta.deletedDiagramIds`. If 'model-meta' were fenced,
    // every tombstone would be dropped on the wire, the durable ack would
    // never arrive, the save badge would wedge and no diagram would ever be
    // deletable again — silently, since a drop is not an error.
    expect(isBaselineDocumentKind('model-meta')).toBe(false)
    // If 'registry' were NOT fenced, a client could "fix" the deletion by
    // writing the frozen baseline shard directly — re-materialising every
    // registry shard the summary migration exists to remove, and mutating a
    // document whose content seals,
    // `staticManifestRepair` and `staticRegistryReferenceRepair` all assume is
    // immutable.
    expect(isBaselineDocumentKind('registry')).toBe(true)
    // …and the write head stays writable: a session-CREATED diagram is removed
    // from it outright rather than tombstoned.
    expect(isBaselineDocumentKind('registry-shard')).toBe(false)
  })

  it('fences a FUTURE base-shard kind without an edit here', () => {
    // The suffix rule is the point: a new baseline family (say group-base)
    // must be born fenced, not writable-until-someone-remembers.
    expect(isBaselineDocumentKind('group-base')).toBe(true)
    // …and a kind merely CONTAINING "base" is not baseline.
    expect(isBaselineDocumentKind('database')).toBe(false)
  })
})

// ============================================================================
// The predicate versus the kinds the REAL producers emit. The
// BASELINE_KINDS/WRITABLE_KINDS lists above are hand-copied, so they cannot
// catch a producer that labels its write head 'registry' (fenced: every
// diagram create/rename would be dropped at the wire and the save badge would
// never clear). This suite RUNS each executable allow-list
// producer and confronts `isBaselineDocumentKind` with what actually comes
// out: every producer's write head must be writable, every frozen baseline
// fenced. The remaining producers are SQL literals, pinned at the end.
// ============================================================================
describe('isBaselineDocumentKind versus the REAL allow-list producers', () => {
  it('performance seed: the write head travels as a WRITABLE kind, the frozen registries stay fenced', () => {
    // Mirrors createPerformanceWorkspaceRoot's shape: the write head is PUSHED
    // INTO registryShardUrls (workspace.ts) — which is precisely how the blanket
    // `registryShardUrls -> 'registry'` mapping swallowed it.
    const workspace = {
      rootUrl: 'automerge:root',
      modelUrl: 'automerge:legacy-model',
      modelMetaUrl: 'automerge:meta',
      objectOverlayUrl: 'automerge:object-overlay',
      connectionOverlayUrl: 'automerge:connection-overlay',
      objectShardUrls: ['automerge:object-base-1', 'automerge:object-overlay'],
      connectionShardUrls: ['automerge:connection-base', 'automerge:connection-overlay'],
      decisionRecordShardUrls: ['automerge:adr-base'],
      registryShardUrls: ['automerge:registry-frozen-1', 'automerge:registry-frozen-2', 'automerge:registry-write-head'],
      registryWriteUrl: 'automerge:registry-write-head',
      diagramDocumentUrls: ['automerge:diagram'],
      documentUrls: [],
      documentCount: 0,
    } satisfies PerformanceWorkspaceResult
    const manifest = performanceWorkspaceTransportDocuments(workspace)

    // The write head appears EXACTLY once, and it is writable.
    const writeHead = manifest.filter(({ url }) => url === workspace.registryWriteUrl)
    expect(writeHead).toHaveLength(1)
    expect(writeHead[0].kind).toBe('registry-shard')
    expect(isBaselineDocumentKind(writeHead[0].kind)).toBe(false)
    // No registry shard is dropped by the write-head exclusion…
    for (const url of workspace.registryShardUrls) {
      expect(manifest.some((entry) => entry.url === url), url).toBe(true)
    }
    // …and every OTHER registry shard is the frozen baseline.
    for (const entry of manifest.filter(({ url }) =>
      workspace.registryShardUrls.includes(url) && url !== workspace.registryWriteUrl)) {
      expect(entry.kind, entry.url).toBe('registry')
      expect(isBaselineDocumentKind(entry.kind), entry.url).toBe(true)
    }
    // Base shards fenced; overlays, root, meta and the legacy model writable.
    for (const entry of manifest) {
      const shouldFence = entry.kind === 'registry' || entry.kind.endsWith('-base')
      expect(isBaselineDocumentKind(entry.kind), `${entry.url} (${entry.kind})`).toBe(shouldFence)
    }
    expect(manifest.find(({ url }) => url === 'automerge:object-base-1')?.kind).toBe('object-base')
    expect(isBaselineDocumentKind(manifest.find(({ url }) => url === 'automerge:root')!.kind)).toBe(false)
    expect(isBaselineDocumentKind(manifest.find(({ url }) => url === 'automerge:object-overlay')!.kind)).toBe(false)
  })

  it('sparse draft: the whole control plane — write head included — is writable (a draft owns no baseline)', async () => {
    const repo = new Repo({ network: [] })
    const objectOverlay = repo.create({ objects: {} })
    const connectionOverlay = repo.create({ connections: {} })
    const meta = repo.create({
      staticBaseline: true,
      objectShardUrls: [objectOverlay.url],
      connectionShardUrls: [connectionOverlay.url],
      editsObjectShardUrl: objectOverlay.url,
      editsConnectionShardUrl: connectionOverlay.url,
      groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    })
    const parentRoot = repo.create({
      modelUrl: '',
      modelMetaUrl: meta.url,
      shardUrls: ['automerge:unavailable-frozen-registry'],
      registrySummaryOnly: true,
      diagramCount: 30_000,
    })
    await Promise.all([objectOverlay, connectionOverlay, meta, parentRoot].map((handle) => handle.whenReady()))

    const draft = await createSparseDraftRoot(repo, parentRoot.url, 'parent-v', openBootstrapScope({ landscapeId: 'L-test', versionId: 'draft-v' }, { kind: 'unfenced', reason: 'no-forker' }))

    const kinds = new Map(draft.allowedDocuments.map(({ documentId, kind }) => [documentId, kind]))
    const writeHeadId = draft.registryUrl.replace(/^automerge:/, '')
    expect(kinds.get(writeHeadId)).toBe('registry-shard')
    expect(isBaselineDocumentKind(kinds.get(writeHeadId)!)).toBe(false)
    // The baseline the draft reads lives in the PARENT's read model; nothing
    // the draft's own allow-list names may ever be fenced.
    for (const { documentId, kind } of draft.allowedDocuments) {
      expect(isBaselineDocumentKind(kind), `${documentId} (${kind})`).toBe(false)
    }
  })

  it('rotated root (degenerate-root repair, sparse branch): the fresh write head is published writable', async () => {
    const repo = new Repo({ network: [] })
    const meta = repo.create<Record<string, unknown>>({ objectShardUrls: [], connectionShardUrls: [] })
    const registry = repo.create<Record<string, unknown>>({ diagrams: {} })
    await Promise.all([meta.whenReady(), registry.whenReady()])

    const rotation = await publishRotatedRoot(repo, {
      rootUrl: 'automerge:TZmtdi8zC33kWVUGNMqhBXS3A1o' as AutomergeUrl,
      modelUrl: '',
      modelMetaUrl: meta.url,
      shardUrls: [registry.url],
      registryWriteUrl: registry.url,
      issues: [],
      landscapeId: 'land',
      versionId: 'v',
      label: 'Sparse',
      mappedDocuments: 4,
      staticWorkspace: { diagramCount: 88 },
      sparseDraft: { parentVersionId: 'parent-v', parentRootUrl: 'automerge:parent-root', diagramCount: 88 },
    } satisfies DegenerateRootAudit)

    const rotatedRoot = await repo.find<Record<string, unknown>>(rotation.newRootUrl)
    await rotatedRoot.whenReady()
    const writeHeadId = String(rotatedRoot.doc()!.registryWriteUrl).replace(/^automerge:/, '')
    const writeHeadEntry = rotation.publishedDocuments.find(({ documentId }) => documentId === writeHeadId)
    // The rotation MUST publish its fresh write head, and as a writable kind —
    // a rotation that relabeled it baseline would freeze the very head it
    // just minted.
    expect(writeHeadEntry).toBeDefined()
    expect(writeHeadEntry!.kind).toBe('registry-shard')
    expect(isBaselineDocumentKind(writeHeadEntry!.kind)).toBe(false)
    for (const { documentId, kind } of rotation.publishedDocuments) {
      // A sparse rotation publishes only control-plane documents; none of
      // them may be born fenced.
      expect(isBaselineDocumentKind(kind), `${documentId} (${kind})`).toBe(false)
    }
  })

  it('pins the SQL-literal producers the suite cannot execute without a database', () => {
    // maintenance/staticManifestRepair.ts backfills 'diagram' (writable) and
    // 'retained-static-base' (fenced — a retained base IS baseline, on
    // purpose); readModel/staticDeltaProjector.ts registers rotated overlay
    // heads as '(object|connection)-overlay' (writable, they ARE the write
    // path); draft/sparse.ts's addDiagram registers 'registry-shard' +
    // 'diagram' (both writable).
    expect(isBaselineDocumentKind('retained-static-base')).toBe(true)
    expect(isBaselineDocumentKind('diagram')).toBe(false)
    expect(isBaselineDocumentKind('object-overlay')).toBe(false)
    expect(isBaselineDocumentKind('connection-overlay')).toBe(false)
    expect(isBaselineDocumentKind('registry-shard')).toBe(false)
  })
})

interface FakeRow { landscapeId: string; versionId: string; documentId: string; kind: string }

/** In-memory stand-in for the two static tables, answering the fence's two
 * statements by shape. Workspaces and documents are SEPARATE sets so the
 * JOIN semantics (a doc row whose workspace row is gone does not fence) can
 * be exercised. `broken` simulates a pool outage mid-life (every statement
 * rejects), for the stale-while-fault rows. */
function fakeStaticPool(state: { workspaces: Set<string>; documents: FakeRow[]; broken?: boolean }): {
  pool: pg.Pool
  queries: string[]
} {
  const queries: string[] = []
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push(sql)
      if (state.broken) throw new Error('remaining connection slots are reserved')
      if (/FROM read_model_static_documents/.test(sql)) {
        const documentId = String(params?.[0])
        const rows = state.documents
          .filter((row) => row.documentId === documentId
            && state.workspaces.has(`${row.landscapeId}/${row.versionId}`))
          .map((row) => ({ kind: row.kind }))
        return { rows, rowCount: rows.length }
      }
      if (/read_model_static_workspaces/.test(sql)) {
        return { rows: [{ present: state.workspaces.size > 0 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  } as unknown as pg.Pool
  return { pool, queries }
}

describe('buildBaselineWriteFence — verdicts and cost (fakes)', () => {
  it('a stack with NO static workspaces answers every message from ONE cached bit — zero per-document SQL', async () => {
    const { pool, queries } = fakeStaticPool({ workspaces: new Set(), documents: [] })
    const fence = buildBaselineWriteFence(pool)
    for (let i = 0; i < 50; i += 1) {
      expect(await fence('peer', `ordinary-doc-${i}`)).toBe(true)
    }
    // The single statement is the static-world bit; no per-document lookup
    // ever ran. This is what "an ordinary workspace is untouched by the
    // fence" means in cost: at most one cached, bounded lookup.
    expect(queries).toHaveLength(1)
    expect(queries[0]).toMatch(/read_model_static_workspaces/)
    expect(queries[0]).not.toMatch(/read_model_static_documents/)
  })

  it('on a static workspace: baseline kinds are refused, write head / overlays / diagram / root pass', async () => {
    const workspaces = new Set(['L1/V1'])
    const documents: FakeRow[] = [
      ...BASELINE_KINDS.map((kind, i) => ({ landscapeId: 'L1', versionId: 'V1', documentId: `base-${i}`, kind })),
      ...WRITABLE_KINDS.map((kind, i) => ({ landscapeId: 'L1', versionId: 'V1', documentId: `writable-${i}`, kind })),
    ]
    const { pool } = fakeStaticPool({ workspaces, documents })
    const fence = buildBaselineWriteFence(pool)
    for (let i = 0; i < BASELINE_KINDS.length; i += 1) {
      expect(await fence('peer', `base-${i}`), BASELINE_KINDS[i]).toBe(false)
    }
    for (let i = 0; i < WRITABLE_KINDS.length; i += 1) {
      expect(await fence('peer', `writable-${i}`), WRITABLE_KINDS[i]).toBe(true)
    }
    // A document ABSENT from the allow-list is not baseline (a client-created
    // doc on a sparse draft, an unrelated ordinary workspace's doc).
    expect(await fence('peer', 'never-listed')).toBe(true)
  })

  it('caches the per-document verdict: repeated messages for one doc cost one lookup per TTL', async () => {
    const workspaces = new Set(['L1/V1'])
    const documents: FakeRow[] = [{ landscapeId: 'L1', versionId: 'V1', documentId: 'base-0', kind: 'object-base' }]
    const { pool, queries } = fakeStaticPool({ workspaces, documents })
    const fence = buildBaselineWriteFence(pool, { ttlMs: 60_000 })
    for (let i = 0; i < 20; i += 1) {
      expect(await fence('peer', 'base-0')).toBe(false)
    }
    const docLookups = queries.filter((sql) => /read_model_static_documents/.test(sql))
    expect(docLookups).toHaveLength(1)
  })

  it('caches the ALLOWED verdict too: an ordinary doc in a static world costs one lookup for 20 messages', async () => {
    // The cost that makes a static workspace livable: every message for a doc
    // the allow-list marks writable (or does not list) must NOT pay a JOIN
    // each. Catches: caching only the fenced verdicts.
    const workspaces = new Set(['L1/V1'])
    const documents: FakeRow[] = [{ landscapeId: 'L1', versionId: 'V1', documentId: 'ordinary-diagram', kind: 'diagram' }]
    const { pool, queries } = fakeStaticPool({ workspaces, documents })
    const fence = buildBaselineWriteFence(pool, { ttlMs: 60_000 })
    for (let i = 0; i < 20; i += 1) {
      expect(await fence('peer', 'ordinary-diagram')).toBe(true)
    }
    expect(queries.filter((sql) => /read_model_static_documents/.test(sql))).toHaveLength(1)
  })

  it('collapses concurrent messages into ONE flight per statement (single-flight)', async () => {
    // Ten messages race in before the FIRST verdict lands (a client
    // reconnecting replays its outbox in a burst). Without single-flight each
    // would issue its own bit query and its own JOIN.
    const bitResolvers: Array<(value: { rows: Array<{ present: boolean }>; rowCount: number }) => void> = []
    const docResolvers: Array<(value: { rows: Array<{ kind: string }>; rowCount: number }) => void> = []
    const queries: string[] = []
    const pool = {
      query: (sql: string) => {
        queries.push(sql)
        return new Promise((resolve) => {
          if (/read_model_static_documents/.test(sql)) docResolvers.push(resolve as never)
          else bitResolvers.push(resolve as never)
        })
      },
    } as unknown as pg.Pool
    const fence = buildBaselineWriteFence(pool)
    const flights = Array.from({ length: 10 }, () => fence('peer', 'base-0'))
    for (const resolve of bitResolvers) resolve({ rows: [{ present: true }], rowCount: 1 })
    await new Promise((r) => setTimeout(r, 0)) // let every caller reach the doc lookup
    for (const resolve of docResolvers) resolve({ rows: [{ kind: 'object-base' }], rowCount: 1 })
    expect(await Promise.all(flights)).toEqual(Array.from({ length: 10 }, () => false))
    expect(queries.filter((sql) =>
      /read_model_static_workspaces/.test(sql) && !/read_model_static_documents/.test(sql))).toHaveLength(1)
    expect(queries.filter((sql) => /read_model_static_documents/.test(sql))).toHaveLength(1)
  })

  it('the doc-verdict cache is BOUNDED: crossing the cap clears wholesale', async () => {
    // The 20k bound, exercised through the injectable cap + the test-only
    // witness. Catches: removing the bound (the witness would read 6).
    const { pool } = fakeStaticPool({ workspaces: new Set(['L1/V1']), documents: [] })
    const fence = buildBaselineWriteFence(pool, { ttlMs: 60_000, maxDocVerdicts: 5 })
    for (let i = 0; i < 5; i += 1) await fence('peer', `doc-${i}`)
    expect(fence._docVerdictCountForTests()).toBe(5)
    await fence('peer', 'doc-5')
    expect(fence._docVerdictCountForTests()).toBe(1) // cleared wholesale, newcomer re-cached
  })

  it('ARMS within one TTL of a promotion committing its allow-list', async () => {
    // The residual window the TTL exists to close: a doc cached "not fenced"
    // before the static rows commit must be refused once the TTL rolls over —
    // never pinned writable for the life of the process. A BYSTANDER static
    // workspace keeps the static-world bit true throughout, so arming and
    // disarming below are decided by the per-document JOIN, not the bit.
    const state = {
      workspaces: new Set<string>(['L-bystander/V-bystander']),
      documents: [] as FakeRow[],
    }
    const { pool } = fakeStaticPool(state)
    const fence = buildBaselineWriteFence(pool, { ttlMs: 20 })
    expect(await fence('peer', 'base-shard')).toBe(true) // pre-promotion

    state.workspaces.add('L1/V1') // the promotion's single transaction
    state.documents.push({ landscapeId: 'L1', versionId: 'V1', documentId: 'base-shard', kind: 'object-base' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(await fence('peer', 'base-shard')).toBe(false)

    // …and DISARMS after a de-promotion deletes the workspace row, even while
    // doc rows linger mid-delete (the JOIN, not the doc row, is the fence).
    state.workspaces.delete('L1/V1')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(await fence('peer', 'base-shard')).toBe(true)
  })

  it('a lookup fault fails CLOSED and is REPORTED — never swallowed into an allow', async () => {
    // A catch that turns the refusal into a pass would let the baseline write
    // through exactly when the database is least able to say no. Catches:
    // `catch { return true }`.
    const pool = {
      query: async () => { throw new Error('remaining connection slots are reserved') },
    } as unknown as pg.Pool
    const onFault = vi.fn()
    const fence = buildBaselineWriteFence(pool, { onFault })
    expect(await fence('peer-1', 'doc-1')).toBe(false)
    expect(onFault).toHaveBeenCalledWith('peer-1', 'doc-1', null)
  })

  it('a missing static schema (42P01) means no static world — allowed, not a fault', async () => {
    const pool = {
      query: async () => {
        const error = new Error('relation "read_model_static_workspaces" does not exist') as Error & { code: string }
        error.code = '42P01'
        throw error
      },
    } as unknown as pg.Pool
    const onFault = vi.fn()
    const fence = buildBaselineWriteFence(pool, { onFault })
    expect(await fence('peer', 'doc')).toBe(true)
    expect(onFault).not.toHaveBeenCalled()
  })
})

// ============================================================================
// The PRODUCTION constants under fake timers. Everything
// below runs WITHOUT injected ttlMs/staleBitGraceMs: the constants themselves
// are on trial, because the fence's whole safety story ("arms within one TTL
// of a promotion", "a SQL outage never freezes ordinary stacks for more than
// nothing, and never opens fenced ones at all") lives in their values.
// ============================================================================
describe('buildBaselineWriteFence — production TTL and stale-while-fault grace (fake timers)', () => {
  it('the PRODUCTION TTL arms the fence: a promotion is enforced once 5 s roll over', async () => {
    // No injected ttlMs. Catches: BASELINE_FENCE_TTL_MS = Infinity
    // (or NaN) would pin the pre-promotion "writable" verdict for the life of
    // the process, and the advance below would change nothing.
    vi.useFakeTimers()
    try {
      const state = { workspaces: new Set<string>(), documents: [] as FakeRow[] }
      const { pool } = fakeStaticPool(state)
      const fence = buildBaselineWriteFence(pool)
      expect(await fence('peer', 'base-shard')).toBe(true) // cached: no static world

      // The promotion's single transaction commits the row + the allow-list…
      state.workspaces.add('L1/V1')
      state.documents.push({ landscapeId: 'L1', versionId: 'V1', documentId: 'base-shard', kind: 'object-base' })
      // …the cached bit may honestly serve one more TTL…
      expect(await fence('peer', 'base-shard')).toBe(true)
      // …and the fence is ARMED once the production TTL rolls over. The
      // advance is the LITERAL 5 001 ms, not `BASELINE_FENCE_TTL_MS + 1`: a
      // self-referential advance would jump the clock BY Infinity under the
      // very regression this targets, and `Infinity > Infinity === false`
      // would then expire the cache anyway — the test would pass regardless.
      vi.advanceTimersByTime(5_001)
      expect(await fence('peer', 'base-shard')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pins the production constants — TTL 5 s, grace 10×TTL, verdict cap 20k', () => {
    // 5 s is the fence's contract: the arming bound after a promotion COMMIT
    // (≤ one TTL for the bit + one for the doc verdict) and the disarming
    // bound after a de-promotion. Whoever edits the value renegotiates that
    // contract — this pin makes the edit a decision instead of a drive-by.
    expect(BASELINE_FENCE_TTL_MS).toBe(5_000)
    expect(BASELINE_FENCE_STALE_BIT_GRACE_MS).toBe(10 * BASELINE_FENCE_TTL_MS)
    expect(BASELINE_FENCE_MAX_ENTRIES).toBe(20_000)
  })

  it('a SQL outage does not fence ordinary writes while the last good bit said NO static world', async () => {
    // Stale-while-fault. Without it, a pool outage longer than one TTL would
    // drop EVERY write of EVERY workspace (stage off/dual stacks included,
    // where ordinary writes otherwise never depend on SQL). Catches: removing
    // the stale-while-fault branch (the second assertion fails closed).
    vi.useFakeTimers()
    try {
      const state = { workspaces: new Set<string>(), documents: [] as FakeRow[], broken: false }
      const { pool } = fakeStaticPool(state)
      const onFault = vi.fn()
      const fence = buildBaselineWriteFence(pool, { onFault })
      expect(await fence('peer', 'ordinary-doc')).toBe(true) // last GOOD bit: absent

      state.broken = true // the outage outlives the TTL
      vi.advanceTimersByTime(BASELINE_FENCE_TTL_MS + 1)
      expect(await fence('peer', 'ordinary-doc')).toBe(true)
      expect(await fence('peer', 'another-ordinary-doc')).toBe(true)
      // Serving the stale bit is an ALLOW, not a deny — nothing to report.
      expect(onFault).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the stale-bit grace is BOUNDED: past 10×TTL the fence fails closed again', async () => {
    // Catches: an infinite grace — the "absent" bit would outlive any
    // outage, including one where this process alone is partitioned from a
    // database another server is still promoting into.
    vi.useFakeTimers()
    try {
      const state = { workspaces: new Set<string>(), documents: [] as FakeRow[], broken: false }
      const { pool } = fakeStaticPool(state)
      const onFault = vi.fn()
      const fence = buildBaselineWriteFence(pool, { onFault })
      expect(await fence('peer', 'ordinary-doc')).toBe(true)

      state.broken = true
      vi.advanceTimersByTime(BASELINE_FENCE_STALE_BIT_GRACE_MS + 1)
      expect(await fence('peer', 'ordinary-doc')).toBe(false)
      expect(onFault).toHaveBeenCalledWith('peer', 'ordinary-doc', null)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a fault while the last good bit said a static world IS present stays fail-closed', async () => {
    // Nothing is ever served stale when the world was PRESENT — the
    // per-document verdict is what protects the baseline, and a stale
    // allow-all bit must not become a tunnel around it. Catches: serving the
    // stale bit regardless of its value.
    vi.useFakeTimers()
    try {
      const state = {
        workspaces: new Set(['L1/V1']),
        documents: [{ landscapeId: 'L1', versionId: 'V1', documentId: 'base-0', kind: 'object-base' }] as FakeRow[],
        broken: false,
      }
      const { pool } = fakeStaticPool(state)
      const onFault = vi.fn()
      const fence = buildBaselineWriteFence(pool, { onFault })
      expect(await fence('peer', 'base-0')).toBe(false) // the world is real and fenced
      expect(await fence('peer', 'ordinary-doc')).toBe(true)

      state.broken = true
      vi.advanceTimersByTime(BASELINE_FENCE_TTL_MS + 1)
      expect(await fence('peer', 'base-0')).toBe(false)
      expect(await fence('peer', 'ordinary-doc')).toBe(false) // strict fail-closed during the fault
      expect(onFault).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe.skipIf(!TEST_DATABASE_URL)('buildBaselineWriteFence — real static rows (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let pool: pg.Pool

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'baseline_fence')
    pool = db.pool
    await ensureReadModelSchema(pool)
  })

  afterAll(async () => {
    await db?.teardown()
  })

  async function seedStaticWorkspace(landscapeId: string, versionId: string, docs: Array<{ id: string; kind: string }>): Promise<void> {
    await pool.query(
      `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source) VALUES ($1, $2, 'promoted')`,
      [landscapeId, versionId],
    )
    for (const doc of docs) {
      await pool.query(
        `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind) VALUES ($1, $2, $3, $4)`,
        [landscapeId, versionId, doc.id, doc.kind],
      )
    }
  }

  it('write-head, overlay, diagram and root writes pass the fence on a static workspace; baseline writes do not', async () => {
    await seedStaticWorkspace('L-fence', 'V-fence', [
      ...BASELINE_KINDS.map((kind, i) => ({ id: `pg-base-${i}`, kind })),
      ...WRITABLE_KINDS.map((kind, i) => ({ id: `pg-writable-${i}`, kind })),
    ])
    const fence = buildBaselineWriteFence(pool)

    for (let i = 0; i < BASELINE_KINDS.length; i += 1) {
      expect(await fence('peer', `pg-base-${i}`), BASELINE_KINDS[i]).toBe(false)
    }
    for (let i = 0; i < WRITABLE_KINDS.length; i += 1) {
      expect(await fence('peer', `pg-writable-${i}`), WRITABLE_KINDS[i]).toBe(true)
    }
    // A document no allow-list names — an ordinary workspace's doc on the same
    // stack — is untouched.
    expect(await fence('peer', 'pg-unlisted')).toBe(true)
  })

  it('a doc row whose workspace row is GONE does not fence (the de-promotion half-state)', async () => {
    // No read_model_static_workspaces row for THIS pair — only the doc row. A
    // BYSTANDER static workspace (no documents) is seeded by this very test so
    // the static-world bit is true on its own: without it the fence would
    // short-circuit before the JOIN and this test would pass against a
    // JOIN-less implementation whenever it runs alone (e.g. under `-t`).
    await pool.query(
      `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source)
       VALUES ('L-bystander-pg', 'V-bystander-pg', 'promoted')
       ON CONFLICT DO NOTHING`,
    )
    // The orphan is LEGACY data now — `read_model_static_documents_workspace_fk`
    // refuses to create one, so the fixture reproduces the sequence that left
    // them behind rather than a state a live database can reach.
    await asLegacyStaticOrphan(pool, () => pool.query(
      `INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind) VALUES ('L-orphan', 'V-orphan', 'pg-orphan-base', 'object-base')`,
    ))
    const fence = buildBaselineWriteFence(pool)
    expect(await fence('peer', 'pg-orphan-base')).toBe(true)
  })
})
