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

import { MAX_ROUTE_BURST_CACHE_TTL_MS } from './workspaceRoute.js'
import type { WorkspaceKey } from '../rbac/docScope.js'

/**
 * A REPOINT MOVES A POINTER SOCKETS ARE STILL FOLLOWING.
 *
 * `setDefaultVersion` moves `landscapes.default_version_id`; this module lets
 * the rest of the process learn it has. The client's sync socket
 * carries its workspace ref VERBATIM (`networkRoute.ts`'s
 * `workspaceWebSocketUrl`), and the app's default ref is
 * `{ landscapeId, versionId: 'current' }` (`workspace.ts`) — so most sockets
 * are following the alias, and the server re-resolves it on every upgrade.
 *
 * Two things happen here, in this order:
 *
 *  1. INVALIDATE the route resolver's memory of the alias, so the next upgrade
 *     reads the database rather than being told the old answer.
 *  2. DRAIN the sockets bound to the OLD default, so a tab whose socket never
 *     falls learns about the move instead of waiting for a blip.
 *
 * ## Why the invalidation has to survive a flight it did not start
 *
 * `createSingleFlightWorkspaceRouteResolver` keeps a resolved `current` for
 * 500 ms. Dropping the entry is not enough on its own: a resolution ISSUED
 * before the repoint is still at the database, and its `.then` writes the stale
 * answer into the cache afterwards. `invalidate` therefore also refuses the
 * answers of flights older than itself — see the generation counter there.
 *
 * ## Why the drain is safe: it depends on the CLIENT
 *
 * The condition this rests on is not visible from this file. A drained socket
 * reconnects to the SAME url — `versionId=current` — and the server
 * canonicalises it to the NEW version. A client that did not follow would
 * arrive on the new workspace still holding the OLD one's root, model shards
 * and diagrams, whose durable `automerge_document_workspace` rows name the old
 * version: every document earns a `workspace-mismatch` deny, and the work done
 * after the repoint is lost.
 *
 * What makes it safe: the server names the workspace it bound each socket to
 * (`workspaceBinding.ts`, sent at upgrade), and the browser compares that name
 * against the version its documents actually belong to. On a disagreement it
 * either FOLLOWS the move (nothing unsaved — which is what `'current'` means)
 * or HOLDS its transport on the version it was editing and says so in a banner
 * (something unsaved). Do not remove that client behaviour without removing
 * the drain.
 *
 * And the reason to drain at all: without it, a tab whose socket never drops keeps syncing the
 * old version indefinitely and the user learns of the move only by reloading.
 * The alias would then mean "the default as of whenever your network last
 * hiccuped", which is not a semantics anyone can reason about.
 *
 * ## Why the drain WAITS, and where the delay comes from
 *
 * `invalidate` is local to this process by construction, and
 * `syncCells/routerMain.ts` runs its own resolver in its own process — it
 * rewrites the upgrade url to the version IT resolved
 * (`canonicalizeWorkspaceUrl`). A socket drained at once comes back in 50-200 ms
 * (`reconnectDelayMs`, 1012), well inside that other process's burst window, and
 * would be canonicalised straight back onto the OLD default. The client would
 * then see a binding it AGREES with, do nothing, and the drain would have spent
 * the one reconnect it gets for nothing.
 *
 * `REPOINT_RESIDUAL_DRAIN_DELAY_MS` is therefore derived from the ceiling that
 * bounds every process's alias cache, not chosen, so the two cannot drift.
 *
 * The cost is that a follow takes a few seconds rather than a few hundred
 * milliseconds after an administrative action. The alternative — drain now AND
 * again after the window — buys that latency back in the deployment that runs no
 * router, and costs a second class of reconnect (every held and concrete-version
 * tab, twice) plus a second mechanism to reason about. If the latency is ever
 * worth that, it is one branch here, not a redesign.
 *
 * ## What the drain reaches that it does not strictly mean to
 *
 * The registry binds the CANONICAL workspace, so it cannot tell a socket that
 * asked for `'current'` from one that asked for the old version by name. The
 * drain therefore also reaches tabs deliberately pinned to that concrete
 * version. For them the reconnect is a no-op — same url, same binding, and the
 * client's own handler early-returns on a concrete ref — so what it costs is one
 * reconnect, to a population that is small precisely because that version has
 * just stopped being the default. Recording the requested alias per socket would
 * remove the waste at the price of a wiring line every construction site must
 * remember; that trade is not worth it for an administrative event.
 *
 * ## What neither half reaches, said plainly
 *
 * Both run in the process that HANDLED the repoint. The drain therefore reaches
 * only the sockets bound to this process: in a multi-cell deployment, a tab held
 * by another cell learns nothing until its own next reconnect. That gap closes
 * the same way the invalidation's would — `rbac/workspaceCacheInvalidation.ts`
 * is the pattern.
 *
 * And the router's own resolver, above. The bound is
 * `MAX_ROUTE_BURST_CACHE_TTL_MS` (5 s), applied where the TTL is read, so no
 * process can hold an alias longer than that whatever it configured.
 * `rbac/workspaceCacheInvalidation.ts` is the pattern for closing it properly,
 * at the cost of a channel, its DDL trigger and a listener in the router.
 * `compose.maplespire.yml` runs no router today; `infra/compose/sync-cell-failover.yml`
 * does.
 *
 * NOT COVERED: the production CALL SITE. Changing
 * `installDefaultVersionRepointHandler(...)` to `(null)` in
 * `automergeServer.ts` leaves the suite green, because `startAutomergeSync` is
 * booted by no test. Same exposure as `installDenyLedgerReleaseGuard` and
 * `installProvisionalPlacementSource`; a boot test for `startAutomergeSync`
 * would close it.
 */

