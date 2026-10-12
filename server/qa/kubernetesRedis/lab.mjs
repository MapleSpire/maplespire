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
import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import http from 'node:http'
import https from 'node:https'
import pg from 'pg'
import { createFaultIo } from './io.mjs'
import { readDurableDocument } from '../b514-durable-read.mjs'
const { Client } = pg
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const load = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

export function kubernetesRedisOptions(args) {
  if (!args.some(arg => arg.startsWith('--kubernetes-'))) return null
  const names = new Map([['--kubernetes-local-config', 'configFile'], ['--kubernetes-out', 'out'], ['--kubernetes-run-id', 'runId']])
  const result = {}; let redis = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--redis-outage' && !redis) { redis = true; continue }
    const name = names.get(args[i]), value = args[++i]
    assert.ok(name && !Object.hasOwn(result, name) && typeof value === 'string' && value.trim() && !value.startsWith('--'), 'INVALID_KUBERNETES_OPTIONS')
    result[name] = value
  }
  assert.ok(redis && result.configFile && result.out && result.runId, 'INCOMPLETE_KUBERNETES_OPTIONS')
  assert.ok(isAbsolute(result.configFile) && isAbsolute(result.out), 'ABSOLUTE_KUBERNETES_PATHS_REQUIRED')
  assert.match(result.runId, /^b516a-[a-z0-9-]{1,80}$/)
  return result
}

export function validateConfig(c) {
  assert.equal(c.schema, 'maplespire-kubernetes-redis-gate/v1')
  assert.equal(c.context, 'docker-desktop')
  assert.match(c.apiServer, /^https:\/\/127\.0\.0\.1:[0-9]{1,5}$/)
  assert.equal(c.namespace, 'maplespire-b516a-3176')
  assert.equal(c.depsNamespace, c.namespace + '-deps')
  for (const key of ['clusterUid', 'namespaceUid', 'depsNamespaceUid']) assert.match(c[key], uuid)
  assert.equal(c.publicOrigin, 'https://localhost:18443')
  const ports = [18443, c.directPort, c.postgresPort]
  assert.equal(new Set(ports).size, 3)
  assert.ok(ports.every(p => Number.isSafeInteger(p) && p > 1024 && p < 65536))
  for (const key of ['authPath', 'caPath', 'restoreManifestPath', 'postgresSecretPath']) assert.ok(isAbsolute(c[key]))
  for (const key of ['caSha256', 'restoreManifestSha256']) assert.match(c[key], /^[a-f0-9]{64}$/)
  for (const key of ['backend', 'redis', 'cache', 'postgres', 'ingress']) {
    const p = c.resources[key]
    assert.match(p.uid, uuid)
    assert.match(p.name, /^[a-z0-9][-a-z0-9]*$/)
    assert.equal(p.namespace, key === 'backend' ? c.namespace : c.depsNamespace)
    assert.equal(p.containers.length, 1)
    const ctr = p.containers[0]
    assert.ok(ctr.name && ctr.containerID && ctr.imageID && Number.isSafeInteger(ctr.restartCount) && ctr.restartCount >= 0)
  }
  assert.equal(new Set(['backend', 'redis', 'cache', 'postgres', 'ingress'].map(k => c.resources[k].uid)).size, 5)
  assert.equal(c.resources.redis.name, 'redis-critical')
  assert.equal(c.resources.cache.name, 'redis-cache')
  assert.equal(c.resources.postgres.name, 'postgres')
  assert.equal(c.service.name, 'maplespire-backend'); assert.match(c.service.uid, uuid)
  assert.equal(c.claim.name, 'redis-critical-data'); assert.match(c.claim.uid, uuid); assert.match(c.claim.volumeUid, uuid)
  assert.ok(c.target.documentId && c.target.url === 'automerge:' + c.target.documentId)
  assert.ok(c.userId && c.workspace.landscapeId && c.workspace.versionId)
  return c
}

