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

import * as A from '@automerge/automerge'
import { fullValueAt, objectIdAt } from './modelEpochs.js'
import { putToElementMap, renderValue, sameValue, type Heads, type Path } from './modelEpochForward.js'

/**
 * DUPLICATE FORWARDS, and their compensation (G4-16f).
 *
 * A forward's change on a target is idempotent BY MESSAGE: a replay that finds
 * `forwardMessage(journal, target)` on the target does not write again. Two
 * windows still let a SECOND change with the same message land:
 *
 *  1. the change reached a peer by sync before `flush`, then the process
 *     died: the replay does not see it (storage lost it) and writes again;
 *     the peer later syncs the first one back;
 *  2. the journal lease window: a forwarder whose session has just died writes
 *     while another replays.
 *
 * Map puts converge (the same value twice), deletes are idempotent — but a
 * list or text INSERT lands twice and a counter INCREMENT counts twice. So the
 * forwarder records, for each target it completes, the CANONICAL change (the
 * one its element map was rebuilt from) and the target's heads before it.
 * {@link forwardDuplicates} finds every other change carrying the same
 * message after those heads, and {@link planCompensation} undoes what such a
 * duplicate did twice — CONSERVATIVELY, because a delete of content a user
 * kept is worse than a visible duplicate:
 *
 *  - an element the duplicate INSERTED into a sequence that existed before it
 *    is deleted ONLY while its CANONICAL TWIN — the canonical change's insert
 *    of the same planned element into the same sequence, paired by CONTENT
 *    and then by ordinal within a group of equal values; a group whose order
 *    the two changes do not share is `ambiguous` and kept ({@link pairTwins})
 *    — is still there,
 *    and NEITHER copy was edited after the recorded heads (a put on the
 *    element, or any op inside an object the element holds: a duplicated
 *    map or list with nested edits is never deleted). Otherwise the duplicate
 *    is KEPT and reported (`kept`), for an alert: a user deleted the
 *    canonical copy and kept this one, or edited one of the two;
 *  - every counter INCREMENT on a counter that existed before it — in a map
 *    or in a list — is reverted (an increment by the opposite amount).
 *
 * Objects the duplicate CREATED (a whole forwarded entity, a new nested list)
 * are left alone: their creation conflicts with the canonical's at the same
 * key, Automerge keeps one, and both hold the same content — deleting inside
 * the winner would empty it. That conflict is the stated residual: when the
 * duplicate's object wins, the element map's ids for that object point into
 * the losing copy, so a LATER forward that anchors on one of those elements
 * finds it absent and places by the plan's fallback.
 *
 * The compensation is idempotent BY ITS OWN MESSAGE ({@link compensationMessage}):
 * once any change carrying it exists, no second compensation is planned. A
 * compensation change can itself land twice (the same two windows), which
 * would revert a counter twice; so each later pass sums the increments every
 * compensation change of that duplicate made ({@link compensationChanges})
 * and writes only the DIFFERENCE to the one revert owed
 * ({@link planCounterFix}), under {@link compensationFixMessage} — itself
 * counted by the next pass. Deletes need no such fix: two deletes of one
 * element are one delete.
 */

export interface DuplicateCompensationOp {
  kind: 'text-del' | 'list-del' | 'counter'
  /** The sequence (text/list) or the object (map/list) holding the counter. */
  path: Path
  /** text/list: the element id to delete. counter in a list: the element. */
  elemId?: string
  /** counter in a map: its key. */
  key?: string
  /** counter: the amount to add (the opposite of the duplicate's). */
  by?: number
}

export interface KeptDuplicate {
  path: Path
  elemId: string
  reason: 'no-twin' | 'twin-gone' | 'edited' | 'ambiguous'
}

export interface CompensationPlan {
  ops: DuplicateCompensationOp[]
  /** Duplicated elements left in place, for the alert. */
  kept: KeptDuplicate[]
}

export function compensationMessage(forwardMsg: string, duplicateHash: string): string {
  return JSON.stringify({ epochForwardDedupe: duplicateHash, of: JSON.parse(forwardMsg) as unknown })
}

/** The message of a counter FIX: the compensation changes it corrects. */
export function compensationFixMessage(forwardMsg: string, duplicateHash: string, compensations: readonly string[]): string {
  return JSON.stringify({ epochForwardDedupe: duplicateHash, of: JSON.parse(forwardMsg) as unknown, fix: [...compensations].sort() })
}

