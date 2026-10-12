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
 * Unit suite for the summary promotion — the two PURE halves of the promotion primitive: the allow-list
 * builder and the precondition verdict.
 *
 * The ORDER of the transaction, the fence wait and the crash windows are not
 * here: they are properties of durable state, and a fake database cannot tell a
 * committed row from an intended one. Those live in
 * `promoteSummaryWorkspace.integration.test.ts`, against real Postgres and real
 * Automerge storage.
 */

import { describe, it, expect } from 'vitest'
import { generateAutomergeUrl } from '@automerge/automerge-repo'
import {
  DEMOTION_OVERRIDABLE_BLOCKERS,
  OVERRIDABLE_BLOCKERS,
  assertWriteHeadIsWritable,
  buildPromotionAllowList,
  evaluateDemotionPreconditions,
  evaluatePromotionPreconditions,
  PROMOTED_STATIC_SOURCE,
  mergePreservedOverlayEntries,
  type PromotionFacts,
} from './promoteSummaryWorkspace.js'
import { isBaselineDocumentKind } from '../rbac/docScope.js'
import { CLAIM_PROTOCOL_VERSION } from '../rbac/documentClaims.js'
import { OVERLAY_WRITE_HEAD_VERSION } from '../modelMeta.js'
import type { WorkspaceFsckReport } from './workspaceFsck.js'

const url = () => generateAutomergeUrl()
const idOf = (value: string) => value.replace(/^automerge:/, '').split('?')[0]

/** A realistic ordinary workspace: 2 base object shards + 1 overlay head (plus
 * one RETIRED overlay segment), 1 base connection shard + 1 overlay head, 1 ADR
 * base shard, 3 baseline registry shards holding 4 diagrams. */
function ordinaryWorkspace() {
  const rootUrl = url()
  const modelUrl = url()
  const modelMetaUrl = url()
  const objectBase = [url(), url()]
  const objectOverlayRetired = url()
  const objectOverlay = url()
  const connectionBase = [url()]
  const connectionOverlay = url()
  const adrBase = [url()]
  const registryShards = [url(), url(), url()]
  const diagramDocs = [url(), url(), url(), url()]
  const diagramIds = ['d1', 'd2', 'd3', 'd4']

  const root = {
    modelUrl,
    modelMetaUrl,
    shardUrls: [...registryShards],
  }
  const modelMeta = {
    objectShardUrls: [...objectBase, objectOverlayRetired, objectOverlay],
    connectionShardUrls: [...connectionBase, connectionOverlay],
    decisionRecordShardUrls: [...adrBase],
    editsObjectShardUrl: objectOverlay,
    editsObjectShardUrls: [objectOverlayRetired, objectOverlay],
    editsConnectionShardUrl: connectionOverlay,
    editsConnectionShardUrls: [connectionOverlay],
    editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION,
  }
  // Slimmed registries, exactly what `materializeRegistryDiagrams` produces.
  const registries = [
    { diagrams: { d1: { docUrl: diagramDocs[0] }, d2: { docUrl: diagramDocs[1] } } },
    { diagrams: { d3: { docUrl: diagramDocs[2] } } },
    { diagrams: { d4: { docUrl: diagramDocs[3] } } },
  ]
  const diagramDocUrls = new Map(diagramIds.map((id, index) => [id, diagramDocs[index]]))
  return {
    rootUrl, root, modelMeta, registries, diagramDocUrls,
    modelUrl, modelMetaUrl, objectBase, objectOverlay, objectOverlayRetired,
    connectionBase, connectionOverlay, adrBase, registryShards, diagramDocs, diagramIds,
  }
}

