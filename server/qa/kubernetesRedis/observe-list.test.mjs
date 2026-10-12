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

import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { classifyEndpoints, startB516Observation } from './observe.mjs'

const nativeSpawn = childProcess.spawn
const expected = { namespace: 'maplespire-b516a-3176', serviceName: 'backend', podName: 'backend-abc',
  podUid: '22222222-2222-4222-8222-222222222222', serviceUid: '33333333-3333-4333-8333-333333333333' }
const boot = '11111111-1111-4111-8111-111111111111'
const complete = body => ({ status: 200, error: null, body })
const expectedRawPath = '/apis/discovery.k8s.io/v1/namespaces/maplespire-b516a-3176/endpointslices'
  + '?labelSelector=kubernetes.io%2Fservice-name%3Dbackend'
function bracket() {
  return {
    service: complete({ kind: 'Service', metadata: { name: expected.serviceName, namespace: expected.namespace, uid: expected.serviceUid },
      spec: { selector: { app: 'backend' }, ports: [{ port: 3001, protocol: 'TCP' }] } }),
    pod: complete({ kind: 'Pod', metadata: { name: expected.podName, namespace: expected.namespace, uid: expected.podUid, labels: { app: 'backend' } },
      status: { podIPs: [{ ip: '10.0.0.1' }], conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [{ name: 'backend', restartCount: 0 }] } }),
    slices: complete({ apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSliceList', metadata: { resourceVersion: 'opaque-native-rv', continue: '' }, items: [
      { kind: 'EndpointSlice', metadata: { namespace: expected.namespace, uid: '44444444-4444-4444-8444-444444444444',
        labels: { 'kubernetes.io/service-name': expected.serviceName }, ownerReferences: [{ kind: 'Service', uid: expected.serviceUid }] },
      ports: [{ port: 3001, protocol: 'TCP' }], endpoints: [{ addresses: ['10.0.0.1'], conditions: { ready: true },
        targetRef: { kind: 'Pod', uid: expected.podUid, namespace: expected.namespace, name: expected.podName } }] },
    ] }),
  }
}

test('generic List with empty resourceVersion remains unknown; native API List retains the required witness', () => {
  const generic = bracket()
  generic.slices.body = { kind: 'List', apiVersion: 'v1', metadata: { resourceVersion: '' }, items: generic.slices.body.items }
  assert.deepEqual(classifyEndpoints(generic, expected), { state: 'unknown', reason: 'partial-or-invalid-slice-list' })
  const raw = bracket()
  const observed = classifyEndpoints(raw, expected)
  assert.equal(observed.state, 'routable')
  assert.equal(observed.resourceVersion, 'opaque-native-rv')
  assert.deepEqual(raw.slices.body.metadata, { resourceVersion: 'opaque-native-rv', continue: '' })
})

test('exact native raw LIST inherits EndpointSlice type from its verified envelope; generic printer stays unknown', () => {
  const load = file => JSON.parse(readFileSync(new URL('./fixtures/' + file, import.meta.url), 'utf8'))
  const native = load('native-identity-bracket.json')
  const identity = { namespace: native.service.metadata.namespace, serviceName: native.service.metadata.name,
    serviceUid: native.service.metadata.uid, podName: native.pod.metadata.name, podUid: native.pod.metadata.uid }
  const generic = load('native-generic.json'), raw = load('native-raw.json')
  const classify = body => classifyEndpoints({ service: complete(native.service), pod: complete(native.pod), slices: complete(body) }, identity)
  assert.equal(generic.metadata.resourceVersion, '')
  assert.equal(Object.hasOwn(raw.items[0], 'kind'), false, 'native API list genuinely omits item TypeMeta')
  assert.equal(classify(generic).state, 'unknown')
  const result = classify(raw)
  assert.equal(result.state, 'routable')
  assert.equal(result.resourceVersion, '1236883')
  assert.equal(result.readyEndpointCount, 1)
})

for (const [variant, mutate] of [
  ['foreign envelope apiVersion', b => { b.slices.body.apiVersion = 'foreign.example/v1' }],
  ['absent envelope apiVersion', b => { delete b.slices.body.apiVersion }],
  ['foreign item kind', b => { b.slices.body.items[0].kind = 'Pod' }],
  ['foreign explicit item apiVersion', b => { b.slices.body.items[0].apiVersion = 'foreign.example/v1' }],
  ['generic untyped items', b => { b.slices.body.kind = 'List'; delete b.slices.body.items[0].kind }],
]) test('native type inheritance refuses ' + variant, () => {
  const value = bracket()
  mutate(value)
  assert.equal(classifyEndpoints(value, expected).state, 'unknown')
})