/** Is `message` a compensation (or a fix) of `duplicateHash` of the forward `forwardMsg`? */
function isCompensationOf(message: string | null | undefined, forwardMsg: string, duplicateHash?: string): boolean {
  if (!message || !message.startsWith('{"epochForwardDedupe"')) return false
  try {
    const parsed = JSON.parse(message) as { epochForwardDedupe?: unknown; of?: unknown }
    return (duplicateHash === undefined || parsed.epochForwardDedupe === duplicateHash)
      && JSON.stringify(parsed.of) === JSON.stringify(JSON.parse(forwardMsg))
  } catch {
    return false
  }
}

/** Every change after `headsBefore` that carries `message`, except `canonical`. */
export function forwardDuplicates(doc: A.Doc<unknown>, message: string, headsBefore: Heads, canonical: string): string[] {
  return A.getChangesMetaSince(doc, headsBefore)
    .filter((meta) => meta.message === message && meta.hash !== canonical)
    .map((meta) => meta.hash)
    .sort()
}

/** Every compensation (and fix) change of `duplicateHash` after `headsBefore`. */
export function compensationChanges(doc: A.Doc<unknown>, forwardMsg: string, duplicateHash: string, headsBefore: Heads): string[] {
  return A.getChangesMetaSince(doc, headsBefore)
    .filter((meta) => isCompensationOf(meta.message, forwardMsg, duplicateHash))
    .map((meta) => meta.hash)
    .sort()
}

/** Has `doc` already compensated `duplicateHash`? */
export function compensated(doc: A.Doc<unknown>, forwardMsg: string, duplicateHash: string, headsBefore: Heads): boolean {
  return compensationChanges(doc, forwardMsg, duplicateHash, headsBefore).length > 0
}

const typeAt = (doc: A.Doc<unknown>, path: Path): string =>
  path.length === 0 ? 'map' : String(fullValueAt(doc, undefined, path)?.[0] ?? 'map')

/** Object id → path, for every object under `entityPaths` in the current doc. */
function objectPaths(doc: A.Doc<unknown>, entityPaths: readonly Path[]): Map<string, Path> {
  const be = A.getBackend(doc)
  const out = new Map<string, Path>()
  const walk = (obj: string, path: Path, type: string) => {
    out.set(obj, path)
    if (type === 'text') return
    const props: Array<string | number> = type === 'list'
      ? Array.from({ length: be.length(obj) }, (_, i) => i)
      : be.keys(obj)
    for (const prop of props) {
      const value = be.getWithType(obj, prop as never) as [string, unknown] | undefined
      if (value && (value[0] === 'map' || value[0] === 'list' || value[0] === 'text' || value[0] === 'table')) {
        walk(String(value[1]), [...path, prop], value[0])
      }
    }
  }
  out.set('_root', [])
  for (const path of entityPaths) {
    // The collection map itself is where a forwarded entity is put.
    for (let i = 1; i < path.length; i += 1) {
      const obj = objectIdAt(doc, undefined, path.slice(0, i))
      if (obj) out.set(obj, path.slice(0, i))
    }
    const obj = objectIdAt(doc, undefined, path)
    if (!obj) continue
    walk(obj, path, typeAt(doc, path))
  }
  return out
}

interface RawOp { action: string; obj: string; elemId?: string; key?: string; insert?: boolean; value?: unknown; datatype?: string }
type Inspected = NonNullable<ReturnType<typeof A.inspectChange>>

const opIdOf = (change: { startOp: number; actor: string }, index: number) => `${change.startOp + index}@${change.actor}`
const MAKE = new Set(['makeMap', 'makeList', 'makeText', 'makeTable'])

/** A change's INSERTS, per sequence object, in op order: their own ids. */
function insertsByObject(change: Inspected): Map<string, string[]> {
  const out = new Map<string, string[]>()
  change.ops.forEach((op, index) => {
    const raw = op as unknown as RawOp
    if (!raw.insert) return
    const list = out.get(raw.obj) ?? []
    list.push(opIdOf(change, index))
    out.set(raw.obj, list)
  })
  return out
}

/** Every object a change CREATED, with what it was created IN: the object,
 * or — for a value put on a list element (the forward's insert-then-copy,
 * `applyTargetPlan`) — that ELEMENT, so the element's subtree holds it. */
