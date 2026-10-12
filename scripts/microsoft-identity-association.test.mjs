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
 * The Microsoft Entra publisher-domain file is OFF unless an operator sets
 * MS_IDENTITY_ASSOCIATION_APP_ID. These tests run the real nginx entrypoint
 * script with `sh` against a temporary directory, and check that both Compose
 * files and the image actually wire it.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'docker/nginx/40-microsoft-identity-association.sh')
const APP_ID = '11111111-2222-3333-4444-555555555555'

function run(appId, seed) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ms-identity-'))
  const target = path.join(dir, 'microsoft-identity-association.json')
  if (seed) writeFileSync(target, seed)
  try {
    const env = { ...process.env, MS_IDENTITY_ASSOCIATION_DIR: dir }
    if (appId === undefined) delete env.MS_IDENTITY_ASSOCIATION_APP_ID
    else env.MS_IDENTITY_ASSOCIATION_APP_ID = appId
    execFileSync('sh', [SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    return existsSync(target) ? readFileSync(target, 'utf8') : null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('off by default: no file is served', () => {
  assert.equal(run(undefined), null)
  assert.equal(run(''), null)
})

test('turning it off removes a file left by an earlier start', () => {
  assert.equal(run('', '{"stale":true}'), null)
})

test('on: serves the association for the configured application', () => {
  assert.deepEqual(JSON.parse(run(APP_ID)), { associatedApplications: [{ applicationId: APP_ID }] })
})

test('a value that is not a GUID is refused, never written into the JSON', () => {
  assert.equal(run('bad"value'), null)
  assert.equal(run(`${APP_ID} extra`), null)
})

test('the image installs it as an nginx entrypoint script, LF-only', () => {
  const dockerfile = readFileSync(path.join(ROOT, 'docker/nginx/Dockerfile'), 'utf8')
  assert.match(dockerfile, /COPY --chmod=755 docker\/nginx\/40-microsoft-identity-association\.sh \/docker-entrypoint\.d\//)
  assert.equal(readFileSync(SCRIPT).indexOf(0x0d), -1, 'a CR byte breaks the shebang')
})

test('both Compose files pass the setting to web, empty by default', () => {
  for (const file of ['compose.quickstart.yml', 'compose.maplespire.yml']) {
    const source = readFileSync(path.join(ROOT, file), 'utf8')
    assert.match(source, /^ {6}MS_IDENTITY_ASSOCIATION_APP_ID: \$\{MS_IDENTITY_ASSOCIATION_APP_ID:-\}$/m, file)
  }
})
