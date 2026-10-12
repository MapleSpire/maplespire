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
 * A boot whose SOCKET FALLS mid-flight, and comes back.
 *
 * ── The mechanism, in the six lines that matter (trace before the fix) ───────
 *   t=15 339  CLOSE:1006                            the pipe lets go
 *   t=15 340  attempt 2  REJECT  waived: false      1 ms later
 *   t=15 845  attempt 3  REJECT  waived: false
 *   t=15 846  "… is unavailable after 3 attempt(s)" the boot dies
 *   t=15 858  OPEN                                  519 ms after the fall
 *   t=15 875  peer                                  29 ms AFTER the boot gave up
 *
 * `budgetMs` (24 000 ms) was never approached and the server never once said
 * `doc-unavailable`: the unavailability was concluded LOCALLY, from
 * `peers.size === 0`. So the fault to inject is not "make it slow", it is
 * "take the socket away and give it back late".
 *
 * ── Why the rate cannot be the proof ─────────────────────────────────────────
 * The natural failure rate in the joiner rush is low (about 1 in 49, 95 % CI
 * [0,4 % – 10,7 %], Wilson); bounding it under 5 % by the rate alone would
 * need 0/60, an hour of wall that would still say nothing about the
 * mechanism. This gate is a SWITCH: the fault is injected, so the run is red
 * or green, never "probably".
 *
 * ── Why not CDP throttling ───────────────────────────────────────────────────
 * Throttling the downlink to 180–350 kB/s does make the socket fall, but such
 * a gate cannot go GREEN, for a reason unrelated to the waiver: the boot set
 * arrives as ATOMIC WebSocket frames, the largest about 1,5–2,4 MB. At
 * 350 kB/s such a frame needs ~7 s of uninterrupted socket life, at 180 kB/s
 * ~13 s, and a socket that dies part-way restarts it from ZERO. Patience
 * cannot fix a transfer that never finishes; that is a frame-size problem,
 * not a waiver problem.
 *
 * CDP throttling and `routeWebSocket` are also mutually exclusive here: the
 * routed socket is dialled by the Playwright server, not by the browser, so
 * `Network.emulateNetworkConditions` does not apply to it.
 *
 * ── What this proves, and what it does NOT ───────────────────────────────────
 * Like `boot-document-unavailable.spec.ts`'s `socket.hold()`, this is an
 * INJECTED FAULT that makes an otherwise rare path deterministic. It shows the
 * waiver handles reconnection. It does NOT show that joiner-rush failures go
 * through this path: instrumented rush boots produced ZERO abnormal socket
 * closes, and the server's back-pressure counters never moved.
 *
 *   E2E_FALL_LANDSCAPE=<id> npx playwright test --project=boot-load \
 *     boot-socket-fall.spec.ts
 *
 * `E2E_FALL_LANDSCAPE` is REQUIRED. Same ruling as `joiner-rush.spec.ts`: a
 * landscape small enough to finish before the fall injects nothing at all.
 * `cd server && npm run fsck` prints `boot … kB` per workspace; name the
 * biggest.
 */
import { test, expect, type Page } from '@playwright/test'

const DEV_EMAIL = process.env.E2E_DEV_EMAIL ?? 'admin@example.com'
const TARGET = process.env.E2E_FALL_LANDSCAPE ?? ''

/**
 * When to take the socket away: after this many bytes of the target's boot set
 * have reached the page. 1,5 MB is past the six 64 kB shards and into the
 * 262 kB ones, so several `find()`s are outstanding — which is the condition
 * that turns a lost peer into a rejection.
 */
const FALL_AFTER_BYTES = Math.max(1, Number(process.env.E2E_FALL_AFTER_BYTES ?? 1_500_000))

/**
 * How long the REPLACEMENT socket's server frames are withheld, counted from
 * the moment it opens. Both margins are arithmetic, not taste:
 *
 *   pre-fix, the three attempts are spent at ~0, ~500 and ~1 000 ms after the
 *   fall (`tries: 3`, `delayMs: 500`, rejections in under a millisecond), and
 *   the boot is dead at ~1 000;
 *   post-fix, the waiver may wait up to WAIVER_BUDGET_MS = 2 000 ms.
 *
 * The peer therefore has to come back strictly between those, and it comes
 * back at `reconnectDelayMs(1011, 0)` + this = 375–625 + 900 = 1 275–1 525 ms.
 * Roughly 300 ms of margin below, 500 ms above.
 */
const PEER_RETURNS_AFTER_MS = Math.max(0, Number(process.env.E2E_FALL_HOLD_MS ?? 900))

/** `networkRoute.ts` puts `landscapeId=` on the socket url, and the server's
 * routing depends on it — so every socket can be attributed to the workspace
 * it belongs to. Counting globally would let the anti-vacuity guard be
 * satisfied by the PREVIOUS landscape's socket. */
