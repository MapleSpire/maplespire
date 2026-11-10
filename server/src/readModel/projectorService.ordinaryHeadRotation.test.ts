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

import { describe, it, expect, vi } from 'vitest'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { awaitInitialDiagramProbe, ProjectorFleet, startReadModelProjector } from './projectorService.js'
import {
  ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV,
  ORDINARY_HEAD_ROTATION_FLAG,
  ORDINARY_HEAD_ROTATION_OFF,
  type OrdinaryHeadRotationConfig,
} from './ordinaryHeadRotation.js'
import { ordinaryRotationTelemetry } from './ordinaryRotationTelemetry.js'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

/**
 * `AM_ORDINARY_HEAD_ROTATION=shadow` wired into the ordinary projector.
 *
 * `ordinaryHeadRotation.test.ts` pins the observer itself (thresholds, gates,
 * dedupe). This file pins what only the wiring can get wrong: it looks at the
 * CURRENT write heads, at attach and on a delta pass, only while the projector
 * is still the owner, and it writes nothing — zero `.change()` on any handle
 * the repo hands out, and the same SQL as with the flag off.
 *
 * No database: the `Queryable` is an in-memory fake (trimmed copy of
 * `fakeDb()` in `projectorService.test.ts`, copied rather than imported — a
 * `*.test.ts` must not import another), so this file needs no entry in
 * `test-skip-allowlist.json`.
 */

const WORKSPACE: WorkspaceKey = { landscapeId: 'ls-rot', versionId: 'v1' }
const DUE = 'read_model.ordinary_head_rotation_due'

