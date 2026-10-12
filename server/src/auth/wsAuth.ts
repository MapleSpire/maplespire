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

import type { IncomingMessage } from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type WebSocket from 'ws'
import { decodeJwt } from 'jose'
import { verifySession, type SessionClaims } from './tokens.js'
import { authStage } from './middleware.js'
import type { WorkspaceKey } from '../rbac/docScope.js'

/**
 * WebSocket/sync auth (see docs/auth-setup.md).
 *
 * Three responsibilities, kept in one module because they share the
 * connection<->identity binding:
 *   1. `authenticateUpgrade` — validate the session cookie on the raw HTTP
 *      UPGRADE request, BEFORE the automerge-repo WebSocketServer takes over
 *      the socket ("reject the upgrade if invalid — never accept-then-check").
 *   2. `ConnectionRegistry` — binds a raw `ws` (which we authenticated at
 *      upgrade time) to the Automerge PEER ID the client announces in its
 *      `join` message, so `shareConfig.access(peerId, docId)` can look up
 *      "what can this connection see" from something that isn't
 *      client-controlled. See "Binding a peerId" below.
 *   3. Epoch revocation — LISTEN on Postgres `auth_epoch` notifications (+ a
 *      poll fallback) and terminate every live connection whose session epoch
 *      is now stale, per org.
 *
 * --- Binding a peerId to the authenticated socket --------------------------
 * (automerge-repo / automerge-repo-network-websocket 2.5.x)
 *   - The adapter emits `peer-candidate: {peerId, peerMetadata}` synchronously
 *     from inside `receiveMessage(messageBytes, socket)` when it decodes a
 *     `join` message — BEFORE it records `this.sockets[peerId] = socket` — so
 *     neither the event payload nor `adapter.sockets[peerId]` gives the socket.
 *   - `CollectionSynchronizer` calls `shareConfig.access(senderId, documentId)`
 *     on every inbound sync/request message, so access is rechecked per
 *     message rather than cached at handshake.
 *   - Strategy: `AuthenticatedWSServerAdapter` (in automergeServer.ts) overrides
 *     `receiveMessage` to record `lastSocket = socket` synchronously before
 *     delegating to `super.receiveMessage`, and reads it in its `peer-candidate`
 *     listener. There is no `await` between the two, so concurrent clients
 *     cannot interleave. Each upgrade is a new `ws` carrying its own claims
 *     (`AUTH_CLAIMS` symbol); a reconnecting client sends a fresh `join` bound
 *     to the new socket.
 */

// -----------------------------------------------------------------------
// 1. Upgrade authentication
// -----------------------------------------------------------------------

export interface UpgradeAuthResult {
  claims: SessionClaims | null
  rejection?: 'stale-session-epoch'
}

export type UpgradeEpochValidator = (claims: SessionClaims) => Promise<boolean>
export type UpgradeSessionVerifier = (token: string) => Promise<SessionClaims | null>

const DEFAULT_TOKEN_BURST_CACHE_TTL_MS = 500
const MAX_TOKEN_BURST_CACHE_TTL_MS = 5_000
const DEFAULT_TOKEN_BURST_CACHE_ENTRIES = 1_000

export interface UpgradeSessionVerifierOptions {
  cacheTtlMs?: number
  maxEntries?: number
  now?: () => number
  verify?: UpgradeSessionVerifier
}

/**
 * Coalesce verification of the exact same signed token during a reconnect
 * storm. Only successful verification is cached, never beyond the JWT's own
 * expiry, and the independent authorization-epoch check still runs on every
 * admission. This removes duplicate WebCrypto work without caching access.
 */
