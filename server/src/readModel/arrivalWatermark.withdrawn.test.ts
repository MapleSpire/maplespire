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
 * T-ZEROWM-2 (1): THE WITHDRAWN HEAD — the frontier of the one refusal a pass
 * no longer writes. `recordSampledDocumentWatermark` skips its write ONLY when
 * the handle it sampled is gone (current heads null) while sampled and
 * durable heads agree, and the caller says the head was withdrawn under the
 * pass. Every other 0 — a true hole (durable heads unlike the sample), a live
 * revision unlike the sample, no sampled heads, no durable heads — is still
 * written, withdrawn or not: no legitimate 0 depends on the skip. The
 * controls assert the WRITES only, so they hold on the version before the fix too (where the
 * function took no withdrawal and returned nothing).
 */

import { describe, expect, it } from 'vitest'

import { recordSampledDocumentWatermark, type PreparedDocumentWatermarks } from './arrivalWatermark.js'
import type { Queryable } from './types.js'

const KEY = { landscapeId: 'ls-withdrawn', versionId: 'v1' }
const SAMPLED = ['aa'.repeat(32)]
const OTHER = ['bb'.repeat(32)]

const prepared = (durable: readonly string[] | undefined): PreparedDocumentWatermarks => ({
  watermarkPost: '42',
  durableHeadsById: new Map(durable ? [['doc', durable]] : []),
})

/** The certificate statements one decision issues: [watermark, heads] each. */
async function writesOf(o: {
  sampled: readonly string[] | null
  durable: readonly string[] | undefined
  current: readonly string[] | null
  withdrawn: boolean | undefined
}) {
  const writes: { watermark: unknown; heads: unknown }[] = []
  const tx = {
    query: async (_sql: string, values?: unknown[]) => {
      writes.push({ watermark: values?.[3], heads: (values?.[4] as unknown[] | undefined)?.[0] })
      return { rows: [], rowCount: 1 }
    },
  } as unknown as Queryable
  const outcome = await recordSampledDocumentWatermark(
    tx, KEY, 'doc', o.sampled, () => o.current, prepared(o.durable),
    o.withdrawn === undefined ? undefined : () => o.withdrawn!,
  )
  return { writes, outcome }
}

describe('T-ZEROWM-2 (1) — recordSampledDocumentWatermark: a withdrawn head writes no 0, and no legitimate 0 depends on it', () => {
  it('the withdrawn head (sampled = durable, handle gone, withdrawn): nothing written', async () => {
    const { writes, outcome } = await writesOf({ sampled: SAMPLED, durable: SAMPLED, current: null, withdrawn: true })
    expect(writes, 'no certificate statement').toEqual([])
    expect(outcome).toBe('withdrawn')
  })

  it('control: the same handle gone WITHOUT a withdrawal (a replaced handle, no caller flag) still writes 0', async () => {
    for (const withdrawn of [false, undefined]) {
      const { writes } = await writesOf({ sampled: SAMPLED, durable: SAMPLED, current: null, withdrawn })
      expect(writes.map((write) => write.watermark), String(withdrawn)).toEqual(['0'])
    }
  })

  it('a TRUE HOLE (durable heads unlike the sample) is refused with 0 even when withdrawn', async () => {
    const { writes } = await writesOf({ sampled: SAMPLED, durable: OTHER, current: null, withdrawn: true })
    expect(writes).toEqual([{ watermark: '0', heads: JSON.stringify(SAMPLED) }])
  })

  it('no durable heads (no durable content, a skipped transient decode) is refused with 0 even when withdrawn', async () => {
    const { writes } = await writesOf({ sampled: SAMPLED, durable: undefined, current: null, withdrawn: true })
    expect(writes.map((write) => write.watermark)).toEqual(['0'])
  })

  it('a live revision unlike the sample (the handle still resident, moved on) is refused with 0 even when withdrawn', async () => {
    const { writes } = await writesOf({ sampled: SAMPLED, durable: SAMPLED, current: OTHER, withdrawn: true })
    expect(writes.map((write) => write.watermark)).toEqual(['0'])
  })

  it('no sampled heads is refused with 0 even when withdrawn', async () => {
    const { writes } = await writesOf({ sampled: null, durable: SAMPLED, current: null, withdrawn: true })
    expect(writes).toEqual([{ watermark: '0', heads: null }])
  })

  it('control: sampled = durable = current certifies exactly, withdrawn or not', async () => {
    for (const withdrawn of [true, false]) {
      const { writes } = await writesOf({ sampled: SAMPLED, durable: SAMPLED, current: SAMPLED, withdrawn })
      expect(writes.map((write) => write.watermark)).toEqual(['42'])
    }
  })
})
