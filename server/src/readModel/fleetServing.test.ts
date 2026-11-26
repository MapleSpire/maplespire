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
import { ProjectorCompactionInProgressError, ProjectorFleet, ProjectorOwnershipError, startReadModelProjector } from './projectorService.js'
import { ColdBuildAdmission, ColdBuildAdmissionStoppedError } from './coldBuildAdmission.js'
import { ReadModelAdoptAttachError } from './adoptVerify.js'
import { compactionFleet, divergenceEligible, ensureServedForReadiness, readRouteServes } from './fleetServing.js'
import type { WorkspaceKey } from './projector.js'

/**
 * G4-16f C6-2b, the fleet's SERVING state with a scripted projector (no
 * database): an adopting start calls `onServing` (its claim committed), then
 * `admitBuild`, then waits for the test to finish or fail its attach.
 * The real projector and PostgreSQL are `adoptTakeover.integration.test.ts`
 * (A17, A18, A5/A6 in the window).
 */

interface Options {
  adopt: string
  signal: AbortSignal
  onServing?: () => void
  admitBuild?: () => Promise<void>
}

interface Start {
  key: string
  mode: string
  options: Options
  /** Resolves the attach (B5 done). */
  finish: () => void
  /** Fails the attach. */
  fail: (error: unknown) => void
  /** Set once `admitBuild` returned (the build slot held). */
  admitted: boolean
  stop: ReturnType<typeof vi.fn>
}

const fakeDb = () => ({ query: async () => ({ rows: [{ present: false }], rowCount: 1 }) }) as never

function scripted(opts: {
  /** Does an `on` start's claim succeed (onServing)? Default yes. */
  claims?: (key: string) => boolean
  coldBuildAdmission?: ColdBuildAdmission
  claimAdmission?: ColdBuildAdmission
  maxProjectors?: number
  /** Null: the workspace resolves to no root. */
  root?: string | null
  owns?: () => boolean
  /** Awaited before the claim decides (the claim phase, S1-S6). */
  beforeClaim?: (start: Start) => Promise<void>
  /** Thrown before the claim decides (a refusal path that fails). */
  failBeforeServing?: (key: string) => unknown
} = {}) {
  const starts: Start[] = []
  const startProjector = vi.fn(async (...args: unknown[]) => {
    const options = args.at(-1) as Options
    const key = args[3] as WorkspaceKey
    let finish!: () => void
    let fail!: (error: unknown) => void
    const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
    const start: Start = {
      key: `${key.landscapeId}/${key.versionId}`, mode: options.adopt, options,
      finish: () => finish(), fail: (error) => fail(error), admitted: false, stop: vi.fn(),
    }
    starts.push(start)
    ;(args[9] as ((id: string) => void) | undefined)?.(`instance-${starts.length}`)
    await opts.beforeClaim?.(start)
    const early = opts.failBeforeServing?.(start.key)
    if (early) throw early
    if (options.adopt === 'on' && (opts.claims?.(start.key) ?? true)) options.onServing?.()
    await options.admitBuild?.()
    start.admitted = true
    await done
    if (options.signal.aborted) throw new ReadModelAdoptAttachError('B3', 'aborted')
    return start.stop
  })
  const fleet = new ProjectorFleet(new Repo({}), async () => (opts.root === undefined ? 'automerge:root' : opts.root), {
    fallbackRootUrl: 'automerge:fallback', db: fakeDb(), adopt: 'on',
    ...(opts.owns ? { ownsWorkspace: opts.owns } : {}),
    startProjector: startProjector as unknown as typeof startReadModelProjector,
    ...(opts.coldBuildAdmission ? { coldBuildAdmission: opts.coldBuildAdmission } : {}),
    ...(opts.claimAdmission ? { claimAdmission: opts.claimAdmission } : {}),
    ...(opts.maxProjectors ? { maxProjectors: opts.maxProjectors } : {}),
  })
  const startOf = async (key: WorkspaceKey, nth = 1): Promise<Start> => {
    const name = `${key.landscapeId}/${key.versionId}`
    return vi.waitFor(() => {
      const found = starts.filter((start) => start.key === name)[nth - 1]
      if (!found) throw new Error(`no start ${nth} for ${name} yet`)
      return found
    })
  }
  return { fleet, starts, startOf }
}

