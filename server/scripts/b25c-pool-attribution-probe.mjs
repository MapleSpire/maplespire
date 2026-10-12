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

// Pool attribution probe — WHO holds the primary pool's clients, during the
// 10 s acquisition plateau seen under a Redis outage (several candidates can
// hold clients simultaneously; this attributes them).
//
// ── WHAT THIS INSTRUMENT CAN AND CANNOT SEE, SAID FIRST ────────────────────
//
// It reads `pg_stat_activity`, the SERVER's view. PostgreSQL knows which
// backends exist, what each is running, and how long each has been in its
// current state. It does NOT know whether an `idle` backend is parked in
// node-postgres's free list or checked out by application code awaiting
// something else. Those are the same row.
//
// So the discriminator is NOT "idle longer than `idleTimeoutMillis`": on a
// healthy cell, three backends sit idle for over an hour — far beyond the 30 s
// `DB_IDLE_TIMEOUT_MS` — because they are dedicated `LISTEN` clients, held on
// purpose for the life of the process. A rule calling those a leak would
// report one on a healthy cell every time.
//
// What this does instead is attribute by STATEMENT, and the statement that
// matters is unambiguous:
//
//     SELECT pg_try_advisory_lock($1, $2) AS locked, pg_backend_pid() AS pid
//
// issued by `acquireLifecycleApplyLock` in `maintenance/lifecycleApplyLock.ts`,
// on a client it checks out and RETURNS STILL CHECKED OUT — a session advisory
// lock belongs to the session that took it. No other statement in the tree looks
// like it. While `promoteSummaryWorkspace` waits out the fence arming bound —
// `await sleep(BASELINE_FENCE_ARMING_BOUND_MS)`, 15 000 ms, defined in
// `rbac/docScope.ts` — that backend stays `idle` with this as its LAST
// statement. So a held client is visible as a fingerprint plus a dwell time,
// and neither half is inferred.
//
// The symbols are named without line numbers on purpose: line numbers drift.
//
// The residual blind spot, stated rather than closed: a holder that borrows a
// client and issues NO statement on it shows the previous borrower's text. No
// reading of this record may claim otherwise.
//
// ── WHY THE CONTROL ARM RUNS WITH REDIS UP ─────────────────────────────────
//
// The hold is not caused by the outage. `sleep(15 000)` under a checked-out
// client is unconditional, so it is measurable on a HEALTHY stack — which is a
// far stronger attribution than one taken only during a failure, where a dozen
// things move at once. Arm 1 fires one promotion and asks whether one backend
// dwells; arm 2 fires several at once and asks whether the count rises with
// them; arm 3 repeats arm 2 during a Redis outage and asks what changes. If the
// holder is only visible in arm 3, the attribution above is wrong and the
// record must say so.
//
// ── WHY `/api/ready` IS THE DETECTOR ───────────────────────────────────────
//
// A workspace read route is useless here: `createWorkspaceHttpRouting` refuses
// at the front door with 503 `workspace owner unavailable` the moment
// ownership is unavailable, so the request never reaches a pool borrow. A
// detector shielded from the thing it measures answers confidently and is
// worth nothing; `/api/ready` runs `pool.query('SELECT 1')` behind NO gate.
//
// Run from the repo root with the bench already up:
//   node server/scripts/b25c-pool-attribution-probe.mjs

