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

import { preferInitialDiagram, startBridge, stopBridge, takeStoppedSessionDurableDebt } from './bridge'
import { drainOutgoingWorkspace } from './workspaceSwitchDrain'
import { forgetWorkspace, hasConnectedSyncPeer, routeWorkspaceNetwork, serverKnownHeads } from './repo'
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
/** The destination of the last switch asked and not yet loaded (null when
 * none is queued), and the number of that request. */
let pendingTarget: WorkspaceRef | null = null
let switchRequests = 0

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
  // T-DIAGDEF-2: the destination's access is ASKED now, beside the drain
  // below (both bounded at 3 s: `WORKSPACE_ACCESS_TIMEOUT_MS`,
  // `WORKSPACE_SWITCH_DRAIN_MS`), and applied where it always was, before the
  // bridge starts. In series, a server that accepts and never answers made
  // the two waits add up; before the access probe had a bound at all, it held
  // the switch for good.
  const applyReadOnly = askWorkspaceReadOnly(ref)
  // T-DIAGDEF: the stop's lifecycle flush has just written the
  // session's last edits (a not-open diagram's delete, still in the write
  // debounce) into its documents. They leave on the OUTGOING socket before the
  // route moves — bounded; past the bound the persisted ledger re-presents
  // them when this workspace is opened again (`workspaceSwitchDrain.ts`).
  // No peer on the outgoing transport answers at once; a
  // drain whose answers and server heads stop moving ends at the stall bound.
  const drained = await drainOutgoingWorkspace(takeStoppedSessionDurableDebt(), {
    connected: hasConnectedSyncPeer,
    serverHeads: serverKnownHeads,
  })
  if (drained.outcome !== 'nothing-owed' && drained.outcome !== 'durable') {
    console.warn(`[switchWorkspace] ${drained.pending} document(s) of the workspace left are not durable yet (${drained.outcome}); `
      + 'they are re-presented when it is opened again')
  }
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
  await applyReadOnly()
  await startBridge(ref)
  if (import.meta.env.DEV) {
    console.info(`[switchWorkspace] ${ref.landscapeId}/${ref.versionId} in ${Math.round(performance.now() - t0)}ms`)
  }
}

/** Ask, now, the session's write access for the workspace being loaded: is
 * the editor to be locked (a user can be an editor on one landscape and a
 * viewer on another)? Stage 'off' / signed-out sessions always unlock —
 * mirrors AutomergeBridge's boot-time resolution. UX only; the server's write
 * gates enforce regardless. Returns the step that APPLIES it, before the
 * bridge starts: never rejects, bounded (`workspaceAccess` fails open at its
 * patience).
 *
 * A LATE answer (after the patience, within the request's own bound) is kept
 * here, by THIS switch: applied by the step if it came first —
 * it used to be dropped when it arrived before the active ref moved, and
 * overwritten by the fail-open value when it arrived before the step — and
 * applied at once if it comes after, while the app is still on this switch's
 * workspace. Never for another identity than the one that asked. */
function askWorkspaceReadOnly(ref: WorkspaceRef): () => Promise<void> {
  const lock = (readOnly: boolean) => useModelStore.getState().setWorkspaceReadOnly(readOnly)
  const auth = useAuthStore.getState()
  if (auth.config?.stage === 'off' || !auth.user) return async () => { lock(false) }
  const identity = `${auth.user.id}\u0000${auth.orgId ?? ''}`
  const sameIdentity = () => {
    const now = useAuthStore.getState()
    return `${now.user?.id ?? ''}\u0000${now.orgId ?? ''}` === identity
  }
  let late: boolean | null = null
  let applied = false
  const early = workspaceAccess(ref.landscapeId, ref.versionId, {
    onLateAnswer: (answer) => {
      if (!sameIdentity()) return
      late = answer.enforced && !answer.canWrite
      if (applied && workspaceRefEquals(currentWorkspaceRef(), ref)) lock(late)
    },
  }).then((access) => access.enforced && !access.canWrite)
  return async () => {
    const value = await early
    // Asked for another identity than the one signed in now: no answer of
    // its holds — open, as for no answer at all.
    lock(sameIdentity() ? late ?? value : false)
    applied = true
  }
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
  // Judged against where the queue ENDS, not where the app is now. A load
  // drains the outgoing transport (up to 3 s) BEFORE it moves the active
  // ref, so during that drain the active ref
  // still names the workspace being LEFT: a return to it was taken for a no-op
  // (the app ended in B, the URL said A), and a second click on B queued a
  // second full reload of B.
  if (workspaceRefEquals(ref, pendingTarget ?? currentWorkspaceRef())) return pendingTarget ? chain : Promise.resolve()
  pendingTarget = ref
  const request = ++switchRequests
  const preferDiagram = opts?.preferDiagram ?? false
  const job = serialize(async () => {
    // Coalesced: a later switch was asked before this one started — only the
    // LAST destination is loaded.
    if (request !== switchRequests) return
    // The queue may already stand where this one leads (A→B→A, B skipped).
    if (workspaceRefEquals(ref, currentWorkspaceRef())) return
    await loadWorkspace(ref, openDiagramId, preferDiagram)
  })
  // Both settlements clear the target, and this side branch never rejects: a
  // failed load reaches the CALLER through `job`, not as an unhandled rejection.
  const settled = () => { if (request === switchRequests) pendingTarget = null }
  job.then(settled, settled)
  return job
}

/** Force-reload the CURRENT workspace (e.g. after set-default moves what a
 * `'current'` ref resolves to). Unlike switchWorkspace it doesn't early-return on
 * an unchanged ref — it always re-resolves the root and re-projects. */
export function reloadWorkspace(): Promise<void> {
  return serialize(() => loadWorkspace(currentWorkspaceRef()))
}
