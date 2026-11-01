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
 * A `current` TAB WHOSE NEW DEFAULT NEVER ARRIVES, WITH THE SERVER UP.
 *
 * After a repoint the root fetch answers at once with the new default's root,
 * and the documents of that graph may not come (the sync layer still warming
 * up). The boot then runs out its budget and re-enters from the last locally
 * materialized root: the boot FALLBACK (`bridge.ts`, startBridge's catch). The
 * cached root is the OLD version's, and the socket is bound to the NEW one.
 *
 * Before this spec's change the tab was then neither held nor followed:
 *
 *  - the socket's binding frame arrived during the failed boot, before the
 *    bridge installed the repoint detector (`wireConnectionStatus`, at the end
 *    of a successful boot), and `noteWorkspaceBinding` dropped it;
 *  - the re-entry does not reconnect (`WorkspaceNetworkRouter.route` is a
 *    no-op on the same route), so no second frame came until some later
 *    reconnect;
 *  - meanwhile the socket stayed bound to the new version while every document
 *    the tab holds belongs to the old one: under AM_WORKSPACE_ROUTING=on each
 *    is refused `workspace-mismatch` and an edit never becomes durable.
 *
 * Now the frame a missing handler could not take is kept and delivered when
 * the handler is installed (`workspaceBinding.ts`), and a fallback session HOLDS
 * on the version its cached root belongs to instead of following: following
 * re-asks the server for the very root that just failed to materialize.
 *
 * ## The two ways in
 *
 * Test 1 reloads the tab after the default moved (the tab was away). Test 2
 * keeps the tab open: the server drains its socket, the tab, with nothing
 * unsaved, FOLLOWS — and that follow's own boot falls back. Its replay lands
 * while the follow is still in flight, which the bridge used to ignore, so
 * test 2 pins the deferred delivery as well.
 *
 * ## The discriminants
 *
 *  - `held` becomes V1, in place (no page reload), with the banner naming the
 *    fallback as the reason. Before: `held` stayed null in both tests.
 *  - An edit made after the hold is durable in V1 and not in V2. Before, with
 *    routing enforced, it was refused for ever.
 *  - Every diagram-render requested after the fallback names V1. Before, the
 *    re-entry's render prefetch (issued before the root) asked `current` = V2
 *    and the canvas could draw V2's renamed object over V1's documents.
 *  - No second fallback: the root is fetched no more after the hold, for longer
 *    than a boot budget. Following instead would re-ask for the withheld root
 *    and fall back again on every reconnect.
 *
 * Void-run guards: the withholding route must have dropped frames, the console
 * must carry the bridge's fallback warning, the badge must say the session is
 * the local-cache detour, and the socket must have been bound to V2.
 *
 * ## How "the new default never arrives" is made
 *
 * `installDocumentWithholding` (repointHelpers.ts) drops every server→page
 * frame that names the new default's ROOT document on the page's sync socket.
 * Everything else passes, the binding frame included. The operator's fork,
 * rename and repoint go through `page.request` and a second browser context,
 * which the page's route does not intercept.
 *
 *   E2E_BOOT_URL=http://localhost:5361 E2E_BOOT_API=http://localhost:3131 \
 *     npx playwright test --project=boot e2e/boot/repoint-boot-fallback.spec.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { test, expect, type Page } from '@playwright/test'
import { editObjectNameDesc, flushLocal, selectShapeById, waitForDiagramRenderCached } from './helpers.js'
import {
  bindingProbe,
  canvasName,
  defaultVersionId,
  documentIdOf,
  enterOnAlias,
  fork,
  installDocumentWithholding,
  nameInWorkspace,
  renameInVersion,
  rootOf,
  setDefaultVersion,
  syncBadge,
  twoCanvasObjects,
} from './repointHelpers.js'

/** One ordered log of what the page did from now on: the bridge's fallback
 * warning, the repoint detector's decisions, every root fetch and every
 * diagram-render (by the version it names). One array, so "after the fallback"
 * is a position in it rather than two clocks to compare. */
function recordBootEvents(page: Page): string[] {
  const events: string[] = []
  page.on('console', (message) => {
    const text = message.text()
    if (text.includes('did not materialize from the server in time')) events.push('fallback')
    if (text.includes('workspace.repoint_observed')) {
      try {
        events.push(`repoint:${(JSON.parse(text) as { action?: string }).action ?? '?'}`)
      } catch {
        events.push('repoint:?')
      }
    }
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.endsWith('/api/automerge/root')) events.push('root-fetch')
    if (url.pathname.endsWith('/api/model/diagram-render')) events.push(`render:${url.searchParams.get('versionId') ?? ''}`)
  })
  return events
}

