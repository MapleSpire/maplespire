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

// 3D quality loop — the MEASURE half. Drives the real UI on a real GPU and
// writes one report directory: report.json (load + frame-time + scene numbers)
// and a fixed set of screenshots the critic agent grades.
//
//   node scripts/view3d-quality/run.mjs --url http://localhost:5301 --out reports/view3d-quality/<tag>
//
// Flags:
//   --url <base>        frontend (dev or a VITE_SCENE3D_PROBE=on preview build)
//   --out <dir>         report directory (created)
//   --gpu real|soft     real = ANGLE/D3D11 on the host GPU (default);
//                       soft = SwiftShader, a stand-in for a weak laptop GPU
//   --dpr <n>           device pixel ratio (default 1)
//   --backgrounds a,b   decor backgrounds to measure (default city,workbench,studio)
//   --headed            show the browser
//
// Frame times are measured with vsync OFF (--disable-gpu-vsync
// --disable-frame-rate-limit): rAF then runs as fast as the frame can be
// produced, so the interval IS the frame cost, not the display's refresh.
// A 60 Hz cap would make every frame under 16.7 ms read as 16.7 ms.
import { chromium } from 'playwright'
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : def
}
const BASE = arg('url', 'http://localhost:5301')
const OUT = resolve(arg('out', `reports/view3d-quality/${new Date().toISOString().replace(/[:.]/g, '-')}`))
const GPU = arg('gpu', 'real')
const DPR = Number(arg('dpr', '1'))
// Every background the harness exists to measure. A run that measures fewer
// is RED (gate "every required background measured"): loop4-r4-dpr2 measured
// city only — 22 gates against 37 at DPR 1 — and the heaviest scene
// (workbench: 3 lights, 43 shadow casters) went unmeasured at DPR 2 for three
// rounds because a narrowed --backgrounds silently shrank the gate list.
// The studio joined on 2026-10-12: its floor showed the walnut desk for
// rounds because no run ever dressed it (the user found it, not a gate).
const REQUIRED_BACKGROUNDS = ['city', 'workbench', 'studio']
const BACKGROUNDS = arg('backgrounds', REQUIRED_BACKGROUNDS.join(',')).split(',').filter(Boolean)
const HEADED = argv.includes('--headed')
const PROFILE = argv.includes('--profile')
const TRACE = argv.includes('--trace')
const EXPERIMENTS = argv.includes('--experiments')
mkdirSync(OUT, { recursive: true })
// A reused report directory keeps NOTHING of an earlier run: final-assets/
// carried an error.png written at 18:01:39 by an aborted run, beside a clean
// report.json whose own run started at 18:03:33 — a loading-spinner "error"
// no report explained. Every PNG and report this harness writes is purged
// first, so a file in the directory belongs to the report next to it.
const stale = readdirSync(OUT).filter((f) => /\.png$/i.test(f) || f === 'report.json')
for (const f of stale) unlinkSync(resolve(OUT, f))
if (stale.length) console.log('[quality]', `purged ${stale.length} file(s) of an earlier run from`, OUT)

// A realistic mid-size container view: 9 nodes, 2 stores, 10 edges.
const DSL = `workspace "Quality" {
  model {
    user = person "Analyst" "Reads dashboards"
    platform = softwareSystem "Observability" "System" {
      web = container "Web console" "Single-page app" "React"
      api = container "Query API" "Serves metrics and traces" "Go"
      ingest = container "Ingest gateway" "Receives telemetry" "Rust"
      alert = container "Alert manager" "Routes alerts" "Go"
      worker = container "Rollup worker" "Downsamples series" "Python"
      tsdb = container "Metrics store" "Time series" "PostgreSQL"
      logs = container "Log store" "Indexed logs" "Elasticsearch"
      queue = container "Event bus" "Buffers spans" "Kafka"
    }
    user -> web "uses"
    web -> api "queries"
    api -> tsdb "reads"
    api -> logs "searches"
    ingest -> queue "publishes"
    queue -> worker "consumes"
    worker -> tsdb "writes"
    ingest -> logs "ships"
    alert -> api "evaluates"
    worker -> alert "notifies"
  }
  views {
    container platform { include * autoLayout }
  }
}`

const gpuArgs =
  GPU === 'soft'
    ? []
    : ['--enable-gpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=d3d11']

const browser = await chromium.launch({
  headless: !HEADED,
  args: [...gpuArgs, '--disable-gpu-vsync', '--disable-frame-rate-limit'],
})
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: DPR })
// Long tasks from navigation start, buffered in the page (an observer
// registered later only sees what Chrome chose to buffer).
await context.addInitScript(() => {
  window.__lt = []
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration])
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    /* no longtask support */
  }
  // Long Animation Frames carry per-script attribution (invoker, source,
  // duration) — what a long task WAS, not just how long it took.
  window.__loaf = []
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__loaf.push({
          start: Math.round(e.startTime),
          ms: Math.round(e.duration),
          blockingMs: Math.round(e.blockingDuration ?? 0),
          renderStart: Math.round(e.renderStart ?? 0),
          scripts: (e.scripts ?? [])
            .filter((s) => s.duration >= 5)
            .map((s) => ({
              ms: Math.round(s.duration),
              invoker: s.invoker,
              fn: s.sourceFunctionName,
              src: String(s.sourceURL ?? '').split('/').pop().split('?')[0],
            })),
        })
      }
    }).observe({ type: 'long-animation-frame', buffered: true })
  } catch {
    /* no LoAF support */
  }
  // Class/style flips on canvases and test-id'd elements (the 2D board's
  // `invisible`, the 3D crossfade): a compositor re-raster they trigger runs
  // on the GPU process's main thread, the one that decodes WebGL — a frame
  // blocked in a GL call with nothing of its own to do lines up with these.
  window.__dom = []
  const watch = () => {
    try {
      new MutationObserver((list) => {
        for (const m of list) {
          const el = m.target
          if (!(el instanceof Element) || !(el.tagName === 'CANVAS' || el.hasAttribute('data-testid'))) continue
          window.__dom.push([
            Math.round(performance.now()),
            el.tagName.toLowerCase(),
            el.getAttribute('data-testid') ?? '',
            m.attributeName,
            String(el.getAttribute(m.attributeName) ?? '').slice(0, 80),
          ])
        }
      }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    } catch {
      /* no MutationObserver */
    }
  }
  if (document.documentElement) watch()
  else document.addEventListener('DOMContentLoaded', watch, { once: true })
})
const page = await context.newPage()
const report = { base: BASE, gpu: GPU, dpr: DPR, startedAt: new Date().toISOString(), runs: [], gates: [], reloads: [] }
const log = (...a) => console.log('[quality]', ...a)

// The step the run is in — named in the error screenshot and the report, so
// a failure always says WHERE it happened (the old catch-all wrote one
// anonymous error.png).
let step = 'start'
const at = (name) => {
  step = name
}
// A FULL page load the harness did not ask for (a Vite full reload when a
// module or a .glb under src/ changes mid-run, a crash recovery) drops the 3D
// scene: every later probe call reads `window.__scene3d` undefined and the
// next screenshot is the app's loading spinner. Our own navigations run
// inside `navigating()`; any other `load` is recorded with its step and
// gated, and `shot()` refuses to capture a scene that is not live.
let ownNavigation = 0
const tWall0 = Date.now()
page.on('load', () => {
  if (ownNavigation > 0) return
  report.reloads.push({ step, atMs: Date.now() - tWall0, url: page.url() })
  log('UNEXPECTED full page load during', step)
})
async function navigating(fn) {
  ownNavigation++
  try {
    return await fn()
  } finally {
    ownNavigation--
  }
}
async function assertLive(what) {
  const live = await page
    .evaluate(() => !!window.__scene3d && window.__scene3d.nodeCount() > 0 && !!document.querySelector('[data-testid="canvas-3d"] canvas'))
    .catch(() => false)
  if (!live) {
    const r = report.reloads.at(-1)
    throw new Error(
      `${what}: the 3D scene is not live — ${r ? `unexpected full page load during "${r.step}" at ${r.atMs} ms` : 'no unexpected page load seen'}; refusing to capture a loading screen`,
    )
  }
}

// Regression gates, recorded in report.gates (and printed). `--strict` turns a
// failing gate into a non-zero exit; without it the report is still written
// whole, so a measuring loop never loses a run to its own verdict.
const STRICT = argv.includes('--strict')
// The stated perf budgets. Overridable ONLY so a gate can be shown RED with a
// deliberately impossible threshold before it is trusted (a gate that cannot
// fail is not a gate): `--orbit-p95-max 0.1 --cold-longtask-max 1`.
const ORBIT_P95_MAX = Number(arg('orbit-p95-max', DPR === 2 ? '14' : '8'))
const COLD_LONGTASK_MAX = Number(arg('cold-longtask-max', '300'))
// connecting in 3D never blocks input past this (measureReconnect3d)
const RECONNECT_LONGTASK_MAX = Number(arg('reconnect-longtask-max', '100'))
const RECONNECT_ONLY = argv.includes('--reconnect-only')
// quality pass "lines" (user round 2026-10-12: "Remet les lignes connections
// comme le theme Clean et regarde pour améliorer le design des lignes pour
// que ce soit un peu plus visible"). The lit board draws Clean's flat ribbon
// and flat 2D arrowhead in a warm INK with a cream halo (src/canvas3d/
// inkLine.ts — this harness cannot import TS; the numbers below mirror its
// constants and the design spec's acceptance list):
//  - every line and every head reads >= 3:1 against the surface round it in
//    the default-framing PNG (WCAG 2.1 SC 1.4.11, non-text contrast) — a
//    line on >= LINE_CONTRAST_SHARE of its seen samples;
//  - a head is never shorter than INK_HEAD_MIN_CSS on screen (the shader's
//    floor), a core never thinner than INK_CORE_MIN_CSS (highlight
//    INK_HIGHLIGHT_MIN_CSS) where it is seen square, and no seen line under
//    LOW_LINE_MIN_CSS in the low shot.
const LINE_MIN_CONTRAST = Number(arg('line-min-contrast', '3'))
const LINE_CONTRAST_SHARE = Number(arg('line-contrast-share', '0.9'))
const INK_HEAD_MIN_CSS = Number(arg('head-min-px', '11'))
const INK_CORE_MIN_CSS = 1.75
const INK_HIGHLIGHT_MIN_CSS = 2.5
const LOW_LINE_MIN_CSS = Number(arg('low-line-min-px', '1.5'))
// the ink set's colours (inkLine.ts INK_DARK_ON_LIGHT; the selected shot
// reads them back from the PNG, +-INK_PIXEL_TOL per channel)
const INK_HIGHLIGHT_CSS = '#D97A3D'
const INK_RIM_CSS = '#3A362F'
const INK_PIXEL_TOL = Number(arg('ink-pixel-tol', '6'))
// a focus-dimmed line (inkLine.INK_DIM_OPACITY, no halo) stays present but
// subordinate
const INK_DIM_OPACITY = 0.42
const DIM_CONTRAST_MIN = 1.3
const DIM_CONTRAST_MAX = 1.8
// dashed and dotted lit lines (inkLine.INK_DASHED / INK_DOTTED: the 2D
// engine's [6, 4] and [2, 3] world px), read back from a close top-view PNG
// — close enough that the fragment's anti-aliasing floor (INK_DASH_MIN_CSS
// 7 css px a period) does not lengthen the dotted rhythm, which the probe
// reports as `scale`: the measured periods must be 10 +- 1 and 5 +- 0.5
// world px, the on-lengths 6 +- 1 and 2 +- 0.75 (a dash end is a
// 1-px antialiased edge either side).
const DASH_SHOT_DISTANCE = 0.5
const DASH_SPECS = {
  dashed: { on: 6, period: 10, periodTol: 1, onTol: 1 },
  dotted: { on: 2, period: 5, periodTol: 0.5, onTol: 0.75 },
}
// --arrows-only: the lines shot set on the dressed workbench, nothing else
// (a diagnostic mode: the backgrounds gate is RED)
const ARROWS_ONLY = argv.includes('--arrows-only')
// quality pass "montroyal" (user 2026-10-11: "le décor du mont royal est
// horrible"): the city's landmark wears the Blender maquette
// (mont-royal.glb) inside this triangle budget — the task's "~12k for the
// whole landmark"; the shipped mesh measures 11 920 (mont_royal_assets.py, montroyal3)
const MOUNT_TRIS_MAX = Number(arg('mount-tris-max', '12000'))
// --mount-only: the dressed city's wide shot and the Mont-Royal close-up,
// nothing else (a diagnostic mode: the backgrounds gate is RED)
const MOUNT_ONLY = argv.includes('--mount-only')
function gate(name, ok, detail) {
  report.gates.push({ name, ok: !!ok, detail })
  log(ok ? 'GATE ok  ' : 'GATE FAIL', name, ok ? '' : JSON.stringify(detail))
}

/** Wait for the first-frame probe of the CURRENT build (and of the post
 * stack, when the lit profile mounts one) to have fired, so perfInfo
 * reports this build's frame — never a previous one (the loop1-r2 stale
 * 170.30000001192093 ms carried from enter-3D into the city pick). */
async function firstFrameMeasured() {
  await page
    .waitForFunction(
      () => {
        const p = window.__scene3d?.perfInfo()
        if (!p || p.postFirstPending || p.postFirstBuild !== p.builds) return false
        // a lit board mounts its post stack after the first build: wait for
        // the composed frame unless the tier has none
        return p.postLive ? p.postFirstComposed : true
      },
      undefined,
      { timeout: 30000 },
    )
    .catch(() => log('first-frame probe did not settle within 30 s'))
}

async function login() {
  await page.goto(`${BASE}/login`)
  const devLogin = page.locator('[data-testid="dev-login-email"]')
  const outcome = await Promise.race([
    devLogin.waitFor({ state: 'visible', timeout: 30000 }).then(() => 'form'),
    page.waitForURL('**/app/**', { timeout: 30000 }).then(() => 'app'),
  ]).catch(() => 'form')
  if (outcome === 'form') {
    await page.locator('[data-testid="legal-acceptance"]').check()
    await devLogin.fill('admin@example.com')
    await devLogin.press('Enter')
  }
  await page.waitForURL('**/app/**', { timeout: 60000 })
}

async function importDsl() {
  await page.locator('[data-testid="nav-menu"]').click()
  await page.locator('[data-testid="nav-diagrams"]').click()
  await page.locator('[data-testid="create-diagram-button"]').click()
  await page.locator('[data-testid="create-import"]').click()
  await page.locator('[data-testid="import-textarea"]').fill(DSL)
  await page.locator('[data-testid="import-parse"]').click()
  await page.locator('[data-testid="import-generate"]').click()
  await page.waitForURL('**/diagram/**', { timeout: 90000 })
  await page.waitForTimeout(2500)
}

const sceneReady = () =>
  page.waitForFunction(
    () => !!window.__scene3d && !window.__scene3d.isCameraAnimating() && window.__scene3d.nodeCount() > 0,
    undefined,
    { timeout: 90000 },
  )

async function longTasksSince(t0) {
  return page.evaluate((from) => {
    const l = (window.__lt ?? []).filter(([s]) => s >= from)
    return {
      count: l.length,
      totalMs: Math.round(l.reduce((a, [, d]) => a + d, 0)),
      maxMs: Math.round(Math.max(0, ...l.map(([, d]) => d))),
      // [start, duration] — lines up with perfInfo().slowFrames[].atMs
      tasks: l.map(([s, d]) => [Math.round(s), Math.round(d)]),
      // the long animation frames over 100 ms, with their scripts
      frames: (window.__loaf ?? []).filter((f) => f.start >= from && f.ms >= 100),
      // long frames (>= 50 ms) carrying >= 50 ms of the durable write flush
      writeFrames: (window.__loaf ?? []).filter(
        (f) => f.start >= from && f.ms >= 50 && f.scripts.some((s) => s.src === 'placementWriteScheduler.ts' && s.ms >= 50),
      ),
    }
  }, t0)
}

/** The durable write must never be the freeze: a view-settings edit (decor,
 * skin) takes bridge.ts's targeted DiagramDoc path. loop2 measured the FULL
 * flushWrite (registry metas + whole-doc reconcile) as a 305 ms task on the
 * city pick and 166 ms inside enter-3D, both attributed by LoAF to the
 * scheduler's setTimeout. Any long frame (>= 50 ms of script) whose script
 * is the write scheduler fails this gate, whatever its length. */
function writeFlushFrames(lt) {
  return lt.writeFrames ?? []
}

async function setStudio() {
  const sel = page.locator('[data-testid="diagram-skin-select"]')
  if (await sel.count()) await sel.selectOption('studio').catch(() => log('studio skin option missing'))
}

async function applyDecor(bg) {
  const t0 = await page.evaluate(() => performance.now())
  const builds0 = await page.evaluate(() => window.__scene3d.perfInfo().builds)
  // each pick may close the popover — reopen it whenever the target is absent
  for (const id of ['decor-pack-canadiana', 'decor-board-wood', `decor-bg-${bg}`]) {
    const target = page.locator(`[data-testid="${id}"]`)
    if (!(await target.isVisible().catch(() => false))) await page.locator('[data-testid="decor-open"]').click()
    await target.click()
  }
  if (await page.locator('[data-testid="decor-bg-default"]').isVisible().catch(() => false)) {
    await page.locator('[data-testid="decor-open"]').click()
  }
  await page.waitForFunction(
    ([b, n]) => {
      const d = window.__scene3d?.decorInfo()
      return d && d.world === b && d.packId === 'canadiana' && window.__scene3d.perfInfo().builds > n
    },
    [bg, builds0],
    { timeout: 60000 },
  )
  await firstFrameMeasured()
  await page.waitForTimeout(400)
  const t1 = await page.evaluate(() => performance.now())
  return { wallMs: Math.round(t1 - t0), longTasks: await longTasksSince(t0), build: await page.evaluate(() => window.__scene3d.perfInfo()) }
}

/** Every node's projected 3D box (5x5 sample points, corners included)
 * hit-tests to the WebGL canvas — not to a panel, the tool rail or a toolbar
 * floating over it — and lies inside the canvas (loop2 round 2: Ingest under
 * the properties panel, Log store's name tag on the STYLE 3D toolbar). */
async function evalFit() {
  return page.evaluate(() => {
    const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
    const hidden = []
    for (const b of window.__scene3d.nodeScreenBoxes()) {
      const misses = []
      for (let i = 0; i <= 4; i++) {
        for (let j = 0; j <= 4; j++) {
          const x = b.x + 1 + ((b.w - 2) * i) / 4
          const y = b.y + 1 + ((b.h - 2) * j) / 4
          const el = document.elementFromPoint(x, y)
          if (el !== canvas) misses.push([Math.round(x), Math.round(y), el ? el.tagName + (el.dataset?.testid ? `#${el.dataset.testid}` : '') : 'outside'])
        }
      }
      if (misses.length) hidden.push({ id: b.id, box: [b.x, b.y, b.w, b.h].map(Math.round), misses: misses.slice(0, 4) })
    }
    return { nodes: window.__scene3d.nodeScreenBoxes().length, hidden }
  })
}

/** Convex hull (monotone chain) of client-px points. */
function hull2d(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

/** Widest separating gap (px) between two convex polygons along their edge
 * normals — negative when they overlap (separating-axis theorem). Written
 * here, not imported from the app's screenClearance.ts: the gate must not
 * share the arithmetic of the fix it grades. */
function hullGap(a, b) {
  let best = -Infinity
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]
      const q = poly[(i + 1) % poly.length]
      let nx = -(q.y - p.y)
      let ny = q.x - p.x
      const len = Math.hypot(nx, ny)
      if (len < 1e-9) continue
      nx /= len
      ny /= len
      const pa = a.map((v) => v.x * nx + v.y * ny)
      const pb = b.map((v) => v.x * nx + v.y * ny)
      best = Math.max(best, Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb))
    }
  }
  return best
}

/** Quality pass "labels": every DRAWN connection label plate
 * (labelScreenInfo: its four corners as drawn) against every card and drum
 * solid, every drum's floor tag, and every other drawn plate. TASK 2 (the
 * user's decision of 2026-10-10): a crowded label is abbreviated or hidden,
 * never drawn half over something — the floor tags are gated now ('consumes'
 * lay over the Event bus tag in tp4-cards-3/workbench-labels.png), and so are
 * plate pairs. `overlaps`: pairs that meet (gap <= 0); `nearest`: each
 * label's smallest gap to anything. */
function evalLabelScreen(info) {
  const solids = info.nodes.map((n) => ({ id: n.id, kind: n.kind, hull: hull2d(n.pts) }))
  const plates = info.labels.map((l) => ({ text: l.text, hull: hull2d(l.pts) }))
  const overlaps = []
  const nearest = {}
  for (const [i, l] of plates.entries()) {
    let min = Infinity
    for (const s of solids) {
      const g = hullGap(l.hull, s.hull)
      min = Math.min(min, g)
      if (g <= 0) overlaps.push({ label: l.text, node: s.id, kind: s.kind, gapPx: +g.toFixed(2) })
    }
    for (const [j, m] of plates.entries()) {
      if (j === i) continue
      const g = hullGap(l.hull, m.hull)
      min = Math.min(min, g)
      if (g <= 0 && j > i) overlaps.push({ label: l.text, node: m.text, kind: 'plate', gapPx: +g.toFixed(2) })
    }
    nearest[l.text] = +min.toFixed(1)
  }
  return { labels: info.labels.length, nodes: solids.length, overlaps, nearest }
}

/** TASK 2: what every lit label shows at the current framing
 * (connLabelStates): counts of whole / abbreviated / hidden, and the
 * abbreviations as shown. */
async function evalLabelStates() {
  const states = await page.evaluate(() => window.__scene3d.connLabelStates().map(({ wire, ...s }) => s))
  const count = (st) => states.filter((s) => s.state === st).length
  return {
    total: states.length,
    full: count('full'),
    abbreviated: count('abbreviated'),
    hidden: count('hidden'),
    states,
  }
}

/** TASK 2: orbit toward top-down with the REAL pointer (a vertical stroke on
 * empty floor: rig.orbitBy lowers the polar by 0.25 deg per px), read what
 * the labels show there, shoot it, and orbit back by the same stroke.
 * `restored`: the pose's polar and azimuth are back within 0.5 deg. */
const TOP_POLAR = 14
async function evalLabelsTopDown(bg) {
  const pose0 = await page.evaluate(() => window.__scene3d.getPose())
  const dy = Math.round((pose0.polar - TOP_POLAR) / 0.25)
  const box = await page.locator('canvas').last().boundingBox()
  /** An empty-floor point from which a stroke of `d` px (down when > 0)
   * stays on the canvas. */
  const startFor = (d) =>
    page.evaluate(
      ([bx, by, bw, bh, d]) => {
        const free = (x, y) => {
          const el = document.elementFromPoint(x, y)
          return !!el && el.tagName === 'CANVAS' && window.__scene3d.pickAt(x, y) === null
        }
        for (let fy = 0.08; fy <= 0.92; fy += 0.04) {
          for (const fx of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7]) {
            const x = bx + bw * fx
            const y = by + bh * fy
            if (y + d < by + 8 || y + d > by + bh - 8) continue
            if (free(x, y)) return { x, y }
          }
        }
        return null
      },
      [box.x, box.y, box.width, box.height, d],
    )
  const stroke = async (d) => {
    const s = await startFor(d)
    if (!s) return false
    await page.mouse.move(s.x, s.y)
    await page.mouse.down()
    await page.mouse.move(s.x, s.y + d, { steps: 16 })
    await page.mouse.up()
    // off the board: no connection stays hovered (hover shows a label whole)
    await page.mouse.move(5, 500)
    await page.waitForFunction(() => !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 })
    await page.waitForTimeout(400)
    return true
  }
  const out = { from: { polar: +pose0.polar.toFixed(1), azimuth: +pose0.azimuth.toFixed(1) }, strokePx: dy }
  out.orbited = await stroke(dy)
  const pose1 = await page.evaluate(() => window.__scene3d.getPose())
  out.at = { polar: +pose1.polar.toFixed(1), azimuth: +pose1.azimuth.toFixed(1) }
  out.orbited = out.orbited && pose1.polar <= TOP_POLAR + 1
  const states = await evalLabelStates()
  out.states = { full: states.full, abbreviated: states.abbreviated, hidden: states.hidden, states: states.states }
  out.screen = evalLabelScreen(await page.evaluate(() => window.__scene3d.labelScreenInfo()))
  // ...and no drawn plate under or through an arrowhead (fifth arrow
  // iteration: 'queries' / 'reads' / 'consumes' cut by their heads in
  // tp8-final-dpr1 workbench-labels-top.png)
  {
    const info = await page.evaluate(() => window.__scene3d.arrowheadInfo())
    const plates = await page.evaluate(() => window.__scene3d.labelScreenInfo().labels)
    out.cueClash = evalCueClash(
      info.map((a) => ({ wire: a.connId, connId: a.connId, drawn: a.drawn, onScreen: a.onScreen, visibleUi: a.visibleFraction, hull: a.hull })),
      plates,
    )
  }
  out.shot = await shot(`${bg}-labels-top`)
  out.summary = `polar ${out.at.polar}: ${states.full} whole, ${states.abbreviated} abbreviated, ${states.hidden} hidden, ${out.screen.overlaps.length} overlaps`
  await stroke(-dy)
  const pose2 = await page.evaluate(() => window.__scene3d.getPose())
  out.back = { polar: +pose2.polar.toFixed(1), azimuth: +pose2.azimuth.toFixed(1) }
  out.restored = Math.abs(pose2.polar - pose0.polar) <= 0.5 && Math.abs(((pose2.azimuth - pose0.azimuth + 540) % 360) - 180) <= 0.5
  return out
}

/** TASK 2: a hidden or abbreviated label is read by hovering its connection
 * — with the REAL pointer. For each such label: the points of its own cable
 * projected through the live camera, nearest its middle first, kept where the
 * canvas is the element under the point and the app would pick THIS
 * connection there (pickAt, read-only); the mouse is moved onto the first,
 * and the label must then be drawn whole; moved off the board, it must go
 * back to what it showed. `hoverable: false` = no point of its wire is
 * pickable at this framing (reported). */
