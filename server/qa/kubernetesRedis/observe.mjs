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

import { request as httpRequest, validateHeaderValue } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const dnsName = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const unknown = reason => ({ state: 'unknown', reason })
const integer = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('invalid ' + label)
  return value
}
const name = (value, label) => {
  if (typeof value !== 'string' || value.length > 253 || !dnsName.test(value)) throw new Error('invalid ' + label)
  return value
}
function origin(value) {
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('explicit loopback origin required')
  return parsed
}
const complete = result => result && result.error === null && result.status === 200 && result.body && typeof result.body === 'object'
const subset = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value ?? {}, key)).map(key => [key, value[key]]))

export function classifyReadiness(result) {
  if (!result || result.error !== null || ![200, 503].includes(result.status)) return unknown('no-complete-readiness-response')
  if (result.body?.status === 'not-ready' && result.status === 503 && result.body?.checks?.redis === false) {
    return { state: 'redis-unready', checks: subset(result.body.checks, ['database', 'automerge', 'readModel', 'redis', 'renderCacheRedis', 'syncCellOwnership', 'syncCellConverged']) }
  }
  if (result.body?.status === 'ready' && result.status === 200 && result.body?.checks?.redis === true) return { state: 'ready' }
  return unknown('readiness-body-status-mismatch-or-other-cause')
}

export function classifyOwnership(before, middle, after, expectedBootId) {
  if (![before, middle, after].every(complete)) return unknown('incomplete-identity-bracket')
  const first = before.body.processBootId, last = after.body.processBootId
  if (!uuid.test(first ?? '') || first !== last || first !== expectedBootId) return unknown('process-identity-changed-or-missing')
  const body = middle.body
  if (body.enabled !== true || body.partitionCount !== 1 || ![null, 0].includes(body.partitionIndex)
    || ![body.partitionLossCount, body.partitionAcquisitionCount].every(value => Number.isSafeInteger(value) && value >= 0)) return unknown('invalid-single-cell-state')
  const ready = body.partitionIndex === 0 && body.ready === true && body.partitionReady === true
  const unassigned = body.partitionIndex === null && body.ready === false && body.partitionReady === false
  if (!ready && !unassigned) return unknown('inconsistent-partition-state')
  return { state: ready ? 'owner' : 'unassigned', processBootId: first,
    ownership: subset(body, ['cellId', 'partitionCount', 'partitionIndex', 'ready', 'partitionReady', 'canServe',
      'partitionLossCount', 'partitionAcquisitionCount', 'topologyGeneration', 'topologyConfirmed', 'topologyKeyCreatedAtBoot', 'storageFence']) }
}