describe('buildPromotionAllowList', () => {
  it('labels the write head registry-shard, NEVER registry (the performance-fixture defect)', () => {
    // The write head lives inside the registry shard list next to N frozen
    // shards. Mapping the whole list to kind 'registry' would make
    // `isBaselineDocumentKind` true for the head, and the baseline write fence
    // would drop every diagram creation and rename.
    const ws = ordinaryWorkspace()
    const writeHeadUrl = url()
    const { entries } = buildPromotionAllowList({ ...ws, writeHeadUrl })

    const writeHead = entries.filter((entry) => entry.documentId === idOf(writeHeadUrl))
    expect(writeHead).toHaveLength(1)
    expect(writeHead[0].kind).toBe('registry-shard')
    expect(isBaselineDocumentKind(writeHead[0].kind)).toBe(false)
    // and the frozen baseline shards ARE fenced — the other half of the same
    // contract, so a bug that makes every registry writable also fails here.
    for (const shard of ws.registryShards) {
      const entry = entries.find((candidate) => candidate.documentId === idOf(shard))
      expect(entry?.kind, shard).toBe('registry')
      expect(isBaselineDocumentKind(entry!.kind)).toBe(true)
    }
    expect(() => assertWriteHeadIsWritable(entries, writeHeadUrl)).not.toThrow()
  })

  it('assertWriteHeadIsWritable REFUSES a write head that got a baseline kind', () => {
    // The guard is in the promotion path, not only in this test: a future
    // refactor that folds the write head back into the `registry` block is
    // stopped before it can commit an allow-list.
    const writeHeadUrl = url()
    expect(() => assertWriteHeadIsWritable(
      [{ documentId: idOf(writeHeadUrl), kind: 'registry' }], writeHeadUrl,
    )).toThrow(/registry-shard/)
    expect(() => assertWriteHeadIsWritable([], writeHeadUrl)).toThrow(/expected exactly 1/)
  })

  it('gives every document reachable from the root a kind — nothing is left unclassified', () => {
    // An unlisted document stops resolving durably once the static row lands
    // (`resolveDurable`'s static_allowed filter), so "unclassified" is an
    // abort, never a silent omission.
    const ws = ordinaryWorkspace()
    const { entries, unclassified } = buildPromotionAllowList({ ...ws, writeHeadUrl: url() })
    expect(unclassified).toEqual([])
    // 1 root + 1 legacy + 1 meta + 2 object-base + 2 object-overlay
    // + 1 connection-base + 1 connection-overlay + 1 adr-base
    // + 3 registry + 1 registry-shard + 4 diagram
    expect(entries).toHaveLength(18)
    const byKind = entries.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.kind] = (acc[entry.kind] ?? 0) + 1
      return acc
    }, {})
    expect(byKind).toEqual({
      root: 1, 'model-legacy': 1, 'model-meta': 1,
      'object-base': 2, 'object-overlay': 2,
      'connection-base': 1, 'connection-overlay': 1,
      'decision-record-base': 1,
      registry: 3, 'registry-shard': 1, diagram: 4,
    })
  })

  it('an overlay head that is ALSO listed as a model shard stays writable, and a RETIRED segment too', () => {
    // Both shapes exist in production. `createEmptyRoot` makes ONE object shard
    // that is simultaneously `objectShardUrls[0]` and `editsObjectShardUrl`;
    // and every rotation leaves the previous segment in `editsObjectShardUrls`.
    // Fencing either one would freeze a document the client still writes (the
    // head) or one a fold still needs (the segment).
    const ws = ordinaryWorkspace()
    const { entries } = buildPromotionAllowList({ ...ws, writeHeadUrl: url() })
    const kindOf = (u: string) => entries.find((entry) => entry.documentId === idOf(u))?.kind
    expect(kindOf(ws.objectOverlay)).toBe('object-overlay')
    expect(kindOf(ws.objectOverlayRetired)).toBe('object-overlay')
    expect(isBaselineDocumentKind(kindOf(ws.objectOverlayRetired)!)).toBe(false)
    expect(kindOf(ws.objectBase[0])).toBe('object-base')
    expect(isBaselineDocumentKind(kindOf(ws.objectBase[0])!)).toBe(true)
  })

  it('carries the diagram id as entityId, from the READ MODEL side of the comparison', () => {
    const ws = ordinaryWorkspace()
    const { entries } = buildPromotionAllowList({ ...ws, writeHeadUrl: url() })
    const diagram = entries.find((entry) => entry.documentId === idOf(ws.diagramDocs[2]))
    expect(diagram).toEqual({ documentId: idOf(ws.diagramDocs[2]), kind: 'diagram', entityId: 'd3' })
  })

  it('a DiagramDoc the read model does not know lands in `unclassified` — the abort, not an omission', () => {
    // This is the MECHANISM behind precondition 3: the registry still reaches
    // the document, but the allow-list is derived from ro_diagrams, so a
    // diagram missing there produces a reachable-but-unlisted document. Left
    // unchecked, that document is in storage and unreachable forever.
    const ws = ordinaryWorkspace()
    const partial = new Map(ws.diagramDocUrls)
    partial.delete('d3')
    const { unclassified } = buildPromotionAllowList({ ...ws, diagramDocUrls: partial, writeHeadUrl: url() })
    expect(unclassified).toEqual([idOf(ws.diagramDocs[2])])
  })

  it('drops a foreign key on a damaged root instead of carrying it into the allow-list', () => {
    const ws = ordinaryWorkspace()
    const rogue = url()
    const { entries } = buildPromotionAllowList({
      ...ws,
      root: { ...ws.root, someFutureField: rogue } as Record<string, unknown>,
      writeHeadUrl: url(),
    })
    expect(entries.some((entry) => entry.documentId === idOf(rogue))).toBe(false)
  })
})

