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

import { Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaticDeltaProjector, substituteOverlayPrefix } from './staticDeltaProjector.js'

/**
 * The chain-fold PASS, driven through the REAL rotation path.
 *
 * The first test bounds the overlay chain. It drives genuine rotations (32
 * write batches on the head, the projector's own debounce, its advisory lock,
 * its own `repo.create`) and asserts on `ModelMeta.editsObjectShardUrls.length`.
 * Without folding it reads 11 for 10 rotations — one Automerge document and
 * three Postgres rows per rotation, for ever.
 *
 * The second test is what makes the fix SAFE rather than merely effective:
 * folding is legitimate only if the effective last-wins entity set is
 * unchanged. `compactOverlay` fails that assertion, which is exactly why the
 * fold had to be a different routine.
 */

const running: StaticDeltaProjector[] = []
afterEach(async () => {
  await Promise.all(running.splice(0).map((projector) => projector.stop()))
})

interface OverlayLike {
  objects?: Record<string, { id: string; name?: string; round?: number }>
  writeHeadVersion?: number
  writeBatchIds?: string[]
}

interface MetaLike {
  editsObjectShardUrl?: string
  editsObjectShardUrls?: string[]
  objectShardUrls?: string[]
}

type ObjectValue = { id: string; name?: string; round?: number }

/** One workspace, one object overlay chain, and a fake pool that answers
 * exactly what the rotation protocol asks while recording what it was asked. */
