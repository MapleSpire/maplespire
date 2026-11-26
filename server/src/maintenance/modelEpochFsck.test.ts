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
import { ImmutableString } from '@automerge/automerge-repo'
import { describe, expect, it } from 'vitest'
import { MODEL_EPOCH_FSCK_BOUND_MS, MODEL_EPOCH_FSCK_CHECKS, checkModelEpochs, type ModelEpochFacts, type ModelEpochFsckInput } from './modelEpochFsck.js'

/**
 * G4-16f — the epoch checks of fsck. Each check is shown CLEAN
 * on a healthy epoch and FIRING on the one state it exists for (a check
 * nobody saw fire is not a check).
 */
const META = 'automerge:2u2DVTo8nJaLLnxD6L3kbxdJyCdG'
const BASE = 'automerge:3u2DVTo8nJaLLnxD6L3kbxdJyCdG'
const HEAD = 'automerge:4u2DVTo8nJaLLnxD6L3kbxdJyCdG'
const s = (u: string) => new ImmutableString(u)

/** A born-scalar epoch meta: marker, four scalar lists, six frozen mirror fields. */
const meta = (over: Record<string, unknown> = {}) => ({
  metaUrlFormat: 2,
  objectShardRefs: [s(BASE), s(HEAD)], connectionShardRefs: [], editsObjectShardRefs: [s(HEAD)], editsConnectionShardRefs: [],
  editsObjectShardRef: s(HEAD),
  objectShardUrls: [BASE, HEAD], connectionShardUrls: [], editsObjectShardUrls: [HEAD], editsConnectionShardUrls: [],
  editsObjectShardUrl: HEAD, editsConnectionShardUrl: '',
  ...over,
})

const healthy = (): ModelEpochFacts => ({
  any: true,
  published: { epochNo: 2, kind: 'full', metaUrl: META, publishedAt: new Date() },
  epochsSoFar: 3, retained: 2, repointing: [], journals: [],
  sources: [{ documentId: 'old', behind: false, quietMs: null }],
  supersededIds: ['old'], pinned: [], lateOverlay: [],
})
const input = (facts: ModelEpochFacts | null = healthy(), over: Partial<ModelEpochFsckInput> = {}): ModelEpochFsckInput => ({
  facts, rootMetaUrl: META, modelMetaRaw: meta(), retain: 3, periodDays: 30, ...over,
})
const fired = (i: ModelEpochFsckInput) => checkModelEpochs(i).findings.map((f) => f.check)

