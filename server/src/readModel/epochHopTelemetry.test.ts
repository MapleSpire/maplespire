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

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { renderPrometheus, type MetricSample } from '../runtime/metrics.js'
import {
  EPOCH_META_LOOKUP_STALE_MS,
  EPOCH_META_LOOKUP_TIMEOUT_MS,
  EpochHopTelemetry,
  HOP_CYCLE_GAP_MS,
  HOP_STALL_TRACKED_MAX,
  HOP_STALL_WINDOW_MS,
  epochHopMetricSamples,
  epochMetaDocumentIds,
  epochMetaLookupStaleMs,
  latchOutcome,
  recordDurableHeadsTelemetry,
} from './epochHopTelemetry.js'
import { awaitTriggeredForward } from './modelEpochForwardWiring.js'
import { createForwardTrigger } from './modelEpochForwardTrigger.js'

const W = { landscapeId: 'L', versionId: 'V' }
const MIN = 60_000

/** One sample's value, by metric name and (optional) label/suffix. */
function valueOf(samples: MetricSample[], name: string, labels: Record<string, string> = {}, suffix?: string): number | undefined {
  const metric = samples.find((m) => m.name === name)
  return metric?.values.find((v) => v.suffix === suffix
    && Object.entries(labels).every(([k, value]) => v.labels?.[k] === value)
    && Object.keys(v.labels ?? {}).length === Object.keys(labels).length)?.value
}

const clock = () => {
  let at = 1_000_000
  return { now: () => at, advance: (ms: number) => { at += ms } }
}

/** One hop cycle of `latches` unproven latch asks on `meta`, 60 s apart. */
function unprovenCycle(t: EpochHopTelemetry, c: ReturnType<typeof clock>, meta: string, latches = 3): void {
  for (let i = 0; i < latches; i += 1) {
    if (i > 0) c.advance(MIN)
    t.recordLatchMetas([{ documentId: meta, durable: true } as never], new Set([meta]))
  }
}

describe('G4-16j — latch asks by outcome', () => {
  it('each outcome is counted under its own label, zero-filled', () => {
    const t = new EpochHopTelemetry()
    const zero = t.samples()
    for (const outcome of ['granted', 'demoted', 'forward_busy', 'not_needed', 'failed']) {
      expect(valueOf(zero, 'maplespire_model_epoch_latch_requests_total', { outcome })).toBe(0)
    }
    t.recordLatch('granted', 10)
    t.recordLatch('granted', 10)
    t.recordLatch('forward_busy', 10)
    t.recordLatch('demoted', 10)
    t.recordLatch('not_needed', 10)
    t.recordLatch('failed', 10)
    const s = t.samples()
    expect(valueOf(s, 'maplespire_model_epoch_latch_requests_total', { outcome: 'granted' })).toBe(2)
    expect(valueOf(s, 'maplespire_model_epoch_latch_requests_total', { outcome: 'forward_busy' })).toBe(1)
    expect(valueOf(s, 'maplespire_model_epoch_latch_requests_total', { outcome: 'demoted' })).toBe(1)
    expect(valueOf(s, 'maplespire_model_epoch_latch_requests_total', { outcome: 'not_needed' })).toBe(1)
    expect(valueOf(s, 'maplespire_model_epoch_latch_requests_total', { outcome: 'failed' })).toBe(1)
  })

  it('latchOutcome: forwardBusy first, then nothing owed, then the trigger\'s grant', () => {
    expect(latchOutcome({ ended: 'timeout', granted: true }, [{ documentId: 'd', forwardPending: true, forwardBusy: true }])).toBe('forward_busy')
    expect(latchOutcome({ ended: 'not-triggered', granted: false }, [{ documentId: 'd' }])).toBe('not_needed')
    expect(latchOutcome({ ended: 'pass', granted: true }, [{ documentId: 'd', forwarded: true }])).toBe('granted')
    expect(latchOutcome({ ended: 'pass', granted: false }, [{ documentId: 'd', forwarded: true }])).toBe('demoted')
    // Every other end of a triggered wait is the trigger's decision too.
    for (const ended of ['not-waited', 'running-pass', 'timeout']) {
      expect(latchOutcome({ ended, granted: true }, [{ documentId: 'd', forwardPending: true }])).toBe('granted')
      expect(latchOutcome({ ended, granted: false }, [{ documentId: 'd', forwardPending: true }])).toBe('demoted')
    }
  })
})

