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
import type { IncomingMessage } from 'node:http'
import { randomBytes } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { Repo, type DocHandle, type AutomergeUrl, type DocumentId } from '@automerge/automerge-repo'
import { NodeWSServerAdapter } from '@automerge/automerge-repo-network-websocket'
import * as Automerge from '@automerge/automerge'
import { PostgresStorageAdapter, type StorageFenceSnapshot } from './automergeStorage.js'
import { cachedHandles, drainEntries, syncedHandle } from './automergeRepoCompat.js'
import { pool } from './db.js'
import { envNumber } from './envNumber.js'
import { migrateEntitiesIntoRoot } from './automergeMigrate.js'
import { seedDemoIntoUnpublishedRoot } from './demoSeed.js'
import { buildModelMeta } from './modelMeta.js'
import { buildEmptyRootShape } from './rootShape.js'
import type { BootstrapScope } from './bootstrapScope.js'
import { createSelectiveSync, stageAwareAccessCheck } from './selectiveSync.js'
import { createSyncWriteGate, throttledOnce, type GateMessage, type SyncWriteGate, type WriteCheck } from './syncWriteGate.js'
import type { WorkspaceKey } from './readModel/projector.js'
import { authStage } from './auth/middleware.js'
import { authenticateUpgrade, createCachedUpgradeSessionVerifier, rejectUpgrade, ConnectionRegistry, startEpochRevocation } from './auth/wsAuth.js'
import { sharedSessionEpochValidator } from './auth/sessionEpoch.js'
import type { SessionClaims } from './auth/tokens.js'
import { WorkspaceDocIndex, buildAccessCheck, buildWorkspaceRouteCheck, buildWriteCheck, buildBaselineWriteFence, resolveDocumentPlacement, allowedWorkspaceKeys, invalidateAllowedWorkspaceKeysCache, type GateFaultReporter } from './rbac/docScope.js'
import { accessCheckMode, createClaimOnlyAccessCheck } from './rbac/claimOnlyAccessCheck.js'
import { createDenyLedger, type DenyLedger, type DenyLedgerSnapshot } from './rbac/denyLedger.js'
import { installDenyLedgerReleaseGuard } from './readModel/documentReleaseGuard.js'
import { installProvisionalPlacementSource } from './rbac/provisionalPlacementSource.js'
import { isCaughtUp, serviceLatency } from './automergeServiceLatency.js'
import { startWorkspaceCacheInvalidation } from './rbac/workspaceCacheInvalidation.js'
import { dropWorkspaceCoverageLocally } from './rbac/claimCoverage.js'
import { createDocumentAccessCheck } from './rbac/documentAccess.js'
import { appendAudit } from './auth/audit.js'
import {
  AutomergeTransportTelemetry,
  automergeTransportConfig,
  backpressureAction,
  type TransportMessage,
} from './automergeTransportTelemetry.js'
import type { SyncCellOwnership } from './syncCells/ownership.js'
import type { LiveWorkspaceResidency } from './readModel/liveWorkspaceResidency.js'
import { getSharedWorkspaceRouteResolver, parseWorkspaceRoute, resolveWorkspaceRouteForUpgrade } from './syncCells/workspaceRoute.js'
import {
  createDefaultVersionRepointHandler,
  installDefaultVersionRepointHandler,
} from './syncCells/defaultVersionRepoint.js'
import { encodeWorkspaceBinding } from './syncCells/workspaceBinding.js'
import {
  proxyWorkspaceUpgrade,
  SYNC_ROUTED_HEADER,
  type UpgradeSocket,
} from './syncCells/upgradeProxy.js'
import { AutomergeResidencyLeases, classifyAutomergeDocument } from './automergeResidency.js'
import { serializeAutomergeDocumentMessages } from './serializeAutomergeMessages.js'
import { observeAutomergeBackgroundSaveErrors } from './automergeBackgroundSave.js'
import { drainAutomergeResources, runShutdownSteps } from './automergeDrain.js'
import { FairInboundQueue, inboundFrameBatchSize } from './fairInboundQueue.js'
import {
  createDiagramPresenceGate,
  normalizePresenceIdentity,
  type DiagramPresenceGate,
} from './diagramPresenceGate.js'

/**
 * Time allowed to coalesce durable Automerge saves. A single-node server keeps
 * the upstream 100 ms default, while failover deployments can opt into a zero
 * delay so a replacement does not have to replay a large divergent client
 * branch that the paused owner had only retained in memory.
 */
export function automergeSaveDebounceRate(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AM_SAVE_DEBOUNCE_MS
  if (raw == null || raw.trim() === '') return 100
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5_000) {
    throw new Error('AM_SAVE_DEBOUNCE_MS must be an integer between 0 and 5000')
  }
  return parsed
}

/**
 * Subclass of `NodeWSServerAdapter` (= `WebSocketServerAdapter`) that captures
 * the raw `ws` socket a `join` message arrived on, synchronously, before
 * delegating to the adapter's own `receiveMessage`. This is what lets us bind
 * the Automerge PEER ID (only known once the `join` message decodes) back to
 * the socket we authenticated at upgrade time — see the module header of
 * auth/wsAuth.ts for why this strategy is needed.
 *
 * `lastSocket` is safe under concurrent clients because Node runs each
 * `receiveMessage` call to completion (including the synchronous
 * `peer-candidate` emit inside it) before any other socket's message can
 * interleave — there is no `await` between setting `lastSocket` here and the
 * base class reading it during the same synchronous call.
 *
 * It is ALSO the write-enforcement point: the base adapter decodes each wire
 * message and hands it to the repo via `this.emit('message', message)` from
 * inside `receiveMessage` — after verifying the message's `senderId` owns this
 * very socket (so a peer can't speak as another peer). Overriding `emit` there
 * lets `writeGate` (syncWriteGate.ts) inspect already-decoded doc messages and
 * DROP change-carrying ones from peers without a write grant, before the
 * synchronizer can apply/persist/relay them. With no gate installed (AUTH=off
 * boots) every message forwards untouched.
 *
 * Exported for syncWriteGate.integration.test.ts, which drives two real client
 * repos through this exact adapter+gate path over a loopback WebSocket.
 */
export class AuthenticatedWSServerAdapter extends NodeWSServerAdapter {
  private lastSocket: WebSocket | null = null
  private readonly inboundFrames: FairInboundQueue<WebSocket, Uint8Array>
  private peerCandidateBinder: ((peerId: string, socket: WebSocket) => void) | null = null
  private readonly pressuredSockets = new WeakSet<WebSocket>()
  private readonly closingForBackpressure = new WeakSet<WebSocket>()
  /** Installed by `startAutomergeSync` when the AUTH stage may enforce; null = pass-through. */
  writeGate: SyncWriteGate | null = null
  /** App-owned ephemeral messages bypass automerge-repo's document access
   * checks, so cursor presence has its own fail-closed validation boundary. */
  presenceGate: DiagramPresenceGate | null = null
  /** Fail-closed mutation admission when this process no longer owns a
   * workspace lease. Kept separate from RBAC so either gate can be tested and
   * rolled out independently. */
  ownershipGate: SyncWriteGate | null = null
  /** The BASELINE WRITE FENCE: on a workspace with a
   * `read_model_static_workspaces` row, inbound mutations of the frozen
   * baseline documents (kind `registry` and `*-base`) are dropped. ALWAYS-ON,
   * independent of the AUTH stage — this is a property of the DOCUMENT, not of
   * the peer, and it must hold for exactly the stale/flagless clients that
   * would otherwise reconcile a windowed store into the baseline. A drop here
   * never cuts reads and pins nothing; the client's heads are simply never
   * acknowledged (its badge honestly stays "Enregistrement…"). */
  baselineWriteFence: SyncWriteGate | null = null
  /** Outstanding recoverable denials. A peer's cached verdicts die with its
   * socket, so the ledger has to hear about the disconnect or it keeps asking
   * for re-evaluations on behalf of a connection that no longer exists. */
  denyLedger: Pick<DenyLedger, 'forgetPeer'> | null = null

  constructor(
    server: ConstructorParameters<typeof NodeWSServerAdapter>[0],
    private readonly transportTelemetry?: AutomergeTransportTelemetry,
  ) {
    super(server)
    this.inboundFrames = new FairInboundQueue(
      inboundFrameBatchSize(),
      (messageBytes, socket) => this.processInboundFrame(messageBytes, socket),
      (socket) => socket.readyState === WebSocket.OPEN,
    )
  }

  receiveMessage(messageBytes: Uint8Array, socket: WebSocket): void {
    this.transportTelemetry?.recordInboundFrame(messageBytes.byteLength)
    // Queue the join handshake as well as document frames. The per-socket FIFO
    // still guarantees that peer binding completes before that socket's first
    // document message, while preventing dozens of reconnect joins delivered
    // by one poll callback from monopolising the event loop during failover.
    this.inboundFrames.enqueue(socket, messageBytes)
  }

  private processInboundFrame(messageBytes: Uint8Array, socket: WebSocket): void {
    const startedAt = performance.now()
    this.lastSocket = socket
    try {
      super.receiveMessage(messageBytes, socket)
    } finally {
      this.lastSocket = null
      const durationMs = performance.now() - startedAt
      if (durationMs >= 50) console.warn(JSON.stringify({
        event: 'automerge.inbound_frame_slow',
        durationMs: Math.round(durationMs * 100) / 100,
        messageBytes: messageBytes.byteLength,
      }))
    }
  }

