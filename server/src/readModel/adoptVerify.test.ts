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

import { describe, expect, it, vi } from 'vitest'
import * as A from '@automerge/automerge'
import { Repo } from '@automerge/automerge-repo'
import { ProjectorCompactionInProgressError, ProjectorFleet, ProjectorOwnershipError, startReadModelProjector } from './projectorService.js'
import {
  AdoptClaimOutcomeUnknownError,
  AdoptSeedHeadsUnknownError,
  READ_MODEL_ADOPT_FLAG,
  ReadModelAdoptAttachError,
  adoptSeedContent,
  adoptSeedMap,
  classifyListedShards,
  seedHeadsEqual,
  fenceRowRefusal,
  readModelAdoptMode,
  seedHeadsAgainstBuild,
  verifyAdoptShadow,
  type ListedShardRow,
} from './adoptVerify.js'
import { markReadModelProjectorAdopting } from './health.js'
import type { Queryable } from './types.js'

/**
 * G4-16f C6-1 without a database: the flag, the S5 classifier and its seed
 * rule. The claim's SQL steps are `adoptTakeover.integration.test.ts`'s.
 */

const row = (over: Partial<ListedShardRow> & Pick<ListedShardRow, 'documentId'>): ListedShardRow => ({
  collection: 'object', position: 1, hasWatermark: true, projectedHeads: ['p1'], status: null, origin: null,
  retirementHeads: null, forwardedHeads: null, foldedInto: null, isFoldProduct: false, ...over,
})

describe('READ_MODEL_ADOPT (readModelAdoptMode)', () => {
  it('unset, empty, blank and off are off; shadow is shadow (trimmed)', () => {
    expect(READ_MODEL_ADOPT_FLAG).toBe('READ_MODEL_ADOPT')
    expect(readModelAdoptMode({})).toBe('off')
    expect(readModelAdoptMode({ READ_MODEL_ADOPT: '' })).toBe('off')
    expect(readModelAdoptMode({ READ_MODEL_ADOPT: '  ' })).toBe('off')
    expect(readModelAdoptMode({ READ_MODEL_ADOPT: 'off' })).toBe('off')
    expect(readModelAdoptMode({ READ_MODEL_ADOPT: 'shadow' })).toBe('shadow')
    expect(readModelAdoptMode({ READ_MODEL_ADOPT: ' shadow\n' })).toBe('shadow')
  })

  it('on is ACCEPTED since C6-2a (trimmed)', () => {
    expect(readModelAdoptMode({ READ_MODEL_ADOPT: 'on' })).toBe('on')
    expect(readModelAdoptMode({ READ_MODEL_ADOPT: ' on\n' })).toBe('on')
  })

  it('any other value refuses to boot — never silently off (Shadow, 1, true, yes, ON)', () => {
    for (const value of ['Shadow', 'SHADOW', '1', 'true', 'yes', 'ON', 'On', 'off,shadow', 'shadowx', 'onn']) {
      expect(() => readModelAdoptMode({ READ_MODEL_ADOPT: value }), value).toThrow(/invalid-READ_MODEL_ADOPT/)
    }
  })
})

