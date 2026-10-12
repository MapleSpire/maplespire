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
 * The bootstrap publishers against live Postgres: every family-A
 * creation (landscape, forked version, draft, merge snapshot) leaves its whole
 * document graph CLAIMED and its workspace COVERED before returning, with the
 * marker written LAST and zero walks anywhere on the path.
 *
 * `landscapes.ts` imports `pool` from `./db.js` directly, so this file mocks
 * `./db.js` to the isolated-schema pool (the landscapes.rbac.test.ts
 * technique) and imports every module dynamically afterwards, so the whole
 * module graph — landscapes, docScope, claimCoverage, applyMerge — shares one
 * consistent set of module-level registries.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import pg from 'pg'
import { Repo } from '@automerge/automerge-repo'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from './testing/isolatedSchema.js'
import { collectReferencedUrls, documentIdOf } from './maintenance/workspaceFsck.js'
import { CLAIM_PROTOCOL_VERSION, CLAIM_BATCH_SIZE } from './rbac/documentClaims.js'
import { findReadyDocument } from './automergeRepoCompat.js'
import { buildModelMeta } from './modelMeta.js'
import { openBootstrapScope } from './bootstrapScope.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

type PlainDoc = Record<string, unknown> | undefined

describe.skipIf(!TEST_DATABASE_URL)('É4-F — claim-at-create bootstrap publishers (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let realPool: pg.Pool
  let repo: Repo
  let orgId: string

  // The doc index's pool, wrapped for the two instruments this suite needs:
  // an injectable claims failure (the marker-is-written-LAST test) and a
  // claim-statement counter (the fork round-trip ceiling test).
  let failClaims = false
  let failCover = false
  let failCommit = false
  let loseMergeRace = false
  let claimStatements = 0

  let landscapes: typeof import('./landscapes.js')
  let docScope: typeof import('./rbac/docScope.js')
  let applyMergeModule: typeof import('./draft/applyMerge.js')
  let automergeServer: typeof import('./automergeServer.js')
  let forkRootModule: typeof import('./forkRoot.js')

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'claim_at_create')
    realPool = db.pool

    // The pool the publishers see hands out a client whose COMMIT can be made
    // to fail — the latest possible failure of the merge's transaction, after
    // every claim and every marker. Purging the placement notes anywhere before
    // COMMIT would leave a rolled-back snapshot with neither a row nor a note;
    // only a failure AT the commit can tell that apart. Every other member of the pool passes through, bound.
    const interceptingPool = new Proxy(realPool, {
      get(target, property, receiver) {
        if (property === 'connect') {
          return async () => {
            const client = await target.connect()
            if (!failCommit && !loseMergeRace) return client
            const patched = client as unknown as { query: (...args: unknown[]) => Promise<unknown>; release: (...args: unknown[]) => void }
            const originalQuery = patched.query.bind(client)
            const originalRelease = patched.release.bind(client)
            patched.query = (...args: unknown[]) => {
              if (args[0] === 'COMMIT') return Promise.reject(new Error('injected commit failure'))
              // The LOST RACE: the merge's `UPDATE versions SET status = 'merged'`
              // matches no row, as when a concurrent merge won — without
              // touching the row, so the arm can check the draft afterwards.
              if (loseMergeRace && typeof args[0] === 'string' && /UPDATE versions SET status = 'merged'/.test(args[0])) {
                return Promise.resolve({ rowCount: 0, rows: [] })
              }
              return originalQuery(...args)
            }
            patched.release = (...args: unknown[]) => {
              patched.query = originalQuery
              patched.release = originalRelease
              originalRelease(...args)
            }
            return client
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
    vi.doMock('./db.js', () => ({ pool: interceptingPool }))
    // An injectable failure AFTER the merge's claim and BEFORE its
    // COMMIT — the coverage marker — so the rollback-after-claim path is
    // driven rather than reasoned about. Passthrough otherwise.
    vi.doMock('./rbac/claimCoverage.js', async () => {
      const actual = await vi.importActual<typeof import('./rbac/claimCoverage.js')>('./rbac/claimCoverage.js')
      return {
        ...actual,
        coverWorkspace: async (...args: Parameters<typeof actual.coverWorkspace>) => {
          if (failCover) throw new Error('injected cover failure')
          return actual.coverWorkspace(...args)
        },
      }
    })
    vi.resetModules()

    const authSchema = await import('./auth/schema.js')
    const rbacSchema = await import('./rbac/schema.js')
    await authSchema.ensureAuthSchema(realPool)
    await rbacSchema.ensureRbacSchema(realPool)
    await realPool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        default_version_id TEXT,
        org_id             TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await realPool.query(`
      CREATE TABLE IF NOT EXISTS versions (
        id                TEXT PRIMARY KEY,
        landscape_id      TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label             TEXT NOT NULL,
        root_url          TEXT NOT NULL,
        parent_version_id TEXT,
        kind              TEXT NOT NULL DEFAULT 'version',
        status            TEXT NOT NULL DEFAULT 'active',
        base_manifest     JSONB,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    const ownership = await import('./syncCells/ownership.js')
    await ownership.ensureSyncCellOwnershipSchema(realPool)
    const readModelSchema = await import('./readModel/schema.js')
    await readModelSchema.ensureReadModelSchema(realPool)

    landscapes = await import('./landscapes.js')
    docScope = await import('./rbac/docScope.js')
    applyMergeModule = await import('./draft/applyMerge.js')
    automergeServer = await import('./automergeServer.js')
    // Same post-reset module registry as landscapes.js, so `instanceof
    // SummaryForkUnsupportedError` compares against the class landscapes
    // actually throws (a static import would be a DIFFERENT module instance).
    forkRootModule = await import('./forkRoot.js')

    orgId = await authSchema.ensureDefaultOrg(realPool)
    repo = new Repo({})

    const indexPool = {
      query: (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO automerge_document_workspace')) {
          claimStatements += 1
          if (failClaims) throw new Error('injected claims failure')
        }
        return realPool.query(sql, params)
      },
    } as unknown as pg.Pool
    // Registers the module-level documents hook the publishers claim through.
    new docScope.WorkspaceDocIndex(repo, indexPool)
  })

  afterAll(async () => {
    await db?.teardown()
    vi.doUnmock('./db.js')
    vi.resetModules()
  })

  async function resolvePlain(url: unknown): Promise<PlainDoc> {
    if (typeof url !== 'string' || url.length === 0) return undefined
    return (await findReadyDocument<Record<string, unknown>>(repo, url)).doc()
  }

  /** The reachable id set of a workspace root, gathered the way fsck gathers
   * it — root included, since the caller claims it too. */
  async function reachableIds(rootUrl: string): Promise<Set<string>> {
    const root = await resolvePlain(rootUrl)
    const meta = await resolvePlain(root?.modelMetaUrl)
    const registries: PlainDoc[] = []
    for (const shardUrl of (root?.shardUrls as string[] | undefined) ?? []) {
      registries.push(await resolvePlain(shardUrl))
    }
    const referenced = collectReferencedUrls(root, meta, registries)
    return new Set([documentIdOf(rootUrl), ...referenced.map(documentIdOf)])
  }

  async function claimedIds(landscapeId: string, versionId: string): Promise<Set<string>> {
    const { rows } = await realPool.query<{ document_id: string }>(
      'SELECT document_id FROM automerge_document_workspace WHERE landscape_id = $1 AND version_id = $2',
      [landscapeId, versionId],
    )
    return new Set(rows.map((row) => row.document_id))
  }

  async function coverageRow(landscapeId: string, versionId: string) {
    const { rows } = await realPool.query<{ covered: boolean; protocol: number; invalidations: string }>(
      `SELECT covered, protocol, invalidations::text AS invalidations
         FROM workspace_claim_coverage WHERE landscape_id = $1 AND version_id = $2`,
      [landscapeId, versionId],
    )
    return rows[0] ?? null
  }

  it('createEmptyRoot returns every document its root graph references — starter diagram included', async () => {
    // Forgetting the starter diagram or a shard in the tracked ids must fail:
    // whatever the root reaches must be in `documentIds`, or the publisher
    // covers a workspace with a hole in it.
    const created = await automergeServer.createEmptyRoot(repo, openBootstrapScope({ landscapeId: 'L-test', versionId: 'V-test' }, { kind: 'unfenced', reason: 'no-forker' }), { starterDiagram: true })
    const reachable = await reachableIds(created.rootUrl)
    expect(new Set(created.documentIds)).toEqual(reachable)
    // 7 with the starter diagram: root, monolith, diagram, object shard,
    // connection shard, ModelMeta, registry shard.
    expect(created.documentIds).toHaveLength(7)
  })

  it('createLandscape leaves every root-reachable document claimed and covered before returning', async () => {
    const walkBefore = docScope.docScopeWalkStats().total
    const landscape = await landscapes.createLandscape(repo, 'covered at birth', orgId)
    const version = landscape.versions[0]!

    // Pure SQL, zero resolution: the claimed set IS the reachable set ∪ root.
    expect(await claimedIds(landscape.id, version.id)).toEqual(await reachableIds(version.rootUrl))

    const marker = await coverageRow(landscape.id, version.id)
    expect(marker?.covered).toBe(true)
    expect(Number(marker?.protocol)).toBe(CLAIM_PROTOCOL_VERSION)

    // The endgame half: creating a covered workspace triggers NO walk — the
    // registration consulted the marker the publisher just wrote.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(docScope.docScopeWalkStats().total).toBe(walkBefore)
  })

  it('the marker is written LAST: an injected claims failure leaves the workspace uncovered', async () => {
    failClaims = true
    let creationError: unknown
    try {
      await landscapes.createLandscape(repo, 'never covered', orgId)
    } catch (error) {
      creationError = error
    } finally {
      failClaims = false
    }
    // The create failed LOUDLY (claims are not best-effort)...
    expect(creationError).toBeInstanceOf(Error)

    // ...and the marker — the commit record — was never written: with claims
    // rolled off the floor, only a marker written before the claims could put
    // a coverage row here, covering a workspace with holes.
    const { rows: versionRows } = await realPool.query<{ id: string; landscape_id: string }>(
      "SELECT id, landscape_id FROM versions v WHERE EXISTS (SELECT 1 FROM landscapes l WHERE l.id = v.landscape_id AND l.name = 'never covered')",
    )
    expect(versionRows).toHaveLength(1) // the versions row precedes the claims by design
    const { id: versionId, landscape_id: landscapeId } = versionRows[0]!
    expect(await coverageRow(landscapeId, versionId)).toBeNull()
    expect(await claimedIds(landscapeId, versionId)).toEqual(new Set())
  })

  it('createVersion(fork) claims the whole copied graph for the NEW version, none for the source, within the batch ceiling', async () => {
    const landscape = await landscapes.createLandscape(repo, 'fork source', orgId)
    const source = landscape.versions[0]!
    const sourceClaims = await claimedIds(landscape.id, source.id)

    claimStatements = 0
    const forked = await landscapes.createVersion(repo, landscape.id, 'Fork', source.id)
    expect(forked).not.toBeNull()

    const forkedClaims = await claimedIds(landscape.id, forked!.id)
    expect(forkedClaims).toEqual(await reachableIds(forked!.rootUrl))
    // First-owner-wins untouched: the source keeps every one of its rows, and
    // the fork owns none of them.
    expect(await claimedIds(landscape.id, source.id)).toEqual(sourceClaims)
    for (const id of forkedClaims) expect(sourceClaims.has(id)).toBe(false)

    // ⌈n/1000⌉ batch INSERTs — a unitary loop explodes this to n.
    expect(claimStatements).toBeLessThanOrEqual(Math.ceil(forkedClaims.size / CLAIM_BATCH_SIZE) + 2)
    expect((await coverageRow(landscape.id, forked!.id))?.covered).toBe(true)
  })

  it('createDraft(sparse) claims its control graph and covers; parent documents stay the parent\'s', async () => {
    // A summary-only static parent, built the way the performance seed builds
    // one: summary root + staticBaseline meta.
    const objectOverlay = repo.create({ objects: {}, writeHeadVersion: 1 })
    const connectionOverlay = repo.create({ connections: {}, writeHeadVersion: 1 })
    await Promise.all([objectOverlay, connectionOverlay].map((h) => h.whenReady()))
    const meta = repo.create({
      ...buildModelMeta({
        objectWriteHead: objectOverlay.url,
        connectionWriteHead: connectionOverlay.url,
      }),
      staticBaseline: true,
    })
    const registry = repo.create({ diagrams: {} })
    await Promise.all([meta, registry].map((h) => h.whenReady()))
    const parentRoot = repo.create({
      modelUrl: '',
      modelMetaUrl: meta.url,
      shardUrls: [registry.url],
      registryWriteUrl: registry.url,
      registrySummaryOnly: true,
      diagramCount: 0,
    })
    await parentRoot.whenReady()

    const landscapeId = 'L-sparse-parent'
    const parentVersionId = 'V-sparse-parent'
    await realPool.query(
      'INSERT INTO landscapes (id, name, default_version_id, org_id) VALUES ($1, $1, $2, $3)',
      [landscapeId, parentVersionId, orgId],
    )
    await realPool.query(
      "INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3)",
      [parentVersionId, landscapeId, parentRoot.url],
    )

    const draft = await landscapes.createDraft(repo, landscapeId, 'sparse draft')
    expect(draft).not.toBeNull()
    expect(draft!.kind).toBe('draft')

    // The six-document control graph (root, legacy monolith, ModelMeta, both
    // overlays, registry) is claimed for the DRAFT...
    const draftClaims = await claimedIds(landscapeId, draft!.id)
    expect(draftClaims.size).toBe(6)
    expect(draftClaims.has(documentIdOf(draft!.rootUrl))).toBe(true)
    // ...and none of the PARENT's control documents moved.
    for (const parentDoc of [parentRoot, meta, registry, objectOverlay, connectionOverlay]) {
      expect(draftClaims.has(String(parentDoc.documentId))).toBe(false)
    }
    expect((await coverageRow(landscapeId, draft!.id))?.covered).toBe(true)
  })

  it('an applyMerge snapshot version is claimed and covered at creation', async () => {
    // Closes the TTL-window fold structurally: the snapshot version is born
    // claimed + covered + notified, in the same transaction as its row.
    const landscape = await landscapes.createLandscape(repo, 'merge home', orgId)
    const main = landscape.versions[0]!
    const draft = await landscapes.createDraft(repo, landscape.id, 'no-op draft')
    expect(draft).not.toBeNull()

    const outcome = await applyMergeModule.applyMerge(repo, landscape.id, draft!.id)
    expect(outcome).toEqual({ ok: true, versionId: expect.any(String) })
    const snapshotId = (outcome as { versionId: string }).versionId
    expect(snapshotId).not.toBe('')
    expect(snapshotId).not.toBe(main.id)

    const { rows } = await realPool.query<{ root_url: string }>(
      'SELECT root_url FROM versions WHERE id = $1 AND landscape_id = $2',
      [snapshotId, landscape.id],
    )
    expect(rows).toHaveLength(1)
    expect(await claimedIds(landscape.id, snapshotId)).toEqual(await reachableIds(rows[0]!.root_url))
    expect((await coverageRow(landscape.id, snapshotId))?.covered).toBe(true)
  })

  describe('B2-5d — the bootstrap scope under the real publishers', () => {
    // Same post-reset registry as `landscapes.js`, or the installed ownership
    // would be a different module instance from the one the publishers read.
    let bootstrapScopeModule: typeof import('./bootstrapScope.js')
    let placementModule: typeof import('./rbac/serverCreationPlacement.js')
    let writeAuthorityModule: typeof import('./syncCells/writeAuthority.js')
    let overlaySegmentsModule: typeof import('./overlaySegments.js')
    let uninstall: (() => void) | null = null
    beforeAll(async () => {
      bootstrapScopeModule = await import('./bootstrapScope.js')
      placementModule = await import('./rbac/serverCreationPlacement.js')
      writeAuthorityModule = await import('./syncCells/writeAuthority.js')
      overlaySegmentsModule = await import('./overlaySegments.js')
    })
    afterEach(() => {
      uninstall?.()
      uninstall = null
      placementModule.resetServerCreationPlacementForTest()
      bootstrapScopeModule.resetBootstrapScopeCountersForTest()
    })

    /** A cell that owns exactly the workspaces `owns` admits. */
    const install = (owns: boolean | ((workspace: { landscapeId: string; versionId: string }) => boolean)) => {
      const ownsFn = typeof owns === 'function' ? owns : () => owns
      uninstall = bootstrapScopeModule.installBootstrapOwnership({
        required: () => true,
        current: () => ({ enabled: true, owns: ownsFn, fencingToken: (w) => (ownsFn(w) ? '7' : null) }),
      })
    }

    it('a merge on a cell that holds NO lease for the parent is refused BEFORE anything is minted', async () => {
      // The agent loop's path (`merge_draft` from `/api/ai/chat|run` or `/mcp`;
      // the direct tool door is routed): `applyMerge` with nothing in front of
      // it. On a lease-less cell the parent scope refuses at open — no
      // snapshot, no copies, the draft still `active`.
      const landscape = await landscapes.createLandscape(repo, 'refused merge home', orgId)
      const draft = await landscapes.createDraft(repo, landscape.id, 'refused draft')
      expect(draft).not.toBeNull()
      const versionsBefore = (await realPool.query('SELECT count(*)::int AS n FROM versions WHERE landscape_id = $1', [landscape.id])).rows[0]!.n
      const claimsBefore = (await realPool.query('SELECT count(*)::int AS n FROM automerge_document_workspace WHERE landscape_id = $1', [landscape.id])).rows[0]!.n

      install(false)
      await expect(applyMergeModule.applyMerge(repo, landscape.id, draft!.id))
        .rejects.toBeInstanceOf(writeAuthorityModule.WriteAuthorityUnavailableError)
      await expect(applyMergeModule.applyMerge(repo, landscape.id, draft!.id)).rejects.toMatchObject({ reason: 'not-owner' })
      // The two creation doors refuse the same way, BEFORE any document: a
      // draft keyed on its parent, a version keyed on the landscape default.
      await expect(landscapes.createDraft(repo, landscape.id, 'refused twin')).rejects.toMatchObject({ reason: 'not-owner' })
      await expect(landscapes.createVersion(repo, landscape.id, 'refused fork', landscape.versions[0]!.id)).rejects.toMatchObject({ reason: 'not-owner' })
      await expect(landscapes.createVersion(repo, landscape.id, 'refused empty')).rejects.toMatchObject({ reason: 'not-owner' })

      const versionsAfter = (await realPool.query('SELECT count(*)::int AS n FROM versions WHERE landscape_id = $1', [landscape.id])).rows[0]!.n
      const claimsAfter = (await realPool.query('SELECT count(*)::int AS n FROM automerge_document_workspace WHERE landscape_id = $1', [landscape.id])).rows[0]!.n
      expect(versionsAfter, 'no snapshot row').toBe(versionsBefore)
      expect(claimsAfter, 'no document claimed').toBe(claimsBefore)
      const { rows } = await realPool.query<{ status: string }>('SELECT status FROM versions WHERE id = $1', [draft!.id])
      expect(rows[0]!.status, 'the draft was not marked merged').toBe('active')
      expect(bootstrapScopeModule.bootstrapScopeSnapshot()).toMatchObject({ refusedAtOpen: 5 })
      expect(placementModule.bootstrapPlacementSnapshot().size, 'nothing was minted, so nothing was noted').toBe(0)
    })

    it('the OWNER\'s merge of a CONTENT draft rotates an overlay segment on the parent under the parent\'s scope, every save fenced, every note purged on commit — and a merged draft is still a forkable source', async () => {
      // A recording adapter asks the fence's question at every save.
      const saves: { documentId: string; placement: string | null }[] = []
      const chunks = new Map<string, Uint8Array>()
      const text = (key: readonly string[]) => key.join('/')
      const storage = {
        load: async (key: string[]) => chunks.get(text(key)),
        save: async (key: string[], data: Uint8Array) => {
          const placement = placementModule.bootstrapPlacementFor(key[0]!)
          saves.push({ documentId: key[0]!, placement: placement ? `${placement.landscapeId}/${placement.versionId}` : null })
          chunks.set(text(key), data)
        },
        remove: async (key: string[]) => { chunks.delete(text(key)) },
        loadRange: async (prefix: string[]) => {
          const p = text(prefix)
          return [...chunks.entries()].filter(([k]) => k === p || k.startsWith(`${p}/`)).map(([k, data]) => ({ key: k.split('/'), data }))
        },
        removeRange: async (prefix: string[]) => {
          const p = text(prefix)
          for (const k of [...chunks.keys()]) if (k === p || k.startsWith(`${p}/`)) chunks.delete(k)
        },
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recording = new Repo({ storage: storage as any, network: [], saveDebounceRate: 0 })
      // Resolved through THIS repo — the suite's `resolvePlain`/`reachableIds`
      // read the beforeAll repo, which never sees these documents.
      const plainIn = async (url: unknown): Promise<PlainDoc> => (typeof url === 'string' && url.length > 0
        ? (await findReadyDocument<Record<string, unknown>>(recording, url)).doc()
        : undefined)
      const reachableIn = async (rootUrl: string): Promise<Set<string>> => {
        const root = await plainIn(rootUrl)
        const meta = await plainIn(root?.modelMetaUrl)
        const registries: PlainDoc[] = []
        for (const shardUrl of (root?.shardUrls as string[] | undefined) ?? []) registries.push(await plainIn(shardUrl))
        return new Set([documentIdOf(rootUrl), ...collectReferencedUrls(root, meta, registries).map(documentIdOf)])
      }

      install(true)
      const landscape = await landscapes.createLandscape(recording, 'content merge home', orgId)
      const main = landscape.versions[0]!
      const draft = await landscapes.createDraft(recording, landscape.id, 'content draft')
      expect(draft).not.toBeNull()

      // Seed the DRAFT with one more object than the overlay segment size, so
      // merging it makes `writeOverlayEntities` rotate a segment on the PARENT
      // — the fourth creation site of a merge, which an empty draft never
      // reaches.
      const draftRoot = await plainIn(draft!.rootUrl)
      const draftMeta = await findReadyDocument<Record<string, unknown>>(recording, String(draftRoot!.modelMetaUrl))
      const seeded: Record<string, unknown> = {}
      for (let i = 0; i < overlaySegmentsModule.OVERLAY_SEGMENT_SIZE + 1; i += 1) {
        seeded[`o${i}`] = { id: `o${i}`, name: `Object ${i}`, type: 'system' }
      }
      await overlaySegmentsModule.writeOverlayEntities(recording, draftMeta as never, 'objects', seeded)
      await recording.flush()

      const parentMetaBefore = await plainIn((await plainIn(main.rootUrl))!.modelMetaUrl)
      const segmentsBefore = (parentMetaBefore!.editsObjectShardUrls as string[] | undefined)?.length ?? 0
      saves.length = 0

      const outcome = await applyMergeModule.applyMerge(recording, landscape.id, draft!.id)
      expect(outcome).toEqual({ ok: true, versionId: expect.any(String) })
      const snapshotId = (outcome as { versionId: string }).versionId

      // THE ROTATION HAPPENED: the parent's overlay has one more segment.
      const parentMetaAfter = await plainIn((await plainIn(main.rootUrl))!.modelMetaUrl)
      const segmentsAfter = (parentMetaAfter!.editsObjectShardUrls as string[]).length
      expect(segmentsAfter, 'the seeded merge did not rotate a segment — this arm proved nothing about the fourth site').toBeGreaterThan(segmentsBefore)
      const newSegments = (parentMetaAfter!.editsObjectShardUrls as string[])
        .filter((url) => !((parentMetaBefore!.editsObjectShardUrls as string[] | undefined) ?? []).includes(url))
        .map(documentIdOf)
      expect(newSegments.length).toBeGreaterThan(0)

      // THE FIRST save of the new segment, and of every snapshot document,
      // saw the PARENT as its fence key — the merge's copies and its fork both
      // write under the parent's lease. The FIRST, not every: the segment is
      // claimed (autocommit) right after its first flush and written again
      // when the batch lands, and by then the note is purged and the durable
      // row is the fence's operand — which the recorder, asking only the map,
      // reads as null. That is the purge-on-commit working, not a hole.
      const parentKey = `${landscape.id}/${main.id}`
      const { rows: snapshotRows } = await realPool.query<{ root_url: string }>('SELECT root_url FROM versions WHERE id = $1', [snapshotId])
      const snapshotIds = await reachableIn(snapshotRows[0]!.root_url)
      const fencedIds = [...new Set([...newSegments, ...snapshotIds])]
      const firstSaveOf = (id: string) => saves.find((save) => save.documentId === id)
      for (const id of fencedIds) {
        expect(firstSaveOf(id), `no save of scoped document ${id} was recorded`).toBeDefined()
        expect(firstSaveOf(id)!.placement, `the first save of ${id} was not fenced under the parent`).toBe(parentKey)
      }
      // And a save of the segment AFTER its claim reads the map as null — the
      // purge-on-commit made the durable row the operand.
      const segmentSaves = saves.filter((save) => newSegments.includes(save.documentId))
      expect(segmentSaves.length, 'the segment was written once for its creation and once for the batch').toBeGreaterThanOrEqual(2)
      expect(segmentSaves.at(-1)!.placement, 'the note outlived the claim').toBeNull()

      // AND EVERY NOTE IS GONE once the claims committed — the segment's on
      // its autocommit claim, the snapshot's after COMMIT.
      expect(placementModule.bootstrapPlacementSnapshot()).toMatchObject({ live: 0, retired: 0 })
      expect(await claimedIds(landscape.id, snapshotId)).toEqual(snapshotIds)

      // THE MERGED DRAFT IS STILL A FORKABLE SOURCE. Keying the fork on the
      // source would refuse this for ever (no cell can lease a merged draft);
      // keyed on the landscape default, it forks — six documents claimed. The
      // cell for this half owns the DEFAULT and nothing else, so a fork keyed
      // on the merged draft would be refused here.
      uninstall?.()
      install((w) => w.versionId === main.id)
      const twin = await landscapes.createVersion(recording, landscape.id, 'twin of a merged draft', draft!.id)
      expect(twin).not.toBeNull()
      expect((await claimedIds(landscape.id, twin!.id)).size).toBeGreaterThanOrEqual(6)
    })

    it('a merge whose transaction rolls back AFTER the claim keeps every note, RETIRED — the purge is on the commit, nowhere earlier', async () => {
      // Purging inside `claimWorkspaceDocuments` would be wrong: a rollback
      // that FOLLOWS the claim (here, the coverage marker failing) would leave
      // the snapshot with neither a row nor a note — admitted unconditionally
      // on a lease-less cell.
      const landscape = await landscapes.createLandscape(repo, 'rollback after claim', orgId)
      const draft = await landscapes.createDraft(repo, landscape.id, 'doomed draft')
      expect(draft).not.toBeNull()
      const versionsBefore = (await realPool.query('SELECT count(*)::int AS n FROM versions WHERE landscape_id = $1', [landscape.id])).rows[0]!.n

      install(true)
      failCover = true
      try {
        await expect(applyMergeModule.applyMerge(repo, landscape.id, draft!.id)).rejects.toThrow(/injected cover failure/)
      } finally {
        failCover = false
      }
      const versionsAfter = (await realPool.query('SELECT count(*)::int AS n FROM versions WHERE landscape_id = $1', [landscape.id])).rows[0]!.n
      expect(versionsAfter, 'the snapshot row was rolled back').toBe(versionsBefore)
      // The six snapshot documents were minted and flushed under the parent's
      // lease; their notes are still there — retired, since no claim committed.
      expect(placementModule.bootstrapPlacementSnapshot()).toMatchObject({ live: 0, retired: 6 })
      // Both of the merge's scopes retire on the way out: the snapshot's (six
      // notes) and the parent's (none here — an empty draft rotates no segment).
      expect(bootstrapScopeModule.bootstrapScopeSnapshot().retired).toBe(2)
    })

    it('KILLS the pre-COMMIT purge: a merge whose COMMIT itself fails keeps every note, RETIRED', async () => {
      // The coverage-marker arm above is blind to a purge placed between the
      // marker and COMMIT: an injected failure BEFORE the purge cannot see
      // where the purge is.
      // This arm fails the transaction at its last statement, so any purge
      // that is not strictly after a SUCCESSFUL commit has already run.
      const landscape = await landscapes.createLandscape(repo, 'rollback at commit', orgId)
      const draft = await landscapes.createDraft(repo, landscape.id, 'doomed at commit')
      expect(draft).not.toBeNull()
      const before = placementModule.bootstrapPlacementSnapshot()
      const versionsBefore = (await realPool.query('SELECT count(*)::int AS n FROM versions WHERE landscape_id = $1', [landscape.id])).rows[0]!.n

      install(true)
      failCommit = true
      try {
        await expect(applyMergeModule.applyMerge(repo, landscape.id, draft!.id)).rejects.toThrow(/injected commit failure/)
      } finally {
        failCommit = false
      }
      const versionsAfter = (await realPool.query('SELECT count(*)::int AS n FROM versions WHERE landscape_id = $1', [landscape.id])).rows[0]!.n
      expect(versionsAfter, 'the snapshot row was rolled back').toBe(versionsBefore)
      const { rows: draftRows } = await realPool.query<{ status: string }>('SELECT status FROM versions WHERE id = $1', [draft!.id])
      expect(draftRows[0]!.status, 'the draft is still mergeable').toBe('active')
      const after = placementModule.bootstrapPlacementSnapshot()
      expect(after.live, 'no note was left live').toBe(0)
      expect(after.retired - before.retired, 'the six snapshot notes were retired, not purged').toBe(6)
    })

    it('KILLS the un-fenced sparse clone: ensureSparseDraftDiagram opens its scope on the DRAFT\'s own lease — refused on a lease-less cell with nothing minted, minted, fenced and claimed on the owner', async () => {
      // The one bootstrap site with no publisher behind it, so nothing else
      // would notice if it were un-fenced.
      const sparseModule = await import('./draft/sparse.js')
      const landscapeId = 'L-sparse-clone'
      const mainId = 'V-sparse-clone-main'
      // A summary parent with a static baseline — the shape `canCreateSparseDraft` accepts.
      const objectOverlay = repo.create({ objects: {}, writeHeadVersion: 1 })
      const connectionOverlay = repo.create({ connections: {}, writeHeadVersion: 1 })
      await Promise.all([objectOverlay, connectionOverlay].map((h) => h.whenReady()))
      const meta = repo.create({
        ...buildModelMeta({ objectWriteHead: objectOverlay.url, connectionWriteHead: connectionOverlay.url }),
        staticBaseline: true,
      })
      const registry = repo.create({ diagrams: {} })
      await Promise.all([meta, registry].map((h) => h.whenReady()))
      const parentRoot = repo.create({
        modelUrl: '', modelMetaUrl: meta.url, shardUrls: [registry.url], registryWriteUrl: registry.url,
        registrySummaryOnly: true, diagramCount: 0,
      })
      await parentRoot.whenReady()
      await realPool.query('INSERT INTO landscapes (id, name, default_version_id, org_id) VALUES ($1, $1, $2, $3)', [landscapeId, mainId, orgId])
      await realPool.query("INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3)", [mainId, landscapeId, parentRoot.url])

      install(true)
      const draft = await landscapes.createDraft(repo, landscapeId, 'sparse under lease')
      expect(draft).not.toBeNull()
      const draftRoot = (await findReadyDocument<Record<string, unknown>>(repo, draft!.rootUrl)).doc()!
      expect(draftRoot.registrySummaryOnly, 'the draft is sparse').toBe(true)
      const claimedBefore = (await claimedIds(landscapeId, draft!.id)).size
      // The source DiagramDoc the clone is taken from, and its projection.
      const source = repo.create({ name: 'Context', type: 'context', objectIds: [], connectionIds: [], groupIds: [] })
      await source.whenReady()
      const projection = { id: 'diag-1', docUrl: source.url, name: 'Context', type: 'context', objectIds: [], connectionIds: [], groupIds: [] }

      // A cell that owns NOTHING: refused before the clone is minted.
      uninstall?.()
      install(false)
      const refusedBefore = bootstrapScopeModule.bootstrapScopeSnapshot().refusedAtOpen
      await expect(sparseModule.ensureSparseDraftDiagram(repo, landscapeId, draft!.id, 'diag-1', projection))
        .rejects.toMatchObject({ reason: 'not-owner' })
      expect(bootstrapScopeModule.bootstrapScopeSnapshot().refusedAtOpen - refusedBefore).toBe(1)
      expect(placementModule.bootstrapPlacementSnapshot().size, 'nothing minted, nothing noted').toBe(0)
      expect((await claimedIds(landscapeId, draft!.id)).size, 'no clone was claimed').toBe(claimedBefore)
      const { rows: untouched } = await realPool.query<{ base_manifest: { diagramBases: Record<string, unknown> } }>(
        'SELECT base_manifest FROM versions WHERE id = $1', [draft!.id])
      expect(untouched[0]!.base_manifest.diagramBases['diag-1'], 'the manifest was rolled back').toBeUndefined()

      // A cell that owns EXACTLY the draft (not its parent): the key is the
      // draft, so keying on the parent would be refused here.
      uninstall?.()
      install((w) => w.versionId === draft!.id)
      const openedBefore = bootstrapScopeModule.bootstrapScopeSnapshot().opened
      // THE DEADLOCK THIS ARM GUARDS: claiming the clone through the
      // autocommit hook — an INSERT on another connection whose foreign key
      // needs a KEY SHARE lock on the draft's `versions` row, held FOR UPDATE
      // by this very call — hangs forever. Bounded so a regression fails by
      // timing, not by the suite's 20 s ceiling.
      const startedAt = Date.now()
      const cloned = await sparseModule.ensureSparseDraftDiagram(repo, landscapeId, draft!.id, 'diag-1', projection)
      expect(Date.now() - startedAt, 'the clone must not wait on its own row lock').toBeLessThan(5_000)
      expect(cloned).toBeDefined()
      expect(String(cloned!.docUrl)).not.toBe(source.url)
      expect(bootstrapScopeModule.bootstrapScopeSnapshot().opened - openedBefore).toBe(1)
      expect(bootstrapScopeModule.bootstrapScopeSnapshot().refusedAtOpen - refusedBefore, 'no further refusal').toBe(1)
      const claimedAfter = await claimedIds(landscapeId, draft!.id)
      expect(claimedAfter.has(documentIdOf(String(cloned!.docUrl))), 'the clone is claimed for the draft').toBe(true)
      expect(placementModule.bootstrapPlacementSnapshot().live, 'the note was purged at the claim').toBe(0)
      const { rows: manifest } = await realPool.query<{ base_manifest: { diagramBases: Record<string, { docUrl: string }> } }>(
        'SELECT base_manifest FROM versions WHERE id = $1', [draft!.id])
      expect(manifest[0]!.base_manifest.diagramBases['diag-1']!.docUrl).toBe(String(cloned!.docUrl))

      // KILLS the pre-COMMIT purge on this site too: a second clone whose
      // COMMIT fails is rolled back with its note RETIRED — not purged (the
      // clone would have neither row nor note), not left live.
      const source2 = repo.create({ name: 'Containers', type: 'container', objectIds: [], connectionIds: [], groupIds: [] })
      await source2.whenReady()
      const projection2 = { id: 'diag-2', docUrl: source2.url, name: 'Containers', type: 'container', objectIds: [], connectionIds: [], groupIds: [] }
      const snapshotBefore = placementModule.bootstrapPlacementSnapshot()
      const claimedBeforeCommitFailure = (await claimedIds(landscapeId, draft!.id)).size
      failCommit = true
      try {
        await expect(sparseModule.ensureSparseDraftDiagram(repo, landscapeId, draft!.id, 'diag-2', projection2))
          .rejects.toThrow(/injected commit failure/)
      } finally {
        failCommit = false
      }
      const snapshotAfter = placementModule.bootstrapPlacementSnapshot()
      expect(snapshotAfter.live, 'no note left live').toBe(0)
      expect(snapshotAfter.retired - snapshotBefore.retired, 'the second clone\'s note was retired, not purged').toBe(1)
      expect((await claimedIds(landscapeId, draft!.id)).size, 'the claim was rolled back with the transaction').toBe(claimedBeforeCommitFailure)
      const { rows: manifest2 } = await realPool.query<{ base_manifest: { diagramBases: Record<string, unknown> } }>(
        'SELECT base_manifest FROM versions WHERE id = $1', [draft!.id])
      expect(manifest2[0]!.base_manifest.diagramBases['diag-2'], 'the manifest was rolled back').toBeUndefined()
    })

    it('KILLS the un-retired losing fork: a merge that loses the race (UPDATE matches no row) rolls back, answers no version, and retires its snapshot notes', async () => {
      // Pins `snapshotScope.retire()` in this branch. The race is made
      // deterministic by the intercepting pool: the
      // merge's UPDATE reports zero rows, as when a concurrent merge won.
      const landscape = await landscapes.createLandscape(repo, 'lost race', orgId)
      const draft = await landscapes.createDraft(repo, landscape.id, 'raced draft')
      expect(draft).not.toBeNull()
      const before = placementModule.bootstrapPlacementSnapshot()
      const scopesBefore = bootstrapScopeModule.bootstrapScopeSnapshot().retired
      const versionsBefore = (await realPool.query('SELECT count(*)::int AS n FROM versions WHERE landscape_id = $1', [landscape.id])).rows[0]!.n

      install(true)
      loseMergeRace = true
      let outcome: Awaited<ReturnType<typeof applyMergeModule.applyMerge>>
      try {
        outcome = await applyMergeModule.applyMerge(repo, landscape.id, draft!.id)
      } finally {
        loseMergeRace = false
      }
      expect(outcome).toEqual({ ok: true, versionId: '' })
      const versionsAfter = (await realPool.query('SELECT count(*)::int AS n FROM versions WHERE landscape_id = $1', [landscape.id])).rows[0]!.n
      expect(versionsAfter, 'the losing snapshot row was rolled back').toBe(versionsBefore)
      const after = placementModule.bootstrapPlacementSnapshot()
      expect(after.live, 'no note was left live').toBe(0)
      expect(after.retired - before.retired, 'the losing fork\'s six notes were retired').toBe(6)
      expect(bootstrapScopeModule.bootstrapScopeSnapshot().retired - scopesBefore, 'the snapshot scope retired itself').toBe(1)
    })
  })

  describe('T2-v0 — forking a summary source is refused with 409 until the summary fork publisher ships', () => {
    // Why: T1 makes forkRoot round-trip the summary contract, so a fork of a
    // summary source now yields a `registrySummaryOnly: true` twin with NO
    // `read_model_static_workspaces` row — exactly the state fsck classifies
    // as data-loss (no cold client can list or open its diagrams). Until T2's
    // publisher exists, every deep-fork orchestration path refuses up front.

    /** A summary-only parent registered in landscapes/versions; `staticBaseline`
     * decides whether createDraft can take the sparse O(1) branch. */
    async function summaryParent(landscapeId: string, versionId: string, staticBaseline: boolean) {
      const objectOverlay = repo.create({ objects: {}, writeHeadVersion: 1 })
      const connectionOverlay = repo.create({ connections: {}, writeHeadVersion: 1 })
      await Promise.all([objectOverlay, connectionOverlay].map((h) => h.whenReady()))
      const meta = repo.create({
        ...buildModelMeta({
          objectWriteHead: objectOverlay.url,
          connectionWriteHead: connectionOverlay.url,
        }),
        ...(staticBaseline ? { staticBaseline: true } : {}),
      })
      const registry = repo.create({ diagrams: {} })
      await Promise.all([meta, registry].map((h) => h.whenReady()))
      const parentRoot = repo.create({
        modelUrl: '',
        modelMetaUrl: meta.url,
        shardUrls: [registry.url],
        registryWriteUrl: registry.url,
        registrySummaryOnly: true,
        diagramCount: 0,
      })
      await parentRoot.whenReady()
      await realPool.query(
        'INSERT INTO landscapes (id, name, default_version_id, org_id) VALUES ($1, $1, $2, $3)',
        [landscapeId, versionId, orgId],
      )
      await realPool.query(
        "INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3)",
        [versionId, landscapeId, parentRoot.url],
      )
      return parentRoot
    }

    it('createVersion(fork) of a summary version: typed 409 error, and NOTHING was created', async () => {
      await summaryParent('L-summary-fork', 'V-summary-main', true)
      let error: unknown
      try {
        await landscapes.createVersion(repo, 'L-summary-fork', 'Twin', 'V-summary-main')
      } catch (err) {
        error = err
      }
      expect(error).toBeInstanceOf(forkRootModule.SummaryForkUnsupportedError)
      expect((error as { status?: number }).status).toBe(409)
      expect((error as Error).message).toContain('summary fork publisher (T2)')
      // Refused BEFORE any creation: the landscape still has exactly its Main
      // version, and no claims exist for anything but that Main.
      const { rows } = await realPool.query<{ id: string }>(
        'SELECT id FROM versions WHERE landscape_id = $1',
        ['L-summary-fork'],
      )
      expect(rows.map((row) => row.id)).toEqual(['V-summary-main'])
    })

    it('createDraft on a summary parent that CANNOT sparse-fork (no staticBaseline) is refused, never deep-forked', async () => {
      await summaryParent('L-summary-nodraft', 'V-nodraft-main', false)
      await expect(landscapes.createDraft(repo, 'L-summary-nodraft', 'doomed draft'))
        .rejects.toBeInstanceOf(forkRootModule.SummaryForkUnsupportedError)
      const { rows } = await realPool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM versions WHERE landscape_id = $1 AND kind = 'draft'",
        ['L-summary-nodraft'],
      )
      expect(rows[0].n).toBe(0)
    })

    it('a sparse draft on a HEALTHY summary parent still works — the guard fences only the deep fork', async () => {
      await summaryParent('L-summary-sparse', 'V-sparse-main', true)
      const draft = await landscapes.createDraft(repo, 'L-summary-sparse', 'still sparse')
      expect(draft).not.toBeNull()
      expect(draft!.kind).toBe('draft')
      const draftRoot = (await findReadyDocument<Record<string, unknown>>(repo, draft!.rootUrl)).doc()!
      expect(draftRoot.registrySummaryOnly).toBe(true)
      expect(draftRoot.sparseDraftBaseVersionId).toBe('V-sparse-main')
    })

    it('applyMerge deep snapshot of a PROMOTED summary parent: blocked (the route maps it to 409), nothing mutated', async () => {
      // A deep draft is born on an ORDINARY parent...
      const landscape = await landscapes.createLandscape(repo, 'promoted under draft', orgId)
      const main = landscape.versions[0]!
      const draft = await landscapes.createDraft(repo, landscape.id, 'deep draft')
      expect(draft).not.toBeNull()
      // ...and the parent is then promoted to summary — the only way a deep
      // (non-sparse) manifest meets a summary parent at merge time.
      const parentRoot = await findReadyDocument<{ registrySummaryOnly?: boolean }>(repo, main.rootUrl)
      parentRoot.change((doc) => { doc.registrySummaryOnly = true })

      const outcome = await applyMergeModule.applyMerge(repo, landscape.id, draft!.id)
      expect(outcome).toEqual({
        ok: false,
        blocked: expect.stringContaining('summary fork publisher (T2)'),
      })
      // Refused BEFORE the in-place apply and BEFORE the snapshot fork: the
      // draft is still active and no "Merge:" version row appeared.
      const { rows: draftRows } = await realPool.query<{ status: string }>(
        'SELECT status FROM versions WHERE id = $1 AND landscape_id = $2',
        [draft!.id, landscape.id],
      )
      expect(draftRows[0].status).toBe('active')
      const { rows: versionRows } = await realPool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM versions WHERE landscape_id = $1 AND kind IS DISTINCT FROM 'draft'",
        [landscape.id],
      )
      expect(versionRows[0].n).toBe(1) // Main only — no snapshot was minted
    })
  })
})
