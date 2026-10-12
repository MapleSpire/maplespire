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
 * The bring-up the four `verify:sync-*` gates do NOT do for themselves.
 *
 * WHY THIS FILE EXISTS. Every one of those gates assumes an ambient stack:
 * `verify-sync-cell-active-active.mjs` calls `login()` as its first act and
 * dies on ECONNREFUSED without one, and its `compose(...)` helper is not
 * reached until well after that — where it writes to the database with `psql`,
 * starts the maintenance worker with `run --rm`, and reads logs. This file is
 * the executable procedure that satisfies that assumption, so a workflow can
 * run the gates.
 *
 * WHAT IT IS NOT. It is not a test framework and it asserts nothing about the
 * product. It owns a LIFECYCLE — resolve, refuse, start, prove the stack is
 * actually serving, run one gate, tear down — and every product assertion still
 * belongs to the gate it runs.
 *
 * ONE LEG PER INVOCATION, DELIBERATELY. The four gates do not share a topology
 * and cannot share a stack; both halves of that are measured, and the reasons
 * are on `LEGS` below.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { postureChoice, resolveShippedPosture, shippedOverrides, benchDefaultOverrides, resolvedBenchPosture, inspectRunningPosture } from './sync-bench-posture.mjs'
import { assertCalibrationReceipt, calibrationProjectCensus, runIsolatedCalibrationStage } from './sync-cell-calibration.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const serverDir = resolve(here, '..')
const composeFile = resolve(here, '../../infra/compose/sync-cell-failover.yml')
const repoRoot = resolve(here, '../..')
/** The conf the compose file mounts over nginx's own (`router` service volume). */
export const routerConfFile = resolve(repoRoot, 'infra/compose/sync-cell-router.nginx.conf')
/** The image the compose file builds for the cells and the ws-router (its `image:` line). */
export const API_IMAGE = 'maplespire-sync-failover-api:local'
/**
 * The label the compose file stamps on that image at build time, from
 * `SYNC_FAILOVER_IMAGE_REVISION` — which this runner sets to the tree it builds
 * from (`<sha>` or `<sha>-dirty`). Read back by `imageIdentity`, so a
 * `--no-build` run shows image-revision ≠ tree-revision instead of an
 * unanchored pairing: the record must say which server code the cells ran.
 */
export const IMAGE_REVISION_LABEL = 'org.opencontainers.image.revision'
export const IMAGE_INSPECT_FORMAT = `{{.Created}} {{.Id}} {{index .Config.Labels "${IMAGE_REVISION_LABEL}"}}`
const serverScripts = JSON.parse(readFileSync(resolve(serverDir, 'package.json'), 'utf8')).scripts || {}

/** Path comparison that survives Windows drive-letter and separator casing. */
const samePath = (a, b) => resolve(a).replace(/[/\\]+$/, '').toLowerCase()
  === resolve(b).replace(/[/\\]+$/, '').toLowerCase()

/**
 * The services every leg needs, in the order compose resolves their
 * dependencies. `sync-cell-c` is NOT here: it carries `profiles: ["load"]`, so
 * compose starts it only when a leg names it, and only the load leg does.
 */
const CORE_SERVICES = [
  'postgres',
  'redis',
  'redis-render-cache',
  'sync-cell-a',
  'sync-cell-b',
  'sync-ws-router',
  'router',
]

/**
 * THE FOUR GATES, AND THE THREE TOPOLOGIES THEY NEED.
 *
 * The four gates cannot share one partition count, which is why each leg
 * below carries its own `partitionCount`:
 *
 *   $ SYNC_FAILOVER_PARTITION_COUNT=2 npm run verify:sync-failover
 *   Error: expected sync-cell-b to be standby, got partition 1
 *
 * `verify-sync-cell-failover.mjs` reads exactly two cells and requires
 * one of them to own partition 0 while the OTHER owns nothing. At two
 * partitions both own a slot, which is the very state
 * `verify-sync-cell-active-active.mjs` waits for. So the failover pair needs one
 * partition and the active-active gate needs two — they are not two settings of
 * one bench, they are two benches.
 *
 * AND THE ACTIVE-ACTIVE LEG DELIBERATELY OMITS `sync-cell-c`. The gate reads
 * cells a and b only and waits for them to hold partitions 0 and 1. With a third
 * cell racing for the same two slots, a run in which c wins one leaves a or b
 * permanently spare and the gate waits out its ceiling — a flake whose cause is
 * the harness.
 */
