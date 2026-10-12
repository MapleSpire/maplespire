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

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { patchDocumentObservedDiffSource, patchFanoutHeadsSource, patchRegistryChangeObserversSource } from './patch-automerge-change-observers.mjs'
import { patchDocumentSaveBarrierSource, patchDocumentSaveBarrierTypesSource, patchStorageSourceCurrentDocumentSource } from './patch-automerge-document-saves.mjs'
import { patchCooperativeEventsSource } from './patch-automerge-cooperative-events.mjs'
import { patchInFlightFanoutSource, verifyInFlightSdkVersion } from './patch-automerge-inflight-fanout.mjs'
import { prepareSyncStateLifetimePatch, applySyncStateLifetimePatch } from './patch-automerge-sync-state-lifetime.mjs'

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url))

function dependencyPaths(installRoot = scriptDirectory) {
  const packageRoot = resolve(installRoot, 'node_modules/@automerge/automerge-repo/dist')
  return {
    docPath: resolve(packageRoot, 'synchronizer/DocSynchronizer.js'),
    collectionPath: resolve(packageRoot, 'synchronizer/CollectionSynchronizer.js'),
    repoPath: resolve(packageRoot, 'Repo.js'),
    handlePath: resolve(packageRoot, 'DocHandle.js'),
    storageSourcePath: resolve(packageRoot, 'StorageSource.js'),
    syncStateTrackerPath: resolve(packageRoot, 'SyncStateTracker.js'),
    storageSubsystemPath: resolve(packageRoot, 'storage/StorageSubsystem.js'),
    storageSubsystemTypesPath: resolve(packageRoot, 'storage/StorageSubsystem.d.ts'),
    throttlePath: resolve(packageRoot, 'helpers/throttle.js'),
    documentPath: resolve(packageRoot, 'Document.js'),
    registryPath: resolve(packageRoot, 'subdoc-handles/handle-registry.js'),
  }
}

const asyncThrottleWaitBefore = `        const wait = lastCall + delay - Date.now(); //if negative, executes immediately`

const asyncThrottleWaitAfter = `        // Node warns for negative timer delays even though it clamps them to one
        // millisecond. Preserve the intended next-turn execution explicitly.
        const wait = Math.max(0, lastCall + delay - Date.now());`

export function patchAsyncThrottleSource(source) {
  if (source.includes('const wait = Math.max(0, lastCall + delay - Date.now())')) {
    return { source, changed: false }
  }
  if (!source.includes(asyncThrottleWaitBefore)) {
    throw new Error(
      'Unsupported @automerge/automerge-repo asyncThrottle source. ' +
      'Review the timer-delay clamp before upgrading the dependency.',
    )
  }
  return {
    source: source.replace(asyncThrottleWaitBefore, asyncThrottleWaitAfter),
    changed: true,
  }
}

const initBefore = `    #initSyncState(peerId, syncState) {
        const pendingCallbacks = this.#pendingSyncStateCallbacks[peerId];`

const initAfter = `    #initSyncState(peerId, syncState) {
        // A storage read may resolve after the socket closed. Do not resurrect a
        // native Automerge sync state for an inactive peer.
        if (!this.#peers.includes(peerId)) {
            delete this.#pendingSyncStateCallbacks[peerId];
            delete this.#syncStates[peerId];
            return;
        }
        const pendingCallbacks = this.#pendingSyncStateCallbacks[peerId];`

const endBefore = `    endSync(peerId) {
        this.#log(\`removing peer \${peerId}\`);
        this.#peers = this.#peers.filter(p => p !== peerId);
        delete this.#peerDocumentStatuses[peerId];
        this.#checkDocUnavailable();
    }`

const endAfter = `    endSync(peerId) {
        this.#log(\`removing peer \${peerId}\`);
        this.#peers = this.#peers.filter(p => p !== peerId);
        delete this.#peerDocumentStatuses[peerId];
        // automerge-repo 2.5.6 otherwise retains the WASM sync state for every
        // disconnected peer for as long as this document stays active.
        delete this.#pendingSyncStateCallbacks[peerId];
        delete this.#syncStates[peerId];
        this.#checkDocUnavailable();
    }`

const resetFieldBefore = `    #pendingSyncStateCallbacks = {};`

const resetFieldAfter = `    #pendingSyncStateCallbacks = {};
    // Lightweight reconnect tombstones. The native sync state itself is still
    // released while the next connection is forced to start from empty state.
    #resetSyncStatePeers = new Set();`

const resetWithBefore = `    #withSyncState(peerId, callback) {
        this.#addPeer(peerId);
        if (!(peerId in this.#peerDocumentStatuses)) {`

const resetWithAfter = `    #withSyncState(peerId, callback) {
        this.#addPeer(peerId);
        if (this.#resetSyncStatePeers.delete(peerId)) {
            this.#syncStates[peerId] = A.initSyncState();
        }
        if (!(peerId in this.#peerDocumentStatuses)) {`

const resetEndBefore = endAfter

const resetEndAfter = `    endSync(peerId) {
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
    }`

const responseBefore = `                this.#sendSyncMessage(message.senderId, doc);`

const responseAfter = `                // Respond from the merged state. automerge-repo 2.5.6 uses
                // the pre-receive snapshot here, forcing an avoidable extra
                // broadcast round and leaving reconnecting peers with stale heads.
                this.#sendSyncMessage(message.senderId, newDoc);`

const debounceBefore = `    syncDebounceRate = 100;`

const debounceAfter = `    // A sync hub benefits from a wider coalescing window than browser peers.
    // Keep the upstream 100ms default unless the server explicitly opts in.
    syncDebounceRate = (() => {
        const configured = Number(globalThis.process?.env?.AM_SYNC_DEBOUNCE_MS);
        return Number.isFinite(configured)
            ? Math.max(25, Math.min(1000, Math.trunc(configured)))
            : 100;
    })();`

const fanoutBefore = `    async #syncWithPeers() {
        try {
            await this.#handle.whenReady();
            const doc = this.#handle.doc(); // XXX THIS ONE IS WEIRD
            this.#peers.forEach(peerId => this.#sendSyncMessage(peerId, doc));
        }
        catch (e) {
            console.log("sync with peers threw an exception");
        }
    }`

const fanoutPrevious = `    async #syncWithPeers() {
        try {
            await this.#handle.whenReady();
            const doc = this.#handle.doc(); // XXX THIS ONE IS WEIRD
            // Generating a sync message is CPU-heavy. A hub with dozens of
            // peers must yield between bounded batches instead of blocking the
            // event loop for the entire fan-out.
            const peers = [...this.#peers];
            const configuredBatch = Number(globalThis.process?.env?.AM_SYNC_FANOUT_BATCH);
            const batchSize = Number.isFinite(configuredBatch)
                ? Math.max(1, Math.min(peers.length || 1, Math.trunc(configuredBatch)))
                : peers.length || 1;
            for (let offset = 0; offset < peers.length; offset += batchSize) {
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
        }
        catch (e) {
            console.log("sync with peers threw an exception");
        }
    }`

const fanoutRefreshed = `    async #syncWithPeers() {
        try {
            await this.#handle.whenReady();
            // Generating a sync message is CPU-heavy. A hub with dozens of
            // peers yields between bounded batches so HTTP and lease callbacks
            // remain responsive. Refresh the document after each cooperative
            // yield so a concurrent receive cannot leave later peers behind.
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
        }
        catch (e) {
            console.log("sync with peers threw an exception");
        }
    }`

const fanoutAfter = `    async #syncWithPeers() {
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
    }`

const stateMachineReceiveStatsBefore = `                ...A.stats(doc),`

const stateMachineReceiveStatsAfter = `                // Do not traverse the complete document for every inbound frame.
                // Explicit Repo.metrics() calls still expose numOps/numChanges when
                // an operator requests the heavyweight diagnostic snapshot.`

const stateMachineReceiveBytesBefore = `                fromPeer: message.senderId,`

const stateMachineReceiveBytesAfter = `                fromPeer: message.senderId,
                // Retain only aggregate byte evidence in the application. This
                // value lets a slow receive be correlated with one oversized
                // protocol frame without logging peer or document contents.
                messageBytes: message.data.byteLength,`

const stateMachineFanoutBefore = `        handle.on("change", asyncThrottle(async () => {
            // Mark all active peers dirty — we have new data to send.
            for (const peer of this.#peers.values()) {
                if (peer.syncState)
                    peer.dirty = true;
            }
            this.#evaluate();
        }, this.syncDebounceRate));`

const stateMachineFanoutV1 = `        handle.on("change", asyncThrottle(async () => {
            // A hot hub must not generate every peer's outbound frame in one
            // event-loop turn. Per-peer sync states are independent; bound the
            // dirty set, evaluate it, then yield before the next group.
            const peers = Array.from(this.#peers.entries());
            const configuredBatch = Number(globalThis.process?.env?.AM_SYNC_FANOUT_BATCH);
            const batchSize = Number.isFinite(configuredBatch)
                ? Math.max(1, Math.min(peers.length || 1, Math.trunc(configuredBatch)))
                : 2;
            for (let offset = 0; offset < peers.length; offset += batchSize) {
                for (const [peerId, peer] of peers.slice(offset, offset + batchSize)) {
                    if (this.#peers.get(peerId) === peer && peer.syncState)
                        peer.dirty = true;
                }
                this.#evaluate();
                if (offset + batchSize < peers.length) {
                    await new Promise(resolve => {
                        const schedule = globalThis.setImmediate ??
                            (callback => globalThis.setTimeout(callback, 0));
                        schedule(resolve);
                    });
                }
            }
        }, this.syncDebounceRate));`

const stateMachineFanoutPrevious = stateMachineFanoutV1.replace(
  '                : 2;',
  '                : 4;',
)

const stateMachineFanoutStable = `        handle.on("change", asyncThrottle(async () => {
            // Materialize one stable snapshot for this fan-out pass. Calling the
            // full evaluator once per batch used to materialize the same hot
            // document O(peers / batch) times and then scan every peer again.
            const peerIds = Array.from(this.#peers.keys());
            const doc = this.#handle.fullDoc();
            const configuredBatch = Number(globalThis.process?.env?.AM_SYNC_FANOUT_BATCH);
            const batchSize = Number.isFinite(configuredBatch)
                ? Math.max(1, Math.min(peerIds.length || 1, Math.trunc(configuredBatch)))
                : 2;
            if (peerIds.length === 0)
                this.#evaluate([], doc);
            for (let offset = 0; offset < peerIds.length; offset += batchSize) {
                const batch = peerIds.slice(offset, offset + batchSize);
                for (const peerId of batch) {
                    const peer = this.#peers.get(peerId);
                    if (peer?.syncState)
                        peer.dirty = true;
                }
                this.#evaluate(batch, doc);
                if (offset + batchSize < peerIds.length) {
                    await new Promise(resolve => {
                        const schedule = globalThis.setImmediate ??
                            (callback => globalThis.setTimeout(callback, 0));
                        schedule(resolve);
                    });
                }
            }
        }, this.syncDebounceRate));`

