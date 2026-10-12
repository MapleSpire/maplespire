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

import type { Express, Request, Response } from 'express'
import type { Repo } from '@automerge/automerge-repo'
import type { Pool } from 'pg'
import { pool } from '../db.js'
import { appendAudit } from '../auth/audit.js'
import { seedOrgEnvironment, beginSeed, endSeed } from './seed.js'

/**
 * POST /api/orgs/:orgId/seed — seed a complete demo/test environment into the
 * org. Doubly gated:
 *   1. `ORG_SEED=on` env flag (default OFF — the route 404s in production so
 *      it is indistinguishable from not existing);
 *   2. org admin (or platform admin), re-checked in the DB per request.
 * One seed per org at a time (409 seed_in_progress). Audited `org.seeded`
 * with the created counts.
 *
 * Registered from main() once the Automerge repo exists (the seed creates
 * workspace docs).
 */

async function canManageOrg(db: Pool, orgId: string, auth: { userId: string; isPlatformAdmin: boolean }): Promise<boolean> {
  if (auth.isPlatformAdmin) return true
  const { rows } = await db.query<{ role: string }>(
    'SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2',
    [orgId, auth.userId]
  )
  return rows[0]?.role === 'admin'
}

export function registerOrgSeedRoutes(app: Express, repo: Repo): void {
  app.post('/api/orgs/:orgId/seed', async (req: Request, res: Response) => {
    if (process.env.ORG_SEED !== 'on') {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const auth = req.auth
    if (!auth) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    const orgId = String(req.params.orgId ?? '')
    try {
      if (!(await canManageOrg(pool, orgId, auth))) {
        res.status(403).json({ error: 'Org admin access required' })
        return
      }
      const { rows } = await pool.query('SELECT 1 FROM orgs WHERE id = $1', [orgId])
      if (rows.length === 0) {
        res.status(404).json({ error: 'Org not found' })
        return
      }

      if (!beginSeed(orgId)) {
        res.status(409).json({ error: 'seed_in_progress' })
        return
      }
      try {
        const result = await seedOrgEnvironment(repo, orgId, auth.userId)

        await appendAudit(pool, {
          orgId,
          actorUserId: auth.userId,
          impersonatorUserId: auth.imp?.by,
          action: 'org.seeded',
          targetKind: 'landscape',
          targetId: result.landscapeId,
          detail: { ...result },
        })

        res.status(201).json({ result })
      } finally {
        endSeed(orgId)
      }
    } catch (err) {
      console.error('[orgSeed] seed failed:', err)
      res.status(500).json({ error: 'Failed to seed demo environment' })
    }
  })
}
