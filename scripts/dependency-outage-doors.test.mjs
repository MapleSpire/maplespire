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

// WHO IS ALLOWED TO TURN A DEPENDENCY OUTAGE INTO HTTP.
//
// Dependency outages map to HTTP through ONE module
// (`runtime/dependencyOutageResponse.ts`). `dependencyOutageResponse.test.ts`
// counts that module's branches, but nothing there stops ANOTHER FILE from
// translating the same errors into HTTP on its own terms, so that clients get
// different answers depending on the route. This suite stops that.
//
// ── WHY RULE 3 (ONE DECLARATION PER CLASS) EXISTS ──────────────────────────
//
// Re-DECLARING `StaleSyncCellWriteError` locally instead of re-exporting the
// leaf corrupts throw sites and their own `instanceof` checks CONSISTENTLY, so
// every server test stays green while `instanceof` at the HTTP layer answers
// false and every refusal silently becomes a 500. Runtime identity gates catch
// that; rule 3 catches it one level earlier, in the source, where a second
// `class X extends Error` is visible without running anything.
//
// ── WHAT THIS SUITE CANNOT SEE ─────────────────────────────────────────────
//
// It matches the literal `instanceof <ClassName>` in comment-stripped source. A
// door that branched some OTHER way — a `catch` narrowing on `err.name`, a type
// guard function, a `switch (true)` — is invisible to it. It holds because
// every site in the tree is written this way, a convention this suite
// enforces. It also does not strip STRING literals, so the exact
// text `instanceof RedisUnavailableError` inside a quoted string would be
// counted as a door; there are none today and a false positive here is a red
// test, not a missed defect.
//
// Wired into `test:ci-diagnostics`, so it runs in `ci:local`. Deliberately NO
// `npm run` alias of its own: `gate-liveness.test.mjs` rejects a `node --test`
// suite that is declared but run by nothing.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './gate-liveness.test.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// IMPORTED, not re-derived. `stripComments` carries a regression test for a
// CRLF trap that makes a stripper fail OPEN (retain the comment, invent the
// finding); a second copy here would be a second place for that fix to be
// missing.

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    // `.mjs` as well as `.ts`: `server/scripts/` and `server/qa/` are mostly
    // `.mjs`, and a door that translates these errors is a door whatever its
    // extension. Excluding them would re-open the hole the root above closes.
    else if (/\.(ts|mjs)$/.test(name) && !/\.test\.(ts|mjs)$/.test(name)) out.push(full)
  }
  return out
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

/**
 * ROOTED AT `server/`, NOT `server/src`: a door placed in `server/scripts/`
 * would otherwise escape every rule (the same reason
 * `maintenance/lifecycleApplyLockCallers.test.ts` walks `server/`).
 *
 * `server/scripts/` is not a hypothetical location: it already holds the CLI
 * forms of three lifecycle doors, and those are exactly the programs most likely
 * to grow their own error translation.
 */
const SOURCES = walk(path.join(ROOT, 'server'))
  .map((file) => ({ path: rel(file), body: stripComments(readFileSync(file, 'utf8')) }))

const filesMatching = (pattern) => SOURCES
  .filter((file) => pattern.test(file.body))
  .map((file) => file.path)
  .sort()

/**
 * THE ALLOWLIST. Every entry carries the reason it is allowed to hold its own
 * branch, because an allowlist without reasons is a list of things somebody once
 * decided, and the next reader cannot tell an exception from an oversight.
 *
 * `kind` separates THROW-SITES from everything else, and that half is enforced:
 * a throw-site is checked with `new X(`, a handler with `instanceof X`, and
 * swapping one for the other goes red.
 *
 * `http` versus `swallow` is DOCUMENTATION, not enforcement: both are filtered
 * together as "handlers", which is correct — the question these rules ask is
 * "may this file branch on the error at all", and that is the same question
 * for a door and for a background saver. The distinction is here so a reader
 * can tell which is which.
 */
