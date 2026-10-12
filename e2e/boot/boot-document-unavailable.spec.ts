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
 * A CLASSIC boot must not die on a document while the user is told nothing.
 *
 * Measured on a 3 000-diagram landscape with eight concurrent clients: some
 * boots died with `DocumentTemporarilyUnavailableError` on the workspace ROOT,
 * a document present in the database. Every such `unavailable` rejection of
 * the root happened with `repo.peers.length === 0`, ONE adapter attached,
 * `isReady()` false and `navigator.onLine` true, and in every case the peer
 * handshake landed 1 to 683 ms AFTER the rejection. The rejection is not a
 * verdict about the document. It is "nobody is here to answer yet", and must
 * not be counted as a consumed attempt.
 *
 * That is what this spec reproduces deterministically, at the transport level:
 * the workspace socket connects, the client's `join` reaches the server, and
 * the server's `peer` reply is WITHELD for a chosen window. The client then
 * sees exactly the measured state — an open socket, no peer.
 *
 * Both tests navigate through the REAL landscape menu. Never `page.goto` to the
 * target route: a direct `goto` can settle in states real navigation does not.
 */
import { test, expect, type Page } from '@playwright/test'

const DEV_EMAIL = process.env.E2E_DEV_EMAIL ?? 'admin@example.com'

/**
 * A switch you can hold: while `hold()` is on, EVERY server→page frame of an
 * Automerge socket is queued, and `release()` lets them through in order.
 *
 * Only that direction is intercepted, so the socket really opens, the client's
 * `join` really reaches the server, and what the client is left without is the
 * `peer` answer — i.e. `repo.peers.length === 0` with the adapter mid-handshake
 * and NO failed connection attempt. (Every server frame is queued, not just the
 * `peer` answer; the resulting CONDITION — open socket, zero peers — is the
 * measured one.) CLOSING the socket instead would be a different
 * fault: a failed connection attempt, which is how "the server is down" reads,
 * and which must stay a FAST failure — see T4/T4b in handleRetry.test.ts.
 *
 * Counted PER WORKSPACE, and that is not bookkeeping. A global counter over
 * every socket matching `/automerge` would include the one the previous
 * landscape opened at sign-in, so a run that injected no fault on the target
 * could still satisfy `heldFrames() > 0` out of the OLD socket's frames.
 *
 * `ws.url()` carries `landscapeId=` (`networkRoute.ts` puts it there, and the
 * server's routing depends on it), so each socket can be attributed to the
 * workspace it belongs to.
 *
 * Installed BEFORE the first navigation on purpose. `page.routeWebSocket` is
 * delivered through a document-start init script, so a route installed after
 * the page loaded never sees the sockets that page opens — both tests would
 * then pass vacuously.
 */
function holdablePeerHandshake(page: Page) {
  let holding = false
  /** landscapeId → frames queued for THAT workspace's socket. */
  const heldByWorkspace = new Map<string, number>()
  /** landscapeId → when its first frame was queued, in this process's clock. */
  const heldSinceByWorkspace = new Map<string, number>()
  const workspaceOf = (url: string): string => {
    try {
      return new URL(url).searchParams.get('landscapeId') ?? ''
    } catch {
      return ''
    }
  }
  const install = page.routeWebSocket(/\/automerge/, (ws) => {
    const workspace = workspaceOf(ws.url())
    const server = ws.connectToServer()
    const queued: (string | Buffer)[] = []
    const drain = () => { for (const message of queued.splice(0)) ws.send(message) }
    server.onMessage((message) => {
      if (!holding) { ws.send(message); return }
      heldByWorkspace.set(workspace, (heldByWorkspace.get(workspace) ?? 0) + 1)
      if (!heldSinceByWorkspace.has(workspace)) heldSinceByWorkspace.set(workspace, Date.now())
      queued.push(message)
    })
    const pump = setInterval(() => { if (!holding) drain() }, 25)
    ws.onClose(() => clearInterval(pump))
  })
  const heldFramesFor = (workspace: string): number => heldByWorkspace.get(workspace) ?? 0
  return {
    ready: install,
    hold: () => { holding = true },
    release: () => { holding = false },
    heldFramesFor,
    /**
     * Release on a SIGNAL, never on a timer started before the navigation: a
     * timer would start counting before menu interactions whose own budget is
     * 20 s, so on a loaded machine the handshake could be free again by the
     * time the switch happened.
     *
     * Here the clock starts when the TARGET workspace's socket has actually
     * had a frame withheld, and a target that never gets one is a LOUD
     * failure rather than a silent pass.
     */
    releaseAfterHeldFor: async (workspace: string, ms: number, timeoutMs = 60_000): Promise<number> => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const since = heldSinceByWorkspace.get(workspace)
        if (since !== undefined && Date.now() - since >= ms) {
          holding = false
          return heldFramesFor(workspace)
        }
        if (Date.now() > deadline) {
          throw new Error(
            `the handshake of ${workspace} was never held: ${heldFramesFor(workspace)} frames queued for it`
            + ` (workspaces seen: ${JSON.stringify([...heldByWorkspace.entries()])})`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    },
  }
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  const email = page.getByTestId('dev-login-email')
  const landed = await Promise.race([
    email.waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'form' as const),
    page.waitForURL('**/app/**', { timeout: 20_000 }).then(() => 'app' as const),
  ]).catch(() => 'form' as const)
  if (landed === 'form') {
    const legal = page.getByTestId('legal-acceptance')
    if (await legal.count()) await legal.check().catch(() => {})
    await email.fill(DEV_EMAIL)
    await email.press('Enter')
    await page.waitForURL('**/app/**', { timeout: 30_000 })
  }
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => Array.isArray((window as any).__modelStore?.getState?.().diagrams),
    undefined,
    { timeout: 45_000 },
  )
}

