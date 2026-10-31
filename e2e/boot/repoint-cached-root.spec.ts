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
 * A `current` TAB THAT BOOTS FROM ITS CACHED ROOT AFTER THE DEFAULT MOVED.
 *
 * The defect, reproduced live on 2026-10-28 (isolated stack, seed `real`):
 * boot a tab on `…/version/current` (V1), fork V2 and rename an object in V2
 * only, repoint the landscape's default to V2 while the tab is away, then load
 * the tab with the server down — it boots V1's cached root — and bring the
 * server back.
 *
 *  - The first socket binding (V2) was ADOPTED as the comparison basis
 *    (`bridge.ts`'s self-arm), so the repoint detector never fired: no hold,
 *    no follow.
 *  - Every `/api/model/*` read asked `versionId=current`, which the server
 *    answers about V2: the canvas drew V2's renamed object over V1's documents,
 *    the sidebar and the Model Objects page listed it, and durable-heads said
 *    `durable: false` for ever about documents that were durable in V1.
 *  - Edits made in that state were refused `workspace-mismatch` (routing
 *    enforced) — an offline edit never reached the server and the next reload
 *    followed the alias away from it — or, AUTH off, written to V1 behind a
 *    badge stuck on "Enregistrement…".
 *
 * The fix persists the version the root fetch reported beside the cached root
 * (`repo.ts`), restores it as a `root-cache` basis for that root, and makes
 * the reads name the documents' workspace (`workspaceSearchParams`).
 *
 * ## The discriminants
 *
 * Test 1 (offline work), phase 1 — HTTP back, sync socket still refused, so no
 * binding and no hold: every `/api/model/*` read and durable-heads request must
 * name V1, and the Model Objects page must find the object by V1's name. Before
 * the fix they all asked `current` (= V2). This phase is what pins the reads'
 * rule: under a hold the reads reach V1 through the hold whatever that rule is.
 * Phase 2 — the socket back: `held` must become V1 (before the fix the basis was
 * self-armed and nothing was ever held, in either auth mode), the offline edit
 * durable in V1 and not in V2, the canvas showing V1's name, every render V1.
 *
 * Test 2 (no offline work): the detector must react — FOLLOW, or a HOLD when
 * the reconnect lands while a write is still scheduled, which the test then
 * follows through the banner — and the session must end on a `root-fetch` V2
 * basis with the canvas showing V2's name. Before the fix the basis stayed the
 * self-armed V2 binding (`socket-binding`) for the whole session, nothing held:
 * the version is the same, so the provenance is what tells the two apart.
 *
 * Not covered here: a cached-root boot taken while the server is UP (the boot
 * fallback). Its binding frame arrives during boot, before the bridge installs
 * the detector; it is kept and replayed, and the fallback session holds —
 * `repoint-boot-fallback.spec.ts`.
 *
 * ## How "the server is down" is made
 *
 * `goOffline` blocks the PAGE's own requests and sync socket; the server keeps
 * running, and the operator's fork, rename and repoint go through
 * `page.request` and a second browser context, which the page's routes do not
 * intercept — an admin acting while this user is disconnected.
 *
 * Both tests leave the landscape's default on a fork of what it replaced (a
 * superset), as `repoint-live-tab.spec.ts` and `repoint-offline-create.spec.ts`
 * do, so versions accumulate on a long-lived stack.
 *
 * Runs under the `boot` project against a dev:boot-shaped stack (AUTH off; the
 * operator context does not sign in):
 *
 *   E2E_BOOT_URL=http://localhost:5343 E2E_BOOT_API=http://localhost:3113 \
 *     npx playwright test --project=boot e2e/boot/repoint-cached-root.spec.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { test, expect, type Page } from '@playwright/test'
import {
  editObjectNameDesc,
  flushLocal,
  goOffline,
  goOnline,
  gotoModelObjects,
  selectShapeById,
  waitForDiagramRenderCached,
} from './helpers.js'
import {
  API_BASE,
  bindingProbe,
  canvasName,
  defaultVersionId,
  enterOnAlias,
  fork,
  nameInWorkspace,
  recordRenderVersions,
  recordWorkspaceReads,
  renameInVersion,
  setDefaultVersion,
  syncBadge,
  twoCanvasObjects,
} from './repointHelpers.js'

