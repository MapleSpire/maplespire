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

import type { SealedRepo } from '../../rbac/sealedRepo.js'
import type { WorkspaceKey } from '../../rbac/docScope.js'
import type { Repo } from '@automerge/automerge-repo'
import type { Pool } from 'pg'
import type { Request } from 'express'
import { pool } from '../../db.js'
import {
  canonicalWorkspaceKey,
  checkWorkspaceAccess,
  workspaceAccessForRequest,
} from '../../rbac/workspaceGate.js'
import { resolveRootUrl } from '../../landscapes.js'
// The leaf module, shared with the router's admission gate:
// `workspaceRouteExtractors.ts` derives the same default from the same
// constant without loading `landscapes.ts` and the pool behind it.
import { DEFAULT_LANDSCAPE_ID } from '../../landscapeDefaults.js'
import type { AiToolRelayCapability } from '../../syncCells/aiToolCallRelay.js'
import { ModelSession } from './modelOps.js'
import { identityToClaims, type AiIdentity } from './identity.js'

/**
 * Per-call execution context for AI tools — the shared-core object every
 * adapter builds via `resolveAiToolCtx` and hands to `executeAiTool`. Carries
 * the resolved CANONICAL workspace, its root URL, the caller identity and
 * write permission. Express-free: adapters normalize whoever is calling into
 * an `AiIdentity` (identity.ts) first.
 */
export interface AiToolCtx {
  /**
   * SEALED: the tools get a repo that cannot MINT a document. `SealedRepo` is
   * an allow-list, so `create`, `create2`, `clone` and `import` are all absent
   * — and so is any minting method upstream adds later, which a subtractive
   * type would have let through.
   *
   * This is a type rather than a convention because an optional workspace
   * argument with a minting fallback lets one forgotten argument silently
   * produce a document no workspace owns — invisible to the catalog walk, to
   * the route gate, and to the read-model projector.
   *
   * WHAT IT DOES NOT SAY. Not "every document an AI tool creates goes through
   * `createClaimedDocument`". Two sanctioned openings widen back to `Repo`
   * (`createClaimedDocument` and `createSegment`, both inside modules that own
   * claiming), and `bootstrapRepo` in `workflowTools.ts` hands the real repo to
   * the draft/version family, which claims at publication instead — three
   * widenings, listed in `sealedRepo.ts`. And even the wrapper's claim is a
   * no-op when no document index is registered.
   *
   * The seal makes the ACCIDENT impossible. The deliberate paths are named,
   * and named where they are.
   */
  repo: SealedRepo
  db: Pool
  identity: AiIdentity | null
  /** Canonical workspace key (real version id, never 'current'). */
  workspace: { landscapeId: string; versionId: string }
  rootUrl: string
  canWrite: boolean
  orgId: string | null
  userId: string | null
  /** Display author for comments/ADRs created by the assistant. */
  userLabel: string
  session: ModelSession
  /** Effective-write check on ANOTHER workspace (same staged semantics as
   * this ctx's own `canWrite`) — workflow tools use it to gate e.g. a draft
   * merge on the PARENT version's scope. */
  assertWriteOn: (key: { landscapeId: string; versionId: string }) => Promise<void>
  /**
   * THE TOOL-CALL RELAY, installed by the adapters whose tool is
   * chosen DURING a loop — `/api/ai/chat` and `/api/ai/run` — and by nobody
   * else. With it, `executeAiTool` asks the router's own placement before
   * running a bootstrap tool and carries the call to the owning cell when the
   * key belongs to a neighbour; without it, every tool executes where it
   * landed, which is what the direct door wants (the middleware has already
   * routed it) and what `/mcp` still does.
   */
  relay?: AiToolRelayCapability
}

/**
 * What an ADAPTER supplies to install the relay: the cell's coordinator and
 * the caller's credential headers. `authorize` is NOT here — it needs the
 * claims carrier this module builds, so `resolveAiToolCtx` adds it.
 */