// ============================================================================

function cleanFsck(): WorkspaceFsckReport {
  return {
    workspace: { landscapeId: 'L', versionId: 'V' },
    rootUrl: 'automerge:x',
    status: 'clean',
    findings: [],
    checksRun: ['root-structure', 'summary-static-coherence', 'model-write-head', 'write-head-version',
      'document-present', 'document-admitted', 'document-orphaned', 'claim-coverage'],
    checksSkipped: [],
    reachableDocuments: 12,
  }
}

function promotableFacts(overrides: Partial<PromotionFacts> = {}): PromotionFacts {
  const diagrams = new Map([['d1', 'automerge:aaa'], ['d2', 'automerge:bbb']])
  return {
    rootUrl: 'automerge:root',
    root: { modelUrl: 'automerge:m', modelMetaUrl: generateAutomergeUrl(), shardUrls: [] },
    fsck: cleanFsck(),
    integrity: { outcome: 'verified' },
    freshness: { status: 'healthy', caughtUp: true, absenceProvable: true },
    projectorInstanceId: 'run-1',
    expectedProjectorInstanceId: null,
    coverage: { covered: true, protocol: CLAIM_PROTOCOL_VERSION },
    connectedPeers: 0,
    quiesceAssertedByOperator: false,
    staticSource: null,
    crdtDiagrams: diagrams,
    readModelDiagrams: new Map(diagrams),
    unresolvedRegistryShards: [],
    ...overrides,
  }
}

const codes = (facts: PromotionFacts) => evaluatePromotionPreconditions(facts).map((blocker) => blocker.code)