async function evalLabelHover() {
  const out = []
  const before = await page.evaluate(() => window.__scene3d.connLabelStates())
  for (const l of before.filter((s) => s.state !== 'full' && s.wire.length > 1)) {
    const target = await page.evaluate(([id, wire]) => {
      const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
      const pts = window.__scene3d.projectWorld(wire)
      const mid = (pts.length - 1) / 2
      const order = pts.map((p, i) => ({ p, d: Math.abs(i - mid) })).sort((a, b) => a.d - b.d)
      for (const { p } of order) {
        if (document.elementFromPoint(p.x, p.y) !== canvas) continue
        const t = window.__scene3d.pickAt(p.x, p.y)
        if (t && (t.kind === 'connection' || t.kind === 'connLabel') && t.id === id) return p
      }
      return null
    }, [l.connId, l.wire])
    if (!target) {
      out.push({ text: l.text, state: l.state, hoverable: false })
      continue
    }
    await page.mouse.move(target.x, target.y)
    await page.waitForTimeout(150)
    const on = await page.evaluate((id) => window.__scene3d.connLabelStates().find((s) => s.connId === id), l.connId)
    // off the board (the left panel), then back to what it showed
    await page.mouse.move(5, 500)
    await page.waitForTimeout(150)
    const off = await page.evaluate((id) => window.__scene3d.connLabelStates().find((s) => s.connId === id), l.connId)
    out.push({
      text: l.text,
      state: l.state,
      hoverable: true,
      at: { x: +target.x.toFixed(1), y: +target.y.toFixed(1) },
      hovered: { state: on.state, drawn: on.drawn, textNow: on.textNow },
      after: { state: off.state, drawn: off.drawn, textNow: off.textNow },
      ok: on.hovered && on.state === 'full' && on.drawn && on.textNow === l.text && off.state === l.state && off.shown === l.shown,
    })
  }
  return out
}

/** Quality pass "labels" round 2: 'notifies' and 'writes' floated ~150 css
 * px up-left of any wire in tp2-final-dpr1/workbench-wide.png, and the
 * connLabelWireInfo probe measured all ten plates 41-183 world px from their
 * own cables. For each visible plate: its drawn WORLD centre's distance to its
 * own cable centreline (3D, point to segment — written here, not imported:
 * the gate must not share the fix's arithmetic), held to half its drawn
 * height + ON_WIRE_SLACK. (Copies of each plate slid along its wire fed a
 * "boxed in" exception to the overlap gate; TASK 2 removed the exception, so
 * they are no longer computed.) */
const ON_WIRE_SLACK = 6
async function evalLabelWires() {
  const raw = await page.evaluate(() => window.__scene3d.connLabelWireInfo())
  const segDist = (p, a, b) => {
    const ab = [b.x - a.x, b.y - a.y, b.z - a.z]
    const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ab[0] + (p.y - a.y) * ab[1] + (p.z - a.z) * ab[2]) / l2)) : 0
    return Math.hypot(p.x - a.x - ab[0] * t, p.y - a.y - ab[1] * t, p.z - a.z - ab[2] * t)
  }
  return raw.map((l) => {
    let d = Infinity
    for (let i = 1; i < l.wire.length; i++) d = Math.min(d, segDist(l.centre, l.wire[i - 1], l.wire[i]))
    if (l.wire.length === 1) d = Math.hypot(l.centre.x - l.wire[0].x, l.centre.y - l.wire[0].y, l.centre.z - l.wire[0].z)
    return {
      connId: l.connId,
      text: l.text,
      k: +l.k.toFixed(2),
      wirePts: l.wire.length,
      distance: +d.toFixed(1),
      limit: +(l.halfH + ON_WIRE_SLACK).toFixed(1),
      onWire: l.wire.length > 1 && d <= l.halfH + ON_WIRE_SLACK,
    }
  })
}

/** The desk flag reads in the current framing (placement.ts showcase view):
 * its finial and foot both project onto the unobstructed canvas. */
async function evalFlagFrame() {
  return page.evaluate(() => {
    const props = window.__scene3d.decorProps('canada-flag')
    if (!props.length) return { placed: false }
    const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
    const pts = window.__scene3d.projectWorld([
      { x: props[0].x, y: props[0].y, z: props[0].z },
      { x: props[0].x, y: props[0].y + 70.5 * props[0].scale, z: props[0].z },
    ])
    const hits = pts.map((p) => document.elementFromPoint(p.x, p.y) === canvas)
    return { placed: true, pts, hits, heightPx: Math.abs(pts[1].y - pts[0].y) }
  })
}

/** The desk wildlife reads in the current framing (quality pass "wildlife":
 * "at the default framing the moose is about 40 px and the beaver about 25
 * px — brown specks"). Per animal: its instances, and for the first its foot
 * and its top (the silhouette's own height as built, antler crown included —
 * decorProps `h`) projected, their hit-tests against the unobstructed canvas
 * and the projected height between them. */
async function evalWildlifeFrame() {
  return page.evaluate(() => {
    const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
    const out = {}
    for (const id of ['moose', 'beaver']) {
      const props = window.__scene3d.decorProps(id)
      if (!props.length) {
        out[id] = { placed: 0 }
        continue
      }
      const p = props[0]
      const pts = window.__scene3d.projectWorld([
        { x: p.x, y: p.y, z: p.z },
        { x: p.x, y: p.y + p.h, z: p.z },
      ])
      out[id] = {
        placed: props.length,
        world: [Math.round(p.x), +p.y.toFixed(1), Math.round(p.z)],
        scale: +p.scale.toFixed(3),
        h: +p.h.toFixed(1),
        pts: pts.map((q) => [Math.round(q.x), Math.round(q.y)]),
        hits: pts.map((q) => document.elementFromPoint(q.x, q.y) === canvas),
        heightPx: +Math.abs(pts[1].y - pts[0].y).toFixed(1),
      }
    }
    return out
  })
}

/** Nothing stands on a desk prop (quality pass "layout",
 * tp-final-dpr1/workbench-moose.png: "the moose stands on the rolled
 * blueprint"). Every desk instance (decorProps, y under the slab top) with its
 * posed geometry box's plan rectangle (the box's bottom face) and its
 * projected SILHOUETTE box (decorSilhouettes: the posed vertices — the 8 box
 * corners overshoot a long or round prop: the first run of this gate read the
 * moose's corner box over the flag's with clear desk between the two in
 * tp2-layout/workbench-wide.png). `planOverlaps`: an ANIMAL's plan rectangle
 * crossing another desk prop's (separating-axis test); `screenOverlaps`: an
 * animal's silhouette box meeting another desk prop's. */
async function evalDeskOverlap() {
  return page.evaluate(() => {
    const s = window.__scene3d
    const desk = []
    for (const { id } of s.decorInfo().archetypes) {
      const sil = s.decorSilhouettes(id)
      s.decorProps(id).forEach((p, i) => {
        // board props stand on the paper (y 0..1), desk props on the desk
        // plane under the slab (y ≈ -30)
        if (p.y > -5) return
        // corners: x-major, then y, then z (Scene3D decorProps) — the bottom
        // face is y-min: indices 0, 1, 5, 4 walk its rectangle
        const plan = [0, 1, 5, 4].map((k) => ({ x: p.corners[k][0], z: p.corners[k][2] }))
        desk.push({ id, at: [Math.round(p.x), Math.round(p.z)], plan, box: sil[i] })
      })
    }
    const axes = (poly) => poly.map((a, i) => {
      const b = poly[(i + 1) % poly.length]
      return { x: -(b.z - a.z), z: b.x - a.x }
    })
    const crosses = (P, Q) =>
      [...axes(P), ...axes(Q)].every((n) => {
        const pp = P.map((v) => v.x * n.x + v.z * n.z)
        const qq = Q.map((v) => v.x * n.x + v.z * n.z)
        return Math.max(...pp) > Math.min(...qq) && Math.max(...qq) > Math.min(...pp)
      })
    const animals = desk.filter((d) => d.id === 'moose' || d.id === 'beaver')
    const planOverlaps = []
    const screenOverlaps = []
    /** the nearest other desk silhouette to each animal, css px */
    const nearestPx = {}
    for (const a of animals) {
      for (const o of desk) {
        if (o === a) continue
        if (crosses(a.plan, o.plan)) planOverlaps.push(`${a.id}@${a.at} / ${o.id}@${o.at}`)
        if (a.box.x0 < o.box.x1 && o.box.x0 < a.box.x1 && a.box.y0 < o.box.y1 && o.box.y0 < a.box.y1) screenOverlaps.push(`${a.id}@${a.at} / ${o.id}@${o.at}`)
        const gx = Math.max(o.box.x0 - a.box.x1, a.box.x0 - o.box.x1, 0)
        const gy = Math.max(o.box.y0 - a.box.y1, a.box.y0 - o.box.y1, 0)
        const g = Math.hypot(gx, gy)
        if (!(a.id in nearestPx) || g < nearestPx[a.id][0]) nearestPx[a.id] = [+g.toFixed(1), o.id]
      }
    }
    return { deskProps: desk.length, animals: animals.length, planOverlaps, screenOverlaps, nearestPx }
  })
}

/** Board vs desk VALUE STEP in a screenshot already written (view3d quality
 * loop 4 r4, workbench-wide.png: board (206,155,98) against desk
 * (204,161,115) — the same luminance, the board did not separate from its
 * desk). Samples Rec. 709 luminance of the PNG's pixels on a grid over the
 * slab top (node boxes excluded) and over a desk ring OUTSIDE the cutting
 * mat (slab + 102 → slab + 450 world units), each point kept only where it
 * hit-tests to the unobstructed canvas. Medians, so props, the lamp pool and
 * labels do not swing it. */
async function evalBoardDesk(file) {
  const b64 = readFileSync(resolve(OUT, file)).toString('base64')
  return page.evaluate(async (b64) => {
    const info = window.__scene3d.boardInfo()
    if (!info) return { ok: false, reason: 'no board' }
    const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
    const rect = canvas.getBoundingClientRect()
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
    const off = new OffscreenCanvas(bmp.width, bmp.height)
    const g = off.getContext('2d')
    g.drawImage(bmp, 0, 0)
    const img = g.getImageData(0, 0, bmp.width, bmp.height)
    const sx = bmp.width / rect.width
    const sy = bmp.height / rect.height
    const boxes = window.__scene3d.nodeScreenBoxes()
    const inNode = (x, y) => boxes.some((b) => x >= b.x - 6 && x <= b.x + b.w + 6 && y >= b.y - 6 && y <= b.y + b.h + 6)
    const read = (worldPts, skipNodes) => {
      const out = []
      const pts = window.__scene3d.projectWorld(worldPts)
      for (const p of pts) {
        if (p.x < rect.left + 2 || p.y < rect.top + 2 || p.x > rect.right - 2 || p.y > rect.bottom - 2) continue
        if (document.elementFromPoint(p.x, p.y) !== canvas) continue
        if (skipNodes && inNode(p.x, p.y)) continue
        const px = Math.min(bmp.width - 1, Math.round((p.x - rect.left) * sx))
        const py = Math.min(bmp.height - 1, Math.round((p.y - rect.top) * sy))
        const o = (py * bmp.width + px) * 4
        out.push(0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2])
      }
      return out
    }
    const G = 28
    const board = []
    for (let i = 0; i < G; i++) {
      for (let j = 0; j < G; j++) {
        board.push({ x: info.x + info.w * (0.04 + (0.92 * i) / (G - 1)), y: info.topY, z: info.z + info.h * (0.04 + (0.92 * j) / (G - 1)) })
      }
    }
    const IN = 102
    const OUTR = 450
    const desk = []
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 40; j++) {
        const x = info.x - OUTR + ((info.w + 2 * OUTR) * i) / 39
        const z = info.z - OUTR + ((info.h + 2 * OUTR) * j) / 39
        if (x > info.x - IN && x < info.x + info.w + IN && z > info.z - IN && z < info.z + info.h + IN) continue
        desk.push({ x, y: info.deskY, z })
      }
    }
    const med = (a) => {
      const s = [...a].sort((p, q) => p - q)
      return s.length ? s[Math.floor(s.length / 2)] : NaN
    }
    const mean = (a) => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : NaN)
    const bl = read(board, true)
    const dl = read(desk, false)
    const boardMed = med(bl)
    const deskMed = med(dl)
    return {
      ok: true,
      boardSamples: bl.length,
      deskSamples: dl.length,
      boardMedian: +boardMed.toFixed(1),
      deskMedian: +deskMed.toFixed(1),
      boardMean: +mean(bl).toFixed(1),
      deskMean: +mean(dl).toFixed(1),
      step: +((boardMed - deskMed) / boardMed).toFixed(3),
    }
  }, b64)
}

/** NO WOOD on the studio floor (user 2026-10-12: "l'arrière plan studio a
 * un problème avec la texture qui reste avec du bois" — the walnut desk was
 * built for every lit world, and the cyclorama's 270° sweep left it showing
 * in the camera's own quadrant, the whole foreground of studio-wide.png).
 * Grain is texture: in a screenshot already written, every point of a grid
 * over the floor around the slab (slab + FLOOR_GRAIN_IN → slab +
 * FLOOR_GRAIN_OUT world units, at the desk level) that hit-tests to the
 * unobstructed canvas gets the Rec. 709 luminance STANDARD DEVIATION of the
 * 9 × 9 css-px window around it. Seamless paper under a soft light pool is
 * a smooth gradient there (a fraction of a level per window); walnut boards
 * carry grain lines and plank seams in every window. Props standing on the
 * floor add texture too, so the statistic is a quantile over the samples,
 * never the max: `p50` and `p75` of the window deviations, and `grainy`, the
 * share of windows over FLOOR_GRAIN_WINDOW_STD. */
const FLOOR_GRAIN_IN = 70
const FLOOR_GRAIN_OUT = 900
const FLOOR_GRAIN_WINDOW_STD = 3
// Measured at DPR 1, RTX 4080, fit framing (wide) — reports/view3d-quality/:
//   studio-bg-before2 (walnut desk under the studio): studio.wide p75 2.04,
//     grainy 0.225 (550 samples) — RED on both bounds;
//   studio-bg-before2 workbench.wide (the walnut itself): p75 7.24, grainy 1;
//   studio-bg-after1 (paper floor): studio.wide p75 1.16, grainy 0.045 —
//     the residue is the desk props standing in the ring.
//   studio-bg-full (the same, full run): studio.wide p75 1.27, grainy 0.064;
//     city.wide p75 19.6, workbench.wide p75 7.36 (reported only).
// The cold (enter) framing is REPORTED, never gated: a close-up where only
// ~47 floor samples reach the canvas. With the old desk they all lay on the
// paper (before2 cold: p75 0.5, grainy 0 — the walnut was off-frame), and on
// the fixed floor a prop-heavy seed put 8 of them on the pencil cup, the
// plant and the tower (studio-bg-full cold: grainy 0.17, p90 24.25 —
// studio-cold.png shows paper and props only). Green on the defect and red
// on a correct frame: that is not a gate.
const FLOOR_GRAIN_P75_MAX = 1.5
const FLOOR_GRAIN_SHARE_MAX = 0.12
function floorGrainGate(label, fg) {
  gate(
    `${label}: no wood grain on the studio floor (window luminance std p75 <= ${FLOOR_GRAIN_P75_MAX}, share of windows over ${FLOOR_GRAIN_WINDOW_STD} <= ${FLOOR_GRAIN_SHARE_MAX}, >= 200 samples)`,
    fg.ok && fg.samples >= 200 && fg.p75 <= FLOOR_GRAIN_P75_MAX && fg.grainy <= FLOOR_GRAIN_SHARE_MAX,
    fg,
  )
}
async function evalFloorGrain(file) {
  const b64 = readFileSync(resolve(OUT, file)).toString('base64')
  return page.evaluate(
    async ([b64, IN, OUTR, T]) => {
      const info = window.__scene3d.boardInfo()
      if (!info) return { ok: false, reason: 'no board' }
      const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
      const rect = canvas.getBoundingClientRect()
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
      const off = new OffscreenCanvas(bmp.width, bmp.height)
      const g = off.getContext('2d')
      g.drawImage(bmp, 0, 0)
      const img = g.getImageData(0, 0, bmp.width, bmp.height)
      const sx = bmp.width / rect.width
      const sy = bmp.height / rect.height
      const lum = (px, py) => {
        const o = (py * bmp.width + px) * 4
        return 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2]
      }
      const pts = []
      const N = 48
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const x = info.x - OUTR + ((info.w + 2 * OUTR) * i) / (N - 1)
          const z = info.z - OUTR + ((info.h + 2 * OUTR) * j) / (N - 1)
          if (x > info.x - IN && x < info.x + info.w + IN && z > info.z - IN && z < info.z + info.h + IN) continue
          pts.push({ x, y: info.deskY, z })
        }
      }
      const stds = []
      const half = 4 // 9 × 9 css px
      for (const p of window.__scene3d.projectWorld(pts)) {
        if (p.x < rect.left + half + 2 || p.y < rect.top + half + 2 || p.x > rect.right - half - 2 || p.y > rect.bottom - half - 2) continue
        // the whole window on the bare canvas (no panel, toolbar or label)
        if ([[0, 0], [-half, -half], [half, -half], [-half, half], [half, half]].some(([dx, dy]) => document.elementFromPoint(p.x + dx, p.y + dy) !== canvas)) continue
        const cx = (p.x - rect.left) * sx
        const cy = (p.y - rect.top) * sy
        let s = 0
        let s2 = 0
        let n = 0
        for (let dy = -half; dy <= half; dy++) {
          for (let dx = -half; dx <= half; dx++) {
            const px = Math.min(bmp.width - 1, Math.max(0, Math.round(cx + dx * sx)))
            const py = Math.min(bmp.height - 1, Math.max(0, Math.round(cy + dy * sy)))
            const l = lum(px, py)
            s += l
            s2 += l * l
            n++
          }
        }
        stds.push(Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)))
      }
      const sorted = [...stds].sort((a, b) => a - b)
      const q = (f) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] : NaN)
      return {
        ok: true,
        samples: stds.length,
        p50: +q(0.5).toFixed(2),
        p75: +q(0.75).toFixed(2),
        p90: +q(0.9).toFixed(2),
        grainy: +(stds.filter((v) => v > T).length / Math.max(1, stds.length)).toFixed(3),
      }
    },
    [b64, FLOOR_GRAIN_IN, FLOOR_GRAIN_OUT, FLOOR_GRAIN_WINDOW_STD],
  )
}

/** No HOT SPOT on the board (lamp pass 2026-10-10; the critic, twice: "a
 * circular spotlight pool on the cards", "a bright warm hot spot just right
 * of Event bus" in workbench-wide.png). Rec. 709 luminance of the PNG on a
 * 60 × 60 grid over the WHOLE slab top (1.5 % inset — the old pool sat at
 * the top edge, under evalBoardDesk's 4 %), each point kept only where it
 * hit-tests to the unobstructed canvas and lies off every node box (+6 px),
 * every connection-label plate (+4 px) and every cable (6 px): bare board.
 * The points are binned into 12 × 12 cells (5 × 5 points each) and a
 * cell's MEDIAN is its value, so wood grain, a leaf or a stray pixel do not
 * count — a pool covering a cell does. `hot` = (hottest cell − board
 * median) / board median.
 *
 * Measured with the same arithmetic (.probes/lamp, workbench fit framing,
 * DPR 1): the old decay-0 lamp 0.085 (the cell beside Event bus, 170.3 over
 * a 157 median); the same frame with the lamp off 0.031; the lit board
 * without the AO pass 0.084 (spot on — the AO pass is not the source). In
 * this harness (tp3-lamp, DPR 1): workbench 0.032, city 0.030; a mutant run
 * restoring the old aim and decay-0 spot read 0.094 (175.1 over 160, the
 * cell beside Event bus) — RED. */
const HOT_SPOT_MAX = 0.06
async function evalBoardHotSpot(file) {
  const b64 = readFileSync(resolve(OUT, file)).toString('base64')
  return page.evaluate(async (b64) => {
    const s = window.__scene3d
    const info = s.boardInfo()
    if (!info) return { ok: false, reason: 'no board' }
    const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
    const rect = canvas.getBoundingClientRect()
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
    const off = new OffscreenCanvas(bmp.width, bmp.height)
    const g = off.getContext('2d')
    g.drawImage(bmp, 0, 0)
    const img = g.getImageData(0, 0, bmp.width, bmp.height)
    const sx = bmp.width / rect.width
    const sy = bmp.height / rect.height
    const boxes = s.nodeScreenBoxes()
    const plates = s.labelScreenInfo().labels.map((l) => {
      const xs = l.pts.map((p) => p.x)
      const ys = l.pts.map((p) => p.y)
      return { x0: Math.min(...xs) - 4, x1: Math.max(...xs) + 4, y0: Math.min(...ys) - 4, y1: Math.max(...ys) + 4 }
    })
    const cables = s.connLabelWireInfo().map((w) => s.projectWorld(w.wire))
    const nearCable = (x, y) =>
      cables.some((pl) =>
        pl.some((a, i) => {
          if (i === 0) return false
          const b = pl[i - 1]
          const dx = b.x - a.x
          const dy = b.y - a.y
          const L = dx * dx + dy * dy || 1
          const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L))
          return Math.hypot(a.x + t * dx - x, a.y + t * dy - y) < 6
        }),
      )
    const G = 60
    const C = 12
    const IN = 0.015
    const pts = []
    const cellOf = []
    for (let i = 0; i < G; i++) {
      for (let j = 0; j < G; j++) {
        pts.push({ x: info.x + info.w * (IN + ((1 - 2 * IN) * i) / (G - 1)), y: info.topY, z: info.z + info.h * (IN + ((1 - 2 * IN) * j) / (G - 1)) })
        cellOf.push(`${Math.floor((i * C) / G)},${Math.floor((j * C) / G)}`)
      }
    }
    const all = []
    const cells = new Map()
    s.projectWorld(pts).forEach((p, k) => {
      if (p.x < rect.left + 2 || p.y < rect.top + 2 || p.x > rect.right - 2 || p.y > rect.bottom - 2) return
      if (document.elementFromPoint(p.x, p.y) !== canvas) return
      if (boxes.some((b) => p.x >= b.x - 6 && p.x <= b.x + b.w + 6 && p.y >= b.y - 6 && p.y <= b.y + b.h + 6)) return
      if (plates.some((b) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1)) return
      if (nearCable(p.x, p.y)) return
      const px = Math.min(bmp.width - 1, Math.round((p.x - rect.left) * sx))
      const py = Math.min(bmp.height - 1, Math.round((p.y - rect.top) * sy))
      const o = (py * bmp.width + px) * 4
      const l = 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2]
      all.push(l)
      const c = cells.get(cellOf[k]) ?? { l: [], sx: 0, sy: 0 }
      c.l.push(l)
      c.sx += p.x
      c.sy += p.y
      cells.set(cellOf[k], c)
    })
    const med = (a) => {
      const q = [...a].sort((p, r) => p - r)
      return q.length ? q[Math.floor(q.length / 2)] : NaN
    }
    const m = med(all)
    // a cell counts with at least 10 of its 25 points on bare board
    const ranked = [...cells.entries()]
      .filter(([, c]) => c.l.length >= 10)
      .map(([cell, c]) => ({ cell, n: c.l.length, median: +med(c.l).toFixed(1), at: [Math.round(c.sx / c.l.length), Math.round(c.sy / c.l.length)] }))
      .sort((a, b) => b.median - a.median)
    return {
      ok: true,
      samples: all.length,
      cells: ranked.length,
      boardMedian: +m.toFixed(1),
      hottest: ranked.slice(0, 3),
      hot: ranked.length ? +((ranked[0].median - m) / m).toFixed(3) : NaN,
    }
  }, b64)
}

/** Frame cost two ways. `bench`: 120 readback-fenced frames rendered
 * synchronously through the real pipeline while the camera orbits 90° — the
 * honest CPU+GPU cost per frame. `hitches`: a real mouse orbit with vsync off,
 * counting rAF gaps over 33 ms (a visible stutter at any refresh rate). */
