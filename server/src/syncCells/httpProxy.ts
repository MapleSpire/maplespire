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

import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import {
  DRAFT_CREATE_PATH,
  expressMatchablePath,
  isAiToolDoorPath,
  MERGE_PATH,
  VERSION_CREATE_PATH,
} from './workspaceRouteExtractors.js'

/**
 * POSTs whose body must be REBUILT for the owner.
 *
 * Each is a bounded JSON contract the owner re-validates: the landing cell
 * re-serialises `req.body` and the owning cell's handler applies its own limits
 * — `durability-witness` slices to 500 ids of 256 characters, the others filter
 * to strings. That is what makes rebuilding safe here rather than a general
 * licence: `express.json` has already consumed the inbound stream by the time
 * this proxy runs, so a POST that is NOT in this set must never be forwarded
 * with a stale `content-length` describing a body nobody will send.
 *
 * It lives HERE, next to the code that acts on it, and is imported by
 * `workspaceHttpRoute.ts` for its allowlist — that module already depends on
 * this one, so the other direction would be a cycle. Keeping the two in one
 * place is the point: a path admitted to the allowlist without a decision about
 * its body is the defect this set exists to make impossible.
 */
export const REBUILT_JSON_BODY_PATHS = new Set([
  '/api/automerge/durable-heads',
  '/api/model/durability-witness',
  '/api/model/related-diagram-object-ids',
])

/**
 * THE WRITE FAMILIES WHOSE WORKSPACE IS IN THEIR BODY, routed to the owner.
 *
 *  1. ON A SINGLE-CELL STACK WITH OWNERSHIP ON, routing is behaviour-neutral IN
 *     THE STEADY STATE: one sync replica with `SYNC_CELL_PARTITION_COUNT: '1'`
 *     means the landing cell IS the owner, `owns()` is true, and the router
 *     calls `next()`. During a Redis outage the router answers 503
 *     `retryable: true` BEFORE anything is written — strictly better than the
 *     handler failing with a 500 after ~10 s having left durable documents
 *     behind.
 *
 *     Two windows are excluded from "steady state". (i) THE BOOT WINDOW:
 *     `index.ts` passes `ownershipRequired: () => SYNC_CELL_OWNERSHIP === 'on'`,
 *     so while the coordinator is still null these answer the router's 503
 *     "sync-cell ownership warming up" (retryable). (ii) THE `status = 'active'`
 *     FILTER: every request passes `resolveWorkspaceRoute`, so a MERGED draft's
 *     workspace becomes a bare 404 from the router, without the
 *     `classifyWorkspaceRefusal` reasoning `ensureWorkspace` gives the same
 *     case. The CLI forms of these doors remain.
 *
 *     The router's 503 is what routing adds; do not read it as "the cells fail
 *     closed" during a Redis outage — that is a property of the ownership
 *     coordinator, not of this module.
 *
 *     ATOMIC, THOUGH NOT NECESSARILY FAST. The refusal sits behind
 *     `resolveWorkspace` and `authorize`, both on the primary pool, which can
 *     starve to a 10 s plateau under these conditions; on exhaustion the
 *     middleware's catch answers 503 "workspace routing unavailable" after
 *     `connectionTimeoutMillis`. Nothing is written either way — but it is not
 *     a latency promise.
 *  2. TWO DEADLINES: these routes compute their full result before writing
 *     headers, so one connect bound and one header bound — see
 *     `CONNECT_DEADLINE_MS` and `ROUTED_WRITE_HEADER_DEADLINE_MS`.
 *
 *     Not solved here: a proxied write that times out is indistinguishable
 *     from a no-op for the caller, and a merge retried after it succeeded
 *     answers 200 with an empty `versionId` (`draft/applyMerge.ts`). The
 *     industry answer is a client-supplied idempotency key and a stored result.
 *  3. PATH SPELLINGS. Express defaults `case sensitive routing` and `strict
 *     routing` to false and `index.ts` sets neither, so `/API/model/compact`
 *     and `/api/automerge/durable-heads/` reach their handlers. Every consumer
 *     (admission gate, `rebuildsJsonBody`, ...) must therefore normalise via
 *     `expressMatchablePath` (`workspaceRouteExtractors.ts`); otherwise a
 *     spelling could be admitted yet forwarded with its body dropped.
 *  4. The `status = 'active'` filter in `resolveWorkspaceRoute` must NOT be
 *     relaxed: `OWNABLE_WORKSPACES_SQL` (`ownership.ts`) selects on the
 *     identical predicate, so resolvable ⟺ ownable. Widening one side
 *     manufactures a workspace that routes but that no cell can ever lease — a
 *     permanent 503. (Only drafts are ever non-active, so ordinary repair
 *     targets such as `repair-summary-flag` still resolve.)
 *
 * ONLY AN APPLY IS PLACED. The set is a set of PATHS, but admission is not: the
 * extractor table gates all four on the handlers' own apply predicates, because
 * `index.ts` states that the reference-integrity dry run *"is deliberately not
 * gated: it is the report an operator reads precisely when a promotion looks
 * stuck"*. Routing a report would answer that operator 503 during exactly the
 * outage the routing exists for.
 */
