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

// Prove `qa/eviction-peeraware.mjs` can BOTH fail and pass, against real
// servers, end to end.
//
//   EVICTION_DRILL_DATABASE_URL=postgres://…  node qa/eviction-fire-drill.mjs
//
// A throwaway database is required and there is no fallback: `TEST_DATABASE_URL`
// is accepted because `scripts/ci-local.mjs` already exports one, but the
// worktree's own `server/.env` value is deliberately NOT used. The drill boots
// servers that write Automerge documents, and the standing rule is that a
// worktree never shares a stack. The easiest throwaway is the container
// `ci-local` already runs:
//
//   postgres://maplespire:maplespire@localhost:5462/maplespire_ci
//
// ── WHY TWO ARMS ────────────────────────────────────────────────────────────
//
// `evictionFireDrillCore.mjs` carries the argument; the short form is that one
// arm can only ever prove half of it. A gate that always passes and a gate that
// always fails are each invisible to a single run, and their remedies are
// opposite.
//
// ── THE FOUR THINGS THAT WOULD MAKE THIS DRILL LIE, AND WHAT STOPS EACH ─────
//
// 1. A LEAKED SERVER ANSWERING THE WRONG ARM. On Windows, killing a spawned
//    `tsx` orphans the node process and it keeps the port, so a stale server
//    can serve "new" code. The structural defence is that the arms use
//    SEPARATE PORTS, so there is no shared resource to sequence. Belt and
//    braces: each port is asserted FREE before its server is spawned and again
//    after it is killed, and the verdict additionally requires the two arms to
//    report DIFFERENT `processBootId`s.
//
// 2. A CLEANUP A SIGNAL CAN SKIP. E.g. a `DROP TABLE` in a SIGTERM handler is
//    skipped when the harness sends
//    SIGKILL, and on Windows `child.kill('SIGTERM')` has no graceful form at
//    all — Node maps it to `TerminateProcess`, so a handler in the child NEVER
//    runs. So nothing here is cleaned up by a signal handler: the port check
//    happens on the way IN, where nothing can skip it, and the kill is a
//    tree-kill whose EFFECT is then asserted rather than trusted.
//
// 3. THE INJECTION SILENTLY DOING NOTHING. A preload that patches nothing turns
//    the broken arm into a second healthy arm, and the drill would report "the
//    gate is fine" about a gate it never challenged. Two independent defences:
//    `qa/faultInjectPeerCheck.mts` throws at boot if the method it means to
//    replace is missing (so the arm fails loudly rather than quietly), and the
//    verdict requires the broken arm to have actually produced `failed` — a
//    no-op patch produces `passed` and is reported as the drill's headline
//    finding.
//
// 4. GRADING THE INSTRUMENT INSTEAD OF THE SUBJECT. An arm whose server never
//    booted, or whose gate voided its own run, says nothing about the gate's
//    discrimination. Those are VOID, never `failed` — the three-valued algebra
//    the rest of `qa/` uses: an instrument that suppresses a finding about the
//    system is worse than one that reports nothing.
//
// WHAT THE DRILL DELIBERATELY DOES NOT DO: give each arm its own database. The
// arms run strictly in sequence and each verdict is computed from deltas taken
// inside its OWN process, so cross-arm residue in storage cannot move either
// reading. A second database would be ceremony bought with a `psql` dependency.

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluateFireDrill, exitCodeForOutcome } from './evictionFireDrillCore.mjs'

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATABASE_URL = process.env.EVICTION_DRILL_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? null

// Distinct from the usual dev-stack ports. One port per arm, never one shared
// between them.
const PORT_BASE_RAW = process.env.EVICTION_DRILL_PORT_BASE ?? '3041'
// Validated rather than coerced: `Number('nonsense')` is NaN, `listen(NaN)`
// throws ERR_SOCKET_BAD_PORT, and inside `portIsFree`'s executor that is an
// unhandled rejection rather than a reason anybody can read.
const PORT_BASE = Number.isInteger(Number(PORT_BASE_RAW)) && Number(PORT_BASE_RAW) > 0 && Number(PORT_BASE_RAW) < 65_535
  ? Number(PORT_BASE_RAW)
  : null