describe('evaluatePromotionPreconditions', () => {
  it('a healthy, sealed, quiesced, covered workspace has NO blockers', () => {
    // The anti-void control: without it every "X blocks" test below could pass
    // against a function that blocks everything.
    expect(evaluatePromotionPreconditions(promotableFacts())).toEqual([])
  })

  it('a diagram missing from ro_diagrams aborts the promotion', () => {
    const crdt = new Map([['d1', 'automerge:aaa'], ['d2', 'automerge:bbb']])
    const readModel = new Map([['d1', 'automerge:aaa']])
    const blockers = evaluatePromotionPreconditions(promotableFacts({
      crdtDiagrams: crdt, readModelDiagrams: readModel,
    }))
    expect(blockers.map((blocker) => blocker.code)).toContain('crdt-sql-divergence')
    expect(blockers.find((blocker) => blocker.code === 'crdt-sql-divergence')!.detail).toContain('d2')
  })

  it('a diagram the read model has but the registry does not is ALSO a divergence', () => {
    expect(codes(promotableFacts({
      crdtDiagrams: new Map([['d1', 'automerge:aaa']]),
      readModelDiagrams: new Map([['d1', 'automerge:aaa'], ['ghost', 'automerge:ccc']]),
    }))).toContain('crdt-sql-divergence')
  })

  it('the SAME diagram id pointing at different documents on the two sides is a divergence', () => {
    // Ids alone are not enough: the allow-list would admit one document and the
    // client would open the other.
    expect(codes(promotableFacts({
      crdtDiagrams: new Map([['d1', 'automerge:aaa']]),
      readModelDiagrams: new Map([['d1', 'automerge:zzz']]),
    }))).toContain('crdt-sql-divergence')
  })

  it('refuses a workspace fsck does not call clean', () => {
    expect(codes(promotableFacts({
      fsck: { ...cleanFsck(), status: 'violations', findings: [
        { check: 'document-admitted', severity: 'sync-stall', detail: 'x' },
      ] },
    }))).toContain('fsck-not-clean')
  })

  it('refuses a clean fsck that SKIPPED the write-head checks (a monolith, or an unresolved meta)', () => {
    // "clean" on a report that never ran the durable-write-head checks only
    // reports how far it got, not that the invariant holds.
    expect(codes(promotableFacts({
      fsck: { ...cleanFsck(), checksRun: cleanFsck().checksRun.filter((c) => c !== 'model-write-head') },
    }))).toContain('fsck-not-clean')
  })

  it('refuses unsealed read-model rows', () => {
    expect(codes(promotableFacts({ integrity: { outcome: 'not-verifiable' } }))).toContain('read-model-not-sealed')
    expect(codes(promotableFacts({ integrity: { outcome: 'mismatch' } }))).toContain('read-model-not-sealed')
  })

  it('refuses when the arrival-watermark witness cannot prove the projection covers storage (trap n°10)', () => {
    // A stale `read_model_projection_state` row from a PREVIOUS process reads
    // healthy and caught up — it carries a plausible generation and a plausible
    // instance id. What it cannot do is cover an arrival minted after it. This
    // predicate is the one that tells the two apart, so it is checked
    // separately from the status ladder.
    const blockers = evaluatePromotionPreconditions(promotableFacts({
      freshness: { status: 'healthy', caughtUp: true, absenceProvable: false },
    }))
    expect(blockers.map((blocker) => blocker.code)).toContain('read-model-not-caught-up')
    expect(blockers.find((blocker) => blocker.code === 'read-model-not-caught-up')!.detail)
      .toContain('arrival-watermark')
  })

  it('refuses a projection-state row written by ANOTHER process when the caller can name this run', () => {
    expect(codes(promotableFacts({
      projectorInstanceId: 'run-from-yesterday', expectedProjectorInstanceId: 'run-now',
    }))).toContain('projector-instance-mismatch')
    // …and does not fire when the caller cannot name the run (the script).
    expect(codes(promotableFacts({
      projectorInstanceId: 'run-from-yesterday', expectedProjectorInstanceId: null,
    }))).not.toContain('projector-instance-mismatch')
  })

  it('refuses an uncovered workspace, and one covered under an older claim protocol', () => {
    expect(codes(promotableFacts({ coverage: null }))).toContain('claim-coverage-missing')
    expect(codes(promotableFacts({ coverage: { covered: false, protocol: CLAIM_PROTOCOL_VERSION } })))
      .toContain('claim-coverage-missing')
    expect(codes(promotableFacts({ coverage: { covered: true, protocol: CLAIM_PROTOCOL_VERSION - 1 } })))
      .toContain('claim-coverage-missing')
  })

  it('refuses a monolith workspace', () => {
    expect(codes(promotableFacts({ root: { modelUrl: 'automerge:m', shardUrls: [] } })))
      .toContain('monolith-workspace')
  })

  it('refuses a workspace that is ALREADY summary, from either half of the pairing', () => {
    expect(codes(promotableFacts({
      root: { modelMetaUrl: generateAutomergeUrl(), shardUrls: [], registrySummaryOnly: true },
    }))).toContain('already-summary')
    expect(codes(promotableFacts({ staticSource: 'performance-seed-editable' }))).toContain('already-summary')
  })

  it('the already-summary refusal NAMES the door out — and a different one for a hybrid', () => {
    // A refusal must name the next move, or an operator ends up writing an
    // UPDATE against read_model_static_* by hand. The two states need
    // DIFFERENT doors, and the message has to tell them apart:
    //   flag + rows  → demote-summary (take it back out)
    //   rows only    → repair-summary-flag (finish it; the fence is already
    //                  armed, so a classic tab's registry writes are being
    //                  dropped right now)
    const complete = evaluatePromotionPreconditions(promotableFacts({
      root: { modelMetaUrl: generateAutomergeUrl(), shardUrls: [], registrySummaryOnly: true },
      staticSource: PROMOTED_STATIC_SOURCE,
    })).find((blocker) => blocker.code === 'already-summary')!
    expect(complete.detail).toContain('demote-summary')

    const hybrid = evaluatePromotionPreconditions(promotableFacts({
      staticSource: PROMOTED_STATIC_SOURCE,
    })).find((blocker) => blocker.code === 'already-summary')!
    expect(hybrid.detail).toContain('repair-summary-flag')
    expect(hybrid.detail).toContain('HYBRID')
  })

  it('refuses a connected peer, and NAMES the reason (a classic tab journals no entity write)', () => {
    const blockers = evaluatePromotionPreconditions(promotableFacts({ connectedPeers: 2 }))
    expect(blockers.map((blocker) => blocker.code)).toContain('peers-connected')
    expect(blockers.find((blocker) => blocker.code === 'peers-connected')!.detail).toContain('bfsActive')
  })

  it('an UNMEASURABLE peer census is not zero — it blocks until the operator asserts the quiesce', () => {
    // The trap this closes: a standalone script has no WebSocket server, so a
    // `0` there would mean "never checked" while reading as "checked and
    // empty". `null` blocks; only an explicit operator assertion unblocks it,
    // and it is recorded as an assertion in the report.
    expect(codes(promotableFacts({ connectedPeers: null }))).toContain('quiesce-unproven')
    expect(codes(promotableFacts({ connectedPeers: null, quiesceAssertedByOperator: true })))
      .not.toContain('quiesce-unproven')
    // …and the assertion can never override a MEASURED non-zero census.
    expect(codes(promotableFacts({ connectedPeers: 3, quiesceAssertedByOperator: true })))
      .toContain('peers-connected')
  })

  it('refuses when a registry shard did not resolve — an unread shard is not an empty one', () => {
    expect(codes(promotableFacts({ unresolvedRegistryShards: ['automerge:aaa'] })))
      .toContain('registry-unresolved')
  })

  it('a missing workspace stops at the first blocker instead of reporting eight derived ones', () => {
    expect(codes(promotableFacts({ rootUrl: null }))).toEqual(['no-such-workspace'])
    expect(codes(promotableFacts({ root: undefined }))).toEqual(['root-unresolved'])
  })
})

