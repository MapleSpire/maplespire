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

import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { patchCooperativeEventsSource } from './patch-automerge-cooperative-events.mjs'
import { patchInFlightFanoutSource, verifyInFlightSdkVersion } from './patch-automerge-inflight-fanout.mjs'
import {
  patchCollectionSynchronizerSource,
  patchDocHandleOutdatedChangeSource,
  patchDocSynchronizerSource,
  patchRepoBackgroundSaveSource,
  patchStorageSourceBackgroundSaveSource,
  patchStorageSubsystemSyncStateSource,
  patchStorageSubsystemBulkLoadSource,
  patchStorageSubsystemSource,
  patchSyncStateTrackerBackgroundSaveSource,
  patchAsyncThrottleSource,
} from './patch-automerge-peer-sync-state.mjs'

const readyAfter = `            this.#networkReady = true;
            this.scheduleInboundEvaluation();`
const readyBefore = readyAfter.replace('this.scheduleInboundEvaluation();', 'this.#evaluate();')
test('in-flight optimization refuses unreviewed SDK versions', () => {
  assert.doesNotThrow(() => verifyInFlightSdkVersion({ name: '@automerge/automerge', version: '3.2.6' }))
  for (const info of [ {}, { name: '@automerge/automerge', version: '3.2.7' }, { name: 'other', version: '3.2.6' } ]) {
    assert.throws(() => verifyInFlightSdkVersion(info), /Unsupported Automerge SDK/)
  }
})
test('in-flight optimization migrates once and refuses changed, mixed or duplicated blocks', () => {
  const before = '                                if (!preparedHeads.every(head => sharedHeads.has(head)))\n                                    peer.dirty = true;'
  const patched = patchInFlightFanoutSource(before)
  assert.equal(patched.changed, true)
  assert.equal(patchInFlightFanoutSource(patched.source).changed, false)
  for (const source of [ '', before + before, patched.source + before, patched.source + patched.source,
    patched.source.replace('state.inFlight === true', 'state.inFlight !== false') ]) {
    assert.throws(() => patchInFlightFanoutSource(source), /Unsupported automerge-repo/)
  }
})
for (const [name, alter] of [
  ['duplicate patched entry', source => source + '\n' + readyAfter],
  ['mixed old and patched entry', source => source + '\n' + readyBefore],
  ['missing expected entry', source => source.replace(readyAfter, '')],
  ['unknown direct entry', source => source + '\nthis.#evaluate();'],
]) {
  test(`cooperative patch refuses ${name}`, () => {
    const source = readFileSync(new URL('./node_modules/@automerge/automerge-repo/dist/synchronizer/DocSynchronizer.js', import.meta.url), 'utf8')
    assert.equal(patchCooperativeEventsSource(source).changed, false)
    assert.throws(() => patchCooperativeEventsSource(alter(source)), /Unsupported automerge-repo/)
  })
}

const storageSubsystemLoadDoc = `class StorageSubsystem {
    async loadDoc(documentId) {
        const binary = await this.loadDocData(documentId);
        if (!binary)
            return null;
        const start = performance.now();
        const newDoc = A.loadIncremental(A.init(), binary);
        const end = performance.now();
        return newDoc;
    }
}`

test('loads stored documents in bulk instead of through the patch pipeline', () => {
  const patched = patchStorageSubsystemBulkLoadSource(storageSubsystemLoadDoc)
  assert.equal(patched.changed, true)
  assert.match(patched.source, /newDoc = A\.load\(binary\)/)
  assert.equal(patchStorageSubsystemBulkLoadSource(patched.source).changed, false)
})

