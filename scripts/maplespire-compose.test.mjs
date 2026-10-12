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

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import { registerDeploymentPlacementTests } from './deployment-placement.test-support.mjs'

registerDeploymentPlacementTests(test)

const composeSource = await readFile(
  new URL('../compose.maplespire.yml', import.meta.url),
  'utf8',
)
const composeLines = composeSource.split(/\r?\n/)

// Grafana is configured across four files that must agree with each other, and
// every disagreement between them fails the same silent way: a dashboard with
// no data, or no dashboard at all, and nothing in any log.
const providerSource = await readFile(
  new URL('../infra/monitoring/grafana/provisioning/dashboards/maplespire.yml', import.meta.url),
  'utf8',
)
const datasourceSource = await readFile(
  new URL('../infra/monitoring/grafana/provisioning/datasources/prometheus.yml', import.meta.url),
  'utf8',
)
const dashboardFiles = await readdir(
  new URL('../infra/monitoring/grafana/dashboards/', import.meta.url),
)
const initEnv = await import('./init-env.mjs')
/** For the assertions here that relate a compose value to an alert threshold. */
const alertsSource = await readFile(
  new URL('../infra/monitoring/alerts.yml', import.meta.url),
  'utf8',
)
/** The scrape config, for the drill's metrics port — declared in a third file. */
const prometheusSource = await readFile(
  new URL('../infra/monitoring/prometheus.yml', import.meta.url),
  'utf8',
)
const schedulerSource = await readFile(
  new URL('../server/src/backup/schedulerHeartbeat.ts', import.meta.url),
  'utf8',
)
/** For the teardown arithmetic, whose three ceilings live in three files. */
const listenerSource = await readFile(
  new URL('../server/src/runtime/metricsListener.ts', import.meta.url),
  'utf8',
)
const lockPoolTeardownSource = await readFile(
  new URL('../server/src/backup/lockPoolTeardown.ts', import.meta.url),
  'utf8',
)
/**
 * Every top-level key under `services:`, in file order.
 *
 * Deliberately a line scan and not a YAML parse: this file already reads seven
 * sources as text, the assertions below are about the TEXT an operator edits
 * (anchors, `${VAR:?}` forms, exact indentation), and a parser would resolve the
 * `<<:` merges that some of those assertions exist to see.
 */
function serviceNames(source) {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => /^services:\s*$/.test(line))
  assert.notEqual(start, -1, 'no top-level `services:` key')
  const names = []
  for (let index = start + 1; index < lines.length; index += 1) {
    // A column-0 key ends the block; anything deeper than two spaces is inside
    // a service, not a new one.
    if (/^[a-zA-Z]/.test(lines[index])) break
    const match = /^ {2}([a-zA-Z0-9][a-zA-Z0-9_-]*):\s*$/.exec(lines[index])
    if (match) names.push(match[1])
  }
  return names
}

/**
 * Services the per-service assertions below deliberately do NOT cover, each with
 * the reason. Empty today, and that is the point of it existing: adding a
 * service to `compose.maplespire.yml` now either satisfies the assertions or
 * requires writing down why it does not.
 */
const productionServiceExemptions = new Map([])

/**
 * DERIVED from the manifest, not transcribed from it. With a hand-written list,
 * a service added to the manifest but not to the list would be silently exempt
 * from `restart: always`, from the logging rule, from everything below.
 * Covered by default, exempt only in writing.
 */
const productionServices = serviceNames(composeSource)
  .filter((name) => !productionServiceExemptions.has(name))

test('the production service list is derived from the manifest, not from memory', () => {
  // The derivation itself needs a witness: a `serviceNames` that returned []
  // would make every per-service loop below vacuous and green.
  assert.ok(
    productionServices.length >= 9,
    `derived only ${productionServices.length} services from compose.maplespire.yml`,
  )
  // The spot-check includes HYPHENATED names — the shape the `serviceNames`
  // regex could get wrong — since losing them could still clear the `>= 9`
  // floor.
  for (const name of [
    'postgres', 'redis', 'api', 'web', 'backup-drill', 'prometheus', 'grafana',
    'redis-exporter', 'render-cache', 'api-b', 'sync-ws-router',
  ]) {
    assert.ok(productionServices.includes(name), `derived list is missing ${name}`)
  }
  for (const [name] of productionServiceExemptions) {
    assert.ok(
      serviceNames(composeSource).includes(name),
      `${name} is exempted but no longer exists in the manifest — delete the exemption`,
    )
  }
})

/** The text of a top-level `x-...: &anchor` block, without its header line. */
function anchorBody(anchorName) {
  const start = composeLines.findIndex((line) => new RegExp(`^x-[a-zA-Z0-9-]+:\\s*&${anchorName}\\s*$`).test(line))
  assert.notEqual(start, -1, `no top-level anchor &${anchorName} in compose.maplespire.yml`)
  const next = composeLines.findIndex(
    (line, index) => index > start && /^[a-zA-Z0-9]/.test(line),
  )
  return composeLines.slice(start + 1, next === -1 ? undefined : next).join('\n')
}

/**
 * A service's block, WITH the bodies of every anchor it merges.
 *
 * The api's shared environment lives in the `x-api-environment` anchor so the
 * two cells cannot drift. Every assertion here reads a service block as TEXT,
 * so without following `<<:` merges, `METRICS_TOKEN`, `DATABASE_URL` and the
 * rest would vanish from `api`'s block, and any check on a value moved into an
 * anchor would silently stop firing.
 *
 * Text and not a parsed document, for the same reason as everything else in this
 * file: the values under test are compose interpolations (`${VAR:?msg}`) that
 * only resolve when `docker compose` runs, and no YAML parser is a dependency
 * here.
 */
function serviceBlock(name) {
  const start = composeLines.indexOf(`  ${name}:`)
  assert.notEqual(start, -1, `missing ${name} service`)

  const nextService = composeLines.findIndex(
    (line, index) => index > start && /^  [a-zA-Z0-9-]+:\s*$/.test(line),
  )
  const own = composeLines.slice(start, nextService === -1 ? undefined : nextService).join('\n')
  const merged = [...own.matchAll(/^\s+<<:\s*\*([a-zA-Z0-9_-]+)\s*$/gm)].map((m) => m[1])
  return [own, ...merged.map(anchorBody)].join('\n')
}

test('serviceBlock follows the merge keys — a value in an anchor is still the service\'s', () => {
  // THE CONTROL FOR THE HELPER ABOVE. If the merge-following broke, every env
  // assertion in this file would go quietly vacuous rather than red.
  const api = serviceBlock('api')
  // Declared directly on the service.
  assert.match(api, /SYNC_CELL_ID:\s*maplespire-home\s*$/m, 'the service\'s own keys are missing')
  // Reached only through `<<: *api-environment`.
  assert.match(api, /METRICS_TOKEN:/, 'the merged anchor body is missing — every env assertion here is vacuous')
  assert.match(api, /DATABASE_URL:/, 'the merged anchor body is missing')
  // And the merge is not indiscriminate: a service that merges nothing gains
  // nothing, or `serviceBlock` would be concatenating the whole file.
  assert.doesNotMatch(serviceBlock('postgres'), /METRICS_TOKEN:/, 'serviceBlock leaked another block\'s keys')
})

test('all app.maplespire.ca containers restart after Docker Desktop relaunches', () => {
  for (const service of productionServices) {
    assert.match(
      serviceBlock(service),
      /^    restart: always$/m,
      `${service} must use restart: always`,
    )
  }
  assert.doesNotMatch(composeSource, /^\s+restart: unless-stopped$/m)
})

test('metrics retention is budgeted in bytes, and its volume is declared', () => {
  // Days are not a disk budget: the series count grows with the number of
  // workspaces, so a time-based retention silently grows the volume until it
  // fills. Prometheus drops the oldest blocks itself once a size budget is set.
  assert.match(
    serviceBlock('prometheus'),
    /--storage\.tsdb\.retention\.size=/,
    'prometheus must cap its TSDB by size',
  )
  for (const volume of ['prometheus_data:', 'backups:']) {
    assert.ok(composeSource.includes(`
  ${volume}`), `missing ${volume} volume declaration`)
  }
})

