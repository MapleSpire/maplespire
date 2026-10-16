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
 * Run the CI test job locally on Docker Desktop.
 *
 * `.github/workflows/ci.yml` gets its Postgres and Redis from GitHub's service
 * containers, which is exactly what a laptop does not have. This runs the same
 * steps against the same images, so the workflow can be verified before a push.
 *
 * Two things it does deliberately:
 *
 *  - **Its own containers on their own ports** (5462 / 6389 by default, not 5432
 *    / 6379, and not any worktree's dev stack). Two worktrees sharing a
 *    Postgres data directory can crash-wedge each other.
 *  - **A freshly created database every run.** This is the property that matters,
 *    not merely "a database": a suite can grow a latent dependency on a
 *    database some server already booted against (`tag_redirects`, see
 *    `vitest.global-setup.ts`), which a reused container hides and an empty one
 *    catches.
 *
 *  - **One kept directory per run** (`reports/<run-id>/`), holding the console
 *    output of every step and the JSON + JUnit reports. This is not tidiness:
 *    a run that fails a FILE with zero failing tests — a `beforeAll`/`afterAll`
 *    that throws or times out, an unhandled rejection, a worker crash — names
 *    the file only in vitest's `Failed Suites` banner, i.e. only on stdout.
 *    Keeping the logs is what lets you find WHICH file. `reports/` is
 *    gitignored, so nothing kept here can reach `git status`.
 *
 * Usage:
 *   node scripts/ci-local.mjs              # services up, full test job, skip check
 *   node scripts/ci-local.mjs --static     # also lint/build (the other CI job)
 *   node scripts/ci-local.mjs --update-allowlist
 *   node scripts/ci-local.mjs --down       # remove the containers and exit
 *   node scripts/ci-local.mjs --help       # usage; starts nothing
 *
 * Any other argument is refused, and one run at a time holds the containers
 * (see `ci-local-guard.mjs` for the two runs this destroyed before).
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describeFailingFiles } from './failing-files.mjs'
import {
  DEFAULT_PG_PORT,
  DEFAULT_REDIS_PORT,
  USAGE,
  acquireCiLocalLocks,
  ciContainerNames,
  lockPath,
  parseCiLocalArgs,
} from './ci-local-guard.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const PG_PORT = process.env.CI_LOCAL_PG_PORT ?? DEFAULT_PG_PORT
const REDIS_PORT = process.env.CI_LOCAL_REDIS_PORT ?? DEFAULT_REDIS_PORT
// Named after their ports: another port is another container, never these.
const { postgres: PG_CONTAINER, redis: REDIS_CONTAINER } = ciContainerNames(PG_PORT, REDIS_PORT)

/** Children still running: a signal must stop them before giving the lock
 *  back, or the next run would drop the database under them. */
const liveChildren = new Set()
const DB_NAME = 'maplespire_ci'
const DATABASE_URL = `postgres://maplespire:maplespire@localhost:${PG_PORT}/${DB_NAME}`
const REDIS_URL = `redis://localhost:${REDIS_PORT}`

const args = parseCiLocalArgs(process.argv.slice(2))
if ('error' in args) {
  console.error(`${args.error}\n\n${USAGE}`)
  process.exit(2)
}
if (args.help) {
  console.log(USAGE)
  process.exit(0)
}

/** One directory per run, so a run can never destroy the evidence of the last one. */
const RUN_ID = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const RUN_DIR = path.join(ROOT, 'reports', RUN_ID)
const KEEP_RUNS = 10

// `npm`/`npx` on Windows are .cmd shims and need a shell; real executables must
// NOT get one, because Node joins argv into a command line without quoting and
// the shell then re-splits any argument containing a space (e.g.
// `psql -c "DROP DATABASE IF EXISTS …"` would arrive as six arguments).
const SHELL_COMMANDS = new Set(['npm', 'npx'])

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? ROOT,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32' && SHELL_COMMANDS.has(command),
    env: { ...process.env, ...options.env },
  })
  if (!options.allowFailure && result.status !== 0) {
    console.error(`\nFAILED: ${command} ${commandArgs.join(' ')}`)
    process.exit(result.status ?? 1)
  }
  return result
}

