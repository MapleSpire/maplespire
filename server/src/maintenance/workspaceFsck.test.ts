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
import { generateAutomergeUrl, isValidAutomergeUrl } from '@automerge/automerge-repo'
import { FSCK_CHECKS, REGISTRY_HEAD_PROJECTION_GRACE_MS, checkWorkspaceStructure, collectReferencedUrls, documentIdOf, fsckStatusOf, registryDiagramEntries, groupSharedRoots, OVERLAY_CHAIN_CEILING, OVERLAY_HEAD_CEILING, OVERLAY_HEAD_ROTATION_GRACE_MS, measureOverlayWriteHeads, overlayWriteHeadBytesTotal, OVERLAY_SEGMENT_BYTE_CEILING, type OverlayWriteHeadSize, type OverlaySegmentSize } from './workspaceFsck.js'
import { OVERLAY_WRITE_HEAD_VERSION, buildModelMeta } from '../modelMeta.js'
import { OVERLAY_SEGMENT_SIZE } from '../overlaySegments.js'
import { OVERLAY_CHAIN_FOLD_MIN } from '../readModel/overlayChainFold.js'

// GENERATED, never hand-written. A hand-typed base58 string fails the
// base58check digest, `isValidAutomergeUrl` rejects it, and every reference is
// then silently dropped from the reachable set — so the suite passes while
// checking an empty graph — precisely the false PASS this module exists to catch.
const ROOT = generateAutomergeUrl()
const META = generateAutomergeUrl()
const REGISTRY = generateAutomergeUrl()
const OBJ_HEAD = generateAutomergeUrl()
const CONN_HEAD = generateAutomergeUrl()
const DIAGRAM = generateAutomergeUrl()
const WRITE_HEAD = generateAutomergeUrl()

const ids = (...urls: string[]) => new Set(urls.map(documentIdOf))

function shardedRoot(overrides: Record<string, unknown> = {}) {
  // Carries a registry WRITE HEAD, so the healthy fixture exercises
  // `registry-head-projected` rather than skipping it — a fixture that skips a
  // check is a fixture that cannot fail it.
  return {
    modelMetaUrl: META,
    shardUrls: [REGISTRY, WRITE_HEAD],
    registryWriteUrl: WRITE_HEAD,
    ...overrides,
  }
}
function healthyMeta(overrides: Record<string, unknown> = {}) {
  return {
    objectShardUrls: [OBJ_HEAD],
    connectionShardUrls: [CONN_HEAD],
    editsObjectShardUrl: OBJ_HEAD,
    editsConnectionShardUrl: CONN_HEAD,
    // The constant, not `1`. With the literal, bumping the protocol turned every
    // "healthy" case in this file red at once, and the obvious repair — edit the
    // literal — is the same keystroke as the repair for a genuine drift. A
    // fixture that means "current" should say "current".
    editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION,
    ...overrides,
  }
}
const registryWith = (docUrl: string) => ({ diagrams: { d1: { id: 'd1', docUrl } } })

/** A workspace where everything resolves and everything is present + admitted. */
function healthyInput(overrides: Partial<Parameters<typeof checkWorkspaceStructure>[0]> = {}) {
  const root = shardedRoot()
  const modelMeta = healthyMeta()
  const registries = [registryWith(DIAGRAM), { diagrams: {} }]
  const referenced = collectReferencedUrls(root, modelMeta, registries)
  const all = ids(ROOT, ...referenced)
  return {
    rootUrl: ROOT,
    root,
    modelMeta,
    unresolvedRegistries: [],
    registryDiagramDocUrls: registryDiagramEntries(registries) as readonly { diagramId: string; docUrl: unknown }[] | undefined,
    referenced,
    presentIds: all,
    admittedIds: all,
    staticSource: null,
    // Zero, not null: the healthy fixture is an ORDINARY workspace, so it
    // has no authority row AND no allow-list, and both halves have to be
    // present for the orphan check to be silent for the right reason. Null
    // would skip it and make every run built on this fixture `incomplete`.
    staticDocumentRows: 0 as number | null,
    claimCoverage: { covered: true },
    diagramTombstones: [] as readonly string[],
    liveTombstonedDiagramIds: new Set<string>() as ReadonlySet<string> | null,
    registryWriteHeadUrl: WRITE_HEAD as string | null,
    // A WRITABLE kind. `registry` here would mean the baseline write fence is
    // dropping every write to the head, which is the state this fixture must
    // NOT be in for the "healthy" contract to mean anything.
    registryWriteHeadStaticKinds: ['registry-shard'] as readonly string[] | null,
    registryWriteHeadDiagramIds: [] as readonly string[] | null,
    projectedWriteHeadDiagramIds: new Set<string>() as ReadonlySet<string> | null,
    registryWriteHeadProjectionLagMs: null as number | null,
    retainedOverlaySegments: [] as readonly { documentId: string; collection: string }[] | null,
    // Both heads MEASURED and comfortably under the ceiling. Small
    // literals rather than a fraction of `OVERLAY_HEAD_CEILING`: a fixture
    // derived from the constant under test agrees with any value that constant
    // is given, and the healthy case has to hold for all of them.
    overlayWriteHeads: [
      { field: 'editsObjectShardUrl', url: OBJ_HEAD, entities: 3, batches: 1, quietForMs: 10, bytes: 900 },
      { field: 'editsConnectionShardUrl', url: CONN_HEAD, entities: 2, batches: 1, quietForMs: 10, bytes: 700 },
    ] as OverlayWriteHeadSize[] | undefined,
    // Every LISTED segment measured and comfortably under the byte
    // ceiling. Literals for the same reason as the heads above: a fixture
    // derived from the constant under test agrees with any value that constant
    // is given.
    //
    // The two heads are IN this list. That is not duplication with
    // `overlayWriteHeads`: the two checks read different facts (entities and
    // quiescence, against storage bytes) from different sources, and the head
    // check is static-plane-only while this one is not. A head is a listed
    // segment, so leaving it out would exempt the one segment the import path
    // is measured to overfill.
    overlaySegmentSizes: [
      { field: 'editsObjectShardUrls', documentId: documentIdOf(OBJ_HEAD), bytes: 900 },
      { field: 'editsConnectionShardUrls', documentId: documentIdOf(CONN_HEAD), bytes: 700 },
    ] as OverlaySegmentSize[] | undefined,
    ...overrides,
  }
}

/**
 * The healthy fixture is an ORDINARY workspace, and overlay rotation is gated
 * on `holdsStaticPlane` — a `read_model_static_workspaces` row. So
 * `overlay-head-bounded` can only RUN on a static one, and a static one must
 * have a summary-only root or `summary-static-coherence` fires on the pair.
 * Both halves are set together here for that reason; setting either alone
 * produces a fixture that is testing a violation it did not mean to.
 */
function staticInput(overrides: Partial<Parameters<typeof checkWorkspaceStructure>[0]> = {}) {
  return healthyInput({
    root: shardedRoot({ registrySummaryOnly: true }),
    staticSource: 'promoted',
    // NOT ZERO: zero is the half-promoted state. `resolveDurable` refuses every
    // document of a static workspace that is not in the allow-list, so an
    // empty list means nothing in the workspace resolves at all.
    //
    // Four, not one: the root, the ModelMeta, the registry and one baseline
    // shard is the smallest allow-list a real promotion produces, so a count
    // that happens to be 1 cannot be read as "somebody wrote a placeholder".
    staticDocumentRows: 4 as number | null,
    ...overrides,
  })
}

