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
 * The draft merge's pre-write placement (`mergePlacement.ts`): the refusal
 * standing between a draft merge and a split-brain write. Each arm below names
 * the one-word mutation it catches — deleting the authority check, opting out
 * with `required: false`, inverting the rotation witness, disarming the
 * cross-partition warning.
 */
import { describe, expect, it } from 'vitest'
import type { WorkspaceKey } from '../rbac/docScope.js'
import { placeMergeWrite, writeAuthorityRefusal, type MergeHalf } from './mergePlacement.js'
import { WriteAuthorityUnavailableError, type WriteAuthorityOwnership } from './writeAuthority.js'

const LANDSCAPE = 'L-1'
const DRAFT = 'D-9'
const PARENT = 'V-parent'

/** An ownership coordinator whose answers the arm controls, including moving
 *  underneath the caller — which is the only way to reach `stillHeld()`. */
function ownership(overrides: Partial<WriteAuthorityOwnership> = {}): WriteAuthorityOwnership {
  return {
    enabled: true,
    owns: () => true,
    fencingToken: () => 'token-1',
    ...overrides,
  }
}

interface Harness {
  rotate: Set<string>
  rotated: string[]
  resolved: string[]
  unowned: Array<{ half: MergeHalf; key: WorkspaceKey }>
  options: Parameters<typeof placeMergeWrite>[0]
}

function harness(overrides: Partial<Parameters<typeof placeMergeWrite>[0]> = {}): Harness {
  const rotate = new Set<string>()
  const rotated: string[] = []
  const resolved: string[] = []
  const unowned: Array<{ half: MergeHalf; key: WorkspaceKey }> = []
  const options: Parameters<typeof placeMergeWrite>[0] = {
    ownership: ownership(),
    landscapeId: LANDSCAPE,
    draftId: DRAFT,
    parentVersionId: PARENT,
    resolveRootUrl: async (key) => {
      resolved.push(key.versionId)
      return `automerge:root-${key.versionId}`
    },
    ensureCanonicalRoot: async (key, _url, observe) => {
      if (rotate.has(key.versionId)) {
        rotated.push(key.versionId)
        observe.onRotated()
      }
      return 'automerge:whatever'
    },
    onUnownedRotation: (event) => unowned.push(event),
    ...overrides,
  }
  return { rotate, rotated, resolved, unowned, options }
}

describe('placeMergeWrite — the authority', () => {
  it('lets a merge through when this cell owns the parent', async () => {
    // The baseline. Without it every refusal arm below is equally satisfied by
    // a function that refuses everything.
    const h = harness()
    await expect(placeMergeWrite(h.options)).resolves.toBeNull()
    expect(h.resolved, 'both halves are offered a root repair, draft first').toEqual([DRAFT, PARENT])
  })

  it('KILLS "delete the authority check": a lost lease refuses with 503', async () => {
    // Ownership moves between the grant and the re-ask, which is what every
    // await in the handler makes possible.
    let owns = true
    const h = harness({ ownership: ownership({ owns: () => owns }) })
    const pending = placeMergeWrite({
      ...h.options,
      resolveRootUrl: async (key) => { owns = false; return `automerge:root-${key.versionId}` },
    })
    await expect(pending).resolves.toMatchObject({
      status: 503,
      retryAfterSeconds: '1',
      body: { retryable: true, wrote: 'nothing' },
    })
  })

  it('KILLS "the token moved but owns() still says yes"', async () => {
    // Both halves of `stillHeld` are load-bearing: this cell can re-acquire at
    // a HIGHER token, which fences the statement the caller was about to run
    // under the old one, while `owns` never stops answering true.
    let token = 'token-1'
    const h = harness({ ownership: ownership({ fencingToken: () => token }) })
    await expect(placeMergeWrite({
      ...h.options,
      resolveRootUrl: async (key) => { token = 'token-2'; return `automerge:root-${key.versionId}` },
    })).resolves.toMatchObject({ status: 503 })
  })

  it('KILLS "required: false": the boot window is a refusal, not a grant', async () => {
    // `requireWriteAuthority`'s `required` defaults to TRUE, and passing
    // `{ required: false }` would turn "this process cannot yet say whether it
    // owns the workspace" into a merge. The throw is the caller's to map.
    const h = harness({ ownership: null })
    await expect(placeMergeWrite(h.options)).rejects.toBeInstanceOf(WriteAuthorityUnavailableError)
    expect(h.resolved, 'the root loop ran before the authority was even asked').toEqual([])
  })

  it('asks nothing of the authority when the draft names no parent', async () => {
    // Nothing is placeable, so manufacturing a key with an empty versionId to
    // have something to ask about would hash into a real partition.
    const h = harness({ parentVersionId: null, ownership: ownership({ owns: () => false }) })
    await expect(placeMergeWrite(h.options)).resolves.toBeNull()
    expect(h.resolved).toEqual([DRAFT])
  })

  it('grants on a cell with ownership disabled — the single-cell deployment', async () => {
    const h = harness({ ownership: ownership({ enabled: false, owns: () => false, fencingToken: () => null }) })
    await expect(placeMergeWrite(h.options)).resolves.toBeNull()
  })
})

