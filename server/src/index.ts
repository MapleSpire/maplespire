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

import 'dotenv/config' // load server/.env (PORT, DATABASE_URL, …) before anything reads process.env
import express from 'express'
import { durableHeadsDecoder } from './readModel/durableHeadsDecoder.js'
import type { Request, Response } from 'express'
import cors from 'cors'
import compression from 'compression'
import type { Repo } from '@automerge/automerge-repo'
import { lifecycleApplyPool, pool, readModelPool, syncCellPool } from './db.js'
import { envNumber } from './envNumber.js'
import { runMigrations, withMigrationLock } from './db/migrations.js'
import { poolMeterSnapshots } from './db/poolMeter.js'
import { schemaMigrations } from './db/schemaMigrations.js'
import { listThemes, getTheme, publishTheme, incrementInstalls, reportTheme, validateThemePayload } from './themes.js'
import {
  createShare, getShare, listShares, updateShare, revokeShare, bumpViewCount, validateCreateShare,
  checkShareRateLimit, checkShareAudienceAccess, getShareGateInfo, defaultShareAudience,
} from './shares.js'
import type { ShareAudience } from './shares.js'
import {
  createVersion, listVersions, getVersion, deleteVersion, validateCreateVersion,
} from './landscapeVersions.js'
import {
  ensureDefaultLandscape, resolveRootUrl, listLandscapes,
  createLandscape, createVersion as createEditableVersion, setDefaultVersion,
  renameLandscape, deleteLandscape, renameVersion, deleteVersion as deleteEditableVersion,
  createDraft, listDrafts, setDraftStatus, backfillLandscapeOrgs,
} from './landscapes.js'
import { mintDocumentIdBytes, encodeMintedIdForWire } from './rbac/documentIdMint.js'
import { SummaryForkUnsupportedError } from './forkRoot.js'

import {
  canonicalWorkspaceKey, checkWorkspaceAccess, sessionOrgId, requireLandscapeInOrg,
  requirePlatformAdminAtStageOn, requireLandscapeWrite, requireVersionWrite, requireOrgAdmin,
  workspaceAccessForRequest,
} from './rbac/workspaceGate.js'
import { computeDraftChanges } from './draft/changes.js'
import { applyMerge } from './draft/applyMerge.js'
import { startAutomergeSync, syncStateLookupMetrics } from './automergeServer.js'
import { LiveWorkspaceResidency } from './readModel/liveWorkspaceResidency.js'
import { lightweightSynchronizerPeerSnapshot } from './automergeTransportTelemetry.js'
import { PostgresStorageAdapter, type StorageFenceSnapshot } from './automergeStorage.js'
import { currentProcessBootId } from './processIdentity.js'
import type { DenyLedgerSnapshot } from './rbac/denyLedger.js'
import { collectAutomergeGarbage, type AutomergeResidencyLeases } from './automergeResidency.js'
import {
  diagramDocHeads,
  registryHasDiagram,
  resolveDiagramDocUrlFromReadModel,
  resolveDiagramDocUrlFromRegistry,
} from './diagramHeads.js'
import { acknowledgeDurableHeads, parseDurableHeadRequests } from './durableHeads.js'
import {
  ProjectorFleet,
  ProjectorOwnershipError,
  ProjectorStaticWorkspaceError,
  DEFAULT_WORKSPACE_KEY,
} from './readModel/projectorService.js'
import {
  ColdBuildAdmission,
  coldBuildAdmissionConfig,
} from './readModel/coldBuildAdmission.js'
// `liveResidency`'s `isExpectedRefusal` derives from `classifyWarmupFailure`,
// so the expected warm-up refusal classes are named in exactly one place.
import { classifyWarmupFailure, createWarmupOutcomeLog } from './readModel/warmupOutcome.js'
import type { WorkspaceKey } from './readModel/projector.js'
import {
  runWorkspaceCompaction,
  type WorkspaceCompactionOutcome,
} from './readModel/workspaceCompaction.js'
import {
  COMPACTION_ALLOWLIST_ENV,
  admitCompaction,
  parseCompactionAllowlist,
} from './readModel/compactionAllowlist.js'
import { compactOverlay } from './readModel/compaction.js'
import {
  COMPACTION_QUEUE_ENV,
  DEFAULT_CLAIM_LEASE_MS,
  compactionQueueEnabled,
  createCompactionQueue,
  dueWorkSeam,
} from './maintenance/compactionQueue.js'
import { scheduleDailyAt } from './scheduler.js'
import { gcOrphanedDocs } from './gc.js'
import {
  roObject, roGroup, roConnection, roLookupMany, durabilityWitnessPayload, roIncoming, roOutgoing,
  roConnectionCount, roDescendants, roRelatedDiagrams, roRelatedDiagramObjectIds, roSearch, roPageObjects, roPageConnections,
  roDiagramMeta, roFilteredObjectTree, roModelObjectFacets, roEntityFlows, roEntityDiagrams,
} from './readModel/queries.js'
import { roDiagramRender, toFirstPaintDiagramRender } from './readModel/diagramRender.js'
import {
  DiagramRenderContextLoader,
  roDiagramRenderGeneration,
  selectDiagramRenderCacheGeneration,
} from './readModel/diagramRenderGeneration.js'
import { DiagramRenderCache, diagramRenderCacheConfig } from './readModel/diagramRenderCache.js'
import { RedisDiagramRenderCache, redisDiagramRenderCacheConfig } from './readModel/diagramRenderRedisCache.js'
import { roDiagramCacheByIds, roDiagramCachePage } from './readModel/diagramOffline.js'
import { roObjectCacheByIds, roObjectCachePage, roObjectSearchPage, roObjectTreeChildren } from './readModel/objectExplorer.js'
import { roConnectionExplorerPage } from './readModel/connectionExplorer.js'
import {
  roConnectionCacheByEndpointIds,
  roConnectionCacheByIds,
  roConnectionCachePage,
  roOfflineCacheEstimate,
} from './readModel/offlineCache.js'
import { roReadModelChanges } from './readModel/changeFeed.js'
import { ReadModelChangeNotificationHub } from './readModel/changeNotifications.js'
import { roDependencyPeerPage } from './readModel/dependencyExplorer.js'
import { roViewerLevel } from './readModel/viewerLevel.js'
import { staticReadModelQueryWorkspaceIfPresent } from './readModel/staticWorkspace.js'
import { ensureSparseDraftDiagram } from './draft/sparse.js'
import { resolveHandleWithRetry } from './readModel/projectorService.js'
/**
 * Per-attempt ceiling for a document resolved INSIDE an HTTP request.
 *
 * The projector's 10 s default is sized for a background cold build that has a
 * retry queue behind it; a request handler has neither, and `tries: 3` would
 * make one decision-record page block for half a minute per document before the
 * client sees anything. `repo.find` can hang indefinitely (see
 * RESOLVE_DEADLINE_MS in readModel/projectorService.ts), so the choice here is
 * not between fast and slow — it is between a bounded 503 and a stuck socket.
 */
const HTTP_RESOLVE_DEADLINE_MS = 2_000
import { documentRetryRegistry } from './readModel/documentRetryQueue.js'
import { readDecisionRecordDetail, readDecisionRecordPage } from './decisionRecords/page.js'
import { roDecisionRecordDetail, roDecisionRecordPage } from './readModel/decisionRecords.js'
import { roDiagramListPage } from './readModel/diagramList.js'
import { toDiagramEditorMeta, toFirstPaintDiagramMeta } from './readModel/diagramMetaViews.js'
import { objectSearchQueryError } from './readModel/objectSearchContract.js'
import { scanReferenceIntegrity } from './maintenance/referenceIntegrityScan.js'
import { repairReferenceIntegrity } from './maintenance/referenceIntegrityRepair.js'
import { route as routeHandler, sendDependencyOutage } from './routeErrors.js'
import { LifecycleApplyRefusedError } from './maintenance/lifecycleApplyLock.js'
import { DOCUMENT_CHECKED_KINDS, scanDocumentReferences } from './maintenance/referenceIntegrityDocuments.js'
import { appendAudit } from './auth/audit.js'
import { StaticDeltaProjector } from './readModel/staticDeltaProjector.js'
import { ServerTimingTrace } from './observability/serverTiming.js'
import { gzipSerializedBody } from './observability/serializedGzipCache.js'
import { AsyncSingleFlight } from './performance/asyncSingleFlight.js'
import { overlayBatchStatuses } from './readModel/overlayHistoryStore.js'
import { ensureDefaultOrg } from './auth/schema.js'
import { ensureRbacSchema } from './rbac/schema.js'
import {
  ensureScopesForExistingWorkspaces,
  allowedWorkspaceKeys,
  notifyWorkspaceCreated,
  notifyWorkspaceDocumentCreated,
} from './rbac/docScope.js'
import { ensureEpochTriggers, workspacePeerCensus, type ConnectionRegistry } from './auth/wsAuth.js'
import {
  promoteSummaryWorkspace,
  demoteSummaryWorkspace,
  repairSummaryFlag,
} from './maintenance/promoteSummaryWorkspace.js'
import {
  authorizeSummaryMigration,
  summaryMigrationApplies,
  summaryMigrationAuditActor,
  summaryMigrationHttpStatus,
  summaryMigrationTarget,
  type SummaryMigrationCaller,
} from './maintenance/summaryMigrationRoute.js'
import { registerOrgAdminRoutes } from './rbac/orgRoutes.js'
import { registerPlatformRoutes } from './auth/platformRoutes.js'
import { authStage, requireAuth } from './auth/middleware.js'
import { sessionCookieName } from './auth/tokens.js'
import { sharedSessionEpochValidator } from './auth/sessionEpoch.js'
import { registerAuthRoutes } from './auth/devLogin.js'
import { registerPasswordAuthRoutes } from './auth/passwordAuth.js'
import { registerOidcRoutes } from './auth/oidc.js'
import { registerInviteRoutes } from './auth/invites.js'
import { registerOrgRoutes } from './auth/orgs.js'
import { setProvisioningRepo } from './auth/provisioning.js'
import { registerOrgSeedRoutes } from './orgSeed/routes.js'
import { registerDevOutboxRoutes } from './email/local.js'
import { registerAiFeature, aiBearerBridge } from './ai/index.js'
import { ensureManagedTechnologyCatalog } from './technologies/bootstrap.js'
import { registerTechnologyRoutes } from './technologies/routes.js'
import { gcStaleTechnologyAssets } from './technologies/assets.js'
import { registerTagRoutes } from './tags/routes.js'
import { registerLinkMetadataRoutes } from './linkMetadata.js'
import { gcTagOperationalState } from './tags/operations.js'
import { assertProductionGuardrails } from './productionGuardrails.js'
import {
  MaintenanceCoordinator,
  workspaceKeyedMaintenanceEnabled,
  type MaintenanceFence,
  type MaintenanceJobName,
  type MaintenanceRunResult,
} from './maintenance/coordinator.js'
import {
  RedisRuntime,
  RedisUnavailableError,
  redisRenderCacheRuntime,
  redisRuntime,
  readinessSourceOf,
  redisRuntimeConfig,
} from './runtime/redis.js'
import { collectReadiness } from './runtime/readiness.js'
import { listenReady } from './runtime/listen.js'
import { terminalErrorHandler } from './runtime/errorMiddleware.js'
import { metricsTokenMatches, renderPrometheus, type MetricSample } from './runtime/metrics.js'
import { serviceLatency } from './automergeServiceLatency.js'
import { docScopeMetricSamples } from './rbac/docScope.js'
import { serverCreationPlacementMetricSamples } from './rbac/serverCreationPlacement.js'
import { forkRollbackMetricSamples } from './forkRollback.js'
import { bootstrapMintMetricSamples } from './bootstrapMint.js'
import { bootstrapScopeMetricSamples, bootstrapScopeSnapshot, installBootstrapOwnership } from './bootstrapScope.js'
import { mintedOrphanReaperMetricSamples, reapMintedOrphans } from './mintedOrphanReaper.js'
import { overlayRotationLockMetricSamples } from './readModel/overlayRotationLock.js'
import { documentGrowthSnapshot, startDocumentGrowthSampler } from './readModel/documentGrowth.js'
import { lastDivergenceRun } from './readModel/divergenceRunner.js'
import { collectCrdtInventory } from './readModel/crdtInventory.js'
import { divergenceSweepState, startDivergenceScheduler } from './readModel/divergenceScheduler.js'
import {
  fleetDefectSummary,
  refusedProjectionCount,
  verifyWorkspaceIntegrity,
} from './readModel/projectionIntegrity.js'
import { getFleetReadModelStatusCounts } from './readModel/health.js'
import { readDrillHealth, readDrillOverlap } from './backup/drillReport.js'
// `backupRestore.js` only — NOT `drillRunner.js`, which re-exports
// `ORPHAN_MINIMUM_AGE_MS` but would drag `coldServer` (an HTTP server),
// `coldApi`, `assetArchive` and `node:child_process` into this entrypoint's
// module graph for one constant.
import {
  ORPHAN_MINIMUM_AGE_MS, readRestoreDatabaseCensus, restoreDatabaseCensusMetrics,
} from './backup/backupRestore.js'
import {
  SyncCellOwnershipCoordinator,
  syncCellOwnershipConfig,
  syncCellOwnershipMetricSamples,
} from './syncCells/ownership.js'
import {
  evictWorkspaceDocumentCache,
  prewarmWorkspaceFailoverDocuments,
} from './syncCells/repoFreshness.js'
import { createWorkspaceHttpRouting } from './syncCells/workspaceHttpRoute.js'
import { aiToolRelayMetricSamples, aiToolRelaySnapshot } from './syncCells/aiToolCallRelay.js'
import { referenceIntegrityApplies } from './syncCells/workspaceRouteExtractors.js'
import { WriteAuthorityUnavailableError } from './syncCells/writeAuthority.js'
import { placeMergeWrite, writeAuthorityRefusal } from './syncCells/mergePlacement.js'
import {
  admitRepoMaintenance,
  maintenanceRunOptions,
  type RepoMaintenanceDenialReason,
  type RepoMaintenanceScope,
} from './syncCells/repoMaintenance.js'
import { ensureHealthyWorkspaceRoot } from './maintenance/workspaceRootGuard.js'
import { cachedHandles, findReadyDocument } from './automergeRepoCompat.js'
import { assertWorkspaceSetParity } from './maintenance/workspaceSetParity.js'
import { singleFlight } from './maintenance/singleFlight.js'
import { classifyWorkspaceRefusal } from './syncCells/workspaceRefusal.js'

/** Upper bound on one mint request. Small on purpose: the offline reserve this
 * feeds should stay small, because a large one widens the window in which a
 * member whose write grant was revoked while offline still holds usable ids. */
const MAX_MINTED_IDS_PER_REQUEST = 64

assertProductionGuardrails(process.env)

const READ_MODEL_ENABLED = process.env.READ_MODEL === 'on'
const readModelChangeHub = new ReadModelChangeNotificationHub(pool)
const renderCacheConfig = diagramRenderCacheConfig()
const redisRenderCacheConfig = redisDiagramRenderCacheConfig()
const diagramRenderCache = new DiagramRenderCache(
  renderCacheConfig,
  redisRenderCacheRuntime.configured
    ? new RedisDiagramRenderCache(redisRenderCacheRuntime, redisRenderCacheConfig)
    : undefined,
)
const diagramRenderContextLoader = new DiagramRenderContextLoader(pool)
const boundedReadSingleFlight = new AsyncSingleFlight()
const coldBuildConfig = coldBuildAdmissionConfig()
const coldBuildAdmission = new ColdBuildAdmission(coldBuildConfig)
let maintenanceCoordinator: MaintenanceCoordinator | null = null
let syncCellOwnership: SyncCellOwnershipCoordinator | null = null
let syncCellOwnershipRedis: RedisRuntime | null = null
// THE ONE WIRE between the bootstrap family and the coordinator.
// A GETTER over the `let` above, installed at module load: while the
// coordinator is still null on a SYNC_CELL_OWNERSHIP=on process, a fenced
// bootstrap scope answers `warming-up` — the same boot-window answer the
// routing middleware's `ownershipRequired` gives its five families — and on a
// process where ownership is not required, an absent coordinator is an
// unfenced grant. Every fork, empty root, sparse draft and merge reaches
// ownership through this line and nothing else, so there is no per-site
// parameter to forget.
// ONE spelling of "is ownership REQUIRED on this process", read at every call
// so a test can flip it. Three consumers ask it — the bootstrap scope below,
// the HTTP router, and the agent loops' tool-call relay — and a
// predicate spelled three times is three chances for one of them to stop
// agreeing with the other two. `mutatingRouteCoverage.test.ts` pins that all
// three read this and the same coordinator.
const syncCellOwnershipRequired = (): boolean => process.env.SYNC_CELL_OWNERSHIP === 'on'
installBootstrapOwnership({
  required: syncCellOwnershipRequired,
  current: () => syncCellOwnership,
})
let readStorageFenceSnapshot: (() => StorageFenceSnapshot) | null = null
let readStorageFenceRejectionCount: (() => number) | null = null
let automergeResidency: AutomergeResidencyLeases | null = null
let readDenyLedgerSnapshot: (() => DenyLedgerSnapshot | null) | null = null

const app = express()
const PORT = Number(process.env.PORT ?? 3001)
const readiness = {
  automerge: false,
  readModel: !READ_MODEL_ENABLED,
  shuttingDown: false,
}

// Credentialed CORS: the session cookie must survive the SPA→API cross-origin hop
// (vite :5180 → server :3002 in dev). Reflecting ANY origin with credentials would
// let arbitrary websites make cookie-bearing calls, so credentialed reflection is
// limited to APP_URL + local dev origins; other origins get the old open behavior
// ('*'), which browsers only honor for NON-credentialed requests.
const appOrigin = (() => {
  try {
    return new URL(process.env.APP_URL ?? 'http://localhost:5173').origin
  } catch {
    return 'http://localhost:5173'
  }
})()
app.use(
  cors({
    credentials: true,
    exposedHeaders: [
      'Server-Timing',
      'X-Read-Model-Generation',
      'X-Read-Model-Render-Cache',
      'X-Read-Model-Render-Bytes',
    ],
    origin: (origin, cb) => {
      // The localhost:* credentialed reflection is a DEV convenience (vite on
      // any port) — in production only the configured APP_URL origin may make
      // cookie-bearing calls, or any site running on localhost beside the
      // user's browser could ride their session.
      const localhostOk =
        process.env.NODE_ENV !== 'production' && /^https?:\/\/localhost(:\d+)?$/.test(origin ?? '')
      if (!origin || origin === appOrigin || localhostOk) {
        cb(null, true) // reflect — credentials allowed
      } else {
        cb(null, '*') // open, non-credentialed (pre-auth behavior for third parties)
      }
    },
  })
)
// Gzip responses — share snapshots are large, highly compressible JSON.
// The AI chat endpoint streams Server-Sent Events; compression would buffer
// the stream into one flush at the end, so event streams are excluded.
app.use(
  compression({
    filter: (req, res) => {
      const type = String(res.getHeader('Content-Type') ?? '')
      if (type.includes('text/event-stream')) return false
      return compression.filter(req, res)
    },
  })
)
app.use(express.json({ limit: '50mb' }))

// AI bearer-token bridge — a verified `Authorization: Bearer bvr_…` token
// sets `req.auth` BEFORE the auth gate (which passes pre-authenticated
// requests through), so MCP hosts/scripts get the owning user's RBAC identity.
app.use('/api', aiBearerBridge())

// Auth gate — MUST be registered before every /api route (Express runs use/route
// in registration order). Stage 'off' (the default) is a pure pass-through, so an
// un-configured server behaves byte-identically to before auth existed. See
// docs/auth-setup.md for the off|dual|on rollout stages + allowlist.
// `isSessionCurrent`: a revoked cookie is refused here too, not only on the
// sync path — every epoch, the same per-process validator, so a bump's notify
// clears both. HTTP gates trust signed claims (`isPlatformAdmin`, and `orgId`
// in workspaceGate.ts requireLandscapeInOrg, which reads no membership).
app.use('/api', requireAuth({ isSessionCurrent: sharedSessionEpochValidator(pool) }))

// Auth + email routes (all default-off/no-op without their env vars; the client's
// login page reads /api/auth/config to know what to render).
registerAuthRoutes(app)
registerPasswordAuthRoutes(app)
registerOidcRoutes(app)
registerInviteRoutes(app)
registerOrgRoutes(app)
registerDevOutboxRoutes(app)
registerOrgAdminRoutes(app)
registerPlatformRoutes(app)
registerTechnologyRoutes(app, pool)
registerTagRoutes(app, pool)
registerLinkMetadataRoutes(app)
// An invalid AUTH_COOKIE_NAME must stop the boot, not 401 every request.
if (authStage() !== 'off') sessionCookieName()
app.get('/api/auth/config', (_req, res) => {
  res.json({
    stage: authStage(),
    devLogin: process.env.AUTH_DEV_LOGIN === 'on',
    passwordLogin: process.env.AUTH_PASSWORD_LOGIN === 'on',
    orgSeed: process.env.ORG_SEED === 'on',
  })
})

// Keep the public/API load balancer stateless while routing only Repo/projector
// work to the fenced owner of the canonical workspace. This middleware runs
// after authentication; the owner repeats auth/RBAC before serving the request.
app.use(createWorkspaceHttpRouting({
  db: pool,
  ownership: () => syncCellOwnership,
  ownershipRequired: syncCellOwnershipRequired,
}))

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

/**
 * THE POOL CENSUS, the reading `pg_stat_activity` cannot produce.
 *
 * Three properties, each of them load-bearing:
 *
 * **It touches no database.** `poolMeterSnapshots()` reads fields off objects
 * already in memory. This endpoint is asked its question precisely when the
 * primary pool has no connection left to give, so a census that had to borrow
 * one would fail exactly on the case it exists to describe.
 *
 * **It is unauthenticated, and that is a decision, not an omission.** `/health`
 * is an `ALLOWLISTED_PREFIXES` entry (`auth/middleware.ts`), so `/api/health/…`
 * answers with no session, so it is readable during an auth outage. It
 * publishes counts and ages and NOTHING else: no identifiers, no SQL, no stack,
 * no configuration beyond `max`. That is a narrower disclosure than the
 * unauthenticated `/api/ready` beside it already makes. `/metrics` takes the
 * opposite posture — 404 without `METRICS_TOKEN` — because it publishes
 * workspace counts and process memory; the two rules differ because the two
 * payloads differ, and neither is the default for the other.
 *
 * **It reports an ENDING pool.** See `poolMeter.ts`: retirement is on `ended`,
 * so a pool that will not drain because a client was never given back stays
 * visible here instead of vanishing at the moment it becomes interesting.
 */
app.get('/api/health/pools', (_req, res) => {
  res.json({ pools: poolMeterSnapshots(), sampledAt: new Date().toISOString() })
})

/**
 * Prometheus scrape. Everything here was previously log-only or behind an admin
 * dialog somebody had to open — including the two detectors this branch added,
 * `stale` workspaces and watched-but-unleased documents. A detector nothing
 * scrapes is a detector nobody acts on.
 *
 * 404 without `METRICS_TOKEN`: the endpoint does not exist rather than existing
 * unauthenticated. Failing open would publish workspace counts and process
 * memory to anything that can reach the port, and scrape endpoints get exposed
 * through an ingress by accident more often than any other route.
 */
