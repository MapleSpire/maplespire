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
import type { SessionClaims } from './tokens.js'

type EpochQuery = Pick<Pool, 'query'>

const DEFAULT_BURST_CACHE_TTL_MS = 500
const MAX_BURST_CACHE_TTL_MS = 5_000
const DEFAULT_BURST_CACHE_ENTRIES = 1_000

export interface SessionEpochValidatorOptions {
  /** Bound the stale-auth window while absorbing reconnect storms. */
  cacheTtlMs?: number
  maxEntries?: number
  now?: () => number
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(0, Math.floor(value!)))
    : fallback
}

/**
 * Read the authorization epoch that newly-issued sessions for an organization
 * must carry. PostgreSQL returns BIGINT values as strings, so the conversion
 * belongs here rather than at each authentication entry point.
 */
export async function currentOrgEpoch(db: EpochQuery, orgId: string): Promise<number> {
  const { rows } = await db.query<{ epoch: number | string }>(
    'SELECT epoch FROM auth_epochs WHERE org_id = $1',
    [orgId],
  )
  return rows[0] ? Number(rows[0].epoch) : 1
}

/**
 * A JWT can remain cryptographically valid after grants or membership change.
 * Reject that stale authorization snapshot before attaching expensive stateful
 * transports such as Automerge.
 */
export async function isSessionEpochCurrent(db: EpochQuery, claims: SessionClaims): Promise<boolean> {
  if (!claims.orgId) return true
  return claims.epoch === await currentOrgEpoch(db, claims.orgId)
}

/**
 * Build a fail-closed epoch validator that shares concurrent database reads and
 * a very short, bounded positive result. Reconnects for one organization arrive
 * in several small waves rather than one perfect Promise flight; without this
 * burst cache every wave queues the same PostgreSQL read. Live sockets are
 * already revoked by the epoch poller, so the default 500 ms admission window is
 * substantially tighter than the transport's existing revocation bound.
 */
export function createSessionEpochValidator(
  db: EpochQuery,
  options: SessionEpochValidatorOptions = {},
): (claims: SessionClaims) => Promise<boolean> {
  const inFlight = new Map<string, Promise<number>>()
  const cache = new Map<string, { epoch: number; expiresAt: number }>()
  const cacheTtlMs = boundedInteger(
    options.cacheTtlMs ?? Number(process.env.WS_AUTH_EPOCH_BURST_CACHE_MS),
    DEFAULT_BURST_CACHE_TTL_MS,
    MAX_BURST_CACHE_TTL_MS,
  )
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_BURST_CACHE_ENTRIES))
  const now = options.now ?? Date.now

  return async (claims) => {
    if (!claims.orgId) return true
    const orgId = claims.orgId
    const cached = cache.get(orgId)
    if (cached && cached.expiresAt > now()) return claims.epoch === cached.epoch
    if (cached) cache.delete(orgId)

    let pending = inFlight.get(orgId)
    if (!pending) {
      pending = currentOrgEpoch(db, orgId)
      inFlight.set(orgId, pending)
      const clear = () => {
        if (inFlight.get(orgId) === pending) inFlight.delete(orgId)
      }
      void pending.then((epoch) => {
        clear()
        if (cacheTtlMs <= 0) return
        while (cache.size >= maxEntries) {
          const oldest = cache.keys().next().value as string | undefined
          if (oldest === undefined) break
          cache.delete(oldest)
        }
        cache.set(orgId, { epoch, expiresAt: now() + cacheTtlMs })
      }, clear)
    }
    return claims.epoch === await pending
  }
}
