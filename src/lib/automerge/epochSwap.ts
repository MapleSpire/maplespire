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

import type { DocHandle } from '@automerge/automerge-repo'

/**
 * The epoch hop's SWAP, made ATOMIC (G4-16f):
 * an ordered list of steps, each with its undo. When a step throws, the steps
 * that completed are undone in REVERSE order and the error is rethrown — so a
 * swap that fails after detaching the old listeners re-attaches the old
 * epoch instead of leaving the tab projecting nothing. An undo that itself
 * throws is reported and the next one still runs: a partial rollback beats
 * none.
 */
export interface SwapStep {
  name: string
  run(): void
  undo(): void
}

export function runAtomically(steps: readonly SwapStep[], onUndoError?: (step: string, error: unknown) => void): void {
  const done: SwapStep[] = []
  try {
    for (const step of steps) {
      step.run()
      done.push(step)
    }
  } catch (error) {
    for (const step of done.reverse()) {
      try { step.undo() } catch (undoError) { onUndoError?.(step.name, undoError) }
    }
    throw error
  }
}

/**
 * The model shards a tab holds that its ModelMeta does not (yet) list: the
 * overflow shards it created whose pointer is still HELD (deferred until the
 * server acknowledges the shard, `publishModelShardReference`). The hop
 * CARRIES them into the new epoch's lists, so the objects they hold stay on
 * screen across the swap; their pointer lands in the CURRENT meta when it is
 * finally written (`writeHeldReference`).
 */
export function unpublishedShards<T>(held: readonly DocHandle<T>[], published: readonly string[]): DocHandle<T>[] {
  const listed = new Set(published)
  return held.filter((handle) => !listed.has(handle.url))
}

/** `base` then each of `extra` whose url `base` lacks. */
export function withCarried<T>(base: readonly DocHandle<T>[], extra: readonly DocHandle<T>[]): DocHandle<T>[] {
  const urls = new Set(base.map((h) => h.url))
  return [...base, ...extra.filter((h) => !urls.has(h.url))]
}