test('the drill container gets a byte budget for both the history and the bundles', () => {
  // Bundles are the big consumer — a full dump every run. Without a ceiling the
  // backups fill the volume and the next backup fails BECAUSE of the backups.
  const drill = serviceBlock('backup-drill')
  assert.match(drill, /BACKUP_DRILL_HISTORY_MAX_BYTES:/)
  assert.match(drill, /BACKUP_BUNDLE_MAX_BYTES:/)
  // Read-only: a backup reads the icon volume and must never be able to alter it.
  assert.match(drill, /technology_assets:\/var\/lib\/maplespire\/assets\/technologies:ro/)

  // drillSchedule.ts THROWS on BACKUP_DIRECTORY without BACKUP_BUNDLE_ROOT —
  // the scheduler's root is the one a retention sweep deletes from. The drill
  // IMAGE sets BACKUP_DIRECTORY in its own ENV, so the guard fires on a compose
  // file that names neither: the container crash-loops on every start,
  // `restart: always` hides it as "Restarting", and the drill never runs.
  assert.match(
    drill,
    /BACKUP_BUNDLE_ROOT:/,
    'backup-drill must set BACKUP_BUNDLE_ROOT; the scheduler refuses to start without it',
  )
})

test('every service building a multi-stage Dockerfile names the stage it wants', async () => {
  // With no `target`, BuildKit builds the LAST stage in the file — a silent
  // dependency on stage ORDER. server/Dockerfile ends with `drill`, so an
  // untargeted `api` would run `drillScheduler.js` and never bind :3001.
  //
  // The rule is deliberately general: whenever a
  // Dockerfile offers a choice of stages, the service has to state its choice.
  // A Dockerfile with a single named stage offers no choice and is exempt.
  for (const service of productionServices) {
    const block = serviceBlock(service)
    const build = /\n\s+build:\n([\s\S]*?)(?=\n\s{4}\w|\n\s{2}\w|$)/.exec(block)
    if (!build) continue

    // Anchored per line, not on a leading \n: the captured block starts AT its
    // first key, so a \n-prefixed pattern silently misses `context:` and every
    // lookup below reads undefined.
    const context = /^\s*context:\s*(\S+)/m.exec(build[1])?.[1]
    assert.ok(context, `${service} declares a build without a context`)
    const dockerfile = /^\s*dockerfile:\s*(\S+)/m.exec(build[1])?.[1] ?? 'Dockerfile'
    const source = await readFile(
      new URL(`../${context === '.' ? '' : `${context.replace(/^\.\//, '')}/`}${dockerfile}`, import.meta.url),
      'utf8',
    )
    const namedStages = [...source.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1])
    if (namedStages.length < 2) continue

    const target = /^\s*target:\s*(\S+)/m.exec(build[1])?.[1]
    assert.ok(
      target,
      `${service} builds ${dockerfile}, which offers stages [${namedStages.join(', ')}] — it must name a target instead of inheriting whichever stage happens to be last`,
    )
    assert.ok(
      namedStages.includes(target),
      `${service} targets "${target}", which ${dockerfile} does not define`,
    )
  }
})

test('every variable the compose file marks required is one the init script checks', () => {
  // `${VAR:?message}` makes docker refuse to INTERPOLATE the file, so a
  // variable missing from the init script's checks turns into a failure docker
  // reports with a message the script can no longer keep true.
  const required = [...composeSource.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1])
  assert.ok(required.length > 0, 'expected the compose file to mark some variables required')

  const declared = new Set([...initEnv.REQUIRED, ...Object.values(initEnv.PROFILE_REQUIRED).flat()])
  for (const name of new Set(required)) {
    assert.ok(
      declared.has(name),
      'compose.maplespire.yml requires ' + name + ' but scripts/init-env.mjs does not check it',
    )
  }
  for (const name of Object.keys(initEnv.GENERATED)) {
    assert.ok(initEnv.REQUIRED.includes(name), name + ' is generated but not verified')
  }
})

test('container entrypoints are LF-only, so the kernel can read their shebang', async () => {
  // exec() reads `#!/bin/sh` literally. On a CRLF checkout the interpreter
  // becomes `/bin/sh\r`, which does not exist, and the container dies with
  // "no such file or directory" — a message naming neither the script nor the
  // cause. .gitattributes is what prevents it; this is what proves it held.
  for (const script of ['docker-entrypoint.sh', 'docker-entrypoint-drill.sh']) {
    const bytes = await readFile(new URL(`../server/${script}`, import.meta.url))
    assert.equal(
      bytes.indexOf(0x0d),
      -1,
      `server/${script} contains a CR byte; it must be checked out with LF endings`,
    )
  }
})

test('the drill container is given the bundle ROOT', () => {
  // drillSchedule.ts throws when BACKUP_DIRECTORY is set without
  // BACKUP_BUNDLE_ROOT, and server/Dockerfile sets BACKUP_DIRECTORY as an image
  // ENV -- so that guard fires whatever compose says, and BACKUP_BUNDLE_ROOT is
  // the one that has to be here. A guard that exists only at runtime is one
  // nobody meets until the deploy, and a crash-looping drill produces no backup
  // while looking like an ordinary restart loop.
  //
  // Assert the PRESENCE of the root, never the ABSENCE of BACKUP_DIRECTORY: the
  // entrypoint chowns with that variable, so requiring its absence would fail
  // the correct configuration.
  const drill = serviceBlock('backup-drill')
  assert.match(drill, /BACKUP_BUNDLE_ROOT:/)
})

test('the drill container is allowed to finish its abort grace before Docker kills it', () => {
  // The scheduler's SIGTERM handling aborts an in-flight drill and then waits
  // BACKUP_DRILL_ABORT_GRACE_SECONDS for it to unwind — a window in which
  // `runBackupDrill`'s teardown drops the isolated restore database it created,
  // work that still touches the cluster and that the advisory lock must still
  // cover. If Docker's stop_grace_period is SHORTER, SIGKILL lands first: the
  // graceful teardown cannot finish and the whole abandonment path is
  // unreachable on the caller-stop leg, which is every rolling deploy.
  //
  // Both numbers can be correct on their own while their relation is wrong —
  // the shape a static test catches and a runtime guard never does.
  const drill = serviceBlock('backup-drill')
  const grace = drill.match(/BACKUP_DRILL_ABORT_GRACE_SECONDS:\s*"?(\d+)"?/)
  const stop = drill.match(/stop_grace_period:\s*(\d+)s/)
  assert.ok(grace, 'backup-drill must set BACKUP_DRILL_ABORT_GRACE_SECONDS explicitly')
  assert.ok(stop, 'backup-drill must set stop_grace_period')
  assert.ok(
    Number(stop[1]) > Number(grace[1]),
    `stop_grace_period (${stop[1]}s) must exceed BACKUP_DRILL_ABORT_GRACE_SECONDS (${grace[1]}s), `
    + 'or Docker kills the drill before it can drop its isolated restore database',
  )
})

test('the drill container declares a deadline whose HOLD fits inside its cadence', () => {
  // The maximum time one drill can hold the advisory lock is DEADLINE plus
  // GRACE, not the deadline alone — `drillSchedule.ts` refuses the combination
  // at boot, and a boot refusal in this container is a crash loop that produces
  // no backups while looking like an ordinary restart. Catch it here, in a file
  // that runs without a database.
  const drill = serviceBlock('backup-drill')
  const deadlineHours = drill.match(/BACKUP_DRILL_DEADLINE_HOURS:\s*"?([\d.]+)"?/)
  const graceSeconds = drill.match(/BACKUP_DRILL_ABORT_GRACE_SECONDS:\s*"?(\d+)"?/)
  assert.ok(deadlineHours, 'backup-drill must set BACKUP_DRILL_DEADLINE_HOURS explicitly')
  assert.ok(graceSeconds)
  // The interval is left at its default of 24 h; assert against that rather
  // than against a value nobody wrote down.
  const intervalHours = drill.match(/BACKUP_DRILL_INTERVAL_HOURS:\s*"?([\d.]+)"?/)
  const cadence = intervalHours ? Number(intervalHours[1]) : 24
  const hold = Number(deadlineHours[1]) + Number(graceSeconds[1]) / 3600
  assert.ok(
    hold <= cadence,
    `deadline + grace (${hold}h) must not exceed the cadence (${cadence}h), or the scheduler `
    + 'refuses to boot',
  )
})

test('the unreclaimed-litter alert threshold is loose enough for the committed cadence', () => {
  // `BackupRestoreDatabasesNotReclaimed` fires when the oldest restore database
  // the sweep should have taken is older than seven days. That number is NOT
  // cadence-free: a leftover is minted by run N and reclaimed by run N+1, so on
  // a healthy deployment its age when the sweep meets it is one whole cadence.
  // Past a seven-day interval — and `intervalMs` accepts up to 720 h — the rule
  // fires on a deployment where nothing is wrong at all.
  //
  // The relation lives in two files that never reference each other; a comment
  // in alerts.yml cannot notice somebody raising MAPLESPIRE_DRILL_INTERVAL_HOURS
  // here.
  //
  // 2x rather than 1x: at exactly one cadence the healthy case sits ON the
  // threshold, and Prometheus's own guidance is to allow at least two full
  // runs. What this CANNOT see: the compose value is
  // `${MAPLESPIRE_DRILL_INTERVAL_HOURS:-24}`, so a deploy-time override is
  // outside any static check — the fallback is what is asserted.
  const drill = serviceBlock('backup-drill')
  const intervalHours = drill.match(/BACKUP_DRILL_INTERVAL_HOURS:.*?:-([\d.]+)\}/)
    ?? drill.match(/BACKUP_DRILL_INTERVAL_HOURS:\s*"?([\d.]+)"?/)
  assert.ok(intervalHours, 'backup-drill must declare BACKUP_DRILL_INTERVAL_HOURS')
  const threshold = alertsSource.match(
    /maplespire_backup_restore_oldest_reclaimable_age_seconds > (\d+)/,
  )
  assert.ok(threshold, 'BackupRestoreDatabasesNotReclaimed must compare against a literal')
  const cadenceSeconds = Number(intervalHours[1]) * 3600
  assert.ok(
    Number(threshold[1]) >= 2 * cadenceSeconds,
    `the alert threshold (${threshold[1]}s) must be at least twice the drill cadence `
    + `(${cadenceSeconds}s), or it fires on a healthy deployment`,
  )
})