describe('G4-16j — the trigger tells a granted latch from a demoted one', () => {
  it('latchGranted is the predicate request applies: past the burst in the gap, demoted', async () => {
    const c = clock()
    const trigger = createForwardTrigger(async () => undefined, { now: c.now, sleep: async () => undefined, priorityBurst: 2 })
    expect(trigger.latchGranted(W)).toBe(true)
    await trigger.request(W, { priority: true })
    expect(trigger.latchGranted(W)).toBe(true)
    await trigger.request(W, { priority: true })
    expect(trigger.latchGranted(W)).toBe(false) // two in the gap: the third is demoted
    c.advance(2_001)
    expect(trigger.latchGranted(W)).toBe(true)
  })

  it('latchGranted follows the reserved priority share too, as request does', async () => {
    const c = clock()
    const traced: Array<Record<string, unknown>> = []
    // A share of zero: no latch keeps its priority, whatever the burst.
    const trigger = createForwardTrigger(async () => undefined, {
      now: c.now, sleep: async () => undefined, priorityShare: 0, trace: (e) => traced.push(e),
    })
    expect(trigger.latchGranted(W)).toBe(false)
    await trigger.request(W, { priority: true })
    expect(traced.find((e) => e.event === 'forward_trigger.request')?.priority).toBe(false)
  })

  it('the REAL trigger through awaitTriggeredForward: a burst of 3 granted, the 4th demoted', async () => {
    // Read AFTER `request`, the third latch of a granted burst would read
    // demoted: its own stamp already counts.
    const trigger = createForwardTrigger(async () => undefined, { sleep: async () => undefined })
    const pending = [{ documentId: 'd', forwardPending: true as const }]
    const granted: boolean[] = []
    for (let i = 0; i < 4; i += 1) {
      const out = await awaitTriggeredForward({ trigger, key: W, query: { latch: '1' }, acknowledged: pending,
        reacknowledge: async () => [{ documentId: 'd', forwarded: true }], waitMs: 1_500 })
      granted.push(out.granted)
    }
    expect(granted).toEqual([true, true, true, false])
  })

  it('a refusal for the BURST is not traced as a demotion; one for the reserved share is', async () => {
    const burst: Array<Record<string, unknown>> = []
    const byBurst = createForwardTrigger(async () => undefined, { sleep: async () => undefined, trace: (e) => burst.push(e) })
    for (let i = 0; i < 4; i += 1) await byBurst.request(W, { priority: true })
    expect(burst.filter((e) => e.event === 'forward_trigger.latch_demoted')).toEqual([])
    const share: Array<Record<string, unknown>> = []
    const byShare = createForwardTrigger(async () => undefined, { sleep: async () => undefined, priorityShare: 0, trace: (e) => share.push(e) })
    await byShare.request(W, { priority: true })
    expect(share.filter((e) => e.event === 'forward_trigger.latch_demoted')).toHaveLength(1)
  })

  it('awaitTriggeredForward reports `granted` only for a latch ask the trigger kept', async () => {
    const pending = [{ documentId: 'd', forwardPending: true as const }]
    const after = [{ documentId: 'd', forwarded: true }]
    const base = { startsInMs: () => 0, request: async () => undefined }
    const run = (trigger: object, query: Record<string, unknown>) => awaitTriggeredForward({
      trigger: trigger as never, key: W, query, acknowledged: pending, reacknowledge: async () => after, waitMs: 1_500,
    })
    expect((await run({ ...base, latchGranted: () => true }, { latch: '1' })).granted).toBe(true)
    expect((await run({ ...base, latchGranted: () => false }, { latch: '1' })).granted).toBe(false)
    expect((await run({ ...base, latchGranted: () => true }, {})).granted).toBe(false)
  })
})