const DOORS = {
  RedisUnavailableError: [
    {
      path: 'server/src/runtime/dependencyOutageResponse.ts',
      kind: 'http',
      why: 'THE shared mapping. Both general doors consult it instead of restating a body.',
    },
    {
      path: 'server/src/runtime/redis.ts',
      kind: 'throw-site',
      why: 'Where the error is raised (`redis.ts:194`, `:207`, `:214`) — not a translation.',
    },
    {
      path: 'server/src/auth/passwordAuth.ts',
      kind: 'http',
      why: 'Pre-existing client contract: 503 `rate_limit_unavailable` with a login-specific message. B2-5b measured that unifying its body would break a client parsing that token.',
    },
    {
      path: 'server/src/auth/orgs.ts',
      kind: 'http',
      why: 'Same pre-existing `rate_limit_unavailable` contract with its own message.',
    },
    {
      path: 'server/src/ai/adminTechnologyRoutes.ts',
      kind: 'http',
      why: 'Answers `technology_research_runtime_unavailable`, a code specific to that subsystem rather than the shared one.',
    },
    {
      path: 'server/src/index.ts',
      kind: 'http',
      why: 'The rate-limit middleware answers `Rate-limit service unavailable` with no `message`. Recorded in B2-5b `whatIsNotCovered` entry 4 as deliberately not unified.',
    },
  ],
  StaleSyncCellWriteError: [
    {
      path: 'server/src/runtime/dependencyOutageResponse.ts',
      kind: 'http',
      why: 'THE shared mapping — the 503 that replaced the misleading 500.',
    },
    {
      path: 'server/src/automergeStorage.ts',
      kind: 'throw-site',
      why: 'Raises it (`staleWrite`, `coalesceStaleImmutableMutation`) and re-exports the leaf class.',
    },
    {
      path: 'server/src/automergeBackgroundSave.ts',
      kind: 'swallow',
      why: 'A background save that loses the fence is not a user-visible failure; it is back-pressure and the write is re-attempted by the owner.',
    },
    {
      path: 'server/src/readModel/staticDeltaProjector.ts',
      kind: 'swallow',
      why: 'The projector stops projecting a workspace it no longer owns. Turning that into HTTP would be answering a request nobody made.',
    },
    {
      path: 'server/src/forkRollback.ts',
      kind: 'swallow',
      why: 'Task B2-5d. The rollback of a fork the storage fence REFUSED classifies each document `fenceRefused` instead of spending a durable removal pass (3 ranges × attempts per document) on the same refusal and alerting per fork. It answers nothing to a client — the refusal that reached the caller is the one `dependencyOutageResponse` maps; this branch only decides what the cleanup reports.',
    },
  ],
  StoragePoolExhaustedError: [
    {
      path: 'server/src/runtime/dependencyOutageResponse.ts',
      kind: 'http',
      why: 'THE shared mapping. Task B2-5e: the 503 that replaced the `read model query failed` 500 the untyped pg borrow failure used to get.',
    },
    {
      path: 'server/src/automergeStorage.ts',
      kind: 'throw-site',
      why: 'Raises it at the two acquisition sites (`withClient` for the borrow, `acquireStoragePermit` for the queue deadline). Deliberately NOT re-exported: unlike `StaleSyncCellWriteError` nothing outside catches it by name.',
    },
  ],
}

/** Exactly one `class X extends Error` per name, in the LEAF module. */
const DECLARED_IN = {
  RedisUnavailableError: 'server/src/runtime/redisErrors.ts',
  StaleSyncCellWriteError: 'server/src/automergeStorageErrors.ts',
  StoragePoolExhaustedError: 'server/src/automergeStorageErrors.ts',
}

