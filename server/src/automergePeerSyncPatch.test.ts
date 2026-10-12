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

import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import * as Automerge from '@automerge/automerge'

const installedSource = new URL(
  '../node_modules/@automerge/automerge-repo/dist/synchronizer/DocSynchronizer.js',
  import.meta.url,
)
const installedPackage = new URL(
  '../node_modules/@automerge/automerge-repo/package.json',
  import.meta.url,
)
const installedCollection = new URL(
  '../node_modules/@automerge/automerge-repo/dist/synchronizer/CollectionSynchronizer.js',
  import.meta.url,
)
const installedRepo = new URL(
  '../node_modules/@automerge/automerge-repo/dist/Repo.js',
  import.meta.url,
)
const installedStorageSource = new URL(
  '../node_modules/@automerge/automerge-repo/dist/StorageSource.js',
  import.meta.url,
)
const installedSyncStateTracker = new URL(
  '../node_modules/@automerge/automerge-repo/dist/SyncStateTracker.js',
  import.meta.url,
)
const installedStorageSubsystem = new URL(
  '../node_modules/@automerge/automerge-repo/dist/storage/StorageSubsystem.js',
  import.meta.url,
)
const patchScriptSource = new URL('../patch-automerge-peer-sync-state.mjs', import.meta.url)

function fanoutSchedulerSections(source: string, event: 'change' | 'heads-changed' = 'heads-changed') {
  const cooperativeStart = source.indexOf('const cooperativeYield = () => new Promise')
  const drainStart = source.indexOf('const drainFanout = async', cooperativeStart)
  const schedulerStart = source.indexOf('const scheduleFanout = () =>', drainStart)
  const listenerStart = source.indexOf(`handle.on("${event}", scheduleFanout)`, schedulerStart)
  expect(cooperativeStart).toBeGreaterThan(-1)
  expect(drainStart).toBeGreaterThan(cooperativeStart)
  expect(schedulerStart).toBeGreaterThan(drainStart)
  expect(listenerStart).toBeGreaterThan(schedulerStart)
  return {
    cooperative: source.slice(cooperativeStart, drainStart),
    scheduler: source.slice(schedulerStart, listenerStart),
  }
}

