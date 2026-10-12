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
import { currentWorkspaceRef, workspaceRefEquals, CURRENT_VERSION_ID, type WorkspaceRef } from '../lib/automerge/workspace'
import { switchWorkspace, reloadWorkspace } from '../lib/automerge/switchWorkspace'
import { navigateToWorkspaceRef } from '../lib/appNavigate'
import { useModelStore } from './modelStore'
import * as api from '../lib/landscapes/api'

/** A brand-new (non-forked) workspace starts with ZERO diagrams, but the editor
 * lands the user on the canvas — which looks editable while every drop silently
 * no-ops because nothing is bound. Give the new workspace one blank starter
 * diagram so it is immediately usable. (Fork/duplicate flows carry their own
 * diagrams and never hit this.) */
function seedStarterDiagram(): void {
  const s = useModelStore.getState()
  if (s.diagrams.length > 0) return
  const id = s.addDiagram({
    name: 'New context diagram',
    type: 'context',
    objectIds: [],
    connectionIds: [],
    groupIds: [],
  })
  s.setCurrentDiagram(id)
}

/**
 * Multi-landscape state: the registry of landscapes/versions, the
 * active ref, and the actions that switch between them or mutate the registry.
 * Switching tears down + restarts the Automerge bridge against the new root.
 */
interface WorkspaceStoreState {
  ref: WorkspaceRef
  /** True once the authenticated boot ref has been resolved against the server
   * (bootRef.ts). Until then `ref` is the synchronous `default` PLACEHOLDER, and
   * workspace-scoped queries against it 403 at AUTH=on (the session can't see the
   * legacy Default Org). Stays `false` at AUTH=off, where `ref` is already the
   * genuine single-tenant workspace from mount — callers treat off as "ready". */
  bootResolved: boolean
  /** True once AutomergeBridge has completed its INITIAL boot (both auth stages) on
   * the URL-seeded/resolved ref. The route layer (WorkspaceRoute / RouteSync /
   * redirects) waits for this so it never drives a switch or emits a workspace URL
   * before the bridge has landed on the right ref — which would double-load it. */
  bridgeBooted: boolean
  landscapes: api.LandscapeInfo[]
  loading: boolean
  busy: boolean
  error: string | null
  /** Load the landscape/version registry. */
  load: () => Promise<void>
  /** Switch the live workspace to a landscape + version ('current' follows default).
   * `openDiagramId` parks a deep-linked diagram so the switch lands on it. Store-led
   * callers (menu, drafts) get a URL update; the URL-led caller (WorkspaceRoute)
   * passes `{ silent: true }` since the address bar already names the ref. */
  switchTo: (landscapeId: string, versionId: string, openDiagramId?: string, opts?: { silent?: boolean }) => Promise<void>
  /** Create a new landscape (fresh Main version) and switch into it. Resolves with the
   * ref it landed on, or null when nothing was created (blank name, busy, or a failure —
   * `error` then carries why). Callers that write into the new workspace must gate on
   * THIS ref, never on a global readiness flag. */
  newLandscape: (name: string) => Promise<WorkspaceRef | null>
  /** Add a version to a landscape and switch into it. Pass forkFromVersionId to
   * duplicate that version instead of starting empty. Resolves with the ref (see
   * newLandscape) or null. */
  newVersion: (landscapeId: string, label: string, forkFromVersionId?: string) => Promise<WorkspaceRef | null>
  /** Repoint a landscape's default version (removes nothing). */
  makeDefault: (landscapeId: string, versionId: string) => Promise<void>
  /** Rename a landscape. */
  renameLandscape: (id: string, name: string) => Promise<void>
  /** Rename a version. */
  renameVersion: (landscapeId: string, versionId: string, label: string) => Promise<void>
  /** Delete a landscape (server refuses the last one); switches away if it's active. */
  removeLandscape: (id: string) => Promise<void>
  /** Delete a version (server refuses the default/last one); switches away if active. */
  removeVersion: (landscapeId: string, versionId: string) => Promise<void>
}

