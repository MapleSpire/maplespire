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

import { createHash, randomBytes } from 'node:crypto'
import { createClient } from 'redis'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { RedisRuntime } from '../runtime/redis.js'
import {
  FencedPartitionLeaseStore,
  FencedWorkspaceLeaseStore,
  syncCellOwnershipConfig,
  type FencedLease,
} from './ownership.js'

const TEST_REDIS_URL = process.env.TEST_REDIS_URL

describe.skipIf(!TEST_REDIS_URL)('placed acquire atomic census (T-10h3)', () => {
  const prefix = `test:placement-acquire:${randomBytes(8).toString('hex')}`
  const client = createClient({ url: TEST_REDIS_URL })
  const workspace = { landscapeId: 'land-placement', versionId: 'version-placement' }
  const digest = createHash('sha256').update(workspace.landscapeId).update(Buffer.from([0]))
    .update(workspace.versionId).digest('hex')
  const ownerKey = `${prefix}:sync-cell:owner:${digest}`
  const sequenceKey = `${prefix}:sync-cell:fence:${digest}`
  const authorityKey = `${prefix}:sync-cell:authority:${digest}`
  const runtime = {
    configured: true,
    get ready() { return client.isReady },
    prefix,
    send<T>(args: string[]) { return client.sendCommand(args) as Promise<T> },
  } as unknown as RedisRuntime
  const settings = (mode: 'shadow' | 'placed' = 'placed', generation = 'placement-acquire', count = 3) => syncCellOwnershipConfig({
    SYNC_CELL_OWNERSHIP: 'on', SYNC_CELL_ID: 'fixture', SYNC_CELL_PARTITION_COUNT: String(count),
    SYNC_CELL_MULTI_PARTITION: 'on', SYNC_CELL_PLACEMENT_MODE: mode,
    SYNC_CELL_TOPOLOGY_GENERATION: generation,
  })
  function stores(mode: 'shadow' | 'placed' = 'placed', generation = 'placement-acquire', count = 3) {
    const config = settings(mode, generation, count)
    return {
      workspace: new FencedWorkspaceLeaseStore(runtime, config.effectiveGeneration, config),
      partition: new FencedPartitionLeaseStore(runtime, config.effectiveGeneration, config.placementMode),
      config,
    }
  }
  async function partition(store: FencedPartitionLeaseStore, index: number, cellId: string): Promise<FencedLease> {
    const lease = await store.acquire(index, cellId, 60_000, `http://${cellId}:3030`)
    expect(lease).not.toBeNull()
    return lease!
  }
  async function initial(mode: 'shadow' | 'placed' = 'placed') {
    const store = stores(mode)
    // The incumbent is deliberately in the last census slot, not index zero.
    const a = await partition(store.partition, 2, 'cell-a')
    const b = await partition(store.partition, 0, 'cell-b')
    const acquired = await store.workspace.acquireForPartition(workspace, 'cell-a', 60_000,
      store.partition.proof(2, a, 3))
    expect(acquired.acquired).not.toBeNull()
    expect(await client.get(ownerKey)).toBe(acquired.acquired!.ownerValue)
    expect(await client.get(sequenceKey)).toBe(acquired.acquired!.token)
    return { store, a, b, lease: acquired.acquired! }
  }

  beforeAll(async () => { await client.connect() })
  afterEach(async () => {
    const keys: string[] = []
    for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) keys.push(...batch)
    if (keys.length) await client.sendCommand(['DEL', ...keys])
  })
  afterAll(async () => { if (client.isOpen) await client.close() })

  it('refuses a live other partition without minting, then acquires after exact release', async () => {
    const { store, b, lease } = await initial()
    await expect(store.workspace.acquireForPartition(workspace, 'cell-b', 60_000,
      store.partition.proof(0, b, 3))).resolves.toEqual({
      acquired: null, refusal: 'placement-incumbent-live', incumbent: lease.ownerValue,
    })
    expect(await client.get(ownerKey)).toBe(lease.ownerValue)
    expect(await client.get(sequenceKey)).toBe(lease.token)
    expect(await store.workspace.release(workspace, lease)).toBe(true)
    const next = await store.workspace.acquireForPartition(workspace, 'cell-b', 60_000,
      store.partition.proof(0, b, 3))
    expect(next.acquired).not.toBeNull()
    expect(BigInt(next.acquired!.token)).toBeGreaterThan(BigInt(lease.token))
  })

  it('immediately takes over the same dead partition while its workspace TTL still lives', async () => {
    const { store, a, lease } = await initial()
    expect(await store.partition.release(2, a)).toBe(true)
    const replacement = await partition(store.partition, 2, 'cell-replacement')
    expect(await client.pTTL(ownerKey)).toBeGreaterThan(0)
    const next = await store.workspace.acquireForPartition(workspace, 'cell-replacement', 60_000,
      store.partition.proof(2, replacement, 3))
    expect(next.acquired).not.toBeNull()
    expect(BigInt(next.acquired!.token)).toBeGreaterThan(BigInt(lease.token))
  })

  it('preserves the shadow takeover behavior between live partitions', async () => {
    const { store, b, lease } = await initial('shadow')
    const next = await store.workspace.acquireForPartition(workspace, 'cell-b', 60_000,
      store.partition.proof(0, b))
    expect(next.acquired).not.toBeNull()
    expect(BigInt(next.acquired!.token)).toBeGreaterThan(BigInt(lease.token))
  })

  it('keeps stale-proof and foreign-generation refusals ahead of placement', async () => {
    const { store, b, lease } = await initial()
    await expect(store.workspace.acquireForPartition(workspace, 'cell-b', 60_000,
      { ...store.partition.proof(0, b, 3), ownerValue: 'stale|999|http://cell-b:3030' }))
      .resolves.toEqual({ acquired: null, refusal: 'partition-proof-stale', incumbent: null })
    const foreign = stores('placed', 'placement-successor')
    const nextPartition = await partition(foreign.partition, 0, 'cell-successor')
    await expect(foreign.workspace.acquireForPartition(workspace, 'cell-successor', 60_000,
      foreign.partition.proof(0, nextPartition, 3)))
      .resolves.toEqual({ acquired: null, refusal: 'foreign-generation', incumbent: lease.ownerValue })
    expect(await client.get(ownerKey)).toBe(lease.ownerValue)
    expect(await client.get(sequenceKey)).toBe(lease.token)
  })

  it('rejects incomplete or wrong-generation census inputs before acquisition', async () => {
    const { store, b, lease } = await initial()
    const proof = store.partition.proof(0, b, 3)
    for (const partitionOwnerKeys of [undefined, proof.partitionOwnerKeys!.slice(0, 2),
      proof.partitionOwnerKeys!.map(key => key.replace(store.config.effectiveGeneration, 'other-generation'))]) {
      await expect(store.workspace.acquireForPartition(workspace, 'cell-b', 60_000,
        { ...proof, partitionOwnerKeys })).rejects.toThrow('complete canonical partition proof census')
    }
    expect(await client.get(ownerKey)).toBe(lease.ownerValue)
    expect(await client.get(sequenceKey)).toBe(lease.token)
  })

  it('does not interpret an unreadable other partition owner as a dead holder', async () => {
    const { store, a, b, lease } = await initial()
    // Exercise the compatibility census for an owner predating the index.
    await client.del(authorityKey)
    await client.set(store.partition.proof(2, a, 3).ownerKey, 'unreadable')
    await expect(store.workspace.acquireForPartition(workspace, 'cell-b', 60_000,
      store.partition.proof(0, b, 3))).rejects.toThrow('Invalid partition owner in placement census')
    expect(await client.get(ownerKey)).toBe(lease.ownerValue)
    expect(await client.get(sequenceKey)).toBe(lease.token)
  })

  it.each(['delete', 'expire'])('preserves live partition authority after workspace owner %s', async loss => {
    const { store, a, b, lease } = await initial()
    const authority = await client.get(authorityKey)
    expect(JSON.parse(authority!)).toEqual({ ownerValue: lease.ownerValue,
      partitionOwnerKey: store.partition.proof(2, a, 3).ownerKey, partitionOwnerValue: a.ownerValue })
    expect(await client.pTTL(authorityKey)).toBe(-1)
    if (loss === 'delete') await client.del(ownerKey)
    else {
      await client.pExpire(ownerKey, 1)
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    expect(await client.get(ownerKey)).toBeNull()
    await expect(store.workspace.acquireForPartition(workspace, 'cell-b', 60_000,
      store.partition.proof(0, b, 3))).resolves.toEqual({
      acquired: null, refusal: 'placement-incumbent-live', incumbent: lease.ownerValue,
    })
    expect(await client.get(sequenceKey)).toBe(lease.token)
    expect(await client.get(authorityKey)).toBe(authority)
    // release returns whether the owner key was deleted, while its matching
    // authority index must also be removed when that owner is already absent.
    expect(await store.workspace.release(workspace, lease)).toBe(false)
    expect(await client.get(authorityKey)).toBeNull()
    expect((await store.workspace.acquireForPartition(workspace, 'cell-b', 60_000,
      store.partition.proof(0, b, 3))).acquired).not.toBeNull()
  })

  it('allows recovery by the same partition and protects T2 from late release T1', async () => {
    const { store, a, lease } = await initial()
    await client.del(ownerKey)
    const recovered = await store.workspace.acquireForPartition(workspace, 'cell-a', 60_000,
      store.partition.proof(2, a, 3))
    expect(recovered.acquired).not.toBeNull()
    expect(BigInt(recovered.acquired!.token)).toBeGreaterThan(BigInt(lease.token))
    const index = await client.get(authorityKey)
    expect(JSON.parse(index!).ownerValue).toBe(recovered.acquired!.ownerValue)
    expect(await store.workspace.release(workspace, lease)).toBe(false)
    expect(await client.get(authorityKey)).toBe(index)
    expect(await client.get(ownerKey)).toBe(recovered.acquired!.ownerValue)
  })

  it('uses the exact old partition incarnation, not a recycled cellId', async () => {
    const { store, a, b, lease } = await initial()
    expect(await store.partition.release(2, a)).toBe(true)
    const replacement = await partition(store.partition, 2, 'cell-a')
    expect(replacement.ownerValue).not.toBe(a.ownerValue)
    const next = await store.workspace.acquireForPartition(workspace, 'cell-b', 60_000,
      store.partition.proof(0, b, 3))
    expect(next.acquired).not.toBeNull()
    expect(BigInt(next.acquired!.token)).toBeGreaterThan(BigInt(lease.token))
  })

  it.each(['not-json', '{}', '{"ownerValue": "cell-a|1|generation", "extra": true}',
    '{"ownerValue":"cell-a|0|generation","partitionOwnerKey":"key","partitionOwnerValue":"cell-a|1|url"}',
    '{"ownerValue":"cell-a|1|generation","partitionOwnerKey":"key","partitionOwnerValue":"cell-a|0|url"}'])(
    'rejects corrupt authority %s without minting or renewing', async raw => {
      const { store, b, lease } = await initial()
      await client.set(authorityKey, raw)
      await expect(store.workspace.acquireForPartition(workspace, 'cell-b', 60_000,
        store.partition.proof(0, b, 3))).rejects.toThrow('Invalid placement authority')
      await expect(store.workspace.renew(workspace, lease, 60_000)).rejects.toThrow('Invalid placement authority')
      await expect(store.workspace.release(workspace, lease)).rejects.toThrow('Invalid placement authority')
      expect(await client.get(ownerKey)).toBe(lease.ownerValue)
      expect(await client.get(sequenceKey)).toBe(lease.token)
      expect(await client.get(authorityKey)).toBe(raw)
    })

  it('does not confirm renewal without its index; central acquisition rebuilds it with a new token', async () => {
    const { store, a, lease } = await initial()
    await client.del(authorityKey)
    expect(await store.workspace.renew(workspace, lease, 60_000)).toBe(false)
    expect(await client.get(authorityKey)).toBeNull()
    const recovered = await store.workspace.acquireForPartition(workspace, 'cell-a', 60_000,
      store.partition.proof(2, a, 3))
    expect(recovered.acquired).not.toBeNull()
    expect(JSON.parse((await client.get(authorityKey))!).ownerValue).toBe(recovered.acquired!.ownerValue)
  })

  it.each(['absent', 'replaced'] as const)(
    'allows a dead foreign partition (%s) only after its workspace owner is gone', async death => {
      const { store, a, lease } = await initial()
      const successor = stores('placed', 'placement-next', 1)
      const claimant = await partition(successor.partition, 0, 'cell-next')
      const acquire = () => successor.workspace.acquireForPartition(workspace, 'cell-next', 60_000,
        successor.partition.proof(0, claimant, 1))
      expect(await store.partition.release(2, a)).toBe(true)
      if (death === 'replaced') {
        const replacement = await partition(store.partition, 2, 'cell-a')
        expect(replacement.ownerValue).not.toBe(a.ownerValue)
      }
      // Existing owner semantics are unchanged, even though its partition is dead.
      await expect(acquire()).resolves.toEqual({
        acquired: null, refusal: 'foreign-generation', incumbent: lease.ownerValue,
      })
      expect(await client.get(sequenceKey)).toBe(lease.token)
      await client.del(ownerKey)
      // Old index 2 is valid even though the new topology only has index 0.
      const next = await acquire()
      expect(next.acquired).not.toBeNull()
      expect(BigInt(next.acquired!.token)).toBeGreaterThan(BigInt(lease.token))
      expect(JSON.parse((await client.get(authorityKey))!).ownerValue).toBe(next.acquired!.ownerValue)
    })

  it('still refuses an absent foreign owner whose exact partition incarnation is live', async () => {
    const { lease } = await initial()
    const successor = stores('placed', 'placement-next', 1)
    const claimant = await partition(successor.partition, 0, 'cell-next')
    await client.del(ownerKey)
    await expect(successor.workspace.acquireForPartition(workspace, 'cell-next', 60_000,
      successor.partition.proof(0, claimant, 1))).resolves.toEqual({
      acquired: null, refusal: 'foreign-generation', incumbent: lease.ownerValue,
    })
    expect(await client.get(sequenceKey)).toBe(lease.token)
    expect(JSON.parse((await client.get(authorityKey))!).ownerValue).toBe(lease.ownerValue)
  })

  it('accepts a dead authority outside the resized count with the same effective generation', async () => {
    const { store, a, b, lease } = await initial()
    expect(await store.partition.ensureTopology(3)).toEqual({ agreed: true, created: true })
    // This is the store-level maintenance boundary: both old partition owners
    // are gone, then only the topology contract is reset. No placement row is
    // required: hash fallback also changes when a fleet shrinks.
    expect(await store.partition.release(2, a)).toBe(true)
    expect(await store.partition.release(0, b)).toBe(true)
    await client.del(ownerKey)
    await client.del(`${prefix}:sync-cell:topology`)
    const resized = stores('placed', 'placement-acquire', 1)
    expect(resized.config.effectiveGeneration).toBe(store.config.effectiveGeneration)
    expect(await resized.partition.ensureTopology(1)).toEqual({ agreed: true, created: true })
    expect(await resized.partition.verifyTopology(1)).toMatchObject({ known: true, agreed: true })
    expect(JSON.parse((await client.get(authorityKey))!).partitionOwnerKey)
      .toBe(store.partition.proof(2, a, 3).ownerKey)
    const claimant = await partition(resized.partition, 0, 'cell-resized')
    const next = await resized.workspace.acquireForPartition(workspace, 'cell-resized', 60_000,
      resized.partition.proof(0, claimant, 1))
    expect(next.acquired).not.toBeNull()
    expect(BigInt(next.acquired!.token)).toBeGreaterThan(BigInt(lease.token))
    expect(JSON.parse((await client.get(authorityKey))!).partitionOwnerKey)
      .toBe(resized.partition.proof(0, claimant, 1).ownerKey)
  })

  it.each(['wrong-prefix', 'leading-zero', 'outside-max', 'suffix'] as const)(
    'rejects a malformed foreign authority key: %s', async corruption => {
      const { store, a, lease } = await initial()
      const successor = stores('placed', 'placement-next', 1)
      const claimant = await partition(successor.partition, 0, 'cell-next')
      const index = JSON.parse((await client.get(authorityKey))!)
      const base = `${prefix}:sync-cell:partition:${store.config.effectiveGeneration}:`
      index.partitionOwnerKey = corruption === 'wrong-prefix' ? `wrong:${store.partition.proof(2, a, 3).ownerKey}`
        : corruption === 'leading-zero' ? `${base}02:owner`
          : corruption === 'outside-max' ? `${base}1024:owner` : `${base}2:owner:suffix`
      await client.del(ownerKey)
      await client.set(authorityKey, JSON.stringify(index))
      await expect(successor.workspace.acquireForPartition(workspace, 'cell-next', 60_000,
        successor.partition.proof(0, claimant, 1))).rejects.toThrow('Invalid foreign placement authority partition key')
      expect(await client.get(sequenceKey)).toBe(lease.token)
      expect(JSON.parse((await client.get(authorityKey))!)).toEqual(index)
    })

  it.each(['wrong-prefix', 'leading-zero', 'outside-max', 'suffix'] as const)(
    'rejects a malformed same-generation authority key: %s', async corruption => {
      const { store, a, b, lease } = await initial()
      const index = JSON.parse((await client.get(authorityKey))!)
      const base = `${prefix}:sync-cell:partition:${store.config.effectiveGeneration}:`
      index.partitionOwnerKey = corruption === 'wrong-prefix' ? `wrong:${store.partition.proof(2, a, 3).ownerKey}`
        : corruption === 'leading-zero' ? `${base}02:owner`
          : corruption === 'outside-max' ? `${base}1024:owner` : `${base}2:owner:suffix`
      await client.del(ownerKey)
      await client.set(authorityKey, JSON.stringify(index))
      await expect(store.workspace.acquireForPartition(workspace, 'cell-b', 60_000,
        store.partition.proof(0, b, 3))).rejects.toThrow('Invalid placement authority partition key')
      expect(await client.get(sequenceKey)).toBe(lease.token)
      expect(JSON.parse((await client.get(authorityKey))!)).toEqual(index)
    })
})