test('the drill container is given the token its own scrape needs', () => {
  // Without it the scheduler's /metrics answers 404 exactly as the api's does,
  // Prometheus records a failed scrape, and `up{job="backup-drill"}` reads 0 —
  // the same reading as the dead container the whole signal exists to catch.
  const drill = serviceBlock('backup-drill')
  assert.match(
    drill,
    /METRICS_TOKEN:\s*\$\{MAPLESPIRE_METRICS_TOKEN/,
    'backup-drill must be given METRICS_TOKEN or its metrics endpoint 404s',
  )
  // The SAME token as the api's, because prometheus.yml points one
  // credentials_file at both jobs. Two tokens would fail closed on whichever
  // job did not match, and read as that container being down.
  const api = serviceBlock('api')
  const tokenOf = (block) => block.match(/METRICS_TOKEN:\s*(\$\{[^}]+\})/)?.[1]
  assert.ok(tokenOf(api), 'api must set METRICS_TOKEN')
  assert.equal(tokenOf(drill), tokenOf(api), 'both jobs are scraped with one credentials_file')
})

test('the router metrics port and bearer token agree with its internal scrape job', async () => {
  const router = serviceBlock('sync-ws-router')
  const main = await readFile(new URL('../server/src/syncCells/routerMain.ts', import.meta.url), 'utf8')
  const tokenOf = (block) => block.match(/METRICS_TOKEN:\s*(\$\{[^}]+\})/)?.[1]
  assert.ok(tokenOf(router), 'router must receive a metrics token')
  assert.equal(tokenOf(router), tokenOf(serviceBlock('api')))
  const target = prometheusSource.match(/targets:\s*\['sync-ws-router:(\d+)'\]/)?.[1]
  const port = router.match(/SYNC_ROUTER_METRICS_PORT:\s*"(\d+)"/)?.[1]
  assert.equal(port, '9464')
  assert.equal(target, port)
  assert.match(main, /envNumber\('SYNC_ROUTER_METRICS_PORT', \{ fallback: 9464,/)
  assert.match(router, /expose:\s*\n\s+- "9464"/)
  assert.doesNotMatch(router, /^\s+ports:/m, 'router metrics must not be published to the host')
  const job = prometheusSource.split('- job_name: sync-ws-router\n')[1]?.split('- job_name:')[0] ?? ''
  assert.match(job, /credentials_file: \/etc\/prometheus\/metrics-token/)
  assert.match(main, /token: process\.env\.METRICS_TOKEN/)
})

test('prometheus scrapes the drill on the port the scheduler binds', () => {
  // Three files, none of which cites another: the default lives in
  // `schedulerHeartbeat.ts`, the target in `prometheus.yml`, and any override
  // would be in the compose service. A mismatch is a permanently failed scrape
  // that reads as a dead container.
  const target = prometheusSource.match(/targets:\s*\['backup-drill:(\d+)'\]/)
  assert.ok(target, 'prometheus.yml must scrape a backup-drill target')
  const declared = schedulerSource.match(/DEFAULT_DRILL_METRICS_PORT\s*=\s*(\d+)/)
  assert.ok(declared, 'schedulerHeartbeat.ts must declare a default metrics port')

  const override = serviceBlock('backup-drill').match(/BACKUP_DRILL_METRICS_PORT:\s*"?(\d+)"?/)
  const effective = override ? override[1] : declared[1]
  assert.equal(
    target[1],
    effective,
    `prometheus scrapes backup-drill:${target[1]} but the scheduler binds ${effective}`,
  )

  // And it must stay out of the ephemeral range, because this container hands
  // itself ephemeral ports: `startColdServer` boots the restored API on one per
  // drill. A collision there happens only under load, on the run whose evidence
  // matters most.
  assert.ok(
    Number(effective) < 32_768,
    `the metrics port (${effective}) is inside the default ephemeral range`,
  )

  // The drill job's block, isolated so the assertions below cannot be satisfied
  // by the api job sitting above it.
  const drillJob = prometheusSource
    .slice(prometheusSource.indexOf('- job_name: backup-drill'))
    .split(/^  - job_name: /m)[0]

  // AUTHORIZATION. Drop the block or repoint the file and every scrape 404s — `up{job="backup-drill"} == 0` forever, the exact
  // reading BackupDrillContainerDown's description warns is indistinguishable
  // from a dead container. The same api-vs-drill equality the METRICS_TOKEN
  // test makes, one layer down: ONE credentials_file serves both jobs.
  assert.match(drillJob, /authorization:/, 'the drill job must send the bearer token')
  const credentialsOf = (block) => block.match(/credentials_file:\s*(\S+)/)?.[1]
  const apiJob = prometheusSource
    .slice(prometheusSource.indexOf('- job_name: maplespire-api'))
    .split(/^  - job_name: /m)[0]
  assert.ok(credentialsOf(apiJob), 'the api job must name a credentials_file')
  assert.equal(
    credentialsOf(drillJob),
    credentialsOf(apiJob),
    'both jobs are scraped with one credentials_file; a second path fails closed on one of them',
  )

  // The SCRAPE TIMEOUT, which prometheus.yml's own comment calls the only thing
  // that can turn a synchronously blocked scheduler into `up == 0` — measured,
  // a 1.5 s block delays the response by 1 502 ms and still answers 200. A
  // generous timeout would hide it.
  const timeout = Number(drillJob.match(/scrape_timeout:\s*(\d+)s/)?.[1])
  assert.ok(
    timeout > 0 && timeout <= 10,
    `the drill scrape_timeout (${timeout}s) must stay tight enough to catch a blocked loop`,
  )
})

test('the drill healthcheck can actually report unhealthy', () => {
  // Without a healthcheck, `docker compose ps backup-drill` reports `Up` for a
  // container whose scheduler is wedged. Three ways to disarm it are checked:
  // the probe pointed at the wrong port, its catch changed to `exit(0)`, or the
  // whole block deleted.
  const drill = serviceBlock('backup-drill')
  assert.match(drill, /healthcheck:/, 'backup-drill must have a healthcheck')

  const probePort = drill.match(/127\.0\.0\.1:(\d+)\/metrics/)?.[1]
  const declared = schedulerSource.match(/DEFAULT_DRILL_METRICS_PORT\s*=\s*(\d+)/)?.[1]
  const override = drill.match(/BACKUP_DRILL_METRICS_PORT:\s*"?(\d+)"?/)?.[1]
  assert.equal(
    probePort,
    override ?? declared,
    `the healthcheck probes ${probePort} but the scheduler binds ${override ?? declared}`,
  )

  assert.match(
    drill,
    /catch\(\(\)=>process\.exit\(1\)\)/,
    'the healthcheck must exit NON-ZERO when the port does not answer',
  )
})

test('the graceful stop still fits after a THIRD teardown step was added', () => {
  // The teardown that has to fit inside `stop_grace_period` is three steps:
  // the abort grace itself, the lock pool's 30s `end()` ceiling, and the
  // metrics listener's 2s close — ~332s against 420s. A fourth step, or a
  // raised grace, fails here instead of surfacing as a SIGKILL mid-teardown.
  const drill = serviceBlock('backup-drill')
  const stop = Number(drill.match(/stop_grace_period:\s*(\d+)s/)?.[1])
  const grace = Number(drill.match(/BACKUP_DRILL_ABORT_GRACE_SECONDS:\s*"?(\d+)"?/)?.[1])
  assert.ok(stop > 0 && grace > 0, 'backup-drill must declare both a stop grace and an abort grace')

  // Literals, deliberately: reading these out of the source would make the
  // assertion agree with whatever those ceilings are changed to.
  const LOCK_POOL_END_CEILING = 30
  const METRICS_STOP_CEILING = 2

  // ...and the literals are then PINNED against the source, so they cannot
  // silently disagree with it in either direction.
  const sourceCeilingMs = Number(
    listenerSource.match(/METRICS_STOP_CEILING_MS\s*=\s*([\d_]+)/)?.[1].replace(/_/g, ''),
  )
  assert.equal(
    METRICS_STOP_CEILING * 1000,
    sourceCeilingMs,
    `this test budgets ${METRICS_STOP_CEILING}s for the listener close but `
    + `metricsListener.ts waits ${sourceCeilingMs}ms`,
  )
  // The lock pool ceiling is declared in lockPoolTeardown.ts.
  const lockPoolCeiling = lockPoolTeardownSource.match(/LOCK_POOL_CLOSE_CEILING_MS\s*=\s*([\d_]+)/)
  assert.ok(lockPoolCeiling, 'lockPoolTeardown.ts must declare LOCK_POOL_CLOSE_CEILING_MS where this test reads it')
  const lockPoolCeilingMs = Number(lockPoolCeiling[1].replace(/_/g, ''))
  assert.equal(
    LOCK_POOL_END_CEILING * 1000,
    lockPoolCeilingMs,
    `this test budgets ${LOCK_POOL_END_CEILING}s for the lock pool close but `
    + `lockPoolTeardown.ts waits ${lockPoolCeilingMs}ms`,
  )
  const teardown = grace + LOCK_POOL_END_CEILING + METRICS_STOP_CEILING
  assert.ok(
    stop > teardown,
    `stop_grace_period (${stop}s) must exceed the whole teardown (${teardown}s: `
    + `${grace}s abort grace + ${LOCK_POOL_END_CEILING}s lock pool end + `
    + `${METRICS_STOP_CEILING}s listener close), or Docker SIGKILLs mid-teardown`,
  )

  // And the consequence for the wedge alert, which is why the `stopping` phase
  // is NOT covered by it: the phase cannot reach its own budget before the
  // kill. Asserted so the alert's comment stops being true loudly rather than
  // quietly if somebody raises the grace.
  const wedgeFor = Number(
    alertsSource.match(/alert: BackupDrillSchedulerWedged[\s\S]*?for:\s*(\d+)m/)?.[1],
  )
  assert.ok(wedgeFor > 0, 'BackupDrillSchedulerWedged must carry a for: window')
  const SLACK_SECONDS = 300
  const stoppingBudget = grace + SLACK_SECONDS
  assert.ok(
    stoppingBudget + wedgeFor * 60 > stop,
    `the stopping phase can now reach its budget (${stoppingBudget}s) plus the wedge window `
    + `(${wedgeFor}m) inside stop_grace_period (${stop}s) — alerts.yml and `
    + 'schedulerHeartbeat.ts both say it cannot, and those comments are now wrong',
  )
})

test('the container-down alert tolerates a graceful stop', () => {
  // `BackupDrillContainerDown` fires on `up == 0`, and a rolling deploy removes
  // the target for the whole of `stop_grace_period` — 420 s here, deliberately,
  // so an aborting drill can unwind. A `for:` window shorter than that pages on
  // every deploy, and an alert that cries wolf stops being read.
  //
  // A relation between two files that do not cite each other. ApiDown's 2m is
  // correct for a container with no grace at all; it would be wrong here.
  //
  // The grace is a LOWER BOUND on the real deploy window, not the window: a
  // rolling deploy also recreates the container and waits on
  // `depends_on: postgres service_healthy`. ~7-8 min against 15 m today. What
  // this asserts is that the window cannot fall BELOW the one part of that
  // total the compose file states; the rest is headroom, and a future
  // `depends_on` with a slow healthcheck eats into it without failing here.
  const drill = serviceBlock('backup-drill')
  const grace = drill.match(/stop_grace_period:\s*(\d+)s/)
  assert.ok(grace, 'backup-drill must set stop_grace_period')

  const rule = alertsSource.match(
    /alert: BackupDrillContainerDown[\s\S]*?for:\s*(\d+)m/,
  )
  assert.ok(rule, 'BackupDrillContainerDown must carry a for: window in minutes')
  assert.ok(
    Number(rule[1]) * 60 > Number(grace[1]),
    `BackupDrillContainerDown fires after ${rule[1]}m, inside the ${grace[1]}s a graceful `
    + 'stop is allowed to take — it would page on every deploy',
  )
})

/** Linux reaps the connection after the idle wait plus every probe. */
const detectionWindow = (idle, interval, count) => idle + count * interval

test('the detection window formula is the one the compose comment cites', () => {
  // The test below is the ONLY defender of the compose keepalive window, so
  // its arithmetic is pinned here (e.g. against a dropped `* count`).
  //
  // 60 / 75 / 9 is the partial-configuration shape the comment in
  // compose.maplespire.yml names -- `tcp_keepalives_idle` set alone, the other
  // two left at the Linux defaults. Its 735 s is measured, not derived: those
  // are the values `pg_settings` reports for an unconfigured session.
  assert.equal(detectionWindow(60, 75, 9), 735)
  assert.equal(detectionWindow(60, 10, 6), 120)
  assert.equal(detectionWindow(60, 30, 10), 360)
})

test('the cluster reaps a client that stopped answering in minutes, not hours', () => {
  // The advisory lock sets these on its own session, so this is not what
  // protects the backup key -- it is what protects everything else. A backend
  // whose client vanished behind a firewall eviction holds its row locks and
  // its transaction for `tcp_keepalive_time`, 7 200 s on Linux, and nothing in
  // the application is even aware of it.
  //
  // Asserted as a computed WINDOW rather than three presence checks, because
  // the failure worth catching is a partial configuration: `idle` alone reads
  // as done and leaves interval=75 / count=9, i.e. 735 s.
  // Read from the parsed `command:` LIST, never from the service block as text:
  // the block includes the comment explaining the settings, so a text match
  // would stay green with the command deleted and only the prose left.
  const postgres = serviceBlock('postgres')
  const lines = postgres.split('\n')
  const start = lines.findIndex((line) => /^\s+command:\s*$/.test(line))
  assert.notEqual(start, -1, 'postgres must declare a command: list')
  const args = []
  for (const line of lines.slice(start + 1)) {
    const item = line.match(/^\s+- (\S.*)$/)
    if (!item) break
    args.push(item[1].trim())
  }
  // The image's entrypoint only passes argv through to the server when argv[0]
  // is `postgres`; anything else and these are flags to a different program.
  assert.equal(args[0], 'postgres', 'the command list must start with postgres')

  const setting = (name) => {
    const found = args.find((arg) => arg.startsWith(`${name}=`))
    assert.ok(found, `postgres must set ${name} on its command line`)
    const value = Number(found.slice(name.length + 1))
    assert.ok(Number.isInteger(value), `${name} must be an integer, got ${found}`)
    return value
  }
  const idle = setting('tcp_keepalives_idle')
  const interval = setting('tcp_keepalives_interval')
  const count = setting('tcp_keepalives_count')
  const detectsWithin = detectionWindow(idle, interval, count)
  assert.ok(
    detectsWithin <= 600,
    `idle + count x interval is ${detectsWithin}s; a dead client must be reaped within 600s`,
  )
  // Measured ceilings: above these the kernel refuses the setsockopt and
  // Postgres reports the PREVIOUS value, with no error anywhere -- so an
  // over-large number here is silently the OS default, not a stricter setting.
  assert.ok(idle <= 32767 && interval <= 32767, 'idle/interval above 32767 are silently ignored')
  assert.ok(count <= 127, 'a count above 127 is silently ignored')
})

test('every service built from server/Dockerfile names its stage', () => {
  // With no `target`, BuildKit builds the LAST stage. server/Dockerfile ends
  // with `drill` (added after `runtime`), so an untargeted service silently
  // builds the DRILL image: the api would run drillScheduler.js, never bind
  // :3001, fail its own healthcheck, and web would never start.
  //
  // Only server/Dockerfile is covered. docker/nginx/Dockerfile is multi-stage
  // too, but its LAST stage is the one `web` wants, so a target there would be
  // ceremony -- and a test that demanded one would be asserting a rule that is
  // not true.
  for (const service of ['api', 'backup-drill']) {
    const block = serviceBlock(service)
    assert.match(block, /dockerfile: Dockerfile/)
    assert.match(block, /\n\s+target: \S/, `${service} must name its build stage`)
  }
})

test('prometheus listens where a SIBLING container can reach it', () => {
  // `--web.listen-address=127.0.0.1:9090` binds the CONTAINER's loopback. The
  // self-scrape in prometheus.yml targets 127.0.0.1:9090 and keeps working, so
  // Prometheus itself looks perfectly healthy -- while Grafana, a sibling, gets
  // "Datasource not found" on every panel. Nothing in the stack reports it.
  //
  // Opening the listener is not an exposure: there is no `ports:` entry for
  // prometheus, so it reaches the compose network and nothing else, exactly
  // like api:3001 and postgres:5432. What keeps it off the internet is the
  // tunnel ingress list, which names `web`.
  const prometheus = serviceBlock('prometheus')
  assert.match(prometheus, /--web\.listen-address=0\.0\.0\.0:9090/)
  assert.doesNotMatch(
    prometheus,
    /--web\.listen-address=127\.0\.0\.1/,
    'a container-local listener is unreachable from Grafana',
  )
  // Both anchored to a COMMAND-LIST line, never to bare text: the compose file
  // has a comment mentioning these flags, and a bare match would read it.
  assert.doesNotMatch(composeSource, /^\s+- --web\.enable-lifecycle$/m, 'POST /-/quit is reachable by every sibling once the listener is open')
  assert.doesNotMatch(composeSource, /^\s+- --web\.enable-admin-api/m, 'the admin API carries delete_series')

  // And no `ports:` on prometheus, which is what makes the line above safe.
  // If somebody publishes it later, this pairing is the thing that has to be
  // reconsidered -- so it fails here rather than being noticed in a scan.
  assert.doesNotMatch(prometheus, /^\s+ports:$/m, 'prometheus must stay unpublished')
})

test('nothing in the stack publishes beyond loopback', () => {
  // Every published port in this file is `127.0.0.1:host:container`. A bare
  // `"3030:3000"` binds 0.0.0.0, which on a home network is the LAN and, behind
  // some routers, the internet. Grafana ships with a known default admin user,
  // so this is the one service where the mistake is immediately exploitable.
  const published = [...composeSource.matchAll(/^\s+- "([^"]+:\d+)"$/gm)].map((m) => m[1])
  assert.ok(published.length >= 2, 'expected published ports to still be there')
  for (const mapping of published) {
    assert.match(mapping, /^127\.0\.0\.1:/, `${mapping} is published beyond loopback`)
  }
})

test('grafana is provisioned from files that actually exist', () => {
  // Three strings in three different files have to agree, and every
  // disagreement produces the SAME symptom: a Grafana with no dashboard and no
  // error anywhere. Nothing logs "I provisioned nothing".
  const grafana = serviceBlock('grafana')

  // (a) the mount target and the provider path.
  const providerPath = providerSource.match(/^\s*path:\s*(\S+)\s*$/m)?.[1]
  assert.ok(providerPath, 'the dashboard provider must name a path')
  assert.ok(
    grafana.includes(`:${providerPath}:ro`),
    `the provider reads ${providerPath} and compose mounts nothing there`,
  )

  // (b) the data source URL and the compose service name.
  assert.match(datasourceSource, /url:\s*http:\/\/prometheus:9090/)

  // (c) the directories are not empty. A provider pointed at an empty folder
  // starts cleanly and provisions nothing at all.
  assert.ok(dashboardFiles.some((name) => name.endsWith('.json')), 'no dashboard JSON to provision')

  // The dashboards are read-only to the container: provisioning never writes
  // there, and a writable mount invites an edit that the next restart eats.
  assert.match(grafana, /grafana\/dashboards:\S+:ro/)
  assert.match(grafana, /grafana\/provisioning:\S+:ro/)
})

test('grafana refuses anonymous access and asks for a real secret', () => {
  // The dashboard names workspace counts, failure counts and drill history. It
  // is operational detail, not a status page.
  const grafana = serviceBlock('grafana')
  assert.match(grafana, /GF_AUTH_ANONYMOUS_ENABLED: "false"/)
  assert.match(grafana, /GF_USERS_ALLOW_SIGN_UP: "false"/)

  // `:?` and not `:-`. A default would boot Grafana with a password committed
  // to this repository, on a service reachable from the host -- and it would
  // do it silently, which is the whole difference.
  assert.match(
    grafana,
    /GF_SECURITY_ADMIN_PASSWORD: \$\{MAPLESPIRE_GRAFANA_ADMIN_PASSWORD:\?/,
    'the admin password must have no default',
  )

  // And the script that generates it must know about it, or every `up` fails
  // for the WHOLE stack with a message about a variable nothing sets.
  assert.ok('MAPLESPIRE_GRAFANA_ADMIN_PASSWORD' in initEnv.GENERATED)
  assert.ok(initEnv.REQUIRED.includes('MAPLESPIRE_GRAFANA_ADMIN_PASSWORD'))
})

// ─────────────────────────────────────────────────────────────────────────
// The coordination Redis.
//
// A persisted append-only file can be torn by an unclean shutdown; redis-server
// then exits 1 on every start, and because `api` carries REDIS_REQUIRED and
// depends_on redis: service_healthy, the whole site stays down.
//
// EVERY assertion below is anchored to a command-list or block-structure line,
// never to bare text. The comments in compose.maplespire.yml necessarily
// contain the strings `--appendonly yes`, `redis_data` and `depends_on` while
// explaining why none of them is there.
// ─────────────────────────────────────────────────────────────────────────

/** The single-line `command: [...]` of a service, for services that use the
 * inline array form. Returns the LINE, so an assertion cannot drift onto a
 * neighbouring comment. */
function commandLine(service) {
  const line = serviceBlock(service)
    .split('\n')
    .find((candidate) => /^\s+command:\s*\[/.test(candidate))
  assert.ok(line, `${service} must declare an inline command array`)
  return line
}

/**
 * Every value a service's command gives to `flag`, in order.
 *
 * A SUBSTRING match cannot see a flag given twice, and a flag given twice is
 * the whole hazard here: `["redis-server", "--save", "", …, "--save", "3600 1"]`
 * satisfies `/"--save",\s*""/` while the server is snapshotting. Returning the
 * LIST lets the assertion be "exactly one, and it is the empty one".
 */
function commandFlagValues(service, flag) {
  const inside = /\[(.*)\]/.exec(commandLine(service))?.[1] ?? ''
  const tokens = [...inside.matchAll(/"([^"]*)"/g)].map((match) => match[1])
  const values = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === flag) values.push(tokens[index + 1] ?? '')
  }
  return values
}

test('the coordination Redis persists nothing, and BOTH halves are required', () => {
  const command = commandLine('redis')

  // The AOF half.
  assert.match(command, /"--appendonly",\s*"no"/, 'the append-only file must be off')
  assert.doesNotMatch(command, /"--appendonly",\s*"yes"/)

  // The RDB half, which is NOT implied by the first. With `--appendonly no`
  // alone, Redis still snapshots at its compiled-in save points
  // (3600/1, 300/100, 60/10000) — a second file for the same unclean shutdown
  // to tear. `--save ""` is what turns that off (render-cache carries both
  // for the same reason). The whole value LIST is asserted, so a later
  // `--save "3600 1"` cannot slip in behind the empty one.
  assert.deepEqual(
    commandFlagValues('redis', '--save'),
    [''],
    'RDB snapshotting must be off too, not just AOF — and exactly one --save may appear, '
    + 'because a second one later in the same list is what the server ends up using',
  )
  assert.deepEqual(commandFlagValues('redis', '--appendonly'), ['no'], 'exactly one --appendonly, and it is off')

  // A tell that somebody re-enabled persistence one flag at a time: this knob
  // only means anything with the AOF on.
  assert.doesNotMatch(command, /appendfsync/, 'appendfsync is inert with AOF off — this is a half-revert')

  // No volume on the service... Anchored on the KEY (no trailing `$`), so the
  // flow spelling `volumes: ["redis_data:/data"]` cannot walk past it;
  // `serviceBlock` has already scoped the text to one service.
  assert.doesNotMatch(
    serviceBlock('redis'),
    /^\s+volumes:/m,
    'redis must mount nothing: with persistence off /data is written by nothing, and a mounted volume is where the 2026-08-30 corrupt AOF still lives',
  )
  // ...and no declaration for it either. Anchored to the two-space declaration
  // indent so the prose above it cannot satisfy this.
  assert.doesNotMatch(composeSource, /^ {2}redis_data:/m, 'the redis_data volume declaration must stay gone')
})

test('the coordination Redis still refuses to evict, which IS load-bearing', () => {
  // The one durability-shaped property that genuinely matters here. Every
  // sync-cell owner key is a lease; an evicted lease is one that nobody
  // released and nobody knows is gone, and the fencing token cannot help
  // because the eviction is silent.
  //
  // The temptation is to make this match `render-cache` now that both run
  // without persistence. They are not the same kind of thing: that one is a
  // pure cache and loses nothing by dropping a key.
  assert.match(
    commandLine('redis'),
    /"--maxmemory-policy",\s*"noeviction"/,
    'an evicted lease key is a lease nobody released',
  )
  assert.match(commandLine('render-cache'), /"--maxmemory-policy",\s*"allkeys-lru"/)
})

test('the monitoring stack does not depend on the stack it monitors', () => {
  // `api` carries `depends_on: redis: service_healthy`. If `prometheus`
  // depended on `api`, a crash-looping redis would keep the container holding
  // `ApiDown` from ever STARTING. Measured on that dependency graph, 20s after
  // `compose up -d` with redis crash-looping:
  //
  //   api: service_healthy           -> prometheus created, grafana created
  //   api: service_started           -> prometheus created, grafana created
  //   no depends_on                  -> prometheus RUNNING, grafana RUNNING
  //
  // Hence ABSENCE, not a weaker condition: `service_started` changes nothing,
  // because `api` is never started either. No trailing `$`, so the flow
  // spelling `depends_on: {…}` cannot walk past these.
  assert.doesNotMatch(
    serviceBlock('prometheus'),
    /^\s+depends_on:/m,
    'prometheus must start during an outage, which is the only time its rules matter',
  )
  assert.doesNotMatch(
    serviceBlock('redis-exporter'),
    /^\s+depends_on:/m,
    'an exporter that waits for the thing it exports is silent in exactly the outage it exists to report',
  )

  // The other half of the claim, so this test fails if the premise stops
  // holding rather than passing vacuously: the chain it protects against must
  // still exist. If `api` ever stops depending on redis, the reasoning above
  // needs rewriting rather than silently becoming decoration.
  assert.match(serviceBlock('api'), /^\s+redis:\n\s+condition: service_healthy$/m)

  // And grafana's edge is deliberately kept: it points AWAY from the monitored
  // stack, so it cannot reproduce this.
  assert.match(serviceBlock('grafana'), /^\s+prometheus:\n\s+condition: service_started$/m)
})

test('the redis scrape target names the service that actually serves it', () => {
  // Three strings in two files, and every disagreement fails the same silent
  // way the drill's job name does: rules present, valid, permanently inactive.
  // `scripts/monitoring.test.mjs` already checks that a rule's `job=` exists in
  // prometheus.yml; what it cannot see is whether that job points at a
  // container this compose file defines. Every host of every (possibly
  // multi-entry) `targets:` array is checked, e.g. `['api:3001', 'api-b:3001']`.
  const hosts = [...prometheusSource.matchAll(/targets:\s*\[([^\]]*)\]/g)]
    .flatMap((array) => [...array[1].matchAll(/'([\w.-]+):(\d+)'/g)].map((entry) => entry[1]))
  assert.ok(hosts.includes('redis-exporter'), 'prometheus.yml must scrape the redis exporter')

  // Prometheus scrapes ITSELF over loopback, which is not a compose service and
  // is not meant to be. Named rather than pattern-matched, so a service that
  // quietly becomes an IP literal is a failure and not an exemption.
  const external = new Set(['127.0.0.1', 'localhost'])
  for (const host of hosts.filter((name) => !external.has(name))) {
    assert.notEqual(
      composeLines.indexOf(`  ${host}:`),
      -1,
      `prometheus.yml scrapes ${host}, which is not a service in this compose file`,
    )
  }

  // The exporter must point at the redis service by the name compose gives it.
  // Renaming the redis service leaves this string valid-looking and the
  // exporter reporting redis_up 0 for ever -- an outage signal that is a
  // configuration error, which is the worst kind because it looks like news.
  assert.match(commandLine('redis-exporter'), /redis:\/\/redis:6379/)
  assert.notEqual(composeLines.indexOf('  redis:'), -1)
})
// ─── G6 — how many cells can each manifest actually produce? ────────────────
//
// A CELL is a service that declares SYNC_CELL_ID: the one field every cell must
// set and nothing else sets. SYNC_CELL_OWNERSHIP lives in the harness's shared
// YAML anchor rather than in each service, so counting it would find 0 cells in
// a file with three; SYNC_CELL_ADVERTISE_URL is not required for a single-cell
// manifest, so it is not a reliable discriminator either.
const harnessSource = await readFile(
  new URL('../infra/compose/sync-cell-failover.yml', import.meta.url),
  'utf8',
)