export const useWorkspaceStore = create<WorkspaceStoreState>((set, get) => ({
  ref: currentWorkspaceRef(),
  bootResolved: false,
  bridgeBooted: false,
  landscapes: [],
  loading: false,
  busy: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null })
    try {
      set({ landscapes: await api.listLandscapes(), loading: false })
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
    }
  },

  switchTo: async (landscapeId, versionId, openDiagramId, opts) => {
    if (get().busy) return
    const before = currentWorkspaceRef()
    set({ busy: true, error: null })
    try {
      await switchWorkspace({ landscapeId, versionId }, openDiagramId)
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      // Store-led switch → move the URL to the new ref (else WorkspaceRoute reverts it).
      // Only when the ref actually changed and not for the URL-led caller.
      //
      // The navigation is AWAITED INSIDE the `busy` guard: WorkspaceRoute and RouteSync
      // both stand down while `busy` is true, and both compare the live
      // `currentWorkspaceRef()` (already the new one) against URL params that only catch
      // up when the router commits. Releasing `busy` first is what let WorkspaceRoute
      // switch the workspace straight back to the previous landscape.
      const after = currentWorkspaceRef()
      if (!opts?.silent && !workspaceRefEquals(before, after)) {
        await navigateToWorkspaceRef(after).catch(() => undefined)
      }
      // Always mirror the ACTUAL active workspace (set inside switchWorkspace before
      // the bridge starts), so the menu's per-landscape version list stays correct
      // even if the bridge restart hiccups.
      set({ busy: false, ref: after })
    }
  },

  newLandscape: async (name) => {
    if (!name.trim() || get().busy) return null
    set({ busy: true, error: null })
    try {
      const ls = await api.createLandscape(name)
      await get().load()
      // Enter the new landscape on its default version.
      await switchWorkspace({ landscapeId: ls.id, versionId: CURRENT_VERSION_ID })
      seedStarterDiagram()
      const ref: WorkspaceRef = { landscapeId: ls.id, versionId: CURRENT_VERSION_ID }
      // Move the address bar BEFORE releasing `busy` — see switchTo.
      await navigateToWorkspaceRef(ref).catch(() => undefined)
      set({ busy: false, ref })
      return ref
    } catch (err) {
      set({ busy: false, error: (err as Error).message })
      return null
    }
  },

  newVersion: async (landscapeId, label, forkFromVersionId) => {
    if (!label.trim() || get().busy) return null
    set({ busy: true, error: null })
    try {
      const version = await api.createVersion(landscapeId, label, forkFromVersionId)
      await get().load()
      // Open the brand-new version to work in it.
      await switchWorkspace({ landscapeId, versionId: version.id })
      // Only a from-scratch version starts empty; a fork carries its diagrams.
      if (!forkFromVersionId) seedStarterDiagram()
      const ref: WorkspaceRef = { landscapeId, versionId: version.id }
      await navigateToWorkspaceRef(ref).catch(() => undefined)
      set({ busy: false, ref })
      return ref
    } catch (err) {
      set({ busy: false, error: (err as Error).message })
      return null
    }
  },

  makeDefault: async (landscapeId, versionId) => {
    if (get().busy) return
    set({ busy: true, error: null })
    try {
      await api.setDefaultVersion(landscapeId, versionId)
      await get().load()
      // If we're following 'current' on this landscape, the default just moved —
      // re-resolve so the live view reflects the new default version.
      const ref = get().ref
      if (ref.landscapeId === landscapeId && ref.versionId === CURRENT_VERSION_ID) {
        await reloadWorkspace()
        // The default moved under us — the open diagram may have changed; re-point
        // the URL at the ref index so RouteSync re-appends the now-current diagram.
        await navigateToWorkspaceRef(ref).catch(() => undefined)
      }
      set({ busy: false })
    } catch (err) {
      set({ busy: false, error: (err as Error).message })
    }
  },

  renameLandscape: async (id, name) => {
    if (!name.trim() || get().busy) return
    set({ busy: true, error: null })
    try {
      await api.renameLandscape(id, name)
      await get().load()
      set({ busy: false })
    } catch (err) {
      set({ busy: false, error: (err as Error).message })
    }
  },

  renameVersion: async (landscapeId, versionId, label) => {
    if (!label.trim() || get().busy) return
    set({ busy: true, error: null })
    try {
      await api.renameVersion(landscapeId, versionId, label)
      await get().load()
      set({ busy: false })
    } catch (err) {
      set({ busy: false, error: (err as Error).message })
    }
  },

  removeLandscape: async (id) => {
    if (get().busy) return
    set({ busy: true, error: null })
    try {
      await api.deleteLandscape(id)
      await get().load()
      // If we just deleted the active landscape, move to a remaining one.
      if (get().ref.landscapeId === id) {
        const fallback = get().landscapes[0]
        if (fallback) {
          const newRef: WorkspaceRef = { landscapeId: fallback.id, versionId: CURRENT_VERSION_ID }
          await switchWorkspace(newRef)
          set({ ref: newRef })
          await navigateToWorkspaceRef(newRef).catch(() => undefined)
        }
      }
      set({ busy: false })
    } catch (err) {
      set({ busy: false, error: (err as Error).message })
    }
  },

  removeVersion: async (landscapeId, versionId) => {
    if (get().busy) return
    set({ busy: true, error: null })
    try {
      await api.deleteVersion(landscapeId, versionId)
      await get().load()
      // If we were pinned to the deleted version, follow the landscape default.
      if (get().ref.landscapeId === landscapeId && get().ref.versionId === versionId) {
        const newRef: WorkspaceRef = { landscapeId, versionId: CURRENT_VERSION_ID }
        await switchWorkspace(newRef)
        set({ ref: newRef })
        await navigateToWorkspaceRef(newRef).catch(() => undefined)
      }
      set({ busy: false })
    } catch (err) {
      set({ busy: false, error: (err as Error).message })
    }
  },
}))
