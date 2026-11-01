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
 * É4-E3 — the browser-naming e2e: offline creation, minted admission, repoint.
 *
 * Two scenarios, both driving the REAL UI for every client action (E2E
 * honesty rule — no store-select/store-mutate shortcuts):
 *
 *  1. A diagram created OFFLINE gets a minted name from the reserve and is
 *     admitted on reconnect by the MAC alone — zero durable-index misses.
 *  2. The same offline creation through a set-default REPOINT executed by an
 *     "operator" while the page is offline. The unsynced work is CARRIED into
 *     the version `current` now names, and the offline DiagramDoc is
 *     RE-CREATED there under an id minted for that version — the product
 *     decision of 2026-10-31, after an architect lens (a stable entity id, a
 *     fresh per-version container: the `forkRoot` rule, and what Replicache,
 *     Linear or PowerSync do with pending work). The source version never
 *     receives it, so the work is not split between a version nobody opens
 *     and the one everybody does. It converges into the CURRENT workspace's
 *     read model with zero index misses.
 *
 *     Until that decision this test asserted the opposite: that the V1-minted
 *     document itself was presented on the V2 socket and admitted through the
 *     server's `displaced` branch (first-owner-wins). Reuse was rejected: it
 *     fails once V1 claimed the document first, and leaves a document whose
 *     MAC names V1 for its whole life (the displaced scan on every cold
 *     presentation, capped at 500 newer versions). The displaced branch keeps
 *     its server tests (docScope.displaced.test.ts) and has no e2e any more.
 *
 * THE discriminant against pre-E2 code is (a): `__docIdInfo(__diagramDocUrl)`
 * decodes the REAL id the registry carries via the production parser
 * (`parseAutomergeUrl`) and must read `{bytes: 24, v0: 1}` — pre-E2 every
 * browser document is a 16-byte random id, so (a) fails always and
 * deterministically. (b) — the `maplespire_docscope_gate_misses_total` delta
 * of 0 — is a hard invariant post-E2; pre-E2 it generally fails too (the
 * unminted DiagramDoc reaches the gate before the registry walk indexes it),
 * but message ORDER can index it first, which is why (a) is the guaranteed
 * discriminant and (b) is the observability criterion.
 *
 * Why the assertion is NOT `walks_total == 0`: the change-listener walk still
 * fires on every edit (it only disappears with F's "déclenchée par un constat"
 * endgame, asserted by claim-at-write.spec.ts on a covered workspace), the
 * upgrade pre-warm calls `scheduleWorkspaceRouteBackfill` on every socket, and
 * the `routeBackfills` memo dedupes the miss's schedule — so walks cannot
 * isolate E2's contribution. The gate-miss counter counts at exactly one site
 * (the route gate's index miss) and is the honest instrument here.
 *
 * Instrumentation is production-grade: the counter is scraped from /metrics
 * with the standard bearer token — E2E_METRICS_TOKEN must be exported and the
 * boot stack's server must set METRICS_TOKEN (a local, non-sensitive value —
 * see e2e/boot/README.md). Without it this spec FAILS with an explicit
 * message; it never skips (a green run that did not run is the worst outcome).
 *
 * Operator actions (the repoint) and metrics scrapes go through
 * `page.request`: it shares the context's cookies (AUTH=on works) and is NOT
 * intercepted by `page.route`/`routeWebSocket`, so the page stays genuinely
 * offline while the operator acts — exactly the real scenario (an admin
 * repoints while the user is disconnected).
 *
 * "Offline" was not offline until 2026-10-29. Both tests create on a LIVE
 * page, and `goOffline(page)` without `installServerRouting` before the first
 * load cannot hold a live page's socket (see helpers.ts). Measured on test 2:
 * the "offline" DiagramDoc was claimed for the source version 3.6 s before
 * the operator's fork, the fork cloned the diagram under a new url, and the
 * url assertion below was red on that clone — not on the product. The
 * window is now routed before load, entered with `{ live: true }`, and
 * checked three ways: the badge reads `offline`, and neither the source
 * version nor the fork lists the diagram before the page reconnects.
 *
 * With the window honest, both tests were RED on 2026-10-29 for product
 * reasons, on origin/develop and on the repoint-binding branch alike. The
 * DiagramDoc of an offline-created diagram had zero storage rows on the
 * server while the registry meta naming it was there (5 runs of 5; test 1's
 * (d) is the check for it). After the repoint, the diagram was absent from
 * the current version (test 2, 3 runs of 3).
 *
 * The first was the client's pending-durability ledger, deleted on reload:
 * StrictMode's remount stopped the first bridge boot while it was still
 * reading the persisted ledger, and the stop wrote its empty in-memory copy
 * over it (bridgeDurableLedgerLifecycle.test.ts). Fixed 2026-10-31; test 1
 * GREEN 5 runs of 5 at retries=0, (d) included.
 *
 * Test 2 leaves the default landscape pointed at the forked version — that IS
 * the scenario (a promoted draft), and the fork is a superset of its source,
 * so subsequent suites see an equivalent workspace.
 *
 * Runs under the `boot` Playwright project against the dev:boot stack
 * (e2e/boot/README.md). Written as part of E3; requires the stack to run the
 * E2 client (minted naming seam) and the F server (claim-at-write).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { test, expect, type Page } from '@playwright/test'
