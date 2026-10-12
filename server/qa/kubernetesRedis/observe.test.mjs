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
import { createServer } from 'node:http'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { classifyReadiness, classifyOwnership, classifyEndpoints, makeDeleteOptions, startB516Observation } from './observe.mjs'

const ids = {
  boot: '11111111-1111-4111-8111-111111111111',
  pod: '22222222-2222-4222-8222-222222222222',
  service: '33333333-3333-4333-8333-333333333333',
  slice: '44444444-4444-4444-8444-444444444444',
  other: '55555555-5555-4555-8555-555555555555',
}
const expected = { namespace: 'maplespire-b516a-3176', serviceName: 'backend', podName: 'backend-abc', podUid: ids.pod, serviceUid: ids.service }
const result = body => ({ error: null, status: 200, body })
const own = () => ({ enabled: true, partitionCount: 1, partitionIndex: 0, ready: true, partitionReady: true,
  partitionLossCount: 0, partitionAcquisitionCount: 1 })
const identity = () => result({ processBootId: ids.boot })
function k8(ready = true) {
  return {
    service: result({ kind: 'Service', metadata: { namespace: expected.namespace, name: expected.serviceName, uid: ids.service },
      spec: { selector: { app: 'backend' }, ports: [{ port: 3001, protocol: 'TCP', targetPort: 'http' }] } }),
    pod: result({ kind: 'Pod', metadata: { namespace: expected.namespace, name: expected.podName, uid: ids.pod, labels: { app: 'backend' } },
      status: { podIPs: [{ ip: '10.0.0.1' }], conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
        containerStatuses: [{ name: 'backend', restartCount: 0 }] } }),
    slices: result({ apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSliceList', metadata: { resourceVersion: 'opaque-revision-A', continue: '' },
      items: [{ kind: 'EndpointSlice', metadata: { namespace: expected.namespace, uid: ids.slice,
        labels: { 'kubernetes.io/service-name': expected.serviceName }, ownerReferences: [{ kind: 'Service', uid: ids.service }] },
      ports: [{ port: 3001, protocol: 'TCP' }], endpoints: [{ addresses: ['10.0.0.1'], conditions: { ready },
        targetRef: { kind: 'Pod', name: expected.podName, namespace: expected.namespace, uid: ids.pod } }] }] }),
  }
}

