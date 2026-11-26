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
 * THE RETIRED-EPOCH EXPORT (G4-16f, the hop's retired path): the held epoch's
 * documents are past retention, so nothing will forward what this tab wrote
 * into them. Before the swap, the hop collects every entity the LOCAL copies
 * of the retired documents hold that differs from the new epoch's value
 * (or that the new epoch lacks), and the `epoch-retired` banner offers them
 * as a JSON export. There is no automatic re-apply: without the cut base no
 * sound three-way merge exists, so "differs" includes other users' later
 * edits — the export is the user's own judgement call, labelled as such.
 *
 * Pure: plain JSON in, plain JSON out (the bridge hands it `doc()` values).
 */
export type RetiredEntityKind = 'object' | 'connection' | 'group' | 'domain' | 'tag' | 'decisionRecord'

export interface RetiredEntityDifference {
  kind: RetiredEntityKind
  id: string
  /** This tab's copy, from the retired document. */
  local: unknown
  /** The new epoch's value; `null` when the new epoch does not hold it. */
  current: unknown
  /** The tab could not read the
   * new epoch's base shards (boot-from-server holds none), so `current` was
   * not compared — `null` then means "not known here", never "absent". */
  currentUnknown?: true
}

export interface RetiredExport {
  version: 1
  metaUrl: string
  collectedAt: string
  differences: RetiredEntityDifference[]
}

type Collection = Record<string, unknown> | undefined

const META_COLLECTIONS: Array<[string, RetiredEntityKind]> = [
  ['groups', 'group'], ['domains', 'domain'], ['tagSnapshots', 'tag'], ['decisionRecords', 'decisionRecord'],
]

const plain = (value: unknown): unknown => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

function diffCollection(kind: RetiredEntityKind, local: Collection, current: Collection, out: RetiredEntityDifference[], unknown = false): void {
  if (!local || typeof local !== 'object' || Array.isArray(local)) return
  for (const [id, value] of Object.entries(local)) {
    const localValue = plain(value)
    if (unknown) { out.push({ kind, id, local: localValue, current: null, currentUnknown: true }); continue }
    const currentValue = current && typeof current === 'object' && id in current ? plain(current[id]) : null
    if (JSON.stringify(localValue) !== JSON.stringify(currentValue)) out.push({ kind, id, local: localValue, current: currentValue })
  }
}

export interface RetiredDiffInput {
  /** The retired documents' local copies, by role. */
  retiredMeta?: Record<string, unknown> | null
  retiredObjectShards: ReadonlyArray<{ objects?: Collection } | undefined | null>
  retiredConnectionShards: ReadonlyArray<{ connections?: Collection } | undefined | null>
  /** The new epoch, merged (resident) — or empty when the tab holds no base shards. */
  current: { meta?: Record<string, unknown> | null; objects: Record<string, unknown>; connections: Record<string, unknown> }
  /** The tab holds none of the new epoch's base shards (boot-from-server):
   * every object and connection of the retired shards is listed, marked
   * `currentUnknown`, instead of being called absent from the new epoch. */
  currentShardsUnknown?: boolean
}

export function collectRetiredDifferences(input: RetiredDiffInput): RetiredEntityDifference[] {
  const out: RetiredEntityDifference[] = []
  const unknown = input.currentShardsUnknown === true
  for (const shard of input.retiredObjectShards) diffCollection('object', shard?.objects, input.current.objects, out, unknown)
  for (const shard of input.retiredConnectionShards) diffCollection('connection', shard?.connections, input.current.connections, out, unknown)
  if (input.retiredMeta) {
    for (const [key, kind] of META_COLLECTIONS) {
      diffCollection(kind, input.retiredMeta[key] as Collection, (input.current.meta?.[key] as Collection) ?? undefined, out)
    }
  }
  return out
}

/** The export file's text: stable, indented JSON. */
export function retiredExportText(exported: RetiredExport): string {
  return `${JSON.stringify(exported, null, 2)}\n`
}
