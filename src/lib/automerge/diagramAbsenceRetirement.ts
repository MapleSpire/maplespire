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

import type { SerializedEntityIntent } from './entityIntents'
import { isDiagramCollectionKind } from './entityIntents'

/**
 * Planner for the REMOTE-delete anti-entropy sweep.
 *
 * A diagram deleted by another client strands every intent scoped to it: the
 * comment/flow replay parks non-active intents until "their diagram is
 * activated" — which a deleted diagram never is — the flush-side acks skip
 * them, and the off-active placement drain loses its doc url. The badge wedges
 * on 'saving' forever, rehydrated afresh at every boot.
 *
 * The local delete paths already retire dependents at the moment the removal
 * is EXPRESSED (`retireIntentsForDeletedDiagram`); a remote removal is never
 * expressed by this client, so its proof is OBSERVATION: the diagram is absent
 * from a COMPLETE registry reading. A transition diff (old-ids minus new-ids)
 * is deliberately NOT the authority — a diff observes a
 * deletion exactly once, so any aborted ack (crash, workspace switch, offline
 * witness flush) recreates the permanent wedge it was meant to close. The
 * JOURNAL itself is the memo instead: this planner re-derives the retirement
 * set from the pending intents on every run, so the sweep is idempotent and
 * crash-proof, and event triggers only decide WHEN it runs, never WHAT it
 * sees.
 */
export interface DiagramAbsenceObservation {
  /** Diagram ids present in the registry, derived from SHARD DOCS only —
   * never from `serverRegistryDiagrams`, which the client feeds itself
   * (the witness-derives-from-the-claim trap). CONTRACT: the caller builds
   * this from a COMPLETE reading only (every root-listed shard resolved, or
   * the summary write-head resolved) and abstains entirely otherwise — an
   * unresolved shard is NOT an empty shard, and this planner cannot tell
   * "loading" from "deleted" on its own. */
  presentIds: ReadonlySet<string>
  /** Non-null under a summary-only registry: the session-local ids. The
   * write-head shard is the complete registry for THOSE ids only; a
   * server-owned diagram's absence is unprovable client-side and its
   * intents would be retained.
   *
   * For the summary mode, `observeRegistryAbsence` therefore also folds `ModelMeta.deletedDiagramIds` into this set, so a server-owned
   * diagram's absence becomes provable POSITIVELY — stated by a durable
   * document instead of inferred from a window that proves nothing. */
  summaryLocalIds: ReadonlySet<string> | null
}

export interface DiagramAbsenceSweepInput {
  intents: readonly SerializedEntityIntent[]
  /** Diagram ids holding pending placement records (the drain's worklist). */
  placementDiagramIds: readonly string[]
  observation: DiagramAbsenceObservation
  /** A creation that has not reached any shard yet is legitimately absent:
   * the doc-durability gate, a pending creation intent (the replay must
   * recreate it) and the projection hold all mean "in flight", never
   * "deleted". Consulted per candidate diagram id. */
  isCreationInFlight: (diagramId: string) => boolean
}

export interface DiagramAbsenceRetirement {
  diagramId: string
  commentIds: string[]
  flowIds: string[]
  /** True when a non-creation 'diagram' stub intent (rename patch or delete)
   * targets the absent id — same absence proof retires it, without waiting
   * for the next flush or replay junction. */
  stubIntent: boolean
  placement: boolean
}

export interface DiagramAbsenceSweepPlan {
  retire: DiagramAbsenceRetirement[]
  /** Comment/flow DELETE intents carrying no diagramId at all: unmatchable by
   * the replay (parked forever), unmatchable by the ack (never a survivor),
   * and unwitnessable by construction — retired under a complete observation
   * Practically unreachable; this is the
   * sweep's own anti-entropy for a journal written by a foreign build. */
  unaddressed: Array<{ kind: 'comment' | 'flow'; id: string }>
}

const EMPTY_PLAN: DiagramAbsenceSweepPlan = Object.freeze({ retire: [], unaddressed: [] })

/** One registry shard as the observation sees it: `diagramIds` is null while
 * the doc is unresolved — which is a reason to ABSTAIN, never an empty shard. */
export interface RegistryAbsenceWitness {
  url: string
  diagramIds: readonly string[] | null
}

export interface RegistryAbsenceInput {
  mode: 'classic' | 'summary'
  witnesses: readonly RegistryAbsenceWitness[]
  /** Classic only: the root document's shard-url list — the authority on how
   * many shards exist AND which. `witnesses` alone is vacuously complete
   * while empty or mid-rollover, and count equality
   * alone admits a same-count url replacement window (url-set membership
   * closes the class). */
  rootShardUrls: readonly string[] | null
  /** Summary only: the CURRENT write-head url. It must be among the resolved
   * witnesses — `witnesses[0]` is not the write head by construction (a
   * deferred head install can merge behind a session-provisioned one, and a
   * session-local diagram whose meta lives in the second shard would be
   * falsely retired). */
  writeHeadUrl: string | null
  /** Summary only: the ids provable against the write-head (session-local
   * memo, PLUS the locally-retired side memo so a failed ack keeps its
   * provability — consuming it with the cleanup would re-create the one-shot
   * miss this module exists to ban). */
  summaryLocalIds: ReadonlySet<string> | null
  /** The diagram tombstones the client currently holds (from ModelMeta,
   * local and remote). Positive proof of deletion in BOTH modes. */
  tombstonedIds?: ReadonlySet<string>
}

