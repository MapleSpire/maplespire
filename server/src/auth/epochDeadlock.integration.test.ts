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
 * Concurrent permission writes against REAL Postgres triggers, driven in a
 * fixed interleaving so a lock-order inversion is a deterministic 40P01, not a
 * flake.
 *
 * Measured 2026-10-16 before any permission-write lock: the first two cases
 * were each a 40P01 — the first on the per-user epoch rows alone, the second on
 * user_effective_permissions alone (the epoch bump stubbed out). Both had been
 * masked by the org-row bump every permission write used to take. A per-org
 * lock taken in row triggers fixed those but left a statement spanning several
 * orgs ordered by its rows; the lock is now one, taken by statement triggers
 * before any row (rbac/schema.ts lock_permission_writes).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import type { PoolClient } from 'pg'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureAuthSchema } from './schema.js'
import { ensureRbacSchema, upsertLandscapeScope } from '../rbac/schema.js'
import { AUTH_TRIGGER_SCHEMA_VERSION, ensureEpochTriggers } from './wsAuth.js'
import { installLegacyEpochTriggersC520678ae } from './legacyEpochTriggers.testFixture.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('concurrent permission writes do not deadlock (live Postgres)', () => {
  let db: IsolatedSchemaDb
  let seq = 0
  const rid = (p: string) => `${p}-dl-${Date.now().toString(36)}-${++seq}`

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'epoch_deadlock')
    await ensureAuthSchema(db.pool)
    await ensureRbacSchema(db.pool)
    expect(await ensureEpochTriggers(db.pool)).toBe('installed')
    // The install records its version — what a later, older build compares with.
    const { rows } = await db.pool.query('SELECT version FROM auth_trigger_schema')
    expect(rows).toEqual([{ version: AUTH_TRIGGER_SCHEMA_VERSION }])
  })
  afterAll(async () => {
    await db?.teardown()
  })

  async function q(sql: string, params: unknown[] = []) {
    return db.pool.query(sql, params)
  }

  async function makeUser(name: string): Promise<string> {
    const id = rid(`user-${name}`)
    await q("INSERT INTO users (id, issuer, subject, email) VALUES ($1, 'test', $1, $1 || '@example.com')", [id])
    return id
  }

  /** An org with users, teams (with members) and one landscape scope per key. */
  async function fixture(teams: Record<string, string[]>, scopeKeys: string[]) {
    const orgId = rid('org')
    await q('INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1)', [orgId])
    const users = new Map<string, string>()
    for (const name of new Set(Object.values(teams).flat())) {
      const id = await makeUser(name)
      users.set(name, id)
      await q("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, id])
    }
    const teamIds = new Map<string, string>()
    for (const [name, members] of Object.entries(teams)) {
      const id = rid(`team-${name}`)
      teamIds.set(name, id)
      await q('INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $1)', [id, orgId])
      for (const m of members) await q('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)', [id, users.get(m)])
    }
    const scopes = new Map<string, string>()
    for (const key of scopeKeys) scopes.set(key, await upsertLandscapeScope(db.pool, orgId, rid(`L-${key}`)))
    return { orgId, users, teamIds, scopes }
  }

  type Step = [string, unknown[]]

  /**
   * Wait until backend `pid` is blocked on a lock, and say which kind. A fixed
   * pause is not enough: if T2 has not reached the server when T1 continues,
   * the run is T1, T1, T2, T2 — no inversion, green with or without the fix
   * (reviewer lens, 2026-10-16). Every case below is built so T2 MUST block on
   * something held by T1; this makes that a checked precondition.
   */
  async function waitUntilBlocked(pid: number): Promise<string> {
    for (let i = 0; i < 200; i++) {
      const { rows } = await db.pool.query<{ wait_event_type: string | null; wait_event: string | null }>(
        'SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1',
        [pid],
      )
      if (rows[0]?.wait_event_type === 'Lock') return rows[0].wait_event ?? 'unknown'
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`T2 (pid ${pid}) never blocked: the interleaving did not happen, the case proves nothing`)
  }

  /**
   * T1 runs its first step; T2 then runs ALL its steps as one chain, which
   * blocks somewhere behind T1 — on the permission-write lock when writes are
   * serialized (`advisory`), else on a row T1 holds, after which T1's next
   * step closes the cycle. T1 continues only once T2 is verifiably blocked.
   * Returns how each transaction ended and what T2 waited on.
   */
  async function interleave(t1: Step[], t2: Step[]) {
    const c1: PoolClient = await db.pool.connect()
    const c2: PoolClient = await db.pool.connect()
    const { rows: pidRows } = await c2.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    const run = async (client: PoolClient, steps: Step[]) => {
      try {
        for (const step of steps) await client.query(...step)
        await client.query('COMMIT')
        return 'committed'
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        return (err as { code?: string }).code ?? String(err)
      }
    }
    try {
      await c1.query('BEGIN')
      await c2.query('BEGIN')
      await c1.query(...t1[0])
      const second = run(c2, t2)
      const t2WaitedOn = await waitUntilBlocked(pidRows[0].pid)
      const first = run(c1, t1.slice(1))
      return { ends: await Promise.all([first, second]), t2WaitedOn }
    } finally {
      c1.release()
      c2.release()
    }
  }

  /** Run `write` in an open transaction, then report whether THAT transaction
   * holds the permission-write lock — read from pg_locks for its own backend,
   * not probed with a timeout: advisory locks are database-wide, and the
   * DB-gated suites run in parallel in one database, so another suite holding
   * the key would make a probe lie both ways (reviewer lens, 2026-10-17). */
  async function heldAfter(write: Step): Promise<boolean> {
    const c1: PoolClient = await db.pool.connect()
    try {
      const { rows: pidRows } = await c1.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await c1.query('BEGIN')
      await c1.query(...write)
      // A bigint advisory key is stored as classid = high 32 bits, objid = low 32 bits, objsubid = 1.
      const { rows } = await db.pool.query<{ held: boolean }>(
        `WITH k AS (SELECT hashtextextended('auth-permission-writes', 0) AS key)
         SELECT EXISTS (
           SELECT 1 FROM pg_locks l, k
           WHERE l.pid = $1 AND l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
             AND l.classid::bigint = ((k.key >> 32) & 4294967295)
             AND l.objid::bigint = (k.key & 4294967295)
         ) AS held`,
        [pidRows[0].pid],
      )
      return rows[0].held
    } finally {
      await c1.query('ROLLBACK').catch(() => {})
      c1.release()
    }
  }

  const grant = 'INSERT INTO team_scope_permissions (team_id, scope_id, resource_type, can_read, can_write) VALUES ($1, $2, \'*\', true, true)'
  const narrow = 'UPDATE team_scope_permissions SET can_write = false WHERE team_id = $1 AND scope_id = $2'

  /** Case 1: grants narrowed in opposite order over shared members (per-user epoch rows). */
  async function oppositeNarrowing() {
    const f = await fixture({ X: ['a'], Y: ['b'] }, ['s1', 's2', 's3', 's4'])
    const [X, Y] = [f.teamIds.get('X')!, f.teamIds.get('Y')!]
    const [s1, s2, s3, s4] = ['s1', 's2', 's3', 's4'].map((k) => f.scopes.get(k)!)
    for (const [t, s] of [[X, s1], [Y, s2], [Y, s3], [X, s4]]) await q(grant, [t, s])
    return interleave(
      [[narrow, [X, s1]], [narrow, [Y, s2]]],
      [[narrow, [Y, s3]], [narrow, [X, s4]]],
    )
  }

  it('two transactions narrowing different grants, in opposite order, over shared members, both commit', async () => {
    // X = {a}, Y = {b}. T1 narrows X then Y, T2 narrows Y then X (different
    // scopes, so no permission row is shared). Each user's revocation is written
    // by both transactions, in opposite orders.
    const { ends, t2WaitedOn } = await oppositeNarrowing()
    expect(ends).toEqual(['committed', 'committed'])
    expect(t2WaitedOn).toBe('advisory') // serialized on the permission-write lock, not luck
  })

  it('the same interleaving over the SAME scope (shared effective-permission rows) also commits both', async () => {
    // X = {a}, Y = {b}, W = {b}, Z = {a}; T1 narrows X/s then Y/t, T2 narrows
    // W/t then Z/s: the effective-permission rows (a,s) and (b,t) are taken in
    // opposite orders.
    const f = await fixture({ X: ['a'], Y: ['b'], W: ['b'], Z: ['a'] }, ['s', 't'])
    const t = (n: string) => f.teamIds.get(n)!
    const [s, tt] = [f.scopes.get('s')!, f.scopes.get('t')!]
    for (const [team, scope] of [[t('X'), s], [t('Y'), tt], [t('W'), tt], [t('Z'), s]]) await q(grant, [team, scope])

    const { ends, t2WaitedOn } = await interleave(
      [[narrow, [t('X'), s]], [narrow, [t('Y'), tt]]],
      [[narrow, [t('W'), tt]], [narrow, [t('Z'), s]]],
    )
    expect(ends).toEqual(['committed', 'committed'])
    expect(t2WaitedOn).toBe('advisory')
  })

  it('concurrent GRANTS in the same inverted order also commit both (they recompute the same effective-permission rows)', async () => {
    const f = await fixture({ X: ['a'], Y: ['b'], W: ['b'], Z: ['a'] }, ['s', 't'])
    const t = (n: string) => f.teamIds.get(n)!
    const [s, tt] = [f.scopes.get('s')!, f.scopes.get('t')!]
    const { ends, t2WaitedOn } = await interleave(
      [[grant, [t('X'), s]], [grant, [t('Y'), tt]]],
      [[grant, [t('W'), tt]], [grant, [t('Z'), s]]],
    )
    expect(ends).toEqual(['committed', 'committed'])
    expect(t2WaitedOn).toBe('advisory')
  })

  it("the access-matrix save's shape — the lock taken BEFORE its rows — commits both batches over the same grant rows", async () => {
    // PUT /api/orgs/:orgId/access locks each grant row (FOR UPDATE, which fires
    // no trigger) in the order the client sent. Two batches over the same rows
    // in opposite order invert on the rows themselves unless the lock comes first.
    const f = await fixture({ X: ['a'], Y: ['b'] }, ['s'])
    const [X, Y] = [f.teamIds.get('X')!, f.teamIds.get('Y')!]
    const s = f.scopes.get('s')!
    for (const team of [X, Y]) await q(grant, [team, s])
    const lock: Step = ['SELECT lock_permission_writes()', []]
    const forUpdate = 'SELECT 1 FROM team_scope_permissions WHERE team_id = $1 AND scope_id = $2 FOR UPDATE'
    const { ends, t2WaitedOn } = await interleave(
      [lock, [forUpdate, [X, s]], [narrow, [X, s]], [forUpdate, [Y, s]], [narrow, [Y, s]]],
      [lock, [forUpdate, [Y, s]], [narrow, [Y, s]], [forUpdate, [X, s]], [narrow, [X, s]]],
    )
    expect(ends).toEqual(['committed', 'committed'])
    expect(t2WaitedOn).toBe('advisory')
  })

  it('A STATEMENT SPANNING TWO ORGS waits for the lock before locking any of its rows', async () => {
    // u belongs to orgs A and B; v to B. T1 updates (B, v), then (A, u). T2 is
    // ONE statement over u's rows in both orgs. With a lock taken in row
    // triggers, T2 locked (A,u) and (B,u) first and then waited for T1 — and
    // T1's next step wanted (A,u): 40P01. Taken by a statement trigger, T2
    // waits for the lock holding no row at all.
    const A = await fixture({ X: ['u'] }, [])
    const B = await fixture({ X: ['v'] }, [])
    const u = A.users.get('u')!
    const v = B.users.get('v')!
    await q("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [B.orgId, u])
    const setRole = "UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2"
    const { ends, t2WaitedOn } = await interleave(
      [[setRole, [B.orgId, v]], [setRole, [A.orgId, u]]],
      [["UPDATE org_members SET role = 'admin' WHERE user_id = $1", [u]]],
    )
    expect(ends).toEqual(['committed', 'committed'])
    expect(t2WaitedOn).toBe('advisory')
  })

  // Lock coverage per writer (QA lens, 2026-10-16: removing the lock from one
  // table's trigger left every other case green).
  it('every permission write holds the lock: org_members, team_members, grants', async () => {
    const f = await fixture({ X: ['a', 'b'], Y: ['c'] }, ['s'])
    const u = await makeUser('n')
    expect(await heldAfter(["INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [f.orgId, u]])).toBe(true)
    expect(await heldAfter(['DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [f.orgId, f.users.get('a')]])).toBe(true)
    expect(await heldAfter(["UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2", [f.orgId, f.users.get('a')]])).toBe(true)
    expect(await heldAfter(['INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)', [f.teamIds.get('Y'), f.users.get('a')]])).toBe(true)
    expect(await heldAfter(['DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [f.teamIds.get('X'), f.users.get('a')]])).toBe(true)
    expect(await heldAfter([grant, [f.teamIds.get('X'), f.scopes.get('s')]])).toBe(true)
    await q(grant, [f.teamIds.get('X'), f.scopes.get('s')])
    expect(await heldAfter([narrow, [f.teamIds.get('X'), f.scopes.get('s')]])).toBe(true)
    // Each event, not one per table (QA lens, 2026-10-17: UPDATE on
    // team_members and DELETE on grants were never written).
    expect(await heldAfter(['UPDATE team_members SET team_id = $1 WHERE team_id = $2 AND user_id = $3', [f.teamIds.get('Y'), f.teamIds.get('X'), f.users.get('b')]])).toBe(true)
    expect(await heldAfter(['DELETE FROM team_scope_permissions WHERE team_id = $1 AND scope_id = $2', [f.teamIds.get('X'), f.scopes.get('s')]])).toBe(true)
  })

  it('so does a statement that changes NO row (the lock is per statement, before any row)', async () => {
    expect(await heldAfter(['DELETE FROM team_members WHERE team_id = $1', ['no-such-team']])).toBe(true)
  })

  it('deletes that cascade into permission rows hold the lock: a team, a scope, an org, a user', async () => {
    const f = await fixture({ X: ['a'] }, ['s'])
    await q(grant, [f.teamIds.get('X'), f.scopes.get('s')])
    expect(await heldAfter(['DELETE FROM teams WHERE id = $1', [f.teamIds.get('X')]])).toBe(true)
    expect(await heldAfter(['DELETE FROM scopes WHERE id = $1', [f.scopes.get('s')]])).toBe(true)
    expect(await heldAfter(['DELETE FROM orgs WHERE id = $1', [f.orgId]])).toBe(true)
    expect(await heldAfter(['DELETE FROM users WHERE id = $1', [f.users.get('a')]])).toBe(true)
  })

  it('a team delete takes the lock BEFORE its own row: a writer adding a member to that team, holding the lock, does not deadlock', async () => {
    // T1 holds the lock (a grant), then adds a member to team X: the foreign
    // key takes KEY SHARE on X's row. T2 deletes X. Locked only by the cascade
    // into team_members, T2 would hold X's row exclusively while waiting for
    // the lock — and T1's insert would wait for X's row: 40P01. The teams
    // statement trigger makes T2 wait for the lock holding no row.
    const f = await fixture({ X: ['a'], Y: ['b'] }, ['s'])
    const { ends, t2WaitedOn } = await interleave(
      [[grant, [f.teamIds.get('Y'), f.scopes.get('s')]], ['INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)', [f.teamIds.get('X'), f.users.get('b')]]],
      [['DELETE FROM teams WHERE id = $1', [f.teamIds.get('X')]]],
    )
    expect(ends).toEqual(['committed', 'committed'])
    expect(t2WaitedOn).toBe('advisory')
  })

  // The same order check for every delete that cascades into permission rows
  // (QA lens, 2026-10-17: with only the CHILD tables' statement triggers, the
  // lock was still held — but after the parent row, and each case was a 40P01).
  it('a scope delete takes the lock BEFORE its own row (vs. a writer granting on that scope)', async () => {
    const f = await fixture({ X: ['a'], Y: ['b'] }, ['s', 's2'])
    const { ends, t2WaitedOn } = await interleave(
      [[grant, [f.teamIds.get('Y'), f.scopes.get('s2')]], [grant, [f.teamIds.get('X'), f.scopes.get('s')]]],
      [['DELETE FROM scopes WHERE id = $1', [f.scopes.get('s')]]],
    )
    expect(ends).toEqual(['committed', 'committed'])
    expect(t2WaitedOn).toBe('advisory')
  })

  it('an org delete takes the lock BEFORE its own row (vs. a writer adding a member to that org)', async () => {
    const A = await fixture({ X: ['a'] }, [])
    const B = await fixture({ X: ['b'] }, ['s'])
    const n = await makeUser('n')
    const { ends, t2WaitedOn } = await interleave(
      [[grant, [B.teamIds.get('X'), B.scopes.get('s')]], ["INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [A.orgId, n]]],
      [['DELETE FROM orgs WHERE id = $1', [A.orgId]]],
    )
    // T1 commits its membership first; T2's cascade then removes it.
    expect(ends).toEqual(['committed', 'committed'])
    expect(t2WaitedOn).toBe('advisory')
  })

  it('a user delete takes the lock BEFORE its own row (vs. a writer adding that user to an org)', async () => {
    const A = await fixture({ X: ['a'] }, [])
    const B = await fixture({ Y: ['b'] }, ['s'])
    const u = await makeUser('u')
    const { ends, t2WaitedOn } = await interleave(
      [[grant, [B.teamIds.get('Y'), B.scopes.get('s')]], ["INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')", [A.orgId, u]]],
      [['DELETE FROM users WHERE id = $1', [u]]],
    )
    // T1 commits its membership first; T2's cascade then removes it.
    expect(ends).toEqual(['committed', 'committed'])
    expect(t2WaitedOn).toBe('advisory')
  })

  // `users` carries TWO triggers of this system: the global-epoch bump (AFTER
  // UPDATE OR DELETE, from the platform-admin revocation work) and this lock
  // (BEFORE DELETE). They must coexist: a delete fires both, an update only theirs.
  it('a user delete fires both triggers on users: the permission lock is held AND the global epoch is bumped', async () => {
    const f = await fixture({ X: ['a'] }, [])
    const u = f.users.get('a')!
    expect(await heldAfter(['DELETE FROM users WHERE id = $1', [u]])).toBe(true)
    await q('DELETE FROM users WHERE id = $1', [u])
    const { rows } = await q('SELECT epoch FROM auth_global_epochs WHERE user_id = $1', [u])
    expect(rows.map((r: { epoch: string }) => Number(r.epoch))).toEqual([2])
  })

  it('revoking platform admin bumps the global epoch and does NOT take the permission lock (only their trigger fires)', async () => {
    const f = await fixture({ X: ['a'] }, [])
    const u = f.users.get('a')!
    await q('UPDATE users SET is_platform_admin = true WHERE id = $1', [u])
    expect(await heldAfter(['UPDATE users SET is_platform_admin = false WHERE id = $1', [u]])).toBe(false)
    await q('UPDATE users SET is_platform_admin = false WHERE id = $1', [u])
    const { rows } = await q('SELECT epoch FROM auth_global_epochs WHERE user_id = $1', [u])
    expect(rows.map((r: { epoch: string }) => Number(r.epoch))).toEqual([2])
  })

  it('updates of users and orgs that are not permission writes do NOT take it (a sign-in stamps users.last_org_id)', async () => {
    const f = await fixture({ X: ['a'] }, [])
    expect(await heldAfter(["UPDATE users SET name = 'x' WHERE id = $1", [f.users.get('a')]])).toBe(false)
    expect(await heldAfter(["UPDATE orgs SET name = 'x' WHERE id = $1", [f.orgId]])).toBe(false)
  })

  it('deleting a team revokes every member (its cascade sees no team row)', async () => {
    const f = await fixture({ X: ['a', 'b'], Y: ['c'] }, [])
    const epochOf = async (name: string) => {
      const { rows } = await q('SELECT epoch FROM auth_user_epochs WHERE org_id = $1 AND user_id = $2', [f.orgId, f.users.get(name)])
      return rows[0] ? Number(rows[0].epoch) : 1
    }
    await q('DELETE FROM teams WHERE id = $1', [f.teamIds.get('X')])
    expect([await epochOf('a'), await epochOf('b'), await epochOf('c')]).toEqual([2, 2, 1])
  })

  it('team-member removals in opposite order over shared users both commit', async () => {
    const f = await fixture({ X: ['a'], Y: ['b'], X2: ['a'], Y2: ['b'] }, [])
    const t = (n: string) => f.teamIds.get(n)!
    const del = 'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2'
    const { ends, t2WaitedOn } = await interleave(
      [[del, [t('X'), f.users.get('a')]], [del, [t('Y'), f.users.get('b')]]],
      [[del, [t('Y2'), f.users.get('b')]], [del, [t('X2'), f.users.get('a')]]],
    )
    expect(ends).toEqual(['committed', 'committed'])
    expect(t2WaitedOn).toBe('advisory')
  })

  it('an org-member removal and a team-member removal, in opposite order over shared users, both commit', async () => {
    const f = await fixture({ X: ['a'], Y: ['b'] }, [])
    const om = 'DELETE FROM org_members WHERE org_id = $1 AND user_id = $2'
    const tm = 'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2'
    const { ends, t2WaitedOn } = await interleave(
      [[om, [f.orgId, f.users.get('a')]], [tm, [f.teamIds.get('Y'), f.users.get('b')]]],
      [[om, [f.orgId, f.users.get('b')]], [tm, [f.teamIds.get('X'), f.users.get('a')]]],
    )
    expect(ends).toEqual(['committed', 'committed'])
    expect(t2WaitedOn).toBe('advisory')
  })

  it('the lock is ONE for all orgs (the price of covering multi-org statements): a write in org A waits for one in org B', async () => {
    const A = await fixture({ X: ['a'] }, [])
    const B = await fixture({ X: ['b'] }, [])
    const setRole = "UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2"
    const { ends, t2WaitedOn } = await interleave(
      [[setRole, [A.orgId, A.users.get('a')]], ['SELECT 1', []]],
      [[setRole, [B.orgId, B.users.get('b')]]],
    )
    expect(ends).toEqual(['committed', 'committed'])
    expect(t2WaitedOn).toBe('advisory')
  })

  describe('rolling deploy', () => {
    async function triggersOn(table: string): Promise<string[]> {
      const { rows } = await q(
        'SELECT tgname FROM pg_trigger WHERE tgrelid = to_regclass($1) AND NOT tgisinternal ORDER BY tgname',
        [table],
      )
      return rows.map((r: { tgname: string }) => r.tgname)
    }

    it('an OLD build re-installing its triggers mid-deploy cannot remove the lock; the next new boot retires them', async () => {
      // The deployed build before this rework (c520678ae), booting after us.
      await installLegacyEpochTriggersC520678ae(db.pool)
      // And the one trigger only the unreleased per-org build (08e093c30) had:
      // its function must go too, which a DROP FUNCTION without CASCADE can only
      // do once the trigger is gone (QA lens, 2026-10-17).
      await q(`CREATE OR REPLACE FUNCTION trg_bump_epoch_teams_delete() RETURNS trigger AS $body$
               BEGIN RETURN OLD; END; $body$ LANGUAGE plpgsql`)
      await q('CREATE TRIGGER trg_epoch_teams_delete BEFORE DELETE ON teams FOR EACH ROW EXECUTE FUNCTION trg_bump_epoch_teams_delete()')
      expect(await triggersOn('org_members')).toEqual(['trg_auth_lock_writes', 'trg_auth_revoke', 'trg_epoch_org_members'])

      // The lock still holds, and the measured deadlock still does not happen.
      const f = await fixture({ X: ['a'] }, [])
      expect(await heldAfter(["UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2", [f.orgId, f.users.get('a')]])).toBe(true)
      const { ends, t2WaitedOn } = await oppositeNarrowing()
      expect(ends).toEqual(['committed', 'committed'])
      expect(t2WaitedOn).toBe('advisory')

      // The next boot of this build retires the old names and their functions.
      expect(await ensureEpochTriggers(db.pool)).toBe('installed')
      expect(await triggersOn('org_members')).toEqual(['trg_auth_lock_writes', 'trg_auth_revoke'])
      expect(await triggersOn('team_members')).not.toContain('trg_epoch_team_members')
      expect(await triggersOn('team_scope_permissions')).not.toContain('trg_epoch_tsp')
      expect(await triggersOn('teams')).toEqual(['trg_auth_lock_writes', 'trg_auth_revoke'])
      // The four functions of the builds before the rework are gone — by NAME:
      // the global-epoch function `trg_bump_epoch_users` shares the prefix and
      // must survive (it is current, not legacy).
      const { rows } = await q(
        `SELECT proname FROM pg_proc WHERE proname = ANY($1::text[]) ORDER BY proname`,
        [['trg_bump_epoch_org_members', 'trg_bump_epoch_team_members', 'trg_bump_epoch_tsp', 'trg_bump_epoch_teams_delete']],
      )
      expect(rows).toEqual([])
      expect(await triggersOn('users')).toEqual(['trg_auth_lock_writes', 'trg_epoch_users'])
    })

    it('a boot with nothing changed is a no-op: no DDL, so it does not queue behind a sign-in holding users', async () => {
      // DROP TRIGGER takes ACCESS EXCLUSIVE; an open transaction that touched
      // users (a sign-in stamping last_org_id) would make a reinstall wait.
      const f = await fixture({ X: ['a'] }, [])
      const signIn = await db.pool.connect()
      try {
        await signIn.query('BEGIN')
        await signIn.query("UPDATE users SET name = 'signed-in' WHERE id = $1", [f.users.get('a')])
        const boot = ensureEpochTriggers(db.pool)
        const outcome = await Promise.race([boot, new Promise((resolve) => setTimeout(() => resolve('blocked'), 3_000))])
        expect(outcome).toBe('up-to-date')
      } finally {
        await signIn.query('ROLLBACK').catch(() => {})
        signIn.release()
      }
    })

    it('an install that must run (changed fingerprint) issues no DDL on users or orgs, which every sign-in reads', async () => {
      const f = await fixture({ X: ['a'] }, [])
      await q("UPDATE auth_trigger_schema SET ddl_hash = 'an-older-installer'")
      const signIn = await db.pool.connect()
      try {
        await signIn.query('BEGIN')
        await signIn.query("UPDATE users SET name = 'signed-in' WHERE id = $1", [f.users.get('a')])
        await signIn.query("UPDATE orgs SET name = 'renamed' WHERE id = $1", [f.orgId])
        const boot = ensureEpochTriggers(db.pool)
        const outcome = await Promise.race([boot, new Promise((resolve) => setTimeout(() => resolve('blocked'), 3_000))])
        expect(outcome).toBe('installed')
      } finally {
        await signIn.query('ROLLBACK').catch(() => {})
        signIn.release()
      }
    })

    it('the global-epoch trigger on users (trg_epoch_users) is repaired when missing, and left alone otherwise', async () => {
      await q('DROP TRIGGER trg_epoch_users ON users')
      expect(await ensureEpochTriggers(db.pool)).toBe('installed')
      expect(await triggersOn('users')).toEqual(['trg_auth_lock_writes', 'trg_epoch_users'])
      expect(await ensureEpochTriggers(db.pool)).toBe('up-to-date')
    })

    it('a trigger with the right name but the wrong events or function is replaced, not trusted', async () => {
      // "Create only when missing" must not mean "trust whatever has the name":
      // a lock trigger that misses DELETE, or whose function does nothing,
      // would leave writes unserialized with every other check green.
      await q('DROP TRIGGER trg_auth_lock_writes ON team_members')
      await q('CREATE TRIGGER trg_auth_lock_writes BEFORE INSERT ON team_members FOR EACH STATEMENT EXECUTE FUNCTION auth_lock_permission_writes()')
      await q('DROP TRIGGER trg_auth_lock_writes ON team_scope_permissions')
      await q('CREATE OR REPLACE FUNCTION zz_noop_stmt() RETURNS trigger AS $body$ BEGIN RETURN NULL; END; $body$ LANGUAGE plpgsql')
      await q('CREATE TRIGGER trg_auth_lock_writes BEFORE INSERT OR UPDATE OR DELETE ON team_scope_permissions FOR EACH STATEMENT EXECUTE FUNCTION zz_noop_stmt()')
      await q("UPDATE auth_trigger_schema SET ddl_hash = 'drift'")
      expect(await ensureEpochTriggers(db.pool)).toBe('installed')
      const f = await fixture({ X: ['a'] }, [])
      expect(await heldAfter(['DELETE FROM team_members WHERE team_id = $1', [f.teamIds.get('X')]])).toBe(true)
      expect(await heldAfter(['DELETE FROM team_scope_permissions WHERE team_id = $1', [f.teamIds.get('X')]])).toBe(true)
      await q('DROP FUNCTION zz_noop_stmt()')
    })

    it('the installer takes its table locks parents-first: blocked on table N, it holds exactly tables 0..N-1', async () => {
      // A hard delete cascades users -> orgs -> scopes -> teams -> memberships;
      // an installer that took the same locks in another order could deadlock
      // with one (reasoned by the reviewer of the trg_epoch_users change;
      // pinned here by blocking it at each table in turn).
      const order = ['users', 'orgs', 'scopes', 'teams', 'org_members', 'team_members', 'team_scope_permissions']
      const installer = guardIdleClientErrors(
        new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1, options: `-c search_path=${db.schema}` }),
        'epochDeadlock:installer'
      )
      try {
        const probe = await installer.connect()
        let pid: number
        try {
          pid = (await probe.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
        } finally {
          // A throw here would otherwise leave the client checked out and make installer.end() never resolve.
          probe.release()
        }
        for (let blockedAt = 1; blockedAt < order.length; blockedAt++) {
          // The state of a first install: none of this build's triggers exist.
          for (const table of order) await q(`DROP TRIGGER IF EXISTS trg_auth_lock_writes ON ${table}`)
          for (const table of ['teams', 'org_members', 'team_members', 'team_scope_permissions']) {
            await q(`DROP TRIGGER IF EXISTS trg_auth_revoke ON ${table}`)
          }
          const blocker = await db.pool.connect()
          try {
            await blocker.query('BEGIN')
            await blocker.query(`LOCK TABLE ${order[blockedAt]} IN ACCESS EXCLUSIVE MODE`)
            const boot = ensureEpochTriggers(installer)
            await waitUntilBlocked(pid)
            const { rows } = await db.pool.query<{ relname: string; granted: boolean }>(
              `SELECT c.relname, l.granted FROM pg_locks l
               JOIN pg_class c ON c.oid = l.relation
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE l.pid = $1 AND l.locktype = 'relation' AND n.nspname = $2
                 AND c.relname <> 'auth_trigger_schema'
                 -- what it HOLDS: the DDL locks. What it WAITS on: any mode (the
                 -- relation lookup of DROP TRIGGER waits as AccessShareLock).
                 AND (NOT l.granted OR l.mode IN ('AccessExclusiveLock', 'ShareRowExclusiveLock'))`,
              [pid, db.schema],
            )
            expect(rows.filter((r) => !r.granted).map((r) => r.relname)).toEqual([order[blockedAt]])
            expect(rows.filter((r) => r.granted).map((r) => r.relname).sort()).toEqual(order.slice(0, blockedAt).sort())
            await blocker.query('ROLLBACK')
            expect(await boot).toBe('installed')
          } finally {
            await blocker.query('ROLLBACK').catch(() => {})
            blocker.release()
          }
        }
      } finally {
        await installer.end()
      }
    })

    it('a changed installer is installed even at the same version (its code fingerprint differs)', async () => {
      await q("UPDATE auth_trigger_schema SET ddl_hash = 'an-older-installer'")
      expect(await ensureEpochTriggers(db.pool)).toBe('installed')
      expect(await ensureEpochTriggers(db.pool)).toBe('up-to-date')
    })

    it('the lock bounds a holder that goes idle: its transaction gets idle_in_transaction_session_timeout = 30s', async () => {
      const c = await db.pool.connect()
      try {
        await c.query('BEGIN')
        await c.query('SELECT lock_permission_writes()')
        const { rows } = await c.query('SHOW idle_in_transaction_session_timeout')
        expect(rows[0].idle_in_transaction_session_timeout).toBe('30s')
      } finally {
        await c.query('ROLLBACK').catch(() => {})
        c.release()
      }
    })

    it('a build OLDER than the installed trigger set leaves it alone (never downgrades)', async () => {
      await q('UPDATE auth_trigger_schema SET version = $1', [AUTH_TRIGGER_SCHEMA_VERSION + 1])
      // Stand-in for "the newer set differs": one of our triggers is absent.
      await q('DROP TRIGGER trg_auth_lock_writes ON org_members')
      try {
        expect(await ensureEpochTriggers(db.pool)).toBe('skipped-newer')
        expect(await triggersOn('org_members')).not.toContain('trg_auth_lock_writes')
      } finally {
        await q('UPDATE auth_trigger_schema SET version = $1', [AUTH_TRIGGER_SCHEMA_VERSION])
        expect(await ensureEpochTriggers(db.pool)).toBe('installed')
      }
      expect(await triggersOn('org_members')).toContain('trg_auth_lock_writes')
      const { rows } = await q('SELECT version FROM auth_trigger_schema')
      expect(rows).toEqual([{ version: AUTH_TRIGGER_SCHEMA_VERSION }])
    })
  })
})