for (const [className, allowed] of Object.entries(DOORS)) {
  // TWO MARKERS, BECAUSE THE ENTRIES ARE TWO DIFFERENT CLAIMS. A `throw-site`
  // does not `instanceof` anything; it RAISES. Checking it with the branch
  // marker would report the throw sites as stale entries to be removed.
  const branches = new RegExp(`instanceof\\s+${className}\\b`)
  const raises = new RegExp(`new\\s+${className}\\s*\\(`)
  /**
   * AN ALIASED IMPORT IS THE SAME DOOR WEARING ANOTHER NAME:
   * `import { StaleSyncCellWriteError as Fence }` followed by
   * `err instanceof Fence` would slip past every rule below.
   *
   * Rather than resolve the alias — which needs a parser, not a regex — the rule
   * REFUSES the alias. Importing one of these classes under another name has
   * no legitimate use in this tree (there is no name collision to avoid), and
   * banning it keeps every rule below able to match on the real name.
   */
  const aliasedImport = new RegExp(`\\b${className}\\s+as\\s+\\w+`)
  const handlers = allowed.filter((entry) => entry.kind === 'http' || entry.kind === 'swallow')
  const throwSites = allowed.filter((entry) => entry.kind === 'throw-site')

  test(`${className}: no file branches on it outside the allowlist`, () => {
    const found = filesMatching(branches)
    const expected = handlers.map((entry) => entry.path).sort()
    const surprises = found.filter((file) => !expected.includes(file))
    assert.deepEqual(
      surprises,
      [],
      `${surprises.join(', ')} branches on ${className} without being on the allowlist in ${rel(fileURLToPath(import.meta.url))}. `
      + 'A new door means a client\'s answer depends on which route it arrived at — the divergence B2-5b removed. '
      + 'Consult `dependencyOutageResponse` instead, or add an entry here saying why this one is different. '
      + 'A throw-site that has STARTED branching must be re-classified deliberately, not by widening this list.',
    )
  })

  test(`${className}: no file raises it outside the allowlist`, () => {
    // The other direction, and it is not symmetric decoration: a second file
    // constructing this error is a second place the fence (or the runtime) can
    // refuse from, and the shared mapping's wording — which names ONE subsystem
    // — would then be answering for a condition it was not written for.
    const found = filesMatching(raises)
    const expected = throwSites.map((entry) => entry.path).sort()
    const surprises = found.filter((file) => !expected.includes(file))
    assert.deepEqual(surprises, [], `${surprises.join(', ')} constructs ${className} but is not an allowlisted throw-site.`)
  })

  test(`${className}: is never imported under another name`, () => {
    const aliased = filesMatching(aliasedImport)
    assert.deepEqual(
      aliased,
      [],
      `${aliased.join(', ')} imports ${className} under an alias. Every rule in this suite matches the real name, `
      + 'so an alias makes a door invisible to all of them — a QA lens defeated the first version of this suite exactly that way. '
      + 'There is no name collision in this tree that would require one.',
    )
  })

  test(`${className}: every allowlist entry is still live`, () => {
    // The half that rots silently. An entry whose file no longer carries its
    // marker is a rule that has stopped applying while still reading as
    // enforcement — a comment claiming a gate exists, inside the gate itself.
    // Same shape as an index row pointing at a renamed file.
    const branchFiles = filesMatching(branches)
    const raiseFiles = filesMatching(raises)
    const stale = allowed
      .filter((entry) => (entry.kind === 'throw-site'
        ? !raiseFiles.includes(entry.path)
        : !branchFiles.includes(entry.path)))
      .map((entry) => `${entry.path} (${entry.kind})`)
    assert.deepEqual(
      stale,
      [],
      `${stale.join(', ')} is allowlisted for ${className} but no longer carries the marker for its kind. Remove the entry, or fix the kind.`,
    )
  })

  test(`${className}: every allowlist entry says WHY, and names a kind`, () => {
    for (const entry of allowed) {
      assert.ok(entry.why && entry.why.trim().length > 20, `${entry.path} has no usable reason`)
      assert.ok(
        ['http', 'swallow', 'throw-site'].includes(entry.kind),
        `${entry.path} has kind='${entry.kind}', which is not one of http|swallow|throw-site`,
      )
    }
  })

  test(`${className}: the allowlist has not been emptied`, () => {
    // Without this, deleting the entries turns both rules above green — the
    // surprise set becomes empty because nothing is expected, and the stale set
    // becomes empty because nothing is allowlisted. Two green rules, no gate.
    assert.ok(allowed.length >= 2, `${className}'s allowlist is down to ${allowed.length} entries; that is a disabled gate, not a clean tree`)
    assert.ok(
      allowed.some((entry) => entry.kind === 'http' && entry.path === 'server/src/runtime/dependencyOutageResponse.ts'),
      `${className} must still be mapped by the SHARED module; if it is not, the two doors have diverged again`,
    )
  })

  test(`${className}: is declared exactly once, in a leaf module`, () => {
    // Rule 3 (see the header). A second declaration
    // leaves every test green and every `instanceof` across a module boundary
    // false.
    const declaration = new RegExp(`class\\s+${className}\\s+extends\\s+`)
    const declaring = filesMatching(declaration)
    assert.deepEqual(
      declaring,
      [DECLARED_IN[className]],
      `${className} must be declared exactly once, in ${DECLARED_IN[className]}. `
      + 'A second declaration corrupts the throwers and their own checks CONSISTENTLY — every suite stays green — '
      + 'while `instanceof` across a module boundary silently answers false.',
    )
  })
}

