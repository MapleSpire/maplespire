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

import { describe, expect, it } from 'vitest'
import {
  databasePoolConfig,
  lifecycleApplyDatabasePoolConfig,
  readModelDatabasePoolConfig,
} from './dbConfig.js'

describe('databasePoolConfig', () => {
  it('preserves DATABASE_URL compatibility for local and existing deployments', () => {
    expect(databasePoolConfig({ DATABASE_URL: 'postgres://legacy/db' })).toMatchObject({
      connectionString: 'postgres://legacy/db',
      max: 10,
      ssl: false,
    })
  })

  it('accepts provider-neutral secret fields and verified TLS', () => {
    expect(databasePoolConfig({
      DB_HOST: 'db.internal',
      DB_PORT: '6432',
      DB_NAME: 'maplespire',
      DB_USER: 'runtime',
      DB_PASSWORD: 'secret',
      DB_POOL_MAX: '24',
      DB_SSL_MODE: 'verify-full',
    })).toMatchObject({
      host: 'db.internal',
      port: 6432,
      database: 'maplespire',
      user: 'runtime',
      password: 'secret',
      max: 24,
      ssl: { rejectUnauthorized: true },
    })
  })

  it('rejects ambiguous TLS modes instead of silently weakening transport security', () => {
    expect(() => databasePoolConfig({ DB_SSL_MODE: 'prefer' })).toThrow('Unsupported DB_SSL_MODE')
  })

  it('isolates read-model projection capacity from the Automerge storage pool', () => {
    expect(readModelDatabasePoolConfig({
      DATABASE_URL: 'postgres://runtime/db',
      DB_POOL_MAX: '24',
    })).toMatchObject({
      connectionString: 'postgres://runtime/db',
      max: 4,
    })
    expect(readModelDatabasePoolConfig({
      DATABASE_URL: 'postgres://runtime/db',
      DB_READ_MODEL_POOL_MAX: '7',
    })).toMatchObject({ max: 7 })
  })

  describe('lifecycleApplyDatabasePoolConfig — the third bulkhead (task B2-5c)', () => {
    it('does not follow DB_POOL_MAX, because it exists to stop competing for it', () => {
      // The whole point: a promotion pins its lock client for tens of seconds,
      // and concurrent promotions plus the permanent LISTEN clients can exhaust
      // the primary pool, starving the promotions' own storage writes.
      expect(lifecycleApplyDatabasePoolConfig({
        DATABASE_URL: 'postgres://runtime/db',
        DB_POOL_MAX: '24',
      })).toMatchObject({ connectionString: 'postgres://runtime/db', max: 4 })
    })

    it('refuses in 2 s, not the primary pool\'s 10 — the "fail fast" half of the fix', () => {
      // A refusal here is converted at the acquisition site into
      // `LifecycleApplyRefusedError('pool-exhausted')`, which `routeErrors.ts`
      // answers 503 + Retry-After; this pool reaches that answer five times sooner.
      const lifecycle = lifecycleApplyDatabasePoolConfig({ DATABASE_URL: 'postgres://runtime/db' })
      const primary = databasePoolConfig({ DATABASE_URL: 'postgres://runtime/db' })
      expect(lifecycle.connectionTimeoutMillis).toBe(2_000)
      expect(primary.connectionTimeoutMillis).toBe(10_000)
      expect(lifecycle.connectionTimeoutMillis).toBeLessThan(primary.connectionTimeoutMillis as number)
    })

    it('is tunable on both axes without touching the primary pool', () => {
      expect(lifecycleApplyDatabasePoolConfig({
        DATABASE_URL: 'postgres://runtime/db',
        LIFECYCLE_APPLY_DB_POOL_MAX: '9',
        LIFECYCLE_APPLY_DB_CONNECTION_TIMEOUT_MS: '500',
      })).toMatchObject({ max: 9, connectionTimeoutMillis: 500 })
    })

    it('falls back to ITS OWN defaults on a bad knob — never to the primary pool\'s', () => {
      // Funnelling the knobs through `databasePoolConfig`'s env would let an
      // unusable value fall through to `positiveInteger(value, 10)` — the
      // PRIMARY pool's default — so the bulkhead would silently fail OPEN into
      // the coupling it exists to remove.
      for (const bad of ['0', '-1', 'four', '', '  ', '4.5']) {
        expect(lifecycleApplyDatabasePoolConfig({
          DATABASE_URL: 'postgres://runtime/db',
          LIFECYCLE_APPLY_DB_POOL_MAX: bad,
          LIFECYCLE_APPLY_DB_CONNECTION_TIMEOUT_MS: bad,
        })).toMatchObject({ max: 4, connectionTimeoutMillis: 2_000 })
      }
    })

    it('does not inherit DB_POOL_MAX even when the primary pool is retuned', () => {
      // The property the whole bulkhead rests on, asserted rather than assumed:
      // an operator raising or lowering the primary pool must not move this one.
      for (const primary of ['2', '10', '50']) {
        expect(lifecycleApplyDatabasePoolConfig({
          DATABASE_URL: 'postgres://runtime/db',
          DB_POOL_MAX: primary,
        })).toMatchObject({ max: 4 })
      }
    })

    it('inherits credentials and TLS from the same derivation as every other pool', () => {
      // A bulkhead that reached a different database, or reached it with weaker
      // transport, would be a second connection string to keep in step. It is
      // built from the primary config with two knobs overridden.
      expect(lifecycleApplyDatabasePoolConfig({
        DB_HOST: 'db.internal', DB_PORT: '6000', DB_NAME: 'ms',
        DB_USER: 'u', DB_PASSWORD: 'p', DB_SSL_MODE: 'require',
      })).toMatchObject({
        host: 'db.internal', port: 6000, database: 'ms',
        user: 'u', password: 'p', ssl: { rejectUnauthorized: true },
      })
    })
  })
})