import { execFile, execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const CELL_URLS = (process.env.B25C_CELL_URLS ?? 'http://127.0.0.1:3321,http://127.0.0.1:3322,http://127.0.0.1:3313')
  .split(',').map((s) => s.trim()).filter(Boolean)
let CELL = CELL_URLS[0]
let CELL_CONTAINER = null
const LOGIN_EMAIL = process.env.B25C_LOGIN_EMAIL ?? 'failover-admin@maplespire.local'
const REDIS = process.env.B25C_REDIS_CONTAINER ?? 'maplespire-sync-active-active-redis-1'
const PG = process.env.B25C_PG_CONTAINER ?? 'maplespire-sync-active-active-postgres-1'
const LABEL = process.env.B25C_LABEL ?? 'unlabelled'

const CELL_CONTAINERS = (process.env.B25C_CELL_CONTAINERS ?? [
  'maplespire-sync-active-active-sync-cell-a-1',
  'maplespire-sync-active-active-sync-cell-b-1',
  'maplespire-sync-active-active-sync-cell-c-1',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean)

/**
 * `??` does not catch a BLANK (same helper as the Redis outage bench). This
 * probe stops the bench's Redis; losing the record is losing the run.
 */
function requiredPath(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (raw.trim() === '') throw new Error(`${name} is set but blank; refusing to run a measurement with nowhere to write it`)
  return raw.trim()
}
const OUT = requiredPath('B25C_OUT', 'reports/B2-5c-probe-runs.json')

function boundedEnvNumber(name, fallback, minimum) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${name}='${raw}' is unusable: it must be a number >= ${minimum}`)
  }
  return parsed
}

/**
 * Concurrent promotions in the fan-out arms. Eight because the pool is ten
 * (`DB_POOL_MAX` unset on this bench -> the `dbConfig.ts` default) and THREE are
 * permanently checked out by dedicated LISTEN clients — `changeNotifications`,
 * `wsAuth`, `workspaceCacheInvalidation` — leaving seven. Eight is the smallest
 * count that must exceed seven if each promotion holds one.
 */
const FANOUT = boundedEnvNumber('B25C_FANOUT', 8, 2)
const CENSUS_INTERVAL_MS = boundedEnvNumber('B25C_CENSUS_INTERVAL_MS', 700, 200)
const READY_INTERVAL_MS = boundedEnvNumber('B25C_READY_INTERVAL_MS', 1_500, 250)
/**
 * A `/api/ready` slower than this is a pool-acquisition wait, not a query.
 * `connectionTimeoutMillis` is 10 s (`dbConfig.ts`); the healthy value for
 * this endpoint on this bench is single-digit milliseconds.
 */
const PLATEAU_MS = boundedEnvNumber('B25C_PLATEAU_MS', 2_000, 200)
/** Seconds the outage arm runs before Redis is restored. */
const OUTAGE_SECONDS = boundedEnvNumber('B25C_OUTAGE_SECONDS', 120, 20)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...p) => console.log(...p)
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const dockerAsync = async (...a) => (await execFileAsync('docker', a, { encoding: 'utf8', maxBuffer: 16 << 20 })).stdout

let outageStartedAtMs = null
const secondsAfterOutage = () => (outageStartedAtMs === null
  ? null
  : Number(((Date.now() - outageStartedAtMs) / 1_000).toFixed(2)))

// ── the census ─────────────────────────────────────────────────────────────

const SEP = '|~|'

/**
 * The cell's own IP, asked of Docker rather than written here. A hardcoded
 * address survives exactly until the bench is recreated and then censuses an
 * EMPTY set — zero backends, which reads as "nothing holds anything" instead of
 * "the filter matched nothing".
 */
function containerIp(container) {
  const raw = docker('inspect', container, '--format',
    '{{range $k, $v := .NetworkSettings.Networks}}{{$v.IPAddress}}{{end}}').trim()
  // Validated before it reaches SQL: this value is interpolated into the census
  // statement, and `docker inspect` on a multi-network container concatenates
  // addresses rather than failing.
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) {
    throw new Error(`container ${container} did not yield exactly one IPv4 address: '${raw}'`)
  }
  return raw
}

const CENSUS_SQL = (ip) => `
  SELECT pid,
         state,
         coalesce(wait_event_type, ''),
         coalesce(wait_event, ''),
         round(extract(epoch from now() - backend_start) * 1000),
         round(extract(epoch from now() - state_change) * 1000),
         coalesce(round(extract(epoch from now() - xact_start) * 1000), -1),
         left(regexp_replace(query, '\\s+', ' ', 'g'), 160)
  FROM pg_stat_activity
  WHERE datname = 'maplespire' AND client_addr = '${ip}'
  ORDER BY backend_start`

async function census(ip, phase) {
  const raw = await dockerAsync('exec', PG, 'psql', '-U', 'maplespire', '-d', 'maplespire',
    '-A', '-F', SEP, '-t', '-c', CENSUS_SQL(ip))
  const rows = raw.split('\n').filter((l) => l.trim() !== '').map((line) => {
    const c = line.split(SEP)
    return {
      pid: Number(c[0]),
      state: c[1],
      waitEventType: c[2] || null,
      waitEvent: c[3] || null,
      backendAgeMs: Number(c[4]),
      stateAgeMs: Number(c[5]),
      xactAgeMs: Number(c[6]) < 0 ? null : Number(c[6]),
      statement: (c[7] ?? '').trim(),
    }
  })
  return {
    phase,
    atMs: Date.now(),
    afterOutageSeconds: secondsAfterOutage(),
    backends: rows.length,
    byState: rows.reduce((acc, r) => { acc[r.state] = (acc[r.state] ?? 0) + 1; return acc }, {}),
    rows,
  }
}

/**
 * A statement reduced to something countable across samples. Every statement
 * this server issues already carries `$n` placeholders rather than inlined
 * values, so the text is stable per call site with no normalisation beyond the
 * whitespace collapse the SQL above already did.
 */
const fingerprint = (statement) => statement.slice(0, 90)

/** The one statement that names the lifecycle apply lock's holder. */
const LOCK_FINGERPRINT = 'SELECT pg_try_advisory_lock('

// ── HTTP ───────────────────────────────────────────────────────────────────

async function req(url, { cookie, method = 'GET', body, timeoutMs = 120_000 } = {}) {
  const headers = {}
  if (cookie) headers.Cookie = cookie
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const startedAt = Date.now()
  const startedAfterOutage = secondsAfterOutage()
  let response
  try {
    response = await fetch(url, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return {
      url, status: null, durationMs: Date.now() - startedAt, startedAfterOutage,
      transportError: String(error?.message ?? error), body: null, retryAfter: null,
    }
  }
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { parsed = { raw: text.slice(0, 400) } }
  return {
    url,
    status: response.status,
    durationMs: Date.now() - startedAt,
    startedAfterOutage,
    transportError: null,
    retryAfter: response.headers.get('retry-after'),
    body: parsed,
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

async function cellState(cookie, base = CELL) {
  const ready = await req(`${base}/api/ready`, { timeoutMs: 30_000 })
  const cell = await req(`${base}/api/platform/sync-cell`, { cookie, timeoutMs: 30_000 })
  return {
    converged: ready.body?.checks?.syncCellConverged ?? null,
    redisReady: ready.body?.checks?.redis ?? null,
    databaseReachable: ready.body?.checks?.database ?? null,
    readyDurationMs: ready.durationMs,
    partitionIndex: cell.body?.partitionIndex ?? null,
    ownedWorkspaceCount: cell.body?.ownedWorkspaceCount ?? null,
    expectedWorkspaceCount: cell.body?.expectedWorkspaceCount ?? null,
  }
}

/**
 * Settle, or say which settled state this is. Three cells over two partitions
 * means one is ALWAYS the spare, and a spare reports `syncCellConverged: false`
 * BY DESIGN — waiting for `true` on one waits for ever and then calls it a
 * timeout.
 */
async function awaitSettled(cookie, base, timeoutSeconds = 90) {
  for (let attempt = 1; attempt <= timeoutSeconds; attempt += 1) {
    const state = await cellState(cookie, base)
    if (state.converged === true) return { ...state, base, polls: attempt, settled: 'converged' }
    if (state.partitionIndex === null && state.expectedWorkspaceCount === 0 && attempt >= 10) {
      return { ...state, base, polls: attempt, settled: 'spare' }
    }
    await sleep(1_000)
  }
  const state = await cellState(cookie, base)
  return { ...state, base, polls: timeoutSeconds, settled: 'unsettled' }
}

async function pickOwningCell() {
  const rejected = []
  for (let i = 0; i < CELL_URLS.length; i += 1) {
    const base = CELL_URLS[i]
    const cookie = await login(base).catch(() => null)
    if (!cookie) { rejected.push({ base, why: 'dev-login failed' }); continue }
    const settled = await awaitSettled(cookie, base)
    if (settled.settled !== 'converged') { rejected.push({ base, why: `settled=${settled.settled}` }); continue }
    log(`  using ${base} (${CELL_CONTAINERS[i]})`)
    return { base, container: CELL_CONTAINERS[i], cookie, settled, rejected }
  }
  throw new Error(`no cell converged: ${JSON.stringify(rejected)}`)
}

/**
 * A workspace this cell owns whose promotion dry run reports no blockers.
 * Promotion is the LOAD, so the preparation must be complete before any arm
 * starts: a promotion that refuses on `read-model-not-caught-up` never reaches
 * the lock and would be recorded as a holder that did not hold.
 */
async function preparePromotable(cookie, tag) {
  for (let round = 1; round <= 6; round += 1) {
    // SEVERAL LANDSCAPES PER ROUND, not one. The bench runs two partitions, so a
    // new landscape lands on THIS cell only about half the time and the rest
    // answer 503 `workspace owner unavailable` here. A single creation per round
    // can burn every round on coin flips and fail with a message naming the
    // wrong cause.
    let w = null
    for (let attempt = 1; attempt <= 10 && !w; attempt += 1) {
      const created = await req(`${CELL}/api/landscapes`, {
        cookie, method: 'POST', body: { name: `b25c ${tag} r${round} n${attempt}` }, timeoutMs: 60_000,
      })
      const l = created.body?.landscape
      if (!l?.id || !l?.defaultVersionId) { await sleep(500); continue }
      const candidate = { landscapeId: l.id, versionId: l.defaultVersionId }
      const owned = await req(`${CELL}/api/automerge/root?${new URLSearchParams(candidate)}`, { cookie, timeoutMs: 30_000 })
      if (owned.status === 200) w = candidate
    }
    if (!w) continue

    for (let attempt = 1; attempt <= 40; attempt += 1) {
      await req(`${CELL}/api/model/cache/estimate?${new URLSearchParams(w)}`, { cookie, timeoutMs: 30_000 })
      const dry = await req(`${CELL}/api/platform/workspace/promote-summary`, {
        cookie, method: 'POST', body: { ...w, apply: false }, timeoutMs: 60_000,
      })
      const codes = (dry.body?.blockers ?? []).map((b) => b.code)
      if (dry.status === 200 && codes.length === 0) return w
      if (!codes.includes('read-model-not-caught-up') && !codes.includes('read-model-not-sealed')) break
      await sleep(1_500)
    }
  }
  throw new Error(`[${tag}] could not prepare a promotable workspace on this cell`)
}

const firePromote = async (cookie, w, tag) => ({
  tag,
  ...(await req(`${CELL}/api/platform/workspace/promote-summary`, {
    cookie, method: 'POST', body: { ...w, apply: true }, timeoutMs: 180_000,
  })),
})

// ── the run ────────────────────────────────────────────────────────────────

let restoring = false
const restoreRedis = (why) => {
  if (restoring) return
  restoring = true
  try {
    docker('start', REDIS)
    log(`redis restored (${why})`)
  } catch (error) {
    log(`!! FAILED TO RESTORE REDIS (${why}): ${error?.message ?? error} — start it by hand: docker start ${REDIS}`)
  }
}

const record = {
  measureId: 'B2-5c-probe',
  label: LABEL,
  takenOn: new Date().toISOString(),
  outcome: 'incomplete — the run did not reach its own verdict',
  knobs: { FANOUT, CENSUS_INTERVAL_MS, READY_INTERVAL_MS, PLATEAU_MS, OUTAGE_SECONDS },
  cell: null,
  cellIp: null,
  cellEnv: null,
  arms: {},
  readyShots: [],
  cellLogTimeouts: null,
  stateBefore: null,
  stateAfterRecovery: null,
  verdict: null,
}

/**
 * Written on EVERY exit path, success and failure alike, so a later throw
 * (e.g. in the recovery control) cannot take the measurement with it.
 */
const writeRecord = (outcome) => {
  record.outcome = outcome
  try {
    writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`)
    log(`record written to ${OUT} (${outcome})`)
  } catch (error) {
    log(`!! could not write ${OUT}: ${error?.message ?? error}`)
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreRedis(signal)
    writeRecord(`aborted by ${signal}`)
    process.exit(130)
  })
}