function createdParents(change: Inspected): Map<string, string> {
  const out = new Map<string, string>()
  change.ops.forEach((op, index) => {
    const raw = op as unknown as RawOp
    if (!MAKE.has(raw.action)) return
    out.set(opIdOf(change, index), !raw.insert && raw.elemId && raw.elemId !== '_head' ? raw.elemId : raw.obj)
  })
  return out
}

/** The element's value — CURRENT, or at `heads` — or undefined when it is
 * not there. */
function elementValue(doc: A.Doc<unknown>, op: DuplicateCompensationOp, putToElem: ReadonlyMap<string, string>, heads?: Heads): { value: unknown } | undefined {
  const index = elementIndex(doc, op, putToElem, heads)
  if (index < 0) return undefined
  if (op.kind === 'text-del') {
    const text = A.getBackend(doc).text(objectIdAt(doc, heads, op.path)!, heads)
    return { value: String.fromCodePoint(text.codePointAt(index)!) }
  }
  return { value: nodeAt(heads ? A.view(doc, heads) : doc, [...op.path, index]) }
}

/**
 * PAIR each element the duplicate inserted into one sequence with its twin
 * among the canonical change's inserts there: by
 * CONTENT — each element's value right after its own change — then by
 * ordinal WITHIN a group of equal values. Ordinal alone is unsound: two
 * attempts' plans may order their inserts differently (an anchor deleted
 * between them), and "the k-th insert" then names another element. A
 * content group whose two sizes differ is `no-twin`; a group of several
 * equal values whose relative order the two changes do not share is
 * `ambiguous` — both KEPT (and alerted) rather than guessed.
 */
function pairTwins(
  doc: A.Doc<unknown>, kind: DuplicateCompensationOp['kind'], path: Path,
  dup: { hash: string; ids: readonly string[] }, canonical: { hash: string; ids: readonly string[] },
  putToElem: ReadonlyMap<string, string>,
): Map<string, { twin: string } | { reason: 'no-twin' | 'ambiguous' }> {
  const keyOf = (id: string, hash: string) => {
    const value = elementValue(doc, { kind, path, elemId: id }, putToElem, [hash])
    return value ? JSON.stringify(renderValue(value.value)) : `\u0000missing:${id}`
  }
  const dupKeys = dup.ids.map((id) => keyOf(id, dup.hash))
  const twinKeys = canonical.ids.map((id) => keyOf(id, canonical.hash))
  const sameOrder = dupKeys.length === twinKeys.length && dupKeys.every((k, i) => k === twinKeys[i])
  const out = new Map<string, { twin: string } | { reason: 'no-twin' | 'ambiguous' }>()
  const groups = new Map<string, { mine: string[]; theirs: string[] }>()
  dupKeys.forEach((k, i) => { const g = groups.get(k) ?? { mine: [], theirs: [] }; g.mine.push(dup.ids[i]!); groups.set(k, g) })
  twinKeys.forEach((k, i) => { const g = groups.get(k); if (g) g.theirs.push(canonical.ids[i]!) })
  for (const { mine, theirs } of groups.values()) {
    mine.forEach((id, i) => {
      if (mine.length !== theirs.length) out.set(id, { reason: 'no-twin' })
      else if (mine.length > 1 && !sameOrder) out.set(id, { reason: 'ambiguous' })
      else out.set(id, { twin: theirs[i]! })
    })
  }
  return out
}

/** `root` and every object the change created inside it (transitively). */
function subtreeOf(root: string, parents: ReadonlyMap<string, string>): Set<string> {
  const out = new Set<string>([root])
  for (const obj of parents.keys()) {
    const chain = new Set<string>()
    for (let at: string | undefined = obj; at !== undefined && !chain.has(at); at = parents.get(at)) {
      chain.add(at)
      if (at === root) { out.add(obj); break }
    }
  }
  return out
}

/** What OTHER changes after `headsBefore` touched: the elements they put on
 * (or deleted, or incremented) and the objects they wrote into. The forward's
 * own changes and its compensations are not edits. */