async function measureOrbit(ms = 3000) {
  await page.evaluate(() => window.__scene3d.benchFrames(10)) // warm programs
  const ft = await page.evaluate(() => window.__scene3d.benchFrames(120))
  ft.sort((a, b) => a - b)
  const q = (p) => +ft[Math.floor(p * (ft.length - 1))].toFixed(2)
  const bench = { frames: ft.length, p50: q(0.5), p95: q(0.95), max: +ft.at(-1).toFixed(1), fpsP50: Math.round(1000 / q(0.5)) }

  const box = await page.locator('canvas').last().boundingBox()
  // An orbit starts on EMPTY floor: a press on a card or a group platform is
  // a drag. The old fixed point (50 %, 90 %) assumed the fit-to-screen
  // framing; right after enter-3D the board still fills the 2D framing, and
  // loop2's "orbitBare: 81 hitches" was a GROUP DRAG — LoAF put 40 ms of
  // CANVAS.onpointermove (updatePlacementsBatch + cable rebuild) in every
  // long frame. Search for a start point the scene's own picker calls empty.
  const legacy = { x: box.x + box.width * 0.5 - 200, y: box.y + box.height * 0.9 }
  const start = await page.evaluate(
    ([bx, by, bw, bh, lx, ly]) => {
      const free = (x, y) => {
        const el = document.elementFromPoint(x, y)
        return !!el && el.tagName === 'CANVAS' && window.__scene3d.pickAt(x, y) === null
      }
      const legacyPick = window.__scene3d.pickAt(lx, ly)
      // the stroke sweeps ±300 px in x and 60 px up from its start: keep the
      // whole sweep inside the canvas
      for (const fy of [0.9, 0.94, 0.86, 0.82, 0.78, 0.97, 0.12, 0.08]) {
        for (const fx of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65]) {
          const x = bx + bw * fx - 200
          const y = by + bh * fy
          if (x - 300 < bx + 4 || x + 300 > bx + bw - 4 || y - 60 < by + 4 || y > by + bh - 4) continue
          if (free(x, y)) return { x, y, legacyPick }
        }
      }
      return { x: lx, y: ly, legacyPick, noEmptyFloor: true }
    },
    [box.x, box.y, box.width, box.height, legacy.x, legacy.y],
  )
  const cx = start.x + 200
  const cy = start.y
  // a hitch is a rAF gap over 33 ms, but long tasks and LoAF entries start at
  // 50 ms: the loop4-r3-dpr2 first orbit had ONE 35.6 ms hitch and an empty
  // frames list. The scene logs its own frames, canvas handlers and
  // out-of-loop tasks (perfInfo().slowFrames, with the shadow flag) down to
  // 20 ms for this window, so every hitch has a candidate.
  await page.evaluate(() => window.__scene3d.setSlowFrameMs(20))
  const tOrbit = await page.evaluate(() => performance.now())
  await page.evaluate(() => {
    window.__ft = []
    window.__ftAt = []
    let last = performance.now()
    window.__ftOn = true
    const tick = (t) => {
      window.__ft.push(t - last)
      window.__ftAt.push(last)
      last = t
      if (window.__ftOn) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.mouse.move(cx - 200, cy)
  await page.mouse.down()
  const steps = Math.round(ms / 16)
  for (let i = 0; i < steps; i++) {
    const t = i / steps
    await page.mouse.move(cx - 200 + Math.sin(t * Math.PI * 2) * 300, cy - Math.sin(t * Math.PI) * 60)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  const { gaps, at } = await page.evaluate(() => {
    window.__ftOn = false
    return { gaps: window.__ft.slice(3), at: window.__ftAt.slice(3) }
  })
  const hitchAt = gaps.flatMap((g, i) => (g > 33 ? [{ atMs: Math.round(at[i]), ms: +g.toFixed(1) }] : []))
  // what ran during the orbit: every long animation frame with its scripts
  // (a hitch with no LoAF entry is GPU/compositor-side, not main-thread script).
  // LoAF itself only reports frames over 50 ms; the >= 30 filter is for a
  // browser that lowers that floor — the scene's own log below covers the rest.
  const frames = await page.evaluate(
    (from) => (window.__loaf ?? []).filter((f) => f.start >= from && f.ms >= 30).slice(0, 20),
    tOrbit,
  )
  const slowFrames = await page.evaluate((from) => {
    const s = window.__scene3d
    const log = s.perfInfo().slowFrames.filter((f) => f.atMs >= from)
    s.setSlowFrameMs(40)
    return log
  }, tOrbit - 1)
  return {
    bench,
    hitches: { count: hitchAt.length, maxMs: +Math.max(0, ...gaps).toFixed(1), at: hitchAt },
    frames,
    slowFrames,
    tOrbit: Math.round(tOrbit),
    start,
  }
}

async function shot(name, setup) {
  at(`shot ${name}`)
  await assertLive(`shot ${name}`)
  if (setup) {
    await setup()
    // `__scene3d &&`: after a reload the bare property read threw inside the
    // predicate — the failure then named a TypeError, not the reload
    await page.waitForFunction(() => window.__scene3d && !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 })
    await page.waitForTimeout(500)
  }
  // re-asked AFTER the settle: the reload can land inside it
  await assertLive(`shot ${name}`)
  const file = `${name}.png`
  await page.locator('canvas').last().screenshot({ path: resolve(OUT, file) })
  return file
}

/** CPU-profile `fn` through CDP and return the top self-time frames — the
 * attribution for a freeze, not just its size. Source-mapped names are what
 * the dev server serves; a production build reports minified names. */
let cdp = null
async function profiled(label, fn, minTaskMs = 50) {
  if (!PROFILE) return { result: await fn(), profile: null }
  cdp ??= await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
  const result = await fn()
  const { profile } = await cdp.send('Profiler.stop')
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map()
  const dt = profile.timeDeltas
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i])
    const cf = n.callFrame
    if (cf.functionName === '(idle)' || cf.functionName === '(program)') continue
    const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop().split('?')[0]}:${cf.lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000)
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, ms]) => [k, Math.round(ms)])
  // …and WHO paid for it: each sample charged to its nearest app-source
  // ancestor (first frame outside node_modules / pre-bundled deps), so a
  // library hotspot like three's `onFirstUse` names the call site behind it.
  const parent = new Map()
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  // wasm (automerge) and React's dev runtime count as library: the caller
  // that matters is the app frame that called INTO them
  const isLib = (url) =>
    !url || /node_modules|\/deps\/|three\.module|postprocessing|troika|react-dom|react_jsx|react-[A-Za-z0-9]+\.js|chunk-|\.wasm/.test(url)
  const callers = new Map()
  for (let i = 0; i < profile.samples.length; i++) {
    let id = profile.samples[i]
    const leaf = byId.get(id).callFrame.functionName
    if (leaf === '(idle)' || leaf === '(program)' || leaf === '(garbage collector)') continue
    while (id !== undefined && isLib(byId.get(id).callFrame.url)) id = parent.get(id)
    const cf = id !== undefined ? byId.get(id).callFrame : { functionName: '(lib root)', url: '', lineNumber: -1 }
    const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop().split('?')[0]}:${cf.lineNumber + 1}`
    callers.set(key, (callers.get(key) ?? 0) + (dt[i] ?? 0) / 1000)
  }
  const byCaller = [...callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, ms]) => [k, Math.round(ms)])
  // …and per LONG TASK: a whole-window profile spreads one 190 ms task over
  // a second of unrelated work. A task is a run of non-idle samples; each
  // run over 50 ms is reported with its own top callers and leaves.
  const tasks = []
  let cur = null
  const flush = () => {
    if (cur && cur.ms >= minTaskMs) {
      const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, ms]) => [k, Math.round(ms)])
      tasks.push({ ms: Math.round(cur.ms), atMs: Math.round(cur.at), byCaller: top(cur.callers), self: top(cur.self) })
    }
    cur = null
  }
  let clock = 0
  for (let i = 0; i < profile.samples.length; i++) {
    const d = (dt[i] ?? 0) / 1000
    clock += d
    let id = profile.samples[i]
    const leafCf = byId.get(id).callFrame
    if (leafCf.functionName === '(idle)') {
      flush()
      continue
    }
    cur ??= { ms: 0, at: clock, callers: new Map(), self: new Map() }
    cur.ms += d
    const leafKey = `${leafCf.functionName || '(anon)'} ${leafCf.url.split('/').pop().split('?')[0]}:${leafCf.lineNumber + 1}`
    cur.self.set(leafKey, (cur.self.get(leafKey) ?? 0) + d)
    while (id !== undefined && isLib(byId.get(id).callFrame.url)) id = parent.get(id)
    const cf = id !== undefined ? byId.get(id).callFrame : { functionName: '(lib root)', url: '', lineNumber: -1 }
    const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop().split('?')[0]}:${cf.lineNumber + 1}`
    cur.callers.set(key, (cur.callers.get(key) ?? 0) + d)
  }
  flush()
  writeFileSync(resolve(OUT, `profile-${label}.json`), JSON.stringify({ self: top, byCaller, longTasks: tasks }, null, 2))
  return { result, profile: { self: top.slice(0, 8), byCaller: byCaller.slice(0, 8) } }
}

/** Fly to the first instance of a decor archetype. `distance` is the framing
 * at desk scale (instance scale 1); a maquette-scaled instance (the city's
 * `cityScale`, 0.18-0.5) is approached proportionally closer, or a 0.25-scale
 * beaver is a 50-px speck in a 1280-px frame (loop 4, city-beaver.png). The
 * orbit target lies on y = 0 while desk props stand at the desk level, so
 * the target slides along the view ray to keep the prop itself centred. */
async function focusProp(archetype, distance, { fitHeight = false } = {}) {
  const props = await page.evaluate((a) => window.__scene3d.decorProps(a), archetype)
  if (!props.length) return false
  const pose = await page.evaluate(() => window.__scene3d.getPose())
  const polar = (Math.max(0.5, pose.polar) * Math.PI) / 180
  const az = (pose.azimuth * Math.PI) / 180
  // the instance furthest toward the camera: a desk prop on the FAR apron
  // is seen past the slab's raised edge (loop 4 city-beaver.png: a beaver
  // peeking over the board's side wall)
  const toward = (q) => q.x * Math.sin(az) + q.z * Math.cos(az)
  const p = props.reduce((a, b) => (toward(b) > toward(a) ? b : a))
  let d = distance * Math.min(1, p.scale)
  // fitHeight (loop 4 r4, workbench-moose.png: "the far antler is cut off
  // behind the top toolbar, so the crown cannot be graded"): aim at the
  // prop's MIDDLE — its full height as built (`h`, antler crown included) —
  // and back off until that height spans at most FIT_SHARE of the frame, so
  // the crown keeps a margin under the top toolbar pill (~70 px of 1000).
  const FIT_SHARE = 0.55
  const h = fitHeight && p.h ? p.h : 16 * p.scale
  if (fitHeight && p.h) d = Math.max(d, h / FIT_SHARE / (2 * Math.tan(((pose.fov ?? 29.6) * Math.PI) / 360)))
  // the ray through the prop's mid-height meets y = 0 here…
  const yMid = p.y + h / 2
  const k = (yMid * Math.sin(polar)) / Math.cos(polar)
  const tx = p.x - Math.sin(az) * k
  const tz = p.z - Math.cos(az) * k
  // …and the prop lies |yMid|/cos(polar) BEYOND that target along it (desk
  // props stand ~30 under y = 0), so `d` is the camera-to-PROP distance. The
  // rig's target is pinned to y = 0, so the camera cannot come closer than
  // that offset: a city desk prop's tightest close-up is ~50 units away
  // (loop 4: at a target distance of 35 the moose was really 84 away).
  const dTarget = Math.max(2, d + yMid / Math.cos(polar))
  await page.evaluate(([x, z, dd]) => window.__scene3d.focusWorld(x, z, dd), [tx, tz, dTarget])
  log('focus', archetype, { x: Math.round(p.x), y: +p.y.toFixed(1), z: Math.round(p.z), scale: +p.scale.toFixed(3), propDistance: Math.round(Math.max(d, dTarget - yMid / Math.cos(polar))) })
  return true
}

/** Quality pass "mug" (blind critic: "the other desk props have no close-up
 * so they cannot be scored above 6"): fly to the instance of an archetype
 * nearest the camera and frame the WHOLE prop — its plan circle (decorProps
 * `r`) and its height (`h`) — inside CLOSEUP_SHARE of the UNOBSTRUCTED
 * canvas (the span of canvas pixels left free by the panels and toolbars
 * through the frame's centre). focusProp's fixed distances framed the mug at
 * ~18 px per unit, its rim cut by the top toolbar, and a 86-unit sketchbook
 * would not fit at all. Returns the instance index and the distance, or null
 * when the archetype is not placed. */
const CLOSEUP_SHARE = 0.7
async function focusWhole(archetype) {
  const props = await page.evaluate((a) => window.__scene3d.decorProps(a), archetype)
  if (!props.length) return null
  const pose = await page.evaluate(() => window.__scene3d.getPose())
  const polar = (Math.max(0.5, pose.polar) * Math.PI) / 180
  const az = (pose.azimuth * Math.PI) / 180
  const toward = (q) => q.x * Math.sin(az) + q.z * Math.cos(az)
  let index = 0
  props.forEach((q, i) => {
    if (toward(q) > toward(props[index])) index = i
  })
  const p = props[index]
  const free = await page.evaluate(() => {
    const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
    const r = canvas.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const on = (x, y) => document.elementFromPoint(x, y) === canvas
    let xl = cx
    let xr = cx
    let yt = cy
    let yb = cy
    while (xl > r.left + 4 && on(xl - 4, cy)) xl -= 4
    while (xr < r.right - 4 && on(xr + 4, cy)) xr += 4
    while (yt > r.top + 4 && on(cx, yt - 4)) yt -= 4
    while (yb < r.bottom - 4 && on(cx, yb + 4)) yb += 4
    // symmetric about the centre, where focusWorld puts the target
    return { w: r.width, h: r.height, fw: (2 * Math.min(cx - xl, xr - cx)) / r.width, fh: (2 * Math.min(cy - yt, yb - cy)) / r.height }
  })
  const tanH = Math.tan(((pose.fov ?? 29.6) * Math.PI) / 360)
  // pass 1, an estimate: the screen extent in world units at the prop — its
  // height foreshortened by the view's tilt, its plan circle's depth by the
  // rest — inside CLOSEUP_SHARE of the free span
  const extV = p.h * Math.sin(polar) + 2 * p.r * Math.cos(polar)
  const dV = extV / (CLOSEUP_SHARE * free.fh * 2 * tanH)
  const dH = (2 * p.r) / (CLOSEUP_SHARE * free.fw * 2 * tanH * (free.w / free.h))
  const fly = async (d) => {
    const yMid = p.y + p.h / 2
    const k = (yMid * Math.sin(polar)) / Math.cos(polar)
    const dTarget = Math.max(2, d + yMid / Math.cos(polar))
    await page.evaluate(([x, z, dd]) => window.__scene3d.focusWorld(x, z, dd), [p.x - Math.sin(az) * k, p.z - Math.cos(az) * k, dTarget])
    await page.waitForFunction(() => window.__scene3d && !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 })
  }
  let d = Math.max(dV, dH)
  await fly(d)
  // pass 2, measured: the posed box's projected span against the free span
  // (the circle over-estimates a long prop's plan; perspective grows its
  // near corners) — the projected size goes as 1 / distance, so one rescale
  // lands the limiting dimension on CLOSEUP_SHARE
  const f = await evalPropFrame(archetype, index)
  const fill = Math.max(f.spanPx[0] / (free.fw * free.w), f.spanPx[1] / (free.fh * free.h))
  if (fill > 0) {
    d *= fill / CLOSEUP_SHARE
    await fly(d)
  }
  log('focus whole', archetype, { r: +p.r.toFixed(1), h: +p.h.toFixed(1), free: [+free.fw.toFixed(2), +free.fh.toFixed(2)], pass1Fill: +fill.toFixed(2), propDistance: Math.round(d) })
  return { index, d: Math.round(d), free }
}

/** Is the whole prop in the close-up? The 8 corners of its posed geometry
 * box (decorProps `corners`) projected: each inside the canvas AND
 * hit-testing to it (not under a panel or a toolbar), and the box's
 * projected span in px. */
async function evalPropFrame(archetype, index) {
  return page.evaluate(
    ([a, i]) => {
      const p = window.__scene3d.decorProps(a)[i]
      const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
      const rect = canvas.getBoundingClientRect()
      const sp = window.__scene3d.projectWorld(p.corners.map(([x, y, z]) => ({ x, y, z })))
      const inside = (q) => q.x > rect.left && q.x < rect.right && q.y > rect.top && q.y < rect.bottom && document.elementFromPoint(q.x, q.y) === canvas
      const xs = sp.map((q) => q.x)
      const ys = sp.map((q) => q.y)
      return {
        r: +p.r.toFixed(1),
        h: +p.h.toFixed(1),
        spanPx: [Math.round(Math.max(...xs) - Math.min(...xs)), Math.round(Math.max(...ys) - Math.min(...ys))],
        misses: sp.filter((q) => !inside(q)).map((q) => [Math.round(q.x), Math.round(q.y)]),
      }
    },
    [archetype, index],
  )
}

/** Quality pass "montroyal": frame the city's Mont-Royal WHOLE — its drawn
 * box (cityMountInfo, the merged `city-mount` part) inside CLOSEUP_SHARE of
 * the unobstructed canvas — and shoot `<bg>-mont-royal.png`. Same two-pass
 * fly as focusWhole: estimate from the box, then rescale once on the
 * measured projected span. Null outside the city (no mount). */
async function mountCloseup(bg) {
  at(`${bg}: close-up mont-royal`)
  const m = await page.evaluate(() => window.__scene3d.cityMountInfo())
  if (!m) return null
  const pose = await page.evaluate(() => window.__scene3d.getPose())
  const polar = (Math.max(0.5, pose.polar) * Math.PI) / 180
  const az = (pose.azimuth * Math.PI) / 180
  const tanH = Math.tan(((pose.fov ?? 29.6) * Math.PI) / 360)
  const cx = (m.min[0] + m.max[0]) / 2
  const cz = (m.min[2] + m.max[2]) / 2
  const yMid = (m.min[1] + m.max[1]) / 2
  const corners = []
  for (const x of [m.min[0], m.max[0]]) for (const y of [m.min[1], m.max[1]]) for (const z of [m.min[2], m.max[2]]) corners.push({ x, y, z })
  const fly = async (d) => {
    const k = (yMid * Math.sin(polar)) / Math.cos(polar)
    const dTarget = Math.max(2, d + yMid / Math.cos(polar))
    await page.evaluate(([x, z, dd]) => window.__scene3d.focusWorld(x, z, dd), [cx - Math.sin(az) * k, cz - Math.cos(az) * k, dTarget])
    await page.waitForFunction(() => window.__scene3d && !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 })
  }
  const frame = () =>
    page.evaluate((pts) => {
      const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
      const rect = canvas.getBoundingClientRect()
      const ccx = rect.left + rect.width / 2
      const ccy = rect.top + rect.height / 2
      const on = (x, y) => document.elementFromPoint(x, y) === canvas
      let xl = ccx
      let xr = ccx
      let yt = ccy
      let yb = ccy
      while (xl > rect.left + 4 && on(xl - 4, ccy)) xl -= 4
      while (xr < rect.right - 4 && on(xr + 4, ccy)) xr += 4
      while (yt > rect.top + 4 && on(ccx, yt - 4)) yt -= 4
      while (yb < rect.bottom - 4 && on(ccx, yb + 4)) yb += 4
      const sp = window.__scene3d.projectWorld(pts)
      const xs = sp.map((q) => q.x)
      const ys = sp.map((q) => q.y)
      const inside = (q) => q.x > rect.left && q.x < rect.right && q.y > rect.top && q.y < rect.bottom && on(q.x, q.y)
      return {
        freeW: 2 * Math.min(ccx - xl, xr - ccx),
        freeH: 2 * Math.min(ccy - yt, yb - ccy),
        spanPx: [Math.round(Math.max(...xs) - Math.min(...xs)), Math.round(Math.max(...ys) - Math.min(...ys))],
        misses: sp.filter((q) => !inside(q)).map((q) => [Math.round(q.x), Math.round(q.y)]),
      }
    }, corners)
  // pass 1: the box's plan diagonal against the free span at this tilt
  let d = Math.hypot(m.max[0] - m.min[0], m.max[2] - m.min[2]) / (CLOSEUP_SHARE * 2 * tanH)
  await fly(d)
  const f1 = await frame()
  const fill = Math.max(f1.spanPx[0] / f1.freeW, f1.spanPx[1] / f1.freeH)
  if (fill > 0) {
    d *= fill / CLOSEUP_SHARE
    await fly(d)
  }
  const file = await shot(`${bg}-mont-royal`, async () => {})
  const f = await frame()
  log('focus whole', 'mont-royal', { source: m.source, tris: m.triangles, radius: Math.round(m.radius), distance: Math.round(d), spanPx: f.spanPx })
  // …and the same landmark from LOW (polar 66°, a jump-cut): the iso pose
  // looks down on the canopy, and the dome's silhouette — the "not a cone"
  // of the brief — only reads against the skyline (not gated: a shot to read)
  const pose0 = await page.evaluate(() => window.__scene3d.getPose())
  const low = (66 * Math.PI) / 180
  const kLow = (yMid * Math.sin(low)) / Math.cos(low)
  await page.evaluate((p) => window.__scene3d.setPose(p), {
    polar: 66,
    targetX: cx - Math.sin(az) * kLow,
    targetZ: cz - Math.cos(az) * kLow,
    distance: d * 0.9 + yMid / Math.cos(low),
  })
  const lowFile = await shot(`${bg}-mont-royal-low`, async () => {})
  await page.evaluate((p) => window.__scene3d.setPose(p), pose0)
  return { file, lowFile, source: m.source, triangles: m.triangles, radius: m.radius, d: Math.round(d), spanPx: f.spanPx, misses: f.misses }
}

function mountGates(bg, c) {
  gate(
    `${bg}: Mont-Royal wears the Blender maquette (mont-royal.glb), not the procedural fallback`,
    c?.source === 'glb',
    c,
  )
  gate(`${bg}: Mont-Royal landmark <= ${MOUNT_TRIS_MAX} triangles`, !!c && c.triangles <= MOUNT_TRIS_MAX, c && { triangles: c.triangles })
  gate(
    `${bg}: Mont-Royal close-up — whole on the unobstructed canvas and >= 300 px across`,
    !!c && c.misses.length === 0 && Math.max(...c.spanPx) >= 300,
    c && { spanPx: c.spanPx, misses: c.misses },
  )
}

async function closeup(bg, archetype) {
  at(`${bg}: close-up ${archetype}`)
  const target = await focusWhole(archetype)
  if (!target) return null
  const file = await shot(`${bg}-${archetype}`, async () => {})
  return { file, d: target.d, ...(await evalPropFrame(archetype, target.index)) }
}

/**
 * CONNECT FREEZE (user report 2026-10-11, "quand je connecte deux shapes …
 * ça gèle"): reconnect a connection in 3D with the REAL pointer — click its
 * cable (selects it), drag its target dot onto another card, release — and
 * report the long tasks of the selection click and of the drop (from the
 * release until the scene and its label pass have settled: the pointerup,
 * the store echo, the write flush). Before the fix, on the dev landscape's
 * 67-connection diagram, the pointerup alone was one 2378-ms task: every
 * connection build re-ran the whole label placement pass (1072 ms) and the
 * release built the layer twice. The pick search is seeded at the projected
 * edit points (connEditPoints) — a whole-viewport pickAt scan is minutes long.
 */
/**
 * The drop window's long tasks, split: the connect's own (the pointerup,
 * the store echo, the write flush, the label slices) and the DEFERRED decor
 * refresh a data change schedules (300 ms debounce, then an idle callback,
 * then its compile gate — Scene3D.scheduleDecorRefresh), told apart by the
 * script their long animation frame names. The refresh is reported, not
 * gated here: on a cold-loaded dressed board it re-keys the fade-toggled
 * decor and dressing programs (`transparent` flipped by the morph fade
 * without a re-key) and its compile gate's first-use task measured 95-190
 * ms (tp5-connect3d, --reconnect-bg workbench) — a pre-existing cost of ANY
 * decor refresh (a node drag too), filed as its own task.
 */
/** Fit-to-screen with the real button, then wait for the camera to land. */
async function fitBoard() {
  await page.locator('[data-testid="canvas-zoom-fit"], [aria-label="Ajuster à l’écran"], [aria-label="Fit to screen"]').first().click().catch(() => {})
  await page.waitForTimeout(1200)
  await page.waitForFunction(() => !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 }).catch(() => {})
}

/** Quality pass "lines": the default (fit) framing, then the board seen
 * from the four sides at the iso polar, from low (75 deg) and from straight
 * above (5 deg) — jump-cut through the setPose probe, target and distance
 * kept — and a real selection. Each pose is shot as <bg>-arrows-<name>.png
 * and every line and arrowhead measured through the live camera
 * (arrowheadInfo), then read back from the PNG. Restores the fit pose. */
const ARROW_ORBIT_DISTANCE = 0.6
const ARROW_POSES = [
  ['az0', { azimuth: 0 }],
  ['az90', { azimuth: 90 }],
  ['az180', { azimuth: 180 }],
  ['az270', { azimuth: 270 }],
  ['low', { polar: 75 }],
  ['top', { polar: 5 }],
]

/** WCAG 2 relative luminance of an sRGB pixel / a css colour. */
function relLum(r, g, b) {
  const ch = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}
function cssRgb(css) {
  const m = String(css).match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/)
  if (m) return [+m[1], +m[2], +m[3]]
  const h = String(css).match(/^#([0-9a-f]{6})$/i)
  if (h) return [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16))
  return null
}
const ratioOf = (la, lb) => (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
const median = (a) => {
  const s = [...a].sort((p, q) => p - q)
  return s.length ? s[Math.floor(s.length / 2)] : NaN
}

/** The PNG's pixels at client-px points: for each point the (2·rad+1)² window
 * round it (image px; the PNG is the canvas element's box, shot()), or null
 * when the point is off the canvas or under page chrome (what the camera
 * sees there is not what the viewer gets). */
async function readPng(file, points) {
  const b64 = readFileSync(resolve(OUT, file)).toString('base64')
  return page.evaluate(
    async ({ b64, points }) => {
      const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
      const rect = canvas.getBoundingClientRect()
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
      const off = new OffscreenCanvas(bmp.width, bmp.height)
      const g = off.getContext('2d')
      g.drawImage(bmp, 0, 0)
      const img = g.getImageData(0, 0, bmp.width, bmp.height)
      const sx = bmp.width / rect.width
      const sy = bmp.height / rect.height
      return points.map((p) => {
        if (!(p.x >= rect.left + 1 && p.y >= rect.top + 1 && p.x <= rect.right - 1 && p.y <= rect.bottom - 1)) return null
        if (document.elementFromPoint(p.x, p.y) !== canvas) return null
        const cx = Math.round((p.x - rect.left) * sx)
        const cy = Math.round((p.y - rect.top) * sy)
        const rad = Math.round((p.rad ?? 0) * sx)
        const out = []
        for (let y = cy - rad; y <= cy + rad; y++) {
          for (let x = cx - rad; x <= cx + rad; x++) {
            const px = Math.min(bmp.width - 1, Math.max(0, x))
            const py = Math.min(bmp.height - 1, Math.max(0, y))
            const o = (py * bmp.width + px) * 4
            out.push([img.data[o], img.data[o + 1], img.data[o + 2]])
          }
        }
        return out
      })
    },
    { b64, points },
  )
}

/** Each line and head against the surface round it, in the SCREENSHOT
 * (what the viewer gets after lighting, the post stack and antialiasing):
 *  - a line sample: its core (the pixel of the 3×3 round the projected
 *    centre that contrasts most with the board) against the pixels 8 css px
 *    off either side — the WORSE of the two sides. Graded where both sides
 *    show the BOARD (the probe's `board`: no node or plate on the ray) — the
 *    spec's "on wood"; a side on a card, a drum or the walnut plinth is
 *    reported apart (`nodeMin`);
 *  - a head: the median of its interior pixels against the median of the
 *    board just past its casing off both flanks (>= 3 + >= 2 pixels). */
async function evalLineContrast(file, arrows) {
  const queries = []
  for (const a of arrows) {
    for (const s of a.line) queries.push({ ...s.c, rad: 1 }, { ...s.l, rad: 0 }, { ...s.r, rad: 0 })
    for (const p of a.face) queries.push({ ...p, rad: 0 })
    for (const p of a.ring) queries.push({ ...p, rad: 0 })
  }
  const px = await readPng(file, queries)
  let k = 0
  const lum = (rgb) => relLum(...rgb)
  return arrows.map((a) => {
    const samples = []
    const onNodes = []
    const fails = []
    for (let i = 0; i < a.line.length; i++) {
      const c = px[k++]
      const l = px[k++]
      const r = px[k++]
      if (!c || !l || !r) continue
      const ll = lum(l[0])
      const lr = lum(r[0])
      let best = 0
      let core = c[0]
      for (const p of c) {
        const v = Math.min(ratioOf(lum(p), ll), ratioOf(lum(p), lr))
        if (v > best) {
          best = v
          core = p
        }
      }
      ;(a.line[i].board ? samples : onNodes).push(+best.toFixed(2))
      if (a.line[i].board && best < LINE_MIN_CONTRAST) fails.push({ at: a.line[i].c, ratio: +best.toFixed(2), core, left: l[0], right: r[0] })
    }
    const face = []
    const ring = []
    for (let i = 0; i < a.face.length; i++) {
      const p = px[k++]
      if (p) face.push(lum(p[0]))
    }
    for (let i = 0; i < a.ring.length; i++) {
      const p = px[k++]
      if (p) ring.push(lum(p[0]))
    }
    const head = face.length >= 3 && ring.length >= 2 ? +ratioOf(median(face), median(ring)).toFixed(2) : null
    const passing = samples.filter((v) => v >= LINE_MIN_CONTRAST).length
    return {
      wire: a.wire,
      highlighted: a.highlighted,
      alpha: a.alpha,
      graded: samples.length,
      share: samples.length ? +(passing / samples.length).toFixed(2) : null,
      min: samples.length ? Math.min(...samples) : null,
      median: samples.length ? median(samples) : null,
      nodeSamples: onNodes.length,
      nodeMin: onNodes.length ? Math.min(...onNodes) : null,
      fails,
      head,
    }
  })
}

const RIM_STEPS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6]
/** The selected shot's highlighted lines, read back where both sides show
 * the board: at each seen sample the 3×3 pixel round the centre nearest the
 * highlight colour (max channel error), and on each side the darkest pixel
 * 1-5 css px out — the ink rim — against the board 8 css px out and against
 * the core (WCAG ratios; the worse side). */
