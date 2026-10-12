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
 * The alert rules are only as good as their metric names.
 *
 * An alert that references a metric nothing emits never fires, and it fails
 * silently in exactly the direction that hurts: the rule is present, promtool
 * validates it, the Prometheus UI lists it, and it sits at "inactive" forever
 * because the series does not exist. Renaming a gauge in `index.ts` is enough
 * to do it, and nothing else in the pipeline would notice.
 *
 * So: every `maplespire_*` name used in a rule must be a name the server
 * actually pushes, and every gauge the server pushes should be referenced by at
 * least one rule — the second half is a weaker claim (a metric can legitimately
 * be dashboard-only) so it is reported rather than enforced.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const alertsSource = await readFile(new URL('../infra/monitoring/alerts.yml', import.meta.url), 'utf8')
const prometheusSource = await readFile(new URL('../infra/monitoring/prometheus.yml', import.meta.url), 'utf8')
/** The promtool fixture suite, for the coverage floor its own `SUCCESS` cannot give. */
const fixtureSource = await readFile(new URL('../infra/monitoring/alerts.test.yml', import.meta.url), 'utf8')

/** Every `.ts` under `server/src`, concatenated.
 *
 * Not `server/src/index.ts` alone: metrics are emitted from several modules
 * (e.g. `rbac/docScope.ts`), and a guard whose INPUT is narrower than its claim
 * reports on its input, not on the system.
 */
async function readServerSources(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true })
  const sources = []
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir)
    if (entry.isDirectory()) sources.push(...await readServerSources(child, `${prefix}${entry.name}/`))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      // The RELATIVE path, not the basename. `server/src/ai/index.ts` and
      // `server/src/email/index.ts` both exist, so a basename lookup for the
      // entrypoint would return the wrong file.
      sources.push({ path: `${prefix}${entry.name}`, source: await readFile(child, 'utf8') })
    }
  }
  return sources
}
const serverFiles = await readServerSources(new URL('../server/src/', import.meta.url))
const metricsSource = serverFiles.map((file) => file.source).join('\n')

/** `export const SCHEDULER_PHASE_AGE_METRIC = 'maplespire_…'` → the name.
 *
 * A metric name is worth a constant when a unit test has to assert it, and
 * `schedulerHeartbeat.ts` does exactly that. Reading only string LITERALS would
 * make such gauges invisible here — and the "is it actually pushed" gate below
 * would silently skip the whole file.
 *
 * So the parser resolves one level of indirection. It deliberately does NOT
 * resolve arbitrary expressions: a name built by concatenation or interpolation
 * is unknowable from source and lands in `unresolved` below, where it is
 * reported rather than guessed at.
 */
const metricNameConstants = new Map(
  [...metricsSource.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*'(maplespire_[a-z0-9_]+)'/g)]
    .map((match) => [match[1], match[2]]),
)

/** Every `name:` inside a MetricSample, with where it sits in the concatenated source. */
const emittedSites = []
const unresolvedNameSites = []
for (const match of metricsSource.matchAll(/name:\s*(?:'(maplespire_[a-z0-9_]+)'|([A-Za-z_$][\w$]*))/g)) {
  const [, literal, identifier] = match
  const name = literal ?? metricNameConstants.get(identifier)
  // `name:` appears on plenty of objects that are not MetricSamples; only an
  // identifier that resolves to a maplespire_ constant counts as one.
  if (name) emittedSites.push({ name, index: match.index })
  else if (identifier && /METRIC$/.test(identifier)) unresolvedNameSites.push(identifier)
}

/** Names the server pushes. */
const emitted = new Set(emittedSites.map((site) => site.name))

/** Does this ONE file bind a metric name into a sample?
 *
 * Not `source.includes(someMetricName)`, which a passing mention in a comment
 * satisfies — the check has to be about the binding, or it reports on prose.
 */
function definesMetrics(source) {
  for (const match of source.matchAll(/name:\s*(?:'(maplespire_[a-z0-9_]+)'|([A-Za-z_$][\w$]*))/g)) {
    if (match[1] ?? metricNameConstants.get(match[2])) return true
  }
  return false
}

/** The source window belonging to one metric: its `name:` up to the next one.
 *
 * `maxChars` caps it because the LAST metric in the concatenated source would
 * otherwise own everything to EOF — a window wider than its claim.
 */
function metricBlock(name, maxChars = 2_000) {
  const at = emittedSites.findIndex((site) => site.name === name)
  if (at === -1) return null
  const start = emittedSites[at].index
  const next = at + 1 < emittedSites.length ? emittedSites[at + 1].index : metricsSource.length
  return metricsSource.slice(start, Math.min(next, start + maxChars))
}

/** Names the rules mention, minus label matchers and function calls. */
const referenced = new Set(
  [...alertsSource.matchAll(/\b(maplespire_[a-z0-9_]+)\b/g)]
    .map((match) => match[1])
    // Annotations quote metric names in prose; only expressions matter, but
    // including prose mentions is harmless — they name real metrics too.
    .filter(Boolean),
)

test('the server emits every metric the alert rules reference', () => {
  assert.ok(emitted.size > 0, 'no metrics parsed out of server/src — the parser is stale')
  const missing = [...referenced].filter((name) => !emitted.has(name))
  assert.deepEqual(
    missing,
    [],
    `alerts.yml references metrics the server does not emit: ${missing.join(', ')}`,
  )
})

