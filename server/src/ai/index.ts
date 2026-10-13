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

import type { Express } from 'express'
import type { Repo } from '@automerge/automerge-repo'
import type { Pool } from 'pg'
import { ensureAiSchema } from './core/schema.js'
import { withMigrationLock } from '../db/migrations.js'
import { registerAiHttpRoutes } from './adapters/httpRoutes.js'
import type { SyncCellOwnership } from '../syncCells/ownership.js'
import { registerMcpHttpRoutes } from './adapters/mcp/http.js'
import { registerMcpOAuthRoutes } from './adapters/mcp/oauth.js'
import { registerAdminTechnologyAiRoutes } from './adminTechnologyRoutes.js'

export { aiBearerBridge } from './adapters/bearerAuth.js'
export { ensureAiSchema } from './core/schema.js'

/**
 * One-call wiring for the whole AI Assist feature (schema + every HTTP-side
 * adapter). Called from index.ts main() once the Automerge repo exists —
 * mirrors registerOrgSeedRoutes. The stdio MCP adapter is a separate process
 * (adapters/mcp/stdio.ts) and needs no wiring here.
 */
export async function registerAiFeature(
  app: Express,
  deps: {
    repo: Repo
    rootUrl: string
    pool: Pool
    /** The cell's coordinator, for the agent loops' tool-call relay. Absent
     *  on a process that never constructs one. */
    ownership?: () => SyncCellOwnership | null
    ownershipRequired?: () => boolean
  }
): Promise<void> {
  // DDL at boot: under the migration key, see withMigrationLock.
  await withMigrationLock(deps.pool, () => ensureAiSchema(deps.pool))
  registerAiHttpRoutes(app, {
    repo: deps.repo,
    rootUrl: deps.rootUrl,
    ...(deps.ownership ? { ownership: deps.ownership } : {}),
    ...(deps.ownershipRequired ? { ownershipRequired: deps.ownershipRequired } : {}),
  })
  registerAdminTechnologyAiRoutes(app, { pool: deps.pool })
  registerMcpHttpRoutes(app, { repo: deps.repo, rootUrl: deps.rootUrl })
  registerMcpOAuthRoutes(app)
  console.log('[ai] AI Assist registered: /api/ai/*, /mcp (+ OAuth), org config at /api/orgs/:orgId/ai-config')
}