/** A promise's state, without awaiting it to the end. */
async function settledState(promise: Promise<unknown>): Promise<'pending' | 'fulfilled' | 'rejected'> {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending'
  promise.then(() => { state = 'fulfilled' }, () => { state = 'rejected' })
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
  return state
}

const K: WorkspaceKey = { landscapeId: 'L', versionId: 'v' }
const fleets: ProjectorFleet[] = []
afterEach(() => {
  for (const fleet of fleets.splice(0)) fleet.stopAll()
  vi.restoreAllMocks()
})

describe('ensure() resolves at SERVING; isServing vs isResident (A17, fleet)', () => {
  it('an adopting start: ensure resolves at the claim; isServing true and isResident false until the attach is done; then resident and no longer only serving', async () => {
    const h = scripted()
    fleets.push(h.fleet)
    expect(await h.fleet.ensure(K)).toBe(true)
    const start = await h.startOf(K)
    expect(start.mode).toBe('on')
    expect(h.fleet.isServing(K)).toBe(true)
    expect(h.fleet.isResident(K)).toBe(false)
    expect(h.fleet.residentProjectorInstanceId(K), 'the promotion check sees no resident instance').toBeNull()
    expect(h.fleet.size(), 'not in the LRU yet').toBe(0)
    // A second plain ensure in the window: true at once, no second start.
    expect(await h.fleet.ensure(K)).toBe(true)
    // until:'attached' and adopt:false wait for the attach.
    const attached = h.fleet.ensure(K, { until: 'attached' })
    const compaction = h.fleet.ensure(K, { adopt: false })
    expect(await settledState(attached)).toBe('pending')
    expect(await settledState(compaction)).toBe('pending')
    expect(h.starts).toHaveLength(1)
    start.finish()
    expect(await attached).toBe(true)
    expect(await compaction).toBe(true)
    expect(h.fleet.isResident(K)).toBe(true)
    expect(h.fleet.isServing(K)).toBe(true)
    expect(h.fleet.residentProjectorInstanceId(K)).toBe('instance-1')
  })

  it('a claim refused (the projector cold-builds, no onServing): ensure resolves only at the attach, and the workspace is never serving before it', async () => {
    const h = scripted({ claims: () => false })
    fleets.push(h.fleet)
    const ensured = h.fleet.ensure(K)
    const start = await h.startOf(K)
    expect(await settledState(ensured)).toBe('pending')
    expect(h.fleet.isServing(K)).toBe(false)
    start.finish()
    expect(await ensured).toBe(true)
    expect(h.fleet.isResident(K)).toBe(true)
  })

  it('a fleet with adopt OFF: serving and attached are one moment (the cold build), ensure resolves at the attach', async () => {
    const starts: Array<() => void> = []
    const startProjector = vi.fn(async (...args: unknown[]) => {
      const options = args.at(-1) as Options
      expect(options.onServing, 'no serving hook for a cold start').toBeUndefined()
      expect(options.admitBuild, 'no admission hook for a cold start (the slot is around it)').toBeUndefined()
      await new Promise<void>((resolve) => starts.push(resolve))
      return vi.fn()
    })
    const fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:fallback', db: fakeDb(), adopt: 'off',
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })
    fleets.push(fleet)
    const ensured = fleet.ensure(K)
    await vi.waitFor(() => expect(starts).toHaveLength(1))
    expect(await settledState(ensured)).toBe('pending')
    expect(fleet.isServing(K)).toBe(false)
    starts[0]!()
    expect(await ensured).toBe(true)
    expect(fleet.isServing(K) && fleet.isResident(K)).toBe(true)
  })
})

