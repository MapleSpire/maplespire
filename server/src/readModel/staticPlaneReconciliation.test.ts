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
import { __resetOverlayRotationRefusalStreaks } from './overlayRotationLock.js'

/**
 * The static projector's ATTACHMENT must follow the plane's AUTHORITY
 * (`read_model_static_workspaces`), not the allow-list
 * (`read_model_static_documents`).
 *
 * If attachment were derived from the allow-list, the projector would
 * re-attach ITSELF after a demotion: its own rotation re-INSERTs a document row
 * the demotion deleted, and the next ten-second reload tick reads it back as
 * evidence that it should be attached. Measured on a real Postgres:
 *
 *   reloadDescriptors rows straight after a demotion : 0
 *   ... after ONE rotation by the unaware projector  : 1
 *   ... same instant, with the authority join        : 0
 *
 * THE FAKE MODELS THE DATABASE, NOT THE STATEMENT. It holds the two tables
 * separately and decides what the descriptor SELECT returns by asking whether
 * that statement joins the authority — which is what Postgres would do. A fake
 * that simply hands back a fixed row set answers the same thing to the joined
 * and un-joined statement, so every assertion below would pass against the
 * defect.
 */
/**
 * Release accounting for the connections that asked for the overlay-rotation
 * key, and ONLY those.
 *
 * `recoverAdmittedOverlayRotations` borrows a client for
 * `closeInactiveAdmittedRotations` before it borrows one per row, so a flat
 * list of `release()` arguments mixes in a connection that never touched the
 * key. That is not a cosmetic off-by-one: the assertions here are about WHICH
 * hand-back each state gets — bare for a refusal, destroyed for an acquisition
 * that gave no answer — and a list that cannot say which connection is which
 * cannot make that assertion at all.
 */
function lockClientReleases() {
  const perLockClient: unknown[] = []
  return {
    get releases() { return perLockClient },
    connect(query: (sql: string, params?: unknown[]) => Promise<unknown>) {
      return async () => {
        let askedForTheKey = false
        return {
          query: async (sql: string, params?: unknown[]) => {
            if (String(sql).includes('pg_try_advisory_lock')) askedForTheKey = true
            return query(sql, params)
          },
          release: (err?: unknown) => {
            if (askedForTheKey) perLockClient.push(err)
          },
        }
      }
    },
  }
}

