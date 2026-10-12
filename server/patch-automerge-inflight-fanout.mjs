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

// Native ordering: Automerge commit a11222254d2f86ec9df0738e7002f15a930fe9b4,
// rust/automerge/src/sync.rs (generate_sync_message). The source and the
// executed controls were checked during load qualification. This only
// suppresses implicit clean-peer work; it is not an ACK or durability proof.
const before = `                                if (!preparedHeads.every(head => sharedHeads.has(head)))
                                    peer.dirty = true;`

const after = `                                if (!preparedHeads.every(head => sharedHeads.has(head))) {
                                    const state = peer.syncState;
                                    // Automerge 3.2.6 sync.rs returns None without changing
                                    // state when these heads were already sent in flight.
                                    // Restrict this shortcut to an empty first lastSync:
                                    // any other Have may require the native reset message.
                                    // Explicit dirty flags never enter this branch.
                                    const firstHave = Array.isArray(state.theirHave)
                                        ? state.theirHave[0] : undefined;
                                    const emptyLastSync = firstHave !== null && typeof firstHave === "object" &&
                                        Array.isArray(firstHave.lastSync) && firstHave.lastSync.length === 0;
                                    let waitingForReply = false;
                                    if (state.inFlight === true && state.haveResponded === true && emptyLastSync &&
                                        Array.isArray(state.lastSentHeads)) {
                                        // A prepared JS view can have old heads while its
                                        // backend advances during a yield. Backend getHeads
                                        // can itself be isolated: the metadata check also
                                        // excludes changes outside that isolated view.
                                        const heads = A.getBackend(preparedDoc).getHeads();
                                        waitingForReply = heads.length === state.lastSentHeads.length &&
                                            heads.every((head, index) => head === state.lastSentHeads[index]) &&
                                            A.getChangesMetaSince(preparedDoc, state.lastSentHeads).length === 0;
                                    }
                                    if (!waitingForReply)
                                        peer.dirty = true;
                                }`

/** The native None/reset ordering is version-specific; upgrades need a review. */
export function verifyInFlightSdkVersion(packageInfo) {
  if (packageInfo.name !== '@automerge/automerge' || packageInfo.version !== '3.2.6') {
    throw new Error('Unsupported Automerge SDK for in-flight fan-out; review native sync semantics before upgrading.')
  }
}

export function patchInFlightFanoutSource(source) {
  const oldCount = source.split(before).length - 1
  const newCount = source.split(after).length - 1
  if (oldCount === 0 && newCount === 1) return { source, changed: false }
  if (oldCount !== 1 || newCount !== 0) {
    throw new Error('Unsupported automerge-repo in-flight fan-out source; review its implicit dirty transition before upgrading.')
  }
  return { source: source.replace(before, after), changed: true }
}
