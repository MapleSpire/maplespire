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
 * A raw NUL byte in a source file is a SILENT search failure.
 *
 * git, grep and ripgrep all classify a file containing 0x00 as BINARY. They do
 * not refuse loudly — they report NO MATCHES. So every code search touching
 * such a file comes back empty, and a reader concludes the symbol is not used
 * rather than that the tool declined to look.
 *
 * The second-order damage is line endings: because git sees the blob as binary,
 * `core.autocrlf` skips it, so the file keeps whatever endings it was first
 * committed with, and any tool that rewrites it can produce a whole-file diff
 * around a small change.
 *
 * The usual intent is legitimate: NUL as a separator that cannot occur inside
 * user input, when building a composite key. The encoding is the mistake.
 * `\u0000` in a template literal yields the identical string and leaves the
 * file greppable.
 */

/**
 * NUL IS NOT THE ONLY INVISIBLE BYTE. Other control bytes (e.g. `\u0001` used
 * as a psql field separator) do not turn the file binary, but they are just as
 * invisible in a terminal, in `grep` output, in a diff and in a review.
 *
 * So the scan covers the whole C0 range, minus the three that are legitimate
 * text: tab (0x09), LF (0x0a), CR (0x0d). DEL (0x7f) is included for the same
 * reason. Each finding names the exact byte.
 */
const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d])

/** True for a byte that cannot legitimately appear in a text source file. */
export function isForbiddenControlByte(byte) {
  if (byte === 0x7f) return true
  return byte < 0x20 && !ALLOWED_CONTROL_BYTES.has(byte)
}

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Byte offsets of every NUL in `buffer`. Empty when the file is clean. */
export function findNulOffsets(buffer) {
  const offsets = []
  for (let i = 0; i < buffer.length; i += 1) if (buffer[i] === 0) offsets.push(i)
  return offsets
}

/**
 * Byte offsets of every forbidden control byte, NUL included.
 *
 * Kept separate from `findNulOffsets` rather than replacing it: existing
 * callers and tests assert on NUL specifically, and widening a function's
 * meaning under its old name is how a gate comes to check something other than
 * what its callers believe.
 */
export function findControlByteOffsets(buffer) {
  const offsets = []
  for (let i = 0; i < buffer.length; i += 1) if (isForbiddenControlByte(buffer[i])) offsets.push(i)
  return offsets
}

/** 1-based line number of a byte offset — what an editor and a stack trace show. */
export function lineOfOffset(buffer, offset) {
  let line = 1
  for (let i = 0; i < offset && i < buffer.length; i += 1) if (buffer[i] === 0x0a) line += 1
  return line
}

/**
 * Extensions scanned. Deliberately a CLOSED list of text source kinds: images,
 * fonts, archives and snapshots legitimately contain NUL, and a scan that had
 * to guess would either miss sources or drown in binaries. A new text extension
 * that is not listed here is simply not covered — which is why the list is
 * asserted by a test rather than left to a reader's memory.
 */
export const SCANNED_EXTENSIONS = Object.freeze([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.json', '.css', '.scss', '.html', '.md', '.yml', '.yaml',
  '.sql', '.rs', '.toml', '.sh',
])

export function isScannedSourcePath(filePath) {
  const lower = filePath.toLowerCase()
  return SCANNED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * Human-readable finding, one per forbidden control byte, naming the file, the
 * line and WHICH byte — because "there is an invisible character on line 84" is
 * only actionable if it says which one.
 *
 * IT SCANS THE WHOLE C0 RANGE, not just NUL. The `byte` field is additive;
 * `file`, `line` and `offset` keep the meanings existing callers rely on.
 */
export function describeFindings(filePath, buffer) {
  return findControlByteOffsets(buffer).map((offset) => ({
    file: filePath,
    line: lineOfOffset(buffer, offset),
    offset,
    byte: `\\u${buffer[offset].toString(16).padStart(4, '0')}`,
  }))
}

// ---------------------------------------------------------------------------
// The RUNNABLE gate. Everything above is a predicate library; what follows is
// the entry point, so `node scripts/source-nul.mjs` scans the tree and fails
// on findings rather than printing nothing and exiting 0.
// ---------------------------------------------------------------------------

/** Every scanned file git knows about — tracked AND untracked-but-not-ignored,
 * because a brand-new file is exactly where this byte arrives. One
 * implementation, shared with `source-nul.test.mjs`, so the two cannot drift. */
export function scanWorkingTree(root) {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    // The archived measurements alone can push the file list past Node's
    // default 1 MiB capture limit, before source extensions are filtered.
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
    .split(/\r?\n/)
    .filter((line) => line.length > 0 && isScannedSourcePath(line))

  const findings = []
  for (const file of listed) {
    let buffer
    try {
      buffer = readFileSync(join(root, file))
    } catch {
      continue // deleted from the working tree but still in the index
    }
    findings.push(...describeFindings(file, buffer))
  }
  return { scanned: listed.length, findings }
}

// Only when this file IS the process entry point, so importing it stays free.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const { scanned, findings } = scanWorkingTree(root)
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} contains ${finding.byte}`)
  }
  // A scan that examined nothing is not a clean tree, hence the count floor.
  if (scanned < 500) {
    console.error(`refusing to report clean: only ${scanned} files were scanned`)
    process.exit(2)
  }
  console.error(`${scanned} files scanned, ${findings.length} finding(s)`)
  process.exit(findings.length > 0 ? 1 : 0)
}
