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

/** Short protected HTTP concurrency probe for a deployed performance workspace.
 * It is not a production capacity certification: it records bounded local-stack
 * latency/error evidence at the requested client levels. */
import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { parseServerTimingHeader } from '../src/observability/serverTiming.js'

const baseUrl = (process.env.HTTP_LOAD_BASE_URL ?? 'http://localhost:3015').replace(/\/$/, '')
const email = process.env.HTTP_LOAD_EMAIL
const landscapeId = process.env.HTTP_LOAD_LANDSCAPE_ID ?? 'default'
const versionId = process.env.HTTP_LOAD_VERSION_ID ?? 'current'
const rounds = Math.max(1, Number(process.env.HTTP_LOAD_ROUNDS ?? 3))
const acceptEncoding = process.env.HTTP_LOAD_ACCEPT_ENCODING?.trim()
const connectionQuery = process.env.HTTP_LOAD_CONNECTION_QUERY?.trim()
const levels = (process.env.HTTP_LOAD_LEVELS ?? '1,10,25,50,100')
  .split(',')
  .map((value) => Math.max(1, Number(value.trim())))
  .filter(Number.isFinite)

if (!email) throw new Error('HTTP_LOAD_EMAIL is required')
const base = new URL(baseUrl)
const maxSockets = Math.max(...levels)
const transport = base.protocol === 'https:' ? httpsRequest : httpRequest
const agent = base.protocol === 'https:'
  ? new HttpsAgent({ keepAlive: true, maxSockets })
  : new HttpAgent({ keepAlive: true, maxSockets })

