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
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(serverDir, '..')
const shippedFile = resolve(root, 'compose.maplespire.yml')
// This maps names, not values: the real configuration functions own defaults
// and bounds. The independent JSON inventory is used by tests, never as input
// to the posture that the runner executes.
export const POSTURE_VARIABLES = {
  SYNC_CELL_PARTITION_WORKER: ['ownership', 'partitionWorker', 'SYNC_FAILOVER_PARTITION_WORKER'],
  SYNC_CELL_PARTITION_LEASE_TTL_MS: ['ownership', 'partitionLeaseTtlMs', 'SYNC_FAILOVER_PARTITION_LEASE_TTL_MS'],
  SYNC_CELL_PARTITION_RENEW_INTERVAL_MS: ['ownership', 'partitionRenewIntervalMs', 'SYNC_FAILOVER_PARTITION_RENEW_INTERVAL_MS'],
  REDIS_COMMAND_TIMEOUT_MS: ['redis', 'commandTimeoutMs', 'SYNC_FAILOVER_REDIS_COMMAND_TIMEOUT_MS'],
  SYNC_CELL_RECONCILE_INTERVAL_MS: ['ownership', 'reconcileIntervalMs', 'SYNC_FAILOVER_RECONCILE_INTERVAL_MS'],
  SYNC_CELL_TELEMETRY_INTERVAL_MS: ['ownership', 'telemetryIntervalMs', 'SYNC_FAILOVER_TELEMETRY_INTERVAL_MS'],
  REDIS_RENDER_CACHE_COMMAND_TIMEOUT_MS: ['render', 'commandTimeoutMs', 'SYNC_FAILOVER_RENDER_CACHE_COMMAND_TIMEOUT_MS'],
  SYNC_CELL_ADMISSION_CONCURRENCY: ['ownership', 'admissionConcurrency', 'SYNC_FAILOVER_ADMISSION_CONCURRENCY'],
  SYNC_CELL_OWNERSHIP_CONCURRENCY: ['ownership', 'concurrency', 'SYNC_FAILOVER_OWNERSHIP_CONCURRENCY'],
}
const EXTRA_FIELDS = {
  SYNC_CELL_LEASE_TTL_MS: ['ownership', 'leaseTtlMs'],
  SYNC_CELL_RENEW_INTERVAL_MS: ['ownership', 'renewIntervalMs'],
  SYNC_CELL_PARTITION_PROBE_INTERVAL_MS: ['ownership', 'partitionProbeIntervalMs'],
  SYNC_CELL_LEASE_COMMAND_TIMEOUT_MS: ['ownership', 'leaseCommandTimeoutMs'],
  SYNC_CELL_RECONCILE_PASS_DEADLINE_MS: ['ownership', 'reconcilePassDeadlineMs'],
  REDIS_CONNECT_WAIT_MS: ['redis', 'connectWaitMs'],
  REDIS_RENDER_CACHE_CONNECT_WAIT_MS: ['render', 'connectWaitMs'],
}
const fields = { ...POSTURE_VARIABLES, ...EXTRA_FIELDS }
const safeProcessKeys = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'ProgramFiles', 'ProgramData', 'ALLUSERSPROFILE']
const dockerKeys = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'SSH_AUTH_SOCK']
const selectedEnvironment = keys => Object.fromEntries(keys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]))

const topologyServices = ['sync-cell-a', 'sync-cell-b', 'sync-cell-c', 'sync-ws-router']
const topologySources = ['server/src/syncCells/assignment.ts', 'server/src/syncCells/topologyContract.ts']
const topologyModules = ['dist/syncCells/assignment.js', 'dist/syncCells/topologyContract.js']
const topologyInputs = ['SYNC_CELL_TOPOLOGY_GENERATION', 'SYNC_CELL_PARTITION_COUNT', 'SYNC_CELL_MULTI_PARTITION']
const sha256 = value => createHash('sha256').update(value).digest('hex')
const sourceHashes = () => Object.fromEntries(topologySources.map(path => [path, sha256(readFileSync(resolve(root, path)))]))

