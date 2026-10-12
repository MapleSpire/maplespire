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
 * THE WIRING, ASSERTED ON THE SOURCE — because `index.ts` cannot be loaded.
 *
 * `mergePlacement.test.ts` covers the DECISIONS. It cannot cover whether
 * `index.ts` still asks for them: that file exports nothing, starts a server on
 * import, and no test loads it. Deleting the `WriteAuthorityUnavailableError`
 * branch from the merge handler's catch, or inverting the reference-integrity
 * apply predicate, would otherwise go unnoticed.
 *
 * So this file reads the source, as `mutatingRouteCoverage.test.ts` and
 * `db/poolErrorGuard.test.ts` do. A source assertion is weak — it cannot tell
 * you the call does the right thing — but it makes DELETION loud. Every arm carries its own vacuity
 * control, because a slice that silently became empty would satisfy all of them
 * at once.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const INDEX = path.resolve(import.meta.dirname, '..', 'index.ts')

/** The body of one `app.<verb>('<path>' …)` registration, up to the next one. */
async function routeBody(marker: string): Promise<string> {
  const source = await readFile(INDEX, 'utf8')
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`route registration not found in index.ts: ${marker}`)
  const rest = source.slice(start + marker.length)
  const end = rest.search(/\n\s*app\.(get|post|put|patch|delete|use)\(/)
  return rest.slice(0, end < 0 ? undefined : end)
}

const MERGE = "app.post('/api/landscapes/:landscapeId/drafts/:draftId/merge'"
const REFERENCE_REPAIR = "app.post('/api/platform/reference-integrity/repair'"

describe('B2-5 — the draft-merge handler still asks for its placement', () => {
  it('the slice is a real one', async () => {
    // THE VACUITY CONTROL, first. If `routeBody` returned an empty string —
    // a renamed route, a changed quote style — every `toContain` below would
    // fail rather than pass, but a `not.toContain` would pass silently, and the
    // next person to add one would get a gate that reports success having done
    // nothing.
    const body = await routeBody(MERGE)
    expect(body.length).toBeGreaterThan(500)
    expect(body, 'the slice ran past the end of the handler').toContain('applyMerge(')
  })

  it('takes the write authority BEFORE the merge, not after it', async () => {
    // The ordering IS the property. `placeMergeWrite` refuses before the root
    // loop runs, so a refusal at that point is genuinely atomic; moved below
    // `applyMerge` it would refuse a write that had already happened.
    const body = await routeBody(MERGE)
    const placement = body.indexOf('placeMergeWrite(')
    const merge = body.indexOf('applyMerge(')
    expect(placement, 'the merge handler no longer places its write — see mergePlacement.ts').toBeGreaterThan(-1)
    expect(placement).toBeLessThan(merge)
  })

  it('answers the refusal instead of dropping it', async () => {
    const body = await routeBody(MERGE)
    expect(body).toContain('if (refusal)')
    expect(body).toContain('refusal.retryAfterSeconds')
    expect(body).toContain('refusal.status')
  })

  it('maps WriteAuthorityUnavailableError in its catch, through the shared mapper', async () => {
    // Without this branch the throw falls to the generic 500 path, but
    // `owns() = false` must yield 503 + `retryable`. The mapper is shared with
    // the module that throws so the two cannot drift.
    //
    // The condition is asserted WHOLE, not as a substring: prefixing it with
    // `false && ` would leave `err instanceof WriteAuthorityUnavailableError`
    // intact while disarming the branch.
    const body = await routeBody(MERGE)
    expect(body).toContain('if (err instanceof WriteAuthorityUnavailableError) {')
    expect(body).toContain('writeAuthorityRefusal(err)')
  })

  it('is not green-washed — no branch in this handler is disarmed in place', async () => {
    // The general form of the mutant above, because pinning one condition's
    // exact spelling only protects that condition. `scripts/sync-gate-wiring.test.mjs`
    // refuses the same family of spellings in the workflows; this is that rule
    // pointed at the one handler whose refusals nothing else can reach.
    const body = await routeBody(MERGE)
    for (const spelling of ['if (false', '&& false', '|| true', 'if (0 ', 'return // ']) {
      expect(body, `a branch is disarmed in place: ${spelling}`).not.toContain(spelling)
    }
    // The control: the guard can fire. Without it, a `routeBody` that returned
    // an empty slice would satisfy every `not.toContain` above.
    expect(`${body} if (false`).toContain('if (false')
  })

  it('reports a cross-partition rotation rather than swallowing it', async () => {
    const body = await routeBody(MERGE)
    expect(body).toContain('onUnownedRotation')
    expect(body).toContain('sync.cell.merge_root_rotated_unowned')
  })
})

describe('B2-5 — the reference repair decides "apply" with the router’s predicate', () => {
  it('uses referenceIntegrityApplies, and not a second spelling of it', async () => {
    // `createWorkspaceHttpRouting` places this route only when it APPLIES. A
    // handler that decided differently would either route a report — which
    // `index.ts` itself says must stay ungated — or run an apply locally,
    // unrouted. `const apply = !referenceIntegrityApplies(req.body)` would pass
    // eslint and every other test, so the predicate needs pinning by shape,
    // not merely by name.
    const body = await routeBody(REFERENCE_REPAIR)
    expect(body.length, 'the slice is empty — the route was renamed').toBeGreaterThan(200)
    expect(body).toContain('const apply = referenceIntegrityApplies(req.body)')
    expect(body, 'the predicate is inverted; every report would apply locally').not.toContain('!referenceIntegrityApplies')
  })
})