async function evalHighlightPixels(file, arrows) {
  const queries = []
  const lit = arrows.filter((a) => a.highlighted)
  const graded = lit.map((a) => a.line.filter((s) => s.board))
  for (const pts of graded) {
    for (const s of pts) {
      queries.push({ ...s.c, rad: 1 }, { ...s.l, rad: 0 }, { ...s.r, rad: 0 })
      const nx = (s.l.x - s.c.x) / 8
      const ny = (s.l.y - s.c.y) / 8
      // half-px steps, each a 3×3: a 1-px rim on a slanted line is a pixel
      // staircase a whole-px walk along its normal can step over
      for (const side of [1, -1]) for (const d of RIM_STEPS) queries.push({ x: s.c.x + nx * d * side, y: s.c.y + ny * d * side, rad: 1 })
    }
  }
  const px = await readPng(file, queries)
  const coral = cssRgb(INK_HIGHLIGHT_CSS)
  const rim = cssRgb(INK_RIM_CSS)
  const err = (p, ref) => Math.max(...p.map((v, i) => Math.abs(v - ref[i])))
  let k = 0
  return lit.map((a, ai) => {
    const rows = []
    for (let i = 0; i < graded[ai].length; i++) {
      const c = px[k++]
      const l = px[k++]
      const r = px[k++]
      const sides = [0, 1].map(() => Array.from({ length: RIM_STEPS.length }, () => px[k++]))
      if (!c || !l || !r || sides.some((s) => s.some((p) => !p))) continue
      const core = c.reduce((best, p) => (err(p, coral) < err(best, coral) ? p : best))
      const rims = sides.map((s) => s.flat().reduce((best, p) => (relLum(...p) < relLum(...best) ? p : best)))
      const boards = [l[0], r[0]]
      const rimBoard = Math.min(...rims.map((p, j) => ratioOf(relLum(...p), relLum(...boards[j]))))
      const coreRim = Math.min(...rims.map((p) => ratioOf(relLum(...p), relLum(...core))))
      rows.push({ coreErr: err(core, coral), rimErr: Math.max(...rims.map((p) => err(p, rim))), rimBoard: +rimBoard.toFixed(2), coreRim: +coreRim.toFixed(2), core, rims })
    }
    return {
      wire: a.wire,
      graded: rows.length,
      coreOk: rows.filter((r) => r.coreErr <= INK_PIXEL_TOL).length,
      rimOk: rows.filter((r) => r.rimErr <= INK_PIXEL_TOL).length,
      rimBoardOk: rows.filter((r) => r.rimBoard >= LINE_MIN_CONTRAST).length,
      coreRimOk: rows.filter((r) => r.coreRim >= LINE_MIN_CONTRAST).length,
      rows,
    }
  })
}

/** Every DRAWN head (on screen, part of it seen) as the convex hull of its
 * projected triangle (arrowheadInfo hull.pts), against every drawn label
 * plate (labelScreenInfo): an overlap is a separating-axis gap under
 * -CUE_CLASH_TOL_PX (hullGap: negative = penetration). The label passes keep
 * every plate off the heads (Scene3D.inkHeadHulls). */
const CUE_CLASH_TOL_PX = Number(arg('cue-clash-tol-px', '0.5'))
function evalCueClash(arrows, plates) {
  const cues = []
  for (const a of arrows) {
    if (a.drawn && a.onScreen && a.visibleUi > 0 && a.hull?.pts?.length >= 3) cues.push({ wire: a.wire, connId: a.connId, hull: a.hull.pts })
  }
  const plateHulls = plates.map((p) => ({ text: p.text, connId: p.connId, hull: hull2d(p.pts) }))
  const cuePlate = []
  for (const c of cues) {
    for (const p of plateHulls) {
      const g = hullGap(c.hull, p.hull)
      if (g < -CUE_CLASH_TOL_PX) cuePlate.push({ wire: c.wire, label: p.text, gapPx: +g.toFixed(1) })
    }
  }
  return { cues: cues.length, plates: plateHulls.length, cuePlate }
}

/** Deselect the way a user does: a click on empty board. True when nothing
 * is selected after it. */
async function deselectOnBoard() {
  const free = await page.evaluate(() => {
    const c = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop().getBoundingClientRect()
    // the middle first (the fit framings), then the whole canvas (a close
    // view can fill the middle with cards and lines)
    const fxs = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75]
    for (const [y0, y1] of [[0.3, 0.9], [0.1, 0.95]]) {
      for (let fy = y0; fy <= y1; fy += 0.05) {
        for (const fx of fxs) {
          const x = c.left + c.width * fx
          const y = c.top + c.height * fy
          const el = document.elementFromPoint(x, y)
          if (el && el.tagName === 'CANVAS' && window.__scene3d.pickAt(x, y) === null) return { x, y }
        }
      }
    }
    return null
  })
  if (free) await page.mouse.click(free.x, free.y)
  await page.mouse.move(5, 500)
  await page.waitForFunction(() => window.__scene3d.selectionIds().length === 0, undefined, { timeout: 5000 }).catch(() => {})
  const cleared = await page.evaluate(() => window.__scene3d.selectionIds().length === 0)
  if (!cleared) log('deselect: a click on empty board left the selection', JSON.stringify(free))
  return cleared
}

/** Restyle connection `id` with the real UI: click its line on the canvas,
 * then the properties panel's line-style button; wait for the store. */
async function setLineStyle(id, at, type) {
  await page.mouse.click(at.x, at.y)
  await page
    .waitForFunction((cid) => window.__scene3d.selectionIds().includes(cid) && !window.__scene3d.isCameraAnimating(), id, { timeout: 10000 })
    .catch(() => {})
  // (a missing button reports through the type read back, not a throw)
  await page.locator(`[data-testid="connection-line-${type}"]`).click({ timeout: 8000 }).catch(() => log('line-style button missing', type))
  await page
    .waitForFunction(
      ([cid, t]) => (window.__modelStore.getState().connections.find((c) => c.id === cid)?.type ?? 'solid') === t,
      [id, type],
      { timeout: 10000 },
    )
    .catch(() => {})
  return page.evaluate((cid) => window.__modelStore.getState().connections.find((c) => c.id === cid)?.type ?? 'solid', id)
}

/** Quality pass "lines", design review round 2: the dash rhythm had no
 * rendered evidence (only inkLine.test.ts). Two lines — the longest runs
 * over open board in a close top view — are restyled dashed and dotted with
 * the real UI, shot from straight above, and their rhythm read back from
 * the PNG along the centreline (arrowheadInfo dash.pts, every 0.5 world px
 * of arc): a sample is ink when its pixel is darker than 30 % of the way
 * from the line's darkest fifth to its brightest; an ink run's centre-to-centre
 * spacing is the period, its length the on-length (world px of arc). Both
 * lines are set back to solid afterwards (`restored`). */
async function evalDashes(bg, pose0, names) {
  at(`${bg}: dashes`)
  const pose = { ...pose0, polar: 5, distance: pose0.distance * DASH_SHOT_DISTANCE }
  await page.evaluate((p) => window.__scene3d.setPose(p), pose)
  await page.waitForFunction(() => !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 }).catch(() => {})
  await page.mouse.move(5, 500)
  await page.waitForTimeout(600)
  // (a sample under a side panel is no place to click: round-2 run 1 clicked
  // 'ships' through the properties panel and restyled nothing)
  // ranked by the on-screen length of their open-board run (a sample count
  // favours a short line seen whole over a long one half off the canvas)
  const picks = await page.evaluate(() => {
    const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
    return window.__scene3d
      .arrowheadInfo()
      .map((a) => {
        const pts = a.line.pts.filter((s) => s.board && document.elementFromPoint(s.c.x, s.c.y) === canvas)
        let run = 0
        for (let i = 1; i < pts.length; i++) run += Math.hypot(pts[i].c.x - pts[i - 1].c.x, pts[i].c.y - pts[i - 1].c.y)
        return { id: a.connId, pts, run }
      })
      .filter((a) => a.pts.length > 0)
      .sort((a, b) => b.run - a.run)
      .slice(0, 2)
      .map((a) => ({ id: a.id, at: a.pts[Math.floor(a.pts.length / 2)].c }))
  })
  const types = ['dashed', 'dotted']
  const styled = []
  for (let i = 0; i < picks.length; i++) styled.push({ ...picks[i], type: types[i], got: await setLineStyle(picks[i].id, picks[i].at, types[i]) })
  // the rhythm is read on plain ink lines: nothing selected (a highlighted
  // line's centre alternates coral core and ink rim — round-2 run 1 read a
  // 2.5-px "period" off the selected dotted line)
  let clearForShot = await deselectOnBoard()
  if (!clearForShot) {
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.__scene3d.selectionIds().length === 0, undefined, { timeout: 3000 }).catch(() => {})
    clearForShot = await page.evaluate(() => window.__scene3d.selectionIds().length === 0)
  }
  await page.waitForTimeout(800)
  const file = await shot(`${bg}-arrows-dashes`)
  const info = await page.evaluate(() => window.__scene3d.arrowheadInfo())
  const lines = []
  for (const s of styled) {
    const a = info.find((x) => x.connId === s.id)
    const d = a?.dash
    const spec = DASH_SPECS[s.type]
    if (!d || !spec) {
      lines.push({ wire: names[s.id] ?? s.id, type: s.type, got: s.got, ok: false, why: 'no dash info', runs: [] })
      continue
    }
    const px = await readPng(file, d.pts.map((p) => ({ x: p.x, y: p.y, rad: 0 })))
    const samples = d.pts.map((p, i) => ({ arc: p.arc, l: px[i] ? relLum(...px[i][0]) : null })).filter((q) => q.l !== null)
    const sorted = samples.map((q) => q.l).sort((p, q) => p - q)
    const fifth = Math.max(1, Math.floor(sorted.length / 5))
    const dark = median(sorted.slice(0, fifth))
    const light = median(sorted.slice(-fifth))
    // 30 % of the way up from the ink: the light fifth is the cream casing
    // (L ~0.67), and the bare wood a gap shows between two cased dots — a
    // 1-px slot on a dotted line, L 0.28 in a card's shadow — sits under the
    // midpoint (round-2 run 3 read those slots as dots: a 2.5-px "period")
    const thr = dark + 0.3 * (light - dark)
    // contiguous stretches (0.5-px steps), then the ink runs fully inside one
    const runs = []
    let seg = []
    const flush = () => {
      let start = null
      for (let i = 0; i < seg.length; i++) {
        const ink = seg[i].l < thr
        if (ink && start === null) start = i
        if ((!ink || i === seg.length - 1) && start !== null) {
          const end = ink ? i : i - 1
          if (start > 0 && end < seg.length - 1) runs.push({ from: seg[start].arc, to: seg[end].arc, len: seg[end].arc - seg[start].arc + 0.5 })
          start = null
        }
      }
      seg = []
    }
    for (const q of samples) {
      if (seg.length && q.arc - seg[seg.length - 1].arc > 0.51) flush()
      seg.push(q)
    }
    flush()
    const periods = []
    for (let i = 1; i < runs.length; i++) {
      const p = (runs[i].from + runs[i].to) / 2 - (runs[i - 1].from + runs[i - 1].to) / 2
      // consecutive dashes only (a run skipped behind a filtered sample would
      // read as a double period)
      if (p < (spec.period * d.scale) * 1.5) periods.push(+p.toFixed(2))
    }
    const expPeriod = spec.period * d.scale
    const pMed = periods.length ? median(periods) : null
    const onMed = runs.length ? median(runs.map((r0) => r0.len)) : null
    const regular = periods.length ? periods.filter((p) => Math.abs(p - expPeriod) <= spec.periodTol).length / periods.length : 0
    const ok =
      s.got === s.type &&
      d.scale <= 1.0001 &&
      periods.length >= 4 &&
      Math.abs(pMed - expPeriod) <= spec.periodTol &&
      Math.abs(onMed - spec.on) <= spec.onTol &&
      regular >= 0.8 &&
      light / Math.max(dark, 1e-4) >= 3
    lines.push({
      wire: names[s.id] ?? s.id,
      type: s.type,
      got: s.got,
      scale: d.scale,
      samples: samples.length,
      darkLum: +dark.toFixed(4),
      lightLum: +light.toFixed(4),
      runCount: runs.length,
      periodMedian: pMed,
      onMedian: onMed,
      periodsRegular: +regular.toFixed(2),
      periods: periods.slice(0, 12),
      ok,
      runs: runs.map((r0) => ({ from: r0.from, len: r0.len })),
    })
  }
  // back to solid, the way they were made dashed
  let restored = true
  for (const s of styled) {
    if (!s.got) continue
    if ((await setLineStyle(s.id, s.at, 'solid')) !== 'solid') restored = false
  }
  await deselectOnBoard()
  log(bg, 'dashes', lines.map((l) => `${l.type}:${l.wire}: period ${l.periodMedian} on ${l.onMedian} reg ${l.periodsRegular} scale ${l.scale} ok ${l.ok}`))
  return { file, pose: { polar: 5, distance: +pose.distance.toFixed(1) }, clearForShot, lines, restored }
}

async function evalArrows(bg) {
  at(`${bg}: lines`)
  await fitBoard()
  // off the board: no hover state on a wire
  await page.mouse.move(5, 500)
  const pose0 = await page.evaluate(() => window.__scene3d.getPose())
  const out = { url: page.url(), pose0, poses: {} }
  // who points at whom, for a reader of report.json
  const names = await page.evaluate(() => {
    const s = window.__modelStore.getState()
    const out = {}
    for (const o of s.objects ?? []) out[o.id] = o.name
    for (const c of s.connections ?? []) out[c.id] = `${out[c.fromId] ?? c.fromId} -> ${out[c.toId] ?? c.toId}`
    return out
  })
  const r = (v, d = 1) => +v.toFixed(d)
  // picking (spec: a click within 4 css px of a line's centre selects it):
  // per line, the three samples over open board nearest its middle, 4 css
  // px off the centre either side, square to the line on screen, through
  // the app's own pick (a pick between two lines or beside a card wall
  // rightly goes to the nearer / front one: open board only)
  const evalPicks = (arrows) =>
    page.evaluate((lines) => {
      const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
      return lines.map(({ connId, pts: all }) => {
        const pts = all.filter((s) => s.board)
        if (pts.length === 0) return { connId, tried: 0, ok: 0, missed: [] }
        const order = pts.map((_, i) => i).sort((a, b) => Math.abs(a - pts.length / 2) - Math.abs(b - pts.length / 2))
        let tried = 0
        let ok = 0
        const missed = []
        for (const i of order.slice(0, 3)) {
          const s = pts[i]
          for (const side of [0.5, -0.5]) {
            const x = s.c.x + (s.l.x - s.c.x) * side
            const y = s.c.y + (s.l.y - s.c.y) * side
            if (document.elementFromPoint(x, y) !== canvas) continue
            tried++
            const hit = window.__scene3d.pickAt(x, y)
            if (hit && (hit.kind === 'connection' || hit.kind === 'connLabel') && hit.id === connId) ok++
            else missed.push({ x: Math.round(x), y: Math.round(y), got: hit })
          }
        }
        return { connId, tried, ok, missed }
      })
    }, arrows.map((a) => ({ connId: a.connId, pts: a.line })))
  const measure = async (name, setup) => {
    const file = await shot(`${bg}-arrows-${name}`, setup)
    const pose = await page.evaluate(() => window.__scene3d.getPose())
    const info = await page.evaluate(() => window.__scene3d.arrowheadInfo())
    const layer = await page.evaluate(() => window.__scene3d.connLayerInfo())
    const arrows = info.map((a) => {
      const widths = a.line.pts.map((p) => ({ w: p.widthPx, f: p.f }))
      const square = widths.filter((p) => p.f >= 0.45)
      return {
        connId: a.connId,
        wire: names[a.connId] ?? a.connId,
        toId: a.toId,
        kind: a.kind,
        ink: a.ink,
        drawn: a.drawn,
        lengthPx: r(a.lengthPx),
        widthPx: r(a.widthPx),
        sizePx: r(a.sizePx),
        scale: r(a.scale, 3),
        onScreen: a.onScreen,
        visibleUi: r(a.visibleFraction, 2),
        tipClear: r(a.tipClear, 2),
        highlighted: a.highlighted,
        alpha: a.alpha,
        css: a.css,
        strokeCss: a.strokeCss,
        casing: a.casing,
        hull: a.hull,
        face: a.face,
        ring: a.ring,
        line: a.line.pts,
        lineSamples: a.line.samples,
        lineSeen: a.line.seen,
        // the core's projected width (the shader's floor + grazing, the
        // probe's CPU mirror): thinnest where seen square, thinnest anywhere
        minCoreSquarePx: square.length ? Math.min(...square.map((p) => p.w)) : null,
        minCorePx: widths.length ? Math.min(...widths.map((p) => p.w)) : null,
      }
    })
    const plates = await page.evaluate(() => window.__scene3d.labelScreenInfo().labels)
    const clash = evalCueClash(arrows, plates)
    const contrast = await evalLineContrast(file, arrows)
    const pick = await evalPicks(arrows)
    const shown = arrows.filter((a) => a.drawn && a.onScreen)
    return {
      file,
      pose: { polar: r(pose.polar), azimuth: r(pose.azimuth), distance: r(pose.distance) },
      layer,
      arrows: arrows.map(({ line, ...rest }) => ({ ...rest, line: line.length })),
      raw: arrows,
      contrast,
      clash,
      pick,
      summary: {
        count: arrows.length,
        drawn: arrows.filter((a) => a.drawn).length,
        onScreen: shown.length,
        minSizePx: shown.length ? Math.min(...shown.map((a) => a.sizePx)) : 0,
        minLengthPx: shown.length ? Math.min(...shown.map((a) => a.lengthPx)) : 0,
        linesSeen: arrows.filter((a) => a.lineSeen > 0).length,
      },
    }
  }
  out.poses.default = await measure('default')
  // the orbit poses frame the board closer than fit: at the fit distance a
  // 75-deg view of this board is a sliver (tp5-arrows-dbg3/workbench-
  // arrows-low.png: the whole diagram ~120 px tall) and nothing on it can be
  // graded by eye
  for (const [name, p] of ARROW_POSES) {
    const target = { polar: pose0.polar, azimuth: pose0.azimuth, distance: pose0.distance * ARROW_ORBIT_DISTANCE, ...p }
    out.poses[name] = await measure(name, () => page.evaluate((pp) => window.__scene3d.setPose(pp), target))
  }
  // a SELECTION, with the real pointer: the card with the most outgoing
  // wires is clicked — its wires highlight (coral core, ink rim), every
  // other line dims (focus mode). The click must link no shader program,
  // then a click on empty board clears it.
  await page.evaluate((p) => window.__scene3d.setPose(p), { ...pose0, distance: pose0.distance * ARROW_ORBIT_DISTANCE })
  await page.waitForFunction(() => !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(400)
  const card = await page.evaluate(() => {
    const conns = window.__modelStore.getState().connections
    const out = new Map()
    for (const c of conns) out.set(c.fromId, (out.get(c.fromId) ?? 0) + 1)
    const boxes = window.__scene3d.nodeScreenBoxes().sort((a, b) => (out.get(b.id) ?? 0) - (out.get(a.id) ?? 0))
    for (const b of boxes) {
      for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.35], [0.4, 0.5], [0.6, 0.5]]) {
        const x = b.x + b.w * fx
        const y = b.y + b.h * fy
        const el = document.elementFromPoint(x, y)
        if (!el || !el.closest('[data-testid="canvas-3d"]')) continue
        const p = window.__scene3d.pickAt(x, y)
        if (p && p.kind === 'object' && p.id === b.id) return { id: b.id, x, y, outgoing: out.get(b.id) ?? 0 }
      }
    }
    return null
  })
  if (card) {
    const keys = () => page.evaluate(() => window.__scene3d.perfInfo().programKeys)
    const before = await keys()
    await page.mouse.click(card.x, card.y)
    await page
      .waitForFunction((id) => window.__scene3d.selectionIds().includes(id) && !window.__scene3d.isCameraAnimating(), card.id, { timeout: 10000 })
      .catch(() => {})
    await page.mouse.move(5, 500)
    await page.waitForTimeout(800)
    const after = await keys()
    const left = [...before]
    const added = []
    for (const k of after) {
      const i = left.indexOf(k)
      if (i >= 0) left.splice(i, 1)
      else added.push(k)
    }
    out.selected = { card, programsAdded: added, ...(await measure('selected')) }
    const deselect = deselectOnBoard
    out.selected.clearedAfter = await deselect()
    // ONE line selected with the real pointer — the one with the longest
    // run over open board (the clicked card's own wires may be stubs hugging
    // a plinth or a drum, where the rim lies under them): its coral core and
    // ink rim read back from the PNG
    const longest = await page.evaluate(() => {
      const info = window.__scene3d.arrowheadInfo()
      const best = info
        .map((a) => ({ id: a.connId, pts: a.line.pts.filter((s) => s.board) }))
        .sort((a, b) => b.pts.length - a.pts.length)[0]
      if (!best || best.pts.length === 0) return null
      const s = best.pts[Math.floor(best.pts.length / 2)]
      return { id: best.id, x: s.c.x, y: s.c.y }
    })
    if (longest) {
      await page.mouse.click(longest.x, longest.y)
      await page
        .waitForFunction((id) => window.__scene3d.selectionIds().includes(id) && !window.__scene3d.isCameraAnimating(), longest.id, { timeout: 10000 })
        .catch(() => {})
      await page.mouse.move(5, 500)
      await page.waitForTimeout(800)
      out.selectedLine = { line: longest, selected: await page.evaluate(() => window.__scene3d.selectionIds()), ...(await measure('selected-line')) }
      out.selectedLine.highlightPixels = await evalHighlightPixels(out.selectedLine.file, out.selectedLine.raw)
      // the target knob against its head: a knob is never drawn while the
      // head beside it is hidden behind its own target (design review round
      // 2: a pale x-ray disc on the Log store drum, no arrow beside it)
      out.selectedLine.knob = await page.evaluate((id) => {
        const h = window.__scene3d.editHandleInfo()
        const a = window.__scene3d.arrowheadInfo().find((x) => x.connId === id)
        const knob = h?.handles.find((x) => x.role === 'knob')
        return { knobVisible: !!knob?.visible, knobOccluded: h?.knobOccluded ?? null, headVisible: a?.visibleFraction ?? null }
      }, longest.id)
      out.selectedLine.clearedAfter = await deselect()
    }
  }
  out.dashes = await evalDashes(bg, pose0, names)
  await page.evaluate((p) => window.__scene3d.setPose(p), pose0)
  await page.waitForFunction(() => !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 }).catch(() => {})
  out.connections = await page.evaluate(() => window.__scene3d.connectionIds().length)
  // the per-sample point lists are the report's bulk: dropped once graded
  for (const p of [...Object.values(out.poses), out.selected, out.selectedLine]) if (p) delete p.raw
  log(bg, 'lines', Object.fromEntries(Object.entries(out.poses).map(([k, v]) => [k, v.summary])))
  return out
}

/**
 * Quality pass "selected line" (user 2026-10-12: "améliorer aussi le visuel
 * quand on sélectionne la ligne, ça n'est pas jolie en ce moment", with
 * user-ref/selected-line-dark.webp): ONE connection selected with the real
 * pointer, in BOTH appearances — light app on the honey-wood board, dark app
 * on the default dark-stone board (the user's) — framed on that line, shot
 * at iso / top / low and the close framing of the user's screenshot as
 * <bg>-selected-line-<light|dark>-<pose>.png. Measured through the probe's
 * CPU mirror (arrowheadInfo, editHandleInfo) AND read back from the PNG:
 * the core colour, its edge against the board, the selection halo, and each
 * handle's ring at 4 css px from its centre (paper) but not at 8 (its size
 * and roundness on screen). The click must link no shader program. The
 * spec's numbers are mirrored here (this harness cannot import TS):
 * inkLine.INK_HIGHLIGHT_* / INK_HEAD_MAX_*, editHandle.HANDLE_*.
 */