describe('G4-16j — latch hold histogram', () => {
  it('a hold lands in every bucket at or above it, in _sum and in _count', () => {
    const t = new EpochHopTelemetry()
    t.recordLatch('granted', 30) // 0.03 s
    t.recordLatch('granted', 1_800) // 1.8 s
    const s = t.samples()
    const bucket = (le: string) => valueOf(s, 'maplespire_model_epoch_latch_hold_seconds', { le }, '_bucket')
    expect(bucket('0.01')).toBe(0)
    expect(bucket('0.05')).toBe(1)
    expect(bucket('1.5')).toBe(1)
    expect(bucket('2')).toBe(2)
    expect(bucket('+Inf')).toBe(2)
    expect(valueOf(s, 'maplespire_model_epoch_latch_hold_seconds', {}, '_count')).toBe(2)
    expect(valueOf(s, 'maplespire_model_epoch_latch_hold_seconds', {}, '_sum')).toBeCloseTo(1.83, 6)
    const text = renderPrometheus(s)
    expect(text).toContain('# TYPE maplespire_model_epoch_latch_hold_seconds histogram\n')
    expect(text).toContain('maplespire_model_epoch_latch_hold_seconds_bucket{le="+Inf"} 2\n')
    expect(text).toContain('maplespire_model_epoch_latch_hold_seconds_count 2\n')
  })

  it('a hold exactly on a bound counts in it (le is inclusive), and the bound set is the documented one', () => {
    const t = new EpochHopTelemetry()
    t.recordLatch('granted', 50) // 0.05 s exactly
    const s = t.samples()
    expect(valueOf(s, 'maplespire_model_epoch_latch_hold_seconds', { le: '0.05' }, '_bucket')).toBe(1)
    expect(valueOf(s, 'maplespire_model_epoch_latch_hold_seconds', { le: '0.01' }, '_bucket')).toBe(0)
    expect(s.find((m) => m.name === 'maplespire_model_epoch_latch_hold_seconds')!.values
      .filter((v) => v.suffix === '_bucket').map((v) => v.labels!.le))
      .toEqual(['0.01', '0.05', '0.1', '0.25', '0.5', '1', '1.5', '2', '5', '+Inf'])
  })
})

describe('G4-16j — durable-heads answers by epoch outcome', () => {
  it('forwarded, forward_pending and epoch_retired on any ask; a forwarded:false answer is none of them', () => {
    const t = new EpochHopTelemetry()
    t.recordAnswers([
      { documentId: 'a', forwarded: true },
      { documentId: 'b', forwarded: false, forwardPending: true },
      { documentId: 'c', forwarded: false, epochRetired: true },
      { documentId: 'd', forwarded: false },
      { documentId: 'e' },
    ] as never)
    const s = t.samples()
    const answers = (outcome: string) => valueOf(s, 'maplespire_model_epoch_durable_heads_answers_total', { outcome })
    expect(answers('forwarded')).toBe(1)
    expect(answers('forward_pending')).toBe(1)
    expect(answers('epoch_retired')).toBe(1)
    expect(answers('s7_unproven')).toBe(0)
  })

  it('s7_unproven: a latch ask\'s META answered without the bit — not a non-meta, not a meta with it', () => {
    const t = new EpochHopTelemetry()
    t.recordLatchMetas([
      { documentId: 'meta-stuck', durable: true },
      { documentId: 'shard', durable: true },
      { documentId: 'meta-proven', durable: true, forwarded: false },
      { documentId: 'meta-retired', durable: false, epochRetired: true },
    ] as never, new Set(['meta-stuck', 'meta-proven', 'meta-retired']))
    expect(valueOf(t.samples(), 'maplespire_model_epoch_durable_heads_answers_total', { outcome: 's7_unproven' })).toBe(1)
  })
})

