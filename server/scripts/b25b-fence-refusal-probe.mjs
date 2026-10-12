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
 * Fence refusal probe — WHAT A FENCE REFUSAL ACTUALLY ANSWERS A CLIENT, on the
 * deployed stack.
 *
 * WHY THIS EXISTS SEPARATELY FROM `b25a-redis-outage-bench.mjs`. That harness
 * measures WHETHER a route mutates before it fails, over several families and
 * sampling regimes, and takes about ten minutes. This one asks a single question
 * the unit tests cannot answer — what status, `Retry-After` and body reach a
 * real HTTP client over a real socket, on the image that is actually running?
 * Unit tests are supporting evidence, not proof: the original symptom has to be
 * reproduced and the same interaction re-driven after a change.
 *
 * SO IT IS MEANT TO BE RUN TWICE, and the run label says which build:
 *
 *   B25B_OUT=<path> B25B_LABEL=before node server/scripts/b25b-fence-refusal-probe.mjs
 *   ... rebuild the cell image with the fix, recreate the cells ...
 *   B25B_OUT=<path> B25B_LABEL=after  node server/scripts/b25b-fence-refusal-probe.mjs
 *
 * `before` must reproduce `500 {"error":"read model query failed"}`. Without
 * that run the `after` proves only that the stack answers 503 today, not that
 * anything changed — the same instrument on both builds is the whole point.
 *
 * THE NEGATIVE CONTROL IS INSIDE EACH RUN, not across runs. The same door is
 * fired with Redis UP before the outage and again with Redis UP after it, on
 * fresh workspaces. If those two also answered a fence refusal, the outage would
 * have explained nothing and the run is VOID. An instrument that has never been
 * shown able to report the other answer has measured nothing.
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

/**
 * WHICH CELL, AND WHY IT IS NOT A CONSTANT. The bench runs three cells over two
 * partitions, so one of them is always the SPARE — `partitionIndex: null`,
 * `ownedWorkspaceCount: 0/0`, and `syncCellConverged: false` BY DESIGN. Which
 * cell is spare changes at every failover, and a Redis outage IS a failover: a
 * pinned cell can come back as the spare after the outage arm, and the
 * recovery control could then not build a workspace.
 *
 * So the cell is DISCOVERED, by asking for a fresh workspace and reading the
 * cell's own `x-maplespire-sync-route` answer, and it is re-discovered after the
 * outage rather than assumed to be the same one.
 */
const CELL_URLS = (process.env.B25B_CELL_URLS ?? 'http://127.0.0.1:3321,http://127.0.0.1:3322,http://127.0.0.1:3313')
  .split(',').map((url) => url.trim()).filter(Boolean)
let CELL = CELL_URLS[0]
const LOGIN_EMAIL = process.env.B25B_LOGIN_EMAIL ?? 'failover-admin@maplespire.local'
const REDIS = process.env.B25B_REDIS_CONTAINER ?? 'maplespire-sync-active-active-redis-1'
const LABEL = process.env.B25B_LABEL ?? 'unlabelled'

/**
 * A blank `B25B_OUT=` must not silently fall back: the whole run is the record,
 * and losing it means running the outage again.
 */
const OUT = (() => {
  const raw = process.env.B25B_OUT
  if (raw === undefined) return 'reports/B2-5b-probe.json'
  if (raw.trim() === '') throw new Error('B25B_OUT is set but empty — refusing to run and lose the record')
  return raw
})()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...p) => console.log(...p)
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

let outageStartedAtMs = null
const secondsAfterOutage = () => (outageStartedAtMs === null
  ? null
  : Number(((Date.now() - outageStartedAtMs) / 1_000).toFixed(2)))

