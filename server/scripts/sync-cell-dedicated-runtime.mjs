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

// Explicit isolated-bench operations only; no work starts at module import.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { request as httpRequest, validateHeaderValue } from 'node:http'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import { coldRead } from '../qa/dedicatedColdRead.mjs'
import { assertDedicatedCensus, assertDedicatedTopology } from './sync-cell-dedicated-contract.mjs'
import { captureDedicatedNative, observeSettlement } from './sync-cell-dedicated-native.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CELL_IDS = ['failover-cell-a', 'failover-cell-b', 'failover-cell-c']
const SERVICES = ['sync-cell-a', 'sync-cell-b', 'sync-cell-c']
const ENV_KEYS = ['SYNC_CELL_ID', 'SYNC_CELL_ROLE', 'SYNC_CELL_PARTITION_COUNT', 'SYNC_CELL_MULTI_PARTITION',
  'SYNC_CELL_PLACEMENT_MODE', 'SYNC_CELL_RESERVED_PARTITIONS', 'SYNC_CELL_TOPOLOGY_GENERATION',
  'SYNC_CELL_PARTITION_WORKER', 'SYNC_CELL_RECONCILE_INTERVAL_MS', 'SYNC_CELL_OWNERSHIP', 'PORT']
const INSPECT = '{"id":{{json .Id}},"image":{{json .Image}},"name":{{json .Name}},'
  + '"running":{{json .State.Running}},"paused":{{json .State.Paused}},"startedAt":{{json .State.StartedAt}},'
  + '"restartCount":{{json .RestartCount}},"ports":{{json .NetworkSettings.Ports}},'
  + '"networks":{{json .NetworkSettings.Networks}},'
  + '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
  + '"service":{{json (index .Config.Labels "com.docker.compose.service")}}}'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const validPort = value => Number.isSafeInteger(value) && value > 0 && value <= 65535
const publicError = (error, label) => {
  const safe = new Error(label)
  if (/^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '')) safe.code = error.code
  if (error?.evidence) safe.evidence = error.evidence
  return safe
}