function fakeDb(onFenceClaimed?: () => void) {
  const queries: string[] = []
  let generation = 0
  let arrivalSeq = 0
  let fence: string | null = null
  const db: Queryable = {
    query: async (text: string, params?: unknown[]) => {
      queries.push(text)
      if (/RETURNING observed_generation/.test(text)) {
        generation += 1
        return { rows: [{ observed_generation: generation }] as never[], rowCount: 1 }
      }
      if (/nextval\('automerge_arrival_seq'\)/.test(text)) {
        arrivalSeq += 1
        return { rows: [{ w: String(arrivalSeq) }] as never[], rowCount: 1 }
      }
      if (/write_fence = EXCLUDED\.write_fence/.test(text)) {
        const expectedPrevious = (params?.[4] as string | null | undefined) ?? null
        if (fence !== expectedPrevious) return { rows: [], rowCount: 0 }
        fence = (params?.[3] as string | undefined) ?? null
        onFenceClaimed?.()
        return { rows: [], rowCount: 1 }
      }
      if (/SELECT write_fence FROM read_model_projection_state/.test(text)) {
        return { rows: [{ write_fence: fence }] as never[], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  }
  return { db, queries }
}

type Obj = { id: string; name: string }
type ObjShard = { objects: Record<string, Obj> }

/** A workspace whose object write head carries `headChanges` changes (the
 * create counts as one) and whose connection write head carries one. The BASE
 * shard carries 20 — over every threshold used here — so a projector that
 * observed every shard rather than the current head would report it too. */
async function workspace(headChanges: number, connectionHeadChanges = 1) {
  const repo = new Repo({})
  const base = repo.create<ObjShard>({ objects: { o0: { id: 'o0', name: 'A' } } })
  for (let index = 1; index < 20; index += 1) {
    base.change((d) => { d.objects[`b${index}`] = { id: `b${index}`, name: `B${index}` } })
  }
  const objectHead = repo.create<ObjShard>({ objects: {} })
  for (let index = 1; index < headChanges; index += 1) {
    objectHead.change((d) => { d.objects[`h${index}`] = { id: `h${index}`, name: `H${index}` } })
  }
  type Conn = { id: string; fromId: string; toId: string }
  // The connection side's retired head, for the same reason as the object
  // BASE above: without it nothing tells "observes the current connection
  // head" from "observes every connection shard".
  const connectionBase = repo.create<{ connections: Record<string, Conn> }>({ connections: {} })
  for (let index = 1; index < 20; index += 1) {
    connectionBase.change((d) => { d.connections[`r${index}`] = { id: `r${index}`, fromId: 'o0', toId: 'o0' } })
  }
  const connectionHead = repo.create<{ connections: Record<string, Conn> }>({ connections: {} })
  for (let index = 1; index < connectionHeadChanges; index += 1) {
    connectionHead.change((d) => { d.connections[`k${index}`] = { id: `k${index}`, fromId: 'o0', toId: 'o0' } })
  }
  const meta = repo.create({
    objectShardUrls: [base.url, objectHead.url],
    connectionShardUrls: [connectionBase.url, connectionHead.url],
    groups: {},
    editsObjectShardUrl: objectHead.url,
    editsConnectionShardUrl: connectionHead.url,
  })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
  const handles = [base, objectHead, connectionBase, connectionHead, meta, root] as DocHandle<unknown>[]
  await Promise.all(handles.map((handle) => handle.whenReady()))
  return { repo, root, base, objectHead, connectionBase, connectionHead, handles }
}

/** Count `.change()` on every handle the repo hands out — the fixture's and
 * any found or created during the run. Same shape as
 * `compaction.preview.test.ts`'s `countChanges`. */
function countChanges(repo: Repo, existing: DocHandle<unknown>[]) {
  let calls = 0
  const seen = new Set<DocHandle<unknown>>()
  const patch = (handle: DocHandle<unknown>) => {
    if (!handle || seen.has(handle)) return handle
    seen.add(handle)
    const original = handle.change.bind(handle)
    ;(handle as unknown as { change: unknown }).change = (...args: unknown[]) => {
      calls += 1
      return (original as (...a: unknown[]) => unknown)(...args)
    }
    return handle
  }
  for (const handle of existing) patch(handle)
  const originalCreate = repo.create.bind(repo)
  const originalFind = repo.find.bind(repo)
  ;(repo as unknown as { create: unknown }).create = (...args: unknown[]) =>
    patch((originalCreate as (...a: unknown[]) => DocHandle<unknown>)(...args))
  ;(repo as unknown as { find: unknown }).find = async (...args: unknown[]) =>
    patch(await (originalFind as (...a: unknown[]) => Promise<DocHandle<unknown>>)(...args))
  return {
    calls: () => calls,
    restore: () => {
      ;(repo as unknown as { create: unknown }).create = originalCreate
      ;(repo as unknown as { find: unknown }).find = originalFind
    },
  }
}

const shadow = (overrides: Partial<OrdinaryHeadRotationConfig> = {}): OrdinaryHeadRotationConfig => ({
  mode: 'shadow',
  allowlist: new Set([`${WORKSPACE.landscapeId}/${WORKSPACE.versionId}`]),
  maxActors: 1_000_000,
  maxChanges: 5,
  ...overrides,
})

/** Every `rotation_due` line logged while `body` runs, parsed. Read INSIDE the
 * `try`: `mockRestore()` clears `mock.calls`, so reading after it would assert
 * on an empty array whatever the implementation does. */
async function dueEvents(body: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await body()
    return warn.mock.calls
      .map(([line]) => { try { return JSON.parse(String(line)) } catch { return null } })
      .filter((line): line is Record<string, unknown> => line?.event === DUE)
  } finally { warn.mockRestore() }
}

async function start(
  fixture: Awaited<ReturnType<typeof workspace>>,
  db: Queryable,
  config: OrdinaryHeadRotationConfig,
  stillOwned: () => boolean = () => true,
) {
  const stop = await startReadModelProjector(
    fixture.repo, fixture.root.url, db, WORKSPACE, undefined, 0, undefined, stillOwned,
    undefined, undefined, config,
  )
  await awaitInitialDiagramProbe(WORKSPACE)
  return stop
}

describe('ordinary writer-head rotation — shadow wiring on the projector', () => {
  it('reports the current object head over threshold at attach, and writes no document', async () => {
    const fixture = await workspace(6)
    const store = fakeDb()
    const spy = countChanges(fixture.repo, fixture.handles)
    let stop: (() => void) | undefined
    try {
      const events = await dueEvents(async () => { stop = await start(fixture, store.db, shadow()) })
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        workspace: 'ls-rot/v1', kind: 'object', url: fixture.objectHead.url,
        numChanges: 6, crossed: ['changes'], thresholds: { maxActors: 1_000_000, maxChanges: 5 },
      })
      expect(spy.calls(), 'shadow mode WROTE into an Automerge document').toBe(0)
      // Control: the counter sees a write made through a patched handle, so
      // the zero above is not a blind spy agreeing with itself.
      fixture.base.change((d) => { (d as ObjShard).objects.o1 = { id: 'o1', name: 'B' } })
      expect(spy.calls()).toBe(1)
    } finally { stop?.(); spy.restore() }
  }, 30_000)

  it('reports the current connection head too, at attach and on a delta pass', async () => {
    const attachFixture = await workspace(1, 6)
    const attachEvents = await dueEvents(async () => {
      const stop = await start(attachFixture, fakeDb().db, shadow())
      stop()
    })
    expect(attachEvents).toHaveLength(1)
    expect(attachEvents[0]).toMatchObject({ kind: 'connection', url: attachFixture.connectionHead.url, numChanges: 6 })

    const deltaFixture = await workspace(1, 4)
    const store = fakeDb()
    let stop: (() => void) | undefined
    const deltaEvents = await dueEvents(async () => {
      stop = await start(deltaFixture, store.db, shadow())
      const upserts = () => store.queries.filter((text) => /INSERT INTO ro_connections/.test(text)).length
      const before = upserts()
      deltaFixture.connectionHead.change((d) => { d.connections.late = { id: 'late', fromId: 'o0', toId: 'o0' } })
      await vi.waitFor(() => { expect(upserts()).toBeGreaterThan(before) }, { timeout: 5_000 })
      // A delta pass on the RETIRED connection shard (20 changes, over the
      // threshold) must stay quiet: it is not the write head.
      const beforeRetired = upserts()
      deltaFixture.connectionBase.change((d) => { d.connections.old = { id: 'old', fromId: 'o0', toId: 'o0' } })
      await vi.waitFor(() => { expect(upserts()).toBeGreaterThan(beforeRetired) }, { timeout: 5_000 })
    })
    stop?.()
    expect(deltaEvents).toHaveLength(1)
    expect(deltaEvents[0]).toMatchObject({ kind: 'connection', numChanges: 5 })
  }, 30_000)

  it('issues the same SQL with the flag in shadow as with it off', async () => {
    const run = async (config: OrdinaryHeadRotationConfig) => {
      const fixture = await workspace(6)
      const store = fakeDb()
      let stop: (() => void) | undefined
      const events = await dueEvents(async () => { stop = await start(fixture, store.db, config) })
      stop?.()
      return { events, queries: store.queries }
    }
    const off = await run(ORDINARY_HEAD_ROTATION_OFF)
    const on = await run(shadow())
    // Non-vacuous on both sides: the shadow run did observe, the off run did not.
    expect(on.events).toHaveLength(1)
    expect(off.events).toEqual([])
    expect(off.queries.length).toBeGreaterThan(0)
    expect([...on.queries].sort()).toEqual([...off.queries].sort())
  }, 30_000)

  it('off computes nothing and reports nothing on the same head', async () => {
    const fixture = await workspace(50)
    const store = fakeDb()
    let stop: (() => void) | undefined
    const events = await dueEvents(async () => {
      // Every other gate open, so `off` is the only thing that can keep it quiet.
      stop = await start(fixture, store.db, { ...ORDINARY_HEAD_ROTATION_OFF, allowlist: 'all', maxChanges: 5 })
    })
    stop?.()
    expect(events).toEqual([])
  }, 30_000)

  it('a workspace the allow-list does not name is not observed', async () => {
    const fixture = await workspace(50)
    const store = fakeDb()
    let stop: (() => void) | undefined
    const events = await dueEvents(async () => {
      stop = await start(fixture, store.db, shadow({ allowlist: new Set(['someone/else']) }))
    })
    stop?.()
    expect(events).toEqual([])
  }, 30_000)

  /** Four edits into the object head (3 → 7 changes, threshold 5), each one
   * awaited until its own delta pass has written rows — so a later pass that
   * stays quiet is the dedupe, not the coalescer folding passes together, and
   * a pass that stays quiet when disowned really reached the observe site. */
  async function editThroughDeltaPasses(fixture: Awaited<ReturnType<typeof workspace>>, queries: string[]) {
    const upserts = () => queries.filter((text) => /INSERT INTO ro_objects/.test(text)).length
    for (let index = 0; index < 4; index += 1) {
      const before = upserts()
      fixture.objectHead.change((d) => { d.objects[`n${index}`] = { id: `n${index}`, name: `N${index}` } })
      await vi.waitFor(() => { expect(upserts()).toBeGreaterThan(before) }, { timeout: 5_000 })
    }
  }

  it('reports a crossing reached on a delta pass, once, while still the owner', async () => {
    const fixture = await workspace(3)
    const store = fakeDb()
    let stop: (() => void) | undefined
    let atAttach = -1
    const events = await dueEvents(async () => {
      stop = await start(fixture, store.db, shadow())
      atAttach = vi.mocked(console.warn).mock.calls.filter(([line]) => String(line).includes(DUE)).length
      await editThroughDeltaPasses(fixture, store.queries)
      // A delta pass on the BASE shard (20 changes, over threshold) must stay
      // quiet: it is not the write head.
      const upserts = () => store.queries.filter((text) => /INSERT INTO ro_objects/.test(text)).length
      const before = upserts()
      fixture.base.change((d) => { d.objects.late = { id: 'late', name: 'L' } })
      await vi.waitFor(() => { expect(upserts()).toBeGreaterThan(before) }, { timeout: 5_000 })
    })
    stop?.()
    expect(atAttach, '3 changes is under the threshold of 5').toBe(0)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'object', url: fixture.objectHead.url, crossed: ['changes'] })
    expect(events[0].numChanges).toBeGreaterThanOrEqual(5)
  }, 30_000)

  it('stays quiet once the projector no longer owns the workspace', async () => {
    const fixture = await workspace(3)
    const store = fakeDb()
    let owned = true
    let stop: (() => void) | undefined
    const events = await dueEvents(async () => {
      stop = await start(fixture, store.db, shadow(), () => owned)
      owned = false
      // The delta passes still run when disowned (the write fence, not this
      // predicate, guards rows), so they do reach the observe call.
      await editThroughDeltaPasses(fixture, store.queries)
    })
    stop?.()
    expect(events).toEqual([])
  }, 30_000)
})

