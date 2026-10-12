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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Repo, type Chunk, type StorageAdapterInterface, type StorageKey } from '@automerge/automerge-repo'
import {
  bootstrapScopeMetricSamples,
  bootstrapScopeSnapshot,
  installBootstrapOwnership,
  openBootstrapScope,
  resetBootstrapScopeCountersForTest,
} from './bootstrapScope.js'
import {
  bootstrapPlacementFor,
  bootstrapPlacementSnapshot,
  resetServerCreationPlacementForTest,
} from './rbac/serverCreationPlacement.js'
import { WriteAuthorityLostError, WriteAuthorityUnavailableError } from './syncCells/writeAuthority.js'
import { setWorkspaceDocumentsRegistrationForTest } from './rbac/docScope.js'

/**
 * THE BOOTSTRAP SCOPE, arm by arm; "KILLS" arms name the wrong implementation
 * they catch.
 *
 * The scope is what turns "a fork on a cell without a lease commits durably"
 * into "a fork on a cell without a lease is refused before its first mint, and
 * every save of a fork it did grant is fenced under the forker's lease". These
 * arms drive the four answers of `requireWriteAuthority` through `open`, the
 * re-ask through `create`, and — through a recording adapter and a real `Repo`
 * — the ordering property the storage fence depends on: the note is in place
 * at the instant Automerge writes.
 */

const TARGET = { landscapeId: 'L-scope', versionId: 'V-child' }
const FORKER = { landscapeId: 'L-scope', versionId: 'V-parent' }
const UNFENCED = { kind: 'unfenced', reason: 'no-forker' } as const
const FORKED = { kind: 'forker', workspace: FORKER } as const

/** An ownership double in the shape `requireWriteAuthority` reads. */
function ownership(overrides: { enabled?: boolean; owns?: () => boolean; token?: () => string | null } = {}) {
  return {
    enabled: overrides.enabled ?? true,
    owns: overrides.owns ?? (() => true),
    fencingToken: overrides.token ?? (() => '7'),
  }
}

/** Records what the fence's read answered at every save — the same question
 *  `PostgresStorageAdapter` asks, at the same instant. */
class RecordingStorage implements StorageAdapterInterface {
  readonly saves: { documentId: string; placement: string | null }[] = []
  private readonly entries = new Map<string, Uint8Array>()
  private text(key: StorageKey): string { return key.join('/') }
  async load(key: StorageKey): Promise<Uint8Array | undefined> { return this.entries.get(this.text(key)) }
  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    const placement = bootstrapPlacementFor(key[0]!)
    this.saves.push({ documentId: key[0]!, placement: placement ? `${placement.landscapeId}/${placement.versionId}` : null })
    this.entries.set(this.text(key), data)
  }
  async remove(key: StorageKey): Promise<void> { this.entries.delete(this.text(key)) }
  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    const p = this.text(prefix)
    return [...this.entries.entries()].filter(([k]) => k === p || k.startsWith(`${p}/`)).map(([k, data]) => ({ key: k.split('/'), data }))
  }
  async removeRange(prefix: StorageKey): Promise<void> {
    const p = this.text(prefix)
    for (const k of [...this.entries.keys()]) if (k === p || k.startsWith(`${p}/`)) this.entries.delete(k)
  }
}