app.get('/metrics', route(async (req, res) => {
  const expected = process.env.METRICS_TOKEN
  if (!expected) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  if (!metricsTokenMatches(req.header('authorization'), expected)) {
    res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' })
    return
  }

  const metrics: MetricSample[] = []

  // The docScope reference walk. It fires on every watched document's
  // change, leaves included, so at scale it is the largest per-change server
  // cost. Exposed so that claim is measurable instead of argued.
  // Document growth and, more urgently, EMPTY documents. Sampled on a
  // timer, never at scrape time: the aggregate is a full scan of
  // automerge_storage (split_part defeats any index).
  // SERVICE LATENCY, the server-side twin of the client's
  // boot walls. The client can only report from the tab a failure happened in;
  // this covers every peer, needs no upload path, and answers the question the
  // client-side caps could not: *is the time to bring a peer up to date on a
  // document approaching the wall that peer will give up at?*
  //
  // `pending_oldest_ms` is the reading that MOVES FIRST. Compare it against the
  // client's `BOOT_RESOLVE_MAX_MS` (120 000 by default): a document outstanding
  // for longer is a boot about to fail, seen before any user sees it.
  const service = serviceLatency.snapshot()
  metrics.push({
    name: 'maplespire_automerge_service_latency_ms',
    help: 'Time to bring ONE peer up to date on ONE document. max/pending_oldest are the tail, and the tail is what fails a boot.',
    type: 'gauge',
    values: [
      { labels: { quantile: 'p50' }, value: service.p50Ms },
      { labels: { quantile: 'p95' }, value: service.p95Ms },
      { labels: { quantile: 'max' }, value: service.maxMs },
      { labels: { quantile: 'pending_oldest' }, value: service.pendingOldestMs },
    ],
  })
  metrics.push({
    name: 'maplespire_automerge_service_documents',
    help: 'Documents completed / in service now / untracked because the pending cap was reached. overflow>0 means the quantiles describe a SUBSET.',
    type: 'gauge',
    values: [
      { labels: { state: 'completed' }, value: service.completed },
      { labels: { state: 'pending' }, value: service.pending },
      { labels: { state: 'overflow' }, value: service.overflow },
      { labels: { state: 'abandoned' }, value: service.abandoned },
    ],
  })

  const growth = documentGrowthSnapshot()
  metrics.push({
    name: 'maplespire_automerge_documents_empty',
    help: 'Documents mapped to a workspace with NO data chunk. These are advertised and unopenable.',
    type: 'gauge',
    values: [
      { labels: { kind: 'no-rows' }, value: growth.documentsEmpty },
      // A lone sync-state row passes every EXISTS(split_part(key,'/',1)=id)
      // predicate in this codebase, so these look stored and then fail to load.
      { labels: { kind: 'sync-state-only' }, value: growth.documentsSyncStateOnly },
    ],
  })
  metrics.push({
    name: 'maplespire_automerge_document_bytes',
    help: 'Stored Automerge bytes. max is the growth early-warning signal; nothing in the product bounds an op log.',
    type: 'gauge',
    values: [
      { labels: { scope: 'total' }, value: growth.totalBytes },
      { labels: { scope: 'max-document' }, value: growth.maxDocumentBytes },
    ],
  })
  metrics.push({
    name: 'maplespire_automerge_document_growth_sample_age_seconds',
    help: 'Age of the cached growth sample. NaN before the first sample — a stale sample must be visibly stale.',
    type: 'gauge',
    values: [{
      value: growth.sampledAt === null
        ? Number.NaN
        : Number(((Date.now() - Date.parse(growth.sampledAt)) / 1000).toFixed(3)),
    }],
  })

  // CRDT vs read model. `outcome` is deliberately an enum-as-gauge with an
  // `error` state: a checker that failed must not be indistinguishable from a
  // system that is fine.
  const divergence = lastDivergenceRun()
  const sweep = divergenceSweepState()
  metrics.push({
    name: 'maplespire_read_model_divergence_sweep',
    help: 'What the last sweep could attempt. eligible=0 means the detector checked NOTHING, which is not the same as clean.',
    type: 'gauge',
    values: [
      { labels: { scope: 'candidates' }, value: sweep.candidates },
      { labels: { scope: 'eligible' }, value: sweep.eligible },
    ],
  })
  metrics.push({
    name: 'maplespire_read_model_divergence_sweep_age_seconds',
    help: 'Age of the last scheduler tick. NaN before the first — a scheduler that never ran must not look idle-but-fine.',
    type: 'gauge',
    values: [{
      value: sweep.lastTickAt === null
        ? Number.NaN
        : Number(((Date.now() - Date.parse(sweep.lastTickAt)) / 1000).toFixed(3)),
    }],
  })
  metrics.push({
    name: 'maplespire_read_model_divergence_state',
    help: 'EXPERIMENTAL, off unless READ_MODEL_DIVERGENCE=on — clean means NOT MEASURED, not healthy. Compares id presence only; the CRDT side is re-walked independently (crdtInventory.ts) but shares the projector\'s empty-shard and tombstone rules, and flows without message steps are false positives. See divergenceRunner.ts.',
    type: 'gauge',
    values: (['never-run', 'clean', 'diverged', 'inconclusive', 'error'] as const).map((state) => ({
      labels: { state },
      value: (divergence === null ? 'never-run' : divergence.outcome) === state ? 1 : 0,
    })),
  })
  metrics.push({
    name: 'maplespire_read_model_divergence_confirmed',
    help: 'Entities that differed in BOTH passes at an unchanged projection generation.',
    type: 'gauge',
    values: [{ value: divergence?.confirmed.length ?? 0 }],
  })
  metrics.push({
    name: 'maplespire_read_model_divergence_age_seconds',
    help: 'Age of the last divergence check. NaN when it has never run.',
    type: 'gauge',
    values: [{
      value: divergence === null ? Number.NaN : Number(((Date.now() - Date.parse(divergence.ranAt)) / 1000).toFixed(3)),
    }],
  })

  // WHAT COVERS THESE LINES. The builders below are unit-tested in their own
  // modules because nothing in CI mounts this route. `scripts/monitoring.test.mjs`
  // fails when a module defining `maplespire_*` names has no exported builder
  // reachable through `metrics.push(...NAME(` here or through the drill
  // listener's collector, so commenting out a push turns it red.
  //
  // WHAT IS STILL UNCOVERED: that gate matches the CALL, not the response.
  // Wrapping a push in a condition that is never true, or passing it a dead
  // argument, stays green; closing that needs a test that mounts the route.
  metrics.push(...docScopeMetricSamples())
  metrics.push(...serverCreationPlacementMetricSamples())
  metrics.push(...forkRollbackMetricSamples())
  // The bootstrap family's named minting, and the reaper that its names make
  // possible.
  metrics.push(...bootstrapMintMetricSamples())
  // The scope every bootstrap graph is created under.
  metrics.push(...bootstrapScopeMetricSamples())
  // The agent loops' tool calls that hopped to the owner.
  metrics.push(...aiToolRelayMetricSamples())
  metrics.push(...mintedOrphanReaperMetricSamples())
  // The overlay rotation key.
  metrics.push(...overlayRotationLockMetricSamples())
  // The two restore detectors (fence divergence, world mismatch).
  //
  // Read the current coordinator, storage counter and projector fleet on each
  // scrape. In particular, the storage counter reader must not use snapshot(),
  // which also prunes its retry cache. These new readers are synchronous; the
  // rest of this endpoint still performs its existing database queries.
  metrics.push(...syncCellOwnershipMetricSamples(syncCellOwnership, Date.now(), {
    storageFenceRejections: () => readStorageFenceRejectionCount?.() ?? null,
    foreignResidentProjectors: () => READ_MODEL_ENABLED
      ? readModelFleet?.snapshot().foreignResidentProjectors ?? null
      : 0,
  }))
  // Documents the projector could not read. This is the signal the
  // divergence detector could never produce: a document that fails to load is
  // absent from BOTH sides of any comparison, so only the reader can report it.
  const defects = await fleetDefectSummary(pool, { worstLimit: 0 })
  metrics.push({
    name: 'maplespire_read_model_unreadable_documents',
    help: 'Documents a full extraction resolved but could not read. Each one is data missing from the read model with no error anywhere.',
    type: 'gauge',
    values: [
      { labels: { scope: 'documents' }, value: defects.totalDefects },
      { labels: { scope: 'workspaces' }, value: defects.workspacesWithDefects },
    ],
  })
  metrics.push({
    name: 'maplespire_read_model_workspaces_never_examined',
    help: 'Workspaces with no defect count recorded. NOT the same as zero defects — these have never been fully extracted since T1.3a shipped.',
    type: 'gauge',
    values: [{ value: defects.workspacesNeverExamined }],
  })
  metrics.push({
    name: 'maplespire_read_model_refused_projections_total',
    help: 'Full-sync projections declined because their source document carried no entity map (a shard delta, or a ModelMeta with no groups). Non-zero means row deletion was refused on evidence that failed to load.',
    type: 'counter',
    values: [{ value: refusedProjectionCount() }],
  })

  const statusCounts = await getFleetReadModelStatusCounts(pool)
  metrics.push({
    name: 'maplespire_read_model_workspaces',
    help: 'Workspaces by read-model projection status, fleet-wide.',
    type: 'gauge',
    values: Object.entries(statusCounts).map(([status, value]) => ({ labels: { status }, value })),
  })

  const residency = automergeResidency ? await automergeResidency.snapshot() : null
  if (residency) {
    metrics.push({
      name: 'maplespire_automerge_orphaned_listener_evictions_total',
      help: 'Documents evicted while an unaccounted change listener was still attached. Should be 0.',
      type: 'counter',
      values: [{ value: residency.orphanedListenerEvictions }],
    })
    // The counter above can only speak at eviction time, so a flat zero means
    // either "no orphans" or "no evictions, ever" — and on a busy workspace with
    // AM_IDLE_MS at its 5-minute default, the second is common. These two make
    // that distinction visible instead of leaving a silent detector looking
    // like a clean one.
    metrics.push({
      name: 'maplespire_automerge_evictions_total',
      help: 'Idle-sweep evictions, and the two reasons one is skipped: a peer was still attached, or the document had been replaced since the sweep decided.',
      type: 'counter',
      values: [
        { labels: { outcome: 'evicted' }, value: residency.evictedDocuments },
        { labels: { outcome: 'skipped_active_peer' }, value: residency.evictionSkippedActivePeer },
        { labels: { outcome: 'skipped_stale_handle' }, value: residency.evictionSkippedStaleHandle },
      ],
    })
    metrics.push({
      name: 'maplespire_automerge_resident_documents',
      help: 'Automerge documents held in this process, by lease state.',
      type: 'gauge',
      values: [
        // `residency` here is an AutomergeResidencySnapshot, not a Repo, and
        // `.handles` is a number it already computed.
        // eslint-disable-next-line no-restricted-syntax
        { labels: { state: 'handles' }, value: residency.handles },
        { labels: { state: 'leased' }, value: residency.leasedDocuments },
        { labels: { state: 'protected' }, value: residency.protectedDocuments },
      ],
    })
    metrics.push({
      name: 'maplespire_automerge_resident_durable_bytes',
      help: 'Durable chunk bytes attributable to resident documents.',
      type: 'gauge',
      values: [{ value: residency.residentDurableChunkBytes }],
    })
  }

  // Backup drill freshness. The alert operations actually needs is on the AGE of
  // the last success, not on the last run's outcome: a drill that stopped being
  // scheduled produces no failures at all, and a green last-run gauge would sit
  // there for months looking exactly like a healthy one.
  const drill = await readDrillHealth(pool)
  metrics.push({
    name: 'maplespire_backup_drill_last_success_age_seconds',
    help: 'Seconds since the last passing backup/restore drill. NaN when no drill has ever passed.',
    type: 'gauge',
    // NaN, deliberately, for "never": renderPrometheus emits it as NaN, so
    // `> 86400` does not fire and `absent()`/NaN checks do — a zero here would
    // read as "a drill just passed" on an installation that has never run one.
    values: [{ value: drill.lastSuccessAgeSeconds ?? Number.NaN }],
  })
  metrics.push({
    name: 'maplespire_backup_drill_last_success_rto_seconds',
    help: 'Wall-clock backup+restore+verify time of the last passing drill.',
    type: 'gauge',
    values: [{ value: drill.lastSuccessRtoMs === null ? Number.NaN : drill.lastSuccessRtoMs / 1_000 }],
  })
  metrics.push({
    name: 'maplespire_backup_drill_failures_since_success',
    help: 'Drill runs that failed since the last passing one.',
    type: 'gauge',
    values: [{ value: drill.failuresSinceLastSuccess }],
  })

  // The CONSEQUENCE check, and the only backup metric that does not
  // derive from the mechanism it is judging. Everything above measures whether
  // the exclusion machinery believes it worked; this reads durable columns no
  // code on the lock path writes and answers whether two drills actually ran at
  // the same time.
  //
  // Guarded, and the reason is specific rather than caution: `/metrics` is one
  // route, so a rejection anywhere in it is a 500 and Prometheus receives
  // NOTHING — including `..._last_success_age_seconds`, whose companion rule is
  // an `absent()` check. A database hiccup here would therefore fire
  // BackupDrillNeverPassed, an alert about backups, for a reason that has
  // nothing to do with backups.
  try {
    const overlap = await readDrillOverlap(pool)
    metrics.push({
      name: 'maplespire_backup_drill_last_overlap_age_seconds',
      help: 'Seconds since a drill last started while another was still running. '
        + 'NaN when the exclusion has never been observed to fail.',
      type: 'gauge',
      // NaN, matching the convention above: a zero here would read as "two
      // drills overlapped just now" on every installation that never had one.
      values: [{ value: overlap.lastOverlapAgeSeconds ?? Number.NaN }],
    })
    metrics.push({
      name: 'maplespire_backup_drill_last_unreliable_window_age_seconds',
      help: 'Seconds since the most recent drill row whose time window cannot be trusted. '
        + 'NaN when there is none.',
      type: 'gauge',
      values: [{ value: overlap.lastUnreliableAgeSeconds ?? Number.NaN }],
    })
    metrics.push({
      name: 'maplespire_backup_drill_overlapping_runs',
      help: 'Drill runs that began while an earlier one was still recorded as running.',
      type: 'gauge',
      values: [{ value: overlap.overlappingRuns }],
    })
    metrics.push({
      name: 'maplespire_backup_drill_runs_considered',
      help: 'Rows the overlap check was computed over — excluded rows are not among them. '
        + 'A zero overlap count against a zero here is an empty scan, not a clean bill of health.',
      type: 'gauge',
      values: [{ value: overlap.consideredRuns }],
    })
    metrics.push({
      name: 'maplespire_backup_drill_runs_with_unreliable_window',
      help: 'Drill rows whose recorded window is not the real one. `abandoned`: finished_at is '
        + 'when the scheduler gave up, not when the drill stopped (#54). `backwards` and '
        + '`implausible`: a clock that jumped, so the row is excluded from the overlap scan. '
        + '`marginal`: an apparent overlap smaller than the skew tolerance. A zero overlap '
        + 'beside a non-zero here is INCOMPLETE, not clean.',
      type: 'gauge',
      values: [
        { labels: { kind: 'abandoned' }, value: overlap.abandonedRuns },
        { labels: { kind: 'backwards' }, value: overlap.backwardsRuns },
        { labels: { kind: 'implausible' }, value: overlap.implausibleRuns },
        { labels: { kind: 'marginal' }, value: overlap.marginalRuns },
      ],
    })
  } catch (error) {
    console.warn('[metrics] the backup drill overlap check failed:', error)
  }

  // The orphan sweep's CONSEQUENCE check, and the second metric here that does
  // not derive from the mechanism it judges.
  //
  // The sweep itself runs in the `backup-drill` container, which Prometheus does
  // not scrape — `prometheus.yml` has exactly one target, `api:3001`, and
  // `drillScheduler.ts` serves no HTTP at all. So an in-process counter over
  // there would read zero forever, which is the shape of a detector that looks
  // clean because it is disconnected. This asks the cluster instead, from the
  // process that IS scraped, and the two share one Postgres.
  //
  // Guarded for the same specific reason the overlap check above is: `/metrics`
  // is one route, so a rejection here would 500 the whole scrape and Prometheus
  // would receive nothing — including `..._last_success_age_seconds`, whose
  // companion rule is an `absent()` check. A hiccup counting databases would
  // otherwise fire BackupDrillNeverPassed, an alert about backups, for a reason
  // that has nothing to do with backups.
  try {
    // `ORPHAN_MINIMUM_AGE_MS` (6 h), which is the FLOOR both sweeps honour —
    // teardown passes it directly and `bootSweepMinimumAgeMs` maxes it against
    // the rival's deadline. Using the floor means `reclaimable` can lead the
    // BOOT sweep's own gate by `maxDrillHold - 6h`: five minutes on the shipped
    // compose file (deadline 6 h, grace 300 s), but that is a property of that
    // file and not of this code — `deadlineMs` is bounded only by the cadence,
    // which `intervalMs` allows up to 720 h. So the overcount is "the databases
    // minted inside that window", not "at most one", and the size of the window
    // is a deployment's choice.
    //
    // It is why the alert is on the OLDEST AGE at a week rather than on this
    // count being non-zero: an age threshold is unaffected by a transiently
    // generous gate, where a `> 0` count rule would fire on every deployment
    // that configures a long deadline.
    const census = await readRestoreDatabaseCensus(pool, ORPHAN_MINIMUM_AGE_MS)
    // Everything about the samples themselves — the label set, the NaN
    // convention, the help text — lives beside the census so a vitest suite can
    // reach it. This file is covered by none, so what stays here is the one
    // thing `monitoring.test.mjs` can see by name.
    metrics.push(...restoreDatabaseCensusMetrics(census))
  } catch (error) {
    console.warn('[metrics] the restore-database census failed:', error)
  }

  const memory = process.memoryUsage()
  metrics.push({
    name: 'maplespire_process_memory_bytes',
    help: 'Process memory usage.',
    type: 'gauge',
    values: [
      { labels: { kind: 'rss' }, value: memory.rss },
      { labels: { kind: 'heap_used' }, value: memory.heapUsed },
      { labels: { kind: 'external' }, value: memory.external },
    ],
  })

  res.type('text/plain; version=0.0.4').send(renderPrometheus(metrics))
}))

// Orchestrator readiness is deliberately stricter than liveness: a process can
// be alive while the Automerge Repo or read-model projector is still warming.
app.get('/api/ready', async (_req, res) => {
  // Computed in `runtime/readiness.ts` so a test can load it. Every check that
  // can ASK its dependency does (reading a cached flag reports a paused Redis
  // as healthy), and ownership readiness uses `canServe`, not `ready`.
  const report = await collectReadiness({
    database: () => pool.query('SELECT 1').then(() => true),
    redis: readinessSourceOf(redisRuntime),
    renderCacheRedis: readinessSourceOf(redisRenderCacheRuntime),
    automerge: readiness.automerge,
    readModel: readiness.readModel,
    shuttingDown: readiness.shuttingDown,
    ownership: syncCellOwnership?.readSnapshot() ?? null,
  })
  res.status(report.status).json(report.body)
})

app.get('/api/platform/sync-cell', (req, res) => {
  if (!requirePlatformAdminAtStageOn(req, res)) return
  const ownership = syncCellOwnership?.readSnapshot()
  if (!ownership) {
    res.status(503).json({ error: 'Sync-cell ownership is not initialized' })
    return
  }
  res.json({
    generatedAt: new Date().toISOString(),
    ...ownership,
    storageFence: readStorageFenceSnapshot?.() ?? null,
    // The bootstrap scope's counters, beside the fence's, so a refusal
    // BEFORE the first mint is as attributable as one on a save.
    bootstrapScope: bootstrapScopeSnapshot(),
    // The tool calls the agent loops relayed to the owner, beside the
    // scope counters they keep at zero on the relaying cell.
    aiToolRelay: aiToolRelaySnapshot(),
  })
})

app.get('/api/platform/automerge-residency', route(async (req, res) => {
  if (!requirePlatformAdminAtStageOn(req, res)) return
  if (!automergeResidency) {
    res.status(503).json({ error: 'Automerge residency is not initialized' })
    return
  }
  res.json(await automergeResidency.snapshot())
}))

/**
 * "Prove the read model still holds what the projector wrote".
 *
 * ON DEMAND, never scheduled. The guarantee it checks is sealed continuously (in
 * the projection's own transaction); what is deliberately not continuous is this
 * READING of it, because a background sweep that pages on its own findings
 * becomes alert noise.
 *
 * With `landscapeId`/`versionId` it compares that workspace's sealed digests
 * against its rows — four indexed aggregates, no Automerge access, so it is safe
 * on an evicted workspace. Without them it reports the fleet's unreadable-document
 * tally instead.
 */
app.get('/api/platform/read-model/integrity', route(async (req, res) => {
  if (!requirePlatformAdminAtStageOn(req, res)) return
  const landscapeId = typeof req.query.landscapeId === 'string' ? req.query.landscapeId : null
  const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : null
  if (landscapeId && versionId) {
    res.json(await verifyWorkspaceIntegrity(pool, { landscapeId, versionId }))
    return
  }
  if (landscapeId || versionId) {
    res.status(400).json({ error: 'landscapeId and versionId must be supplied together' })
    return
  }
  res.json({
    generatedAt: new Date().toISOString(),
    defects: await fleetDefectSummary(pool),
    refusedProjections: refusedProjectionCount(),
  })
}))

/** Outstanding recoverable denials on the cached share-policy gate. A deny that
 * never drains is the failure mode this ledger exists to make visible: it means
 * something is being recorded that no repair can reverse. See rbac/denyLedger.ts. */
app.get('/api/platform/automerge-deny-ledger', (req, res) => {
  if (!requirePlatformAdminAtStageOn(req, res)) return
  const snapshot = readDenyLedgerSnapshot?.()
  if (!snapshot) {
    res.status(503).json({ error: 'Deny ledger is not initialized' })
    return
  }
  res.json(snapshot)
})

app.get('/api/platform/automerge-runtime', (req, res) => {
  if (!requirePlatformAdminAtStageOn(req, res)) return
  if (!automergeResidency) {
    res.status(503).json({ error: 'Automerge residency is not initialized' })
    return
  }
  res.json(automergeResidency.runtimeSnapshot())
})

app.post('/api/platform/automerge-residency/collect', route(async (req, res) => {
  if (!requirePlatformAdminAtStageOn(req, res)) return
  if (!automergeResidency) {
    res.status(503).json({ error: 'Automerge residency is not initialized' })
    return
  }
  const collected = await collectAutomergeGarbage()
  if (!collected) {
    res.status(503).json({ error: 'Explicit GC is not enabled for this process' })
    return
  }
  res.json(await automergeResidency.snapshot())
}))

// Data sync runs over Automerge (ws /automerge + GET /api/automerge/root), wired
// up in main(). The old entity-diff `/api/sync` endpoint has been removed.

// --- Community theme gallery ---

app.get('/api/themes', async (_req, res) => {
  try {
    res.json({ themes: await listThemes() })
  } catch (err) {
    console.error('List themes error:', err)
    res.status(500).json({ error: 'Failed to list themes' })
  }
})

app.get('/api/themes/:id', async (req, res) => {
  try {
    const theme = await getTheme(req.params.id)
    if (!theme) {
      res.status(404).json({ error: 'Theme not found' })
      return
    }
    res.json({ theme })
  } catch (err) {
    console.error('Get theme error:', err)
    res.status(500).json({ error: 'Failed to get theme' })
  }
})

app.post('/api/themes', async (req, res) => {
  try {
    const error = validateThemePayload(req.body)
    if (error) {
      res.status(400).json({ error })
      return
    }
    const theme = await publishTheme(req.body)
    res.json({ theme })
  } catch (err) {
    console.error('Publish theme error:', err)
    res.status(500).json({ error: 'Failed to publish theme' })
  }
})

app.post('/api/themes/:id/install', async (req, res) => {
  try {
    await incrementInstalls(req.params.id)
    res.json({ success: true })
  } catch {
    res.json({ success: false })
  }
})

app.post('/api/themes/:id/report', async (req, res) => {
  try {
    await reportTheme(req.params.id)
    res.json({ success: true })
  } catch {
    res.json({ success: false })
  }
})

// --- Read model query API (premium tier) ---
// Served from the Postgres read model so clients answer cross-diagram queries
// without materializing the full Automerge model. Only mounted when READ_MODEL=on.
//
// One projector fleet serves EVERY active workspace — every endpoint reads its
// (landscapeId, versionId) from the query string (defaulting to the default
// workspace), ensures that workspace has a live projector, and scopes its
// read-model query by it.

/** Wrap an async handler so a thrown error becomes a 500 instead of crashing. */
type Handler = (req: express.Request, res: express.Response) => Promise<void>
// The wrapper AND the mapping both live in `routeErrors.ts` so they can be
// tested at all: this file boots a server on import, so nothing inlined here
// can be reached by a test.
// A `function` declaration and not a `const`: four call sites above this line
// rely on hoisting, and `const` turns them into TS2448 at build time.
function route(handler: Handler): express.RequestHandler {
  return routeHandler<express.Request, express.Response>(handler)
}
const idsParam = (v: unknown): string[] =>
  typeof v === 'string' && v.length ? v.split(',').filter(Boolean) : []
const intParam = (v: unknown, def: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}
const boolParam = (v: unknown): boolean | undefined =>
  v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : undefined
const boundedIdsParam = (v: unknown, max: number): string[] =>
  idsParam(v).slice(0, max).map((id) => id.slice(0, 256))

