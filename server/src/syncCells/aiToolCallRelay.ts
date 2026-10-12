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

import type { Pool } from 'pg'
import type { WorkspaceKey } from '../rbac/docScope.js'
import type { MetricSample } from '../runtime/metrics.js'
import type { SyncCellOwnership } from './ownership.js'
import { requestWorkspaceOwnerJson, ROUTED_WRITE_HEADER_DEADLINE_MS } from './httpProxy.js'
import { decideWorkspaceRoute, parseWorkspaceHttpRoute } from './workspaceHttpRoute.js'
import type { WorkspaceRouteDecision } from './workspaceHttpRoute.js'
import {
  resolveLandscapeDefaultWorkspace,
  resolveMergeParentWorkspace,
  getSharedWorkspaceRouteResolver,
} from './workspaceRoute.js'
import type { LandscapeDefaultResolver, MergeParentResolver, WorkspaceRouteResolver } from './workspaceRoute.js'

/**
 * THE TOOL-CALL RELAY: a bootstrap tool decided INSIDE the agent loop reaches
 * the owner of its key, and the conversation does not move.
 *
 * ## Why
 *
 * The router sends `POST /api/ai/tools/create_draft|create_version|merge_draft`
 * — the DIRECT door — to the owner, keyed the way the bootstrap fence keys
 * them. `/api/ai/chat` and `/api/ai/run` cannot be routed that way: the tool
 * is chosen DURING the loop, on whichever cell the conversation landed, and
 * one request may call tools on several workspaces. Without the relay, a chat
 * that landed on the wrong cell would get 503 `sync-cell-not-owner` as a tool
 * error, and since placement is deterministic, every retry on the same cell
 * would get it again.
 *
 * ## What hops, and what does not
 *
 * ONE tool call. The loop, its messages, its stream and its history stay on
 * the landing cell; `executeAiTool` asks this module before running a placed
 * tool, and when the key belongs to a neighbour the CALL is re-issued to that
 * neighbour's direct door — `POST /api/ai/tools/:name`, the same door the
 * router places — with the caller's own credentials, and the door's `{ result }` (or
 * its error, status and text) comes back as the tool's answer. The owner
 * authenticates the same user again, re-checks `canWrite` again, re-validates
 * the input again and opens the bootstrap scope as the holder of the lease;
 * the relaying cell opens nothing, so `bootstrapScope.refusedAtOpen` does not
 * move there — which is the reason this asks BEFORE executing rather than
 * executing and relaying on refusal.
 *
 * ## One placement, not two
 *
 * The key is derived by the ROUTER'S OWN EXTRACTOR: the call is presented to
 * `parseWorkspaceHttpRoute` as the door request it will become (`POST
 * /api/ai/tools/<name>` with `{ landscapeId, versionId, input }`), and the
 * decision — lookups, canonicalisation, authorisation, `owns`, `resolveOwner`,
 * the loop check — is `decideWorkspaceRoute`, the function the middleware
 * itself acts on. Nothing here re-derives the landscape or the draft parent;
 * if the extractor changes, the loop follows. A derivation spelled twice
 * would drift; sharing the chain is what carries the parity.
 *
 * ## What the caller sees, and why it is the direct door's answer
 *
 * A 2xx from the owner is its `result`. Anything else is the door's own
 * `{ error }` at the door's own status — a View user refused 403 by the owner
 * reads the exact text the local gate would have produced, a merge of a
 * merged draft reads the owner's 404, an owner that lost its lease between
 * the decision and the hop reads the route-loop 503 the middleware answers.
 * An owner that cannot be reached reads `workspace owner unavailable`, the
 * text the proxy's `fail` writes; a placement chain that THROWS (a database
 * or Redis failure while deciding) reads `workspace routing unavailable`, the
 * text the middleware's own catch writes. The relaying cell never invents a
 * wording.
 *
 * ## What it does NOT relay
 *
 * Whatever the extractor does not place. The bootstrap tools (`AI_TOOL_DOORS`)
 * are keyed by a lookup; the generic entry places every other name the door
 * serves on its body's workspace. Because this module asks the extractor
 * rather than a list of names, it follows the extractor without a change here.
 * Which calls are worth a hop at all is `executeAiTool`'s decision. `/mcp`
 * installs no relay capability (one workspace per tool call,
 * `splitMcpArgs`) and the direct door installs none either — on the
 * owner it executes, and on a non-owner the middleware has already proxied
 * the request before the handler runs.
 */

export interface AiToolRelayCapability {
  ownership: () => SyncCellOwnership | null
  ownershipRequired: () => boolean
  /** Read access on the PLACED workspace, as the router checks it — for a
   *  merge that is the parent the caller never named. */
  authorize: (workspace: WorkspaceKey) => Promise<boolean>
  /** The caller's credential headers (`cookie`, `authorization`), forwarded so
   *  the owner authenticates the same user. Never logged. */
  credentials: Readonly<Record<string, string>>
  /** Did the request the loop is answering arrive routed itself? A relayed
   *  hop from a routed request would be a second hop; the decision refuses
   *  it the way the middleware refuses a route loop. */
  alreadyRouted: boolean
  /** Overridable ONLY so a unit arm can drive the decision without a
   *  database — the same seams `createWorkspaceHttpRouting` exposes, for the
   *  same reason. The statements are covered by the DB-gated suites. */
  resolvers?: {
    resolveWorkspace?: WorkspaceRouteResolver
    resolveMergeParent?: MergeParentResolver
    resolveLandscapeDefault?: LandscapeDefaultResolver
  }
  /** Whole-answer deadline for the hop. Defaults to the write families'. */
  timeoutMs?: number
  connectTimeoutMs?: number
}