test('readiness: complete Redis 503 qualifies, ready 200 qualifies', () => {
  assert.equal(classifyReadiness({ error: null, status: 503, body: { status: 'not-ready', checks: { redis: false } } }).state, 'redis-unready')
  assert.equal(classifyReadiness(result({ status: 'ready', checks: { redis: true } })).state, 'ready')
})
test('readiness: transport, incomplete body, proxy 503 and another failing dependency stay unknown', () => {
  for (const candidate of [
    { error: 'timeout', status: 503, body: { status: 'not-ready', checks: { redis: false } } },
    { error: null, status: 503 },
    { error: null, status: 503, body: { status: 'bad-gateway' } },
    { error: null, status: 503, body: { status: 'not-ready', checks: { redis: true, database: false } } },
  ]) assert.equal(classifyReadiness(candidate).state, 'unknown')
})
test('ownership: same boot owner and genuine unassigned states', () => {
  assert.equal(classifyOwnership(identity(), result(own()), identity(), ids.boot).state, 'owner')
  assert.equal(classifyOwnership(identity(), result({ ...own(), partitionIndex: null, ready: false, partitionReady: false, partitionLossCount: 1 }), identity(), ids.boot).state, 'unassigned')
})
test('ownership: missing, changed or unexpected boot; absent counters and inconsistent state refuse identity proof', () => {
  const cases = [
    [result({ processBootId: '' }), result(own()), identity()],
    [identity(), result(own()), result({ processBootId: ids.other })],
    [result({ processBootId: ids.other }), result(own()), result({ processBootId: ids.other })],
    [identity(), result({ ...own(), partitionLossCount: undefined }), identity()],
    [identity(), result({ ...own(), partitionIndex: null }), identity()],
    [identity(), result({ ...own(), partitionCount: 2 }), identity()],
  ]
  for (const [before, middle, after] of cases) assert.equal(classifyOwnership(before, middle, after, ids.boot).state, 'unknown')
})
test('EndpointSlices: full healthy and withdrawn samples, and complete empty list', () => {
  assert.equal(classifyEndpoints(k8(), expected).state, 'routable')
  const withdrawn = classifyEndpoints(k8(false), expected)
  assert.equal(withdrawn.state, 'withdrawn')
  assert.equal(withdrawn.endpointCount, 1)
  const empty = k8(false)
  empty.slices.body.items = []
  assert.equal(classifyEndpoints(empty, expected).state, 'withdrawn')
})
test('EndpointSlices: aggregate all slices and deduplicate equal addresses; one ready endpoint defeats withdrawal', () => {
  const bracket = k8(false)
  bracket.pod.body.status.podIPs.push({ ip: '10.0.0.2' })
  const second = structuredClone(bracket.slices.body.items[0])
  second.metadata.uid = ids.other
  second.endpoints[0].addresses = ['10.0.0.2']
  second.endpoints[0].conditions.ready = true
  bracket.slices.body.items.push(second, structuredClone(second))
  const actual = classifyEndpoints(bracket, expected)
  assert.equal(actual.state, 'routable')
  assert.equal(actual.endpointCount, 2)
  assert.equal(actual.readyEndpointCount, 1)
})
const endpointNegatives = [
  ['failed list is not an empty healthy response', b => { b.slices.error = 'timeout' }],
  ['pagination must be complete', b => { b.slices.body.metadata.continue = 'next-page' }],
  ['resourceVersion absent', b => { delete b.slices.body.metadata.resourceVersion }],
  ['Pod UID changed', b => { b.pod.body.metadata.uid = ids.other }],
  ['Service UID changed', b => { b.service.body.metadata.uid = ids.other }],
  ['foreign owner', b => { b.slices.body.items[0].metadata.ownerReferences[0].uid = ids.other }],
  ['invalid ownerReferences schema', b => { b.slices.body.items[0].metadata.ownerReferences = {} }],
  ['slice UID absent', b => { delete b.slices.body.items[0].metadata.uid }],
  ['ready absent', b => { delete b.slices.body.items[0].endpoints[0].conditions.ready }],
  ['ready null', b => { b.slices.body.items[0].endpoints[0].conditions.ready = null }],
  ['terminating endpoint', b => { b.slices.body.items[0].endpoints[0].conditions.terminating = true }],
  ['foreign backend endpoint', b => { b.slices.body.items[0].endpoints[0].targetRef.uid = ids.other }],
  ['endpoint name mismatch', b => { b.slices.body.items[0].endpoints[0].targetRef.name = 'foreign' }],
  ['unknown address', b => { b.slices.body.items[0].endpoints[0].addresses[0] = '10.0.0.99' }],
  ['publishNotReadyAddresses cannot prove withdrawal', b => { b.service.body.spec.publishNotReadyAddresses = true }],
  ['selector mismatch', b => { b.service.body.spec.selector.app = 'foreign' }],
  ['Pod Ready condition absent', b => { b.pod.body.status.conditions = [] }],
  ['invalid Pod status schema', b => { b.pod.body.status.containerStatuses = {} }],
  ['conflicting duplicate', b => {
    const second = structuredClone(b.slices.body.items[0])
    second.metadata.uid = ids.other
    second.endpoints[0].conditions.ready = false
    b.slices.body.items.push(second)
  }],
]
for (const [label, mutate] of endpointNegatives) test('EndpointSlices unknown: ' + label, () => {
  const bracket = k8()
  mutate(bracket)
  assert.equal(classifyEndpoints(bracket, expected).state, 'unknown')
})
test('UID precondition body is exact and rejects absent identity; it performs no request', () => {
  assert.deepEqual(makeDeleteOptions(ids.pod), { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: ids.pod }, propagationPolicy: 'Foreground' })
  assert.throws(() => makeDeleteOptions(''), /UID/)
})