// ============================================================================

describe('the overridable blockers, PINNED AS A SET', () => {
  // Not "contains peers-connected" — the WHOLE set, both doors. What an
  // operator may wave through is a decision, and the way it goes wrong is by
  // ACCRETION: adding e.g. `allow-list-incomplete` to get unblocked would let
  // the promotion strand documents in storage forever. An equality assertion
  // makes that a failing test.
  //
  // For the de-promotion, `sparse-child-active` slipping in would make "delete
  // the baseline a live draft is reading" an operator checkbox.

  it('the PROMOTION allows exactly the two quiesce blockers to be overridden', () => {
    expect([...OVERRIDABLE_BLOCKERS]).toEqual(['peers-connected', 'quiesce-unproven'])
  })

  it('the DE-PROMOTION allows exactly the same two, and nothing about the sparse children', () => {
    expect([...DEMOTION_OVERRIDABLE_BLOCKERS]).toEqual(['peers-connected', 'quiesce-unproven'])
  })

  it('every overridable code is a REAL code of its own verdict function', () => {
    // The set is typed, so a typo does not compile — but a code that no
    // verdict ever emits would make the override silently inert, which is the
    // shape a type cannot catch. Both lists are proved reachable here.
    const promotionCodes = new Set([
      ...codes(promotableFacts({ connectedPeers: 4 })),
      ...codes(promotableFacts({ connectedPeers: null })),
    ])
    for (const code of OVERRIDABLE_BLOCKERS) expect(promotionCodes, code).toContain(code)

    const demotable = {
      rootUrl: 'automerge:root',
      root: { registrySummaryOnly: true, shardUrls: [] } as Record<string, unknown>,
      staticSource: PROMOTED_STATIC_SOURCE,
      activeSparseChildren: [] as string[],
      connectedPeers: 0 as number | null,
      quiesceAssertedByOperator: false,
    }
    const demotionCodes = new Set([
      ...evaluateDemotionPreconditions({ ...demotable, connectedPeers: 4 }).map((b) => b.code),
      ...evaluateDemotionPreconditions({ ...demotable, connectedPeers: null }).map((b) => b.code),
    ])
    for (const code of DEMOTION_OVERRIDABLE_BLOCKERS) expect(demotionCodes, code).toContain(code)
  })
})