const SEL_CORE_CSS = [2.5, 4]
const SEL_RIM_CSS = [1, 1.5]
const SEL_HEAD_LEN_CSS = [11, 16]
const SEL_HEAD_WIDTH_CSS = [10, 14]
const SEL_HANDLE_D = 10
const SEL_HANDLE_D_HOT = 12
// the target knob's centre on the head's tip, as the 2D canvas draws its
// destination dot on toEdge (user 2026-10-12: "le arrow doit toucher le dot,
// en ce moment le dot est avant" — the spec had it 5 css behind the base)
const SEL_KNOB_TIP_MAX = 1.5
// the unselected lines' ceilings (inkLine.INK_CORE_MAX_CSS) and the
// hierarchy the spec asks for (selected core >= 1.33x an unselected one at
// the same spot)
const SEL_PLAIN_CORE_CSS = [1.75, 3]
const SEL_RATIO_MIN = 1.33
// the bead's body (half INK_PACKET.lenCss) stays this far from every handle
// and the head wherever it is drawn at all
const SEL_BEAD_CLEAR = 12
const SEL_BEAD_HALF = 4.5
// read-back effective opacity of the selection halo 1.5 css px outside the
// rim (spec: 0.65 cream / 0.30 coral at the rim edge, smoothstep over 4 / 5
// css px — 0.42 / 0.24 there); the dark round-1 read-back was ~0.49
const SEL_HALO_EFF = { light: [0.25, 0.55], dark: [0.1, 0.36] }
// the head's coral read across it at 80 % of its length, on screen (>= 0.8 x
// the 10-css floor, less ~1.5 px of antialiased edge), and against the core's
const SEL_HEAD_RUN_MIN = 6.5
const SEL_HEAD_RUN_RATIO = 1.5
const SEL_PRESSED = { light: '#B85E26', dark: '#F4B589' }
const SEL_APPEARANCES = [
  { name: 'light', scheme: 'light', board: 'wood', inkSet: 'darkInk', coral: '#D97A3D', rim: '#3A362F', paper: '#FFFFFF' },
  { name: 'dark', scheme: 'dark', board: 'default', inkSet: 'lightInk', coral: '#E89456', rim: '#161513', paper: '#F2F0EC' },
]
const SEL_LINE_LABEL = 'publishes'

async function setAppearance(a) {
  await page.emulateMedia({ colorScheme: a.scheme })
  const target = page.locator(`[data-testid="decor-board-${a.board}"]`)
  if (!(await target.isVisible().catch(() => false))) await page.locator('[data-testid="decor-open"]').click()
  await target.click()
  if (await page.locator('[data-testid="decor-bg-default"]').isVisible().catch(() => false)) await page.locator('[data-testid="decor-open"]').click()
  await page
    .waitForFunction((s) => window.__scene3d?.connLayerInfo().inkSet === s && !window.__scene3d.isCameraAnimating(), a.inkSet, { timeout: 60000 })
    .catch(() => log('appearance: ink set did not reach', a.inkSet))
  await firstFrameMeasured()
  await page.waitForTimeout(1500)
  return page.evaluate(() => ({ inkSet: window.__scene3d.connLayerInfo().inkSet, dark: window.matchMedia('(prefers-color-scheme: dark)').matches }))
}

async function evalSelectedLines(bg) {
  at(`${bg}: selected line`)
  const pose0 = await page.evaluate(() => window.__scene3d.getPose())
  const out = { pose0, appearances: {} }
  const conn = await page.evaluate((label) => {
    const names = Object.fromEntries(window.__modelStore.getState().connections.map((c) => [c.id, c.label]))
    const ids = window.__scene3d.connectionIds()
    const id = ids.find((i) => names[i] === label) ?? ids[0]
    return { id, label: names[id], e: window.__scene3d.connEditPoints(id) }
  }, SEL_LINE_LABEL)
  out.line = { id: conn.id, label: conn.label }
  const cx = (conn.e.from.x + conn.e.to.x) / 2
  const cz = (conn.e.from.y + conn.e.to.y) / 2
  const len = Math.hypot(conn.e.to.x - conn.e.from.x, conn.e.to.y - conn.e.from.y)
  const D = Math.max(len * 2.9, 420)
  const frame = { ...pose0, distance: D, targetX: cx, targetZ: cz }
  const POSES = [
    ['iso', {}],
    ['top', { polar: 5 }],
    ['low', { polar: 75 }],
    // close on the line's middle, the iso polar
    ['close', { distance: D * 0.45 }],
    // the user's own framing (design-ref-selected close-target): close on
    // the TARGET end, head and knob in view, clear of the side panels —
    // its target is set once the line is selected (the knob's spot)
    ['close-target', { distance: D * 0.4, polar: 40 }],
  ]
  for (const ap of SEL_APPEARANCES) {
    at(`${bg}: selected line (${ap.name})`)
    const r = { set: await setAppearance(ap), shots: {} }
    await page.evaluate((p) => window.__scene3d.setPose(p), frame)
    await page.waitForFunction(() => !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 }).catch(() => {})
    await page.mouse.move(5, 500)
    await page.waitForTimeout(600)
    // a point on the line over open board, near its middle
    const at0 = await page.evaluate((id) => {
      const a = window.__scene3d.arrowheadInfo().find((x) => x.connId === id)
      const pts = a.line.pts.filter((s) => s.board)
      const s = pts[Math.floor(pts.length / 2)] ?? a.line.pts[Math.floor(a.line.pts.length / 2)]
      return s ? { x: s.c.x, y: s.c.y } : null
    }, conn.id)
    if (!at0) {
      out.appearances[ap.name] = { ...r, error: 'no point of the line on screen' }
      continue
    }
    const keys = () => page.evaluate(() => window.__scene3d.perfInfo().programKeys)
    const mem = () => page.evaluate(() => {
      const st = window.__scene3d.sceneStats()
      return { geometries: st.geometries, textures: st.textures }
    })
    r.memBefore = await mem()
    const before = await keys()
    await page.mouse.click(at0.x, at0.y)
    await page
      .waitForFunction((id) => window.__scene3d.selectionIds().includes(id) && !window.__scene3d.isCameraAnimating(), conn.id, { timeout: 10000 })
      .catch(() => {})
    await page.mouse.move(5, 500)
    await page.waitForTimeout(800)
    const after = await keys()
    const left = [...before]
    r.programsAdded = []
    for (const k of after) {
      const i = left.indexOf(k)
      if (i >= 0) left.splice(i, 1)
      else r.programsAdded.push(k)
    }
    r.selected = await page.evaluate(() => window.__scene3d.selectionIds())
    r.layer = await page.evaluate(() => window.__scene3d.connLayerInfo())
    r.flow = await page.evaluate(() => window.__scene3d.flowInfo())
    // the knob's spot (on the drawn line behind the head): the close-target
    // framing's target
    const tgt = await page.evaluate((id) => window.__scene3d.connEditPoints(id)?.to ?? null, conn.id)
    for (const [pose, p] of POSES) {
      const pp = pose === 'close-target' && tgt ? { ...frame, ...p, targetX: tgt.x, targetZ: tgt.y } : { ...frame, ...p }
      const file = await shot(`${bg}-selected-line-${ap.name}-${pose}`, () => page.evaluate((q) => window.__scene3d.setPose(q), pp))
      const probe = await page.evaluate((id) => {
        const s = window.__scene3d
        const all = s.arrowheadInfo()
        const a = all.find((x) => x.connId === id)
        const h = s.editHandleInfo()
        const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
        // on the UNOBSTRUCTED canvas: no side panel, toolbar or chip over it
        const free = (q) => document.elementFromPoint(q.x, q.y) === canvas
        const headFree = !!a && [a.screenTri.tip, a.screenTri.base, a.screenTri.a, a.screenTri.b].every(free)
        const handles = (h?.handles ?? []).map((x) => {
          const f = x.visible && free(x)
          return { ...x, free: f, pick: f ? s.pickAt(x.x, x.y) : null }
        })
        const others = all
          .filter((x) => x.connId !== id && x.ink)
          .map((x) => ({
            id: x.connId,
            highlighted: x.highlighted,
            cores: x.line.pts.map((q) => q.widthPx),
            // each width over the zoom growth of its ceiling (inkLine.inkCapGrowth)
            coresN: x.line.pts.map((q) => q.widthPx / q.capK),
            head: x.onScreen ? { len: +x.lengthPx.toFixed(2), th: +x.thicknessPx.toFixed(2), w: +x.widthPx.toFixed(2), capK: x.capK } : null,
          }))
        return { a, h: h && { ...h, handles }, headFree, others }
      }, conn.id)
      r.shots[pose] = { file, ...(await evalSelectedShot(file, probe, ap)) }
    }
    // hover the target knob (the iso framing): it glows and grows, the
    // cursor is the 2D crosshair
    await page.evaluate((p) => window.__scene3d.setPose(p), frame)
    await page.waitForFunction(() => !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(400)
    const hinfo = await page.evaluate(() => window.__scene3d.editHandleInfo())
    const knob = hinfo?.handles.find((x) => x.role === 'knob' && x.visible)
    if (knob) {
      await page.mouse.move(knob.x, knob.y)
      await page.waitForTimeout(400)
      r.hover = await page.evaluate(() => {
        const h = window.__scene3d.editHandleInfo()
        const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
        return { hover: h.hover, knob: h.handles.find((x) => x.role === 'knob'), cursor: canvas.style.cursor }
      })
      // pressing the head is the target grip too; hovering it lights the
      // knob and brightens the halo (+20 %)
      const head = hinfo.head
      if (head) {
        const hc = { x: (head[0].x + head[1].x + head[2].x) / 3, y: (head[0].y + head[1].y + head[2].y) / 3 }
        r.headGrip = await page.evaluate(([x, y]) => window.__scene3d.pickAt(x, y), [hc.x, hc.y])
        await page.mouse.move(5, 500)
        await page.waitForTimeout(250)
        await page.mouse.move(hc.x, hc.y)
        await page.waitForTimeout(400)
        r.headHover = await page.evaluate(() => {
          const h = window.__scene3d.editHandleInfo()
          return { hover: h.hover, haloOpacity: h.haloOpacity, haloBase: h.haloBase }
        })
      }
      await page.mouse.move(5, 500)
      await page.waitForTimeout(300)
    }
    // the flow bead over three cycles at the iso and the low framing: every
    // frame its centre and fade, the handles and the head as drawn
    r.bead = {}
    for (const [pose, p] of [['iso', {}], ['low', { polar: 75 }]]) {
      await page.evaluate((q) => window.__scene3d.setPose(q), { ...frame, ...p })
      await page.waitForFunction(() => !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 }).catch(() => {})
      await page.waitForTimeout(300)
      r.bead[pose] = await page.evaluate(async () => {
        const out = []
        const t0 = performance.now()
        while (performance.now() - t0 < 4600) {
          await new Promise((res) => requestAnimationFrame(() => res()))
          const h = window.__scene3d.editHandleInfo()
          if (!h?.bead) continue
          out.push({ b: h.bead, hs: h.handles.filter((x) => x.visible).map((x) => ({ x: x.x, y: x.y, r: x.diameterPx / 2 })), head: h.head })
        }
        return out
      })
    }
    // the drag at the whole-board framing: other cards to drop on in view
    await page.evaluate((q) => window.__scene3d.setPose(q), pose0)
    await page.waitForFunction(() => !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(400)
    r.drag = await evalSelectedDrag(bg, ap, conn.id)
    r.shortLine = await evalShortLine(conn.id, frame)
    await page.evaluate((q) => window.__scene3d.setPose(q), frame)
    await page.waitForFunction(() => !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(400)
    // prefers-reduced-motion: re-selected with the real pointer, no bead
    r.reduced = await evalReducedMotionBead(conn.id)
    r.clearedAfter = await deselectOnBoard()
    await page.waitForTimeout(600)
    r.mem = { before: r.memBefore, after: await mem() }
    // a second select / deselect cycle, real pointer
    const again = await selLinePoint(conn.id)
    if (again) {
      await page.mouse.click(again.x, again.y)
      await page.waitForFunction((id) => window.__scene3d.selectionIds().includes(id), conn.id, { timeout: 8000 }).catch(() => {})
      await page.mouse.move(5, 500)
      await page.waitForTimeout(600)
      await deselectOnBoard()
      await page.waitForTimeout(600)
      r.mem.again = await mem()
    }
    out.appearances[ap.name] = r
  }
  // back to the run's own appearance and board
  at(`${bg}: selected line (restore)`)
  out.restored = await setAppearance(SEL_APPEARANCES[0])
  await page.evaluate((p) => window.__scene3d.setPose(p), pose0)
  await page.waitForFunction(() => !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 }).catch(() => {})
  return out
}

/** A point of line `id` over open board near its middle (client px). */
function selLinePoint(id) {
  return page.evaluate((id) => {
    const a = window.__scene3d.arrowheadInfo().find((x) => x.connId === id)
    if (!a) return null
    const pts = a.line.pts.filter((s) => s.board)
    const s = pts[Math.floor(pts.length / 2)] ?? a.line.pts[Math.floor(a.line.pts.length / 2)]
    return s ? { x: s.c.x, y: s.c.y } : null
  }, id)
}

const rgbErr = (p, ref) => Math.max(...p.map((v, i) => Math.abs(v - ref[i])))

/**
 * The endpoint drag with the real pointer (spec §4.1 d, §4.3): press the
 * source handle (it fills coral-800, read back from the PNG), drag it over
 * open board (the preview is a dashed 2-css coral ink line, the dragged
 * handle rides the cursor at 12), then over a card that is neither end (its
 * 12 drop anchors: 6-px bodies, the snapped one 10), back to open board and
 * release there — nothing is written.
 */
async function evalSelectedDrag(bg, ap, id) {
  const h0 = await page.evaluate(() => window.__scene3d.editHandleInfo())
  const src = h0?.handles.find((x) => x.role === 'source' && x.visible)
  if (!src) return { error: 'no source handle' }
  const ends = () =>
    page.evaluate((id) => {
      const c = window.__modelStore.getState().connections.find((k) => k.id === id)
      return { fromId: c.fromId, toId: c.toId, fromAnchor: c.fromAnchor ?? null, toAnchor: c.toAnchor ?? null }
    }, id)
  const before = await ends()
  // open board: nothing picks there (a group's plate is a drop target too —
  // the diagram's system boundary covers most of the board), the nearest
  // such point to the handle on the unobstructed canvas
  const empty = await page.evaluate(([sx, sy]) => {
    const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
    const c = canvas.getBoundingClientRect()
    let best = null
    for (let y = c.top + 20; y < c.bottom - 20; y += 16) {
      for (let x = c.left + 20; x < c.right - 20; x += 16) {
        const d = Math.hypot(x - sx, y - sy)
        if (d < 40 || (best && d >= best.d)) continue
        if (document.elementFromPoint(x, y) === canvas && window.__scene3d.pickAt(x, y) === null) best = { x, y, d }
      }
    }
    return best
  }, [src.x, src.y])
  if (!empty) return { error: 'no open board near the source handle' }
  const steps = async (from, to, n = 10) => {
    for (let i = 1; i <= n; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / n, from.y + ((to.y - from.y) * i) / n)
  }
  await page.mouse.move(src.x, src.y)
  await page.waitForTimeout(250)
  await page.mouse.down()
  await page.waitForTimeout(350)
  const press = await page.evaluate(() => window.__scene3d.editHandleInfo())
  const pressedFile = await shot(`${bg}-selected-line-${ap.name}-pressed`)
  const pressedRef = cssRgb(SEL_PRESSED[ap.name])
  const [win] = await readPng(pressedFile, [{ x: src.x, y: src.y, rad: 1 }])
  const pressedPx = win ? win.reduce((best, p) => (rgbErr(p, pressedRef) < rgbErr(best, pressedRef) ? p : best)) : null
  await steps(src, empty)
  await page.waitForTimeout(450)
  const drag = await page.evaluate(() => {
    const h = window.__scene3d.editHandleInfo()
    return { preview: h?.preview ?? null, dragHandle: h?.handles.find((x) => x.role === 'drag') ?? null, pressId: h?.pressId }
  })
  await shot(`${bg}-selected-line-${ap.name}-drag`)
  const card = await page.evaluate(([from, to]) => {
    for (const b of window.__scene3d.nodeScreenBoxes()) {
      if (b.id === from || b.id === to || b.w <= 12 || b.h <= 8) continue
      const x = b.x + b.w / 2
      const y = b.y + b.h / 2
      const el = document.elementFromPoint(x, y)
      if (!el || !el.closest('[data-testid="canvas-3d"]')) continue
      const p = window.__scene3d.pickAt(x, y)
      if (p && p.kind === 'object' && p.id !== from && p.id !== to) return { id: p.id, x, y }
    }
    return null
  }, [before.fromId, before.toId])
  let anchors = null
  if (card) {
    await steps(empty, card)
    await page.waitForTimeout(450)
    anchors = await page.evaluate(() => (window.__scene3d.editHandleInfo()?.handles ?? []).filter((x) => x.role === 'anchor').map((x) => ({ kind: x.kind, d: x.diameterPx, body: x.bodyPx, visible: x.visible })))
    await shot(`${bg}-selected-line-${ap.name}-anchors`)
    await steps(card, empty)
    await page.waitForTimeout(300)
  }
  await page.mouse.up()
  await page.waitForTimeout(900)
  const after = await ends()
  await page.mouse.move(5, 500)
  return {
    pressId: press?.pressId ?? null,
    pressedPx,
    pressedErr: pressedPx ? rgbErr(pressedPx, pressedRef) : null,
    drag,
    card: card?.id ?? null,
    anchors,
    unchanged: JSON.stringify(before) === JSON.stringify(after),
    stillSelected: await page.evaluate((id) => window.__scene3d.selectionIds().includes(id), id),
  }
}

/** Zoom out on the selected line until it is short on screen (spec §4.2):
 * the target knob hides and the head alone is the target grip. */
async function evalShortLine(id, frame) {
  for (let k = 0; k < 14; k++) {
    const distance = frame.distance * Math.pow(1.5, k + 1)
    await page.evaluate((q) => window.__scene3d.setPose(q), { ...frame, distance })
    await page.waitForTimeout(250)
    const s = await page.evaluate(() => {
      const h = window.__scene3d.editHandleInfo()
      if (!h) return null
      const src = h.handles.find((x) => x.role === 'source')
      const knob = h.handles.find((x) => x.role === 'knob')
      const head = h.head
      const hc = head ? { x: (head[0].x + head[1].x + head[2].x) / 3, y: (head[0].y + head[1].y + head[2].y) / 3 } : null
      return {
        knobVisible: !!knob?.visible,
        knobOccluded: h.knobOccluded,
        sourceVisible: !!src?.visible,
        // where the knob would sit: its spot is updated even while hidden
        knobToSourcePx: src && knob ? +Math.hypot(knob.x - src.x, knob.y - src.y).toFixed(2) : null,
        headPick: hc ? window.__scene3d.pickAt(hc.x, hc.y) : null,
      }
    })
    if (s && !s.knobVisible && !s.knobOccluded) return { reached: true, distance: Math.round(distance), ...s }
  }
  return { reached: false }
}

/** prefers-reduced-motion (spec §5): the line re-selected with the real
 * pointer draws no bead — no flow unit, no bead on the probe. */
async function evalReducedMotionBead(id) {
  const reselect = async () => {
    await deselectOnBoard()
    await page.waitForTimeout(400)
    const p = await selLinePoint(id)
    if (p) await page.mouse.click(p.x, p.y)
    await page.waitForFunction((id) => window.__scene3d.selectionIds().includes(id), id, { timeout: 8000 }).catch(() => {})
    await page.mouse.move(5, 500)
    await page.waitForTimeout(700)
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await reselect()
  const out = await page.evaluate((id) => {
    const h = window.__scene3d.editHandleInfo()
    return { selected: window.__scene3d.selectionIds().includes(id), flow: window.__scene3d.flowInfo(), bead: h?.bead ?? null, reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches }
  }, id)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await reselect()
  out.restoredBead = await page.evaluate(() => !!window.__scene3d.editHandleInfo()?.bead)
  return out
}

/** Signed distance (css px) from point `p` to triangle `tri` (< 0 inside). */
function pointTriGap(p, tri) {
  const segD = (a, b) => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
    return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y)
  }
  const side = (a, b) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
  const s1 = side(tri[0], tri[1])
  const s2 = side(tri[1], tri[2])
  const s3 = side(tri[2], tri[0])
  const inside = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)
  const edge = Math.min(segD(tri[0], tri[1]), segD(tri[1], tri[2]), segD(tri[2], tri[0]))
  return inside ? -edge : edge
}

/** The bead samples graded: wherever it is drawn at all (fade > 0.02), its
 * body's clearance to every drawn handle edge and to the head triangle,
 * measured HERE from the probe's positions (not its own clearPx). */
function gradeBead(samples) {
  if (!samples?.length) return { samples: 0 }
  let drawn = 0
  let whole = 0
  let worst = Infinity
  const near = []
  const phases = new Set()
  for (const s of samples) {
    phases.add(Math.floor((s.b.phase ?? 0) * 10))
    if (s.b.fade <= 0.02) continue
    drawn++
    if (s.b.fade >= 0.99) whole++
    let c = Infinity
    for (const h of s.hs) c = Math.min(c, Math.hypot(s.b.x - h.x, s.b.y - h.y) - h.r)
    if (s.head) c = Math.min(c, pointTriGap(s.b, s.head))
    const body = c - SEL_BEAD_HALF
    worst = Math.min(worst, body)
    if (body < SEL_BEAD_CLEAR - 0.5) near.push({ fade: s.b.fade, body: +body.toFixed(2), at: [s.b.x, s.b.y] })
  }
  return { samples: samples.length, drawn, whole, phases: phases.size, worstBodyClearPx: +worst.toFixed(2), near: near.slice(0, 6), nearCount: near.length }
}

/** One selected-line shot, graded: the probe's mirror numbers and the PNG. */
async function evalSelectedShot(file, probe, ap) {
  const { a, h } = probe
  if (!a) return { error: 'line not in arrowheadInfo' }
  const pts = a.line.pts.filter((s) => s.board)
  const queries = []
  for (const s of pts) {
    const nx = (s.l.x - s.c.x) / 8
    const ny = (s.l.y - s.c.y) / 8
    const halfOut = s.widthPx / 2 + s.rimPx
    queries.push({ ...s.c, rad: 1 })
    for (const side of [1, -1]) for (const d of RIM_STEPS) queries.push({ x: s.c.x + nx * d * side, y: s.c.y + ny * d * side, rad: 1 })
    for (const side of [1, -1]) {
      // the board well clear of the halo; the halo near the rim and far out
      queries.push({ x: s.c.x + nx * 13 * side, y: s.c.y + ny * 13 * side, rad: 0 })
      queries.push({ x: s.c.x + nx * (halfOut + 1.5) * side, y: s.c.y + ny * (halfOut + 1.5) * side, rad: 0 })
      queries.push({ x: s.c.x + nx * (halfOut + 6) * side, y: s.c.y + ny * (halfOut + 6) * side, rad: 0 })
    }
  }
  // each visible handle: centre, its ring 4 css px out, outside it 8 px out
  const dirs = Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4), Math.sin((i * Math.PI) / 4)])
  const handles = (h?.handles ?? []).filter((x) => x.visible)
  // (the ring is 2 px wide, radius 3-5: read at 3.6, 4 and 4.4 — a whole-px
  // PNG sample at a fractional centre lands up to 0.7 px off)
  const RING_R = [3.6, 4, 4.4]
  for (const x of handles) {
    queries.push({ x: x.x, y: x.y, rad: 0 })
    for (const [dx, dy] of dirs) for (const rr of RING_R) queries.push({ x: x.x + dx * rr, y: x.y + dy * rr, rad: 0 })
    for (const [dx, dy] of dirs) queries.push({ x: x.x + dx * 8, y: x.y + dy * 8, rad: 0 })
  }
  // the head's coral read ACROSS its on-screen axis at 80 % of its length
  // (what the eye reads as its width), every 0.5 css px over ±12
  const RUN_STEP = 0.5
  const T = a.screenTri
  const axL = Math.hypot(T.base.x - T.tip.x, T.base.y - T.tip.y) || 1
  const ux = (T.base.x - T.tip.x) / axL
  const uy = (T.base.y - T.tip.y) / axL
  const headScan = probe.headFree && a.visibleFraction >= 0.6
  const scanN = Math.round(12 / RUN_STEP)
  if (headScan) {
    const c = { x: T.tip.x + ux * axL * 0.8, y: T.tip.y + uy * axL * 0.8 }
    for (let i = -scanN; i <= scanN; i++) queries.push({ x: c.x - uy * i * RUN_STEP, y: c.y + ux * i * RUN_STEP, rad: 0 })
  }
  // …and the core's, the same way, at up to 4 open-board samples
  const coreScans = pts.slice(0, 4)
  const coreN = Math.round(6 / RUN_STEP)
  for (const s of coreScans) {
    const nx = (s.l.x - s.c.x) / 8
    const ny = (s.l.y - s.c.y) / 8
    for (let i = -coreN; i <= coreN; i++) queries.push({ x: s.c.x + nx * i * RUN_STEP, y: s.c.y + ny * i * RUN_STEP, rad: 0 })
  }
  const px = await readPng(file, queries)
  const coral = cssRgb(ap.coral)
  const paper = cssRgb(ap.paper)
  const err = (p, ref) => Math.max(...p.map((v, i) => Math.abs(v - ref[i])))
  const lum = (p) => relLum(...p)
  let k = 0
  const rows = []
  for (let i = 0; i < pts.length; i++) {
    const c = px[k++]
    const sides = [0, 1].map(() => Array.from({ length: RIM_STEPS.length }, () => px[k++]))
    const outs = [0, 1].map(() => ({ board: px[k++], near: px[k++], far: px[k++] }))
    if (!c || sides.some((s) => s.some((p) => !p)) || outs.some((o) => !o.board || !o.near || !o.far)) continue
    const core = c.reduce((best, p) => (err(p, coral) < err(best, coral) ? p : best))
    const rims = sides.map((s) => s.flat().reduce((best, p) => (lum(p) < lum(best) ? p : best)))
    const boards = outs.map((o) => o.board[0])
    const coreBoard = Math.min(...boards.map((b) => ratioOf(lum(core), lum(b))))
    const rimBoard = Math.min(...rims.map((p, j) => ratioOf(lum(p), lum(boards[j]))))
    const coreRim = Math.min(...rims.map((p) => ratioOf(lum(p), lum(core))))
    // the halo: just outside the rim lighter (light: cream; dark: the coral
    // glow) than further out
    const halo = outs.every((o) => lum(o.near[0]) > lum(o.far[0]) * 1.04)
    // its effective opacity there, read back: (near - board) / (halo colour
    // - board) on the channel with the largest swing
    const haloRef = ap.name === 'light' ? cssRgb('#FBF4E8') : coral
    const effs = outs.map((o) => {
      const b = o.board[0]
      let ch = 0
      for (let j = 1; j < 3; j++) if (Math.abs(haloRef[j] - b[j]) > Math.abs(haloRef[ch] - b[ch])) ch = j
      const den = haloRef[ch] - b[ch]
      return Math.abs(den) > 20 ? (o.near[0][ch] - b[ch]) / den : null
    })
    rows.push({
      coreErr: err(core, coral),
      coreBoard: +coreBoard.toFixed(2),
      rimBoard: +rimBoard.toFixed(2),
      coreRim: +coreRim.toFixed(2),
      halo,
      haloEff: effs.filter((e) => e !== null).map((e) => +e.toFixed(3)),
    })
  }
  const handleRows = handles.map((x) => {
    const centre = px[k++]
    const ring = dirs.map(() => RING_R.map(() => px[k++]))
    const outside = dirs.map(() => px[k++])
    if (!centre || ring.some((d) => d.some((p) => !p)) || outside.some((p) => !p)) return { role: x.role, graded: false }
    const isPaper = (p) => err(p[0], paper) <= 40
    return {
      role: x.role,
      graded: true,
      diameterPx: x.diameterPx,
      centreErr: x.kind === 'endpoint' ? err(centre[0], coral) : err(centre[0], paper),
      ringPaper: ring.filter((d) => d.some(isPaper)).length,
      outsidePaper: outside.filter(isPaper).length,
    }
  })
  // the longest run of coral pixels along a scan (css px)
  const coralRun = (scan) => {
    let best = 0
    let cur = 0
    for (const p of scan) {
      cur = p && err(p[0], coral) <= 48 ? cur + 1 : 0
      best = Math.max(best, cur)
    }
    return best * RUN_STEP
  }
  let headRunPx = null
  if (headScan) headRunPx = coralRun(Array.from({ length: 2 * scanN + 1 }, () => px[k++]))
  const coreRuns = coreScans.map(() => coralRun(Array.from({ length: 2 * coreN + 1 }, () => px[k++])))
  const widths = a.line.pts.map((p) => p.widthPx)
  const rimsPx = a.line.pts.map((p) => p.rimPx)
  // the ceilings grow with the zoom (inkLine.inkCapGrowth): graded on the
  // widths divided by the growth at their own spot
  const widthsN = a.line.pts.map((p) => p.widthPx / p.capK)
  const rimsN = a.line.pts.map((p) => p.rimPx / p.capK)
  const ratios = a.line.pts.filter((p) => p.plainWidthPx > 0).map((p) => p.widthPx / p.plainWidthPx)
  const haloEffs = rows.flatMap((q) => q.haloEff)
  const others = probe.others ?? []
  const otherCores = others.flatMap((o) => o.cores)
  const otherCoresN = others.flatMap((o) => o.coresN)
  const otherHeads = others.map((o) => o.head).filter(Boolean)
  return {
    head: {
      lengthPx: +a.lengthPx.toFixed(2),
      widthPx: +a.widthPx.toFixed(2),
      thicknessPx: +a.thicknessPx.toFixed(2),
      capK: a.capK,
      onScreen: a.onScreen,
      free: probe.headFree,
      visible: a.visibleFraction,
      runPx: headRunPx,
    },
    coreRunPx: coreRuns,
    ratio: ratios.length ? +Math.min(...ratios).toFixed(3) : null,
    plainCore: otherCores.length ? [Math.min(...otherCores), Math.max(...otherCores)] : null,
    plainCoreMaxN: otherCoresN.length ? Math.max(...otherCoresN) : null,
    otherHeads: otherHeads.length
      ? { maxLen: Math.max(...otherHeads.map((x) => x.len)), maxTh: Math.max(...otherHeads.map((x) => x.th)), maxLenN: Math.max(...otherHeads.map((x) => x.len / x.capK)), maxThN: Math.max(...otherHeads.map((x) => x.th / x.capK)) }
      : null,
    haloEff: haloEffs.length ? +median(haloEffs).toFixed(3) : null,
    haloEffN: haloEffs.length,
    picks: (h?.handles ?? []).filter((x) => x.free).map((x) => ({ role: x.role, pick: x.pick })),
    order: h ? { minHandle: h.minHandleOrder, labels: h.labelOrderMax } : null,
    sourceOffLinePx: h?.sourceOffLinePx ?? null,
    core: widths.length ? [Math.min(...widths), Math.max(...widths)] : null,
    rim: rimsPx.length ? [Math.min(...rimsPx), Math.max(...rimsPx)] : null,
    coreMaxN: widthsN.length ? Math.max(...widthsN) : null,
    rimMaxN: rimsN.length ? Math.max(...rimsN) : null,
    selected: a.selected,
    halo: a.selectHalo,
    knobTipPx: h?.knobTipPx ?? null,
    handles: (h?.handles ?? []).map((x) => ({ role: x.role, visible: x.visible, d: x.diameterPx, ly: x.ly })),
    handlePx: handleRows,
    graded: rows.length,
    coreOk: rows.filter((q) => q.coreErr <= INK_PIXEL_TOL * 2).length,
    edgeOk: rows.filter((q) => Math.max(q.coreBoard, q.rimBoard) >= LINE_MIN_CONTRAST).length,
    coreRimOk: rows.filter((q) => q.coreRim >= LINE_MIN_CONTRAST).length,
    haloOk: rows.filter((q) => q.halo).length,
    rows: rows.slice(0, 6),
  }
}