// The gate's own window is ~13 s (a 1.5 s settle, a snapshot, then 9 s of
// sweeps at AM_IDLE_MS=4000 / AM_SWEEP_MS=1500). These bound the parts around
// it, and they are LITERALS rather than multiples of the values above: a bound
// derived from the constant it is bounding agrees with whatever that constant
// becomes, which is its own defect class.
const BOOT_CEILING_MS = 90_000
const GATE_CEILING_MS = 120_000
const STDERR_TAIL_CHARS = 600

const log = (message) => console.error(`[fire-drill] ${message}`)

/** Is anything listening on this port?
 *
 * Asked by BINDING, not by connecting. A connect probe answers "did something
 * accept me", which a half-dead server may fail while still holding the port —
 * and holding the port is the condition that matters, because it is what makes
 * the next `listen` fail and the arm boot into nothing. */
function portIsFree(port) {
  // Three-valued per family: `true` free, `false` genuinely occupied, `null`
  // this family could not answer.
  //
  // THE CODE MATTERS: not every error means "occupied". Measured:
  //
  //   free port, either family        -> listening
  //   port held by another process    -> EADDRINUSE
  //   address/family unavailable      -> EADDRNOTAVAIL
  //
  // A host without IPv6 answers the `::1` probe with EADDRNOTAVAIL (or
  // EAFNOSUPPORT), and a rule of "both families must bind" would then read
  // every port as permanently occupied — every arm voiding, forever, on a
  // machine where nothing is wrong.
  const bind = (host) => new Promise((resolve) => {
    // A ceiling of its own. `listen` always emits one of these two in practice,
    // but this is a gate path and the standing rule is never to await an
    // unbounded promise on one — a probe that never settles hangs the drill
    // with no deadline, because the caller's deadline is only consulted BETWEEN
    // attempts.
    const done = setTimeout(() => resolve(null), 5_000)
    const settle = (value) => { clearTimeout(done); resolve(value) }
    try {
      const probe = net.createServer()
      probe.once('error', (error) => settle(error?.code === 'EADDRINUSE' ? false : null))
      probe.once('listening', () => probe.close(() => settle(true)))
      // `listen` throws SYNCHRONOUSLY for a bad port (ERR_SOCKET_BAD_PORT),
      // which inside a promise executor rejects `portIsFree` and propagates all
      // the way out of `main()` — the drill would exit with NO QARESULT line.
      if (host === undefined) probe.listen(port)
      else probe.listen(port, host)
    } catch { settle(null) }
  })
  // THE WILDCARD PROBE IS THE ONE THAT MATTERS for the holder the drill
  // produces. Measured on win32 / node 22.14.0 against a holder bound the way
  // `app.listen(PORT)` binds (`server/src/index.ts` with `BIND_ADDRESS` unset —
  // `server.address()` reads `::`):
  //
  //   probe (wildcard) -> EADDRINUSE      probe 127.0.0.1 -> LISTENED
  //   probe '::'       -> EADDRINUSE      probe ::1       -> LISTENED
  //
  // Loopback probes alone would report a leaked server's port as released.
  //
  // All three are kept, because they catch different holders: the wildcard
  // probe misses a holder bound to `127.0.0.1` alone, and the loopback probes
  // miss the wildcard. On Linux a loopback bind DOES collide with a wildcard
  // holder, so this is Windows-only blindness — on the platform whose orphaned
  // ports are the reason this function exists.
  return Promise.all([bind(undefined), bind('127.0.0.1'), bind('::1')]).then((results) => {
    if (results.some((free) => free === false)) return false      // definitely occupied
    if (results.some((free) => free === true)) return true        // at least one family answered, none occupied
    return false                                                  // nobody could answer: not established, so not free
  })
}

async function waitForPortFree(port, ceilingMs) {
  const deadline = Date.now() + ceilingMs
  for (;;) {
    if (await portIsFree(port)) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 250))
  }
}

/** Kill the whole tree, because the thing holding the port is usually a CHILD.
 *
 * `taskkill /T` on Windows and a process-group kill elsewhere. Neither is
 * graceful and neither needs to be: the drill's database is a throwaway and the
 * server has nothing to flush that any later step reads. The EFFECT is asserted
 * by the caller (`waitForPortFree`) rather than inferred from this returning. */
