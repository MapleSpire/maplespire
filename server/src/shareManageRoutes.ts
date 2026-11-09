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

import type { Pool } from 'pg'
import type { RequestHandler } from 'express'
import type { WorkspaceKey } from './readModel/projector.js'
import { getShareGateInfo, parseShareUpdate, updateShare } from './shares.js'
import { requireVersionWrite } from './rbac/workspaceGate.js'
import { sendDependencyOutage } from './routeErrors.js'

/**
 * The share-link MANAGE handlers, lifted out of index.ts so a test can drive
 * the real handler over HTTP (index.ts boots a server on import and cannot be
 * imported by a test). The route registration itself stays in index.ts —
 * `syncCells/mutatingRouteCoverage.test.ts` scans the source for each route's
 * registration call, and this file must not register (or quote) one.
 */
export interface ShareManageDeps {
  pool: Pool
  /** index.ts's `shareWorkspaceKey`: the share row's stored workspace with
   * 'current' canonicalised to the landscape's real default version. */
  workspaceKey: (landscapeId: string | null, versionId: string | null) => Promise<WorkspaceKey>
}

export function sharePatchHandler(deps: ShareManageDeps): RequestHandler {
  return async (req, res) => {
    const token = String(req.params.token)
    try {
      // Body first: a malformed request is a 400 whoever sends it, and nothing
      // unparsed reaches updateShare (unknown keys are stripped by the schema).
      const body = parseShareUpdate(req.body ?? {})
      if (!body.ok) { res.status(400).json({ error: body.error }); return }
      // RBAC manage gate: editing/disabling/repointing a link requires WRITE on the
      // share's workspace — a View-only grant (or another org) must not touch it.
      // requireVersionWrite writes the 403; a missing grant only refuses at stage 'on'.
      // `missingLandscape: 'deny'`: a share whose landscape is gone (an orphan
      // row) is refused with a 404 rather than passing the gate (V0-03).
      const existing = await getShareGateInfo(token)
      if (!existing.exists) { res.status(404).json({ error: 'Share not found' }); return }
      const key = await deps.workspaceKey(existing.landscapeId, existing.versionId)
      if (!(await requireVersionWrite(deps.pool, req, res, key.landscapeId, key.versionId, { missingLandscape: 'deny' }))) return
      const share = await updateShare(token, { ...body.value, sessionOrgId: req.auth?.orgId })
      if (!share) { res.status(404).json({ error: 'Share not found' }); return }
      res.json({ share })
    } catch (err) {
      // A failed registry read (WorkspaceRegistryUnavailableError from the
      // workspace key's canonicalisation) or another dependency outage is the
      // shared 503, not this handler's 500.
      if (sendDependencyOutage(res, err)) return
      console.error('Update share error:', err)
      res.status(500).json({ error: 'Failed to update share' })
    }
  }
}