describe('classifyListedShards (S5)', () => {
  it('a clean listing classifies every shard: projected, retired (forwarded ?? H_r), product (H_r), new', () => {
    const result = classifyListedShards([
      row({ documentId: 'base', projectedHeads: ['b1'] }),
      row({ documentId: 'r-fwd', position: 2, status: 'retired', origin: 'rotation', retirementHeads: ['hr'], forwardedHeads: ['fw'], projectedHeads: ['stamp'] }),
      row({ documentId: 'r-hr', position: 3, status: 'retired', origin: 'rotation', retirementHeads: ['hr2'], projectedHeads: ['stamp2'] }),
      row({ documentId: 'prod', position: 4, status: 'retired', origin: 'fold-product', retirementHeads: ['ph'], forwardedHeads: ['pf'], projectedHeads: ['x'] }),
      row({ documentId: 'prod-rec', position: 5, status: 'retired', origin: null, isFoldProduct: true, retirementHeads: ['qh'], forwardedHeads: ['qf'] }),
      row({ documentId: 'fresh', position: 6, hasWatermark: false, projectedHeads: null }),
      row({ documentId: 'adm', position: 7, status: 'admitted', projectedHeads: ['a1'] }),
      row({ documentId: 'conn', collection: 'connection', position: 1, projectedHeads: ['c1'] }),
    ])
    expect(result.refusal).toBeNull()
    if (result.refusal !== null) return
    const byId = Object.fromEntries(result.seeds.map((seed) => [seed.documentId, seed]))
    expect(byId.base).toMatchObject({ source: 'projected', heads: ['b1'] })
    expect(byId['r-fwd']).toMatchObject({ source: 'retired', heads: ['fw'] })
    expect(byId['r-hr']).toMatchObject({ source: 'retired', heads: ['hr2'] })
    expect(byId.prod).toMatchObject({ source: 'product', heads: ['ph'] })
    expect(byId['prod-rec']).toMatchObject({ source: 'product', heads: ['qh'] })
    expect(byId.fresh).toMatchObject({ source: 'new', heads: null })
    // `admitted` is treated like no retirement row.
    expect(byId.adm).toMatchObject({ source: 'projected', heads: ['a1'] })
    expect(byId.conn).toMatchObject({ collection: 'connection', source: 'projected', heads: ['c1'] })
    expect(result.counts).toEqual({ listed: 8, retired: 2, products: 2, projected: 3, newShards: 1 })
  })

  it('a retired head NEVER seeds at projected_heads — not even when it has them and nothing else', () => {
    // H_r only: the seed is H_r, not the stamp's forwarded-up-to heads.
    const retired = classifyListedShards([
      row({ documentId: 'r', status: 'retired', origin: 'rotation', retirementHeads: ['hr'], forwardedHeads: null, projectedHeads: ['stamp'] }),
    ])
    expect(retired.refusal).toBeNull()
    if (retired.refusal === null) expect(retired.seeds[0]).toMatchObject({ source: 'retired', heads: ['hr'] })
    // A retired head whose heads are missing refuses rather than fall back
    // to projected_heads (a row the schema's CHECK forbids, written by hand).
    const missing = classifyListedShards([
      row({ documentId: 'r', status: 'retired', origin: 'rotation', retirementHeads: null, forwardedHeads: null, projectedHeads: ['stamp'] }),
    ])
    expect(missing).toMatchObject({ refusal: 'seed-heads' })
    // A product with forwarded heads still seeds at H_r.
    const product = classifyListedShards([
      row({ documentId: 'p', status: 'retired', origin: 'fold-product', retirementHeads: null, forwardedHeads: ['pf'], projectedHeads: ['stamp'] }),
    ])
    expect(product).toMatchObject({ refusal: 'seed-heads' })
  })

  it('a document listed twice — in one list or across both — refuses (duplicate-listing)', () => {
    expect(classifyListedShards([row({ documentId: 'a' }), row({ documentId: 'a', position: 2 })]))
      .toMatchObject({ refusal: 'duplicate-listing', detail: 'a' })
    expect(classifyListedShards([row({ documentId: 'a' }), row({ documentId: 'a', collection: 'connection' })]))
      .toMatchObject({ refusal: 'duplicate-listing' })
    // Control: distinct ids.
    expect(classifyListedShards([row({ documentId: 'a' }), row({ documentId: 'b', position: 2 })]).refusal).toBeNull()
  })

  it('a NON-retired shard whose watermark row carries NULL heads refuses; no row at all is a new shard, not a refusal', () => {
    expect(classifyListedShards([row({ documentId: 'a', hasWatermark: true, projectedHeads: null })]))
      .toMatchObject({ refusal: 'null-projected-heads', detail: 'object:a' })
    expect(classifyListedShards([row({ documentId: 'a', status: 'admitted', hasWatermark: true, projectedHeads: null })]))
      .toMatchObject({ refusal: 'null-projected-heads' })
    expect(classifyListedShards([row({ documentId: 'a', hasWatermark: false, projectedHeads: null })]).refusal).toBeNull()
    // A retired head's NULL projected_heads is irrelevant (it never seeds there).
    expect(classifyListedShards([row({ documentId: 'r', status: 'retired', retirementHeads: ['h'], projectedHeads: null })]).refusal).toBeNull()
  })

  it('a listed folded row whose product is not listed in the same kind refuses; listed there, it seeds', () => {
    const folded = { documentId: 's', status: 'folded', origin: 'rotation', retirementHeads: ['h'], foldedInto: 'p' } as const
    expect(classifyListedShards([row(folded)])).toMatchObject({ refusal: 'folded-product-unlisted', detail: 'object:s->p' })
    // The product listed in the OTHER kind does not count.
    expect(classifyListedShards([row(folded), row({ documentId: 'p', collection: 'connection' })]))
      .toMatchObject({ refusal: 'folded-product-unlisted' })
    const ok = classifyListedShards([row(folded), row({ documentId: 'p', position: 2, status: 'retired', origin: 'fold-product', retirementHeads: ['ph'] })])
    expect(ok.refusal).toBeNull()
    if (ok.refusal === null) expect(ok.seeds[0]).toMatchObject({ source: 'retired', heads: ['h'] })
  })
})

