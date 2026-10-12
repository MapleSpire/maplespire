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
 * WHAT the cliff at ~16 KB actually is.
 *
 * `fence-survey-mget-bench.mjs` established that one `MGET` costs 0.46 ms at
 * 144 keys and 44 ms at 160, and stays flat above. It did NOT establish why.
 * Two tempting explanations are ruled out by the dependency source itself:
 *
 *   - Nagle is OFF: `@redis/client/dist/lib/client/socket.js` sets
 *     `noDelay: options?.noDelay ?? true`.
 *   - A single command is NOT deferred by the stream high-water mark: the
 *     writer `cork()`s, writes every chunk of the command, checks
 *     `writableNeedDrain` BETWEEN commands, then `uncork()`s.
 *
 * This file is the measurement. Four arms, each isolating one variable the
 * sweep confounded:
 *
 *   N1  ECHO of one large string   — same request BYTES, ONE argument, ZERO key
 *                                    lookups. Separates bytes from both.
 *   N2  MGET of the same key N x   — same bytes, same argument count, ONE
 *                                    distinct lookup. Separates lookups.
 *   N3  writableNeedDrain + spacing — is the cost paid by THIS command or by the
 *                                    NEXT one waiting on `drain`?
 *   N4  a second connection         — if the cost is head-of-line blocking on
 *                                    one socket, an idle sibling connection is
 *                                    unaffected. This is the arm that decides
 *                                    whether sharing the lease connection is the
 *                                    real defect.
 *
 *   TEST_REDIS_URL=redis://localhost:6389 node qa/fence-survey-cliff-cause.mjs
 */
import { createHash } from 'node:crypto'
import { createClient } from 'redis'

const URL = process.env.TEST_REDIS_URL
if (!URL) {
  console.error('TEST_REDIS_URL is required')
  process.exit(1)
}

const PREFIX = `cliff-cause-${process.pid}`
const key = (index) => `${PREFIX}:sync-cell:fence:${createHash('sha256').update(String(index)).digest('hex')}`
/** Under and over the measured cliff, from the committed sweep. */
const UNDER = 144
const OVER = 160

const median = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b)
  return Number(sorted[Math.floor(sorted.length / 2)].toFixed(3))
}

async function time(client, args, iterations, between) {
  await client.sendCommand(args)
  const samples = []
  for (let i = 0; i < iterations; i += 1) {
    if (between) await between()
    const started = performance.now()
    await client.sendCommand(args)
    samples.push(performance.now() - started)
  }
  return median(samples)
}

const client = createClient({ url: URL })
const sibling = createClient({ url: URL })
await client.connect()
await sibling.connect()

const report = { platform: `${process.platform}-${process.arch}`, under: UNDER, over: OVER }
try {
  const keys = Array.from({ length: OVER }, (unused, index) => key(index))
  await client.sendCommand(['MSET', ...keys.flatMap((k) => [k, '7'])])

  const bytesOf = (args) => args.reduce((total, a) => total + Buffer.byteLength(a) + 7, 0)
  const underArgs = keys.slice(0, UNDER)
  const overArgs = keys.slice(0, OVER)

  // N0 — reproduce the cliff on THIS client, or nothing below means anything.
  report.n0_mget = {
    under: { bytes: bytesOf(underArgs), ms: await time(client, ['MGET', ...underArgs], 25) },
    over: { bytes: bytesOf(overArgs), ms: await time(client, ['MGET', ...overArgs], 25) },
  }

  // N1 — SAME BYTES, ONE argument, ZERO key lookups.
  const filler = (n) => 'x'.repeat(bytesOf(keys.slice(0, n)) - 8)
  report.n1_echo_oneArgument = {
    under: { bytes: Buffer.byteLength(filler(UNDER)), ms: await time(client, ['ECHO', filler(UNDER)], 25) },
    over: { bytes: Buffer.byteLength(filler(OVER)), ms: await time(client, ['ECHO', filler(OVER)], 25) },
  }

  // N2 — same bytes, same argument count, ONE distinct key.
  report.n2_mget_oneDistinctKey = {
    under: { ms: await time(client, ['MGET', ...Array.from({ length: UNDER }, () => keys[0])], 25) },
    over: { ms: await time(client, ['MGET', ...Array.from({ length: OVER }, () => keys[0])], 25) },
  }

  // N3 — is the cost paid by THIS command, or by the NEXT one waiting on
  // `drain`? If spacing the commands removes the step, the cost is the next
  // command being head-of-line blocked — which is a statement about the
  // CONNECTION, not about the command.
  const spaced = () => new Promise((resolve) => setTimeout(resolve, 5))
  report.n3_spacedByFiveMs = {
    under: { ms: await time(client, ['MGET', ...underArgs], 25, spaced) },
    over: { ms: await time(client, ['MGET', ...overArgs], 25, spaced) },
  }

  // N4 — while the busy client is over the cliff, what does an IDLE SIBLING
  // connection see? This is the arm that decides whether routing the survey off
  // the lease connection is the real remedy or a nicety.
  const busy = (async () => {
    const deadline = performance.now() + 1_500
    while (performance.now() < deadline) await client.sendCommand(['MGET', ...overArgs])
  })()
  report.n4_siblingWhileBusy = { pingMs: await time(sibling, ['PING'], 40) }
  await busy
  report.n4_siblingIdle = { pingMs: await time(sibling, ['PING'], 40) }

  report.verdict = {
    cliffReproduced: report.n0_mget.over.ms > report.n0_mget.under.ms * 10,
    isBytesNotLookups: report.n2_mget_oneDistinctKey.over.ms > report.n2_mget_oneDistinctKey.under.ms * 10,
    isBytesNotArgumentCount: report.n1_echo_oneArgument.over.ms > report.n1_echo_oneArgument.under.ms * 10,
    spacingRemovesIt: report.n3_spacedByFiveMs.over.ms < report.n0_mget.over.ms / 10,
    blocksTheSameConnectionOnly:
      report.n4_siblingWhileBusy.pingMs < report.n0_mget.over.ms / 10,
  }
} finally {
  const doomed = []
  for await (const batch of client.scanIterator({ MATCH: `${PREFIX}*`, COUNT: 500 })) {
    if (Array.isArray(batch)) doomed.push(...batch)
    else doomed.push(batch)
  }
  if (doomed.length > 0) await client.sendCommand(['DEL', ...doomed])
  await Promise.allSettled([client.close(), sibling.close()])
}

console.log(JSON.stringify(report, null, 1))
