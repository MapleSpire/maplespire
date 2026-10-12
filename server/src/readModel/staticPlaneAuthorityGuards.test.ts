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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import { StaticDeltaProjector } from './staticDeltaProjector.js'
import { isReadModelAuthorityLoss, STATIC_PLANE_LOCK_WAIT_MS } from './projectionAuthority.js'

/**
 * Static-plane authority guards that broader suites do not exercise.
 *
 * The most important: `assertReadModelPlane` must run inside
 * `assertPlaneAndOwnership` ABOVE the `if (!this.ownership?.enabled) return`,
 * so that all five bare transactions are covered in the shipped configuration
 * (ownership disabled). Deleting the call, or moving it below that return,
 * must turn this file red.
 *
 * The other half of the file is about ERROR CLASSIFICATION, which is the half a
 * happy-path fixture cannot reach: which failures a catch is allowed to
 * swallow, and which must propagate.
 */

type FakeClient = {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
}

/** The separator `keyOf` uses, BUILT rather than typed: a literal NUL in a
 * source file is invisible. */
const NUL = String.fromCharCode(0)

/** A fake that is a POOL, which is what production passes: paths needing a
 * transaction borrow a client. The borrowed client shares the same `query` spy,
 * so statement assertions are unaffected by where a statement was issued. A
 * `{ query }`-only fake reports `this.db.connect is not a function` — a FIXTURE
 * failure that reads as a production one. */
const poolLike = (query: unknown) => ({
  query,
  connect: async () => ({ query, release: () => undefined }),
})

const descriptorOf = (overrides: Record<string, unknown> = {}) => ({
  landscapeId: 'land', versionId: 'version', documentId: 'doc-1',
  kind: 'model-meta', entityId: null, orgId: 'org', ...overrides,
})

const running: StaticDeltaProjector[] = []
afterEach(async () => {
  for (const projector of running.splice(0)) await projector.stop().catch(() => undefined)
  vi.restoreAllMocks()
})