describe('workspace fsck — the document-graph invariants', () => {
  it('uses fixture URLs the library actually accepts', () => {
    // Guards the fixtures themselves. Without it, a regression in how URLs are
    // built turns every assertion below into a statement about an empty set.
    for (const value of [ROOT, META, REGISTRY, OBJ_HEAD, CONN_HEAD, DIAGRAM, WRITE_HEAD]) {
      expect(isValidAutomergeUrl(value)).toBe(true)
    }
    expect(new Set([ROOT, META, REGISTRY, OBJ_HEAD, CONN_HEAD, DIAGRAM, WRITE_HEAD]).size).toBe(7)
  })

  it('passes a healthy sharded workspace with EVERY REGISTERED check RUN', () => {
    const result = checkWorkspaceStructure(healthyInput())
    expect(result.findings).toEqual([])
    // Not merely "no findings" — the checks have to have happened, and the
    // list is compared against the REGISTRY, not a hand-copied array: a check
    // added to FSCK_CHECKS but wired nowhere must fail here rather than let a
    // run report `clean` while silently not checking it.
    //
    // The UNION, since `overlay-head-bounded` arrived: this fixture is an
    // ORDINARY workspace and rotation is a static-plane mechanism, so that one
    // check cannot run here. The union still fails a check wired nowhere — it
    // would appear in neither list — and the exact skip plus its reason are
    // pinned below, so "does not apply" cannot quietly become "was not
    // checked". The positive coverage is the static fixture next door.
    expect([...result.checksRun, ...result.checksSkipped.map((entry) => entry.check)].sort())
      .toEqual(Object.keys(FSCK_CHECKS).sort())
    expect(result.checksSkipped).toEqual([
      { check: 'overlay-head-bounded', reason: 'ordinary workspace: overlay rotation is a static-plane mechanism' },
    ])
    // …and a does-not-apply skip must leave the run CLEAN. Without the
    // `ordinary workspace` prefix in `fsckStatusOf`, every ordinary workspace
    // in the fleet would report `incomplete` and `npm run fsck` would exit
    // non-zero for the common case.
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('clean')
  })

  it('passes a healthy STATIC workspace with every check RUN, this one included', () => {
    // The positive half: on the plane where rotation actually runs, nothing is
    // skipped at all. Without this the check above would tolerate a
    // `overlay-head-bounded` that can never run anywhere.
    const result = checkWorkspaceStructure(staticInput())
    expect(result.findings).toEqual([])
    expect([...result.checksRun].sort()).toEqual(Object.keys(FSCK_CHECKS).sort())
    expect(result.checksSkipped).toEqual([])
  })

  describe('diagram-doc-url — a registry meta that names no document', () => {
    // A classic-workspace Structurizr import published 14 such metas before the
    // 2026-10-21 client fix (bridgeImportDocUrl.test.ts). `referenced` drops an
    // invalid url, so every other check passed over them and the run was clean.
    const damaged = [registryWith(DIAGRAM), { diagrams: { d2: { id: 'd2', docUrl: '' } } }]

    it('keeps the raw url of every entry, an empty one included', () => {
      expect(registryDiagramEntries(damaged)).toEqual([
        { diagramId: 'd1', docUrl: DIAGRAM },
        { diagramId: 'd2', docUrl: '' },
      ])
      expect(collectReferencedUrls(shardedRoot(), healthyMeta(), damaged)).not.toContain('')
    })

    it('reports it, and the run is not clean', () => {
      const result = checkWorkspaceStructure(healthyInput({ registryDiagramDocUrls: registryDiagramEntries(damaged) }))
      expect(result.findings.map((f) => [f.check, f.severity])).toEqual([['diagram-doc-url', 'degraded']])
      expect(result.findings[0].detail).toContain('d2')
      expect(fsckStatusOf(result.findings, result.checksSkipped)).not.toBe('clean')
    })

    it('skips rather than passes on a partial walk or when the entries were not gathered', () => {
      const partial = checkWorkspaceStructure(healthyInput({ unresolvedRegistries: [REGISTRY] }))
      expect(partial.checksRun).not.toContain('diagram-doc-url')
      expect(partial.checksSkipped.map((s) => s.check)).toContain('diagram-doc-url')
      const omitted = checkWorkspaceStructure(healthyInput({ registryDiagramDocUrls: undefined }))
      expect(omitted.checksSkipped).toContainEqual({ check: 'diagram-doc-url', reason: 'the registry entries were not gathered' })
      expect(fsckStatusOf(omitted.findings, omitted.checksSkipped)).not.toBe('clean')
    })
  })

  it('reports a sharded model with no overlay write head as data-loss', () => {
    // The defect that lost a real object today: the client-authored ModelMeta
    // (bridge.ts from splitModel().meta) carries the shard arrays and none
    // of the three edits* fields.
    const root = shardedRoot()
    const modelMeta = { objectShardUrls: [OBJ_HEAD], connectionShardUrls: [CONN_HEAD] }
    const referenced = collectReferencedUrls(root, modelMeta, [registryWith(DIAGRAM)])
    const all = ids(ROOT, ...referenced)
    const result = checkWorkspaceStructure({
      rootUrl: ROOT, root, modelMeta, unresolvedRegistries: [], referenced,
      presentIds: all, admittedIds: all, staticSource: null, claimCoverage: null,
    })
    const finding = result.findings.find((f) => f.check === 'model-write-head')
    expect(finding?.severity).toBe('data-loss')
    expect(finding?.detail).toContain('editsObjectShardUrl')
    expect(finding?.detail).toContain('editsConnectionShardUrl')
  })

  it('does NOT flag a monolith workspace, and still calls the run complete', () => {
    // The counterpart mistake, and this codebase has already made it once: the
    // read-model projector shipped an alarm on `modelMetaUrl` appearing, which
    // fires on the ORDINARY bootstrap. A checker that cries wolf on every
    // monolith is worse than no checker, because it will be muted.
    const root = { modelUrl: OBJ_HEAD, shardUrls: [REGISTRY] }
    const referenced = collectReferencedUrls(root, undefined, [registryWith(DIAGRAM)])
    const all = ids(ROOT, ...referenced)
    const result = checkWorkspaceStructure({
      rootUrl: ROOT, root, modelMeta: undefined, unresolvedRegistries: [], referenced,
      presentIds: all, admittedIds: all, staticSource: null, claimCoverage: null,
      diagramTombstones: [], liveTombstonedDiagramIds: new Set<string>(),
      // A monolith can be ASKED whether it has an orphaned allow-list,
      // and the answer is a real zero. Leaving it out would skip the check for
      // a reason that is not "does not apply", which is an INCOMPLETE run, not
      // a clean one — the distinction this whole test exists to defend.
      staticDocumentRows: 0,
      // A monolith HAS no overlay chain, so `overlay-chain-bounded` is a
      // does-not-apply skip. `overlay-segment-retained` is a different case and
      // is given its answer: the empty list is a real answer ("nothing retained"),
      // so that check RUNS. Conflating the two is how a run that never looked
      // reports itself clean.
      retainedOverlaySegments: [],
      // A monolith has registry shards too, so `diagram-doc-url` RUNS.
      registryDiagramDocUrls: registryDiagramEntries([registryWith(DIAGRAM)]),
    })
    expect(result.findings).toEqual([])
    expect(result.checksRun).toContain('diagram-doc-url')
    expect(result.checksSkipped.map((s) => s.check)).toEqual([
      'write-head-writable',
      'model-write-head', 'write-head-version', 'overlay-chain-bounded',
      // A monolith has no overlay WRITE HEAD either, for the same reason
      // it has no chain: nothing names one. Both skips carry the
      // "monolith workspace" prefix, so the run stays COMPLETE.
      // And neither does it have a listed SEGMENT, which is a third
      // fact rather than a restatement of the two above: `overlay-chain-bounded`
      // reads the chain's length, `overlay-head-bounded` the two current heads,
      // and this one the size of every listed segment. All three carry the
      // "monolith workspace" prefix, so the run stays COMPLETE.
      'overlay-head-bounded', 'overlay-segment-bounded', 'claim-coverage',
      'diagram-tombstone-honoured', 'registry-head-projected',
    ])
    // Every skip is a does-not-apply prefix ("monolith workspace" /
    // "uncovered workspace"), which is what lets the caller distinguish
    // "does not apply" from "could not be checked" — the run is COMPLETE.
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('clean')
    // Reachability is still fully checked on a monolith.
    expect(result.checksRun).toEqual(expect.arrayContaining(['document-present', 'document-admitted']))
  })

  it('reports heads present but a legacy write-head version', () => {
    // No producer in the tree emits this today; it is what a document written by
    // a build older than the version field looks like. Online, `writeEditsShards`
    // plans it as needing rotation and bails while `ensureOverlayHandles` plans
    // the same meta as current and returns without rotating — every flush bails
    // forever with no log. Only a checker finds a shape nothing produces.
    const root = shardedRoot()
    const modelMeta = healthyMeta({ editsOverlayWriteHeadVersion: undefined })
    const referenced = collectReferencedUrls(root, modelMeta, [registryWith(DIAGRAM)])
    const all = ids(ROOT, ...referenced)
    const result = checkWorkspaceStructure({
      rootUrl: ROOT, root, modelMeta, unresolvedRegistries: [], referenced,
      presentIds: all, admittedIds: all, staticSource: null, claimCoverage: null,
    })
    const finding = result.findings.find((f) => f.check === 'write-head-version')
    expect(finding?.severity).toBe('data-loss')
    expect(result.findings.some((f) => f.check === 'model-write-head')).toBe(false)
  })

  it('passes a meta built by the production constructor — the checker cannot outvote the producer', () => {
    // Every other row here feeds the checker a HAND WRITTEN meta, which only
    // proves the checker consistent with this file. `buildModelMeta` is what
    // actually stamps the field in production, so feeding its real output in
    // makes producer and detector share one operand: if they were independent
    // literals, a protocol bump would make the checker rate every
    // correctly-built workspace `data-loss`.
    const root = shardedRoot()
    const modelMeta = buildModelMeta({ objectWriteHead: OBJ_HEAD, connectionWriteHead: CONN_HEAD })
    const referenced = collectReferencedUrls(root, modelMeta, [registryWith(DIAGRAM), { diagrams: {} }])
    const all = ids(ROOT, ...referenced)
    // Through `healthyInput`, not a sparse literal: passing only the fields
    // this check reads would leave every OTHER check skipped and the verdict
    // `incomplete`. "Nothing outstanding is only true once everything has been
    // looked at" applies to the test as much as to the sweep.
    const result = checkWorkspaceStructure(healthyInput({
      modelMeta, referenced, presentIds: all, admittedIds: all,
    }))
    expect(result.checksRun).toContain('write-head-version')
    expect(result.findings.filter((f) => f.check === 'write-head-version')).toEqual([])
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('clean')
  })

  it('flags a WRONG version, not merely a missing one', () => {
    // The other negatives use `undefined`, which a detector degenerated to
    // `version === undefined` would also pass. A `data-loss` check that
    // recognises only "field absent" is exactly the checker a protocol bump must
    // not meet, because after a bump every stale meta carries a NUMBER.
    const root = shardedRoot()
    const modelMeta = healthyMeta({ editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION + 1 })
    const referenced = collectReferencedUrls(root, modelMeta, [registryWith(DIAGRAM)])
    const all = ids(ROOT, ...referenced)
    const result = checkWorkspaceStructure({
      rootUrl: ROOT, root, modelMeta, unresolvedRegistries: [], referenced,
      presentIds: all, admittedIds: all, staticSource: null, claimCoverage: null,
    })
    const finding = result.findings.find((f) => f.check === 'write-head-version')
    expect(finding?.severity).toBe('data-loss')
    // The number it reports must be the one it compared against, or the operator
    // reading the report goes looking for the wrong protocol.
    expect(finding?.detail).toContain(`not ${OVERLAY_WRITE_HEAD_VERSION}`)
  })

  it('checks the version when only ONE head is present, not just when both are', () => {
    // The detector's guard is `if (objectHead || connectionHead)`; narrowed to
    // `&&`, a half-built workspace — exactly the shape `model-write-head`
    // already reports — could carry a legacy version that nothing mentioned. The two findings are
    // different repairs (mint the missing head / migrate the protocol), so the
    // report has to carry both.
    const root = shardedRoot()
    const modelMeta = healthyMeta({
      editsConnectionShardUrl: undefined,
      editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION + 1,
    })
    const referenced = collectReferencedUrls(root, modelMeta, [registryWith(DIAGRAM)])
    const all = ids(ROOT, ...referenced)
    const result = checkWorkspaceStructure({
      rootUrl: ROOT, root, modelMeta, unresolvedRegistries: [], referenced,
      presentIds: all, admittedIds: all, staticSource: null, claimCoverage: null,
    })
    expect(result.findings.find((f) => f.check === 'write-head-version')?.severity).toBe('data-loss')
    // Counter-control: the missing head IS also reported, so the row above is
    // not passing because the checker gave up on this workspace entirely.
    expect(result.findings.some((f) => f.check === 'model-write-head')).toBe(true)
  })

  it('summary-static-coherence: a summary root WITH its static row is clean', () => {
    // The two legitimate summary producers (performance seed, sparse draft)
    // both insert the read_model_static_workspaces row — the pairing is the
    // whole contract.
    const result = checkWorkspaceStructure(healthyInput({
      root: shardedRoot({ registrySummaryOnly: true, registryWriteUrl: REGISTRY }),
      staticSource: 'sparse-draft',
      // The pairing is the whole contract of THIS check, but a static
      // workspace also needs a non-empty allow-list to be clean at all — see
      // `static-allow-list-empty`.
      staticDocumentRows: 4,
      claimCoverage: null,
    }))
    expect(result.findings).toEqual([])
    expect(result.checksRun).toContain('summary-static-coherence')
  })

  it('summary-static-coherence: a summary root with NO static row is data-loss', () => {
    // A cold client of this workspace boots summary mode, asks the server read
    // model for its diagrams, and there is nothing there to answer — content
    // intact in storage, unreachable for everyone. This is what a future
    // producer that sets the flag without inserting the row would ship.
    const result = checkWorkspaceStructure(healthyInput({
      root: shardedRoot({ registrySummaryOnly: true, registryWriteUrl: REGISTRY }),
      staticSource: null,
    }))
    const finding = result.findings.find((f) => f.check === 'summary-static-coherence')
    expect(finding?.severity).toBe('data-loss')
    expect(finding?.documentUrl).toBe(ROOT)
    expect(result.findings.filter((f) => f.check !== 'summary-static-coherence')).toEqual([])
  })

  it('summary-static-coherence: a static row with a CLASSIC root is degraded', () => {
    // The live shape on the slope fixtures (flag removed by hand for the walk
    // measurements, static rows kept), and what forkRoot/publishRotatedRoot
    // produce when they rebuild a summary root from their field-literals: the
    // flag is dropped, the row stays. resolveDurable keeps applying the
    // static_allowed filter to a workspace that now grows outside it.
    const result = checkWorkspaceStructure(healthyInput({
      staticSource: 'performance-seed-editable',
      // The subject here is the FLAG/ROW mismatch, so the allow-list is
      // given the populated value a real seed leaves behind. At zero this arm
      // also reported `static-allow-list-empty`, which is true of the fixture
      // and beside this arm's point.
      staticDocumentRows: 4,
      claimCoverage: null,
    }))
    const finding = result.findings.find((f) => f.check === 'summary-static-coherence')
    expect(finding?.severity).toBe('degraded')
    expect(finding?.detail).toContain('performance-seed-editable')
    expect(result.findings.filter((f) => f.check !== 'summary-static-coherence')).toEqual([])
  })

  it('reports a present-but-unadmitted document as a sync stall, not as missing', () => {
    const input = healthyInput()
    const result = checkWorkspaceStructure({
      ...input,
      admittedIds: ids(ROOT, META, REGISTRY, WRITE_HEAD, OBJ_HEAD, CONN_HEAD), // DIAGRAM omitted
    })
    const finding = result.findings.find((f) => f.check === 'document-admitted')
    expect(finding?.documentUrl).toBe(DIAGRAM)
    expect(finding?.severity).toBe('sync-stall')
    expect(result.findings.some((f) => f.check === 'document-present')).toBe(false)
  })

  it('flags an admitted document the graph no longer references as document-orphaned', () => {
    // The inverse direction: admission rows outlive their references — a
    // deleted diagram's doc, a retired overlay segment, a repair that admitted a
    // child and never published the pointer. Only the COMPLETE admission set can
    // see this, which is why fsckWorkspace queries it unbounded.
    const input = healthyInput()
    const orphan = documentIdOf(generateAutomergeUrl())
    const result = checkWorkspaceStructure({
      ...input,
      admittedIds: new Set([...input.admittedIds, orphan]),
    })
    const findings = result.findings.filter((f) => f.check === 'document-orphaned')
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('degraded')
    expect(findings[0].documentUrl).toBe(`automerge:${orphan}`)
    // The root itself and every referenced document are NOT orphans.
    expect(result.findings.filter((f) => f.check !== 'document-orphaned')).toEqual([])
  })

  it('splits an orphan finding by storage presence: dead row vs still-in-storage', () => {
    // The split is what makes the finding actionable: a row whose document is
    // gone from storage too is safe to de-admit; one still in storage may be a
    // snapshot member or a mid-publication child and deserves a look first.
    const input = healthyInput()
    const deadRow = documentIdOf(generateAutomergeUrl())
    const inStorage = documentIdOf(generateAutomergeUrl())
    const result = checkWorkspaceStructure({
      ...input,
      admittedIds: new Set([...input.admittedIds, deadRow, inStorage]),
      presentIds: new Set([...input.presentIds, inStorage]),
    })
    const details = new Map(
      result.findings
        .filter((f) => f.check === 'document-orphaned')
        .map((f) => [f.documentUrl, f.detail]),
    )
    expect(details.get(`automerge:${deadRow}`)).toContain('dead admission row')
    expect(details.get(`automerge:${inStorage}`)).toContain('still IN storage')
  })

  it('does not report repo bookkeeping as an orphan', () => {
    // `storage-adapter-id` is automerge-repo's own peer identity, written as a
    // bare key into the same table as document chunks. It has no root, no
    // parent and no referent, so it is unreachable BY CONSTRUCTION — the
    // orphan check would report it on every workspace whose admission path
    // mapped it, i.e. an alarm that fires on the ordinary bootstrap. It was
    // failing workspaceFsck.integration.test.ts before this filter existed.
    //
    // Asserted with it PRESENT in storage too, which is the real shape: that is
    // the branch that says "still IN storage… deserves a look before any
    // de-admission" and would have sent a reader hunting for nothing.
    const input = healthyInput()
    const result = checkWorkspaceStructure({
      ...input,
      admittedIds: new Set([...input.admittedIds, 'storage-adapter-id']),
      presentIds: new Set([...input.presentIds, 'storage-adapter-id']),
    })
    expect(result.findings).toEqual([])
    // The check must still have RUN — skipping it would trade a false positive
    // for a false `clean`, which is the worse of the two.
    expect(result.checksRun).toContain('document-orphaned')
  })

  it('reports a missing document ONCE, not also as unadmitted', () => {
    // A document absent from storage is necessarily unmapped too. Emitting both
    // doubles the noise on exactly the workspaces that are already worst, and
    // buries the finding that explains the other.
    const input = healthyInput()
    const withoutDiagram = ids(ROOT, META, REGISTRY, WRITE_HEAD, OBJ_HEAD, CONN_HEAD)
    const result = checkWorkspaceStructure({
      ...input, presentIds: withoutDiagram, admittedIds: withoutDiagram,
    })
    const about = result.findings.filter((f) => f.documentUrl === DIAGRAM)
    expect(about).toHaveLength(1)
    expect(about[0].check).toBe('document-present')
  })

  it('refuses to check reachability when a registry shard did not resolve', () => {
    // THE ANTI-LYING TEST, and the reason the report has three statuses instead
    // of a boolean. With one registry unread, the reachable set is a subset, so
    // "every reachable document is present" is a statement about how far the pass
    // got — not about the workspace.
    const root = shardedRoot()
    const modelMeta = healthyMeta()
    const referenced = collectReferencedUrls(root, modelMeta, []) // registry unread
    const result = checkWorkspaceStructure({
      rootUrl: ROOT, root, modelMeta, unresolvedRegistries: [REGISTRY], referenced,
      presentIds: ids(ROOT, ...referenced), admittedIds: ids(ROOT, ...referenced),
      staticSource: null, claimCoverage: null,
    })
    expect(result.checksRun).not.toContain('document-present')
    expect(result.checksRun).not.toContain('document-admitted')
    // The inverse check shares the gate: with one registry unread,
    // "unreachable" would merely mean "not read yet".
    expect(result.checksRun).not.toContain('document-orphaned')
    const skipped = result.checksSkipped.find((s) => s.check === 'document-present')
    expect(skipped?.reason).toContain('registry shard(s) did not resolve')
    // The write-head checks do NOT depend on the registries and must still run —
    // a partial obstacle must not silently disable the checks it does not touch.
    expect(result.checksRun).toEqual(expect.arrayContaining(['model-write-head', 'write-head-version']))
  })

  it('checks nothing and claims nothing when the root did not resolve', () => {
    const result = checkWorkspaceStructure({
      rootUrl: ROOT, root: undefined, modelMeta: undefined, unresolvedRegistries: [],
      referenced: [], presentIds: new Set(), admittedIds: new Set(), staticSource: null, claimCoverage: null,
    })
    expect(result.findings).toEqual([])
    expect(result.checksRun).toEqual([])
    expect(result.checksSkipped).toHaveLength(Object.keys(FSCK_CHECKS).length)
    expect(result.checksSkipped.every((s) => !s.reason.startsWith('monolith workspace'))).toBe(true)
  })

  it('static-allow-list-orphaned: runs WITHOUT a root, because the fact is relational', () => {
    // Deliberately not gated on the root resolving. The workspaces most
    // likely to carry an orphaned allow-list are exactly the ones whose root is
    // in a state that makes every other check skip — an alarm muted where it
    // matters most protects nothing, which is a mistake this module has already
    // shipped once (the monolith bootstrap).
    const orphaned = checkWorkspaceStructure({
      rootUrl: ROOT, root: undefined, modelMeta: undefined, unresolvedRegistries: [],
      referenced: [], presentIds: new Set(), admittedIds: new Set(),
      staticSource: null, staticDocumentRows: 3, claimCoverage: null,
    })
    // BOTH relational checks run without a root, and for the same reason: the
    // orphan direction and the empty direction are facts about two tables and
    // neither needs the graph. `static-allow-list-empty` is silent here because
    // `staticSource` is null — there is no workspace row for an allow-list to be
    // empty FOR — which is the pairing that keeps the two from double-reporting.
    expect([...orphaned.checksRun].sort())
      .toEqual(['static-allow-list-empty', 'static-allow-list-orphaned'])
    expect(orphaned.findings).toHaveLength(1)
    expect(orphaned.findings[0]).toMatchObject({
      check: 'static-allow-list-orphaned', severity: 'degraded',
    })
    expect(orphaned.findings[0].detail).toContain('3 read_model_static_documents')

    // CONTROL — the same rows WITH their workspace row are the normal state of
    // every promoted workspace, and must be silent. Without this the check
    // would be indistinguishable from one that fires on any allow-list at all.
    const healthy = checkWorkspaceStructure({
      rootUrl: ROOT, root: undefined, modelMeta: undefined, unresolvedRegistries: [],
      referenced: [], presentIds: new Set(), admittedIds: new Set(),
      staticSource: 'promotion', staticDocumentRows: 3, claimCoverage: null,
    })
    expect(healthy.findings).toEqual([])
    // The SAME control serves the empty check: a workspace row WITH a populated
    // allow-list is silent on both directions, which is what makes the pair a
    // pair rather than two checks that fire on each other's healthy state.
    expect([...healthy.checksRun].sort())
      .toEqual(['static-allow-list-empty', 'static-allow-list-orphaned'])

    // THE SECOND HALF OF THE SUMMARY CONTRACT, and the half a half-promoted
    // workspace falls through. A workspace ROW with an EMPTY allow-list passes
    // every check above: `summary-static-coherence` pairs the flag with the row
    // and sees both, `static-allow-list-orphaned` looks for documents WITHOUT a
    // row and finds none. Meanwhile `resolveDurable` refuses every document of
    // a static workspace that is not in the allow-list (docScope.ts), so with
    // the list empty NOTHING resolves.
    const halfPromoted = checkWorkspaceStructure({
      rootUrl: ROOT, root: undefined, modelMeta: undefined, unresolvedRegistries: [],
      referenced: [], presentIds: new Set(), admittedIds: new Set(),
      staticSource: 'promoted', staticDocumentRows: 0, claimCoverage: null,
    })
    expect(halfPromoted.findings).toHaveLength(1)
    expect(halfPromoted.findings[0]).toMatchObject({
      check: 'static-allow-list-empty',
      // The same severity `summary-static-coherence` gives its own unreachable
      // case, because the consequence is identical: intact in storage, openable
      // by nobody.
      severity: 'data-loss',
    })
    expect(halfPromoted.findings[0].detail).toContain('promoted')
    // GUARDS AGAINST: `staticDocumentRows === 0` -> `< 0`. The finding would
    // disappear and this arm is the only thing that says so.
    expect(halfPromoted.checksRun).toContain('static-allow-list-empty')

    // …and an UNTAKEN count is skipped, never read as zero. `undefined` is what
    // a caller that forgets the field supplies, and test files are not
    // typechecked, so nothing else can catch that.
    const untaken = checkWorkspaceStructure({
      rootUrl: ROOT, root: undefined, modelMeta: undefined, unresolvedRegistries: [],
      referenced: [], presentIds: new Set(), admittedIds: new Set(),
      staticSource: null, claimCoverage: null,
    } as unknown as Parameters<typeof checkWorkspaceStructure>[0])
    expect(untaken.checksRun).toEqual([])
    expect(untaken.checksSkipped.find((s) => s.check === 'static-allow-list-orphaned')?.reason)
      .toContain('was not taken')
    // BOTH directions skip, and both say why. An untaken count read as zero
    // would make the empty check fire on every workspace whose caller forgot
    // the field — the loudest possible false positive, on the check whose whole
    // subject is a count being zero.
    expect(untaken.checksSkipped.find((s) => s.check === 'static-allow-list-empty')?.reason)
      .toContain('was not taken')
  })

  it('shared-root: flags two workspaces on ONE root document — invisible from either walk alone', () => {
    // Found live: 'default' and the personal landscape shared one root; the
    // losing twin's docScope walk failed "foreign" forever and its cold boots
    // hung with zero errors. Each twin's own graph looked perfectly
    // consistent — only the park view can see this.
    const shared = generateAutomergeUrl()
    const findings = groupSharedRoots([
      { landscape_id: 'default', id: 'v-default', root_url: shared },
      { landscape_id: 'personal', id: 'v-personal', root_url: shared },
      { landscape_id: 'healthy', id: 'v-healthy', root_url: generateAutomergeUrl() },
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0].rootUrl).toBe(shared)
    expect(findings[0].workspaces).toEqual([
      { landscapeId: 'default', versionId: 'v-default' },
      { landscapeId: 'personal', versionId: 'v-personal' },
    ])
  })

  it('shared-root: unique roots produce no finding', () => {
    expect(groupSharedRoots([
      { landscape_id: 'a', id: 'v1', root_url: generateAutomergeUrl() },
      { landscape_id: 'b', id: 'v2', root_url: generateAutomergeUrl() },
    ])).toEqual([])
  })

  it('follows every edge a booting client follows', () => {
    const root = shardedRoot({ registryWriteUrl: REGISTRY })
    const modelMeta = healthyMeta({ editsObjectShardUrls: [OBJ_HEAD], decisionRecordShardUrls: [] })
    const referenced = collectReferencedUrls(root, modelMeta, [registryWith(DIAGRAM)])
    expect(new Set(referenced)).toEqual(new Set([META, REGISTRY, WRITE_HEAD, OBJ_HEAD, CONN_HEAD, DIAGRAM]))
    // The root is excluded on purpose: it is the walk's origin, and the caller
    // adds it back when asking the database about presence.
    expect(referenced).not.toContain(ROOT)
  })

  // ── claim-coverage ─────────────────────────────────────────────────────────

  it('claim-coverage: a covered workspace with a reachable unclaimed document violates (sync-stall)', () => {
    // The lying marker, found by a RUN instead of a reader: covered attaches
    // skip the pre-warm walk, so an unclaimed reachable document has no
    // admission path left until a route-gate miss de-covers the workspace.
    // The diagram is present in storage but missing from the admission set.
    const root = shardedRoot()
    const modelMeta = healthyMeta()
    const referenced = collectReferencedUrls(root, modelMeta, [registryWith(DIAGRAM)])
    const result = checkWorkspaceStructure(healthyInput({
      admittedIds: ids(ROOT, ...referenced.filter((u) => u !== DIAGRAM)),
    }))
    const finding = result.findings.find((f) => f.check === 'claim-coverage')
    expect(finding?.severity).toBe('sync-stall')
    expect(finding?.documentUrl).toBe(DIAGRAM)
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('violations')
    // The plain admission check fires too — different invariant, same hole —
    // and the claim-coverage finding is the one that names the MARKER.
    expect(finding?.detail).toContain('marker')
  })

  it('claim-coverage: an uncovered workspace skips with a reason and can still be clean', () => {
    // "A check that does not apply is not incompleteness" (fsck rule 2): the
    // legacy stock has made no coverage promise, and treating that as a
    // violation — or as an incomplete run — is the muted-alarm inversion: an
    // alarm that fires on every ordinary pre-F workspace gets muted, and then
    // it protects nothing.
    const result = checkWorkspaceStructure(healthyInput({ claimCoverage: null }))
    expect(result.findings).toEqual([])
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('clean')
    expect(result.checksRun).not.toContain('claim-coverage')
    const skipped = result.checksSkipped.find((s) => s.check === 'claim-coverage')
    expect(skipped?.reason).toContain('uncovered workspace')

    // Same for an explicitly de-covered marker (a constat happened).
    const decovered = checkWorkspaceStructure(healthyInput({ claimCoverage: { covered: false } }))
    expect(fsckStatusOf(decovered.findings, decovered.checksSkipped)).toBe('clean')
    expect(decovered.checksRun).not.toContain('claim-coverage')
  })

  it('claim-coverage: a covered workspace with a PARTIAL reachable set is incomplete, never checked-what-we-could', () => {
    // The marker made a promise over the WHOLE reachable set; with a registry
    // unread the set is a subset, and a promise must not be verified against
    // how far the pass got.
    const root = shardedRoot()
    const modelMeta = healthyMeta()
    const referenced = collectReferencedUrls(root, modelMeta, []) // registry unread
    const result = checkWorkspaceStructure(healthyInput({
      unresolvedRegistries: [REGISTRY],
      referenced,
      presentIds: ids(ROOT, ...referenced),
      admittedIds: ids(ROOT, ...referenced),
    }))
    expect(result.checksRun).not.toContain('claim-coverage')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('incomplete')
  })
})