// ============================================================================

describe('evaluateDemotionPreconditions', () => {
  const demotable = {
    rootUrl: 'automerge:root',
    root: { registrySummaryOnly: true, shardUrls: [] } as Record<string, unknown>,
    staticSource: PROMOTED_STATIC_SOURCE,
    activeSparseChildren: [] as string[],
    connectedPeers: 0 as number | null,
    quiesceAssertedByOperator: false,
  }

  it('a quiesced promoted workspace with no sparse child demotes', () => {
    expect(evaluateDemotionPreconditions(demotable)).toEqual([])
  })

  it('demotion is refused while a sparse child is active', () => {
    // A sparse draft serves its BASELINE from the parent's read model through
    // `base_version_id`. Delete those rows underneath it and every untouched
    // entity resolves to nothing: the draft renders empty and its merge diffs
    // against a void.
    const blockers = evaluateDemotionPreconditions({ ...demotable, activeSparseChildren: ['draft-7'] })
    expect(blockers.map((blocker) => blocker.code)).toEqual(['sparse-child-active'])
    expect(blockers[0].detail).toContain('draft-7')
  })

  it('la démotion refuse un espace avec des tombstones de diagramme en suspens', () => {
    // The demotion strips `registrySummaryOnly` and deletes the static rows,
    // so the client rebuilds a CLASSIC registry from the FROZEN baseline
    // shards — which still carry an entry for every tombstoned diagram,
    // because nothing ever rewrites a sealed shard. Without this blocker every
    // diagram deleted since the promotion would come back silently.
    const blockers = evaluateDemotionPreconditions({ ...demotable, diagramTombstones: 3 })
    expect(blockers.map((blocker) => blocker.code)).toEqual(['diagram-tombstones-outstanding'])
    expect(blockers[0].detail).toContain('3')
  })

  it('un ModelMeta illisible bloque aussi : non mesurable n est pas zéro', () => {
    // The `connectedPeers` rule, applied here: reporting "no tombstones"
    // because the document would not resolve would be a false pass.
    const blockers = evaluateDemotionPreconditions({ ...demotable, diagramTombstones: null })
    expect(blockers.map((blocker) => blocker.code)).toEqual(['diagram-tombstones-outstanding'])
  })

  it('un contrôle qui NE S APPLIQUE PAS n est pas un blocage', () => {
    // A root naming no ModelMeta has no tombstone list and never could. An
    // alarm that fires on the ordinary case gets muted, and then it protects
    // nothing.
    expect(evaluateDemotionPreconditions({ ...demotable, diagramTombstones: undefined })).toEqual([])
    expect(evaluateDemotionPreconditions({ ...demotable, diagramTombstones: 0 })).toEqual([])
  })

  it('la résurrection n est PAS couverte par l override des pairs connectés', () => {
    // The set is pinned as a SET one describe above. This is the other half:
    // `diagram-tombstones-outstanding` must stay OUT of it, so that ticking
    // "there is a tab open" can never also mean "bring back every deleted
    // diagram". It has its own flag, `allowDiagramResurrection`.
    expect(DEMOTION_OVERRIDABLE_BLOCKERS.has('diagram-tombstones-outstanding')).toBe(false)
  })

  it('refuses a static workspace that was BORN summary rather than promoted', () => {
    for (const source of ['performance-seed-editable', 'sparse-draft']) {
      const blockers = evaluateDemotionPreconditions({ ...demotable, staticSource: source })
      expect(blockers.map((blocker) => blocker.code), source).toContain('not-promoted')
    }
  })

  it('refuses a workspace that is not in the summary world at all', () => {
    expect(evaluateDemotionPreconditions({
      ...demotable, root: { shardUrls: [] }, staticSource: null,
    }).map((blocker) => blocker.code)).toContain('not-summary')
  })

  it('refuses connected peers, and an unmeasurable census, exactly like the promotion', () => {
    expect(evaluateDemotionPreconditions({ ...demotable, connectedPeers: 1 })
      .map((blocker) => blocker.code)).toContain('peers-connected')
    expect(evaluateDemotionPreconditions({ ...demotable, connectedPeers: null })
      .map((blocker) => blocker.code)).toContain('quiesce-unproven')
    expect(evaluateDemotionPreconditions({
      ...demotable, connectedPeers: null, quiesceAssertedByOperator: true,
    })).toEqual([])
  })
})