/**
 * Same as `run`, but the child's output goes to the terminal AND to a file.
 *
 * `spawnSync` cannot do this: with `stdio: 'inherit'` there is nothing to
 * capture, and with `'pipe'` the operator watches a blank terminal for three
 * minutes. So the long steps get the async spawn and a tee. The file is what
 * survives the run; the terminal is what the operator watches during it.
 */
function runStreamed(command, commandArgs, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? ROOT,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && SHELL_COMMANDS.has(command),
      env: { ...process.env, ...options.env },
    })
    liveChildren.add(child)
    const log = options.logFile ? createWriteStream(options.logFile) : null
    for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => {
        sink.write(chunk)
        log?.write(chunk)
      })
    }
    let status = null
    let done = false
    const finish = () => {
      if (status === null || done) return
      done = true
      if (!log) return resolve({ status })
      // Resolve only once the log is on disk: the summary reads it back.
      log.end(() => resolve({ status }))
    }
    child.on('error', (error) => {
      const text = `\nFAILED TO START: ${command} ${commandArgs.join(' ')}\n${error.message}\n`
      process.stderr.write(text)
      log?.write(text)
      status = status ?? 1
      finish()
    })
    child.on('close', (code) => {
      liveChildren.delete(child)
      status = code ?? 1
      finish()
    })
  })
}

function docker(commandArgs, options = {}) {
  return run('docker', commandArgs, { capture: true, allowFailure: true, ...options })
}

function containerRunning(name) {
  const result = docker(['inspect', '--format', '{{.State.Running}}', name])
  return result.status === 0 && result.stdout.trim() === 'true'
}

async function waitHealthy(name) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = docker(['inspect', '--format', '{{.State.Health.Status}}', name]).stdout?.trim()
    if (status === 'healthy') return
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  console.error(`${name} never became healthy — is Docker Desktop running?`)
  process.exit(1)
}

function startServices() {
  if (!containerRunning(PG_CONTAINER)) {
    docker(['rm', '-f', PG_CONTAINER])
    // Same image tags as ci.yml. A local run on a different major version would
    // be a different test.
    run('docker', [
      'run', '-d', '--name', PG_CONTAINER,
      '-e', 'POSTGRES_USER=maplespire',
      '-e', 'POSTGRES_PASSWORD=maplespire',
      '-e', `POSTGRES_DB=${DB_NAME}`,
      '-p', `${PG_PORT}:5432`,
      '--health-cmd', `pg_isready -U maplespire -d ${DB_NAME}`,
      '--health-interval', '3s', '--health-timeout', '5s', '--health-retries', '10',
      'postgres:16-alpine',
    ], { capture: true })
  }
  if (!containerRunning(REDIS_CONTAINER)) {
    docker(['rm', '-f', REDIS_CONTAINER])
    run('docker', [
      'run', '-d', '--name', REDIS_CONTAINER,
      '-p', `${REDIS_PORT}:6379`,
      '--health-cmd', 'redis-cli ping',
      '--health-interval', '3s', '--health-timeout', '3s', '--health-retries', '10',
      'redis:7.4-alpine',
    ], { capture: true })
  }
}

function freshDatabase() {
  // WITH (FORCE) so a leftover connection from an interrupted run cannot wedge
  // this; both statements run separately because DROP DATABASE refuses to run
  // inside the implicit transaction psql uses for a multi-statement -c.
  run('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'maplespire', '-d', 'postgres',
    '-c', `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`], { capture: true })
  run('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'maplespire', '-d', 'postgres',
    '-c', `CREATE DATABASE ${DB_NAME} OWNER maplespire`], { capture: true })
  run('docker', ['exec', REDIS_CONTAINER, 'redis-cli', 'FLUSHALL'], { capture: true })
}

/** Bounded history: enough to compare a red run with the green one before it. */
function pruneOldRuns() {
  const reports = path.join(ROOT, 'reports')
  const runs = readdirSync(reports, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}Z$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  for (const name of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS))) {
    rmSync(path.join(reports, name), { recursive: true, force: true })
  }
}

