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
 * A same-origin "front door" for the N-1 <-> N compatibility harness — what
 * nginx is in production, in about a hundred lines, run inside the Playwright
 * process so a test can flip it.
 *
 * One origin serves one client build at a time:
 *  - `{ kind: 'static', dir }` — a `vite build` output (the N-1 bundle), with
 *    the SPA fallback to `index.html`;
 *  - `{ kind: 'proxy', origin }` — everything forwarded to a Vite DEV server
 *    (the N client), including Vite's HMR WebSocket.
 * `/api`, `/automerge` and `/assets/technologies` always go to the sync
 * server, so both builds are SAME-ORIGIN builds (the N-1 bundle is built with
 * `VITE_SYNC_API_URL`/`VITE_AUTOMERGE_URL` empty, exactly like the image).
 *
 * Why not two plain servers: the IndexedDB of a browser profile is keyed by
 * ORIGIN, so "N opens the databases N-1 wrote" is only testable when the same
 * origin serves N-1 first and N afterwards. `setTarget` is that upgrade.
 *
 * `setOffline(true)` is a network outage for the backend routes only: every
 * open backend socket (the sync WebSocket included) is destroyed and new
 * requests are refused at the socket. It works against a production bundle,
 * which has none of the DEV `__dropSyncSocketsForTest` hooks — and a
 * Playwright `context.setOffline` does not end an open localhost WebSocket
 * (measured 2026-10-15, `adaptiveWebSocketClientAdapter.ts`).
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import type { Duplex } from 'node:stream'

export type DoorTarget = { kind: 'static'; dir: string } | { kind: 'proxy'; origin: string }

const BACKEND_PREFIXES = ['/api', '/automerge', '/assets/technologies']

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function isBackendPath(url: string): boolean {
  const pathname = url.split('?')[0]
  return BACKEND_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

export class CompatDoor {
  readonly port: number
  private readonly backend: URL
  private target: DoorTarget
  private offline = false
  private readonly server: http.Server
  /** Every client socket, so a target switch can drop keep-alive connections. */
  private readonly clientSockets = new Set<net.Socket>()
  /** Upgraded and HTTP sockets currently talking to the BACKEND. */
  private readonly backendSockets = new Set<Duplex>()

  constructor(options: { port: number; backend: string; target: DoorTarget }) {
    this.port = options.port
    this.backend = new URL(options.backend)
    this.target = options.target
    this.server = http.createServer((req, res) => this.onRequest(req, res))
    this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head))
    this.server.on('connection', (socket) => {
      this.clientSockets.add(socket)
      socket.on('close', () => this.clientSockets.delete(socket))
    })
  }

  get origin(): string {
    return `http://localhost:${this.port}`
  }

  get currentTarget(): DoorTarget {
    return this.target
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      // No host: dual-stack, so `localhost` resolving to ::1 or 127.0.0.1
      // reaches it either way.
      this.server.listen(this.port, () => resolve())
    })
  }

  /** Serve another build on this origin. Open connections are dropped, as a
   *  redeploy behind a load balancer would, so nothing keeps talking to the
   *  previous build over a kept-alive socket. */
  setTarget(target: DoorTarget): void {
    this.target = target
    for (const socket of this.clientSockets) socket.destroy()
  }

  setOffline(offline: boolean): void {
    this.offline = offline
    if (offline) for (const socket of this.backendSockets) socket.destroy()
  }

  async close(): Promise<void> {
    for (const socket of this.clientSockets) socket.destroy()
    for (const socket of this.backendSockets) socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private upstreamFor(url: string): URL | null {
    if (isBackendPath(url)) return this.backend
    return this.target.kind === 'proxy' ? new URL(this.target.origin) : null
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/'
    const backend = isBackendPath(url)
    if (backend && this.offline) {
      req.socket.destroy()
      return
    }
    const upstream = this.upstreamFor(url)
    if (!upstream) {
      this.serveStatic(url, res)
      return
    }
    const proxied = http.request({
      host: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: url,
      headers: { ...req.headers, host: upstream.host },
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    // Once per socket: a kept-alive socket carries many requests.
    if (backend && !this.backendSockets.has(req.socket)) {
      const socket = req.socket
      this.backendSockets.add(socket)
      socket.once('close', () => this.backendSockets.delete(socket))
    }
    proxied.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(proxied)
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = req.url ?? '/'
    const backend = isBackendPath(url)
    const upstream = this.upstreamFor(url)
    if (!upstream || (backend && this.offline)) {
      socket.destroy()
      return
    }
    const upstreamSocket = net.connect(Number(upstream.port), upstream.hostname, () => {
      // Replay the request head verbatim (rawHeaders keeps order and case),
      // with the Host rewritten for the upstream.
      const lines = [`${req.method} ${url} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]
        lines.push(`${name}: ${name.toLowerCase() === 'host' ? upstream.host : req.rawHeaders[i + 1]}`)
      }
      upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstreamSocket.write(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })
    const drop = () => {
      socket.destroy()
      upstreamSocket.destroy()
    }
    upstreamSocket.on('error', drop)
    socket.on('error', drop)
    upstreamSocket.on('close', drop)
    socket.on('close', drop)
    if (backend) {
      this.backendSockets.add(socket)
      socket.once('close', () => this.backendSockets.delete(socket))
    }
  }

  private serveStatic(url: string, res: http.ServerResponse): void {
    if (this.target.kind !== 'static') return
    const root = path.resolve(this.target.dir)
    const pathname = decodeURIComponent(url.split('?')[0])
    let file = path.normalize(path.join(root, pathname))
    if (!file.startsWith(root)) {
      res.writeHead(403)
      res.end()
      return
    }
    const isFile = existsSync(file) && statSync(file).isFile()
    if (!isFile) {
      // A missing ASSET is a 404, not the app shell: answering it with
      // index.html would turn a broken bundle into a "successful" HTML load.
      if (path.extname(pathname) && !pathname.endsWith('.html')) {
        res.writeHead(404)
        res.end(`No such file in the build: ${pathname}`)
        return
      }
      file = path.join(root, 'index.html')
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      // index.html must never be cached across a build switch; hashed assets
      // are distinct names per build anyway.
      'Cache-Control': 'no-store',
    })
    createReadStream(file).pipe(res)
  }
}