describe('release, stopAll and the LRU in the window (A17, A6 fleet)', () => {
  it('release() in the window ends serving AT ONCE and aborts the attach; an ensure in between gets the doomed start, never a stale true; the next start is fresh', async () => {
    const h = scripted()
    fleets.push(h.fleet)
    expect(await h.fleet.ensure(K)).toBe(true)
    const first = await h.startOf(K)
    h.fleet.release(K, 'test')
    expect(h.fleet.isServing(K), 'serving ends with the release, before the attach notices').toBe(false)
    expect(first.options.signal.aborted).toBe(true)
    const between = h.fleet.ensure(K)
    expect(await settledState(between), 'not the spent serving promise').toBe('pending')
    first.finish()
    await expect(between).rejects.toThrow(ProjectorOwnershipError)
    expect(h.fleet.isResident(K)).toBe(false)
    // Fresh.
    expect(await h.fleet.ensure(K)).toBe(true)
    expect(h.starts).toHaveLength(2)
    expect(h.fleet.isServing(K)).toBe(true)
  })

  it('stopAll() in the window ends serving, aborts the attach, and its failure is handled (no unhandled rejection)', async () => {
    const h = scripted()
    expect(await h.fleet.ensure(K)).toBe(true)
    const start = await h.startOf(K)
    h.fleet.stopAll()
    expect(h.fleet.isServing(K)).toBe(false)
    expect(start.options.signal.aborted).toBe(true)
    start.finish()
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.fleet.isResident(K)).toBe(false)
    await expect(h.fleet.ensure(K)).rejects.toThrow(ColdBuildAdmissionStoppedError)
  })

  it('onServing from a start released BEFORE its claim committed is ignored: no serving resurrected for a workspace this fleet no longer speaks for', async () => {
    // eslint-disable-next-line prefer-const -- assigned once, after the start it is read from
    let fleet!: ProjectorFleet
    const startProjector = vi.fn(async (...args: unknown[]) => {
      const options = args.at(-1) as Options
      fleet.release(K, 'test')
      options.onServing?.()
      await options.admitBuild?.().catch(() => undefined)
      throw new ReadModelAdoptAttachError('B1', 'aborted')
    })
    fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:fallback', db: fakeDb(), adopt: 'on',
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })
    fleets.push(fleet)
    await expect(fleet.ensure(K)).rejects.toThrow(ProjectorOwnershipError)
    expect(fleet.isServing(K)).toBe(false)
  })

  it('the LRU never evicts a SERVING start: cap 1, B serving; A then C attach (C evicts A, B untouched); B attaching then evicts C', async () => {
    const h = scripted({ maxProjectors: 1, claims: (key) => key === 'L/b' })
    fleets.push(h.fleet)
    const A = { landscapeId: 'L', versionId: 'a' }
    const B = { landscapeId: 'L', versionId: 'b' }
    const C = { landscapeId: 'L', versionId: 'c' }
    expect(await h.fleet.ensure(B)).toBe(true)
    const b = await h.startOf(B)
    const a = h.fleet.ensure(A)
    ;(await h.startOf(A)).finish()
    expect(await a).toBe(true)
    const c = h.fleet.ensure(C)
    ;(await h.startOf(C)).finish()
    expect(await c).toBe(true)
    expect(h.fleet.isResident(A), 'A was the LRU victim').toBe(false)
    expect(h.fleet.isServing(B), 'B still serving').toBe(true)
    expect(b.options.signal.aborted, 'B\'s attach never aborted').toBe(false)
    b.finish()
    expect(await h.fleet.ensure(B, { until: 'attached' })).toBe(true)
    expect(h.fleet.isResident(B)).toBe(true)
    expect(h.fleet.isResident(C), 'the cap is enforced when B becomes resident').toBe(false)
    // Once resident, B is the LRU's like any other: evicted, it is no longer
    // served either (its serving ended when it became resident).
    const D = { landscapeId: 'L', versionId: 'd' }
    const dEnsured = h.fleet.ensure(D)
    ;(await h.startOf(D)).finish()
    expect(await dEnsured).toBe(true)
    expect(h.fleet.isResident(B)).toBe(false)
    expect(h.fleet.isServing(B), 'an evicted workspace is not served').toBe(false)
  })
})

