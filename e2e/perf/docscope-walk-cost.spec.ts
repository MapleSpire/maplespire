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

/* eslint-disable @typescript-eslint/no-explicit-any */

// What does the docScope re-walk actually cost during ordinary editing?
//
// OPT-IN. Set DOCSCOPE_WALK_MEASURE=1. It is a measurement, not a gate: it
// asserts only that the WORKLOAD happened, and prints the numbers for a human
// to compare across two builds.
//
// Two rules shape this file:
//
//  1. **The workload asserts itself.** A workload that never reaches a watched
//     document (e.g. a peer harness editing a document the server did not hold
//     when its walk ran, or `page.mouse` drags aimed at screenshot pixels,
//     which are not canvas coordinates) reads zero walks on any build. If the
//     drags do not move the shape in the store, the test FAILS instead of
//     reporting a flattering zero.
//  2. **The dataset declares itself.** Zero walks on a toy workspace says
//     nothing about a cost that grows with document count. Every RESULT line
//     carries the workspace size, and DOCSCOPE_WALK_MIN_OBJECTS turns "this
//     run is at scale" from a claim into an assertion.
//
// ===========================================================================
// KNOWN LIMITS. READ THIS BEFORE QUOTING ANY NUMBER FROM HERE.
// ===========================================================================
//
// This spec CANNOT trigger the expensive walk, so its zero is guaranteed by
// construction. Three open defects:
//
//  a. WRONG WORKLOAD. The rename below writes a MODEL shard, and model shards
//     are watched with `control = false` (docScope.ts, `findLeaf(u)` then
//     `watch(h)` with no second argument), so they arm nothing. Only
//     a REGISTRY shard write — creating, renaming or deleting a DIAGRAM, not an
//     object — arms a hydrating re-walk. This spec never does that.
//  b. THE COUNTER CONFLATES TWO WALKS. `maplespire_docscope_walks_total` is
//     incremented by `walk()`, which serves both the hydrating traversal and the
//     manifest-only backfill (`hydrateLeaves: false`) that the socket upgrade
//     runs. Their costs differ by ~100x and /metrics does not separate them, so
//     `walkSecondsDuringEditing` is not a hydrating-walk cost.
//  c. THE SCALE GUARD IS UNSOUND WHERE IT MATTERS. DOCSCOPE_WALK_MIN_OBJECTS
//     asserts on `storeObjects`, which this file itself documents as NOT a
//     workspace size under boot-from-server — and boot-from-server is the only
//     configuration measured as viable at 10k scale. A genuinely
//     at-scale run under that flag holds ~30 objects and fails the assertion.
//
// What DID produce trustworthy numbers is a storage-only harness driving
// `walkFrom` directly, with the durable claim table emptied and re-read as proof
// of traversal.
// Until (a)-(c) are fixed, treat this spec as a workload driver, not as a
// measurement of the docScope walk.
//
// The projection comes from `shapeScreenCenter` (e2e/boot/helpers.ts), which
// reads the live canvas engine's viewport rather than guessing.

import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { shapeScreenCenter } from '../boot/helpers'

const API = process.env.E2E_API_URL ?? 'http://localhost:3021'
const METRICS_TOKEN = process.env.METRICS_TOKEN ?? 'dev-metrics-angry-fermat'
const LOGIN_EMAIL = process.env.E2E_LOGIN_EMAIL ?? 'admin@example.com'
const DRAGS = Number(process.env.DOCSCOPE_WALK_DRAGS ?? 20)
const LABEL = process.env.DOCSCOPE_WALK_LABEL ?? 'run'
/** Set on a run that claims to be at target scale; it then has to prove it. */
const MIN_OBJECTS = Number(process.env.DOCSCOPE_WALK_MIN_OBJECTS ?? 0)
/** A diagram route, not '/'. Both arms must use the SAME one. */
const APP_PATH = process.env.DOCSCOPE_WALK_PATH
  ?? '/app/landscape/la5PcOfSI22yWuXt/version/current/diagram/0-landscape'

interface WalkSample { walks: number; walkSeconds: number; p50: number | null; p99: number | null; max: number | null }