export type AiToolRelayInstall = Omit<AiToolRelayCapability, 'authorize'>

export class AiToolError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message)
    this.name = 'AiToolError'
  }
}

/** The RBAC gates read `req.auth` and nothing else off the request — a
 * minimal claims carrier keeps their staged semantics byte-identical without
 * threading express through the core. */
function pseudoReq(identity: AiIdentity | null): Request {
  return (identity ? { auth: identityToClaims(identity) } : {}) as Request
}

export interface ResolveCtxOpts {
  /**
   * The REAL repo, and this is the one place it enters.
   *
   * Sealing here would be the wrong end: an adapter genuinely holds the whole
   * repo — it is the process's — and the point of the seal is the narrowing
   * that happens at the boundary below, when this is placed on `AiToolCtx` as
   * a `SealedRepo`. That assignment is legal in exactly one direction, which
   * is what makes the boundary a boundary rather than a convention.
   */
  repo: Repo
  /** Legacy fallback root (startAutomergeSync's rootUrl). */
  fallbackRootUrl: string
  identity: AiIdentity | null
  landscapeId?: string
  versionId?: string
  userLabel?: string
  /** See `AiToolCtx.relay`. Omitted by the direct door and by `/mcp`. */
  relay?: AiToolRelayInstall
}

/**
 * Resolve + authorize a workspace for one AI request/tool call. Applies the
 * same gates as /api/model/* (canonical key → read access → root url) and
 * computes effective write permission, which `executeAiTool` enforces on
 * write tools.
 *
 * Below auth stage 'on', `workspaceAccessForRequest` reports enforced=false
 * and the sync gate accepts client writes — the AI mirrors that
 * (canWrite=true) so it is exactly as permissive as the editor, never more.
 */
export async function resolveAiToolCtx(opts: ResolveCtxOpts): Promise<AiToolCtx> {
  const landscapeId = opts.landscapeId?.trim() || DEFAULT_LANDSCAPE_ID
  const versionId = opts.versionId?.trim() || 'current'
  const req = pseudoReq(opts.identity)

  const canonical = await canonicalWorkspaceKey(pool, { landscapeId, versionId })
  if (!canonical) throw new AiToolError(`unknown workspace ${landscapeId}/${versionId}`, 404)
  if (!(await checkWorkspaceAccess(pool, req, canonical))) {
    throw new AiToolError('you do not have access to this workspace', 403)
  }
  const rootUrl = await resolveRootUrl(canonical.landscapeId, canonical.versionId, opts.fallbackRootUrl)
  if (!rootUrl) throw new AiToolError(`workspace ${landscapeId}/${versionId} has no document root`, 404)

  const access = await workspaceAccessForRequest(pool, req, canonical)
  const canWrite = access.enforced ? access.canWrite : true

  const assertWriteOn = async (key: { landscapeId: string; versionId: string }): Promise<void> => {
    const target = (await canonicalWorkspaceKey(pool, key)) ?? key
    const a = await workspaceAccessForRequest(pool, req, target)
    if (a.enforced && !a.canWrite) {
      throw new AiToolError(
        `you do not have write access to workspace ${target.landscapeId}/${target.versionId}`,
        403
      )
    }
  }

  return {
    repo: opts.repo,
    db: pool,
    identity: opts.identity,
    workspace: canonical,
    rootUrl,
    canWrite,
    orgId: opts.identity?.orgId ?? null,
    userId: opts.identity?.userId ?? null,
    userLabel: opts.userLabel ?? opts.identity?.label ?? 'AI Assist',
    session: new ModelSession(opts.repo, rootUrl),
    assertWriteOn,
    // The relay authorises the PLACED workspace the way the middleware does —
    // `checkWorkspaceAccess` on the same claims carrier the gates above read.
    ...(opts.relay
      ? { relay: { ...opts.relay, authorize: (key: WorkspaceKey) => checkWorkspaceAccess(pool, req, key) } }
      : {}),
  }
}