/**
 * How long the drain waits out the alias caches this process cannot invalidate.
 *
 * DERIVED from the ceiling rather than restated: `MAX_ROUTE_BURST_CACHE_TTL_MS`
 * is the longest any process in the deployment may keep a `current` alias warm,
 * so an entry written at the instant of the repoint is gone by then. The extra
 * second is the margin for an entry written a moment AFTER the repoint by a
 * resolution that was already at the database — the same race the generation
 * counter closes locally and cannot close across a process boundary.
 */
export const REPOINT_RESIDUAL_DRAIN_DELAY_MS = MAX_ROUTE_BURST_CACHE_TTL_MS + 1_000

/** Sent to the browser as the 1012 close reason; `drainWorkspace` bounds it. */
const DRAIN_REASON = 'Default version repointed; reconnecting'

export interface DefaultVersionRepoint {
  landscapeId: string
  /** The default BEFORE the update. Null when the landscape had none. */
  previousVersionId: string | null
  versionId: string
}

export interface DefaultVersionRepointDeps {
  /** `InvalidatableWorkspaceRouteResolver.invalidate`. */
  invalidateRoutes: (landscapeId: string) => number
  /**
   * `ConnectionRegistry.drainWorkspace`, bound to this process's registry.
   * REQUIRED rather than optional: an absent drain would be a silent no-op that
   * still reports success.
   */
  drainSockets: (workspace: WorkspaceKey, reason: string) => number
  log?: (line: string) => void
  /**
   * Arm a one-shot timer; returns its canceller. Injected so a test can drive
   * the delay without a real clock, and so the production default can `unref`
   * the handle — a pending drain must never be the reason a process stays up.
   */
  schedule?: (run: () => void, delayMs: number) => () => void
}

export type DefaultVersionRepointHandler = (repoint: DefaultVersionRepoint) => void

