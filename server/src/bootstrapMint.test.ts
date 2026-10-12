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

import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Repo, documentIdToBinary, type DocumentId } from '@automerge/automerge-repo'
import {
  createBootstrapDocument,
  canMintBootstrapDocumentIds,
  bootstrapMintMetricSamples,
  resetBootstrapMintCountersForTest,
} from './bootstrapMint.js'
import {
  isMintedDocumentId,
  verifyDocumentId,
  verifyDocumentIdWithDisplacement,
  MINTED_ID_BYTES,
} from './rbac/documentIdMint.js'
import { setWorkspaceDocumentsRegistrationForTest } from './rbac/docScope.js'

/**
 * The bootstrap family names its documents with workspace-bound ids
 * (bootstrapMint.ts). These arms pin the two things the reaper's safety rests
 * on: a named document verifies `bound` to its TARGET and to nothing else, and
 * naming is switched by the same fact as claiming.
 */

const TARGET = { landscapeId: 'L-alpha', versionId: 'V-1' }
const SIBLING = { landscapeId: 'L-alpha', versionId: 'V-2' }
const ELSEWHERE = { landscapeId: 'L-beta', versionId: 'V-1' }

const claimsRecorded = async () => ({ claimed: [], alreadyOurs: [], foreign: [], missingVersion: false })

class MemoryStorage {
  readonly chunks = new Map<string, Uint8Array>()
  private text(key: readonly string[]): string { return key.join('/') }
  async load(key: string[]): Promise<Uint8Array | undefined> { return this.chunks.get(this.text(key)) }
  async save(key: string[], data: Uint8Array): Promise<void> { this.chunks.set(this.text(key), data) }
  async remove(key: string[]): Promise<void> { this.chunks.delete(this.text(key)) }
  async loadRange(prefix: string[]): Promise<{ key: string[]; data: Uint8Array }[]> {
    const p = this.text(prefix)
    return [...this.chunks.entries()].filter(([k]) => k === p || k.startsWith(`${p}/`)).map(([k, data]) => ({ key: k.split('/'), data }))
  }
  async removeRange(prefix: string[]): Promise<void> {
    const p = this.text(prefix)
    for (const k of [...this.chunks.keys()]) if (k === p || k.startsWith(`${p}/`)) this.chunks.delete(k)
  }
  /** Document ids with a chunk — minus `storage-adapter-id`, the repo's own
   *  identity key, which it writes at construction and which is not a document
   *  (`isDocumentStorageKey`, automergeStorage.ts). */
  documentIds(): string[] {
    return [...new Set([...this.chunks.keys()].map((k) => k.split('/')[0]!))].filter((k) => k !== 'storage-adapter-id')
  }
}