test('keeps loadIncremental as the recovery path for shapes A.load alone rejects', () => {
  const patched = patchStorageSubsystemBulkLoadSource(storageSubsystemLoadDoc)
  // A.load is STRICTER than loadIncremental (e.g. it rejects trailing garbage),
  // so the fallback reproduces the pre-patch result for those. It does NOT make
  // damaged storage safe: shapes both reject still throw out of loadDoc.
  assert.match(patched.source, /catch \(error\) \{/)
  assert.match(patched.source, /newDoc = A\.loadIncremental\(A\.init\(\), binary\);/)
})

test('reports the fallback instead of swallowing it', () => {
  const patched = patchStorageSubsystemBulkLoadSource(storageSubsystemLoadDoc)
  // A silent catch would let an upgrade that breaks A.load make boots SLOWER
  // than before the patch while every check still passed.
  assert.match(patched.source, /this\.#log\.warn\(/)
})

test('emits parseable JavaScript', () => {
  // The patched text is written straight into node_modules. A missing `let`
  // would only surface as a ReferenceError on every document load at runtime.
  const patched = patchStorageSubsystemBulkLoadSource(storageSubsystemLoadDoc)
  assert.match(patched.source, /let newDoc;/)
  assert.doesNotThrow(() => new vm.Script(`class C { #log = console; ${
    patched.source.replace(/^class StorageSubsystem \{/, '').replace(/\}$/, '')
  } }`))
})

test('uses the bulk-loaded document rather than merely mentioning it', () => {
  const patched = patchStorageSubsystemBulkLoadSource(storageSubsystemLoadDoc)
  // Asserting only that the string `A.load(binary)` appears would still pass if
  // an incremental load were appended after it inside the same try block.
  const tryBody = /try \{([\s\S]*?)\}\s*\n?\s*catch/.exec(patched.source)?.[1] ?? ''
  assert.match(tryBody, /newDoc = A\.load\(binary\);/)
  assert.doesNotMatch(tryBody, /loadIncremental/)
})

test('still reports changed when only the sync-state half was applied', () => {
  // A long-lived node_modules can carry one patch and not the other. If the
  // composite reported changed:false there, postinstall would skip the file and
  // --check would call it verified.
  const halfPatched = `class StorageSubsystem {
    async saveSyncState(documentId, storageId, syncState) {
        const key = [documentId, "sync-state", storageId];
        await this.#storageAdapter.save(key, A.encodeSyncState(syncState));
    }
    async removeSyncState(documentId, storageId) {
        const key = [documentId, "sync-state", storageId];
        await this.#storageAdapter.remove(key);
    }
    async loadDoc(documentId) {
        const binary = await this.loadDocData(documentId);
        const newDoc = A.loadIncremental(A.init(), binary);
        return newDoc;
    }
}`
  const patched = patchStorageSubsystemSource(halfPatched)
  assert.equal(patched.changed, true)
  assert.match(patched.source, /newDoc = A\.load\(binary\)/)
  assert.equal(patchStorageSubsystemSource(patched.source).changed, false)
})

test('does not report already-patched for an unguarded A.load', () => {
  // A future automerge-repo (or a botched merge) could carry `A.load(binary)`
  // with no fallback. Keying idempotency on that string would leave it unguarded.
  const unguarded = storageSubsystemLoadDoc.replace(
    'const newDoc = A.loadIncremental(A.init(), binary);',
    'const newDoc = A.load(binary);',
  )
  assert.throws(
    () => patchStorageSubsystemBulkLoadSource(unguarded),
    /Unsupported @automerge\/automerge-repo StorageSubsystem loadDoc/,
  )
})

test('rejects an unrecognised loadDoc rather than silently skipping the bulk-load patch', () => {
  assert.throws(
    () => patchStorageSubsystemBulkLoadSource('class StorageSubsystem { async loadDoc() { return null } }'),
    /Unsupported @automerge\/automerge-repo StorageSubsystem loadDoc/,
  )
})

test('applies both StorageSubsystem patches together and stays idempotent', () => {
  const source = `class StorageSubsystem {
    async saveSyncState(documentId, storageId, syncState) {
        const key = [documentId, "sync-state", storageId];
        await this.#storageAdapter.save(key, A.encodeSyncState(syncState));
    }
    async loadDoc(documentId) {
        const binary = await this.loadDocData(documentId);
        const newDoc = A.loadIncremental(A.init(), binary);
        return newDoc;
    }
}`
  const patched = patchStorageSubsystemSource(source)
  assert.equal(patched.changed, true)
  assert.match(patched.source, /async removeSyncState\(documentId, storageId\)/)
  assert.match(patched.source, /newDoc = A\.load\(binary\)/)
  assert.equal(patchStorageSubsystemSource(patched.source).changed, false)
})

test('clamps elapsed async-throttle delays before passing them to setTimeout', () => {
  const source = `        const wait = lastCall + delay - Date.now(); //if negative, executes immediately
        return new Promise((resolve, reject) => {
            timeout = setTimeout(async () => {`
  const patched = patchAsyncThrottleSource(source)

  assert.equal(patched.changed, true)
  assert.match(patched.source, /Math\.max\(0, lastCall \+ delay - Date\.now\(\)\)/)
  assert.equal(patchAsyncThrottleSource(patched.source).changed, false)
})

test('responds to an inbound sync message from the merged document state', () => {
  const source = `class DocSynchronizer {
    syncDebounceRate = 100;
    #peers = [];
    #pendingSyncStateCallbacks = {};
    #peerDocumentStatuses = {};
    #syncStates = {};
    #syncStarted = false;
    constructor({ handle }) {
        this.#handle = handle;
        handle.on("change", asyncThrottle(() => this.#syncWithPeers(), this.syncDebounceRate));
    }
    async #syncWithPeers() {
        try {
            await this.#handle.whenReady();
            const doc = this.#handle.doc(); // XXX THIS ONE IS WEIRD
            this.#peers.forEach(peerId => this.#sendSyncMessage(peerId, doc));
        }
        catch (e) {
            console.log("sync with peers threw an exception");
        }
    }
    #withSyncState(peerId, callback) {
        this.#addPeer(peerId);
        if (!(peerId in this.#peerDocumentStatuses)) {
            this.#peerDocumentStatuses[peerId] = "unknown";
        }
    }
    #initSyncState(peerId, syncState) {
        const pendingCallbacks = this.#pendingSyncStateCallbacks[peerId];
        if (pendingCallbacks) {
            for (const callback of pendingCallbacks) {
                callback(syncState);
            }
        }
        delete this.#pendingSyncStateCallbacks[peerId];
        this.#syncStates[peerId] = syncState;
    }
    #addPeer(peerId) {
        if (!this.#peers.includes(peerId)) {
            this.#peers.push(peerId);
            this.emit("open-doc", { documentId: this.documentId, peerId });
        }
    }
    endSync(peerId) {
        this.#log(\`removing peer \${peerId}\`);
        this.#peers = this.#peers.filter(p => p !== peerId);
        delete this.#peerDocumentStatuses[peerId];
        this.#checkDocUnavailable();
    }
    receive(message, doc, newDoc) {
                this.#sendSyncMessage(message.senderId, doc);
    }
}`
  const patched = patchDocSynchronizerSource(source)
  assert.equal(patched.changed, true)
  assert.match(patched.source, /sendSyncMessage\(message\.senderId, newDoc\)/)
  assert.doesNotMatch(patched.source, /sendSyncMessage\(message\.senderId, doc\)/)
  assert.match(patched.source, /AM_SYNC_DEBOUNCE_MS/)
  assert.match(patched.source, /Math\.max\(25, Math\.min\(1000/)
  assert.match(patched.source, /#resetSyncStatePeers = new Set\(\)/)
  assert.match(patched.source, /this\.#setSyncState\(peerId, A\.initSyncState\(\)\)/)
  assert.match(patched.source, /this\.#resetSyncStatePeers\.delete\(peerId\)/)
  assert.doesNotMatch(patched.source, /AM_SYNC_FANOUT_BATCH/)
  assert.doesNotMatch(patched.source, /Repeat a pass when document heads changed/)
  assert.match(patched.source, /this\.#peers\.forEach\(peerId => this\.#sendSyncMessage\(peerId, doc\)\)/)
  assert.equal(patchDocSynchronizerSource(patched.source).changed, false)
})

test('reverts a cooperative fan-out patch to one atomic protocol pass', () => {
  const source = `class DocSynchronizer {
${fanoutFixture()}
}`
  const patched = patchDocSynchronizerSource(source)
  assert.equal(patched.changed, true)
  assert.doesNotMatch(patched.source, /AM_SYNC_FANOUT_BATCH/)
  assert.doesNotMatch(patched.source, /Repeat a pass when document heads changed/)
  assert.match(patched.source, /this\.#peers\.forEach\(peerId => this\.#sendSyncMessage\(peerId, doc\)\)/)
})

function fanoutFixture() {
  return `    // A sync hub benefits from a wider coalescing window than browser peers.
    // Keep the upstream 100ms default unless the server explicitly opts in.
    syncDebounceRate = (() => {
        const configured = Number(globalThis.process?.env?.AM_SYNC_DEBOUNCE_MS);
        return Number.isFinite(configured)
            ? Math.max(25, Math.min(1000, Math.trunc(configured)))
            : 100;
    })();
    #peers = [];
    #pendingSyncStateCallbacks = {};
    #resetSyncStatePeers = new Set();
    #peerDocumentStatuses = {};
    #syncStates = {};
    #syncStarted = false;
    constructor({ handle }) {
        this.#handle = handle;
        handle.on("change", asyncThrottle(() => this.#syncWithPeers(), this.syncDebounceRate));
    }
    async #syncWithPeers() {
        try {
            await this.#handle.whenReady();
            // Generating a sync message is CPU-heavy. A hub with dozens of
            // peers yields between bounded batches so HTTP and lease callbacks
            // remain responsive. Repeat a pass when document heads changed
            // during its yields; every peer then observes one stable final pass.
            let passHeads = A.getHeads(this.#handle.doc());
            while (true) {
                const peers = [...this.#peers];
                const configuredBatch = Number(globalThis.process?.env?.AM_SYNC_FANOUT_BATCH);
                const batchSize = Number.isFinite(configuredBatch)
                    ? Math.max(1, Math.min(peers.length || 1, Math.trunc(configuredBatch)))
                    : peers.length || 1;
                for (let offset = 0; offset < peers.length; offset += batchSize) {
                    const doc = this.#handle.doc();
                    for (const peerId of peers.slice(offset, offset + batchSize)) {
                        if (this.#peers.includes(peerId))
                            this.#sendSyncMessage(peerId, doc);
                    }
                    if (offset + batchSize < peers.length) {
                        await new Promise(resolve => {
                            const schedule = globalThis.setImmediate ??
                                (callback => globalThis.setTimeout(callback, 0));
                            schedule(resolve);
                        });
                    }
                }
                const latestHeads = A.getHeads(this.#handle.doc());
                const stable = passHeads.length === latestHeads.length &&
                    passHeads.every((head, index) => head === latestHeads[index]);
                if (stable)
                    break;
                passHeads = latestHeads;
            }
        }
        catch (e) {
            console.log("sync with peers threw an exception");
        }
    }
    #withSyncState(peerId, callback) {
        this.#addPeer(peerId);
        if (this.#resetSyncStatePeers.delete(peerId)) {
            this.#syncStates[peerId] = A.initSyncState();
        }
        if (!(peerId in this.#peerDocumentStatuses)) {
            this.#peerDocumentStatuses[peerId] = "unknown";
        }
    }
    #initSyncState(peerId, syncState) {
        // A storage read may resolve after the socket closed. Do not resurrect a
        // native Automerge sync state for an inactive peer.
        if (!this.#peers.includes(peerId)) {
            delete this.#pendingSyncStateCallbacks[peerId];
            delete this.#syncStates[peerId];
            return;
        }
        const pendingCallbacks = this.#pendingSyncStateCallbacks[peerId];
        if (pendingCallbacks) {
            for (const callback of pendingCallbacks) {
                callback(syncState);
            }
        }
        delete this.#pendingSyncStateCallbacks[peerId];
        this.#syncStates[peerId] = syncState;
    }
    #addPeer(peerId) {
        if (!this.#peers.includes(peerId)) {
            this.#peers.push(peerId);
            this.emit("open-doc", { documentId: this.documentId, peerId });
        }
    }
    endSync(peerId) {
        this.#log(\`removing peer \${peerId}\`);
        this.#peers = this.#peers.filter(p => p !== peerId);
        delete this.#peerDocumentStatuses[peerId];
        // A send records sync state before the network write. If that write is
        // lost, reloading the persisted state on reconnect falsely claims the
        // peer has heads it never received. Persist an empty state and also
        // bypass a racing storage read on the immediate reconnect.
        this.#setSyncState(peerId, A.initSyncState());
        this.#resetSyncStatePeers.add(peerId);
        delete this.#pendingSyncStateCallbacks[peerId];
        delete this.#syncStates[peerId];
        this.#checkDocUnavailable();
    }
    receive(message, doc, newDoc) {
                // Respond from the merged state. automerge-repo 2.5.6 uses
                // the pre-receive snapshot here, forcing an avoidable extra
                // broadcast round and leaving reconnecting peers with stale heads.
                this.#sendSyncMessage(message.senderId, newDoc);
    }`
}

test('patches collection synchronizers to forget retired document requests', () => {
  const source = `class CollectionSynchronizer {
    /** Returns a list of all connected peer ids */
    get peers() {
        return Array.from(this.#peers);
    }
}`
  const patched = patchCollectionSynchronizerSource(source)
  assert.equal(patched.changed, true)
  assert.match(patched.source, /forgetDocumentRequests\(documentId\)/)
  assert.match(patched.source, /this\.#hasRequested\.delete\(documentId\)/)
  assert.match(patched.source, /synchronizer\.endSync\(peerId\)/)
  assert.equal(patchCollectionSynchronizerSource(patched.source).changed, false)
})

test('keeps retired state-machine documents out of future peer fan-out until a late message arrives', () => {
  const source = `class CollectionSynchronizer {
    #peers = new Set();
    #docSynchronizers = {};
    #denylist;
    attach(query) {
        const docSync = this.#initDocSynchronizer(query.handle, query);
        this.#docSynchronizers[query.documentId] = docSync;
        for (const peerId of this.#peers) {
            this.#addPeerToDoc(peerId, docSync, []);
        }
    }
    addPeer(peerId) {
        this.#log.debug(\`adding \${peerId} & synchronizing with them\`);
        this.#peers.add(peerId);
        for (const docSync of Object.values(this.#docSynchronizers)) {
            this.#addPeerToDoc(peerId, docSync, []);
        }
    }
    receiveMessage(message) {
        const documentId = message.documentId;
        let docSync = this.#docSynchronizers[documentId];
        if (!docSync.hasPeer(message.senderId)) {
            this.#addPeerToDoc(message.senderId, docSync, [message]);
        }
    }
    get peers() {
        return Array.from(this.#peers);
    }
  }`
  const patched = patchCollectionSynchronizerSource(source)
  assert.equal(patched.changed, true)
  assert.match(patched.source, /#forgottenDocumentRequests = new Set\(\)/)
  assert.match(patched.source, /this\.#forgottenDocumentRequests\.add\(documentId\)/)
  assert.match(patched.source, /this\.#forgottenDocumentRequests\.has\(documentId\)/)
  assert.match(patched.source, /this\.#forgottenDocumentRequests\.delete\(documentId\)/)
  assert.match(patched.source, /projector recovery attach into unsolicited fan-out/)
  assert.match(patched.source, /Selective sync binds peers only to documents they request/)
  assert.equal(patchCollectionSynchronizerSource(patched.source).changed, false)
})

test('turns rejected fire-and-forget Repo saves into controlled events', () => {
  const source = `class Repo {
    save(handle, doc) {
                void fn({ handle, doc });
    }
}`
  const patched = patchRepoBackgroundSaveSource(source)
  assert.equal(patched.changed, true)
  assert.match(patched.source, /void fn\(\{ handle, doc \}\)\.catch\(error =>/)
  assert.match(patched.source, /this\.emit\("storage-error", \{ documentId: handle\.documentId, error \}\)/)
  assert.equal(patchRepoBackgroundSaveSource(patched.source).changed, false)
})

test('turns rejected throttled sync-state saves into controlled events', () => {
  const source = `class SyncStateTracker {
    #throttledSaveSyncStateHandlers = {};
    constructor(storage, saveDebounceRate) {
        this.#storage = storage;
        this.#saveDebounceRate = saveDebounceRate;
    }
    delete(documentId) {
        delete this.#syncInfo[documentId];
    }
    save(storageId, payload) {
        if (!this.#storage) {
            return;
        }
        if (!storageId || isEphemeral) {
            return;
        }
            handler = this.#throttledSaveSyncStateHandlers[storageId] = asyncThrottle(({ documentId, syncState }) => this.#storage.saveSyncState(documentId, storageId, syncState), this.#saveDebounceRate);
        void handler(payload);
    }
  }`
  const patched = patchSyncStateTrackerBackgroundSaveSource(source)
  assert.equal(patched.changed, true)
  assert.match(patched.source, /#onStorageError/)
  assert.match(patched.source, /operation: "sync-state"/)
  assert.match(patched.source, /\.catch\(error/)
  assert.match(patched.source, /async resetStorage\(storageId\)/)
  assert.match(patched.source, /async waitForStorageReset\(storageId\)/)
  assert.match(patched.source, /removeSyncState\(documentId, storageId\)/)
  assert.match(patched.source, /AM_PERSIST_SYNC_STATE/)
  assert.equal(patchSyncStateTrackerBackgroundSaveSource(patched.source).changed, false)
})

test('adds an exact-key persisted sync-state removal boundary', () => {
  const source = `class StorageSubsystem {
    async saveSyncState(documentId, storageId, syncState) {
        const key = [documentId, "sync-state", storageId];
        await this.#storageAdapter.save(key, A.encodeSyncState(syncState));
    }
  }`
  const patched = patchStorageSubsystemSyncStateSource(source)
  assert.equal(patched.changed, true)
  assert.match(patched.source, /async removeSyncState\(documentId, storageId\)/)
  assert.match(patched.source, /this\.#storageAdapter\.remove\(key\)/)
  assert.equal(patchStorageSubsystemSyncStateSource(patched.source).changed, false)
})

test('retries only outdated local changes on a writable clone', () => {
  const source = `class DocHandle {
    change(callback, options = {}) {
        this.#sendUpdate(doc => A.change(doc, options, callback));
    }
}`
  const patched = patchDocHandleOutdatedChangeSource(source)
  assert.equal(patched.changed, true)
  assert.match(patched.source, /error instanceof RangeError/)
  assert.match(patched.source, /Attempting to change an outdated document/)
  assert.match(patched.source, /A\.clone\(doc, A\.getActorId\(doc\)\)/)
  assert.match(patched.source, /throw error/)
  assert.equal(patchDocHandleOutdatedChangeSource(patched.source).changed, false)
})

test('preserves the 2.6 per-connection state machine and patches its storage boundary', () => {
  const docSource = `class DocSynchronizer {
    syncDebounceRate = 100;
    #peers = new Map();
    constructor(handle) {
        query.subscribe(() => {
            queueMicrotask(() => this.#evaluate());
        });
        handle.on("change", asyncThrottle(async () => {
            // Mark all active peers dirty — we have new data to send.
            for (const peer of this.#peers.values()) {
                if (peer.syncState)
                    peer.dirty = true;
            }
            this.#evaluate();
        }, this.syncDebounceRate));
        networkReady.then(() => {
            this.#networkReady = true;
            this.#evaluate();
        });
    }
    addPeer(peerId, syncState, { messages = [] } = {}) {
      // Note that we completely replace any existing state here.
      this.#peers.set(peerId, {
            pendingMessages: [...messages],
            dirty: true,
            hasRequested: false,
      });
    }
    removePeer(peerId) {
        this.#peers.delete(peerId);
        this.emit("peer-status", {
            peerId,
            status: "unavailable",
        });
        this.#evaluate();
    }
    reevaluateSharePolicy() {
        for (const peer of this.#peers.values()) {
            resolvePolicy(peer).then(() => {
                peer.dirty = true;
                this.#evaluate();
            });
        }
    }
    syncAllPeers() {
        for (const peer of this.#peers.values()) {
            if (peer.syncState)
                peer.dirty = true;
        }
        this.#evaluate();
    }
    hasPeer(peerId) {
        return this.#peers.has(peerId);
    }
    receiveMessage(message) {
        switch (message.type) {
            case "sync":
            case "request":
                this.#receiveSyncMessage(message);
                break;
            case "ephemeral":
                this.#receiveEphemeralMessage(message);
                break;
            case "doc-unavailable":
                this.#setPeerStatus(message.senderId, { type: "unavailable" });
                break;
            default:
                throw new Error(\`unknown message type: \${message.type}\`);
        }
        this.#evaluate();
    }
    #evaluate() {
        const doc = this.#handle.fullDoc();
        const weHaveData = A.getHeads(doc).length > 0;
        const supplierExists = this.#anyActivePeerOfType("has");
        // Check whether we've caught up with all suppliers' initial heads.
        // Until we have, we shouldn't respond to requestors.
        const awaitingSupplierData = supplierExists && this.#hasPendingSupplierHeads(doc);
        // Phase 1: Send outbound sync messages to dirty peers.
        for (const [peerId, peer] of this.#peers) {
            if (!peer.dirty) continue;
            peer.dirty = false;
            this.#sendSyncMessage(peerId, peer, doc);
        }
        this.#updateAvailability();
    }
    #updateAvailability() {
        if (this.#hasCaughtUpToAnySupplier(this.#handle.fullDoc())) {
            this.#query.sourceReady("automerge-sync");
        }
    }
    #hasPendingSupplierHeads(doc) {
        for (const peer of this.#peers.values()) {
            if (peer.status.type !== "has")
                continue;
            if (peer.sharePolicyState === "denied")
                continue;
            if (!A.hasHeads(doc, peer.status.theirInitialHeads))
                return true;
        }
        return false;
    }
    #hasCaughtUpToAnySupplier(doc) {
        for (const peer of this.#peers.values()) {
            if (peer.status.type !== "has")
                continue;
            if (peer.sharePolicyState === "denied")
                continue;
            if (A.hasHeads(doc, peer.status.theirInitialHeads))
                return true;
        }
        return false;
    }
    #activatePeer(peerId, peer) {
        if (peer.sharePolicyState === "denied") {
            this.#evaluate();
            return;
        }
        // Only emit "open-doc" when the peer has interacted.
        const queued = peer.pendingMessages;
        peer.pendingMessages = [];
        for (const msg of queued) {
            this.#receiveSyncMessage(msg);
        }
        // After draining, mark dirty so #evaluate sends the initial sync.
        peer.dirty = true;
        this.#evaluate();
    }
    #setPeerStatus(peerId, status) {}
    receive(doc, message) {
            const peer = this.#peers.get("peer");
            const newSyncState = { sharedHeads: [] };
            peer.syncState = newSyncState;
            this.emit("sync-state", {
                peerId: "peer"
            });
      this.emit("metrics", {
                type: "receive-sync-message",
                fromPeer: message.senderId,
                ...A.stats(doc),
      });
    }
  }`
  const docPatched = patchDocSynchronizerSource(docSource)
  assert.equal(docPatched.changed, true)
  assert.doesNotMatch(docPatched.source, /\.\.\.A\.stats\(doc\)/)
  assert.match(docPatched.source, /Do not traverse the complete document for every inbound frame/)
  assert.match(docPatched.source, /messageBytes: message\.data\.byteLength/)
  assert.match(docPatched.source, /AM_SYNC_DEBOUNCE_MS/)
  assert.match(docPatched.source, /Math\.max\(25, Math\.min\(1000/)
  assert.match(docPatched.source, /Coalesce document changes for one event-loop turn/)
  assert.match(docPatched.source, /AM_SYNC_FANOUT_BATCH/)
  assert.match(docPatched.source, /const cooperativeYield = \(\) => new Promise/)
  assert.match(docPatched.source, /while \(fanoutPending\)/)
  assert.match(docPatched.source, /fanoutRunning \|\| fanoutScheduled/)
  assert.match(docPatched.source, /handle\.on\("heads-changed", scheduleFanout\)/)
  assert.match(docPatched.source, /this\.scheduleInboundEvaluation = scheduleFanout/)
  assert.match(docPatched.source, /this\.scheduleInboundEvaluation\(\);\s+return;/)
  assert.doesNotMatch(docPatched.source, /this\.#receiveSyncMessage\(message\);\s+break;/)
  assert.match(docPatched.source, /Query transitions share the same single-flight scheduler/)
  assert.doesNotMatch(docPatched.source, /queueMicrotask\(\(\) => this\.#evaluate\(\)\)/)
  assert.match(docPatched.source, /Concurrent peer activations collapse into one drain/)
  assert.doesNotMatch(docPatched.source, /peer\.dirty = true;\s+this\.#evaluate\(\);\s+}\s+#setPeerStatus/)
  assert.doesNotMatch(docPatched.source, /handle\.on\("change", asyncThrottle/)
  assert.match(docPatched.source, /#evaluate\(peerIds = null, preparedDoc = null, finalize = true, preparedContext = null\)/)
  assert.match(docPatched.source, /Materialize one immutable view per pass/)
  assert.match(docPatched.source, /const preparedDoc = this\.#handle\.fullDoc\(\)/)
  assert.match(docPatched.source, /automerge\.fanout_prepare_slow/)
  assert.match(docPatched.source, /this\.#evaluate\(batch, preparedDoc, finalBatch, evaluationContext\)/)
  assert.match(docPatched.source, /Compute document-wide evaluation state once per/)
  assert.match(docPatched.source, /if \(!finalize\)/)
  assert.doesNotMatch(docPatched.source, /this\.#evaluate\(batch, this\.#handle\.fullDoc\(\)\)/)
  assert.match(docPatched.source, /this\.#updateAvailability\(doc\)/)
  assert.match(docPatched.source, /peerIds\s*\.map\(peerId => \[peerId, this\.#peers\.get\(peerId\)\]\)/)
  assert.match(docPatched.source, /peer\.supplierCaughtUp === true/)
  assert.match(docPatched.source, /peer\.supplierCaughtUp = true/)
  assert.match(docPatched.source, /this\.#supplierHasCaughtUp\(doc, peer\)/)
  assert.equal((docPatched.source.match(/A\.hasHeads\(doc, peer\.status\.theirInitialHeads\)/g) ?? []).length, 1)
  assert.match(docPatched.source, /const sharedHeads = new Set\(newSyncState\.sharedHeads\)/)
  assert.match(docPatched.source, /automerge\.fanout_failed/)
  assert.match(docPatched.source, /fanoutFailures <= 3/)
  assert.match(docPatched.source, /peer\.status\.theirInitialHeads\.every\(head => sharedHeads\.has\(head\)\)/)
  assert.match(docPatched.source, /canForgetRequests\(\)/)
  assert.match(docPatched.source, /Avoid materializing a retired document when no peer requested it/)
  assert.match(docPatched.source, /let heads;/)
  assert.match(docPatched.source, /!peer\.syncState \|\| peer\.dirty/)
  assert.match(docPatched.source, /heads\.every\(head => sharedHeads\.has\(head\)\)/)
  assert.match(docPatched.source, /hasRequested: messages\.length > 0/)
  assert.match(docPatched.source, /retirement cannot discard the peer and its message/)
  assert.equal(patchDocSynchronizerSource(docPatched.source).changed, false)

  // A previous patch revision had already installed prepared-document fan-out
  // and the slow-preparation diagnostic, but still evaluated document-wide
  // state once per peer batch. This is the exact ordering that existed in a
  // long-lived root node_modules and used to make postinstall abort instead of
  // migrating it.
  const partiallyPatched = docPatched.source
    .replace(`                    // Compute document-wide evaluation state once per
                    // cooperative pass. #evaluate runs once per small peer
                    // batch, so repeating these full peer scans and heads
                    // checks in every batch made a 50-peer pass quadratic.
                    const supplierExists = this.#anyActivePeerOfType("has");
                    const evaluationContext = {
                        weHaveData: preparedHeads.length > 0,
                        supplierExists,
                        awaitingSupplierData: supplierExists && this.#hasPendingSupplierHeads(preparedDoc),
                    };
                    const peerIds = Array.from(this.#peers.keys());`,
    '                    const peerIds = Array.from(this.#peers.keys());')
    .replace(
      '                        this.#evaluate([], preparedDoc, true, evaluationContext);',
      '                        this.#evaluate([], preparedDoc);',
    )
    .replace(`                        const finalBatch = offset + batchSize >= peerIds.length;
                        this.#evaluate(batch, preparedDoc, finalBatch, evaluationContext);`,
    '                        this.#evaluate(batch, preparedDoc);')
    .replace(
      '    #evaluate(peerIds = null, preparedDoc = null, finalize = true, preparedContext = null) {',
      '    #evaluate(peerIds = null, preparedDoc = null) {',
    )
    .replace(`        const weHaveData = preparedContext?.weHaveData ?? A.getHeads(doc).length > 0;
        const supplierExists = preparedContext?.supplierExists ?? this.#anyActivePeerOfType("has");
        // Check whether we've caught up with all suppliers' initial heads.
        // Until we have, we shouldn't respond to requestors.
        const awaitingSupplierData = preparedContext?.awaitingSupplierData ??
            (supplierExists && this.#hasPendingSupplierHeads(doc));`,
    `        const weHaveData = A.getHeads(doc).length > 0;
        const supplierExists = this.#anyActivePeerOfType("has");
        // Check whether we've caught up with all suppliers' initial heads.
        // Until we have, we shouldn't respond to requestors.
        const awaitingSupplierData = supplierExists && this.#hasPendingSupplierHeads(doc);`)
    .replace(`        // Availability and unavailable notifications are document-wide. A
        // cooperative pass finalizes them once after its last peer batch.
        if (!finalize)
            return;
        this.#updateAvailability(doc);`,
    '        this.#updateAvailability(doc);')

  assert.doesNotMatch(partiallyPatched, /Compute document-wide evaluation state once per/)
  assert.match(partiallyPatched, /automerge\.fanout_prepare_slow/)
  const migratedPartial = patchDocSynchronizerSource(partiallyPatched)
  assert.equal(migratedPartial.changed, true)
  assert.match(migratedPartial.source, /Compute document-wide evaluation state once per/)
  assert.equal(patchDocSynchronizerSource(migratedPartial.source).changed, false)

  const collectionSource = `class CollectionSynchronizer {
    #peers = new Set();
    #docSynchronizers = {};
    #denylist;
    attach(query) {
        const docSync = this.#initDocSynchronizer(query.handle, query);
        this.#docSynchronizers[query.documentId] = docSync;
        for (const peerId of this.#peers) {
            this.#addPeerToDoc(peerId, docSync, []);
        }
    }
    addPeer(peerId) {
        this.#log.debug(\`adding \${peerId} & synchronizing with them\`);
        this.#peers.add(peerId);
        for (const docSync of Object.values(this.#docSynchronizers)) {
            this.#addPeerToDoc(peerId, docSync, []);
        }
    }
    removePeer(peerId) {
      for (const synchronizer of Object.values(this.#docSynchronizers))
        synchronizer.removePeer(peerId);
    }
    receiveMessage(message) {
        const documentId = message.documentId;
        let docSync = this.#docSynchronizers[documentId];
        if (!docSync.hasPeer(message.senderId)) {
            this.#addPeerToDoc(message.senderId, docSync, [message]);
        }
    }
    get peers() { return Array.from(this.#peers); }
  }`
  const collectionPatched = patchCollectionSynchronizerSource(collectionSource)
  assert.equal(collectionPatched.changed, true)
  assert.match(collectionPatched.source, /this\.#docSynchronizers\[documentId\]/)
  assert.match(collectionPatched.source, /!synchronizer\.canForgetRequests\(\)/)
  assert.match(collectionPatched.source, /this\.#forgottenDocumentRequests\.has\(documentId\)\)\s+return true/)
  assert.match(collectionPatched.source, /return false/)
  assert.match(collectionPatched.source, /synchronizer\.removePeer\(peerId\)/)
  assert.match(collectionPatched.source, /#forgottenDocumentRequests/)
  assert.match(collectionPatched.source, /Selective sync binds peers only to documents they request/)
  assert.match(collectionPatched.source, /AM_SELECTIVE_SYNC === "on"/)
  assert.match(collectionPatched.source, /AM_SELECTIVE_SYNC !== "on"/)
  assert.equal(patchCollectionSynchronizerSource(collectionPatched.source).changed, false)

  const repoSource = `class Repo {
    constructor(storageSubsystem, saveDebounceRate) {
        this.#syncStateTracker = new SyncStateTracker(this.storageSubsystem, saveDebounceRate);
      if (storageSubsystem) {
            this.#sources.set("storage", new StorageSource(storageSubsystem, saveDebounceRate));
      }
    }
  }`
  const repoPatched = patchRepoBackgroundSaveSource(repoSource)
  assert.equal(repoPatched.changed, true)
  assert.match(repoPatched.source, /onStorageError/)
  assert.match(repoPatched.source, /operation/)
  assert.match(repoPatched.source, /this\.emit\("storage-error"/)

  const storageSource = `class StorageSource {
    #saveFns = {};
    constructor(storage, saveDebounceRate, { priority = 1 } = {}) {
        this.#storage = storage;
    }
    make(documentId) {
            fn = this.#saveFns[documentId] = asyncThrottle(({ doc, handle }) => this.#storage.saveDoc(handle.documentId, doc), this.#saveDebounceRate);
    }
  }`
  const storagePatched = patchStorageSourceBackgroundSaveSource(storageSource)
  assert.equal(storagePatched.changed, true)
  assert.match(storagePatched.source, /#onStorageError/)
  assert.match(storagePatched.source, /\.catch\(error/)
  assert.match(storagePatched.source, /operation: "document"/)
  assert.equal(patchStorageSourceBackgroundSaveSource(storagePatched.source).changed, false)

  const handleSource = `class DocHandle {
    change(callbackOrValue, options = {}) {
      this.#document.applyMutation(doc => A.change(doc, options, callbackOrValue));
    }
  }`
  assert.equal(patchDocHandleOutdatedChangeSource(handleSource).changed, false)
})
