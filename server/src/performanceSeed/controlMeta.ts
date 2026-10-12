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

import { OVERLAY_WRITE_HEAD_VERSION } from '../modelMeta.js'

export interface PerformanceControlMetaInput extends Record<string, unknown> {
  objectShardUrls?: string[]
  connectionShardUrls?: string[]
  decisionRecordShardUrls?: string[]
  editsObjectShardUrl?: string
  editsObjectShardUrls?: string[]
  editsConnectionShardUrl?: string
  editsConnectionShardUrls?: string[]
  editsOverlayWriteHeadVersion?: number
  deletedObjectIds?: string[]
  deletedConnectionIds?: string[]
}

export interface PerformanceOverlaySnapshots {
  objects: ReadonlyMap<string, Record<string, unknown>>
  connections: ReadonlyMap<string, Record<string, unknown>>
}

export interface PerformanceOverlayPruneOptions {
  /** Tombstones matching this predicate are disposable load-harness state.
   * They are removed only when every retained overlay has an acknowledged
   * snapshot and none of those snapshots still contains the entity. */
  disposableObjectId?: (id: string) => boolean
}

function orderedOverlays(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function retainEffectiveOverlays(
  urls: readonly string[],
  currentUrl: string | undefined,
  tombstones: ReadonlySet<string>,
  snapshots: ReadonlyMap<string, Record<string, unknown>>,
): string[] {
  return urls.filter((url) => {
    if (url === currentUrl) return true
    const snapshot = snapshots.get(url)
    // A missing/unacknowledged snapshot is never safe to prune.
    if (!snapshot) return true
    return Object.keys(snapshot).some((id) => !tombstones.has(id))
  })
}

/** Fold acknowledged overlays in metadata order into one last-write-wins
 * snapshot. Returning null is a hard safety boundary: maintenance must retain
 * the original chain when even one source snapshot is unknown. */
export function materializeAcknowledgedOverlayState(
  urls: readonly string[],
  snapshots: ReadonlyMap<string, Record<string, unknown>>,
  tombstones: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (urls.some((url) => !snapshots.has(url))) return null
  const effective: Record<string, unknown> = {}
  for (const url of urls) Object.assign(effective, snapshots.get(url) ?? {})
  for (const id of tombstones) delete effective[id]
  return effective
}

/**
 * Remove only retired segments whose last acknowledged snapshot is empty or
 * completely masked by explicit ModelMeta tombstones. Their durable scope and
 * retention rows remain intact, so an offline writer can still reconnect and
 * be three-way-forwarded into the current head.
 */
export function pruneCoveredPerformanceOverlayHistory(
  source: PerformanceControlMetaInput,
  snapshots: PerformanceOverlaySnapshots,
  options: PerformanceOverlayPruneOptions = {},
): PerformanceControlMetaInput {
  const objectUrls = orderedOverlays([
    ...(source.editsObjectShardUrls ?? []), source.editsObjectShardUrl,
  ])
  const connectionUrls = orderedOverlays([
    ...(source.editsConnectionShardUrls ?? []), source.editsConnectionShardUrl,
  ])
  const keptObjects = retainEffectiveOverlays(
    objectUrls,
    source.editsObjectShardUrl,
    new Set(source.deletedObjectIds ?? []),
    snapshots.objects,
  )
  const keptConnections = retainEffectiveOverlays(
    connectionUrls,
    source.editsConnectionShardUrl,
    new Set(source.deletedConnectionIds ?? []),
    snapshots.connections,
  )
  let deletedObjectIds = source.deletedObjectIds
  if (
    options.disposableObjectId
    && keptObjects.every((url) => snapshots.objects.has(url))
  ) {
    const retainedObjectIds = new Set(
      keptObjects.flatMap((url) => Object.keys(snapshots.objects.get(url) ?? {})),
    )
    deletedObjectIds = (source.deletedObjectIds ?? []).filter((id) => (
      !options.disposableObjectId!(id) || retainedObjectIds.has(id)
    ))
  }
  return {
    ...source,
    objectShardUrls: keptObjects,
    connectionShardUrls: keptConnections,
    editsObjectShardUrls: keptObjects,
    editsConnectionShardUrls: keptConnections,
    deletedObjectIds,
  }
}

/** Keep only bounded control state in Automerge; the immutable performance
 * baseline is already authoritative in PostgreSQL. */
export function toPerformanceControlMeta(
  source: PerformanceControlMetaInput,
): PerformanceControlMetaInput {
  const objectOverlays = orderedOverlays([
    ...(source.editsObjectShardUrls ?? []),
    source.editsObjectShardUrl,
  ])
  const connectionOverlays = orderedOverlays([
    ...(source.editsConnectionShardUrls ?? []),
    source.editsConnectionShardUrl,
  ])
  const plain = JSON.parse(JSON.stringify(source)) as PerformanceControlMetaInput
  return {
    ...plain,
    staticBaseline: true,
    objectShardUrls: objectOverlays,
    connectionShardUrls: connectionOverlays,
    decisionRecordShardUrls: [],
    editsObjectShardUrls: objectOverlays,
    editsConnectionShardUrls: connectionOverlays,
    editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION,
    ...(objectOverlays.length > 0
      ? { editsObjectShardUrl: objectOverlays[objectOverlays.length - 1] }
      : {}),
    ...(connectionOverlays.length > 0
      ? { editsConnectionShardUrl: connectionOverlays[connectionOverlays.length - 1] }
      : {}),
  }
}