/** Service name -> its block text, for any compose source. */
function serviceBlocksOf(source) {
  const lines = source.split(/\r?\n/)
  const blocks = new Map()
  for (const name of serviceNames(source)) {
    const start = lines.indexOf(`  ${name}:`)
    const next = lines.findIndex(
      (line, index) => index > start && /^ {2}[a-zA-Z0-9][a-zA-Z0-9_-]*:\s*$/.test(line),
    )
    blocks.set(name, lines.slice(start, next === -1 ? undefined : next).join('\n'))
  }
  return blocks
}

function cellServicesOf(source) {
  return [...serviceBlocksOf(source)]
    .filter(([, block]) => /^\s+SYNC_CELL_ID:/m.test(block))
    .map(([name]) => name)
}

test('the web image build is self-sufficient, and still runs prebuild', async () => {
  // `tsconfig.app.json` includes every file under `src`, tests included, and
  // the conformance tests in `src/lib/automerge/` import `server/src/**`
  // deliberately — comparing the client's implementation against the server's
  // IS the test. The web build stage copies `src` and not `server/src`.
  //
  // Lint, typecheck and the whole vitest suite cannot see a breakage here,
  // because at the repo root `server/` is simply there. The failure exists only
  // inside the build context, which is why a test that reads the Dockerfile is
  // the only thing that can see it.
  const dockerfile = await readFile(new URL('../docker/nginx/Dockerfile', import.meta.url), 'utf8')
  const copied = [...dockerfile.matchAll(/^COPY\s+(?!--from)([^\s]+)\s/gm)].map((m) => m[1])

  // The stage typechecks through `tsconfig.image.json` / `npm run build:image`,
  // which excludes test files, so the pair invariant below asks WHICH files the
  // stage typechecks rather than WHETHER it typechecks at all.
  //
  // Everything here is RESOLVED from the tree, never assumed: the stage's npm
  // script comes from the Dockerfile, its command from package.json, and the
  // exclusion from the tsconfig that command names. A gate that hard-codes
  // "the image build excludes tests" stays green the day somebody deletes the
  // exclusion.
  const scripts = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).scripts

  // EVERY `RUN npm run` line, not the first one. Reading only the first is
  // wrong in both directions: prepend `RUN npm run something-else` and the
  // resolution below silently describes that instead, making the invariant
  // vacuous; and a stage that legitimately runs two scripts is read as running
  // one.
  const stageScripts = [...dockerfile.matchAll(/^RUN\s+npm run ([A-Za-z0-9:_.-]+)/gm)].map((match) => match[1])
  assert.ok(stageScripts.length > 0, 'the web stage runs no npm script at all — this gate resolves nothing')
  for (const name of stageScripts) {
    assert.ok(scripts[name], `the web stage runs \`npm run ${name}\`, which package.json does not define`)
  }
  const stageCommand = stageScripts.map((name) => scripts[name]).join(' && ')

  const project = /\btsc\b[^&|]*?\s(?:-p|--project)\s+([^\s&|]+)/.exec(stageCommand)?.[1] ?? null
  // An unreadable project is NOT the same state as no project, and collapsing
  // them is how this gate would quietly stop reading the exclusion: `-p` given
  // a directory, or a renamed config, would land in `excludesTestFiles === false`
  // and merely widen the scan. Say so instead.
  const projectText = project === null
    ? ''
    : await readFile(new URL(`../${project}`, import.meta.url), 'utf8').catch(() => null)
  assert.notEqual(
    projectText,
    null,
    `the web stage typechecks through \`${project}\`, which cannot be read as a file from the repository root`,
  )

  // The QUOTED glob literals, not the words: `tsconfig.image.json` explains the
  // exclusion in a block comment that names `src/webImageBuild.test.ts`.
  // `src/webImageBuild.test.ts` pins the array itself, parsed, to exactly
  // these two globs; this is the same fact read from the text.
  const excludesTestFiles =
    /"src\/\*\*\/\*\.test\.ts"/.test(projectText) && /"src\/\*\*\/\*\.test\.tsx"/.test(projectText)

  // RESOLVED, not counted: whether an import ESCAPES `src/` is a question about
  // where it lands, not about how many `../` it has (`../../stores/x` is an
  // ordinary intra-`src` import).
  const root = new URL('../', import.meta.url)
  const srcRoot = new URL('src/', root)

  async function tsFilesUnder(dir) {
    const found = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
      if (entry.isDirectory()) found.push(...await tsFilesUnder(child))
      else if (/\.(ts|tsx)$/.test(entry.name)) found.push(child)
    }
    return found
  }

  // Only the files the stage COMPILES. A test file excluded from
  // `tsconfig.image.json` is not part of the artifact and cannot fail the image
  // build, so counting its cross-package import here would report a breakage
  // that does not exist. When the exclusion is absent the filter is a no-op
  // and every file is scanned.
  const walked = await tsFilesUnder(srcRoot)
  const isTestFile = (file) => /\.test\.tsx?$/.test(file.pathname)
  const files = walked.filter((file) => !(excludesTestFiles && isTestFile(file)))
  // The control on the SCAN: with no files or no imports found, every assertion
  // below is vacuous and the gate would pass on a Dockerfile copying nothing.
  assert.ok(files.length > 100, `only ${files.length} client sources scanned — the walk is broken, not the tree`)
  // ...and the control on the FILTER, which the walk's own control cannot give:
  // a filter that removed production files too would leave both counts healthy.
  assert.equal(
    walked.length - files.length,
    excludesTestFiles ? walked.filter(isTestFile).length : 0,
    'the filter removed something other than the test files the image config excludes',
  )

  const reached = new Map()
  let relativeImports = 0
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(/from\s+'(\.[^']*)'/g)) {
      relativeImports += 1
      const target = new URL(match[1], file)
      // Intra-`src` targets are recorded too, not assumed "covered by
      // `COPY src`": with test files excluded, nearly every target is inside
      // `src/`, and skipping them would let `COPY src ./src` be deleted with
      // this gate still green.
      const relative = decodeURIComponent(target.href.slice(root.href.length))
      if (relative && !reached.has(relative)) {
        reached.set(relative, `${file.href.slice(srcRoot.href.length)} -> ${match[1]}`)
      }
    }
  }
  assert.ok(relativeImports > 100, `only ${relativeImports} relative imports seen — the scan is broken`)

  // A COPY must CONTAIN the import target, not merely share its first path
  // segment: `COPY server/patch-automerge-peer-sync-state.mjs` (a single file
  // the stage needs for `npm ci`) does not make `server/src` available.
  const covers = (copiedPath, target) => {
    const clean = copiedPath.replace(/^\.\//, '').replace(/\/$/, '')
    return target === clean || target.startsWith(`${clean}/`)
  }
  const unsatisfiable = [...reached].filter(([target]) => !copied.some((path) => covers(path, target)))

  // THE SOURCES THEMSELVES, unconditionally. Nothing this stage does — bundling
  // or typechecking — is possible without them, so unlike the cross-package
  // question below this one is not paired with anything: a target under `src/`
  // that no COPY contains means the image build fails on a tree where lint,
  // typecheck and the whole vitest suite are green.
  const missingSources = unsatisfiable.filter(([target]) => target.startsWith('src/'))
  assert.ok(
    copied.some((path) => covers(path, 'src')),
    'docker/nginx/Dockerfile no longer COPYs src/ — the stage bundles nothing and typechecks nothing',
  )
  assert.equal(
    missingSources.length,
    0,
    `docker/nginx/Dockerfile does not copy ${missingSources.length} path(s) the stage imports, `
    + `starting with ${missingSources.slice(0, 3).map(([t]) => t).join(', ')}`,
  )

  // And the cross-package half, which IS paired — see below.
  const missingAcrossPackages = unsatisfiable.filter(([target]) => !target.startsWith('src/'))

  // THE INVARIANT IS ABOUT THE PAIR, not about either half. The stage may
  // typecheck across the package boundary, or it may reach across it — it may
  // not do both. Copying `server/src` in would make `tsc` typecheck the whole
  // server with none of its dependencies present (`pg`, `express`, `jose`).
  // Instead the typecheck is narrowed to the files that ship; what is excluded
  // is checked at the repo root by CI and ci:local, which both run
  // `npm run build` — `tsc -b && vite build` — where the monorepo exists.
  //
  // RESOLVED through package.json rather than matched in the Dockerfile: a
  // script's NAME says nothing about what it runs.
  //
  // THIS HALF IS CONDITIONAL AND HAS NO LIVE SUBJECT TODAY. Every
  // cross-package import in this tree is in a
  // `*.conformance.test.ts`, which the image config excludes, so
  // `missingAcrossPackages` is empty and this assertion cannot fail as the tree
  // stands. What DOES fire on that class is `src/webImageBuild.test.ts`, which
  // walks `src` unfiltered and requires the offender list outside test files to
  // be empty. This one fires when the pair breaks — a stage that typechecks a
  // file reaching somewhere the context has not got.
  const typechecks = /\btsc\b/.test(stageCommand) || /^RUN\s+(?!npm run\b).*\btsc\b/m.test(dockerfile)
  assert.ok(
    !(typechecks && missingAcrossPackages.length > 0),
    `docker/nginx/Dockerfile typechecks the client, but the client reaches outside src/ to `
    + `${missingAcrossPackages.map(([t]) => t).join(', ')} — which this stage does not contain. `
    + 'Either exclude the files that reach out (tsconfig.image.json), bundle without `tsc` at all '
    + '(the typecheck is done at the repo root by CI), or make the stage self-sufficient. As written '
    + 'the image cannot build, while lint, typecheck and the whole vitest suite stay green because '
    + '`server/` is simply present at the repo root.',
  )

  // ...and the verifications the `build` script brings along must still run
  // in the image build. They are `verify:automerge-patch && verify:icon-assets`, and npm fires
  // a pre-script only for the exact name invoked — so bundling with `vite`
  // directly, or renaming `build` to `build:image` without adding
  // `prebuild:image`, drops both silently with the image building perfectly
  // well. Read as `pre<name>` OR the named script itself, because the stage may
  // legitimately invoke the verifications directly (`RUN npm run prebuild &&
  // …`), and a gate that only knew the first form would fail that tree.
  const verifications = stageScripts
    .flatMap((name) => [scripts[`pre${name}`] ?? '', scripts[name] ?? ''])
    .join(' && ')
  for (const verification of ['verify:automerge-patch', 'verify:icon-assets']) {
    assert.ok(
      verifications.includes(verification),
      `the web stage runs \`npm run ${stageScripts.join('` and `npm run ')}\`, and neither those scripts nor `
      + `their \`pre\` twins run ${verification} — so it no longer runs in the image build, and its absence `
      + 'produces no signal',
    )
  }
})