const stateMachineFanoutRefreshedPass = `        handle.on("change", asyncThrottle(async () => {
            // Refresh the document between cooperative batches. Per-peer sync
            // states are independent, so later recipients can consume changes
            // that arrived during the pass instead of waiting for another
            // throttled fan-out. Repeat only when heads moved during the pass;
            // the final stable pass makes every retained peer current.
            while (true) {
                const passHeads = A.getHeads(this.#handle.fullDoc());
                const peerIds = Array.from(this.#peers.keys());
                const configuredBatch = Number(globalThis.process?.env?.AM_SYNC_FANOUT_BATCH);
                const batchSize = Number.isFinite(configuredBatch)
                    ? Math.max(1, Math.min(peerIds.length || 1, Math.trunc(configuredBatch)))
                    : 1;
                if (peerIds.length === 0)
                    this.#evaluate([], this.#handle.fullDoc());
                for (let offset = 0; offset < peerIds.length; offset += batchSize) {
                    const batch = peerIds.slice(offset, offset + batchSize);
                    for (const peerId of batch) {
                        const peer = this.#peers.get(peerId);
                        if (peer?.syncState)
                            peer.dirty = true;
                    }
                    this.#evaluate(batch, this.#handle.fullDoc());
                    if (offset + batchSize < peerIds.length) {
                        await new Promise(resolve => {
                            const schedule = globalThis.setImmediate ??
                                (callback => globalThis.setTimeout(callback, 0));
                            schedule(resolve);
                        });
                    }
                }
                const latestHeads = A.getHeads(this.#handle.fullDoc());
                const stable = passHeads.length === latestHeads.length &&
                    passHeads.every((head, index) => head === latestHeads[index]);
                if (stable)
                    break;
            }
        }, this.syncDebounceRate));`

const stateMachineFanoutAfter = `        // Coalesce document changes for one event-loop turn, then keep one
        // cooperative fan-out drain active until every change observed during
        // the drain has received a complete pass. asyncThrottle imposed a new
        // 100 ms delay after each protocol wave; on a hot hub those delays
        // accumulated into multi-second convergence even while CPU stayed idle.
        let fanoutScheduled = false;
        let fanoutRunning = false;
        let fanoutPending = false;
        let fanoutFailures = 0;
        const configuredCoalesce = Number(globalThis.process?.env?.AM_SYNC_FANOUT_COALESCE_MS);
        const fanoutCoalesceMs = Number.isFinite(configuredCoalesce)
            ? Math.max(0, Math.min(250, Math.trunc(configuredCoalesce)))
            : 0;
        const cooperativeYield = () => new Promise(resolve => {
            // Yield between peer batches without adding wall-clock latency per
            // peer. Coalescing belongs only in scheduleFanout below: applying
            // it here turns a 10 ms window into 500 ms for a 50-peer document.
            const schedule = globalThis.setImmediate ??
                (callback => globalThis.setTimeout(callback, 0));
            schedule(resolve);
        });
        const drainFanout = async () => {
            if (fanoutRunning)
                return;
            fanoutRunning = true;
            try {
                while (fanoutPending) {
                    fanoutPending = false;
                    // Materialize one immutable view per pass. Changes that
                    // arrive during the cooperative yields set fanoutPending
                    // and receive a fresh complete pass; rebuilding fullDoc()
                    // for every peer made a 50-peer hub do O(peers) document
                    // materializations before it could converge.
                    const prepareStartedAt = globalThis.performance?.now() ?? Date.now();
                    const preparedDoc = this.#handle.fullDoc();
                    const preparedHeads = A.getHeads(preparedDoc);
                    const prepareDurationMs = (globalThis.performance?.now() ?? Date.now()) - prepareStartedAt;
                    if (prepareDurationMs >= 50) {
                        console.warn(JSON.stringify({
                            event: "automerge.fanout_prepare_slow",
                            durationMs: Math.round(prepareDurationMs * 100) / 100,
                            peers: this.#peers.size,
                        }));
                    }
                    // Compute document-wide evaluation state once per
                    // cooperative pass. #evaluate runs once per small peer
                    // batch, so repeating these full peer scans and heads
                    // checks in every batch made a 50-peer pass quadratic.
                    const supplierExists = this.#anyActivePeerOfType("has");
                    const evaluationContext = {
                        weHaveData: preparedHeads.length > 0,
                        supplierExists,
                        awaitingSupplierData: supplierExists && this.#hasPendingSupplierHeads(preparedDoc),
                    };
                    const peerIds = Array.from(this.#peers.keys());
                    const configuredBatch = Number(globalThis.process?.env?.AM_SYNC_FANOUT_BATCH);
                    const batchSize = Number.isFinite(configuredBatch)
                        ? Math.max(1, Math.min(peerIds.length || 1, Math.trunc(configuredBatch)))
                        : 1;
                    if (peerIds.length === 0)
                        this.#evaluate([], preparedDoc, true, evaluationContext);
                    for (let offset = 0; offset < peerIds.length; offset += batchSize) {
                        const batch = peerIds.slice(offset, offset + batchSize);
                        for (const peerId of batch) {
                            const peer = this.#peers.get(peerId);
                            if (peer?.syncState && !peer.dirty) {
                                // sharedHeads are an Automerge protocol proof
                                // that this peer already has the prepared view.
                                // Keep protocol-driven dirty flags intact, but
                                // avoid thousands of no-op generate calls from
                                // document-change fan-out on a hot hub.
                                const sharedHeads = new Set(peer.syncState.sharedHeads);
                                if (!preparedHeads.every(head => sharedHeads.has(head)))
                                    peer.dirty = true;
                            }
                        }
                        const finalBatch = offset + batchSize >= peerIds.length;
                        this.#evaluate(batch, preparedDoc, finalBatch, evaluationContext);
                        if (offset + batchSize < peerIds.length)
                            await cooperativeYield();
                    }
                    fanoutFailures = 0;
                }
            }
            catch (error) {
                fanoutFailures += 1;
                const willRetry = fanoutFailures <= 3 && this.#peers.size > 0;
                console.warn(JSON.stringify({
                    event: "automerge.fanout_failed",
                    attempt: fanoutFailures,
                    willRetry,
                    peers: this.#peers.size,
                    error: error instanceof Error ? error.message : String(error),
                }));
                // One transient materialization/protocol error must not strand
                // dirty peers forever. Retry three times, but remain bounded if
                // a deterministic document error persists.
                if (willRetry)
                    fanoutPending = true;
            }
            finally {
                fanoutRunning = false;
                if (fanoutPending)
                    scheduleFanout();
            }
        };
        const scheduleFanout = () => {
            fanoutPending = true;
            if (fanoutRunning || fanoutScheduled)
                return;
            fanoutScheduled = true;
            // A short, bounded window combines one burst of inbound changes
            // before paying the O(peers) fan-out cost. Unlike asyncThrottle it
            // does not impose a new fixed delay after every protocol message.
            const schedule = fanoutCoalesceMs > 0
                ? (callback => globalThis.setTimeout(callback, fanoutCoalesceMs))
                : globalThis.setImmediate ?? (callback => globalThis.setTimeout(callback, 0));
            schedule(() => {
                fanoutScheduled = false;
                void drainFanout();
            });
        };
        // Inbound protocol frames use the same single-flight drain as local
        // document changes. This avoids evaluating the sender immediately and
        // then evaluating the whole peer set again from the synchronous change
        // event emitted by receiveSyncMessage.
        this.scheduleInboundEvaluation = scheduleFanout;
        handle.on("change", scheduleFanout);`

const stateMachineEvaluateBefore = `    #evaluate() {
        const doc = this.#handle.fullDoc();`

const stateMachineEvaluateAfter = `    #evaluate(peerIds = null, preparedDoc = null, finalize = true, preparedContext = null) {
        // A cooperative fan-out passes one prepared document through every
        // batch. Other callers still materialize the current document once.
        const doc = preparedDoc ?? this.#handle.fullDoc();`

const stateMachineEvaluationContextBefore = `        const weHaveData = A.getHeads(doc).length > 0;
        const supplierExists = this.#anyActivePeerOfType("has");
        // Check whether we've caught up with all suppliers' initial heads.
        // Until we have, we shouldn't respond to requestors.
        const awaitingSupplierData = supplierExists && this.#hasPendingSupplierHeads(doc);`

const stateMachineEvaluationContextAfter = `        const weHaveData = preparedContext?.weHaveData ?? A.getHeads(doc).length > 0;
        const supplierExists = preparedContext?.supplierExists ?? this.#anyActivePeerOfType("has");
        // Check whether we've caught up with all suppliers' initial heads.
        // Until we have, we shouldn't respond to requestors.
        const awaitingSupplierData = preparedContext?.awaitingSupplierData ??
            (supplierExists && this.#hasPendingSupplierHeads(doc));`

const stateMachinePeerLoopBefore = `        // Phase 1: Send outbound sync messages to dirty peers.
        for (const [peerId, peer] of this.#peers) {`

const stateMachinePeerLoopAfter = `        // Phase 1: Send outbound sync messages to dirty peers. A supplied peer
        // subset prevents every small cooperative batch from rescanning the
        // entire hub; peers removed during a yield are discarded safely.
        const candidates = peerIds === null
            ? this.#peers
            : peerIds
                .map(peerId => [peerId, this.#peers.get(peerId)])
                .filter(([, peer]) => peer !== undefined);
        for (const [peerId, peer] of candidates) {`

const stateMachineAvailabilityCallBefore = `        this.#updateAvailability();`
const stateMachineAvailabilityCallAfter = `        // Availability and unavailable notifications are document-wide. A
        // cooperative pass finalizes them once after its last peer batch.
        if (!finalize)
            return;
        this.#updateAvailability(doc);`
const stateMachineAvailabilityBefore = `    #updateAvailability() {`
const stateMachineAvailabilityAfter = `    #updateAvailability(preparedDoc = null) {`
const stateMachineCaughtUpBefore = `        if (this.#hasCaughtUpToAnySupplier(this.#handle.fullDoc())) {`
const stateMachineCaughtUpAfter = `        if (this.#hasCaughtUpToAnySupplier(preparedDoc ?? this.#handle.fullDoc())) {`

const stateMachinePendingSupplierBefore = `    #hasPendingSupplierHeads(doc) {
        for (const peer of this.#peers.values()) {
            if (peer.status.type !== "has")
                continue;
            if (peer.sharePolicyState === "denied")
                continue;
            if (!A.hasHeads(doc, peer.status.theirInitialHeads))
                return true;
        }
        return false;
    }`

const stateMachinePendingSupplierAfter = `    #supplierHasCaughtUp(doc, peer) {
        if (peer.status.type !== "has" || peer.sharePolicyState === "denied")
            return false;
        // Automerge documents grow monotonically: once the supplier's initial
        // heads are present they cannot disappear. hasHeads() walks document
        // history, so repeating it for every peer on every inbound frame made
        // a hot 50-peer workspace spend most of its CPU re-proving old facts.
        if (peer.supplierCaughtUp === true)
            return true;
        if (!A.hasHeads(doc, peer.status.theirInitialHeads))
            return false;
        peer.supplierCaughtUp = true;
        return true;
    }
    #hasPendingSupplierHeads(doc) {
        for (const peer of this.#peers.values()) {
            if (peer.status.type !== "has")
                continue;
            if (peer.sharePolicyState === "denied")
                continue;
            if (!this.#supplierHasCaughtUp(doc, peer))
                return true;
        }
        return false;
    }`

const stateMachineCaughtUpSupplierBefore = `    #hasCaughtUpToAnySupplier(doc) {
        for (const peer of this.#peers.values()) {
            if (peer.status.type !== "has")
                continue;
            if (peer.sharePolicyState === "denied")
                continue;
            if (A.hasHeads(doc, peer.status.theirInitialHeads))
                return true;
        }
        return false;
    }`

const stateMachineCaughtUpSupplierAfter = `    #hasCaughtUpToAnySupplier(doc) {
        for (const peer of this.#peers.values()) {
            if (this.#supplierHasCaughtUp(doc, peer))
                return true;
        }
        return false;
    }`

const stateMachineReceiveStateBefore = `            peer.syncState = newSyncState;
            this.emit("sync-state", {`

const stateMachineReceiveStateAfter = `            peer.syncState = newSyncState;
            // The sync protocol already computed the heads both peers now
            // share. Reuse that proof instead of immediately walking the full
            // Automerge history again in #hasPendingSupplierHeads.
            if (peer.status.type === "has" && peer.supplierCaughtUp !== true) {
                const sharedHeads = new Set(newSyncState.sharedHeads);
                if (peer.status.theirInitialHeads.every(head => sharedHeads.has(head)))
                    peer.supplierCaughtUp = true;
            }
            this.emit("sync-state", {`

