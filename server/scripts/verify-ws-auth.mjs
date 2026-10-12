#!/usr/bin/env node
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

// Real end-to-end verification of WS/sync auth. Boots the ACTUAL server module
// (src/index.ts via tsx) on a scratch port against the isolated e2e Postgres
// (postgres://maplespire:maplespire@localhost:5433/maplespire), then drives real
// Automerge WebSocket connections against it with signed session cookies.
//
// Cases:
//   1. AUTH=on, no cookie          -> upgrade REJECTED (connection never opens)
//   2. AUTH=on, platform-admin     -> root doc SYNCS (find() resolves)
//   3. AUTH=on, member w/ no grant -> root doc does NOT sync within 5s (default-deny)
//   4. AUTH=off                    -> everything serves with NO cookie (byte-identical)
//
// Usage: node scripts/verify-ws-auth.mjs
// Exits non-zero if any case fails; prints PASS/FAIL per case either way.

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import pg from 'pg'
import { SignJWT } from 'jose'
import { Repo, isValidAutomergeUrl } from '@automerge/automerge-repo'
import { NetworkAdapter } from '@automerge/automerge-repo/slim'
import WS from 'ws'

const PORT = 3055
const DATABASE_URL = 'postgres://maplespire:maplespire@localhost:5433/maplespire'
const AUTH_SECRET = 'verify-ws-auth-scratch-secret-do-not-use-in-prod'
const BASE_HTTP = `http://localhost:${PORT}`
const BASE_WS = `ws://localhost:${PORT}/automerge`

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`)
}

function rid(prefix) {
  return `${prefix}_${randomBytes(6).toString('base64url')}`
}

// ---------------------------------------------------------------------
// A minimal cookie-aware WS client adapter. automerge-repo's own
// BrowserWebSocketClientAdapter (via isomorphic-ws) only ever calls
// `new WebSocket(url)` with no options, so it cannot attach a Cookie header
// — needed here to simulate a real browser's httpOnly-cookie session. `ws`'s
// WebSocket constructor DOES support a third `options.headers` argument, so
// this adapter is a thin, protocol-compatible reimplementation of
// WebSocketClientAdapter's connect/message flow using that. Verification-only
// code (not shipped in server/src); production browsers send the cookie
// automatically on the upgrade request, no adapter change needed there.
// ---------------------------------------------------------------------
class CookieWSClientAdapter extends NetworkAdapter {
  constructor(url, cookie) {
    super()
    this.url = url
    this.cookie = cookie
    this.socket = null
    this._ready = false
    this._readyPromise = new Promise((resolve) => {
      this._resolveReady = resolve
    })
  }

  isReady() {
    return this._ready
  }

  whenReady() {
    return this._readyPromise
  }

  #forceReady() {
    if (!this._ready) {
      this._ready = true
      this._resolveReady()
    }
  }

  connect(peerId, peerMetadata) {
    this.peerId = peerId
    this.peerMetadata = peerMetadata ?? {}
    const headers = this.cookie ? { Cookie: this.cookie } : undefined
    const socket = new WS(this.url, [], { headers })
    this.socket = socket
    socket.binaryType = 'arraybuffer'
    socket.on('open', () => {
      this.send({
        type: 'join',
        senderId: this.peerId,
        peerMetadata: this.peerMetadata,
        supportedProtocolVersions: ['1'],
      })
    })
    socket.on('message', (data) => {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data)
      let message
      try {
        message = decodeCbor(bytes)
      } catch {
        return
      }
      if (message.type === 'peer') {
        this.#forceReady()
        this.emit('peer-candidate', { peerId: message.senderId, peerMetadata: message.peerMetadata ?? {} })
        return
      }
      if (message.type === 'error') {
        this.emit('error', new Error(message.message))
        return
      }
      this.emit('message', message)
    })
    socket.on('close', () => {
      this.#forceReady() // an adapter that never becomes ready hangs whenReady() forever
      this.emit('peer-disconnected', { peerId: this.peerId })
    })
    socket.on('error', (err) => {
      this.#forceReady()
      this.emit('error', err)
    })
    socket.on('unexpected-response', (_req, res) => {
      this.rejectedStatus = res.statusCode
      this.#forceReady()
      this.emit('error', new Error(`upgrade rejected: HTTP ${res.statusCode}`))
    })
    // Mirror WebSocketClientAdapter's own 1s forced-ready fallback so a find()
    // isn't blocked forever if the server never answers 'join' for some
    // reason unrelated to auth (matches production adapter behavior).
    setTimeout(() => this.#forceReady(), 1000)
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== WS.OPEN) return
    this.socket.send(encodeCbor(message))
  }

  disconnect() {
    this.socket?.close()
  }
}

// cbor-x is a transitive dep of @automerge/automerge-repo (its own cbor
// helper uses it) — resolvable directly per the recon in auth/wsAuth.ts.
const { Encoder, decode: cborXdecode } = await import('cbor-x')
const encoder = new Encoder({ tagUint8Array: false, useRecords: false })
function encodeCbor(obj) {
  return encoder.encode(obj)
}
function decodeCbor(buf) {
  return cborXdecode(buf)
}

// ---------------------------------------------------------------------
// Server boot / teardown
// ---------------------------------------------------------------------

let serverProc = null

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_HTTP}/api/health`)
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await sleep(300)
  }
  return false
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
    const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'src/index.ts'], {
      cwd: serverDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    let out = ''
    proc.stdout.on('data', (d) => (out += d.toString()))
    proc.stderr.on('data', (d) => (out += d.toString()))
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code !== null && code !== 0 && !proc.__stoppedOnPurpose) {
        console.error('--- server output on unexpected exit ---')
        console.error(out.slice(-4000))
      }
    })
    serverProc = proc
    resolve(proc)
  })
}