  send(message: Parameters<NodeWSServerAdapter['send']>[0]): void {
    const socket = this.sockets[message.targetId] as WebSocket | undefined
    if (!socket) {
      this.transportTelemetry?.recordDisconnectedDrop()
      super.send(message)
      return
    }

    const bufferedBytes = Math.max(0, socket.bufferedAmount || 0)
    const action = this.transportTelemetry
      ? backpressureAction(bufferedBytes, this.transportTelemetry.config)
      : 'send'
    if (action === 'close') {
      if (!this.closingForBackpressure.has(socket)) {
        this.closingForBackpressure.add(socket)
        this.transportTelemetry?.recordBackpressureDisconnect(bufferedBytes)
        socket.close(1013, 'Client cannot keep up; reconnecting')
      } else {
        this.transportTelemetry?.recordBackpressureDrop()
      }
      return
    }
    if (action === 'warn') {
      if (!this.pressuredSockets.has(socket)) {
        this.pressuredSockets.add(socket)
        this.transportTelemetry?.recordBackpressureWarning(bufferedBytes)
      }
    } else if (bufferedBytes < (this.transportTelemetry?.config.backpressureWarnBytes ?? 0) / 2) {
      this.pressuredSockets.delete(socket)
    }

    const telemetryMessage = message as TransportMessage
    this.transportTelemetry?.recordOutbound(
      telemetryMessage,
      telemetryMessage.data?.byteLength ?? 0,
      bufferedBytes,
    )
    super.send(message)
    this.transportTelemetry?.observeBuffered(socket.bufferedAmount || 0)
  }

  /** Read by the `peer-candidate` listener registered in `startAutomergeSync`
   * — valid only synchronously within the `receiveMessage` call that produced
   * the event, which is exactly when the listener runs. */
  currentSocket(): WebSocket | null {
    return this.lastSocket
  }

  /** Bind the authenticated socket before Repo observes `peer-candidate`.
   * Repo immediately starts async share-policy checks from that event; binding
   * in a later listener races the initial check and can leave a peer denied
   * even after a global shareConfigChanged() repair. */
  setPeerCandidateBinder(binder: (peerId: string, socket: WebSocket) => void): void {
    this.peerCandidateBinder = binder
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'peer-disconnected') {
      const disconnected = args[0] as { peerId?: unknown } | undefined
      if (typeof disconnected?.peerId === 'string') {
        this.presenceGate?.disconnect(disconnected.peerId, (message) => {
          this.forwardEmit('message', [message])
        })
        this.denyLedger?.forgetPeer(disconnected.peerId)
        // A peer that left is neither served nor being served. Its
        // in-service documents leave the pending set WITHOUT a sample:
        // counting a disconnect as a completion would
        // report the fastest possible service for serving nothing.
        serviceLatency.forgetPeer(disconnected.peerId)
      }
    }
    if (event === 'peer-candidate' && this.lastSocket && this.peerCandidateBinder) {
      const candidate = args[0] as { peerId?: unknown } | undefined
      if (typeof candidate?.peerId === 'string') {
        this.peerCandidateBinder(candidate.peerId, this.lastSocket)
      }
    }
    if (event === 'message') this.transportTelemetry?.recordInboundMessage(args[0] as TransportMessage)
    if (event === 'message' && this.presenceGate) {
      const message = args[0] as GateMessage | undefined
      if (message?.type === 'ephemeral') {
        const socketKey: object = this.lastSocket ?? message
        this.presenceGate.process(message, socketKey, () => this.forwardEmit(event, args))
        return true
      }
    }
    if (event === 'message' && (this.ownershipGate || this.writeGate || this.baselineWriteFence)) {
      const message = args[0] as GateMessage | undefined
      if (message && (message.type === 'sync' || message.type === 'request') && message.documentId != null) {
        // `emit('message')` only ever fires synchronously inside the base
        // class's receiveMessage, so lastSocket is the authenticated socket
        // this message arrived on — the gate's per-connection FIFO key.
        const socketKey: object = this.lastSocket ?? message
        const throughRbac = () => {
          if (this.writeGate) {
            this.writeGate.process(message, socketKey, () => this.forwardEmit(event, args))
          } else {
            this.forwardEmit(event, args)
          }
        }
        const throughFence = () => {
          // The fence sits BEFORE the RBAC write gate: a fenced-baseline drop
          // is a server-policy verdict about the document, so it should not
          // also surface as a per-user RBAC denial in the audit trail.
          if (this.baselineWriteFence) this.baselineWriteFence.process(message, socketKey, throughRbac)
          else throughRbac()
        }
        if (this.ownershipGate) this.ownershipGate.process(message, socketKey, throughFence)
        else throughFence()
        return true
      }
    }
    return this.forwardEmit(event, args)
  }

  /** Single cast point for delegating to eventemitter3's generically-typed emit. */
  private forwardEmit(event: string | symbol, args: unknown[]): boolean {
    type AnyEmit = (event: string | symbol, ...args: unknown[]) => boolean
    return (super.emit as AnyEmit)(event, ...args)
  }
}

/** Empty root document shape — from the ONE root-shape module (rootShape.ts),
 * which mirrors the client's `emptyRootDoc()` without depending on client
 * source. The `change` blocks that fill it below are in-place mutations of a
 * doc this process just created, touching only fields inside the closed
 * ROOT_SHAPE_FIELDS list. */
function emptyRoot(): Record<string, unknown> {
  return buildEmptyRootShape() as unknown as Record<string, unknown>
}

function emptyModelDoc(): Record<string, unknown> {
  return { objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} }
}

async function getMeta(key: string): Promise<string | null> {
  const { rows } = await pool.query<{ value: string }>(
    'SELECT value FROM automerge_meta WHERE key = $1',
    [key]
  )
  return rows[0]?.value ?? null
}

async function setMeta(key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO automerge_meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  )
}

/** Minimal per-diagram doc (mirrors the client's `diagramToDiagramDoc` output
 * for a brand-new empty diagram — src/lib/automerge/types.ts DiagramDoc; kept
 * inline like `emptyRoot` so the server has no dependency on client source). */
function starterDiagramDoc(name: string): Record<string, unknown> {
  return {
    name,
    type: 'context',
    objectIds: [],
    connectionIds: [],
    groupIds: [],
    layouts: {},
    comments: {},
    flows: {},
    checkpoints: [],
  }
}

/**
 * Create a fresh, EMPTY workspace root (root doc + empty ModelDoc + one empty
 * registry shard) and return its URL. This is the per-(landscape,version) root
 * factory used by the multi-landscape registry — a new landscape or a
 * new version gets its own independent root so it can be edited in isolation. No
 * legacy migration (that is one-time, for the primary root only).
 *
 * `opts.starterDiagram` additionally seeds one empty Context diagram: its own
 * DiagramDoc plus a DiagramMeta entry in the first registry shard, exactly the
 * two artifacts the client's own create-diagram path writes. Used by
 * first-login provisioning so a brand-new user's editor opens ON a diagram
 * (startBridge auto-opens `diagrams[0]`) instead of the empty-workspace overlay.
 *
 * The SHARDED model skeleton is ALWAYS created — ModelMeta + one empty object
 * shard + one empty connection shard, each also serving as its collection's
 * persistent edits overlay — and `modelMetaUrl` is always recorded on the root.
 * A workspace born without it would be sharded by the CLIENT, producing docs the
 * server can neither serve to the projector nor guarantee to capture, and a
 * ModelMeta with no overlay write head — i.e. data loss. The bridge reuses a
 * pre-sharded workspace as-is on every client (the sharded read path keys off
 * `root.modelMetaUrl`, not a client flag).
 */
export async function createEmptyRoot(
  repo: Repo,
  /** THE SCOPE this root is created in (`bootstrapScope.ts`): its
   *  `target` is the workspace the root is FOR — the caller generates the ids
   *  BEFORE calling and inserts the rows AFTER, and every document is named
   *  with an id bound to that pair (`bootstrapMint.ts`), which is what lets
   *  `mintedOrphanReaper.ts` reclaim the set if the publisher never lands —
   *  and its AUTHORITY is the lease the write is fenced under: the landscape
   *  default for a new version, or `unfenced / no-forker` for a landscape being
   *  created, which has no lease-able key and says so. */
  scope: BootstrapScope,
  opts?: { starterDiagram?: boolean }
): Promise<{ rootUrl: string; documentIds: string[] }> {
  if (!scope || typeof scope.create !== 'function') {
    throw new Error('createEmptyRoot: a BootstrapScope is required (openBootstrapScope(target, authority))')
  }
  // Every created id is RETURNED — produced by the scope through the act
  // of creating, exactly like forkRoot. The publisher (landscapes.ts /
  // provisioning.ts) claims the whole set right after its INSERT INTO versions
  // — the claim cannot happen here, where no versions row exists yet (the
  // claims table derives landscape/version from it, by FK and by anti-spoof
  // design).
  const create = <T extends object>(value: T) => scope.create(repo, value)
  const rootHandle = create(emptyRoot())
  await rootHandle.whenReady()
  const modelHandle = create(emptyModelDoc())
  await modelHandle.whenReady()

  let diagrams: Record<string, unknown> = {}
  if (opts?.starterDiagram) {
    const diagramId = randomBytes(12).toString('base64url')
    const name = 'New context diagram' // matches the client's seedStarterDiagram copy
    const diagramHandle = create(starterDiagramDoc(name))
    await diagramHandle.whenReady()
    diagrams = {
      [diagramId]: {
        id: diagramId,
        name,
        type: 'context',
        docUrl: diagramHandle.url,
        objectIds: [],
        connectionIds: [],
        groupIds: [],
      },
    }
  }

  // UNCONDITIONAL (see the doc comment): a monolith sharded later by the
  // browser gets a ModelMeta with no write heads and cannot durably hold an
  // object. `buildModelMeta` makes the heads impossible to omit. The single
  // object/connection shard doubles as the persistent edits overlay (kept last
  // in its shard-url list).
  const objectShard = create({ objects: {} })
  await objectShard.whenReady()
  const connectionShard = create({ connections: {} })
  await connectionShard.whenReady()
  const metaHandle = create(buildModelMeta({
    objectWriteHead: objectShard.url,
    connectionWriteHead: connectionShard.url,
  }))
  await metaHandle.whenReady()
  const modelMetaUrl: string = metaHandle.url

  const firstShard = create({ diagrams })
  await firstShard.whenReady()
  rootHandle.change((r) => {
    const root = r as { modelUrl: string; shardUrls: string[]; modelMetaUrl?: string }
    root.modelUrl = modelHandle.url
    root.shardUrls = [firstShard.url]
    root.modelMetaUrl = modelMetaUrl
  })
  // `Repo.create()` saves through a debounced storage writer. Do not return a
  // root URL before every document it references has reached durable storage:
  // an interrupted process could otherwise persist the root first, leaving a
  // client with a valid pointer to an unavailable ModelDoc on its next boot.
  await repo.flush()
  return { rootUrl: rootHandle.url, documentIds: [...scope.createdDocumentIds] }
}