test('a label VALUE a rule selects on is a label value the server emits', () => {
  // The name gate above stops at the metric name, so
  // `maplespire_backup_restore_databases{state="unrecognised"}` is checked as
  // far as the brace and no further. Renaming that label value leaves the rule
  // present, valid, listed in the Prometheus UI, and inactive forever.
  //
  // Resolved PER METRIC, not against one global bag of label values: a global
  // set would pass any rule that happened to reuse a string some unrelated
  // gauge emits.
  //
  // And only where the emission is a LITERAL. `maplespire_read_model_workspaces`
  // builds its labels from `Object.entries(statusCounts)` — the values are
  // database rows, unknowable from source — so it is skipped (and reported)
  // rather than guessed at. That is a known hole on the side of not failing.
  const skipped = []
  const missing = []
  for (const match of alertsSource.matchAll(/(maplespire_[a-z0-9_]+)\{([^}]*)\}/g)) {
    const [, metric, selector] = match
    // The sample block: from the name to the end of its `values:` array.
    const block = metricBlock(metric)
    if (block === null) continue // the name gate above owns this failure
    // `=~` as well as `=`, and the alternation inside it split into its
    // branches, so `{cause=~"released|aboveLive"}` is checked too.
    //
    // Negated matchers are deliberately not parsed: `!=` and `!~` assert that a
    // value is NOT emitted, and checking those against the emitted set inverts
    // the question. There are none today; if one appears, it is skipped rather
    // than mis-checked.
    for (const pair of selector.matchAll(/(\w+)\s*(=~|=)\s*"([^"]*)"/g)) {
      const [, key, operator, raw] = pair
      const literals = [...block.matchAll(new RegExp(`${key}:\\s*'([^']*)'`, 'g'))]
        .map((hit) => hit[1])
      if (literals.length === 0) { skipped.push(`${metric}{${key}}`); continue }
      // A regex matcher's branches are checked one by one. Anything that is not
      // a plain alternation of literal words is left alone: a real regex
      // (`released.*`, a character class) has no finite branch set to compare.
      const values = operator === '=~'
        ? (/^[\w|]+$/.test(raw) ? raw.split('|') : null)
        : [raw]
      if (values === null) { skipped.push(`${metric}{${key}=~}`); continue }
      for (const value of values) {
        if (!literals.includes(value)) missing.push(`${metric}{${key}="${value}"}`)
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `alert rules select on label values the server never emits: ${missing.join(', ')}`,
  )
  if (skipped.length > 0) {
    console.log(`note: label values not resolvable from source, unchecked: ${skipped.join(', ')}`)
  }
})

/**
 * The processes that serve `/metrics`.
 *
 * Each carries the form in which a builder reaches its endpoint, because they
 * differ. `index.ts` collects synchronously into an array, so the spread IS the
 * wire — a looser `${fn}(` rule there would accept `readRestoreDatabaseCensus(`
 * being called whether or not its samples are ever pushed. The other processes
 * hand a closure to `startMetricsListener`, so their wire is the listener call,
 * asserted separately below.
 */
const METRIC_ENTRYPOINTS = [
  { path: 'index.ts', wire: (fn) => `metrics.push(...${fn}(`, serves: "app.get('/metrics'" },
  { path: 'backup/drillScheduler.ts', wire: (fn) => `${fn}(`, serves: 'startMetricsListener(' },
  { path: 'syncCells/routerMain.ts', wire: (fn) => `${fn}(`, serves: 'startMetricsListener(' },
  { path: 'syncCells/placementProposerMain.ts', wire: (fn) => `${fn}(`, serves: 'startMetricsListener(' },
]

test('every metrics entrypoint actually serves an endpoint', () => {
  // The premise the gate below rests on. If `startMetricsListener(` is deleted
  // from the drill scheduler, every heartbeat gauge stops existing while the
  // module that defines them is still imported and still called — and the four
  // liveness rules go inactive with nothing red.
  for (const entrypoint of METRIC_ENTRYPOINTS) {
    const source = serverFiles.find((file) => file.path === entrypoint.path)?.source
    assert.ok(source, `${entrypoint.path} is not in server/src — this list is stale`)
    assert.ok(
      source.includes(entrypoint.serves),
      `${entrypoint.path} no longer serves metrics (looked for ${entrypoint.serves})`,
    )

    // ...and the witness has to be a witness: a `serves` string that every
    // file contains (e.g. `'const'`) would make this check unable to fail. The
    // listener's actual callers are pinned exactly.
    const carriers = serverFiles.filter((file) =>
      !file.path.endsWith('.test.ts') && file.source.includes(entrypoint.serves))
    if (entrypoint.serves === 'startMetricsListener(') assert.deepEqual(
      carriers.map(file => file.path).sort(), ['runtime/metricsListener.ts', 'backup/drillScheduler.ts',
        'syncCells/routerMain.ts', 'syncCells/placementProposerMain.ts'].sort())
    else assert.ok(
      carriers.length <= 3,
      `the "${entrypoint.serves}" witness appears in ${carriers.length} non-test files — `
      + 'it is too generic to prove anything about this one',
    )
  }
})

test('a metric name built from an unresolvable expression is reported', () => {
  // The parser resolves a literal and one level of `const X = 'maplespire_…'`.
  // Anything else — a template string, a concatenation — is invisible to every
  // gate in this file, and invisible is how a rule ends up permanently
  // inactive. Reported rather than enforced, because there is no such name
  // today and forbidding one pre-emptively would be a rule with no defect
  // behind it.
  if (unresolvedNameSites.length > 0) {
    console.log(`note: metric names not resolvable from source: ${unresolvedNameSites.join(', ')}`)
  }
  assert.ok(metricNameConstants.size > 0, 'no metric-name constants parsed — the parser is stale')
})

