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

import test, { after } from 'node:test'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createFaultIo } from './io.mjs'
import { kubernetesRedisOptions, getJson, assertOwnershipRefusal, joinHttpWitness, observePublicOutage } from './lab.mjs'
import { deleteCriticalRedis } from './engine.mjs'
import { classifyReadiness, classifyOwnership, classifyEndpoints } from './observe.mjs'
import { readRedisWitness } from './redis-witness.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const tempParent = fs.realpathSync(tmpdir())
const out = fs.mkdtempSync(path.join(tempParent, 'maplespire-kubernetes-redis-gate-'))
after(() => {
  const actual = fs.realpathSync(out)
  assert.equal(path.dirname(actual), tempParent)
  assert.match(path.basename(actual), /^maplespire-kubernetes-redis-gate-/)
  assert.equal(fs.lstatSync(out).isSymbolicLink(), false)
  fs.rmSync(out, { recursive: true })
})
const requireServer = createRequire(new URL('../../../server/package.json', import.meta.url))
const A = requireServer('@automerge/automerge')
const clone = value => structuredClone(value)
const sha = value => createHash('sha256').update(value).digest('hex')
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const response = body => ({ error: null, status: 200, body })
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const baseArgs = ['--redis-outage', '--kubernetes-local-config', path.join(out, 'synthetic-config.json'), '--kubernetes-out', path.join(out, 'synthetic-gate-output'), '--kubernetes-run-id', 'b516a-qa-local']

test('CLI: explicit one-cell mode parses without any runtime and Compose remains separate', () => {
  assert.deepEqual(kubernetesRedisOptions(baseArgs), { configFile: baseArgs[2], out: baseArgs[4], runId: baseArgs[6] })
  assert.equal(kubernetesRedisOptions(['--redis-outage']), null)
})

for (const [label, change] of [
  ['dedicated mixed with Kubernetes', a => [...a, '--dedicated']],
  ['Compose observer mixed with Kubernetes', a => [...a, '--observe-out', path.join(out, 'wrong-observer')]],
  ['unknown Kubernetes flag', a => [...a, '--kubernetes-unknown', 'value']],
  ['duplicate option', a => [...a, '--kubernetes-run-id', 'b516a-second']],
  ['missing outage flag', a => a.slice(1)],
  ['duplicate outage flag', a => [...a, '--redis-outage']],
  ['relative configuration', a => a.map((v, i) => i === 2 ? 'relative.json' : v)],
  ['empty output', a => a.map((v, i) => i === 4 ? '' : v)],
]) test('CLI refuses ' + label, () => assert.throws(() => kubernetesRedisOptions(change(baseArgs))))

for (const extra of [['--dedicated'], ['--observe-out', path.join(out, 'observer')]]) {
  test('real CLI rejects mixed mode before any command: ' + extra[0], { timeout: 15000 }, async () => {
    const guardFile = path.join(out, 'guard-' + extra[0].slice(2) + '.jsonl')
    const child = spawn(process.execPath, ['--import', new URL('./gate-no-external.fixture.mjs', import.meta.url).href,
      path.join(root, 'server/scripts/verify-sync-cell-failover.mjs'), ...baseArgs, ...extra], {
      cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, B516B_QA_GUARD_LOG: guardFile, NODE_EXTRA_CA_CERTS: '' },
    })
    const chunks = [], errors = []
    child.stdout.on('data', b => chunks.push(b)); child.stderr.on('data', b => errors.push(b))
    const timer = setTimeout(() => child.kill(), 10000)
    const closed = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
    clearTimeout(timer)
    fs.writeFileSync(guardFile + '.stdout.log', Buffer.concat(chunks), { flag: 'wx' })
    fs.writeFileSync(guardFile + '.stderr.log', Buffer.concat(errors), { flag: 'wx' })
    fs.writeFileSync(guardFile + '.native.json', JSON.stringify({ ...closed, pid: child.pid, nativeCloseConfirmed: true }) + '\n', { flag: 'wx' })
    assert.equal(closed.code, 1); assert.equal(closed.signal, null)
    assert.match(Buffer.concat(errors).toString(), /INVALID_KUBERNETES_OPTIONS/)
    assert.equal(fs.existsSync(guardFile), false, 'no intercepted command or transport may be called')
    assert.doesNotMatch(Buffer.concat(chunks).toString(), /"outcome":"passed"/)
  })
}

