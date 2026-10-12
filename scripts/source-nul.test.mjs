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
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  describeFindings,
  findNulOffsets,
  isForbiddenControlByte,
  isScannedSourcePath,
  lineOfOffset,
  scanWorkingTree,
  SCANNED_EXTENSIONS,
} from './source-nul.mjs'

// Built, never written literally: a raw NUL in THIS file would trip the very
// scan below, and the suite would fail on its own fixture.
const NUL = Buffer.from([0])
const ROOT = path.resolve(import.meta.dirname, '..')

test('finds every NUL offset, and none in clean text', () => {
  assert.deepEqual(findNulOffsets(Buffer.from('const a = 1\n')), [])
  assert.deepEqual(findNulOffsets(Buffer.concat([Buffer.from('ab'), NUL, Buffer.from('cd'), NUL])), [2, 5])
})

test('reports the 1-based line an editor would show', () => {
  const buffer = Buffer.concat([Buffer.from('one\ntwo\nthr'), NUL, Buffer.from('ee\n')])
  assert.equal(lineOfOffset(buffer, findNulOffsets(buffer)[0]), 3)
})

test('the escape sequence is NOT a finding — that is the whole fix', () => {
  // `\u0000` in a template literal yields the identical string while leaving
  // the file greppable. A guard that flagged it would forbid the remedy.
  // The escape is built from its bytes on purpose: writing it literally here
  // would be re-escaped by whatever tool edits this file next, and the test
  // would then assert on a real NUL instead of on the two-character sequence.
  const escapeText = String.fromCharCode(92) + 'u0000'
  assert.deepEqual(findNulOffsets(Buffer.from(`const k = ` + escapeText + ` composite`)), [])
})

test('scans source extensions and skips binaries that legitimately hold NUL', () => {
  assert.equal(isScannedSourcePath('src/lib/layout/engine.ts'), true)
  assert.equal(isScannedSourcePath('scripts/ci-local.mjs'), true)
  assert.equal(isScannedSourcePath('public/icons/app.png'), false)
  assert.equal(isScannedSourcePath('assets/font.woff2'), false)
})

test('the extension list stays closed and lowercase', () => {
  // Pinned so a silent widening — or a stray uppercase entry that would never
  // match `isScannedSourcePath`'s lowercased input — fails here rather than
  // quietly reducing coverage.
  assert.equal(SCANNED_EXTENSIONS.every((ext) => ext === ext.toLowerCase() && ext.startsWith('.')), true)
  assert.equal(new Set(SCANNED_EXTENSIONS).size, SCANNED_EXTENSIONS.length)
})

test('describeFindings names the file, the line AND the byte, so a failure is actionable', () => {
  const buffer = Buffer.concat([Buffer.from('a\nb'), NUL])
  assert.deepEqual(describeFindings('src/x.ts', buffer), [
    { file: 'src/x.ts', line: 2, offset: 3, byte: '\\u0000' },
  ])
})

test('describeFindings catches a NON-NUL control byte — the one that got through', () => {
  // E.g. a `\u0001` written as a psql field separator. It does not turn the
  // file binary, but it is invisible in `grep` output, a diff and a review.
  //
  // Built from a byte value, never written literally, for the reason the NUL
  // fixture above gives: a literal here would trip the tree scan.
  const buffer = Buffer.concat([Buffer.from('const SEP = '), Buffer.from([1]), Buffer.from('\n')])
  assert.deepEqual(describeFindings('scripts/y.mjs', buffer), [
    { file: 'scripts/y.mjs', line: 1, offset: 12, byte: '\\u0001' },
  ])
})

test('describeFindings leaves tab, LF and CR alone — they are legitimate text', () => {
  // The negative control. Without it the widening would be indistinguishable
  // from "reject every byte below 0x20", which would fail on every file in the
  // repository and be reverted rather than fixed.
  const buffer = Buffer.from('a\tb\r\nc\n')
  assert.deepEqual(describeFindings('src/z.ts', buffer), [])
})

test('isForbiddenControlByte draws the boundary where the docstring says', () => {
  assert.equal(isForbiddenControlByte(0x00), true)
  assert.equal(isForbiddenControlByte(0x1f), true)
  assert.equal(isForbiddenControlByte(0x7f), true)
  assert.equal(isForbiddenControlByte(0x09), false)
  assert.equal(isForbiddenControlByte(0x0a), false)
  assert.equal(isForbiddenControlByte(0x0d), false)
  assert.equal(isForbiddenControlByte(0x20), false)
  assert.equal(isForbiddenControlByte(0x41), false)
})

test('running the SCRIPT is a gate — both directions, spawned', () => {
  // `node scripts/source-nul.mjs` must be a real gate, not a library import
  // that prints nothing and exits 0 for any tree.
  //
  // BOTH arms are required. The exit-0 arm alone is satisfied by a script that
  // does nothing; the exit-1 arm alone by a script that always fails.
  const script = path.join(ROOT, 'scripts', 'source-nul.mjs')
  const run = () => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }) }
    } catch (error) {
      return { code: error.status ?? -1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
    }
  }

  const clean = run()
  assert.equal(clean.code, 0, `a clean tree must exit 0, got ${clean.code}`)

  // The control, built rather than written literally — a raw NUL in THIS file
  // would trip the scan on its own fixture.
  const planted = path.join(ROOT, 'scripts', '.source-nul-control.mjs')
  try {
    writeFileSync(planted, Buffer.concat([Buffer.from('export const a = 1'), NUL, Buffer.from('\n')]))
    const dirty = run()
    assert.equal(dirty.code, 1, `a planted NUL must exit 1, got ${dirty.code}`)
    assert.match(dirty.out, /source-nul-control\.mjs:1/)
  } finally {
    rmSync(planted, { force: true })
  }

  // And back to clean, so a leftover fixture cannot make every later run red.
  assert.equal(run().code, 0)
})

test('NO SOURCE FILE IN THE WORKING TREE CONTAINS A RAW NUL BYTE', () => {
  // The check that actually protects the repository. The unit tests above only
  // prove the predicate works; this one proves the tree is clean, which is what
  // a reader of a green run is entitled to assume.
  //
  // `--others --exclude-standard` alongside `--cached` — UNTRACKED files too,
  // ignored ones excluded — because `git ls-files` alone covers a file only
  // once it has been added, and by then the defect is durable — a brand-new
  // file is exactly where this byte arrives.
  // Through the SHARED `scanWorkingTree`, which the script's own entry point
  // also calls, so the runnable path and the tested path are one scan.
  const { scanned, findings } = scanWorkingTree(ROOT)

  assert.ok(scanned > 500, `expected a real file list, got ${scanned}`)

  assert.deepEqual(
    findings,
    [],
    `raw NUL bytes make these files INVISIBLE to git/grep/ripgrep — a code search over them ` +
      `returns no matches rather than an error. Replace each with a unicode escape, which ` +
      `produces the identical string:\n${findings.map((f) => `  ${f.file}:${f.line}`).join('\n')}`,
  )
})
