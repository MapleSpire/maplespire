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

import type { RequestHandler } from 'express'
import type { Pool } from 'pg'
import type { WorkspaceKey } from '../rbac/docScope.js'
import { checkWorkspaceAccess } from '../rbac/workspaceGate.js'
import type { SyncCellOwnerRoute, SyncCellOwnership } from './ownership.js'
import {
  isRoutedWritePath,
  proxyWorkspaceHttpRequest,
  SYNC_BENCH_UNROUTED_HEADER,
  REBUILT_JSON_BODY_PATHS,
  ROUTED_WRITE_HEADER_DEADLINE_MS,
  SYNC_HTTP_ROUTED_HEADER,
  SYNC_HTTP_ROUTE_HEADER,
} from './httpProxy.js'
import { aiToolNameFor, expressMatchablePath, extractorFor } from './workspaceRouteExtractors.js'
import {
  resolveLandscapeDefaultWorkspace,
  resolveMergeParentWorkspace,
  getSharedWorkspaceRouteResolver,
} from './workspaceRoute.js'
import type { LandscapeDefaultResolver, MergeParentResolver } from './workspaceRoute.js'

/** Exported so `workspaceRouteExtractors.test.ts` can PIN that its own `ID`
 *  has the same shape: a divergence between the two silently converts a
 *  routable write into a local one. */
export const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,160}$/
const DEFAULT_WORKSPACE: WorkspaceKey = { landscapeId: 'default', versionId: 'current' }

export type ParsedWorkspaceHttpRoute =
  | { kind: 'not-workspace' }
  | { kind: 'invalid' }
  | { kind: 'workspace'; workspace: WorkspaceKey }
  /**
   * The request named a DRAFT, and the workspace it writes is that draft's
   * PARENT — a database read. `createWorkspaceHttpRouting` resolves it; a
   * caller that only wants to know whether a path is placeable can treat this
   * as "yes, but not yet".
   */
  | { kind: 'needs-lookup'; landscapeId: string; draftId: string }
  /**
   * The request CREATES a version or a draft of `landscapeId`;
   * the workspace it is placed on is the landscape's DEFAULT version — a
   * database read the middleware performs.
   */
  | { kind: 'needs-landscape-default'; landscapeId: string }

/** A parse that names something to place — the three members `decideWorkspaceRoute` accepts. */
export type PlaceableWorkspaceHttpRoute = Exclude<ParsedWorkspaceHttpRoute, { kind: 'not-workspace' | 'invalid' }>

function isWorkspaceHttpPath(rawPathname: string, method: string): boolean {
  const pathname = expressMatchablePath(rawPathname)
  if (method === 'GET' || method === 'HEAD') {
    return pathname.startsWith('/api/model/')
      || pathname === '/api/automerge/root'
      || pathname === '/api/automerge/doc-heads'
      || pathname === '/api/automerge/registry-diagram'
      // projector-fleet stays process-local: its handler reads this cell's
      // counters without ensureWorkspace. Routing it attributes an owner's
      // fleet to a reserve.
  }
  // Compaction is workspace-local; GC is accepted only by the sole ready
  // partition owner (and is explicitly rejected in multi-partition mode until a
  // fenced global worker exists). Those two are bodyless; the rest carry a
  // bounded JSON body — see `REBUILT_JSON_BODY_PATHS`.
  return method === 'POST'
    && (
      pathname === '/api/model/compact'
      || pathname === '/api/automerge/gc'
      || REBUILT_JSON_BODY_PATHS.has(pathname)
    )
}