function selectedLineGates(bg, s) {
  if (!s) {
    gate(`${bg}.selected-line: measured`, false, 'not measured')
    return
  }
  for (const ap of SEL_APPEARANCES) {
    const r = s.appearances[ap.name]
    const name = `${bg}.selected-line[${ap.name}]`
    if (!r || r.error) {
      gate(`${name}: measured`, false, r?.error ?? 'missing')
      continue
    }
    const shots = Object.entries(r.shots)
    gate(
      `${name}: the board took its appearance (ink set ${ap.inkSet}) and a real click selected the line, linking NO shader program`,
      r.set.inkSet === ap.inkSet && r.selected.includes(s.line.id) && r.programsAdded.length === 0,
      { set: r.set, selected: r.selected, programsAdded: r.programsAdded },
    )
    const offCore = []
    const offHead = []
    // a head is graded where all of it is on the UNOBSTRUCTED canvas (no
    // side panel over it) and the camera sees most of it
    const headGraded = (x) => x.head.free && x.head.visible >= 0.6
    for (const [pose, x] of shots) {
      if (!x.core || x.core[0] < SEL_CORE_CSS[0] - 0.01 || x.coreMaxN > SEL_CORE_CSS[1] + 0.01 || !x.rim || x.rim[0] < SEL_RIM_CSS[0] - 0.01 || x.rimMaxN > SEL_RIM_CSS[1] + 0.01)
        offCore.push({ pose, core: x.core, rim: x.rim, coreMaxN: x.coreMaxN, rimMaxN: x.rimMaxN })
      // its width is read SQUARE to its on-screen axis (thicknessPx); the
      // corner-to-corner widthPx a skewed base inflates is reported only
      const k = x.head.capK ?? 1
      if (headGraded(x) && (x.head.lengthPx < SEL_HEAD_LEN_CSS[0] - 0.5 || x.head.lengthPx > SEL_HEAD_LEN_CSS[1] * k + 0.5 || x.head.thicknessPx > SEL_HEAD_WIDTH_CSS[1] * k + 0.5 || x.head.thicknessPx < SEL_HEAD_WIDTH_CSS[0] - 0.5))
        offHead.push({ pose, head: x.head })
    }
    const gradedHeadPoses = shots.filter(([, x]) => headGraded(x)).map(([p]) => p)
    gate(
      `${name}: in all ${shots.length} shots the core is ${SEL_CORE_CSS.join('-')} css px and the rim ${SEL_RIM_CSS.join('-')} per side (probe mirror; ceilings x inkCapGrowth at the spot), the head ${SEL_HEAD_LEN_CSS.join('-')} long x ${SEL_HEAD_WIDTH_CSS.join('-')} wide square to its axis (same growth) — graded on the unobstructed canvas at low and close-target`,
      offCore.length === 0 && offHead.length === 0 && ['iso', 'low', 'close-target'].every((p) => gradedHeadPoses.includes(p)),
      { offCore, offHead, gradedHeadPoses, shots: Object.fromEntries(shots.map(([p, x]) => [p, { core: x.core, rim: x.rim, head: x.head }])) },
    )
    // read back from the PNG: the head's coral across it, against the core's
    const thinHeads = []
    let headRuns = 0
    for (const [pose, x] of shots) {
      if (x.head.runPx === null || x.head.runPx === undefined) continue
      headRuns++
      const coreRun = x.coreRunPx.length ? median(x.coreRunPx.filter((v) => v > 0)) : NaN
      if (x.head.runPx < SEL_HEAD_RUN_MIN || (Number.isFinite(coreRun) && x.head.runPx < SEL_HEAD_RUN_RATIO * coreRun))
        thinHeads.push({ pose, headRunPx: x.head.runPx, coreRunPx: x.coreRunPx })
    }
    gate(
      `${name}: read back from the PNGs, the head's coral spans >= ${SEL_HEAD_RUN_MIN} css px across its axis at 80 % of its length and >= ${SEL_HEAD_RUN_RATIO}x the core's (low and close-target included)`,
      thinHeads.length === 0 && headRuns >= 3 && ['low', 'close-target'].every((p) => r.shots[p]?.head.runPx != null),
      { headRuns, thinHeads, byPose: Object.fromEntries(shots.map(([p, x]) => [p, { head: x.head.runPx, core: x.coreRunPx }])) },
    )
    // the hierarchy: every unselected line under its ceiling, the selected
    // core >= 1.33x what an unselected core draws at the same spot, and no
    // unselected head larger than the selected head's ceiling
    const badPlain = []
    for (const [pose, x] of shots) {
      const lo = pose === 'low' ? 1.5 : SEL_PLAIN_CORE_CSS[0]
      // (a close framing may hold no other line: its ratio still grades)
      if ((x.plainCore && (x.plainCore[0] < lo - 0.01 || x.plainCoreMaxN > SEL_PLAIN_CORE_CSS[1] + 0.01)) || x.ratio === null || x.ratio < SEL_RATIO_MIN - 0.005)
        badPlain.push({ pose, plainCore: x.plainCore, plainCoreMaxN: x.plainCoreMaxN, ratio: x.ratio })
      if (x.otherHeads && (x.otherHeads.maxLenN > SEL_HEAD_LEN_CSS[1] + 0.5 || x.otherHeads.maxThN > SEL_HEAD_WIDTH_CSS[1] + 0.5)) badPlain.push({ pose, otherHeads: x.otherHeads })
    }
    gate(
      `${name}: every unselected core is ${SEL_PLAIN_CORE_CSS.join('-')} css px (1.5 floor at low) and no unselected head exceeds ${SEL_HEAD_LEN_CSS[1]} x ${SEL_HEAD_WIDTH_CSS[1]}; the selected core is >= ${SEL_RATIO_MIN}x an unselected core at the same spot (probe mirror, every shot)`,
      badPlain.length === 0 && shots.filter(([, x]) => x.plainCore).length >= 3,
      { badPlain, byPose: Object.fromEntries(shots.map(([p, x]) => [p, { plainCore: x.plainCore, ratio: x.ratio, otherHeads: x.otherHeads }])) },
    )
    const offLine = shots.filter(([, x]) => x.sourceOffLinePx === null || x.sourceOffLinePx < 0 || x.sourceOffLinePx > 2)
    gate(
      `${name}: the source handle sits on the drawn line's first point (<= 2 css px) at every pose`,
      offLine.length === 0,
      Object.fromEntries(shots.map(([p, x]) => [p, x.sourceOffLinePx])),
    )
    const [effLo, effHi] = SEL_HALO_EFF[ap.name]
    const effBad = shots.filter(([, x]) => x.haloEffN >= 4 && (x.haloEff < effLo || x.haloEff > effHi))
    gate(
      `${name}: the selection halo reads back ${effLo}-${effHi} effective opacity 1.5 css px outside the rim (median; spec ${ap.name === 'light' ? '0.42' : '0.24'} there) — a soft glow, not a second stroke`,
      effBad.length === 0 && shots.filter(([, x]) => x.haloEffN >= 4).length >= 2,
      Object.fromEntries(shots.map(([p, x]) => [p, [x.haloEff, x.haloEffN]])),
    )
    const badPick = []
    let picked = 0
    for (const [pose, x] of shots) {
      for (const pk of x.picks) {
        if (pk.role !== 'source' && pk.role !== 'knob') continue
        picked++
        const want = pk.role === 'source' ? 'source' : 'target'
        if (pk.pick?.kind !== 'connEndpoint' || pk.pick.end !== want) badPick.push({ pose, ...pk })
      }
    }
    const orderOk = shots.every(([, x]) => x.order && x.order.minHandle > x.order.labels)
    gate(
      `${name}: every handle draws above the label plates (render order) and a real pick at its centre returns its endpoint, x-ray or not, at every pose`,
      badPick.length === 0 && picked >= 6 && orderOk,
      { picked, badPick, order: Object.fromEntries(shots.map(([p, x]) => [p, x.order])) },
    )
    const offTip = shots.filter(([, x]) => x.knobTipPx !== null && x.knobTipPx > SEL_KNOB_TIP_MAX)
    gate(
      `${name}: the target handle sits ON the arrowhead's tip (<= ${SEL_KNOB_TIP_MAX} css px, every shot; shown in >= 3) — the 2D destination dot`,
      offTip.length === 0 && shots.filter(([, x]) => x.knobTipPx !== null).length >= 3,
      Object.fromEntries(shots.map(([p, x]) => [p, x.knobTipPx])),
    )
    const badSize = []
    const badPx = []
    let gradedHandles = 0
    for (const [pose, x] of shots) {
      for (const hd of x.handles) if (hd.visible && Math.abs(hd.d - SEL_HANDLE_D) > 1) badSize.push({ pose, ...hd })
      for (const hp of x.handlePx) {
        if (!hp.graded) continue
        gradedHandles++
        if (hp.centreErr > 45 || hp.ringPaper < 6 || hp.outsidePaper > 2) badPx.push({ pose, ...hp })
      }
    }
    gate(
      `${name}: every handle is a ${SEL_HANDLE_D}+-1 css px circle at every pose — its paper ring read back from the PNG 4 px from its centre in >= 6 of 8 directions, <= 2 of 8 at 8 px out`,
      badSize.length === 0 && badPx.length === 0 && gradedHandles >= 4,
      { gradedHandles, badSize, badPx, byPose: Object.fromEntries(shots.map(([p, x]) => [p, x.handlePx])) },
    )
    const faint = []
    let graded = 0
    for (const [pose, x] of shots) {
      if (x.graded < 3) continue
      graded++
      if (x.coreOk < x.graded * 0.6 || x.edgeOk < x.graded * 0.8 || x.coreRimOk < x.graded * 0.8 || x.haloOk < x.graded * 0.6)
        faint.push({ pose, graded: x.graded, coreOk: x.coreOk, edgeOk: x.edgeOk, coreRimOk: x.coreRimOk, haloOk: x.haloOk, rows: x.rows })
    }
    gate(
      `${name}: read back from the PNGs, the core is ${ap.coral} (>= 60 %), the line's edge (core or rim) reads >= ${LINE_MIN_CONTRAST}:1 on the board and core/rim >= ${LINE_MIN_CONTRAST}:1 (>= 80 %), the selection halo shows (>= 60 %)`,
      // (the low and close shots rarely keep 4 + 8 px of open board either
      // side of a sample: the iso and top shots carry the read-back)
      graded >= 2 && faint.length === 0,
      { graded, faint, byPose: Object.fromEntries(shots.map(([p, x]) => [p, [x.graded, x.coreOk, x.edgeOk, x.coreRimOk, x.haloOk]])) },
    )
    const solids = ['CircleGeometry', 'RingGeometry', 'PlaneGeometry']
    gate(
      `${name}: 'Point mobile' is a bead in the core — no disc, ring or plane in the layer, one flow unit for the line`,
      !solids.some((t) => r.layer.geometryTypes[t]) && r.flow.units === 1 && r.flow.kinds[0] === 'traveling-dot',
      { geometryTypes: r.layer.geometryTypes, flow: r.flow },
    )
    gate(
      `${name}: hovering the target knob grows it to ${SEL_HANDLE_D_HOT} px with the crosshair, and the head is the target grip`,
      !!r.hover && r.hover.hover.id === 1 && r.hover.hover.t >= 0.999 && Math.abs(r.hover.knob.diameterPx - SEL_HANDLE_D_HOT) < 0.01 && r.hover.cursor === 'crosshair' &&
        r.headGrip?.kind === 'connEndpoint' && r.headGrip.end === 'target',
      { hover: r.hover, headGrip: r.headGrip },
    )
    gate(
      `${name}: hovering the HEAD lights the knob (the same target grip) and brightens the selection halo by 20 %`,
      !!r.headHover && r.headHover.hover.id === 1 && r.headHover.haloBase > 0 && Math.abs(r.headHover.haloOpacity / r.headHover.haloBase - 1.2) < 0.01,
      r.headHover,
    )
    const beads = Object.entries(r.bead ?? {}).map(([pose, s]) => [pose, gradeBead(s)])
    gate(
      `${name}: over 3 cycles at iso and low the bead's body never comes within ${SEL_BEAD_CLEAR} css px of a handle or the head wherever it is drawn (measured here from the probe's positions), and it is drawn whole on a stretch of every cycle`,
      beads.length === 2 && beads.every(([, g]) => g.samples >= 60 && g.nearCount === 0 && g.whole >= 10 && g.phases >= 8),
      Object.fromEntries(beads),
    )
    const d = r.drag ?? {}
    const pressedOk = d.pressId === 0 && d.pressedErr !== null && d.pressedErr <= 45
    gate(
      `${name}: pressing the source handle (real pointer) fills it coral-800 ${SEL_PRESSED[ap.name]}, read back from the PNG`,
      pressedOk,
      { pressId: d.pressId, pressedPx: d.pressedPx, pressedErr: d.pressedErr, error: d.error },
    )
    const pv = d.drag?.preview
    gate(
      `${name}: dragging it shows the re-route preview as a dashed coral ink line 2 css px wide, dash 6/4 css px (no world ribbon), the dragged handle riding the cursor at ${SEL_HANDLE_D_HOT} px pressed`,
      !!pv && pv.name === 'ink-drag-preview' && Math.abs(pv.minCss - 2) < 0.01 && Math.abs(pv.maxCss - 2) < 0.01 && Math.abs(pv.dash[0] - 6) < 0.05 && Math.abs(pv.dash[1] - 10) < 0.05 &&
        pv.css.toUpperCase() === ap.coral.toUpperCase() && !!d.drag.dragHandle && Math.abs(d.drag.dragHandle.diameterPx - SEL_HANDLE_D_HOT) < 0.01 && d.drag.pressId === 100,
      d.drag,
    )
    const an = d.anchors ?? []
    const snapped = an.filter((x) => x.kind === 'anchorSnapped')
    const plainA = an.filter((x) => x.kind === 'anchor')
    gate(
      `${name}: over another card its 12 drop anchors show — 6-px bodies, the snapped one ${SEL_HANDLE_D} px — and releasing on open board writes nothing`,
      an.length === 12 && snapped.length === 1 && Math.abs(snapped[0].d - SEL_HANDLE_D) < 0.01 && plainA.every((x) => Math.abs(x.body - 6) < 0.01) && d.unchanged === true,
      { card: d.card, anchors: an, unchanged: d.unchanged },
    )
    const sl = r.shortLine ?? {}
    gate(
      `${name}: zoomed out until the line is short on screen, the target knob hides (source-to-knob < 18 css px) and pressing the head is the target grip`,
      sl.reached === true && sl.sourceVisible === true && sl.headPick?.kind === 'connEndpoint' && sl.headPick.end === 'target',
      sl,
    )
    const rm = r.reduced ?? {}
    gate(
      `${name}: under prefers-reduced-motion the re-selected line draws no bead (no flow unit, no bead), and it comes back after`,
      rm.reduced === true && rm.selected === true && rm.bead === null && rm.flow?.units === 0 && rm.restoredBead === true,
      rm,
    )
    gate(`${name}: a click on empty board clears the selection`, r.clearedAfter === true, r.clearedAfter)
    // (the first count, taken before any selection, can hold allocations the
    // appearance switch left pending; the steady state is what must hold:
    // a second select / deselect cycle returns to the first one's count)
    const m = r.mem ?? {}
    gate(
      `${name}: selection, hover, drag and deselection leave 0 geometry / texture residue (a second select + deselect returns to the same counts, never above the first)`,
      !!m.before && !!m.after && !!m.again &&
        m.again.geometries === m.after.geometries && m.again.textures === m.after.textures &&
        m.after.geometries <= m.before.geometries && m.after.textures <= m.before.textures,
      m,
    )
  }
  gate(`${bg}.selected-line: the run's own appearance restored (light, honey wood)`, s.restored?.inkSet === 'darkInk', s.restored)
}

