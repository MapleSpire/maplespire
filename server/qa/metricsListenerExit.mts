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

/**
 * Can the drill's metrics listener delay the process exiting?
 *
 * It must not, on ANY path. The scheduler's top-level catch sets
 * `exitCode = 1` for a configuration error and expects the event loop to
 * drain — and a container that never exits never restarts, so an open handle
 * turns "crash loudly under `restart: always`" into a silent permanent hang.
 * A `try/finally` in the caller would only cover the paths somebody
 * enumerated; unref'ing covers the ones nobody did.
 *
 * This has to run OUT OF PROCESS, because the property is about the event loop
 * draining and a test runner's loop never drains.
 *
 * Two arms, and the control is not optional. Without it a green run says the
 * probe REACHED its report, never that it AGREED.
 *
 *   npx tsx qa/metricsListenerExit.mts listener   -> must exit 0 promptly
 *   npx tsx qa/metricsListenerExit.mts control    -> must print STILL_ALIVE, exit 7
 */

import { Agent, createServer, request } from 'node:http'
import { once } from 'node:events'
import { startMetricsListener } from '../src/runtime/metricsListener.js'

const arm = process.argv[2]
if (arm !== 'listener' && arm !== 'control') {
  console.error('usage: metricsListenerExit.mts <listener|control>')
  process.exit(2)
}

const TOKEN = 'exit-probe-token'
let port: number

if (arm === 'listener') {
  const listener = await startMetricsListener({
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
    collect: () => [{ name: 'maplespire_exit_probe', help: 'probe', type: 'gauge', values: [{ value: 1 }] }],
    log: () => {},
  })
  if (!listener) {
    console.error('the listener did not bind')
    process.exit(2)
  }
  port = listener.port
} else {
  // The CONTROL: the same shape with no unref anywhere. This one MUST hang, or
  // the arm above proves nothing about unref'ing and everything about node
  // happening to exit.
  const server = createServer((_req, res) => { res.end('ok') })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  port = (server.address() as { port: number }).port
}

// One completed scrape over a keep-alive agent, leaving the socket pooled and
// open — which is exactly what Prometheus leaves between two scrapes, and the
// state in which `server.unref()` alone was measured to be insufficient.
const agent = new Agent({ keepAlive: true })
const scrape = await new Promise<{ status: number; body: string }>((settle, fail) => {
  const req = request({
    host: '127.0.0.1', port, path: '/metrics', agent,
    headers: { authorization: `Bearer ${TOKEN}` },
  }, (res) => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => { body += chunk })
    res.on('end', () => settle({ status: res.statusCode ?? 0, body }))
  })
  req.on('error', fail)
  req.end()
})

// THE WITNESS, and without it this probe passes over the defect it exists to
// catch: with no scrape, the accepted-socket unref is never exercised, the
// listener arm exits 0 and the control still hangs (a ref'd plain server holds
// the loop whether or not anything connected). "No request happened" and "the
// request 404'd" are therefore hard failures rather than silent passes.
if (arm === 'listener') {
  if (scrape.status !== 200) {
    console.error(`the listener arm never got a 200 (was ${scrape.status}); nothing was proven`)
    process.exit(2)
  }
  if (!scrape.body.includes('maplespire_exit_probe')) {
    console.error('the listener arm got a 200 with no exposition in it; nothing was proven')
    process.exit(2)
  }
}

// Nothing below refs the loop. If the process is still here at 2 500 ms, the
// listener — or a socket it accepted — is what held it.
const floor = setTimeout(() => {
  console.log('STILL_ALIVE')
  process.exit(7)
}, 2_500)
floor.unref()