/**
 * Name the files, and say explicitly when no test failed inside them.
 *
 * The reading itself lives in scripts/failing-files.mjs, where a node --test
 * suite feeds it a real vitest report captured from a real hook timeout, so the
 * diagnosis is exercised even when no run fails that way.
 */
function reportFailingFiles(label, kind) {
  const jsonPath = path.join(RUN_DIR, `vitest-${kind}.json`)
  const junitPath = path.join(RUN_DIR, `vitest-${kind}.junit.xml`)
  const logName = `reports/${RUN_ID}/${kind}.log`
  const readOrNull = (file) => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }
  const raw = existsSync(jsonPath) ? readOrNull(jsonPath) : null
  let report = null
  let reportProblem
  if (raw === null) reportProblem = 'no JSON report was written — the step died before its reporter'
  else {
    try {
      report = JSON.parse(raw)
    } catch (error) {
      reportProblem = `${path.relative(ROOT, jsonPath)} is unreadable (${error.message})`
    }
  }
  const { lines } = describeFailingFiles({
    report,
    reportProblem,
    junitXml: readOrNull(junitPath) ?? '',
    toRelative: (absolute) => path.relative(ROOT, absolute).split(path.sep).join('/'),
    label,
    logPath: logName,
    junitPath: `reports/${RUN_ID}/vitest-${kind}.junit.xml`,
  })
  console.error('')
  for (const line of lines) console.error(line)
}

