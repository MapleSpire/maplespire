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

import { preferInitialDiagram, startBridge, stopBridge } from './bridge'
import { forgetWorkspace, routeWorkspaceNetwork } from './repo'
import { holdWorkspaceOn } from './workspaceBinding'
import { setActiveWorkspaceRef, workspaceRefEquals, currentWorkspaceRef, type WorkspaceRef } from './workspace'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { useAuthStore } from '../../stores/authStore'
import { workspaceAccess } from '../auth/api'
import { resetWorkspaceProjection } from './workspaceProjection'

/**
 * Switching the live workspace to a different (landscapeId, versionId): tear the
 * bridge down, clear the resident store so no stale data flashes, drop the ref's
 * cached IN-MEMORY root/model promises (a `'current'` ref is a moving pointer —
 * set-default repoints it; the PERSISTED offline root url is deliberately kept —
 * deleting it here would disarm the offline/cached-root boot fallback on every
 * in-app switch, and it only ever names the last MATERIALIZED root anyway),
 * point `currentWorkspaceRef()` at the new ref, then restart the bridge.
 *
 * Switches are SERIALIZED through one chain so a fast double-switch can't interleave
 * two stop/start cycles (which would race the bridge's module state).
 */
let chain: Promise<void> = Promise.resolve()

function serialize(work: () => Promise<void>): Promise<void> {
  chain = chain.then(work, work)
  return chain
}

async function loadWorkspace(ref: WorkspaceRef, openDiagramId?: string, preferDiagram = false): Promise<void> {
  const t0 = import.meta.env.DEV ? performance.now() : 0
  // A real (re)load ENDS any transport hold, by definition: the hold exists to
  // keep a live session on the version it was editing, and this is the session
  // ending. Cleared here rather than at the two call sites so a third one cannot
  // forget — and before anything else, so the boot's own root fetch and HTTP
  // reads address the ref being loaded rather than the one just left.
  holdWorkspaceOn(null)
  // Re-arm the loading gate BEFORE tearing down: the whole model is being replaced,
  // so views must block interaction (e.g. canvas drops) until the new workspace's
  // first projection lands — otherwise a drag in the empty-store window silently
  // no-ops. startBridge() sets 'ready' again when the projection is in.
  useAutomergeStatus.getState().beginWorkspaceSwitch()
  stopBridge()
  // Park the deep-linked diagram id (if any) across the reset instead of nulling it,
  // so the bridge's default-diagram pick (`currentDiagramId ?? default`) keeps it —
  // a switch driven by opening /app/landscape/…/diagram/X lands on X, not the
  // workspace's default diagram.
  resetWorkspaceProjection(openDiagramId ?? null)
  // …unless the park is only a preference (stay on the diagram the user was
  // viewing when it exists in the target version) — see preferInitialDiagram.
  preferInitialDiagram(preferDiagram ? openDiagramId ?? null : null)
  forgetWorkspace(ref)
  setActiveWorkspaceRef(ref)
  // A concrete workspace change gets a new routed socket; a reload of the
  // moving `current` pointer must also force a reconnect even though its ref is
  // textually unchanged.
  await routeWorkspaceNetwork(ref, true)
  await refreshWorkspaceReadOnly(ref)
  await startBridge(ref)
  if (import.meta.env.DEV) {
    console.info(`[switchWorkspace] ${ref.landscapeId}/${ref.versionId} in ${Math.round(performance.now() - t0)}ms`)
  }
}

/** Re-resolve the session's write access for the workspace being loaded and
 * lock/unlock the editor accordingly (a user can be an editor on one landscape
 * and a viewer on another). Stage 'off' / signed-out sessions always unlock —
 * mirrors AutomergeBridge's boot-time resolution. UX only; the server's write
 * gates enforce regardless. */
async function refreshWorkspaceReadOnly(ref: WorkspaceRef): Promise<void> {
  const auth = useAuthStore.getState()
  if (auth.config?.stage === 'off' || !auth.user) {
    useModelStore.getState().setWorkspaceReadOnly(false)
    return
  }
  const access = await workspaceAccess(ref.landscapeId, ref.versionId)
  useModelStore.getState().setWorkspaceReadOnly(access.enforced && !access.canWrite)
}

/** Switch to a different workspace ref. No-op if already there. `openDiagramId`
 * parks a deep-linked diagram so the switch lands on it (see loadWorkspace);
 * with `preferDiagram` it lands there only when the target version has it,
 * and on the default diagram otherwise. */
export function switchWorkspace(
  ref: WorkspaceRef,
  openDiagramId?: string,
  opts?: { preferDiagram?: boolean },
): Promise<void> {
  if (workspaceRefEquals(ref, currentWorkspaceRef())) return Promise.resolve()
  return serialize(() => loadWorkspace(ref, openDiagramId, opts?.preferDiagram ?? false))
}

/** Force-reload the CURRENT workspace (e.g. after set-default moves what a
 * `'current'` ref resolves to). Unlike switchWorkspace it doesn't early-return on
 * an unchanged ref — it always re-resolves the root and re-projects. */
export function reloadWorkspace(): Promise<void> {
  return serialize(() => loadWorkspace(currentWorkspaceRef()))
}