function assertTopology(topology) {
  assert.ok(topology && Number.isSafeInteger(topology.partitionCount) && topology.partitionCount >= 1 && topology.partitionCount <= 1024,
    'topology partition count is missing or invalid')
  assert.match(topology.configuredGeneration ?? '', /^[a-z0-9][a-z0-9_.-]{0,46}$/, 'configured generation is missing or invalid')
  assert.match(topology.mappingFingerprint ?? '', /^[a-f0-9]{16}$/, 'mapping fingerprint is missing or invalid')
  assert.equal(topology.effectiveGeneration, `${topology.configuredGeneration}.${topology.mappingFingerprint}`, 'effective generation differs from the declared build fingerprint')
  assert.equal(topology.topologyGeneration, topology.effectiveGeneration, 'topology generation is not effective')
}

function assertHashes(hashes, paths) {
  assert.deepEqual(Object.keys(hashes ?? {}).sort(), [...paths].sort(), 'topology module/source census is incomplete')
  for (const path of paths) assert.match(hashes[path], /^[a-f0-9]{64}$/, 'missing SHA-256 for ' + path)
}

const topologyProbe = (compiled = false) => [
  `import { syncCellPartitionConfig, MAPPING_FINGERPRINT } from './${compiled ? 'dist/syncCells/assignment.js' : 'src/syncCells/assignment.ts'}'`,
  "import { readFileSync } from 'node:fs'",
  "import { createHash } from 'node:crypto'",
  'const input = JSON.parse(process.argv[1])',
  'const config = syncCellPartitionConfig(input.environment ?? process.env)',
  'const { partitionCount, configuredGeneration, effectiveGeneration, topologyGeneration } = config',
  'const topology = { partitionCount, configuredGeneration, effectiveGeneration, topologyGeneration, mappingFingerprint: MAPPING_FINGERPRINT }',
  "const modules = Object.fromEntries((input.modules ?? []).map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]))",
  "process.stdout.write(JSON.stringify({ topology, modules }) + '\\n')",
].join('\n')

/** Resolve the checkout's factory with explicit public inputs. Never import the
 * host's dist: a previous build there can otherwise supply a stale expectation. */
export function readRuntimeTopology(environment, exec = execFileSync) {
  const sources = sourceHashes()
  const selected = Object.fromEntries(topologyInputs.flatMap(key => environment[key] == null ? [] : [[key, String(environment[key])]]))
  const output = exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', topologyProbe(), JSON.stringify({ environment: selected })], {
    cwd: serverDir, env: selectedEnvironment(safeProcessKeys), encoding: 'utf8',
    timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true,
  })
  const { topology } = JSON.parse(output)
  assertTopology(topology)
  assert.deepEqual(sourceHashes(), sources, 'topology sources changed while the factory was read')
  return { expectedTopology: topology, sources }
}

/** Structural checks also used by the pure baseline evaluator. This is a local
 * provenance record, not cryptographic authentication of an external report. */
function assertTargets(targets) {
  assert.equal(targets?.host, '127.0.0.1', 'qualified topology requires the local IPv4 host 127.0.0.1')
  assert.equal(targets.cellPorts?.length, 3, 'qualified topology requires three cell ports')
  const ports = [...targets.cellPorts, targets.routerPort]
  assert.ok(ports.every(port => Number.isSafeInteger(port) && port > 0 && port <= 65535), 'invalid topology target port')
  assert.equal(new Set(ports).size, 4, 'topology target ports must be distinct')
}

function assertEngineEndpoint(endpoint) {
  assert.ok(typeof endpoint === 'string' && (/^npipe:\/\/\/\/\.\/pipe\/[a-zA-Z0-9_.-]+$/.test(endpoint)
    || /^unix:\/\/\/[^\s]+$/.test(endpoint)), 'qualified topology requires a local Docker socket, not a remote daemon')
}

