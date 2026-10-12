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

import { Pool } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { placementProposerConfig } from './placementProposerConfig.js'
import { postgresMicros } from './placementProposerSnapshot.js'
import { runPlacementProposer } from './placementProposerMain.js'

const valid = () => ({
  SYNC_CELL_PLACEMENT_PROPOSER: 'on',
  SYNC_CELL_PLACEMENT_PROPOSER_DATABASE_URL: 'postgres://proposer:fixture@127.0.0.1:5498/test',
  SYNC_CELL_PLACEMENT_PROPOSER_ROLE: 'proposer',
  SYNC_CELL_PLACEMENT_PROPOSER_SCHEMA: 'test_fixture',
  SYNC_CELL_PLACEMENT_PROPOSER_TOPOLOGY: 'v1.ce1461953e2b8ac2|2|v1|mode=placed|reserved=',
})
afterEach(() => { vi.restoreAllMocks() })
describe('dedicated proposer executable configuration', () => {
  it.each([undefined, '', ' ', 'off'])('does no PG work when disabled (%s)', async flag => {
    const connect = vi.spyOn(Pool.prototype, 'connect')
    const events: unknown[] = []
    await runPlacementProposer({ SYNC_CELL_PLACEMENT_PROPOSER: flag,
      DATABASE_URL: 'postgres://privileged:secret@127.0.0.1:1/shared' }, undefined, event => { events.push(event) })
    expect(connect).not.toHaveBeenCalled()
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({ kind: 'disabled', flag: 'SYNC_CELL_PLACEMENT_PROPOSER' })
    expect(events[1]).toMatchObject({ kind: 'proposer-health', state: 'disabled', enabled: false,
      observedAtUs: null, sampleCount: 0, lastSuccessObservedAtUs: null })
  })
  it.each(['1', 'true', 'ON', 'yes', 'disabled'])('rejects undeclared activation spelling %s', flag => {
    expect(() => placementProposerConfig({ ...valid(), SYNC_CELL_PLACEMENT_PROPOSER: flag })).toThrow('invalid-SYNC_CELL')
  })
  it.each(['SYNC_CELL_PLACEMENT_PROPOSER_DATABASE_URL', 'SYNC_CELL_PLACEMENT_PROPOSER_ROLE',
    'SYNC_CELL_PLACEMENT_PROPOSER_SCHEMA', 'SYNC_CELL_PLACEMENT_PROPOSER_TOPOLOGY'])(
    'requires %s even with privileged fallbacks present', key => {
      const env: NodeJS.ProcessEnv = { ...valid(), DATABASE_URL: 'postgres://admin:secret@localhost/shared',
        DB_USER: 'admin', DB_PASSWORD: 'secret', [key]: ' ' }
      expect(() => placementProposerConfig(env)).toThrow('missing-' + key)
    })
  it.each(['postgres://proposer@localhost/test', 'postgres://proposer:fixture@localhost',
    'file:///etc/password', 'postgres://admin:fixture@localhost/test',
    'postgres://proposer:fixture@localhost/test?options=-c%20role=admin',
    'postgres://proposer:fixture@localhost/test?application_name=other'])('refuses unsafe dedicated DSN %s', url => {
    expect(() => placementProposerConfig({ ...valid(), SYNC_CELL_PLACEMENT_PROPOSER_DATABASE_URL: url })).toThrow()
  })
  it('requires an exact placed contract and a literal schema identifier', () => {
    expect(() => placementProposerConfig({ ...valid(), SYNC_CELL_PLACEMENT_PROPOSER_TOPOLOGY: 'v1|2' })).toThrow('placed')
    expect(() => placementProposerConfig({ ...valid(), SYNC_CELL_PLACEMENT_PROPOSER_SCHEMA: 'x,public' })).toThrow('schema')
  })
  it('uses one bounded dedicated pool and no configurable cooldown escape', () => {
    const config = placementProposerConfig({ ...valid(), DB_MAX: '1000',
      SYNC_CELL_PLACEMENT_PROPOSER_COOLDOWN_MS: '0' })!
    expect(config.pool).toMatchObject({ max: 1, connectionTimeoutMillis: 5000,
      statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 5000 })
    expect(config.grants).toEqual([])
  })
  it('requires explicit valid grants for reserved partitions', () => {
    const env = { ...valid(), SYNC_CELL_PLACEMENT_PROPOSER_TOPOLOGY: 'v1|2|v1|mode=placed|reserved=1' }
    expect(placementProposerConfig(env)!.grants).toEqual([])
    expect(placementProposerConfig({ ...env, SYNC_CELL_PLACEMENT_PROPOSER_GRANTS:
      '[{"partition":1,"orgId":"org","landscapeIds":["l"]}]' })!.grants).toHaveLength(1)
    for (const raw of ['{}', 'null', '[{}]',
      '[{"partition":0,"orgId":"org","landscapeIds":["l"]}]',
      '[{"partition":1,"orgId":"org","landscapeIds":[]}]']) {
      expect(() => placementProposerConfig({ ...env, SYNC_CELL_PLACEMENT_PROPOSER_GRANTS: raw })).toThrow('grants')
    }
  })
})
describe('PostgreSQL microseconds', () => {
  it('retains a one-microsecond difference beyond JS safe integer precision', () => {
    expect(postgresMicros('1800000000000000001') - postgresMicros('1800000000000000000')).toBe(1n)
  })
  it.each([null, undefined, 1789000000000000, '1.5', '-1', '01', '8e9', '8640000000000000001'])(
    'refuses an unproved or out-of-range clock %s', value => { expect(() => postgresMicros(value)).toThrow() })
})
