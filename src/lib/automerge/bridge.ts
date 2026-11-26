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

import type { AutomergeUrl, DocHandle, DocHandleChangePayload, DocumentId } from '@automerge/automerge-repo'
import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import { decodeChange, getActorId, getAllChanges, getHeads } from '@automerge/automerge'
import { useModelStore } from '../../stores/modelStore'
import { undoHistory } from '../history/undoHistory'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import {
  repo,
  getRootHandle,
  getModelHandle,
  getRegistryShardHandles,
  createRegistryShardHandle,
  findDiagramHandle,
  createDiagramHandle,
  findModelMetaHandle,
  createObjectShardHandle,
  createConnectionShardHandle,
  getModelShardHandles,
  findHeldModelShardHandle,
  findHeldRegistryShardHandle,
  isMintedDocumentId,
  forgetWorkspace,
  forgetWorkspaceHandles,
  routeWorkspaceNetwork,
  activeDocumentShare,
  prepareDocumentRequest,
  releaseDocumentRequest,
  cachedRootUrlFor,
  lastAttemptedRootUrlFor,
  preferCachedRootForNextResolve,
  abandonPreferredCachedRoot,
  BOOT_DOCUMENT_RESOLUTION,
} from './repo'
import {
  startMintedIdSupply,
  stopMintedIdSupply,
  notifyMintedIdSupplyOnline,
  notifyMintedIdSupplyHostReachable,
  noteMintedIdSupplyWorkspace,
  ensureMintedIdCapacity,
} from './mintedIdSupply'
import { CURRENT_VERSION_ID, DEFAULT_WORKSPACE_REF, currentWorkspaceRef, isDefaultWorkspaceRef, workspaceRefEquals, workspaceRefKey, type WorkspaceRef } from './workspace'
import {
  adoptBindingAsBasis,
  documentsWorkspaceFor,
  forgetResolvedWorkspace,
  holdWorkspaceOn,
  installSessionRootUrlSource,
  installWorkspaceBindingHandler,
  redeliverWorkspaceBinding,
  resolvedWorkspaceFor,
  type WorkspaceBinding,
} from './workspaceBinding'
import { applyCollectionReconcile, planCollectionReconcile, reconcile, reconcileIsNoop } from './reconcile'
import { clearedOverlayEditsToRestore, mergeStoredRescues, rescuePatch, storeForm, type StoredOverlayRescue } from './overlayClearRescue'
import { ResidentPendingWrites } from './residentPendingWrites'
import { createResidentDebtDriver, type ResidentDebtAttempt, type ResidentDebtDriver, type ResidentDebtDriverState } from './residentDebtDriver'
import { BootLocalEdits } from './bootLocalEdits'
import {
  COLLECTION_SCHEMAS,
  CONNECTION_SCHEMA,
  C4_OBJECT_SCHEMA,
  DECISION_RECORD_SCHEMA,
  DIAGRAM_DOC_SCHEMA,
  DIAGRAM_META_SCHEMA,
  ENTITY_SCHEMAS,
  ROOT_MODEL_SCHEMA,
  type EntityCollection,
} from './knownKeys'
import {
  ENTITY_FAMILIES,
  ENTITY_FAMILY_BY_NAME,
  MODEL_META_INLINE_COLLECTIONS,
  MONOLITH_COLLECTIONS,
  entityKeyOf,
} from './entityFamilies'
import { applyDiagramViewFields, classifyDiagramViewEdit, ScopeEditTracker, setObjectScopesForReconcile, withObjectScopesAtBirth } from './diagramViewWrite'
import { syncModelIndex, resetModelIndexSync, applyOffWindowEditsToIndex, notifyServerInvalidation } from '../modelQuery/indexSync'
import { isBootFromServerEnabled } from '../modelQuery/flag'
import { isServerReadModelEnabled } from '../modelQuery/tierFlag'
import { setWorkspaceSummaryActive } from '../modelQuery/summaryTier'
import { fetchDurabilityWitness } from '../modelQuery/server'
import { isIndexReady } from '../modelQuery/offlineIndex'
import { getModelQuery } from '../modelQuery'
import {
  fetchDiagramRender,
  fetchDiagramDocHeads,
  fetchRegistryHasDiagram,
  readCachedDiagramRender,
  type DiagramRenderResult,
} from '../modelQuery/diagramRender'
import { fetchDiagramMeta, type DiagramBootstrap } from '../modelQuery/diagramMeta'
import { fetchDiagramListPage } from '../modelQuery/diagrams'
import { buildLocalDiagramRender } from '../modelQuery/diagramRenderLocal'
import { publishAfterDurableFlush } from './durableReferences'
import { MODEL_SHARD_SIZE, SHARD_SIZE } from './shardSizes'
import {
  DeferredReferenceQueue,
  ServerDurabilityWaiters,
  isModelShardReferenceField,
  type DeferredReference,
} from './deferredReferences'
import { subscribeCurrentWorkspaceInvalidations } from '../modelQuery/workspaceInvalidation'
import { workspaceKvStore, type KvStore } from '../modelQuery/kvStore'
import { withWorkspaceParams } from '../modelQuery/workspaceParams'
import { apiFetch } from '../api/http'
import { stripUndefined } from './docSafe'
import { scheduleDeferredOverlayHydration } from './deferredOverlayHydration'
import { runDiagramFirstPaintPipeline, waitForVisualCommit } from './diagramOpenPipeline'
import { persistentSlicesChanged } from './persistentSlices'
import { resolveReadyHandleWithRetry } from './handleRetry'
import {
  DocumentPermanentlyUnavailableError, DocumentTemporarilyUnavailableError, isRetryableDocumentResolutionError,
} from './documentResolution'
import { shouldFallBackToCachedRoot, WorkspaceRootUnreachableError } from './rootFetchPolicy'
import { GroupEditOverlay } from './groupEditOverlay'
import { LocalDiagramHold } from './localDiagramHold'
import { UnpublishedDiagramDocs } from './unpublishedDiagramDocs'
import { mergeOverlaySegments, updateOverlaySegment } from './overlayPrecedence'
import {
  planBfsWriteMode,
  planOverlayWriteHeads,
  shouldRotateOverlayWriteHead,
  type BfsWriteMode,
} from './overlayWriteHead'
import {
  changedDecisionRecords,
  shouldProjectInlineDecisionRecords,
  usesDecisionRecordDelta,
} from './decisionRecordDelta'
import { overlayRecordsToReseed } from './decisionRecordOverlayReseed'
import { markClientTimeline, startClientTimelineMeasure } from '../observability/clientTimeline'
import { PlacementWriteScheduler, type WriteKind } from './placementWriteScheduler'
import { createEpochHop, type EpochHop, type EpochHopOptions, type EpochHopPorts, type HopAcknowledgement, type HopDocumentHeads, type RetainToken } from './epochHop'
import {
  ANSWER_EXPIRED, ANSWER_REFUSED, createRepointProbeScheduler, EPOCH_LINEAGE_KEY, EPOCH_LINK_GONE, holdsTargets, hopUnaccounted, isExpiredSession, isPermanentRefusal,
  lifecycleFlushPlan, nextEpochCapability, predecessorIdOf, repointAction, retryUntilAnswered, UNMINTED_RETRY_DELAYS_MS,
  walkEpochLineage, withLineageLinks, type EpochLineage,
} from './epochBridgeRules'
import { runAtomically, unpublishedShards, withCarried } from './epochSwap'
import { collectRetiredDifferences, type RetiredExport } from './epochRetiredDiff'
import { loadRetiredExport, mergeRetiredExports, persistRetiredExport } from './epochRetiredExportStore'
import { useEpochHopStore } from '../../stores/epochHopStore'
import {
  acknowledgeDurableDocumentHeads,
  changeWithDurabilityTracking as changeAndTrack,
  DurableHeadLedger,
  type DurableHeadSnapshot,
  durableConnectionStatus,
  mergeDurableHeadSnapshots,
  pendingDurabilityDebts,
  setLocalDocumentChangeListener,
  setEpochCapabilityListener,
  withChangeMessage,
} from './durableSync'
import { installEpochOverrides, refreshOverrides } from './epochOverridesController'
import { isReapplyMessage } from './epochOverrides'
import { useEpochOverridesStore } from '../../stores/epochOverridesStore'
import {
  applyDurableVerdicts,
  DeniedDocumentRecovery,
  resetDocumentSyncState,
} from './deniedDocumentRecovery'
import {
  applyPlacementSnapshotToDiagramDoc,
  flushPlacementIntentPersistence,
  hydratePlacementIntents,
  isDiagramDocPlacementRecord,
  pendingPlacementIntents,
  persistPlacementIntents,
  persistPlacementIntentsNow,
  type PlacementIntentSnapshot,
} from './placementIntents'
import { isLowerConnectionId } from '../diagrams/lowerRouting'
import { DiagramCollectionCapture, planDiagramCollectionAck } from './diagramCollectionCapture'
import {
  DiagramStubCapture,
  diagramStubOf,
  planDiagramStubAck,
  planDiagramStubReplay,
} from './diagramStubCapture'
import { planDiagramTombstones } from './diagramTombstonePlan'
import {
  observeRegistryAbsence,
  planDiagramAbsenceSweep,
  type DiagramAbsenceObservation,
} from './diagramAbsenceRetirement'
import {
  createOverlayBatchId,
  hydrateOverlayBatchJournal,
  overlayBatchJournal,
  persistOverlayBatchJournal,
  type OverlayBatchTerminalStatus,
} from './overlayBatchJournal'
import {
  DIAGRAM_COLLECTION_INTENT_KINDS,
  SMALL_COLLECTION_INTENT_KINDS,
  deepEqualPlain,
  flushEntityIntentPersistence,
  forgetIntentsOnceDurable,
  hydrateEntityIntents,
  isDiagramCollectionKind,
  isEntityPlannerKind,
  isSmallCollectionKind,
  pendingEntityIntents,
  persistEntityIntents,
  persistEntityIntentsNow,
  planDiagramCollectionIntentReplay,
  planEntityIntentReplay,
  planSmallCollectionIntentReplay,
  schedulePersistEntityIntents,
  splitResidentPlannableIntents,
  type DiagramCollectionIntentKind,
  type EntityIntentKind,
  type SentCarrier,
  type SmallCollectionIntentKind,
} from './entityIntents'
import { syncedHandle } from './repoCompat'
import { SmallCollectionCapture, planSmallCollectionAck } from './smallCollectionCapture'
import {
  sliceToRootModel,
  mergeShards,
  stripDeletedFromComposition,
  type DiagramComposition,
  resolveDiagramProjection,
  diagramDocComments,
  diagramDocFlows,
  diagramToDiagramDoc,
  mergeObjectShards,
  mergeConnectionShards,
} from './projection'
import { isModelShardingEnabled, setModelSharding } from './shardingFlag'
import { planShardAssignment, partitionByShard } from './shardRouting'
import { planRegistryWrites } from './registryWritePlan'
import {
  resolveOptionalRegistryWriteHead,
  resolveSummaryRegistryInitialDiagram,
  type OptionalRegistryWriteHeadResult,
} from './summaryRegistryBootstrap'
import { recoverWorkspaceProjection } from './workspaceProjection'
import { generateRichWorkspace, type RichSeedOptions } from '../devSeed/richWorkspace'
import type {
  RootDoc,
  ModelDoc,
  DiagramDoc,
  DiagramMeta,
  RegistryShard,
  ModelMeta,
  ObjectShard,
  ConnectionShard,
} from './types'
import type {
  Diagram,
  Comment,
  Flow,
  C4Object,
  Connection,
  Group,
  Domain,
  Tag,
  DecisionRecord,
} from '../../types'
import { appendMetaUrl, readMetaUrl, readMetaUrls, withMetaUrlView, writeMetaUrls } from './modelMetaUrls'

/**
 * The bridge between the Zustand model store (which the canvas/UI read & write)
 * and the Automerge documents (the system of record + real-time sync).
 *
 *  - READ  (Automerge → store): on any doc change, project the root model + the
 *    active diagram's view into the store, wrapped in `applyingRemote` so it does
 *    not bounce back out as a local edit.
 *  - WRITE (store → Automerge): on local store changes (debounced), reconcile the
 *    store into the model doc + the registry shards + the active diagram doc.
 *
 * Registry sharding: the root doc holds only `modelUrl` and `shardUrls` (an
 * ordered list of RegistryShard doc URLs). Each shard holds up to SHARD_SIZE
 * DiagramMeta entries. The full registry = union of all shards' `diagrams` maps.
 *
 * `currentDiagramId` is intentionally NOT stored in any doc — each browser can
 * view a different diagram. Changing it lazily loads that diagram's doc.
 */

/** Slow recovery poll for environments where SSE is unavailable or an
 * invalidation is lost. Normal live refresh is driven by workspace push. */
const LIVE_SYNC_FALLBACK_MS = 60_000

// Registry / model shard capacities: shardSizes.ts (shared with the import's
// minted-id budget).

/** Bound each offline edits document. A segment rotates after this many unique
 * entities or local write batches; compaction folds all segments oldest→newest. */
const OVERLAY_SEGMENT_SIZE = Math.max(8, Number(
  import.meta.env.VITE_OVERLAY_SEGMENT_SIZE ?? 32,
))

let started = false
// The workspace (landscapeId,versionId) this bridge session is bound to. One
// workspace at a time today; a future switch = stopBridge() then startBridge(ref).
let currentRef: WorkspaceRef = DEFAULT_WORKSPACE_REF
let applyingRemote = false
let rootHandle: DocHandle<RootDoc> | null = null
let modelHandle: DocHandle<ModelDoc> | null = null
let activeDiagramId: string | null = null
let activeDiagramHandle: DocHandle<DiagramDoc> | null = null
const activeDiagramHandleListeners = new Set<(handle: DocHandle<DiagramDoc> | null) => void>()
let storeUnsub: (() => void) | null = null
let rootChangeHandler: (() => void) | null = null
let modelChangeHandler: (() => void) | null = null
let activeChangeHandler: (() => void) | null = null
// `scheduleWrite` optimistically shows "saving" the moment a write is requested,
// but `flushWrite` has several paths that legitimately produce NOTHING durable —
// the guard at its head returns early when there is no monolith and no sharded
// ModelMeta, and boot-from-server never writes model shards at all. On those
// paths no handle reaches `trackDurableHandle`, so the durable-ack loop is never
// re-armed (it only re-arms itself while `durableHeads.size > 0`) and the badge
// would stay on "Saving…" forever (notably under bootFromServer). Re-evaluating after every
// flush closes that gap: with an empty ledger `runDurableAcknowledgement` simply
// reports `ready`, and with a non-empty one it does the acknowledgement it was
// always going to do.
const writeScheduler = new PlacementWriteScheduler(() => {
  // The epoch hop's latch (`epochHop.ts`, step 4): writes are PAUSED between the one
  // flush it runs and the swap. A request in that window is remembered and
  // re-armed on resume, so it lands on whichever epoch is current then.
  if (writesPausedByHop) {
    writeDeferredByHop = true
    writesDeferredByLatch += 1
    return
  }
  try {
    flushWrite()
  } finally {
    scheduleDurableAcknowledgement(0)
    armHeldDeletionRetry()
  }
})

/**
 * T-DIAGDEF-2: the debt the badge now counts for a WHOLE-MODEL
 * diagram delete no document holds (`pendingDurabilityCount`) needs an engine
 * of its own: the hold is released only by a flush that finds the registry
 * complete, and nothing asked for one when the missing shard came back —
 * Saving until some unrelated edit. A flush that leaves held deletions arms
 * one more write, backing off from 2 s to 30 s; any flush re-evaluates, and
 * none is armed under boot-from-server (its intent journal has its own
 * replays) or a frozen contract (no write can express it; the banner asks
 * for the reload).
 */
const HELD_DELETION_RETRY_MIN_MS = 2_000
const HELD_DELETION_RETRY_MAX_MS = 30_000
let heldDeletionRetryTimer: ReturnType<typeof setTimeout> | null = null
let heldDeletionRetryMs = HELD_DELETION_RETRY_MIN_MS
/** Retries fired this EPISODE (from a held deletion until none is held, or
 * the session ends), and whether its 30 s cadence was reported. */
let heldDeletionRetriesFired = 0
let heldDeletionRetryCeilingReported = false

function clearHeldDeletionRetry(): void {
  if (heldDeletionRetryTimer) clearTimeout(heldDeletionRetryTimer)
  heldDeletionRetryTimer = null
  heldDeletionRetryMs = HELD_DELETION_RETRY_MIN_MS
  heldDeletionRetriesFired = 0
  heldDeletionRetryCeilingReported = false
}

/** TEST-ONLY: the held-deletion retry's state. Production never calls this. */
export function __heldDeletionRetryForTest(): { armed: boolean; nextDelayMs: number; fired: number } {
  return { armed: heldDeletionRetryTimer !== null, nextDelayMs: heldDeletionRetryMs, fired: heldDeletionRetriesFired }
}

function armHeldDeletionRetry(): void {
  if (!started || bfsActive || workspaceContractStale || localDiagramHold.heldDeletions === 0) {
    clearHeldDeletionRetry()
    return
  }
  if (heldDeletionRetryTimer) return
  const epoch = durableAckEpoch
  const delay = heldDeletionRetryMs
  heldDeletionRetryMs = Math.min(heldDeletionRetryMs * 2, HELD_DELETION_RETRY_MAX_MS)
  // Reported once an episode when the cadence reaches its ceiling: a shard
  // that stays unresolved keeps this at one cheap flush every 30 s, for as
  // long as the badge says Saving — never silently.
  if (delay === HELD_DELETION_RETRY_MAX_MS && !heldDeletionRetryCeilingReported) {
    heldDeletionRetryCeilingReported = true
    console.warn(`[bridge] ${localDiagramHold.heldDeletions} diagram delete(s) no registry shard could express yet; `
      + `retrying every ${HELD_DELETION_RETRY_MAX_MS / 1000} s while the badge shows them unsaved`)
  }
  heldDeletionRetryTimer = setTimeout(() => {
    heldDeletionRetryTimer = null
    if (epoch !== durableAckEpoch || localDiagramHold.heldDeletions === 0) return
    heldDeletionRetriesFired += 1
    scheduleWrite('normal')
  }, delay)
}
/** Set by the epoch hop's latch (`flushAndPauseWrites`), cleared by `resumeWrites`. */
let writesPausedByHop = false
let writeDeferredByHop = false
let pendingNormalWrite = false
/** Diagrams whose only pending durable change is a VIEW field
 * (`diagramViewWrite.ts`). Drained by flushWrite's targeted branch when the
 * diagram is the active one and no full write is pending. */
let pendingViewDiagramIds = new Set<string>()
let switching: Promise<void> | null = null
let netCleanups: Array<() => void> = []
let serverProjectionRequestSequence = 0
let lastAppliedServerProjectionRequest = 0
const durableHeads = new DurableHeadLedger()
/** The debt of the last stopped session (see `stopBridge`), taken by the
 * workspace switch that stopped it. */
let stoppedSessionDebt: StoppedSessionDebt | null = null

export interface StoppedSessionDebt {
  ref: WorkspaceRef
  documents: DurableHeadSnapshot[]
}

/** The documents the session `stopBridge` just ended still owed its server,
 * with their frontiers — once: a second call answers null. */
export function takeStoppedSessionDurableDebt(): StoppedSessionDebt | null {
  const debt = stoppedSessionDebt
  stoppedSessionDebt = null
  return debt
}
/** Pointers held back until the server acknowledges the document they name
 *  (deferredReferences.ts). The waiters live for one session, like the ledger
 *  that feeds them; the queue is persisted per workspace and resumed at boot. */
const serverDurability = new ServerDurabilityWaiters()
const deferredReferences = new DeferredReferenceQueue(() => workspaceKvStore())
/** Re-presents documents the sync gate refused. Bookkeeping lives beside the
 *  ledger because the ledger IS the "authored and not yet durable" set — the
 *  only population this may ever touch. See deniedDocumentRecovery.ts. */
const deniedRecovery = new DeniedDocumentRecovery()
let syncTransportConnected = false
/** EVIDENCE that the server cannot be reached: this session's render fetch
 *  failed at the network level. Distinct from `!syncTransportConnected`, which
 *  is also the state of every boot before its end — online ones included — so
 *  it cannot tell "offline" from "not finished booting" (review,
 *  2026-10-16). Set only by `loadDiagramRenderForProjection`; cleared by any
 *  connected transition (`setDurableConnectionState(true)`) and by `startBridge`. */
let serverUnreachable = false

/** A failure that says the server was not REACHED — the fetch never got an HTTP
 *  answer (`TypeError`) or ran out of time. An HTTP error status, or a payload
 *  that failed validation, came from a live server. */
function isServerUnreachableError(error: unknown): boolean {
  if (error instanceof TypeError) return true
  return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')
}
let durableAckTimer: ReturnType<typeof setTimeout> | null = null
let durableAckInFlight = false
let durableAckFollowUp = false
let durableAckEpoch = 0

const DURABLE_ACK_DEBOUNCE_MS = 180
const DURABLE_ACK_RETRY_MS = 750
const DURABLE_ACK_BATCH_SIZE = 48
const DURABLE_HEAD_LEDGER_KEY = 'pending-durable-heads:v1'
let durableLedgerPersistence: Promise<void> = Promise.resolve()
/** The session (`durableAckEpoch`) whose `durableHeads` has absorbed the
 *  persisted ledger. Only that session's snapshot is the WHOLE set. */
let durableLedgerHydratedEpoch = -1
/** The store the ledger of the session started last lives in, taken when it
 *  started. `workspaceKvStore()` follows the ACTIVE workspace, and the active
 *  workspace can move before the session stops: the auth-on rebound in
 *  startBridge's catch resolves (and activates) its fallback, THEN stops — and
 *  that stop wrote the failed workspace's ledger over the fallback's
 *  (found by a probe, 2026-10-31). */
let durableLedgerStore: KvStore | null = null

function durableLedgerHydrated(): boolean {
  return durableLedgerHydratedEpoch === durableAckEpoch
}

function queueDurableLedgerPersistence(): void {
  const store = durableLedgerStore ?? workspaceKvStore()
  // Dormant entries included: they wait for their version to come back.
  const snapshot = durableHeads.persisted()
  // Before this session has read the persisted ledger, its snapshot holds only
  // what it marked since `startBridge` cleared it, so writing it as THE ledger
  // deletes what earlier sessions left. Measured 2026-10-31: StrictMode's
  // remount stopped the first boot mid-read, the stop's empty snapshot deleted
  // the key, and an offline-created DiagramDoc was never re-presented while the
  // badge said ready. Until the read, a write may only add.
  const replace = durableLedgerHydrated()
  durableLedgerPersistence = durableLedgerPersistence
    .catch(() => undefined)
    .then(async () => {
      if (replace) {
        if (snapshot.length > 0) await store.set(DURABLE_HEAD_LEDGER_KEY, snapshot)
        else await store.del(DURABLE_HEAD_LEDGER_KEY)
      } else if (snapshot.length > 0) {
        // A read then a write, not `store.update`: idb-keyval's update settles
        // only from its read's `onsuccess`, so a failed read left it — and this
        // chain, which the next boot's hydration awaits — pending for ever
        // (seen with a fake-indexeddb probe). The chain already serializes
        // this tab's writes; across tabs the replace above is no more atomic.
        const persisted = await store.get<unknown>(DURABLE_HEAD_LEDGER_KEY)
        await store.set(DURABLE_HEAD_LEDGER_KEY, mergeDurableHeadSnapshots(persisted, snapshot))
      }
    })
    .catch((error) => {
      console.warn('pending PostgreSQL durability ledger persistence failed', error)
    })
}

/**
 * Read the persisted ledger and WITHHOLD every entry — not pin it. The ledger
 * hydrates its entries DORMANT (`DurableHeadLedger.dormant`): which of them
 * belong to this session is known only once the root resolution names its
 * workspace (`partitionDurableLedger`), and until then none may reach the
 * socket — the server announces its root's core documents, registry shards
 * included, to every peer. That is why startBridge awaits this BEFORE routing
 * the network. Measured 2026-10-31: pinned here, a `current` tab's reload sent
 * the OLD version's offline edits on the NEW version's socket 30 ms after the
 * handshake, and the old version's registry gained the offline diagram.
 */
async function hydrateDurableLedger(epoch: number, store: KvStore): Promise<void> {
  await durableLedgerPersistence.catch(() => undefined)
  const entries = await store.get<unknown>(DURABLE_HEAD_LEDGER_KEY)
  // `durableHeads` is module state: a session stopped during the read must
  // leave it to the session that replaced it.
  if (epoch !== durableAckEpoch) return
  durableHeads.hydrate(entries)
  durableLedgerHydratedEpoch = epoch
  activeDocumentShare.withhold(durableHeads.dormantEntries().map(({ documentId }) => documentId))
}

/** The placement journal's hydration, for the carry (`carryRepointedWork`) to
 * await: startBridge's own handle on it is local. Session state. */
let placementIntentHydration: Promise<void> = Promise.resolve()

/** How long the carry asks the old version (`carryRepointedWork`) before it
 * treats every record as unknown — carried, conflict-averse. */
const REPOINT_CARRY_ASK_TIMEOUT_MS = 10_000

/**
 * The root resolution named the workspace this session's documents belong to.
 * Split the hydrated (dormant) ledger by the workspace each document was
 * marked under:
 *
 *  - this workspace, or untagged → activate, lift the withhold, pin,
 *    re-present: what every boot did before the tag existed;
 *  - ANOTHER workspace → the default moved while those changes were unsent.
 *    They stay DORMANT and withheld: presented neither to the old version
 *    (which would split the work) nor to the new one (which would claim the
 *    old version's documents), not counted, and persisted — so that if the
 *    default ever comes back to their version, this same partition activates
 *    them there. The work they carried goes back into the journals for this
 *    workspace (`carryRepointedWork`), where the ordinary replays write it
 *    into this workspace's documents. That is the product decision of
 *    2026-10-31: unsynced work follows `current`.
 *
 * A session that cannot name its workspace (`documentsWorkspaceKey()` null)
 * keeps the old behaviour for everything: it cannot tell what moved.
 */
function partitionDurableLedger(): void {
  const booted = documentsWorkspaceKey()
  const local: DocumentId[] = []
  for (const { documentId, workspace } of durableHeads.dormantEntries()) {
    const elsewhere = booted !== null && typeof workspace === 'string' && workspace !== booted
    if (!elsewhere) local.push(documentId)
  }
  durableHeads.activate(local)
  activeDocumentShare.release(local)
  for (const documentId of local) activeDocumentShare.pin(documentId, 'durability-pending')
  resumePendingDurableDocuments(local)
  if (booted === null) return
  void noteMintedIdSupplyWorkspace(booted)
  // Every replay awaits `entityIntentHydration`, so the carry rides on it: no
  // replay plans before the carried records are back. (Reassigned before any
  // replay junction runs: those follow the overlay materialization, which
  // follows this root resolution.)
  entityIntentHydration = carryRepointedWork(booted, entityIntentHydration, durableAckEpoch)
}

/**
 * Put back the SENT records of other workspaces (see `partitionDurableLedger`)
 * — but only those the OLD version does not already hold.
 *
 * A SENT record outlives its delivery until a release round proves it: a tab
 * that closed in between leaves records the old version received, which the
 * fork may then have copied. Replayed into the new version anyway, a creation
 * the fork carried and a colleague deleted there would come back — and where
 * deletes leave no tombstone (comments, groups, the resident replay) not even
 * the conflict-averse planner could tell (found 2026-10-31). So the
 * old version is ASKED, through the durable-heads endpoint, about each record's
 * carriers:
 *  - durable there → released: the old version has it, the fork may too, and
 *    whatever the new version did since is later work; it is not carried;
 *  - not durable there → requeued: the fork, copied from that version, cannot
 *    hold it, so creating it in the new version resurrects nothing;
 *  - the old version cannot answer (offline, denied, past the timeout) →
 *    requeued, `carried`, replayed conflict-averse (`planCarriedUpsert`): the
 *    side that loses no work, with a resurrection risk recorded rather than
 *    removed.
 * Never rejects: every replay awaits it.
 */
async function carryRepointedWork(booted: string, hydrated: Promise<void>, epoch: number): Promise<void> {
  try {
    await hydrated
    await placementIntentHydration
    if (epoch !== durableAckEpoch) return
    const workspaceKey = workspaceRefKey(currentRef)
    const elsewhere = new Set([
      ...pendingEntityIntents.sentWorkspaces(workspaceKey),
      ...pendingPlacementIntents.sentWorkspaces(workspaceKey),
    ].filter((workspace) => workspace !== booted))
    let releasedEntity = 0
    let releasedPlacement = 0
    for (const workspace of elsewhere) {
      const [landscapeId, versionId] = workspace.split('/')
      if (!landscapeId || !versionId) continue
      try {
        const durable = await durableInWorkspace(workspaceKey, workspace, { landscapeId, versionId })
        if (epoch !== durableAckEpoch) return
        const proved = (carrier: SentCarrier) => durable.has(carrier.documentId)
        releasedEntity += pendingEntityIntents.releaseSent(workspaceKey, workspace, proved)
        releasedPlacement += pendingPlacementIntents.releaseSent(workspaceKey, workspace, proved)
      } catch (error) {
        // Unknown: carried, conflict-averse (see above).
        console.warn(`[repoint] the old version ${workspace} could not be asked; its unconfirmed work is carried`, error)
      }
    }
    if (epoch !== durableAckEpoch) return
    const requeued = pendingEntityIntents.requeueSent(workspaceKey, booted)
    for (const key of requeued) {
      if (key.startsWith('diagram:')) carriedCreationIds.add(key.slice('diagram:'.length))
    }
    const placementDiagrams = pendingPlacementIntents.requeueSent(workspaceKey, booted)
    if (requeued.length > 0 || releasedEntity > 0) persistEntityIntentsNow(workspaceKvStore(), workspaceKey)
    if (placementDiagrams.length > 0 || releasedPlacement > 0) persistPlacementIntentsNow(workspaceKvStore(), workspaceKey)
    if (requeued.length + placementDiagrams.length + releasedEntity + releasedPlacement === 0) return
    console.info(JSON.stringify({
      event: 'workspace.repoint_carried',
      workspace: booted,
      carried: requeued.length,
      carriedPlacementDiagrams: placementDiagrams.length,
      alreadyInOldVersion: releasedEntity + releasedPlacement,
    }))
    // The placements are read by the first projection, which does not wait for
    // this; the drains take the late ones (both self-guard on the session).
    if (placementDiagrams.length > 0) {
      void drainOffActivePlacementIntents()
      if (activeDiagramId && placementDiagrams.includes(activeDiagramId)) scheduleWrite('placement')
    }
  } catch (error) {
    console.warn('[repoint] carrying the unconfirmed work failed', error)
  }
}

/** The documents among `workspace`'s SENT carriers that that workspace's
 * server holds, asked in batches the endpoint accepts. Throws when it cannot
 * be asked (the caller's "unknown"). */
async function durableInWorkspace(
  workspaceKey: string,
  workspace: string,
  ref: { landscapeId: string; versionId: string },
): Promise<Set<string>> {
  const headsByDocument = new Map<string, Set<string>>()
  for (const carrier of [
    ...pendingEntityIntents.sentCarriers(workspaceKey, workspace),
    ...pendingPlacementIntents.sentCarriers(workspaceKey, workspace),
  ]) {
    const heads = headsByDocument.get(carrier.documentId) ?? new Set<string>()
    for (const head of carrier.heads) heads.add(head)
    headsByDocument.set(carrier.documentId, heads)
  }
  const asked = [...headsByDocument]
    .filter(([, heads]) => heads.size > 0)
    .map(([documentId, heads]) => ({ documentId: documentId as DocumentId, heads: [...heads].sort() }))
  const durable = new Set<string>()
  for (let start = 0; start < asked.length; start += DURABLE_ACK_BATCH_SIZE) {
    const batch = asked.slice(start, start + DURABLE_ACK_BATCH_SIZE)
    const answers = await acknowledgeDurableDocumentHeads(batch, {
      workspace: ref,
      signal: AbortSignal.timeout(REPOINT_CARRY_ASK_TIMEOUT_MS),
    })
    const askedIds = new Set<string>(batch.map(({ documentId }) => documentId))
    for (const answer of answers) {
      if (answer.durable && askedIds.has(answer.documentId)) durable.add(answer.documentId)
    }
  }
  return durable
}

function resumePendingDurableDocuments(documentIds: readonly DocumentId[]): void {
  for (const documentId of documentIds) {
    const url = `automerge:${documentId}`
    if (!isValidAutomergeUrl(url)) continue
    prepareDocumentRequest(url, 'durability-pending')
    void repo.find(url as AutomergeUrl)
      .then((handle) => handle.whenReady())
      .then(() => scheduleDurableAcknowledgement(0))
      .catch((error) => console.warn('pending durable document could not be resumed', error))
  }
}

/** EVERY write of `syncTransportConnected` goes through here, so the reconnect
 *  signal (`transportEpoch`) cannot be forgotten at a new one: a direct write
 *  of `true` once skipped the bump with every test green (QA lens). */
function setSyncTransportConnected(connected: boolean): void {
  if (connected && !syncTransportConnected) useAutomergeStatus.getState().noteTransportRestored()
  syncTransportConnected = connected
}

function setDurableConnectionState(connected: boolean): void {
  if (connected) serverUnreachable = false
  setSyncTransportConnected(connected)
  // Weak evidence for the minted-id supply: the sync socket is a separately
  // configured endpoint (VITE_AUTOMERGE_URL) from the mint's own host
  // (VITE_SYNC_API_URL). Unconditional, and safe to be — the supply is a no-op
  // unless a backoff is armed and is rate-limited by that backoff, so this can
  // never make the mint ask more often than it already was. Deliberately NOT a
  // rising-edge test on `syncTransportConnected`: that flag is asserted true at
  // the end of every successful boot with no transport evidence, which consumes
  // the edge before the transport has said anything.
  if (connected) notifyMintedIdSupplyHostReachable()
  useAutomergeStatus.getState().setStatus(durableConnectionStatus(
    connected,
    pendingDurabilityCount(),
  ))
  if (connected && durableHeads.size > 0) scheduleDurableAcknowledgement(0)
  // Reconnection is the retry signal the DEFERRED intents wait for: offline,
  // the witness set cannot vouch for absence and the replay parks stamped
  // intents (without this they would freeze until a reload).
  // Dispatch by write mode: the BFS replay refuses under a resident boot and
  // vice versa, so calling the wrong one would silently drop the retry.
  if (connected && pendingEntityIntents.hasPending(workspaceRefKey(currentRef))) {
    if (bfsActive) void maybeReplayEntityIntents()
    else void maybeReplayEntityIntentsResident()
  }
  // Reconnection also retries the off-active placement drain — its
  // per-doc resolution is deadlined, so an offline pass leaves intents behind
  // on purpose and this is their retry signal.
  if (connected && pendingPlacementIntents.hasPending(workspaceRefKey(currentRef))) {
    void drainOffActivePlacementIntents()
  }
}

function scheduleDurableAcknowledgement(delayMs = DURABLE_ACK_DEBOUNCE_MS): void {
  if (durableAckTimer) clearTimeout(durableAckTimer)
  durableAckTimer = setTimeout(() => {
    durableAckTimer = null
    void runDurableAcknowledgement()
  }, delayMs)
}

/**
 * Re-present documents whose refusal the server can no longer lift by itself.
 *
 * Driven from the durable-acknowledgement round on purpose: that round is the
 * only place in the client holding a per-document SERVER VERDICT for exactly the
 * documents at risk, it is already epoch-guarded, and it is already re-armed.
 * An inbound `doc-unavailable` would be a faster signal but a missable one —
 * `wireConnectionStatus` is torn down and rebuilt on every workspace switch, so
 * a frame landing in that window has no second path.
 *
 * Note what this deliberately does NOT do: it never clears a durable-head entry,
 * never unpins, and never touches the badge. A document leaves `durableHeads`
 * only when the server answers `durable:true` for the exact frontier that was
 * sent (`DurableHeadLedger.acknowledge`, guarded by `sameHeads`). So the worst
 * this can do is emit a frame the server ignores — it cannot manufacture
 * durability, and it cannot force the gate, because `addPeer` mutates only this
 * client's peer record and admission stays receiver-side.
 */
function representRefusedDocuments(
  sent: readonly DocumentId[],
  stillPending: ReadonlySet<DocumentId>,
): void {
  const { represented, exhausted } = applyDurableVerdicts({
    sent,
    stillPending,
    recovery: deniedRecovery,
    // An attempt is counted even when no peer was reached, inside
    // applyDurableVerdicts. Skipping the count would leave `nextEligibleAt`
    // unarmed and the document would be retried every round for the life of the
    // tab — the unbounded shape of a backoff cleared unconditionally.
    represent: (documentId) => { resetDocumentSyncState(repo, documentId) },
    now: Date.now(),
  })
  for (const documentId of represented) {
    console.info(`[automerge] re-presenting refused document ${documentId}`)
  }
  for (const documentId of exhausted) {
    // The visibility half. Giving up silently here would leave a badge
    // holding "Saving…" forever while nothing is being retried.
    console.warn(
      `[automerge] document ${documentId} is still not durable after every re-presentation `
      + 'attempt. Its changes exist only in this browser; reloading retries from a fresh peer.',
    )
  }
}

let sentReleaseInFlight = false

/**
 * Retire the SENT intents whose carriers the server now holds — a POSITIVE
 * answer for the heads each carrier had after its local flush, asked of the
 * workspace this session's documents belong to (the same params every
 * durable-heads round sends). Never by absence from `durableHeads`: that ledger
 * is one key every tab of the browser rewrites, and a sibling's ack round
 * deletes it.
 *
 * Two SENT records can name the same document at different heads; each
 * journal's `sentCarriers` gives its latest capture, which descends from its
 * others, and a document both journals carry is asked with the union of their
 * two latest (two captures of one local history, in an order neither journal
 * knows). Only what was marked BEFORE the request may be released by its
 * answer: a record marked during the round carries heads it never named
 * (found 2026-10-31). A carrier past the batch is simply not proved
 * this round. A failed round is retried with the next one: SENT is not a debt,
 * so nothing waits on it.
 */
async function releaseConfirmedSentIntents(): Promise<void> {
  if (sentReleaseInFlight) return
  const workspaceKey = workspaceRefKey(currentRef)
  if (pendingEntityIntents.sentCount(workspaceKey) === 0 && pendingPlacementIntents.sentCount(workspaceKey) === 0) return
  const workspace = documentsWorkspaceKey()
  const entityThrough = pendingEntityIntents.sentSequenceNow
  const placementThrough = pendingPlacementIntents.sentSequenceNow
  const headsByDocument = new Map<string, Set<string>>()
  for (const carrier of [
    ...pendingEntityIntents.sentCarriers(workspaceKey, workspace, entityThrough),
    ...pendingPlacementIntents.sentCarriers(workspaceKey, workspace, placementThrough),
  ]) {
    const heads = headsByDocument.get(carrier.documentId) ?? new Set<string>()
    for (const head of carrier.heads) heads.add(head)
    headsByDocument.set(carrier.documentId, heads)
  }
  const asked = [...headsByDocument]
    .filter(([, heads]) => heads.size > 0)
    .slice(0, DURABLE_ACK_BATCH_SIZE)
    .map(([documentId, heads]) => ({ documentId: documentId as DocumentId, heads: [...heads].sort() }))
  const epoch = durableAckEpoch
  const store = workspaceKvStore()
  sentReleaseInFlight = true
  try {
    const answers = asked.length > 0 ? await acknowledgeDurableDocumentHeads(asked) : []
    if (epoch !== durableAckEpoch) return
    const askedIds = new Set<string>(asked.map(({ documentId }) => documentId))
    const durable = new Set(answers
      .filter((answer) => answer.durable && askedIds.has(answer.documentId))
      .map((answer) => answer.documentId as string))
    // A SENT record with no carrier has nothing to prove: `releaseSent` frees
    // it without a request, which is why an empty `asked` still reaches here.
    const proved = (carrier: SentCarrier) => durable.has(carrier.documentId)
    if (pendingEntityIntents.releaseSent(workspaceKey, workspace, proved, entityThrough) > 0) {
      await persistEntityIntents(store, workspaceKey)
    }
    if (pendingPlacementIntents.releaseSent(workspaceKey, workspace, proved, placementThrough) > 0) {
      await persistPlacementIntents(store, workspaceKey)
    }
  } catch (error) {
    console.warn('SENT intent release round failed; retried with the next durability round', error)
  } finally {
    sentReleaseInFlight = false
  }
}

async function runDurableAcknowledgement(): Promise<void> {
  if (durableAckInFlight) {
    durableAckFollowUp = true
    return
  }
  const epoch = durableAckEpoch
  const sent = durableHeads.snapshot().slice(0, DURABLE_ACK_BATCH_SIZE)
  if (sent.length === 0) {
    // 'ready' only with EVERY durability debt at zero — the journal included:
    // with a missing write head, entity edits are journaled but never produce a
    // durable head, and this branch must not say "Synced" over them.
    if (syncTransportConnected && pendingDurabilityCount() === 0) {
      useAutomergeStatus.getState().setStatus('ready')
    }
    if (syncTransportConnected) void releaseConfirmedSentIntents()
    return
  }
  durableAckInFlight = true
  durableAckFollowUp = false
  try {
    // Preserve offline-first crash safety before asking the server for its
    // stronger PostgreSQL durability boundary.
    await repo.flush(sent.map(({ documentId }) => documentId))
    const acknowledged = await acknowledgeDurableDocumentHeads(sent)
    if (epoch !== durableAckEpoch) return
    durableHeads.acknowledge(sent, acknowledged)
    // The epoch an abandoned hop left the tab on is retired now — hop at once
    // (the retired path exports).
    if (epochHopAbandonedUrl !== null && heldEpochRetiredIn(acknowledged)) resumeAbandonedEpochHop()
    // A retired document held in no epoch.
    offerOrphanedRetiredLedger(acknowledged)
    // Any `durable` answer means the server holds the document (heads are
    // causal, so the frontier sent contains its creation) — which is all a held
    // pointer waits for, even if newer edits are still on their way.
    const sentIds = new Set(sent.map(({ documentId }) => documentId))
    serverDurability.noteDurable(acknowledged
      .filter((item) => item.durable && sentIds.has(item.documentId as DocumentId))
      .map((item) => item.documentId as DocumentId))
    const stillPending = new Set(durableHeads.snapshot().map(({ documentId }) => documentId))
    for (const { documentId } of sent) {
      if (!stillPending.has(documentId)) {
        activeDocumentShare.unpin(documentId, 'durability-pending')
      }
    }
    // The server ANSWERED. A document still pending after that is what a refusal
    // looks like from here — one such answer is ordinary (the heads may simply
    // not have reached its Repo yet), a run of them is not. The polarity and the
    // decision live in applyDurableVerdicts, where they are testable.
    representRefusedDocuments(sent.map(({ documentId }) => documentId), stillPending)
    queueDurableLedgerPersistence()
    // The STRONGEST evidence available that the minted-id endpoint will answer:
    // `acknowledgeDurableDocumentHeads` just got a 200 from
    // `${VITE_SYNC_API_URL}/api/automerge/durable-heads`, which is the same
    // origin the mint posts to — unlike the sync WebSocket, which is a
    // separately configured endpoint.
    notifyMintedIdSupplyHostReachable()
    setSyncTransportConnected(true)
    // Third 'ready' producer — the one a partial patch always misses: a
    // placement acknowledging must not flip the badge over journaled entity
    // intents that never reached a durable head.
    useAutomergeStatus.getState().setStatus(durableConnectionStatus(
      true,
      pendingDurabilityCount(),
    ))
    void releaseConfirmedSentIntents()
  } catch (error) {
    // Never show Synced on an unavailable or rejecting durability endpoint.
    // Keep retrying as a connectivity probe while the browser itself is online.
    // 'saving' is for a server we believe reachable that failed or refused the
    // ack. Under boot-from-server navigator.onLine stays true when only the
    // backend is gone, so a server already known UNREACHABLE (a render fetch
    // that failed at the network level) stays 'offline' — measured 2026-10-16
    // (bridgeOfflineBoot.test.ts): the first edit after an outage flipped the
    // badge from Offline to Saving. Not `!syncTransportConnected`: that flag is
    // false for the whole of every boot, online ones included.
    // Session-scoped: an ack a previous session left in flight must not write
    // THIS session's badge (2026-10-16; measured in
    // bridgeOfflineBoot.test.ts as an offline session's late writes pinning the
    // next session's transport down).
    if (epoch !== durableAckEpoch) {
      // (stale session: nothing to report)
    } else if ((typeof navigator !== 'undefined' && !navigator.onLine) || serverUnreachable) {
      setSyncTransportConnected(false)
      useAutomergeStatus.getState().setStatus('offline')
    } else {
      useAutomergeStatus.getState().setStatus('saving')
    }
    console.warn('PostgreSQL durability acknowledgement failed', error)
  } finally {
    if (epoch === durableAckEpoch) {
      durableAckInFlight = false
      if (durableHeads.size > 0 || durableAckFollowUp) {
        scheduleDurableAcknowledgement(DURABLE_ACK_RETRY_MS)
      }
    }
  }
}

function trackDurableHandle<T>(handle: DocHandle<T>, localChange = false): void {
  const doc = handle.doc()
  if (!doc) return
  // Tagged with the workspace the document belongs to; an unknown one leaves
  // any earlier tag in place (`partitionDurableLedger` reads it).
  // With the actor a LOCAL change was written under: the net filters a retired
  // copy by the entry's own writers, never by the bounded actor journal. Any
  // other mark (a creation, a resumed handle whose content an earlier page load
  // wrote) leaves them unknown: nothing filtered.
  durableHeads.mark(handle.documentId, getHeads(doc as never), documentsWorkspaceKey() ?? undefined,
    localChange ? getActorId(doc as never) : undefined)
  activeDocumentShare.pin(handle.documentId, 'durability-pending')
  queueDurableLedgerPersistence()
  if (syncTransportConnected) useAutomergeStatus.getState().setStatus('saving')
  scheduleDurableAcknowledgement()
}

function trackCreatedHandle<T>(handle: DocHandle<T>): DocHandle<T> {
  trackDurableHandle(handle)
  return handle
}

/** All loaded shard handles, in shardUrls order. */
let shardHandles: DocHandle<RegistryShard>[] = []
/** Change listeners keyed by shard URL so we can detach them cleanly. */
const shardChangeHandlers = new Map<string, () => void>()
/** id → diagram doc url, mirrored from the merged registry. */
const docUrlById = new Map<string, string>()
/** Forget a diagram's doc url everywhere this module keeps one: the index and
 * the session's record of a document whose meta is not placed yet. */
function forgetDiagramDocUrl(id: string): void {
  docUrlById.delete(id)
  unpublishedDiagramDocs.forget(id)
}
/** id → shard url that holds this diagram's meta. */
const shardByDiagramId = new Map<string, string>()
/** Static performance baselines resolve diagram stubs from the read model and
 * never open the multi-million-id Automerge registry during interactive boot. */
let registrySummaryOnly = false
/**
 * Assign `registrySummaryOnly` AND publish it to the read-model tier in one
 * step. Never assign the variable directly: the global read path (`ro_*` via
 * `getModelQuery`) and the boot path must enter and leave the summary contract
 * together — a summary boot whose tier stayed resident silently truncates the
 * global views (bootFromServer without serverReadModel), and a resident boot
 * whose tier stayed on the
 * server would query `ro_*` for a workspace the client holds whole.
 */
function setRegistrySummaryOnly(active: boolean): void {
  registrySummaryOnly = active
  setWorkspaceSummaryActive(active)
}
/**
 * A SUMMARY root that cannot enter its own contract.
 *
 * The root says `registrySummaryOnly`, so the baseline lives in the server read
 * model and the baseline shards are fenced server-side — but the ModelMeta the
 * boot-from-server path needs is missing or never resolved. There is no
 * `bfs-degraded` to fall into (that mode is built on the ModelMeta), and the
 * classic path is not a fallback but three failures at once: it re-materializes
 * every registry shard (~78 s at 10k diagrams), it projects a store whose
 * model documents were never loaded, and its writes are refused by the fence
 * while `flushWrite` reports "nothing tracked" — i.e. a badge that says
 * "Synced" over a session that saves nothing. So the honest answer is a boot
 * that FAILS and names why.
 *
 * Its own class because startBridge's catch has two REBOUNDS that must not fire
 * for it: both exist for a REFERENCE that can never resolve, and rebounding
 * would silently move the user to a different landscape. This failure is about
 * the workspace's own shape — the reference resolved perfectly.
 */
class SummaryContractBootError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SummaryContractBootError'
  }
}
/**
 * Latched by the epoch guard once a CLASSIC session sees its workspace promoted
 * to the summary contract (`rootChangeHandler`). One-way within a session — the
 * only exit is the reload the banner asks for, or a workspace switch, which
 * stops the bridge.
 *
 * TWO readers, and the second one is the point. The epoch
 * guard's own `return` only stops a PROJECTION (`syncShardHandles` +
 * `projectAll`); the verb that WRITES is `flushWrite`, which for a classic
 * session runs its model pass, its `ensureDiagramDoc` pass and its registry
 * pass into exactly the baseline documents the promotion has just handed to the
 * server. Latching without reading it there would freeze the harmless half and
 * leave the dangerous one running.
 */
let workspaceContractStale = false
let serverRegistryDiagrams: DiagramMeta[] = []
const serverDiagramBootstraps = new Map<string, DiagramBootstrap>()
let summaryRegistryWriteUrl: string | null = null
/** Diagram ids explicitly created by this client while only a bounded registry
 * window is resident. This is the proof required to mutate registry membership;
 * absence from the window alone is never treated as a deletion. */
const summaryLocalDiagramIds = new Set<string>()

/** Diagrams the user just created, held until a registry shard carries them. */
const localDiagramHold = new LocalDiagramHold()
// Override keys changed LOCALLY per diagram, written as a delta (diagramViewWrite.ts).
const scopeEdits = new ScopeEditTracker()
/** Their DiagramDocs, kept resolvable across `docUrlById` rebuilds until a meta
 * names them (see unpublishedDiagramDocs.ts). */
const unpublishedDiagramDocs = new UnpublishedDiagramDocs()
/** Diagrams whose meta flushWrite withheld for naming no document — warned once each. */
const withheldMetaWarned = new Set<string>()

// ── sharded model state (only when isModelShardingEnabled()) ───────────────────
/** True once the model has been sharded (ModelMeta + object/connection shards
 * resolved). When false the monolithic ModelDoc at root.modelUrl is authoritative
 * — every path below branches on this so flag-off is byte-identical. */
let sharded = false
/**
 * Boot-from-server is a PER-WORKSPACE mode, not just the flag: it projects from the
 * server render and routes writes through the ModelMeta edits overlay, both of which
 * require a SHARDED workspace (root.modelMetaUrl). A monolith workspace booted on the
 * raw flag alone would have NO durable write path — writeEditsShards bails without a
 * ModelMeta, so edits would sit in memory and be LOST on reload (e.g. a new
 * landscape's first object vanishing). startBridge resolves the
 * flag against the root's actual shape once per boot; every bridge path consults
 * THIS, never the raw flag.
 */
let bfsActive = false
/** The resolved per-workspace boot-from-server mode (flag AND the workspace is
 * sharded). False before startBridge / after stopBridge. */
export function isBootFromServerActive(): boolean {
  return bfsActive
}

/**
 * READ-ONLY: whether this session holds a delete tombstone for the entity —
 * a deletion the server read model may not have projected yet. Readers that
 * show server answers next to the store (the Spotlight's server tier) use it
 * so a deleted entity does not come back from a stale projection. The sets
 * themselves stay private to the bridge.
 */
export function hasDeleteTombstone(kind: 'object' | 'connection' | 'group' | 'diagram', id: string): boolean {
  switch (kind) {
    case 'object': return tombstoneObjects.has(id)
    case 'connection': return tombstoneConnections.has(id)
    case 'group': return tombstoneGroups.has(id)
    case 'diagram': return tombstoneDiagrams.has(id)
  }
}

/**
 * READ-ONLY: the url of the root this session holds, or null with no session.
 * It is half of what `documentsWorkspaceFor` needs to name the workspace this
 * session's documents belong to (the other half is the ref), and the readers
 * that ask the server about those documents — the crash replay's durability
 * witness and the Spotlight's server tier — take it from here, and every
 * `/api/model/*` read through the installed source below.
 */
export function sessionRootUrl(): string | null {
  return rootHandle?.url ?? null
}
// `workspaceParams.ts` cannot import this module (see
// `installSessionRootUrlSource`); bridgeSessionRootUrl.test.ts drives a real
// boot to check the reads name the documents' workspace through it.
installSessionRootUrlSource(sessionRootUrl)

/** Workspace key whose boot already re-entered from the cached root this
 * session — the one-shot guard of the boot fallback (a broken local cache must
 * fail honestly, never recurse). NOT cleared in stopBridge: the fallback path
 * itself goes through stopBridge → startBridge, and clearing it there would
 * re-arm the guard mid-flight. Cleared on a successful boot instead. */
let bootCachedRootFallbackKey: string | null = null

/** True exactly between the fallback branch arming the cached-root preference
 * and its re-entry startBridge call capturing it (synchronously — the entry
 * runs to its first await in the same tick). Each startBridge invocation
 * captures this into a LOCAL at entry, because boots can overlap: StrictMode's
 * dev double-mount leaves the first boot's promise chain running while the
 * second boots, and both can fail. Only the invocation that IS the fallback
 * re-entry may clean the one-shot preference up on its terminal error: if the
 * refused TWIN's terminal path disarmed the preference while the re-entry was
 * still in its early awaits, the re-entry would re-fetch the FORK root from the
 * server, stall again, and the one-shot guard would brick the whole recovery. */
let bootFallbackReentryPending = false

/** The version whose root the boot that fell back failed to materialize, for
 * the session that boot re-entered (null when unknown, or no fallback). Set in
 * startBridge's fallback branch, kept by the re-entry, cleared by every other
 * start; `onWorkspaceBound` holds a fallback session only on a frame naming it. */
let bootFallbackFailedVersionId: string | null = null

/** A parked diagram the next boot PREFERS rather than REQUESTS. A deep link
 * requests a diagram: when it is absent, the canvas shows not-found, which is
 * the honest answer to "open this diagram". A workspace switch that only wants
 * to keep the user where they were (entering, leaving or merging a Draft)
 * prefers one: absent from the target version, the boot falls back to its
 * default pick instead of stranding the user on not-found. Set by
 * `switchWorkspace` before every load (null for a request or no park), and
 * consumed by the boot's initial-diagram choice — it survives the boot
 * fallback's stopBridge → startBridge re-entry on purpose. */
let preferredInitialDiagramId: string | null = null

export function preferInitialDiagram(id: string | null): void {
  preferredInitialDiagramId = id
}

/** The parked diagram, or null when it is only a preference the target
 * version does not contain — or cannot be confirmed to contain (the park is
 * then cleared from the store, so the default pick applies). Consumes the
 * preference either way. */
async function takeParkedInitialDiagram(
  parked: string | null,
  exists: (id: string) => boolean | Promise<boolean>,
): Promise<string | null> {
  const preferred = preferredInitialDiagramId
  preferredInitialDiagramId = null
  if (!parked || parked !== preferred || await exists(parked)) return parked
  // The user may have picked a diagram while the existence check was in flight.
  const now = useModelStore.getState().currentDiagramId
  if (now !== parked) return now
  withRemote(() => useModelStore.setState({ currentDiagramId: null }))
  return null
}

let deferredPickTeardown: Array<() => void> = []
/** Bumped by every disarm, so a queued open or an in-flight heads probe from a
 * session that has since been stopped (or re-armed) lands nowhere. */
let deferredPickGeneration = 0

function disarmDeferredInitialPick(): void {
  deferredPickGeneration += 1
  for (const teardown of deferredPickTeardown) teardown()
  deferredPickTeardown = []
}

/** The loaded registry of the booted version — the authority on which diagrams
 * it has. Under boot-from-server the STORE's diagram list is not projected yet
 * at the boot's choice (measured 2026-10-17: store 0, registry shard 4, in 8 of
 * 8 draft boots, e2e/boot/draft-stays-on-diagram.spec.ts), so it cannot be. */
function loadedRegistryMetas(): DiagramMeta[] {
  return mergeShards(shardHandles.map((handle) => handle.doc() ?? { diagrams: {} }))
}

/**
 * The boot was asked to PREFER a diagram (a Draft create/open/exit/merge keeps
 * the one being viewed) and the loaded registry does not list it. That proves
 * nothing on its own: a warm tab resolves its shards from IndexedDB before the
 * WebSocket delivers changes, and a merge is applied to live IN PLACE — so the
 * diagram just merged can be missing from a perfectly "ready" shard. The
 * SERVER answers for the version's own registry (registry-diagram):
 *  - absent → the default pick, at once;
 *  - present → wait for the registry to bring it, then open it. The wait is
 *    for DELIVERY only (presence is settled), bounded by the same budget a
 *    document gets to arrive at boot; past it the sync is not delivering, and
 *    the user gets the default diagram with a warning rather than a blank
 *    canvas for good;
 *  - the server cannot tell (offline, refused, too large) → the loaded registry
 *    is the best knowledge there is; decide on it.
 * The registry bringing the diagram opens it whenever that happens, even
 * before the server answers. A diagram chosen meanwhile — by the user or a
 * deep link — wins; stopBridge disarms.
 */
function armRegistryConfirmedPick(preferred: string): void {
  disarmDeferredInitialPick()
  const generation = deferredPickGeneration
  const live = () => generation === deferredPickGeneration
  let server: 'asking' | 'present' | 'absent' | 'unknown' = 'asking'
  let deliveryOverdue = false

  const open = (id: string) => {
    disarmDeferredInitialPick()
    const opened = deferredPickGeneration
    // Outside any withRemote on purpose: onStoreChange sees an ordinary
    // navigation and opens it through the same path as a user's pick.
    setTimeout(() => {
      if (opened !== deferredPickGeneration) return
      if (useModelStore.getState().currentDiagramId === null) useModelStore.setState({ currentDiagramId: id })
    }, 0)
  }

  const decide = () => {
    if (!live()) return
    if (useModelStore.getState().currentDiagramId !== null) {
      disarmDeferredInitialPick()
      return
    }
    const metas = loadedRegistryMetas()
    if (metas.some((meta) => meta.id === preferred)) {
      open(preferred)
      return
    }
    if (server === 'asking') return
    if (server === 'present' && !deliveryOverdue) return
    if (server === 'present') {
      console.warn(
        `deferred initial pick: the server's registry lists diagram ${preferred} but this client's copy did not `
          + `receive it within ${BOOT_DOCUMENT_RESOLUTION.budgetMs} ms; opening the default diagram instead`,
      )
    }
    const fallback = (metas.find((meta) => meta.objectIds.length > 0) ?? metas[0])?.id
    if (fallback) open(fallback)
  }

  for (const handle of shardHandles) {
    handle.on('change', decide)
    deferredPickTeardown.push(() => handle.off('change', decide))
  }
  // Also re-decide on projections: a root change can bring shards this
  // listener set was not attached to.
  deferredPickTeardown.push(useModelStore.subscribe(decide))

  // decide() is the one session guard: a stopped or re-armed session ignores
  // the answer there.
  void fetchRegistryHasDiagram(preferred).then((present) => {
    server = present === undefined ? 'unknown' : present ? 'present' : 'absent'
    if (server === 'present' && live()) {
      const timer = setTimeout(() => {
        deliveryOverdue = true
        decide()
      }, BOOT_DOCUMENT_RESOLUTION.budgetMs)
      deferredPickTeardown.push(() => clearTimeout(timer))
    }
    decide()
  })
}

/** TEST-ONLY: clear the one-shot boot-fallback guard between tests. The guard
 * is module state that survives a FAILED fallback boot on purpose (see above),
 * so a test that legitimately ends in 'error' would otherwise leak a latched
 * key into whichever later test reuses the same workspace ref — an ordering
 * dependency. Production never calls this. */
export function __resetBootCachedRootFallbackForTest(): void {
  bootCachedRootFallbackKey = null
  bootFallbackReentryPending = false
  bootFallbackFailedVersionId = null
}

/** TEST-ONLY: the summary registry window as the bridge itself sees it. Exposed
 * so `bridgeSummaryDelete.test.ts` can make the CLAIM (the window) and the
 * PROOF (the ModelMeta flush) disagree, and pin that only the second is ever
 * allowed to acknowledge an intent. Production never calls this. */
export function __summaryRegistryMetasForTest(): DiagramMeta[] {
  return summaryRegistryMetas()
}

/** TEST-ONLY: how many document heads the durable ledger is still waiting on.
 * The badge derives from this, so a test can assert "still saving" without
 * reproducing the whole status pipeline. Production never calls this. */
export function __bridgeDurableHeadCountForTest(): number {
  return durableHeads.size
}

/** TEST-ONLY: WHICH documents the durable ledger is waiting on. The count
 * alone is a global: tracking some other handle instead of ModelMeta would
 * still satisfy an assertion on `size > 0`, and ModelMeta is the only carrier a
 * summary deletion has. Production never calls this. */
export function __bridgeDurableHeadDocumentIdsForTest(): string[] {
  return durableHeads.snapshot().map(({ documentId }) => documentId)
}

/** True when the workspace deliberately keeps the multi-diagram registry on the
 * server. Views that list every diagram must page the read model even when the
 * current user can edit the bounded active DiagramDoc. */
export function isRegistrySummaryOnlyActive(): boolean {
  return registrySummaryOnly
}

/**
 * The diagrams THIS session created on a summary workspace, as the bridge
 * currently holds them.
 *
 * SESSION-SCOPED ON PURPOSE. It is empty on a fresh load, so nothing built on it
 * can survive a reload or a cold profile — which is what keeps the diagram
 * list's latency mask from ever hiding a regression of the server-side
 * projection. `writeSummaryLocalRegistry` drops an id from this set the moment
 * the user deletes the diagram, so a consumer that re-reads it also gets the
 * removal for free (a session-created diagram never receives a ModelMeta
 * tombstone — `diagramTombstonePlan.ts` — so this set is the ONLY signal for
 * that case).
 *
 * A copy: the caller must not be able to mutate the bridge's set.
 */
export function sessionLocalDiagramIds(): ReadonlySet<string> {
  return new Set(summaryLocalDiagramIds)
}
let modelMetaHandle: DocHandle<ModelMeta> | null = null
let objectShardHandles: DocHandle<ObjectShard>[] = []
let connectionShardHandles: DocHandle<ConnectionShard>[] = []
/** Change listeners for the meta + model shard docs, keyed by url (detach cleanly). */
const modelShardChangeHandlers = new Map<string, () => void>()
/** id → shard INDEX, rebuilt from shard CONTENTS each projection (stable routing —
 * an entity returns to the shard already holding it; never id-hash bucketed). */
const shardIndexByObjectId = new Map<string, number>()
const shardIndexByConnectionId = new Map<string, number>()

/** The resident path's local writes no document holds yet, overlaid on every
 * projection (`residentPendingWrites.ts`). Resident sharded mode only:
 * boot-from-server journals them (`entityIntents.ts`). */
const residentPendingWrites = new ResidentPendingWrites()

/** The entity as the document it is routed to holds it (any shard otherwise). */
function heldInShards(collection: 'objects' | 'connections', id: string): Record<string, unknown> | undefined {
  const handles = (collection === 'objects' ? objectShardHandles : connectionShardHandles) as DocHandle<unknown>[]
  const route = (collection === 'objects' ? shardIndexByObjectId : shardIndexByConnectionId).get(id)
  const read = (h: DocHandle<unknown> | undefined) => ((h?.doc() as Record<string, Record<string, Record<string, unknown>> | undefined>)?.[collection])?.[id]
  if (route !== undefined) {
    const routed = read(handles[route])
    if (routed) return routed
  }
  for (const h of handles) {
    const found = read(h)
    if (found) return found
  }
  return undefined
}

/**
 * With or without epochs: the store is projected and the editor shown BEFORE
 * the boot subscribes `onStoreChange` — it still awaits the active diagram
 * (`switchActiveDiagram`) and its freshness. An edit in that window was noted
 * by nothing and scheduled no write, and the write-guard baselines were then
 * seeded from the store WITH it, so no later flush saw it either. Measured in a
 * manual test: Paul's online rename of an object showed in his store, no
 * document held it, the badge said "Synced", and the reload lost it (3 trials
 * in 6, and 4 in 6 on an earlier build). The sample that named it: status `connecting`
 * at the edit, `residentPendingWrites` 0, the shard untouched.
 *
 * So from the start of the boot, a LOCAL store change is noted as owed (the
 * resident pending-writes overlay keeps it through the boot's projections), and the state
 * before the first one is kept: the baselines are seeded from it, and the
 * subscription then hands `onStoreChange` the whole difference, which writes
 * it like any edit.
 */
let bootEditWatch: (() => void) | null = null
/** The window's LOCAL edits, by entity. */
let bootLocalEdits: BootLocalEdits | null = null
/** The write-guard baselines were seeded for this boot window. */
let bootBaselinesSeeded = false

/**
 * G4-16l: the session's owner of the resident debt, from `startBridge` to
 * `stopBridge` — not the boot window's. Before it, the window's 200 ms retry
 * and its `pagehide` listener were what drove the debt, and closing the window
 * (a failed boot, a throw between the debt's note and its scheduled write) left
 * an edit owed with nobody charged with writing it.
 */
let residentDebtDriver: ResidentDebtDriver | null = null
/**
 * Which path the driver's attempt takes. `boot`: from `watchBootEdits` until
 * the session's subscription takes over — the boot window's model write, with
 * its gates (`writesPausedByHop`, `residentStoreProjectsShards`); a boot that
 * FAILED inside its window stays here, its window baselines seeded by its
 * catch. `session`: from the boot's seeding of its write baselines (just
 * before the subscription) on — ALWAYS the flush
 * (`scheduleWrite`), the only writer that reads `workspaceContractStale`, so
 * a failed boot past its window never writes over a contract latched stale.
 * `null`: no session.
 */
let residentDebtWriter: 'boot' | 'session' | null = null

function attemptResidentDebtWrite(): ResidentDebtAttempt {
  if (residentDebtWriter === 'session') {
    // A FULL write already planned is the one that pays the debt: requesting
    // another would push its debounce back. A placement-only one would not
    // write the model.
    if (!writeScheduler.pending || !pendingNormalWrite) scheduleWrite('normal')
    return 'deferred'
  }
  if (residentDebtWriter === 'boot') return writeBootModelNow() ? 'written' : 'refused'
  return 'refused'
}

/**
 * G4-16l, case 3: the failed boot's write of its window debt, which never
 * throws (a throw from `writeModelShards` used to skip the rest of the catch —
 * its cleanup, the cached-root fallback and the `error` status — and leave
 * the loader on "connecting"). Not retried here: what stays owed is the
 * driver's. Only while the window is open. The baselines are seeded
 * from the window's base now, while it is still known — closing the window
 * drops it, and a later seeding from the store would already hold her
 * edit, which no flush would then write.
 */
function tryWriteBootDebt(): 'written' | 'refused' | 'failed' {
  if (!bootEditWatch) return 'refused'
  try {
    if (residentPendingWrites.size > 0 && !bootBaselinesSeeded && bootLocalEdits) {
      seedWriteBaselines(bootLocalEdits.base(useModelStore.getState()), true)
      bootBaselinesSeeded = true
    }
    return writeBootModelNow() ? 'written' : 'refused'
  } catch (error) {
    console.error('Automerge bridge: the failed boot could not write its window edits now; they stay owed and are tried again', error)
    return 'failed'
  }
}

/**
 * TEST SEAM (G4-16l): one synchronous throw at a named site, the next time it
 * runs. Inert in production: nothing outside a test arms it, and an empty map
 * is one size check per call.
 */
export type BridgeFaultSiteForTest = 'onStoreChangeAfterNote' | 'writeModelShards' | 'projectAll'
const faultsOnceForTest = new Map<BridgeFaultSiteForTest, (() => void) | undefined>()
export function __injectFaultOnceForTest(site: BridgeFaultSiteForTest | null, onFire?: () => void): void {
  if (site === null) faultsOnceForTest.clear()
  else faultsOnceForTest.set(site, onFire)
}
export function __armedFaultsForTest(): BridgeFaultSiteForTest[] {
  return [...faultsOnceForTest.keys()]
}
function faultPointForTest(site: BridgeFaultSiteForTest): void {
  if (faultsOnceForTest.size === 0 || !faultsOnceForTest.has(site)) return
  const onFire = faultsOnceForTest.get(site)
  faultsOnceForTest.delete(site)
  onFire?.()
  throw new Error(`injected fault (${site})`)
}
/** TEST SEAM (G4-16l): this session's debt driver (null: no session). */
export function __residentDebtDriverForTest(): ResidentDebtDriver | null {
  return residentDebtDriver
}
/** TEST SEAM (G4-16l, case 1): writes paused as a hop's latch pauses them,
 * without a hop. Inert in production: nothing outside a test calls it. */
export function __pauseWritesAsByHopForTest(paused: boolean): void {
  writesPausedByHop = paused
}

function watchBootEdits(): void {
  stopWatchingBootEdits()
  bootLocalEdits = new BootLocalEdits()
  bootBaselinesSeeded = false
  residentDebtWriter = 'boot'
  bootEditWatch = useModelStore.subscribe((state, previous) => {
    if (applyingRemote) return
    if (!bfsActive && sharded && modelMetaHandle) {
      residentPendingWrites.note('objects', previous.objects as never, state.objects as never)
      residentPendingWrites.note('connections', previous.connections as never, state.connections as never,
        (c) => (c as unknown as Connection).kind === 'lower')
      if (residentPendingWrites.size > 0) residentDebtDriver?.arm()
    }
    if (persistentSlicesChanged(state, previous)) bootLocalEdits?.note(previous as never, state as never)
  })
}

/**
 * The write-guard baselines (`lastModelSlices`, the per-shard slices) seeded
 * from `base` — the store as the documents hold it, the boot window's local
 * edits put back — so a write reconciles only the shards and the small
 * collections those edits touched (when they were seeded only at the
 * subscription, the first boot-window write reconciled EVERY shard, the
 * O(model) walk measured at ~12 s for 15 000 objects, and the meta's small
 * collections from a store whose ADR page may not be hydrated yet).
 */
function seedWriteBaselines(base: ReturnType<typeof useModelStore.getState>, shards: boolean): void {
  const persisted0 = base.connections.filter((c) => c.kind !== 'lower')
  lastModelSlices = {
    objects: base.objects,
    connections: persisted0,
    groups: base.groups,
    domains: base.domains,
    tags: base.tags,
    decisionRecords: base.decisionRecords,
  }
  // Per-shard write-guard baselines: partition the just-projected store exactly
  // as writeModelShards will, so the first flush finds every shard unchanged.
  if (shards) {
    lastObjectShardSlices = partitionByShard(base.objects, shardIndexByObjectId, objectShardHandles.length)
    lastConnectionShardSlices = partitionByShard(persisted0, shardIndexByConnectionId, connectionShardHandles.length)
  }
}

/**
 * The model half of a boot-window edit, written WITHOUT waiting for the boot
 * to end (measured in a manual test: a device that edits offline while its boot still
 * awaits the active diagram's freshness wrote nothing for seconds; the clear
 * then reached it, the entity was absent from the merge until its fold
 * product was followed, and the pending-write entry was dropped as "deleted remotely"
 * — the edit was lost with no document ever holding it). Only the model
 * shards (the rest of `flushWrite` waits for the boot), only while the store
 * is the projection of the loaded shards (a reconcile from a store not
 * projected yet would delete what it does not show).
 *
 * Driven by the session's `residentDebtDriver` (G4-16l; the window's own
 * 50 ms then 200 ms timer before it): refused now — a hop's latch, a store not
 * (or no longer) the projection of the loaded shards — it is tried again on
 * the driver's backoff, past the window too when the boot failed inside it.
 * `flushWrite`'s other gate, the promoted-contract latch
 * (`workspaceContractStale`), is read here too: the boot installs
 * `rootChangeHandler` shortly BEFORE its window closes, and a boot that failed
 * inside its window has no root handler at all, so its writer also refuses a
 * root that now says `registrySummaryOnly` — the base shards are the server's
 * and fenced.
 */
/** The boot window's owed model writes, written now if they can be (no
 * latch, the store the projection of the loaded shards); false: refused. */
function writeBootModelNow(): boolean {
  if (residentPendingWrites.size === 0) return true
  if (writesPausedByHop || !residentStoreProjectsShards()) return false
  if (workspaceContractStale || rootHandle?.doc()?.registrySummaryOnly === true) return false
  const state = useModelStore.getState()
  if (!bootBaselinesSeeded) {
    // The window's base is gone (the window closed before any seeding): a
    // seeding from the store would hold her edit and write nothing.
    if (!bootLocalEdits) return false
    seedWriteBaselines(bootLocalEdits.base(state), true)
    bootBaselinesSeeded = true
  }
  writeModelShards(state.objects, state.connections.filter((c) => c.kind !== 'lower'), {
    groups: state.groups, domains: state.domains, tags: state.tags, decisionRecords: state.decisionRecords,
  })
  releaseResidentPendingWrites()
  return true
}

/**
 * The page hidden or closed while the boot runs — before `wireConnectionStatus`
 * installs the session's own lifecycle listeners — runs the lifecycle flush
 * too: an edit made in the boot window is otherwise lost with the tab
 * (measured in a manual test: a device that edits, reconnects and closes
 * while its boot still awaits the active diagram's freshness).
 *
 * G4-16l: the listener is the debt driver's, installed with the session and
 * removed only when `wireConnectionStatus` installs the session's own (one
 * owner of the lifecycle at a time, so no double flush) or by `stopBridge`.
 * A failed boot keeps it: its catch used to remove it, and an edit its write
 * refused then had nothing to write it before the tab went away.
 */
function watchBootLifecycle(): void {
  residentDebtDriver?.installLifecycle()
}

/**
 * The watch removed, and the window's local edits handed back (null: none).
 * Called by the boot that installed it only once that boot has checked it is
 * not superseded (a superseded boot taking it would take the NEXT boot's
 * window); a stop or a new watch removes it. G4-16l: it cancels nothing on the
 * debt's side — what is owed stays the session driver's.
 */
function stopWatchingBootEdits(): BootLocalEdits | null {
  if (bootEditWatch) bootEditWatch()
  bootEditWatch = null
  const edits = bootLocalEdits
  bootLocalEdits = null
  return edits && edits.size > 0 ? edits : null
}

/** The resident sharded store is the projection of the shard documents as
 * they are now (nothing has changed in them since `projectAll` merged them). */
function residentStoreProjectsShards(): boolean {
  if (bfsActive || !sharded || !modelMetaHandle) return false
  if (lastObjectShardDocs.length === 0 || lastObjectShardDocs.length !== objectShardHandles.length) return false
  return sameRefs(objectShardHandles.map((h) => h.doc()), lastObjectShardDocs)
    && sameRefs(connectionShardHandles.map((h) => h.doc()), lastConnectionShardDocs)
}

function releaseResidentPendingWrites(): void {
  if (residentPendingWrites.size === 0) return
  residentPendingWrites.release('objects', (id) => heldInShards('objects', id))
  residentPendingWrites.release('connections', (id) => heldInShards('connections', id))
  armAbsentReleaseTimer()
}

/**
 * An entity edited here that stayed absent past its grace is released when the
 * grace ENDS, not at the next projection or write — in a quiet workspace there
 * may be none, and the badge would say "Saving" until then. The durability
 * check that follows lets it say "Synced" again.
 */
let absentReleaseTimer: ReturnType<typeof setTimeout> | null = null
let absentReleaseAt = 0

function armAbsentReleaseTimer(): void {
  const deadline = residentPendingWrites.nextAbsentDeadline()
  if (deadline === null) return
  if (absentReleaseTimer && absentReleaseAt <= deadline) return
  if (absentReleaseTimer) clearTimeout(absentReleaseTimer)
  absentReleaseAt = deadline
  const session = durableAckEpoch
  absentReleaseTimer = setTimeout(() => {
    absentReleaseTimer = null
    if (session !== durableAckEpoch) return
    releaseResidentPendingWrites()
    scheduleDurableAcknowledgement(0)
  }, Math.max(0, deadline - Date.now()) + 5)
}

function stopAbsentReleaseTimer(): void {
  if (absentReleaseTimer) clearTimeout(absentReleaseTimer)
  absentReleaseTimer = null
}
/** Read-skip caches: re-merge object/connection shards only when a shard doc ref
 * changed; small collections come from the meta doc (per-key via lastModelColl). */
let lastObjectShardDocs: unknown[] = []
let lastConnectionShardDocs: unknown[] = []
/** Write-skip caches: per-shard last-written slices (by element ref) so a flush
 * reconciles ONLY the shards whose contents actually changed. */
let lastObjectShardSlices: C4Object[][] = []
let lastConnectionShardSlices: Connection[][] = []

// ── Slice B/C: user EDITS under boot-from-server (new + existing entities) ───────
// The store is windowed, so we CANNOT diff it against the model, and we can't reuse
// writeModelShards (it reconciles a partition of the WINDOW and would delete off-window
// objects). Instead: detect entities that DIFFER from the last server render (created
// OR edited — by ref), keep their authoritative data in these maps (NOT derived from
// the windowed store, so a re-projection can't drop them), and write them into a
// PERSISTENT, model-level "edits overlay" shard. The overlay shadows originals
// last-write-wins (it's the LAST entry in ModelMeta.objectShardUrls, so the server
// read-model upsert + mergeShards dedup pick it). `rendered*` hold the render's
// entities BY REF — the detection baseline.
//
// Offline-first + reliable: the overlay is a local Automerge doc (writes apply offline
// and CRDT-sync on reconnect), and — crucially — it uses bounded segments reused
// across sessions. The current URL lives in ModelMeta.editsObjectShardUrl; rotation
// is driven by size, not by sessions. That kills the old per-session shard proliferation
// + server-fetch race that made writes flaky. It is
// Loaded after the first interactive paint (or lazily on the first edit if that
// happens sooner), so it adds no cost to the connection/first-render gate.
// The daily server compaction folds it back into the base shards and clears it.
let renderedObjects = new Map<string, C4Object>()
let renderedConnections = new Map<string, Connection>()
const editsObjects = new Map<string, C4Object>()
const editsConnections = new Map<string, Connection>()
// Groups need the same local-edit overlay objects have, for the same reason —
// see groupEditOverlay.ts for the mechanism this closes.
const groupEdits = new GroupEditOverlay()
const dirtyObjectIds = new Set<string>()
const dirtyConnectionIds = new Set<string>()
const overlayObjectIds = new Set<string>()
const overlayConnectionIds = new Set<string>()
const objectOverlaySegments = new Map<string, Record<string, C4Object>>()
const connectionOverlaySegments = new Map<string, Record<string, Connection>>()
const effectiveObjectOverlay = new Map<string, C4Object>()
const effectiveConnectionOverlay = new Map<string, Connection>()
/** The persistent overlay handles (reused across sessions; null until the first edit
 * lazily resolves them via ensureOverlayHandles). */
let editsObjectShardHandle: DocHandle<ObjectShard> | null = null
let editsConnectionShardHandle: DocHandle<ConnectionShard> | null = null
let editsObjectSegmentHandles: DocHandle<ObjectShard>[] = []
let editsConnectionSegmentHandles: DocHandle<ConnectionShard>[] = []
const overlayChangeHandlers = new Map<string, () => void>()
let objectOverlayWrites = 0
let connectionOverlayWrites = 0
const retiredOverlayHandles = new Map<
  DocumentId,
  DocHandle<ObjectShard> | DocHandle<ConnectionShard>
>()
let overlayAckTimer: ReturnType<typeof setTimeout> | null = null
/** True while ensureOverlayHandles is resolving (so a flush doesn't kick it twice). */
let overlayResolving = false
let cancelDeferredOverlayHydration: (() => void) | null = null
/** Crash-recovery journal for entity edits (see entityIntents.ts). Hydrated in
 * parallel with boot; replay waits on this so neither ordering of (journal
 * hydrated, overlay handles resolved) can skip it. */
let entityIntentHydration: Promise<void> = Promise.resolve()
/** False until this session's hydration resolved — the badge treats an unread
 * journal as a debt, never as an empty one. */
let entityIntentsHydrated = false
/** Single-flight guard for maybeReplayEntityIntents. */
let entityIntentReplaying = false
/** A replay requested while one was running — consumed in the finally. */
let entityIntentReplayFollowUp: { withoutHandles?: boolean } | null = null
/** Once per session: the degraded (no write head) replay schedules a flush that
 * fails and lands back in ensureOverlayHandles' catch — without this latch that
 * is an infinite replay/flush loop on a damaged workspace. */
let entityIntentsDegradedReplayed = false
/** Once per session, like the degraded latch: the resident replay runs at boot
 * only — afterwards the resident write path itself is the durability story. */
let entityIntentsResidentReplayed = false
/** A resident replay request that arrived while the (shared) replay lock was
 * held — run it when the lock frees instead of dropping it. */
let entityIntentResidentFollowUp = false

/** False until this session's placement-journal hydration resolved — same
 * unknown-is-a-debt rule as the entity journal. */
let placementIntentsHydrated = false

/** The ONE sum all three 'ready'-producing badge sites go through. */
function pendingDurabilityCount(): number {
  return pendingDurabilityDebts({
    // A rescue still owed is an edit the server does not show yet — never
    // "Synced" over it. Nor over a local write no document holds yet.
    // T-DIAGDEF-2: nor over a WHOLE-MODEL diagram delete no document holds yet.
    // That plane journals no delete intent (`captureExplicitDeletes` is
    // boot-from-server only; the whole-model branch clears the intent and
    // counts on the registry write), so when the write cannot express it — a
    // registry shard unresolved at the flush, a frozen contract —
    // `LocalDiagramHold` is the only record of it, until a complete registry no
    // longer lists the id (`retirePendingLocalDiagrams`). Boot-from-server
    // counts the same delete through its entity-intent journal.
    durableHeadCount: durableHeads.size + pendingOverlayRescues.size + residentPendingWrites.size
      + (bfsActive ? 0 : localDiagramHold.heldDeletions),
    durableLedgerHydrated: durableLedgerHydrated(),
    writeSchedulerPending: writeScheduler.pending,
    entityIntentCount: pendingEntityIntents.pendingCount(workspaceRefKey(currentRef)),
    entityIntentsHydrated,
    placementIntentCount: pendingPlacementIntents.pendingCount(workspaceRefKey(currentRef)),
    placementIntentsHydrated,
  })
}
/** id → last-written entity REF, so writeEditsShards sets ONLY the entries that
 * actually changed (targeted O(changed) write), keeping per-edit cost flat regardless
 * of how large the overlay grows. */
const lastWrittenObj = new Map<string, C4Object>()
const lastWrittenConn = new Map<string, Connection>()

function rebuildEffectiveObjectOverlay(handle: DocHandle<ObjectShard>): void {
  const delta = updateOverlaySegment(
    editsObjectSegmentHandles.map((entry) => entry.documentId),
    objectOverlaySegments,
    effectiveObjectOverlay,
    handle.documentId,
    (handle.doc()?.objects ?? {}) as Record<string, C4Object>,
  )
  for (const id of delta.deleteIds) {
    overlayObjectIds.delete(id)
    if (!dirtyObjectIds.has(id)) editsObjects.delete(id)
  }
  for (const [id, object] of delta.upserts) {
    overlayObjectIds.add(id)
    if (dirtyObjectIds.has(id)) continue
    editsObjects.set(id, object)
    lastWrittenObj.set(id, object)
  }
}

function rebuildEffectiveConnectionOverlay(handle: DocHandle<ConnectionShard>): void {
  const delta = updateOverlaySegment(
    editsConnectionSegmentHandles.map((entry) => entry.documentId),
    connectionOverlaySegments,
    effectiveConnectionOverlay,
    handle.documentId,
    (handle.doc()?.connections ?? {}) as Record<string, Connection>,
  )
  for (const id of delta.deleteIds) {
    overlayConnectionIds.delete(id)
    if (!dirtyConnectionIds.has(id)) editsConnections.delete(id)
  }
  for (const [id, connection] of delta.upserts) {
    overlayConnectionIds.add(id)
    if (dirtyConnectionIds.has(id)) continue
    editsConnections.set(id, connection)
    lastWrittenConn.set(id, connection)
  }
}
// Slice D: OFF-window entities selected for editing (e.g. from the Model Objects /
// Connections page). They aren't in the windowed store, so updateObject/Connection
// can't mutate them — hydrate the selected one into the store (kept by the overlay)
// so its edits flow through the normal path. Pruned when deselected (unless edited →
// then it's in editsObjects and persists).
const hydratedForEdit = new Map<string, C4Object>()
const hydratedConnForEdit = new Map<string, Connection>()
// Delete tracking (boot-from-server). Under the windowed store a LOCAL removal from
// s.objects/s.connections is a real model DELETE — remove-from-diagram leaves the entity
// in s.objects (only delete*/deleteSelectedItems removes it). We diff the store against
// the previous tick's ids (derived `lower` connections excluded — their churn isn't a
// delete) and record tombstones, written to ModelMeta.deletedObjectIds/deletedConnectionIds
// so the server read model + compaction delete the entities from the base shards the client
// can't load. `prev*Ids` is the diff baseline, refreshed every projection + store tick.
const tombstoneObjects = new Set<string>()
const tombstoneConnections = new Set<string>()
/**
 * Groups deleted this session.
 *
 * SESSION-SCOPED on purpose, unlike the two above. A group lives whole inside
 * ModelMeta — `writeSmallCollections` reconciles `m.groups` in full — so the
 * delete is durable the moment it flushes and there is no immutable base shard
 * for a document tombstone to mark. A persisted `deletedGroupIds` would also be
 * a list nothing ever clears: the daily compaction folds `objects` and
 * `connections` only. What this set is for is the registry meta of NON-ACTIVE
 * diagrams, whose composition `flushWrite` preserves verbatim from the shard —
 * without it a deleted group's id survives a reload there.
 */
const tombstoneGroups = new Set<string>()
// Ids un-tombstoned this session (a delete that was undone / the entity re-appeared) that
// may already have been written to ModelMeta — writeTombstones splices them back out so an
// undo isn't permanently deleted server-side.
const unTombObjects = new Set<string>()
const unTombConnections = new Set<string>()
/**
 * DIAGRAM delete tombstones, the fourth member of the family.
 *
 * Hydrated at boot from `ModelMeta.deletedDiagramIds` (exactly like
 * `tombstoneObjects`) and grown by EXPLICIT user deletions only
 * (`captureExplicitDeletes` ← `pendingDeletedDiagramIds`). Under a summary-only
 * registry this is both the write source and the client-side read filter: the
 * registry is server-owned and its baseline shards are frozen, so the only
 * place the client can say "this diagram is gone" is ModelMeta.
 *
 * NEVER fed from the resident window. `state.diagrams` is a bounded slice of a
 * registry that can hold 10 000 entries, so a window-derived tombstone set
 * would delete the workspace on the first flush (`diagramTombstonePlan.ts`).
 */
const tombstoneDiagrams = new Set<string>()
const unTombDiagrams = new Set<string>()
/**
 * SESSION-CREATED diagrams whose removal `writeSummaryLocalRegistry` expressed
 * in the write-head shard (T-DIAGDEF (1)). Their deletion is as durable as a
 * tombstone — the write head is the one document that listed them — but it is
 * deliberately NOT a tombstone (`planDiagramTombstones` defers them), so
 * `tombstoneDiagrams` drops them at that moment. Published to the store with
 * the tombstones (`publishDiagramTombstones`): the summary Diagrams page is
 * served by the SERVER and its one removal signal is the store's
 * `deletedDiagramIds`, so without this the card of a diagram created and
 * deleted in the same session stayed until a reload. Session state only (the
 * server row is gone with the head entry); an id created again leaves it.
 */
const retiredSessionDiagramIds = new Set<string>()
const decisionRecordPageBaseline = new Map<string, DecisionRecord>()
// Small-collections write guard (boot-from-server): groups/domains/tags/decisionRecords are
// RESIDENT (s.* = the full set, projected from ModelMeta), so they're written back to
// ModelMeta here — reconcile only when one changed (by ref), like writeModelShards does.
let lastSmall: { groups: unknown; domains: unknown; tags: unknown; decisionRecords: unknown } | null = null
/**
 * The small-collection crash journal's capture state. The LOGIC lives in
 * smallCollectionCapture.ts (pure and unit-tested, because the unit tier is
 * structurally blind to bridge.ts, where every test mocks the module). The
 * bridge owns only the WIRING: which sites seed (durable provenance ONLY — the
 * pre-overlay projection values, a completed flush, the replay's own writes;
 * never an `applyingRemote` heuristic, whose re-entrant
 * `clearExplicitDeleteIntents` tick would reseed the baseline out from under
 * the delete diff and silently un-journal every group delete), which site
 * diffs (detectEdits, user ticks under bfsActive), and which site acks
 * (writeSmallCollections, value-checked).
 */
const SMALL_INTENT_KINDS = SMALL_COLLECTION_INTENT_KINDS
const smallCapture = new SmallCollectionCapture()
// The diagram-scoped families' capture layers — comments/flows
// (per-diagram doc maps, active-window slices) and diagram stubs (registry
// identity). Same baseline contract, same pure-module rationale.
const DIAGRAM_INTENT_KINDS = DIAGRAM_COLLECTION_INTENT_KINDS
const diagramCapture = new DiagramCollectionCapture()
const stubCapture = new DiagramStubCapture()
/** Diagram ids whose freshly created DiagramDoc has not yet been confirmed
 * durable by `repo.flush` — their registry meta (the docUrl pointer) is NOT
 * placed until it has. This enforces the create→flush→publish invariant on
 * the ordinary client creation path: otherwise the meta could land in an
 * already-synced shard while the doc died with the tab, leaving a permanently
 * unopenable zombie stub (a cold open's `repo.find` never settles). */
const pendingDurableDiagramDocs = new Set<string>()
// Live-sync (boot-from-server): PostgreSQL-backed SSE invalidation is the normal
// trigger; a slow interval is recovery. Refreshes coalesce and wait for local edits.
let lastLocalEditAt = 0
let liveSyncTimer: ReturnType<typeof setInterval> | null = null
let liveSyncRefreshTimer: ReturnType<typeof setTimeout> | null = null
let liveSyncInvalidationUnsubscribe: (() => void) | null = null
let liveSyncRefreshInFlight = false
let liveSyncRefreshRequested = false
let pendingLiveGeneration = -1
let lastServerProjectionGeneration = -1
// Self-echo suppression. flushWrite reconciles the active diagram doc + ModelMeta + shards,
// and each of those emits a 'change' event whose handler re-projects the store — under
// boot-from-server via the ASYNC projectActiveFromServer (a full server-render re-fetch). So
// a local edit echoes back as a re-fetch that re-seeds the store from the just-flushed (now
// slightly stale) snapshot, clobbering the field the user is actively typing in (dropped
// letters in flow/ADR descriptions) and re-rendering the whole canvas each keystroke ("not
// fluid"). We stamp a short window around our own writes; change-handler re-projections are
// skipped within it (the store already holds the local edit). REMOTE changes outside the
// window still re-project, and workspace invalidation backstops anything missed in-window.
let suppressEchoUntil = 0
const ECHO_SUPPRESS_MS = 200
/** Re-project from a doc/shard 'change' event, unless it's the echo of our own just-flushed
 * write (see suppressEchoUntil). Used by every shard/meta/model change handler. The
 * suppression only applies under boot-from-server, where the re-projection is an async
 * render re-fetch that can clobber an in-flight edit; the normal path re-projects
 * synchronously with no clobber, so it's never suppressed. */
function reprojectFromChange(): void {
  lastModelActivityAt = Date.now()
  if (bfsActive && Date.now() < suppressEchoUntil) return
  // Not inside a hop's latch. Measured on an aged stack (a diagram of ~3 000
  // shapes, two other tabs writing every 120 ms), each remote change
  // re-projected the store and redrew the whole canvas: the hopping tab's main
  // thread was busy 100 % of the time (CPU profile: 68 % in the canvas render
  // loop), its 50 ms timer late by more than 200 ms four ticks in five, and the
  // latch's acknowledgement — answered by the server in 3–8 ms — resolved
  // 1.1–1.5 s after it was sent: no latch (2 s) ever settled, 0 hops in 5.
  // Input is blocked during the latch and the swap projects everything at its
  // end; the remote changes that arrive meanwhile are projected ONCE, right
  // after the latch.
  if (hopLatched()) {
    if (!reprojectDeferredByLatch) {
      reprojectDeferredByLatch = true
      reprojectionsDeferredByLatch += 1
      outsideHopLatch(() => { reprojectDeferredByLatch = false; withRemote(projectAll) })
    }
    return
  }
  withRemote(projectAll)
  // A rescued overlay value whose entity is projected again now.
  if (pendingOverlayRescues.size > 0) setTimeout(() => outsideHopLatch(applyPendingOverlayRescues), 0)
}
let reprojectDeferredByLatch = false
/** When the model last changed here — a change handler re-projected, or a
 * local write (a starved hop waits for a quiet moment). */
let lastModelActivityAt = 0
/** Probe: latches during which remote changes waited for the latch's end. */
let reprojectionsDeferredByLatch = 0

/** Array → id-keyed map (the reconcile target shape). */
function byIdMap<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  const out: Record<string, T> = {}
  for (const item of items) out[item.id] = item
  return out
}

/**
 * `reconcile(doc[key], target)` for a by-id map the document may not hold:
 * `reconcile` on an absent map is a silent no-op (measured: resident addGroup on
 * a meta without `groups` left no group and no journal entry). An EMPTY target
 * creates nothing — two peers each creating the same key is an Automerge
 * conflict that hides the loser's puts — otherwise create, then reconcile the
 * RE-READ proxy (`local/no-detached-container-write`). The map's schema is the
 * collection's (`COLLECTION_SCHEMAS[key]`): an absent id is deleted, an
 * entity's unknown fields are kept (V0-08).
 */
function reconcileMapField(doc: object, key: EntityCollection, target: Record<string, unknown>): void {
  const fields = doc as Record<string, unknown>
  if (fields[key] === undefined || fields[key] === null) {
    if (Object.keys(target).length === 0) return
    fields[key] = {}
  }
  reconcile(fields[key], target, COLLECTION_SCHEMAS[key])
}

/** Never copy a server-paged immutable ADR baseline into ModelMeta. */
function reconcileDecisionRecordCollection(meta: ModelMeta, records: readonly DecisionRecord[]): void {
  if (!usesDecisionRecordDelta(meta)) {
    reconcileMapField(meta, 'decisionRecords', byIdMap(records))
    return
  }
  const overlayIds = new Set(Object.keys(meta.decisionRecords ?? {}))
  const currentIds = new Set(records.map((record) => record.id))
  // Tombstone edits are IN PLACE (push/splice), never a fresh-array
  // assignment: Automerge treats a reassigned list as a NEW object and LWW
  // picks one whole list, discarding a colleague's concurrently-pushed
  // tombstone — their ADR delete would resurrect (the same rule
  // writeTombstones follows).
  if (!meta.deletedDecisionRecordIds) meta.deletedDecisionRecordIds = []
  const tombstoned = new Set(meta.deletedDecisionRecordIds)
  for (const id of decisionRecordPageBaseline.keys()) {
    if (!currentIds.has(id)) {
      if (!tombstoned.has(id)) {
        meta.deletedDecisionRecordIds.push(id)
        tombstoned.add(id)
      }
      if (meta.decisionRecords?.[id] !== undefined) delete meta.decisionRecords[id]
    }
  }
  const lifted = new Set<string>()
  for (const record of changedDecisionRecords(records, decisionRecordPageBaseline, overlayIds)) {
    if (tombstoned.has(record.id)) lifted.add(record.id)
    const clean = stripUndefined(record)
    // Created only right before a write (`local/no-detached-container-write`).
    if (!meta.decisionRecords) meta.decisionRecords = {}
    if (meta.decisionRecords[record.id]) reconcile(meta.decisionRecords[record.id], clean, DECISION_RECORD_SCHEMA)
    else meta.decisionRecords[record.id] = clean
  }
  if (lifted.size) {
    for (let i = meta.deletedDecisionRecordIds.length - 1; i >= 0; i--) {
      if (lifted.has(meta.deletedDecisionRecordIds[i])) meta.deletedDecisionRecordIds.splice(i, 1)
    }
  }
}

/** The currently-open diagram's Automerge handle (or null before one is open).
 * The history UI operates directly on this handle. */
export function getActiveDiagramHandle(): DocHandle<DiagramDoc> | null {
  return activeDiagramHandle
}

/** Subscribe to the live DiagramDoc handle without polling or coupling
 * presence to the large model store. The current value is delivered
 * synchronously so late-mounted consumers attach immediately. */
export function subscribeActiveDiagramHandle(
  listener: (handle: DocHandle<DiagramDoc> | null) => void,
): () => void {
  activeDiagramHandleListeners.add(listener)
  listener(activeDiagramHandle)
  return () => activeDiagramHandleListeners.delete(listener)
}

function notifyActiveDiagramHandle(): void {
  for (const listener of activeDiagramHandleListeners) listener(activeDiagramHandle)
}

function withRemote(fn: () => void): void {
  // A remote write can land synchronously INSIDE a recorded canvas action (a
  // store subscriber re-entering under this flag, e.g. the hydration of a
  // selected off-window entity). Report it, so undo never replays it as the
  // user's own change.
  const recordedBefore = undoHistory.recording ? useModelStore.getState() : null
  applyingRemote = true
  try {
    fn()
  } finally {
    applyingRemote = false
    if (recordedBefore) undoHistory.noteRemote(recordedBefore, useModelStore.getState())
  }
}

// ── shard helpers ─────────────────────────────────────────────────────────────

/** Attach a change listener to a shard handle (idempotent). */
function attachShardListener(handle: DocHandle<RegistryShard>): void {
  if (shardChangeHandlers.has(handle.url)) return
  activeDocumentShare.pin(handle.documentId, 'registry-shard')
  // The absence sweep fires OUTSIDE reprojectFromChange on purpose: under
  // boot-from-server the re-projection is echo-suppressed for 200 ms windows
  // and projectAll early-returns entirely, so a remote delete's only live
  // signal in the flagship mode is this raw event. The sweep is journal-driven and early-exits when nothing
  // diagram-scoped is pending, so over-firing on our own echoes is cheap.
  const handler = (): void => {
    scheduleDiagramAbsenceSweep()
    reprojectFromChange()
    // T-DIAGDEF-2: a shard moving is the likeliest moment a held
    // whole-model delete can be expressed — at once, not at the next retry.
    if (!bfsActive && !workspaceContractStale && localDiagramHold.heldDeletions > 0) scheduleWrite('normal')
  }
  shardChangeHandlers.set(handle.url, handler)
  handle.on('change', handler)
}

/** Detach and remove all shard listeners. */
function detachAllShardListeners(): void {
  for (const [url, handler] of shardChangeHandlers) {
    const h = shardHandles.find((s) => s.url === url)
    if (h) {
      h.off('change', handler)
      activeDocumentShare.unpin(h.documentId, 'registry-shard')
    }
  }
  shardChangeHandlers.clear()
}

/** Re-resolve shard handles when root.shardUrls changes (new shard appended). */
async function syncShardHandles(): Promise<void> {
  if (!rootHandle) return
  const root = rootHandle.doc()
  if (!root) return
  const currentUrls = new Set<string>(shardHandles.map((h) => h.url))
  const newUrls = uniqueUrls(root.shardUrls).filter((u) => !currentUrls.has(u))
  if (newUrls.length === 0) return
  for (const url of newUrls) {
    if (!isValidAutomergeUrl(url)) continue
    prepareDocumentRequest(url, 'registry-shard')
    const handle = await repo.find<RegistryShard>(url)
    await handle.whenReady()
    shardHandles.push(handle)
    attachShardListener(handle)
  }
}

// ── sharded model helpers ──────────────────────────────────────────────────────

/** Probe: overlay entries written back after a compaction's clear that never saw
 * their last edit. */
let overlayClearRescues = 0

/** Is `url` an edits-overlay segment of the current meta (a write head included)? */
function isOverlaySegmentUrl(url: string): boolean {
  const meta = modelMetaHandle?.doc()
  if (!meta) return false
  return [
    ...(readMetaUrls(meta, 'editsObjectShardUrls') ?? []), ...(readMetaUrls(meta, 'editsConnectionShardUrls') ?? []),
    readMetaUrl(meta, 'editsObjectShardUrl'), readMetaUrl(meta, 'editsConnectionShardUrl'),
  ].includes(url)
}

/**
 * With or without epochs (`overlayClearRescue.ts`): a REMOTE change deleted an
 * overlay entry that held an edit its author never saw — her offline edit,
 * inside an entry the compaction cleared meanwhile. Her value is applied again
 * AS AN EDIT of the entity where it lives now (`applyPendingOverlayRescues`),
 * once the projection shows it again: the compaction folded the entry into a
 * base shard, which may come AFTER the overlay segment in the meta's order and
 * so outrank anything written back into the segment (measured: 40 of 68 written
 * back there stayed hidden until the next compaction folded them). An entity
 * tombstoned here (a real delete) is left deleted.
 */
function rescueClearedOverlayEdits(handle: DocHandle<unknown>, payload: DocHandleChangePayload<unknown>): void {
  if (!payload.patches.some((p) => p.action === 'del' && p.path.length === 2)) return
  if (!isOverlaySegmentUrl(handle.url)) return
  const restore = clearedOverlayEditsToRestore(payload.patchInfo.before as never, payload.patchInfo.after as never, payload.patches)
  if (restore.length === 0) return
  const upserts: PendingOverlayRescue[] = []
  const replaced: PendingOverlayRescue[] = []
  for (const r of restore) {
    const key = `${r.collection}:${r.id}`
    const earlier = pendingOverlayRescues.get(key)
    if (earlier) replaced.push(earlier)
    const entry = { collection: r.collection, id: r.id, value: storeForm(r.value), seen: storeForm(r.seen), since: Date.now() }
    pendingOverlayRescues.set(key, entry)
    upserts.push(entry)
  }
  persistOverlayRescues(upserts, replaced)
  markClientTimeline('overlay.clear-rescue-pending', { document: handle.documentId, entries: restore.length })
  armOverlayRescueAttempt(0)
}

/**
 * Lost overlay values waiting to be applied again, in store form.
 * PERSISTED in the workspace's KV the moment they are found — a reload, a
 * closed tab, a base copy slow to arrive no longer lose them — read back at
 * boot, and counted as a durability debt (the badge says "Saving", not
 * "Synced") until an attempt finds nothing owed: her fields are in the
 * documents, or a later write superseded them, or the entity was tombstoned.
 * The browser that never comes back is the server's (G4-16k).
 */
type PendingOverlayRescue = StoredOverlayRescue
const pendingOverlayRescues = new Map<string, PendingOverlayRescue>()
/** Whether this session has READ the persisted rescues. Until it has, its memory
 * is a subset of them, so a write may only add: the removals it owes wait here,
 * and are written once the read is in: a persisted mirror written from memory
 * before memory has READ it deletes it. */
let overlayRescuesHydrated = false
let overlayRescueRemovalsOwed: PendingOverlayRescue[] = []
const OVERLAY_RESCUES_KEY = 'overlay-clear-rescues:v1'
/** How long a rescue waits for its entity (its folded copy still syncing). */
const OVERLAY_RESCUE_WAIT_MS = 7 * 24 * 60 * 60_000
/** Between two attempts while any is owed. */
const OVERLAY_RESCUE_RETRY_MS = 2_000
let overlayRescueTimer: ReturnType<typeof setTimeout> | null = null
let overlayRescuePersistence: Promise<void> = Promise.resolve()

/**
 * Write THIS tab's changes into the persisted rescues: its findings added, the
 * findings it finished removed — one atomic read-modify-write of the key
 * (`mergeStoredRescues`), never its memory written over what another tab, or
 * the previous session, stored. Before this session has read the key, removals
 * wait.
 */
function persistOverlayRescues(upserts: readonly PendingOverlayRescue[], removals: readonly PendingOverlayRescue[]): void {
  const store = durableLedgerStore ?? workspaceKvStore()
  let removing = [...removals]
  if (!overlayRescuesHydrated) {
    overlayRescueRemovalsOwed.push(...removing)
    removing = []
  }
  if (upserts.length === 0 && removing.length === 0) return
  const adding = [...upserts]
  overlayRescuePersistence = overlayRescuePersistence.catch(() => undefined).then(async () => {
    await store.update<PendingOverlayRescue[]>(OVERLAY_RESCUES_KEY, (stored) => mergeStoredRescues(stored, adding, removing))
  }).catch((error) => { console.warn('overlay rescues could not be persisted', error) })
}

/** Boot: the rescues an earlier session (or another tab) found and did not
 * finish. One already in memory — found live while the read ran — is kept
 * (never replaced by its stored copy); one this session finished meanwhile is
 * not taken back. Then the removals owed since the boot are written. */
async function hydrateOverlayRescues(epoch: number, store: KvStore): Promise<void> {
  const stored = await store.get<unknown>(OVERLAY_RESCUES_KEY).catch(() => undefined)
  if (epoch !== durableAckEpoch) return
  const finished = new Set(overlayRescueRemovalsOwed.map((r) => `${r.collection}:${r.id}:${r.since}`))
  for (const entry of mergeStoredRescues(stored, [], [])) {
    const key = `${entry.collection}:${entry.id}`
    if (finished.has(`${key}:${entry.since}`)) continue
    if (!pendingOverlayRescues.has(key)) pendingOverlayRescues.set(key, entry)
  }
  overlayRescuesHydrated = true
  const owed = overlayRescueRemovalsOwed
  overlayRescueRemovalsOwed = []
  if (owed.length > 0) persistOverlayRescues([], owed)
  if (pendingOverlayRescues.size > 0) armOverlayRescueAttempt(0)
}

function armOverlayRescueAttempt(ms: number): void {
  if (overlayRescueTimer) return
  const session = durableAckEpoch
  overlayRescueTimer = setTimeout(() => {
    overlayRescueTimer = null
    if (session !== durableAckEpoch) return
    outsideHopLatch(applyPendingOverlayRescues)
  }, ms)
}

/** Apply each pending rescue whose entity the documents hold again, the
 * fields `rescuePatch` says are still owed, as an edit written where the
 * entity lives now; dropped (and unpersisted) once nothing is owed. */
function applyPendingOverlayRescues(): void {
  if (pendingOverlayRescues.size === 0) return
  const state = useModelStore.getState()
  const now = Date.now()
  let objectsInDocs: Record<string, unknown> | null = null
  let connectionsInDocs: Record<string, unknown> | null = null
  const finished: PendingOverlayRescue[] = []
  for (const [key, rescue] of pendingOverlayRescues) {
    const objects = rescue.collection === 'objects'
    const tombstoned = (objects ? tombstoneObjects : tombstoneConnections).has(rescue.id)
    if (tombstoned || now - rescue.since > OVERLAY_RESCUE_WAIT_MS) {
      pendingOverlayRescues.delete(key)
      finished.push(rescue)
      continue
    }
    // The entity as the DOCUMENTS hold it (not as the store shows it), merged
    // as the projection merges them.
    if (objects) objectsInDocs ??= mergeObjectShards(objectShardHandles.map((h) => h.doc() ?? { objects: {} })) as Record<string, unknown>
    else connectionsInDocs ??= mergeConnectionShards(connectionShardHandles.map((h) => h.doc() ?? { connections: {} })) as Record<string, unknown>
    const inDocs = (objects ? objectsInDocs : connectionsInDocs)![rescue.id] as Record<string, unknown> | undefined
    const inStore = (objects ? state.objects : state.connections).find((e) => e.id === rescue.id) as Record<string, unknown> | undefined
    if (!inDocs || !inStore) continue
    const patch = rescuePatch(rescue.value as Record<string, unknown>, rescue.seen as Record<string, unknown>, inDocs, inStore)
    if (!patch) {
      pendingOverlayRescues.delete(key)
      finished.push(rescue)
      continue
    }
    // Outside the undo history: a Ctrl+Z right after she reconnects must not
    // take her offline value away again. Still a local edit: written,
    // journaled, acknowledged like any other. Kept pending until an attempt
    // finds it in the documents.
    undoHistory.suppress(() => {
      if (objects) state.updateObject(rescue.id, patch as never)
      else state.updateConnection(rescue.id, patch as never)
    })
    overlayClearRescues += 1
  }
  if (finished.length > 0) persistOverlayRescues([], finished)
  if (pendingOverlayRescues.size > 0) armOverlayRescueAttempt(OVERLAY_RESCUE_RETRY_MS)
}

/** Attach a change listener to a meta/object/connection shard handle (idempotent). */
function attachModelShardListener(handle: DocHandle<unknown>): void {
  if (modelShardChangeHandlers.has(handle.url)) return
  activeDocumentShare.pin(handle.documentId, 'model-shard')
  const handler = (payload?: DocHandleChangePayload<unknown>) => {
    // An edit the overlay compaction's clear never saw is written back, before
    // the re-projection shows its loss.
    if (payload && handle !== modelMetaHandle) rescueClearedOverlayEdits(handle, payload)
    // A warm browser can resolve its cached ModelMeta before selective sync
    // merges a server-side write-head rotation/repair. Hydrate the newly
    // published current heads as soon as that small control document changes.
    if (bfsActive && handle === modelMetaHandle) scheduleOverlayHydration()
    // Before re-projecting: a remote ADR overlay write has to reach the store, or
    // the next flush reconciles our stale copy back over it (see the function).
    if (handle === modelMetaHandle) reseedOverlayDecisionRecords()
    // Diagram tombstones, the REMOTE half. A twin (or another tab) deleting a diagram lands
    // here as a new id in `deletedDiagramIds`; without adopting it the window
    // filter below never sees it and the diagram keeps rendering, then gets
    // re-published by the next write pass. A remote disappearance must NOT
    // produce a local intent — it IS the tombstone — so nothing is journaled.
    if (handle === modelMetaHandle && registrySummaryOnly) adoptRemoteDiagramTombstones()
    reprojectFromChange()
    // A shard the meta lists now (a compaction's new base shard) is projected.
    if (handle === modelMetaHandle) followListedModelShards()
  }
  modelShardChangeHandlers.set(handle.url, handler)
  handle.on('change', handler)
}

function detachAllModelShardListeners(): void {
  for (const [url, handler] of modelShardChangeHandlers) {
    const h =
      modelMetaHandle?.url === url
        ? modelMetaHandle
        : objectShardHandles.find((s) => s.url === url) ??
          connectionShardHandles.find((s) => s.url === url)
    if (h) {
      ;(h as DocHandle<unknown>).off('change', handler)
      activeDocumentShare.unpin(h.documentId, 'model-shard')
    }
  }
  modelShardChangeHandlers.clear()
}

/** Overlay segments are absent from objectShardHandles under the server-boot
 * path. Listen to the bounded active segments explicitly so a second editor's
 * CRDT update reaches the in-memory overlay before the SQL/SSE repair cycle.
 * Local dirty values always win until their flush completes. */
function attachOverlayChangeListener(handle: DocHandle<ObjectShard>, kind: 'object'): void
function attachOverlayChangeListener(handle: DocHandle<ConnectionShard>, kind: 'connection'): void
function attachOverlayChangeListener(
  handle: DocHandle<ObjectShard> | DocHandle<ConnectionShard>,
  kind: 'object' | 'connection',
): void {
  if (overlayChangeHandlers.has(handle.url)) return
  const handler = (payload?: DocHandleChangePayload<unknown>) => {
    if (payload) rescueClearedOverlayEdits(handle as DocHandle<unknown>, payload)
    if (kind === 'object') rebuildEffectiveObjectOverlay(handle as DocHandle<ObjectShard>)
    else rebuildEffectiveConnectionOverlay(handle as DocHandle<ConnectionShard>)
    reprojectFromChange()
  }
  overlayChangeHandlers.set(handle.url, handler)
  handle.on('change', handler)
}

function detachAllOverlayChangeListeners(): void {
  for (const [url, handler] of overlayChangeHandlers) {
    const handle = editsObjectSegmentHandles.find((entry) => entry.url === url)
      ?? editsConnectionSegmentHandles.find((entry) => entry.url === url)
    handle?.off('change', handler)
  }
  overlayChangeHandlers.clear()
}

/**
 * Resolve the sharded model.
 *
 *  - Already sharded (root.modelMetaUrl set): load the ModelMeta + object/connection
 *    shard handles.
 *  - Not sharded: return false — the workspace stays a monolith on the resident
 *    write path, and the caller keeps boot-from-server off. The browser must
 *    NOT split the monolith here (see the branch below); sharding an existing
 *    monolith is server maintenance's job.
 *
 * Returns true on success. Attaches change listeners.
 */
async function ensureModelSharded(): Promise<boolean> {
  // modelHandle may be null under boot-from-server (the monolith isn't loaded);
  // the sharded branch below doesn't need it.
  if (!rootHandle) return false
  const root = rootHandle.doc()
  if (!root) return false

  if (root.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl)) {
    modelMetaHandle = await findModelMetaHandle(root.modelMetaUrl)
    // The epoch this session booted on: a root repointing away from it
    // starts the live hop (step 1, `maybeStartEpochHop`).
    bootedMetaUrl = root.modelMetaUrl
    await hydrateEpochKnowledge(modelMetaHandle)
    // A retired export an earlier session neither exported nor dismissed is
    // offered again. A KV read, in the background: never on the path to the
    // first render. Only on a workspace with epochs (none can be retired
    // elsewhere: flag off reads nothing).
    if (epochCapability) void raisePersistedRetiredExport()
    const metaDoc = modelMetaHandle.doc()
    if (!metaDoc) return false
    // The ruling URL values as plain strings (`modelMetaUrls.ts`).
    const meta = withMetaUrlView(metaDoc)
    // Write-head boot guard: a sharded root does not guarantee a USABLE write path.
    // With unusable heads, boot-from-server accepts every edit and can persist
    // none of it (the "born-broken" shape). When the
    // overlay provably holds nothing, downgrade to the resident write path —
    // base shards are the whole model and need no heads, so edits are durable
    // immediately instead of camping in the crash journal until a server
    // repair. When overlay content MAY exist, resident projection would hide
    // it (it merges no overlay and filters no meta tombstones), so stay on
    // boot-from-server degraded: journal + honest badge + drain-on-repair.
    if (bfsActive) {
      const planned = planBfsWriteMode(meta, isValidAutomergeUrl)
      // …with ONE exception, and it is not a preference: on a SUMMARY root there
      // is no resident path to fall back TO. The base shards are not the model
      // there — the baseline lives in the server read model — so a resident boot
      // would show the active diagram's window and call it the workspace, and
      // getting there costs a re-materialization of every registry shard (the
      // 77.6 s wall this migration exists to remove). Its writes would then be
      // refused by the server's baseline write fence, i.e. the downgrade buys a
      // slower boot, a truncated model AND an unwritable one. `bfs-degraded` is
      // the correct degraded mode for a summary root: reads keep coming from the
      // server render, writes camp in the crash journal behind an honest badge,
      // and a server head repair drains them live.
      const summaryRoot = root.registrySummaryOnly === true
      const writeMode: BfsWriteMode =
        planned.mode === 'resident-fallback' && summaryRoot
          ? { mode: 'bfs-degraded', reason: `${planned.reason} (summary root: no resident baseline to fall back to)` }
          : planned
      if (writeMode.mode === 'resident-fallback') {
        // Flip BEFORE any capture/drain/projection predicate reads it — they
        // are all spelled `bfsActive`.
        bfsActive = false
        markClientTimeline('workspace.bfs.refused', { reason: writeMode.reason })
        console.warn(
          `boot-from-server refused (${writeMode.reason}); booting resident — `
          + 'repair the overlay heads server-side: npm run repair:overlay-heads',
        )
      } else if (writeMode.mode === 'bfs-degraded') {
        markClientTimeline('workspace.bfs.degraded', { reason: writeMode.reason })
        console.warn(`boot-from-server write path is degraded (${writeMode.reason}); edits will be journaled until a server repair`)
      }
    }
    // Boot-from-server (step 2c): the active diagram is projected from the server
    // render, so the client never loads the model shards — skip them entirely
    // (read-only mode). Only the ModelMeta is needed, for the resident small
    // collections (groups/domains/tags/decisionRecords).
    if (bfsActive) {
      objectShardHandles = []
      connectionShardHandles = []
      tombstoneObjects.clear()
      tombstoneConnections.clear()
      // Not reloaded from the document: group deletes are not persisted as
      // tombstones (see tombstoneGroups), so a fresh attach starts empty.
      tombstoneGroups.clear()
      for (const id of meta.deletedObjectIds ?? []) tombstoneObjects.add(id)
      for (const id of meta.deletedConnectionIds ?? []) tombstoneConnections.add(id)
      // Diagram tombstones: same hydration, same branch. This set is BOTH the
      // write source and the read filter for the summary registry window, so it
      // must carry what previous sessions (and other clients) already
      // tombstoned — otherwise a cold boot re-renders every diagram a colleague
      // deleted earlier.
      tombstoneDiagrams.clear()
      unTombDiagrams.clear()
      for (const id of meta.deletedDiagramIds ?? []) tombstoneDiagrams.add(id)
      publishDiagramTombstones()
      // No `scheduleDiagramStubReplay()` is needed here: a replay cannot fire
      // between `started = true` and this hydration, because every route into
      // `replayDiagramStubIntents` needs a resident ModelMeta first
      // (`ensureOverlayHandles` returns at its own `if (!modelMetaHandle)`,
      // `scheduleOverlayHydration` runs only after `ensureModelSharded` or from
      // the ModelMeta change handler, the reconnect route is wired later, and
      // `flushWrite` guards on the same handle). The ordinary junction re-expresses
      // a journaled-but-unwritten delete at the next boot; see
      // `bridgeSummaryDelete.test.ts`.
    } else {
      objectShardHandles = await getModelShardHandles<ObjectShard>(uniqueUrls(meta.objectShardUrls))
      connectionShardHandles = await getModelShardHandles<ConnectionShard>(uniqueUrls(meta.connectionShardUrls))
    }
    // Shards this browser created whose pointer is still held back. Resumed on
    // both paths so they get published; only the resident path writes model
    // shards, so only it keeps the handles (appended after the published ones,
    // in the order they were created).
    const held = await resumeDeferredModelShardReferences(
      modelMetaHandle,
      new Set([...(meta.objectShardUrls ?? []), ...(meta.connectionShardUrls ?? [])]),
    )
    if (!bfsActive) {
      objectShardHandles.push(...held.objects)
      connectionShardHandles.push(...held.connections)
    }
  } else {
    // Do NOT split the monolith here, in the browser. A client-created
    // ModelMeta (splitModel().meta) carries NO overlay write heads — head
    // minting belongs to the server — and that head-less shape silently eats
    // every entity edit under boot-from-server (fsck: model-write-head). A
    // browser also cannot prove its children reached SERVER storage before the
    // parent points at them, so no client-side variant of this split is safe.
    // Sharding an existing monolith is server maintenance's job; until it
    // runs, the workspace stays a monolith on the resident write path — the
    // caller flips bfsActive off when this returns false, which keeps the
    // write and projection paths consistent.
    markClientTimeline('workspace.sharding.deferred-to-server', {
      reason: 'monolith split is server maintenance; the client cannot mint write heads',
    })
    return false
  }

  attachModelShardListener(modelMetaHandle as DocHandle<unknown>)
  for (const h of objectShardHandles) attachModelShardListener(h as DocHandle<unknown>)
  for (const h of connectionShardHandles) attachModelShardListener(h as DocHandle<unknown>)
  // Listed between the list's read and the listener's attach.
  followListedModelShards()
  return true
}

// ── THE LIVE EPOCH HOP: the ports (G4-16f; state machine in epochHop.ts) ──
//
// The server periodically recreates the ModelMeta and the base shards without
// history (an epoch) and repoints `root.modelMetaUrl`; late writes on the
// superseded documents are forwarded. An open tab follows the repoint LIVE
// (design point 4): the root handler starts the hop, which loads the new epoch
// in the background, then swaps under one bounded latch once the old
// documents' paused heads are acknowledged `durable && forwarded`.

interface EpochHandles {
  metaUrl: string
  meta: DocHandle<ModelMeta>
  objects: DocHandle<ObjectShard>[]
  connections: DocHandle<ConnectionShard>[]
}

/** The ModelMeta URL this session projects (booted on, or hopped to). */
let bootedMetaUrl: string | null = null
let epochHop: EpochHop | null = null
/** The handles the running hop loaded (step 3): the retired export reads them. */
let hopLoaded: EpochHandles | null = null
/** The old epoch's documents, between the swap and `retainOld`. */
let swappedOut: DocHandle<unknown>[] | null = null
/** Every ModelMeta this session hopped away from: a held pointer recorded
 * against one of them is written to the current meta (`writeHeldReference`). */
const supersededMetaDocumentIds = new Set<DocumentId>()
/** Retained old sets, attached and SYNCING (pinned) until forwarded. */
const retainedEpochSets = new Map<RetainToken, DocHandle<unknown>[]>()
let retainedEpochSeq = 0
let epochHopRetryTimer: ReturnType<typeof setTimeout> | null = null
/** Probe: swaps that found a write deferred by their latch. */
let deferredWritesAtSwap = 0
/** Probe: write requests the latch deferred. */
let writesDeferredByLatch = 0
/** The retired documents the running hop collected (step 6). */
let retiredEpochDocumentIds: DocumentId[] = []
/** Model shards THIS browser created (overflow) or resumed as held: never an
 * epoch's base shard, always carried across a swap until the new meta lists
 * them (a pointer written to the OLD meta during the latch would
 * otherwise drop the shard's objects from the screen). */
const locallyCreatedModelShardUrls = new Set<string>()
/** The documents the running hop's acknowledgements named as
 * SUPERSEDED epoch documents (`forwarded` present, `forwardPending` or
 * `epochRetired`). One of this browser's own shards among them was CUT by
 * the roll — a full roll recreates every base shard of the list, the
 * browser's overflow ones included (X → X′ in place): it is retained and
 * forwarded like the epoch's other documents, never carried over its copy. */
const hopLateSources = new Set<string>()
/** Whether this workspace has (or may get) epochs — the server
 * says so on each durable acknowledgement, an epoch ModelMeta says so by its
 * `modelEpoch` hint. Sticky per workspace (KV). Gates the hop, the actor
 * journal's persistence and the override review. */
let epochCapability = false
/** Where the capability came from (probe): the KV, the meta's mark, or an ack. */
let epochCapabilityFrom: 'kv' | 'meta' | 'ack' | null = null
/** ModelMetas this browser has booted on in this workspace (KV):
 * a held pointer recorded against one of them — a shard created offline on
 * an epoch that has since been superseded — is published to the current meta
 * after a reload, instead of being given up. */
const EPOCH_CAPABILITY_KEY = 'epoch-capability:v1'
const EPOCH_RETAINED_ROLE = 'epoch-retained'
/** Boot-from-server reads for the override review: bounded. */
const EPOCH_FETCH_MAX = 200
const EPOCH_FETCH_CONCURRENCY = 8
/** The hop's event timeline (probe `hopTrace`): latch, flush, asks, targets. */
const hopTrace: Array<Record<string, unknown>> = []
const HOP_TRACE_MAX = 400
const EPOCH_HOP_RETRY_MS = 10_000
/** A hop that gave up on the S7 proof (`epoch_hop.s7_unproven`) is started again
 * on this slow timer — the roll stopped between S6b and S7 is resumed by the
 * server's next pass, and the root (which already names the new meta) never
 * changes again to restart it — and at once when the durable ledger answers one
 * of the held epoch's documents `epochRetired` (retention reached the epoch the
 * tab still writes: the retired path offers those edits as an export). */
export const EPOCH_HOP_ABANDONED_RETRY_MS = 10 * 60_000
let epochHopAbandonedRetryMs = EPOCH_HOP_ABANDONED_RETRY_MS
/** The url of the hop that gave up on S7, until it is started again. */
let epochHopAbandonedUrl: string | null = null
let epochHopAbandonedTimer: ReturnType<typeof setTimeout> | null = null
export function __setEpochHopAbandonedRetryForTest(ms: number | null): void {
  epochHopAbandonedRetryMs = ms ?? EPOCH_HOP_ABANDONED_RETRY_MS
  epochHopAbandonedDelayMs = epochHopAbandonedRetryMs
}
/** Start the abandoned hop again (the timer fired, or the ledger saw its
 * epoch retired). */
function heldEpochRetiredIn(answers: readonly unknown[]): boolean {
  const held = new Set(heldEpochDocuments().map((h) => h.documentId as string))
  return answers.some((a) => {
    const answer = a as { documentId?: unknown; epochRetired?: unknown }
    return answer.epochRetired === true && typeof answer.documentId === 'string' && held.has(answer.documentId)
  })
}
function resumeAbandonedEpochHop(): void {
  if (epochHopAbandonedTimer) clearTimeout(epochHopAbandonedTimer)
  epochHopAbandonedTimer = null
  if (epochHopAbandonedUrl === null) return
  epochHopAbandonedUrl = null
  epochHopAbandonedDelayMs = epochHopAbandonedRetryMs
  maybeStartEpochHop()
}

/** The timer does not restart the hop blind — a roll still stopped between S6b
 * and S7 would cost ten more latches (input blocked up to 2 s each) every
 * cycle, for ever. ONE acknowledgement, no latch, about the old meta: restarted
 * only when it proves S7 (`forwarded` or `epochRetired` present); otherwise the
 * timer is armed again, its delay doubled (10, 20, 40… min, at most 160). */
let epochHopAbandonedDelayMs = EPOCH_HOP_ABANDONED_RETRY_MS
const EPOCH_HOP_ABANDONED_RETRY_MAX_MS = 160 * 60_000
function armAbandonedEpochHopTimer(): void {
  if (epochHopAbandonedTimer) clearTimeout(epochHopAbandonedTimer)
  epochHopAbandonedTimer = setTimeout(() => { epochHopAbandonedTimer = null; void probeAbandonedEpochHop() }, epochHopAbandonedDelayMs)
}
async function probeAbandonedEpochHop(): Promise<void> {
  const session = durableAckEpoch
  const meta = modelMetaHandle
  if (epochHopAbandonedUrl === null || !meta) return
  const heads = documentHeads(meta as DocHandle<unknown>)
  let proven = false
  if (heads) {
    const answers = await acknowledgeDurableDocumentHeads([{ documentId: heads.documentId as DocumentId, heads: heads.heads }]).catch(() => [])
    const answer = answers.find((a) => a.documentId === heads.documentId) as Record<string, unknown> | undefined
    proven = answer !== undefined && ('forwarded' in answer || answer.epochRetired === true)
  }
  if (session !== durableAckEpoch || epochHopAbandonedUrl === null || modelMetaHandle !== meta) return
  if (proven) { resumeAbandonedEpochHop(); return }
  epochHopAbandonedDelayMs = Math.min(epochHopAbandonedDelayMs * 2, Math.max(EPOCH_HOP_ABANDONED_RETRY_MAX_MS, epochHopAbandonedRetryMs))
  armAbandonedEpochHopTimer()
}
const DURABLE_HEADS_BATCH = 64

function documentHeads(handle: DocHandle<unknown>): HopDocumentHeads | null {
  const doc = handle.doc()
  if (!doc) return null
  const heads = getHeads(doc as never)
  return heads.length > 0 ? { documentId: handle.documentId, heads } : null
}

/** The OLD epoch's documents this tab holds: the meta and the base shards its
 * meta lists — not an overflow shard this tab created whose pointer is still
 * held (it is not an epoch document; the swap carries it). */
function heldEpochDocuments(): DocHandle<unknown>[] {
  if (!modelMetaHandle) return []
  const meta = modelMetaHandle.doc()
  const view = meta ? withMetaUrlView(meta) : undefined
  const listed = new Set([...(view?.objectShardUrls ?? []), ...(view?.connectionShardUrls ?? [])])
  return [
    modelMetaHandle as DocHandle<unknown>,
    ...[...objectShardHandles, ...connectionShardHandles].filter((h) => listed.has(h.url)) as DocHandle<unknown>[],
  ]
}

function reattachOverlaySegmentListeners(): void {
  for (const h of editsObjectSegmentHandles) attachOverlayChangeListener(h, 'object')
  for (const h of editsConnectionSegmentHandles) attachOverlayChangeListener(h, 'connection')
}

/** Partition the just-projected store as the resident write path will, so the
 * first flush after a swap finds every shard unchanged (the boot seed's rule). */
function reseedResidentWriteBaselines(): void {
  const s = useModelStore.getState()
  const persisted = s.connections.filter((c) => c.kind !== 'lower')
  lastModelSlices = {
    objects: s.objects, connections: persisted, groups: s.groups, domains: s.domains, tags: s.tags, decisionRecords: s.decisionRecords,
  }
  if (!bfsActive) {
    lastObjectShardSlices = partitionByShard(s.objects, shardIndexByObjectId, objectShardHandles.length)
    lastConnectionShardSlices = partitionByShard(persisted, shardIndexByConnectionId, connectionShardHandles.length)
  }
}

function resetModelShardProjectionCaches(): void {
  for (const k of MODEL_KEYS) delete lastModelColl[k]
  lastObjectShardDocs = []
  lastConnectionShardDocs = []
  lastObjectShardSlices = []
  lastConnectionShardSlices = []
}

/** BOOT-FROM-SERVER tombstones after a swap: the new meta's, plus every delete
 * still journaled (not yet seen durable). Not the old session set whole: the
 * roll rides a compaction that CLEARS folded tombstones, and re-adding them
 * would re-append every one to the new meta. */
function hydrateTombstonesFrom(meta: ModelMeta): void {
  const journaled = pendingEntityIntents.pending(workspaceRefKey(currentRef)).filter((intent) => intent.op === 'delete')
  tombstoneObjects.clear()
  tombstoneConnections.clear()
  for (const id of meta.deletedObjectIds ?? []) tombstoneObjects.add(id)
  for (const id of meta.deletedConnectionIds ?? []) tombstoneConnections.add(id)
  for (const intent of journaled) {
    if (intent.kind === 'object') tombstoneObjects.add(intent.id)
    else if (intent.kind === 'connection') tombstoneConnections.add(intent.id)
  }
  for (const id of meta.deletedDiagramIds ?? []) tombstoneDiagrams.add(id)
  publishDiagramTombstones()
}

/** A shard THIS browser created (or resumed as held) that the server did not
 * name a late source: the swap carries it. The `hopLateSources` test is
 * equivalent for `verdictOf`'s exemption (a late source has an epoch row, so
 * `forwarded`, and is never exempted) but not for the swap's carry, where it
 * is what keeps a shard the roll cut from being carried over its copy. */
function isOwnCarriedShard(h: DocHandle<unknown>): boolean {
  return locallyCreatedModelShardUrls.has(h.url) && !hopLateSources.has(h.documentId)
}

/**
 * Random-id shards the swap carried that the OLD meta listed — their pointer
 * written there offline — and the new meta does not. When the old meta was
 * RETIRED by then, nothing forwards that pointer: the server never claims the
 * shard, and its author alone sees its objects. Their queued `unminted` entry
 * is asked about (`serverHoldsShard`, again until answered): UNKNOWN to the
 * server, the pointer is written into the CURRENT meta (as the boot's resume of
 * an unlisted entry does) and the entry dequeued once durable. HELD — an
 * ordinary document the old meta's pointer got claimed, whose forward adopts it
 * — it stays carried, as before. A late source is never carried, so never asked
 * here. Only once the predecessor walk reaches the entry's holder from the new
 * meta — a repoint to another lineage publishes nothing.
 *
 * When the old meta was RETIRED (the hop's retired path), no forward will ever
 * adopt its pointer, so HELD as a plain claim (durable, no epoch row: not a
 * shard a full roll cut, which answers `forwarded` or `epochRetired`) is
 * written into the current meta too. And a carried shard with NO queued
 * `unminted` entry is decided the same way: a MINTED shard (AUTH on) whose held
 * pointer the reconnect wrote into the old meta during the hop, its entry
 * dequeued then — before, nothing ever wrote it into the current meta, and its
 * objects left her screen at the next reload (2 088 → 2 048).
 */
/** Probe: `<shard>:<step>` of each carried decision. Bounded. */
const carriedDecisions: string[] = []
function noteCarried(shard: string, step: string): void {
  carriedDecisions.push(`${shard}:${step}`)
  if (carriedDecisions.length > 64) carriedDecisions.splice(0, carriedDecisions.length - 64)
}

async function decideCarriedUnminted(prevMetaId: DocumentId, handles: DocHandle<unknown>[], prevMetaRetired = false): Promise<void> {
  const session = durableAckEpoch
  for (const h of handles) noteCarried(h.documentId, 'swap')
  const byUrl = new Map<string, DocHandle<unknown>>(handles.map((h) => [h.url as string, h]))
  const booted = documentsWorkspaceKey()
  const listed = (await deferredReferences.list().catch(() => [] as DeferredReference[])).filter((r) =>
    r.unminted === true && isModelShardReferenceField(r.field) && byUrl.has(r.url)
    && (r.workspace === undefined || booted === null || r.workspace === booted))
  // A carried shard with no queued entry, decided only behind a RETIRED old
  // meta (a live one's forward adopts it).
  const entered = new Set(listed.map((r) => r.url))
  const unqueued: DeferredReference[] = prevMetaRetired
    ? handles.filter((h) => !entered.has(h.url)).map((h) => ({
      holderDocumentId: prevMetaId,
      field: connectionShardHandles.some((c) => c.url === h.url) ? 'connectionShardUrls' : 'objectShardUrls',
      url: h.url, unminted: true, ...workspaceTag(),
    }))
    : []
  for (const r of unqueued) noteCarried(byUrl.get(r.url)!.documentId, 'unqueued')
  const queued = [...listed, ...unqueued]
  const meta = modelMetaHandle
  if (queued.length === 0 || session !== durableAckEpoch || !meta) { for (const h of handles) noteCarried(h.documentId, 'no-entry'); return }
  const accepted = (r: DeferredReference) => r.holderDocumentId === prevMetaId || supersededMetaDocumentIds.has(r.holderDocumentId as DocumentId)
  // The walk loads the metas between (from the server: this tab never saw
  // them) under ONE budget; one cut short — a server slow to give them right
  // after a roll — is walked again on the unminted question's schedule (the
  // links it learned are persisted, so each try goes further), never given
  // up for the session on one try.
  for (let attempt = 0; !supersededMetaDocumentIds.has(prevMetaId); attempt += 1) {
    if (attempt > unmintedRetryDelaysMs.length) { for (const h of handles) noteCarried(h.documentId, 'walk-undecided'); return }
    if (attempt > 0) {
      // Settled by the stop too:
      // a cancelled timer left this promise pending for ever.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { unmintedRetryTimers.delete(timer); unmintedWaitResolvers.delete(resolve); resolve() }, unmintedRetryDelaysMs[attempt - 1])
        unmintedRetryTimers.add(timer)
        unmintedWaitResolvers.add(resolve)
      })
    }
    if (session !== durableAckEpoch || modelMetaHandle !== meta) return
    await extendPredecessorChain(meta).catch(() => false)
    if (session !== durableAckEpoch || modelMetaHandle !== meta) return
  }
  for (const reference of queued.filter(accepted)) {
    const handle = byUrl.get(reference.url)!
    noteCarried(handle.documentId, 'asked')
    const decide = (verdict: ShardVerdict | 'claimed') => outsideHopLatch(() => {
      noteCarried(handle.documentId, verdict)
      // `claimed` (a plain claim, asked only behind a retired old meta): no
      // forward will adopt the old meta's pointer, so it is written here.
      const write = verdict === 'unknown' || verdict === 'claimed'
      if (session !== durableAckEpoch || !write || !projectedModelShardUrls().has(handle.url)) return
      const written = writeHeldReference(reference, session)
      noteCarried(handle.documentId, written ? 'written' : 'not-written')
      if (written) {
        // Claimable only now. While nothing the server reads named it, every
        // re-presentation of X was refused and its budget may be spent (seen
        // in one e2e run in four: never claimed, the entry queued for good):
        // a NEW episode, presented again at once.
        deniedRecovery.noteAcknowledged(handle.documentId)
        resetDocumentSyncState(repo, handle.documentId)
      }
      // Redundant within a session whose boot resumed the entry (its own
      // dequeue waits for the same durability); kept for an entry the boot did
      // not settle (a later resume path).
      dequeueOnceDurable(handle, reference, session)
      markClientTimeline('workspace.held-shards.carried-published', { shard: handle.documentId })
    })
    void serverHoldsShard(handle, reference, undefined, prevMetaRetired).then((verdict) => {
      if (verdict === ANSWER_REFUSED) return
      if (unanswered(verdict)) askUnmintedUntilAnswered(handle, reference, session, decide, verdict, prevMetaRetired)
      else decide(verdict)
    })
  }
}

/** Step 4's swap, ATOMIC (`runAtomically`): on any failure the old epoch is
 * re-attached and re-projected, never a tab with no epoch. */
async function swapEpoch(next: EpochHandles, retired: readonly string[] = []): Promise<void> {
  const prevMeta = modelMetaHandle
  if (!prevMeta) throw new Error('epoch hop: no ModelMeta to swap from')
  // A write requested DURING the latch (not by input, which is blocked — by
  // code: a replay, an assistant action): the store holds it and the swap's
  // `projectAll` is about to replace the store from the new documents. Write
  // it to the OLD epoch first: those documents are retained until their
  // current heads are forwarded, so it reaches the new epoch, never lost.
  if (writeDeferredByHop) deferredWritesAtSwap += 1
  if (writeDeferredByHop) {
    writeDeferredByHop = false
    writesPausedByHop = false
    try {
      writeScheduler.request('normal')
      writeScheduler.flushNow()
    } finally {
      writesPausedByHop = true
    }
  }
  const prevObjects = objectShardHandles
  const prevConnections = connectionShardHandles
  const prevUrl = bootedMetaUrl
  const prevTombstones = { objects: [...tombstoneObjects], connections: [...tombstoneConnections], diagrams: [...tombstoneDiagrams] }
  const prevDoc = prevMeta.doc()
  const prevView = prevDoc ? withMetaUrlView(prevDoc) : undefined
  // Overflow shards this tab created: carried, so their objects never leave
  // the screen (and are written to after the swap) — whether their pointer
  // is still held (unlisted) or was written to the OLD meta during the latch
  // (listed there, not yet adopted by the new one).
  // NOT one the server named a late source — the roll cut it
  // and recreated it in the new list; carried, it would win the routing over
  // its copy and the next flush would empty the copy.
  const isOwn = isOwnCarriedShard
  const cutOwn = [...prevObjects, ...prevConnections]
    .filter((h) => locallyCreatedModelShardUrls.has(h.url) && hopLateSources.has(h.documentId)).map((h) => h.url)
  const carriedObjects = withCarried(
    unpublishedShards(prevObjects, prevView?.objectShardUrls ?? []),
    prevObjects.filter((h) => isOwn(h as DocHandle<unknown>)))
  const carriedConnections = withCarried(
    unpublishedShards(prevConnections, prevView?.connectionShardUrls ?? []),
    prevConnections.filter((h) => isOwn(h as DocHandle<unknown>)))
  const oldDocuments = heldEpochDocuments().filter((h) => !isOwn(h))
  const restoreTombstones = () => {
    tombstoneObjects.clear(); for (const id of prevTombstones.objects) tombstoneObjects.add(id)
    tombstoneConnections.clear(); for (const id of prevTombstones.connections) tombstoneConnections.add(id)
    tombstoneDiagrams.clear(); for (const id of prevTombstones.diagrams) tombstoneDiagrams.add(id)
  }
  try {
    runAtomically([
      {
        // Pinned BEFORE the detach (which unpins 'model-shard'): the old
        // documents never stop syncing — they are RETAINED until forwarded.
        name: 'retain-pin',
        run: () => { for (const h of oldDocuments) activeDocumentShare.pin(h.documentId, EPOCH_RETAINED_ROLE) },
        undo: () => { for (const h of oldDocuments) activeDocumentShare.unpin(h.documentId, EPOCH_RETAINED_ROLE) },
      },
      {
        name: 'detach',
        run: () => { detachAllModelShardListeners(); detachAllOverlayChangeListeners() },
        undo: () => {
          attachModelShardListener(prevMeta as DocHandle<unknown>)
          for (const h of prevObjects) attachModelShardListener(h as DocHandle<unknown>)
          for (const h of prevConnections) attachModelShardListener(h as DocHandle<unknown>)
          reattachOverlaySegmentListeners()
        },
      },
      {
        name: 'assign',
        run: () => {
          modelMetaHandle = next.meta
          objectShardHandles = bfsActive ? [] : withCarried(next.objects, carriedObjects)
          connectionShardHandles = bfsActive ? [] : withCarried(next.connections, carriedConnections)
          bootedMetaUrl = next.metaUrl
          const meta = next.meta.doc()
          if (bfsActive && meta) hydrateTombstonesFrom(meta)
        },
        undo: () => {
          modelMetaHandle = prevMeta
          objectShardHandles = prevObjects
          connectionShardHandles = prevConnections
          bootedMetaUrl = prevUrl
          restoreTombstones()
        },
      },
      {
        name: 'attach',
        run: () => {
          attachModelShardListener(next.meta as DocHandle<unknown>)
          for (const h of objectShardHandles) attachModelShardListener(h as DocHandle<unknown>)
          for (const h of connectionShardHandles) attachModelShardListener(h as DocHandle<unknown>)
          reattachOverlaySegmentListeners()
        },
        undo: () => { detachAllModelShardListeners(); detachAllOverlayChangeListeners() },
      },
      {
        name: 'project',
        run: () => {
          resetModelShardProjectionCaches()
          withRemote(projectAll)
          reseedResidentWriteBaselines()
        },
        undo: () => { resetModelShardProjectionCaches() },
      },
    ], (step, error) => console.error(`epoch hop: undo of ${step} failed`, error))
  } catch (error) {
    // Rolled back: re-project the old epoch so the store matches what is attached.
    try { withRemote(projectAll); reseedResidentWriteBaselines() } catch (reprojectError) {
      console.error('epoch hop: re-projection of the old epoch after a failed swap failed', reprojectError)
    }
    throw error
  }
  // The meta just left, IF it is the new one's epoch predecessor: a pointer
  // held on it is resumed into the new meta. A repoint to another lineage (a
  // repair, the slim script, a reseed) is followed, but never resurrects a
  // pointer held on the meta it left. A cut shard of this browser's is an epoch
  // document like the others now.
  for (const url of cutOwn) locallyCreatedModelShardUrls.delete(url)
  const nextPredecessor = predecessorIdOf(next.meta.doc())
  if (nextPredecessor === prevMeta.documentId) supersededMetaDocumentIds.add(prevMeta.documentId)
  // The link is persisted (a reload walks it without a load).
  void persistEpochLineage([[next.meta.documentId, nextPredecessor ?? '']])
  swappedOut = oldDocuments
  // An own random-id shard the OLD meta listed (written there offline) and the
  // new one does not — nothing forwards the old meta's pointer when that meta
  // was retired — is decided against the new meta in the background.
  const nextDoc = next.meta.doc()
  const nextView = nextDoc ? withMetaUrlView(nextDoc) : undefined
  const nextListed = new Set([...(nextView?.objectShardUrls ?? []), ...(nextView?.connectionShardUrls ?? [])])
  const prevListed = new Set([...(prevView?.objectShardUrls ?? []), ...(prevView?.connectionShardUrls ?? [])])
  const writtenIntoOld = [...carriedObjects, ...carriedConnections]
    .filter((h) => prevListed.has(h.url) && !nextListed.has(h.url) && !provisionalModelShardUrls.has(h.url)) as DocHandle<unknown>[]
  // On the retired path, the old meta's pointers are forwarded by no one.
  // Told by the machine with the swap (the verdict's retired ids),
  // not read from a global another step resets.
  const prevMetaRetired = retired.includes(prevMeta.documentId)
  if (writtenIntoOld.length > 0) void decideCarriedUnminted(prevMeta.documentId, writtenIntoOld, prevMetaRetired)
  // Boot-from-server: re-run the overlay heads against the new meta (a roll
  // carries them; a repair may not), then the server render.
  if (bfsActive) scheduleOverlayHydration()
  // What a compaction listed in the new meta between the load and the swap.
  followListedModelShards()
  checkHopAccountedLater()
  markClientTimeline('workspace.epoch.swapped', { metaUrl: next.metaUrl })
  // The batch re-apply is offered after the hop too, whenever the route
  // returns rows.
  void refreshOverrides()
}

// ── BATCH RE-APPLY: the bridge's ports (G4-16f; controller in
// epochOverridesController.ts) ──────────────────────────────────────────────

/** The Automerge actors this browser profile wrote with (whose override
 * rows it is offered): an actor is per page load × document handle, so they are recorded
 * at the write boundary and persisted, a reload keeping its offline edits'
 * actors visible to the override route. */
const localActorIds = new Set<string>()
const LOCAL_ACTORS_KEY = 'epoch-actors:v1'
const LOCAL_ACTORS_MAX = 256
let localActorsPersist: { timer: ReturnType<typeof setTimeout>; store: KvStore } | null = null
let uninstallEpochOverrides: (() => void) | null = null
/** The boot has read the actor journal: the review may be installed. */
let overridesReady = false

/** One acknowledgement at boot, so the server can say whether this workspace
 * has epochs before any write asks it. Offline: later acks will. */
async function probeEpochCapability(): Promise<void> {
  try {
    // Inside the try: a meta that is not (yet) an Automerge document makes
    // `getHeads` throw, and a boot probe must never leak a rejection.
    const heads = modelMetaHandle ? documentHeads(modelMetaHandle as DocHandle<unknown>) : null
    if (!heads) return
    await acknowledgeDurableDocumentHeads([{ documentId: heads.documentId as DocumentId, heads: heads.heads }])
  } catch { /* offline, refused or not loaded: the next acknowledgement says it */ }
}

/** The capability probes a repoint sends while the capability is unknown
 * (`createRepointProbeScheduler`, `epochBridgeRules.ts`): one series per
 * repoint target, stopped when the capability comes or the root goes back. */
const repointProbes = createRepointProbeScheduler({
  wanted: () => {
    const url = rootHandle?.doc()?.modelMetaUrl
    return started && !epochCapability && !!url && url !== bootedMetaUrl
  },
  probe: () => { void probeEpochCapability() },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
})

function probeCapabilityForRepoint(target: string): void {
  repointProbes.schedule(target)
}

function stopRepointProbes(): void {
  repointProbes.stop()
}

/** Write the actor list now, to the workspace store it was recorded for. */
function persistLocalActorsNow(): void {
  const pending = localActorsPersist
  if (!pending) return
  clearTimeout(pending.timer)
  localActorsPersist = null
  const session = [...localActorIds]
  // MERGED with what is stored: this may run before the boot's hydration has
  // read the list, and replacing it would hide earlier offline edits' actors.
  // In ONE atomic update: two tabs persisting in the same window would
  // otherwise each read the old list and the last write would drop the other
  // tab's actor — whose override rows would never be offered.
  void pending.store.update<string[]>(LOCAL_ACTORS_KEY, (stored) =>
    [...new Set([...(Array.isArray(stored) ? stored : []), ...session])].slice(-LOCAL_ACTORS_MAX))
    .catch((error) => { console.warn('epoch override actors could not be persisted', error) })
}

function recordLocalActor(handle: DocHandle<unknown>): void {
  const doc = handle.doc()
  if (!doc) return
  const actor = getActorId(doc as never)
  if (localActorIds.has(actor)) return
  localActorIds.add(actor)
  // Persisted ALWAYS (a design commitment): an edit made offline
  // before a workspace's FIRST roll is overridden by that roll, and its
  // review rows are keyed by this actor — kept in memory only, the next
  // session (another actor) would never be offered them. Bounded
  // (LOCAL_ACTORS_MAX), one debounced KV write per new actor.
  if (localActorsPersist) return
  localActorsPersist = { timer: setTimeout(persistLocalActorsNow, 250), store: workspaceKvStore() }
}

async function hydrateLocalActors(): Promise<void> {
  const stored = await workspaceKvStore().get<string[]>(LOCAL_ACTORS_KEY).catch(() => undefined)
  for (const actor of Array.isArray(stored) ? stored : []) if (typeof actor === 'string' && /^[0-9a-f]{2,128}$/.test(actor)) localActorIds.add(actor)
}

/** Every document this tab projects the model from, the overlay heads included. */
function modelDocumentsHeld(): DocHandle<unknown>[] {
  const handles = [
    modelMetaHandle, ...objectShardHandles, ...connectionShardHandles,
    editsObjectShardHandle, editsConnectionShardHandle, ...editsObjectSegmentHandles, ...editsConnectionSegmentHandles,
  ].filter((h): h is NonNullable<typeof h> => h !== null) as DocHandle<unknown>[]
  return [...new Map(handles.map((h) => [h.documentId, h])).values()]
}

/** The changes, in the projected documents, whose message matches. */
function changesWithMessage(match: (message: string) => boolean): Array<{ documentId: string; actor: string }> {
  const found: Array<{ documentId: string; actor: string }> = []
  for (const handle of modelDocumentsHeld()) {
    const doc = handle.doc()
    if (!doc) continue
    for (const raw of getAllChanges(doc as never)) {
      const change = decodeChange(raw)
      if (change.message && match(change.message)) found.push({ documentId: handle.documentId, actor: change.actor })
    }
  }
  return found
}

/** The documents the tagged flush running now has changed. */
let taggedCarriers: Set<string> | null = null

/** Whether none of `documentIds` is still owed to the server. */
function carriersDurable(documentIds: readonly string[]): boolean {
  const owed = new Set(durableHeads.snapshot().map((e) => e.documentId as string))
  return documentIds.every((id) => !owed.has(id))
}

function installEpochOverridePorts(): () => void {
  return installEpochOverrides({
    // The profile's journal read AGAIN at each refresh — the design's "actors
    // this browser profile has used". A tab read it at boot only, so the rows
    // of an actor another open tab of Marie recorded since were never offered
    // here. Signed in, the server adds every actor the user's tabs asked with
    // (other devices included).
    actorIds: async () => {
      await hydrateLocalActors()
      return [...localActorIds]
    },
    // Signed in, a device that never wrote asks too — the server lists the rows
    // of the actors her other devices recorded. Installed only on a workspace
    // with epochs: flag off, never.
    signedIn: async () => {
      const { useAuthStore } = await import('../../stores/authStore')
      const auth = useAuthStore.getState()
      return Boolean(auth.config && auth.config.stage !== 'off' && auth.user)
    },
    // A re-apply during a hop (latch, paused or deferred writes, or a hop in
    // flight) is refused: its flush could land on the epoch being left.
    writable: () => !writesPausedByHop && !writeDeferredByHop && (epochHop?.state().phase ?? 'idle') === 'idle',
    flushPending: () => writeScheduler.flushNow(),
    flushTagged(message) {
      // The store edit armed the write (onStoreChange); run it NOW, inside
      // the message scope, so every change it makes carries the batch id —
      // and collect WHICH documents those are: durability is asked of them.
      scheduleWrite('normal')
      const carriers = new Set<string>()
      taggedCarriers = carriers
      try {
        withChangeMessage(message, () => writeScheduler.flushNow())
      } finally {
        taggedCarriers = null
      }
      return [...carriers]
    },
    async whenDurable(carriers, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        // Only the batch's own carriers, never the whole ledger.
        if (!writesPausedByHop && !writeDeferredByHop && carriersDurable(carriers)) return true
        scheduleDurableAcknowledgement(0)
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      return false
    },
    changesWithMessage: (match) => changesWithMessage(match),
    carriersDurable,
    // A carrier the tab projects is read from its own handle: `syncedHandle`
    // alone skipped one not yet synced, and the server was then asked about
    // a subset of the batch's carriers.
    carrierHeads: (documentIds) => documentIds
      .map((id) => modelDocumentsHeld().find((h) => h.documentId === id) ?? syncedHandle(repo, id as DocumentId))
      .map((handle) => (handle ? documentHeads(handle as DocHandle<unknown>) : null))
      .filter((d): d is HopDocumentHeads => d !== null),
    async serverHolds(heads) {
      if (heads.length === 0) return false
      const answers = await acknowledgeDurableDocumentHeads(heads.map((d) => ({ documentId: d.documentId as DocumentId, heads: d.heads })))
      // A carrier whose epoch was RETIRED is no longer checked by the server —
      // `'retired'`, never a plain "not held".
      let retired = false
      for (const d of heads) {
        const answer = answers.find((a) => a.documentId === d.documentId) as { durable?: boolean; epochRetired?: boolean } | undefined
        if (answer?.durable === true) continue
        if (answer?.epochRetired === true) { retired = true; continue }
        return false
      }
      return retired ? 'retired' : true
    },
    // Boot-from-server: the store is the diagram's window; an entity the
    // window lacks is read from the server read model — BOUNDED: at most
    // EPOCH_FETCH_MAX ids, EPOCH_FETCH_CONCURRENCY at a time.
    fetchEntities: bfsActive
      ? async (collection, ids) => {
        const query = getModelQuery()
        const out = new Map<string, Record<string, unknown>>()
        const wanted = ids.slice(0, EPOCH_FETCH_MAX)
        // Never silent: the rows past the bound show without
        // their entity.
        if (ids.length > EPOCH_FETCH_MAX) console.warn(`epoch overrides: ${ids.length - EPOCH_FETCH_MAX} ${collection} beyond the first ${EPOCH_FETCH_MAX} are not fetched`)
        for (let i = 0; i < wanted.length; i += EPOCH_FETCH_CONCURRENCY) {
          await Promise.all(wanted.slice(i, i + EPOCH_FETCH_CONCURRENCY).map(async (id) => {
            const entity = collection === 'objects' ? await query.object(id)
              : collection === 'connections' ? await query.connection(id) : await query.group(id)
            if (entity) out.set(id, entity as unknown as Record<string, unknown>)
          }))
        }
        return out
      }
      : undefined,
    seedForEdit(collection, entity) {
      if (collection === 'objects') seedObjectForEdit(entity as unknown as C4Object)
      else if (collection === 'connections') seedConnectionForEdit(entity as unknown as Connection)
    },
  })
}

function plainDocument(handle: DocHandle<unknown> | null | undefined): Record<string, unknown> | null {
  const doc = handle?.doc()
  return doc ? JSON.parse(JSON.stringify(doc)) as Record<string, unknown> : null
}

function timelineDetail(event: Record<string, unknown>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(Object.entries(event).map(([key, value]) => [key,
    value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value as string | number | boolean | null : JSON.stringify(value)]))
}

/** Give back the 'model-shard' leases a hop's loads took, for the documents
 * the tab does not project. */
function releaseUnprojected(handles: EpochHandles): void {
  const projected = new Set<string>([
    ...(modelMetaHandle ? [modelMetaHandle.url] : []),
    ...objectShardHandles.map((h) => h.url), ...connectionShardHandles.map((h) => h.url),
  ])
  for (const h of [handles.meta, ...handles.objects, ...handles.connections]) {
    if (!projected.has(h.url)) releaseDocumentRequest(h.url, 'model-shard')
  }
}

function epochHopPorts(): EpochHopPorts<EpochHandles> {
  return {
    async load(metaUrl, signal) {
      hopLateSources.clear()
      noteHopObjectsAtLoad()
      const meta = await findModelMetaHandle(metaUrl)
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      const doc = meta.doc()
      if (!doc) throw new Error(`epoch hop: ModelMeta ${metaUrl} has no document`)
      const view = withMetaUrlView(doc)
      // Boot-from-server reads come from the server render: the meta only.
      const objects = bfsActive ? [] : await getModelShardHandles<ObjectShard>(uniqueUrls(view.objectShardUrls))
      const connections = bfsActive ? [] : await getModelShardHandles<ConnectionShard>(uniqueUrls(view.connectionShardUrls))
      const loaded = { metaUrl, meta, objects, connections }
      if (signal.aborted) { releaseUnprojected(loaded); throw new DOMException('aborted', 'AbortError') }
      hopLoaded = loaded
      return hopLoaded
    },
    drop(handles) {
      // Never projected: its listeners were never attached, but the loads
      // took a 'model-shard' lease each — given back, except for
      // a document the tab projects anyway.
      releaseUnprojected(handles)
      if (hopLoaded === handles) hopLoaded = null
    },
    holdsTargets(handles, targets) {
      const mine = new Map([handles.meta, ...handles.objects, ...handles.connections]
        .map((h) => [h.documentId as string, () => (h as DocHandle<unknown>).doc()]))
      return holdsTargets(mine, targets)
    },
    stillWanted: (metaUrl) => rootHandle?.doc()?.modelMetaUrl === metaUrl,
    oldHeads: () => heldEpochDocuments().map(documentHeads).filter((d): d is HopDocumentHeads => d !== null),
    carried: () => new Set(heldEpochDocuments().filter(isOwnCarriedShard).map((h) => h.documentId as string)),
    oldMetaDocumentId: () => (modelMetaHandle ? String(modelMetaHandle.documentId) : null),
    async acknowledge(documents, signal, options) {
      const out: HopAcknowledgement[] = []
      for (let i = 0; i < documents.length; i += DURABLE_HEADS_BATCH) {
        const batch = documents.slice(i, i + DURABLE_HEADS_BATCH).map((d) => ({ documentId: d.documentId as DocumentId, heads: d.heads }))
        out.push(...(await acknowledgeDurableDocumentHeads(batch, { signal, ...(options?.latch ? { latch: true } : {}) })) as HopAcknowledgement[])
      }
      for (const answer of out as Array<HopAcknowledgement & Record<string, unknown>>) {
        if ('forwarded' in answer || answer.forwardPending === true || answer.epochRetired === true) hopLateSources.add(answer.documentId)
      }
      return out
    },
    blockInput: () => useEpochHopStore.getState().setLatched(true),
    unblockInput: () => useEpochHopStore.getState().setLatched(false),
    async flushAndPauseWrites() {
      writeScheduler.flushNow()
      writesPausedByHop = true
    },
    resumeWrites() {
      writesPausedByHop = false
      if (writeDeferredByHop) {
        writeDeferredByHop = false
        writeScheduler.request('normal')
      }
      // The adoptions and unloads the latch held back.
      runAfterLatch()
    },
    swap: swapEpoch,
    // A starved hop latches in a quiet moment.
    quietForMs: () => Date.now() - lastModelActivityAt,
    retainOld(documents) {
      const keep = new Set(documents.map((d) => d.documentId))
      const all = swappedOut ?? []
      swappedOut = null
      hopLoaded = null
      // A RETIRED document (not in `documents`) will never be forwarded:
      // holding it buys nothing.
      for (const h of all) if (!keep.has(h.documentId)) activeDocumentShare.unpin(h.documentId, EPOCH_RETAINED_ROLE)
      retainedEpochSeq += 1
      retainedEpochSets.set(retainedEpochSeq, all.filter((h) => keep.has(h.documentId)))
      return retainedEpochSeq
    },
    retainedHeads: (token) => (retainedEpochSets.get(token) ?? []).map(documentHeads).filter((d): d is HopDocumentHeads => d !== null),
    releaseOld(token) {
      for (const h of retainedEpochSets.get(token) ?? []) activeDocumentShare.unpin(h.documentId, EPOCH_RETAINED_ROLE)
      retainedEpochSets.delete(token)
    },
    collectRetiredDiff(retired): RetiredExport {
      retiredEpochDocumentIds = retired.map((id) => id as DocumentId)
      const ids = new Set(retired)
      const loaded = hopLoaded
      return noteHopExported({
        version: 1,
        metaUrl: loaded?.metaUrl ?? '',
        collectedAt: new Date().toISOString(),
        differences: collectRetiredDifferences({
          retiredMeta: modelMetaHandle && ids.has(modelMetaHandle.documentId) ? plainDocument(modelMetaHandle as DocHandle<unknown>) : null,
          retiredObjectShards: objectShardHandles.filter((h) => ids.has(h.documentId)).map((h) => plainDocument(h as DocHandle<unknown>)),
          retiredConnectionShards: connectionShardHandles.filter((h) => ids.has(h.documentId)).map((h) => plainDocument(h as DocHandle<unknown>)),
          // Boot-from-server loads no base shard of the new epoch, so absence
          // cannot be told.
          currentShardsUnknown: bfsActive,
          current: {
            meta: plainDocument(loaded?.meta as DocHandle<unknown> | undefined),
            objects: mergeObjectShards((loaded?.objects ?? []).map((h) => h.doc() ?? { objects: {} })) as Record<string, unknown>,
            connections: mergeConnectionShards((loaded?.connections ?? []).map((h) => h.doc() ?? { connections: {} })) as Record<string, unknown>,
          },
        }),
      })
    },
    showRetired(diff) {
      // Persisted, merged with one already shown, until "Export" or a confirmed
      // "×". Exported: the retired documents are no longer owed to the server
      // (they never will be durable), so they stop holding the badge — once the
      // export is PERSISTED (forgotten in the same turn, a crash during the
      // write lost both, as the unlisted path, which waits for `safe`, does
      // not). A write that FAILED forgets them too — a private window has no
      // IndexedDB, the export is shown for the session, and owed for ever they
      // held the badge at "Saving" and were asked about every 750 ms. Only a
      // write still RUNNING keeps them owed.
      const retired = retiredEpochDocumentIds
      retiredEpochDocumentIds = []
      const session = durableAckEpoch
      void offerRetiredExport(diff as RetiredExport).then(() => {
        if (session !== durableAckEpoch) return
        durableHeads.forget(retired)
        queueDurableLedgerPersistence()
        scheduleDurableAcknowledgement(0)
      })
    },
    log(event) {
      markClientTimeline(String(event.event), timelineDetail(event))
      // Diagnostics (B1 convergence): the hop's own timeline, wall-clock so
      // it lines up with the server's trigger trace. Bounded.
      hopTrace.push({ t: Date.now(), ...event })
      if (hopTrace.length > HOP_TRACE_MAX) hopTrace.splice(0, hopTrace.length - HOP_TRACE_MAX)
      if (event.event === 'epoch_hop.s7_unproven') {
        console.warn('[epoch hop] the old meta\'s supersession (S7) was never proven; this tab stays on its epoch and tries again later', event)
        epochHopAbandonedUrl = typeof event.metaUrl === 'string' ? event.metaUrl : ''
        armAbandonedEpochHopTimer()
      }
      if (event.event === 'epoch_hop.failed') {
        console.warn('epoch hop failed; retrying', event)
        if (epochHopRetryTimer) clearTimeout(epochHopRetryTimer)
        epochHopRetryTimer = setTimeout(() => { epochHopRetryTimer = null; maybeStartEpochHop() }, EPOCH_HOP_RETRY_MS)
      }
    },
  }
}

/** Step 1, DETECT: called from the root handler. The root changes only by
 * sync, so this only fires online. Any repoint — a roll, the slim script, a
 * degenerate-root repair — is followed the same way (as the server's
 * projector follows it). */
function maybeStartEpochHop(): void {
  if (!started || !sharded || !modelMetaHandle || !bootedMetaUrl) return
  const url = rootHandle?.doc()?.modelMetaUrl
  if (!url || !isValidAutomergeUrl(url)) return
  // Back to the booted meta: a hop running towards another one is
  // cancelled, never swapped. Elsewhere — a design decision: followed only on
  // a workspace with epochs. A flag-off repoint (degenerate-root repair, the
  // slim script) leaves no forward journal behind it, so "durable on the old
  // meta" would not mean "in the new one"; such a tab keeps its booted meta
  // until reload, the pre-epoch behaviour (`repointAction`).
  const action = repointAction({ bootedMetaUrl, rootMetaUrl: url, capability: epochCapability })
  if (action === 'cancel') { epochHop?.cancel(); return }
  // Capability unknown (a tab booted before the first roll, idle since): ask,
  // a few times — the repoint can reach the tab before the roll that made it
  // has marked the workspace on the server (whose "no epochs" answer is
  // memoized up to 60 s). A `true` answer comes back through
  // `noteEpochCapability`, which calls this again.
  if (action === 'probe') { probeCapabilityForRepoint(url); return }
  if (action !== 'start') return
  if (!epochHop) epochHop = createEpochHop(epochHopPorts(), epochHopOptionsForTest)
  epochHop.start(url)
}

/** Tests only: the hop machine's timings (latch, backoff, S7 bound). */
let epochHopOptionsForTest: EpochHopOptions | undefined
export function __setEpochHopOptionsForTest(options: EpochHopOptions | null): void {
  epochHopOptionsForTest = options ?? undefined
}

/** The server or the ModelMeta says this workspace has epochs:
 * sticky per workspace; the actor journal starts persisting, the override
 * review is installed, a pending repoint is followed. */
function noteEpochCapability(epochs: boolean): void {
  // Sticky: a `false` never downgrades a known `true`.
  const next = nextEpochCapability(epochCapability, epochs)
  if (!started || next === epochCapability) return
  epochCapability = next
  epochCapabilityFrom = 'ack'
  void workspaceKvStore().set(EPOCH_CAPABILITY_KEY, true).catch(() => undefined)
  if (localActorIds.size > 0 && !localActorsPersist) {
    localActorsPersist = { timer: setTimeout(persistLocalActorsNow, 0), store: workspaceKvStore() }
  }
  if (!uninstallEpochOverrides && overridesReady) uninstallEpochOverrides = installEpochOverridePorts()
  // The boot raises a persisted retired export only when the capability is
  // known then; learned here (its KV write had failed), it is raised now.
  void raisePersistedRetiredExport()
  maybeStartEpochHop()
}

/** The persisted epoch lineage's key: per CONCRETE workspace, so a fork or
 * another version never shares its links. */
function epochLineageKey(): string {
  const workspace = documentsWorkspaceKey()
  return workspace ? `${EPOCH_LINEAGE_KEY}:${workspace}` : EPOCH_LINEAGE_KEY
}

/** Persist lineage links, merged atomically with what other tabs wrote. */
async function persistEpochLineage(links: ReadonlyArray<readonly [string, string]>): Promise<void> {
  if (links.length === 0) return
  await workspaceKvStore().update<EpochLineage>(epochLineageKey(), (stored) => withLineageLinks(stored, links))
    .catch((error) => { console.warn('epoch lineage could not be persisted', error) })
}

/** Walk `meta`'s predecessors (persisted lineage first, then `load`), learn
 * the links found, and accept their metas as holders of held pointers. */
async function walkPredecessors(meta: DocHandle<ModelMeta>, load: (url: string) => Promise<unknown>): Promise<boolean> {
  const stored = await workspaceKvStore().get<unknown>(epochLineageKey()).catch(() => undefined)
  const { chain, learned, complete } = await walkEpochLineage({
    current: meta.doc(), currentId: meta.documentId, lineage: withLineageLinks(stored, []), load,
  })
  await persistEpochLineage(learned)
  for (const id of chain) if (id !== meta.documentId) supersededMetaDocumentIds.add(id as DocumentId)
  return complete
}

/** A held pointer names a meta the lineage does not reach — walk again, LOADING
 * the missing predecessor metas, their leases given back. Two rolls the tab
 * never saw, then a reload: E(n)'s predecessor E(n−1) was never booted here.
 * Run in the BACKGROUND after the first render, under ONE budget for the whole
 * walk (PREDECESSOR_WALK_BUDGET_MS). True when the walk decided (reached the
 * chain's end). */
async function extendPredecessorChain(meta: DocHandle<ModelMeta>, budgetMs = predecessorWalkBudgetMs): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  return walkPredecessors(meta, async (url) => {
    const local = syncedHandle(repo, url.slice('automerge:'.length) as DocumentId)
    if (local?.isReady()) return local.doc()
    // From the SERVER (it was never here): the boot resolution of a meta,
    // bounded by what is LEFT of the walk's budget — less a reserve for the
    // authoritative question below (a meta the server stays SILENT about ran
    // the whole budget out, and the walk could never decide).
    const left = deadline - Date.now() - Math.min(PREDECESSOR_QUESTION_RESERVE_MS, budgetMs / 3)
    if (deadline - Date.now() <= 0) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const handle = await Promise.race([
        findModelMetaHandle(url),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PredecessorTimeoutError(url)), Math.max(0, left)) }),
      ])
      return handle.doc()
    } catch (error) {
      // GONE (deleted by the server's GC) is a decision; the budget running
      // out, or nobody to ask, is not: only on an answer that is
      // AUTHORITATIVE.
      if (await predecessorGone(error, url, deadline - Date.now())) return EPOCH_LINK_GONE
      throw error
    } finally {
      clearTimeout(timer)
      if (url !== modelMetaHandle?.url) releaseDocumentRequest(url as AutomergeUrl, 'model-shard')
    }
  })
}

/** The walk's own deadline for one predecessor's load (not the repo's). */
class PredecessorTimeoutError extends Error {
  constructor(url: string) { super(`epoch predecessor ${url} not resolved in time`); this.name = 'PredecessorTimeoutError' }
}

/** Kept out of a predecessor's load for the `epochRetired` question: at
 * most a third of the walk's budget. */
const PREDECESSOR_QUESTION_RESERVE_MS = 3_000

/** Boots, with the server reachable, whose walk never decided an entry set
 * aside for it: past this many, the entry is given up (otherwise it was
 * walked again at every boot, for ever). Counted apart from
 * the entry (`UNDECIDED_WALKS_KEY`), offline boots never. */
const UNDECIDED_WALK_LIMIT = 10
const UNDECIDED_WALKS_KEY = 'epoch-undecided-walks:v1'
/** The running walk's question about a predecessor got an answer at all… */
let predecessorQuestionAnswered = false
/** …and one said a predecessor is NOT retired. */
let predecessorAnsweredLive = false

/** Count one more undecided walk for `references` (url → boots), and give up
 * those that reach the limit; `decided` clears their counts. */
async function noteUndecidedWalks(references: readonly DeferredReference[], decided: boolean): Promise<void> {
  if (references.length === 0) return
  const reached: DeferredReference[] = []
  await workspaceKvStore().update<Record<string, number>>(UNDECIDED_WALKS_KEY, (old) => {
    const next = { ...(old && typeof old === 'object' ? old : {}) }
    for (const reference of references) {
      if (decided) { delete next[reference.url]; continue }
      const count = (next[reference.url] ?? 0) + 1
      if (count >= UNDECIDED_WALK_LIMIT) { reached.push(reference); delete next[reference.url] } else next[reference.url] = count
    }
    return next
  }).catch(() => undefined)
  for (const reference of reached) {
    console.warn(`held ${reference.field} entry ${reference.url}: its holder ${reference.holderDocumentId} was not reached in ${UNDECIDED_WALK_LIMIT} boots with the server reachable; given up`)
    await deferredReferences.remove(reference).catch(() => undefined)
  }
}

/** Test hook: the bound's counter. */
export const __noteUndecidedWalksForTest = noteUndecidedWalks

/** A well-formed head the server cannot hold: the durable-heads route needs
 * one per document, and `epochRetired` is read from the epoch rows, not
 * from the heads (`durableHeads.ts`). */
const NO_SUCH_HEAD = '0'.repeat(64)

/** Whether a predecessor meta's load failed because the meta is GONE —
 * decided only on an answer that says so: a deleted or invalid document
 * (`DocumentPermanentlyUnavailableError`), or "unavailable" when the SERVER,
 * asked about that meta, answers `epochRetired` (its `retired` row outlives
 * GC, `modelEpochRetire.ts`). "Unavailable" alone — a sync peer connected or
 * not — covers a server slow to load from storage, a meta outside the shared
 * scope for a moment, a cell hand-over: it decides nothing, so a live
 * predecessor answering it three boots in a row no longer gives its entries
 * up. */
async function predecessorGone(error: unknown, url: string, leftMs: number): Promise<boolean> {
  if (error instanceof DocumentPermanentlyUnavailableError) return true
  // A load the server stayed silent about is asked about like an "unavailable"
  // one.
  const unavailable = error instanceof DocumentTemporarilyUnavailableError || error instanceof PredecessorTimeoutError
  if (!unavailable || leftMs <= 0) return false
  const documentId = url.slice('automerge:'.length) as DocumentId
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(leftMs, unmintedAckTimeoutMs))
  try {
    const answers = await acknowledgeDurableDocumentHeads([{ documentId, heads: [NO_SUCH_HEAD] }], { signal: controller.signal })
    const answer = answers.find((a) => a.documentId === documentId) as { epochRetired?: unknown } | undefined
    // The server answered the round (an offline boot never gets here)…
    predecessorQuestionAnswered = true
    // …and, NOT retired: a live meta it is slow to give — the walk's
    // undecided bound does not count this boot (it is not gone).
    if (answer && answer.epochRetired !== true) predecessorAnsweredLive = true
    return answer?.epochRetired === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Boot: the epoch knowledge of this workspace — the sticky
 * capability, and the ModelMetas this browser has booted on, which a held
 * pointer may name after a roll and a reload. Bounded: every await here is a
 * KV read; a failure leaves the knowledge empty (the old behaviour). */
async function hydrateEpochKnowledge(meta: DocHandle<ModelMeta>): Promise<void> {
  const capability = await workspaceKvStore().get<boolean>(EPOCH_CAPABILITY_KEY).catch(() => undefined)
  // The metas a held pointer may name are the current meta's EPOCH PREDECESSORS
  // (its `epochPredecessorRef` chain), not every meta this browser once booted:
  // a repoint to another lineage or another version never resurrects a shard
  // abandoned there. Walked through the PERSISTED lineage (every link this
  // browser booted, swapped or loaded), and the metas this tab holds in memory
  // — no request here; a held pointer that needs a link nobody here has seen
  // loads it (`extendPredecessorChain`, at the resume).
  supersededMetaDocumentIds.clear()
  await walkPredecessors(meta, async (url) => {
    const handle = syncedHandle(repo, url.slice('automerge:'.length) as DocumentId)
    return handle?.isReady() ? handle.doc() : undefined
  })
  const markedEpoch = typeof (meta.doc() as { modelEpoch?: unknown } | undefined)?.modelEpoch === 'number'
  epochCapability = capability === true || markedEpoch
  epochCapabilityFrom = capability === true ? 'kv' : markedEpoch ? 'meta' : null
}

function stopEpochHop(): void {
  stopRepointProbes()
  if (epochHopRetryTimer) clearTimeout(epochHopRetryTimer)
  epochHopRetryTimer = null
  if (epochHopAbandonedTimer) clearTimeout(epochHopAbandonedTimer)
  epochHopAbandonedTimer = null
  epochHopAbandonedUrl = null
  epochHopAbandonedDelayMs = epochHopAbandonedRetryMs
  ledgerRetiredOffered.clear()
  epochHop?.stop()
  epochHop = null
  for (const handles of retainedEpochSets.values()) {
    for (const h of handles) activeDocumentShare.unpin(h.documentId, EPOCH_RETAINED_ROLE)
  }
  retainedEpochSets.clear()
  // Pinned for a swap and never handed to `retainOld`.
  for (const h of swappedOut ?? []) activeDocumentShare.unpin(h.documentId, EPOCH_RETAINED_ROLE)
  swappedOut = null
  if (hopLoaded) releaseUnprojected(hopLoaded)
  hopLoaded = null
  bootedMetaUrl = null
  retiredEpochDocumentIds = []
  supersededMetaDocumentIds.clear()
  locallyCreatedModelShardUrls.clear()
  hopLateSources.clear()
  pendingSetAside = null
  cancelUnmintedRetries()
  hopObjectsAtLoad = null
  hopExportedIds = new Set()
  hopUnaccountedObjects.length = 0
  followingModelShardUrls.clear()
  stopFollowRepresentations()
  provisionalModelShardUrls.clear()
  afterLatch = []
  // The projection it queued is dropped with `afterLatch`; left true, no later
  // latch — this session's or the next one's — would queue one again.
  reprojectDeferredByLatch = false
  // In memory only: the persisted copy waits for this workspace's next boot.
  pendingOverlayRescues.clear()
  // The next session reads the key again before it may remove from it; a
  // removal this one still owed is left to that read (the entry comes back,
  // finds nothing owed, and leaves).
  overlayRescuesHydrated = false
  overlayRescueRemovalsOwed = []
  // The overlay of owed local writes is cleared by `stopBridge` AFTER its
  // lifecycle flush: that flush reads it as a debt.
  if (overlayRescueTimer) clearTimeout(overlayRescueTimer)
  overlayRescueTimer = null
  epochCapability = false
  epochCapabilityFrom = null
  // A write the latch deferred is re-armed: the lifecycle flush
  // that follows in `stopBridge` then writes it.
  writesPausedByHop = false
  if (writeDeferredByHop) writeScheduler.request('normal')
  writeDeferredByHop = false
  useEpochHopStore.getState().reset()
}

/** Read-only probe (dev `window.__epochHop`, e2e assertions). */
/** The held-pointer queue of this workspace, for the e2e (an `unminted` entry
 * must leave it once the server holds the shard). */
export async function epochDeferredQueueProbe(): Promise<DeferredReference[]> {
  return deferredReferences.list().catch(() => [])
}

export function epochHopProbe(objectId?: string): {
  bootedMetaUrl: string | null; state: unknown; retainedSets: number; retainedDocuments: string[]
  objectShards: string[]; objectInShards?: unknown[]; writesDeferredByLatch: number; deferredWritesAtSwap: number
  heldHeads: HopDocumentHeads[]; retainedPins: number; hopTrace: Array<Record<string, unknown>>
  epochCapability: boolean; epochCapabilityFrom: string | null; durablePending: string[]
  predecessorMetas: string[]; repointProbePending: boolean; lineageKey: string
  unmintedRetriesPending: number; provisionalShards: string[]; connectionShards: string[]
  metaObjectShardUrls: string[]; carriedDecisions: string[]; hopUnaccountedObjects: string[]; followFailures: string[]; followRepresentations: number; reprojectionsDeferredByLatch: number; overlayClearRescues: number
  followRepresentWaits: number[]; overlayRescuesPending: number; residentPendingWrites: number
  residentDebt: (ResidentDebtDriverState & { writer: 'boot' | 'session' | null }) | null
  bootEditWatchActive: boolean; bridgeStarted: boolean
  objectInDocuments?: string[]; editsHeads?: Array<string | null>
} {
  return {
    bootedMetaUrl,
    epochCapability,
    epochCapabilityFrom,
    hopTrace: [...hopTrace],
    // How many documents hold the `epoch-retained` pin (a retained set must
    // keep syncing until it is forwarded).
    retainedPins: activeDocumentShare.snapshot().byRole[EPOCH_RETAINED_ROLE] ?? 0,
    heldHeads: heldEpochDocuments().map(documentHeads).filter((d): d is HopDocumentHeads => d !== null),
    writesDeferredByLatch,
    deferredWritesAtSwap,
    state: epochHop?.state() ?? { phase: 'idle' },
    retainedSets: retainedEpochSets.size,
    retainedDocuments: [...retainedEpochSets.values()].flat().map((h) => h.documentId),
    objectShards: objectShardHandles.map((h) => h.documentId),
    // What the durable ledger still owes the server.
    durablePending: durableHeads.snapshot().map(({ documentId }) => documentId as string),
    // The metas a held pointer may name (the epoch predecessors), and
    // whether a capability probe is pending.
    predecessorMetas: [...supersededMetaDocumentIds],
    repointProbePending: repointProbes.pending(),
    // Where the lineage is persisted (tests preload it).
    lineageKey: epochLineageKey(),
    // The armed questions about random-id shards (none after a
    // stop), and the shards shown while they wait for an answer.
    unmintedRetriesPending: unmintedRetryTimers.size,
    provisionalShards: [...provisionalModelShardUrls],
    connectionShards: connectionShardHandles.map((h) => h.documentId),
    // What the current meta lists, and the carried pointers this session asked
    // about and wrote.
    metaObjectShardUrls: (() => { const doc = modelMetaHandle?.doc(); return doc ? (readMetaUrls(doc, 'objectShardUrls') ?? []) : [] })(),
    carriedDecisions: [...carriedDecisions],
    // The hop's invariant alerts.
    hopUnaccountedObjects: [...hopUnaccountedObjects],
    // The follow's failed urls.
    followFailures: followFailureProbe(),
    followRepresentations,
    reprojectionsDeferredByLatch,
    overlayClearRescues,
    followRepresentWaits: [...followRepresentWaits],
    overlayRescuesPending: pendingOverlayRescues.size,
    residentPendingWrites: residentPendingWrites.size,
    // G4-16l: the debt's owner, the boot window, and whether a boot runs.
    residentDebt: residentDebtDriver ? { ...residentDebtDriver.state(), writer: residentDebtWriter } : null,
    bootEditWatchActive: bootEditWatch !== null,
    bridgeStarted: started,
    ...(objectId ? { objectInShards: objectShardHandles.map((h) => (h.doc()?.objects as Record<string, unknown> | undefined)?.[objectId] ?? null) } : {}),
    // Which held document — the overlay heads included — holds the object, and
    // what the meta names as its heads.
    ...(objectId ? {
      objectInDocuments: modelDocumentsHeld()
        .filter((h) => ((h.doc() as { objects?: Record<string, unknown> } | undefined)?.objects ?? {})[objectId] !== undefined)
        .map((h) => h.documentId as string),
      editsHeads: (() => { const doc = modelMetaHandle?.doc(); return doc ? [readMetaUrl(doc, 'editsObjectShardUrl') ?? null, ...(readMetaUrls(doc, 'editsObjectShardUrls') ?? [])] : [] })(),
    } : {}),
  }
}

/**
 * Pull remote changes to ADRs this client holds a PAGE copy of back into the store.
 *
 * Without this, a server-side repair to `ModelMeta.decisionRecords[id]` is undone
 * by the very next flush. `changedDecisionRecords` re-emits any id that is
 * already an overlay key — the `|| overlayIds.has(record.id)` term — so once the
 * repair creates that entry, reference-identity with the page baseline stops
 * protecting the record and `reconcileDecisionRecordCollection` reconciles the
 * client's STALE copy straight back over the repaired one (repair -> merge to
 * client -> client flush -> merge back, and the removed link is present
 * again). And the trigger is not an edit to that ADR:
 * `writeSmallCollections` guards all four small collections together, so
 * renaming a group is enough.
 *
 * Store and baseline are re-seeded TOGETHER on purpose. Updating the store alone
 * would leave the baseline stale; updating the baseline alone would make the
 * record look dropped-out, and `reconcileDecisionRecordCollection` TOMBSTONES
 * baseline ids missing from the store.
 *
 * There is deliberately NO `suppressEchoUntil` guard here. That window is a
 * TIME bet, and the predicate it is spelled with (`bfsActive`) does not match the
 * predicate of the hazard (`usesDecisionRecordDelta`), so it would be both
 * unnecessary in the cases it covers and absent in the ones it does not.
 * `overlayRecordsToReseed` instead refuses on STATE — it re-seeds only records
 * whose store copy is still reference-identical to the page baseline, which no
 * locally-edited record ever is, echo or not.
 */
function reseedOverlayDecisionRecords(): void {
  const store = useModelStore.getState().decisionRecords
  const byId = new Map(store.map((record) => [record.id, record]))
  const refreshed = overlayRecordsToReseed(modelMetaHandle?.doc(), decisionRecordPageBaseline, byId)
  if (refreshed.length === 0) return
  for (const record of refreshed) byId.set(record.id, record)
  projectDecisionRecordPage([...byId.values()], refreshed, false)
}

/** Project a bounded server ADR page without echoing the window into Automerge. */
export function projectDecisionRecordPage(
  records: DecisionRecord[],
  hydratedPage: readonly DecisionRecord[] = records,
  replace = false,
): void {
  if (replace) decisionRecordPageBaseline.clear()
  for (const record of hydratedPage) decisionRecordPageBaseline.set(record.id, record)
  withRemote(() => useModelStore.setState({ decisionRecords: records }))
  // A page swap replaces the ADR slice with durable server values —
  // reseed the capture baseline on the SAME synchronous tick, so the delete
  // diff in detectEdits can never read the previous page's ids (in the
  // baseline, absent from the new slice) as a burst of user deletes that the
  // replay would then execute as real ModelMeta deletions.
  if (bfsActive) smallCapture.seed({ decisionRecord: records })
}

/** Rebuild id → shard-index from loaded shard CONTENTS (the authoritative source
 * for stable routing). Cheap O(model) map fill; runs only when a shard doc changed. */
function rebuildObjectRoute(docs: (ObjectShard | undefined)[], listed: readonly boolean[] = []): void {
  rebuildRoute(shardIndexByObjectId, docs.map((d) => d?.objects), listed)
}
function rebuildConnectionRoute(docs: (ConnectionShard | undefined)[], listed: readonly boolean[] = []): void {
  rebuildRoute(shardIndexByConnectionId, docs.map((d) => d?.connections), listed)
}

/**
 * id → shard index, from the shards' contents: among the shards the meta
 * LISTS, the last one holding an id wins (list order is precedence). In
 * defence: a shard the meta does not list (carried, or loaded from
 * the held queue) never takes an id a listed shard holds — a recreated copy
 * (X′) must not be routed past, or it looks empty and the next flush empties
 * it. `listed[i]` absent: listed.
 */
function rebuildRoute(route: Map<string, number>, collections: Array<Record<string, unknown> | undefined>, listed: readonly boolean[]): void {
  route.clear()
  for (let i = 0; i < collections.length; i++) {
    if (listed[i] === false) continue
    for (const id of Object.keys(collections[i] ?? {})) route.set(id, i)
  }
  for (let i = 0; i < collections.length; i++) {
    if (listed[i] !== false) continue
    for (const id of Object.keys(collections[i] ?? {})) if (!route.has(id)) route.set(id, i)
  }
}

/** Per held shard, whether the current meta lists it. */
function listedInMeta(handles: readonly DocHandle<unknown>[], field: 'objectShardUrls' | 'connectionShardUrls'): boolean[] {
  const doc = modelMetaHandle?.doc()
  const urls = new Set(doc ? readMetaUrls(doc, field) ?? [] : [])
  return handles.map((h) => urls.has(h.url))
}

/** Merge order with the unlisted shards FIRST: the merge's later-wins makes a
 * listed shard's copy of an id the projected one. */
function listedLast<T>(docs: readonly T[], listed: readonly boolean[]): T[] {
  return [...docs.filter((_, i) => listed[i] === false), ...docs.filter((_, i) => listed[i] !== false)]
}

/**
 * `reconcile(shard[key], byIdMap(bucket))` restricted to the entities that
 * differ from what the shard already holds (`planCollectionReconcile`, read
 * against the materialized doc before the change). Measured 2026-10-11
 * (a Playwright connect-freeze probe, never committed; 739-diagram landscape): with the registry
 * pre-diff in place, this full-bucket walk was the largest remaining piece of
 * a connect's flush — 55 of ~100 ms — to add ONE connection. A shard whose doc
 * cannot be read, or holds no such collection, takes the unplanned path: an
 * absent map is created by `reconcileMapField` (bare `reconcile` was a silent
 * no-op there), an ARRAY is left to `reconcile`, which ignores mismatched kinds.
 */
function reconcileModelShardBucket(
  handle: DocHandle<ObjectShard> | DocHandle<ConnectionShard>,
  key: 'objects' | 'connections',
  bucket: readonly { id: string }[],
  /** In defence: ids this (unlisted) shard holds but that are
   * routed to a LISTED shard — left as they are, never deleted here (a delete
   * in a superseded shard is forwarded into the current epoch's copy). */
  keepForeign?: (id: string) => boolean,
): void {
  const target = byIdMap(bucket) as Record<string, unknown>
  const materialized = (handle.doc() as unknown as Record<string, Record<string, unknown> | undefined> | undefined)?.[key]
  if (keepForeign && materialized && typeof materialized === 'object' && !Array.isArray(materialized)) {
    for (const [id, value] of Object.entries(materialized)) if (!(id in target) && keepForeign(id)) target[id] = value
  }
  // Only a by-id MAP can be planned key by key; an array (a corrupt or
  // foreign shard) keeps the bare reconcile, an absent map is created.
  if (!materialized || typeof materialized !== 'object' || Array.isArray(materialized)) {
    changeAndTrack(handle as unknown as DocHandle<Record<string, unknown>>, (s) => {
      if (Array.isArray(s[key])) reconcile(s[key], target, COLLECTION_SCHEMAS[key])
      else reconcileMapField(s, key, target)
    })
    return
  }
  const schema = COLLECTION_SCHEMAS[key]
  const plan = planCollectionReconcile(materialized, target, schema)
  if (!plan) return
  changeAndTrack(handle as unknown as DocHandle<Record<string, unknown>>, (s) => {
    const draft = s[key]
    if (draft && typeof draft === 'object' && !Array.isArray(draft)) applyCollectionReconcile(draft as Record<string, unknown>, target, plan, schema)
    else reconcile(draft, target, schema)
  })
}

/** The concrete workspace a new model-shard entry is recorded in, or nothing
 * when the session cannot name it. */
function workspaceTag(): { workspace?: string } {
  const workspace = documentsWorkspaceKey()
  return workspace ? { workspace } : {}
}

/** Write a new model shard's url into ModelMeta — at once for a random-id
 *  shard, after the server's acknowledgement for a minted one (see
 *  writeModelShards and deferredReferences.ts). */
function publishModelShardReference(field: 'objectShardUrls' | 'connectionShardUrls', handle: DocHandle<unknown>): void {
  if (!modelMetaHandle) return
  if (!isMintedDocumentId(handle.documentId)) {
    changeAndTrack(modelMetaHandle, (m) => {
      // Through `modelMetaUrls.ts`, text or scalar by the marker.
      writeMetaUrls(m, field, [...(readMetaUrls(m, field) ?? []), handle.url])
    })
    // G4-16f: journaled too, until the server acknowledges the shard — written
    // offline into a meta a roll then supersedes, the pointer would otherwise
    // reach no tab booted after it. The first change's hash, read while the
    // shard's history is this one creation — the resume asks about it.
    const first = firstChangeHash(handle)
    const reference: DeferredReference = {
      holderDocumentId: modelMetaHandle.documentId, field, url: handle.url, unminted: true, ...workspaceTag(),
      ...(first ? { firstChange: first } : {}),
    }
    const persisted = deferredReferences.add(reference).catch((error) => {
      console.warn('random-id model-shard reference could not be journaled', error)
    })
    void serverDurability.wait(handle.documentId).then(async () => {
      await persisted
      await deferredReferences.remove(reference).catch(() => undefined)
    })
    return
  }
  const reference: DeferredReference = {
    holderDocumentId: modelMetaHandle.documentId,
    field,
    url: handle.url,
    ...workspaceTag(),
  }
  const epoch = durableAckEpoch
  const persisted = deferredReferences.add(reference).catch((error) => {
    // Unqueued, a held pointer would not survive this session, and a reload
    // would hide the shard's objects from their own author. Write it now: a
    // possible dangling pointer (the old behaviour) beats certain loss.
    console.warn('deferred model-shard reference could not be persisted; writing it now', error)
    writeHeldReference(reference, epoch)
  })
  holdReference(reference, handle.documentId, persisted)
}

/** Write a held pointer into the session's holder document — the ModelMeta for
 *  a model shard, the root for a registry shard — once. False when the session
 *  or the holder it was held for is gone. */
function writeHeldReference(reference: DeferredReference, epoch: number): boolean {
  if (epoch !== durableAckEpoch) return false
  const field = reference.field
  if (!isModelShardReferenceField(field)) {
    // No holder comparison: `rootHandle` is assigned once per session (after
    // the epoch bump in startBridge), so the epoch test above already rules
    // out another root, and a resumed entry for another root is given up
    // before it is held (resumeHeldReferences).
    const root = rootHandle
    if (!root) return false
    changeAndTrack(root, (draft) => {
      if (!draft.shardUrls.includes(reference.url)) draft.shardUrls.push(reference.url)
      if (reference.writeHead) draft.registryWriteUrl = reference.url
    })
    return true
  }
  const meta = modelMetaHandle
  // A held pointer recorded against a ModelMeta this session hopped AWAY from
  // (a writer that bypasses flushWrite) lands in the CURRENT meta: that is
  // where the forwarder's URL adoption would put it, without the round trip —
  // and without depending on the old meta still being retained when the
  // server's acknowledgement of the shard finally arrives.
  const holderIsCurrent = meta?.documentId === reference.holderDocumentId
    || (meta !== null && supersededMetaDocumentIds.has(reference.holderDocumentId as DocumentId))
  if (!meta || !holderIsCurrent) return false
  changeAndTrack(meta, (m) => {
    appendMetaUrl(m, field, reference.url)
  })
  return true
}

/** Boots after which a held shard this browser cannot load is given up. */
const HELD_SHARD_RESUME_LIMIT = 3

/** Write `reference` once the server acknowledges `documentId`, in THIS session
 *  only: a later session resumes it from the persisted queue instead. */
function holdReference(
  reference: DeferredReference,
  documentId: DocumentId,
  persisted: Promise<unknown>,
): void {
  const epoch = durableAckEpoch
  void serverDurability.wait(documentId).then(async () => {
    // Ordered after the add: a remove that overtook it would leave the entry
    // queued for ever (harmless at the next boot, which finds it published).
    await persisted
    if (!writeHeldReference(reference, epoch)) return
    await deferredReferences.remove(reference).catch((error) => {
      console.warn(`published ${reference.field} reference could not be dequeued`, error)
    })
  })
}

/**
 * The shared boot half of every held pointer kind. Takes the queue entries
 * `accepts` selects (the queue is one per workspace and carries ModelMeta and
 * root entries side by side — a resume must never count a failure against an
 * entry of the other kind), drops those already published, and loads the rest
 * from this browser's storage IN PARALLEL: each find is bounded
 * (HELD_SHARD_RESOLUTION), so the whole resume costs the boot at most one
 * budget however many entries are held.
 */
async function resumeHeldReferences<T>(options: {
  queued: readonly DeferredReference[]
  accepts: (reference: DeferredReference) => boolean
  holderDocumentId: string
  /** Another holder this workspace still answers for (a ModelMeta of an earlier
   * epoch this browser booted on). */
  acceptsHolder?: (holderDocumentId: string) => boolean
  holderName: string
  lost: string
  isPublished: (reference: DeferredReference) => boolean
  find: (url: string) => Promise<DocHandle<T>>
  onResumed: (reference: DeferredReference, handle: DocHandle<T>) => void
  /** An entry whose holder is not (yet) accepted is kept for a
   * later decision instead of being given up — true when it was. */
  setAside?: (reference: DeferredReference) => boolean
  /** The resume of a RANDOM-id entry (model shards only). */
  resumeUnminted?: (reference: DeferredReference, published: boolean, epoch: number,
    giveUp: (reference: DeferredReference, why: string, error?: unknown) => Promise<void>) => Promise<void>
}): Promise<void> {
  // The session this resume belongs to, read BEFORE any await: a find can take
  // seconds, and a workspace switch in the meantime (stopBridge → startBridge)
  // must not get this workspace's shard in its ledger or its hold (found in
  // review, 2026-10-19). `holdReference` reads the epoch only when it is called.
  const epoch = durableAckEpoch
  const giveUp = async (reference: DeferredReference, why: string, error?: unknown) => {
    const failures = await deferredReferences.noteResumeFailure(reference, HELD_SHARD_RESUME_LIMIT).catch((countError) => {
      // Uncounted, this boot does not bring the give-up any closer.
      console.warn(`held ${reference.field} entry ${reference.url}: this boot's failure could not be counted`, countError)
      return 0
    })
    const verdict = failures >= HELD_SHARD_RESUME_LIMIT
      ? `given up after ${failures} boots: ${options.lost}`
      : `retrying next boot (${failures}/${HELD_SHARD_RESUME_LIMIT})`
    console.warn(`held ${reference.field} entry ${reference.url} ${why}; ${verdict}`, error ?? '')
  }
  const booted = documentsWorkspaceKey()
  await Promise.all(options.queued.filter(options.accepts).map(async (reference) => {
    // The queue is namespaced by the workspace ALIAS, so a fork and its
    // source share it, and a fork made by an earlier build still names its
    // source's epoch metas as predecessors. An entry recorded for another
    // CONCRETE workspace is never published here (entries of earlier builds
    // carry no workspace). Nor COUNTED — it is not this workspace's to give up.
    // The queue is per alias: three boots of a fork would otherwise drop its
    // source's pointer, lost when the alias points back (a demote).
    if (reference.workspace !== undefined && booted !== null && reference.workspace !== booted) return
    if (reference.holderDocumentId !== options.holderDocumentId && !options.acceptsHolder?.(reference.holderDocumentId)) {
      // A holder the boot's LOCAL lineage does not reach is set
      // aside, not given up — the network walk, after the first render, decides.
      if (options.setAside?.(reference)) return
      // Held for a holder this workspace no longer uses: nowhere to publish.
      await giveUp(reference, `was held for ${options.holderName} ${reference.holderDocumentId}, not ${options.holderDocumentId}`)
      return
    }
    if (reference.unminted && options.resumeUnminted) {
      await options.resumeUnminted(reference, options.isPublished(reference), epoch, giveUp)
      return
    }
    if (options.isPublished(reference)) {
      // A failed dequeue only leaves the entry for the next boot to drop.
      await deferredReferences.remove(reference).catch((error) => {
        console.warn(`published ${reference.field} reference could not be dequeued`, error)
      })
      return
    }
    let handle: DocHandle<T>
    try {
      handle = await options.find(reference.url)
    } catch (error) {
      await giveUp(reference, 'could not be loaded from this browser', error)
      return
    }
    // The entry stays queued for that workspace's next boot.
    if (epoch !== durableAckEpoch) return
    options.onResumed(reference, handle)
    trackDurableHandle(handle)
    holdReference(reference, handle.documentId, Promise.resolve())
  }))
}

/** How long one question about a RANDOM-id shard waits for the server.
 * Asked in the BACKGROUND: past it, the shard is shown provisionally and the
 * question asked again. */
const UNMINTED_ACK_TIMEOUT_MS = 3_000
let unmintedAckTimeoutMs = UNMINTED_ACK_TIMEOUT_MS
let unmintedRetryDelaysMs: readonly number[] = UNMINTED_RETRY_DELAYS_MS

/** Test hook: the question's timeout and retry delays (null restores them). */
export function __setUnmintedQuestionTimingForTest(timing: { timeoutMs?: number; retryDelaysMs?: readonly number[] } | null): void {
  unmintedAckTimeoutMs = timing?.timeoutMs ?? UNMINTED_ACK_TIMEOUT_MS
  unmintedRetryDelaysMs = timing?.retryDelaysMs ?? UNMINTED_RETRY_DELAYS_MS
}

/** What the server says of a random-id shard: it holds it as an ordinary or
 * a live superseded document, it holds it as a RETIRED epoch document (it
 * will never be durable again), or it does not know it. */
type ShardVerdict = 'held' | 'retired' | 'unknown'

/** The hash of a document's first change, or nothing for an empty one. */
function firstChangeHash(handle: DocHandle<unknown>): string | undefined {
  const doc = handle.doc()
  const first = doc ? getAllChanges(doc as never)[0] : undefined
  return first ? decodeChange(first).hash : undefined
}

/**
 * Whether the server already HOLDS a random-id shard. Such a
 * document is claimed only through a pointer (deferredReferences.ts), so a
 * server that holds it means some ModelMeta already named it — it is in the
 * lineage (adopted, or cut by a full roll into a recreated copy). Asked
 * about the shard's FIRST change, which every copy carries (recorded in the
 * entry at the shard's creation): `durable` then means "claimed", whatever the
 * server's copy lacks of later edits; `forwarded` or `forwardPending` means "a
 * live superseded epoch document"; `epochRetired`, "a retired one". `null`: no
 * answer (offline, timed out, a 5xx, no line for the shard); ANSWER_REFUSED: a
 * 4xx, which asking again will not change.
 */
type ShardAnswer<V> = Promise<V | null | typeof ANSWER_REFUSED | typeof ANSWER_EXPIRED>
function serverHoldsShard(handle: DocHandle<unknown>, reference: DeferredReference, timeoutMs?: number, claims?: false): ShardAnswer<ShardVerdict>
function serverHoldsShard(handle: DocHandle<unknown>, reference: DeferredReference, timeoutMs: number | undefined, claims: boolean): ShardAnswer<ShardVerdict | 'claimed'>
async function serverHoldsShard(
  handle: DocHandle<unknown>,
  reference: DeferredReference,
  timeoutMs = unmintedAckTimeoutMs,
  /** Tell a PLAIN claim (durable, no epoch row) apart, as `claimed`, from a live
   * superseded epoch document. */
  claims = false,
): ShardAnswer<ShardVerdict | 'claimed'> {
  const first = reference.firstChange ?? firstChangeHash(handle)
  if (!first) return 'unknown'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const answers = await acknowledgeDurableDocumentHeads(
      [{ documentId: handle.documentId, heads: [first] }], { signal: controller.signal })
    const answer = answers.find((a) => a.documentId === handle.documentId) as Record<string, unknown> | undefined
    if (!answer) return null
    if (answer.epochRetired === true) return 'retired'
    if (claims && answer.durable === true && !('forwarded' in answer) && answer.forwardPending !== true) return 'claimed'
    return answer.durable === true || 'forwarded' in answer || answer.forwardPending === true ? 'held' : 'unknown'
  } catch (error) {
    return isPermanentRefusal(error) ? ANSWER_REFUSED : isExpiredSession(error) ? ANSWER_EXPIRED : null
  } finally {
    clearTimeout(timer)
  }
}

/** No answer from the first question: asked again (an expired session
 * counts towards its stop). */
const unanswered = (verdict: unknown): verdict is null | typeof ANSWER_EXPIRED => verdict === null || verdict === ANSWER_EXPIRED

/** The session's pending offline decisions, cancelled at stop. */
const unmintedRetryTimers = new Set<ReturnType<typeof setTimeout>>()

/** The waits of `decideCarriedUnminted`'s walk, resolved at stop. */
const unmintedWaitResolvers = new Set<() => void>()

function cancelUnmintedRetries(): void {
  for (const timer of unmintedRetryTimers) clearTimeout(timer)
  unmintedRetryTimers.clear()
  for (const resolve of unmintedWaitResolvers) resolve()
  unmintedWaitResolvers.clear()
  for (const timer of hopAccountingTimers) clearTimeout(timer)
  hopAccountingTimers.clear()
  cancelFollowRetries()
}

/** Ask about `handle` again until the server answers (`retryUntilAnswered`:
 * backed off, capped, stopped by a refusal or by the session's end). */
function askUnmintedUntilAnswered<V extends ShardVerdict | 'claimed' = ShardVerdict>(handle: DocHandle<unknown>, reference: DeferredReference, epoch: number,
  answered: (verdict: V) => void, first: null | typeof ANSWER_EXPIRED = null, claims = false): void {
  retryUntilAnswered<V>({
    // `claimed` comes only when `claims` was asked for, so only to a V that has it.
    ask: () => serverHoldsShard(handle, reference, undefined, claims) as ShardAnswer<V>,
    alive: () => epoch === durableAckEpoch,
    answered,
    setTimer: (fn, ms) => {
      const timer = setTimeout(() => { unmintedRetryTimers.delete(timer); fn() }, ms)
      unmintedRetryTimers.add(timer)
    },
  }, unmintedRetryDelaysMs, undefined, first === ANSWER_EXPIRED ? 1 : 0)
}

/** Random-id shards shown while the server has not said whether it holds
 * them: projected (unlisted: they never take an id a listed shard holds),
 * never the tab's own, and FULL for the write path — no new id is
 * placed in a shard a late "held" would take off the screen. */
const provisionalModelShardUrls = new Set<string>()

/** The urls of the model shards the tab projects. */
function projectedModelShardUrls(): Set<string> {
  return new Set([...objectShardHandles, ...connectionShardHandles].map((h) => h.url))
}

/** The indices of `handles` that are provisional (`planShardAssignment`'s
 * `closed`); nothing at all — no allocation — while none is. */
function provisionalShardIndices(handles: readonly DocHandle<unknown>[]): Set<number> | undefined {
  if (provisionalModelShardUrls.size === 0) return undefined
  const closed = new Set<number>()
  handles.forEach((h, i) => { if (provisionalModelShardUrls.has(h.url)) closed.add(i) })
  return closed
}

/** Dequeue `reference` once the server acknowledges `handle`'s CURRENT heads
 * (not merely its first change — a shard edited offline past the server's copy
 * stays queued, so a later boot still sends those edits). Its 'model-shard'
 * lease is then given back if the tab does not project it. */
function dequeueOnceDurable(handle: DocHandle<unknown>, reference: DeferredReference, epoch: number): void {
  trackDurableHandle(handle)
  void serverDurability.wait(handle.documentId).then(async () => {
    if (epoch !== durableAckEpoch) return
    await deferredReferences.remove(reference).catch(() => undefined)
    if (epoch === durableAckEpoch && !projectedModelShardUrls().has(handle.url)) {
      releaseDocumentRequest(handle.url as AutomergeUrl, 'model-shard')
    }
  })
}

// ── Projection changes after the boot, outside a hop's latch ──

/** Adoptions and unloads a hop's latch held back, run once it lifts. */
let afterLatch: Array<() => void> = []

function hopLatched(): boolean {
  return writesPausedByHop || epochHop?.state().phase === 'latched'
}

/**
 * Run a change of the projected shard set now — or, inside a hop's latch,
 * once it lifts (after the swap when there is one). In the latch a flush only
 * DEFERS the write (`writeScheduler`), so a projection would replace the
 * store under a write made by code meanwhile, and the reseed would make that
 * its baseline: the swap's deferred flush would then write a store without
 * it. FIFO: what was held back runs before anything later.
 */
function outsideHopLatch(run: () => void): void {
  if (hopLatched() || afterLatch.length > 0) {
    afterLatch.push(run)
    if (!hopLatched()) runAfterLatch()
    return
  }
  run()
}

/** After `resumeWrites` — in a microtask, once the hop machine has left
 * its `latched` state. */
function runAfterLatch(): void {
  if (afterLatch.length === 0) return
  const session = durableAckEpoch
  queueMicrotask(() => {
    if (session !== durableAckEpoch || hopLatched()) return
    const runs = afterLatch
    afterLatch = []
    for (const run of runs) outsideHopLatch(run)
  })
}

/** Append held shards to the projection (a pending write flushed first, then
 * attach → project → reseed): one handle per url, never one the tab projects. */
function adoptModelShardsNow(objects: DocHandle<ObjectShard>[], connections: DocHandle<ConnectionShard>[],
  /** Only a shard the CURRENT meta lists (the follow's path) — a load in flight
   * across a swap never brings the old epoch's shard into the new one's
   * projection, whatever its caller checked. */
  options: { listedOnly?: boolean } = {}): void {
  if (bfsActive) return
  const seen = projectedModelShardUrls()
  const listedDoc = options.listedOnly ? modelMetaHandle?.doc() : undefined
  const listed = options.listedOnly
    ? new Set(listedDoc ? [...(readMetaUrls(listedDoc, 'objectShardUrls') ?? []), ...(readMetaUrls(listedDoc, 'connectionShardUrls') ?? [])] : [])
    : null
  const fresh = <T>(handles: DocHandle<T>[]) => handles.filter((h) => (!listed || listed.has(h.url)) && !seen.has(h.url) && Boolean(seen.add(h.url)))
  const newObjects = fresh(objects)
  const newConnections = fresh(connections)
  if (newObjects.length === 0 && newConnections.length === 0) return
  // What the user typed meanwhile is written first: the reseed below takes the
  // projected store as the shards' baseline.
  writeScheduler.flushNow()
  objectShardHandles.push(...newObjects)
  connectionShardHandles.push(...newConnections)
  for (const h of [...newObjects, ...newConnections]) attachModelShardListener(h as DocHandle<unknown>)
  resetModelShardProjectionCaches()
  withRemote(projectAll)
  reseedResidentWriteBaselines()
}

/**
 * The hop's invariant, checked — every object in the store when the hop started
 * loading is, once it has swapped, either still in the store or a line of the
 * retired export. One that is neither is reported (a warning, the timeline, the
 * probe), never acted on: it is the alert that would have named the 58 objects
 * a manual test lost (see `followListedModelShards`). Checked 5 s after the
 * swap, so a shard the swap is still adopting (`followListedModelShards`) is
 * not counted.
 */
let hopObjectsAtLoad: Set<string> | null = null
let hopExportedIds: Set<string> = new Set()
const hopUnaccountedObjects: string[] = []
const hopAccountingTimers = new Set<ReturnType<typeof setTimeout>>()
const HOP_ACCOUNTING_DELAY_MS = 5_000

function noteHopObjectsAtLoad(): void {
  hopObjectsAtLoad = new Set(useModelStore.getState().objects.map((o) => o.id))
  hopExportedIds = new Set()
}

function noteHopExported<T extends { differences: ReadonlyArray<{ id: string }> }>(diff: T): T {
  hopExportedIds = new Set(diff.differences.map((d) => d.id))
  return diff
}

function checkHopAccountedLater(): void {
  const before = hopObjectsAtLoad
  const exported = hopExportedIds
  hopObjectsAtLoad = null
  hopExportedIds = new Set()
  if (!before || before.size === 0) return
  // `hopUnaccounted`: a delete in the new epoch, and boot-from-server, are not
  // the hop's to account.
  const afterSwap = new Set(useModelStore.getState().objects.map((o) => o.id))
  const session = durableAckEpoch
  const timer = setTimeout(() => {
    hopAccountingTimers.delete(timer)
    if (session !== durableAckEpoch) return
    const now = new Set(useModelStore.getState().objects.map((o) => o.id))
    const missing = hopUnaccounted({ before, afterSwap, now, exported, tombstones: tombstoneObjects, bootFromServer: bfsActive })
    if (missing.length === 0) return
    hopUnaccountedObjects.push(...missing.slice(0, 64))
    if (hopUnaccountedObjects.length > 256) hopUnaccountedObjects.splice(0, hopUnaccountedObjects.length - 256)
    console.warn('[epoch hop] objects in the store before the hop are neither projected nor exported after it', { count: missing.length, sample: missing.slice(0, 8) })
    markClientTimeline('workspace.epoch.hop-unaccounted', { count: missing.length })
  }, HOP_ACCOUNTING_DELAY_MS)
  // Cleared with the session's other timers (`cancelUnmintedRetries`, at stop).
  hopAccountingTimers.add(timer)
}

/** URLs `followListedModelShards` is resolving (never resolved twice at once). */
const followingModelShardUrls = new Set<string>()

/**
 * The objects gone from the author's tab: project every model shard the CURRENT
 * meta lists and the tab does not — resident path only (boot-from-server reads
 * no base shard).
 *
 * The resident tab resolved its shard list once, at boot or at a hop's load.
 * A compaction writes the CURRENT meta in place: it folds the overlay
 * segments the tab writes into (they are listed among its object shards) and
 * CLEARS them, placing a created entity in a base shard with room or, when
 * none has, in a NEW base shard inserted into the list. The tab saw the clear
 * (its objects left the segment) and never loaded the new shard: measured on
 * the e2e stack, 56 of the 2 000 objects Marie created offline were then in
 * neither her store nor her export, while the server served them (58 in
 * the manual test that found it). Called on every change of the meta, after a swap (a
 * compaction between the hop's load and its swap changes a meta no listener
 * watched yet) and after the boot attaches. Adopted outside a hop's latch.
 */
function followListedModelShards(): void {
  if (bfsActive || !modelMetaHandle) return
  const meta = modelMetaHandle
  const doc = meta.doc()
  if (!doc) return
  const view = withMetaUrlView(doc)
  const projected = projectedModelShardUrls()
  // A url given up is followed again at a change of the meta once
  // FOLLOW_GIVEN_UP_REARM_MS have passed — a shard claimed minutes later
  // reaches Paul's open tab without a reload.
  const now = Date.now()
  for (const [url, failure] of followFailures) {
    if (failure.givenUpAt !== undefined && now - failure.givenUpAt >= followGivenUpRearmMs) followFailures.delete(url)
  }
  // A url that failed waits for ITS retry (or was given up), whatever changes
  // the meta meanwhile.
  const unprojected = (urls: readonly string[] | undefined) => uniqueUrls(urls)
    .filter((url) => isValidAutomergeUrl(url) && !projected.has(url) && !followingModelShardUrls.has(url) && followFailures.get(url)?.blocked !== true)
  const objects = unprojected(view.objectShardUrls)
  const connections = unprojected(view.connectionShardUrls)
  if (objects.length === 0 && connections.length === 0) return
  const urls = [...objects, ...connections]
  for (const url of urls) followingModelShardUrls.add(url)
  const session = durableAckEpoch
  // Per url: one shard listed but not served — an `unminted` pointer the server
  // has not claimed yet — no longer holds back the others (a compaction's new
  // base shard in the same diff).
  const resolveEach = <T>(list: string[]) => Promise.allSettled(list.map(async (url) => {
    // With or without epochs: a shard another client just created is asked for
    // here as soon as the meta names it — often before the server holds it or
    // has admitted it. The server's verdict is then cached per (document, peer)
    // and the client's sync state believes its first frame is still awaiting a
    // reply: it never asks again, the find's ceilings only re-await
    // (`handleRetry`), and Paul's open tab went without Marie's new shard for
    // the spec's 120 s (3 runs in 6). Every FOLLOW_FIND_REPRESENT_MS without an
    // answer the document is presented again (`resetDocumentSyncState`: a fresh
    // request), bounded.
    //
    // Only on a real signal — the server said `doc-unavailable`, or sent
    // NOTHING for the document since it was last presented — and spaced
    // exponentially (4, 8, 16 … 30 s): a large shard still arriving on a slow
    // link is never reset under its own transfer. And bound to the session: a
    // stop (or a workspace change) ends it.
    const documentId = url.slice('automerge:'.length) as DocumentId
    const stopRepresenting = representUnansweredFind(documentId, session)
    try {
      const [handle] = await getModelShardHandles<T>([url])
      if (!handle) throw new Error(`model shard ${url} not resolved`)
      return handle
    } finally {
      stopRepresenting()
    }
  }))
  void (async () => {
    try {
      const [objectResults, connectionResults] = await Promise.all([
        resolveEach<ObjectShard>(objects), resolveEach<ConnectionShard>(connections),
      ])
      const ready = <T>(results: PromiseSettledResult<DocHandle<T>>[]) =>
        results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      const objectHandles = ready(objectResults)
      const connectionHandles = ready(connectionResults)
      const failed = [...objects.filter((_, i) => objectResults[i]!.status === 'rejected'),
        ...connections.filter((_, i) => connectionResults[i]!.status === 'rejected')]
      // A failed load took its lease too (`prepareDocumentRequest`).
      for (const url of failed) releaseDocumentRequest(url as AutomergeUrl, 'model-shard')
      if (session !== durableAckEpoch) return
      if (failed.length > 0) {
        console.warn(`[bridge] ${failed.length} model shard(s) the meta lists could not be loaded; retried with a backoff`)
        for (const url of failed) scheduleFollowRetry(url, session)
      }
      const giveBack = () => {
        const kept = projectedModelShardUrls()
        for (const h of [...objectHandles, ...connectionHandles]) if (!kept.has(h.url)) releaseDocumentRequest(h.url, 'model-shard')
      }
      for (const h of [...objectHandles, ...connectionHandles]) followFailures.delete(h.url)
      if (objectHandles.length === 0 && connectionHandles.length === 0) return
      markClientTimeline('workspace.model-shards.followed', { objects: objectHandles.length, connections: connectionHandles.length, failed: failed.length })
      outsideHopLatch(() => {
        // The meta replaced meanwhile (a hop swapped), and
        // `adoptModelShardsNow` takes only what the CURRENT meta lists.
        if (session === durableAckEpoch && modelMetaHandle === meta) adoptModelShardsNow(objectHandles, connectionHandles, { listedOnly: true })
        // Not adopted (the session or the meta gone, or not listed any
        // more): the leases go back.
        if (session === durableAckEpoch) giveBack()
      })
    } finally {
      for (const url of urls) followingModelShardUrls.delete(url)
    }
  })()
}

/** The follow's retries per url — backed off, BOUNDED (given up for the session
 * after the last delay: a later boot loads the shard), cancelled at stop. */
const FOLLOW_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000]
let followRetryDelaysMs: readonly number[] = FOLLOW_RETRY_DELAYS_MS
/** Per url that failed: the attempts spent, and whether it waits (`timer`)
 * or was given up (`blocked` without a timer). A url retried by its timer is
 * unblocked for that one pass. */
const followFailures = new Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> | null; blocked: boolean; givenUpAt?: number }>()
/** How long a given-up url stays given up before a change of the meta follows it
 * again. */
export const FOLLOW_GIVEN_UP_REARM_MS = 5 * 60_000
/** A follow's find unanswered this long is presented again, at most
 * FOLLOW_FIND_REPRESENT_MAX times. */
export const FOLLOW_FIND_REPRESENT_MS = 4_000
export const FOLLOW_FIND_REPRESENT_MAX = 15
/** The spacing's ceiling: 4, 8, 16, then every 30 s (60 s left a shard admitted
 * late — AUTH on — four presentations in two minutes). */
export const FOLLOW_FIND_REPRESENT_MAX_DELAY_MS = 30_000
let followFindRepresentMs = FOLLOW_FIND_REPRESENT_MS
let followFindRepresentMaxDelayMs = FOLLOW_FIND_REPRESENT_MAX_DELAY_MS
/** Probe: how many times the follow presented a document again. */
let followRepresentations = 0
let followNetworkSignalWarned = false
/** Probe: the wait before each presentation, in order (bounded). */
const followRepresentWaits: number[] = []
/** The armed re-presentations: the bridge's stop ends them. */
const followRepresentStops = new Set<() => void>()
export function __setFollowFindRepresentForTest(ms: number | null, maxDelayMs: number | null = null): void {
  followFindRepresentMs = ms ?? FOLLOW_FIND_REPRESENT_MS
  followFindRepresentMaxDelayMs = maxDelayMs ?? FOLLOW_FIND_REPRESENT_MAX_DELAY_MS
  followRepresentWaits.length = 0
}

/**
 * Present `documentId` again while its find stays unanswered,
 * on a signal only: at each tick, when the server said `doc-unavailable`
 * for it or sent nothing for it since the last presentation. A tick that
 * heard frames waits (the transfer is under way). At most
 * FOLLOW_FIND_REPRESENT_MAX presentations, spaced exponentially; nothing
 * once the session ended. Returns the stop (the find settled).
 */
function representUnansweredFind(documentId: DocumentId, session: number): () => void {
  let presented = 0
  let delay = followFindRepresentMs
  let heard = false
  let unavailable = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const network = repo.networkSubsystem as unknown as {
    on?: (event: 'message', listener: (message: { documentId?: unknown; type?: unknown }) => void) => void
    off?: (event: 'message', listener: (message: { documentId?: unknown; type?: unknown }) => void) => void
  } | undefined
  const onMessage = (message: { documentId?: unknown; type?: unknown }) => {
    if (message.documentId !== documentId) return
    if (message.type === 'doc-unavailable') unavailable = true
    // A sync frame (the document's data on its way); remote-heads and
    // ephemeral traffic say nothing about this request.
    else if (message.type === 'sync') heard = true
  }
  network?.on?.('message', onMessage)
  // Without the event API the signal is gone and only the spacing remains —
  // said once, not silently.
  if (typeof network?.on !== 'function' && !followNetworkSignalWarned) {
    followNetworkSignalWarned = true
    console.warn('[bridge] the network subsystem emits no `message` events: a follow re-presents on its timer alone')
  }
  const holdsData = () => {
    try {
      const doc = syncedHandle(repo, documentId)?.doc()
      return !!doc && getHeads(doc as never).length > 0
    } catch {
      return false
    }
  }
  const stop = () => {
    stopped = true
    if (timer) { clearTimeout(timer); timer = null }
    followRepresentStops.delete(stop)
    network?.off?.('message', onMessage)
  }
  followRepresentStops.add(stop)
  const arm = () => {
    timer = setTimeout(() => {
      timer = null
      if (stopped) return
      if (session !== durableAckEpoch) { stop(); return }
      if (heard && !unavailable && holdsData()) {
        // Frames arrived for it since the last presentation, and data with
        // them: its transfer is under way, not unanswered. (A sync frame that
        // brought NOTHING — the server's empty answer — is no transfer:
        // measured once in the AUTH-on suite, Paul's tab held its presentations
        // for 120 s on such answers.)
        heard = false
        arm()
        return
      }
      presented += 1
      followRepresentations += 1
      // Probe: the wait that preceded each presentation — the spacing a test
      // asserts without timing the machine.
      followRepresentWaits.push(delay)
      if (followRepresentWaits.length > 64) followRepresentWaits.splice(0, followRepresentWaits.length - 64)
      heard = false
      unavailable = false
      resetDocumentSyncState(repo, documentId)
      if (presented >= FOLLOW_FIND_REPRESENT_MAX) { stop(); return }
      delay = Math.min(delay * 2, followFindRepresentMaxDelayMs)
      arm()
    }, delay)
  }
  arm()
  return stop
}

function stopFollowRepresentations(): void {
  for (const stop of [...followRepresentStops]) stop()
}
let followGivenUpRearmMs = FOLLOW_GIVEN_UP_REARM_MS

/** Test hook: the follow's retry delays (null restores them). */
export function __setFollowRetryDelaysForTest(delays: readonly number[] | null, givenUpRearmMs: number | null = null): void {
  followRetryDelaysMs = delays ?? FOLLOW_RETRY_DELAYS_MS
  followGivenUpRearmMs = givenUpRearmMs ?? FOLLOW_GIVEN_UP_REARM_MS
}

/** Probe: the follow's failed urls, as `<url>:<attempts>[:given-up]`. */
function followFailureProbe(): string[] {
  return [...followFailures].map(([url, f]) => `${url}:${f.attempts}${f.blocked && !f.timer ? ':given-up' : ''}`)
}

function scheduleFollowRetry(url: string, session: number): void {
  const failure = followFailures.get(url) ?? { attempts: 0, timer: null, blocked: true }
  followFailures.set(url, failure)
  failure.blocked = true
  if (failure.timer) return
  if (failure.attempts >= followRetryDelaysMs.length) {
    failure.givenUpAt ??= Date.now()
    markClientTimeline('workspace.model-shards.follow-given-up', { url })
    return
  }
  const delay = followRetryDelaysMs[failure.attempts]!
  failure.attempts += 1
  failure.timer = setTimeout(() => {
    failure.timer = null
    if (session !== durableAckEpoch) return
    failure.blocked = false
    followListedModelShards()
  }, delay)
}

function cancelFollowRetries(): void {
  for (const failure of followFailures.values()) if (failure.timer) clearTimeout(failure.timer)
  followFailures.clear()
}

/** One held shard, by its reference's field. */
function adoptHeldShardNow(reference: DeferredReference, handle: DocHandle<unknown>): void {
  if (reference.field === 'objectShardUrls') adoptModelShardsNow([handle as DocHandle<ObjectShard>], [])
  else adoptModelShardsNow([], [handle as DocHandle<ConnectionShard>])
}

/** The reverse: `handle` leaves the projection — a pending write flushed first,
 * its listener detached (its lease is kept until `dequeueOnceDurable` gives it
 * back), then project → reseed, so its ids no longer route there and what only
 * it held leaves the screen. */
function unloadModelShardNow(handle: DocHandle<unknown>): void {
  if (bfsActive || !projectedModelShardUrls().has(handle.url)) return
  writeScheduler.flushNow()
  objectShardHandles = objectShardHandles.filter((h) => h.url !== handle.url)
  connectionShardHandles = connectionShardHandles.filter((h) => h.url !== handle.url)
  const handler = modelShardChangeHandlers.get(handle.url)
  if (handler) {
    handle.off('change', handler)
    modelShardChangeHandlers.delete(handle.url)
  }
  resetModelShardProjectionCaches()
  withRemote(projectAll)
  reseedResidentWriteBaselines()
}

/**
 * A RETIRED random-id shard the booted meta does not list: its local copy may
 * carry offline edits the server never received — a session closed offline past
 * the retention — and a retired document is never forwarded again. Its entities
 * that differ from the projection WITHOUT it (the current epoch's,
 * `collectRetiredDifferences`) are offered in the `epoch-retired` banner,
 * merged with an export already shown (one entry per entity, the one shown
 * first kept). A pending write is flushed first, so what was typed into X while
 * it was provisional is in the export. Nothing differs: nothing is shown.
 *
 * The export is PERSISTED before the shard is let go (`offerRetiredExport`);
 * the promise says whether what only X held is now safe — the entry may leave
 * the queue only then.
 */
function offerRetiredShardExport(reference: DeferredReference, handle: DocHandle<unknown>): Promise<boolean> {
  writeScheduler.flushNow()
  const objects = reference.field === 'objectShardUrls'
  const others = <T>(handles: DocHandle<T>[]) => handles.filter((h) => h.url !== handle.url)
  const differences = collectRetiredDifferences({
    retiredMeta: null,
    retiredObjectShards: objects ? [plainDocument(handle)] : [],
    retiredConnectionShards: objects ? [] : [plainDocument(handle)],
    current: {
      meta: null,
      objects: mergeObjectShards(others(objectShardHandles).map((h) => h.doc() ?? { objects: {} })) as Record<string, unknown>,
      connections: mergeConnectionShards(others(connectionShardHandles).map((h) => h.doc() ?? { connections: {} })) as Record<string, unknown>,
    },
    // Boot-from-server holds no base shard, so "absent from the current epoch"
    // cannot be told here.
    currentShardsUnknown: bfsActive,
  })
  if (differences.length === 0) return Promise.resolve(true)
  markClientTimeline('workspace.held-shards.retired-export', { shard: handle.documentId, differences: differences.length })
  return offerRetiredExport({
    version: 1,
    metaUrl: modelMetaHandle?.url ?? '',
    collectedAt: new Date().toISOString(),
    differences,
  })
}

/**
 * The net: a document of the durable ledger — this browser wrote it and the
 * server never acknowledged it — that the server answers RETIRED while the tab
 * holds it in NO epoch: the hop that should have collected it never settled (it
 * stayed in backoff, then the tab was reloaded onto the current epoch). Its
 * local copy is the only place her edits live, and a retired document is never
 * forwarded: its entities that differ from the current projection are offered
 * in the `epoch-retired` banner, persisted, before it leaves the ledger. A
 * retired META also brings the local copies of the shards it lists and the
 * current meta does not (a shard created offline whose pointer only that meta
 * held). Nothing during a hop (its own retired path collects), nothing for a
 * document the tab holds.
 */
const ledgerRetiredOffered = new Set<string>()
/** Ids the net is reading or offering now (one pass per id at a time). */
const ledgerRetiredInFlight = new Set<string>()
/** How long the net waits for a local copy (IndexedDB) before it leaves the
 * document for the next round. */
const LEDGER_RETIRED_READ_MS = 5_000

/** The local copy of `id`, read from this browser's storage, within a bound;
 * null when it is not readable now (left for the next round). */
async function readLocalCopy(id: string, role: 'durability-pending' | 'model-shard'): Promise<DocHandle<unknown> | null> {
  const synced = syncedHandle(repo, id as DocumentId)
  if (synced?.isReady()) return synced as DocHandle<unknown>
  const url = `automerge:${id}`
  if (!isValidAutomergeUrl(url)) return null
  prepareDocumentRequest(url, role)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const handle = await Promise.race([
      repo.find<unknown>(url as AutomergeUrl).then(async (h) => { await h.whenReady(); return h }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), LEDGER_RETIRED_READ_MS) }),
    ]).catch(() => null)
    return handle && handle.isReady() && handle.doc() ? handle : null
  } finally {
    if (timer) clearTimeout(timer)
    if (role === 'model-shard') releaseDocumentRequest(url as AutomergeUrl, role)
  }
}

/** The keys, per top-level collection (`objects`, `connections`, `groups`, …),
 * of the entities that changes by THIS browser's actors touched — the net
 * offers only those, not everything others changed since. Null — nothing
 * filtered — when the document holds NO change by one of those actors: an edit
 * made under an actor nobody recorded must not be filtered out and then
 * forgotten.
 *
 * The actors are the ledger ENTRY's own writers
 * (`DurableHeadLedger.writersOf`), not the actor journal — that journal keeps
 * the last 256 actors, and an edit made under one it evicted was filtered out,
 * then forgotten. Everything the server has not acknowledged was written under
 * one of the entry's writers; unknown writers (an entry persisted before them,
 * a creation, a resumed handle) filter nothing. */
function locallyTouchedKeys(handle: DocHandle<unknown>, writers: ReadonlySet<string> | null | undefined): Map<string, Set<string>> | null {
  if (!writers || writers.size === 0) return null
  const doc = handle.doc()
  if (!doc) return null
  /** objId → [collection, entity key | null (the collection map itself)] */
  const owner = new Map<string, [string, string | null]>()
  const touched = new Map<string, Set<string>>()
  let anyLocal = false
  for (const raw of getAllChanges(doc as never)) {
    const change = decodeChange(raw)
    const local = writers.has(change.actor)
    if (local) anyLocal = true
    change.ops.forEach((op, index) => {
      const at = op.obj === '_root' ? null : owner.get(op.obj)
      const key = typeof op.key === 'string' ? op.key : null
      // Ownership of the object an op creates: a collection under the root,
      // an entity under a collection, a part under an entity.
      if (op.action.startsWith('make')) {
        const created = `${change.startOp + index}@${change.actor}`
        if (op.obj === '_root' && key) owner.set(created, [key, null])
        else if (at) owner.set(created, [at[0], at[1] ?? key])
      }
      if (!local || !at) return
      const entity = at[1] ?? key
      if (!entity) return
      const set = touched.get(at[0]) ?? new Set<string>()
      set.add(entity)
      touched.set(at[0], set)
    })
  }
  return anyLocal ? touched : null
}

const COLLECTION_OF_KIND: Record<string, string> = {
  object: 'objects', connection: 'connections', group: 'groups', domain: 'domains', tag: 'tagSnapshots', tagSnapshot: 'tagSnapshots', decisionRecord: 'decisionRecords',
}

function offerOrphanedRetiredLedger(answers: readonly unknown[]): void {
  if (!epochCapability || !sharded || !modelMetaHandle) return
  if (epochHop && epochHop.state().phase !== 'idle' && epochHop.state().phase !== 'retired') return
  const held = new Set<string>([
    ...heldEpochDocuments().map((h) => h.documentId as string),
    ...[...objectShardHandles, ...connectionShardHandles].map((h) => h.documentId as string),
    ...[...retainedEpochSets.values()].flat().map((h) => h.documentId as string),
  ])
  const orphaned = answers.flatMap((a) => {
    const answer = a as { documentId?: unknown; epochRetired?: unknown }
    const id = typeof answer.documentId === 'string' ? answer.documentId : null
    return id && answer.epochRetired === true && !held.has(id) && !ledgerRetiredOffered.has(id) && !ledgerRetiredInFlight.has(id) ? [id] : []
  })
  if (orphaned.length === 0) return
  for (const id of orphaned) ledgerRetiredInFlight.add(id)
  // Out of the acknowledgement loop: reads, merges and the diff run on
  // their own task.
  setTimeout(() => {
    void collectOrphanedRetired(orphaned).finally(() => { for (const id of orphaned) ledgerRetiredInFlight.delete(id) })
  }, 0)
}

/**
 * ONLY what was read is offered and forgotten. A document whose local copy is
 * not ready yet (the boot's `repo.find` still running, the ack sent with the
 * ledger's heads) is read here within a bound; one still unreadable — or a
 * retired meta one of whose unlisted shards is — stays in the ledger, not
 * marked, for the next round. Before, it was marked offered and forgotten
 * unread: her offline edits named by nothing any more.
 */
async function collectOrphanedRetired(orphaned: readonly string[]): Promise<void> {
  const session = durableAckEpoch
  const meta = modelMetaHandle
  if (!meta) return
  const currentDoc = meta.doc()
  const currentView = currentDoc ? withMetaUrlView(currentDoc) : { objectShardUrls: [], connectionShardUrls: [] }
  const currentlyListed = new Set([...(currentView.objectShardUrls ?? []), ...(currentView.connectionShardUrls ?? [])])
  const objectShards: Array<Record<string, unknown> | null> = []
  const connectionShards: Array<Record<string, unknown> | null> = []
  let retiredMeta: Record<string, unknown> | null = null
  const touched = new Map<string, Set<string>>()
  let filterable = true
  const seen = new Set<string>()
  const read: string[] = []
  const addRead = (handle: DocHandle<unknown>, id: string) => {
    const doc = plainDocument(handle)
    if (!doc || seen.has(id)) return
    seen.add(id)
    const keys = locallyTouchedKeys(handle, durableHeads.writersOf(id as DocumentId))
    if (keys === null) filterable = false
    else for (const [collection, set] of keys) touched.set(collection, new Set([...(touched.get(collection) ?? []), ...set]))
    if ('objectShardUrls' in doc || 'connectionShardUrls' in doc) retiredMeta ??= doc
    else if (doc.objects && typeof doc.objects === 'object') objectShards.push(doc)
    else if (doc.connections && typeof doc.connections === 'object') connectionShards.push(doc)
  }
  for (const id of orphaned) {
    const handle = await readLocalCopy(id, 'durability-pending')
    if (session !== durableAckEpoch) return
    if (!handle) continue
    const doc = handle.doc() as Record<string, unknown> | undefined
    if (doc && ('objectShardUrls' in doc || 'connectionShardUrls' in doc)) {
      // Its shards the current meta does not list: all of them read, or the
      // meta waits for the next round.
      const view = withMetaUrlView(doc as unknown as ModelMeta)
      const shards: Array<[DocHandle<unknown>, string]> = []
      let complete = true
      for (const url of [...(view.objectShardUrls ?? []), ...(view.connectionShardUrls ?? [])]) {
        if (!isValidAutomergeUrl(url) || currentlyListed.has(url)) continue
        const shardId = url.slice('automerge:'.length)
        const shard = await readLocalCopy(shardId, 'model-shard')
        if (!shard) { complete = false; break }
        shards.push([shard, shardId])
      }
      if (session !== durableAckEpoch) return
      if (!complete) continue
      addRead(handle, id)
      for (const [shard, shardId] of shards) addRead(shard, shardId)
    } else {
      addRead(handle, id)
    }
    read.push(id)
  }
  if (read.length === 0 || session !== durableAckEpoch || modelMetaHandle !== meta) return
  for (const id of read) ledgerRetiredOffered.add(id)
  const all = collectRetiredDifferences({
    retiredMeta,
    retiredObjectShards: objectShards,
    retiredConnectionShards: connectionShards,
    currentShardsUnknown: bfsActive,
    current: {
      meta: plainDocument(meta as DocHandle<unknown>),
      objects: mergeObjectShards(objectShardHandles.map((h) => h.doc() ?? { objects: {} })) as Record<string, unknown>,
      connections: mergeConnectionShards(connectionShardHandles.map((h) => h.doc() ?? { connections: {} })) as Record<string, unknown>,
    },
  })
  // Only what her own changes touched; everything when her actors are unknown.
  const differences = filterable
    ? all.filter((d) => touched.get(COLLECTION_OF_KIND[d.kind] ?? '')?.has(d.id) === true)
    : all
  markClientTimeline('epoch.ledger-retired', { documents: read.length, differences: differences.length })
  const forget = () => {
    if (session !== durableAckEpoch) return
    durableHeads.forget(read.map((id) => id as DocumentId))
    // The acknowledgement round unpinned 'durability-pending' BEFORE this (the
    // entry was still owed then), and `readLocalCopy` pinned it again; owed by
    // nothing now, no round will unpin it — the retired copy stayed shared and
    // synced all session.
    for (const id of read) activeDocumentShare.unpin(id as DocumentId, 'durability-pending')
    queueDurableLedgerPersistence()
  }
  if (differences.length === 0) { forget(); return }
  const persisted = await offerRetiredExport({ version: 1, metaUrl: meta.url, collectedAt: new Date().toISOString(), differences })
  // Owed until the export is PERSISTED: unpersisted (a private
  // window), the export is shown for this session and the ledger still owes
  // the documents, so the next boot offers them again.
  if (persisted) forget()
}

/**
 * Show a retired export in the `epoch-retired` banner, merged with one
 * already shown (one line per entity, the one shown first kept), after
 * PERSISTING it merged with what an earlier session left
 * (`epochRetiredExportStore.ts`): it stays until the user exports or dismisses
 * it, and the boot raises the banner again from it. True once it is persisted;
 * shown either way (a failed write keeps it in memory, and the caller keeps
 * what it would have let go).
 */
async function offerRetiredExport(next: RetiredExport): Promise<boolean> {
  const session = durableAckEpoch
  const show = (exported: RetiredExport) => {
    if (session !== durableAckEpoch) return
    const store = useEpochHopStore.getState()
    store.showRetired(mergeRetiredExports(store.retired, exported))
  }
  try {
    show(await persistRetiredExport(next))
    return true
  } catch (error) {
    console.warn('the retired export could not be persisted; it is shown for this session only', error)
    show(next)
    return false
  }
}

/** Boot: the banner raised again from the export an earlier session persisted
 * and the user neither exported nor dismissed. */
async function raisePersistedRetiredExport(): Promise<void> {
  const session = durableAckEpoch
  const saved = await loadRetiredExport()
  if (!saved || session !== durableAckEpoch) return
  const store = useEpochHopStore.getState()
  store.showRetired(mergeRetiredExports(saved, store.retired ?? saved))
}

/**
 * The resume of one RANDOM-id model-shard pointer. The pointer was written at once when the
 * shard was created; the entry only says "not yet acknowledged". Nothing of
 * it is on the boot's critical path: the server is asked in
 * the background, before anything is written again.
 *
 * `published`: the booted meta (an older epoch's) lists the shard and this
 * boot loaded it — this browser's own, which a hop carries unless the server
 * calls it a late source (`swapEpoch`). Shown already; the answer only
 * decides the dequeue: once its current heads are durable, or at once when
 * it is RETIRED (it never will be).
 *
 * Not published (`resumeUnlistedUnminted`): not loaded by the boot.
 */
async function resumeUnmintedModelShard(
  reference: DeferredReference,
  published: boolean,
  epoch: number,
  find: (url: string) => Promise<DocHandle<unknown>>,
  giveUp: (reference: DeferredReference, why: string, error?: unknown) => Promise<void>,
): Promise<void> {
  if (!published) {
    void resumeUnlistedUnminted(reference, epoch, find, giveUp)
    return
  }
  let handle: DocHandle<unknown>
  try {
    handle = await find(reference.url)
  } catch {
    // The boot loaded it from its meta: nothing to count against the entry.
    return
  }
  if (epoch !== durableAckEpoch) return
  locallyCreatedModelShardUrls.add(reference.url)
  const settle = (verdict: ShardVerdict) => {
    if (epoch !== durableAckEpoch) return
    if (verdict === 'retired') void deferredReferences.remove(reference).catch(() => undefined)
    else dequeueOnceDurable(handle, reference, epoch)
  }
  void serverHoldsShard(handle, reference).then((verdict) => {
    if (verdict === ANSWER_REFUSED) return
    if (unanswered(verdict)) askUnmintedUntilAnswered(handle, reference, epoch, settle, verdict)
    else settle(verdict)
  })
}

/**
 * A random-id shard the booted meta does not list, decided in the
 * BACKGROUND, its projection changes outside a hop's latch:
 *  - the server does NOT know it: no meta it saw names it. Written into the
 *    current meta, adopted as the tab's own, dequeued once durable;
 *  - it HOLDS it (`held`, or `retired`): a meta named it already. Never
 *    written again — a full roll may have recreated it (X → X′ in place),
 *    and X appended to the current meta would win over X′ for every reader
 *    and mask every edit made since. Adopted only if the current meta lists
 *    it (the adoption landed during the boot); otherwise not projected —
 *    taken OFF the screen if it was shown provisionally. Dequeued once its
 *    current heads are durable (its offline edits reach the
 *    server, which forwards them into X′), at once when RETIRED;
 *  - NO ANSWER (offline, timed out, refused): shown PROVISIONALLY so its
 * author sees it — never the tab's own, closed to new ids — and asked again
 * (`askUnmintedUntilAnswered`); a refusal is not
 *    asked again this session.
 */
async function resumeUnlistedUnminted(
  reference: DeferredReference,
  epoch: number,
  find: (url: string) => Promise<DocHandle<unknown>>,
  giveUp: (reference: DeferredReference, why: string, error?: unknown) => Promise<void>,
): Promise<void> {
  let handle: DocHandle<unknown>
  try {
    handle = await find(reference.url)
  } catch (error) {
    await giveUp(reference, 'could not be loaded from this browser', error)
    return
  }
  if (epoch !== durableAckEpoch) return
  const listedNow = () => {
    const doc = modelMetaHandle?.doc()
    return doc ? (readMetaUrls(doc, reference.field as 'objectShardUrls' | 'connectionShardUrls') ?? []).includes(reference.url) : false
  }
  const settle = (verdict: ShardVerdict) => outsideHopLatch(() => {
    if (epoch !== durableAckEpoch) return
    provisionalModelShardUrls.delete(handle.url)
    if (verdict === 'unknown') {
      writeHeldReference(reference, epoch)
      locallyCreatedModelShardUrls.add(handle.url)
      adoptHeldShardNow(reference, handle)
      dequeueOnceDurable(handle, reference, epoch)
      return
    }
    let safe: Promise<boolean> = Promise.resolve(true)
    if (listedNow()) {
      locallyCreatedModelShardUrls.add(handle.url)
      adoptHeldShardNow(reference, handle)
    } else {
      locallyCreatedModelShardUrls.delete(handle.url)
      // A RETIRED X is never forwarded — what only its local copy holds is
      // offered as the retired export (the hop's step 6) BEFORE it leaves the
      // screen and its entry the queue.
      if (verdict === 'retired') safe = offerRetiredShardExport(reference, handle)
      unloadModelShardNow(handle)
    }
    if (verdict === 'held') { dequeueOnceDurable(handle, reference, epoch); return }
    // RETIRED: never durable again (the hop's `showRetired` rule) — out of the
    // durability ledger and its pin, or the badge stays "Saving" and the round
    // asks about it every 750 ms for the whole session.
    durableHeads.forget([handle.documentId])
    activeDocumentShare.unpin(handle.documentId, 'durability-pending')
    queueDurableLedgerPersistence()
    scheduleDurableAcknowledgement(0)
    if (!projectedModelShardUrls().has(handle.url)) releaseDocumentRequest(handle.url as AutomergeUrl, 'model-shard')
    // Dequeued only once the export is persisted — a reload before "Export"
    // then raises the banner again from the KV store; a failed write leaves the
    // entry for the next boot to ask again.
    void safe.then((persisted) => {
      if (persisted) void deferredReferences.remove(reference).catch(() => undefined)
    })
  })
  // No session test here: every way on (settle, the provisional show, the
  // retries) tests it itself.
  const first = await serverHoldsShard(handle, reference)
  if (first !== ANSWER_REFUSED && !unanswered(first)) { settle(first); return }
  outsideHopLatch(() => {
    if (epoch !== durableAckEpoch) return
    provisionalModelShardUrls.add(handle.url)
    adoptHeldShardNow(reference, handle)
  })
  if (unanswered(first)) askUnmintedUntilAnswered(handle, reference, epoch, settle, first)
}

/**
 * Boot half of the held model-shard pointers: shards this browser created
 * whose url the ModelMeta does not carry yet. They are loaded locally (their
 * content is in this browser's storage) so the author keeps seeing their
 * objects, re-entered in the durability ledger so the acknowledgement round
 * asks about them again, and published once acknowledged. An entry the meta
 * already carries was published by an earlier session or another tab whose
 * dequeue was lost; it is just dropped.
 *
 * Runs on EVERY boot of a sharded workspace, boot-from-server included (the
 * caller only keeps the handles on the resident path): a session that boots
 * the other way must still publish what an earlier one held, or the shard's
 * objects stay invisible to everyone, the author included.
 */
async function resumeDeferredModelShardReferences(
  meta: DocHandle<ModelMeta>,
  loaded: ReadonlySet<string>,
): Promise<{ objects: DocHandle<ObjectShard>[]; connections: DocHandle<ConnectionShard>[] }> {
  pendingSetAside = null
  let queued: DeferredReference[]
  try {
    queued = await deferredReferences.list()
  } catch (error) {
    console.warn('deferred model-shard references could not be read', error)
    return { objects: [], connections: [] }
  }
  // The boot walks the LOCAL lineage only (hydrateEpochKnowledge). A pointer
  // held on a meta it does not reach (rolls this browser never saw) is SET
  // ASIDE — neither given up nor counted — and resumed after the first render,
  // once the network walk has decided (`resumeSetAsideModelShards`).
  const setAside: DeferredReference[] = []
  const resumed = await resumeModelShardEntries(meta, queued, loaded, setAside)
  pendingSetAside = setAside.length > 0 ? { meta, references: setAside, loaded, session: durableAckEpoch } : null
  return resumed
}

/** The entries the boot set aside for the background walk. */
let pendingSetAside: { meta: DocHandle<ModelMeta>; references: DeferredReference[]; loaded: ReadonlySet<string>; session: number } | null = null

/** The whole network walk of the predecessors costs at most this. */
const PREDECESSOR_WALK_BUDGET_MS = 10_000
let predecessorWalkBudgetMs = PREDECESSOR_WALK_BUDGET_MS

/** Test hook: the walk's budget (null restores the default). */
export function __setPredecessorWalkBudgetForTest(ms: number | null): void {
  predecessorWalkBudgetMs = ms ?? PREDECESSOR_WALK_BUDGET_MS
}

/**
 * After the first render: walk the predecessors over the network — ONE budget
 * for the whole walk — then resume the entries the boot set aside, and adopt
 * their shards into the projection (a write flushed first, then the swap's
 * assign → attach → project → reseed). An entry still not reached is counted
 * towards its give-up only when the walk DECIDED (it reached the chain's end);
 * a walk cut short by the budget or the network leaves it for the next boot,
 * uncounted.
 */
async function resumeSetAsideModelShards(): Promise<void> {
  const pending = pendingSetAside
  pendingSetAside = null
  if (!pending || pending.session !== durableAckEpoch) return
  let decided = false
  predecessorAnsweredLive = false
  predecessorQuestionAnswered = false
  try {
    decided = await extendPredecessorChain(pending.meta)
  } catch (error) {
    console.warn('epoch predecessors could not be walked', error)
  }
  if (pending.session !== durableAckEpoch) return
  // A hop swapped during the walk. The entries are resumed against the meta
  // projected NOW — when the meta left is its predecessor (a repoint to another
  // lineage resurrects nothing: left for the next boot, uncounted) — instead of
  // being dropped for the session.
  const meta = modelMetaHandle
  if (!meta) return
  if (meta !== pending.meta && !supersededMetaDocumentIds.has(pending.meta.documentId)) return
  const loaded = meta === pending.meta ? pending.loaded : projectedModelShardUrls()
  const stillAside: DeferredReference[] = []
  const resumed = await resumeModelShardEntries(meta, pending.references, loaded, decided ? undefined : stillAside)
  if (pending.session !== durableAckEpoch) return
  // A bound and an outcome for an entry no walk ever decides — counted only
  // when the server answered the walk's question and said of no predecessor
  // that it is live (an offline boot, or a live meta slow to load, decides
  // nothing about it).
  if (decided) void noteUndecidedWalks(pending.references, true)
  else if (predecessorQuestionAnswered && !predecessorAnsweredLive) void noteUndecidedWalks(stillAside, false)
  adoptLateHeldModelShards(resumed.objects, resumed.connections)
  markClientTimeline('workspace.held-shards.resumed-late', { resumed: resumed.objects.length + resumed.connections.length, decided, aside: stillAside.length })
}

/** Held shards found after the boot join the projection — appended after the
 * tab's shards, as the boot appends its held ones — once no hop latch is up,
 * and never twice. */
function adoptLateHeldModelShards(objects: DocHandle<ObjectShard>[], connections: DocHandle<ConnectionShard>[]): void {
  const session = durableAckEpoch
  outsideHopLatch(() => {
    if (session === durableAckEpoch) adoptModelShardsNow(objects, connections)
  })
}

async function resumeModelShardEntries(
  meta: DocHandle<ModelMeta>,
  queued: DeferredReference[],
  loaded: ReadonlySet<string>,
  setAside?: DeferredReference[],
): Promise<{ objects: DocHandle<ObjectShard>[]; connections: DocHandle<ConnectionShard>[] }> {
  const resumed = { objects: [] as DocHandle<ObjectShard>[], connections: [] as DocHandle<ConnectionShard>[] }
  const doc = meta.doc()
  // Creation order: the handles are appended after the published ones, and the
  // parallel resume completes in any order.
  const order = new Map(queued.map((reference, index) => [reference, index]))
  const objects: Array<[number, DocHandle<ObjectShard>]> = []
  const connections: Array<[number, DocHandle<ConnectionShard>]> = []
  const onResumed = (reference: DeferredReference, handle: DocHandle<unknown>) => {
    locallyCreatedModelShardUrls.add(handle.url)
    const index = order.get(reference) ?? 0
    if (reference.field === 'objectShardUrls') objects.push([index, handle as DocHandle<ObjectShard>])
    else connections.push([index, handle as DocHandle<ConnectionShard>])
  }
  const find = (url: string) => findHeldModelShardHandle<unknown>(url)
  await resumeHeldReferences<unknown>({
    queued,
    setAside: setAside ? (reference) => { setAside.push(reference); return true } : undefined,
    resumeUnminted: (reference, published, epoch, giveUp) =>
      resumeUnmintedModelShard(reference, published, epoch, find, giveUp),
    accepts: (reference) => isModelShardReferenceField(reference.field),
    holderDocumentId: meta.documentId,
    // A pointer held against an earlier epoch's ModelMeta (a shard created
    // offline, then a roll, then a reload) is published to the
    // CURRENT meta — where the forwarder's URL adoption would have put it.
    acceptsHolder: (holder) => supersededMetaDocumentIds.has(holder as DocumentId),
    holderName: 'ModelMeta',
    lost: 'its objects are lost to this workspace',
    isPublished: (reference) => {
      const field = reference.field as 'objectShardUrls' | 'connectionShardUrls'
      // Through `modelMetaUrls.ts`, never the raw field (G4-16f): on a
      // scalar-ruled ModelMeta — every epoch meta — the raw text
      // field is the frozen mirror, which never names a shard published
      // after the epoch's birth, so a held pointer would be re-published.
      // Published AND loaded by this boot. In the meta but NOT loaded — the
      // server adopted the shard from the old meta while this tab was
      // booting (measured in the two-roll e2e: the adoption landed between
      // the boot's shard load and this resume) — it is resumed all the same:
      // loaded here, its pointer write a deduplicated no-op.
      return loaded.has(reference.url) && (readMetaUrls(doc, field) ?? []).includes(reference.url)
    },
    find,
    onResumed,
  })
  const byOrder = (a: [number, unknown], b: [number, unknown]) => a[0] - b[0]
  resumed.objects = objects.sort(byOrder).map(([, handle]) => handle)
  resumed.connections = connections.sort(byOrder).map(([, handle]) => handle)
  return resumed
}

/**
 * Boot half of the held REGISTRY-shard pointers: shards this browser created
 * (overflow, or a summary workspace's write head) whose url the root does not
 * carry yet. Same contract as the model resume above — and the same reason it
 * runs on every boot path: a dangling registry shard breaks every client's
 * registry boot and sets the GC census incomplete fleet-wide (server/src/gc.ts),
 * which is why the pointer is held at all; an un-resumed one would instead hide
 * the shard's diagrams from everyone, the author included.
 *
 * The handles join `shardHandles` (so the author's diagrams are projected and
 * the flush keeps writing into them). While one is held, the classic absence
 * sweep abstains: its witnesses no longer equal root.shardUrls
 * (`observeRegistryAbsence`), which is the safe direction.
 */
async function resumeDeferredRegistryShardReferences(root: DocHandle<RootDoc>): Promise<void> {
  let queued: DeferredReference[]
  try {
    queued = await deferredReferences.list()
  } catch (error) {
    console.warn('deferred registry-shard references could not be read', error)
    return
  }
  if (!queued.some((reference) => reference.field === 'shardUrls')) return
  const doc = root.doc()
  await resumeHeldReferences<RegistryShard>({
    queued,
    accepts: (reference) => reference.field === 'shardUrls',
    holderDocumentId: root.documentId,
    holderName: 'root',
    lost: 'its diagrams are lost to this workspace',
    isPublished: (reference) => Boolean(doc?.shardUrls.includes(reference.url)),
    find: (url) => findHeldRegistryShardHandle(url),
    onResumed: (reference, handle) => {
      if (!shardHandles.some((loaded) => loaded.url === handle.url)) shardHandles.push(handle)
      attachShardListener(handle)
      // This browser chose it as the write head; its own metas live there.
      if (reference.writeHead && registrySummaryOnly) summaryRegistryWriteUrl = handle.url
    },
  })
}

/** One handle per url: two tabs publishing the same held shard can leave a
 *  url twice in ModelMeta (concurrent list inserts both survive the merge),
 *  and a duplicate index would split one shard's routing across two buckets
 *  that then overwrite each other. */
function uniqueUrls(urls: readonly string[] | undefined): string[] {
  return [...new Set(urls ?? [])]
}

/**
 * Per-shard model write (Slice 3) — replaces the monolithic
 * `modelHandle.change(reconcile(wholeModel))`. Routes objects/connections to shards
 * (stable fill, new shards on overflow) and reconciles ONLY the shards whose slice
 * actually changed (per-shard ref guard via `lastObject|ConnectionShardSlices`), so
 * an edit walks ~MODEL_SHARD_SIZE entities through the proxy, not the whole model.
 * Small collections (groups/domains/tags/decisionRecords) stay inline on the meta
 * and are reconciled only when one of them changed.
 *
 * On overflow this creates a shard. A browser cannot order two documents'
 * arrival at the server, so writing the new shard's url into ModelMeta in the
 * same turn lets a client dying in between leave a dangling pointer (`fsck
 * document-present` detects it). So the url goes through
 * `publishModelShardReference`: a MINTED shard is used locally at once and its
 * pointer is written only after the server acknowledges the shard; a shard on
 * a random fallback id keeps the old same-turn write, because the server can
 * only claim it through that pointer (deferredReferences.ts).
 */
function writeModelShards(
  objects: readonly C4Object[],
  connections: readonly Connection[],
  small: { groups: Group[]; domains: Domain[]; tags: Tag[]; decisionRecords: DecisionRecord[] }
): void {
  if (!modelMetaHandle) return
  faultPointForTest('writeModelShards')

  // Objects ──────────────────────────────────────────────────────────────────
  const objPlan = planShardAssignment(
    objects.map((o) => o.id),
    shardIndexByObjectId,
    objectShardHandles.length,
    MODEL_SHARD_SIZE,
    provisionalShardIndices(objectShardHandles as DocHandle<unknown>[]),
  )
  while (objectShardHandles.length < objPlan.shardCount) {
    const h = trackCreatedHandle(createObjectShardHandle({ objects: {} }))
    locallyCreatedModelShardUrls.add(h.url)
    objectShardHandles.push(h)
    attachModelShardListener(h as DocHandle<unknown>)
    publishModelShardReference('objectShardUrls', h)
  }
  const objBuckets = partitionByShard(objects, objPlan.route, objectShardHandles.length)
  const objListed = listedInMeta(objectShardHandles as DocHandle<unknown>[], 'objectShardUrls')
  for (let i = 0; i < objBuckets.length; i++) {
    if (!sameRefs(objBuckets[i], lastObjectShardSlices[i] ?? [])) {
      reconcileModelShardBucket(objectShardHandles[i], 'objects', objBuckets[i],
        objListed[i] === false ? (id) => { const at = objPlan.route.get(id); return at !== undefined && at !== i } : undefined)
      lastObjectShardSlices[i] = objBuckets[i]
    }
  }
  lastObjectShardSlices.length = objBuckets.length
  for (const [id, idx] of objPlan.route) shardIndexByObjectId.set(id, idx)

  // Connections (lower already excluded by the caller) ─────────────────────────
  const connPlan = planShardAssignment(
    connections.map((c) => c.id),
    shardIndexByConnectionId,
    connectionShardHandles.length,
    MODEL_SHARD_SIZE,
    provisionalShardIndices(connectionShardHandles as DocHandle<unknown>[]),
  )
  while (connectionShardHandles.length < connPlan.shardCount) {
    const h = trackCreatedHandle(createConnectionShardHandle({ connections: {} }))
    locallyCreatedModelShardUrls.add(h.url)
    connectionShardHandles.push(h)
    attachModelShardListener(h as DocHandle<unknown>)
    publishModelShardReference('connectionShardUrls', h)
  }
  const connBuckets = partitionByShard(connections, connPlan.route, connectionShardHandles.length)
  const connListed = listedInMeta(connectionShardHandles as DocHandle<unknown>[], 'connectionShardUrls')
  for (let i = 0; i < connBuckets.length; i++) {
    if (!sameRefs(connBuckets[i], lastConnectionShardSlices[i] ?? [])) {
      reconcileModelShardBucket(connectionShardHandles[i], 'connections', connBuckets[i],
        connListed[i] === false ? (id) => { const at = connPlan.route.get(id); return at !== undefined && at !== i } : undefined)
      lastConnectionShardSlices[i] = connBuckets[i]
    }
  }
  lastConnectionShardSlices.length = connBuckets.length
  for (const [id, idx] of connPlan.route) shardIndexByConnectionId.set(id, idx)

  // Small collections → meta doc (guarded: reconcile only when one changed) ─────
  const smallUnchanged =
    lastModelSlices !== null &&
    small.groups === lastModelSlices.groups &&
    small.domains === lastModelSlices.domains &&
    small.tags === lastModelSlices.tags &&
    small.decisionRecords === lastModelSlices.decisionRecords
  if (!smallUnchanged) {
    changeAndTrack(modelMetaHandle, (m) => {
      reconcileMapField(m, 'groups', byIdMap(small.groups))
      reconcileMapField(m, 'domains', byIdMap(small.domains))
      reconcileMapField(m, 'tagSnapshots', Object.fromEntries(small.tags.map((tag) => [tag.tagId, tag])))
      reconcileDecisionRecordCollection(m, small.decisionRecords)
    })
  }
  lastModelSlices = {
    objects: objects as unknown[],
    connections: connections as unknown[],
    groups: small.groups,
    domains: small.domains,
    tags: small.tags,
    decisionRecords: small.decisionRecords,
  }
}

/**
 * Lazily resolve the PERSISTENT edits-overlay handles (object + connection), the
 * offline-first write target under boot-from-server. The current bounded segment is
 * reused across sessions and recorded in the singular ModelMeta pointer; ordered
 * plural arrays retain all last-wins segments until acknowledged compaction. On a
 * fresh session we `repo.find` those URLs (the server holds them, so it serves on
 * request — no fetch race). The browser never creates or appends a segment: the
 * server mints the write heads with the ModelMeta (`buildModelMeta`) and owns
 * rotation, kept last in ModelMeta.{object,connection}ShardUrls so the read model
 * overlays them. Done after the first paint (or lazily on first edit), never in
 * the critical boot path. After it resolves we re-schedule a flush to write the edits
 * accumulated meanwhile (they sit durably in editsObjects/Connections until then).
 */
function orderedObjectOverlayUrls(meta: ModelMeta | undefined): string[] {
  const urls = [...(readMetaUrls(meta, 'editsObjectShardUrls') ?? [])].filter(isValidAutomergeUrl)
  const current = readMetaUrl(meta, 'editsObjectShardUrl')
  if (current && isValidAutomergeUrl(current)) {
    const index = urls.indexOf(current)
    if (index >= 0) urls.splice(index, 1)
    urls.push(current)
  }
  return [...new Set(urls)]
}

function orderedConnectionOverlayUrls(meta: ModelMeta | undefined): string[] {
  const urls = [...(readMetaUrls(meta, 'editsConnectionShardUrls') ?? [])].filter(isValidAutomergeUrl)
  const current = readMetaUrl(meta, 'editsConnectionShardUrl')
  if (current && isValidAutomergeUrl(current)) {
    const index = urls.indexOf(current)
    if (index >= 0) urls.splice(index, 1)
    urls.push(current)
  }
  return [...new Set(urls)]
}

function retainRetiredOverlayHandle(
  handle: DocHandle<ObjectShard> | DocHandle<ConnectionShard>,
): void {
  const workspaceKey = workspaceRefKey(currentRef)
  activeDocumentShare.unpin(handle.documentId, 'edits-overlay')
  if (!overlayBatchJournal.hasPendingDocument(workspaceKey, handle.documentId)) return
  retiredOverlayHandles.set(handle.documentId, handle)
  activeDocumentShare.pin(handle.documentId, 'edits-overlay-pending')
}

function releaseAcknowledgedRetiredOverlayHandles(): void {
  const workspaceKey = workspaceRefKey(currentRef)
  for (const [documentId] of retiredOverlayHandles) {
    if (overlayBatchJournal.hasPendingDocument(workspaceKey, documentId)) continue
    activeDocumentShare.unpin(documentId, 'edits-overlay-pending')
    retiredOverlayHandles.delete(documentId)
  }
}

async function reconcileOverlayBatchAcknowledgements(): Promise<void> {
  const workspaceKey = workspaceRefKey(currentRef)
  const pending = overlayBatchJournal.pending(workspaceKey)
  if (!pending.length || useAutomergeStatus.getState().status === 'offline') return
  const terminal: string[] = []
  for (let offset = 0; offset < pending.length; offset += 1_000) {
    const batchIds = pending.slice(offset, offset + 1_000).map((entry) => entry.batchId)
    const response = await apiFetch(`/api/model/overlay-batches/status?${withWorkspaceParams('')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchIds }),
    })
    if (!response.ok) throw new Error(`overlay batch status returned HTTP ${response.status}`)
    const body = await response.json() as {
      batches?: Array<{
        batchId: string
        status: OverlayBatchTerminalStatus | 'forwarding' | 'forwarding_conflict'
      }>
    }
    for (const batch of body.batches ?? []) {
      if (batch.status === 'projected'
        || batch.status === 'forwarded'
        || batch.status === 'conflict') terminal.push(batch.batchId)
    }
  }
  if (!terminal.length) return
  overlayBatchJournal.terminal(terminal)
  await persistOverlayBatchJournal(workspaceKvStore(), workspaceKey)
  releaseAcknowledgedRetiredOverlayHandles()
  markClientTimeline('overlay.batch.acknowledged', { batches: terminal.length })
}

function scheduleOverlayBatchAcknowledgement(delayMs = 1_000): void {
  if (overlayAckTimer) clearTimeout(overlayAckTimer)
  overlayAckTimer = setTimeout(() => {
    overlayAckTimer = null
    void reconcileOverlayBatchAcknowledgements().catch((error) => {
      console.warn('overlay batch acknowledgement failed', error)
    })
  }, delayMs)
}

/** Bound each replay-injected flush: a post-crash journal can hold thousands
 * (a lost bulk paste) and one giant changeAndTrack would block the main thread
 * right after first paint. */
const ENTITY_INTENT_REPLAY_CHUNK = 250

let smallCollectionReplaying = false
let smallCollectionReplayTimer: ReturnType<typeof setTimeout> | null = null
let diagramCollectionReplaying = false
let diagramCollectionReplayTimer: ReturnType<typeof setTimeout> | null = null
let diagramStubReplaying = false
let diagramStubReplayTimer: ReturnType<typeof setTimeout> | null = null
/** Diagram ids whose creation a repoint just put back into the journal
 * (`partitionDurableLedger`): their replay waits for a pool named for the
 * version they now live in (`replayDiagramStubIntents`). Session state. */
const carriedCreationIds = new Set<string>()
let offActiveDrainTimer: ReturnType<typeof setTimeout> | null = null
let diagramAbsenceSweeping = false
let diagramAbsenceSweepTimer: ReturnType<typeof setTimeout> | null = null
// A trigger landing while a sweep is in flight must not be eaten — remote
// deletes arrive in reconnect bursts, exactly when a sweep is likely running
// (durableAckFollowUp's pattern).
let diagramAbsenceSweepFollowUp = false
/** Summary-local ids whose retirement was PLANNED but whose ack may not have
 * landed yet: the synchronous memo cleanup removes them from
 * `summaryLocalDiagramIds` (anti-resurrection), which would also destroy the
 * PROVABILITY a failed ack needs to retry — the exact one-shot consumption
 * the sweep exists to ban. The planner sees the
 * union; entries leave on a successful ack or at stop. */
const summaryRetiredDiagramIds = new Set<string>()

/** Debounced in-session trigger for the off-active placement drain:
 * applyDiagramLayout on a NON-current diagram journals records that no
 * boot/reconnect/activation trigger would ever drain in a stable online
 * session — the badge would read 'saving' forever and other devices would
 * never receive the layout. */
function scheduleOffActivePlacementDrain(): void {
  if (offActiveDrainTimer) return
  offActiveDrainTimer = setTimeout(() => {
    offActiveDrainTimer = null
    if (!started) return
    const workspaceKey = workspaceRefKey(currentRef)
    const hasOffActive = pendingPlacementIntents.pendingDiagramIds(workspaceKey)
      .some((id) => id !== activeDiagramId)
    if (hasOffActive) void drainOffActivePlacementIntents()
  }, 2_000)
}

/** Deferred trigger for `replaySmallCollectionIntents` — used by
 * `writeSmallCollections` when a value-checked acknowledgement leaves
 * survivors (a projection clobbered the store slice between capture and
 * flush; the flush loop can no longer express the journaled value, only the
 * replay can, straight into ModelMeta). */
function scheduleSmallCollectionReplay(): void {
  if (smallCollectionReplayTimer) return
  smallCollectionReplayTimer = setTimeout(() => {
    smallCollectionReplayTimer = null
    void replaySmallCollectionIntents()
  }, 0)
}

/**
 * Replay of the SMALL-COLLECTION journal (groups, domains,
 * tagSnapshots, decisionRecords), shared by BOTH boot modes.
 *
 * Deliberately simpler than the entity replay above, because the families'
 * durability story is simpler: their one durable home is the ModelMeta inline
 * map, which is resolved in BFS mode (precisely for the small collections)
 * and in resident sharded mode alike — so the SAME materialized document is
 * both the replay target and the durability witness, there is no compaction
 * ambiguity, no batch-id substrate, and no server round trip. Application is
 * DOC SURGERY, never store actions: replaying a group delete through
 * `store.deleteGroup` would re-run its cascade over the CURRENT incident
 * connections (the crashed session already journaled its own cascade as
 * connection intents), and a full-set store flush from a not-yet-projected
 * store would erase every durable entity the store has not seen yet.
 *
 * A monolith workspace has no ModelMeta — and can have no small-collection
 * intents either (capture is bfsActive-gated and sharding is one-way), so
 * the missing-handle return is a consistency guard, not a deferral.
 */
async function replaySmallCollectionIntents(): Promise<void> {
  if (smallCollectionReplaying) return
  smallCollectionReplaying = true
  const epoch = durableAckEpoch
  try {
    await entityIntentHydration
    if (epoch !== durableAckEpoch || !started) return
    const metaHandle = modelMetaHandle
    if (!metaHandle) return
    const workspaceKey = workspaceRefKey(currentRef)
    const intents = pendingEntityIntents.pending(workspaceKey)
      .filter((intent) => isSmallCollectionKind(intent.kind))
    if (!intents.length) return
    const meta = metaHandle.doc()
    if (!meta) return
    const asMap = (record: Record<string, unknown> | undefined) =>
      new Map(Object.entries(record ?? {})) as ReadonlyMap<string, Record<string, unknown>>
    const plan = planSmallCollectionIntentReplay({
      intents,
      current: {
        group: asMap(meta.groups as Record<string, unknown> | undefined),
        domain: asMap(meta.domains as Record<string, unknown> | undefined),
        tagSnapshot: asMap(meta.tagSnapshots as Record<string, unknown> | undefined),
        decisionRecord: asMap(meta.decisionRecords as Record<string, unknown> | undefined),
      },
      deletedDecisionRecordIds: new Set(meta.deletedDecisionRecordIds ?? []),
    })
    // Revision captured BEFORE the durable write — the standing ack contract.
    const revision = pendingEntityIntents.revisionNow
    // The map key is the family's registered id field (`tagId` for tagSnapshot).
    const keyOfValue = (kind: SmallCollectionIntentKind, value: unknown): string =>
      entityKeyOf(ENTITY_FAMILY_BY_NAME[kind], value)
    const replayedByKind: Record<SmallCollectionIntentKind, string[]> = {
      group: [], domain: [], tagSnapshot: [], decisionRecord: [],
    }
    for (const kind of SMALL_INTENT_KINDS) {
      for (const value of plan.replayUpserts[kind]) {
        const id = keyOfValue(kind, value)
        if (id) replayedByKind[kind].push(id)
      }
      for (const id of plan.replayDeletes[kind]) replayedByKind[kind].push(id)
    }
    const hasWrites = SMALL_INTENT_KINDS.some((kind) => replayedByKind[kind].length > 0)
      || plan.unTombDecisionRecordIds.length > 0
    if (hasWrites) {
      markClientTimeline('entity-intents.small-replay', {
        replayed: SMALL_INTENT_KINDS.reduce((sum, kind) => sum + replayedByKind[kind].length, 0),
        satisfied: plan.satisfied.length,
      })
      changeAndTrack(metaHandle, (m) => {
        const fields = m as unknown as Record<string, Record<string, unknown> | undefined>
        for (const kind of SMALL_INTENT_KINDS) {
          const field: EntityCollection = ENTITY_FAMILY_BY_NAME[kind].collection
          // Created only for a kind with upserts, then RE-READ (`local/no-detached-container-write`).
          if (!fields[field] && plan.replayUpserts[kind].some((value) => keyOfValue(kind, value))) fields[field] = {}
          const target = fields[field]
          if (!target) continue
          for (const value of plan.replayUpserts[kind]) {
            const id = keyOfValue(kind, value)
            if (!id) continue
            const clean = stripUndefined(value)
            if (target[id]) reconcile(target[id] as Record<string, unknown>, clean, ENTITY_SCHEMAS[field])
            else target[id] = clean
          }
          for (const id of plan.replayDeletes[kind]) delete target[id]
        }
        // ADR deletes leave the one positive artifact this planner knows: the
        // durable tombstone, on delta/paged metas where absence alone is not
        // expressible (the baseline shards are immutable). IN PLACE — a fresh
        // array assignment is an Automerge LWW list swap that discards a
        // colleague's concurrently-pushed tombstone, resurrecting THEIR
        // delete (writeTombstones push/splices for the same reason).
        if (plan.replayDeletes.decisionRecord.length && usesDecisionRecordDelta(m)) {
          if (!m.deletedDecisionRecordIds) m.deletedDecisionRecordIds = []
          const have = new Set(m.deletedDecisionRecordIds)
          for (const id of plan.replayDeletes.decisionRecord) {
            if (!have.has(id)) m.deletedDecisionRecordIds.push(id)
          }
        }
        if (plan.unTombDecisionRecordIds.length && m.deletedDecisionRecordIds) {
          const lift = new Set(plan.unTombDecisionRecordIds)
          for (let i = m.deletedDecisionRecordIds.length - 1; i >= 0; i--) {
            if (lift.has(m.deletedDecisionRecordIds[i])) m.deletedDecisionRecordIds.splice(i, 1)
          }
        }
      })
      // A replayed group delete must clean up what `store.deleteGroup` would
      // have: non-active diagrams keep their composition verbatim
      // from the registry shard unless the id is in `tombstoneGroups`, and
      // the ACTIVE diagram's composition flushes from the store — without
      // both, the replayed delete leaves a group listed by every diagram.
      // (Orphan layout keys in diagram docs are left to the
      // reference-integrity scanner, like any other dangling ref.)
      for (const id of plan.replayDeletes.group) tombstoneGroups.add(id)
      // Inject the replayed values into the STORE in the same tick, do not
      // wait for the async re-projection: `writeSmallCollections` reconciles
      // the FULL SET from the store, so any user-triggered flush landing in
      // the meta-committed→store-projected gap would erase the just-replayed
      // entities right back out of ModelMeta. withRemote, so this never
      // re-captures; the touched families' baselines are reseeded explicitly
      // below (families the replay did not touch keep their baselines — a
      // pending domain edit must not be adopted as its own baseline by a
      // group replay).
      withRemote(() => {
        const s = useModelStore.getState()
        const mergeSlice = <T>(
          items: readonly T[],
          kind: SmallCollectionIntentKind,
          keyOf: (item: T) => string,
        ): T[] => {
          const deletes = new Set(plan.replayDeletes[kind])
          const upserts = new Map(plan.replayUpserts[kind]
            .map((value) => [keyOfValue(kind, value), value] as const)
            .filter(([id]) => id !== ''))
          const merged = items
            .filter((item) => !deletes.has(keyOf(item)))
            .map((item) => (upserts.get(keyOf(item)) as T | undefined) ?? item)
          const have = new Set(merged.map(keyOf))
          for (const [id, value] of upserts) {
            if (!have.has(id)) merged.push(value as T)
          }
          return merged
        }
        const touched = (kind: SmallCollectionIntentKind) =>
          plan.replayUpserts[kind].length > 0 || plan.replayDeletes[kind].length > 0
        const groups = touched('group') ? mergeSlice(s.groups, 'group', (g) => g.id) : s.groups
        const domains = touched('domain') ? mergeSlice(s.domains, 'domain', (d) => d.id) : s.domains
        const tags = touched('tagSnapshot') ? mergeSlice(s.tags, 'tagSnapshot', (t) => t.tagId) : s.tags
        const decisionRecords = touched('decisionRecord')
          ? mergeSlice(s.decisionRecords, 'decisionRecord', (r) => r.id)
          : s.decisionRecords
        const deletedGroupIds = new Set(plan.replayDeletes.group)
        const diagrams = deletedGroupIds.size
          ? s.diagrams.map((diagram) => diagram.groupIds?.some((id) => deletedGroupIds.has(id))
            ? { ...diagram, groupIds: diagram.groupIds.filter((id) => !deletedGroupIds.has(id)) }
            : diagram)
          : s.diagrams
        useModelStore.setState({ groups, domains, tags, decisionRecords, diagrams })
        smallCapture.seed({
          ...(touched('group') ? { group: groups } : {}),
          ...(touched('domain') ? { domain: domains } : {}),
          ...(touched('tagSnapshot') ? { tagSnapshot: tags } : {}),
          ...(touched('decisionRecord') ? { decisionRecord: decisionRecords } : {}),
        })
      })
    }
    // Flush-then-forget through the ONE helper that owns the ordering (do not
    // re-inline it: the forget-before-flush ordering is only testable there).
    // What is forgotten differs by mode:
    //
    //  - SATISFIED intents die in both modes — nothing was written for them.
    //  - REPLAYED intents die immediately only in RESIDENT mode, where
    //    `writeSmallCollections` never runs. Under BFS they STAY JOURNALED
    //    and the scheduled flush below re-expresses them from the injected
    //    store slices; the value-checked ack (merge predicate) retires them
    //    there. A direct ack here would be one-shot: a later projection
    //    clobber + full-set flush would erase the replayed value with no
    //    intent left to re-assert it.
    const sentWorkspace = documentsWorkspaceKey()
    const forgetForMode = () => {
      if (epoch !== durableAckEpoch) return
      markReplayedSent(workspaceKey, plan.satisfied, sentWorkspace, [metaHandle.documentId], epoch)
      if (!bfsActive) {
        for (const kind of SMALL_INTENT_KINDS) {
          if (replayedByKind[kind].length) {
            markIntentsSent(workspaceKey, kind, replayedByKind[kind], revision, sentWorkspace, [metaHandle.documentId], epoch)
          }
        }
      }
    }
    // Store captured EAGERLY: the closure runs
    // after an awaited flush, and workspaceKvStore() resolved THEN would
    // follow a mid-flight workspace switch into the NEW workspace's
    // namespace — the old journal serialization (often empty) deleting the
    // new workspace's fresh tab key.
    const persistStore = workspaceKvStore()
    await forgetIntentsOnceDurable(
      () => repo.flush([metaHandle.documentId]),
      forgetForMode,
      () => flushEntityIntentPersistence(persistStore, workspaceKey),
    )
    if (epoch !== durableAckEpoch) return
    if (bfsActive && hasWrites) scheduleWrite('normal')
    scheduleDurableAcknowledgement(0)
  } catch (error) {
    console.error('small-collection intent replay failed', error)
  } finally {
    if (epoch === durableAckEpoch) smallCollectionReplaying = false
  }
}

/** Deferred trigger for `replayDiagramCollectionIntents` — fired from the
 * replay junctions, from `attachActive` (the doc arriving IS the carrier this
 * replay was waiting for) and by a flush ack that left survivors. */
function scheduleDiagramCollectionReplay(): void {
  if (diagramCollectionReplayTimer) return
  diagramCollectionReplayTimer = setTimeout(() => {
    diagramCollectionReplayTimer = null
    void replayDiagramCollectionIntents()
  }, 0)
}

/**
 * Replay of the DIAGRAM-COLLECTION journal (comments, flows),
 * shared by both boot modes. The carrier is the ACTIVE DiagramDoc — the only
 * one resident — so the pass replays exactly the intents whose `diagramId`
 * is the active diagram and leaves the rest journaled (badge-counted) until
 * their diagram is activated; `attachActive` re-fires it on every activation.
 * Application is DOC SURGERY + a same-tick store injection, the small-
 * collection template verbatim (flushWrite step 3 is a full-set write from
 * the store for the active diagram, so a user flush landing in the
 * doc-committed→store-projected gap would erase the replayed values).
 */
async function replayDiagramCollectionIntents(): Promise<void> {
  if (diagramCollectionReplaying) return
  diagramCollectionReplaying = true
  const epoch = durableAckEpoch
  try {
    await entityIntentHydration
    if (epoch !== durableAckEpoch || !started) return
    const handle = activeDiagramHandle
    const diagramId = activeDiagramId
    const doc = activeDiagramDoc()
    if (!handle || !diagramId || !doc) return
    const workspaceKey = workspaceRefKey(currentRef)
    const intents = pendingEntityIntents.pending(workspaceKey)
      .filter((intent) => isDiagramCollectionKind(intent.kind))
    if (!intents.length) return
    const asMap = (record: Record<string, unknown> | undefined) =>
      new Map(Object.entries(record ?? {})) as ReadonlyMap<string, Record<string, unknown>>
    const plan = planDiagramCollectionIntentReplay({
      intents,
      activeDiagramId: diagramId,
      current: {
        comment: asMap(doc.comments as Record<string, unknown> | undefined),
        flow: asMap(doc.flows as Record<string, unknown> | undefined),
      },
    })
    // Revision captured BEFORE the durable write — the standing ack contract.
    // Capturing it inside forgetForMode (after the flush resolved) would ack
    // through revisionNow at THAT moment, erasing an intent the user
    // re-recorded while the flush was in flight (the resident-mode branch
    // below is the consumer).
    const revision = pendingEntityIntents.revisionNow
    const replayedByKind: Record<DiagramCollectionIntentKind, string[]> = { comment: [], flow: [] }
    for (const kind of DIAGRAM_INTENT_KINDS) {
      for (const value of plan.replayUpserts[kind]) {
        const id = String((value as { id?: unknown }).id ?? '')
        if (id) replayedByKind[kind].push(id)
      }
      for (const id of plan.replayDeletes[kind]) replayedByKind[kind].push(id)
    }
    const hasWrites = DIAGRAM_INTENT_KINDS.some((kind) => replayedByKind[kind].length > 0)
    if (hasWrites) {
      markClientTimeline('entity-intents.diagram-collection-replay', {
        replayed: DIAGRAM_INTENT_KINDS.reduce((sum, kind) => sum + replayedByKind[kind].length, 0),
        satisfied: plan.satisfied.length,
        remaining: plan.remaining,
      })
      changeAndTrack(handle, (d) => {
        const fields = d as unknown as Record<string, Record<string, unknown> | undefined>
        const idOf = (value: unknown) => String((value as { id?: unknown }).id ?? '')
        for (const kind of DIAGRAM_INTENT_KINDS) {
          const field: EntityCollection = ENTITY_FAMILY_BY_NAME[kind].collection
          // Created only for a kind with upserts, then RE-READ (`local/no-detached-container-write`).
          if (!fields[field] && plan.replayUpserts[kind].some((value) => idOf(value))) fields[field] = {}
          const target = fields[field]
          if (!target) continue
          for (const value of plan.replayUpserts[kind]) {
            const id = idOf(value)
            if (!id) continue
            const clean = stripUndefined(value)
            if (target[id]) reconcile(target[id] as Record<string, unknown>, clean, ENTITY_SCHEMAS[field])
            else target[id] = clean
          }
          for (const id of plan.replayDeletes[kind]) delete target[id]
        }
      })
      // Same-tick store injection: the slices are windowed to the active
      // diagram, so every replayed value belongs in them. withRemote — never
      // a re-capture; the baselines reseed from the injected values.
      withRemote(() => {
        const s = useModelStore.getState()
        const mergeSlice = <T extends { id: string }>(
          items: readonly T[],
          kind: DiagramCollectionIntentKind,
        ): T[] => {
          const deletes = new Set(plan.replayDeletes[kind])
          const upserts = new Map(plan.replayUpserts[kind]
            .map((value) => [String((value as { id?: unknown }).id ?? ''), value] as const)
            .filter(([id]) => id !== ''))
          const merged = items
            .filter((item) => !deletes.has(item.id))
            .map((item) => (upserts.get(item.id) as T | undefined) ?? item)
          const have = new Set(merged.map((item) => item.id))
          for (const [id, value] of upserts) {
            if (!have.has(id)) merged.push(value as unknown as T)
          }
          return merged
        }
        const touched = (kind: DiagramCollectionIntentKind) =>
          plan.replayUpserts[kind].length > 0 || plan.replayDeletes[kind].length > 0
        const comments = touched('comment') ? mergeSlice(s.comments, 'comment') : s.comments
        const flows = touched('flow') ? mergeSlice(s.flows, 'flow') : s.flows
        useModelStore.setState({ comments, flows })
        diagramCapture.seed({
          ...(touched('comment') ? { comment: comments } : {}),
          ...(touched('flow') ? { flow: flows } : {}),
        })
      })
    }
    // Mode split, the small-collection rule verbatim: SATISFIED intents die
    // in both modes; REPLAYED intents die immediately only in RESIDENT mode.
    // Under BFS they stay journaled — a stale projectActiveFromServer landing
    // after this pass would rebuild the slices from a pre-replay server
    // render, and the next full-set flush would erase the replayed value with
    // no intent left to re-assert it. The scheduled flush re-expresses them
    // from the injected slices and the value-checked ack retires them.
    const sentWorkspace = documentsWorkspaceKey()
    const forgetForMode = () => {
      if (epoch !== durableAckEpoch) return
      markReplayedSent(workspaceKey, plan.satisfied, sentWorkspace, [handle.documentId], epoch)
      if (!bfsActive) {
        for (const kind of DIAGRAM_INTENT_KINDS) {
          if (replayedByKind[kind].length) {
            markIntentsSent(workspaceKey, kind, replayedByKind[kind], revision, sentWorkspace, [handle.documentId], epoch)
          }
        }
      }
    }
    // Store captured eagerly — same mid-flight-switch rationale as the
    // small-collection replay above.
    const persistStore = workspaceKvStore()
    await forgetIntentsOnceDurable(
      () => repo.flush([handle.documentId]),
      forgetForMode,
      () => flushEntityIntentPersistence(persistStore, workspaceKey),
    )
    if (epoch !== durableAckEpoch) return
    if (hasWrites) scheduleWrite('normal')
    scheduleDurableAcknowledgement(0)
  } catch (error) {
    console.error('diagram-collection intent replay failed', error)
  } finally {
    if (epoch === durableAckEpoch) diagramCollectionReplaying = false
  }
}

/** Deferred trigger for `replayDiagramStubIntents`. */
function scheduleDiagramStubReplay(): void {
  if (diagramStubReplayTimer) return
  diagramStubReplayTimer = setTimeout(() => {
    diagramStubReplayTimer = null
    void replayDiagramStubIntents()
  }, 0)
}

/**
 * Replay of the DIAGRAM-STUB journal (creations, renames, deletes),
 * shared by both boot modes. Witness and target are the loaded registry
 * metas. Application is a STORE injection + `scheduleWrite`: flushWrite's
 * ordinary registry pass is the one writer of metas (creations additionally
 * get their DiagramDoc from `ensureDiagramDoc`, seeded from the injected
 * snapshot — composition and layouts included), and the flush-side
 * `planDiagramStubAck` retires the intents once the written metas express
 * them. Recreation keeps the ORIGINAL diagram id, so a crash that outran the
 * ack cannot mint a second diagram — the registry merge converges on one
 * entry per id.
 */
async function replayDiagramStubIntents(): Promise<void> {
  if (diagramStubReplaying) return
  diagramStubReplaying = true
  const epoch = durableAckEpoch
  try {
    await entityIntentHydration
    if (epoch !== durableAckEpoch || !started || !rootHandle) return
    const workspaceKey = workspaceRefKey(currentRef)
    const pendingStubs = () => pendingEntityIntents.pending(workspaceKey)
      .filter((intent) => intent.kind === 'diagram')
      // Same gate as the flush-side ack: an id whose doc flush is still
      // pending is already being expressed by the ordinary path.
      .filter((intent) => !pendingDurableDiagramDocs.has(intent.id))
    // A creation a repoint carried over gets a NEW DiagramDoc here (through
    // `ensureDiagramDoc`), and that document must be named for the version it
    // now lives in: the minted pool may still hold ids of the version the work
    // left (`noteMintedIdSupplyWorkspace` drops it, the mint refills it). Only
    // carried creations wait — an ordinary crash replay must not hang on a slow
    // mint — and only before the plan, which the wait would otherwise stale.
    const carried = pendingStubs().filter((intent) => carriedCreationIds.has(intent.id)).length
    if (carried > 0) {
      // The note again, AWAITED: the partition's own call is not, and a
      // capacity read before its drop would count the old version's ids.
      const booted = documentsWorkspaceKey()
      if (booted) await noteMintedIdSupplyWorkspace(booted)
      await ensureMintedIdCapacity(carried)
      if (epoch !== durableAckEpoch || !started || !rootHandle) return
    }
    const intents = pendingStubs()
    for (const intent of intents) carriedCreationIds.delete(intent.id)
    if (!intents.length) return
    // SHARD DOCS ONLY as witness — same rule as the flush-side ack: the
    // in-memory summary window is partly fed by this client itself. A shard
    // whose doc() has not resolved yet is NOT an empty shard: claiming
    // completeness over it would read "still loading" as "those diagrams
    // were deleted" — completeness requires
    // every handle to have materialized.
    const allShardsLoaded = shardHandles.every((h) => h.doc() !== undefined)
    const metas = mergeShards(shardHandles.map((h) => h.doc() ?? { diagrams: {} }))
    const currentMetaStubs = new Map(metas.map((meta) => [meta.id, diagramStubOf(meta)]))
    const plan = planDiagramStubReplay({
      intents,
      currentMetaStubs,
      metasComplete: allShardsLoaded && !registrySummaryOnly,
      tombstonedIds: tombstoneDiagrams,
      // The tombstone is expressible exactly where it is written: a summary
      // registry with a resident ModelMeta.
      canTombstone: registrySummaryOnly && modelMetaHandle !== null,
    })
    // A diagram delete journaled before the flush landed (offline, or a hard kill)
    // is RE-EXPRESSED rather than parked. Adopting the ids back into the
    // session set is the whole replay: the next flush's `writeDiagramTombstones`
    // writes them and acknowledges against the ModelMeta flush, exactly as if
    // the user had just clicked Delete.
    for (const id of plan.replayTombstones) {
      tombstoneDiagrams.add(id)
      unTombDiagrams.delete(id)
    }
    // The mirror arm, which prevents a silent LOSS. A journaled creation of a
    // tombstoned id must not be marked `satisfied`: the intent would die, the
    // diagram would stay hidden behind the tombstone filter and the badge would
    // go green over it. The lift is the whole expression a re-created
    // SERVER-OWNED diagram can have here (ModelMeta carries no diagram
    // overrides), so `writeDiagramTombstones` both splices the entry and
    // acknowledges the creation against that same flush.
    for (const id of plan.replayLifts) {
      tombstoneDiagrams.delete(id)
      unTombDiagrams.add(id)
    }
    if (plan.replayTombstones.length || plan.replayLifts.length) publishDiagramTombstones()
    const hasWrites = plan.replayCreates.length > 0
      || plan.replayStubPatches.length > 0
      || plan.replayDeletes.length > 0
      || plan.replayTombstones.length > 0
      || plan.replayLifts.length > 0
    if (hasWrites) {
      markClientTimeline('entity-intents.diagram-replay', {
        creates: plan.replayCreates.length,
        patches: plan.replayStubPatches.length,
        deletes: plan.replayDeletes.length,
        tombstones: plan.replayTombstones.length,
        lifts: plan.replayLifts.length,
        satisfied: plan.satisfied.length,
        remaining: plan.remaining,
      })
      withRemote(() => {
        const s = useModelStore.getState()
        const deletes = new Set(plan.replayDeletes)
        const patchById = new Map(plan.replayStubPatches.map((patch) => [patch.id, patch.fields]))
        let diagrams = s.diagrams
          .filter((diagram) => !deletes.has(diagram.id))
          .map((diagram) => {
            const fields = patchById.get(diagram.id)
            return fields ? { ...diagram, ...fields } as Diagram : diagram
          })
        const have = new Set(diagrams.map((diagram) => diagram.id))
        const created: Diagram[] = []
        for (const snapshot of plan.replayCreates) {
          if (have.has(snapshot.id)) continue
          created.push(snapshot)
        }
        if (created.length) diagrams = [...diagrams, ...created]
        // Hold the recreated diagrams through any projection landing before
        // their registry meta is re-written — the same shield a live creation
        // gets from onStoreChange (which withRemote deliberately skips).
        if (created.length) {
          localDiagramHold.noteCreated(diagrams, s.diagrams)
          if (registrySummaryOnly) for (const diagram of created) captureSummaryLocalDiagram(diagram)
        }
        // Summary mode writes metas only for ids in summaryLocalDiagramIds —
        // a per-session memo the crash erased. Re-admit every replayed id
        // whose meta lives in a locally loaded shard (write-head), or the
        // patch/delete below would never reach a durable write.
        if (registrySummaryOnly) {
          for (const patch of plan.replayStubPatches) {
            if (currentMetaStubs.has(patch.id)) summaryLocalDiagramIds.add(patch.id)
          }
          for (const id of plan.replayDeletes) {
            if (currentMetaStubs.has(id)) summaryLocalDiagramIds.add(id)
          }
        }
        useModelStore.setState({ diagrams })
        stubCapture.seed(diagrams)
      })
    }
    // SATISFIED intents go SENT now (flush-then-mark through the one helper:
    // satisfied by the LOCAL shards is a local fact, `markReplayedSent`);
    // REPLAYED intents stay journaled in BOTH modes — the registry pass of
    // the next flush writes the metas, and its planDiagramStubAck retires
    // them against what was actually written.
    const shardDocIds = shardHandles.map((shardHandle) => shardHandle.documentId)
    const persistStore = workspaceKvStore()
    const sentWorkspace = documentsWorkspaceKey()
    await forgetIntentsOnceDurable(
      () => repo.flush(shardDocIds),
      () => {
        if (epoch !== durableAckEpoch) return
        for (const [carriers, ids] of registryCarriersOf(plan.satisfied.map((done) => done.id))) {
          const grouped = plan.satisfied.filter((done) => ids.includes(done.id))
          markReplayedSent(workspaceKey, grouped.map((done) => ({ ...done, kind: 'diagram' as const })), sentWorkspace, carriers, epoch)
        }
      },
      () => flushEntityIntentPersistence(persistStore, workspaceKey),
    )
    if (epoch !== durableAckEpoch) return
    if (hasWrites) scheduleWrite('normal')
    scheduleDurableAcknowledgement(0)
  } catch (error) {
    console.error('diagram stub intent replay failed', error)
  } finally {
    if (epoch === durableAckEpoch) diagramStubReplaying = false
  }
}

/**
 * Replay the crash journal once BOTH conditions hold: the journal is hydrated
 * AND the overlay handles are materialized. Called at the end of every full
 * `ensureOverlayHandles` body; the await on `entityIntentHydration` makes the
 * call correct in either completion order, and the first resolution of a
 * session always runs the full body (stopBridge nulls the handles), so the
 * early-return paths of ensureOverlayHandles cannot skip a session's replay.
 * Guarded by the session epoch: a workspace switch during any await aborts
 * silently instead of injecting workspace A's intents into B's state.
 */
async function maybeReplayEntityIntents(options?: { withoutHandles?: boolean }): Promise<void> {
  if (entityIntentReplaying) {
    // Remember the request instead of dropping it (durableAckFollowUp's
    // pattern): a normal replay arriving while a degraded one still awaits
    // hydration must run afterwards, not vanish. And never DOWNGRADE a queued
    // normal request to a degraded one: the degraded pass is latched, so the
    // normal replay would be lost until a reconnect.
    const queuedNormal = entityIntentReplayFollowUp !== null && !entityIntentReplayFollowUp.withoutHandles
    if (!queuedNormal) entityIntentReplayFollowUp = options ?? {}
    return
  }
  entityIntentReplaying = true
  const epoch = durableAckEpoch
  try {
    await entityIntentHydration
    if (epoch !== durableAckEpoch) return
    if (!started || !bfsActive) return
    // The small-collection families replay on their own, simpler track (their
    // carrier and witness is ModelMeta in every mode) — and they need none of
    // the overlay-handle gates below, so a degraded workspace still drains
    // them. Fire-and-forget: it holds its own single-flight latch.
    void replaySmallCollectionIntents()
    // The diagram-scoped families ride the same junction — their
    // carriers (active DiagramDoc, registry shards) need no overlay handles
    // either, and each pass self-guards on its carrier being resident.
    scheduleDiagramCollectionReplay()
    scheduleDiagramStubReplay()
    // Remote-delete anti-entropy: the junction IS the crash-recovery path —
    // a sweep aborted by a kill re-runs here at the next boot/reconnect.
    scheduleDiagramAbsenceSweep()
    // Degraded mode (withoutHandles): the workspace has no resolvable write
    // head, so nothing can be made durable in the overlay yet — but the
    // journaled entities are re-injected so the user SEES their work after a
    // reload instead of a silently emptied diagram, delete intents still drain
    // through ModelMeta tombstones, and everything re-runs normally once a
    // server repair publishes heads (the ModelMeta change listener re-enters
    // via scheduleOverlayHydration).
    if (!options?.withoutHandles && (!editsObjectShardHandle || !editsConnectionShardHandle)) return
    if (options?.withoutHandles) {
      if (entityIntentsDegradedReplayed) return
      entityIntentsDegradedReplayed = true
    }
    const workspaceKey = workspaceRefKey(currentRef)
    // Captured with the journal key, once: this session's ref and the root it
    // ACTUALLY holds. The server witness must answer about the documents this
    // replay writes into; `documentsWorkspaceFor` names them only while the
    // recorded basis came with THIS root url, so a basis a stale fetch
    // overwrote stops matching and the witness is skipped, never misdirected.
    const witnessJournal = { ref: currentRef, bootedRootUrl: sessionRootUrl() }
    // Object/connection intents ONLY — POSITIVE admission. A negative filter
    // (`!isSmallCollectionKind`) would let any kind that is neither small nor
    // object/connection fall through to the binary dispatch below, which plans
    // every non-object as a CONNECTION — a 'flow' hydrated from a newer
    // sibling's journal would be written into the connection overlay shard.
    // Unknown kinds PARK: journaled, badge-counted, planned by nobody until a
    // build that knows them.
    const intents = pendingEntityIntents.pending(workspaceKey)
      .filter((intent) => isEntityPlannerKind(intent.kind))
    if (intents.length === 0) return
    // Batch ids carried by the resolved shards — membership proves an intent's
    // write happened, so it is acknowledged without any value comparison.
    const objectBatchIds = new Set<string>()
    for (const handle of editsObjectSegmentHandles) {
      for (const id of handle.doc()?.writeBatchIds ?? []) objectBatchIds.add(id)
    }
    const connectionBatchIds = new Set<string>()
    for (const handle of editsConnectionSegmentHandles) {
      for (const id of handle.doc()?.writeBatchIds ?? []) connectionBatchIds.add(id)
    }
    // Current values from DURABILITY WITNESSES only: the materialized overlay
    // docs, and the SERVER read model (a projection of durable documents; it
    // also covers the post-compaction case where the overlay alone is empty).
    // NEVER getModelQuery(): its paging-index rung serves the very records this
    // replay feeds for visibility, so consulting it makes the equality guard
    // compare our snapshot against our own cache and acknowledge an intent that
    // was never durable anywhere (the instrument must not hold what the
    // subject needs).
    const currentObjects = new Map<string, C4Object>()
    const currentConnections = new Map<string, Connection>()
    const serverWitness = isServerReadModelEnabled()
    // The server witness must be able to vouch for ABSENCE, not just presence:
    // a failed fetch means "unknown", never "absent". The planner defers
    // stamped intents rather than whole-snapshot-replaying them blind.
    // Every witness call is DEADLINED (the loop runs under the replay lock and
    // a journal can hold up to its soft cap of intents — an unbounded await
    // per call would wedge the lock), and once the
    // witness is unreliable there is no point asking it again.
    let witnessesReliable = serverWitness
    const WITNESS_DEADLINE_MS = 3_000
    const witnessed = async <T,>(query: Promise<T | undefined>): Promise<T | undefined> => {
      // The timer is CLEARED once the race settles: a leftover timer from a
      // chunk that succeeded would fire seconds later and flip
      // witnessesReliable during a later chunk — a deferral caused by a call
      // that succeeded.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          query.catch(() => { witnessesReliable = false; return undefined }),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => {
              witnessesReliable = false
              resolve(undefined)
            }, WITNESS_DEADLINE_MS)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    const witnessObjectIds: string[] = []
    const witnessConnectionIds: string[] = []
    // T-SUM-2b: the batch of every stamped upsert the loaded segments do not
    // carry. The server is asked whether it ever received it — the only proof
    // left once a rotation, a fold or a compaction took the segment out of
    // sight, and the one that stops a replay from undoing what followed the
    // write (a colleague's deletion: the entity came back, measured on both
    // planes, T-SUM-2b).
    const witnessBatchIds = new Set<string>()
    // Captured with `intents`: an id dirty NOW is skipped below, so it must
    // stay in flight for the planner even if a write consumes it during the
    // witness awaits (its captured record still names the old batch, and its
    // overlay value was never read — replaying it then would be blind).
    const dirtyObjectsAtStart = new Set(dirtyObjectIds)
    const dirtyConnectionsAtStart = new Set(dirtyConnectionIds)
    for (const intent of intents) {
      if (intent.op !== 'upsert') {
        // A delete's "gone from the model" condition reads these maps too;
        // the overlay is the only local witness worth consulting for it (no
        // server round trip — a tombstone present in meta is the durable half).
        if (intent.kind === 'object') {
          const value = effectiveObjectOverlay.get(intent.id)
          if (value) currentObjects.set(intent.id, value)
        } else {
          const value = effectiveConnectionOverlay.get(intent.id)
          if (value) currentConnections.set(intent.id, value)
        }
        continue
      }
      const batchIds = intent.kind === 'object' ? objectBatchIds : connectionBatchIds
      if (intent.writtenInBatchId && batchIds.has(intent.writtenInBatchId)) continue
      // Its value already waits for this session's next write (the planner's
      // `inFlight`): no question to ask about it.
      if ((intent.kind === 'object' ? dirtyObjectsAtStart : dirtyConnectionsAtStart).has(intent.id)) continue
      if (intent.writtenInBatchId && serverWitness) witnessBatchIds.add(intent.writtenInBatchId)
      if (intent.kind === 'object') {
        const value = effectiveObjectOverlay.get(intent.id)
        if (value) currentObjects.set(intent.id, value)
        else if (serverWitness) witnessObjectIds.push(intent.id)
      } else {
        const value = effectiveConnectionOverlay.get(intent.id)
        if (value) currentConnections.set(intent.id, value)
        else if (serverWitness) witnessConnectionIds.push(intent.id)
      }
    }
    // BATCHED server witness: one deadlined round trip per ≤500-id chunk pair,
    // objects and connections together (the previous shape was one sequential
    // HTTP call per intent — a post-crash journal made that N × latency under
    // the replay lock). The response carries the projection-freshness signal:
    // PRESENCE stays usable from a lagging projector (a projected value WAS
    // durable when it was projected, so the equality-ack remains sound), but
    // ABSENCE is a proof only when the projection is caught up — a lagging
    // projector's last coherent snapshot may simply not contain a durably
    // written entity yet.
    const WITNESS_CHUNK = 500
    const askBatchIds = [...witnessBatchIds]
    const landedBatchIds = new Set<string>()
    for (
      let offset = 0;
      witnessesReliable
        && (offset < witnessObjectIds.length || offset < witnessConnectionIds.length || offset < askBatchIds.length);
      offset += WITNESS_CHUNK
    ) {
      const result = await witnessed(fetchDurabilityWitness(
        witnessJournal,
        witnessObjectIds.slice(offset, offset + WITNESS_CHUNK),
        witnessConnectionIds.slice(offset, offset + WITNESS_CHUNK),
        askBatchIds.slice(offset, offset + WITNESS_CHUNK),
      ))
      if (!result) break // witnessed() has already flipped witnessesReliable
      for (const [id, object] of result.objects) currentObjects.set(id, object)
      for (const [id, connection] of result.connections) currentConnections.set(id, connection)
      // A positive fact, like presence: usable whatever the freshness says.
      for (const batchId of result.landedBatchIds) landedBatchIds.add(batchId)
      // The write-checkpoint gate (an ORDER, not a status): presence stays
      // usable regardless, but ABSENCE proves only when every durable arrival
      // predates the last completed projection server-side.
      if (!result.absenceProvable) witnessesReliable = false
    }
    if (epoch !== durableAckEpoch) return
    const meta = modelMetaHandle?.doc()
    const live = new Map(pendingEntityIntents.pending(workspaceKey).map((intent) => [`${intent.kind}:${intent.id}`, intent]))
    const changedSinceCapture = (kind: 'object' | 'connection'): string[] => intents
      .filter((intent) => intent.kind === kind && intent.op === 'upsert')
      .filter((intent) => {
        const now = live.get(`${intent.kind}:${intent.id}`)
        return now !== undefined && (now.revision !== intent.revision || now.writtenInBatchId !== intent.writtenInBatchId)
      })
      .map((intent) => intent.id)
    const plan = planEntityIntentReplay({
      intents,
      currentObjects,
      currentConnections,
      objectBatchIds,
      connectionBatchIds,
      deletedObjectIds: new Set(meta?.deletedObjectIds ?? []),
      deletedConnectionIds: new Set(meta?.deletedConnectionIds ?? []),
      witnessesReliable,
      landedBatchIds,
      // Dirty at the start (skipped above), dirty now, or re-recorded or
      // re-stamped since the capture (edited — and possibly already written —
      // during the witness awaits): the captured record is older than what
      // the session holds, and replaying it would write it over the newer one.
      inFlightObjectIds: new Set([...dirtyObjectsAtStart, ...dirtyObjectIds, ...changedSinceCapture('object')]),
      inFlightConnectionIds: new Set([...dirtyConnectionsAtStart, ...dirtyConnectionIds, ...changedSinceCapture('connection')]),
      deletionWins: true,
    })
    if (plan.satisfied.length) {
      // Batch/overlay proofs were read from handle.doc() — RAM. A mid-session
      // re-entry (head rotation) can race an in-flight adapter save, so the
      // carrying documents are flushed BEFORE the journal forgets anything.
      // ModelMeta is a carrier too: it is what proves a DELETE (the tombstone
      // lives in meta.deletedObjectIds) — without it a delete intent could be
      // forgotten on the strength of an unflushed document.
      const carriers = [
        ...editsObjectSegmentHandles.map((handle) => handle.documentId),
        ...editsConnectionSegmentHandles.map((handle) => handle.documentId),
        ...(modelMetaHandle ? [modelMetaHandle.documentId] : []),
      ]
      const sentWorkspace = documentsWorkspaceKey()
      if (carriers.length) await repo.flush(carriers)
      if (epoch !== durableAckEpoch) return
      // SENT, not forgotten: the witness may be the local overlay
      // (`markReplayedSent`).
      markReplayedSent(workspaceKey, plan.satisfied, sentWorkspace, carriers as DocumentId[], epoch)
      persistEntityIntentsNow(workspaceKvStore(), workspaceKey)
    }
    // Not silent: these are the user's intents, deliberately not replayed
    // because a durable deletion wins over them (T-SUM-2b).
    if (plan.droppedDeleted > 0) {
      markClientTimeline('entity-intents.replay-dropped-deleted', { dropped: plan.droppedDeleted })
      console.warn(`entity intent replay: ${plan.droppedDeleted} edit(s) of entities deleted since were not replayed (a durable deletion wins)`)
    }
    const replayCount = plan.replayObjects.length + plan.replayConnections.length
      + plan.replayDeleteObjectIds.length + plan.replayDeleteConnectionIds.length
    if (replayCount === 0) {
      scheduleDurableAcknowledgement(0)
      return
    }
    markClientTimeline('entity-intents.replay', {
      replayed: replayCount,
      satisfied: plan.satisfied.length,
      deferred: plan.deferred,
      inFlight: plan.inFlight,
    })
    for (const id of plan.replayDeleteObjectIds) {
      tombstoneObjects.add(id)
      unTombObjects.delete(id)
      deleteObjectFromOverlaySegments(id)
    }
    for (const id of plan.replayDeleteConnectionIds) {
      tombstoneConnections.add(id)
      unTombConnections.delete(id)
      deleteConnectionFromOverlaySegments(id)
    }
    // An upsert over a durably tombstoned id must also lift the tombstone, or
    // the read model keeps excluding the entity and the compaction deletes it.
    for (const id of plan.unTombObjectIds) unTombObjects.add(id)
    for (const id of plan.unTombConnectionIds) unTombConnections.add(id)
    // Surface the replayed entities in the local paging index NOW — the global
    // pages (Model Objects/Connections) answer from the query seam, and with no
    // write head the writeEditsShards path that normally feeds the index is
    // never reached. Without this the replay is real but invisible: the entity
    // sits safe in editsObjects while the table the user is looking at omits it.
    applyOffWindowEditsToIndex(
      plan.replayObjects,
      plan.replayConnections,
      plan.replayDeleteObjectIds,
      plan.replayDeleteConnectionIds,
    )
    const upserts: Array<() => void> = [
      ...plan.replayObjects.map((o) => () => { editsObjects.set(o.id, o); dirtyObjectIds.add(o.id) }),
      ...plan.replayConnections.map((c) => () => { editsConnections.set(c.id, c); dirtyConnectionIds.add(c.id) }),
    ]
    if (upserts.length === 0) {
      scheduleWrite() // deletes alone still need a flush for meta tombstones
      return
    }
    for (let offset = 0; offset < upserts.length; offset += ENTITY_INTENT_REPLAY_CHUNK) {
      if (epoch !== durableAckEpoch) return
      for (const apply of upserts.slice(offset, offset + ENTITY_INTENT_REPLAY_CHUNK)) apply()
      scheduleWrite()
      if (offset + ENTITY_INTENT_REPLAY_CHUNK < upserts.length) {
        // Flush THIS chunk before injecting the next, so no single Automerge
        // change carries more than one chunk, and yield the main thread.
        writeScheduler.flushNow()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
  } catch (error) {
    console.error('entity intent replay failed', error)
  } finally {
    // Epoch-scoped release: a pass surviving from a torn-down session must not
    // free — or re-take through the follow-ups — the CURRENT session's lock.
    if (epoch === durableAckEpoch) {
      entityIntentReplaying = false
      if (entityIntentReplayFollowUp) {
        const followUp = entityIntentReplayFollowUp
        entityIntentReplayFollowUp = null
        void maybeReplayEntityIntents(followUp)
      } else if (entityIntentResidentFollowUp) {
        entityIntentResidentFollowUp = false
        void maybeReplayEntityIntentsResident()
      }
    }
  }
}

/** The resident model documents' ids at THIS instant — recomputed after every
 * write, because `writeModelShards` can CREATE a shard mid-flush and a list
 * captured before the write would flush everything except the very document
 * that carries the replayed entities. */
function residentCarrierDocumentIds(): DocumentId[] | null {
  if (sharded && modelMetaHandle) {
    return [
      ...objectShardHandles.map((handle) => handle.documentId),
      ...connectionShardHandles.map((handle) => handle.documentId),
      modelMetaHandle.documentId,
    ]
  }
  if (modelHandle) return [modelHandle.documentId]
  return null
}

/**
 * Boot-time replay of the crash journal into the RESIDENT write path — the
 * non-BFS boots: monoliths, sharded workspaces with the flag off, and the
 * write-head guard's `resident-fallback`. The journaled intents were captured under an earlier
 * boot-from-server session of the SAME workspace; without this they could only
 * drain through the overlay flush, which a resident session never runs, so the
 * journal sat visible in the badge but undrainable until the next BFS boot.
 *
 * Witness rule, resident edition: the materialized model documents are the
 * durability witnesses — they ARE the stage this journal covers (RAM → doc),
 * and the store was projected FROM them, not from the journal, so the equality
 * guard never reads its own output. That holds ONLY while the overlay provably
 * contains nothing: with overlay content present the witness set is incomplete
 * (meta tombstones are not filtered by resident projection, and an overlay
 * value can shadow the base copy the resident merge would serve), so the pass
 * REFUSES — the journal stays, the badge counts it, and a BFS boot or a
 * server repair drains it later.
 *
 * Deletes follow the STRICTER rule: absence from the
 * local docs is never a tombstone — the local copy may simply be behind — so
 * an absent-target delete is DEFERRED, and a present-target delete goes
 * through the store's REAL delete actions (incident connections, diagram
 * compositions, layouts and group memberships cascade there and nowhere else).
 *
 * Timing: this runs `void` after first projection and awaits journal
 * hydration, so an early keystroke CAN interleave. Upserts whose store value
 * already diverged from the doc value are therefore skipped (kept journaled)
 * rather than injected over the newer keystrokes; a reconnect retries them
 * once the resident flush has landed and store == doc again.
 */
async function maybeReplayEntityIntentsResident(): Promise<void> {
  if (entityIntentReplaying) {
    entityIntentResidentFollowUp = true
    return
  }
  entityIntentReplaying = true
  const epoch = durableAckEpoch
  try {
    await entityIntentHydration
    if (epoch !== durableAckEpoch) return
    if (!started || bfsActive) return
    // Small-collection intents (captured by an earlier BFS session of this
    // workspace) drain on their own track: ModelMeta doc surgery, valid in
    // resident mode too — and exempt from BOTH the once-only latch below
    // (their pass is idempotent and self-latching) and the overlay-inert
    // refusal, which protects the OBJECT/CONNECTION witness set only (the
    // small families' witness is the meta doc itself, overlay or no overlay).
    void replaySmallCollectionIntents()
    // Same exemption for the diagram-scoped families (witnesses:
    // active DiagramDoc / registry metas — resident in this mode too).
    scheduleDiagramCollectionReplay()
    scheduleDiagramStubReplay()
    scheduleDiagramAbsenceSweep()
    if (entityIntentsResidentReplayed) return
    const workspaceKey = workspaceRefKey(currentRef)
    // POSITIVE admission — same rationale as the BFS dispatch: a negative
    // filter would plan every unknown kind as a connection.
    const intents = pendingEntityIntents.pending(workspaceKey)
      .filter((intent) => isEntityPlannerKind(intent.kind))
    if (intents.length === 0) return
    // `!modelMetaHandle` is the monolith case (no overlay can exist). A handle
    // whose doc() is still undefined means the overlay state is UNKNOWN — that
    // must refuse, not pass: this guard carries the whole pass's safety, and
    // "unresolved" declared "inert" is its open-mode failure.
    const metaDoc = modelMetaHandle?.doc()
    const meta = metaDoc ? withMetaUrlView(metaDoc) : undefined
    if (modelMetaHandle && !meta) {
      markClientTimeline('entity-intents.resident-replay.refused', {
        reason: 'ModelMeta unresolved; overlay state unknown',
        pending: intents.length,
      })
      return
    }
    const overlayInert = !modelMetaHandle || (
      !meta!.editsObjectShardUrl
      && !meta!.editsConnectionShardUrl
      && (meta!.editsObjectShardUrls ?? []).length === 0
      && (meta!.editsConnectionShardUrls ?? []).length === 0
      && (meta!.deletedObjectIds ?? []).length === 0
      && (meta!.deletedConnectionIds ?? []).length === 0
    )
    if (!overlayInert) {
      markClientTimeline('entity-intents.resident-replay.refused', {
        reason: 'overlay content exists; the resident witness set would be incomplete',
        pending: intents.length,
      })
      return
    }
    const currentObjects = new Map<string, C4Object>()
    const currentConnections = new Map<string, Connection>()
    if (sharded && modelMetaHandle) {
      for (const handle of objectShardHandles) {
        for (const [id, object] of Object.entries(handle.doc()?.objects ?? {})) {
          currentObjects.set(id, object as C4Object)
        }
      }
      for (const handle of connectionShardHandles) {
        for (const [id, connection] of Object.entries(handle.doc()?.connections ?? {})) {
          currentConnections.set(id, connection as Connection)
        }
      }
    } else if (modelHandle) {
      const doc = modelHandle.doc()
      for (const [id, object] of Object.entries(doc?.objects ?? {})) {
        currentObjects.set(id, object as C4Object)
      }
      for (const [id, connection] of Object.entries(doc?.connections ?? {})) {
        currentConnections.set(id, connection as Connection)
      }
    } else {
      return
    }
    // Blocker fix: absent-target deletes never reach the planner — fabricating
    // a "resident tombstone" from that very absence made the witness derive
    // from the claim it proves, and acknowledged deletes the sync would later
    // undo. They stay journaled (the badge counts them) until the entity is
    // visible locally or a BFS session drains them against real tombstones.
    const { plannable, deferredDeletes } = splitResidentPlannableIntents(
      intents, currentObjects, currentConnections,
    )
    const plan = planEntityIntentReplay({
      intents: plannable,
      currentObjects,
      currentConnections,
      objectBatchIds: new Set(),
      connectionBatchIds: new Set(),
      deletedObjectIds: new Set(),
      deletedConnectionIds: new Set(),
      witnessesReliable: true,
    })
    if (plan.satisfied.length) {
      // Proofs were read from handle.doc() — RAM. Flush the carrying documents
      // before the journal forgets anything.
      const carriers = residentCarrierDocumentIds()
      if (!carriers) return
      const sentWorkspace = documentsWorkspaceKey()
      await repo.flush(carriers)
      if (epoch !== durableAckEpoch) return
      // SENT, not forgotten: the witness is the local model (`markReplayedSent`).
      markReplayedSent(workspaceKey, plan.satisfied, sentWorkspace, carriers as DocumentId[], epoch)
      persistEntityIntentsNow(workspaceKvStore(), workspaceKey)
    }
    // Interleave guard: skip an upsert whose STORE value already
    // diverged from the doc value the plan merged against — injecting it would
    // overwrite keystrokes newer than the crash. Skipped intents stay
    // journaled and retry on reconnect.
    const stateBefore = useModelStore.getState()
    const storeObjects = new Map(stateBefore.objects.map((object) => [object.id, object]))
    const storeConnections = new Map(stateBefore.connections.map((connection) => [connection.id, connection]))
    const undiverged = (kind: 'object' | 'connection', id: string): boolean => {
      const inStore = kind === 'object' ? storeObjects.get(id) : storeConnections.get(id)
      if (inStore === undefined) return true
      const inDoc = kind === 'object' ? currentObjects.get(id) : currentConnections.get(id)
      if (inDoc === undefined) return false // created THIS session, not yet flushed — do not overwrite
      return deepEqualPlain(
        stripUndefined(inStore as unknown as Record<string, unknown>),
        stripUndefined(inDoc as unknown as Record<string, unknown>),
      )
    }
    const injectObjects = plan.replayObjects.filter((object) => undiverged('object', object.id))
    const injectConnections = plan.replayConnections.filter((connection) => undiverged('connection', connection.id))
    const skippedDiverged =
      (plan.replayObjects.length - injectObjects.length)
      + (plan.replayConnections.length - injectConnections.length)
    const leftBehind = deferredDeletes.length + skippedDiverged
    const ackAfterWrite: Array<{ kind: 'object' | 'connection'; id: string }> = [
      ...injectObjects.map((object) => ({ kind: 'object' as const, id: object.id })),
      ...plan.replayDeleteObjectIds.map((id) => ({ kind: 'object' as const, id })),
      ...injectConnections.map((connection) => ({ kind: 'connection' as const, id: connection.id })),
      ...plan.replayDeleteConnectionIds.map((id) => ({ kind: 'connection' as const, id })),
    ]
    if (ackAfterWrite.length === 0) {
      // Latch only a pass that left NOTHING behind — deferred/skipped intents
      // must keep the reconnect retry path alive.
      if (leftBehind === 0) entityIntentsResidentReplayed = true
      else {
        markClientTimeline('entity-intents.resident-replay.deferred', {
          deferredDeletes: deferredDeletes.length,
          skippedDiverged,
        })
      }
      scheduleDurableAcknowledgement(0)
      return
    }
    markClientTimeline('entity-intents.resident-replay', {
      replayed: ackAfterWrite.length,
      satisfied: plan.satisfied.length,
      deferredDeletes: deferredDeletes.length,
      skippedDiverged,
    })
    // Revisions captured BEFORE injection: a keystroke landing during the flush
    // bumps the revision past this and survives the acknowledgement below.
    const revisionOf = new Map(intents.map((intent) => [`${intent.kind}:${intent.id}`, intent.revision]))
    // Inject upserts as ONE local store mutation (NOT withRemote): the resident
    // write path (onStoreChange → flushWrite → model docs) is what makes them
    // durable. Capture is gated on bfsActive, so this cannot re-journal itself.
    if (injectObjects.length || injectConnections.length) {
      const state = useModelStore.getState()
      const objectsById = new Map(state.objects.map((object) => [object.id, object]))
      for (const object of injectObjects) objectsById.set(object.id, object)
      const connectionsById = new Map(state.connections.map((connection) => [connection.id, connection]))
      for (const connection of injectConnections) connectionsById.set(connection.id, connection)
      useModelStore.setState({
        objects: [...objectsById.values()],
        connections: [...connectionsById.values()],
      })
    }
    // Replayed deletes go through the store's REAL delete actions: the plain
    // map-surgery variant would durably write dangling references (incident
    // connections, diagram compositions, layouts, group memberships
    // all cascade in deleteObject/deleteConnection and nowhere else).
    // Suppressed: a crash replay is not something the user can undo.
    const actions = useModelStore.getState()
    undoHistory.suppress(() => {
      for (const id of plan.replayDeleteObjectIds) actions.deleteObject(id)
      for (const id of plan.replayDeleteConnectionIds) actions.deleteConnection(id)
    })
    writeScheduler.flushNow()
    const carriers = residentCarrierDocumentIds()
    if (!carriers) return
    const sentWorkspace = documentsWorkspaceKey()
    await repo.flush(carriers)
    if (epoch !== durableAckEpoch) return
    for (const { kind, id } of ackAfterWrite) {
      const revision = revisionOf.get(`${kind}:${id}`)
      if (revision !== undefined) {
        markIntentsSent(workspaceKey, kind, [id], revision, sentWorkspace, carriers as DocumentId[], epoch)
      }
    }
    persistEntityIntentsNow(workspaceKvStore(), workspaceKey)
    // Latch AFTER the flush succeeded, and only when nothing was left behind —
    // a latch set before the flush would let any flush failure kill the
    // session's reconnect retry.
    if (leftBehind === 0) entityIntentsResidentReplayed = true
    scheduleDurableAcknowledgement(0)
  } catch (error) {
    console.error('resident entity intent replay failed', error)
  } finally {
    // Epoch-scoped release: a pass surviving from a torn-down
    // session must not free — or re-take through the follow-ups — the CURRENT
    // session's lock. stopBridge resets the flag for the next session itself.
    if (epoch === durableAckEpoch) {
      entityIntentReplaying = false
      if (entityIntentReplayFollowUp) {
        const followUp = entityIntentReplayFollowUp
        entityIntentReplayFollowUp = null
        void maybeReplayEntityIntents(followUp)
      } else if (entityIntentResidentFollowUp) {
        entityIntentResidentFollowUp = false
        void maybeReplayEntityIntentsResident()
      }
    }
  }
}

async function ensureOverlayHandles(): Promise<void> {
  if (overlayResolving) return
  if (!modelMetaHandle) return
  const metaBefore = modelMetaHandle.doc()
  if (!metaBefore) return
  // A browser cannot prove that a newly-created child reached server storage
  // before its ModelMeta change. It therefore never publishes overlay heads;
  // creation/rotation belongs to server maintenance, which flushes the child
  // and registers workspace admission before publishing the parent pointer.
  const planBefore = planOverlayWriteHeads(metaBefore, isValidAutomergeUrl, false)
  const objectCurrent = editsObjectShardHandle
    && planBefore.objectUrl === editsObjectShardHandle.url
  const connectionCurrent = editsConnectionShardHandle
    && planBefore.connectionUrl === editsConnectionShardHandle.url
  if (objectCurrent && connectionCurrent) return
  overlayResolving = true
  const finish = startClientTimelineMeasure('overlay.write-head.ready')
  try {
    const meta = modelMetaHandle.doc()
    if (!meta) return
    const plan = planOverlayWriteHeads(meta, isValidAutomergeUrl, false)
    if ((editsObjectShardHandle && editsObjectShardHandle.url !== plan.objectUrl)
      || (editsConnectionShardHandle && editsConnectionShardHandle.url !== plan.connectionUrl)) {
      // Local changes are durable before a remotely rotated head is released.
      // The old URL stays in ModelMeta and can still synchronize after reconnect.
      await repo.flush()
    }
    if (editsObjectShardHandle && editsObjectShardHandle.url !== plan.objectUrl) {
      const handler = overlayChangeHandlers.get(editsObjectShardHandle.url)
      if (handler) editsObjectShardHandle.off('change', handler)
      overlayChangeHandlers.delete(editsObjectShardHandle.url)
      retainRetiredOverlayHandle(editsObjectShardHandle)
      editsObjectShardHandle = null
    }
    if (editsConnectionShardHandle && editsConnectionShardHandle.url !== plan.connectionUrl) {
      const handler = overlayChangeHandlers.get(editsConnectionShardHandle.url)
      if (handler) editsConnectionShardHandle.off('change', handler)
      overlayChangeHandlers.delete(editsConnectionShardHandle.url)
      retainRetiredOverlayHandle(editsConnectionShardHandle)
      editsConnectionShardHandle = null
    }
    if (!editsObjectShardHandle) {
      const urls = plan.objectUrl ? [plan.objectUrl] : []
      if (urls.length) {
        editsObjectSegmentHandles = []
        objectOverlaySegments.clear()
        effectiveObjectOverlay.clear()
        for (const url of urls) {
          prepareDocumentRequest(url as AutomergeUrl, 'edits-overlay')
          // Unbudgeted, peer-blind: a known residual, documented at repo.ts's
          // getModelShardHandles with its 9 min 33 s figure.
          const handle = await resolveReadyHandleWithRetry<ObjectShard>(repo, url as AutomergeUrl)
          editsObjectSegmentHandles.push(handle)
          attachOverlayChangeListener(handle, 'object')
          activeDocumentShare.pin(handle.documentId, 'edits-overlay')
          objectOverlaySegments.set(
            handle.documentId,
            (handle.doc()?.objects ?? {}) as Record<string, C4Object>,
          )
          // Merge oldest → newest. Keep the materialized ref as the write
          // baseline so resolving old segments never copies them into current.
          for (const [id, object] of Object.entries(handle.doc()?.objects ?? {})) {
            // A local edit can land while the background hydration is in flight.
            // Never replace that newer value with the persisted baseline.
            overlayObjectIds.add(id)
            if (!dirtyObjectIds.has(id)) editsObjects.set(id, object as C4Object)
            lastWrittenObj.set(id, object as C4Object)
          }
        }
        for (const [id, object] of mergeOverlaySegments([...objectOverlaySegments.values()])) {
          effectiveObjectOverlay.set(id, object)
        }
        editsObjectShardHandle = editsObjectSegmentHandles.at(-1) ?? null
      } else {
        throw new Error('Durable object overlay write head is missing; server repair is required')
      }
    }
    if (!editsConnectionShardHandle) {
      const urls = plan.connectionUrl ? [plan.connectionUrl] : []
      if (urls.length) {
        editsConnectionSegmentHandles = []
        connectionOverlaySegments.clear()
        effectiveConnectionOverlay.clear()
        for (const url of urls) {
          prepareDocumentRequest(url as AutomergeUrl, 'edits-overlay')
          // Unbudgeted, peer-blind: a known residual (see repo.ts).
          const handle = await resolveReadyHandleWithRetry<ConnectionShard>(repo, url as AutomergeUrl)
          editsConnectionSegmentHandles.push(handle)
          attachOverlayChangeListener(handle, 'connection')
          activeDocumentShare.pin(handle.documentId, 'edits-overlay')
          connectionOverlaySegments.set(
            handle.documentId,
            (handle.doc()?.connections ?? {}) as Record<string, Connection>,
          )
          for (const [id, connection] of Object.entries(handle.doc()?.connections ?? {})) {
            overlayConnectionIds.add(id)
            if (!dirtyConnectionIds.has(id)) editsConnections.set(id, connection as Connection)
            lastWrittenConn.set(id, connection as Connection)
          }
        }
        for (const [id, connection] of mergeOverlaySegments([...connectionOverlaySegments.values()])) {
          effectiveConnectionOverlay.set(id, connection)
        }
        editsConnectionShardHandle = editsConnectionSegmentHandles.at(-1) ?? null
      } else {
        throw new Error('Durable connection overlay write head is missing; server repair is required')
      }
    }
    finish({
      legacyRotated: plan.migrateLegacy,
      historicalSkipped: plan.historicalObjectSegments + plan.historicalConnectionSegments,
      objectHeadsResolved: editsObjectSegmentHandles.length,
      connectionHeadsResolved: editsConnectionSegmentHandles.length,
    })
    if (started) scheduleWrite()
    // Overlay materialized → second half of the replay junction (the first is
    // journal hydration, awaited inside). Idempotent across head rotations.
    void maybeReplayEntityIntents()
  } catch (e) {
    finish({ failed: true })
    console.error('edits overlay resolve failed', e)
    // No write head — the flush cannot land anything durable, but the journal
    // can still put the user's work back on screen and drain deletes via
    // ModelMeta. Without this, a reload on a damaged workspace shows an empty
    // diagram while the intents sit invisible in IndexedDB.
    void maybeReplayEntityIntents({ withoutHandles: true })
  } finally {
    overlayResolving = false
  }
}

function shouldRotateObjectOverlay(dirtyIds: string[]): boolean {
  const doc = editsObjectShardHandle?.doc()
  const current = doc?.objects ?? {}
  const currentCount = Object.keys(current).length
  const newIds = dirtyIds.reduce((count, id) => count + (current[id] ? 0 : 1), 0)
  return shouldRotateOverlayWriteHead({
    entryCount: currentCount,
    pendingNewIds: newIds,
    durableBatchCount: doc?.writeBatchIds?.length ?? objectOverlayWrites,
    limit: OVERLAY_SEGMENT_SIZE,
  })
}

function shouldRotateConnectionOverlay(dirtyIds: string[]): boolean {
  const doc = editsConnectionShardHandle?.doc()
  const current = doc?.connections ?? {}
  const currentCount = Object.keys(current).length
  const newIds = dirtyIds.reduce((count, id) => count + (current[id] ? 0 : 1), 0)
  return shouldRotateOverlayWriteHead({
    entryCount: currentCount,
    pendingNewIds: newIds,
    durableBatchCount: doc?.writeBatchIds?.length ?? connectionOverlayWrites,
    limit: OVERLAY_SEGMENT_SIZE,
  })
}

function deleteObjectFromOverlaySegments(id: string): void {
  for (const handle of editsObjectSegmentHandles) {
    if (handle.doc()?.objects?.[id]) changeAndTrack(handle, (shard) => { delete shard.objects[id] })
  }
}

function deleteConnectionFromOverlaySegments(id: string): void {
  for (const handle of editsConnectionSegmentHandles) {
    if (handle.doc()?.connections?.[id]) changeAndTrack(handle, (shard) => { delete shard.connections[id] })
  }
}

/**
 * Slice B/C/D: persist user-CREATED + user-EDITED objects/connections (boot-from-server)
 * into the persistent edits overlay. NOT writeModelShards — that reconciles a partition
 * of the WINDOW and would delete off-window objects. Writes are TARGETED: only the
 * entries whose ref changed since the last write are touched (reconciled in place for an
 * existing overlay entry, set for a new one), so per-edit cost is O(changed), never
 * O(overlay) — the overlay can grow without slowing edits. If the overlay isn't resolved
 * yet, kick off the lazy resolve and bail (editsObjects/Connections hold the edits; the
 * resolve re-schedules this flush).
 */
function writeEditsShards(): void {
  if (!modelMetaHandle) return
  // Off-window DELETES must leave the index even when there are no edits to write.
  const delObjIds = [...tombstoneObjects]
  const delConnIds = [...tombstoneConnections]
  if (editsObjects.size === 0 && editsConnections.size === 0) {
    applyOffWindowEditsToIndex([], [], delObjIds, delConnIds)
    return
  }
  const meta = modelMetaHandle.doc()
  if (!meta) return
  const metaPlan = planOverlayWriteHeads(
    meta,
    isValidAutomergeUrl,
    useAutomergeStatus.getState().status !== 'offline',
  )
  const staleHeads = editsObjectShardHandle?.url !== metaPlan.objectUrl
    || editsConnectionShardHandle?.url !== metaPlan.connectionUrl
  if (!editsObjectShardHandle || !editsConnectionShardHandle || staleHeads) {
    void ensureOverlayHandles()
    return
  }
  const pendingObjects = [...dirtyObjectIds].filter((id) => editsObjects.has(id))
  const pendingConnections = [...dirtyConnectionIds].filter((id) => editsConnections.has(id))
  const rotateObjects = pendingObjects.length > 0 && shouldRotateObjectOverlay(pendingObjects)
  const rotateConnections = pendingConnections.length > 0 && shouldRotateConnectionOverlay(pendingConnections)
  if (rotateObjects || rotateConnections) {
    // Continue on the current durable head until the server-side maintenance
    // path rotates it. Publishing a browser-created child here can leave a
    // permanently dangling ModelMeta pointer after a restart or network race.
    markClientTimeline('overlay.rotation.deferred', {
      object: rotateObjects,
      connection: rotateConnections,
      owner: 'server',
    })
  }
  // Collect the entities actually written this flush (ref changed since last write) so the
  // persisted IndexedDB index can be kept in sync — under boot-from-server the regular
  // store-fed syncModelIndex is skipped, so without this the seam reads stale off-window
  // records back and edits appear to revert.
  const wroteObj: C4Object[] = []
  const wroteConn: Connection[] = []
  if (pendingObjects.length > 0) {
    const batchId = createOverlayBatchId('object')
    // Captured BEFORE the Automerge change: any intent recorded after this line
    // (a keystroke racing the flush) outlives the acknowledgement below.
    const intentRevision = pendingEntityIntents.revisionNow
    overlayBatchJournal.record({
      batchId,
      workspaceKey: workspaceRefKey(currentRef),
      collection: 'object',
      documentId: editsObjectShardHandle.documentId,
      createdAt: Date.now(),
    })
    changeAndTrack(editsObjectShardHandle, (s) => {
      // Create, then write through the re-read proxy (`local/no-detached-container-write`).
      if (!s.writeBatchIds) s.writeBatchIds = []
      s.writeBatchIds.push(batchId)
      if (!s.objects) s.objects = {}
      for (const id of pendingObjects) {
        const o = editsObjects.get(id)
        if (!o) continue
        const clean = stripUndefined(o)
        if (s.objects[id]) reconcile(s.objects[id], clean, C4_OBJECT_SCHEMA)
        else s.objects[id] = clean
      }
    })
    for (const id of pendingObjects) {
      const o = editsObjects.get(id)
      if (!o) continue
      wroteObj.push(o)
      lastWrittenObj.set(id, o)
      dirtyObjectIds.delete(id)
    }
    objectOverlayWrites += 1
    void persistOverlayBatchJournal(workspaceKvStore(), workspaceRefKey(currentRef))
    // Stamp the intents this batch expressed and persist the stamp NOW: if the
    // tab dies after the doc write but before the acknowledgement below, the
    // replay finds batchId ∈ shard.writeBatchIds and acknowledges without
    // re-asserting our value over whatever synced since.
    pendingEntityIntents.markWritten(
      workspaceRefKey(currentRef), 'object', wroteObj.map((o) => o.id), intentRevision, batchId,
    )
    persistEntityIntentsNow(workspaceKvStore(), workspaceRefKey(currentRef))
    acknowledgeEntityIntentBatch(
      'object',
      wroteObj.map((o) => o.id),
      intentRevision,
      editsObjectShardHandle.documentId,
    )
  }
  if (pendingConnections.length > 0) {
    const batchId = createOverlayBatchId('connection')
    const intentRevision = pendingEntityIntents.revisionNow
    overlayBatchJournal.record({
      batchId,
      workspaceKey: workspaceRefKey(currentRef),
      collection: 'connection',
      documentId: editsConnectionShardHandle.documentId,
      createdAt: Date.now(),
    })
    changeAndTrack(editsConnectionShardHandle, (s) => {
      if (!s.writeBatchIds) s.writeBatchIds = []
      s.writeBatchIds.push(batchId)
      if (!s.connections) s.connections = {}
      for (const id of pendingConnections) {
        const c = editsConnections.get(id)
        if (!c) continue
        const clean = stripUndefined(c)
        if (s.connections[id]) reconcile(s.connections[id], clean, CONNECTION_SCHEMA)
        else s.connections[id] = clean
      }
    })
    for (const id of pendingConnections) {
      const c = editsConnections.get(id)
      if (!c) continue
      wroteConn.push(c)
      lastWrittenConn.set(id, c)
      dirtyConnectionIds.delete(id)
    }
    connectionOverlayWrites += 1
    void persistOverlayBatchJournal(workspaceKvStore(), workspaceRefKey(currentRef))
    pendingEntityIntents.markWritten(
      workspaceRefKey(currentRef), 'connection', wroteConn.map((c) => c.id), intentRevision, batchId,
    )
    persistEntityIntentsNow(workspaceKvStore(), workspaceRefKey(currentRef))
    acknowledgeEntityIntentBatch(
      'connection',
      wroteConn.map((c) => c.id),
      intentRevision,
      editsConnectionShardHandle.documentId,
    )
  }
  applyOffWindowEditsToIndex(wroteObj, wroteConn, delObjIds, delConnIds)
  if (wroteObj.length || wroteConn.length) scheduleOverlayBatchAcknowledgement()
}

/**
 * Persist the small, RESIDENT collections (groups/domains/tags/decisionRecords) into the
 * ModelMeta doc under boot-from-server. These are NOT windowed — the store holds the full
 * set (projected from ModelMeta), so reconciling them back is safe (no off-window data
 * loss). Without this, creating/editing/deleting a GROUP (or domain/tag/ADR) on a diagram
 * never persisted: the diagramOnly branch only wrote the object/connection overlay. Group
 * DELETE works through this too — the server's syncGroups is a full-set upsert+delete-
 * missing, so a removed group is deleted. Guarded by ref-identity so an unchanged flush
 * skips the reconcile (mirrors writeModelShards' small-collections block).
 */
function writeSmallCollections(state: ReturnType<typeof useModelStore.getState>): void {
  if (!modelMetaHandle) return
  const unchanged =
    lastSmall !== null &&
    state.groups === lastSmall.groups &&
    state.domains === lastSmall.domains &&
    state.tags === lastSmall.tags &&
    state.decisionRecords === lastSmall.decisionRecords
  if (unchanged) return
  // Revision captured BEFORE the durable write, like every other intent
  // acknowledgement site — an edit landing mid-flush keeps its intent.
  const intentRevision = pendingEntityIntents.revisionNow
  changeAndTrack(modelMetaHandle, (m) => {
    reconcileMapField(m, 'groups', byIdMap(state.groups))
    reconcileMapField(m, 'domains', byIdMap(state.domains))
    reconcileMapField(m, 'tagSnapshots', Object.fromEntries(state.tags.map((tag) => [tag.tagId, tag])))
    reconcileDecisionRecordCollection(m, state.decisionRecords)
  })
  lastSmall = {
    groups: state.groups,
    domains: state.domains,
    tags: state.tags,
    decisionRecords: state.decisionRecords,
  }
  // Retire overlay entries the moment they are durable. The overlay only has to
  // cover the window between a keystroke and this flush; holding a group past
  // that would out-rank a genuine remote edit to the same group forever.
  groupEdits.retireDurable(state.groups)
  // Acknowledge the small-collection intents this full-set write
  // expressed — VALUE-CHECKED, not blanket (a projection can clobber a store
  // slice between capture and flush; a blanket ack would forget an intent
  // whose newer value was never written anywhere). The decision is pure and
  // unit-tested in planSmallCollectionAck. ADR DELETES take a CARRIER
  // witness read off the meta doc after the write: on a
  // delta/paged workspace the flush only removes/tombstones ids present in
  // the page baseline, so absence from the STORE does not imply the carrier
  // expressed the delete — the record RightSidebar opened outside the page
  // would be gone from the store, intact in the meta, and a store-witnessed
  // ack would throw away the delete the replay could still save.
  const workspaceKey = workspaceRefKey(currentRef)
  const written: Record<SmallCollectionIntentKind, Map<string, unknown>> = {
    group: new Map(state.groups.map((g) => [g.id, g])),
    domain: new Map(state.domains.map((d) => [d.id, d])),
    tagSnapshot: new Map(state.tags.map((t) => [t.tagId, t])),
    decisionRecord: new Map(state.decisionRecords.map((r) => [r.id, r])),
  }
  const metaAfter = modelMetaHandle.doc()
  const adrDeleteWitness = metaAfter
    ? (id: string) =>
      metaAfter.decisionRecords?.[id] === undefined
        && (!usesDecisionRecordDelta(metaAfter) || (metaAfter.deletedDecisionRecordIds ?? []).includes(id))
    : null
  const ackPlan = planSmallCollectionAck(
    pendingEntityIntents.pending(workspaceKey), written, intentRevision, adrDeleteWitness,
  )
  for (const kind of SMALL_INTENT_KINDS) {
    if (ackPlan.ackByKind[kind].length) {
      acknowledgeEntityIntentBatch(kind, ackPlan.ackByKind[kind], intentRevision, modelMetaHandle.documentId)
    }
  }
  // The freshest store state is the new believed-durable baseline — NOT the
  // `state` argument: the changeAndTrack above fires the meta change handler
  // synchronously, which can run the ADR overlay reseed and replace the
  // decisionRecords slice before control returns here. Seeding
  // from the stale snapshot would roll that repair back into a
  // wrong-provenance intent on the next tick.
  smallCapture.seed((({ groups, domains, tags, decisionRecords }) => ({
    group: groups, domain: domains, tagSnapshot: tags, decisionRecord: decisionRecords,
  }))(useModelStore.getState()))
  // A survivor means the store no longer holds the journaled value (a
  // projection clobbered it before this flush). The flush loop cannot express
  // it anymore — only the replay can, straight into ModelMeta.
  if (ackPlan.survivors) scheduleSmallCollectionReplay()
}

/** Persist delete tombstones to ModelMeta (boot-from-server). Append-only (union of new
 * ids) so concurrent deletes from multiple clients merge and a daily-compaction clear
 * isn't immediately clobbered. The server read model excludes + deletes these ids; the
 * daily compaction removes them from the base shards then clears the arrays. */
function writeTombstones(): void {
  if (!modelMetaHandle) return
  const meta = modelMetaHandle.doc()
  // Delete intents die once their tombstone is durable in ModelMeta. Captured
  // before the change, like every other intent acknowledgement. The tombstone
  // sets live for the whole session, so scope the acknowledgement to ids that
  // still HOLD an intent — otherwise every later flush would redo a repo.flush
  // and an IndexedDB round trip for long-acknowledged deletes.
  const intentRevision = pendingEntityIntents.revisionNow
  const journaled = new Set(
    pendingEntityIntents.pending(workspaceRefKey(currentRef))
      .filter((intent) => intent.op === 'delete')
      .map((intent) => `${intent.kind}:${intent.id}`),
  )
  const ackObjDeletes = [...tombstoneObjects].filter((id) => journaled.has(`object:${id}`))
  const ackConnDeletes = [...tombstoneConnections].filter((id) => journaled.has(`connection:${id}`))
  const acknowledgeDeleteIntents = () => {
    acknowledgeEntityIntentBatch('object', ackObjDeletes, intentRevision, modelMetaHandle!.documentId)
    acknowledgeEntityIntentBatch('connection', ackConnDeletes, intentRevision, modelMetaHandle!.documentId)
  }
  const haveObj = new Set(meta?.deletedObjectIds ?? [])
  const haveConn = new Set(meta?.deletedConnectionIds ?? [])
  // Adds: tombstones not yet in meta. Removes: ids un-tombstoned this session (an undo /
  // re-create) that ARE in meta — splice them so the undo isn't permanently deleted.
  const addObj = [...tombstoneObjects].filter((id) => !haveObj.has(id))
  const addConn = [...tombstoneConnections].filter((id) => !haveConn.has(id))
  const remObj = [...unTombObjects].filter((id) => haveObj.has(id))
  const remConn = [...unTombConnections].filter((id) => haveConn.has(id))
  if (addObj.length === 0 && addConn.length === 0 && remObj.length === 0 && remConn.length === 0) {
    // Nothing to write, but a re-delete of an already-tombstoned id still holds
    // a journal entry — it is durable already, so let it die here.
    acknowledgeDeleteIntents()
    return
  }
  const remObjSet = new Set(remObj)
  const remConnSet = new Set(remConn)
  changeAndTrack(modelMetaHandle, (m) => {
    if (addObj.length) {
      if (!m.deletedObjectIds) m.deletedObjectIds = []
      for (const id of addObj) m.deletedObjectIds.push(id)
    }
    if (addConn.length) {
      if (!m.deletedConnectionIds) m.deletedConnectionIds = []
      for (const id of addConn) m.deletedConnectionIds.push(id)
    }
    if (remObj.length && m.deletedObjectIds) {
      for (let i = m.deletedObjectIds.length - 1; i >= 0; i--) if (remObjSet.has(m.deletedObjectIds[i])) m.deletedObjectIds.splice(i, 1)
    }
    if (remConn.length && m.deletedConnectionIds) {
      for (let i = m.deletedConnectionIds.length - 1; i >= 0; i--) if (remConnSet.has(m.deletedConnectionIds[i])) m.deletedConnectionIds.splice(i, 1)
    }
  })
  for (const id of remObj) unTombObjects.delete(id)
  for (const id of remConn) unTombConnections.delete(id)
  acknowledgeDeleteIntents()
}

/**
 * Persist DIAGRAM delete tombstones to ModelMeta.
 *
 * The summary-only counterpart of `writeTombstones`: a diagram the client did
 * not create this session lives in a frozen, server-owned baseline registry
 * shard. `planRegistryWrites` returns an empty plan for that mode,
 * `flushWrite`'s `desiredMetas` loop is skipped and `writeSummaryLocalRegistry`
 * walks only session-created ids — so without this function the Delete button
 * would write, warn and journal NOTHING.
 *
 * THE WITNESS IS THE MODELMETA FLUSH, and it may be nothing else. Never
 * `serverRegistryDiagrams` (which `captureSummaryLocalDiagram` upserts in
 * MEMORY) and never `summaryRegistryMetas()` (which derives from it): a
 * durability decision may consult durability witnesses only, never a cache the
 * recovering party itself feeds — see `acknowledgeDiagramStubsAgainstRegistry`'s
 * comment.
 *
 * This deliberately does NOT compact the list. Folding it is a server-side
 * concern; `workspaceFsck`'s `diagram-tombstone-honoured` check monitors it.
 */
function writeDiagramTombstones(): void {
  if (!modelMetaHandle) return
  const meta = modelMetaHandle.doc()
  const existingTombstones = meta?.deletedDiagramIds ?? []
  const plan = planDiagramTombstones({
    registrySummaryOnly,
    tombstonedIds: [...tombstoneDiagrams],
    unTombstonedIds: [...unTombDiagrams],
    summaryLocalDiagramIds,
    existingTombstones,

  })
  // What the meta EXPRESSES once this change lands: what it already carries,
  // plus the adds, minus the lifts. Computed from the DOCUMENT, never from the
  // session's intent set — an intent proves nothing about durability.
  const expressed = new Set(existingTombstones)
  for (const id of plan.add) expressed.add(id)
  for (const id of plan.remove) expressed.delete(id)
  // A lift that writes NOTHING must not LATCH. `unTombDiagrams` gates
  // `adoptRemoteDiagramTombstones` (`if (unTombDiagrams.has(id)) continue`); if
  // it drained only through `plan.remove` — empty precisely when the meta never
  // carried the id — one lift of a never-written tombstone would shut that gate
  // for the whole session: every FUTURE remote tombstone for that id refused,
  // and a colleague's deletion still rendering here (and spliced out by the
  // next flush). A lift is outstanding only while the
  // DOCUMENT still carries the entry; `plan.remove` drains the rest below, once
  // the splice has actually landed.
  const carried = new Set(existingTombstones)
  for (const id of [...unTombDiagrams]) {
    if (!carried.has(id)) unTombDiagrams.delete(id)
  }
  const intentRevision = pendingEntityIntents.revisionNow
  const deleteIntents = pendingEntityIntents.pending(workspaceRefKey(currentRef))
    .filter((intent) => intent.kind === 'diagram' && intent.op === 'delete')
    // A session-created id retires through `writeSummaryLocalRegistry`, whose
    // witness is the write-head shard flush. Two carriers would each ack a
    // removal the other made durable.
    .filter((intent) => !summaryLocalDiagramIds.has(intent.id))
  // `currentMetaStubs` empty + `metasComplete` false on purpose: under a
  // summary registry the window can never prove absence, so the ONLY admissible
  // proof of a delete here is PRESENCE in the tombstone list.
  //
  // On the LIFT half: the creation intent that produced a `plan.remove`
  // entry is deliberately NOT acknowledged here. It does not need to be — the
  // replay's injection re-admits the id through `captureSummaryLocalDiagram`
  // (the boot's page ingest skips tombstoned ids, so `docUrlById` does not hold
  // it and the early return does not fire), `writeSummaryLocalRegistry` places
  // its meta in the write head and the shard-flush ack retires it there (a
  // second ack keyed on `plan.remove` would carry nothing).
  const ackPlan = planDiagramStubAck(deleteIntents, new Map(), false, intentRevision, expressed)
  const acknowledgeDeleteIntents = () => acknowledgeEntityIntentBatch(
    'diagram', ackPlan.ackIds, intentRevision, modelMetaHandle!.documentId,
  )
  if (plan.add.length === 0 && plan.remove.length === 0) {
    // Nothing to write, but a re-delete of an already-tombstoned id still holds
    // a journal entry — it is durable already, so let it die here.
    acknowledgeDeleteIntents()
    return
  }
  const removeSet = new Set(plan.remove)
  changeAndTrack(modelMetaHandle, (m) => {
    if (plan.add.length) {
      if (!m.deletedDiagramIds) m.deletedDiagramIds = []
      for (const id of plan.add) m.deletedDiagramIds.push(id)
    }
    if (plan.remove.length && m.deletedDiagramIds) {
      for (let i = m.deletedDiagramIds.length - 1; i >= 0; i--) {
        if (removeSet.has(m.deletedDiagramIds[i])) m.deletedDiagramIds.splice(i, 1)
      }
    }
  })
  for (const id of plan.remove) unTombDiagrams.delete(id)
  // Dependent intents die with the diagram, same rule and same reason as the
  // session-local path: flushWrite step 3 only covers the ACTIVE diagram and a
  // deleted one can never re-activate, so a comment/flow/placement intent
  // scoped to it would wedge the badge for ever, rehydrated at every boot.
  for (const id of plan.add) {
    retireIntentsForDeletedDiagram(id, modelMetaHandle.documentId)
    // The registry window is a MEMO this client feeds itself; leaving the
    // entry there would let `writeSummaryLocalRegistry`/`summaryRegistryMetas`
    // re-publish a diagram the user just deleted.
    serverRegistryDiagrams = serverRegistryDiagrams.filter((candidate) => candidate.id !== id)
    serverDiagramBootstraps.delete(id)
    forgetDiagramDocUrl(id)
  }
  publishDiagramTombstones()
  acknowledgeDeleteIntents()
}

/** Slice B/C: capture entities that DIFFER from the last server render (created OR
 * edited — by ref; immer gives an edited entity a new ref) into the durable edits maps.
 * An unchanged rendered entity keeps the render's ref, so it's skipped. A re-appeared id
 * (e.g. a quick undo of a delete, before the tombstone is flushed to meta) is
 * un-tombstoned so it isn't deleted. */
function detectEdits(): void {
  const s = useModelStore.getState()
  const workspaceKey = workspaceRefKey(currentRef)
  // Cost note: the whole capture sweep runs synchronously on EVERY durable
  // store tick — a 3D drag fires ~60 of them per second — and its cost scales
  // with the registry size through stubCapture.diff. Timed into a DEV-gated
  // ring buffer (no-op in production).
  const finishDetectEdits = startClientTimelineMeasure('bridge.detectEdits')
  let intentsRecorded = false
  // A FIRST intent for an entity is persisted immediately (a hard kill fires no
  // pagehide); only re-records of an already-journaled entity may coalesce. The
  // timer is per-workspace, so without this a new entity landing inside another
  // entity's typing burst would wait out the debounce — a whole entity at risk,
  // not just its last keystrokes.
  let newIntentKey = false
  for (const o of s.objects) {
    const reAddedObject = tombstoneObjects.delete(o.id)
    if (reAddedObject) { lastWrittenObj.delete(o.id); unTombObjects.add(o.id) } // re-added → un-delete
    // A merely-hydrated off-window entity (seeded for edit) keeps its baseline ref until
    // the user actually changes it (immer then gives it a new ref). Skip the unchanged
    // baseline so browsing off-window objects doesn't write no-op copies into the overlay.
    if (hydratedForEdit.get(o.id) === o) continue
    if (renderedObjects.get(o.id) !== o && editsObjects.get(o.id) !== o) {
      editsObjects.set(o.id, o)
      dirtyObjectIds.add(o.id)
      // The edit only lives in RAM until writeEditsShards lands it in the
      // overlay doc; journal the intent so a crash (or a missing write head)
      // cannot silently eat it. Held by ref — no copy on the store tick. The
      // baseline (last state believed durable) makes replay a per-field
      // three-way merge instead of a whole-entity clobber.
      if (!pendingEntityIntents.has(workspaceKey, 'object', o.id)) newIntentKey = true
      pendingEntityIntents.recordUpsert(
        workspaceKey, 'object', o.id, o,
        renderedObjects.get(o.id) ?? hydratedForEdit.get(o.id) ?? lastWrittenObj.get(o.id),
      )
      // T-SUM-2b: the one upsert a replay may still lift a tombstone for.
      if (reAddedObject) pendingEntityIntents.markReAdded(workspaceKey, 'object', o.id)
      intentsRecorded = true
    } else if (reAddedObject) {
      pendingEntityIntents.markReAdded(workspaceKey, 'object', o.id)
    }
  }
  for (const c of s.connections) {
    if (c.kind === 'lower') continue
    const reAddedConnection = tombstoneConnections.delete(c.id)
    if (reAddedConnection) { lastWrittenConn.delete(c.id); unTombConnections.add(c.id) }
    if (hydratedConnForEdit.get(c.id) === c) continue
    if (renderedConnections.get(c.id) !== c && editsConnections.get(c.id) !== c) {
      editsConnections.set(c.id, c)
      dirtyConnectionIds.add(c.id)
      if (!pendingEntityIntents.has(workspaceKey, 'connection', c.id)) newIntentKey = true
      pendingEntityIntents.recordUpsert(
        workspaceKey, 'connection', c.id, c,
        renderedConnections.get(c.id) ?? hydratedConnForEdit.get(c.id) ?? lastWrittenConn.get(c.id),
      )
      if (reAddedConnection) pendingEntityIntents.markReAdded(workspaceKey, 'connection', c.id)
      intentsRecorded = true
    } else if (reAddedConnection) {
      pendingEntityIntents.markReAdded(workspaceKey, 'connection', c.id)
    }
  }
  // Journal the four ModelMeta small-collection families. Same
  // BFS-only rule and the same leading-edge persistence contract as objects;
  // the diff/delete semantics live in smallCollectionCapture.ts (pure,
  // unit-tested). Deletes and OP FLIPS persist immediately: a hard kill
  // fires no pagehide, and until the write lands the disk would hold the
  // opposite op.
  const smallOutcome = smallCapture.diff(
    { group: s.groups, domain: s.domains, tagSnapshot: s.tags, decisionRecord: s.decisionRecords },
    pendingEntityIntents,
    workspaceKey,
  )
  // The two diagram-scoped capture layers. Comments/flows follow the
  // small-collection template on the active-window slices; diagram stubs diff
  // the diagrams slice on registry-identity fields only (composition and drag
  // churn never records). Deletes of diagrams the current write path cannot
  // remove (server-owned under a summary-only registry) are refused — an
  // unexpressable intent is a permanently wedged badge, worse than the
  // documented no-op it would journal.
  const diagramOutcome = diagramCapture.diff(
    { comment: s.comments, flow: s.flows },
    pendingEntityIntents,
    workspaceKey,
  )
  // A diagram back in the store MAY be a diagram the user re-created (undo, a
  // JSON import under "existing ids win"): lift its tombstone, or the recreated
  // diagram stays invisible for ever behind the server's exclusion.
  //
  // But PRESENCE IN THE WINDOW IS NOT THAT SIGNAL, and this is not the object
  // loop above: `state.objects` under BFS is the active render, while
  // `state.diagrams` is a WINDOW that `projectAll` never rebuilds (it
  // early-returns while `bfsActive`). The only thing that drops a remotely
  // tombstoned id from it is an asynchronous re-projection — a rAF, an
  // `ensureOverlayHandles()`, then a network round trip for the render. A drag
  // tick is ~16 ms and wins that race routinely; a slow or unreachable read
  // model holds the window stale for as long as the outage lasts. Lifting from
  // that state would splice a COLLEAGUE's tombstone out of ModelMeta, and since
  // the projector already dropped the `ro_diagrams` rows and nothing re-inserts
  // them, the diagram would be invisible to everyone with no tombstone left —
  // invisible to `diagram-tombstone-honoured` too. Delete-wins, on the
  // user-tick path as well as on the replay path.
  //
  // So the lift takes the same witness as the `placeIds` loop ("a stale store
  // is NOT a witness"): a SESSION CREATION SIGNAL — the projection hold, or a
  // pending creation intent (present for fresh creations and crash-replayed
  // ones alike). The `bfsActive` term states the invariant rather than a live
  // branch: `detectEdits` only runs under `bfsActive` today (`onStoreChange`),
  // and off it the resident registry really is complete, so presence there
  // would be proof.
  for (const dg of s.diagrams) {
    if (!tombstoneDiagrams.has(dg.id)) continue
    if (bfsActive
      && !localDiagramHold.has(dg.id)
      && !pendingEntityIntents.pendingCreation(workspaceKey, 'diagram', dg.id)) continue
    tombstoneDiagrams.delete(dg.id)
    unTombDiagrams.add(dg.id)
  }
  const finishStubDiff = startClientTimelineMeasure('bridge.capture.stubDiff')
  const stubOutcome = stubCapture.diff(
    s.diagrams,
    pendingEntityIntents,
    workspaceKey,
    // Deliberately NOT relaxed with `|| tombstoneDiagrams.has(id)`. A
    // server-owned DELETE does have a durable write path (the tombstone), but
    // not through here: `captureExplicitDeletes` journals it unconditionally,
    // earlier in the same `onStoreChange` tick and before any `canJournal`
    // gate. Such a clause would be inert on the delete arm and harmful on the
    // upsert arm: the only diagrams that reach it tombstoned are the ones the
    // lift loop above deliberately REFUSED to lift — a stale window holding a
    // deleted diagram. Journaling from the window is forbidden, and since a
    // journaled CREATION can lift a tombstone (`planDiagramStubReplay`) it
    // would be a live resurrection path. `bridgeSummaryDelete.test.ts` pins
    // the refusal.
    (id) => !registrySummaryOnly || summaryLocalDiagramIds.has(id),
  )
  finishStubDiff({ diagrams: s.diagrams.length })
  if (smallOutcome.newIntentKey || diagramOutcome.newIntentKey || stubOutcome.newIntentKey) {
    newIntentKey = true
  }
  if (smallOutcome.recorded || diagramOutcome.recorded || stubOutcome.recorded) {
    intentsRecorded = true
  }
  const persistImmediately = smallOutcome.persistImmediately
    || diagramOutcome.persistImmediately
    || stubOutcome.persistImmediately
  if (newIntentKey || persistImmediately) persistEntityIntentsNow(workspaceKvStore(), workspaceKey)
  else if (intentsRecorded) schedulePersistEntityIntents(workspaceKvStore(), workspaceKey)
  // Groups are written whole into ModelMeta by writeSmallCollections rather than
  // through the per-entity overlay, so there is no dirty set to feed here — this
  // exists purely so a projection cannot undo an edit that has not been flushed
  // yet. Entries retire in writeSmallCollections once durable.
  // A group back in the store is a group the user un-deleted (undo, re-create):
  // drop the strip intent or the next flush would take it out of every
  // non-active diagram it was just restored to.
  for (const g of s.groups) tombstoneGroups.delete(g.id)
  groupEdits.captureLocalEdits(s.groups)
  finishDetectEdits({
    objects: s.objects.length,
    connections: s.connections.length,
    diagrams: s.diagrams.length,
  })
}

/** Capture only explicit user deletion actions. Selective-sync projections are partial
 * by design, so comparing consecutive resident windows can never safely distinguish a
 * real delete from a temporarily omitted object/connection. */
function captureExplicitDeletes(state: ModelStoreSnapshot): void {
  const workspaceKey = workspaceRefKey(currentRef)
  for (const id of state.pendingDeletedObjectIds) {
    tombstoneObjects.add(id)
    unTombObjects.delete(id)
    editsObjects.delete(id)
    dirtyObjectIds.delete(id)
    lastWrittenObj.delete(id)
    hydratedForEdit.delete(id)
    deleteObjectFromOverlaySegments(id)
    pendingEntityIntents.recordDelete(workspaceKey, 'object', id)
  }
  for (const id of state.pendingDeletedConnectionIds) {
    tombstoneConnections.add(id)
    unTombConnections.delete(id)
    editsConnections.delete(id)
    dirtyConnectionIds.delete(id)
    lastWrittenConn.delete(id)
    hydratedConnForEdit.delete(id)
    deleteConnectionFromOverlaySegments(id)
    pendingEntityIntents.recordDelete(workspaceKey, 'connection', id)
  }
  // The diagram tombstone is recorded from the EXPLICIT intent, never from
  // a window diff — and the intent is journaled here, before any write path
  // runs, because a summary delete's only durable carrier is ModelMeta and the
  // flush is debounced. `retireIntentsForDeletedDiagram` cleans the dependents
  // once the tombstone is expressed.
  for (const id of state.pendingDeletedDiagramIds) {
    tombstoneDiagrams.add(id)
    unTombDiagrams.delete(id)
    pendingEntityIntents.recordDelete(workspaceKey, 'diagram', id)
  }
  if (state.pendingDeletedObjectIds.length
    || state.pendingDeletedConnectionIds.length
    || state.pendingDeletedDiagramIds.length) {
    // Immediate, not debounced: deletes are rare, discrete actions, and a hard
    // kill fires no pagehide — no reason to leave even a 50 ms capture window.
    persistEntityIntentsNow(workspaceKvStore(), workspaceKey)
  }
  for (const id of state.pendingDeletedGroupIds) tombstoneGroups.add(id)
  clearExplicitDeleteIntents()
}

function clearExplicitDeleteIntents(): void {
  withRemote(() => useModelStore.setState({
    pendingDeletedObjectIds: [],
    pendingDeletedConnectionIds: [],
    pendingDeletedGroupIds: [],
    pendingDeletedDiagramIds: [],
  }))
}

/** Slice D: keep the SELECTED off-window entity hydrated in the store so the
 * RightSidebar's updateObject/updateConnection can mutate it. Prune entries no longer
 * selected (and not already edited — those persist via editsObjects). */
function syncHydration(): void {
  const s = useModelStore.getState()
  const selObj = new Set(s.selectedItems.filter((i) => i.type === 'object').map((i) => i.id))
  const selConn = new Set(s.selectedItems.filter((i) => i.type === 'connection').map((i) => i.id))
  for (const id of [...hydratedForEdit.keys()]) if (!selObj.has(id) && !editsObjects.has(id)) hydratedForEdit.delete(id)
  for (const id of [...hydratedConnForEdit.keys()]) if (!selConn.has(id) && !editsConnections.has(id)) hydratedConnForEdit.delete(id)
  const objIn = new Set(s.objects.map((o) => o.id))
  for (const id of selObj) if (!objIn.has(id) && !editsObjects.has(id) && !hydratedForEdit.has(id)) void hydrateObjForEdit(id)
  const connIn = new Set(s.connections.map((c) => c.id))
  for (const id of selConn) if (!connIn.has(id) && !editsConnections.has(id) && !hydratedConnForEdit.has(id)) void hydrateConnForEdit(id)
}

async function hydrateObjForEdit(id: string): Promise<void> {
  const obj = await getModelQuery().object(id)
  if (!obj) return
  const s = useModelStore.getState()
  if (!s.selectedItems.some((i) => i.type === 'object' && i.id === id)) return // selection moved on
  if (s.objects.some((o) => o.id === id)) return // already present
  hydratedForEdit.set(id, obj)
  withRemote(() => useModelStore.setState({ objects: [...useModelStore.getState().objects, obj] }))
}

async function hydrateConnForEdit(id: string): Promise<void> {
  const conn = await getModelQuery().connection(id)
  if (!conn) return
  const s = useModelStore.getState()
  if (!s.selectedItems.some((i) => i.type === 'connection' && i.id === id)) return
  if (s.connections.some((c) => c.id === id)) return
  hydratedConnForEdit.set(id, conn)
  withRemote(() => useModelStore.setState({ connections: [...useModelStore.getState().connections, conn] }))
}

/**
 * Slice D (synchronous): seed an ALREADY-RESOLVED off-window entity into the windowed
 * store so the store's `updateObject`/`updateConnection`/`moveObject`/`addObjectToDiagram`
 * actions can mutate it. Callers (the RightSidebar's seam resolver, the canvas drop
 * handler) already hold the entity, so this closes the race that the async
 * hydrate*ForEdit above leaves open: an off-window entity becomes editable the instant
 * it is displayed/dropped, not ~50 ms later when a separate fetch lands. Idempotent and
 * boot-from-server only (otherwise the whole model is resident and there's nothing to
 * seed). The entity stays in `hydratedForEdit` so the projection keeps it (and
 * `detectEdits` treats it as an unchanged baseline until the user actually edits it).
 */
export function seedObjectForEdit(obj: C4Object): void {
  if (!bfsActive) return
  if (useModelStore.getState().objects.some((o) => o.id === obj.id)) return // already resident
  hydratedForEdit.set(obj.id, obj)
  withRemote(() => useModelStore.setState({ objects: [...useModelStore.getState().objects, obj] }))
}

export function seedConnectionForEdit(conn: Connection): void {
  if (!bfsActive) return
  if (useModelStore.getState().connections.some((c) => c.id === conn.id)) return
  hydratedConnForEdit.set(conn.id, conn)
  withRemote(() => useModelStore.setState({ connections: [...useModelStore.getState().connections, conn] }))
}

/**
 * Boot-from-server: explicitly tombstone an OFF-WINDOW object/connection delete.
 *
 * The whole-model pages (Model Objects / Model Connections) and the left-sidebar tree can
 * delete entities that are not resident in the active window, so those handlers also call
 * this helper after the store action. Resident deletes are captured through the store's
 * explicit pending-delete intents.
 *
 * Mirrors captureExplicitDeletes()'s bookkeeping (drop from the edits overlay + lastWritten + the
 * overlay doc) and schedules a write, so writeTombstones() (→ ModelMeta, the server + daily
 * compaction) and writeEditsShards() (→ applyOffWindowEditsToIndex drops it from the IndexedDB
 * index + bumps the index version so the page re-queries without it) both run. No-op when
 * boot-from-server is off (the whole model is resident and is written normally) or when the id
 * is still resident (avoids tombstoning a still-present id or a group id passed by mistake).
 */
export function tombstoneObjectOffWindow(id: string): void {
  if (!bfsActive) return
  if (useModelStore.getState().objects.some((o) => o.id === id)) return
  tombstoneObjects.add(id)
  editsObjects.delete(id)
  dirtyObjectIds.delete(id)
  lastWrittenObj.delete(id)
  hydratedForEdit.delete(id)
  unTombObjects.delete(id)
  deleteObjectFromOverlaySegments(id)
  pendingEntityIntents.recordDelete(workspaceRefKey(currentRef), 'object', id)
  persistEntityIntentsNow(workspaceKvStore(), workspaceRefKey(currentRef))
  scheduleWrite()
}

export function tombstoneConnectionOffWindow(id: string): void {
  if (!bfsActive) return
  if (useModelStore.getState().connections.some((c) => c.id === id)) return
  tombstoneConnections.add(id)
  editsConnections.delete(id)
  dirtyConnectionIds.delete(id)
  lastWrittenConn.delete(id)
  hydratedConnForEdit.delete(id)
  unTombConnections.delete(id)
  deleteConnectionFromOverlaySegments(id)
  pendingEntityIntents.recordDelete(workspaceRefKey(currentRef), 'connection', id)
  persistEntityIntentsNow(workspaceKvStore(), workspaceRefKey(currentRef))
  scheduleWrite()
}

// ── projection (doc → store) ─────────────────────────────────────────────────

/**
 * The active diagram's doc, but only once it's actually hydrated. A handle can
 * briefly expose an empty/partial doc (e.g. just-created, or mid-load) where
 * `name`/`comments` aren't there yet; projecting that yields a malformed diagram
 * and can throw in `diagramDocComments`. Treat a doc with no `name` as
 * not-yet-loaded and fall back to the (correct) registry stub until the doc's
 * change event re-projects the full view.
 */
function activeDiagramDoc(): DiagramDoc | undefined {
  const doc = activeDiagramHandle?.doc()
  return doc && typeof doc.name === 'string' ? doc : undefined
}

/**
 * Rebase the pending comment/flow intents over freshly projected
 * slices — the diagram-collection twin of `pendingPlacementIntents.
 * overlayProjection` and `groupEdits.apply`. Without it, any projection of
 * the active doc (a colleague's change, a BFS attach) erases a journaled-but-
 * unflushed comment/flow from the screen, and the still-pending flush then
 * persists the erasure. Upserts replace-or-append for the ACTIVE diagram;
 * pending deletes stay deleted.
 */
function overlayDiagramCollections(
  comments: Comment[],
  flows: Flow[],
): { comments: Comment[]; flows: Flow[] } {
  const workspaceKey = workspaceRefKey(currentRef)
  const intents = pendingEntityIntents.pending(workspaceKey)
    .filter((intent) => isDiagramCollectionKind(intent.kind))
  if (!intents.length || !activeDiagramId) return { comments, flows }
  const apply = <T extends { id: string; diagramId: string }>(
    items: T[],
    kind: DiagramCollectionIntentKind,
  ): T[] => {
    const deletes = new Set<string>()
    const upserts = new Map<string, T>()
    for (const intent of intents) {
      if (intent.kind !== kind) continue
      if (intent.op === 'delete') {
        if (intent.diagramId === activeDiagramId) deletes.add(intent.id)
        continue
      }
      const snapshot = intent.snapshot as unknown as T
      if (snapshot.diagramId === activeDiagramId) upserts.set(intent.id, snapshot)
    }
    if (deletes.size === 0 && upserts.size === 0) return items
    const merged = items
      .filter((item) => !deletes.has(item.id))
      .map((item) => upserts.get(item.id) ?? item)
    const have = new Set(merged.map((item) => item.id))
    for (const [id, value] of upserts) {
      if (!have.has(id)) merged.push(value)
    }
    return merged
  }
  return { comments: apply(comments, 'comment'), flows: apply(flows, 'flow') }
}

/**
 * Take on board diagram tombstones another client wrote, and publish the
 * set to the store.
 *
 * The remote half of the tombstone, and it is deliberately one-directional: the
 * arriving id joins `tombstoneDiagrams` (so the window filter and the absence
 * observation both see it) and NOTHING is journaled. The memory note "boot
 * off-window delete" is about the opposite shape — a disappearance arriving by
 * the REMOTE path cannot produce a local intent because `withRemote` suppresses
 * `onStoreChange`. Here that is exactly what we want: the remote deletion does
 * not need to be re-expressed, it already IS the durable expression.
 */
function adoptRemoteDiagramTombstones(): void {
  const remote = modelMetaHandle?.doc()?.deletedDiagramIds ?? []
  let changed = false
  for (const id of remote) {
    // An id this client just re-created (an "existing ids win" import) is being
    // LIFTED by our own next flush; adopting the stale remote entry would hide
    // the survivor until that flush lands.
    if (unTombDiagrams.has(id)) continue
    if (tombstoneDiagrams.has(id)) continue
    tombstoneDiagrams.add(id)
    changed = true
  }
  if (!changed) return
  publishDiagramTombstones()
  // Comment/flow/placement intents scoped to a diagram someone else deleted
  // have no expression path left — the sweep is what retires them, and the
  // tombstone is the POSITIVE proof of absence it never had before.
  scheduleDiagramAbsenceSweep()
}

/** Mirror the tombstone set into the store. The diagram list is served by the
 * SERVER under a summary registry, so a module-level memo would re-render
 * nothing — this has to be reactive state. `withRemote`, because it is a
 * projection, not a user edit. */
function publishDiagramTombstones(): void {
  const next = [...tombstoneDiagrams]
  for (const id of retiredSessionDiagramIds) if (!tombstoneDiagrams.has(id)) next.push(id)
  const current = useModelStore.getState().deletedDiagramIds
  if (current.length === next.length && next.every((id, index) => current[index] === id)) return
  withRemote(() => useModelStore.setState({ deletedDiagramIds: next }))
}

/** Merge the bounded server window with the one mutable summary-registry shard.
 * The local shard wins for ids it owns so edits/new diagrams remain visible
 * while the asynchronous SQL projector catches up.
 *
 * Tombstoned ids are removed LAST, after both sources have been merged.
 * The frozen baseline registry shard still carries the entry for ever (nothing
 * rewrites it, by design) and the server page can lag the projection by a
 * round trip, so filtering here is what makes the deletion converge locally —
 * offline included — instead of waiting on SQL. `buildDiagramsArray`,
 * `retirePendingLocalDiagrams` and the absence observation all inherit it. */
function summaryRegistryMetas(): DiagramMeta[] {
  const byId = new Map(serverRegistryDiagrams.map((meta) => [meta.id, meta]))
  for (const handle of shardHandles) {
    for (const meta of Object.values(handle.doc()?.diagrams ?? {})) byId.set(meta.id, meta)
  }
  for (const id of tombstoneDiagrams) byId.delete(id)
  return [...byId.values()]
}

function buildDiagramsArray(): Diagram[] {
  const activeDoc = activeDiagramDoc()
  const metas = registrySummaryOnly
    ? summaryRegistryMetas()
    : mergeShards(shardHandles.map((h) => h.doc() ?? { diagrams: {} }))
  const projected = metas.map((meta) => {
    const bootstrap = registrySummaryOnly ? serverDiagramBootstraps.get(meta.id) : undefined
    return resolveDiagramProjection(meta, activeDiagramId, activeDoc, bootstrap?.diagram)
  })
  // Keep a just-created diagram that has not reached a registry shard yet —
  // otherwise this projection is what deletes it.
  return localDiagramHold.apply(projected, useModelStore.getState().diagrams)
}

function retirePendingLocalDiagrams(): void {
  if (localDiagramHold.size === 0 && localDiagramHold.heldDeletions === 0) return
  const metas = registrySummaryOnly
    ? summaryRegistryMetas()
    : mergeShards(shardHandles.map((h) => h.doc() ?? { diagrams: {} }))
  // A held deletion is released by ABSENCE, so only from a registry whose every
  // shard has materialized (the replay's and the ack's completeness rule).
  // The summary window filters its own tombstones (`summaryRegistryMetas`).
  const registryComplete = registrySummaryOnly || shardHandles.every((h) => h.doc() !== undefined)
  localDiagramHold.retire(metas.map((meta) => meta.id), useModelStore.getState().diagrams, registryComplete)
}

// ── boot-from-server (step 2c) ─────────────────────────────────────────────────
// The active diagram is projected from the server read model's diagram-render API,
// so the client never loads/merges the model shards. Read-only (the windowed store
// isn't written back). Gated by isBootFromServerEnabled() — default off.

/** Rebuild docUrlById / shardByDiagramId from the loaded REGISTRY shards — the part
 * of projectAll the boot-from-server path needs (to resolve a diagram's doc url)
 * without projecting the model itself. */
function rebuildRegistryIndex(): void {
  docUrlById.clear()
  shardByDiagramId.clear()
  if (registrySummaryOnly) {
    // A tombstoned diagram must not keep a resolvable doc url — that is
    // what a stale route or a re-fetched page would use to re-open it.
    for (const meta of serverRegistryDiagrams) {
      if (tombstoneDiagrams.has(meta.id)) continue
      docUrlById.set(meta.id, unpublishedDiagramDocs.resolve(meta.id, meta.docUrl))
    }
    for (const handle of shardHandles) {
      for (const meta of Object.values(handle.doc()?.diagrams ?? {})) {
        if (tombstoneDiagrams.has(meta.id)) continue
        docUrlById.set(meta.id, unpublishedDiagramDocs.resolve(meta.id, meta.docUrl))
        shardByDiagramId.set(meta.id, handle.url)
      }
    }
    unpublishedDiagramDocs.readmit(docUrlById, (id) => tombstoneDiagrams.has(id))
    return
  }
  const shardDocs = shardHandles.map((h) => h.doc())
  for (let i = 0; i < shardHandles.length; i++) {
    const shard = shardDocs[i]
    if (!shard) continue
    for (const meta of Object.values(shard.diagrams)) {
      docUrlById.set(meta.id, unpublishedDiagramDocs.resolve(meta.id, meta.docUrl))
      shardByDiagramId.set(meta.id, shardHandles[i].url)
    }
  }
  unpublishedDiagramDocs.readmit(docUrlById, (id) => tombstoneDiagrams.has(id))
}

/** Project the active diagram into the store from the server render — objects +
 * connections (incl. server-computed lower roll-ups) + the resident small
 * collections + the diagram registry — without the rest of the model. */
async function loadDiagramRenderForProjection(
  diagramId: string,
): Promise<DiagramRenderResult | undefined> {
  // The badge and the reachability evidence belong to the session that ASKED: a
  // render a previous session left in flight must not write this one's
  // (measured 2026-10-16, bridgeOfflineBoot.test.ts — see `serverUnreachable`).
  const epoch = durableAckEpoch
  try {
    const render = await fetchDiagramRender(diagramId)
    // The render fetch reaching the server (200 OR 404) means we're connected. If the
    // badge was showing offline (the server had been unreachable in boot-from-server
    // mode, where navigator.onLine can't see a dead :3002), reflect the reconnection.
    if (epoch === durableAckEpoch && (serverUnreachable || useAutomergeStatus.getState().status === 'offline')) {
      setDurableConnectionState(true)
    }
    // Same origin as the mint, and OUTSIDE the `offline` guard above on
    // purpose: this path is how a boot-from-server client learns the backend is
    // back, and the badge may already read connected (bridge.ts asserts that at
    // the end of every boot) while the mint is still asleep on its ladder.
    notifyMintedIdSupplyHostReachable()
    return render
  } catch (e) {
    // OFFLINE / backend down (Bug B): the server render is unreachable. Surface it in the
    // sync badge (the HTTP failure is the only offline signal in boot-from-server mode —
    // navigator.onLine stays true when only the backend is gone), then serve the render
    // from the Worker's diagram-render cache (written by every online open), and only
    // failing that rebuild it from the legacy IndexedDB index — which nothing builds
    // automatically any more (the complete copy is the explicit "Make available
    // offline" action), so that last rung is normally skipped by isIndexReady.
    // Only the OFFLINE path runs this — a successful/404 fetch above never reaches here, so
    // the online boot path is unchanged.
    console.warn('diagram-render fetch failed; trying local index fallback:', e)
    if (epoch !== durableAckEpoch) {
      // A previous session's request: not this session's evidence.
    } else if (isServerUnreachableError(e)) {
      // The TRANSPORT flag too, not just the status: with the flag left true, the
      // next empty durable-ack tick re-claimed 'ready' ("Synced") within a second
      // of this line, and the end-of-boot assertion did the same (measured
      // 2026-10-16, e2e/boot/offline.spec.ts "badge Offline"). A later successful
      // render fetch, or a sync-socket peer, is the evidence that lifts it again.
      serverUnreachable = true
      setDurableConnectionState(false)
    } else {
      // The server ANSWERED (an HTTP error status, an invalid payload): it is
      // reachable, so this is not transport evidence (2026-10-16) —
      // the status-only signal it always had.
      useAutomergeStatus.getState().setStatus('offline')
    }
    const cached = await readCachedDiagramRender(diagramId)
    if (cached) return cached
    if (isIndexReady()) {
      try {
        const local = await buildLocalDiagramRender(workspaceKvStore(), diagramId)
        if (local) return local
      } catch (e2) {
        console.error('local diagram-render fallback failed:', e2)
      }
    }
    return undefined
  }
}

async function projectActiveFromServer(
  diagramId: string | null,
  preparedRender?: Promise<DiagramRenderResult | undefined>,
): Promise<void> {
  if (!started) return
  const requestSequence = ++serverProjectionRequestSequence
  const render = diagramId
    ? await (preparedRender ?? loadDiagramRenderForProjection(diagramId))
    : undefined
  if (!started) return
  const renderObjects = render?.objects ?? []
  const renderConnections = render?.connections ?? []
  const renderGroups = render?.groups ?? []
  const lowerIds = renderConnections.filter((c) => c.kind === 'lower').map((c) => c.id)
  if (render) {
    lastServerProjectionGeneration = Math.max(
      lastServerProjectionGeneration,
      render.workspaceGeneration ?? render.projectionGeneration,
    )
  }
  const finishStoreProjection = startClientTimelineMeasure('diagram.store.project', {
    serverBoot: true,
  })
  // The active diagram's connectionIds (from its doc) exclude lower connections (not
  // persisted); append the server-computed lower ids so the canvas — which selects
  // connections by the diagram's connectionIds — draws them.
  let diagrams = buildDiagramsArray().map((d) =>
    d.id === diagramId && lowerIds.length ? { ...d, connectionIds: [...d.connectionIds, ...lowerIds] } : d
  )
  const activeDoc = activeDiagramDoc()
  const meta = modelMetaHandle?.doc() as ModelMeta | undefined

  // Slice B/C: the render is the detection baseline (held BY REF). editsObjects/
  // editsConnections is the DURABLE edits-shard contents (never dropped here — that
  // would delete them from the shard). OVERLAY the edits onto the render so the local
  // view reflects them before the server re-renders: a rendered entity is REPLACED by
  // its edited version, and a newly-created entity on THIS diagram is appended.
  renderedObjects = new Map(renderObjects.map((o) => [o.id, o]))
  groupEdits.rebaseline(renderGroups)
  renderedConnections = new Map(renderConnections.map((c) => [c.id, c]))
  // Overlay: rendered entities REPLACED by their edited versions; then append non-
  // rendered entities the user is working with — created/edited (editsObjects) AND
  // hydrated-for-edit (Slice D). They're kept in the store so they stay editable; the
  // canvas only draws the active diagram's composition, so off-diagram ones don't show.
  // Scope the durable overlay to the ACTIVE diagram's composition: the overlay holds EVERY
  // locally created/edited entity across all diagrams, so adding all of them would bloat the
  // window and resurrect entities removed from this diagram. We add an overlay entity to the
  // window only if it belongs to the active diagram (its composition) — except entities the
  // user is actively editing off-window this session (hydratedForEdit), which stay resident so
  // they remain editable. This also makes offline-created/edited content in THIS diagram show
  // when the server render is empty.
  const activeDiagram = diagrams.find((d) => d.id === diagramId)
  const activeObjIds = new Set(activeDiagram?.objectIds ?? [])
  const activeConnIds = new Set(activeDiagram?.connectionIds ?? [])
  const objectsOverlaid = renderObjects.map((o) => editsObjects.get(o.id) ?? o)
  const extraObj = new Map<string, C4Object>()
  // Keep an off-window overlay entity resident if it belongs to the active diagram OR the user is
  // actively editing it off-window this session (hydratedForEdit). The hydratedForEdit term is
  // CRITICAL: editing a shape on the Dependencies / Model Connections page mutates editsObjects,
  // but the entity is neither rendered nor in activeObjIds — without it, the next re-projection
  // (a live invalidation after the idle guard) would drop the EDITED value here and the second loop would re-add the
  // STALE baseline from hydratedForEdit, snapping the field back on screen. Running editsObjects
  // FIRST makes the edited value win; the hydratedForEdit loop then only adds not-yet-edited ones.
  for (const [id, o] of editsObjects) if (!renderedObjects.has(id) && (activeObjIds.has(id) || hydratedForEdit.has(id))) extraObj.set(id, o)
  for (const [id, o] of hydratedForEdit) if (!renderedObjects.has(id) && !extraObj.has(id)) extraObj.set(id, o)
  const connsOverlaid = renderConnections.map((c) => editsConnections.get(c.id) ?? c)
  const extraConn = new Map<string, Connection>()
  for (const [id, c] of editsConnections) if (!renderedConnections.has(id) && (activeConnIds.has(id) || hydratedConnForEdit.has(id))) extraConn.set(id, c)
  for (const [id, c] of hydratedConnForEdit) if (!renderedConnections.has(id) && !extraConn.has(id)) extraConn.set(id, c)

  // Delete tracking: locally-deleted ids may still appear in a stale server render (the
  // render predates the tombstone reaching the projector), so filter them out so a deleted
  // entity never flashes back before the read model catches up.
  let allObj = extraObj.size ? [...objectsOverlaid, ...extraObj.values()] : objectsOverlaid
  let allConn = extraConn.size ? [...connsOverlaid, ...extraConn.values()] : connsOverlaid
  if (tombstoneObjects.size) allObj = allObj.filter((o) => !tombstoneObjects.has(o.id))
  if (tombstoneConnections.size) allConn = allConn.filter((c) => !tombstoneConnections.has(c.id))

  // Pre-overlay comment/flow values — the durable provenance the
  // capture baselines seed from (the doc when hydrated, else the server
  // bootstrap, itself a projection of the doc). The store receives the
  // OVERLAID slice so a stale render cannot erase a journaled-but-unflushed
  // comment/flow from the screen.
  const durableComments = activeDoc
    ? diagramDocComments(activeDoc)
    : (diagramId ? serverDiagramBootstraps.get(diagramId)?.comments ?? [] : [])
  const durableFlows = activeDoc
    ? diagramDocFlows(activeDoc)
    : (diagramId ? serverDiagramBootstraps.get(diagramId)?.flows ?? [] : [])
  const collectionsOverlaid = overlayDiagramCollections(durableComments, durableFlows)
  const patch: Partial<ReturnType<typeof useModelStore.getState>> = {
    objects: allObj,
    connections: allConn,
    groups: renderGroups,
    diagrams,
    comments: collectionsOverlaid.comments,
    flows: collectionsOverlaid.flows,
  }
  if (meta) {
    // Selective sync may expose ModelMeta before every inline collection has
    // hydrated. Missing is not empty: preserve the resident slice until the
    // actual Automerge map arrives, otherwise labels briefly (or permanently)
    // fall back to stable ids after an unrelated diagram/perspective refresh.
    if (meta.groups !== undefined) patch.groups = Object.values(meta.groups) as Group[]
    // Same reason as the object/connection filter above: the delete may not have
    // reached the document yet, and a group that flashes back also re-renders its
    // wrapper chrome on the canvas.
    if (tombstoneGroups.size && patch.groups) {
      patch.groups = patch.groups.filter((g) => !tombstoneGroups.has(g.id))
    }
    if (meta.domains !== undefined) patch.domains = Object.values(meta.domains) as Domain[]
    if (meta.tagSnapshots !== undefined) patch.tags = Object.values(meta.tagSnapshots) as Tag[]
    if (shouldProjectInlineDecisionRecords(meta)) {
      patch.decisionRecords = Object.values(meta.decisionRecords)
    }
  }
  // The capture baselines seed from the PRE-overlay values captured
  // HERE — the durable provenance — never from the post-overlay slice the
  // store receives (a GroupEditOverlay ref in the baseline made the later
  // three-way replay treat the overlay's fields as already-durable and drop
  // them). An overlaid group therefore re-captures on the
  // next user tick with the DURABLE value as its baseline, which is exactly
  // right. Families the meta did not provide keep their baselines.
  const durableSmallSlices = {
    ...(meta?.groups !== undefined && patch.groups ? { group: patch.groups } : {}),
    ...(meta?.domains !== undefined && patch.domains ? { domain: patch.domains } : {}),
    ...(meta?.tagSnapshots !== undefined && patch.tags ? { tagSnapshot: patch.tags } : {}),
    ...(patch.decisionRecords ? { decisionRecord: patch.decisionRecords } : {}),
  }
  // After the meta override — that is the value that would otherwise win — and
  // before the placement overlay below, which only patches position/size/autoSize
  // and must still take precedence on geometry.
  patch.groups = groupEdits.apply(patch.groups ?? renderGroups)
  if (diagramId && pendingPlacementIntents.hasPending(workspaceRefKey(currentRef), diagramId)) {
    const overlaid = pendingPlacementIntents.overlayProjection(workspaceRefKey(currentRef), diagramId, {
      diagrams,
      groups: patch.groups ?? renderGroups,
      connections: allConn,
    })
    diagrams = overlaid.diagrams
    patch.diagrams = overlaid.diagrams
    patch.groups = overlaid.groups
    patch.connections = overlaid.connections
  }
  // Guard against a STALE projection clobbering a fresher one. This async projection can complete
  // AFTER the active diagram changed (or after a newer projection already landed). If the diagram we
  // rendered for is no longer the current one, drop this setState — otherwise an early
  // projectActiveFromServer (e.g. one kicked off for a null/previous diagram before the route set
  // currentDiagramId) lands LATE and wipes the freshly-projected store to empty. That is the boot
  // flicker: the diagram appears, then a stale empty projection clears it, then it reappears.
  if (diagramId !== useModelStore.getState().currentDiagramId) {
    finishStoreProjection({ stale: true })
    return
  }
  if (requestSequence < lastAppliedServerProjectionRequest) {
    finishStoreProjection({ stale: true, outOfOrder: true })
    return
  }
  lastAppliedServerProjectionRequest = requestSequence
  withRemote(() => useModelStore.setState(patch))
  // Seed AFTER the setState and past the stale guards above: a projection
  // that was dropped must not move the baselines either.
  if (bfsActive) {
    smallCapture.seed(durableSmallSlices)
    // Same contract for the diagram-scoped families — pre-overlay
    // values, post-guards. The diagrams baseline reseeds from the slice the
    // store received (identity fields only are diffed, so the placement
    // overlay's geometry patches are invisible to it).
    diagramCapture.seed({ comment: durableComments, flow: durableFlows })
    stubCapture.seed((patch.diagrams as Diagram[] | undefined) ?? diagrams)
  }
  finishStoreProjection({
    objects: allObj.length,
    connections: allConn.length,
    diagrams: diagrams.length,
  })
  markClientTimeline('diagram.store.ready', {
    objects: allObj.length,
    connections: allConn.length,
  })
}

/** Project the active diagram — from the server render under boot-from-server, else
 * the normal full projection. */
async function projectActive(id: string | null): Promise<void> {
  if (bfsActive) await projectActiveFromServer(id)
  else withRemote(projectAll)
}

// ── incremental projection ────────────────────────────────────────────────────
// Automerge 3 keeps a subtree's reference stable when nothing inside it changed
// (verified: editing one object leaves doc.connections/doc.tagSnapshots ref-identical).
// We exploit that to re-project + setState only the slices that actually changed,
// instead of rebuilding all nine arrays on every sync tick. Falls back to full
// work if a ref always changes, so it never regresses.

/** The monolithic ModelDoc's collections — derived from the entity-family
 * registry (`monolith: true`), same order as the literal it replaced. */
const MODEL_KEYS = MONOLITH_COLLECTIONS
/** The model collections that stay INLINE on the ModelMeta when sharded (objects +
 * connections move into shards) — registry `home: 'modelMeta'`. */
const MODEL_SMALL_KEYS = MODEL_META_INLINE_COLLECTIONS
const PROJ_UNSET = Symbol('unset')
/** Last materialized model-collection refs we projected from. */
const lastModelColl: Record<string, unknown> = {}
let lastShardDocs: unknown[] = []
let lastDiagramsActiveDoc: unknown = PROJ_UNSET
let lastDiagramsActiveId: string | null | typeof PROJ_UNSET = PROJ_UNSET
let lastCommentsActiveDoc: unknown = PROJ_UNSET
// The lower-connection roll-up is deferred off the critical path on hydration and
// diagram switches (so the just-projected objects paint first); these decide when
// to defer vs. run inline (edits on the same diagram run inline — no flicker).
let firstProjection = true
let lastSyncedDiagramId: string | null = null
// Last model slices written to the model doc (by reference). flushWrite skips the
// expensive Automerge reconcile when none changed — see flushWrite().
let lastModelSlices: {
  objects: unknown[]
  connections: unknown[]
  groups: unknown[]
  domains: unknown[]
  tags: unknown[]
  decisionRecords: unknown[]
} | null = null

function sameRefs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Reset the projection caches (so a restarted bridge re-projects from scratch). */
function resetProjectionCache(): void {
  for (const k of MODEL_KEYS) delete lastModelColl[k]
  lastShardDocs = []
  lastDiagramsActiveDoc = PROJ_UNSET
  lastDiagramsActiveId = PROJ_UNSET
  lastCommentsActiveDoc = PROJ_UNSET
  firstProjection = true
  lastSyncedDiagramId = null
  lastModelSlices = null
  lastObjectShardDocs = []
  lastConnectionShardDocs = []
  lastObjectShardSlices = []
  lastConnectionShardSlices = []
  groupEdits.clear()
}

function projectAll(): void {
  if (!rootHandle) return
  faultPointForTest('projectAll')
  // Boot-from-server (step 2c): the model shards aren't loaded (and the monolith
  // modelHandle isn't either), so the shard-merge below would wipe the store to
  // empty. Any caller (meta/registry change, root change) instead re-projects the
  // active diagram from the server render. Checked BEFORE the modelHandle guard
  // because modelHandle is null in this mode.
  if (bfsActive) {
    scheduleLiveSyncRefresh()
    return
  }
  // A SHARDED workspace may have NO monolith handle at all (forks have no monolith
  // doc; re-entering a sharded workspace skips fetching one) — its projection reads
  // the meta + model shards below. Only the monolith branch needs modelHandle, so
  // bailing here for a sharded workspace would leave the store permanently EMPTY.
  if (!modelHandle && !(sharded && modelMetaHandle)) return
  const root = rootHandle.doc()
  if (!root) return
  const modelDoc = modelHandle?.doc()
  if (modelHandle && !modelDoc) return

  const shardDocs = shardHandles.map((h) => h.doc())
  const shardsChanged = !sameRefs(shardDocs, lastShardDocs)

  // Rebuild the id → doc-url / id → shard-url maps only when a shard changed
  // (the write path keeps them current in between). This runs synchronously on
  // the echo of flushWrite's own writes, so a document still waiting on the
  // create→flush→publish gate is in no shard yet: the rebuild must keep it.
  if (shardsChanged) {
    docUrlById.clear()
    shardByDiagramId.clear()
    for (let i = 0; i < shardHandles.length; i++) {
      const shard = shardDocs[i]
      if (!shard) continue
      for (const meta of Object.values(shard.diagrams)) {
        docUrlById.set(meta.id, unpublishedDiagramDocs.resolve(meta.id, meta.docUrl))
        shardByDiagramId.set(meta.id, shardHandles[i].url)
      }
    }
    unpublishedDiagramDocs.readmit(docUrlById, (id) => tombstoneDiagrams.has(id))
    lastShardDocs = shardDocs
  }

  const patch: Record<string, unknown[]> = {}

  if (sharded && modelMetaHandle) {
    // Objects/connections = union of their shards; re-merge only when some shard
    // doc ref changed (Automerge keeps a doc ref stable when nothing inside moved),
    // and rebuild the id→shard route from the new contents. The merge itself is a
    // cheap Object.assign union — the expensive proxy walk is gone from the WRITE.
    const objDocs = objectShardHandles.map((h) => h.doc())
    if (!sameRefs(objDocs, lastObjectShardDocs)) {
      const listed = listedInMeta(objectShardHandles as DocHandle<unknown>[], 'objectShardUrls')
      // The local writes no document holds yet stay.
      patch.objects = residentPendingWrites.overlay('objects',
        Object.values(mergeObjectShards(listedLast(objDocs, listed).map((d) => d ?? { objects: {} }))) as C4Object[])
      rebuildObjectRoute(objDocs, listed)
      lastObjectShardDocs = objDocs
    }
    const connDocs = connectionShardHandles.map((h) => h.doc())
    if (!sameRefs(connDocs, lastConnectionShardDocs)) {
      const listed = listedInMeta(connectionShardHandles as DocHandle<unknown>[], 'connectionShardUrls')
      patch.connections = residentPendingWrites.overlay('connections', Object.values(
        mergeConnectionShards(listedLast(connDocs, listed).map((d) => d ?? { connections: {} }))
      ) as Connection[])
      rebuildConnectionRoute(connDocs, listed)
      lastConnectionShardDocs = connDocs
    }
    // An owed edit whose entity this merge no longer holds: released when its grace ends.
    armAbsentReleaseTimer()
    // Small collections live inline on the meta doc — per-key ref skip (reusing
    // lastModelColl) exactly as the monolith path does.
    const meta = modelMetaHandle.doc() as unknown as Record<string, Record<string, unknown>> | undefined
    if (meta) {
      for (const key of MODEL_SMALL_KEYS) {
        const coll = meta[key]
        if (coll === undefined) continue
        if (coll !== lastModelColl[key]) {
          patch[ENTITY_FAMILIES[key].storeSlice] = Object.values(coll)
          lastModelColl[key] = coll
        }
      }
    }
  } else {
    // Monolithic ModelDoc — re-project only those collections whose ref changed.
    const collections = modelDoc as unknown as Record<string, Record<string, unknown>>
    for (const key of MODEL_KEYS) {
      const coll = collections[key]
      if (coll === undefined) continue
      if (coll !== lastModelColl[key]) {
        patch[ENTITY_FAMILIES[key].storeSlice] = Object.values(coll)
        lastModelColl[key] = coll
      }
    }
  }

  // Same overlay as the server-projection path. Any model-doc 'change' re-projects
  // groups wholesale, which would otherwise undo a rename the debounced flush has
  // not written to ModelMeta yet. Only when the collection ref actually changed —
  // an untouched slice leaves the resident (already-edited) array alone.
  if (patch.groups) {
    groupEdits.rebaseline(patch.groups as Group[])
    patch.groups = groupEdits.apply(patch.groups as Group[])
  }

  // Diagrams depend on shard docs + the active diagram doc + active id.
  const activeDoc = activeDiagramDoc()
  if (shardsChanged || activeDoc !== lastDiagramsActiveDoc || activeDiagramId !== lastDiagramsActiveId) {
    patch.diagrams = buildDiagramsArray()
    lastDiagramsActiveDoc = activeDoc
    lastDiagramsActiveId = activeDiagramId
    // Wholesale slice replacement → same-tick baseline reseed (the
    // stub diff would otherwise read a registry catch-up as user deletes).
    stubCapture.seed(patch.diagrams as Diagram[])
  }

  // Comments + flows depend only on the active diagram doc.
  if (activeDoc !== lastCommentsActiveDoc) {
    const docComments = activeDoc ? diagramDocComments(activeDoc) : []
    const docFlows = activeDoc ? diagramDocFlows(activeDoc) : []
    // Every wholesale slice replacement reseeds the capture
    // baselines on the SAME synchronous tick (the ADR page-swap discipline —
    // a diagram switch must never read as a burst of user deletes), from the
    // PRE-overlay doc values (durable provenance). Then overlay the pending
    // intents so an incoming projection cannot erase a journaled-but-
    // unflushed comment/flow from the screen — the previous behaviour was a
    // silent in-session loss when a remote change landed inside the write
    // debounce.
    diagramCapture.seed({ comment: docComments, flow: docFlows })
    const overlaid = overlayDiagramCollections(docComments, docFlows)
    patch.comments = overlaid.comments
    patch.flows = overlaid.flows
    lastCommentsActiveDoc = activeDoc
  }

  // A local placement may be waiting for its bounded Automerge flush while a
  // remote document change re-projects the store. Rebase that latest local
  // intent over the incoming snapshot so the projection cannot become the
  // value that the later flush persists.
  if (activeDiagramId && pendingPlacementIntents.hasPending(workspaceRefKey(currentRef), activeDiagramId)) {
    const current = useModelStore.getState()
    const overlaid = pendingPlacementIntents.overlayProjection(workspaceRefKey(currentRef), activeDiagramId, {
      diagrams: (patch.diagrams as Diagram[] | undefined) ?? current.diagrams,
      groups: (patch.groups as Group[] | undefined) ?? current.groups,
      connections: (patch.connections as Connection[] | undefined) ?? current.connections,
    })
    patch.diagrams = overlaid.diagrams
    patch.groups = overlaid.groups
    patch.connections = overlaid.connections
  }

  if (Object.keys(patch).length > 0) {
    useModelStore.setState(patch as Partial<ReturnType<typeof useModelStore.getState>>)
  }

  // Lower connections are a DERIVED roll-up of deeper-level edges onto the
  // nearest visible ancestor on a diagram. Their membership in
  // diagram.connectionIds is not round-tripped through the per-diagram docs,
  // so every hydration would otherwise drop them — leaving them invisible on
  // load until the next mutation re-runs the sync (and they'd all appear at
  // once). Re-derive them for the active diagram. syncLowerConnections always
  // runs inside withRemote(), so its store mutation is skipped by onStoreChange
  // and cannot echo back to the docs or loop.
  //
  // It DOES churn the lower objects whenever this projection replaced
  // `connections` (any model-doc change, our own flush's included): the shard /
  // model merge holds no lowers, so every one is minted again. That costs no
  // identity — a lower's id is its pair (`lower:<from>→<to>`) — and no routing,
  // which lives on the diagram (`Diagram.lowerRouting`, from the DiagramDoc) and
  // not on the lower. Measured 2026-10-21 before that split: Auto-layout's
  // routing of FSSystemContext's lowers was gone ~2 s later, by this path.
  const currentId = useModelStore.getState().currentDiagramId

  // Keep the paged IndexedDB index fresh (no-op unless paging is enabled). Runs
  // after the roll-up so the index includes the rolled-up edges too.
  //
  // Under boot-from-server the resident store is WINDOWED to the active diagram, so
  // feeding it to the store-diff syncModelIndex would rebuild the index from just the
  // window — deleting every off-window entity. There the complete index is owned by
  // the background cold-build (offlineIndex.ensureIndexReady), so skip the store-fed
  // sync entirely.
  const refreshIndex = () => {
    if (bfsActive) return
    const s = useModelStore.getState()
    syncModelIndex({ objects: s.objects, connections: s.connections, groups: s.groups, diagrams: s.diagrams })
  }

  if (!currentId) {
    refreshIndex()
    return
  }

  // On hydration (first projection) and diagram switches, the roll-up is
  // O(all connections) and would block the paint of the just-projected objects.
  // Defer it one macrotask so the store renders (and the loading spinner can
  // actually animate) first, then re-index so the IndexedDB index picks up the
  // rolled-up edges. An edit on the SAME diagram runs inline to avoid flicker.
  const deferRollup = firstProjection || currentId !== lastSyncedDiagramId
  firstProjection = false
  lastSyncedDiagramId = currentId

  if (deferRollup) {
    refreshIndex()
    const idToSync = currentId
    setTimeout(() => {
      if (!started) return
      withRemote(() => {
        useModelStore.getState().syncLowerConnections(idToSync)
        refreshIndex()
      })
    }, 0)
  } else {
    useModelStore.getState().syncLowerConnections(currentId)
    refreshIndex()
  }
}

// ── active diagram handling (lazy load) ───────────────────────────────────────

function detachActive(): void {
  if (activeDiagramHandle && activeChangeHandler) {
    activeDiagramHandle.off('change', activeChangeHandler)
  }
  if (activeDiagramHandle) {
    activeDocumentShare.unpin(activeDiagramHandle.documentId, 'active-diagram')
  }
  activeChangeHandler = null
  activeDiagramHandle = null
  notifyActiveDiagramHandle()
}

function attachActive(id: string, handle: DocHandle<DiagramDoc>): void {
  activeDiagramId = id
  activeDiagramHandle = handle
  notifyActiveDiagramHandle()
  activeDocumentShare.pin(handle.documentId, 'active-diagram')
  // Under boot-from-server, a diagram-doc change re-projects from the server render;
  // otherwise the normal full projection.
  activeChangeHandler = () => {
    if (bfsActive) {
      if (Date.now() < suppressEchoUntil) return // self-echo of our own flush — store already current
      scheduleLiveSyncRefresh()
    } else {
      withRemote(projectAll)
    }
  }
  handle.on('change', activeChangeHandler)
  // The doc arriving IS the carrier the diagram-scoped journals wait
  // for. Comments/flows journaled for THIS diagram by a crashed session can
  // now replay; placements journaled for it can now flush (the boot-time
  // check at startBridge only covered the boot-active diagram).
  scheduleDiagramCollectionReplay()
  if (pendingPlacementIntents.hasPending(workspaceRefKey(currentRef), id)) {
    scheduleWrite('placement')
  }
}

interface PreparedDiagramOpen {
  render?: Promise<DiagramRenderResult | undefined>
  bootstrap?: Promise<DiagramBootstrap | undefined>
}

async function switchActiveDiagram(
  id: string | null,
  prepared: PreparedDiagramOpen = {},
): Promise<void> {
  if (id === activeDiagramId && activeDiagramHandle) return
  detachActive()
  activeDiagramId = id
  useAutomergeStatus.getState().beginDiagramOpen()
  if (!id) {
    await projectActive(null)
    useAutomergeStatus.getState().markEditReady()
    return
  }
  markClientTimeline('diagram.open', { registrySummaryOnly, serverBoot: bfsActive })
  const finishOpen = startClientTimelineMeasure('diagram.open.total', {
    registrySummaryOnly,
    serverBoot: bfsActive,
  })
  if (bfsActive) {
    let failureStage = 'document'
    const renderPromise = prepared.render ?? loadDiagramRenderForProjection(id)
    const loadDocument = async (): Promise<DocHandle<DiagramDoc> | undefined> => {
      let url = docUrlById.get(id)
      if (!url && registrySummaryOnly) {
        failureStage = 'meta'
        const finishMeta = startClientTimelineMeasure('diagram.meta')
        try {
          const bootstrap = await (prepared.bootstrap ?? fetchDiagramMeta(id))
          finishMeta({ found: Boolean(bootstrap) })
          if (activeDiagramId !== id) return undefined
          if (bootstrap) {
            const existing = serverRegistryDiagrams.findIndex((diagram) => diagram.id === id)
            if (existing >= 0) serverRegistryDiagrams[existing] = bootstrap.meta
            else serverRegistryDiagrams.push(bootstrap.meta)
            serverDiagramBootstraps.set(id, bootstrap)
            docUrlById.set(bootstrap.meta.id, bootstrap.meta.docUrl)
            url = bootstrap.meta.docUrl
          }
        } catch (error) {
          finishMeta({ failed: true })
          throw error
        }
      }
      if (!url || activeDiagramId !== id) return undefined
      failureStage = 'document'
      const finishDocument = startClientTimelineMeasure('diagram.doc')
      try {
        const handle = await findDiagramHandle(url)
        finishDocument()
        return handle
      } catch (error) {
        finishDocument({ failed: true })
        throw error
      }
    }

    try {
      const result = await runDiagramFirstPaintPipeline({
        loadVisual: () => renderPromise,
        loadDocument,
        paintVisual: async (render) => {
          if (activeDiagramId !== id) return
          const finishProjection = startClientTimelineMeasure('diagram.project', { temporary: true })
          try {
            await projectActiveFromServer(id, Promise.resolve(render))
            finishProjection()
          } catch (error) {
            finishProjection({ failed: true })
            throw error
          }
          if (activeDiagramId !== id) return
          useAutomergeStatus.getState().markVisualReady()
          markClientTimeline('diagram.visual.ready')
        },
        // Even a warm DiagramDoc must not unlock in the same microtask as the
        // server projection. Give React + CanvasEngine one real paint while the
        // edit gate is still closed.
        afterVisualPaint: waitForVisualCommit,
        activateEditing: async (handle, render) => {
          if (!handle || activeDiagramId !== id) return
          attachActive(id, handle)
          const finishProjection = startClientTimelineMeasure('diagram.project', { temporary: false })
          try {
            // Reuse the generation-consistent render while layering the now-ready
            // DiagramDoc's layouts/comments. No second HTTP/cache round trip.
            await projectActiveFromServer(id, Promise.resolve(render))
            finishProjection()
          } catch (error) {
            finishProjection({ failed: true })
            throw error
          }
          if (activeDiagramId !== id) return
          useAutomergeStatus.getState().markEditReady()
          markClientTimeline('diagram.edit.ready')
        },
      })
      if (activeDiagramId !== id) {
        finishOpen({ stale: true })
        return
      }
      finishOpen({ document: Boolean(result.document) })
      markClientTimeline('diagram.open.complete')
    } catch (error) {
      finishOpen({ failed: true, stage: failureStage })
      throw error
    }
    return
  }

  const url = docUrlById.get(id)
  if (!url) {
    // Brand-new classic diagram: the next flush creates its DiagramDoc. The
    // resident projection is already authoritative and editable.
    const finishProjection = startClientTimelineMeasure('diagram.project')
    try {
      await projectActive(id)
      finishProjection({ document: false })
      useAutomergeStatus.getState().markEditReady()
      finishOpen({ document: false })
    } catch (error) {
      finishProjection({ document: false, failed: true })
      finishOpen({ document: false, failed: true, stage: 'project' })
      throw error
    }
    return
  }

  const finishDocument = startClientTimelineMeasure('diagram.doc')
  let handle: DocHandle<DiagramDoc>
  try {
    handle = await findDiagramHandle(url)
    finishDocument()
  } catch (error) {
    finishDocument({ failed: true })
    finishOpen({ failed: true, stage: 'document' })
    throw error
  }
  if (activeDiagramId !== id) {
    finishOpen({ stale: true, stage: 'document' })
    return
  }
  attachActive(id, handle)
  const finishProjection = startClientTimelineMeasure('diagram.project')
  try {
    await projectActive(id)
    finishProjection()
    useAutomergeStatus.getState().markEditReady()
    markClientTimeline('diagram.visual.ready')
    markClientTimeline('diagram.edit.ready')
    finishOpen()
  } catch (error) {
    finishProjection({ failed: true })
    finishOpen({ failed: true, stage: 'project' })
    throw error
  }
  markClientTimeline('diagram.open.complete')
}

// ── write path (store → docs) ─────────────────────────────────────────────────

function commentsFor(id: string): Comment[] {
  return useModelStore.getState().comments.filter((c) => c.diagramId === id)
}
function flowsFor(id: string): Flow[] {
  return useModelStore.getState().flows.filter((f) => f.diagramId === id)
}

interface RegistryShardSelection {
  handle: DocHandle<RegistryShard>
  created: boolean
}

/** Find a shard with room for one more diagram, or create a new shard. */
function findOrCreateShardForNew(): RegistryShardSelection {
  // Find an existing shard with room.
  for (const handle of shardHandles) {
    const shard = handle.doc()
    if (shard && Object.keys(shard.diagrams).length < SHARD_SIZE) {
      return { handle, created: false }
    }
  }
  // All shards are full (or none exist) — create a new one.
  const newHandle = trackCreatedHandle(createRegistryShardHandle({ diagrams: {} }))
  shardHandles.push(newHandle)
  attachShardListener(newHandle)
  return { handle: newHandle, created: true }
}

/** Summary-only workspaces never reuse an immutable baseline registry shard.
 * They append to one bounded write head that is the only registry document the
 * interactive client loads. Older roots acquire that pointer lazily on the
 * first creation. */
function findOrCreateSummaryWriteShard(): RegistryShardSelection {
  const writeUrl = summaryRegistryWriteUrl ?? rootHandle?.doc()?.registryWriteUrl
  if (writeUrl) {
    const existing = shardHandles.find((handle) => handle.url === writeUrl)
    if (existing) return { handle: existing, created: false }
  }
  const handle = trackCreatedHandle(createRegistryShardHandle({ diagrams: {} }))
  shardHandles.push(handle)
  attachShardListener(handle)
  summaryRegistryWriteUrl = handle.url
  return { handle, created: true }
}

/**
 * Publish a newly populated registry shard into the root (`shardUrls`, and
 * `registryWriteUrl` for a summary write head).
 *
 * A MINTED shard's pointer is written only after the server acknowledges the
 * shard (deferredReferences.ts, same machinery as `publishModelShardReference`):
 * a root naming a shard the server never received breaks every other client's
 * registry boot, and the GC census reads every registry shard, so one dangling
 * pointer makes it incomplete and aborts GC fleet-wide. The shard is used
 * locally at once — it is already in `shardHandles` — and the pending pointer
 * is persisted so a reload resumes it (`resumeDeferredRegistryShardReferences`).
 *
 * A shard on a random fallback id keeps the local-flush ordering: the server
 * claims such a document only through the walk from the root, i.e. through
 * this very pointer, so holding it would wait for ever.
 *
 * Capturing the root prevents an asynchronous publish from an old workspace
 * from appending into the next workspace's root (`writeHeldReference` checks
 * the holder and the session epoch).
 */
function publishNewRegistryShard(handle: DocHandle<RegistryShard>, summaryWriteHead = false): void {
  const targetRoot = rootHandle
  if (!targetRoot) return
  if (isMintedDocumentId(handle.documentId)) {
    const reference: DeferredReference = {
      holderDocumentId: targetRoot.documentId,
      field: 'shardUrls',
      url: handle.url,
      ...(summaryWriteHead ? { writeHead: true } : {}),
    }
    const epoch = durableAckEpoch
    const persisted = deferredReferences.add(reference).catch((error) => {
      // Unqueued, a held pointer would not survive this session and a reload
      // would hide the shard's diagrams from their own author. Fall back to the
      // pre-hold ordering (after the LOCAL flush): a possible dangling pointer
      // beats certain loss.
      console.warn('deferred registry-shard reference could not be persisted; writing it after the local flush', error)
      void publishAfterDurableFlush(repo, () => {
        writeHeldReference(reference, epoch)
      }).catch((flushError) => {
        console.warn('registry shard durability flush failed', flushError)
      })
    })
    holdReference(reference, handle.documentId, persisted)
    return
  }
  void publishAfterDurableFlush(repo, () => {
    if (rootHandle !== targetRoot) return
    const root = targetRoot.doc()
    if (!root || root.shardUrls.includes(handle.url)) return
    changeAndTrack(targetRoot, (draft) => {
      draft.shardUrls.push(handle.url)
      if (summaryWriteHead) draft.registryWriteUrl = handle.url
    })
  }).catch((error) => {
    console.warn('registry shard durability flush failed', error)
  })
}

/** Build the registry meta for a diagram. `parentObjectId` is only set when
 * present so we never assign `undefined` into an Automerge map (which throws).
 * The composition arrays are COPIED: they may be views of another (or the same)
 * Automerge doc (`existingMeta.objectIds`), and assigning a doc view into a
 * change draft throws "Cannot create a reference to an existing document object". */
function buildMeta(
  dg: Diagram,
  composition: DiagramComposition,
  docUrl: string,
): DiagramMeta {
  const meta: DiagramMeta = {
    id: dg.id,
    name: dg.name,
    type: dg.type,
    docUrl,
    objectIds: [...composition.objectIds],
    connectionIds: [...composition.connectionIds],
    groupIds: [...composition.groupIds],
  }
  if (dg.parentObjectId !== undefined) meta.parentObjectId = dg.parentObjectId
  // Same copy rule as the arrays. An EMPTY map is kept, not written as absent:
  // reconcile would delete the container, and in Automerge a container delete
  // concurrent with a peer's put inside it loses the put (server twin:
  // `server/src/ai/core/stubObjectScopes.ts`).
  const scopes = composition.objectScopes
  if (scopes) meta.objectScopes = { ...scopes }
  return meta
}

function upsertSummaryRegistryWindow(meta: DiagramMeta, diagram: Diagram): void {
  const index = serverRegistryDiagrams.findIndex((candidate) => candidate.id === meta.id)
  if (index >= 0) serverRegistryDiagrams[index] = meta
  else serverRegistryDiagrams.push(meta)
  serverDiagramBootstraps.set(meta.id, {
    meta,
    diagram,
    comments: commentsFor(meta.id),
    flows: flowsFor(meta.id),
  })
  docUrlById.set(meta.id, meta.docUrl)
}

/** Capture a user-created diagram synchronously, before the subsequent
 * setCurrentDiagram triggers an asynchronous server projection. Without this
 * bounded local bootstrap, the server's expected 404 for a brand-new id replaces
 * the store with an empty registry and the create button appears to do nothing. */
/** `ids` minus every derived (lower) connection: by kind in the store, and by the
 * `lower:` prefix for one whose object a projection dropped. The same rule as
 * flushWrite's `withoutLower`, for the paths that write a new document or meta
 * outside it. Returns `ids` itself when nothing is removed. */
function withoutDerivedConnectionIds(ids: string[]): string[] {
  if (ids.length === 0) return ids
  const lowerIds = new Set<string>()
  for (const connection of useModelStore.getState().connections) {
    if (connection.kind === 'lower') lowerIds.add(connection.id)
  }
  const derived = (id: string) => lowerIds.has(id) || isLowerConnectionId(id)
  return ids.some(derived) ? ids.filter((id) => !derived(id)) : ids
}

function captureSummaryLocalDiagram(diagram: Diagram): void {
  if (!registrySummaryOnly || docUrlById.has(diagram.id)) return
  summaryLocalDiagramIds.add(diagram.id)
  // Created again (an undo of the delete): no longer a retired id.
  if (retiredSessionDiagramIds.delete(diagram.id)) publishDiagramTombstones()
  const docUrl = ensureDiagramDoc(diagram)
  upsertSummaryRegistryWindow(
    buildMeta(
      diagram,
      {
        objectIds: diagram.objectIds,
        connectionIds: withoutDerivedConnectionIds(diagram.connectionIds),
        groupIds: diagram.groupIds,
        objectScopes: diagram.objectScopes,
      },
      docUrl,
    ),
    diagram,
  )
}

/** Persist only diagram ids that were explicitly created by this client. The
 * rest of the 30k-entry registry is absent from the store and must never be
 * inferred as deleted or rewritten. */
function writeSummaryLocalRegistry(
  state: ReturnType<typeof useModelStore.getState>,
  withoutLower: (connectionIds: string[]) => string[],
): void {
  for (const id of [...summaryLocalDiagramIds]) {
    const diagram = state.diagrams.find((candidate) => candidate.id === id)
    const shardUrl = shardByDiagramId.get(id)
    const existingHandle = shardUrl
      ? shardHandles.find((handle) => handle.url === shardUrl)
      : undefined

    if (!diagram) {
      // Ack the 'diagram' delete intent HERE, at the moment the removal is
      // expressed — the memo cleanup below bars it from
      // acknowledgeDiagramStubsAgainstRegistry's summary filter forever, so
      // acking later would leave a fully successful delete wedging the badge
      // on every future boot. Two sub-cases: the meta was in the
      // write-head shard (shard flush is the witness), or it was never
      // placed at all (the creation was still doc-gated — nothing durable
      // exists, the intent retires against a no-op carrier).
      const deleteRevision = pendingEntityIntents.revisionNow
      if (existingHandle?.doc()?.diagrams[id]) {
        changeAndTrack(existingHandle, (shard) => { delete shard.diagrams[id] })
        acknowledgeEntityIntentBatch('diagram', [id], deleteRevision, existingHandle.documentId)
      } else if (pendingEntityIntents.pendingOp(workspaceRefKey(currentRef), 'diagram', id) === 'delete') {
        const workspaceKey = workspaceRefKey(currentRef)
        const kvStore = workspaceKvStore()
        void forgetIntentsOnceDurable(
          () => Promise.resolve(),
          () => pendingEntityIntents.acknowledge(workspaceKey, 'diagram', [id], deleteRevision),
          () => persistEntityIntents(kvStore, workspaceKey),
        ).then(() => scheduleDurableAcknowledgement(0)).catch((error) => {
          console.warn('summary diagram delete intent persistence failed', error)
        })
      }
      // Dependent intents die with the diagram: the carrier is durably gone
      // (or never existed), so comment/flow intents and placement records
      // scoped to it can never be expressed — keeping them is a permanently
      // wedged badge.
      retireIntentsForDeletedDiagram(id, existingHandle?.documentId)
      // The removal is expressed HERE, in the write head, so the id must
      // leave the tombstone set too. Without this the next flush would find it
      // still tombstoned but no longer session-local, and write a permanent
      // ModelMeta tombstone for a diagram that is already durably gone —
      // growth for nothing, and a second truth about the same removal.
      tombstoneDiagrams.delete(id)
      unTombDiagrams.delete(id)
      // …but NOT the published deletion: the server-paged list hides a card
      // only behind the store's `deletedDiagramIds` (T-DIAGDEF (1)).
      retiredSessionDiagramIds.add(id)
      publishDiagramTombstones()
      summaryLocalDiagramIds.delete(id)
      serverRegistryDiagrams = serverRegistryDiagrams.filter((candidate) => candidate.id !== id)
      serverDiagramBootstraps.delete(id)
      forgetDiagramDocUrl(id)
      shardByDiagramId.delete(id)
      continue
    }

    const docUrl = ensureDiagramDoc(diagram)
    // Create→flush→publish, same gate as the classic placeIds pass:
    // the write-head shard is already server-synced, so a meta written now
    // would publish a docUrl whose document is not yet durable anywhere.
    if (pendingDurableDiagramDocs.has(id)) continue
    const meta = buildMeta(
      diagram,
      {
        objectIds: diagram.objectIds,
        connectionIds: withoutLower(diagram.connectionIds),
        groupIds: diagram.groupIds,
        objectScopes: diagram.objectScopes,
      },
      docUrl,
    )
    upsertSummaryRegistryWindow(meta, diagram)
    // Both branches below place the meta in the write head.
    unpublishedDiagramDocs.forget(id)

    if (existingHandle) {
      changeAndTrack(existingHandle, (shard) => {
        if (shard.diagrams[id]) reconcile(shard.diagrams[id], meta, DIAGRAM_META_SCHEMA)
        else shard.diagrams[id] = meta
      })
      continue
    }

    const selection = findOrCreateSummaryWriteShard()
    changeAndTrack(selection.handle, (shard) => { shard.diagrams[id] = meta })
    shardByDiagramId.set(id, selection.handle.url)
    if (selection.created) publishNewRegistryShard(selection.handle, true)
  }
}

/** The document a loaded registry meta names for `diagramId`, if any. */
function publishedDocUrl(diagramId: string): string | undefined {
  if (tombstoneDiagrams.has(diagramId)) return undefined
  for (const handle of shardHandles) {
    const docUrl = handle.doc()?.diagrams?.[diagramId]?.docUrl
    if (docUrl) return docUrl
  }
  return serverRegistryDiagrams.find((meta) => meta.id === diagramId)?.docUrl || undefined
}

/** Create a DiagramDoc for a diagram that doesn't have one yet, record its url. */
function ensureDiagramDoc(diagram: Diagram): string {
  const existing = docUrlById.get(diagram.id)
  if (existing) return existing
  // The index can lag the loaded registry — under boot-from-server it is rebuilt
  // only at boot, so a diagram a colleague added since has a meta and no entry.
  // A meta that names a document IS this diagram's document: minting another
  // would hand this client an empty copy of it.
  const published = publishedDocUrl(diagram.id)
  if (published) {
    docUrlById.set(diagram.id, published)
    return published
  }
  const isActive = diagram.id === activeDiagramId
  // Flows are taken for ANY new diagram, not just the active one: store.flows is
  // normally windowed to the active diagram (so this matches the old behavior),
  // but a JSON import pushes flows for its freshly created diagrams and this is
  // their one chance to land in the new doc before the window resets.
  const revisionBeforeCreate = pendingEntityIntents.revisionNow
  const handle = trackCreatedHandle(createDiagramHandle(
    diagramToDiagramDoc(
      withObjectScopesAtBirth({ ...diagram, connectionIds: withoutDerivedConnectionIds(diagram.connectionIds) }),
      isActive ? commentsFor(diagram.id) : [],
      flowsFor(diagram.id),
      []
    )
  ))
  docUrlById.set(diagram.id, handle.url)
  unpublishedDiagramDocs.record(diagram.id, handle.url)
  // Create→flush→publish: hold the registry meta back until this
  // doc's local flush confirms — a meta pointing at a doc that died with the
  // tab is a permanently unopenable zombie stub. The flush resolving kicks
  // another write pass, which places the meta. Epoch-guarded like every
  // other await, and a rejected flush retries with backoff: without the
  // retry, one transient IndexedDB failure would leave the diagram
  // unpublishable for the whole session.
  pendingDurableDiagramDocs.add(diagram.id)
  const gateEpoch = durableAckEpoch
  const confirmDocDurable = (attempt: number): void => {
    void repo.flush([handle.documentId]).then(() => {
      if (gateEpoch !== durableAckEpoch) return
      // The gate is keyed by diagram: if a newer document replaced this one (the
      // diagram deleted and re-created by undo), only THAT one confirming may
      // lift it. A diagram gone from the index altogether has nothing to hold.
      const current = docUrlById.get(diagram.id)
      if (!current || current === handle.url) pendingDurableDiagramDocs.delete(diagram.id)
      if (started) scheduleWrite('normal')
    }).catch((error) => {
      console.warn('diagram doc durability flush failed', error)
      if (gateEpoch !== durableAckEpoch || !started || attempt >= 5) return
      // Kept in the gate meanwhile: the meta stays unplaced, the stub intent
      // stays journaled and badge-counted — an honest 'saving', not a zombie.
      setTimeout(() => confirmDocDurable(attempt + 1), 1_000 * 2 ** attempt)
    })
  }
  confirmDocDurable(0)
  // The seeding write above IS the flush for any journaled comment/flow of
  // this diagram (the import one-shot window): value-check and acknowledge
  // against the doc as written.
  acknowledgeDiagramCollectionsAgainstDoc(handle, diagram.id, revisionBeforeCreate)
  if (isActive && !activeDiagramHandle) attachActive(diagram.id, handle)
  return handle.url
}

function flushWrite(): void {
  if (!rootHandle) return
  // The doc/meta/shard writes below each emit a 'change' that would echo back as a
  // re-projection; suppress those for a short window so they don't clobber the field the
  // user is editing or re-fetch the render on every keystroke.
  suppressEchoUntil = Date.now() + ECHO_SUPPRESS_MS
  // Boot-from-server window: the model object/connection shards are NOT loaded and the
  // store is WINDOWED to the active diagram, so the MODEL write (step 1) MUST be skipped —
  // reconciling the windowed store into a base shard would DELETE every off-window
  // object/connection (catastrophic). Gated on the flag ALONE (not objectShardHandles):
  // boot-from-server is window-only by design, so we never write base shards regardless of
  // what handles happen to be resolved — a future read-write slice must opt in explicitly,
  // not flip this implicitly. The diagram-doc + registry writes (steps 2-3) target loaded,
  // window-safe docs (the active diagram's composition/comments/flows + the edits overlay).
  const diagramOnly = bfsActive
  // EPOCH GUARD, write half. The workspace was promoted to
  // the summary contract under this CLASSIC session, so the server now owns the
  // registry and has fenced the baseline shards. `rootChangeHandler` froze the
  // projection; this freezes the WRITES, which is where the damage was:
  //
  //  - step 1 reconciles the resident model into the BASE object/connection
  //    shards, and step 2 re-places every diagram meta into the baseline
  //    registry shards. Both are now server-owned and fenced, so those changes
  //    are refused — and a classic session journals nothing (the entity-intent
  //    capture is gated on `bfsActive`), so they are lost with no trace and no
  //    badge. That silent loss is exactly what the promotion's quiesce
  //    precondition exists to prevent.
  //  - `ensureDiagramDoc` would mint brand-new documents reachable only through
  //    a registry we are no longer allowed to write, i.e. guaranteed orphans.
  //
  // NOT frozen: the ACTIVE DiagramDoc write (step 3) and the placement fast
  // path above it. Those touch one already-published, per-diagram document
  // whose url the server-owned registry already carries — nothing fenced, and
  // it is the only carrier that keeps the user's in-flight edits recoverable
  // across the reload the banner is asking for. Freezing it would throw away
  // work the freeze is supposed to protect.
  const contractFrozen = workspaceContractStale
  // Not initialized yet — nothing to write to. A SHARDED workspace legitimately has
  // no monolith handle (forks have none at all); its writes go through the model
  // shards, so it must not bail here.
  if (!diagramOnly && !modelHandle && !(sharded && modelMetaHandle)) return
  const state = useModelStore.getState()
  const placementWorkspaceKey = workspaceRefKey(currentRef)
  const placementSnapshot = activeDiagramId
    ? pendingPlacementIntents.snapshot(placementWorkspaceKey, activeDiagramId)
    : undefined

  // Common drag path: only diagram-scoped positions changed. Avoid rebuilding
  // 30k registry metas or reconciling every DiagramDoc field; one targeted
  // Automerge change is proportional to the shapes in this coalesced batch.
  //
  // View-settings edits (3D decor, skin, connection animation style) take the
  // same door: they live only in the active DiagramDoc, so one targeted
  // change replaces the ensureDiagramDoc loop + registry meta rebuild +
  // whole-doc reconcile that froze a decor pick for 305 ms
  // (diagramViewWrite.ts carries the measurement). A view edit for a
  // diagram that is no longer active, or for a session-local summary diagram
  // (whose bootstrap cache `writeSummaryLocalRegistry` refreshes), falls
  // through to the full write, which (as before this fast path) persists only
  // the ACTIVE diagram's doc: a view edit on a non-active diagram is not
  // written by either path. The store-driven switch flushes first
  // (onStoreChange → writeScheduler.flushNow before switchActiveDiagram), so
  // the ordinary pick-then-navigate sequence still lands.
  const placementOnly = !pendingNormalWrite
  pendingNormalWrite = false
  const viewDiagramIds = pendingViewDiagramIds
  pendingViewDiagramIds = new Set()
  const placementTargetable = !placementSnapshot || (
    placementSnapshot.connections.length === 0
    && placementSnapshot.groups.every((group) => group.autoSize === undefined)
  )
  const viewDiagram = viewDiagramIds.size > 0
    && activeDiagramId
    && [...viewDiagramIds].every((id) => id === activeDiagramId)
    && !(registrySummaryOnly && summaryLocalDiagramIds.has(activeDiagramId))
    ? state.diagrams.find((diagram) => diagram.id === activeDiagramId)
    : undefined
  const viewTargetable = viewDiagramIds.size === 0 || viewDiagram !== undefined
  if (
    placementOnly
    && (placementSnapshot || viewDiagram)
    && placementTargetable
    && viewTargetable
    && activeDiagramHandle
    && activeDiagramId
  ) {
    changeAndTrack(activeDiagramHandle, (doc) => {
      if (placementSnapshot) applyPlacementSnapshotToDiagramDoc(doc, placementSnapshot)
      if (viewDiagram) applyDiagramViewFields(doc, viewDiagram)
    })
    if (placementSnapshot) {
      acknowledgePlacementSnapshot(
        placementWorkspaceKey,
        activeDiagramId,
        placementSnapshot,
        activeDiagramHandle.documentId,
      )
      markClientTimeline('placement.flush', {
        mode: 'targeted',
        objects: placementSnapshot.objects.length,
        groups: placementSnapshot.groups.length,
        lowerRoutes: placementSnapshot.lowerRoutes.length,
        coalescedRevision: placementSnapshot.throughRevision,
      })
    }
    if (viewDiagram) markClientTimeline('diagramView.flush', { mode: 'targeted' })
    return
  }

  // A summary-only registry is server-owned and the store contains only a
  // window, not the complete diagram set. Existing active docs are supplied by
  // /api/model/diagram-meta; do not manufacture client-only docs for every
  // resident summary and then accidentally make them discoverable.
  if (!registrySummaryOnly && !contractFrozen) {
    for (const dg of state.diagrams) ensureDiagramDoc(dg)
    // A diagram deleted before its meta was placed is in no shard, so no
    // registry removal retires its record; without this, every later rebuild
    // would readmit its url — the deleted diagram stays resolvable, and a
    // same-id re-creation (an undo) reuses the dead document. (With no rebuild
    // in between, docUrlById itself still holds that url, as it always did.)
    // Summary sessions hold a window, not every diagram — their records retire
    // on placement in the write head.
    unpublishedDiagramDocs.retainOnly(new Set(state.diagrams.map((dg) => dg.id)))
  }

  // Derived "lower" roll-up connections are NEVER persisted — syncLowerConnections
  // recomputes them on load (their per-diagram routing is persisted, on the
  // DiagramDoc's `lowerRouting`). Excluding them means a diagram switch (which only
  // adds/removes lower connections) leaves the PERSISTED model unchanged, so the
  // guard below skips the O(model) Automerge reconcile that otherwise froze every
  // nested-diagram switch (~7.3s at 15k). They're filtered from the model doc AND
  // from each diagram's connectionIds (doc + shard meta) to avoid dangling refs —
  // by kind, AND by id for a `lower:` id whose object a projection dropped
  // before the roll-up re-minted it (by kind alone that id was persisted).
  const lowerIds = new Set<string>()
  for (const c of state.connections) if (c.kind === 'lower') lowerIds.add(c.id)
  const persistedConnections = lowerIds.size
    ? state.connections.filter((c) => c.kind !== 'lower')
    : state.connections
  const withoutLower = (cids: string[]) => {
    for (const cid of cids) {
      if (lowerIds.has(cid) || isLowerConnectionId(cid)) {
        return cids.filter((id) => !lowerIds.has(id) && !isLowerConnectionId(id))
      }
    }
    return cids
  }

  // 1) Model doc: shared C4 model. Reconciling walks all objects/connections through
  // the Automerge change proxy — ~seconds at 15k/10k. When sharded, write per-shard
  // (only the changed shards reconcile); else reconcile the monolith, guarded on
  // slice identity (objects/groups/… by ref; non-lower connections element-wise,
  // since the filtered array is rebuilt each call) so an unchanged write skips.
  // Skipped entirely under boot-from-server (diagramOnly) — the model shards aren't
  // loaded and the store is windowed, so this would corrupt the model. Skipped
  // entirely under `contractFrozen` too: BOTH halves of this step write documents
  // the promotion just fenced.
  if (contractFrozen) {
    // Deliberately nothing. See the epoch-guard comment at the top of flushWrite.
  } else if (!diagramOnly) {
    if (sharded && modelMetaHandle) {
      writeModelShards(state.objects, persistedConnections, {
        groups: state.groups,
        domains: state.domains,
        tags: state.tags,
        decisionRecords: state.decisionRecords,
      })
      // What the documents hold now leaves the overlay.
      releaseResidentPendingWrites()
    } else if (modelHandle) {
      const modelUnchanged =
        lastModelSlices !== null &&
        state.objects === lastModelSlices.objects &&
        sameRefs(persistedConnections, lastModelSlices.connections) &&
        state.groups === lastModelSlices.groups &&
        state.domains === lastModelSlices.domains &&
        state.tags === lastModelSlices.tags &&
        state.decisionRecords === lastModelSlices.decisionRecords
      if (!modelUnchanged) {
        changeAndTrack(modelHandle, (model) => {
          reconcile(
            model,
            sliceToRootModel({
              objects: state.objects,
              connections: persistedConnections,
              groups: state.groups,
              domains: state.domains,
              tagSnapshots: state.tags,
              decisionRecords: state.decisionRecords,
            }),
            ROOT_MODEL_SCHEMA,
          )
        })
        lastModelSlices = {
          objects: state.objects,
          connections: persistedConnections,
          groups: state.groups,
          domains: state.domains,
          tags: state.tags,
          decisionRecords: state.decisionRecords,
        }
      }
    }
  } else {
    // Boot-from-server writes (model shards NOT loaded):
    //  - user-CREATED/EDITED objects/connections → the persistent edits overlay (Slice B/C/D);
    //  - groups/domains/tags/decisionRecords → ModelMeta (resident, full-set safe — enables
    //    creating/editing/deleting GROUPS on a diagram, + domains/tags/ADRs);
    //  - object/connection DELETE tombstones → ModelMeta (the server + compaction apply them).
    // (membership + comments/flows persist via the diagram-doc write in steps 2-3 below.)
    writeEditsShards()
    writeSmallCollections(state)
    writeTombstones()
    // The DIAGRAM tombstones, through the same door and under the same gate.
    // The `registrySummaryOnly` half of the guard lives inside the planner —
    // an ORDINARY workspace booted `bfsActive` by a VITE flag reaches this line
    // and must write nothing.
    writeDiagramTombstones()
  }

  if (registrySummaryOnly) writeSummaryLocalRegistry(state, withoutLower)

  // 2) Registry shards. In summary-only mode the server owns membership: the
  // client store is deliberately windowed and MUST NOT be reconciled into the
  // complete registry. Doing so previously appended client-only shard URLs to
  // a sparse Draft root, leaving a cold client unable to load the Draft.
  // A FROZEN contract gets the same empty plan a summary session gets, and for
  // the same reason one level up: the server owns registry membership now. Both
  // loops below iterate the plan, so an empty plan is the whole freeze —
  // nothing is even built for it (metas are built per planned id only).
  const registryPlan = contractFrozen
    ? { reconcile: [], placeIds: [] }
    : planRegistryWrites({
      registrySummaryOnly,
      storeDiagramIds: state.diagrams.map((diagram) => diagram.id),
      shards: shardHandles.map((handle) => ({
        diagramIds: Object.keys(handle.doc()?.diagrams ?? {}),
      })),
    })

  // The desired meta of a diagram NOT yet in any shard (the placement loop
  // below is its only consumer). Built on demand: building it for every store
  // diagram up front cost ~200 ms per flush on a 739-diagram landscape (the
  // non-active branch copies each existing meta's composition out of its shard
  // doc) to place, usually, nothing. Same inputs as before: the reconcile loop
  // below only deletes `shardByDiagramId` / `docUrlById` entries of REMOVED
  // ids, which a placement id (present in the store) never is.
  // For the active diagram use the store's current composition (authoritative).
  // For non-active diagrams preserve the existing shard meta composition so we
  // never clobber it with empty arrays — the DiagramDoc is the authoritative
  // source when that diagram is active; the meta is kept in sync then.
  const desiredMetaFor = (dg: Diagram): DiagramMeta => {
    const isActive = dg.id === activeDiagramId
    // For non-active diagrams, preserve the existing shard meta composition so we
    // never clobber it with the stub's arrays. But a BRAND-NEW non-active diagram
    // (no shard meta yet — e.g. one the expand menu just created and seeded with a
    // wrapper group before navigating in) has no meta to preserve, so the store IS
    // authoritative for it; fall back to the store composition instead of empty.
    let existingMeta: DiagramMeta | undefined
    if (!isActive) {
      const shardUrl = shardByDiagramId.get(dg.id)
      if (shardUrl) {
        const shardHandle = shardHandles.find((h) => h.url === shardUrl)
        existingMeta = shardHandle?.doc()?.diagrams[dg.id]
      }
    }
    // A non-active diagram's preserved composition must still drop ids DELETED this
    // session — otherwise the registry keeps a dangling objectId/connectionId after a
    // reload (objectIds.length > rendered objects). stripDeletedFromComposition removes
    // only the tombstoned ids, never empties the arrays.
    const composition = isActive || !existingMeta
      ? { objectIds: dg.objectIds, connectionIds: withoutLower(dg.connectionIds), groupIds: dg.groupIds, objectScopes: dg.objectScopes }
      : stripDeletedFromComposition(
          {
            objectIds: existingMeta.objectIds ?? [],
            connectionIds: existingMeta.connectionIds ?? [],
            groupIds: existingMeta.groupIds ?? [],
            objectScopes: existingMeta.objectScopes,
          },
          tombstoneObjects,
          tombstoneConnections,
          tombstoneGroups
        )
    return buildMeta(dg, composition, docUrlById.get(dg.id) ?? '')
  }

  // For each existing shard, reconcile it: remove deleted diagrams, update existing.
  // First occurrence wins, as the `state.diagrams.find` it replaces did.
  const storeDiagramById = new Map<string, Diagram>()
  for (const diagram of state.diagrams) {
    if (!storeDiagramById.has(diagram.id)) storeDiagramById.set(diagram.id, diagram)
  }
  // The meta an EXISTING registry entry must hold. ONE function for both the
  // pre-diff (against the materialized shard doc) and the write (against the
  // change draft), so the two can never disagree about what "current" means.
  const registryMetaFor = (dg: Diagram, existing: DiagramMeta | undefined): DiagramMeta => {
    const isActive = dg.id === activeDiagramId
    // Non-active: preserve the existing composition, but still strip ids deleted this
    // session so a delete reaches every diagram's registry (the bug a reload exposed:
    // the deleted member lingered in non-active diagrams' objectIds). Active: the store
    // is authoritative (deleteObject already cleaned it).
    const composition = isActive
      ? { objectIds: dg.objectIds, connectionIds: withoutLower(dg.connectionIds), groupIds: dg.groupIds, objectScopes: dg.objectScopes }
      : stripDeletedFromComposition(
          {
            objectIds: existing?.objectIds ?? [],
            connectionIds: existing?.connectionIds ?? [],
            groupIds: existing?.groupIds ?? [],
            // Scope overrides are preserved like the composition: a stale stub
            // must never overwrite what a peer wrote for a diagram not open here.
            objectScopes: existing?.objectScopes,
          },
          tombstoneObjects,
          tombstoneConnections,
          tombstoneGroups
        )
    // A meta that names a document keeps it: nothing in this client may repoint
    // a published diagram (a colleague's diagram this client's index has not
    // learned would otherwise be repointed at a stub minted for it). Only a meta
    // published with an EMPTY docUrl is repointed, at the fresh document
    // ensureDiagramDoc made for it, and only once that document is durable —
    // the create→flush→publish gate, for an existing meta.
    const docUrl = existing?.docUrl
      || (pendingDurableDiagramDocs.has(dg.id) ? '' : docUrlById.get(dg.id))
      || ''
    return buildMeta(dg, composition, docUrl)
  }
  for (const shardPlan of registryPlan.reconcile) {
    const handle = shardHandles[shardPlan.shardIndex]
    const shard = handle.doc()
    if (!shard) continue
    const toRemove = shardPlan.removeIds
    // PRE-DIFF (perf, 2026-10-11): reconcile only the metas that differ from
    // what the shard already holds. The reconcile of an equal meta writes
    // nothing, but walking it through the change draft is what cost: connecting
    // two shapes on a 739-diagram landscape spent 548 of a 655 ms flush here,
    // rebuilding and re-reconciling 739 metas to persist ONE diagram's
    // connectionIds (the connect-freeze probe, never committed; reconcile.ts
    // `reconcileIsNoop` carries the read-vs-draft measurement). The check
    // reads the materialized doc this change starts from, and a removal is
    // never pre-diffed.
    const toUpdate = shardPlan.updateIds.filter((id) => {
      const dg = storeDiagramById.get(id)
      if (!dg) return false
      const existing = shard.diagrams[id]
      return !reconcileIsNoop(existing, registryMetaFor(dg, existing), DIAGRAM_META_SCHEMA)
    })
    if (toRemove.length === 0 && toUpdate.length === 0) continue
    changeAndTrack(handle, (s) => {
      for (const id of toRemove) {
        delete s.diagrams[id]
        shardByDiagramId.delete(id)
        forgetDiagramDocUrl(id)
      }
      for (const id of toUpdate) {
        const dg = storeDiagramById.get(id)
        if (!dg) continue
        // Read the shard's CURRENT meta from inside the change callback (the live
        // doc), not a pre-built lookup that can miss — so non-active composition
        // is preserved reliably and never clobbered with empty arrays.
        reconcile(s.diagrams[id], registryMetaFor(dg, s.diagrams[id]), DIAGRAM_META_SCHEMA)
      }
    })
    // Dependent intents die with the removed diagrams: their carrier's
    // registry removal was just expressed in this shard, and neither the
    // active-doc flush nor an activation can ever cover them again —
    // keeping them wedges the badge permanently.
    for (const id of toRemove) retireIntentsForDeletedDiagram(id, handle.documentId)
  }

  // For diagrams not yet in any shard (new ones), place them.
  for (const id of registryPlan.placeIds) {
    const dg = state.diagrams.find((diagram) => diagram.id === id)
    if (!dg) continue
    // A stale store is NOT a witness: under
    // boot-from-server the store is not shard-projected — projectAll
    // early-returns and the live refresh defers while the user edits — so a
    // diagram deleted REMOTELY lingers in state.diagrams and this loop
    // would silently re-place its meta, undoing the colleague's delete
    // registry-wide, right after the absence sweep retired its journal.
    // Under BFS only ids carrying a session creation signal (the projection
    // hold, or a pending creation intent — both present for fresh creations
    // AND for crash-replayed ones) may be placed; the ghost leaves the
    // store at the next server refresh.
    if (bfsActive
      && !localDiagramHold.has(id)
      && !pendingEntityIntents.pendingCreation(workspaceRefKey(currentRef), 'diagram', id)) {
      continue
    }
    // Create→flush→publish: the DiagramDoc's local flush has not
    // confirmed yet — placing the meta now would publish a docUrl whose
    // document can still die with the tab (the zombie-stub window). The
    // flush's completion schedules another pass; localDiagramHold keeps the
    // diagram visible meanwhile, and the stub intent keeps it recoverable.
    if (pendingDurableDiagramDocs.has(id)) continue
    const meta = desiredMetaFor(dg)
    // Never publish a meta that names no document: nobody can open it, and
    // ensureDiagramDoc reads an empty url as "no document", so every later
    // flush minted another one for it. The ensureDiagramDoc pass above created
    // this diagram's doc; an empty url here means that bookkeeping broke.
    if (!meta.docUrl) {
      if (!withheldMetaWarned.has(dg.id)) {
        withheldMetaWarned.add(dg.id)
        console.warn('[bridge] diagram meta withheld: it names no DiagramDoc', dg.id)
      }
      continue
    }
    const selection = findOrCreateShardForNew()
    const targetShard = selection.handle
    changeAndTrack(targetShard, (s) => {
      s.diagrams[dg.id] = meta
    })
    shardByDiagramId.set(dg.id, targetShard.url)
    unpublishedDiagramDocs.forget(dg.id)
    if (selection.created) publishNewRegistryShard(targetShard)
  }

  // 3) Active diagram doc (full view). Checkpoints live only in the doc — never
  // clobber them with store data (the store doesn't carry them).
  if (activeDiagramHandle && activeDiagramId) {
    const active = state.diagrams.find((d) => d.id === activeDiagramId)
    if (active) {
      // Revision BEFORE the write — the standing ack contract (an intent
      // re-recorded mid-flight has a higher revision and survives).
      const collectionRevision = pendingEntityIntents.revisionNow
      changeAndTrack(activeDiagramHandle, (doc) => {
        const target = diagramToDiagramDoc(
          { ...active, connectionIds: withoutLower(active.connectionIds) },
          commentsFor(activeDiagramId!),
          flowsFor(activeDiagramId!),
          doc.checkpoints ?? []
        )
        // The scope map is never deleted and never created by an unrelated
        // write: see setObjectScopesForReconcile.
        setObjectScopesForReconcile(target, active.objectScopes, doc, scopeEdits.take(activeDiagramId!))
        reconcile(doc, target, DIAGRAM_DOC_SCHEMA)
      })
      if (placementSnapshot) {
        acknowledgePlacementSnapshot(
          placementWorkspaceKey,
          activeDiagramId,
          placementSnapshot,
          activeDiagramHandle.documentId,
        )
      }
      // Value-checked acknowledgement for the comment/flow intents
      // this full-set write covered — the CARRIER is the witness (the doc
      // re-read after the write), the merge predicate decides, deletes are
      // absence. Survivors (a projection clobbered the store slice between
      // capture and flush) stay journaled and the replay re-expresses them
      // straight into the doc.
      acknowledgeDiagramCollectionsAgainstDoc(
        activeDiagramHandle,
        activeDiagramId,
        collectionRevision,
      )
      // Same as writeSmallCollections: reseed from the FRESHEST store state, not
      // the `state` argument — a synchronous handler can have swapped the
      // slices while this flush ran.
      const fresh = useModelStore.getState()
      diagramCapture.seed({ comment: fresh.comments, flow: fresh.flows })
    }
  }

  // Value-checked acknowledgement for the diagram-stub intents the
  // registry pass above expressed — witnessed against the metas AS WRITTEN
  // (shard docs / summary window + write head), never against desiredMetas.
  // The creation-ordering gate makes a placed meta imply a durable doc, so
  // this ack vouches for both. NO baseline reseed here, unlike the two
  // collection captures: a flush does not swap the diagrams slice, and the
  // store can hold values this pass deliberately did NOT express (a creation
  // still behind the doc-durability gate) — adopting those as baselines is
  // false durability.
  // …and under a FROZEN contract the registry pass above wrote nothing, so
  // neither of the two lines below may run: acknowledging a stub against a
  // registry this pass deliberately skipped is false durability too, and retiring the local hold would delete from
  // the store the very diagrams whose metas never landed.
  if (!contractFrozen) {
    acknowledgeDiagramStubsAgainstRegistry()
    // Registry metas are written above; whatever landed no longer needs holding.
    retirePendingLocalDiagrams()
  }
}

/** The step-3 companion of `writeSmallCollections`' ack: plan against the doc
 * as written, flush-then-forget through the one helper, schedule the replay
 * for survivors. Also used by `ensureDiagramDoc` when it seeds a brand-new
 * doc with import-pushed flows, so they do not depend on a one-chance window. */
function acknowledgeDiagramCollectionsAgainstDoc(
  handle: DocHandle<DiagramDoc>,
  diagramId: string,
  throughRevision: number,
): void {
  const workspaceKey = workspaceRefKey(currentRef)
  const intents = pendingEntityIntents.pending(workspaceKey)
    .filter((intent) => isDiagramCollectionKind(intent.kind))
  if (!intents.length) return
  const written = handle.doc()
  if (!written) return
  const asMap = (record: Record<string, unknown> | undefined) =>
    new Map(Object.entries(record ?? {})) as ReadonlyMap<string, unknown>
  const ackPlan = planDiagramCollectionAck(
    intents,
    {
      comment: asMap(written.comments as Record<string, unknown> | undefined),
      flow: asMap(written.flows as Record<string, unknown> | undefined),
    },
    diagramId,
    throughRevision,
  )
  for (const kind of DIAGRAM_INTENT_KINDS) {
    if (ackPlan.ackByKind[kind].length) {
      acknowledgeEntityIntentBatch(kind, ackPlan.ackByKind[kind], throughRevision, handle.documentId)
    }
  }
  if (ackPlan.survivors) {
    scheduleDiagramCollectionReplay()
    // A survivor whose diagram was deleted REMOTELY is not a replay's to
    // save — the absence sweep is its only exit.
    scheduleDiagramAbsenceSweep()
  }
}

/**
 * Retire every journaled intent scoped to a diagram whose registry removal
 * was just expressed: comment/flow intents
 * targeting it and its placement records can never be expressed again —
 * flushWrite step 3 only covers the ACTIVE diagram and a deleted one can
 * never re-activate, so keeping them wedges the badge permanently, hydrated
 * afresh on every boot. Witness = the registry shard carrying the removal; a
 * diagram whose meta never existed retires against a no-op carrier (nothing
 * durable was ever involved).
 */
function retireIntentsForDeletedDiagram(diagramId: string, carrierDocId?: DocumentId): void {
  const workspaceKey = workspaceRefKey(currentRef)
  const kvStore = workspaceKvStore()
  const throughRevision = pendingEntityIntents.revisionNow
  // Ceiling captured NOW, not MAX_SAFE_INTEGER at ack time: a same-id
  // recreation (JSON import, existing-ids-win) dragged while the witness
  // flush is in flight records HIGHER revisions that must survive this
  // retirement.
  const placementRevision = pendingPlacementIntents.revisionNow
  const byKind: Record<DiagramCollectionIntentKind, string[]> = { comment: [], flow: [] }
  for (const intent of pendingEntityIntents.pending(workspaceKey)) {
    if (!isDiagramCollectionKind(intent.kind)) continue
    const intentDiagramId = intent.op === 'delete'
      ? intent.diagramId
      : (intent.snapshot as { diagramId?: string }).diagramId
    if (intentDiagramId === diagramId) byKind[intent.kind].push(intent.id)
  }
  const hasCollectionIntents = byKind.comment.length > 0 || byKind.flow.length > 0
  const hasPlacement = pendingPlacementIntents.hasPending(workspaceKey, diagramId)
  if (!hasCollectionIntents && !hasPlacement) return
  void forgetIntentsOnceDurable(
    () => (carrierDocId ? repo.flush([carrierDocId]) : Promise.resolve()),
    () => {
      for (const kind of DIAGRAM_INTENT_KINDS) {
        if (byKind[kind].length) {
          pendingEntityIntents.acknowledge(workspaceKey, kind, byKind[kind], throughRevision)
        }
      }
      if (hasPlacement) {
        pendingPlacementIntents.acknowledge(workspaceKey, diagramId, placementRevision)
      }
    },
    async () => {
      if (hasCollectionIntents) await persistEntityIntents(kvStore, workspaceKey)
      if (hasPlacement) await persistPlacementIntents(kvStore, workspaceKey)
    },
  ).then(() => {
    scheduleDurableAcknowledgement(0)
  }).catch((error) => {
    console.warn('deleted-diagram intent retirement failed', error)
  })
}

/** Deferred trigger for the absence sweep — fired from every registry-shard
 * 'change' event (the low-latency path for a live remote delete), from both
 * replay junctions (boot/reconnect — the crash-recovery path) and from
 * flush-side acks that left survivors. Cheap to over-fire: the sweep
 * early-exits when the journal holds nothing diagram-scoped. */
function scheduleDiagramAbsenceSweep(): void {
  if (diagramAbsenceSweepTimer) return
  diagramAbsenceSweepTimer = setTimeout(() => {
    diagramAbsenceSweepTimer = null
    void sweepAbsentDiagramIntents()
  }, 0)
}

/** Thin wrapper feeding module state into the PURE observation
 * (`observeRegistryAbsence`) — every abstention rule is unit-tested there.
 * Summary provability is the UNION of the session memo
 * and the locally-retired side memo (a failed ack must keep its proof). */
function observeRegistryForAbsence(
  witnesses: readonly DocHandle<RegistryShard>[],
): DiagramAbsenceObservation | null {
  return observeRegistryAbsence({
    mode: registrySummaryOnly ? 'summary' : 'classic',
    witnesses: witnesses.map((handle) => {
      const doc = handle.doc()
      return { url: handle.url, diagramIds: doc ? Object.keys(doc.diagrams) : null }
    }),
    // Deduped like the handles it is compared with (getRegistryShardHandles):
    // a url listed twice would otherwise make the sweep abstain for ever.
    rootShardUrls: registrySummaryOnly
      ? null
      : (rootHandle?.doc()?.shardUrls ? uniqueUrls(rootHandle.doc()?.shardUrls) : null),
    writeHeadUrl: registrySummaryOnly
      ? (summaryRegistryWriteUrl ?? rootHandle?.doc()?.registryWriteUrl ?? null)
      : null,
    summaryLocalIds: registrySummaryOnly
      ? new Set([...summaryLocalDiagramIds, ...summaryRetiredDiagramIds])
      : null,
    // m7. `observeRegistryAbsence` strips these from `presentIds` BEFORE it
    // branches on mode, so handing them over in CLASSIC mode lets the sweep
    // retire a diagram's comment/flow intents on the strength of a tombstone
    // that mode never expresses — an intent retired against an absence nothing
    // proved. `bfsActive ∧ ¬registrySummaryOnly` is reachable (a VITE flag on
    // an ordinary landscape) and `captureExplicitDeletes` does fill the set
    // there, so the window is narrow but real.
    tombstonedIds: registrySummaryOnly ? tombstoneDiagrams : new Set<string>(),
  })
}

/**
 * Anti-entropy sweep for REMOTELY-deleted diagrams. The local delete paths retire dependent
 * intents at the moment the removal is EXPRESSED; a remote removal is never
 * expressed here, so its proof is observation: absent from a COMPLETE
 * registry reading. The journal itself is the memo — the plan is re-derived
 * from the pending intents on every run, so an aborted pass (crash, epoch
 * switch, offline witness flush) is retried at the next junction instead of
 * becoming a one-shot miss. Without this, comment/flow intents of a
 * non-active deleted diagram have NO exit (the replay parks them until an
 * activation that can never come), placement records strand on a cleared
 * docUrl, and the badge wedges on 'saving' forever, rehydrated every boot.
 */
async function sweepAbsentDiagramIntents(): Promise<void> {
  if (diagramAbsenceSweeping) {
    diagramAbsenceSweepFollowUp = true
    return
  }
  diagramAbsenceSweeping = true
  const epoch = durableAckEpoch
  try {
    await entityIntentHydration
    if (epoch !== durableAckEpoch || !started) return
    const workspaceKey = workspaceRefKey(currentRef)
    const intents = pendingEntityIntents.pending(workspaceKey)
    const placementDiagramIds = pendingPlacementIntents.pendingDiagramIds(workspaceKey)
    if (intents.length === 0 && placementDiagramIds.length === 0) return
    // Witnesses captured ONCE: the re-validation after the flush must read
    // the same handles the plan read, not a module array a workspace switch
    // may have re-pointed (the epoch guard also aborts that case — belt and
    // suspenders).
    const witnesses = [...shardHandles]
    const observation = observeRegistryForAbsence(witnesses)
    if (!observation) return
    const isCreationInFlight = (diagramId: string): boolean =>
      pendingDurableDiagramDocs.has(diagramId)
      || pendingEntityIntents.pendingCreation(workspaceKey, 'diagram', diagramId)
      || localDiagramHold.has(diagramId)
    const plan = planDiagramAbsenceSweep({ intents, placementDiagramIds, observation, isCreationInFlight })
    if (plan.retire.length === 0 && plan.unaddressed.length === 0) return
    markClientTimeline('entity-intents.absence-sweep', {
      retire: plan.retire.length,
      unaddressed: plan.unaddressed.length,
    })
    // Revisions and the persist store captured BEFORE any async step — the
    // standing ack contract (a re-record mid-flight survives) and the eager
    // kvStore rule (a switch mid-flush must not persist into the NEW
    // workspace's namespace).
    const entityRevision = pendingEntityIntents.revisionNow
    const placementRevision = pendingPlacementIntents.revisionNow
    const kvStore = workspaceKvStore()
    // Summary-mode memo cleanup runs SYNCHRONOUSLY, before the next flush:
    // writeSummaryLocalRegistry iterates summaryLocalDiagramIds and — masked
    // by the stale serverRegistryDiagrams entry that summaryRegistryMetas
    // still merges — would RE-PLACE the remotely-deleted meta into the
    // write-head, resurrecting the diagram. The
    // revision capture above keeps the async ack immune to this cleanup
    // landing first.
    if (registrySummaryOnly) {
      for (const entry of plan.retire) {
        if (!summaryLocalDiagramIds.has(entry.diagramId)) continue
        // The side memo keeps the id PROVABLE for a retry: without it a
        // failed witness flush would leave the intents journaled while the
        // cleanup below removed the very membership the planner's summary
        // filter requires — a session-permanent wedge.
        summaryRetiredDiagramIds.add(entry.diagramId)
        summaryLocalDiagramIds.delete(entry.diagramId)
        serverRegistryDiagrams = serverRegistryDiagrams.filter((candidate) => candidate.id !== entry.diagramId)
        serverDiagramBootstraps.delete(entry.diagramId)
        forgetDiagramDocUrl(entry.diagramId)
        shardByDiagramId.delete(entry.diagramId)
      }
    }
    const witnessDocIds = witnesses.map((handle) => handle.documentId)
    await forgetIntentsOnceDurable(
      () => (witnessDocIds.length ? repo.flush(witnessDocIds) : Promise.resolve()),
      () => {
        if (epoch !== durableAckEpoch) return
        // Re-validate against the SAME witnesses' current docs plus a FRESH
        // in-flight check: a same-id recreation (import, stub replay) lives
        // behind the creation gate with no shard meta yet, so a shard-only
        // re-read would still claim "absent".
        const stillObserved = observeRegistryForAbsence(witnesses)
        if (!stillObserved) return
        for (const entry of plan.retire) {
          if (stillObserved.presentIds.has(entry.diagramId)) continue
          if (isCreationInFlight(entry.diagramId)) continue
          if (entry.commentIds.length) {
            pendingEntityIntents.acknowledge(workspaceKey, 'comment', entry.commentIds, entityRevision)
          }
          if (entry.flowIds.length) {
            pendingEntityIntents.acknowledge(workspaceKey, 'flow', entry.flowIds, entityRevision)
          }
          if (entry.stubIntent) {
            pendingEntityIntents.acknowledge(workspaceKey, 'diagram', [entry.diagramId], entityRevision)
          }
          if (entry.placement) {
            // ALL record kinds retire under the diagram-level proof —
            // including connection/autoSize records the off-active drain
            // spares (they target model documents): once the carrier is
            // gone no expression path can ever cover them, and per-diagram
            // geometry of a deleted diagram is moot. A deliberate trade-off.
            pendingPlacementIntents.acknowledge(workspaceKey, entry.diagramId, placementRevision)
          }
          summaryRetiredDiagramIds.delete(entry.diagramId)
        }
        for (const dangling of plan.unaddressed) {
          pendingEntityIntents.acknowledge(workspaceKey, dangling.kind, [dangling.id], entityRevision)
        }
      },
      async () => {
        if (epoch !== durableAckEpoch) return
        await persistEntityIntents(kvStore, workspaceKey)
        await persistPlacementIntents(kvStore, workspaceKey)
      },
    )
    if (epoch !== durableAckEpoch) return
    scheduleDurableAcknowledgement(0)
  } catch (error) {
    console.warn('absent-diagram intent sweep failed', error)
  } finally {
    if (epoch === durableAckEpoch) {
      diagramAbsenceSweeping = false
      if (diagramAbsenceSweepFollowUp) {
        diagramAbsenceSweepFollowUp = false
        scheduleDiagramAbsenceSweep()
      }
    }
  }
}

/** The registry-pass companion for diagram-stub intents. The witness is the
 * SHARD DOCS ONLY — never `serverRegistryDiagrams`, which
 * `captureSummaryLocalDiagram` upserts in MEMORY at creation time: a witness
 * the client feeds itself would acknowledge a creation whose durable write
 * the doc-durability gate deliberately held back (the witness-derives-from-
 * the-claim trap, again). Under a summary registry only session-created ids
 * are considered — they live in the write-head shard, which IS their
 * complete registry; server-owned ids have no client write path there. */
function acknowledgeDiagramStubsAgainstRegistry(): void {
  const workspaceKey = workspaceRefKey(currentRef)
  const intents = pendingEntityIntents.pending(workspaceKey)
    .filter((intent) => intent.kind === 'diagram')
    .filter((intent) => !registrySummaryOnly || summaryLocalDiagramIds.has(intent.id))
    // A creation still behind the doc-durability gate CANNOT be expressed
    // this pass by construction — counting it as a survivor would schedule
    // a replay that writes nothing, whose flush re-runs this ack: an
    // unbounded hot loop when the gate's retries are exhausted. The gate lifting reschedules the write itself.
    .filter((intent) => !pendingDurableDiagramDocs.has(intent.id))
  if (!intents.length) return
  const throughRevision = pendingEntityIntents.revisionNow
  // Same completeness honesty as the replay: an unresolved shard is not an
  // empty one, and a delete must never ack by the absence "loading" fakes.
  const allShardsLoaded = shardHandles.every((h) => h.doc() !== undefined)
  const metas = mergeShards(shardHandles.map((h) => h.doc() ?? { diagrams: {} }))
  const currentMetaStubs = new Map(metas.map((meta) => [meta.id, diagramStubOf(meta)]))
  const ackPlan = planDiagramStubAck(intents, currentMetaStubs, allShardsLoaded, throughRevision)
  if (!ackPlan.ackIds.length) {
    if (ackPlan.survivors) {
      scheduleDiagramStubReplay()
      scheduleDiagramAbsenceSweep()
    }
    return
  }
  const shardDocIds = shardHandles.map((shardHandle) => shardHandle.documentId)
  const persistStore = workspaceKvStore()
  const workspace = documentsWorkspaceKey()
  const epoch = durableAckEpoch
  const idsByCarrier = registryCarriersOf(ackPlan.ackIds)
  void forgetIntentsOnceDurable(
    () => repo.flush(shardDocIds),
    () => {
      for (const [carriers, ids] of idsByCarrier) {
        markIntentsSent(workspaceKey, 'diagram', ids, throughRevision, workspace, carriers, epoch)
      }
    },
    () => persistEntityIntents(persistStore, workspaceKey),
  ).then(() => {
    scheduleDurableAcknowledgement(0)
  }).catch((error) => {
    console.warn('diagram stub intent durability flush failed', error)
  })
  if (ackPlan.survivors) {
    scheduleDiagramStubReplay()
    scheduleDiagramAbsenceSweep()
  }
}

function scheduleWrite(kind: WriteKind = 'normal'): void {
  if (kind === 'normal') pendingNormalWrite = true
  writeScheduler.request(kind)
  if (syncTransportConnected) useAutomergeStatus.getState().setStatus('saving')
}

/** A view-settings-only edit of one diagram (`classifyDiagramViewEdit`): same
 * debounce as a normal edit, but it does not arm the full write. */
function scheduleViewWrite(diagramId: string): void {
  pendingViewDiagramIds.add(diagramId)
  writeScheduler.request('normal')
  if (syncTransportConnected) useAutomergeStatus.getState().setStatus('saving')
}

function acknowledgePlacementSnapshot(
  workspaceKey: string,
  diagramId: string,
  snapshot: PlacementIntentSnapshot,
  documentId: DocumentId,
): void {
  const store = workspaceKvStore()
  // A handle.change is synchronous but its IndexedDB adapter is debounced. Keep
  // the recovery journal until this exact DiagramDoc is durably saved locally;
  // otherwise a crash between journal deletion and the adapter save can lose
  // the user's final position.
  //
  // The witness must cover EVERY carrier the snapshot wrote to.
  // Connection intents and group autoSize are NOT written into the
  // DiagramDoc: on the full path they land in the model documents (monolith/
  // shards, or the edits overlay + ModelMeta under BFS). Flushing only the
  // DiagramDoc before forgetting them let a crash lose the connection
  // routing with the journal already erased. Those snapshots flush ALL
  // documents — rare (the fast path excludes them), so the cost is noise.
  const needsFullFlush = snapshot.connections.length > 0
    || snapshot.groups.some((group) => group.autoSize !== undefined)
  const flushCarriers = needsFullFlush ? repo.flush() : repo.flush([documentId])
  // SENT, not forgotten (`SentMark`): the DiagramDoc carries the geometry, and
  // the model documents the connection/autoSize records — the overlay write
  // heads under boot-from-server, ModelMeta otherwise.
  const sentWorkspace = documentsWorkspaceKey()
  const epoch = durableAckEpoch
  const carrierIds = needsFullFlush
    ? [documentId, ...[editsConnectionShardHandle, editsObjectShardHandle, modelMetaHandle]
      .flatMap((handle) => (handle ? [handle.documentId] : []))]
    : [documentId]
  void flushCarriers.then(async () => {
    if (epoch === durableAckEpoch) {
      pendingPlacementIntents.markSentWhere(workspaceKey, diagramId, snapshot.throughRevision, () => true, {
        workspace: sentWorkspace, carriers: carriersOf(carrierIds),
      })
    }
    await persistPlacementIntents(store, workspaceKey)
    markClientTimeline('placement.flush.durable', {
      coalescedRevision: snapshot.throughRevision,
    })
    scheduleDurableAcknowledgement(0)
  }).catch((error) => {
    // The absolute latest-wins intent remains in IndexedDB and will be replayed
    // on the next successful gesture, lifecycle flush or workspace boot.
    console.warn('placement DiagramDoc durability flush failed', error)
  })
}

/**
 * Drain placement intents journaled for NON-ACTIVE diagrams. flushWrite
 * snapshots the active diagram only, so without this a crashed session's
 * off-active placements (an auto-layout applied from the list view, a
 * properties-panel edit mid-switch) would stay confined to one browser profile
 * forever — and, being badge-counted, would hold 'saving' forever too. Resolution is bounded per doc (no
 * `repo.find` without a ceiling — offline it NEVER settles); a diagram whose
 * doc cannot be resolved keeps its intents for the next drain (reconnect,
 * next boot, or its own activation via attachActive). Only object/group
 * geometry is drained — connection/autoSize records need the model write
 * path, which only the active-diagram flush runs.
 */
async function drainOffActivePlacementIntents(): Promise<void> {
  const epoch = durableAckEpoch
  const workspaceKey = workspaceRefKey(currentRef)
  const store = workspaceKvStore()
  for (const diagramId of pendingPlacementIntents.pendingDiagramIds(workspaceKey)) {
    if (epoch !== durableAckEpoch || !started) return
    if (diagramId === activeDiagramId) continue
    const snapshot = pendingPlacementIntents.snapshot(workspaceKey, diagramId)
    const drainable = snapshot !== undefined && (snapshot.objects.length > 0
      || snapshot.lowerRoutes.length > 0
      || snapshot.groups.some((g) => g.position !== undefined || g.size !== undefined))
    if (!snapshot || !drainable) continue
    const url = docUrlById.get(diagramId)
    if (!url) continue
    try {
      const resolveAttempt = resolveReadyHandleWithRetry<DiagramDoc>(
        repo, url as AutomergeUrl, { tries: 3, delayMs: 300 },
      )
      // The race can abandon the attempt (offline: find never settles, or it
      // rejects after the deadline) — observe it so a late rejection never
      // surfaces as unhandled.
      resolveAttempt.catch(() => undefined)
      const handle = await Promise.race([
        resolveAttempt,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
      ])
      if (epoch !== durableAckEpoch || !started) return
      if (!handle) continue
      // Re-validate AFTER the await: the
      // diagram may have been ACTIVATED while we resolved its doc —
      // attachActive's placement flush then writes and retires the journal,
      // the user drags on, and writing the PRE-await snapshot here would
      // revert their newest geometry with the journal already empty. Only a
      // freshly-read snapshot may be written.
      if (diagramId === activeDiagramId) continue
      const fresh = pendingPlacementIntents.snapshot(workspaceKey, diagramId)
      const freshDrainable = fresh !== undefined && (fresh.objects.length > 0
        || fresh.lowerRoutes.length > 0
        || fresh.groups.some((g) => g.position !== undefined || g.size !== undefined))
      if (!fresh || !freshDrainable) continue
      changeAndTrack(handle, (doc) => {
        applyPlacementSnapshotToDiagramDoc(doc, fresh)
      })
      const sentWorkspace = documentsWorkspaceKey()
      await repo.flush([handle.documentId])
      if (epoch !== durableAckEpoch) return
      // Only what THIS doc write expressed: object records, pure-geometry
      // group records and lower routes. Connection records and
      // autoSize-carrying group records target the MODEL documents, which only
      // the active-diagram flush writes — they survive for the activation
      // path. Revision-scoped to the FRESH snapshot: anything re-recorded after
      // it survives. SENT, not forgotten (`SentMark`).
      pendingPlacementIntents.markSentWhere(
        workspaceKey, diagramId, fresh.throughRevision,
        isDiagramDocPlacementRecord,
        { workspace: sentWorkspace, carriers: carriersOf([handle.documentId]) },
      )
      await persistPlacementIntents(store, workspaceKey)
      markClientTimeline('placement.offactive.drained', {
        diagramId,
        objects: fresh.objects.length,
        groups: fresh.groups.length,
        lowerRoutes: fresh.lowerRoutes.length,
      })
      scheduleDurableAcknowledgement(0)
    } catch (error) {
      console.warn('off-active placement drain failed', error)
    }
  }
}

/** `landscapeId/versionId` of the concrete workspace this session's documents
 * belong to, or null when the session cannot name it (`documentsWorkspaceFor`:
 * a root-fetch or root-cache basis for the root this session holds). It tags
 * what the durable-heads ledger and the SENT intents carry, so a repoint can
 * tell which documents belong to a version nobody opens any more. */
function documentsWorkspaceKey(): string | null {
  const workspace = documentsWorkspaceFor(currentRef, sessionRootUrl())
  return workspace ? `${workspace.landscapeId}/${workspace.versionId}` : null
}

/**
 * The carriers just flushed locally: move the intents to SENT, with each
 * carrier's heads as the server must later acknowledge them. Called from a
 * `forgetIntentsOnceDurable` forget step, i.e. after the flush.
 *
 * A carrier whose handle cannot be read contributes no proof, so the intent is
 * released on the others alone — or at once, with none, which is the behaviour
 * every intent had before the SENT stage. `workspace` and `epoch` are taken by
 * the caller BEFORE the flush, with its store: a switch landing during the
 * flush must not tag these intents with the next session's workspace.
 *
 * A flush that completes after its session ENDED marks nothing: the intents
 * stay PENDING, and the next session's replay plans them against its own
 * witnesses. Marked SENT under the old tag they would miss that session's
 * requeue — a FOLLOW's lifecycle flush lands just after it (found
 * 2026-10-31) — and sit uncounted while the badge said Synced.
 */
function markIntentsSent(
  workspaceKey: string,
  kind: EntityIntentKind,
  ids: readonly string[],
  throughRevision: number,
  workspace: string | null,
  carrierIds: readonly DocumentId[],
  epoch: number,
): void {
  if (epoch !== durableAckEpoch) return
  pendingEntityIntents.markSent(workspaceKey, kind, ids, throughRevision, { workspace, carriers: carriersOf(carrierIds) })
}

/**
 * A replay found these intents expressed in — or just wrote them into — the
 * LOCAL carrier: SENT, not forgotten. "Satisfied" read off a local document is
 * a local fact, and the journal must not lose an intention on a local fact: a
 * tab reopened offline from the cached root replays, finds the value in the
 * old version's local copy, and an outright ack there was the original loss
 * again once the default moved (found 2026-10-31).
 */
function markReplayedSent(
  workspaceKey: string,
  items: ReadonlyArray<{ kind: EntityIntentKind; id: string; revision: number }>,
  workspace: string | null,
  carrierIds: readonly DocumentId[],
  epoch: number,
): void {
  if (epoch !== durableAckEpoch || items.length === 0) return
  // Heads read once for the batch (each item at its own revision).
  const carriers = carriersOf(carrierIds)
  for (const item of items) {
    pendingEntityIntents.markSent(workspaceKey, item.kind, [item.id], item.revision, { workspace, carriers })
  }
}

/** Diagram ids grouped by the registry shard that carries each one's meta. An
 * id the index cannot place is carried by every shard: stricter, never wrong. */
function registryCarriersOf(ids: readonly string[]): Map<readonly DocumentId[], string[]> {
  const shardIdByUrl = new Map(shardHandles.map((shardHandle) => [shardHandle.url as string, shardHandle.documentId]))
  const all = shardHandles.map((shardHandle) => shardHandle.documentId)
  const byShard = new Map<DocumentId | null, string[]>()
  for (const id of ids) {
    const shard = shardIdByUrl.get(shardByDiagramId.get(id) ?? '') ?? null
    byShard.set(shard, [...(byShard.get(shard) ?? []), id])
  }
  return new Map([...byShard].map(([shard, grouped]) => [shard ? [shard] : all, grouped]))
}

/** Each carrier's heads, read now (after its flush). */
function carriersOf(carrierIds: readonly DocumentId[]): SentCarrier[] {
  const carriers: SentCarrier[] = []
  for (const documentId of carrierIds) {
    const doc = syncedHandle(repo, documentId)?.doc()
    if (doc) carriers.push({ documentId, heads: getHeads(doc as never) })
  }
  return carriers
}

/**
 * Move entity intents to SENT ONLY once the overlay/meta document that carries
 * them is durably saved by the local IndexedDB adapter — `handle.change` is
 * synchronous but the adapter is debounced, so acknowledging earlier would
 * re-open the exact crash window this journal closes (same contract as
 * acknowledgePlacementSnapshot). `throughRevision` was captured BEFORE the
 * Automerge change: an intent re-recorded mid-flight has a higher revision and
 * survives. SENT, not forgotten: see `SentMark` (entityIntents.ts) for why the
 * local flush is not enough to drop the user's intention.
 */
function acknowledgeEntityIntentBatch(
  kind: EntityIntentKind,
  ids: readonly string[],
  throughRevision: number,
  documentId: DocumentId,
): void {
  if (ids.length === 0) return
  const workspaceKey = workspaceRefKey(currentRef)
  const store = workspaceKvStore()
  const workspace = documentsWorkspaceKey()
  const epoch = durableAckEpoch
  // The flush→forget→persist ORDER lives in forgetIntentsOnceDurable, where a
  // unit test pins it. Do not re-inline it.
  void forgetIntentsOnceDurable(
    () => repo.flush([documentId]),
    () => markIntentsSent(workspaceKey, kind, ids, throughRevision, workspace, [documentId], epoch),
    () => persistEntityIntents(store, workspaceKey),
  ).then(() => {
    // Let the badge re-evaluate now that the journal may have drained.
    scheduleDurableAcknowledgement(0)
  }).catch((error) => {
    // The absolute latest-wins intent stays journaled; it is replayed on the
    // next flush, lifecycle flush or workspace boot.
    console.warn('entity intent durability flush failed', error)
  })
}

function flushPendingWritesForLifecycle(): void {
  const workspaceKey = workspaceRefKey(currentRef)
  // A write the hop's latch deferred is still the user's: on a
  // pagehide during the latch it is written NOW — to the epoch the tab still
  // holds, which is retained and forwarded — then the latch's pause resumes
  // (`lifecycleFlushPlan`).
  const residentDebt = residentPendingWrites.size > 0
  const plan = lifecycleFlushPlan({
    pausedByHop: writesPausedByHop,
    deferredByHop: writeDeferredByHop,
    pending: writeScheduler.pending
      || pendingPlacementIntents.hasPending(workspaceKey)
      || pendingEntityIntents.hasPending(workspaceKey)
      // A page hidden with a local write no document holds yet writes it now,
      // before the reload.
      || residentDebt,
  })
  if (!plan.flush) return
  // A debt no write is scheduled for — an edit made while the boot ran, before
  // `onStoreChange` was subscribed, and a stop (a workspace switch, a remount)
  // before the boot ended — is written now. Only while the store projects every
  // loaded shard as it is: the write reconciles each shard to the store's slice
  // of it, so a store not projected yet would delete what it does not show.
  if (residentDebt && !writeScheduler.pending && residentStoreProjectsShards()) {
    pendingNormalWrite = true
    writeScheduler.request('normal')
  }
  if (plan.liftPause) {
    writesPausedByHop = false
    writeDeferredByHop = false
    try {
      if (plan.requestDeferred) writeScheduler.request('normal')
      writeScheduler.flushNow()
    } finally {
      writesPausedByHop = true
    }
  } else {
    writeScheduler.flushNow()
  }
  void flushPlacementIntentPersistence(workspaceKvStore(), workspaceKey).catch((error) => {
    console.warn('pending placement lifecycle persistence failed', error)
  })
  void flushEntityIntentPersistence(workspaceKvStore(), workspaceKey).catch((error) => {
    console.warn('pending entity intent lifecycle persistence failed', error)
  })
  // Local durability only; network convergence remains asynchronous/offline-safe.
  void repo.flush().catch((error) => console.warn('[repo] lifecycle flush partial', error))
}

type ModelStoreSnapshot = ReturnType<typeof useModelStore.getState>

function onStoreChange(state: ModelStoreSnapshot, previous: ModelStoreSnapshot): void {
  // NO capture-baseline seeding here. `applyingRemote` means "not a user
  // edit", NOT "this state is durable": `clearExplicitDeleteIntents` re-enters
  // this subscriber synchronously under the flag with the POST-DELETE slices,
  // and a seed hooked on it would reseed the group baseline out from under the
  // delete diff on every explicit-delete tick — group deletes would never be
  // journaled at all. The baselines are seeded only at
  // the sites that write DURABLE small-collection values into the store:
  // boot, projectActiveFromServer (pre-overlay values), the ADR page
  // projection, the small-collections flush, and the replay's injection.
  if (applyingRemote) return
  // Before any early return: every local change to a scope map must be recorded.
  scopeEdits.note(previous.diagrams, state.diagrams)
  if (isBootFromServerEnabled() && state.selectedItems !== previous.selectedItems) {
    syncHydration()
  }
  const diagramSwitched = state.currentDiagramId !== previous.currentDiagramId
  const durableSlicesChanged = persistentSlicesChanged(state, previous)
  // A LOCAL write of the resident sharded path is owed until a document holds
  // it (boot-from-server journals its own).
  if (!bfsActive && sharded && modelMetaHandle) {
    residentPendingWrites.note('objects', previous.objects as never, state.objects as never)
    residentPendingWrites.note('connections', previous.connections as never, state.connections as never,
      (c) => (c as unknown as Connection).kind === 'lower')
  }
  // G4-16l, case 2: a throw between the note above and the write scheduled
  // below left the debt owed and unscheduled — at the boot's replay of her
  // window edits, and in the steady state alike — until a later edit; a
  // reload lost it. The finally hands it to the session's driver, and lets
  // the throw go on (never masked).
  try {
    faultPointForTest('onStoreChangeAfterNote')
    scheduleStoreChangeWrites(state, previous, diagramSwitched, durableSlicesChanged)
  } finally {
    if (residentPendingWrites.size > 0) residentDebtDriver?.arm()
  }
}

function scheduleStoreChangeWrites(
  state: ModelStoreSnapshot,
  previous: ModelStoreSnapshot,
  diagramSwitched: boolean,
  durableSlicesChanged: boolean,
): void {
  const explicitDeletesChanged = state.pendingDeletedObjectIds !== previous.pendingDeletedObjectIds
    || state.pendingDeletedConnectionIds !== previous.pendingDeletedConnectionIds
    || state.pendingDeletedGroupIds !== previous.pendingDeletedGroupIds
    // Without this term an OFF-WINDOW diagram delete changes no other slice
    // at all — `state.diagrams` is rebuilt identical — so nothing would capture
    // the intent and nothing would schedule a write. The silent no-op, exactly.
    || state.pendingDeletedDiagramIds !== previous.pendingDeletedDiagramIds
  const placementChanged = state.placementRevision !== previous.placementRevision
  if (state.diagrams !== previous.diagrams) {
    // Both modes: hold the new diagram through any projection that lands before
    // its registry meta is written.
    for (const diagram of localDiagramHold.noteCreated(state.diagrams, previous.diagrams)) {
      if (registrySummaryOnly) captureSummaryLocalDiagram(diagram)
    }
  }
  // …and the deleted one, the same window the other way round: deleting the
  // OPEN diagram switches the active diagram below, whose first paint rebuilds
  // the list from registry metas the flush has not touched yet (T-DIAGDEF (2)).
  // Every mode, before the bfs/whole-model split clears the intents.
  if (state.pendingDeletedDiagramIds !== previous.pendingDeletedDiagramIds) {
    localDiagramHold.noteDeleted(state.pendingDeletedDiagramIds)
  }
  // Selection, hover and other transient UI updates must not look like edits,
  // scan the resident model, reset the write debounce or touch Automerge.
  if (!durableSlicesChanged && !explicitDeletesChanged && !diagramSwitched) return
  if (durableSlicesChanged || explicitDeletesChanged) {
    lastLocalEditAt = Date.now() // defer live invalidation refresh while the user is actively editing
  }
  // Boot-from-server (step 2c): the store holds only the active diagram, so the MODEL
  // write (objects/connections shards) must be skipped — flushWrite gates that with
  // `diagramOnly`. But edits that only touch the loaded active DIAGRAM doc + registry
  // shards (comments, flows, layout positions, adding an existing object to the
  // diagram) ARE persistable, so we DO schedule writes here. (applyingRemote above
  // still suppresses the server-render projection from looping back as an edit.)
  // Slice B/C: capture user-created/edited entities before they could be dropped by a
  // switch re-projection (they live in the durable edits maps → the edits shard).
  // Slice D: hydrate the SELECTED off-window entity into the store so it's editable.
  // Gated on bfsActive, NOT the raw flag: every DRAIN of these captures
  // (writeEditsShards, writeTombstones, the intent replay) is gated on
  // bfsActive, and since the client-side monolith split was removed,
  // "flag ON + bfsActive false" is the PERMANENT, ordinary state of a monolith
  // workspace — capture on the raw flag there would fill the entity-intent
  // journal forever with nothing to ever acknowledge it (a lifelong wrong
  // badge, an O(n²) journal, and stale intents replayed over
  // resident history if the workspace is ever sharded later).
  if (bfsActive) {
    if (explicitDeletesChanged) captureExplicitDeletes(state)
    if (durableSlicesChanged) detectEdits()
  } else if (explicitDeletesChanged) {
    // In whole-model mode the ordinary model write persists the removal; do not
    // retain transient intents that could be replayed if a runtime flag changes.
    // A diagram deleted before its meta was published is in no shard, so the
    // registry write never removes it and nothing tombstones it here: drop its
    // unpublished url NOW, or every later rebuild would make it resolvable again
    // (bridgeCreatedDocUrlLifecycle.test.ts, "a gated diagram deleted locally
    // stays unresolvable across a rebuild").
    for (const deletedId of state.pendingDeletedDiagramIds) unpublishedDiagramDocs.forget(deletedId)
    clearExplicitDeleteIntents()
  }
  const id = state.currentDiagramId
  if (diagramSwitched && id !== activeDiagramId) {
    // Switching the active diagram re-projects (from the server render under
    // boot-from-server, or projectAll otherwise), which rebuilds the store. Flush any
    // pending local writes to the OUTGOING diagram FIRST, or the re-projection would
    // clobber store-only edits (a just-added comment/flow, or a fresh import) before
    // they persist.
    writeScheduler.flushNow()
    switching = switchActiveDiagram(id).catch((e) => console.error('switch diagram failed', e))
  }
  // `currentDiagramId` is browser-local. A pure navigation must never publish
  // a no-op DiagramDoc/registry revision and invalidate the render cache.
  if (durableSlicesChanged || explicitDeletesChanged) {
    const viewOnlyDiagramId = !explicitDeletesChanged && !placementChanged
      ? classifyDiagramViewEdit(state, previous)
      : null
    if (viewOnlyDiagramId) scheduleViewWrite(viewOnlyDiagramId)
    else scheduleWrite(placementChanged ? 'placement' : 'normal')
  }
  // Placements recorded for a NON-active diagram (applyDiagramLayout from a
  // list view) have no other in-session drain trigger.
  if (placementChanged) scheduleOffActivePlacementDrain()
}

// ── live connection status ────────────────────────────────────────────────────

/** Coalesce workspace invalidations into one generation-consistent render. A
 * local drag/typing session delays refresh until it has been idle for 2.5s, so
 * a remote projection cannot interrupt the interaction. */
function scheduleLiveSyncRefresh(generation?: number): void {
  if (Number.isSafeInteger(generation) && (generation ?? -1) >= 0) {
    const nextGeneration = generation as number
    if (nextGeneration <= lastServerProjectionGeneration && !liveSyncRefreshRequested) return
    pendingLiveGeneration = Math.max(pendingLiveGeneration, nextGeneration)
  }
  liveSyncRefreshRequested = true
  if (liveSyncRefreshTimer || liveSyncRefreshInFlight) return

  const run = async (): Promise<void> => {
    liveSyncRefreshTimer = null
    if (!liveSyncRefreshRequested || !started || !bfsActive) return
    if (useAutomergeStatus.getState().status !== 'ready') return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    const quietRemaining = 2500 - (Date.now() - lastLocalEditAt)
    if (quietRemaining > 0) {
      liveSyncRefreshTimer = setTimeout(() => { void run() }, quietRemaining)
      return
    }
    const id = useModelStore.getState().currentDiagramId
    if (!id) {
      liveSyncRefreshRequested = false
      pendingLiveGeneration = -1
      return
    }
    const requestedGeneration = pendingLiveGeneration
    pendingLiveGeneration = -1
    liveSyncRefreshRequested = false
    liveSyncRefreshInFlight = true
    try {
      await projectActiveFromServer(id)
    } finally {
      liveSyncRefreshInFlight = false
      if (requestedGeneration > lastServerProjectionGeneration) {
        pendingLiveGeneration = Math.max(pendingLiveGeneration, requestedGeneration)
        liveSyncRefreshRequested = true
      }
      if (liveSyncRefreshRequested) scheduleLiveSyncRefresh()
    }
  }
  liveSyncRefreshTimer = setTimeout(() => { void run() }, 0)
}

function stopLiveSync(): void {
  if (liveSyncTimer) clearInterval(liveSyncTimer)
  liveSyncTimer = null
  if (liveSyncRefreshTimer) clearTimeout(liveSyncRefreshTimer)
  liveSyncRefreshTimer = null
  liveSyncInvalidationUnsubscribe?.()
  liveSyncInvalidationUnsubscribe = null
  liveSyncRefreshInFlight = false
  liveSyncRefreshRequested = false
  pendingLiveGeneration = -1
}

/** SSE is the primary live-sync trigger. The one-minute fallback only repairs a
 * missed notification or a deployment where streaming is unavailable. */
function startLiveSync(): void {
  stopLiveSync()
  // The invalidation stream is also the ONLY signal that tells the bounded LIST
  // pages (Model objects, Model connections, Dependencies) that the server read
  // model they query has caught up. Their other revalidation trigger — the local
  // index write — fires from `writeEditsShards` at FLUSH time, i.e. strictly
  // BEFORE the server has projected the change, so it revalidates against the
  // pre-write projection and the new row never appears (e.g. creating an
  // object on the Model Objects page would leave "Total objects: 0" until a
  // reload). The revision (`notifyServerInvalidation`) is a counter, not data — consumers
  // re-query their own authoritative endpoint.
  if (!bfsActive && !isServerReadModelEnabled()) return
  liveSyncInvalidationUnsubscribe = subscribeCurrentWorkspaceInvalidations((event) => {
    notifyServerInvalidation()
    if (bfsActive) scheduleLiveSyncRefresh(event.generation)
  })
  if (!bfsActive) return
  liveSyncTimer = setInterval(() => {
    scheduleLiveSyncRefresh()
  }, LIVE_SYNC_FALLBACK_MS)
}

/** Guards against acting twice on the same move: the binding frame arrives on
 * every connect, and the corrective action itself reconnects. A frame that
 * lands meanwhile is handed back and re-offered when the action ends. */
let repointInFlight = false

/**
 * The server just named the workspace it bound this socket to. Does it agree
 * with the one this tab's documents belong to?
 *
 * Disagreement means an admin repointed the landscape's default version while
 * this tab was open. Every document the tab holds is then denied
 * `workspace-mismatch`, permanently, and everything done afterwards is lost
 * behind a badge that says "Saving…".
 *
 * The answer is to FOLLOW, which is what `'current'` means, and to CARRY what
 * this tab has not got confirmed into the version it follows. That is the
 * product decision of 2026-10-31: unsynced work lands in the new default,
 * whether the tab reloads or stays open, so a user's work is never split
 * between a version nobody opens any more and the one everybody does. (This
 * branch used to PIN the tab to the old version whenever anything was unsaved;
 * the work then landed in V1 only, or — when the reload outran the pin — in
 * V1's registry with its DiagramDoc claimed by V2: repoint-offline-create.spec
 * test 2, 3 runs of 3.)
 *
 * Carrying needs two things, in this order:
 *  - the documents holding the unconfirmed changes are WITHHELD at once,
 *    synchronously, here: the frame precedes the handshake on this socket, and
 *    the server announces its root's core documents (registry shards included)
 *    to every peer, so without the withhold the old version's offline edits
 *    leave on the very socket that just told us the version moved;
 *  - the FOLLOW reboots the bridge, whose root resolution then puts the work
 *    those documents carried back into the journal for the new version
 *    (`partitionDurableLedger`).
 *
 *  - this session is the boot FALLBACK (`bootFallbackActive`) and the frame
 *    names the version whose root failed (`bootFallbackFailedVersionId`) →
 *    HOLD as well, whatever is unsaved. The root this session holds is the
 *    cached one, of the version it was fetched for; following re-asks the
 *    server for the very root that just failed, a follow whose boot falls back
 *    again meets the same frame again, and each round is a workspace teardown
 *    plus a full resolution budget — measured 2026-10-29 before this rule, a
 *    fallback session re-entered that root at +52.9 s and again at +76.5 s
 *    (repoint-boot-fallback.spec.ts's stack). Holding loses nothing following
 *    would have kept: nothing is persisted, so the next reload asks the server
 *    again (the fallback's own contract), and the banner's button is the
 *    retry, one per click.
 */
function onWorkspaceBound(bound: WorkspaceBinding, defer: () => void): void {
  if (repointInFlight) {
    // Not dropped: a FOLLOW runs its whole reload inside the response, so this
    // can be that reload's own frame, replayed when its boot installed this
    // handler — and if that boot fell back, it is the only frame there will
    // be. Re-offered from the `finally` below (repoint-boot-fallback.spec.ts,
    // test 2).
    defer()
    return
  }
  const ref = currentWorkspaceRef()
  // A concrete ref cannot be re-canonicalised: it names its own version, so a
  // binding for it can only ever agree. Only an alias can move underneath.
  if (ref.versionId !== CURRENT_VERSION_ID) return
  if (bound.landscapeId !== ref.landscapeId) return
  const booted = resolvedWorkspaceFor(ref)
  if (!booted) {
    // SELF-ARMING, and it is not an optimisation. The basis is normally set by
    // the root fetch — but a deep-link boot onto `…/version/current` can reach
    // a fully booted workspace with the basis still NULL, which would leave the
    // whole detector inert.
    //
    // The first binding of a session is therefore taken AS the basis. The
    // cost: a repoint landing before the first socket is adopted as though it
    // had always been so, and goes undetected. This branch runs only when
    // there is no basis at all — a server that reported no key (after a follow
    // cleared the basis, too), or a page that
    // booted from a cached root with no key persisted beside it (one written
    // before the key was persisted; otherwise `repo.ts` restores the key as a
    // `root-cache` basis). Hence the provenance: `documentsWorkspaceFor`, which
    // the durability witness, the Spotlight's server tier and every
    // `/api/model/*` read ask through, never trusts this basis.
    //
    // A frame that arrives DURING a boot is not lost: this handler is installed
    // by `wireConnectionStatus`, at the end of a successful boot, and
    // `workspaceBinding.ts` keeps the frame no handler took and replays it on
    // install. That is how the boot FALLBACK, which runs with the server up and
    // whose re-entry does not reconnect, meets its socket's frame at all
    // (e2e/boot/repoint-boot-fallback.spec.ts); a cached-root boot taken with
    // the server DOWN meets its first frame after boot
    // (e2e/boot/repoint-cached-root.spec.ts).
    adoptBindingAsBasis(ref, bound)
    return
  }
  if (bound.versionId === booted.versionId) return

  const unsaved = pendingDurabilityCount()
  const bootFallback = useAutomergeStatus.getState().bootFallbackActive
  // The fallback rule applies only to the version whose root failed: a repoint
  // to some OTHER version later in a fallback session (or a fallback that was
  // a slow server, not a repoint) follows like any other — the flag lasts the
  // whole session (found 2026-10-29). Unknown (a server that reported
  // no key) counts as that version: holding is the side that cannot loop.
  const retriesFailedRoot = bootFallback
    && (bootFallbackFailedVersionId === null || bootFallbackFailedVersionId === bound.versionId)
  const hold = retriesFailedRoot
  console.warn(JSON.stringify({
    event: 'workspace.repoint_observed',
    landscapeId: ref.landscapeId,
    bootedVersionId: booted.versionId,
    boundVersionId: bound.versionId,
    unsaved,
    bootFallback,
    failedVersionId: bootFallbackFailedVersionId,
    action: hold ? 'pin' : 'follow',
  }))
  // Before anything awaits (see the docstring): the handshake follows this
  // frame on the same socket. Every document the ledger names holds changes
  // the server has not confirmed; the follow's boot decides which of them
  // belong to the version it lands on and lifts those.
  if (!hold) activeDocumentShare.withhold(durableHeads.snapshot().map(({ documentId }) => documentId))

  repointInFlight = true
  void (async () => {
    try {
      if (hold) {
        // HOLD, by re-routing the TRANSPORT only. The ref is deliberately left
        // on `'current'`.
        //
        // Switching the workspace to the concrete version would orphan the
        // intent journals, which are keyed by `workspaceRefKey(currentRef)`:
        // moving the ref from `L/current` to `L/V1` hides the entries the
        // replay would have found.
        //
        // Swapping the adapter changes one thing — the `versionId` on the socket
        // url — and touches nothing else: the Repo, the store, the projection,
        // the write scheduler and both journals stay exactly as they are. The
        // server then binds this socket to the concrete version, so every
        // document the tab holds is admissible again and the pending writes
        // drain on their own.
        //
        // Nothing is persisted either: a reload puts the tab back on `current`
        // and the hold simply ends, and the reload is the fallback's retry.
        const held = { landscapeId: ref.landscapeId, versionId: booted.versionId }
        useAutomergeStatus.getState().noteWorkspacePinnedAfterRepoint(held, 'boot-fallback')
        // One value, two consumers: the socket route below, and the HTTP params
        // that `workspaceSearchParams` builds for every /api/model/* call. Set
        // BEFORE the route, so no request can be issued against the alias while
        // the transport is already somewhere else.
        holdWorkspaceOn(held)
        await routeWorkspaceNetwork(held, true)
        return
      }
      // Clear the basis first — see `forgetResolvedWorkspace`. The reload's
      // own frame now reaches this handler only after the reload's root fetch
      // (kept while no handler is installed, deferred while this runs), but a
      // fetch that reports no key leaves the basis as it was: comparing the new
      // binding against the stale one would follow again, forever.
      forgetResolvedWorkspace(ref)
      // Dynamic import: `switchWorkspace` closes a static cycle through
      // workspaceStore back into this module, the same reason the dangling-ref
      // fallback below imports the store rather than naming it at the top.
      const { reloadWorkspace } = await import('./switchWorkspace')
      await reloadWorkspace()
    } catch (error) {
      console.warn('[workspace-binding] repoint response failed', error)
    } finally {
      repointInFlight = false
      // A frame handed back while this ran (see the top of this function).
      redeliverWorkspaceBinding()
    }
  })()
}

/** Reflect transport availability without confusing it with PostgreSQL
 * durability. Connected traffic can produce "Saving"; only the durable-heads
 * acknowledgement may produce "Synced" while local heads are pending. */
function wireConnectionStatus(): void {
  // The session's own lifecycle listeners take over from the debt driver's
  // (G4-16l: one owner of the lifecycle at a time).
  residentDebtDriver?.uninstallLifecycle()
  const { setStatus } = useAutomergeStatus.getState()
  // Reach a CONNECTED state on any sync traffic, not just the 'peer' event. automerge-repo does NOT
  // re-fire 'peer' on a WS reconnect to the same server (its own NetworkSubsystem flags it:
  // the server treats the reconnect as a late channel for an existing peer). So after a
  // network blip the badge would stay stuck on 'connecting' forever even though sync works.
  // Incoming 'message' events flow on every (re)connect, so they're the reliable signal. On
  // the transition INTO 'ready' we also re-fetch the active render (boot-from-server) so
  // remote edits made while we were offline show up immediately.
  const markReady = () => {
    scheduleOverlayBatchAcknowledgement(250)
    setDurableConnectionState(true)
    if (bfsActive) scheduleLiveSyncRefresh()
  }
  const onDisconnected = () => setDurableConnectionState(false)
  const onOffline = () => setDurableConnectionState(false)
  const onOnline = () => {
    setSyncTransportConnected(false)
    setStatus('connecting')
    if (durableHeads.size > 0) scheduleDurableAcknowledgement(0)
    // Reset the mint backoff and top the id pool up now — the mint response
    // is also how a repoint that happened while offline is observed.
    notifyMintedIdSupplyOnline()
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') flushPendingWritesForLifecycle()
  }
  const onPageHide = () => flushPendingWritesForLifecycle()

  repo.networkSubsystem.on('peer', markReady)
  repo.networkSubsystem.on('message', markReady)
  repo.networkSubsystem.on('peer-disconnected', onDisconnected)
  window.addEventListener('offline', onOffline)
  window.addEventListener('online', onOnline)
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', onPageHide)
  if (typeof navigator !== 'undefined' && !navigator.onLine) setDurableConnectionState(false)

  startLiveSync()

  const uninstallWorkspaceBinding = installWorkspaceBindingHandler(onWorkspaceBound)

  netCleanups = [
    uninstallWorkspaceBinding,
    () => repo.networkSubsystem.off('peer', markReady),
    () => repo.networkSubsystem.off('message', markReady),
    () => repo.networkSubsystem.off('peer-disconnected', onDisconnected),
    () => window.removeEventListener('offline', onOffline),
    () => window.removeEventListener('online', onOnline),
    () => document.removeEventListener('visibilitychange', onVisibilityChange),
    () => window.removeEventListener('pagehide', onPageHide),
    stopLiveSync,
  ]
}

function unwireConnectionStatus(): void {
  netCleanups.forEach((fn) => fn())
  netCleanups = []
}

/**
 * Test hook: install the connection-status listeners without booting a bridge,
 * and return their removal.
 *
 * The minted-id supply's wake is reachable in production through exactly these
 * listeners, while everything else in the tree exercises the supply by calling
 * its exports directly — so without this hook the wire itself would be covered
 * by nothing. Booting a whole bridge to reach it
 * costs a workspace, a repo and a socket; this reaches it with none of them.
 */
export function __wireConnectionStatusForTest(): () => void {
  wireConnectionStatus()
  return unwireConnectionStatus
}

// ── fresh-on-load (boot-from-server) ──────────────────────────────────────────

/** Max time to hold the boot loader waiting for the active diagram doc to catch up
 * to the server before painting anyway (fail-open so a slow/quiet server still
 * boots promptly). */
const FRESHNESS_WAIT_MS = 2500

/**
 * A warm boot-from-server client resolves the active diagram doc from IndexedDB
 * (`repo.find().whenReady()` returns the on-disk copy) BEFORE the WebSocket has
 * delivered the server's newer copy — so painting immediately shows a STALE layout
 * for ~1-2s and then snaps once sync lands. Before we lift the boot loader (which
 * hides the canvas until `status === 'ready'`), compare the local doc's heads to
 * the server's: if the local copy already has every server head it is current → we
 * return at once (no wait). Otherwise we hold until the WS merges the server's
 * changes — the diagram-doc 'change' handler re-projects the fresh layout — or a
 * bounded timeout, then force one projection so the first VISIBLE frame is already
 * the latest.
 *
 * Fail-open and scoped: no-op unless boot-from-server is active, and any of
 * offline / server-can't-tell / superseded-by-a-switch returns immediately (paint
 * local, unchanged behavior). Heads are RAW hex (`getHeads`), matching the server's
 * `getHeads` — `handle.heads()` returns repo-tagged UrlHeads that would never match.
 */
async function awaitActiveDiagramFresh(id: string): Promise<void> {
  if (!bfsActive) return
  if (useAutomergeStatus.getState().status === 'offline') return
  const handle = activeDiagramHandle
  if (!handle || activeDiagramId !== id) return

  // Bound the heads fetch so a slow/hung endpoint can NEVER hang boot — on timeout
  // we treat it as "can't tell" and paint local (fail-open).
  const serverHeads = await Promise.race([
    fetchDiagramDocHeads(id),
    new Promise<undefined>((r) => setTimeout(() => r(undefined), FRESHNESS_WAIT_MS)),
  ])
  // A switch may have superseded us while awaiting the heads fetch.
  if (!started || activeDiagramId !== id || activeDiagramHandle !== handle) return
  if (!serverHeads || serverHeads.length === 0) return

  const isCurrent = (): boolean => {
    const doc = handle.doc()
    if (!doc) return false
    const local = new Set(getHeads(doc))
    return serverHeads.every((h) => local.has(h))
  }
  // Already up to date: the boot projection used this same (current) doc — nothing
  // to wait for and nothing stale to repaint.
  if (isCurrent()) return

  // Behind: wait for the WS to merge the server's changes into this handle.
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      handle.off('change', onChange)
      clearTimeout(timer)
      resolve()
    }
    const onChange = (): void => {
      if (isCurrent()) finish()
    }
    const timer = setTimeout(finish, FRESHNESS_WAIT_MS)
    handle.on('change', onChange)
    // The merge may have landed between the heads fetch and attaching the listener.
    if (isCurrent()) finish()
  })

  // The diagram-doc 'change' re-projection is async (it re-fetches the render), so
  // resolving on heads alone could lift 'ready' a beat before the store updates.
  // Force one projection now so the first visible frame is the latest layout.
  if (started && activeDiagramId === id) await projectActiveFromServer(id)
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

function scheduleOverlayHydration(): void {
  cancelDeferredOverlayHydration?.()
  cancelDeferredOverlayHydration = null
  const meta = modelMetaHandle?.doc()
  const hasPersistedOverlay =
    orderedObjectOverlayUrls(meta).length > 0 || orderedConnectionOverlayUrls(meta).length > 0
  markClientTimeline('overlay.write-head.planned', {
    hasPersistedOverlay,
    objectSegments: orderedObjectOverlayUrls(meta).length,
    connectionSegments: orderedConnectionOverlayUrls(meta).length,
    writeHeadVersion: meta?.editsOverlayWriteHeadVersion ?? null,
  })
  if (!hasPersistedOverlay) {
    // No overlay URLs at all (a workspace whose ModelMeta lost its heads):
    // ensureOverlayHandles will never be called, so the crash journal's replay
    // must be triggered from here or it never runs on exactly the workspaces
    // that need it most.
    void maybeReplayEntityIntents({ withoutHandles: true })
    return
  }
  // OFFLINE boot: a head this browser never fetched cannot resolve until the
  // server is back, and `ensureOverlayHandles` reaches its degraded replay only
  // when the resolve gives up — 9 min 33 s (the unbudgeted retry in repo.ts).
  // Until then the journaled edits stayed invisible: an edit made offline looked
  // reverted after an offline reload (measured 2026-10-16, 4 runs in 6,
  // e2e/boot/offline.spec.ts "edit an EXISTING shape OFFLINE"). Put them back on
  // screen now; the degraded replay is the designed first half of the sequence —
  // the normal replay still runs (via the follow-up latch) once heads resolve.
  // The replay only fills `editsObjects`; the projection is what overlays it on
  // the rendered window — as `runDeferredHydration` does after its own replay.
  // Gated on EVIDENCE the server is unreachable, not on `!syncTransportConnected`
  // (false for the whole of every boot, so a mid-boot ModelMeta change ran this
  // on ONLINE boots), and once per session (this runs on every
  // ModelMeta change and the degraded replay is latched anyway).
  // NOT covered: it also fires offline when the heads ARE resolvable locally; the
  // degraded pass then runs before the overlay is materialized, so an unstamped
  // intent's whole snapshot can be flushed before the normal replay merges it
  // per field — the order the 9-minute give-up already produced, now the
  // ordinary one.
  if (serverUnreachable && !entityIntentsDegradedReplayed) {
    void maybeReplayEntityIntents({ withoutHandles: true })
      .then(() => (started && bfsActive ? projectActiveFromServer(activeDiagramId) : undefined))
      .catch((error) => { console.error('offline journal re-projection failed', error) })
  }

  const runDeferredHydration = async () => {
    cancelDeferredOverlayHydration = null
    try {
      await ensureOverlayHandles()
      if (!started || !bfsActive) return
      await projectActiveFromServer(activeDiagramId)
    } catch (error) {
      console.error('deferred edits overlay projection failed', error)
    }
  }
  // A hidden tab never runs requestAnimationFrame, so the rAF-deferred path
  // would park FOREVER — and a server-side head repair arriving while the tab
  // is hidden would never drain the crash journal until the user looks at it.
  // Timers do fire in hidden tabs (throttled); use one there.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    const timer = setTimeout(() => { void runDeferredHydration() }, 1_000)
    cancelDeferredOverlayHydration = () => clearTimeout(timer)
    return
  }
  cancelDeferredOverlayHydration = scheduleDeferredOverlayHydration(runDeferredHydration)
}

export async function startBridge(ref: WorkspaceRef = DEFAULT_WORKSPACE_REF): Promise<void> {
  if (started) return
  // Captured PER INVOCATION (see bootFallbackReentryPending): this boot is the
  // fallback re-entry iff the fallback branch just handed control here.
  const isFallbackReentry = bootFallbackReentryPending
  bootFallbackReentryPending = false
  // Only a re-entry keeps the version its failed boot was asked for.
  if (!isFallbackReentry) bootFallbackFailedVersionId = null
  durableAckEpoch += 1
  // Which boot owns the module state: the session epoch, bumped by every start
  // and every stop, so a boot whose epoch has moved on was SUPERSEDED.
  //
  // Boots OVERLAP. React StrictMode's dev double-mount — and any re-run of
  // `AutomergeBridge`'s effect — stops one boot and starts another while the
  // first still awaits the same memoized root. A failing boot must therefore
  // ask whether it is still the session before recovering, and a superseded one
  // used not to: measured 2026-10-29 on the dev stack
  // (e2e/boot/repoint-boot-fallback.spec.ts), the stopped boot fell back and
  // re-entered, then the live boot's catch — refused as "already fell back" —
  // set `started = false` under that re-entry, which went on to boot with every
  // projection returning early: the bridge held 27 diagrams, the store none,
  // and the canvas read "No diagrams yet". Checked again after every await on
  // the recovery paths, and before the success tail.
  const bootEpoch = durableAckEpoch
  const superseded = (): boolean => bootEpoch !== durableAckEpoch
  durableHeads.clear()
  const ledgerStore = workspaceKvStore()
  durableLedgerStore = ledgerStore
  serverDurability.clear()
  serverUnreachable = false
  // Same lifetime as the ledger it shadows. A new session gets a fresh budget:
  // the per-session cap must not carry a previous workspace's refusals into one
  // that may be perfectly healthy.
  deniedRecovery.clear()
  setSyncTransportConnected(false)
  setLocalDocumentChangeListener((handle) => {
    lastModelActivityAt = Date.now()
    trackDurableHandle(handle, true)
    recordLocalActor(handle)
    taggedCarriers?.add(handle.documentId)
  })
  // Only answers about THIS session's workspace, compared when
  // each answer arrives: the session's parameters move from the `current`
  // alias to the concrete version once it is bound, so a value captured here
  // would never match again (seen in e2e: no tab ever learned the capability).
  setEpochCapabilityListener((epochs, params) => { if (params === withWorkspaceParams('')) noteEpochCapability(epochs) })
  if (import.meta.env?.DEV && typeof window !== 'undefined') {
    ;(window as unknown as { __epochHop?: typeof epochHopProbe }).__epochHop = epochHopProbe
    ;(window as unknown as { __epochDeferredQueue?: typeof epochDeferredQueueProbe }).__epochDeferredQueue = epochDeferredQueueProbe
    ;(window as unknown as { __epochOverrides?: unknown }).__epochOverrides = {
      refresh: () => refreshOverrides(),
      rows: () => useEpochOverridesStore.getState().rows.map((r) => ({ id: r.id, entityId: r.entityId, path: r.path })),
      checked: () => [...useEpochOverridesStore.getState().checked],
      pulled: () => [...useEpochOverridesStore.getState().pulled],
      lastBatch: () => useEpochOverridesStore.getState().lastBatch,
      actorIds: () => [...localActorIds],
      changesWithBatch: (batchId: string) => changesWithMessage((message) => isReapplyMessage(message, batchId)),
    }
  }
  started = true
  // G4-16l: the session's owner of the resident debt, until `stopBridge`. A
  // driver a failed boot left running (no stop in between) ends here; its
  // session token would refuse it anyway.
  residentDebtDriver?.stop()
  residentDebtDriver = createResidentDebtDriver({
    owed: () => residentPendingWrites.size > 0,
    attempt: attemptResidentDebtWrite,
    onLifecycle: flushPendingWritesForLifecycle,
    // Taken now (this session's `durableAckEpoch`), compared at every attempt.
    sessionToken: () => durableAckEpoch,
  })
  // Every local edit of this boot is seen, and written if the page goes
  // away before the boot ends. Taken back only by this boot, past its
  // `superseded()` check.
  watchBootEdits()
  watchBootLifecycle()
  currentRef = ref
  serverProjectionRequestSequence = 0
  lastAppliedServerProjectionRequest = 0
  activeDocumentShare.beginSession(workspaceRefKey(ref))
  const durableHydration = hydrateDurableLedger(durableAckEpoch, ledgerStore).catch((error) => {
    console.warn('pending PostgreSQL durability ledger hydration failed', error)
  })
  lastServerProjectionGeneration = -1
  const status = useAutomergeStatus.getState()
  status.setStatus('connecting')
  const finishBoot = startClientTimelineMeasure('workspace.boot.total')
  sentReleaseInFlight = false
  // BEFORE the route: the ledger's documents are withheld by the hydration and
  // must be before any socket of this session can hand them to the server (see
  // `hydrateDurableLedger`). The read used to overlap the route.
  await durableHydration
  // The overlay rescues an earlier session left.
  void hydrateOverlayRescues(durableAckEpoch, ledgerStore)
  // A superseded boot must not route: the transport is module state, and the
  // live boot may still be reading ITS ledger, with nothing withheld yet
  // (found 2026-10-31).
  if (superseded()) return
  // A root handle can remain cached after visiting this workspace, while the
  // single Repo transport has since been routed to another workspace. Resolving
  // that cached handle does not call getRootHandle's cache-miss route setup, so
  // every subsequent lazy find (notably the active DiagramDoc) would be sent to
  // the stale workspace socket and wait forever. Reassert the requested route on
  // every bridge session; WorkspaceNetworkRouter makes the same-route case a
  // cheap no-op and preserves warm/offline document caches.
  await routeWorkspaceNetwork(currentRef)
  // Minted-id supply: fire-and-forget, entirely off the boot path — its
  // hydration and top-up run in the background and creations fall back to
  // random ids until it is warm.
  startMintedIdSupply(currentRef)
  // (The ledger's documents are re-presented by `partitionDurableLedger`,
  // once the root resolution below has named this session's workspace.)
  const requestedAtStart = useModelStore.getState().currentDiagramId
  const preparedInitial: PreparedDiagramOpen = {}
  // Start the tiny crash-recovery journal beside root/render work; only the
  // first projection awaits it, so IndexedDB never serializes the boot path.
  placementIntentsHydrated = false
  const placementHydrationEpoch = durableAckEpoch
  const placementHydration = hydratePlacementIntents(workspaceKvStore(), workspaceRefKey(ref))
    .then(() => {
      if (placementHydrationEpoch !== durableAckEpoch) return
      placementIntentsHydrated = true
      scheduleDurableAcknowledgement(0)
    })
    .catch((error) => {
      // The debt stays: a stuck "saving" over an unreadable placement journal
      // beats a "Synced" over one (same rule as the entity journal).
      console.warn('pending placement hydration failed', error)
    })
  placementIntentHydration = placementHydration
  const overlayBatchHydration =hydrateOverlayBatchJournal(workspaceKvStore(), workspaceRefKey(ref)).catch((error) => {
    console.warn('pending overlay batch hydration failed', error)
  })
  // Entity-intent crash journal. NEVER awaited by the boot path (only the
  // deferred replay and the badge consume it): a post-crash journal can be
  // large, and the boot budget tolerates no addition. Until it resolves the
  // badge counts the unread journal as a debt rather than assuming it empty;
  // on failure the debt stays — a stuck "saving" over an unreadable crash
  // journal beats a "Synced" over one.
  entityIntentsHydrated = false
  const hydrationEpoch = durableAckEpoch
  entityIntentHydration = hydrateEntityIntents(workspaceKvStore(), workspaceRefKey(ref))
    .then(() => {
      if (hydrationEpoch !== durableAckEpoch) return // a newer session took over
      entityIntentsHydrated = true
      scheduleDurableAcknowledgement(0)
    })
    .catch((error) => {
      console.warn('pending entity intent hydration failed', error)
    })
  // A deep-linked server-boot diagram is known before the Automerge root. Start
  // its independent read-model requests immediately while root/model-meta
  // continue in parallel. DiagramDoc still starts only after sharding is known.
  //
  // NOT on the fallback re-entry. A read issued before the root asks the alias
  // (nothing names this session's documents yet: the cached root's basis is
  // restored by the root resolution below), and on this path the alias is the
  // new default whose graph just failed to arrive. Its render would be
  // projected over the cached root's documents, and its generation would raise
  // `lastServerProjectionGeneration` above the cached version's, so that
  // version's SSE events (which carry a generation) would be ignored by
  // `scheduleLiveSyncRefresh` until an untyped trigger — sync traffic, the 60 s
  // timer — refreshed anyway. The open fetches
  // both after the root instead, when the reads name the cached root's
  // version; the cost is the parallelism, on a boot that has already spent its
  // resolution budget.
  if (requestedAtStart && isBootFromServerEnabled() && !isFallbackReentry) {
    preparedInitial.render = loadDiagramRenderForProjection(requestedAtStart)
    const finishMeta = startClientTimelineMeasure('diagram.meta', { prefetched: true })
    preparedInitial.bootstrap = fetchDiagramMeta(requestedAtStart).then(
      (bootstrap) => {
        finishMeta({ found: Boolean(bootstrap) })
        return bootstrap
      },
      (error: unknown) => {
        finishMeta({ failed: true })
        throw error
      },
    )
    // The pipeline awaits metadata later; observe an early failure during a slow
    // root load now so it is never reported as unhandled.
    void preparedInitial.bootstrap.catch(() => undefined)
  }
  try {
    const finishRoot = startClientTimelineMeasure('workspace.root')
    try {
      rootHandle = await getRootHandle(currentRef)
      activeDocumentShare.pin(rootHandle.documentId, 'root')
      finishRoot()
      // The root resolution has named this session's workspace (the
      // root-fetch or root-cache basis `documentsWorkspaceKey` trusts).
      if (!superseded()) partitionDurableLedger()
    } catch (error) {
      finishRoot({ failed: true })
      throw error
    }
    // Boot-from-server (step 2c) never uses the monolithic ModelDoc — it projects the
    // active diagram from the server render. The monolith is the WHOLE pre-split model
    // (~20k objects) and the server announces it as a "core" doc, so awaiting it here
    // blocks boot ~40s while it syncs, for nothing. Skip it.
    //
    // ALSO skip it when the root itself says the workspace is SHARDED
    // (modelMetaUrl set): a fork of a sharded source (drafts, duplicated versions)
    // has NO monolith at all — forkRoot leaves root.modelUrl empty because the
    // sharded reader ignores it. Awaiting getModelHandle there polls 5s, throws,
    // and the non-default fallback below silently bounces the user to the DEFAULT
    // workspace — the "my draft/duplicate opened the default landscape" bug.
    const rootDocAtBoot = rootHandle.doc()
    if (!rootDocAtBoot) throw new Error('Workspace root is ready but has no document snapshot')
    const workspaceSharded = !!rootDocAtBoot?.modelMetaUrl && isValidAutomergeUrl(rootDocAtBoot.modelMetaUrl)
    // Resolve the per-workspace boot-from-server mode HERE — a monolith workspace
    // always boots classic, whatever the flag says, because the BFS write path
    // (edits overlay) needs a ModelMeta that a monolith doesn't have.
    //
    // The ROOT can require it too, and that half is NOT a flag. A workspace
    // whose root declares `registrySummaryOnly` keeps its baseline in the server
    // read model and its registry on the server; the classic path would resolve
    // every registry shard to build a list the server already has (~78 s /
    // ~22 MB at 10k diagrams) and would then project a store holding only what
    // the client happens to hold. Worse than slow: a sparse draft opened by a
    // client WITHOUT the Vite flags would show ONLY the touched entities,
    // because its baseline lives in `ro_*` where the resident path never looks.
    //
    // Read ONCE, from the root snapshot resolved just above (the root is the
    // client's only source of truth for this — never `read_model_static_*`,
    // which the client does not read). This is a BOOT CONTRACT: every later
    // bridge decision is spelled `bfsActive` / `registrySummaryOnly`, so it must
    // not become reactive state. A promotion arriving mid-session is handled by
    // the epoch guard in `rootChangeHandler` (banner + reload), never by
    // re-deciding here.
    const summaryRootAtBoot = rootDocAtBoot.registrySummaryOnly === true
    // The `&& workspaceSharded` half applies to the ROOT term too, and
    // there it means something different. For the FLAG it is the correct
    // downgrade (a monolith has no ModelMeta, so it boots classic and that is
    // the right answer). For a summary ROOT it is a contradiction: the workspace
    // declares a server-owned registry it has no ModelMeta to boot, and silently
    // falling through here would produce the very classic boot the contract
    // forbids — with `registrySummaryOnly` never set, so the guard further down
    // could never see it either. Refuse at the contract, in one place.
    if (summaryRootAtBoot && !workspaceSharded) {
      throw new SummaryContractBootError(
        `workspace ${ref.landscapeId}/${ref.versionId} declares registrySummaryOnly but its root carries no valid modelMetaUrl; `
        + 'a summary workspace keeps its baseline in the server read model and cannot boot the resident registry',
      )
    }
    bfsActive = (isBootFromServerEnabled() || summaryRootAtBoot) && workspaceSharded
    setRegistrySummaryOnly(bfsActive && summaryRootAtBoot)
    if (registrySummaryOnly && rootDocAtBoot.registryWriteUrl && isValidAutomergeUrl(rootDocAtBoot.registryWriteUrl)) {
      const writeUrl = rootDocAtBoot.registryWriteUrl
      const installWriteHead = (writeHandle: DocHandle<RegistryShard>): void => {
        if (
          !started
          || !workspaceRefEquals(currentRef, ref)
          || rootHandle?.doc()?.registryWriteUrl !== writeUrl
          // The write-head guard may have DOWNGRADED this boot to the full editable
          // registry (registrySummaryOnly flipped false, shardHandles = all
          // shards). A deferred head resolving after that must not shrink
          // shardHandles back to one — projectAll would collapse the diagram
          // list and the next registry flush would re-place every meta.
          || !registrySummaryOnly
        ) return
        // MERGE, never replace: on the deferred path a creation may already
        // have provisioned a session write shard — replacing would drop it from
        // the witness set while its metas keep living there, and every sweep
        // would then falsely retire those diagrams' intents. The session's chosen write head also keeps priority.
        if (!shardHandles.some((handle) => handle.url === writeHandle.url)) {
          shardHandles.push(writeHandle)
        }
        if (!summaryRegistryWriteUrl) summaryRegistryWriteUrl = writeHandle.url
        attachShardListener(writeHandle)
        // The junctions that ran before this install abstained (no resolved
        // write head) with no retry of their own — without this line a
        // wedged journal sits for the whole session on exactly the degraded
        // path.
        scheduleDiagramAbsenceSweep()
      }
      prepareDocumentRequest(writeUrl, 'registry-shard')
      const resolution = await resolveOptionalRegistryWriteHead(
        () => resolveReadyHandleWithRetry<RegistryShard>(
          repo,
          writeUrl as AutomergeUrl,
          { tries: 4, delayMs: 250 },
        ),
      )
      if (resolution.state === 'ready') {
        installWriteHead(resolution.value)
      } else if (resolution.state === 'failed') {
        // The immutable baseline remains usable. A later creation can provision a
        // replacement write head without loading the 30k-entry registry.
        console.warn('summary registry write head is unavailable; continuing with the server registry', resolution.error)
      } else {
        console.warn('summary registry write head is still syncing; continuing workspace boot')
        void resolution.completion.then((settled: Exclude<OptionalRegistryWriteHeadResult<DocHandle<RegistryShard>>, { state: 'deferred' }>) => {
          if (settled.state === 'ready') installWriteHead(settled.value)
          else console.warn('deferred summary registry write head is unavailable', settled.error)
        })
      }
    }
    const skipMonolith = bfsActive || workspaceSharded
    if (!skipMonolith) {
      const finishModel = startClientTimelineMeasure('workspace.model')
      try {
        modelHandle = await getModelHandle(currentRef)
        activeDocumentShare.pin(modelHandle.documentId, 'model')
        finishModel()
      } catch (error) {
        finishModel({ failed: true })
        throw error
      }
    }

    // Ordinary workspaces load the full editable registry. A pre-materialized
    // benchmark resolves only the requested diagram below, while still opening
    // that diagram's Automerge document so edits remain durable.
    if (!registrySummaryOnly) {
      const finishRegistry = startClientTimelineMeasure('workspace.registry')
      try {
        shardHandles = await getRegistryShardHandles(currentRef)
        finishRegistry({ shards: shardHandles.length })
      } catch (error) {
        finishRegistry({ failed: true })
        throw error
      }
      for (const handle of shardHandles) attachShardListener(handle)
    }
    // Registry shards this browser created whose root pointer is still held
    // back — on BOTH registry paths (full and summary), before the first
    // projection so the author's own diagrams are in it.
    await resumeDeferredRegistryShardReferences(rootHandle)

    // Yield one macrotask so React paints the loading gate BEFORE the first
    // projection. The handle awaits above resolve as microtasks (no paint), so
    // without this the synchronous materialization + projectAll below would run
    // before any frame is drawn and the user would stare at a blank screen.
    await new Promise((resolve) => setTimeout(resolve, 0))
    // A boot superseded during the awaits above stops before it shards the
    // model (`modelMetaHandle`, the shard handles and their listeners are the
    // next session's to set).
    if (superseded()) {
      finishBoot({ superseded: true })
      return
    }

    // The demo of a fresh install is written by the SERVER into the default
    // workspace before it publishes the root (server/src/demoSeed.ts). A browser
    // seed reached the server one document at a time, and a tab closed mid-way
    // left every other client a partial demo.

    // When model sharding is enabled, resolve the sharded model — loading
    // existing shards. An unsharded monolith stays one: splitting it is server
    // maintenance (see ensureModelSharded). Falls back to the monolith on any failure.
    // An ALREADY-sharded workspace is self-describing (root.modelMetaUrl): load its
    // shards regardless of the local flag — it may have no monolith to fall back to
    // (forks), and the flag only governs whether an UNsharded workspace gets split.
    if (isModelShardingEnabled() || workspaceSharded) {
      const finishSharding = startClientTimelineMeasure('workspace.sharding')
      try {
        sharded = await ensureModelSharded()
        finishSharding({ sharded })
      } catch (e) {
        finishSharding({ failed: true })
        // Bounded unavailability (the ModelMeta never materialized) is a
        // WORKSPACE-level condition: rethrow so the boot fallback below can
        // re-enter from the last materialized root. Absorbing it into
        // `sharded = false` would "boot" a resident projection whose model
        // documents were never loaded — an empty store that reports ready,
        // the silent-failure class.
        if (isRetryableDocumentResolutionError(e)) throw e
        console.error('model sharding init failed; using monolithic model', e)
        sharded = false
      }
    }

    // Boot-from-server (step 2c): the model shards were NOT loaded (ensureModelSharded
    // skipped them). Build the diagram registry index from the registry shards and
    // project the diagram list + small collections; the active diagram's
    // objects/connections come from the server render via switchActiveDiagram below.
    // If sharding init FAILED, drop out of BFS entirely so the write path stays
    // consistent with the projection path (no overlay without a meta doc).
    // A summary root reaching here without a resolved ModelMeta has nowhere left
    // to go. Downgrading (`setRegistrySummaryOnly(false)` and re-materializing
    // the whole editable registry) would be three failures in one: the full
    // registry load back on the boot path, a resident tier reading a store
    // whose model shards were never loaded, and — worst — `flushWrite` bailing
    // at its `!modelHandle` guard, so the durable ack sees "nothing tracked" and
    // the badge reads "Synced" over a session that can save nothing. There is
    // no `bfs-degraded` to fall into either: that mode IS the ModelMeta. So the
    // honest outcome is an explicit boot failure that names the cause.
    //
    // Reachability: `registrySummaryOnly` is only ever set true when
    // `summaryRootAtBoot` is true, so `!bfsActive && registrySummaryOnly` IS
    // "summary root, boot-from-server refused". `ensureModelSharded`'s write-head guard
    // already keeps a summary root out of `resident-fallback`, which leaves
    // exactly one cause: `sharded` came back false (no meta snapshot, or a
    // non-retryable sharding failure absorbed just above).
    if (!sharded && registrySummaryOnly) {
      throw new SummaryContractBootError(
        `workspace ${ref.landscapeId}/${ref.versionId} declares registrySummaryOnly but its ModelMeta never resolved; `
        + 'refusing to downgrade to the resident registry — the baseline lives in the server read model and the base '
        + 'shards are fenced for writes, so that boot would be slow, truncated and unwritable',
      )
    }
    if (!sharded) bfsActive = false
    const bootFromServer = bfsActive
    await Promise.all([placementHydration, overlayBatchHydration])
    // …and before it projects the store or opens a diagram for that session.
    if (superseded()) {
      finishBoot({ superseded: true })
      return
    }
    if (bootFromServer) {
      if (registrySummaryOnly) {
        let requestedId = await takeParkedInitialDiagram(
          useModelStore.getState().currentDiagramId,
          async (id) => {
            if (tombstoneDiagrams.has(id)) return false
            if (summaryRegistryMetas().some((diagram) => diagram.id === id)) return true
            // Share the answer with the open below (it reuses preparedInitial).
            if (id === requestedAtStart && !preparedInitial.bootstrap) {
              preparedInitial.bootstrap = fetchDiagramMeta(id)
              void preparedInitial.bootstrap.catch(() => undefined)
            }
            try {
              return Boolean(await (id === requestedAtStart ? preparedInitial.bootstrap : fetchDiagramMeta(id)))
            } catch {
              // Unknown counts as absent for a PREFERENCE: keeping the park
              // would make the open below await this rejected request outside
              // any try and fail the whole boot (offline, or a draft's
              // retryable 503 while the repository warms up). Forget the
              // failed prefetch too, so the default pick takes exactly the
              // pre-preference path.
              if (id === requestedAtStart) preparedInitial.bootstrap = undefined
              return false
            }
          },
        )
        try {
          requestedId = await resolveSummaryRegistryInitialDiagram(
            requestedId,
            // Ask for a few, not one: the first entries can all be tombstoned
            // and the filter needs something left to choose from.
            async () => fetchDiagramListPage({ limit: 8 }),
            // `tombstoneDiagrams` is already hydrated from ModelMeta by
            // `ensureModelSharded` at this point — the deletion is durable long
            // before the server page stops listing it.
            (id) => tombstoneDiagrams.has(id),
          )
        } catch (error) {
          requestedId = summaryRegistryMetas()[0]?.id ?? null
          console.warn('summary registry initial diagram lookup failed; using the local write window', error)
        }
        if (requestedId && useModelStore.getState().currentDiagramId !== requestedId) {
          withRemote(() => useModelStore.setState({ currentDiagramId: requestedId }))
        }
        const localMeta = requestedId
          ? summaryRegistryMetas().find((diagram) => diagram.id === requestedId)
          : undefined
        const requested = requestedId && !localMeta
          ? await (requestedId === requestedAtStart && preparedInitial.bootstrap
              ? preparedInitial.bootstrap
              : fetchDiagramMeta(requestedId))
          : undefined
        if (requested) {
          serverRegistryDiagrams = [requested.meta]
          serverDiagramBootstraps.set(requested.meta.id, requested)
        }
      }
      rebuildRegistryIndex()
      // The bounded server render is enough for the first paint. Persistent
      // object/connection edits are overlaid just after that paint; awaiting a
      // large overlay here made the connection gate absorb several seconds.
      await projectActiveFromServer(null)
    } else {
      withRemote(projectAll)
    }

    // Open a diagram by default (currentDiagramId is local-only). The registry is keyed by
    // Automerge map (so diagrams are SORTED by id, not insertion order); a freshly-created
    // blank diagram can sort first and become diagrams[0]. Prefer the first diagram that
    // actually has content so a fresh boot never lands the user (or a test) in an empty canvas.
    const initialDiagrams = useModelStore.getState().diagrams
    const parkedAtChoice = useModelStore.getState().currentDiagramId
    // A PREFERENCE (a Draft transition keeping the viewed diagram) is judged
    // against the booted version's loaded REGISTRY, never this store list:
    // under boot-from-server the list is not projected yet here, and reading
    // its emptiness as "absent" is the 2026-10-17 empty-canvas defect. A deep
    // link keeps its request; a summary workspace has no loaded registry and
    // made its choice above (where the preference was consumed).
    const prefersParked = !registrySummaryOnly
      && parkedAtChoice !== null
      && parkedAtChoice === preferredInitialDiagramId
    let parked: string | null
    let awaitingRegistryVerdict = false
    if (prefersParked && loadedRegistryMetas().some((meta) => meta.id === parkedAtChoice)) {
      preferredInitialDiagramId = null
      parked = parkedAtChoice
    } else if (prefersParked) {
      preferredInitialDiagramId = null
      // Unparked while the registry copy's currency is checked: a current
      // diagram this version may not have would put the not-found overlay up.
      withRemote(() => useModelStore.setState({ currentDiagramId: null }))
      armRegistryConfirmedPick(parkedAtChoice)
      awaitingRegistryVerdict = true
      parked = null
    } else {
      parked = await takeParkedInitialDiagram(
        parkedAtChoice,
        (id) => initialDiagrams.some((d) => d.id === id),
      )
      if (superseded()) {
        finishBoot({ superseded: true })
        return
      }
    }
    // While the registry verdict is out, open nothing: taking the default pick
    // here (the store is populated on a resident boot) is exactly losing the
    // user's place.
    const initial = awaitingRegistryVerdict
      ? null
      : parked ??
        (initialDiagrams.find((d) => d.objectIds.length > 0) ?? initialDiagrams[0])?.id ??
        null
    if (initial) {
      if (useModelStore.getState().currentDiagramId !== initial) {
        withRemote(() => useModelStore.setState({ currentDiagramId: initial }))
      }
      await switchActiveDiagram(
        initial,
        initial === requestedAtStart ? preparedInitial : {},
      )
    } else {
      status.markEditReady()
    }

    // A boot superseded while it awaited the active diagram stops HERE.
    // Everything below installs module state the boot that replaced it owns —
    // the store subscription, the root and model listeners, the write-guard
    // baselines, and the boot-edit watch whose window holds the user's edits
    // made since.
    if (superseded()) {
      finishBoot({ superseded: true })
      return
    }

    // Non-BFS boots drain the crash journal through the RESIDENT write path
    // (P1bis): intents captured under an earlier boot-from-server session of
    // this workspace cannot drain through an overlay flush that a resident
    // session never runs. Runs at boot, before any new edit, so a stale BFS
    // intent can never be replayed OVER a newer resident edit made this
    // session. Fire-and-forget: it awaits journal hydration itself.
    if (!bootFromServer) void maybeReplayEntityIntentsResident()

    rootChangeHandler = () => {
      // G4-16f, hop step 1: a repointed `modelMetaUrl` starts the live hop,
      // under every contract (summary roots included).
      maybeStartEpochHop()
      if (registrySummaryOnly) {
        scheduleLiveSyncRefresh()
        return
      }
      // EPOCH GUARD. The workspace was PROMOTED to the summary contract
      // while this classic session is live — an operator ran the promotion, or
      // this tab was open on a second one that did.
      //
      // There is no hot re-switch, deliberately. Every piece of this session's
      // state is built on the boot contract: `shardHandles` holds the full
      // editable registry, the write-guard baselines were partitioned against
      // base shards, the entity-intent capture is gated `bfsActive` and so has
      // journaled NOTHING, and the projection path reads the resident store.
      // Flipping the contract under all of that produces a session whose halves
      // disagree — and the disagreeing half writes.
      //
      // So: latch, and ask for a reload. Precisely what THIS return buys:
      // `syncShardHandles()` + `projectAll` is a PROJECTION — it reads the
      // shards into the store. Stopping it keeps the store from being churned
      // by a registry the server is mid-way through taking over, and that is
      // all. The verb that WRITES is `flushWrite`, whose registry pass
      // (`desiredMetas` + `planRegistryWrites` + the place/reconcile loops) is
      // what re-places every diagram meta into shards the server has just
      // fenced; it reads the same latch and freezes for the same reason.
      // The server's baseline write fence is the belt; the latch is the braces,
      // and it is also the only half that can tell the USER anything.
      if (rootHandle?.doc()?.registrySummaryOnly === true) {
        if (!workspaceContractStale) {
          workspaceContractStale = true
          markClientTimeline('workspace.contract.promoted', { from: 'classic' })
          console.warn(
            'this workspace was promoted to a server-registry (summary) contract while the session was live; '
            + 'reload to boot on the new contract — this tab no longer reconciles the registry',
          )
          useAutomergeStatus.getState().markWorkspaceContractStale()
        }
        return
      }
      // shardUrls may have grown (new shard created by another peer or this tab).
      void syncShardHandles().then(() => withRemote(projectAll))
    }
    rootHandle.on('change', rootChangeHandler)

    // When sharded the monolith is a frozen pre-split snapshot we never write, so
    // don't project from it; the meta + shard listeners (attached in
    // ensureModelSharded) drive projection instead. (modelHandle is also null under
    // boot-from-server, which is always sharded, so this branch never runs there.)
    if (!sharded && modelHandle) {
      modelChangeHandler = () => withRemote(projectAll)
      modelHandle.on('change', modelChangeHandler)
    }

    // The store now mirrors the docs (just projected), so the first store change
    // (a selection, the deferred roll-up, …) would otherwise schedule a no-op
    // O(model) reconcile (~12s at 15k). Seed the write-guard baseline so the first
    // flushWrite skips; real edits diverge it and still persist. An edit made
    // while the boot ran is NOT in the baseline — it is seeded from the state
    // before it, and written just below. "Before it" is per ENTITY — the store
    // now with only the window's local edits put back — so a remote projection
    // that landed after her first edit is a baseline, never replayed as hers.
    const bootEdits = stopWatchingBootEdits()
    const bootEdited = bootEdits ? bootEdits.base(useModelStore.getState()) : null
    {
      const s0 = bootEdited ?? useModelStore.getState()
      // Per-shard baselines skipped under boot-from-server (base shards are
      // not loaded; edits go to bounded overlays and the active diagram
      // document instead).
      seedWriteBaselines(s0, sharded && !bootFromServer)
      // These ARE the boot's baselines — a later boot write (the failed boot's,
      // below) must never re-seed them from a store that already holds an
      // unwritten edit.
      bootBaselinesSeeded = true
      // G4-16l: from here the debt is the flush's to write — set with the
      // baselines, not at the subscription below, so a throw in between does
      // not leave a 'boot' writer whose window base is gone.
      residentDebtWriter = 'session'
      // The small-collection capture baselines, seeded from the SAME
      // just-projected state, for the same reason as lastModelSlices — and
      // for a sharper one: before the first seed the diff treats
      // every projected group/domain/tag/ADR as a CREATED entity on the first
      // user tick, journaling the whole collection with `baseline: undefined`
      // — whose replay is a whole-value clobber over any colleague edit.
      if (bfsActive) {
        smallCapture.seed({
          group: s0.groups, domain: s0.domains, tagSnapshot: s0.tags, decisionRecord: s0.decisionRecords,
        })
        // Same rationale for the diagram-scoped families.
        diagramCapture.seed({ comment: s0.comments, flow: s0.flows })
        stubCapture.seed(s0.diagrams)
      }
    }

    storeUnsub = useModelStore.subscribe(onStoreChange)
    // The edits made during the boot, as one store change: noted, scheduled,
    // written like any other.
    if (bootEdited) onStoreChange(useModelStore.getState(), bootEdited)
    // Held pointers on metas only the network can name — after
    // the first render, in the background.
    if (pendingSetAside) void resumeSetAsideModelShards()
    // The batch re-apply — the actors this profile wrote with first,
    // then the override rows for them (on boot, after a hop, periodically).
    // Only on a workspace with epochs, and for THIS session (a switch during
    // the read must not install the old one's).
    const overridesSession = durableAckEpoch
    void hydrateLocalActors().then(() => {
      if (!started || overridesSession !== durableAckEpoch) return
      overridesReady = true
      if (epochCapability && !uninstallEpochOverrides) uninstallEpochOverrides = installEpochOverridePorts()
      void probeEpochCapability()
    })
    if (activeDiagramId && pendingPlacementIntents.hasPending(workspaceRefKey(currentRef), activeDiagramId)) {
      scheduleWrite('placement')
    }
    // Placements journaled for OTHER diagrams drain in the
    // background (bounded per-doc resolution; deadline-guarded, so an
    // offline boot simply leaves them for reconnect).
    if (pendingPlacementIntents.hasPending(workspaceRefKey(currentRef))) {
      void placementHydration.then(() => { void drainOffActivePlacementIntents() })
    }

    // Fresh-on-load: don't lift the boot loader onto a STALE local layout. When
    // boot-from-server and online, hold (bounded) until the active diagram doc has
    // caught up to the server, so the first visible frame is the latest layout
    // instead of the on-disk copy snapping ~1-2s later. No-op / immediate unless
    // actually behind (see awaitActiveDiagramFresh).
    if (activeDiagramId) {
      const finishFreshness = startClientTimelineMeasure('diagram.freshness')
      try {
        await awaitActiveDiagramFresh(activeDiagramId)
        finishFreshness()
      } catch (error) {
        finishFreshness({ failed: true })
        throw error
      }
    }

    // A superseded boot that got this far stops here: the tail below wires the
    // session's listeners and its repoint handler — which takes the binding
    // frame kept for it, judged against whatever basis that moment holds — and
    // publishes the fallback marker the handler reads. All of that belongs to
    // the boot that owns the session now.
    if (superseded()) {
      finishBoot({ superseded: true })
      return
    }
    // Asserted connected because the status listeners are wired only below, so a
    // socket that connected DURING boot was never heard — unless this boot already
    // learned the opposite: a render fetch that could not reach the server
    // (`serverUnreachable`, reset by `startBridge`).
    setDurableConnectionState(!serverUnreachable)
    // Published from HERE — after the documents are attached, the store projected and
    // `useModelStore.subscribe(onStoreChange)` wired — because that is the first
    // instant at which a write into the store reaches this workspace's documents.
    // Guarded on the session still being the one that started: the fallback path below
    // re-enters startBridge on a DIFFERENT ref, and a waiter for the requested ref must
    // never be satisfied by the workspace it fell back to.
    if (started && workspaceRefEquals(currentRef, ref)) {
      useAutomergeStatus.getState().markWorkspaceProjected(workspaceRefKey(ref))
    }
    const shareSnapshot = activeDocumentShare.snapshot()
    markClientTimeline('workspace.ready', {
      serverBoot: bootFromServer,
      registrySummaryOnly,
      residentDocuments: shareSnapshot.documents,
      documentLeases: shareSnapshot.leases,
    })
    // A completed boot re-arms the cached-root fallback for later sessions of
    // this (or any) workspace — and tells the UI whether THIS session is the
    // local-cache detour (the sync badge surfaces it as a title detail). Nothing is persisted, so the next
    // reload retries the server and the marker resets with the page.
    useAutomergeStatus.getState().setBootFallbackActive(
      bootCachedRootFallbackKey === workspaceRefKey(ref),
    )
    bootCachedRootFallbackKey = null
    finishBoot({ serverBoot: bootFromServer, registrySummaryOnly })
    // DEV: expose ms from page-load to first "ready" so a boot probe can read the
    // exact boot time (the bridge finishes too fast to catch from outside).
    // `typeof window` too: `performance` exists under Node (vitest), where the
    // bare `window` write would THROW inside this try and re-enter the catch
    // as a phantom boot failure.
    if (import.meta.env.DEV && typeof window !== 'undefined' && typeof performance !== 'undefined') {
      ;(window as unknown as { __bootReadyMs?: number }).__bootReadyMs = Math.round(performance.now())
    }
    wireConnectionStatus()
    if (bootFromServer) scheduleOverlayHydration()

    // Boot-from-server painted the active diagram only. Now make the local index the
    // COMPLETE read model in the background (resilient: warm → server → shards), so
    // the global tables show the whole model — and keep working offline — once it's
    // ready. Off the critical path; the bridge is already 'ready'.
    // A complete Worker cache is downloaded only through the explicit,
    // quota-checked "Available offline" action. Never assemble the whole model
    // automatically after boot.
  } catch (err) {
    finishBoot({ failed: true })
    if (superseded()) {
      // A stop, or a newer start, took over while this boot was awaiting.
      // Every step below acts on the module state, i.e. on THAT session —
      // clearing `started`, ending its document share, falling back,
      // rebounding, reporting 'error' — so none of it is this boot's to do.
      // The rebounds await before they act, hence the checks again below.
      console.warn('Automerge bridge: a superseded boot failed; the current session recovers on its own', err)
      return
    }
    started = false
    activeDocumentShare.endSession()
    // A failed boot leaves no boot-edit watch behind (this boot is not
    // superseded: checked just above). An edit made in the window before
    // the failure is WRITTEN first. (Until G4-16l the cleanup
    // also cancelled the window's retry and removed the only `pagehide`
    // listener; both are the session driver's now, and stay.)
    // Only while the window is still open.
    // Past the subscription the edit is the flush's to write (it reads
    // `workspaceContractStale`; this path does not), and a write here would
    // seed its baselines from the store holding that edit, i.e. erase it.
    // G4-16l, case 3: through a write that never throws — a throw there used
    // to skip everything below and leave the loader on "connecting". What it
    // could not write (refused, or failed) stays owed and is the session
    // driver's: the window closes, the driver and its `pagehide` listener do
    // not (case 1).
    tryWriteBootDebt()
    stopWatchingBootEdits()
    if (residentPendingWrites.size > 0) residentDebtDriver?.arm()
    // A CONTRACT failure is terminal AND local. Every recovery
    // below — the cached-root re-entry and both rebounds — answers the question
    // "can this REFERENCE resolve?", and here it can: the root resolved, was
    // read, and said `registrySummaryOnly`. Letting those run would trade an
    // honest error for a silent move to a different landscape. Report and stop.
    if (err instanceof SummaryContractBootError) {
      // Retract the contract from the READ tier before reporting. The
      // meta-less case publishes it at the boot decision and only fails
      // afterwards, so returning here without this would leave
      // `getModelQuery()` pointed at `ro_*` for a workspace that never booted —
      // half a switch, which is the disease `setRegistrySummaryOnly` exists to
      // prevent.
      setRegistrySummaryOnly(false)
      console.error('Automerge bridge failed to start:', err)
      useAutomergeStatus.getState().setStatus('error', err.message)
      return
    }
    // Bounded document unavailability: after a set-default
    // repoint, the server can answer the root-url fetch instantly while its
    // sync layer — still warming up, the same window in which the read model
    // answers 503 — leaves every document request for the new graph
    // unanswered. The resolution ceilings above turn that from a forever-hang
    // into THIS retryable failure; the recovery is the same resident/IndexedDB
    // path a connection-failure boot takes — re-enter once from the last
    // locally MATERIALIZED root, so the user gets their local content instead
    // of an empty store. Nothing is persisted about the detour: the next
    // reload asks the server again and normal service resumes when it answers.
    {
      const refKey = workspaceRefKey(ref)
      if (shouldFallBackToCachedRoot({
        error: err,
        cachedRootUrl: cachedRootUrlFor(ref),
        attemptedRootUrl: lastAttemptedRootUrlFor(ref),
        alreadyFellBack: bootCachedRootFallbackKey === refKey,
      })) {
        console.warn(
          `Automerge bridge: workspace ${ref.landscapeId}/${ref.versionId} did not materialize from the server in time — ` +
            're-entering the boot from the last locally materialized root (offline path); the next reload retries the server',
          err
        )
        // The version whose root just failed: the root fetch's own basis for
        // the root it attempted, read before the re-entry restores the cached
        // root's basis over it. Null when the server reported no key.
        bootFallbackFailedVersionId = documentsWorkspaceFor(ref, lastAttemptedRootUrlFor(ref))?.versionId ?? null
        forgetWorkspaceHandles(ref)
        stopBridge()
        bootCachedRootFallbackKey = refKey
        preferCachedRootForNextResolve(ref)
        bootFallbackReentryPending = true
        return startBridge(ref)
      }
    }
    // T-DIAGDEF-2 (B): the root request got NO answer and nothing local could
    // stand in (`fetchRootUrl` already tried the cached root). That says
    // nothing about the REFERENCE, so neither rebound below applies — and both
    // would ask the same unreachable server again, with requests of no bound
    // of their own: behind a server that accepts and never answers, the
    // auth-on rebound's `listLandscapes` held the switch for good (measured:
    // still loading 90 s after the click, `e2e/boot/workspace-switch-server-
    // down.spec.ts`). An honest error, with its cause, ends the boot.
    if (err instanceof WorkspaceRootUnreachableError) {
      if (isFallbackReentry) {
        abandonPreferredCachedRoot(ref)
        forgetWorkspaceHandles(ref)
      }
      console.error('Automerge bridge failed to start:', err)
      useAutomergeStatus.getState().setStatus('error', err.message, 'server-unreachable')
      return
    }
    // A persisted/pinned ref can point at a version or draft whose root document no
    // longer exists — a draft merged or deleted on another device, or (in dev) a
    // reseed that wiped it out from under a browser still holding the ref. Don't brick
    // boot on a dangling ref: fall back and retry once.
    //
    // BOTH rebounds are gated on the failure being NON-retryable: they exist
    // for references that can NEVER resolve, and a transient stall (server
    // warming up past the ~21s resolution budget) must not fall into them —
    // under AUTH=off that would destroy the persisted offline root url and
    // silently open the DEFAULT landscape; under AUTH=on it would silently
    // bounce a cold deep-link onto the persisted ref. A retryable failure that was refused the cached
    // fallback above must end in an honest 'error', never a workspace change.
    //
    // AUTHENTICATED sessions must NOT fall back to the hardcoded
    // `default/current` — with org-scoped landscapes that's the Default Org's
    // workspace, i.e. a FOREIGN one that 403s at stage 'on'. Re-resolve
    // through bootRef (org default landscape / first in the registry) instead,
    // and only retry when it resolved somewhere new (no infinite loop).
    if (!isRetryableDocumentResolutionError(err)) {
      const { useAuthStore } = await import('../../stores/authStore')
      if (superseded()) return
      const authState = useAuthStore.getState()
      if (authState.config && authState.config.stage !== 'off' && authState.user) {
        const { resolveBootWorkspaceRef } = await import('./bootRef')
        // The REQUESTED ref rides along as the deep-link preference: a still-valid requested workspace resolves to ITSELF — so the
        // rebound below does not fire and the failure surfaces honestly —
        // while a truly dangling/forbidden ref falls through to the org
        // fallback exactly as before.
        const fallbackRef = await resolveBootWorkspaceRef(authState.orgId, ref)
        if (superseded()) return
        if (!workspaceRefEquals(fallbackRef, ref)) {
          console.warn(
            `Automerge bridge: workspace ${ref.landscapeId}/${ref.versionId} is unavailable — ` +
              `falling back to ${fallbackRef.landscapeId}/${fallbackRef.versionId}`,
            err
          )
          // Imported BEFORE the stop below, so no await separates this boot's
          // own stop from its restart (a check after one would read this very
          // stop as a supersession).
          const { useWorkspaceStore } = await import('../../stores/workspaceStore')
          if (superseded()) return
          // dropPersistedRootUrl: the failure is authoritative (non-retryable),
          // so keeping the dead root's offline url would only let the cached
          // boot fallback resurrect it later.
          forgetWorkspace(ref, { dropPersistedRootUrl: true })
          stopBridge()
          recoverWorkspaceProjection(fallbackRef)
          useWorkspaceStore.setState({ ref: fallbackRef })
          return startBridge(fallbackRef)
        }
      } else if (!isDefaultWorkspaceRef(ref)) {
        // Legacy/AUTH=off path — the default IS the fallback, so only retry for
        // non-default refs (and the retry passes the default, so a genuinely broken
        // default still lands in the error branch below — no infinite loop).
        console.warn(
          `Automerge bridge: workspace ${ref.landscapeId}/${ref.versionId} is unavailable — ` +
            'falling back to the live model',
          err
        )
        // Mirror the fallback into the workspace store so the UI (draft pill, version
        // menu) reflects the live model and doesn't keep polling the dead draft. Dynamic
        // import avoids a static cycle (workspaceStore → switchWorkspace → bridge);
        // imported before the stop, for the reason given above.
        const { useWorkspaceStore } = await import('../../stores/workspaceStore')
        if (superseded()) return
        forgetWorkspace(ref, { dropPersistedRootUrl: true })
        stopBridge()
        recoverWorkspaceProjection(DEFAULT_WORKSPACE_REF)
        useWorkspaceStore.setState({ ref: DEFAULT_WORKSPACE_REF })
        return startBridge(DEFAULT_WORKSPACE_REF)
      }
    }
    // Terminal-error hygiene — for the FALLBACK RE-ENTRY's own failure ONLY.
    // Boots overlap (StrictMode's dev double-mount leaves the first boot's
    // promise chain running beside the second), so this path can belong to a
    // REFUSED TWIN running next to a live re-entry, and module-wide cleanup
    // here is cleanup of SOMEONE ELSE'S session. An unconditional
    // abandonPreferredCachedRoot would let the refused twin disarm the
    // one-shot preference the concurrent re-entry is about to consume — the
    // re-entry would re-fetch the FORK root from the server, stall again, and
    // the one-shot guard would turn the whole recovery into an empty-store
    // 'error'. The handle
    // purge has the same shape one window later: the twin would drop the
    // HEALTHY cached-root promise the re-entry just resolved, sending its
    // getModelHandle back to the server mid-boot. So the re-entry cleans up
    // after itself — the unconsumed preference and its rejected promises —
    // and every other failing boot leaves the shared module state to the
    // session that owns it. An ordinary terminal failure keeps its rejected
    // promise cached: the next in-app
    // switch purges handles itself (loadWorkspace → forgetWorkspace), and a
    // reload starts clean.
    if (isFallbackReentry) {
      abandonPreferredCachedRoot(ref)
      forgetWorkspaceHandles(ref)
    }
    console.error('Automerge bridge failed to start:', err)
    useAutomergeStatus.getState().setStatus('error', err instanceof Error ? err.message : String(err))
  }
}

export function stopBridge(): void {
  // No bridge, no projected workspace. Cleared FIRST so nothing waiting on a specific
  // workspace can be satisfied by a session that is being torn down.
  useAutomergeStatus.getState().clearWorkspaceProjection()
  disarmDeferredInitialPick()
  // Before the lifecycle flush: a latch held now must not pause it.
  stopEpochHop()
  uninstallEpochOverrides?.()
  uninstallEpochOverrides = null
  overridesReady = false
  setEpochCapabilityListener(null)
  persistLocalActorsNow()
  localActorIds.clear()
  // G4-16l: a throw out of this flush (from `writeModelShards`, case 3's fault)
  // used to abort the whole stop — the driver left running, the epoch not
  // bumped, `started` left true so every later `startBridge` returned at once.
  // Logged; the teardown goes on.
  try {
    flushPendingWritesForLifecycle()
  } catch (error) {
    console.error('Automerge bridge: the stop\'s lifecycle flush failed; the session is torn down anyway', error)
  }
  // Pre-existing, made visible: a debt the flush could not write (the store not
  // the projection, a write that threw) is cleared below with the session, and
  // lost.
  if (residentPendingWrites.size > 0) {
    console.warn(`Automerge bridge: ${residentPendingWrites.size} local edit(s) no document holds are dropped with the session`)
  }
  // G4-16l: the debt's driver ends with its session — after the lifecycle
  // flush, before the debt is cleared (its timer and its listener with it).
  residentDebtDriver?.stop()
  residentDebtDriver = null
  residentDebtWriter = null
  // The stop's lifecycle flush wrote the store's local values; the overlay
  // belongs to this session's projections.
  residentPendingWrites.clear()
  stopAbsentReleaseTimer()
  // AFTER the final lifecycle flush, never before: that flush legitimately
  // creates documents that must still be named with the OUTGOING workspace's
  // ids (mintedIdReserve's drainReserve contract).
  stopMintedIdSupply()
  // Before the epoch moves: a session that has read the ledger writes it whole
  // here; after the bump the same call could only add to it.
  queueDurableLedgerPersistence()
  // T-DIAGDEF: what this session still owes its server — the
  // lifecycle flush above has just written into its documents whatever the
  // write debounce held (a not-open diagram's delete, 150 ms) — handed to a
  // workspace switch, which drains it on the OUTGOING transport before routing
  // the socket away (`switchWorkspace.ts`, `workspaceSwitchDrain.ts`).
  stoppedSessionDebt = { ref: currentRef, documents: durableHeads.snapshot() }
  durableAckEpoch += 1
  if (durableAckTimer) clearTimeout(durableAckTimer)
  durableAckTimer = null
  durableAckInFlight = false
  durableAckFollowUp = false
  durableHeads.clear()
  serverDurability.clear()
  // Same lifetime as the ledger it shadows. A new session gets a fresh budget:
  // the per-session cap must not carry a previous workspace's refusals into one
  // that may be perfectly healthy.
  deniedRecovery.clear()
  setSyncTransportConnected(false)
  setLocalDocumentChangeListener(null)
  unwireConnectionStatus()
  cancelDeferredOverlayHydration?.()
  cancelDeferredOverlayHydration = null
  writeScheduler.cancel()
  clearHeldDeletionRetry()
  if (overlayAckTimer) clearTimeout(overlayAckTimer)
  overlayAckTimer = null
  void persistOverlayBatchJournal(workspaceKvStore(), workspaceRefKey(currentRef)).catch((error) => {
    console.warn('pending overlay batch lifecycle persistence failed', error)
  })
  pendingNormalWrite = false
  pendingViewDiagramIds = new Set()
  // The entity-intent journal itself is NOT cleared — surviving teardown is its
  // purpose; the per-workspace keying isolates the next session.
  entityIntentsHydrated = false
  entityIntentHydration = Promise.resolve()
  entityIntentReplaying = false
  entityIntentReplayFollowUp = null
  entityIntentsDegradedReplayed = false
  entityIntentsResidentReplayed = false
  entityIntentResidentFollowUp = false
  smallCollectionReplaying = false
  if (smallCollectionReplayTimer) { clearTimeout(smallCollectionReplayTimer); smallCollectionReplayTimer = null }
  diagramCollectionReplaying = false
  if (diagramCollectionReplayTimer) { clearTimeout(diagramCollectionReplayTimer); diagramCollectionReplayTimer = null }
  diagramStubReplaying = false
  if (diagramStubReplayTimer) { clearTimeout(diagramStubReplayTimer); diagramStubReplayTimer = null }
  carriedCreationIds.clear()
  if (offActiveDrainTimer) { clearTimeout(offActiveDrainTimer); offActiveDrainTimer = null }
  diagramAbsenceSweeping = false
  diagramAbsenceSweepFollowUp = false
  if (diagramAbsenceSweepTimer) { clearTimeout(diagramAbsenceSweepTimer); diagramAbsenceSweepTimer = null }
  summaryRetiredDiagramIds.clear()
  placementIntentsHydrated = false
  pendingDurableDiagramDocs.clear()
  if (storeUnsub) storeUnsub()
  storeUnsub = null
  stopWatchingBootEdits()
  if (rootHandle && rootChangeHandler) rootHandle.off('change', rootChangeHandler)
  rootChangeHandler = null
  if (modelHandle && modelChangeHandler) modelHandle.off('change', modelChangeHandler)
  modelChangeHandler = null
  detachAllShardListeners()
  detachAllModelShardListeners()
  detachAllOverlayChangeListeners()
  shardHandles = []
  setRegistrySummaryOnly(false)
  // BOTH halves of the epoch latch. The module variable is what `flushWrite`
  // and `rootChangeHandler` read; the STORE field is what the banner renders.
  // Leaving the store field set would outlive its session — `AutomergeBridge`
  // stops and re-boots on every change of [config, loading, user, orgId], so an
  // org switch or an auth refresh would leave a phantom banner. Clearing only
  // the store field leaves the reverse hole: the NEXT workspace would inherit
  // an armed latch, so a real promotion there would freeze with no warn and no
  // banner (the dedup `if (!workspaceContractStale)` would already be false).
  workspaceContractStale = false
  useAutomergeStatus.getState().clearWorkspaceContractStale()
  serverRegistryDiagrams = []
  serverDiagramBootstraps.clear()
  summaryRegistryWriteUrl = null
  summaryLocalDiagramIds.clear()
  localDiagramHold.clear()
  scopeEdits.clear()
  shardByDiagramId.clear()
  resetProjectionCache()
  resetModelIndexSync()
  detachActive()
  void switching
  rootHandle = null
  modelHandle = null
  sharded = false
  bfsActive = false
  modelMetaHandle = null
  objectShardHandles = []
  connectionShardHandles = []
  shardIndexByObjectId.clear()
  shardIndexByConnectionId.clear()
  // Edits-overlay state (boot-from-server writes).
  editsObjects.clear()
  editsConnections.clear()
  dirtyObjectIds.clear()
  dirtyConnectionIds.clear()
  overlayObjectIds.clear()
  overlayConnectionIds.clear()
  objectOverlaySegments.clear()
  connectionOverlaySegments.clear()
  effectiveObjectOverlay.clear()
  effectiveConnectionOverlay.clear()
  editsObjectShardHandle = null
  editsConnectionShardHandle = null
  editsObjectSegmentHandles = []
  editsConnectionSegmentHandles = []
  for (const documentId of retiredOverlayHandles.keys()) {
    activeDocumentShare.unpin(documentId, 'edits-overlay-pending')
  }
  retiredOverlayHandles.clear()
  objectOverlayWrites = 0
  connectionOverlayWrites = 0
  overlayResolving = false
  lastWrittenObj.clear()
  lastWrittenConn.clear()
  renderedObjects = new Map()
  renderedConnections = new Map()
  // A group edit staged against the previous workspace/version must not survive
  // the switch and reappear over the new one's groups.
  groupEdits.clear()
  hydratedForEdit.clear()
  hydratedConnForEdit.clear()
  tombstoneObjects.clear()
  tombstoneConnections.clear()
  tombstoneGroups.clear()
  unTombObjects.clear()
  unTombConnections.clear()
  tombstoneDiagrams.clear()
  unTombDiagrams.clear()
  retiredSessionDiagramIds.clear()
  decisionRecordPageBaseline.clear()
  lastSmall = null
  smallCapture.reset()
  diagramCapture.reset()
  stubCapture.reset()
  lastServerProjectionGeneration = -1
  serverProjectionRequestSequence = 0
  lastAppliedServerProjectionRequest = 0
  activeDiagramId = null
  docUrlById.clear()
  unpublishedDiagramDocs.clear()
  withheldMetaWarned.clear()
  activeDocumentShare.endSession()
  started = false
}

// ── DEV load-test seeding ───────────────────────────────────────────────────
// Bulk-insert synthetic objects/connections straight into the ModelDoc (one
// Automerge change → persisted + synced → projected). DEV only. Entities are
// prefixed `lt-` so __clearLoad() can remove them.
//   __seedLoad(15000, 10000)   __seedHubs(5000, 10000)   __clearLoad()
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>
  // When sharded, write seeds THROUGH the store so flushWrite shards them (the
  // monolith is a frozen snapshot the sharded reader ignores). When not sharded,
  // write straight into the monolith ModelDoc (original behavior).
  const seedViaStore = (newObjects: C4Object[], newConnections: Connection[]) => {
    const s = useModelStore.getState()
    // Upsert by id (match the monolith seeder's map semantics) so re-seeding
    // overlapping ids replaces rather than duplicating in the store array.
    const objMap = new Map(s.objects.map((o) => [o.id, o]))
    for (const o of newObjects) objMap.set(o.id, o)
    const connMap = new Map(s.connections.map((c) => [c.id, c]))
    for (const c of newConnections) connMap.set(c.id, c)
    useModelStore.setState({ objects: [...objMap.values()], connections: [...connMap.values()] })
  }
  w.__seedLoad = (nObjects = 15000, nConnections = 10000) => {
    if (!modelHandle) return 'bridge not started yet'
    const t0 = performance.now()
    const newObjects: C4Object[] = []
    const ids: string[] = []
    for (let i = 0; i < nObjects; i++) {
      const id = 'lt-o' + i
      ids.push(id)
      newObjects.push({
        id, type: 'app', name: 'LoadTest ' + i,
        position: { x: (i % 200) * 180, y: Math.floor(i / 200) * 120 },
        size: { width: 160, height: 90 },
        tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
      })
    }
    const newConnections: Connection[] = []
    for (let i = 0; i < nConnections; i++) {
      newConnections.push({
        id: 'lt-c' + i,
        fromId: ids[(Math.random() * ids.length) | 0],
        toId: ids[(Math.random() * ids.length) | 0],
        type: 'solid',
      })
    }
    if (sharded) {
      seedViaStore(newObjects, newConnections)
    } else {
      changeAndTrack(modelHandle, (doc) => {
        for (const o of newObjects) doc.objects[o.id] = o
        for (const c of newConnections) doc.connections[c.id] = c
      })
    }
    return `seeded ${nObjects} objects + ${nConnections} connections in ${Math.round(performance.now() - t0)}ms${sharded ? ' (sharded, via store)' : ''}`
  }
  // Create two HIGH-DEGREE hub shapes ("Hub 5K"/"Hub 10K") with N OUTGOING
  // connections each to distinct existing objects — for stress-testing the
  // Dependencies fan-out. Reuses existing objects as peers (creating extras only
  // if the model is too small). Ids are `lt-o-hub*` / `lt-c-…` so __clearLoad()
  // removes them too.
  w.__seedHubs = (deg5k = 5000, deg10k = 10000) => {
    if (!modelHandle) return 'bridge not started yet'
    const t0 = performance.now()
    // Peers = existing objects that aren't hubs (avoids self-loops).
    const existingIds = sharded
      ? useModelStore.getState().objects.map((o) => o.id)
      : Object.keys(modelHandle.doc()?.objects ?? {})
    const peers = existingIds.filter((id) => !id.startsWith('lt-o-hub'))
    const need = Math.max(deg5k, deg10k)
    const newObjects: C4Object[] = []
    for (let extra = 0; peers.length < need; extra++) {
      const id = 'lt-o-peer' + extra
      newObjects.push({
        id, type: 'app', name: 'Peer ' + extra,
        position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
        tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
      })
      peers.push(id)
    }
    const hubs = [
      { id: 'lt-o-hub5k', name: 'Hub 5K', deg: deg5k },
      { id: 'lt-o-hub10k', name: 'Hub 10K', deg: deg10k },
    ]
    const newConnections: Connection[] = []
    for (const h of hubs) {
      newObjects.push({
        id: h.id, type: 'system', name: h.name,
        position: { x: 0, y: 0 }, size: { width: 200, height: 120 },
        tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
      })
      for (let i = 0; i < h.deg; i++) {
        newConnections.push({ id: 'lt-c-' + h.id + '-' + i, fromId: h.id, toId: peers[i], type: 'solid' })
      }
    }
    if (sharded) {
      seedViaStore(newObjects, newConnections)
    } else {
      changeAndTrack(modelHandle, (doc) => {
        for (const o of newObjects) doc.objects[o.id] = o
        for (const c of newConnections) doc.connections[c.id] = c
      })
    }
    return `seeded "Hub 5K" (${deg5k} outgoing) + "Hub 10K" (${deg10k} outgoing) in ${Math.round(performance.now() - t0)}ms${sharded ? ' (sharded, via store)' : ''}`
  }
  w.__clearLoad = () => {
    if (!modelHandle) return 'bridge not started'
    if (sharded) {
      const s = useModelStore.getState()
      useModelStore.setState({
        objects: s.objects.filter((o) => !o.id.startsWith('lt-o')),
        connections: s.connections.filter((c) => !c.id.startsWith('lt-c')),
      })
    } else {
      changeAndTrack(modelHandle, (doc) => {
        for (const id of Object.keys(doc.objects)) if (id.startsWith('lt-o')) delete doc.objects[id]
        for (const id of Object.keys(doc.connections)) if (id.startsWith('lt-c')) delete doc.connections[id]
      })
    }
    return 'cleared load-test entities'
  }
  // Seed a realistic enterprise workspace (C4 hierarchy + drill-down diagrams,
  // hubs, ADRs, comments, flows, tags, technologies). REPLACES the model in the
  // store; the bridge then persists it (monolith, or per-shard when sharding is on).
  // Seed with sharding OFF then __modelSharding.on() for a clean split, or with
  // sharding ON to write straight to shards.   __seedRich({ objects: 20000, ... })
  w.__seedRich = (opts: RichSeedOptions = {}) => {
    const t0 = performance.now()
    const ws = generateRichWorkspace(opts)
    useModelStore.setState({
      objects: ws.objects,
      connections: ws.connections,
      groups: ws.groups,
      domains: ws.domains,
      tags: ws.tags,
      decisionRecords: ws.decisionRecords,
      diagrams: ws.diagrams,
      comments: ws.comments,
      flows: ws.flows,
      currentDiagramId: ws.diagrams[0]?.id ?? null,
    })
    return (
      `seeded rich workspace: ${ws.objects.length} objects, ${ws.connections.length} connections, ` +
      `${ws.diagrams.length} diagrams, ${ws.decisionRecords.length} ADRs, ${ws.comments.length} comments, ` +
      `${ws.flows.length} flows, ${ws.tags.length} tags in ${Math.round(performance.now() - t0)}ms ` +
      `(sharded=${sharded})`
    )
  }
  // Edit one model object's fields through the store (drives flushWrite) — for
  // measuring write-wall cost (monolith reconcile vs per-shard).
  w.__editObject = (id: string, patch: Partial<C4Object>) => {
    const s = useModelStore.getState()
    const idx = s.objects.findIndex((o) => o.id === id)
    if (idx < 0) return `no object ${id}`
    const next = s.objects.slice()
    next[idx] = { ...next[idx], ...patch }
    useModelStore.setState({ objects: next })
    return `edited ${id}`
  }
  // DEV: expose the Zustand store so a probe can drive ANY model action deterministically
  // (deleteObject/deleteConnection/addGroup/addGroupToDiagram/deleteGroup/updateGroup/…)
  // for validating the boot-from-server write paths end-to-end.
  w.__modelStore = useModelStore
  // DEV: the durability badge and the epoch hop's face (G4-16f e2e probes).
  w.__automergeStatus = useAutomergeStatus
  w.__epochHopStore = useEpochHopStore
  // DEV: the stores the ROUTE layer reads, from the app's own module instance.
  // A probe cannot get at these with `import('/src/stores/…')` from the console —
  // Vite resolves that specifier to a SECOND module instance whose state is all
  // defaults, so `bridgeBooted: false` and `loading: true` read back as facts
  // when they are just an unused copy. That is a false diagnosis waiting to
  // happen; it cost one wrong root cause before this existed.
  w.__routeStores = async () => {
    const [{ useWorkspaceStore }, { useUIStore }, { useAuthStore }] = await Promise.all([
      import('../../stores/workspaceStore'),
      import('../../stores/uiStore'),
      import('../../stores/authStore'),
    ])
    return { workspace: useWorkspaceStore, ui: useUIStore, auth: useAuthStore }
  }
  // E2E probe (repoint-offline-create.spec.ts): map a diagram id from the
  // store to its DiagramDoc url, so the minted-name assertion decodes the id
  // the REGISTRY actually carries — no store shortcut, no length heuristic.
  w.__diagramDocUrl = (id: string) => docUrlById.get(id)
  // DEV: inspect the bridge's delete-tracking + overlay state.
  w.__bridgeDebug = () => ({
    tombObj: [...tombstoneObjects],
    tombConn: [...tombstoneConnections],
    tombDiagram: [...tombstoneDiagrams],
    metaDeletedObj: modelMetaHandle?.doc()?.deletedObjectIds ?? null,
    metaDeletedConn: modelMetaHandle?.doc()?.deletedConnectionIds ?? null,
    metaDeletedDiagram: modelMetaHandle?.doc()?.deletedDiagramIds ?? null,
    metaObjShardCount: readMetaUrls(modelMetaHandle?.doc(), 'objectShardUrls')?.length ?? null,
    metaConnShardCount: readMetaUrls(modelMetaHandle?.doc(), 'connectionShardUrls')?.length ?? null,
    overlayWriteHeadVersion: modelMetaHandle?.doc()?.editsOverlayWriteHeadVersion ?? null,
    objectOverlaySegmentCount: readMetaUrls(modelMetaHandle?.doc(), 'editsObjectShardUrls')?.length ?? 0,
    connectionOverlaySegmentCount: readMetaUrls(modelMetaHandle?.doc(), 'editsConnectionShardUrls')?.length ?? 0,
    resolvedObjectOverlayHeads: editsObjectSegmentHandles.length,
    resolvedConnectionOverlayHeads: editsConnectionSegmentHandles.length,
    editsObj: editsObjects.size,
    editsConn: editsConnections.size,
    dirtyObj: dirtyObjectIds.size,
    dirtyConn: dirtyConnectionIds.size,
    // Pending journal intents per kind — the e2e crash tests' void-run
    // guard for the small-collection families (their "doc write not yet
    // happened" witness is the still-pending intent itself: the value-checked
    // ack in writeSmallCollections removes it the moment the flush expressed it).
    pendingIntentsByKind: pendingEntityIntents.pending(workspaceRefKey(currentRef))
      .reduce<Record<string, number>>((counts, intent) => {
        counts[intent.kind] = (counts[intent.kind] ?? 0) + 1
        return counts
      }, {}),
    // The placement journal is part of the badge sum — expose its count
    // so the e2e void-run guards can read it.
    placementPending: pendingPlacementIntents.pendingCount(workspaceRefKey(currentRef)),
    // The create→flush→publish gate's OBSERVABLE effect, for the e2e: at
    // crash time a just-created diagram's meta must NOT be in any loaded
    // registry shard doc (without this the gate's removal would be
    // timing-invisible to the crash test).
    registryMetaIds: mergeShards(shardHandles.map((h) => h.doc() ?? { diagrams: {} }))
      .map((meta) => meta.id),
    // Which registry/boot mode this session actually runs — e2e and probes
    // must never infer it from list behaviour (server-paged vs resident has
    // TWO possible causes: !canManage or a summary root).
    registrySummaryOnly,
    bfsActive,
    summaryLocalIds: [...summaryLocalDiagramIds],
  })
  // DEV: force ONE re-projection. With no args it re-projects the CURRENT diagram from the server
  // render — the exact operation workspace invalidation triggers (used to assert an off-window
  // edit survives a re-projection). Pass an explicit id (or null) to simulate a STALE/early
  // projection: a regression test calls __projectActive(null) to prove the boot-flicker race — a
  // projection whose diagram is no longer current must NOT clobber the resident store.
  w.__projectActive = (...args: Array<string | null>) => {
    const id = args.length > 0 ? args[0] : useModelStore.getState().currentDiagramId
    return projectActiveFromServer(id ?? null)
  }
  // Model-sharding console controls: __modelSharding.on()/off() toggle the
  // flag + reload; .status() reports the live shard topology.
  w.__modelSharding = {
    on: () => setModelSharding(true),
    off: () => setModelSharding(false),
    status: () => ({
      enabled: isModelShardingEnabled(),
      sharded,
      objectShards: objectShardHandles.length,
      connectionShards: connectionShardHandles.length,
      modelShardSize: MODEL_SHARD_SIZE,
    }),
  }
}