describe('placeMergeWrite — the rotation witness', () => {
  it('KILLS "invert the witness": a refusal after a rotation does NOT say nothing was written', async () => {
    // By the time
    // `stillHeld()` runs, the loop may already have published a fresh root and
    // swapped `versions.root_url`; a 503 asserting "nothing" would be false
    // exactly when it mattered.
    let owns = true
    const h = harness({ ownership: ownership({ owns: () => owns }) })
    h.rotate.add(PARENT)
    const refusal = await placeMergeWrite({
      ...h.options,
      ensureCanonicalRoot: async (key, _url, observe) => {
        if (h.rotate.has(key.versionId)) observe.onRotated()
        owns = false
        return 'automerge:whatever'
      },
    })
    expect(refusal?.body.wrote).toBe('a parent workspace root was rotated before this refusal')
  })

  it('KILLS "assign instead of OR": a DRAFT rotation survives a clean parent iteration', async () => {
    // The draft is rotated FIRST. A witness written with `=` on every callback
    // would be fine here, but a witness that only recorded the LAST iteration —
    // or one reset per half — would report `nothing` for a merge that had
    // already rotated the draft's root durably. That is the exact false claim
    // this field exists to prevent.
    let owns = true
    const h = harness({ ownership: ownership({ owns: () => owns }) })
    const refusal = await placeMergeWrite({
      ...h.options,
      ensureCanonicalRoot: async (key, _url, observe) => {
        if (key.versionId === DRAFT) observe.onRotated()
        if (key.versionId === PARENT) owns = false
        return 'automerge:whatever'
      },
    })
    expect(refusal?.body.wrote).toBe('a draft workspace root was rotated before this refusal')
  })

  it('names the FIRST half when both rotated, so `??=` cannot become `=`', async () => {
    // Catches `rotated = half` instead of `rotated ??= half`. It differs from the correct code only when BOTH
    // halves rotate, and the arm above rotates only the draft. Reporting the
    // draft is the honest answer — it is the first durable write of the
    // request, and the one a reader needs to know happened.
    let owns = true
    const h = harness({ ownership: ownership({ owns: () => owns }) })
    const refusal = await placeMergeWrite({
      ...h.options,
      ensureCanonicalRoot: async (key, _url, observe) => {
        observe.onRotated()
        if (key.versionId === PARENT) owns = false
        return 'automerge:whatever'
      },
    })
    expect(refusal?.body.wrote).toBe('a draft workspace root was rotated before this refusal')
  })

  it('says NOTHING when nothing rotated — the control that keeps the field honest', async () => {
    let owns = true
    const h = harness({ ownership: ownership({ owns: () => owns }) })
    const refusal = await placeMergeWrite({
      ...h.options,
      resolveRootUrl: async () => { owns = false; return 'automerge:root' },
    })
    expect(refusal?.body.wrote).toBe('nothing')
  })

  it('touches no root at all when the workspace has none', async () => {
    const h = harness({ resolveRootUrl: async () => null })
    await expect(placeMergeWrite(h.options)).resolves.toBeNull()
    expect(h.rotated).toEqual([])
  })

  it('a failed root read ends the placement: it is thrown, never read as "no root"', async () => {
    // `resolveRootUrl` throws for an explicit key on a failed read. Read as
    // "no root", the parent would skip its repair and the merge would go on;
    // thrown, it ends in the handler's catch before `applyMerge`.
    const failure = new Error('connection terminated')
    const h = harness()
    const repaired: string[] = []
    await expect(placeMergeWrite({
      ...h.options,
      resolveRootUrl: async (key) => {
        if (key.versionId === PARENT) throw failure
        return `automerge:root-${key.versionId}`
      },
      ensureCanonicalRoot: async (key) => { repaired.push(key.versionId); return 'automerge:whatever' },
    })).rejects.toBe(failure)
    expect(repaired, 'only the draft half had been reached').toEqual([DRAFT])
  })
})