/** G4-16e: which projectors put their workspace into the stats body. The
 * body names workspaces, so this is a privacy gate as well as a cost one: only
 * a ROTATING (`on`), allow-listed, still-owned workspace is registered. */
describe('ordinary rotation telemetry (G4-16e) — who registers', () => {
  const entries = (config: OrdinaryHeadRotationConfig) => ordinaryRotationTelemetry.snapshot(config).entries
    .filter((entry) => entry.workspace === 'ls-rot/v1')
  let threw = false
  const run = async (
    config: OrdinaryHeadRotationConfig,
    stillOwned: () => boolean = () => true,
    onFenceClaimed?: () => void,
  ) => {
    ordinaryRotationTelemetry.resetForTest()
    threw = false
    const fixture = await workspace(1)
    let stop: (() => void) | undefined
    let seen: ReturnType<typeof entries> = []
    await dueEvents(async () => {
      try { stop = await start(fixture, fakeDb(onFenceClaimed).db, config, stillOwned) } catch { threw = true }
      seen = entries(config)
    })
    stop?.()
    ordinaryRotationTelemetry.resetForTest()
    return seen
  }
  const rotating = shadow({ mode: 'on', maxChanges: 512 })

  it('control: on, allow-listed, owned — both kinds, resident, as ModelMeta lists them', async () => {
    const seen = await run(rotating)
    expect(seen.map((entry) => entry.collection)).toEqual(['connection', 'object'])
    for (const entry of seen) expect(entry).toMatchObject({ resident: true, listedShards: 2, rotations: 0 })
  }, 30_000)

  it('shadow, even allow-listed: nothing', async () => {
    expect(await run(shadow({ maxChanges: 512 }))).toEqual([])
  }, 30_000)

  it('on, but the allow-list does not name the workspace: nothing', async () => {
    expect(await run({ ...rotating, allowlist: new Set(['someone/else']) })).toEqual([])
  }, 30_000)

  it('on and allow-listed, but ownership lost AFTER the build claimed the fence: nothing', async () => {
    // Unowned from the start, the claim is skipped and the attach throws
    // (a lost write fence) before it could register: not the window. The
    // window is a loss between the claim and the end of the attach.
    let owned = true
    expect(await run(rotating, () => owned, () => { owned = false })).toEqual([])
    expect(threw, 'the attach itself must succeed, or this tests nothing').toBe(false)
  }, 30_000)
})

