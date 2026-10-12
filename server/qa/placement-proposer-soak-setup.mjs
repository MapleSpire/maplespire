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
import { readFileSync } from 'node:fs'
import { createPlacementProposerFixture } from '../src/testing/placementProposerFixture.ts'
import { writeProposerArtifact } from './placement-proposer-artifacts.mjs'

// The supervisor bounds this preparation process separately to 60 seconds.
// The shared fixture attempts cleanup on setup failure. Its unbounded owner
// pools never enter the six-hour supervisor or the measured proposer child.
let fixture = null, result = null, failed = false
try {
  assert.equal(process.argv.length, 3)
  const input = JSON.parse(readFileSync(process.argv[2], 'utf8')), url = new URL(input.adminUrl)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && /^\/maplespire_t14f_[a-z0-9_]+$/.test(url.pathname) && url.search + url.hash === '')
  assert.ok(/^t14f_[a-f0-9]{16}$/.test(input.name))
  fixture = await createPlacementProposerFixture(input.adminUrl, input.name)
  result = { schema: fixture.db.schema, env: fixture.env, role: fixture.config.role }
  writeProposerArtifact(input.output, 'private/fixture.json', result)
} catch { failed = true }
finally {
  if (fixture) {
    try { await fixture.reader.end() } catch { failed = true }
    try { await fixture.db.pool.end() } catch { failed = true }
  }
}
process.stdout.write(JSON.stringify({ complete: !failed && result !== null, preparationOnly: true }) + '\n')
if (failed || result === null) process.exitCode = 1
