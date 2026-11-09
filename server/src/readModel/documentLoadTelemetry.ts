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

import type { MetricSample } from '../runtime/metrics.js'

/**
 * NON-RESIDENT DOCUMENT LOADS BY THE READ-MODEL PROJECTOR (G4-16, M3).
 *
 * A document not in the Repo's cache is read from storage and
 * `Automerge.load`ed in ONE synchronous wasm call: 30–70 ms for a
 * fleet-shaped retired head (512 changes, 128 actors), on the owner cell's
 * event loop. In a CPU profile the stack of such a stall ends at
 * `StorageSubsystem.loadDoc`: the projector path that asked is behind an
 * await. So every such load is COUNTED by that path (`caller`) and by when
 * (`phase`: during the projector's attach, or after it), a slow one after the
 * attach is LOGGED with its document (`read_model.document_loaded`), and an
 * attach logs one summary of its own loads
 * (`read_model.attach_document_loads`).
 */

/** Which path of the projector resolved a document, and so which role the
 * document plays: `rotation-current` the current write head, `fold-sample` a
 * retired head the fold samples, `fold-settle` a source a product replaces,
 * `fold-product` a product being attached, `folded-arrival` a detached
 * (folded) source the arrival poll forwards, `handover-recheck` a
 * still-watched head re-read for the handover, `parked-arrival`/`park` a
 * parked retired head, `extract` a listed shard read by an extraction,
 * `attach` a shard newly listed in ModelMeta. */
export const DOCUMENT_LOAD_CALLERS = [
  'attach', 'extract', 'rotation-current', 'fold-sample', 'fold-settle', 'fold-product',
  'folded-arrival', 'handover-recheck', 'parked-arrival', 'park', 'other',
] as const
export type DocumentLoadCaller = typeof DOCUMENT_LOAD_CALLERS[number]
export const DOCUMENT_LOAD_PHASES = ['attach', 'steady'] as const
export type DocumentLoadPhase = typeof DOCUMENT_LOAD_PHASES[number]

/** A load after the attach at least this slow (wall time, the storage read
 * included) is logged one by one; every load is counted. */
export const DOCUMENT_LOAD_LOG_MS = 20

const counts = new Map<string, number>()
const countKey = (phase: DocumentLoadPhase, caller: DocumentLoadCaller) => `${phase}|${caller}`

export function countDocumentLoad(phase: DocumentLoadPhase, caller: DocumentLoadCaller): void {
  const at = countKey(phase, caller)
  counts.set(at, (counts.get(at) ?? 0) + 1)
}

/** Since process start. */
export function documentLoadCount(phase: DocumentLoadPhase, caller: DocumentLoadCaller): number {
  return counts.get(countKey(phase, caller)) ?? 0
}

export function documentLoadMetricSamples(): MetricSample[] {
  return [{
    name: 'maplespire_read_model_document_loads_total',
    help: 'Documents the read-model projector had to load from storage (not resident), by the path that asked and '
      + 'whether during its attach or after; each is one synchronous Automerge.load on the event loop. Since process start.',
    type: 'counter',
    values: DOCUMENT_LOAD_PHASES.flatMap((phase) => DOCUMENT_LOAD_CALLERS.map((caller) => ({
      labels: { phase, caller },
      value: documentLoadCount(phase, caller),
    }))),
  }]
}
