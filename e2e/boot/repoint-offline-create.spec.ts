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
 *     "operator" while the page is offline: the V1-minted DiagramDoc presented
 *     on the V2-canonicalised socket takes the `displaced` branch (durable
 *     first-owner-wins claim — slice D end to end), converges into the
 *     CURRENT workspace's read model, and still causes zero index misses.
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
    await enterBootApp(page)
    await waitForMintedPool(page)
    const missesBefore = await gateMissTotal(page)

    // OFFLINE: create a diagram and draw a shape on it, all through the UI.
    await goOffline(page)
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
  })

  test('offline create through a set-default repoint: displaced-claimed, converges, zero gate misses', async ({ page }) => {
    await enterBootApp(page)
    await waitForMintedPool(page)
    const missesBefore = await gateMissTotal(page)

    // OFFLINE: same creation as test 1 (diagram + shape), through the UI.
    await goOffline(page)
    const diagramId = await createBlankDiagramViaUi(page)
    const objectId = await dragNewShapeToCanvas(page, 'system')
    await flushLocal(page)

    // QA hole n°3 — capture the doc URL the registry carries BEFORE going
    // back online. The discriminating repoint assertion is that this URL is
    // IDENTICAL after the reboot: same URL ⇒ the V1-minted document itself
    // was ADMITTED (displaced branch). A recovery that re-created the diagram
    // under a fresh V2-minted id would converge, read {bytes: 24, v0: 1} and
    // count zero misses — passing every other assertion while silently
    // skipping the branch under test.
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

    // Reconnect: the client's `current` alias now resolves to the fork
    // (fetchRootUrl is no-store; the alias's cached root url is re-fetched
    // online), so this boot IS the repoint from the client's point of view.
    await goOnline(page)
    await reloadBootApp(page)

    // The offline-created diagram survived THROUGH the repoint: the
    // alias-keyed journals/holds replay into the current workspace, and the
    // V1-minted DiagramDoc presented on the V2-canonicalised socket takes the
    // `displaced` branch — durable first-owner-wins claim, admission, announce
    // (slice D end to end, previously uncovered by any e2e).
    await assertDiagramPresent(page, diagramId)
    await expect.poll(() => mintedDocInfo(page, diagramId), { timeout: 30_000 }).toEqual({ bytes: 24, v0: 1 })

    // The URL captured offline survived the repoint IDENTICALLY — admitted
    // displaced, not re-created under a V2 id (see the capture above).
    expect(
      await page.evaluate((id) => (window as any).__diagramDocUrl?.(id) ?? null, diagramId),
      'a changed doc url means the document was re-created instead of displaced-admitted',
    ).toBe(offlineDocUrl)

    // Content converges into the CURRENT (forked) workspace's read model.
    await expect.poll(async () => Boolean(await serverObject(page, objectId)), { timeout: 60_000 }).toBe(true)

    // Badge ready: every deny on this path is paired with a lift (the claim's
    // announce) — a permanent deny would leave the badge stuck on saving.
    const badge = page.locator('#sync-status')
    await expect.poll(() => badge.getAttribute('data-status'), { timeout: 30_000 }).toBe('ready')

    // (b) The displaced path consults the CLAIM table, never the index-miss
    // fallback: pre-E2 the same document is unminted and IS a miss.
    expect(
      (await gateMissTotal(page)) - missesBefore,
      'a repointed minted document must take the displaced branch, not the index-miss branch',
    ).toBe(0)

    // Consigned, not asserted (correct behaviour, per the design): a local
    // edit of the V1 REGISTRY SHARD on the V2 socket is rightly refused
    // (`sameWorkspace` false — the shard doc is durably indexed to V1); its
    // lift is an explicit visit of V1, not anything this test should force.
  })
})