const stateMachineReceiveMessageBefore = `    receiveMessage(message) {
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
    }`

const stateMachineReceiveMessageAfter = `    receiveMessage(message) {
        switch (message.type) {
            case "sync":
            case "request":
                this.#receiveSyncMessage(message);
                // receiveSyncMessage marks the sender dirty. Schedule exactly
                // one cooperative response even when the frame only advances
                // sync state and therefore emits no document change event.
                this.scheduleInboundEvaluation();
                return;
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
    }`

const stateMachineQueryEvaluateBefore = `            queueMicrotask(() => this.#evaluate());`

const stateMachineQueryEvaluateAfter = `            // Query transitions share the same single-flight scheduler as
            // document changes. A reconnect burst can resolve dozens of peer
            // and storage promises in one microtask checkpoint; evaluating each
            // transition inline starves timers for hundreds of milliseconds.
            this.scheduleInboundEvaluation();`

const stateMachinePeerActivationBefore = `        // After draining, mark dirty so #evaluate sends the initial sync.
        peer.dirty = true;
        this.#evaluate();
    }
    #setPeerStatus(peerId, status) {`

const stateMachinePeerActivationAfter = `        // After draining, mark dirty so the shared cooperative pass sends the
        // initial sync. Concurrent peer activations collapse into one drain.
        peer.dirty = true;
        this.scheduleInboundEvaluation();
    }
    #setPeerStatus(peerId, status) {`

const stateMachinePendingRequestBefore = `            pendingMessages: [...messages],
            dirty: true,
            hasRequested: false,`

const stateMachinePendingRequestAfter = `            pendingMessages: [...messages],
            dirty: true,
            // Initial buffered sync/request frames are already an explicit
            // document request. Mark them before async sync-state/share-policy
            // loading so retirement cannot discard the peer and its message;
            // activation also emits open-doc exactly once.
            hasRequested: messages.length > 0,`

const stateMachineRetiredReleaseBefore = `    hasPeer(peerId) {
        return this.#peers.has(peerId);
    }
    receiveMessage(message) {`

const stateMachineRetiredReleasePrevious = `    hasPeer(peerId) {
        return this.#peers.has(peerId);
    }
    /** A retired write-head may be detached only after every peer that used it
     * has acknowledged all current server heads. A database projection being
     * caught up is not a network-convergence proof: the final fan-out can still
     * be in flight when an overlay rotates. */
    canForgetRequests() {
        const heads = A.getHeads(this.#handle.fullDoc());
        for (const peer of this.#peers.values()) {
            if (!peer.hasRequested || peer.sharePolicyState === "denied")
                continue;
            if (!peer.syncState || peer.dirty)
                return false;
            const sharedHeads = new Set(peer.syncState.sharedHeads);
            if (!heads.every(head => sharedHeads.has(head)))
                return false;
        }
        return true;
    }
    receiveMessage(message) {`

const stateMachineRetiredReleaseAfter = `    hasPeer(peerId) {
        return this.#peers.has(peerId);
    }
    /** A retired write-head may be detached only after every peer that used it
     * has acknowledged all current server heads. A database projection being
     * caught up is not a network-convergence proof: the final fan-out can still
     * be in flight when an overlay rotates. */
    canForgetRequests() {
        // Avoid materializing a retired document when no peer requested it.
        // The projector revisits every retained segment on each descriptor
        // refresh; fullDoc() here otherwise creates an O(history) event-loop
        // stall even after those segments were already detached.
        let heads;
        for (const peer of this.#peers.values()) {
            if (!peer.hasRequested || peer.sharePolicyState === "denied")
                continue;
            if (!peer.syncState || peer.dirty)
                return false;
            heads ??= A.getHeads(this.#handle.fullDoc());
            const sharedHeads = new Set(peer.syncState.sharedHeads);
            if (!heads.every(head => sharedHeads.has(head)))
                return false;
        }
        return true;
    }
    receiveMessage(message) {`

