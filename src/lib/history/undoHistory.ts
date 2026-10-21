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

import type { SelectedItem } from '../../types'
import type { Direction } from './applyDiff'
import { composeDiffs, diffModel, isContinuation, subtractKeys, type DiffableState, type ModelDiff } from './modelDiff'

/**
 * The canvas undo/redo stack.
 *
 * ## What gets recorded
 * `wrap()` wraps an allow-listed store action. Only the OUTERMOST wrapped call
 * records (`moveObject` → `moveObjectsBatch` → `updatePlacementsBatch` is one
 * record), as the diff between the store before and after it. Remote changes
 * are applied by the sync bridge with `setState`, never through an action, so a
 * peer's edit never lands on this stack; the one remote write that can happen
 * synchronously INSIDE an action (`withRemote` from a store subscriber) is
 * reported through `noteRemote` and subtracted.
 *
 * ## One gesture = one entry
 * Records made in the same event-loop task join one entry (a palette drop is
 * `addGroup` + `addGroupToDiagram`). A later record also joins the open entry
 * when it only UPDATES things the entry already changed — a typing burst, or
 * the 3D board's per-frame drag writes — while the pointer is held, while a
 * text field has focus, or within `IDLE_MS` of the previous record. `seal()` closes the open entry; the canvas
 * calls it on pointerdown, on a keydown outside a text field and on focusout.
 *
 * ## Scope
 * One stack per (workspace, diagram) — the host's `scope()`. Undo on a diagram
 * only ever undoes what was done while looking at it.
 */

export const MAX_ENTRIES = 100
export const IDLE_MS = 1000

export interface RecordedState extends DiffableState {
  selectedItems: readonly SelectedItem[]
}

export interface HistoryEntry {
  diff: ModelDiff
  selectionBefore: readonly SelectedItem[]
  selectionAfter: readonly SelectedItem[]
}

export interface ApplyOutcome {
  applied: ModelDiff
  skipped: number
}

export interface HistoryHost {
  /** The stack the next record belongs to; `null` = do not record now. */
  scope(): string | null
  /** Apply a diff backwards (undo) or forwards (redo) as ONE local edit and
   * restore `selection`. Returns what was really applied. */
  apply(diff: ModelDiff, direction: Direction, selection: readonly SelectedItem[]): ApplyOutcome
  /** Some changes of the entry could not be applied (a peer changed them). */
  onPartial?(skipped: number, direction: Direction): void
}

interface Stack {
  undo: HistoryEntry[]
  redo: HistoryEntry[]
}

export interface UndoAvailability {
  canUndo: boolean
  canRedo: boolean
}

export class UndoHistory {
  private host: HistoryHost | null = null
  private readonly stacks = new Map<string, Stack>()
  private open: { scope: string; entry: HistoryEntry; task: number; lastAt: number } | null = null
  private task = 0
  private taskBumpScheduled = false
  private depth = 0
  private suppressed = 0
  private remoteKeys: Set<string> | null = null
  private readonly listeners = new Set<() => void>()
  private snapshot: UndoAvailability = { canUndo: false, canRedo: false }
  /** Set by the canvas while a pointer button is held (a drag in progress). */
  pointerHeld = false
  /** True while a text field has focus: one field session is one undo step
   * however long the user pauses (leaving the field seals it). Set by the canvas. */
  editingField: () => boolean = () => false
  /** Injectable clock, for tests. */
  now: () => number = () => Date.now()

  configure(host: HistoryHost | null): void {
    this.host = host
    this.notify()
  }

  /** Wrap a store action so its outermost call is recorded. */
  wrap<A extends unknown[], R>(fn: (...args: A) => R, getState: () => RecordedState): (...args: A) => R {
    return (...args: A): R => {
      if (this.depth > 0 || this.suppressed > 0 || !this.host || this.host.scope() === null) {
        this.depth++
        try { return fn(...args) } finally { this.depth-- }
      }
      const before = getState()
      this.remoteKeys = null
      this.depth++
      try {
        return fn(...args)
      } finally {
        this.depth--
        const remote = this.remoteKeys
        this.remoteKeys = null
        this.record(before, getState(), remote)
      }
    }
  }

  /** True while a wrapped action is running (the bridge asks before diffing). */
  get recording(): boolean {
    return this.depth > 0 && this.suppressed === 0
  }

  /** A remote apply happened synchronously inside a recorded action: whatever
   * it changed is not the user's and must not be undone. */
  noteRemote(before: DiffableState, after: DiffableState): void {
    if (!this.recording || before === after) return
    const keys = this.remoteKeys ?? new Set<string>()
    for (const key of diffModel(before, after).keys()) keys.add(key)
    this.remoteKeys = keys
  }

  /** Run store writes that must never be recorded (crash replay, undo itself). */
  suppress<T>(fn: () => T): T {
    this.suppressed++
    try { return fn() } finally { this.suppressed-- }
  }