/** The fleet is constructed in main() once the Automerge repo exists (see the
 * projector boot call below) — module-level so both the boot call and the
 * routes registered here (at module scope, before main() runs) can share one
 * instance. app.listen() runs BEFORE the Automerge attach + fleet assignment,
 * so a client polling /api/model/* during boot can arrive while this is still
 * null — ensureWorkspace answers 503 (retryable) for that window. */
let readModelFleet: ProjectorFleet | null = null
/** Residency follows the live workspace: the ownership gate of the
 * sync server tells this of every document frame on a workspace this cell
 * owns, and it makes the fleet's projector resident without waiting for a read.
 * The fleet is handed LAZILY: `startAutomergeSync` runs before the fleet
 * exists (`readModelFleet` is assigned in the read-model bring-up below), and a
 * frame that arrives before then is counted, never an error — and not asked
 * for again before that client's NEXT frame.
 * The refusals the fleet is entitled to are the ones the read route's warm-up
 * tolerates (the read route reaches the static one only in a race thanks to
 * its cached pre-check; the residency would reach it every
 * window — which is why a non-retryable refusal is suppressed for ten minutes). */
const liveResidency = new LiveWorkspaceResidency({
  fleet: () => readModelFleet,
  // DERIVED from `classifyWarmupFailure` (`readModel/warmupOutcome.ts`), not
  // restated: one list of "refusals the fleet is entitled to" cannot drift.
  isExpectedRefusal: (error) => classifyWarmupFailure(error).expected,
})
/** Why the last background `ensure()` for a workspace did NOT make it
 * resident, so the 503 can name a cause instead of implying "still warming".
 * See `readModel/warmupOutcome.ts` for what this cost. */
const readModelWarmup = createWarmupOutcomeLog()
/** Shared durable repo for bounded document-backed APIs that do not require a
 * relational read-model projection (notably paged ADR baseline shards). */
let automergeRepo: Repo | null = null
/** The sync server's live socket registry, assigned in main(). Module-level so
 * the summary-migration routes (registered at module scope) can drain a
 * workspace's sockets after a contract change without threading it through. */
let automergeConnectionRegistry: ConnectionRegistry | null = null

/** (landscapeId, versionId) from the query string, defaulting to the default
 * workspace per the shared contract — every /api/model/* endpoint accepts
 * these as OPTIONAL params. */
function workspaceFromReq(req: express.Request): WorkspaceKey {
  const landscapeId = typeof req.query.landscapeId === 'string' && req.query.landscapeId ? req.query.landscapeId : undefined
  const versionId = typeof req.query.versionId === 'string' && req.query.versionId ? req.query.versionId : undefined
  if (!landscapeId && !versionId) return DEFAULT_WORKSPACE_KEY
  return {
    landscapeId: landscapeId ?? DEFAULT_WORKSPACE_KEY.landscapeId,
    versionId: versionId ?? DEFAULT_WORKSPACE_KEY.versionId,
  }
}

/** Ensure the request's workspace has a live projector + passes the access
 * check ('current' canonicalization + the stage-aware read gate both live in
 * rbac/workspaceGate.ts, shared with /api/automerge/root); writes the 404/403
 * response itself when it doesn't. Returns the CANONICAL key on success
 * (undefined otherwise — caller returns immediately); callers query ro_* with
 * that canonical key. */
async function ensureWorkspace(req: express.Request, res: express.Response): Promise<WorkspaceKey | undefined> {
  const key = await canonicalWorkspaceKey(pool, workspaceFromReq(req))
  if (!key) {
    res.status(404).json({ error: 'workspace not found' })
    return undefined
  }
  if (!(await checkWorkspaceAccess(pool, req, key))) {
    res.status(403).json({ error: 'forbidden' })
    return undefined
  }
  if (!readModelFleet) {
    // Boot window: the HTTP server listens before the Automerge repo + fleet
    // exist. Retryable, not a 404 — the workspace may well exist.
    //
    // It carries its own `reason`, like every other 503 here: the drill
    // retries every 503 identically, so a cause must never have to be
    // inferred from an absent field.
    res.setHeader('Retry-After', '2')
    res.status(503).json({ error: 'read model warming up', retryable: true, reason: 'server_booting' })
    return undefined
  }
  if (syncCellOwnership?.enabled && !syncCellOwnership.owns(key)) {
    // TWO REASONS, which must not share one code.
    //
    // Temporary: the routing middleware checked ownership before entering this
    // handler, but a lease may be lost while auth/canonicalization is in flight.
    // Waiting fixes that.
    //
    // Permanent: ownership can only own an `active` version, and
    // `canonicalWorkspaceKey` resolves only the `current` alias — a concrete id
    // for a retired or merged version arrives here untouched. No cell will EVER
    // own it, so a retryable 503 is a refusal that never lifts, retried for
    // ever, wearing the shape of ordinary contention.
    const refusal = await classifyWorkspaceRefusal(pool, key)
    if (refusal.kind === 'not-servable') {
      res.status(refusal.status).json({
        error: 'workspace is no longer served',
        retryable: false,
        versionStatus: refusal.versionStatus,
      })
      return undefined
    }
    res.setHeader('Retry-After', '1')
    res.status(refusal.status).json({
      error: 'workspace owner changed',
      retryable: true,
      reason: 'workspace_owner_changed',
    })
    return undefined
  }
  // A performance baseline is materialized transactionally by its seed. Its
  // edits use bounded Automerge overlays + the active DiagramDoc, so serving the
  // baseline must not start an O(500k) cold build merely to attach every shard.
  const staticQueryKey = await staticReadModelQueryWorkspaceIfPresent(pool, key)
  if (staticQueryKey) return staticQueryKey
  if (!readModelFleet.isResident(key)) {
    // Never make an interactive request await an O(workspace) cold build. The
    // fleet memoizes the background start; callers retry the bounded query.
    void readModelFleet.ensure(key).then(
      // `false` means "no root URL" — `ProjectorFleet.ensure`'s own docstring
      // says "caller should 404", and this caller discarded the boolean and
      // answered a retryable 503 for ever. The status is unchanged here (two
      // sibling ADR handlers below DO 404 on the same condition, so the
      // divergence is worth deciding deliberately rather than in passing);
      // what changes is that the answer now says which.
      (started) => readModelWarmup.noteSettled(key, started),
      (error) => {
        // Queue saturation is expected backpressure: the 503 below makes the
        // caller retry. Log only unexpected failures to avoid one warning per
        // browser retry during a recovery burst — the expected ones are now
        // recorded (once per transition) instead of vanishing, which is what
        // left the backup drill's cold-API stage reporting a 118 s give-up
        // with no cause for 24 consecutive runs.
        //
        // A workspace promoted to the summary contract between the static
        // lookup above and this call is served by the StaticDeltaProjector;
        // the ordinary fleet refusing it is the design, not a failure.
        if (!readModelWarmup.noteFailed(key, error).expected) {
          console.error(`[read-model] background warm-up failed for ${key.landscapeId}/${key.versionId}`, error)
        }
      },
    )
    // The verdict is composed in `warmupOutcome.ts`, not here: `retryable` is
    // per REASON (and about the REQUEST, which is not the question the error
    // classes' own `retryable` answers), and it carries the verdict's AGE
    // because a stored reason is a fact about the past — after a queue-full
    // refusal, a real 26-35 s cold build would otherwise keep blaming
    // admission backpressure, and the drill keeps only the LAST detail.
    const verdict = readModelWarmup.verdictFor(key)
    // Only when a retry can actually clear it. 503 + `Retry-After` is a promise
    // to intermediaries as well as to clients, and for an unresolvable root it
    // is a promise nothing can keep — which is why the drill burned its whole
    // 120 s deadline on a workspace that had been deleted.
    if (verdict.retryable) res.setHeader('Retry-After', '2')
    res.status(503).json({
      error: verdict.retryable ? 'read model warming up' : 'workspace has no resolvable root',
      ...verdict,
    })
    return undefined
  }
  // A read is a use: without `touch` the fleet's LRU would be FIFO.
  readModelFleet.touch(key)
  return key
}

interface SerializedJsonResponse {
  body: string
}

async function sendSerializedJson(
  req: Request,
  res: Response,
  timing: ServerTimingTrace,
  value: SerializedJsonResponse,
): Promise<void> {
  res.type('application/json')
  if (req.acceptsEncodings('gzip') === 'gzip') {
    const encoded = await timing.measure('encode', () => gzipSerializedBody(value, value.body))
    res.vary('Accept-Encoding')
    res.setHeader('Content-Encoding', 'gzip')
    res.setHeader('Content-Length', String(encoded.byteLength))
    timing.write(res)
    res.send(encoded)
    return
  }
  timing.write(res)
  res.send(value.body)
}

app.post('/api/model/overlay-batches/status', route(async (req, res) => {
  const key = await canonicalWorkspaceKey(pool, workspaceFromReq(req))
  if (!key) { res.status(404).json({ error: 'workspace not found' }); return }
  if (!(await checkWorkspaceAccess(pool, req, key))) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  const raw: unknown[] = Array.isArray(req.body?.batchIds) ? req.body.batchIds : []
  const batchIds: string[] = [...new Set(raw.filter((value): value is string => (
    typeof value === 'string' && value.length > 0 && value.length <= 200
  )))]
  if (!batchIds.length || batchIds.length > 1_000) {
    res.status(400).json({ error: 'batchIds must contain 1..1000 stable ids' })
    return
  }
  res.setHeader('Cache-Control', 'private, no-store')
  res.json({ batches: await overlayBatchStatuses(pool, key, batchIds) })
}))

app.get('/api/model/decision-records/page', route(async (req, res) => {
  const timing = new ServerTimingTrace()
  const key = await timing.measure('workspace', () => canonicalWorkspaceKey(pool, workspaceFromReq(req)))
  if (!key) { res.status(404).json({ error: 'workspace not found' }); return }
  if (!(await checkWorkspaceAccess(pool, req, key))) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  const staticQueryKey = await staticReadModelQueryWorkspaceIfPresent(pool, key)
  if (staticQueryKey) {
    res.setHeader('Cache-Control', 'private, no-cache')
    const options = {
      offset: intParam(req.query.offset, 0),
      limit: intParam(req.query.limit, 100),
      query: req.query.q ? String(req.query.q) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      relatedTargetId: req.query.relatedTargetId ? String(req.query.relatedTargetId) : undefined,
      relatedType: req.query.relatedType ? String(req.query.relatedType) : undefined,
      after: req.query.after ? String(req.query.after) : null,
    }
    const response = await timing.measure('query', () => boundedReadSingleFlight.run(
      JSON.stringify(['decision-records', staticQueryKey, options]),
      async () => ({ body: JSON.stringify(await roDecisionRecordPage(pool, staticQueryKey, options)) }),
    ))
    await sendSerializedJson(req, res, timing, response)
    return
  }
  if (!automergeRepo) {
    res.setHeader('Retry-After', '1')
    res.status(503).json({ error: 'automerge repository warming up', retryable: true })
    return
  }
  const rootUrl = await resolveRootUrl(key.landscapeId, key.versionId, '')
  if (!rootUrl) { res.status(404).json({ error: 'workspace root not found' }); return }
  const resolve = async (url: string): Promise<unknown> => (
    await resolveHandleWithRetry(automergeRepo!, url, { tries: 3, delayMs: 200, deadlineMs: HTTP_RESOLVE_DEADLINE_MS })
  ).doc()
  const root = await resolve(rootUrl) as { modelUrl?: string; modelMetaUrl?: string } | undefined
  const page = await readDecisionRecordPage(
    root,
    resolve,
    intParam(req.query.offset, 0),
    intParam(req.query.limit, 100),
  )
  if (!page) { res.status(404).json({ error: 'decision records not found' }); return }
  res.setHeader('Cache-Control', 'private, no-cache')
  res.json({ ...page, serverFiltered: false, detailsIncluded: true })
}))

app.get('/api/model/decision-records/:id', route(async (req, res) => {
  const key = await canonicalWorkspaceKey(pool, workspaceFromReq(req))
  if (!key) { res.status(404).json({ error: 'workspace not found' }); return }
  if (!(await checkWorkspaceAccess(pool, req, key))) {
    res.status(403).json({ error: 'forbidden' })
    return
  }

  const id = String(req.params.id)
  let record: unknown
  const staticQueryKey = await staticReadModelQueryWorkspaceIfPresent(pool, key)
  if (staticQueryKey) {
    record = await roDecisionRecordDetail(pool, staticQueryKey, id)
  } else {
    if (!automergeRepo) {
      res.setHeader('Retry-After', '1')
      res.status(503).json({ error: 'automerge repository warming up', retryable: true })
      return
    }
    const rootUrl = await resolveRootUrl(key.landscapeId, key.versionId, '')
    if (!rootUrl) { res.status(404).json({ error: 'workspace root not found' }); return }
    const resolve = async (url: string): Promise<unknown> => (
      await resolveHandleWithRetry(automergeRepo!, url, { tries: 3, delayMs: 200, deadlineMs: HTTP_RESOLVE_DEADLINE_MS })
    ).doc()
    const root = await resolve(rootUrl) as { modelUrl?: string; modelMetaUrl?: string } | undefined
    record = await readDecisionRecordDetail(root, resolve, id)
  }

  if (!record) { res.status(404).json({ error: 'not found' }); return }
  res.setHeader('Cache-Control', 'private, no-cache')
  res.json({ record })
}))

