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
import { signSession, type SessionClaims } from './tokens.js'

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
 * Read the per-user authorization epoch for (org, user) — bumped when THIS
 * user's access in the org is reduced (`bump_auth_user_epoch`, wsAuth.ts).
 * No row = 1, the value an old cookie without `uepoch` is read as.
 */
export async function currentUserEpoch(db: EpochQuery, orgId: string, userId: string): Promise<number> {
  const { rows } = await db.query<{ epoch: number | string }>(
    'SELECT epoch FROM auth_user_epochs WHERE org_id = $1 AND user_id = $2',
    [orgId, userId],
  )
  return rows[0] ? Number(rows[0].epoch) : 1
}

/**
 * Read the global (org-independent) epoch for a user — bumped when they lose
 * platform admin or are deactivated (`bump_auth_global_epoch`, wsAuth.ts).
 * No row = 1, the value an old cookie without `gepoch` is read as.
 */
export async function currentGlobalEpoch(db: EpochQuery, userId: string): Promise<number> {
  const { rows } = await db.query<{ epoch: number | string }>(
    'SELECT epoch FROM auth_global_epochs WHERE user_id = $1',
    [userId],
  )
  return rows[0] ? Number(rows[0].epoch) : 1
}

/** Why `signCurrentSession` refused to mint. Every mint route answers it as a
 * 403 `{ error: reason }` (`mintRefusalBody`). */
export type SessionMintRefusal = 'user_inactive' | 'impersonator_not_admin' | 'not_a_member' | 'org_suspended'

export class SessionMintRefusedError extends Error {
  constructor(readonly reason: SessionMintRefusal) {
    super(`session mint refused: ${reason}`)
    this.name = 'SessionMintRefusedError'
  }
}

/** The 403 body for a refused mint, or null for any other error. */
export function mintRefusalBody(err: unknown): { error: SessionMintRefusal } | null {
  return err instanceof SessionMintRefusedError ? { error: err.reason } : null
}

interface UserMintRow { id: string; is_platform_admin: boolean; status: string; gepoch: number | string }
interface OrgMintRow { status: string; epoch: number | string; uepoch: number | string; member: boolean }

/**
 * THE way to mint a session. Every sign-in, org switch, invite accept and
 * impersonation goes through here; sessionEpoch.test.ts fails if
 * `signSession(` is called anywhere else in server/src.
 *
 * Each epoch is read IN THE SAME STATEMENT as the facts it vouches for, and
 * those facts are re-checked here rather than taken from the caller: the
 * user's `is_platform_admin` and `status` with their global epoch, the org's
 * status with its epoch, the membership with the per-user epoch. A fact read
 * by the caller BEFORE the epoch could be revoked in between, and the session
 * would carry the stale fact under the post-revocation epoch — current on
 * every gate for its whole life. Measured shape (reviewer + architect lenses,
 * 2026-10-16): switch-org copied `isPlatformAdmin` from the old cookie, and
 * its `UPDATE users` waited on the revoke's row lock, so the mint read the
 * bumped `gepoch` after the revoke committed — a fresh 30-day admin cookie.
 * One statement is one snapshot, and every reduction moves its epoch in the
 * same transaction as the fact (trg_epoch_users; the membership triggers) or
 * after it (an org suspension updates the status, then bumps), so a snapshot
 * that sees the old epoch also sees the old fact, and the session it mints is
 * refused once the epoch moves.
 *
 * So: `isPlatformAdmin` is signed as the caller's AND the database's (never
 * elevated past either; an impersonation session passes false); an inactive
 * user, an org the user is not a member of or that is suspended, and an
 * impersonator who is no longer an active platform admin all REFUSE
 * (`SessionMintRefusedError`) — which is also what stops a deactivated user
 * from simply signing in again. Old cookies minted without `uepoch`/`gepoch`
 * read them as 1.
 */