test('readiness controls distinguish completed application replies and unknowns', () => {
  assert.equal(classifyReadiness({ ...response({ status: 'ready', checks: { redis: true } }) }).state, 'ready')
  const failed = { status: 503, error: null, body: { status: 'not-ready', checks: { redis: false } } }
  assert.equal(classifyReadiness(failed).state, 'redis-unready')
  for (const bad of [null, { ...failed, error: 'timeout' }, { ...failed, status: 502 }, { ...failed, body: null },
    { ...failed, body: { status: 'ready', checks: { redis: false } } },
    { ...failed, body: { status: 'not-ready', checks: { redis: true, database: false } } },
    { ...failed, status: 200 }]) assert.equal(classifyReadiness(bad).state, 'unknown')
})

test('ownership has positive owner and revoked controls plus identity/schema refusals', () => {
  const before = response({ processBootId: uuid(1) }), after = clone(before)
  const owner = response({ enabled: true, partitionCount: 1, partitionIndex: 0, ready: true, partitionReady: true, partitionLossCount: 2, partitionAcquisitionCount: 3 })
  assert.equal(classifyOwnership(before, owner, after, uuid(1)).state, 'owner')
  const revoked = response({ ...owner.body, partitionIndex: null, ready: false, partitionReady: false, partitionLossCount: 3 })
  assert.equal(classifyOwnership(before, revoked, after, uuid(1)).state, 'unassigned')
  for (const change of [b => { b.enabled = false }, b => { b.partitionCount = 2 }, b => { b.partitionReady = true },
    b => { delete b.partitionLossCount }, b => { b.partitionAcquisitionCount = -1 }]) {
    const bad = clone(revoked); change(bad.body)
    assert.equal(classifyOwnership(before, bad, after, uuid(1)).state, 'unknown')
  }
  assert.equal(classifyOwnership(before, revoked, response({ processBootId: uuid(2) }), uuid(1)).state, 'unknown')
  assert.equal(classifyOwnership(before, { ...revoked, error: 'timeout' }, after, uuid(1)).state, 'unknown')
})

const serviceExpected = { namespace: 'maplespire-b516a-3176', serviceName: 'maplespire-backend', serviceUid: uuid(8), podName: 'maplespire-backend-current-qa', podUid: uuid(9) }
function endpointFixture(ready) {
  const e = serviceExpected
  const service = response({ kind: 'Service', metadata: { name: e.serviceName, namespace: e.namespace, uid: e.serviceUid }, spec: { selector: { app: 'qa-backend' }, ports: [{ port: 3001 }] } })
  const pod = response({ kind: 'Pod', metadata: { name: e.podName, namespace: e.namespace, uid: e.podUid, labels: { app: 'qa-backend' } }, status: { podIPs: [{ ip: '10.1.2.3' }, { ip: '10.1.2.4' }], conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }], containerStatuses: [{ name: 'backend', restartCount: 0 }] } })
  const slice = { metadata: { uid: uuid(10), namespace: e.namespace, labels: { 'kubernetes.io/service-name': e.serviceName }, ownerReferences: [{ kind: 'Service', uid: e.serviceUid }] }, ports: [{ port: 3001 }], endpoints: [{ targetRef: { kind: 'Pod', name: e.podName, namespace: e.namespace, uid: e.podUid }, addresses: ['10.1.2.3'], conditions: { ready } }] }
  const slices = response({ kind: 'EndpointSliceList', apiVersion: 'discovery.k8s.io/v1', metadata: { resourceVersion: '2181', continue: '' }, items: [slice] })
  return { service, pod, slices }
}
test('Service controls include whole-list readiness and a second live slice', () => {
  assert.equal(classifyEndpoints(endpointFixture(true), serviceExpected).state, 'routable')
  const withdrawn = endpointFixture(false)
  assert.equal(classifyEndpoints(withdrawn, serviceExpected).state, 'withdrawn')
  const second = clone(withdrawn.slices.body.items[0]); second.metadata.uid = uuid(11)
  second.endpoints[0].addresses = ['10.1.2.4']; second.endpoints[0].conditions.ready = true
  withdrawn.slices.body.items.push(second)
  assert.equal(classifyEndpoints(withdrawn, serviceExpected).state, 'routable')
})
for (const [label, change] of [
  ['partial LIST', f => { f.slices.body.metadata.continue = 'more' }],
  ['no resourceVersion', f => { delete f.slices.body.metadata.resourceVersion }],
  ['ready unknown', f => { delete f.slices.body.items[0].endpoints[0].conditions.ready }],
  ['wrong Pod UID', f => { f.slices.body.items[0].endpoints[0].targetRef.uid = uuid(99) }],
  ['wrong Service UID', f => { f.service.body.metadata.uid = uuid(99) }],
  ['unready addresses published', f => { f.service.body.spec.publishNotReadyAddresses = true }],
]) test('Service unknown refuses withdrawal: ' + label, () => {
  const f = endpointFixture(false); change(f)
  assert.equal(classifyEndpoints(f, serviceExpected).state, 'unknown')
})