import {
  enterBootApp,
  enterBootAppOffline,
  reloadBootApp,
  goOffline,
  goOnline,
  installServerRouting,
  dragNewShapeToCanvas,
  flushLocal,
  serverObject,
} from './helpers.js'

const API_BASE = process.env.E2E_BOOT_API ?? 'http://localhost:3002'
const METRICS_TOKEN = process.env.E2E_METRICS_TOKEN

/** The gate's index-miss counter, from the production /metrics endpoint. */
async function gateMissTotal(page: Page): Promise<number> {
  expect(
    METRICS_TOKEN,
    'E2E_METRICS_TOKEN is not exported — the boot stack must set METRICS_TOKEN '
    + '(server env) and the runner must export E2E_METRICS_TOKEN with the same '
    + 'value; see e2e/boot/README.md. This spec fails rather than skips.',
  ).toBeTruthy()
  const response = await page.request.get(`${API_BASE}/metrics`, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  })
  expect(
    response.status(),
    `/metrics answered ${response.status()} — 404 means METRICS_TOKEN is unset on the `
    + 'boot stack server, 401 means E2E_METRICS_TOKEN does not match it.',
  ).toBe(200)
  const line = (await response.text())
    .split('\n')
    .find((candidate) => candidate.startsWith('maplespire_docscope_gate_misses_total'))
  expect(line, 'maplespire_docscope_gate_misses_total missing from /metrics').toBeTruthy()
  return Number(line!.trim().split(/\s+/).pop())
}

/** B.1 — the boot top-up must land BEFORE the offline window opens, or the
 * offline creation legitimately falls back to a random id and (a) would blame
 * the wrong thing. This wait pins the supply's boot replenish as a behaviour. */
async function waitForMintedPool(page: Page): Promise<void> {
  // The probes are import.meta.env.DEV hooks: a production bundle ships none
  // of them. Surface THAT as the failure instead of the generic
  // waitForFunction timeout it would otherwise read as.
  expect(
    await page.evaluate(() => Boolean((window as any).__mintedIdSupply)),
    '__mintedIdSupply probe absent — the boot stack must serve a DEV build '
    + '(vite dev / import.meta.env.DEV); this spec cannot run against a '
    + 'production bundle.',
  ).toBe(true)
  await page.waitForFunction(
    () => {
      const supply = (window as any).__mintedIdSupply
      return !!supply && supply.available() > 0
    },
    undefined,
    { timeout: 30_000 },
  )
}

/** Create a blank diagram through the REAL UI (the exact offline.spec.ts flow:
 * breadcrumb menu → All diagrams → Create diagram → Blank) and return its id
 * by diffing the store's diagram list. */
async function createBlankDiagramViaUi(page: Page): Promise<string> {
  const before: string[] = await page.evaluate(() =>
    (window as any).__modelStore.getState().diagrams.map((d: any) => d.id)
  )
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('nav-diagrams').click()
  await page.getByTestId('create-diagram-button').click()
  await page.getByTestId('create-blank').click()
  const id = await page.evaluate(async (prev: string[]) => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    for (let i = 0; i < 50; i++) {
      const s = (window as any).__modelStore.getState()
      const fresh = s.diagrams.find((d: any) => !prev.includes(d.id))
      if (fresh) return fresh.id as string
      await wait(60)
    }
    return null
  }, before)
  expect(id, 'a new diagram must appear after Create → Blank').toBeTruthy()
  return id!
}