export async function signCurrentSession(
  db: EpochQuery,
  base: Omit<SessionClaims, 'epoch' | 'uepoch' | 'gepoch' | 'imp'> & { imp?: { by: string } },
  maxAgeS?: number,
): Promise<string> {
  const ids = base.imp ? [base.userId, base.imp.by] : [base.userId]
  const [{ rows: users }, org] = await Promise.all([
    db.query<UserMintRow>(
      `SELECT u.id, u.is_platform_admin, u.status, COALESCE(g.epoch, 1) AS gepoch
       FROM users u LEFT JOIN auth_global_epochs g ON g.user_id = u.id
       WHERE u.id = ANY($1::text[])`,
      [ids],
    ),
    base.orgId
      ? db.query<OrgMintRow>(
          `SELECT o.status, COALESCE(e.epoch, 1) AS epoch, COALESCE(ue.epoch, 1) AS uepoch,
                  EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id AND m.user_id = $2) AS member
           FROM orgs o
           LEFT JOIN auth_epochs e ON e.org_id = o.id
           LEFT JOIN auth_user_epochs ue ON ue.org_id = o.id AND ue.user_id = $2
           WHERE o.id = $1`,
          [base.orgId, base.userId],
        )
      : null,
  ])
  const user = users.find((r) => r.id === base.userId)
  if (!user || user.status !== 'active') throw new SessionMintRefusedError('user_inactive')
  let imp: { by: string; gepoch: number } | undefined
  if (base.imp) {
    const by = users.find((r) => r.id === base.imp!.by)
    if (!by || by.status !== 'active' || !by.is_platform_admin) throw new SessionMintRefusedError('impersonator_not_admin')
    imp = { by: by.id, gepoch: Number(by.gepoch) }
  }
  let epoch = 1
  let uepoch = 1
  if (org) {
    const row = org.rows[0]
    if (!row || !row.member) throw new SessionMintRefusedError('not_a_member')
    if (row.status === 'suspended') throw new SessionMintRefusedError('org_suspended')
    epoch = Number(row.epoch)
    uepoch = Number(row.uepoch)
  }
  return signSession(
    {
      ...base,
      isPlatformAdmin: base.isPlatformAdmin && user.is_platform_admin,
      epoch,
      uepoch,
      gepoch: Number(user.gepoch),
      ...(imp ? { imp } : {}),
    },
    maxAgeS,
  )
}

/** The per-user epoch a session carries; absent (minted before it existed) = 1. */
export function sessionUserEpoch(claims: SessionClaims): number {
  return claims.uepoch ?? 1
}

/** The global epoch a session carries for its user; absent = 1. */
export function sessionGlobalEpoch(claims: SessionClaims): number {
  return claims.gepoch ?? 1
}

/** Every (user, pinned global epoch) a session depends on: its own user's,
 * and on an impersonation session the impersonator's too. */
export function sessionGlobalPins(claims: SessionClaims): Array<{ userId: string; gepoch: number }> {
  const pins = [{ userId: claims.userId, gepoch: sessionGlobalEpoch(claims) }]
  if (claims.imp) pins.push({ userId: claims.imp.by, gepoch: claims.imp.gepoch ?? 1 })
  return pins
}

async function globalPinsCurrent(
  claims: SessionClaims,
  read: (userId: string) => Promise<number>,
): Promise<boolean> {
  const pins = sessionGlobalPins(claims)
  const current = await Promise.all(pins.map((pin) => read(pin.userId)))
  return pins.every((pin, i) => pin.gepoch === current[i])
}

/**
 * A JWT can remain cryptographically valid after grants or membership change.
 * Reject that stale authorization snapshot before attaching expensive stateful
 * transports such as Automerge. Every epoch must match: the user's global one
 * (and the impersonator's, if any) — checked for org-less sessions too — then
 * the org's (an org-wide event) and this user's in the org (a reduction of
 * their own access).
 */
export async function isSessionEpochCurrent(db: EpochQuery, claims: SessionClaims): Promise<boolean> {
  if (!(await globalPinsCurrent(claims, (userId) => currentGlobalEpoch(db, userId)))) return false
  if (!claims.orgId) return true
  if (claims.epoch !== await currentOrgEpoch(db, claims.orgId)) return false
  return sessionUserEpoch(claims) === await currentUserEpoch(db, claims.orgId, claims.userId)
}

/**
 * Build a fail-closed epoch validator that shares concurrent database reads and
 * a very short, bounded positive result. Reconnects for one organization arrive
 * in several small waves rather than one perfect Promise flight; without this
 * burst cache every wave queues the same PostgreSQL read. Live sockets are
 * already revoked by the epoch poller, so the default 500 ms admission window is
 * substantially tighter than the transport's existing revocation bound.
 *
 * Three burst caches: the global epoch per user (checked first, for every
 * session including org-less ones), the org epoch (shared by a whole org's
 * reconnect wave) and the per-user epoch in the org (one primary-key read per
 * user, coalesced across that user's tabs). Each later read is skipped when
 * an earlier one already refuses.
 */