describe('fenceRowRefusal (S1)', () => {
  const state = (over: Record<string, unknown> = {}) => ({
    observed_generation: '5', projected_generation: '5', last_error_generation: null,
    last_projected_at: new Date(0), degraded_since: null, content_digest: null, ...over,
  })
  it('observed AHEAD of projected (a pass a crash abandoned) is NOT a refusal', () => {
    expect(fenceRowRefusal(state())).toBeNull()
    expect(fenceRowRefusal(state({ observed_generation: '9' }))).toBeNull()
    // An error at or below the projection is history, not a failed status.
    expect(fenceRowRefusal(state({ last_error_generation: '5' }))).toBeNull()
    expect(fenceRowRefusal(state({ last_error_generation: '4' }))).toBeNull()
  })
  it('degraded, failed (error above the projection, compared as integers), uninitialized and no row refuse', () => {
    expect(fenceRowRefusal(state({ degraded_since: new Date(0) }))).toBe('degraded')
    expect(fenceRowRefusal(state({ last_error_generation: '6' }))).toBe('failed')
    // '10' > '9' only as integers (as text it sorts below).
    expect(fenceRowRefusal(state({ projected_generation: '9', last_error_generation: '10' }))).toBe('failed')
    expect(fenceRowRefusal(state({ last_projected_at: null }))).toBe('uninitialized')
    expect(fenceRowRefusal(undefined)).toBe('no-fence-row')
    expect(fenceRowRefusal(state({ projected_generation: null }))).toBe('no-fence-row')
  })
})