export function createCachedUpgradeSessionVerifier(
  options: UpgradeSessionVerifierOptions = {},
): UpgradeSessionVerifier {
  const configuredTtl = options.cacheTtlMs ?? Number(process.env.WS_AUTH_TOKEN_BURST_CACHE_MS)
  const cacheTtlMs = Number.isFinite(configuredTtl)
    ? Math.max(0, Math.min(MAX_TOKEN_BURST_CACHE_TTL_MS, Math.floor(configuredTtl)))
    : DEFAULT_TOKEN_BURST_CACHE_TTL_MS
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_TOKEN_BURST_CACHE_ENTRIES))
  const now = options.now ?? Date.now
  const verify = options.verify ?? verifySession
  const cache = new Map<string, { claims: SessionClaims; expiresAt: number }>()
  const inFlight = new Map<string, Promise<SessionClaims | null>>()

  return async (token) => {
    const cached = cache.get(token)
    if (cached && cached.expiresAt > now()) return cached.claims
    if (cached) cache.delete(token)

    let pending = inFlight.get(token)
    if (!pending) {
      pending = verify(token)
      inFlight.set(token, pending)
      const clear = () => {
        if (inFlight.get(token) === pending) inFlight.delete(token)
      }
      void pending.then((claims) => {
        clear()
        if (!claims || cacheTtlMs <= 0) return
        let jwtExpiresAt = 0
        try {
          const expirationSeconds = decodeJwt(token).exp
          if (typeof expirationSeconds === 'number') jwtExpiresAt = expirationSeconds * 1_000
        } catch { /* a verified token without a decodable expiry is not cached */ }
        const expiresAt = Math.min(now() + cacheTtlMs, jwtExpiresAt)
        if (expiresAt <= now()) return
        while (cache.size >= maxEntries) {
          const oldest = cache.keys().next().value as string | undefined
          if (oldest === undefined) break
          cache.delete(oldest)
        }
        cache.set(token, { claims, expiresAt })
      }, clear)
    }
    return await pending
  }
}

/** Manual `Cookie` header parse for the raw upgrade request (mirrors
 * tokens.ts's `parseCookies`, duplicated because that one takes an Express
 * `Request`, not a raw `IncomingMessage`). */
function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    const value = part.slice(eq + 1).trim()
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      out[name] = value
    }
  }
  return out
}

const SESSION_COOKIE_NAME = 'maplespire_session'

let lastDualWarnAt = 0
const DUAL_WARN_THROTTLE_MS = 60_000
function logDualMiss(reason: string): void {
  const now = Date.now()
  if (now - lastDualWarnAt < DUAL_WARN_THROTTLE_MS) return
  lastDualWarnAt = now
  console.warn(`[ws-auth:dual] unauthenticated upgrade allowed through (${reason})`)
}

/**
 * Authenticate a raw WS upgrade request. Mirrors `requireAuth()`'s stage
 * semantics (docs/auth-setup.md) but for the upgrade path, which never goes
 * through Express middleware:
 *   - 'off'  -> always accept, claims null.
 *   - 'dual' -> accept regardless; missing/invalid is logged (throttled).
 *   - 'on'   -> REJECT (caller writes 401 + destroys the socket) when the
 *     cookie is missing or invalid.
 */
export async function authenticateUpgrade(
  req: IncomingMessage,
  isEpochCurrent?: UpgradeEpochValidator,
  verifyToken: UpgradeSessionVerifier = verifySession,
): Promise<UpgradeAuthResult> {
  const stage = authStage()
  if (stage === 'off') return { claims: null }

  const cookies = parseCookieHeader(req.headers.cookie)
  const token = cookies[SESSION_COOKIE_NAME]
  if (!token) {
    if (stage === 'dual') logDualMiss('missing session cookie')
    return { claims: null }
  }

  const claims = await verifyToken(token)
  if (!claims) {
    if (stage === 'dual') logDualMiss('invalid or expired session')
    return { claims: null }
  }
  if (stage === 'on' && isEpochCurrent && !(await isEpochCurrent(claims))) {
    return { claims: null, rejection: 'stale-session-epoch' }
  }
  return { claims }
}

