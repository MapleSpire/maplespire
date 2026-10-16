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

import { create } from 'zustand'

export type AutomergeStatus = 'connecting' | 'saving' | 'ready' | 'offline' | 'error'

/**
 * WHAT THE BADGE MAY SAY WHILE A ROUTED READ IS BEING RETRIED.
 *
 * `status` is a DURABILITY latch — it answers "are my writes saved", and during
 * a workspace move between sync cells the answer is legitimately yes: nothing
 * is unsaved, the reads are simply being refused with `503 {retryable: true}`
 * while the new owner warms up. So `status` alone would say "Synced" over a page
 * that is mid-retry and has no data.
 *
 * A retry in flight is not a durability debt, which is why this does NOT join
 * `pendingDurabilityDebts` — putting it there would make a read stall
 * indistinguishable from an unsaved edit, and that sum's whole purpose is to be
 * exactly the set of things that block "Synced".
 *
 * It is instead a separate, narrower claim: the client is currently waiting on
 * the server, so 'ready' is downgraded to 'saving' (spinner, "Synchronisation…").
 * Every other status already tells a truer story than a retry would — 'offline',
 * 'error' and 'connecting' are not improved by this — so only 'ready' moves.
 */
export function effectiveSyncStatus(status: AutomergeStatus, routedRetriesInFlight: number): AutomergeStatus {
  return status === 'ready' && routedRetriesInFlight > 0 ? 'saving' : status
}

interface AutomergeStatusState {
  status: AutomergeStatus
  /** True once the first projection has landed — the app has data to show.
   * Stays true across later offline/online transitions. */
  ready: boolean
  /** The active diagram has enough bounded data for its first canvas frame. */
  visualReady: boolean
  /** The active DiagramDoc is attached and persistent editing can be enabled. */
  editReady: boolean
  /**
   * `workspaceRefKey` of the workspace whose bridge session has FINISHED booting —
   * documents attached, store projected and subscribed, writes durable from here on.
   * Null while a switch is in flight and after the bridge stops.
   *
   * Exists because `ready` cannot answer "is THIS workspace loaded?". `ready` is a
   * global durability latch with no workspace identity, so it is satisfied by ANY
   * workspace that reaches 'ready' — including the previous one being re-booted by a
   * mid-switch route bounce — and on a brand-new landscape, whose freshly created
   * documents PostgreSQL has not acknowledged yet, it stays false indefinitely
   * (`durableConnectionStatus` reports 'saving'). Anything that must write into a
   * SPECIFIC workspace waits on this, never on `ready`.
   */
  projectedWorkspace: string | null
  error: string | null
  /**
   * True while THIS session serves the cached-root boot fallback: the server
   * did not materialize the workspace in time and the bridge re-entered from
   * the last locally materialized root (startBridge's catch). The sync badge
   * surfaces it as a title detail so the detour is visible. Nothing
   * is persisted about the detour, so a reload retries the server and the
   * marker resets with the page.
   */
  bootFallbackActive: boolean
  /**
   * True once the active workspace's BOOT CONTRACT changed under a live session:
   * a classic (resident-registry) session whose root was promoted to the summary
   * contract. The bridge freezes that session's registry reconciliation and the
   * app shows a reload banner — the whole bridge state is built on the contract
   * decided at boot, so the only honest way into the new one is a fresh boot.
   * Not persisted: the reload clears it with the page.
   */
  workspaceContractStale: boolean
  /**
   * Set when a repoint moved the landscape's default version under this tab and
   * the tab was HELD on the concrete version it was already editing, rather than
   * carried to the new one (carrying it would discard whatever was unsaved).
   *
   * `pinnedVersionId` is where the TRANSPORT was pointed. The ref itself is
   * untouched and still says `'current'`, so the banner's condition is "still on
   * the alias, in this landscape" — any real move away hides it without a rule
   * to forget. Nothing here is persisted: a reload ends the hold on its own.
   */
  workspaceRepointNotice: { landscapeId: string; pinnedVersionId: string } | null
  /**
   * Bumped each time the sync transport comes BACK (not connected → connected).
   *
   * `status` cannot answer "did we just reconnect": it is a durability latch,
   * and a failed durable-heads acknowledgement sets 'saving' while the backend is
   * still down (the browser being online), so an edge into ready|saving fires
   * during the outage and none fires on the real reconnect. Consumers that must
   * re-read what they could not read offline key on this instead.
   */
  transportEpoch: number
  /** The bridge saw the transport go from down to up. */
  noteTransportRestored: () => void
  setStatus: (status: AutomergeStatus, error?: string | null) => void
  setBootFallbackActive: (active: boolean) => void
  /** The bridge saw the workspace contract change mid-session — ask for a reload. */
  markWorkspaceContractStale: () => void
  /** The transport was held on `versionId` because the landscape's default moved. */
  noteWorkspacePinnedAfterRepoint: (workspace: { landscapeId: string; versionId: string }) => void
  /** The user acknowledged the notice. */
  dismissWorkspaceRepointNotice: () => void
  /**
   * A bridge session ended (`stopBridge`), so the marker it left belongs to a
   * session that no longer exists.
   *
   * This is NOT redundant with `beginWorkspaceSwitch`: that one is
   * called from `switchWorkspace` only, while `AutomergeBridge` stops and
   * re-boots the bridge on any change of [config, loading, user, orgId] — an
   * org switch, an auth refresh. Without this the banner would survive a re-boot
   * that had already entered the NEW contract correctly, asking the user to
   * reload a session that was never stale.
   */
  clearWorkspaceContractStale: () => void
  beginDiagramOpen: () => void
  markVisualReady: () => void
  markEditReady: () => void
  /** The named workspace is booted and safe to write into. */
  markWorkspaceProjected: (workspaceKey: string) => void
  /** The bridge is down (stopped or failed) — no workspace is projected. */
  clearWorkspaceProjection: () => void
  /** Re-arm the loading gate for an EXPLICIT workspace switch (landscape/version
   * change): unlike a connection blip — where `ready` must stay latched so the app
   * keeps working offline — a switch replaces the whole model, so views must show
   * loading (and block edits) until the NEW workspace's first projection lands. */
  beginWorkspaceSwitch: () => void
}

