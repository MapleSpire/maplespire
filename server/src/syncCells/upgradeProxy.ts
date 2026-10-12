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

import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import type { Duplex } from 'node:stream'
import { rejectUpgrade } from '../auth/wsAuth.js'

export const SYNC_ROUTED_HEADER = 'x-maplespire-sync-routed'

export interface UpgradeSocket extends Duplex {
  destroy(error?: Error): this
}

export interface ProxiedWorkspaceTunnel {
  close(code?: number, reason?: string): void
}

function responseHead(response: IncomingMessage): string {
  const headers: string[] = []
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    headers.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`)
  }
  return `HTTP/${response.httpVersion} ${response.statusCode ?? 101} ${response.statusMessage ?? 'Switching Protocols'}\r\n${headers.join('\r\n')}\r\n\r\n`
}

function safeFailureStatus(status: number | undefined): number {
  return status && [400, 401, 403, 404, 409, 503].includes(status) ? status : 503
}

/**
 * Tunnel one already-authorized WebSocket upgrade to the partition owner.
 * The owner repeats authentication and workspace authorization before its Repo
 * sees the socket. Node streams provide bounded backpressure in both directions.
 */
export function proxyWorkspaceUpgrade(options: {
  request: IncomingMessage
  socket: UpgradeSocket
  head: Buffer
  advertiseUrl: string
  sourceCellId: string
  timeoutMs?: number
  signal?: AbortSignal
  onConnected?: (tunnel: ProxiedWorkspaceTunnel) => void
  onClosed?: () => void
}): Promise<boolean> {
  const { request, socket, head, advertiseUrl, sourceCellId } = options
  const timeoutMs = options.timeoutMs ?? 5_000
  return new Promise((resolve) => {
    let target: URL
    try {
      const base = new URL(advertiseUrl)
      if (
        !['http:', 'https:'].includes(base.protocol)
        || base.username
        || base.password
        || base.pathname !== '/'
        || base.search
        || base.hash
      ) {
        rejectUpgrade(socket, 503)
        resolve(false)
        return
      }
      target = new URL(request.url ?? '/automerge', base)
      if (target.pathname !== '/automerge' || target.origin !== base.origin) {
        rejectUpgrade(socket, 503)
        resolve(false)
        return
      }
    } catch {
      rejectUpgrade(socket, 503)
      resolve(false)
      return
    }

    const headers = { ...request.headers }
    delete headers[SYNC_ROUTED_HEADER]
    headers.host = target.host
    headers[SYNC_ROUTED_HEADER] = sourceCellId
    const transport = target.protocol === 'https:' ? https : http
    const upstream = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: 'GET',
      path: `${target.pathname}${target.search}`,
      headers,
      agent: false,
    })

    let finished = false
    const pending = { timer: undefined as ReturnType<typeof setTimeout> | undefined }
    const cleanupPending = () => {
      if (pending.timer) clearTimeout(pending.timer)
      options.signal?.removeEventListener('abort', abortPending)
    }
    const finishFailure = (status = 503) => {
      if (finished) return
      finished = true
      cleanupPending()
      upstream.destroy()
      rejectUpgrade(socket, status)
      resolve(false)
    }
    const abortPending = () => finishFailure(503)
    upstream.once('upgrade', (response, upstreamSocket, upstreamHead) => {
      if (finished) {
        upstreamSocket.destroy()
        return
      }
      finished = true
      cleanupPending()
      try {
        let tunnelClosing = false
        let closedNotified = false
        const notifyClosed = () => {
          if (closedNotified) return
          closedNotified = true
          options.onClosed?.()
        }
        const close = (code = 1012, reason = 'Workspace owner changed') => {
          if (tunnelClosing) return
          tunnelClosing = true
          const reasonBytes = Buffer.from(reason).subarray(0, 123)
          const payload = Buffer.allocUnsafe(2 + reasonBytes.length)
          payload.writeUInt16BE(code, 0)
          reasonBytes.copy(payload, 2)
          const frame = Buffer.concat([Buffer.from([0x88, payload.length]), payload])
          socket.unpipe(upstreamSocket)
          upstreamSocket.unpipe(socket)
          socket.end(frame)
          upstreamSocket.destroy()
          const forceClose = setTimeout(() => socket.destroy(), 250)
          forceClose.unref?.()
        }
        socket.write(responseHead(response))
        if (upstreamHead.length > 0) socket.write(upstreamHead)
        if (head.length > 0) upstreamSocket.write(head)
        upstreamSocket.on('error', () => socket.destroy())
        socket.on('error', () => upstreamSocket.destroy())
        upstreamSocket.once('close', notifyClosed)
        socket.once('close', notifyClosed)
        upstreamSocket.pipe(socket).pipe(upstreamSocket)
        options.onConnected?.({ close })
        resolve(true)
      } catch {
        upstreamSocket.destroy()
        socket.destroy()
        resolve(false)
      }
    })
    upstream.once('response', (response) => {
      response.resume()
      finishFailure(safeFailureStatus(response.statusCode))
    })
    upstream.once('error', () => finishFailure(503))
    // Attach every upstream terminal handler before exposing the request to
    // either a timeout or an AbortSignal. An already-aborted signal may destroy
    // the ClientRequest synchronously and emit ECONNRESET on the next tick.
    pending.timer = setTimeout(() => finishFailure(503), timeoutMs)
    pending.timer.unref?.()
    if (options.signal?.aborted) {
      finishFailure(503)
      return
    }
    options.signal?.addEventListener('abort', abortPending, { once: true })
    upstream.end()
  })
}