/** Read the docScope walk counters straight off /metrics. */
async function sampleWalks(request: APIRequestContext): Promise<WalkSample> {
  const res = await request.get(`${API}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })
  expect(res.status(), '/metrics needs METRICS_TOKEN set on the server (worktree-local server/.env)').toBe(200)
  const text = await res.text()
  const num = (name: string, labels = ''): number | null => {
    const prefix = labels ? `${name}{${labels}}` : `${name} `
    const line = text.split('\n').find((l) => l.startsWith(prefix))
    if (!line) return null
    const value = Number(line.slice(line.lastIndexOf(' ') + 1))
    return Number.isFinite(value) ? value : null
  }
  return {
    walks: num('maplespire_docscope_walks_total') ?? 0,
    walkSeconds: num('maplespire_docscope_walk_seconds_total') ?? 0,
    p50: num('maplespire_docscope_walk_duration_seconds', 'quantile="0.5"'),
    p99: num('maplespire_docscope_walk_duration_seconds', 'quantile="0.99"'),
    max: num('maplespire_docscope_walk_duration_seconds', 'quantile="max"'),
  }
}

/** The size of the thing that was actually measured.
 *
 * THE SECOND RULE. The workload guards below prove that the edits HAPPENED;
 * they say nothing about whether they happened on a workspace worth measuring
 * (e.g. one smaller than the smallest seed profile, TEST_PERFORMANCE_SEED_SCALE
 * at 600 objects).
 *
 * So the number never travels without its denominator: every RESULT line carries
 * the dataset, and DOCSCOPE_WALK_MIN_OBJECTS lets a run that CLAIMS to be at scale
 * prove it instead of being taken at its word.
 *
 * `shardCounts` is the load-bearing figure, not the object count: the walk's cost
 * scales with documents traversed, and shards are watched leaves. `storeObjects` is reported for orientation and is NOT a
 * workspace size under boot-from-server, which holds only the active diagram.
 */
async function datasetScale(page: Page): Promise<Record<string, number | boolean | null>> {
  return page.evaluate(() => {
    const state = (window as any).__modelStore?.getState?.()
    const debug = (window as any).__bridgeDebug?.()
    return {
      storeObjects: state?.objects?.length ?? null,
      storeConnections: state?.connections?.length ?? null,
      storeDiagrams: state?.diagrams?.length ?? null,
      objectShards: debug?.metaObjShardCount ?? null,
      connectionShards: debug?.metaConnShardCount ?? null,
      objectOverlaySegments: debug?.objectOverlaySegmentCount ?? null,
      // Boot-from-server truncates the store to the active diagram, so
      // storeObjects is not a workspace size when this is true.
      bootFromServer: (window as any).__bootFromServer?.() ?? null,
    }
  })
}

/** Position as the canvas engine holds it — the value a drag must change. */
function shapePosition(page: Page, id: string): Promise<{ x: number; y: number }> {
  return page.evaluate((oid) => {
    const object = (window as any).__canvasEngine?.objectMap?.get(oid)
    if (!object) throw new Error(`object not on canvas: ${oid}`)
    return { x: object.position.x, y: object.position.y }
  }, id)
}

test.describe('docScope walk cost during ordinary editing', () => {
  test.skip(!process.env.DOCSCOPE_WALK_MEASURE, 'measurement tool — set DOCSCOPE_WALK_MEASURE=1')

  test(`${LABEL}: ${DRAGS} shape drags`, async ({ page, context, request }) => {
    test.setTimeout(300_000)

    // AUTH=on on this stack, so the browser needs a session before '/' is the app.
    const login = await request.post(`${API}/api/auth/dev-login`, { data: { email: LOGIN_EMAIL } })
    expect(login.status(), 'dev-login (needs AUTH_DEV_LOGIN=on)').toBe(200)
    const cookies = login.headers()['set-cookie']
    if (cookies) {
      await context.addCookies(cookies.split('\n').map((raw) => {
        const [pair] = raw.split(';')
        const index = pair.indexOf('=')
        return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), domain: 'localhost', path: '/' }
      }))
    }

    // NOT '/': that is the marketing landing page, which has no canvas and no
    // currentDiagramId, and waiting for the engine there times out at 120 s.
    await page.goto(APP_PATH)
    // The app remembers the last canvas view and can restore 3D, where the 2D
    // engine this measurement drives does not exist. Force 2D before waiting.
    const twoD = page.getByTestId('view-2d')
    await twoD.waitFor({ timeout: 120_000 })
    await twoD.click()
    // The app is ready when the store has content AND the canvas engine has
    // rendered it — `shapeScreenCenter` reads objectMap, which fills after the
    // store does.
    await page.waitForFunction(() => {
      const state = (window as any).__modelStore?.getState?.()
      const engine = (window as any).__canvasEngine
      return !!state?.currentDiagramId && !!engine?.objectMap && engine.objectMap.size > 0
    }, undefined, { timeout: 120_000 })
    // Best-effort: let the background index build settle so it is not competing
    // for the main thread inside the measured window.
    await page.waitForFunction(() => (window as any).__indexReady?.ready?.() === true, undefined, { timeout: 30_000 })
      .catch(() => {})
    await page.waitForTimeout(5_000)

    const scale = await datasetScale(page)

    // A run that claims to be at scale has to prove it. Unset, this is inert and
    // the run is still valid — but its RESULT line now carries the dataset, so
    // nobody can quote the number without the denominator.
    if (MIN_OBJECTS > 0) {
      expect(
        Number(scale.storeObjects ?? 0),
        `DOCSCOPE_WALK_MIN_OBJECTS=${MIN_OBJECTS} was set, so this run claims to be at scale — but the workspace holds ${String(scale.storeObjects)} objects. Seed it (npm run seed:performance) or drop the variable; do not report a number from a workspace this size.`,
      ).toBeGreaterThanOrEqual(MIN_OBJECTS)
    }

    const target = await page.evaluate(() => {
      const engine = (window as any).__canvasEngine
      return [...engine.objectMap.keys()][0] as string
    })
    const origin = await shapePosition(page, target)

    const before = await sampleWalks(request)

    // Real drags, alternating so the diagram does not drift across the run.
    let effective = 0
    for (let i = 0; i < DRAGS; i += 1) {
      const centre = await shapeScreenCenter(page, target)
      const dx = i % 2 === 0 ? 60 : -60
      const positionBefore = await shapePosition(page, target)
      await page.mouse.move(centre.x, centre.y)
      await page.mouse.down()
      for (let step = 1; step <= 5; step += 1) {
        await page.mouse.move(centre.x + (dx * step) / 5, centre.y + (dx * step) / 10)
        await page.waitForTimeout(16)
      }
      await page.mouse.up()
      await page.waitForTimeout(250)
      const positionAfter = await shapePosition(page, target)
      if (positionAfter.x !== positionBefore.x || positionAfter.y !== positionBefore.y) effective += 1
    }

    // THE GUARD. A workload that moved nothing produces zero walks on any build,
    // which is exactly the false PASS this file was written to prevent.
    expect(effective, 'the drags must actually move the shape, or the run measures nothing').toBeGreaterThan(0)

    // A DRAG writes only the diagram document's `layouts`. A RENAME writes the
    // object into its model shard — and that distinction turned out to decide
    // the whole measurement: the server resolves shards from its own storage at
    // walk time, so they are watched, whereas a diagram document typically
    // arrives from the client AFTER the walk has run and is therefore never
    // watched at all. Editing only positions measures a path docScope is not on.
    let renames = 0
    await page.mouse.click((await shapeScreenCenter(page, target)).x, (await shapeScreenCenter(page, target)).y)
    const nameField = page.getByTestId('object-name')
    if (await nameField.count()) {
      const original = await nameField.inputValue()
      for (let i = 0; i < DRAGS; i += 1) {
        await nameField.fill(`${original} ${i}`)
        await nameField.blur()
        await page.waitForTimeout(300)
        renames += 1
      }
      await nameField.fill(original)
      await nameField.blur()
      await page.waitForTimeout(500)
    }
    expect(renames, 'the object rename workload must run — it is the shard-writing half').toBeGreaterThan(0)

    // Walks are scheduled, not synchronous: ending the window at the last drag
    // would undercount the build that schedules more of them.
    await page.waitForTimeout(10_000)
    const after = await sampleWalks(request)
    const drift = await shapePosition(page, target)

    console.log(`RESULT ${JSON.stringify({
      label: LABEL,
      // The denominator. Quoting anything below without this line is the error
      // this spec was revised to prevent — see `datasetScale`.
      dataset: scale,
      drags: DRAGS,
      effectiveDrags: effective,
      renames,
      walksDuringEditing: after.walks - before.walks,
      walkSecondsDuringEditing: Number((after.walkSeconds - before.walkSeconds).toFixed(3)),
      // Beware n=1: the boot walk is often the ONLY sample in the process, in
      // which case p50/p99/max are all that single value and none of them is a
      // distribution. Cross-check with `maplespire_docscope_walks_total`.
      walksTotalInProcess: after.walks,
      p99Seconds: after.p99,
      maxSeconds: after.max,
      netDrift: { x: drift.x - origin.x, y: drift.y - origin.y },
    })}`)
  })
})
