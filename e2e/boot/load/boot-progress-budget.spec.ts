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
 * A boot document's allowance is counted from the SERVICE, not from the
 * REQUEST: no find ceiling may be charged while the socket is delivering.
 *
 * ── The failure mode, in one sentence ────────────────────────────────────────
 * `resolveInBatches` issues registry shards three at a time and the sync server
 * generates sync messages for ONE document at a time, so three 3 000 ms find
 * ceilings (`repo.ts`: `BOOT_DOCUMENT_TRIES` 3, `BOOT_DOCUMENT_FIND_TIMEOUT_MS`
 * 3 000, `BOOT_DOCUMENT_DELAY_MS` 500) counted from the request would run in
 * parallel over a multi-MB batch while the socket is busy delivering that
 * batch's other members — abandoning a document for taking too long while
 * receiving half a megabyte down the same socket.
 *
 * ── Why this is not `joiner-rush.spec.ts` ────────────────────────────────────
 * The rush asserts the LAGGING indicator: everybody painted. This asserts the
 * LEADING one, and that difference is the whole reason it is worth a second
 * rush. Measured on a ~6.7 MB-boot workspace at 8 joiners, with ceilings
 * counted from the request (16 boots):
 *
 *   97 charged ceilings, EVERY boot >= 2 (min 2, max 10), and all sixteen boots
 *   painted anyway — nine of them on their last attempt of three.
 *
 * A gate that only watches the canvas reports green on that build, which is one
 * slow day away from failing. Counted from the service, same target and load:
 * **0 charged**, 32/32 painted.
 *
 * ── THE ORACLE IS THE console.warn, AND THE MARK SHAPE IS NOT ────────────────
 * The tempting predicate is "a `boot.document.retry` mark with
 * `cause: 'ceiling'` and no `progressBytes`". It is WRONG, and it is wrong in
 * the direction that fails a correct build:
 *
 *   `productive` (`handleRetry.ts`) is `maxBudgetMs !== null && hardRemainingMs()
 *   > 0 && connectedPeerCount() > 0`. It does NOT mention `deliveredBytes`.
 *
 * So a window under `MIN_PROGRESS_BYTES_PER_SECOND` is refunded — attempt given
 * back — while `markRetry(..., deliveredBytes || undefined)` writes no
 * `progressBytes` and `normalizedDetails` strips the key. The mark then looks
 * exactly like a charged one. Measured: 102 ceiling marks over 8 boots, 66 of
 * them byte-less, and ZERO of them charged.
 *
 * What separates the two is which BRANCH ran, and the charged branch is the
 * only one that speaks: `console.warn('[handleRetry] find ceiling …')` sits
 * after the `continue` of the productive block. So it fires once per attempt
 * actually spent, on both revisions, and it is plain production code — not
 * gated on DEV, not bounded by `RETRY_MARK_LIMIT`, not evictable from the
 * timeline ring. It is a strictly better witness than the surface built for
 * the purpose, which is worth remembering the next time one is built.
 *
 *   E2E_RUSH_LANDSCAPE=<id> npx playwright test --project=boot-load \
 *     boot-progress-budget.spec.ts
 *
 * `E2E_RUSH_LANDSCAPE` is shared with `joiner-rush.spec.ts` — one stack has one
 * heaviest workspace — and REQUIRED for the same reason: on `slope-a` (631 kB,
 * 3 registry shards) nothing queues behind anything, no window ever expires,
 * and this gate would go green over a straight revert. `cd server && npm run
 * fsck` prints `boot … kB` per workspace; name the biggest.
 */
import { test, expect, type Browser, type Page } from '@playwright/test'

const DEV_EMAIL = process.env.E2E_DEV_EMAIL ?? 'admin@example.com'
/** 8 because 8 is what was measured. The pressure is not decoration: the
 * charged ceilings come from documents queued behind OTHER clients' documents
 * on a server that serves them one at a time, and at one joiner there is
 * nothing to queue behind. */
const JOINERS = Math.max(2, Number(process.env.E2E_BUDGET_JOINERS ?? 8))
const TARGET = process.env.E2E_RUSH_LANDSCAPE ?? ''
/** Same floor, same reason, same env var as the sibling rush: it is a property
 * of the target, not of the gate. */
const MIN_BOOT_KB = Math.max(0, Number(process.env.E2E_RUSH_MIN_BOOT_KB ?? 4_000))

/** THE SUBJECT'S WITNESS. Emitted once per ceiling that really cost an
 * attempt — `handleRetry.ts`, immediately after the productive branch has
 * `continue`d past it. Kept as a source-shaped regex so a reworded message
 * fails this gate loudly instead of silently zeroing it. */
