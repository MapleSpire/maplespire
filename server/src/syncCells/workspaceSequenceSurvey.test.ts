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
import type { RedisRuntime } from '../runtime/redis.js'
import { FencedWorkspaceLeaseStore } from './ownership.js'

/**
 * The world-mismatch (R3) survey primitive, at the level the integration suite
 * cannot reach: the CHUNK BOUNDARY.
 *
 * The integration arms use three workspaces, so everything about batching —
 * the chunk boundary, the positional read of the reply, ONE `MGET` per chunk
 * rather than one per workspace — is unexercised there; off-by-one slicing or
 * offset errors would pass. This file is database-free and asserts the
 * commands actually issued.
 *
 * Chunks are bounded by REQUEST BYTES, not a key count: 512 fence keys are a
 * ~58 KB command, above Node's 16 384-byte stream high-water mark, which made
 * the request roughly 95× slower. The number of chunks is therefore a function
 * of the deployment's Redis PREFIX length, and a literal here would break with
 * the next prefix. The assertions pin the properties instead: every request
 * under the budget, the budget actually used, the chunks partitioning the set,
 * and the reply read positionally.
 */

const WORKSPACE_COUNT = 1_200
/** Mirrors `FENCE_SURVEY_REQUEST_BUDGET_BYTES`. Not imported, because the
 * constant is module-private and exporting it for a test would let the test
 * agree with any value it is given — a tautology. The bound is asserted here;
 * the CHOICE of 12 288 is a benchmark result. */
const BUDGET_BYTES = 12_288
/** One key's cost on the wire: the key, its `$NN` length prefix, two CRLFs. */
const wireBytes = (key: string): number => key.length + String(key.length).length + 5
/** Indexes deliberately chosen to spread across chunks, and the LAST of them
 * is in the short final chunk (with ~130-key chunks, 1185 lands in the
 * 30-key tail). If the budget changes, re-check that the last index still
 * falls in the short chunk. */
const MISSING = [5, 700, 1185]

interface Issued { args: string[] }

function recordingRedis(missing: ReadonlySet<number>, keyIndexOf: Map<string, number>): {
  runtime: RedisRuntime
  issued: Issued[]
} {
  const issued: Issued[] = []
  const runtime = {
    configured: true,
    ready: true,
    prefix: 'survey',
    async send<T>(args: string[]): Promise<T> {
      issued.push({ args })
      if (args[0] !== 'MGET') throw new Error(`unexpected command: ${args[0]}`)
      // Positional reply, exactly as Redis answers: one value per key, `null`
      // where the key is absent.
      return args.slice(1).map((key) => {
        const index = keyIndexOf.get(key)
        if (index === undefined) throw new Error(`survey asked for an unknown key: ${key}`)
        return missing.has(index) ? null : '7'
      }) as T
    },
  } as unknown as RedisRuntime
  return { runtime, issued }
}