/**
 * Write a raw 401 on the upgrade socket and destroy it — used by
 * automergeServer.ts's `upgrade` handler when `authenticateUpgrade` yields no
 * claims under stage 'on'. Never call `wss.handleUpgrade` after this.
 */
export function rejectUpgrade(
  socket: { write: (s: string) => void; destroy: () => void },
  status = 401,
): void {
  const reason = status === 400 ? 'Bad Request'
    : status === 403 ? 'Forbidden'
      : status === 404 ? 'Not Found'
        : status === 409 ? 'Conflict'
          : status === 503 ? 'Service Unavailable'
            : 'Unauthorized'
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  } catch {
    // socket may already be half-closed; destroy regardless.
  }
  socket.destroy()
}

// -----------------------------------------------------------------------
// 2. Connection registry — bind (ws, claims) then (peerId, ws)
// -----------------------------------------------------------------------

const AUTH_CLAIMS = Symbol('wsAuthClaims')

type ClaimedSocket = WebSocket & { [AUTH_CLAIMS]?: SessionClaims | null }

/**
 * Per-process registry mapping live sockets <-> claims <-> Automerge peer ids.
 * `automergeServer.ts` constructs one instance and:
 *   - calls `bind(ws, claims)` right after a successful upgrade (before handing
 *     the socket to the WebSocketServer), and
 *   - calls `bindPeer(peerId, ws)` from the adapter's `peer-candidate` handler.
 *
 * `identityForPeer(peerId)` is what `selectiveSync.ts`'s `accessCheck` and the
 * epoch-revocation sweep read.
 */
export class ConnectionRegistry {
  private readonly claimsBySocket = new WeakMap<WebSocket, SessionClaims | null>()
  private readonly workspaceBySocket = new WeakMap<WebSocket, WorkspaceKey | null>()
  private readonly peerToSocket = new Map<string, WebSocket>()
  private readonly socketToPeer = new WeakMap<WebSocket, string>()
  private readonly liveSockets = new Set<WebSocket>()

  constructor() {
    // Self-register as "the" live registry for this process — there is only
    // ever one (constructed once in automergeServer.ts's startAutomergeSync).
    // Platform routes read live-connection counts through the module-level
    // accessors below instead of importing automergeServer.ts, which would
    // create an import cycle. A named function (not `currentRegistry = this`)
    // satisfies `no-this-alias`.
    registerCurrentRegistry(this)
  }

  /** Record the authenticated claims (possibly null under stage off/dual) for
   * a freshly-upgraded socket. */
  bind(ws: WebSocket, claims: SessionClaims | null, workspace: WorkspaceKey | null = null): void {
    this.claimsBySocket.set(ws, claims)
    this.workspaceBySocket.set(ws, workspace)
    this.liveSockets.add(ws)
    ;(ws as ClaimedSocket)[AUTH_CLAIMS] = claims
    ws.once('close', () => this.dropSocket(ws))
  }

  /** Record that `peerId` (the Automerge peer id from the `join` message) now
   * maps to `ws`. Called from the adapter's `peer-candidate` handler. Safe to
   * call again for a reconnect (overwrites the previous socket for that peer,
   * mirroring the adapter's own reconnect handling). */
  bindPeer(peerId: string, ws: WebSocket): void {
    const previous = this.peerToSocket.get(peerId)
    if (previous && previous !== ws) this.socketToPeer.delete(previous)
    this.peerToSocket.set(peerId, ws)
    this.socketToPeer.set(ws, peerId)
  }

  /** The claims bound to whichever socket currently owns `peerId`, or
   * undefined if the peer is unknown (never authenticated a socket for it —
   * default-deny territory for the access gate). */
  identityForPeer(peerId: string): SessionClaims | null | undefined {
    const ws = this.peerToSocket.get(peerId)
    if (!ws) return undefined
    return this.claimsBySocket.get(ws) ?? null
  }