const CHARGED_CEILING = /\[handleRetry\] find ceiling (\d+)ms fired for (\S+) \(attempt (\d+)\/(\d+)\)/

interface RetryMark {
  cause?: unknown
  progressBytes?: unknown
  [key: string]: unknown
}

interface ProgressCounters {
  extended: number
  extendedBytes: number
  stallEnded: number
  hardCapped: number
  maxExtendedMs: number
}

interface JoinerReport {
  index: number
  outcome: 'canvas' | 'failed' | 'timeout'
  detail: string
  bytes: number
  /** Ceilings that really spent an attempt, from the console. THE SUBJECT. */
  charged: string[]
  /** Did the timeline surface answer at all? False means the census is unreadable. */
  instrumented: boolean
  /** Entries the 500-entry ring evicted DURING the measured switch. */
  dropped: number
  marks: RetryMark[]
  /** `null` on any build predating #37ter — reported, never defaulted to zero. */
  progress: ProgressCounters | null
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  const email = page.getByTestId('dev-login-email')
  const landed = await Promise.race([
    email.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'form' as const),
    page.waitForURL('**/app/**', { timeout: 30_000 }).then(() => 'app' as const),
  ]).catch(() => 'form' as const)
  if (landed === 'form') {
    const legal = page.getByTestId('legal-acceptance')
    if (await legal.count()) await legal.check().catch(() => {})
    await email.fill(DEV_EMAIL)
    await email.press('Enter')
    await page.waitForURL('**/app/**', { timeout: 60_000 })
  }
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => Array.isArray((window as any).__modelStore?.getState?.().diagrams),
    undefined,
    { timeout: 90_000 },
  )
}

/** Through the REAL navigation menu, never a `goto` to the target route
 * (a route entered by `page.goto` is not the route a user
 * enters, and a whole defect was once misattributed to a flag over it). */
async function switchLandscape(page: Page, landscapeId: string): Promise<void> {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('workspace-landscapes').click()
  await page.locator(`[data-testid="landscape-switch"][data-landscape-id="${landscapeId}"]`)
    .click({ timeout: 30_000 })
}

/**
 * Zero the mark census between the sign-in boot and the measured one.
 *
 * A joiner boots the DEFAULT workspace on sign-in and only then switches to the
 * target, so without this every mark and every counter would carry two
 * workspaces fused together and the census would name the wrong one. Resetting
 * is exact where diffing would not be: the ring can evict across the boundary,
 * and the progress counters carry no sequence number to diff on. The console
 * subject is scoped the same way, by a flag flipped on the same line.
 *
 * It touches the INSTRUMENT and never the application — no store read, no store
 * write. The UI below is driven exactly as a user drives it.
 */
async function resetInstruments(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const diagnostics = (window as unknown as {
      __maplespireDiagnostics?: { resetTimeline?: () => void; resetProgress?: () => void }
    }).__maplespireDiagnostics
    if (typeof diagnostics?.resetTimeline !== 'function') return false
    diagnostics.resetTimeline()
    // Optional on purpose: absent on older builds. The report
    // then carries `progress: null`, which the assertions read as "this
    // revision has no such counters" rather than as a zero.
    diagnostics.resetProgress?.()
    return true
  })
}

async function readBudget(page: Page): Promise<{
  dropped: number
  marks: RetryMark[]
  progress: ProgressCounters | null
}> {
  return page.evaluate(() => {
    const diagnostics = (window as unknown as {
      __maplespireDiagnostics?: {
        timeline?: () => {
          droppedEntries: number
          entries: { name: string; details: Record<string, unknown> }[]
        }
        progress?: () => {
          extended: number
          extendedBytes: number
          stallEnded: number
          hardCapped: number
          maxExtendedMs: number
        }
      }
    }).__maplespireDiagnostics
    const snapshot = diagnostics?.timeline?.()
    return {
      dropped: snapshot?.droppedEntries ?? 0,
      marks: (snapshot?.entries ?? [])
        .filter((entry) => entry.name === 'boot.document.retry')
        .map((entry) => entry.details),
      progress: diagnostics?.progress?.() ?? null,
    }
  })
}

/** Every expired window, charged or refunded. The ARMING witness, and
 * deliberately not the subject: see the header on why the mark shape cannot
 * tell the two apart. */
const isCeiling = (mark: RetryMark): boolean => mark.cause === 'ceiling'