describe('workspacesWithoutSequence — the chunk boundary', () => {
  const workspaces = Array.from({ length: WORKSPACE_COUNT }, (unused, index) => ({
    landscapeId: 'landscape-1',
    versionId: `version-${index}`,
  }))

  /** The store derives its keys by hashing; the test must not re-derive them or
   * it would be asserting against its own copy of the derivation. Ask the store
   * for each key one workspace at a time, through the same public entry point. */
  async function keyIndex(store: FencedWorkspaceLeaseStore): Promise<Map<string, number>> {
    const map = new Map<string, number>()
    for (const [index, workspace] of workspaces.entries()) {
      const probe = recordingRedis(new Set(), new Map())
      const single = new FencedWorkspaceLeaseStore(probe.runtime)
      // One workspace at a time, so the single MGET's only key is this one's.
      await single.workspacesWithoutSequence([workspace]).catch(() => undefined)
      map.set(probe.issued[0]!.args[1]!, index)
    }
    expect(map.size).toBe(WORKSPACE_COUNT)
    void store
    return map
  }

  it('batches under the request-byte budget and reads the replies positionally', async () => {
    const missing = new Set(MISSING)
    const probeStore = new FencedWorkspaceLeaseStore(recordingRedis(missing, new Map()).runtime)
    const keyIndexOf = await keyIndex(probeStore)

    const { runtime, issued } = recordingRedis(missing, keyIndexOf)
    const store = new FencedWorkspaceLeaseStore(runtime)
    const found = await store.workspacesWithoutSequence(workspaces)

    // MORE THAN ONE and FEWER THAN ONE PER WORKSPACE. A per-workspace GET issues
    // 1 200 commands — which is the failure the batch exists to avoid, and it is
    // invisible to a test that only counts the answer.
    expect(issued.length).toBeGreaterThan(1)
    expect(issued.length).toBeLessThan(WORKSPACE_COUNT / 10)
    expect(issued.every((command) => command.args[0] === 'MGET')).toBe(true)

    // EVERY request under the budget — not the average, not the last. One
    // oversized request is the whole failure mode and a mean hides it.
    const sizes = issued.map((command) => command.args.slice(1).reduce((total, key) => total + wireBytes(key), 0))
    for (const bytes of sizes) expect(bytes).toBeLessThanOrEqual(BUDGET_BYTES)
    // ...and the budget actually USED, or a chunker that emitted one key per
    // request would satisfy the line above while making the survey 1 200 round
    // trips. Every chunk but the last is filled past half.
    for (const bytes of sizes.slice(0, -1)) expect(bytes).toBeGreaterThan(BUDGET_BYTES / 2)
    // No key asked for twice — the chunks PARTITION the set rather than
    // overlapping it. Both halves are needed: a chunker that re-asks each
    // boundary key still covers 1 200 DISTINCT keys, so
    // the set-size assertion alone cannot see a repeat. Only 3 of 1 200 are
    // planted missing, so the answer assertion usually cannot either.
    const asked = issued.flatMap((command) => command.args.slice(1))
    expect(new Set(asked).size).toBe(WORKSPACE_COUNT)
    expect(asked.length).toBe(WORKSPACE_COUNT)

    // And the ANSWER is the three planted ones, in order, including one in the
    // short final chunk — which is where an off-by-one on the offset lands.
    expect(found.map((workspace) => workspace.versionId))
      .toEqual(MISSING.map((index) => `version-${index}`))
  })

  it('refuses a reply LONGER than the batch, not only a short one', async () => {
    // The guard is `!==`, not `<`, so a LONG reply needs its own driver. A
    // long reply means the
    // connection is DESYNCHRONISED and the values belong to somebody else's
    // command — quieter than a short one and worse, because every value read
    // positionally is then attributed to the wrong workspace.
    const runtime = {
      configured: true,
      ready: true,
      prefix: 'survey',
      async send<T>(args: string[]): Promise<T> {
        return args.slice(1).concat(['extra']).map(() => '7') as T
      },
    } as unknown as RedisRuntime
    const store = new FencedWorkspaceLeaseStore(runtime)
    await expect(store.workspacesWithoutSequence(workspaces.slice(0, 3)))
      .rejects.toThrow(/returned 4 values for 3 keys/)
  })

  it('refuses a reply that is not an array at all', async () => {
    // The other half of the same guard. A Redis
    // that answers an error string, or a client that hands back `null`, must not
    // be read positionally — `null[0]` throws, but a string would be INDEXED
    // character by character and every workspace would read as present.
    const runtime = {
      configured: true,
      ready: true,
      prefix: 'survey',
      async send<T>(): Promise<T> { return 'OK' as T },
    } as unknown as RedisRuntime
    const store = new FencedWorkspaceLeaseStore(runtime)
    await expect(store.workspacesWithoutSequence(workspaces.slice(0, 3)))
      .rejects.toThrow(/returned string values for 3 keys/)
  })

  it('treats an undefined slot as missing, exactly as it treats null', async () => {
    // The `|| values[index] === undefined` half of the read, which a fake that
    // always answers `null` never exercises. A sparse array is
    // the shape a client can hand back after a partial parse, and reading a hole
    // as PRESENT is the direction that hides a rebuilt Redis.
    const runtime = {
      configured: true,
      ready: true,
      prefix: 'survey',
      async send<T>(args: string[]): Promise<T> {
        const values = new Array<string | null>(args.length - 1).fill('7')
        delete values[1]
        return values as T
      },
    } as unknown as RedisRuntime
    const store = new FencedWorkspaceLeaseStore(runtime)
    const found = await store.workspacesWithoutSequence(workspaces.slice(0, 3))
    expect(found.map((workspace) => workspace.versionId)).toEqual(['version-1'])
  })

  it('asks Redis nothing for an empty set', async () => {
    const { runtime, issued } = recordingRedis(new Set(), new Map())
    const store = new FencedWorkspaceLeaseStore(runtime)
    expect(await store.workspacesWithoutSequence([])).toEqual([])
    expect(issued).toEqual([])
  })

  it('refuses a reply it cannot read positionally instead of reporting a disaster', async () => {
    // A SHORT reply read positionally says "everything after the cut is
    // missing" — which is exactly the state this detector exists to report, so
    // the failure mode is a fabricated incident rather than a missed one.
    const runtime = {
      configured: true,
      ready: true,
      prefix: 'survey',
      async send<T>(): Promise<T> { return ['7'] as T },
    } as unknown as RedisRuntime
    const store = new FencedWorkspaceLeaseStore(runtime)
    await expect(store.workspacesWithoutSequence(workspaces.slice(0, 3)))
      .rejects.toThrow(/returned 1 values for 3 keys/)
  })
})