// A complete Service+Pod+LIST bracket only. No watch cache, no partial-page inference.
// Conditions with null/absent ready are UNKNOWN, never a withdrawal witness.
export function classifyEndpoints({ service, pod, slices }, expected) {
  if (![service, pod, slices].every(complete)) return unknown('incomplete-kubernetes-bracket')
  const s = service.body, p = pod.body, list = slices.body
  if (s.kind !== 'Service' || s.metadata?.uid !== expected.serviceUid || s.metadata?.name !== expected.serviceName
    || s.metadata?.namespace !== expected.namespace || p.kind !== 'Pod' || p.metadata?.uid !== expected.podUid
    || p.metadata?.name !== expected.podName || p.metadata?.namespace !== expected.namespace) return unknown('kubernetes-identity-mismatch')
  if (p.metadata.deletionTimestamp || s.spec?.publishNotReadyAddresses === true) return unknown('backend-terminating-or-unready-published')
  const selector = s.spec?.selector
  if (!selector || !Object.keys(selector).length || Object.entries(selector).some(([key, value]) => p.metadata?.labels?.[key] !== value)) return unknown('service-selector-mismatch')
  if (!Array.isArray(s.spec?.ports) || s.spec.ports.filter(port => port?.port === 3001 && (port.protocol ?? 'TCP') === 'TCP').length !== 1) return unknown('service-port-mismatch')
  if (!Array.isArray(p.status?.podIPs) || !p.status.podIPs.length || p.status.podIPs.some(item => typeof item?.ip !== 'string' || !item.ip)) return unknown('pod-address-missing')
  if (!['List', 'EndpointSliceList'].includes(list.kind) || !Array.isArray(list.items)
    || typeof list.metadata?.resourceVersion !== 'string' || !list.metadata.resourceVersion
    || (list.metadata.continue ?? '') !== '') return unknown('partial-or-invalid-slice-list')
  const typedSliceList = list.kind === 'EndpointSliceList' && list.apiVersion === 'discovery.k8s.io/v1'
  if (list.kind === 'EndpointSliceList' && !typedSliceList) return unknown('invalid-slice-list-type')
  const allowedIPs = new Set(p.status.podIPs.map(item => item.ip)), endpoints = new Map()
  for (const slice of list.items) {
    // Raw typed LIST items omit TypeMeta. Only that verified envelope supplies
    // an absent item kind; an explicitly foreign kind/version is still refused.
    if ((slice?.kind !== 'EndpointSlice' && !(typedSliceList && slice?.kind === undefined))
      || (slice?.apiVersion !== undefined && slice.apiVersion !== 'discovery.k8s.io/v1')
      || !uuid.test(slice?.metadata?.uid ?? '') || slice.metadata?.namespace !== expected.namespace
      || slice.metadata?.labels?.['kubernetes.io/service-name'] !== expected.serviceName
      || !Array.isArray(slice.metadata?.ownerReferences) || !slice.metadata.ownerReferences.some(ref => ref?.kind === 'Service' && ref.uid === expected.serviceUid)
      || !Array.isArray(slice.endpoints) || !Array.isArray(slice.ports)) return unknown('foreign-or-invalid-slice')
    const ports = slice.ports.filter(port => port?.port === 3001 && (port.protocol ?? 'TCP') === 'TCP')
    if (!ports.length && slice.endpoints.length) return unknown('slice-port-mismatch')
    for (const endpoint of slice.endpoints) {
      if (endpoint?.targetRef?.kind !== 'Pod' || endpoint.targetRef?.uid !== expected.podUid || endpoint.targetRef?.name !== expected.podName
        || endpoint.targetRef?.namespace !== expected.namespace || !Array.isArray(endpoint.addresses)
        || !endpoint.addresses.length || endpoint.addresses.some(ip => !allowedIPs.has(ip))) return unknown('unexpected-endpoint')
      if (typeof endpoint.conditions?.ready !== 'boolean' || endpoint.conditions.terminating === true) return unknown('unknown-or-terminating-endpoint')
      for (const ip of endpoint.addresses) {
        const key = ip + ':3001'
        if (endpoints.has(key) && endpoints.get(key) !== endpoint.conditions.ready) return unknown('contradictory-duplicate-endpoint')
        endpoints.set(key, endpoint.conditions.ready)
      }
    }
  }
  if (!Array.isArray(p.status?.conditions) || !Array.isArray(p.status.containerStatuses ?? [])) return unknown('pod-status-schema-mismatch')
  const readyCondition = p.status.conditions.find(condition => condition?.type === 'Ready')
  if (!readyCondition || !['True', 'False'].includes(readyCondition.status)) return unknown('pod-ready-condition-missing')
  const readyCount = [...endpoints.values()].filter(Boolean).length
  return { state: readyCount ? 'routable' : 'withdrawn', readyEndpointCount: readyCount, endpointCount: endpoints.size,
    podReady: readyCondition.status === 'True', podUid: expected.podUid, serviceUid: expected.serviceUid,
    resourceVersion: list.metadata.resourceVersion,
    sliceUids: list.items.map(slice => slice.metadata.uid), podRestartCounts: (p.status.containerStatuses ?? []).map(container => ({ name: container?.name, restartCount: container?.restartCount })) }
}

export function makeDeleteOptions(podUid) {
  if (!uuid.test(podUid ?? '')) throw new Error('explicit Redis Pod UID required')
  return { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: podUid }, propagationPolicy: 'Foreground' }
}

