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

import { createServer, type Server } from 'node:http'
import { listenReady } from './listen.js'
import { metricsTokenMatches, renderPrometheus, type MetricSample } from './metrics.js'

/**
 * A separate `/metrics` listener for processes without an Express metrics route.
 *
 * The backup drill scheduler and WebSocket router are callers. The drill is
 * the reason this is `node:http` and not the Express app: importing `index.ts`
 * into the drill container's entrypoint would drag the whole API — every
 * route, the Automerge repo, Redis — into a process whose job is to run
 * `pg_dump`. This shares the token check and the renderer with the API's own
 * route, which are the two parts that must not diverge.
 *
 * Everything here fails toward "the drill still runs". A metrics endpoint that
 * can stop a backup is worse than no metrics endpoint.
 */

/**
 * How long `stop()` waits before settling regardless.
 *
 * EXPORTED so `scripts/maplespire-compose.test.mjs` can check its own literal
 * against it. That test deliberately keeps an un-derived number (a bound taken
 * from the constant under test agrees with any value), and asserts the two
 * agree so neither copy drifts silently.
 */
export const METRICS_STOP_CEILING_MS = 2_000

export type MetricsListener = {
  /** The bound port. Resolved rather than echoed, so a `0` request is usable. */
  readonly port: number
  /**
   * The bound address, resolved the same way and printed in the boot log.
   *
   * `0.0.0.0` and `127.0.0.1` are the difference between a sibling container
   * being able to scrape this and not, and the failure is a permanently failed
   * scrape reading as a dead container. An operator staring at
   * `up{job="backup-drill"} == 0` needs to see which one it got.
   */
  readonly address: string
  /** Idempotent, bounded, and never rejects. */
  stop(): Promise<void>
}

type Log = (event: string, fields?: Record<string, unknown>) => void

export type MetricsServerOptions = {
  /** `METRICS_TOKEN`. Unset means the endpoint 404s, exactly as the API's does. */
  readonly token: string | undefined
  readonly collect: () => MetricSample[]
  readonly log: Log
}

/**
 * The request handler, separated from the socket so it can be tested without
 * one — and so the throw-swallowing below is provable rather than asserted.
 */
export function createMetricsServer(options: MetricsServerOptions): Server {
  const server = createServer((req, res) => {
    // The WHOLE handler is guarded, not just `collect()`: any throw here —
    // including from request parsing, ahead of the token check, so reachable
    // UNAUTHENTICATED — would be an uncaught exception in an entrypoint with
    // no `uncaughtException` handler, killing the container that makes the
    // backups.
    try {
      // No `URL` parse: `new URL('//', 'http://localhost')` throws (llhttp
      // delivers `//`, `/\` and `///` verbatim as `req.url`), and
      // `new URL('//evil', …).pathname` is `/` because `//host/path` is a
      // protocol-relative reference. A request target is a path plus an
      // optional query, and that is all this needs.
      const path = (req.url ?? '/').split('?', 1)[0]
      if (path !== '/metrics') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"not_found"}')
        return
      }
      // BEFORE the method check, so the "the endpoint does not exist without a
      // token" posture is actually true: a 405 ahead of it would disclose that
      // the path exists to a caller holding no credential.
      //
      // 404 rather than an open endpoint, matching `index.ts`. Note the
      // consequence, which `ApiDown` already documents for the API — an unset
      // token reads downstream as `up == 0`, indistinguishable from a dead
      // container, so the alert names both causes and
      // `maplespire-compose.test.mjs` asserts the deployment sets it.
      if (!options.token) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"not_found"}')
        return
      }
      if (!metricsTokenMatches(req.headers.authorization, options.token)) {
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer',
        })
        res.end('{"error":"unauthorized"}')
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, HEAD' })
        res.end('{"error":"method_not_allowed"}')
        return
      }
      const body = renderPrometheus(options.collect())
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch (error) {
      // LOAD-BEARING, not defensive. A scrape may fail; a drill may not.
      options.log('metrics_request_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      // `headersSent` because a throw from `collect()` happens before the 200
      // is written, but a throw from `res.end` would happen after — and
      // writing a second head on the same response throws again, from inside
      // the catch, which is the one place a throw is once more unguarded.
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":"collect_failed"}')
    }
  })

  // THIS is what makes the listener structurally unable to delay an exit, and
  // it is not the same guarantee as `stop()` below.
  //
  // `server.unref()` unrefs the LISTENING handle and does not reach an accepted
  // socket — so a pooled keep-alive connection, which is what Prometheus leaves
  // between two scrapes, keeps the process alive on its own. Unref'ing each
  // connection as it arrives closes that, and serving is unaffected (a second
  // scrape over the pooled socket still returns its complete body).
  //
  // A `try/finally` around the scheduler's whole body would only cover the
  // paths somebody enumerated. E.g. `mkdir` on the bundle root throws,
  // `main()` rejects, and the top-level catch sets `exitCode = 1` expecting
  // the loop to drain — which an open listener would turn into a container
  // that never exits and therefore never restarts. Unref'd, no exit path can
  // be held open at all.
  server.on('connection', (socket) => socket.unref())

  return server
}