/** Tiny store reflecting the Automerge bridge lifecycle + live connection state,
 * so views can show a loading state until the first projection lands and the
 * bottom bar can reflect synced/offline. */
export const useAutomergeStatus = create<AutomergeStatusState>((set) => ({
  status: 'connecting',
  ready: false,
  visualReady: false,
  editReady: false,
  projectedWorkspace: null,
  error: null,
  bootFallbackActive: false,
  workspaceContractStale: false,
  workspaceRepointNotice: null,
  transportEpoch: 0,
  noteTransportRestored: () => set((prev) => ({ transportEpoch: prev.transportEpoch + 1 })),
  setStatus: (status, error = null) =>
    // `ready` latches on once we've projected; it never drops back to false when
    // the connection blips (the app keeps working offline against local data).
    set((prev) => ({ status, ready: prev.ready || status === 'ready', error })),
  setBootFallbackActive: (active) => set({ bootFallbackActive: active }),
  markWorkspaceContractStale: () => set({ workspaceContractStale: true }),
  clearWorkspaceContractStale: () => set({ workspaceContractStale: false }),
  noteWorkspacePinnedAfterRepoint: (workspace) => set({
    workspaceRepointNotice: {
      landscapeId: workspace.landscapeId,
      pinnedVersionId: workspace.versionId,
    },
  }),
  dismissWorkspaceRepointNotice: () => set({ workspaceRepointNotice: null }),
  beginDiagramOpen: () => set({ visualReady: false, editReady: false }),
  markVisualReady: () => set({ visualReady: true }),
  // Editing implies that a visual projection can be displayed as well. Keeping
  // this invariant here gives classic workspaces the same readiness contract.
  markEditReady: () => set({ visualReady: true, editReady: true }),
  markWorkspaceProjected: (workspaceKey) => set({ projectedWorkspace: workspaceKey }),
  clearWorkspaceProjection: () => set({ projectedWorkspace: null }),
  beginWorkspaceSwitch: () => set({
    status: 'connecting',
    ready: false,
    visualReady: false,
    editReady: false,
    projectedWorkspace: null,
    error: null,
    bootFallbackActive: false,
    // A switch re-boots the bridge, so the next session decides its own
    // contract; carrying the stale marker across would ask for a reload the new
    // workspace does not need.
    workspaceContractStale: false,
  }),
}))
