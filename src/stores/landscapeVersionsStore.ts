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
import { currentWorkspaceRef } from '../lib/automerge/workspace'
import { captureLandscapeManifest, restoreLandscapeManifest } from '../lib/automerge/landscapeVersions'
import * as api from '../lib/landscapeVersions/api'

/**
 * Orchestrates the landscape-version registry: capture the current workspace into a
 * named version, list versions, and restore one (auto-saving the current state
 * first so a restore is reversible). Capture/restore are the client-side
 * head-manifest operations; the API persists the manifest server-side.
 */
interface LandscapeVersionsState {
  versions: api.LandscapeVersionMeta[]
  loading: boolean
  busy: boolean
  error: string | null
  notice: string | null
  /** Load the version list for the current landscape. */
  load: () => Promise<void>
  /** Capture the current workspace as a new named version. */
  saveCurrent: (label: string) => Promise<void>
  /** Roll the whole landscape back to a saved version (auto-saves current first). */
  restore: (id: string) => Promise<void>
  /** Delete a saved version (does not touch the live workspace). */
  remove: (id: string) => Promise<void>
  clearNotice: () => void
}

export const useLandscapeVersionsStore = create<LandscapeVersionsState>((set, get) => ({
  versions: [],
  loading: false,
  busy: false,
  error: null,
  notice: null,

  load: async () => {
    set({ loading: true, error: null })
    try {
      const versions = await api.listVersions(currentWorkspaceRef().landscapeId)
      set({ versions, loading: false })
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
    }
  },

  saveCurrent: async (label) => {
    const trimmed = label.trim()
    if (!trimmed || get().busy) return
    const { landscapeId } = currentWorkspaceRef()
    set({ busy: true, error: null, notice: null })
    try {
      const manifest = await captureLandscapeManifest()
      await api.createVersion(landscapeId, trimmed, manifest)
      await get().load()
      set({ busy: false, notice: `Saved version “${trimmed}”.` })
    } catch (err) {
      set({ busy: false, error: (err as Error).message })
    }
  },

  restore: async (id) => {
    if (get().busy) return
    const { landscapeId } = currentWorkspaceRef()
    set({ busy: true, error: null, notice: null })
    try {
      const target = await api.getVersion(landscapeId, id)
      // Auto-save the current state first so restore is reversible.
      const before = await captureLandscapeManifest()
      await api.createVersion(
        landscapeId,
        `Auto-save before restoring “${target.label}”`,
        before,
        'auto'
      )
      const result = await restoreLandscapeManifest(target.manifest)
      await get().load()
      set({
        busy: false,
        notice:
          result.failed > 0
            ? `Restored “${target.label}” (${result.restored} docs, ${result.failed} unavailable).`
            : `Restored “${target.label}”.`,
      })
    } catch (err) {
      set({ busy: false, error: (err as Error).message })
    }
  },

  remove: async (id) => {
    if (get().busy) return
    const { landscapeId } = currentWorkspaceRef()
    set({ busy: true, error: null })
    try {
      await api.deleteVersion(landscapeId, id)
      await get().load()
      set({ busy: false })
    } catch (err) {
      set({ busy: false, error: (err as Error).message })
    }
  },

  clearNotice: () => set({ notice: null }),
}))
