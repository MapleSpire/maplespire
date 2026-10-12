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

/* eslint-disable react-refresh/only-export-components --
   This is the route-tree config: route components live here alongside the
   `router` export by design, so fast-refresh's component-only rule doesn't apply. */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useNavigate,
  useParams,
  useRouterState,
} from '@tanstack/react-router'
import { Loader2, Lock } from 'lucide-react'
import { currentWorkspaceRef } from './lib/automerge/workspace'
import { useWorkspaceStore } from './stores/workspaceStore'
import { checkWorkspaceReadAccess } from './lib/auth/api'
import { setWorkspaceNavigator } from './lib/appNavigate'
import { Button } from './components/ui/button'
import { AppShell } from './components/layout/AppShell'
import { CanvasView } from './components/diagram/CanvasView'
import { ModelObjectsView } from './components/model-objects/ModelObjectsView'
import { ModelViewerView } from './components/model-viewer/ModelViewerView'
import { DiagramsListView } from './components/diagrams-list/DiagramsListView'
import { ConnectionsView } from './components/connections/ConnectionsView'
import { DependenciesView } from './components/dependencies/DependenciesView'
import { DecisionRecordsView } from './components/decision-records/DecisionRecordsView'
import { DraftsTable } from './components/drafts/DraftsTable'
import { ShareViewer } from './viewer/ShareViewer'
import { RouteSync } from './components/RouteSync'
import { LoginPage, SsoLoginPage } from './components/auth/LoginPage'
import { AuthCompletePage } from './components/auth/AuthCompletePage'
import { InvitePage } from './components/auth/InvitePage'
import { AdminShell } from './components/admin/AdminShell'
import { AdminOverview } from './components/admin/AdminOverview'
import { AdminMembers } from './components/admin/AdminMembers'
import { AdminTeams } from './components/admin/AdminTeams'
import { AdminAccess } from './components/admin/AdminAccess'
import { AdminAi } from './components/admin/AdminAi'
import { AdminTechnologies } from './components/admin/AdminTechnologies'
import { AdminSettings } from './components/admin/AdminSettings'
import { AdminTags } from './components/admin/AdminTags'
import { PlatformShell } from './components/platform/PlatformShell'
import { PlatformOverview } from './components/platform/PlatformOverview'
import { PlatformOrgs } from './components/platform/PlatformOrgs'
import { PlatformUsers } from './components/platform/PlatformUsers'
import { PlatformAudit } from './components/platform/PlatformAudit'
import { PlatformAccess } from './components/platform/PlatformAccess'
import { PlatformDebug } from './components/platform/PlatformDebug'
import { PlatformTechnologies } from './components/platform/PlatformTechnologies'
import { PlatformSettings } from './components/platform/PlatformSettings'
import { PlatformReferenceIntegrity } from './components/platform/PlatformReferenceIntegrity'
import { ImpersonationBanner } from './components/platform/ImpersonationBanner'
import { WorkspaceContractBanner } from './components/layout/WorkspaceContractBanner'
import { WorkspaceRepointBanner } from './components/layout/WorkspaceRepointBanner'
import { useUIStore, type AppView } from './stores/uiStore'
import { useModelStore } from './stores/modelStore'
import { useAuthStore } from './stores/authStore'

// ── URL → store sync ────────────────────────────────────────────────────────
// Each editor route writes its view (and diagram) into the stores on mount/param
// change. Guarded so re-applying an already-current value is a no-op (see RouteSync
// for the mirror in the other direction).

function useSyncView(view: AppView) {
  useEffect(() => {
    if (useUIStore.getState().currentView !== view) {
      useUIStore.getState().setCurrentView(view)
    }
  }, [view])
}

// ── route components ──────────────────────────────────────────────────────────

function LandingRoute() {
  const navigate = useNavigate()
  // The marketing site lives in its own repository (https://maplespire.ca);
  // the application root goes straight to the editor.
  useEffect(() => {
    navigate({ to: '/app', replace: true })
  }, [navigate])
  return null
}