function cellEnvValue(name) {
  const raw = docker('inspect', CELL_CONTAINER, '--format', '{{range .Config.Env}}{{println .}}{{end}}')
  const line = raw.split('\n').find((l) => l.startsWith(`${name}=`))
  return line === undefined ? null : line.slice(name.length + 1).trim()
}

let sampling = false

async function censusLoop(ip, phase, sink) {
  while (sampling) {
    try {
      sink.push(await census(ip, phase))
    } catch (error) {
      sink.push({ phase, atMs: Date.now(), censusError: String(error?.message ?? error) })
    }
    await sleep(CENSUS_INTERVAL_MS)
  }
}

/**
 * THE PLATEAU WITNESS. `/api/ready` runs `pool.query('SELECT 1')` on the PRIMARY
 * pool (`index.ts`) behind no ownership gate, no read-model gate and no
 * single-flight (see the header). Its LATENCY is the acquisition
 * wait, and `checks.database` is an independent second witness of the same
 * event: the route swallows the error and reports `false`.
 *
 * It is not free of effect on the thing it measures: each poll is itself a
 * borrow, so during starvation these queue like any other borrower. The interval
 * is 1.5 s against a 10 s timeout, so at most ~7 of this probe's own polls can
 * be outstanding, and the count is recorded rather than assumed away.
 */