async function httpFixture(t, handler) {
  const connections = new Set(), closeFlights = []
  const server = http.createServer(handler)
  server.on('connection', socket => {
    connections.add(socket)
    closeFlights.push(new Promise(resolve => socket.once('close', () => { connections.delete(socket); resolve() })))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => {
    for (const socket of connections) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    await Promise.all(closeFlights)
    assert.equal(connections.size, 0, 'fixture listener and accepted sockets joined')
  })
  return { server, connections, origin: 'http://localhost:' + server.address().port }
}

test('real HTTP sends the gate mutation; offline CRDT edits are a distinct operand', { timeout: 10000 }, async t => {
  const requests = [], gateSource = fs.readFileSync(path.join(root, 'server/scripts/verify-sync-cell-redis-kubernetes.mjs'), 'utf8')
  const start = gateSource.indexOf('  const write = (origin, marker) => getJson(')
  const end = gateSource.indexOf('  result.controls.healthyWrite = ', start)
  assert.ok(start >= 0 && end > start, 'exact gate write factory anchor')
  const factory = new Function('getJson', 'lab', 'manualMutation', gateSource.slice(start, end) + '\nreturn write')
  let backendValue = 'initial'
  const f = await httpFixture(t, (req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks))
      requests.push({ method: req.method, url: req.url, host: req.headers.host, cookie: req.headers.cookie, body })
      const marker = body.input.properties.b516bWriteProbe
      if (marker === 'qa-healthy') { backendValue = marker; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"result":{"updated":true}}') }
      else { res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' }); res.end('{"error":"workspace owner unavailable","retryable":true}') }
    })
  })
  const lab = { cookie: 'maplespire_session=qa-fictional', workspace: { landscapeId: 'qa-landscape', versionId: 'qa-version' } }
  const write = factory(getJson, lab, { id: 'qa-object', healthy: 'qa-healthy', outage: 'qa-outage' })
  const healthy = await write(f.origin, 'qa-healthy'); assert.equal(healthy.status, 200)
  let doc = A.from({ marker: 'qa-healthy' })
  doc = A.change(doc, d => { d.marker = 'qa-local-only' })
  assert.equal(requests.length, 1, 'the offline change sent no HTTP request')
  const refused = await write(f.origin, 'qa-outage')
  assert.equal(refused.status, 503); assert.equal(refused.nativeClosed, true)
  assert.equal(refused.body.retryable, true); assert.equal(backendValue, 'qa-healthy')
  assert.equal(A.load(A.save(doc)).marker, 'qa-local-only')
  assert.equal(requests.length, 2)
  assert.deepEqual(requests.map(r => [r.method, r.url]), [['POST', '/api/ai/tools/update_model_object'], ['POST', '/api/ai/tools/update_model_object']])
  assert.equal(requests[1].body.input.properties.b516bWriteProbe, 'qa-outage')
  assert.equal(requests[1].body.landscapeId, 'qa-landscape'); assert.match(requests[1].host, /^localhost:/)
  assert.equal(requests[1].cookie, lab.cookie)
})

test('real HTTP preserves proxy body as non-JSON rather than application refusal', { timeout: 10000 }, async t => {
  const f = await httpFixture(t, (_req, res) => { res.writeHead(503); res.end('proxy unavailable') })
  const value = await getJson(f.origin, '/ready')
  assert.equal(value.status, 503); assert.equal(value.body, null); assert.equal(value.nativeClosed, true)
  assert.equal(value.bodySha256, sha('proxy unavailable'))
  assert.equal(classifyReadiness({ ...value, error: null }).state, 'unknown')
})

test('real HTTP rejects a suspended 503 body and closes its socket', { timeout: 10000 }, async t => {
  const f = await httpFixture(t, (_req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.write('{"error":') })
  await assert.rejects(getJson(f.origin, '/ready', { timeoutMs: 100 }), /HTTP_TIMEOUT/)
})

test('public observation preserves completed proxy 502/503 separately from ownership refusal', { timeout: 10000 }, async t => {
  let status = 502
  const f = await httpFixture(t, (_req, res) => { res.writeHead(status); res.end('fixture proxy unavailable') })
  for (status of [502, 503]) {
    const value = await observePublicOutage(f.origin, '/public', { timeoutMs: 1000 })
    assert.equal(value.status, status)
    assert.equal(value.classification, 'complete-unavailable-response')
    assert.equal(value.nativeClosed, true)
    assert.equal(value.body, null)
    assert.throws(() => assertOwnershipRefusal(value))
  }
})