function patchStateMachineSynchronizer(source) {
  let patched = source
  let changed = false
  if (!patched.includes('A sync hub benefits from a wider coalescing window')) {
    if (!patched.includes(debounceBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 debounce source. ' +
        'Review the configurable synchronization cadence before upgrading the dependency.',
      )
    }
    patched = patched.replace(debounceBefore, debounceAfter)
    changed = true
  }
  if (!patched.includes('Do not traverse the complete document for every inbound frame')) {
    if (!patched.includes(stateMachineReceiveStatsBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 receive metrics source. ' +
        'Review the per-message full-document statistics patch before upgrading the dependency.',
      )
    }
    patched = patched.replace(stateMachineReceiveStatsBefore, stateMachineReceiveStatsAfter)
    changed = true
  }
  if (!patched.includes('correlated with one oversized')) {
    if (!patched.includes(stateMachineReceiveBytesBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 receive byte metrics source. ' +
        'Review the protocol frame diagnostics patch before upgrading the dependency.',
      )
    }
    patched = patched.replace(stateMachineReceiveBytesBefore, stateMachineReceiveBytesAfter)
    changed = true
  }
  if (patched.includes(stateMachineFanoutRefreshedPass)) {
    patched = patched.replace(stateMachineFanoutRefreshedPass, stateMachineFanoutAfter)
    changed = true
  } else if (patched.includes(stateMachineFanoutStable)) {
    patched = patched.replace(stateMachineFanoutStable, stateMachineFanoutAfter)
    changed = true
  } else if (patched.includes(stateMachineFanoutPrevious)) {
    patched = patched.replace(stateMachineFanoutPrevious, stateMachineFanoutAfter)
    changed = true
  } else if (patched.includes(stateMachineFanoutV1)) {
    patched = patched.replace(stateMachineFanoutV1, stateMachineFanoutAfter)
    changed = true
  } else if (!patched.includes('Coalesce document changes for one event-loop turn')) {
    if (!patched.includes(stateMachineFanoutBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 change fan-out source. ' +
        'Review the cooperative per-peer fan-out patch before upgrading the dependency.',
      )
    }
    patched = patched.replace(stateMachineFanoutBefore, stateMachineFanoutAfter)
    changed = true
  }
  if (!patched.includes('event: "automerge.fanout_failed"')) {
    const retryFieldBefore = `        let fanoutPending = false;
        const configuredCoalesce`
    const retryFieldAfter = `        let fanoutPending = false;
        let fanoutFailures = 0;
        const configuredCoalesce`
    const retrySuccessBefore = `                    }
                }
            }
            catch (error) {
                console.log("cooperative sync with peers threw an exception", error);
            }`
    const retrySuccessAfter = `                    }
                    fanoutFailures = 0;
                }
            }
            catch (error) {
                fanoutFailures += 1;
                const willRetry = fanoutFailures <= 3 && this.#peers.size > 0;
                console.warn(JSON.stringify({
                    event: "automerge.fanout_failed",
                    attempt: fanoutFailures,
                    willRetry,
                    peers: this.#peers.size,
                    error: error instanceof Error ? error.message : String(error),
                }));
                // One transient materialization/protocol error must not strand
                // dirty peers forever. Retry three times, but remain bounded if
                // a deterministic document error persists.
                if (willRetry)
                    fanoutPending = true;
            }`
    if (!patched.includes(retryFieldBefore) || !patched.includes(retrySuccessBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 fan-out retry source. ' +
        'Review the bounded failure recovery before upgrading the dependency.',
      )
    }
    patched = patched
      .replace(retryFieldBefore, retryFieldAfter)
      .replace(retrySuccessBefore, retrySuccessAfter)
    changed = true
  }
  if (!patched.includes('this.scheduleInboundEvaluation = scheduleFanout')) {
    const schedulerBoundaryBefore = `        };
        handle.on("change", scheduleFanout);`
    const schedulerBoundaryAfter = `        };
        // Inbound protocol frames use the same single-flight drain as local
        // document changes. This avoids evaluating the sender immediately and
        // then evaluating the whole peer set again from the synchronous change
        // event emitted by receiveSyncMessage.
        this.scheduleInboundEvaluation = scheduleFanout;
        handle.on("change", scheduleFanout);`
    if (!patched.includes(schedulerBoundaryBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 fan-out scheduler boundary. ' +
        'Review the inbound evaluation coalescing patch before upgrading the dependency.',
      )
    }
    patched = patched.replace(schedulerBoundaryBefore, schedulerBoundaryAfter)
    changed = true
  }
  // Repair the first coalescing template, which accidentally used the burst
  // delay as the cooperative yield between every peer. That made latency grow
  // linearly with peer count (10 ms * 50 peers per protocol pass).
  const perPeerCoalesceBefore = `        const cooperativeYield = () => new Promise(resolve => {
            // A short, bounded window combines one burst of inbound changes
            // before paying the O(peers) fan-out cost. Unlike asyncThrottle it
            // does not impose a new fixed delay after every protocol message.
            const schedule = fanoutCoalesceMs > 0
                ? (callback => globalThis.setTimeout(callback, fanoutCoalesceMs))
                : globalThis.setImmediate ?? (callback => globalThis.setTimeout(callback, 0));
            schedule(resolve);
        });`
  const perPeerCoalesceAfter = `        const cooperativeYield = () => new Promise(resolve => {
            // Yield between peer batches without adding wall-clock latency per
            // peer. Coalescing belongs only in scheduleFanout below: applying
            // it here turns a 10 ms window into 500 ms for a 50-peer document.
            const schedule = globalThis.setImmediate ??
                (callback => globalThis.setTimeout(callback, 0));
            schedule(resolve);
        });`
  const immediateFanoutSchedule = `            fanoutScheduled = true;
            const schedule = globalThis.setImmediate ??
                (callback => globalThis.setTimeout(callback, 0));
            schedule(() => {`
  const coalescedFanoutSchedule = `            fanoutScheduled = true;
            // A short, bounded window combines one burst of inbound changes
            // before paying the O(peers) fan-out cost. Unlike asyncThrottle it
            // does not impose a new fixed delay after every protocol message.
            const schedule = fanoutCoalesceMs > 0
                ? (callback => globalThis.setTimeout(callback, fanoutCoalesceMs))
                : globalThis.setImmediate ?? (callback => globalThis.setTimeout(callback, 0));
            schedule(() => {`
  if (patched.includes(perPeerCoalesceBefore)) {
    if (!patched.includes(immediateFanoutSchedule)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 per-peer coalescing source. ' +
        'Review the burst scheduler repair before upgrading the dependency.',
      )
    }
    patched = patched
      .replace(perPeerCoalesceBefore, perPeerCoalesceAfter)
      .replace(immediateFanoutSchedule, coalescedFanoutSchedule)
    changed = true
  }
  if (!patched.includes('sharedHeads are an Automerge protocol proof')) {
    const preparedDocBefore = `                    const preparedDoc = this.#handle.fullDoc();
                    const peerIds = Array.from(this.#peers.keys());`
    const preparedDocAfter = `                    const preparedDoc = this.#handle.fullDoc();
                    const preparedHeads = A.getHeads(preparedDoc);
                    const peerIds = Array.from(this.#peers.keys());`
    const unconditionalDirtyBefore = `                            const peer = this.#peers.get(peerId);
                            if (peer?.syncState)
                                peer.dirty = true;`
    const provenDirtyAfter = `                            const peer = this.#peers.get(peerId);
                            if (peer?.syncState && !peer.dirty) {
                                // sharedHeads are an Automerge protocol proof
                                // that this peer already has the prepared view.
                                // Keep protocol-driven dirty flags intact, but
                                // avoid thousands of no-op generate calls from
                                // document-change fan-out on a hot hub.
                                const sharedHeads = new Set(peer.syncState.sharedHeads);
                                if (!preparedHeads.every(head => sharedHeads.has(head)))
                                    peer.dirty = true;
                            }`
    if (!patched.includes(preparedDocBefore) || !patched.includes(unconditionalDirtyBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 dirty-peer fan-out source. ' +
        'Review the shared-head proof optimization before upgrading the dependency.',
      )
    }
    patched = patched
      .replace(preparedDocBefore, preparedDocAfter)
      .replace(unconditionalDirtyBefore, provenDirtyAfter)
    changed = true
  }
  if (!patched.includes('automerge.fanout_prepare_slow')) {
    const prepareBefore = `                    const preparedDoc = this.#handle.fullDoc();
                    const preparedHeads = A.getHeads(preparedDoc);`
    const prepareAfter = `                    const prepareStartedAt = globalThis.performance?.now() ?? Date.now();
                    const preparedDoc = this.#handle.fullDoc();
                    const preparedHeads = A.getHeads(preparedDoc);
                    const prepareDurationMs = (globalThis.performance?.now() ?? Date.now()) - prepareStartedAt;
                    if (prepareDurationMs >= 50) {
                        console.warn(JSON.stringify({
                            event: "automerge.fanout_prepare_slow",
                            durationMs: Math.round(prepareDurationMs * 100) / 100,
                            peers: this.#peers.size,
                        }));
                    }`
    if (!patched.includes(prepareBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 fan-out preparation source. ' +
        'Review the hot-document materialization diagnostic before upgrading the dependency.',
      )
    }
    patched = patched.replace(prepareBefore, prepareAfter)
    changed = true
  }
  // Upgrade the first single-flight implementation in already-installed
  // worktrees. Fresh installs receive stateMachineFanoutAfter directly above.
  if (!patched.includes('AM_SYNC_FANOUT_COALESCE_MS')) {
    const coalesceConfigBefore = `        let fanoutPending = false;
        const cooperativeYield`
    const coalesceConfigAfter = `        let fanoutPending = false;
        const configuredCoalesce = Number(globalThis.process?.env?.AM_SYNC_FANOUT_COALESCE_MS);
        const fanoutCoalesceMs = Number.isFinite(configuredCoalesce)
            ? Math.max(0, Math.min(250, Math.trunc(configuredCoalesce)))
            : 0;
        const cooperativeYield`
    const coalesceScheduleBefore = `            const schedule = globalThis.setImmediate ??
                (callback => globalThis.setTimeout(callback, 0));
            schedule(() => {
                fanoutScheduled = false;
                void drainFanout();
            });`
    const coalesceScheduleAfter = `            // A short, bounded window combines one burst of inbound changes
            // before paying the O(peers) fan-out cost. Unlike asyncThrottle it
            // does not impose a new fixed delay after every protocol message.
            const schedule = fanoutCoalesceMs > 0
                ? (callback => globalThis.setTimeout(callback, fanoutCoalesceMs))
                : globalThis.setImmediate ?? (callback => globalThis.setTimeout(callback, 0));
            schedule(() => {
                fanoutScheduled = false;
                void drainFanout();
            });`
    if (!patched.includes(coalesceConfigBefore) || !patched.includes(coalesceScheduleBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 fan-out scheduler source. ' +
        'Review the bounded fan-out coalescing patch before upgrading the dependency.',
      )
    }
    patched = patched
      .replace(coalesceConfigBefore, coalesceConfigAfter)
      .replace(coalesceScheduleBefore, coalesceScheduleAfter)
    changed = true
  }
  if (!patched.includes('Materialize one immutable view per pass')) {
    const passStartBefore = `                while (fanoutPending) {
                    fanoutPending = false;
                    const peerIds = Array.from(this.#peers.keys());`
    const passStartAfter = `                while (fanoutPending) {
                    fanoutPending = false;
                    // Materialize one immutable view per pass. Changes that
                    // arrive during the cooperative yields set fanoutPending
                    // and receive a fresh complete pass; rebuilding fullDoc()
                    // for every peer made a 50-peer hub do O(peers) document
                    // materializations before it could converge.
                    const preparedDoc = this.#handle.fullDoc();
                    const peerIds = Array.from(this.#peers.keys());`
    if (!patched.includes(passStartBefore)
      || !patched.includes('this.#evaluate([], this.#handle.fullDoc());')
      || !patched.includes('this.#evaluate(batch, this.#handle.fullDoc());')) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 single-flight fan-out source. ' +
        'Review the prepared-document optimization before upgrading the dependency.',
      )
    }
    patched = patched
      .replace(passStartBefore, passStartAfter)
      .replace('this.#evaluate([], this.#handle.fullDoc());', 'this.#evaluate([], preparedDoc);')
      .replace('this.#evaluate(batch, this.#handle.fullDoc());', 'this.#evaluate(batch, preparedDoc);')
    changed = true
  }
  if (!patched.includes('A cooperative fan-out passes one prepared document')) {
    const required = [
      stateMachineEvaluateBefore,
      stateMachineEvaluationContextBefore,
      stateMachinePeerLoopBefore,
      stateMachineAvailabilityCallBefore,
      stateMachineAvailabilityBefore,
      stateMachineCaughtUpBefore,
    ]
    if (required.some((fragment) => !patched.includes(fragment))) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 evaluator source. ' +
        'Review the single-materialization cooperative fan-out patch before upgrading the dependency.',
      )
    }
    patched = patched
      .replace(stateMachineEvaluateBefore, stateMachineEvaluateAfter)
      .replace(stateMachineEvaluationContextBefore, stateMachineEvaluationContextAfter)
      .replace(stateMachinePeerLoopBefore, stateMachinePeerLoopAfter)
      .replace(stateMachineAvailabilityCallBefore, stateMachineAvailabilityCallAfter)
      .replace(stateMachineAvailabilityBefore, stateMachineAvailabilityAfter)
      .replace(stateMachineCaughtUpBefore, stateMachineCaughtUpAfter)
    changed = true
  }
  if (!patched.includes('Compute document-wide evaluation state once per')) {
    // Insert relative to the peer-list boundary rather than requiring
    // preparedHeads and peerIds to remain adjacent. Older revisions of this
    // patch inserted the slow-preparation diagnostic between those lines;
    // matching the whole block made a normal `npm install` unable to migrate
    // an already-patched worktree.
    const preparedHeadsProof = '                    const preparedHeads = A.getHeads(preparedDoc);'
    const peerListBefore = '                    const peerIds = Array.from(this.#peers.keys());'
    const peerListAfter = `                    // Compute document-wide evaluation state once per
                    // cooperative pass. #evaluate runs once per small peer
                    // batch, so repeating these full peer scans and heads
                    // checks in every batch made a 50-peer pass quadratic.
                    const supplierExists = this.#anyActivePeerOfType("has");
                    const evaluationContext = {
                        weHaveData: preparedHeads.length > 0,
                        supplierExists,
                        awaitingSupplierData: supplierExists && this.#hasPendingSupplierHeads(preparedDoc),
                    };
                    const peerIds = Array.from(this.#peers.keys());`
    const emptyBefore = '                        this.#evaluate([], preparedDoc);'
    const emptyAfter = '                        this.#evaluate([], preparedDoc, true, evaluationContext);'
    const batchBefore = '                        this.#evaluate(batch, preparedDoc);'
    const batchAfter = `                        const finalBatch = offset + batchSize >= peerIds.length;
                        this.#evaluate(batch, preparedDoc, finalBatch, evaluationContext);`
    const evaluateBefore = '    #evaluate(peerIds = null, preparedDoc = null) {'
    const evaluateAfter = '    #evaluate(peerIds = null, preparedDoc = null, finalize = true, preparedContext = null) {'
    const availabilityBefore = '        this.#updateAvailability(doc);'
    const availabilityAfter = `        // Availability and unavailable notifications are document-wide. A
        // cooperative pass finalizes them once after its last peer batch.
        if (!finalize)
            return;
        this.#updateAvailability(doc);`
    const required = [
      preparedHeadsProof,
      peerListBefore,
      emptyBefore,
      batchBefore,
      evaluateBefore,
      stateMachineEvaluationContextBefore,
      availabilityBefore,
    ]
    if (required.some((fragment) => !patched.includes(fragment))) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 cooperative evaluator source. ' +
        'Review the once-per-pass evaluation patch before upgrading the dependency.',
      )
    }
    patched = patched
      .replace(peerListBefore, peerListAfter)
      .replace(emptyBefore, emptyAfter)
      .replace(batchBefore, batchAfter)
      .replace(evaluateBefore, evaluateAfter)
      .replace(stateMachineEvaluationContextBefore, stateMachineEvaluationContextAfter)
      .replace(availabilityBefore, availabilityAfter)
    changed = true
  }
  if (!patched.includes("once the supplier's initial")) {
    if (!patched.includes(stateMachinePendingSupplierBefore)
      || !patched.includes(stateMachineCaughtUpSupplierBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 supplier-head source. ' +
        'Review the monotone supplier catch-up cache before upgrading the dependency.',
      )
    }
    patched = patched
      .replace(stateMachinePendingSupplierBefore, stateMachinePendingSupplierAfter)
      .replace(stateMachineCaughtUpSupplierBefore, stateMachineCaughtUpSupplierAfter)
    changed = true
  }
  if (!patched.includes('The sync protocol already computed the heads')) {
    if (!patched.includes(stateMachineReceiveStateBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 receive-state source. ' +
        'Review the shared-head catch-up proof before upgrading the dependency.',
      )
    }
    patched = patched.replace(stateMachineReceiveStateBefore, stateMachineReceiveStateAfter)
    changed = true
  }
  if (!patched.includes('this.scheduleInboundEvaluation();')) {
    if (!patched.includes(stateMachineReceiveMessageBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 receive dispatch source. ' +
        'Review the inbound evaluation coalescing patch before upgrading the dependency.',
      )
    }
    patched = patched.replace(stateMachineReceiveMessageBefore, stateMachineReceiveMessageAfter)
    changed = true
  }
  if (!patched.includes('Query transitions share the same single-flight scheduler')) {
    if (!patched.includes(stateMachineQueryEvaluateBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 query subscription source. ' +
        'Review the query evaluation coalescing patch before upgrading the dependency.',
      )
    }
    patched = patched.replace(stateMachineQueryEvaluateBefore, stateMachineQueryEvaluateAfter)
    changed = true
  }
  if (!patched.includes('Concurrent peer activations collapse into one drain')) {
    if (!patched.includes(stateMachinePeerActivationBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 peer activation source. ' +
        'Review the activation evaluation coalescing patch before upgrading the dependency.',
      )
    }
    patched = patched.replace(stateMachinePeerActivationBefore, stateMachinePeerActivationAfter)
    changed = true
  }
  if (!patched.includes('Initial buffered sync/request frames are already an explicit')) {
    if (!patched.includes(stateMachinePendingRequestBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 pending request source. ' +
        'Review the retired-document activation race before upgrading the dependency.',
      )
    }
    patched = patched.replace(stateMachinePendingRequestBefore, stateMachinePendingRequestAfter)
    changed = true
  }
  if (patched.includes(stateMachineRetiredReleasePrevious)) {
    patched = patched.replace(stateMachineRetiredReleasePrevious, stateMachineRetiredReleaseAfter)
    changed = true
  } else if (!patched.includes('A retired write-head may be detached only after every peer')) {
    if (!patched.includes(stateMachineRetiredReleaseBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo 2.6 peer inspection source. ' +
        'Review the retired write-head convergence guard before upgrading the dependency.',
      )
    }
    patched = patched.replace(stateMachineRetiredReleaseBefore, stateMachineRetiredReleaseAfter)
    changed = true
  }
  const fanoutHeads = patchFanoutHeadsSource(patched)
  const cooperativeEvents = patchCooperativeEventsSource(fanoutHeads.source)
  const inFlightFanout = patchInFlightFanoutSource(cooperativeEvents.source)
  return { source: inFlightFanout.source, changed: changed || fanoutHeads.changed || cooperativeEvents.changed || inFlightFanout.changed }
}

