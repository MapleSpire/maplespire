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
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'
import {
  POSTURE_VARIABLES, readRuntimePostures, postureChoice, resolveShippedPosture,
  shippedOverrides, benchDefaultOverrides, resolvedBenchPosture, inspectRunningPosture,
} from '../server/scripts/sync-bench-posture.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fields = {
  SYNC_CELL_PARTITION_WORKER: ['ownership', 'partitionWorker'],
  SYNC_CELL_PARTITION_LEASE_TTL_MS: ['ownership', 'partitionLeaseTtlMs'],
  SYNC_CELL_PARTITION_RENEW_INTERVAL_MS: ['ownership', 'partitionRenewIntervalMs'],
  REDIS_COMMAND_TIMEOUT_MS: ['redis', 'commandTimeoutMs'],
  SYNC_CELL_RECONCILE_INTERVAL_MS: ['ownership', 'reconcileIntervalMs'],
  SYNC_CELL_TELEMETRY_INTERVAL_MS: ['ownership', 'telemetryIntervalMs'],
  REDIS_RENDER_CACHE_COMMAND_TIMEOUT_MS: ['render', 'commandTimeoutMs'],
  SYNC_CELL_ADMISSION_CONCURRENCY: ['ownership', 'admissionConcurrency'],
  SYNC_CELL_OWNERSHIP_CONCURRENCY: ['ownership', 'concurrency'],
}
const required = Object.keys(fields).slice(0, 5)

// Static declaration reader for the named environment anchors, not a Compose
// deployment resolver. Reject ambiguous entries rather than inheriting a value
// from a different service. Only the selected posture variables are evaluated.
function environmentAnchor(source, key) {
  const lines = source.split(/\r?\n/)
  const starts = lines.flatMap((line, index) => line.startsWith(key + ':') ? [index] : [])
  assert.equal(starts.length, 1, `expected exactly one ${key} declaration`)
  const environment = {}
  for (const line of lines.slice(starts[0] + 1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (/^\S/.test(line)) break
    const entry = /^  ([A-Z][A-Z0-9_]*):\s*(.*?)\s*$/.exec(line)
    assert.ok(entry, `${key}: unsupported environment entry`)
    assert.equal(Object.hasOwn(environment, entry[1]), false, `${key}: duplicate ${entry[1]}`)
    environment[entry[1]] = entry[2]
  }
  return environment
}

function literalDefault(raw, key) {
  if (raw === undefined) return undefined
  let value = raw.trim()
  if (value.startsWith('"')) value = JSON.parse(value)
  else if (value.startsWith("'")) {
    assert.match(value, /^'[^']*'$/, `${key}: unsupported quoted value`)
    value = value.slice(1, -1)
  }
  const substitution = /^\$\{[A-Z][A-Z0-9_]*(?::-|-)([^{}]*)\}$/.exec(value)
  if (substitution) value = substitution[1]
  assert.match(value, /^(?:on|off|\d+)?$/, `${key}: posture default is unresolved`)
  return value
}

const benchAnchor = environmentAnchor(readFileSync(resolve(root, 'infra/compose/sync-cell-failover.yml'), 'utf8'), 'x-sync-environment')
const shippedAnchor = environmentAnchor(readFileSync(resolve(root, 'compose.maplespire.yml'), 'utf8'), 'x-api-environment')
const select = anchor => Object.fromEntries(Object.keys(fields).flatMap(key => {
  const value = literalDefault(anchor[key], key)
  return value === undefined ? [] : [[key, value]]
}))
const explicit = {
  SYNC_CELL_PARTITION_WORKER: 'on',
  SYNC_CELL_PARTITION_LEASE_TTL_MS: '2000',
  SYNC_CELL_PARTITION_RENEW_INTERVAL_MS: '300',
  REDIS_COMMAND_TIMEOUT_MS: '900',
  SYNC_CELL_RECONCILE_INTERVAL_MS: '2000',
  SYNC_CELL_TELEMETRY_INTERVAL_MS: '7000',
  REDIS_RENDER_CACHE_COMMAND_TIMEOUT_MS: '800',
  SYNC_CELL_ADMISSION_CONCURRENCY: '5',
  SYNC_CELL_OWNERSHIP_CONCURRENCY: '7',
}

// Execute the actual parsers with explicit environments. No daemon is used,
// no .env is loaded, and secrets/NODE_OPTIONS from the caller are not inherited.
// The child is bounded even if a future imported module starts keeping handles.
const childSource = `
import { syncCellOwnershipConfig } from './src/syncCells/ownership.ts'
import { redisRuntimeConfig, redisRenderCacheRuntimeConfig } from './src/runtime/redis.ts'
const { environments, fields } = JSON.parse(process.argv[1])
const results = Object.fromEntries(Object.entries(environments).map(([name, env]) => {
  const configs = { ownership: syncCellOwnershipConfig(env), redis: redisRuntimeConfig(env), render: redisRenderCacheRuntimeConfig(env) }
  const values = Object.fromEntries(Object.entries(fields).map(([key, [family, field]]) => {
    const value = configs[family][field]
    return [key, typeof value === 'boolean' ? (value ? 'on' : 'off') : value]
  }))
  return [name, { values, derivedLeaseCommandTimeoutMs: configs.ownership.leaseCommandTimeoutMs }]
}))
process.stdout.write('T_POST_CONFIG=' + JSON.stringify(results) + '\\n')
process.exit(0)
`
const childEnvironment = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'HOME'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource,
  JSON.stringify({ environments: { bench: select(benchAnchor), shipped: select(shippedAnchor), empty: {}, explicit }, fields })],
{ cwd: resolve(root, 'server'), env: childEnvironment, timeout: 15_000, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 })
const configLines = output.split(/\r?\n/).filter(line => line.startsWith('T_POST_CONFIG='))
assert.equal(configLines.length, 1, 'the actual config child must return exactly one result')
const actual = JSON.parse(configLines[0].slice('T_POST_CONFIG='.length))