export const ROUTED_WRITE_PATHS = new Set([
  '/api/platform/workspace/promote-summary',
  '/api/platform/workspace/demote-summary',
  '/api/platform/workspace/repair-summary-flag',
  '/api/platform/reference-integrity/repair',
])

/**
 * The parameterised member: the draft merge.
 *
 * A `Set` cannot hold `/api/landscapes/:landscapeId/drafts/:draftId/merge`, and
 * this is the one forwarded path whose body is NOT a bounded scalar contract —
 * `resolutions` is a caller-supplied map with one entry per conflict, under the
 * app-wide `express.json({ limit: '50mb' })`. Re-serialising it on the landing
 * cell is the cost of routing a merge at all, and it is bounded by that limit
 * rather than by the route.
 *
 * Stated because `REBUILT_JSON_BODY_PATHS` earns its safety from boundedness
 * and this entry does not have that property. What makes it safe is narrower:
 * the owner re-parses and re-validates `resolutions` exactly as it would for a
 * direct request, and a merge is an operator-initiated action, not a hot path.
 *
 * `MERGE_PATH` is imported rather than re-spelled — see its docblock.
 *
 * AND THE TWO CREATION DOORS: `POST /api/landscapes/:id/drafts` and
 * `POST /api/landscapes/:id/versions`. Both fork the landscape's documents
 * under the DEFAULT version's lease — the storage fence keys the bootstrap
 * family on it — so a request landing on a cell that does not hold that lease
 * would be refused; it is routed to the owner instead. Their bodies are two
 * short scalars (`label`, optionally `forkFromVersionId`), bounded by the same
 * app-wide limit as the merge's.
 *
 * AND THE AI TOOL DOORS, which are NOT in this array: they
 * are matched by a predicate on the DECODED tool name (`isAiToolDoorPath`,
 * `workspaceRouteExtractors.ts`), because a `RegExp` on the raw path cannot
 * claim `/api/ai/tools/create%5Fdraft`, which Express serves as `create_draft`.
 * `isRoutedWritePath` asks that predicate beside this array. Their body is
 * `{ input, landscapeId?, versionId? }`; the merge's `input.resolutions` is the
 * same caller-supplied map as the HTTP merge's, under the same app-wide limit,
 * re-validated by the owner's own `executeAiTool` schema parse.
 */
export const ROUTED_WRITE_PATTERNS: readonly RegExp[] = [MERGE_PATH, DRAFT_CREATE_PATH, VERSION_CREATE_PATH]