export function patchDocSynchronizerSource(source) {
  // 2.6's synchronizer replaces the complete per-connection PeerState on
  // reconnect and queues frames until that connection's state has loaded. Do
  // not layer the 2.5 workaround onto the new state machine.
  if (source.includes('#peers = new Map();')
    && source.includes('completely replace any existing state here')
    && source.includes('#evaluate(')) {
    return patchStateMachineSynchronizer(source)
  }
  let patched = source
  let changed = false
  if (!patched.includes('A sync hub benefits from a wider coalescing window')) {
    if (!patched.includes(debounceBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo DocSynchronizer debounce source. ' +
        'Review the sync batching patch before upgrading the dependency.',
      )
    }
    patched = patched.replace(debounceBefore, debounceAfter)
    changed = true
  }
  // Cooperative fan-out was experimentally introduced to reduce event-loop
  // stalls. Yielding in the middle of Automerge's per-document protocol can
  // interleave receive state with a partially completed broadcast and failed
  // the exact-convergence failover gate. Restore the dependency's atomic FIFO
  // pass; CPU isolation must happen outside the sync protocol.
  if (patched.includes(fanoutAfter)) {
    patched = patched.replace(fanoutAfter, fanoutBefore)
    changed = true
  } else if (patched.includes(fanoutRefreshed)) {
    patched = patched.replace(fanoutRefreshed, fanoutBefore)
    changed = true
  } else if (patched.includes(fanoutPrevious)) {
    patched = patched.replace(fanoutPrevious, fanoutBefore)
    changed = true
  } else if (!patched.includes(fanoutBefore)) {
    throw new Error(
      'Unsupported @automerge/automerge-repo DocSynchronizer fan-out source. ' +
      'Review the atomic fan-out invariant before upgrading the dependency.',
    )
  }
  if (!patched.includes('Do not resurrect a\n        // native Automerge sync state')) {
    if (!patched.includes(initBefore) || !patched.includes(endBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo DocSynchronizer source. ' +
        'Review the peer sync-state cleanup patch before upgrading the dependency.',
      )
    }
    patched = patched.replace(initBefore, initAfter).replace(endBefore, endAfter)
    changed = true
  }
  if (!patched.includes('bypass a racing storage read on the immediate reconnect')) {
    if (!patched.includes(resetFieldBefore)
      || !patched.includes(resetWithBefore)
      || !patched.includes(resetEndBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo reconnect reset source. ' +
        'Review the durable peer sync-state reset before upgrading the dependency.',
      )
    }
    patched = patched
      .replace(resetFieldBefore, resetFieldAfter)
      .replace(resetWithBefore, resetWithAfter)
      .replace(resetEndBefore, resetEndAfter)
    changed = true
  }
  if (!patched.includes(fanoutBefore)
    || patched.includes('Repeat a pass when document heads changed')
    || patched.includes('AM_SYNC_FANOUT_BATCH')) {
    throw new Error(
      'Unsupported @automerge/automerge-repo DocSynchronizer fan-out source. ' +
      'Review the atomic fan-out invariant before upgrading the dependency.',
    )
  }
  if (!patched.includes('Respond from the merged state. automerge-repo 2.5.6')) {
    if (!patched.includes(responseBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo DocSynchronizer response source. ' +
        'Review the merged-sync response patch before upgrading the dependency.',
      )
    }
    patched = patched.replace(responseBefore, responseAfter)
    changed = true
  }
  if (!patched.includes('Do not resurrect a\n        // native Automerge sync state')) {
    throw new Error(
      'Unsupported @automerge/automerge-repo DocSynchronizer source. ' +
      'Review the peer sync-state cleanup patch before upgrading the dependency.',
    )
  }
  if (!patched.includes('A sync hub benefits from a wider coalescing window')) {
    throw new Error(
      'Unsupported @automerge/automerge-repo DocSynchronizer debounce source. ' +
      'Review the sync batching patch before upgrading the dependency.',
    )
  }
  if (!patched.includes('bypass a racing storage read on the immediate reconnect')) {
    throw new Error(
      'Unsupported @automerge/automerge-repo reconnect reset source. ' +
      'Review the durable peer sync-state reset before upgrading the dependency.',
    )
  }
  return { source: patched, changed }
}

const forgetBefore = `    /** Returns a list of all connected peer ids */
    get peers() {`

const forgetStateMachineBefore = `    get peers() {`

const forgetAfter = `    /** Forget stale on-demand requests for a retired write-head. A peer that
     * later sends another sync/request message re-registers itself normally. */
    forgetDocumentRequests(documentId) {
        this.#hasRequested.delete(documentId);
        const synchronizer = this.docSynchronizers[documentId];
        if (!synchronizer)
            return;
        for (const peerId of this.#peers)
            synchronizer.endSync(peerId);
    }
    /** Returns a list of all connected peer ids */
    get peers() {`

const forgetAcknowledgedStateMachinePrevious = `    /** Forget stale on-demand requests for a retired write-head. A peer that
     * later sends another sync/request message re-registers itself normally.
     * Never detach a requester before it has acknowledged the server heads. */
    forgetDocumentRequests(documentId) {
        const synchronizer = this.#docSynchronizers[documentId];
        if (!synchronizer)
            return true;
        if (!synchronizer.canForgetRequests())
            return false;
        for (const peerId of this.#peers)
            synchronizer.removePeer(peerId);
        return true;
    }
    get peers() {`

const forgetIdempotentStateMachinePrevious = `    /** Forget stale on-demand requests for a retired write-head. A peer that
     * later sends another sync/request message re-registers itself normally.
     * Never detach a requester before it has acknowledged the server heads. */
    forgetDocumentRequests(documentId) {
        const synchronizer = this.#docSynchronizers[documentId];
        // Remember retirement even before the handle is attached. Projector
        // recovery can open a historical segment after this call.
        if (!synchronizer) {
            this.#forgottenDocumentRequests.add(documentId);
            return true;
        }
        if (!synchronizer.canForgetRequests())
            return false;
        for (const peerId of this.#peers)
            synchronizer.removePeer(peerId);
        this.#forgottenDocumentRequests.add(documentId);
        return true;
    }
    get peers() {`

const forgetAfterStateMachine = `    /** Forget stale on-demand requests for a retired write-head. A peer that
     * later sends another sync/request message re-registers itself normally.
     * Never detach a requester before it has acknowledged the server heads. */
    forgetDocumentRequests(documentId) {
        // Descriptor reconciliation revisits retained rows. Once forgotten,
        // keep this operation O(1); a genuine late message removes the marker
        // before reactivating the document and makes it eligible again.
        if (this.#forgottenDocumentRequests.has(documentId))
            return true;
        const synchronizer = this.#docSynchronizers[documentId];
        // Remember retirement even before the handle is attached. Projector
        // recovery can open a historical segment after this call.
        if (!synchronizer) {
            this.#forgottenDocumentRequests.add(documentId);
            return true;
        }
        if (!synchronizer.canForgetRequests())
            return false;
        for (const peerId of this.#peers)
            synchronizer.removePeer(peerId);
        this.#forgottenDocumentRequests.add(documentId);
        return true;
    }
    get peers() {`

const forgetPreviousStateMachine = `    /** Forget stale on-demand requests for a retired write-head. A peer that
     * later sends another sync/request message re-registers itself normally. */
    forgetDocumentRequests(documentId) {
        const synchronizer = this.#docSynchronizers[documentId];
        if (!synchronizer)
            return;
        for (const peerId of this.#peers)
            synchronizer.removePeer(peerId);
    }
    get peers() {`

const forgottenRequestsFieldBefore = `    #docSynchronizers = {};
    #denylist;`

const forgottenRequestsFieldAfter = `    #docSynchronizers = {};
    // Keep forgotten retired documents out of new-peer fan-out. Retaining an
    // empty synchronizer lets a genuinely late offline message reactivate it
    // without binding every future connection to every historical segment.
    #forgottenDocumentRequests = new Set();
    #denylist;`

const forgottenRequestsAddPeerBefore = `    addPeer(peerId) {
        this.#log.debug(\`adding \${peerId} & synchronizing with them\`);
        this.#peers.add(peerId);
        for (const docSync of Object.values(this.#docSynchronizers)) {
            this.#addPeerToDoc(peerId, docSync, []);
        }
    }`

const forgottenRequestsAddPeerAfter = `    addPeer(peerId) {
        this.#log.debug(\`adding \${peerId} & synchronizing with them\`);
        this.#peers.add(peerId);
        for (const [documentId, docSync] of Object.entries(this.#docSynchronizers)) {
            if (this.#forgottenDocumentRequests.has(documentId))
                continue;
            this.#addPeerToDoc(peerId, docSync, []);
        }
    }`

const forgottenRequestsReceiveBefore = `        if (!docSync.hasPeer(message.senderId)) {
            this.#addPeerToDoc(message.senderId, docSync, [message]);`

const forgottenRequestsReceiveAfter = `        if (!docSync.hasPeer(message.senderId)) {
            this.#forgottenDocumentRequests.delete(documentId);
            this.#addPeerToDoc(message.senderId, docSync, [message]);`

const forgottenRequestsAttachBefore = `        const docSync = this.#initDocSynchronizer(query.handle, query);
        this.#docSynchronizers[query.documentId] = docSync;
        for (const peerId of this.#peers) {
            this.#addPeerToDoc(peerId, docSync, []);
        }`

const forgottenRequestsAttachAfter = `        const docSync = this.#initDocSynchronizer(query.handle, query);
        this.#docSynchronizers[query.documentId] = docSync;
        // Do not bind already-connected peers when projector recovery opens a
        // document whose retirement was recorded before this attach.
        if (!this.#forgottenDocumentRequests.has(query.documentId)) {
            for (const peerId of this.#peers) {
                this.#addPeerToDoc(peerId, docSync, []);
            }
        }`

const selectiveOnDemandAddPeerAfter = `    addPeer(peerId) {
        this.#log.debug(\`adding \${peerId} & synchronizing with them\`);
        this.#peers.add(peerId);
        // Selective sync binds peers only to documents they request. Eagerly
        // attaching every resident root/control/write-head multiplies one hot
        // cohort across unrelated synchronizers and defeats cooperative
        // fan-out. A client's first sync/request message below still binds the
        // peer immediately, including a late offline edit to a retired head.
        if (globalThis.process?.env?.AM_SELECTIVE_SYNC === "on")
            return;
        for (const [documentId, docSync] of Object.entries(this.#docSynchronizers)) {
            if (this.#forgottenDocumentRequests.has(documentId))
                continue;
            this.#addPeerToDoc(peerId, docSync, []);
        }
    }`

const selectiveOnDemandAttachAfter = `        const docSync = this.#initDocSynchronizer(query.handle, query);
        this.#docSynchronizers[query.documentId] = docSync;
        // A selectively synchronized peer discovers this document through a
        // root/control pointer and requests it explicitly. Do not turn a
        // projector recovery attach into unsolicited fan-out.
        if (globalThis.process?.env?.AM_SELECTIVE_SYNC !== "on"
            && !this.#forgottenDocumentRequests.has(query.documentId)) {
            for (const peerId of this.#peers) {
                this.#addPeerToDoc(peerId, docSync, []);
            }
        }`

