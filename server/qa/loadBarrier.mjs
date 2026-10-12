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

/** A cohort holds its real sockets while the parent admits the complete fleet.
 * The episode UUID is known before admission; the separate release nonce is
 * minted only afterwards and reaches the child in the release message. The
 * receipt proves that causal hand-off without ordering clocks from different
 * processes. IPC is closed at settlement so it cannot keep a child alive. */
export function waitForLoadBarrier({ barrierId, users, userOffset, totalUsers, timeoutMs = 60_000, signal }, proc = process) {
  if (!barrierId || typeof proc.send !== 'function' || !proc.connected) {
    return Promise.reject(new Error('load baseline barrier requires a connected parent IPC channel'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      proc.removeListener('message', onMessage)
      proc.removeListener('disconnect', onDisconnect)
      proc.removeListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
      if (proc.connected) proc.disconnect()
    }
    const finish = (error, releaseNonce) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve({ barrierId, releaseNonce, releasedAt: Date.now() })
    }
    const onMessage = (message) => {
      if (message?.type !== 'load-baseline-release' || message.barrierId !== barrierId) return
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(message.releaseNonce)
        || message.releaseNonce === barrierId) {
        finish(new Error('load baseline release requires a separate UUID nonce'))
        return
      }
      finish(null, message.releaseNonce)
    }
    const onDisconnect = () => finish(new Error('load baseline parent disconnected before release'))
    const onError = (error) => finish(error)
    const onAbort = () => finish(signal.reason ?? new Error('load cohort aborted before baseline release'))
    proc.on('message', onMessage)
    proc.once('disconnect', onDisconnect)
    proc.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    timer = setTimeout(() => finish(new Error(`load baseline release exceeded ${timeoutMs} ms`)), timeoutMs)
    try {
      proc.send({ type: 'load-baseline-ready', barrierId, users, userOffset, totalUsers }, (error) => {
        if (error) finish(error)
      })
    } catch (error) { finish(error) }
  })
}
