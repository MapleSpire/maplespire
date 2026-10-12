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

// The BROWSER arm of the diagram peer bench: K real Chromium contexts on the SAME document
// as the Node peers, at the same instant.
//
//   DIAGRAM_BROWSER_OBSERVERS=2 DIAGRAM_PEER_ID=t1-bench \
//   DIAGRAM_BROWSER_APP=http://localhost:5197 \
//   DIAGRAM_BROWSER_WINDOW_MS=30000 node scripts/verify-diagram-peer-browser.mjs
//
// Normally it is launched BY the fleet coordinator, which supplies the window
// instants so browsers and Node peers share one campaign.
//
// WHY IT IS AN OBSERVER AND NOT A GENERATOR. 100 Chromium contexts do not fit
// on one machine, and they are the noisiest instrument in the repository. In
// the hybrid shape the browsers hold the document and receive the fan-out (so
// they count toward "peers on one document") while the Node peers generate the
// load. The report
// says which is which, in `evaluateHybridCampaign`, so the distinction cannot
// quietly decay into a claim of "100 browsers".
//
// WHAT IS MEASURED IN THE PAGE, and why each choice is forced:
//
//  - NO requestAnimationFrame, anywhere. A rAF poller is starved by exactly the
//    long tasks it would be trying to observe, so it reports quiet
//    during the only moments that matter.
//  - `PerformanceObserver('longtask', { buffered: true })`. `buffered` because
//    the observer attaches after document_start work has already happened, and
//    an entry that predates the attachment is data, not noise.
//  - The WebSocket is wrapped at `document_start` so leg [C] can start at FRAME
//    ARRIVAL rather than at whatever the app chooses to expose. The end of the
//    leg is the end of the TASK that processed the frame — a `setTimeout(…, 0)`
//    scheduled from the message handler runs once the main thread yields, so the
//    difference is the synchronous cost the user actually paid.
//  - An EXTERNAL liveness witness, from Node. An in-page probe cannot observe
//    itself being blocked: a wedged tab records nothing, and "no long task" is
//    byte-identical to "the capture died". Node beats a heartbeat, keeps the
//    gaps, and a gap no long task explains is VOID — never PASS.

import { writeFileSync } from 'node:fs'

import {
  evaluateBrowserArm,
  summarizeObserverFrames,
} from '../qa/diagramBrowserCore.mjs'
import { exitCodeForOutcome } from '../qa/diagramPeersCore.mjs'

const API = (process.env.DIAGRAM_PEER_API ?? 'http://localhost:3021').replace(/\/$/, '')
const APP = (process.env.DIAGRAM_BROWSER_APP ?? 'http://localhost:5197').replace(/\/$/, '')
const OBSERVERS = Math.max(1, Number(process.env.DIAGRAM_BROWSER_OBSERVERS ?? 2))
const LOGIN_EMAIL = process.env.DIAGRAM_PEER_LOGIN_EMAIL ?? 'admin@example.com'
const DIAGRAM_ID = process.env.DIAGRAM_PEER_ID || undefined
const REPORT_PATH = process.env.DIAGRAM_BROWSER_REPORT || undefined
// Absolute instants, so the browser window is the same window the Node peers
// ran. Defaults let the script stand alone for debugging.
const WINDOW_START_AT = Number(process.env.DIAGRAM_BROWSER_START_AT ?? 0)
const WINDOW_MS = Number(process.env.DIAGRAM_BROWSER_WINDOW_MS ?? 30_000)
const HEARTBEAT_MS = Number(process.env.DIAGRAM_BROWSER_HEARTBEAT_MS ?? 250)
// A gap has to be wider than the heartbeat plus its own jitter before it is
// evidence of anything. 4x the interval is deliberately generous: this gate is
// here to catch a DEAD capture, not a busy one.
const LIVENESS_BUDGET_MS = Number(process.env.DIAGRAM_BROWSER_LIVENESS_BUDGET_MS ?? HEARTBEAT_MS * 4)
const HEADLESS = process.env.DIAGRAM_BROWSER_HEADED !== '1'
const CAPTURE = process.env.DIAGRAM_BROWSER_CAPTURE !== 'off'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Everything the page records about itself, installed before any app code runs.
 *
 * Kept as a source string because `addInitScript` serialises it into the page:
 * it must not close over anything from this module.
 */