describe('createBootstrapDocument — the name carries the workspace', () => {
  let restoreRegistration: () => void = () => {}
  const savedSecret = process.env.AUTH_SECRET

  beforeEach(() => {
    resetBootstrapMintCountersForTest()
    process.env.AUTH_SECRET = 'bootstrap-mint-test-secret'
    restoreRegistration = setWorkspaceDocumentsRegistrationForTest(claimsRecorded)
  })
  afterEach(() => {
    restoreRegistration()
    if (savedSecret === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = savedSecret
  })

  it('control — with a key and a registration, minting is on', () => {
    expect(canMintBootstrapDocumentIds()).toBe(true)
  })

  it('names the document with an id BOUND to the target — and to nothing else', () => {
    const repo = new Repo({ network: [] })
    const handle = createBootstrapDocument(repo, TARGET, { objects: { o1: { id: 'o1' } } })
    const id = String(handle.documentId)
    expect(isMintedDocumentId(id)).toBe(true)
    expect(documentIdToBinary(id as DocumentId)?.length).toBe(MINTED_ID_BYTES)
    expect(verifyDocumentId(TARGET, id).kind).toBe('bound')
    expect(verifyDocumentId(SIBLING, id).kind).toBe('foreign')
    expect(verifyDocumentId(ELSEWHERE, id).kind).toBe('foreign')
    expect(handle.doc()).toEqual({ objects: { o1: { id: 'o1' } } })
    expect(bootstrapMintMetricSamples().find((s) => s.name.endsWith('_minted_total'))!.values[0]!.value).toBe(1)
  })

  it('the admission story, at the mint level: bound on its own route, DISPLACED on the parent, foreign across landscapes', async () => {
    // A fork names its documents for the CHILD. A peer routed to the child is
    // admitted in O(1); a peer routed to the parent reads foreign, and the
    // displaced scan over the landscape's versions finds the sibling — the
    // durable first-owner-wins row (written by the publisher's claim) then
    // denies it. Another landscape stays foreign at full precision.
    const repo = new Repo({ network: [] })
    const id = String(createBootstrapDocument(repo, SIBLING, { diagrams: {} }).documentId)
    const versionsOfAlpha = async () => ['V-2', 'V-1']
    expect((await verifyDocumentIdWithDisplacement(SIBLING, id, versionsOfAlpha)).kind).toBe('bound')
    expect((await verifyDocumentIdWithDisplacement(TARGET, id, versionsOfAlpha)).kind).toBe('displaced')
    expect((await verifyDocumentIdWithDisplacement(ELSEWHERE, id, async () => ['V-1', 'V-2'])).kind).toBe('foreign')
  })

  it('a named document persists through the SAME armed save as a created one — no flush needed', async () => {
    // The reaper's premise, and the mechanism behind forkRoot.test.ts's
    // KNOWN GAP arm: `import` joins
    // the same `#ensureQuery` as `create`, so the storage listener arms the
    // initial save the instant the handle exists.
    const storage = new MemoryStorage()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = new Repo({ network: [], storage: storage as any })
    const handle = createBootstrapDocument(repo, TARGET, { connections: {} })
    await handle.whenReady()
    expect(storage.documentIds(), 'nothing durable yet — the save is armed, not landed').toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(storage.documentIds()).toEqual([String(handle.documentId)])
  })

  it('an EMPTY value takes the empty-change path, and is still named', async () => {
    const repo = new Repo({ network: [] })
    const handle = createBootstrapDocument(repo, TARGET, {})
    await handle.whenReady()
    expect(verifyDocumentId(TARGET, String(handle.documentId)).kind).toBe('bound')
    expect(handle.doc()).toEqual({})
  })

  it('two documents for the same target get DIFFERENT names', () => {
    const repo = new Repo({ network: [] })
    const a = String(createBootstrapDocument(repo, TARGET, { a: 1 }).documentId)
    const b = String(createBootstrapDocument(repo, TARGET, { a: 1 }).documentId)
    expect(a).not.toBe(b)
  })

  it('FALLS BACK to repo.create when no mint key is configured — a legacy id, counted', () => {
    delete process.env.AUTH_SECRET
    expect(canMintBootstrapDocumentIds()).toBe(false)
    const repo = new Repo({ network: [] })
    const handle = createBootstrapDocument(repo, TARGET, { objects: {} })
    const id = String(handle.documentId)
    expect(isMintedDocumentId(id)).toBe(false)
    expect(documentIdToBinary(id as DocumentId)?.length).toBe(16)
    expect(handle.doc()).toEqual({ objects: {} })
    const samples = bootstrapMintMetricSamples()
    expect(samples.find((s) => s.name.endsWith('_unminted_total'))!.values[0]!.value).toBe(1)
    expect(samples.find((s) => s.name.endsWith('_minted_total'))!.values[0]!.value).toBe(0)
  })

  it('FALLS BACK when only a RETIRED key is configured — minting needs the current one, or every creation would throw', () => {
    // A gate reading `hasMintKey` (which counts AUTH_SECRET_PREVIOUS) would let
    // a blank AUTH_SECRET beside a populated PREVIOUS through, and then
    // `mintDocumentIdBytes` would throw on every landscape, version, draft and
    // merge.
    const savedPrevious = process.env.AUTH_SECRET_PREVIOUS
    delete process.env.AUTH_SECRET
    process.env.AUTH_SECRET_PREVIOUS = 'a-retired-key'
    try {
      expect(canMintBootstrapDocumentIds()).toBe(false)
      const repo = new Repo({ network: [] })
      const handle = createBootstrapDocument(repo, TARGET, { objects: {} })
      expect(isMintedDocumentId(String(handle.documentId))).toBe(false)
    } finally {
      if (savedPrevious === undefined) delete process.env.AUTH_SECRET_PREVIOUS
      else process.env.AUTH_SECRET_PREVIOUS = savedPrevious
    }
  })

  it('FALLS BACK when no documents registration is installed — minting and claiming are switched by the same fact', () => {
    // A key alone is not enough: a minted id whose claim would never be
    // recorded is the one shape the reaper would later mistake for an orphan.
    restoreRegistration()
    restoreRegistration = setWorkspaceDocumentsRegistrationForTest(null)
    expect(canMintBootstrapDocumentIds()).toBe(false)
    const repo = new Repo({ network: [] })
    const id = String(createBootstrapDocument(repo, TARGET, { objects: {} }).documentId)
    expect(isMintedDocumentId(id)).toBe(false)
  })

  it('REFUSES a missing target on the fallback path too — server/ does not typecheck its tests', () => {
    delete process.env.AUTH_SECRET
    const repo = new Repo({ network: [] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createBootstrapDocument(repo, undefined as any, { a: 1 })).toThrow(/target workspace/)
    expect(() => createBootstrapDocument(repo, { landscapeId: '', versionId: 'V' }, { a: 1 })).toThrow(/target workspace/)
  })

  it('exports both counters to /metrics', () => {
    const names = bootstrapMintMetricSamples().map((s) => s.name).sort()
    expect(names).toEqual([
      'maplespire_bootstrap_documents_minted_total',
      'maplespire_bootstrap_documents_unminted_total',
    ])
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/metrics\.push\(\.\.\.bootstrapMintMetricSamples\(\)\)/)
  })
})