test('a metric defined outside an entrypoint is actually WIRED to one', () => {
  // The gate above proves a name EXISTS in source. It cannot tell that name
  // apart from one sitting in a builder function nobody calls — and a builder
  // nobody calls is a gauge that silently stopped existing, which is the exact
  // condition every rule in maplespire-backup was written to avoid.
  //
  // E.g. deleting `metrics.push(...restoreDatabaseCensusMetrics(census))` from
  // index.ts leaves the names in `backup/backupRestore.ts`, so the name gate
  // stays green; this one does not.
  //
  // Source text, the weak form. The strong version would boot the route and
  // scrape it, and nothing in this tree boots `index.ts`.
  const entrypointPaths = new Set(METRIC_ENTRYPOINTS.map((entry) => entry.path))
  const offenders = []
  const unwiredBuilders = []
  for (const file of serverFiles) {
    if (entrypointPaths.has(file.path)) continue
    // Resolved names, not a literal filter: naming a metric with a constant
    // must not make the whole file invisible here.
    if (!definesMetrics(file.source)) continue
    const exported = [...file.source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)]
      .map((match) => match[1])
    const wiredNames = new Set()
    for (const entry of METRIC_ENTRYPOINTS) {
      const entrySource = serverFiles.find((candidate) => candidate.path === entry.path)?.source ?? ''
      for (const name of exported) if (entrySource.includes(entry.wire(name))) wiredNames.add(name)
    }
    if (wiredNames.size === 0) offenders.push(file.path)
    // ...and then PER NAME, for the builders that say in their name what they
    // are. The check above is `.some()` over a file: a module exporting two
    // `*MetricSamples` builders with only ONE of them pushed reads as wired,
    // and the unpushed one is a set of series that silently never existed. The
    // convention is only applied where it is declared — an exported function
    // NOT named `*MetricSamples` may legitimately be a helper — so this cannot
    // fire on an ordinary export.
    for (const name of exported) {
      if (!/MetricSamples$/.test(name)) continue
      if (!wiredNames.has(name)) unwiredBuilders.push(`${file.path}: ${name}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these modules define maplespire_* metrics that no entrypoint wires up: ${offenders.join(', ')}`,
  )
  assert.deepEqual(
    unwiredBuilders,
    [],
    `these *MetricSamples builders are exported but pushed by no entrypoint: ${unwiredBuilders.join(', ')}`,
  )
})

test('the drill scheduler enters EVERY phase it can report, and closes its listener', () => {
  // Source text, the weak form; the strong version would boot `main()`, and
  // nothing in this tree boots it.
  //
  // A missing `enter(...)` can invert the signal rather than merely lose it:
  // without `enter('sleeping')` every healthy night wears the `running` budget
  // and pages, and without `enter('running')` a wedged six-hour drill wears the
  // 24 h sleep budget and never does.
  //
  // The phase list is PARSED from the union rather than written out, so adding
  // a phase and forgetting to enter it fails here instead of shipping a state
  // the loop can report and never leave.
  const heartbeatSource = serverFiles.find((file) => file.path === 'backup/schedulerHeartbeat.ts')?.source
  assert.ok(heartbeatSource, 'backup/schedulerHeartbeat.ts is gone — this gate is stale')
  const union = heartbeatSource.match(/export type SchedulerPhase =([^\n]*)/)?.[1] ?? ''
  const phases = [...union.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
  assert.ok(phases.length >= 4, `parsed ${phases.length} phases out of the union — the parser is stale`)

  // One phase is legitimately never entered: the INITIAL one, which the
  // constructor sets. Parsed rather than named here, so renaming it moves the
  // exemption with it — a hard-coded `'starting'` would quietly exempt whatever
  // string happened to keep that spelling.
  const initial = heartbeatSource.match(/let phase: SchedulerPhase = '([a-z_]+)'/)?.[1]
  assert.ok(initial, 'could not find the heartbeat\'s initial phase — the parser is stale')
  assert.ok(phases.includes(initial), `the initial phase ${initial} is not in the union`)

  const scheduler = serverFiles.find((file) => file.path === 'backup/drillScheduler.ts')?.source ?? ''
  const missing = phases
    .filter((phase) => phase !== initial)
    .filter((phase) => !scheduler.includes(`heartbeat.enter('${phase}')`))
  assert.deepEqual(missing, [], `the scheduler never enters: ${missing.join(', ')}`)

  // PRESENCE is not enough. The load-bearing property is the ORDER: swap
  // `enter('running')` and `enter('sleeping')` and both strings are still
  // present while the budgets are inverted.
  //
  // A structural remedy — a scope, `during('running', fn)`, so there is no
  // free-standing line to move — was not taken: it would reindent the whole
  // tick loop, the most safety-critical loop in this subsystem, for an
  // observability change.
  const at = (needle) => scheduler.indexOf(needle)
  assert.ok(at("heartbeat.enter('running')") < at('runDrillTick('),
    "enter('running') must precede the tick it names")
  assert.ok(at('runDrillTick(') < at("heartbeat.enter('sleeping')"),
    "enter('sleeping') must follow the tick, not precede it")
  assert.ok(at("heartbeat.enter('boot_sweep')") < at('sweepOrphanedRestoreDatabasesAtBoot('),
    "enter('boot_sweep') must precede the sweep")
  // The bind must precede `mkdir`: `phase="starting"` exists to cover a `mkdir` on a bundle volume
  // that never returns. Move the listener behind it and that window is silent
  // again, with every other gate green.
  assert.ok(at('startMetricsListener(') < at('await mkdir(bundleRoot'),
    'the listener must bind BEFORE mkdir, or the starting phase covers nothing')

  // The token, because without it the endpoint 404s and `up` reads 0 forever —
  // the same value a dead container produces, on a deployment where nothing is
  // wrong.
  assert.match(scheduler, /token:\s*env\.METRICS_TOKEN/)

  // ...and the COLLECTOR. `collect: () => []` empties the exposition, every
  // gauge vanishes and both the wedge and restart rules become structurally
  // unable to fire — while the "an entrypoint wires it up" gate above stays
  // green, because it only asks that SOME export of the module be called and
  // `createSchedulerHeartbeat(` still is.
  assert.match(
    scheduler,
    /collect:\s*\(\)\s*=>\s*heartbeat\.samples\(\)/,
    'the listener must collect from the heartbeat, not from a literal',
  )

  // And the close. It does NOT prevent a hang on exit — that guarantee is the
  // socket unref in `metricsListener.ts` (`qa/metricsListenerExit.mts` never
  // calls `stop()` and exits 0). What the line buys is that `up == 0` becomes
  // true when the scheduler is done rather than whenever the process finally
  // goes.
  assert.match(scheduler, /await metrics\?\.stop\(\)/)
})

test('the router triad retains its severity, windows and positive/negative fixtures', () => {
  for (const [name, severity, window] of [
    ['SyncRouterDown', 'page', '2m'],
    ['SyncRouterNotScraped', 'page', '2m'],
    ['SyncRouterTopologyPending', 'ticket', '5m'],
  ]) {
    const block = alertsSource.split(`- alert: ${name}\n`)[1]?.split('- alert:')[0] ?? ''
    assert.match(block, new RegExp(`severity: ${severity}[ \\t]*$`, 'm'))
    assert.match(block, new RegExp(`for: ${window}[ \\t]*$`, 'm'))
    assert.ok(fixtureSource.includes(`alertname="${name}", alertstate="firing"`), `${name} must be proven to fire`)
    assert.match(fixtureSource, new RegExp(`alertname: ${name}\\n[ \\t]+exp_alerts: \\[\\]`), `${name} must be proven silent`)
  }
})

test('cell ownership and critical Redis alerts retain severity, windows and both fixture directions', () => {
  for (const [name, severity, window] of [
    ['SyncCellCoverageGap', 'page', '2m'],
    ['SyncCellPartitionLoss', 'ticket', '2m'],
    ['SyncCellWorkspaceLoss', 'ticket', '2m'],
    ['SyncCellFenceRejections', 'ticket', '2m'],
    ['SyncCellForeignProjector', 'page', '2m'],
    ['RedisMemoryNearLimit', 'page', '5m'],
  ]) {
    const block = alertsSource.split(`- alert: ${name}\n`)[1]?.split('- alert:')[0] ?? ''
    assert.match(block, new RegExp(`severity: ${severity}[ \\t]*$`, 'm'))
    assert.match(block, new RegExp(`for: ${window}[ \\t]*$`, 'm'))
    assert.ok(fixtureSource.includes(`alertname="${name}", alertstate="firing"`), `${name} must be proven to fire`)
    assert.match(fixtureSource, new RegExp(`alertname: ${name}\\n[ \\t]+exp_alerts: \\[\\]`), `${name} must be proven silent`)
  }
})

test('a rule that selects on a job selects on a job prometheus.yml defines', () => {
  // `up{job="backup-drill"}` is the only series in the backup group that
  // Prometheus generates rather than the drill emitting — which is what makes
  // it trustworthy, and also what puts it outside every other gate in this
  // file: the metric-name check knows nothing about `up`.
  //
  // Rename the job in prometheus.yml and three rules stay present, valid,
  // listed in the UI, and inactive forever.
  const jobs = new Set(
    [...prometheusSource.matchAll(/^\s*-?\s*job_name:\s*['"]?([\w.-]+)['"]?\s*$/gm)]
      .map((match) => match[1]),
  )
  assert.ok(jobs.size >= 2, 'no scrape jobs parsed out of prometheus.yml — the parser is stale')

  const selected = new Set(
    [...alertsSource.matchAll(/job\s*=\s*"([^"]+)"/g)].map((match) => match[1]),
  )
  assert.ok(selected.size > 0, 'no job selectors found in alerts.yml — the parser is stale')
  const missing = [...selected].filter((job) => !jobs.has(job))
  assert.deepEqual(missing, [], `alert rules select on jobs prometheus.yml does not scrape: ${missing.join(', ')}`)
})

test('the drill container has a liveness rule and a rule for its absence', () => {
  // The same pairing BackupDrillStale/BackupDrillNeverPassed needs, for the
  // same reason: `up{job=…} == 0` requires a target to be about, so deleting
  // the scrape job silences it in the direction a healthy deployment also
  // silences it. `absent()` is what can tell those apart.
  // Anchored to the END of the line, every one of them: `/alert: X/` would
  // also match `alert: XSuffix`, i.e. a renamed rule.
  assert.match(alertsSource, /alert: BackupDrillContainerDown[ \t]*\r?$/m)
  assert.match(alertsSource, /alert: BackupDrillNotScraped[ \t]*\r?$/m)
  assert.match(
    alertsSource,
    /absent\(up\{job="backup-drill"\}\)/,
    'the not-scraped rule must handle the absent case',
  )

  // And the wedge rule, which is the half `up` cannot see: a loop stuck on an
  // await that never settles keeps answering scrapes in 1-2 ms. Measured.
  assert.match(alertsSource, /alert: BackupDrillSchedulerWedged[ \t]*\r?$/m)
  assert.match(alertsSource, /alert: BackupDrillRestarting[ \t]*\r?$/m)
  assert.match(alertsSource, /alert: BackupDrillHeartbeatMissing[ \t]*\r?$/m)

  // The crash-loop rule must use a RANGE function, never a threshold behind a
  // `for:` window. Prometheus marks a target's series stale on a failed scrape,
  // which ends the pending period — and a crash loop is made of failed scrapes,
  // so `uptime_seconds < 600 for: 30m` could never fire on a crash loop. The
  // same failed scrape resets `BackupDrillContainerDown` too.
  assert.match(
    alertsSource,
    /changes\(maplespire_backup_drill_scheduler_start_time_seconds\[\d+m\]\)/,
    'the restart rule must count changes over a range, not compare an uptime',
  )
  assert.doesNotMatch(
    alertsSource,
    /maplespire_backup_drill_scheduler_uptime_seconds/,
    'the uptime gauge was replaced by a start-time stamp; a rule on it cannot fire',
  )

  // The THRESHOLDS and the SEVERITIES, which no parse check can see.
  //
  // `> 2` is deliberate: a single rolling deploy is one change, so `> 0` would
  // page on every deploy — and an alert that cries wolf stops being read.
  assert.match(
    alertsSource,
    /changes\(maplespire_backup_drill_scheduler_start_time_seconds\[30m\]\) > 2[ \t]*\r?$/m,
    'the restart rule must keep its 30m range and its > 2 threshold',
  )
  // `and on()` with the empty label list. `absent()` returns a vector carrying
  // only its selector's matchers — no `job`, no `instance` — so a plain `and`
  // matches nothing and the rule becomes the silent thing it was written to
  // catch. promtool parses both, so only this can tell them apart.
  assert.match(
    alertsSource,
    /absent\(maplespire_backup_drill_scheduler_start_time_seconds\)\s*\n\s*and on\(\) \(up\{job="backup-drill"\} == 1\)/,
    'the heartbeat-missing rule needs `and on()`; a bare `and` joins on labels absent() does not carry',
  )
  // A `page` demoted to `ticket` silences the rules this whole section adds,
  // and the file-wide severity check accepts either word.
  for (const [rule, severity] of [
    ['BackupDrillContainerDown', 'page'],
    ['BackupDrillRestarting', 'page'],
    ['BackupDrillSchedulerWedged', 'page'],
    ['BackupDrillNotScraped', 'ticket'],
    ['BackupDrillHeartbeatMissing', 'ticket'],
  ]) {
    const block = alertsSource.split(`- alert: ${rule}\n`)[1]?.split('- alert:')[0] ?? ''
    assert.match(
      block,
      new RegExp(`severity: ${severity}[ \\t]*\r?$`, 'm'),
      `${rule} must stay severity: ${severity}`,
    )
  }

  // The rules ARE parsed by promtool (below); the old claim must not return.
  assert.doesNotMatch(
    alertsSource,
    /no promtool in the toolchain/i,
    'promtool now parses every expression here; that claim was removed once already',
  )
  assert.match(
    alertsSource,
    /maplespire_backup_drill_scheduler_phase_age_seconds\s*\n?\s*>\s*maplespire_backup_drill_scheduler_phase_budget_seconds/,
    'the wedge rule must compare the age against the EXPORTED budget, never a literal',
  )
})

/**
 * promtool, run from `prom/prometheus:v3.1.0` — the image the rules run under,
 * already used by the compose stack, which ships `/bin/promtool`.
 *
 * TWO gates, and the second is the one that matters.
 *
 * `check rules` parses every expression, so it catches an unbalanced paren, a
 * misspelled function, a bad duration, a malformed label matcher and a template
 * that will not render. What it cannot do is tell a rule that is VALID from one
 * that is valid and MATCHES NOTHING — which is every silent-failure story in
 * this tree.
 *
 * `test rules` closes that: `infra/monitoring/alerts.test.yml` runs the rules
 * through the real engine against fixture series, so the assertions are about
 * what an alert DOES — including `and on()` vs `and`, which both parse.
 *
 * What is still uncovered: only the rules the fixtures name. A new rule is
 * parsed but not exercised unless somebody adds a case; the `covered` list
 * below pins the existing ones.
 *
 * The availability check asks for DOCKER, never for the image: a machine that
 * had not pulled the image must not silently pass. `docker run` pulls what it
 * needs.
 *
 * And the absence is a real `t.skip()`, not an early `return`. `ci:local`
 * already requires Docker, so this never fires there or in CI — but where it
 * does, it surfaces as `# skipped 1` and `run-harness-suites.mjs` fails the
 * suite: a skip is a failure, not a pass.
 */
async function dockerAvailable() {
  try {
    await exec('docker', ['--version'])
    return true
  } catch {
    return false
  }
}

test('every alert expression parses — checked by the promtool that runs them', async (t) => {
  if (!await dockerAvailable()) {
    t.skip('docker is not on this machine; the alert expressions were NOT parsed')
    return
  }
  const alertsPath = fileURLToPath(new URL('../infra/monitoring/alerts.yml', import.meta.url))
  const run = (file) => exec('docker', [
    'run', '--rm', '--entrypoint', '/bin/promtool',
    '-v', `${file}:/tmp/rules.yml:ro`,
    'prom/prometheus:v3.1.0', 'check', 'rules', '/tmp/rules.yml',
  ])

  const { stdout } = await run(alertsPath)
  const found = Number(stdout.match(/SUCCESS: (\d+) rules found/)?.[1] ?? -1)
  // The COUNT, not just the word SUCCESS: `SUCCESS: 0 rules found` is what an
  // empty or mis-mounted file produces.
  const declared = [...alertsSource.matchAll(/^[ \t]+- alert: /gm)].length
  assert.equal(
    found,
    declared,
    `promtool parsed ${found} rules but alerts.yml declares ${declared}:\n${stdout}`,
  )

  // The CONTROL. Without it a green run says promtool RAN, never that it
  // AGREED — and a container that silently no-ops (wrong entrypoint, a mount
  // that landed empty) would report success on nothing at all.
  const broken = fileURLToPath(new URL('./fixtures/promtool-must-fail.yml', import.meta.url))
  let rejected = null
  try {
    await run(broken)
  } catch (error) {
    rejected = error
  }
  assert.ok(rejected, 'promtool ACCEPTED a rules file with a syntax error — the check is inert')
  // stderr, not stdout. promtool prints "Checking <file>" to stdout and the
  // FAILED lines to stderr, so a predicate reading stdout alone reports "it
  // accepted the broken file" about a run that rejected it correctly — a wrong
  // conclusion in the direction that looks like a caught defect. Both streams.
  const said = `${rejected.stdout ?? ''}${rejected.stderr ?? ''}`
  assert.match(
    said,
    /unclosed left parenthesis/,
    `promtool rejected the control for the wrong reason:\n${said}`,
  )
  assert.match(said, /unknown function with name "chagnes"/, `unexpected control output:\n${said}`)
})

test('every alert rule BEHAVES — the rules run against fixture series', async (t) => {
  if (!await dockerAvailable()) {
    t.skip('docker is not on this machine; the alert rules were NOT evaluated')
    return
  }
  const monitoring = fileURLToPath(new URL('../infra/monitoring/', import.meta.url))
  const control = fileURLToPath(new URL('./fixtures/promtool-testrules-must-fail.yml', import.meta.url))

  // The two files are mounted INDIVIDUALLY into one container directory rather
  // than mounting `infra/monitoring` whole: `rule_files` resolves relative to
  // the test file, so they must share a directory — and that directory also
  // holds `metrics-token`, which has no business inside a throwaway container.
  const run = (testFile) => exec('docker', [
    'run', '--rm', '--entrypoint', '/bin/promtool',
    '-v', `${monitoring}alerts.yml:/tmp/m/alerts.yml:ro`,
    '-v', `${testFile}:/tmp/m/suite.test.yml:ro`,
    'prom/prometheus:v3.1.0', 'test', 'rules', '/tmp/m/suite.test.yml',
  ])

  const { stdout } = await run(`${monitoring}alerts.test.yml`)
  assert.match(stdout, /SUCCESS/, `the alert fixtures failed:\n${stdout}`)

  // A COVERAGE FLOOR, because `SUCCESS` alone is not evidence that anything ran.
  // Measured: a fixture file containing `tests: []` prints `SUCCESS` and exits
  // 0 — the same inert-on-empty shape that made the parse gate above assert a
  // rule COUNT rather than the word SUCCESS.
  const cases = [...fixtureSource.matchAll(/^  - interval: /gm)].length
  assert.ok(cases >= 15, `alerts.test.yml declares only ${cases} cases — it has been gutted`)

  // ...and every rule the fixtures are credited with must still be named by
  // one. Deleting a case is exactly as silent as emptying the file.
  const covered = [
    'BackupDrillContainerDown', 'BackupDrillRestarting', 'BackupDrillHeartbeatMissing',
    'BackupDrillSchedulerWedged', 'BackupDrillNotScraped',
    'BackupDrillStale', 'BackupDrillNeverPassed',
    'SyncCellFenceUnrepairable', 'SyncCellForeignFenceOwner', 'SyncCellFenceDetectorBlind',
    'SyncCellCrossGenerationRefusal', 'SyncCellSupersededGeneration',
    // Every covered rule is NAMED here: the case-count floor above has slack,
    // so a whole fixture group could otherwise be deleted unnoticed.
    'RedisDown', 'RedisExporterDown', 'RedisNotScraped', 'RedisPersistenceEnabled',
    'SyncRouterDown', 'SyncRouterNotScraped', 'SyncRouterTopologyPending',
    'SyncCellCoverageGap', 'SyncCellPartitionLoss', 'SyncCellWorkspaceLoss',
    'SyncCellFenceRejections', 'SyncCellForeignProjector', 'RedisMemoryNearLimit',
    'PlacementProposerSignalUnknown', 'PlacementProposerDown', 'PlacementProposerMetricsMissing',
    'AlertmanagerEmailDeliveryFailed',
  ]
  const uncovered = covered.filter((name) => !fixtureSource.includes(name))
  assert.deepEqual(uncovered, [], `alerts.test.yml no longer exercises: ${uncovered.join(', ')}`)

  // ...and NAMED is not PROVEN TO FIRE. The line above is a substring check,
  // and a purely negative `exp_alerts: []` arm satisfies it, so a rule could be
  // "covered" by fixtures that only ever assert it stays silent.
  const neverProvenToFire = covered.filter(
    (name) => !fixtureSource.includes(`alertname="${name}", alertstate="firing"`),
  )
  assert.deepEqual(
    neverProvenToFire,
    [],
    `these rules have fixtures but none that proves they FIRE: ${neverProvenToFire.join(', ')}`,
  )

  // The CONTROL, and it is a DIFFERENT kind of wrong from the parse-level one:
  // every rule in it loads and every expression is valid, only the
  // EXPECTATIONS are false. That is exactly the failure mode `test rules`
  // exists to catch and `check rules` cannot see, so a control that merely had
  // a syntax error would prove the wrong thing.
  let rejected = null
  try {
    await run(control)
  } catch (error) {
    rejected = error
  }
  assert.ok(rejected, 'promtool ACCEPTED a fixture file whose expectations are false — the gate is inert')
  const said = `${rejected.stdout ?? ''}${rejected.stderr ?? ''}`
  assert.match(said, /FAILED/, `the control was refused for the wrong reason:\n${said}`)
  // BOTH directions, because a gate that notices only "expected an alert and
  // got none" is blind to the commoner "expected none and got one".
  //
  // The two are asserted with DIFFERENT patterns because promtool reports them
  // differently: a `promql_expr_test` failure prints the expression and
  // `got: nil` and NO test name, while an `alert_rule_test` failure prints
  // `name:`.
  assert.match(said, /got: nil/, `the "expected an alert, got none" arm did not fail:\n${said}`)
  assert.match(
    said,
    /this expectation is false in the other direction/,
    `the "expected none, got one" arm did not fail:\n${said}`,
  )
})

test('every alert rule carries a severity and a summary', () => {
  // A rule without a severity cannot be routed, and one without a summary
  // arrives as a bare expression at 3am.
  const rules = alertsSource.split(/^\s+- alert: /m).slice(1)
  assert.ok(rules.length >= 5, 'expected the alert rules to still be there')
  for (const rule of rules) {
    const name = rule.split('\n', 1)[0].trim()
    // Watchdog breaks both conventions ON PURPOSE, and is carved out BY NAME
    // rather than by loosening the regex for everybody: it carries
    // `severity: watchdog` because nobody acts on its ARRIVAL (routing it as
    // page or ticket pages on every restart, and a channel that cries wolf
    // stops being read), and it carries
    // no `for:` because a watchdog has to be firing at the first evaluation
    // after a restart. A `for` window is a stretch of time during which the
    // dashboard reports the rule engine dead while it is merely young: a
    // false alarm on the one signal whose whole job is to be believed.
    //
    // The carve-out costs no coverage. Its shape is pinned by its own test
    // below, which also fails if a SECOND rule adopts `severity: watchdog` --
    // that would be a real alert wearing the one label documented as never
    // routed, i.e. an alert deliberately made unroutable.
    if (name === 'Watchdog') continue
    assert.match(rule, /severity: (page|ticket)/, `${name} has no routable severity`)
    assert.match(rule, /summary:/, `${name} has no summary`)
    if (name === 'PlacementProposerSignalUnknown') {
      assert.doesNotMatch(rule, /\n\s+for:/, 'unknown age already carries the continuous fifteen-minute window')
      assert.match(rule, /unknown_age_seconds\{job="placement-proposer"\} > 900\)/)
    } else if (name === 'AlertmanagerEmailDeliveryFailed') {
      assert.doesNotMatch(rule, /\n\s+for:/, 'an explicit delivery failure has no second grace period')
      assert.match(rule, /alertmanager_notification_requests_failed_total/)
    } else assert.match(rule, /\n\s+for: /, `${name} has no "for" window — one bad scrape would fire it`)
  }
})

test('the drill freshness alert is paired with a never-passed alert', () => {
  // NaN fails every `>` comparison, so a threshold rule alone is SILENT on a
  // deployment whose drill has never succeeded — the worst case. These two must
  // ship together; deleting either leaves a hole that looks covered.
  assert.match(alertsSource, /alert: BackupDrillStale/)
  assert.match(alertsSource, /alert: BackupDrillNeverPassed/)
  assert.match(
    alertsSource,
    /absent\(maplespire_backup_drill_last_success_age_seconds\)/,
    'the never-passed rule must handle the absent case',
  )
})

test('metrics are reported when no rule watches them', () => {
  // Informational, not a failure: a gauge can legitimately be dashboard-only.
  const unwatched = [...emitted].filter((name) => !referenced.has(name))
  if (unwatched.length > 0) {
    console.log(`note: no alert rule references ${unwatched.join(', ')}`)
  }
  assert.ok(true)
})

/* ------------------------------------------------------------------------
 * The Grafana dashboard, held to the same standard as the rules.
 *
 * A panel that queries a metric nothing emits renders "No data" forever, which
 * is the calmest possible way to be broken: no error, no red, just an empty
 * graph that a reader interprets as "nothing is happening".
 * ---------------------------------------------------------------------- */

const dashboardSource = await readFile(
  new URL('../infra/monitoring/grafana/dashboards/maplespire-sante.json', import.meta.url),
  'utf8',
)
const dashboard = JSON.parse(dashboardSource)

test('delivery panels distinguish no attempts, failed sends and unavailable telemetry', async (t) => {
  if (!await dockerAvailable()) {
    t.skip('docker is not available; delivery panel expressions were NOT evaluated')
    return
  }
  // Execute the shipped expressions, not copies. In particular, a stale zero
  // from an unavailable Alertmanager must not be presented as zero failures.
  const expressions = [32, 33, 34, 35, 37, 38, 39].map(id => {
    const expression = dashboard.panels.find(panel => panel.id === id)?.targets?.[0]?.expr
    assert.ok(expression, `missing delivery panel ${id}`)
    return expression
  })
  const cases = [
    { name: 'unconfigured', series: [], values: [null, 0, null, null, null, null, null] },
    { name: 'healthy but never sent', up: 1, attempts: 0, failures: 0, values: [1, 1, 0, 0, 0, 0, 0] },
    { name: 'failed sends', up: 1, attempts: 6, failures: 2, values: [1, 1, 6, 2, 12, 1, 3] },
    { name: 'stale counters after failed scrape', up: 0, attempts: 6, failures: 2, values: [1, 0, null, null, null, null, null] },
    { name: 'scraped endpoint without delivery counters', up: 1, values: [1, 1, null, null, null, null, null] },
    { name: 'failed Prometheus self scrape', up: 1, self: 0, attempts: 0, failures: 0, values: [null, 1, 0, 0, 0, 0, 0] },
  ]
  const fixture = {
    rule_files: [], evaluation_interval: '1m',
    tests: cases.map(c => ({
      name: c.name, interval: '1m',
      input_series: c.series ?? [
        { series: 'up{job="alertmanager",instance="alertmanager:9093"}', values: String(c.up) },
        { series: 'up{job="prometheus",instance="127.0.0.1:9090"}', values: String(c.self ?? 1) },
        { series: 'prometheus_notifications_alertmanagers_discovered{job="prometheus"}', values: '1' },
        ...(c.attempts === undefined ? [] : [{ series: 'alertmanager_notifications_total{job="alertmanager",integration="email"}', values: String(c.attempts) }]),
        ...(c.failures === undefined ? [] : [
          { series: 'alertmanager_notifications_failed_total{job="alertmanager",integration="email",reason="authError"}', values: String(c.failures) },
          { series: 'alertmanager_notifications_failed_total{job="alertmanager",integration="email",reason="other"}', values: '0' },
          { series: 'alertmanager_notification_requests_total{job="alertmanager",integration="sns"}', values: String(c.attempts * 2) },
          { series: 'alertmanager_notification_requests_failed_total{job="alertmanager",integration="sns"}', values: String(c.failures / 2) },
          { series: 'alertmanager_notification_requests_failed_total{job="alertmanager",integration="email"}', values: String(c.failures * 1.5) },
        ]),
      ],
      promql_expr_test: expressions.map((expr, i) => ({
        expr, eval_time: '0m', exp_samples: c.values[i] === null ? [] : [{ labels: '{}', value: c.values[i] }],
      })),
    })),
  }
  const directory = await mkdtemp(join(tmpdir(), 'maplespire-delivery-panels-'))
  const file = join(directory, 'panels.json')
  try {
    await writeFile(file, JSON.stringify(fixture))
    const { stdout } = await exec('docker', ['run', '--rm', '--entrypoint', '/bin/promtool',
      '-v', `${file}:/tmp/panels.json:ro`, 'prom/prometheus:v3.1.0', 'test', 'rules', '/tmp/panels.json'])
    assert.match(stdout, /SUCCESS/, stdout)
  } finally {
    await rm(file, { force: true })
    await rmdir(directory)
  }
})
const datasourceSource = await readFile(
  new URL('../infra/monitoring/grafana/provisioning/datasources/prometheus.yml', import.meta.url),
  'utf8',
)

/** Every panel that is not a row header, and every target under it. */
const contentPanels = dashboard.panels.filter((panel) => panel.type !== 'row')
const targets = contentPanels.flatMap((panel) => panel.targets ?? [])

test('the Watchdog rule exists and is a constant, not an alert in disguise', () => {
  // The whole value of a watchdog is that it CANNOT be silenced by the system
  // it watches. `vector(1)` has no inputs; anything that reads a series could
  // stop firing for a reason that is not "the engine stopped", and the panel
  // would then report a lie in the safe-looking direction.
  // `\r?` on both line anchors, here and below: on a Windows CRLF checkout a
  // regex that pins a line ENDING (rather than `\s`, which absorbs the `\r`)
  // would otherwise fail.
  assert.match(alertsSource, /- alert: Watchdog\r?\n\s+expr: vector\(1\)/)

  // Exactly one rule may carry it. A second `severity: watchdog` would be a
  // real alert wearing the one label documented as "never routed".
  //
  // Anchored to a whole LINE: a bare `/severity: watchdog/` also counts the
  // mentions inside the comment block that explains the label.
  const watchdogLabels = [...alertsSource.matchAll(/^[ \t]+severity: watchdog[ \t]*\r?$/gm)]
  assert.equal(watchdogLabels.length, 1, 'severity: watchdog must name exactly one rule')
})

test('the dashboard queries only metrics the server emits', () => {
  // What this CANNOT see: it compares the dashboard against the SOURCE in this
  // tree, not against the build that is running. A deployment built from an
  // older commit can show "No data" on panels for metrics added since.
  //
  // So a green run here means "no typo and no rename", never "the deployment
  // will show data". Only a query against the running Prometheus can say that.
  const used = new Set(
    [...dashboardSource.matchAll(/\b(maplespire_[a-z0-9_]+)\b/g)].map((match) => match[1]),
  )
  assert.ok(used.size > 5, 'no metrics parsed out of the dashboard — the parser is stale')
  const missing = [...used].filter((name) => !emitted.has(name))
  assert.deepEqual(missing, [], `the dashboard queries metrics the server does not emit: ${missing.join(', ')}`)
})

test('every panel points at the provisioned data source UID', () => {
  // Grafana mints a random UID when the provisioning file does not pin one, and
  // a panel whose UID has no match renders "Datasource not found". That reads
  // as a broken dashboard rather than as a broken deployment, so it gets
  // rediscovered by whoever next opens the page rather than by a test.
  const pinned = datasourceSource.match(/^\s*uid:\s*(\S+)\s*$/m)?.[1]
  assert.ok(pinned, 'the provisioned data source must pin a uid')

  const uids = new Set(
    [...dashboardSource.matchAll(/"uid":\s*"([^"]+)"/g)]
      .map((match) => match[1])
      // The dashboard's own uid is not a datasource reference.
      .filter((uid) => uid !== dashboard.uid),
  )
  assert.deepEqual([...uids], [pinned], `panels reference data source uids other than ${pinned}`)

  // And every target must carry one: a target with no datasource inherits the
  // panel's, which inherits the org default -- so it works until somebody adds
  // a second data source, and then it silently queries the wrong one.
  for (const target of targets) {
    assert.equal(target.datasource?.uid, pinned, `target ${target.refId} has no pinned data source`)
  }
})

test('the dashboard surfaces the watchdog and the firing-alert list', () => {
  // These two panels are the reason this dashboard exists at all: one says
  // whether the rule engine is alive, the other shows a firing alert on its
  // first night. Losing either in a refactor leaves a page that still looks
  // complete.
  const exprs = targets.map((target) => target.expr ?? '').join('\n')
  assert.match(exprs, /ALERTS\{alertname="Watchdog", alertstate="firing"\}/)
  assert.match(exprs, /ALERTS_FOR_STATE/, 'the firing list must show how long each alert has been firing')
  assert.match(exprs, /ALERTS\{alertstate="firing"/)
})

test('every panel explains what it means, not just what it plots', () => {
  // A number nobody can interpret is a number nobody acts on. Several of these
  // gauges are actively counter-intuitive -- NaN means "never", `clean` means
  // "not measured", a flat zero can mean "the detector never ran" -- and the
  // panel description is the only place that fits.
  for (const panel of contentPanels) {
    if (panel.type === 'text') continue
    assert.ok(
      typeof panel.description === 'string' && panel.description.length > 60,
      `panel "${panel.title}" has no description`,
    )
  }
})

/** Metrics the server can emit as NaN, derived rather than listed.
 *
 * `renderPrometheus` writes a literal `NaN` for "never happened", deliberately:
 * a zero would read as "a drill just passed" on an installation that has never
 * run one. Everything downstream has to survive that, and the ways it does not
 * are silent.
 *
 * Derived by taking each `name: 'maplespire_…'` and the text up to the NEXT
 * such name — that window is the metric's own `values` array. A hand-kept list
 * would rot the first time somebody adds a gauge.
 */
const nanCapable = (() => {
  const found = new Set()
  for (const site of emittedSites) {
    // No cap here: a metric's whole `values` array is the window, and the last
    // one in the source legitimately runs to the end of it.
    if (metricBlock(site.name, Number.POSITIVE_INFINITY)?.includes('Number.NaN')) found.add(site.name)
  }
  return found
})()

test('a NaN gauge cannot render as a healthy panel', () => {
  // MEASURED against a live stack: Prometheus serves the string "NaN"; the
  // Grafana Prometheus datasource converts it to `null` before any panel
  // option is applied. So:
  //
  //   - a `special` mapping matching "nan" NEVER fires, and
  //   - the `lastNotNull` reducer then discards the value entirely, leaving no
  //     value to map at all, so the panel falls through to the BASE threshold.
  //
  // The base threshold on an age panel is green: an empty GREEN box on a
  // deployment where no backup drill has ever passed.
  //
  // `null+nan` covers both the value Grafana produces today and the one the
  // wire carries, so this survives a datasource that stops converting.
  assert.ok(nanCapable.size >= 4, 'the NaN-capable derivation found almost nothing — the parser is stale')

  for (const panel of contentPanels) {
    const exprs = (panel.targets ?? []).map((target) => target.expr ?? '').join(' ')
    const metrics = [...exprs.matchAll(/\b(maplespire_[a-z0-9_]+)\b/g)].map((match) => match[1])
    if (!metrics.some((name) => nanCapable.has(name))) continue

    // A timeseries renders NaN as a GAP, which is honest: the line stops where
    // the data stops. Only single-value panels need the mapping.
    if (panel.type !== 'stat') continue

    const mappings = JSON.stringify(panel.fieldConfig?.defaults?.mappings ?? [])
    assert.match(
      mappings,
      /"match":\s*"null\+nan"/,
      `"${panel.title}" reads a NaN-capable metric with no null+nan mapping — it will render blank on the "never" case`,
    )
    assert.deepEqual(
      panel.options?.reduceOptions?.calcs,
      ['last'],
      `"${panel.title}" must reduce with "last": "lastNotNull" drops the null and the mapping never runs`,
    )
  }
})