/**
 * Resolve a document the server cannot boot without — bounded, and loud when it
 * fails.
 *
 * `ensureRootDoc` returns the STORED `root_url` without checking that the
 * document is still present, and `repo.find()` on a document in neither storage
 * nor any peer never settles when a network adapter is attached and no peer is
 * connected, which is exactly the state of a server that has just bound its
 * port. Awaiting that here is the widest blast radius this failure has:
 * `startAutomergeSync` never returns, so `readModelFleet` is never assigned and
 * EVERY workspace in the process answers 503 forever, with no log line.
 *
 * Do not add `await handle.whenReady()` after it: it returns a forever promise,
 * never a rejection, for any state but `ready`, and runs after `find` resolves,
 * so no deadline on `find` bounds it.
 *
 * Throwing is deliberate: a server that cannot read its own root cannot serve
 * anything, and failing to boot with a diagnosis is better than hanging
 * silently.
 */
const BOOT_DOCUMENT_TIMEOUT_MS = Number(process.env.AM_BOOT_DOC_TIMEOUT_MS) > 0
  ? Number(process.env.AM_BOOT_DOC_TIMEOUT_MS)
  : 30_000

async function findBootDocument(repo: Repo, url: string, what: string): Promise<DocHandle<unknown>> {
  let handle: DocHandle<unknown>
  try {
    handle = await repo.find(url as AutomergeUrl, {
      signal: AbortSignal.timeout(BOOT_DOCUMENT_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(
      `Automerge ${what} ${url} could not be resolved within ${BOOT_DOCUMENT_TIMEOUT_MS} ms. ` +
      'The document is missing from storage (check automerge_storage for its chunks, and ' +
      'automerge_meta.root_url), or storage is unreachable. The server cannot serve any ' +
      'workspace without it.',
      { cause: error },
    )
  }
  if (handle.state !== 'ready') {
    throw new Error(`Automerge ${what} ${url} resolved in state "${String(handle.state)}"`)
  }
  return handle
}

/**
 * Ensure exactly one shared PRIMARY ROOT document exists and return its URL. The
 * URL is persisted in `automerge_meta` so it is stable across restarts. This is
 * the legacy single workspace, registered as the 'default' landscape's 'Main'
 * version (see ensureDefaultLandscape).
 *
 * On first boot the server also creates the ModelDoc (the sharded C4 model) and
 * stores its URL inside the root so clients can find it.
 */
export interface RootBootstrapDeps {
  getMeta(key: string): Promise<string | null>
  setMeta(key: string, value: string): Promise<void>
  /** Folds legacy `entities` rows into the root; true when it wrote anything. */
  migrate(
    repo: Repo,
    rootHandle: DocHandle<Record<string, unknown>>,
    modelHandle: DocHandle<Record<string, unknown>>,
  ): Promise<boolean>
  /** Seed the demo into a fresh root. Off for a process that must not write
   *  content into the database it boots against (the backup drill's cold server). */
  seedDemo: boolean
}

const rootBootstrapDeps: RootBootstrapDeps = {
  getMeta,
  setMeta,
  migrate: migrateEntitiesIntoRoot,
  seedDemo: process.env.DEMO_SEED !== 'off',
}

/** Exported for demoSeed.ensureRootDoc.test.ts; production passes no `deps`. */
export async function ensureRootDoc(repo: Repo, deps: RootBootstrapDeps = rootBootstrapDeps): Promise<string> {
  const existing = await deps.getMeta('root_url')
  if (existing) return existing

  // Create the root doc first (just shard list + model pointer).
  const rootHandle = repo.create(emptyRoot())
  await rootHandle.whenReady()

  // Create the model doc (the sharded C4 model — six empty collections).
  const modelHandle = repo.create(emptyModelDoc())
  await modelHandle.whenReady()

  // Create the initial empty registry shard.
  const firstShard = repo.create({ diagrams: {} })
  await firstShard.whenReady()

  // Store the model URL and the first shard URL in the root.
  rootHandle.change((r) => {
    const root = r as { modelUrl: string; shardUrls: string[] }
    root.modelUrl = modelHandle.url
    root.shardUrls = [firstShard.url]
  })

  // First-ever boot: fold any legacy `entities` data into the model doc + per-
  // diagram docs, before anyone connects, so existing workspaces carry over.
  // Pass the repo + rootHandle so migration can create additional shards when
  // the diagram count exceeds AM_SHARD_SIZE.
  const migrated = await deps.migrate(repo, rootHandle, modelHandle)
  // A fresh install gets the demo HERE, inside the unpublished root, never
  // from a browser (see demoSeed.ts for the partial seeds that caused). Not
  // after a migration: `writeWorkspaceContent` replaces whole collections, so
  // seeding over migrated groups/domains/ADRs would erase them.
  const seeded = deps.seedDemo && !migrated && await seedDemoIntoUnpublishedRoot(repo, rootHandle, modelHandle)

  // Publish the root URL only after its model and registry documents are
  // durable. See the matching flush in createEmptyRoot().
  await repo.flush()

  await deps.setMeta('root_url', rootHandle.url)
  console.log('Created shared Automerge root document', rootHandle.url, '+ model doc', modelHandle.url, seeded ? '(demo seeded)' : '')
  return rootHandle.url
}

/**
 * Bounds the server's in-memory — and therefore *announced* — document set by
 * evicting documents that are idle for `idleMs` AND have no connected peer
 * interested in them (and are neither leased nor protected).
 *
 * The peer check is the safety guarantee: unloading a doc a client still holds
 * open makes that client's `whenReady` time out, so we evict ONLY docs
 * whose per-doc synchronizer has zero active peers — a viewer always keeps its
 * docs loaded. The root is never evicted; an evicted diagram reloads from Postgres
 * on the next request. The normal workspace (a few open diagrams) never floods;
 * eviction matters only at large scale.
 *
 * Tunable via AM_IDLE_MS / AM_SWEEP_MS.
 */
export function startIdleEviction(
  repo: Repo,
  rootUrl: string,
  residency = new AutomergeResidencyLeases(repo),
  idleMs = Number(process.env.AM_IDLE_MS ?? 300_000),
  sweepMs = Number(process.env.AM_SWEEP_MS ?? 60_000)
): ReturnType<typeof setInterval> {
  const lastActive = new Map<string, number>()
  const listening = new WeakSet<object>()

  // Track a handle the first time we see it. Docs the server RECEIVES from a peer
  // do NOT fire a 'document' event, so we also lazily track them in the sweep —
  // otherwise they'd never get a lastActive entry and never be evicted. First-seen
  // counts as activity (grace before eviction); an incoming change refreshes it.
  const track = (handle: { url: string; on: (e: 'change', cb: () => void) => void }) => {
    if (!lastActive.has(handle.url)) lastActive.set(handle.url, Date.now())
    if (!listening.has(handle)) {
      listening.add(handle)
      handle.on('change', () => lastActive.set(handle.url, Date.now()))
      // Ambient, not ownership: declared so the evict-time census does not read
      // it as someone watching a document nobody leased. This runs before the
      // lease check, so leased documents carry it too.
      residency.noteAmbientListener(String((handle as { documentId?: unknown }).documentId ?? ''))
    }
  }
  repo.on('document', ({ handle }) => track(handle))

  // NOTE: do NOT `.unref()` this timer — under tsx an unref'd interval does not
  // fire. The server runs forever anyway, so keeping it referenced is fine.
  let sweeping = false
  const sweep = async () => {
    if (sweeping) return
    sweeping = true
    const now = Date.now()
    let evicted = 0
    /** Which KIND of document is being evicted, so an orphaning bug (e.g.
     * `evictedByType: { diagram: 27 }`) is self-evident in a log search. */
    const evictedByType: Record<string, number> = {}
    let skippedRecent = 0
    let skippedLeased = 0
    let skippedActivePeer = 0
    let skippedNotReady = 0
    // Diffed, because the residency counts this one: only `evict` can tell a
    // refusal-on-mismatch from any other `false`. Without it a refused document
    // lands in no bucket at all and `evicted + skipped* + 1 === handlesBefore`
    // silently stops holding.
    const staleHandleSkipsBefore = residency.staleHandleSkips()
    // ONE read of the O(n) getter produces BOTH the work list and
    // `handlesBefore`.
    const entries: Array<readonly [string, DocHandle<unknown>] | undefined> =
      Object.entries(cachedHandles(repo))
    const handlesBefore = entries.length
    const memoryBefore = process.memoryUsage()
    try {
      // `drainEntries` clears each slot before handing out the next, so the
      // snapshot never pins a document this sweep has already evicted. A plain
      // `for (const handle of Object.values(...))` would hold all n DocHandles,
      // and their WASM documents, across every `await` below (~30 s for a
      // 3 000-document sweep).
      for (const [, handle] of drainEntries(entries)) {
        if (handle.url === rootUrl) continue
        if (handle.state !== 'ready') { skippedNotReady += 1; continue }
        track(handle)
        if (now - (lastActive.get(handle.url) ?? now) <= idleMs) { skippedRecent += 1; continue }
        if (residency.isLeased(handle.documentId)) { skippedLeased += 1; continue }
        if (residency.hasActivePeers(handle.documentId)) { skippedActivePeer += 1; continue }
        try {
          // `track()` above declared this sweep's single 'change' listener as
          // AMBIENT, which is the only declaration the census takes. Do not
          // declare it again here: it would be subtracted twice and hide the
          // one-orphan case.
          const documentType = classifyAutomergeDocument(handle.doc())
          // The handle goes with the id. `evict` still looks the document up
          // (O(1)) and evicts only if what it finds IS this object:
          // between the snapshot above and this line another path may have
          // dropped the document and someone may have re-resolved it.
          if (await residency.evict(handle.documentId, handle)) {
            evicted += 1
            evictedByType[documentType] = (evictedByType[documentType] ?? 0) + 1
            lastActive.delete(handle.url)
          }
        } catch {
          /* a doc mid-transition may refuse eviction; skip it this sweep */
        }
      }
    } finally {
      sweeping = false
    }
    if (evicted > 0) {
      // Removing handles is already the bounded-memory control. Do not force
      // GC from this maintenance loop: stop-the-world collections cause
      // visible event-loop p99 spikes while clients are actively syncing.
      // V8 may collect naturally; the admin-only residency endpoint remains
      // the explicit collection seam used by endurance measurements.
      const memoryAfter = process.memoryUsage()
      console.log(JSON.stringify({
        event: 'automerge.idle_eviction',
        handlesBefore,
        // A SECOND, independent measurement -- never `handlesBefore - evicted`.
        // Deriving it would make the payload's only cross-check depend on the
        // very counter an eviction defect corrupts first: an eviction that
        // announced but did not remove would still show this number falling.
        // It is inside `if (evicted > 0)`, so an idle server never pays it.
        handlesAfter: Object.keys(cachedHandles(repo)).length,
        evicted,
        evictedByType,
        skippedRecent,
        skippedLeased,
        skippedActivePeer,
        skippedNotReady,
        skippedStaleHandle: residency.staleHandleSkips() - staleHandleSkipsBefore,
        gc: 'deferred',
        rssBefore: memoryBefore.rss,
        rssAfter: memoryAfter.rss,
        heapBefore: memoryBefore.heapUsed,
        heapAfter: memoryAfter.heapUsed,
        externalBefore: memoryBefore.external,
        externalAfter: memoryAfter.external,
      }))
    }
  }
  return setInterval(() => { void sweep() }, sweepMs)
}

/**
 * The permanent instrument on `residentHeads`, read through `/api/automerge/stats`.
 * Four scalars, never an array of samples: a per-event instrument whose memory
 * grew with the thing under test would be the subject holding its own probe.
 *
 * Each field says what it is, because two are diffable and two are not, and a
 * reader who mixes them up gets nonsense:
 *
 *   count   — monotonic. DIFF IT across two reads to get a window.
 *   totalMs — monotonic. DIFF IT; with `count`, gives the window's mean.
 *   misses  — monotonic. DIFF IT. A sustained rise alongside `count` is the
 *             EXTINCTION signature: the walk stopped resolving and every event
 *             returns undefined. Without this field, extinction shows up as
 *             `totalMs` going DOWN — the instrument moving in the reassuring
 *             direction while the subject is dead.
 *   maxMs   — SINCE PROCESS START, and NOT diffable: `max_end - max_start` is
 *             meaningless, and once a scheduler preemption lands inside the
 *             bracket it stops moving. Kept because a max is the cheapest
 *             defence against coordinated omission and it fans in correctly
 *             (max of maxes), unlike a precomputed quantile. A high-water mark,
 *             never a window.
 *
 * Cost of the instrument: two `performance.now()`, ~65 ns per event, against a
 * ~450 ns subject — ~14%. The instrument is the same order as its subject, so
 * the absolute per-access figure is mostly timer; it is still a valid
 * comparison between expressions measured the same way.
 *
 * This is a bucketless histogram in the OpenTelemetry sense (count + sum, max
 * retained). Buckets would add nothing: aggregation costs under 5 ns against a
 * ~65 ns timer, and standard duration boundaries bottom out at 5 ms, where every
 * observation here lands in bucket 0.
 *
 * If this expression ever regresses to something O(n), the access-count test
 * fails in CI and this counter is what shows it on a RUNNING server.
 */
export const syncStateLookupMetrics = { count: 0, totalMs: 0, maxMs: 0, misses: 0 }

/**
 * The heads of a document THIS PROCESS ALREADY HOLDS, in raw hex, or undefined.
 * Its own function so `automergeServer.residentHeads.test.ts` can count
 * `repo.handles` accesses against the real expression.
 *
 * 1. **It does not read `repo.handles`.** That getter rebuilds an entire
 *    `Record` per access, and the caller runs once per `sync-state` — after
 *    EVERY `generateSyncMessage` and `receiveSyncMessage`. With `--cpu-prof` at
 *    25 peers / 211 resident documents it was 4 839 ms of a 74 s profile (6.5%,
 *    the largest non-idle frame); an A/B at ~212 documents measured 41.87 µs per
 *    access for `repo.handles[id]` against 0.14 µs for this lookup (299x). The
 *    lookup reaches the same object the library's own `sync-state` listener
 *    uses, and is flat in the document count.
 * 2. **It never calls `repo.find()`.** With a network adapter attached, `find`
 *    NEVER SETTLES for a document this process does not hold — so a miss here
 *    must be a synchronous `undefined`, not a wait.
 *
 * It returns RAW HEX, which is what `sharedHeads` carries and what
 * `DocSynchronizer` compares. Mixing hex with bs58check `DocHandle.heads()`
 * makes `isCaughtUp` false for ever; reading hex on both sides avoids that and
 * the encode/decode round trip (3.2% of the same profile).
 */
export function residentHeads(repo: Repo, documentId: string): string[] | undefined {
  const started = performance.now()
  // `syncedHandle`, not a copy of its body: the rationale lives once, on the
  // seam (no casts, so `tsc` breaks if automerge-repo renames a hop instead of
  // this silently returning `undefined` forever).
  const resident = syncedHandle(repo, documentId)
  const heads = resident ? Automerge.getHeads(resident.fullDoc()) : undefined
  // The bracket closes HERE, after `getHeads`, deliberately: the property walk
  // is ~12 ns, `getHeads(fullDoc())` ~433 ns, and one `performance.now()`
  // ~33 ns. Timing the walk alone would make the timer ~85% of its own reading;
  // around the whole function it reports the cost the site actually pays.
  const elapsed = performance.now() - started
  syncStateLookupMetrics.count += 1
  syncStateLookupMetrics.totalMs += elapsed
  if (!resident) syncStateLookupMetrics.misses += 1
  if (elapsed > syncStateLookupMetrics.maxMs) syncStateLookupMetrics.maxMs = elapsed
  return heads
}

/**
 * The ownership gate's `canWrite`, held as a function so a test can drive it
 * (`ownershipWriteCheck.test.ts`) — no test boots `startAutomergeSync`, so
 * logic inside its closure would be pinned by nothing. The argument list in
 * `startAutomergeSync` that wires production placement, ownership and
 * residency remains untested here; the two-partition bench covers it.
 *
 * RESIDENCY FOLLOWS THE LIVE WORKSPACE. This is the one place that already
 * knows, for every `sync`/`request` frame, both the document's workspace and
 * whether this cell owns it; the note is synchronous and never throws, so the
 * verdict is unchanged. Without it, after a failover the new owner's projector
 * waits for a READ (measured: 170 of 301 batches unacknowledged for ~50 s).
 */
export function buildOwnershipWriteCheck(deps: {
  /** Transport-level route isolation; null when none is configured. */
  routeCheck: ((peerId: string, documentId: string) => Promise<boolean>) | null
  /** `resolveDocumentPlacement` over the doc index and the peer's route. */
  placement: (peerId: string, documentId: string) => Promise<WorkspaceKey | null>
  owns: (workspace: WorkspaceKey) => boolean
  residency: Pick<LiveWorkspaceResidency, 'noteOwnedActivity'> | undefined
}): WriteCheck {
  return async (peerId, documentId) => {
    if (deps.routeCheck && !(await deps.routeCheck(peerId, documentId))) return false
    const workspace = await deps.placement(peerId, documentId)
    const owned = workspace !== null && deps.owns(workspace)
    if (owned) deps.residency?.noteOwnedActivity(workspace)
    return owned
  }
}

/**
 * Attaches an Automerge sync peer to the existing HTTP server.
 *
 * The server is a full, durable Automerge peer: it relays sync messages between
 * every connected client and persists documents via the Postgres storage
 * adapter, so docs survive restarts and new clients catch up from here.
 * WebSocket upgrades on the `/automerge` path are handed to a `WebSocketServer`;
 * other upgrades are ignored so Express keeps owning normal HTTP.
 *
 * WS/sync auth (docs/auth-setup.md) adds, all stage-gated:
 *   - `authenticateUpgrade` runs on every `/automerge` upgrade BEFORE
 *     `wss.handleUpgrade` — stage 'on' rejects (401 + destroy) a missing/
 *     invalid session; stage 'off'/'dual' never reject (see auth/wsAuth.ts).
 *   - `ConnectionRegistry` binds the authenticated claims to the raw socket,
 *     then (via `AuthenticatedWSServerAdapter`) to the Automerge peer id once
 *     the client's `join` message arrives (see auth/wsAuth.ts).
 *   - A `WorkspaceDocIndex` (rbac/docScope.ts) resolves any doc id to its
 *     `(landscapeId, versionId)`, and `buildAccessCheck` + `stageAwareAccessCheck`
 *     compose that into the `accessCheck` passed to `createSelectiveSync`.
 *   - `shareConfig` is always used (the legacy `sharePolicy: async () => true`
 *     has no `access` gate). Its `access` hook runs the workspace route gate at
 *     every stage, because that gate writes `automerge_document_workspace`, the
 *     table the durable-heads acknowledgement reads.
 *   - `startEpochRevocation` terminates live connections whose session epoch
 *     falls behind an access-REDUCING bump (stage 'on' only; 'dual' logs); a
 *     pure grant only drops the allowed-workspace cache (ensureEpochTriggers).
 *
 * Returns the repo and the shared root document URL (clients fetch the latter via
 * `GET /api/automerge/root`).
 */
export async function startAutomergeSync(
  httpServer: Server,
  options: {
    ownership?: SyncCellOwnership
    /** Told, by the ownership gate, of every document frame on a
     * workspace this cell owns, so the read-model projector becomes resident
     * on the owner without waiting for a read (`liveWorkspaceResidency.ts`).
     * Only meaningful with `ownership.enabled`: without cells, reads are the
     * only way a workspace reaches this process and they already ensure. */
    readModelResidency?: LiveWorkspaceResidency
  } = {},
): Promise<{
  repo: Repo
  rootUrl: string
  connectionRegistry: ConnectionRegistry
  transportTelemetry: AutomergeTransportTelemetry
  storageFenceSnapshot: () => StorageFenceSnapshot
  storageFenceRejectionCount: () => number
  /** Null when no doc index is configured — which no boot does since
   * 2026-10-16 (the index is built at every stage); kept nullable for callers. */
  denyLedgerSnapshot: () => DenyLedgerSnapshot | null
  residency: AutomergeResidencyLeases
  setPinnedCoreDocument: (owner: string, documentId?: string) => void
  forgetDocumentRequests: (documentId: string) => void
  /** Stop transport admission and durably flush every accepted write. Once
   * this resolves a sync-cell lease can be released without risking a stale
   * writer, while the slower Repo teardown continues afterward. */
  drain: () => Promise<void>
  shutdown: () => Promise<void>
}> {
  const transportConfig = automergeTransportConfig()
  const transportTelemetry = new AutomergeTransportTelemetry(transportConfig)
  transportTelemetry.startStructuredLogging()
  const wss = new WebSocketServer({ noServer: true, maxPayload: transportConfig.maxPayloadBytes })

  // The adapter bundles its own copy of `ws` types; our `ws` is a different
  // (structurally identical) instance, so TS sees two `WebSocketServer` types.
  // Cast to the adapter's expected parameter type — runtime is the same object.
  type WssParam = ConstructorParameters<typeof NodeWSServerAdapter>[0]

  const stage = authStage()
  const validateSessionEpoch = sharedSessionEpochValidator(pool)
  const verifyUpgradeSession = createCachedUpgradeSessionVerifier()
  const resolveUpgradeWorkspace = getSharedWorkspaceRouteResolver(pool)
  const connectionRegistry = new ConnectionRegistry()
  // A repoint of `landscapes.default_version_id` moves an alias this resolver
  // is caching, so the next upgrade must re-read the database rather than be
  // told the old answer — and the sockets already bound to the OLD default are
  // then asked to reconnect, after a delay that outlasts the alias caches this
  // process cannot invalidate. defaultVersionRepoint.ts's header carries why
  // the drain was rejected first and what had to exist on the client before it
  // became safe.
  const repointHandler = createDefaultVersionRepointHandler({
    invalidateRoutes: (landscapeId) => resolveUpgradeWorkspace.invalidate(landscapeId),
    drainSockets: (workspace, reason) => connectionRegistry.drainWorkspace(workspace, reason),
  })
  const uninstallRepointHandler = installDefaultVersionRepointHandler(repointHandler)
  const unsubscribeOwnershipLoss = options.ownership?.enabled
    ? options.ownership.onOwnershipLost(({ workspace, reason }) => {
        const drainedSockets = connectionRegistry.drainWorkspace(
          workspace,
          'Workspace ownership moved; reconnecting',
        )
        console.warn(JSON.stringify({
          event: 'sync.cell.workspace_drained',
          reason,
          drainedSockets,
          assignedPartition: options.ownership!.partitionFor(workspace),
        }))
      })
    : null
  const workspaceRoutingRequired = process.env.AM_WORKSPACE_ROUTING === 'on' || Boolean(options.ownership?.enabled)

  // Selective sync (AM_SELECTIVE_SYNC=on, default off): announce only the CORE boot
  // docs (root + model + ModelMeta + registry shards) and serve everything else on
  // demand, instead of pushing all ~300 docs to every client on connect (a ~52s
  // boot at 20k).
  //
  // `shareConfig` is installed in EVERY configuration, not only when selective
  // sync, auth or required routing asks for it: its `access` hook is where the
  // workspace route gate runs, and the route gate is the only writer of
  // `automerge_document_workspace` on the sync path. That table is what
  // `POST /api/automerge/durable-heads` acknowledges against, so a server
  // without the gate (AUTH off, AM_WORKSPACE_ROUTING unset — `npm start`,
  // `dev:server`, `dev:boot`) answered `durable:false` for every document it
  // stored and the client badge never left "saving" (measured 2026-10-16: five
  // documents in `automerge_storage`, zero manifest rows; regression in
  // e2e/boot/new-landscape-durable.spec.ts). Every container and IaC launcher
  // already sets AM_WORKSPACE_ROUTING=on, so this is what they ran.
  //
  // `createSelectiveSync` announces only the core docs whatever
  // AM_SELECTIVE_SYNC says, which is what every auth-on or routed deployment
  // already did. The flag still selects the peer-binding behaviour: the
  // vendored automerge-repo patch reads it directly in
  // `CollectionSynchronizer.addPeer` (see server/qa/eviction-fire-drill.mjs).
  // Measured 2026-10-16 with it OFF on this code: the regression spec above
  // passes; on the previous code it stayed "saving".
  const selectiveOn = process.env.AM_SELECTIVE_SYNC === 'on'
  let rootHandle: DocHandle<unknown> | null = null

  // The doc index needs `repo` to walk doc graphs (`repo.find`), but `repo`'s
  // constructor needs `shareConfig` (which needs the doc index's access check)
  // — a circular requirement. Broken via `accessCheckRef`: `shareConfig.access/
  // announce` read through this mutable ref, which stays `null` (== "allow")
  // until it's populated just after `repo` is constructed below.
  const accessCheckRef: { current: ((peerId: string, documentId: string) => Promise<boolean>) | null } = {
    current: null,
  }
  const selective = createSelectiveSync(
    () => rootHandle,
    async (peerId, documentId) => (accessCheckRef.current ? accessCheckRef.current(peerId, documentId) : true)
  )

  const adapter = new AuthenticatedWSServerAdapter(wss as unknown as WssParam, transportTelemetry)
  adapter.setPeerCandidateBinder((peerId, socket) => connectionRegistry.bindPeer(peerId, socket))
  const configuredFenceIdleTimeoutMs = Number(process.env.AM_STORAGE_FENCE_IDLE_TIMEOUT_MS ?? 1_000)
  // No `provisionalPlacement` option here on purpose: the adapter defaults to
  // the process-wide source, which `installProvisionalPlacementSource` below
  // points at the doc index once it exists. A single install call with its own
  // seam test (like `installDenyLedgerReleaseGuard`) is used instead of another
  // ref, because no test boots this function and a ref's wiring lines would be
  // pinned by nothing.
  const storageAdapter = new PostgresStorageAdapter({
    ownership: options.ownership?.enabled ? options.ownership : undefined,
    fencedTransactionIdleTimeoutMs: Number.isFinite(configuredFenceIdleTimeoutMs)
      ? configuredFenceIdleTimeoutMs
      : 1_000,
    trackStaticReadModel: process.env.READ_MODEL === 'on',
  })
  const repo = new Repo({
    network: [adapter],
    storage: storageAdapter,
    saveDebounceRate: automergeSaveDebounceRate(),
    shareConfig: selective.shareConfig,
  })

  // The doc index needs the real repo to walk doc graphs (`repo.find`), which
  // only exists once `repo` is constructed above — hence `accessCheckRef`'s
  // indirection: `shareConfig` is wired into `repo`'s constructor before the
  // index/check can be built, so it reads through the ref instead.
  //
  // Built whatever the auth stage: see the `shareConfig` comment above — the
  // manifest the durability acknowledgement reads is written by this index.
  const docIndex = new WorkspaceDocIndex(repo, pool)
  // THE WIRE between the route gate's placement and the storage fence. The
  // fence consults it only when its own durable SELECT missed, so the mapping
  // row stays the sole operand wherever it exists; this covers the window
  // before the gate's unawaited claim lands, which is every freshly created
  // document — and `removeRange` runs through the same fence, so without it a
  // leaseless cell could delete a new document outright in that window.
  const uninstallProvisionalPlacements = installProvisionalPlacementSource(docIndex)

  // A gate that FAILS returns a bare `false`, indistinguishable downstream from
  // a real refusal — and on an indexed document the composed check classifies it
  // as a permanent RBAC denial, so it would never be re-evaluated. The gates
  // report faults here instead, and the ledger records them as recoverable.
  // Routed through a ref because the ledger is constructed below, once docIndex
  // exists.
  const gateFaultRef: { current: GateFaultReporter | null } = { current: null }
  const reportGateFault: GateFaultReporter = (peerId, documentId, workspace) => {
    gateFaultRef.current?.(peerId, documentId, workspace)
  }

  const routeCheck = docIndex
    ? buildWorkspaceRouteCheck(docIndex, connectionRegistry, workspaceRoutingRequired, {
      onFault: reportGateFault,
    })
    : null

  // The gates deny a document they cannot place and repair the index in the
  // background — they must never await that repair (see
  // scheduleWorkspaceRouteBackfill). But automerge-repo caches the share-policy
  // verdict per (document, peer) at addPeer and only recomputes it via
  // reevaluateSharePolicy, which nothing but shareConfigChanged() reaches. So
  // without this, the deny that TRIGGERED the repair would outlive it for the
  // whole connection, and the peer's changes would be discarded — a permanent
  // "document unavailable" in place of a rare hang. This closes that loop.
  //
  // Debounced deliberately: shareConfigChanged() re-runs the share policy across
  // every DocSynchronizer x every peer, which on a large workspace is hundreds
  // of synchronizers re-entering the access check. A repair burst must collapse
  // into one fan-out.
  let reevaluate: NodeJS.Timeout | null = null
  const requestSharePolicyReevaluation = (): void => {
    if (reevaluate) return
    reevaluate = setTimeout(() => {
      reevaluate = null
      try {
        repo.shareConfigChanged()
      } catch (error) {
        console.warn('[automerge] share-policy re-evaluation failed:', error)
      }
    }, 250)
    reevaluate.unref?.()
  }
  if (docIndex) docIndex.onWorkspaceIndexRepaired = requestSharePolicyReevaluation

  // The index-repaired hook above only fires when the index CHANGES. That covers
  // a deny the index later fixes; it does not cover a deny whose repair silently
  // did nothing. The ledger closes the class: a recoverable deny is recorded, and while
  // anything is outstanding a re-evaluation keeps being requested until the
  // entry drains or is written off. See rbac/denyLedger.ts.
  const denyLedger = docIndex
    ? createDenyLedger({
      onReevaluate: requestSharePolicyReevaluation,
      scheduleRepair: (key) => docIndex.scheduleWorkspaceRouteBackfill(key),
      // Bounded: this feeds a `setInterval`, and `setInterval(fn, NaN)` or a
      // blank `AM_DENY_RECONCILE_MS=` (0) would fire a global
      // `shareConfigChanged()` fan-out as fast as possible.
      reconcileMs: envNumber('AM_DENY_RECONCILE_MS', {
        fallback: 30_000, minimum: 1, maximum: 3_600_000,
      }),
    })
    : null
  /**
   * SERVICE LATENCY — how long the server takes to bring one
   * peer up to date on one document, measured where it is already observable.
   *
   * The client's own early warnings (`progressBudget`, `waiverBudget`) can only
   * be read in the tab they happened in, because this product has no
   * client->server telemetry channel. This needs none: the server is the party
   * doing the serving, and `sync-state` carries both ends of the interval.
   *
   * `caughtUp` is the SERVER's verdict and not the peer's claim: shared heads
   * covering the document's current heads. A peer that says it is caught up
   * without the exchange having happened would otherwise stop a clock that
   * never ran.
   *
   * Guarded, because an instrument on the sync hot path must never be able to
   * take the hub down: any throw here is swallowed. `automergeServiceLatency`
   * bounds its own memory and reports the bound (`overflow`).
   */
  const synchronizerEvents = repo.synchronizer as unknown as {
    on?: (event: string, listener: (payload: unknown) => void) => void
  }
  synchronizerEvents.on?.('sync-state', (payload) => {
    try {
      const message = payload as {
        peerId?: unknown
        documentId?: unknown
        syncState?: { sharedHeads?: unknown }
      }
      if (typeof message.peerId !== 'string' || typeof message.documentId !== 'string') return
      const heads = residentHeads(repo, message.documentId)
      if (!heads || heads.length === 0) return
      const shared = Array.isArray(message.syncState?.sharedHeads)
        ? (message.syncState.sharedHeads as string[])
        : []
      serviceLatency.observe(message.peerId, message.documentId, isCaughtUp(heads, shared))
    } catch {
      /* an instrument may not break the hub */
    }
  })
  adapter.denyLedger = denyLedger
  // Stop the read-model projector detaching a document whose refusal is still
  // outstanding. Its retry calls releaseUnavailableDocument on every attempt,
  // and that deletes the DocSynchronizer the lift above must traverse — so the
  // deny destroys the mechanism that would lift the deny. The polarity lives
  // inside the installer because no test boots this function. See
  // readModel/documentReleaseGuard.ts.
  const uninstallReleaseGuard = installDenyLedgerReleaseGuard(denyLedger)
  gateFaultRef.current = denyLedger
    ? (peerId, documentId, workspace) => denyLedger.recordDeny(peerId, documentId, 'gate-fault', workspace)
    : null
  // With AUTH off and routing optional nothing is enforced, as before — but the
  // route gate still RUNS for its claim into `automerge_document_workspace`,
  // the table the durable-heads acknowledgement reads. Its verdict is
  // discarded and it reports no faults, so the deny ledger never sees this
  // configuration (rbac/claimOnlyAccessCheck.ts says why a deny here would be
  // a data-loss path, not a fix).
  if (accessCheckMode(stage, workspaceRoutingRequired) === 'claim-only') {
    accessCheckRef.current = createClaimOnlyAccessCheck(
      buildWorkspaceRouteCheck(docIndex, connectionRegistry, false),
    )
  } else {
    const authCheck = stage !== 'off'
      ? stageAwareAccessCheck(
        buildAccessCheck(pool, docIndex, connectionRegistry, { onFault: reportGateFault }),
        () => authStage(),
      )
      : null
    const deniedAt = new Map<string, number>()
    const logDenied = (
      reason: 'workspace-route' | 'rbac' | 'gate-fault',
      documentId: string,
      details: Record<string, unknown> = {},
    ): void => {
      const now = Date.now()
      const key = `${reason}/${documentId}`
      if (now - (deniedAt.get(key) ?? 0) < 10_000) return
      if (deniedAt.size > 1_000) deniedAt.clear()
      deniedAt.set(key, now)
      console.warn(JSON.stringify({ event: 'sync.cell.document_access_denied', reason, documentId, ...details }))
    }
    accessCheckRef.current = createDocumentAccessCheck({
      onGateFault: reportGateFault,
      routeCheck,
      authCheck,
      workspaceForPeer: (peerId) => connectionRegistry.workspaceForPeer(peerId),
      resolveDocWorkspace: (documentId) => docIndex.resolveDocWorkspace(documentId),
      ledger: denyLedger ?? { recordDeny: () => {}, clear: () => {} },
      onDenied: (reason, documentId, details) => logDenied(reason, documentId, details),
    })
  }

  // Automerge ephemeral messages bypass durable document access checks. Keep
  // cursor presence on a separate fail-closed boundary in every auth stage.
  const presenceIdentityByUser = new Map<string, Promise<ReturnType<typeof normalizePresenceIdentity> | null>>()
  adapter.presenceGate = createDiagramPresenceGate({
    canRead: async (peerId, documentId) => (
      accessCheckRef.current ? accessCheckRef.current(peerId, documentId) : true
    ),
    identityForPeer: async (peerId) => {
      const claims = connectionRegistry.identityForPeer(peerId)
      if (claims === undefined) return null
      if (!claims) {
        return normalizePresenceIdentity({ userId: `anonymous:${peerId}`, givenName: 'Guest' })
      }
      let pending = presenceIdentityByUser.get(claims.userId)
      if (!pending) {
        pending = pool.query<{ given_name: string | null; name: string | null; email: string | null }>(
          'SELECT given_name, name, email FROM users WHERE id = $1 LIMIT 1',
          [claims.userId],
        ).then(({ rows }) => {
          const user = rows[0]
          return user
            ? normalizePresenceIdentity({
                userId: claims.userId,
                givenName: user.given_name,
                name: user.name,
                email: user.email,
              })
            : null
        }).catch((error) => {
          presenceIdentityByUser.delete(claims.userId)
          throw error
        })
        presenceIdentityByUser.set(claims.userId, pending)
      }
      return pending
    },
    onAccepted: () => transportTelemetry.recordPresenceAccepted(),
    onDropped: (reason) => transportTelemetry.recordPresenceDropped(reason === 'rate-limited'),
  })

  if (stage !== 'off' && docIndex) {

    // WRITE enforcement (the read gate above only decides what a peer may SEE;
    // automerge-repo applies inbound changes from any peer it serves). Denials
    // are throttled per (peer, doc) for the log/audit trail — a stale client
    // re-offers the same changes on every sync round, and one line a minute is
    // signal while one line per message is noise.
    const rawWriteCheck = buildWriteCheck(pool, docIndex, connectionRegistry, { onFault: reportGateFault })
    const deniedAt = new Map<string, number>()
    const DENY_LOG_THROTTLE_MS = 60_000
    adapter.writeGate = createSyncWriteGate({
      stage: () => authStage(),
      canWrite: rawWriteCheck,
      onDenied: ({ peerId, documentId, enforced }) => {
        const now = Date.now()
        const key = `${peerId}/${documentId}`
        const last = deniedAt.get(key) ?? 0
        if (now - last < DENY_LOG_THROTTLE_MS) return
        if (deniedAt.size > 1000) deniedAt.clear() // bounded — it's only a throttle
        deniedAt.set(key, now)
        const claims = connectionRegistry.identityForPeer(peerId)
        console.warn(
          `[sync-write-gate] ${enforced ? 'DROPPED' : 'dual: would drop'} change(s) from ` +
            `user=${claims?.userId ?? 'unknown'} peer=${peerId} doc=${documentId} (no write grant)`
        )
        if (claims?.userId) {
          appendAudit(pool, {
            orgId: claims.orgId ?? null,
            actorUserId: claims.userId,
            action: enforced ? 'sync.write-denied' : 'sync.write-denied-dual',
            targetKind: 'doc',
            targetId: documentId,
            detail: { peerId },
          }).catch((err) => console.warn('[sync-write-gate] audit write failed:', err))
        }
      },
    })
  }

  // The BASELINE WRITE FENCE — wired UNCONDITIONALLY, unlike every gate above:
  // RBAC's writeGate only exists at stage!=='off' and only enforces at stage
  // 'on', while the fence protects the frozen baseline of static workspaces
  // from exactly the clients that predate flags and auth stages (a stale tab,
  // an old build, a downgrade). Its verdict is a property of the DOCUMENT (SQL
  // + bounded process cache — never an Automerge document, which a gate must
  // not wait on), and a stack with no
  // static workspaces answers every message from one cached process-wide bit.
  // A drop here is a per-message MUTATION refusal, not an admission deny:
  // reads flow, nothing is pinned, no shareConfigChanged() lift is owed — the
  // client re-offers on the next sync round and its heads are simply never
  // acknowledged, which keeps its sync badge honestly on "Enregistrement…".
  {
    const fenceDeniedAt = new Map<string, number>()
    // The fence's faults deliberately do NOT feed `reportGateFault` / the deny
    // ledger. The ledger exists to LIFT a pinned share-policy deny — it keeps
    // requesting `shareConfigChanged()` (a fan-out across every DocSynchronizer
    // × every peer, every 30 s) until its entry drains via a scheduled index
    // repair. A fence fault pins nothing and has nothing to drain: the verdict
    // is consumed per message by `syncWriteGate`, so the next sync round
    // re-asks a healed pool by itself, and the fence reports no workspace, so
    // the ledger's `scheduleRepair` could not even target a backfill — the
    // entry would sit there driving pointless fan-outs until written off.
    // Log-only, throttled: the fault stays VISIBLE without feeding the
    // reconcile loop.
    const fenceFaultLoggedAt = new Map<string, number>()
    const reportFenceFault: GateFaultReporter = (peerId, documentId) => {
      if (!throttledOnce(fenceFaultLoggedAt, documentId, 60_000)) return
      console.warn(JSON.stringify({
        event: 'sync.baseline_fence.fault',
        documentId,
        peerId,
      }))
    }
    adapter.baselineWriteFence = createSyncWriteGate({
      stage: () => 'on',
      canWrite: buildBaselineWriteFence(pool, { onFault: reportFenceFault }),
      onDenied: ({ peerId, documentId }) => {
        // One line per (peer, doc) per window — pinned in both directions by
        // syncWriteGate.test.ts (`throttledOnce`): spam AND silence both fall.
        if (!throttledOnce(fenceDeniedAt, `${peerId}/${documentId}`, 60_000)) return
        const claims = connectionRegistry.identityForPeer(peerId)
        console.warn(JSON.stringify({
          event: 'sync.baseline_fence.write_denied',
          documentId,
          peerId,
          userId: claims?.userId ?? null,
        }))
        if (claims?.userId) {
          appendAudit(pool, {
            orgId: claims.orgId ?? null,
            actorUserId: claims.userId,
            action: 'sync.baseline-write-fenced',
            targetKind: 'doc',
            targetId: documentId,
            detail: { peerId },
          }).catch((err) => console.warn('[baseline-write-fence] audit write failed:', err))
        }
      },
    })
  }

  if (options.ownership?.enabled && docIndex) {
    const deniedAt = new Map<string, number>()
    adapter.ownershipGate = createSyncWriteGate({
      stage: () => 'on',
      canWrite: buildOwnershipWriteCheck({
        routeCheck,
        // Placement, by the same rule as the RBAC gates — and this gate needs it
        // MOST, because it runs FIRST in the adapter chain. `routeCheck` above
        // consults the index too, but only its PROCESS-MEMORY cache
        // (`peekDocWorkspace`) — it may not await — and it fires its claim
        // without awaiting that either. So on a cold process, or on a
        // document's first presentation, it still admits a `bound` minted id
        // that the durable table places elsewhere, and the durable read here is
        // what denies it and drops the frame.
        placement: (peerId, documentId) => resolveDocumentPlacement(
          docIndex,
          connectionRegistry.workspaceForPeer(peerId),
          documentId,
        ),
        owns: (workspace) => options.ownership!.owns(workspace),
        residency: options.readModelResidency,
      }),
      onDenied: ({ peerId, documentId }) => {
        const now = Date.now()
        const key = `${peerId}/${documentId}`
        const last = deniedAt.get(key) ?? 0
        if (now - last < 60_000) return
        if (deniedAt.size > 1_000) deniedAt.clear()
        deniedAt.set(key, now)
        console.warn(JSON.stringify({
          event: 'sync.cell.write_denied',
          reason: 'workspace-not-owned',
          ...options.ownership!.snapshot(),
        }))
      },
    })
  }

  repo.synchronizer.on('metrics', (event: {
    type?: string
    durationMillis?: number
    messageBytes?: number
  }) => {
    if (
      (event.type === 'receive-sync-message' || event.type === 'generate-sync-message')
      && typeof event.durationMillis === 'number'
    ) {
      transportTelemetry.recordSyncOperation(event.type, event.durationMillis)
    }
  })
  repo.on('doc-metrics', (event: {
    type?: string
    documentId?: string
    durationMillis?: number
    messageBytes?: number
  }) => {
    if (typeof event.durationMillis !== 'number' || event.durationMillis < 100) return
    console.warn(JSON.stringify({
      event: 'automerge.storage_cpu_slow',
      operation: event.type ?? 'unknown',
      documentId: event.documentId ?? null,
      durationMs: Math.round(event.durationMillis * 100) / 100,
      ...(typeof event.messageBytes === 'number' ? { messageBytes: event.messageBytes } : {}),
    }))
  })
  const unavailableLoggedAt = new Map<string, number>()
  repo.synchronizer.on('message', (message: { type?: string; documentId?: string }) => {
    if (message.type !== 'doc-unavailable' || !message.documentId) return
    const now = Date.now()
    if (now - (unavailableLoggedAt.get(message.documentId) ?? 0) < 10_000) return
    if (unavailableLoggedAt.size > 1_000) unavailableLoggedAt.clear()
    unavailableLoggedAt.set(message.documentId, now)
    const documentId = message.documentId as DocumentId
    const query = repo.findWithProgress(documentId)
    const state = query.peek()
    const handle = syncedHandle(repo, documentId)
    console.warn(JSON.stringify({
      event: 'automerge.document_unavailable_sent',
      documentId: message.documentId,
      queryState: state.state,
      sources: state.sources,
      handlePresent: Boolean(handle),
      heads: handle ? Automerge.getHeads(handle.fullDoc()).length : 0,
    }))
  })
  const stopBackgroundSaveErrors = observeAutomergeBackgroundSaveErrors(repo)

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const parsedRoute = parseWorkspaceRoute(request.url)
    if (parsedRoute.kind === 'not-automerge') return
    const upgradeSocket = socket as unknown as { write: (s: string) => void; destroy: () => void }
    void (async () => {
      const upgradeStartedAt = performance.now()
      let claims: SessionClaims | null = null
      let authRejection: 'stale-session-epoch' | undefined
      try {
        ;({ claims, rejection: authRejection } = await authenticateUpgrade(
          request,
          validateSessionEpoch,
          verifyUpgradeSession,
        ))
      } catch (error) {
        console.error('[automerge] upgrade authentication failed unexpectedly:', error)
        if (authStage() === 'on') {
          transportTelemetry.recordRejectedUpgrade('auth-error')
          rejectUpgrade(upgradeSocket, 503)
          return
        }
      }
      const authCompletedAt = performance.now()
      if (claims === null && authStage() === 'on') {
        transportTelemetry.recordRejectedUpgrade(authRejection ? 'stale-epoch' : 'unauthorized')
        if (authRejection) {
          console.warn(JSON.stringify({ event: 'ws-auth.upgrade_rejected', reason: authRejection }))
        }
        rejectUpgrade(upgradeSocket)
        return
      }
      if (parsedRoute.kind === 'invalid' || (parsedRoute.kind === 'legacy' && workspaceRoutingRequired)) {
        console.warn(JSON.stringify({ event: 'sync.cell.route_rejected', reason: 'missing-or-invalid' }))
        rejectUpgrade(upgradeSocket, 400)
        return
      }

      try {
        const workspace = parsedRoute.kind === 'workspace'
          ? await resolveWorkspaceRouteForUpgrade(
              pool,
              parsedRoute.workspace,
              (candidate) => Boolean(options.ownership?.enabled && options.ownership.owns(candidate)),
              resolveUpgradeWorkspace,
            )
          : null
        const workspaceCompletedAt = performance.now()
        if (parsedRoute.kind === 'workspace' && !workspace) {
          console.warn(JSON.stringify({ event: 'sync.cell.route_rejected', reason: 'unknown-workspace' }))
          rejectUpgrade(upgradeSocket, 404)
          return
        }
        if (workspace && claims && authStage() !== 'off') {
          const allowed = await allowedWorkspaceKeys(pool, claims)
          if (!allowed.has(`${workspace.landscapeId}/${workspace.versionId}`)) {
            if (authStage() === 'on') {
              console.warn(JSON.stringify({ event: 'sync.cell.route_rejected', reason: 'forbidden' }))
              rejectUpgrade(upgradeSocket, 403)
              return
            }
            console.warn(JSON.stringify({ event: 'sync.cell.route_dual_miss' }))
          }
        }
        const accessCompletedAt = performance.now()
        if (workspace && options.ownership?.enabled && !options.ownership.owns(workspace)) {
          const local = options.ownership.snapshot()
          const owner = await options.ownership.resolveOwner(workspace)
          if (request.headers[SYNC_ROUTED_HEADER] !== undefined) {
            console.warn(JSON.stringify({
              event: 'sync.cell.route_rejected',
              reason: 'route-loop',
              assignedPartition: options.ownership.partitionFor(workspace),
              localPartition: local.partitionIndex,
            }))
            rejectUpgrade(upgradeSocket, 503)
            return
          }
          console.warn(JSON.stringify({
            event: owner?.advertiseUrl ? 'sync.cell.route_proxy' : 'sync.cell.route_rejected',
            reason: owner?.advertiseUrl ? 'forward-to-owner' : 'owner-route-unavailable',
            assignedPartition: options.ownership.partitionFor(workspace),
            localPartition: local.partitionIndex,
          }))
          if (
            !owner?.advertiseUrl
            || owner.cellId === local.cellId
          ) {
            rejectUpgrade(upgradeSocket, 503)
            return
          }
          const proxied = await proxyWorkspaceUpgrade({
            request,
            socket: socket as UpgradeSocket,
            head,
            advertiseUrl: owner.advertiseUrl,
            sourceCellId: local.cellId,
          })
          console.log(JSON.stringify({
            event: 'sync.cell.route_proxy_result',
            outcome: proxied ? 'connected' : 'failed',
            assignedPartition: owner.partition,
          }))
          return
        }
        // Warm the doc index for this workspace before the first sync frame.
        // This is the ONE place a workspace walk is legal under the gate
        // liveness invariant: the peer is not a network peer yet, so the walk
        // can never be waiting on a message this connection is blocking.
        // Fire-and-forget rather than awaited — awaiting would park the
        // handshake for up to the walk deadline whenever the connecting browser
        // is the sole holder of a control document, which is a user-visible
        // cold-start stall. Gated on the durable coverage marker: a covered
        // workspace attaches with ZERO walks and zero backfills (its documents
        // were claimed at write); an uncovered or unreadable marker falls back
        // to a memoized pre-warm walk.
        if (workspace && docIndex) docIndex.preWarmWorkspaceRoute(workspace)
        wss.handleUpgrade(request, socket, head, (ws) => {
          transportTelemetry.bindSocket(ws)
          connectionRegistry.bind(ws, claims, workspace)
          // Tell the browser WHICH workspace this socket was bound to, before
          // any sync traffic. `versionId=current` is a moving pointer, so a tab
          // that reconnects after a repoint is silently re-canonicalised and
          // every document it holds earns a permanent `workspace-mismatch`.
          // Sent BEFORE `emit('connection')` so it precedes
          // the handshake in the socket's FIFO, and only for a ROUTED socket: a
          // legacy upgrade carries no workspace and has no binding to report.
          if (workspace) {
            try {
              ws.send(encodeWorkspaceBinding(workspace))
            } catch (error) {
              // Never fail an upgrade over this. The frame is a detector; a
              // client that does not receive it merely loses that detection.
              console.warn(JSON.stringify({
                event: 'sync.cell.workspace_binding_send_failed',
                landscapeId: workspace.landscapeId,
                versionId: workspace.versionId,
                error: error instanceof Error ? error.message : String(error),
              }))
            }
          }
          wss.emit('connection', ws, request)
          const completedAt = performance.now()
          const totalMs = completedAt - upgradeStartedAt
          if (totalMs >= 50) {
            console.warn(JSON.stringify({
              event: 'sync.cell.upgrade_slow',
              totalMs: Number(totalMs.toFixed(2)),
              authMs: Number((authCompletedAt - upgradeStartedAt).toFixed(2)),
              workspaceMs: Number((workspaceCompletedAt - authCompletedAt).toFixed(2)),
              accessMs: Number((accessCompletedAt - workspaceCompletedAt).toFixed(2)),
              handshakeMs: Number((completedAt - accessCompletedAt).toFixed(2)),
            }))
          }
        })
      } catch (error) {
        console.error('[automerge] workspace route resolution failed:', error)
        rejectUpgrade(upgradeSocket, 503)
      }
    })()
  })

  const rootUrl = await ensureRootDoc(repo)
  const residency = new AutomergeResidencyLeases(repo, {
    snapshot: (documentIds) => storageAdapter.residencySnapshot(documentIds),
    forget: (documentId) => storageAdapter.forgetResidency(documentId),
  })
  const inboundMessageQueue = serializeAutomergeDocumentMessages(repo.synchronizer)
  const protectedRoot = await findBootDocument(repo, rootUrl, 'workspace root')
  residency.protect(protectedRoot)

  // Under selective sync (or RBAC-enforced shareConfig), resolve the root handle
  // so the share config can derive the core doc-id set from it, and keep it fresh
  // as the root changes (clients add shards / set modelMetaUrl). Without this the
  // core set stays empty → nothing is announced (clients can still find()
  // everything they're allowed to, but get no proactive boot docs).
  if (selective) {
    rootHandle = await findBootDocument(repo, rootUrl, 'workspace root (shareConfig)')
    selective.refresh()
    rootHandle.on('change', () => {
      selective.refresh()
      repo.shareConfigChanged()
    })
    console.log(
      `Automerge shareConfig active (selectiveSync=${selectiveOn ? 'on' : 'off'}, authStage=${stage}) — announcing`,
      selective.coreIds().length,
      'core doc(s)'
    )
  }

  const forgetDocumentRequests = (documentId: string): void => {
    ;(repo.synchronizer as unknown as {
      forgetDocumentRequests?: (retiredDocumentId: string) => void
    }).forgetDocumentRequests?.(documentId)
  }

  const setPinnedCoreDocument = (owner: string, documentId?: string): void => {
    if (!selective) return
    const previousDocumentId = selective.setPinnedCore(owner, documentId)
    if (previousDocumentId && previousDocumentId !== documentId) {
      forgetDocumentRequests(previousDocumentId)
    }
    repo.shareConfigChanged()
    console.log(JSON.stringify({
      event: 'automerge.selective_core_pin',
      owner,
      documentId: documentId ?? null,
      retiredDocumentId: previousDocumentId && previousDocumentId !== documentId
        ? previousDocumentId
        : null,
      coreDocuments: selective.coreIds().length,
    }))
  }

  // Epoch revocation: LISTEN + poll for org auth_epoch bumps, terminating stale
  // connections. Runs at every stage != 'off' for observability (stage 'dual'
  // logs, never terminates — see wsAuth.ts); stage 'off' skips it entirely
  // (zero behavior change, zero extra Postgres connection).
  const epochRevocation = stage !== 'off'
    ? startEpochRevocation(pool, connectionRegistry, {
        onWorkspaceAccessChanged: () => invalidateAllowedWorkspaceKeysCache(),
        onEpochBumped: (orgId, userId) => validateSessionEpoch.forget(orgId, userId),
        onGlobalEpochBumped: (userId) => validateSessionEpoch.forgetGlobal(userId),
      })
    : null

  // Cross-process invalidation for the per-process caches that otherwise lie
  // for up to their TTL across sibling processes. The canonical route resolver
  // is shared with HTTP for this pool. COMFORT, not a dependency: a process
  // whose LISTEN drops merely returns to TTL-bounded staleness — the route gate
  // and the denyLedger remain
  // the correctness net. Routing also needs this listener when AUTH is off.
  const workspaceCacheInvalidation = docIndex || workspaceRoutingRequired
    ? startWorkspaceCacheInvalidation(pool, {
        onCoverageChanged: dropWorkspaceCoverageLocally,
        onVersionCreated: (landscapeId) => docIndex?.noteRemoteVersionCreated(landscapeId),
        onRouteChanged: (landscapeId) => {
          if (landscapeId === null) resolveUpgradeWorkspace.invalidateAll()
          else resolveUpgradeWorkspace.invalidate(landscapeId)
        },
      })
    : null

  // The doc index watches control documents it does not lease, so eviction
  // would otherwise orphan the listeners that make client-created documents
  // servable. Attach here rather than in the constructor: `docIndex` is built
  // well before `residency` exists. Must precede startIdleEviction so no sweep
  // can run before the index is following it.
  const untrackDocIndexResidency = docIndex?.trackResidency(residency) ?? null

  // Peer-aware + lease-aware eviction. Projectors pin only live listener docs,
  // so READ_MODEL no longer turns eviction off for the entire repository.
  const idleEviction = Number(process.env.AM_IDLE_MS ?? 300_000) > 0
    ? startIdleEviction(repo, rootUrl, residency)
    : null
  console.log(
    `Automerge sync peer attached on ws path /automerge (workspaceRouting=${workspaceRoutingRequired ? 'required' : 'optional'}); root =`,
    rootUrl,
  )
  let draining: Promise<void> | null = null
  const drain = (): Promise<void> => {
    if (draining) return draining
    draining = (async () => {
      unsubscribeOwnershipLoss?.()
      untrackDocIndexResidency?.()
      denyLedger?.stop()
      // The guard closes over THIS ledger; leaving it installed past teardown
      // would let a dead ledger answer for the next server in the same process.
      uninstallReleaseGuard()
      // Same reasoning, same shape: this source closes over THIS doc index, and
      // a dead index naming workspaces for the next server's documents would
      // fence writes against leases nobody in that process holds.
      uninstallProvisionalPlacements()
      // And again: this handler closes over THIS resolver, so leaving it
      // installed would invalidate a cache belonging to a server that is gone.
      // Its armed drains close over THIS registry too, and they outlive the
      // announcement by seconds — uninstalling alone would leave a timer that
      // fires into a torn-down server. The handle is unref'd, so this is about
      // correctness, not about the process staying up.
      uninstallRepointHandler()
      repointHandler.stopPendingDrains()
      if (reevaluate) clearTimeout(reevaluate)
      if (idleEviction) clearInterval(idleEviction)
      transportTelemetry.stop()
      await drainAutomergeResources({
        stopEpochRevocation: () => epochRevocation?.stop(),
        stopWorkspaceCacheInvalidation: () => workspaceCacheInvalidation?.stop(),
        wss,
        drainResidency: () => residency.drain(),
        restoreInboundQueue: () => inboundMessageQueue.restore(),
        flush: () => repo.flush(),
      })
    })()
    return draining
  }
  let shuttingDown: Promise<void> | null = null
  const shutdown = (): Promise<void> => {
    if (shuttingDown) return shuttingDown
    shuttingDown = runShutdownSteps('Automerge shutdown', [
      { name: 'drain', run: drain },
      { name: 'repo shutdown', run: () => repo.shutdown() },
      { name: 'background save observer', run: stopBackgroundSaveErrors },
    ])
    return shuttingDown
  }
  return {
    repo,
    rootUrl,
    connectionRegistry,
    transportTelemetry,
    storageFenceSnapshot: () => storageAdapter.snapshot(),
    storageFenceRejectionCount: () => storageAdapter.readRejectedMutationCount(),
    /** Outstanding recoverable denials. `outstanding` returning to 0 after a
     * workspace settles is the observable proof that the pairing invariant is
     * holding; a number that only grows means denials are being recorded that no
     * repair can reverse, i.e. the classification is wrong. */
    denyLedgerSnapshot: () => denyLedger?.snapshot() ?? null,
    residency,
    setPinnedCoreDocument,
    forgetDocumentRequests,
    drain,
    shutdown,
  }
}