/**
 * Does this POST path have a body the proxy knows how to rebuild?
 *
 * A SUPERSET of what the router admits, and that direction is deliberate: the
 * proxy must be able to rebuild anything it could ever be handed. The invariant
 * that matters is admitted ⇒ body decided.
 *
 * IT NORMALISES. This is fed `target.pathname`, built by
 * `new URL(request.originalUrl, base)` — raw case, raw trailing slash — while
 * the admission gate compares a lowercased, de-slashed form. Without the same
 * `expressMatchablePath` here, a spelling in the gap would be admitted,
 * proxied, and then forwarded BODYLESS by the `else if` below, which deletes
 * `content-length` and `content-type`.
 */
export function rebuildsJsonBody(pathname: string): boolean {
  return REBUILT_JSON_BODY_PATHS.has(expressMatchablePath(pathname)) || isRoutedWritePath(pathname)
}

/**
 * Is this one of the write families the router places — the body-keyed
 * platform writes, the merge, the two creation doors, the AI tool doors?
 *
 * Asked by the router to decide the header deadline: these compute their whole
 * result before writing a header, so they get `ROUTED_WRITE_HEADER_DEADLINE_MS`
 * where a read gets the historical five seconds. And by `rebuildsJsonBody`,
 * which is why admitting a path here is never also an undecided question
 * about its body.
 */
export function isRoutedWritePath(pathname: string): boolean {
  return ROUTED_WRITE_PATHS.has(expressMatchablePath(pathname))
    // The merge pattern carries `i` and an optional trailing slash of its own,
    // so it is tested against the RAW path — normalising here would be
    // harmless (nothing is captured) but would spell the rule twice.
    || ROUTED_WRITE_PATTERNS.some((pattern) => pattern.test(pathname))
    // The AI tool doors decode their capture before comparing it, so they are
    // a predicate rather than a pattern — see `AI_TOOL_PATH`.
    || isAiToolDoorPath(pathname)
}

export const SYNC_HTTP_ROUTED_HEADER = 'x-maplespire-sync-http-routed'
export const SYNC_HTTP_ROUTE_HEADER = 'x-maplespire-sync-route'

/**
 * THE BENCH'S ROUTING BYPASS — a header the cell honours only under
 * `SYNC_CELL_BENCH_UNROUTED=on`, and only on the AI tool door.
 *
 * It exists so `b25a-redis-outage-bench.mjs` can reach the bootstrap fence
 * directly: with the router in front of every bootstrap door, a refusal by the
 * router says nothing about the fence. Absent the env var, a request carrying
 * it is REFUSED 400 — never served, never silently routed — so a bench can
 * never quietly measure the wrong mechanism.
 *
 * It is declared here, beside the two routing headers, so the three are read
 * together; `workspaceHttpRoute.ts` is what acts on it.
 */
export const SYNC_BENCH_UNROUTED_HEADER = 'x-maplespire-sync-bench-unrouted'

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

interface ProxyRequest extends IncomingMessage {
  originalUrl?: string
  body?: unknown
}

interface ProxyResponse extends ServerResponse {
  destroy(error?: Error): this
}

function targetUrl(advertiseUrl: string, requestUrl: string): URL | null {
  try {
    const base = new URL(advertiseUrl)
    if (
      !['http:', 'https:'].includes(base.protocol)
      || base.username
      || base.password
      || base.pathname !== '/'
      || base.search
      || base.hash
    ) return null
    const target = new URL(requestUrl, base)
    if (target.origin !== base.origin) return null
    return target
  } catch {
    return null
  }
}

/**
 * HOW LONG A TCP CONNECTION TO THE OWNER MAY TAKE, which is a different
 * question from how long the owner may take to answer.
 *
 * A dead owner has to produce the fast 503 the load balancer needs, and that is
 * this bound. A SLOW owner is not a dead one: with one bound for both, a route
 * that computes its whole result before writing a header would be 503'd on the
 * landing cell while the owner carried on executing it.
 */
export const CONNECT_DEADLINE_MS = 5_000