describe('workspace fsck — diagram-tombstone-honoured (T6)', () => {
  it('signale un id tombstoné qui garde sa ligne ro_diagrams', () => {
    // A tombstone the projector never
    // applied is "written but never read" at rest: the client hides the card
    // and the server keeps serving the diagram — paged list, global views, the
    // "linked diagrams" of every object it contained. Nothing is LOST, hence
    // `degraded`; but it is exactly the drift a reader never finds.
    //
    // A row added to FSCK_CHECKS and wired nowhere fails the coverage test
    // above (checksRun vs FSCK_CHECKS).
    const result = checkWorkspaceStructure(healthyInput({
      diagramTombstones: ['dg-gone', 'dg-applied'],
      liveTombstonedDiagramIds: new Set(['dg-gone']),
    }))

    expect(result.checksRun).toContain('diagram-tombstone-honoured')
    const findings = result.findings.filter((f) => f.check === 'diagram-tombstone-honoured')
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('degraded')
    expect(findings[0].detail).toContain('dg-gone')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('violations')
  })

  it('une liste vide EST un contrôle qui a tourné, pas une incomplétude', () => {
    // "Every id in the list is absent" over an empty list is vacuously true and
    // the pass really did look at everything there was. Skipping here would be
    // the opposite mistake to the one the module warns about: it would make
    // `clean` unreachable for the ordinary case.
    const result = checkWorkspaceStructure(healthyInput())

    expect(result.checksRun).toContain('diagram-tombstone-honoured')
    expect(result.findings).toEqual([])
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('clean')
  })

  it('un ModelMeta illisible rend le contrôle INCOMPLET, jamais propre', () => {
    // The tombstone list is unreadable, so nothing can be asserted about it —
    // and "checked what we could" must not read as checked.
    const result = checkWorkspaceStructure(healthyInput({
      modelMeta: undefined,
      modelMetaUnresolved: true,
      diagramTombstones: [],
      liveTombstonedDiagramIds: new Set<string>(),
    }))

    expect(result.checksRun).not.toContain('diagram-tombstone-honoured')
    expect(result.checksSkipped.find((entry) => entry.check === 'diagram-tombstone-honoured')?.reason)
      .toContain('ModelMeta did not resolve')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('incomplete')
  })
})