describe('A10 — attachment must be reconciled against the plane authority', () => {
  const running: StaticDeltaProjector[] = []
  afterEach(async () => {
    for (const projector of running.splice(0)) await projector.stop().catch(() => undefined)
  })

  type DocumentRow = {
    landscape_id: string
    version_id: string
    document_id: string
    kind: string
    entity_id: string | null
    org_id: string | null
  }

  const row = (overrides: Partial<DocumentRow> = {}): DocumentRow => ({
    landscape_id: 'land',
    version_id: 'version',
    document_id: 'doc-1',
    kind: 'registry-shard',
    entity_id: null,
    org_id: 'org',
    ...overrides,
  })

  const WORKSPACE = { landscapeId: 'land', versionId: 'version' }
  const keyOf = (r: DocumentRow) => `${r.landscape_id}/${r.version_id}`

  /**
   * Both arguments are FUNCTIONS so one projector can be driven across two
   * ticks that disagree — which is the whole subject here. A per-harness value
   * could only model a projector that never sees the plane change hands.
   *
   * @param documents rows in `read_model_static_documents`
   * @param authority workspace keys in `read_model_static_workspaces`
   */
  function harness(documents: () => DocumentRow[], authority: () => Set<string>) {
    const repo = new Repo({})
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      const text = String(sql)
      calls.push({ sql: text, params })
      // The descriptor SELECT. Matched on the aliased CHILD table, which no
      // other statement in this class names: `isStaticReadModelWorkspace` and
      // `assertReadModelPlane` both mention `read_model_static_workspaces`, and
      // a matcher that cannot tell them apart answers the wrong one.
      if (text.includes('LEFT JOIN read_model_static_documents document')) {
        const owned = authority()
        // THE FAKE MODELS THE DATABASE. The real statement is driven FROM the
        // authority table and reaches the allow-list through a LEFT JOIN, so:
        // a workspace with authority and no documents yields ONE row with a
        // null document, and a document whose workspace has no authority row
        // yields nothing at all. A fake that just hands back a fixed row set
        // answers the same thing to the joined and un-joined statement, so
        // every assertion here would pass against the defect.
        const driven = text.includes('FROM read_model_static_workspaces workspace')
        const rows = driven
          ? [...owned].flatMap((key) => {
            const mine = documents().filter((r) => keyOf(r) === key)
            return mine.length ? mine : [{
              landscape_id: key.split('/')[0]!, version_id: key.split('/')[1]!,
              document_id: null, kind: null, entity_id: null, org_id: null,
            }]
          })
          : documents()
        return { rows, rowCount: rows.length }
      }
      return { rows: [], rowCount: 0 }
    })
    const projector = new StaticDeltaProjector(repo, { query } as never)
    running.push(projector)
    const internal = projector as unknown as {
      reloadDescriptors(): Promise<void>
      release(key: { landscapeId: string; versionId: string }, reason?: string): void
      descriptors: Map<string, { landscapeId: string; versionId: string; kind: string }>
      attachedWorkspaces: Map<string, unknown>
    }
    const callsMatching = (needle: string) => calls.filter((call) => call.sql.includes(needle))
    return { projector, internal, calls, callsMatching }
  }

  const owns = () => new Set([`${WORKSPACE.landscapeId}/${WORKSPACE.versionId}`])
  const ownsNothing = () => new Set<string>()

  it('A10-1 — releases a workspace whose authority row is gone', async () => {
    // The document rows NEVER go away in this test, which is the measured
    // state: a demotion deletes them and the demoted projector's own next
    // rotation puts one back. Attachment must follow the authority, so the
    // release has to happen anyway.
    let promoted = true
    const { internal } = harness(
      () => [row(), row({ document_id: 'doc-2' })],
      () => (promoted ? owns() : ownsNothing()),
    )

    await internal.reloadDescriptors()
    expect(internal.descriptors.size).toBe(2)
    expect(internal.attachedWorkspaces.size).toBe(1)

    promoted = false
    await internal.reloadDescriptors()

    // Stop SERVING it, not merely refuse to write. A refusal leaves the
    // descriptors, the listeners and the residency leases in place until the
    // pod restarts, and leaves the rotation paths re-entering every tick.
    expect(internal.descriptors.size).toBe(0)
    expect(internal.attachedWorkspaces.size).toBe(0)
  })

  it('A10-2 — never stamps the health row for a workspace it does not serve', async () => {
    // `markReadModelProjectorAttached` UPSERTs `read_model_projection_state`
    // and sets `projector_instance_id` to the STATIC projector's id. That row
    // is the ORDINARY projector's health row. So the re-attach loop does not
    // only write the wrong plane's `ro_*` rows — it forges the identity on the
    // health row of the projector that legitimately owns them.
    const { internal, callsMatching } = harness(() => [row()], ownsNothing)
    await internal.reloadDescriptors()
    expect(callsMatching('INTO read_model_projection_state')).toHaveLength(0)
  })

  it('A10-3 — drops a descriptor whose document row is gone, workspace intact', async () => {
    // Reconciling the WORKSPACE set is not enough. `degenerateRootRepair`
    // deletes retired document ids from the allow-list while the workspace
    // keeps its authority row, so a retired registry shard would keep its
    // descriptor, keep its `change` listener and keep projecting into
    // `ro_diagrams` for a root that has been rotated away.
    let both = true
    const { internal } = harness(
      () => (both ? [row({ document_id: 'doc-1' }), row({ document_id: 'doc-2' })] : [row({ document_id: 'doc-1' })]),
      owns,
    )

    await internal.reloadDescriptors()
    expect([...internal.descriptors.keys()].sort()).toEqual(['doc-1', 'doc-2'])

    both = false
    await internal.reloadDescriptors()
    expect([...internal.descriptors.keys()]).toEqual(['doc-1'])
    // The workspace itself is still served — this is the narrower case.
    expect(internal.attachedWorkspaces.size).toBe(1)
  })

  it('A10-4 — a released workspace is not resurrected by the orphan rows it left', async () => {
    // `release()` must be a FIXED POINT. The document rows outlive it — that is
    // what an orphan IS — so a tick that still derives attachment from them
    // undoes the release on the very next pass, ten seconds later, for ever.
    const { internal, callsMatching } = harness(() => [row()], ownsNothing)

    internal.release(WORKSPACE, 'plane lost')
    await internal.reloadDescriptors()

    expect(internal.descriptors.size).toBe(0)
    expect(internal.attachedWorkspaces.size).toBe(0)
    expect(callsMatching('INTO read_model_projection_state')).toHaveLength(0)
  })

  it('A10-6 — a fleet lease answer does NOT release a workspace whose plane never moved', async () => {
    // Plane membership and lease ownership are different facts with different
    // owners, and must not be folded into one `continue`.
    //
    // `ownsWorkspace` is the sync-cell fleet's lease predicate.
    // `partitionIsLive()` folds `redis.ready` into it, so it goes false for
    // EVERY workspace the instant the Redis transport blips, while the paired
    // `onOwnershipLost` only fires on the next reconcile tick. Treating that as
    // a plane change would release the whole static plane: descriptors,
    // listeners, four residency owners, four core-document pins, and every
    // pending rotation timer.
    //
    // Lease loss keeps its own owner (`onOwnershipLost` -> `release()`), which
    // is why nothing here needs to react to it.
    let leaseHealthy = true
    const repo = new Repo({})
    const calls: Array<{ sql: string }> = []
    const query = vi.fn(async (sql: string) => {
      const text = String(sql)
      calls.push({ sql: text })
      if (text.includes('LEFT JOIN read_model_static_documents document')) {
        return { rows: [row()], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const projector = new StaticDeltaProjector(
      repo, { query } as never, 60_000, 10, () => leaseHealthy,
    )
    running.push(projector)
    const internal = projector as unknown as {
      reloadDescriptors(): Promise<void>
      descriptors: Map<string, unknown>
      attachedWorkspaces: Map<string, unknown>
    }

    await internal.reloadDescriptors()
    expect(internal.attachedWorkspaces.size).toBe(1)

    // The transport blips. The authority row has NOT moved.
    leaseHealthy = false
    await internal.reloadDescriptors()
    expect(internal.attachedWorkspaces.size).toBe(1)
    expect(internal.descriptors.size).toBe(1)

    // …and it comes back, with nothing to rebuild.
    leaseHealthy = true
    await internal.reloadDescriptors()
    expect(internal.attachedWorkspaces.size).toBe(1)
    // CONTROL: the health row is stamped ONCE across all three ticks. A
    // projector that released and re-attached each time satisfies every
    // assertion above — only a cross-tick count can see the churn.
    expect(calls.filter((c) => c.sql.includes('INTO read_model_projection_state'))).toHaveLength(1)
  })

  it('A10-7 — a descriptor installed WHILE the query is in flight is not swept', async () => {
    // The window the pre-query snapshot exists to buy. A rotation commits its document row and only then installs the child
    // descriptor, so a tick whose SELECT ran before that commit would otherwise
    // sweep a descriptor installed while it was still reading.
    let armed = false
    const repo = new Repo({})
    const query = vi.fn(async (sql: string) => {
      const text = String(sql)
      if (text.includes('LEFT JOIN read_model_static_documents document')) {
        // Fire only on the SECOND tick: on the first, the child would land
        // before that tick even snapshotted, so it would be swept legitimately
        // and the test would go red against CORRECT code.
        if (armed) {
          internal.descriptors.set('rotation-child', {
            landscapeId: 'land', versionId: 'version', documentId: 'rotation-child',
            kind: 'object-overlay', entityId: null, orgId: 'org',
          } as never)
        }
        return { rows: [row()], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const projector = new StaticDeltaProjector(repo, { query } as never)
    running.push(projector)
    const internal = projector as unknown as {
      reloadDescriptors(): Promise<void>
      descriptors: Map<string, unknown>
    }

    await internal.reloadDescriptors()
    armed = true
    await internal.reloadDescriptors()

    // `rotation-child` is in NEITHER the snapshot nor the result set. It must
    // survive on the strength of not having been a candidate.
    expect([...internal.descriptors.keys()].sort()).toEqual(['doc-1', 'rotation-child'])
  })

  it('A10-8 — attach() refuses a descriptor whose workspace was released', async () => {
    // THE FIXED POINT. `release()` removes descriptors, listeners, residency
    // leases and core-document pins; six paths re-install some of that after an
    // await, and `detach()` releases NEITHER leases nor pins — so without the
    // guard a pass in flight when `release` ran would leave the document
    // unevictable for the life of the pod, for a workspace that had left the
    // plane.
    //
    // The fixture is built so every WEAKENING of the guard has somewhere to
    // fail: a second workspace stays attached (so `attachedWorkspaces.size ===
    // 0` is not enough), the refused descriptor is present in `descriptors`
    // (so consulting that map instead is not enough), and the admitting control
    // runs last (so a guard that refuses everything is not enough either).
    const repo = new Repo({})
    const refused = repo.create({ objects: {} })
    const sibling = repo.create({ objects: {} })
    const control = repo.create({ objects: {} })
    await Promise.all([refused.whenReady(), sibling.whenReady(), control.whenReady()])

    const { projector, internal } = harness(
      () => [
        row({ document_id: refused.documentId, kind: 'object-overlay' }),
        row({ landscape_id: 'other', document_id: sibling.documentId, kind: 'object-overlay' }),
        row({ landscape_id: 'other', document_id: control.documentId, kind: 'object-overlay' }),
      ],
      () => new Set(['land/version', 'other/version']),
    )
    const inner = projector as unknown as {
      attach(handle: unknown): void
      descriptors: Map<string, unknown>
    }
    await internal.reloadDescriptors()
    expect(internal.attachedWorkspaces.size).toBe(2)

    // `reloadDescriptors` installs DESCRIPTORS, not listeners — those come from
    // `scanResidentHandles` and the repo's document event. Attach explicitly so
    // the baseline is a real count and not an accidental zero.
    inner.attach(refused)
    inner.attach(sibling)
    expect(projector.listenedCount()).toBe(2)

    internal.release(WORKSPACE, 'plane lost')
    expect(projector.listenedCount()).toBe(1)

    // The in-flight rotation tail: `activatePublishedOverlayHead` does exactly
    // this — `descriptors.set` and then `attach` — after `release` has run.
    inner.descriptors.set(refused.documentId, {
      landscapeId: 'land', versionId: 'version', documentId: refused.documentId,
      kind: 'object-overlay', entityId: null, orgId: 'org',
    })
    inner.attach(refused)
    expect(projector.listenedCount()).toBe(1)

    // CONTROL, last on purpose and on a document not yet listened: the OTHER
    // workspace never left the plane, so a fresh handle of its own must still
    // be admitted. Without this, a guard that refuses EVERY attach would pass
    // every assertion above.
    inner.attach(control)
    expect(projector.listenedCount()).toBe(2)
    expect(internal.attachedWorkspaces.size).toBe(1)
  })

  it('A10-9 — one contended row never aborts the recovery pass', async () => {
    // `publishAdmittedRotation`'s transactions carry `SET LOCAL lock_timeout`
    // and its plane check takes `FOR KEY SHARE`, so it can raise 55P03 —
    // waiting behind a demotion or a `clearWorkspace`. The per-row catch must
    // therefore NOT be narrowed to `isReadModelAuthorityLoss`.
    //
    // Escaping costs far more than the row: from the tick it skips every later
    // step for EVERY workspace; from `start()` it rejects, and `index.ts` logs
    // and swallows that — leaving a pod with no reload timer, no readiness and
    // no compaction route, listening and never reconciling.
    const repo = new Repo({})
    const meta = repo.create({ editsObjectShardUrls: [] })
    await meta.whenReady()

    let advisoryAttempts = 0
    const query = vi.fn(async (sql: string) => {
      const text = String(sql)
      // `pg_try_advisory_lock` never waits, so 55P03 cannot arrive from THIS
      // statement; the injected error stands for any other failure of the
      // round trip, which lands in the state `overlayRotationLock` calls
      // `unknown` (the server may have granted the key and lost the reply).
      // One row's failure, of ANY kind, must not abort a pass that `start()`
      // awaits.
      if (text.includes('pg_try_advisory_lock')) {
        advisoryAttempts += 1
        throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })
      }
      if (text.includes('SELECT landscape_id, version_id, collection')) {
        return {
          rows: [{
            landscape_id: 'land', version_id: 'version', collection: 'object',
            old_document_id: 'old', new_document_id: 'new',
            new_segment_url: 'automerge:new',
          }],
          rowCount: 1,
        }
      }
      if (text.includes('read_model_static_workspaces') && text.includes('SELECT EXISTS')) {
        return { rows: [{ present: true }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    // PER CONNECTION, and attributed to the one that asked for the lock:
    // `closeInactiveAdmittedRotations` borrows a client of its own at the head
    // of this pass, so a flat list of releases counts a connection that has
    // nothing to do with the key and the assertion below drifts by one.
    const releases = lockClientReleases()
    const db = { query, connect: releases.connect(query) }
    const projector = new StaticDeltaProjector(repo, db as never)
    running.push(projector)
    const internal = projector as unknown as {
      recoverAdmittedOverlayRotations(): Promise<void>
      descriptors: Map<string, unknown>
      attachedWorkspaces: Map<string, unknown>
    }
    const descriptor = {
      landscapeId: 'land', versionId: 'version', documentId: meta.documentId,
      kind: 'model-meta', entityId: null, orgId: 'org',
    }
    internal.descriptors.set(meta.documentId, descriptor)
    internal.attachedWorkspaces.set(`land${String.fromCharCode(0)}version`, descriptor)

    // RESOLVES. That is the whole assertion — the pass is idempotent and the
    // next tick re-derives the row from `read_model_overlay_rotations`.
    await expect(internal.recoverAdmittedOverlayRotations()).resolves.toBeUndefined()
    // LIVENESS WITNESS: without this the test would pass against a pass that
    // never entered the loop at all, which is the vacuous form of the same green.
    expect(advisoryAttempts).toBeGreaterThan(0)

    // …and the connection went back DESTROYED, not bare. An acquisition that
    // threw leaves the backend session possibly holding the key; measured, a
    // bare `release()` keeps it (1 → 1) while `release(err)` ends the session
    // and drops it (1 → 0). Handing a lock-holding connection back to a pool of
    // four is worse than losing the connection: the next borrower of that
    // backend is ADMITTED, because an advisory lock is counted per session.
    expect(releases.releases).toHaveLength(1)
    expect(releases.releases[0]).toBeInstanceOf(Error)
  })

  it('A10-9b — a row whose key is HELD is skipped, and the pass goes on to the next', async () => {
    // A contended key must be REFUSED, not waited for. A blocking lock would
    // wait, unbounded, on a holder that spans `repo.create` and two
    // `repo.flush`es, on the chain `start()` awaits — and forever if the holder
    // leaked the key.
    //
    // Two rows, and the second is the assertion: a refusal must skip ONE row,
    // never the pass.
    const repo = new Repo({})
    const first = repo.create({ editsObjectShardUrls: [] })
    const second = repo.create({ editsObjectShardUrls: [] })
    await first.whenReady()
    await second.whenReady()

    // The streak is MODULE state that no lifecycle call resets, so
    // `consecutiveRefusals` below would depend on test ORDER without this.
    __resetOverlayRotationRefusalStreaks()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const releases = lockClientReleases()
    let attempts = 0
    /** The keys actually asked for. PARAMS-SENSITIVE, because a fixture that
     * ignores them cannot tell a correctly-minted key from one built out of the
     * wrong workspace (e.g. `landscapeId` and `versionId` swapped). The
     * recovery pass would then mint a key no other door uses and exclude
     * nobody, silently, which is the one failure this lock exists to prevent. */
    const keysAsked: string[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const text = String(sql)
      if (text.includes('pg_try_advisory_lock')) {
        keysAsked.push(String((params ?? [])[0] ?? ''))
        attempts += 1
        // The FIRST row is contended, the second is free. A fake that refused
        // both could not tell "skips a row" from "skips the pass".
        return { rows: [{ locked: attempts > 1 }], rowCount: 1 }
      }
      // The unlock answers TRUTHFULLY too. Letting it fall through to the empty
      // default makes `releaseOverlayRotationLock` read "this session did not
      // hold the key" and log a broken-bookkeeping warning on the row that did
      // everything right — a fake that manufactures the very fault the code is
      // there to report.
      if (text.includes('pg_advisory_unlock')) return { rows: [{ released: true }], rowCount: 1 }
      if (text.includes('SELECT landscape_id, version_id, collection')) {
        return {
          rows: [
            {
              landscape_id: 'land', version_id: 'version', collection: 'object',
              old_document_id: 'old-a', new_document_id: 'new-a',
              new_segment_url: 'automerge:new-a',
            },
            {
              landscape_id: 'land', version_id: 'version', collection: 'connection',
              old_document_id: 'old-b', new_document_id: 'new-b',
              new_segment_url: 'automerge:new-b',
            },
          ],
          rowCount: 2,
        }
      }
      if (text.includes('read_model_static_workspaces') && text.includes('SELECT EXISTS')) {
        return { rows: [{ present: true }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const db = { query, connect: releases.connect(query) }
    const projector = new StaticDeltaProjector(repo, db as never)
    running.push(projector)
    const internal = projector as unknown as {
      recoverAdmittedOverlayRotations(): Promise<void>
      descriptors: Map<string, unknown>
      attachedWorkspaces: Map<string, unknown>
    }
    const descriptor = {
      landscapeId: 'land', versionId: 'version', documentId: first.documentId,
      kind: 'model-meta', entityId: null, orgId: 'org',
    }
    internal.descriptors.set(first.documentId, descriptor)
    internal.attachedWorkspaces.set(`land${String.fromCharCode(0)}version`, descriptor)

    // THE SKIP, witnessed at the one call that cannot be undone.
    //
    // `attempts === 2` proves the pass went ON to the next row; this proves the
    // refused row was skipped. `publishAdmittedRotation` supersedes the
    // rotation row, mutates the user's ModelMeta and flushes it, none of which
    // the SQL gate at the end can undo, while another writer holds the key.
    //
    // A SPY rather than a SQL-parameter assertion: `publishAdmittedRotation` is
    // entered on this fixture but its `UPDATE` never runs, so a SQL witness
    // could not fire even on correct code.
    const published: string[] = []
    const spied = internal as unknown as {
      publishAdmittedRotation(...args: unknown[]): Promise<void>
    }
    vi.spyOn(spied, 'publishAdmittedRotation').mockImplementation(async (...args: unknown[]) => {
      published.push(String(args[5]))
    })

    await expect(internal.recoverAdmittedOverlayRotations()).resolves.toBeUndefined()

    // BOTH rows were asked. One refusal skipping the rest of the list would be
    // a head-of-line block, invisible from the resolve above.
    expect(attempts).toBe(2)
    // …with the RIGHT keys, in the row order the SELECT returned them. The
    // literal is asserted, not a shape: the key text is the wire format of an
    // exclusion, and the two collections of one workspace are different doors.
    expect(keysAsked).toEqual([
      'overlay-rotation:land:version:object',
      'overlay-rotation:land:version:connection',
    ])
    // …and ONLY the second row — the one whose key was free — was published.
    // `new-a` appearing here is the two-writers-on-one-head failure.
    expect(published).toEqual(['new-b'])

    // THE SIGNAL, asserted at the call site rather than only on the export:
    // a stalled key must be reported, not just skipped.
    const contended = warn.mock.calls
      .map(([line]) => { try { return JSON.parse(String(line)) as Record<string, unknown> } catch { return {} } })
      .filter((event) => event.event === 'read_model.overlay_rotation_lock_contended')
    expect(contended).toHaveLength(1)
    expect(contended[0]).toMatchObject({
      path: 'recover-admitted',
      landscapeId: 'land',
      versionId: 'version',
      kind: 'object',
      state: 'refused',
      // The streak, which is what tells a pod folding a chain for 400 ms apart
      // from a key nobody will ever release.
      consecutiveRefusals: 1,
    })
    // Refused means nothing was taken, so both connections go back CLEAN —
    // `undefined`, not an Error. Destroying a connection per contended row
    // would drain a pool of four under exactly the contention it is meant to
    // survive.
    expect(releases.releases).toEqual([undefined, undefined])
    // EXACTLY ONE unlock — for the row that actually took the key, and not for
    // the refused one. Unlocking a key a session never held answers `false`,
    // which the release path reports as broken bookkeeping; issuing it after
    // every refusal would turn that detector into noise and retire it.
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('pg_advisory_unlock'))).toHaveLength(1)
  })

  it('A10-5 — the descriptor statement consults the authority table', async () => {
    // A DELIBERATE source-text assertion, and the only one in this file.
    //
    // The fake above decides what to return by reading the statement, so it
    // proves the join CHANGES the answer — not that the join is correct. A
    // wrong join mentioning the right table would satisfy both it and this.
    // `staticPlaneReconciliation.integration.test.ts` runs the real statement
    // against a real Postgres with an orphan planted, and that is what decides.
    const { internal, callsMatching } = harness(() => [], ownsNothing)
    await internal.reloadDescriptors()
    // `LEFT JOIN`, not the bare table alias: the `entity_id` backfill UPDATE
    // above the SELECT names `read_model_static_documents document` too, and so
    // does `recoverChangedDocuments`' queue join. A matcher that cannot tell
    // the three apart returns two statements here and hijacks the queue scan in
    // the sibling fixtures.
    const select = callsMatching('LEFT JOIN read_model_static_documents document')
    expect(select).toHaveLength(1)
    // Driven FROM the authority, reaching the allow-list through a LEFT JOIN.
    // The direction is the assertion: the other way round, a workspace whose
    // allow-list is empty would vanish from the result and be swept as if it
    // had left the plane.
    expect(select[0]!.sql).toContain('FROM read_model_static_workspaces workspace')
    expect(select[0]!.sql).toContain('LEFT JOIN read_model_static_documents document')
  })
})