test('G6 — the shipped manifest produces TWO cells, the harness THREE', () => {
  // Pinned at 2 rather than `>= 2` deliberately. A third cell appearing by
  // accident — a copy-paste of `api-b`, a merge that duplicates a block — is a
  // change to workspace placement nobody asked for, and the standby topology
  // here is deliberately exactly one owner plus one spare.
  const shipped = cellServicesOf(composeSource)
  const harness = cellServicesOf(harnessSource)

  // PRINTED, because a count nobody can read is a count nobody checks.
  console.log(`compose.maplespire.yml cellServices=${shipped.length} (${shipped.join(', ') || 'none'})`)
  console.log(`sync-cell-failover.yml cellServices=${harness.length} (${harness.join(', ') || 'none'})`)

  assert.equal(shipped.length, 2, 'compose.maplespire.yml should declare exactly two sync cells')
  assert.equal(harness.length, 3, 'the failover harness should declare three sync cells')
  // The two must be DISTINCT identities. One anchor feeding both services is
  // how they stay in step on everything else, and `SYNC_CELL_ID` is precisely
  // the value that must not be shared: two cells announcing one id cannot both
  // be resolved as a partition owner, and the second would look like the first
  // restarting rather than like a peer.
  const ids = shipped.map((name) => serviceBlock(name).match(/SYNC_CELL_ID:\s*(\S+)/)?.[1])
  assert.equal(new Set(ids).size, ids.length, `two cells share one SYNC_CELL_ID: ${ids.join(', ')}`)
})