function editsSince(doc: A.Doc<unknown>, headsBefore: Heads, forwardMsg: string): { elements: Set<string>; objects: Set<string> } {
  const elements = new Set<string>()
  const objects = new Set<string>()
  for (const raw of A.getChangesSince(doc, headsBefore)) {
    const change = A.decodeChange(raw)
    if (change.message === forwardMsg || isCompensationOf(change.message, forwardMsg)) continue
    for (const op of change.ops as unknown as RawOp[]) {
      objects.add(op.obj)
      if (!op.insert && op.elemId && op.elemId !== '_head') elements.add(op.elemId)
    }
  }
  return { elements, objects }
}

/**
 * What a duplicate did twice, as compensation ops on the CURRENT doc, and the
 * duplicated elements it must leave (see the header).
 */
export function planCompensation(
  doc: A.Doc<unknown>, duplicateHash: string, entityPaths: readonly Path[],
  guard: { canonical: string; headsBefore: Heads; forwardMessage: string },
): CompensationPlan {
  const change = A.inspectChange(doc, duplicateHash)
  if (!change) return { ops: [], kept: [] }
  const canonical = A.inspectChange(doc, guard.canonical)
  const created = createdParents(change)
  const dupInserts = insertsByObject(change)
  const twinInserts = canonical ? insertsByObject(canonical) : new Map<string, string[]>()
  const twinCreated = canonical ? createdParents(canonical) : new Map<string, string>()
  const edits = editsSince(doc, guard.headsBefore, guard.forwardMessage)
  const putToElem = putToElementMap(doc, guard.headsBefore)
  const paths = objectPaths(doc, entityPaths)
  const ops: DuplicateCompensationOp[] = []
  const kept: KeptDuplicate[] = []
  const pairings = new Map<string, Map<string, { twin: string } | { reason: 'no-twin' | 'ambiguous' }>>()
  const editedElement = (id: string, parents: ReadonlyMap<string, string>) =>
    edits.elements.has(id) || [...subtreeOf(id, parents)].some((obj) => edits.objects.has(obj))
  change.ops.forEach((op, index) => {
    const raw = op as unknown as RawOp
    if (created.has(raw.obj)) return
    const path = paths.get(raw.obj)
    if (!path) return
    if (raw.insert) {
      const elemId = opIdOf(change, index)
      const kind = typeAt(doc, path) === 'text' ? 'text-del' : 'list-del'
      let pairing = pairings.get(raw.obj)
      if (!pairing) {
        pairing = pairTwins(doc, kind, path, { hash: duplicateHash, ids: dupInserts.get(raw.obj) ?? [] },
          { hash: guard.canonical, ids: twinInserts.get(raw.obj) ?? [] }, putToElem)
        pairings.set(raw.obj, pairing)
      }
      const paired = pairing.get(elemId) ?? { reason: 'no-twin' as const }
      // Already gone (a user deleted it): nothing to undo, nothing to report.
      const value = elementValue(doc, { kind, path, elemId }, putToElem)
      if (!value) return
      if (!('twin' in paired)) { kept.push({ path, elemId, reason: paired.reason }); return }
      const twin = paired.twin
      const twinValue = elementValue(doc, { kind, path, elemId: twin }, putToElem)
      if (!twinValue) { kept.push({ path, elemId, reason: 'twin-gone' }); return }
      if (editedElement(elemId, created) || editedElement(twin, twinCreated)) { kept.push({ path, elemId, reason: 'edited' }); return }
      // The same planned element holds the same content (plans of two
      // attempts may differ; a mismatch is not a duplicate of THIS element).
      if (!sameValue(value.value, twinValue.value)) { kept.push({ path, elemId, reason: 'no-twin' }); return }
      ops.push({ kind, path, elemId })
    } else if (raw.action === 'inc' && typeof raw.value === 'number') {
      if (typeof raw.key === 'string') ops.push({ kind: 'counter', path, key: raw.key, by: -raw.value })
      else if (raw.elemId) ops.push({ kind: 'counter', path, elemId: raw.elemId, by: -raw.value })
    }
  })
  return { ops, kept }
}

/**
 * The counter FIX owed once compensation changes exist: per counter op of the
 * plan, the one revert owed (`op.by`) minus what every compensation change in
 * `compensations` already incremented on that counter. Empty when they add up
 * — the common case: a single compensation change.
 */