/**
 * How long the OWNER may take to produce a response header for one of the
 * admitted write families. A POLICY, chosen between two bounds rather than
 * measured itself.
 *
 *   LOWER: the owner's own failure ceiling. `db.ts` runs the primary pool at
 *   `connectionTimeoutMillis` 10 s, and under load `draft-merge` and
 *   `promote-summary` fail at ~10 s on pool acquisition. A proxy deadline under
 *   that turns every owner-side pool timeout into a landing-cell 503 for an
 *   operation still running, which is the worst possible ordering.
 *
 *   UPPER: `docker/nginx/nginx.conf`'s `location /api/` sets no
 *   `proxy_read_timeout`, so nginx's 60 s default cuts the whole path in the
 *   self-hosted topology regardless of what this says. (Other front proxies or
 *   load balancers may set a different idle timeout.)
 *
 * 45 s sits well above the first and below the second. What it does NOT do is
 * make a slow write safe: a proxied write that times out is indistinguishable
 * from a no-op for the caller, and the industry's answer to that is an
 * idempotency key, not a larger number.
 *
 * The bench's nginx does not enable replay of a POST already sent upstream.
 * `infra/compose/sync-cell-router.nginx.conf` keeps error/timeout/502/503 retry
 * conditions without `non_idempotent`; a failed connection BEFORE submission
 * may still try another member, within a five-second window that is not a
 * total request deadline. That window is distinct
 * from this relay's connect bound and the 45-second write-header bound below.
 * A 503 after submission belongs to the client to handle; nginx must not
 * silently replay an already submitted mutation on another cell.
 */
export const ROUTED_WRITE_HEADER_DEADLINE_MS = 45_000

function fail(response: ProxyResponse, status = 503): void {
  // `destroyed` as well as `headersSent`: the abort path below destroys the
  // response, and `setHeader`/`end` on a destroyed stream is a throw inside a
  // timer callback — an unhandled rejection with no request left to answer.
  if (response.destroyed) return
  if (response.headersSent) {
    response.destroy()
    return
  }
  const body = JSON.stringify({ error: 'workspace owner unavailable', retryable: true })
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', Buffer.byteLength(body))
  response.end(body)
}

/** Stream an already-authorized workspace HTTP request to its owning cell.
 * The owner repeats authentication and authorization. Responses (including
 * SSE) are piped with Node stream backpressure; only connection and header
 * arrival have deadlines, long-lived event streams do not.
 *
 * TWO deadlines, because they answer different questions:
 * `CONNECT_DEADLINE_MS` bounds reaching the owner at all, and `timeoutMs`
 * bounds the owner's first header. The default keeps the historical 5 s for
 * both; the router raises the second to `ROUTED_WRITE_HEADER_DEADLINE_MS` for
 * the write families, whose result is computed before any header is written. */