test('G6 — every cell in a MULTI-cell manifest advertises a route', () => {
  // THE CHARACTER CLASS IS [ \t] AND NOT \s: `\s` matches NEWLINES, so an
  // empty `SYNC_CELL_ADVERTISE_URL:` would let the match run onto the
  // FOLLOWING line. Present-but-blank is exactly how this field gets broken.
  //
  // A cell that does not advertise cannot be routed to: `syncCellAdvertiseUrl`
  // returns null, the snapshot reports `routeAdvertised: false`, and NOTHING
  // refuses — the cell comes up, holds a partition, and is unreachable through
  // the router.
  //
  // Conditioned on there being more than one cell, deliberately: with a single
  // cell there is nothing to route BETWEEN. Today both files have several.
  for (const [label, source] of [
    ['compose.maplespire.yml', composeSource],
    ['sync-cell-failover.yml', harnessSource],
  ]) {
    const blocks = serviceBlocksOf(source)
    const cells = cellServicesOf(source)
    if (cells.length < 2) continue
    for (const cell of cells) {
      assert.match(
        blocks.get(cell),
        /^[ \t]+SYNC_CELL_ADVERTISE_URL:[ \t]*\S/m,
        `${label}: ${cell} declares SYNC_CELL_ID but no SYNC_CELL_ADVERTISE_URL, so the router cannot reach it`,
      )
    }
  }
})