/**
 * Bind, or log and return `null`. Never throws, never exits.
 *
 * `listenReady` is used for the bind because an EventEmitter that emits
 * 'error' with no listener throws, and here that throw would be fatal to the
 * drill for the sake of a scrape port. Its own docblock says a bind failure is
 * unrecoverable and expects the caller to die; that is right for the sync
 * server and exactly wrong for this caller, which is why the rejection is
 * caught rather than propagated.
 */
export async function startMetricsListener(options: MetricsServerOptions & {
  readonly port: number
  readonly host?: string
}): Promise<MetricsListener | null> {
  const server = createMetricsServer(options)
  try {
    // 0.0.0.0, and it is not a loosening. Prometheus is a SIBLING container, so
    // 127.0.0.1 would bind this container's own loopback and nothing outside
    // its network namespace could connect — the mistake compose.maplespire.yml
    // documents at length for prometheus's own listener, where it left every
    // Grafana panel without a data source. There is no `ports:` entry for this
    // service, so the port is reachable on the compose network and nowhere
    // else: the same posture as api:3001 and postgres:5432.
    server.listen(options.port, options.host ?? '0.0.0.0')
    await listenReady(server)
    server.unref()
  } catch (error) {
    options.log('metrics_listener_failed', {
      detail: 'the metrics port could not be bound; the process continues without this endpoint',
      port: options.port,
      error: error instanceof Error ? error.message : String(error),
    })
    // Release the handle rather than leaving a half-open server behind.
    server.close()
    return null
  }
  // Post-bind socket errors are not fatal either — a reset connection from a
  // scraper is not a reason to stop backing up.
  server.on('error', (error) => {
    options.log('metrics_listener_error', { error: error.message })
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  const host = typeof address === 'object' && address ? address.address : (options.host ?? '0.0.0.0')

  let stopped: Promise<void> | null = null
  return {
    port,
    address: host,
    stop() {
      if (stopped) return stopped
      // Distinct from the unref above, and both are kept because they buy
      // different things. The unref means the listener can never DELAY an exit;
      // this means the port stops answering when the scheduler is done with it,
      // which is what makes `up == 0` truthful during a teardown rather than
      // merely eventual.
      //
      // `close()` alone suffices for an IDLE socket since Node 19, which closes
      // idle keep-alive connections on close; `closeAllConnections()` covers a
      // scrape still in flight, whose loss is a failed scrape reporting
      // `up == 0` on a process that is indeed stopping.
      stopped = new Promise<void>((settle) => {
        const done = () => settle()
        server.close(done)
        server.closeAllConnections()
        // A ceiling, because a stop that hangs is the very thing this function
        // must avoid. Unref'd so the ceiling itself cannot be what keeps the
        // process alive.
        const timer = setTimeout(done, METRICS_STOP_CEILING_MS)
        timer.unref?.()
      })
      return stopped
    },
  }
}