async function main() {
  // Before anything touches a container: --down removes them too.
  const lock = acquireCiLocalLocks([lockPath(PG_CONTAINER), lockPath(REDIS_CONTAINER)])
  if (!lock.ok) {
    const { pid, cwd, startedAt } = lock.holder
    console.error(`Another ci-local run holds ${PG_CONTAINER} / ${REDIS_CONTAINER} (pid ${pid ?? '?'}, ${cwd ?? '?'}, since ${startedAt ?? '?'}).`)
    console.error('Starting would drop its database mid-suite. Wait for it, or set BOTH CI_LOCAL_PG_PORT and CI_LOCAL_REDIS_PORT for a pair of your own.')
    console.error(`If no such run exists (a reused pid), delete ${lock.file}.`)
    process.exit(3)
  }
  process.on('exit', lock.release)
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => {
      for (const child of liveChildren) child.kill(signal)
      lock.release()
      process.exit(code)
    })
  }

  if (args.down) {
    docker(['rm', '-f', PG_CONTAINER])
    docker(['rm', '-f', REDIS_CONTAINER])
    console.log('CI service containers removed.')
    return
  }

  if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) {
    console.error('Docker is not reachable. Start Docker Desktop and retry.')
    process.exit(1)
  }

  console.log(`Postgres :${PG_PORT}  Redis :${REDIS_PORT}  (isolated from every dev stack)`)
  startServices()
  await waitHealthy(PG_CONTAINER)
  await waitHealthy(REDIS_CONTAINER)
  freshDatabase()

  if (args.static) {
    console.log('\n=== Lint, build, typecheck ===')
    run('npm', ['run', 'lint'])
    // CI builds with `VITE_SYNC_API_URL` UNSET on purpose, so that
    // `verify:same-origin-dist` below has something it can actually catch. A
    // developer machine does not: Vite loads the worktree-local `.env.local`,
    // which every isolated stack sets, so the forbidden literal never reaches
    // the bundle and the gate would pass without ever looking at the code
    // under test.
    //
    // An inline env var wins over `.env.local` (measured with a sentinel value
    // reaching `dist/`). Empty is the CI-equivalent, because an unset variable
    // and an empty one now resolve identically (`lib/api/base.ts`), and
    // `base.test.ts` pins that they always will.
    run('npm', ['run', 'build'], { env: { VITE_SYNC_API_URL: '', VITE_AUTOMERGE_URL: '' } })
    run('npm', ['run', 'verify:same-origin-dist'])
    run('npm', ['--prefix', 'server', 'run', 'build'])
    // `build` sees `src/**` only (`server/tsconfig.json` sets `rootDir: ./src`).
    // `typecheck:all` is the one that covers `scripts/**` and `qa/**`, AND it is
    // the sole gate that fails when a `@ts-expect-error` in the seam test stops
    // being necessary (e.g. if `Readonly` is dropped from `cachedHandles`).
    run('npm', ['--prefix', 'server', 'run', 'typecheck:all'])
    // The same idea, one package over: `tsc -b` above covers `src/**` and
    // `vite.config.ts` and NOTHING else, so `e2e/**`, the
    // `playwright*.config.ts` files and `vitest.config.ts` need this program —
    // Playwright transpiles without typechecking, exactly as vitest does.
    run('npm', ['run', 'typecheck:e2e'])
  }

  mkdirSync(RUN_DIR, { recursive: true })
  pruneOldRuns()
  console.log(`Kept for this run: reports/${RUN_ID}/`)
  const env = {
    DATABASE_URL,
    TEST_DATABASE_URL: DATABASE_URL,
    TEST_REDIS_URL: REDIS_URL,
    REQUIRE_DB_TESTS: '1',
    REQUIRE_REDIS_TESTS: '1',
    // The backup/restore drill shells out to pg_dump/pg_restore. Windows has
    // neither — the embedded-postgres package ships initdb/pg_ctl/postgres and
    // nothing else — so it borrows the client binaries from the Postgres
    // container it is already talking to, via DockerPgTools (docker exec +
    // docker cp). Same code path CI uses.
    BACKUP_RESTORE_TEST_DATABASE_URL: DATABASE_URL,
    BACKUP_RESTORE_TEST_PG_CONTAINER: PG_CONTAINER,
    // vitest loads `.env.local` too, so without this the frontend suite would
    // run against this worktree's `VITE_SYNC_API_URL` while CI runs against
    // nothing: with the API base defaulting to same-origin, tests whose
    // `apiFetch` mocks call `new URL(url)` pass locally and fail on CI.
    //
    // The BUILD step forces the same thing (see `--static` above). Unset and
    // empty resolve identically (`src/lib/api/base.ts`), so this is
    // CI-equivalent.
    VITE_SYNC_API_URL: '',
  }

  // The `node --test` suites, from the same list `ci.yml` uses (vitest does
  // not collect `.test.mjs` under `server/qa` or `server/scripts`). Their
  // position before the database suites is about COST, not dependency: they
  // fail in seconds rather than after twenty minutes.
  //
  // `env` AND `--with-database` are both passed: some checks (e.g.
  // `qa:promotion-door-check`, which promotes a real workspace in an isolated
  // schema) need the database. Both are safe here
  // because `waitHealthy(PG_CONTAINER)` has already returned — the container is
  // proved healthy well above this line, not merely started. `ci.yml` splits
  // the same list the other way: its `static` job runs this WITHOUT the flag
  // and its `test` job runs the database half.
  console.log('\n=== Harness self-tests (node --test) ===')
  const harness = await runStreamed('npm', ['run', '--silent', 'test:harness-suites', '--', '--with-database'],
    { logFile: path.join(RUN_DIR, 'harness.log'), env })

  // `--reporter=junit` is not decoration either: the JSON reporter records a
  // file-level failure as `status: "failed"` but its `message` is `""` whenever
  // the throwing hook lives in a nested `describe` (the error is attached to the
  // inner suite; only the STATE propagates to the file). The JUnit reporter says
  // in its own source that it injects failed suites "to surface errors during
  // beforeAll/afterAll", and carries the message and the line number.
  console.log('\n=== Frontend tests ===')
  const frontend = await runStreamed('npx', ['vitest', 'run', '--reporter=default',
    '--reporter=json', `--outputFile.json=reports/${RUN_ID}/vitest-frontend.json`,
    '--reporter=junit', `--outputFile.junit=reports/${RUN_ID}/vitest-frontend.junit.xml`],
    { env, logFile: path.join(RUN_DIR, 'frontend.log') })

  console.log('\n=== Server tests (Postgres + Redis) ===')
  // Relative output path on purpose: this repo lives under a path with a space in
  // it ("My projects"), and `shell: true` on Windows re-splits an unquoted
  // argument on spaces, so an absolute --outputFile silently writes somewhere else.
  const server = await runStreamed('npx', ['vitest', 'run', '--reporter=default',
    '--reporter=json', `--outputFile.json=../reports/${RUN_ID}/vitest-server.json`,
    '--reporter=junit', `--outputFile.junit=../reports/${RUN_ID}/vitest-server.junit.xml`],
    { cwd: path.join(ROOT, 'server'), env, logFile: path.join(RUN_DIR, 'server.log') })

  // The stable paths stay, for anything that still expects them — but they are
  // now COPIES of a report that also lives, untouched, in this run's directory.
  for (const name of ['vitest-frontend.json', 'vitest-server.json']) {
    const kept = path.join(RUN_DIR, name)
    if (existsSync(kept)) copyFileSync(kept, path.join(ROOT, 'reports', name))
  }

  console.log('\n=== Every skip is declared ===')
  const checkArgs = ['scripts/check-test-skips.mjs',
    '--report', `reports/${RUN_ID}/vitest-frontend.json`,
    '--report', `reports/${RUN_ID}/vitest-server.json`]
  if (args.updateAllowlist) checkArgs.push('--update')
  // Same `env`, deliberately: an allowlist entry with `requiresEnv` is a claim
  // about the environment the SUITES ran in, so a checker that cannot see that
  // environment is judging a different run (it would report the backup drill
  // as a stale exemption on the very run that executed it). CI gets this for
  // free — its variables go through $GITHUB_ENV and every later step inherits
  // them.
  const check = await runStreamed('node', checkArgs, { env, logFile: path.join(RUN_DIR, 'skip-check.log') })

  // The one step that runs a `qa/` GATE rather than a gate's oracle.
  //
  // `qa/eviction-peeraware.mjs` needs a server, a database and compressed
  // eviction timers, so unit tests over hand-made fixtures can only check its
  // verdict logic. This runner already has the database. The drill boots
  // its own servers on 3041/3042 — never a dev stack, never this runner's own
  // ports — and asserts the gate reports `failed` against a server whose sweep
  // peer check is disabled and `passed` against one that is untouched.
  //
  // It runs LAST of the database steps on purpose: it writes Automerge
  // documents into `maplespire_ci`, and every suite above should see the
  // database `freshDatabase()` made, not the one this drill left behind.
  //
  // Its status is in `failed` below rather than merely logged, so it can turn
  // the build red.
  console.log('\n=== Eviction gate fire drill (two arms, real servers) ===')
  const fireDrill = await runStreamed('npm', ['run', '--silent', 'qa:eviction-fire-drill'],
    { cwd: path.join(ROOT, 'server'), env, logFile: path.join(RUN_DIR, 'eviction-fire-drill.log') })

  const failed = [
    harness.status !== 0 && 'harness self-tests',
    frontend.status !== 0 && 'frontend tests',
    server.status !== 0 && 'server tests',
    check.status !== 0 && 'skip check',
    // VOID and FAILED kept apart, because `exitCodeForOutcome` maps them to 2
    // and 1 precisely so an instrument outage is never quoted as a measurement
    // of the system. Collapsing them to one string tells an operator the same
    // thing about "the gate is blind to a wrongly-evicted document" and "port
    // 3041 was busy".
    fireDrill.status === 2 && 'eviction gate fire drill (VOID — the drill did not run)',
    fireDrill.status !== 0 && fireDrill.status !== 2 && 'eviction gate fire drill (the gate cannot discriminate)',
  ].filter(Boolean)
  if (failed.length > 0) {
    console.error(`\nCI would be RED: ${failed.join(', ')}`)
    // "server tests" is a step, not a diagnosis. Name the files, and when a file
    // failed without a single failing test, say so — that is a hook, an
    // unhandled rejection or a worker crash, and the operator needs to open the
    // log, not scroll it.
    if (frontend.status !== 0) reportFailingFiles('frontend tests', 'frontend')
    if (server.status !== 0) reportFailingFiles('server tests', 'server')
    console.error(`\nEverything above is kept in reports/${RUN_ID}/ ` +
      '(console output, JSON and JUnit reports). The next run writes its own directory.')
    process.exit(1)
  }
  console.log('\nCI would be GREEN.')
}

await main()