function targetFor(service, targets) {
  const index = topologyServices.slice(0, 3).indexOf(service)
  return service === 'router' ? { url: `http://${targets.host}:${targets.routerPort}`, containerPort: '8080/tcp', hostPort: targets.routerPort }
    : index >= 0 ? { url: `http://${targets.host}:${targets.cellPorts[index]}`, containerPort: '3001/tcp', hostPort: targets.cellPorts[index] } : null
}

function assertContainer(cell, project, targets) {
  assert.match(cell.id ?? '', /^[a-f0-9]{64}$/, 'invalid topology container ID')
  assert.match(cell.image ?? '', /^sha256:[a-f0-9]{64}$/, 'invalid topology image ID')
  assert.ok(typeof cell.startedAt === 'string' && Number.isFinite(Date.parse(cell.startedAt)), 'missing topology container start')
  assert.ok(Number.isSafeInteger(cell.restartCount) && cell.restartCount >= 0, 'missing topology restart counter')
  assert.equal(cell.project, project, 'inspected topology project changed')
  assert.equal(cell.running, true, 'topology container is not running')
  assert.ok(cell.ports && typeof cell.ports === 'object' && !Array.isArray(cell.ports), 'missing published port census')
  const target = targetFor(cell.service, targets)
  assert.deepEqual(cell.target, target, 'topology HTTP target differs')
  if (target) {
    const bindings = cell.ports[target.containerPort]
    assert.ok(Array.isArray(bindings) && bindings.some(binding => ['127.0.0.1', '0.0.0.0'].includes(binding?.HostIp)
      && binding.HostPort === String(target.hostPort)), 'published port does not bind the requested HTTP target: ' + cell.service)
  }
}

const containerIdentity = ({ service, id, image, startedAt, restartCount, project, running, ports, target }) =>
  ({ service, id, image, startedAt, restartCount, project, running, ports, target })

export function assertTopologyBuild(record, targets = record?.targets, project = record?.project) {
  assertTargets(targets)
  assert.deepEqual(record.targets, targets, 'topology target configuration differs')
  assert.match(project ?? '', /^[a-z0-9][a-z0-9_-]{0,62}$/, 'invalid topology project')
  assert.equal(record.project, project, 'topology project differs from the requested project')
  assertEngineEndpoint(record.engineEndpoint)
  assertTopology(record?.expectedTopology)
  assertHashes(record.sources, topologySources)
  assert.equal(record.running?.length, topologyServices.length, 'topology requires all three cells and the router')
  assert.deepEqual(record.running.map(cell => cell.service).sort(), [...topologyServices].sort(), 'topology service census differs')
  for (const cell of record.running) {
    assertContainer(cell, project, targets)
    assertTopology(cell.topology)
    assert.deepEqual(cell.topology, record.expectedTopology, 'compiled topology differs from the source factory: ' + cell.service)
    assertHashes(cell.modules, topologyModules)
    assert.deepEqual(cell.modules, record.running[0].modules, 'compiled topology modules differ between services')
  }
  assert.equal(new Set(record.running.map(cell => cell.id)).size, topologyServices.length, 'topology container IDs are not distinct')
  assert.equal(new Set(record.running.map(cell => cell.image)).size, 1, 'topology services run different images')
  assert.equal(record.edge?.service, 'router', 'missing nginx HTTP entry service')
  assertContainer(record.edge, project, targets)
  assert.equal(new Set([...record.running, record.edge].map(cell => cell.id)).size, 5, 'topology and entry container IDs are not distinct')
}