/** (a)'s probe: decode the REAL id behind the diagram's registry docUrl with
 * the production parser. {bytes: 24, v0: 1} = a version-1 minted id; a
 * pre-E2 (random) id reads {bytes: 16, v0: <random>}. */
function mintedDocInfo(page: Page, diagramId: string): Promise<{ bytes: number; v0: number } | null> {
  return page.evaluate((id) => {
    const url = (window as any).__diagramDocUrl?.(id)
    if (!url) return null
    return (window as any).__docIdInfo?.(url) ?? null
  }, diagramId)
}

/** Take the LOADED page offline and prove it is: the creation below happens
 * without a reload, and a live page used to keep (or re-open) its sync socket
 * — measured 2026-10-29 on this spec, the "offline" DiagramDoc was claimed by
 * the server 3.6 s before the operator's fork, which then cloned the diagram
 * under a new url. Needs `installServerRouting(page)` before the first load. */
async function goOfflineLive(page: Page): Promise<void> {
  await goOffline(page, { live: true })
  const badge = page.locator('#sync-status')
  await expect
    .poll(() => badge.getAttribute('data-status'), { timeout: 20_000, message: 'the page is still connected after goOffline' })
    .toBe('offline')
}

/** Whether ONE named version's own registry lists the diagram, asked of the
 * server through `page.request` (the page's offline routes do not apply). */
async function registryLists(page: Page, versionId: string, diagramId: string): Promise<boolean> {
  const query = new URLSearchParams({ landscapeId: 'default', versionId, id: diagramId })
  const response = await page.request.get(`${API_BASE}/api/automerge/registry-diagram?${query.toString()}`)
  expect(response.ok(), `GET /api/automerge/registry-diagram -> ${response.status()}`).toBe(true)
  return ((await response.json()) as { present: boolean }).present
}

/**
 * (d) — once the badge says ready, the user may close the tab: close it, and
 * ask the server for the diagram's DiagramDoc. `doc-heads` resolves the url the
 * registry names and answers 404 when the server cannot load that document.
 *
 * The page is closed FIRST on purpose: the server's lookup is a network find,
 * so with the tab still open it could fetch the document from the tab itself
 * and heal the very thing being measured. Closed, nothing but the server holds
 * it — which is what every other client would get.
 *
 * Not the read model: `diagram-render` places an object from the object's own
 * model position, so it answered "placed" for a DiagramDoc with zero storage
 * rows (measured 2026-10-29) — a witness that could not fail.
 */
async function closeAndReadServerDiagramDoc(page: Page, diagramId: string): Promise<number> {
  const request = page.context().request
  await page.close()
  const query = new URLSearchParams({ landscapeId: 'default', versionId: 'current', id: diagramId })
  const response = await request.get(`${API_BASE}/api/automerge/doc-heads?${query.toString()}`)
  return response.status()
}

async function assertDiagramPresent(page: Page, diagramId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => (window as any).__modelStore.getState().diagrams.some((d: any) => d.id === id),
          diagramId
        ),
      { timeout: 15_000 }
    )
    .toBe(true)
}