export function proxyWorkspaceHttpRequest(options: {
  request: ProxyRequest
  response: ProxyResponse
  advertiseUrl: string
  sourceCellId: string
  /** How long the OWNER may take to produce a response header. */
  timeoutMs?: number
  /** How long the CONNECTION may take. Overridable only so a test can tell the
   *  two bounds apart — with both at their defaults, a test cannot prove the
   *  connect timer is cleared on connect rather than merely outlived. */
  connectTimeoutMs?: number
}): Promise<boolean> {
  const { request, response, advertiseUrl, sourceCellId } = options
  const timeoutMs = options.timeoutMs ?? 5_000
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_DEADLINE_MS
  return new Promise((resolve) => {
    const target = targetUrl(advertiseUrl, request.originalUrl || request.url || '/')
    if (!target) {
      fail(response)
      resolve(false)
      return
    }

    const headers = { ...request.headers }
    for (const header of HOP_BY_HOP_HEADERS) delete headers[header]
    // Let the landing cell's compression middleware make the one compression
    // decision. This avoids double-compressing an upstream response and leaves
    // text/event-stream unbuffered.
    delete headers['accept-encoding']
    delete headers[SYNC_HTTP_ROUTED_HEADER]
    headers.host = target.host
    headers[SYNC_HTTP_ROUTED_HEADER] = sourceCellId
    let serializedBody: string | undefined
    if (request.method === 'POST' && rebuildsJsonBody(target.pathname)) {
      // express.json() consumed the inbound stream on the landing cell. Rebuild
      // only these bounded, validated-at-owner JSON contracts for the owning
      // cell — the set is declared beside the allowlist that admits them, so a
      // path can never be forwarded without a decision about its body.
      serializedBody = JSON.stringify(request.body ?? {})
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(serializedBody))
    } else if (request.method === 'POST') {
      // Maintenance POSTs are bodyless; never forward their stale length.
      delete headers['content-length']
      delete headers['content-type']
    }

    const transport = target.protocol === 'https:' ? https : http
    const upstream = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers,
      agent: false,
    })

    let settled = false
    // TWO BOUNDS, AND A DISARM THAT EVERY TERMINAL PATH REACHES.
    //
    // Every terminal path (`response`, `error`, `aborted`, `close`, expiry) must
    // settle the promise and clear BOTH timers. Otherwise the executor's closure
    // — holding `serializedBody`, up to `express.json`'s 50 MB limit — stays
    // reachable for the whole deadline. `unref()` keeps a timer out of the exit
    // accounting; it does not release what the timer's closure retains.
    const connectTimer = setTimeout(() => expire(), connectTimeoutMs)
    const headerTimer = setTimeout(() => expire(), timeoutMs)
    connectTimer.unref?.()
    headerTimer.unref?.()
    const settle = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      clearTimeout(headerTimer)
      serializedBody = undefined
      resolve(value)
    }
    function expire(): void {
      if (settled) return
      settle(false)
      upstream.destroy()
      fail(response)
    }

    upstream.once('socket', (socket) => {
      // The connect bound answers "is the owner reachable", so it is cleared the
      // moment the TCP (or TLS) connection is up, whatever the header bound
      // still allows. `agent: false` above means a fresh socket per request, so
      // `connecting` is the honest reading rather than a pooled leftover.
      if (!socket.connecting) {
        clearTimeout(connectTimer)
        return
      }
      const connected = (): void => clearTimeout(connectTimer)
      socket.once('connect', connected)
      socket.once('secureConnect', connected)
    })

    request.once('aborted', () => {
      settle(false)
      upstream.destroy()
    })
    response.once('close', () => {
      if (!response.writableEnded) upstream.destroy()
      settle(false)
    })
    upstream.once('response', (upstreamResponse) => {
      if (settled) {
        upstreamResponse.destroy()
        return
      }
      clearTimeout(connectTimer)
      clearTimeout(headerTimer)
      upstream.setTimeout(0)
      response.statusCode = upstreamResponse.statusCode ?? 502
      if (upstreamResponse.statusMessage) response.statusMessage = upstreamResponse.statusMessage
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue
        response.setHeader(name, value)
      }
      // Do not expose a cell identity. This bounded marker is useful for
      // operations and the active/active conformance gate.
      response.setHeader(SYNC_HTTP_ROUTE_HEADER, 'proxied')
      upstreamResponse.once('error', (error) => response.destroy(error))
      upstreamResponse.pipe(response)
      settle(true)
    })
    upstream.once('error', () => {
      if (settled) return
      settle(false)
      fail(response)
    })
    upstream.end(serializedBody)
  })
}