describe('workspace fsck — registry-head-projected (#41, T9)', () => {
  // The invariant, made runnable: a diagram written to the
  // registry WRITE HEAD is durable and clickable from the nav menu, and has no
  // server row at all — so the Diagrams page, "linked diagrams", the search,
  // `diagram-render`, share links and every other client are blind to it.
  //
  // `sync-stall`, not `data-loss`: the write reached storage. What failed is
  // the read model's ability to ever tell anyone about it.

  it('signale un diagramme de la tête d\'écriture sans ligne ro_diagrams', () => {
    const result = checkWorkspaceStructure(healthyInput({
      registryWriteHeadUrl: WRITE_HEAD,
      registryWriteHeadDiagramIds: ['dg-projected', 'dg-invisible'],
      projectedWriteHeadDiagramIds: new Set(['dg-projected']),
    }))

    expect(result.checksRun).toContain('registry-head-projected')
    const findings = result.findings.filter((f) => f.check === 'registry-head-projected')
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('sync-stall')
    expect(findings[0].detail).toContain('dg-invisible')
    expect(findings[0].documentUrl).toBe(WRITE_HEAD)
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('violations')
  })

  it('une tête d\'écriture entièrement projetée est PROPRE', () => {
    const result = checkWorkspaceStructure(healthyInput({
      registryWriteHeadUrl: WRITE_HEAD,
      registryWriteHeadDiagramIds: ['dg-a', 'dg-b'],
      projectedWriteHeadDiagramIds: new Set(['dg-a', 'dg-b']),
    }))

    expect(result.checksRun).toContain('registry-head-projected')
    expect(result.findings).toEqual([])
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('clean')
  })

  it('ne réclame PAS de ligne pour un id sous pierre tombale', () => {
    // The projection refuses to resurrect a tombstoned id, so demanding a row
    // for one would make the checker contradict the code it checks — an alarm
    // that fires on correct behaviour.
    const result = checkWorkspaceStructure(healthyInput({
      registryWriteHeadUrl: WRITE_HEAD,
      registryWriteHeadDiagramIds: ['dg-a', 'dg-tombed'],
      projectedWriteHeadDiagramIds: new Set(['dg-a']),
      diagramTombstones: ['dg-tombed'],
      liveTombstonedDiagramIds: new Set<string>(),
    }))

    expect(result.checksRun).toContain('registry-head-projected')
    expect(result.findings).toEqual([])
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('clean')
  })

  it('une racine SANS tête d\'écriture ne s\'applique pas, et le run reste COMPLET', () => {
    // A monolith (or a classic sharded workspace) never writes through a head.
    // Does-not-apply, therefore NOT incompleteness — the same contract as
    // `model-write-head` on a monolith.
    const result = checkWorkspaceStructure(healthyInput({
      registryWriteHeadUrl: null,
      registryWriteHeadDiagramIds: null,
      projectedWriteHeadDiagramIds: new Set<string>(),
    }))

    expect(result.checksRun).not.toContain('registry-head-projected')
    expect(result.checksSkipped.find((entry) => entry.check === 'registry-head-projected')?.reason)
      .toMatch(/^monolith workspace/)
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('clean')
  })

  it('une tête d\'écriture illisible rend le run INCOMPLET, jamais propre', () => {
    // The head is named but did not resolve: nothing can be asserted about its
    // diagrams, and "checked what we could" must not read as checked.
    const result = checkWorkspaceStructure(healthyInput({
      registryWriteHeadUrl: WRITE_HEAD,
      registryWriteHeadDiagramIds: null,
      projectedWriteHeadDiagramIds: new Set<string>(),
    }))

    expect(result.checksRun).not.toContain('registry-head-projected')
    expect(result.checksSkipped.find((entry) => entry.check === 'registry-head-projected')?.reason)
      .toContain('registry write head did not resolve')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('incomplete')
  })
})

