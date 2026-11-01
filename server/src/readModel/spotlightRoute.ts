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

/**
 * `POST /api/model/spotlight`: grouped, ranked search over one workspace.
 *
 * POST because the body carries the client's domain and tag names, which the
 * read model does not hold; the request is read-only.
 *
 * The answer says how far to trust it, as `durabilityWitnessPayload` does:
 * the workspace it is for (a late answer after a workspace switch is dropped by
 * the client), the projection's generation and status (an empty list from a
 * projection that is still building is not "nothing found"), and the read
 * model's coverage gaps (`spotlight.ts`). A database whose stored fold is not
 * the one this build would write answers 503, so the client falls back to its
 * own tiers instead of showing a silently short list.
 *
 * Registered by `server/src/index.ts`; `spotlightRoute.test.ts` mounts this
 * function on a bare app. The single registration line in index.ts is the one
 * wire no test covers.
 */

import type { Express, Request, Response } from 'express'
import { route } from '../routeErrors.js'
import { getWorkspaceProjectionFreshness } from './health.js'
import { SpotlightAborted, parseSpotlightRequest, roSpotlight } from './spotlight.js'
import type { SpotlightWorkspace } from './spotlight.js'
import { spotlightReadiness } from './spotlightSql.js'
import type { SpotlightReadiness } from './spotlightSql.js'
import type { Queryable } from './types.js'

interface Freshness {
  status: string
  projectedGeneration: number
  caughtUp: boolean
  absenceProvable: boolean
}

export interface SpotlightRouteDeps {
  readonly db: Queryable
  /** The workspace gate: the canonical key, or undefined after writing 403/404. */
  readonly ensureWorkspace: (req: Request, res: Response) => Promise<SpotlightWorkspace | undefined>
  readonly search?: typeof roSpotlight
  readonly freshness?: (db: Queryable, key: SpotlightWorkspace) => Promise<Freshness>
  readonly readiness?: (db: Queryable) => Promise<SpotlightReadiness>
  /** How long a NOT-ready verdict is trusted before it is checked again. */
  readonly notReadyTtlMs?: number
}

/** A ready verdict holds for the process (the schema cannot change under a
 *  running build); a not-ready one is re-checked, since a boot elsewhere may be
 *  building the schema right now. */
function cachedReadiness(deps: SpotlightRouteDeps): () => Promise<SpotlightReadiness> {
  const check = deps.readiness ?? spotlightReadiness
  const ttl = deps.notReadyTtlMs ?? 30_000
  let cached: { verdict: SpotlightReadiness; at: number } | null = null
  return async () => {
    if (cached && (cached.verdict.ready || Date.now() - cached.at < ttl)) return cached.verdict
    const verdict = await check(deps.db)
    if (!verdict.ready) console.warn(`[spotlight] not ready: ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ''}`)
    cached = { verdict, at: Date.now() }
    return verdict
  }
}

export function registerSpotlightRoutes(app: Express, deps: SpotlightRouteDeps): void {
  const search = deps.search ?? roSpotlight
  const freshness = deps.freshness ?? getWorkspaceProjectionFreshness
  const readiness = cachedReadiness(deps)

  app.post('/api/model/spotlight', route(async (req: Request, res: Response) => {
    const key = await deps.ensureWorkspace(req, res)
    if (!key) return
    const request = parseSpotlightRequest(req.body)
    if (typeof request === 'string') {
      res.status(400).json({ error: request })
      return
    }
    const ready = await readiness()
    if (!ready.ready) {
      res.status(503).json({ error: 'spotlight unavailable', reason: ready.reason, retryable: ready.reason === 'not-built' })
      return
    }
    // A closed response with nothing written means the client went away.
    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() })
    try {
      const result = await search(deps.db, key, request.q, {
        kinds: request.kinds, perKind: request.perKind, vocab: request.vocab, signal: controller.signal,
      })
      const fresh = await freshness(deps.db, key)
      res.json({
        ...result,
        landscapeId: key.landscapeId,
        versionId: key.versionId,
        projectionGeneration: fresh.projectedGeneration,
        status: fresh.status,
        caughtUp: fresh.caughtUp,
        absenceProvable: fresh.absenceProvable,
      })
    } catch (error) {
      if (error instanceof SpotlightAborted) return
      throw error
    }
  }))
}