export type AiToolRelayOutcome =
  /** Not placed, or placed here: execute where it landed. */
  | { kind: 'local'; reason: 'not-placed' | Extract<WorkspaceRouteDecision, { kind: 'pass-through' }>['reason'] | 'owner' }
  /** The router's own refusal — what the direct door would have answered. */
  | { kind: 'refused'; status: number; error: string }
  /** The owner answered; `body` is the door's JSON at `status`. */
  | { kind: 'relayed'; status: number; route: string | null; body: unknown }
  | { kind: 'owner-unavailable'; reason: string }
  | { kind: 'malformed'; reason: string }

export const AI_TOOL_RELAY_EVENT = 'sync.cell.ai_tool_relay'

let relayed = 0
const relayedByTool = new Map<string, number>()
let refusedByRouter = 0
let routingUnavailable = 0
let ownerUnavailable = 0
let malformed = 0
let aborted = 0

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

export interface AiToolRelaySnapshot {
  /** Hops that reached the owner and got an answer — at ANY status. A 403 or
   *  a 404 from the owner is a relayed call; success is the door's business. */
  relayed: number
  relayedByTool: Record<string, number>
  refusedByRouter: number
  /** The placement chain THREW (a database or Redis failure while deciding) —
   *  answered as the middleware answers it, 503 `workspace routing unavailable`. */
  routingUnavailable: number
  ownerUnavailable: number
  malformed: number
  /** Hops destroyed by the loop's own signal (round watchdog, client gone):
   *  the outcome at the owner is unknown, which is why they are counted. */
  aborted: number
}

/** Process-wide counters, exposed on `/api/platform/sync-cell` beside the
 *  bootstrap scope's, so a tool call that hopped is attributable. Read as
 *  DELTAS — nothing resets them in production. */
export function aiToolRelaySnapshot(): AiToolRelaySnapshot {
  return {
    relayed,
    relayedByTool: Object.fromEntries(relayedByTool),
    refusedByRouter,
    routingUnavailable,
    ownerUnavailable,
    malformed,
    aborted,
  }
}

/** TEST SEAM. */
export function resetAiToolRelayCountersForTest(): void {
  relayed = 0
  relayedByTool.clear()
  refusedByRouter = 0
  routingUnavailable = 0
  ownerUnavailable = 0
  malformed = 0
  aborted = 0
}

export function aiToolRelayMetricSamples(): MetricSample[] {
  return [
    {
      name: 'maplespire_ai_tool_relays_total',
      help: 'AI tool calls decided inside the /api/ai/chat or /api/ai/run agent loop that were RELAYED to the owning cell and answered by it, at any status (task B2-10b), by tool — bounded by the registry, since only a name the registry resolved reaches the relay. Non-zero is normal on a multi-partition fleet; on a single-cell deployment it means the loop believes another cell owns a workspace.',
      type: 'counter',
      values: [...relayedByTool.entries()].map(([tool, value]) => ({ value, labels: { tool } })),
    },
    {
      name: 'maplespire_ai_tool_relay_failures_total',
      help: 'AI tool calls the relay could not complete, by outcome: refused-by-router (the placement chain answered a refusal the direct door would have answered too), routing-unavailable (the placement chain threw — a database or Redis failure — answered 503 as the middleware answers it), owner-unavailable (no route, the owner unreachable, or its answer not complete within the deadline), malformed (the owner answered something the door never answers), aborted (the loop’s own signal destroyed the hop; the outcome at the owner is unknown).',
      type: 'counter',
      values: [
        { value: refusedByRouter, labels: { outcome: 'refused-by-router' } },
        { value: routingUnavailable, labels: { outcome: 'routing-unavailable' } },
        { value: ownerUnavailable, labels: { outcome: 'owner-unavailable' } },
        { value: malformed, labels: { outcome: 'malformed' } },
        { value: aborted, labels: { outcome: 'aborted' } },
      ],
    },
  ]
}

function doorPath(tool: string): string {
  return `/api/ai/tools/${encodeURIComponent(tool)}`
}

/**
 * Ask where this tool call is placed and, when it is placed on a neighbour,
 * carry it there. Throws only on abort (the caller's signal), with the
 * signal's reason, so the SDK sees the same abort it would see from any tool.
 */