describe('workspace fsck — la revue : m1 (table absente) et q2 (projection en vol)', () => {
  // m1. The `catch` on 42P01 left the projected set EMPTY, so a database that
  // simply predates the read model produced one `sync-stall` finding PER
  // DIAGRAM of the write head — the exact opposite of what the comment on that
  // catch claimed, and `scripts/fsck-workspaces.ts` does not call
  // `ensureReadModelSchema`, so a fresh database really reaches it. An alarm
  // that screams about the absence of an object it needs is an alarm someone
  // mutes.
  it('m1 — pas de table ro_diagrams : registry-head-projected est SAUTE, pas N violations', () => {
    const result = checkWorkspaceStructure(healthyInput({
      registryWriteHeadDiagramIds: ['d1', 'd2', 'd3'],
      projectedWriteHeadDiagramIds: null,
    }))
    expect(result.findings.filter((f) => f.check === 'registry-head-projected')).toHaveLength(0)
    expect(result.checksRun).not.toContain('registry-head-projected')
    expect(result.checksSkipped.map((s) => s.check)).toContain('registry-head-projected')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('incomplete')
  })

  // The twin failed in the other direction — silently REPORTING CLEAN on a
  // question it could not ask. Module rule 1 says a pass that reports from
  // inside itself reports on how far it got.
  it('m1b — pas de table ro_diagrams : diagram-tombstone-honoured est SAUTE, pas propre', () => {
    const result = checkWorkspaceStructure(healthyInput({
      diagramTombstones: ['gone-1'],
      liveTombstonedDiagramIds: null,
    }))
    expect(result.checksRun).not.toContain('diagram-tombstone-honoured')
    expect(result.checksSkipped.map((s) => s.check)).toContain('diagram-tombstone-honoured')
  })

  // Projection is asynchronous, so any live editing session leaves the head
  // ahead of `ro_diagrams` for the projection latency; reporting that as
  // `sync-stall` would make `clean` a snapshot rather than a verdict.
  it('q2 — une projection EN VOL est tolérée et le dit', () => {
    const result = checkWorkspaceStructure(healthyInput({
      registryWriteHeadDiagramIds: ['d-fresh'],
      projectedWriteHeadDiagramIds: new Set<string>(),
      registryWriteHeadProjectionLagMs: 800,
    }))
    expect(result.findings.filter((f) => f.check === 'registry-head-projected')).toHaveLength(0)
    expect(result.checksSkipped.find((s) => s.check === 'registry-head-projected')?.reason)
      .toContain('projection in flight')
  })

  it('q2b — une projection EN VOL DEPUIS TROP LONGTEMPS reste une violation', () => {
    // The tolerance must not become a mute button: a wedged projector keeps the
    // row pending for ever, and that is precisely a stall.
    const result = checkWorkspaceStructure(healthyInput({
      registryWriteHeadDiagramIds: ['d-fresh'],
      projectedWriteHeadDiagramIds: new Set<string>(),
      registryWriteHeadProjectionLagMs: REGISTRY_HEAD_PROJECTION_GRACE_MS + 1,
    }))
    expect(result.findings.filter((f) => f.check === 'registry-head-projected')).toHaveLength(1)
    expect(result.checksRun).toContain('registry-head-projected')
  })

  it("q2b-bis — la tolérance est bornée par une DURÉE, pas par elle-même", () => {
    // q2b above says "trop longtemps reste une violation", but it expresses
    // "trop longtemps" as `REGISTRY_HEAD_PROJECTION_GRACE_MS + 1`. That is a
    // statement about the constant relative to ITSELF, and it holds for every
    // possible value of it: raise the grace to 24 h and q2b still passes,
    // because its input rises with it.
    //
    // What the tolerance actually promises is in its own comment: "short enough
    // that a wedged projector is still reported by the NEXT RUN rather than
    // tolerated for ever". That promise is about wall-clock duration, so it
    // needs an absolute number to mean anything. Five minutes of a head pending
    // is not latency by any reading — the projector is wedged.
    const result = checkWorkspaceStructure(healthyInput({
      registryWriteHeadDiagramIds: ['d-wedged'],
      projectedWriteHeadDiagramIds: new Set<string>(),
      registryWriteHeadProjectionLagMs: 5 * 60_000,
    }))
    expect(
      result.findings.filter((f) => f.check === 'registry-head-projected'),
      'a write head pending for five minutes is a wedged projector, not a projection in flight — '
      + 'the tolerance has become the mute button q2b exists to forbid',
    ).toHaveLength(1)
    expect(result.checksRun).toContain('registry-head-projected')
    // And the bound said plainly, so the next reader does not have to infer it
    // from a scenario.
    expect(REGISTRY_HEAD_PROJECTION_GRACE_MS).toBeLessThanOrEqual(120_000)
  })

  it('q2c — #41 lui-même (rien en file) reste une violation, la tolérance ne le couvre pas', () => {
    // The defect this check exists for has NO queue row at all — the head was
    // never enqueued. If the tolerance covered that case it would have muted
    // the one thing it was written to find.
    const result = checkWorkspaceStructure(healthyInput({
      registryWriteHeadDiagramIds: ['d-invisible'],
      projectedWriteHeadDiagramIds: new Set<string>(),
      registryWriteHeadProjectionLagMs: null,
    }))
    expect(result.findings.filter((f) => f.check === 'registry-head-projected')).toHaveLength(1)
    expect(result.findings[0].severity).toBe('sync-stall')
  })
})

/**
 * The two checks the overlay chain folder brings with it.
 *
 * `checksRun == Object.keys(FSCK_CHECKS)` alone would not notice the detection
 * loop or the `document-orphaned` exemption being deleted. A check that only
 * has to RUN is a check nobody has ever seen fire.
 */
