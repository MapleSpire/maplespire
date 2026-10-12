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

import type { ModelMeta } from './types'

/**
 * Version of the bounded write-head protocol. Historical overlay segments are
 * immutable input to the server read model; an interactive client resolves only
 * the current, small write head. A missing version denotes a legacy head whose
 * Automerge history may be arbitrarily large, so it must be rotated without
 * being materialized in the browser.
 *
 * This is the RULING copy: `planBfsWriteMode` and `planOverlayWriteHeads` below
 * are what actually decide current-vs-legacy for a running client. The server
 * keeps a second one in `server/src/modelMeta.ts` because it cannot import this
 * file (`rootDir: ./src`), and `overlayWriteHead.conformance.test.ts` asserts
 * the two are equal — bump one without the other and that test goes red.
 */
export const OVERLAY_WRITE_HEAD_VERSION = 1

export interface OverlayWriteHeadPlan {
  migrateLegacy: boolean
  objectUrl?: string
  connectionUrl?: string
  historicalObjectSegments: number
  historicalConnectionSegments: number
}

export function planOverlayWriteHeads(
  meta: Pick<
    ModelMeta,
    | 'editsOverlayWriteHeadVersion'
    | 'editsObjectShardUrl'
    | 'editsObjectShardUrls'
    | 'editsConnectionShardUrl'
    | 'editsConnectionShardUrls'
  >,
  isValidUrl: (url: string) => boolean,
  allowLegacyRotation = true,
): OverlayWriteHeadPlan {
  const objectUrls = (meta.editsObjectShardUrls ?? []).filter(isValidUrl)
  const connectionUrls = (meta.editsConnectionShardUrls ?? []).filter(isValidUrl)
  const objectUrl = meta.editsObjectShardUrl
  const connectionUrl = meta.editsConnectionShardUrl
  const currentObjectUrl = objectUrl && isValidUrl(objectUrl) ? objectUrl : undefined
  const currentConnectionUrl = connectionUrl && isValidUrl(connectionUrl) ? connectionUrl : undefined
  const legacy = meta.editsOverlayWriteHeadVersion !== OVERLAY_WRITE_HEAD_VERSION
  const migrateLegacy = legacy && allowLegacyRotation

  return {
    migrateLegacy,
    objectUrl: migrateLegacy ? undefined : currentObjectUrl,
    connectionUrl: migrateLegacy ? undefined : currentConnectionUrl,
    historicalObjectSegments: objectUrls.filter((url) => url !== currentObjectUrl).length,
    historicalConnectionSegments: connectionUrls.filter((url) => url !== currentConnectionUrl).length,
  }
}

export type BfsWriteMode =
  | { mode: 'bfs' }
  | { mode: 'bfs-degraded'; reason: string }
  | { mode: 'resident-fallback'; reason: string }

/**
 * Decide, at boot, whether boot-from-server is SAFE to enter for this ModelMeta.
 *
 * `bfs`: both overlay write heads are valid and the write-head protocol version
 * is current — the ordinary case.
 *
 * `resident-fallback`: the write path is unusable AND the overlay provably holds
 * nothing (no heads, no bounded segments, no pending tombstones). Booting
 * resident is then LOSSLESS — the base shards are the whole model — and every
 * edit is durable immediately through the resident write path, which needs no
 * heads. This is the shape of a born-broken workspace (fsck `model-write-head`).
 *
 * `bfs-degraded`: the write path is unusable but the overlay MAY hold content
 * (segments listed, tombstones pending, or a legacy-version head). Two hazards
 * rule the resident fallback out there: meta tombstones are NOT filtered by
 * resident projection (deleted entities would resurrect on screen), and an
 * overlay segment absent from the base-shard lists is not read at all (server
 * maintenance pushes heads into the base lists, but nothing guarantees every
 * listed segment is; a value living only there would silently vanish). Stay on
 * boot-from-server: reads keep coming from the server render (a projection of
 * the durable overlay), writes camp in the crash journal with an accurate sync
 * badge, and a server repair drains them live. A stricter analysis could widen
 * the fallback (head-last ordering makes the base-list merge
 * overlay-last-wins); this stays conservative.
 *
 * A head that is a NON-EMPTY but invalid string also lands in `bfs-degraded`,
 * on purpose: it may be the typo of a real document, and "provably empty" must
 * stay literal.
 */
export function planBfsWriteMode(
  meta: Pick<
    ModelMeta,
    | 'editsOverlayWriteHeadVersion'
    | 'editsObjectShardUrl'
    | 'editsObjectShardUrls'
    | 'editsConnectionShardUrl'
    | 'editsConnectionShardUrls'
    | 'deletedObjectIds'
    | 'deletedConnectionIds'
  >,
  isValidUrl: (url: string) => boolean,
): BfsWriteMode {
  const objectHead = meta.editsObjectShardUrl && isValidUrl(meta.editsObjectShardUrl)
  const connectionHead = meta.editsConnectionShardUrl && isValidUrl(meta.editsConnectionShardUrl)
  const versionCurrent = meta.editsOverlayWriteHeadVersion === OVERLAY_WRITE_HEAD_VERSION
  if (objectHead && connectionHead && versionCurrent) return { mode: 'bfs' }
  const overlayProvablyEmpty =
    !meta.editsObjectShardUrl
    && !meta.editsConnectionShardUrl
    && (meta.editsObjectShardUrls ?? []).length === 0
    && (meta.editsConnectionShardUrls ?? []).length === 0
    && (meta.deletedObjectIds ?? []).length === 0
    && (meta.deletedConnectionIds ?? []).length === 0
  if (overlayProvablyEmpty) {
    return { mode: 'resident-fallback', reason: 'no overlay write heads and no overlay content' }
  }
  return {
    mode: 'bfs-degraded',
    reason: !versionCurrent && (objectHead || connectionHead)
      ? 'legacy write-head version'
      : 'write heads unusable but overlay content may exist',
  }
}

export function shouldRotateOverlayWriteHead(input: {
  entryCount: number
  pendingNewIds: number
  durableBatchCount: number
  limit: number
}): boolean {
  return input.durableBatchCount >= input.limit
    || input.entryCount >= input.limit
    || input.entryCount + input.pendingNewIds > input.limit
}