function arrowGates(bg, a) {
  const d = a.poses.default
  const s = a.selected
  const allShots = [...Object.entries(a.poses), ['selected', s], ['selected-line', a.selectedLine]]
  // what the lines are made of: Clean's flat ribbon and head, inked — no
  // tube, cone or torus left in the layer, nothing casting a shadow, one ink
  // core (+ at most one casing) per line, every head 'flat' and ink
  const solids = ['TubeGeometry', 'ConeGeometry', 'TorusGeometry', 'CylinderGeometry', 'LatheGeometry']
  const made = d.layer
  gate(
    `${bg}.lines: every connection is a flat ink line with a flat head — no tube, cone or torus in the layer, no shadow cast, <= 2 meshes each`,
    a.connections > 0 &&
      d.arrows.length === a.connections &&
      d.arrows.every((x) => x.drawn && x.kind === 'flat' && x.ink) &&
      !solids.some((t) => made.geometryTypes[t]) &&
      made.shadowCasters === 0 &&
      made.inkCores === a.connections &&
      made.inkMeshes <= 2 * a.connections,
    { connections: a.connections, layer: made, heads: d.arrows.map((x) => `${x.wire}:${x.kind}:${x.ink}`) },
  )
  // the tip on the target's 3D silhouette: a card's slab edge (2D parity,
  // connectionPath's arrowTip), a drum's pad circle (round 1 measured the
  // drum's 2D rect, so a head 20-25 css px short of the Event bus pad
  // passed with tipClear 0 — design review round 2)
  const offTip = d.arrows.filter((x) => Math.abs(x.tipClear) > 1)
  gate(`${bg}.lines: every head's point is on its target's 3D silhouette — card slab edge, drum pad circle (|tipClear| <= 1 world px)`, d.arrows.length > 0 && offTip.length === 0, offTip.map((x) => ({ wire: x.wire, tipClear: x.tipClear })))
  // contrast in the PNGs (WCAG 2.1 SC 1.4.11, 3:1), in the default framing
  // and every angle shot: a line graded on >= 4 samples over open board
  // reads >= 3:1 against both sides on >= 90 % of them, and a graded head
  // >= 3:1 against the board round it. A crowded board leaves few runs over
  // open board in any one shot, so every line must be graded in SOME shot
  // (>= 80 % of the lines and of the heads): a run that grades nothing
  // cannot pass.
  const poseShots = Object.entries(a.poses)
  const faintLines = []
  const faintHeads = []
  const gradedLines = new Set()
  const gradedHeads = new Set()
  for (const [pose, p] of poseShots) {
    for (const c of p.contrast) {
      if (c.alpha === 1 && c.graded >= 4) {
        gradedLines.add(c.wire)
        if (c.share < LINE_CONTRAST_SHARE) faintLines.push({ pose, ...c, fails: c.fails.slice(0, 4) })
      }
      if (c.head !== null) {
        gradedHeads.add(c.wire)
        if (c.head < LINE_MIN_CONTRAST) faintHeads.push({ pose, wire: c.wire, head: c.head })
      }
    }
  }
  gate(
    `${bg}.lines: every line reads >= ${LINE_MIN_CONTRAST}:1 against the board either side on >= ${LINE_CONTRAST_SHARE * 100} % of its samples, every head >= ${LINE_MIN_CONTRAST}:1 round it (all ${poseShots.length} pose PNGs)`,
    gradedLines.size >= Math.ceil(a.connections * 0.8) && faintLines.length === 0 && gradedHeads.size >= Math.ceil(a.connections * 0.8) && faintHeads.length === 0,
    { lines: gradedLines.size, heads: gradedHeads.size, faintLines, faintHeads, byPose: Object.fromEntries(poseShots.map(([k, p]) => [k, p.contrast.map((c) => [c.wire, c.graded, c.share, c.min, c.head])])) },
  )
  // the projected floors: at the default framing every on-screen head is
  // >= INK_HEAD_MIN_CSS long and every core >= its floor where seen square;
  // in every angle shot every seen head spans >= INK_HEAD_MIN_CSS, and from
  // low no seen line is under LOW_LINE_MIN_CSS
  const shortHeads = d.arrows.filter((x) => x.onScreen && x.visibleUi >= 0.3 && x.lengthPx < INK_HEAD_MIN_CSS - 0.25)
  const thinCores = d.arrows.filter((x) => x.minCoreSquarePx !== null && x.minCoreSquarePx < (x.highlighted ? INK_HIGHLIGHT_MIN_CSS : INK_CORE_MIN_CSS) - 0.01)
  gate(
    `${bg}.lines: at the default framing every head is >= ${INK_HEAD_MIN_CSS} css px long and every core >= ${INK_CORE_MIN_CSS} px where seen square`,
    d.arrows.some((x) => x.onScreen) && shortHeads.length === 0 && thinCores.length === 0,
    { shortHeads: shortHeads.map((x) => ({ wire: x.wire, lengthPx: x.lengthPx, scale: x.scale })), thinCores: thinCores.map((x) => ({ wire: x.wire, px: x.minCoreSquarePx })) },
  )
  const small = []
  for (const [pose, p] of allShots) {
    for (const x of p?.arrows ?? []) if (x.onScreen && x.visibleUi >= 0.3 && x.sizePx < INK_HEAD_MIN_CSS - 0.25) small.push({ pose, wire: x.wire, sizePx: x.sizePx })
  }
  gate(
    `${bg}.lines: in all ${allShots.length} shots every seen head spans >= ${INK_HEAD_MIN_CSS} css px`,
    Object.keys(a.poses).length === ARROW_POSES.length + 1 && !!s && small.length === 0,
    small,
  )
  const low = a.poses.low
  const thinLow = (low?.arrows ?? []).filter((x) => x.minCorePx !== null && x.minCorePx < LOW_LINE_MIN_CSS)
  gate(
    `${bg}.lines: from low (polar 75) no seen line is under ${LOW_LINE_MIN_CSS} css px`,
    (low?.arrows ?? []).some((x) => x.minCorePx !== null) && thinLow.length === 0,
    thinLow.map((x) => ({ wire: x.wire, minCorePx: x.minCorePx })),
  )
  // picking: within 4 css px of a line's centre picks that line — in every
  // pose shot, every line tried in at least one of them (>= 80 %)
  const triedLines = new Set()
  const missed = []
  for (const [pose, p] of poseShots) {
    for (const q of p.pick ?? []) {
      if (q.tried > 0) triedLines.add(q.connId)
      if (q.ok < q.tried) missed.push({ pose, ...q })
    }
  }
  gate(
    `${bg}.lines: a pick 4 css px off a line's centre selects that connection (all ${poseShots.length} pose shots)`,
    triedLines.size >= Math.ceil(a.connections * 0.8) && missed.length === 0,
    { tried: triedLines.size, missed, byPose: Object.fromEntries(poseShots.map(([k, p]) => [k, (p.pick ?? []).map((q) => [q.connId, q.tried, q.ok])])) },
  )
  gate(
    `${bg}.lines: selecting a card (real click) keeps every head drawn and links no shader program`,
    !!s && s.arrows.length === a.connections && s.arrows.every((x) => x.drawn) && s.programsAdded.length === 0 && s.clearedAfter,
    s ? { card: s.card, programsAdded: s.programsAdded, drawn: s.summary.drawn, clearedAfter: s.clearedAfter } : 'no card could be clicked',
  )
  // the selected state: every wire the clicked card sends is highlighted at
  // full opacity with its ink rim
  const lit = s ? s.arrows.filter((x) => x.highlighted) : []
  gate(
    `${bg}.lines: the selected card's wires (${s?.card?.outgoing ?? '?'}) are highlighted, full opacity, ink-rimmed, heads on screen`,
    !!s && lit.length === s.card.outgoing && lit.every((x) => x.drawn && x.onScreen && x.alpha === 1 && x.casing?.kind === 'rim' && x.casing.css === INK_RIM_CSS),
    { highlighted: lit.map((x) => ({ wire: x.wire, onScreen: x.onScreen, alpha: x.alpha, casing: x.casing })) },
  )
  // ONE line selected with the real pointer (the longest run over open
  // board), read back from the PNG where the board shows either side: the
  // core is the coral (+-INK_PIXEL_TOL), the rim reads >= 3:1 against the
  // board and against the core. (The traveling packet of the focus
  // animation sits on part of the line in any one shot: >= 60 % for the
  // core.)
  const sl = a.selectedLine
  const hp = sl?.highlightPixels ?? []
  const graded = hp.filter((h) => h.graded >= 3)
  const offPx = graded.filter((h) => h.coreOk < h.graded * 0.6 || h.rimBoardOk < h.graded * 0.8 || h.coreRimOk < h.graded * 0.8)
  gate(
    `${bg}.lines: a selected line (real click) reads back ${INK_HIGHLIGHT_CSS} at its core (+-${INK_PIXEL_TOL}, >= 60 % of samples) and an ink rim >= ${LINE_MIN_CONTRAST}:1 against the board and the core (>= 80 %)`,
    !!sl && sl.selected.includes(sl.line.id) && graded.length > 0 && offPx.length === 0 && sl.clearedAfter,
    sl
      ? { line: sl.line, selected: sl.selected, pixels: hp.map(({ rows, ...h }) => ({ ...h, rimErrMedian: rows.length ? median(rows.map((q) => q.rimErr)) : null, rows: rows.slice(0, 6) })) }
      : 'no line could be clicked',
  )
  gate(
    `${bg}.lines: the selected line's target knob is not drawn while its head is hidden (seen < 30 %)`,
    !!sl?.knob && !(sl.knob.knobVisible && sl.knob.headVisible < 0.3),
    sl?.knob ?? 'not measured',
  )
  // focus-dimmed lines: INK_DIM_OPACITY, no halo — present but subordinate.
  // Every graded dimmed line's own median sits in the band (round 1 gated a
  // median of medians, which passed with 'uses' at 1.30 and every head
  // nearly gone — design review round 2)
  const dimmed = s ? s.contrast.filter((c) => !c.highlighted && c.graded >= 4) : []
  const dimMedian = dimmed.length ? median(dimmed.map((c) => c.median)) : null
  const offBand = dimmed.filter((c) => c.median < DIM_CONTRAST_MIN || c.median > DIM_CONTRAST_MAX)
  gate(
    `${bg}.lines: every focus-dimmed line reads ${DIM_CONTRAST_MIN}-${DIM_CONTRAST_MAX}:1 (its median), with no casing, at opacity ${INK_DIM_OPACITY}`,
    dimmed.length > 0 &&
      offBand.length === 0 &&
      s.arrows.filter((x) => !x.highlighted).every((x) => x.casing === null && Math.abs(x.alpha - INK_DIM_OPACITY) < 1e-6),
    { dimMedian, offBand: offBand.map((c) => ({ wire: c.wire, median: c.median })), dimmed },
  )
  // dashed and dotted: the rhythm read back from the close top-view PNG
  const dz = a.dashes
  const badDash = (dz?.lines ?? []).filter((l) => !l.ok)
  gate(
    `${bg}.lines: dashed / dotted lines read back their 2D rhythm from a top-view PNG (periods 10+-1 / 5+-0.5, on 6+-1 / 2+-0.75 world px, regular, scale 1)`,
    !!dz && dz.clearForShot && dz.lines.length === 2 && dz.lines.map((l) => l.type).sort().join() === 'dashed,dotted' && badDash.length === 0 && dz.restored,
    dz ? { clearForShot: dz.clearForShot, lines: dz.lines.map(({ runs, ...l }) => ({ ...l, runs: runs.slice(0, 8) })), restored: dz.restored } : 'not measured',
  )
  // labels stay uncut: no head's silhouette reaches into a drawn label plate
  // in any shot (the label passes keep the plates off the heads)
  const plateHits = []
  let gradedShots = 0
  for (const [pose, p] of allShots) {
    const c = p?.clash
    if (!c) continue
    if (c.cues > 0 && c.plates > 0) gradedShots++
    for (const h of c.cuePlate) plateHits.push({ pose, ...h })
  }
  gate(
    `${bg}.lines: in all ${allShots.length} shots no head's silhouette overlaps a label plate (> ${CUE_CLASH_TOL_PX} px)`,
    gradedShots === allShots.length && plateHits.length === 0,
    { gradedShots, plateHits },
  )
}

function splitDecorRefresh(w) {
  const refreshScript = (s) =>
    (s.invoker === 'IdleRequestCallback' && s.src === 'Scene3D.ts') || (s.fn === 'check' && s.src === 'compileSafe.ts')
  const frameOf = ([start, ms]) => w.loaf.find((f) => f.start <= start + 2 && f.start + f.ms >= start + ms - 2)
  const isRefresh = (t) => {
    const f = frameOf(t)
    if (!f || f.scripts.length === 0) return false
    const top = [...f.scripts].sort((a, b) => b.ms - a.ms)[0]
    return refreshScript(top)
  }
  const own = w.tasks.filter((t) => !isRefresh(t))
  const refresh = w.tasks.filter(isRefresh)
  return {
    ...w,
    connectTasks: own,
    connectMaxMs: Math.max(0, ...own.map(([, d]) => d)),
    decorRefresh: { tasks: refresh, maxMs: Math.max(0, ...refresh.map(([, d]) => d)) },
  }
}

async function measureReconnect3d() {
  await page.waitForFunction(() => window.__scene3d && !window.__scene3d.isCameraAnimating(), undefined, { timeout: 30000 })
  const pick = (id, kind) =>
    page.evaluate(
      ([id, kind]) => {
        const s = window.__scene3d
        const ep = s.connEditPoints(id)
        if (!ep) return null
        const seeds = kind === 'connEndpoint' ? [ep.to, ep.from] : [ep.mid, ep.from, ep.to]
        // endpoint dots ride their card's TOP rim, above the cable plane
        for (const seed of seeds) {
          for (const lift of [ep.planeY, ep.planeY + 4, ep.planeY + 10, ep.planeY + 20, ep.planeY + 30, ep.planeY + 40, 0]) {
            const [c] = s.projectWorld([{ x: seed.x, y: lift, z: seed.y }])
            if (!c) continue
            for (let r = 0; r <= 24; r += 3)
              for (let dy = -r; dy <= r; dy += 3)
                for (let dx = -r; dx <= r; dx += 3) {
                  if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
                  const sx = Math.round(c.x + dx)
                  const sy = Math.round(c.y + dy)
                  const el = document.elementFromPoint(sx, sy)
                  if (!el || !el.closest('[data-testid="canvas-3d"]')) continue
                  const p = s.pickAt(sx, sy)
                  if (p && p.kind === kind && p.id === id) return { sx, sy }
                }
          }
        }
        return null
      },
      [id, kind],
    )
  const ids = await page.evaluate(() => window.__scene3d.connectionIds())
  for (const connId of ids) {
    const cable = await pick(connId, 'connection')
    if (!cable) continue
    const tSel = await page.evaluate(() => performance.now())
    // (programNames on a build without programKeys: a coarser diff)
    const programKeys = () => page.evaluate(() => {
      const p = window.__scene3d.perfInfo()
      return p.programKeys ?? p.programNames
    })
    const progs0 = await programKeys()
    await profiled(
      'reconnect-select',
      async () => {
        await page.mouse.click(cable.sx, cable.sy)
        await page
          .waitForFunction((id) => window.__scene3d.selectionIds().includes(id) && !window.__scene3d.isCameraAnimating(), connId, { timeout: 10000 })
          .catch(() => {})
        await page.waitForTimeout(300)
      },
      30,
    )
    // what each long task WAS: the frames from 50 ms with their scripts
    const loafSince = (from) => page.evaluate((t) => (window.__loaf ?? []).filter((f) => f.start >= t && f.ms >= 50), from)
    // programs the click added (a multiset diff of names) and the frames
    // that LINKED one synchronously (perfInfo slowFrames newPrograms)
    const programsSince = (from, before) =>
      page.evaluate(
        ([t, b]) => {
          const p = window.__scene3d.perfInfo()
          const left = [...b]
          const added = []
          for (const n of p.programKeys ?? p.programNames) {
            const i = left.indexOf(n)
            if (i >= 0) left.splice(i, 1)
            else added.push(n)
          }
          return { added, linkFrames: p.slowFrames.filter((f) => f.atMs >= t && f.newPrograms > 0) }
        },
        [from, before],
      )
    const select = { ...(await longTasksSince(tSel)), loaf: await loafSince(tSel), programs: await programsSince(tSel, progs0) }
    const dot = await pick(connId, 'connEndpoint')
    if (!dot) continue
    const before = await page.evaluate((id) => {
      const c = window.__modelStore.getState().connections.find((k) => k.id === id)
      return { fromId: c.fromId, toId: c.toId }
    }, connId)
    // a card on the unobstructed canvas that is neither end
    const target = await page.evaluate(([from, to]) => {
      for (const b of window.__scene3d.nodeScreenBoxes()) {
        if (b.id === from || b.id === to || b.w <= 12 || b.h <= 8) continue
        const x = b.x + b.w / 2
        const y = b.y + b.h / 2
        const el = document.elementFromPoint(x, y)
        if (!el || !el.closest('[data-testid="canvas-3d"]')) continue
        const p = window.__scene3d.pickAt(x, y)
        if (p && p.kind === 'object' && p.id !== from && p.id !== to) return { id: p.id, x, y }
      }
      return null
    }, [before.fromId, before.toId])
    if (!target) continue
    await page.mouse.move(dot.sx, dot.sy)
    await page.mouse.down()
    for (let i = 1; i <= 12; i++) await page.mouse.move(dot.sx + ((target.x - dot.sx) * i) / 12, dot.sy + ((target.y - dot.sy) * i) / 12)
    await page.waitForTimeout(60)
    const t0 = await page.evaluate(() => performance.now())
    const perf0 = await page.evaluate(() => window.__scene3d.connLabelPerf())
    const progsDrop = await programKeys()
    // full rebuilds and quality-tier steps inside the window (a tier step
    // re-keys every program: what the drop window then measures is that)
    const sceneState = () =>
      page.evaluate(() => ({ builds: window.__scene3d.perfInfo().builds, tier: window.__scene3d.sceneStats().qualityTier }))
    const state0 = await sceneState()
    await profiled(
      'reconnect-drop',
      async () => {
        await page.mouse.up()
        // the store write, its echo, the write flush and the sliced label pass
        await page
          .waitForFunction(
            ([id, b]) => {
              const c = window.__modelStore.getState().connections.find((k) => k.id === id)
              return (c.fromId !== b.fromId || c.toId !== b.toId) && !window.__scene3d.isCameraAnimating()
            },
            [connId, before],
            { timeout: 20000 },
          )
          .catch(() => {})
        await page.waitForTimeout(2000)
      },
      30,
    )
    const after = await page.evaluate((id) => {
      const c = window.__modelStore.getState().connections.find((k) => k.id === id)
      return { fromId: c.fromId, toId: c.toId }
    }, connId)
    return {
      connId,
      before,
      after,
      targetId: target.id,
      reconnected: after.fromId !== before.fromId || after.toId !== before.toId,
      select,
      drop: splitDecorRefresh({
        ...(await longTasksSince(t0)),
        loaf: await loafSince(t0),
        programs: await programsSince(t0, progsDrop),
        scene: { before: state0, after: await sceneState() },
      }),
      labelPerfBefore: perf0,
      labelPerf: await page.evaluate(() => window.__scene3d.connLabelPerf()),
      labelsSettled: await page.evaluate(() => !window.__scene3d.isCameraAnimating()),
    }
  }
  return null
}

async function reconnectGates() {
  at('reconnect a connection in 3D')
  const r = await measureReconnect3d()
  report.reconnect3d = r
  log('reconnect 3D', r && { connId: r.connId, reconnected: r.reconnected, select: r.select.tasks, drop: r.drop.tasks, labelPerf: r.labelPerf })
  gate('reconnect3d: a cable reconnected with the real pointer (cable click, endpoint drag onto another card)', !!r && r.reconnected, r && { connId: r.connId, before: r.before, after: r.after, targetId: r.targetId })
  if (!r) return
  gate(`reconnect3d.select.longTasks.maxMs <= ${RECONNECT_LONGTASK_MAX}`, r.select.maxMs <= RECONNECT_LONGTASK_MAX, r.select)
  // the connect's own tasks; the deferred decor refresh is reported beside
  // them (splitDecorRefresh) — a long task with no attributable frame
  // counts as the connect's
  gate(
    `reconnect3d.drop: the connect's own long tasks (pointerup, store echo, write flush, label slices) <= ${RECONNECT_LONGTASK_MAX} ms`,
    r.drop.connectMaxMs <= RECONNECT_LONGTASK_MAX,
    { connectTasks: r.drop.connectTasks, decorRefresh: r.drop.decorRefresh, loaf: r.drop.loaf },
  )
  // the selection's programs (focus-dimmed cables, flow effect, edit
  // chrome) were linked inside the enter compile gate: the click adds none
  // (it added three before, a 119-133 ms task). The drop's are reported:
  // on a dressed board its deferred decor refresh re-keys (splitDecorRefresh)
  gate('reconnect3d: the cable click adds no shader program', r.select.programs.added.length === 0, {
    select: r.select.programs,
    drop: r.drop.programs,
    scene: r.drop.scene,
  })
  // the label placement pass of the rebuilt layer ran sliced, every slice
  // under the long-task line, and committed (no pass pending)
  gate(
    'reconnect3d: the label pass ran after the drop in slices under 50 ms and settled',
    r.labelsSettled && r.labelPerf.connBuilds > r.labelPerfBefore.connBuilds && r.labelPerf.jobMaxSliceMs < 50,
    { labelPerf: r.labelPerf, before: r.labelPerfBefore, settled: r.labelsSettled },
  )
}

