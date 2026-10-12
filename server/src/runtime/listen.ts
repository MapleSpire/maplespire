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

import type { Server } from 'node:http'

/**
 * Wait for an HTTP server to finish binding, turning a failed bind into a
 * rejection instead of an unhandled 'error' event.
 *
 * This exists because the sync server installs a deliberate
 * `process.on('uncaughtException')` handler that keeps the process alive — a
 * single document's sync failure must not take down every other client. That
 * handler also swallows the throw that Node performs when an EventEmitter emits
 * 'error' with no listener. Without this helper, a replica that loses the race
 * for its port (EADDRINUSE) or lacks permission to bind it (EACCES) logs the
 * error and then KEEPS RUNNING: healthy to the orchestrator, joined to the
 * sync-cell ownership ring and renewing partition leases, while serving no
 * traffic at all. Every workspace hashed to its partitions stalls, and no
 * other replica can take them over.
 *
 * A bind failure is not recoverable, so the caller is expected to let the
 * rejection terminate the process.
 *
 * After a successful bind the listeners are removed: post-boot socket errors
 * are a separate, non-fatal concern and the caller installs its own handler.
 */
export function listenReady(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    // The bind may already have completed before this was called; the
    // 'listening' event would then never fire again.
    if (server.listening) {
      resolve()
      return
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    server.once('listening', onListening)
    server.once('error', onError)
  })
}