function killTree(child) {
  if (!child?.pid) return
  // A pid the OS may have RECYCLED. `child.pid` stays set after the child
  // exits, and `child.kill()` is a no-op on a dead handle — but `taskkill /T /F`
  // and `process.kill(-pid)` take the raw number and will happily kill whatever
  // holds it now. When the fault preload throws at boot (its designed loud
  // failure) the child dies at ~2 s, long before any kill.
  //
  // The fencing-token rule: pids are recycled, so an identity must be checked
  // before it is acted on.
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

async function waitForServerReady(port, ceilingMs, hasExited) {
  const deadline = Date.now() + ceilingMs
  for (;;) {
    // The child is already gone — nothing will ever answer. Without this the
    // loop spends its whole 90 s ceiling on a failure that was knowable at
    // ~2 s, twice per drill, and leaves `killTree` firing at a long-dead pid.
    if (hasExited?.()) return false
    try {
      // `/api/automerge/root` rather than `/api/health`: health answers as soon
      // as express listens, and the gate's very first call is for the root URL.
      // Readiness has to mean "ready for what the subject does next", or the
      // drill reports a gate failure that is really a race it created.
      //
      // The per-request ceiling is load-bearing, not decoration. `fetch` here
      // is undici, whose `headersTimeout`/`bodyTimeout` default to 300 s — five
      // minutes past the deadline this loop believes bounds it, and the
      // deadline is only consulted BETWEEN attempts. And this route can hang:
      // it reaches document resolution, and `repo.find()` never settles with a network adapter attached and no peer
      // connected, which is exactly a freshly-booted arm before the gate dials in.
      const response = await fetch(`http://localhost:${port}/api/automerge/root`,
        { signal: AbortSignal.timeout(5_000) })
      if (response.ok) {
        const body = await response.json()
        if (typeof body?.url === 'string') return true
      }
    } catch { /* not up yet */ }
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** Run one arm: boot a server, run the gate against it, kill the server. */
async function runArm({ label, port, inject }) {
  const arm = { label, port, booted: false, gateExitCode: null, result: null, serverStderrTail: null, injected: inject }

  log(`${label} arm: checking port ${port} is free`)
  if (!(await portIsFree(port))) {
    arm.serverStderrTail = `port ${port} was already in use before this arm started — something is listening that this drill did not start`
    return arm
  }

  const args = ['--import', 'tsx']
  if (inject) args.push('--import', pathToFileURL(path.join(SERVER_DIR, 'qa', 'faultInjectPeerCheck.mts')).href)
  args.push('src/index.ts')

  log(`${label} arm: booting server on ${port}${inject ? ' WITH the peer-check fault injected' : ''}`)
  const child = spawn(process.execPath, args, {
    cwd: SERVER_DIR,
    // No shell, and `process.execPath` rather than `npx`: this repository lives
    // under a path containing a space, and `shell: true` on Windows re-splits
    // unquoted arguments on spaces. Going straight to the node binary removes
    // both the `.cmd` shim and the quoting hazard.
    shell: false,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL,
      // `dotenv/config` in `src/index.ts` does NOT overwrite variables the
      // parent already set — measured, not assumed, with `server/.env` present
      // and a sentinel in each of PORT, AUTH and DATABASE_URL. So these win.
      //
      // BUT dotenv DOES supply everything the parent omits, so a checkout with
      // a `server/.env` would run a materially DIFFERENT server from a fresh
      // clone or a CI runner that has none — and the drill's numbers would
      // describe the .env, not the branch.
      //
      // So every flag that SELECTS A CODE PATH for this scenario is pinned to a
      // literal below. These are not tuning knobs:
      //
      //   AUTH / AUTH_DEV_LOGIN — the two ADMIN endpoints the gate reads
      //     (`/api/automerge/stats`, `/api/platform/automerge-residency`) sit
      //     behind `requirePlatformAdminAtStageOn`: a no-op below stage 'on', a
      //     403 at it, so with AUTH=on the gate would read
      //     `{"error":"forbidden"}` from both. (It also reads `/api/health`,
      //     unauthenticated, and `/api/automerge/root`, which has its own
      //     workspace-key gate.)
      //   AM_SELECTIVE_SYNC — pinned ON, and this is the flag the SCENARIO
      //     itself depends on rather than merely a code path. Measured with it
      //     off: the healthy arm reports `evicted: 0` and VOIDS, and
      //     `documentsWithPeers` reads 3 instead of 2 — root + viewed + the
      //     orphan.
      //
      //     WHERE IT ACTS: NOT in `automergeServer.ts`'s share configuration
      //     (installed unconditionally since 2026-10-16).
      //     It is read directly by the VENDORED PATCH, in
      //     `CollectionSynchronizer.addPeer`
      //     (`patch-automerge-peer-sync-state.mjs`, installed into
      //     `node_modules/@automerge/automerge-repo/dist/synchronizer/CollectionSynchronizer.js`):
      //     with the flag off, a connecting peer is eagerly bound to EVERY
      //     resident DocSynchronizer, and `#addPeerToDoc` consults no share
      //     policy. So client B acquires a binding on the orphan, the sweep's
      //     `hasActivePeers` answers true, the orphan is correctly spared, and
      //     the run sees no eviction at all. The gate needs one genuinely
      //     unheld document to prove the sweep ran.
      //
      //     The distinction is load-bearing: because the patched `addPeer`
      //     reads the variable directly, the eager attach is NOT gated by
      //     the share configuration, so turning `AUTH=on` would not restore the
      //     scenario. It also means the scenario depends on the vendored patch
      //     being applied — see the witness below.
      //   READ_MODEL — a resident projector leases root/ModelMeta/registry,
      //     which is a known false-PASS for this exact check and
      //     moves the `evicted` delta the gate voids on.
      //   AM_WORKSPACE_ROUTING / SYNC_CELL_OWNERSHIP — flip the route gate from
      //     allow to deny for an unrouted peer.
      //   ORG_SEED — boots seeding work that competes for the same documents.
      //   AM_RESET_SYNC_STATE_ON_DISCONNECT — pinned for reproducibility only:
      //     it exists only in the vendored patch and calls
      //     `#syncStateTracker.resetStorage(storageId)`, which deletes
      //     PERSISTED sync-state rows for a departed storage id. It never
      //     touches `#peers` or `hasPeer`, which is all either witness reads.
      AUTH: 'off',
      AUTH_DEV_LOGIN: 'off',
      // `BIND_ADDRESS` selects the listen path (`index.ts` chooses
      // `app.listen(PORT, bindAddress)` over `app.listen(PORT)`), and therefore
      // decides which address a leaked server holds and whether `portIsFree`
      // can see it.
      BIND_ADDRESS: '',
      AM_SELECTIVE_SYNC: 'on',
      READ_MODEL: 'off',
      AM_WORKSPACE_ROUTING: 'off',
      SYNC_CELL_OWNERSHIP: 'off',
      ORG_SEED: 'off',
      AM_RESET_SYNC_STATE_ON_DISCONNECT: 'off',
      // The compressed eviction window used by the canary: the
      // defaults are 300 000 / 60 000, so an unset run observes no eviction at
      // all inside the gate's 9 s and VOIDs.
      AM_IDLE_MS: '4000',
      AM_SWEEP_MS: '1500',
    },
  })

  // A spawn that fails (bad path, EACCES, a broken cwd) emits 'error'. With no
  // listener that is an uncaught exception, and the drill dies with NO QARESULT
  // line at all — `ci-local` gets a bare non-zero exit and no three-valued
  // report, which is the one outcome this whole directory exists to prevent.
  let spawnError = null
  child.on('error', (error) => { spawnError = error?.message ?? String(error) })

  // Bounded on purpose. A classic measurement trap is the instrument consuming
  // what its subject needs; retaining a busy server's whole stdout
  // for the life of the drill is the cheap version of that.
  let tail = ''
  const absorb = (chunk) => { tail = (tail + chunk).slice(-STDERR_TAIL_CHARS) }
  child.stdout?.on('data', absorb)
  child.stderr?.on('data', absorb)
  let exitedEarly = null
  child.on('exit', (code, signal) => { exitedEarly = `server exited early (code=${code}, signal=${signal})` })

  const ready = await waitForServerReady(port, BOOT_CEILING_MS, () => exitedEarly !== null || spawnError !== null)
  if (!ready) {
    const why = spawnError ? `spawn failed: ${spawnError} — ` : (exitedEarly ? exitedEarly + ' — ' : '')
    arm.serverStderrTail = `${why}${tail.trim().slice(-STDERR_TAIL_CHARS)}`
    killTree(child)
    arm.portReleased = await waitForPortFree(port, 15_000)
    return arm
  }
  arm.booted = true

  log(`${label} arm: running the gate`)
  const gate = spawnSync(process.execPath, ['qa/eviction-peeraware.mjs'], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
    timeout: GATE_CEILING_MS,
    shell: false,
    // Explicit rather than the 1 MiB default. Today's QARESULT is far under it
    // (the residency snapshot carries no per-document arrays), so this is a
    // guard rather than a fix: a future field must not turn a pass into a
    // silent ENOBUFS with no output to explain it.
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, EVICTION_PEERAWARE_PORT: String(port) },
  })
  arm.gateExitCode = gate.status
  // A `spawnSync` TIMEOUT reports `status: null`, and grading that as "the gate
  // exited null, not 1" accuses the gate of a defect when the truth is that the
  // drill gave up on it. Recorded so the verdict can void instead.
  arm.gateTimedOut = gate.status === null
  const output = `${gate.stdout ?? ''}${gate.stderr ?? ''}`
  const match = output.match(/^QARESULT (.*)$/m)
  if (match) {
    try { arm.result = JSON.parse(match[1]) } catch { arm.result = null }
  }
  if (!arm.result) arm.serverStderrTail = output.trim().slice(-STDERR_TAIL_CHARS)

  log(`${label} arm: gate exited ${arm.gateExitCode}, outcome=${arm.result?.outcome ?? 'none'}`)
  killTree(child)
  // ASSERTED, not logged: `portReleased` reaches the report and the verdict, so
  // a drill that leaves a fault-injected server running cannot pass.
  //
  // A surviving arm-1 server would also break the sequencing argument this
  // file rests on: it would be CONCURRENT with arm 2 against the same database,
  // still sweeping, still holding connections, still able to take the
  // migration advisory lock.
  arm.portReleased = await waitForPortFree(port, 15_000)
  if (!arm.portReleased) {
    log(`WARNING: port ${port} is still held after killing the ${label} arm's server — ` +
      `recover with: taskkill /F /T /PID <pid>  (or kill -9 on POSIX)`)
  }
  return arm
}