describe('a background failure after serving (A5/A6 fleet)', () => {
  it('an adopt failure of its own after serving: logged; the fallback cold build runs in the background, the kept rows STILL served (no served → 503 flap); until:attached waits for it; then resident', async () => {
    const h = scripted()
    fleets.push(h.fleet)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.fleet.ensure(K)).toBe(true)
    const adopting = await h.startOf(K)
    adopting.fail(new ReadModelAdoptAttachError('B4', 'gap-failed: x'))
    const fallback = await h.startOf(K, 2)
    expect(fallback.mode).toBe('off')
    expect(h.fleet.isServing(K), 'still serving while the fallback builds').toBe(true)
    expect(h.fleet.isResident(K)).toBe(false)
    expect(readRouteServes(h.fleet, K)).toBe(true)
    expect(await h.fleet.ensure(K), 'a reader is served at once').toBe(true)
    const attached = h.fleet.ensure(K, { until: 'attached' })
    expect(await settledState(attached), 'until:attached waits for the fallback').toBe('pending')
    expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('"event":"read_model.adopt_attach_failed"'))).toHaveLength(1)
    fallback.finish()
    expect(await attached).toBe(true)
    expect(h.fleet.isResident(K)).toBe(true)
    expect(fallback.admitted, 'the fallback was admitted (it kept the slot)').toBe(true)
  })

  it('a FAILED fallback ends serving, warns once (adopt_serving_failed), and the next ensure starts afresh', async () => {
    const h = scripted()
    fleets.push(h.fleet)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.fleet.ensure(K)).toBe(true)
    ;(await h.startOf(K)).fail(new ReadModelAdoptAttachError('B1', 'topology-moved'))
    const fallback = await h.startOf(K, 2)
    const attached = h.fleet.ensure(K, { until: 'attached' })
    fallback.fail(new Error('test: the cold build failed'))
    await expect(attached).rejects.toThrow('test: the cold build failed')
    expect(h.fleet.isServing(K)).toBe(false)
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('"event":"read_model.adopt_serving_failed"'))
    expect(lines).toHaveLength(1)
    expect(await settledState(h.fleet.ensure(K))).not.toBe('rejected')
    expect(h.starts).toHaveLength(3)
  })

  it('the fallback REUSES the build slot of its adopt attempt (one cold slot: never waits on itself)', async () => {
    const cold = new ColdBuildAdmission({ maxConcurrent: 1, maxQueued: 32 })
    const h = scripted({ coldBuildAdmission: cold })
    fleets.push(h.fleet)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.fleet.ensure(K)).toBe(true)
    const adopting = await h.startOf(K)
    await vi.waitFor(() => expect(adopting.admitted).toBe(true))
    adopting.fail(new ReadModelAdoptAttachError('B2', 'error'))
    const fallback = await h.startOf(K, 2)
    await vi.waitFor(() => expect(fallback.admitted, 'admitted on the held slot').toBe(true))
    expect(cold.snapshot()).toMatchObject({ active: 1, queued: 0 })
    fallback.finish()
    expect(await h.fleet.ensure(K, { until: 'attached' })).toBe(true)
  })

  it('any other failure after serving: serving ends, it is logged once, nothing is retried, and the rejection is handled (no unhandled rejection reaches the process)', async () => {
    const h = scripted()
    fleets.push(h.fleet)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.fleet.ensure(K)).toBe(true)
    const start = await h.startOf(K)
    const attached = h.fleet.ensure(K, { until: 'attached' })
    start.fail(new Error('test: the meta pass threw'))
    await expect(attached).rejects.toThrow('test: the meta pass threw')
    expect(h.fleet.isServing(K)).toBe(false)
    expect(h.starts).toHaveLength(1)
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('read_model.adopt_serving_failed'))
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ workspace: 'L/v', error: 'Error: test: the meta pass threw' })
    // The next ensure starts again.
    expect(await h.fleet.ensure(K)).toBe(true)
    expect(h.starts).toHaveLength(2)
  })
})