describe('placeMergeWrite — the cross-partition witness', () => {
  it('KILLS "disarm the warning": a rotation on an UNOWNED half is reported', async () => {
    // There is no mid-flight two-owner detector, so without this a deployment
    // with `SYNC_CELL_MULTI_PARTITION=on` could get a cross-partition rotation
    // with nothing saying so.
    const h = harness({ ownership: ownership({ owns: (key) => key.versionId === PARENT }) })
    h.rotate.add(DRAFT)
    h.rotate.add(PARENT)
    await expect(placeMergeWrite(h.options)).resolves.toBeNull()
    expect(h.unowned).toEqual([{ half: 'draft', key: { landscapeId: LANDSCAPE, versionId: DRAFT } }])
  })

  it('fires on the WRITE, never on the opportunity', async () => {
    // The guard returns early for a healthy root, which is almost every merge.
    // A witness fired on placement would say the same thing whether or not
    // anything happened — a witness that cannot see its subject.
    // Owns the parent (so step 1 grants) and NOT the draft — the shape that
    // would fire the witness if it fired on placement. Nothing rotates.
    const h = harness({ ownership: ownership({ owns: (key) => key.versionId === PARENT }) })
    await expect(placeMergeWrite(h.options)).resolves.toBeNull()
    expect(h.rotated, 'the harness rotated something after all').toEqual([])
    expect(h.unowned, 'reported a rotation that never happened').toEqual([])
  })

  it('stays silent on a cell with ownership disabled', async () => {
    const h = harness({ ownership: ownership({ enabled: false, owns: () => false, fencingToken: () => null }) })
    h.rotate.add(DRAFT)
    await expect(placeMergeWrite(h.options)).resolves.toBeNull()
    expect(h.unowned).toEqual([])
  })
})

describe('writeAuthorityRefusal', () => {
  it('answers 503 + retryable for BOTH reasons, including the terminal one', async () => {
    // `not-owner` is terminal for THIS PROCESS and its `retryable` says so.
    // The HTTP answer is about the CLIENT, whose retry goes through the load
    // balancer and reaches the new owner. `owns() = false` must yield 503 +
    // retryable; answering a write with a route in the response body (e.g. a
    // 409-with-a-route) is ruled out by design.
    const key = { landscapeId: LANDSCAPE, versionId: PARENT }
    const notOwner = writeAuthorityRefusal(new WriteAuthorityUnavailableError('not-owner', key))
    expect(notOwner.status).toBe(503)
    expect(notOwner.body).toMatchObject({ reason: 'not-owner', retryable: true, wrote: 'nothing' })
    expect(notOwner.retryAfterSeconds).toBe('1')

    const warming = writeAuthorityRefusal(new WriteAuthorityUnavailableError('warming-up', key))
    expect(warming.status).toBe(503)
    expect(warming.body).toMatchObject({ reason: 'warming-up', retryable: true, wrote: 'nothing' })
    // Longer, because it is a boot window rather than a placement decision.
    expect(warming.retryAfterSeconds).toBe('2')
  })
})