test('public no-header deadline is closed unknown and cannot qualify direct ownership/readiness', { timeout: 10000 }, async t => {
  let received = 0
  const f = await httpFixture(t, () => { received++ })
  const source = fs.readFileSync(path.join(root, 'server/scripts/verify-sync-cell-redis-kubernetes.mjs'), 'utf8')
  const statement = source.split('\n').find(line => line.includes('result.controls.publicOutageRead = await observePublicOutage('))
  assert.ok(statement, 'exact public GET observation call')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const call = new AsyncFunction('observePublicOutage', 'lab', 'readRoute', 'result', statement + '\nreturn result.controls.publicOutageRead')
  const value = await call((origin, route, options) => observePublicOutage(origin, route, { ...options, timeoutMs: 200 }),
    { serviceOrigin: f.origin, cookie: 'qa-fictional' }, '/public', { controls: {} })
  assert.equal(received, 1)
  assert.equal(value.status, null)
  assert.equal(value.error, 'HTTP_TIMEOUT')
  assert.equal(value.nativeClosed, true)
  assert.equal(value.bodyComplete, false)
  assert.equal(value.classification, 'unknown')
  assert.equal(value.reason, 'local-deadline-without-response')
  assert.throws(() => assertOwnershipRefusal(value))
  assert.equal(classifyReadiness(value).state, 'unknown')
})

test('public headers 200 followed by a suspended body are rejected after native close', { timeout: 10000 }, async t => {
  const f = await httpFixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"held":') })
  await assert.rejects(observePublicOutage(f.origin, '/public', { timeoutMs: 200 }), error => {
    assert.equal(error.message, 'HTTP_TIMEOUT')
    assert.equal(error.httpEvidence.status, 200)
    assert.equal(error.httpEvidence.bodyComplete, false)
    assert.equal(error.httpEvidence.nativeClosed, true)
    return true
  })
})

test('public transport error without headers remains rejected rather than unknown', { timeout: 10000 }, async t => {
  const f = await httpFixture(t, req => req.socket.destroy())
  await assert.rejects(observePublicOutage(f.origin, '/public', { timeoutMs: 1000 }), error => {
    assert.equal(error.message, 'HTTP_TRANSPORT_ERROR')
    assert.equal(error.httpEvidence.status, null)
    assert.equal(error.httpEvidence.nativeClosed, true)
    assert.equal(error.httpEvidence.bodyComplete, false)
    return true
  })
})

test('real upgrade refusal accepts a completed 503 but refuses an actual 101', { timeout: 10000 }, async t => {
  let allow = false
  const f = await httpFixture(t, (_req, res) => { res.writeHead(404); res.end() })
  f.server.on('upgrade', (req, socket) => {
    if (!allow) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    else {
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    }
  })
  const refused = await getJson(f.origin, '/automerge', { upgrade: true })
  assert.equal(refused.status, 503); assert.equal(refused.nativeClosed, true)
  allow = true
  await assert.rejects(getJson(f.origin, '/automerge', { upgrade: true, timeoutMs: 500 }), /UNEXPECTED_ACCEPTED_UPGRADE/)
})

test('actual gate joins a failed first request and a suspended second HTTP socket before rejecting', { timeout: 10000 }, async t => {
  assert.deepEqual(await joinHttpWitness([Promise.resolve('first'), Promise.resolve('second')]), ['first', 'second'])
  const source = fs.readFileSync(path.join(root, 'server/scripts/verify-sync-cell-redis-kubernetes.mjs'), 'utf8')
  const start = source.indexOf('      const [upgrade, mutation, directRead] = await joinHttpWitness([')
  const end = source.indexOf('      result.controls.outageUpgrade = upgrade', start)
  assert.ok(start >= 0 && end > start, 'exact gate HTTP trio anchor')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const operation = new AsyncFunction('joinHttpWitness', 'getJson', 'lab', 'wsRoute', 'write', 'manualMutation', 'readRoute',
    source.slice(start, end) + '\nreturn { upgrade, mutation, directRead }')
  const firstDone = deferred(), heldReady = deferred(), requests = []
  let held, firstFailure, secondClosed = false, returned = false, outcome
  const f = await httpFixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url === '/held') { held = res; res.write('{"held":'); heldReady.resolve() }
    else res.end('{"ready":true}')
  })
  f.server.on('upgrade', (_req, socket) => socket.destroy())
  const request = (...args) => {
    const flight = getJson(...args)
    requests.push(flight)
    if (args[1] === '/first') void flight.catch(error => { firstFailure = error; firstDone.resolve() })
    if (args[1] === '/held') void flight.then(value => { secondClosed = value.nativeClosed }, () => {})
    return flight
  }
  const joined = operation(joinHttpWitness, request, { directOrigin: f.origin, cookie: 'qa-fictional' }, '/first',
    origin => request(origin, '/held'), { outage: 'qa-outage' }, '/healthy').then(
    value => { returned = true; outcome = { value } }, error => { returned = true; outcome = { error } })
  try {
    await Promise.all([firstDone.promise, heldReady.promise]); await tick()
    assert.equal(returned, false, 'first error must not detach the suspended sibling')
    assert.equal(secondClosed, false)
    held.end('true}')
    await joined
    assert.equal(secondClosed, true, 'second request resolved only after its native socket close')
    assert.equal(outcome.error, firstFailure, 'the original rejection is propagated after joining')
    assert.equal(requests.length, 3)
  } finally {
    if (held && !held.writableEnded) held.end('true}')
    await Promise.allSettled(requests)
    await joined
  }
})