const LEGS = {
  'failover': {
    partitionCount: 1,
    services: CORE_SERVICES,
    script: 'verify:sync-failover',
    args: [],
    summary: 'active/standby lease expiry and takeover through the public router',
  },
  'redis-failover': {
    partitionCount: 1,
    services: CORE_SERVICES,
    script: 'verify:sync-redis-failover',
    args: [],
    summary: 'both cells fail closed during a total critical-Redis outage',
  },
  'active-active': {
    partitionCount: 2,
    services: CORE_SERVICES,
    script: 'verify:sync-active-active',
    args: [],
    summary: 'two partitions, each workspace owned by one cell and proxied by the other',
  },
  'load-soak': {
    partitionCount: 2,
    services: [...CORE_SERVICES, 'sync-cell-c'],
    script: 'verify:sync-load-soak',
    args: ['--mode=smoke'],
    summary: 'two hot workspaces and a spare cell under concurrent clients',
  },
}

function usage() {
  return `usage: node scripts/sync-cell-bench.mjs --leg=<${Object.keys(LEGS).join('|')}> [--keep] [--no-build] [--host=<name|ip>]
                                        [--mode=<smoke|soak|endurance>] [--load-profile=<contention|fleet>] [--users=<n>]

Brings up infra/compose/sync-cell-failover.yml for ONE leg, runs that leg's
gate, and tears the stack down. Every leg gets its own compose project and its
own published ports, so two legs can run side by side and neither inherits the
other's containers, volumes or logs.

  --keep          leave the stack running after the gate (for diagnosis)
  --no-build      reuse the existing image instead of rebuilding it
  --posture       bench or shipped: qualify the fleet baseline with explicit
                  ownership/Redis settings; shipped reads the delivered anchor
                  and actual code defaults (other harness differences stay listed)
  --host          where the published ports are reachable when the stack runs
                  on another machine (pair with DOCKER_HOST=ssh://… for compose);
                  also binds the router and cell ports to 0.0.0.0 on that machine

The three below reach the load-soak leg only (they are ignored by the others):
  --mode          the gate's mode; the leg's default is smoke (soak is >= 2 h)
  --load-profile  contention (every user writes every shared object — the
                  historical shape) or fleet (many connected, few writing, on
                  distinct objects); see LOAD_PROFILES in the load gate
  --users         users per hot workspace, overriding the profile's default

SYNC_FAILOVER_AUTH_SECRET is generated per run when unset.`
}

/**
 * The load-soak knobs a soak run needs, as ONE command line.
 *
 * The leg hard-codes `--mode=smoke`; these overrides avoid invoking the gate
 * directly with a hand-copied environment block (and its transcription
 * errors). `--mode` replaces the leg's default argument; the other two travel as
 * the gate's own environment variables, so the gate's validation (bounds,
 * writers ≤ users) stays the single place the numbers are checked.
 */
export function loadSoakOverrides(argv) {
  const value = (flag) => argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
  const mode = value('--mode')
  const profile = value('--load-profile')
  const users = value('--users')
  return {
    args: mode ? [`--mode=${mode}`] : null,
    env: {
      ...(profile ? { SYNC_LOAD_PROFILE: profile } : {}),
      ...(users ? { SYNC_LOAD_USERS_PER_WORKSPACE: users } : {}),
    },
  }
}

/**
 * `--host=<name or address>`: where the published ports are reachable when the
 * compose stack runs on ANOTHER machine (`DOCKER_HOST=ssh://…` carries the
 * `docker compose` side; this carries the HTTP/WebSocket side, for this file's
 * own readiness probe and, through `SYNC_FAILOVER_HOST`, for the gate and its
 * load clients). Loopback when absent — every existing invocation unchanged.
 */
export function benchHostOverride(argv) {
  const host = argv.find((arg) => arg.startsWith('--host='))?.slice(7)?.trim()
  // The compose file binds every published port to `${SYNC_FAILOVER_BIND:-127.0.0.1}`;
  // a stack that must be reached from another machine has to listen on that
  // machine's interfaces, or the runner's own readiness probe fails after 90 s
  // and the gate never starts. Loopback stays the default for every
  // single-host run.
  return host ? { SYNC_FAILOVER_HOST: host, SYNC_FAILOVER_BIND: '0.0.0.0' } : {}
}

/**
 * Refusals THROW; they do not exit.
 *
 * `process.exit()` does not run `finally`, so a `fail()` raised after bring-up —
 * a cell that never served, a gate that could not start — would have left seven
 * containers and two volumes behind on every failing CI run, and the next leg
 * would have collided with them. The teardown is in a `finally`, and this is
 * what keeps it reachable.
 */
class BenchRefusal extends Error {}

function fail(message) {
  throw new BenchRefusal(message)
}

/**
 * The router's event model, read from the conf the compose file mounts over
 * nginx's own, so the run log carries the number the router ALLOWED (an empty
 * `events {}` silently leaves nginx on its compiled-in 512). A directive the
 * file does not set is `null` and is printed as `unset` — never defaulted here,
 * because a default written in this file would be a second copy of nginx's
 * that nothing keeps in step. Comments are stripped first: a commented-out
 * directive is not a setting.
 *
 * Not an nginx grammar: the strip is line-based (not quote-aware) and the
 * first occurrence anywhere in the file wins. Both shapes that could mislead it
 * — a directive inside `http {}`, a duplicate — are confs nginx refuses at
 * start, so `up --wait` fails before anything is printed.
 */
