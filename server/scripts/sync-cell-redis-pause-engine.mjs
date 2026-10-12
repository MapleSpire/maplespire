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

import { request as httpRequest } from 'node:http'
import { isIPv4 } from 'node:net'

/** Filter the inspection before it leaves this module: Config.Env and other
 * daemon data must never become measurement evidence. The witness contacts
 * this exact container IP, not a DNS name, published port or Redis URI. */
function redisWitnessTarget(inspection, expected) {
  const network = inspection.NetworkSettings?.Networks?.[expected.networkName]
  if (inspection.Id !== expected.containerId || inspection.Name !== `/${expected.containerName}`
    || inspection.Config?.Labels?.['com.docker.compose.project'] !== expected.project
    || inspection.Config?.Labels?.['com.docker.compose.service'] !== 'redis'
    || inspection.State?.Running !== true || inspection.State?.Paused !== false
    || !Number.isFinite(Date.parse(inspection.State?.StartedAt))
    || !Number.isInteger(inspection.RestartCount) || inspection.RestartCount < 0
    || !/^sha256:[a-f0-9]{64}$/i.test(inspection.Image ?? '')
    || !/^[a-f0-9]{64}$/i.test(network?.NetworkID ?? '')
    || !isIPv4(network?.IPAddress ?? '') || network.IPAddress === '0.0.0.0') {
    throw new Error('Redis witness identity, Compose ownership, running state or bridge address is invalid')
  }
  return {
    containerId: inspection.Id, imageId: inspection.Image, startedAt: inspection.State.StartedAt,
    restartCount: inspection.RestartCount, project: expected.project, service: 'redis',
    networkName: expected.networkName, networkId: network.NetworkID, ip: network.IPAddress, port: 6379,
  }
}

/** Explicit local transports only. No TCP daemon, remote named pipe, SSH,
 * credentials or environment fallback can change which Engine is measured. */
export function localDockerEngineEndpoint(host) {
  if (typeof host !== 'string') throw new Error('Docker Engine host must be an explicit local npipe:// or unix:// endpoint')
  const pipePrefix = 'npipe:////./pipe/'
  if (host.startsWith(pipePrefix)) {
    const name = host.slice(pipePrefix.length)
    if (/^[a-zA-Z0-9_.-]+$/.test(name)) return { host, socketPath: `\\\\.\\pipe\\${name}` }
  }
  if (host.startsWith('unix:///')) {
    const path = host.slice('unix://'.length)
    if (!path.startsWith('//') && !/[?#\u0000]/.test(path) && path.length > 1) return { host, socketPath: path }
  }
  throw new Error('Docker Engine host must be an explicit local npipe:// or unix:// endpoint')
}

/** No Docker process is spawned between the caller's begin/ACK markers.
 * The request's absolute timeout covers connection, headers AND body. API
 * v1.40 defines POST pause/unpause success as 204 (Docker Engine reference).
 * A timeout is uncertain acquisition; the caller still owns its cleanup. */
export async function createLocalDockerPauseTransport({ engineHost, containerName, containerId, witnessNetwork = null, project = null }, seams = {}) {
  const endpoint = localDockerEngineEndpoint(engineHost)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName ?? '')) throw new Error('invalid expected Redis container name')
  if (!/^[a-f0-9]{64}$/i.test(containerId ?? '')) throw new Error('expected full Redis container Id from Docker CLI')
  if (witnessNetwork !== null && (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(witnessNetwork)
    || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(project ?? ''))) {
    throw new Error('Redis witness needs an explicit Compose project and network name')
  }
  const request = seams.request ?? httpRequest
  const timeoutMs = seams.timeoutMs ?? 15_000
  const base = `/v1.40/containers/${encodeURIComponent(containerName)}`
  const call = (method, path, expectedStatus) => new Promise((resolve, reject) => {
    let client = null
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) { client?.destroy(); reject(error) }
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error(`Docker Engine ${method} request timed out after ${timeoutMs} ms`)), timeoutMs)
    try {
      client = request({ socketPath: endpoint.socketPath, method, path, agent: false, headers: { 'Content-Length': '0' } }, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
          if (body.length > 256 * 1024) finish(new Error('Docker Engine response exceeded the bounded inspection body'))
        })
        response.on('aborted', () => finish(new Error('Docker Engine response was aborted')))
        response.on('error', (error) => finish(error))
        response.on('end', () => {
          if (response.statusCode !== expectedStatus) {
            finish(new Error(`Docker Engine ${method} ${path} returned HTTP ${response.statusCode}, expected ${expectedStatus}`))
          } else finish(null, body)
        })
      })
      client.on('error', (error) => finish(error))
      client.end()
    } catch (error) { finish(error) }
  })
  // Before the baseline or any mutation, prove this endpoint sees the same
  // container the CLI inspected. Do not expose the inspection's Config/Env.
  const inspectionBody = await call('GET', `${base}/json`, 200)
  let inspected
  try { inspected = JSON.parse(inspectionBody) }
  catch { throw new Error('Docker Engine inspection did not return valid JSON') }
  if (inspected.Id !== containerId) throw new Error('Docker Engine identity does not match the Redis container inspected by CLI')
  if (inspected.State?.Paused !== false) throw new Error('Docker Engine Redis container is already paused or its pause state is unavailable')
  const expected = { containerId, containerName, networkName: witnessNetwork, project }
  const witnessTarget = witnessNetwork === null ? null : redisWitnessTarget(inspected, expected)
  return {
    evidence: {
      kind: 'docker-engine', host: endpoint.host, apiVersion: '1.40', containerName,
      cliContainerId: containerId, engineContainerId: inspected.Id,
    },
    ...(witnessTarget ? {
      witnessTarget: Object.freeze(witnessTarget),
      async verifyWitnessIdentity() {
        const body = await call('GET', `/v1.40/containers/${containerId}/json`, 200)
        let finalInspection
        try { finalInspection = JSON.parse(body) }
        catch { throw new Error('Redis witness final inspection did not return valid JSON') }
        const final = redisWitnessTarget(finalInspection, expected)
        if (Object.keys(witnessTarget).some(key => final[key] !== witnessTarget[key])) {
          throw new Error('Redis witness container, process or network identity changed during observation')
        }
        return { valid: true, initial: witnessTarget, final }
      },
    } : {}),
    async readClock() {
      // Only these two fields leave this method: /info also contains host and
      // registry configuration that has no place in a measurement artefact.
      const body = await call('GET', '/v1.40/info', 200)
      let info
      try { info = JSON.parse(body) }
      catch { throw new Error('Docker Engine clock did not return valid JSON') }
      if (typeof info.SystemTime !== 'string' || !Number.isFinite(Date.parse(info.SystemTime))) {
        throw new Error('Docker Engine clock did not provide a valid SystemTime')
      }
      return { generatedAt: info.SystemTime, version: info.ServerVersion ?? null }
    },
    async change(operation) {
      if (operation !== 'pause' && operation !== 'unpause') throw new Error('Docker Engine instrument permits only pause and unpause')
      // Pin the verified Id: replacing the name during the baseline cannot
      // redirect the instrument's mutation to a different container.
      await call('POST', `/v1.40/containers/${containerId}/${operation}`, 204)
    },
  }
}