describe('automerge disconnected-peer compatibility patch', () => {
  it('does not materialize a retired document when it has no requesters', async () => {
    const { DocSynchronizer } = await import(installedSource.href) as {
      DocSynchronizer: new (options: Record<string, unknown>) => {
        canForgetRequests(): boolean
      }
    }
    const fullDoc = vi.fn(() => {
      throw new Error('fullDoc must stay lazy without a requester')
    })
    const synchronizer = new DocSynchronizer({
      handle: {
        documentId: 'retired-document',
        fullDoc,
        on: vi.fn(),
      },
      query: {
        sourcePending: vi.fn(),
        subscribe: vi.fn(),
      },
      networkReady: new Promise<void>(() => undefined),
      shareConfig: {
        announce: vi.fn(async () => false),
        access: vi.fn(async () => true),
      },
    })

    expect(synchronizer.canForgetRequests()).toBe(true)
    expect(fullDoc).not.toHaveBeenCalled()
  })

  it('preserves and applies a first late request while its sync state is loading', async () => {
    const previous = process.env.AM_SELECTIVE_SYNC
    process.env.AM_SELECTIVE_SYNC = 'on'
    try {
      const { CollectionSynchronizer } = await import(installedCollection.href) as {
        CollectionSynchronizer: new (options: Record<string, unknown>) => {
          attach(query: Record<string, unknown>): void
          addPeer(peerId: string): void
          receiveMessage(message: Record<string, unknown>): void
          forgetDocumentRequests(documentId: string): boolean
          on(event: string, listener: (...args: unknown[]) => void): void
          docSynchronizers: Record<string, { hasPeer(peerId: string): boolean }>
        }
      }
      type SyncState = ReturnType<typeof Automerge.initSyncState>
      let resolveSyncState: (state: SyncState) => void = () => undefined
      const loadingSyncState = new Promise<SyncState>((resolve) => {
        resolveSyncState = resolve
      })
      // Establish a persisted sync-state baseline, then create one real client
      // edit while that peer is offline. The next frame contains the change,
      // not merely an empty protocol request.
      let serverDocument = Automerge.from<{ base: string, offlineEdit?: string }>({ base: 'shared' })
      let offlineDocument = Automerge.clone(serverDocument)
      let serverSyncState = Automerge.initSyncState()
      let offlineSyncState = Automerge.initSyncState()
      const [announcedOfflineState, announcement] = Automerge.generateSyncMessage(
        offlineDocument,
        offlineSyncState,
      )
      offlineSyncState = announcedOfflineState
      expect(announcement).toBeDefined()
      ;[serverDocument, serverSyncState] = Automerge.receiveSyncMessage(
        serverDocument,
        serverSyncState,
        announcement!,
      )
      const [respondedServerState, response] = Automerge.generateSyncMessage(
        serverDocument,
        serverSyncState,
      )
      serverSyncState = respondedServerState
      expect(response).toBeDefined()
      ;[offlineDocument, offlineSyncState] = Automerge.receiveSyncMessage(
        offlineDocument,
        offlineSyncState,
        response!,
      )
      offlineDocument = Automerge.change(offlineDocument, (document) => {
        document.offlineEdit = 'preserved'
      })
      const [changedOfflineState, offlineEditFrame] = Automerge.generateSyncMessage(
        offlineDocument,
        offlineSyncState,
      )
      offlineSyncState = changedOfflineState
      expect(offlineEditFrame).toBeDefined()

      const collection = new CollectionSynchronizer({
        networkReady: Promise.resolve(),
        priority: 1,
        ensureQuery: vi.fn(),
        loadSyncState: vi.fn(() => loadingSyncState),
        shareConfig: {
          announce: vi.fn(async () => false),
          access: vi.fn(async () => true),
        },
      })
      const updates = new Map<string, ReturnType<typeof vi.fn>>()
      const documents = new Map<string, typeof serverDocument>()
      const query = (documentId: string) => ({
        documentId,
        handle: (() => {
          let document = documentId === 'requested-document'
            ? serverDocument
            : Automerge.clone(serverDocument)
          documents.set(documentId, document)
          const update = vi.fn((callback: (doc: typeof document) => typeof document) => {
            document = callback(document)
            documents.set(documentId, document)
          })
          updates.set(documentId, update)
          return {
          documentId,
          fullDoc: vi.fn(() => document),
          update,
          on: vi.fn(),
          }
        })(),
        sourcePending: vi.fn(),
        sourceReady: vi.fn(),
        sourceUnavailable: vi.fn(),
        subscribe: vi.fn(),
        peek: vi.fn(() => ({ state: 'ready' })),
      })
      collection.attach(query('requested-document'))
      collection.attach(query('unrelated-document'))
      collection.addPeer('browser-peer')
      const openDoc = vi.fn()
      collection.on('open-doc', openDoc)

      expect(collection.docSynchronizers['requested-document']?.hasPeer('browser-peer')).toBe(false)
      expect(collection.docSynchronizers['unrelated-document']?.hasPeer('browser-peer')).toBe(false)

      collection.receiveMessage({
        type: 'sync',
        documentId: 'requested-document',
        senderId: 'browser-peer',
        data: offlineEditFrame,
      })

      expect(collection.docSynchronizers['requested-document']?.hasPeer('browser-peer')).toBe(true)
      expect(collection.docSynchronizers['unrelated-document']?.hasPeer('browser-peer')).toBe(false)
      // Descriptor reconciliation may revisit the retired head while the
      // persisted sync state/share policy is still loading. The request and
      // its pending frame must keep the peer alive through that race.
      expect(collection.forgetDocumentRequests('requested-document')).toBe(false)

      resolveSyncState(serverSyncState)
      await vi.waitFor(() => {
        expect(updates.get('requested-document')).toHaveBeenCalledTimes(1)
      })
      expect(Automerge.toJS(documents.get('requested-document')!)).toMatchObject({
        base: 'shared',
        offlineEdit: 'preserved',
      })
      expect(openDoc).toHaveBeenCalledTimes(1)
      expect(openDoc).toHaveBeenCalledWith({
        documentId: 'requested-document',
        peerId: 'browser-peer',
      })
    } finally {
      if (previous === undefined) delete process.env.AM_SELECTIVE_SYNC
      else process.env.AM_SELECTIVE_SYNC = previous
    }
  })

  it('installs one complete reconnect state machine and controlled storage errors', async () => {
    const [source, packageJson, collection, repo, storageSource, syncStateTracker, storageSubsystem, patchScript] = await Promise.all([
      readFile(installedSource, 'utf8'),
      readFile(installedPackage, 'utf8'),
      readFile(installedCollection, 'utf8'),
      readFile(installedRepo, 'utf8'),
      readFile(installedStorageSource, 'utf8'),
      readFile(installedSyncStateTracker, 'utf8'),
      readFile(installedStorageSubsystem, 'utf8'),
      readFile(patchScriptSource, 'utf8'),
    ])
    const version = (JSON.parse(packageJson) as { version: string }).version

    if (version.startsWith('2.6.')) {
      expect(source).toContain('#peers = new Map()')
      expect(source).toContain('completely replace any existing state here')
      expect(source).toContain('if (this.#peers.get(peerId) !== peer)')
      expect(source).toContain('pendingMessages: [...messages]')
      expect(source).toContain('hasRequested: messages.length > 0')
      expect(source).toContain('retirement cannot discard the peer and its message')
      expect(source).toContain('Do not traverse the complete document for every inbound frame')
      expect(source).toContain('AM_SYNC_DEBOUNCE_MS')
      expect(source).toContain('Math.max(25, Math.min(1000')
      expect(source).not.toContain('...A.stats(doc)')
      expect(source).toContain('size: A.stats(this.#handle.fullDoc())')
      expect(source).toContain('Coalesce document changes for one event-loop turn')
      expect(source).toContain('AM_SYNC_FANOUT_BATCH')
      expect(source).toContain('AM_SYNC_FANOUT_COALESCE_MS')
      expect(source).toContain('Math.max(0, Math.min(250')
      expect(source).toContain('A short, bounded window combines one burst')
      expect(source).toContain('const cooperativeYield = () => new Promise')
      const installedFanout = fanoutSchedulerSections(source)
      expect(installedFanout.cooperative).not.toContain('fanoutCoalesceMs')
      expect(installedFanout.scheduler).toContain('fanoutCoalesceMs')
      const templateStart = patchScript.indexOf('const stateMachineFanoutAfter = `')
      const templateEnd = patchScript.indexOf('const stateMachineEvaluateBefore', templateStart)
      // This intermediate template is subsequently migrated by patchFanoutHeadsSource.
      const templateFanout = fanoutSchedulerSections(patchScript.slice(templateStart, templateEnd), 'change')
      expect(templateFanout.cooperative).not.toContain('fanoutCoalesceMs')
      expect(templateFanout.scheduler).toContain('fanoutCoalesceMs')
      expect(source).toContain('while (fanoutPending)')
      expect(source).toContain('event: "automerge.fanout_failed"')
      expect(source).toContain('fanoutFailures <= 3')
      expect(source).toContain('fanoutRunning || fanoutScheduled')
      expect(source).toContain('handle.on("heads-changed", scheduleFanout)')
      expect(source).toContain('this.scheduleInboundEvaluation = scheduleFanout')
      expect(source).toMatch(/this\.scheduleInboundEvaluation\(\);\s+return;/)
      expect(source).not.toMatch(/this\.#receiveSyncMessage\(message\);\s+break;/)
      expect(source).toContain('Query transitions share the same single-flight scheduler')
      expect(source).not.toContain('queueMicrotask(() => this.#evaluate())')
      expect(source).toContain('Concurrent peer activations collapse into one drain')
      expect(source).not.toMatch(/peer\.dirty = true;\s+this\.#evaluate\(\);\s+}\s+#setPeerStatus/)
      expect(source).not.toContain('handle.on("change", asyncThrottle')
      expect(source).toContain('#evaluate(peerIds = null, preparedDoc = null, finalize = true, preparedContext = null)')
      expect(source).toContain('Materialize one immutable view per pass')
      expect(source).toContain('const preparedDoc = this.#handle.fullDoc()')
      expect(source).toContain('const preparedHeads = A.getHeads(preparedDoc)')
      expect(source).toContain('sharedHeads are an Automerge protocol proof')
      expect(source).toContain('peer?.syncState && !peer.dirty')
      expect(source).toContain('preparedHeads.every(head => sharedHeads.has(head))')
      expect(source).toContain('this.#evaluate(batch, preparedDoc, finalBatch, evaluationContext)')
      expect(source).toContain('Compute document-wide evaluation state once per')
      expect(source).toContain('if (!finalize)')
      expect(source).not.toContain('this.#evaluate(batch, this.#handle.fullDoc())')
      expect(source).toContain('this.#updateAvailability(doc)')
      expect(source).toContain('peer.supplierCaughtUp === true')
      expect(source).toContain('peer.supplierCaughtUp = true')
      expect(source).toContain('this.#supplierHasCaughtUp(doc, peer)')
      expect(source.match(/A\.hasHeads\(doc, peer\.status\.theirInitialHeads\)/g)).toHaveLength(1)
      expect(source).toContain('const sharedHeads = new Set(newSyncState.sharedHeads)')
      expect(source).toContain('peer.status.theirInitialHeads.every(head => sharedHeads.has(head))')
      expect(source).toContain('canForgetRequests()')
      expect(source).toContain('Avoid materializing a retired document when no peer requested it')
      expect(source).toContain('let heads;')
      expect(source).toContain('!peer.syncState || peer.dirty')
      expect(source).toContain('heads.every(head => sharedHeads.has(head))')
    } else {
      expect(source).toContain('if (!this.#peers.includes(peerId))')
      expect(source).toContain('Do not resurrect a')
      expect(source.match(/delete this\.#syncStates\[peerId\]/g)).toHaveLength(2)
    }
    expect(collection).toContain('forgetDocumentRequests(documentId)')
    expect(collection).toMatch(/#forgottenDocumentRequests\.has\(documentId\)\)\s+return true/)
    expect(collection).toContain('if (!synchronizer.canForgetRequests())')
    expect(collection).toContain('Never detach a requester before it has acknowledged')
    expect(collection).toContain('#forgottenDocumentRequests = new Set()')
    expect(collection).toContain('this.#forgottenDocumentRequests.add(documentId)')
    expect(collection).toContain('this.#forgottenDocumentRequests.has(documentId)')
    expect(collection).toContain('this.#forgottenDocumentRequests.delete(documentId)')
    expect(collection).toContain('Remember retirement even before the handle is attached')
    expect(collection).toContain('projector recovery attach into unsolicited fan-out')
    expect(collection).toContain('Selective sync binds peers only to documents they request')
    expect(collection).toContain('globalThis.process?.env?.AM_SELECTIVE_SYNC === "on"')
    expect(collection).toContain('globalThis.process?.env?.AM_SELECTIVE_SYNC !== "on"')
    expect(collection).toContain('retirementMetrics()')
    expect(collection).toContain('AM_RETIRED_SYNC_DOCUMENT_LIMIT')
    expect(repo).toContain('onStorageError: ({ documentId, error, operation })')
    expect(repo).toContain('AM_RESET_SYNC_STATE_ON_DISCONNECT')
    expect(repo).toContain('AM_PERSIST_SYNC_STATE')
    expect(repo).toContain('this.#syncStateTracker.resetStorage(storageId)')
    expect(repo).toContain('await this.#syncStateTracker.waitForStorageReset(storageId)')
    expect(storageSource).toContain('operation: "document"')
    expect(syncStateTracker).toContain('operation: "sync-state"')
    expect(syncStateTracker).toContain('this.#onStorageError?.({ documentId, error')
    expect(syncStateTracker).toContain('async resetStorage(storageId)')
    expect(syncStateTracker).toContain('async waitForStorageReset(storageId)')
    expect(syncStateTracker).toContain('AM_PERSIST_SYNC_STATE')
    expect(storageSubsystem).toContain('async removeSyncState(documentId, storageId)')
  })

  it('uses shared heads as the protocol proof that advertised supplier heads arrived', () => {
    let supplier = Automerge.from({ supplier: 0 })
    let receiver = Automerge.clone(supplier)
    supplier = Automerge.change(supplier, (document) => { document.supplier = 1 })
    receiver = Automerge.change(receiver, (document) => {
      ;(document as { receiver?: number }).receiver = 1
    })
    let supplierState = Automerge.initSyncState()
    let receiverState = Automerge.initSyncState()

    const advertisement = Automerge.generateSyncMessage(supplier, supplierState)
    supplierState = advertisement[0]
    expect(advertisement[1]).toBeDefined()
    const advertisedHeads = Automerge.decodeSyncMessage(advertisement[1]!).heads
    const received = Automerge.receiveSyncMessage(receiver, receiverState, advertisement[1]!)
    receiver = received[0]
    receiverState = received[1]

    // The first advertisement can carry only heads. Complete the protocol
    // round, then assert the cheap shared-head proof agrees with hasHeads().
    const response = Automerge.generateSyncMessage(receiver, receiverState)
    receiverState = response[0]
    expect(response[1]).toBeDefined()
    const supplierReceived = Automerge.receiveSyncMessage(supplier, supplierState, response[1]!)
    supplier = supplierReceived[0]
    supplierState = supplierReceived[1]
    const second = Automerge.generateSyncMessage(supplier, supplierState)
    expect(second[1]).toBeDefined()
    const secondHeads = Automerge.decodeSyncMessage(second[1]!).heads
    const receiverReceived = Automerge.receiveSyncMessage(receiver, receiverState, second[1]!)
    receiver = receiverReceived[0]
    receiverState = receiverReceived[1]

    expect(advertisedHeads.length).toBeGreaterThan(0)
    expect(secondHeads.every((head) => receiverState.sharedHeads.includes(head))).toBe(true)
    expect(Automerge.hasHeads(receiver, secondHeads)).toBe(true)
  })
})