async function stopServer() {
  if (!serverProc) return
  serverProc.__stoppedOnPurpose = true
  const pid = serverProc.pid
  if (process.platform === 'win32' && pid) {
    // `npx.cmd` + shell:true spawns a process TREE (cmd -> npx -> node/tsx);
    // a plain SIGTERM on the top-level pid leaves the actual tsx/node process
    // holding the port. `taskkill /T` kills the whole tree.
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      killer.on('exit', resolve)
      killer.on('error', resolve)
    })
  } else {
    serverProc.kill()
  }
  await sleep(500)
  serverProc = null
}

// ---------------------------------------------------------------------
// DB fixtures: a platform admin + a fresh member-with-no-grants, both with
// valid signed session cookies against AUTH_SECRET (mirrors what the real
// server would issue via /api/auth/dev-login, but signed directly here to
// avoid depending on AUTH_DEV_LOGIN plumbing for the verification script).
// ---------------------------------------------------------------------

async function signCookie(claims) {
  const secret = new TextEncoder().encode(AUTH_SECRET)
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(secret)
  return `maplespire_session=${encodeURIComponent(token)}`
}

async function setupFixtures(pool) {
  // Platform admin (no org needed — buildAccessCheck short-circuits on
  // isPlatformAdmin regardless of orgId).
  const adminId = rid('verify_admin')
  await pool.query(
    `INSERT INTO users (id, issuer, subject, email, name, is_platform_admin) VALUES ($1, 'verify', $1, $2, $2, true)`,
    [adminId, `${adminId}@example.com`]
  )
  const adminCookie = await signCookie({ userId: adminId, orgId: null, isPlatformAdmin: true, epoch: 1 })

  // Fresh org + member with NO grants at all.
  const orgId = rid('verify_org')
  await pool.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`, [orgId, 'Verify org', orgId])
  const memberId = rid('verify_member')
  await pool.query(`INSERT INTO users (id, issuer, subject, email, name) VALUES ($1, 'verify', $1, $2, $2)`, [
    memberId,
    `${memberId}@example.com`,
  ])
  await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, memberId])
  const memberCookie = await signCookie({ userId: memberId, orgId, isPlatformAdmin: false, epoch: 1 })

  return {
    adminId,
    adminCookie,
    orgId,
    memberId,
    memberCookie,
    cleanup: async () => {
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [[adminId, memberId]])
      await pool.query('DELETE FROM orgs WHERE id = $1', [orgId])
    },
  }
}

/** GET /api/automerge/root is a normal `/api/*` route, so under AUTH=on it
 * requires a session cookie too (the `requireAuth()` blanket gate — not the
 * WS auth under test, but a real browser always sends its cookie here
 * same-origin, so the verification script must too).
 *
 * This route is registered LATE in index.ts's `main()` — only after
 * `startAutomergeSync` resolves, well after `/api/health` starts answering
 * (registered at module load, before `app.listen`). So `waitForHealth()`
 * alone does not guarantee this route exists yet; poll past the gap instead
 * of trusting the first response (which can be Express's default 404 HTML,
 * not JSON, and would otherwise crash the script's `res.json()` parse). */
async function getRootUrl(cookie, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = null
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_HTTP}/api/automerge/root`, {
      headers: cookie ? { Cookie: cookie } : undefined,
    })
    lastStatus = res.status
    const contentType = res.headers.get('content-type') ?? ''
    if (res.ok && contentType.includes('application/json')) {
      const body = await res.json()
      if (body.url) return body.url
    }
    await sleep(300)
  }
  throw new Error(`GET /api/automerge/root never returned a usable url within ${timeoutMs}ms (last status ${lastStatus})`)
}

/** Try to sync `rootUrl` over a WS connection using `cookie` (null = no
 * cookie). Resolves { synced: true } if the doc arrives within `timeoutMs`,
 * { synced: false, rejected: true } if the upgrade itself was rejected, or
 * { synced: false } if it just timed out without syncing (default-deny). */
async function attemptSync(rootUrl, cookie, timeoutMs) {
  const adapter = new CookieWSClientAdapter(BASE_WS, cookie)
  const repo = new Repo({ network: [adapter], sharePolicy: async () => true })
  let rejected = false
  adapter.on('error', (err) => {
    if (/upgrade rejected/.test(String(err?.message))) rejected = true
  })
  try {
    const findPromise = repo.find(rootUrl).then(async (handle) => {
      await handle.whenReady()
      return handle.doc()
    })
    const timeoutPromise = sleep(timeoutMs).then(() => 'TIMEOUT')
    const result = await Promise.race([findPromise, timeoutPromise])
    if (result === 'TIMEOUT') return { synced: false, rejected }
    return { synced: result != null, rejected }
  } catch {
    return { synced: false, rejected }
  } finally {
    adapter.disconnect()
  }
}

/** Case 1 needs to detect upgrade REJECTION specifically (not just a sync
 * timeout) — waits briefly for the 'error' event from an unexpected-response,
 * separate from attemptSync's find()-based check (which would just hang). */
async function attemptConnectOnly(cookie, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new WS(BASE_WS, [], { headers: cookie ? { Cookie: cookie } : undefined })
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      resolve(outcome)
    }
    socket.on('open', () => finish({ rejected: false }))
    socket.on('unexpected-response', (_req, res) => finish({ rejected: true, status: res.statusCode }))
    socket.on('error', () => finish({ rejected: true, status: null }))
    setTimeout(() => finish({ rejected: false, timedOut: true }), timeoutMs)
  })
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 })

  // ---- Phase 1: AUTH=on ----
  console.log('\n=== Phase 1: AUTH=on ===')
  await startServer({
    PORT: String(PORT),
    DATABASE_URL,
    AUTH: 'on',
    AUTH_SECRET,
    AM_SELECTIVE_SYNC: 'on',
    READ_MODEL: 'off',
    GC: 'off',
  })
  const healthy = await waitForHealth()
  if (!healthy) {
    record('server boot (AUTH=on)', false, 'health check never came up')
    await stopServer()
    process.exitCode = 1
    return
  }
  record('server boot (AUTH=on)', true)

  const fixtures = await setupFixtures(pool)
  try {
    // Case 1: no cookie -> upgrade rejected.
    const noCookie = await attemptConnectOnly(null, 4000)
    record(
      'case 1: no cookie -> upgrade rejected',
      noCookie.rejected === true && (noCookie.status === 401 || noCookie.status === null),
      `status=${noCookie.status} timedOut=${!!noCookie.timedOut}`
    )

    const rootUrl = await getRootUrl(fixtures.adminCookie)
    if (!rootUrl || !isValidAutomergeUrl(rootUrl)) {
      throw new Error(`GET /api/automerge/root did not return a usable url (got ${JSON.stringify(rootUrl)})`)
    }

    // Case 2: platform-admin cookie -> root doc syncs.
    const adminSync = await attemptSync(rootUrl, fixtures.adminCookie, 8000)
    record('case 2: platform-admin cookie -> root doc SYNCS', adminSync.synced === true, JSON.stringify(adminSync))

    // Case 3: fresh member, no grants -> root doc does NOT sync within 5s.
    const memberSync = await attemptSync(rootUrl, fixtures.memberCookie, 5000)
    record(
      'case 3: member w/ no grants -> root doc does NOT sync within 5s (default-deny)',
      memberSync.synced === false,
      JSON.stringify(memberSync)
    )
  } finally {
    await fixtures.cleanup()
    await stopServer()
  }

  // ---- Phase 2: AUTH=off ----
  console.log('\n=== Phase 2: AUTH=off ===')
  await startServer({
    PORT: String(PORT),
    DATABASE_URL,
    AM_SELECTIVE_SYNC: 'on',
    READ_MODEL: 'off',
    GC: 'off',
    // AUTH unset -> defaults to 'off'
  })
  const healthy2 = await waitForHealth()
  record('server boot (AUTH=off)', healthy2)
  if (healthy2) {
    const rootUrl = await getRootUrl()
    const noCookieOff = await attemptSync(rootUrl, null, 8000)
    record('case 4: AUTH=off -> serves with NO cookie', noCookieOff.synced === true, JSON.stringify(noCookieOff))
  }
  await stopServer()

  await pool.end()

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} cases passed.`)
  if (failed.length > 0) {
    console.log('FAILURES:', failed.map((f) => f.name).join('; '))
    process.exitCode = 1
  }
}

main().catch(async (err) => {
  console.error('verify-ws-auth.mjs crashed:', err)
  await stopServer()
  process.exitCode = 1
})
