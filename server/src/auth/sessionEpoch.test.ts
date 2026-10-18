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

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { SessionClaims } from './tokens.js'
import {
  createSessionEpochValidator,
  currentGlobalEpoch,
  currentOrgEpoch,
  currentUserEpoch,
  isSessionEpochCurrent,
  mintRefusalBody,
  SessionMintRefusedError,
  sharedSessionEpochValidator,
} from './sessionEpoch.js'

const claims: SessionClaims = {
  userId: 'user-1',
  orgId: 'org-1',
  isPlatformAdmin: false,
  epoch: 7,
  uepoch: 3,
}

type Rows = { rows: Array<{ epoch: string }> }
const row = (epoch: number | null): Rows => ({ rows: epoch === null ? [] : [{ epoch: String(epoch) }] })

/** A pool that answers the org, per-user and global tables separately.
 * `global` is one value for every user, or a value per user id (absent = no row). */
function fakeDb(epochs: { org: number | null; user: number | null; global?: number | null | Record<string, number> }) {
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<Rows> => {
    if (sql.includes('auth_global_epochs')) {
      const g = epochs.global ?? null
      return row(typeof g === 'object' && g !== null ? (g[params[0] as string] ?? null) : g)
    }
    if (sql.includes('auth_user_epochs')) return row(epochs.user)
    if (sql.includes('auth_epochs')) return row(epochs.org)
    throw new Error(`unexpected query: ${sql}`)
  })
  const count = (table: 'auth_epochs' | 'auth_user_epochs' | 'auth_global_epochs') =>
    query.mock.calls.filter(([sql]) => sql.split(/\W+/).includes(table)).length
  return { query, count }
}