test('G6 — that rule can actually fire', () => {
  // The positive control, inline, because the rule above is conditioned on
  // `cells.length >= 2` and would pass on a tree where it never runs. A cell
  // whose advertise URL was deleted, played against a synthetic source so the
  // real file stays clean.
  const mutated = harnessSource.replace(
    /^\s+SYNC_CELL_ADVERTISE_URL: http:\/\/sync-cell-b:3001$/m,
    '',
  )
  assert.notEqual(mutated, harnessSource, 'the mutant did not change anything — the anchor moved')

  const blocks = serviceBlocksOf(mutated)
  const cells = cellServicesOf(mutated)
  assert.equal(cells.length, 3, 'the mutant must remove only the URL, not the cell')
  const offenders = cells.filter((cell) => !/^[ \t]+SYNC_CELL_ADVERTISE_URL:[ \t]*\S/m.test(blocks.get(cell)))
  assert.deepEqual(offenders, ['sync-cell-b'], 'deleting one advertise URL must be visible to the rule')
})

test('G6 — every cell service builds the SERVER stage, not whatever is last', () => {
  // With no `target`, BuildKit builds the LAST stage of server/Dockerfile,
  // which is `drill` — so a cell would run the backup-drill scheduler, never
  // call app.listen, and fail its /api/ready healthcheck forever. The log is
  // misleading: it still contains "MapleSpire sync server running", from the
  // drill's own cold-server child on a random port.
  for (const [label, source] of [
    ['compose.maplespire.yml', composeSource],
    ['sync-cell-failover.yml', harnessSource],
  ]) {
    const blocks = serviceBlocksOf(source)
    for (const cell of cellServicesOf(source)) {
      const block = blocks.get(cell)
      if (!/^\s+build:/m.test(block) && !/<<: \*sync-cell/.test(block)) continue
      const anchored = /<<: \*sync-cell/.test(block)
      const buildText = anchored
        ? source.slice(source.indexOf('x-sync-cell:'), source.indexOf('services:'))
        : block
      assert.match(
        buildText,
        /^\s+target: runtime$/m,
        `${label}: ${cell} builds server/Dockerfile without \`target: runtime\`, so BuildKit builds the last stage (drill) and the cell never serves`,
      )
    }
  }
})