  record(before: RecordedState, after: RecordedState, remoteKeys?: Iterable<string> | null): void {
    if (!this.host || before === after) return
    let diff = diffModel(before, after)
    if (remoteKeys) diff = subtractKeys(diff, remoteKeys)
    if (diff.size === 0) return
    const scope = this.host.scope()
    if (scope === null) return
    const now = this.now()
    const stack = this.stackFor(scope)
    stack.redo.length = 0
    const open = this.open
    const canJoin = open !== null
      && open.scope === scope
      && stack.undo[stack.undo.length - 1] === open.entry
      && (open.task === this.task
        || (isContinuation(open.entry.diff, diff)
          && (this.pointerHeld || this.editingField() || now - open.lastAt < IDLE_MS)))
    if (canJoin) {
      open.entry.diff = composeDiffs(open.entry.diff, diff)
      open.entry.selectionAfter = after.selectedItems
      open.task = this.task
      open.lastAt = now
      if (open.entry.diff.size === 0) {
        // Everything cancelled out (dragged back to where it started).
        stack.undo.pop()
        this.open = null
      }
    } else {
      const entry: HistoryEntry = { diff, selectionBefore: before.selectedItems, selectionAfter: after.selectedItems }
      stack.undo.push(entry)
      if (stack.undo.length > MAX_ENTRIES) stack.undo.splice(0, stack.undo.length - MAX_ENTRIES)
      this.open = { scope, entry, task: this.task, lastAt: now }
    }
    this.scheduleTaskBump()
    this.notify()
  }

  /** Close the open entry: the next record starts a new one. */
  seal(): void {
    this.open = null
  }

  undo(): boolean {
    return this.step('undo')
  }

  redo(): boolean {
    return this.step('redo')
  }

  private step(direction: Direction): boolean {
    this.seal()
    const host = this.host
    const scope = host?.scope() ?? null
    if (!host || scope === null) return false
    const stack = this.stacks.get(scope)
    if (!stack) return false
    const source = direction === 'undo' ? stack.undo : stack.redo
    const target = direction === 'undo' ? stack.redo : stack.undo
    let done = false
    while (source.length > 0 && !done) {
      const entry = source.pop()!
      const selection = direction === 'undo' ? entry.selectionBefore : entry.selectionAfter
      const outcome = this.suppress(() => host.apply(entry.diff, direction, selection))
      // Nothing of it left to apply (peers changed all of it): it is dropped
      // and the next entry is tried, so one keypress always does something.
      if (outcome.applied.size === 0) continue
      target.push({ ...entry, diff: outcome.applied })
      if (outcome.skipped > 0) host.onPartial?.(outcome.skipped, direction)
      done = true
    }
    this.notify()
    return done
  }

  /** Forget everything (workspace, version or draft switch; History restore). */
  clear(): void {
    this.stacks.clear()
    this.open = null
    this.notify()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): UndoAvailability => this.snapshot

  /** Recompute availability for the current scope and tell subscribers. */
  notify(): void {
    const scope = this.host?.scope() ?? null
    const stack = scope === null ? undefined : this.stacks.get(scope)
    const canUndo = (stack?.undo.length ?? 0) > 0
    const canRedo = (stack?.redo.length ?? 0) > 0
    if (canUndo !== this.snapshot.canUndo || canRedo !== this.snapshot.canRedo) {
      this.snapshot = { canUndo, canRedo }
    }
    for (const listener of this.listeners) listener()
  }

  /** Test seam: entry counts for a scope. */
  sizes(scope: string): { undo: number; redo: number } {
    const stack = this.stacks.get(scope)
    return { undo: stack?.undo.length ?? 0, redo: stack?.redo.length ?? 0 }
  }

  /** Read-only probe (dev `window.__undoHistory`, e2e assertions): the change
   * keys of every entry of the current scope, oldest first. */
  inspect(): { scope: string | null; undo: string[][]; redo: string[][] } {
    const scope = this.host?.scope() ?? null
    const stack = scope === null ? undefined : this.stacks.get(scope)
    return {
      scope,
      undo: (stack?.undo ?? []).map((entry) => [...entry.diff.keys()]),
      redo: (stack?.redo ?? []).map((entry) => [...entry.diff.keys()]),
    }
  }

  private stackFor(scope: string): Stack {
    let stack = this.stacks.get(scope)
    if (!stack) {
      stack = { undo: [], redo: [] }
      this.stacks.set(scope, stack)
    }
    return stack
  }

  private scheduleTaskBump(): void {
    if (this.taskBumpScheduled) return
    this.taskBumpScheduled = true
    setTimeout(() => {
      this.task++
      this.taskBumpScheduled = false
    }, 0)
  }

  /** Test seam: end the current task now (what a macrotask boundary does). */
  endTask(): void {
    this.task++
  }
}

/** The app's single history. */
export const undoHistory = new UndoHistory()
