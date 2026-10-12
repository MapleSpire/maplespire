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

import { randomBytes } from 'node:crypto'
import type { StorageAdapterInterface } from '@automerge/automerge-repo'
import type { Pool } from 'pg'
import { appendAudit } from '../auth/audit.js'
import { notifyWorkspaceCreated } from '../rbac/docScope.js'
import { claimWorkspaceDocuments } from '../rbac/documentClaims.js'
import { coverWorkspace, noteCoveredLocally } from '../rbac/claimCoverage.js'
import { upsertLandscapeScope, upsertVersionScope } from '../rbac/schema.js'
import { preparePerformanceCatalog } from './catalog.js'
import { PerformanceSeedPlan } from './generator.js'
import { seedPerformancePrincipals } from './principals.js'
import { createPerformanceWorkspaceRoot, type PerformanceSeedProgress } from './workspace.js'
import {
  materializePerformanceReadModel,
  performanceWorkspaceTransportDocuments,
  type PerformanceReadModelProgress,
} from './readModel.js'
import type { PerformanceSeedScale, PerformanceSeedSummary } from './types.js'

function newId(): string {
  return randomBytes(12).toString('base64url')
}

export interface SeedPerformanceEnvironmentOptions {
  db: Pool
  storage: StorageAdapterInterface
  orgId: string
  actorUserId: string
  scale: PerformanceSeedScale
  landscapeName?: string
  seed?: number
  onProgress?: (progress: PerformanceSeedProgress | PerformanceReadModelProgress | {
    phase: 'catalog' | 'principals' | 'publish'
    completed: number
    total: number
    message: string
  }) => void
}

export interface PerformanceSeedResult extends PerformanceSeedSummary {
  landscapeId: string
  landscapeName: string
  versionId: string
  rootUrl: string
  documents: number
  memberships: number
}

export async function seedPerformanceEnvironment(
  options: SeedPerformanceEnvironmentOptions,
): Promise<PerformanceSeedResult> {
  const { db, storage, orgId, actorUserId, scale } = options
  const { rows: orgs } = await db.query<{ id: string }>('SELECT id FROM orgs WHERE id = $1 AND status = $2', [orgId, 'active'])
  if (!orgs[0]) throw new Error(`Active organization not found: ${orgId}`)
  const { rows: actors } = await db.query<{ user_id: string }>(
    `SELECT user_id FROM org_members WHERE org_id = $1 AND user_id = $2 AND role = 'admin'`,
    [orgId, actorUserId],
  )
  if (!actors[0]) throw new Error(`Actor ${actorUserId} is not an administrator of organization ${orgId}`)

  options.onProgress?.({ phase: 'catalog', completed: 0, total: 1, message: 'preparing governed Tags and Technologies' })
  const tags = await preparePerformanceCatalog(db, orgId, actorUserId)
  options.onProgress?.({ phase: 'catalog', completed: 1, total: 1, message: `${tags.length} governed Tags are ready` })

  const principals = await seedPerformancePrincipals(db, orgId, scale, (completed, total) => {
    options.onProgress?.({
      phase: 'principals', completed, total,
      message: `users: ${completed.toLocaleString('en-CA')} / ${total.toLocaleString('en-CA')}`,
    })
  })
  const plan = new PerformanceSeedPlan({ scale, tags, teamIds: principals.teamIds, seed: options.seed })
  const workspace = await createPerformanceWorkspaceRoot(storage, plan, { onProgress: options.onProgress })

  const landscapeId = newId()
  const versionId = newId()
  const suffix = randomBytes(2).toString('hex')
  const landscapeName = options.landscapeName?.trim() || `Enterprise performance seed ${scale.name} ${suffix}`
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO landscapes (id, name, default_version_id, org_id) VALUES ($1, $2, $3, $4)`,
      [landscapeId, landscapeName, versionId, orgId],
    )
    await client.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Performance baseline', $3)`,
      [versionId, landscapeId, workspace.rootUrl],
    )
    // Shared batch claim core (1,000 ids per statement). Losers are verified:
    // a foreign owner under a freshly seeded workspace is corruption and
    // aborts the transaction. The coverage marker is written LAST, in the same
    // transaction as the versions row and the claims, so all three commit or
    // vanish together.
    const claims = await claimWorkspaceDocuments(
      client,
      { landscapeId, versionId },
      workspace.documentUrls.map((url) => url.slice('automerge:'.length)),
    )
    if (claims.missingVersion || claims.foreign.length > 0) {
      const detail = claims.missingVersion
        ? 'the versions row is missing from this very transaction'
        : `${claims.foreign.length} document(s) already owned elsewhere (first: ${claims.foreign[0]!.documentId})`
      throw new Error(`performance seed claim batch failed: ${detail}`)
    }
    // The local write-through is DEFERRED past COMMIT: inside the tx the
    // marker is not durable, and a rollback would leave this process serving
    // "covered" from cache for a marker that never existed.
    const covered = await coverWorkspace(client, { landscapeId, versionId }, '0', { deferLocalWriteThrough: true })
    await client.query('COMMIT')
    if (covered) noteCoveredLocally({ landscapeId, versionId })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }

  await materializePerformanceReadModel({
    db,
    key: { landscapeId, versionId },
    orgId,
    plan,
    diagramDocumentUrls: workspace.diagramDocumentUrls,
    staticDocumentUrls: performanceWorkspaceTransportDocuments(workspace),
    onProgress: options.onProgress,
  })

  const landscapeScopeId = await upsertLandscapeScope(db, orgId, landscapeId)
  await upsertVersionScope(db, orgId, landscapeId, versionId)
  const grants = principals.teamIds.map((teamId, index) => ({
    teamId,
    canRead: true,
    canWrite: index % 4 !== 3,
  }))
  await db.query(
    `INSERT INTO team_scope_permissions (
       team_id, scope_id, resource_type, can_read, can_write, updated_by
     )
     SELECT item."teamId", $2, '*', item."canRead", item."canWrite", $3
     FROM jsonb_to_recordset($1::jsonb) AS item("teamId" text, "canRead" boolean, "canWrite" boolean)
     ON CONFLICT (team_id, scope_id, resource_type) DO UPDATE
     SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(grants), landscapeScopeId, actorUserId],
  )

  try {
    notifyWorkspaceCreated({ landscapeId, versionId, rootUrl: workspace.rootUrl })
  } catch (error) {
    console.warn('[performanceSeed] workspace notification deferred until server boot:', error)
  }
  const summary = plan.summary()
  const result: PerformanceSeedResult = {
    ...summary,
    landscapeId,
    landscapeName,
    versionId,
    rootUrl: workspace.rootUrl,
    documents: workspace.documentCount,
    memberships: principals.memberships,
  }
  await appendAudit(db, {
    orgId,
    actorUserId,
    action: 'org.performance_seeded',
    targetKind: 'landscape',
    targetId: landscapeId,
    detail: result,
  })
  options.onProgress?.({ phase: 'publish', completed: 1, total: 1, message: `published ${landscapeName}` })
  return result
}