describe('session authorization epochs', () => {
  it('coerces PostgreSQL BIGINT strings and defaults an absent row to epoch 1 — for the org and the user', async () => {
    const withRows = fakeDb({ org: 7, user: 3 })
    const without = fakeDb({ org: null, user: null })
    await expect(currentOrgEpoch(withRows as never, 'org-1')).resolves.toBe(7)
    await expect(currentUserEpoch(withRows as never, 'org-1', 'user-1')).resolves.toBe(3)
    await expect(currentOrgEpoch(without as never, 'org-new')).resolves.toBe(1)
    await expect(currentUserEpoch(without as never, 'org-new', 'user-1')).resolves.toBe(1)
    await expect(currentGlobalEpoch(fakeDb({ org: 7, user: 3, global: 5 }) as never, 'user-1')).resolves.toBe(5)
    await expect(currentGlobalEpoch(without as never, 'user-1')).resolves.toBe(1)
  })

  it('reads the per-user epoch for exactly (org, user)', async () => {
    const db = fakeDb({ org: 7, user: 3 })
    await currentUserEpoch(db as never, 'org-1', 'user-1')
    expect(db.query).toHaveBeenCalledWith(
      'SELECT epoch FROM auth_user_epochs WHERE org_id = $1 AND user_id = $2',
      ['org-1', 'user-1'],
    )
  })

  it('rejects a session once the ORG epoch advances (an org-wide event)', async () => {
    await expect(isSessionEpochCurrent(fakeDb({ org: 8, user: 3 }) as never, claims)).resolves.toBe(false)
  })

  it("rejects a session once THIS USER's epoch in the org advances (their access was reduced)", async () => {
    await expect(isSessionEpochCurrent(fakeDb({ org: 7, user: 4 }) as never, claims)).resolves.toBe(false)
  })

  it('a cookie minted before per-user epochs existed (no uepoch) reads as 1: valid until this user is first reduced', async () => {
    const { uepoch: _omit, ...old } = claims
    void _omit
    await expect(isSessionEpochCurrent(fakeDb({ org: 7, user: null }) as never, old)).resolves.toBe(true)
    await expect(isSessionEpochCurrent(fakeDb({ org: 7, user: 2 }) as never, old)).resolves.toBe(false)
  })

  it('requires exact equality instead of accepting an impossible future epoch', async () => {
    await expect(isSessionEpochCurrent(fakeDb({ org: 6, user: 3 }) as never, claims)).resolves.toBe(false)
    await expect(isSessionEpochCurrent(fakeDb({ org: 7, user: 2 }) as never, claims)).resolves.toBe(false)
  })

  it('propagates an unavailable epoch store so the transport can fail closed', async () => {
    const db = { query: vi.fn(async () => { throw new Error('database unavailable') }) }
    await expect(isSessionEpochCurrent(db as never, claims)).rejects.toThrow('database unavailable')
  })

  it('accepts the current epochs; an org-less session is checked against its global epoch only', async () => {
    const db = fakeDb({ org: 7, user: 3 })
    await expect(isSessionEpochCurrent(db as never, claims)).resolves.toBe(true)

    db.query.mockClear()
    await expect(isSessionEpochCurrent(db as never, { ...claims, orgId: null })).resolves.toBe(true)
    expect(db.count('auth_global_epochs')).toBe(1)
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('coalesces a reconnect wave: ONE org read for the whole org, one user read per user, within a bounded window', async () => {
    let now = 1_000
    const db = fakeDb({ org: 7, user: 3 })
    const validate = createSessionEpochValidator(db as never, { cacheTtlMs: 500, now: () => now })

    const users = Array.from({ length: 5 }, (_, i) => ({ ...claims, userId: `user-${i}` }))
    const wave = users.flatMap((c) => Array.from({ length: 10 }, () => validate(c)))
    await expect(Promise.all(wave)).resolves.toEqual(wave.map(() => true))
    expect(db.count('auth_epochs')).toBe(1)
    expect(db.count('auth_user_epochs')).toBe(5)
    expect(db.count('auth_global_epochs')).toBe(5)

    // A second wave inside the window reads nothing.
    await Promise.all(users.map(validate))
    expect(db.query).toHaveBeenCalledTimes(11)

    now += 501
    await expect(validate(claims)).resolves.toBe(true)
    expect(db.query).toHaveBeenCalledTimes(14)
  })

  it('a stale org epoch refuses without reading the user epoch', async () => {
    const db = fakeDb({ org: 8, user: 3 })
    const validate = createSessionEpochValidator(db as never, { cacheTtlMs: 0 })
    await expect(validate(claims)).resolves.toBe(false)
    expect(db.count('auth_user_epochs')).toBe(0)
  })

  it('the validator refuses a reduced user and admits a colleague in the same org', async () => {
    const db = {
      query: vi.fn(async (sql: string, params: unknown[]): Promise<Rows> => {
        if (sql.includes('auth_global_epochs')) return row(null)
        if (sql.includes('auth_user_epochs')) return row(params[1] === 'demoted' ? 4 : null)
        return row(7)
      }),
    }
    const validate = createSessionEpochValidator(db as never)
    await expect(validate({ ...claims, userId: 'demoted', uepoch: 3 })).resolves.toBe(false)
    await expect(validate({ ...claims, userId: 'colleague', uepoch: 1 })).resolves.toBe(true)
  })

  it('can disable the burst cache for immediate revalidation', async () => {
    const db = fakeDb({ org: 7, user: 3 })
    const validate = createSessionEpochValidator(db as never, { cacheTtlMs: 0 })
    await validate(claims)
    await validate(claims)
    expect(db.query).toHaveBeenCalledTimes(6)
  })

  it('no code in server/src signs a session except through signCurrentSession', () => {
    // A mint site that bypasses it can forget `uepoch`, which is a silent
    // lockout of anyone whose access was ever reduced (reviewer lens,
    // 2026-10-16). Grep-shaped on purpose: it must catch a NEW site too.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          const rel = relative(root, path).replace(/\\/g, '/')
          if (rel === 'auth/tokens.ts' || rel === 'auth/sessionEpoch.ts') continue
          if (/\bsignSession\s*\(/.test(readFileSync(path, 'utf8'))) offenders.push(rel)
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
    // And the scan saw the tree (an empty walk would pass vacuously).
    expect(readFileSync(join(root, 'auth/devLogin.ts'), 'utf8')).toMatch(/signCurrentSession\(/)
  })

  it('production wires the epoch check into cookie HTTP and the global notify into the shared validator', () => {
    // Every behavioural test builds its own gate; without this a deleted
    // wiring line would leave them all green while HTTP trusted a revoked
    // admin's cookie again. Text matching (startAutomergeSync and the index
    // module boot nothing a test can drive): line comments stripped and each
    // match anchored at a line start (QA lens, 2026-10-16 — a wiring line kept
    // only in a comment passed the first version). A /* */ block still would.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..')
    const code = (file: string) => readFileSync(join(root, file), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
      .join('\n')
    const index = code('index.ts')
    expect(index).toMatch(/^app\.use\('\/api', requireAuth\(\{ isSessionCurrent: sharedSessionEpochValidator\(pool\) \}\)\)$/m)
    expect(index.match(/requireAuth\(/g)).toHaveLength(1)
    const sync = code('automergeServer.ts')
    expect(sync).toMatch(/^\s*const validateSessionEpoch = sharedSessionEpochValidator\(pool\)$/m)
    expect(sync).toMatch(/^\s*onGlobalEpochBumped: \(userId\) => validateSessionEpoch\.forgetGlobal\(userId\),$/m)
  })

  it('sharedSessionEpochValidator is one instance per pool (so a forgetGlobal from the sync path reaches HTTP)', () => {
    const a = { query: vi.fn() }
    expect(sharedSessionEpochValidator(a as never)).toBe(sharedSessionEpochValidator(a as never))
    expect(sharedSessionEpochValidator({ query: vi.fn() } as never)).not.toBe(sharedSessionEpochValidator(a as never))
  })

  it('the shared validator checks EVERY epoch, not only the global one — it is what cookie HTTP runs', async () => {
    // index.ts hands sharedSessionEpochValidator(pool) to requireAuth, and the
    // wiring test above only pins that line's TEXT; a shared validator that
    // checked the global epoch alone would let a removed member's cookie read
    // the org's landscapes again (QA lens round 2, 2026-10-17: survived).
    await expect(sharedSessionEpochValidator(fakeDb({ org: 7, user: 3 }) as never)(claims)).resolves.toBe(true)
    await expect(sharedSessionEpochValidator(fakeDb({ org: 7, user: 4 }) as never)(claims)).resolves.toBe(false)
    await expect(sharedSessionEpochValidator(fakeDb({ org: 8, user: 3 }) as never)(claims)).resolves.toBe(false)
    await expect(sharedSessionEpochValidator(fakeDb({ org: 7, user: 3, global: 2 }) as never)(claims)).resolves.toBe(false)
  })

  it('mintRefusalBody answers each refusal with ITS reason, and anything else with null', () => {
    for (const reason of ['user_inactive', 'impersonator_not_admin', 'not_a_member', 'org_suspended'] as const) {
      expect(mintRefusalBody(new SessionMintRefusedError(reason))).toEqual({ error: reason })
    }
    expect(mintRefusalBody(new Error('session mint refused: user_inactive'))).toBeNull()
    expect(mintRefusalBody(undefined)).toBeNull()
  })

  it('forget drops a burst-cached epoch at once: a reconnect right after a bump is not admitted on the old value', async () => {
    const epochs = { org: 7, user: 3 }
    const db = fakeDb(epochs)
    const validate = createSessionEpochValidator(db as never, { cacheTtlMs: 5_000 })
    await expect(validate(claims)).resolves.toBe(true) // caches org 7, user 3

    epochs.user = 4 // the user is demoted…
    await expect(validate(claims)).resolves.toBe(true) // …the cache still says 3 (bounded staleness)
    validate.forget('org-1', 'user-1') // …until the bump's notify arrives
    await expect(validate(claims)).resolves.toBe(false)

    epochs.org = 8
    validate.forget('org-1')
    await expect(validate({ ...claims, uepoch: 4 })).resolves.toBe(false)
  })

  it('a read already in flight when forget runs does not put its pre-bump answer in the cache', async () => {
    let release!: (rows: Rows) => void
    const epochs = { org: 7, user: 3 }
    const query = vi.fn(async (sql: string): Promise<Rows> => {
      if (sql.includes('auth_global_epochs')) return row(null)
      if (sql.includes('auth_user_epochs')) {
        if (query.mock.calls.filter(([s]) => s.includes('auth_user_epochs')).length === 1) {
          return new Promise<Rows>((resolve) => { release = resolve })
        }
        return row(epochs.user)
      }
      return row(epochs.org)
    })
    const validate = createSessionEpochValidator({ query } as never, { cacheTtlMs: 5_000 })
    const first = validate(claims)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    epochs.user = 4
    validate.forget('org-1', 'user-1')
    release(row(3)) // the stale read lands after the forget
    await expect(first).resolves.toBe(true) // its own caller saw the old value — it asked first
    await expect(validate(claims)).resolves.toBe(false) // but nobody after it does
  })

  it('the burst cache is bounded: past maxEntries the oldest entry is evicted and read again', async () => {
    const db = fakeDb({ org: 7, user: 3 })
    const validate = createSessionEpochValidator(db as never, { cacheTtlMs: 5_000, maxEntries: 2 })
    const user = (n: number) => ({ ...claims, userId: `user-${n}` })
    for (const n of [1, 2, 3]) await validate(user(n))
    expect(db.count('auth_user_epochs')).toBe(3)
    await validate(user(3)) // still cached
    expect(db.count('auth_user_epochs')).toBe(3)
    await validate(user(1)) // evicted when user-3 arrived
    expect(db.count('auth_user_epochs')).toBe(4)
  })

  it('clears a failed epoch flight and remains fail closed', async () => {
    const db = fakeDb({ org: 7, user: 3 })
    db.query.mockImplementationOnce(async () => { throw new Error('database unavailable') })
    const validate = createSessionEpochValidator(db as never)

    await expect(validate(claims)).rejects.toThrow('database unavailable')
    await expect(validate(claims)).resolves.toBe(true)
  })

  describe('the global epoch (platform admin lost, deactivated) reaches every session of the user', () => {
    // Regression (architect lens, 2026-10-16): revoking platform admin bumped
    // nothing, and an org-less session was never epoch-checked at all.
    const admin: SessionClaims = { userId: 'admin-1', orgId: null, isPlatformAdmin: true, epoch: 1 }

    it('refuses an org-less session once its global epoch moves — the case no (org, user) epoch can reach', async () => {
      await expect(isSessionEpochCurrent(fakeDb({ org: null, user: null, global: null }) as never, admin)).resolves.toBe(true)
      await expect(isSessionEpochCurrent(fakeDb({ org: null, user: null, global: 2 }) as never, admin)).resolves.toBe(false)
      const validate = createSessionEpochValidator(fakeDb({ org: null, user: null, global: 2 }) as never)
      await expect(validate(admin)).resolves.toBe(false)
      await expect(validate(admin)).resolves.toBe(false)
    })

    it('refuses an org session on its global epoch even when the org and per-user epochs still match', async () => {
      const db = fakeDb({ org: 7, user: 3, global: 2 })
      await expect(isSessionEpochCurrent(db as never, claims)).resolves.toBe(false)
      await expect(isSessionEpochCurrent(db as never, { ...claims, gepoch: 2 })).resolves.toBe(true)
      // The global check refuses first: the org tables are never read.
      const validate = createSessionEpochValidator(db as never, { cacheTtlMs: 0 })
      db.query.mockClear()
      await expect(validate(claims)).resolves.toBe(false)
      expect(db.count('auth_epochs') + db.count('auth_user_epochs')).toBe(0)
    })

    it('a cookie minted before global epochs existed (no gepoch) reads as 1: valid until the user is first revoked', async () => {
      await expect(isSessionEpochCurrent(fakeDb({ org: 7, user: 3, global: null }) as never, claims)).resolves.toBe(true)
      await expect(isSessionEpochCurrent(fakeDb({ org: 7, user: 3, global: 1 }) as never, claims)).resolves.toBe(true)
      await expect(isSessionEpochCurrent(fakeDb({ org: 7, user: 3, global: 2 }) as never, claims)).resolves.toBe(false)
    })

    it("an impersonation session ends when the IMPERSONATOR's global epoch moves, not only the target's", async () => {
      const imp: SessionClaims = { ...claims, imp: { by: 'admin-1', gepoch: 1 } }
      await expect(isSessionEpochCurrent(fakeDb({ org: 7, user: 3, global: { 'admin-1': 1 } }) as never, imp)).resolves.toBe(true)
      await expect(isSessionEpochCurrent(fakeDb({ org: 7, user: 3, global: { 'admin-1': 2 } }) as never, imp)).resolves.toBe(false)
      // An old impersonation cookie without imp.gepoch reads it as 1, too.
      const oldImp: SessionClaims = { ...claims, imp: { by: 'admin-1' } }
      await expect(isSessionEpochCurrent(fakeDb({ org: 7, user: 3, global: { 'admin-1': 2 } }) as never, oldImp)).resolves.toBe(false)
      const validate = createSessionEpochValidator(fakeDb({ org: 7, user: 3, global: { 'admin-1': 2 } }) as never)
      await expect(validate(imp)).resolves.toBe(false)
    })

    it('forgetGlobal drops a burst-cached global epoch at once', async () => {
      const epochs: { org: number; user: number; global: number | null } = { org: 7, user: 3, global: null }
      const validate = createSessionEpochValidator(fakeDb(epochs) as never, { cacheTtlMs: 5_000 })
      await expect(validate(claims)).resolves.toBe(true)
      epochs.global = 2
      await expect(validate(claims)).resolves.toBe(true) // cached, bounded staleness
      validate.forgetGlobal('user-1')
      await expect(validate(claims)).resolves.toBe(false)
      await expect(validate(claims)).resolves.toBe(false)
    })

  })
})