try {
  log('login', BASE)
  at('login')
  await navigating(login)
  at('import the DSL')
  await navigating(importDsl)
  at('studio skin')
  await setStudio()
  at('enter 3D')
  const tEnter = await page.evaluate(() => performance.now())
  // --trace: a Chrome trace of the enter (GPU process included) — a frame
  // blocked inside a GL call is waiting on the GPU main thread, which only
  // the trace shows (loop4: 150-310 ms composed frames, self time in
  // three's uniform setters, no link/upload/resize of our own)
  if (TRACE) {
    await browser.startTracing(page, {
      path: resolve(OUT, 'trace-enter3d.json'),
      categories: ['devtools.timeline', 'gpu', 'gpu.service', 'disabled-by-default-gpu.service', 'viz', 'cc', 'toplevel', 'disabled-by-default-devtools.timeline'],
    })
  }
  const enterProf = await profiled('enter3d', async () => {
    await page.locator('[data-testid="view-3d"]').click()
    await sceneReady()
    // the post-stack mount (and its first composed frame) is part of entering
    await firstFrameMeasured()
    await page.waitForTimeout(400)
  })
  if (TRACE) await browser.stopTracing()
  const enter = {
    wallMs: Math.round((await page.evaluate(() => performance.now())) - tEnter),
    longTasks: await longTasksSince(tEnter),
    build: await page.evaluate(() => window.__scene3d.perfInfo()),
    // the connection build's share, and its label placement pass
    connPerf: await page.evaluate(() => {
      const p = window.__scene3d.connLabelPerf()
      return { connBuildMaxMs: p.connBuildMaxMs, labelBuildMs: p.buildMs }
    }),
    dom: await page.evaluate((t) => (window.__dom ?? []).filter((e) => e[0] >= t), tEnter),
    profile: enterProf.profile,
  }
  log('enter 3D', enter)
  // every program the first frame draws with was linked inside the async
  // compile gate — shadow-depth and backdrop included (loop1-r2: never empty)
  gate('enter3d.postFirstNewPrograms empty', enter.build.postFirstNewPrograms.length === 0, enter.build.postFirstNewPrograms)
  gate('enter3d.longTasks.maxMs <= 200', enter.longTasks.maxMs <= 200, enter.longTasks)
  gate('enter3d long task is not the write flush', writeFlushFrames(enter.longTasks).length === 0, writeFlushFrames(enter.longTasks))
  const firstFrames = [{ label: 'enter3d', build: enter.build }]
  const gpuName = await page.evaluate(() => {
    const g = document.createElement('canvas').getContext('webgl2')
    const d = g.getExtension('WEBGL_debug_renderer_info')
    return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown'
  })
  report.gpuName = gpuName
  report.enter3d = enter
  // tasks from 25 ms: the hitch this orbit is gated on can be 33-50 ms
  at('first orbit')
  const orbitBareProf = await profiled('orbitBare', () => measureOrbit(2000), 25)
  report.orbitBare = { ...orbitBareProf.result, profile: orbitBareProf.profile }
  // the FIRST orbit after entering 3D — loop2 measured 81 hitches (max
  // 65 ms) here while every per-background orbit read 0: the user who orbits
  // straight after pressing 3D is the one who sees it
  gate('orbitBare started on empty floor (an orbit, not a drag)', !report.orbitBare.start.noEmptyFloor, report.orbitBare.start)
  gate('orbitBare.hitches.count == 0', report.orbitBare.hitches.count === 0, report.orbitBare.hitches)
  gate(`orbitBare.bench.p95 <= ${ORBIT_P95_MAX}`, report.orbitBare.bench.p95 <= ORBIT_P95_MAX, report.orbitBare.bench)

  // --reconnect-only: the reconnect gates on the freshly entered board, and
  // nothing else (a diagnostic mode: the backgrounds gate below is RED);
  // --reconnect-bg <bg> first dresses it and cold-reloads into 3D, as the
  // full run's reconnect (after the last background's cold load) sees it
  if (RECONNECT_ONLY) {
    const bg = arg('reconnect-bg', '')
    if (bg) {
      at(`${bg}: apply decor (reconnect-only)`)
      await applyDecor(bg)
      const url = page.url()
      await navigating(async () => {
        await page.goto(url.includes('view=3d') ? url : `${url}${url.includes('?') ? '&' : '?'}view=3d`)
        await page.waitForFunction((b) => window.__scene3d?.decorInfo()?.world === b && !window.__scene3d.isCameraAnimating(), bg, { timeout: 120000 })
        await firstFrameMeasured()
      })
    }
    await reconnectGates()
  }
  if (ARROWS_ONLY) {
    at('workbench: apply decor (arrows-only)')
    await applyDecor('workbench')
    report.arrows = await evalArrows('workbench')
    arrowGates('workbench', report.arrows)
    report.selectedLines = await evalSelectedLines('workbench')
    selectedLineGates('workbench', report.selectedLines)
  }
  if (MOUNT_ONLY) {
    at('city: apply decor (mount-only)')
    await applyDecor('city')
    await page.locator('[data-testid="canvas-zoom-fit"], [aria-label="Ajuster à l’écran"], [aria-label="Fit to screen"]').first().click().catch(() => {})
    await page.waitForTimeout(1200)
    await page.waitForFunction(() => !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 }).catch(() => {})
    report.mountWide = await shot('city-wide')
    report.mount = await mountCloseup('city')
    mountGates('city', report.mount)
  }
  for (const bg of RECONNECT_ONLY || ARROWS_ONLY || MOUNT_ONLY ? [] : BACKGROUNDS) {
    const run = { background: bg }
    at(`${bg}: apply decor`)
    const decorProf = await profiled(`decor-${bg}`, () => applyDecor(bg))
    run.applyDecor = { ...decorProf.result, profile: decorProf.profile }
    log(bg, 'decor', run.applyDecor)
    const db = run.applyDecor.build
    gate(`${bg}.applyDecor measured its own first frame`, db.postFirstBuild === db.builds, {
      postFirstBuild: db.postFirstBuild,
      builds: db.builds,
    })
    gate(`${bg}.applyDecor.postFirstNewPrograms empty`, db.postFirstNewPrograms.length === 0, db.postFirstNewPrograms)
    gate(`${bg}.applyDecor.longTasks.maxMs <= 150`, run.applyDecor.longTasks.maxMs <= 150, run.applyDecor.longTasks)
    gate(`${bg}.applyDecor long task is not the write flush`, writeFlushFrames(run.applyDecor.longTasks).length === 0, writeFlushFrames(run.applyDecor.longTasks))
    firstFrames.push({ label: `${bg}.applyDecor`, build: db })
    run.stats = await page.evaluate(() => window.__scene3d.sceneStats())
    run.decor = await page.evaluate(() => window.__scene3d.decorInfo())
    at(`${bg}: fit and orbit`)
    await page.locator('[data-testid="canvas-zoom-fit"], [aria-label="Ajuster à l’écran"], [aria-label="Fit to screen"]').first().click().catch(() => {})
    await page.waitForTimeout(1200)
    await page.waitForFunction(() => !window.__scene3d.isCameraAnimating(), undefined, { timeout: 20000 }).catch(() => {})
    // fit-to-screen leaves every node VISIBLE: each node's projected 3D box
    // (5x5 sample points, corners included) hit-tests to the WebGL canvas,
    // not to a panel, the tool rail or a toolbar floating over it, and lies
    // inside the canvas (loop2 round 2: Ingest under the properties panel,
    // Log store's name tag on the STYLE 3D toolbar, after this very click).
    run.fit = await evalFit()
    gate(`${bg}.fit: every node's projected box inside the unobstructed canvas`, run.fit.nodes > 0 && run.fit.hidden.length === 0, run.fit)
    run.orbit = await measureOrbit(3000)
    gate(`${bg}.orbit started on empty floor (an orbit, not a drag)`, !run.orbit.start.noEmptyFloor, run.orbit.start)
    gate(`${bg}.orbit.hitches.count == 0`, run.orbit.hitches.count === 0, run.orbit.hitches)
    gate(`${bg}.orbit.bench.p95 <= ${ORBIT_P95_MAX}`, run.orbit.bench.p95 <= ORBIT_P95_MAX, run.orbit.bench)
    log(bg, 'orbit', run.orbit)
    if (EXPERIMENTS) {
      // cost split: the same fenced bench under each post tier
      run.tiers = {}
      for (const tier of ['high', 'medium', 'low']) {
        await page.evaluate((t) => window.__scene3d.setQualityTier(t), tier)
        await page.waitForTimeout(1500)
        await page.evaluate(() => window.__scene3d.benchFrames(10))
        const ft = (await page.evaluate(() => window.__scene3d.benchFrames(90))).sort((a, b) => a - b)
        run.tiers[tier] = +ft[Math.floor(ft.length / 2)].toFixed(2)
      }
      log(bg, 'tiers p50 ms', run.tiers)
    }
    run.shots = {}
    run.shots.wide = await shot(`${bg}-wide`)
    // the board reads a value step LIGHTER than its desk (loop 4 r4: both
    // ~160 luminance in workbench-wide.png). Gated where the desk ring IS
    // desk — the city ring covers it with blocks, so city only reports.
    run.boardDesk = await evalBoardDesk(run.shots.wide)
    log(bg, 'board vs desk', run.boardDesk)
    // the floor's texture round the board: reported on every world (the
    // workbench's walnut is the "grainy" reference), gated on the studio
    run.floorGrain = await evalFloorGrain(run.shots.wide)
    log(bg, 'floor grain', run.floorGrain)
    if (bg === 'studio') floorGrainGate(`${bg}.wide`, run.floorGrain)
    if (bg === 'workbench') {
      gate(
        `${bg}.wide: board median luminance >= 12% over the desk's`,
        run.boardDesk.ok && run.boardDesk.boardSamples >= 100 && run.boardDesk.deskSamples >= 100 && run.boardDesk.step >= 0.12,
        run.boardDesk,
      )
    }
    // no light pool on the diagram: the board's hottest bare cell stays
    // within HOT_SPOT_MAX of its median (evalBoardHotSpot)
    run.hotSpot = await evalBoardHotSpot(run.shots.wide)
    log(bg, 'board hot spot', run.hotSpot)
    gate(
      `${bg}.wide: no hot spot on the bare board (hottest cell median <= ${HOT_SPOT_MAX * 100}% over the board median)`,
      run.hotSpot.ok && run.hotSpot.samples >= 500 && run.hotSpot.cells >= 30 && run.hotSpot.hot <= HOT_SPOT_MAX,
      run.hotSpot,
    )
    // view3d quality loop 3 r2: connection labels ~5 px at THIS framing —
    // they are reported with the scale they wear (they grow only as far as
    // the room beside their cable allows). Node titles are REPORTED here,
    // not held to a size: see the shape-face gate below.
    run.legibility = await page.evaluate(() => window.__scene3d.textLegibility())
    log(bg, 'legibility', {
      titles: run.legibility.titles.map((t) => `${t.id}:${t.kind}:${t.capPx.toFixed(1)}`),
      labels: run.legibility.labels.map((l) => `${l.text}:${l.capPx.toFixed(1)}×${l.k.toFixed(2)}`),
      growth: run.legibility.growth
        ? `kWant ${run.legibility.growth.kWant.toFixed(2)}: ${run.legibility.growth.labels.map((l) => `${l.kFree.toFixed(2)}${l.moved ? '*' : ''}`).join(' ')}`
        : 'n/a',
    })
    // SHAPE FACES — a REGRESSION gate. A gate here held every card title to a
    // 10-px projected cap height at this framing; nothing in the base design
    // reaches that at a fit-to-screen zoom, so it forced a far-title mode
    // (Inter 700 up to 34, the badge, subtitle and pill hidden) and the
    // drums' names onto the drum in bold. The user rejected the result on
    // 2026-10-10: "sur les shapes je vois des régressions sur la police et la
    // taille de la police et l'icône par rapport à avant". The base face
    // (edfc9c6f7, reports/view3d-quality/baseline-dev/workbench-wide.png) is
    // now the contract at this framing: every card shows its title in Inter
    // 600 at 13 and its icon badge at its built size; every drum shows its
    // side badge and its name tag in Inter 600 at 10.5; no node text in a
    // font the base faces never used.
    run.faces = await page.evaluate(() => window.__scene3d.nodeFaces())
    log(bg, 'faces', run.faces.map((f) => `${f.id.slice(0, 6)}:${f.kind}:${f.title ? `${f.title.font}@${f.title.size}${f.title.visible ? '' : ' HIDDEN'}` : 'no title'}:badge ${f.badge ? (f.badge.visible ? `x${f.badge.scale}` : 'HIDDEN') : 'none'}${f.foreignFonts.length ? ` foreign ${f.foreignFonts.join(',')}` : ''}`))
    const faceOk = (f) => {
      const want = f.kind === 'store' ? { font: 'inter600', size: 10.5 } : { font: 'inter600', size: 13 }
      const titleOk = f.title !== null && f.title.visible && f.title.font === want.font && f.title.size === want.size
      // a card always carries its icon tile; a drum carries a badge when it
      // has a technology (icon or first technology), as the base did
      const needsBadge = f.kind === 'card' || f.hasTech
      const badgeOk = !needsBadge || (f.badge !== null && f.badge.visible && f.badge.scale === 1)
      return titleOk && badgeOk && f.foreignFonts.length === 0
    }
    gate(
      `${bg}.wide: every card and drum shows its base face (title Inter 600 13 / drum tag 10.5, tech badge shown at its built size, no other font)`,
      run.faces.length > 0 && run.faces.length >= run.fit.nodes && run.faces.every(faceOk),
      run.faces.filter((f) => !faceOk(f)),
    )
    // loop4-r1: 7 of 10 connection labels read 4.7-7.2 px here and nothing
    // measured them — they now slide along their wire to room they can grow
    // into (labelLegibility.roomiestSpot). Held to 8 px caps (~11 px text).
    const connLabels = run.legibility.labels
    gate(
      `${bg}.wide: every connection label cap height >= 8 px`,
      connLabels.length > 0 && connLabels.every((l) => l.capPx >= 8),
      connLabels.map((l) => ({ text: l.text, capPx: +l.capPx.toFixed(2), k: +l.k.toFixed(2) })),
    )
    // quality pass "labels": 'evaluates' tucked under Alert manager and
    // 'queries' jammed between Query API and Web console in this very shot
    // (measured through the live camera: -0.4 px and -4.2 / -4.9 px). Every
    // label plate as drawn (scale + lift) against every card's slab + plinth
    // and every drum's body, as projected convex hulls — apart.
    const screenInfo = await page.evaluate(() => window.__scene3d.labelScreenInfo())
    run.labelScreen = evalLabelScreen(screenInfo)
    log(bg, 'label screen gaps', run.labelScreen.nearest)
    // quality pass "labels" round 2: every plate ON its own wire (the
    // connLabelWireInfo probe measured all ten 41-183 world px off theirs
    // before the fix; 'notifies' / 'writes' ~150 css px off in the shot)
    run.labelWires = await evalLabelWires()
    log(bg, 'label wire distances', Object.fromEntries(run.labelWires.map((w) => [w.text, `${w.distance}/${w.limit}`])))
    gate(
      `${bg}.wide: every connection label plate sits on its own wire (centre <= half its height + ${ON_WIRE_SLACK} from its cable)`,
      run.labelWires.length > 0 && run.labelWires.length === run.labelScreen.labels && run.labelWires.every((w) => w.onWire),
      run.labelWires,
    )
    // TASK 2 (the user's decision of 2026-10-10). The previous gate let a
    // plate overlap a card or drum when no copy of it slid along its own wire
    // was clear ("boxed in"): 6 of 10 wires here are short hops between
    // adjacent cards ('queries' / 'notifies' 40 world px, 'consumes' 46,
    // 'reads' 61, 'evaluates' 84) or run behind the Log store drum
    // ('searches'), and with the exception the shot showed 'queries' 10.2 px
    // into Query API, 'searches' 15.9 px into it and 14.1 px into the drum
    // (tp4-cards-3 report, labelScreen.overlaps). A label with no free spot
    // is now abbreviated or hidden at this framing, so the exception is gone:
    // NO drawn plate meets a card, a drum, a drum's floor tag or another
    // plate on screen.
    gate(
      `${bg}.wide: no drawn connection label plate overlaps a card, a drum, a drum tag or another plate on screen`,
      run.labelScreen.labels > 0 && run.labelScreen.nodes > 0 && run.labelScreen.overlaps.length === 0,
      run.labelScreen,
    )
    // …and the labels it did not draw whole are counted, not lost: every
    // labelled connection is whole, abbreviated (>= 4 characters + an
    // ellipsis, a prefix of its label) or hidden, and the drawn ones are
    // exactly the plates the screen probe saw
    run.labelStates = await evalLabelStates()
    log(bg, 'label states', `${run.labelStates.full} whole, ${run.labelStates.abbreviated} abbreviated, ${run.labelStates.hidden} hidden`, run.labelStates.states.filter((s) => s.state !== 'full').map((s) => `${s.text}->${s.shown ?? '(hidden)'}`))
    const abbrOk = (s) => s.state !== 'abbreviated' || (s.shown.endsWith('…') && Array.from(s.shown).length - 1 >= 4 && s.text.startsWith(s.shown.slice(0, -1).trimEnd()))
    gate(
      `${bg}.wide: every connection label is whole, abbreviated (>= 4 chars + ellipsis) or hidden — reported: whole/abbreviated/hidden`,
      run.labelStates.total > 0 &&
        run.labelStates.full + run.labelStates.abbreviated + run.labelStates.hidden === run.labelStates.total &&
        run.labelStates.full + run.labelStates.abbreviated === run.labelScreen.labels &&
        run.labelStates.states.every((s) => abbrOk(s) && s.drawn === (s.state !== 'hidden') && (s.state === 'hidden' || s.textNow === s.shown)),
      { full: run.labelStates.full, abbreviated: run.labelStates.abbreviated, hidden: run.labelStates.hidden, states: run.labelStates.states },
    )
    // a hidden or abbreviated label shows WHOLE while its connection is
    // hovered with the real pointer, and goes back when the pointer leaves
    run.labelHover = await evalLabelHover()
    log(bg, 'label hover', run.labelHover)
    const crowded = run.labelStates.abbreviated + run.labelStates.hidden
    gate(
      `${bg}.wide: hovering a hidden or abbreviated label's connection shows it whole (real pointer)`,
      crowded === 0 || (run.labelHover.some((h) => h.hoverable) && run.labelHover.filter((h) => h.hoverable).every((h) => h.ok)),
      run.labelHover,
    )
    // the flag reads in the default framing (placement.ts showcase view):
    // its finial and foot both project inside the unobstructed canvas
    run.flagFrame = await evalFlagFrame()
    gate(`${bg}.wide: the desk flag's foot and finial are on the unobstructed canvas`, run.flagFrame.placed && run.flagFrame.hits.every(Boolean), run.flagFrame)
    // quality pass "wildlife": the moose (~40 px) and the beaver (~25 px)
    // were brown specks in workbench-wide.png. On the workbench each is ONE
    // animal, foot and crown on the unobstructed canvas, at least 80 / 50 px
    // tall (registry MOOSE_/BEAVER_DESK_GROWTH). The city keeps its maquette
    // scale (~12 / ~9 units, under the lowest walk-up): there it must stand
    // on the canvas, and its height is reported.
    run.wildlife = await evalWildlifeFrame()
    log(bg, 'wildlife', run.wildlife)
    for (const [id, minPx] of [['moose', 80], ['beaver', 50]]) {
      const w = run.wildlife[id]
      const framed = w.placed === 1 && w.hits.every(Boolean)
      if (bg === 'workbench') gate(`${bg}.wide: the ${id} stands on the unobstructed canvas, >= ${minPx} px tall`, framed && w.heightPx >= minPx, w)
      else gate(`${bg}.wide: the ${id} stands on the unobstructed canvas`, framed, w)
    }
    // quality pass "layout": no animal stands on a desk prop — neither in
    // plan (its posed box over another's) nor on screen in this framing
    run.deskOverlap = await evalDeskOverlap()
    log(bg, 'deskOverlap', run.deskOverlap)
    gate(
      `${bg}.wide: no animal stands on a desk prop (plan boxes apart, screen boxes apart)`,
      run.deskOverlap.animals > 0 && run.deskOverlap.planOverlaps.length === 0 && run.deskOverlap.screenOverlaps.length === 0,
      run.deskOverlap,
    )
    // a close-up over the middle of the diagram: the fit framing of a 9-node
    // board puts the cards' chips and subtitles under their LOD threshold, so
    // label-vs-chip overlap is only gradeable this close
    const mid = await page.evaluate(() => {
      // node origins are top-left corners: +100 lands near the card middles
      const ps = window.__scene3d.nodeIds().map((id) => window.__scene3d.nodeWorldPos(id)).filter(Boolean)
      const p = ps.length
        ? { x: ps.reduce((a, b) => a + b.x, 0) / ps.length + 100, y: ps.reduce((a, b) => a + b.y, 0) / ps.length + 60 }
        : null
      return { p, d: window.__scene3d.getPose().distance * 0.5 }
    })
    if (mid.p) {
      run.shots.labels = await shot(`${bg}-labels`, async () =>
        page.evaluate(([x, z, d]) => window.__scene3d.focusWorld(x, z, d), [mid.p.x, mid.p.y, mid.d]),
      )
      // TASK 2: what the labels show is re-decided when the camera settles,
      // and at this closer framing still no drawn plate meets a node, a tag
      // or another plate. (Zoom alone gives the short hops NO room at this
      // pitch: measured with a one-off debug probe on this board at this
      // close-up (DPR 1, k 1.01), every on-wire spot of 'queries' /
      // 'notifies' / 'consumes' / 'reads' / 'searches' / 'evaluates' still
      // reached 4.6-51 px into a card, a drum or a tag — the near card's wall
      // covers the whole hop on screen at the iso polar.)
      run.labelStatesClose = await evalLabelStates()
      run.labelScreenClose = evalLabelScreen(await page.evaluate(() => window.__scene3d.labelScreenInfo()))
      log(bg, 'label states (close-up)', `${run.labelStatesClose.full} whole, ${run.labelStatesClose.abbreviated} abbreviated, ${run.labelStatesClose.hidden} hidden`, run.labelStatesClose.states.filter((s) => s.state !== 'full').map((s) => `${s.text}->${s.shown ?? '(hidden)'}`))
      gate(
        `${bg}.labels close-up: no drawn connection label plate overlaps a node, a tag or another plate`,
        run.labelScreenClose.labels > 0 && run.labelScreenClose.overlaps.length === 0 && run.labelStatesClose.total === run.labelStates.total,
        { close: { full: run.labelStatesClose.full, abbreviated: run.labelStatesClose.abbreviated, hidden: run.labelStatesClose.hidden }, overlaps: run.labelScreenClose.overlaps },
      )
      // …and a framing that DOES give room brings them back: orbited toward
      // top-down with the real pointer (the cards' walls stop covering the
      // hops), more labels are whole than at the wide framing, none overlaps;
      // then orbited back by the same stroke
      run.labelTop = await evalLabelsTopDown(bg)
      log(bg, 'label states (top-down orbit)', run.labelTop.summary)
      // what the label passes cost (reported; the long-task gates hold the
      // builds and settles they run in)
      run.labelPerf = await page.evaluate(() => window.__scene3d.connLabelPerf())
      log(bg, 'label pass ms', run.labelPerf)
      // "come back" = more labels DRAWN (whole or abbreviated) than at the
      // wide framing. It counted whole labels only until the fifth arrow
      // iteration, and passed on defects: of the 8 whole at the top-down
      // orbit in tp8-final-dpr1, 4 were drawn THROUGH a head ('queries',
      // 'reads', 'searches', 'consumes' — 20.6-36.5 px of cone into the
      // plate, tp9-arrows5-base2 evalCueClash 'top'). With the heads as
      // obstacles the short hops they fill have no clear spot and hide; the
      // orbit still brings one back abbreviated ('search…': 4 whole + 1
      // abbreviated against the wide framing's 4 + 0, tp9-arrows5-full1).
      const shownTop = run.labelTop.states.full + run.labelTop.states.abbreviated
      const shownWide = run.labelStates.full + run.labelStates.abbreviated
      gate(
        `${bg}.labels top-down orbit (real pointer): crowded labels come back — more drawn (whole or abbreviated) than at the wide framing, no drawn plate over a node, a tag, another plate or a direction cue`,
        run.labelTop.orbited &&
          run.labelTop.screen.labels > 0 &&
          run.labelTop.screen.overlaps.length === 0 &&
          run.labelTop.cueClash.cues > 0 &&
          run.labelTop.cueClash.cuePlate.length === 0 &&
          (crowded === 0 || shownTop > shownWide) &&
          run.labelTop.restored,
        run.labelTop,
      )
    }
    // quality pass "labels" round 2: the drums' floor tags ('PostgreSQL',
    // 'Elasticsearch') sat beside their drums, the inner end on the pad
    // under the drum's foot, the outer one under the bottom chrome
    // (tp2-final-dpr1/workbench-labels.png). Each is framed on itself at the
    // labels close-up distance: shown, its four corners on the unobstructed
    // canvas, and its plate clear of every card and drum solid on screen.
    run.storeTags = []
    const tagList = await page.evaluate(() => window.__scene3d.storeTagInfo())
    for (const [i, t] of tagList.entries()) {
      const cx = t.corners.reduce((a, c) => a + c.x, 0) / t.corners.length
      const cz = t.corners.reduce((a, c) => a + c.z, 0) / t.corners.length
      const file = await shot(`${bg}-tag-${i}`, async () =>
        page.evaluate(([x, z, d]) => window.__scene3d.focusWorld(x, z, d), [cx, cz, mid.d ?? 1200]),
      )
      const now = await page.evaluate((id) => {
        const tag = window.__scene3d.storeTagInfo().find((x) => x.id === id)
        const canvas = [...document.querySelectorAll('[data-testid="canvas-3d"] canvas')].pop()
        const pts = window.__scene3d.projectWorld(tag.corners)
        // a hair inside each corner: the rounded plate's own edge
        const c = { x: pts.reduce((a, p) => a + p.x, 0) / 4, y: pts.reduce((a, p) => a + p.y, 0) / 4 }
        const hits = pts.map((p) => document.elementFromPoint(p.x + (c.x - p.x) * 0.05, p.y + (c.y - p.y) * 0.05) === canvas)
        return { text: tag.text, visible: tag.visible, pts, hits, nodes: window.__scene3d.labelScreenInfo().nodes }
      }, t.id)
      const th = hull2d(now.pts)
      const gaps = now.nodes.filter((n) => n.kind !== 'tag').map((n) => ({ id: n.id, kind: n.kind, gapPx: +hullGap(th, hull2d(n.pts)).toFixed(1) }))
      // IN FRONT of its drum, not beside it: the whole plate below the
      // drum's lowest screen point (a board point nearer the camera is drawn
      // lower). The old +z tag at the iso azimuth sat beside the drum's foot
      // with 2.6 px of clearance — never occluded, so a gap test alone
      // passed it (measured with the old placement restored, tp3 mutant run)
      const own = now.nodes.find((n) => n.id === t.id && n.kind === 'drum')
      const belowPx = own ? +(Math.min(...now.pts.map((p) => p.y)) - Math.max(...own.pts.map((p) => p.y))).toFixed(1) : -Infinity
      run.storeTags.push({
        text: now.text,
        file,
        visible: now.visible,
        onCanvas: now.hits.every(Boolean),
        belowDrumPx: belowPx,
        minGapPx: Math.min(...gaps.map((g) => g.gapPx)),
        touching: gaps.filter((g) => g.gapPx <= 0),
      })
    }
    log(bg, 'store tags', run.storeTags.map((t) => `${t.text}:${t.visible ? 'shown' : 'hidden'}:${t.onCanvas ? 'canvas' : 'chrome'}:below ${t.belowDrumPx}:gap ${t.minGapPx}`))
    gate(
      `${bg}: every drum's floor tag shows whole when framed — on the unobstructed canvas, in front of its drum, clear of every card and drum on screen`,
      run.storeTags.length > 0 && run.storeTags.every((t) => t.visible && t.onCanvas && t.belowDrumPx >= 0 && t.touching.length === 0),
      run.storeTags,
    )
    if (await focusProp('canada-flag', 260)) run.shots.flag = await shot(`${bg}-flag`, async () => {})
    for (const leaf of ['maple-leaf-cluster', 'maple-leaf-drift', 'maple-leaf-fall', 'maple-leaf-bank']) {
      if (await focusProp(leaf, 220)) {
        run.shots.leaf = await shot(`${bg}-leaf`, async () => {})
        break
      }
    }
    // WHOLE-PROP close-ups (quality pass "mug"). The desk wildlife — loop3
    // graded the moose and beaver "crude" from the wide shot alone — in BOTH
    // worlds (the city's maquette-scale beaver had no close-up), then EVERY
    // desk-* prop the build placed: the blind critic could not score the
    // notebooks, plant, pencil cup, books, sketchbook or blueprint ("no
    // close-up, so not above 6"), and the old fixed 170-unit mug framing cut
    // its rim under the top toolbar.
    run.closeups = {}
    const deskIds = (await page.evaluate(() => window.__scene3d.decorInfo().archetypes))
      .map((a) => a.id)
      .filter((id) => id.startsWith('desk-'))
      .sort()
    for (const id of ['moose', 'beaver', ...deskIds]) {
      const c = await closeup(bg, id)
      if (!c) continue
      run.shots[id] = c.file
      run.closeups[id] = c
    }
    log(bg, 'close-ups', Object.fromEntries(Object.entries(run.closeups).map(([id, c]) => [id, { d: c.d, spanPx: c.spanPx, misses: c.misses.length }])))
    const missing = ['beaver', ...deskIds].filter((id) => !run.closeups[id])
    const cut = Object.entries(run.closeups).filter(([, c]) => c.misses.length > 0 || Math.max(...c.spanPx) < 200)
    gate(
      `${bg}: close-ups — the beaver and every desk prop present, each whole on the unobstructed canvas and >= 200 px across`,
      missing.length === 0 && cut.length === 0,
      { deskProps: deskIds, missing, cut: cut.map(([id, c]) => ({ id, spanPx: c.spanPx, misses: c.misses })) },
    )
    // quality pass "montroyal": the city's landmark, framed whole
    if (bg === 'city') {
      run.mount = await mountCloseup(bg)
      if (run.mount) run.shots['mont-royal'] = run.mount.file
      mountGates(bg, run.mount)
    }
    // quality pass "arrows": the direction arrowheads from every side, on
    // the workbench (the Studio desk the user graded them on)
    if (bg === 'workbench') {
      run.arrows = await evalArrows(bg)
      arrowGates(bg, run.arrows)
      // the selected line, light wood and the dark default board
      run.selectedLines = await evalSelectedLines(bg)
      selectedLineGates(bg, run.selectedLines)
    }
    // cold reload straight into the dressed 3D board (the "loading is long" case)
    at(`${bg}: cold reload`)
    const url = page.url()
    const coldProf = await profiled(`cold-${bg}`, () =>
      navigating(async () => {
        await page.goto(url.includes('view=3d') ? url : `${url}${url.includes('?') ? '&' : '?'}view=3d`)
        await page.waitForFunction(
          (b) => window.__scene3d?.decorInfo()?.world === b && !window.__scene3d.isCameraAnimating(),
          bg,
          { timeout: 120000 },
        )
        await firstFrameMeasured()
      }),
    )
    run.coldLoad = {
      readyMs: Math.round(await page.evaluate(() => performance.now())),
      longTasks: await longTasksSince(0),
      build: await page.evaluate(() => window.__scene3d.perfInfo()),
      profile: coldProf.profile,
    }
    log(bg, 'cold', run.coldLoad)
    // the ENTER framing (no fit click): what a viewer sees first
    run.shots.cold = await shot(`${bg}-cold`)
    // reported, not gated: see FLOOR_GRAIN_P75_MAX's note on the cold framing
    run.coldFloorGrain = await evalFloorGrain(run.shots.cold)
    log(bg, 'floor grain (cold)', run.coldFloorGrain)
    run.coldLegibility = await page.evaluate(() => window.__scene3d.textLegibility())
    // USER FEEDBACK 2026-10-10: loop 4 held the enter framing to the fit
    // contracts (every node + the desk flag on the unobstructed canvas),
    // which moved the enter camera ~2x out and halved every card face — the
    // user reported it as a font-size regression. The enter framing is the
    // base design pose again; fit and flag are REPORTED here, not gated (the
    // fit-click gates above still hold them for fit-to-screen).
    run.coldFit = await evalFit()
    run.coldFlagFrame = await evalFlagFrame()
    run.coldPose = await page.evaluate(() => ({ at: window.__scene3d.getPose(), base: window.__scene3d.presetPose() }))
    const poseRatio = run.coldPose.at.distance / run.coldPose.base.distance
    gate(`${bg}.cold: enter lands on the base design pose (distance ratio ${poseRatio.toFixed(3)})`, Math.abs(poseRatio - 1) < 0.02, run.coldPose)
    gate(`${bg}.coldLoad.postFirstNewPrograms empty`, run.coldLoad.build.postFirstNewPrograms.length === 0, run.coldLoad.build.postFirstNewPrograms)
    gate(`${bg}.coldLoad.longTasks.maxMs <= ${COLD_LONGTASK_MAX}`, run.coldLoad.longTasks.maxMs <= COLD_LONGTASK_MAX, run.coldLoad.longTasks)
    firstFrames.push({ label: `${bg}.coldLoad`, build: run.coldLoad.build })
    report.runs.push(run)
  }
  // LAST: it rewires the board every gate above grades
  if (!RECONNECT_ONLY && !ARROWS_ONLY && !MOUNT_ONLY) await reconnectGates()
  // A carried-over probe reads bit-identical across builds (loop1-r2:
  // 170.30000001192093 on enter-3D AND the city pick; 105.09999999403954 on
  // the city cold load AND the workbench pick). Equality was the tell while
  // first frames cost 100+ ms; it is not one any more: performance.now() is
  // coarsened to 0.1 ms here and first frames now cost ~3 ms, so two
  // INDEPENDENT frames collide routinely (loop4-scene-pre-dpr2: 8.5 on
  // enter3d and the cold load; loop4-scene-final4: 3.1 / 3.3 on both DPRs,
  // each with its own postFirstBuild). The probe stamps the build it
  // measured (postFirstBuild), so carried-over is now asked directly: every
  // measurement must belong to the build it reports. Equal VALUES are still
  // listed in the detail, for the reader.
  const carried = firstFrames.filter((f) => f.build.postFirstBuild !== f.build.builds)
  const equal = []
  for (let i = 0; i < firstFrames.length; i++) {
    for (let j = i + 1; j < firstFrames.length; j++) {
      const a = firstFrames[i].build.postFirstMs
      if (a > 0 && a === firstFrames[j].build.postFirstMs) equal.push([firstFrames[i].label, firstFrames[j].label, a])
    }
  }
  gate('postFirstMs never carried across builds', carried.length === 0, {
    measured: firstFrames.map((f) => [f.label, f.build.postFirstMs, f.build.postFirstBuild, f.build.builds]),
    carried: carried.map((f) => f.label),
    equalValues: equal,
  })
} catch (err) {
  report.error = String(err?.stack ?? err)
  // named by its step and recorded with it: the screenshot is never an
  // orphan the report does not explain
  report.errorStep = step
  report.errorShot = `error-${step.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}.png`
  await page.screenshot({ path: resolve(OUT, report.errorShot) }).catch(() => {})
  log('ERROR during', step, err)
} finally {
  // A run that threw is RED whatever it measured before the throw (the
  // report used to carry `error` beside an all-green gate list)…
  gate('the run finished without an exception', !report.error, report.error ? { step: report.errorStep, shot: report.errorShot } : undefined)
  // …and so is one whose page was reloaded under it (Vite full reload,
  // crash): what it measured after the reload is a different page load
  gate('no unexpected full page load during the run', report.reloads.length === 0, report.reloads)
  // Asked in finally so a run that died half-way still records which
  // backgrounds it never reached.
  const measured = report.runs.map((r) => r.background)
  const missing = REQUIRED_BACKGROUNDS.filter((bg) => !measured.includes(bg))
  const unrequested = BACKGROUNDS.filter((bg) => !measured.includes(bg))
  gate('every required background measured', missing.length === 0 && unrequested.length === 0, {
    required: REQUIRED_BACKGROUNDS,
    requested: BACKGROUNDS,
    measured,
    missing,
    unrequested,
  })
  report.finishedAt = new Date().toISOString()
  writeFileSync(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2))
  log('report →', resolve(OUT, 'report.json'))
  await browser.close()
}
const gateFailures = report.gates.filter((g) => !g.ok)
if (gateFailures.length) log(`${gateFailures.length} gate(s) failed`, gateFailures.map((g) => g.name))
process.exit(report.error || (STRICT && gateFailures.length) ? 1 : 0)