/**
 * Identify the deliberately small HTTP surface that must execute beside the
 * workspace's Automerge Repo/projector. Query values are untrusted routing
 * hints until resolveWorkspaceRoute() canonicalizes them from PostgreSQL.
 *
 * TWO WAYS IN, and `body` is why the second exists. The query-string surface
 * names its workspace in the QUERY STRING. The five write families do not: four carry it in the JSON body and the merge carries a
 * draft in its path. `workspaceRouteExtractors.ts` places those, and this
 * function is where the two meet.
 *
 * `body` IS OPTIONAL AND ITS ABSENCE IS NOT A REFUSAL — it is `absent`, which
 * this turns into `not-workspace`, i.e. a pass-through to the handler, which
 * answers its own 400. That is deliberate for every one of the four: each
 * refuses a request without both ids (checked one route at a time), and
 * `beginSummaryMigration` writes nothing before it does. A caller that wants
 * to know only whether a PATH is claimable — `mutatingRouteCoverage.test.ts`
 * — passes no body and gets exactly that answer.
 */
export function parseWorkspaceHttpRoute(
  requestUrl: string | undefined,
  method = 'GET',
  body?: unknown,
): ParsedWorkspaceHttpRoute {
  if (!requestUrl) return { kind: 'not-workspace' }
  let url: URL
  try {
    url = new URL(requestUrl, 'http://sync.invalid')
  } catch {
    return { kind: 'not-workspace' }
  }
  const upperMethod = method.toUpperCase()
  if (!isWorkspaceHttpPath(url.pathname, upperMethod)) {
    // The five write families. `extractorFor` owns the normalisation, because
    // the merge's ids live in its path and must NOT be lowercased while the
    // four literal paths must be — see its docblock.
    const extractor = extractorFor(url.pathname, upperMethod)
    if (!extractor) return { kind: 'not-workspace' }
    const extracted = extractor.extract(url.pathname, body)
    if (extracted.kind === 'absent') return { kind: 'not-workspace' }
    if (extracted.kind === 'needs-lookup' || extracted.kind === 'needs-landscape-default') return extracted
    return { kind: 'workspace', workspace: extracted.workspace }
  }

  const landscapes = url.searchParams.getAll('landscapeId')
  const versions = url.searchParams.getAll('versionId')
  if (landscapes.length > 1 || versions.length > 1) return { kind: 'invalid' }
  const landscapeId = landscapes[0] || DEFAULT_WORKSPACE.landscapeId
  const versionId = versions[0] || DEFAULT_WORKSPACE.versionId
  if (!WORKSPACE_ID.test(landscapeId) || !WORKSPACE_ID.test(versionId)) return { kind: 'invalid' }
  return { kind: 'workspace', workspace: { landscapeId, versionId } }
}

/** Where the request is placed relative to this cell, for the log line and the
 *  bench: the partition the workspace hashes to, and the one this cell holds. */
export interface WorkspaceRoutePlacement {
  assignedPartition: number
  localPartition: number | null
  localCellId: string
}

/**
 * THE DECISION, SEPARATED FROM THE TWO THINGS THAT ACT ON IT.
 *
 * The chain — ownership gates, the two database lookups, canonicalisation,
 * authorisation, `owns`, `resolveOwner`, the loop check — is needed both by
 * the Express middleware and by the agent loop, which decides a tool call in
 * the middle of answering a request, on whichever cell the conversation
 * landed, and must reach the owner WITHOUT the conversation moving.
 * Duplicating the chain would create a second derivation of the same
 * placement that could drift. So the chain is ONE function, and both the
 * middleware and `aiToolCallRelay.ts` act on its answer.
 *
 * FOUR ANSWERS, and each maps to exactly one thing the middleware does:
 *   `pass-through` — `next()` with no route header (ownership absent and not
 *                    required, ownership disabled, a draft with no row, a
 *                    landscape with no default). The handler answers.
 *   `owner`        — `next()` under `x-maplespire-sync-route: owner`.
 *   `refuse`       — `status` and `body`, verbatim what the middleware wrote.
 *   `proxy`        — the owner to forward to, and the placement for the log.
 *
 * The ORDER is load-bearing: the two
 * ownership gates come BEFORE the database lookups so a cell with ownership
 * disabled or still warming up costs nothing; the lookups come BEFORE
 * `resolveWorkspace`, because until they resolve there is no key to
 * canonicalise; `authorize` is asked of the PLACED workspace, which for a
 * merge is the parent the caller never named.
 *
 * `authorize` is a closure over the caller rather than a `(db, request,
 * workspace)` triple because the two callers hold the caller differently — the
 * middleware has an Express request, the relay has an `AiIdentity` it wraps
 * into the claims carrier the RBAC gates read. What is checked is the same
 * (`checkWorkspaceAccess`), and the relay's wrapper is built inside
 * `resolveAiToolCtx`, the one place that carrier already exists.
 */