function workspaceOf(url: string): string {
  try {
    return new URL(url).searchParams.get('landscapeId') ?? ''
  } catch {
    return ''
  }
}

interface InjectedFall {
  ready: Promise<void>
  /** Did the fall actually happen, on the target's socket? */
  fell: () => boolean
  /** Frames withheld from the REPLACEMENT socket. */
  heldFrames: () => number
  bytesBeforeFall: () => number
}

/**
 * Take the target workspace's socket away once, mid-boot, and give it back
 * late.
 *
 * Installed BEFORE the first navigation on purpose: `page.routeWebSocket` is
 * delivered through a document-start init script, so a route installed after
 * the page loaded never sees the sockets that page opens. The sibling spec
 * shipped that mistake once and BOTH its tests passed vacuously.
 */
function injectSocketFall(page: Page, workspace: string): InjectedFall {
  let sockets = 0
  let bytes = 0
  let fell = false
  let held = 0
  const ready = page.routeWebSocket(/\/automerge/, (ws) => {
    const server = ws.connectToServer()
    // Page → server is forwarded automatically; server → page is ours as soon
    // as we register a handler, so every branch below must send it on.
    if (workspaceOf(ws.url()) !== workspace) {
      server.onMessage((message) => ws.send(message))
      return
    }
    sockets += 1
    if (sockets === 1) {
      server.onMessage((message) => {
        ws.send(message)
        bytes += message.length
        if (fell || bytes < FALL_AFTER_BYTES) return
        fell = true
        // 1011, not 1000: the adapter treats 1012/1013 as a fast service
        // handoff and everything else as an outage, so this takes the same
        // reconnect cadence a real 1006 does — 375 to 625 ms.
        ws.close({ code: 1011, reason: 'injected mid-boot socket fall' })
      })
      return
    }
    if (sockets > 2) {
      server.onMessage((message) => ws.send(message))
      return
    }
    // THE replacement socket. Everything the server says — the `peer` answer
    // first of all — is withheld, so the peer comes back after the pre-fix
    // schedule has already given up and before the waiver's allowance runs out.
    const queued: (string | Buffer)[] = []
    let holding = true
    server.onMessage((message) => {
      if (!holding) { ws.send(message); return }
      held += 1
      queued.push(message)
    })
    setTimeout(() => {
      holding = false
      for (const message of queued.splice(0)) ws.send(message)
    }, PEER_RETURNS_AFTER_MS)
  })
  return {
    ready,
    fell: () => fell,
    heldFrames: () => held,
    bytesBeforeFall: () => bytes,
  }
}

/** Close codes, read from INSIDE the page: Playwright's own `websocket` event
 * reports that a socket closed and not with which code, and the code is the
 * whole anti-vacuity question — 1000 is the app deliberately closing the
 * PREVIOUS workspace's socket at every switch. This observes and never drives:
 * the UI is exercised exactly as a user exercises it. */
async function armSocketWatch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as {
      WebSocket: typeof WebSocket
      __ms37sockets?: { closes: number[]; bytes: number }
    }
    const state = { closes: [] as number[], bytes: 0 }
    target.__ms37sockets = state
    const Native = target.WebSocket
    const Wrapped = function (this: unknown, ...args: [string, (string | string[])?]) {
      const socket = new Native(...args)
      if (/\/automerge/.test(String(socket.url ?? ''))) {
        socket.addEventListener('close', (event) => { state.closes.push((event as CloseEvent).code) })
        socket.addEventListener('message', (event) => {
          const data = (event as MessageEvent).data as ArrayBuffer | string | undefined
          state.bytes += typeof data === 'string' ? data.length : (data?.byteLength ?? 0)
        })
      }
      return socket
    } as unknown as typeof WebSocket
    Wrapped.prototype = Native.prototype
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) {
      (Wrapped as unknown as Record<string, unknown>)[key] = Native[key]
    }
    target.WebSocket = Wrapped
  })
}

async function readSockets(page: Page): Promise<{ closes: number[]; bytes: number }> {
  return page.evaluate(() => (window as unknown as {
    __ms37sockets?: { closes: number[]; bytes: number }
  }).__ms37sockets ?? { closes: [], bytes: 0 })
}

/**
 * The `boot.document.retry` marks, out of the app's own diagnostics surface —
 * document, attempt, cause (`ceiling` or `reject`), whether it was WAIVED, and
 * since R1c the transport phase and close code underneath it.
 *
 * They go into the failure messages rather than into an assertion. This gate
 * asserts on what a user sees; the marks are what tells the reader WHY, and a
 * gate that had to be re-run under a probe to be understood is a gate that
 * costs an afternoon.
 */