export function routerEventsSummary(confText) {
  const uncommented = String(confText).replace(/#[^\n]*/g, '')
  const directive = (name) => {
    const match = uncommented.match(new RegExp(`(?:^|[\\s{;])${name}\\s+([^;\\s]+)\\s*;`))
    return match ? match[1] : null
  }
  return {
    workerProcesses: directive('worker_processes'),
    workerRlimitNofile: directive('worker_rlimit_nofile'),
    workerConnections: directive('worker_connections'),
  }
}

/**
 * The router's event model AS THE RUNNER READS IT — through `routerConfFile`,
 * so a test that goes through this function travels the path `main()` does
 * (a test parsing a path of its own would not notice the runner reading the
 * wrong file).
 */
export function routerSummaryForRun() {
  return routerEventsSummary(readFileSync(routerConfFile, 'utf8'))
}

const runExec = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })

/**
 * The commit this tree is at, `-dirty` when the tree is NOT that commit: a
 * tracked change anywhere, or an untracked file under server/ or infra/ — the
 * image's build context, the runner, the gates and the compose file, where an
 * untracked file changes what RUNS (a log written under docs/ does not). A
 * status that cannot be read is `-unverified`, never silently clean.
 * `exec` is injectable so the test EXECUTES every branch.
 */
export function gitIdentity(exec = runExec) {
  let sha
  try {
    sha = exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).trim()
  } catch {
    return null
  }
  try {
    const tracked = exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot })
    const inputs = exec('git', ['status', '--porcelain', '--untracked-files=all', '--', 'server', 'infra'], { cwd: repoRoot })
    return `${sha}${`${tracked}${inputs}`.trim() ? '-dirty' : ''}`
  } catch {
    return `${sha}-unverified`
  }
}

/**
 * The image compose brought up — inspected through the same `DOCKER_HOST`, so
 * on a two-host run it is the stack host's image, the one the cells run:
 * created timestamp, id, and the revision it was built from (`unlabelled` for
 * an image built without the label). Null when the inspect fails or hangs past
 * 30 s; the leg still runs and the record says so.
 *
 * Under BuildKit `Created` is the cached layers' time, not this build's: a
 * rebuild that only changes the label keeps it to the nanosecond. The revision
 * and the id identify the image; the timestamp is kept for the reader, not as
 * identity.
 */
export function imageIdentity(env, exec = runExec) {
  try {
    const [created, id, revision] = exec('docker', ['image', 'inspect', API_IMAGE, '--format', IMAGE_INSPECT_FORMAT],
      { env: { ...process.env, ...env }, timeout: 30_000 }).trim().split(/\s+/)
    return `${created} ${id} revision=${revision || 'unlabelled'}`
  } catch {
    return null
  }
}

/**
 * The one line an operator keeps per pass: what ran, under which router
 * settings, reached where. Pure, so the test asserts the exact string and a
 * label/value swap cannot survive.
 */
export function describeRun({ image, commit, router, host, bind }) {
  const show = (value) => value ?? 'unset'
  return `[bench] image ${image ?? '(not inspected)'} · commit ${commit ?? '(git unavailable or not a checkout)'}`
    + ` · router worker_processes=${show(router.workerProcesses)} worker_connections=${show(router.workerConnections)}`
    + ` worker_rlimit_nofile=${show(router.workerRlimitNofile)} · host ${host} bind ${bind}`
}

/**
 * Ports are derived from the leg, never defaulted.
 *
 * The gates disagree about their own defaults: each defaults the compose
 * PROJECT differently, and the two that read a router port default it to
 * different values. A bring-up using the compose file's defaults and a gate
 * using its own would look like a working pair and not be one — and quietly:
 * `docker compose -p <a project that does not exist> logs sync-cell-a` prints
 * nothing and exits 0.
 *
 * So the block is computed ONCE and the identical environment goes to
 * `docker compose` and to the gate child process, so neither can fall back to
 * a default for the PROJECT AND PORTS. Other variables the gates read
 * (`SYNC_FAILOVER_LOGIN_EMAIL`, the `SYNC_LOAD_*` knobs) keep their own
 * defaults, deliberately.
 */

