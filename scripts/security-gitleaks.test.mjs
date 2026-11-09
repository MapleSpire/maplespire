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
 * Does `.gitleaks.toml` catch a planted secret? Needs the real `gitleaks`.
 *
 * Run it with `npm run test:security-gitleaks` (the CI `security` job does).
 * It is NOT inside `test:ci-diagnostics` on purpose: `run-harness-suites`
 * treats any skip as a failure, and the `static` job has no gitleaks.
 *
 * When gitleaks is not installed this test is SKIPPED and says so on stderr;
 * a skip is not a pass. With REQUIRE_GITLEAKS=1 (CI) the absence FAILS instead.
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

const ROOT = path.resolve(import.meta.dirname, '..')
const CONFIG = path.join(ROOT, '.gitleaks.toml')
const have = !spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).error
const required = process.env.REQUIRE_GITLEAKS === '1'

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
/** A GitHub-PAT-shaped token, random per run so no scannable literal is committed. */
const plantedToken = () => `ghp_${[...randomBytes(36)].map((b) => ALNUM[b % ALNUM.length]).join('')}`

function scan(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gitleaks-plant-'))
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
    const report = path.join(dir, '..', `${path.basename(dir)}.json`)
    const r = spawnSync('gitleaks', ['dir', dir, '--config', CONFIG, '--report-format', 'json', '--report-path', report, '--no-banner', '--exit-code', '7'], { encoding: 'utf8' })
    const findings = r.status === 7 ? JSON.parse(readFileSync(report, 'utf8')) : []
    rmSync(report, { force: true })
    return { status: r.status, findings, stderr: r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (!have && required) {
  describe('gitleaks config', () => {
    it('gitleaks is installed (REQUIRE_GITLEAKS=1)', () => assert.fail('gitleaks is required here and is not installed'))
  })
} else {
  if (!have) console.error('SKIPPED: gitleaks is not installed — the planted-secret test did NOT run. This is not a pass.')
  describe('gitleaks config', { skip: have ? false : 'gitleaks not installed — test did not run' }, () => {
    it('catches a planted secret in a temp dir', () => {
      const { status, findings } = scan({ 'app.config.js': `export const token = '${plantedToken()}'\n` })
      assert.equal(status, 7, 'gitleaks must report a leak (exit code 7)')
      assert.ok(findings.length >= 1)
    })

    it('still catches it in a *.test.ts file: allowlists are path AND regex, not path alone', () => {
      const { status } = scan({ 'fixture.test.ts': `const token = '${plantedToken()}'\n` })
      assert.equal(status, 7)
    })

    it('reports nothing for a clean file (control)', () => {
      const { status, findings } = scan({ 'clean.js': 'export const answer = 42\n' })
      assert.equal(status, 0)
      assert.deepEqual(findings, [])
    })
  })
}
