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
 * Copy the Spotlight search core from the app (the ruling copy) to the server.
 *
 *   node scripts/sync-spotlight-core.mjs           copy, report what changed
 *   node scripts/sync-spotlight-core.mjs --check   change nothing; exit 1 on drift
 *
 * Every non-test `.ts` file in `src/lib/search/spotlight/` is mirrored byte for
 * byte into `server/src/search/spotlight/`, and any other `.ts` file there is
 * removed. `src/lib/search/spotlight/spotlight.conformance.test.ts` enforces the
 * same rule inside `npm test`; this script is how you satisfy it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'lib', 'search', 'spotlight')
const mirror = join(root, 'server', 'src', 'search', 'spotlight')
const check = process.argv.includes('--check')

const isCore = (name) => name.endsWith('.ts') && !name.endsWith('.test.ts')
const core = readdirSync(source).filter(isCore).sort()
if (core.length === 0) {
  console.error(`sync-spotlight-core: no core files in ${source}`)
  process.exit(1)
}

const drift = []
if (!check) mkdirSync(mirror, { recursive: true })
for (const name of core) {
  const want = readFileSync(join(source, name))
  const target = join(mirror, name)
  const have = existsSync(target) ? readFileSync(target) : null
  if (have && have.equals(want)) continue
  drift.push(have ? `changed  ${name}` : `missing  ${name}`)
  if (!check) writeFileSync(target, want)
}
const extra = existsSync(mirror) ? readdirSync(mirror).filter((n) => n.endsWith('.ts') && !core.includes(n)) : []
for (const name of extra) {
  drift.push(`extra    ${name}`)
  if (!check) rmSync(join(mirror, name))
}

if (drift.length === 0) {
  console.log(`sync-spotlight-core: ${core.length} files, mirror is identical`)
} else if (check) {
  console.error(`sync-spotlight-core: the server mirror has drifted:\n  ${drift.join('\n  ')}\nRun: node scripts/sync-spotlight-core.mjs`)
  process.exit(1)
} else {
  console.log(`sync-spotlight-core: updated the server mirror:\n  ${drift.join('\n  ')}`)
}
