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

import { useEffect, useRef } from 'react'
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import { useUIStore } from '../stores/uiStore'
import { useModelStore } from '../stores/modelStore'
import { useWorkspaceStore } from '../stores/workspaceStore'
import { readUrlWorkspaceRef } from '../lib/automerge/urlRef'
import { popHold } from './routeSyncTarget'

/**
 * Mirrors editor navigation state into the URL:
 *   `workspaceStore.ref` (landscape/version) + `uiStore.currentView` + `modelStore.currentDiagramId`
 *   → `/app/landscape/<lid>/version/<vid>/<view>[/diagram/<did>]`
 *
 * The stores stay the source of truth for what renders; this keeps the address bar in
 * sync so every view is deep-linkable and browser back/forward works. The reverse
 * direction (URL → store) lives in the route components (WorkspaceRoute drives the
 * workspace switch; the leaf routes drive the view + diagram). Both directions guard
 * with an equality check, so a change applied by one side is a no-op on the other —
 * there is no feedback loop. A legacy/bare `/app/*` path (no landscape segment) is
 * upgraded here with `replace`, preserving old bookmarks without a junk history entry.
 */
export function RouteSync() {
  const navigate = useNavigate()
  const router = useRouter()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const urlView = useRouterState({
    select: (s) => {
      const v = (s.location.search as Record<string, unknown>).view
      return v === '3d' ? '3d' : v === '2d' ? '2d' : undefined
    },
  })
  const currentView = useUIStore((s) => s.currentView)
  const canvasViewMode = useUIStore((s) => s.canvasViewMode)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const ref = useWorkspaceStore((s) => s.ref)
  const bridgeBooted = useWorkspaceStore((s) => s.bridgeBooted)
  const busy = useWorkspaceStore((s) => s.busy)

  /**
   * The pathname the user reached with Back / Forward, held until the store
   * catches up with it.
   *
   * Without this, browser Back does nothing at all. On a pop, the route
   * component applies URL → store in a sibling effect of the SAME commit, so the
   * effect below still holds the previous render's `currentDiagramId` and would
   * push the page the user just left — which also truncates the forward entry,
   * so Back looks inert rather than bouncy.
   */
  const poppedPath = useRef<string | null>(null)
  useEffect(() => router.history.subscribe(({ location, action }) => {
    const popped = action.type === 'BACK' || action.type === 'FORWARD' || action.type === 'GO'
    poppedPath.current = popped ? location.pathname : null
  }), [router])

  useEffect(() => {
    if (!pathname.startsWith('/app')) return
    // Don't emit a workspace URL until the bridge has booted on the real ref — before
    // that `ref` may still be the `default` placeholder (AUTH=on, pre-bootRef).
    if (!bridgeBooted) return
    // Don't emit mid-switch: while a workspace switch is in flight, `ref`,
    // `currentDiagramId` and the module active ref update at different ticks — acting
    // now would emit a URL for a half-applied state (e.g. the new version's diagram
    // under the old version's path). The switching action navigates when it settles.
    if (busy) return

    // If the path already names a DIFFERENT (landscape, version) than the live ref,
    // it's a pending switch or a forbidden deep-link that WorkspaceRoute owns — leave
    // the URL alone (rewriting it here would clobber the 403 / race the switch). We
    // only manage view/diagram WITHIN the live workspace, or upgrade a bare/legacy path.
    const urlTarget = readUrlWorkspaceRef(pathname)
    if (urlTarget) {
      if (urlTarget.ref.landscapeId !== ref.landscapeId || urlTarget.ref.versionId !== ref.versionId) return
    }

    const { landscapeId, versionId } = ref
    const base = { landscapeId, versionId }
    const wsPrefix = `/app/landscape/${landscapeId}/version/${versionId}`
    // A legacy/bare `/app/*` path (no landscape segment) is being upgraded to the
    // current ref — replace it rather than pushing a history entry.
    const upgrading = !urlTarget

    // Back / Forward: the URL is the intent, so stay silent until the route
    // components have brought the store to it (see popHold).
    const pop = popHold({
      pathname,
      poppedPath: poppedPath.current,
      state: { currentView, currentDiagramId, wsPrefix },
    })
    poppedPath.current = pop.poppedPath
    if (pop.hold) return

    switch (currentView) {
      case 'diagram': {
        // Before the bridge has opened a diagram there is no id to put in the URL.
        // Still upgrade a bare/legacy path to the versioned workspace index, so the
        // address bar always carries the workspace; the diagram is appended once it opens.
        if (!currentDiagramId) {
          if (upgrading && pathname !== wsPrefix) {
            navigate({ to: '/app/landscape/$landscapeId/version/$versionId', params: base, replace: true })
          }
          return
        }
        const desired = `${wsPrefix}/diagram/${currentDiagramId}`
        // Reflect the 2D/3D view into `?view=3d` (dropped in 2D) so the diagram
        // URL is a copyable deep link. A pure view flip (same path) replaces
        // rather than pushes, so toggling never spams browser history.
        const desiredView = canvasViewMode === '3d' ? '3d' : undefined
        const pathChanged = pathname !== desired
        if (pathChanged || urlView !== desiredView) {
          navigate({
            to: '/app/landscape/$landscapeId/version/$versionId/diagram/$diagramId',
            params: { ...base, diagramId: currentDiagramId },
            replace: upgrading || !pathChanged,
            search: desiredView ? { view: desiredView } : {},
          })
        }
        break
      }
      case 'diagrams':
        if (pathname !== `${wsPrefix}/diagrams`)
          navigate({ to: '/app/landscape/$landscapeId/version/$versionId/diagrams', params: base, replace: upgrading })
        break
      case 'model-objects':
        if (pathname !== `${wsPrefix}/model`)
          navigate({ to: '/app/landscape/$landscapeId/version/$versionId/model', params: base, replace: upgrading })
        break
      case 'model-viewer':
        if (pathname !== `${wsPrefix}/model-viewer`)
          navigate({ to: '/app/landscape/$landscapeId/version/$versionId/model-viewer', params: base, replace: upgrading })
        break
      case 'connections':
        if (pathname !== `${wsPrefix}/connections`)
          navigate({ to: '/app/landscape/$landscapeId/version/$versionId/connections', params: base, replace: upgrading })
        break
      case 'dependencies':
        if (pathname !== `${wsPrefix}/dependencies`)
          navigate({ to: '/app/landscape/$landscapeId/version/$versionId/dependencies', params: base, replace: upgrading })
        break
      case 'decision-records':
        if (pathname !== `${wsPrefix}/decision-records`)
          navigate({ to: '/app/landscape/$landscapeId/version/$versionId/decision-records', params: base, replace: upgrading })
        break
      case 'drafts':
        if (pathname !== `${wsPrefix}/drafts`)
          navigate({ to: '/app/landscape/$landscapeId/version/$versionId/drafts', params: base, replace: upgrading })
        break
    }
  }, [currentView, canvasViewMode, urlView, currentDiagramId, ref, bridgeBooted, busy, pathname, navigate])

  return null
}