function topologyInspector(project, targets, exec) {
  assert.match(project, /^[a-z0-9][a-z0-9_-]{0,62}$/, 'invalid topology project')
  assertTargets(targets)
  const env = selectedEnvironment([...safeProcessKeys, ...dockerKeys])
  const invoke = args => exec('docker', args, { env, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true })
  // DOCKER_CONTEXT takes precedence over DOCKER_HOST in the Docker CLI. Only
  // a local socket can associate its published ports with this process's HTTP.
  const engineEndpoint = env.DOCKER_CONTEXT || !env.DOCKER_HOST
    ? JSON.parse(invoke(['context', 'inspect', ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []), '--format', '{{json .Endpoints.docker.Host}}']))
    : env.DOCKER_HOST
  assertEngineEndpoint(engineEndpoint)
  const format = '{"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"ports":{{json .NetworkSettings.Ports}}}'
  const inspect = (id, service) => {
    const cell = JSON.parse(invoke(['inspect', id, '--format', format]))
    assert.equal(cell.id, id, 'inspected topology container changed')
    assert.equal(cell.service, service, 'inspected topology service changed')
    cell.target = targetFor(service, targets)
    assertContainer(cell, project, targets)
    return cell
  }
  const discover = service => {
    const ids = String(invoke(['ps', '-q', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + project,
      '--filter', 'label=com.docker.compose.service=' + service])).trim().split(/\s+/).filter(Boolean)
    assert.equal(ids.length, 1, 'expected one running topology service: ' + service)
    assert.match(ids[0], /^[a-f0-9]{64}$/, 'invalid running topology container ID')
    return inspect(ids[0], service)
  }
  return { engineEndpoint, invoke, inspect, discover }
}

/** Inspect only the named project's running containers. The imported compiled
 * factory makes no application connection; its output contains no credentials.
 * Bracket each probe with container identity to reject a concurrent restart. */
export function inspectRunningTopology(project, expectedTopology, exec = execFileSync, targets) {
  assertTopology(expectedTopology)
  const inspector = topologyInspector(project, targets, exec)
  const { invoke, discover, inspect } = inspector
  const observed = []
  for (const service of topologyServices) {
    const before = discover(service)
    const probe = JSON.parse(invoke(['exec', '-e', 'NODE_OPTIONS=', '-e', 'NODE_PATH=', '-w', '/app', before.id,
      'node', '--input-type=module', '-e', topologyProbe(true), JSON.stringify({ modules: topologyModules })]))
    const after = inspect(before.id, service)
    assert.deepEqual(after, before, 'topology container changed during the compiled probe: ' + service)
    assertTopology(probe.topology)
    assert.deepEqual(probe.topology, expectedTopology, 'compiled topology differs from the source factory: ' + service)
    assertHashes(probe.modules, topologyModules)
    observed.push({ ...before, topology: probe.topology, modules: probe.modules })
  }
  return { project, targets: structuredClone(targets), engineEndpoint: inspector.engineEndpoint, running: observed, edge: discover('router') }
}

/** Both runner-mediated and direct qualified load gates use this preflight;
 * neither accepts an expected fingerprint from an environment variable. */
export function qualifyRuntimeTopology(project, environment, exec = execFileSync, targets) {
  assertTargets(targets)
  const source = readRuntimeTopology(environment, exec)
  const record = { ...source, ...inspectRunningTopology(project, source.expectedTopology, exec, targets) }
  assertTopologyBuild(record)
  assert.deepEqual(sourceHashes(), source.sources, 'topology sources changed during container inspection')
  return record
}

/** No compiled exec at admission: inspect the five identities and their ports
 * again. These sequential observations bracket HTTP; they are not atomic. */
export function revalidateTopologyTargets(record, targets, project, exec = execFileSync) {
  assertTopologyBuild(record, targets, project)
  const beganAt = Date.now()
  const inspector = topologyInspector(project, targets, exec)
  assert.equal(inspector.engineEndpoint, record.engineEndpoint, 'Docker endpoint changed after topology preflight')
  const containers = [...record.running, record.edge].map(cell => inspector.discover(cell.service))
  const receipt = { beganAt, endedAt: Date.now(), engineEndpoint: inspector.engineEndpoint, containers }
  assertTopologyTargetReceipt(record, receipt)
  assert.deepEqual(sourceHashes(), record.sources, 'topology sources changed after preflight')
  return receipt
}

export function assertTopologyTargetReceipt(record, receipt) {
  assert.ok(Number.isSafeInteger(receipt?.beganAt) && receipt.beganAt > 0
    && Number.isSafeInteger(receipt.endedAt) && receipt.endedAt >= receipt.beganAt, 'invalid topology target observation window')
  assert.equal(receipt.engineEndpoint, record.engineEndpoint, 'Docker endpoint changed after topology preflight')
  assert.deepEqual(receipt.containers, [...record.running, record.edge].map(containerIdentity), 'topology identity or HTTP binding changed after preflight')
}