async function readyLoop(phase) {
  while (sampling) {
    const shot = await req(`${CELL}/api/ready`, { timeoutMs: 30_000 })
    record.readyShots.push({
      phase,
      atMs: Date.now(),
      afterOutageSeconds: shot.startedAfterOutage,
      durationMs: shot.durationMs,
      status: shot.status,
      databaseReachable: shot.body?.checks?.database ?? null,
      redisReady: shot.body?.checks?.redis ?? null,
      plateau: shot.durationMs >= PLATEAU_MS,
    })
    await sleep(READY_INTERVAL_MS)
  }
}

/** Run one arm: start sampling, do the work, stop sampling. */
async function arm(name, ip, work) {
  const samples = []
  sampling = true
  const loops = Promise.all([censusLoop(ip, name, samples), readyLoop(name)])
  let result
  try {
    result = await work()
  } finally {
    sampling = false
    await loops
  }
  record.arms[name] = { samples, result, attribution: attribute(samples) }
  const a = record.arms[name].attribution
  const lock = a.byStatement.find((s) => s.statement.startsWith(LOCK_FINGERPRINT))
  log(`  [${name}] ${samples.length} samples, max backends ${a.maxBackends}`
    + `, lock-holders max ${lock?.maxConcurrentBackends ?? 0}, dwell max ${lock?.maxStateAgeMs ?? 0} ms`)
  return record.arms[name]
}