describe('G4-16j — the stalled-hop gauge', () => {
  const gauge = (t: EpochHopTelemetry) => valueOf(t.samples(), 'maplespire_model_epoch_hop_stalled_metas')

  it('three unproven hop cycles in the hour raise it; two do not', () => {
    const c = clock()
    const t = new EpochHopTelemetry(c.now, () => undefined)
    unprovenCycle(t, c, 'm1', 10)
    c.advance(10 * MIN)
    unprovenCycle(t, c, 'm1', 10)
    expect(gauge(t)).toBe(0)
    c.advance(10 * MIN)
    unprovenCycle(t, c, 'm1', 10)
    expect(gauge(t)).toBe(1)
  })

  it('the crossing names the meta and its workspace in ONE log line — the identity the gauge cannot carry', () => {
    const c = clock()
    const lines: string[] = []
    const t = new EpochHopTelemetry(c.now, (line) => lines.push(line))
    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        t.recordLatchMetas([{ documentId: 'm1', durable: true }] as never, new Set(['m1']), W)
        c.advance(MIN)
      }
      c.advance(10 * MIN)
    }
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'model_epoch.hop_stalled', metaDocumentId: 'm1', landscapeId: 'L', versionId: 'V', cycles: 3 })
  })

  it('a gap of EXACTLY the cycle gap starts a new cycle; the window drops a cycle exactly an hour after its last latch', () => {
    const c = clock()
    const t = new EpochHopTelemetry(c.now, () => undefined)
    unprovenCycle(t, c, 'm1', 1)
    c.advance(HOP_CYCLE_GAP_MS)
    unprovenCycle(t, c, 'm1', 1)
    c.advance(HOP_CYCLE_GAP_MS)
    unprovenCycle(t, c, 'm1', 1)
    expect(gauge(t)).toBe(1)
    c.advance(HOP_STALL_WINDOW_MS - 2 * HOP_CYCLE_GAP_MS - 1) // the first cycle's last latch is 1 h - 1 ms old
    expect(gauge(t)).toBe(1)
    c.advance(1)
    expect(gauge(t)).toBe(0)
  })

  it('a stale cycle does not count towards the crossing log either', () => {
    const c = clock()
    const lines: string[] = []
    const t = new EpochHopTelemetry(c.now, (line) => lines.push(line))
    unprovenCycle(t, c, 'm1', 1)
    c.advance(10 * MIN)
    unprovenCycle(t, c, 'm1', 1)
    c.advance(3 * HOP_STALL_WINDOW_MS) // no scrape in between
    unprovenCycle(t, c, 'm1', 1)
    expect(lines).toEqual([])
  })

  it('an unproven answer to an ask made BEFORE a proof of the same meta is ignored', () => {
    const c = clock()
    const t = new EpochHopTelemetry(c.now, () => undefined)
    for (let i = 0; i < 2; i += 1) { unprovenCycle(t, c, 'm1'); c.advance(10 * MIN) }
    const askedAt = c.now()
    c.advance(10)
    t.recordAnswers([{ documentId: 'm1', durable: true, forwarded: true }] as never)
    c.advance(10)
    t.recordLatchMetas([{ documentId: 'm1', durable: true }] as never, new Set(['m1']), W, askedAt)
    expect(t.trackedCount()).toBe(0)
  })

  it('latches less than the cycle gap apart are ONE cycle, however many', () => {
    const c = clock()
    const t = new EpochHopTelemetry(c.now, () => undefined)
    for (let i = 0; i < 30; i += 1) {
      unprovenCycle(t, c, 'm1', 1)
      c.advance(HOP_CYCLE_GAP_MS - 1)
    }
    expect(gauge(t)).toBe(0)
  })

  it('a cycle leaves the window an hour after its LAST latch, not its first', () => {
    const c = clock()
    const t = new EpochHopTelemetry(c.now, () => undefined)
    unprovenCycle(t, c, 'm1', 10) // 9 minutes long
    c.advance(10 * MIN)
    unprovenCycle(t, c, 'm1', 1)
    c.advance(10 * MIN)
    unprovenCycle(t, c, 'm1', 1)
    // The first cycle began 1 h 1 min ago but ended 52 min ago: still in.
    c.advance(HOP_STALL_WINDOW_MS - 20 * MIN - 9 * MIN + MIN)
    expect(gauge(t)).toBe(1)
  })

  it('logs ONCE per crossing: a starved hop that keeps 3 cycles in the window does not log again; a new crossing does', () => {
    const c = clock()
    const lines: string[] = []
    const t = new EpochHopTelemetry(c.now, (line) => lines.push(line))
    // A starved hop's latches 15 min apart: 3 or more cycles in the window
    // at every new one, the gauge never dropping in between.
    for (let i = 0; i < 8; i += 1) { unprovenCycle(t, c, 'm1', 1); c.advance(15 * MIN) }
    expect(lines).toHaveLength(1)
    // Below the threshold with ONE cycle still in the window (the meta stays
    // tracked), then back to three: a new crossing, logged again.
    c.advance(35 * MIN) // the last cycle is 50 min old, the one before 65
    expect(gauge(t)).toBe(0)
    expect(t.trackedCount()).toBe(1)
    for (let i = 0; i < 2; i += 1) { unprovenCycle(t, c, 'm1', 1); c.advance(6 * MIN) }
    expect(lines).toHaveLength(2)
  })

  it('a cycle older than the hour no longer counts', () => {
    const c = clock()
    const t = new EpochHopTelemetry(c.now, () => undefined)
    unprovenCycle(t, c, 'm1')
    c.advance(30 * MIN)
    unprovenCycle(t, c, 'm1')
    c.advance(20 * MIN)
    unprovenCycle(t, c, 'm1')
    expect(gauge(t)).toBe(1)
    c.advance(HOP_STALL_WINDOW_MS - 50 * MIN + 1) // the first cycle leaves the window
    expect(gauge(t)).toBe(0)
  })

  it('an answer that proves S7 for the meta — latch or not — forgets it', () => {
    const c = clock()
    const t = new EpochHopTelemetry(c.now, () => undefined)
    for (let i = 0; i < 3; i += 1) { unprovenCycle(t, c, 'm1'); c.advance(10 * MIN) }
    expect(gauge(t)).toBe(1)
    t.recordAnswers([{ documentId: 'm1', durable: true, forwarded: false, forwardPending: true }] as never)
    expect(gauge(t)).toBe(0)
    expect(t.trackedCount()).toBe(0)
  })

  it('a NORMAL hop (the meta answered with the bit) never raises it', () => {
    const c = clock()
    const t = new EpochHopTelemetry(c.now, () => undefined)
    for (let i = 0; i < 5; i += 1) {
      t.recordLatchMetas([{ documentId: 'm1', durable: true, forwarded: true }] as never, new Set(['m1']))
      c.advance(10 * MIN)
    }
    expect(gauge(t)).toBe(0)
    expect(t.trackedCount()).toBe(0)
  })

  it('counts METAS, not latches or tabs', () => {
    const c = clock()
    const t = new EpochHopTelemetry(c.now, () => undefined)
    for (let i = 0; i < 3; i += 1) {
      unprovenCycle(t, c, 'm1'); unprovenCycle(t, c, 'm2'); unprovenCycle(t, c, 'm2')
      c.advance(10 * MIN)
    }
    expect(gauge(t)).toBe(2)
  })

  it('the tracked metas are bounded: the one latched least recently goes', () => {
    const c = clock()
    const t = new EpochHopTelemetry(c.now, () => undefined)
    for (let i = 0; i < HOP_STALL_TRACKED_MAX; i += 1) { unprovenCycle(t, c, `m${i}`, 1); c.advance(1) }
    unprovenCycle(t, c, 'm0', 1) // m0 latched again: m1 is now the least recent
    c.advance(1)
    unprovenCycle(t, c, 'new', 1)
    expect(t.trackedCount()).toBe(HOP_STALL_TRACKED_MAX)
    // m0 kept (still one cycle tracked: proving it removes an entry), m1 gone.
    t.recordAnswers([{ documentId: 'm1', durable: true, forwarded: true }] as never)
    expect(t.trackedCount()).toBe(HOP_STALL_TRACKED_MAX)
    t.recordAnswers([{ documentId: 'm0', durable: true, forwarded: true }] as never)
    expect(t.trackedCount()).toBe(HOP_STALL_TRACKED_MAX - 1)
  })
})