// The child imports configuration modules only, never the HTTP entrypoint.
// Explicit input + a minimal process environment avoid .env/NODE_OPTIONS and
// ambient Redis credentials. tsx is the server's locked development dependency.
const probeSource = (compiled = false) => [
  "import { syncCellOwnershipConfig } from './" + (compiled ? 'dist' : 'src') + "/syncCells/ownership." + (compiled ? 'js' : 'ts') + "'",
  "import { redisRuntimeConfig, redisRenderCacheRuntimeConfig } from './" + (compiled ? 'dist' : 'src') + "/runtime/redis." + (compiled ? 'js' : 'ts') + "'",
  'const { environments, fields } = JSON.parse(process.argv[1])',
  'const results = Object.fromEntries(Object.entries(environments ?? { running: process.env }).map(([name, env]) => {',
  '  const configs = { ownership: syncCellOwnershipConfig(env), redis: redisRuntimeConfig(env), render: redisRenderCacheRuntimeConfig(env) }',
  '  const values = Object.fromEntries(Object.entries(fields).map(([variable, [group, property]]) => {',
  '    const value = configs[group][property]',
  "    if (typeof value !== 'boolean' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('invalid config field: ' + variable)",
  "    return [variable, typeof value === 'boolean' ? (value ? 'on' : 'off') : value]",
  '  }))',
  '  return [name, { values, derivedLeaseCommandTimeoutMs: configs.ownership.leaseCommandTimeoutMs }]',
  '}))',
  "process.stdout.write(JSON.stringify(results) + '\\n')",
].join('\n')

export function readRuntimePostures(environments, exec = execFileSync) {
  assert.ok(environments && typeof environments === 'object' && Object.keys(environments).length > 0)
  const selected = Object.fromEntries(Object.entries(environments).map(([name, environment]) => [name,
    Object.fromEntries(Object.keys(fields).flatMap(key => environment[key] == null ? [] : [[key, String(environment[key])]])),
  ]))
  const output = exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probeSource(), JSON.stringify({ environments: selected, fields })], {
    cwd: serverDir, env: selectedEnvironment(safeProcessKeys), encoding: 'utf8',
    timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true,
  })
  return JSON.parse(output)
}

export function postureChoice(argv) {
  const options = argv.filter(arg => arg === '--posture' || arg.startsWith('--posture='))
  if (!options.length) return null
  assert.equal(options.length, 1, 'one --posture option is required')
  const value = options[0].slice('--posture='.length)
  assert.ok(value === 'bench' || value === 'shipped', '--posture must be bench or shipped')
  return value
}