export async function relayPlacedAiToolCall(call: {
  db: Pool
  relay: AiToolRelayCapability
  tool: string
  workspace: WorkspaceKey
  rawInput: unknown
  signal?: AbortSignal
}): Promise<AiToolRelayOutcome> {
  const { relay, tool, workspace } = call
  const path = doorPath(tool)
  // THE DOOR REQUEST THIS CALL WOULD BE, presented to the router's own parser.
  // `workspace` is the ctx's CANONICAL key (a real version id, never
  // `current`), which the owner's `resolveAiToolCtx` canonicalises again to
  // the same thing.
  const body = { landscapeId: workspace.landscapeId, versionId: workspace.versionId, input: call.rawInput }
  const parsed = parseWorkspaceHttpRoute(path, 'POST', body)
  if (parsed.kind === 'not-workspace' || parsed.kind === 'invalid') return { kind: 'local', reason: 'not-placed' }

  let decision: WorkspaceRouteDecision
  try {
    decision = await decideWorkspaceRoute(parsed, {
      db: call.db,
      ownership: relay.ownership,
      ownershipRequired: relay.ownershipRequired,
      resolveWorkspace: relay.resolvers?.resolveWorkspace
        ?? ((db, requested) => getSharedWorkspaceRouteResolver(db)(db, requested)),
      authorize: relay.authorize,
      resolveMergeParent: relay.resolvers?.resolveMergeParent ?? resolveMergeParentWorkspace,
      resolveLandscapeDefault: relay.resolvers?.resolveLandscapeDefault ?? resolveLandscapeDefaultWorkspace,
      alreadyRouted: relay.alreadyRouted,
    })
  } catch (error) {
    // THE MIDDLEWARE'S CATCH, HERE TOO. Every lookup in the chain THROWS on a
    // database failure rather than answering null (`workspaceRoute.ts` says so
    // for both resolvers), and `resolveOwner` can reject on a Redis command.
    // The middleware answers that throw 503 `workspace routing unavailable`,
    // retryable, having written nothing. Letting it escape would reach the
    // loop's generic catch as a 500 "AI request failed" with no line and no
    // counter — and break this function's "throws only on abort" contract.
    routingUnavailable += 1
    console.error('[sync-cell] AI tool relay: route resolution failed:', error)
    console.warn(JSON.stringify({ event: AI_TOOL_RELAY_EVENT, tool, route: 'routing-unavailable', status: 503 }))
    return { kind: 'refused', status: 503, error: 'workspace routing unavailable' }
  }
  if (decision.kind === 'pass-through') return { kind: 'local', reason: decision.reason }
  if (decision.kind === 'owner') return { kind: 'local', reason: 'owner' }
  if (decision.kind === 'refuse') {
    refusedByRouter += 1
    console.warn(JSON.stringify({
      event: AI_TOOL_RELAY_EVENT,
      tool,
      route: 'refused',
      reason: decision.reason,
      status: decision.status,
      ...(decision.placement
        ? { assignedPartition: decision.placement.assignedPartition, localPartition: decision.placement.localPartition }
        : {}),
    }))
    return { kind: 'refused', status: decision.status, error: String(decision.body.error ?? 'workspace routing refused') }
  }

  const answer = await requestWorkspaceOwnerJson({
    advertiseUrl: decision.owner.advertiseUrl,
    path,
    body,
    headers: relay.credentials,
    sourceCellId: decision.placement.localCellId,
    signal: call.signal,
    timeoutMs: relay.timeoutMs ?? ROUTED_WRITE_HEADER_DEADLINE_MS,
    ...(relay.connectTimeoutMs !== undefined ? { connectTimeoutMs: relay.connectTimeoutMs } : {}),
  })
  const placement = {
    assignedPartition: decision.placement.assignedPartition,
    localPartition: decision.placement.localPartition,
  }
  if (answer.kind === 'aborted') {
    // Counted and journaled BEFORE the throw: the loop's catch turns the
    // abort into a tool result and drops the reason, so without this line
    // the hops with the least-known outcome — sent, maybe applied, never
    // answered — would be the ones nobody could count.
    aborted += 1
    console.warn(JSON.stringify({ event: AI_TOOL_RELAY_EVENT, tool, route: 'aborted', ...placement }))
    throw answer.reason instanceof Error ? answer.reason : new DOMException('tool call aborted', 'AbortError')
  }
  if (answer.kind === 'answered') {
    relayed += 1
    bump(relayedByTool, tool)
    // The journal line: `route: proxied` on the relaying cell, beside the
    // status the owner answered, with the same partition pair the middleware
    // logs — and never the credentials.
    console.log(JSON.stringify({ event: AI_TOOL_RELAY_EVENT, tool, route: 'proxied', status: answer.status, ...placement }))
    return { kind: 'relayed', status: answer.status, route: answer.route, body: answer.body }
  }
  if (answer.kind === 'unreachable') {
    ownerUnavailable += 1
    console.warn(JSON.stringify({ event: AI_TOOL_RELAY_EVENT, tool, route: 'owner-unavailable', reason: answer.reason, ...placement }))
    return { kind: 'owner-unavailable', reason: answer.reason }
  }
  malformed += 1
  console.warn(JSON.stringify({ event: AI_TOOL_RELAY_EVENT, tool, route: 'malformed', reason: answer.reason, ...placement }))
  return { kind: 'malformed', reason: answer.reason }
}
