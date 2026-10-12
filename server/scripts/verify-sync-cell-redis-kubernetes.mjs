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

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { openLab, readPg, getJson, validateConfig, assertOwnershipRefusal, joinHttpWitness, observePublicOutage } from '../qa/kubernetesRedis/lab.mjs'
import { startB514Traffic } from '../qa/b514-traffic.mjs'
import { replayB516Snapshots } from '../qa/kubernetesRedis/replay.mjs'
import { startB516Observation, classifyOwnership, classifyEndpoints } from '../qa/kubernetesRedis/observe.mjs'
import { deleteCriticalRedis } from '../qa/kubernetesRedis/engine.mjs'
import { readRedisWitness } from '../qa/kubernetesRedis/redis-witness.mjs'

export async function runKubernetesRedisGate({ configFile, out, runId }) {
const root = path.resolve(import.meta.dirname, '../..')
const config = validateConfig(JSON.parse(fs.readFileSync(configFile)))
assert.ok(path.isAbsolute(out))
assert.match(runId, /^b516a-[a-z0-9-]{1,80}$/)
assert.equal(path.resolve(process.env.NODE_EXTRA_CA_CERTS ?? ''), path.resolve(config.caPath))
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0')
assert.equal(fs.existsSync(out), false); fs.mkdirSync(out)
const names = { app: config.namespace, deps: config.depsNamespace, appUid: config.namespaceUid, depsUid: config.depsNamespaceUid,
  backend: config.resources.backend.name, backendUid: config.resources.backend.uid,
  service: config.service.name, serviceUid: config.service.uid, criticalUid: config.resources.redis.uid }
let runKubectl, manualMutation
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const saved = (file, value) => fs.writeFileSync(`${out}/${file}.json`, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const fd = fs.openSync(`${out}/events.jsonl`, 'wx')
const record = (channel, value) => fs.writeSync(fd, JSON.stringify({ channel, receivedAt: performance.now(), value }) + '\n')
const controller = new AbortController()
const onSignal = () => controller.abort()
process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal)
const result = { schema: 'b516b-kubernetes-redis-gate/v1', runId, platform: 'kubernetes-local', replicas: 1,
  startedAt: new Date().toISOString(), complete: false, phase: 'admission', controls: {},
  parameters: { holdFromConfirmedAbsenceMs: 45000, observerDurationMs: 180000, restorationOwnedBy: 'fault-engine-finally',
    qualification: 'Observed transitions and durations under D55; not a G4 capacity run.',
    sourceProtocol: 'B5.16b / D55, explicit single-cell Kubernetes adaptation of verify:sync-redis-failover' },
  limitations: ['One Windows machine, two Docker Desktop nodes, one backend replica. No cloud or host-failure qualification.',
    'Original author close code observed on its one non-reconnecting transport; reason is unavailable in the reused helper.',
    'Offline edits are sealed before injection; this arm does not prove transactional refusal of writes already delivered.',
    'Ownership polling can prune expired leases; observation does not prove continuous exclusivity between samples.',
    'DELETE transmission and confirmed absence bracket different facts; neither is an exact Redis extinction timestamp.',
    'In-process restoration cannot survive an OS kill or a permanently blocked event loop.'] }
const sources = ['server/scripts/verify-sync-cell-redis-kubernetes.mjs', 'server/scripts/verify-sync-cell-failover.mjs',
  ...['lab', 'observe', 'engine', 'io', 'redis-witness', 'replay'].map(name => 'server/qa/kubernetesRedis/' + name + '.mjs'),
  ...['b514-traffic', 'b514-durable-read', 'b514-replay', 'authenticatedWebSocketAdapter', 'loadUsersCore', 'lib'].map(name => 'server/qa/' + name + '.mjs')]
saved('sources', sources.map(file => ({ file, sha256: hash(fs.readFileSync(path.join(root, file))) })))
fs.mkdirSync(out + '/sources')
for (const file of sources) fs.copyFileSync(path.join(root, file), out + '/sources/' + file.replaceAll('/', '__') + '.txt', fs.constants.COPYFILE_EXCL)
const manifest = JSON.parse(fs.readFileSync(config.restoreManifestPath))
saved('restore-manifest', manifest)
saved('config', config)
let lab, observer, stoppingObserver = false, observerExpired = false, stoppingAuthors = false, authorEnded = false
let authors = [], closedAuthors = [], pgLoss = false, faultResult = null
const assertAlive = () => {
  lab?.assertTransports()
  assert.equal(controller.signal.aborted, false, 'CAMPAIGN_ABORTED')
  assert.equal(observerExpired, false, 'OBSERVER_ENDED_EARLY')
  assert.equal(authorEnded, false, 'AUTHOR_ENDED_EARLY')
}
const waitFor = async (label, predicate, timeoutMs) => {
  const due = performance.now() + timeoutMs
  while (performance.now() < due) { assertAlive(); if (predicate()) return; await delay(50) }
  throw new Error(label)
}
const requestFor = attempts => ({ documentId: lab.target.documentId, heads: [...new Set(attempts.flatMap(item => item.heads))],
  markers: [...attempts.map(item => ({ path: ['objects', item.objectId, 'properties', `seq${item.seq}`], value: item.marker })),
    ...(manualMutation ? [{ path: ['objects', manualMutation.id, 'properties', 'b516bWriteProbe'], value: manualMutation.healthy }] : [])] })
const pgCheck = async (label, attempts) => {
  let proof
  try { proof = await readPg(lab, requestFor(attempts)) }
  catch (error) {
    if (error.durableReadEvidence) {
      if (error.durableReadEvidence.proof?.status === 'not-durable') pgLoss = true
      result.controls[label] = { ...error.durableReadEvidence, cleanupFailed: true }
    }
    throw error
  }
  if (proof.proof.status === 'not-durable') pgLoss = true
  result.controls[label] = proof; saved(label, proof)
  assert.equal(proof.proof.status, 'verified'); return proof
}
const expected = { namespace: names.app, serviceName: names.service, podName: names.backend, podUid: names.backendUid, serviceUid: names.serviceUid }
const redisWitness = async label => {
  const value = await readRedisWitness(runKubectl, { namespace: names.app, backendPod: names.backend,
    host: 'redis-critical.maplespire-b516a-3176-deps.svc.cluster.local', port: 6379, prefix: 'maplespire' })
  saved(label, value); record('redis-witness', { label, value }); return value
}
const freshAdmission = async (phase = 'pre-delete') => {
  assertAlive()
  const began = performance.now()
  const kube = async args => {
    const start = performance.now(), io = await runKubectl(args, { timeoutMs: 4000 })
    assert.equal(io.ok, true); assert.equal(io.nativeCloseConfirmed, true)
    return { began: start, ended: performance.now(), error: null, status: 200, body: JSON.parse(io.stdout), io: io.public }
  }
  const ownership = async () => {
    const before = await getJson(lab.directOrigin, '/api/automerge/stats', { cookie: lab.cookie })
    const middle = await getJson(lab.directOrigin, '/api/platform/sync-cell', { cookie: lab.cookie })
    const after = await getJson(lab.directOrigin, '/api/automerge/stats', { cookie: lab.cookie })
    return { before, middle, after, classification: classifyOwnership(...[before, middle, after].map(item => ({ ...item, error: null })), lab.processBootId) }
  }
  const calls = await Promise.allSettled([
    ownership(), getJson(lab.directOrigin, '/api/ready'), getJson(lab.serviceOrigin, '/api/ready', { ca: lab.ca }),
    kube(['-n', names.app, 'get', 'service', names.service, '-o', 'json']),
    kube(['-n', names.app, 'get', 'pod', names.backend, '-o', 'json']),
    kube(['get', '--raw', `/apis/discovery.k8s.io/v1/namespaces/${names.app}/endpointslices?labelSelector=${encodeURIComponent('kubernetes.io/service-name=' + names.service)}`]),
    kube(['-n', names.app, 'get', 'pods', '-l', 'app.kubernetes.io/component=backend', '-o', 'json'])
  ])
  assert.ok(calls.every(item => item.status === 'fulfilled'), 'FRESH_ADMISSION_INCOMPLETE')
  const [owner, directReady, serviceReady, service, pod, slices, backendList] = calls.map(item => item.value)
  const endpoints = classifyEndpoints({ service, pod, slices }, expected)
  assert.equal(endpoints.state, 'routable'); assert.equal(endpoints.podReady, true)
  assert.deepEqual(endpoints.podRestartCounts, config.resources.backend.containers.map(c => ({ name: c.name, restartCount: c.restartCount })))
  assert.deepEqual(pod.body.status.containerStatuses.map(c => ({ name: c.name, containerID: c.containerID })), config.resources.backend.containers.map(c => ({ name: c.name, containerID: c.containerID })))
  assert.equal(backendList.body.items.length, 1); assert.equal(backendList.body.items[0].metadata.uid, names.backendUid)
  assert.equal(owner.classification.state, 'owner')
  for (const ready of [directReady, serviceReady]) { assert.equal(ready.status, 200); assert.equal(ready.body.status, 'ready'); assert.equal(ready.body.checks.redis, true) }
  if (phase === 'pre-delete') assert.ok(authors.every(author => author.ledger.records.filter(row => row.kind === 'transport-open').length === 1 && !author.ledger.records.some(row => row.kind === 'transport-close')))
  else {
    assert.equal(owner.classification.ownership.partitionLossCount, result.controls.baselineOwnership.partitionLossCount + 1)
    assert.equal(owner.classification.ownership.partitionAcquisitionCount, result.controls.baselineOwnership.partitionAcquisitionCount + 1)
  }
  assertAlive()
  const value = { complete: true, began, observedAt: began, ended: performance.now(), owner, directReady, serviceReady, service, pod, slices, backendList, endpoints }
  assert.ok(value.ended - began <= 1000, 'ADMISSION_OLDER_THAN_ONE_SECOND')
  saved(`fresh-admission-${phase}`, value)
  if (phase === 'pre-delete') result.controls.baselineOwnership = owner.classification.ownership
  return value
}
const rows = (channel, state, after = -Infinity) => observer.records.filter(row => row.channel === channel && row.classification?.state === state && row.began >= after)
try {
  lab = await openLab(config, out)
  runKubectl = lab.runKubectl
  const wsRoute = '/automerge?' + new URLSearchParams({ landscapeId: lab.workspace.landscapeId, versionId: lab.workspace.versionId })
  result.controls.anonymousUpgrade = await getJson(lab.serviceOrigin, wsRoute, { ca: lab.ca, upgrade: true })
  assert.equal(result.controls.anonymousUpgrade.status, 401, 'ANONYMOUS_UPGRADE_NOT_401')
  const created = await getJson(lab.serviceOrigin, '/api/ai/tools/create_model_object', { cookie: lab.cookie, ca: lab.ca, method: 'POST',
    body: { ...lab.workspace, input: { type: 'system', name: 'B5.16b ' + runId } } })
  assert.equal(created.status, 200, 'HEALTHY_CREATE_FAILED')
  assert.ok(created.body?.result?.created?.id, 'HEALTHY_CREATE_ID_MISSING')
  manualMutation = { id: created.body.result.created.id, healthy: runId + ':healthy', outage: runId + ':outage' }
  const write = (origin, marker) => getJson(origin, '/api/ai/tools/update_model_object', { cookie: lab.cookie, ca: lab.ca, method: 'POST',
    body: { ...lab.workspace, input: { id: manualMutation.id, properties: { b516bWriteProbe: marker } } } })
  result.controls.healthyWrite = await write(lab.serviceOrigin, manualMutation.healthy)
  assert.equal(result.controls.healthyWrite.status, 200, 'HEALTHY_WRITE_FAILED')
  result.controls.manualMutation = manualMutation
  const readRoute = '/api/model/object/' + encodeURIComponent(manualMutation.id) + '?' + new URLSearchParams({ landscapeId: lab.workspace.landscapeId, versionId: lab.workspace.versionId })
  const readDeadline = performance.now() + 20000
  const healthyReads = []
  do {
    result.controls.healthyRead = await getJson(lab.serviceOrigin, readRoute, { cookie: lab.cookie, ca: lab.ca })
    healthyReads.push(result.controls.healthyRead)
    if (result.controls.healthyRead.status === 200 && result.controls.healthyRead.body?.object?.properties?.b516bWriteProbe === manualMutation.healthy) break
    await delay(250)
  } while (performance.now() < readDeadline)
  saved('healthy-read-arrivals', healthyReads)
  assert.equal(result.controls.healthyRead.status, 200, 'HEALTHY_READ_FAILED')
  assert.equal(result.controls.healthyRead.body?.object?.id, manualMutation.id)
  assert.equal(result.controls.healthyRead.body?.object?.properties?.b516bWriteProbe, manualMutation.healthy)
  const probes = lab.objects.backend.spec.containers[0]
  for (const name of ['startupProbe', 'readinessProbe']) { assert.equal(probes[name].httpGet.path, '/api/ready'); assert.equal(probes[name].timeoutSeconds, 3) }
  assert.equal(probes.readinessProbe.periodSeconds, 10); assert.equal(probes.readinessProbe.failureThreshold, 3)
  assert.equal(probes.livenessProbe.httpGet.path, '/api/health')
  saved('admitted-probes', { startup: probes.startupProbe, readiness: probes.readinessProbe, liveness: probes.livenessProbe })
  observer = startB516Observation({ apiServer: config.apiServer, directOrigin: lab.directOrigin, serviceOrigin: lab.serviceOrigin, cookie: lab.cookie, ca: lab.ca,
    processBootId: lab.processBootId, durationMs: 180000, expected, onRecord: value => record('observation', value) })
  void observer.done.then(() => { if (!stoppingObserver) { observerExpired = true; controller.abort() } }, () => { observerExpired = true; controller.abort() })
  const baselineStates = { 'pod/ready': 'ready', 'service/ready': 'ready', 'pod/health': 'healthy', 'pod/ownership': 'owner', 'kubernetes/endpoints': 'routable' }
  result.phase = 'baseline'
  await waitFor('BASELINE_INCOMPLETE', () => Object.entries(baselineStates).every(([channel, state]) => rows(channel, state).length >= 3), 20000)
  result.controls.redisBefore = await redisWitness('redis-before')
  assert.equal(result.controls.redisBefore.state, 'available')
  const effectiveGeneration = rows('pod/ownership', 'owner').at(-1)?.classification.ownership.topologyGeneration
  assert.ok(typeof effectiveGeneration === 'string' && effectiveGeneration.length > 0, 'EFFECTIVE_GENERATION_MISSING')
  assert.equal(result.controls.redisBefore.observation.topology.value, effectiveGeneration + '|1')
  result.controls.effectiveTopologyContract = { generation: effectiveGeneration, partitionCount: 1,
    value: result.controls.redisBefore.observation.topology.value }
  result.phase = 'authors'
  for (let index = 0; index < 2; index++) {
    const author = startB514Traffic({ targetUrl: lab.target.url, workspace: lab.workspace, baseUrl: lab.serviceOrigin,
      wsUrl: 'wss://localhost:18443/automerge', cookie: lab.cookie, runId: `${result.runId}-${index}`, reconnect: false,
      manualWrites: true, durationMs: 180000, readyTimeoutMs: 15000, onRecord: value => record(`author-${index}`, value) })
    authors.push(author)
    void author.done.then(() => { if (!stoppingAuthors) { authorEnded = true; controller.abort() } }, () => { authorEnded = true; controller.abort() })
  }
  await Promise.all(authors.map(author => author.ready))
  const accepted = authors.map(author => author.writeOnce())
  await waitFor('SEQ1_ACK_MISSING', () => authors.every(author => author.ledger.acknowledgements.some(ack => ack.outcome === 'durable' && ack.sequences.includes(1))), 20000)
  await pgCheck('pg-baseline', accepted)
  for (const author of authors) { await author.suspendAcknowledgements(); await author.sealOutbound() }
  assert.ok(authors.every(author => author.ledger.ackSuspension.qualified && author.ledger.outboundBarrier.qualified))
  result.phase = 'redis-fault'
  faultResult = await deleteCriticalRedis({ runKubectl, manifest, runId: result.runId, signal: controller.signal,
    expected: { namespace: names.deps, name: 'redis-critical', uid: names.criticalUid, namespaceUid: names.depsUid }, freshAdmission,
    onRecord: value => record('fault', value), witnessUnavailable: async () => {
      assertAlive()
      for (const author of authors) { author.writeOnce(); author.writeOnce() }
      const witness = await redisWitness('redis-unavailable')
      result.controls.redisUnavailable = witness
      await waitFor('FAIL_CLOSED_NOT_OBSERVED', () => rows('pod/ownership', 'unassigned', witness.began).length
        && rows('pod/ready', 'redis-unready', witness.began).length, 20000)
      const [upgrade, mutation, directRead] = await joinHttpWitness([
        getJson(lab.directOrigin, wsRoute, { cookie: lab.cookie, upgrade: true }),
        write(lab.directOrigin, manualMutation.outage),
        getJson(lab.directOrigin, readRoute, { cookie: lab.cookie }),
      ])
      result.controls.outageUpgrade = upgrade
      result.controls.outageWrite = mutation
      result.controls.outageRead = directRead
      for (const response of [upgrade, mutation, directRead]) assert.equal(response.status, 503, 'APPLICATION_OUTAGE_REFUSAL_MISSING')
      assertOwnershipRefusal(mutation); assertOwnershipRefusal(directRead)
      await waitFor('SERVICE_WITHDRAWAL_NOT_OBSERVED', () => rows('kubernetes/endpoints', 'withdrawn', witness.began).some(row => !row.classification.podReady), 35000)
      result.controls.publicOutageRead = await observePublicOutage(lab.serviceOrigin, readRoute, { cookie: lab.cookie, ca: lab.ca })
      return { unavailable: witness.state === 'unavailable', witness }
    } })
  saved('fault-engine', faultResult)
  assert.equal(faultResult.successful, true, 'FAULT_OR_RESTORATION_INCOMPLETE')
  assertAlive()
  result.phase = 'recovery'
  result.controls.redisAfter = await redisWitness('redis-after')
  assert.equal(result.controls.redisAfter.state, 'available')
  assert.notEqual(result.controls.redisAfter.observation.runId, result.controls.redisBefore.observation.runId, 'REDIS_RUN_ID_DID_NOT_CHANGE')
  assert.deepEqual(result.controls.redisAfter.observation.topology, result.controls.redisBefore.observation.topology, 'TOPOLOGY_CONTRACT_CHANGED')
  const injectionAt = faultResult.events.find(row => row.kind === 'delete-requested').at
  const restoredAt = faultResult.events.find(row => row.kind === 'create-requested').at
  assert.ok(result.controls.redisUnavailable.began >= faultResult.absenceAt && result.controls.redisUnavailable.ended < restoredAt, 'REDIS_WITNESS_OUTSIDE_ABSENCE')
  const initialOwner = result.controls.baselineOwnership
  await waitFor('RECOVERY_NOT_OBSERVED', () => ['pod/ready', 'service/ready'].every(channel => rows(channel, 'ready', restoredAt).length >= 3)
    && rows('kubernetes/endpoints', 'routable', restoredAt).some(row => row.classification.podReady)
    && rows('pod/ownership', 'owner', restoredAt).some(row => row.classification.ownership.partitionAcquisitionCount === initialOwner.partitionAcquisitionCount + 1), 25000)
  const duringFault = (channel, state) => rows(channel, state, injectionAt).filter(row => row.ended < restoredAt)
  const lossRows = duringFault('pod/ownership', 'unassigned')
  assert.ok(lossRows.some(row => row.classification.ownership.partitionLossCount === initialOwner.partitionLossCount + 1), 'PARTITION_LOSS_NOT_OBSERVED')
  assert.ok(duringFault('pod/ready', 'redis-unready').length > 0, 'DIRECT_503_NOT_OBSERVED')
  // After EndpointSlice withdrawal the proxy may return HTML 502/503.
  // The direct Pod proves the 503-during-outage contract; the public observation keeps a completed proxy refusal
  // distinct from a deadline without a response, which remains unknown.
  for (const key of ['outageUpgrade', 'outageWrite', 'outageRead', 'publicOutageRead']) {
    assert.ok(result.controls[key]?.began >= faultResult.absenceAt && result.controls[key].ended < restoredAt, 'OUTAGE_REQUEST_OUTSIDE_ABSENCE')
  }
  assert.ok(duringFault('kubernetes/endpoints', 'withdrawn').some(row => !row.classification.podReady), 'ENDPOINT_WITHDRAWAL_NOT_OBSERVED')
  assert.ok(rows('pod/health', 'healthy', faultResult.absenceAt).some(row => row.ended < faultResult.restoreDueAt), 'LIVENESS_DURING_ABSENCE_NOT_OBSERVED')
  const closes = authors.map(author => author.ledger.records.filter(row => row.kind === 'transport-close'))
  assert.ok(closes.every(items => items.length === 1 && items[0].code === 1012 && items[0].monoAt > injectionAt && items[0].monoAt < restoredAt), 'ORIGINAL_WS_1012_NOT_OBSERVED')
  result.controls.originalClosures = closes.map((items, author) => ({ author, ...items[0], reason: null, sinceDeleteRequestedMs: items[0].monoAt - injectionAt }))
  stoppingAuthors = true
  closedAuthors = await Promise.all(authors.map(author => author.stop()))
  assert.ok(closedAuthors.every(item => item.transportsClosed && item.ledger.attempts.length === 3))
  for (const item of closedAuthors) assert.equal(item.ledger.records.filter(row => row.kind === 'outbound-send-started' && row.monoAt > item.ledger.outboundBarrier.sealed.monoAt).length, 0)
  result.phase = 'pg-before-replay'
  await pgCheck('pg-before-replay', accepted)
  assertAlive()
  result.phase = 'replay'
  const replay = await replayB516Snapshots({ snapshots: closedAuthors.map(item => item.snapshot), documentId: lab.target.documentId,
    targetUrl: lab.target.url, workspace: lab.workspace, baseUrl: lab.serviceOrigin, wsUrl: 'wss://localhost:18443/automerge', cookie: lab.cookie,
    ca: lab.ca, runId: `${result.runId}-replay`, readPgBeforeReplayVerified: true, onRecord: value => record('replay', value), timeoutMs: 20000 })
  saved('replay', { ledger: replay.ledger, mergedHeads: replay.mergedHeads, transportsClosed: replay.transportsClosed })
  assert.equal(replay.transportsClosed, true)
  result.phase = 'pg-after-replay'
  await pgCheck('pg-after-replay', closedAuthors.flatMap(item => item.ledger.attempts))
  result.controls.finalAdmission = await freshAdmission('after-pg')
  const session = await getJson(lab.serviceOrigin, '/api/auth/me', { cookie: lab.cookie, ca: lab.ca })
  assert.equal(session.status, 200); assert.equal(session.body.user?.id, config.userId, 'SESSION_IDENTITY_CHANGED')
  result.controls.recoveredSession = { status: session.status, userId: session.body.user.id, began: session.began, ended: session.ended }
  // A Redis outage can produce more than 2,000 error-stack lines after the
  // initial drain. Keep the whole campaign window; native capture remains
  // byte-bounded and rejects overflow instead of silently dropping its start.
  const logResult = await runKubectl(['-n', names.app, 'logs', names.backend, '--since-time=' + result.startedAt, '--timestamps=true'], { timeoutMs: 10000 })
  assert.ok(logResult.ok && logResult.nativeCloseConfirmed, 'DRAIN_LOG_INCOMPLETE')
  fs.writeFileSync(out + '/backend.log', logResult.stdout, { flag: 'wx' })
  assert.ok(logResult.stdout.includes('sync.cell.workspace_drained'), 'DRAIN_EVENT_MISSING')
  assert.ok([...logResult.stdout.matchAll(/"drainedSockets":(\d+)/g)].some(m => Number(m[1]) > 0), 'DRAIN_SOCKET_COUNT_MISSING')
  result.controls.drainLog = { sha256: hash(logResult.stdout), native: logResult.public }
  for (const key of ['cache', 'postgres']) {
    const expected = config.resources[key]
    const current = await runKubectl(['-n', expected.namespace, 'get', 'pod', expected.name, '-o', 'json'], { timeoutMs: 10000 })
    assert.ok(current.ok && current.nativeCloseConfirmed)
    const pod = JSON.parse(current.stdout)
    assert.equal(pod.metadata.uid, expected.uid)
    assert.deepEqual(pod.status.containerStatuses.map(c => ({ name: c.name, restartCount: c.restartCount, containerID: c.containerID, imageID: c.imageID })), expected.containers)
    saved('preserved-' + key, { pod, native: current.public })
  }
  const claimResult = await runKubectl(['-n', names.deps, 'get', 'pvc', config.claim.name, '-o', 'json'], { timeoutMs: 10000 })
  assert.ok(claimResult.ok && claimResult.nativeCloseConfirmed)
  const claim = JSON.parse(claimResult.stdout)
  assert.equal(claim.metadata.uid, config.claim.uid); assert.equal(claim.spec.volumeName, config.claim.volumeName)
  saved('preserved-redis-pvc', { claim, native: claimResult.public })
  const transition = (channel, from, to, after, before = Infinity) => {
    const newer = rows(channel, to, after).find(row => row.ended < before)
    const older = newer && rows(channel, from).filter(row => row.ended <= newer.began).at(-1)
    assert.ok(older && newer, 'TRANSITION_BRACKET_MISSING')
    return { bracket: [older.began, newer.ended], lastOldSequence: older.sequence, firstNewSequence: newer.sequence,
      unknownSamples: observer.records.filter(row => row.channel === channel && row.classification?.state === 'unknown' && row.began >= older.began && row.ended <= newer.ended).length,
      scope: 'Last observed old state to first observed new state; not a proof of continuous state or an exact instant.' }
  }
  const reacquisition = transition('pod/ownership', 'unassigned', 'owner', restoredAt)
  const redisReturnBracket = [restoredAt, result.controls.redisAfter.ended]
  const sinceReplay = value => { assert.ok(Number.isFinite(value) && value >= replay.ledger.startedAt); return value - replay.ledger.startedAt }
  result.controls.timings = { clock: 'Single parent performance.now domain, milliseconds',
    deleteRequestedAt: injectionAt, deleteOrigin: 'Parent request dispatch before kubectl spawn; not exact wire transmission or Redis extinction.',
    confirmedAbsenceAt: faultResult.absenceAt, createRequestedAt: restoredAt,
    holdWaitBeforeRestorationMs: faultResult.events.find(row => row.kind === 'hold-ended').at - faultResult.absenceAt,
    absenceToCreateRequestMs: restoredAt - faultResult.absenceAt,
    originalWebSockets: result.controls.originalClosures,
    readinessLoss: transition('pod/ready', 'ready', 'redis-unready', injectionAt, restoredAt),
    endpointWithdrawal: transition('kubernetes/endpoints', 'routable', 'withdrawn', injectionAt, restoredAt),
    readinessReturn: transition('pod/ready', 'redis-unready', 'ready', restoredAt),
    endpointReturn: transition('kubernetes/endpoints', 'withdrawn', 'routable', restoredAt),
    partitionReacquisition: { ...reacquisition, redisReturnBracket,
      redisReturnScope: 'From new Pod create request to completed independent PING/INFO with a new Redis run_id. Parent exec/cleanup overhead included.',
      afterRedisReturnMs: [Math.max(0, reacquisition.bracket[0] - redisReturnBracket[1]), Math.max(0, reacquisition.bracket[1] - redisReturnBracket[0])] },
    reconvergence: { origin: 'Replay ledger.startedAt, after merging saved snapshots and before creating the new peer', startedAt: replay.ledger.startedAt,
      events: replay.ledger.records.filter(row => ['ws-open', 'peer-ready', 'ws-close', 'tls-close'].includes(row.kind)).map(row => ({ kind: row.kind, at: row.at, elapsedMs: sinceReplay(row.at) })),
      acknowledgements: replay.ledger.acknowledgements.map(row => ({ ordinal: row.ordinal, durable: row.durable, bodyCompleteMs: sinceReplay(row.ended), nativeClosedMs: sinceReplay(row.closedAt) })),
      pgVerifiedMs: sinceReplay(result.controls['pg-after-replay'].observedAt), pgNativeClosedMs: sinceReplay(result.controls['pg-after-replay'].proof.clientCloseObservedAt) } }
  saved('timings', result.controls.timings)
  assertAlive()
  result.complete = true; result.phase = 'complete'
} catch (error) {
  result.failure = { phase: result.phase, name: error.name, code: error.code ?? null,
    label: /^[-A-Z0-9_]+$/.test(error.message ?? '') ? error.message : null }
  if (error.evidence) saved('failure-evidence', error.evidence)
  process.exitCode = 1
} finally {
  const cleanupFailures = []
  const publicationFailures = []
  const trySave = (label, value) => { try { saved(label, value) } catch { publicationFailures.push(label) } }
  stoppingAuthors = true
  const settled = await Promise.allSettled(authors.map(author => author.stop()))
  for (const item of settled) if (item.status === 'rejected' || !item.value.transportsClosed) cleanupFailures.push('author')
  const authorsEvidence = settled.map((item, index) => ({ index, status: item.status, ledger: authors[index].ledger,
    transportsClosed: item.status === 'fulfilled' && item.value.transportsClosed,
    snapshot: item.status === 'fulfilled' && item.value.snapshot ? { heads: item.value.snapshot.heads, bytes: item.value.snapshot.bytes.length, sha256: hash(item.value.snapshot.bytes) } : null }))
  const snapshotsEvidence = settled.map((item, index) => ({ index, status: item.status,
    snapshot: item.status === 'fulfilled' && item.value.snapshot ? { documentId: item.value.snapshot.documentId, targetUrl: item.value.snapshot.targetUrl,
      heads: item.value.snapshot.heads, bytes: item.value.snapshot.bytes.length, sha256: hash(item.value.snapshot.bytes),
      base64: Buffer.from(item.value.snapshot.bytes).toString('base64') } : null }))
  stoppingObserver = true
  let observationsEvidence
  if (observer) {
    try { observationsEvidence = await observer.stop(); result.observerNativeResources = observer.nativeResources()
      assert.deepEqual(result.observerNativeResources, { requests: 0, sockets: 0, children: 0 }) }
    catch { cleanupFailures.push('observer') }
  }
  if (lab) { try { result.portForwardCleanup = await lab.close()
    assert.ok(result.portForwardCleanup.every(item => item.closed && item.nativeCloseConfirmed))
  } catch { cleanupFailures.push('port-forwards') } }
  trySave('authors', authorsEvidence)
  trySave('snapshots', snapshotsEvidence)
  if (observationsEvidence) trySave('observations', observationsEvidence)
  result.cleanupFailures = cleanupFailures
  result.publicationFailures = publicationFailures
  result.fault = faultResult && { deleteAttempted: faultResult.deleteAttempted, createAttempted: faultResult.createAttempted, restored: faultResult.restored, successful: faultResult.successful }
  if (cleanupFailures.length || publicationFailures.length) { result.complete = false; process.exitCode = 1 }
  result.verdict = pgLoss ? 'RED_ACCEPTED_DATA_MISSING' : result.complete ? 'FAULT_SCENARIO_PASSED' : 'INCONCLUSIVE'
  result.finishedAt = new Date().toISOString()
  process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal)
  try { fs.closeSync(fd) } catch { publicationFailures.push('journal-close'); result.complete = false; process.exitCode = 1 }
  result.verdict = pgLoss ? 'RED_ACCEPTED_DATA_MISSING' : result.complete ? 'FAULT_SCENARIO_PASSED' : 'INCONCLUSIVE'
  try { saved('result', result) } catch { publicationFailures.push('result'); result.complete = false; process.exitCode = 1
    result.verdict = pgLoss ? 'RED_ACCEPTED_DATA_MISSING' : 'INCONCLUSIVE' }
  // The caller prints PASS only after this finally has confirmed every owner closed.
}

if (!result.complete) { const error = new Error('KUBERNETES_REDIS_GATE_FAILED'); error.evidence = { output: out, verdict: result.verdict, failure: result.failure }; throw error }
return { outcome: 'passed', scenario: 'critical-redis-pod-delete', platform: 'kubernetes-local', replicas: 1, output: out, result }
}