function AppLayout() {
  return (
    <AppShell>
      <RouteSync />
      <Outlet />
    </AppShell>
  )
}

// ── Workspace-scoped routing (landscape/version in the URL) ────────────────────
// URLs carry the workspace: /app/landscape/<lid>/version/<vid>/<view>. The store
// stays the source of truth (RouteSync mirrors it → URL); these components drive the
// reverse direction (URL → store). `versionId` may be the literal 'current' sentinel
// (follow the landscape default) or a concrete version id — a draft is just a version
// with its own id, so no separate segment is needed.

const WS_ROUTE = '/app/landscape/$landscapeId/version/$versionId'

/** 403 page for a deep-link into a landscape/version the session can't read. */
function WorkspaceForbidden() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-app px-4">
      <div className="w-full max-w-[420px] rounded-xl border border-line bg-surface-100 p-8 text-center shadow-xl">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-surface-200 text-fg-secondary">
          <Lock className="h-5 w-5" />
        </div>
        <h1 data-testid="workspace-forbidden" className="mb-1.5 text-[16px] font-semibold text-fg">
          {t('workspace.forbiddenTitle')}
        </h1>
        <p className="mb-6 text-[13px] leading-relaxed text-fg-secondary">{t('workspace.forbiddenBody')}</p>
        <Button variant="secondary" size="lg" className="w-full justify-center" onClick={() => navigate({ to: '/app' })}>
          {t('workspace.forbiddenGoToApp')}
        </Button>
      </div>
    </div>
  )
}

/** The workspace layer: (1) enforces the deep-link access gate — a URL into a
 * landscape/version the session can't read renders a 403 (not the editor); and
 * (2) when access is granted and the URL names a DIFFERENT (landscape, version)
 * than the live one, switches to it (post-boot only — the initial boot already
 * landed on the URL ref, so this is a no-op then), parking a deep-linked diagram
 * id across the switch so it opens instead of the workspace default. */
function WorkspaceRoute() {
  const { landscapeId, versionId } = useParams({ from: WS_ROUTE })
  const { diagramId } = useParams({ strict: false })
  const bridgeBooted = useWorkspaceStore((s) => s.bridgeBooted)
  const busy = useWorkspaceStore((s) => s.busy)

  // Access gate — only enforced at AUTH stage 'on' with a session (mirrors the
  // server). Initialise synchronously so off/dual/signed-out never flash a loader.
  const [access, setAccess] = useState<'checking' | 'granted' | 'forbidden'>(() => {
    const a = useAuthStore.getState()
    return a.config?.stage === 'on' && a.user ? 'checking' : 'granted'
  })
  const authStage = useAuthStore((s) => s.config?.stage)
  const authUser = useAuthStore((s) => s.user)
  const authLoading = useAuthStore((s) => s.loading)

  useEffect(() => {
    if (authLoading) return
    if (authStage !== 'on' || !authUser) {
      setAccess('granted')
      return
    }
    let cancelled = false
    setAccess('checking')
    void checkWorkspaceReadAccess(landscapeId, versionId).then((r) => {
      // 'unknown' (offline / server error) → allow; the sync socket + REST gates
      // still enforce server-side, and this keeps offline deep-links working.
      if (!cancelled) setAccess(r === 'forbidden' ? 'forbidden' : 'granted')
    })
    return () => {
      cancelled = true
    }
  }, [authStage, authUser, authLoading, landscapeId, versionId])

  useEffect(() => {
    if (!bridgeBooted || busy || access !== 'granted') return
    const cur = currentWorkspaceRef()
    if (cur.landscapeId !== landscapeId || cur.versionId !== versionId) {
      // URL-led switch: the address bar already names this ref, so DON'T navigate
      // (that would strip the deep-linked diagram from the URL).
      void useWorkspaceStore.getState().switchTo(landscapeId, versionId, diagramId, { silent: true })
    }
  }, [bridgeBooted, busy, access, landscapeId, versionId, diagramId])

  if (access === 'forbidden') return <WorkspaceForbidden />
  if (access === 'checking') {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-app">
        <Loader2 className="h-5 w-5 animate-spin text-fg-secondary" />
      </div>
    )
  }
  return <Outlet />
}

