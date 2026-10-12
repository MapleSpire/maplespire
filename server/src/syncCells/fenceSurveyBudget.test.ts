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
import { FencedWorkspaceLeaseStore, syncCellOwnershipConfig } from './ownership.js'

/**
 * The fence survey's request stays small, and the bound is asserted against the
 * code that SENDS rather than against a copy of its arithmetic.
 *
 * WHY THE REQUEST AND NOT THE REPLY. Measured: a fence key is
 * `<prefix>:sync-cell:fence:<sha256 hex>`, ~91 bytes on the shipped prefix
 * whatever the workspace ids are, so a fixed 512-key chunk is a 58 KB command.
 * The cost of an MGET steps by 95x between 16 297 and 18 105 request bytes —
 * `ECHO` of ONE large string steps at the same place, so it is neither the
 * argument count nor the key lookups.
 *
 * These tests drive `workspacesWithoutSequence` itself: a helper that mirrored
 * the production loop's arithmetic would test the copy, not the code that runs.
 */

interface Issued { args: string[] }

/** Records what actually went to Redis and answers positionally, so the tests
 * below observe the SHIPPED loop rather than a description of it. */
function recording(prefix: string): { store: FencedWorkspaceLeaseStore; issued: Issued[] } {
  const issued: Issued[] = []
  const store = new FencedWorkspaceLeaseStore({
    configured: true,
    ready: true,
    prefix,
    async send<T>(args: string[]): Promise<T> {
      issued.push({ args })
      // One value per key, all present — this file is about the request.
      return args.slice(1).map(() => '7') as T
    },
  } as unknown as RedisRuntime)
  return { store, issued }
}

const workspaces = (count: number) => Array.from({ length: count }, (unused, index) => ({
  landscapeId: `landscape-${index}`,
  versionId: `version-${index}`,
}))

/** Independently re-derived, NOT imported and NOT read back off the store.
 *
 * A control computed from its own subject is a naming convention, not a
 * detector. `Buffer.byteLength` and not `.length` for the same reason the
 * production helper uses it — the non-ASCII case below is what makes the two
 * differ, and a checker written in code units would agree with the mutant. */
const wireBytes = (key: string): number =>
  Buffer.byteLength(key) + String(Buffer.byteLength(key)).length + 5

const requestBytes = (command: Issued): number =>
  command.args.slice(1).reduce((total, key) => total + wireBytes(key), 0)

/** The measured step, from a sweep: flat below
 * 16 297 bytes, 95x above 18 105. */
const MEASURED_STEP_LOWER_BOUND = 16_297

describe('R3 survey chunking', () => {
  it('keeps every REQUEST it sends below the measured step', async () => {
    const { store, issued } = recording('maplespire')
    await store.workspacesWithoutSequence(workspaces(10_000))

    expect(issued.length).toBeGreaterThan(1)
    // EVERY request, not the mean and not the last: one oversized command is
    // the entire failure mode and an average hides it perfectly.
    for (const command of issued) {
      expect(requestBytes(command)).toBeLessThan(MEASURED_STEP_LOWER_BOUND)
    }
  })

  it('pins the chunk as a KEY COUNT for a named prefix, which any budget change moves', async () => {
    // A LITERAL, and that is the point. A test that recomputed the chunk from
    // `FENCE_SURVEY_REQUEST_BUDGET_BYTES` would agree with any value that
    // constant is given, and a window like `(BUDGET/2, BUDGET]` would let the
    // budget move freely.
    //
    // `maplespire` is the shipped prefix. Key = 10 + 17 + 64 = 91 bytes; on the
    // wire 91 + 2 + 5 = 98; 12 288 / 98 = 125.
    const { store, issued } = recording('maplespire')
    expect(store.surveyKeysPerChunk()).toBe(125)
    await store.workspacesWithoutSequence(workspaces(300))
    expect(issued.map((command) => command.args.length - 1)).toEqual([125, 125, 50])
  })

  it('counts BYTES and not code units, so a non-ASCII prefix is not under-counted', async () => {
    // The stated reason bytes beat key counts, driven rather than asserted.
    // With ASCII-only fixtures, `.length` and `Buffer.byteLength` agree — and
    // under-counting is the direction that walks off the step.
    //
    // Each `é` is two bytes in UTF-8 and one code unit, so a 40-character
    // prefix of them is 80 bytes: a code-unit implementation packs the chunk as
    // if the keys were 40 bytes shorter than they are.
    const { store, issued } = recording('é'.repeat(40))
    const bytesPerKey = Buffer.byteLength(`${'é'.repeat(40)}:sync-cell:fence:${'0'.repeat(64)}`)
    expect(bytesPerKey).toBeGreaterThan(`${'é'.repeat(40)}:sync-cell:fence:${'0'.repeat(64)}`.length)
    await store.workspacesWithoutSequence(workspaces(400))
    for (const command of issued) {
      expect(requestBytes(command)).toBeLessThan(MEASURED_STEP_LOWER_BOUND)
    }
    // ...and strictly fewer keys per chunk than the ASCII prefix of the same
    // LENGTH, which is the difference a code-unit count cannot see.
    expect(store.surveyKeysPerChunk()).toBeLessThan(recording('x'.repeat(40)).store.surveyKeysPerChunk())
  })

  it('makes progress even when one key alone exceeds the budget', async () => {
    // Driven through the SHIPPED loop: deleting `Math.max(1, …)` would be an
    // infinite loop inside `start()`, before the first reconcile.
    //
    // Unreachable in production (`redisRuntimeConfig` caps the prefix at 64
    // characters), so this is a guard on the constructor accepting any
    // `LeaseRedis`, not on a live configuration. An infinite loop on absurd
    // input is still an infinite loop.
    const { store, issued } = recording('x'.repeat(20_000))
    expect(store.surveyKeysPerChunk()).toBe(1)
    await store.workspacesWithoutSequence(workspaces(3))
    expect(issued).toHaveLength(3)
    // And never a zero-key MGET, which real Redis rejects on arity while a
    // permissive fake accepts it.
    for (const command of issued) expect(command.args.length).toBeGreaterThan(1)
  })

  it('the bench compares against the timeout the SHIPPED DEFAULTS derive', async () => {
    // `qa/fence-survey-mget-bench.mjs` restates the derivation as literals so its
    // JSON can name the ceiling it measured against. That copy is a parity
    // claim, and this test is its detector.
    //
    // ON THE DEFAULTS, not on explicit inputs: passing `1500`/`400` in by hand
    // would pin the FORMULA and not the number the bench hardcodes, so a change
    // to the shipped default TTL would go unnoticed.
    const shipped = syncCellOwnershipConfig({} as NodeJS.ProcessEnv)
    expect(shipped.partitionLeaseTtlMs).toBe(1_500)
    expect(shipped.partitionRenewIntervalMs).toBe(400)
    expect(shipped.leaseCommandTimeoutMs).toBe(550)
  })
})