const login = await fetch(`${baseUrl}/api/auth/dev-login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email }),
})
if (!login.ok) throw new Error(`dev login returned HTTP ${login.status}`)
const setCookie = login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie')
const sessionCookie = setCookie?.split(';', 1)[0]
if (!sessionCookie) throw new Error('dev login did not return a session cookie')

const workspace = `landscapeId=${encodeURIComponent(landscapeId)}&versionId=${encodeURIComponent(versionId)}`
const allEndpoints = [
  `/api/model/diagrams/page?limit=60&${workspace}`,
  `/api/model/connections/page?limit=50${connectionQuery ? `&q=${encodeURIComponent(connectionQuery)}` : ''}&${workspace}`,
  `/api/model/decision-records/page?limit=100&${workspace}`,
  `/api/model/viewer/level?limit=50&${workspace}`,
  `/api/model/dependencies/page?focus=perf-o-000010&direction=outgoing&limit=10&${workspace}`,
  `/api/model/diagram-render?id=perf-dg-027004&${workspace}`,
]
const scenario = process.env.HTTP_LOAD_SCENARIO?.trim().toLowerCase() || 'mixed'
const endpoints = scenario === 'connections'
  ? allEndpoints.filter((endpoint) => endpoint.startsWith('/api/model/connections/page'))
  : allEndpoints
if (!endpoints.length) throw new Error(`HTTP load scenario has no endpoints: ${scenario}`)

function percentile(values: readonly number[], quantile: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]
}

function rawGet(endpoint: string, includeSession = true): Promise<{
  status: number
  serverTiming: Record<string, number>
  bodyBytes: number
  encodedBytes: number
}> {
  return new Promise((resolve, reject) => {
    const request = transport(new URL(endpoint, base), {
      agent,
      headers: {
        ...(includeSession ? { cookie: sessionCookie! } : {}),
        'accept-encoding': acceptEncoding || 'gzip',
      },
    }, (response) => {
      let bodyBytes = 0
      response.on('data', (chunk: Buffer) => { bodyBytes += chunk.byteLength })
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        serverTiming: parseServerTimingHeader(
          Array.isArray(response.headers['server-timing'])
            ? response.headers['server-timing'].join(',')
            : response.headers['server-timing'] ?? null,
        ),
        bodyBytes,
        encodedBytes: Number(response.headers['content-length'] ?? 0) || bodyBytes,
      }))
      response.on('error', reject)
    })
    request.setTimeout(30_000, () => request.destroy(new Error('HTTP load request timeout')))
    request.on('error', reject)
    request.end()
  })
}

// One local driver opening 100 sockets on its own event loop otherwise makes
// the first wave mostly a driver/TCP benchmark. Record that cost separately,
// then keep the sockets alive so the measured cold read wave still sees cold
// application/query caches without paying serialized local connection setup.
const preconnectDurations = await Promise.all(Array.from({ length: maxSockets }, async (_, index) => {
  const startedAt = performance.now()
  const response = await rawGet(`/api/health?load-preconnect=${index}`, false)
  if (response.status !== 200) throw new Error(`preconnect returned HTTP ${response.status}`)
  return performance.now() - startedAt
}))
const preconnectP95Ms = Math.round(percentile(preconnectDurations, 0.95))

for (const clients of levels) {
  const samples: Array<{
    endpoint: string
    durationMs: number
    status: number
    serverTiming: Record<string, number>
    bodyBytes: number
    encodedBytes: number
  }> = []
  for (let round = 0; round < rounds; round += 1) {
    const wave = Array.from({ length: clients }, async (_, client) => {
      const endpoint = endpoints[(round * clients + client) % endpoints.length]
      const startedAt = performance.now()
      let status: number
      let serverTiming: Record<string, number> = {}
      let bodyBytes = 0
      let encodedBytes = 0
      try {
        const response = await rawGet(endpoint)
        status = response.status
        serverTiming = response.serverTiming
        encodedBytes = response.encodedBytes
        bodyBytes = response.bodyBytes
      } catch {
        status = 0
      }
      samples.push({ endpoint, status, serverTiming, bodyBytes, encodedBytes, durationMs: performance.now() - startedAt })
    })
    await Promise.all(wave)
  }
  const durations = samples.map((sample) => sample.durationMs)
  const failures = samples.filter((sample) => sample.status < 200 || sample.status >= 300)
  const byEndpoint = Object.fromEntries(endpoints.map((endpoint) => {
    const endpointSamples = samples.filter((sample) => sample.endpoint === endpoint)
    const timingNames = new Set(endpointSamples.flatMap((sample) => Object.keys(sample.serverTiming)))
    return [endpoint.split('?')[0], {
      requests: endpointSamples.length,
      p95Ms: Math.round(percentile(endpointSamples.map((sample) => sample.durationMs), 0.95)),
      maxMs: Math.round(Math.max(0, ...endpointSamples.map((sample) => sample.durationMs))),
      failures: endpointSamples.filter((sample) => sample.status < 200 || sample.status >= 300).length,
      maxBodyBytes: Math.max(0, ...endpointSamples.map((sample) => sample.bodyBytes)),
      maxEncodedBytes: Math.max(0, ...endpointSamples.map((sample) => sample.encodedBytes)),
      serverTimingP95Ms: Object.fromEntries([...timingNames].sort().map((name) => [
        name,
        Math.round(percentile(endpointSamples
          .map((sample) => sample.serverTiming[name])
          .filter((value): value is number => value !== undefined), 0.95) * 10) / 10,
      ])),
    }]
  }))
  console.log(JSON.stringify({
    scenario,
    clientTransport: 'raw-http',
    preconnectedSockets: maxSockets,
    preconnectP95Ms,
    acceptEncoding: acceptEncoding || 'gzip',
    connectionQuery: connectionQuery || null,
    clients,
    rounds,
    requests: samples.length,
    failures: failures.length,
    errorRate: samples.length ? failures.length / samples.length : 0,
    p50Ms: Math.round(percentile(durations, 0.5)),
    p95Ms: Math.round(percentile(durations, 0.95)),
    maxMs: Math.round(Math.max(0, ...durations)),
    byEndpoint,
  }))
}

agent.destroy()