/**
 * Build the absence observation, or abstain (null) when completeness cannot
 * be claimed. Pure — the caller feeds module state in; every abstention rule
 * is unit-coverable here instead of living in the bridge tier the unit level
 * cannot see (these are the feature's most safety-critical rules).
 */
export function observeRegistryAbsence(input: RegistryAbsenceInput): DiagramAbsenceObservation | null {
  const tombstonedIds = input.tombstonedIds ?? new Set<string>()
  if (input.witnesses.length === 0) return null
  // An unresolved witness hides metas in BOTH modes: abstain, never default.
  for (const witness of input.witnesses) {
    if (witness.diagramIds === null) return null
  }
  const presentIds = new Set<string>()
  for (const witness of input.witnesses) {
    for (const id of witness.diagramIds!) presentIds.add(id)
  }
  // A tombstoned id is ABSENT no matter what any shard still says. The frozen
  // baseline registry keeps its entry for ever by design, so presence there is
  // not evidence of existence once ModelMeta says otherwise.
  for (const id of tombstonedIds) presentIds.delete(id)
  if (input.mode === 'summary') {
    if (!input.writeHeadUrl) return null
    if (!input.witnesses.some((witness) => witness.url === input.writeHeadUrl)) return null
    return {
      presentIds,
      // The union: a session-local id is provable against the write head, and
      // a SERVER-OWNED id becomes provable the moment its tombstone exists —
      // without the second half those intents would have no exit at all.
      summaryLocalIds: new Set([...(input.summaryLocalIds ?? []), ...tombstonedIds]),
    }
  }
  const rootUrls = input.rootShardUrls
  if (!rootUrls || rootUrls.length === 0) return null
  if (input.witnesses.length !== rootUrls.length) return null
  const rootSet = new Set(rootUrls)
  for (const witness of input.witnesses) {
    if (!rootSet.has(witness.url)) return null
  }
  return { presentIds, summaryLocalIds: null }
}

export function planDiagramAbsenceSweep(input: DiagramAbsenceSweepInput): DiagramAbsenceSweepPlan {
  const byDiagram = new Map<string, DiagramAbsenceRetirement>()
  const unaddressed: DiagramAbsenceSweepPlan['unaddressed'] = []
  // A summary observation witnesses nothing about an UNKNOWN carrier: the
  // unaddressed arm (dangling deletes) is a classic-completeness-only call
  // (retiring a delete un-expresses a user deletion, and the write-head
  // proves nothing about where it lived).
  const unaddressedProvable = input.observation.summaryLocalIds === null
  const candidate = (diagramId: string): DiagramAbsenceRetirement => {
    let entry = byDiagram.get(diagramId)
    if (!entry) {
      entry = { diagramId, commentIds: [], flowIds: [], stubIntent: false, placement: false }
      byDiagram.set(diagramId, entry)
    }
    return entry
  }

  for (const intent of input.intents) {
    if (isDiagramCollectionKind(intent.kind)) {
      const diagramId = intent.op === 'delete'
        ? intent.diagramId
        : (intent.snapshot as { diagramId?: string }).diagramId
      if (diagramId === undefined) {
        // An UPSERT with no diagramId carries user data and is retained
        // (parked, badge-honest) — only data-free deletes are unaddressable.
        if (intent.op === 'delete' && unaddressedProvable) {
          unaddressed.push({ kind: intent.kind, id: intent.id })
        }
        continue
      }
      const entry = candidate(diagramId)
      if (intent.kind === 'comment') entry.commentIds.push(intent.id)
      else entry.flowIds.push(intent.id)
      continue
    }
    if (intent.kind === 'diagram') {
      // A pending CREATION of an absent diagram is the replay's job — it
      // recreates under the same id. Only an edit of a once-durable diagram
      // (baseline present) or a delete retires on proven absence.
      if (intent.op === 'upsert' && intent.baseline === undefined) continue
      candidate(intent.id).stubIntent = true
    }
  }
  for (const diagramId of input.placementDiagramIds) candidate(diagramId).placement = true

  if (byDiagram.size === 0 && unaddressed.length === 0) return EMPTY_PLAN

  const retire: DiagramAbsenceRetirement[] = []
  for (const entry of byDiagram.values()) {
    if (input.observation.presentIds.has(entry.diagramId)) continue
    if (input.observation.summaryLocalIds && !input.observation.summaryLocalIds.has(entry.diagramId)) continue
    if (input.isCreationInFlight(entry.diagramId)) continue
    retire.push(entry)
  }
  if (retire.length === 0 && unaddressed.length === 0) return EMPTY_PLAN
  return { retire, unaddressed }
}