export function assertOwnershipRefusal(response) {
  assert.equal(response.status, 503, 'APPLICATION_OUTAGE_REFUSAL_MISSING')
  assert.equal(response.nativeClosed, true)
  assert.equal(response.body?.retryable, true, 'NON_ROUTING_REFUSAL')
  assert.ok(['workspace owner unavailable', 'workspace routing unavailable'].includes(response.body?.error), 'NON_ROUTING_REFUSAL')
}

export async function joinHttpWitness(requests) {
  const settled = await Promise.allSettled(requests)
  const failed = settled.find(row => row.status === 'rejected')
  if (failed) throw failed.reason
  return settled.map(row => row.value)
}

// Complete HTTP responses and native socket closure; HTML proxy failures are
// recorded as such, never converted to application JSON or readiness witnesses.
export function getJson(origin, route, { cookie, ca, method = 'GET', body, upgrade = false, timeoutMs = 8000 } = {}) {
  const url = new URL(route, origin)
  assert.ok(['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1'].includes(url.hostname))
  return new Promise((resolve, reject) => {
    const began = performance.now()
    let socket, socketClosed = false, requestClosed = false, complete = false, status, failure, bytes = Buffer.alloc(0), settled = false, headers
    let timer
    const finish = () => {
      if (settled || !requestClosed || (socket && !socketClosed)) return
      settled = true; clearTimeout(timer)
      if (failure || !complete) {
        const error = new Error(failure ?? 'HTTP_INCOMPLETE')
        error.httpEvidence = { began, ended: performance.now(), status: status ?? null,
          error: failure ?? 'HTTP_INCOMPLETE', nativeClosed: true, bodyComplete: complete, bodyBytes: bytes.length }
        reject(error); return
      }
      let parsed = null
      try { parsed = JSON.parse(bytes) } catch { /* Proxy/plain-text responses are explicit non-JSON evidence. */ }
      resolve({ began, ended: performance.now(), status, body: parsed, bodySha256: hash(bytes), bodyBytes: bytes.length, headers, nativeClosed: true })
    }
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method, agent: false, family: 4, ...(ca ? { ca, rejectUnauthorized: true } : {}),
      headers: { Connection: upgrade ? 'Upgrade' : 'close', ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(upgrade ? { Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64') } : {}) }
    }, response => {
      status = response.statusCode
      headers = Object.fromEntries(['retry-after', 'content-type', 'cache-control'].filter(k => response.headers[k] !== undefined).map(k => [k, response.headers[k]]))
      response.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 512 * 1024) { failure = 'HTTP_BODY_LIMIT'; request.destroy() } })
      response.once('end', () => { complete = true; request.destroy() })
      response.once('error', () => { failure ??= 'HTTP_RESPONSE_ERROR'; request.destroy() })
    })
    request.once('upgrade', (_res, upgradedSocket) => { failure = 'UNEXPECTED_ACCEPTED_UPGRADE'; upgradedSocket.destroy(); request.destroy() })
    request.once('socket', value => { socket = value; socket.once('close', () => { socketClosed = true; finish() }) })
    request.once('close', () => { requestClosed = true; finish() })
    request.once('error', () => { failure ??= 'HTTP_TRANSPORT_ERROR' })
    timer = setTimeout(() => { failure = 'HTTP_TIMEOUT'; request.destroy(); socket?.destroy() }, timeoutMs)
    request.end(body ? JSON.stringify(body) : undefined)
  })
}