function environmentFor(legName, leg) {
  const slot = Object.keys(LEGS).indexOf(legName)
  const base = 3410 + slot * 10
  return {
    SYNC_FAILOVER_PROJECT: `maplespire-bench-${legName}`,
    SYNC_FAILOVER_PARTITION_COUNT: String(leg.partitionCount),
    SYNC_FAILOVER_TOPOLOGY_GENERATION: `bench-${legName}-v1`,
    SYNC_FAILOVER_ROUTER_PORT: String(base),
    SYNC_FAILOVER_CELL_A_PORT: String(base + 1),
    SYNC_FAILOVER_CELL_B_PORT: String(base + 2),
    SYNC_FAILOVER_CELL_C_PORT: String(base + 3),
    SYNC_FAILOVER_POSTGRES_PORT: String(55600 + slot),
    SYNC_FAILOVER_FRONTEND_PORT: String(5400 + slot),
    SYNC_FAILOVER_APP_URL: `http://127.0.0.1:${5400 + slot}`,
    SYNC_FAILOVER_AUTH_SECRET: process.env.SYNC_FAILOVER_AUTH_SECRET
      || randomBytes(32).toString('hex'),
  }
}

/**
 * Teardown that actually reaches a PROFILED service.
 *
 * `docker compose down -v --remove-orphans` on this file leaves `sync-cell-c`
 * running: it sits behind `profiles: ["load"]`, and a `down` that does not
 * select that profile does not consider it part of the project to stop.
 *
 * That matters here more than it would elsewhere: the load-soak gate refuses to
 * share a project with a concurrent run, so a leftover cell from a previous
 * leg makes the next one fail as if the product were at fault.
 * `--profile '*'` selects every profile, which is the same resolution
 * `scripts/deploy-startup-pairs.test.mjs` uses for the same file.
 */
const TEARDOWN = ['--profile', '*', 'down', '-v', '--remove-orphans']

function compose(env, args, options = {}) {
  try {
    return execFileSync(
      'docker',
      ['compose', '-p', env.SYNC_FAILOVER_PROJECT, '-f', composeFile, ...args],
      { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], ...options },
    )
  } catch (error) {
    // A MISSING DOCKER IS THE LIKELIEST FAILURE ON A LAPTOP OR A BARE RUNNER:
    // say so in one sentence instead of `spawnSync docker ENOENT` plus a node
    // stack. Everything else keeps its error, stderr included.
    if (error?.code === 'ENOENT') {
      fail('docker is not on PATH. This bench needs the Docker CLI and a running daemon; it starts seven containers.')
    }
    throw error
  }
}

/**
 * The compose file as the DAEMON will read it — anchors, `${VAR:-default}` and
 * `${VAR:?message}` all already applied.
 *
 * Resolved rather than parsed: re-implementing that resolution is how a check
 * ends up green over a file the daemon reads differently.
 */
function resolvedConfig(env) {
  return JSON.parse(compose(env, ['--profile', '*', 'config', '--format', 'json']))
}

/**
 * Every service in the file is either STARTED by this leg or excluded for a
 * reason that is a property of the service, not its name.
 *
 * A HAND-WRITTEN SERVICE LIST GOES STALE SILENTLY: a service added to the
 * compose file later
 * would simply not start, the gate would run against an incomplete stack, and
 * the result would be a pass. So the list is CHECKED against the resolved file
 * rather than trusted, and anything neither started nor classified stops the run.
 *
 * The two exclusions are structural:
 *
 *   - a service carrying `profiles` is opt-in BY COMPOSE'S OWN SEMANTICS; it
 *     starts only when a leg names it. `sync-cell-c` (profile `load`) and
 *     `global-gc-worker` (profile `maintenance`) are both here, and the
 *     active-active gate runs the latter itself with
 *     `compose --profile maintenance run --rm global-gc-worker`.
 *   - a service built from a context OUTSIDE `server/` is the browser tier. No
 *     gate speaks to it: all four talk HTTP and WebSocket to the cells and to
 *     the router directly. That claim is not left as prose — `assertGateInventory`
 *     re-derives it from the gates' own source on every run, though only as far
 *     as a text search can: it looks for the frontend's published-port variable
 *     and for the service name, and a gate reaching that tier by a bare literal
 *     port would pass it. Named here rather than implied.
 *
 * Exclusion rests only on "no gate contacts it", which is checkable and is
 * checked — never on an unchecked property such as whether an image builds.
 */