describe('openBootstrapScope — the four answers, before anything is minted', () => {
  let uninstall: (() => void) | null = null
  beforeEach(() => {
    resetBootstrapScopeCountersForTest()
    resetServerCreationPlacementForTest()
  })
  afterEach(() => {
    uninstall?.()
    uninstall = null
    resetBootstrapScopeCountersForTest()
    resetServerCreationPlacementForTest()
  })

  it('KILLS the missing-authority guard: a scope needs an authority, on every path', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => openBootstrapScope(TARGET, undefined as any)).toThrow(/authority is required/)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => openBootstrapScope(TARGET, { kind: 'forker', workspace: { landscapeId: '', versionId: 'V' } } as any)).toThrow(/authority is required/)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => openBootstrapScope(TARGET, { kind: 'fenced' } as any)).toThrow(/authority is required/)
  })

  it('unfenced / no-forker: granted, notes nothing, counts itself', () => {
    const scope = openBootstrapScope(TARGET, UNFENCED)
    expect(scope.fenced).toBe(false)
    expect(scope.forker).toBeNull()
    const repo = new Repo({ network: [] })
    const handle = scope.create(repo, { a: 1 })
    expect(scope.createdDocumentIds).toEqual([String(handle.documentId)])
    expect(bootstrapPlacementFor(String(handle.documentId)), 'an unfenced scope must not feed the fence').toBeNull()
    expect(bootstrapScopeSnapshot()).toMatchObject({ opened: 1, unfenced: 1, refusedAtOpen: 0 })
    expect(bootstrapScopeSnapshot().unfencedByReason['no-forker']).toBe(1)
  })

  it('not installed: a forker scope is unfenced — vitest, the gc worker, an AUTH=off boot with ownership unset', () => {
    const scope = openBootstrapScope(TARGET, FORKED)
    expect(scope.fenced).toBe(false)
    expect(bootstrapScopeSnapshot().unfencedByReason['ownership-not-installed']).toBe(1)
    expect(bootstrapScopeSnapshot().installed).toBe(false)
  })

  it('KILLS the boot-window bypass: required and absent is WARMING-UP, not a grant', () => {
    uninstall = installBootstrapOwnership({ required: () => true, current: () => null })
    expect(() => openBootstrapScope(TARGET, FORKED)).toThrow(WriteAuthorityUnavailableError)
    let reason: string | null = null
    try { openBootstrapScope(TARGET, FORKED) } catch (error) { reason = (error as WriteAuthorityUnavailableError).reason }
    expect(reason).toBe('warming-up')
    expect(bootstrapScopeSnapshot()).toMatchObject({ refusedAtOpen: 2 })
    expect(bootstrapScopeSnapshot().refusedAtOpenByReason['warming-up']).toBe(2)
    // The unfenced door is unaffected by the boot window: nothing to ask for.
    expect(openBootstrapScope(TARGET, UNFENCED).fenced).toBe(false)
  })

  it('installed but not required and absent: unfenced, counted as ownership-DISABLED, not as not-installed', () => {
    // index.ts installs the source on every boot; with SYNC_CELL_OWNERSHIP off
    // it answers null and nothing is required — the single-cell deployment.
    // Counting that as "not installed" would label every AUTH=off dev boot with
    // the reason reserved for processes that never wired a coordinator.
    uninstall = installBootstrapOwnership({ required: () => false, current: () => null })
    expect(openBootstrapScope(TARGET, FORKED).fenced).toBe(false)
    expect(bootstrapScopeSnapshot().unfencedByReason['ownership-disabled']).toBe(1)
    expect(bootstrapScopeSnapshot().unfencedByReason['ownership-not-installed']).toBe(0)
    expect(bootstrapScopeSnapshot().installed).toBe(true)
  })

  it('KILLS the cached coordinator: `current()` is consulted at EVERY open, never snapshotted at install', () => {
    // index.ts installs the source at module load, when `syncCellOwnership` is
    // still null; the coordinator arrives later. A getter that cached its first
    // answer would report warming-up for ever on a SYNC_CELL_OWNERSHIP=on cell,
    // and a double that hands a constant cannot see that. So: the answer
    // changes between two opens, and the scope must follow it.
    let coordinator: ReturnType<typeof ownership> | null = null
    let required = false
    uninstall = installBootstrapOwnership({ required: () => required, current: () => coordinator })
    expect(openBootstrapScope(TARGET, FORKED).fenced, 'absent and not required: unfenced').toBe(false)
    required = true
    expect(() => openBootstrapScope(TARGET, FORKED), 'absent and required: warming-up').toThrow(WriteAuthorityUnavailableError)
    coordinator = ownership({ owns: () => true })
    const fenced = openBootstrapScope(TARGET, FORKED)
    expect(fenced.fenced, 'the coordinator arrived: fenced').toBe(true)
    coordinator = ownership({ owns: () => false })
    expect(() => openBootstrapScope(TARGET, FORKED), 'the lease moved: refused').toThrow(/does not own/)
    // `opened` counts every ATTEMPT (four), `refusedAtOpen` the two refused.
    expect(bootstrapScopeSnapshot()).toMatchObject({ opened: 4, refusedAtOpen: 2, unfenced: 1 })
  })

  it('KILLS the not-owner bypass: a cell that does not own the forker is refused with nothing minted', () => {
    uninstall = installBootstrapOwnership({ required: () => true, current: () => ownership({ owns: () => false }) })
    expect(() => openBootstrapScope(TARGET, FORKED)).toThrow(/does not own L-scope\/V-parent/)
    expect(bootstrapScopeSnapshot().refusedAtOpenByReason['not-owner']).toBe(1)
    expect(bootstrapPlacementSnapshot().size, 'a refused scope notes nothing').toBe(0)
  })

  it('ownership disabled: granted unfenced — a single-cell deployment has no fence at all', () => {
    uninstall = installBootstrapOwnership({ required: () => false, current: () => ownership({ enabled: false, token: () => null }) })
    const scope = openBootstrapScope(TARGET, FORKED)
    expect(scope.fenced).toBe(false)
    expect(bootstrapScopeSnapshot().unfencedByReason['ownership-disabled']).toBe(1)
    const repo = new Repo({ network: [] })
    const handle = scope.create(repo, { a: 1 })
    expect(bootstrapPlacementFor(String(handle.documentId))).toBeNull()
  })

  it('the owner: fenced, and every created id is NOTED under the FORKER — not under the target', () => {
    uninstall = installBootstrapOwnership({ required: () => true, current: () => ownership() })
    const scope = openBootstrapScope(TARGET, FORKED)
    expect(scope.fenced).toBe(true)
    expect(scope.forker).toEqual(FORKER)
    const repo = new Repo({ network: [] })
    const a = String(scope.create(repo, { a: 1 }).documentId)
    const b = String(scope.create(repo, { b: 2 }).documentId)
    expect(scope.createdDocumentIds).toEqual([a, b])
    expect(bootstrapPlacementFor(a)).toEqual(FORKER)
    expect(bootstrapPlacementFor(b)).toEqual(FORKER)
    // KILLS "note the target": the target has no lease and a note under it
    // would refuse every save for ever.
    expect(bootstrapPlacementFor(a)).not.toEqual(TARGET)
    expect(bootstrapPlacementSnapshot()).toMatchObject({ live: 2, retired: 0 })
  })

  it('KILLS the once-at-open reading: stillHeld is re-asked at EVERY create, and a lost lease mints nothing more', () => {
    let held = true
    uninstall = installBootstrapOwnership({
      required: () => true,
      current: () => ownership({ owns: () => held, token: () => (held ? '7' : null) }),
    })
    const scope = openBootstrapScope(TARGET, FORKED)
    const repo = new Repo({ network: [] })
    scope.create(repo, { a: 1 })
    held = false
    expect(() => scope.create(repo, { b: 2 })).toThrow(WriteAuthorityLostError)
    expect(scope.createdDocumentIds, 'the refused create left no id behind').toHaveLength(1)
    expect(bootstrapPlacementSnapshot().live, 'and no note').toBe(1)
    expect(bootstrapScopeSnapshot().lostMidScope).toBe(1)
  })

  it('a token that MOVED while owns() still answers true is also a lost authority', () => {
    // `stillHeld` compares the token too: a same-cell re-acquire at a higher
    // token fences the statement the scope was granted under.
    let token = '7'
    uninstall = installBootstrapOwnership({ required: () => true, current: () => ownership({ token: () => token }) })
    const scope = openBootstrapScope(TARGET, FORKED)
    const repo = new Repo({ network: [] })
    scope.create(repo, { a: 1 })
    token = '8'
    expect(() => scope.create(repo, { b: 2 })).toThrow(WriteAuthorityLostError)
  })

  it('retire moves the notes to the retired tier and keeps them READABLE — the write-back must still meet the fence', () => {
    uninstall = installBootstrapOwnership({ required: () => true, current: () => ownership() })
    const scope = openBootstrapScope(TARGET, FORKED)
    const repo = new Repo({ network: [] })
    const id = String(scope.create(repo, { a: 1 }).documentId)
    scope.retire()
    scope.retire() // idempotent
    expect(bootstrapPlacementSnapshot()).toMatchObject({ live: 0, retired: 1 })
    expect(bootstrapPlacementFor(id), 'a retired note still answers').toEqual(FORKER)
    expect(bootstrapScopeSnapshot().retired).toBe(1)
    // An unfenced scope has nothing to retire and does not count as one.
    openBootstrapScope(TARGET, UNFENCED).retire()
    expect(bootstrapScopeSnapshot().retired).toBe(1)
  })

  it('exports every counter to /metrics, by name', () => {
    const names = bootstrapScopeMetricSamples().map((s) => s.name).sort()
    expect(names).toEqual([
      'maplespire_bootstrap_scopes_lost_total',
      'maplespire_bootstrap_scopes_opened_total',
      'maplespire_bootstrap_scopes_refused_total',
      'maplespire_bootstrap_scopes_unfenced_total',
    ])
  })
})