/** Renders requested after the (first) fallback, by version. */
function rendersAfterFallback(events: string[]): string[] {
  const from = events.indexOf('fallback')
  if (from < 0) return []
  return events.slice(from).filter((e) => e.startsWith('render:')).map((e) => e.slice('render:'.length))
}

/** The fallback session is held on V1, in place, and says why — then an edit
 * made there is durable in V1 and nowhere else, and nothing tears it down. */
async function expectHeldOnCachedVersion(
  page: Page,
  args: {
    landscapeId: string
    v1: string
    v2: string
    renamed: { id: string; name: string }
    edited: { id: string; name: string }
    events: string[]
    withheldDropped: () => number
  },
): Promise<void> {
  const { landscapeId, v1, v2, renamed, edited, events } = args

  // Void-run guards: the fallback really ran, over a withheld root.
  await expect.poll(() => events.includes('fallback'), { timeout: 120_000, message: 'the boot never fell back' })
    .toBe(true)
  expect(args.withheldDropped(), 'the withholding route dropped nothing').toBeGreaterThan(0)
  await expect(syncBadge(page)).toHaveAttribute('data-boot-fallback', 'true', { timeout: 60_000 })

  // HELD on the cached root's version, and told why.
  await expect.poll(async () => (await bindingProbe(page, landscapeId)).held?.versionId ?? null, {
    timeout: 60_000,
    message: 'the fallback session was neither held nor followed',
  }).toBe(v1)
  const banner = page.getByTestId('workspace-repoint-banner')
  await expect(banner).toBeVisible({ timeout: 30_000 })
  await expect(banner).toHaveAttribute('data-reason', 'boot-fallback')
  expect(page.url()).toContain('/version/current')
  const probe = await bindingProbe(page, landscapeId)
  expect(`${probe.basis?.versionId}/${probe.provenance}`, 'the basis is the cached root\'s record')
    .toBe(`${v1}/root-cache`)

  // The canvas shows V1, and every render since the fallback asked V1.
  await expect.poll(() => canvasName(page, renamed.id), { timeout: 30_000 }).toBe(renamed.name)
  const renders = rendersAfterFallback(events)
  expect(renders.length, 'no render was requested after the fallback').toBeGreaterThan(0)
  expect(renders.filter((version) => version !== v1), `renders after the fallback: ${renders.join(', ')}`)
    .toEqual([])

  // Work done here is durable where the tab is, and nowhere else.
  const editName = `held-${Date.now().toString(36)}`
  await selectShapeById(page, edited.id)
  await editObjectNameDesc(page, editName, 'edited in the fallback session')
  await flushLocal(page)
  await expect.poll(() => nameInWorkspace(page, edited.id, { landscapeId, versionId: v1 }), { timeout: 90_000 })
    .toBe(editName)
  await expect.poll(() => nameInWorkspace(page, edited.id, { landscapeId, versionId: v2 }), { timeout: 60_000 })
    .toBe(edited.name)
  await expect(syncBadge(page)).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })

  // Nothing tears the session down again: no root fetch for longer than a boot
  // budget (24 s, `BOOT_DOCUMENT_RESOLUTION.budgetMs`), the hold still there.
  const rootFetchesAtHold = events.filter((e) => e === 'root-fetch').length
  await page.waitForTimeout(30_000)
  expect(events.filter((e) => e === 'root-fetch').length, `events: ${events.join(' ')}`).toBe(rootFetchesAtHold)
  expect(events.filter((e) => e === 'fallback').length, `events: ${events.join(' ')}`).toBe(1)
  expect((await bindingProbe(page, landscapeId)).held?.versionId ?? null).toBe(v1)
  expect(await page.evaluate(() => (window as any).__fallbackSentinel ?? null),
    'the hold must happen IN PLACE — a reload re-fetches the root and proves nothing').toBe('alive')
}