function actualOutageGuard() {
  const source = fs.readFileSync(path.join(root, 'server/scripts/verify-sync-cell-redis-kubernetes.mjs'), 'utf8')
  const start = source.indexOf('      for (const response of [upgrade, mutation, directRead])')
  const end = source.indexOf("      await waitFor('SERVICE_WITHDRAWAL_NOT_OBSERVED'", start)
  assert.ok(start >= 0 && end > start, 'exact outage guard anchor')
  const exactGuard = new Function('assert', 'assertOwnershipRefusal', 'upgrade', 'mutation', 'directRead', source.slice(start, end))
  return (upgrade, mutation, directRead) => exactGuard(assert, assertOwnershipRefusal, upgrade, mutation, directRead)
}
test('actual gate outage guard has healthy and missing-body controls', () => {
  const guard = actualOutageGuard(), good = { status: 503, nativeClosed: true, body: { error: 'workspace owner unavailable', retryable: true } }
  guard({ status: 503 }, good, good)
  assert.throws(() => guard({ status: 503 }, { status: 503, body: null }, good))
  assert.throws(() => guard({ status: 101 }, good, good))
})
test('actual gate outage guard must reject a 503 JSON unrelated to ownership', () => {
  const guard = actualOutageGuard(), unrelated = { status: 503, nativeClosed: true, body: { error: 'fixture maintenance', retryable: true } }
  assert.throws(() => guard({ status: 503 }, unrelated, unrelated), 'unrelated JSON is not an ownership refusal')
})
test('pure refusal guard accepts both product routing forms and refuses unknown closure/body/status', () => {
  const good = { status: 503, nativeClosed: true, body: { error: 'workspace routing unavailable', retryable: true } }
  assertOwnershipRefusal(good)
  assertOwnershipRefusal({ ...good, body: { error: 'workspace owner unavailable', retryable: true } })
  for (const bad of [{ ...good, nativeClosed: false }, { ...good, status: null }, { ...good, status: 502 },
    { ...good, body: null }, { ...good, body: { error: 'workspace owner unavailable', retryable: false } },
    { ...good, body: { error: 'other reason', retryable: true } }]) assert.throws(() => assertOwnershipRefusal(bad))
})