/** The handler, plus the disposer for the drains it has armed but not yet run. */
export type DefaultVersionRepointService = DefaultVersionRepointHandler & {
  /** Cancel every drain still waiting out the residual delay. */
  stopPendingDrains(): void
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function createDefaultVersionRepointHandler(
  deps: DefaultVersionRepointDeps,
): DefaultVersionRepointService {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const schedule = deps.schedule ?? defaultSchedule
  // Keyed by the workspace being drained. Ids match `WORKSPACE_ID`
  // (`[A-Za-z0-9_-]`), so `/` cannot occur in either half and this join is
  // unambiguous without an escape.
  const pending = new Map<string, () => void>()

  const handler = ((repoint) => {
    // A PUT that names the version already in place is not a repoint, and the
    // admin console re-submitting its form is an ordinary thing.
    if (repoint.previousVersionId === repoint.versionId) return

    const invalidatedRoutes = deps.invalidateRoutes(repoint.landscapeId)

    const { landscapeId, previousVersionId, versionId } = repoint
    // No previous default means no socket can have resolved the alias to a
    // concrete version, so there is nothing bound to move. Invalidating was
    // still worth doing: a CONCRETE entry for this landscape can exist.
    const armed = previousVersionId !== null && !pending.has(`${landscapeId}/${previousVersionId}`)
    if (armed) {
      const key = `${landscapeId}/${previousVersionId as string}`
      const cancel = schedule(() => {
        pending.delete(key)
        let drainedSockets = 0
        let error: string | null = null
        try {
          drainedSockets = deps.drainSockets(
            { landscapeId, versionId: previousVersionId as string },
            DRAIN_REASON,
          )
        } catch (err) {
          // A throw here is on a TIMER, so it would take the process down
          // rather than the request that caused it — and the repoint itself
          // committed long ago.
          error = err instanceof Error ? err.message : String(err)
        }
        log(JSON.stringify({
          event: 'sync.cell.default_version_drained',
          landscapeId,
          previousVersionId,
          versionId,
          drainedSockets,
          error,
        }))
      }, REPOINT_RESIDUAL_DRAIN_DELAY_MS)
      pending.set(key, cancel)
    }

    log(JSON.stringify({
      event: 'sync.cell.default_version_repointed',
      landscapeId,
      previousVersionId,
      versionId,
      invalidatedRoutes,
      // The drain is DEFERRED, so this line cannot carry its count and must not
      // pretend to: it reports what was armed. The count arrives on
      // `sync.cell.default_version_drained`, and its absence is itself a fact —
      // a repoint with no matching drain line means the process went away first.
      drainArmed: armed,
      drainDelayMs: armed ? REPOINT_RESIDUAL_DRAIN_DELAY_MS : null,
    }))
  }) as DefaultVersionRepointService

  handler.stopPendingDrains = () => {
    for (const cancel of pending.values()) cancel()
    pending.clear()
  }

  return handler
}

let installed: DefaultVersionRepointHandler | null = null

/**
 * Point `announceDefaultVersionRepoint` at this process's sync server. Returns
 * the uninstaller.
 *
 * A module rather than an argument threaded through `setDefaultVersion`'s
 * callers (same reasoning as `rbac/provisionalPlacementSource.ts`): a
 * per-call-site wiring line is easy for tests to inject around, and
 * `setDefaultVersion` has TWO callers (`index.ts`'s PUT and
 * `ai/core/tools/workflowTools.ts`). A line each of them must remember is a
 * line one of them will forget.
 */
export function installDefaultVersionRepointHandler(
  handler: DefaultVersionRepointHandler | null,
): () => void {
  installed = handler
  return () => { installed = null }
}

/**
 * Tell whatever sync server lives in this process that a landscape's default
 * version moved. Returns whether anything was listening — false is the ordinary
 * answer in a process that runs no sync server (fsck, the gc worker, a script),
 * not a fault.
 *
 * Never throws and never awaits: a repoint is a durable database write that has
 * already succeeded by the time this runs, and turning a cache-invalidation
 * failure into a 500 would tell the admin the repoint did not happen when it
 * did. A throwing handler is logged rather than silently swallowed.
 */
export function announceDefaultVersionRepoint(repoint: DefaultVersionRepoint): boolean {
  const handler = installed
  if (!handler) return false
  try {
    handler(repoint)
  } catch (err) {
    console.warn(JSON.stringify({
      event: 'sync.cell.default_version_repoint_failed',
      landscapeId: repoint.landscapeId,
      versionId: repoint.versionId,
      error: err instanceof Error ? err.message : String(err),
    }))
  }
  return true
}
