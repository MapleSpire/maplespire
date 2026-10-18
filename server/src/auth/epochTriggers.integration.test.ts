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
 * The auth-epoch rules, against REAL Postgres triggers:
 *  - a pure GRANT bumps nothing and announces itself on `workspace_access_changed`;
 *  - a REDUCTION bumps the per-user epoch of exactly the users it reduced
 *    (`auth_user_epochs`) — never the org's, never a colleague's.
 *
 * Regressions (2026-10-16): accepting an invite bumped the org-wide epoch and
 * revoked every live session in the org, the inviter's included; then, with
 * grants fixed, a demotion still revoked the whole org — the admin who made it
 * included (their next request was refused).
 *
 * Every case measures ONE statement (or the accept's one transaction) in
 * isolation: epochs are read before and after, notifications are cleared
 * before, and a SENTINEL notify sent after the statement bounds what it
 * produced — NOTIFYs are delivered in commit order, so once the sentinel
 * arrives, every notify the statement could have caused has arrived too. Each
 * case also watches a COLLEAGUE whose epoch must never move.
 *
 * NOTIFY isolation: channels are database-global, so every org id is
 * suite-unique and the assertions filter on it (same accepted leak as
 * isolatedSchema.ts documents for `bump_auth_epoch`).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureAuthSchema } from './schema.js'
import { ensureRbacSchema, upsertOrgScope, upsertLandscapeScope } from '../rbac/schema.js'
import { ConnectionRegistry, ensureEpochTriggers, startEpochRevocation } from './wsAuth.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const GRANT = 'workspace_access_changed'
const ORG_REVOKE = 'auth_epoch'
const USER_REVOKE = 'auth_user_epoch'
const GLOBAL_REVOKE = 'auth_global_epoch'

