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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { RedisRuntime } from '../runtime/redis.js'
import { FencedPartitionLeaseStore } from './ownership.js'
import { syncCellPartitionConfig } from './assignment.js'
import { SyncCellTopologyContractFormatError } from './topologyContract.js'
import {
  SyncCellRouterTopologyMismatchError,
  SyncCellRouterTopologyUnreadableError,
  startRouterTopologyGuard,
} from './routerTopology.js'

/**
 * The router verifies the topology it is about to route on.
 *
 * THE HAZARD: `routerMain.ts` feeds its own `partitionCount` into
 * `createOwnerAwareWsUpgradeHandler`, which hashes a workspace to a partition,
 * and its own `topologyGeneration` into the `FencedPartitionLeaseStore` whose
 * keys it reads owners from. The cells refuse to start on a mismatch; this is
 * the router's equivalent.
 *
 * WHAT A DISAGREEMENT COSTS. It does not silently misroute. Both halves fail
 * closed downstream: a wrong COUNT reaches a cell that recomputes the
 * partition with its own count and refuses the routed upgrade with 503
 * (`automergeServer.ts`); a wrong GENERATION resolves no owner and the router
 * refuses with 503 (`ownerAwareWsRouter.ts`). The symptom is a PARTIAL 503
 * OUTAGE over the re-bucketed workspaces. So this guard is a diagnostic
 * upgrade — a named refusal in place of a diffuse half-outage.
 *
 * THE PAIR. `routerDeployment.test.ts` refuses divergence STATICALLY in the manifests, before
 * anything runs. This refuses it at BOOT, from whatever Redis holds. Neither
 * subsumes the other: the static gate cannot see a guard being removed or a
 * Redis written by an older fleet, and the runtime gate cannot see a manifest
 * divergence while the router boots first on a cold Redis — which is the
 * ordering `sync-cell-failover.yml`'s `condition: service_started` produces.
 */