test.describe.configure({ mode: 'serial' })

test.describe('a `current` tab whose new default never arrives, with the server up', () => {
  // Two boots, one of them spending the whole 24 s resolution budget on the
  // withheld root, an operator session on a fresh fork, then 30 s of watching.
  test.beforeEach(() => test.setTimeout(420_000))

  test('reloaded after the default moved, it falls back to its cached root and is held there', async ({ page, browser }) => {
    const frames = await installDocumentWithholding(page)
    const { landscapeId, diagramId, tabUrl } = await enterOnAlias(page)
    const v1 = await defaultVersionId(page, landscapeId)
    await expect.poll(async () => (await bindingProbe(page, landscapeId)).basis?.versionId ?? null, { timeout: 60_000 })
      .toBe(v1)
    await expect(syncBadge(page)).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
    await waitForDiagramRenderCached(page)
    const [renamed, edited] = await twoCanvasObjects(page)
    const v2Name = `v2only-${Date.now().toString(36)}`

    const v2 = await fork(page, landscapeId, v1, 'e2e-boot-fallback')
    await renameInVersion(browser, page, { landscapeId, versionId: v2 }, diagramId, renamed.id, v2Name)
    const v2Root = await rootOf(page, { landscapeId, versionId: v2 })
    expect(v2Root.versionId).toBe(v2)
    frames.withhold(documentIdOf(v2Root.url))

    // The tab goes away; the default moves while it is gone; it comes back.
    await page.goto('about:blank')
    await setDefaultVersion(page, landscapeId, v2)
    const events = recordBootEvents(page)
    const bindingsBefore = frames.bindings().length
    await page.goto(tabUrl)
    await page.evaluate(() => { (window as any).__fallbackSentinel = 'alive' })

    await expectHeldOnCachedVersion(page, {
      landscapeId, v1, v2, renamed, edited, events, withheldDropped: frames.dropped,
    })
    // The socket of that boot was bound to the new default — the disagreement.
    expect(frames.bindings().slice(bindingsBefore)[0]).toBe(v2)
    expect(events.filter((e) => e.startsWith('repoint:')), `events: ${events.join(' ')}`).toEqual(['repoint:pin'])
  })

  test('open when the default moves, it follows, the follow falls back, and it is held there', async ({ page, browser }) => {
    const frames = await installDocumentWithholding(page)
    const { landscapeId, diagramId } = await enterOnAlias(page)
    const v1 = await defaultVersionId(page, landscapeId)
    await expect.poll(async () => (await bindingProbe(page, landscapeId)).basis?.versionId ?? null, { timeout: 60_000 })
      .toBe(v1)
    // Nothing to lose, so the live detector FOLLOWS (repoint-live-tab.spec.ts
    // explains why the badge is this precondition).
    await expect(syncBadge(page)).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
    await waitForDiagramRenderCached(page)
    const [renamed, edited] = await twoCanvasObjects(page)
    const v2Name = `v2only-${Date.now().toString(36)}`

    const v2 = await fork(page, landscapeId, v1, 'e2e-boot-fallback')
    await renameInVersion(browser, page, { landscapeId, versionId: v2 }, diagramId, renamed.id, v2Name)
    const v2Root = await rootOf(page, { landscapeId, versionId: v2 })
    expect(v2Root.versionId).toBe(v2)
    frames.withhold(documentIdOf(v2Root.url))
    await expect(syncBadge(page)).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })

    const events = recordBootEvents(page)
    await page.evaluate(() => { (window as any).__fallbackSentinel = 'alive' })
    // The server drains the sockets bound to the old default; the reconnect's
    // frame names V2.
    await setDefaultVersion(page, landscapeId, v2)
    await expect.poll(() => events.find((e) => e.startsWith('repoint:')) ?? null, {
      timeout: 120_000,
      message: 'the live tab never observed the repoint',
    }).toBe('repoint:follow')

    await expectHeldOnCachedVersion(page, {
      landscapeId, v1, v2, renamed, edited, events, withheldDropped: frames.dropped,
    })
    expect(events.filter((e) => e.startsWith('repoint:')), `events: ${events.join(' ')}`)
      .toEqual(['repoint:follow', 'repoint:pin'])
  })
})