function classifyServices(config, leg) {
  const all = Object.entries(config.services || {})
  // THE FLOOR MUST NOT EQUAL WHAT THE FAILURE PRODUCES. The file declares ten
  // services, two of them profile-gated. The likeliest degradation of
  // `resolvedConfig` is `--profile '*'` not being honoured — an older Compose,
  // or an edit that drops it — and that returns exactly EIGHT, with
  // `unclassified` empty because absent services are not in `all`.
  //
  // So the discriminator is not the count but the PRESENCE of a profile-gated
  // service, which is the thing `--profile '*'` exists to return.
  if (all.length < 10) {
    fail(`the resolved compose file declares only ${all.length} services — the resolution returned something unexpected`)
  }
  const profiled = all.filter(([, service]) => Array.isArray(service.profiles) && service.profiles.length > 0)
  if (profiled.length === 0) {
    fail('the resolved compose file declares no profile-gated service, so `--profile \'*\'` was not honoured and this resolution is incomplete')
  }
  const started = new Set(leg.services)
  const unclassified = []
  const excluded = []
  for (const [name, service] of all) {
    if (started.has(name)) continue
    const profiles = Array.isArray(service.profiles) ? service.profiles : []
    if (profiles.length > 0) {
      excluded.push({ service: name, because: `profile-gated (${profiles.join(', ')}) and this leg does not name it` })
      continue
    }
    const context = String(service.build?.context ?? '')
    if (context && !samePath(context, serverDir)) {
      excluded.push({ service: name, because: `built from ${context}, outside server/ — the browser tier, which no gate contacts` })
      continue
    }
    unclassified.push(name)
  }
  if (unclassified.length > 0) {
    fail(
      `these services are in the compose file, are not started by this leg, and match no exclusion rule: ${unclassified.join(', ')}\n`
      + 'Either add them to the leg or give them a rule. A service the bench neither starts nor refuses is a stack the gate passes against by accident.',
    )
  }
  for (const name of leg.services) {
    if (!config.services?.[name]) fail(`this leg starts "${name}", which the resolved compose file does not declare`)
  }
  return excluded
}

/**
 * The gate scripts, taken from `package.json` rather than from their names.
 *
 * `verify:sync-redis-failover` runs `verify-sync-cell-failover.mjs --redis-outage`
 * — TWO GATES, ONE FILE — so substituting the script name into the filename
 * pattern names a file the tree does not have, and the browser-tier check
 * below would silently skip that gate.
 *
 * (The nonexistent filename is deliberately not spelled out here:
 * `scripts/test-citations.test.mjs` reads any `*.test.mjs`-shaped name in a
 * comment as a citation.)
 */
function gateSourceFiles() {
  const files = new Map()
  for (const [name, command] of Object.entries(serverScripts)) {
    if (!name.startsWith('verify:sync-')) continue
    const match = /(scripts[/\\][A-Za-z0-9._-]+\.mjs)/.exec(String(command))
    if (!match) continue
    files.set(name, resolve(serverDir, match[1]))
  }
  return files
}

/**
 * The argv a gate is launched with, taken whole from `package.json`.
 *
 * Returns [absolute .mjs path, ...the flags the script itself declares].
 */
function gateCommand(script) {
  const command = String(serverScripts[script] ?? '')
  const parts = command.split(/\s+/).filter(Boolean)
  if (parts[0] !== 'node') fail(`${script} is not a node script: ${command || '(missing)'}`)
  const files = parts.filter((part) => /\.mjs$/.test(part))
  // TWO FILES MEANS TWO GATES IN ONE COMMAND, and picking the first would run
  // half of it while `assertGateInventory` read only that half's source. Refuse.
  if (files.length !== 1) fail(`${script} names ${files.length} .mjs files; this bench runs exactly one: ${command}`)
  // NOT POSITIONAL SLICING: `parts.slice(2)` assumes the script path is
  // argv[1]; a command that puts a node flag before it would drop that flag and
  // inject the script path as a stray positional argument. Take everything
  // AFTER the path, wherever the path turned out to be.
  const file = gateSourceFiles().get(script)
  if (!file) fail(`${script} names no .mjs file under scripts/: ${command}`)
  return [file, ...parts.slice(parts.indexOf(files[0]) + 1)]
}

/**
 * Two claims this file makes about the gates, both re-derived on every run.
 *
 * 1. EVERY `verify:sync-*` GATE HAS A LEG. A new gate added to
 *    `server/package.json` would otherwise silently never run. `verify:sync-fence`
 *    is exempt and named: it is `vitest run`, has no compose stack, and already
 *    runs under the server suite.
 * 2. NO GATE CONTACTS THE BROWSER TIER, which is the ground on which
 *    `classifyServices` excludes it. If one ever does, this goes red here
 *    instead of surfacing twenty minutes later as a connection timeout.
 */
const GATES_WITHOUT_A_STACK = new Set(['verify:sync-fence'])

