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

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { evaluateAutomergeMemorySoak, parseAutomergeMemorySoakConfig } from './automergeMemorySoakCore.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const loadUsersScript = resolve(here, '../qa/load-users.mjs')
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

async function requestJson(url, cookie, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : null
}

async function login(config) {
  const response = await fetch(`${config.baseUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: config.email }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`dev login returned HTTP ${response.status}`)
  const cookieHeader = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
  const cookie = cookieHeader?.match(/maplespire_session=[^;]+/)?.[0]
  if (!cookie) throw new Error('dev login did not return a session cookie')
  return cookie
}

function summarizeMemory(residency, runtime) {
  const buckets = Object.values(runtime.byType ?? {})
  return {
    rss: Number(residency.processMemory?.rss ?? 0),
    heapUsed: Number(residency.processMemory?.heapUsed ?? 0),
    external: Number(residency.processMemory?.external ?? 0),
    arrayBuffers: Number(residency.processMemory?.arrayBuffers ?? 0),
    handles: Number(residency.handles ?? 0),
    leasedDocuments: Number(residency.leasedDocuments ?? 0),
    evictedDocuments: Number(residency.evictedDocuments ?? 0),
    peerReferences: buckets.reduce((sum, bucket) => sum + Number(bucket.peerReferences ?? 0), 0),
    activePeerDocuments: buckets.reduce((sum, bucket) => sum + Number(bucket.activePeerDocuments ?? 0), 0),
    numOps: buckets.reduce((sum, bucket) => sum + Number(bucket.numOps ?? 0), 0),
    numChanges: buckets.reduce((sum, bucket) => sum + Number(bucket.numChanges ?? 0), 0),
    durableChunkBytes: buckets.reduce((sum, bucket) => sum + Number(bucket.durableChunkBytes ?? 0), 0),
  }
}

async function collectMemory(config, cookie) {
  const residency = await requestJson(`${config.baseUrl}/api/platform/automerge-residency/collect`, cookie, { method: 'POST' })
  const runtime = await requestJson(`${config.baseUrl}/api/platform/automerge-runtime`, cookie)
  return summarizeMemory(residency, runtime)
}

async function collectTransport(config, cookie) {
  const stats = await requestJson(`${config.baseUrl}/api/automerge/stats`, cookie)
  const transport = stats?.transport ?? {}
  return {
    accepted: Number(transport.connections?.accepted ?? 0),
    closed: Number(transport.connections?.closed ?? 0),
    normalCloses: Number(transport.connections?.closedByCategory?.normal ?? 0),
    abnormalCloses: Number(transport.connections?.closedByCategory?.abnormal ?? 0),
    backpressureCloses: Number(transport.connections?.closedByCategory?.backpressure ?? 0),
    droppedOutboundFrames: Number(transport.traffic?.outboundDroppedBackpressure ?? 0),
  }
}

function runWave(config, cookie, wave, targetUrl) {
  const args = [
    loadUsersScript,
    '--root', targetUrl,
    '--users', String(config.users),
    '--rounds', String(config.rounds),
    '--objects', String(config.objects),
    '--settle', String(config.settleMs),
    '--stagger', String(config.staggerMs),
    '--startDelay', '1000',
    '--roundDelay', '250',
  ]
  const child = spawn(process.execPath, args, {
    cwd: resolve(here, '..'),
    env: {
      ...process.env,
      QA_API: config.baseUrl,
      QA_WS: config.wsUrl,
      QA_LANDSCAPE_ID: config.landscapeId,
      QA_VERSION_ID: config.versionId,
      QA_SESSION_COOKIE: cookie,
      QA_REQUIRE_TRANSPORT: 'on',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-2 * 1024 * 1024) })
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2 * 1024 * 1024) })
  return new Promise((resolveResult, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      const line = stdout.split(/\r?\n/).findLast((candidate) => candidate.startsWith('QARESULT '))
      if (!line) return reject(new Error(`wave ${wave} emitted no QARESULT: ${stderr.slice(-1_000)}`))
      let result
      try { result = JSON.parse(line.slice('QARESULT '.length)) } catch (error) {
        return reject(new Error(`wave ${wave} emitted invalid QARESULT: ${error.message}`))
      }
      if (code !== 0) return reject(new Error(`wave ${wave} failed: ${stderr.slice(-1_000)}`))
      resolveResult(result)
    })
  })
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  const config = parseAutomergeMemorySoakConfig(env, argv)
  const cookie = await login(config)
  const db = config.followCurrent ? new pg.Pool({ connectionString: config.pgUrl, max: 2 }) : null
  const baseline = await collectMemory(config, cookie)
  const transportBaseline = await collectTransport(config, cookie)
  const waves = []
  try {
    for (let wave = 1; wave <= config.waves; wave += 1) {
      const targetUrl = db
        ? (await db.query(
          `SELECT segment_url FROM read_model_overlay_segments
           WHERE landscape_id = $1 AND version_id = $2
             AND collection = 'object' AND is_current`,
          [config.landscapeId, config.versionId],
        )).rows[0]?.segment_url
        : config.targetUrl
      if (!targetUrl) throw new Error(`wave ${wave} could not resolve the current object write head`)
      const load = await runWave(config, cookie, wave, targetUrl)
      await delay(config.idleWaitMs)
      const memory = await collectMemory(config, cookie)
      const transport = await collectTransport(config, cookie)
      waves.push({ wave, targetUrl, load, memory, transport })
      process.stderr.write(`[automerge-memory] wave ${wave}/${config.waves} head=${targetUrl.replace('automerge:', '')} rss=${memory.rss} external=${memory.external} handles=${memory.handles} peers=${memory.peerReferences}\n`)
    }
  } finally {
    await db?.end()
  }
  const result = evaluateAutomergeMemorySoak({ baseline, transportBaseline, waves }, config)
  console.log(JSON.stringify({ test: 'automerge-memory-soak', config: {
    waves: config.waves,
    users: config.users,
    rounds: config.rounds,
    objects: config.objects,
    idleWaitMs: config.idleWaitMs,
    capacityBytes: config.capacityBytes,
    convergenceBudgetMs: config.maxConvergenceMs,
    eventLoopP99BudgetMs: config.maxEventLoopP99Ms,
  }, ...result, samples: waves.map(({ wave, targetUrl, load, memory, transport }) => ({
    wave,
    targetUrl,
    convergenceMs: load.convergenceMs,
    eventLoopP99Ms: load.serverTransport?.eventLoopDelayP99Ms ?? null,
    memory,
    transport,
  })) }))
  if (result.outcome !== 'passed') process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
