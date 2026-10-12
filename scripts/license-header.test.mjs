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

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { ESLint } from 'eslint'
import {
  addLicenseHeader,
  hasLicenseHeader,
  isEvidenceRootDirectory,
  LICENSE_HEADER,
  normalizeLicenseHeader,
} from './license-header.mjs'

test('accepts the exact MapleSpire AGPL header', () => {
  assert.equal(hasLicenseHeader(`${LICENSE_HEADER}\n\nexport const value = 1\n`), true)
})

test('rejects a source file without the required header', () => {
  assert.equal(hasLicenseHeader('export const value = 1\n'), false)
})

test('preserves a shebang before the license header', () => {
  const source = '#!/usr/bin/env node\nconsole.log("MapleSpire")\n'
  const updated = addLicenseHeader(source)

  assert.equal(updated.startsWith(`#!/usr/bin/env node\n${LICENSE_HEADER}\n\n`), true)
  assert.equal(hasLicenseHeader(updated), true)
})

test('does not duplicate an existing header', () => {
  const source = `${LICENSE_HEADER}\n\nexport const value = 1\n`
  assert.equal(addLicenseHeader(source), source)
})

test('accepts CRLF files and preserves their line endings', () => {
  const source = `${LICENSE_HEADER}\n\nexport const value = 1\n`.replace(/\n/g, '\r\n')
  assert.equal(hasLicenseHeader(source), true)
  assert.equal(normalizeLicenseHeader(source), source)
})

test('collapses duplicated headers to exactly one header', () => {
  const source = `${LICENSE_HEADER}\n\n${LICENSE_HEADER}\n\nexport const value = 1\n`
  const normalized = normalizeLicenseHeader(source)

  assert.equal(hasLicenseHeader(source), false)
  assert.equal(normalized, `${LICENSE_HEADER}\n\nexport const value = 1\n`)
  assert.equal(normalized.match(/SPDX-License-Identifier/g)?.length, 1)
})

test('evidence roots match exactly, including native Windows separators', () => {
  for (const directory of ['reports', 'docs/plan-cellulaire/mesures/logs', 'docs\\plan-cellulaire\\mesures\\logs']) {
    assert.equal(isEvidenceRootDirectory(directory), true, directory)
  }
  for (const directory of ['reports-old', 'src/reports', 'server/reports', 'docs/plan-cellulaire/mesures/logs-next', 'other/docs/plan-cellulaire/mesures/logs']) {
    assert.equal(isEvidenceRootDirectory(directory), false, directory)
  }
})

test('licence CLIs preserve evidence bytes and still reject and repair neighbouring source', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'maplespire-license-scope-'))
  const evidence = ['reports/run/mutant.js', 'docs/plan-cellulaire/mesures/logs/run/vendor.ts']
  const source = ['src/app.ts', 'server/qa/check.ts', 'scripts/check.mjs', 'server/reports/check.js', 'reports-old/check.js', 'docs/plan-cellulaire/mesures/logs-next/check.js']
  const body = '// Original third-party or deliberately invalid fixture.\nexport const x = 1\n'
  const scripts = path.dirname(fileURLToPath(import.meta.url))
  const run = name => spawnSync(process.execPath, [path.join(scripts, name)], {
    cwd: temporaryRoot, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  })
  try {
    for (const file of [...evidence, ...source]) {
      await mkdir(path.dirname(path.join(temporaryRoot, file)), { recursive: true })
      await writeFile(path.join(temporaryRoot, file), body)
    }
    const before = run('verify-license-headers.mjs')
    assert.ifError(before.error)
    assert.equal(before.signal, null)
    assert.equal(before.status, 1)
    const failed = before.stderr.split(/\r?\n/).filter(line => line.startsWith('  - ')).map(line => line.slice(4).replace(/\\/g, '/')).sort()
    assert.deepEqual(failed, [...source].sort())
    const fix = run('apply-license-headers.mjs')
    assert.ifError(fix.error)
    assert.equal(fix.signal, null)
    assert.equal(fix.status, 0)
    for (const file of evidence) assert.equal(await readFile(path.join(temporaryRoot, file), 'utf8'), body)
    for (const file of source) assert.equal(hasLicenseHeader(await readFile(path.join(temporaryRoot, file), 'utf8')), true)
    const after = run('verify-license-headers.mjs')
    assert.ifError(after.error)
    assert.equal(after.signal, null)
    assert.equal(after.status, 0)
  } finally {
    // mkdtemp created this exact directory; never delete a caller-supplied path.
    assert.equal(path.dirname(temporaryRoot), path.resolve(tmpdir()))
    assert.ok(path.basename(temporaryRoot).startsWith('maplespire-license-scope-'))
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('real ESLint config ignores only evidence roots and enforces source licences', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const eslint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, 'eslint.config.js') })
  for (const file of ['reports/run/mutant.js', 'docs/plan-cellulaire/mesures/logs/run/vendor.ts']) {
    assert.equal(await eslint.isPathIgnored(path.join(root, file)), true, file)
  }
  for (const file of ['src/license-scope.ts', 'server/qa/license-scope.mts', 'scripts/license-scope.mjs', 'server/reports/license-scope.js', 'reports-old/license-scope.js', 'docs/plan-cellulaire/mesures/logs-next/license-scope.js']) {
    assert.equal(await eslint.isPathIgnored(path.join(root, file)), false, file)
    const [result] = await eslint.lintText('export const x = 1\n', { filePath: path.join(root, file) })
    assert.ok(result.messages.some(message => message.ruleId === 'local/license-header' && message.severity === 2), file)
  }
})