export interface WorkspaceRouteDecisionDeps {
  db: Pool
  ownership: () => SyncCellOwnership | null
  ownershipRequired?: () => boolean
  resolveWorkspace: (db: Pool, requested: WorkspaceKey) => Promise<WorkspaceKey | null>
  /** Read access on the PLACED workspace, as `checkWorkspaceAccess` decides it. */
  authorize: (workspace: WorkspaceKey) => Promise<boolean>
  resolveMergeParent: MergeParentResolver
  resolveLandscapeDefault: LandscapeDefaultResolver
  /** Has this request ALREADY crossed one cell (`SYNC_HTTP_ROUTED_HEADER` present)?
   *  A routed request may never be routed again — ownership churn is answered
   *  with a retryable 503 so the load balancer picks the new owner afresh. */
  alreadyRouted: boolean
}

export type WorkspaceRouteDecision =
  | { kind: 'pass-through'; reason: 'ownership-absent' | 'ownership-disabled' | 'no-such-draft' | 'unresolved-landscape' }
  | { kind: 'owner'; workspace: WorkspaceKey }
  | {
      kind: 'refuse'
      status: number
      body: Record<string, unknown>
      reason: 'warming-up' | 'unplaceable' | 'workspace-not-found' | 'forbidden' | 'route-loop' | 'owner-route-unavailable'
      /** Present for the two ownership refusals, which the middleware logs with it. */
      placement?: WorkspaceRoutePlacement
    }
  | {
      kind: 'proxy'
      workspace: WorkspaceKey
      owner: SyncCellOwnerRoute & { advertiseUrl: string }
      placement: WorkspaceRoutePlacement
    }

export async function decideWorkspaceRoute(
  parsed: PlaceableWorkspaceHttpRoute,
  deps: WorkspaceRouteDecisionDeps,
): Promise<WorkspaceRouteDecision> {
  const ownership = deps.ownership()
  if (!ownership) {
    if (deps.ownershipRequired?.()) {
      return {
        kind: 'refuse',
        status: 503,
        body: { error: 'sync-cell ownership warming up', retryable: true },
        reason: 'warming-up',
      }
    }
    return { kind: 'pass-through', reason: 'ownership-absent' }
  }
  if (!ownership.enabled) return { kind: 'pass-through', reason: 'ownership-disabled' }

  // THE DRAFT MERGE, AND THE ONE PLACE THIS DECISION READS THE DATABASE TO
  // FIND OUT WHAT IT IS PLACING. The request names a draft; the write lands
  // on that draft's PARENT. Deliberately AFTER the two ownership gates above,
  // so a cell with ownership disabled or still warming up costs nothing —
  // and BEFORE `resolveWorkspace`, because until this resolves there is no
  // key to canonicalise.
  let requested: WorkspaceKey
  if (parsed.kind === 'needs-lookup') {
    const placement = await deps.resolveMergeParent(deps.db, parsed.landscapeId, parsed.draftId)
    if (placement.kind === 'no-such-draft') {
      // Express answers its own 404, having written nothing — see
      // `MergeParentPlacement`, where the difference between this and the
      // branch below is spelled out.
      return { kind: 'pass-through', reason: 'no-such-draft' }
    }
    if (placement.kind === 'unplaceable') {
      return {
        kind: 'refuse',
        status: 404,
        body: { error: 'draft not found or not mergeable', reason: placement.reason },
        reason: 'unplaceable',
      }
    }
    requested = placement.workspace
  } else if (parsed.kind === 'needs-landscape-default') {
    // THE TWO CREATION DOORS and the two AI creation tools, placed on the landscape's default version — the lease the
    // bootstrap fence keys them on. An unresolved landscape is handed back
    // to the handler, which is safe: every one of them answers 404 before
    // creating anything, see `LandscapeDefaultPlacement`.
    const placement = await deps.resolveLandscapeDefault(deps.db, parsed.landscapeId)
    if (placement.kind === 'unresolved') return { kind: 'pass-through', reason: 'unresolved-landscape' }
    requested = placement.workspace
  } else {
    requested = parsed.workspace
  }

  const workspace = await deps.resolveWorkspace(deps.db, requested)
  if (!workspace) {
    return { kind: 'refuse', status: 404, body: { error: 'workspace not found' }, reason: 'workspace-not-found' }
  }
  if (!(await deps.authorize(workspace))) {
    return { kind: 'refuse', status: 403, body: { error: 'forbidden' }, reason: 'forbidden' }
  }

  if (ownership.owns(workspace)) return { kind: 'owner', workspace }

  const local = ownership.readSnapshot()
  const owner = await ownership.resolveOwner(workspace)
  const placement: WorkspaceRoutePlacement = {
    assignedPartition: ownership.partitionFor(workspace),
    localPartition: local.partitionIndex,
    localCellId: local.cellId,
  }
  const routeAvailable = Boolean(
    owner?.advertiseUrl
    && owner.cellId !== local.cellId
    && !deps.alreadyRouted,
  )
  if (!routeAvailable || !owner?.advertiseUrl) {
    return {
      kind: 'refuse',
      status: 503,
      body: { error: 'workspace owner unavailable', retryable: true },
      reason: deps.alreadyRouted ? 'route-loop' : 'owner-route-unavailable',
      placement,
    }
  }
  return { kind: 'proxy', workspace, owner: { ...owner, advertiseUrl: owner.advertiseUrl }, placement }
}