/** Is the vendored automerge patch actually installed?
 *
 * The scenario depends on it: `AM_SELECTIVE_SYNC` is read by the PATCHED
 * `CollectionSynchronizer.addPeer`, not by branch source, so on a tree where
 * the patch is missing the healthy arm voids with `evicted: 0` and the operator
 * goes hunting an environment problem. `node_modules` is not on the branch and
 * a developer's tree drifts, so the drill witnesses it. `postinstall` applies
 * the patch, so CI is fine; a hand-managed checkout is where this fires.
 */
function automergePatchApplied() {
  try {
    const installed = path.join(SERVER_DIR, 'node_modules', '@automerge', 'automerge-repo',
      'dist', 'synchronizer', 'CollectionSynchronizer.js')
    return readFileSync(installed, 'utf8').includes('AM_SELECTIVE_SYNC')
  } catch {
    return false
  }
}

async function main() {
  if (!automergePatchApplied()) {
    console.error('[fire-drill] the vendored automerge patch is not installed — run `npm ci` (postinstall applies it).')
    console.log('QARESULT ' + JSON.stringify({
      test: 'eviction-fire-drill',
      outcome: 'void',
      reasons: [
        'VOID: the installed `CollectionSynchronizer` does not read AM_SELECTIVE_SYNC, so the vendored patch is ' +
        'missing — the scenario depends on it, and without it the healthy arm voids for a reason that is not about the gate',
      ],
      pass: false,
    }))
    process.exitCode = exitCodeForOutcome('void')
    return
  }
  if (PORT_BASE === null) {
    console.error(`[fire-drill] EVICTION_DRILL_PORT_BASE=${JSON.stringify(PORT_BASE_RAW)} is not a usable port number.`)
    console.log('QARESULT ' + JSON.stringify({
      test: 'eviction-fire-drill',
      outcome: 'void',
      reasons: [`VOID: EVICTION_DRILL_PORT_BASE=${JSON.stringify(PORT_BASE_RAW)} is not an integer port`],
      pass: false,
    }))
    process.exitCode = exitCodeForOutcome('void')
    return
  }
  if (!DATABASE_URL) {
    // FAIL, never skip. A green test run may simply not have run: both runs
    // exit 0 and nothing in the output distinguishes them.
    console.error(
      '[fire-drill] no database. Set EVICTION_DRILL_DATABASE_URL (or TEST_DATABASE_URL) to a THROWAWAY database.\n' +
      '             The container `scripts/ci-local.mjs` already runs is the easiest one:\n' +
      '               postgres://maplespire:maplespire@localhost:5462/maplespire_ci',
    )
    console.log('QARESULT ' + JSON.stringify({
      test: 'eviction-fire-drill',
      outcome: 'void',
      reasons: ['VOID: no EVICTION_DRILL_DATABASE_URL / TEST_DATABASE_URL was supplied, so no server could be booted'],
      pass: false,
    }))
    process.exitCode = exitCodeForOutcome('void')
    return
  }

  // The broken arm runs FIRST, deliberately. If the two arms ever did share a
  // process, the healthy arm running second would inherit a fault-injected
  // server and report `failed` — a loud, correct-shaped complaint. The other
  // order inherits a HEALTHY server into the broken arm and reports `passed`,
  // which is the silent direction.
  const broken = await runArm({ label: 'broken', port: PORT_BASE, inject: true })
  const healthy = await runArm({ label: 'healthy', port: PORT_BASE + 1, inject: false })

  const evaluation = evaluateFireDrill({ broken, healthy })
  const armReport = (arm) => ({
    port: arm.port,
    injected: arm.injected,
    booted: arm.booted,
    // Whether the server this arm started is actually GONE. Graded in
    // `armIsVoid`, and in the report because "the arm passed" and "the arm
    // cleaned up after itself" are different facts.
    portReleased: arm.portReleased ?? null,
    gateExitCode: arm.gateExitCode,
    outcome: arm.result?.outcome ?? null,
    peerBoundDelta: arm.result?.peerBoundDelta ?? null,
    peerBindingDelta: arm.result?.peerBindingDelta ?? null,
    evicted: arm.result?.evicted ?? null,
    // Carried because the gate publishes them SO the drill can say why a run
    // voided.
    joinedConnectionsBefore: arm.result?.joinedConnectionsBefore ?? null,
    joinedConnectionsAfter: arm.result?.joinedConnectionsAfter ?? null,
    // The witness margin: documents the client held against documents the
    // server saw with a peer. The healthy run sits at 2 against 2, so a VOID
    // about the witnesses is readable from the report without a re-run.
    clientDocumentsHeld: arm.result?.clientDocumentsHeld ?? null,
    documentsWithPeersBefore: arm.result?.documentsWithPeersBefore ?? null,
    processBootId: arm.result?.processBootId ?? null,
    // The two classification facts the verdict grades. Republished here so an
    // operator can see WHY an arm was called a server finding without diffing
    // the reason text — and so a run where they are absent is visible as
    // `null` rather than silently reading as `false`.
    serverFault: arm.result?.serverFault ?? null,
    restarted: arm.result?.restarted ?? null,
    reasons: arm.result?.reasons ?? null,
    serverStderrTail: arm.serverStderrTail,
  })

  console.log('QARESULT ' + JSON.stringify({
    test: 'eviction-fire-drill',
    broken: armReport(broken),
    healthy: armReport(healthy),
    discriminates: evaluation.discriminates,
    outcome: evaluation.outcome,
    reasons: evaluation.reasons,
    pass: evaluation.outcome === 'passed',
  }))
  for (const reason of evaluation.reasons) console.error(`[fire-drill] ${reason}`)
  process.exitCode = exitCodeForOutcome(evaluation.outcome)
}

await main()