async function joinerBoots(browser: Browser, landscapeId: string, index: number): Promise<JoinerReport> {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    // MEASURED, not declared — the anti-vacuity guard on load. `framereceived`
    // fires on the Automerge socket, which is where the boot set travels.
    let bytes = 0
    page.on('websocket', (ws) => {
      if (!/\/automerge/.test(ws.url())) return
      ws.on('framereceived', (frame) => { bytes += frame.payload.length })
    })
    // Attached at page creation so nothing can be missed, gated so nothing from
    // the sign-in boot of the DEFAULT workspace is attributed to the target.
    const charged: string[] = []
    let counting = false
    page.on('console', (message) => {
      if (!counting) return
      const text = message.text()
      if (CHARGED_CEILING.test(text)) charged.push(text.slice(0, 200))
    })
    // The CLASSIC boot: the whole model is materialised through
    // `BOOT_DOCUMENT_RESOLUTION`, which is the path the allowance is spent on.
    // Under `bootFromServer` the store holds the active diagram alone and the
    // batch that produced the defect is never issued at all.
    await page.addInitScript(() => {
      localStorage.setItem('maplespire:bootFromServer', 'false')
      localStorage.setItem('maplespire:serverReadModel', 'false')
    })
    await signIn(page)
    const instrumented = await resetInstruments(page)
    counting = true
    await switchLandscape(page, landscapeId)

    // The oracle NAMES the workspace whose bridge finished booting before it
    // waits for a `<canvas>`: the previous landscape's canvas stays mounted for
    // the first frames of a switch, and both sibling specs were bitten by
    // resolving on it.
    const booted = page.locator('#sync-status')
      .and(page.locator(`[data-projected-workspace^="${landscapeId}/"]`))
    const failure = page.getByTestId('canvas-boot-error-detail')
    const outcome = await Promise.race([
      booted.waitFor({ state: 'attached', timeout: 180_000 })
        .then(() => page.locator('canvas').first().waitFor({ state: 'visible', timeout: 30_000 }))
        .then(() => 'canvas' as const),
      failure.waitFor({ state: 'visible', timeout: 180_000 }).then(() => 'failed' as const),
    ]).catch(() => 'timeout' as const)

    // Read BEFORE the context closes, and on EVERY outcome: a joiner that died
    // carries the most informative census of the run.
    const detail = outcome === 'failed' ? await failure.innerText().catch(() => '') : ''
    const budget = await readBudget(page)
      .catch(() => ({ dropped: 0, marks: [] as RetryMark[], progress: null }))
    return { index, outcome, detail, bytes, charged, instrumented, ...budget }
  } finally {
    await context.close()
  }
}