describe('the flag reaches the projector through the fleet', () => {
  const fakeDb = () => ({
    query: async (text: string) => {
      if (/read_model_static_workspaces/.test(text)) return { rows: [{ present: false }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    },
  }) as never
  it('ProjectorFleet hands `adopt` to every start as its trailing option, and OFF when the fleet was given none', async () => {
    for (const [given, expected] of [['shadow', 'shadow'], ['on', 'on'], [undefined, 'off']] as const) {
      const startProjector = vi.fn(async () => vi.fn())
      const fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
        fallbackRootUrl: 'automerge:fallback', db: fakeDb(),
        startProjector: startProjector as unknown as typeof startReadModelProjector,
        ...(given === undefined ? {} : { adopt: given }),
      })
      expect(await fleet.ensure({ landscapeId: 'L', versionId: 'v' })).toBe(true)
      const args = startProjector.mock.calls[0] as unknown[]
      const options = args.at(-1) as { adopt: string; signal: AbortSignal }
      expect(options.adopt, String(given)).toBe(expected)
      expect(options.signal).toBeInstanceOf(AbortSignal)
      // C6-2b: an ADOPTING start also gets the serving and admission hooks.
      // G4-16f (R4-d): every start gets the repoint hook.
      expect(Object.keys(options).sort()).toEqual(expected === 'on'
        ? ['admitBuild', 'adopt', 'onModelMetaRepointed', 'onServing', 'signal']
        : ['adopt', 'onModelMetaRepointed', 'signal'])
      fleet.stopAll()
    }
  })

  it('ensure(key, { adopt: false }) starts with OFF whatever the fleet was given (compaction); a plain ensure follows the fleet', async () => {
    const startProjector = vi.fn(async () => vi.fn())
    const fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:fallback', db: fakeDb(), adopt: 'on',
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })
    expect(await fleet.ensure({ landscapeId: 'L', versionId: 'a' }, { adopt: false })).toBe(true)
    expect(await fleet.ensure({ landscapeId: 'L', versionId: 'b' })).toBe(true)
    expect(await fleet.ensure({ landscapeId: 'L', versionId: 'c' }, { adopt: true })).toBe(true)
    const modes = startProjector.mock.calls.map((call) => ((call as unknown[]).at(-1) as { adopt: string }).adopt)
    expect(modes).toEqual(['off', 'on', 'on'])
    fleet.stopAll()
  })

  it('release() and stopAll() ABORT the signal of a start in flight; a resident start keeps an unaborted one', async () => {
    const signals: AbortSignal[] = []
    const gates: Array<() => void> = []
    const startProjector = vi.fn(async (...args: unknown[]) => {
      signals.push((args.at(-1) as { signal: AbortSignal }).signal)
      await new Promise<void>((resolve) => gates.push(resolve))
      return vi.fn()
    })
    const fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:fallback', db: fakeDb(), adopt: 'on',
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })
    const a = { landscapeId: 'L', versionId: 'a' }
    const b = { landscapeId: 'L', versionId: 'b' }
    const first = fleet.ensure(a)
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    fleet.release(a, 'test')
    expect(signals[0]!.aborted, 'release aborts the start in flight').toBe(true)
    gates.shift()!()
    await expect(first).rejects.toThrow(/not owned/)
    const second = fleet.ensure(b)
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    gates.shift()!()
    expect(await second).toBe(true)
    expect(signals[1]!.aborted, 'an attach that completed keeps its signal').toBe(false)
    // A third, in flight, then stopAll.
    fleet.release(b, 'again')
    const third = fleet.ensure(b)
    await vi.waitFor(() => expect(signals).toHaveLength(3))
    fleet.stopAll()
    expect(signals[2]!.aborted, 'stopAll aborts the start in flight').toBe(true)
    gates.shift()!()
    await expect(third).rejects.toThrow()
  })
})

