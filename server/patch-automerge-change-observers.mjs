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

function replaceOnce(source, before, after, name) {
  if (source.includes(after)) {
    if (source.split(after).length !== 2
      || source.split(before).length !== after.split(before).length) {
      throw new Error(`Ambiguous automerge-repo ${name}; mixed or duplicated change-observer patch.`)
    }
    return { source, changed: false }
  }
  if (source.split(before).length !== 2) {
    throw new Error(`Unsupported automerge-repo ${name}; review change-observer patch before upgrading.`)
  }
  return { source: source.replace(before, after), changed: true }
}

/** Sync consumes heads, not materialized patches. Keep its scheduling async. */
export function patchFanoutHeadsSource(source) {
  return replaceOnce(source, '        handle.on("change", scheduleFanout);',
    `        // Sync needs new heads even when no application consumes change patches.
        handle.on("heads-changed", scheduleFanout);`, 'DocSynchronizer')
}

export function patchRegistryChangeObserversSource(source) {
  const anchor = '    dispatchChange(doc, patches, patchInfo) {'
  return replaceOnce(source, anchor, `    hasWritableChangeListeners() {
        for (const [handle, events] of this.#listeners) {
            if (!handle.isReadOnly() && (events.get("change")?.size ?? 0) > 0)
                return true;
        }
        return false;
    }
    dispatchChange(doc, patches, patchInfo) {`, 'HandleRegistry')
}

export function patchDocumentObservedDiffSource(source) {
  const anchor = `        this.registry.dispatchHeadsChanged(after);
        const patches = A.diff(after, beforeHeads, afterHeads);`
  return replaceOnce(source, anchor, `        this.registry.dispatchHeadsChanged(after);
        // Heads callbacks may add/remove change listeners synchronously. Check
        // the entire registry afterwards, including writable sub-handles.
        // Snapshot adoption and heads notifications are unconditional.
        if (!this.registry.hasWritableChangeListeners())
            return;
        const patches = A.diff(after, beforeHeads, afterHeads);`, 'Document')
}