function CanvasIndexRoute() {
  useSyncView('diagram')
  return <CanvasView />
}

function DiagramRoute() {
  const { diagramId } = useParams({ from: '/app/landscape/$landscapeId/version/$versionId/diagram/$diagramId' })
  useSyncView('diagram')
  useEffect(() => {
    if (diagramId && useModelStore.getState().currentDiagramId !== diagramId) {
      useModelStore.getState().setCurrentDiagram(diagramId)
    }
  }, [diagramId])
  return <CanvasView />
}

/** Legacy un-versioned diagram deep-link (`/app/diagram/x`): read the id from the OLD
 * path shape and drive the store; RouteSync then upgrades the URL to the versioned form
 * under the booted workspace. Static legacy views (`/app/model`, …) don't need this —
 * they render the same view components directly and RouteSync upgrades them. */
function LegacyDiagramRoute() {
  const { diagramId } = useParams({ from: '/app/diagram/$diagramId' })
  useSyncView('diagram')
  useEffect(() => {
    if (diagramId && useModelStore.getState().currentDiagramId !== diagramId) {
      useModelStore.getState().setCurrentDiagram(diagramId)
    }
  }, [diagramId])
  return <CanvasView />
}

function DiagramsRoute() {
  useSyncView('diagrams')
  return <DiagramsListView />
}

function ModelRoute() {
  useSyncView('model-objects')
  return <ModelObjectsView />
}

function ModelViewerRoute() {
  useSyncView('model-viewer')
  return <ModelViewerView />
}

function ConnectionsRoute() {
  useSyncView('connections')
  return <ConnectionsView />
}

function DependenciesRoute() {
  useSyncView('dependencies')
  return <DependenciesView />
}

function DecisionRecordsRoute() {
  useSyncView('decision-records')
  return <DecisionRecordsView />
}

function DraftsRoute() {
  useSyncView('drafts')
  return <DraftsTable />
}

function ShareRoute() {
  const { token } = useParams({ from: '/share/$token' })
  return <ShareViewer token={token} mode="standalone" />
}

function EmbedRoute() {
  const { token } = useParams({ from: '/embed/$token' })
  return <ShareViewer token={token} mode="embed" />
}

// Paths that stay reachable while signed out even when AUTH=on — the auth pages
// themselves, plus the read-only share/embed viewers (those authenticate via their
// own share token, not a session).
const AUTH_EXEMPT_PREFIXES = ['/login', '/auth/complete', '/invite/', '/share/', '/embed/']

function isAuthExempt(pathname: string): boolean {
  return AUTH_EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))
}

/** Loads auth config/session once on boot (mounted alongside the root Outlet) and,
 * only in stage 'on', forces signed-out visitors of non-exempt routes to /login.
 * Stage 'off' (default) and 'dual' never redirect — see docs/auth-setup.md. */
function AuthBoot() {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const load = useAuthStore((s) => s.load)
  const config = useAuthStore((s) => s.config)
  const user = useAuthStore((s) => s.user)
  const loading = useAuthStore((s) => s.loading)

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (loading || !config || config.stage !== 'on' || user) return
    if (isAuthExempt(pathname)) return
    navigate({ to: '/login', replace: true })
  }, [loading, config, user, pathname, navigate])

  return null
}

// ── route tree ────────────────────────────────────────────────────────────────

const rootRoute = createRootRoute({
  component: () => (
    <>
      <AuthBoot />
      <ImpersonationBanner />
      <WorkspaceContractBanner />
      <WorkspaceRepointBanner />
      <Outlet />
    </>
  ),
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: LandingRoute,
})

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'app',
  component: AppLayout,
})

// Bare /app → render the canvas; RouteSync upgrades the URL to the versioned form
// once the bridge has booted (so `to: '/app'` links and old bookmarks keep working).
const appIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: CanvasIndexRoute,
})

// The workspace layer: /app/landscape/$landscapeId/version/$versionId + its views.
const workspaceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'landscape/$landscapeId/version/$versionId',
  component: WorkspaceRoute,
})

const wsIndexRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/',
  component: CanvasIndexRoute,
})

const wsDiagramRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'diagram/$diagramId',
  component: DiagramRoute,
})

const wsDiagramsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'diagrams',
  component: DiagramsRoute,
})

const wsModelRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'model',
  component: ModelRoute,
})

const wsModelViewerRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'model-viewer',
  component: ModelViewerRoute,
})

const wsConnectionsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'connections',
  component: ConnectionsRoute,
})

const wsDependenciesRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'dependencies',
  component: DependenciesRoute,
})

const wsAdrRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'decision-records',
  component: DecisionRecordsRoute,
})

const wsDraftsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'drafts',
  component: DraftsRoute,
})

// ── Legacy un-versioned routes (back-compat) — render the same view components as
// the workspace subtree; each calls useSyncView, and RouteSync upgrades the bare
// `/app/*` URL to the versioned form under the booted workspace (with `replace`, so
// old bookmarks keep working without a junk history entry). Only the diagram path
// needs its own component (its id comes from the OLD param shape). ──────────────
const legacyDiagramRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'diagram/$diagramId',
  component: LegacyDiagramRoute,
})
const legacyDiagramsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'diagrams',
  component: DiagramsRoute,
})
const legacyModelRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'model',
  component: ModelRoute,
})
const legacyModelViewerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'model-viewer',
  component: ModelViewerRoute,
})
const legacyConnectionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'connections',
  component: ConnectionsRoute,
})
const legacyDependenciesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'dependencies',
  component: DependenciesRoute,
})
const legacyAdrRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'decision-records',
  component: DecisionRecordsRoute,
})
const legacyDraftsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'drafts',
  component: DraftsRoute,
})

const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'share/$token',
  component: ShareRoute,
})

const embedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'embed/$token',
  component: EmbedRoute,
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login',
  component: LoginPage,
})

// Isolated org-SSO login surface (docs/auth-setup.md "TWO ISOLATED SURFACES") —
// a full multi-segment path directly off rootRoute (like orgAdminRoute below),
// NOT nested under loginRoute: nesting would mount LoginPage's own component as
// chrome around this page (TanStack renders every matched ancestor), and
// LoginPage renders a complete card with no <Outlet/> — the two pages must be
// fully independent, not parent/child. '/login/sso' still matches
// AUTH_EXEMPT_PREFIXES' '/login' prefix check in AuthBoot with no extra entry.
const loginSsoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login/sso',
  component: SsoLoginPage,
})

const authCompleteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'auth/complete',
  component: AuthCompletePage,
})

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'invite/$token',
  component: InvitePage,
})

// ── Org Admin console ──
// Deliberately its OWN top-level surface under `/org/$orgId/admin`, NOT nested
// under `/app` — no canvas, no AppShell chrome. AdminShell owns the auth +
// org-admin guards and renders child routes via its own <Outlet/>.
const orgAdminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'org/$orgId/admin',
  component: AdminShell,
})

const orgAdminIndexRoute = createRoute({
  getParentRoute: () => orgAdminRoute,
  path: '/',
  component: AdminOverview,
})

const orgAdminMembersRoute = createRoute({
  getParentRoute: () => orgAdminRoute,
  path: 'members',
  component: AdminMembers,
})

const orgAdminTeamsRoute = createRoute({
  getParentRoute: () => orgAdminRoute,
  path: 'teams',
  component: AdminTeams,
})

const orgAdminAccessRoute = createRoute({
  getParentRoute: () => orgAdminRoute,
  path: 'access',
  component: AdminAccess,
})

const orgAdminAiRoute = createRoute({
  getParentRoute: () => orgAdminRoute,
  path: 'ai',
  component: AdminAi,
})

const orgAdminTechnologiesRoute = createRoute({
  getParentRoute: () => orgAdminRoute,
  path: 'technologies',
  component: AdminTechnologies,
})

const orgAdminTagsRoute = createRoute({
  getParentRoute: () => orgAdminRoute,
  path: 'tags',
  component: AdminTags,
})