async function req(url, { cookie, method = 'GET', body, timeoutMs = 90_000 } = {}) {
  const headers = {}
  if (cookie) headers.Cookie = cookie
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const startedAt = Date.now()
  const startedAfterOutage = secondsAfterOutage()
  let response
  try {
    response = await fetch(url, {
      method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return {
      status: 0, retryAfter: null, body: `FETCH-FAILED: ${error.message}`,
      elapsedMs: Date.now() - startedAt, startedAfterOutage, finishedAfterOutage: secondsAfterOutage(),
    }
  }
  const text = await response.text()
  let parsed = text
  try { parsed = text ? JSON.parse(text) : null } catch { /* keep the text */ }
  return {
    status: response.status,
    route: response.headers.get('x-maplespire-sync-route'),
    retryAfter: response.headers.get('retry-after'),
    body: parsed,
    elapsedMs: Date.now() - startedAt,
    startedAfterOutage,
    finishedAfterOutage: secondsAfterOutage(),
  }
}

async function login(base = CELL) {
  const response = await fetch(`${base}/api/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL }), signal: AbortSignal.timeout(15_000),
  })
  const cookie = (response.headers.get('set-cookie') || '').match(/maplespire_session=[^;]+/)?.[0]
  if (!cookie) throw new Error(`dev-login gave no cookie (HTTP ${response.status})`)
  return cookie
}

/**
 * The fence's own counters, read from the cell rather than from a container log.
 * A delta across one request is what separates "the barrier refused" from "the
 * request failed for some other reason and happened to return the same 500" —
 * a distinction HTTP alone cannot make.
 */
async function fenceCounters(cookie, base = CELL) {
  const cell = await req(`${base}/api/platform/sync-cell`, { cookie, timeoutMs: 15_000 })
  const fence = cell.body?.storageFence ?? null
  const ready = await req(`${base}/api/ready`, { timeoutMs: 15_000 })
  return {
    rejectedMutationCount: fence?.rejectedMutationCount ?? null,
    rejectedMutationsByReason: fence?.rejectedMutationsByReason ?? null,
    partitionIndex: cell.body?.partitionIndex ?? null,
    ownedWorkspaceCount: cell.body?.ownedWorkspaceCount ?? null,
    expectedWorkspaceCount: cell.body?.expectedWorkspaceCount ?? null,
    converged: ready.body?.checks?.syncCellConverged ?? null,
  }
}

const rejectedDelta = (before, after) => (
  before?.rejectedMutationCount === null || after?.rejectedMutationCount === null
    ? null
    : after.rejectedMutationCount - before.rejectedMutationCount
)

/**
 * Settle, or say which of the two settled states this is. A SPARE reports
 * `syncCellConverged: false` by design — it holds no partition and owns nothing
 * — so waiting for `true` on a spare waits forever and then calls it a timeout,
 * which is a witness that cannot tell "still recovering" from "correctly
 * demoted". Both are reported; only one is a failure.
 */
async function awaitSettled(cookie, label, base, timeoutSeconds = 90) {
  for (let attempt = 1; attempt <= timeoutSeconds; attempt += 1) {
    const witness = await fenceCounters(cookie, base)
    if (witness.converged === true) {
      log(`  [${label}] ${base} converged after ${attempt} poll(s): owned=${witness.ownedWorkspaceCount}/${witness.expectedWorkspaceCount}`)
      return { ...witness, base, polls: attempt, settled: 'converged' }
    }
    if (witness.partitionIndex === null && witness.expectedWorkspaceCount === 0 && attempt >= 10) {
      log(`  [${label}] ${base} is the SPARE (no partition, owns nothing) — that is a settled state, not a timeout`)
      return { ...witness, base, polls: attempt, settled: 'spare' }
    }
    await sleep(1_000)
  }
  const witness = await fenceCounters(cookie, base)
  log(`  [${label}] ${base} !! NEITHER converged NOR a clean spare after ${timeoutSeconds}s`)
  return { ...witness, base, polls: timeoutSeconds, settled: 'unsettled' }
}

/**
 * The cell that will actually answer as owner, asked rather than assumed.
 * Returns the first candidate that both settles and takes ownership of a fresh
 * landscape, along with a session cookie for it.
 */
async function pickOwningCell(label) {
  const rejected = []
  for (const base of CELL_URLS) {
    const cookie = await login(base).catch(() => null)
    if (!cookie) { rejected.push({ base, why: 'dev-login failed' }); continue }
    const settled = await awaitSettled(cookie, label, base)
    if (settled.settled !== 'converged') { rejected.push({ base, why: `settled=${settled.settled}` }); continue }
    log(`  [${label}] using ${base}`)
    return { base, cookie, settled, rejected }
  }
  throw new Error(`[${label}] no cell converged: ${JSON.stringify(rejected)}`)
}

/** Is this workspace served by THIS cell? Asked, never assumed. */
async function ownedHere(cookie, w) {
  const probe = await req(`${CELL}/api/automerge/root?${new URLSearchParams(w)}`, { cookie, timeoutMs: 20_000 })
  return probe.status === 200 && probe.route === 'owner'
}

/**
 * One workspace this cell owns, promoted to summary so `demote-summary` has
 * something to undo. Built fresh per firing: a demotion consumes the promoted
 * state, so reusing one would make the second firing refuse for its own reasons
 * and look like a fence refusal.
 */
async function freshPromotedWorkspace(cookie, tag) {
  for (let round = 1; round <= 10; round += 1) {
    for (let i = 0; i < 4; i += 1) {
      const created = await req(`${CELL}/api/landscapes`, {
        cookie, method: 'POST', body: { name: `B2-5b ${tag} r${round} n${i}` },
      })
      const l = created.body?.landscape
      if (!l?.id || !l?.defaultVersionId) continue
      const w = { landscapeId: l.id, versionId: l.defaultVersionId }
      if (!(await ownedHere(cookie, w))) continue

      for (let attempt = 1; attempt <= 40; attempt += 1) {
        await req(`${CELL}/api/model/cache/estimate?${new URLSearchParams(w)}`, { cookie })
        const dry = await req(`${CELL}/api/platform/workspace/promote-summary`, {
          cookie, method: 'POST', body: { ...w, apply: false },
        })
        const codes = (dry.body?.blockers ?? []).map((b) => b.code)
        if (dry.status === 200 && codes.length === 0) break
        if (!codes.includes('read-model-not-caught-up') && !codes.includes('read-model-not-sealed')) break
        await sleep(1_500)
      }
      const promoted = await req(`${CELL}/api/platform/workspace/promote-summary`, {
        cookie, method: 'POST', body: { ...w, apply: true },
      })
      if (promoted.body?.applied) {
        log(`  [${tag}] ready: ${w.landscapeId}/${w.versionId}`)
        return w
      }
    }
  }
  throw new Error(`[${tag}] could not build a promoted workspace owned by this cell`)
}

/** The door under study, with the fence counters bracketing it. */
async function fireDemote(cookie, w, tag) {
  const before = await fenceCounters(cookie)
  const response = await req(`${CELL}/api/platform/workspace/demote-summary`, {
    cookie, method: 'POST', body: { ...w, apply: true },
  })
  const after = await fenceCounters(cookie)
  const delta = rejectedDelta(before, after)
  const record = {
    tag,
    status: response.status,
    retryAfter: response.retryAfter,
    body: response.body,
    elapsedMs: response.elapsedMs,
    atSecondsAfterOutage: response.startedAfterOutage,
    fenceRejectionDelta: delta,
    /**
     * The classification, stated as data rather than inferred by a later reader.
     * A fence refusal is a NON-2xx whose firing moved the barrier's own counter;
     * a 500 with a delta of zero is something else entirely (on this bench,
     * typically a primary-pool acquisition timeout).
     */
    isFenceRefusal: response.status >= 400 && delta !== null && delta > 0,
    convergenceBefore: before,
    convergenceAfter: after,
  }
  log(`  [${tag}] HTTP ${record.status} in ${record.elapsedMs} ms, Retry-After=${record.retryAfter ?? '-'}, `
    + `fence delta ${record.fenceRejectionDelta}, refusal=${record.isFenceRefusal}`)
  return record
}

/**
 * Ctrl+C between stopping Redis and restarting it leaves the bench in outage for
 * every later measurement. `main().catch` does not cover a signal.
 */
let restoring = false
const restoreRedis = (why) => {
  if (restoring) return
  restoring = true
  try { docker('start', REDIS); console.error(`(${why}: Redis restarted)`) } catch { /* already up */ }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => { restoreRedis(signal); process.exit(130) })
}

/**
 * MODULE SCOPE ON PURPOSE. Everything this run learns accumulates here, and the
 * failure path below writes it too. A run that stops the bench's Redis, produces
 * its measurement, and then throws on a later step must not take the measurement
 * with it — that costs another outage to learn what a saved partial record would
 * have said outright.
 */
const record = {
  measureId: 'B2-5b-probe',
  label: LABEL,
  candidateCells: CELL_URLS,
  startedAt: new Date().toISOString(),
  question: 'What status, Retry-After and body does a sync-cell fence refusal answer a real HTTP client?',
}

const writeRecord = (outcome) => {
  record.outcome = outcome
  record.finishedAt = new Date().toISOString()
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`)
  log(`wrote ${OUT} (outcome: ${outcome})`)
}

const main = async () => {
  log('finding a cell that actually owns workspaces')
  const chosen = await pickOwningCell('start')
  CELL = chosen.base
  const cookie = chosen.cookie
  record.cell = CELL
  record.cellSelection = { chosen: chosen.base, rejected: chosen.rejected }
  record.convergenceAtStart = chosen.settled

  log('control A — the same door, Redis UP')
  const controlA = await freshPromotedWorkspace(cookie, 'control-a')
  record.controlBeforeOutage = await fireDemote(cookie, controlA, 'control-a')

  // Built BEFORE the outage, and there are three of them: a firing that succeeds
  // consumes its workspace, and a probe that runs out of targets mid-window
  // reports VOID for a reason that is its own fault.
  log('building the workspaces the outage arm will fire on, while Redis is still up')
  const targets = []
  for (let i = 0; i < 3; i += 1) targets.push(await freshPromotedWorkspace(cookie, `outage-${i}`))

  log(`stopping ${REDIS}`)
  docker('stop', REDIS)
  outageStartedAtMs = Date.now()
  record.outageStartedAt = new Date(outageStartedAtMs).toISOString()

  try {
    // FIRE EARLY AND OFTEN. The refusal itself takes 8-11 ms — the door gets a
    // client instantly and the barrier says no — whereas pool starvation sets
    // in around t=60 s and answers the SAME 500 after a 10 s plateau. A probe
    // that starts late fires entirely inside the other mechanism (every firing
    // ~10 s with a fence-rejection delta of zero, correctly VOID).
    //
    // Ownership goes first, not last: `SYNC_CELL_PARTITION_LEASE_TTL_MS`
    // defaults to 1 500 ms (`syncCellOwnershipConfig` in `ownership.ts`), so `owns()` starts answering
    // false within about two seconds of Redis stopping. The window this probe
    // needs is roughly t=2 s to t=60 s, which is the window it now samples.
    const firings = []
    let consumed = 0
    for (let round = 1; round <= 12; round += 1) {
      const waitSeconds = round === 1 ? 4 : 5
      log(`  waiting ${waitSeconds}s (t=${secondsAfterOutage()}s)`)
      await sleep(waitSeconds * 1_000)
      const current = targets[consumed]
      if (!current) { log('  out of prepared workspaces'); break }
      const firing = await fireDemote(cookie, current, `outage-r${round}`)
      firings.push(firing)
      if (firing.isFenceRefusal) break
      if (firing.status >= 200 && firing.status < 300) {
        consumed += 1
        log(`  that firing SUCCEEDED; workspace consumed (${consumed}/${targets.length})`)
      }
    }
    record.outageFirings = firings
    record.outageRefusal = firings.find((f) => f.isFenceRefusal) ?? null
  } finally {
    log(`restarting ${REDIS}`)
    restoreRedis('run complete')
    outageStartedAtMs = null
  }

  // RECOVERY CONTROL, AND IT IS ALLOWED TO BE INCONCLUSIVE WITHOUT DESTROYING
  // THE RUN. A Redis outage on this bench IS a failover: the cell that owned the
  // workspaces before it can come back as the spare, in which case no workspace
  // can be built on it and that is correct behaviour, not a failed measurement.
  // Throwing here would lose the record after the outage arm had already
  // produced its result.
  try {
    const after = await pickOwningCell('restore')
    record.convergenceAfterRestore = after.settled
    record.cellAfterRestore = after.base
    log('control B — the same door, Redis UP again')
    const controlB = await freshPromotedWorkspace(after.cookie, 'control-b')
    record.controlAfterOutage = await fireDemote(after.cookie, controlB, 'control-b')
  } catch (error) {
    record.controlAfterOutage = null
    record.controlAfterOutageFailure = String(error && error.message ? error.message : error)
    log(`  [control-b] INCONCLUSIVE: ${record.controlAfterOutageFailure}`)
  }

  // The verdict, computed here rather than left to a reader of the numbers.
  const refusal = record.outageRefusal
  // Control A is the one that carries the negative control: same door, same
  // outage-free conditions, must NOT answer a fence refusal. Control B adds
  // recovery and is not allowed to make the run VOID when it is inconclusive —
  // only when it actively contradicts, by refusing with Redis up.
  const controlsClean = record.controlBeforeOutage.isFenceRefusal === false
    && record.controlAfterOutage?.isFenceRefusal !== true
  record.verdict = {
    controlsClean,
    void: !controlsClean || refusal === null,
    voidReason: !controlsClean
      ? 'a control arm ALSO answered a fence refusal — the outage explains nothing'
      : (refusal === null ? 'the outage arm never produced a fence refusal — nothing was measured' : null),
    observed: refusal === null ? null : {
      status: refusal.status,
      retryAfter: refusal.retryAfter,
      body: refusal.body,
    },
    /**
     * The refusal contract, checked against what a client got.
     * Stated as a field rather than asserted with a throw so a FAILING run still
     * writes its record — a probe that exits before writing is a probe that has
     * to be re-run to learn why it failed.
     */
    matchesFixedContract: refusal !== null
      && refusal.status === 503
      && refusal.retryAfter === '15'
      && ['sync-cell-ownership-unavailable', 'sync-cell-not-owner', 'sync-cell-write-refused']
        .includes(refusal.body?.code)
      // NO `retryable`, and it is checked rather than merely omitted. In this
      // codebase `retryable: true` means "safe to repeat", and a mutating
      // request interrupted by this outage can leave durable documents behind
      // with a rollback that cannot run (see `b25a-redis-outage-bench.mjs`).
      && refusal.body?.retryable === undefined,
    matchesOldSymptom: refusal !== null
      && refusal.status === 500
      && refusal.body?.error === 'read model query failed',
  }
  writeRecord('complete')
  log(`verdict: void=${record.verdict.void} fixed=${record.verdict.matchesFixedContract} `
    + `oldSymptom=${record.verdict.matchesOldSymptom}`)
}

main().catch((error) => {
  restoreRedis('run failed')
  record.error = String(error && error.stack ? error.stack : error)
  try { writeRecord('failed') } catch (writeError) { console.error('could not save the record:', writeError) }
  console.error(error)
  process.exit(1)
})