describe('G4-16j — the route\'s recorder', () => {
  it('names the asked workspace in the crossing log line', async () => {
    const c = clock()
    const lines: string[] = []
    const t = new EpochHopTelemetry(c.now, (line) => lines.push(line))
    for (let i = 0; i < 3; i += 1) {
      await recordDurableHeadsTelemetry({
        telemetry: t, workspace: W, acknowledged: [{ documentId: 'meta', durable: true }] as never,
        latch: { outcome: 'not_needed', heldMs: 1 }, metaDocumentIds: async () => new Set(['meta']),
      })
      c.advance(10 * MIN)
    }
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toMatchObject([{ landscapeId: 'L', versionId: 'V' }])
  })

  it('records the answers, the latch, and the latch\'s metas — after resolving them', async () => {
    const t = new EpochHopTelemetry()
    const asked: string[][] = []
    await recordDurableHeadsTelemetry({
      telemetry: t,
      acknowledged: [{ documentId: 'meta', durable: true }, { documentId: 'x', forwarded: true }] as never,
      latch: { outcome: 'not_needed', heldMs: 5 },
      metaDocumentIds: async (ids) => { asked.push(ids); return new Set(['meta']) },
    })
    expect(asked).toEqual([['meta', 'x']])
    const s = t.samples()
    expect(valueOf(s, 'maplespire_model_epoch_latch_requests_total', { outcome: 'not_needed' })).toBe(1)
    expect(valueOf(s, 'maplespire_model_epoch_durable_heads_answers_total', { outcome: 'forwarded' })).toBe(1)
    expect(valueOf(s, 'maplespire_model_epoch_durable_heads_answers_total', { outcome: 's7_unproven' })).toBe(1)
  })

  it('a non-latch ask never looks metas up and never counts s7_unproven', async () => {
    const t = new EpochHopTelemetry()
    const lookup = vi.fn(async () => new Set(['meta']))
    await recordDurableHeadsTelemetry({ telemetry: t, acknowledged: [{ documentId: 'meta', durable: true }] as never, latch: null, metaDocumentIds: lookup })
    expect(lookup).not.toHaveBeenCalled()
    expect(valueOf(t.samples(), 'maplespire_model_epoch_durable_heads_answers_total', { outcome: 's7_unproven' })).toBe(0)
  })

  it('a failed lookup is counted, never thrown', async () => {
    const t = new EpochHopTelemetry()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(recordDurableHeadsTelemetry({
      telemetry: t, acknowledged: [{ documentId: 'meta', durable: true }] as never,
      latch: { outcome: 'not_needed', heldMs: 1 }, metaDocumentIds: async () => { throw new Error('db down') },
    })).resolves.toBeUndefined()
    warn.mockRestore()
    expect(valueOf(t.samples(), 'maplespire_model_epoch_hop_meta_lookup_failures_total')).toBe(1)
  })

  it('epochMetaDocumentIds asks for the workspace\'s meta rows only, and reads no table as none', async () => {
    const calls: unknown[][] = []
    const pool = (answer: (sql: string, values: unknown[]) => unknown) => ({
      connect: async () => ({
        query: async (sql: string, values: unknown[] = []) => {
          calls.push([sql, values])
          if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return { rows: [] }
          return answer(sql, values)
        },
        release: () => undefined,
      }),
    })
    expect(await epochMetaDocumentIds(pool(() => ({ rows: [{ document_id: 'meta' }] })) as never, W, ['meta', 'x'])).toEqual(new Set(['meta']))
    const lookup = calls.find(([sql]) => String(sql).includes('read_model_model_epoch_docs'))!
    expect(String(lookup[0])).toMatch(/role = 'meta'/)
    expect(lookup[1]).toEqual(['L', 'V', ['meta', 'x']])
    // Under its own statement timeout.
    expect(calls.map(([sql]) => sql)).toContain(`SET LOCAL statement_timeout = '${EPOCH_META_LOOKUP_TIMEOUT_MS}ms'`)
    const missing = pool(() => { throw Object.assign(new Error('no table'), { code: '42P01' }) })
    expect(await epochMetaDocumentIds(missing as never, W, ['meta'])).toEqual(new Set())
  })

  it('lookups are guarded PER WORKSPACE, four at most; one that never settles is dropped after the stale bound, its late answer ignored', async () => {
    const c = clock()
    const t = new EpochHopTelemetry(c.now, () => undefined)
    const releases: Array<(metas: Set<string>) => void> = []
    let lookups = 0
    const hung = () => { lookups += 1; return new Promise<Set<string>>((resolve) => { releases.push(resolve) }) }
    const ask = (landscapeId: string) => recordDurableHeadsTelemetry({
      telemetry: t, workspace: { landscapeId, versionId: 'V' }, acknowledged: [{ documentId: `meta-${landscapeId}`, durable: true }] as never,
      latch: { outcome: 'not_needed', heldMs: 1 }, metaDocumentIds: hung,
    })
    const inFlight = ['A', 'B', 'C', 'D'].map(ask)
    await ask('A') // the same workspace: skipped
    await ask('E') // a fifth workspace: past the bound, skipped
    expect(lookups).toBe(4)
    expect(valueOf(t.samples(), 'maplespire_model_epoch_hop_meta_lookups_skipped_total')).toBe(2)
    // They never settle: past the stale bound they are dropped (failures).
    c.advance(EPOCH_META_LOOKUP_STALE_MS)
    const fresh = ask('E')
    expect(lookups).toBe(5)
    expect(valueOf(t.samples(), 'maplespire_model_epoch_hop_meta_lookup_failures_total')).toBe(4)
    // A late answer of a dropped lookup records nothing.
    releases[0]!(new Set(['meta-A']))
    await inFlight[0]
    expect(valueOf(t.samples(), 'maplespire_model_epoch_durable_heads_answers_total', { outcome: 's7_unproven' })).toBe(0)
    releases[4]!(new Set(['meta-E']))
    await fresh
    expect(valueOf(t.samples(), 'maplespire_model_epoch_durable_heads_answers_total', { outcome: 's7_unproven' })).toBe(1)
    for (const release of releases.slice(1, 4)) release(new Set())
    await Promise.all(inFlight)
  })

  it('the lookup abandon bound follows DB_CONNECTION_TIMEOUT_MS, never shorter than the pool\'s patience', async () => {
    expect(epochMetaLookupStaleMs(10_000)).toBe(EPOCH_META_LOOKUP_STALE_MS)
    expect(EPOCH_META_LOOKUP_STALE_MS).toBe(15_000)
    vi.stubEnv('DB_CONNECTION_TIMEOUT_MS', '30000')
    try {
      const c = clock()
      const t = new EpochHopTelemetry(c.now, () => undefined)
      expect(t.lookupStaleMs).toBe(35_000)
      const ask = (landscapeId: string) => recordDurableHeadsTelemetry({
        telemetry: t, workspace: { landscapeId, versionId: 'V' }, acknowledged: [{ documentId: 'm', durable: true }] as never,
        latch: { outcome: 'not_needed', heldMs: 1 }, metaDocumentIds: () => new Promise(() => undefined),
      })
      void ask('A')
      c.advance(EPOCH_META_LOOKUP_STALE_MS) // past the default, not past this pool's patience
      void ask('B')
      expect(valueOf(t.samples(), 'maplespire_model_epoch_hop_meta_lookup_failures_total')).toBe(0)
      c.advance(35_000 - EPOCH_META_LOOKUP_STALE_MS)
      void ask('C')
      expect(valueOf(t.samples(), 'maplespire_model_epoch_hop_meta_lookup_failures_total')).toBe(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('at most ONE meta lookup in flight: a concurrent latch ask is skipped and counted', async () => {
    const t = new EpochHopTelemetry()
    let release!: (metas: Set<string>) => void
    let lookups = 0
    const slow = () => { lookups += 1; return new Promise<Set<string>>((resolve) => { release = resolve }) }
    const first = recordDurableHeadsTelemetry({ telemetry: t, acknowledged: [{ documentId: 'meta', durable: true }] as never,
      latch: { outcome: 'not_needed', heldMs: 1 }, metaDocumentIds: slow })
    await recordDurableHeadsTelemetry({ telemetry: t, acknowledged: [{ documentId: 'meta', durable: true }] as never,
      latch: { outcome: 'not_needed', heldMs: 1 }, metaDocumentIds: slow })
    expect(lookups).toBe(1)
    expect(valueOf(t.samples(), 'maplespire_model_epoch_hop_meta_lookups_skipped_total')).toBe(1)
    release(new Set(['meta']))
    await first
    // Freed once it ended, a failure too.
    await recordDurableHeadsTelemetry({ telemetry: t, acknowledged: [{ documentId: 'meta', durable: true }] as never,
      latch: { outcome: 'not_needed', heldMs: 1 }, metaDocumentIds: async () => { lookups += 1; throw Object.assign(new Error('x'), { code: '57014' }) } })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await recordDurableHeadsTelemetry({ telemetry: t, acknowledged: [{ documentId: 'meta', durable: true }] as never,
      latch: { outcome: 'not_needed', heldMs: 1 }, metaDocumentIds: async () => { lookups += 1; return new Set(['meta']) } })
    expect(lookups).toBe(3)
    vi.restoreAllMocks()
  })

  it('the durable-heads route calls the recorder, with the latch outcome, after its answer (source pin)', async () => {
    // The weak form (nothing in CI mounts index.ts): the CALL is pinned, not
    // its behaviour — that is what the real-stack check of G4-16j covers.
    const source = await readFile(path.resolve(import.meta.dirname, '..', 'index.ts'), 'utf8')
    const route = source.split("app.post('/api/automerge/durable-heads'")[1]?.split('app.post(')[0] ?? ''
    expect(route).toMatch(/res\.json\(\{ documents: acknowledged[\s\S]*recordDurableHeadsTelemetry\(\{[\s\S]*latchOutcome\(waited, acknowledged\)/)
    expect(route).toMatch(/epochMetaDocumentIds\(pool, canonical, ids\)/)
    expect(route).toMatch(/outcome: 'failed'/)
    expect(source).toContain('metrics.push(...epochHopMetricSamples())')
  })

  it('the module samples are the process telemetry\'s', () => {
    expect(epochHopMetricSamples().map((m) => m.name)).toEqual([
      'maplespire_model_epoch_latch_requests_total',
      'maplespire_model_epoch_latch_hold_seconds',
      'maplespire_model_epoch_durable_heads_answers_total',
      'maplespire_model_epoch_hop_stalled_metas',
      'maplespire_model_epoch_hop_meta_lookup_failures_total',
      'maplespire_model_epoch_hop_meta_lookups_skipped_total',
    ])
  })
})
