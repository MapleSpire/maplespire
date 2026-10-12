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

import { describe, it, expect } from 'vitest'
import { generateAutomergeUrl, isValidAutomergeUrl } from '@automerge/automerge-repo'
import {
  OVERLAY_WRITE_HEAD_VERSION as browserVersion,
  planBfsWriteMode,
  planOverlayWriteHeads,
} from './overlayWriteHead'
import {
  OVERLAY_WRITE_HEAD_VERSION as serverVersion,
  buildModelMeta,
} from '../../../server/src/modelMeta.js'

/**
 * The bounded write-head protocol version exists TWICE — once here, once in
 * `server/src/modelMeta.ts`. A comment saying one "mirrors" the other cannot
 * notice an edit; this test can.
 *
 * WHY A TEST AND NOT A DERIVATION. `export const A = B` is the better remedy
 * where it is available, and here it is not: `server/tsconfig.json` sets
 * `rootDir: ./src`, so the server importing `../../src/lib/automerge/...`
 * fails the build outright, and widening that `rootDir` is a trap of its
 * own. The reverse direction — this root vitest run
 * importing server source — is the one that works, which is why the assertion
 * lives on this side. Same shape, and the same reasoning, as
 * `documentResolution.conformance.test.ts` next door.
 *
 * WHY THE DIVERGENCE IS SILENT WITHOUT IT, in both directions:
 *
 *  - bump the SERVER's alone and `buildModelMeta` starts stamping a number this
 *    module's `planBfsWriteMode` reads as legacy, so every freshly seeded
 *    workspace boots `bfs-degraded` — writes camp in the crash journal instead
 *    of flowing, on a workspace that is in fact perfectly healthy;
 *  - bump THIS one alone and every meta already written reads as legacy to the
 *    client while `workspaceFsck` — which derives its threshold from the server
 *    copy — keeps certifying them clean. The one checker built to catch this
 *    agrees with nobody.
 *
 * Neither shows up as a crash, a log line, or a red test anywhere else. That is
 * the whole reason for this file.
 */
// GENERATED, never hand-written (the rule
// `server/src/maintenance/workspaceFsck.test.ts`'s header states). Hand-typed ids can be INVALID automerge urls and still pass here,
// because every case below stubs the validator with `() => true`; the first
// test guards against that.
const OBJECT_HEAD = generateAutomergeUrl()
const CONNECTION_HEAD = generateAutomergeUrl()

const currentMeta = () => buildModelMeta({
  objectWriteHead: OBJECT_HEAD,
  connectionWriteHead: CONNECTION_HEAD,
})

describe('overlay write-head protocol version — client/server conformance', () => {
  it('builds its fixtures from REAL automerge ids', () => {
    // The guard that keeps the stub honest. Without it, every `() => true` below
    // is unfalsifiable about url shape and the fixtures can rot into nonsense.
    expect(isValidAutomergeUrl(OBJECT_HEAD)).toBe(true)
    expect(isValidAutomergeUrl(CONNECTION_HEAD)).toBe(true)
    const meta = currentMeta()
    expect(isValidAutomergeUrl(meta.editsObjectShardUrl)).toBe(true)
    expect(isValidAutomergeUrl(meta.editsConnectionShardUrl)).toBe(true)
  })

  it('is the same number on both sides', () => {
    // THIS row is deliberately value-free: what it asserts is that the two
    // AGREE, at whatever number. The literal `1` is pinned separately, in the
    // last case of this file, because agreement and migration are two different
    // obligations and folding them into one assertion loses whichever the
    // reader is not thinking about.
    expect(serverVersion).toBe(browserVersion)
  })

  it('is the shape `planBfsWriteMode` calls current, when built by the server constructor', () => {
    // The equality above is necessary and not sufficient: it would still hold if
    // both were 2 while `buildModelMeta` stamped a hardcoded 1. So run the
    // server's own constructor output through the client's own decision.
    const meta = currentMeta()
    const mode = planBfsWriteMode(meta, () => true)
    expect(mode.mode).toBe('bfs')
  })

  it('rejects a meta one version behind, so the check above cannot pass vacuously', () => {
    // Without this row the previous test proves only that SOME meta boots `bfs`.
    // A `planBfsWriteMode` that ignored the version field entirely would pass it.
    const meta = currentMeta()
    const stale = { ...meta, editsOverlayWriteHeadVersion: serverVersion - 1 }
    expect(planBfsWriteMode(stale, () => true).mode).toBe('bfs-degraded')
  })

  it('is the shape the WRITE path calls current, not only the boot path', () => {
    // Both constants' comments name `planBfsWriteMode` AND `planOverlayWriteHeads`
    // as the deciders. They are currently redundant (same field, same
    // operator); they are separately claimed, so they are separately asserted. `planBfsWriteMode` is boot-only;
    // `planOverlayWriteHeads` is what the write path consults to set
    // `migrateLegacy`.
    const meta = currentMeta()
    expect(planOverlayWriteHeads(meta, () => true).migrateLegacy).toBe(false)
    const stale = { ...meta, editsOverlayWriteHeadVersion: serverVersion - 1 }
    expect(planOverlayWriteHeads(stale, () => true).migrateLegacy).toBe(true)
  })

  it('is still 1 — a DELIBERATE literal, and the only one left in the tree', () => {
    // Read this before "fixing" the red.
    //
    // Every other fixture and assertion touching this field now derives from the
    // constants, which is right for detecting DRIFT between the two copies and
    // wrong for the other job: `editsOverlayWriteHeadVersion` is written into
    // every ModelMeta in every database, so bumping both constants together is
    // a DATA MIGRATION. Without this line a coordinated bump of both constants
    // is 100 % green — a silent failure on exactly the axis that matters.
    //
    // What a bump actually costs, none of it at build time: every existing
    // workspace reads legacy, so `planBfsWriteMode` returns `bfs-degraded` and
    // writes camp in the crash journal; `workspaceFsck` rates each one
    // `data-loss`; and `promoteSummaryWorkspace` gates on `fsck.status`, so
    // summary promotion stops fleet-wide.
    //
    // So this is not a value to update — it is a checklist to discharge. Bump
    // both constants, migrate the durable metas with
    // `server/scripts/repair-overlay-heads.ts`, and only then move this number.
    expect(browserVersion).toBe(1)
  })
})