if (READ_MODEL_ENABLED) {
  // Process-local operational counters only: no workspace identifiers or model
  // payload. Restricted to platform administrators because hit rate and memory
  // pressure still reveal deployment workload characteristics.
  app.get('/api/platform/read-model/render-cache', route(async (req, res) => {
    if (!requirePlatformAdminAtStageOn(req, res)) return
    res.json({
      generatedAt: new Date().toISOString(),
      config: renderCacheConfig,
      sharedConfig: redisRenderCacheRuntime.configured ? redisRenderCacheConfig : null,
      sharedRuntime: redisRenderCacheRuntime.snapshot(),
      ...diagramRenderCache.snapshot(),
    })
  }))

  app.get('/api/platform/read-model/projector-fleet', route(async (req, res) => {
    if (!requirePlatformAdminAtStageOn(req, res)) return
    res.json({
      generatedAt: new Date().toISOString(),
      ...(readModelFleet?.snapshot() ?? {
        ...coldBuildAdmission.snapshot(),
        residentProjectors: 0,
        inFlightWorkspaces: 0,
        maxProjectors: null,
        fleetStopped: false,
        foreignResidentProjectors: 0,
        ownershipRejectedStarts: 0,
        ownershipEvictions: 0,
      }),
      // Bounded document-resolution pressure across every resident projector.
      // `activeTimers` is expected to equal `queues`: one wake timer per
      // workspace, never one per missing document.
      documentRetries: documentRetryRegistry.snapshot(),
      // How often the sync path made a projector resident on its own,
      // beside how often a read had to. `ensuresRequested` growing while
      // `alreadyResident` stays flat is a fleet that keeps evicting what the
      // sockets keep re-warming — the cap is too small for the live set.
      liveResidency: liveResidency.snapshot(),
    })
  }))

  app.get('/api/model/cache/estimate', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json(await roOfflineCacheEstimate(pool, key))
  }))
  app.get('/api/model/cache/connections', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json(await roConnectionCachePage(pool, key, {
      after: typeof req.query.after === 'string' ? req.query.after : null,
      limit: intParam(req.query.limit, 500),
    }))
  }))
  app.get('/api/model/cache/connections/by-ids', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json(await roConnectionCacheByIds(pool, key, boundedIdsParam(req.query.ids, 500)))
  }))
  app.get('/api/model/cache/connections/by-endpoints', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json(await roConnectionCacheByEndpointIds(
      pool,
      key,
      boundedIdsParam(req.query.ids, 100),
      {
        after: typeof req.query.after === 'string' ? req.query.after : null,
        limit: intParam(req.query.limit, 500),
      },
    ))
  }))
  app.get('/api/model/cache/events', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    try {
      await readModelChangeHub.start()
    } catch {
      res.setHeader('Retry-After', '2')
      res.status(503).json({ error: 'read model event stream unavailable', retryable: true })
      return
    }

    const headerGeneration = intParam(req.get('Last-Event-ID'), 0)
    const queryGeneration = intParam(req.query.afterGeneration, 0)
    let lastSentGeneration = Math.max(0, headerGeneration, queryGeneration)
    let pendingGeneration: number | null = null
    let blocked = false
    let ready = false
    let closed = false
    let heartbeat: NodeJS.Timeout | null = null

    const writeGeneration = (generation: number): void => {
      if (closed || generation <= lastSentGeneration) return
      if (!ready || blocked) {
        pendingGeneration = Math.max(pendingGeneration ?? 0, generation)
        return
      }
      const accepted = res.write(
        `id: ${generation}\nevent: invalidate\ndata: ${JSON.stringify({ generation })}\n\n`,
      )
      lastSentGeneration = generation
      blocked = !accepted
    }

    const unsubscribe = readModelChangeHub.subscribe(key, (event) => writeGeneration(event.generation))
    const cleanup = () => {
      if (closed) return
      closed = true
      unsubscribe()
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      res.off('drain', onDrain)
    }
    const onDrain = () => {
      blocked = false
      const generation = pendingGeneration
      pendingGeneration = null
      if (generation !== null) writeGeneration(generation)
    }
    req.once('close', cleanup)
    res.once('close', cleanup)
    res.on('drain', onDrain)

    // Query after subscribing. Any notification racing this query is buffered,
    // and the durable generation catches a commit that happened just before the
    // subscription was registered.
    let currentGeneration: number
    try {
      currentGeneration = (await roReadModelChanges(pool, key, {
        afterGeneration: lastSentGeneration,
        limit: 1,
      })).projectionGeneration
    } catch (error) {
      cleanup()
      throw error
    }
    if (closed) return

    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    res.write(`retry: 2000\nevent: ready\ndata: ${JSON.stringify({ generation: currentGeneration })}\n\n`)
    ready = true
    writeGeneration(Math.max(currentGeneration, pendingGeneration ?? 0))
    pendingGeneration = null
    heartbeat = setInterval(() => {
      if (!closed && !blocked) blocked = !res.write(': heartbeat\n\n')
    }, 25_000)
    heartbeat.unref()
  }))
  app.get('/api/model/cache/changes', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json(await roReadModelChanges(pool, key, {
      afterGeneration: intParam(req.query.afterGeneration, 0),
      limit: intParam(req.query.limit, 100),
    }))
  }))
  app.get('/api/model/cache/objects', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json(await roObjectCachePage(pool, key, {
      after: typeof req.query.after === 'string' ? req.query.after : null,
      limit: intParam(req.query.limit, 500),
    }))
  }))
  app.get('/api/model/cache/objects/by-ids', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json(await roObjectCacheByIds(pool, key, boundedIdsParam(req.query.ids, 500)))
  }))
  app.get('/api/model/cache/diagrams/by-ids', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json(await roDiagramCacheByIds(pool, key, boundedIdsParam(req.query.ids, 500)))
  }))
  app.get('/api/model/cache/diagrams', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json(await roDiagramCachePage(pool, key, {
      after: typeof req.query.after === 'string' ? req.query.after : null,
      limit: intParam(req.query.limit, 500),
    }))
  }))
  app.get('/api/model/connections/page', route(async (req, res) => {
    const timing = new ServerTimingTrace()
    const key = await timing.measure('workspace', () => ensureWorkspace(req, res))
    if (!key) return
    const options = {
      query: typeof req.query.q === 'string' ? req.query.q : '',
      domainId: typeof req.query.domainId === 'string' ? req.query.domainId : null,
      sortBy: typeof req.query.sortBy === 'string' ? req.query.sortBy as 'name' | 'sender' | 'receiver' | 'diagrams' | 'flows' : 'name',
      sortAsc: boolParam(req.query.sortAsc) ?? true,
      after: typeof req.query.after === 'string' ? req.query.after : null,
      limit: intParam(req.query.limit, 50),
    }
    const response = await timing.measure('query', () => boundedReadSingleFlight.run(
      JSON.stringify(['connections', key, options]),
      async () => {
        const client = await timing.measure('pool_wait', () => pool.connect())
        try {
          const page = await roConnectionExplorerPage(client, key, options, timing)
          return { body: timing.measureSync('serialize', () => JSON.stringify(page)) }
        } finally {
          client.release()
        }
      },
    ))
    await sendSerializedJson(req, res, timing, response)
  }))
  app.get('/api/model/dependencies/page', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    const focusId = typeof req.query.focus === 'string' ? req.query.focus.slice(0, 256) : ''
    if (!focusId) {
      res.status(400).json({ error: 'focus is required' })
      return
    }
    const options = {
      focusId,
      direction: req.query.direction === 'incoming' ? 'incoming' : 'outgoing',
      search: typeof req.query.q === 'string' ? req.query.q : '',
      globalSearch: typeof req.query.globalQ === 'string' ? req.query.globalQ : '',
      domainId: typeof req.query.domainId === 'string' ? req.query.domainId : null,
      after: typeof req.query.after === 'string' ? req.query.after : null,
      limit: intParam(req.query.limit, 10),
    } as const
    const timing = new ServerTimingTrace()
    const response = await timing.measure('query', () => boundedReadSingleFlight.run(
      JSON.stringify(['dependencies', key, options]),
      async () => ({ body: JSON.stringify(await roDependencyPeerPage(pool, key, options)) }),
    ))
    await sendSerializedJson(req, res, timing, response)
  }))
  app.get('/api/model/viewer/level', route(async (req, res) => {
    const timing = new ServerTimingTrace()
    const key = await timing.measure('workspace', () => ensureWorkspace(req, res))
    if (!key) return
    const options = {
      parentId: typeof req.query.parentId === 'string' ? req.query.parentId : null,
      query: typeof req.query.q === 'string' ? req.query.q : '',
      domainIds: boundedIdsParam(req.query.domainIds, 100),
      after: typeof req.query.after === 'string' ? req.query.after : null,
      limit: intParam(req.query.limit, 200),
      connectionLimit: intParam(req.query.connectionLimit, 1_000),
    }
    const response = await timing.measure('query', () => boundedReadSingleFlight.run(
      JSON.stringify(['viewer', key, options]),
      async () => {
        const client = await timing.measure('pool', () => pool.connect())
        try {
          await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
          const page = await roViewerLevel(client, key, options)
          await client.query('COMMIT')
          return { body: timing.measureSync('serialize', () => JSON.stringify(page)) }
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          client.release()
        }
      },
    ))
    await sendSerializedJson(req, res, timing, response)
  }))
  app.get('/api/model/tree/children', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json(await roObjectTreeChildren(pool, key, {
      parentId: typeof req.query.parentId === 'string' ? req.query.parentId.slice(0, 256) : null,
      diagramId: typeof req.query.diagramId === 'string' ? req.query.diagramId.slice(0, 256) : null,
      after: typeof req.query.after === 'string' ? req.query.after : null,
      limit: intParam(req.query.limit, 50),
    }))
  }))
  app.get('/api/model/objects/search', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 256) : ''
    const types = boundedIdsParam(req.query.types, 16)
    const technologyIds = boundedIdsParam(req.query.technologyIds, 50)
    const tagIds = boundedIdsParam(req.query.tagIds, 100)
    const statuses = boundedIdsParam(req.query.statuses, 16)
    const teamIds = boundedIdsParam(req.query.teamIds, 100)
    const scope = typeof req.query.scope === 'string' ? req.query.scope.slice(0, 32) : undefined
    const hasDescription = boolParam(req.query.hasDescription)
    const inDiagram = boolParam(req.query.inDiagram)
    const externalOnSomeDiagram = boolParam(req.query.externalOnSomeDiagram)
    const domainId = typeof req.query.domainId === 'string' ? req.query.domainId.slice(0, 256) : undefined
    const queryError = objectSearchQueryError(query)
    if (queryError) {
      res.status(400).json({ error: queryError })
      return
    }
    res.json(await roObjectSearchPage(pool, key, {
      query,
      diagramId: typeof req.query.diagramId === 'string' ? req.query.diagramId.slice(0, 256) : null,
      filter: { types, technologyIds, tagIds, statuses, teamIds, scope, hasDescription, inDiagram, externalOnSomeDiagram, domainId },
      after: typeof req.query.after === 'string' ? req.query.after : null,
      limit: intParam(req.query.limit, 50),
    }))
  }))
  app.get('/api/model/object/:id', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    const object = await roObject(pool, key, String(req.params.id))
    if (!object) { res.status(404).json({ error: 'not found' }); return }
    res.json({ object })
  }))
  app.get('/api/model/group/:id', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    const group = await roGroup(pool, key, String(req.params.id))
    if (!group) { res.status(404).json({ error: 'not found' }); return }
    res.json({ group })
  }))
  app.get('/api/model/connection/:id', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    const connection = await roConnection(pool, key, String(req.params.id))
    if (!connection) { res.status(404).json({ error: 'not found' }); return }
    res.json({ connection })
  }))
  app.get('/api/model/lookup', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    const map = await roLookupMany(pool, key, idsParam(req.query.ids))
    res.json({ entities: [...map.entries()] })
  }))
  // Durability witness for the client's crash-journal replay: objects AND
  // connections batched in one round trip, WITH the projection-freshness signal
  // that decides whether an absent id is a proof of absence. The single-entity
  // routes above carry no freshness, so their 404 is unusable for that.
  // POST because 500 long (imported) ids overflow request-line/header limits on
  // GET (HTTP 431 at 40-char ids).
  app.post('/api/model/durability-witness', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    const boundedIdsBody = (value: unknown): string[] => (
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
          .slice(0, 500)
          .map((entry) => entry.slice(0, 256))
        : []
    )
    const body = (req.body ?? {}) as { objects?: unknown; connections?: unknown }
    const objectIds = boundedIdsBody(body.objects)
    const connectionIds = boundedIdsBody(body.connections)
    // The whole contract (freshness-then-entities ordering, resolved-workspace
    // echo, the absenceProvable field) lives in durabilityWitnessPayload —
    // assembled and TESTED there; this route only parses and transmits.
    res.json(await durabilityWitnessPayload(pool, key, objectIds, connectionIds))
  }))
  app.get('/api/model/dependencies', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    const focus = String(req.query.focus ?? '')
    const [incoming, outgoing] = await Promise.all([roIncoming(pool, key, focus), roOutgoing(pool, key, focus)])
    res.json({ incoming, outgoing })
  }))
  app.get('/api/model/connection-count', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json({ count: await roConnectionCount(pool, key, String(req.query.id ?? '')) })
  }))
  app.get('/api/model/diagram-meta', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    const diagramId = String(req.query.id ?? '')
    let diagram = await roDiagramMeta(pool, key, diagramId)
    if (!diagram) { res.status(404).json({ error: 'not found' }); return }
    // `ensureWorkspace` maps a sparse draft to its parent's query plane. Before
    // returning an editable DiagramDoc URL, lazily fork that one document into
    // the draft so a canvas edit can never bleed into the live model.
    const requestedKey = await canonicalWorkspaceKey(pool, workspaceFromReq(req))
    if (requestedKey && requestedKey.versionId !== key.versionId) {
      if (!automergeRepo) {
        res.setHeader('Retry-After', '1')
        res.status(503).json({ error: 'automerge repository warming up', retryable: true })
        return
      }
      diagram = await ensureSparseDraftDiagram(
        automergeRepo,
        requestedKey.landscapeId,
        requestedKey.versionId,
        diagramId,
        diagram,
      )
      if (!diagram) { res.status(404).json({ error: 'not found in draft base' }); return }
    }
    const view = req.query.view
    res.json({ diagram: view === 'first-paint'
      ? toFirstPaintDiagramMeta(diagram)
      : view === 'editor'
        ? toDiagramEditorMeta(diagram)
        : diagram })
  }))
  app.get('/api/model/diagrams/page', route(async (req, res) => {
    const timing = new ServerTimingTrace()
    const key = await timing.measure('workspace', () => ensureWorkspace(req, res))
    if (!key) return
    res.setHeader('Cache-Control', 'private, no-cache')
    const options = {
      offset: intParam(req.query.offset, 0),
      limit: intParam(req.query.limit, 60),
      query: req.query.q ? String(req.query.q) : undefined,
      type: req.query.type ? String(req.query.type) : undefined,
      domainId: req.query.domainId ? String(req.query.domainId) : undefined,
      after: req.query.after ? String(req.query.after) : null,
    }
    const response = await timing.measure('query', () => boundedReadSingleFlight.run(
      JSON.stringify(['diagrams', key, options]),
      async () => ({ body: JSON.stringify(await roDiagramListPage(pool, key, options)) }),
    ))
    await sendSerializedJson(req, res, timing, response)
  }))
  app.get('/api/model/descendants', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json({ ids: await roDescendants(pool, key, String(req.query.object ?? '')) })
  }))
  app.get('/api/model/related-diagrams', route(async (req, res) => {
    const timing = new ServerTimingTrace()
    const key = await timing.measure('workspace', () => ensureWorkspace(req, res))
    if (!key) return
    const related = await timing.measure('query', () => roRelatedDiagrams(
      pool,
      key,
      String(req.query.object ?? ''),
      req.query.current ? String(req.query.current) : null,
      {
        query: req.query.q ? String(req.query.q) : undefined,
        limit: intParam(req.query.limit, 50),
      },
    ))
    const body = timing.measureSync('serialize', () => JSON.stringify(related))
    timing.write(res)
    res.type('application/json').send(body)
  }))
  app.get('/api/model/entity-flows', route(async (req, res) => {
    const timing = new ServerTimingTrace()
    const key = await timing.measure('workspace', () => ensureWorkspace(req, res))
    if (!key) return
    const kind = req.query.kind === 'connection' ? 'connection' : req.query.kind === 'object' ? 'object' : null
    if (!kind) {
      res.status(400).json({ error: 'kind must be object or connection' })
      return
    }
    const flows = await timing.measure('query', () => roEntityFlows(
      pool,
      key,
      kind,
      String(req.query.id ?? '').slice(0, 256),
      {
        limit: intParam(req.query.limit, 50),
        excludeDiagramId: typeof req.query.excludeDiagram === 'string' && req.query.excludeDiagram
          ? req.query.excludeDiagram.slice(0, 256) : null,
      },
    ))
    // `ensureWorkspace` answers a sparse draft from its BASE version's rows.
    // A draft's DiagramDocs fork lazily and nothing projects their flows into
    // the base, so the base's witnesses certify flows the draft may have
    // changed: never call that answer complete.
    const requestedKey = await canonicalWorkspaceKey(pool, workspaceFromReq(req))
    if (requestedKey && requestedKey.versionId !== key.versionId) flows.complete = false
    const body = timing.measureSync('serialize', () => JSON.stringify(flows))
    timing.write(res)
    res.type('application/json').send(body)
  }))
  app.get('/api/model/entity-diagrams', route(async (req, res) => {
    const timing = new ServerTimingTrace()
    const key = await timing.measure('workspace', () => ensureWorkspace(req, res))
    if (!key) return
    const kind = req.query.kind === 'group' ? 'group' : req.query.kind === 'connection' ? 'connection' : null
    if (!kind) {
      res.status(400).json({ error: 'kind must be group or connection' })
      return
    }
    const diagrams = await timing.measure('query', () => roEntityDiagrams(
      pool,
      key,
      kind,
      String(req.query.id ?? '').slice(0, 256),
      { limit: intParam(req.query.limit, 50) },
    ))
    const body = timing.measureSync('serialize', () => JSON.stringify(diagrams))
    timing.write(res)
    res.type('application/json').send(body)
  }))
  app.post('/api/model/related-diagram-object-ids', route(async (req, res) => {
    const timing = new ServerTimingTrace()
    const key = await timing.measure('workspace', () => ensureWorkspace(req, res))
    if (!key) return
    const rawObjectIds: unknown[] = Array.isArray(req.body?.objectIds) ? req.body.objectIds : []
    const objectIds = rawObjectIds.filter((id: unknown): id is string => typeof id === 'string')
    const ids = await timing.measure('query', () => roRelatedDiagramObjectIds(
      pool,
      key,
      objectIds,
      req.query.current ? String(req.query.current) : null,
    ))
    const body = timing.measureSync('serialize', () => JSON.stringify({ ids }))
    timing.write(res)
    res.type('application/json').send(body)
  }))
  app.get('/api/model/search', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json({ hits: await roSearch(pool, key, String(req.query.q ?? ''), intParam(req.query.limit, 12)) })
  }))
  app.get('/api/model/page-objects', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json(await roPageObjects(pool, key, {
      after: req.query.after ? String(req.query.after) : null,
      limit: intParam(req.query.limit, 100),
      domainId: req.query.domainId ? String(req.query.domainId) : null,
    }))
  }))
  app.get('/api/model/filter-objects', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json(await roFilteredObjectTree(
      pool,
      key,
      {
        technologyIds: idsParam(req.query.technologyIds),
        types: idsParam(req.query.types),
        tagIds: idsParam(req.query.tagIds),
        statuses: idsParam(req.query.statuses),
        teamIds: idsParam(req.query.teamIds),
        scope: typeof req.query.scope === 'string' ? req.query.scope : undefined,
        hasDescription: boolParam(req.query.hasDescription),
        inDiagram: boolParam(req.query.inDiagram),
      },
      {
        search: typeof req.query.search === 'string' ? req.query.search.slice(0, 500) : undefined,
        domainId: typeof req.query.domainId === 'string' ? req.query.domainId : null,
      }
    ))
  }))
  app.get('/api/model/object-facets', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json(await roModelObjectFacets(pool, key))
  }))
  app.get('/api/model/page-connections', route(async (req, res) => {
    const key = await ensureWorkspace(req, res)
    if (!key) return
    res.json(await roPageConnections(pool, key, {
      after: req.query.after ? String(req.query.after) : null,
      limit: intParam(req.query.limit, 100),
    }))
  }))
  // Everything needed to render a diagram (objects + groups + persisted connections
  // + computed lower roll-ups) so a client draws it without the whole model. (Boot
  // fix step 2.)
  app.get('/api/model/diagram-render', route(async (req, res) => {
    const timing = new ServerTimingTrace()
    const key = await timing.measure('workspace', () => ensureWorkspace(req, res))
    if (!key) return
    // RBAC above deliberately precedes every cache lookup. The cached payload is
    // shared only after the caller has proved read access to this workspace.
    const diagramId = String(req.query.id ?? '')
    const firstPaint = req.query.view === 'first-paint'
    // The current editor consumes the complete entity contract, but can still
    // opt into dependency-scoped caching. Compact first-paint DTOs use the same
    // scope once their lazy editor hydration is enabled client-side.
    const dependencyScoped = firstPaint || req.query.cacheScope === 'diagram'
    const { projectionGeneration, staticBaselineEpoch } = await timing.measure(
      'render_context',
      () => diagramRenderContextLoader.load(key),
    )
    const staticReadModel = staticBaselineEpoch !== undefined
    const diagramGeneration = staticReadModel && dependencyScoped
      ? await timing.measure('diagram_generation', () => roDiagramRenderGeneration(pool, key, diagramId))
      : projectionGeneration
    const cacheGeneration = selectDiagramRenderCacheGeneration({
      staticReadModel,
      dependencyScoped,
      workspaceGeneration: projectionGeneration,
      diagramGeneration,
    })
    const cached = await timing.measure('cache', () => diagramRenderCache.getOrLoad(
      {
        ...key,
        diagramId,
        projectionGeneration: cacheGeneration,
        variant: firstPaint ? 'first-paint' : dependencyScoped ? 'diagram-full' : 'full',
        baselineEpoch: staticBaselineEpoch,
      },
      async () => {
        // Every query contributing to the render must observe the same projection.
        // Without a repeatable-read snapshot, a projector commit between the object
        // and connection queries could create a mixed-generation cache entry.
        const client = await pool.connect()
        try {
          await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
          const render = await timing.measure('render', () => roDiagramRender(client, key, diagramId, {
            computeLowerConnections: !staticReadModel,
          }))
          const actualDiagramGeneration = render && staticReadModel && dependencyScoped
            ? await roDiagramRenderGeneration(client, key, diagramId)
            : render?.projectionGeneration ?? cacheGeneration
          await client.query('COMMIT')
          return render ? {
            projectionGeneration: render.projectionGeneration,
            cacheGeneration: selectDiagramRenderCacheGeneration({
              staticReadModel,
              dependencyScoped,
              workspaceGeneration: render.projectionGeneration,
              diagramGeneration: actualDiagramGeneration,
            }),
            body: timing.measureSync('serialize', () => JSON.stringify(
              firstPaint ? toFirstPaintDiagramRender(render, actualDiagramGeneration) : render,
            )),
          } : undefined
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          client.release()
        }
      }
    ))
    if (!cached.value) {
      timing.write(res)
      res.status(404).json({ error: 'not found' })
      return
    }

    const renderGeneration = cached.value.cacheGeneration ?? cached.value.projectionGeneration
    const etag = dependencyScoped
      ? `W/"rm-${firstPaint ? 'fp' : 'dg'}-${renderGeneration}-${cached.value.projectionGeneration}"`
      : `W/"rm-${cached.value.projectionGeneration}"`
    res.setHeader('Cache-Control', 'private, no-cache')
    res.setHeader('ETag', etag)
    res.setHeader('X-Read-Model-Generation', String(cached.value.projectionGeneration))
    // A dependency-cache hit may intentionally serve an older but still valid
    // payload snapshot. Future first-paint clients advance their SSE cursor with
    // this current workspace token, not the body snapshot token.
    res.setHeader('X-Read-Model-Workspace-Generation', String(projectionGeneration))
    res.setHeader('X-Read-Model-Render-Generation', String(renderGeneration))
    res.setHeader('X-Read-Model-Render-Cache', cached.status)
    res.setHeader('X-Read-Model-Render-Bytes', String(Buffer.byteLength(cached.value.body, 'utf8')))
    if (req.fresh) { timing.write(res); res.status(304).end(); return }
    res.type('application/json')
    if (req.acceptsEncodings('gzip') === 'gzip') {
      const encoded = await timing.measure('encode', () =>
        gzipSerializedBody(cached.value!, cached.value!.body))
      res.vary('Accept-Encoding')
      res.setHeader('Content-Encoding', 'gzip')
      res.setHeader('Content-Length', String(encoded.byteLength))
      timing.write(res)
      res.send(encoded)
      return
    }
    timing.write(res)
    res.send(cached.value.body)
  }))
}

app.get('/api/platform/maintenance', route(async (req, res) => {
  if (!requirePlatformAdminAtStageOn(req, res)) return
  if (!maintenanceCoordinator) {
    res.status(503).json({ error: 'maintenance coordinator warming up' })
    return
  }
  res.json(await maintenanceCoordinator.clusterSnapshot())
}))

/**
 * Cross-entity references whose target no longer exists.
 *
 * REPORT ONLY — nothing here mutates. Repair writes Automerge documents
 * directly and so bypasses the RBAC write gate, which is a different
 * authorization story and lands separately.
 *
 * Platform admin only, like every other route in this block: the report names
 * entity ids across every workspace in the deployment.
 */
app.get('/api/platform/reference-integrity', route(async (req, res) => {
  if (!requirePlatformAdminAtStageOn(req, res)) return
  if (!READ_MODEL_ENABLED) {
    res.status(503).json({ error: 'read model is disabled; the reference scan has nothing to read' })
    return
  }
  const landscapeId = typeof req.query.landscapeId === 'string' ? req.query.landscapeId : undefined
  const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : undefined
  const rawLimit = Number(req.query.limit)
  const scoped = Boolean(landscapeId && versionId)
  const sql = await scanReferenceIntegrity(pool, {
    // Both or neither: a landscape without a version would silently sweep every
    // version of it, which is not what a caller asking for one workspace meant.
    ...(scoped ? { landscapeId: landscapeId!, versionId: versionId! } : {}),
    ...(Number.isSafeInteger(rawLimit) && rawLimit > 0 ? { limit: Math.min(rawLimit, 5_000) } : {}),
  })

  // The document leg is opt-in and workspace-scoped: it opens one Automerge
  // document per diagram, which the SQL leg never does. Off by default so the
  // ordinary report stays a few indexed queries.
  if (req.query.documents !== 'true') {
    res.json(sql)
    return
  }
  if (!scoped) {
    res.status(400).json({ error: 'documents=true requires landscapeId and versionId — the walk is per-workspace' })
    return
  }
  if (!automergeRepo) {
    res.status(503).json({ error: 'automerge repo warming up' })
    return
  }
  const { rows } = await pool.query<{ root_url: string }>(
    `SELECT root_url FROM versions WHERE landscape_id = $1 AND id = $2`, [landscapeId, versionId])
  if (!rows[0]?.root_url) {
    res.status(404).json({ error: `no root document for workspace ${landscapeId}/${versionId}` })
    return
  }
  const documents = await scanDocumentReferences(pool, automergeRepo, rows[0].root_url, {
    landscapeId: landscapeId!,
    versionId: versionId!,
  })
  res.json({
    ...sql,
    documents,
    // What NEITHER leg looked at, so a combined report still cannot be mistaken
    // for a clean model.
    uncheckedKinds: sql.uncheckedKinds.filter(
      (kind) => !(DOCUMENT_CHECKED_KINDS as readonly string[]).includes(kind),
    ),
  })
}))

/**
 * Repair the references the scan found dangling.
 *
 * Dry run is the DEFAULT: `apply` must be sent explicitly. The workspace is
 * required rather than optional, so a fleet-wide apply cannot be reached by
 * leaving a field out. Every applied run is audited, because this writes
 * Automerge documents directly and so bypasses the RBAC write gate entirely.
 *
 * AN APPLY CAN COME BACK 503. It is the fourth door on the lifecycle apply
 * key, alongside promote / demote / repair-summary-flag. A refusal is `LifecycleApplyRefusedError` → 503 +
 * `retryable`, and NOTHING was written when it happens. The dry run is
 * deliberately not gated: it is the report an operator reads precisely when a
 * promotion looks stuck.
 */
app.post('/api/platform/reference-integrity/repair', route(async (req, res) => {
  if (!requirePlatformAdminAtStageOn(req, res)) return
  if (!READ_MODEL_ENABLED) {
    res.status(503).json({ error: 'read model is disabled; the reference scan has nothing to read' })
    return
  }
  if (!automergeRepo) {
    res.status(503).json({ error: 'automerge repo warming up' })
    return
  }
  const body = (req.body ?? {}) as { landscapeId?: unknown; versionId?: unknown; apply?: unknown; limit?: unknown; documents?: unknown }
  const landscapeId = typeof body.landscapeId === 'string' ? body.landscapeId.trim() : ''
  const versionId = typeof body.versionId === 'string' ? body.versionId.trim() : ''
  if (!landscapeId || !versionId) {
    res.status(400).json({ error: 'landscapeId and versionId are required — repair is never fleet-wide' })
    return
  }
  // ONE predicate, shared with the router. `createWorkspaceHttpRouting`
  // places this route only when it APPLIES — the dry run is deliberately not
  // gated, per this handler's own docblock — so a second spelling of "is this
  // an apply" here would let a report become routable, or an apply run locally.
  const apply = referenceIntegrityApplies(req.body)
  const result = await repairReferenceIntegrity(pool, automergeRepo, {
    landscapeId,
    versionId,
    apply,
    documents: body.documents === true,
    ...(Number.isSafeInteger(body.limit) && (body.limit as number) > 0
      ? { limit: Math.min(body.limit as number, 5_000) }
      : {}),
  })
  if (apply && result.applied > 0 && req.auth?.userId) {
    await appendAudit(pool, {
      actorUserId: req.auth.userId,
      action: 'platform.reference-repair',
      targetKind: 'workspace',
      targetId: `${landscapeId}/${versionId}`,
      detail: {
        applied: result.applied,
        skipped: result.skipped,
        truncated: result.truncated,
        // The findings themselves, so the log answers "what did it change?"
        // without needing the pre-repair report to still exist.
        repaired: result.plans
          .filter((plan) => plan.safeToApply)
          .map((plan) => ({ kind: plan.finding.kind, source: plan.finding.sourceId, target: plan.finding.targetId })),
      },
    })
  }
  res.json(result)
}))

app.get('/api/platform/distributed-runtime', route(async (req, res) => {
  if (!requirePlatformAdminAtStageOn(req, res)) return
  res.json({
    generatedAt: new Date().toISOString(),
    redis: redisRuntime.snapshot(),
    renderCacheRedis: redisRenderCacheRuntime.snapshot(),
  })
}))

// ---------------------------------------------------------------------------
// The ordinary→summary migration, over HTTP.
//
// WHY A ROUTE AND NOT ONLY THE SCRIPT. The script cannot see the WebSocket
// sockets — it is a different process — so it can never PROVE the quiesce and
// falls back to the operator's `--assume-quiesced`. This route runs INSIDE the
// sync server, so it measures the census (`workspacePeerCensus`) and refuses on
// a real number. It is also what makes the promotion reachable from an e2e run
// (`e2e/boot/workspace-contract-promotion.spec.ts` reads `E2E_PROMOTE_URL`).
//
// NOT the authorization pattern of the other platform routes, and the deviation
// is deliberate: these are the only ones that change a workspace's BOOT
// CONTRACT. `requirePlatformAdminAtStageOn` allows everyone below stage 'on',
// which made an unauthenticated `curl -XPOST` on a dev/cutover stack enough to
// flip a landscape — with no audit row either, since the audit was conditioned
// on `req.auth?.userId`. A REPORT stays open below stage 'on'; an APPLY requires
// an identified platform admin at EVERY stage, and is always audited. The
// verdicts are pure functions in `maintenance/summaryMigrationRoute.ts`, where
// they are unit-tested — the full argument lives in that file's header.
//
// `apply: true` MUST be explicit, so a body-less POST is never a migration.
// ---------------------------------------------------------------------------

/** The one place the three routes read their authorization inputs from. */
function summaryMigrationCaller(req: express.Request): SummaryMigrationCaller {
  return {
    stage: authStage(),
    isPlatformAdmin: req.auth?.isPlatformAdmin === true,
    authenticated: Boolean(req.auth),
  }
}

/**
 * Shared preamble: authorization, the read-model guard, and the repo guard.
 * Returns the requested mode, or null when it has already answered.
 *
 * The READ_MODEL guard is the same 503 `reference-integrity` uses, and for a
 * sharper reason here: every precondition of a promotion is a read-model
 * witness (the content seals, projection freshness, `ro_diagrams`), so on a
 * stack with the read model off they are all vacuous. Refusing is the only
 * honest answer; without it the route would answer from tables nothing is
 * maintaining.
 */
function beginSummaryMigration(
  req: express.Request,
  res: express.Response,
): { apply: boolean; repo: Repo; residency: AutomergeResidencyLeases } | null {
  const apply = summaryMigrationApplies(req.body)
  const verdict = authorizeSummaryMigration(summaryMigrationCaller(req), apply)
  if (!verdict.allowed) {
    res.status(verdict.status).json({ error: verdict.error })
    return null
  }
  if (!READ_MODEL_ENABLED) {
    res.status(503).json({
      error: 'read model is disabled (READ_MODEL=on): every precondition of a summary migration is a '
        + 'read-model witness, so this route cannot reach a verdict on this stack',
    })
    return null
  }
  if (!automergeRepo || !automergeResidency) {
    res.status(503).json({ error: 'automerge repo warming up' })
    return null
  }
  return { apply, repo: automergeRepo, residency: automergeResidency }
}