export function resolveShippedPosture(exec = execFileSync) {
  // No connection is made to the deployed demo. Compose resolves its checked-in
  // anchor with inert credentials; only selected non-secret settings leave here.
  const environment = {
    ...selectedEnvironment([...safeProcessKeys, ...dockerKeys]),
    MAPLESPIRE_POSTGRES_PASSWORD: 'posture-config-placeholder',
    MAPLESPIRE_AUTH_SECRET: 'posture-config-placeholder',
    MAPLESPIRE_METRICS_TOKEN: 'posture-config-placeholder',
    MAPLESPIRE_ALERT_SMTP_REGION: 'ca-central-1',
    MAPLESPIRE_ALERT_SMTP_USERNAME: 'AKIAIOSFODNN7EXAMPLE',
    MAPLESPIRE_ALERT_SMTP_PASSWORD: 'B' + 'A'.repeat(43),
    MAPLESPIRE_ALERT_EMAIL_FROM: 'alerts@example.invalid',
    MAPLESPIRE_ALERT_EMAIL_TO: 'operator@example.invalid',
    MAPLESPIRE_ALERT_SNS_REGION: 'ca-central-1',
    MAPLESPIRE_ALERT_SNS_ACCESS_KEY_ID: 'AKIAABCDEFGHIJKLMNOP',
    MAPLESPIRE_ALERT_SNS_SECRET_ACCESS_KEY: 'A'.repeat(40),
    MAPLESPIRE_ALERT_SNS_WATCHDOG_TOPIC_ARN: 'arn:aws:sns:ca-central-1:123456789012:maplespire-watchdog',
    MAPLESPIRE_ALERT_SNS_NOTIFICATION_TOPIC_ARN: 'arn:aws:sns:ca-central-1:123456789012:maplespire-alerting-notifications',
    MAPLESPIRE_GRAFANA_ADMIN_PASSWORD: 'posture-config-placeholder',
    CLOUDFLARE_TUNNEL_TOKEN: 'posture-config-placeholder',
  }
  const temporary = mkdtempSync(resolve(tmpdir(), 'maplespire-posture-'))
  const emptyEnv = resolve(temporary, 'empty.env')
  let config
  try {
    writeFileSync(emptyEnv, '', { flag: 'wx' })
    config = JSON.parse(exec('docker', ['compose', '--env-file', emptyEnv, '-f', shippedFile, '--profile', '*', 'config', '--format', 'json'], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    }))
  } finally {
    try { unlinkSync(emptyEnv) } finally { rmdirSync(temporary) }
  }
  const anchor = config['x-api-environment']
  assert.ok(anchor && typeof anchor === 'object', 'shipped x-api-environment must resolve')
  const select = environment => Object.fromEntries(Object.keys(fields).flatMap(key => environment[key] == null ? [] : [[key, String(environment[key])]]))
  const selected = select(anchor)
  const cells = Object.entries(config.services ?? {}).filter(([, service]) => service.environment?.SYNC_CELL_OWNERSHIP === 'on')
  assert.ok(cells.length > 0, 'no shipped sync cell found')
  const routerEnvironment = config.services?.['sync-ws-router']?.environment
  assert.ok(routerEnvironment, 'no shipped owner-aware router found')
  const configurations = readRuntimePostures({ shipped: selected, router: select(routerEnvironment),
    ...Object.fromEntries(cells.map(([name, service]) => [name, select(service.environment)])) })
  const runtime = configurations.shipped
  for (const [name] of cells) assert.deepEqual(configurations[name].values, runtime.values, 'shipped cell differs from x-api-environment: ' + name)
  assert.equal(configurations.router.values.REDIS_COMMAND_TIMEOUT_MS, runtime.values.REDIS_COMMAND_TIMEOUT_MS,
    'shipped router Redis command budget differs from x-api-environment')
  const sources = Object.fromEntries(['compose.maplespire.yml', 'server/src/syncCells/ownership.ts', 'server/src/runtime/redis.ts'].map(path => [path,
    createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'),
  ]))
  return { ...runtime, sources, anchor: selected, servicesChecked: cells.map(([name]) => name) }
}

export function shippedOverrides(shipped) {
  const env = Object.fromEntries(Object.entries(POSTURE_VARIABLES).map(([key, [, , override]]) => [override, String(shipped.values[key])]))
  const commandMs = Math.max(shipped.values.REDIS_COMMAND_TIMEOUT_MS, shipped.values.REDIS_RENDER_CACHE_COMMAND_TIMEOUT_MS)
  env.SYNC_FAILOVER_HEALTHCHECK_TIMEOUT = Math.max(2_000, 2 * commandMs) + 'ms'
  return env
}

export function benchDefaultOverrides() {
  // An explicitly selected control means the Compose defaults, not inherited
  // experimental SYNC_FAILOVER_* values. ${...:-default} treats '' as absent.
  return { ...Object.fromEntries(Object.values(POSTURE_VARIABLES).map(([, , override]) => [override, ''])),
    SYNC_FAILOVER_HEALTHCHECK_TIMEOUT: '' }
}