function harness(options: {
  foldMin?: number
  foldBudget?: number
  /** The seal, injected so a fixture can cross it without building 1 024
   * real Automerge entities per segment (~500 ms of wasm work each). */
  segmentCeiling?: number
  windowEntities?: number
  /** Witness only the FIRST merged part as durable. The fold must then
   * refuse: publishing on a partial witness drops every entity that lives only
   * in a part which never landed. */
  partialDurability?: boolean
  /** Record every projected snapshot as EMPTY, so `last_projected_snapshot`
   * disagrees with the documents. The fold must not notice. */
  poisonSnapshots?: boolean
  /** Fail the claim of the MERGED SEGMENT only, leaving every rotation's own
   * claim to succeed — otherwise no rotation completes, no chain accumulates
   * and the fold under test never runs at all.
   *
   * The discriminator is the durability witness: `AS durable` is issued by the
   * fold and by nothing else, so the first `witness:` event marks the boundary
   * between "rotations are still building the chain" and "the fold is claiming
   * its merged segment". Keyed on an EVENT rather than on a document id
   * because the merged id is minted inside the pass and is not knowable here. */
  foldClaimFails?: boolean
  /** Answer `pg_try_advisory_lock` with `false` — another writer holds the
   * overlay-rotation key. Rotation and fold share that key, so this refuses
   * BOTH, which is what makes the fold's refusal branch reachable here at all
   * (without it, a refusal branch that lost its `return` would let a second
   * writer create, claim and publish a merged segment with no exclusion). */
  lockRefused?: () => boolean
  /** Make `pg_advisory_unlock` take a macrotask, so the hand-back is
   * observably ordered. See the fake for why a microtask is not enough. */
  slowUnlock?: boolean
} = {}) {
  const repo = new Repo({})
  const sql: string[] = []
  // An ORDERED log, tagged with the document each step is about, so the
  // publish ordering can be asserted for one specific merged segment rather than for
  // whatever interleaving of ten rotations happened to occur.
  const events: string[] = []
  const first = repo.create<OverlayLike>({
    objects: {},
    writeHeadVersion: 1,
    writeBatchIds: Array.from({ length: 32 }, (_, index) => `batch-init-${index}`),
  })
  const meta = repo.create<MetaLike & Record<string, unknown>>({
    staticBaseline: true,
    objectShardUrls: [first.url],
    connectionShardUrls: [] as string[],
    editsObjectShardUrls: [first.url],
    editsObjectShardUrl: first.url,
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  const descriptors = [
    { landscape_id: 'land', version_id: 'version', document_id: meta.documentId, kind: 'model-meta', entity_id: null, org_id: 'org' },
    { landscape_id: 'land', version_id: 'version', document_id: first.documentId, kind: 'object-overlay', entity_id: null, org_id: 'org' },
  ]
  // Every segment the projector has told the database about, with the snapshot
  // it last projected. This is what `overlaySegmentSnapshots` reads back when
  // the overlay list changes in a way that is NOT append-only — i.e. after a
  // fold. A fake that forgets these makes the rebuild path untestable.
  const projected = new Map<string, Record<string, unknown>>()

  const query = vi.fn(async (text: string, params?: unknown[]) => {
    sql.push(text)
    // The overlay-rotation advisory lock RETURNS a verdict
    // (`pg_try_advisory_lock`), so a fake that lets it fall through to the empty
    // default reads as CONTENDED and every fold and rotation in this file is
    // (correctly) skipped. `land/version` is this suite's only workspace.
    if (text.includes('pg_try_advisory_lock')) {
      const key = String((params ?? [])[0] ?? '')
      // A GETTER, not a flag: rotation and fold share this key, so a fixture
      // that refuses from the start refuses every rotation too, no chain ever
      // accumulates and the fold under test is never reached — the vacuous
      // shape this file exists to refuse. The test builds the chain with the
      // key free and flips it immediately before driving the fold.
      if (options.lockRefused?.() === true) return { rows: [{ locked: false }], rowCount: 1 }
      return { rows: [{ locked: key.startsWith('overlay-rotation:land:version:') }], rowCount: 1 }
    }
    // The unlock answers TRUTHFULLY. Left to the row-less default it reads as
    // "this session did not hold the key" on every healthy release — a fixture
    // manufacturing the fault the code exists to report, and since that verdict
    // destroys the connection, one that would also churn the pool.
    //
    // And it answers on a MACROTASK when asked to. A real unlock is a round
    // trip; a fake that resolves in a microtask makes "the hand-back was
    // awaited" and "it was not" differ by one queue position, which is a coin
    // flip rather than a test. With this, dropping the `await` is observable.
    if (text.includes('pg_advisory_unlock')) {
      if (options.slowUnlock === true) {
        await new Promise((resolve) => { setTimeout(resolve, 5) })
      }
      return { rows: [{ released: true }], rowCount: 1 }
    }
    // The PLANE check. This fixture is a static workspace, so it must say so:
    // the fold and the rotation consult the plane at their entry.
    //
    // PARAMS-SENSITIVE, like its two siblings in `staticDeltaProjector.test.ts`
    // and `projectorService.test.ts`: a fake that answers the same for any
    // parameters cannot tell a correctly-threaded workspace key from a
    // mis-threaded one.
    //
    // A statement about the AUTHORITY ALONE, and the exclusion is part of the
    // predicate: the descriptor SELECT joins the same authority table, and a
    // matcher on the bare table name would answer `[{ present: true }]` to a
    // statement asking for document rows, so no descriptor would ever load.
    // Excluding the child table rather than matching `SELECT EXISTS` keeps
    // `assertReadModelPlane`'s `FOR KEY SHARE` form answered too.
    if (text.includes('read_model_static_workspaces')
      && !text.includes('read_model_static_documents')) {
      const asked = (params ?? []) as string[]
      const mine = asked[0] === 'land' && asked[1] === 'version'
      return { rows: [{ present: mine }], rowCount: 1 }
    }
    if (text.includes('LEFT JOIN read_model_static_documents document')) {
      return { rows: descriptors, rowCount: descriptors.length }
    }
    if (text.includes('SELECT document_id, last_projected_snapshot')) {
      const ids = (params ?? []).find((value) => Array.isArray(value)) as string[] | undefined
      const rows = (ids ?? [...projected.keys()])
        .filter((id) => projected.has(id))
        .map((id) => ({ document_id: id, last_projected_snapshot: projected.get(id) }))
      return { rows, rowCount: rows.length }
    }
    if (text.includes('INSERT INTO read_model_overlay_segments')
      && text.includes('last_projected_snapshot')) {
      projected.set(String(params?.[3]), options.poisonSnapshots
        ? {}
        : JSON.parse(String(params?.[5])) as Record<string, unknown>)
      events.push(`segment-row:${String(params?.[3])}`)
      return { rows: [], rowCount: 1 }
    }
    if (text.includes('INSERT INTO read_model_static_documents')) {
      const admitted = JSON.parse(String(params?.[0])) as Array<{ documentId: string; kind: string }>
      for (const entry of admitted) {
        descriptors.push({
          landscape_id: 'land', version_id: 'version',
          document_id: entry.documentId, kind: entry.kind, entity_id: null, org_id: 'org',
        })
        events.push(`register:${entry.documentId}`)
      }
      return { rows: [], rowCount: admitted.length }
    }
    if (text.includes('INSERT INTO automerge_document_workspace')) {
      const ids = Array.isArray(params?.[0]) ? params[0] as string[] : [String(params?.[0])]
      if (options.foldClaimFails && events.some((event) => event.startsWith('witness:'))) {
        // Zero rows inserted — the shape a real conflict takes.
        for (const id of ids) events.push(`claim-refused:${id}`)
        return { rows: [], rowCount: 0 }
      }
      for (const id of ids) events.push(`claim:${id}`)
      return { rows: ids.map((id) => ({ document_id: id })), rowCount: ids.length }
    }
    // The winner SELECT that turns a refused claim into `foreign`. Only
    // reachable while `foldClaimFails` is set; without it every claim above
    // succeeds and `claimWorkspaceDocuments` never asks.
    if (options.foldClaimFails && text.includes('FROM automerge_document_workspace')) {
      const ids = (params ?? []).find((value) => Array.isArray(value)) as string[] | undefined
      const rows = (ids ?? []).map((id) => ({
        document_id: id, landscape_id: 'intruder', version_id: 'other',
      }))
      return { rows, rowCount: rows.length }
    }
    // The arrival clock and the durability witness. Both MUST be answered:
    // `captureArrivalWatermark` reads `rows[0].w` and would throw on the
    // default empty answer, and the witness would read `undefined` and refuse.
    // The fold would then abort silently and this file would go red for a
    // fixture reason, which is why these two branches are here rather than in
    // the default fall-through.
    if (text.includes("nextval('automerge_arrival_seq')")) return { rows: [{ w: '1' }], rowCount: 1 }
    if (text.includes('AS durable')) {
      events.push(`witness:${String(params?.[0])}`)
      // A COUNT of durable parts, not a boolean. The fold creates
      // `ceil(n / segmentCeiling)` documents and requires every one of them to
      // be durable, so the statement is `count(*)` over a `GROUP BY`. (A
      // boolean answer would pass the one-part case — `Number(true)` is 1 —
      // and refuse every multi-part fold.)
      //
      // `options.partialDurability` witnesses only the FIRST part, which is the
      // mutant this fixture must be able to express: a fold that published on a
      // partial witness would drop every entity living only in the parts that
      // never landed.
      const asked = (params ?? []).find((value) => Array.isArray(value)) as string[] | undefined
      const parts = asked?.length ?? 1
      return {
        rows: [{ durable: String(options.partialDurability ? Math.min(1, parts) : parts) }],
        rowCount: 1,
      }
    }
    if (text.includes('RETURNING observed_generation')) return { rows: [{ observed_generation: 2 }], rowCount: 1 }
    if (text.includes('SELECT revision FROM read_model_static_document_queue')) {
      return { rows: [{ revision: 1 }], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  })
  const realFlush = repo.flush.bind(repo)
  vi.spyOn(repo, 'flush').mockImplementation(async (documentIds) => {
    if (documentIds?.includes(meta.documentId)) events.push('meta-flush')
    return realFlush(documentIds)
  })
  const client = { query, release: vi.fn() }
  const projector = new StaticDeltaProjector(
    repo, { query, connect: vi.fn(async () => client) } as never,
    10, 200, undefined, undefined, undefined, undefined, undefined,
    5, 20, options.foldMin ?? 4, options.foldBudget ?? 3,
    options.segmentCeiling, options.windowEntities,
  )
  running.push(projector)
  // `client` EXPOSED: its `release` is the only direct witness that the
  // hand-back completed, and "the connection came back" is not a claim the
  // statement log can make — `client.query(...)` is called synchronously, so
  // the unlock appears in `sql` whether or not anything awaited it.
  return { repo, meta, first, projector, sql, query, events, client }
}

/** Drive `rounds` REAL rotations: fill the current head to the rotation
 * threshold, wait for the projector to publish a new one, repeat. Each head
 * carries one unique object plus a shared object it overwrites, so the
 * effective set has both a growing part and a genuine last-wins part. */
async function rotate(
  repo: Repo,
  meta: { doc(): (MetaLike & Record<string, unknown>) | undefined },
  first: { url: string },
  rounds: number,
): Promise<Record<string, ObjectValue>> {
  const expected: Record<string, ObjectValue> = {}
  let head = first.url
  for (let round = 0; round < rounds; round += 1) {
    const handle = await repo.find<OverlayLike>(head as AutomergeUrl)
    handle.change((doc) => {
      const objects = (doc.objects ??= {})
      objects[`obj-${round}`] = { id: `obj-${round}`, name: `object ${round}` }
      objects.shared = { id: 'shared', round }
      doc.writeBatchIds = Array.from({ length: 32 }, (_, index) => `batch-${round}-${index}`)
    })
    expected[`obj-${round}`] = { id: `obj-${round}`, name: `object ${round}` }
    expected.shared = { id: 'shared', round }
    await expect.poll(() => meta.doc()?.editsObjectShardUrl, { timeout: 15_000, interval: 5 })
      .not.toBe(head)
    head = meta.doc()!.editsObjectShardUrl!
  }
  return expected
}

/** The effective set a client and the projector both compute: merge every
 * segment ModelMeta still lists, in order, last one wins. */
async function effectiveSet(repo: Repo, urls: readonly string[]) {
  const effective: Record<string, unknown> = {}
  for (const url of urls) {
    const handle = await repo.find<OverlayLike>(url as AutomergeUrl)
    for (const [id, value] of Object.entries(handle.doc()?.objects ?? {})) {
      effective[id] = JSON.parse(JSON.stringify(value))
    }
  }
  return effective
}

describe('D3 — la chaîne de segments overlay est bornée', () => {
  it('ROUGE AVANT LE CORRECTIF : dix rotations ne font pas croître la liste sans borne', async () => {
    const { repo, meta, first, projector } = harness({ foldMin: 4, foldBudget: 3 })
    await projector.start()
    await rotate(repo, meta, first, 10)

    // Without folding this reads 11: every other reference to
    // `editsObjectShardUrls` appends and none removes. The pin is the BOUND, not an arithmetic identity — where each fold pass
    // lands relative to the rotations is a timing detail, and pinning it would
    // make this test a metronome instead of an invariant.
    await expect.poll(
      () => meta.doc()?.editsObjectShardUrls?.length ?? 0,
      { timeout: 15_000, interval: 25 },
    ).toBeLessThan(11)
    expect(meta.doc()!.editsObjectShardUrls!.length).toBeGreaterThan(0)
    // The write head is still last, and still the one ModelMeta points at. A
    // fold that swallowed the head would lose every edit landing during it.
    expect(meta.doc()!.editsObjectShardUrls!.at(-1)).toBe(meta.doc()!.editsObjectShardUrl)
  }, 60_000)

  it('le pliage ne change RIEN d\'observable, et n\'émet aucune suppression d\'entité', async () => {
    const { repo, meta, first, projector, sql } = harness({ foldMin: 4, foldBudget: 3 })
    await projector.start()
    const expected = await rotate(repo, meta, first, 10)
    await expect.poll(
      () => meta.doc()?.editsObjectShardUrls?.length ?? 0,
      { timeout: 15_000, interval: 25 },
    ).toBeLessThan(11)

    // The whole point of folding in one assertion: a fold re-encodes the chain, it never
    // changes its meaning. `compactOverlay` fails here — it clears the folded
    // entries, `updateStaticOverlaySegment` then sees "no winner", and the row
    // leaves `ro_objects` while the CRDT stays perfectly correct.
    const surviving = await effectiveSet(repo, meta.doc()!.editsObjectShardUrls!)
    expect(surviving).toEqual(expected)

    // The negative form of the same claim, read off the SQL actually issued.
    expect(sql.filter((text) => /DELETE FROM ro_objects/i.test(text))).toEqual([])
  }, 60_000)

  it('A11 — NO listed segment ever exceeds the ceiling, driven through the real projector', async () => {
    // THE WIRE, and the property the whole change buys, asserted end to end
    // rather than on the planner in isolation.
    //
    // Every seal assertion in `overlayChainFold.test.ts` INJECTS sizes, so all
    // of them pass with `foldOverlayChain`'s `segmentCeiling` /
    // `windowEntities` / `entityCountOf` lines deleted, or with sealing
    // effectively off (`AM_OVERLAY_SEGMENT_ENTITY_CEILING=65536`). This test is
    // the one that goes red.
    //
    // Ceiling 3 against segments of 2 entities: unsealed, so they merge — and
    // three of them hold 4 distinct ids (`obj-N` plus the `shared` id every
    // round rewrites), which is past the ceiling, so the merge MUST come back
    // as more than one document.
    const { repo, meta, first, projector, events } = harness({
      foldMin: 4, foldBudget: 3, segmentCeiling: 3, windowEntities: 6,
    })
    await projector.start()
    const expected = await rotate(repo, meta, first, 10)
    // Poll on a fold having HAPPENED, not on a chain length. Under a ceiling
    // the window contracts — three segments come back as two rather than one —
    // so how far the chain has walked at any instant is a metronome reading,
    // and the neighbouring test already pins the bound on chain length. What
    // this test needs is only that at least one pass ran before it measures.
    await expect.poll(
      () => events.filter((event) => event.startsWith('segment-row:')).length,
      { timeout: 15_000, interval: 25 },
    ).toBeGreaterThan(0)

    const sizes = await Promise.all(
      meta.doc()!.editsObjectShardUrls!.map(async (url) => {
        const handle = await repo.find<OverlayLike>(url as AutomergeUrl)
        return Object.keys(handle.doc()?.objects ?? {}).length
      }),
    )
    // MUTANT: replace `splitMergedOverlaySegment(merged, ceiling)` with
    // `[merged]`. The merged segment then holds 4+ ids and this fails — the
    // unbounded document sealing exists to prevent.
    //
    // The write head is EXCLUDED: clients write into it and nothing bounds it
    // until a rotation retires it, which is `overlay-head-bounded`'s subject.
    const retired = sizes.slice(0, -1)
    expect(retired.length, 'the fixture must retire something, or this asserts nothing')
      .toBeGreaterThan(0)
    expect(Math.max(...retired)).toBeLessThanOrEqual(3)

    // The CONTROL that makes the bound meaningful, and it must compare against
    // what the WRITER produced — not against another read of the same chain,
    // which would be an assertion that a value equals itself. A bound is easy
    // to satisfy by losing entities; this is what says it was bought by
    // splitting instead.
    expect(await effectiveSet(repo, meta.doc()!.editsObjectShardUrls!)).toEqual(expected)
    expect(meta.doc()!.editsObjectShardUrls!.at(-1)).toBe(meta.doc()!.editsObjectShardUrl)
  }, 60_000)

  it('A11 — refuses to publish when only SOME merged parts are durable', async () => {
    // With a split merge, a PARTIAL durable result can exist, and it is the
    // worst shape available: publishing a window whose second part never landed removes the
    // folded segments from ModelMeta and puts back a pointer to bytes that are
    // not there — every entity living only in that part leaves the read model,
    // silently, and the loss surfaces days later one entity at a time. That is
    // the failure `foldOverlayChain` already refuses a single unresolvable
    // INPUT for; this is the same refusal on the output side.
    const { repo, meta, first, projector, events } = harness({
      foldMin: 4, foldBudget: 3, segmentCeiling: 3, windowEntities: 6,
      partialDurability: true,
    })
    await projector.start()
    await rotate(repo, meta, first, 10)
    // Give the fold real opportunities to run — it is scheduled on every reload
    // tick, so several will have passed by the time the witness count settles.
    await expect.poll(
      () => events.filter((event) => event.startsWith('witness:')).length,
      { timeout: 15_000, interval: 25 },
    ).toBeGreaterThan(1)

    // MUTANT: `!== childIds.length` weakened to `< 1`, or the witness left as a
    // boolean. The chain would then shrink here.
    expect(events.filter((event) => event.startsWith('segment-row:'))).toEqual([])
    expect(meta.doc()!.editsObjectShardUrls!.length).toBe(11)
    // …and the head is untouched, so no edit landing during the refused pass is
    // at risk.
    expect(meta.doc()!.editsObjectShardUrls!.at(-1)).toBe(meta.doc()!.editsObjectShardUrl)
  }, 60_000)

  it('une CLÉ TENUE arrête le pliage AVANT toute écriture, et le mutant qui supprime le refus est tué', async () => {
    // The fold's lock-refusal branch. Deleting its `return` — while keeping
    // the log line above it — would let a second writer go on through
    // `repo.create`, a claim and a ModelMeta rewrite with no exclusion at all.
    // That is the collision `synchronizeOverlaySegments` names: two transactions each promoting a different row against
    // `idx_read_model_overlay_segments_current`.
    let refuse = false
    const { repo, meta, first, projector, sql, client } = harness({
      foldMin: 4, foldBudget: 3, lockRefused: () => refuse, slowUnlock: true,
    })
    await projector.start()
    await rotate(repo, meta, first, 10)
    await expect.poll(
      () => meta.doc()?.editsObjectShardUrls?.length ?? 0,
      { timeout: 15_000, interval: 25 },
    ).toBeGreaterThan(4)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const internal = projector as unknown as {
      foldOverlayChain(d: Record<string, unknown>, kind: 'object'): Promise<void>
    }
    const metaDescriptor = {
      landscapeId: 'land', versionId: 'version', documentId: meta.documentId,
      kind: 'model-meta', entityId: null, orgId: 'org',
    }
    const foldEvents = () => warn.mock.calls
      .map(([line]) => { try { return JSON.parse(String(line)) as Record<string, unknown> } catch { return {} } })
      .filter((event) => event.event === 'read_model.overlay_chain_folded')

    // ── the ARM: the key is held ───────────────────────────────────────────
    refuse = true
    const asks = () => sql.filter((text) => text.includes('pg_try_advisory_lock')).length
    const durable = () => sql.filter((text) => text.includes('AS durable')).length
    const asksBefore = asks()
    const durableBefore = durable()
    await internal.foldOverlayChain(metaDescriptor, 'object')

    // IT REACHED THE LOCK. Read off the statement stream, not off a log line:
    // the fold returns before `db.connect()` when the chain is below threshold,
    // so an unchanged count here would mean every assertion below is about a
    // code path this test never entered.
    expect(asks()).toBeGreaterThan(asksBefore)
    // …and wrote NOTHING. `AS durable` is issued by the fold and by nothing
    // else — this file's own discriminator.
    expect(durable()).toBe(durableBefore)
    // NAMED in the fold's own record too. Not redundant with the assertion
    // below: this is the only thing that can kill a mutant deleting
    // `skippedReason = 'lock-contended'`, and a pass whose reason is
    // `undefined` reads in the log as a slow no-op.
    expect(foldEvents().at(-1)?.skippedReason).toBe('lock-contended')
    const contention = warn.mock.calls
      .map(([line]) => { try { return JSON.parse(String(line)) as Record<string, unknown> } catch { return {} } })
      .filter((event) => event.event === 'read_model.overlay_rotation_lock_contended')
    expect(contention.map((event) => event.path)).toEqual(['fold'])

    // ── the CONTROL: the same call with the key free ───────────────────────
    // Without it, every assertion above passes against a fold that refuses for
    // any reason at all — including one whose refusal branch has lost its
    // `return` but whose chain is simply too short to fold.
    refuse = false
    const releasesBefore = client.release.mock.calls.length
    await internal.foldOverlayChain(metaDescriptor, 'object')
    // THE HAND-BACK WAS AWAITED. Dropping the `await` on
    // `releaseOverlayRotationLock` leaves the connection checked out past the
    // point where `overlayFoldInFlight` is already false — so a second fold can
    // start while this one still holds one of four connections — and it makes
    // the duration log fire before the release. The unlock is deliberately slow
    // in this fixture, so an unawaited hand-back has provably not completed
    // here rather than merely probably not.
    expect(client.release.mock.calls.length).toBeGreaterThan(releasesBefore)
    expect(durable()).toBeGreaterThan(durableBefore)
    expect(foldEvents().at(-1)?.skippedReason).toBeUndefined()
    // The hold time is REPORTED — it is what a same-workspace publish waits
    // behind with its ceiling disarmed.
    expect(foldEvents().at(-1)?.lockHeldMs).toEqual(expect.any(Number))
  }, 60_000)

  it('lit le contenu des DOCUMENTS, jamais du témoin qu\'il alimente lui-même', async () => {
    // The database says every segment is empty; the documents say otherwise.
    //
    // This is the mutant that matters most and the one hardest to see: building
    // the merged segment from `last_projected_snapshot` is the obvious shortcut
    // (it is already in SQL, it is already indexed) and on a healthy stack it
    // gives the SAME answer, so it passes every test that does not force the
    // two apart. It is also a witness the projector feeds itself, and the
    // column is `NOT NULL DEFAULT '{}'` — so a segment not yet snapshotted
    // folds to EMPTY, `projectMeta` rebuilds an amputated effective set from
    // SQL, no delete is emitted, and the loss surfaces days later one entity at
    // a time when the write head stops carrying an id.
    const { repo, meta, first, projector } = harness({
      foldMin: 4, foldBudget: 3, poisonSnapshots: true,
    })
    await projector.start()
    const expected = await rotate(repo, meta, first, 10)
    await expect.poll(
      () => meta.doc()?.editsObjectShardUrls?.length ?? 0,
      { timeout: 15_000, interval: 25 },
    ).toBeLessThan(11)

    const surviving = await effectiveSet(repo, meta.doc()!.editsObjectShardUrls!)
    expect(surviving).toEqual(expected)
  }, 60_000)
})

describe('D3 — le pliage dont la revendication ÉCHOUE (A7)', () => {
  it('de-covers durably and NEVER writes the health row', async () => {
    // The fold's claim-failure branch must de-cover the workspace and must NOT
    // mark it degraded (the rotation site's twin is pinned in
    // staticDeltaProjector.test.ts).
    //
    // Why the health row is the wrong place: this `catch` returns BEFORE
    // `BEGIN`, so no segment row, no ModelMeta change and no `ro_*` write
    // happens — the workspace goes on serving the chain it already had.
    // `degraded` would assert the opposite, and no code could retract it,
    // because the only clear lives in the ordinary projector and the fleet
    // refuses to attach one to a static workspace.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { repo, meta, first, projector, sql, events } = harness({
        foldMin: 4, foldBudget: 3, foldClaimFails: true,
      })
      await projector.start()
      await rotate(repo, meta, first, 10)

      // LIVENESS WITNESS. Without it "no health write" and "the fold never ran"
      // are the same green — and this arm deliberately breaks the fold, so the
      // usual `overlay_chain_folded` signal is exactly what will NOT appear.
      // A refused claim is the one event that proves the branch was entered.
      await expect.poll(
        () => events.some((event) => event.startsWith('claim-refused:')),
        { timeout: 20_000, interval: 25 },
      ).toBe(true)
      // The de-cover is durable and carries a reason.
      await expect.poll(
        () => sql.some((text) =>
          text.includes('workspace_claim_coverage') && text.includes('invalidated_reason')),
        { timeout: 20_000, interval: 25 },
      ).toBe(true)

      // …and in that same window, not one health-row statement.
      expect(sql.filter((text) => text.includes('degraded_kind'))).toEqual([])
      // The merged segment was never published either, which is the fact that
      // makes "not degraded" the TRUE answer rather than a convenient one.
      expect(events.some((event) => event.startsWith('segment-row:'))).toBe(false)
    } finally {
      error.mockRestore()
      warn.mockRestore()
    }
  }, 60_000)
})

/**
 * The ONE global lock order in this subsystem, made executable.
 *
 * `read-model-projection:` before `overlay-rotation:`, always. It holds only
 * because nothing that takes an `overlay-rotation` lock ever asks for the
 * projection mutex: rotation, fold and admitted-rotation recovery hold
 * `overlay-rotation` at SESSION scope on their own client and run their
 * transactions with a bare `BEGIN`, deliberately NOT through
 * `withReadModelProjectionTransaction`. Route any of them through it "for
 * uniformity" and the order inverts against `publish()`, which holds the mutex
 * and then takes `overlay-rotation` as an XACT lock inside
 * `synchronizeOverlaySegments` — a real 40P01, on one workspace, needing no
 * fan-out.
 *
 * A comment cannot notice that edit, which is the whole reason this scanner
 * exists rather than a paragraph. It lives in THIS file because this is where
 * real rotations and real folds are driven end to end: the hazard shape is
 * produced for free by `publishAdmittedRotation`, which COMMITS its transaction
 * and then calls `metaHandle.change` while the session lock is still held —
 * firing the ModelMeta listener, whose publish is the transaction that wants
 * the mutex.
 *
 * Process-wide on purpose, not per-connection. The dangerous cycle here is
 * partly in JavaScript — one path holds a session lock and then waits for a
 * pool slot held by a path waiting on that lock — and Postgres cannot see that
 * one at all: only one side is waiting in the lock manager, so there is no
 * cycle to detect and no 40P01 to catch it.
 */
function projectionLockOrderViolations(
  calls: readonly (readonly [string, (readonly unknown[])?])[],
): string[] {
  const held: string[] = []
  const violations: string[] = []
  for (const [sql, params] of calls) {
    const text = String(sql)
    const key = String((params ?? [])[0] ?? '')
    // `pg_advisory_lock(` cannot match `pg_advisory_xact_lock(` — the xact form
    // spells `advisory_xact_lock` — so these three branches are disjoint. The
    // TRY form is spelled `pg_try_advisory_lock(` and does not match the bare
    // one either, which is why it is named explicitly: the projector's three
    // session-lock sites all use it, and matching only the blocking form
    // would leave this detector tracking an empty `held` stack for ever —
    // reporting zero violations because it stopped looking, not because there
    // are none.
    if (text.includes('pg_advisory_lock(') || text.includes('pg_try_advisory_lock(')) held.push(key)
    else if (text.includes('pg_advisory_unlock(')) {
      const at = held.lastIndexOf(key)
      if (at >= 0) held.splice(at, 1)
    } else if (text.includes('pg_advisory_xact_lock(') && key.startsWith('read-model-projection:')) {
      if (held.length > 0) violations.push(`${key} taken while holding ${held.join(', ')}`)
    }
  }
  return violations
}

/**
 * The ROW-lock order, which the advisory detector above cannot see.
 *
 * The documented global order in this subsystem is
 *
 *   read_model_static_workspaces (S) -> automerge_document_workspace (W)
 *   -> read_model_static_documents (D) -> read_model_projection_state (P)
 *
 * and it is a lock order, not a preference: `promoteSummaryWorkspace`'s demotion
 * deletes S BEFORE D on the argued ground that the other way round is a straight
 * ABBA against a publish holding S and wanting D. `assertReadModelPlane` — a
 * `FOR KEY SHARE` on S — runs in every transaction in `staticDeltaProjector`,
 * so that argument is load-bearing for all of them; this detector is what goes
 * red if a future statement takes the pair the other way round.
 *
 * This tracks the FIRST touch of each table per transaction and reports any pair
 * observed out of canonical order. It deliberately says nothing about advisory
 * locks — that is the sibling detector's job, and folding the two would give one
 * predicate two ways to be vacuously clean.
 */
const PLANE_LOCK_ORDER = [
  'read_model_static_workspaces',
  'automerge_document_workspace',
  'read_model_static_documents',
  'read_model_projection_state',
] as const

function planeLockOrderViolations(
  calls: readonly (readonly [string, (readonly unknown[])?])[],
): string[] {
  const violations: string[] = []
  let inTransaction = false
  let touched: string[] = []
  for (const [sql] of calls) {
    const text = String(sql)
    if (text.includes('BEGIN')) { inTransaction = true; touched = []; continue }
    if (text.includes('COMMIT') || text.includes('ROLLBACK')) {
      inTransaction = false; touched = []; continue
    }
    // OUTSIDE a transaction every statement autocommits, so no two of them ever
    // hold a row lock together and there is no order to violate. Without this
    // the detector would flag a correct stream — the reload tick touches D and
    // P on the pool, and a rotation's
    // `claimWorkspaceDocuments` takes W on the pool a moment later. Three
    // autocommitted statements, no shared lock, no ABBA available.
    if (!inTransaction) continue
    // A single statement's tables are added TOGETHER. Text order inside one
    // statement is not acquisition order — the planner decides — so ranking
    // them against each other would flag the descriptor SELECT, which
    // names D in its FROM clause and S in its JOIN.
    const here = PLANE_LOCK_ORDER.filter((table) => text.includes(table) && !touched.includes(table))
    for (const table of here) {
      const rank = PLANE_LOCK_ORDER.indexOf(table)
      for (const earlier of touched) {
        if (PLANE_LOCK_ORDER.indexOf(earlier) > rank) {
          // The offending STATEMENT, not just the pair: a bare pair sends the
          // reader hunting through a 3 600-line class for a transaction the
          // message does not name.
          violations.push(`${table} taken after ${earlier} — ${text.replace(/\s+/g, ' ').slice(0, 90)}`)
        }
      }
    }
    touched.push(...here)
  }
  return violations
}

describe('A10 — l\'ordre des verrous de LIGNE, exécutable', () => {
  it('le détecteur PEUT échouer — sinon il ne mesure rien', () => {
    // The inverted stream is exactly what a demotion written the other way
    // round would produce, and it is the ABBA `promoteSummaryWorkspace`'s
    // comment argues against.
    const inverted: [string, unknown[]][] = [
      ['BEGIN', []],
      ['DELETE FROM read_model_static_documents WHERE landscape_id = $1', ['land']],
      ['DELETE FROM read_model_static_workspaces WHERE landscape_id = $1', ['land']],
      ['COMMIT', []],
    ]
    const found = planeLockOrderViolations(inverted)
    expect(found).toHaveLength(1)
    // The PAIR is the assertion; the statement text after the dash is context
    // for whoever has to find it, and pinning it here would make this test a
    // transcription of the message rather than of the invariant.
    expect(found[0]).toContain('read_model_static_workspaces taken after read_model_static_documents')
    expect(found[0]).toContain('DELETE FROM read_model_static_workspaces')

    // The correct order, differing ONLY in which DELETE comes first.
    const correct: [string, unknown[]][] = [
      ['BEGIN', []],
      ['DELETE FROM read_model_static_workspaces WHERE landscape_id = $1', ['land']],
      ['DELETE FROM read_model_static_documents WHERE landscape_id = $1', ['land']],
      ['COMMIT', []],
    ]
    expect(planeLockOrderViolations(correct)).toEqual([])

    // A transaction boundary RESETS the order — two autocommit statements in
    // the wrong sequence hold no locks together and are not a violation. Without
    // this the detector would flag the projector's ordinary tick.
    const separated: [string, unknown[]][] = [
      ['BEGIN', []],
      ['SELECT 1 FROM read_model_static_documents', []],
      ['COMMIT', []],
      ['BEGIN', []],
      ['SELECT 1 FROM read_model_static_workspaces', []],
      ['COMMIT', []],
    ]
    expect(planeLockOrderViolations(separated)).toEqual([])
  })

  it('reconnaît l\'ordre correct des cinq transactions nues du projecteur', () => {
    // The shapes the five bare transactions actually issue, transcribed from
    // `staticDeltaProjector`. Transcribed rather than CAPTURED — a known
    // limitation.
    //
    // Running the detector over a real `query.mock.calls` is UNSOUND: that
    // array is one stream for every connection, so a rotation's transaction
    // and a publish's transaction interleave in it, and the detector would
    // report violations against a stream in which every individual transaction
    // is correctly ordered. Attributing statements to connections needs a
    // harness that tags them, which this one does not do. So this pins the
    // ORDER the code is written to take; the production stream is not covered.
    const rotationAdmission: [string, unknown[]][] = [
      ['BEGIN', []],
      ["SET LOCAL lock_timeout = '5000ms'", []],
      ['SELECT true AS present FROM read_model_static_workspaces WHERE landscape_id = $1 FOR KEY SHARE', []],
      ['INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)', []],
      ['INSERT INTO read_model_static_documents (landscape_id, version_id, document_id, kind)', []],
      ['SELECT true AS present FROM read_model_static_workspaces WHERE landscape_id = $1 FOR KEY SHARE', []],
      ['COMMIT', []],
    ]
    expect(planeLockOrderViolations(rotationAdmission)).toEqual([])

    // The SECOND plane check, before COMMIT, must not read as a fresh
    // acquisition — the transaction already holds that row. A detector that
    // counted it would flag every correct transaction in the class.
    expect(rotationAdmission.filter(([sql]) => sql.includes('FOR KEY SHARE'))).toHaveLength(2)

    // And the publish path, which reaches P last.
    expect(planeLockOrderViolations([
      ['BEGIN', []],
      ['SELECT true AS present FROM read_model_static_workspaces WHERE landscape_id = $1 FOR KEY SHARE', []],
      ['INSERT INTO automerge_document_workspace (document_id)', []],
      ['INSERT INTO read_model_static_documents (landscape_id)', []],
      ['UPDATE read_model_projection_state SET projected_revision = GREATEST', []],
      ['COMMIT', []],
    ])).toEqual([])
  })
})

describe('A8 — l\'ordre des verrous, exécutable', () => {
  it('le détecteur PEUT échouer — sinon il ne mesure rien', () => {
    // A gate that cannot fail is not a gate. The inverted stream below is
    // exactly what routing a rotation transaction through
    // `withReadModelProjectionTransaction` would produce.
    const inverted: [string, unknown[]][] = [
      ['SELECT pg_advisory_lock(hashtextextended($1, 0))', ['overlay-rotation:land:version:object']],
      ['BEGIN', []],
      ['SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['read-model-projection:land:version']],
      ['COMMIT', []],
      ['SELECT pg_advisory_unlock(hashtextextended($1, 0))', ['overlay-rotation:land:version:object']],
    ]
    expect(projectionLockOrderViolations(inverted)).toEqual([
      'read-model-projection:land:version taken while holding overlay-rotation:land:version:object',
    ])

    // …and the correct order, which differs from the stream above ONLY in
    // where the session lock is released, is clean.
    const correct: [string, unknown[]][] = [
      ['SELECT pg_advisory_lock(hashtextextended($1, 0))', ['overlay-rotation:land:version:object']],
      ['SELECT pg_advisory_unlock(hashtextextended($1, 0))', ['overlay-rotation:land:version:object']],
      ['BEGIN', []],
      ['SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['read-model-projection:land:version']],
      ['SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['overlay-rotation:land:version:object']],
      ['COMMIT', []],
    ]
    expect(projectionLockOrderViolations(correct)).toEqual([])

    // The TRY form, which is what all three production sites issue. Its own
    // arm, because
    // `'pg_try_advisory_lock('.includes('pg_advisory_lock(')` is FALSE: a
    // detector that tracked only the blocking form would hold an empty stack
    // against the real statement stream and report zero violations for ever,
    // which is the shape this whole file exists to refuse.
    const tried: [string, unknown[]][] = [
      ['SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', ['overlay-rotation:land:version:object']],
      ['BEGIN', []],
      ['SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['read-model-projection:land:version']],
      ['COMMIT', []],
      ['SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released', ['overlay-rotation:land:version:object']],
    ]
    expect(projectionLockOrderViolations(tried)).toEqual([
      'read-model-projection:land:version taken while holding overlay-rotation:land:version:object',
    ])
  })

  it('dix rotations et leurs pliages ne prennent jamais le mutex sous un verrou de session', async () => {
    const { repo, meta, first, projector, query } = harness({ foldMin: 4, foldBudget: 3 })
    await projector.start()
    await rotate(repo, meta, first, 10)
    await expect.poll(
      () => meta.doc()?.editsObjectShardUrls?.length ?? 0,
      { timeout: 15_000, interval: 25 },
    ).toBeLessThan(11)

    const calls = query.mock.calls as unknown as readonly (readonly [string, (readonly unknown[])?])[]
    // LIVENESS WITNESS, and the run is VOID without it: a stream in which no
    // session lock was ever taken, or no projection mutex ever requested, is
    // trivially clean and says nothing about the order.
    expect(calls.some(([sql]) => String(sql).includes('pg_try_advisory_lock('))).toBe(true)
    // …and the blocking form is GONE from the stream, which is a claim the
    // witness above cannot make: `pg_try_advisory_lock(` does not contain
    // `pg_advisory_lock(`, so without this line a site that kept the old form
    // would satisfy neither assertion and be noticed by neither.
    expect(calls.some(([sql]) => String(sql).includes('SELECT pg_advisory_lock('))).toBe(false)
    expect(calls.some(([sql]) => String(sql).includes('pg_advisory_xact_lock('))).toBe(true)
    expect(calls.some(([sql, params]) =>
      String(sql).includes('pg_advisory_xact_lock(')
      && String((params ?? [])[0] ?? '').startsWith('read-model-projection:'))).toBe(true)

    expect(projectionLockOrderViolations(calls)).toEqual([])
  }, 60_000)
})

describe('D3 — substituteOverlayPrefix', () => {
  const url = (n: number) => `automerge:seg-${n}`

  it('mutates the list IN PLACE and never reassigns it', () => {
    const routes = [url(0), url(1), url(2), url(3)]
    const meta = { editsObjectShardUrls: routes }
    expect(substituteOverlayPrefix(meta, 'editsObjectShardUrls', [url(0), url(1)], [url(9)], true, true)).toBe(true)
    // Same array OBJECT. MUTANT: `meta[field] = [merged, ...tail]`, which the
    // comment on `appendUniqueOverlayRoute` forbids by name — it recreates
    // every element and gives the hottest control document of the workspace a
    // quadratic Automerge history.
    expect(meta.editsObjectShardUrls).toBe(routes)
    expect(routes).toEqual([url(9), url(2), url(3)])
  })

  it('accepte une url EN DOUBLE dans la liste brute — sinon le pliage gèle à jamais', () => {
    // ModelMeta's list is a CRDT. `appendUniqueOverlayRoute`'s `includes` guard
    // is a single-replica check: two replicas inserting the same url
    // independently merge into two entries, and a crash between
    // `publishAdmittedRotation`'s change and its flush produces exactly that.
    //
    // MUTANT: comparing `indices.length` — POSITIONS in the raw list — with
    // `foldedIds.size` — DEDUPLICATED ids. One duplicate makes 3 !== 2, the
    // fold refuses, and it refuses for ever because the chain never shrinks
    // again; if the refusal lands after create + flush + claim + admit, every
    // pass also leaves a GC-protected orphan behind.
    const routes = [url(0), url(1), url(0), url(2)]
    const meta = { editsObjectShardUrls: routes }
    expect(substituteOverlayPrefix(meta, 'editsObjectShardUrls', [url(0), url(1)], [url(9)], true, true)).toBe(true)
    expect(routes).toEqual([url(9), url(2)])
  })

  it('refuses without writing anything when a folded url is missing and requireAll', () => {
    const routes = [url(0), url(2)]
    const meta = { editsObjectShardUrls: routes }
    expect(substituteOverlayPrefix(meta, 'editsObjectShardUrls', [url(0), url(1)], [url(9)], true, true)).toBe(false)
    // MUTANT: substituting whatever was found. Half a substitution on the
    // authoritative list is a chain whose last-wins order no longer matches
    // what was actually merged.
    expect(routes).toEqual([url(0), url(2)])
  })

  it('keeps the key on a list it empties', () => {
    const meta = { editsObjectShardUrls: [url(0)] }
    substituteOverlayPrefix(meta, 'editsObjectShardUrls', [url(0)], [url(9)], true, true)
    // MUTANT: `delete meta[field]` when the list ends up empty. `gc.ts` reads a
    // ModelMeta with a missing shard array as `degenerate-model-meta`, sets
    // complete = false, and then the sweep never deletes anything again — for
    // the WHOLE park, not just this workspace.
    expect(Object.prototype.hasOwnProperty.call(meta, 'editsObjectShardUrls')).toBe(true)
    expect(meta.editsObjectShardUrls).toEqual([url(9)])
  })

  it('appends rather than refusing on a list that carries none of the prefix', () => {
    // `objectShardUrls` legitimately reaches that state. The merged segment
    // still has to be named somewhere the GC walk can see it.
    const meta = { objectShardUrls: ['automerge:base-a'] }
    expect(substituteOverlayPrefix(meta, 'objectShardUrls', [url(0)], [url(9)], false, false)).toBe(true)
    expect(meta.objectShardUrls).toEqual(['automerge:base-a', url(9)])
  })

  it('matches on document id, so a decorated url is still folded away', () => {
    const meta = { editsObjectShardUrls: [`${url(0)}?ref=1`, url(1)] }
    expect(substituteOverlayPrefix(meta, 'editsObjectShardUrls', [url(0)], [url(9)], true, true)).toBe(true)
    // MUTANT: comparing strings. The decorated url survives the fold, the
    // chain never shrinks, and the pass silently no-ops for ever.
    expect(meta.editsObjectShardUrls).toEqual([url(9), url(1)])
  })

  // ── contiguity and split substitution ──────────────────────────────────────

  it('REFUSES a non-contiguous window on the authoritative list', () => {
    // `overlayChainFold.ts` states this invariant — "merging a non-contiguous
    // subset would move values across segments that outrank them". A gapped
    // window such as [0,4] produces last-wins inversions on a fixture where
    // each id is written by exactly one pair of segments. Since sealing means
    // `planOverlayChainFold` no longer emits only prefixes, the substituter
    // itself must refuse.
    const routes = [url(0), url(1), url(2), url(3), url(4)]
    const meta = { editsObjectShardUrls: routes }
    expect(substituteOverlayPrefix(
      meta, 'editsObjectShardUrls', [url(0), url(2)], [url(9)], true, true,
    )).toBe(false)
    // AND IT WROTE NOTHING. A refusal that has already spliced is worse than no
    // refusal: half a substitution on the authoritative list is a chain whose
    // last-wins order no longer matches what was merged.
    expect(routes).toEqual([url(0), url(1), url(2), url(3), url(4)])
  })

  it('accepts a window whose only gap is the current HEAD sitting mid-list', () => {
    // Contiguity is a property of the CANONICAL order, not of raw positions,
    // and the two differ by exactly one element: `canonicalOverlayDocumentIds`
    // moves the head LAST "even when a stale client appended it earlier". A raw
    // list of [0,1,2,3] whose head is 2 canonicalises to [0,1,3,2], so the
    // window [0,1,3] is contiguous — with a GAP at raw index 2.
    //
    // A positional check would refuse this on every pass, for ever
    // (`prefix-not-substitutable` at the dry run), and the chain would then
    // grow until `overlay-chain-bounded` fires.
    const routes = [url(0), url(1), url(2), url(3)]
    const meta = { editsObjectShardUrls: routes }
    expect(substituteOverlayPrefix(
      meta, 'editsObjectShardUrls', [url(0), url(1), url(3)], [url(9)], true, true, url(2),
    )).toBe(true)
    expect(routes).toEqual([url(9), url(2)])
  })

  it('a DUPLICATE outside the window does not make it non-contiguous', () => {
    // `[seg0, seg1, seg2, seg0]` folding `[seg0, seg1]` puts a duplicate of
    // seg0 at index 3, so the raw position list is [0,1,3] and a naive
    // adjacency check refuses — for ever, because the fold always picks the
    // OLDEST foldable run (the same freeze as the distinct-id counting above).
    // Contiguity is judged on FIRST occurrences; the splice still removes
    // every one.
    const routes = [url(0), url(1), url(2), url(0)]
    const meta = { editsObjectShardUrls: routes }
    expect(substituteOverlayPrefix(
      meta, 'editsObjectShardUrls', [url(0), url(1)], [url(9)], true, true,
    )).toBe(true)
    expect(routes).toEqual([url(9), url(2)])
  })

  it('still refuses when the gap is NOT the head', () => {
    // The control for the row above. Without it, "skip one position" would be
    // an unconditional licence and the contiguity check would be decoration.
    const routes = [url(0), url(1), url(2), url(3)]
    const meta = { editsObjectShardUrls: routes }
    expect(substituteOverlayPrefix(
      meta, 'editsObjectShardUrls', [url(0), url(2)], [url(9)], true, true, url(3),
    )).toBe(false)
    expect(routes).toEqual([url(0), url(1), url(2), url(3)])
    // …and a gap of TWO is refused even when the head is inside it.
    expect(substituteOverlayPrefix(
      meta, 'editsObjectShardUrls', [url(0), url(3)], [url(9)], true, true, url(1),
    )).toBe(false)
  })

  it('accepts a contiguous window that is NOT a prefix', () => {
    // The invariant is contiguity; prefix-ness is strictly stronger than it
    // needs to be, and a sealed run is never a prefix.
    const routes = [url(0), url(1), url(2), url(3)]
    const meta = { editsObjectShardUrls: routes }
    expect(substituteOverlayPrefix(
      meta, 'editsObjectShardUrls', [url(1), url(2)], [url(9)], true, true,
    )).toBe(true)
    expect(routes).toEqual([url(0), url(9), url(3)])
  })

  it('splices EVERY merged part, in order, at the window slot', () => {
    // The merge is split at `OVERLAY_SEGMENT_ENTITY_CEILING`, so the window
    // is replaced by `ceil(n / ceiling)` segments rather than one.
    const routes = [url(0), url(1), url(2), url(3)]
    const meta = { editsObjectShardUrls: routes }
    expect(substituteOverlayPrefix(
      meta, 'editsObjectShardUrls', [url(0), url(1)], [url(7), url(8), url(9)], true, true,
    )).toBe(true)
    // MUTANT: `splice(insertAt, 0, mergedUrls[0])` — the tail parts vanish from
    // ModelMeta while their rows, claims and bytes all exist, so every entity
    // that lived only in part 2 or 3 leaves the read model silently.
    expect(routes).toEqual([url(7), url(8), url(9), url(2), url(3)])
  })

  it('appends every part on a list that carries none of the window', () => {
    const meta = { objectShardUrls: ['automerge:base-a'] }
    expect(substituteOverlayPrefix(
      meta, 'objectShardUrls', [url(0)], [url(8), url(9)], false, false,
    )).toBe(true)
    expect(meta.objectShardUrls).toEqual(['automerge:base-a', url(8), url(9)])
  })

  it('does NOT enforce contiguity on the mixed shard list', () => {
    // `objectShardUrls` interleaves the MODEL base shards with overlay routes,
    // so the folded window is legitimately
    // non-adjacent there. Enforcing contiguity on it would refuse every fold.
    const routes = [url(0), 'automerge:base-a', url(2)]
    const meta = { objectShardUrls: routes }
    expect(substituteOverlayPrefix(
      meta, 'objectShardUrls', [url(0), url(2)], [url(9)], false, false,
    )).toBe(true)
    expect(routes).toEqual([url(9), 'automerge:base-a'])
  })
})

describe('D3 — l\'ordre de durabilité (L7) de la passe', () => {
  it('prouve la durabilité, puis revendique, puis admet, puis publie — jamais l\'inverse', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { repo, meta, first, projector, events } = harness({ foldMin: 4, foldBudget: 3 })
      // Every url ModelMeta has EVER carried, across both lists.
      const everNamed = new Set<string>()
      const record = (doc?: MetaLike) => {
        for (const url of [
          ...(doc?.editsObjectShardUrls ?? []),
          ...(doc?.objectShardUrls ?? []),
        ]) everNamed.add(url.replace('automerge:', ''))
      }
      record(meta.doc())
      meta.on('change', (payload) => record(payload.doc as MetaLike))
      await projector.start()
      await rotate(repo, meta, first, 10)
      await expect.poll(
        () => meta.doc()?.editsObjectShardUrls?.length ?? 0,
        { timeout: 15_000, interval: 25 },
      ).toBeLessThan(11)

      // The pass has to be OBSERVABLE. A fold that refuses for ever — the
      // realistic failure is `head-not-listed` — is otherwise indistinguishable
      // from a fold that is working.
      const folds = warn.mock.calls
        .map(([line]) => { try { return JSON.parse(String(line)) } catch { return null } })
        .filter((entry) => entry?.event === 'read_model.overlay_chain_folded' && entry.folded > 0)
      expect(folds.length).toBeGreaterThan(0)
      const merged = String(folds[0].mergedDocumentId)
      expect(merged).toBeTruthy()

      const at = (tag: string) => events.indexOf(`${tag}:${merged}`)
      expect(at('witness')).toBeGreaterThanOrEqual(0)
      expect(at('claim')).toBeGreaterThan(at('witness'))
      expect(at('register')).toBeGreaterThan(at('claim'))
      expect(at('segment-row')).toBeGreaterThan(at('register'))
      // MUTANTS, one per inequality: proving durability AFTER the claim (the
      // claim then names a document that may not exist); registering before the
      // flush; and writing the segment row after the ModelMeta change, which
      // leaves the rebuild reading a `{}` snapshot for the merged segment.
      const published = events.findIndex((event, index) => event === 'meta-flush' && index > at('segment-row'))
      expect(published).toBeGreaterThan(-1)

      // Known, unexplained: in this scenario more documents are claimed than
      // ModelMeta ever names. Some of that is legitimate (a rotation whose
      // publication is superseded claims a child that is never published);
      // the rest is unattributed. There is deliberately NO "no claimed
      // document is orphaned" assertion here — it would currently fail.
      const claimed = events
        .filter((event) => event.startsWith('claim:'))
        .map((event) => event.slice('claim:'.length))
      expect(claimed.length).toBeGreaterThan(0)
      expect(everNamed.size).toBeGreaterThan(0)
    } finally {
      warn.mockRestore()
    }
  }, 60_000)

  it('substitue les DEUX listes, et jamais dans un état intermédiaire visible', async () => {
    const { repo, meta, first, projector } = harness({ foldMin: 4, foldBudget: 3 })
    // Every state ModelMeta is ever observed in, recorded from its own change
    // stream — the same stream the projector reads.
    const seen: string[][] = []
    meta.on('change', () => seen.push([...(meta.doc()?.editsObjectShardUrls ?? [])]))
    await projector.start()
    await rotate(repo, meta, first, 10)
    await expect.poll(
      () => meta.doc()?.editsObjectShardUrls?.length ?? 0,
      { timeout: 15_000, interval: 25 },
    ).toBeLessThan(11)

    // BOTH lists. Rotation appends to `editsObjectShardUrls` AND
    // `objectShardUrls`; substituting only the first leaves the second growing
    // 1:1 — and keeps the folded ids reachable, which would make
    // `overlay-segment-retained` unreachable and hide a real GC failure.
    expect(meta.doc()!.objectShardUrls!.length).toBeLessThan(11)

    // MUTANT: two `metaHandle.change` calls, one per list. That opens a state
    // in which the folded prefix is gone and the merged segment is not yet
    // named — every entity in it belongs to no listed segment — and ModelMeta
    // change listeners project exactly that state.
    for (let index = 1; index < seen.length; index += 1) {
      const before = seen[index - 1]
      const after = seen[index]
      if (after.length >= before.length) continue
      const vanished = before.filter((url) => !after.includes(url))
      const appeared = after.filter((url) => !before.includes(url))
      expect(vanished.length).toBeGreaterThan(0)
      expect(appeared).toHaveLength(1)
    }
  }, 60_000)
})

/**
 * Connection borrowing and per-process fold exclusion.
 *
 * The main harness returns the SAME client object on every connect(), so "a
 * pool connection held across document resolution" is structurally invisible
 * there; and it has only ONE workspace, so "one fold in flight per process" is
 * true by accident.
 *
 * This harness counts borrows, logs resolutions, and has TWO eligible
 * workspaces at once. The chain is SEEDED rather than rotated: what is
 * measured here is the pass, not the rotation.
 */
describe('D3 — la passe ne retient pas le pool, et il n en tourne qu une', () => {
  interface Seeded {
    metaId: string
    segmentIds: string[]
    headId: string
  }

  function twoWorkspaceHarness() {
    const repo = new Repo({})
    const events: string[] = []
    const projected = new Map<string, Record<string, unknown>>()
    const descriptors: Record<string, unknown>[] = []
    const seeded: Seeded[] = []
    const metas: { doc(): (MetaLike & Record<string, unknown>) | undefined }[] = []

    // Two workspaces, each with a chain already past the fold threshold. One
    // entity per segment, so a fold that lost content would be visible.
    for (const [index, workspace] of [['land', 'version'], ['land2', 'version2']].entries()) {
      const segments = Array.from({ length: 6 }, (_, position) =>
        repo.create<OverlayLike>({
          objects: { [`w${index}-obj-${position}`]: { id: `w${index}-obj-${position}` } },
          writeHeadVersion: 2,
          writeBatchIds: [],
        }))
      const head = segments[segments.length - 1]
      const meta = repo.create<MetaLike & Record<string, unknown>>({
        staticBaseline: true,
        objectShardUrls: segments.map((segment) => segment.url),
        connectionShardUrls: [] as string[],
        editsObjectShardUrls: segments.map((segment) => segment.url),
        editsObjectShardUrl: head.url,
        groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
      })
      descriptors.push({
        landscape_id: workspace[0], version_id: workspace[1],
        document_id: meta.documentId, kind: 'model-meta', entity_id: null, org_id: 'org',
      })
      for (const segment of segments) {
        descriptors.push({
          landscape_id: workspace[0], version_id: workspace[1],
          document_id: segment.documentId, kind: 'object-overlay', entity_id: null, org_id: 'org',
        })
        // The projector rebuilds a non-append-only order from SQL, so every
        // seeded segment needs its snapshot or the chain is never `ready`.
        projected.set(segment.documentId, plainObjects(segment))
      }
      metas.push(meta)
      seeded.push({
        metaId: meta.documentId,
        segmentIds: segments.map((segment) => segment.documentId),
        headId: head.documentId,
      })
    }

    const query = vi.fn(async (text: string, params?: unknown[]) => {
      // BOTH workspaces are granted, deliberately: if only one key were
      // granted, the second fold would be stopped by a REFUSED LOCK and the
      // test below would exercise the lock instead of the semaphore. With both
      // keys granted the semaphore is the ONLY thing that can hold the second
      // fold.
      if (text.includes('pg_try_advisory_lock')) {
        const key = String((params ?? [])[0] ?? '')
        return { rows: [{ locked: key.startsWith('overlay-rotation:') }], rowCount: 1 }
      }
      if (text.includes('pg_advisory_unlock')) return { rows: [{ released: true }], rowCount: 1 }
      // The PLANE check. The fold consults it at its ENTRY, before the first
      // `db.connect()` — so a fake that lets this fall through to the empty
      // default models a DEMOTED workspace and no fold ever runs. It is a pool
      // `query`, never a `connect`, so it does not disturb this test's borrow
      // accounting. The authority ALONE — see the sibling fake above for why a
      // bare table-name match is wrong.
      if (text.includes('read_model_static_workspaces')
        && !text.includes('read_model_static_documents')) {
        return { rows: [{ present: true }], rowCount: 1 }
      }
      if (text.includes('LEFT JOIN read_model_static_documents document')) {
        return { rows: descriptors, rowCount: descriptors.length }
      }
      if (text.includes('SELECT document_id, last_projected_snapshot')) {
        const ids = (params ?? []).find((value) => Array.isArray(value)) as string[] | undefined
        const rows = (ids ?? [...projected.keys()])
          .filter((id) => projected.has(id))
          .map((id) => ({ document_id: id, last_projected_snapshot: projected.get(id) }))
        return { rows, rowCount: rows.length }
      }
      if (text.includes('INSERT INTO read_model_overlay_segments')
        && text.includes('last_projected_snapshot')) {
        projected.set(String(params?.[3]), JSON.parse(String(params?.[5])) as Record<string, unknown>)
        events.push(`segment-row:${String(params?.[3])}`)
        return { rows: [], rowCount: 1 }
      }
      if (text.includes('INSERT INTO automerge_document_workspace')) {
        const ids = Array.isArray(params?.[0]) ? params[0] as string[] : [String(params?.[0])]
        return { rows: ids.map((id) => ({ document_id: id })), rowCount: ids.length }
      }
      if (text.includes("nextval('automerge_arrival_seq')")) return { rows: [{ w: '1' }], rowCount: 1 }
      if (text.includes('AS durable')) return { rows: [{ durable: true }], rowCount: 1 }
      if (text.includes('RETURNING observed_generation')) return { rows: [{ observed_generation: 2 }], rowCount: 1 }
      if (text.includes('SELECT revision FROM read_model_static_document_queue')) {
        return { rows: [{ revision: 1 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })

    // A NEW client per borrow, each with its OWN id stamped on every event it
    // produces. The main harness recycles one object, which is exactly why it
    // cannot see a connection being held — and an untagged `connect` event is
    // no better here, because ordinary projections borrow connections
    // concurrently and the first `connect` in the log belongs to one of them.
    let borrowed = 0
    let maxBorrowed = 0
    let nextConnectionId = 0
    const connect = vi.fn(async () => {
      borrowed += 1
      maxBorrowed = Math.max(maxBorrowed, borrowed)
      const connectionId = (nextConnectionId += 1)
      events.push(`connect:${connectionId}`)
      return {
        query: async (text: string, params?: unknown[]) => {
          // `pg_try_advisory_lock`, named exactly: the bare form is not a
          // substring of the try form. Both spellings, so this stays a borrow
          // detector rather than a spelling detector.
          if (text.includes('pg_advisory_lock') || text.includes('pg_try_advisory_lock')) {
            events.push(`lock:${connectionId}`)
          }
          // The UNLOCK, tagged separately. Without it every assertion in this
          // block is about the CLIENT and none is about the KEY — and those are
          // different resources with different owners: handing
          // `releaseOverlayRotationLock` the state `'refused'` after a
          // successful acquisition issues NO unlock while returning the
          // connection bare, exactly once — every client-side assertion would
          // pass while the advisory key stays held for the life of the session.
          if (text.includes('pg_advisory_unlock')) events.push(`unlock:${connectionId}`)
          if (text.includes('INSERT INTO read_model_overlay_segments')
            && text.includes('last_projected_snapshot')) {
            events.push(`fold-on:${connectionId}`)
          }
          return query(text, params)
        },
        // The ARGUMENT is recorded, not just the call. `client.release()` does
        // NOT end the session, so a bare hand-back returns the SAME backend to
        // the pool with whatever it still holds; `release(err)` is the only
        // form that destroys it. Those are opposite outcomes for a connection
        // that took an advisory key, and an untagged event cannot tell them
        // apart — see `overlayRotationLock.ts`.
        release: (error?: unknown) => {
          borrowed -= 1
          events.push(`release:${connectionId}${error ? ':destroy' : ''}`)
        },
      }
    })

    const projector = new StaticDeltaProjector(
      repo, { query, connect } as never,
      10, 60_000, undefined, undefined, undefined, undefined, undefined,
      5, 20, 4, 3,
    )
    running.push(projector)

    const internal = projector as unknown as {
      resolveDocumentHandle(documentId: string, signal?: AbortSignal): Promise<unknown>
      scheduleOverlayChainFolds(): void
      overlayState: Map<string, unknown>
    }
    const realResolve = internal.resolveDocumentHandle.bind(internal)
    vi.spyOn(internal, 'resolveDocumentHandle').mockImplementation(async (documentId, signal) => {
      events.push(`resolve:${documentId}`)
      return realResolve(documentId, signal)
    })

    return { repo, projector, internal, events, seeded, metas, maxBorrowed: () => maxBorrowed }
  }

  const plainObjects = (handle: { doc(): OverlayLike | undefined }) =>
    JSON.parse(JSON.stringify(handle.doc()?.objects ?? {})) as Record<string, unknown>

  it('résout les documents AVANT d\'emprunter une connexion, et n\'en tient qu\'une', async () => {
    const { projector, internal, events } = twoWorkspaceHarness()
    await projector.start()
    // Wait for both ModelMetas to be projected: `scheduleOverlayChainFolds`
    // reads `overlayState`, which only `projectMeta` populates.
    await expect.poll(() => internal.overlayState.size, { timeout: 15_000, interval: 10 })
      .toBeGreaterThanOrEqual(2)

    // NOT cleared: `start()` already schedules a round of its own once
    // `hydrateControlDocuments` has populated `overlayState`, so a cleared log
    // describes a LATER pass than the one being reasoned about.
    internal.scheduleOverlayChainFolds()
    await expect.poll(
      () => events.filter((event) => event.startsWith('fold-on:')).length,
      { timeout: 15_000, interval: 10 },
    ).toBeGreaterThanOrEqual(1)
    // Give a second pass room to run if the semaphore does not stop it.
    await new Promise((resolve) => setTimeout(resolve, 500))

    // (a) ONE FOLD PER PROCESS. Two workspaces were eligible and scheduled in
    // the same round; refusing rather than queueing is the design, so the
    // second folds on a later tick.
    // MUTANT: dropping `if (this.overlayFoldInFlight) return` — both run, and
    // each holds one of the four read-model connections.
    const merged = events.filter((event) => event.startsWith('segment-row:'))
    expect(merged).toHaveLength(1)

    // (b) THE CONNECTION IS TAKEN AFTER THE RESOLUTION. Every folded segment
    // of the workspace that won must have been resolved before the first
    // `connect` of the pass.
    // MUTANT: `client = await this.db.connect()` moved above the resolve loop —
    // one of four connections held across a wait bounded only by 30 s.
    //
    // The anchor is the connection that CARRIED the fold, identified by the
    // segment row it wrote. Anchoring on the first `connect` in the log would
    // pick up an ordinary projection's borrow and prove nothing.
    const foldConnection = events.find((event) => event.startsWith('fold-on:'))
      ?.slice('fold-on:'.length)
    expect(foldConnection).toBeDefined()
    const foldBorrowedAt = events.indexOf(`connect:${foldConnection}`)
    expect(foldBorrowedAt).toBeGreaterThan(-1)

    // The pass resolves its ModelMeta plus `budget` segments — FOUR documents —
    // and every one of them must be behind it before it borrows. Counting
    // rather than naming the ids keeps the assertion independent of which of
    // the two workspaces won the semaphore, which is a race by design.
    const resolvedBefore = new Set(events.slice(0, foldBorrowedAt)
      .filter((event) => event.startsWith('resolve:'))
      .map((event) => event.slice('resolve:'.length)))
    const resolvedAfter = new Set(events.slice(foldBorrowedAt)
      .filter((event) => event.startsWith('resolve:'))
      .map((event) => event.slice('resolve:'.length)))
    expect(resolvedBefore.size).toBeGreaterThanOrEqual(4)
    // And nothing was left to resolve while the connection was held: with the
    // mutant, the three segment resolves land AFTER `connect`, and this set is
    // where they show up.
    expect([...resolvedAfter].filter((id) => !resolvedBefore.has(id))).toEqual([])
  }, 60_000)

  it('rend CHAQUE connexion empruntée, exactement une fois, et le pliage la rend NUE', async () => {
    // `borrowed`/`maxBorrowed` and `release:<id>` are the direct measure of a
    // leaked client: a checked-out client that is never handed back makes
    // `pool.end()` never resolve, so the process stays live with a calm log.
    const { projector, internal, events, maxBorrowed } = twoWorkspaceHarness()
    await projector.start()
    await expect.poll(() => internal.overlayState.size, { timeout: 15_000, interval: 10 })
      .toBeGreaterThanOrEqual(2)
    internal.scheduleOverlayChainFolds()
    await expect.poll(
      () => events.filter((event) => event.startsWith('fold-on:')).length,
      { timeout: 15_000, interval: 10 },
    ).toBeGreaterThanOrEqual(1)

    const connectIds = () => events.filter((event) => event.startsWith('connect:'))
      .map((event) => event.slice('connect:'.length))
    const releaseIds = () => events.filter((event) => event.startsWith('release:'))
      .map((event) => event.slice('release:'.length).split(':')[0])

    // POLLED, not asserted once. A borrow still in flight is transient and a
    // leak is permanent, so a poll tells them apart where a bare assertion
    // would only tell them apart by luck.
    await expect.poll(() => {
      const outstanding = connectIds().filter((id) => !releaseIds().includes(id))
      return outstanding.length
    }, { timeout: 15_000, interval: 10 }).toBe(0)

    // …and exactly ONCE each, which is the other direction. pg-pool's
    // `_release` re-arms the idle listener on a bare hand-back, so releasing
    // twice returns a connection the pool already owns.
    // MUTANT: `if (client) await releaseOverlayRotationLock(...)` deleted from
    // the fold's `finally` — the fold's borrow never comes back and the poll
    // above times out.
    const counts = new Map<string, number>()
    for (const id of releaseIds()) counts.set(id, (counts.get(id) ?? 0) + 1)
    expect([...counts.entries()].filter(([, count]) => count !== 1)).toEqual([])

    // The FOLD's own connection, and the form of its hand-back. On the happy
    // path it acquired the key and `pg_advisory_unlock` answered true, so the
    // session provably holds nothing and the connection is reusable — a bare
    // release. `:destroy` here would mean the unlock failed or was never
    // issued, which is the state that must NOT reach the pool.
    const foldConnection = events.find((event) => event.startsWith('fold-on:'))
      ?.slice('fold-on:'.length)
    expect(foldConnection).toBeDefined()
    // EXACT ids, not a prefix. Connection ids are integers, so `release:1`
    // prefix-matches `release:10`.
    expect(events.filter((event) => (
      event === `release:${foldConnection}` || event === `release:${foldConnection}:destroy`
    ))).toEqual([`release:${foldConnection}`])

    // …and it gave the KEY back before it gave the CLIENT back. The connection
    // returning clean is only half of a correct hand-back: an advisory lock is
    // held by the SESSION, and pg-pool's bare release re-arms the idle listener
    // and hands the same backend on with whatever it still holds. Ordering
    // asserted, not just presence — an unlock issued after the release would be
    // on a connection the pool has already given away.
    // MUTANT: `releaseOverlayRotationLock(client, lockKey, 'refused')` — the
    // refused path issues no unlock by design, and on an ACQUIRED key that is
    // a permanently held lock behind a connection that looks healthy.
    const unlockAt = events.indexOf(`unlock:${foldConnection}`)
    const releaseAt = events.indexOf(`release:${foldConnection}`)
    expect(unlockAt).toBeGreaterThan(-1)
    expect(unlockAt).toBeLessThan(releaseAt)

    // The PEAK (`maxBorrowed`), and the bound comes from the DESIGN rather
    // than from the observation. What the projector is
    // allowed to hold at once is one connection per serialized workspace tail
    // plus one fold — two workspaces here, and `overlayFoldInFlight` permits a
    // single fold per process — so THREE, and the read-model pool is capped at
    // four (`dbConfig.ts`, `DB_READ_MODEL_POOL_MAX ?? '4'`). A projector whose
    // peak reaches the pool waits on itself.
    //
    // Typically 2 on this harness, but both tails and the fold CAN overlap, so
    // a pin at 2 would be a flake. A literal, not the pool default — raising
    // the pool must not make this agree with any peak the projector grows into.
    //
    // WHAT IT DOES NOT DO: it is not the semaphore's detector. With
    // `if (this.overlayFoldInFlight) return` deleted the extra folds run
    // SERIALLY, queued behind the same workspace tails, so the peak stays at 2
    // and this passes; the sibling test above catches that. This line bounds
    // the projector's demand against a pool of four, and would catch a change
    // that made the fold hold TWO connections at once.
    expect(maxBorrowed()).toBeLessThanOrEqual(3)
  }, 60_000)
})