  /** Canonical route established during the HTTP upgrade. `undefined` is an
   * unknown peer; `null` is an explicitly supported legacy socket. */
  workspaceForPeer(peerId: string): WorkspaceKey | null | undefined {
    const ws = this.peerToSocket.get(peerId)
    if (!ws) return undefined
    return this.workspaceBySocket.get(ws) ?? null
  }

  /** All (peerId, claims) pairs whose claims.orgId === orgId — used by the
   * epoch sweep to find sockets to terminate. */
  socketsForOrg(orgId: string): { peerId: string; ws: WebSocket; claims: SessionClaims }[] {
    const out: { peerId: string; ws: WebSocket; claims: SessionClaims }[] = []
    for (const [peerId, ws] of this.peerToSocket) {
      const claims = this.claimsBySocket.get(ws)
      if (claims && claims.orgId === orgId) out.push({ peerId, ws, claims })
    }
    return out
  }

  /** Number of live (authenticated) peer connections — the platform overview's
   * `liveConnections` counter. Counts every bound peer regardless of auth
   * stage/claims shape (a null-claims entry under stage off/dual is still a
   * live connection). */
  liveConnectionCount(): number {
    return this.peerToSocket.size
  }

  /**
   * The QUIESCE census for one workspace — the summary-promotion precondition
   * (`maintenance/promoteSummaryWorkspace.ts`).
   *
   * Two numbers, never one, because they answer different questions and
   * collapsing them would let a promotion look safe when it is not:
   *
   *  - `boundToWorkspace` — live sockets whose HTTP upgrade named THIS
   *    canonical workspace. Counted over `liveSockets`, not `peerToSocket`, so
   *    a socket that upgraded but has not announced an Automerge peer id yet
   *    still counts: it is one message away from writing.
   *  - `unrouted` — live sockets bound to NO workspace (legacy upgrades that
   *    carried no landscape/version). They cannot be attributed, and one of
   *    them may be on the workspace being promoted, so a caller that must
   *    PROVE quiescence treats a non-zero value as "not proven" rather than as
   *    somebody else's problem.
   */
  peerCensusForWorkspace(workspace: WorkspaceKey): { boundToWorkspace: number; unrouted: number } {
    let boundToWorkspace = 0
    let unrouted = 0
    for (const ws of this.liveSockets) {
      if (ws.readyState >= 2) continue // CLOSING/CLOSED — already gone
      const bound = this.workspaceBySocket.get(ws)
      if (!bound) { unrouted += 1; continue }
      if (bound.landscapeId === workspace.landscapeId && bound.versionId === workspace.versionId) {
        boundToWorkspace += 1
      }
    }
    return { boundToWorkspace, unrouted }
  }

  /** Ask every socket bound to one canonical workspace to reconnect through
   * the public router. The live-socket set intentionally includes upgrades
   * that have not announced an Automerge peer id yet. */
  drainWorkspace(workspace: WorkspaceKey, reason: string, forceAfterMs = 5_000): number {
    let drained = 0
    const boundedReason = reason.slice(0, 123)
    for (const ws of this.liveSockets) {
      const bound = this.workspaceBySocket.get(ws)
      if (!bound || bound.landscapeId !== workspace.landscapeId || bound.versionId !== workspace.versionId) continue
      if (ws.readyState >= 2) continue
      drained += 1
      ws.close(1012, boundedReason)
      if (forceAfterMs > 0) {
        const timer = setTimeout(() => {
          if (ws.readyState !== 3) ws.terminate()
        }, forceAfterMs)
        timer.unref?.()
      }
    }
    return drained
  }

  private dropSocket(ws: WebSocket): void {
    this.liveSockets.delete(ws)
    this.claimsBySocket.delete(ws)
    this.workspaceBySocket.delete(ws)
    const peerId = this.socketToPeer.get(ws)
    if (peerId && this.peerToSocket.get(peerId) === ws) this.peerToSocket.delete(peerId)
    this.socketToPeer.delete(ws)
  }
}