describe('fsck — model epoch checks', () => {
  it('a healthy epoch: every check RUNS and none fires', () => {
    const result = checkModelEpochs(input())
    expect(result.findings).toEqual([])
    expect(result.checksRun.sort()).toEqual(Object.keys(MODEL_EPOCH_FSCK_CHECKS).sort())
  })

  it('no epoch row: every check is skipped as an answer ("no model epochs"); unreadable tables are not', () => {
    const none = checkModelEpochs(input({ ...healthy(), any: false }))
    expect(none.checksSkipped.every((s) => s.reason.startsWith('no model epochs'))).toBe(true)
    expect(none.checksSkipped).toHaveLength(Object.keys(MODEL_EPOCH_FSCK_CHECKS).length)
    expect(checkModelEpochs(input(null)).checksSkipped.every((s) => !s.reason.startsWith('no model epochs'))).toBe(true)
  })

  it('model-epoch-pointer fires when the root and the published row disagree, and names a stuck repoint', () => {
    expect(fired(input(healthy(), { rootMetaUrl: BASE }))).toEqual(['model-epoch-pointer'])
    const stuck = checkModelEpochs(input({ ...healthy(), repointing: [{ epochNo: 3, ageMs: 1, metaUrl: 'automerge:stuck' }] }, { rootMetaUrl: BASE }))
    // The door exists (`server/package.json`), and fsck names it.
    expect(stuck.findings[0]!.detail).toContain('npm run epoch:resolve-repointing')
    expect(stuck.findings[0]!.detail).toContain('--adopt-root')
    expect(stuck.findings[0]!.detail).toContain('automerge:stuck')
    // The same meta spelled as an ImmutableString is not a disagreement.
    expect(fired(input(healthy(), { rootMetaUrl: s(META) }))).toEqual([])
  })

  it('model-epoch-born-scalar fires on a missing marker, scalar list or mirror field', () => {
    expect(fired(input(healthy(), { modelMetaRaw: meta({ metaUrlFormat: undefined }) }))).toContain('model-epoch-born-scalar')
    const noMirror = meta(); delete (noMirror as Record<string, unknown>).editsConnectionShardUrl
    expect(fired(input(healthy(), { modelMetaRaw: noMirror }))).toEqual(['model-epoch-born-scalar'])
    expect(fired(input(healthy(), { modelMetaRaw: meta({ connectionShardRefs: undefined }) }))).toContain('model-epoch-born-scalar')
  })

  it('model-epoch-late-write-pending fires on a cursor behind storage past the bound only', () => {
    expect(fired(input({ ...healthy(), sources: [{ documentId: 'old', behind: true, quietMs: MODEL_EPOCH_FSCK_BOUND_MS + 1 }] })))
      .toEqual(['model-epoch-late-write-pending'])
    expect(fired(input({ ...healthy(), sources: [{ documentId: 'old', behind: true, quietMs: 1_000 }] }))).toEqual([])
  })

  it('meta-text-mirror-unforwarded fires on a URL an old client appended to the mirror and nobody adopted', () => {
    const appended = 'automerge:5u2DVTo8nJaLLnxD6L3kbxdJyCdG'
    expect(fired(input(healthy(), { modelMetaRaw: meta({ objectShardUrls: [BASE, HEAD, appended] }) })))
      .toEqual(['meta-text-mirror-unforwarded'])
    // Adopted (ruling) → clean.
    expect(fired(input(healthy(), { modelMetaRaw: meta({ objectShardUrls: [BASE, HEAD, appended], objectShardRefs: [s(BASE), s(HEAD), s(appended)] }) })))
      .toEqual([])
  })

  it('model-epoch-late-overlay-write fires on a written segment no retirement row forwards', () => {
    expect(fired(input({ ...healthy(), lateOverlay: [{ documentId: 'seg', writtenAfterSupersede: true, retirementRow: false }] })))
      .toEqual(['model-epoch-late-overlay-write'])
    expect(fired(input({ ...healthy(), lateOverlay: [{ documentId: 'seg', writtenAfterSupersede: true, retirementRow: true }] }))).toEqual([])
  })

  it('model-epoch-retention fires below min(N, epochs so far), above 2N, and on a pin older than a period', () => {
    expect(fired(input({ ...healthy(), retained: 1 }))).toEqual(['model-epoch-retention'])
    expect(fired(input({ ...healthy(), epochsSoFar: 12, retained: 7 }))).toEqual(['model-epoch-retention'])
    expect(fired(input({ ...healthy(), epochsSoFar: 12, retained: 6 }))).toEqual([])
    expect(fired(input({ ...healthy(), pinned: [{ documentId: 'p', pinnedBy: 'manifest:1', ageMs: 31 * 86_400_000 }] })))
      .toEqual(['model-epoch-retention'])
  })

  it('model-epoch-carried-not-superseded fires on a listed document marked superseded', () => {
    expect(fired(input({ ...healthy(), supersededIds: ['old', BASE.slice('automerge:'.length)] })))
      .toEqual(['model-epoch-carried-not-superseded'])
  })

  it('model-epoch-forward-journal-stale fires on an old journal and on a quarantined one', () => {
    expect(fired(input({ ...healthy(), journals: [{ id: 'j', ageMs: MODEL_EPOCH_FSCK_BOUND_MS + 1, quarantined: false, source: 'old' }] })))
      .toEqual(['model-epoch-forward-journal-stale'])
    const q = checkModelEpochs(input({ ...healthy(), journals: [{ id: 'j', ageMs: 5, quarantined: true, source: 'old' }] }))
    expect(q.findings[0]!.detail).toContain('repair:epoch-forward-quarantine')
    expect(fired(input({ ...healthy(), journals: [{ id: 'j', ageMs: 5, quarantined: false, source: 'old' }] }))).toEqual([])
  })

  it('model-epoch-repointing-stuck fires past the bound and names the operator command', () => {
    const r = checkModelEpochs(input({ ...healthy(), repointing: [{ epochNo: 3, ageMs: MODEL_EPOCH_FSCK_BOUND_MS + 1 }] }))
    expect(r.findings.map((f) => f.check)).toEqual(['model-epoch-repointing-stuck'])
    expect(r.findings[0]!.detail).toContain('npm run epoch:resolve-repointing')
    // …and the command it names is a real package script.
    const scripts = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts['epoch:resolve-repointing']).toBe('tsx scripts/resolve-epoch-repointing.ts')
    expect(fired(input({ ...healthy(), repointing: [{ epochNo: 3, ageMs: 10 }] }))).toEqual([])
  })
})