/**
 * A fold removes urls from ModelMeta, so a re-promotion rebuilding the
 * allow-list from those lists would silently de-admit the folded segments. On a
 * static workspace that is a PERMANENT sync deny with no lever to lift it.
 */
describe('mergePreservedOverlayEntries (D3)', () => {
  const entry = (id: string, kind = 'object-overlay') => ({ documentId: id, kind })

  it('carries an admitted overlay the rebuilt list no longer names', () => {
    const merged = mergePreservedOverlayEntries([entry('head')], [
      { document_id: 'folded-1', kind: 'object-overlay' },
      { document_id: 'folded-2', kind: 'connection-overlay' },
    ])
    expect(merged.map((item) => item.documentId)).toEqual(['head', 'folded-1', 'folded-2'])
    expect(merged.find((item) => item.documentId === 'folded-2')?.kind).toBe('connection-overlay')
    // Without the union, resolveDurable returns null for the folded segments
    // and all three sync gates deny them, permanently.
  })

  it('never duplicates an id, from either source', () => {
    const merged = mergePreservedOverlayEntries([entry('head')], [
      { document_id: 'head', kind: 'object-overlay' },
      { document_id: 'folded', kind: 'object-overlay' },
      { document_id: 'folded', kind: 'object-overlay' },
    ])
    expect(merged.map((item) => item.documentId)).toEqual(['head', 'folded'])
    // Filtering only against the built list is not enough: the allow-list
    // insert is keyed by document id, and a duplicate breaks the promotion.
  })

  it('the built list wins on kind — it is the freshly derived truth', () => {
    const merged = mergePreservedOverlayEntries([entry('head', 'object-overlay')], [
      { document_id: 'head', kind: 'retained-static-base' },
    ])
    expect(merged).toEqual([{ documentId: 'head', kind: 'object-overlay' }])
  })
})