/**
 * Switch to a landscape this browser profile has never materialized, through
 * the real navigation menu.
 *
 * A never-visited workspace is the point: its root is absent from IndexedDB, so
 * the storage source reports unavailable and the verdict rests entirely on
 * whether a peer answers — the measured condition.
 */
async function switchToUnvisitedLandscape(page: Page): Promise<string> {
  await page.getByTestId('nav-menu').click()
  await page.getByTestId('workspace-landscapes').click()
  const rows = page.getByTestId('landscape-switch')
  await expect(rows.first()).toBeVisible({ timeout: 20_000 })
  const ids = await rows.evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute('data-landscape-id') ?? '',
    active: node.className.includes('text-accent'),
  })))
  const target = ids.find((entry) => !entry.active && entry.id)
  expect(
    target,
    'this stack needs at least two landscapes: the switch is what re-routes the socket',
  ).toBeTruthy()
  await page.locator(`[data-testid="landscape-switch"][data-landscape-id="${target!.id}"]`).click()
  return target!.id
}

/**
 * The boot waiver's live counters, out of the ordinary diagnostics surface
 * (`installClientDiagnostics`, on in DEV). `clipped` is the early-warning
 * reading: a waiver that ran into its cap. Asserting on it here proves the
 * counter actually increments in the real app.
 */
async function waiverCounters(page: Page): Promise<{
  budgetMs: number; granted: number; clipped: number; peerArrived: number
}> {
  return page.evaluate(() => {
    const diagnostics = (window as unknown as {
      __maplespireDiagnostics?: { waiver?: () => Record<string, number> }
    }).__maplespireDiagnostics
    const waiver = diagnostics?.waiver?.() ?? {}
    return {
      budgetMs: Number(waiver.budgetMs ?? -1),
      granted: Number(waiver.granted ?? -1),
      clipped: Number(waiver.clipped ?? -1),
      peerArrived: Number(waiver.peerArrived ?? -1),
    }
  })
}

/** The three mutually exclusive things the editor can be showing. */
async function canvasState(page: Page): Promise<'canvas' | 'named-error' | 'hourglass' | 'none'> {
  if (await page.locator('canvas').count() > 0) return 'canvas'
  if (await page.getByTestId('canvas-boot-error').count() > 0) return 'named-error'
  const text = await page.locator('body').innerText().catch(() => '')
  if (/Chargement…|Loading…/.test(text)) return 'hourglass'
  return 'none'
}

