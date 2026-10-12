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
 * `compose.quickstart.yml` — the three-service stack people try first.
 *
 * Each assertion pins a property whose loss was either measured on a clean
 * `up` or is refused by the server at boot, so a later "simplification" of the
 * file fails here instead of in a newcomer's terminal.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { REQUIRED } from './init-env.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The [name, value] pairs of one array in productionGuardrails.ts, read from
 *  source (node --test cannot import TypeScript without a flag). */
function guardrailPairs(arrayName) {
  const guardrails = readFileSync(path.join(ROOT, 'server/src/productionGuardrails.ts'), 'utf8')
  const block = new RegExp(`const ${arrayName}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\s*\\]`).exec(guardrails)
  assert.ok(block, `productionGuardrails.ts no longer declares \`${arrayName}\`; update this test`)
  const pairs = [...block[1].matchAll(/\['([A-Z_]+)',\s*'([^']*)'\]/g)].map((m) => [m[1], m[2]])
  assert.ok(pairs.length > 0, `no pairs parsed from \`${arrayName}\``)
  return pairs
}
const FILE = path.join(ROOT, 'compose.quickstart.yml')
const source = readFileSync(FILE, 'utf8')

/** The real Compose resolver, with fake secrets and none of the caller's env. */
function resolve(extra = []) {
  const directory = mkdtempSync(path.join(tmpdir(), 'maplespire-quickstart-'))
  const envFile = path.join(directory, 'test.env')
  writeFileSync(envFile, [...REQUIRED.map((name) => `${name}=fake-${name.toLowerCase()}`), ...extra].join('\n'))
  try {
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !/^(MAPLESPIRE_|EMAIL_|AWS_|MS_|GOOGLE_|CLOUDFLARE_|PLATFORM_|COMPOSE_|AI_)/.test(name)))
    return JSON.parse(execFileSync('docker', ['compose', '--env-file', envFile, '-f', FILE, 'config', '--format', 'json'],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const config = resolve()
const api = config.services.api.environment
const web = config.services.web.environment

test('it is three services and nothing else', () => {
  assert.deepEqual(Object.keys(config.services).sort(), ['api', 'postgres', 'web'])
})

test('the API passes the production guardrails it is started under', () => {
  // NODE_ENV=production makes the server refuse to boot without auth, the read
  // model, selective sync and a secret.
  assert.equal(api.NODE_ENV, 'production')
  for (const [name, value] of guardrailPairs('required')) assert.equal(api[name], value, `${name} must be ${value}`)
  for (const [name, value] of guardrailPairs('unsafe')) assert.notEqual(api[name], value, `${name} must not be ${value}`)
  assert.ok(api.AUTH_SECRET?.trim(), 'AUTH_SECRET must resolve to a value')
})

test('one process means no distributed runtime is required', () => {
  assert.equal(api.REDIS_URL, '')
  assert.equal(api.REDIS_REQUIRED, 'off')
  assert.equal(api.REDIS_RENDER_CACHE_URL, '')
  assert.equal(api.SYNC_CELL_OWNERSHIP, 'off')
  assert.equal(api.AM_WORKSPACE_ROUTING, 'off')
})

test('REST and the Automerge WebSocket both reach the single API', () => {
  // The image defaults point at `backend`, a host this file does not define.
  assert.equal(web.BACKEND_HOST, 'api')
  assert.equal(web.SYNC_WS_HOST, 'api')
  assert.equal(web.BACKEND_PORT, '3001')
  assert.equal(web.SYNC_WS_PORT, '3001')
})

test('the API image builds the runtime stage, not the backup drill', () => {
  assert.equal(config.services.api.build.target, 'runtime')
})

test('the AI endpoint allowlist set in .env reaches the API', () => {
  // Reported on a clean quickstart: every LM Studio / OpenAI-compatible base URL
  // was refused ("not permitted by the server AI endpoint allowlist") because
  // the file never passed AI_ALLOWED_BASE_URLS through.
  const url = 'http://host.docker.internal:1234/v1'
  const withAllowlist = resolve([`AI_ALLOWED_BASE_URLS=${url}`])
  assert.equal(withAllowlist.services.api.environment.AI_ALLOWED_BASE_URLS, url)
  assert.equal(api.AI_ALLOWED_BASE_URLS, '')
  // A model server on the host is reachable under that name on Linux too.
  assert.ok(config.services.api.extra_hosts?.some?.((h) => /^host\.docker\.internal[:=]host-gateway$/.test(h))
    ?? config.services.api.extra_hosts?.['host.docker.internal'] === 'host-gateway',
    JSON.stringify(config.services.api.extra_hosts))
})

test('the local email outbox is writable by the runtime user', () => {
  // Measured on a clean `up` of the full stack: without OUTBOX_DIR,
  // registration answered 500 with `EACCES: mkdir '/app/.outbox'`.
  assert.equal(api.EMAIL_PROVIDER, 'local')
  assert.match(api.OUTBOX_DIR, /^\/tmp\//)
})

test('the web build keeps boot-from-server and the server read model together', () => {
  // Boot from the server without the server read model truncates the global views.
  const args = config.services.web.build.args
  assert.equal(args.VITE_BOOT_FROM_SERVER, 'true')
  assert.equal(args.VITE_SERVER_READ_MODEL, 'true')
})

test('only the web front end is published, and only on loopback', () => {
  for (const name of ['api', 'postgres']) assert.equal(config.services[name].ports, undefined, `${name} must not publish a port`)
  assert.equal(config.services.web.ports.length, 1)
  assert.equal(config.services.web.ports[0].host_ip, '127.0.0.1')
})

test('every variable the file marks required is generated by init-env.mjs', () => {
  const required = new Set([...source.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]))
  assert.ok(required.size > 0)
  for (const name of required) assert.ok(REQUIRED.includes(name), `${name} is required but not generated`)
})