function validateOptions(options) {
  assert.ok(options && /^[a-z0-9][a-z0-9_-]{2,100}$/.test(options.project)
    && !/(^|[-_])demo($|[-_])/.test(options.project), 'An explicit non-demo Compose project is required')
  assert.ok(typeof options.out === 'string' && options.out.length > 0, 'A receipt directory is required')
  assert.ok(typeof options.generation === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(options.generation), 'Invalid effective generation')
  assert.ok(options.workspace && ['landscapeId', 'versionId'].every(key =>
    typeof options.workspace[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(options.workspace[key])), 'Invalid workspace identity')
  assert.ok(Array.isArray(options.cells) && options.cells.length === 3, 'Three explicit cells are required')
  assert.deepEqual(options.cells.map(cell => cell.cellId).sort(), CELL_IDS)
  for (const cell of options.cells) {
    assert.equal(cell.service, SERVICES[CELL_IDS.indexOf(cell.cellId)], 'Cell service does not match its identity')
    assert.ok(validPort(cell.port), 'Invalid cell port')
  }
  assert.ok(validPort(options.routerPort) && options.routerPort !== 80, 'An explicit public router port is required')
  assert.ok(typeof options.loginEmail === 'string' && /^[^\s@]+@[^\s@]+$/.test(options.loginEmail), 'An existing login email is required')
  let database
  try { database = new URL(options.databaseUrl) } catch { throw new Error('An explicit local database URL is required') }
  assert.ok(['postgres:', 'postgresql:'].includes(database.protocol) && ['127.0.0.1', 'localhost'].includes(database.hostname)
    && /^[1-9][0-9]{0,4}$/.test(database.port) && validPort(Number(database.port))
    && /^\/[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(database.pathname) && !database.search && !database.hash,
  'The database must name a loopback port and one database')
  assert.equal(new Set([...options.cells.map(cell => cell.port), options.routerPort, Number(database.port)]).size, 5,
    'Bench ports must be distinct')
  return database
}

/** A settled operation can still owe cleanup. Keep that obligation after its
 * promise leaves the pending set; an unrelated later success cannot erase it. */
export function createDedicatedOperations({ controller = new AbortController(), closeResources = async () => {} } = {}) {
  const flights = new Set(), cleanupIssues = []
  let closing = false, closePromise
  const mark = value => {
    if (!value || typeof value !== 'object') return
    if (value.nativeResourcesClosed === false || value.cleanupConfirmed === false || value.cleanup?.confirmed === false) {
      cleanupIssues.push({ reason: 'operation-cleanup-unconfirmed' })
    }
    for (const key of ['evidence', 'native', 'receipt']) if (value[key] && value[key] !== value) mark(value[key])
    if (Array.isArray(value.readings)) for (const reading of value.readings) if (reading?.receipt) mark(reading.receipt)
  }
  const run = action => {
    assert.ok(!closing, 'Dedicated runtime is closing')
    const flight = Promise.resolve().then(action).then(value => { mark(value); return value }, error => {
      mark(error)
      throw publicError(error, 'Dedicated runtime operation failed')
    })
    flights.add(flight)
    void flight.then(() => flights.delete(flight), () => flights.delete(flight))
    return flight
  }
  const close = () => {
    if (closePromise) return closePromise
    closing = true; controller.abort()
    closePromise = (async () => {
      const joined = await Promise.allSettled([...flights])
      try { await closeResources() }
      catch { cleanupIssues.push({ reason: 'runtime-resources-cleanup-unconfirmed' }) }
      if (flights.size || cleanupIssues.length) {
        const error = new Error('Dedicated runtime cleanup is unconfirmed')
        error.code = 'DEDICATED_CLEANUP_UNCONFIRMED'
        error.evidence = { cleanupConfirmed: false, pendingOperations: flights.size, cleanupIssues: [...cleanupIssues] }
        throw error
      }
      return { closed: true, cleanupConfirmed: true, operationsJoined: joined.length,
        rejectedOperations: joined.filter(result => result.status === 'rejected').length }
    })()
    return closePromise
  }
  return { run, mark, close, signal: controller.signal }
}

/** No global fetch agent. Every response, ClientRequest and TCP close is
 * joined even on abort, non-200 status or malformed JSON. Headers stay private. */
export async function requestDedicatedJson(port, path, { cookie, method = 'GET', body, signal, timeoutMs = 2_000,
  requestImpl = httpRequest, joinTimeoutMs = 5_000 } = {}) {
  assert.ok(validPort(port) && path.startsWith('/api/') && !path.startsWith('//'), 'Invalid local HTTP target')
  if (cookie) validateHeaderValue('Cookie', cookie)
  const receipt = { port, path, method, startedAtMs: performance.now(), completedAtMs: null, status: null,
    closed: false, cleanupConfirmed: false, timedOut: false, aborted: false }
  let request, response, socket, headers, error, timer, finishing = false
  const closures = [], chunks = []
  const recordClose = resource => closures.push(new Promise(done => resource.once('close', done)))
  const stop = () => {
    receipt.aborted = Boolean(signal?.aborted)
    error ??= new Error('Dedicated HTTP request aborted or timed out')
    request?.destroy(new Error('Dedicated HTTP request aborted')); response?.destroy(); socket?.destroy()
  }
  try {
    assert.ok(!signal?.aborted, 'Local HTTP request aborted before dispatch')
    await new Promise((accept, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      request = requestImpl({ host: '127.0.0.1', family: 4, port, path, method, agent: false,
        headers: { Connection: 'close', ...(cookie ? { Cookie: cookie } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, value => {
        response = value; headers = value.headers; receipt.status = value.statusCode; recordClose(value)
        let length = 0
        value.on('data', bytes => {
          length += bytes.length
          if (length > 1024 * 1024) { error = new Error('Local HTTP body exceeds the limit'); stop() }
          else chunks.push(Buffer.from(bytes))
        })
        value.once('end', accept)
        value.once('error', reject)
        value.once('aborted', () => reject(new Error('Local HTTP response aborted')))
      })
      recordClose(request)
      request.once('socket', value => {
        socket = value; recordClose(value); value.on('error', () => undefined)
        if (finishing) value.destroy()
      })
      request.once('error', reject)
      signal?.addEventListener('abort', stop, { once: true })
      if (signal?.aborted) stop()
      timer = setTimeout(() => { receipt.timedOut = true; stop() }, timeoutMs)
      request.end(payload)
    })
    assert.equal(receipt.status, 200, 'Local HTTP status is not 200')
  } catch (caught) { error ??= publicError(caught, 'Dedicated local HTTP request failed') }
  finally {
    finishing = true
    response?.destroy(); request?.destroy(); socket?.destroy()
    try {
      const joins = (async () => {
        let joined = 0
        do { joined = closures.length; await Promise.all(closures) } while (closures.length !== joined)
      })()
      receipt.closed = await observeSettlement(joins, joinTimeoutMs)
      receipt.cleanupConfirmed = receipt.closed
      if (!receipt.closed) error ??= new Error('Dedicated HTTP resource closure is unconfirmed')
      if (signal?.aborted) { receipt.aborted = true; error ??= new Error('Dedicated HTTP request aborted during resource closure') }
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', stop)
      receipt.completedAtMs = performance.now()
    }
  }
  if (error) { error.evidence = receipt; throw error }
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { const invalid = new Error('Dedicated HTTP JSON is malformed'); invalid.evidence = receipt; throw invalid }
  const result = { value, receipt }
  Object.defineProperty(result, 'headers', { value: headers })
  return result
}

export async function createDedicatedRuntime(input) {
  const database = validateOptions(input)
  const options = { ...input, cells: input.cells.map(cell => ({ ...cell })), workspace: { ...input.workspace }, out: resolve(input.out) }
  const workspace = { landscapeId: options.workspace.landscapeId, versionId: options.workspace.versionId }
  const stopController = new AbortController(), poolErrors = []
  const identity = { project: options.project, recordedAt: new Date().toISOString(), docker: null, database: null, login: null }
  let pool, cookie, fixture, dockerContext, sequence = 0
  const operations = createDedicatedOperations({ controller: stopController, closeResources: async () => {
    cookie = undefined
    if (pool) await pool.end()
    assert.equal(poolErrors.length, 0, 'The dedicated PostgreSQL pool reported an idle connection error')
  } })
  const track = operations.run
  const sanitize = text => {
    // The public configuration probe never returns credentials. Strip complete
    // connection strings/cookies from native diagnostics; replacing a short
    // password in isolation would also alter unrelated project/fixture names.
    for (const secret of [options.databaseUrl, cookie].filter(Boolean)) {
      text = text.split(secret).join('[REDACTED]')
    }
    return text.replace(/postgres(?:ql)?:\/\/[^\s@]+@/g, 'postgres://[REDACTED]@')
  }
  async function command(label, file, args, { env = process.env, timeoutMs } = {}) {
    const result = await captureDedicatedNative(file, args, { cwd: ROOT, env, timeoutMs, signal: stopController.signal })
    operations.mark(result)
    result.stdout = sanitize(result.stdout); result.stderr = sanitize(result.stderr)
    result.receipt.command = [file, ...args]
    const name = String(++sequence).padStart(4, '0') + '-' + label
    const paths = { stdout: resolve(options.out, name + '.stdout.txt'), stderr: resolve(options.out, name + '.stderr.txt') }
    await Promise.all([writeFile(paths.stdout, result.stdout, { flag: 'wx' }), writeFile(paths.stderr, result.stderr, { flag: 'wx' })])
    result.receipt.streams = Object.fromEntries(['stdout', 'stderr'].map(stream => [stream,
      { path: paths[stream], bytes: Buffer.byteLength(result[stream]), sha256: digest(Buffer.from(result[stream])) }]))
    await writeFile(resolve(options.out, name + '.json'), JSON.stringify(result.receipt, null, 2) + '\n', { flag: 'wx' })
    return result
  }
  async function docker(label, args) {
    const result = await command(label, 'docker', [...(dockerContext ? ['--context', dockerContext] : []), ...args])
    if (!result.receipt.closed || result.receipt.code !== 0 || result.receipt.signal || result.receipt.timedOut
      || result.receipt.aborted || result.receipt.spawnError || result.receipt.captureError || result.receipt.killError
      || !result.receipt.cleanupConfirmed) {
      const error = new Error('Dedicated Docker preflight failed: ' + label)
      error.evidence = result.receipt
      throw error
    }
    return result
  }
  async function preflightDocker() {
    const selected = await docker('docker-context-name', ['context', 'show'])
    dockerContext = selected.stdout.trim()
    assert.ok(dockerContext.length > 0 && dockerContext.length < 128, 'Docker context identity is missing')
    const endpoint = JSON.parse((await docker('docker-context-endpoint', ['context', 'inspect', dockerContext,
      '--format', '{{json .Endpoints.docker.Host}}'])).stdout)
    assert.ok(typeof endpoint === 'string' && /^(npipe|unix):\/\//.test(endpoint), 'The dedicated gate requires a local Docker engine')
    const listed = await docker('docker-project-ids', ['ps', '-a', '--no-trunc', '-q', '--filter', 'label=com.docker.compose.project=' + options.project])
    const ids = listed.stdout.trim().split(/\r?\n/).filter(Boolean)
    assert.ok(ids.length >= 6 && ids.every(id => /^[0-9a-f]{64}$/.test(id)), 'Dedicated project inventory is missing')
    const inspected = await docker('docker-project-inspect', ['inspect', '--format', INSPECT, ...ids])
    const rows = inspected.stdout.trim().split(/\r?\n/).map(JSON.parse)
    assert.deepEqual(rows.map(row => row.id).sort(), [...ids].sort(), 'Docker inventory changed during inspection')
    assert.ok(rows.every(row => row.project === options.project), 'Docker project identity differs')
    const one = service => {
      const candidates = rows.filter(row => row.service === service)
      assert.equal(candidates.length, 1, 'Expected exactly one ' + service)
      assert.ok(candidates[0].running && candidates[0].paused === false, service + ' is not running unpaused')
      return candidates[0]
    }
    const mapping = (row, containerPort, port) => {
      assert.ok(row.ports?.[containerPort]?.some(binding => Number(binding.HostPort) === port
        && ['127.0.0.1', '0.0.0.0'].includes(binding.HostIp)), row.service + ' does not publish the requested loopback port')
    }
    for (const cell of options.cells) mapping(one(cell.service), '3001/tcp', cell.port)
    mapping(one('router'), '8080/tcp', options.routerPort)
    mapping(one('postgres'), '5432/tcp', Number(database.port))
    const configuration = []
    const probe = 'import { syncCellPartitionConfig } from "./dist/syncCells/assignment.js";'
      + 'const keys=' + JSON.stringify(ENV_KEYS) + ';'
      + 'process.stdout.write(JSON.stringify({environment:Object.fromEntries(keys.map(key=>[key,process.env[key]??null])),partition:syncCellPartitionConfig(process.env)}))'
    for (const service of [...SERVICES, 'sync-ws-router']) {
      const row = one(service)
      const measured = await docker('docker-config-' + service, ['exec', '-w', '/app', row.id, 'node', '--input-type=module', '-e', probe])
      const value = JSON.parse(measured.stdout)
      assert.equal(value.partition?.topologyGeneration, options.generation, service + ' has another effective generation')
      assert.equal(value.partition?.partitionCount, 2); assert.equal(value.partition?.placementMode, 'placed')
      assert.deepEqual(value.partition?.reservedPartitions, [1])
      assert.equal(value.environment.SYNC_CELL_PLACEMENT_MODE, 'placed')
      assert.equal(value.environment.SYNC_CELL_PARTITION_COUNT, '2')
      assert.equal(value.environment.SYNC_CELL_RESERVED_PARTITIONS, '1')
      if (service !== 'sync-ws-router') {
        assert.equal(value.environment.SYNC_CELL_ID, CELL_IDS[SERVICES.indexOf(service)])
        assert.equal(value.environment.SYNC_CELL_ROLE, service === 'sync-cell-c' ? 'reserved:1' : 'pool')
        assert.equal(value.environment.SYNC_CELL_OWNERSHIP, 'on')
      }
      configuration.push({ id: row.id, service, ...value })
    }
    const pgRow = one('postgres')
    return { context: { name: dockerContext, endpoint }, containers: rows.sort((a, b) => a.id.localeCompare(b.id)), configuration, postgresId: pgRow.id,
      postgresAddresses: Object.values(pgRow.networks ?? {}).flatMap(network => [network.IPAddress, network.GlobalIPv6Address]).filter(Boolean) }
  }
  const census = () => track(async () => (await pool.query("SELECT landscape_id, id FROM versions WHERE status = 'active'")).rows)
  async function loadFixture() {
    const result = await pool.query('SELECT landscape_id, id, root_url, status FROM versions WHERE landscape_id=$1 AND id=$2',
      [workspace.landscapeId, workspace.versionId])
    assert.equal(result.rows.length, 1, 'The target version is missing or ambiguous')
    const row = result.rows[0]
    assert.equal(row.status, 'active'); assert.ok(isValidAutomergeUrl(row.root_url), 'Target root URL is invalid')
    return { ...workspace, rootUrl: row.root_url }
  }
  function checkPlacement(rows) {
    assert.equal(rows.length, 1, 'Exactly one placement row for the target workspace is required')
    const row = rows[0]
    assert.equal(row.landscape_id, workspace.landscapeId); assert.equal(row.version_id, workspace.versionId)
    assert.equal(row.topology_generation, options.generation, 'Target placement generation differs')
    assert.ok(row.partition === 0 || row.partition === 1, 'Invalid target partition')
    return row
  }
  const placement = () => track(async () => checkPlacement((await pool.query(
    'SELECT landscape_id, version_id, partition, topology_generation, updated_at FROM workspace_placement WHERE landscape_id=$1 AND version_id=$2',
    [workspace.landscapeId, workspace.versionId])).rows))
  const readCells = () => track(async () => {
    const results = await Promise.allSettled(options.cells.map(async cell => {
      const result = await requestDedicatedJson(cell.port, '/api/platform/sync-cell', { cookie, signal: stopController.signal })
      assert.equal(result.value.cellId, cell.cellId, 'HTTP cell identity differs from its port')
      return { cellId: cell.cellId, state: result.value, startedAtMs: result.receipt.startedAtMs,
        completedAtMs: result.receipt.completedAtMs, receipt: result.receipt }
    }))
    const failed = results.filter(result => result.status === 'rejected')
    for (const result of failed) operations.mark(result.reason)
    if (failed.length) {
      const error = new Error('One or more dedicated cell reads failed')
      error.evidence = { readings: results.map((result, index) => result.status === 'fulfilled' ? result.value
        : { cellId: options.cells[index].cellId, failure: publicError(result.reason, 'Cell request failed').message,
          receipt: result.reason.evidence ?? null }), allRequestsJoined: true }
      throw error
    }
    return { readings: results.map(result => result.value) }
  })
  const move = (from, to) => track(async () => {
    assert.ok((from === 0 || from === 1) && to === 1 - from, 'A move must change between the two partitions')
    const client = await pool.connect()
    let inTransaction = false, connectionError, failure, commit
    const onError = error => { connectionError = error }
    client.on('error', onError)
    try {
      await client.query('BEGIN'); inTransaction = true
      const before = checkPlacement((await client.query(
        'SELECT landscape_id, version_id, partition, topology_generation, updated_at FROM workspace_placement WHERE landscape_id=$1 AND version_id=$2 FOR UPDATE',
        [workspace.landscapeId, workspace.versionId])).rows)
      assert.equal(before.partition, from, 'Placement moved before the requested transaction')
      const transaction = await client.query('SELECT txid_current()::text AS id')
      const updated = await client.query(
        'UPDATE workspace_placement SET partition=$1, updated_at=NOW() WHERE landscape_id=$2 AND version_id=$3 AND topology_generation=$4 AND partition=$5 RETURNING landscape_id, version_id, partition, topology_generation, updated_at',
        [to, workspace.landscapeId, workspace.versionId, options.generation, from])
      const after = checkPlacement(updated.rows)
      assert.equal(updated.rowCount, 1); assert.equal(after.partition, to)
      commit = { startedAtMs: performance.now(), completedAtMs: null }
      await client.query('COMMIT')
      commit.completedAtMs = performance.now(); inTransaction = false
      assert.ok(!connectionError, 'Placement connection failed')
      return { from, to, rowCount: updated.rowCount, transactionId: transaction.rows[0].id, before, after, commit }
    } catch (error) {
      failure = error
      if (inTransaction) {
        try { await client.query('ROLLBACK'); inTransaction = false }
        catch (rollbackError) { connectionError ??= rollbackError }
      }
      const reported = publicError(error, 'Dedicated placement transaction failed')
      reported.evidence = { commit: commit ?? null, rollbackConfirmed: !inTransaction, connectionFailed: Boolean(connectionError) }
      throw reported
    } finally {
      client.release(connectionError || (failure && inTransaction ? failure : undefined))
      client.removeListener('error', onError)
    }
  })
  const readFence = () => track(async () => {
    const result = await pool.query(
      'SELECT cell_id, fencing_token::text AS token, released_at FROM sync_workspace_ownership WHERE landscape_id=$1 AND version_id=$2',
      [workspace.landscapeId, workspace.versionId])
    assert.ok(result.rows.length <= 1, 'Durable workspace ownership is ambiguous')
    const row = result.rows[0] ?? null
    if (row) assert.ok(typeof row.token === 'string' && /^[1-9][0-9]*$/.test(row.token), 'Durable fencing token is invalid')
    return row
  })
  const readCold = expected => track(() => coldRead({ fixture, cookie, expected,
    baseUrl: 'http://127.0.0.1:' + options.routerPort, signal: stopController.signal }))
  const verifyIdentity = () => track(async () => {
    const final = await preflightDocker()
    assert.deepEqual(final, identity.docker, 'Dedicated Docker processes or configuration changed during the campaign')
    return { ...final, unchanged: true }
  })
  const fsck = () => track(async () => {
    const candidates = [resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
    const npm = candidates.find(path => existsSync(path))
    assert.ok(npm, 'Cannot locate npm-cli.js beside the active Node runtime')
    const result = await command('fsck', process.execPath, [npm, '--prefix', 'server', 'run', 'fsck', '--',
      '--landscape-id', workspace.landscapeId, '--version-id', workspace.versionId, '--json'], {
      env: { ...process.env, DATABASE_URL: options.databaseUrl, DB_CONNECTION_TIMEOUT_MS: '2000', DB_SSL_MODE: 'disable',
        PGOPTIONS: '-c statement_timeout=5000 -c lock_timeout=2000', FORCE_COLOR: '0' }, timeoutMs: 180_000,
    })
    return { native: result.receipt, stdout: result.stdout, stderr: result.stderr }
  })
  const close = operations.close
  try {
    await mkdir(options.out, { recursive: true })
    identity.docker = await preflightDocker()
    pool = new Pool({ connectionString: options.databaseUrl, max: 2, connectionTimeoutMillis: 2_000, idleTimeoutMillis: 1_000,
      statement_timeout: 5_000, lock_timeout: 2_000, idle_in_transaction_session_timeout: 5_000, application_name: 'maplespire-dedicated-gate' })
    pool.on('error', error => poolErrors.push({ code: publicError(error, 'PostgreSQL idle error').code ?? null }))
    const actual = await pool.query("SELECT current_database() AS database, host(inet_server_addr()) AS server_address, inet_server_port() AS server_port, pg_backend_pid() AS backend_pid, current_setting('statement_timeout') AS statement_timeout")
    assert.equal(actual.rows.length, 1)
    identity.database = actual.rows[0]
    assert.equal(identity.database.database, database.pathname.slice(1), 'Connected database name differs')
    assert.equal(identity.database.server_port, 5432, 'Connected database server port differs')
    assert.ok(identity.docker.postgresAddresses.includes(identity.database.server_address), 'Connected database address is not the inspected PostgreSQL container')
    assert.equal(identity.database.statement_timeout, '5s', 'PostgreSQL statement bound was not applied')
    const before = await census()
    assertDedicatedCensus(before, workspace)
    fixture = await loadFixture()
    const accounts = await pool.query('SELECT id, email, is_platform_admin FROM users WHERE email=$1', [options.loginEmail])
    assert.equal(accounts.rows.length, 1, 'Dedicated login must already exist without provisioning')
    assert.equal(accounts.rows[0].is_platform_admin, true, 'Dedicated login is not an existing platform admin')
    const loginCell = options.cells.find(cell => cell.cellId === 'failover-cell-a')
    const login = await requestDedicatedJson(loginCell.port, '/api/auth/dev-login', { method: 'POST', body: { email: options.loginEmail },
      signal: stopController.signal, timeoutMs: 15_000 })
    assert.equal(login.value.user?.isPlatformAdmin, true, 'Login is not platform admin')
    assert.equal(login.value.user.id, accounts.rows[0].id, 'Login changed user identity')
    const cookies = (login.headers['set-cookie'] ?? []).map(value => value.split(';')[0]).filter(value => /^maplespire_session=/.test(value))
    assert.equal(cookies.length, 1, 'Login did not return exactly one session cookie')
    cookie = cookies[0]
    assert.match(cookie, /^maplespire_session=[^;\s]+$/)
    assert.deepEqual(await census(), before, 'Login changed the ownable census')
    assert.deepEqual(await loadFixture(), fixture, 'Login changed the target root')
    identity.login = { userId: login.value.user.id, orgId: login.value.orgId ?? null, platformAdmin: true,
      receipt: login.receipt, censusAndRootUnchanged: true }
    assertDedicatedTopology((await readCells()).readings.map(reading => reading.state), { generation: options.generation })
    await placement()
    return { identity, fixture: { ...fixture }, now: () => performance.now(), census, readCells, placement, move, readFence, readCold, fsck, verifyIdentity, close }
  } catch (error) {
    operations.mark(error)
    let cleanup
    try { cleanup = await close() } catch (cleanupError) { cleanup = { closed: false, error: publicError(cleanupError, 'Dedicated cleanup failed').message } }
    const failure = publicError(error, 'Dedicated runtime preflight failed')
    failure.evidence = { identity, cleanup, operation: error.evidence ?? null }
    throw failure
  }
}