export function patchCollectionSynchronizerSource(source) {
  const stateMachine = source.includes('#docSynchronizers = {};')
    && source.includes('#peers = new Set();')
  if (!stateMachine) {
    if (source.includes('forgetDocumentRequests(documentId)')) return { source, changed: false }
    if (!source.includes(forgetBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo CollectionSynchronizer source. ' +
        'Review the retired document-request cleanup patch before upgrading the dependency.',
      )
    }
    return { source: source.replace(forgetBefore, forgetAfter), changed: true }
  }

  let patched = source
  let changed = false
  if (patched.includes(forgetIdempotentStateMachinePrevious)) {
    patched = patched.replace(forgetIdempotentStateMachinePrevious, forgetAfterStateMachine)
    changed = true
  } else if (patched.includes(forgetAcknowledgedStateMachinePrevious)) {
    patched = patched.replace(forgetAcknowledgedStateMachinePrevious, forgetAfterStateMachine)
    changed = true
  } else if (patched.includes(forgetPreviousStateMachine)) {
    patched = patched.replace(forgetPreviousStateMachine, forgetAfterStateMachine)
    changed = true
  } else if (!patched.includes('forgetDocumentRequests(documentId)')) {
    if (!patched.includes(forgetStateMachineBefore)) {
      throw new Error(
        'Unsupported @automerge/automerge-repo CollectionSynchronizer source. ' +
        'Review the retired document-request cleanup patch before upgrading the dependency.',
      )
    }
    patched = patched.replace(forgetStateMachineBefore, forgetAfterStateMachine)
    changed = true
  }

  if (!patched.includes('Keep forgotten retired documents out of new-peer fan-out')) {
    const required = [
      forgottenRequestsFieldBefore,
      forgottenRequestsAddPeerBefore,
      forgottenRequestsReceiveBefore,
    ]
    if (required.some((fragment) => !patched.includes(fragment))) {
      throw new Error(
        'Unsupported @automerge/automerge-repo CollectionSynchronizer peer lifecycle. ' +
        'Review the retired document residency patch before upgrading the dependency.',
      )
    }
    patched = patched
      .replace(forgottenRequestsFieldBefore, forgottenRequestsFieldAfter)
      .replace(forgottenRequestsAddPeerBefore, forgottenRequestsAddPeerAfter)
      .replace(forgottenRequestsReceiveBefore, forgottenRequestsReceiveAfter)
    changed = true
  }
  if (!patched.includes('Remember retirement even before the handle is attached')) {
    const unattachedBefore = `        if (!synchronizer)
            return true;`
    const unattachedAfter = `        // Remember retirement even before the handle is attached. Projector
        // recovery can open a historical segment after this call.
        if (!synchronizer) {
            this.#forgottenDocumentRequests.add(documentId);
            return true;
        }`
    if (!patched.includes(unattachedBefore)) {
      throw new Error('Unsupported unattached retired document lifecycle')
    }
    patched = patched.replace(unattachedBefore, unattachedAfter)
    changed = true
  }
  if (!patched.includes('Selective sync binds peers only to documents they request')
    && !patched.includes('Do not bind already-connected peers when projector recovery opens')) {
    if (!patched.includes(forgottenRequestsAttachBefore)) {
      throw new Error('Unsupported CollectionSynchronizer attach lifecycle')
    }
    patched = patched.replace(forgottenRequestsAttachBefore, forgottenRequestsAttachAfter)
    changed = true
  }
  if (!patched.includes('Selective sync binds peers only to documents they request')) {
    if (!patched.includes(forgottenRequestsAddPeerAfter)
      || !patched.includes(forgottenRequestsAttachAfter)) {
      throw new Error(
        'Unsupported CollectionSynchronizer selective-sync peer lifecycle. ' +
        'Review the on-demand peer binding patch before upgrading the dependency.',
      )
    }
    patched = patched
      .replace(forgottenRequestsAddPeerAfter, selectiveOnDemandAddPeerAfter)
      .replace(forgottenRequestsAttachAfter, selectiveOnDemandAttachAfter)
    changed = true
  }
  if (!patched.includes('this.#forgottenDocumentRequests.add(documentId);')) {
    throw new Error('Retired document peer exclusion was not installed')
  }
  if (!patched.includes('retirementMetrics()')) {
    const metricsBefore = `    // MESSAGE HANDLING`
    const metricsAfter = `    /** Privacy-minimized pressure signal for correctness-preserving retirement
     * tombstones. They cannot be evicted by age: an offline peer can return
     * after an arbitrary delay and must not receive every historical segment. */
    retirementMetrics() {
        const configured = Number(globalThis.process?.env?.AM_RETIRED_SYNC_DOCUMENT_LIMIT);
        const limit = Number.isFinite(configured)
            ? Math.max(1000, Math.min(1000000, Math.trunc(configured)))
            : 100000;
        const count = this.#forgottenDocumentRequests.size;
        return { count, limit, overLimit: count > limit };
    }
    // MESSAGE HANDLING`
    if (patched.includes(metricsBefore)) {
      patched = patched.replace(metricsBefore, metricsAfter)
      changed = true
    }
  }
  return { source: patched, changed }
}

const backgroundSaveBefore = `                void fn({ handle, doc });`

const backgroundSaveAfter = `                // Repo change events are fire-and-forget, but storage adapters may
                // reject (for example when a sync-cell fence retires a workspace
                // while this debounced save is waiting). Surface the rejection as
                // a controlled Repo event instead of abandoning the Promise.
                void fn({ handle, doc }).catch(error => {
                    this.emit("storage-error", { documentId: handle.documentId, error });
                });`

const backgroundStorageSourceBefore = `            this.#sources.set("storage", new StorageSource(storageSubsystem, saveDebounceRate));`

const backgroundStorageSourceAfter = `            this.#sources.set("storage", new StorageSource(storageSubsystem, saveDebounceRate, {
                onStorageError: ({ documentId, error, operation }) => this.emit("storage-error", { documentId, error, operation }),
            }));`

const backgroundSyncTrackerBefore = `        this.#syncStateTracker = new SyncStateTracker(this.storageSubsystem, saveDebounceRate);`

const backgroundSyncTrackerAfter = `        this.#syncStateTracker = new SyncStateTracker(this.storageSubsystem, saveDebounceRate, {
            onStorageError: ({ documentId, error, operation }) => this.emit("storage-error", { documentId, error, operation }),
        });`

const disconnectBefore = `        networkSubsystem.on("peer-disconnected", ({ peerId }) => {
            this.synchronizer.removePeer(peerId);
            this.#remoteHeadsSubscriptions.removePeer(peerId);
        });`

const disconnectAfter = `        networkSubsystem.on("peer-disconnected", ({ peerId }) => {
            const disconnectedPeerMetadata = this.peerMetadataByPeerId[peerId];
            delete this.peerMetadataByPeerId[peerId];
            this.synchronizer.removePeer(peerId);
            this.#remoteHeadsSubscriptions.removePeer(peerId);
            // A transport may close after refusing an outbound frame for
            // backpressure. The synchronizer has already advanced its state at
            // that point, so resuming from the persisted state COULD skip the
            // refused frame. Enterprise sync hubs invalidate that remote
            // storage state after the last connection disappears.
            //
            // MEASURED, AND THE PREMISE DID NOT HOLD — keep this OFF (default).
            // 21 injected single falls on slope-c, 3 857 478 bytes dropped in
            // flight (the server's send SUCCEEDED, the peer never saw them):
            //   off  12/12 boots painted, persisted state provably survived,
            //        traffic identical to a no-fall run to within 0,04 %
            //   on    8/9 boots painted, same traffic when it works
            // Nothing is skipped with this off, because the reconnect handshake
            // is CLIENT-driven: the peer announces its own heads and the server
            // computes the delta from what the peer really has, not from what it
            // believes it sent. The persisted state is an optimisation, and an
            // over-optimistic one is corrected by that announcement. The only
            // dead boot of the whole experiment was in the "on" arm, its
            // replacement socket served 164 bytes. Backpressure REFUSAL itself
            // is still unreproduced.
            const resetOnDisconnect = ["1", "true", "on"].includes(String(globalThis.process?.env?.AM_RESET_SYNC_STATE_ON_DISCONNECT ?? "").toLowerCase());
            const storageId = disconnectedPeerMetadata?.storageId;
            const storageStillConnected = storageId && Object.values(this.peerMetadataByPeerId)
                .some(metadata => metadata?.storageId === storageId);
            if (resetOnDisconnect && storageId && !storageStillConnected) {
                void this.#syncStateTracker.resetStorage(storageId).catch(error => {
                    this.emit("storage-error", { documentId: "unknown", error, operation: "sync-state-reset" });
                });
            }
        });`

const loadSyncStateBefore = `            loadSyncState: async (documentId, pid) => {
                if (!this.storageSubsystem)
                    return;`
const loadSyncStateAfter = `            loadSyncState: async (documentId, pid) => {
                if (!this.storageSubsystem)
                    return;
                // A void transport API cannot acknowledge that its final frame
                // reached the remote peer. Enterprise hubs prefer a truthful
                // empty reconnect state over resuming from possibly refused
                // progress; in-memory state remains active during a connection.
                if (String(globalThis.process?.env?.AM_PERSIST_SYNC_STATE ?? "on").toLowerCase() === "off")
                    return;`
const loadSyncStateResetBarrierBefore = `                const { storageId, isEphemeral: isEph } = this.peerMetadataByPeerId[pid] || {};
                if (!storageId || isEph)
                    return;
                return this.storageSubsystem.loadSyncState(documentId, storageId);`
const loadSyncStateResetBarrierAfter = `                const { storageId, isEphemeral: isEph } = this.peerMetadataByPeerId[pid] || {};
                if (!storageId || isEph)
                    return;
                // peer-disconnected and the replacement peer event may be
                // adjacent. Never reload persisted progress until the previous
                // connection's invalidation has durably completed.
                await this.#syncStateTracker.waitForStorageReset(storageId);
                return this.storageSubsystem.loadSyncState(documentId, storageId);`

export function patchRepoBackgroundSaveSource(source) {
  let patched = source
  let changed = false
  if (patched.includes(backgroundSyncTrackerBefore)) {
    patched = patched.replace(backgroundSyncTrackerBefore, backgroundSyncTrackerAfter)
    changed = true
  } else if (patched.includes('new SyncStateTracker(this.storageSubsystem, saveDebounceRate)')
    && !patched.includes('new SyncStateTracker(this.storageSubsystem, saveDebounceRate, {')) {
    throw new Error('Unsupported @automerge/automerge-repo SyncStateTracker construction')
  }
  if (patched.includes(disconnectBefore)) {
    patched = patched.replace(disconnectBefore, disconnectAfter)
    changed = true
  } else if (!patched.includes('AM_RESET_SYNC_STATE_ON_DISCONNECT')) {
    if (patched.includes('networkSubsystem.on("peer-disconnected"')) {
      throw new Error('Unsupported @automerge/automerge-repo peer disconnect lifecycle')
    }
  }
  if (!patched.includes('AM_PERSIST_SYNC_STATE') && patched.includes(loadSyncStateBefore)) {
    patched = patched.replace(loadSyncStateBefore, loadSyncStateAfter)
    changed = true
  } else if (!patched.includes('AM_PERSIST_SYNC_STATE')) {
    if (patched.includes('loadSyncState: async')) {
      throw new Error('Unsupported @automerge/automerge-repo persisted sync-state load lifecycle')
    }
  }
  if (patched.includes('loadSyncState: async') && !patched.includes('waitForStorageReset(storageId)')) {
    if (!patched.includes(loadSyncStateResetBarrierBefore)) {
      throw new Error('Unsupported @automerge/automerge-repo sync-state reset/load barrier')
    }
    patched = patched.replace(loadSyncStateResetBarrierBefore, loadSyncStateResetBarrierAfter)
    changed = true
  }
  if (patched.includes('this.emit("storage-error", { documentId: handle.documentId, error })')) {
    return { source: patched, changed }
  }
  if (patched.includes('onStorageError: ({ documentId, error })')) {
    patched = patched.replaceAll(
      'onStorageError: ({ documentId, error }) => this.emit("storage-error", { documentId, error })',
      'onStorageError: ({ documentId, error, operation }) => this.emit("storage-error", { documentId, error, operation })',
    )
    return { source: patched, changed: true }
  }
  if (patched.includes(backgroundStorageSourceBefore)) {
    return {
      source: patched.replace(backgroundStorageSourceBefore, backgroundStorageSourceAfter),
      changed: true,
    }
  }
  if (!patched.includes(backgroundSaveBefore)) {
    if (patched.includes('onStorageError: ({ documentId, error, operation })')) {
      return { source: patched, changed }
    }
    throw new Error(
      'Unsupported @automerge/automerge-repo Repo background-save source. ' +
      'Review the rejected-save patch before upgrading the dependency.',
    )
  }
  return { source: patched.replace(backgroundSaveBefore, backgroundSaveAfter), changed: true }
}