let declarations = []
let registry
try {
  registry = JSON.parse(readFileSync(resolve(root, 'server/scripts/sync-bench-posture.json'), 'utf8'))
  assert.ok(Array.isArray(registry.deltas), 'posture deltas must be an array')
  declarations = registry.deltas
} catch (error) {
  // An absent registry means undeclared differences, not a missing-module
  // failure. Parse errors or an unreadable existing file remain hard failures.
  if (error.code !== 'ENOENT') throw error
}

test('T-POST config control uses actual defaults and honours explicit values', () => {
  assert.deepEqual(Object.fromEntries(required.map(key => [key, actual.empty.values[key]])), {
    SYNC_CELL_PARTITION_WORKER: 'off', SYNC_CELL_PARTITION_LEASE_TTL_MS: 1500,
    SYNC_CELL_PARTITION_RENEW_INTERVAL_MS: 400, REDIS_COMMAND_TIMEOUT_MS: 1500,
    SYNC_CELL_RECONCILE_INTERVAL_MS: 5000,
  })
  assert.deepEqual(actual.explicit.values, Object.fromEntries(Object.entries(explicit).map(([key, value]) => [key, key.endsWith('_WORKER') ? value : Number(value)])))
  assert.equal(actual.empty.derivedLeaseCommandTimeoutMs, 550)
  assert.equal(actual.explicit.derivedLeaseCommandTimeoutMs, 850)
})

test('T-POST inventory reads every selected delta and exposes auxiliary timing declarations', t => {
  const differences = Object.keys(fields).flatMap(variable => actual.bench.values[variable] === actual.shipped.values[variable] ? [] : [{ variable, benchDefault: actual.bench.values[variable], shippedDefault: actual.shipped.values[variable] }])
  const otherTimingKeys = [...new Set([...Object.keys(benchAnchor), ...Object.keys(shippedAnchor)])].filter(key => /^(?:SYNC|AM|WS|REDIS)[A-Z0-9_]*_MS$/.test(key) && !Object.hasOwn(fields, key)).sort()
  assert.equal(Object.keys(actual.bench.values).length, 9)
  assert.equal(Object.keys(actual.shipped.values).length, 9)
  t.diagnostic(JSON.stringify({ differences, otherTimingKeys, derivedLeaseCommandTimeoutMs: { bench: actual.bench.derivedLeaseCommandTimeoutMs, shipped: actual.shipped.derivedLeaseCommandTimeoutMs } }))
})

