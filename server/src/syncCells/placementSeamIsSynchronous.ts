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
 * THE PLACEMENT SEAM IS SYNCHRONOUS, PROVED BY THE TYPE.
 *
 * Design rule: the placement read stays synchronous, served from an in-memory
 * cache refreshed by notification and level reconciliation. This file makes a
 * violation of that rule a build failure rather than something remembered.
 *
 * ## Why a TYPE and not a test
 *
 * A test pins the sites it names; a type pins every site that has to satisfy
 * it, including ones written later.
 *
 * It must be a build failure rather than a red test: `tsc -b` compiles
 * `server/src/**` with test files excluded, and vitest's transpiler does not
 * typecheck at all, so an assertion in a `.test.ts` would never be checked.
 * This file is ordinary source. If any pinned seam starts returning a
 * `Promise`, `npm run build` fails.
 *
 * ## What breaks the build, exactly
 *
 * `SynchronousOnly<F>` resolves to `never` when `F`'s return type is a promise,
 * and a function is not assignable to `never`. The failure message therefore
 * names the seam, because each pin is its own declaration.
 *
 * ## The pinned seams
 *
 * They are the seams a request travels through to answer "does this cell speak
 * for this workspace", and every one of them is called from a path with no
 * `await` available to it:
 *
 *   - `workspacePartition` — the hash itself, called per routing decision.
 *   - `PlacementResolver.partitionOf` and the coordinator's `partitionFor` —
 *     the stored placement and its caller, both read from memory.
 *   - `partitionProbeOrder` — derived from the same topology, called at boot and
 *     on every partition probe.
 *   - `SyncCellOwnershipCoordinator.owns` — consulted by the storage fence and
 *     by `ProjectorFleet.ensure`'s admission callback, both of which are
 *     synchronous predicates by construction.
 *   - `SyncCellOwnershipCoordinator.fencingToken` — read INSIDE the transaction
 *     that writes with it, where an await would widen the race window between
 *     reading the token and writing under it.
 *
 * A `workspace_placement` lookup that had to await would be a different design
 * decision, and this file is where that has to be argued rather than
 * discovered.
 */

import { partitionProbeOrder, workspacePartition } from './assignment.js'
import { hashPlacementResolver, SyncCellOwnershipCoordinator, type PlacementResolver } from './ownership.js'
import { placementDivergence } from './placementDivergence.js'

/**
 * `F` unless it returns a promise, in which case `never` — and nothing is
 * assignable to `never`.
 *
 * `PromiseLike`, not `Promise`: a thenable that is not a `Promise` still forces
 * the caller to await, which is the property being pinned. Checking only
 * `Promise` would let a hand-rolled thenable through, and "it compiled" would
 * then be the reason nobody looked.
 */
type SynchronousOnly<F extends (...args: never[]) => unknown> =
  ReturnType<F> extends PromiseLike<unknown> ? never : F

/**
 * One declaration per seam, so the compiler names the one that broke.
 *
 * `void`-marked rather than exported: these exist to be TYPECHECKED, not
 * called, and exporting them would invite a runtime consumer that made the pins
 * look like an API.
 */
const placementReadIsSynchronous: SynchronousOnly<typeof workspacePartition> = workspacePartition
const storedPlacementReadIsSynchronous: SynchronousOnly<PlacementResolver['partitionOf']> =
  hashPlacementResolver.partitionOf
const coordinatorPartitionReadIsSynchronous: SynchronousOnly<SyncCellOwnershipCoordinator['partitionFor']> =
  SyncCellOwnershipCoordinator.prototype.partitionFor
const probeOrderIsSynchronous: SynchronousOnly<typeof partitionProbeOrder> = partitionProbeOrder
const divergenceReadIsSynchronous: SynchronousOnly<typeof placementDivergence> = placementDivergence
const ownershipReadIsSynchronous: SynchronousOnly<SyncCellOwnershipCoordinator['owns']> =
  SyncCellOwnershipCoordinator.prototype.owns
const fencingTokenReadIsSynchronous: SynchronousOnly<SyncCellOwnershipCoordinator['fencingToken']> =
  SyncCellOwnershipCoordinator.prototype.fencingToken

/**
 * THE CONTROL, and it is what stops this file from being decorative.
 *
 * Every pin above is a positive assertion, and a positive assertion is
 * satisfied by a `SynchronousOnly` that resolves to `F` unconditionally — a
 * broken helper would typecheck exactly as well as a working one, for ever,
 * with the build green. So the NEGATIVE case is asserted too: an asynchronous
 * function must resolve to `never`, and `never` is assignable to anything, so
 * the check has to be made in the direction that can fail.
 *
 * `@ts-expect-error` is the assertion: it fails the build when the line it
 * guards does NOT error, which is precisely "the helper stopped rejecting a
 * promise". Written against a local async function so the control cannot be
 * disarmed by a change to any real seam.
 */
declare function anAsyncSeam(workspace: string): Promise<number>
// @ts-expect-error — an async seam must NOT satisfy SynchronousOnly. If this
// line ever compiles cleanly, `SynchronousOnly` has stopped discriminating and
// every pin above became decoration.
const _controlRejectsAnAsyncSeam: SynchronousOnly<typeof anAsyncSeam> = anAsyncSeam

void placementReadIsSynchronous
void storedPlacementReadIsSynchronous
void coordinatorPartitionReadIsSynchronous
void probeOrderIsSynchronous
void divergenceReadIsSynchronous
void ownershipReadIsSynchronous
void fencingTokenReadIsSynchronous
void _controlRejectsAnAsyncSeam