const storageErrorFieldBefore = `    #saveFns = {};`
const storageErrorFieldAfter = `    #saveFns = {};
    #onStorageError;`
const storageErrorConstructorBefore = `    constructor(storage, saveDebounceRate, { priority = 1 } = {}) {
        this.#storage = storage;`
const storageErrorConstructorAfter = `    constructor(storage, saveDebounceRate, { priority = 1, onStorageError } = {}) {
        this.#storage = storage;
        this.#onStorageError = onStorageError;`
const storageErrorSaveBefore = `            fn = this.#saveFns[documentId] = asyncThrottle(({ doc, handle }) => this.#storage.saveDoc(handle.documentId, doc), this.#saveDebounceRate);`
const storageErrorSaveAfter = `            fn = this.#saveFns[documentId] = asyncThrottle(({ doc, handle }) => this.#storage.saveDoc(handle.documentId, doc).catch(error => {
                this.#onStorageError?.({ documentId: handle.documentId, error, operation: "document" });
            }), this.#saveDebounceRate);`

export function patchStorageSourceBackgroundSaveSource(source) {
  if (source.includes('this.#onStorageError?.({ documentId: handle.documentId, error, operation: "document" })')) {
    return { source, changed: false }
  }
  if (source.includes('this.#onStorageError?.({ documentId: handle.documentId, error })')) {
    return {
      source: source.replace(
        'this.#onStorageError?.({ documentId: handle.documentId, error })',
        'this.#onStorageError?.({ documentId: handle.documentId, error, operation: "document" })',
      ),
      changed: true,
    }
  }
  // In 2.5 Repo owns the throttled listener and is patched above. StorageSource
  // owns it in 2.6, so both halves of the callback bridge must be present.
  if (!source.includes(storageErrorSaveBefore)) return { source, changed: false }
  if (!source.includes(storageErrorFieldBefore) || !source.includes(storageErrorConstructorBefore)) {
    throw new Error(
      'Unsupported @automerge/automerge-repo StorageSource. ' +
      'Review the rejected-save bridge before upgrading the dependency.',
    )
  }
  return {
    source: source
      .replace(storageErrorFieldBefore, storageErrorFieldAfter)
      .replace(storageErrorConstructorBefore, storageErrorConstructorAfter)
      .replace(storageErrorSaveBefore, storageErrorSaveAfter),
    changed: true,
  }
}

const syncStateErrorFieldBefore = `    #throttledSaveSyncStateHandlers = {};`
const syncStateErrorFieldAfter = `    #throttledSaveSyncStateHandlers = {};
    #onStorageError;
    #syncStateDocuments = {};
    #syncStateGenerations = {};
    #pendingSyncStateSaves = {};
    #resetSyncStatePromises = {};`
const syncStateErrorConstructorBefore = `    constructor(storage, saveDebounceRate) {
        this.#storage = storage;
        this.#saveDebounceRate = saveDebounceRate;
    }`
const syncStateErrorConstructorAfter = `    constructor(storage, saveDebounceRate, { onStorageError } = {}) {
        this.#storage = storage;
        this.#saveDebounceRate = saveDebounceRate;
        this.#onStorageError = onStorageError;
    }`
const syncStateErrorSaveBefore = `            handler = this.#throttledSaveSyncStateHandlers[storageId] = asyncThrottle(({ documentId, syncState }) => this.#storage.saveSyncState(documentId, storageId, syncState), this.#saveDebounceRate);`
const syncStateErrorSaveAfter = `            handler = this.#throttledSaveSyncStateHandlers[storageId] = asyncThrottle(async ({ documentId, syncState, generation }) => {
                await this.#resetSyncStatePromises[storageId];
                if (generation !== (this.#syncStateGenerations[storageId] ?? 0))
                    return;
                await this.#storage.saveSyncState(documentId, storageId, syncState);
            }, this.#saveDebounceRate);`
const syncStateErrorFieldIntermediate = `    #throttledSaveSyncStateHandlers = {};
    #onStorageError;`
const syncStateErrorSaveIntermediate = `            handler = this.#throttledSaveSyncStateHandlers[storageId] = asyncThrottle(({ documentId, syncState }) => this.#storage.saveSyncState(documentId, storageId, syncState).catch(error => {
                this.#onStorageError?.({ documentId, error, operation: "sync-state" });
            }), this.#saveDebounceRate);`

const syncStateSaveInvocationBefore = `        void handler(payload);`
const syncStateSaveInvocationAfter = `        const generation = this.#syncStateGenerations[storageId] ?? 0;
        const documents = this.#syncStateDocuments[storageId] ?? new Set();
        documents.add(payload.documentId);
        this.#syncStateDocuments[storageId] = documents;
        const pending = handler({ ...payload, generation }).catch(error => {
            this.#onStorageError?.({ documentId: payload.documentId, error, operation: "sync-state" });
        });
        this.#pendingSyncStateSaves[storageId] = pending;
        void pending.finally(() => {
            if (this.#pendingSyncStateSaves[storageId] === pending)
                delete this.#pendingSyncStateSaves[storageId];
        });`

const syncStateStorageCheckBefore = `        if (!this.#storage) {
            return;
        }
        if (!storageId || isEphemeral) {`
const syncStateStorageCheckAfter = `        if (!this.#storage) {
            return;
        }
        if (String(globalThis.process?.env?.AM_PERSIST_SYNC_STATE ?? "on").toLowerCase() === "off") {
            return;
        }
        if (!storageId || isEphemeral) {`

const syncStateDeleteBefore = `    delete(documentId) {
        delete this.#syncInfo[documentId];
    }`
const syncStateDeleteAfter = `    delete(documentId) {
        delete this.#syncInfo[documentId];
        for (const documents of Object.values(this.#syncStateDocuments))
            documents.delete(documentId);
    }
    /**
     * Wait for an invalidation already started by a prior connection. The
     * network adapter can announce a replacement socket immediately after the
     * disconnect event, so persisted state loads use this as a race barrier.
     */
    async waitForStorageReset(storageId) {
        await this.#resetSyncStatePromises[storageId];
    }
    /**
     * Invalidate persisted protocol progress after the final connection for a
     * storage id closes. This makes a reconnect start from a truthful empty
     * state when the transport may have refused its last outbound frame.
     */
    async resetStorage(storageId) {
        if (!this.#storage)
            return;
        this.#syncStateGenerations[storageId] = (this.#syncStateGenerations[storageId] ?? 0) + 1;
        delete this.#throttledSaveSyncStateHandlers[storageId];
        const documents = [...(this.#syncStateDocuments[storageId] ?? [])];
        delete this.#syncStateDocuments[storageId];
        for (const syncInfo of Object.values(this.#syncInfo))
            delete syncInfo[storageId];
        const previousReset = this.#resetSyncStatePromises[storageId];
        const pendingSave = this.#pendingSyncStateSaves[storageId];
        const reset = Promise.allSettled([previousReset, pendingSave].filter(Boolean)).then(async () => {
            for (const documentId of documents) {
                await this.#storage.removeSyncState(documentId, storageId).catch(error => {
                    this.#onStorageError?.({ documentId, error, operation: "sync-state-reset" });
                });
            }
        });
        this.#resetSyncStatePromises[storageId] = reset;
        await reset;
        if (this.#resetSyncStatePromises[storageId] === reset)
            delete this.#resetSyncStatePromises[storageId];
    }`

export function patchSyncStateTrackerBackgroundSaveSource(source) {
  if (source.includes('async resetStorage(storageId)')) {
    let migrated = source
    let changed = false
    if (!migrated.includes('async waitForStorageReset(storageId)')) {
      migrated = migrated.replace(
        '    async resetStorage(storageId) {',
        `    async waitForStorageReset(storageId) {
        await this.#resetSyncStatePromises[storageId];
    }
    async resetStorage(storageId) {`,
      )
      changed = true
    }
    if (migrated.includes('AM_PERSIST_SYNC_STATE')) return { source: migrated, changed }
    if (!source.includes(syncStateStorageCheckBefore)) {
      throw new Error('Unsupported persisted sync-state save lifecycle migration')
    }
    return {
      source: migrated.replace(syncStateStorageCheckBefore, syncStateStorageCheckAfter),
      changed: true,
    }
  }
  let normalized = source
  if (normalized.includes(syncStateErrorFieldIntermediate)) {
    normalized = normalized.replace(syncStateErrorFieldIntermediate, syncStateErrorFieldBefore)
  }
  if (normalized.includes(syncStateErrorConstructorAfter)) {
    normalized = normalized.replace(syncStateErrorConstructorAfter, syncStateErrorConstructorBefore)
  }
  if (normalized.includes(syncStateErrorSaveIntermediate)) {
    normalized = normalized.replace(syncStateErrorSaveIntermediate, syncStateErrorSaveBefore)
  }
  const required = [
    syncStateErrorFieldBefore,
    syncStateErrorConstructorBefore,
    syncStateErrorSaveBefore,
    syncStateSaveInvocationBefore,
    syncStateDeleteBefore,
    syncStateStorageCheckBefore,
  ]
  if (required.some((fragment) => !normalized.includes(fragment))) {
    throw new Error(
      'Unsupported @automerge/automerge-repo SyncStateTracker. ' +
      'Review the rejected sync-state save bridge before upgrading the dependency.',
    )
  }
  return {
    source: normalized
      .replace(syncStateErrorFieldBefore, syncStateErrorFieldAfter)
      .replace(syncStateErrorConstructorBefore, syncStateErrorConstructorAfter)
      .replace(syncStateErrorSaveBefore, syncStateErrorSaveAfter)
      .replace(syncStateSaveInvocationBefore, syncStateSaveInvocationAfter)
      .replace(syncStateDeleteBefore, syncStateDeleteAfter)
      .replace(syncStateStorageCheckBefore, syncStateStorageCheckAfter),
    changed: true,
  }
}

const removeSyncStateBefore = `    async saveSyncState(documentId, storageId, syncState) {
        const key = [documentId, "sync-state", storageId];
        await this.#storageAdapter.save(key, A.encodeSyncState(syncState));
    }`
const removeSyncStateAfter = `    async saveSyncState(documentId, storageId, syncState) {
        const key = [documentId, "sync-state", storageId];
        await this.#storageAdapter.save(key, A.encodeSyncState(syncState));
    }
    async removeSyncState(documentId, storageId) {
        const key = [documentId, "sync-state", storageId];
        await this.#storageAdapter.remove(key);
    }`

export function patchStorageSubsystemSyncStateSource(source) {
  if (source.includes('async removeSyncState(documentId, storageId)')) {
    return { source, changed: false }
  }
  if (!source.includes(removeSyncStateBefore)) {
    throw new Error(
      'Unsupported @automerge/automerge-repo StorageSubsystem. ' +
      'Review sync-state invalidation before upgrading the dependency.',
    )
  }
  return { source: source.replace(removeSyncStateBefore, removeSyncStateAfter), changed: true }
}

