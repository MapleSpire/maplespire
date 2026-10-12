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

import { WebSocket, type WebSocketServer } from 'ws'

export interface ShutdownStep {
  name: string
  run: () => void | Promise<void>
}

/** Preserve ordering and join each operation even after an earlier failure.
 * A rejected drain is not proof that applied writes were persisted. */
export async function runShutdownSteps(label: string, steps: readonly ShutdownStep[]): Promise<void> {
  const failures: Error[] = []
  for (const step of steps) {
    try { await step.run() } catch (cause) {
      failures.push(new Error(`${label}: ${step.name} failed`, { cause }))
    }
  }
  if (failures.length) throw new AggregateError(failures, `${label} incomplete`)
}

/** Stop upgrades, request a graceful close, then terminate remaining sockets
 * after five seconds. The deadline initiates termination; only the real WSS
 * callback and the admitted sockets' close events join closure. In ws's
 * internal-HTTP-server mode the server callback can precede socket closure;
 * the delivered noServer mode also gets the explicit socket proof. */
export async function closeAutomergeSockets(wss: Pick<WebSocketServer, 'clients' | 'close'>): Promise<void> {
  const failures: unknown[] = []
  const clients = [...wss.clients]
  const closedClients = clients.map(client => new Promise<void>((resolve) => {
    const onClose = () => { client.off('close', onClose); resolve() }
    client.once('close', onClose)
    // A stale tracked CLOSED socket cannot emit a second close event. Register
    // first, then check, so the event and this observation cover the same join.
    if (client.readyState === WebSocket.CLOSED) onClose()
  }))
  const timer = setTimeout(() => {
    for (const client of clients) {
      try { client.terminate() } catch (error) { failures.push(error) }
    }
  }, 5_000)
  try {
    const closedServer = new Promise<void>((resolve) => {
      try {
        wss.close((error) => {
          if (error) failures.push(error)
          resolve()
        })
      } catch (error) { failures.push(error); resolve() }
    })
    for (const client of clients) {
      try { client.close(1012, 'Server restarting') } catch (error) { failures.push(error) }
    }
    await Promise.all([closedServer, ...closedClients])
  } finally { clearTimeout(timer) }
  if (failures.length) throw new AggregateError(failures, 'Automerge WebSocket closure failed')
}

export interface AutomergeDrainResources {
  stopEpochRevocation: () => void | Promise<void>
  stopWorkspaceCacheInvalidation: () => void | Promise<void>
  wss: Pick<WebSocketServer, 'clients' | 'close'>
  drainResidency: () => void | Promise<void>
  restoreInboundQueue: () => void
  flush: () => Promise<void>
}

export function drainAutomergeResources(resources: AutomergeDrainResources): Promise<void> {
  return runShutdownSteps('Automerge resource drain', [
    { name: 'epoch revocation', run: resources.stopEpochRevocation },
    { name: 'workspace cache invalidation', run: resources.stopWorkspaceCacheInvalidation },
    { name: 'WebSocket closure', run: () => closeAutomergeSockets(resources.wss) },
    { name: 'residency', run: resources.drainResidency },
    { name: 'inbound queue', run: resources.restoreInboundQueue },
    { name: 'final flush', run: resources.flush },
  ])
}