test.describe('minted browser naming — offline create + repoint (E3)', () => {
  test('an offline-created diagram is admitted on reconnect: minted name, zero gate misses', async ({ page }) => {
    await installServerRouting(page)
    await enterBootApp(page)
    await waitForMintedPool(page)
    const missesBefore = await gateMissTotal(page)

    // OFFLINE: create a diagram and draw a shape on it, all through the UI.
    await goOfflineLive(page)
    const diagramId = await createBlankDiagramViaUi(page)
    const objectId = await dragNewShapeToCanvas(page, 'system')
    await flushLocal(page)

    // Local durability first (the offline.spec pattern): the creation must
    // survive an OFFLINE reload before the reconnect proves anything.
    await page.reload()
    await enterBootAppOffline(page)
    await assertDiagramPresent(page, diagramId)

    // Reconnect.
    await goOnline(page)
    await reloadBootApp(page)
    await assertDiagramPresent(page, diagramId)

    // (a) THE discriminant: the registry's docUrl for the offline-created
    // diagram decodes to a 24-byte version-1 minted id. Pre-E2: 16 bytes,
    // always, deterministically.
    await expect.poll(() => mintedDocInfo(page, diagramId), { timeout: 30_000 }).toEqual({ bytes: 24, v0: 1 })

    // (c) Real convergence: the dragged object reaches the server read model
    // and the badge settles on ready — no permanent deny anywhere.
    await expect.poll(async () => Boolean(await serverObject(page, objectId)), { timeout: 45_000 }).toBe(true)
    const badge = page.locator('#sync-status')
    await expect.poll(() => badge.getAttribute('data-status'), { timeout: 30_000 }).toBe('ready')

    // (b) Zero index misses over the whole window: the minted DiagramDoc is
    // admitted by the MAC, never by the durable-index fallback.
    expect(
      (await gateMissTotal(page)) - missesBefore,
      'an offline-created minted document must never miss the durable index on admission',
    ).toBe(0)

    // (d) The DiagramDoc itself reached the server, not only the registry
    // meta naming it. Measured 2026-10-29, 3 runs of 3 once the window was
    // really offline: the meta was published, the document never arrived
    // (zero storage rows, even with the tab held open 60 s) while the badge
    // said ready, and the version's next fork failed on "Document … is
    // unavailable". The offline reload had deleted the ledger entry that
    // re-presents it (see the header).
    expect(
      await closeAndReadServerDiagramDoc(page, diagramId),
      'the badge said ready, yet the server cannot load the offline-created DiagramDoc',
    ).toBe(200)
  })

  test('offline create through a set-default repoint: carried into the new default, re-created there, zero gate misses', async ({ page }) => {
    // Four boots (enter, the reconnect's reload + goto, the later page load)
    // and server polls of up to 60 s each: measured 108 s on a quiet machine,
    // past the 120 s default under load.
    test.setTimeout(300_000)
    await installServerRouting(page)
    await enterBootApp(page)
    await waitForMintedPool(page)
    const missesBefore = await gateMissTotal(page)

    // OFFLINE: same creation as test 1 (diagram + shape), through the UI.
    await goOfflineLive(page)
    const diagramId = await createBlankDiagramViaUi(page)
    const objectId = await dragNewShapeToCanvas(page, 'system')
    await flushLocal(page)

    // Capture the doc URL the registry carries BEFORE going back online: the
    // decided behaviour is that the diagram lands in the new default under a
    // DIFFERENT document, minted for that version (see the header).
    const offlineDocUrl = await page.evaluate(
      (id) => (window as any).__diagramDocUrl?.(id) ?? null,
      diagramId,
    )
    expect(offlineDocUrl, 'the offline-created diagram must already carry a doc url').toBeTruthy()

    // While the page is offline, the OPERATOR repoints the landscape through
    // the real API: fork the current default version, then set the fork as
    // default (the draft-promotion gesture). page.request bypasses the
    // page.route offline interception on purpose — the page stays offline.
    const landscapes = (await (await page.request.get(`${API_BASE}/api/landscapes`)).json()) as {
      landscapes: { id: string; defaultVersionId: string | null }[]
    }
    const defaultLandscape = landscapes.landscapes.find((l) => l.id === 'default')
    expect(defaultLandscape?.defaultVersionId, 'the default landscape must expose its default version').toBeTruthy()
    const forkResponse = await page.request.post(`${API_BASE}/api/landscapes/default/versions`, {
      data: {
        label: `e2e-repoint-${Date.now().toString(36)}`,
        forkFromVersionId: defaultLandscape!.defaultVersionId,
      },
    })
    expect(forkResponse.ok(), 'the operator fork must succeed').toBe(true)
    const forkedVersionId = ((await forkResponse.json()) as { version: { id: string } }).version.id
    const setDefaultResponse = await page.request.put(`${API_BASE}/api/landscapes/default/default-version`, {
      data: { versionId: forkedVersionId },
    })
    expect(setDefaultResponse.ok(), 'the operator set-default must succeed').toBe(true)

    // The fork must NOT already carry the diagram. If it does, the creation
    // reached the server before the fork, the fork CLONED it under a new url,
    // and every assertion below would be about the operator's copy — nothing
    // would have been carried. (The fork is a snapshot: what it lists now is
    // fixed, while the page stays offline.)
    expect(await page.locator('#sync-status').getAttribute('data-status'), 'the page reconnected during the offline window').toBe('offline')
    expect(
      await registryLists(page, defaultLandscape!.defaultVersionId!, diagramId),
      'the offline-created diagram reached the source version while the page was offline',
    ).toBe(false)
    expect(
      await registryLists(page, forkedVersionId, diagramId),
      'the fork already lists the offline-created diagram: it cloned a creation that was not offline',
    ).toBe(false)

    // Reconnect: the client's `current` alias now resolves to the fork
    // (fetchRootUrl is no-store; the alias's cached root url is re-fetched
    // online), so this boot IS the repoint from the client's point of view.
    await goOnline(page)
    await reloadBootApp(page)

    // The offline-created diagram survived THROUGH the repoint: its journaled
    // creation was put back for the version `current` now names, and replayed
    // there (bridge.ts `partitionDurableLedger`).
    await assertDiagramPresent(page, diagramId)
    // With what the user drew on it — the creation's journaled snapshot keeps
    // the composition the diagram gained after its first flush.
    await expect.poll(
      () => page.evaluate(
        (id) => (window as any).__modelStore.getState().diagrams.find((d: any) => d.id === id)?.objectIds ?? [],
        diagramId,
      ),
      { timeout: 30_000, message: 'the carried diagram lost the shape drawn on it offline' },
    ).toContain(objectId)
    // The positive half of the fork check above: the fork lists it now, and
    // only the reconnected client can have put it there.
    await expect
      .poll(() => registryLists(page, forkedVersionId, diagramId), { timeout: 60_000 })
      .toBe(true)

    // RE-CREATED, not reused: a different document, still a version-1 minted
    // id (named by a pool the repoint rebound to the fork).
    const carriedDocUrl = await page.evaluate((id) => (window as any).__diagramDocUrl?.(id) ?? null, diagramId)
    expect(carriedDocUrl, 'the carried diagram must name a document').toBeTruthy()
    expect(carriedDocUrl, 'the V1-minted document was reused instead of re-created').not.toBe(offlineDocUrl)
    await expect.poll(() => mintedDocInfo(page, diagramId), { timeout: 30_000 }).toEqual({ bytes: 24, v0: 1 })

    // Content converges into the CURRENT (forked) workspace's read model.
    await expect.poll(async () => Boolean(await serverObject(page, objectId)), { timeout: 60_000 }).toBe(true)

    // Badge ready: nothing left owed — the old version's documents left the
    // ledger, and the carried ones are durable.
    const badge = page.locator('#sync-status')
    await expect.poll(() => badge.getAttribute('data-status'), { timeout: 30_000 }).toBe('ready')

    // NOT SPLIT: the source version never received the offline work. Measured
    // before the change: V1's server registry gained the diagram while its
    // document was claimed by the fork (3 runs of 3).
    expect(
      await registryLists(page, defaultLandscape!.defaultVersionId!, diagramId),
      'the offline work was split: the source version received it too',
    ).toBe(false)

    // (b) The re-created document is minted for the fork: admitted by its MAC,
    // never by the durable-index fallback.
    expect(
      (await gateMissTotal(page)) - missesBefore,
      'a carried, re-minted document must never miss the durable index on admission',
    ).toBe(0)

    // A LATER page load still keeps the old version's documents off the
    // socket (they left the ledger; the server announces its root's registry
    // shards to every peer): the source version must still not list it.
    await reloadBootApp(page)
    await assertDiagramPresent(page, diagramId)
    await expect.poll(() => badge.getAttribute('data-status'), { timeout: 30_000 }).toBe('ready')
    expect(
      await registryLists(page, defaultLandscape!.defaultVersionId!, diagramId),
      'a later page load delivered the offline work to the source version',
    ).toBe(false)
    expect(await registryLists(page, forkedVersionId, diagramId)).toBe(true)

    // (d) as in test 1: the current version can load the DiagramDoc once the
    // tab that made it is gone.
    expect(
      await closeAndReadServerDiagramDoc(page, diagramId),
      'the badge said ready, yet the current version cannot load the carried DiagramDoc',
    ).toBe(200)
  })
})