describe('the fleet default and the attach guard', () => {
  it('a fleet given no `adopt` follows READ_MODEL_ADOPT (the same parse as index.ts), so no construction site can drop the wire', async () => {
    vi.stubEnv('READ_MODEL_ADOPT', 'shadow')
    try {
      const startProjector = vi.fn(async () => vi.fn())
      const fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
        fallbackRootUrl: 'automerge:fallback',
        db: { query: async () => ({ rows: [{ present: false }], rowCount: 1 }) } as never,
        startProjector: startProjector as unknown as typeof startReadModelProjector,
      })
      await fleet.ensure({ landscapeId: 'L', versionId: 'v' })
      expect((startProjector.mock.calls[0] as unknown[]).at(-1)).toMatchObject({ adopt: 'shadow' })
      fleet.stopAll()
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it('an attach given a mode this build cannot run (via a cast) rejects before its first statement', async () => {
    let statements = 0
    const db = { query: async () => { statements += 1; throw new Error('test: no database') } } as unknown as Queryable
    await expect(startReadModelProjectorForTest(db, 'adopt')).rejects.toThrow(/unsupported read-model adopt mode: adopt/)
    expect(statements).toBe(0)
    // Control: the same call with `off` gets past the guard to its first statement.
    await expect(startReadModelProjectorForTest(db, 'off')).rejects.toThrow()
    expect(statements).toBeGreaterThan(0)
  })
})

async function startReadModelProjectorForTest(db: Queryable, adopt: string) {
  return startReadModelProjector(new Repo({}), 'automerge:2j9knpCseyhnK8izDmLpGP5WMdZQ', db, { landscapeId: 'L', versionId: 'v' },
    undefined, 0, 50, undefined, undefined, undefined, undefined, { adopt: adopt as never })
}

describe('the seed extraction (C6-2a, B2/B3)', () => {
  // A shard at three revisions: v1 {a, b}; v2 deletes b and adds c; v3 edits a.
  const shard = () => {
    let doc = A.from<{ objects: Record<string, { id: string; name: string }> }>({
      objects: { a: { id: 'a', name: 'A' }, b: { id: 'b', name: 'B' } },
    })
    const v1 = A.getHeads(doc)
    doc = A.change(doc, (d) => { delete d.objects.b; d.objects.c = { id: 'c', name: 'C' } })
    const v2 = A.getHeads(doc)
    doc = A.change(doc, (d) => { d.objects.a.name = 'A2' })
    return { doc, v1, v2, v3: A.getHeads(doc) }
  }

  it('at the LIVE heads (as a set) the live document itself, no copy; elsewhere the view AT the seed heads, a plain copy', () => {
    const { doc, v1, v2, v3 } = shard()
    const live = adoptSeedContent(doc, [...v3].reverse())
    expect(live.atLive).toBe(true)
    expect(live.content).toBe(doc)
    expect(adoptSeedMap(doc, v3, 'objects')).toBe((doc as { objects: unknown }).objects)
    // v1: the deleted b is IN the seed — so the gap delta deletes its row.
    const atV1 = adoptSeedMap(doc, v1, 'objects')
    expect(atV1).toEqual({ a: { id: 'a', name: 'A' }, b: { id: 'b', name: 'B' } })
    expect(adoptSeedContent(doc, v1).atLive).toBe(false)
    expect(adoptSeedMap(doc, v2, 'objects')).toEqual({ a: { id: 'a', name: 'A' }, c: { id: 'c', name: 'C' } })
    // A plain copy, not a live Automerge object.
    expect(A.isAutomerge(atV1)).toBe(false)
  })

  it('a seed head ABSENT from the history THROWS — never the empty document `view` would return', () => {
    const { doc } = shard()
    const foreign = A.getHeads(A.from({ objects: { z: { id: 'z' } } }))
    // The trap the guard exists for: view() with unknown heads is silently empty.
    expect(Object.keys(A.view(doc, foreign) as object)).toEqual([])
    expect(() => adoptSeedContent(doc, foreign)).toThrow(AdoptSeedHeadsUnknownError)
    expect(() => adoptSeedMap(doc, foreign, 'objects')).toThrow(/absent from the document's history/)
    // One known head and one unknown: still refused.
    expect(() => adoptSeedContent(doc, [...A.getHeads(doc), ...foreign])).toThrow(AdoptSeedHeadsUnknownError)
  })

  it('a field absent or not a map at the seed heads is null (the attach fails), not {}', () => {
    let doc = A.from<{ objects?: unknown; other: number }>({ other: 1 })
    const before = A.getHeads(doc)
    doc = A.change(doc, (d) => { d.objects = { a: { id: 'a' } } })
    expect(adoptSeedMap(doc, before, 'objects')).toBeNull()
    expect(adoptSeedMap(doc, A.getHeads(doc), 'connections')).toBeNull()
    expect(adoptSeedMap(doc, A.getHeads(doc), 'objects')).toEqual({ a: { id: 'a' } })
  })

  it('seedHeadsEqual compares as sets', () => {
    expect(seedHeadsEqual(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(seedHeadsEqual(['a'], ['a', 'b'])).toBe(false)
    expect(seedHeadsEqual(['a', 'c'], ['a', 'b'])).toBe(false)
    expect(seedHeadsEqual([], [])).toBe(true)
  })
})

describe('the fleet after an adopting attach failed (C6-2a)', () => {
  const fakeDb = () => ({ query: async () => ({ rows: [{ present: false }], rowCount: 1 }) }) as never
  it('an adopt failure of its own is followed by ONE cold build (off) in the same ensure; an aborted one is an ownership loss and is not retried', async () => {
    const modes: string[] = []
    let fail: ReadModelAdoptAttachError | null = new ReadModelAdoptAttachError('B1', 'topology-moved')
    const startProjector = vi.fn(async (...args: unknown[]) => {
      const mode = (args.at(-1) as { adopt: string }).adopt
      modes.push(mode)
      if (mode === 'on' && fail) throw fail
      return vi.fn()
    })
    const fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:fallback', db: fakeDb(), adopt: 'on',
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await fleet.ensure({ landscapeId: 'L', versionId: 'a' })).toBe(true)
      expect(modes).toEqual(['on', 'off'])
      expect(fleet.isResident({ landscapeId: 'L', versionId: 'a' })).toBe(true)
      const logged = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('read_model.adopt_attach_failed'))
      expect(logged).toHaveLength(1)
      expect(JSON.parse(logged[0]!)).toMatchObject({ stage: 'B1', reason: 'topology-moved' })
      // Aborted: not retried, an ownership loss.
      modes.length = 0
      fail = new ReadModelAdoptAttachError('B3', 'aborted')
      await expect(fleet.ensure({ landscapeId: 'L', versionId: 'b' })).rejects.toThrow(ProjectorOwnershipError)
      expect(modes).toEqual(['on'])
      // A claim whose commit outcome is unknown: one cold build too.
      modes.length = 0
      fail = new AdoptClaimOutcomeUnknownError({ landscapeId: 'L', versionId: 'u' }, new Error('test: commit lost'))
      expect(await fleet.ensure({ landscapeId: 'L', versionId: 'u' })).toBe(true)
      expect(modes).toEqual(['on', 'off'])
      // Any other error: passed through, not retried.
      modes.length = 0
      const plain = new Error('test: not an adopt failure')
      startProjector.mockImplementationOnce(async (...args: unknown[]) => { modes.push((args.at(-1) as { adopt: string }).adopt); throw plain })
      await expect(fleet.ensure({ landscapeId: 'L', versionId: 'c' })).rejects.toBe(plain)
      expect(modes).toEqual(['on'])
    } finally {
      warn.mockRestore()
      fleet.stopAll()
    }
  })
})

describe('the fleet around compaction and disownment (C6-2a)', () => {
  const fakeDb = () => ({ query: async () => ({ rows: [{ present: false }], rowCount: 1 }) }) as never
  const recordingFleet = (onStart?: (fleet: ProjectorFleet, mode: string) => void) => {
    const modes: string[] = []
    // eslint-disable-next-line prefer-const -- assigned once, after the start it is read from
    let fleet!: ProjectorFleet
    const startProjector = vi.fn(async (...args: unknown[]) => {
      const mode = (args.at(-1) as { adopt: string }).adopt
      modes.push(mode)
      onStart?.(fleet, mode)
      return vi.fn()
    })
    fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:fallback', db: fakeDb(), adopt: 'on',
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })
    return { fleet: () => fleet, modes, startProjector }
  }
  const K = { landscapeId: 'L', versionId: 'v' }

  it('a COMPACTION release makes every start of the workspace off — a read\'s plain ensure included — until compaction\'s own { adopt: false } re-attach has built; another release does not', async () => {
    const r = recordingFleet()
    const fleet = r.fleet()
    try {
      fleet.release(K, 'compaction')
      // T-VANISH: during the fold itself a read's start is REFUSED, not run.
      await expect(fleet.ensure(K)).rejects.toBeInstanceOf(ProjectorCompactionInProgressError)
      fleet.endCompactionWindow(K)                     // the pass returned, left detached
      expect(await fleet.ensure(K)).toBe(true)        // a read after the fold: off
      fleet.release(K, 'test')
      expect(await fleet.ensure(K)).toBe(true)        // still detached by compaction
      fleet.release(K, 'test')
      expect(await fleet.ensure(K, { adopt: false })).toBe(true) // compaction's re-attach
      fleet.release(K, 'test')
      expect(await fleet.ensure(K)).toBe(true)        // lifted: adopts again
      fleet.release(K, 'compaction-instance-refresh')
      expect(await fleet.ensure(K)).toBe(true)
      expect(r.modes).toEqual(['off', 'off', 'off', 'on', 'off'])
    } finally {
      fleet.stopAll()
    }
  })

  it('an adopt failure of its own on a workspace released meanwhile is an OWNERSHIP loss — counted, not retried, never the raw error', async () => {
    const modes: string[] = []
    // eslint-disable-next-line prefer-const -- assigned once, after the start it is read from
    let fleet!: ProjectorFleet
    const startProjector = vi.fn(async (...args: unknown[]) => {
      modes.push((args.at(-1) as { adopt: string }).adopt)
      fleet.release(K, 'test')
      throw new ReadModelAdoptAttachError('B1', 'topology-moved')
    })
    fleet = new ProjectorFleet(new Repo({}), async () => 'automerge:root', {
      fallbackRootUrl: 'automerge:fallback', db: fakeDb(), adopt: 'on',
      startProjector: startProjector as unknown as typeof startReadModelProjector,
    })
    try {
      const before = fleet.snapshot().ownershipRejectedStarts
      await expect(fleet.ensure(K)).rejects.toThrow(ProjectorOwnershipError)
      expect(modes).toEqual(['on'])
      expect(fleet.snapshot().ownershipRejectedStarts).toBe(before + 1)
    } finally {
      fleet.stopAll()
    }
  })
})