// Native response+transport collector adapted from b514-observe, but one cell;
// HTTP and HTTPS origins remain loopback. This module has NO mutation command.
export function startB516Observation(options = {}) {
  if (options.apiServer !== undefined && !/^https:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(options.apiServer)) throw new Error('local Kubernetes API required')
  const direct = origin(options.directOrigin), serviceOrigin = origin(options.serviceOrigin)
  if (direct.origin === serviceOrigin.origin) throw new Error('direct Pod and actual Service paths must be distinct')
  const expected = Object.freeze({ ...options.expected })
  for (const key of ['namespace', 'serviceName', 'podName']) name(expected[key], key)
  for (const key of ['serviceUid', 'podUid']) if (!uuid.test(expected[key] ?? '')) throw new Error('invalid ' + key)
  if (!uuid.test(options.processBootId ?? '')) throw new Error('explicit processBootId required')
  if (typeof options.cookie !== 'string' || !options.cookie.trim() || options.cookie.length > 16384) throw new Error('authenticated cookie required in memory')
  validateHeaderValue('Cookie', options.cookie)
  const periodMs = integer(options.periodMs ?? 100, 50, 1000, 'HTTP period')
  const kubernetesPeriodMs = integer(options.kubernetesPeriodMs ?? 1000, 250, 5000, 'Kubernetes period')
  const timeoutMs = integer(options.timeoutMs ?? 4000, 3000, 10000, 'request timeout')
  const durationMs = integer(options.durationMs ?? 120000, 1000, 180000, 'observation duration')
  if (typeof options.onRecord !== 'function') throw new Error('synchronous evidence sink required')
  const now = options.now ?? (() => performance.now())
  const abort = new AbortController(), requests = new Set(), sockets = new Set(), children = new Set(), records = []
  let lastAt = -Infinity, fatal = null, sequence = 0, stopFlight
  const clock = () => {
    const at = now()
    if (!Number.isFinite(at) || at < lastAt) throw new Error('invalid or regressing monotonic clock')
    lastAt = at
    return at
  }
  clock()
  const fail = error => { fatal ??= error; abort.abort() }
  const arrival = () => { try { return clock() } catch (error) { fail(error); return null } }
  const emit = entry => {
    const row = { ...entry, sequence: ++sequence, at: clock() }
    records.push(row)
    const result = options.onRecord(structuredClone(row))
    if (result && typeof result.then === 'function') {
      void Promise.resolve(result).catch(() => undefined)
      throw new Error('asynchronous evidence sink refused')
    }
    return row
  }
  const getHttp = (base, path, authenticated = false) => {
    const began = clock()
    if (abort.signal.aborted) return Promise.resolve({ began, ended: began, closedAt: began, status: null, error: 'aborted' })
    return new Promise(resolve => {
      let socket, socketClosed = false, requestClosed = false, ended = null, status = null, body, error = null, completeBody = false, settled = false, bytes = 0
      const chunks = []
      let timer
      const finish = () => {
        if (settled || !requestClosed || (socket && !socketClosed)) return
        settled = true
        clearTimeout(timer)
        abort.signal.removeEventListener('abort', cancel)
        requests.delete(req)
        const closedAt = arrival()
        error ??= fatal ? 'collector-failed' : completeBody ? null : 'incomplete-response'
        resolve({ began, ended: ended ?? closedAt, closedAt, status: error ? null : status, responseStatus: status,
          error, bodySha256: sha(Buffer.concat(chunks)), ...(error ? {} : { body }) })
      }
      const destroy = reason => {
        if (!completeBody) error ??= reason
        ended ??= arrival()
        req.destroy()
        socket?.destroy()
      }
      const cancel = () => destroy('aborted')
      const request = base.protocol === 'https:' ? httpsRequest : httpRequest
      const req = request({ protocol: base.protocol, hostname: base.hostname === '[::1]' ? '::1' : '127.0.0.1',
        port: base.port || (base.protocol === 'https:' ? 443 : 80), path, method: 'GET', agent: false,
        ...(base.protocol === 'https:' ? { servername: base.hostname, ca: options.ca, rejectUnauthorized: true } : {}),
        headers: { Host: base.host, Connection: 'close', ...(authenticated ? { Cookie: options.cookie } : {}) } }, response => {
        status = response.statusCode ?? null
        response.once('error', () => destroy('response-error'))
        response.once('aborted', () => destroy('incomplete-response'))
        if (status >= 300 && status < 400) { destroy('redirect-refused'); return }
        response.on('data', chunk => {
          bytes += chunk.length
          if (bytes > 2 * 1024 * 1024) { destroy('body-too-large'); return }
          chunks.push(chunk)
        })
        response.once('end', () => {
          ended = arrival()
          completeBody = true
          clearTimeout(timer)
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (!body || typeof body !== 'object' || Array.isArray(body)) error ??= 'invalid-json-object'
          } catch { error ??= 'invalid-json' }
          socket?.destroy()
        })
      })
      requests.add(req)
      req.once('socket', value => {
        socket = value
        sockets.add(socket)
        socket.once('close', () => { socketClosed = true; sockets.delete(socket); finish() })
      })
      req.once('error', () => destroy('request-error'))
      req.once('close', () => { requestClosed = true; finish() })
      timer = setTimeout(() => destroy('timeout'), timeoutMs)
      abort.signal.addEventListener('abort', cancel, { once: true })
      if (abort.signal.aborted) cancel()
      req.end()
    })
  }
  const getKubernetes = resource => {
    const began = clock()
    if (abort.signal.aborted) return Promise.resolve({ began, ended: began, closedAt: began, status: null, error: 'aborted' })
    return new Promise(resolve => {
      const args = ['--context=docker-desktop', ...(options.apiServer ? ['--server=' + options.apiServer] : []), '--namespace=' + expected.namespace, '--request-timeout=4s', 'get',
        ...resource, ...(resource[0] === '--raw' ? [] : ['--output=json', '--chunk-size=0'])]
      const child = spawn(options.kubectlPath ?? 'kubectl', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
      children.add(child)
      const chunks = []
      let bytes = 0, stderrBytes = 0, failure = null, escalation
      const terminate = reason => {
        failure ??= reason
        try { child.kill() } catch { failure = 'child-kill-failed' }
        escalation ??= setTimeout(() => {
          try { child.kill('SIGKILL') } catch { failure = 'child-kill-failed' }
        }, 500)
      }
      const cancel = () => terminate('aborted')
      const timer = setTimeout(() => terminate('timeout'), timeoutMs)
      abort.signal.addEventListener('abort', cancel, { once: true })
      child.stdout.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 4 * 1024 * 1024) terminate('body-too-large'); else chunks.push(chunk)
      })
      child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 1024 * 1024) terminate('stderr-too-large') })
      child.once('error', () => { failure ??= 'spawn-error' })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        clearTimeout(escalation)
        abort.signal.removeEventListener('abort', cancel)
        children.delete(child)
        const closedAt = arrival()
        let body
        if (code !== 0 || signal) failure ??= 'kubectl-failed'
        if (!failure) {
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { failure = 'invalid-json' }
        }
        if (fatal) failure ??= 'collector-failed'
        resolve({ began, ended: closedAt, closedAt, status: failure ? null : 200, error: failure, bodySha256: sha(Buffer.concat(chunks)),
          code, signal, bytes, stderrBytes, ...(failure ? {} : { body }) })
      })
      if (abort.signal.aborted) cancel()
    })
  }
  const metadata = result => subset(result, ['began', 'ended', 'closedAt', 'status', 'responseStatus', 'error', 'bodySha256', 'code', 'signal', 'bytes', 'stderrBytes'])
  const loop = async (channel, sample, period) => {
    try {
      while (!abort.signal.aborted) {
        const began = clock(), result = await sample()
        if (fatal) return
        emit({ kind: 'sample', channel, began, ended: clock(), ...result })
        try { await delay(Math.max(0, period - (clock() - began)), undefined, { signal: abort.signal }) }
        catch (error) { if (!abort.signal.aborted) throw error }
      }
    } catch (error) { fail(error) }
  }
  const channels = [
    ['pod/ready', async () => { const response = await getHttp(direct, '/api/ready'); return { response: metadata(response), classification: classifyReadiness(response) } }, periodMs],
    ['service/ready', async () => { const response = await getHttp(serviceOrigin, '/api/ready'); return { response: metadata(response), classification: classifyReadiness(response) } }, periodMs],
    ['pod/health', async () => {
      const response = await getHttp(direct, '/api/health')
      return { response: metadata(response), classification: complete(response) && response.body.status === 'ok'
        ? { state: 'healthy' } : unknown('no-complete-health-response') }
    }, periodMs],
    ['pod/ownership', async () => {
      const before = await getHttp(direct, '/api/automerge/stats', true), middle = await getHttp(direct, '/api/platform/sync-cell', true), after = await getHttp(direct, '/api/automerge/stats', true)
      return { before: metadata(before), middle: metadata(middle), after: metadata(after), classification: classifyOwnership(before, middle, after, options.processBootId) }
    }, periodMs],
    ['kubernetes/endpoints', async () => {
      const [service, pod, slices] = await Promise.all([
        getKubernetes(['service/' + expected.serviceName]), getKubernetes(['pod/' + expected.podName]),
        // The generic kubectl printer emits kind List with an empty RV. Read
        // the actual API LIST so the unchanged completeness guard can judge it.
        getKubernetes(['--raw', '/apis/discovery.k8s.io/v1/namespaces/' + expected.namespace + '/endpointslices'
          + '?labelSelector=' + encodeURIComponent('kubernetes.io/service-name=' + expected.serviceName)]),
      ])
      return { responses: { service: metadata(service), pod: metadata(pod), slices: metadata(slices) },
        classification: classifyEndpoints({ service, pod, slices }, expected) }
    }, kubernetesPeriodMs],
  ]
  const timer = setTimeout(() => abort.abort(), durationMs)
  const loops = channels.map(([channel, sample, period]) => Promise.resolve().then(() => loop(channel, sample, period)))
  const done = Promise.all(loops).then(() => {
    clearTimeout(timer)
    if (requests.size || sockets.size || children.size) throw new Error('native cleanup incomplete')
    if (fatal) throw fatal
    return { schema: 'b516-observation-skeleton/v1', records, taskComplete: false, verdict: 'UNADJUDICATED',
      transport: { requests: requests.size, sockets: sockets.size, children: children.size },
      limits: ['Kubernetes GET brackets are not atomic and may miss short transitions.', 'Polling ownership invokes pruneExpired.',
        'No fault, Redis availability witness, WS author, PG oracle, replay or final verdict is implemented here.'] }
  })
  void done.catch(() => undefined)
  return { records, done, clock,
    nativeResources() { return { requests: requests.size, sockets: sockets.size, children: children.size } },
    stop() { if (!stopFlight) { abort.abort(); stopFlight = done } return stopFlight },
  }
}