for (const variable of Object.keys(fields)) {
  test(`T-POST declares ${variable} when bench and shipped posture differ`, () => {
    const benchDefault = actual.bench.values[variable]
    const shippedDefault = actual.shipped.values[variable]
    if (benchDefault === shippedDefault) return
    const matches = declarations.filter(entry => entry.variable === variable)
    assert.equal(matches.length, 1,
      `UNDECLARED_POSTURE_DELTA ${variable}: bench=${benchDefault}, shipped=${shippedDefault}; expected one declaration with a reason in server/scripts/sync-bench-posture.json`)
    assert.equal(matches[0].benchDefault, benchDefault, `${variable}: declaration does not match actual bench config`)
    assert.equal(matches[0].shippedDefault, shippedDefault, `${variable}: declaration does not match actual shipped config`)
    assert.ok(typeof matches[0].reason === 'string' && matches[0].reason.trim(), `${variable}: a nonempty reason is required`)
  })
}

const projectSettings = {
  SYNC_FAILOVER_PARTITION_WORKER: 'off',
  SYNC_FAILOVER_PARTITION_LEASE_TTL_MS: '1500',
  SYNC_FAILOVER_PARTITION_RENEW_INTERVAL_MS: '400',
  SYNC_FAILOVER_REDIS_COMMAND_TIMEOUT_MS: '1500',
  SYNC_FAILOVER_RECONCILE_INTERVAL_MS: '5000',
  SYNC_FAILOVER_TELEMETRY_INTERVAL_MS: '60000',
  SYNC_FAILOVER_RENDER_CACHE_COMMAND_TIMEOUT_MS: '1500',
  SYNC_FAILOVER_ADMISSION_CONCURRENCY: '4',
  SYNC_FAILOVER_OWNERSHIP_CONCURRENCY: '16',
  SYNC_FAILOVER_HEALTHCHECK_TIMEOUT: '3000ms',
}

function resolveBench(overrides = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'maplespire-posture-test-'))
  const file = resolve(directory, 'empty.env')
  const safe = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'ProgramFiles', 'ProgramData', 'ALLUSERSPROFILE', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'SSH_AUTH_SOCK']
  const env = { ...Object.fromEntries(safe.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    SYNC_FAILOVER_AUTH_SECRET: 't-post-compose-placeholder', ...overrides }
  try {
    writeFileSync(file, '', { flag: 'wx' })
    return JSON.parse(execFileSync('docker', ['compose', '--env-file', file, '-f', resolve(root, 'infra/compose/sync-cell-failover.yml'), '--profile', '*', 'config', '--format', 'json'],
      { cwd: root, env, encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }))
  } finally {
    try { unlinkSync(file) } finally { rmdirSync(directory) }
  }
}

let deliveredConfig
const shipped = resolveShippedPosture((file, args, options) => {
  const resolved = execFileSync(file, args, options)
  deliveredConfig = JSON.parse(resolved)
  return resolved
})
const benchConfig = resolveBench(benchDefaultOverrides())
const shippedConfig = resolveBench(shippedOverrides(shipped))
const benchPosture = resolvedBenchPosture(benchConfig)
const appliedPosture = resolvedBenchPosture(shippedConfig, shipped)
const selectNine = values => Object.fromEntries(Object.keys(fields).map(key => [key, values[key]]))

test('T-POST shared helper agrees with the independent real-parser control', () => {
  assert.deepEqual(Object.keys(POSTURE_VARIABLES).sort(), Object.keys(fields).sort())
  assert.deepEqual(selectNine(shipped.values), actual.shipped.values)
  assert.deepEqual(selectNine(benchPosture.values), actual.bench.values)
  assert.deepEqual(appliedPosture.values, shipped.values)
  assert.equal(benchPosture.derivedLeaseCommandTimeoutMs, 275)
  assert.equal(shipped.derivedLeaseCommandTimeoutMs, 550)
  assert.equal(Object.keys(shipped.values).length, 16)
})

test('T-POST applies the independent nine-setting shipped vector and clears bench overrides', () => {
  // Literal defaults are an independent check on both the mapping and Docker
  // interpolation; catalogue JSON is not an input to this expectation.
  assert.deepEqual(shippedOverrides(readRuntimePostures({ empty: {} }).empty), projectSettings)
  assert.deepEqual(benchDefaultOverrides(), Object.fromEntries(Object.keys(projectSettings).map(key => [key, ''])))
  const restored = resolveBench({ ...projectSettings, ...benchDefaultOverrides() })
  assert.deepEqual(selectNine(resolvedBenchPosture(restored).values), actual.bench.values)
})