const bulkLoadBefore = `        const newDoc = A.loadIncremental(A.init(), binary);`

const bulkLoadSentinel = 'maplespire: bulk document load'

const bulkLoadAfter = `        // ${bulkLoadSentinel}.
        // A.loadIncremental replays the binary through the PATCH pipeline —
        // applyAndReturnPatches — so every string crosses the wasm→JS boundary
        // as a patch value. A.load materialises in bulk instead. Measured in
        // this worktree (24 shards of 512 objects, 884 kB, automerge 3.2.6):
        // 1825 ms → 1042 ms, i.e. 1.75x. Heads and materialised content are
        // identical for snapshot-only, snapshot+incremental, duplicated-chunk,
        // concurrent-branch and empty documents.
        //
        // The fallback is REQUIRED, but it is NOT a cure for damaged storage:
        // it only rescues the shapes where A.load is STRICTER than
        // loadIncremental (e.g. trailing garbage, which A.load rejects with
        // "Invalid magic bytes" and loadIncremental accepts). Shapes that BOTH
        // reject — a truncated chunk, leading garbage — still throw out of
        // loadDoc exactly as they did before this patch. StorageSource.attach
        // attaches no .catch(), so those remain a pending-forever query; that
        // hang is pre-existing and unchanged, not introduced and not fixed here.
        let newDoc;
        try {
            newDoc = A.load(binary);
        }
        catch (error) {
            // Never silent: the whole justification for A.load is speed, and a
            // dependency upgrade that made it throw for every document would
            // otherwise slow boots down while every check still passed.
            this.#log.warn(\`bulk load failed for \${documentId}, falling back to incremental\`, error);
            newDoc = A.loadIncremental(A.init(), binary);
        }`

export function patchStorageSubsystemBulkLoadSource(source) {
  // Key on a marker unique to THIS patch. Guarding on `newDoc = A.load(binary)`
  // alone would report "already patched" for a half-applied edit — or for a
  // future automerge-repo that adopts A.load itself — leaving an unguarded
  // A.load in place while --check reports everything verified.
  if (source.includes(bulkLoadSentinel)) {
    return { source, changed: false }
  }
  if (!source.includes(bulkLoadBefore)) {
    throw new Error(
      'Unsupported @automerge/automerge-repo StorageSubsystem loadDoc. ' +
      'Review the bulk document-load patch before upgrading the dependency.',
    )
  }
  return { source: source.replace(bulkLoadBefore, bulkLoadAfter), changed: true }
}

/** StorageSubsystem patches, applied to the one file they share. */
export function patchStorageSubsystemSource(source) {
  const syncState = patchStorageSubsystemSyncStateSource(source)
  const bulkLoad = patchStorageSubsystemBulkLoadSource(syncState.source)
  return { source: bulkLoad.source, changed: syncState.changed || bulkLoad.changed }
}

function patchInstalledStorageSubsystemSource(source) {
  const existing = patchStorageSubsystemSource(source)
  const barrier = patchDocumentSaveBarrierSource(existing.source)
  return { source: barrier.source, changed: existing.changed || barrier.changed }
}

function patchInstalledStorageSource(source) {
  const existing = patchStorageSourceBackgroundSaveSource(source)
  const current = patchStorageSourceCurrentDocumentSource(existing.source)
  return { source: current.source, changed: existing.changed || current.changed }
}

const changeBefore = `        this.#sendUpdate(doc => A.change(doc, options, callback));`

const changeAfter = `        this.#sendUpdate(doc => {
            try {
                return A.change(doc, options, callback);
            }
            catch (error) {
                // automerge-repo 2.5.6 can retain a snapshot invalidated by a
                // concurrent sync update. Automerge rejects it before invoking
                // the callback, so one retry on a writable clone is safe.
                if (!(error instanceof RangeError) ||
                    !error.message.includes("Attempting to change an outdated document"))
                    throw error;
                this.#log("recovering outdated document before local change");
                return A.change(A.clone(doc, A.getActorId(doc)), options, callback);
            }
        });`

export function patchDocHandleOutdatedChangeSource(source) {
  if (source.includes('recovering outdated document before local change')) {
    return { source, changed: false }
  }
  if (source.includes('this.#document.applyMutation(doc => A.change(doc, options, callbackOrValue))')) {
    return { source, changed: false }
  }
  if (!source.includes(changeBefore)) {
    throw new Error(
      'Unsupported @automerge/automerge-repo DocHandle source. ' +
      'Review the outdated-document recovery patch before upgrading the dependency.',
    )
  }
  return { source: source.replace(changeBefore, changeAfter), changed: true }
}

export async function applyAutomergePeerSyncStatePatch(
  docPath = dependencyPaths().docPath,
  collectionPath = dependencyPaths().collectionPath,
  repoPath = dependencyPaths().repoPath,
  handlePath = dependencyPaths().handlePath,
  storageSourcePath = dependencyPaths().storageSourcePath,
  syncStateTrackerPath = dependencyPaths().syncStateTrackerPath,
  storageSubsystemPath = dependencyPaths().storageSubsystemPath,
  throttlePath = dependencyPaths().throttlePath,
  documentPath = dependencyPaths().documentPath,
  registryPath = dependencyPaths().registryPath,
  storageSubsystemTypesPath = dependencyPaths().storageSubsystemTypesPath,
) {
  verifyInFlightSdkVersion(JSON.parse(await readFile(resolve(dirname(docPath), '../../../automerge/package.json'), 'utf8')))
  const docPatched = patchDocSynchronizerSource(await readFile(docPath, 'utf8'))
  const collectionPatched = patchCollectionSynchronizerSource(await readFile(collectionPath, 'utf8'))
  const repoPatched = patchRepoBackgroundSaveSource(await readFile(repoPath, 'utf8'))
  const handlePatched = patchDocHandleOutdatedChangeSource(await readFile(handlePath, 'utf8'))
  const storageSourcePatched = patchInstalledStorageSource(
    await readFile(storageSourcePath, 'utf8'),
  )
  const syncStateTrackerPatched = patchSyncStateTrackerBackgroundSaveSource(
    await readFile(syncStateTrackerPath, 'utf8'),
  )
  const storageSubsystemPatched = patchInstalledStorageSubsystemSource(
    await readFile(storageSubsystemPath, 'utf8'),
  )
  const throttlePatched = patchAsyncThrottleSource(await readFile(throttlePath, 'utf8'))
  const documentPatched = patchDocumentObservedDiffSource(await readFile(documentPath, 'utf8'))
  const registryPatched = patchRegistryChangeObserversSource(await readFile(registryPath, 'utf8'))
  const storageTypesPatched = patchDocumentSaveBarrierTypesSource(await readFile(storageSubsystemTypesPath, 'utf8'))
  if (docPatched.changed) await writeFile(docPath, docPatched.source, 'utf8')
  if (collectionPatched.changed) await writeFile(collectionPath, collectionPatched.source, 'utf8')
  if (repoPatched.changed) await writeFile(repoPath, repoPatched.source, 'utf8')
  if (handlePatched.changed) await writeFile(handlePath, handlePatched.source, 'utf8')
  if (storageSourcePatched.changed) await writeFile(storageSourcePath, storageSourcePatched.source, 'utf8')
  if (syncStateTrackerPatched.changed) await writeFile(syncStateTrackerPath, syncStateTrackerPatched.source, 'utf8')
  if (storageSubsystemPatched.changed) await writeFile(storageSubsystemPath, storageSubsystemPatched.source, 'utf8')
  if (throttlePatched.changed) await writeFile(throttlePath, throttlePatched.source, 'utf8')
  if (documentPatched.changed) await writeFile(documentPath, documentPatched.source, 'utf8')
  if (registryPatched.changed) await writeFile(registryPath, registryPatched.source, 'utf8')
  if (storageTypesPatched.changed) await writeFile(storageSubsystemTypesPath, storageTypesPatched.source, 'utf8')
  return docPatched.changed || collectionPatched.changed || repoPatched.changed
    || handlePatched.changed || storageSourcePatched.changed || syncStateTrackerPatched.changed
    || storageSubsystemPatched.changed || throttlePatched.changed || documentPatched.changed || registryPatched.changed || storageTypesPatched.changed
}

export async function applyAutomergePatchesAtInstallRoot(installRoot = scriptDirectory) {
  const sdkPlans = await prepareSyncStateLifetimePatch(installRoot)
  const paths = dependencyPaths(installRoot)
  const repoChanged = await applyAutomergePeerSyncStatePatch(
    paths.docPath,
    paths.collectionPath,
    paths.repoPath,
    paths.handlePath,
    paths.storageSourcePath,
    paths.syncStateTrackerPath,
    paths.storageSubsystemPath,
    paths.throttlePath,
    paths.documentPath,
    paths.registryPath,
    paths.storageSubsystemTypesPath,
  )
  const sdkChanged = await applySyncStateLifetimePatch(sdkPlans)
  return repoChanged || sdkChanged
}

export async function verifyAutomergePatchesAtInstallRoot(installRoot = scriptDirectory) {
  const sdkPlans = await prepareSyncStateLifetimePatch(installRoot)
  const paths = dependencyPaths(installRoot)
  verifyInFlightSdkVersion(JSON.parse(await readFile(resolve(installRoot, 'node_modules/@automerge/automerge/package.json'), 'utf8')))
  const results = [
    ['DocSynchronizer.js', patchDocSynchronizerSource(await readFile(paths.docPath, 'utf8'))],
    ['CollectionSynchronizer.js', patchCollectionSynchronizerSource(await readFile(paths.collectionPath, 'utf8'))],
    ['Repo.js', patchRepoBackgroundSaveSource(await readFile(paths.repoPath, 'utf8'))],
    ['DocHandle.js', patchDocHandleOutdatedChangeSource(await readFile(paths.handlePath, 'utf8'))],
    ['StorageSource.js', patchInstalledStorageSource(await readFile(paths.storageSourcePath, 'utf8'))],
    ['SyncStateTracker.js', patchSyncStateTrackerBackgroundSaveSource(await readFile(paths.syncStateTrackerPath, 'utf8'))],
    ['StorageSubsystem.js', patchInstalledStorageSubsystemSource(await readFile(paths.storageSubsystemPath, 'utf8'))],
    ['helpers/throttle.js', patchAsyncThrottleSource(await readFile(paths.throttlePath, 'utf8'))],
    ['Document.js', patchDocumentObservedDiffSource(await readFile(paths.documentPath, 'utf8'))],
    ['HandleRegistry.js', patchRegistryChangeObserversSource(await readFile(paths.registryPath, 'utf8'))],
    ['StorageSubsystem.d.ts', patchDocumentSaveBarrierTypesSource(await readFile(paths.storageSubsystemTypesPath, 'utf8'))],
  ]
  const stale = results.filter(([, result]) => result.changed).map(([name]) => name)
  stale.push(...sdkPlans.filter(plan => plan.changed).map(plan => plan.path))
  if (stale.length > 0) {
    throw new Error(
      `Automerge compatibility patch is stale for ${stale.join(', ')}. ` +
      'Run npm ci so the exact locked dependency is installed and patched.',
    )
  }
  return true
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  const checkOnly = args[0] === '--check'
  const rootArg = checkOnly ? args[1] : args[0]
  const installRoot = rootArg ? resolve(process.cwd(), rootArg) : scriptDirectory
  if (checkOnly) {
    await verifyAutomergePatchesAtInstallRoot(installRoot)
    console.log('Automerge compatibility patches verified.')
  } else {
    const changed = await applyAutomergePatchesAtInstallRoot(installRoot)
    console.log(changed
      ? 'Patched automerge-repo peer cleanup, rejected saves, and outdated changes.'
      : 'Automerge peer, background-save, and outdated-change patches already applied.')
  }
}
