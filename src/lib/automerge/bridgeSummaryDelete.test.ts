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

/**
 * Deleting a SERVER-OWNED diagram on a summary-only workspace.
 *
 * The failure mode is a total silent no-op: the card menu's Delete calls
 * `deleteDiagram`, which filters a resident array that does not hold the id —
 * and without a tombstone path nothing else happens (no registry write, no
 * journal entry, no warning, no badge movement) and the card stays.
 *
 * These drive the REAL bridge (`bridgeSummaryContract.test.ts`'s pattern:
 * repo-module seams spied, everything else real) with REAL Automerge handles,
 * because what is under test is the write path and its durability witness — a
 * fake handle would let an implementation that never changes the document pass.
 *
 * THE WITNESS RULE these tests hold: a delete intent may only be acknowledged
 * against the ModelMeta FLUSH. Never against `serverRegistryDiagrams` (which
 * `captureSummaryLocalDiagram` and the write pass upsert in memory), never
 * against `summaryRegistryMetas()` which derives from it, never against the
 * resident store — a witness fed by the party it is supposed to convict.
 */

// @vitest-environment jsdom
// jsdom, not node: startBridge's success path wires real window/document
// listeners, and under node the bare `window` access reads as a boot failure.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoModule from './repo'
import { repo } from './repo'
import { DEFAULT_WORKSPACE_REF } from './workspace'
import { OVERLAY_WRITE_HEAD_VERSION } from './overlayWriteHead'
import { useModelStore } from '../../stores/modelStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import type { ModelMeta, RegistryShard, RootDoc } from './types'

/** An in-memory KvStore. It is the crash-journal's DURABLE surface, so the
 * suite reads the journal through it rather than through a module private —
 * what a reload would recover is exactly what a crash would have kept. */
const kv = new Map<string, unknown>()
vi.mock('../modelQuery/kvStore', () => ({
  workspaceKvStore: () => ({
    get: async (key: string) => kv.get(key),
    set: async (key: string, value: unknown) => { kv.set(key, value) },
    del: async (key: string) => { kv.delete(key) },
    update: async (key: string, fn: (value: unknown) => unknown) => {
      kv.set(key, fn(kv.get(key)))
    },
  }),
}))

const mocks = vi.hoisted(() => ({
  fetchDiagramListPage: vi.fn(),
  fetchDiagramMeta: vi.fn(),
  fetchDiagramRender: vi.fn(),
}))
vi.mock('../modelQuery/diagrams', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modelQuery/diagrams')>(),
  fetchDiagramListPage: mocks.fetchDiagramListPage,
}))
vi.mock('../modelQuery/diagramMeta', async (importOriginal) => ({
  ...await importOriginal<typeof import('../modelQuery/diagramMeta')>(),
  fetchDiagramMeta: mocks.fetchDiagramMeta,
}))
// The active-diagram projection would otherwise reach the network on every boot.
// A vi.fn rather than a fixed throw, because ONE test needs to park it: the
// window only goes stale while the re-projection has not landed, and that
// re-projection is a network round trip.
vi.mock("../modelQuery/diagramRender", async (importOriginal) => ({
  ...await importOriginal<typeof import("../modelQuery/diagramRender")>(),
  fetchDiagramRender: mocks.fetchDiagramRender,
}))

const SERVER_OWNED = 'dg-server-owned'

function diagramMeta(id: string, name: string) {
  return { id, name, type: 'container', docUrl: '', objectIds: [], connectionIds: [], groupIds: [] }
}

/** The journalled entity intents as a crash would find them on disk. */
function journaledIntents(): Array<{ kind: string; id: string; op: string }> {
  const out: Array<{ kind: string; id: string; op: string }> = []
  for (const [key, value] of kv) {
    if (!key.includes('entity-intents') || !Array.isArray(value)) continue
    for (const intent of value) out.push(intent as { kind: string; id: string; op: string })
  }
  return out
}

function journaledDiagramDeletes(): string[] {
  return journaledIntents()
    .filter((intent) => intent.kind === 'diagram' && intent.op === 'delete')
    .map((intent) => intent.id)
}

/** A journaled CREATION is an upsert with NO baseline — the same predicate
 * `PendingEntityIntents.pendingCreation` uses, read off the disk image. */
function journaledDiagramCreations(): string[] {
  return journaledIntents()
    .filter((intent) => intent.kind === 'diagram' && intent.op === 'upsert')
    .filter((intent) => (intent as { baseline?: unknown }).baseline === undefined)
    .map((intent) => intent.id)
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The write scheduler's `normal` trailing edge is 150 ms of REAL time. */
async function settleWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
  await settle()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await settle()
}

interface Fixture {
  root: any
  meta: any
  writeHead: any
  registryBase: any
}

/**
 * A summary-only workspace: a server-owned registry, a resident ModelMeta with
 * usable overlay write heads, and one mutable registry write-head shard.
 * `registrySummaryOnly` comes from the ROOT, never from a build flag — a client
 * with no VITE flag at all reaches this contract.
 */
function summaryFixture(options: { summaryOnly?: boolean; deletedDiagramIds?: string[] } = {}): Fixture {
  const objectBase = repo.create<Record<string, unknown>>({ objects: {} })
  const connectionBase = repo.create<Record<string, unknown>>({ connections: {} })
  const objectHead = repo.create<Record<string, unknown>>({ objects: {}, writeHeadVersion: 1 })
  const connectionHead = repo.create<Record<string, unknown>>({ connections: {}, writeHeadVersion: 1 })
  const meta = repo.create<ModelMeta>({
    objectShardUrls: [objectBase.url],
    connectionShardUrls: [connectionBase.url],
    editsOverlayWriteHeadVersion: OVERLAY_WRITE_HEAD_VERSION,
    editsObjectShardUrl: objectHead.url,
    editsConnectionShardUrl: connectionHead.url,
    editsObjectShardUrls: [objectHead.url],
    editsConnectionShardUrls: [connectionHead.url],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    deletedObjectIds: [], deletedConnectionIds: [],
    // Present from the FIRST byte when a fixture asks for it: a workspace whose
    // tombstones were written by a previous session (or by a colleague), which
    // is what a cold boot actually meets.
    ...(options.deletedDiagramIds ? { deletedDiagramIds: options.deletedDiagramIds } : {}),
  } as unknown as ModelMeta)
  const writeHead = repo.create<RegistryShard>({ diagrams: {} } as RegistryShard)
  const registryBase = repo.create<RegistryShard>({ diagrams: {} } as RegistryShard)
  const root = repo.create<RootDoc>({
    modelUrl: '',
    modelMetaUrl: meta.url,
    shardUrls: [registryBase.url],
    registryWriteUrl: writeHead.url,
    ...(options.summaryOnly === false ? {} : { registrySummaryOnly: true }),
  } as unknown as RootDoc)
  return { root, meta, writeHead, registryBase }
}

function wire(fixture: Fixture): void {
  vi.spyOn(repoModule, 'getRootHandle').mockResolvedValue(fixture.root)
  vi.spyOn(repoModule, 'findModelMetaHandle').mockResolvedValue(fixture.meta)
  vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([] as any)
  vi.spyOn(repoModule, 'getModelShardHandles').mockResolvedValue([] as any)
}

