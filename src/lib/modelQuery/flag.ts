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
 * Model paging flag. OFF by default → the resident ModelQuery → zero behavior
 * change. Enabled by either the build-time `VITE_MODEL_PAGING=true` env or a
 * runtime localStorage toggle (so it can be flipped from the console without a
 * dev-server restart). Kept in its own module to avoid import cycles.
 *
 * The paging index (offlineIndex.ts) is namespaced PER WORKSPACE
 * (`${landscapeId}::${versionId}` key prefix), so this flag applies to every
 * workspace, not only the default one.
 */
const LS_KEY = 'maplespire:modelPaging'

export function isModelPagingEnabled(): boolean {
  if (import.meta.env.VITE_MODEL_PAGING === 'true') return true
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY) === 'true'
  } catch {
    return false
  }
}

/** Toggle the runtime flag and reload so the bridge rebuilds the index + the read
 * path switches. */
export function setModelPaging(on: boolean): void {
  try {
    localStorage.setItem(LS_KEY, String(on))
  } catch {
    /* ignore */
  }
  if (typeof location !== 'undefined') location.reload()
}

/**
 * Boot-from-server flag. When ON, the bridge boots WITHOUT loading the model
 * shards: it projects the active diagram from the server read model's
 * `/api/model/diagram-render` (objects + groups + connections incl. server-computed
 * lower roll-ups), so boot no longer materializes the whole model. Requires the
 * server to run with `READ_MODEL=on` (the render API) + `AM_SELECTIVE_SYNC=on` (so
 * the model shards aren't pushed) and the workspace sharded. The bounded window is
 * editable: model deltas are written to the current overlays while layout/comments
 * remain in the active DiagramDoc. Default off ⇒ the normal full-model boot.
 *
 * The diagram-render fetch carries the active workspace's `landscapeId`/
 * `versionId` (see `workspaceParams.ts`), and the server's `ro_*` tables are keyed
 * per workspace, so a non-default landscape/version boots from ITS OWN server render.
 */
const BOOT_FROM_SERVER_LS_KEY = 'maplespire:bootFromServer'

export function isBootFromServerEnabled(): boolean {
  if (import.meta.env.VITE_BOOT_FROM_SERVER === 'true') return true
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(BOOT_FROM_SERVER_LS_KEY) === 'true'
  } catch {
    return false
  }
}

export function setBootFromServer(on: boolean): void {
  try {
    localStorage.setItem(BOOT_FROM_SERVER_LS_KEY, String(on))
  } catch {
    /* ignore */
  }
  if (typeof location !== 'undefined') location.reload()
}