/**
 * THE FIVE SELF-TERMINATING HANDLERS, pinned by their own fallback text.
 *
 * `index.ts` boots a server on import, so no unit test can reach these five
 * call sites — which is exactly the condition under which a wiring quietly
 * comes undone. A survey of the `res.status(500)` sites in that file found
 * these five, and only these five, able to reach `StaleSyncCellWriteError`;
 * each does it through a `repo.flush(...)` in its own call graph. The others
 * are pure app-Postgres CRUD, read-only Automerge, raw-SQL GC that bypasses the
 * fenced adapter entirely, a Redis path that already answers 503, or the
 * minted-orphan reaper (see the count below).
 *
 * THE ANCHOR IS THE `console.error` LABEL, NOT THE FALLBACK BODY: a fallback
 * such as `'Failed to create version'` appears in more than one handler, and
 * `indexOf` would silently pick the wrong one. Hence the uniqueness assertion
 * below. Line numbers are avoided because they drift with every edit.
 */
const SELF_TERMINATING_HANDLERS = [
  { anchor: "console.error('Create landscape error:'", route: 'POST /api/landscapes' },
  { anchor: "console.error('Create editable version error:'", route: 'POST /api/landscapes/:id/versions' },
  { anchor: "console.error('Create draft error:'", route: 'POST /api/landscapes/:id/drafts' },
  { anchor: "console.error('Draft changes error:'", route: 'GET /api/landscapes/:id/drafts/:draftId/changes' },
  { anchor: "console.error('Draft merge error:'", route: 'POST /api/landscapes/:id/drafts/:draftId/merge' },
]

