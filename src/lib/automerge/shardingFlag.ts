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
 * Model-SHARDING flag. OFF by default → the monolithic ModelDoc path. Orthogonal to the model-PAGING flag
 * (`src/lib/modelQuery/flag.ts`): paging changes how cross-diagram queries READ;
 * sharding changes how the model DOC is stored and WRITTEN (an edit reconciles only
 * the affected shard, not the whole model). Enabled by build-time
 * `VITE_MODEL_SHARDING=true` or a runtime localStorage toggle (so it can be flipped
 * from the console — reloads so the bridge re-resolves handles). Kept in its own
 * module to avoid import cycles, mirroring the paging flag.
 */
const LS_KEY = 'maplespire:modelSharding'

export function isModelShardingEnabled(): boolean {
  if (import.meta.env.VITE_MODEL_SHARDING === 'true') return true
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY) === 'true'
  } catch {
    return false
  }
}

/** Toggle the runtime flag and reload so the bridge re-resolves the model handles
 * (and runs the one-time splitter when turning it on for the first time). */
export function setModelSharding(on: boolean): void {
  try {
    localStorage.setItem(LS_KEY, String(on))
  } catch {
    /* ignore */
  }
  if (typeof location !== 'undefined') location.reload()
}
