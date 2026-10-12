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

import { describe, it, expect } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import {
  collectContentWitness,
  compareContentWitness,
  stableHash,
  type ContentWitness,
} from './compactionWitness.js'
import { compactOverlay } from './compaction.js'

/**
 * The VALUE half of the compaction witness.
 *
 * A witness is only worth taking if it can FAIL. The arms below are paired: each
 * "a correct fold passes" is matched by an injected fault that must be caught,
 * because a witness that reports clean on a genuine loss is worse than none —
 * it converts an unverified run into a verified-looking one.
 *
 * The end-to-end arm drives the REAL `compactOverlay` and asserts the witness
 * agrees before and after. That is the arm that would notice the witness and the
 * fold disagreeing about overlay precedence — which is exactly what a witness
 * built on `foldCollection` could never notice, since it would inherit the same
 * mistake.
 */

type Obj = { id: string; name: string }

/** Build a model and return a resolver over a plain map, so the witness can be
 *  driven without a Repo where the test is about the walk itself. */
function docs(entries: Record<string, unknown>) {
  return async (url: string) => {
    if (!(url in entries)) throw new Error(`no such doc: ${url}`)
    return entries[url]
  }
}

const ROOT = { modelMetaUrl: 'meta' }

describe('compaction witness — the value half (T-28e)', () => {
  it('resolves overlay-LAST-wins, the way a reader does', async () => {
    // The overlay segment is kept last in `objectShardUrls`, so it shadows the
    // base. A witness that walked in the other order would report the pre-edit
    // value and call a CORRECT fold a regression.
    const witness = await collectContentWitness(ROOT, docs({
      meta: { objectShardUrls: ['base', 'overlay'], connectionShardUrls: [] },
      base: { objects: { o0: { id: 'o0', name: 'A' }, o1: { id: 'o1', name: 'B' } } },
      overlay: { objects: { o0: { id: 'o0', name: 'A-edited' } } },
    }))
    expect([...witness.objects.keys()].sort()).toEqual(['o0', 'o1'])
    expect(witness.objects.get('o0')).toBe(stableHash({ id: 'o0', name: 'A-edited' }))
    expect(witness.objects.get('o1')).toBe(stableHash({ id: 'o1', name: 'B' }))
  })

  it('applies tombstones AFTER the shards', async () => {
    const witness = await collectContentWitness(ROOT, docs({
      meta: {
        objectShardUrls: ['base'], connectionShardUrls: [],
        deletedObjectIds: ['o1', 'never-existed'],
      },
      base: { objects: { o0: { id: 'o0' }, o1: { id: 'o1' } } },
    }))
    // A tombstone for an id no shard carries is a visible no-op, not something
    // that silently shapes the result.
    expect([...witness.objects.keys()]).toEqual(['o0'])
  })

  it('hashes by VALUE, not by key order', async () => {
    // Automerge maps have no meaningful key order, so a fold can reorder keys
    // without changing anything a reader sees. A witness that hashed
    // `JSON.stringify` would report a regression on every run — and a witness
    // that cries wolf gets deleted, which loses the real assertion.
    expect(stableHash({ a: 1, b: { c: 2, d: 3 } })).toBe(stableHash({ b: { d: 3, c: 2 }, a: 1 }))
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }))
  })

  it('CATCHES a lost edit — the failure the id-only inventory cannot see', async () => {
    // `collectCrdtInventory` returns ids, so a fold that wrote a STALE value
    // over a newer one leaves every id present and reports clean. This is the
    // whole reason the value half exists.
    const before = await collectContentWitness(ROOT, docs({
      meta: { objectShardUrls: ['base', 'overlay'], connectionShardUrls: [] },
      base: { objects: { o0: { id: 'o0', name: 'A' } } },
      overlay: { objects: { o0: { id: 'o0', name: 'A-edited' } } },
    }))
    const after = await collectContentWitness(ROOT, docs({
      meta: { objectShardUrls: ['base'], connectionShardUrls: [] },
      base: { objects: { o0: { id: 'o0', name: 'A' } } }, // the edit was lost
    }))
    const verdict = compareContentWitness(before, after)
    expect(verdict.pass).toBe(false)
    expect(verdict.regressed).toEqual(['objects:o0'])
    expect(verdict.vanished).toEqual([])
  })

  it('CATCHES a vanished entity, and an invented one', async () => {
    const before = await collectContentWitness(ROOT, docs({
      meta: { objectShardUrls: ['base'], connectionShardUrls: [] },
      base: { objects: { o0: { id: 'o0' }, o1: { id: 'o1' } } },
    }))
    const after = await collectContentWitness(ROOT, docs({
      meta: { objectShardUrls: ['base'], connectionShardUrls: [] },
      base: { objects: { o0: { id: 'o0' }, o2: { id: 'o2' } } },
    }))
    const verdict = compareContentWitness(before, after)
    expect(verdict.pass).toBe(false)
    expect(verdict.vanished).toEqual(['objects:o1'])
    // A fold invents nothing, so an appearance is a finding, not a curiosity.
    expect(verdict.appeared).toEqual(['objects:o2'])
  })

  it('tolerates a changed value ONLY when the run reported it as kept', async () => {
    // A `kept` entry was edited concurrently during the run, so its value is
    // allowed to differ. The permission comes from the RUN'S OWN REPORT, never
    // from the data — otherwise "it changed" would excuse itself.
    const before = await collectContentWitness(ROOT, docs({
      meta: { objectShardUrls: ['base'], connectionShardUrls: [] },
      base: { objects: { o0: { id: 'o0', name: 'A' } } },
    }))
    const after = await collectContentWitness(ROOT, docs({
      meta: { objectShardUrls: ['base'], connectionShardUrls: [] },
      base: { objects: { o0: { id: 'o0', name: 'A-changed-during-the-run' } } },
    }))
    expect(compareContentWitness(before, after, ['o0'])).toMatchObject({
      pass: true, regressed: [], changedButKept: ['objects:o0'],
    })
    // ...and the SAME data without that permission is a regression. Without this
    // pairing, `kept` could be excusing everything.
    expect(compareContentWitness(before, after, [])).toMatchObject({
      pass: false, regressed: ['objects:o0'],
    })
  })

  it('REFUSES a root with no ModelMeta rather than returning an empty witness', async () => {
    // An empty witness compares equal to another empty one, so any comparison
    // would trivially pass — a gate reporting success having looked at nothing.
    await expect(collectContentWitness({ modelUrl: 'legacy' }, docs({ legacy: {} })))
      .rejects.toThrow(/no modelMetaUrl/)
    await expect(collectContentWitness(null, docs({}))).rejects.toThrow(/did not resolve/)
  })

  it('END TO END — agrees with a real compactOverlay across the fold', async () => {
    // The arm that matters: the witness is an independent implementation of
    // overlay-last-wins, and this is where it and `foldCollection` would be
    // caught disagreeing. A witness built on `foldCollection` inherits its
    // mistakes and can never fail this way.
    const repo = new Repo({})
    const base = repo.create({ objects: { o0: { id: 'o0', name: 'A' }, o1: { id: 'o1', name: 'B' } } })
    const overlay = repo.create({ objects: { o0: { id: 'o0', name: 'A-edited' } } })
    const meta = repo.create({
      objectShardUrls: [base.url, overlay.url],
      connectionShardUrls: [] as string[],
      editsObjectShardUrl: overlay.url,
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
    await Promise.all([base, overlay, meta, root].map((h) => h.whenReady()))

    const resolve = async (url: string) => (await repo.find<Record<string, unknown>>(url)).doc()
    const before = await collectContentWitness(root.doc(), resolve)

    const result = await compactOverlay(repo, root.url, { mode: 'apply' })
    // VOID, not PASS, if nothing was folded: a witness over a no-op proves
    // nothing about a fold. The same rule applies to a live run.
    expect(result.objectsFolded, 'nothing was folded — this arm proves nothing').toBeGreaterThan(0)

    const after = await collectContentWitness(root.doc(), resolve)
    expect(compareContentWitness(before, after, [])).toMatchObject({
      pass: true, vanished: [], appeared: [], regressed: [],
    })
    // And the fold really did move the value into the base, so "agrees" is not
    // "nothing happened".
    expect(before.objects.get('o0')).toBe(stableHash({ id: 'o0', name: 'A-edited' }))
    expect(after.objects.get('o0')).toBe(before.objects.get('o0'))
  })

  it('END TO END — the same comparison FAILS when an edit is dropped after the fold', async () => {
    // The control for the arm above: it must be able to go red on this fixture,
    // or "agrees with compactOverlay" is a statement about the fixture rather
    // than about the fold.
    const repo = new Repo({})
    const base = repo.create({ objects: { o0: { id: 'o0', name: 'A' } } })
    const overlay = repo.create({ objects: { o0: { id: 'o0', name: 'A-edited' } } })
    const meta = repo.create({
      objectShardUrls: [base.url, overlay.url],
      connectionShardUrls: [] as string[],
      editsObjectShardUrl: overlay.url,
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] as string[] })
    await Promise.all([base, overlay, meta, root].map((h) => h.whenReady()))
    const resolve = async (url: string) => (await repo.find<Record<string, unknown>>(url)).doc()

    const before = await collectContentWitness(root.doc(), resolve)
    await compactOverlay(repo, root.url, { mode: 'apply' })
    // Inject the loss the witness exists to catch: revert the base to the
    // pre-edit value, as a fold of a stale snapshot would have left it.
    base.change((s) => { (s.objects as Record<string, Obj>).o0 = { id: 'o0', name: 'A' } })

    const after = await collectContentWitness(root.doc(), resolve)
    const verdict: ReturnType<typeof compareContentWitness> = compareContentWitness(before, after, [])
    expect(verdict.pass, 'the witness reported clean over a lost edit').toBe(false)
    expect(verdict.regressed).toContain('objects:o0')
  })
})

// Exported type is referenced so a rename cannot leave this file compiling
// against a stale name while asserting nothing about it.
export type { ContentWitness }
