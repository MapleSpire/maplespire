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

import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:net'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlacementProposerFixture, controlledPlacementObservations } from '../testing/placementProposerFixture.js'
import { runPlacementProposer } from './placementProposerMain.js'
import { PlacementProposerHealth, type ProposerHealthSnapshot } from './placementProposerHealth.js'
import { persistObservedPlacement, PlacementProposer } from './placementProposer.js'
import { ActivityWitness } from './activityWitness.js'
import * as metricsListener from '../runtime/metricsListener.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
type Fixture = Awaited<ReturnType<typeof createPlacementProposerFixture>>
type Event = Record<string, unknown>
const isHealth = (event: unknown): event is ProposerHealthSnapshot => (event as Event)?.kind === 'proposer-health'
async function until(predicate: () => boolean, ceiling = 15_000) {
  const deadline = performance.now() + ceiling
  while (!predicate() && performance.now() < deadline) await delay(10)
  expect(predicate(), 'observable condition did not arrive').toBe(true)
}

describe.skipIf(!TEST_DATABASE_URL)('real proposer entry health and local HTTP metrics (T-14e)', () => {
  let f: Fixture
  beforeAll(async () => { f = await createPlacementProposerFixture(TEST_DATABASE_URL!, 'proposer_health') })
  beforeEach(async () => { await f.reset() })
  afterEach(() => { vi.restoreAllMocks() })
  afterAll(async () => { await f?.cleanup() })
  const history = () => f.db.pool.query(`UPDATE sync_placement_history_coverage
    SET from_at=statement_timestamp()-interval '7 hours', from_beginning=(kind='proposals'), origin=gen_random_uuid()`)
  const balanced = async () => {
    await f.db.pool.query("UPDATE workspace_placement SET partition=1 WHERE landscape_id IN ('one','two')")
    await f.db.pool.query('TRUNCATE sync_workspace_placement_moves')
    await history()
  }
  const authority = async () => {
    const snapshot: Record<string, unknown> = {}
    for (const table of ['orgs', 'landscapes', 'versions', 'automerge_storage', 'read_model_static_workspaces',
      'workspace_placement', 'sync_workspace_ownership', 'workspace_claim_coverage',
      'automerge_document_workspace', 'sync_topology_contract']) {
      snapshot[table] = (await f.db.pool.query(`SELECT to_jsonb(t)::text AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows
    }
    return snapshot
  }
  const once = async (env = f.env) => {
    const events: unknown[] = []
    await runPlacementProposer(env, undefined, event => { events.push(event) }, true)
    return events.filter(isHealth)
  }
  it('publishes initial unknown, real sampling/stability, then stopped; preserves every authority table', async () => {
    const before = await authority(), events = await once()
    expect(events[0]).toMatchObject({ state: 'initial-unknown', observedAtUs: null, sampleCount: 0 })
    expect(events.some(e => e.state === 'warming-stability' && e.sampleCount === 6 && e.frames === 1)).toBe(true)
    expect(events.at(-1)).toMatchObject({ state: 'stopped', sampleCount: 6 })
    expect(await authority()).toEqual(before)
    expect((await f.db.pool.query('SELECT count(*) FROM sync_placement_proposals')).rows[0].count).toBe('0')
  })
  it('distinguishes real mono-partition no-candidate from missing global history', async () => {
    const topology = 'v1.ce1461953e2b8ac2|1|v1|mode=placed|reserved='
    await f.db.pool.query('UPDATE workspace_placement SET partition=0')
    await f.db.pool.query('UPDATE sync_topology_contract SET value=$1', [topology])
    const env = { ...f.env, SYNC_CELL_PLACEMENT_PROPOSER_TOPOLOGY: topology }
    expect((await once(env)).some(e => e.state === 'halted-no-candidate-target')).toBe(true)
    const removed = (await f.db.pool.query('DELETE FROM sync_placement_history_coverage WHERE kind=$1 RETURNING *', ['movements'])).rows[0]
    try {
      const events = await once(env)
      expect(events.some(e => e.state === 'halted-signal-unknown' && e.reason === 'history-unavailable')).toBe(true)
      expect(events.some(e => e.state === 'halted-no-candidate-target')).toBe(false)
    } finally {
      await f.db.pool.query('INSERT INTO sync_placement_history_coverage SELECT * FROM json_populate_record(NULL::sync_placement_history_coverage, $1)', [JSON.stringify(removed)])
    }
  })
  it('reports healthy no-need, loss and return in one real entry; sample count survives witness replacement', async () => {
    await balanced()
    expect((await once()).map(e => ({ state: e.state, reason: e.reason }))).toContainEqual({ state: 'healthy-no-proposal', reason: 'no-proposal-needed' })
    const events: ProposerHealthSnapshot[] = [], abort = new AbortController()
    const running = runPlacementProposer(f.env, abort.signal, event => { if (isHealth(event)) events.push(event) })
    const joined = running.then(() => null, error => error as Error)
    try {
      await until(() => events.some(e => e.state === 'healthy-no-proposal'))
      const success = events.find(e => e.state === 'healthy-no-proposal')!
      await f.db.pool.query('UPDATE workspace_claim_coverage SET covered=false')
      await until(() => events.some(e => e.state === 'halted-signal-unknown'))
      const lost = events.find(e => e.state === 'halted-signal-unknown')!
      expect(lost.lastSuccessObservedAtUs).toBe(success.lastSuccessObservedAtUs)
      expect(lost.sampleCount).toBeGreaterThan(success.sampleCount)
      await f.db.pool.query('UPDATE workspace_claim_coverage SET covered=true')
      await until(() => events.some(e => e.state === 'healthy-no-proposal' && e.sampleCount > lost.sampleCount))
      const recovered = events.find(e => e.state === 'healthy-no-proposal' && e.sampleCount > lost.sampleCount)!
      expect(recovered.lastSuccessObservedAtUs).not.toBe(success.lastSuccessObservedAtUs)
      expect(recovered.unknownSince).toBeNull()
      expect(recovered.sampleCount).toBe(lost.sampleCount + 6)
    } finally { abort.abort(); expect(await joined).toBeNull() }
    expect(events.at(-1)?.state).toBe('stopped')
  })
  it('publishes a needed isolation return waiting for idle instead of no need', async () => {
    const topology = 'v1.ce1461953e2b8ac2|2|v1|mode=placed|reserved=1'
    await f.db.pool.query("UPDATE workspace_placement SET partition=1 WHERE landscape_id='subject'")
    await f.db.pool.query('UPDATE sync_topology_contract SET value=$1', [topology])
    await f.db.pool.query("UPDATE automerge_storage SET updated_at=statement_timestamp()-interval '2 minutes'")
    await f.db.pool.query('TRUNCATE sync_workspace_placement_moves')
    await history()
    const env = { ...f.env, SYNC_CELL_PLACEMENT_PROPOSER_TOPOLOGY: topology }
    const active = await once(env)
    expect(active.some(e => e.state === 'waiting-idle' && e.reason === 'group-not-idle')).toBe(true)
    expect(active.some(e => e.state === 'healthy-no-proposal')).toBe(false)
    await f.db.pool.query("UPDATE automerge_storage SET updated_at=statement_timestamp()-interval '10 minutes'")
    expect((await once(env)).some(e => e.state === 'warming-stability')).toBe(true)
    expect((await f.db.pool.query('SELECT count(*) FROM sync_placement_proposals')).rows[0].count).toBe('0')
  })
  it('serves authenticated metrics from local state without SQL or rejuvenating observation/publication', async () => {
    await balanced()
    const events: unknown[] = [], abort = new AbortController()
    const joined = runPlacementProposer({ ...f.env, SYNC_CELL_PLACEMENT_PROPOSER_METRICS_PORT: '0', METRICS_TOKEN: 'fixture' },
      abort.signal, event => { events.push(event) }).then(() => null, error => error as Error)
    let url = ''
    try {
      await until(() => events.some(e => isHealth(e) && e.state === 'healthy-no-proposal'))
      const channel = events.find(e => (e as Event).event === 'listening') as { port: number }
      url = `http://127.0.0.1:${channel.port}/metrics`
      const query = vi.spyOn(Pool.prototype, 'query')
      expect((await fetch(url)).status).toBe(401)
      const scrape = async () => {
        const response = await fetch(url, { headers: { Authorization: 'Bearer fixture' } })
        expect(response.status).toBe(200); return response.text()
      }
      const a = await scrape(); await delay(30); const b = await scrape()
      const metric = (text: string, name: string) => Number(text.match(new RegExp(`^maplespire_placement_proposer_${name} (.+)$`, 'm'))![1])
      expect(metric(a, 'observed_timestamp_seconds')).toBe(metric(b, 'observed_timestamp_seconds'))
      expect(metric(a, 'last_success_timestamp_seconds')).toBe(metric(b, 'last_success_timestamp_seconds'))
      expect(metric(b, 'observation_age_seconds')).toBeGreaterThan(metric(a, 'observation_age_seconds'))
      expect(metric(a, 'activity_queries_total')).toBe(6)
      expect(metric(b, 'activity_queries_total')).toBe(6)
      expect(query).not.toHaveBeenCalled()
      expect(b).toContain('maplespire_placement_proposer_state{state="healthy-no-proposal"} 1')
    } finally { abort.abort(); expect(await joined).toBeNull() }
    await expect(fetch(url)).rejects.toThrow()
  })
  it('only says proposing for an actual committed row and keeps reconciliation out of admission counters', async () => {
    const observed = await controlledPlacementObservations(f.reader, f.config.schema)
    const result = await persistObservedPlacement(f.reader, f.config, observed, 'subject', 1)
    expect(result).toMatchObject({ kind: 'admitted' })
    if (result.kind !== 'admitted') throw new Error('expected real admission')
    const health = new PlacementProposerHealth(true)
    health.observe(observed.observations.at(-1)!, observed.snapshot.history, performance.now(), 0, observed.observations.length)
    health.finish([result], false)
    expect(health.publish(6)).toMatchObject({ state: 'proposing', admittedMembers: 3,
      lastAdmission: { id: result.id, landscapeId: 'subject', toPartition: 1, memberCount: 3 }, results: { admitted: 1 } })
    const row = (await f.db.pool.query('SELECT proposal_id, payload FROM sync_placement_proposals')).rows[0]
    expect(row.proposal_id).toBe(result.id)
    expect(row.payload.members).toHaveLength(3)
    health.reconciled({ kind: 'already-admitted', id: result.id })
    expect(health.snapshot(6)).toMatchObject({ state: 'halted-signal-unknown', admittedMembers: 3,
      results: { admitted: 1, 'already-admitted': 1 } })
    // A fresh native pass sees the durable budget and emits the oscillation guard.
    const proposer = new PlacementProposer(f.reader, f.config)
    try { await proposer.pass(); expect(proposer.health.snapshot(proposer.sampleCount).state).toBe('halted-oscillation-guard') }
    finally { await proposer.stop() }
  })
  it('survives a publication callback failure during bind failure and closes the pool', async () => {
    const blocker = createServer()
    await new Promise<void>(resolve => { blocker.listen(0, '127.0.0.1', resolve) })
    const port = (blocker.address() as { port: number }).port
    const sentinel = new Error('fixture-publication-failed')
    try {
      await expect(runPlacementProposer({ ...f.env, SYNC_CELL_PLACEMENT_PROPOSER_METRICS_PORT: String(port), METRICS_TOKEN: 'fixture' },
        undefined, event => { if ((event as Event).kind === 'proposer-metrics') throw sentinel }, true)).rejects.toBe(sentinel)
      const sessions = await f.db.pool.query('SELECT count(*) FROM pg_stat_activity WHERE usename=$1', [f.config.role])
      // The fixture reader can exist; the entry pool cannot remain after finally.
      expect(Number(sessions.rows[0].count)).toBe(f.reader.totalCount)
    } finally { await new Promise<void>((resolve, reject) => blocker.close(error => error ? reject(error) : resolve())) }
  })
  it('retains unknown while stop is still joining its witness', async () => {
    let release!: () => void, mono = 0
    const barrier = new Promise<void>(resolve => { release = resolve })
    const health = new PlacementProposerHealth(true, { wall: () => 1_789_340_000_000 + mono, monotonic: () => mono })
    // A delivery barrier tests await ordering, not a simulated duration of PG.
    vi.spyOn(ActivityWitness.prototype, 'stop').mockImplementation(() => barrier)
    const proposer = new PlacementProposer(f.reader, f.config, health), stopping = proposer.stop()
    try {
      mono = 900_001
      expect(health.publish(0)).toMatchObject({ state: 'initial-unknown', unknownAgeMs: 900_001 })
    } finally { release(); await stopping }
    expect(health.snapshot(0).state).toBe('stopped')
  })
  it.each(['abort', 'publication'])('starts no database work after %s during metrics bind', async cause => {
    const original = metricsListener.startMetricsListener, abort = new AbortController()
    const sentinel = new Error('fixture-bind-publication'), events: unknown[] = []
    const query = vi.spyOn(Pool.prototype, 'query'), connect = vi.spyOn(Pool.prototype, 'connect')
    const end = vi.spyOn(Pool.prototype, 'end')
    let port = 0
    vi.spyOn(metricsListener, 'startMetricsListener').mockImplementation(async options => {
      const listener = await original(options)
      if (!listener) throw new Error('fixture-listener-required')
      port = listener.port
      if (cause === 'abort') abort.abort()
      else options.log('fixture-bind-boundary')
      // The real socket is acquired, but its handle is not yet handed to Main.
      // Give the requested proposer stop time to settle before hand-off.
      await delay(0)
      return listener
    })
    const failure = await runPlacementProposer({ ...f.env,
      SYNC_CELL_PLACEMENT_PROPOSER_METRICS_PORT: '0', METRICS_TOKEN: 'fixture' }, abort.signal, event => {
      events.push(event)
      if ((event as Event).event === 'fixture-bind-boundary') throw sentinel
    }, true).then(() => undefined, error => error as unknown)
    expect(failure).toBe(cause === 'abort' ? undefined : sentinel)
    expect(query, 'no new SQL after stop during metrics bind').not.toHaveBeenCalled()
    expect(connect, 'no new pool acquisition after stop during metrics bind').not.toHaveBeenCalled()
    expect(end).toHaveBeenCalledTimes(1)
    expect(events.some(event => (event as Event).kind === 'ready')).toBe(false)
    expect(events.filter(isHealth).at(-1)?.state).toBe('stopped')
    expect(port).toBeGreaterThan(0)
    await expect(fetch(`http://127.0.0.1:${port}/metrics`)).rejects.toThrow()
  })
  it.each([new Error('fixture-final-publication-failed'), 0, false, null])('propagates a timer publication failure %s during final pool cleanup', async sentinel => {
    const original = Pool.prototype.end
    let ending = false, failed = false
    vi.spyOn(Pool.prototype, 'end').mockImplementation(async function(this: Pool) {
      ending = true
      await new Promise<void>(resolve => { original.call(this, resolve) })
      await delay(1_200)
    })
    await expect(runPlacementProposer(f.env, undefined, event => {
      if (ending && !failed && isHealth(event)) { failed = true; throw sentinel }
    }, true)).rejects.toBe(sentinel)
    expect(failed).toBe(true)
  })
})