// The public proxy's timeout is not the readiness contract. A local deadline
// without response headers remains UNKNOWN; it never proves an HTTP 503.
export async function observePublicOutage(origin, route, options) {
  try {
    const response = await getJson(origin, route, options)
    assert.ok([502, 503].includes(response.status), 'PUBLIC_OUTAGE_NOT_UNAVAILABLE')
    return { ...response, classification: 'complete-unavailable-response' }
  } catch (error) {
    const e = error.httpEvidence
    if (!e || e.error !== 'HTTP_TIMEOUT' || e.status !== null || e.nativeClosed !== true || e.bodyComplete !== false) throw error
    return { ...e, classification: 'unknown', reason: 'local-deadline-without-response',
      limitation: 'The probe received no headers within its own budget; this is not an application 503 or a completed proxy refusal.' }
  }
}

export async function openLab(config, out) {
  const c = validateConfig(config), io = createFaultIo({ apiServer: c.apiServer })
  const save = (name, v) => fs.writeFileSync(out + '/' + name + '.json', JSON.stringify(v, null, 2) + '\n', { flag: 'wx' })
  const forwards = []
  let closing = false, failed = false, sequence = 0
  const kube = async args => {
    const r = await io.runKubectl(args, { timeoutMs: 15000 })
    save('admission-native-' + ++sequence, r.public)
    assert.ok(r.ok && r.nativeCloseConfirmed, 'KUBECTL_FAILED')
    return JSON.parse(r.stdout)
  }
  const assertTransports = () => { assert.ok(!failed && forwards.every(f => f.isRunning()), 'PORT_FORWARD_ENDED') }
  const close = async () => {
    closing = true
    const closed = await Promise.allSettled(forwards.map(f => f.stop()))
    assert.ok(closed.every(r => r.status === 'fulfilled' && r.value.nativeCloseConfirmed), 'PORT_FORWARD_CLEANUP_FAILED')
    return closed.map(r => r.value)
  }
  try {
    const prior = c.previousQualification
    assert.ok(prior?.sameRuntimePodUids === true, 'PRIOR_RUNTIME_QUALIFICATION_MISSING')
    for (const [file, digest] of [[prior.imagePinsPath, prior.imagePinsSha256], [prior.lastAccessPath, prior.lastAccessSha256]]) {
      assert.ok(isAbsolute(file)); assert.equal(hash(fs.readFileSync(file)), digest)
    }
    const pins = load(prior.imagePinsPath), previousAccess = load(prior.lastAccessPath)
    assert.equal(previousAccess.complete, true)
    assert.equal(c.resources.backend.uid, previousAccess.routing.backendPodUid)
    assert.equal(c.resources.ingress.uid, previousAccess.routing.ingressPodUid)
    assert.equal(c.service.uid, previousAccess.routing.serviceUid)
    assert.deepEqual(c.resources.web.map(p => p.uid).sort(), previousAccess.routing.webPodUids.sort())
    assert.equal(c.resources.backend.images[0].image, pins.images.api)
    assert.ok(c.resources.web.every(p => p.images[0].image === pins.images.web))
    assert.equal((await kube(['get', 'namespace', 'kube-system', '-o', 'json'])).metadata.uid, c.clusterUid)
    for (const [name, uid] of [[c.namespace, c.namespaceUid], [c.depsNamespace, c.depsNamespaceUid]]) {
      const ns = await kube(['get', 'namespace', name, '-o', 'json'])
      assert.equal(ns.metadata.uid, uid); assert.equal(ns.metadata.deletionTimestamp, undefined)
    }
    const objects = {}
    for (const key of ['backend', 'redis', 'cache', 'postgres', 'ingress']) {
      const p = c.resources[key], current = await kube(['-n', p.namespace, 'get', 'pod', p.name, '-o', 'json'])
      assert.equal(current.metadata.uid, p.uid); assert.equal(current.metadata.deletionTimestamp, undefined)
      assert.deepEqual(current.spec.containers.map(x => ({ name: x.name, image: x.image })), p.images)
      assert.deepEqual(current.status.containerStatuses.map(s => ({ name: s.name, restartCount: s.restartCount, containerID: s.containerID, imageID: s.imageID })), p.containers)
      assert.ok(current.status.conditions.some(s => s.type === 'Ready' && s.status === 'True'))
      assert.ok(current.status.containerStatuses.every(s => s.ready && s.state.running))
      objects[key] = current
    }
    const backendList = await kube(['-n', c.namespace, 'get', 'pods', '-l', 'app.kubernetes.io/component=backend', '-o', 'json'])
    assert.equal(backendList.items.length, 1); assert.equal(backendList.items[0].metadata.uid, c.resources.backend.uid)
    const deployment = await kube(['-n', c.namespace, 'get', 'deployment', 'maplespire-backend', '-o', 'json'])
    assert.equal(deployment.spec.replicas, 1)
    const service = await kube(['-n', c.namespace, 'get', 'service', c.service.name, '-o', 'json'])
    assert.equal(service.metadata.uid, c.service.uid)
    const rsName = objects.backend.metadata.ownerReferences.find(ref => ref.controller && ref.kind === 'ReplicaSet')?.name
    assert.ok(rsName, 'BACKEND_REPLICASET_MISSING')
    const replicaSet = await kube(['-n', c.namespace, 'get', 'replicaset', rsName, '-o', 'json'])
    assert.equal(objects.backend.metadata.ownerReferences.find(ref => ref.controller).uid, replicaSet.metadata.uid)
    assert.ok(replicaSet.metadata.ownerReferences.some(ref => ref.controller && ref.uid === deployment.metadata.uid && ref.kind === 'Deployment'))
    assert.equal(deployment.status.observedGeneration, deployment.metadata.generation)
    assert.equal(deployment.status.readyReplicas, 1)
    const ingress = await kube(['-n', c.namespace, 'get', 'ingress', 'maplespire', '-o', 'json'])
    assert.equal(ingress.spec.ingressClassName, 'b516a-3176-traefik')
    assert.ok(ingress.spec.rules.some(rule => rule.host === 'localhost' && rule.http.paths.some(p => p.path === '/' && p.backend.service.name === 'maplespire-web')))
    assert.ok(objects.ingress.spec.containers[0].args.some(arg => arg.toLowerCase().includes('nativelbbydefault=true')))
    const webService = await kube(['-n', c.namespace, 'get', 'service', 'maplespire-web', '-o', 'json'])
    const webList = await kube(['-n', c.namespace, 'get', 'pods', '-l', 'app.kubernetes.io/component=web', '-o', 'json'])
    assert.equal(webList.items.length, 2)
    assert.deepEqual(webList.items.map(p => p.metadata.uid).sort(), c.resources.web.map(p => p.uid).sort())
    for (const pod of webList.items) {
      const expectedWeb = c.resources.web.find(p => p.uid === pod.metadata.uid)
      assert.deepEqual(pod.spec.containers.map(x => ({ name: x.name, image: x.image })), expectedWeb.images)
      assert.deepEqual(pod.status.containerStatuses.map(x => ({ name: x.name, restartCount: x.restartCount, containerID: x.containerID, imageID: x.imageID })), expectedWeb.containers)
      assert.ok(Object.entries(webService.spec.selector).every(([key, value]) => pod.metadata.labels[key] === value))
      assert.ok(pod.status.conditions.some(s => s.type === 'Ready' && s.status === 'True'))
      const env = Object.fromEntries(pod.spec.containers.find(x => x.name === 'web').env.map(e => [e.name, e.value]))
      for (const name of ['BACKEND_HOST', 'SYNC_WS_HOST']) assert.equal(env[name], c.service.name)
      for (const name of ['BACKEND_PORT', 'SYNC_WS_PORT']) assert.equal(env[name], '3001')
    }
    save('public-routing', { ingress, webService, webPods: webList.items, replicaSet,
      path: 'Traefik TLS Ingress -> web Service -> Nginx web Pod -> backend Service -> backend Pod' })
    const publicKeys = ['NODE_ENV', 'AUTH_DEV_LOGIN', 'ORG_SEED', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_TLS', 'REDIS_KEY_PREFIX',
      'REDIS_COMMAND_TIMEOUT_MS', 'REDIS_RENDER_CACHE_HOST', 'REDIS_RENDER_CACHE_PORT', 'REDIS_RENDER_CACHE_TLS', 'REDIS_RENDER_CACHE_COMMAND_TIMEOUT_MS', 'SYNC_CELL_PARTITION_COUNT', 'SYNC_CELL_TOPOLOGY_GENERATION']
    const program = 'process.stdout.write(JSON.stringify(Object.fromEntries(' + JSON.stringify(publicKeys) + '.map(k => [k,process.env[k] ?? null]))))'
    const environment = await kube(['-n', c.namespace, 'exec', c.resources.backend.name, '-c', 'backend', '--', 'node', '-e', program])
    assert.equal(environment.NODE_ENV, 'production')
    for (const key of ['AUTH_DEV_LOGIN', 'ORG_SEED']) assert.ok(!['true', 'on', '1'].includes(environment[key]?.toLowerCase()))
    assert.equal(environment.DB_HOST, 'postgres.' + c.depsNamespace + '.svc.cluster.local')
    assert.equal(environment.DB_NAME, 'b516a'); assert.equal(environment.DB_PORT, '5432')
    assert.equal(environment.REDIS_HOST, 'redis-critical.' + c.depsNamespace + '.svc.cluster.local')
    assert.equal(environment.REDIS_RENDER_CACHE_HOST, 'redis-cache.' + c.depsNamespace + '.svc.cluster.local')
    for (const key of ['REDIS_COMMAND_TIMEOUT_MS', 'REDIS_RENDER_CACHE_COMMAND_TIMEOUT_MS']) assert.equal(environment[key], '1500')
    assert.equal(environment.SYNC_CELL_PARTITION_COUNT, '1')
    const configKeys = ['enabled', 'leaseTtlMs', 'renewIntervalMs', 'partitionLeaseTtlMs', 'partitionRenewIntervalMs', 'leaseCommandTimeoutMs', 'partitionProbeIntervalMs', 'partitionWorker', 'reconcileIntervalMs']
    const effectiveProgram = "import('./dist/syncCells/ownership.js').then(({syncCellOwnershipConfig})=>{const c=syncCellOwnershipConfig(process.env);process.stdout.write(JSON.stringify(Object.fromEntries(" + JSON.stringify(configKeys) + '.map(k=>[k,c[k]]))))}).catch(()=>{process.exitCode=1})'
    const effectiveOwnership = await kube(['-n', c.namespace, 'exec', c.resources.backend.name, '-c', 'backend', '--', 'node', '-e', effectiveProgram])
    assert.deepEqual(effectiveOwnership, { enabled: true, leaseTtlMs: 15000, renewIntervalMs: 5000, partitionLeaseTtlMs: 1500,
      partitionRenewIntervalMs: 400, leaseCommandTimeoutMs: 550, partitionProbeIntervalMs: 100, partitionWorker: false, reconcileIntervalMs: 5000 })
    save('effective-configuration', { environment, effectiveOwnership })
    const claim = await kube(['-n', c.depsNamespace, 'get', 'pvc', c.claim.name, '-o', 'json'])
    const volume = await kube(['get', 'pv', c.claim.volumeName, '-o', 'json'])
    assert.equal(claim.metadata.uid, c.claim.uid); assert.equal(claim.spec.volumeName, c.claim.volumeName)
    assert.equal(volume.metadata.uid, c.claim.volumeUid); assert.equal(volume.spec.claimRef.uid, c.claim.uid)
    const manifestBytes = fs.readFileSync(c.restoreManifestPath)
    assert.equal(hash(manifestBytes), c.restoreManifestSha256)
    const manifest = JSON.parse(manifestBytes)
    assert.deepEqual(objects.redis.spec, manifest.spec)
    const ca = fs.readFileSync(c.caPath); assert.equal(hash(ca), c.caSha256)
    const { cookie } = load(c.authPath)
    assert.ok(typeof cookie === 'string' && cookie.length > 0)
    save('admitted-objects', { ...objects, service, claim, volume, deployment })
    for (const [key, port, remotePort] of [['ingress', 18443, 8443], ['backend', c.directPort, 3001], ['postgres', c.postgresPort, 5432]]) {
      const p = c.resources[key]
      const f = await io.startPodPortForward({ namespace: p.namespace, podName: p.name, podUid: p.uid, port, remotePort, lifetimeMs: 600000 })
      forwards.push(f)
      void f.done.then(() => { if (!closing) failed = true }, () => { if (!closing) failed = true })
    }
    save('port-forwards', forwards.map(f => ({ pid: f.pid, origin: f.origin, admission: f.admission })))
    const directOrigin = 'http://127.0.0.1:' + c.directPort
    const stats = await getJson(directOrigin, '/api/automerge/stats', { cookie })
    assert.equal(stats.status, 200); assert.match(stats.body.processBootId, uuid)
    const me = await getJson(c.publicOrigin, '/api/auth/me', { cookie, ca })
    assert.equal(me.status, 200); assert.equal(me.body.user.id, c.userId)
    const secret = load(c.postgresSecretPath).items.find(s => s.metadata.name === 'b516a-runtime').stringData
    const pgConfig = { host: '127.0.0.1', port: c.postgresPort, database: 'b516a', user: secret.DB_USER, password: secret.DB_PASSWORD,
      ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: 'b516b-independent-oracle' }
    assertTransports()
    return { config: c, directOrigin, serviceOrigin: c.publicOrigin, cookie, ca, processBootId: stats.body.processBootId,
      workspace: c.workspace, target: c.target, manifest, objects, pgConfig, runKubectl: io.runKubectl, close, assertTransports }
  } catch (error) { await close(); throw error }
}
export async function readPg(lab, request) {
  const client = new Client(lab.pgConfig)
  const began = performance.now()
  let connected = false, proof, fault, socketClosedAt = null, forced = false, durableReadEvidence = null
  const socket = client.connection.stream
  const nativeClosed = new Promise(resolve => socket.once('close', () => { socketClosedAt = performance.now(); resolve() }))
  const phaseTimer = setTimeout(() => { forced = true; fault = new Error('PG_PHASE_TIMEOUT'); socket.destroy(fault) }, 25000)
  client.on('error', () => { fault ??= new Error('PG_TRANSPORT_ERROR') })
  try {
    await client.connect(); connected = true
    const identity = await client.query('SELECT current_database() AS database, current_user AS username, pg_backend_pid() AS pid')
    assert.equal(identity.rows[0].database, 'b516a'); assert.equal(identity.rows[0].username, 'b516a')
    proof = await readDurableDocument(client, request)
    durableReadEvidence = { began, observedAt: performance.now(), identity: identity.rows[0], proof }
    return durableReadEvidence
  } finally {
    const cleanupTimer = setTimeout(() => { forced = true; socket.destroy() }, 8000)
    try {
      let cleanupError
      try { await client.end() } catch (error) { cleanupError = error; socket.destroy() }
      await nativeClosed
      if (cleanupError) throw cleanupError
      if (fault) throw fault
      if (forced) throw new Error('PG_CLEANUP_FORCED')
      if (proof) proof.clientCloseObservedAt = socketClosedAt
      if (!connected) assert.equal(proof, undefined)
    } catch (error) {
      // A completed oracle remains a fact even when its later cleanup fails.
      // In particular, never lose an established not-durable result here.
      if (durableReadEvidence) error.durableReadEvidence = durableReadEvidence
      throw error
    } finally { clearTimeout(cleanupTimer); clearTimeout(phaseTimer) }
  }
}
