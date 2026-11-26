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

import type { Express, Request, RequestHandler, Response } from 'express'
import type { Pool } from 'pg'
import { canonicalWorkspaceKey, canWriteVersion, checkWorkspaceAccess, requireVersionWrite } from '../rbac/workspaceGate.js'
import { listOverridesForActors, overrideActorsOfUser, parseResolveRequest, resolveOverrides } from './modelEpochOverrides.js'
import type { WorkspaceKey } from './projector.js'

/**
 * G4-16f (the server half): the OVERRIDE-ROW
 * routes — a tab's own offline edits the current epoch overrode, read by
 * actor and resolved BY BATCH ID. SQL only, so any cell answers: the read
 * gate, no ownership check. Moved out of `index.ts` so they
 * can be driven over HTTP by a test: `index.ts` boots a server on import.
 *
 * ORDER on the resolve route: the WRITE check comes before the body is even
 * parsed, so a reader is told 403 whatever it sent — never a 400 that says
 * "your request was malformed, try again".
 */
export interface ModelEpochOverrideRouteDeps {
  pool: Pool
  /** The request's workspace, before canonicalisation (`workspaceFromReq`). */
  workspaceOf: (req: Request) => WorkspaceKey
  /** The error-to-500 wrapper (`routeErrors.ts`). */
  route: (handler: (req: Request, res: Response) => Promise<void>) => RequestHandler
}

async function overrideWorkspace(deps: ModelEpochOverrideRouteDeps, req: Request, res: Response): Promise<WorkspaceKey | null> {
  const canonical = await canonicalWorkspaceKey(deps.pool, deps.workspaceOf(req))
  if (!canonical) { res.status(404).json({ error: 'workspace not found' }); return null }
  if (!(await checkWorkspaceAccess(deps.pool, req, canonical))) { res.status(403).json({ error: 'forbidden' }); return null }
  return canonical
}

export function registerModelEpochOverrideRoutes(app: Express, deps: ModelEpochOverrideRouteDeps): void {
  app.get('/api/model/epoch-overrides', deps.route(async (req, res) => {
    const key = await overrideWorkspace(deps, req, res)
    if (!key) return
    const actors = (typeof req.query.actors === 'string' ? req.query.actors : '')
      .split(',').map((a) => a.trim()).filter((a) => /^[0-9a-f]{2,128}$/.test(a)).slice(0, 256)
    // Signed in, the rows of every actor the
    // user's tabs asked with — not only this tab's. The user is the
    // SESSION's, never a parameter. Recorded only
    // for a writer — a reader has no rows of its own, and this GET is open
    // to readers.
    const userId = req.auth?.userId
    const byActors = userId
      ? await overrideActorsOfUser(deps.pool, key, userId, actors, await canWriteVersion(deps.pool, req, key.landscapeId, key.versionId))
      : actors
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ overrides: await listOverridesForActors(deps.pool, key, byActors) })
  }))
  app.post('/api/model/epoch-overrides/resolve', deps.route(async (req, res) => {
    const key = await overrideWorkspace(deps, req, res)
    if (!key) return
    if (!(await requireVersionWrite(deps.pool, req, res, key.landscapeId, key.versionId))) return
    const request = parseResolveRequest(req.body)
    if (!request) { res.status(400).json({ error: 'invalid resolve request' }); return }
    const client = await deps.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await resolveOverrides(client, key, request, req.auth?.userId ?? null)
      await client.query('COMMIT')
      res.json(result)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }))
}