describe('workspace fsck — D3, la chaîne overlay', () => {
  const segment = (n: number) => ({ documentId: `seg-${n}`, collection: 'object' })

  it('overlay-chain-bounded: crie au-dessus du plafond, se tait EN dessous', () => {
    // GENERATED urls, never hand-written: urlList() runs isValidAutomergeUrl
    // first, so a hand-typed string yields a chain of length ZERO and the test
    // asserts on an empty list while claiming to assert on a long one.
    const chain = (length: number) => Array.from({ length }, () => generateAutomergeUrl())

    // THE LITERAL: every case below sizes its fixture as
    // `chain(OVERLAY_CHAIN_CEILING ± 1)`, so without it the test would agree
    // with any value the constant is given. Keep the relation (it catches a
    // change to the FOLD threshold that should have moved this) and pin the
    // number the code cannot move.
    expect(OVERLAY_CHAIN_CEILING).toBe(4 * OVERLAY_CHAIN_FOLD_MIN)
    expect(OVERLAY_CHAIN_CEILING).toBe(256)

    // At the ceiling exactly: legitimate. This assertion is the point — the
    // module refuses growth-as-violation three separate times, and an alarm
    // that fires on a workspace which merely grew is an alarm that gets muted.
    const atCeiling = checkWorkspaceStructure(healthyInput({
      modelMeta: { ...healthyMeta(), editsObjectShardUrls: chain(OVERLAY_CHAIN_CEILING) },
    }))
    expect(atCeiling.findings.filter((f) => f.check === 'overlay-chain-bounded')).toEqual([])

    // One past it: the folder is not running, and that has a name.
    const past = checkWorkspaceStructure(healthyInput({
      modelMeta: { ...healthyMeta(), editsObjectShardUrls: chain(OVERLAY_CHAIN_CEILING + 1) },
    }))
    const finding = past.findings.find((f) => f.check === 'overlay-chain-bounded')
    expect(finding?.severity).toBe('degraded')
    expect(finding?.detail).toContain('folder is not running')
  })

  // ── overlay-head-bounded ───────────────────────────────────────────────────
  // The rotation's detector, and the reason it had to be a SECOND check rather
  // than a widening of the one above: the two faults have opposite signatures.
  const QUIET = OVERLAY_HEAD_ROTATION_GRACE_MS + 1
  const heads = (over: Partial<OverlayWriteHeadSize>): OverlayWriteHeadSize[] => ([
    { field: 'editsObjectShardUrl', url: OBJ_HEAD, entities: 3, batches: 1, quietForMs: QUIET, bytes: 9, ...over },
    { field: 'editsConnectionShardUrl', url: CONN_HEAD, entities: 2, batches: 1, quietForMs: 10, bytes: 9 },
  ])
  const reason = (result: ReturnType<typeof checkWorkspaceStructure>) =>
    result.checksSkipped.find((s) => s.check === 'overlay-head-bounded')?.reason

  it('overlay-head-bounded: le plafond DÉRIVE du producteur, et un littéral l\'empêche de bouger', () => {
    // The relation, which is what stops the detector and the producer becoming
    // two copies — `OVERLAY_SEGMENT_SIZE` is the number `maybeRotateOverlayHead`
    // schedules at, imported rather than restated.
    expect(OVERLAY_HEAD_CEILING).toBe(4 * OVERLAY_SEGMENT_SIZE)
    // …and the relation ALONE constrains neither operand: it agrees with any
    // value the knob is given, including one that makes the ceiling useless.
    // So the second assertion is a LITERAL, at the defaults this suite runs at.
    // `AM_OVERLAY_SEGMENT_SIZE` is set in no `.env` and no file under `infra/`,
    // and deliberately not set here — a test that sets the knob it is pinning
    // would be pinning itself.
    expect(OVERLAY_SEGMENT_SIZE).toBe(32)
    expect(OVERLAY_HEAD_CEILING).toBe(128)
    // The GRACE must exceed the rotation debounce it waits out, and the bound
    // is the debounce's REACHABLE MAXIMUM, not its default:
    // `AM_OVERLAY_ROTATION_MAX_DELAY_MS` is clamped `maximum: 3_600_000` in
    // `staticDeltaProjector.ts`, and any shorter grace would let a deployment
    // inside that range report a pending rotation as a dead one.
    //
    // LITERALS, not an import: the projector's constant is read from the
    // environment of whatever process holds it, so importing it would move the
    // cross-process problem onto a second knob AND make this assertion agree
    // with any value that knob is given.
    expect(OVERLAY_HEAD_ROTATION_GRACE_MS).toBeGreaterThan(3_600_000)
    expect(OVERLAY_HEAD_ROTATION_GRACE_MS).toBe(3_900_000)
  })

  it('overlay-head-bounded: le plafond SUIT le bouton, ce que le défaut seul ne peut pas montrer', async () => {
    // THE DERIVATION, the reason `OVERLAY_SEGMENT_SIZE` is exported from
    // `overlaySegments.ts`.
    //
    // Rewrite the constant as `4 * 32` and BOTH assertions in the sibling test
    // still pass, because this suite runs at the
    // default knob where `OVERLAY_SEGMENT_SIZE` IS 32. The relation and the
    // literal agree there, so neither can see a restatement. The one input that
    // separates them is a knob that has moved.
    //
    // REGRESSION GUARD: `OVERLAY_HEAD_CEILING = 4 * 32` — the ceiling stays 128 here and
    // this goes red.
    vi.resetModules()
    vi.stubEnv('AM_OVERLAY_SEGMENT_SIZE', '64')
    try {
      const fresh = await import('./workspaceFsck.js')
      const segments = await import('../overlaySegments.js')
      expect(segments.OVERLAY_SEGMENT_SIZE).toBe(64)
      expect(fresh.OVERLAY_HEAD_CEILING).toBe(256)
      // …and it moved, which the equality alone would not prove if the module
      // had failed to re-evaluate.
      expect(fresh.OVERLAY_HEAD_CEILING).not.toBe(OVERLAY_HEAD_CEILING)
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it('overlay-head-bounded: crie au-dessus du plafond, se tait AU plafond', () => {
    // At the ceiling exactly, the same contract as the chain: a workspace that
    // merely grew is not broken.
    const atCeiling = checkWorkspaceStructure(staticInput({
      overlayWriteHeads: heads({ entities: OVERLAY_HEAD_CEILING }),
    }))
    expect(atCeiling.findings.filter((f) => f.check === 'overlay-head-bounded')).toEqual([])
    expect(atCeiling.checksRun).toContain('overlay-head-bounded')

    const past = checkWorkspaceStructure(staticInput({
      overlayWriteHeads: heads({ entities: OVERLAY_HEAD_CEILING + 1 }),
    }))
    const finding = past.findings.find((f) => f.check === 'overlay-head-bounded')
    expect(finding?.severity).toBe('degraded')
    expect(finding?.documentUrl).toBe(OBJ_HEAD)
    expect(finding?.detail).toContain('rotation is not running')
    // The CHAIN LENGTH travels with it — one segment beside a head far past its
    // bound reads "never rotated", a long one reads "rotated until it stopped",
    // and the head alone cannot say which.
    expect(finding?.detail).toContain('editsObjectShardUrls lists 0 segment(s)')
  })

  it('overlay-head-bounded: une tête PLEINE mais encore ÉCRITE ne dit rien — c\'est un import', () => {
    // THE CONJUNCT, and the reason the ceiling could come back down to 4x.
    //
    // A large multiple cannot defend the burst: a ~12k-object import is written
    // into a single head (the client declines to rotate and defers,
    // `owner: 'server'`), which clears 16x as easily as 4x. No multiple can
    // separate a burst from a dead rotator. Only
    // time can — a healthy rotation empties the head within its debounce of the
    // writes STOPPING, so still-full-long-after-the-last-byte is the half a
    // healthy rotation cannot produce.
    //
    // REGRESSION GUARD: delete the `quietForMs` guard — this goes red, and `npm run fsck`
    // starts exiting non-zero for anyone importing a large model.
    const importing = checkWorkspaceStructure(staticInput({
      overlayWriteHeads: heads({ entities: 11_935, quietForMs: 1_000 }),
    }))
    expect(importing.findings.filter((f) => f.check === 'overlay-head-bounded')).toEqual([])
    expect(importing.checksRun).toContain('overlay-head-bounded')

    // At the grace exactly it is still silent; one past it, the rotation has
    // had five minutes to run and has not.
    const atGrace = checkWorkspaceStructure(staticInput({
      overlayWriteHeads: heads({ entities: 11_935, quietForMs: OVERLAY_HEAD_ROTATION_GRACE_MS }),
    }))
    expect(atGrace.findings.filter((f) => f.check === 'overlay-head-bounded')).toEqual([])

    const wedged = checkWorkspaceStructure(staticInput({
      overlayWriteHeads: heads({ entities: 11_935, quietForMs: OVERLAY_HEAD_ROTATION_GRACE_MS + 1 }),
    }))
    expect(wedged.findings.find((f) => f.check === 'overlay-head-bounded')?.detail)
      // A LITERAL, so a grace that moves has to move this too — the derivation
      // test above is what pins the constant itself.
      .toContain('taken no durable write for 3900s')
  })

  it('overlay-head-bounded: le compte de LOTS est un déclencheur à part entière', () => {
    // REGRESSION GUARD: delete the `batches` clause. `maybeRotateOverlayHead` rotates on
    // `entityCount >= SIZE || batchCount >= SIZE`, so a checker that only reads
    // entities is blind to half the promise — and the batch half is the one a
    // write-heavy workspace with few distinct entities hits first.
    const result = checkWorkspaceStructure(staticInput({
      overlayWriteHeads: heads({ entities: 1, batches: OVERLAY_HEAD_CEILING + 1 }),
    }))
    const finding = result.findings.find((f) => f.check === 'overlay-head-bounded')
    expect(finding?.detail).toContain('pending write batches')
    expect(finding?.detail).not.toContain('entities,')
  })

  it('overlay-head-bounded: un paysage ORDINAIRE ne s\'applique pas, et le run reste PROPRE', () => {
    // Every rotating path begins `if (!(await this.holdsStaticPlane(...))) return`,
    // and `rotateOverlayHead` exists in one file. So on the ordinary plane there
    // is no rotation to have stopped, and a finding would be an alarm on a state
    // nothing promised to avoid.
    //
    // REGRESSION GUARD: drop the `staticSource === null` gate — a head over the ceiling on
    // an ordinary workspace becomes a violation, i.e. `npm run fsck` exits
    // non-zero for the common case.
    const result = checkWorkspaceStructure(healthyInput({
      overlayWriteHeads: heads({ entities: 99_999, batches: 99_999 }),
    }))
    expect(result.findings.filter((f) => f.check === 'overlay-head-bounded')).toEqual([])
    expect(reason(result)).toBe('ordinary workspace: overlay rotation is a static-plane mechanism')
    // A does-not-apply skip, so the run is CLEAN and not merely finding-free.
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('clean')
  })

  it('overlay-head-bounded: une méta SANS tête ne s\'applique pas — un `ran` sur une liste vide n\'est pas un contrôle', () => {
    // `model-write-head` reports a head-less sharded meta at `data-loss`; there
    // is nothing here to bound. Recording `ran` over an empty list would make
    // `checksRun` claim a check that looked at nothing. `write-head-version` guards its own body the same way.
    const result = checkWorkspaceStructure(staticInput({ overlayWriteHeads: [] }))
    expect(result.checksRun).not.toContain('overlay-head-bounded')
    // Its OWN does-not-apply prefix, not `monolith workspace` borrowed. This
    // workspace IS sharded — that is precisely why `model-write-head` reports
    // it at `data-loss` — and calling it a monolith to reuse a prefix would be
    // a false statement in the report. It has to be does-not-apply all the
    // same: an `incomplete` outranks findings, so it would report a run that
    // found a real defect as one that could not be checked.
    expect(reason(result)).toBe('no overlay write head: the ModelMeta names neither')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('clean')
  })

  it('overlay-head-bounded: la PERTE DE DONNÉES d\'une méta sans tête survit à ce saut', () => {
    // The half the test above cannot show on its own. With both heads gone,
    // `model-write-head` fires at `data-loss` — and the run must report
    // `violations`, not `incomplete`. `fsckStatusOf` ranks incompleteness
    // ABOVE findings, so a skip with the wrong prefix here would bury a
    // data-loss report behind "could not be checked".
    const result = checkWorkspaceStructure(staticInput({
      modelMeta: { ...healthyMeta(), editsObjectShardUrl: undefined, editsConnectionShardUrl: undefined },
      overlayWriteHeads: [],
    }))
    expect(result.findings.find((f) => f.check === 'model-write-head')?.severity).toBe('data-loss')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('violations')
  })

  it('overlay-head-bounded: une tête NON MESURABLE est SIGNALÉE, et n\'efface pas le verdict de l\'autre', () => {
    // Skipping the WHOLE check when any head is unmeasurable would turn
    //
    //   wedged object head + healthy connection head    -> 1 finding
    //   wedged object head + UNRESOLVED connection head -> 0 findings
    //
    // i.e. the object head's fully-decided verdict would never be produced
    // because the OTHER head could not be read. And what makes a head unreadable is plausibly
    // this very fault growing it past what `A.load` manages inside the
    // per-document ceiling, so the detector would be disarmed in proportion to
    // the severity of the thing it detects.
    //
    // REGRESSION GUARD: restore the `skip(...)` — the wedged head's finding vanishes.
    const result = checkWorkspaceStructure(staticInput({
      overlayWriteHeads: [
        { field: 'editsObjectShardUrl', url: OBJ_HEAD, entities: 99_999, batches: 1, quietForMs: QUIET, bytes: 9 },
        { field: 'editsConnectionShardUrl', url: CONN_HEAD, entities: null, batches: null, quietForMs: 10, bytes: 4_096 },
      ],
    }))
    const byUrl = (url: string) => result.findings
      .find((f) => f.check === 'overlay-head-bounded' && f.documentUrl === url)
    // The decided head keeps its verdict…
    expect(byUrl(OBJ_HEAD)?.detail).toContain('rotation is not running')
    // …and the unmeasurable one is reported rather than swallowed, carrying the
    // byte count as the one measure that still worked on it.
    expect(byUrl(CONN_HEAD)?.detail).toContain('UNVERIFIED')
    expect(byUrl(CONN_HEAD)?.detail).toContain('4 kB in storage')
    expect(result.checksRun).toContain('overlay-head-bounded')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('violations')
  })

  it('overlay-head-bounded: une QUIESCENCE inconnue sous une tête PLEINE est SIGNALÉE avec son incertitude', () => {
    // A missing queue row means nobody can say when writing stopped. Reported
    // rather than skipped, because the CEILING half is decided and because a
    // workspace promoted with an already-full head and not written since has no
    // queue row at all — which is precisely the state this check exists to
    // find.
    //
    // The detail must NOT claim the rotation is dead: it says which of the two
    // readings could not be separated.
    // REGRESSION GUARD: `quietForMs ?? Number.MAX_SAFE_INTEGER` — the finding would then
    // claim a dead rotator on an import in flight.
    const result = checkWorkspaceStructure(staticInput({
      overlayWriteHeads: heads({ entities: 99_999, quietForMs: null }),
    }))
    const finding = result.findings.find((f) => f.check === 'overlay-head-bounded')
    expect(finding?.detail).toContain('could NOT be decided')
    expect(finding?.detail).not.toContain('rotation is not running')
    expect(result.checksRun).toContain('overlay-head-bounded')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('violations')
  })

  it('overlay-head-bounded: la tête des CONNEXIONS a le même plafond que celle des objets', () => {
    // REGRESSION GUARD: `.slice(0, 1)` on the per-head loop. Every other case in this
    // file drives the OBJECT head, so a checker that measured only the first
    // entry would leave the connection side of the promise untested for ever.
    const result = checkWorkspaceStructure(staticInput({
      overlayWriteHeads: [
        { field: 'editsObjectShardUrl', url: OBJ_HEAD, entities: 3, batches: 1, quietForMs: QUIET, bytes: 9 },
        { field: 'editsConnectionShardUrl', url: CONN_HEAD, entities: OVERLAY_HEAD_CEILING + 1, batches: 1, quietForMs: QUIET, bytes: 9 },
      ],
    }))
    const finding = result.findings.find((f) => f.check === 'overlay-head-bounded')
    expect(finding?.documentUrl).toBe(CONN_HEAD)
    expect(finding?.detail).toContain('editsConnectionShardUrl carries')
    expect(finding?.detail).toContain('editsConnectionShardUrls lists 0 segment(s)')
  })

  it('overlay-head-bounded: une tête SAINE n\'a pas besoin de quiescence — sinon toute promotion est INCOMPLÈTE', () => {
    // A head written before `markStaticReadModelWorkspace` inserts the
    // allow-list gets NO `read_model_static_document_queue` row, because the
    // storage adapter's enqueue CTE joins that table. Demanding quiescence up
    // front would turn every freshly promoted workspace `incomplete` (see
    // `promoteSummaryWorkspace.integration.test.ts`).
    //
    // A healthy head has nothing to decide, so it needs no second fact.
    // REGRESSION GUARD: hoist the quiescence guard above the ceiling test — red here, and
    // red in four integration tests that drive the real promotion.
    const result = checkWorkspaceStructure(staticInput({
      overlayWriteHeads: heads({ entities: 3, batches: 1, quietForMs: null }),
    }))
    expect(result.findings).toEqual([])
    expect(result.checksRun).toContain('overlay-head-bounded')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('clean')
  })

  describe('measureOverlayWriteHeads — le collecteur, qu\'aucun test n\'atteignait', () => {
    // Tested directly because reaching the collector inline needs a live repo
    // AND a live database AND a STATIC workspace, and every integration fixture
    // is an ordinary one.
    const meta = { editsObjectShardUrl: OBJ_HEAD, editsConnectionShardUrl: CONN_HEAD }
    const quiet = async () => 1_000
    const bytes = async () => 4_096

    it('une tête NON RÉSOLUE compte `null`, jamais 0', async () => {
      // REGRESSION GUARD: `head === undefined ? 0`. Zero is the HEALTHIEST possible
      // reading of a count nobody could take — "the head is empty" — so that
      // bug would not merely lose information, it would invert the verdict.
      const measured = await measureOverlayWriteHeads(meta, async () => undefined, quiet, bytes)
      expect(measured.map((head) => [head.entities, head.batches]))
        .toEqual([[null, null], [null, null]])
      // …and the rest of the record is still taken: the head is NAMED, so its
      // url, its quiescence and its bytes are all answerable even when its
      // contents are not. `overlayWriteHeadBytes` is the headline number that
      // covers exactly this case.
      expect(measured.map((head) => head.bytes)).toEqual([4_096, 4_096])
    })

    it('une tête vide RÉSOLUE compte 0 — un vrai zéro n\'est pas une absence de réponse', async () => {
      const measured = await measureOverlayWriteHeads(meta, async () => ({}), quiet, bytes)
      expect(measured.map((head) => [head.entities, head.batches])).toEqual([[0, 0], [0, 0]])
    })

    it('lit la bonne COLLECTION pour chaque tête, et déduplique les lots', async () => {
      // REGRESSION GUARD: read `objects` for both. The connection head would then report
      // its object count — 0 on every real document — and the connection side
      // of the promise would be unchecked for ever.
      const measured = await measureOverlayWriteHeads(meta, async (target) => (
        target === OBJ_HEAD
          ? { objects: { a: 1, b: 2, c: 3 }, writeBatchIds: ['x', 'x', 'y'] }
          : { connections: { d: 1 }, writeBatchIds: ['z'] }
      ), quiet, bytes)
      expect(measured.map((head) => [head.field, head.entities, head.batches])).toEqual([
        ['editsObjectShardUrl', 3, 2],
        ['editsConnectionShardUrl', 1, 1],
      ])
    })

    it('une tête ABSENTE ou malformée n\'est pas mesurée — `model-write-head` la signale déjà', async () => {
      const measured = await measureOverlayWriteHeads(
        { editsObjectShardUrl: OBJ_HEAD, editsConnectionShardUrl: 'not-an-automerge-url' },
        async () => ({}), quiet, bytes,
      )
      // One entry, not two, and not a fabricated `null` row: a second finding
      // on a document `model-write-head` already reports at `data-loss` would
      // bury the first.
      expect(measured.map((head) => head.field)).toEqual(['editsObjectShardUrl'])
    })

    it('propage `null` quand la quiescence ou les octets n\'ont pas pu être pris', async () => {
      const measured = await measureOverlayWriteHeads(
        meta, async () => ({}), async () => null, async () => null,
      )
      expect(measured.map((head) => [head.quietForMs, head.bytes]))
        .toEqual([[null, null], [null, null]])
    })

    it('interroge la quiescence et les octets par DOCUMENT ID, jamais par URL', async () => {
      // REGRESSION GUARD: pass `headUrl` instead of `documentIdOf(headUrl)`. Both queries
      // key on `document_id`, so a url — `automerge:<id>` and possibly a `?…`
      // suffix — matches no row: the quiescence reads `null` for every head and
      // the byte sum reads null too. The check then reports "quiescence could
      // not be read" on a perfectly healthy database, for ever.
      const askedQuiet: string[] = []
      const askedBytes: string[] = []
      await measureOverlayWriteHeads(meta, async () => ({}),
        async (id) => { askedQuiet.push(id); return 1 },
        async (id) => { askedBytes.push(id); return 1 })
      expect(askedQuiet).toEqual([documentIdOf(OBJ_HEAD), documentIdOf(CONN_HEAD)])
      expect(askedBytes).toEqual(askedQuiet)
      for (const id of askedQuiet) expect(id).not.toContain('automerge:')
    })

    it('une PREMIÈRE tête absente ne fait pas sauter la seconde', async () => {
      // REGRESSION GUARD: `if (!headUrl) continue` -> `break`. The object head is checked
      // first, so a workspace whose OBJECT head is malformed would silently
      // stop measuring the connection head — and the sibling test above cannot
      // see it, because there the malformed head is the last one.
      const measured = await measureOverlayWriteHeads(
        { editsObjectShardUrl: 'not-an-automerge-url', editsConnectionShardUrl: CONN_HEAD },
        async () => ({}), quiet, bytes,
      )
      expect(measured.map((head) => head.field)).toEqual(['editsConnectionShardUrl'])
    })
  })

  it('overlayWriteHeadBytesTotal: complet ou `null`, jamais une somme partielle', () => {
    // The sum is exported for this test: the report fields themselves are
    // assembled in `fsckWorkspace`, which needs a live database and a live
    // repo.
    expect(overlayWriteHeadBytesTotal(heads({}))).toBe(9 + 9)

    // PARTIAL is not complete: one head answering beside one that could not be
    // summed must not publish the first alone, counting the failure as zero.
    // REGRESSION GUARD: `.some(bytes !== null) ? reduce : null`.
    expect(overlayWriteHeadBytesTotal(heads({ bytes: null }))).toBeNull()

    // A real zero survives: both heads answered, and one is empty.
    expect(overlayWriteHeadBytesTotal(heads({ bytes: 0 }))).toBe(0 + 9)

    // No head at all is "does not apply", not "weighs nothing"; and an
    // unmeasured caller is neither.
    expect(overlayWriteHeadBytesTotal([])).toBeNull()
    expect(overlayWriteHeadBytesTotal(undefined)).toBeNull()
  })

  it('overlay-head-bounded: un appelant qui ne MESURE PAS rend le run INCOMPLET', () => {
    // The `retainedOverlaySegments` rule, applied to a second field: a caller
    // that omitted it must land in the SAFE direction. A default of `[]` here
    // would make every such run report itself clean on a list it never received.
    const result = checkWorkspaceStructure(staticInput({ overlayWriteHeads: undefined }))
    expect(reason(result)).toBe('the overlay write heads were not measured')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('incomplete')
  })

  it('overlay-head-bounded: l\'ORDRE de l\'échelle — « ordinaire » passe AVANT « non mesuré »', () => {
    // An ORDINARY workspace whose heads are also unmeasured is what any caller
    // that skips the measurement for a workspace it knows is ordinary
    // produces. If the not-measured gate won, every one of them would report
    // `incomplete`, i.e. `npm run fsck` would exit non-zero across the fleet
    // for a check that does not apply to those workspaces at all.
    // REGRESSION GUARD: move the `!input.overlayWriteHeads` branch above the
    // `staticSource === null` branch.
    const result = checkWorkspaceStructure(healthyInput({ overlayWriteHeads: undefined }))
    expect(reason(result)).toBe('ordinary workspace: overlay rotation is a static-plane mechanism')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('clean')
  })

  it('overlay-segment-retained: un segment retenu sans octets est une PERTE DE DONNEES', () => {
    const result = checkWorkspaceStructure(healthyInput({
      retainedOverlaySegments: [segment(1)],
      // `seg-1` is in NEITHER `presentIds` nor `referenced`: retained by
      // contract, gone from storage. That is the GC root having failed.
    }))
    const finding = result.findings.find((f) => f.check === 'overlay-segment-retained')
    expect(finding?.severity).toBe('data-loss')
    expect(finding?.documentUrl).toBe('automerge:seg-1')

    // Present in storage: nothing to say.
    const present = checkWorkspaceStructure(healthyInput({
      retainedOverlaySegments: [segment(1)],
      presentIds: new Set(['seg-1']) as ReadonlySet<string>,
    }))
    expect(present.findings.filter((f) => f.check === 'overlay-segment-retained')).toEqual([])
  })

  it('un segment PLIE ne devient pas un findings document-orphaned', () => {
    // A folded segment is unreachable from the root ON PURPOSE and keeps its
    // admission row ON PURPOSE. Without the exemption, one fold pass turns a
    // clean workspace into up to `budget` findings per collection and the
    // check gets muted. Guards the `retainedOverlaySegments` loop in
    // `document-orphaned`.
    const admitted = new Set([...healthyInput().admittedIds, 'seg-1']) as ReadonlySet<string>
    const exempt = checkWorkspaceStructure(healthyInput({
      admittedIds: admitted,
      presentIds: new Set([...healthyInput().presentIds, 'seg-1']) as ReadonlySet<string>,
      retainedOverlaySegments: [segment(1)],
    }))
    expect(exempt.findings.filter((f) => f.check === 'document-orphaned')).toEqual([])

    // And the control: the SAME admission without the retained list IS an
    // orphan. Without this half, the assertion above would also pass against
    // a checker that never reports orphans at all.
    const orphan = checkWorkspaceStructure(healthyInput({
      admittedIds: admitted,
      presentIds: new Set([...healthyInput().presentIds, 'seg-1']) as ReadonlySet<string>,
      retainedOverlaySegments: [],
    }))
    expect(orphan.findings.filter((f) => f.check === 'document-orphaned')).toHaveLength(1)
  })
})

/**
 * `write-head-writable`.
 *
 * A registry write head stored with `kind = 'registry'` — a BASELINE kind —
 * has EVERY write dropped by the baseline write fence, silently. Fixtures
 * provisioned by an older producer can carry exactly that.
 *
 * `baselineWriteFence.test.ts` checks every runnable producer's output, but a
 * producer unit test cannot see this: the fault is in the STORED ROW, not in
 * the code that writes it. That is why this check reads the value from the
 * database.
 */
describe('write-head-writable — la tête d\'écriture gelée par la clôture', () => {
  it('signale en data-loss une tête étiquetée avec un kind de SOCLE', () => {
    const result = checkWorkspaceStructure(healthyInput({
      registryWriteHeadStaticKinds: ['registry'],
    }))
    const found = result.findings.filter((f) => f.check === 'write-head-writable')
    expect(found).toHaveLength(1)
    // `data-loss` au sens littéral du module : « a user edit is accepted by the
    // UI and never reaches durable storage ». Pas `degraded` — l'espace a l'air
    // de fonctionner, et c'est exactement ce qui rend la perte silencieuse.
    expect(found[0].severity).toBe('data-loss')
    expect(found[0].documentUrl).toBe(WRITE_HEAD)
    expect(result.checksRun).toContain('write-head-writable')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('violations')
  })

  it('accepte une tête writable, et le check a bien TOURNÉ', () => {
    const result = checkWorkspaceStructure(healthyInput({ registryWriteHeadStaticKinds: ['registry-shard'] }))
    expect(result.findings.filter((f) => f.check === 'write-head-writable')).toEqual([])
    // Le contrôle qui distingue « propre » de « pas regardé » : sans cette
    // ligne, un check débranché passerait ce test.
    expect(result.checksRun).toContain('write-head-writable')
  })

  it('attrape AUSSI les kinds de base du modèle, pas seulement `registry`', () => {
    // Le prédicat est celui de la clôture (`isBaselineDocumentKind`), importé et
    // non recopié : une copie locale dériverait et certifierait un espace que la
    // clôture est en train de geler.
    for (const kind of ['object-base', 'connection-base', 'decision-record-base']) {
      const result = checkWorkspaceStructure(healthyInput({ registryWriteHeadStaticKinds: [kind] }))
      const found = result.findings.filter((f) => f.check === 'write-head-writable')
      expect(found, kind).toHaveLength(1)
      // Et le conseil de réparation N'est PAS offert : `realign-performance-fixture`
      // ne relabelle que `registry` et refuse tout le reste. Un constat qui
      // embarque une commande qui va refuser vaut moins qu'un constat nu.
      expect(found[0].detail, kind).not.toContain('realign-performance-fixture --')
      expect(found[0].detail, kind).toContain('no automatic repair')
    }
  })

  it('une tête listée SOCLE SOUS UN AUTRE ESPACE est gelée ici aussi', () => {
    // The fence queries `WHERE document.document_id = $1` — with NO workspace
    // scope — so a document listed as baseline under any static workspace is
    // frozen EVERYWHERE. A read scoped to this workspace would return zero
    // rows and certify `clean` while the fence freezes. Reachable through
    // shared roots, which the `shared-root` park check exists to catch.
    const result = checkWorkspaceStructure(healthyInput({
      registryWriteHeadStaticKinds: ['registry-shard', 'registry'],
    }))
    const found = result.findings.filter((f) => f.check === 'write-head-writable')
    expect(found).toHaveLength(1)
    // `.some`, comme la clôture — une seule ligne socle suffit à geler, même si
    // la ligne de CET espace est parfaitement writable.
    expect(found[0].detail).toContain("'registry'")
  })

  it('une liste VIDE est une réponse, pas une absence de réponse', () => {
    // `[]` = la requête a tourné et rien ne liste ce document : la clôture le
    // laisse passer. Le check TOURNE donc et ne trouve rien. Le confondre avec
    // `null` rendrait CHAQUE espace non promu `incomplete` — une alarme qui se
    // déclenche sur le cas normal finit muette.
    const result = checkWorkspaceStructure(healthyInput({ registryWriteHeadStaticKinds: [] }))
    expect(result.findings.filter((f) => f.check === 'write-head-writable')).toEqual([])
    expect(result.checksRun).toContain('write-head-writable')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('clean')
  })

  it('SAUTE quand le manifeste est ILLISIBLE, et le run devient incomplete', () => {
    const result = checkWorkspaceStructure(healthyInput({ registryWriteHeadStaticKinds: null }))
    expect(result.findings.filter((f) => f.check === 'write-head-writable')).toEqual([])
    expect(result.checksRun).not.toContain('write-head-writable')
    // Starting this reason with `monolith workspace` would turn a workspace
    // that could not be looked at into `clean`: `fsckStatusOf` classifies by
    // string PREFIX, so without this line one word could flip the verdict.
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('incomplete')
  })

  it('SAUTE sur un monolithe, avec une raison, et le run reste COMPLET', () => {
    const result = checkWorkspaceStructure(healthyInput({
      registryWriteHeadUrl: null,
      registryWriteHeadStaticKinds: null,
      registryWriteHeadDiagramIds: null,
      projectedWriteHeadDiagramIds: null,
    }))
    const skipped = result.checksSkipped.find((e) => e.check === 'write-head-writable')
    expect(skipped).toBeDefined()
    expect(skipped!.reason).toMatch(/^monolith workspace/)
    // Le pendant de l'assertion ci-dessus : ici le saut est un ne-s'applique-pas,
    // et le run DOIT pouvoir rester complet. Les deux ensemble épinglent la
    // distinction « ne s'applique pas » / « n'a pas pu regarder ».
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('clean')
  })
})

/**
 * `overlay-segment-bounded`.
 *
 * The blind spot this closes: without it, a workspace whose overlay held ONE
 * ~12k-entity merged document would report `clean` on every other check.
 * `overlay-chain-bounded` reads the chain's
 * LENGTH — which the fold makes SHORTER as the merged document grows, so it
 * reads greener the worse the fault gets — and `overlay-head-bounded` reads
 * only the two CURRENT heads, which the fold's output never is.
 */
describe('overlay-segment-bounded — the size of a LISTED segment (A11)', () => {
  const segment = (bytes: number | null, n = 0): OverlaySegmentSize => ({
    field: 'editsObjectShardUrls',
    documentId: documentIdOf(generateAutomergeUrl()),
    bytes,
    ...(n ? {} : {}),
  })

  it('fires on a segment past the byte ceiling', () => {
    const result = checkWorkspaceStructure(healthyInput({
      overlaySegmentSizes: [segment(OVERLAY_SEGMENT_BYTE_CEILING + 1)],
    }))
    const found = result.findings.filter((f) => f.check === 'overlay-segment-bounded')
    expect(found).toHaveLength(1)
    expect(found[0]!.severity).toBe('degraded')
    expect(result.checksRun).toContain('overlay-segment-bounded')
  })

  it('measures the CONNECTION chain too, not only the object one', () => {
    // REGRESSION GUARD: dropping `editsConnectionShardUrls` from the list
    // `fsckWorkspace` builds. The other assertions use object-side fixtures,
    // so an over-ceiling CONNECTION segment would be invisible — and
    // connections grow fast on an imported landscape (fewer than objects, but
    // each rewritten whenever either endpoint moves).
    const result = checkWorkspaceStructure(healthyInput({
      overlaySegmentSizes: [{
        field: 'editsConnectionShardUrls',
        documentId: documentIdOf(generateAutomergeUrl()),
        bytes: OVERLAY_SEGMENT_BYTE_CEILING + 1,
      }],
    }))
    const found = result.findings.filter((f) => f.check === 'overlay-segment-bounded')
    expect(found).toHaveLength(1)
    expect(found[0]!.detail).toContain('editsConnectionShardUrls')
  })

  it('is silent EXACTLY AT the ceiling', () => {
    const result = checkWorkspaceStructure(healthyInput({
      overlaySegmentSizes: [segment(OVERLAY_SEGMENT_BYTE_CEILING)],
    }))
    expect(result.findings.filter((f) => f.check === 'overlay-segment-bounded')).toEqual([])
    // REGRESSION GUARD: `<` instead of `<=`. A segment exactly at the bound is the
    // COMMON case — every full part the fold's split emits is exactly the
    // ceiling — so an off-by-one here fires on every healthy workspace, and an
    // alarm that fires on the ordinary case is an alarm that gets muted.
  })

  it('fires against a LITERAL, so the ceiling cannot be moved without a red test', () => {
    // A test that derives its bound from the constant under test agrees with
    // any value that constant is given. 2 MB is the size of a runaway merged
    // segment on a ~12k-entity landscape; it must fire whatever
    // `OVERLAY_SEGMENT_BYTE_CEILING` is set to,
    // or the constant has been given a value that does not bound the defect it
    // exists for.
    const result = checkWorkspaceStructure(healthyInput({
      overlaySegmentSizes: [segment(2_000_000)],
    }))
    expect(result.findings.filter((f) => f.check === 'overlay-segment-bounded')).toHaveLength(1)
  })

  it('fires on an ORDINARY workspace too, unlike overlay-head-bounded', () => {
    // The head check skips the ordinary plane because nothing there promises to
    // rotate. This one must NOT: the import path overfills a head on any plane,
    // the next rotation retires it WHOLE, and there is no plane on which a
    // 2 MB overlay segment is healthy.
    const ordinary = checkWorkspaceStructure(healthyInput({
      staticSource: null,
      overlaySegmentSizes: [segment(OVERLAY_SEGMENT_BYTE_CEILING * 4)],
    }))
    expect(ordinary.findings.filter((f) => f.check === 'overlay-segment-bounded')).toHaveLength(1)
    // The CONTROL that makes that meaningful: the head check DOES skip here.
    expect(ordinary.checksSkipped.map((s) => s.check)).toContain('overlay-head-bounded')
    expect(ordinary.checksRun).toContain('overlay-segment-bounded')
  })

  it('judges every segment SEPARATELY — an unmeasurable one cannot silence a measured one', () => {
    // Same rule as `overlay-head-bounded`: skipping the whole check when ANY
    // item is unmeasurable would let an unresolved item hide a wedged one.
    const fat = segment(OVERLAY_SEGMENT_BYTE_CEILING * 3)
    const blank = segment(null)
    const result = checkWorkspaceStructure(healthyInput({
      overlaySegmentSizes: [fat, blank],
      // BOTH PRESENT in storage, so the blank one is a genuine disagreement
      // between two predicates over the same table rather than a plain absence.
      presentIds: new Set([fat.documentId, blank.documentId]),
    }))
    const found = result.findings.filter((f) => f.check === 'overlay-segment-bounded')
    // One for the over-full segment, one for the present-but-unmeasurable one.
    expect(found).toHaveLength(2)
    expect(found.some((f) => f.detail.includes('past the'))).toBe(true)
    expect(found.some((f) => f.detail.includes('UNVERIFIED'))).toBe(true)
  })

  it('leaves an ABSENT segment to document-present — one fault, one voice', () => {
    // `document-admitted` refuses this duplication in as many words: "a missing
    // document is already reported once and reporting it twice buries the first
    // finding". `collectReferencedUrls` puts both `edits*ShardUrls` in
    // `referenced`, so an absent segment is ALREADY reported there.
    const fat = segment(OVERLAY_SEGMENT_BYTE_CEILING * 3)
    const absent = segment(null)
    const result = checkWorkspaceStructure(healthyInput({
      overlaySegmentSizes: [fat, absent],
      presentIds: new Set([fat.documentId]),
    }))
    const found = result.findings.filter((f) => f.check === 'overlay-segment-bounded')
    // REGRESSION GUARD: drop the `presentIds` filter. The absent segment then earns a
    // second finding here, and a reader chasing it lands on a size question
    // when the real fault is that the document is gone.
    expect(found).toHaveLength(1)
    expect(found[0]!.detail).toContain('past the')
  })

  it('does not apply when the ModelMeta lists NO segment, and the run stays complete', () => {
    const result = checkWorkspaceStructure(healthyInput({ overlaySegmentSizes: [] }))
    expect(result.checksRun).not.toContain('overlay-segment-bounded')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('clean')
  })

  it('is INCOMPLETE, never clean, when the caller did not measure', () => {
    // The opposite of the row above, and the pair is the point: "there are no
    // segments" is an answer, "nobody looked" is not. A checker that reports
    // from inside itself reports on how far it got.
    const result = checkWorkspaceStructure(healthyInput({ overlaySegmentSizes: undefined }))
    expect(result.checksRun).not.toContain('overlay-segment-bounded')
    expect(fsckStatusOf(result.findings, result.checksSkipped)).toBe('incomplete')
  })
})