export interface WorkspaceHttpRoutingOptions {
  db: Pool
  ownership: () => SyncCellOwnership | null
  ownershipRequired?: () => boolean
  resolveWorkspace?: (db: Pool, requested: WorkspaceKey) => Promise<WorkspaceKey | null>
  authorize?: (db: Pool, request: Parameters<RequestHandler>[0], workspace: WorkspaceKey) => Promise<boolean>
  /** Overridable ONLY so a middleware arm can drive the `needs-lookup` branch
   *  without a database. The statement itself is covered by
   *  `mergeParentRoute.integration.test.ts`, so the seam does not hide the
   *  real SQL. */
  resolveMergeParent?: MergeParentResolver
  /** Same contract as `resolveMergeParent`, for the two creation doors. The statement is covered by `landscapeDefaultRoute.integration.test.ts`. */
  resolveLandscapeDefault?: LandscapeDefaultResolver
}

/** Express admission/router for workspace-affine HTTP traffic. Both the landing
 * cell and the owner authenticate/authorize the original cookie or Bearer token.
 * A routed request may never be routed again: ownership churn returns a
 * retryable 503 so the public load balancer can choose the new owner afresh. */
export function createWorkspaceHttpRouting(options: WorkspaceHttpRoutingOptions): RequestHandler {
  const resolveWorkspace = options.resolveWorkspace ?? getSharedWorkspaceRouteResolver(options.db)
  const authorize = options.authorize ?? checkWorkspaceAccess
  const resolveMergeParent = options.resolveMergeParent ?? resolveMergeParentWorkspace
  const resolveLandscapeDefault = options.resolveLandscapeDefault ?? resolveLandscapeDefaultWorkspace
  return (request, response, next) => {
    const requestUrl = request.originalUrl || request.url
    // BENCH-ONLY ROUTING BYPASS; it governs nothing in production.
    //
    // `b25a-redis-outage-bench.mjs` measures the bootstrap fence barrier
    // THROUGH the AI tool door. A routed door is refused by the ROUTER before
    // any document exists, and a refusal by the router says nothing about the
    // fence, so the bench needs to skip routing.
    //
    // Three constraints keep it out of the product: it is honoured ONLY under
    // the bench manifest's env var, ONLY on the AI tool door, and when the env
    // var is absent the header is REFUSED 400 rather than ignored — a bench
    // that silently measured routing instead would be misleading.
    // `routerDeployment.test.ts` checks the var is in no shipped manifest.
    if (request.headers[SYNC_BENCH_UNROUTED_HEADER] !== undefined) {
      const onTheToolDoor = aiToolNameFor(new URL(requestUrl ?? '/', 'http://sync.invalid').pathname) !== null
      if (process.env.SYNC_CELL_BENCH_UNROUTED !== 'on' || !onTheToolDoor) {
        response.status(400).json({ error: 'bench routing bypass is not armed on this cell' })
        return
      }
      next()
      return
    }
    const parsed = parseWorkspaceHttpRoute(requestUrl, request.method, (request as { body?: unknown }).body)
    // Parsed a second time rather than threaded out of `parseWorkspaceHttpRoute`,
    // because it is only read on the proxy branch and the alternative is a
    // field on a union whose three other members have no use for it. It cannot
    // throw here: `parsed` is not `not-workspace`, which is the answer a URL
    // this constructor rejects would have produced.
    const pathname = (): string => new URL(requestUrl ?? '/', 'http://sync.invalid').pathname
    if (parsed.kind === 'not-workspace') {
      next()
      return
    }
    if (parsed.kind === 'invalid') {
      response.status(400).json({ error: 'invalid workspace route' })
      return
    }

    void (async () => {
      try {
        const decision = await decideWorkspaceRoute(parsed, {
          db: options.db,
          ownership: options.ownership,
          ownershipRequired: options.ownershipRequired,
          resolveWorkspace,
          authorize: (workspace) => authorize(options.db, request, workspace),
          resolveMergeParent,
          resolveLandscapeDefault,
          alreadyRouted: request.headers[SYNC_HTTP_ROUTED_HEADER] !== undefined,
        })

        if (decision.kind === 'pass-through') {
          next()
          return
        }
        if (decision.kind === 'owner') {
          response.setHeader(SYNC_HTTP_ROUTE_HEADER, 'owner')
          next()
          return
        }
        if (decision.kind === 'refuse') {
          if (decision.placement) {
            console.warn(JSON.stringify({
              event: 'sync.cell.http_route_rejected',
              reason: decision.reason,
              assignedPartition: decision.placement.assignedPartition,
              localPartition: decision.placement.localPartition,
            }))
          }
          response.status(decision.status).json(decision.body)
          return
        }

        console.warn(JSON.stringify({
          event: 'sync.cell.http_route_proxy',
          reason: 'forward-to-owner',
          assignedPartition: decision.placement.assignedPartition,
          localPartition: decision.placement.localPartition,
        }))
        // The write families get the long header deadline. They compute their
        // whole result before writing a header, and the historical five seconds
        // is BELOW the owner's own 10 s pool-acquisition ceiling — so the
        // landing cell would answer 503 for an operation the owner is still
        // running. See `ROUTED_WRITE_HEADER_DEADLINE_MS`.
        const writeFamily = isRoutedWritePath(pathname())
        const proxied = await proxyWorkspaceHttpRequest({
          request,
          response,
          advertiseUrl: decision.owner.advertiseUrl,
          sourceCellId: decision.placement.localCellId,
          ...(writeFamily ? { timeoutMs: ROUTED_WRITE_HEADER_DEADLINE_MS } : {}),
        })
        console.log(JSON.stringify({
          event: 'sync.cell.http_route_proxy_result',
          outcome: proxied ? 'connected' : 'failed',
          assignedPartition: decision.owner.partition,
        }))
      } catch (error) {
        console.error('[sync-cell] HTTP workspace route resolution failed:', error)
        if (!response.headersSent) {
          response.status(503).json({ error: 'workspace routing unavailable', retryable: true })
        } else {
          response.destroy(error instanceof Error ? error : undefined)
        }
      }
    })()
  }
}
