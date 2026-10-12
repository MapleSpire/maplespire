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

import http from 'k6/http'
import ws from 'k6/ws'
import { check, sleep } from 'k6'
import { Counter, Trend } from 'k6/metrics'

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3001').replace(/\/$/, '')
const SESSION_COOKIE = __ENV.SESSION_COOKIE || ''
const LANDSCAPE_ID = __ENV.LANDSCAPE_ID || 'default'
const VERSION_ID = __ENV.VERSION_ID || 'current'
const WS_BASE_URL = __ENV.WS_URL || BASE_URL.replace(/^http/, 'ws') + '/automerge'
const WS_SEPARATOR = WS_BASE_URL.includes('?') ? '&' : '?'
const WS_URL = WS_BASE_URL.includes('landscapeId=') || WS_BASE_URL.includes('versionId=')
  ? WS_BASE_URL
  : `${WS_BASE_URL}${WS_SEPARATOR}landscapeId=${encodeURIComponent(LANDSCAPE_ID)}&versionId=${encodeURIComponent(VERSION_ID)}`
const DIAGRAM_ID = __ENV.DIAGRAM_ID || 'seed-dg-checkout'
const HOLD_SECONDS = Number(__ENV.WS_HOLD_SECONDS || 60)

const headers = SESSION_COOKIE ? { Cookie: SESSION_COOKIE } : {}
const renderLatency = new Trend('diagram_render_duration', true)
const websocketFailures = new Counter('websocket_transport_failures')
const websocketUnexpectedCloses = new Counter('websocket_unexpected_closes')
const websocketSessionDuration = new Trend('websocket_session_duration', true)

export const options = {
  scenarios: {
    read_model: {
      executor: 'constant-arrival-rate',
      exec: 'readModel',
      rate: Number(__ENV.RENDER_RPS || 10),
      timeUnit: '1s',
      duration: __ENV.DURATION || '5m',
      preAllocatedVUs: Number(__ENV.HTTP_VUS || 20),
      maxVUs: Number(__ENV.HTTP_MAX_VUS || 100),
    },
    websocket_transport: {
      executor: 'ramping-vus',
      exec: 'websocketTransport',
      startVUs: 0,
      stages: [
        { duration: '1m', target: Number(__ENV.WS_VUS || 50) },
        { duration: __ENV.DURATION || '5m', target: Number(__ENV.WS_VUS || 50) },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    diagram_render_duration: ['p(95)<500', 'p(99)<1000'],
    websocket_transport_failures: ['count==0'],
    websocket_unexpected_closes: ['count==0'],
  },
}
export function readModel() {
  const url = `${BASE_URL}/api/model/diagram-render?id=${encodeURIComponent(DIAGRAM_ID)}`
    + `&landscapeId=${encodeURIComponent(LANDSCAPE_ID)}&versionId=${encodeURIComponent(VERSION_ID)}`
  const response = http.get(url, { headers, tags: { operation: 'diagram-render' } })
  renderLatency.add(response.timings.duration)
  check(response, { 'diagram render is 200': (r) => r.status === 200 })
}

/**
 * Transport-only socket soak. It validates ALB/Ingress connection capacity and
 * idle timeouts, not Automerge convergence. Use server/qa/load-users.mjs for the
 * real binary Automerge protocol and cross-peer convergence.
 */
export function websocketTransport() {
  const startedAt = Date.now()
  const response = ws.connect(WS_URL, { headers }, (socket) => {
    socket.on('error', () => websocketFailures.add(1))
    socket.on('close', (code) => {
      websocketSessionDuration.add(Date.now() - startedAt)
      if (code !== 1000 && code !== 1001) websocketUnexpectedCloses.add(1)
    })
    socket.setInterval(() => socket.ping(), 20_000)
    socket.setTimeout(() => socket.close(1000, 'qualification complete'), HOLD_SECONDS * 1000)
  })
  if (!check(response, { 'websocket upgraded': (r) => r && r.status === 101 })) websocketFailures.add(1)
  sleep(1)
}