function engineFixture(options = {}) {
  const expected = { namespace: 'maplespire-b516a-3176-deps', namespaceUid: uuid(21), name: 'redis-critical', uid: uuid(22) }
  const manifest = { apiVersion: 'v1', kind: 'Pod', metadata: { name: expected.name, namespace: expected.namespace, labels: { 'maplespire.io/lab': 'b516a-3176' } },
    spec: { containers: [{ name: 'redis', image: 'redis@sha256:' + '1'.repeat(64) }], volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'redis-critical-data' } }] } }
  let pod = { ...clone(manifest), metadata: { ...clone(manifest.metadata), uid: expected.uid }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }
  if (options.badClaim) pod.spec.volumes[0].persistentVolumeClaim.claimName = 'foreign-data'
  let now = 100, deletes = 0, creates = 0, restoreEntries = 0, witnessCalls = 0, deleted = false
  const calls = [], records = [], replaced = deferred(), witnessEnd = deferred(), controller = new AbortController()
  const reply = value => ({ ok: true, code: 0, nativeCloseConfirmed: true, stdout: value === null ? '' : JSON.stringify(value) })
  const runKubectl = async (args, request) => {
    calls.push({ args: [...args], at: now })
    if (args[0] === 'get' && args[1] === 'namespace') {
      if (deleted && options.failFirstRestore && restoreEntries === 1) return { ...reply(null), ok: false }
      return reply({ metadata: { uid: expected.namespaceUid } })
    }
    if (args[0] === '-n' && args[2] === 'get' && args[3] === 'pod') return reply(pod)
    if (args[0] === 'delete') {
      deletes++; deleted = true
      assert.equal(JSON.parse(request.input).preconditions.uid, expected.uid)
      pod = null
      if (options.foreignReplacement) pod = { ...clone(manifest), metadata: { ...manifest.metadata, uid: uuid(99) }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }
      return options.deleteUnknown ? { ...reply(null), ok: false, nativeCloseConfirmed: false } : reply({ kind: 'Status', status: 'Success' })
    }
    if (args[0] === 'create') {
      creates++
      const actual = JSON.parse(request.input)
      assert.equal(actual.spec.volumes[0].persistentVolumeClaim.claimName, 'redis-critical-data')
      pod = { ...actual, metadata: { ...actual.metadata, uid: uuid(23) }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }
      return options.createUnknown ? { ...reply(null), ok: false } : reply(pod)
    }
    throw new Error('QA_UNEXPECTED_SIMULATED_COMMAND')
  }
  const promise = deleteCriticalRedis({ expected, manifest, runId: 'b516a-qa-local', runKubectl, signal: controller.signal,
    freshAdmission: async () => { if (options.abortBefore) controller.abort(); return { complete: true, observedAt: now } },
    onRecord: row => {
      records.push(row)
      if (row.kind === 'restore-entered') restoreEntries++
      if (row.kind === 'replacement-ready') replaced.resolve(row)
      if (options.sinkFails && row.kind === 'delete-response') throw new Error('QA_SINK_FAILED')
    },
    witnessUnavailable: async () => {
      witnessCalls++
      if (options.abortWitness) controller.abort()
      if (options.delayWitness) await witnessEnd.promise
      if (options.rejectWitness) throw new Error('QA_WITNESS_FAILED')
      return { unavailable: options.unknownWitness ? false : true }
    },
  }, { now: () => now, wait: async ms => { now += ms; await Promise.resolve() } })
  return { promise, records, calls, replaced, witnessEnd, counts: () => ({ deletes, creates, witnessCalls, restoreEntries }), finishWitness: () => witnessEnd.resolve() }
}

test('engine sane simulated DELETE restores exactly once on same claim', async () => {
  const f = engineFixture(), r = await f.promise
  assert.equal(r.successful, true); assert.equal(r.restored, true)
  assert.deepEqual(f.counts(), { deletes: 1, creates: 1, witnessCalls: 1, restoreEntries: 1 })
  assert.equal(r.restoreDueAt - r.absenceAt, 45000)
  assert.equal(f.calls.find(c => c.args[0] === 'create').at, r.restoreDueAt)
})
test('engine ambiguous DELETE response still reconciles but cannot pass', async () => {
  const f = engineFixture({ deleteUnknown: true }), r = await f.promise
  assert.equal(r.successful, false); assert.equal(r.restored, true)
  assert.equal(f.counts().deletes, 1); assert.equal(f.counts().creates, 1); assert.equal(f.counts().witnessCalls, 0)
  assert.ok(r.failures.some(x => x.code === 'DELETE_RESPONSE_UNKNOWN'))
})
test('engine ambiguous CREATE is observed without creating a second time', async () => {
  const f = engineFixture({ createUnknown: true }), r = await f.promise
  assert.equal(r.restored, true); assert.equal(f.counts().creates, 1)
  assert.ok(r.events.some(e => e.kind === 'create-response-unknown'))
  assert.ok(r.events.some(e => e.kind === 'replacement-ready'))
})
test('engine restores before joining delayed witness and stays pending until join', async () => {
  const f = engineFixture({ delayWitness: true })
  let settled = false; void f.promise.then(() => { settled = true })
  await f.replaced.promise; await tick()
  assert.equal(settled, false); assert.equal(f.counts().creates, 1)
  assert.equal(f.calls.find(c => c.args[0] === 'create').at, 45100)
  f.finishWitness(); assert.equal((await f.promise).successful, true)
})
test('engine retries reconciliation after its first read failed and still joins witness', async () => {
  const f = engineFixture({ failFirstRestore: true, delayWitness: true })
  let settled = false; void f.promise.then(() => { settled = true })
  await f.replaced.promise; await tick(); assert.equal(settled, false)
  f.finishWitness(); const r = await f.promise
  assert.equal(r.restored, true); assert.equal(r.successful, false)
  assert.equal(f.counts().restoreEntries, 2); assert.equal(f.counts().creates, 1)
})
test('engine abort during witness restores early and joins instead of reporting success', async () => {
  const f = engineFixture({ abortWitness: true, delayWitness: true })
  let settled = false; void f.promise.then(() => { settled = true })
  await f.replaced.promise; await tick(); assert.equal(settled, false)
  f.finishWitness(); const r = await f.promise
  assert.equal(r.restored, true); assert.equal(r.successful, false)
  assert.ok(r.events.find(e => e.kind === 'hold-ended').early)
})
for (const [label, options] of [['abort before DELETE', { abortBefore: true }], ['wrong initial PVC', { badClaim: true }]]) {
  test('engine never deletes on ' + label, async () => {
    const f = engineFixture(options), r = await f.promise
    assert.equal(r.successful, false); assert.equal(f.counts().deletes, 0); assert.equal(f.counts().creates, 0)
  })
}
for (const [label, options] of [['evidence sink failure', { sinkFails: true }], ['witness rejection', { rejectWitness: true }], ['unknown witness', { unknownWitness: true }]]) {
  test('engine red outcome after ' + label + ' still restores', async () => {
    const f = engineFixture(options), r = await f.promise
    assert.equal(r.successful, false); assert.equal(r.restored, true); assert.equal(f.counts().creates, 1)
  })
}
test('engine refuses to overwrite a foreign replacement', async () => {
  const f = engineFixture({ foreignReplacement: true }), r = await f.promise
  assert.equal(r.successful, false); assert.equal(r.restored, false); assert.equal(f.counts().creates, 0)
})