export function planCounterFix(doc: A.Doc<unknown>, ops: readonly DuplicateCompensationOp[], compensations: readonly string[]): DuplicateCompensationOp[] {
  const applied = compensations.map((hash) => A.inspectChange(doc, hash)).filter((c): c is Inspected => Boolean(c))
  const out: DuplicateCompensationOp[] = []
  for (const op of ops) {
    if (op.kind !== 'counter') continue
    const obj = objectIdAt(doc, undefined, op.path)
    if (!obj) continue
    let sum = 0
    for (const change of applied) {
      for (const raw of change.ops as unknown as RawOp[]) {
        if (raw.action !== 'inc' || raw.obj !== obj || typeof raw.value !== 'number') continue
        if (op.key !== undefined ? raw.key === op.key : raw.elemId === op.elemId) sum += raw.value
      }
    }
    const owed = op.by! - sum
    if (owed !== 0) out.push({ ...op, by: owed })
  }
  return out
}

/** The current index of element `elemId` in the list/text at `path`, or -1. */
function elementIndex(doc: A.Doc<unknown>, op: DuplicateCompensationOp, putToElem: ReadonlyMap<string, string>, heads?: Heads): number {
  const obj = objectIdAt(doc, heads, op.path)
  if (!obj) return -1
  const be = A.getBackend(doc)
  if (op.kind === 'text-del') {
    // A cursor of a deleted element still resolves to a position: present
    // only when the element at that position IS it.
    let pos: number
    try { pos = be.getCursorPosition(obj, op.elemId!, heads) } catch { return -1 }
    return pos < be.length(obj, heads) && be.getCursor(obj, pos, heads) === op.elemId ? pos : -1
  }
  // `getAll` names the WINNING op: the element id only for an element never
  // overwritten; a put after the duplicate names it by `elemId`, which
  // `putToElem` (built since the canonical's heads) maps back.
  for (let i = 0, n = be.length(obj, heads); i < n; i += 1) {
    const all = be.getAll(obj, i, heads) as Array<unknown[]>
    if (all.some((v) => { const id = String(v[v.length - 1]); return (putToElem.get(id) ?? id) === op.elemId })) return i
  }
  return -1
}

const nodeAt = (draft: unknown, path: Path): unknown =>
  path.reduce<unknown>((node, step) => (node as Record<string | number, unknown> | undefined)?.[step], draft)

/**
 * Apply compensation ops inside a change on the target (`doc` is the target
 * BEFORE the change, read for positions). Deletes run from the highest
 * position down so earlier ones do not shift later ones. Returns how many ops
 * found nothing to undo (the element is already gone).
 */
export function applyCompensation(
  draft: unknown, doc: A.Doc<unknown>, ops: readonly DuplicateCompensationOp[], headsBefore: Heads,
): { applied: number; unmatched: number } {
  const putToElem = ops.some((op) => op.kind !== 'text-del') ? putToElementMap(doc, headsBefore) : new Map<string, string>()
  let applied = 0
  let unmatched = 0
  const deletes: Array<{ op: DuplicateCompensationOp; index: number }> = []
  for (const op of ops) {
    if (op.kind === 'counter') {
      const parent = nodeAt(draft, op.path) as Record<string | number, unknown> | undefined
      let counter: unknown
      if (op.key !== undefined) counter = parent?.[op.key]
      else {
        // A counter INSIDE A LIST: found by its element id where it now is.
        const index = elementIndex(doc, { kind: 'list-del', path: op.path, elemId: op.elemId }, putToElem)
        counter = index >= 0 ? parent?.[index] : undefined
      }
      if (counter instanceof A.Counter) { counter.increment(op.by!); applied += 1 } else unmatched += 1
      continue
    }
    const index = elementIndex(doc, op, putToElem)
    if (index < 0) { unmatched += 1; continue }
    deletes.push({ op, index })
  }
  const be = A.getBackend(doc)
  deletes.sort((a, b) => b.index - a.index)
  for (const { op, index } of deletes) {
    if (op.kind === 'text-del') {
      const obj = objectIdAt(doc, undefined, op.path)!
      const text = be.text(obj)
      const cp = text.codePointAt(index)
      A.splice(draft as A.Doc<unknown>, op.path as A.Prop[], index, cp !== undefined && cp > 0xffff ? 2 : 1)
    } else {
      const list = nodeAt(draft, op.path) as unknown[]
      A.deleteAt(list, index)
    }
    applied += 1
  }
  return { applied, unmatched }
}