// Process-wide handle to the single `ConnectionRegistry` instance, set by its
// own constructor above. `null` until `startAutomergeSync` has run (e.g.
// early in boot, or in a unit test that never constructs one) — callers treat
// that as "0 live connections" rather than throwing.
let currentRegistry: ConnectionRegistry | null = null

function registerCurrentRegistry(registry: ConnectionRegistry): void {
  currentRegistry = registry
}

/** Live authenticated WS connection count for the current process, or 0 if no
 * `ConnectionRegistry` has been constructed yet. Read-only accessor for
 * `platformRoutes.ts`'s overview endpoint — see the constructor comment above
 * for why this is a module-level accessor rather than a threaded-through
 * dependency. */
export function liveConnectionCount(): number {
  return currentRegistry?.liveConnectionCount() ?? 0
}

/**
 * Live-socket census for one workspace, or `null` when no registry exists in
 * this process yet.
 *
 * `null` is NOT zero, and callers must not conflate them: a promotion asked to
 * prove "no peer is connected" from a process that has no WebSocket server has
 * proved nothing at all. The promotion route reads this; the standalone script
 * cannot (it is a different process) and says so in its report instead of
 * inventing a zero.
 */
export function workspacePeerCensus(
  workspace: WorkspaceKey,
): { boundToWorkspace: number; unrouted: number } | null {
  return currentRegistry?.peerCensusForWorkspace(workspace) ?? null
}

// -----------------------------------------------------------------------
// AuthenticatedWSServerAdapter — captures (socket, senderId) on 'peer-candidate'
// -----------------------------------------------------------------------

/**
 * The adapter subclass itself lives in automergeServer.ts (with the
 * `registry.bindPeer` wiring described in the module header), so this module
 * depends on `ws` only for the `WebSocket` instance type re-exported here.
 */
export type { WebSocket }

// -----------------------------------------------------------------------
// 3. Epoch revocation
// -----------------------------------------------------------------------

export interface EpochRevocationHandle {
  stop(): Promise<void>
}

export interface EpochRevocationOptions {
  /** Clear process-local workspace authorization caches when another server
   * process commits a scope change. */
  onWorkspaceAccessChanged?: (orgId: string) => void
}

interface OrgEpochRow {
  org_id: string
  epoch: number
}

/**
 * Ensure the AFTER INSERT/UPDATE/DELETE triggers on `org_members`,
 * `team_members`, and `team_scope_permissions` that bump `auth_epochs` for the
 * affected org and `pg_notify('auth_epoch', org_id)`. Idempotent (CREATE OR
 * REPLACE / DROP+CREATE TRIGGER), safe to call on every boot alongside
 * `ensureRbacSchema`.
 *
 * Placed here (auth/wsAuth.ts) rather than rbac/schema.ts because it's a
 * consumer-side concern (WS revocation) layered on top of the already-idempotent
 * `auth_epochs` table from auth/schema.ts — no circular import between the two
 * schema modules.
 */