test('T-POST posture flag is explicit and unambiguous', () => {
  assert.equal(postureChoice([]), null)
  assert.equal(postureChoice(['--posture=bench']), 'bench')
  assert.equal(postureChoice(['--posture=shipped']), 'shipped')
  for (const args of [['--posture'], ['--posture='], ['--posture=other'], ['--posture=bench', '--posture=shipped']]) assert.throws(() => postureChoice(args), /posture/)
})

test('T-POST shipped resolution ignores ambient posture and removes its temporary env after an error', () => {
  const previous = process.env.SYNC_CELL_PARTITION_LEASE_TTL_MS
  process.env.SYNC_CELL_PARTITION_LEASE_TTL_MS = '30000'
  let temporary
  try {
    assert.deepEqual(resolveShippedPosture().values, shipped.values)
    assert.throws(() => resolveShippedPosture((_file, args, options) => {
      temporary = args[args.indexOf('--env-file') + 1]
      assert.equal(readFileSync(temporary, 'utf8'), '')
      assert.equal(options.env.SYNC_CELL_PARTITION_LEASE_TTL_MS, undefined)
      throw new Error('QA resolved-compose failure')
    }), /QA resolved-compose failure/)
    assert.equal(existsSync(temporary), false)
    assert.equal(existsSync(dirname(temporary)), false)
  } finally {
    if (previous === undefined) delete process.env.SYNC_CELL_PARTITION_LEASE_TTL_MS
    else process.env.SYNC_CELL_PARTITION_LEASE_TTL_MS = previous
  }
})

test('T-POST the real parser child receives settings without credential markers', () => {
  let inspected = false
  const marker = 'qa-credential-marker-never-forward'
  const returned = readRuntimePostures({ probe: { ...explicit, AUTH_SECRET: marker, DATABASE_URL: marker, REDIS_URL: marker, NODE_OPTIONS: marker } }, (file, args, options) => {
    inspected = true
    assert.equal(JSON.stringify(args).includes(marker), false)
    assert.equal(JSON.stringify(options.env).includes(marker), false)
    assert.equal(options.timeout, 15000)
    return execFileSync(file, args, options)
  })
  assert.equal(inspected, true)
  assert.deepEqual(selectNine(returned.probe.values), actual.explicit.values)
})

test('T-POST delivered cells must agree with their environment anchor', () => {
  assert.deepEqual(shipped.servicesChecked.sort(), ['api', 'api-b'])
  const changed = structuredClone(deliveredConfig)
  changed.services['api-b'].environment.SYNC_CELL_PARTITION_LEASE_TTL_MS = '3000'
  assert.throws(() => resolveShippedPosture(() => JSON.stringify(changed)), /shipped cell differs from x-api-environment: api-b/)
  changed.services['api-b'].command = ['node', 'dist/index.js']
  assert.throws(() => resolveShippedPosture(() => JSON.stringify(changed)), /shipped cell differs from x-api-environment: api-b/)
  const routerDrift = structuredClone(deliveredConfig)
  routerDrift.services['sync-ws-router'].environment.REDIS_COMMAND_TIMEOUT_MS = '3000'
  assert.throws(() => resolveShippedPosture(() => JSON.stringify(routerDrift)), /shipped router Redis command budget differs/)
})

test('T-POST all three resolved cells and the separate WS router consume shipped settings', () => {
  for (const name of ['sync-cell-a', 'sync-cell-b', 'sync-cell-c']) assert.equal(shippedConfig.services[name].environment.SYNC_CELL_PARTITION_WORKER, 'off')
  assert.equal(shippedConfig.services['sync-ws-router'].environment.REDIS_COMMAND_TIMEOUT_MS, '1500')
  const changed = structuredClone(shippedConfig)
  changed.services['sync-ws-router'].environment.REDIS_COMMAND_TIMEOUT_MS = '750'
  assert.throws(() => resolvedBenchPosture(changed, shipped), /router Redis command budget/)
  const missing = structuredClone(shippedConfig)
  delete missing.services['sync-cell-c']
  assert.throws(() => resolvedBenchPosture(missing, shipped), /missing cell sync-cell-c/)
  const drift = structuredClone(shippedConfig)
  drift.services['sync-cell-b'].environment.SYNC_CELL_TELEMETRY_INTERVAL_MS = '5000'
  assert.throws(() => resolvedBenchPosture(drift, shipped), /cell posture mismatch/)
})