describe('markReadModelProjectorAdopting', () => {
  it('names the instance and clears attached in one UPDATE, and THROWS when no row moved', async () => {
    const seen: Array<{ text: string; params: unknown[] }> = []
    const tx = (rowCount: number) => ({
      query: async (text: string, params: unknown[]) => { seen.push({ text, params }); return { rows: [], rowCount } },
    }) as unknown as Queryable
    await markReadModelProjectorAdopting(tx(1), { landscapeId: 'l', versionId: 'v' }, 'me')
    expect(seen[0]!.text).toMatch(/projector_attached = false/)
    expect(seen[0]!.params).toEqual(['l', 'v', 'me'])
    await expect(markReadModelProjectorAdopting(tx(0), { landscapeId: 'l', versionId: 'v' }, 'me')).rejects.toThrow(/no read_model_projection_state row/)
  })
})

describe('seedHeadsAgainstBuild', () => {
  it('counts a seed whose heads differ from the build\'s (as sets), and one the build has no heads for; new shards are not counted', async () => {
    const rows = [
      { id: 'same', heads: ['b', 'a'] }, { id: 'moved', heads: ['z'] }, { id: 'nulled', heads: null },
    ]
    const db = { query: async () => ({ rows, rowCount: rows.length }) } as unknown as Queryable
    const result = await seedHeadsAgainstBuild(db, { landscapeId: 'l', versionId: 'v' }, [
      { collection: 'object', documentId: 'same', source: 'projected', heads: ['a', 'b'] },
      { collection: 'object', documentId: 'moved', source: 'retired', heads: ['y'] },
      { collection: 'object', documentId: 'nulled', source: 'product', heads: ['p'] },
      { collection: 'connection', documentId: 'absent', source: 'projected', heads: ['q'] },
      { collection: 'object', documentId: 'fresh', source: 'new', heads: null },
    ])
    expect(result).toEqual({ compared: 2, differ: 1, unknown: 2 })
  })
})