describe('T6 — deleting a server-owned diagram under a summary registry', () => {
  beforeEach(async () => {
    kv.clear()
    const { __resetBootCachedRootFallbackForTest } = await import('./bridge')
    __resetBootCachedRootFallbackForTest()
    const { __resetIndexReady } = await import('../modelQuery/offlineIndex')
    __resetIndexReady()
    localStorage.clear()
    vi.clearAllMocks()
    mocks.fetchDiagramRender.mockRejectedValue(new Error('offline in this suite'))
    mocks.fetchDiagramListPage.mockResolvedValue({
      items: [diagramMeta(SERVER_OWNED, 'Owned by the server')],
      nextCursor: null,
      total: 10_000,
    })
    mocks.fetchDiagramMeta.mockResolvedValue({
      meta: diagramMeta(SERVER_OWNED, 'Owned by the server'),
      diagram: {
        id: SERVER_OWNED, name: 'Owned by the server', type: 'container',
        objectIds: [], connectionIds: [], groupIds: [], layouts: {},
      },
      comments: [],
      flows: [],
    })
    useModelStore.setState({
      objects: [], connections: [], groups: [], domains: [], tags: [],
      diagrams: [], comments: [], flows: [], decisionRecords: [],
      currentDiagramId: null, selectedItems: [], workspaceReadOnly: false,
      pendingDeletedObjectIds: [], pendingDeletedConnectionIds: [],
      pendingDeletedGroupIds: [], pendingDeletedDiagramIds: [],
      deletedDiagramIds: [],
    })
    useAutomergeStatus.setState({
      status: 'connecting', ready: false, visualReady: false, editReady: false,
      projectedWorkspace: null, error: null, bootFallbackActive: false,
      workspaceContractStale: false,
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(repoModule, 'routeWorkspaceNetwork').mockResolvedValue(undefined)
    vi.spyOn(repoModule, 'cachedRootUrlFor').mockReturnValue(null)
    vi.spyOn(repoModule, 'lastAttemptedRootUrlFor').mockReturnValue(null)
  })

  afterEach(async () => {
    const { stopBridge } = await import('./bridge')
    stopBridge()
    vi.restoreAllMocks()
    localStorage.clear()
    kv.clear()
  })

  it('écrit un tombstone dans ModelMeta pour un diagramme possédé par le serveur', async () => {
    // The core case. Not calling `writeDiagramTombstones`, sourcing the plan
    // from `summaryLocalDiagramIds` only, or keeping the `desiredMetas` loop as
    // the sole removal path all reproduce the silent no-op: nothing written,
    // nothing said.
    const fixture = summaryFixture()
    wire(fixture)
    const { startBridge, isRegistrySummaryOnlyActive } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(isRegistrySummaryOnlyActive()).toBe(true)

    useModelStore.getState().deleteDiagram(SERVER_OWNED)
    await settleWrites()

    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).toContain(SERVER_OWNED)
  })

  it('journalise la suppression d\'un diagramme serveur dès qu\'un chemin de tombstone existe', async () => {
    // If `canJournal`/`captureExplicitDeletes` refused every id outside
    // `summaryLocalDiagramIds`, an OFFLINE delete would not be journaled at all
    // and would die with the tab.
    //
    // The witness is the KV store, i.e. what a crash would actually recover.
    const fixture = summaryFixture()
    wire(fixture)
    // Never let the meta reach durability, so the intent cannot be acked away
    // before the assertion: the journal entry is what is under test here.
    vi.spyOn(repo, 'flush').mockImplementation(() => new Promise<void>(() => {}))
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)

    useModelStore.getState().deleteDiagram(SERVER_OWNED)
    await settleWrites()

    expect(journaledDiagramDeletes()).toContain(SERVER_OWNED)
  })

  it('n\'acquitte pas l\'intention avant la résolution du flush ModelMeta', async () => {
    // `forgetIntentsOnceDurable(flush → forget → persist)` must not become a
    // direct `acknowledge()`. `handle.change` is synchronous but the storage
    // adapter is debounced, so acknowledging before the flush resolves re-opens
    // the exact crash window the journal exists to close: an intent forgotten
    // while it is durable NOWHERE.
    const fixture = summaryFixture()
    wire(fixture)
    let releaseFlush: (() => void) | null = null
    const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve })
    const realFlush = repo.flush.bind(repo)
    vi.spyOn(repo, 'flush').mockImplementation(async (ids?: any) => {
      await flushGate
      return realFlush(ids)
    })
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)

    useModelStore.getState().deleteDiagram(SERVER_OWNED)
    await settleWrites()

    // The tombstone is IN the document (the change is synchronous)…
    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).toContain(SERVER_OWNED)
    // …and the intent is still journaled, because nothing is durable yet.
    expect(journaledDiagramDeletes()).toContain(SERVER_OWNED)

    releaseFlush!()
    await settleWrites()

    expect(journaledDiagramDeletes()).not.toContain(SERVER_OWNED)
  })

  it('n\'acquitte jamais contre la fenêtre de registre que le client s\'alimente lui-même', async () => {
    // The witness-derives-from-the-claim trap. `serverRegistryDiagrams` is
    // an in-memory memo this very client upserts (`captureSummaryLocalDiagram`,
    // `upsertSummaryRegistryWindow`) and `summaryRegistryMetas()` derives from
    // it, so "the id is gone from the window" is the claim, not the proof.
    //
    // The fixture makes the two disagree: the window no longer lists the
    // diagram (the delete removed it), while the ModelMeta flush never lands.
    // An implementation witnessing the window acknowledges here; the correct
    // one keeps the intent.
    const fixture = summaryFixture()
    wire(fixture)
    vi.spyOn(repo, 'flush').mockImplementation(() => new Promise<void>(() => {}))
    const { startBridge, __summaryRegistryMetasForTest } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(__summaryRegistryMetasForTest().map((meta) => meta.id)).toContain(SERVER_OWNED)

    useModelStore.getState().deleteDiagram(SERVER_OWNED)
    await settleWrites()

    // The claim: the window says the diagram is gone.
    expect(__summaryRegistryMetasForTest().map((meta) => meta.id)).not.toContain(SERVER_OWNED)
    // The proof: nothing is durable, so the intent must survive.
    expect(journaledDiagramDeletes()).toContain(SERVER_OWNED)
  })

  it('laisse le badge sur « Enregistrement… » tant que le serveur n\'a pas acquitté le head', async () => {
    // Reading "no tracked handle / nothing pending" as SUCCESS would make the
    // badge say "Synced" over a deletion that never left the tab.
    const fixture = summaryFixture()
    wire(fixture)
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)

    useModelStore.getState().deleteDiagram(SERVER_OWNED)
    await settleWrites()

    // Nothing acknowledged the ModelMeta head server-side in this suite (there
    // is no peer), so the durable ledger must still be holding it — and it must
    // be holding THAT document. `size > 0` is a global: tracking any other
    // handle than the tombstone's only carrier would satisfy it.
    const { __bridgeDurableHeadDocumentIdsForTest } = await import('./bridge')
    expect(__bridgeDurableHeadDocumentIdsForTest()).toContain(fixture.meta.documentId)
    expect(useAutomergeStatus.getState().status).not.toBe('ready')
  })

  it('retire le diagramme de la fenêtre de registre et publie le tombstone dans le magasin', async () => {
    // The client READ half. Without it the deletion is durable but invisible
    // until the SQL projector catches up — and offline it would never converge
    // at all. The published store field is what re-renders a list the SERVER
    // pages: a module memo would change nothing on screen.
    const fixture = summaryFixture()
    wire(fixture)
    const { startBridge, __summaryRegistryMetasForTest } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(__summaryRegistryMetasForTest().map((meta) => meta.id)).toContain(SERVER_OWNED)

    useModelStore.getState().deleteDiagram(SERVER_OWNED)
    await settleWrites()

    expect(__summaryRegistryMetasForTest().map((meta) => meta.id)).not.toContain(SERVER_OWNED)
    expect(useModelStore.getState().deletedDiagramIds).toContain(SERVER_OWNED)
    expect(useModelStore.getState().diagrams.map((d) => d.id)).not.toContain(SERVER_OWNED)
  })

  it('adopte un tombstone posé par un autre client sans journaliser d\'intention', async () => {
    // The REMOTE half (bridge side). A twin's deletion arrives as a new id
    // in `deletedDiagramIds`; the window must drop it. And nothing may be
    // journaled — a disappearance arriving by the remote path is already the
    // durable expression, so re-expressing it would be an intent with no user
    // behind it.
    const fixture = summaryFixture()
    wire(fixture)
    const { startBridge, __summaryRegistryMetasForTest } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(__summaryRegistryMetasForTest().map((meta) => meta.id)).toContain(SERVER_OWNED)

    // What a remote client's change looks like on this tab.
    fixture.meta.change((meta: any) => {
      meta.deletedDiagramIds = [SERVER_OWNED]
    })
    await settleWrites()

    expect(__summaryRegistryMetasForTest().map((meta) => meta.id)).not.toContain(SERVER_OWNED)
    expect(journaledDiagramDeletes()).not.toContain(SERVER_OWNED)
  })

  it('l\'adoption d\'un tombstone distant DÉCLENCHE le balayage d\'absence', async () => {
    // The other half. `adoptRemoteDiagramTombstones` ends with
    // `scheduleDiagramAbsenceSweep()`; the adoption test above asserts the
    // window and the journal, both of which are identical with the call removed.
    //
    // What the call is for: a comment/flow intent scoped to a diagram a
    // COLLEAGUE deleted has no expression path left at all. `flushWrite` step 3
    // writes only the ACTIVE diagram, and a deleted one can never re-activate;
    // the local delete paths retire dependents through
    // `retireIntentsForDeletedDiagram`, which a remote deletion never calls. So
    // the sweep is the only exit, and the tombstone's arrival is the only event
    // that can prove the absence. Drop the call and the badge reads "Saving…"
    // for the rest of the workspace's life, rehydrated at every boot, over a
    // deletion that succeeded perfectly somewhere else.
    //
    // The fixture starves every OTHER trigger: no registry-shard change (the
    // colleague writes ModelMeta only), no replay junction, and the flush-side
    // stub ack skips server-owned ids by rule, so nothing but adoption can fire
    // the sweep in this window.
    const fixture = summaryFixture()
    wire(fixture)
    // Only the sweep's own witness — the registry write head — reaches durable
    // storage. The comment's carrier (the active DiagramDoc) never does, so
    // nothing except the retirement can clear that intent.
    const realFlush = repo.flush.bind(repo)
    vi.spyOn(repo, 'flush').mockImplementation((ids?: any) => {
      if (Array.isArray(ids) && ids.every((id: string) => id === fixture.writeHead.documentId)) {
        return realFlush(ids)
      }
      return new Promise<void>(() => {})
    })
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(useModelStore.getState().currentDiagramId).toBe(SERVER_OWNED)

    useModelStore.setState({
      comments: [{ id: 'cmt-remote', diagramId: SERVER_OWNED, text: 'Une remarque', x: 1, y: 2 } as any],
    })
    await settleWrites()
    const commentIntents = () => journaledIntents().filter((intent) => intent.kind === 'comment')
    // Anti-void guard: the dependent intent really is journaled and really is
    // stuck, or the assertion below would pass on an empty journal.
    expect(commentIntents().map((intent) => intent.id)).toContain('cmt-remote')

    // A colleague deletes the diagram. Nothing local is journaled by adoption —
    // the tombstone IS the durable expression — so the sweep is what has to
    // notice that the comment's carrier is gone.
    fixture.meta.change((meta: any) => { meta.deletedDiagramIds = [SERVER_OWNED] })
    await settleWrites()

    expect(useModelStore.getState().deletedDiagramIds).toContain(SERVER_OWNED)
    expect(commentIntents().map((intent) => intent.id)).not.toContain('cmt-remote')
  })

  it('ne lève PAS le tombstone d\'un collègue parce que la fenêtre porte encore le diagramme', async () => {
    // The lift in `detectEdits` must not read "present in `state.diagrams`" as
    // "the user re-created it". Under a summary contract that is FALSE, and the
    // window is a WINDOW: `projectAll` early-returns
    // while `bfsActive`, so the only thing that drops a remotely-tombstoned id
    // from the store is an ASYNCHRONOUS re-projection — a rAF (or a 1 s timer in
    // a hidden tab), an `ensureOverlayHandles()`, then a network round trip for
    // the render. A drag tick is ~16 ms. The user wins that race routinely, and
    // when the server is slow or unreachable the window stays stale for as long
    // as the outage lasts.
    //
    // Same rule as the `placeIds` loop (`bridge.ts`, "a stale store is NOT a
    // witness") and the same rule as durability: a tombstone may only be lifted
    // by an explicit user intention, never by a store state.
    //
    // Left unguarded the next flush splices the colleague's id OUT of
    // `deletedDiagramIds`, and since the server projector already dropped the
    // `ro_diagrams` rows and nothing re-inserts them, the diagram becomes
    // invisible to everyone with no tombstone left — invisible to the
    // `diagram-tombstone-honoured` fsck check too. Delete-wins, on the user
    // tick path as well as on the replay path.
    const fixture = summaryFixture()
    wire(fixture)
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)

    // Anti-void guard n°1: Alice really has the diagram resident.
    expect(useModelStore.getState().diagrams.map((d) => d.id)).toContain(SERVER_OWNED)

    // The render round trip is now in flight and never answers — a slow or
    // unreachable read model. This is what holds the window stale; without it
    // the re-projection lands within a millisecond of the tombstone and the
    // scenario evaporates (the test would then pass OVER the broken code).
    mocks.fetchDiagramRender.mockImplementation(() => new Promise(() => {}))

    // Alice is editing.
    useModelStore.setState({
      objects: [{
        id: 'obj-a', name: 'Moved once', type: 'system', description: '', tags: [],
      } as any],
    })
    await settleWrites()

    // Bob deletes the diagram; his tombstone merges into Alice's ModelMeta.
    fixture.meta.change((meta: any) => { meta.deletedDiagramIds = [SERVER_OWNED] })
    await settleWrites()
    expect(useModelStore.getState().deletedDiagramIds).toContain(SERVER_OWNED)
    // Anti-void guard n°2: the window is STALE — that is the whole premise.
    expect(useModelStore.getState().diagrams.map((d) => d.id)).toContain(SERVER_OWNED)

    // Alice keeps working: any durable slice tick runs `detectEdits`.
    useModelStore.setState({
      objects: [{
        id: 'obj-a', name: 'Moved twice', type: 'system', description: '', tags: [],
      } as any],
    })
    await settleWrites()

    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).toContain(SERVER_OWNED)
  })

  it('une fenêtre PÉRIMÉE ne journalise RIEN pour un diagramme tombstoné', async () => {
    // The companion of the lift refusal above, on the capture side, and the
    // guard that makes `canJournal`'s narrowness executable.
    //
    // Widening `canJournal` to `|| tombstoneDiagrams.has(id)` would be inert
    // where it might seem to help — `captureExplicitDeletes` already journals a
    // server-owned delete unconditionally, earlier in the same `onStoreChange`
    // tick — and ACTIVE exactly where nothing should be journaled: the only
    // diagrams that reach that gate still tombstoned are the ones the lift loop
    // refused to lift, i.e. a stale window holding a diagram whose deletion is
    // already durable. Journaling from the window is forbidden, and since a
    // journaled CREATION lifts a tombstone (the replay's `replayLifts`), it
    // would be a live resurrection path. This test fails if the clause is added.
    const fixture = summaryFixture()
    wire(fixture)
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(useModelStore.getState().diagrams.map((d) => d.id)).toContain(SERVER_OWNED)

    // The re-projection that would drop the id never answers — a slow or
    // unreachable read model. This is what holds the window stale; without it
    // the scenario evaporates and the test passes over broken code.
    mocks.fetchDiagramRender.mockImplementation(() => new Promise(() => {}))

    // A colleague deletes it. Nothing local is journaled by adoption.
    fixture.meta.change((meta: any) => { meta.deletedDiagramIds = [SERVER_OWNED] })
    await settleWrites()
    // Anti-void guard: the window really IS stale — that is the whole premise.
    expect(useModelStore.getState().diagrams.map((d) => d.id)).toContain(SERVER_OWNED)

    // The user renames the stale card on a real user tick.
    useModelStore.setState({
      diagrams: useModelStore.getState().diagrams.map((d) =>
        d.id === SERVER_OWNED ? { ...d, name: 'Renamed on a stale window' } : d),
    })
    await settleWrites()

    const diagramIntents = journaledIntents().filter((intent) => intent.kind === 'diagram')
    expect(diagramIntents.map((intent) => intent.id)).not.toContain(SERVER_OWNED)
    // …and the colleague's tombstone is untouched, on both sides.
    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).toContain(SERVER_OWNED)
    expect(useModelStore.getState().deletedDiagramIds).toContain(SERVER_OWNED)
  })

  it('une levée qui n\'écrit rien ne loque pas l\'adoption des tombstones distants', async () => {
    // `unTombDiagrams` gates `adoptRemoteDiagramTombstones`
    // (`if (unTombDiagrams.has(id)) continue`). If it drained ONLY through
    // `plan.remove` — empty exactly when the meta never carried the id — a
    // delete undone before its flush would latch the gate shut for the whole
    // session: every FUTURE remote tombstone for that id silently refused, and
    // the next flush splicing a colleague's out.
    // A SESSION-CREATED diagram, because that is where a lift provably writes
    // nothing: the planner routes those ids to `deferredToLocalRegistry` (the
    // write-head shard removes the entry outright), so ModelMeta never carries
    // a tombstone for them and `plan.remove` can never drain the lift. And it
    // must not be the ACTIVE diagram — deleting that one switches
    // `currentDiagramId`, which makes `onStoreChange` call
    // `writeScheduler.flushNow()` inside the same tick.
    const MINE = 'dg-made-here'
    const fixture = summaryFixture()
    wire(fixture)
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)

    const created = {
      id: MINE, name: 'Made here', type: 'container',
      objectIds: [], connectionIds: [], groupIds: [], layouts: {},
    } as any
    useModelStore.setState({ diagrams: [...useModelStore.getState().diagrams, created] })
    await settleWrites()
    expect(useModelStore.getState().currentDiagramId).not.toBe(MINE)

    // Delete, then undo before the debounced flush: a lift with nothing written.
    useModelStore.getState().deleteDiagram(MINE)
    useModelStore.setState({
      diagrams: [...useModelStore.getState().diagrams, { ...created, name: 'Undone' }],
    })
    await settleWrites()
    // Anti-void guard: the flush really wrote no tombstone, which is the premise
    // — without it the lift would drain through `plan.remove` and prove nothing.
    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).toEqual([])

    // Much later, a colleague deletes it for real.
    fixture.meta.change((meta: any) => { meta.deletedDiagramIds = [MINE] })
    await settleWrites()

    expect(useModelStore.getState().deletedDiagramIds).toContain(MINE)
  })

  it('une suppression puis re-création du même id ne laisse pas de tombstone', async () => {
    // Without the un-tombstone lift (the `remObj` equivalent), the recreated
    // diagram stays excluded by the server read model and filtered out
    // of the client window — invisible for ever, with its data intact and
    // unreachable. A JSON import under "existing ids win" does exactly this.
    const fixture = summaryFixture()
    wire(fixture)
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)

    useModelStore.getState().deleteDiagram(SERVER_OWNED)
    await settleWrites()
    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).toContain(SERVER_OWNED)

    // The user re-creates the same id (a real store tick, not a projection).
    useModelStore.setState({
      diagrams: [{
        id: SERVER_OWNED, name: 'Recreated', type: 'container',
        objectIds: [], connectionIds: [], groupIds: [], layouts: {},
      } as any],
    })
    await settleWrites()

    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).not.toContain(SERVER_OWNED)
    expect(useModelStore.getState().deletedDiagramIds).not.toContain(SERVER_OWNED)
  })

  it('un BOOT À FROID hydrate les tombstones du ModelMeta et ne rend pas ce qui est supprimé', async () => {
    // Covers the tombstone hydration in `ensureModelSharded`: without it every
    // deletion made in a previous session — or by anyone else — comes back on
    // the next cold boot. The store and the window are rebuilt from scratch at
    // boot, so the tombstone set is the only thing that carries the deletion
    // across it. Everything downstream (`summaryRegistryMetas`,
    // `rebuildRegistryIndex`, the absence proof, the replay's delete-wins,
    // `canTombstone`) reads that set; other tests all delete within the session
    // they assert in, so only this one sees it.
    //
    // The server page still lists the diagram here, deliberately: the
    // `ro_diagrams` row goes only when the projector catches up, and offline it
    // never does. Converging locally on the durable tombstone is the point.
    const fixture = summaryFixture({ deletedDiagramIds: [SERVER_OWNED] })
    wire(fixture)
    const { startBridge, __summaryRegistryMetasForTest } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)

    // Anti-void guard: the server really did still serve the deleted diagram.
    expect(mocks.fetchDiagramListPage).toHaveBeenCalled()
    expect(__summaryRegistryMetasForTest().map((meta) => meta.id)).not.toContain(SERVER_OWNED)
    expect(useModelStore.getState().deletedDiagramIds).toContain(SERVER_OWNED)
    expect(useModelStore.getState().diagrams.map((d) => d.id)).not.toContain(SERVER_OWNED)
    // And nothing was journaled: a tombstone read at boot is already the
    // durable expression, not a fresh user intention.
    expect(journaledDiagramDeletes()).not.toContain(SERVER_OWNED)
  })

  it('une suppression journalisée mais jamais écrite est RÉ-EXPRIMÉE au boot suivant', async () => {
    // The bridge half of the replay. `planDiagramStubReplay` returning
    // `replayTombstones` is unit-tested elsewhere; this pins the bridge
    // CONSUMING that plan. Without the adoption loop the user's offline deletion
    // would be replanned at every boot and never expressed — the badge stuck on
    // "Saving…" for ever.
    //
    // The crash window is real and narrow: `captureExplicitDeletes` journals
    // IMMEDIATELY (`persistEntityIntentsNow`) while the ModelMeta change waits
    // on the 150 ms write debounce. A kill in between leaves exactly this
    // state — journal yes, document no.
    const OTHER = 'dg-other-server-owned'
    mocks.fetchDiagramListPage.mockResolvedValue({
      items: [diagramMeta(SERVER_OWNED, 'Owned by the server'), diagramMeta(OTHER, 'Also the server\'s')],
      nextCursor: null,
      total: 10_000,
    })
    const fixture = summaryFixture()
    wire(fixture)
    // Session 1 never reaches durable storage, so nothing is ever acknowledged
    // and the journal entry survives — the offline half of the scenario.
    const blockedFlush = vi.spyOn(repo, 'flush').mockImplementation(() => new Promise<void>(() => {}))
    const bridge = await import('./bridge')
    await bridge.startBridge(DEFAULT_WORKSPACE_REF)
    // NOT the active diagram: deleting that one switches `currentDiagramId` and
    // takes a different code path (an immediate flush) than the one under test.
    expect(useModelStore.getState().currentDiagramId).not.toBe(OTHER)

    useModelStore.getState().deleteDiagram(OTHER)
    await settleWrites()
    bridge.stopBridge()

    // The kill, reconstructed on the documents rather than on the clock: the
    // ModelMeta change was made in memory but its storage write never landed,
    // so the next process opens a document that never carried it. The journal
    // is the only surviving trace — which is the entire reason it exists.
    blockedFlush.mockRestore()
    fixture.meta.change((meta: any) => { meta.deletedDiagramIds = [] })

    // Anti-void guards: journal yes, document no.
    expect(journaledDiagramDeletes()).toContain(OTHER)
    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).not.toContain(OTHER)

    // The next boot, same journal, same documents.
    useModelStore.setState({
      diagrams: [], currentDiagramId: null,
      pendingDeletedDiagramIds: [], deletedDiagramIds: [],
    })
    await bridge.startBridge(DEFAULT_WORKSPACE_REF)
    await settleWrites()

    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).toContain(OTHER)
    expect(bridge.__summaryRegistryMetasForTest().map((meta) => meta.id)).not.toContain(OTHER)
  })

  it('une RE-CRÉATION journalisée survit au tombstone au lieu d\'être perdue en silence', async () => {
    // On the REPLAY path a journaled CREATION whose id is tombstoned must not be
    // marked `satisfied`: the intent would die, the diagram would stay hidden
    // behind the tombstone filter, and the badge would go green over it — a
    // re-creation lost with no trace.
    //
    // The live user-tick path self-corrects (the lift and the journal entry come
    // out of the same `detectEdits` tick, one line apart), so the window only
    // opens across a CRASH — and across a crash it is wide, because
    // `tombstoneDiagrams` is rehydrated from ModelMeta at every cold boot while
    // the lift's splice waits on a debounced flush.
    const OTHER = 'dg-other-server-owned'
    mocks.fetchDiagramListPage.mockResolvedValue({
      items: [diagramMeta(SERVER_OWNED, 'Owned by the server'), diagramMeta(OTHER, 'Also the server\'s')],
      nextCursor: null,
      total: 10_000,
    })
    const fixture = summaryFixture()
    wire(fixture)
    // One spy, toggled: session 1's DELETE must become durable, session 1's
    // LIFT must not. Two `vi.spyOn` calls on the same method would stack.
    let blockFlush = false
    const realFlush = repo.flush.bind(repo)
    vi.spyOn(repo, 'flush').mockImplementation((ids?: any) =>
      blockFlush ? new Promise<void>(() => {}) : realFlush(ids))
    const bridge = await import('./bridge')
    await bridge.startBridge(DEFAULT_WORKSPACE_REF)
    // NOT the active diagram: deleting that one switches `currentDiagramId`,
    // which flushes inside the same tick and takes a different path.
    expect(useModelStore.getState().currentDiagramId).not.toBe(OTHER)

    useModelStore.getState().deleteDiagram(OTHER)
    await settleWrites()
    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).toContain(OTHER)

    // The user puts the id back — undo, or a JSON import under "existing ids
    // win" — and the tab dies before the lift reaches storage.
    blockFlush = true
    useModelStore.setState({
      diagrams: [...useModelStore.getState().diagrams, {
        id: OTHER, name: 'Recreated', type: 'container',
        objectIds: [], connectionIds: [], groupIds: [], layouts: {},
      } as any],
    })
    await settleWrites()
    bridge.stopBridge()
    blockFlush = false

    // The kill, reconstructed on the DOCUMENTS rather than on the clock (as the
    // offline-delete replay test does): the re-creation's writes were made in memory but never landed,
    // so the next process opens the documents exactly as the DELETE left them.
    fixture.meta.change((meta: any) => { meta.deletedDiagramIds = [OTHER] })
    fixture.writeHead.change((shard: any) => { delete shard.diagrams[OTHER] })

    // Anti-void guards, both halves: the journal holds a CREATION (not a rename
    // patch — a patch would legitimately lose to delete-wins), and the document
    // holds the tombstone that swallowed it.
    expect(journaledDiagramCreations()).toContain(OTHER)
    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).toContain(OTHER)

    useModelStore.setState({
      diagrams: [], currentDiagramId: null,
      pendingDeletedDiagramIds: [], deletedDiagramIds: [],
    })
    await bridge.startBridge(DEFAULT_WORKSPACE_REF)
    await settleWrites()

    // The lift is the expression: the tombstone leaves the document…
    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).not.toContain(OTHER)
    expect(useModelStore.getState().deletedDiagramIds).not.toContain(OTHER)
    // …and the diagram is back on screen instead of invisible for ever.
    expect(useModelStore.getState().diagrams.map((d) => d.id)).toContain(OTHER)
    // The other half of the trade, and it has to be asserted or the cure is
    // just a different disease: the badge may go green HONESTLY. A silent loss
    // swapped for an intent journaled for the life of the workspace would be no
    // cure at all. What expresses it is named rather than assumed — the
    // injection re-admits the id as session-local (the boot's page ingest skips
    // tombstoned ids, so `docUrlById` never held it), `writeSummaryLocalRegistry`
    // places the meta in the write head, and THAT shard flush is the witness.
    expect(Object.keys(fixture.writeHead.doc()?.diagrams ?? {})).toContain(OTHER)
    expect(journaledDiagramCreations()).not.toContain(OTHER)
  })

  it('les intentions dépendantes meurent avec le diagramme tombstoné', async () => {
    // The wedge this prevents: `flushWrite` step 3 only writes the ACTIVE
    // diagram's comments and flows, and a deleted diagram can never become
    // active again. So a comment/flow intent scoped to it has no expression
    // path left at all — it survives every flush, is rehydrated at every boot,
    // and `pendingDurabilityCount()` never reaches zero, so the badge says
    // "Saving…" for the rest of the workspace's life over a deletion that in
    // fact succeeded perfectly.
    //
    // The fixture separates the two carriers, which is the only way to see it:
    // ONLY the ModelMeta document reaches durable storage. The comment's own
    // carrier never does, so nothing but the retirement can clear it — and the
    // retirement's witness is the ModelMeta flush, the same document that
    // carries the tombstone.
    //
    // The ModelMeta flush is GATED rather than merely allowed, so the same
    // fixture also pins the witness: retiring the dependents before that flush
    // resolves would forget them while the tombstone that justifies the
    // retirement is durable nowhere — a crash there loses both.
    const fixture = summaryFixture()
    wire(fixture)
    const realFlush = repo.flush.bind(repo)
    let releaseMetaFlush: (() => void) | null = null
    const metaGate = new Promise<void>((resolve) => { releaseMetaFlush = resolve })
    vi.spyOn(repo, 'flush').mockImplementation(async (ids?: any) => {
      if (!Array.isArray(ids) || !ids.includes(fixture.meta.documentId)) {
        return new Promise<void>(() => {})
      }
      await metaGate
      return realFlush(ids)
    })
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)
    expect(useModelStore.getState().currentDiagramId).toBe(SERVER_OWNED)

    useModelStore.setState({
      comments: [{
        id: 'cmt-1', diagramId: SERVER_OWNED, text: 'Une remarque',
        x: 10, y: 20,
      } as any],
    })
    await settleWrites()
    // Anti-void guard: the dependent intent really is journaled and really is
    // stuck — without this the assertion below would pass on an empty journal.
    const commentIntents = () => journaledIntents().filter((intent) => intent.kind === 'comment')
    expect(commentIntents().map((intent) => intent.id)).toContain('cmt-1')

    useModelStore.getState().deleteDiagram(SERVER_OWNED)
    await settleWrites()

    // The tombstone is in the document (the change is synchronous)…
    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).toContain(SERVER_OWNED)
    // …but it is durable NOWHERE yet, so the dependents may not be forgotten:
    // a kill here would lose the comment intent and the tombstone together.
    expect(commentIntents().map((intent) => intent.id)).toContain('cmt-1')

    releaseMetaFlush!()
    await settleWrites()

    // Durable now — and only now do the dependents go, so the badge can reach
    // "Synced" instead of wedging on an intent with no expression path.
    expect(commentIntents().map((intent) => intent.id)).not.toContain('cmt-1')
  })

  it('un id supprimé APRÈS avoir été créé en session ne laisse pas de tombstone permanent', async () => {
    // `writeSummaryLocalRegistry` expresses a session-created diagram's removal
    // in the write-head shard and drops the id from the tombstone set. Without
    // that, on the NEXT flush the id is still tombstoned but no longer
    // session-local, so the planner writes a permanent ModelMeta entry for a
    // diagram that is already durably gone: a second truth about one removal,
    // plus unbounded growth on the one document a summary boot must
    // materialize (nothing compacts it).
    const MINE = 'dg-made-then-deleted'
    const fixture = summaryFixture()
    wire(fixture)
    const { startBridge } = await import('./bridge')
    await startBridge(DEFAULT_WORKSPACE_REF)

    useModelStore.setState({
      diagrams: [...useModelStore.getState().diagrams, {
        id: MINE, name: 'Made here', type: 'container',
        objectIds: [], connectionIds: [], groupIds: [], layouts: {},
      } as any],
    })
    await settleWrites()
    // Anti-void guard: it really was written to the write-head shard, i.e. the
    // id really is session-local and really has its own removal path.
    expect(Object.keys(fixture.writeHead.doc()?.diagrams ?? {})).toContain(MINE)
    expect(useModelStore.getState().currentDiagramId).not.toBe(MINE)

    useModelStore.getState().deleteDiagram(MINE)
    await settleWrites()

    // Expressed where it belongs…
    expect(Object.keys(fixture.writeHead.doc()?.diagrams ?? {})).not.toContain(MINE)
    // …and nowhere else, now or on any later flush.
    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).not.toContain(MINE)
    useModelStore.setState({
      objects: [{ id: 'obj-z', name: 'Later edit', type: 'system', description: '', tags: [] } as any],
    })
    await settleWrites()
    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).not.toContain(MINE)
  })

  it('un paysage classique supprime par le tesson de registre et n\'écrit AUCUN tombstone', async () => {
    // `deletedDiagramIds` must not be written without the `registrySummaryOnly`
    // guard. `bfsActive ∧ ¬registrySummaryOnly` is reachable — the VITE flag on
    // an ordinary landscape — and there the resident registry already knows how
    // to remove a diagram. A tombstone there is a SECOND truth about the same
    // removal plus a ModelMeta that grows for nothing.
    //
    // The name promises TWO things, so both are asserted: mocking
    // `getRegistryShardHandles` to `[]` would leave "deletes through the
    // registry shard" unobserved.
    localStorage.setItem('maplespire:bootFromServer', 'true')
    const fixture = summaryFixture({ summaryOnly: false })
    // The shard the ROOT names, not a detached one: `ensureRegistryShards`
    // resolves `root.shardUrls`, so a handle the root does not list is never
    // loaded and the removal would have nowhere to be observed.
    const classicShard = fixture.registryBase
    classicShard.change((shard: any) => {
      shard.diagrams['dg-classic'] = {
        id: 'dg-classic', name: 'Classic', type: 'container', docUrl: '',
        objectIds: [], connectionIds: [], groupIds: [],
      }
    })
    wire(fixture)
    const { startBridge, isRegistrySummaryOnlyActive, isBootFromServerActive } = await import('./bridge')
    await startBridge({ landscapeId: 'ordinary-bfs', versionId: 'current' })

    // The anti-void guard: this case only means something if the session really
    // is boot-from-server WITHOUT the summary contract.
    expect(isBootFromServerActive()).toBe(true)
    expect(isRegistrySummaryOnlyActive()).toBe(false)

    useModelStore.setState({
      diagrams: [{
        id: 'dg-classic', name: 'Classic', type: 'container',
        objectIds: [], connectionIds: [], groupIds: [], layouts: {},
      } as any],
    })
    await settleWrites()
    // Anti-void guard for the other half of the name: the removal can only be
    // OBSERVED in the shard if the entry is there to begin with.
    expect(Object.keys(classicShard.doc()?.diagrams ?? {})).toContain('dg-classic')

    useModelStore.getState().deleteDiagram('dg-classic')
    await settleWrites()

    // Half one: the classic path removed it from the REGISTRY SHARD…
    expect(Object.keys(classicShard.doc()?.diagrams ?? {})).not.toContain('dg-classic')
    // …half two: and wrote no tombstone doing it.
    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).toEqual([])
  })

  it('QA 2026-10-11: the registry PRE-DIFF still strips a connection deleted this session out of a NON-active meta', async () => {
    // The write path pre-diffs every existing registry meta against the
    // materialized shard and skips the equal ones (connect-freeze fix). A
    // non-active meta's desired composition is its EXISTING composition MINUS
    // the ids tombstoned this session, so a pre-diff that compares against the
    // unstripped composition calls it "equal" and the deleted connection stays
    // in that diagram's registry entry for ever. Mutant (QA lens): the pre-diff
    // skips `stripDeletedFromComposition` — every arm in src/lib/automerge and
    // src/stores stayed GREEN. The strip is only live under `bfsActive` (the
    // only mode that records tombstones), hence this suite's fixture.
    //
    // Three phases, because the FIRST flushes of this fixture rewrite every
    // meta for other reasons (the docUrl is re-minted), which would carry the
    // strip along incidentally and let the mutant pass:
    //  1. settle until the registry is quiescent;
    //  2. delete a connection that only the NON-active meta lists;
    //  3. the meta must lose exactly that id.
    localStorage.setItem('maplespire:bootFromServer', 'true')
    const fixture = summaryFixture({ summaryOnly: false })
    const classicShard = fixture.registryBase
    classicShard.change((shard: any) => {
      shard.diagrams['dg-other'] = {
        id: 'dg-other', name: 'Other', type: 'container', docUrl: '',
        objectIds: ['o-a', 'o-b'], connectionIds: ['c-x', 'c-keep'], groupIds: [],
      }
      shard.diagrams['dg-trigger'] = {
        id: 'dg-trigger', name: 'Trigger', type: 'container', docUrl: '',
        objectIds: [], connectionIds: [], groupIds: [],
      }
    })
    wire(fixture)
    const { startBridge, isRegistrySummaryOnlyActive, isBootFromServerActive } = await import('./bridge')
    await startBridge({ landscapeId: 'ordinary-bfs-strip', versionId: 'current' })
    expect(isBootFromServerActive()).toBe(true)
    expect(isRegistrySummaryOnlyActive()).toBe(false)

    // Phase 1: quiescence.
    useModelStore.setState({
      diagrams: [
        { id: 'dg-other', name: 'Other', type: 'container', objectIds: ['o-a', 'o-b'], connectionIds: ['c-x', 'c-keep'], groupIds: [], layouts: {} } as any,
        { id: 'dg-trigger', name: 'Trigger', type: 'container', objectIds: [], connectionIds: [], groupIds: [], layouts: {} } as any,
      ],
      connections: [{ id: 'c-x', fromId: 'o-a', toId: 'o-b', type: 'solid' } as any],
    })
    await settleWrites()
    useModelStore.getState().updateDiagram('dg-trigger', { name: 'Trigger renamed' })
    await settleWrites()
    expect((classicShard.doc()?.diagrams['dg-trigger'] as any).name).toBe('Trigger renamed')
    // Anti-void: the id is still there before the delete.
    expect([...(classicShard.doc()?.diagrams['dg-other'] as any).connectionIds]).toEqual(['c-x', 'c-keep'])

    // Phase 2: an explicit delete — the only change this flush carries.
    useModelStore.getState().deleteConnection('c-x')
    await settleWrites()

    // Phase 3.
    const other = classicShard.doc()?.diagrams['dg-other'] as any
    expect([...other.connectionIds]).toEqual(['c-keep'])
    expect([...other.objectIds]).toEqual(['o-a', 'o-b'])
    expect(other.name).toBe('Other')
  })

  it('a NON-active meta keeps its per-diagram scope overrides through a flush, and loses only a deleted object\'s', async () => {
    // The registry meta's `objectScopes` copy is what Model Objects counts
    // "external in N of M diagrams" from (resident stubs, ro_diagrams.data).
    // For a non-active diagram the store holds a STUB, which is not
    // authoritative: the flush must keep the existing meta's overrides, minus
    // the objects deleted this session. QA lens mutants R1/R4/R6 (buildMeta
    // never writes them / the non-active branch drops `existing.objectScopes` /
    // no strip) were all GREEN before this test.
    localStorage.setItem('maplespire:bootFromServer', 'true')
    const fixture = summaryFixture({ summaryOnly: false })
    const classicShard = fixture.registryBase
    classicShard.change((shard: any) => {
      shard.diagrams['dg-other'] = {
        id: 'dg-other', name: 'Other', type: 'container', docUrl: '',
        objectIds: ['o-a', 'o-b'], connectionIds: [], groupIds: [],
        objectScopes: { 'o-a': 'external', 'o-b': 'internal' },
      }
      shard.diagrams['dg-trigger'] = {
        id: 'dg-trigger', name: 'Trigger', type: 'container', docUrl: '',
        objectIds: [], connectionIds: [], groupIds: [],
      }
    })
    wire(fixture)
    const { startBridge, isRegistrySummaryOnlyActive } = await import('./bridge')
    await startBridge({ landscapeId: 'ordinary-bfs-scopes', versionId: 'current' })
    expect(isRegistrySummaryOnlyActive()).toBe(false)

    // The store's stub of dg-other deliberately carries NO overrides: if the
    // flush took them from the stub, the meta would lose them.
    useModelStore.setState({
      diagrams: [
        { id: 'dg-other', name: 'Other', type: 'container', objectIds: ['o-a', 'o-b'], connectionIds: [], groupIds: [], layouts: {} } as any,
        { id: 'dg-trigger', name: 'Trigger', type: 'container', objectIds: [], connectionIds: [], groupIds: [], layouts: {} } as any,
      ],
      objects: [
        { id: 'o-a', type: 'app', name: 'A', scope: 'internal' } as any,
        { id: 'o-b', type: 'app', name: 'B', scope: 'internal' } as any,
      ],
    })
    await settleWrites()
    useModelStore.getState().updateDiagram('dg-trigger', { name: 'Trigger renamed' })
    await settleWrites()
    expect((classicShard.doc()?.diagrams['dg-trigger'] as any).name).toBe('Trigger renamed')
    expect({ ...(classicShard.doc()?.diagrams['dg-other'] as any).objectScopes })
      .toEqual({ 'o-a': 'external', 'o-b': 'internal' })

    useModelStore.getState().deleteObject('o-b')
    await settleWrites()
    const other = classicShard.doc()?.diagrams['dg-other'] as any
    expect([...other.objectIds]).toEqual(['o-a'])
    expect({ ...other.objectScopes }).toEqual({ 'o-a': 'external' })
  })

  it('en mode CLASSIQUE le balayage ignore les tombstones — mais balaye quand même', async () => {
    // `observeRegistryForAbsence` passes `tombstonedIds` only under a
    // summary registry, and `observeRegistryAbsence` strips them from
    // `presentIds` BEFORE it branches on mode — so handing them over in classic
    // mode retires a diagram's comment/flow intents on the strength of a
    // tombstone that mode never expresses. `bfsActive ∧ ¬registrySummaryOnly`
    // is reachable (a VITE flag on an ordinary landscape), `ensureModelSharded`
    // hydrates `tombstoneDiagrams` from ModelMeta in BOTH bfs modes, and
    // `planDiagramTombstones` returns an empty plan there — so the set can be
    // non-empty over a registry that still legitimately holds the entry. An
    // intent retired against an absence nothing proved.
    //
    // The POSITIVE CONTROL is what makes this test discriminating rather than
    // vacuous: a second comment, on a diagram that really is absent from the
    // complete registry, must be retired by the SAME sweep in the SAME run. One
    // kept and one retired proves the sweep ran and chose; asserting only the
    // survivor would pass just as well on a sweep that never fires.
    localStorage.setItem('maplespire:bootFromServer', 'true')
    const fixture = summaryFixture({ summaryOnly: false, deletedDiagramIds: ['dg-classic'] })
    const classicShard = fixture.registryBase
    classicShard.change((shard: any) => {
      shard.diagrams['dg-classic'] = {
        id: 'dg-classic', name: 'Classic', type: 'container', docUrl: '',
        objectIds: [], connectionIds: [], groupIds: [],
      }
    })
    wire(fixture)
    // The classic registry really is LOADED here, unlike the suite's default
    // `[]`: the absence observation abstains outright on zero witnesses, so
    // with no shard resolved this test would assert over a sweep that never
    // ran (the positive control catches that).
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([classicShard] as any)
    // Only the sweep's witness — the registry shard the root names — becomes
    // durable. The comments' own carrier never does, so nothing but the
    // retirement can clear either intent.
    const realFlush = repo.flush.bind(repo)
    vi.spyOn(repo, 'flush').mockImplementation((ids?: any) => {
      if (Array.isArray(ids) && ids.length && ids.every((id: string) => id === classicShard.documentId)) {
        return realFlush(ids)
      }
      return new Promise<void>(() => {})
    })
    const { startBridge, isBootFromServerActive, isRegistrySummaryOnlyActive } = await import('./bridge')
    await startBridge({ landscapeId: 'ordinary-bfs-m7', versionId: 'current' })

    // Anti-void guards: the reachable state really is bfs WITHOUT summary, and
    // the tombstone really was hydrated over a registry that still holds it.
    expect(isBootFromServerActive()).toBe(true)
    expect(isRegistrySummaryOnlyActive()).toBe(false)
    expect(useModelStore.getState().deletedDiagramIds).toContain('dg-classic')

    useModelStore.setState({
      comments: [
        { id: 'cmt-tombstoned', diagramId: 'dg-classic', text: 'Sur un id tombstoné', x: 1, y: 2 } as any,
        { id: 'cmt-vanished', diagramId: 'dg-vanished', text: 'Sur un id vraiment absent', x: 3, y: 4 } as any,
      ],
    })
    await settleWrites()
    const commentIntents = () => journaledIntents()
      .filter((intent) => intent.kind === 'comment')
      .map((intent) => intent.id)
    // Anti-void guard: both intents really are journaled to begin with.
    expect(commentIntents()).toContain('cmt-tombstoned')

    await settleWrites()
    expect(Object.keys(classicShard.doc()?.diagrams ?? {})).toContain('dg-classic')

    // The positive control: the sweep DID run and DID retire, on the id whose
    // absence the complete classic registry really does prove.
    expect(commentIntents()).not.toContain('cmt-vanished')
    // …and it left the tombstoned-but-present one alone.
    expect(commentIntents()).toContain('cmt-tombstoned')
  })

  it("en mode CLASSIQUE le rejeu d'une suppression n'ecrit et ne publie AUCUN tombstone", async () => {
    // `canTombstone: registrySummaryOnly && modelMetaHandle !== null` — the
    // wiring. What this holds is the OUTCOME that
    // expression exists for: on an ordinary landscape booted `bfsActive`, a
    // delete surviving into a SECOND session is re-planned and expressed
    // through the registry, never as a `ModelMeta.deletedDiagramIds` entry and
    // never as a published `deletedDiagramIds` in the store. A phantom
    // tombstone there would hide a diagram whose registry — the authority in
    // that mode — still holds it, with no document anywhere carrying the claim,
    // and `writeDiagramTombstones` never publishes on an empty plan, so a
    // non-empty store field could only come from the replay's tombstone arm.
    //
    // What this does NOT catch: dropping the `registrySummaryOnly` conjunct
    // does not fail here, because with the shards resolved `metasComplete` is
    // true off summary, so the planner satisfies or replays the delete and the
    // `canTombstone` branch is never reached. Reaching it needs `metasComplete
    // === false` in classic mode, i.e. a shard whose doc has not materialized —
    // and an in-process `repo.create` handle is `ready` the instant it exists,
    // so that state has no faithful fixture here.
    localStorage.setItem('maplespire:bootFromServer', 'true')
    const fixture = summaryFixture({ summaryOnly: false })
    const classicShard = fixture.registryBase
    const seedClassic = () => classicShard.change((shard: any) => {
      shard.diagrams['dg-classic'] = {
        id: 'dg-classic', name: 'Classic', type: 'container', docUrl: '',
        objectIds: [], connectionIds: [], groupIds: [],
      }
    })
    seedClassic()
    wire(fixture)
    vi.spyOn(repoModule, 'getRegistryShardHandles').mockResolvedValue([classicShard] as any)
    const blockedFlush = vi.spyOn(repo, 'flush').mockImplementation(() => new Promise<void>(() => {}))
    const bridge = await import('./bridge')
    await bridge.startBridge({ landscapeId: 'ordinary-bfs-cantomb', versionId: 'current' })
    expect(bridge.isBootFromServerActive()).toBe(true)
    expect(bridge.isRegistrySummaryOnlyActive()).toBe(false)
    expect(useModelStore.getState().diagrams.map((d) => d.id)).toContain('dg-classic')

    useModelStore.getState().deleteDiagram('dg-classic')
    await settleWrites()
    bridge.stopBridge()

    // The kill: the registry removal was made in memory and never reached
    // storage, so the next process opens a registry that still lists the
    // diagram, with the journal as the only surviving trace.
    blockedFlush.mockRestore()
    seedClassic()
    expect(journaledDiagramDeletes()).toContain('dg-classic')
    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).toEqual([])

    useModelStore.setState({
      diagrams: [], currentDiagramId: null,
      pendingDeletedDiagramIds: [], deletedDiagramIds: [],
    })
    await bridge.startBridge({ landscapeId: 'ordinary-bfs-cantomb', versionId: 'current' })
    await settleWrites()

    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).toEqual([])
    expect(useModelStore.getState().deletedDiagramIds).not.toContain('dg-classic')
  })

  it('n\'acquitte jamais une suppression contre le flush d\'un document qui ne l\'exprime pas', async () => {
    // THE WITNESS RULE, in the one place it can still break silently.
    //
    // `writeDiagramTombstones` decides which delete intents to acknowledge from
    // an `expressed` set, and that set must be built from the DOCUMENT
    // (`existingTombstones` + `plan.add` − `plan.remove`). Rebuilding it from
    // `tombstoneDiagrams` — the session's own intent set — reads identically on
    // every summary fixture, because there the two agree by construction. They
    // come apart in exactly one reachable state, and it is not exotic:
    // `bfsActive ∧ ¬registrySummaryOnly` (a VITE flag on an ordinary
    // landscape). There `captureExplicitDeletes` DOES fill `tombstoneDiagrams`
    // while the planner returns an empty plan, so ModelMeta expresses nothing
    // at all — and `writeDiagramTombstones` runs BEFORE the registry reconcile
    // that actually removes the entry.
    //
    // A session-intent witness therefore acknowledges the delete against
    // `repo.flush([modelMetaDocumentId])`: a flush of a document that says
    // NOTHING about this diagram, and which resolves immediately precisely
    // because it was never changed. The journal entry is forgotten while the
    // only write that expresses the deletion — the registry shard — is still in
    // flight. A kill in that window loses the deletion with no trace, which is
    // the class of silent failure this journal exists to close.
    //
    // The fixture makes the two documents disagree: ModelMeta flushes, the
    // registry shard never does. The correct code acknowledges nothing here and
    // leaves the intent to `acknowledgeDiagramStubsAgainstRegistry`, whose
    // witness IS the shard flush.
    localStorage.setItem('maplespire:bootFromServer', 'true')
    const fixture = summaryFixture({ summaryOnly: false })
    const classicShard = fixture.registryBase
    classicShard.change((shard: any) => {
      shard.diagrams['dg-classic'] = {
        id: 'dg-classic', name: 'Classic', type: 'container', docUrl: '',
        objectIds: [], connectionIds: [], groupIds: [],
      }
    })
    wire(fixture)
    // The registry shard — the ONLY carrier of this removal — never reaches
    // durable storage. Everything else, ModelMeta included, flushes normally.
    const realFlush = repo.flush.bind(repo)
    vi.spyOn(repo, 'flush').mockImplementation((ids?: any) => {
      if (Array.isArray(ids) && ids.includes(classicShard.documentId)) {
        return new Promise<void>(() => {})
      }
      return realFlush(ids)
    })
    const { startBridge, isRegistrySummaryOnlyActive, isBootFromServerActive } = await import('./bridge')
    await startBridge({ landscapeId: 'ordinary-bfs-witness', versionId: 'current' })

    // Anti-void guard n°1: the reachable state really is bfs WITHOUT summary.
    expect(isBootFromServerActive()).toBe(true)
    expect(isRegistrySummaryOnlyActive()).toBe(false)

    useModelStore.setState({
      diagrams: [{
        id: 'dg-classic', name: 'Classic', type: 'container',
        objectIds: [], connectionIds: [], groupIds: [], layouts: {},
      } as any],
    })
    await settleWrites()
    expect(Object.keys(classicShard.doc()?.diagrams ?? {})).toContain('dg-classic')

    useModelStore.getState().deleteDiagram('dg-classic')
    await settleWrites()

    // Anti-void guard n°2: ModelMeta expresses NOTHING about this deletion —
    // that is the whole premise of the trap.
    expect(fixture.meta.doc()?.deletedDiagramIds ?? []).toEqual([])
    // The proof: the only carrier never became durable, so the intent must
    // still be on disk for the next boot to replay.
    expect(journaledDiagramDeletes()).toContain('dg-classic')
  })
})