describe('the claim\'s own admission (design risk 1)', () => {
  it('three workspaces taken over at once with ONE cold-build slot: all three SERVE; the attaches are admitted one at a time', async () => {
    const cold = new ColdBuildAdmission({ maxConcurrent: 1, maxQueued: 32 })
    const h = scripted({ coldBuildAdmission: cold })
    fleets.push(h.fleet)
    const keys = ['a', 'b', 'c'].map((versionId) => ({ landscapeId: 'L', versionId }))
    const served = await Promise.all(keys.map((key) => h.fleet.ensure(key)))
    expect(served).toEqual([true, true, true])
    for (const key of keys) expect(h.fleet.isServing(key)).toBe(true)
    const admitted = () => h.starts.filter((start) => start.admitted)
    await vi.waitFor(() => expect(admitted()).toHaveLength(1))
    expect(cold.snapshot()).toMatchObject({ active: 1, queued: 2 })
    admitted()[0]!.finish()
    await vi.waitFor(() => expect(admitted()).toHaveLength(2))
    for (const start of h.starts) start.finish()
    for (const key of keys) expect(await h.fleet.ensure(key, { until: 'attached' })).toBe(true)
    await vi.waitFor(() => expect(cold.snapshot()).toMatchObject({ active: 0, queued: 0 }))
  })

  it('the claim slot is given back at admitBuild: with ONE claim slot, three workspaces still all serve (in turn)', async () => {
    const claims = new ColdBuildAdmission({ maxConcurrent: 1, maxQueued: 32 })
    const h = scripted({ claimAdmission: claims })
    fleets.push(h.fleet)
    const keys = ['a', 'b', 'c'].map((versionId) => ({ landscapeId: 'L', versionId }))
    expect(await Promise.all(keys.map((key) => h.fleet.ensure(key)))).toEqual([true, true, true])
    await vi.waitFor(() => expect(claims.snapshot()).toMatchObject({ active: 0, queued: 0, completed: 3 }))
    for (const start of h.starts) start.finish()
  })

  it('a start released while QUEUED for a build slot gives up at once; the slot it is granted later is given back (never leaked)', async () => {
    const cold = new ColdBuildAdmission({ maxConcurrent: 1, maxQueued: 32 })
    const h = scripted({ coldBuildAdmission: cold })
    fleets.push(h.fleet)
    const A = { landscapeId: 'L', versionId: 'a' }
    const B = { landscapeId: 'L', versionId: 'b' }
    expect(await h.fleet.ensure(A)).toBe(true)
    await vi.waitFor(async () => expect((await h.startOf(A)).admitted).toBe(true))
    expect(await h.fleet.ensure(B)).toBe(true)
    const b = await h.startOf(B)
    expect(b.admitted).toBe(false)
    const bAttached = h.fleet.ensure(B, { until: 'attached' })
    h.fleet.release(B, 'test')
    await expect(bAttached).rejects.toThrow(ProjectorOwnershipError)
    expect(cold.snapshot()).toMatchObject({ active: 1 })
    ;(await h.startOf(A)).finish()
    await vi.waitFor(() => expect(cold.snapshot()).toMatchObject({ active: 0, queued: 0 }))
  })
})

describe('which question each index.ts caller asks (fleetServing.ts)', () => {
  it('in the window: the read route and readiness say SERVED; divergence, compaction and the instance check say NOT RESIDENT; after the attach all agree', async () => {
    const h = scripted()
    fleets.push(h.fleet)
    expect(await ensureServedForReadiness(h.fleet, K), 'readiness resolves at serving').toBe(true)
    const start = await h.startOf(K)
    expect(h.fleet.isResident(K)).toBe(false)
    const touch = vi.spyOn(h.fleet, 'touch')
    expect(readRouteServes(h.fleet, K)).toBe(true)
    expect(touch).toHaveBeenCalledWith(K)
    expect(divergenceEligible(h.fleet, K)).toBe(false)
    const compaction = compactionFleet(h.fleet)
    expect(compaction.isResident(K)).toBe(false)
    expect(compaction.residentProjectorInstanceId(K)).toBeNull()
    const ensured = compaction.ensure(K, { adopt: false })
    expect(await settledState(ensured), 'compaction\'s ensure waits for the attach').toBe('pending')
    start.finish()
    expect(await ensured).toBe(true)
    expect(divergenceEligible(h.fleet, K)).toBe(true)
    expect(compaction.isResident(K)).toBe(true)
    expect(compaction.residentProjectorInstanceId(K)).toBe('instance-1')
  })

  it('readiness is not resolved before serving: a refused claim keeps it pending until the cold build attaches', async () => {
    const h = scripted({ claims: () => false })
    fleets.push(h.fleet)
    const ready = ensureServedForReadiness(h.fleet, K)
    const start = await h.startOf(K)
    expect(await settledState(ready)).toBe('pending')
    expect(readRouteServes(h.fleet, K)).toBe(false)
    start.finish()
    expect(await ready).toBe(true)
  })

  it('readiness WATCHES the background attach: a real failure after serving reaches onAttachFailed once; a release (the ordinary end) does not', async () => {
    const h = scripted()
    fleets.push(h.fleet)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failures: unknown[] = []
    expect(await ensureServedForReadiness(h.fleet, K, (error) => failures.push(error))).toBe(true)
    ;(await h.startOf(K)).fail(new Error('test: the meta pass threw'))
    await vi.waitFor(() => expect(failures).toHaveLength(1))
    expect(String(failures[0])).toContain('test: the meta pass threw')
    // A release in the window: nothing reported.
    const B = { landscapeId: 'L', versionId: 'b' }
    const quiet: unknown[] = []
    expect(await ensureServedForReadiness(h.fleet, B, (error) => quiet.push(error))).toBe(true)
    const b = await h.startOf(B)
    h.fleet.release(B, 'test')
    b.finish()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(quiet).toEqual([])
  })
})