async function fixture(t, handler) {
  const sockets = new Set(), servers = [createServer(handler), createServer(handler)]
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  })
  for (const server of servers) {
    server.on('connection', socket => {
      sockets.add(socket)
      socket.once('error', () => undefined)
      socket.once('close', () => sockets.delete(socket))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  }
  return { sockets, directOrigin: 'http://127.0.0.1:' + servers[0].address().port,
    serviceOrigin: 'http://127.0.0.1:' + servers[1].address().port }
}
function healthy(request, response) {
  let body = { status: 'ready', checks: { redis: true } }
  if (request.url === '/api/health') body = { status: 'ok' }
  if (request.url === '/api/automerge/stats') body = { processBootId: ids.boot }
  if (request.url === '/api/platform/sync-cell') body = own()
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}
function options(fix, extra = {}) {
  // Node rejects kubectl's fixed CLI arguments locally. No kubectl or cluster is used.
  return { ...fix, expected, processBootId: ids.boot, cookie: 'synthetic-session=local-only',
    kubectlPath: process.execPath, durationMs: 1000, periodMs: 50, kubernetesPeriodMs: 250, onRecord: () => undefined, ...extra }
}
async function closed(fix, observation) {
  assert.deepEqual(observation.nativeResources(), { requests: 0, sockets: 0, children: 0 })
  for (let attempt = 0; fix.sockets.size && attempt < 100; attempt++) await delay(5)
  assert.equal(fix.sockets.size, 0, 'server observes native peer closures before fixture teardown')
}
test('real HTTP: healthy samples and native stop, failing read-only child stays unknown', { timeout: 10000 }, async t => {
  const fix = await fixture(t, healthy)
  const observation = startB516Observation(options(fix))
  const summary = await observation.done
  assert.equal(summary.verdict, 'UNADJUDICATED')
  assert.equal(summary.taskComplete, false)
  for (const [channel, state] of [['pod/ready', 'ready'], ['service/ready', 'ready'], ['pod/health', 'healthy'], ['pod/ownership', 'owner'], ['kubernetes/endpoints', 'unknown']]) {
    assert.ok(summary.records.some(row => row.channel === channel && row.classification.state === state), channel)
  }
  for (const row of summary.records) assert.ok(row.ended >= row.began && row.at >= row.ended)
  assert.equal(JSON.stringify(summary).includes('synthetic-session'), false)
  assert.equal(await observation.stop(), summary)
  await closed(fix, observation)
})
test('real HTTP: complete Redis 503 is captured; native transports close', { timeout: 10000 }, async t => {
  const fix = await fixture(t, (request, response) => {
    if (request.url !== '/api/ready') { healthy(request, response); return }
    response.writeHead(503, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'not-ready', checks: { redis: false } }))
  })
  const observation = startB516Observation(options(fix))
  const summary = await observation.done
  assert.ok(summary.records.some(row => row.channel === 'pod/ready' && row.classification.state === 'redis-unready'))
  await closed(fix, observation)
})
test('real HTTP: 503 headers with a suspended body never become a completed readiness witness', { timeout: 10000 }, async t => {
  const fix = await fixture(t, (request, response) => {
    if (request.url !== '/api/ready') { healthy(request, response); return }
    response.writeHead(503, { 'Content-Type': 'application/json' })
    response.flushHeaders()
    response.write('{"status":"not-ready","checks":{"redis":false}')
  })
  const observation = startB516Observation(options(fix))
  const summary = await observation.done
  const rows = summary.records.filter(row => row.channel.endsWith('/ready'))
  assert.ok(rows.length >= 2)
  assert.ok(rows.every(row => row.classification.state === 'unknown' && row.response.status === null))
  assert.ok(rows.some(row => row.response.responseStatus === 503))
  await closed(fix, observation)
})
for (const variant of ['throwing sink', 'asynchronous sink', 'regressing clock']) {
  test('real HTTP cleanup after ' + variant, { timeout: 10000 }, async t => {
    const fix = await fixture(t, healthy)
    let regress = false
    const observation = startB516Observation(options(fix, {
      now: () => regress ? -1 : performance.now(),
      onRecord: () => {
        if (variant === 'throwing sink') throw new Error('intentional sink failure')
        if (variant === 'asynchronous sink') return Promise.resolve()
        regress = true
      },
    }))
    await assert.rejects(observation.done, /sink|clock/)
    await assert.rejects(observation.stop(), /sink|clock/)
    await closed(fix, observation)
  })
}
test('unsafe origins and unauthenticated starts are refused before any transport', () => {
  const args = options({ directOrigin: 'http://127.0.0.1:19001', serviceOrigin: 'http://127.0.0.1:19002' })
  assert.throws(() => startB516Observation({ ...args, directOrigin: 'https://app.maplespire.ca' }), /loopback/)
  assert.throws(() => startB516Observation({ ...args, serviceOrigin: args.directOrigin }), /distinct/)
  assert.throws(() => startB516Observation({ ...args, cookie: '' }), /cookie/)
})