export async function ensureEpochTriggers(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Shared bump function: UPSERT-increment auth_epochs for one org + notify.
    await client.query(`
      CREATE OR REPLACE FUNCTION bump_auth_epoch(p_org_id TEXT) RETURNS void AS $$
      BEGIN
        IF p_org_id IS NULL THEN
          RETURN;
        END IF;
        INSERT INTO auth_epochs (org_id, epoch) VALUES (p_org_id, 2)
        ON CONFLICT (org_id) DO UPDATE SET epoch = auth_epochs.epoch + 1;
        PERFORM pg_notify('auth_epoch', p_org_id);
      END;
      $$ LANGUAGE plpgsql
    `)

    // org_members: org_id is a direct column.
    await client.query(`
      CREATE OR REPLACE FUNCTION trg_bump_epoch_org_members() RETURNS trigger AS $$
      BEGIN
        PERFORM bump_auth_epoch(COALESCE(NEW.org_id, OLD.org_id));
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `)
    await client.query(`DROP TRIGGER IF EXISTS trg_epoch_org_members ON org_members`)
    await client.query(`
      CREATE TRIGGER trg_epoch_org_members
      AFTER INSERT OR UPDATE OR DELETE ON org_members
      FOR EACH ROW EXECUTE FUNCTION trg_bump_epoch_org_members()
    `)

    // team_members: org_id via teams.org_id.
    await client.query(`
      CREATE OR REPLACE FUNCTION trg_bump_epoch_team_members() RETURNS trigger AS $$
      DECLARE
        v_team_id TEXT := COALESCE(NEW.team_id, OLD.team_id);
        v_org_id TEXT;
      BEGIN
        SELECT org_id INTO v_org_id FROM teams WHERE id = v_team_id;
        PERFORM bump_auth_epoch(v_org_id);
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `)
    await client.query(`DROP TRIGGER IF EXISTS trg_epoch_team_members ON team_members`)
    await client.query(`
      CREATE TRIGGER trg_epoch_team_members
      AFTER INSERT OR UPDATE OR DELETE ON team_members
      FOR EACH ROW EXECUTE FUNCTION trg_bump_epoch_team_members()
    `)

    // team_scope_permissions: org_id via teams.org_id.
    await client.query(`
      CREATE OR REPLACE FUNCTION trg_bump_epoch_tsp() RETURNS trigger AS $$
      DECLARE
        v_team_id TEXT := COALESCE(NEW.team_id, OLD.team_id);
        v_org_id TEXT;
      BEGIN
        SELECT org_id INTO v_org_id FROM teams WHERE id = v_team_id;
        PERFORM bump_auth_epoch(v_org_id);
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `)
    await client.query(`DROP TRIGGER IF EXISTS trg_epoch_tsp ON team_scope_permissions`)
    await client.query(`
      CREATE TRIGGER trg_epoch_tsp
      AFTER INSERT OR UPDATE OR DELETE ON team_scope_permissions
      FOR EACH ROW EXECUTE FUNCTION trg_bump_epoch_tsp()
    `)

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Start listening for org epoch bumps and terminate live connections whose
 * session epoch is now stale. Uses a dedicated LISTEN client ('auth_epoch')
 * plus a 60s poll fallback (NOTIFY can be missed across a connection blip;
 * the poll re-reads every org epoch and catches anything the LISTEN missed).
 *
 * Under `authStage() !== 'on'` this still runs (so 'dual' gets the same
 * observability — bumps are logged) but never terminates a connection: only
 * 'on' enforces ('dual' only governs whether HTTP returns 401).
 */
export function startEpochRevocation(
  pool: Pool,
  registry: ConnectionRegistry,
  options: EpochRevocationOptions = {},
): EpochRevocationHandle {
  const knownEpoch = new Map<string, number>() // orgId -> last-seen epoch

  const terminateStale = (orgId: string, newEpoch: number) => {
    const enforce = authStage() === 'on'
    const sockets = registry.socketsForOrg(orgId)
    let terminated = 0
    for (const { ws, claims } of sockets) {
      if (claims.epoch >= newEpoch) continue
      if (enforce) {
        try {
          ws.close(4001, 'Session revoked — please reconnect')
        } catch {
          try {
            ws.terminate()
          } catch {
            /* already gone */
          }
        }
        terminated++
      }
    }
    if (terminated > 0 || sockets.length > 0) {
      console.log(
        `[ws-auth] org ${orgId} epoch -> ${newEpoch}: ${terminated}/${sockets.length} stale connection(s) ${
          enforce ? 'terminated' : 'observed (stage != on, not enforced)'
        }`
      )
    }
  }

  const handleBump = (orgId: string, epoch: number) => {
    const prev = knownEpoch.get(orgId) ?? 0
    knownEpoch.set(orgId, epoch)
    if (epoch > prev) terminateStale(orgId, epoch)
  }

  let listenClient: PoolClient | null = null
  let stopped = false
  // Single-flight for the (re)connect: the poll fires on wall time, not on the
  // previous attempt having settled, so a pool.connect slower than the cadence
  // would stack a second checkout whose `listenClient` overwrite leaks the
  // first (same fold as rbac/workspaceCacheInvalidation.ts).
  let connecting = false

  const connectListener = async (): Promise<void> => {
    if (stopped || connecting) return
    connecting = true
    let client: PoolClient | null = null
    try {
      client = await pool.connect()
      // stop() may have raced the checkout above — nothing else will ever
      // release this client, so hand it back here.
      if (stopped) {
        client.release()
        return
      }
      listenClient = client
      client.on('notification', (msg) => {
        if (msg.channel === 'workspace_access_changed' && msg.payload) {
          options.onWorkspaceAccessChanged?.(msg.payload)
          return
        }
        if (msg.channel !== 'auth_epoch' || !msg.payload) return
        // Payload is just the org id; re-read its epoch (cheap, avoids trusting
        // an out-of-band epoch value in the notify payload itself).
        pool
          .query<{ epoch: number | string }>('SELECT epoch FROM auth_epochs WHERE org_id = $1', [msg.payload])
          .then(({ rows }) => {
            // BIGINT → string in node-pg; coerce before numeric epoch compares.
            if (rows[0]) handleBump(msg.payload as string, Number(rows[0].epoch))
          })
          .catch((err) => console.warn('[ws-auth] failed to read bumped epoch:', err))
      })
      const deadClient = client
      client.on('error', (err) => {
        console.warn('[ws-auth] LISTEN client error, will reconnect on next poll:', err.message)
        // A checked-out client whose connection
        // died is still COUNTED by the shared pool until release(): nulling
        // the reference alone leaks one DB_POOL_MAX slot per Postgres
        // restart/failover, for the life of the process. release(err)
        // DESTROYS the dead connection rather than recycling it; try/catch
        // because release() throws on a second call (stop() may already have
        // returned it).
        try {
          deadClient.release(err)
        } catch {
          /* already released */
        }
        if (listenClient === deadClient) listenClient = null
      })
      await client.query('LISTEN auth_epoch')
      await client.query('LISTEN workspace_access_changed')
    } catch (err) {
      console.warn('[ws-auth] failed to establish LISTEN client (poll fallback still active):', err)
      // Same slot leak as the 'error' case: a client already checked out when
      // the LISTEN statements fail must be destroyed, not just forgotten.
      if (client) {
        if (listenClient === client) listenClient = null
        try {
          client.release(err instanceof Error ? err : new Error(String(err)))
        } catch {
          /* already released */
        }
      }
    } finally {
      connecting = false
    }
  }
  void connectListener()

  // Poll fallback: catches any NOTIFY missed across a LISTEN client blip, and
  // is also what makes this robust with zero LISTEN support in test/dev DBs.
  const pollMs = Number(process.env.WS_AUTH_EPOCH_POLL_MS ?? 60_000)
  const pollTimer = setInterval(() => {
    pool
      .query<OrgEpochRow>('SELECT org_id, epoch FROM auth_epochs')
      .then(({ rows }) => {
        for (const r of rows) handleBump(r.org_id, Number(r.epoch))
      })
      .catch((err) => console.warn('[ws-auth] epoch poll failed:', err))
    // Also opportunistically retry the LISTEN client if it dropped.
    if (!listenClient) void connectListener()
  }, pollMs)
  // Never .unref() — an unref'd interval does not fire under tsx (same
  // rationale as automergeServer.ts's startIdleEviction timer).

  return {
    stop: async () => {
      stopped = true
      clearInterval(pollTimer)
      const client = listenClient
      listenClient = null
      if (client) {
        try {
          await client.query('UNLISTEN auth_epoch')
          await client.query('UNLISTEN workspace_access_changed')
        } catch {
          /* connection may already be dead */
        }
        try {
          client.release()
        } catch {
          /* the 'error' handler already released it */
        }
      }
    },
  }
}
