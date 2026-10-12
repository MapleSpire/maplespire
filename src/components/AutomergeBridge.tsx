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

import { useEffect } from 'react'
import { startBridge, stopBridge } from '../lib/automerge/bridge'
import { currentWorkspaceRef, setActiveWorkspaceRef } from '../lib/automerge/workspace'
import { resolveBootWorkspaceRef } from '../lib/automerge/bootRef'
import { readUrlWorkspaceRef } from '../lib/automerge/urlRef'
import { useAuthStore } from '../stores/authStore'
import { useModelStore } from '../stores/modelStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { workspaceAccess } from '../lib/auth/api'

/**
 * Mounts the Automerge bridge for the app session.
 * Starting it wires the Zustand store to the Automerge documents (real-time sync
 * + local persistence); stopping it tears the subscriptions down.
 *
 * Boot ref selection is stage-aware, and a deep-link URL
 * (`/app/landscape/<lid>/version/<vid>[/diagram/<did>]`) seeds it so a shared link
 * boots directly into its workspace + diagram (no boot-then-switch double-load):
 *   - stage 'off' (or config unreachable): the localStorage-persisted ref, no
 *     server round-trip — unless the URL carries a ref, which is applied verbatim.
 *   - stage 'dual'/'on': wait for the auth store to resolve the session, then
 *     resolve the ref against the org's landscape registry (bootRef.ts), preferring
 *     the URL ref when it's accessible so a stale/foreign persisted ref can never
 *     403-brick the boot.
 * `bridgeBooted` flips true once the initial start lands, gating the route layer.
 * Later switches go through switchWorkspace (stop → reset → start).
 */
export function AutomergeBridge() {
  const config = useAuthStore((s) => s.config)
  const loading = useAuthStore((s) => s.loading)
  const user = useAuthStore((s) => s.user)
  const orgId = useAuthStore((s) => s.orgId)

  useEffect(() => {
    // AuthBoot (root route) kicks off authStore.load(); wait for it so we know
    // the stage and the session's org before picking a workspace.
    if (config === null || loading) return

    // Deep-link workspace + diagram from the address bar (null on bare /app or a
    // legacy un-versioned path). Read once at boot; later nav goes through the
    // route layer + switchWorkspace.
    const urlTarget = readUrlWorkspaceRef(window.location.pathname)

    // Seed the deep-linked diagram BEFORE the bridge projects so its default-diagram
    // pick (`currentDiagramId ?? default`) lands on it instead of the workspace default.
    if (urlTarget?.diagramId) {
      useModelStore.setState({ currentDiagramId: urlTarget.diagramId })
    }

    if (config.stage === 'off') {
      if (urlTarget) setActiveWorkspaceRef(urlTarget.ref)
      useModelStore.getState().setWorkspaceReadOnly(false)
      void startBridge(currentWorkspaceRef()).then(() => {
        useWorkspaceStore.setState({ ref: currentWorkspaceRef(), bridgeBooted: true })
      })
      return () => {
        useWorkspaceStore.setState({ bridgeBooted: false })
        stopBridge()
      }
    }

    let cancelled = false
    void (async () => {
      const ref = await resolveBootWorkspaceRef(user ? orgId : null, urlTarget?.ref ?? null)
      if (cancelled) return
      // Lock the editor read-only when the session holds only a View grant on
      // this workspace AND the server enforces writes (stage 'on'). UX only —
      // the server's sync/REST write gates are the actual authority, so the
      // fail-open default inside workspaceAccess() is safe.
      const access = user ? await workspaceAccess(ref.landscapeId, ref.versionId) : null
      if (cancelled) return
      useModelStore.getState().setWorkspaceReadOnly(!!access && access.enforced && !access.canWrite)
      await startBridge(ref)
      if (cancelled) return
      useWorkspaceStore.setState({ bridgeBooted: true })
    })()
    return () => {
      cancelled = true
      useWorkspaceStore.setState({ bridgeBooted: false })
      stopBridge()
    }
  }, [config, loading, user, orgId])
  return null
}