async function fixture(t) {
  const sockets = new Set()
  const handler = (request, response) => {
    let body = { status: 'ready', checks: { redis: true } }
    if (request.url === '/api/health') body = { status: 'ok' }
    if (request.url === '/api/automerge/stats') body = { processBootId: boot }
    if (request.url === '/api/platform/sync-cell') body = { enabled: true, partitionCount: 1, partitionIndex: 0,
      ready: true, partitionReady: true, partitionLossCount: 0, partitionAcquisitionCount: 1 }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  const servers = [createServer(handler), createServer(handler)]
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  })
  for (const server of servers) {
    server.on('connection', socket => {
      sockets.add(socket)
      socket.on('error', () => undefined)
      socket.once('close', () => sockets.delete(socket))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  }
  return { sockets, directOrigin: 'http://127.0.0.1:' + servers[0].address().port,
    serviceOrigin: 'http://127.0.0.1:' + servers[1].address().port }
}

// Intercept only process creation, then use actual local Node children with
// stdout/close/exit lifecycle. No executable named kubectl is invoked.
async function collect(t, variant = 'healthy') {
  const fix = await fixture(t), calls = [], data = bracket()
  const mocked = t.mock.method(childProcess, 'spawn', (executable, args, init) => {
    calls.push({ executable, args: [...args], init: structuredClone(init) })
    const key = args.includes('service/' + expected.serviceName) ? 'service'
      : args.includes('pod/' + expected.podName) ? 'pod' : 'slices'
    let body = structuredClone(data[key].body), code = 0, malformed = false, stalled = false
    if (key === 'slices') {
      if (!args.includes('--raw')) body = { apiVersion: 'v1', kind: 'List', metadata: { resourceVersion: '' }, items: body.items }
      else for (const item of body.items) { delete item.kind; delete item.apiVersion }
      if (variant === 'pagination') body.metadata.continue = 'next-page-token'
      if (variant === 'missing-rv') delete body.metadata.resourceVersion
      if (variant === 'empty-rv') body.metadata.resourceVersion = ''
      if (variant === 'exit-error') code = 1
      if (variant === 'invalid-json') malformed = true
      if (variant === 'timeout') stalled = true
    }
    const program = 'const [text, code, stalled] = process.argv.slice(1); '
      + 'if (stalled === "true") setInterval(() => {}, 1000); '
      + 'else { process.stdout.write(text); process.exitCode = Number(code); }'
    return nativeSpawn(process.execPath, ['-e', program, malformed ? '{"items":' : JSON.stringify(body), String(code), String(stalled)], init)
  })
  syncBuiltinESMExports()
  let observation
  try {
    observation = startB516Observation({ ...fix, expected, processBootId: boot, cookie: 'synthetic-fixture-only',
      kubectlPath: 'fixture-must-never-run-kubectl', durationMs: 5000, timeoutMs: 3000, periodMs: 50, kubernetesPeriodMs: 1000,
      onRecord: row => { if (row.channel === 'kubernetes/endpoints') queueMicrotask(() => { void observation.stop() }) },
    })
    const summary = await observation.done
    assert.deepEqual(observation.nativeResources(), { requests: 0, sockets: 0, children: 0 })
    for (let i = 0; fix.sockets.size && i < 100; i++) await delay(5)
    assert.equal(fix.sockets.size, 0, 'HTTP peer sockets close before fixture teardown')
    const rows = summary.records.filter(row => row.channel === 'kubernetes/endpoints')
    assert.equal(rows.length, 1)
    return { calls, row: rows[0] }
  } finally {
    await observation?.stop()
    mocked.mock.restore()
    syncBuiltinESMExports()
  }
}

test('collector issues actual raw EndpointSlice LIST arguments and preserves regular Service/Pod GETs', { timeout: 10000 }, async t => {
  const { calls, row } = await collect(t)
  const prefix = ['--context=docker-desktop', '--namespace=' + expected.namespace, '--request-timeout=4s', 'get']
  assert.equal(calls.length, 3)
  for (const call of calls) {
    assert.equal(call.executable, 'fixture-must-never-run-kubectl')
    assert.deepEqual(call.init, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  }
  assert.deepEqual(calls.find(call => call.args.includes('service/' + expected.serviceName))?.args,
    [...prefix, 'service/' + expected.serviceName, '--output=json', '--chunk-size=0'])
  assert.deepEqual(calls.find(call => call.args.includes('pod/' + expected.podName))?.args,
    [...prefix, 'pod/' + expected.podName, '--output=json', '--chunk-size=0'])
  assert.deepEqual(calls.find(call => call.args.includes('--raw'))?.args, [...prefix, '--raw', expectedRawPath])
  assert.equal(row.classification.state, 'routable')
  assert.equal(row.classification.resourceVersion, 'opaque-native-rv')
  assert.equal(row.responses.slices.code, 0)
  assert.equal(row.responses.slices.signal, null)
  assert.equal(row.responses.slices.error, null)
})

for (const [variant, expectedError] of [
  ['pagination', null], ['missing-rv', null], ['empty-rv', null],
  ['exit-error', 'kubectl-failed'], ['invalid-json', 'invalid-json'], ['timeout', 'timeout'],
]) {
  test('raw LIST remains unknown and closes children: ' + variant, { timeout: 10000 }, async t => {
    const { row } = await collect(t, variant)
    assert.equal(row.classification.state, 'unknown')
    assert.equal(row.classification.reason, expectedError ? 'incomplete-kubernetes-bracket' : 'partial-or-invalid-slice-list')
    assert.equal(row.responses.slices.error, expectedError)
    if (expectedError) assert.equal(row.responses.slices.status, null)
  })
}