async function retryMarks(page: Page): Promise<unknown[]> {
  return page.evaluate(() => {
    const diagnostics = (window as unknown as {
      __maplespireDiagnostics?: { timeline?: () => { entries: { name: string; details: unknown }[] } }
    }).__maplespireDiagnostics
    const entries = diagnostics?.timeline?.().entries ?? []
    return entries.filter((entry) => entry.name === 'boot.document.retry').map((entry) => entry.details)
  })
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

test.describe('#37bis a boot whose socket falls and comes back', () => {
  test('the socket is taken away mid-boot and returned late: the canvas still appears', async ({ page }) => {
    test.setTimeout(600_000)

    expect(
      TARGET,
      'E2E_FALL_LANDSCAPE must NAME the heaviest workspace on this stack'
      + ' (cd server && npm run fsck, then read the `boot … kB` column).'
      + ' A landscape that finishes before the fall injects no fault at all.',
    ).toBeTruthy()

    const fall = injectSocketFall(page, TARGET)
    await fall.ready
    await armSocketWatch(page)
    // The CLASSIC boot — the path the defect lives on: the whole model is
    // materialised through `BOOT_DOCUMENT_RESOLUTION`.
    await page.addInitScript(() => {
      localStorage.setItem('maplespire:bootFromServer', 'false')
      localStorage.setItem('maplespire:serverReadModel', 'false')
    })
    await signIn(page)
    await switchLandscape(page, TARGET)

    // The oracle NAMES the workspace whose bridge finished booting, then waits
    // for a real `<canvas>`. Waiting on `canvas` alone resolves on the PREVIOUS
    // landscape's canvas, still mounted for the first frames of a switch — the
    // sibling spec was bitten by exactly that.
    const booted = page.locator('#sync-status')
      .and(page.locator(`[data-projected-workspace^="${TARGET}/"]`))
    const failure = page.getByTestId('canvas-boot-error-detail')
    const outcome = await Promise.race([
      booted.waitFor({ state: 'attached', timeout: 300_000 })
        .then(() => page.locator('canvas').first().waitFor({ state: 'visible', timeout: 60_000 }))
        .then(() => 'canvas' as const),
      failure.waitFor({ state: 'visible', timeout: 300_000 }).then(() => 'failed' as const),
    ]).catch(() => 'timeout' as const)

    const detail = outcome === 'failed' ? await failure.innerText().catch(() => '') : ''
    const sockets = await readSockets(page)
    const bootKb = Math.round(sockets.bytes / 1024)
    const marks = await retryMarks(page)

    // ── ANTI-VACUITY on the fault ────────────────────────────────────────────
    // Checked BEFORE the subject, because a green subject on an un-injected
    // fault is the worse outcome: it reads as a pass. Three independent
    // witnesses, one per half of the injection.
    expect(
      fall.fell(),
      `the target's socket was never taken away (${fall.bytesBeforeFall()} bytes seen on it;`
      + ` E2E_FALL_AFTER_BYTES is ${FALL_AFTER_BYTES}). Lower it, or name a heavier landscape.`,
    ).toBe(true)
    expect(
      sockets.closes.filter((code) => code !== 1000),
      `the page never SAW an abnormal close (codes: ${JSON.stringify(sockets.closes)});`
      + ' code 1000 is the deliberate close of the previous workspace at the switch.',
    ).not.toEqual([])
    expect(
      fall.heldFrames(),
      'the replacement socket was never held, so the peer came back at once and nothing was tested',
    ).toBeGreaterThan(0)
    // The fault has to reach the RESOLVER, not merely the socket. A fall that
    // lands while no `find()` is outstanding produces no rejection at all, and
    // the boot then survives on any revision — a green run that measured
    // nothing. This is the witness that the mechanism under test actually ran.
    expect(
      marks,
      `the socket fell but no document resolution noticed: no boot.document.retry mark.`
      + ` Nothing was waived because nothing was rejected, so this run cannot distinguish`
      + ` any revision from any other. Move E2E_FALL_AFTER_BYTES (now ${FALL_AFTER_BYTES})`
      + ` to an instant when documents are in flight.`,
    ).not.toEqual([])

    // ── The subject ──────────────────────────────────────────────────────────
    // Without the waiver the three attempts are spent by ~1 000 ms and this
    // ends in "failed", naming the document that was in flight.
    expect(
      outcome,
      `the boot of ${TARGET} ended in "${outcome}" after ${bootKb} kB`
      + ` (close codes ${JSON.stringify(sockets.closes)}) ${detail}`
      + ` — retry marks: ${JSON.stringify(marks)}`,
    ).toBe('canvas')

    // ── It was the WAIVER, not a recovery ────────────────────────────────────
    // Without this, "the boot survived" cannot be told from "the boot died and
    // something rescued it". Nothing here ever clicks Réessayer, so a panel that
    // appeared at any point would mean the boot really did die.
    expect(
      await page.getByTestId('canvas-boot-error').count(),
      'the named failure panel appeared: the boot died and something else recovered it',
    ).toBe(0)
  })
})
