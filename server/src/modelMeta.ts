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
 * The ONE way to build a ModelMeta.
 *
 * A ModelMeta reachable from a workspace root MUST carry a durable object AND
 * connection overlay write head. Under boot-from-server those overlay shards are
 * the only durable home for objects and connections (`flushWrite`'s `diagramOnly`
 * branch), so a ModelMeta without them accepts every edit in the UI and persists
 * none of it — the diagrams come back after a reload and every shape is gone.
 *
 * The fields are OPTIONAL in the client's `ModelMeta` interface (an older
 * contract let the browser mint the head on first edit, and the type still says
 * "Absent until the first edit creates it"), so TypeScript accepts an object
 * literal that is missing them.
 *
 * Hence a smart constructor: the two heads are REQUIRED parameters. Forgetting
 * them is a compile error rather than a workspace that silently eats edits.
 * If you are adding a path that constructs a ModelMeta, call this. There is no
 * other legal way — see `workspaceFsck.ts`, which fails a workspace that has one
 * built any other way.
 *
 * ⚠ THIS FILE IS COMPILED BY THE CLIENT'S TSCONFIG TOO.
 * `overlayWriteHead.conformance.test.ts` imports it, that test lives under
 * `tsconfig.app.json`'s
 * `include: ["src"]`, and `tsc -b` therefore pulls this file into the APP
 * program — confirmed with `--listFiles`. So `erasableSyntaxOnly`,
 * `verbatimModuleSyntax` and `noUnusedLocals` apply here: an enum, a namespace,
 * or a constructor parameter property added below breaks `npm run build` at the
 * ROOT, with an error pointing at a server file. Keep it plain. Same note, same
 * reason, as `readModel/documentResolution.ts`.
 */

/**
 * Bounded write-head protocol version.
 *
 * The client owns the RULING copy — `src/lib/automerge/overlayWriteHead.ts`,
 * whose `planBfsWriteMode` and `planOverlayWriteHeads` compare a meta against it
 * to decide "current" vs "legacy head needing rotation". This one exists because
 * the server cannot import that file: `server/tsconfig.json` sets
 * `rootDir: ./src`, so a `../../src/...` import fails the build outright.
 *
 * The two copies must stay equal; what enforces that:
 *
 *  - `src/lib/automerge/overlayWriteHead.conformance.test.ts` imports BOTH
 *    constants into one root vitest run and asserts they are equal. It lives on
 *    the ROOT side because `tsconfig.app.json` has `include: ["src"]`, so `tsc`
 *    typechecks it and pulls this file into the app program; server test files
 *    are excluded from BOTH server tsconfigs, so the mirror-image test would be
 *    typechecked by nothing.
 *  - `workspaceFsck.ts` derives its `write-head-version` threshold from this
 *    constant rather than restating `1`, and `workspaceFsck.test.ts` runs
 *    `buildModelMeta`'s own output through the checker, so a re-hardcoded
 *    literal in EITHER of those two goes red.
 *  - `modelMeta.test.ts` pins this constant on the SERVER side, because every
 *    other server assertion derives from it — so without that pin a lone
 *    server bump leaves the whole server job green and
 *    detection rests entirely on a root-run file the server job cannot see.
 *
 * Scoped deliberately, because "producer and detector cannot disagree" would be
 * too wide: `buildModelMeta`, the fsck detector, `overlaySegments`, `compaction`
 * and `controlMeta` are asserted on this field. `staticDeltaProjector`'s
 * rotation republish is NOT — its `.change()` sits inside a private method that
 * needs a live PoolClient and an open transaction, so a direct edit of that one
 * line is not caught by the suite. Routing it through this constant still defeats
 * bump-and-forget by construction; what is uncovered is a direct edit there.
 *
 * ⚠ BUMPING THIS IS A DATA MIGRATION, NOT A TWO-LINE EDIT — and the tests will
 * NOT stop you, by construction. Every fixture and assertion in the tree now
 * derives from these constants, so bumping both together is 100 % green while
 * every ModelMeta already in every database still holds the OLD number. Three
 * things then fire at once, none of them at build time:
 *   - `planBfsWriteMode` reads every existing workspace as legacy and returns
 *     `bfs-degraded` — writes camp in the crash journal fleet-wide;
 *   - `workspaceFsck.ts`'s checker rates each of them `data-loss`;
 *   - `promoteSummaryWorkspace` gates on `fsck.status !== 'clean'`, so summary
 *     promotion stops for the whole fleet.
 * So: bump both constants, migrate the durable metas with
 * `server/scripts/repair-overlay-heads.ts` (which already stamps this constant),
 * and expect `overlayWriteHead.conformance.test.ts` to go red on its deliberate
 * `toBe(1)` pin — that pin exists precisely so a bump cannot be quiet.
 */
