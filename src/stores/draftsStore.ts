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
import * as api from '../lib/drafts/api'
import { useWorkspaceStore } from './workspaceStore'
import { CURRENT_VERSION_ID } from '../lib/automerge/workspace'

/**
 * Drafts state. A draft is a forked version edited in isolation; OPENING one is just
 * a workspace switch into its version id (so all edits flow to the draft's
 * own root — isolation is free). This store owns the drafts registry + create/status
 * actions; the active draft is derived from the workspace ref (see `activeDraftId`).
 */
interface DraftsStoreState {
  drafts: api.DraftInfo[]
  loading: boolean
  busy: boolean
  error: string | null
  /** The active draft's computed 3-way changes (null until loaded / no active draft). */
  changes: api.DraftChanges | null
  /** The draft id `changes` was computed for (guards against stale results racing). */
  changesFor: string | null
  /** Load a landscape's drafts. */
  load: (landscapeId: string) => Promise<void>
  /** Create a draft off the landscape's default version and OPEN it. */
  create: (landscapeId: string, label: string) => Promise<api.DraftInfo | null>
  /** Open (switch into) an existing draft. */
  open: (draft: api.DraftInfo) => Promise<void>
  /** Change a draft's lifecycle status (archive / delete / restore). */
  setStatus: (landscapeId: string, draftId: string, status: api.DraftStatus) => Promise<void>
  /** Recompute the active draft's changes (server 3-way diff). Debounced by callers. */
  loadChanges: (landscapeId: string, draftId: string) => Promise<void>
  /** Merge the draft into the live model, applying optional per-conflict resolutions.
   * On success, leaves the draft for the live workspace; on conflicts, refreshes changes. */
  merge: (
    landscapeId: string,
    draftId: string,
    resolutions?: Record<string, api.ConflictResolution>
  ) => Promise<api.MergeResult>
  /** Clear changes (e.g. on exiting a draft). */
  clearChanges: () => void
  /** Clear the last error message. */
  clearError: () => void
  /** The id of the draft the workspace is currently switched into, if any. */
  activeDraftId: () => string | null
}

// Monotonic token so the LATEST-issued changes request wins even if an earlier one
// resolves later (fast draft switches, or the dropdown's open-load racing the debounced load).
let changesReqSeq = 0

export const useDraftsStore = create<DraftsStoreState>((set, get) => ({
  drafts: [],
  loading: false,
  busy: false,
  error: null,
  changes: null,
  changesFor: null,

  load: async (landscapeId) => {
    set({ loading: true, error: null })
    try {
      set({ drafts: await api.listDrafts(landscapeId), loading: false })
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
    }
  },

  create: async (landscapeId, label) => {
    if (!label.trim() || get().busy) return null
    set({ busy: true, error: null })
    try {
      const draft = await api.createDraft(landscapeId, label)
      await get().load(landscapeId)
      // Open it: switch the live workspace into the draft's version root.
      await useWorkspaceStore.getState().switchTo(landscapeId, draft.id)
      set({ busy: false })
      return draft
    } catch (err) {
      set({ busy: false, error: (err as Error).message })
      return null
    }
  },

  open: async (draft) => {
    if (get().busy) return
    set({ busy: true, error: null })
    try {
      await useWorkspaceStore.getState().switchTo(draft.landscapeId, draft.id)
      set({ busy: false })
    } catch (err) {
      set({ busy: false, error: (err as Error).message })
    }
  },

  setStatus: async (landscapeId, draftId, status) => {
    if (get().busy) return
    set({ busy: true, error: null })
    try {
      await api.setDraftStatus(landscapeId, draftId, status)
      await get().load(landscapeId)
      set({ busy: false })
    } catch (err) {
      set({ busy: false, error: (err as Error).message })
    }
  },

  loadChanges: async (landscapeId, draftId) => {
    const my = ++changesReqSeq
    try {
      const changes = await api.getDraftChanges(landscapeId, draftId)
      // Commit only if (a) this is still the latest-issued request (so an older response
      // can't clobber a newer one for the same draft) and (b) the workspace is still on
      // this draft (so a result from a previous draft can't leak in after a switch).
      const ref = useWorkspaceStore.getState().ref
      if (my === changesReqSeq && ref.versionId === draftId && ref.landscapeId === landscapeId) {
        set({ changes, changesFor: draftId })
      }
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  merge: async (landscapeId, draftId, resolutions = {}) => {
    if (get().busy) return { ok: false, conflicts: [] }
    set({ busy: true, error: null })
    try {
      const result = await api.mergeDraft(landscapeId, draftId, resolutions)
      if (result.ok) {
        await get().load(landscapeId) // status → merged
        // Leave the draft for the live workspace (which now carries the merged changes).
        await useWorkspaceStore.getState().switchTo(landscapeId, CURRENT_VERSION_ID)
        set({ busy: false, changes: null, changesFor: null })
      } else {
        await get().loadChanges(landscapeId, draftId) // surface the blocking conflicts
        // A non-conflict rejection (e.g. the base version moved, or a server error) has no
        // conflict rows — surface its message so the modal can show why merge was refused.
        set({ busy: false, error: result.conflicts.length === 0 ? result.error ?? null : null })
      }
      return result
    } catch (err) {
      set({ busy: false, error: (err as Error).message })
      return { ok: false, conflicts: [] }
    }
  },

  clearChanges: () => set({ changes: null, changesFor: null }),
  clearError: () => set({ error: null }),

  activeDraftId: () => {
    const ref = useWorkspaceStore.getState().ref
    const d = get().drafts.find((x) => x.id === ref.versionId && x.landscapeId === ref.landscapeId)
    return d ? d.id : null
  },
}))