/** The fleet is the only production caller, and `startReadModelProjector`
 * defaults to OFF — so a fleet that stopped forwarding its config would turn
 * shadow off for the whole process with every test above still green. */
describe('ordinary writer-head rotation — the fleet hands its config to every projector', () => {
  const fleetDb = {
    query: async (text: string) => /read_model_static_workspaces/.test(text)
      ? { rows: [{ present: false }], rowCount: 1 }
      : { rows: [], rowCount: 0 },
  } as never

  async function forwardedConfig(ordinaryHeadRotation?: OrdinaryHeadRotationConfig): Promise<unknown> {
    const startProjector = vi.fn(async (..._args: unknown[]) => vi.fn())
    const fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:fallback',
      db: fleetDb,
      startProjector: startProjector as unknown as typeof startReadModelProjector,
      ...(ordinaryHeadRotation ? { ordinaryHeadRotation } : {}),
    })
    try {
      expect(await fleet.ensure(WORKSPACE)).toBe(true)
    } finally { fleet.stopAll() }
    expect(startProjector).toHaveBeenCalledTimes(1)
    // The 11th positional parameter of `startReadModelProjector`.
    return startProjector.mock.calls[0][10]
  }

  it('forwards the config index.ts parsed at boot', async () => {
    const config = shadow()
    expect(await forwardedConfig(config)).toBe(config)
  })

  it('without one, forwards what the environment says rather than OFF', async () => {
    vi.stubEnv(ORDINARY_HEAD_ROTATION_FLAG, 'shadow')
    vi.stubEnv(ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV, 'ls-rot/v1')
    try {
      expect(await forwardedConfig()).toMatchObject({ mode: 'shadow', allowlist: new Set(['ls-rot/v1']) })
    } finally { vi.unstubAllEnvs() }
  })
})