export function resolvedBenchPosture(config, expected = null) {
  const names = ['sync-cell-a', 'sync-cell-b', 'sync-cell-c']
  const environments = Object.fromEntries(names.map(name => {
    assert.ok(config.services?.[name]?.environment, 'missing cell ' + name)
    return [name, config.services[name].environment]
  }))
  const actual = readRuntimePostures(environments)
  for (const name of names) {
    assert.deepEqual(actual[name].values, actual[names[0]].values, 'cell posture mismatch: ' + name)
    if (expected) assert.deepEqual(actual[name].values, expected.values, 'shipped posture was not applied to ' + name)
  }
  const routerEnvironment = config.services?.['sync-ws-router']?.environment
  assert.ok(routerEnvironment, 'missing owner-aware router')
  const router = readRuntimePostures({ router: routerEnvironment }).router
  assert.equal(router.values.REDIS_COMMAND_TIMEOUT_MS, actual[names[0]].values.REDIS_COMMAND_TIMEOUT_MS, 'router Redis command budget differs from the cells')
  const registry = JSON.parse(readFileSync(resolve(serverDir, 'scripts/sync-bench-posture.json'), 'utf8'))
  const known = new Set([...Object.keys(fields), ...registry.retainedTimingDeltas.map(entry => entry.variable), ...registry.equalTimingVariables])
  const timingValues = environment => Object.fromEntries(Object.entries(environment).filter(([key]) => /^(?:SYNC|AM|WS|REDIS)[A-Z0-9_]*_MS$/.test(key)))
  const retainedTimings = {}
  for (const [name, environment] of [...Object.entries(environments), ['sync-ws-router', routerEnvironment]]) {
    const timings = timingValues(environment)
    for (const variable of Object.keys(timings)) assert.ok(known.has(variable), 'undeclared harness timing: ' + name + '/' + variable)
    if (name === 'sync-ws-router') continue
    for (const entry of registry.retainedTimingDeltas) {
      assert.equal(String(timings[entry.variable]), String(entry.benchDefault), 'retained harness timing differs from declaration: ' + name + '/' + entry.variable)
      assert.ok(typeof entry.reason === 'string' && entry.reason.trim(), 'retained timing requires a reason')
    }
    retainedTimings[name] = Object.fromEntries(registry.retainedTimingDeltas.map(entry => [entry.variable, timings[entry.variable]]))
  }
  return { values: actual[names[0]].values, derivedLeaseCommandTimeoutMs: actual[names[0]].derivedLeaseCommandTimeoutMs,
    routerRedisCommandTimeoutMs: router.values.REDIS_COMMAND_TIMEOUT_MS, retainedTimings }
}

export function inspectRunningPosture(project, services, expected, env, exec = execFileSync) {
  const observed = []
  for (const service of services.filter(name => name.startsWith('sync-cell-') || name === 'sync-ws-router')) {
    const ids = String(exec('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=' + project,
      '--filter', 'label=com.docker.compose.service=' + service], { encoding: 'utf8', env, timeout: 15_000 })).trim().split(/\s+/).filter(Boolean)
    assert.equal(ids.length, 1, 'expected one running ' + service)
    const inspect = JSON.parse(exec('docker', ['inspect', ids[0], '--format', '{"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}}}'], { encoding: 'utf8', env, timeout: 15_000 }))
    const output = exec('docker', ['exec', '-w', '/app', ids[0], 'node', '--input-type=module', '-e', probeSource(true), JSON.stringify({ fields })], {
      encoding: 'utf8', env, timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true,
    })
    const running = JSON.parse(output).running
    if (service === 'sync-ws-router') assert.equal(running.values.REDIS_COMMAND_TIMEOUT_MS, expected.values.REDIS_COMMAND_TIMEOUT_MS, 'compiled router Redis budget differs')
    else assert.deepEqual(running.values, expected.values, 'compiled running posture differs: ' + service)
    observed.push({ service, id: inspect.id, image: inspect.image, startedAt: inspect.startedAt,
      values: service === 'sync-ws-router' ? { REDIS_COMMAND_TIMEOUT_MS: running.values.REDIS_COMMAND_TIMEOUT_MS } : running.values })
  }
  assert.ok(observed.length >= 2, 'at least two running cells must be inspected')
  assert.equal(new Set(observed.map(cell => cell.image)).size, 1, 'cells run different images')
  return observed
}