describe('C6-2b: the cases the first tests left uncovered', () => {
  it('a workspace with NO ROOT: ensure answers false for serving and attached (never a served true), and the claim slot is given back on that early exit', async () => {
    const claims = new ColdBuildAdmission({ maxConcurrent: 1, maxQueued: 0 })
    const h = scripted({ root: null, claimAdmission: claims })
    fleets.push(h.fleet)
    expect(await h.fleet.ensure(K)).toBe(false)
    expect(await h.fleet.ensure({ landscapeId: 'L', versionId: 'w' }, { until: 'attached' })).toBe(false)
    expect(h.fleet.isServing(K)).toBe(false)
    await vi.waitFor(() => expect(claims.snapshot()).toMatchObject({ active: 0, rejected: 0 }))
  })

  it('every ensure that arrives DURING the claim phase resolves at onServing, with the attach still pending', async () => {
    let openClaim: () => void = () => {}
    const claimGate = new Promise<void>((resolve) => { openClaim = resolve })
    const h = scripted({ beforeClaim: () => claimGate })
    fleets.push(h.fleet)
    const first = h.fleet.ensure(K)
    await h.startOf(K)
    const second = h.fleet.ensure(K)
    expect(await settledState(second)).toBe('pending')
    openClaim()
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(h.fleet.isResident(K)).toBe(false)
  })

  it('a failure BEFORE serving, awaited only through until:attached, rejects that caller and leaves no unhandled rejection; it is not reported as a serving failure', async () => {
    const h = scripted({ failBeforeServing: () => new Error('test: the static check threw') })
    fleets.push(h.fleet)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(h.fleet.ensure(K, { until: 'attached' })).rejects.toThrow('test: the static check threw')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('adopt_serving_failed'))).toEqual([])
  })

  it('stopAll while a start is QUEUED for a claim slot rejects it as stopped; a release while queued is an ownership loss, counted', async () => {
    let openClaim: () => void = () => {}
    const claimGate = new Promise<void>((resolve) => { openClaim = resolve })
    const claims = new ColdBuildAdmission({ maxConcurrent: 1, maxQueued: 8 })
    const h = scripted({ claimAdmission: claims, beforeClaim: (start) => (start.key === 'L/a' ? claimGate : Promise.resolve()) })
    const A = { landscapeId: 'L', versionId: 'a' }
    const B = { landscapeId: 'L', versionId: 'b' }
    const C = { landscapeId: 'L', versionId: 'c' }
    const a = h.fleet.ensure(A)
    await h.startOf(A)
    const b = h.fleet.ensure(B)
    const c = h.fleet.ensure(C)
    await vi.waitFor(() => expect(claims.snapshot()).toMatchObject({ queued: 2 }))
    const before = h.fleet.snapshot().ownershipRejectedStarts
    h.fleet.release(B, 'test')
    await expect(b).rejects.toThrow(ProjectorOwnershipError)
    expect(h.fleet.snapshot().ownershipRejectedStarts).toBe(before + 1)
    expect(claims.snapshot(), 'the released wait left the queue').toMatchObject({ queued: 1 })
    h.fleet.stopAll()
    await expect(c).rejects.toThrow(ColdBuildAdmissionStoppedError)
    openClaim()
    await a.catch(() => undefined)
  })

  it('the DEFAULT claim admission is bounded: with the claim phase held, only two starts enter it at once', async () => {
    let openClaim: () => void = () => {}
    const claimGate = new Promise<void>((resolve) => { openClaim = resolve })
    const h = scripted({ beforeClaim: () => claimGate })
    fleets.push(h.fleet)
    const ensured = ['a', 'b', 'c', 'd'].map((versionId) => h.fleet.ensure({ landscapeId: 'L', versionId }))
    await vi.waitFor(() => expect(h.starts).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.starts).toHaveLength(2)
    expect(h.fleet.snapshot().claimAdmission).toMatchObject({ active: 2, queued: 2 })
    openClaim()
    expect(await Promise.all(ensured)).toEqual([true, true, true, true])
    expect(h.fleet.snapshot().servingWorkspaces).toBe(4)
  })

  it('a claim admission that REFUSES (queue full) rejects the ensure, never hangs it', async () => {
    let openClaim: () => void = () => {}
    const claimGate = new Promise<void>((resolve) => { openClaim = resolve })
    const claims = new ColdBuildAdmission({ maxConcurrent: 1, maxQueued: 0 })
    const h = scripted({ claimAdmission: claims, beforeClaim: () => claimGate })
    fleets.push(h.fleet)
    const a = h.fleet.ensure({ landscapeId: 'L', versionId: 'a' })
    await h.startOf({ landscapeId: 'L', versionId: 'a' })
    await expect(h.fleet.ensure({ landscapeId: 'L', versionId: 'b' })).rejects.toThrow(/queue is full/)
    openClaim()
    expect(await a).toBe(true)
  })

  it('a COMMITTED claim is never refused a build slot for a full queue (S1): it queues past maxQueued, keeps serving, then attaches', async () => {
    const cold = new ColdBuildAdmission({ maxConcurrent: 1, maxQueued: 0 })
    const h = scripted({ coldBuildAdmission: cold, claims: (key) => key === 'L/b' })
    fleets.push(h.fleet)
    const A = { landscapeId: 'L', versionId: 'a' }
    const B = { landscapeId: 'L', versionId: 'b' }
    const a = h.fleet.ensure(A)                      // a refused claim: cold, holds the one slot
    const aStart = await h.startOf(A)
    await vi.waitFor(() => expect(aStart.admitted).toBe(true))
    expect(await h.fleet.ensure(B)).toBe(true)        // B claims and serves
    const b = await h.startOf(B)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(b.admitted).toBe(false)
    expect(h.fleet.isServing(B), 'still serving while queued').toBe(true)
    expect(h.starts.filter((start) => start.key === 'L/b'), 'no fallback').toHaveLength(1)
    aStart.finish()
    expect(await a).toBe(true)
    await vi.waitFor(() => expect(b.admitted).toBe(true))
    b.finish()
    expect(await h.fleet.ensure(B, { until: 'attached' })).toBe(true)
  })

  it('compactionFleet passes the release REASON: a compaction release makes the next start off', async () => {
    const h = scripted()
    fleets.push(h.fleet)
    const adapter = compactionFleet(h.fleet)
    adapter.release(K, 'compaction')
    // T-VANISH: inside the fold's window a plain start is refused, and the
    // adapter passes the window's close through.
    await expect(h.fleet.ensure(K)).rejects.toBeInstanceOf(ProjectorCompactionInProgressError)
    adapter.endCompactionWindow(K)
    const ensured = h.fleet.ensure(K)
    ;(await h.startOf(K)).finish()
    expect(await ensured).toBe(true)
    expect(h.starts[0]!.mode).toBe('off')
  })

  it('ownership lost WITHOUT a release before the claim committed: onServing does not set serving', async () => {
    let owned = true
    const h = scripted({ owns: () => owned, beforeClaim: async () => { owned = false } })
    fleets.push(h.fleet)
    const ensured = h.fleet.ensure(K)
    const start = await h.startOf(K)
    await vi.waitFor(() => expect(start.admitted).toBe(true))
    expect(h.fleet.isServing(K)).toBe(false)
    start.finish()
    await expect(ensured).rejects.toThrow(ProjectorOwnershipError)
  })
})