const orgAdminSettingsRoute = createRoute({
  getParentRoute: () => orgAdminRoute,
  path: 'settings',
  component: AdminSettings,
})

// ── Platform Admin console ──
// The operator's ("god mode") surface under `/platform` — its OWN top-level
// route, not nested under `/app` or `/org/$orgId/admin`. PlatformShell owns
// the auth + platform-admin guards and renders child routes via its own
// <Outlet/>, mirroring AdminShell's structure.
const platformRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'platform',
  component: PlatformShell,
})

const platformIndexRoute = createRoute({
  getParentRoute: () => platformRoute,
  path: '/',
  component: PlatformOverview,
})

const platformOrgsRoute = createRoute({
  getParentRoute: () => platformRoute,
  path: 'orgs',
  component: PlatformOrgs,
})

const platformUsersRoute = createRoute({
  getParentRoute: () => platformRoute,
  path: 'users',
  component: PlatformUsers,
})

const platformTechnologiesRoute = createRoute({
  getParentRoute: () => platformRoute,
  path: 'technologies',
  component: PlatformTechnologies,
})

const platformSettingsRoute = createRoute({
  getParentRoute: () => platformRoute,
  path: '/settings',
  component: PlatformSettings,
})

const platformReferenceIntegrityRoute = createRoute({
  getParentRoute: () => platformRoute,
  path: 'reference-integrity',
  component: PlatformReferenceIntegrity,
})

const platformAuditRoute = createRoute({
  getParentRoute: () => platformRoute,
  path: 'audit',
  component: PlatformAudit,
})

const platformDebugRoute = createRoute({
  getParentRoute: () => platformRoute,
  path: 'debug',
  component: PlatformDebug,
})

const platformAccessRoute = createRoute({
  getParentRoute: () => platformRoute,
  path: 'access',
  component: PlatformAccess,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  appRoute.addChildren([
    appIndexRoute,
    workspaceRoute.addChildren([
      wsIndexRoute,
      wsDiagramRoute,
      wsDiagramsRoute,
      wsModelRoute,
      wsModelViewerRoute,
      wsConnectionsRoute,
      wsDependenciesRoute,
      wsAdrRoute,
      wsDraftsRoute,
    ]),
    // Legacy un-versioned paths (back-compat redirects) — siblings of the workspace
    // subtree; distinct first segments so there's no match ambiguity.
    legacyDiagramRoute,
    legacyDiagramsRoute,
    legacyModelRoute,
    legacyModelViewerRoute,
    legacyConnectionsRoute,
    legacyDependenciesRoute,
    legacyAdrRoute,
    legacyDraftsRoute,
  ]),
  orgAdminRoute.addChildren([
    orgAdminIndexRoute,
    orgAdminMembersRoute,
    orgAdminTeamsRoute,
    orgAdminAccessRoute,
    orgAdminTagsRoute,
    orgAdminTechnologiesRoute,
    orgAdminSettingsRoute,
    orgAdminAiRoute,
  ]),
  platformRoute.addChildren([
    platformIndexRoute,
    platformOrgsRoute,
    platformUsersRoute,
    platformTechnologiesRoute,
    platformSettingsRoute,
    platformAccessRoute,
    platformReferenceIntegrityRoute,
    platformAuditRoute,
    platformDebugRoute,
  ]),
  shareRoute,
  embedRoute,
  loginSsoRoute,
  loginRoute,
  authCompleteRoute,
  inviteRoute,
])

export const router = createRouter({ routeTree })

// Let store-led workspace switches (menu, new/duplicate version|landscape, draft
// open/exit) move the address bar to the new ref — see src/lib/appNavigate.ts.
// The promise is RETURNED, not voided: the caller holds its `busy` guard until the
// address bar has actually moved, so WorkspaceRoute below never sees the new active
// ref against the old URL params and bounces the workspace back.
setWorkspaceNavigator((ref) =>
  router.navigate({
    to: WS_ROUTE,
    params: { landscapeId: ref.landscapeId, versionId: ref.versionId },
  })
)

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