/**
 * The attribution: over a window, how many backends carried each statement AT
 * ONCE, and how long the longest one dwelled on it. The maximum PER SAMPLE, not
 * a sum across samples — summing 200 samples of the same nine long-lived
 * backends would report 1 800 holders.
 */
function attribute(samples) {
  const perFingerprint = new Map()
  let maxBackends = 0
  for (const sample of samples) {
    if (!sample.rows) continue
    maxBackends = Math.max(maxBackends, sample.rows.length)
    const perSample = new Map()
    for (const row of sample.rows) {
      const key = fingerprint(row.statement)
      const seen = perSample.get(key) ?? { count: 0, states: new Set(), maxStateAgeMs: 0, waits: new Set() }
      seen.count += 1
      seen.states.add(row.state)
      seen.maxStateAgeMs = Math.max(seen.maxStateAgeMs, row.stateAgeMs)
      if (row.waitEventType) seen.waits.add(`${row.waitEventType}:${row.waitEvent}`)
      perSample.set(key, seen)
    }
    for (const [key, seen] of perSample) {
      const agg = perFingerprint.get(key) ?? {
        statement: key, maxConcurrentBackends: 0, samplesPresent: 0,
        states: new Set(), maxStateAgeMs: 0, waits: new Set(),
      }
      agg.maxConcurrentBackends = Math.max(agg.maxConcurrentBackends, seen.count)
      agg.samplesPresent += 1
      for (const s of seen.states) agg.states.add(s)
      for (const wv of seen.waits) agg.waits.add(wv)
      agg.maxStateAgeMs = Math.max(agg.maxStateAgeMs, seen.maxStateAgeMs)
      perFingerprint.set(key, agg)
    }
  }
  return {
    samples: samples.length,
    maxBackends,
    byStatement: [...perFingerprint.values()]
      .map((a) => ({ ...a, states: [...a.states].sort(), waits: [...a.waits].sort() }))
      .sort((a, b) => b.maxConcurrentBackends - a.maxConcurrentBackends),
  }
}