/**
 * ONE JSON REQUEST TO THE OWNER, FROM INSIDE A HANDLER — the
 * transport under the tool-call relay (`aiToolCallRelay.ts`).
 *
 * `proxyWorkspaceHttpRequest` above forwards a REQUEST the landing cell has not
 * answered yet and pipes the owner's response into the caller's socket. The
 * agent loop is in the middle of answering a request: the conversation stays
 * where it landed, ONE tool call hops, and its answer comes back as a value.
 * So this is a client, not a proxy — with the same origin validation
 * (`targetUrl`), the same routed marker (`SYNC_HTTP_ROUTED_HEADER`, so an owner
 * that lost the lease answers route-loop instead of forwarding again), the same
 * hop-by-hop hygiene and the same connect bound (`CONNECT_DEADLINE_MS`).
 *
 * ONE deadline where the proxy has two, and it bounds the whole ANSWER. The
 * proxy clears its header timer on the first byte and leaves a live stream
 * unbounded on purpose (SSE). A tool answer is a bounded JSON document: a
 * header timer cleared on arrival would let an owner that sends headers and
 * then stalls hold the tool call — and the model's turn behind it — until the
 * loop's own round watchdog fires (`AI_AGENT_ROUND_TIMEOUT_MS`, 360 s by
 * default, `ai/core/agent.ts`). So `timeoutMs` runs from the request to the
 * LAST byte of the answer, and the caller's `signal` — the round watchdog, the
 * client disconnect — destroys the hop from outside.
 *
 * THE ANSWER IS BOUNDED, and the bound is a POLICY anchored on the tree rather
 * than a measurement: `index.ts` accepts inbound JSON up to `express.json`'s
 * 50 MB, so an owner answering the same door cannot legitimately need more
 * than the door accepts. `toolResultText` then cuts what the MODEL sees at
 * 60 000 characters; the bound here protects the relaying cell's memory from a
 * peer that misbehaves, not the model.
 *
 * NOTHING HERE RETRIES. A POST that timed out may have been applied by the
 * owner — a merge is not idempotent — and both halves of the tree's doctrine
 * refuse to repeat a non-idempotent method (`src/lib/api/retryable.ts`; the
 * nginx `proxy_next_upstream` note on `ROUTED_WRITE_HEADER_DEADLINE_MS`). The
 * caller gets `unreachable`, the loop tells the model, and if the model asks
 * again a merged draft is not mergeable twice (`applyMerge` answers 404) —
 * which is the only reason a second ask is safe, and it does not extend to
 * `create_draft`. Known, and not solved here.
 *
 * EVERY TERMINAL PATH RELEASES EVERYTHING — both timers, the abort listener
 * and the socket — through one `finish`. The abort listener matters most: the
 * signal it hangs on is the loop's round watchdog, which outlives every tool
 * call in the round, so a listener left behind keeps this closure (and the
 * serialised body) reachable until the round ends. `proxyWorkspaceHttpRequest`
 * settles the same way for the same reason.
 */
export const OWNER_JSON_ANSWER_LIMIT_BYTES = 50 * 1024 * 1024

export interface OwnerJsonRequest {
  advertiseUrl: string
  /** Path and query of the door on the owner, e.g. `/api/ai/tools/merge_draft`. */
  path: string
  body: unknown
  /** The caller's credential headers, forwarded so the owner authenticates the
   *  SAME user. Hop-by-hop names, `host`, the content headers and the routed
   *  marker are dropped whatever the caller passes — this function owns them. */
  headers: Readonly<Record<string, string>>
  sourceCellId: string
  signal?: AbortSignal
  /** Whole-answer deadline: request sent → last byte of the owner's JSON. */
  timeoutMs?: number
  connectTimeoutMs?: number
  maxAnswerBytes?: number
}

export type OwnerJsonAnswer =
  /** The owner answered a complete document. `body` is `null` when a NON-2xx
   *  answer was not JSON (a proxy's HTML error page, say): the owner's STATUS
   *  is the fact that matters there and it survives; a 2xx that is not JSON is
   *  `malformed`, because a result the door never produced must not be handed
   *  to the model as one. */
  | { kind: 'answered'; status: number; route: string | null; body: unknown }
  /** Never got a complete answer: `answer-cut` is a connection that dropped
   *  AFTER the request was sent — the owner may have applied it. */
  | { kind: 'unreachable'; reason: 'bad-advertise-url' | 'connect-timeout' | 'answer-timeout' | 'connection-error' | 'answer-cut' }
  | { kind: 'malformed'; reason: 'not-json' | 'too-large' }
  | { kind: 'aborted'; reason: unknown }