describe('verifyAdoptShadow without a pool', () => {
  it('refuses without a statement on a client (the caller\'s own transaction), on a missing fence and on a lifecycle fence', async () => {
    let statements = 0
    const client = { query: async () => { statements += 1; return { rows: [], rowCount: 0 } }, release: () => {} } as unknown as Queryable
    const input = { orgId: null, fenceObserved: 'f', sealedCeiling: 4, posture: { rotation: false, fold: false, parking: false, extractCache: false } }
    expect(await verifyAdoptShadow(client, { landscapeId: 'l', versionId: 'v' }, input)).toMatchObject({ verdict: 'refused', reason: 'not-a-pool' })
    const pool = { query: async () => { statements += 1; return { rows: [], rowCount: 0 } }, connect: async () => { throw new Error('no') } } as unknown as Queryable
    expect(await verifyAdoptShadow(pool, { landscapeId: 'l', versionId: 'v' }, { ...input, fenceObserved: null }))
      .toMatchObject({ verdict: 'refused', reason: 'no-fence' })
    expect(await verifyAdoptShadow(pool, { landscapeId: 'l', versionId: 'v' }, { ...input, fenceObserved: 'lifecycle:promote:x' }))
      .toMatchObject({ verdict: 'refused', reason: 'lifecycle-fence' })
    expect(statements).toBe(0)
    // A precheck that fails is the verdict `error`, never a throw.
    const failing = { query: async () => { throw Object.assign(new Error('boom'), { code: 'XX000' }) }, connect: async () => { throw new Error('no') } } as unknown as Queryable
    expect(await verifyAdoptShadow(failing, { landscapeId: 'l', versionId: 'v' }, input)).toMatchObject({ verdict: 'error', reason: 'XX000', stage: 'precheck' })
  })
})