describe('openBootstrapScope — the note is in place when Automerge WRITES', () => {
  let uninstall: (() => void) | null = null
  let restoreRegistration: () => void = () => {}
  const savedSecret = process.env.AUTH_SECRET
  beforeEach(() => {
    resetBootstrapScopeCountersForTest()
    resetServerCreationPlacementForTest()
    uninstall = installBootstrapOwnership({ required: () => true, current: () => ownership() })
  })
  afterEach(() => {
    uninstall?.()
    uninstall = null
    restoreRegistration()
    restoreRegistration = () => {}
    if (savedSecret === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = savedSecret
    resetBootstrapScopeCountersForTest()
    resetServerCreationPlacementForTest()
  })

  for (const path of ['mint (repo.import, AUTH_SECRET set)', 'fallback (repo.create, no key)'] as const) {
    it(`every save of a fenced document sees the forker — on the ${path} path`, async () => {
      // BOTH paths of `createBootstrapDocument`, because the note is taken by
      // a callback that has to sit in the same synchronous frame on each, and
      // a maintainer could move one without the other.
      if (path.startsWith('mint')) {
        process.env.AUTH_SECRET = 'bootstrap-scope-test-secret'
        restoreRegistration = setWorkspaceDocumentsRegistrationForTest(async () => ({ claimed: [], alreadyOurs: [], foreign: [], missingVersion: false }))
      } else {
        delete process.env.AUTH_SECRET
      }
      const storage = new RecordingStorage()
      const repo = new Repo({ storage, network: [], saveDebounceRate: 0 })
      const scope = openBootstrapScope(TARGET, FORKED)
      const handle = scope.create(repo, { hello: 'world' })
      await handle.whenReady()
      await repo.flush([handle.documentId])
      await new Promise((resolve) => setTimeout(resolve, 50))
      const saves = storage.saves.filter((save) => save.documentId === String(handle.documentId))
      expect(saves.length, 'the repo never saved the document — this arm proved nothing').toBeGreaterThan(0)
      expect(saves.map((save) => save.placement)).toEqual(saves.map(() => `${FORKER.landscapeId}/${FORKER.versionId}`))
    })
  }

  it('an UNFENCED scope leaves every save unplaced — the control that keeps the arm above honest', async () => {
    const storage = new RecordingStorage()
    const repo = new Repo({ storage, network: [], saveDebounceRate: 0 })
    const scope = openBootstrapScope(TARGET, UNFENCED)
    const handle = scope.create(repo, { hello: 'world' })
    await handle.whenReady()
    await repo.flush([handle.documentId])
    const saves = storage.saves.filter((save) => save.documentId === String(handle.documentId))
    expect(saves.length).toBeGreaterThan(0)
    expect(saves.every((save) => save.placement === null)).toBe(true)
  })
})