/** Reload the tab with the server unreachable, on the same diagram. */
async function bootFromCachedRoot(page: Page, tabUrl: string, objectIds: string[]): Promise<void> {
  await goOffline(page)
  await page.goto(tabUrl)
  await expect
    .poll(
      async () => page.evaluate((ids) => ids.every((id) => !!(window as any).__canvasEngine?.objectMap?.get(id)), objectIds),
      { timeout: 45_000 },
    )
    .toBe(true)
}

test.describe.configure({ mode: 'serial' })

test.describe('a `current` tab booted from its cached root after the default moved', () => {
  // Two boots, an operator session on a freshly forked version (its read model
  // cold-builds on first demand) and a reconnect: well past the project's 120 s.
  test.beforeEach(() => test.setTimeout(360_000))

  test('holding offline work, it is held on its own version, saves the work there and shows that version', async ({ page, browser }) => {
    const { landscapeId, diagramId, tabUrl } = await enterOnAlias(page)
    const v1 = await defaultVersionId(page, landscapeId)
    // The basis comes from the root fetch, beside the root this boot caches.
    await expect.poll(async () => (await bindingProbe(page, landscapeId)).basis?.versionId ?? null, { timeout: 60_000 })
      .toBe(v1)
    await waitForDiagramRenderCached(page)
    const [renamed, edited] = await twoCanvasObjects(page)
    const stamp = Date.now().toString(36)
    const v2Name = `v2only-${stamp}`
    const offlineName = `offline-${stamp}`

    // The operator: fork V2 (before this tab writes anything) and rename one
    // object there, through the real editor.
    const v2 = await fork(page, landscapeId, v1, 'e2e-cached-root')
    await renameInVersion(browser, page, { landscapeId, versionId: v2 }, diagramId, renamed.id, v2Name)

    // The tab goes away; the default moves while it is gone.
    await bootFromCachedRoot(page, tabUrl, [renamed.id, edited.id])
    await setDefaultVersion(page, landscapeId, v2)
    await page.evaluate(() => { (window as any).__cachedRootSentinel = 'alive' })

    // Offline work: something this tab must not lose.
    await selectShapeById(page, edited.id)
    await editObjectNameDesc(page, offlineName, 'edited offline in the V1 tab')
    await flushLocal(page)

    // PHASE 1 — the server answers HTTP again, the sync socket is still refused.
    // No binding frame means no hold, so nothing but the reads' own rule decides
    // which version they name. (Under the hold of phase 2 they reach V1 through
    // the hold whatever that rule says — reviewer lens, 2026-10-28.)
    const reads = recordWorkspaceReads(page)
    await page.unroute(`${API_BASE.replace(/\/$/, '')}/**`)

    // The Model Objects page reads the whole model from the server. Searching
    // V1's name finds the object only if the page asked V1: V2's read model
    // knows it by `v2Name` (measured before the fix, routing enforced: the page
    // listed the repointed version's names). A presence, not an absence — an
    // absence also passes while the table is still loading.
    await gotoModelObjects(page)
    await page.getByTestId('mo-search').fill(renamed.name)
    await expect(page.getByTestId(`mo-row-${renamed.id}`)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId(`mo-row-${renamed.id}`)).not.toContainText(v2Name)
    // The offline edit is pending, so the durable-heads acknowledgement keeps
    // asking; before the fix it asked `current` and was told "not durable" about
    // a workspace that does not hold these documents, for ever.
    await expect.poll(() => reads.filter((read) => read.path.endsWith('/durable-heads')).length, { timeout: 60_000 })
      .toBeGreaterThan(0)
    expect((await bindingProbe(page, landscapeId)).held, 'phase 1 must run with no hold').toBeNull()
    expect(reads.filter((read) => read.versionId !== v1), `reads with the socket down: ${JSON.stringify(reads)}`)
      .toEqual([])

    // Back to the canvas, still with no socket.
    await page.goBack()
    await expect
      .poll(async () => page.evaluate((id) => !!(window as any).__canvasEngine?.objectMap?.get(id), renamed.id), { timeout: 45_000 })
      .toBe(true)

    // PHASE 2 — the socket comes back, bound to `current` = V2.
    const renders = recordRenderVersions(page)
    await goOnline(page)

    // HELD on the version it was editing, and told so.
    await expect.poll(async () => (await bindingProbe(page, landscapeId)).held?.versionId ?? null, { timeout: 90_000 })
      .toBe(v1)
    await expect(page.getByTestId('workspace-repoint-banner')).toBeVisible({ timeout: 30_000 })
    expect(page.url()).toContain('/version/current')

    // The work is durable where the tab is, and nowhere else.
    await expect.poll(() => nameInWorkspace(page, edited.id, { landscapeId, versionId: v1 }), { timeout: 90_000 })
      .toBe(offlineName)
    await expect.poll(() => nameInWorkspace(page, edited.id, { landscapeId, versionId: v2 }), { timeout: 60_000 })
      .toBe(edited.name)
    await expect(syncBadge(page)).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })

    // At least one render was fetched since the reconnect (so the canvas
    // assertion is not about a stale offline copy), and every one named V1.
    await expect.poll(() => renders.length, { timeout: 60_000 }).toBeGreaterThan(0)
    expect(renders.filter((version) => version !== v1), `renders since the reconnect: ${renders.join(', ')}`)
      .toEqual([])
    await expect.poll(() => canvasName(page, renamed.id), { timeout: 30_000 }).toBe(renamed.name)
    expect(await canvasName(page, edited.id)).toBe(offlineName)

    expect(await page.evaluate(() => (window as any).__cachedRootSentinel ?? null),
      'the hold must happen IN PLACE — a reload re-fetches the root and proves nothing').toBe('alive')
  })

  test('with no offline work, it ends on the new default in place — documents and reads together', async ({ page, browser }) => {
    const { landscapeId, diagramId, tabUrl } = await enterOnAlias(page)
    const v1 = await defaultVersionId(page, landscapeId)
    await expect.poll(async () => (await bindingProbe(page, landscapeId)).basis?.versionId ?? null, { timeout: 60_000 })
      .toBe(v1)
    await expect(syncBadge(page)).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
    await waitForDiagramRenderCached(page)
    const [renamed, other] = await twoCanvasObjects(page)
    const v2Name = `v2only-${Date.now().toString(36)}`

    const v2 = await fork(page, landscapeId, v1, 'e2e-cached-root')
    await renameInVersion(browser, page, { landscapeId, versionId: v2 }, diagramId, renamed.id, v2Name)

    await bootFromCachedRoot(page, tabUrl, [renamed.id, other.id])
    await setDefaultVersion(page, landscapeId, v2)
    // The cached boot knows which version its root is.
    const offline = await bindingProbe(page, landscapeId)
    expect(offline.basis?.versionId ?? null, 'the cached root must come back with the version it was fetched for')
      .toBe(v1)
    await page.evaluate(() => { (window as any).__cachedRootSentinel = 'alive' })

    await goOnline(page)

    // The detector reacts: it FOLLOWS, or it HOLDS when the reconnect lands
    // while a write is still scheduled — `pendingDurabilityDebts` counts a
    // pending write scheduler as unsaved work, measured 2026-10-28 (`unsaved: 1`,
    // `writeScheduler.pending`, no user edit). Before the fix it did NEITHER: the
    // basis stayed the self-armed V2 binding for the whole session (same version
    // as below, different provenance), with nothing held.
    let outcome = ''
    await expect
      .poll(async () => {
        const probe = await bindingProbe(page, landscapeId)
        outcome = probe.held ? `held/${probe.held.versionId}` : `${probe.basis?.versionId ?? null}/${probe.provenance}`
        return outcome === `held/${v1}` || outcome === `${v2}/root-fetch`
      }, { timeout: 90_000, message: 'neither a hold on V1 nor a follow to V2' })
      .toBe(true)
    if (outcome === `held/${v1}`) {
      // The banner is the way to the new default, and taking it follows in place.
      await page.getByTestId('workspace-repoint-follow').click()
    }
    await expect
      .poll(async () => {
        const probe = await bindingProbe(page, landscapeId)
        return `${probe.basis?.versionId ?? null}/${probe.provenance}`
      }, { timeout: 90_000 })
      .toBe(`${v2}/root-fetch`)
    expect((await bindingProbe(page, landscapeId)).held).toBeNull()
    await expect(page.getByTestId('workspace-repoint-banner')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__cachedRootSentinel ?? null),
      'the follow must happen IN PLACE').toBe('alive')

    // And now the canvas shows V2 — over V2's documents.
    await expect.poll(() => canvasName(page, renamed.id), { timeout: 60_000 }).toBe(v2Name)
  })
})