const IN_PAGE_PROBE = (captureEnabled) => `
(() => {
  const store = {
    // Trap 4: a reload mid-window invalidates every counter below, and the only
    // way to know it happened is to persist the count across the reload.
    navigations: Number(sessionStorage.getItem('__t11navs') || 0) + 1,
    longTasks: [],
    frameProcessingMs: [],
    inboundFrames: 0,
    inboundBytes: 0,
    lastFrameAt: null,
    longTaskCaptureEnabled: false,
    captureEnabled: ${captureEnabled ? 'true' : 'false'},
  }
  sessionStorage.setItem('__t11navs', String(store.navigations))
  window.__t11 = store
  if (!store.captureEnabled) return

  try {
    // buffered: entries that predate this attachment are data, not noise.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        store.longTasks.push({ startMs: entry.startTime, durationMs: entry.duration })
        if (store.longTasks.length > 5000) store.longTasks.shift()
      }
    }).observe({ type: 'longtask', buffered: true })
    store.longTaskCaptureEnabled = true
  } catch {
    // No longtask support is not "no long tasks" — leave the flag false so the
    // run is void rather than silently reporting a quiet main thread.
    store.longTaskCaptureEnabled = false
  }

  // Leg [C] starts at FRAME ARRIVAL. Wrapping the socket is the only way to get
  // that instant without depending on app internals — and this adapter is ours.
  const NativeWebSocket = window.WebSocket
  window.WebSocket = function (url, protocols) {
    const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols)
    socket.addEventListener('message', (event) => {
      const arrivedAt = performance.now()
      store.inboundFrames += 1
      store.lastFrameAt = arrivedAt
      const data = event.data
      if (data && typeof data.byteLength === 'number') store.inboundBytes += data.byteLength
      else if (typeof data === 'string') store.inboundBytes += data.length
      // Runs when the main thread next yields, so the difference is the
      // SYNCHRONOUS cost of everything the frame set off — store fill, re-render.
      setTimeout(() => {
        store.frameProcessingMs.push(performance.now() - arrivedAt)
        if (store.frameProcessingMs.length > 20000) store.frameProcessingMs.shift()
      }, 0)
    })
    return socket
  }
  window.WebSocket.prototype = NativeWebSocket.prototype
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    window.WebSocket[key] = NativeWebSocket[key]
  }
})()
`