app.post('/api/platform/workspace/promote-summary', route(async (req, res) => {
  const mode = beginSummaryMigration(req, res)
  if (!mode) return
  const target = summaryMigrationTarget(req.body)
  if (!target) {
    res.status(400).json({ error: 'landscapeId and versionId are required — promotion is never fleet-wide' })
    return
  }
  const workspace = await canonicalWorkspaceKey(pool, target)
  if (!workspace) {
    res.status(404).json({ error: 'workspace not found' })
    return
  }
  const apply = mode.apply
  // A FRESH read adapter for the one-shard-at-a-time materialisation, not the
  // sync server's fenced one: the pass is read-only and short-lived, and
  // borrowing the production adapter would fold its ephemeral repos into the
  // residency and fence accounting the live sync path depends on.
  const report = await promoteSummaryWorkspace({
    db: pool, lockDb: lifecycleApplyPool,
    repo: mode.repo,
    residency: mode.residency,
    storage: new PostgresStorageAdapter({ db: pool }),
    workspace,
    apply,
    // MEASURED, in this process. `null` (no registry yet) stays null — the
    // primitive refuses an unproven quiesce rather than reading it as zero.
    connectedPeers: () => {
      const census = workspacePeerCensus(workspace)
      return census === null ? null : census.boundToWorkspace + census.unrouted
    },
    // The ONE overridable precondition, and it must be asked for by name.
    // What it costs is spelled out in the primitive: a live CLASSIC tab's
    // in-flight ENTITY writes (its DiagramDoc writes survive). The override is
    // recorded in `report.overridden` and in the audit entry, never silent.
    allowConnectedPeers: (req.body as { allowConnectedPeers?: unknown })?.allowConnectedPeers === true,
    // The resident projector's OWN instance id, so the
    // `projector-instance-mismatch` precondition has something to compare
    // against. Passing `null` (as this route did) made the check inert in
    // production — it only ever fires when the caller can name the run, and
    // nothing but the fleet can. `null` when no projector is resident here,
    // which is the honest "this process cannot name it".
    expectedProjectorInstanceId: readModelFleet?.residentProjectorInstanceId(workspace) ?? null,
    hooks: {
      releaseOrdinaryProjector: (key, reason) => readModelFleet?.release(key, reason),
      announceDocuments: async ({ key, rootUrl, documentIds }) => {
        for (const documentId of documentIds) {
          await notifyWorkspaceDocumentCreated({
            landscapeId: key.landscapeId, versionId: key.versionId, rootUrl, documentId,
          })
        }
      },
      drainPeers: (key, reason) => { automergeConnectionRegistry?.drainWorkspace(key, reason) },
    },
    onProgress: (message) => console.log(`[promote-summary] ${message}`),
  })
  // Audited whenever something was APPLIED — never conditioned on there being
  // an actor. The gate above already requires an identified platform admin for
  // an apply, so the sentinel is unreachable today; an audit trail that skips
  // the runs it cannot attribute is worse than one that says "unattributed".
  if (report.applied) {
    await appendAudit(pool, {
      actorUserId: summaryMigrationAuditActor(req.auth?.userId),
      action: 'platform.promote-summary',
      targetKind: 'workspace',
      targetId: `${workspace.landscapeId}/${workspace.versionId}`,
      detail: {
        writeHeadUrl: report.applied.writeHeadUrl,
        allowListSize: report.applied.allowListSize,
        diagramCount: report.applied.diagramCount,
        fenceWaitMs: report.applied.fenceWaitMs,
        // An overridden quiesce is part of the record of what was done.
        overridden: report.overridden.map((blocker) => blocker.code),
      },
    })
  }
  // A refused promotion is a 409, not a 200 with a sad payload: an e2e (or an
  // operator's `curl`) that treats HTTP status as the verdict must not read
  // "blocked" as "done" — the missing-prerequisite failure mode this whole
  // module is written against. An APPLY that changed nothing without naming a
  // blocker is a 500 for the same reason (see `summaryMigrationHttpStatus`).
  res.status(summaryMigrationHttpStatus({
    apply, blockers: report.blockers.length, applied: report.applied !== null,
  })).json(report)
}))

app.post('/api/platform/workspace/demote-summary', route(async (req, res) => {
  const mode = beginSummaryMigration(req, res)
  if (!mode) return
  const target = summaryMigrationTarget(req.body)
  if (!target) {
    res.status(400).json({ error: 'landscapeId and versionId are required' })
    return
  }
  const workspace = await canonicalWorkspaceKey(pool, target)
  if (!workspace) {
    res.status(404).json({ error: 'workspace not found' })
    return
  }
  const report = await demoteSummaryWorkspace({
    db: pool, lockDb: lifecycleApplyPool,
    repo: mode.repo,
    workspace,
    apply: mode.apply,
    connectedPeers: () => {
      const census = workspacePeerCensus(workspace)
      return census === null ? null : census.boundToWorkspace + census.unrouted
    },
    allowConnectedPeers: (req.body as { allowConnectedPeers?: unknown })?.allowConnectedPeers === true,
    // T6 — its own flag on purpose: overriding the quiesce costs a live
    // session's in-flight writes, while this one brings back every diagram
    // anyone deleted since the promotion.
    allowDiagramResurrection:
      (req.body as { allowDiagramResurrection?: unknown })?.allowDiagramResurrection === true,
    hooks: {
      ensureOrdinaryProjector: async (key) => {
        try {
          await readModelFleet?.ensure(key)
        } catch (error) {
          // The workspace is ordinary again either way; a cold build that
          // cannot start now starts at the next request. Logged, never
          // swallowed silently.
          console.warn('[demote-summary] the ordinary projector did not re-attach yet:', error)
        }
      },
      drainPeers: (key, reason) => { automergeConnectionRegistry?.drainWorkspace(key, reason) },
    },
    onProgress: (message) => console.log(`[demote-summary] ${message}`),
  })
  if (report.applied) {
    await appendAudit(pool, {
      actorUserId: summaryMigrationAuditActor(req.auth?.userId),
      action: 'platform.demote-summary',
      targetKind: 'workspace',
      targetId: `${workspace.landscapeId}/${workspace.versionId}`,
      detail: {
        staticRowsDeleted: report.applied.staticRowsDeleted,
        // Symmetrical with the promotion: a de-promotion run over a live
        // session is part of the record of what was done, and the demotion's
        // override costs the same kind of thing the promotion's does.
        overridden: report.overridden.map((blocker) => blocker.code),
      },
    })
  }
  res.status(summaryMigrationHttpStatus({
    apply: mode.apply, blockers: report.blockers.length, applied: report.applied !== null,
  })).json(report)
}))

/**
 * The THIRD door: finish a HYBRID workspace (static rows committed, ordinary
 * root) by writing the root half only.
 *
 * Reachable by a crash between the promotion's commit and its root flip, and by
 * a flag stripped from a static fixture by hand — the T8 migration fixtures.
 * Neither of the other two routes can regularise it (`promote` refuses
 * `already-summary`, `demote` refuses `not-promoted`), and without this one the
 * remaining tool is a hand-written UPDATE on `read_model_static_*`.
 */
app.post('/api/platform/workspace/repair-summary-flag', route(async (req, res) => {
  const mode = beginSummaryMigration(req, res)
  if (!mode) return
  const target = summaryMigrationTarget(req.body)
  if (!target) {
    res.status(400).json({ error: 'landscapeId and versionId are required' })
    return
  }
  const workspace = await canonicalWorkspaceKey(pool, target)
  if (!workspace) {
    res.status(404).json({ error: 'workspace not found' })
    return
  }
  const report = await repairSummaryFlag({
    db: pool, lockDb: lifecycleApplyPool,
    repo: mode.repo,
    workspace,
    apply: mode.apply,
    hooks: {
      drainPeers: (key, reason) => { automergeConnectionRegistry?.drainWorkspace(key, reason) },
    },
    onProgress: (message) => console.log(`[repair-summary-flag] ${message}`),
  })
  if (report.applied) {
    await appendAudit(pool, {
      actorUserId: summaryMigrationAuditActor(req.auth?.userId),
      action: 'platform.repair-summary-flag',
      targetKind: 'workspace',
      targetId: `${workspace.landscapeId}/${workspace.versionId}`,
      detail: {
        writeHeadUrl: report.applied.writeHeadUrl,
        // Which half was missing: an ADOPTED head means this was a crashed
        // promotion, not a stripped flag.
        adoptedFromAllowList: report.applied.adoptedFromAllowList,
        diagramCount: report.applied.diagramCount,
      },
    })
  }
  res.status(summaryMigrationHttpStatus({
    apply: mode.apply, blockers: report.blockers.length, applied: report.applied !== null,
  })).json(report)
}))

// --- Public read-only share links ---

// Optional absolute base for generated links (e.g. https://app.example.com, no
// trailing slash). When unset the client builds the URL from its own origin.
const SHARE_BASE_URL = process.env.SHARE_BASE_URL

/** Allow the share/embed JSON to be consumed from inside a cross-origin iframe. */
function setEmbedHeaders(res: express.Response): void {
  res.removeHeader('X-Frame-Options')
  res.setHeader('Content-Security-Policy', 'frame-ancestors *')
}

/** Tighten framing for a GATED (org/domain) share so it can't be embedded on an
 * attacker page to ride a victim's session — only our own app (`APP_URL`) may frame it. */
function setRestrictedEmbedHeaders(res: express.Response): void {
  const appUrl = process.env.APP_URL
  res.setHeader('Content-Security-Policy', `frame-ancestors 'self'${appUrl ? ` ${appUrl}` : ''}`)
}

/** Canonicalize a share's stored workspace ('current' → the landscape's real default
 * version id) so the RBAC gates — which are keyed by real version ids — match. Falls
 * back to the raw key when the landscape can't be resolved (a missing landscape makes
 * requireVersionWrite permissive, and its own row lookup 404s downstream). */
async function shareWorkspaceKey(landscapeId: string | null, versionId: string | null): Promise<WorkspaceKey> {
  const raw: WorkspaceKey = {
    landscapeId: landscapeId ?? DEFAULT_WORKSPACE_KEY.landscapeId,
    versionId: versionId ?? DEFAULT_WORKSPACE_KEY.versionId,
  }
  return (await canonicalWorkspaceKey(pool, raw)) ?? raw
}

/** RBAC read-filter for the manage list: at stage 'on', drop shares whose workspace
 * the caller can't READ, so one org/team can't enumerate another's link tokens.
 * Permissive below 'on' and for platform admins (unchanged behavior). */
async function filterSharesByReadAccess<T extends { landscapeId: string | null; versionId: string | null }>(
  req: express.Request,
  shares: T[]
): Promise<T[]> {
  if (authStage() !== 'on' || !req.auth || req.auth.isPlatformAdmin) return shares
  const readable = await allowedWorkspaceKeys(pool, req.auth)
  const defaultVersionByLandscape = new Map<string, string | null>()
  const out: T[] = []
  for (const s of shares) {
    const lid = s.landscapeId ?? DEFAULT_WORKSPACE_KEY.landscapeId
    let vid = s.versionId ?? DEFAULT_WORKSPACE_KEY.versionId
    if (vid === 'current') {
      if (!defaultVersionByLandscape.has(lid)) {
        const c = await canonicalWorkspaceKey(pool, { landscapeId: lid, versionId: 'current' })
        defaultVersionByLandscape.set(lid, c?.versionId ?? null)
      }
      const real = defaultVersionByLandscape.get(lid)
      if (!real) continue // unresolvable landscape → hide (fail closed)
      vid = real
    }
    if (readable.has(`${lid}/${vid}`)) out.push(s)
  }
  return out
}

app.post('/api/shares', async (req, res) => {
  try {
    const error = validateCreateShare(req.body)
    if (error) { res.status(400).json({ error }); return }
    // RBAC: creating a share EXPOSES a workspace's content read-only — a governance
    // action, so it requires WRITE on that workspace (a View-only grant must NOT be
    // able to publish a link). requireVersionWrite writes the 403 itself and is
    // permissive below stage 'on' (byte-identical pre-auth behavior).
    const createKey = await shareWorkspaceKey(
      typeof req.body?.landscapeId === 'string' ? req.body.landscapeId : null,
      typeof req.body?.versionId === 'string' ? req.body.versionId : null
    )
    if (!(await requireVersionWrite(pool, req, res, createKey.landscapeId, createKey.versionId))) return
    // Default a new link to org-restricted once identity is enforceable, so a link
    // is never public-by-accident ("Anyone" must be a deliberate click). An explicit
    // client audience (incl. one inherited when freezing a version) always wins.
    const audience: ShareAudience =
      typeof req.body?.audience === 'string' ? req.body.audience : defaultShareAudience(authStage())
    const share = await createShare({ ...req.body, audience, actorUserId: req.auth?.userId, sessionOrgId: req.auth?.orgId })
    const url = SHARE_BASE_URL ? `${SHARE_BASE_URL}/share/${share.token}` : null
    const { snapshot: _snapshot, ...meta } = share
    res.json({ token: share.token, url, share: meta })
  } catch (err) {
    console.error('Create share error:', err)
    res.status(500).json({ error: 'Failed to create share' })
  }
})

app.get('/api/shares', async (req, res) => {
  try {
    const diagramId = typeof req.query.diagramId === 'string' ? req.query.diagramId : undefined
    const shares = await filterSharesByReadAccess(req, await listShares(diagramId))
    res.json({ shares })
  } catch (err) {
    console.error('List shares error:', err)
    res.status(500).json({ error: 'Failed to list shares' })
  }
})

// Public — no auth; the token is the capability. Embeddable in iframes.
// Rate-limited per token (SHARE_RATE_LIMIT_PER_MIN, default 120/min) — this is
// the anonymous-by-design resolution path, so it needs backoff +
// audit-on-threshold.
app.get('/api/shares/:token', async (req, res) => {
  setEmbedHeaders(res)
  try {
    const share = await getShare(req.params.token)
    const expired = share?.expiresAt ? new Date(share.expiresAt).getTime() < Date.now() : false
    if (!share || !share.enabled || expired) {
      res.status(404).json({ error: 'Share not found' })
      return
    }
    // Audience gate: a non-public share requires an authorized identity. `req.auth`
    // is set by requireAuth even on this allowlisted route when a valid session
    // cookie is present, so the caller is already resolved here. 401 for anonymous
    // (the viewer prompts sign-in), 403 for signed-in-but-not-permitted. Public
    // shares skip this entirely — byte-identical to before.
    if (share.audience !== 'public') {
      const decision = await checkShareAudienceAccess(pool, share, req.auth)
      if (decision === 'unauthenticated') {
        res.status(401).json({ error: 'authentication_required', audience: share.audience })
        return
      }
      if (decision === 'forbidden') {
        res.status(403).json({ error: 'forbidden', audience: share.audience })
        return
      }
      // Authorized — don't let a gated share be framed on an arbitrary origin.
      setRestrictedEmbedHeaders(res)
    }
    // Checked (and counted) AFTER resolving the share so the limit is keyed by
    // a real row's org_id for the audit trail; an unknown token already 404'd
    // above without consuming a rate-limit slot.
    const rate = await checkShareRateLimit(share.token, share.orgId)
    if (!rate.allowed) {
      res.status(429).setHeader('Retry-After', String(rate.retryAfterS))
      res.json({ error: 'Too many requests' })
      return
    }
    void bumpViewCount(share.token).catch(() => {})
    res.json({
      snapshot: share.snapshot,
      mode: share.mode,
      checkpointLabel: share.checkpointLabel,
      updatedAt: share.updatedAt,
      allow3d: share.allow3d,
    })
  } catch (err) {
    if (err instanceof RedisUnavailableError) {
      res.status(503).setHeader('Retry-After', '1')
      res.json({ error: 'Rate-limit service unavailable' })
      return
    }
    console.error('Get share error:', err)
    res.status(500).json({ error: 'Failed to get share' })
  }
})

app.patch('/api/shares/:token', async (req, res) => {
  try {
    // RBAC manage gate: editing/disabling/repointing a link requires WRITE on the
    // share's workspace — a View-only grant (or another org) must not touch it.
    // requireVersionWrite writes the 403; permissive below stage 'on'.
    const existing = await getShareGateInfo(req.params.token)
    if (!existing.exists) { res.status(404).json({ error: 'Share not found' }); return }
    const key = await shareWorkspaceKey(existing.landscapeId, existing.versionId)
    if (!(await requireVersionWrite(pool, req, res, key.landscapeId, key.versionId))) return
    const share = await updateShare(req.params.token, { ...(req.body ?? {}), sessionOrgId: req.auth?.orgId })
    if (!share) { res.status(404).json({ error: 'Share not found' }); return }
    res.json({ share })
  } catch (err) {
    console.error('Update share error:', err)
    res.status(500).json({ error: 'Failed to update share' })
  }
})

app.delete('/api/shares/:token', async (req, res) => {
  try {
    const existing = await getShareGateInfo(req.params.token)
    if (!existing.exists) { res.json({ success: false }); return }
    const key = await shareWorkspaceKey(existing.landscapeId, existing.versionId)
    if (!(await requireVersionWrite(pool, req, res, key.landscapeId, key.versionId))) return
    const ok = await revokeShare(req.params.token)
    res.json({ success: ok })
  } catch (err) {
    console.error('Revoke share error:', err)
    res.status(500).json({ error: 'Failed to revoke share' })
  }
})

// --- Landscape SNAPSHOTS (named head-manifest restore points; opaque store).
// Distinct from editable VERSIONS (below): a snapshot is a frozen
// capture of a version's heads, a version is its own editable Automerge root. ---

app.get('/api/landscapes/:landscapeId/snapshots', async (req, res) => {
  try {
    if (!(await requireLandscapeInOrg(pool, req, res, req.params.landscapeId))) return
    res.json({ versions: await listVersions(req.params.landscapeId) })
  } catch (err) {
    console.error('List versions error:', err)
    res.status(500).json({ error: 'Failed to list versions' })
  }
})

app.post('/api/landscapes/:landscapeId/snapshots', async (req, res) => {
  try {
    if (!(await requireLandscapeInOrg(pool, req, res, req.params.landscapeId))) return
    if (!(await requireLandscapeWrite(pool, req, res, req.params.landscapeId))) return
    const error = validateCreateVersion(req.body)
    if (error) { res.status(400).json({ error }); return }
    const version = await createVersion({
      landscapeId: req.params.landscapeId,
      label: (req.body as { label: string }).label,
      kind: (req.body as { kind?: string }).kind,
      manifest: (req.body as { manifest: unknown }).manifest,
    })
    const { manifest: _manifest, ...meta } = version
    res.json({ version: meta })
  } catch (err) {
    console.error('Create version error:', err)
    res.status(500).json({ error: 'Failed to create version' })
  }
})

app.get('/api/landscapes/:landscapeId/snapshots/:id', async (req, res) => {
  try {
    if (!(await requireLandscapeInOrg(pool, req, res, req.params.landscapeId))) return
    const version = await getVersion(req.params.id)
    if (!version || version.landscapeId !== req.params.landscapeId) {
      res.status(404).json({ error: 'Snapshot not found' }); return
    }
    res.json({ version })
  } catch (err) {
    console.error('Get version error:', err)
    res.status(500).json({ error: 'Failed to get version' })
  }
})

app.delete('/api/landscapes/:landscapeId/snapshots/:id', async (req, res) => {
  try {
    if (!(await requireLandscapeInOrg(pool, req, res, req.params.landscapeId))) return
    if (!(await requireLandscapeWrite(pool, req, res, req.params.landscapeId))) return
    res.json({ success: await deleteVersion(req.params.landscapeId, req.params.id) })
  } catch (err) {
    console.error('Delete snapshot error:', err)
    res.status(500).json({ error: 'Failed to delete version' })
  }
})

async function migrateWithRetry(attempts = 20, delayMs = 1500): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      const outcome = await runMigrations(pool, schemaMigrations(pool), {
        appliedBy: syncCellOwnershipConfig().cellId,
      })
      // One line, every boot, including the boring one. "Did this deploy's
      // schema step run?" having no answer is half of what the ledger is for,
      // and a log that only appears when something changed cannot distinguish
      // "nothing to do" from "never reached".
      console.log(JSON.stringify({
        event: 'schema.migrations',
        applied: outcome.applied,
        repeated: outcome.repeated.length,
        alreadyApplied: outcome.alreadyApplied.length,
        unknownToThisBuild: outcome.unknown,
      }))
      return
    } catch (err) {
      if (i === attempts) throw err
      console.log(`Postgres not ready (attempt ${i}/${attempts}); retrying in ${delayMs}ms…`)
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

// Resilience: a single document's sync failure (e.g. an automerge-repo
// `whenReady` 60s TimeoutError surfacing in an async sync handler) must NOT take
// the whole sync server down. Log and keep serving every other document/client.
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException (kept alive):', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection (kept alive):', reason)
})