test('both manifests set UV_THREADPOOL_SIZE, and the harness defaults to the shipped value', () => {
  // A remedy, not a tuning knob, which is why it gets a gate.
  //
  // `dns.lookup` is `getaddrinfo` on the libuv threadpool — FOUR threads unless
  // this says otherwise. Stop a dependency's container and its DNS name stops
  // resolving; failed lookups then accumulate faster than they complete, and
  // every NEW connection to any other host queues behind them while every
  // already-open connection is untouched. Measured inside a cell: resolving the
  // Postgres hostname went from 0.25 ms to 13 449 ms. On the failover bench,
  // during one Redis outage, promote-summary went from 500 at 10 035 ms to 409
  // at 33 ms with the larger pool. The symptom looks like database-pool
  // exhaustion; it is not.
  //
  // The number is compared BETWEEN the two files rather than retyped in each:
  // a harness running a different configuration from production measures a
  // system nobody deploys.
  const shipped = /^\s*UV_THREADPOOL_SIZE:\s*"?(\d+)"?\s*$/m.exec(composeSource)
  assert.ok(shipped, 'compose.maplespire.yml does not set UV_THREADPOOL_SIZE')

  // The unset-ONLY default form. `${VAR:-64}` would substitute 64 for an empty
  // value too, and an empty value is how a bench run deliberately restores the
  // default — libuv reads it as 0 and falls back to 4. Keeping that override
  // working is what lets the fix be re-tested later.
  const harness = /^\s*UV_THREADPOOL_SIZE:\s*\$\{UV_THREADPOOL_SIZE-(\d+)\}\s*$/m.exec(harnessSource)
  assert.ok(harness, 'sync-cell-failover.yml must default UV_THREADPOOL_SIZE with the unset-only ${VAR-N} form')

  assert.equal(harness[1], shipped[1], 'the harness default and the shipped value have drifted apart')
  assert.ok(Number(shipped[1]) > 4, 'a value of 4 or less is the Node default and fixes nothing')
})

// Readiness-probe consumers and their Redis timeout margins are checked together
// in readiness-consumers.test.mjs (Compose, Kubernetes and ECS/ALB).

test('the local email outbox is writable by the runtime user', () => {
  // Measured on a clean `up`: with EMAIL_PROVIDER=local and no OUTBOX_DIR,
  // registration answered 500 with `EACCES: permission denied, mkdir
  // '/app/.outbox'`, so nobody could confirm the first account.
  const anchor = composeSource.slice(
    composeSource.indexOf('x-api-environment: &api-environment'),
    composeSource.indexOf('x-api-healthcheck:'),
  )
  assert.match(anchor, /^ {2}EMAIL_PROVIDER: \$\{EMAIL_PROVIDER:-local\}$/m)
  assert.match(anchor, /^ {2}OUTBOX_DIR: \/tmp\//m, 'OUTBOX_DIR must point at a directory the runtime user can create')
})

test('both cells receive the AI endpoint allowlist and can reach the host', () => {
  // Without it every LM Studio / OpenAI-compatible base URL is refused with
  // "not permitted by the server AI endpoint allowlist", whatever .env says.
  const anchor = composeSource.slice(
    composeSource.indexOf('x-api-environment: &api-environment'),
    composeSource.indexOf('x-api-healthcheck:'),
  )
  assert.match(anchor, /^ {2}AI_ALLOWED_BASE_URLS: \$\{AI_ALLOWED_BASE_URLS:-\}$/m)
  for (const cell of ['api', 'api-b']) {
    const start = composeSource.indexOf(`\n  ${cell}:\n`)
    const body = composeSource.slice(start, composeSource.indexOf('\n  # ', start + 1))
    assert.match(body, /- "host\.docker\.internal:host-gateway"/, `${cell} must map host.docker.internal`)
  }
})
