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

import type { AuthStage, MeOutcome, SessionEndReason } from './api'
import type { TransportClose } from '../automerge/adaptiveWebSocketClientAdapter'

/**
 * Notice, on a LIVE page, that the session behind the sync socket is over.
 *
 * Regression (2026-10-16): when the org's auth epoch moved, the server closed
 * the socket with 4001 and refused every reconnect at the upgrade. The browser
 * sees a refused upgrade as a bare 1006 on a socket that never opened, and the
 * transport kept retrying for ever: edits stopped syncing and nothing on the
 * page said so.
 *
 * The transport cannot tell "revoked" from "server down" — and must not try:
 * an outage is the offline-first case, where the page keeps working. So a
 * suspicious close only triggers a question to the server, `GET /api/auth/me`,
 * and only its explicit 401 ends the session. An unreachable server (the probe
 * throws) ends nothing.
 *
 * Suspicious: a 4001 (the server's own "Session revoked" close), or a socket
 * that never opened. The second also fires through a whole outage, so probes
 * not caused by a 4001 are spaced by `minIntervalMs`; at most one is in flight.
 */
export interface SessionWatchDeps {
  /** Ask the server about the session. Must THROW when it cannot answer. */
  probe: () => Promise<MeOutcome>
  /** Watch at all? Stage 'on' (the only stage that refuses stale sessions),
   * signed in, not already ended. Re-read on every close and after the probe. */
  shouldWatch: () => boolean
  onEnded: (reason: SessionEndReason) => void
  now?: () => number
  minIntervalMs?: number
}

export const SESSION_PROBE_MIN_INTERVAL_MS = 10_000

/** The `shouldWatch` the app uses. Only stage 'on' refuses a stale session
 * (dual and off admit it), so only there can a close mean "revoked"; a page
 * with no user has no session to lose; an ended session is not ended twice. */
export function sessionWatchApplies(auth: {
  config: { stage: AuthStage } | null
  user: unknown
  sessionEnded: SessionEndReason | null
}): boolean {
  return auth.config?.stage === 'on' && !!auth.user && auth.sessionEnded === null
}

export function createSessionWatch(deps: SessionWatchDeps): (close: TransportClose) => void {
  const now = deps.now ?? Date.now
  const minIntervalMs = deps.minIntervalMs ?? SESSION_PROBE_MIN_INTERVAL_MS
  let inFlight = false
  let lastProbeAt = Number.NEGATIVE_INFINITY

  return (close) => {
    if (!deps.shouldWatch()) return
    const revoked = close.code === 4001
    if (!revoked && close.opened) return
    if (inFlight) return
    if (!revoked && now() - lastProbeAt < minIntervalMs) return
    lastProbeAt = now()
    inFlight = true
    deps
      .probe()
      .then((outcome) => {
        if (outcome.kind === 'signed-out' && deps.shouldWatch()) deps.onEnded(outcome.reason)
      })
      .catch(() => {
        // The server could not answer: an outage, not a verdict on the session.
      })
      .finally(() => {
        inFlight = false
      })
  }
}