const lockHolders = (armName) => {
  const found = record.arms[armName]?.attribution.byStatement
    .find((s) => s.statement.startsWith(LOCK_FINGERPRINT))
  return { maxConcurrent: found?.maxConcurrentBackends ?? 0, maxDwellMs: found?.maxStateAgeMs ?? 0 }
}

const main = async () => {
  log(`B2-5c pool-attribution probe — label='${LABEL}'`)

  const picked = await pickOwningCell()
  CELL = picked.base
  CELL_CONTAINER = picked.container
  record.cell = { base: CELL, container: CELL_CONTAINER, rejected: picked.rejected, settled: picked.settled }
  const cookie = picked.cookie

  const ip = containerIp(CELL_CONTAINER)
  record.cellIp = ip
  record.cellEnv = {
    DB_POOL_MAX: cellEnvValue('DB_POOL_MAX'),
    DB_READ_MODEL_POOL_MAX: cellEnvValue('DB_READ_MODEL_POOL_MAX'),
    SYNC_CELL_DB_POOL_MAX: cellEnvValue('SYNC_CELL_DB_POOL_MAX'),
    DB_CONNECTION_TIMEOUT_MS: cellEnvValue('DB_CONNECTION_TIMEOUT_MS'),
    DB_IDLE_TIMEOUT_MS: cellEnvValue('DB_IDLE_TIMEOUT_MS'),
  }
  log(`  cell ip ${ip}; pool knobs ${JSON.stringify(record.cellEnv)}`)

  record.stateBefore = await cellState(cookie)
  log(`  before: redis=${record.stateBefore.redisReady} converged=${record.stateBefore.converged}`)

  // ── arm 0: the idle baseline. What is checked out when nothing is happening.
  await arm('idle-baseline', ip, async () => { await sleep(8_000); return 'no load' })

  // ── prepare the load. Sequential on purpose: preparation itself promotes
  //    nothing, but it drives the read model, and doing it under measurement
  //    would put its own borrows in the arm being attributed.
  //
  //    TWICE the fan-out plus one. Re-firing already-promoted workspaces during
  //    the outage returns 409 at once and the arm carries NO LOAD AT ALL —
  //    "0 lock holders" that is the absence of an experiment. Fresh workspaces
  //    cannot be prepared once the outage starts (preparation needs the very
  //    ownership the outage removes), so the outage arm's load is prepared
  //    beforehand.
  //    PREPARED IN TWO BATCHES, EACH JUST BEFORE ITS ARM: a workspace's
  //    promotion preconditions go stale while it waits, and stale ones refuse
  //    in milliseconds — an arm with 0 holders that reads like "the fix
  //    worked" and means "the load never ran".
  const prepareBatch = async (count, label) => {
    const batch = []
    log(`preparing ${count} promotable workspaces (${label}) …`)
    for (let i = 0; i < count; i += 1) {
      batch.push(await preparePromotable(cookie, `${label}-${i}`))
      log(`  ${label}: ${batch.length}/${count}`)
    }
    return batch
  }
  const prepared = await prepareBatch(FANOUT + 1, 'healthy')

  // ── arm 1: ONE promotion, Redis up. Does a single backend dwell?
  //    The LAST prepared workspace, not the first. A promotion's preconditions
  //    go stale while the rest of the batch is prepared, and `prepared[0]` has
  //    waited the longest; firing it would measure preparation order, not the
  //    lock.
  await arm('single-promote-redis-up', ip, () => firePromote(cookie, prepared[FANOUT], 'single'))

  // ── arm 2: FANOUT promotions at once, Redis up. Does the count follow?
  await arm('fanout-promote-redis-up', ip, () => Promise.all(
    prepared.slice(0, FANOUT).map((w, i) => firePromote(cookie, w, `fanout-${i}`)),
  ))

  // ── arm 3: the same fan-out during a Redis outage, on a FRESH batch prepared
  //    now rather than twenty minutes ago. It has to be prepared BEFORE Redis
  //    stops: preparation needs the very ownership the outage removes.
  const outageBatch = await prepareBatch(FANOUT, 'outage')

  const logSince = new Date().toISOString()
  log(`stopping ${REDIS} …`)
  docker('stop', REDIS)
  outageStartedAtMs = Date.now()
  try {
    await arm('fanout-promote-redis-down', ip, async () => {
      // The SECOND batch, never promoted. See the preparation block for why
      // re-firing the first batch would measure nothing.
      const fired = await Promise.all(
        outageBatch.map((w, i) => firePromote(cookie, w, `outage-${i}`)),
      )
      const remaining = OUTAGE_SECONDS * 1_000 - (Date.now() - outageStartedAtMs)
      if (remaining > 0) await sleep(remaining)
      return fired
    })
  } finally {
    record.cellLogTimeouts = await dockerAsync('logs', '--since', logSince, CELL_CONTAINER)
      .then((out) => {
        const lines = out.split('\n').filter((l) => /timeout exceeded when trying to connect/i.test(l))
        return { matchedLines: lines.length, sample: lines.slice(0, 12) }
      })
      .catch((error) => ({ error: String(error?.message ?? error) }))
    restoreRedis('outage arm complete')
  }

  // ── arm 4: recovery.
  await arm('recovery', ip, async () => { await sleep(20_000); return 'settling' })
  record.stateAfterRecovery = await cellState(cookie).catch((e) => ({ error: String(e?.message ?? e) }))

  // ── verdict ──────────────────────────────────────────────────────────────
  const idle = lockHolders('idle-baseline')
  const single = lockHolders('single-promote-redis-up')
  const fanUp = lockHolders('fanout-promote-redis-up')
  const fanDown = lockHolders('fanout-promote-redis-down')
  const readyByPhase = (phase) => record.readyShots.filter((s) => s.phase === phase)
  const plateauIn = (phase) => readyByPhase(phase).filter((s) => s.plateau)

  /**
   * DID THE LOAD REACH THE MECHANISM AT ALL? A promotion that refuses before
   * taking the lock — 409 on an already-promoted workspace, say — exercises
   * nothing, and an arm made entirely of those reports "0 holders" in exactly
   * the words a real negative result would use. This is the discriminator, and
   * it is reported for every arm rather than assumed.
   */
  const promotionsThatWorked = (armName) => {
    const result = record.arms[armName]?.result
    const shots = Array.isArray(result) ? result : [result]
    return shots.filter((s) => s && typeof s === 'object' && s.status !== null && s.status !== 409).length
  }
  /** What the doors actually answered, per status. */
  const answersFor = (armName) => {
    const result = record.arms[armName]?.result
    const shots = (Array.isArray(result) ? result : [result]).filter((s) => s && typeof s === 'object' && s.status)
    return [...new Set(shots.map((s) => JSON.stringify({
      status: s.status, ms: s.durationMs, retryAfter: s.retryAfter, body: s.body?.error ?? null, code: s.body?.code ?? null,
    })))]
  }

  record.verdict = {
    /**
     * THE CONTROL, and it is a NEGATIVE one: with no load, no backend may be
     * dwelling on the lock statement. If the idle baseline already shows a
     * holder, the fan-out arms are measuring something that was there before
     * them and nothing below is attributable to the promotions.
     */
    idleBaselineClean: idle.maxConcurrent === 0,
    lockHolders: { idle, single, fanoutRedisUp: fanUp, fanoutRedisDown: fanDown },
    loadReachedMechanism: Object.fromEntries(
      Object.keys(record.arms).map((name) => [name, promotionsThatWorked(name)]),
    ),
    doorAnswers: Object.fromEntries(
      ['single-promote-redis-up', 'fanout-promote-redis-up', 'fanout-promote-redis-down']
        .map((name) => [name, answersFor(name)]),
    ),
    /** Does ONE promotion hold ONE client, and for roughly the arming bound? */
    singleHolderObserved: single.maxConcurrent >= 1,
    singleArmExercisedTheMechanism: promotionsThatWorked('single-promote-redis-up') > 0,
    singleDwellMs: single.maxDwellMs,
    /** Does the holder count follow the fan-out? */
    holdersScaleWithLoad: fanUp.maxConcurrent > single.maxConcurrent,
    maxBackendsByArm: Object.fromEntries(
      Object.entries(record.arms).map(([name, a]) => [name, a.attribution.maxBackends]),
    ),
    readyPlateauByArm: Object.fromEntries(
      Object.keys(record.arms).map((name) => [name, {
        shots: readyByPhase(name).length,
        plateaus: plateauIn(name).length,
        maxDurationMs: readyByPhase(name).length ? Math.max(...readyByPhase(name).map((s) => s.durationMs)) : null,
        databaseFalse: readyByPhase(name).filter((s) => s.databaseReachable === false).length,
      }]),
    ),
    cellLogTimeouts: record.cellLogTimeouts,
  }

  if (!record.verdict.idleBaselineClean) {
    writeRecord('VOID — the idle baseline already showed a lock holder; the fan-out arms attribute nothing')
    return
  }
  if (record.verdict.loadReachedMechanism['fanout-promote-redis-up'] === 0) {
    writeRecord('VOID — every promotion in the healthy fan-out arm refused before taking the lock, so this run exercised nothing')
    return
  }
  if (!record.verdict.singleHolderObserved && !record.verdict.singleArmExercisedTheMechanism) {
    // NOT a negative result. The single-promotion arm can refuse for its own
    // reasons — e.g. a 409 on `read-model-not-caught-up` — and an arm whose
    // request never reached the lock says nothing
    // about whether the lock pins a client. Reported as inconclusive so the
    // fan-out arms below still stand on their own.
    writeRecord(`INCONCLUSIVE single arm (it refused before taking the lock); fan-out holders up=${fanUp.maxConcurrent} down=${fanDown.maxConcurrent}`)
    return
  }
  writeRecord(`attributed — single hold ${single.maxDwellMs} ms; holders idle=${idle.maxConcurrent}`
    + ` single=${single.maxConcurrent} fanout-up=${fanUp.maxConcurrent} fanout-down=${fanDown.maxConcurrent}`)
}

main().catch((error) => {
  sampling = false
  restoreRedis('probe threw')
  record.error = String(error?.stack ?? error)
  writeRecord(`FAILED — ${String(error?.message ?? error)}`)
  process.exitCode = 1
})
