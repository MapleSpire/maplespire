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
 * The `write_fence` value an `epoch:resolve-repointing` run holds while it
 * runs (`modelEpochResolveGuard.ts`). Its own module, free of imports, so the
 * sync-cell ownership coordinator (`syncCells/ownership.ts`, `persistLease`)
 * can refuse a lease under it without pulling in the epoch machinery.
 *
 * Never cleared by hand: re-run the CLI, which finishes or refuses and then
 * moves the fence to {@link EPOCH_RESOLVE_DONE_PREFIX}.
 */
export const EPOCH_RESOLVE_FENCE_PREFIX = 'maintenance:epoch-resolve-repointing:'
/** The fence once a run has ended: unique per run, never the active prefix. */
export const EPOCH_RESOLVE_DONE_PREFIX = 'maintenance:epoch-resolve-done:'

export const isActiveEpochResolveFence = (fence: string | null | undefined): fence is string =>
  typeof fence === 'string' && fence.startsWith(EPOCH_RESOLVE_FENCE_PREFIX)