test('T-POST resolved posture refuses an inherited fanout override or an unclassified timing', () => {
  const contaminated = resolveBench({ ...shippedOverrides(shipped), SYNC_FAILOVER_FANOUT_COALESCE_MS: '250' })
  assert.throws(() => resolvedBenchPosture(contaminated, shipped), /retained harness timing differs.*AM_SYNC_FANOUT_COALESCE_MS/)
  for (const service of ['sync-cell-a', 'sync-ws-router']) {
    const unknown = structuredClone(shippedConfig)
    unknown.services[service].environment.SYNC_CELL_NEW_DEADLINE_MS = '123'
    assert.throws(() => resolvedBenchPosture(unknown, shipped), /undeclared harness timing/)
  }
})

function milliseconds(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(String(value))
  assert.ok(match, `unexpected Compose duration ${value}`)
  return Number(match[1]) * (match[2] === 's' ? 1000 : 1)
}

test('T-POST cell and router healthchecks retain at least twice the Redis budget', () => {
  for (const [config, posture, literalTimeout] of [[benchConfig, benchPosture, 2000], [shippedConfig, shipped, 3000]]) {
    const checks = Object.entries(config.services).filter(([, value]) => value.healthcheck?.test?.some(part => String(part).includes('/api/ready')))
    assert.deepEqual(checks.map(([name]) => name).sort(), ['sync-cell-a', 'sync-ws-router'])
    for (const [name, service] of checks) {
      assert.notEqual(service.healthcheck.disable, true, name)
      const timeout = milliseconds(service.healthcheck.timeout)
      assert.equal(timeout, literalTimeout, name)
      assert.ok(timeout >= 2 * Math.max(posture.values.REDIS_COMMAND_TIMEOUT_MS, posture.values.REDIS_RENDER_CACHE_COMMAND_TIMEOUT_MS), name)
    }
  }
})

function assertCatalogue(bench, delivered, catalogue, anchorKeys) {
  assert.equal(catalogue.schemaVersion, 1)
  for (const name of ['deltas', 'retainedTimingDeltas', 'equalTimingVariables']) assert.ok(Array.isArray(catalogue[name]), name)
  const entries = [...catalogue.deltas, ...catalogue.retainedTimingDeltas]
  const all = [...entries.map(entry => entry.variable), ...catalogue.equalTimingVariables]
  assert.equal(new Set(all).size, all.length, 'duplicate posture/timing declaration')
  for (const entry of entries) assert.ok(typeof entry.reason === 'string' && entry.reason.trim(), `missing reason for ${entry.variable}`)
  for (const entry of catalogue.deltas) {
    assert.ok(Object.hasOwn(fields, entry.variable), `unknown qualified variable ${entry.variable}`)
    assert.notEqual(bench[entry.variable], delivered[entry.variable], `orphan delta ${entry.variable}`)
    assert.equal(entry.benchDefault, bench[entry.variable], `stale bench value ${entry.variable}`)
    assert.equal(entry.shippedDefault, delivered[entry.variable], `stale shipped value ${entry.variable}`)
  }
  for (const variable of Object.keys(fields)) {
    if (bench[variable] !== delivered[variable]) assert.ok(catalogue.deltas.some(entry => entry.variable === variable), `undeclared ${variable}`)
  }
  const known = new Set([...Object.keys(fields), ...all])
  for (const key of anchorKeys) assert.ok(known.has(key), `unknown timing variable ${key}`)
  for (const key of [...catalogue.retainedTimingDeltas.map(entry => entry.variable), ...catalogue.equalTimingVariables]) assert.ok(anchorKeys.includes(key), `orphan timing declaration ${key}`)
}