test.describe('#37ter the boot allowance is counted from the service', () => {
  test(`${JOINERS} clients rush one landscape, and no window is charged while the server is serving it`, async ({ browser }) => {
    test.setTimeout(600_000)

    expect(
      TARGET,
      'E2E_RUSH_LANDSCAPE must NAME the heaviest workspace on this stack'
      + ' (cd server && npm run fsck, then read the `boot … kB` column).'
      + ' On a light landscape nothing queues behind anything, no find ceiling ever expires,'
      + ' and this gate reports green over a straight revert of #37ter.',
    ).toBeTruthy()
    const landscapeId = TARGET

    // All at once, on purpose: sequentially each of these boots passes, and the
    // contention is the subject.
    const reports = await Promise.all(
      Array.from({ length: JOINERS }, (_, index) => joinerBoots(browser, landscapeId, index)),
    )

    const census = reports.map((report) => ({
      joiner: report.index,
      outcome: report.outcome,
      kb: Math.round(report.bytes / 1024),
      charged: report.charged.length,
      ceilings: report.marks.filter(isCeiling).length,
      dropped: report.dropped,
      progress: report.progress,
    }))
    const printed = JSON.stringify(census)
    // Printed on SUCCESS too, and that is the point: a green tick says the
    // subject held, never how hard it was pressed. `ceilings` is how much the
    // mechanism was actually exercised and `maxExtendedMs` against
    // `BOOT_RESOLVE_MAX_MS` is the margin `progressTelemetry.ts` says to read
    // as a maximum — the reading that moves BEFORE any boot fails.
    console.log(`[#37ter census] ${printed}`)

    // ── Void guards, all BEFORE the subject ──────────────────────────────────
    // A green subject on a run that measured nothing is the worse outcome: it
    // reads as a pass. Each guard below makes such a run RED instead.

    // 1. The mark census answered at all. The subject below comes off the
    //    console and does not need it, but the ARMING witness does, and an
    //    absent instrument would make "no ceiling fired" unfalsifiable.
    expect(
      reports.filter((report) => !report.instrumented).map((report) => report.index),
      'these joiners had no __maplespireDiagnostics.timeline, so their mark census is empty for a reason'
      + ' that has nothing to do with the budget, and the arming witness below cannot be read. The'
      + ' surface needs DEV or VITE_CLIENT_PERF_DIAGNOSTICS=true; run this against the dev server.',
    ).toEqual([])

    // 2. The 500-entry ring evicted nothing it was supposed to count. It bounds
    //    the arming witness only — an under-count there fails this gate rather
    //    than passing it — but a run that cannot say whether it armed is void,
    //    and saying so beats letting the reader assume.
    expect(
      reports.filter((report) => report.dropped > 0)
        .map((report) => ({ joiner: report.index, dropped: report.dropped })),
      'the client timeline overflowed its 500-entry ring on these joiners, so the ceiling census is'
      + ` truncated and this run cannot state whether the mechanism armed. VOID, not green. ${printed}`,
    ).toEqual([])

    // 3. The rush really moved a boot set. As in `joiner-rush.spec.ts`: the
    //    first guard stops the target being unnamed, this one stops it being
    //    named and small.
    const heaviestKb = Math.round(Math.max(...reports.map((report) => report.bytes)) / 1024)
    expect(
      heaviestKb,
      `the rush moved only ${heaviestKb} kB into ${landscapeId}: too light to queue documents behind one`
      + ' another on a server that serves them one at a time. Name a heavier workspace, or lower'
      + ` E2E_RUSH_MIN_BOOT_KB on purpose. ${printed}`,
    ).toBeGreaterThanOrEqual(MIN_BOOT_KB)

    // 4. THE ARMING WITNESS, and the one that matters most here. A find ceiling
    //    has to have actually expired somewhere, or "none was charged" is the
    //    trivial truth about a run where none fired. Revision-independent: the
    //    pre-fix code marks the same expiries, and charges every one of them.
    const ceilings = reports.reduce((total, report) => total + report.marks.filter(isCeiling).length, 0)
    expect(
      ceilings,
      `not one find ceiling expired across ${JOINERS} joiners, so nothing was ever at risk of being charged`
      + ' and this run cannot tell #37ter from its revert. Raise E2E_BUDGET_JOINERS or name a heavier'
      + ' workspace: 51 boots of 51 blew at least one 3 s window on the 2 395 377-byte registry shard when'
      + ` this was measured. ${printed}`,
    ).toBeGreaterThan(0)

    // ── The lagging indicator: what a user sees ──────────────────────────────
    const casualties = reports.filter((report) => report.outcome !== 'canvas')
      .map((report) => ({ joiner: report.index, outcome: report.outcome, detail: report.detail }))
    expect(
      casualties,
      `joiners that never painted (heaviest boot ${heaviestKb} kB): ${JSON.stringify(casualties)} ${printed}`,
    ).toEqual([])

    // ── THE SUBJECT: the leading indicator ───────────────────────────────────
    // Asserted after the canvas on purpose. All sixteen pre-fix boots that
    // produced the 97 charges PAINTED; the charges are what said the margin was
    // gone, one slow day before the deaths.
    const chargedLines = reports.flatMap((report) =>
      report.charged.map((line) => ({ joiner: report.index, line })))
    expect(
      chargedLines,
      `${chargedLines.length} find ceiling(s) were CHARGED an attempt across ${JOINERS} joiners: the window`
      + ' expired with the transport not delivering, or with no connected peer. Each one spends 1 of the 3'
      + ' attempts a boot document gets, and pre-#37ter this stood at 97 across 16 boots with every boot'
      + ' >= 2 — all of which painted anyway, nine on their last attempt. Post-fix it was 0 across 24.'
      + ` ${JSON.stringify(chargedLines)} ${printed}`,
    ).toEqual([])

    // ── Corroboration from the INDEPENDENT surface ───────────────────────────
    // The subject is a console line; this is the in-page counter set, reached
    // through a different path, and it is what says the REFUND BRANCH ran
    // rather than that no ceiling was ever reached. A number confirmed only by
    // re-running its own probe is the trap this repository keeps falling into.
    const progress = reports.map((report) => report.progress)
      .filter((value): value is ProgressCounters => value !== null)
    expect(
      progress.length,
      'no joiner exposed __maplespireDiagnostics.progress, which is the #37ter counter set. Either this'
      + ' build predates the fix — in which case the subject above should already be red — or the'
      + ` diagnostics surface changed shape and this corroboration has stopped corroborating. ${printed}`,
    ).toBe(reports.length)
    expect(
      progress.reduce((total, counters) => total + counters.extended, 0),
      'ceilings expired and none was charged, yet the extension counter never moved: no window was ever'
      + ' refunded WITH bytes behind it, so the two surfaces disagree about what happened and the run'
      + ` cannot be believed either way. ${printed}`,
    ).toBeGreaterThan(0)
    expect(
      progress.filter((counters) => counters.hardCapped > 0),
      'a boot document hit the ABSOLUTE wall while the transport was still delivering. This is the one'
      + ' reading no client setting fixes: the deployment needs longer to serve this workspace than any'
      + ` client should wait. ${printed}`,
    ).toEqual([])
  })
})