test.describe('#37 a boot that dies on a document', () => {
  test.beforeEach(async ({ page }) => {
    // The defect lives in the CLASSIC boot: the full model is materialized
    // through `BOOT_DOCUMENT_RESOLUTION`. Forced through the localStorage
    // override so the spec runs against any dev stack.
    await page.addInitScript(() => {
      localStorage.setItem('maplespire:bootFromServer', 'false')
      localStorage.setItem('maplespire:serverReadModel', 'false')
    })
  })

  test('a peer that never answers ends in a NAMED failure with a retry that WORKS', async ({ page }) => {
    const socket = holdablePeerHandshake(page)
    await socket.ready
    await signIn(page)

    socket.hold()
    const target = await switchToUnvisitedLandscape(page)

    // The bounded budget must END. What the user sees when it does is the
    // subject: without the failure panel this would be `common.loading`
    // forever — the spinner has no terminating condition on a dead boot,
    // because neither markVisualReady() nor markEditReady() is ever called.
    const panel = page.getByTestId('canvas-boot-error')
    await expect(panel).toBeVisible({ timeout: 60_000 })
    // NAMED: the document id is on screen, so the user can quote it and an
    // operator can grep for it.
    await expect(page.getByTestId('canvas-boot-error-detail')).toContainText(/is unavailable/i)
    const retry = page.getByTestId('canvas-boot-error-retry')
    await expect(retry).toBeVisible()
    expect(await canvasState(page)).toBe('named-error')
    // Did the workload happen, and to the RIGHT socket? Attributed to the
    // target workspace, so the previous landscape's socket — open since
    // sign-in, and also matching `/automerge` — cannot satisfy this.
    expect(
      socket.heldFramesFor(target),
      `the handshake of ${target} was never actually held`,
    ).toBeGreaterThan(0)

    // The early warning fired, in production code, on the real transport: the
    // waiver armed and its CAP is what ended the wait. This is the counter
    // whose whole justification is "we must see it move before users fail",
    // so the e2e watches it move.
    const clippedRun = await waiverCounters(page)
    expect(clippedRun.granted, 'the waiver never armed').toBeGreaterThan(0)
    expect(clippedRun.clipped, 'the cap never clipped a waiver').toBeGreaterThan(0)

    // …and the recovery is CLICKED, not merely visible. The chain it walks —
    // `reloadWorkspace` → `loadWorkspace` → `forgetWorkspace` →
    // `forgetWorkspaceHandles`, which purges the memoized REJECTED root
    // promise — is five links long. A button that is present and inert is the same screen to a user as no
    // button at all.
    socket.release()
    await retry.click()
    await expect(page.locator('#sync-status')).toHaveAttribute(
      'data-projected-workspace', new RegExp(`^${target}/`), { timeout: 90_000 },
    )
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
    expect(await canvasState(page)).toBe('canvas')
  })

  test('a peer that answers LATE still boots: the canvas appears', async ({ page }) => {
    const socket = holdablePeerHandshake(page)
    await socket.ready
    await signIn(page)

    // THE red-before/green-after test, so its fault injection has to be real.
    //
    // The hold is released 3 s after the TARGET's socket first had a frame
    // withheld — not after a timer that started before three menu clicks.
    // The waiver has its own wall, so the hold has to sit inside it or this
    // test would be asserting that the cap does not work. Both margins are
    // deliberately wide: 3 s is three times a naive rejection budget
    // (3 tries × ~500 ms ≈ 1,0–1,5 s measured, so code that counts peerless
    // rejections as attempts is long dead by then) and a full second inside
    // the cap configured below.
    //
    // And the cap is CONFIGURED here rather than defaulted, which makes this
    // the end-to-end cover for the setting: `VITE_BOOT_WAIVER_MS` /
    // `localStorage['maplespire:bootWaiverMs']` has to reach production code,
    // not just `resolveWaiverBudgetMs`. A setting that only its own unit test
    // can see is a setting an operator cannot rely on.
    await page.addInitScript(() => { localStorage.setItem('maplespire:bootWaiverMs', '4000') })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Array.isArray((window as any).__modelStore?.getState?.().diagrams),
      undefined,
      { timeout: 45_000 },
    )
    expect(
      (await waiverCounters(page)).budgetMs,
      'the configured waiver cap never reached the running app',
    ).toBe(4_000)

    socket.hold()
    const target = await switchToUnvisitedLandscape(page)
    const heldForTarget = await socket.releaseAfterHeldFor(target, 3_000)
    expect(
      heldForTarget,
      `the handshake of ${target} was never actually held`,
    ).toBeGreaterThan(0)

    // The oracle names the workspace whose bridge FINISHED booting. Asserting
    // on a `<canvas>` alone would race the previous landscape's canvas, which
    // is still mounted for the first frames of a switch.
    //
    // Raced against the failure panel, because the two outcomes are not
    // interchangeable: a boot that shows the failure panel and is then recovered by the
    // ordinary reconnect proves the RECOVERY works, not that the waiver kept
    // the boot alive — and this test only claims the second.
    const booted = page.locator('#sync-status')
      .and(page.locator(`[data-projected-workspace^="${target}/"]`))
    const outcome = await Promise.race([
      booted.waitFor({ state: 'attached', timeout: 90_000 }).then(() => 'booted' as const),
      page.getByTestId('canvas-boot-error').waitFor({ state: 'visible', timeout: 90_000 })
        .then(() => 'named-error' as const),
    ])
    expect(outcome, 'the waiver did not keep the boot alive: the failure panel appeared').toBe('booted')
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 })
    expect(await canvasState(page)).toBe('canvas')

    // The boot was saved by WAITING, and the counters say so: a peer arrived
    // inside the cap and nothing was clipped. Without this, "the canvas
    // appeared" is compatible with the waiver never having armed at all —
    // which would make this test vacuous.
    const savedRun = await waiverCounters(page)
    expect(savedRun.granted, 'the waiver never armed').toBeGreaterThan(0)
    expect(savedRun.peerArrived, 'no peer ever arrived inside the cap').toBeGreaterThan(0)
    expect(savedRun.clipped, 'the cap clipped a wait this test sized to fit inside it').toBe(0)
  })
})