test('every self-terminating handler that can be fenced consults the shared mapping first', () => {
  const index = SOURCES.find((file) => file.path === 'server/src/index.ts')
  assert.ok(index, 'server/src/index.ts not found')
  assert.ok(
    index.body.includes('sendDependencyOutage'),
    'index.ts must import the shared sender; without it none of the guards below can exist',
  )

  // THE COUNT FIRST. Without it, deleting an entry from the list AND its guard
  // from `index.ts` in one edit would be green. The list
  // is the population; a rule that walks a population it also defines can be
  // satisfied by shrinking it.
  assert.equal(
    SELF_TERMINATING_HANDLERS.length,
    5,
    'the five fenceable self-terminating handlers are a MEASURED population (a survey of all 29 '
    + '`res.status(500)` sites in index.ts). Changing this number means re-running that survey, not editing a literal.',
  )

  // AND THE POPULATION IT WAS DRAWN FROM. A new self-terminating site is a site
  // nobody has asked the reachability question about, so the total is pinned.
  //
  // One surveyed site that needs no guard:
  // `POST /api/automerge/reap-minted-orphans` reaches NEITHER error. The reaper (mintedOrphanReaper.ts) deletes
  // through the primary `pool` inside its own transaction under the
  // coordinator's advisory-lock fence (`assertMaintenanceFence`, Postgres) —
  // never through the storage adapter's `withFencedMutation`, which is the
  // only thing that throws `StaleSyncCellWriteError` — and touches no Redis
  // client at all, so `RedisUnavailableError` has no path to it. No guard, no
  // entry above.
  const terminations = (index.body.match(/res\.status\(500\)/g) ?? []).length
  assert.equal(
    terminations,
    29,
    `index.ts now has ${terminations} \`res.status(500)\` sites, not the 29 the five-handler survey covered. `
    + 'Re-run the survey: can the new one reach StaleSyncCellWriteError or RedisUnavailableError? '
    + 'If it can, it needs a guard and an entry above; if it cannot, update this number with the reason.',
  )

  const problems = []
  for (const handler of SELF_TERMINATING_HANDLERS) {
    const occurrences = index.body.split(handler.anchor).length - 1
    if (occurrences === 0) {
      // A renamed anchor is NOT a pass. The rule would otherwise go green by
      // failing to find its own subject.
      problems.push(`${handler.route}: anchor ${handler.anchor} no longer appears in index.ts`)
      continue
    }
    if (occurrences > 1) {
      problems.push(`${handler.route}: anchor ${handler.anchor} matches ${occurrences} sites, so this rule cannot say which one it checked`)
      continue
    }
    // The guard sits inside the same `catch`, immediately before the log line.
    // 150 characters, and the number is MEASURED rather than generous: at all
    // five sites the guard ends exactly 45 characters before the anchor, and the
    // nearest PREVIOUS handler's guard is 1 287 characters back. A wider window
    // could find a neighbouring handler's guard and miss a deleted one.
    const window = index.body.slice(Math.max(0, index.body.indexOf(handler.anchor) - 150), index.body.indexOf(handler.anchor))
    // THE WHOLE GUARD, not just the call. A bare `sendDependencyOutage(res, err)`
    // with no `return` writes the 503 and then falls through to the handler's
    // own `res.status(500)`, which throws ERR_HTTP_HEADERS_SENT.
    if (!/if \(sendDependencyOutage\(res, err\)\) return/.test(window)) {
      problems.push(`${handler.route}: terminates its own error without the full "if (sendDependencyOutage(res, err)) return" guard`)
    }
  }
  assert.deepEqual(
    problems,
    [],
    `${problems.join('; ')}\n`
    + 'Each of these handlers can reach StaleSyncCellWriteError through a repo.flush() in its call graph, '
    + 'and a fence refusal is transient. Their neighbours GET /api/automerge/root and '
    + 'POST /api/automerge/durable-heads already answer 503 for the same condition.',
  )
})

test('the leaf modules stay leaves: no import that builds a pool or a client at import time', () => {
  // WHY THE CLASSES MOVED AT ALL. `db.ts` constructs FOUR `pg.Pool`s at module
  // scope — `pool`, `readModelPool`, `syncCellPool`, `lifecycleApplyPool` — and
  // `redis.ts` constructs two runtimes, with `redisRuntimeConfig()` able to
  // THROW during import. The HTTP layer has to `instanceof` these classes;
  // importing them through the heavy modules would make `routeErrors.ts`
  // (which otherwise reaches neither `pg` nor `redis`) do all of that at import.
  //
  // The rule is structural rather than behavioural on purpose: "does importing
  // this open a socket" cannot be asserted without importing it, which is the
  // thing under test.
  for (const leaf of Object.values(DECLARED_IN)) {
    const body = SOURCES.find((file) => file.path === leaf)
    assert.ok(body, `${leaf} does not exist; the allowlist above points at nothing`)
    const imports = [...body.body.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
    const heavy = imports.filter((spec) => /(^|\/)(db|redis|index|automergeStorage|automergeServer)\.js$/.test(spec))
    assert.deepEqual(
      heavy,
      [],
      `${leaf} imports ${heavy.join(', ')}, which re-couples the leaf to a module with import-time side effects. `
      + 'The point of the leaf is that the HTTP layer can `instanceof` without constructing three pg pools and two Redis clients.',
    )
  }
})