function assertGateInventory() {
  const files = gateSourceFiles()
  const legScripts = new Set(Object.values(LEGS).map((leg) => leg.script))
  const declared = Object.keys(serverScripts).filter((name) => name.startsWith('verify:sync-'))
  if (declared.length < 5) {
    fail(`only ${declared.length} verify:sync-* scripts found in server/package.json — the scan stopped matching`)
  }
  const unlegged = declared.filter((name) => !legScripts.has(name) && !GATES_WITHOUT_A_STACK.has(name))
  if (unlegged.length > 0) {
    fail(
      `these verify:sync-* gates have no leg here, so no workflow can run them: ${unlegged.join(', ')}\n`
      + 'Give each one a leg, or add it to GATES_WITHOUT_A_STACK with the reason it needs no compose stack.',
    )
  }
  const offenders = []
  for (const script of legScripts) {
    const file = files.get(script)
    if (!file) fail(`${script} names no .mjs file in server/package.json — the bench cannot check what it reads`)
    // A typo in `server/package.json` is a REFUSAL, not a raw ENOENT stack out
    // of `readFileSync` two lines later.
    if (!existsSync(file)) fail(`${script} names ${file}, which does not exist`)
    // Both spellings a gate would plausibly use to reach that tier: the port
    // variable the bench hands it, and the compose service name it would pass to
    // `compose(...)`. A bare literal port would still slip through, which is why
    // the docblock on `classifyServices` says so rather than implying coverage.
    if (/SYNC_FAILOVER_FRONTEND_PORT|['"]frontend['"]/.test(readFileSync(file, 'utf8'))) offenders.push(script)
  }
  if (offenders.length > 0) {
    fail(
      `these gates now read the browser tier's port: ${offenders.join(', ')}\n`
      + 'The bench excludes that service on the ground that no gate contacts it. One does now, so the exclusion is wrong.',
    )
  }
}

/**
 * That the topology the workflow ASKED for is the topology the daemon will run.
 *
 * `SYNC_FAILOVER_PARTITION_COUNT` defaults to `1` in the compose file. A leg
 * that needs two partitions and whose variable failed to reach the daemon would
 * start a perfectly healthy one-partition stack, and `verify:sync-active-active`
 * would then fail on a topology assertion — reporting the product broken when
 * the harness was misconfigured. Read from the RESOLVED config, so this compares
 * what will run, not what was typed.
 */
function assertTopologyResolves(config, leg) {
  for (const name of ['sync-cell-a', 'sync-cell-b', 'sync-ws-router']) {
    const declared = config.services?.[name]?.environment?.SYNC_CELL_PARTITION_COUNT
    if (String(declared) !== String(leg.partitionCount)) {
      fail(`${name} resolves SYNC_CELL_PARTITION_COUNT=${declared}, but this leg needs ${leg.partitionCount}`)
    }
  }
}

/**
 * That the stack is SERVING, which is not what `up --wait` proves.
 *
 * WHAT `up --wait` DOES NOT ESTABLISH. Of the services a leg starts, only
 * `sync-cell-a` and `sync-ws-router` declare a compose-level healthcheck;
 * `sync-cell-b` and `sync-cell-c` declare none, so `--wait` returns for them as
 * soon as they are RUNNING. A cell that boots the wrong entrypoint and never
 * calls `app.listen` satisfies that — e.g. with `target:` missing from a build
 * block, BuildKit builds the Dockerfile's last stage (the backup drill).
 *
 * That exact case is also caught statically by
 * `scripts/maplespire-compose.test.mjs` ("every cell service builds the SERVER
 * stage, not whatever is last"). This check catches the same SHAPE arriving
 * through a service with no healthcheck, and turns "the gate timed out sixty
 * seconds later on something unrelated" into a named refusal.
 *
 * The public entry point is probed too: `verify:sync-failover` and
 * `verify:sync-load-soak` both open `ws://127.0.0.1:<router port>/automerge`, so
 * a section headed "the stack is SERVING" that skipped it would leave those two
 * gates to report the product broken when the harness was.
 */
async function assertCellsAreServing(env, leg) {
  const ports = {
    'sync-cell-a': env.SYNC_FAILOVER_CELL_A_PORT,
    'sync-cell-b': env.SYNC_FAILOVER_CELL_B_PORT,
    'sync-cell-c': env.SYNC_FAILOVER_CELL_C_PORT,
    // The public entry point every WebSocket assertion goes through.
    'router': env.SYNC_FAILOVER_ROUTER_PORT,
  }
  const deadline = Date.now() + 90_000
  const pending = leg.services.filter((name) => ports[name])
  const serving = []
  while (pending.length > 0 && Date.now() < deadline) {
    for (const name of [...pending]) {
      try {
        const response = await fetch(`http://${env.SYNC_FAILOVER_HOST || '127.0.0.1'}:${ports[name]}/api/ready`, { signal: AbortSignal.timeout(2_000) })
        if (response.ok) {
          response.body?.cancel().catch(() => undefined)
          serving.push(name)
          pending.splice(pending.indexOf(name), 1)
        } else {
          response.body?.cancel().catch(() => undefined)
        }
      } catch { /* not up yet */ }
    }
    if (pending.length > 0) await new Promise((r) => setTimeout(r, 500))
  }
  if (pending.length > 0) {
    fail(
      `these services never served /api/ready on their published port: ${pending.join(', ')}\n`
      + 'A container that is up and does not listen is what a wrong build stage looks like (task B0a-0),\n'
      + 'and two of the cells declare no healthcheck, so `up --wait` returns for them regardless.',
    )
  }
  return serving
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const legName = argv.find((arg) => arg.startsWith('--leg='))?.slice(6)
  if (!legName || !LEGS[legName]) fail(`${usage()}\n\nunknown --leg: ${legName ?? '(missing)'}`)
  const leg = LEGS[legName]
  const keep = argv.includes('--keep')
  const build = !argv.includes('--no-build')
  const overrides = legName === 'load-soak' ? loadSoakOverrides(argv) : { args: null, env: {} }
  const posture = postureChoice(argv)
  if (posture && legName !== 'load-soak') fail('--posture currently qualifies the load-soak leg only')
  if (posture && !build) fail('--posture requires a build from the current tree; omit --no-build')
  const shipped = posture ? resolveShippedPosture() : null
  const env = { ...environmentFor(legName, leg),
    SYNC_FAILOVER_HOST: '127.0.0.1', SYNC_FAILOVER_BIND: '127.0.0.1',
    ...benchHostOverride(argv), ...overrides.env,
    ...(posture === 'shipped' ? shippedOverrides(shipped) : posture === 'bench' ? benchDefaultOverrides() : {}),
    // The CLI owns this label. An inherited value must not qualify an
    // ordinary bench as shipped without resolving and inspecting its posture.
    SYNC_BENCH_POSTURE: posture ?? '',
  }
  const legArgs = overrides.args ?? leg.args
  const dedicatedCalibration = Boolean(posture && legName === 'load-soak' && legArgs.includes('--mode=soak'))

  assertGateInventory()
  const config = resolvedConfig(env)
  const postureConfig = posture ? resolvedBenchPosture(config, posture === 'shipped' ? shipped : null) : null
  const excluded = classifyServices(config, leg)
  assertTopologyResolves(config, leg)

  const startedAt = Date.now()
  let gateExitCode = null
  let serving = []
  let runningPosture = null
  const router = routerSummaryForRun()
  const host = env.SYNC_FAILOVER_HOST || '127.0.0.1'
  const bind = env.SYNC_FAILOVER_BIND || '127.0.0.1'
  // The git half needs no docker and matters most on the run that fails to
  // come up; the image half waits for the stack. Printed once, after the cells
  // serve or in `finally` — whichever comes first — so no run ends without it.
  const identity = { image: null, commit: gitIdentity() }
  if (build) env.SYNC_FAILOVER_IMAGE_REVISION = identity.commit ?? 'unknown'
  let described = false
  const describe = () => {
    if (described) return
    described = true
    process.stderr.write(`${describeRun({ ...identity, router, host, bind })}\n`)
  }
  let teardownFailed = false
  let calibrationStage = null
  let mainStackAttempted = false
  try {
    // A stale project from an interrupted run keeps volumes, and the load gate
    // refuses to share a project with a concurrent run. Start from nothing.
    if (dedicatedCalibration) {
      const initial = calibrationProjectCensus(env.SYNC_FAILOVER_PROJECT, { ...process.env, ...env })
      if (Object.values(initial).some(rows => rows.length > 0)) fail('G4 requires an unused main project before calibration')
      compose(env, ['build', 'sync-cell-a'], { stdio: ['ignore', 'inherit', 'inherit'] })
      identity.image = imageIdentity(env)
      const image = identity.image?.match(/\bsha256:[a-f0-9]{64}\b/)?.[0]
      calibrationStage = await runIsolatedCalibrationStage({ env: { ...process.env, ...env }, image, posture,
        services: leg.services, compose,
        inspectPosture: (project, childEnv) => inspectRunningPosture(project, leg.services, postureConfig, childEnv),
      })
    } else {
      try { compose(env, TEARDOWN) } catch { /* nothing to remove */ }
    }
    mainStackAttempted = true
    compose(env, ['up', '-d', '--wait', ...(dedicatedCalibration ? ['--no-build'] : build ? ['--build'] : []), ...leg.services], { stdio: ['ignore', 'inherit', 'inherit'] })
    serving = await assertCellsAreServing(env, leg)
    const broughtUpAt = Date.now()
    identity.image = imageIdentity(env)
    if (posture) {
      runningPosture = inspectRunningPosture(env.SYNC_FAILOVER_PROJECT, leg.services, postureConfig, { ...process.env, ...env })
      const builtImageId = identity.image?.match(/\bsha256:[a-f0-9]{64}\b/)?.[0]
      if (!builtImageId || runningPosture.some(cell => cell.image !== builtImageId)) {
        fail('running posture does not use the image built by this qualification')
      }
      if (calibrationStage) {
        assertCalibrationReceipt(calibrationStage.record, { nonce: calibrationStage.binding.nonce,
          project: env.SYNC_FAILOVER_PROJECT, image: builtImageId, posture, runningPosture })
      }
      process.stderr.write(`${JSON.stringify({ event: 'bench.posture', posture, project: env.SYNC_FAILOVER_PROJECT,
        scope: 'ownership/Redis comparison on transport harness', config: postureConfig,
        shippedSource: shipped, runningCells: runningPosture,
        retainedDifferences: 'server/scripts/sync-bench-posture.json',
      })}\n`)
    }
    describe()

    // THE GATE IS RUN AS NODE, NOT THROUGH npm: recent Node refuses to spawn a
    // `.cmd` without a shell, so `spawnSync('npm.cmd', …)` returns
    // `status: null` with the error in a field nothing reads — a failure that
    // gets blamed on the product.
    //
    // Both the file and its own flags come from `package.json`, so
    // `verify:sync-redis-failover`'s `--redis-outage` is carried without this
    // file knowing it exists.
    const [gateFile, ...gateArgs] = gateCommand(leg.script)
    const gate = spawnSync(
      process.execPath,
      [gateFile, ...gateArgs, ...legArgs],
      { cwd: serverDir, env: { ...process.env, ...env,
        // Always override inherited receipts, including on the other legs.
        SYNC_G47_CALIBRATION_PATH: calibrationStage?.binding.path ?? '',
        SYNC_G47_CALIBRATION_SHA256: calibrationStage?.binding.sha256 ?? '',
        SYNC_G47_CALIBRATION_NONCE: calibrationStage?.binding.nonce ?? '',
      }, stdio: ['ignore', 'inherit', 'inherit'] },
    )
    if (gate.error) fail(`could not start ${leg.script}: ${gate.error.message}`)
    if (gate.status === null) fail(`${leg.script} was terminated by signal ${gate.signal ?? '(unknown)'} and produced no verdict`)
    gateExitCode = gate.status
    process.stderr.write(`${JSON.stringify({
      bench: 'sync-cell',
      leg: legName,
      summary: leg.summary,
      partitionCount: leg.partitionCount,
      project: env.SYNC_FAILOVER_PROJECT,
      host,
      bind,
      image: identity.image,
      commit: identity.commit,
      router,
      ...(posture ? { posture, postureConfig, runningPosture } : {}),
      services: leg.services,
      excluded,
      cellsServing: serving,
      bringUpMs: broughtUpAt - startedAt,
      gateMs: Date.now() - broughtUpAt,
      gate: leg.script,
      gateExitCode,
      outcome: gateExitCode === 0 ? 'passed' : 'failed',
    })}\n`)
  } finally {
    describe()
    // A red run on a CI runner leaves nothing to inspect once the stack is
    // gone, so the cells' own account of it is printed before the teardown.
    if (mainStackAttempted && gateExitCode !== 0) {
      try {
        compose(env, ['logs', '--no-color', '--timestamps', '--tail=200', ...leg.services], { stdio: ['ignore', 'inherit', 'inherit'] })
      } catch (error) {
        process.stderr.write(`[bench] could not collect service logs: ${error.message}\n`)
      }
    }
    if (keep && mainStackAttempted) {
      process.stderr.write(`[bench] --keep: leaving ${env.SYNC_FAILOVER_PROJECT} up\n`)
    } else if (mainStackAttempted) {
      try {
        compose(env, TEARDOWN)
      } catch (error) {
        // `compose()` pipes stderr, so `error.message` is only "Command failed:
        // docker compose …" and the REASON is in `error.stderr`. A teardown
        // that leaves seven containers behind also
        // has to change the exit code: the next leg would otherwise collide with
        // them and report the product broken.
        teardownFailed = true
        process.stderr.write(`[bench] TEARDOWN FAILED — containers may be left behind: ${error.message}\n`)
        process.stderr.write(`${String(error.stderr || '').trim()}\n`)
      }
    }
    if (calibrationStage) {
      try { calibrationStage.dispose() } catch (error) {
        teardownFailed = true
        process.stderr.write(`[bench] calibration receipt cleanup failed: ${error.message}\n`)
      }
    }
  }
  // `process.exitCode` and a return, never `process.exit()`. The JSON verdict
  // above is the only machine-readable output this file produces and it goes to
  // stderr, which is asynchronous for a pipe on Windows — `process.exit()` does
  // not flush a pending async write, so the summary can be truncated there.
  process.exitCode = gateExitCode === 0 && !teardownFailed ? 0 : 1
}

main().catch((error) => {
  // A refusal prints its sentence; anything else prints its stack. A bench that
  // answers "unknown --leg" with a stack trace teaches people to skim it.
  const text = error instanceof BenchRefusal ? error.message : (error?.stack || String(error))
  // `error.stderr` carries what docker actually said; without it a bring-up
  // failure reads only as "Command failed: docker compose …".
  const detail = String(error?.stderr || '').trim()
  process.stderr.write(`${text}\n${detail ? `${detail}\n` : ''}`)
  process.exitCode = 1
})