describe('the owner-aware router verifies the topology contract', () => {
  const GENERATION = 'router-gen-1'

  /** Answers GET for the topology key and nothing else — a router that reached
   *  for any other command during verification is doing more than reading. */
  function redisHolding(contract: string | null | (() => string | null)): {
    runtime: RedisRuntime
    commands: string[][]
  } {
    const commands: string[][] = []
    const runtime = {
      configured: true,
      ready: true,
      prefix: 'test-prefix',
      async send(args: string[]) {
        commands.push(args)
        if (args[0] !== 'GET') throw new Error(`verification must not issue ${args[0]}`)
        return typeof contract === 'function' ? contract() : contract
      },
    } as unknown as RedisRuntime
    return { runtime, commands }
  }

  const storeOn = (runtime: RedisRuntime) => new FencedPartitionLeaseStore(runtime, GENERATION)

  /** A db that answers the durable-row survey with `count`, or throws — and
   *  RECORDS the SQL, because the count alone cannot show which rows were
   *  counted. */
  const statements: string[] = []
  const dbWith = (count: number | string | Error) => ({
    async query(text: string) {
      statements.push(text)
      if (count instanceof Error) throw count
      return { rows: [{ count: String(count) }] }
    },
  }) as never

  /** Collects the guard's output without letting it reach the console. */
  function recorder() {
    const log: string[] = []
    const warn: string[] = []
    const fatal: Error[] = []
    return {
      log: (l: string) => log.push(l),
      warn: (l: string) => warn.push(l),
      onFatal: (e: Error) => fatal.push(e),
      lines: log,
      warnings: warn,
      fatal,
      events: () => [...log, ...warn].map((l) => JSON.parse(l) as Record<string, unknown>),
      event: (name: string) => [...log, ...warn]
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e.event === name),
    }
  }

  /** A guard that never arms a real timer. Every deferred arm drives
   *  `recheckNow()` itself, so no test waits on wall-clock. */
  function guardOptions(runtime: RedisRuntime, extra: Record<string, unknown> = {}) {
    const armed: Array<() => void> = []
    return {
      armed,
      options: {
        store: storeOn(runtime),
        partitionCount: 2,
        setInterval: (handler: () => void) => { armed.push(handler); return armed.length },
        clearInterval: (handle: unknown) => { armed.splice(Number(handle) - 1, 1) },
        ...extra,
      },
    }
  }

  it.each(['shadow', 'placed'] as const)('T-10h1: a %s router confirms its mode and refuses the other mode', async placementMode => {
    const config = syncCellPartitionConfig({ SYNC_CELL_PARTITION_COUNT: '2', SYNC_CELL_MULTI_PARTITION: 'on', SYNC_CELL_PLACEMENT_MODE: placementMode })
    const shadow = 'v1.ce1461953e2b8ac2|2'
    const placed = 'v1.ce1461953e2b8ac2|2|v1|mode=placed|reserved='
    const expected = placementMode === 'shadow' ? shadow : placed
    const other = placementMode === 'shadow' ? placed : shadow
    for (const contract of [expected, other]) {
      const redis = redisHolding(contract)
      const seen = recorder()
      const store = new FencedPartitionLeaseStore(redis.runtime, config.topologyGeneration, config.placementMode)
      const { options } = guardOptions(redis.runtime, { ...seen, store })
      if (contract === expected) {
        const guard = await startRouterTopologyGuard(options)
        expect(guard.snapshot()).toMatchObject({ state: 'confirmed', contract: expected, contractPresent: true })
        guard.stop()
      } else {
        await expect(startRouterTopologyGuard(options)).rejects.toBeInstanceOf(SyncCellRouterTopologyMismatchError)
      }
      expect(redis.commands.map(args => args[0])).toEqual(['GET'])
    }
  })

  it('T-10h1: a pending placed router retains its mode on the later contract read', async () => {
    let contract: string | null = null
    const redis = redisHolding(() => contract)
    const config = syncCellPartitionConfig({ SYNC_CELL_PLACEMENT_MODE: 'placed', SYNC_CELL_PARTITION_COUNT: '2', SYNC_CELL_MULTI_PARTITION: 'on' })
    const store = new FencedPartitionLeaseStore(redis.runtime, config.topologyGeneration, config.placementMode)
    const seen = recorder()
    const { options } = guardOptions(redis.runtime, { ...seen, store, db: dbWith(0) })
    const guard = await startRouterTopologyGuard(options)
    try {
      expect(guard.snapshot()).toMatchObject({ state: 'pending', contract: 'v1.ce1461953e2b8ac2|2|v1|mode=placed|reserved=' })
      contract = 'v1.ce1461953e2b8ac2|2'
      await guard.recheckNow()
      expect(seen.fatal).toHaveLength(1)
      expect(seen.fatal[0]).toBeInstanceOf(SyncCellRouterTopologyMismatchError)
      expect(guard.snapshot().state).toBe('pending')
      expect(redis.commands.map(args => args[0])).toEqual(['GET', 'GET'])
    } finally { guard.stop() }
  })

  it('a MATCHING contract confirms, and arms no timer', async () => {
    const redis = redisHolding(`${GENERATION}|2`)
    const seen = recorder()
    const { armed, options } = guardOptions(redis.runtime, seen)
    const guard = await startRouterTopologyGuard(options)

    expect(guard.snapshot()).toMatchObject({ state: 'confirmed', contractPresent: true, rechecks: 0 })
    // Nothing to wait for, so nothing is scheduled — a confirmed router must not
    // pay a GET every few seconds for the rest of its life.
    expect(armed).toHaveLength(0)
    expect(seen.event('sync.router.topology_verified')[0]).toMatchObject({
      contract: `${GENERATION}|2`, contractPresent: true, pending: false,
    })
  })

  it('B3e confirms the same fingerprint through the real shared factory', async () => {
    const env = { SYNC_CELL_TOPOLOGY_GENERATION: 'v1', SYNC_CELL_PARTITION_COUNT: '2', SYNC_CELL_MULTI_PARTITION: 'on' }
    const fleet = syncCellPartitionConfig(env, '1111111111111111')
    const router = syncCellPartitionConfig(env, '1111111111111111')
    const redis = redisHolding(fleet.topologyGeneration + '|' + fleet.partitionCount)
    const { armed, options } = guardOptions(redis.runtime, {
      store: new FencedPartitionLeaseStore(redis.runtime, router.topologyGeneration), ...recorder(),
    })
    const guard = await startRouterTopologyGuard(options)
    try {
      expect(guard.snapshot()).toEqual({ state: 'confirmed', contract: 'v1.1111111111111111|2', contractPresent: true, rechecks: 0 })
      expect(armed).toHaveLength(0)
      expect(redis.commands).toEqual([['GET', 'test-prefix:sync-cell:topology']])
    } finally { guard.stop() }
  })

  it('B3e refuses a different fingerprint with the same configured generation', async () => {
    const env = { SYNC_CELL_TOPOLOGY_GENERATION: 'v1', SYNC_CELL_PARTITION_COUNT: '2', SYNC_CELL_MULTI_PARTITION: 'on' }
    const fleet = syncCellPartitionConfig(env, '1111111111111111')
    const router = syncCellPartitionConfig(env, '2222222222222222')
    const redis = redisHolding(fleet.topologyGeneration + '|' + fleet.partitionCount)
    const { options } = guardOptions(redis.runtime, {
      store: new FencedPartitionLeaseStore(redis.runtime, router.topologyGeneration), ...recorder(),
    })
    let opened: Awaited<ReturnType<typeof startRouterTopologyGuard>> | undefined
    const attempt = startRouterTopologyGuard(options).then(guard => { opened = guard; return guard })
    try {
      await expect(attempt).rejects.toBeInstanceOf(SyncCellRouterTopologyMismatchError)
      await expect(attempt).rejects.toMatchObject({ expected: 'v1.2222222222222222|2', found: 'v1.1111111111111111|2' })
      expect(redis.commands).toEqual([['GET', 'test-prefix:sync-cell:topology']])
    } finally { opened?.stop() }
  })

  it('B3d2 refuses malformed stored presence as corruption, not an unreadable Redis', async () => {
    const redis = redisHolding('router-gen-1|2|ce1461953e2b8ac2')
    const { options } = guardOptions(redis.runtime, recorder())
    const error = await startRouterTopologyGuard(options).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(SyncCellRouterTopologyMismatchError)
    expect(error).not.toBeInstanceOf(SyncCellRouterTopologyUnreadableError)
    expect(error).toMatchObject({ corruption: { code: 'sync_cell_topology_contract_invalid', reason: 'arity-invalid' } })
    expect(redis.commands).toEqual([['GET', 'test-prefix:sync-cell:topology']])
  })

  it('B3d2 makes malformed presence fatal after a pending boot too', async () => {
    let contract: string | null = null
    const redis = redisHolding(() => contract)
    const seen = recorder()
    const { options } = guardOptions(redis.runtime, seen)
    const guard = await startRouterTopologyGuard(options)
    try {
      expect(guard.snapshot().state).toBe('pending')
      contract = 'router-gen-1|2|ce1461953e2b8ac2'
      await guard.recheckNow()
      expect(seen.fatal).toHaveLength(1)
      expect(seen.fatal[0]).toBeInstanceOf(SyncCellRouterTopologyMismatchError)
      expect(seen.fatal[0]).toMatchObject({ corruption: { reason: 'arity-invalid' } })
      expect(seen.event('sync.router.topology_recheck_failed')).toEqual([])
      expect(redis.commands).toEqual([['GET', 'test-prefix:sync-cell:topology'], ['GET', 'test-prefix:sync-cell:topology']])
    } finally { guard.stop() }
  })

  it('B3d2 rejects unsupported contract options even when generation and count match', async () => {
    for (const contract of ['router-gen-1|2|v1|mode=placed|reserved=', 'router-gen-1|2|v1|mode=shadow|reserved=1']) {
      const redis = redisHolding(contract)
      const { options } = guardOptions(redis.runtime, recorder())
      const error = await startRouterTopologyGuard(options).catch((cause: unknown) => cause)
      expect(error).toBeInstanceOf(SyncCellRouterTopologyMismatchError)
      expect(error).toMatchObject({ found: contract, expected: 'router-gen-1|2' })
      expect((error as SyncCellRouterTopologyMismatchError).corruption).toBeUndefined()
    }
  })

  it('B3d2 does not label an invalid local expected contract as a transport failure', async () => {
    const redis = redisHolding('router-gen-1|2')
    const { options } = guardOptions(redis.runtime, {
      store: new FencedPartitionLeaseStore(redis.runtime, '../bad'), ...recorder(),
    })
    await expect(startRouterTopologyGuard(options)).rejects.toBeInstanceOf(SyncCellTopologyContractFormatError)
    expect(redis.commands).toEqual([])
  })

  it('a DIFFERENT partition count REFUSES at boot with the named error', async () => {
    // The incident: the router would hash workspaces across 2 partitions while
    // the fleet placed them across 4.
    const redis = redisHolding(`${GENERATION}|4`)
    const { options } = guardOptions(redis.runtime, recorder())
    await expect(startRouterTopologyGuard(options))
      .rejects.toBeInstanceOf(SyncCellRouterTopologyMismatchError)
  })

  it('a DIFFERENT generation refuses too — the half that resolves no owner at all', async () => {
    // Quieter than a count mismatch: the router reads owner keys under another
    // prefix and finds NOTHING, so every workspace looks unowned rather than
    // misowned. Same refusal.
    const redis = redisHolding('other-generation|2')
    const { options } = guardOptions(redis.runtime, recorder())
    const error = await startRouterTopologyGuard(options).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(SyncCellRouterTopologyMismatchError)
    expect((error as Error).message).toContain('other-generation|2')
    expect((error as Error).message).toContain(`${GENERATION}|2`)
    // An operator reading this at 3am needs the remedy, not just the fact.
    expect((error as Error).message).toContain('SYNC_CELL_PARTITION_COUNT')
  })

  it('an UNREADABLE contract is a DIFFERENT named error from a disagreement', async () => {
    // `redisRuntime.send` replaces the underlying cause with a generic
    // "Distributed runtime is unavailable", so without a distinct error a 750 ms
    // Redis stall at boot and a genuine fleet-wide disagreement would produce the
    // same line. Both are fatal at boot; they are not the same incident, and an
    // operator cannot act on a message that conflates them.
    const runtime = {
      configured: true,
      ready: true,
      prefix: 'test-prefix',
      async send() { throw new Error('Distributed runtime is unavailable') },
    } as unknown as RedisRuntime
    const { options } = guardOptions(runtime, recorder())
    const error = await startRouterTopologyGuard(options).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(SyncCellRouterTopologyUnreadableError)
    // ...and NOT the mismatch. Asserted separately because both are Errors with
    // similar shapes, and "it threw" is what a conflating implementation does.
    expect(error).not.toBeInstanceOf(SyncCellRouterTopologyMismatchError)
    expect((error as Error).message).toContain('could not READ')
    expect((error as Error).message).toContain('Distributed runtime is unavailable')
  })

  it('an ABSENT contract DEFERS the verification instead of passing it', async () => {
    // The router is gated on the cells with `condition: service_started`, so on
    // a first deployment it reliably reads an absent key. A boot-only check
    // would report success having examined nothing and never look again.
    const redis = redisHolding(null)
    const seen = recorder()
    const { armed, options } = guardOptions(redis.runtime, seen)
    const guard = await startRouterTopologyGuard(options)

    // It STARTS — refusing here would couple router liveness to cell boot order.
    expect(guard.snapshot()).toMatchObject({ state: 'pending', contractPresent: false })
    // ...but it has verified NOTHING, and both the log and the timer say so.
    expect(seen.event('sync.router.topology_verified')[0]).toMatchObject({
      contractPresent: false, pending: true,
    })
    expect(armed, 'an absent contract must arm a re-read').toHaveLength(1)
  })

  it('a deferred verification CONFIRMS when the contract finally appears', async () => {
    let contract: string | null = null
    const redis = redisHolding(() => contract)
    const seen = recorder()
    const { armed, options } = guardOptions(redis.runtime, seen)
    const guard = await startRouterTopologyGuard(options)
    expect(guard.snapshot().state).toBe('pending')

    // Still nothing: it stays pending and keeps the timer.
    await guard.recheckNow()
    expect(guard.snapshot()).toMatchObject({ state: 'pending', rechecks: 1 })
    expect(armed).toHaveLength(1)

    contract = `${GENERATION}|2`
    await guard.recheckNow()
    expect(guard.snapshot()).toMatchObject({ state: 'confirmed', contractPresent: true, rechecks: 2 })
    // The timer is cleared, so a confirmed router stops paying for the re-read.
    expect(armed).toHaveLength(0)
    expect(seen.event('sync.router.topology_verified').at(-1)).toMatchObject({
      contractPresent: true, deferred: true,
    })
  })

  it('a deferred verification that DISAGREES is fatal, handed back rather than thrown', async () => {
    // The whole reason deferring is safe. A cell writes a disagreeing contract
    // one second after the router booted; the router must not keep serving.
    let contract: string | null = null
    const redis = redisHolding(() => contract)
    const seen = recorder()
    const { armed, options } = guardOptions(redis.runtime, seen)
    const guard = await startRouterTopologyGuard(options)

    contract = `${GENERATION}|8`
    // It RESOLVES rather than rejecting: nothing awaits a timer callback, so a
    // throw would surface as an unhandled rejection and the exit code would
    // depend on Node's flags. The caller owns how the process dies.
    await expect(guard.recheckNow()).resolves.toBeUndefined()

    expect(seen.fatal).toHaveLength(1)
    expect(seen.fatal[0]).toBeInstanceOf(SyncCellRouterTopologyMismatchError)
    expect(seen.fatal[0]!.message).toContain(`${GENERATION}|8`)
    // The timer is cleared, so the same fatal cannot be delivered every 5 s.
    expect(armed).toHaveLength(0)
  })

  it('a re-read that FAILS is reported and retried, never fatal', async () => {
    // The calculus inverts after boot: the process is already serving, a blip is
    // self-healing, and killing it would turn a 750 ms stall into an outage. But
    // a swallowed failure would leave a permanently unverified router looking
    // identical to a confirmed one, so it is logged every time.
    // Absent at boot (so the guard defers), then the transport fails, then it
    // recovers — one store, three answers, driven by the call count.
    let call = 0
    const redis = redisHolding(() => {
      call += 1
      if (call === 1) return null
      if (call === 2) throw new Error('connection destroyed by the command timeout')
      return `${GENERATION}|2`
    })
    const seen = recorder()
    const { armed, options } = guardOptions(redis.runtime, seen)
    const guard = await startRouterTopologyGuard(options)
    expect(guard.snapshot().state).toBe('pending')

    await guard.recheckNow()
    expect(seen.fatal, 'a transient re-read failure must not kill the router').toHaveLength(0)
    expect(guard.snapshot().state).toBe('pending')
    expect(armed, 'the retry must stay armed').toHaveLength(1)
    // REPORTED. A swallowed failure leaves a permanently unverified router
    // looking identical to a confirmed one.
    expect(seen.event('sync.router.topology_recheck_failed')).toHaveLength(1)

    // ...and it genuinely recovers rather than being wedged by the failure.
    await guard.recheckNow()
    expect(guard.snapshot().state).toBe('confirmed')
    expect(armed).toHaveLength(0)
  })

  it('an absent contract beside DURABLE OWNERSHIP ROWS is reported', async () => {
    // THE BLIND SPOT OF THE ABSENT BRANCH: `topologyKey()` is
    // `${prefix}:sync-cell:topology`, so a router pointed at a different Redis
    // or a different REDIS_KEY_PREFIX reads nothing, calls it a cold start, and
    // AGREES — then resolves no owner for any workspace, forever, having
    // reported success. Absence beside durable rows says PostgreSQL has been
    // serving workspaces this router's Redis has never seen a cell claim.
    const redis = redisHolding(null)
    const seen = recorder()
    const { options } = guardOptions(redis.runtime, { ...seen, db: dbWith(3) })
    await startRouterTopologyGuard(options)

    const reported = seen.event('sync.router.contract_absent_with_durable_rows')
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({ ownershipRows: 3 })
    expect(String(reported[0]!.detail)).toContain('REDIS_KEY_PREFIX')

    // IT COUNTS EVERY ROW, NOT THE UNRELEASED ONES — asserted on the SQL,
    // because the fake returns whatever count it is asked for and cannot show
    // WHICH rows were counted. `restore:reset-routing --apply` releases every
    // row and is run BEFORE the restart, so a survey filtered with
    // `WHERE released_at IS NULL` would be silent on precisely the documented
    // procedure this detector exists for. The integration arm in
    // `topologyIdentity.integration.test.ts` pins the same property against a
    // real table; this one fails faster and without services.
    expect(statements.at(-1)).toContain('FROM sync_workspace_ownership')
    expect(statements.at(-1), 'the survey must not filter to unreleased rows').not.toMatch(/released_at/)
  })

  it('a MALFORMED row count is reported as a failed survey, not as no rows', async () => {
    // `Number()` of anything non-numeric is NaN and `NaN > 0` is FALSE, so a
    // reply the decode does not recognise would silently disarm the detector —
    // the same hazard `ensureTopology` enumerates against in `ownership.ts`.
    const redis = redisHolding(null)
    const seen = recorder()
    const { options } = guardOptions(redis.runtime, { ...seen, db: dbWith('not-a-number') })
    const guard = await startRouterTopologyGuard(options)

    expect(seen.event('sync.router.contract_absent_with_durable_rows')).toHaveLength(0)
    expect(seen.event('sync.router.durable_row_survey_failed')).toHaveLength(1)
    expect(guard.snapshot().state).toBe('pending')
  })

  it('the snapshot names the contract, and the state it reports after a fatal is NOT confirmed', async () => {
    // `contract` is published on `/api/ready`, so it is asserted. And the early
    // return after `onFatal` needs a witness — without it the guard falls through and
    // sets `state = 'confirmed'`, so `/api/ready` would report a confirmed
    // topology on a router that had just detected a fatal mismatch and is on its
    // way down. That is the worst possible reading for an operator.
    let contract: string | null = null
    const redis = redisHolding(() => contract)
    const seen = recorder()
    const { options } = guardOptions(redis.runtime, seen)
    const guard = await startRouterTopologyGuard(options)
    expect(guard.snapshot().contract).toBe(`${GENERATION}|2`)

    contract = `${GENERATION}|8`
    await guard.recheckNow()
    expect(seen.fatal).toHaveLength(1)
    expect(guard.snapshot().state, 'a router that just went fatal must not read confirmed').toBe('pending')
    expect(guard.snapshot().contractPresent).toBe(false)
  })

  it('the re-read interval is the one it was given', async () => {
    // The scheduler's `ms` argument is recorded, so the interval itself is
    // pinned. A re-read that runs eight minutes late is the cold-start hole
    // again, just slower.
    const redis = redisHolding(null)
    const delays: number[] = []
    const guard = await startRouterTopologyGuard({
      store: storeOn(redis.runtime),
      partitionCount: 2,
      ...recorder(),
      recheckIntervalMs: 1_234,
      setInterval: (_handler: () => void, ms: number) => { delays.push(ms); return 1 },
      clearInterval: () => {},
    })

    expect(guard.snapshot().state).toBe('pending')
    expect(delays).toEqual([1_234])

    // ...AND THE DEFAULT IS BOUNDED. The line above only proves the parameter is
    // forwarded. Bounded rather than pinned to a literal, deliberately: a
    // gate that false-reds on a legitimate re-tuning is one that gets deleted.
    // What matters is that the re-read happens on a human timescale — an
    // eight-minute deferral is the cold-start hole again, just slower.
    const defaults: number[] = []
    await startRouterTopologyGuard({
      store: storeOn(redisHolding(null).runtime),
      partitionCount: 2,
      ...recorder(),
      setInterval: (_handler: () => void, ms: number) => { defaults.push(ms); return 1 },
      clearInterval: () => {},
    })
    expect(defaults).toHaveLength(1)
    expect(defaults[0]).toBeGreaterThan(0)
    expect(defaults[0], 'the default re-read interval is too slow to close the cold-start hole')
      .toBeLessThanOrEqual(30_000)
  })

  it('a re-read in flight is not started twice, and a settled contract is not re-read', async () => {
    // Neither guard is a correctness barrier — removing either leaves `state`
    // intact — so this arm pins what they ACTUALLY buy: one deduplicated round
    // trip, and one deduplicated `onFatal` delivery.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let reads = 0
    const store = {
      async verifyTopology() {
        reads += 1
        if (reads > 1) await gate
        return { known: reads > 1, agreed: true, expected: `${GENERATION}|2`, found: reads > 1 ? `${GENERATION}|2` : null }
      },
    }
    const seen = recorder()
    const guard = await startRouterTopologyGuard({
      store: store as never, partitionCount: 2, ...seen,
      setInterval: () => 1, clearInterval: () => {},
    })
    expect(reads).toBe(1)

    const first = guard.recheckNow()
    const second = guard.recheckNow()
    expect(reads, 'the second call must not start another read').toBe(2)
    release()
    await Promise.all([first, second])
    expect(guard.snapshot()).toMatchObject({ state: 'confirmed', rechecks: 1 })

    // ...and a confirmed guard does not read again.
    await guard.recheckNow()
    expect(reads).toBe(2)
  })

  it('both error types carry a stable code and name', async () => {
    // The machine-readable half of "a NAMED error".
    const mismatch = new SyncCellRouterTopologyMismatchError('a|1', 'a|2')
    expect(mismatch.code).toBe('sync_cell_router_topology_mismatch')
    expect(mismatch.name).toBe('SyncCellRouterTopologyMismatchError')
    const unreadable = new SyncCellRouterTopologyUnreadableError('a|1', new Error('boom'))
    expect(unreadable.code).toBe('sync_cell_router_topology_unreadable')
    expect(unreadable.name).toBe('SyncCellRouterTopologyUnreadableError')
    expect(mismatch.code).not.toBe(unreadable.code)
  })

  it('...and stays SILENT on a genuine cold start with an empty table', async () => {
    // THE CONTROL that makes the arm above mean anything. A first deployment has
    // no contract AND no rows; a detector firing there would be noise on day one
    // of every install, which is how a detector gets deleted.
    const redis = redisHolding(null)
    const seen = recorder()
    const { options } = guardOptions(redis.runtime, { ...seen, db: dbWith(0) })
    await startRouterTopologyGuard(options)

    expect(seen.event('sync.router.contract_absent_with_durable_rows')).toHaveLength(0)
  })

  it('...and does not report ZERO rows when the survey itself failed', async () => {
    // A survey that threw knows nothing; reporting that as "no rows" is the
    // silent-failure shape. It warns about the survey instead, and the router
    // still boots — a broken detector must not become an outage.
    const redis = redisHolding(null)
    const seen = recorder()
    const { options } = guardOptions(redis.runtime, { ...seen, db: dbWith(new Error('relation does not exist')) })
    const guard = await startRouterTopologyGuard(options)

    expect(seen.event('sync.router.contract_absent_with_durable_rows')).toHaveLength(0)
    expect(seen.event('sync.router.durable_row_survey_failed')).toHaveLength(1)
    expect(guard.snapshot().state).toBe('pending')
  })

  it('the whole policy READS and never writes', async () => {
    // Asserted rather than trusted, through the path routerMain actually takes.
    // A router that CREATED the contract would define a topology nobody agreed
    // to, and would make the first cell's `ensureTopology` report `matched`
    // instead of `created` — silently disarming the cells' rebuilt-Redis detector,
    // which keys on exactly that bit. The fake throws on any command but GET.
    const redis = redisHolding(null)
    const seen = recorder()
    const { options } = guardOptions(redis.runtime, seen)
    const guard = await startRouterTopologyGuard(options)
    await guard.recheckNow()

    expect(redis.commands.map((c) => c[0])).toEqual(['GET', 'GET'])
    expect(redis.commands[0]![1]).toBe('test-prefix:sync-cell:topology')
  })

  it('routerMain wires it BEFORE it can route', () => {
    // What executing the policy still cannot show: that the boot path calls it,
    // and calls it early enough. `routerMain.ts` is a top-level script with side
    // effects — importing it starts a server, a Redis connection and a pool — so
    // the CALL SITE is read from source while the POLICY above is executed.
    //
    // Said plainly rather than left implicit: this half is a source check, and
    // it is load-bearing for one property only — ordering. A guard armed after
    // `server.listen` would leave a window in which an upgrade is accepted on an
    // unverified topology, and no unit test on the policy can see that.
    // COMMENTS STRIPPED FIRST: `/onFatal:/` and `/process\.exit\(1\)/` would
    // match commented-out code (`// was process.exit(1)`) perfectly well. With
    // `onFatal` gone the guard falls back to its default no-op, so a router that
    // DETECTS a fatal mismatch after boot would log it and keep serving. A regex
    // over raw source asserts what the file SAYS; stripping comments is what
    // makes it assert what the file DOES.
    const raw = readFileSync(
      fileURLToPath(new URL('./routerMain.ts', import.meta.url)),
      'utf8',
    )
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n')
    // The strip must not have eaten the file: a broken strip would make every
    // `indexOf` below return -1, and -1 < anything is a passing comparison.
    expect(source.length, 'comment stripping consumed the file').toBeGreaterThan(raw.length / 2)

    const verifyAt = source.indexOf('startRouterTopologyGuard(')
    const readyAt = source.indexOf('redisRuntime.start()')
    const handlerAt = source.indexOf('createOwnerAwareWsUpgradeHandler({')
    const listenAt = source.indexOf('server.listen(')

    // EVERY anchor guarded, including `readyAt`: `expect(-1).toBeLessThan(verifyAt)`
    // passes, so an unfindable `redisRuntime.start()` would silently switch off
    // the "after Redis is up" check.
    expect(verifyAt, 'routerMain never starts the topology guard').toBeGreaterThan(-1)
    expect(readyAt, 'routerMain no longer starts Redis before the guard').toBeGreaterThan(-1)
    expect(handlerAt, 'routerMain no longer builds an upgrade handler').toBeGreaterThan(-1)
    expect(listenAt, 'routerMain no longer listens').toBeGreaterThan(-1)
    // AFTER Redis is up — it cannot read a contract through a connection that
    // does not exist — and BEFORE anything can accept a socket.
    expect(readyAt).toBeLessThan(verifyAt)
    expect(verifyAt).toBeLessThan(handlerAt)
    expect(verifyAt).toBeLessThan(listenAt)
    // AWAITED. A floating promise verifies concurrently with the listen, which
    // is the ordering defect wearing the correct source order.
    expect(source).toMatch(/await startRouterTopologyGuard\(/)
    // The executed store/guard cases above do not execute this entry script.
    // Pin both fleet options as well as ordering, with comments stripped.
    const storeWiring = /new FencedPartitionLeaseStore\(redisRuntime,\s*partition\.topologyGeneration,\s*partition\.placementMode,\s*partition\.reservedPartitions\s*\)/
    expect(source).toMatch(storeWiring)
    expect(source.replace(/,\s*partition\.reservedPartitions(?=\s*\))/, '')).not.toMatch(storeWiring)
    // ...and the fatal path is WIRED and lethal — the only witness that a
    // post-boot disagreement takes the router down, which is the whole
    // justification for letting it start on an absent contract.
    expect(source).toMatch(/onFatal:\s*\(/)
    expect(source).toMatch(/process\.exit\(1\)/)
    // ...and the guard's snapshot reaches the `/api/ready` PAYLOAD, or the state
    // it computes has no consumer and an operator cannot tell `pending` from
    // `confirmed`. Scoped to the response body rather than the file: asserting
    // only that `snapshot()` is CALLED would pass with the call site surviving
    // as an unused local.
    expect(source).toMatch(/topologyGuard\.snapshot\(\)/)
    // The payload is built by the pure `routerReadinessReport`
    // (`runtime/readiness.ts`), so the snapshot reaches the payload in two
    // steps, each with its own witness: it is handed to the report HERE, and
    // the report's arms in `readiness.test.ts` assert `topology` is in the body.
    expect(source, 'the guard snapshot never reaches the /api/ready payload')
      .toMatch(/\/api\/ready[\s\S]*?routerReadinessReport\(\{[\s\S]{0,400}?\btopology: topologyGuard\.snapshot\(\)/)
    expect(source).toMatch(/topologyGuard\.stop\(\)/)
  })
})