export interface SessionEpochValidator {
  (claims: SessionClaims): Promise<boolean>
  /** Drop what the burst caches hold for an org (and, with a user, that
   * user's epoch). Called on a bump notify, so a reconnect inside the burst
   * window cannot be admitted on the pre-bump value and then live until the
   * next poll (reviewer lens, 2026-10-16). */
  forget(orgId: string, userId?: string): void
  /** Drop the burst-cached global epoch of a user (an `auth_global_epoch` notify). */
  forgetGlobal(userId: string): void
}

export function createSessionEpochValidator(
  db: EpochQuery,
  options: SessionEpochValidatorOptions = {},
): SessionEpochValidator {
  const cacheTtlMs = boundedInteger(
    options.cacheTtlMs ?? Number(process.env.WS_AUTH_EPOCH_BURST_CACHE_MS),
    DEFAULT_BURST_CACHE_TTL_MS,
    MAX_BURST_CACHE_TTL_MS,
  )
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_BURST_CACHE_ENTRIES))
  const now = options.now ?? Date.now
  const orgEpochs = burstCache(cacheTtlMs, maxEntries, now)
  const userEpochs = burstCache(cacheTtlMs, maxEntries, now)
  const globalEpochs = burstCache(cacheTtlMs, maxEntries, now)

  const userKey = (orgId: string, userId: string) => JSON.stringify([orgId, userId])
  const globalCurrent = (claims: SessionClaims) =>
    globalPinsCurrent(claims, (userId) => globalEpochs.get(userId, () => currentGlobalEpoch(db, userId)))
  const validate = async (claims: SessionClaims) => {
    if (!(await globalCurrent(claims))) return false
    if (!claims.orgId) return true
    const orgId = claims.orgId
    const orgEpoch = await orgEpochs.get(orgId, () => currentOrgEpoch(db, orgId))
    if (claims.epoch !== orgEpoch) return false
    const userEpoch = await userEpochs.get(userKey(orgId, claims.userId), () =>
      currentUserEpoch(db, orgId, claims.userId),
    )
    return sessionUserEpoch(claims) === userEpoch
  }
  return Object.assign(validate, {
    forget(orgId: string, userId?: string) {
      if (userId === undefined) orgEpochs.forget(orgId)
      else userEpochs.forget(userKey(orgId, userId))
    },
    forgetGlobal(userId: string) {
      globalEpochs.forget(userId)
    },
  })
}

const sharedValidators = new WeakMap<object, SessionEpochValidator>()

/** One validator per pool for the process, shared by the sync upgrade and
 * HTTP, so the bump notify that `startEpochRevocation` relays to `forget*`
 * clears the burst cache both of them read. */
export function sharedSessionEpochValidator(db: EpochQuery): SessionEpochValidator {
  let validator = sharedValidators.get(db)
  if (!validator) {
    validator = createSessionEpochValidator(db)
    sharedValidators.set(db, validator)
  }
  return validator
}

/** Shared in-flight read + short bounded cache, per key. A failed read is not
 * cached (the next caller retries) and propagates — callers fail closed. */
function burstCache(
  cacheTtlMs: number,
  maxEntries: number,
  now: () => number,
): { get: (key: string, load: () => Promise<number>) => Promise<number>; forget: (key: string) => void } {
  const inFlight = new Map<string, Promise<number>>()
  const cache = new Map<string, { epoch: number; expiresAt: number }>()
  // A flight that STARTED before a forget must not repopulate the cache: it
  // may have read the pre-bump value. One counter for all keys (bounded
  // memory); a forget elsewhere costs an in-flight read its caching, nothing more.
  let generation = 0
  const forget = (key: string) => {
    cache.delete(key)
    inFlight.delete(key)
    generation += 1
  }
  const get = (key: string, load: () => Promise<number>): Promise<number> => {
    const cached = cache.get(key)
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.epoch)
    if (cached) cache.delete(key)

    let pending = inFlight.get(key)
    if (!pending) {
      const startedAt = generation
      const flight = load()
      pending = flight
      inFlight.set(key, flight)
      const clear = () => {
        if (inFlight.get(key) === flight) inFlight.delete(key)
      }
      void flight.then((epoch) => {
        clear()
        if (cacheTtlMs <= 0 || startedAt !== generation) return
        while (cache.size >= maxEntries) {
          const oldest = cache.keys().next().value as string | undefined
          if (oldest === undefined) break
          cache.delete(oldest)
        }
        cache.set(key, { epoch, expiresAt: now() + cacheTtlMs })
      }, clear)
    }
    return pending
  }
  return { get, forget }
}