const timingKeys = [...new Set([...Object.keys(benchAnchor), ...Object.keys(shippedAnchor), ...Object.keys(benchConfig.services['sync-ws-router'].environment), ...Object.keys(deliveredConfig.services['sync-ws-router'].environment)])].filter(key => /^(?:SYNC|AM|WS|REDIS)[A-Z0-9_]*_MS$/.test(key)).sort()
test('T-POST catalogue covers all timing declarations without unknown, duplicate or orphan entries', () => {
  assertCatalogue(actual.bench.values, actual.shipped.values, registry, timingKeys)
  const unknown = [...timingKeys, 'SYNC_CELL_NEW_DEADLINE_MS']
  assert.throws(() => assertCatalogue(actual.bench.values, actual.shipped.values, registry, unknown), /unknown timing variable/)
  const noReason = structuredClone(registry)
  noReason.deltas[0].reason = ' '
  assert.throws(() => assertCatalogue(actual.bench.values, actual.shipped.values, noReason, timingKeys), /missing reason/)
  const duplicate = structuredClone(registry)
  duplicate.deltas.push(duplicate.deltas[0])
  assert.throws(() => assertCatalogue(actual.bench.values, actual.shipped.values, duplicate, timingKeys), /duplicate/)
  const stale = structuredClone(registry)
  stale.deltas[0].shippedDefault = 'invented'
  assert.throws(() => assertCatalogue(actual.bench.values, actual.shipped.values, stale, timingKeys), /stale shipped/)
})

// The auxiliary cache/delay declarations are outside runtime posture. Read
// their actual named fallback expressions without importing server startup.
const tree = (file, source = readFileSync(resolve(root, file), 'utf8')) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
function nodes(ast, predicate) {
  const found = []
  const visit = node => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit) }
  visit(ast)
  return found
}
function one(values, label) { assert.equal(values.length, 1, label); return values[0] }
function numericConstant(file, name) {
  const node = one(nodes(tree(file), node => ts.isVariableDeclaration(node) && node.name.getText() === name), name)
  assert.ok(ts.isNumericLiteral(node.initializer), `${name}: expected a numeric source fallback`)
  return Number(node.initializer.text)
}
function templateTree(name) {
  const node = one(nodes(tree('server/patch-automerge-peer-sync-state.mjs'), node => ts.isVariableDeclaration(node) && node.name.getText() === name), name)
  assert.ok(ts.isNoSubstitutionTemplateLiteral(node.initializer), name)
  return tree(name + '.js', node.initializer.text)
}
const auxiliaryDefaults = {
  AM_SAVE_DEBOUNCE_MS: Number(one(nodes(one(nodes(tree('server/src/automergeServer.ts'), n => ts.isFunctionDeclaration(n) && n.name?.text === 'automergeSaveDebounceRate'), 'save config'), n => ts.isReturnStatement(n) && n.expression && ts.isNumericLiteral(n.expression)), 'save fallback').expression.text),
  AM_SYNC_FANOUT_COALESCE_MS: Number(one(nodes(templateTree('stateMachineFanoutAfter'), n => ts.isVariableDeclaration(n) && n.name.getText() === 'fanoutCoalesceMs'), 'fanout fallback').initializer.whenFalse.text),
  AM_SYNC_DEBOUNCE_MS: Number(one(nodes(templateTree('debounceAfter'), n => ts.isConditionalExpression(n)), 'sync debounce fallback').whenFalse.text),
  WS_AUTH_TOKEN_BURST_CACHE_MS: numericConstant('server/src/auth/wsAuth.ts', 'DEFAULT_TOKEN_BURST_CACHE_TTL_MS'),
  WS_AUTH_EPOCH_BURST_CACHE_MS: numericConstant('server/src/auth/sessionEpoch.ts', 'DEFAULT_BURST_CACHE_TTL_MS'),
  AM_WORKSPACE_ROUTE_BURST_CACHE_MS: numericConstant('server/src/syncCells/workspaceRoute.ts', 'DEFAULT_ROUTE_BURST_CACHE_TTL_MS'),
  AM_CONCRETE_WORKSPACE_ROUTE_CACHE_MS: numericConstant('server/src/syncCells/workspaceRoute.ts', 'DEFAULT_CONCRETE_ROUTE_CACHE_TTL_MS'),
  AM_STORAGE_FENCE_IDLE_TIMEOUT_MS: Number(one(nodes(tree('server/src/automergeServer.ts'), n => ts.isVariableDeclaration(n) && n.name.getText() === 'configuredFenceIdleTimeoutMs'), 'fence idle fallback').initializer.arguments[0].right.text),
  SYNC_WS_OWNER_RECHECK_MS: Number(one(nodes(tree('server/src/syncCells/ownerAwareWsRouter.ts'), n => ts.isVariableDeclaration(n) && n.name.getText() === 'configuredRecheckMs'), 'router recheck fallback').initializer.right.arguments[0].right.text),
}
test('T-POST retained and equal timing declarations match their source fallbacks', () => {
  const effective = (key, anchor, runtime) => {
    const raw = literalDefault(anchor[key], key)
    const value = raw === undefined ? runtime.values[key] ?? auxiliaryDefaults[key] : Number(raw)
    assert.ok(Number.isSafeInteger(value) && value >= 0, `unresolved auxiliary default ${key}`)
    return value
  }
  for (const entry of registry.retainedTimingDeltas) {
    const bench = effective(entry.variable, benchAnchor, { values: benchPosture.values })
    const delivered = effective(entry.variable, shippedAnchor, shipped)
    assert.notEqual(bench, delivered, `orphan retained delta ${entry.variable}`)
    assert.equal(entry.benchDefault, bench, entry.variable)
    assert.equal(entry.shippedDefault, delivered, entry.variable)
  }
  for (const key of registry.equalTimingVariables) {
    const bench = key === 'SYNC_WS_OWNER_RECHECK_MS' ? benchConfig.services['sync-ws-router'].environment : benchAnchor
    const delivered = key === 'SYNC_WS_OWNER_RECHECK_MS' ? deliveredConfig.services['sync-ws-router'].environment : shippedAnchor
    assert.equal(effective(key, bench, { values: benchPosture.values }), effective(key, delivered, shipped), `undeclared auxiliary drift ${key}`)
  }
})