describe.skipIf(!TEST_DATABASE_URL)('auth epoch triggers: only a reduction revokes, and only whom it reduced (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let listener: PoolClient
  const notifications: Array<{ channel: string; payload: string }> = []
  let seq = 0

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'epoch_triggers')
    await ensureAuthSchema(db.pool)
    await ensureRbacSchema(db.pool)
    await ensureEpochTriggers(db.pool)
    listener = await db.pool.connect()
    listener.on('notification', (msg) => {
      if (msg.payload) notifications.push({ channel: msg.channel, payload: msg.payload })
    })
    await listener.query(`LISTEN ${ORG_REVOKE}`)
    await listener.query(`LISTEN ${USER_REVOKE}`)
    await listener.query(`LISTEN ${GRANT}`)
  })

  afterAll(async () => {
    if (listener) {
      await listener.query('UNLISTEN *').catch(() => {})
      listener.release()
    }
    await db?.teardown()
  })

  const rid = (p: string) => `${p}-et-${Date.now().toString(36)}-${++seq}`

  async function makeOrg(): Promise<string> {
    const id = rid('org')
    await db.pool.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1)', [id])
    return id
  }
  async function makeUser(): Promise<string> {
    const id = rid('user')
    await db.pool.query(
      "INSERT INTO users (id, issuer, subject, email) VALUES ($1, 'test', $1, $1 || '@example.com')",
      [id],
    )
    return id
  }
  async function makeTeam(orgId: string): Promise<string> {
    const id = rid('team')
    await db.pool.query('INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $1)', [id, orgId])
    return id
  }
  async function addMember(orgId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
    await db.pool.query('INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, userId, role])
  }
  async function orgEpoch(orgId: string): Promise<number> {
    const { rows } = await db.pool.query<{ epoch: string }>('SELECT epoch FROM auth_epochs WHERE org_id = $1', [orgId])
    return rows[0] ? Number(rows[0].epoch) : 1
  }
  async function userEpoch([orgId, userId]: Pair): Promise<number> {
    const { rows } = await db.pool.query<{ epoch: string }>(
      'SELECT epoch FROM auth_user_epochs WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    )
    return rows[0] ? Number(rows[0].epoch) : 1
  }
  type Pair = [orgId: string, userId: string]

  /** The org a notification is about: its payload, or the `org` of a per-user payload. */
  function orgOf(n: { channel: string; payload: string }): string | null {
    if (n.channel !== USER_REVOKE) return n.payload
    try {
      return (JSON.parse(n.payload) as { org?: string }).org ?? null
    } catch {
      return null
    }
  }

  /**
   * What `act` did: per watched org, its epoch delta and the channels notified
   * about it; per watched (org, user), the per-user epoch delta.
   */
  async function effectsOf(watch: { orgs: string[]; users: Pair[] }, act: () => Promise<unknown>) {
    const orgsBefore = await Promise.all(watch.orgs.map(orgEpoch))
    const usersBefore = await Promise.all(watch.users.map(userEpoch))
    notifications.length = 0
    await act()
    const sentinel = rid('sentinel')
    await db.pool.query(`SELECT pg_notify('${GRANT}', $1)`, [sentinel])
    await vi.waitFor(
      () => expect(notifications.some((n) => n.payload === sentinel)).toBe(true),
      { timeout: 3_000, interval: 10 },
    )
    const orgsAfter = await Promise.all(watch.orgs.map(orgEpoch))
    const usersAfter = await Promise.all(watch.users.map(userEpoch))
    return {
      orgs: watch.orgs.map((org, i) => ({
        bumped: orgsAfter[i] - orgsBefore[i],
        notified: [...new Set(notifications.filter((n) => orgOf(n) === org).map((n) => n.channel))].sort(),
      })),
      users: watch.users.map((_, i) => usersAfter[i] - usersBefore[i]),
    }
  }
  const granted = { bumped: 0, notified: [GRANT] }
  const reducedSomeone = { bumped: 0, notified: [USER_REVOKE] }
  const untouched = { bumped: 0, notified: [] }

  it("an invite accepted — a member added, joined to the invite's team, in one transaction — revokes nobody and announces the grant", async () => {
    const orgId = await makeOrg()
    const owner = await makeUser()
    await addMember(orgId, owner, 'admin')
    const team = await makeTeam(orgId)
    const guest = await makeUser()

    // The exact writes of POST /api/invites/:token/accept (invites.ts).
    const effect = await effectsOf({ orgs: [orgId], users: [[orgId, owner], [orgId, guest]] }, async () => {
      const client = await db.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT (org_id, user_id) DO NOTHING`,
          [orgId, guest],
        )
        await client.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [team, guest])
        await client.query('COMMIT')
      } finally {
        client.release()
      }
    })
    expect(effect).toEqual({ orgs: [granted], users: [0, 0] })
  })

  it('org_members: add and promote grant; an untouched role does nothing; demote, re-key and remove revoke THAT user only', async () => {
    const orgA = await makeOrg()
    const orgB = await makeOrg()
    const user = await makeUser()
    const other = await makeUser()
    const colleague = await makeUser() // the admin making the changes
    await addMember(orgA, colleague, 'admin')
    await addMember(orgB, colleague, 'admin')
    const watchA = { orgs: [orgA], users: [[orgA, user], [orgA, colleague]] as Pair[] }

    expect(await effectsOf(watchA, () => addMember(orgA, user, 'member'))).toEqual({ orgs: [granted], users: [0, 0] })
    expect(await effectsOf(watchA, () =>
      db.pool.query("UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2", [orgA, user]),
    )).toEqual({ orgs: [untouched], users: [0, 0] })
    expect(await effectsOf(watchA, () =>
      db.pool.query("UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2", [orgA, user]),
    )).toEqual({ orgs: [granted], users: [0, 0] })
    expect(await effectsOf(watchA, () =>
      db.pool.query("UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2", [orgA, user]),
    )).toEqual({ orgs: [reducedSomeone], users: [1, 0] })
    // Moved to another org: a removal from A, an addition to B.
    expect(await effectsOf({ orgs: [orgA, orgB], users: [[orgA, user], [orgB, user], [orgB, colleague]] }, () =>
      db.pool.query('UPDATE org_members SET org_id = $3 WHERE org_id = $1 AND user_id = $2', [orgA, user, orgB]),
    )).toEqual({ orgs: [reducedSomeone, granted], users: [1, 0, 0] })
    // Re-keyed to another user: the first one lost the membership; the second gained one.
    expect(await effectsOf({ orgs: [orgB], users: [[orgB, user], [orgB, other], [orgB, colleague]] }, () =>
      db.pool.query('UPDATE org_members SET user_id = $3 WHERE org_id = $1 AND user_id = $2', [orgB, user, other]),
    )).toEqual({ orgs: [reducedSomeone], users: [1, 0, 0] })
    expect(await effectsOf({ orgs: [orgB], users: [[orgB, other], [orgB, colleague]] }, () =>
      db.pool.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [orgB, other]),
    )).toEqual({ orgs: [reducedSomeone], users: [1, 0] })
  })

  it('team_members: joining a team grants; moving to another team or leaving revokes THAT user only', async () => {
    const orgA = await makeOrg()
    const orgB = await makeOrg()
    const teamA = await makeTeam(orgA)
    const teamA2 = await makeTeam(orgA)
    const teamB = await makeTeam(orgB)
    const user = await makeUser()
    const teammate = await makeUser()
    for (const org of [orgA, orgB]) {
      await addMember(org, user, 'member')
      await addMember(org, teammate, 'member')
    }
    await db.pool.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2), ($3, $2)', [teamA, teammate, teamB])

    expect(await effectsOf({ orgs: [orgA], users: [[orgA, user], [orgA, teammate]] }, () =>
      db.pool.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)', [teamA, user]),
    )).toEqual({ orgs: [granted], users: [0, 0] })
    // Within the org: leaving A for A2 may take away what A granted.
    expect(await effectsOf({ orgs: [orgA], users: [[orgA, user], [orgA, teammate]] }, () =>
      db.pool.query('UPDATE team_members SET team_id = $3 WHERE team_id = $1 AND user_id = $2', [teamA, user, teamA2]),
    )).toEqual({ orgs: [reducedSomeone], users: [1, 0] })
    // Across orgs: a removal for A (the OLD team's org), an addition for B.
    expect(await effectsOf({ orgs: [orgA, orgB], users: [[orgA, user], [orgB, user], [orgB, teammate]] }, () =>
      db.pool.query('UPDATE team_members SET team_id = $3 WHERE team_id = $1 AND user_id = $2', [teamA2, user, teamB]),
    )).toEqual({ orgs: [reducedSomeone, granted], users: [1, 0, 0] })
    expect(await effectsOf({ orgs: [orgB], users: [[orgB, user], [orgB, teammate]] }, () =>
      db.pool.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [teamB, user]),
    )).toEqual({ orgs: [reducedSomeone], users: [1, 0] })
  })

  it("team_scope_permissions: create and widen grant; audit-only does nothing; a reduction revokes the TEAM's members and nobody else", async () => {
    const orgId = await makeOrg()
    const orgScope = await upsertOrgScope(db.pool, orgId)
    const landscapeScope = await upsertLandscapeScope(db.pool, orgId, rid('L'))
    const team = await makeTeam(orgId)
    const [m1, m2, outsider] = [await makeUser(), await makeUser(), await makeUser()]
    for (const u of [m1, m2, outsider]) await addMember(orgId, u, 'member')
    await db.pool.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2), ($1, $3)', [team, m1, m2])
    const watch = { orgs: [orgId], users: [[orgId, m1], [orgId, m2], [orgId, outsider]] as Pair[] }
    const where = 'WHERE team_id = $1'
    const tsp = (sql: string, ...params: unknown[]) => () => db.pool.query(sql, [team, ...params])
    const teamReduced = { orgs: [reducedSomeone], users: [1, 1, 0] }

    expect(await effectsOf(watch, tsp(
      `INSERT INTO team_scope_permissions (team_id, scope_id, resource_type, can_read, can_write) VALUES ($1, $2, '*', true, false)`,
      orgScope,
    ))).toEqual({ orgs: [granted], users: [0, 0, 0] })
    expect(await effectsOf(watch, tsp(`UPDATE team_scope_permissions SET can_write = true ${where}`)))
      .toEqual({ orgs: [granted], users: [0, 0, 0] })
    expect(await effectsOf(watch, tsp(`UPDATE team_scope_permissions SET updated_at = now() ${where}`)))
      .toEqual({ orgs: [untouched], users: [0, 0, 0] })
    expect(await effectsOf(watch, tsp(`UPDATE team_scope_permissions SET can_read = false ${where}`))).toEqual(teamReduced)
    expect(await effectsOf(watch, tsp(`UPDATE team_scope_permissions SET can_read = true ${where}`)))
      .toEqual({ orgs: [granted], users: [0, 0, 0] })
    expect(await effectsOf(watch, tsp(`UPDATE team_scope_permissions SET can_write = false ${where}`))).toEqual(teamReduced)
    // Re-keying moves the grant off what it covered: a reduction there.
    expect(await effectsOf(watch, tsp(`UPDATE team_scope_permissions SET scope_id = $2 ${where}`, landscapeScope))).toEqual(teamReduced)
    expect(await effectsOf(watch, tsp(`UPDATE team_scope_permissions SET resource_type = 'flows' ${where}`))).toEqual(teamReduced)
    expect(await effectsOf(watch, tsp(`DELETE FROM team_scope_permissions ${where}`))).toEqual(teamReduced)
  })

  it('an org-wide event (bump_auth_epoch — a suspension) still moves the org epoch', async () => {
    const orgId = await makeOrg()
    const user = await makeUser()
    await addMember(orgId, user, 'admin')
    expect(await effectsOf({ orgs: [orgId], users: [[orgId, user]] }, () =>
      db.pool.query('SELECT bump_auth_epoch($1)', [orgId]),
    )).toEqual({ orgs: [{ bumped: 1, notified: [ORG_REVOKE] }], users: [0] })
  })

  // Regression (architect lens, 2026-10-16): revoking platform admin bumped
  // nothing, so the signed `isPlatformAdmin` claim kept cross-org sync for the
  // cookie's 30 days; and deactivation reached only (org, user) epochs, never
  // an org-less session.
  describe('users: losing platform admin or leaving active bumps the GLOBAL epoch of that user only', () => {
    async function globalEpoch(userId: string): Promise<number> {
      const { rows } = await db.pool.query<{ epoch: string }>('SELECT epoch FROM auth_global_epochs WHERE user_id = $1', [userId])
      return rows[0] ? Number(rows[0].epoch) : 1
    }
    /** Global epoch deltas of `users` and the users notified on GLOBAL_REVOKE,
     * bounded by a sentinel like effectsOf. */
    async function globalEffectsOf(users: string[], act: () => Promise<unknown>) {
      const before = await Promise.all(users.map(globalEpoch))
      notifications.length = 0
      await act()
      const sentinel = rid('sentinel')
      await db.pool.query(`SELECT pg_notify('${GRANT}', $1)`, [sentinel])
      await vi.waitFor(
        () => expect(notifications.some((n) => n.payload === sentinel)).toBe(true),
        { timeout: 3_000, interval: 10 },
      )
      const after = await Promise.all(users.map(globalEpoch))
      return {
        bumped: users.map((_, i) => after[i] - before[i]),
        notified: notifications.filter((n) => n.channel === GLOBAL_REVOKE && users.includes(n.payload)).map((n) => n.payload),
      }
    }
    const setUser = (column: 'is_platform_admin' | 'status', value: unknown, userId: string) =>
      db.pool.query(`UPDATE users SET ${column} = $1 WHERE id = $2`, [value, userId])

    beforeAll(async () => {
      await listener.query(`LISTEN ${GLOBAL_REVOKE}`)
    })

    it('platform admin: a revoke bumps once and notifies; a grant, a no-op and an unrelated column bump nothing', async () => {
      const [user, colleague] = [await makeUser(), await makeUser()]
      const orgId = await makeOrg()
      await addMember(orgId, user, 'admin')
      await setUser('is_platform_admin', true, colleague)

      expect(await globalEffectsOf([user, colleague], () => setUser('is_platform_admin', true, user)))
        .toEqual({ bumped: [0, 0], notified: [] })
      expect(await globalEffectsOf([user, colleague], () => setUser('is_platform_admin', true, user)))
        .toEqual({ bumped: [0, 0], notified: [] })
      expect(await globalEffectsOf([user, colleague], () =>
        db.pool.query("UPDATE users SET name = 'renamed' WHERE id = $1", [user]),
      )).toEqual({ bumped: [0, 0], notified: [] })
      // The org-scoped epochs do not move: this is not an org event.
      const orgBefore = await orgEpoch(orgId)
      const userInOrgBefore = await userEpoch([orgId, user])
      expect(await globalEffectsOf([user, colleague], () => setUser('is_platform_admin', false, user)))
        .toEqual({ bumped: [1, 0], notified: [user] })
      expect(await orgEpoch(orgId)).toBe(orgBefore)
      expect(await userEpoch([orgId, user])).toBe(userInOrgBefore)
      // Already not an admin: setting false again revokes nothing.
      expect(await globalEffectsOf([user, colleague], () => setUser('is_platform_admin', false, user)))
        .toEqual({ bumped: [0, 0], notified: [] })
    })

    it('status: deactivation bumps; reactivation and an unchanged status do not', async () => {
      const [user, colleague] = [await makeUser(), await makeUser()]
      expect(await globalEffectsOf([user, colleague], () => setUser('status', 'active', user)))
        .toEqual({ bumped: [0, 0], notified: [] })
      expect(await globalEffectsOf([user, colleague], () => setUser('status', 'deactivated', user)))
        .toEqual({ bumped: [1, 0], notified: [user] })
      expect(await globalEffectsOf([user, colleague], () => setUser('status', 'deactivated', user)))
        .toEqual({ bumped: [0, 0], notified: [] })
      expect(await globalEffectsOf([user, colleague], () => setUser('status', 'active', user)))
        .toEqual({ bumped: [0, 0], notified: [] })
    })

    it('every later reduction bumps again: revoke, re-grant, revoke, deactivate', async () => {
      const [user, colleague] = [await makeUser(), await makeUser()]
      await setUser('is_platform_admin', true, user)
      expect(await globalEffectsOf([user, colleague], () => setUser('is_platform_admin', false, user)))
        .toEqual({ bumped: [1, 0], notified: [user] })
      await setUser('is_platform_admin', true, user)
      expect(await globalEffectsOf([user, colleague], () => setUser('is_platform_admin', false, user)))
        .toEqual({ bumped: [1, 0], notified: [user] })
      expect(await globalEffectsOf([user, colleague], () => setUser('status', 'deactivated', user)))
        .toEqual({ bumped: [1, 0], notified: [user] })
      expect(await globalEpoch(user)).toBe(4)
    })

    it('a deleted user is bumped too, and the row outlives them', async () => {
      const [user, colleague] = [await makeUser(), await makeUser()]
      expect(await globalEffectsOf([user, colleague], () => db.pool.query('DELETE FROM users WHERE id = $1', [user])))
        .toEqual({ bumped: [1, 0], notified: [user] })
      expect(await globalEpoch(user)).toBe(2)
    })

    // QA lens round 2 (2026-10-17): the users trigger is created only when
    // missing, and no test booted twice — a check that never found the
    // existing trigger would fail EVERY boot after the first ("trigger already
    // exists"), and one that looked at any table of that name would skip a
    // schema whose neighbour already has it.
    it('a second boot is a no-op, and a neighbouring schema with the trigger does not stop this one getting it', async () => {
      await ensureEpochTriggers(db.pool)
      const { rows: [{ n }] } = await db.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_epoch_users' AND tgrelid = 'users'::regclass",
      )
      expect(n).toBe(1)
      const [user, colleague] = [await makeUser(), await makeUser()]
      expect(await globalEffectsOf([user, colleague], () => setUser('status', 'deactivated', user)))
        .toEqual({ bumped: [1, 0], notified: [user] })

      const neighbour = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'epoch_triggers_neighbour')
      try {
        await ensureAuthSchema(neighbour.pool)
        await ensureRbacSchema(neighbour.pool)
        await ensureEpochTriggers(neighbour.pool)
        const id = rid('user')
        await neighbour.pool.query("INSERT INTO users (id, issuer, subject, email) VALUES ($1, 'test', $1, $1 || '@example.com')", [id])
        await neighbour.pool.query("UPDATE users SET status = 'deactivated' WHERE id = $1", [id])
        const { rows } = await neighbour.pool.query<{ epoch: string }>('SELECT epoch FROM auth_global_epochs WHERE user_id = $1', [id])
        expect(rows.map((r) => Number(r.epoch))).toEqual([2])
      } finally {
        await neighbour.teardown()
      }
    })
  })

  describe('through startEpochRevocation (live sockets)', () => {
    async function withRevocation(
      run: (ctx: {
        registry: ConnectionRegistry
        onWorkspaceAccessChanged: ReturnType<typeof vi.fn>
        onEpochBumped: ReturnType<typeof vi.fn>
        onGlobalEpochBumped: ReturnType<typeof vi.fn>
      }) => Promise<void>,
      { pollMs = 50, auth = 'on' }: { pollMs?: number; auth?: 'on' | 'dual' } = {},
    ) {
      const savedAuth = process.env.AUTH
      const savedPoll = process.env.WS_AUTH_EPOCH_POLL_MS
      process.env.AUTH = auth
      process.env.WS_AUTH_EPOCH_POLL_MS = String(pollMs)
      const onWorkspaceAccessChanged = vi.fn()
      const onEpochBumped = vi.fn()
      const onGlobalEpochBumped = vi.fn()
      const registry = new ConnectionRegistry()
      const handle = startEpochRevocation(db.pool, registry, { onWorkspaceAccessChanged, onEpochBumped, onGlobalEpochBumped })
      try {
        // The LISTEN client connects asynchronously; wait until it hears a probe.
        const probeOrg = rid('probe')
        await vi.waitFor(async () => {
          await db.pool.query(`SELECT pg_notify('${GRANT}', $1)`, [probeOrg])
          expect(onWorkspaceAccessChanged).toHaveBeenCalledWith(probeOrg)
        }, { timeout: 3_000, interval: 50 })
        onWorkspaceAccessChanged.mockClear()
        await run({ registry, onWorkspaceAccessChanged, onEpochBumped, onGlobalEpochBumped })
      } finally {
        await handle.stop()
        if (savedAuth === undefined) delete process.env.AUTH
        else process.env.AUTH = savedAuth
        if (savedPoll === undefined) delete process.env.WS_AUTH_EPOCH_POLL_MS
        else process.env.WS_AUTH_EPOCH_POLL_MS = savedPoll
      }
    }

    /** A peer-bound socket (revocation walks peer-bound sockets only) carrying
     * the session a fresh sign-in would mint for (org, user) right now. */
    async function liveSocket(registry: ConnectionRegistry, orgId: string, userId: string) {
      const socket = { once: vi.fn(), close: vi.fn(), terminate: vi.fn(), readyState: 1 }
      registry.bind(socket as never, {
        userId,
        orgId,
        isPlatformAdmin: false,
        epoch: await orgEpoch(orgId),
        uepoch: await userEpoch([orgId, userId]),
      })
      registry.bindPeer(rid('peer'), socket as never)
      return socket
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300)) // several 50 ms polls

    it("an accept revokes nobody; a demotion closes the demoted user's socket and NOT the admin's who made it", async () => {
      await withRevocation(async ({ registry, onWorkspaceAccessChanged }) => {
        const orgId = await makeOrg()
        const owner = await makeUser()
        await addMember(orgId, owner, 'admin')
        const ownerSocket = await liveSocket(registry, orgId, owner)

        const guest = await makeUser()
        await addMember(orgId, guest, 'admin')
        // The grant reached the cache-drop hook (the process saw the commit)…
        await vi.waitFor(() => expect(onWorkspaceAccessChanged).toHaveBeenCalledWith(orgId), { timeout: 3_000, interval: 20 })
        const guestSocket = await liveSocket(registry, orgId, guest)
        await settle()
        expect(ownerSocket.close).not.toHaveBeenCalled()

        // The guest demotes the owner: the owner's socket closes, the guest's does not.
        onWorkspaceAccessChanged.mockClear()
        await db.pool.query("UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2", [orgId, owner])
        await vi.waitFor(() => expect(ownerSocket.close).toHaveBeenCalledWith(4001, expect.any(String)), { timeout: 3_000, interval: 20 })
        // The reduced user's cached allowed set is dropped too (coalesced to the
        // next turn of the event loop, hence the wait).
        await vi.waitFor(() => expect(onWorkspaceAccessChanged).toHaveBeenCalledWith(orgId), { timeout: 3_000, interval: 20 })
        await settle()
        expect(guestSocket.close).not.toHaveBeenCalled()
      })
    })

    it('the NOTIFY alone revokes within seconds — with the production 60 s poll — and tells the upgrade validator to forget', async () => {
      await withRevocation(async ({ registry, onEpochBumped }) => {
        const orgId = await makeOrg()
        const [owner, admin] = [await makeUser(), await makeUser()]
        await addMember(orgId, owner, 'admin')
        await addMember(orgId, admin, 'admin')
        const ownerSocket = await liveSocket(registry, orgId, owner)
        await db.pool.query("UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2", [orgId, owner])
        await vi.waitFor(() => expect(ownerSocket.close).toHaveBeenCalledWith(4001, expect.any(String)), { timeout: 2_000, interval: 20 })
        expect(onEpochBumped).toHaveBeenCalledWith(orgId, owner)
      }, { pollMs: 60_000 })
    })

    it('a socket opened AFTER the reduction, carrying the new epoch, is left alone poll after poll', async () => {
      await withRevocation(async ({ registry }) => {
        const orgId = await makeOrg()
        const user = await makeUser()
        await addMember(orgId, user, 'admin')
        await db.pool.query("UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2", [orgId, user])
        expect(await userEpoch([orgId, user])).toBe(2)
        const fresh = await liveSocket(registry, orgId, user) // signed in again: uepoch 2
        await settle()
        expect(fresh.close).not.toHaveBeenCalled()
      })
    })

    it("stage 'dual' observes a reduction but closes nothing", async () => {
      await withRevocation(async ({ registry }) => {
        const orgId = await makeOrg()
        const user = await makeUser()
        await addMember(orgId, user, 'admin')
        const socket = await liveSocket(registry, orgId, user)
        await db.pool.query("UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2", [orgId, user])
        await settle()
        expect(socket.close).not.toHaveBeenCalled()
        expect(socket.terminate).not.toHaveBeenCalled()
      }, { auth: 'dual' })
    })

    it('a per-user bump the LISTEN never delivered is caught by the poll', async () => {
      await withRevocation(async ({ registry }) => {
        const orgId = await makeOrg()
        const [user, colleague] = [await makeUser(), await makeUser()]
        await addMember(orgId, user, 'member')
        await addMember(orgId, colleague, 'member')
        const socket = await liveSocket(registry, orgId, user)
        const colleagueSocket = await liveSocket(registry, orgId, colleague)
        // A raw write: no trigger, no NOTIFY — only the poll can see it.
        await db.pool.query('INSERT INTO auth_user_epochs (org_id, user_id, epoch) VALUES ($1, $2, 2)', [orgId, user])
        await vi.waitFor(() => expect(socket.close).toHaveBeenCalledWith(4001, expect.any(String)), { timeout: 3_000, interval: 20 })
        expect(colleagueSocket.close).not.toHaveBeenCalled()
      })
    })

    it('an org-wide bump still closes every socket in the org', async () => {
      await withRevocation(async ({ registry }) => {
        const orgId = await makeOrg()
        const [a, b] = [await makeUser(), await makeUser()]
        await addMember(orgId, a, 'admin')
        await addMember(orgId, b, 'member')
        const sockets = [await liveSocket(registry, orgId, a), await liveSocket(registry, orgId, b)]
        await db.pool.query('SELECT bump_auth_epoch($1)', [orgId])
        for (const s of sockets) {
          await vi.waitFor(() => expect(s.close).toHaveBeenCalledWith(4001, expect.any(String)), { timeout: 3_000, interval: 20 })
        }
      })
    })

    /** A peer-bound socket carrying exactly `claims`. */
    function boundSocket(registry: ConnectionRegistry, claims: import('./tokens.js').SessionClaims) {
      const socket = { once: vi.fn(), close: vi.fn(), terminate: vi.fn(), readyState: 1 }
      registry.bind(socket as never, claims)
      registry.bindPeer(rid('peer'), socket as never)
      return socket
    }

    it("revoking platform admin closes the admin's sockets everywhere — org-less, in an org, and impersonations they started — and nobody else's", async () => {
      await withRevocation(async ({ registry, onGlobalEpochBumped }) => {
        const orgId = await makeOrg()
        const [admin, colleague, target] = [await makeUser(), await makeUser(), await makeUser()]
        await addMember(orgId, admin, 'admin')
        await addMember(orgId, colleague, 'admin')
        await addMember(orgId, target, 'member')
        await db.pool.query('UPDATE users SET is_platform_admin = true WHERE id = ANY($1::text[])', [[admin, colleague]])
        const orgless = boundSocket(registry, { userId: admin, orgId: null, isPlatformAdmin: true, epoch: 1, gepoch: 1 })
        const inOrg = await liveSocket(registry, orgId, admin)
        const impersonating = boundSocket(registry, {
          userId: target, orgId, isPlatformAdmin: false, epoch: await orgEpoch(orgId), uepoch: 1, imp: { by: admin, gepoch: 1 },
        })
        const colleagueOrgless = boundSocket(registry, { userId: colleague, orgId: null, isPlatformAdmin: true, epoch: 1 })
        const targetOwn = await liveSocket(registry, orgId, target)

        await db.pool.query('UPDATE users SET is_platform_admin = false WHERE id = $1', [admin])
        for (const s of [orgless, inOrg, impersonating]) {
          await vi.waitFor(() => expect(s.close).toHaveBeenCalledWith(4001, expect.any(String)), { timeout: 3_000, interval: 20 })
        }
        expect(onGlobalEpochBumped).toHaveBeenCalledWith(admin)
        await settle()
        expect(colleagueOrgless.close).not.toHaveBeenCalled()
        expect(targetOwn.close).not.toHaveBeenCalled()
      })
    })

    it('the global NOTIFY alone closes within seconds — with the production 60 s poll', async () => {
      await withRevocation(async ({ registry }) => {
        const user = await makeUser()
        const socket = boundSocket(registry, { userId: user, orgId: null, isPlatformAdmin: false, epoch: 1 }) // old cookie: no gepoch
        await db.pool.query("UPDATE users SET status = 'deactivated' WHERE id = $1", [user])
        await vi.waitFor(() => expect(socket.close).toHaveBeenCalledWith(4001, expect.any(String)), { timeout: 2_000, interval: 20 })
      }, { pollMs: 60_000 })
    })

    it('a global bump the LISTEN never delivered is caught by the poll; a session minted after it is left alone', async () => {
      await withRevocation(async ({ registry }) => {
        const [user, fresh] = [await makeUser(), await makeUser()]
        const stale = boundSocket(registry, { userId: user, orgId: null, isPlatformAdmin: false, epoch: 1 })
        const current = boundSocket(registry, { userId: fresh, orgId: null, isPlatformAdmin: false, epoch: 1, gepoch: 3 })
        // Raw writes: no trigger, no NOTIFY — only the poll can see them.
        await db.pool.query('INSERT INTO auth_global_epochs (user_id, epoch) VALUES ($1, 2), ($2, 3)', [user, fresh])
        await vi.waitFor(() => expect(stale.close).toHaveBeenCalledWith(4001, expect.any(String)), { timeout: 3_000, interval: 20 })
        await settle()
        expect(current.close).not.toHaveBeenCalled()
      })
    })

    it("the poll alone ends an impersonation whose impersonator holds no socket here, on the impersonator's own pin", async () => {
      await withRevocation(async ({ registry }) => {
        const [admin, target] = [await makeUser(), await makeUser()]
        const orgId = await makeOrg()
        await addMember(orgId, target, 'member')
        // The target's own global epoch is AHEAD of the impersonator's pin.
        await db.pool.query('INSERT INTO auth_global_epochs (user_id, epoch) VALUES ($1, 5)', [target])
        const imp = boundSocket(registry, {
          userId: target, orgId, isPlatformAdmin: false, epoch: await orgEpoch(orgId), uepoch: 1, gepoch: 5, imp: { by: admin, gepoch: 1 },
        })
        await settle()
        expect(imp.close).not.toHaveBeenCalled()
        // Raw write: no NOTIFY, only the poll can see it.
        await db.pool.query('INSERT INTO auth_global_epochs (user_id, epoch) VALUES ($1, 2)', [admin])
        await vi.waitFor(() => expect(imp.close).toHaveBeenCalledWith(4001, expect.any(String)), { timeout: 3_000, interval: 20 })
      })
    })

    it('the poll runs when a single user is live here', async () => {
      await withRevocation(async ({ registry }) => {
        const user = await makeUser()
        const socket = boundSocket(registry, { userId: user, orgId: null, isPlatformAdmin: false, epoch: 1 })
        await db.pool.query('INSERT INTO auth_global_epochs (user_id, epoch) VALUES ($1, 2)', [user])
        await vi.waitFor(() => expect(socket.close).toHaveBeenCalledWith(4001, expect.any(String)), { timeout: 3_000, interval: 20 })
      })
    })

    it('a global notify reaches onGlobalEpochBumped even when no socket of that user is held here (HTTP reads the same cache)', async () => {
      await withRevocation(async ({ onGlobalEpochBumped }) => {
        const user = await makeUser()
        await db.pool.query("UPDATE users SET status = 'deactivated' WHERE id = $1", [user])
        await vi.waitFor(() => expect(onGlobalEpochBumped).toHaveBeenCalledWith(user), { timeout: 3_000, interval: 20 })
      }, { pollMs: 60_000 })
    })

    it('a notify re-reads the epoch: a session already on the current global epoch is left alone', async () => {
      await withRevocation(async ({ registry, onGlobalEpochBumped }) => {
        const user = await makeUser()
        await db.pool.query('INSERT INTO auth_global_epochs (user_id, epoch) VALUES ($1, 2)', [user])
        const socket = boundSocket(registry, { userId: user, orgId: null, isPlatformAdmin: false, epoch: 1, gepoch: 2 })
        await db.pool.query(`SELECT pg_notify('${GLOBAL_REVOKE}', $1)`, [user])
        await vi.waitFor(() => expect(onGlobalEpochBumped).toHaveBeenCalledWith(user), { timeout: 3_000, interval: 20 })
        await settle()
        expect(socket.close).not.toHaveBeenCalled()
      }, { pollMs: 60_000 })
    })

    it("stage 'dual' observes a global bump but closes nothing", async () => {
      await withRevocation(async ({ registry }) => {
        const user = await makeUser()
        const socket = boundSocket(registry, { userId: user, orgId: null, isPlatformAdmin: false, epoch: 1 })
        await db.pool.query("UPDATE users SET status = 'deactivated' WHERE id = $1", [user])
        await settle()
        expect(socket.close).not.toHaveBeenCalled()
        expect(socket.terminate).not.toHaveBeenCalled()
      }, { auth: 'dual' })
    })
  })
})