const witnessEndpoint = { namespace: 'maplespire-b516a-3176', backendPod: 'maplespire-backend-6b4c7cdbd8-zmphb', host: 'redis-critical.maplespire-b516a-3176-deps.svc.cluster.local', port: 6379, prefix: 'maplespire' }
function simulatedWitnessRunner(endpoint, change = () => {}) {
  let calls = 0
  return { calls: () => calls, run: async (_args, options) => {
    calls++
    const episode = options.input.match(/"([a-f0-9-]{36})"\)$/)?.[1]
    assert.ok(episode, 'synthetic witness obtains the actual per-call challenge')
    const body = { schema: 'b516-redis-witness/v2', episodeId: episode, host: endpoint.host, port: endpoint.port, key: endpoint.prefix + ':sync-cell:topology',
      state: 'unavailable', phase: 'connect', reason: 'ECONNREFUSED', errorKind: 'NETWORK', nativeErrorKind: 'NETWORK', nativeErrorCode: 'ECONNREFUSED',
      nativeClosed: true, settled: true, socketCreated: 1, socketClosed: 1, tcpConnects: 0, clockValid: true, clockDomain: 'pod-performance', globalDeadlineFired: false,
      marks: { started: 1, created: 2, connected: null, error: 3, closed: 4, finished: 5 } }
    const envelope = { ok: true, nativeCloseConfirmed: true, code: 0, signal: null, error: null, timedOut: false, clockValid: true, backend: 'native-kubectl', context: 'docker-desktop', spawned: true, stdinFinished: true }
    change(body, envelope)
    return { ...envelope, stdout: JSON.stringify(body) }
  } }
}
test('Redis witness has a qualified unavailable control and rejects unknown native observations', async () => {
  const healthy = simulatedWitnessRunner(witnessEndpoint)
  assert.equal((await readRedisWitness(healthy.run, witnessEndpoint)).state, 'unavailable')
  assert.equal(healthy.calls(), 1)
  for (const change of [(b, e) => { e.nativeCloseConfirmed = false }, (b, e) => { e.timedOut = true },
    b => { b.globalDeadlineFired = true }, b => { b.episodeId = uuid(77) }, b => { b.reason = 'DNS' }, b => { b.marks.closed = 1 }, b => { b.state = 'unknown' }]) {
    const f = simulatedWitnessRunner(witnessEndpoint, change)
    assert.equal((await readRedisWitness(f.run, witnessEndpoint)).state, 'unknown')
  }
})
test('Redis witness must use a freshly admitted Pod name rather than the old lab name', async () => {
  const current = { ...witnessEndpoint, backendPod: 'maplespire-backend-76d6c9d554-qa123' }
  const f = simulatedWitnessRunner(current)
  assert.equal((await readRedisWitness(f.run, current)).state, 'unavailable')
  assert.equal(f.calls(), 1)
})