export const OVERLAY_WRITE_HEAD_VERSION = 1

export interface ModelMetaSeed {
  /** Base object shards. The write head must be the LAST entry, so the read
   * model overlays it last-wins. `buildModelMeta` appends it if it is absent. */
  objectShardUrls?: readonly string[]
  connectionShardUrls?: readonly string[]
  /** Required. The durable document every object edit is written into. */
  objectWriteHead: string
  /** Required. Its connection counterpart. */
  connectionWriteHead: string
  /** Resident small collections; default empty. */
  groups?: Record<string, unknown>
  domains?: Record<string, unknown>
  tagSnapshots?: Record<string, unknown>
  decisionRecords?: Record<string, unknown>
}

export interface BuiltModelMeta {
  objectShardUrls: string[]
  connectionShardUrls: string[]
  editsObjectShardUrl: string
  editsObjectShardUrls: string[]
  editsConnectionShardUrl: string
  editsConnectionShardUrls: string[]
  editsOverlayWriteHeadVersion: number
  groups: Record<string, unknown>
  domains: Record<string, unknown>
  tagSnapshots: Record<string, unknown>
  decisionRecords: Record<string, unknown>
  deletedObjectIds: string[]
  deletedConnectionIds: string[]
  deletedDecisionRecordIds: string[]
  deletedDiagramIds: string[]
}

/** Keep the write head last in its base-shard list — `forkRoot.remapModelMeta`
 * remaps the head by its POSITION in that array and yields `undefined` when the
 * head is not found there, so a head kept outside the list is silently lost by a
 * fork. That coupling is why this is done here and not left to each caller. */
function withHeadLast(shardUrls: readonly string[] | undefined, head: string): string[] {
  const base = (shardUrls ?? []).filter((url) => url !== head)
  return [...base, head]
}

export function buildModelMeta(seed: ModelMetaSeed): BuiltModelMeta {
  if (!seed.objectWriteHead || !seed.connectionWriteHead) {
    // Defence for JS callers and for a `as any` at a boundary; TypeScript already
    // refuses the omission.
    throw new Error('buildModelMeta requires both overlay write heads')
  }
  return {
    objectShardUrls: withHeadLast(seed.objectShardUrls, seed.objectWriteHead),
    connectionShardUrls: withHeadLast(seed.connectionShardUrls, seed.connectionWriteHead),
    editsObjectShardUrl: seed.objectWriteHead,
    editsObjectShardUrls: [seed.objectWriteHead],
    editsConnectionShardUrl: seed.connectionWriteHead,
    editsConnectionShardUrls: [seed.connectionWriteHead],
    editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION,
    groups: seed.groups ?? {},
    domains: seed.domains ?? {},
    tagSnapshots: seed.tagSnapshots ?? {},
    decisionRecords: seed.decisionRecords ?? {},
    // The tombstone lists exist from birth. Every reader treats an absent list
    // as empty, but every WRITER created it lazily on the first delete — and two
    // peers deleting concurrently on a meta without it each create their own
    // list under one key, which Automerge resolves by hiding one of them, its
    // tombstones with it (the deleted entity comes back). Created here, there is
    // one list from the start and concurrent pushes merge. Measured in
    // modelMeta.test.ts "two peers creating a tombstone list lazily": 1 of 2
    // tombstones survives lazy creation, 2 of 2 survive this one.
    deletedObjectIds: [],
    deletedConnectionIds: [],
    deletedDecisionRecordIds: [],
    deletedDiagramIds: [],
  }
}
