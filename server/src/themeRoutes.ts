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
import { pool } from './db.js'
import { requireOrgAdmin } from './rbac/workspaceGate.js'
import { listThemes, getTheme, publishTheme, incrementInstalls, reportTheme, validateThemePayload } from './themes.js'

/**
 * Community theme gallery routes.
 *
 * The gallery is platform-global (`theme_plugins` has no org column), so there
 * is no org or landscape to scope a check to. Authorization:
 *  - reads, install and report: the global `/api` session gate (stage 'on')
 *    already requires a signed-in user; nothing stronger is meaningful for a
 *    shared catalogue.
 *  - publish (`POST /api/themes`) upserts by id and stores code that other
 *    users' clients run in the worker sandbox, so it needs more than a session:
 *    an org admin (or platform admin), via the same staged gate that guards
 *    landscape creation (off/no-claims allow, dual warn, on 403).
 */
export function registerThemeRoutes(app: Express): void {
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
      if (!(await requireOrgAdmin(pool, req, res))) return
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
}