async function login() {
  const response = await fetch(`${API}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`dev login returned HTTP ${response.status}`)
  const cookie = (response.headers.get('set-cookie') || '').match(/maplespire_session=([^;]+)/)
  if (!cookie) throw new Error('dev login did not return the HttpOnly session cookie')
  return { name: 'maplespire_session', value: cookie[1] }
}

async function selectWorkspace(cookieHeader) {
  const landscapeId = process.env.DIAGRAM_PEER_LANDSCAPE_ID
  const versionId = process.env.DIAGRAM_PEER_VERSION_ID
  if (landscapeId && versionId) return { landscapeId, versionId }
  const response = await fetch(`${API}/api/landscapes`, {
    headers: { Cookie: cookieHeader },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`GET /api/landscapes returned HTTP ${response.status}`)
  const body = await response.json()
  const landscapes = Array.isArray(body) ? body : (body?.landscapes ?? [])
  const usable = landscapes.find((l) => l?.id && l?.defaultVersionId)
  if (!usable) throw new Error('no landscape with a default version is visible to this account')
  return { landscapeId: usable.id, versionId: usable.defaultVersionId }
}

async function main() {
  // Imported lazily so a stack without Playwright fails with a sentence rather
  // than a module-resolution stack trace at import time.
  let chromium
  try {
    ({ chromium } = await import('playwright'))
  } catch (error) {
    throw new Error(`the browser arm needs Playwright (\`npm install\` at the repo root): ${error.message}`)
  }

  const cookie = await login()
  const cookieHeader = `${cookie.name}=${cookie.value}`
  const workspace = await selectWorkspace(cookieHeader)
  if (!DIAGRAM_ID) throw new Error('DIAGRAM_PEER_ID is required: the browser arm must join the SAME diagram as the Node peers')
  const target = `${APP}/app/landscape/${workspace.landscapeId}/version/${workspace.versionId}/diagram/${DIAGRAM_ID}`
  console.log(`[browser] ${OBSERVERS} observer(s) on ${target}`)

  const browser = await chromium.launch({ headless: HEADLESS })
  const observers = []
  const contexts = []
  try {
    for (let index = 0; index < OBSERVERS; index += 1) {
      // A brand-new context per observer, never reused between runs — trap 2.
      // The session cookie is INJECTED rather than obtained through the login
      // form, because logging in through the UI lands on a diagram route and
      // boots the whole workspace first (trap 1): the observer would then be
      // measuring its second visit while the report called it the first.
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      await context.addCookies([{ ...cookie, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }])
      await context.addInitScript(IN_PAGE_PROBE(CAPTURE))
      contexts.push(context)
      const page = await context.newPage()
      observers.push({ index, context, page, heartbeatGaps: [], navigations: 0 })
    }

    // Navigate all observers, then let them settle before the window opens: the
    // boot is not the campaign, and folding it in would publish a cold load as a
    // concurrency cost.
    await Promise.all(observers.map(async (observer) => {
      await observer.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    }))
    console.log('[browser] observers navigated; waiting for the campaign window')

    if (WINDOW_START_AT > Date.now()) await sleep(WINDOW_START_AT - Date.now())
    const windowOpenedAt = Date.now()

    // Zero the in-page counters AT the window edge, so what they hold afterwards
    // is the campaign and not the boot.
    await Promise.all(observers.map((observer) => observer.page.evaluate(() => {
      const store = window.__t11
      if (!store) return
      store.longTasks.length = 0
      store.frameProcessingMs.length = 0
      store.inboundFrames = 0
      store.inboundBytes = 0
    }).catch(() => {})))

    // The EXTERNAL witness. Every beat is a round trip into the page under a
    // deadline; a beat that does not come back inside the deadline is a GAP, and
    // a gap nothing explains means the in-page capture stopped being able to
    // report — which is the one thing the in-page capture can never tell us.
    const beat = async (observer) => {
      const startedAt = Date.now()
      try {
        await observer.page.evaluate(() => window.__t11?.inboundFrames ?? -1)
      } catch {
        // A page that cannot answer is exactly the condition being watched for.
      }
      const endedAt = Date.now()
      if (endedAt - startedAt > HEARTBEAT_MS) {
        observer.heartbeatGaps.push({ startMs: startedAt - windowOpenedAt, endMs: endedAt - windowOpenedAt, durationMs: endedAt - startedAt })
      }
    }
    const deadline = windowOpenedAt + WINDOW_MS
    while (Date.now() < deadline) {
      await Promise.all(observers.map(beat))
      await sleep(HEARTBEAT_MS)
    }
    const windowClosedAt = Date.now()

    for (const observer of observers) {
      const snapshot = await observer.page.evaluate(() => {
        const store = window.__t11
        if (!store) return null
        return {
          navigations: store.navigations,
          longTasks: store.longTasks.slice(),
          frameProcessingMs: store.frameProcessingMs.slice(),
          inboundFrames: store.inboundFrames,
          inboundBytes: store.inboundBytes,
          longTaskCaptureEnabled: store.longTaskCaptureEnabled,
        }
      }).catch(() => null)
      Object.assign(observer, {
        connected: Boolean(snapshot && snapshot.inboundFrames > 0),
        ...(snapshot ?? { navigations: 0, longTasks: [], frameProcessingMs: [], inboundFrames: 0, inboundBytes: 0, longTaskCaptureEnabled: false }),
      })
    }

    const arm = evaluateBrowserArm(
      observers.map((observer) => ({
        index: observer.index,
        connected: observer.connected,
        inboundFrames: observer.inboundFrames,
        inboundBytes: observer.inboundBytes,
        navigations: observer.navigations,
        longTaskCaptureEnabled: observer.longTaskCaptureEnabled,
        longTasks: observer.longTasks,
        frameProcessingMs: observer.frameProcessingMs,
        heartbeatGaps: observer.heartbeatGaps,
      })),
      { requestedObservers: OBSERVERS, livenessBudgetMs: LIVENESS_BUDGET_MS },
    )

    const report = {
      startedAt: new Date(windowOpenedAt).toISOString(),
      endedAt: new Date(windowClosedAt).toISOString(),
      app: APP,
      api: API,
      workspace,
      diagramId: DIAGRAM_ID,
      captureEnabled: CAPTURE,
      requestedObservers: OBSERVERS,
      livenessBudgetMs: LIVENESS_BUDGET_MS,
      // The arm's verdict is spread FIRST and the per-observer detail second:
      // both carry an `observers` key and the detail is the one a reader needs.
      ...arm,
      observingCount: arm.observing,
      observers: observers.map((observer) => ({
        index: observer.index,
        connected: observer.connected,
        inboundFrames: observer.inboundFrames,
        inboundBytes: observer.inboundBytes,
        navigations: observer.navigations,
        longTaskCaptureEnabled: observer.longTaskCaptureEnabled,
        // Leg [C]: frame arrival -> the task that processed it yielding.
        receiveMs: summarizeObserverFrames(observer.frameProcessingMs),
        // The felt cost, and the one bound that is rigorous: a single 54 ms
        // longtask BOUNDS every synchronous block inside it at <= 54 ms.
        longTaskMs: summarizeObserverFrames(observer.longTasks.map((task) => task.durationMs)),
        longTasks: observer.longTasks.length,
        heartbeatGaps: observer.heartbeatGaps,
      })),
    }

    if (REPORT_PATH) {
      writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8')
      console.log(`[browser] report written to ${REPORT_PATH}`)
    }
    for (const observer of report.observers) {
      console.log(
        `[browser] observer ${observer.index}: ${observer.inboundFrames} frames / ` +
        `${(observer.inboundBytes / 1024).toFixed(1)} kB, receive p99 ${observer.receiveMs.p99 ?? '-'} ms, ` +
        `${observer.longTasks} long task(s) p99 ${observer.longTaskMs.p99 ?? '-'} ms, ` +
        `${observer.heartbeatGaps.length} liveness gap(s)`,
      )
    }
    if (arm.outcome === 'void') {
      for (const reason of arm.voids) console.error(`[browser] VOID ${reason}`)
      return exitCodeForOutcome('void')
    }
    console.log(`[browser] PASS ${arm.observing}/${OBSERVERS} observers held the document and reported`)
    return exitCodeForOutcome('passed')
  } finally {
    // Park every tab on about:blank before closing: a live tab reconnects the
    // instant a port rebinds, and the next run would start against a warm peer.
    for (const context of contexts) {
      await Promise.all(context.pages().map((page) => page.goto('about:blank').catch(() => {})))
      await context.close().catch(() => {})
    }
    await browser.close().catch(() => {})
  }
}

main()
  .catch((error) => {
    console.error(`[browser] VOID harness error: ${error?.stack ?? error}`)
    return exitCodeForOutcome('void')
  })
  .then((code) => process.exit(code ?? 1))