async function main() {
  // Initialize only the pure decoder, before migrations, ownership or listen.
  // Standby projectors and their documents remain cold. A failed initialization
  // must refuse startup before this process can hold a workspace lease.
  if (READ_MODEL_ENABLED) await durableHeadsDecoder.initialize()
  // All schema, under one advisory lock and recorded in `schema_migrations`
  // (src/db/schemaMigrations.ts). The `ensure*Schema` sequence lives in the
  // baseline migration, which re-runs every boot.
  await migrateWithRetry()
  const defaultOrgId = await ensureDefaultOrg(pool)
  // The managed public catalog is platform data, not demo data. Install it on
  // every normal boot so existing and newly provisioned organizations inherit
  // the complete catalog through their default `all` policy. The seed is
  // deterministic and idempotent, so it also upgrades older deployments when
  // a new catalog revision is shipped. Data, not schema — so it stays here.
  //
  // Its schema half is DDL, and so are the RBAC and epoch-trigger steps below:
  // each runs under the migration key so a backup in flight is waited for on
  // the key, not queued behind on a table lock (see withMigrationLock).
  await withMigrationLock(pool, () => ensureManagedTechnologyCatalog(pool, defaultOrgId))
  maintenanceCoordinator = new MaintenanceCoordinator(pool)
  const maintenanceScheduleStops: Array<() => void> = []
  let stopReadModelOwnershipListener: (() => void) | null = null
  let stopDivergenceScheduler: (() => void) | null = null
  let stopRepoFreshnessListener: (() => void) | null = null
  let staticDeltaProjector: StaticDeltaProjector | null = null
  await Promise.all([redisRuntime.start(), redisRenderCacheRuntime.start()])
  // Authentication, quotas and route lookups create a command burst when many
  // websocket clients arrive together. Lease renewal gets a separate Redis
  // connection so unrelated queue pressure cannot revoke every workspace.
  if (process.env.SYNC_CELL_OWNERSHIP === 'on') {
    // Derived lease timeout, not the general runtime default: see
    // syncCellOwnershipConfig. This is the DEFAULT path — SYNC_CELL_PARTITION_WORKER
    // is off unless opted into — so leaving it on the shared timeout would mean
    // the fix applied only to the configuration almost nobody runs.
    syncCellOwnershipRedis = new RedisRuntime(
      { ...redisRuntimeConfig(), commandTimeoutMs: syncCellOwnershipConfig().leaseCommandTimeoutMs },
      'sync-cell-ownership',
    )
    await syncCellOwnershipRedis.start()
  }
  // `syncCellPool`, NOT `pool`: its connections carry `statement_timeout` and
  // `lock_timeout` from the startup packet, so one blocked statement cannot
  // freeze every later reconciliation. The coordinator verifies at start that the server really is enforcing them.
  syncCellOwnership = new SyncCellOwnershipCoordinator(
    syncCellPool,
    syncCellOwnershipRedis ?? redisRuntime,
  )
  await syncCellOwnership.start()
  // PARITY BETWEEN THE TWO WORKSPACE SETS, and it runs
  // AFTER `start()` on purpose: a cell that could not confirm the fleet's
  // topology has bigger problems than set parity, and `start()` is what decides
  // that. Before it, a divergence report would be noise on a cell that is not
  // going to own anything anyway.
  //
  // FATAL. The failure it names is silent and permanent by nature — a workspace
  // no cell can own is one whose scheduled fsck runs on no cell at all, and
  // nothing else in the system reports that. The expected difference (versions
  // that are not `active`) is logged on every boot, healthy ones included, so an
  // operator sees the gap rather than inferring it from silence.
  await assertWorkspaceSetParity(pool)
  if (READ_MODEL_ENABLED) {
    void readModelChangeHub.start().catch((error) => {
      console.warn('[read-model-events] initial LISTEN failed; reconnecting in background', error)
    })
  }
  await maintenanceCoordinator.run('tag_operational_gc', () => gcTagOperationalState(pool))
    .then((result) => {
      if (result.status === 'skipped_locked') {
        console.log('[tags] startup operational cleanup skipped; another replica owns the job')
      }
    })
    .catch((error) => console.warn('[tags] startup operational cleanup failed:', error))
  // Multi-org: stamp pre-org landscapes with the Default Org + point its
  // default_landscape_id. MUST run before ensureScopesForExistingWorkspaces so
  // the scope backfill registers every workspace under its true owning org.
  await backfillLandscapeOrgs()
  // RBAC substrate: teams, scopes closure table, grants, trigger-denormalized
  // effective permissions + rbac_effective_access(). No RLS policies are
  // enforced at the database level.
  await withMigrationLock(pool, () => ensureRbacSchema(pool))
  // Scope rows for every pre-existing workspace (the Default-Org backfill —
  // the WS access gate resolves docs to these scopes) + the epoch-bump triggers
  // that revoke live sessions/sockets when membership or grants change.
  await ensureScopesForExistingWorkspaces(pool)
  await withMigrationLock(pool, () => ensureEpochTriggers(pool))
  const tagMaintenanceTz = process.env.TAG_MAINTENANCE_TZ ?? 'America/Toronto'
  maintenanceScheduleStops.push(scheduleDailyAt(3, 15, tagMaintenanceTz, async () => {
    const outcome = await maintenanceCoordinator!.run('tag_operational_gc', () => gcTagOperationalState(pool))
    if (outcome.status === 'completed') {
      console.log('[tags] operational cleanup complete', outcome.value)
    } else if (outcome.status === 'skipped_locked') {
      console.log('[tags] operational cleanup skipped; another replica owns the job')
    }
  }))
  // BIND_ADDRESS exists for one caller that matters: the backup drill boots this
  // server with AUTH=off against a full restore of production data, and binding
  // every interface would publish every workspace, org and model, plus an
  // unauthenticated Automerge socket, for the length of the drill. Unset keeps
  // the previous all-interfaces behaviour, which is what a container needs.
  const bindAddress = process.env.BIND_ADDRESS?.trim()
  const server = bindAddress ? app.listen(PORT, bindAddress) : app.listen(PORT)
  // A failed bind (EADDRINUSE, EACCES) must terminate this process. The
  // uncaughtException handler above deliberately keeps the server alive, and it
  // would otherwise swallow the bind failure too — leaving a replica that never
  // bound a port yet still renews its sync-cell partition leases, stalling every
  // workspace hashed to it. Rejecting here reaches main().catch, which exits 1.
  try {
    await listenReady(server)
  } catch (error) {
    // syncCellOwnership.start() ran above, so by now this replica may already
    // hold partition leases. Exiting without releasing them would strand every
    // workspace hashed to those partitions for a full TTL while no replica is
    // able to serve them — a milder version of the zombie this guards against.
    await syncCellOwnership?.stop().catch((stopError) => {
      console.error('[server] failed to release sync-cell leases after bind failure:', stopError)
    })
    throw error
  }
  // Post-boot server errors are usually not fatal — the listener is bound and
  // every other connection is still being served, so log rather than fall
  // through to uncaughtException. But an error that arrives once the listener
  // has gone down without us shutting down recreates exactly the
  // serve-nothing-but-hold-leases state this block guards against.
  //
  // The shuttingDown check is load-bearing, NOT belt-and-braces: `server.close()`
  // clears the handle synchronously, so `server.listening` is false for the
  // whole drain — including `syncCellOwnership.stop()`. Keying on `listening`
  // alone would let any error during shutdown exit the process before the
  // leases are released, causing the very stranding this tries to avoid.
  server.on('error', (error) => {
    if (!server.listening && !readiness.shuttingDown) {
      console.error('[server] http server error after the listener went down; exiting:', error)
      process.exit(1)
    }
    console.error('[server] http server error:', error)
  })
  console.log(`MapleSpire sync server running on http://localhost:${PORT}`)
  // Attach the Automerge sync peer to the same HTTP server (ws path /automerge)
  // and expose the shared root document URL so every client opens one workspace.
  // Same lease hazard as the bind failure above, and for the same reason.
  // `startAutomergeSync` can now REJECT rather than hang — `findBootDocument`
  // throws when the workspace root cannot be resolved within its ceiling — and
  // `syncCellOwnership.start()` ran long before this line. Exiting while still
  // holding partition leases strands every workspace hashed to them for a full
  // TTL, with no replica able to serve them: strictly worse than the hang it
  // replaces, and exactly the failure I2 was written to avoid. The listener is
  // also already bound by now, so it is closed here too rather than left to a
  // process exit that never runs its shutdown path.
  const started = await startAutomergeSync(server, { ownership: syncCellOwnership, readModelResidency: liveResidency })
    .catch(async (error: unknown) => {
      await syncCellOwnership?.stop().catch((stopError) => {
        console.error('[server] failed to release sync-cell leases after automerge boot failure:', stopError)
      })
      server.close()
      throw error
    })
  const {
    repo,
    rootUrl,
    connectionRegistry,
    transportTelemetry,
    storageFenceSnapshot,
    storageFenceRejectionCount,
    denyLedgerSnapshot,
    residency,
    setPinnedCoreDocument,
    forgetDocumentRequests,
    drain: drainAutomerge,
    shutdown: shutdownAutomerge,
  } = started
  automergeRepo = repo
  automergeConnectionRegistry = connectionRegistry
  automergeResidency = residency
  readStorageFenceSnapshot = storageFenceSnapshot
  readStorageFenceRejectionCount = storageFenceRejectionCount
  readDenyLedgerSnapshot = denyLedgerSnapshot
  stopRepoFreshnessListener = syncCellOwnership.onOwnershipAcquired(async ({
    workspace, fencingToken,
  }) => {
    // Token 1 is the first owner of a newly-created workspace. Later tokens
    // are transfers/restarts and must discard standby-era mutable handles
    // before the coordinator advertises local ownership.
    if (BigInt(fencingToken) <= 1n) return
    const refreshStartedAt = Date.now()
    console.log(JSON.stringify({
      event: 'sync.cell.workspace_cache_refresh_started',
      landscapeId: workspace.landscapeId,
      versionId: workspace.versionId,
      cachedHandles: Object.keys(cachedHandles(repo)).length,
    }))
    const evicted = await evictWorkspaceDocumentCache(repo, pool, workspace, automergeResidency)
    const prewarmed = await prewarmWorkspaceFailoverDocuments(repo, pool, workspace)
    console.log(JSON.stringify({
      event: 'sync.cell.workspace_cache_refreshed',
      landscapeId: workspace.landscapeId,
      versionId: workspace.versionId,
      fencingToken,
      evictedDocuments: evicted,
      prewarmedDocuments: prewarmed.documentIds.length,
      prewarmedModelKind: prewarmed.modelKind,
      elapsedMs: Date.now() - refreshStartedAt,
    }))
  })
  // Register the legacy workspace before declaring readiness. The ownership
  // coordinator observes creation, then the explicit reconcile makes boot
  // deterministic even if this is the first database initialization.
  await ensureDefaultLandscape(rootUrl)
  await syncCellOwnership.reconcileNow()
  readiness.automerge = true

  // Canonical once per process: maintenance and the default projector must use
  // the persisted version id, never the public `current` sentinel.
  const defaultWorkspaceKey = (
    await canonicalWorkspaceKey(pool, DEFAULT_WORKSPACE_KEY)
  ) ?? DEFAULT_WORKSPACE_KEY

  type RepoMaintenanceDenied = {
    status: 'skipped_ownership'
    reason: RepoMaintenanceDenialReason
    retryable: boolean
  }
  type RepoMaintenanceOutcome<T> = MaintenanceRunResult<T> | RepoMaintenanceDenied

  /** Check ownership before competing for the cluster advisory lock and again
   * after acquiring it. The second check closes the scheduling race; storage
   * fencing remains the final write-time guard if a lease is lost mid-task. */
  const runOwnedRepoMaintenance = async <T>(
    job: MaintenanceJobName,
    scope: RepoMaintenanceScope,
    workspace: WorkspaceKey,
    task: () => Promise<T>,
  ): Promise<RepoMaintenanceOutcome<T>> => {
    const beforeLock = admitRepoMaintenance(syncCellOwnership, scope, workspace)
    if (!beforeLock.allowed) return { status: 'skipped_ownership', ...beforeLock }

    // Per-workspace exclusion ONLY for workspace-scoped work. A `global-repo`
    // job walks the whole Repo, so two of them keyed by different workspaces
    // would run the same global walk concurrently — the per-job-name lock is the
    // correct exclusion there and it stays.
    const coordinated = await maintenanceCoordinator!.run(job, async () => {
      const afterLock = admitRepoMaintenance(syncCellOwnership, scope, workspace)
      if (!afterLock.allowed) return { kind: 'denied' as const, admission: afterLock }
      return { kind: 'completed' as const, value: await task() }
    }, maintenanceRunOptions(scope, workspace))
    if (coordinated.status !== 'completed') return coordinated
    if (coordinated.value.kind === 'denied') {
      return { status: 'skipped_ownership', ...coordinated.value.admission }
    }
    return { ...coordinated, value: coordinated.value.value }
  }

  const runOwnedFencedRepoMaintenance = async <T>(
    job: MaintenanceJobName,
    scope: RepoMaintenanceScope,
    workspace: WorkspaceKey,
    task: (fence: MaintenanceFence) => Promise<T>,
  ): Promise<RepoMaintenanceOutcome<T>> => {
    const beforeLock = admitRepoMaintenance(syncCellOwnership, scope, workspace)
    if (!beforeLock.allowed) return { status: 'skipped_ownership', ...beforeLock }

    // Same rule as the unfenced wrapper: workspace-scoped work gets the
    // per-workspace key, a global-repo walk keeps the per-job-name lock.
    const coordinated = await maintenanceCoordinator!.runFenced(job, async (fence) => {
      const afterLock = admitRepoMaintenance(syncCellOwnership, scope, workspace)
      if (!afterLock.allowed) return { kind: 'denied' as const, admission: afterLock }
      return { kind: 'completed' as const, value: await task(fence) }
    }, maintenanceRunOptions(scope, workspace))
    if (coordinated.status !== 'completed') return coordinated
    if (coordinated.value.kind === 'denied') {
      return { status: 'skipped_ownership', ...coordinated.value.admission }
    }
    return { ...coordinated, value: coordinated.value.value }
  }

  let shutdownStarted: Promise<void> | null = null
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownStarted) return shutdownStarted
    shutdownStarted = (async () => {
      readiness.shuttingDown = true
      console.log(`[server] ${signal} received; draining HTTP and Automerge connections`)
      // Reject queued cold starts before closing transport/DB. ProjectorFleet
      // prevents active builds from registering listeners after this stop.
      // Closing the proof decoder below rejects unfinished pure decoding;
      // it does not cancel SQL/drains or join every cold-build continuation.
      readModelFleet?.stopAll()
      coldBuildAdmission.stop()
      stopReadModelOwnershipListener?.()
      stopDivergenceScheduler?.()
      stopReadModelOwnershipListener = null
      stopRepoFreshnessListener?.()
      stopRepoFreshnessListener = null
      const stopStaticDeltaProjector = staticDeltaProjector?.stop()
      staticDeltaProjector = null
      maintenanceCoordinator?.stopAccepting()
      for (const stopSchedule of maintenanceScheduleStops) stopSchedule()
      const forcedExit = setTimeout(() => {
        console.error('[server] graceful shutdown deadline exceeded')
        process.exit(1)
      }, 30_000)
      forcedExit.unref()
      const closeHttp = new Promise<void>((resolve) => server.close(() => resolve()))
      // Maintenance jobs can hold and mutate Automerge documents, so let an
      // active one finish before closing the repo or its PostgreSQL session.
      await maintenanceCoordinator?.drain()
      const drainResults = await Promise.allSettled([
        durableHeadsDecoder.close(),
        stopStaticDeltaProjector,
        drainAutomerge(),
        readModelChangeHub.stop(),
        closeHttp,
      ])
      const failedDrains = drainResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      // A rejected drain can mean an unjoined operation or failed persistence.
      // Keep ownership until forced process exit; never compare-release on an
      // allSettled result that did not certify transport closure and flush.
      if (failedDrains.length) throw new AggregateError(failedDrains.map(result => result.reason), 'Server drain incomplete; ownership retained')
      // Keep the critical Redis connection alive until Automerge has stopped
      // accepting writes and flushed. Only then compare-release our leases.
      // Repo.shutdown can take longer than an orchestrator's stop window; it is
      // safe to finish after ownership is gone because drainAutomerge closed
      // every transport and persisted all accepted writes first.
      await syncCellOwnership?.stop()
      await shutdownAutomerge()
      await Promise.allSettled([
        syncCellOwnershipRedis?.stop(),
        redisRuntime.stop(),
        redisRenderCacheRuntime.stop(),
      ])
      await pool.end().catch((error) => console.warn('[server] Postgres pool shutdown failed:', error))
      await readModelPool.end().catch((error) => console.warn('[server] read-model Postgres pool shutdown failed:', error))
      await syncCellPool.end().catch((error) => console.warn('[server] sync-cell Postgres pool shutdown failed:', error))
      await lifecycleApplyPool.end().catch((error) => console.warn('[server] lifecycle-apply Postgres pool shutdown failed:', error))
      clearTimeout(forcedExit)
      console.log('[server] graceful shutdown complete')
      process.exit(0)
    })()
    return shutdownStarted
  }
  const onShutdownSignal = (signal: string): void => {
    void shutdown(signal).catch((error) => {
      console.error('[server] graceful shutdown failed; forced-exit deadline remains active:', error)
      process.exitCode = 1
    })
  }
  process.once('SIGTERM', () => onShutdownSignal('SIGTERM'))
  process.once('SIGINT', () => onShutdownSignal('SIGINT'))
  // First-login provisioning creates Automerge docs — hand it the repo now
  // that one exists (logins during the pre-attach boot window fail loud +
  // retryable instead of provisioning half an org).
  setProvisioningRepo(repo)
  // Org-admin demo seeding also creates workspace docs (ORG_SEED=on gated).
  registerOrgSeedRoutes(app, repo)
  // AI Assist: schema + chat/tool/skill routes + remote MCP (Bearer/OAuth).
  // The coordinator getter and the required-predicate are the ones
  // `createWorkspaceHttpRouting` reads, so the agent loops' tool-call relay
  // and the middleware read one coordinator. That is a WIRE —
  // `registerAiFeature` accepts their absence and the relay then silently
  // stays off — and `mutatingRouteCoverage.test.ts` pins it on this source,
  // because index.ts cannot be loaded by a test.
  await registerAiFeature(app, {
    repo,
    rootUrl,
    pool,
    ownership: () => syncCellOwnership,
    ownershipRequired: syncCellOwnershipRequired,
  })
  const ensureCanonicalWorkspaceRoot = async (
    key: WorkspaceKey,
    url: string,
    // A per-call rotation WITNESS. The merge handler refuses on a lost lease
    // and has to say whether anything was written when it does; it must not
    // claim "nothing was written" while a root had already rotated. Hooked to `onRotated` rather than to a URL comparison because this
    // wrapper is called TWICE per merge and only the callback distinguishes
    // "this call rotated" from "the url came back different".
    observe?: { onRotated?: () => void },
  ): Promise<string> => {
    const healthyUrl = await ensureHealthyWorkspaceRoot(pool, repo, key, url, {
      onRotated: (rotation) => {
        observe?.onRotated?.()
        notifyWorkspaceCreated({
          landscapeId: rotation.landscapeId,
          versionId: rotation.versionId,
          rootUrl: rotation.newRootUrl,
        })
        // NO coverage-marker write here. The marker keys on (landscape,
        // version), not on the root URL, so a rotation invalidates nothing
        // and a covered workspace stays covered on its own. Re-posing
        // WITHOUT proof would cover a legacy workspace never walked (its
        // missing row reads as witness '0'), or re-cover one a finding
        // de-covered before its repair ran. Coverage changes hands only
        // through its two proofs: bootstrap-by-construction, and the
        // complete repair walk's caller.
      },
    })
    // Close the descriptor-reload race after a repair: a static root must be
    // resident before this URL is disclosed. The static projector takes over
    // the same owner and also covers cold startup without an HTTP request.
    const handle = await findReadyDocument(repo, healthyUrl)
    if ((handle.doc() as Record<string, unknown> | undefined)?.registrySummaryOnly === true) {
      const owner = `static-control:${key.landscapeId}\u0000${key.versionId}:root`
      residency.replaceOwner(handle, owner, `${key.landscapeId}/${key.versionId}`, 'root')
      setPinnedCoreDocument(owner, handle.documentId)
    }
    return healthyUrl
  }
  // Resolve a (landscapeId, versionId) ref to its root. No params → the default
  // landscape's default version (legacy clients unaffected, always bootable). An
  // EXPLICIT ref that doesn't resolve is a dangling workspace (deleted draft/
  // version, wiped landscape) — 404 so the client runs its own fallback-to-default
  // WITH its user-visible warning, instead of us silently handing it the default
  // landscape's root as if it were the requested one.
  app.get('/api/automerge/root', async (req, res) => {
    const landscapeId = typeof req.query.landscapeId === 'string' ? req.query.landscapeId : undefined
    const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : undefined
    try {
      // Stage-aware read gate BEFORE disclosing the root URL — the URL is the
      // capability the WS layer syncs by, so handing it out unchecked would
      // leak another org's workspace to any authenticated user. Same gate as
      // /api/model/* (canonical key + allowedWorkspaceKeys). A null canonical
      // key (unknown landscape / no default version) falls through to
      // resolveRootUrl's own explicit-miss 404 / legacy-fallback handling.
      const canonical = await canonicalWorkspaceKey(pool, {
        landscapeId: landscapeId ?? DEFAULT_WORKSPACE_KEY.landscapeId,
        versionId: versionId ?? DEFAULT_WORKSPACE_KEY.versionId,
      })
      if (canonical && !(await checkWorkspaceAccess(pool, req, canonical))) {
        res.status(403).json({ error: 'forbidden' })
        return
      }
      const url = await resolveRootUrl(landscapeId, versionId, rootUrl)
      if (!url) {
        res.status(404).json({ error: `unknown workspace ${landscapeId ?? 'default'}/${versionId ?? 'current'}` })
        return
      }
      const healthyUrl = canonical
        ? await ensureCanonicalWorkspaceRoot(canonical, url)
        : url
      // A concrete version root is normally stable but may rotate during
      // integrity recovery. ETag/304 caching can otherwise strand a browser on
      // the retired URL even though the server has repaired the workspace.
      res.setHeader('Cache-Control', 'private, no-store')
      // The CANONICAL workspace goes back with the url. It was already computed
      // above and thrown away, and the client needs it: `versionId=current` is a
      // moving pointer, so a tab that never learns which CONCRETE version it
      // booted against has nothing to compare the socket's binding to when a
      // repoint moves the alias under it (§5/N14). Null when the ref did not
      // canonicalise — the legacy fallback path, which has no key to report.
      res.json({
        url: healthyUrl,
        landscapeId: canonical?.landscapeId ?? null,
        versionId: canonical?.versionId ?? null,
      })
    } catch (err) {
      console.error('Resolve root error:', err)
      res.setHeader('Retry-After', '1')
      res.status(503).json({ error: 'workspace root is temporarily unavailable', retryable: true })
    }
  })

  // The server's current Automerge heads for a diagram doc — the "fresh-on-load"
  // signal (see diagramHeads.ts). A boot-from-server client compares these against
  // its LOCAL copy's heads to decide whether to hold the boot loader (local behind)
  // or paint immediately (local already current), so it never flashes a stale
  // layout. Same stage-aware workspace gate as /api/automerge/root; the DiagramDoc
  // URL is resolved by a workspace-scoped read-model lookup (registry walk only
  // when READ_MODEL=off), so a caller can only read heads it was already granted.
  app.get('/api/automerge/doc-heads', async (req, res) => {
    const landscapeId = typeof req.query.landscapeId === 'string' ? req.query.landscapeId : undefined
    const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : undefined
    const id = typeof req.query.id === 'string' ? req.query.id : ''
    if (!id) {
      res.status(400).json({ error: 'missing diagram id' })
      return
    }
    try {
      const canonical = await canonicalWorkspaceKey(pool, {
        landscapeId: landscapeId ?? DEFAULT_WORKSPACE_KEY.landscapeId,
        versionId: versionId ?? DEFAULT_WORKSPACE_KEY.versionId,
      })
      if (canonical && !(await checkWorkspaceAccess(pool, req, canonical))) {
        res.status(403).json({ error: 'forbidden' })
        return
      }
      if (!canonical) {
        res.status(404).json({ error: `unknown workspace ${landscapeId ?? 'default'}/${versionId ?? 'current'}` })
        return
      }
      let docUrl = READ_MODEL_ENABLED
        ? await resolveDiagramDocUrlFromReadModel(pool, canonical, id)
        : null
      if (!READ_MODEL_ENABLED) {
        const url = await resolveRootUrl(landscapeId, versionId, rootUrl)
        if (!url) {
          res.status(404).json({ error: `unknown workspace ${landscapeId ?? 'default'}/${versionId ?? 'current'}` })
          return
        }
        docUrl = await resolveDiagramDocUrlFromRegistry(repo, url, id)
      }
      const heads = docUrl ? await diagramDocHeads(repo, docUrl) : null
      if (!heads) {
        res.status(404).json({ error: 'diagram not found' })
        return
      }
      res.json({ heads })
    } catch (err) {
      console.error('doc-heads error:', err)
      res.status(500).json({ error: 'failed to read diagram heads' })
    }
  })

  // Whether a workspace's OWN registry lists a diagram (see registryHasDiagram):
  // a booting client's answer to "does this version have the diagram I was
  // viewing?" when its own registry copy may be stale. Same stage-aware
  // workspace gate as doc-heads; the root is resolved server-side.
  app.get('/api/automerge/registry-diagram', async (req, res) => {
    const landscapeId = typeof req.query.landscapeId === 'string' ? req.query.landscapeId : undefined
    const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : undefined
    const id = typeof req.query.id === 'string' ? req.query.id : ''
    if (!id) {
      res.status(400).json({ error: 'missing diagram id' })
      return
    }
    try {
      const canonical = await canonicalWorkspaceKey(pool, {
        landscapeId: landscapeId ?? DEFAULT_WORKSPACE_KEY.landscapeId,
        versionId: versionId ?? DEFAULT_WORKSPACE_KEY.versionId,
      })
      if (canonical && !(await checkWorkspaceAccess(pool, req, canonical))) {
        res.status(403).json({ error: 'forbidden' })
        return
      }
      const url = canonical ? await resolveRootUrl(landscapeId, versionId, rootUrl) : null
      if (!url) {
        res.status(404).json({ error: `unknown workspace ${landscapeId ?? 'default'}/${versionId ?? 'current'}` })
        return
      }
      const result = await registryHasDiagram(repo, url, id)
      if (result.state === 'not-found') {
        res.status(404).json({ error: 'registry not found' })
        return
      }
      if (result.state === 'too-large') {
        res.status(422).json({ error: 'registry too large for a presence probe', shardCount: result.shardCount })
        return
      }
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ present: result.present })
    } catch (err) {
      console.error('registry-diagram error:', err)
      res.status(500).json({ error: 'failed to read the registry' })
    }
  })

  // A successful response is the durability boundary behind the client badge:
  // every acknowledged frontier has reached the workspace owner and its
  // PostgreSQL-backed Repo.flush() has completed. Merely receiving WebSocket
  // traffic is intentionally insufficient to report "Synced".
  app.post('/api/automerge/durable-heads', async (req, res) => {
    const landscapeId = typeof req.query.landscapeId === 'string'
      ? req.query.landscapeId
      : DEFAULT_WORKSPACE_KEY.landscapeId
    const versionId = typeof req.query.versionId === 'string'
      ? req.query.versionId
      : DEFAULT_WORKSPACE_KEY.versionId
    const documents = parseDurableHeadRequests(req.body?.documents)
    if (!documents) {
      res.status(400).json({ error: 'invalid durable head request' })
      return
    }
    try {
      const canonical = await canonicalWorkspaceKey(pool, { landscapeId, versionId })
      if (!canonical) {
        res.status(404).json({ error: `unknown workspace ${landscapeId}/${versionId}` })
        return
      }
      if (!(await checkWorkspaceAccess(pool, req, canonical))) {
        res.status(403).json({ error: 'forbidden' })
        return
      }
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ documents: await acknowledgeDurableHeads(repo, pool, canonical, documents) })
    } catch (err) {
      console.error('durable-heads error:', err)
      res.setHeader('Retry-After', '1')
      res.status(503).json({ error: 'durability acknowledgement unavailable', retryable: true })
    }
  })

  /**
   * Mint workspace-bound document ids — T2 step 4.
   *
   * The client asks for ids ahead of time and BANKS them: the browser's
   * minted-id supply (src/lib/automerge/mintedIdSupply.ts) keeps a small
   * IndexedDB reserve topped up, and the repo factories name new documents
   * SYNCHRONOUSLY via `repo.import(binary, { docId })` (`createHandleNamed`,
   * src/lib/automerge/repo.ts) — not via `idFactory`/`create2`, whose await
   * loses documents under pagehide. The sync gate then verifies the id with a
   * MAC instead of a graph traversal. See `rbac/documentIdMint.ts` for why,
   * and `buildWorkspaceRouteCheck` for the verification side.
   *
   * MINTING IS A WRITE CAPABILITY, hence `requireVersionWrite` and not
   * `checkWorkspaceAccess`: an id bound to a workspace is what lets a document
   * enter it, so handing one to a read-only ("View") grant would let them create
   * documents there. This is the only place that decision is made — the gate
   * deliberately does not re-derive permission from the id, because the MAC
   * answers WHICH WORKSPACE and never WHETHER THIS PEER MAY.
   *
   * The binding is to the CANONICAL key. `workspaceForPeer` returns the route
   * canonicalised at the HTTP upgrade, so minting against a version alias (the
   * client may send `current`) would produce ids that never verify.
   */
  app.post('/api/automerge/mint-document-ids', async (req, res) => {
    const landscapeId = typeof req.body?.landscapeId === 'string'
      ? req.body.landscapeId
      : DEFAULT_WORKSPACE_KEY.landscapeId
    const versionId = typeof req.body?.versionId === 'string'
      ? req.body.versionId
      : DEFAULT_WORKSPACE_KEY.versionId
    // Bounded so a client cannot turn this into a CPU sink, and because the
    // offline pool it feeds is deliberately small — a large reserve widens the
    // window in which a revoked member still holds usable ids. (They grant no
    // permission on their own; the write gate still applies at sync time.)
    const requested = Number(req.body?.count ?? 1)
    const count = Number.isFinite(requested) ? Math.floor(requested) : 0
    if (count < 1 || count > MAX_MINTED_IDS_PER_REQUEST) {
      res.status(400).json({ error: `count must be between 1 and ${MAX_MINTED_IDS_PER_REQUEST}` })
      return
    }
    try {
      const canonical = await canonicalWorkspaceKey(pool, { landscapeId, versionId })
      if (!canonical) {
        res.status(404).json({ error: `unknown workspace ${landscapeId}/${versionId}` })
        return
      }
      // THE ENDPOINT'S OWN EXISTENCE LOOKUP, and it is not optional.
      // `requireWorkspaceWrite` returns TRUE for a landscape with no row —
      // "missing landscape: the endpoint's own lookup 404s" is written at that
      // return — so the write gate is not an existence check. And
      // `canonicalWorkspaceKey` only consults the database when the version is
      // the alias `'current'`; otherwise it hands the key straight back. Without
      // this, minting for `nope/nope` answered 200. (Verified against the
      // running stack, which is where it was found — no unit test would have,
      // because there is no route harness in this repo.)
      const { rows: exists } = await pool.query(
        'SELECT 1 FROM versions WHERE landscape_id = $1 AND id = $2',
        [canonical.landscapeId, canonical.versionId],
      )
      if (exists.length === 0) {
        res.status(404).json({ error: `unknown workspace ${landscapeId}/${versionId}` })
        return
      }
      if (!(await requireVersionWrite(pool, req, res, canonical.landscapeId, canonical.versionId))) return
      const ids = Array.from({ length: count }, () =>
        encodeMintedIdForWire(mintDocumentIdBytes(canonical)))
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ landscapeId: canonical.landscapeId, versionId: canonical.versionId, ids })
    } catch (err) {
      // A missing AUTH_SECRET throws here by design rather than minting under an
      // empty key, which would make every workspace's tag identical.
      console.error('mint-document-ids error:', err)
      res.status(503).json({ error: 'document id minting unavailable', retryable: true })
    }
  })

  // --- Multi-landscape registry: editable versions, switch, set-default ---
  app.get('/api/landscapes', async (req, res) => {
    try {
      // A session sees ONLY its pinned org's registry (an org-less session
      // sees an empty one); no claims / stage off keeps the legacy unfiltered
      // list. Applies at 'dual' too — an authenticated dual client is a
      // converted client and must exercise the org-scoped shape before 'on'.
      const claims = req.auth
      if (authStage() !== 'off' && claims) {
        res.json({ landscapes: claims.orgId ? await listLandscapes(claims.orgId) : [] })
        return
      }
      res.json({ landscapes: await listLandscapes() })
    } catch (err) {
      console.error('List landscapes error:', err)
      res.status(500).json({ error: 'Failed to list landscapes' })
    }
  })

  // The session's effective access to one workspace — the client locks its
  // editor read-only from this (`canWrite:false` + `enforced:true`). Distinct
  // from authorization itself: the sync write gate and the REST write gates
  // enforce regardless of what any client does with this answer.
  app.get('/api/me/workspace-access', async (req, res) => {
    try {
      const landscapeId = typeof req.query.landscapeId === 'string' ? req.query.landscapeId : DEFAULT_WORKSPACE_KEY.landscapeId
      const versionId = typeof req.query.versionId === 'string' ? req.query.versionId : DEFAULT_WORKSPACE_KEY.versionId
      const canonical = await canonicalWorkspaceKey(pool, { landscapeId, versionId })
      if (!canonical) {
        res.status(404).json({ error: `unknown workspace ${landscapeId}/${versionId}` })
        return
      }
      res.json({ access: await workspaceAccessForRequest(pool, req, canonical) })
    } catch (err) {
      console.error('Workspace access error:', err)
      res.status(500).json({ error: 'Failed to resolve workspace access' })
    }
  })

  app.post('/api/landscapes', async (req, res) => {
    try {
      const name = typeof req.body?.name === 'string' ? req.body.name : ''
      if (!name.trim()) { res.status(400).json({ error: 'name required' }); return }
      // Creating a landscape shapes the whole org (new scope rows every team
      // sees) — org admins only once auth enforces. Not scope-write-gated:
      // there IS no scope yet to hold a grant on.
      if (!(await requireOrgAdmin(pool, req, res))) return
      // Owner = the session's org (Default Org when auth is off / no session).
      // An org-less session must NOT create landscapes — they'd land in
      // nobody's registry.
      const orgId = await sessionOrgId(pool, req)
      if (!orgId) { res.status(403).json({ error: 'no_org' }); return }
      res.json({ landscape: await createLandscape(repo, name, orgId) })
    } catch (err) {
      // `createLandscape` publishes a root through `repo.flush()`
      // (`createEmptyRoot` in `automergeServer.ts`), so the sync-cell write fence can refuse it.
      // That is transient and the client should come back; a 500 says the
      // opposite. Its neighbour `GET /api/automerge/root` answers 503 for this
      // condition too.
      if (sendDependencyOutage(res, err)) return
      console.error('Create landscape error:', err)
      res.status(500).json({ error: 'Failed to create landscape' })
    }
  })

  app.post('/api/landscapes/:landscapeId/versions', async (req, res) => {
    try {
      if (!(await requireLandscapeInOrg(pool, req, res, req.params.landscapeId))) return
      if (!(await requireLandscapeWrite(pool, req, res, req.params.landscapeId))) return
      const label = typeof req.body?.label === 'string' ? req.body.label : ''
      if (!label.trim()) { res.status(400).json({ error: 'label required' }); return }
      const forkFromVersionId =
        typeof req.body?.forkFromVersionId === 'string' ? req.body.forkFromVersionId : undefined
      const version = await createEditableVersion(repo, req.params.landscapeId, label, forkFromVersionId)
      if (!version) {
        res.status(404).json({ error: forkFromVersionId ? 'Landscape or source version not found' : 'Landscape not found' })
        return
      }
      res.json({ version })
    } catch (err) {
      // T2-v0: forking a summary source is refused until the summary fork
      // publisher ships — a client-visible limit, not a server fault.
      if (err instanceof SummaryForkUnsupportedError) {
        res.status(err.status).json({ error: err.message })
        return
      }
      // Both branches of `createEditableVersion` flush — `forkRoot` for a
      // fork, `createEmptyRoot` in `automergeServer.ts` for an empty root — so both can be
      // refused by the fence. Placed after the summary-fork branch above: that
      // one is a permanent client-visible limit and must not be re-labelled
      // transient. The order is currently vacuous —
      // `SummaryForkUnsupportedError` is not one of the two classes the shared
      // mapping matches, so reordering changes nothing. It is a convention for
      // the day a permanent condition does get mapped, not a live invariant.
      if (sendDependencyOutage(res, err)) return
      console.error('Create editable version error:', err)
      res.status(500).json({ error: 'Failed to create version' })
    }
  })

  app.put('/api/landscapes/:landscapeId/default-version', async (req, res) => {
    try {
      if (!(await requireLandscapeInOrg(pool, req, res, req.params.landscapeId))) return
      if (!(await requireLandscapeWrite(pool, req, res, req.params.landscapeId))) return
      const versionId = typeof req.body?.versionId === 'string' ? req.body.versionId : ''
      const ok = await setDefaultVersion(req.params.landscapeId, versionId)
      if (!ok) { res.status(404).json({ error: 'Version not found in landscape' }); return }
      res.json({ success: true })
    } catch (err) {
      console.error('Set default version error:', err)
      res.status(500).json({ error: 'Failed to set default version' })
    }
  })

  app.patch('/api/landscapes/:landscapeId', async (req, res) => {
    try {
      if (!(await requireLandscapeInOrg(pool, req, res, req.params.landscapeId))) return
      if (!(await requireLandscapeWrite(pool, req, res, req.params.landscapeId))) return
      const name = typeof req.body?.name === 'string' ? req.body.name : ''
      if (!name.trim()) { res.status(400).json({ error: 'name required' }); return }
      const ok = await renameLandscape(req.params.landscapeId, name)
      if (!ok) { res.status(404).json({ error: 'Landscape not found' }); return }
      res.json({ success: true })
    } catch (err) {
      console.error('Rename landscape error:', err)
      res.status(500).json({ error: 'Failed to rename landscape' })
    }
  })

  app.delete('/api/landscapes/:landscapeId', async (req, res) => {
    try {
      if (!(await requireLandscapeInOrg(pool, req, res, req.params.landscapeId))) return
      // Deleting a landscape erases every team's scopes/grants/history under
      // it — org-admin territory, not a per-scope write.
      if (!(await requireOrgAdmin(pool, req, res))) return
      const result = await deleteLandscape(req.params.landscapeId)
      if (!result.ok) { res.status(409).json({ error: result.reason }); return }
      res.json({ success: true })
    } catch (err) {
      console.error('Delete landscape error:', err)
      res.status(500).json({ error: 'Failed to delete landscape' })
    }
  })

  app.patch('/api/landscapes/:landscapeId/versions/:versionId', async (req, res) => {
    try {
      if (!(await requireLandscapeInOrg(pool, req, res, req.params.landscapeId))) return
      if (!(await requireVersionWrite(pool, req, res, req.params.landscapeId, req.params.versionId))) return
      const label = typeof req.body?.label === 'string' ? req.body.label : ''
      if (!label.trim()) { res.status(400).json({ error: 'label required' }); return }
      const ok = await renameVersion(req.params.landscapeId, req.params.versionId, label)
      if (!ok) { res.status(404).json({ error: 'Version not found' }); return }
      res.json({ success: true })
    } catch (err) {
      console.error('Rename version error:', err)
      res.status(500).json({ error: 'Failed to rename version' })
    }
  })

  app.delete('/api/landscapes/:landscapeId/versions/:versionId', async (req, res) => {
    try {
      if (!(await requireLandscapeInOrg(pool, req, res, req.params.landscapeId))) return
      if (!(await requireVersionWrite(pool, req, res, req.params.landscapeId, req.params.versionId))) return
      const result = await deleteEditableVersion(req.params.landscapeId, req.params.versionId)
      if (!result.ok) { res.status(409).json({ error: result.reason }); return }
      res.json({ success: true })
    } catch (err) {
      console.error('Delete version error:', err)
      res.status(500).json({ error: 'Failed to delete version' })
    }
  })

  // --- Drafts: a draft is a fork of the landscape's default version,
  // kind='draft', edited in isolation; merge/diff come in later slices. ---
  app.get('/api/landscapes/:landscapeId/drafts', async (req, res) => {
    try {
      if (!(await requireLandscapeInOrg(pool, req, res, req.params.landscapeId))) return
      res.json({ drafts: await listDrafts(req.params.landscapeId) })
    } catch (err) {
      console.error('List drafts error:', err)
      res.status(500).json({ error: 'Failed to list drafts' })
    }
  })

  app.post('/api/landscapes/:landscapeId/drafts', async (req, res) => {
    try {
      if (!(await requireLandscapeInOrg(pool, req, res, req.params.landscapeId))) return
      // A draft only makes sense for someone who could contribute it back —
      // and its forked scope inherits the same grants, so a read-only user
      // couldn't even edit the draft they created.
      if (!(await requireLandscapeWrite(pool, req, res, req.params.landscapeId))) return
      const label = typeof req.body?.label === 'string' ? req.body.label : ''
      if (!label.trim()) { res.status(400).json({ error: 'label required' }); return }
      const draft = await createDraft(repo, req.params.landscapeId, label)
      if (!draft) { res.status(404).json({ error: 'Landscape or default version not found' }); return }
      res.json({ draft })
    } catch (err) {
      // T2-v0: only the summary parent that would need the DEEP fork is
      // refused; a healthy summary parent still takes the sparse O(1) branch.
      if (err instanceof SummaryForkUnsupportedError) {
        res.status(err.status).json({ error: err.message })
        return
      }
      // The sparse branch (`createSparseDraftRoot`) flushes three times and the
      // deep branch (`forkRoot`) once; either can be
      // fenced off. Same ordering rule as the version door above.
      if (sendDependencyOutage(res, err)) return
      console.error('Create draft error:', err)
      res.status(500).json({ error: 'Failed to create draft' })
    }
  })

  app.patch('/api/landscapes/:landscapeId/drafts/:draftId', async (req, res) => {
    try {
      if (!(await requireLandscapeInOrg(pool, req, res, req.params.landscapeId))) return
      if (!(await requireLandscapeWrite(pool, req, res, req.params.landscapeId))) return
      const status = typeof req.body?.status === 'string' ? req.body.status : ''
      const ok = await setDraftStatus(req.params.landscapeId, req.params.draftId, status)
      if (!ok) { res.status(404).json({ error: 'Draft not found or invalid status' }); return }
      res.json({ success: true })
    } catch (err) {
      console.error('Set draft status error:', err)
      res.status(500).json({ error: 'Failed to update draft' })
    }
  })

  // The draft's 3-way changes vs its parent: created/updated/deleted model +
  // diagram changes + conflicts + counts. Drives the Changes dropdown and (later) merge.
  app.get('/api/landscapes/:landscapeId/drafts/:draftId/changes', async (req, res) => {
    try {
      if (!(await requireLandscapeInOrg(pool, req, res, req.params.landscapeId))) return
      const draftKey = { landscapeId: req.params.landscapeId, versionId: req.params.draftId }
      const draftRoot = await resolveRootUrl(draftKey.landscapeId, draftKey.versionId, '')
      if (draftRoot) await ensureCanonicalWorkspaceRoot(draftKey, draftRoot)
      const result = await computeDraftChanges(repo, req.params.landscapeId, req.params.draftId)
      if (!result) { res.status(404).json({ error: 'Draft not found or has no captured base' }); return }
      res.json(result)
    } catch (err) {
      // A LIFECYCLE REFUSAL IS NOT A SERVER FAULT. `ensureCanonicalWorkspaceRoot`
      // can now refuse — the root rotation behind it takes the workspace apply
      // key — and this handler is not `route()`-wrapped, so it cannot inherit
      // `routeErrors`' mapping. Without this branch a draft read answers an
      // opaque, non-retryable 500 while the honest answer is "a promotion is
      // running, come back".
      if (err instanceof LifecycleApplyRefusedError) {
        res.setHeader('Retry-After', '5')
        res.status(503).json({ error: err.message, code: err.code, retryable: true })
        return
      }
      // `ensureCanonicalWorkspaceRoot` above can rotate a root through the
      // fenced adapter (`degenerateRootRepair.ts`), so a fence
      // refusal reaches here and must answer 503 like its neighbours, not 500.
      if (sendDependencyOutage(res, err)) return
      console.error('Draft changes error:', err)
      res.status(500).json({ error: 'Failed to compute draft changes' })
    }
  })

  // Merge a draft into the live model: applies the non-conflicting changeset onto the
  // parent version in place + snapshots a new version + marks the draft merged. Blocked
  // (409 + the conflicts) when the live model changed the same things the draft did.
  app.post('/api/landscapes/:landscapeId/drafts/:draftId/merge', async (req, res) => {
    try {
      if (!(await requireLandscapeInOrg(pool, req, res, req.params.landscapeId))) return
      // Merging writes the draft's changes INTO ITS PARENT version — gate on
      // write access to that parent (a version-scoped write grant suffices;
      // an unknown draft falls through for applyMerge's own 404).
      const { rows: draftRows } = await pool.query<{ parent_version_id: string | null }>(
        `SELECT parent_version_id FROM versions WHERE id = $1 AND landscape_id = $2 AND kind = 'draft'`,
        [req.params.draftId, req.params.landscapeId]
      )
      const parentVersionId = draftRows[0]?.parent_version_id
      if (parentVersionId) {
        if (!(await requireVersionWrite(pool, req, res, req.params.landscapeId, parentVersionId))) return
      } else if (!(await requireLandscapeWrite(pool, req, res, req.params.landscapeId))) {
        return
      }
      // THE AUTHORITY TO WRITE THE PARENT, AND THE ROOT REPAIRS, IN ONE PLACE.
      // The ordering, the rotation witness and the refusal's wording all live
      // in `syncCells/mergePlacement.ts`, because `index.ts` exports nothing and
      // no test loads it.
      //
      // THE CROSS-PARTITION EVENT IS REPORTED, NEVER REFUSED. A merge writes
      // BOTH workspaces and `assignment.ts` hashes each key separately, so at
      // `SYNC_CELL_PARTITION_COUNT > 1` the draft and its parent generally land
      // in different partitions; routing by the parent places one owner out of
      // two. Refusing would break every such merge, and there is no second
      // owner to send the other half to. `assignment.ts` records that the mid-flight
      // two-owner detector was dropped, which is why this witness exists at all.
      const refusal = await placeMergeWrite({
        ownership: syncCellOwnership,
        landscapeId: req.params.landscapeId,
        draftId: req.params.draftId,
        parentVersionId: parentVersionId ?? null,
        resolveRootUrl: (key) => resolveRootUrl(key.landscapeId, key.versionId, ''),
        ensureCanonicalRoot: (key, url, observe) => ensureCanonicalWorkspaceRoot(key, url, observe),
        onUnownedRotation: ({ half, key }) => {
          console.warn(JSON.stringify({
            event: 'sync.cell.merge_root_rotated_unowned',
            half,
            assignedPartition: syncCellOwnership?.partitionFor(key) ?? null,
            localPartition: syncCellOwnership?.readSnapshot().partitionIndex ?? null,
          }))
        },
      })
      if (refusal) {
        res.setHeader('Retry-After', refusal.retryAfterSeconds)
        res.status(refusal.status).json(refusal.body)
        return
      }
      const resolutions =
        req.body && typeof req.body.resolutions === 'object' && req.body.resolutions !== null
          ? (req.body.resolutions as Record<string, 'draft' | 'live'>)
          : {}
      const result = await applyMerge(
        repo,
        req.params.landscapeId,
        req.params.draftId,
        resolutions,
        { residency: automergeResidency ?? undefined },
      )
      if (!result) { res.status(404).json({ error: 'Draft not found or not mergeable' }); return }
      if (!result.ok) {
        if ('blocked' in result) { res.status(409).json({ error: result.blocked }); return }
        res.status(409).json({ conflicts: result.conflicts }); return
      }
      res.json({ versionId: result.versionId })
    } catch (err) {
      // NO AUTHORITY TO WRITE THE PARENT. Thrown by
      // `requireWriteAuthority` BEFORE the root loop, so nothing has been
      // written when this fires — the one refusal on this route that can say so
      // without qualification. The mapping is `writeAuthorityRefusal`, shared
      // with the module that throws it so the two spellings cannot drift.
      if (err instanceof WriteAuthorityUnavailableError) {
        const refusal = writeAuthorityRefusal(err)
        res.setHeader('Retry-After', refusal.retryAfterSeconds)
        res.status(refusal.status).json(refusal.body)
        return
      }
      // Same reasoning as the draft-changes handler above, and it matters more
      // here: this is a WRITE the user initiated, so answering an opaque 500
      // for "a promotion holds the key" tells them their merge failed when it
      // has not yet been attempted.
      if (err instanceof LifecycleApplyRefusedError) {
        res.setHeader('Retry-After', '5')
        res.status(503).json({ error: err.message, code: err.code, retryable: true })
        return
      }
      // TWO independent ways in: the root rotation in `placeMergeWrite` and
      // `applyMerge`'s flushes. A merge interrupted by this condition can leave
      // durable documents behind, which is why the shared mapping refuses to
      // call it safe to repeat.
      if (sendDependencyOutage(res, err)) return
      console.error('Draft merge error:', err)
      res.status(500).json({ error: 'Failed to merge draft' })
    }
  })
  // Privacy-minimized process telemetry. The transport snapshot deliberately
  // exposes no peer, user, organization, workspace or document identifiers.
  // It reports only bounded fan-out distributions and queue-pressure counters.
  app.get('/api/automerge/stats', (req, res) => {
    if (!requirePlatformAdminAtStageOn(req, res)) return
    const handles = Object.values(cachedHandles(repo))
    const byState: Record<string, number> = {}
    for (const h of handles) byState[h.state] = (byState[h.state] ?? 0) + 1
    const transport = req.query.eventLoopWindow === 'consume'
      ? transportTelemetry.snapshotAndResetEventLoopDelay()
      : transportTelemetry.snapshot()
    const synchronizer = repo.synchronizer as unknown as {
      peers: string[]
      docSynchronizers: Record<string, { hasPeer(peerId: string): boolean }>
      retirementMetrics?: () => { count: number; limit: number; overLimit: boolean }
    }
    res.json({
      generatedAt: new Date().toISOString(),
      // The same per-process identity the residency snapshot carries. The
      // counters below are diffed by the caller at window edges, so the caller
      // needs this to detect a restart inside the window (otherwise a reset
      // `documentsWithPeers` reads as a peer-binding drop).
      processBootId: currentProcessBootId(),
      totalHandles: handles.length,
      // Monotonic, diffed by the caller at the window edges. Never reset
      // here: a counter reset by a path other than the one that owns the window
      // describes a different interval than everything it is compared against.
      syncStateLookup: { ...syncStateLookupMetrics },
      byState,
      joinedConnections: connectionRegistry.liveConnectionCount(),
      synchronizer: {
        ...lightweightSynchronizerPeerSnapshot(synchronizer),
        retiredDocuments: synchronizer.retirementMetrics?.() ?? null,
      },
      transport,
    })
  })

  // Daily off-hours GC uses separate locks for the global Automerge reachable
  // walk and technology assets. Asset cleanup is PostgreSQL/filesystem-only,
  // so it remains available in multi-partition mode even while Repo GC is
  // deliberately refused without a fenced global worker.
  const gcTz = process.env.GC_TZ ?? process.env.COMPACTION_TZ ?? 'America/Toronto'
  type GcOutcome = RepoMaintenanceOutcome<Awaited<ReturnType<typeof gcOrphanedDocs>>>
  const runGc = singleFlight((): Promise<GcOutcome> =>
    runOwnedFencedRepoMaintenance('automerge_gc', 'global-repo', defaultWorkspaceKey, async (fence) => {
      const r = await gcOrphanedDocs(repo, { fence })
      console.log(
        r.aborted
          ? '[gc] aborted — reachable set incomplete (a root/shard failed to load); nothing deleted'
          : `[gc] deleted ${r.deleted} orphan doc(s) — roots=${r.roots} reachable=${r.reachable} stored=${r.stored}`
            + ` skippedInMemory=${r.skippedInMemory} deferredYoung=${r.deferredYoung}`
      )
      return r
    }))
  const runTechnologyAssetGc = async () => maintenanceCoordinator!.run('technology_asset_gc', async () => {
    const assets = await gcStaleTechnologyAssets(pool)
    console.log(
      `[gc] technology assets scanned=${assets.scanned} metadataDeleted=${assets.metadataDeleted}`
      + ` blobsDeleted=${assets.blobsDeleted} missing=${assets.missingBlobs} deferred=${assets.deferred}`
    )
    return assets
  })
  // The daily sweep is destructive; the reachable walk includes snapshot manifests
  // and aborts on a degenerate parent (see gc.ts). Set GC=off to disable just the
  // schedule (the on-demand endpoint stays available). KNOWN residual: a doc
  // created right before its registry link syncs, then idle-evicted before GC, could
  // be swept — but the client re-pushes it on reconnect, so the loss self-heals.
  if (process.env.GC !== 'off') {
    maintenanceScheduleStops.push(scheduleDailyAt(2, 0, gcTz, async () => {
      const [outcome, assetOutcome] = await Promise.all([runGc(), runTechnologyAssetGc()])
      if (outcome.status === 'skipped_locked') {
        console.log('[gc] skipped; another replica owns the job')
      } else if (outcome.status === 'skipped_ownership') {
        console.log(`[gc] skipped by sync-cell ownership admission: ${outcome.reason}`)
      }
      if (assetOutcome.status === 'skipped_locked') {
        console.log('[gc] technology asset cleanup skipped; another replica owns the job')
      }
    }))
    console.log(`[gc] orphaned-doc GC scheduled daily at 02:00 ${gcTz}`)
  } else {
    console.log('[gc] daily schedule disabled (GC=off); on-demand /api/automerge/gc still available')
  }

  // Document-growth sampler. Deliberately OUTSIDE the GC branch: it must run whether or
  // not the daily job is enabled, because the signal it carries — documents
  // advertised in the registry with no data chunk — is a correctness alarm, not
  // housekeeping. Sampled on a timer because the aggregate is a full scan.
  {
    // Parsed through `envNumber`: a bare `Math.max` is not a guard against NaN
    // (it propagates it), and this value goes to a `setInterval` that does not
    // throw on NaN.
    const growthIntervalMs = Math.max(10_000, envNumber('DOCUMENT_GROWTH_SAMPLE_MS', {
      fallback: 60_000, minimum: 1, maximum: 86_400_000,
    }))
    const stopGrowthSampler = startDocumentGrowthSampler(pool, growthIntervalMs)
    process.once('SIGTERM', stopGrowthSampler)
    process.once('SIGINT', stopGrowthSampler)
    console.log(`[metrics] document-growth sampler every ${growthIntervalMs} ms`)
  }
  app.post('/api/automerge/gc', async (req, res) => {
    if (!requirePlatformAdminAtStageOn(req, res)) return
    try {
      const outcome = await runGc()
      if (outcome.status === 'completed') {
        await runTechnologyAssetGc()
        res.json(outcome.value)
      } else if (outcome.status === 'skipped_ownership') {
        res.status(outcome.retryable ? 503 : 409).json({
          status: outcome.status,
          reason: outcome.reason,
          retryable: outcome.retryable,
        })
      } else {
        res.status(outcome.status === 'skipped_locked' ? 202 : 503).json({
          status: outcome.status,
          reason: outcome.status === 'skipped_locked' ? 'already_running_on_another_replica' : 'server_stopping',
        })
      }
    } catch (err) {
      console.error('GC error:', err)
      res.status(500).json({ error: 'GC failed' })
    }
  })

  // The minted-orphan reaper. Hourly, under the coordinator's
  // job-name lease and fence, and deliberately NOT through
  // `runOwnedFencedRepoMaintenance`: that wrapper's ownership admission exists
  // because the GC's in-memory set has to be the whole fleet's. The reaper's
  // predicate is local to each row and its MAC check against `versions`
  // protects anything a live version owns, so it is safe wherever it runs
  // (mintedOrphanReaper.ts, § why this is not gcOrphanedDocs). Set
  // MINTED_ORPHAN_REAPER=off to disable the schedule; the endpoint stays.
  const runMintedOrphanReaper = singleFlight(() =>
    maintenanceCoordinator!.runFenced('minted_orphan_reaper', (fence) => reapMintedOrphans(repo, { db: pool, fence })))
  if (process.env.MINTED_ORPHAN_REAPER !== 'off') {
    // Bounds as literals — `envNumber.test.ts` parses them. One hour, one minute, one day.
    const reaperIntervalMs = envNumber('MINTED_ORPHAN_REAPER_INTERVAL_MS', {
      fallback: 3_600_000, minimum: 60_000, maximum: 86_400_000, integer: true,
    })
    const reaperTimer = setInterval(() => {
      void runMintedOrphanReaper().then((outcome) => {
        if (outcome.status === 'skipped_locked') console.log('[minted-orphan-reaper] skipped; another replica owns the job')
      }).catch((err) => {
        console.error('[minted-orphan-reaper] run failed:', err)
      })
    }, reaperIntervalMs)
    reaperTimer.unref()
    maintenanceScheduleStops.push(() => clearInterval(reaperTimer))
    console.log(`[minted-orphan-reaper] scheduled every ${reaperIntervalMs} ms`)
  } else {
    console.log('[minted-orphan-reaper] schedule disabled (MINTED_ORPHAN_REAPER=off); on-demand /api/automerge/reap-minted-orphans still available')
  }
  app.post('/api/automerge/reap-minted-orphans', async (req, res) => {
    if (!requirePlatformAdminAtStageOn(req, res)) return
    try {
      const reportOnly = req.query.reportOnly === '1' || req.query.reportOnly === 'true'
      const outcome = reportOnly
        ? await maintenanceCoordinator!.runFenced('minted_orphan_reaper', (fence) => reapMintedOrphans(repo, { db: pool, fence, reportOnly: true }))
        : await runMintedOrphanReaper()
      if (outcome.status === 'completed') {
        res.json(outcome.value)
      } else {
        res.status(outcome.status === 'skipped_locked' ? 202 : 503).json({
          status: outcome.status,
          reason: outcome.status === 'skipped_locked' ? 'already_running_on_another_replica' : 'server_stopping',
        })
      }
    } catch (err) {
      console.error('[minted-orphan-reaper] error:', err)
      res.status(500).json({ error: 'minted-orphan reaper failed' })
    }
  })

  // Premium read model: project the Automerge model into Postgres + serve queries.
  // A projection failure must not take the sync peer down (the read model is a
  // cache, never the source of truth).
  if (READ_MODEL_ENABLED) {
    try {
      // Project the root CLIENTS actually resolve for the default workspace (the
      // landscapes registry), not the legacy automerge_meta root. They start out
      // identical, but a wipe/reseed or a set-default can repoint the registry —
      // projecting the stale legacy root would then serve a model no client sees.
      const projectorRoot = (await resolveRootUrl(undefined, undefined, rootUrl)) ?? rootUrl
      if (projectorRoot !== rootUrl) {
        console.warn(
          `[read-model] default workspace root (${projectorRoot}) differs from the legacy automerge_meta root (${rootUrl}) — projecting the workspace root`
        )
      }
      // The fleet owns every projector lifecycle, including the default. Its
      // admission callback is checked before and after a cold build, while the
      // ownership-loss listener invalidates an in-flight generation and
      // detaches already-resident listeners immediately.
      readModelFleet = new ProjectorFleet(repo, resolveRootUrl, {
        fallbackRootUrl: rootUrl,
        db: readModelPool,
        coldBuildAdmission,
        residency,
        ownsWorkspace: (key) => !syncCellOwnership?.enabled || syncCellOwnership.owns(key),
      })
      readModelFleet.pin(defaultWorkspaceKey)

      // Bind the divergence check to this cell's repo. One resident, owned
      // workspace per tick: materialising every model on a timer would put
      // O(workspace) work on the same event loop as the sync fan-out and the
      // projector.
      // DEFAULT OFF, because the check is known to be unreliable: it throws on
      // a registry-advertised diagram the projector deliberately tolerates, its
      // flow kind compares a registry against a posting table (an
      // all-non-message flow is permanent false divergence), and one global
      // verdict slot makes the round-robin publish whichever workspace ran
      // last. Running it by default would page on noise. Opt in with
      // READ_MODEL_DIVERGENCE=on.
      stopDivergenceScheduler = process.env.READ_MODEL_DIVERGENCE === 'on'
        ? startDivergenceScheduler({
        pool: readModelPool,
        intervalMs: Number(process.env.READ_MODEL_DIVERGENCE_INTERVAL_MS ?? 15 * 60_000),
        isEligible: (key) => Boolean(readModelFleet?.isResident(key))
          && (!syncCellOwnership?.enabled || syncCellOwnership.owns(key)),
        // INDEPENDENT oracle. This deliberately does NOT use
        // extractModelEntities: that is the projector's own extractor, and
        // building the CRDT operand with it made the detector compare the
        // writer against itself — proven to report `clean` with a third of the
        // read model missing. collectCrdtInventory re-walks the graph and
        // throws where the projector's traversal shrugs.
        loadCrdtEntities: async (key) => {
          const workspaceRoot = await resolveRootUrl(key.landscapeId, key.versionId, '')
          if (!workspaceRoot) throw new Error(`no root url for ${key.landscapeId}/${key.versionId}`)
          const rootHandle = await findReadyDocument(repo, workspaceRoot)
          return collectCrdtInventory(
            rootHandle.doc(),
            async (url) => (await findReadyDocument(repo, url)).doc(),
          )
        },
          })
        : null
      if (!stopDivergenceScheduler) {
        console.log('[read-model] divergence detector disabled (set READ_MODEL_DIVERGENCE=on to enable)')
      }
      stopReadModelOwnershipListener = syncCellOwnership!.onOwnershipLost(({ workspace, reason }) => {
        readModelFleet?.release(workspace, reason)
        staticDeltaProjector?.release(workspace, reason)
      })
      if (syncCellOwnership!.owns(defaultWorkspaceKey)) {
        try {
          await readModelFleet.ensure(defaultWorkspaceKey)
        } catch (error) {
          // A PROMOTED default workspace has no ordinary projector by design —
          // boot must continue, not abort. Same for a lost lease.
          if (error instanceof ProjectorStaticWorkspaceError) {
            console.log('[read-model] default workspace is summary/static — served by the static delta projector')
          } else if (!(error instanceof ProjectorOwnershipError)) throw error
        }
      }
      if (readiness.shuttingDown) return
      staticDeltaProjector = new StaticDeltaProjector(
        repo,
        readModelPool,
        250,
        10_000,
        (key) => !syncCellOwnership?.enabled || syncCellOwnership.owns(key),
        syncCellOwnership
          ? {
              enabled: syncCellOwnership.enabled,
              fencingToken: (key) => syncCellOwnership?.fencingToken(key) ?? null,
            }
          : undefined,
        residency,
        setPinnedCoreDocument,
        forgetDocumentRequests,
      )
      await staticDeltaProjector.start()
      // Do not advertise the pod while the default cold build or static
      // descriptor/control-document hydration is still consuming the same DB,
      // Repo and event loop as user reads. The first post-ready request must see
      // the fully attached read plane, not compete with startup work.
      readiness.readModel = true
      console.log(
        'Read-model projector fleet + static delta projector ready (READ_MODEL=on); only locally-owned workspaces may attach listeners'
      )

      // Daily overlay compaction: fold the persistent edits overlay back into the base
      // shards + clear it (CRDT-safe under concurrent edits — see compaction.ts), then
      // restart the projector so its cold build re-derives the read model
      // (overlay-last-wins) from the compacted shards. The cold build is
      // authoritative, healing any transient delta from compaction's writes.
      // Serialized by awaiting, so a manual + scheduled run can't overlap.
      //
      // NOTE: the projector restart is NOT conditional on something having been
      // folded. `runWorkspaceCompaction` detaches UNCONDITIONALLY — before it
      // can know whether there is anything to fold — and its `finally`
      // re-attaches unconditionally too. On an EMPTY overlay at 200 000 objects
      // the fold returns in 0.2 ms and the re-attach still runs for ~32 s.
      // The pass itself lives in `readModel/workspaceCompaction.ts` — see its
      // header. What stays here is the wiring: which workspace, and the deps
      // this process owns.
      // THE WHOLE OUTCOME, not just its counts: callers must be able to learn
      // that a fold succeeded and left the read plane DOWN
      // (`skipped_reattach_no_root`). The HTTP response below sends `.result`;
      // the queue reads the `reattach` half.
      type CompactionOutcome = RepoMaintenanceOutcome<WorkspaceCompactionOutcome>
      // One single-flight latch PER WORKSPACE. A single shared latch would make a
      // request for workspace B join a run already in flight for A and receive
      // A's counts — the same confusion of workspaces this route is being fixed
      // to end, moved one layer down. Bounded by the allow-list: only the default
      // workspace and explicitly named ones can ever create an entry.
      const compactionRunners = new Map<string, () => Promise<CompactionOutcome>>()
      const compactionRunner = (key: WorkspaceKey): (() => Promise<CompactionOutcome>) => {
        const id = `${key.landscapeId}/${key.versionId}`
        const existing = compactionRunners.get(id)
        if (existing) return existing
        const runner = singleFlight((): Promise<CompactionOutcome> =>
        runOwnedRepoMaintenance(
          'default_compaction',
          'workspace',
          key,
          async (): Promise<WorkspaceCompactionOutcome> => {
            // THE ROOT MUST BE THIS WORKSPACE'S. `projectorRoot` is the DEFAULT
            // workspace's root; passing it while compacting a named workspace
            // would rewrite the default workspace's base shards and report the
            // counts as the named one's — the same substitution this route is
            // being fixed to end. Resolved per run, and a workspace whose root
            // cannot be resolved is refused rather than compacted against a
            // fallback.
            const workspaceRoot = key.landscapeId === defaultWorkspaceKey.landscapeId
              && key.versionId === defaultWorkspaceKey.versionId
              ? projectorRoot
              : await resolveRootUrl(key.landscapeId, key.versionId, '')
            if (!workspaceRoot) {
              throw new Error(
                `compaction refused: no root_url for ${key.landscapeId}/${key.versionId} — `
                + 'compacting against a fallback root would rewrite another workspace',
              )
            }
            const outcome = await runWorkspaceCompaction(key, {
              repo,
              rootUrl: workspaceRoot,
              db: pool,
              fleet: {
                isResident: (key) => readModelFleet!.isResident(key),
                ensure: (key) => readModelFleet!.ensure(key),
                release: (key, reason) => readModelFleet!.release(key, reason),
                residentProjectorInstanceId: (key) => readModelFleet!.residentProjectorInstanceId(key) ?? null,
              },
              ownership: { owns: (key) => syncCellOwnership!.owns(key) },
              isShuttingDown: () => readiness.shuttingDown,
            })
            return outcome
          },
        ))
        compactionRunners.set(id, runner)
        return runner
      }
      /** The scheduled daily pass — always the default workspace. */
      const runCompaction = () => compactionRunner(defaultWorkspaceKey)()

      // Default 00:00 America/Toronto (Montreal); override the zone with COMPACTION_TZ.
      const tz = process.env.COMPACTION_TZ ?? 'America/Toronto'
      maintenanceScheduleStops.push(scheduleDailyAt(0, 0, tz, async () => {
        const outcome = await runCompaction()
        if (outcome.status === 'skipped_locked') {
          console.log('[compaction] skipped; another replica owns the job')
        } else if (outcome.status === 'skipped_ownership') {
          console.log(`[compaction] skipped by sync-cell ownership admission: ${outcome.reason}`)
        }
      }))
      console.log(`[compaction] scheduled daily at 00:00 ${tz}`)

      // On-demand trigger (verification / manual maintenance).
      app.post('/api/model/compact', route(async (req, res) => {
        if (!requirePlatformAdminAtStageOn(req, res)) return
        // STOPS IGNORING THE QUERY. `parseWorkspaceHttpRoute` already reads
        // landscapeId/versionId off this request and routes it to the owning
        // cell; this handler then ran the DEFAULT workspace's compaction and
        // answered 200 with its counts. A request naming workspace B destroyed
        // workspace A's overlay and reported it as B's.
        //
        // `ensureWorkspace` canonicalizes, checks access and handles ownership
        // refusals — the same path every other workspace-scoped route uses, so a
        // named workspace cannot be compacted by someone who cannot read it.
        const requested = await ensureWorkspace(req, res)
        if (!requested) return
        const admission = admitCompaction(requested, defaultWorkspaceKey, parseCompactionAllowlist())
        if (!admission.allowed) {
          // A NAMED refusal, carrying the workspace that was asked for. Empty by
          // default, so an unset deployment reaches exactly the behaviour it has
          // today for a named workspace — refusal — instead of silently
          // compacting a different one.
          res.status(409).json({
            status: 'refused',
            reason: admission.reason,
            requested: admission.requested,
            hint: `add "${admission.requested}" to ${COMPACTION_ALLOWLIST_ENV} to allow it`,
          })
          return
        }
        const outcome = await compactionRunner(requested)()
        if (outcome.status === 'completed') {
          // `.result`, so this response is unchanged by the runner now carrying
          // the re-attach outcome too.
          res.json(outcome.value.result)
        } else if (outcome.status === 'skipped_ownership') {
          res.status(outcome.retryable ? 503 : 409).json({
            status: outcome.status,
            reason: outcome.reason,
            retryable: outcome.retryable,
          })
        } else {
          res.status(outcome.status === 'skipped_locked' ? 202 : 503).json({
            status: outcome.status,
            reason: outcome.status === 'skipped_locked' ? 'already_running_on_another_replica' : 'server_stopping',
          })
        }
      }))

      // ── The compaction queue ──────────────────────────────────────────────
      //
      // TWO SWITCHES, BOTH OFF BY DEFAULT, AND NEITHER IS ENOUGH ALONE.
      // `COMPACTION_QUEUE=on` says this cell may run windows;
      // `COMPACTION_WORKSPACE_ALLOWLIST` says which workspaces may be proposed,
      // and it is empty unless an operator writes it. A deployment that upgrades
      // therefore acquires nothing: the queue enumerates, admits nobody, claims
      // nothing. That is deliberate — `compactOverlay` rewrites base shards in
      // place and has seen very little production use.
      //
      // THE DEFAULT WORKSPACE IS NOT PROPOSED HERE. It keeps the daily schedule
      // above until the queue has run on named workspaces; `admitCompaction`
      // answers `scope: 'default'` for it, and only `'allowlisted'` is admitted.
      // A floor of one minute, not zero: a dangling `COMPACTION_QUEUE_TICK_MS=`
      // parses to 0, and a zero-interval timer on a destructive job is the one
      // misconfiguration that would be indistinguishable from an attack.
      // PLAIN LITERALS, not `60 * 60 * 1_000`, and that is a requirement rather
      // than a preference: `envNumber.test.ts` scans these bounds rows from
      // SOURCE and cannot evaluate arithmetic; a row whose real bounds the
      // checker cannot read is a knob nothing validates.
      // 3 600 000 ms = 1 h, 86 400 000 = 24 h.
      const compactionQueueTickMs = envNumber('COMPACTION_QUEUE_TICK_MS', {
        fallback: 3_600_000,
        minimum: 60_000,
        maximum: 86_400_000,
      })
      const compactionQueue = createCompactionQueue({
        // The lease is the module's constant, not a literal repeated here: a
        // test asserts its relation to `DEFAULT_WINDOW_CAP` against the measured
        // worst-case pass, and two copies would let that assertion go stale.
        queue: dueWorkSeam(pool, syncCellOwnershipConfig().cellId, DEFAULT_CLAIM_LEASE_MS),
        // Read on every claim and before every unit, never captured — see the
        // dep's own docstring for why a switch read at boot is not a switch.
        // THE THIRD PRECONDITION, and it is not a switch — it is a refusal to
        // run under an exclusion that cannot tell workspaces apart. With
        // `MAINTENANCE_WORKSPACE_KEYED` off (the shipped default) the
        // coordinator takes the JOB-NAME advisory lock, cluster-wide, and writes
        // every workspace's run into ONE `maintenance_job_status` row — shared
        // `run_count`, `runner_id`, `last_error_code` (see `coordinator.ts`). A
        // manual run per workspace can live with that. An unattended job over
        // many workspaces cannot: a failure would be recorded against a row
        // that does not say which workspace failed.
        killSwitch: () =>
          compactionQueueEnabled()
          && workspaceKeyedMaintenanceEnabled(),
        // Ownership BEFORE the preview, which is a walk of every base shard.
        // `syncCellOwnership.owns` is universally true when sync cells are
        // disabled, so this changes nothing for a single-cell deployment.
        owns: (workspace) => !syncCellOwnership?.enabled || syncCellOwnership.owns(workspace),
        // Only a workspace this cell already serves. Keeps the pass out of the
        // cold-entry path, the larger half of the lock hold, and
        // keeps the `ro_*` count below from being taken on a read model that was
        // never built.
        isResident: (workspace) => readModelFleet!.isResident(workspace),
        admit: (workspace) => {
          const admission = admitCompaction(workspace, defaultWorkspaceKey, parseCompactionAllowlist())
          return admission.allowed && admission.scope === 'allowlisted'
        },
        // BOUND (iii)'s first term: the number of
        // objects+connections the read model holds for this workspace. Two index
        // scans on the composite primary key's leading columns.
        measure: async (workspace) => {
          try {
            const { rows } = await pool.query<{ objects: string; connections: string }>(
              `SELECT (SELECT count(*) FROM ro_objects WHERE landscape_id = $1 AND version_id = $2) AS objects,
                      (SELECT count(*) FROM ro_connections WHERE landscape_id = $1 AND version_id = $2) AS connections`,
              [workspace.landscapeId, workspace.versionId],
            )
            const row = rows[0]
            if (!row) return null
            return { objects: Number(row.objects), connections: Number(row.connections) }
          } catch (error) {
            // `null` is "could not tell", which the queue refuses on. Swallowing
            // this into a zero would turn a statement timeout into permission to
            // enter a workspace of unknown size.
            console.warn(`[compaction-queue] size query failed for ${workspace.landscapeId}/${workspace.versionId}: ${String(error)}`)
            return null
          }
        },
        // The preview: what an apply WOULD fold, with `.change()` never
        // called. Runs BEFORE anything detaches the read plane, so an empty
        // fold never pays for a detach/re-attach.
        preview: async (workspace) => {
          const rootUrl = await resolveRootUrl(workspace.landscapeId, workspace.versionId, '')
          if (!rootUrl) return null
          const forecast = await compactOverlay(repo, rootUrl, { workspace, mode: 'preview' })
          return {
            folded: forecast.objectsFolded + forecast.connectionsFolded,
            deleted: forecast.objectsDeleted + forecast.connectionsDeleted,
          }
        },
        compact: async (workspace) => {
          const outcome = await compactionRunner(workspace)()
          // `skipped_locked` (another replica holds the job), `skipped_stopping`
          // and `skipped_ownership` mean the pass never ran.
          if (outcome.status !== 'completed') return { ran: false, reason: outcome.status }
          // AND `completed` IS NOT ENOUGH. `runWorkspaceCompaction` returns
          // NORMALLY, with zero counts and a `skippedReason`, for four of its own
          // refusals — `summary_workspace`, `projection_not_acknowledged`,
          // `foreign_projector_instance`, `ownership_lost_mid_fold` — and the
          // coordinator stamps all four `completed`. Reading only the status
          // would book them as a compaction of zero and DELETE the due-work row,
          // so a workspace whose projector is one generation behind (normal for
          // a fat overlay) would lose its turn every window, under a green report.
          if (outcome.value.result.skippedReason !== undefined) {
            return { ran: false, reason: outcome.value.result.skippedReason }
          }
          return {
            ran: true,
            objectsFolded: outcome.value.result.objectsFolded,
            connectionsFolded: outcome.value.result.connectionsFolded,
            reattach: outcome.value.reattach,
          }
        },
      })
      const compactionQueueTimer = setInterval(() => {
        void compactionQueue.tick().then((tick) => {
          if (!tick.ran || tick.claimed === 0) return
          console.log(
            `[compaction-queue] window: claimed ${tick.claimed}, compacted ${tick.compacted}, `
            + `skipped ${tick.skipped}, failed ${tick.failed}`,
          )
          // A window that printed only the line above would read green while a
          // workspace it folded is answering 503. This is the alert condition.
          if (tick.reattachFailed > 0) {
            console.error(
              `[compaction-queue] ${tick.reattachFailed} workspace(s) were folded and left with the `
              + 'READ PLANE DOWN: '
              + tick.units
                .filter((unit) => unit.status === 'compacted' && unit.reattach !== 'reattached')
                .map((unit) => `${unit.landscapeId}/${unit.versionId} (${unit.reattach})`)
                .join(', '),
            )
          }
        }, (error: unknown) => {
          // A tick that throws must not become an unhandled rejection on a
          // timer, which ends the process.
          console.error(`[compaction-queue] window failed: ${String(error)}`)
        })
      }, compactionQueueTickMs)
      maintenanceScheduleStops.push(() => clearInterval(compactionQueueTimer))
      console.log(
        `[compaction-queue] ticking every ${Math.round(compactionQueueTickMs / 1000)}s; `
        + `${COMPACTION_QUEUE_ENV}=${compactionQueueEnabled() ? 'on' : 'off'}, `
        + `${COMPACTION_ALLOWLIST_ENV} names ${parseCompactionAllowlist().size} workspace(s)`,
      )
    } catch (err) {
      console.error('Read-model projector failed to start (sync peer unaffected):', err)
    }
  }

  // LAST statement of main(), deliberately. Express dispatches an error forward
  // from the index of the layer that threw, so an error handler registered
  // beside the other app.use() calls would not be in the path of anything
  // mounted later in this function — which is org-seed, the AI feature and the
  // whole READ_MODEL block above. Registered here it covers every route.
  app.use(terminalErrorHandler())
}

main().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