// The log-window regression exercises the exact collection segment as well as
// the native bounded reader; the child processes below are local Node fixtures.
{
  const hash = value => createHash('sha256').update(value).digest('hex')
  const gateFile = new URL('../../../server/scripts/verify-sync-cell-redis-kubernetes.mjs', import.meta.url)
  const source = fs.readFileSync(gateFile, 'utf8')
  const start = source.indexOf('  const logResult = await runKubectl(')
  const end = source.indexOf("  for (const key of ['cache', 'postgres'])", start)
  assert.ok(start > 0 && end > start, 'exact executed collection segment')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const segment = new AsyncFunction('runKubectl', 'names', 'result', 'assert', 'fs', 'out', 'hash',
    source.slice(start, end) + '\nreturn result.controls.drainLog')
  const began = '2026-09-13T15:40:39.056Z'
  const event = '2026-09-13T15:40:45.000000000Z {"event":"sync.cell.workspace_drained","drainedSockets":2}\n'
  const full = event + Array.from({ length: 2107 }, (_, i) => '2026-09-13T15:40:46.000000000Z fixture-followup-' + i + '\n').join('')
  function collect(runner) {
    const writes = [], result = { startedAt: began, controls: {} }
    const promise = segment(runner, { app: 'maplespire-b516a-3176', backend: 'maplespire-backend-qa-current' }, result,
      assert, { writeFileSync: (file, bytes, options) => writes.push({ file, bytes, options }) }, 'qa-memory-output', hash)
    return { promise, writes }
  }

  test('actual segment keeps a drain followed by 2107 lines; truncated last-2000 control is red', async () => {
    let args
    const current = collect(async received => {
      args = received
      const tail = args.find(arg => /^--tail=/.test(arg))
      const stdout = tail ? full.trimEnd().split('\n').slice(-Number(tail.split('=')[1])).join('\n') + '\n' : full
      return { ok: true, nativeCloseConfirmed: true, stdout, public: { fixture: true } }
    })
    const value = await current.promise
    assert.equal(value.sha256, hash(full))
    assert.ok(args.includes('--since-time=' + began)); assert.ok(args.includes('--timestamps=true'))
    assert.equal(args.some(arg => arg.startsWith('--tail')), false)
    assert.equal(current.writes.length, 1); assert.equal(current.writes[0].bytes, full)
    const last2000 = full.trimEnd().split('\n').slice(-2000).join('\n') + '\n'
    const legacyCapture = collect(async () => ({ ok: true, nativeCloseConfirmed: true, stdout: last2000, public: { fixture: true } }))
    await assert.rejects(legacyCapture.promise, /DRAIN_EVENT_MISSING/)
  })

  test('actual segment refuses missing drain and zero-socket drain', async () => {
    for (const [stdout, reason] of [['fixture unrelated\n', /DRAIN_EVENT_MISSING/], [event.replace('"drainedSockets":2', '"drainedSockets":0'), /DRAIN_SOCKET_COUNT_MISSING/]]) {
      await assert.rejects(collect(async () => ({ ok: true, nativeCloseConfirmed: true, stdout })).promise, reason)
    }
  })

  test('unknown or nonjoined capture is refused before publishing even if the bytes contain a drain', async () => {
    for (const flags of [{ ok: false, nativeCloseConfirmed: true }, { ok: true, nativeCloseConfirmed: false }, { ok: false, nativeCloseConfirmed: false }]) {
      const value = collect(async () => ({ ...flags, stdout: full }))
      await assert.rejects(value.promise, /DRAIN_LOG_INCOMPLETE/)
      assert.equal(value.writes.length, 0)
    }
  })

  for (const mode of ['overflow', 'exit1']) test('actual native capture and gate refuse ' + mode, { timeout: 15000 }, async t => {
    let native
    const program = mode === 'overflow'
      ? 'process.stdout.write(' + JSON.stringify(event) + '); process.stdout.write(Buffer.alloc(9*1024*1024,120));'
      : 'process.stdout.write(' + JSON.stringify(event) + '); process.exitCode=1;'
    const io = createFaultIo({ spawnProcess: (_file, _args, options) => spawn(process.execPath, ['-e', program], options) })
    const captured = collect(async (args, options) => { native = await io.runKubectl(args, options); return native })
    await assert.rejects(captured.promise, /DRAIN_LOG_INCOMPLETE/)
    assert.equal(captured.writes.length, 0)
    assert.equal(native.nativeCloseConfirmed, true); assert.equal(native.ok, false)
    assert.equal(native.backend, 'injected-local-process')
    assert.equal(native.error, mode === 'overflow' ? 'STDOUT_LIMIT' : 'CHILD_FAILED')
    assert.ok(native.stdout.includes('sync.cell.workspace_drained'))
    if (mode === 'overflow') { assert.ok(native.stdoutBytes > 8 * 1024 * 1024); assert.ok(native.stdoutCapturedBytes <= 8 * 1024 * 1024) }
    t.diagnostic(JSON.stringify({ mode, native: native.public }))
  })
}