function runningFixture(change = () => {}) {
  const services = ['sync-cell-a', 'sync-cell-b', 'sync-cell-c', 'sync-ws-router']
  const calls = []
  const ids = Object.fromEntries(services.map((name, index) => [name, String(index + 1).repeat(64)]))
  const exec = (file, args) => {
    assert.equal(file, 'docker')
    calls.push(args)
    if (args[0] === 'ps') {
      const name = args.find(arg => arg.startsWith('label=com.docker.compose.service=')).split('=').at(-1)
      return ids[name]
    }
    const id = args[0] === 'inspect' ? args[1] : args[3]
    const service = services.find(name => ids[name] === id)
    assert.ok(service, 'only expected IDs may be inspected')
    if (args[0] === 'inspect') {
      assert.ok(args.includes('--format'))
      assert.equal(args.at(-1).includes('Config.Env'), false)
      return JSON.stringify({ id, image: 'sha256:' + 'a'.repeat(64), startedAt: '2026-09-07T00:00:00Z' })
    }
    assert.equal(args[0], 'exec')
    assert.ok(args.includes('node'))
    assert.ok(args.some(arg => arg.includes('./dist/syncCells/ownership.js')))
    assert.ok(args.some(arg => arg.includes('process.env')))
    const running = structuredClone(shipped)
    change(service, running)
    return JSON.stringify({ running })
  }
  return { services, calls, exec }
}
test('T-POST inspects compiled configuration for every cell and the separate router', () => {
  const f = runningFixture()
  const observed = inspectRunningPosture('qa-posture', f.services, shipped, {}, f.exec)
  assert.deepEqual(observed.map(value => value.service), f.services)
  assert.equal(f.calls.filter(args => args[0] === 'exec').length, 4)
  const drift = runningFixture((name, running) => { if (name === 'sync-cell-c') running.values.SYNC_CELL_PARTITION_WORKER = 'on' })
  assert.throws(() => inspectRunningPosture('qa-posture', drift.services, shipped, {}, drift.exec), /compiled running posture differs: sync-cell-c/)
  const router = runningFixture((name, running) => { if (name === 'sync-ws-router') running.values.REDIS_COMMAND_TIMEOUT_MS = 750 })
  assert.throws(() => inspectRunningPosture('qa-posture', router.services, shipped, {}, router.exec), /compiled router Redis budget differs/)
})