export function requestWorkspaceOwnerJson(options: OwnerJsonRequest): Promise<OwnerJsonAnswer> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_DEADLINE_MS
  const maxAnswerBytes = options.maxAnswerBytes ?? OWNER_JSON_ANSWER_LIMIT_BYTES
  const signal = options.signal
  // An already-aborted signal never fires `abort` again — asked first, or the
  // request would be sent and the answer awaited for a caller that is gone.
  if (signal?.aborted) return Promise.resolve({ kind: 'aborted', reason: signal.reason })
  const target = targetUrl(options.advertiseUrl, options.path)
  if (!target) return Promise.resolve({ kind: 'unreachable', reason: 'bad-advertise-url' })

  return new Promise((resolve) => {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(options.headers)) {
      const key = name.toLowerCase()
      if (
        HOP_BY_HOP_HEADERS.has(key)
        || key === 'host'
        || key === 'content-length'
        || key === 'content-type'
        || key === 'accept-encoding'
        || key === SYNC_HTTP_ROUTED_HEADER
      ) continue
      headers[key] = value
    }
    const serializedBody = JSON.stringify(options.body ?? {})
    headers.host = target.host
    headers.accept = 'application/json'
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(Buffer.byteLength(serializedBody))
    headers[SYNC_HTTP_ROUTED_HEADER] = options.sourceCellId

    const transport = target.protocol === 'https:' ? https : http
    const upstream = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: 'POST',
      path: `${target.pathname}${target.search}`,
      headers,
      agent: false,
    })

    let settled = false
    const connectTimer = setTimeout(() => finish({ kind: 'unreachable', reason: 'connect-timeout' }), connectTimeoutMs)
    const answerTimer = setTimeout(() => finish({ kind: 'unreachable', reason: 'answer-timeout' }), timeoutMs)
    connectTimer.unref?.()
    answerTimer.unref?.()
    const onAbort = (): void => finish({ kind: 'aborted', reason: signal?.reason })
    signal?.addEventListener('abort', onAbort, { once: true })
    function finish(answer: OwnerJsonAnswer): void {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      clearTimeout(answerTimer)
      signal?.removeEventListener('abort', onAbort)
      if (answer.kind !== 'answered') upstream.destroy()
      resolve(answer)
    }

    upstream.once('socket', (socket) => {
      if (!socket.connecting) {
        clearTimeout(connectTimer)
        return
      }
      const connected = (): void => clearTimeout(connectTimer)
      socket.once('connect', connected)
      socket.once('secureConnect', connected)
    })
    upstream.once('error', () => finish({ kind: 'unreachable', reason: 'connection-error' }))
    upstream.once('response', (response) => {
      if (settled) {
        response.destroy()
        return
      }
      clearTimeout(connectTimer)
      const chunks: Buffer[] = []
      let received = 0
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > maxAnswerBytes) {
          finish({ kind: 'malformed', reason: 'too-large' })
          response.destroy()
          return
        }
        chunks.push(chunk)
      })
      // A connection that drops mid-body is a TRANSPORT failure after the
      // request was sent, not an owner that answered nonsense — the caller
      // must treat it like a timeout (the owner may have applied the call).
      response.once('error', () => finish({ kind: 'unreachable', reason: 'answer-cut' }))
      response.once('end', () => {
        if (settled) return
        const status = response.statusCode ?? 502
        const route = response.headers[SYNC_HTTP_ROUTE_HEADER]
        let body: unknown
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          // A non-JSON ERROR keeps its status (an nginx 503 page is still a
          // 503); a non-JSON 2xx is not a result and says so.
          if (status >= 200 && status < 300) {
            finish({ kind: 'malformed', reason: 'not-json' })
            return
          }
          body = null
        }
        finish({
          kind: 'answered',
          status,
          route: typeof route === 'string' ? route : null,
          body,
        })
      })
    })
    upstream.end(serializedBody)
  })
}