describe('A10 — beginBoundedTransaction and the order inside assertPlaneAndOwnership', () => {
  /**
   * Drives the REAL `publishAdmittedRotation`, not the two private helpers in
   * isolation. A direct call to `beginBoundedTransaction` would stay green over
   * a call site that stopped using it — the wire is the half that breaks, and
   * it is usually the half with no test.
   *
   * `ownership` is left UNDEFINED on purpose: that is the shipped
   * configuration, in which the fence's own body returns on its first line. It
   * is the only configuration under which the plane check's POSITION is
   * observable at all.
   */
  async function publish(arm: 'demoted' | 'head-moved' | 'flush-lost') {
    const repo = new Repo({})
    const meta = repo.create({
      editsObjectShardUrl: arm === 'flush-lost'
        ? 'automerge:old-head'
        : 'automerge:some-other-head',
    })
    await meta.whenReady()
    vi.spyOn(repo, 'flush').mockResolvedValue(undefined)
    if (arm === 'flush-lost') {
      // "The ModelMeta flush did not take" — modelled where the code observes
      // it, which is the value it reads back after the change.
      vi.spyOn(meta, 'change').mockImplementation(() => undefined)
    }
    const queries: Array<{ sql: string; params: unknown[] }> = []
    const client: FakeClient = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        const text = String(sql)
        queries.push({ sql: text, params })
        if (text.includes('FOR KEY SHARE')) {
          return arm === 'demoted'
            ? { rows: [], rowCount: 0 }
            : { rows: [{ present: true }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const projector = new StaticDeltaProjector(repo, poolLike(vi.fn()) as never)
    running.push(projector)
    let threw: unknown = null
    try {
      await (projector as unknown as {
        publishAdmittedRotation(
          c: unknown, d: unknown, m: unknown, k: string, o: string, n: string, u: string,
        ): Promise<void>
      }).publishAdmittedRotation(
        client, descriptorOf(), meta, 'object', 'old-head', 'new-head', 'automerge:new-head',
      )
    } catch (error) { threw = error }
    return { queries, threw, sqls: queries.map((q) => q.sql) }
  }

  it('the ceiling is BEGIN, then a LITERAL 5000ms, and it is armed before the first row lock',
    async () => {
      // The bound is asserted as a NUMBER the code cannot move. Deriving it from
      // `STATIC_PLANE_LOCK_WAIT_MS` would agree with any value that constant is
      // given.
      const { sqls } = await publish('demoted')
      // ONE statement, not two: as a separate `BEGIN` and `SET LOCAL`, a throw
      // from the second would leave the transaction open while the caller's
      // `inTransaction` was still false, so the `finally` would release a
      // connection still inside a transaction.
      expect(sqls[0]).toBe("BEGIN; SET LOCAL lock_timeout = '5000ms'")
      // …and the constant the literal above stands in for, so a change to it
      // fails HERE and not somewhere downstream.
      expect(STATIC_PLANE_LOCK_WAIT_MS).toBe(5_000)

      // ORDER is the property. `SET LOCAL` outside a transaction is silently
      // inert, and the row lock it exists to bound is the first blocking one
      // these five transactions take.
      const ceiling = sqls.findIndex((sql) => sql.includes('lock_timeout'))
      const firstRowLock = sqls.findIndex((sql) => sql.includes('FOR KEY SHARE'))
      expect(ceiling).toBe(0)
      expect(firstRowLock).toBeGreaterThan(ceiling)
    })

  it('the plane is asked with the ownership flag OFF, and it is asked for `static`', async () => {
    const demoted = await publish('demoted')
    // THE CLAIM OF THE WHOLE CHANGE: this statement is issued even though
    // `ownership` is undefined.
    expect(demoted.sqls.filter((sql) => sql.includes('FOR KEY SHARE'))).toHaveLength(1)
    // It refuses, and it refuses with something every caller classifies as an
    // authority loss rather than as a broken read model.
    expect(demoted.threw).not.toBeNull()
    expect(isReadModelAuthorityLoss(demoted.threw)).toBe(true)
    // Nothing was written, and the transaction was rolled back rather than left
    // open on a pooled connection.
    expect(demoted.sqls.some((sql) => sql.includes('read_model_overlay'))).toBe(false)
    expect(demoted.sqls).toContain('ROLLBACK')
    expect(demoted.sqls).not.toContain('COMMIT')

    // THE CONTROL, and it is what makes the arm above mean "refused" rather
    // than "throws for everyone": a workspace that IS static passes the same
    // gate and does its work. Without it, asking the plane for `'ordinary'`
    // satisfies every assertion above.
    const live = await publish('head-moved')
    expect(live.threw).toBeNull()
    expect(live.sqls).toContain('COMMIT')
    expect(live.sqls).not.toContain('ROLLBACK')
  })

  it('both abandon branches release the CHILD\'s retention pin, in their own transaction',
    async () => {
      // `retain_until IS NULL` means RETAINED to `gc.ts`, and nothing in the
      // tree ever DELETEs a `read_model_overlay_segments` row — so a rotation
      // abandoned without this leaves a reachability root that can never
      // expire. Both exits need it.
      for (const arm of ['head-moved', 'flush-lost'] as const) {
        const { sqls, queries, threw } = await publish(arm)
        expect(threw).toBeNull()
        expect(sqls.some((sql) => sql.includes("SET status = 'superseded'"))).toBe(true)
        const release = queries.filter((q) => q.sql.includes('read_model_overlay_segments'))
        expect(release, `${arm}: the child's pin must be released`).toHaveLength(1)
        // The CHILD, not the outgoing head: releasing the old head's pin here
        // would de-pin a segment an offline client may still be merging
        // against, and both ids are in scope at this call site.
        expect(release[0]!.params).toContain('new-head')
        expect(release[0]!.params).not.toContain('old-head')
        // Same transaction as the status change — the two are one fact.
        const status = sqls.findIndex((sql) => sql.includes("SET status = 'superseded'"))
        const pin = sqls.findIndex((sql) => sql.includes('read_model_overlay_segments'))
        // `lastIndexOf`: the flush-lost arm COMMITs its first transaction
        // before it ever reaches this branch, so the FIRST commit belongs to a
        // different transaction entirely.
        const commit = sqls.lastIndexOf('COMMIT')
        expect(status).toBeLessThan(pin)
        expect(pin).toBeLessThan(commit)
      }
    })
})

describe('A10 — the two catches in recoverAdmittedOverlayRotations', () => {
  type Row = {
    landscape_id: string; version_id: string; collection: 'object'
    old_document_id: string; new_document_id: string; new_segment_url: string
  }
  const rotationRow = (landscape: string): Row => ({
    landscape_id: landscape, version_id: 'version', collection: 'object',
    old_document_id: 'old-head', new_document_id: `new-${landscape}`,
    new_segment_url: `automerge:new-${landscape}`,
  })

  /**
   * @param rows the admitted rotations the SELECT hands back, in order
   * @param plane how the PER-ROW connection answers its in-transaction gate
   * @param cteError what the data-modifying close CTE rejects with, if anything
   */
  async function recover(options: {
    rows: Row[]
    plane?: (landscape: string) => 'static' | 'demoted' | 'boom'
    cteError?: unknown
  }) {
    const repo = new Repo({})
    const meta = repo.create({ editsObjectShardUrl: 'automerge:some-other-head' })
    await meta.whenReady()
    vi.spyOn(repo, 'flush').mockResolvedValue(undefined)
    const clientSql: Array<{ sql: string; params: unknown[] }> = []
    const poolSql: string[] = []
    const query = vi.fn(async (sql: string) => {
      const text = String(sql)
      poolSql.push(text)
      // `WITH candidates AS` — the close statement selects its rows `FOR UPDATE
      // SKIP LOCKED` first, which is what replaced a ceiling: a contended row is
      // one another writer is already publishing, and this pass is idempotent,
      // so there is nothing to wait FOR.
      if (text.includes('WITH candidates AS')) {
        if (options.cteError) throw options.cteError
        return { rows: [], rowCount: 0 }
      }
      if (text.includes("WHERE status = 'admitted'")) {
        return { rows: options.rows, rowCount: options.rows.length }
      }
      // `holdsStaticPlane`'s UNLOCKED reader, on the pool. Answering it `true`
      // is what lets the loop reach the per-connection gate, which is the
      // subject: the two are different questions asked of the same table.
      if (text.includes('read_model_static_workspaces')) {
        return { rows: [{ present: true }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const connect = vi.fn(async (): Promise<FakeClient> => ({
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        const text = String(sql)
        clientSql.push({ sql: text, params })
        // The close statement runs on a BORROWED CLIENT inside a bounded
        // transaction, so the injection must live here, or these two cases
        // silently stop exercising anything.
        if (text.includes('WITH candidates AS') && options.cteError) throw options.cteError
        // The overlay-rotation key. It RETURNS a verdict, and a fake that
        // lets it fall through to the empty default answers `refused` for every
        // row — so the loop skips all of them and three tests here go red
        // reporting an empty statement log. Granted for any well-formed key of
        // this fixture, refused for anything else: the key text is the wire
        // format of an exclusion, so a constant `true` could not tell a
        // correctly-minted key from one built out of the wrong workspace.
        if (text.includes('pg_try_advisory_lock')) {
          return {
            rows: [{ locked: /^overlay-rotation:[^:]+:[^:]+:(object|connection)$/.test(String(params[0])) }],
            rowCount: 1,
          }
        }
        if (text.includes('pg_advisory_unlock')) return { rows: [{ released: true }], rowCount: 1 }
        if (text.includes('FOR KEY SHARE')) {
          const verdict = options.plane?.(String(params[0])) ?? 'static'
          if (verdict === 'boom') throw new Error('a failure belonging to nobody else')
          return verdict === 'static'
            ? { rows: [{ present: true }], rowCount: 1 }
            : { rows: [], rowCount: 0 }
        }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }))
    const projector = new StaticDeltaProjector(repo, { query, connect } as never)
    running.push(projector)
    const internal = projector as unknown as {
      recoverAdmittedOverlayRotations(): Promise<void>
      descriptors: Map<string, unknown>
    }
    // One ModelMeta document shared by every workspace: the loop looks its
    // descriptor up by workspace key, and all of them resolving to the same
    // handle keeps the fixture about the CATCH rather than about the repo.
    for (const row of options.rows) {
      internal.descriptors.set(`${row.landscape_id}-meta`, descriptorOf({
        landscapeId: row.landscape_id, documentId: meta.documentId, kind: 'model-meta',
      }))
    }
    return { internal, clientSql, poolSql }
  }

  it('a demoted workspace is SKIPPED, and the next row still runs', async () => {
    // The contract the per-row catch exists to make true. The demoted row is
    // FIRST on purpose: an escaping throw takes the rest of the reload tick
    // with it and, from `start()`, both interval timers are never installed —
    // so a projector that has lost this catch also loses reconciliation itself,
    // silently.
    const { internal, clientSql } = await recover({
      rows: [rotationRow('demoted'), rotationRow('healthy')],
      plane: (landscape) => (landscape === 'demoted' ? 'demoted' : 'static'),
    })
    await expect(internal.recoverAdmittedOverlayRotations()).resolves.toBeUndefined()

    // The demoted row wrote nothing and rolled back.
    expect(clientSql.filter((call) => (
      call.params.includes('demoted') && call.sql.includes('read_model_overlay')
    ))).toHaveLength(0)
    expect(clientSql.filter((call) => call.sql === 'ROLLBACK')).toHaveLength(1)
    // THE LIVENESS WITNESS. Without it, "it resolved" is equally true of a loop
    // that never reached a second iteration.
    expect(clientSql.filter((call) => (
      call.params.includes('healthy') && call.sql.includes("SET status = 'superseded'")
    ))).toHaveLength(1)
    // Both connections were unlocked and handed back, whichever way the row went.
    expect(clientSql.filter((c) => c.sql.includes('pg_advisory_unlock'))).toHaveLength(2)
  })

  it('a failure that is NOT an authority loss is LOGGED and the pass carries on', async () => {
    // A NON-authority failure must also be swallowed per row.
    // `publishAdmittedRotation`'s transactions carry `SET LOCAL lock_timeout`
    // and its plane check takes `FOR KEY SHARE`, so it can raise 55P03 behind a
    // demotion. Escaping here would skip every later step of the tick for
    // EVERY workspace and, from `start()`, leave the pod with no reload timer
    // and no readiness: reconciliation would never run again for the life of
    // the process.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { internal } = await recover({
      rows: [rotationRow('boom'), rotationRow('healthy')], plane: () => 'boom',
    })
    await expect(internal.recoverAdmittedOverlayRotations()).resolves.toBeUndefined()
    // …and it is not swallowed SILENTLY: the log names the workspace.
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('admitted rotation recovery failed for boom/version'),
      expect.anything(),
    )
    // "CARRIES ON" needs its own witness. Both rows throw here, so a loop that
    // gave up after the first — without rethrowing — would satisfy every
    // assertion above. The count is what distinguishes swallow-and-continue
    // from swallow-and-abandon, and the second is the failure this catch exists
    // to prevent.
    expect(error).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('admitted rotation recovery failed for healthy/version'),
      expect.anything(),
    )
  })

  it('a 40P01 or a 55P03 on the close CTE is tolerated, and the pass carries on', async () => {
    for (const code of ['40P01', '55P03']) {
      const injected = Object.assign(new Error(`injected ${code}`), { code })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { internal, poolSql } = await recover({ rows: [], cteError: injected })
      await expect(internal.recoverAdmittedOverlayRotations()).resolves.toBeUndefined()
      // LIVENESS: the statement AFTER the close ran, so "resolved" is not
      // "returned at the first line".
      expect(poolSql.some((sql) => sql.includes("WHERE status = 'admitted'"))).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`gave up (${code})`))
      warn.mockRestore()
    }
  })

  it('any other SQLSTATE on the close CTE is real and propagates', async () => {
    const missing = Object.assign(new Error('relation does not exist'), { code: '42P01' })
    const { internal } = await recover({ rows: [], cteError: missing })
    await expect(internal.recoverAdmittedOverlayRotations()).rejects.toThrow(/does not exist/)
  })
})

describe('A10 — pendingDetachWrites and the docRuns resurrection guard', () => {
  it('stop() does not resolve while a detach write it started is in flight', async () => {
    const repo = new Repo({})
    let settle: (() => void) | null = null
    const query = vi.fn(async (sql: string) => {
      if (String(sql).includes('projector_attached = false')) {
        await new Promise<void>((resolve) => { settle = resolve })
      }
      return { rows: [], rowCount: 0 }
    })
    const projector = new StaticDeltaProjector(repo, poolLike(query) as never)
    running.push(projector)
    const internal = projector as unknown as {
      release(key: { landscapeId: string; versionId: string }, reason?: string): void
      attachedWorkspaces: Map<string, unknown>
      pendingDetachWrites: Set<Promise<void>>
    }
    internal.attachedWorkspaces.set(`land${NUL}version`, descriptorOf())
    internal.release({ landscapeId: 'land', versionId: 'version' }, 'plane lost')
    // The registration happened — otherwise "it drained" is a fact about a set
    // nothing ever entered.
    expect(internal.pendingDetachWrites.size).toBe(1)

    let stopped = false
    const stopping = projector.stop().then(() => { stopped = true })
    // Several FULL loop turns, not one microtask: `stop()` awaits three settled
    // promises before it reaches the drain, and a single turn would report
    // "still pending" for a reason that has nothing to do with the subject.
    for (let turn = 0; turn < 5; turn++) await new Promise((r) => setImmediate(r))
    expect(stopped).toBe(false)

    settle!()
    await stopping
    expect(stopped).toBe(true)
    expect(internal.pendingDetachWrites.size).toBe(0)
  })

  it('the set self-clears, so it is bounded by what is actually in flight', async () => {
    const repo = new Repo({})
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const projector = new StaticDeltaProjector(repo, poolLike(query) as never)
    running.push(projector)
    const internal = projector as unknown as {
      release(key: { landscapeId: string; versionId: string }, reason?: string): void
      attachedWorkspaces: Map<string, unknown>
      pendingDetachWrites: Set<Promise<void>>
    }
    for (const landscape of ['a', 'b', 'c']) {
      internal.attachedWorkspaces.set(
        `${landscape}${NUL}version`, descriptorOf({ landscapeId: landscape }))
      internal.release({ landscapeId: landscape, versionId: 'version' }, 'plane lost')
    }
    expect(internal.pendingDetachWrites.size).toBe(3)
    for (let turn = 0; turn < 3; turn++) await new Promise((r) => setImmediate(r))
    expect(internal.pendingDetachWrites.size).toBe(0)
  })

  it('a run whose descriptor was swept does not re-enter trigger', async () => {
    const repo = new Repo({})
    const handle = repo.create({ objects: {} })
    await handle.whenReady()
    let answerPlane: ((value: { rows: unknown[]; rowCount: number }) => void) | null = null
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const query = vi.fn(async (sql: string) => {
      if (String(sql).includes('read_model_static_workspaces')) {
        return new Promise((resolve) => { answerPlane = resolve as never })
      }
      return { rows: [], rowCount: 0 }
    })
    const projector = new StaticDeltaProjector(repo, poolLike(query) as never)
    running.push(projector)
    const internal = projector as unknown as {
      trigger(d: unknown, h: unknown, immediate?: boolean): void
      detach(documentId: string): void
      descriptors: Map<string, unknown>
      docRuns: Map<string, { running: boolean; pending: boolean }>
    }
    const descriptor = descriptorOf({ documentId: handle.documentId, kind: 'object-overlay' })
    internal.descriptors.set(handle.documentId, descriptor)

    internal.trigger(descriptor, handle, true)
    await new Promise((r) => setImmediate(r))
    // Parked on the plane query — the LIVENESS witness for the whole fixture,
    // since a `docRuns` map that was never populated satisfies the final
    // assertion for free.
    expect(internal.docRuns.get(handle.documentId)?.running).toBe(true)

    // A second change while it runs: this is what sets `pending`.
    internal.trigger(descriptor, handle)
    expect(internal.docRuns.get(handle.documentId)?.pending).toBe(true)

    // …and now the reconciliation sweep drops the document, exactly as
    // `reloadDescriptors` does when a row goes while its workspace stays.
    internal.descriptors.delete(handle.documentId)
    internal.detach(handle.documentId)
    expect(internal.docRuns.has(handle.documentId)).toBe(false)

    answerPlane!({ rows: [], rowCount: 0 })
    for (let turn = 0; turn < 5; turn++) await new Promise((r) => setImmediate(r))

    // The entry `detach` removed must not come back. `state` is a closure over
    // the object `detach` deleted, so re-entering `trigger` `set`s a FRESH
    // entry for a descriptor that no longer exists: one map entry that survives
    // to `stop()`, plus a `project()` the plane check then refuses.
    expect(internal.docRuns.has(handle.documentId)).toBe(false)
    expect(internal.docRuns.size).toBe(0)
  })
})
describe('A10 — the `stopped` guards, one per await that can straddle a shutdown', () => {
  const fakePool = () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    // A POOL, which is what production passes: `closeInactiveAdmittedRotations`
    // borrows a client for its bounded transaction. The borrowed client shares
    // this `query` spy, so the statement counts these cases assert are
    // unaffected by where the statement was issued.
    return { query, db: { query, connect: async () => ({ query, release: () => undefined }) } as never }
  }
  const timersOf = (p: StaticDeltaProjector) => p as unknown as {
    scanTimer: NodeJS.Timeout | null
    reloadTimer: NodeJS.Timeout | null
  }

  it('QA-E — reloadDescriptors issues NOTHING once stop() has run', async () => {
    // The head guard is the only thing between a shutdown and a pass that
    // RELEASES workspaces, detaches listeners and UPSERTs the ordinary
    // projector's health row. This test calls the method on a stopped
    // projector, and the control below asserts that a live one queries.
    const live = fakePool()
    const liveProjector = new StaticDeltaProjector(new Repo({}), live.db)
    running.push(liveProjector)
    // THE CONTROL: without it, "no query" is equally true of a guard that
    // returns on every call.
    await (liveProjector as unknown as { reloadDescriptors(): Promise<void> }).reloadDescriptors()
    expect(live.query.mock.calls.length).toBeGreaterThan(0)

    const dead = fakePool()
    const deadProjector = new StaticDeltaProjector(new Repo({}), dead.db)
    await deadProjector.stop()
    dead.query.mockClear()
    await (deadProjector as unknown as { reloadDescriptors(): Promise<void> }).reloadDescriptors()
    expect(dead.query).not.toHaveBeenCalled()
  })

  it('QA-F — a stop() landing inside start() installs neither interval', async () => {
    // `stop()` never awaits an in-flight `start()`, and `index.ts` calls it
    // unconditionally on SIGTERM — so every await in `start()` is a window in
    // which the two intervals are installed AFTER `stop()` cleared them. The
    // next tick then re-stamps `read_model_projection_state.projector_-
    // instance_id` with a dead instance's id that will never detach.
    const plain = fakePool()
    const healthy = new StaticDeltaProjector(new Repo({}), plain.db)
    running.push(healthy)
    // THE CONTROL — an undisturbed start() arms both, so an inverted guard is
    // distinguishable from a correct one.
    await healthy.start()
    expect(timersOf(healthy).scanTimer).not.toBeNull()
    expect(timersOf(healthy).reloadTimer).not.toBeNull()

    let release: (() => void) | null = null
    let parked = false
    const query = vi.fn(async () => {
      if (!parked) {
        parked = true
        await new Promise<void>((resolve) => { release = resolve })
      }
      return { rows: [], rowCount: 0 }
    })
    const projector = new StaticDeltaProjector(new Repo({}), poolLike(query) as never)
    running.push(projector)
    const starting = projector.start()
    for (let turn = 0; turn < 3; turn++) await new Promise((r) => setImmediate(r))
    // The window is real and start() is sitting in it — otherwise the stop
    // below lands after start() finished and the assertion is vacuous.
    expect(parked).toBe(true)
    await projector.stop()
    release!()
    await starting
    expect(timersOf(projector).scanTimer).toBeNull()
    expect(timersOf(projector).reloadTimer).toBeNull()
  })

  it('QA-G — the recovery loop stops mid-list, and the row after the stop never runs', async () => {
    // The per-row guard's own comment states the contract: "a SIGTERM landing
    // in it would otherwise keep borrowing connections from a pool `stop()` has
    // already been told to let go of". This asserts it.
    const repo = new Repo({})
    const meta = repo.create({ editsObjectShardUrl: 'automerge:some-other-head' })
    await meta.whenReady()
    vi.spyOn(repo, 'flush').mockResolvedValue(undefined)
    const rows = ['first', 'second'].map((landscape) => ({
      landscape_id: landscape, version_id: 'version', collection: 'object' as const,
      old_document_id: 'old-head', new_document_id: `new-${landscape}`,
      new_segment_url: `automerge:new-${landscape}`,
    }))
    const clientSql: Array<{ sql: string; params: unknown[] }> = []
    let projector: StaticDeltaProjector | null = null
    const query = vi.fn(async (sql: string) => {
      const text = String(sql)
      if (text.includes('WITH candidates AS')) return { rows: [], rowCount: 0 }
      if (text.includes("WHERE status = 'admitted'")) return { rows, rowCount: rows.length }
      if (text.includes('read_model_static_workspaces')) return { rows: [{ present: true }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const connect = vi.fn(async () => ({
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        const text = String(sql)
        clientSql.push({ sql: text, params })
        // SIGTERM, delivered while the FIRST row is releasing its overlay
        // advisory key. `stop()` sets `stopped` synchronously, before its first
        // await, which is what makes the next iteration's guard observable.
        if (text.includes('pg_advisory_unlock')) {
          void projector!.stop()
          return { rows: [{ released: true }], rowCount: 1 }
        }
        // Granted, or the first row never does the work this test's liveness
        // witness is looking for — and the SIGTERM would then be delivered on
        // a pass that had already skipped everything.
        if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 }
        if (text.includes('FOR KEY SHARE')) return { rows: [{ present: true }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }))
    projector = new StaticDeltaProjector(repo, { query, connect } as never)
    running.push(projector)
    const internal = projector as unknown as {
      recoverAdmittedOverlayRotations(): Promise<void>
      descriptors: Map<string, unknown>
    }
    for (const row of rows) {
      internal.descriptors.set(`${row.landscape_id}-meta`, descriptorOf({
        landscapeId: row.landscape_id, documentId: meta.documentId, kind: 'model-meta',
      }))
    }
    await internal.recoverAdmittedOverlayRotations()

    // LIVENESS — the FIRST row did its work, so "the second never ran" is not
    // "the loop never started", and an inverted guard fails here.
    expect(clientSql.filter((call) => (
      call.params.includes('first') && call.sql.includes("SET status = 'superseded'")
    ))).toHaveLength(1)
    // …and the row after the stop borrowed no connection at all.
    expect(clientSql.filter((call) => call.params.includes('second'))).toHaveLength(0)
    // TWO borrows, not one: the close statement takes a client for its bounded
    // transaction before the loop begins, and the first row takes one of its
    // own. The second row takes none — which is the property.
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('QA-H — no detach write outlives stop(), including one release() starts after the drain', async () => {
    // THE OUTCOME, deliberately not the mechanism. `release()`'s durable write
    // and `stop()`'s drain admit (at least) two correct designs: gate the write
    // while stopping, or drain a SECOND time after the detach loop. A test
    // written against either one would go red the day the other is chosen.
    // What neither design may ever produce is a `markReadModelProjectorDetached` still in
    // flight when `stop()` resolves: `index.ts` awaits this `stop()` and then
    // ends the read-model pool, and that statement is a CAS on
    // `projector_instance_id`, so a lost one leaves `projector_attached = true`
    // with a dead instance's id that no later process can clear.
    //
    // The assertion is `startedWrites - completedWrites` sampled AT THE
    // INSTANT `stop()` resolves: 0 for the gated design (no third write exists)
    // and 0 for the double-drain design (the third write is awaited), 1 for
    // either one with its half removed.
    let startedWrites = 0
    let completedWrites = 0
    const parked: Array<() => void> = []
    const query = vi.fn(async (sql: string) => {
      if (!String(sql).includes('projector_attached = false')) return { rows: [], rowCount: 0 }
      startedWrites += 1
      await new Promise<void>((resolve) => { parked.push(resolve) })
      completedWrites += 1
      return { rows: [], rowCount: 0 }
    })
    const projector = new StaticDeltaProjector(new Repo({}), poolLike(query) as never)
    running.push(projector)
    const internal = projector as unknown as {
      release(key: { landscapeId: string; versionId: string }, reason?: string): void
      attachedWorkspaces: Map<string, unknown>
      pendingDetachWrites: Set<Promise<void>>
    }

    // THE CONTROL, against an inverted gate: on a LIVE projector
    // the same call registers a tracked write and the set self-clears.
    internal.attachedWorkspaces.set(`live${NUL}version`, descriptorOf({ landscapeId: 'live' }))
    internal.release({ landscapeId: 'live', versionId: 'version' }, 'ownership lost')
    expect(internal.pendingDetachWrites.size).toBe(1)
    parked.splice(0).forEach((resolve) => { resolve() })
    for (let turn = 0; turn < 3; turn++) await new Promise((r) => setImmediate(r))
    expect(internal.pendingDetachWrites.size).toBe(0)
    startedWrites = 0
    completedWrites = 0

    internal.attachedWorkspaces.set(`land-a${NUL}version`, descriptorOf({ landscapeId: 'land-a' }))
    internal.attachedWorkspaces.set(`land-b${NUL}version`, descriptorOf({ landscapeId: 'land-b' }))

    let outstandingAtResolve: number | null = null
    const stopping = projector.stop().then(() => {
      outstandingAtResolve = startedWrites - completedWrites
    })
    for (let turn = 0; turn < 5; turn++) await new Promise((r) => setImmediate(r))
    // LIVENESS — `stop()` really is parked inside its OWN detach loop, so the
    // `release()` below lands after the drain took its copy rather than before
    // `stop()` had started.
    expect(startedWrites).toBe(2)
    expect(internal.attachedWorkspaces.size).toBeGreaterThan(0)

    // The Redis path — `onOwnershipLost` — fires HERE.
    internal.release({ landscapeId: 'land-b', versionId: 'version' }, 'ownership lost')
    for (let turn = 0; turn < 3; turn++) await new Promise((r) => setImmediate(r))

    // Let ONLY the two writes `stop()` issued itself complete. Anything
    // `release()` added is deliberately left in flight, which is the whole
    // question.
    parked[0]!()
    parked[1]!()
    for (let turn = 0; turn < 5; turn++) await new Promise((r) => setImmediate(r))

    for (const resolve of parked.slice(2)) resolve()
    await stopping
    expect(outstandingAtResolve).toBe(0)
    expect(internal.pendingDetachWrites.size).toBe(0)
  })

  it('QA-I — a reload tick already queued when stop() lands runs nothing', async () => {
    // The interval callback's own guard, which the head guard of
    // `reloadDescriptors` MASKS for the first statement only: the callback goes
    // on to `recoverAdmittedOverlayRotations`, which has no head guard and
    // opens the close CTE on the pool. Two guards answering one question look
    // like one coverage hole and are two.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const armed = async (stopIt: boolean) => {
        const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
        const projector = new StaticDeltaProjector(new Repo({}), poolLike(query) as never, 250, 1_000)
        running.push(projector)
        await projector.start()
        const internal = projector as unknown as { reloadTail: Promise<void> }
        let release: (() => void) | null = null
        const parkedTail = new Promise<void>((resolve) => { release = resolve })
        internal.reloadTail = parkedTail
        query.mockClear()
        vi.advanceTimersByTime(1_000)
        // The tick DID chain onto the parked tail. Without this the negative
        // below is satisfied by an interval that never fired.
        expect(internal.reloadTail).not.toBe(parkedTail)
        const stopping = stopIt ? projector.stop() : Promise.resolve()
        release!()
        await stopping
        await internal.reloadTail.catch(() => undefined)
        for (let turn = 0; turn < 5; turn++) await new Promise((r) => setImmediate(r))
        return query.mock.calls.filter(([sql]) => String(sql).includes('WITH candidates AS')).length
      }

      // THE CONTROL — an undisturbed tick reaches the close CTE.
      expect(await armed(false)).toBeGreaterThan(0)
      // …and a tick whose turn comes after the stop reaches nothing.
      expect(await armed(true)).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
