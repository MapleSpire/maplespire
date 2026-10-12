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

// Detectors for "an instrument that reports pass while the thing it measures is
// broken": scripts that publish a verdict and then exit 0 anyway, verdicts
// decided by a constant, suites declared but run by nothing, and `file:NNN`
// citations that no longer point at anything. A clean run of these mechanical
// rules is a weaker claim than a human audit, but a reproducible one.
//
// Each rule is first exercised on a synthetic corpus that CONTAINS the defect:
// the real tree is clean, and on a clean tree a working rule and one that
// returns `[]` unconditionally look identical.
//
// What is deliberately NOT here, having been measured and rejected:
//   - "a script that publishes a verdict and never sets an exit code": every
//     hit was false — library modules, or scripts that signal failure by
//     THROWING, which already exits non-zero.
//   - "a qa/ file no runner references": mostly `lib.mjs` and the `*Core.mjs`
//     modules, which are imported rather than run; operator tools are unwired
//     by design, so the rule would fire on the healthy majority.
//   - "a `file:NNN` citation pointing into the SPDX header": no hits, and it
//     needs a header-length constant nothing enforces; the blank-line rule
//     below already covers what it would catch.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Strip comments so a rule never fires on prose ABOUT the rule.
 *
 * Line terminators: on a CRLF checkout `.*$` fails to match (`.` stops before
 * the CR, `$` without `m` only matches after it), so the comment is RETAINED
 * and a scanner built on it reports findings from prose. Hence `[^\r\n]*`.
 *
 * Order: line comments are stripped FIRST. Otherwise a line comment containing
 * `/*` (e.g. `// Same gate as /api/model/* …`) opens a phantom block comment
 * and `[\s\S]*?` swallows real code up to the next `*​/` — failing in the
 * direction that LOSES findings. A `//` inside a block comment is text that was
 * going to be deleted anyway. The `(^|[^:])` guard keeps `https://` in a string
 * from eating the rest of its line.
 *
 * Known limit: a `/*` inside a STRING literal (`'/api/model/*'`) still opens a
 * phantom block; closing that needs a real tokeniser.
 */
export function stripComments(text) {
  return text
    // `[^\r\n]*` rather than `.*$`: explicit about both terminators.
    // FIRST, so a `/*` inside a line comment cannot open a phantom block.
    .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(mjs|mts|ts|js)$/.test(name)) out.push(full)
  }
  return out
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

/** Every runnable script that could carry a verdict. Test files are excluded:
 *  a test framework owns their exit code. */
function verdictBearingScripts() {
  return [
    ...walk(path.join(ROOT, 'server', 'qa')),
    ...walk(path.join(ROOT, 'server', 'scripts')),
    ...walk(path.join(ROOT, 'scripts')),
  ].filter((file) => !/\.test\.(mjs|mts|ts|js)$/.test(file))
}

const readPackageScripts = (pkg) => {
  const json = JSON.parse(readFileSync(path.join(ROOT, pkg), 'utf8'))
  return Object.entries(json.scripts ?? {})
}

test('the comment stripper survives CRLF, which is how this file found its own defect', () => {
  // A regression case for the trap in the docblock above, pinned with a LITERAL
  // carriage return rather than by reading a file that happens to have one —
  // a checkout's line endings are not a property this suite should depend on.
  const crlf = '// process.exit(0) in prose\r\nconst real = 1\r\n'
  assert.doesNotMatch(stripComments(crlf), /process\.exit/, 'a CRLF comment must be stripped')
  assert.match(stripComments(crlf), /const real = 1/, 'and the code around it must survive')

  // The naive `.*$` form, kept executable so the claim above is checkable
  // rather than merely asserted.
  const naive = (text) => text.split('\n').map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  assert.match(naive(crlf), /process\.exit/, 'the `.*$` form must still fail, or the lesson has moved')
  assert.doesNotMatch(naive('// process.exit(0) in prose\nconst real = 1\n'), /process\.exit/, 'and it works on LF, which is why it looked correct')

  // A URL must not be mistaken for a comment — the `[^:]` guard is what stops
  // `https://…` from eating the rest of a line of real code.
  assert.match(stripComments('const u = "https://example.test/x"\r\n'), /example\.test/)

  // A `/*` INSIDE A LINE COMMENT MUST NOT OPEN A BLOCK. Stripping block
  // comments first made a line like `// … /api/model/* …` open a phantom block
  // that `[\s\S]*?` closed at the next `*/` far below, deleting the real code
  // in between (in this tree, code in over a hundred files).
  const phantom = [
    '// Same gate as /api/model/* (canonical key + allowedWorkspaceKeys).',
    'const survivor = 1',
    '/* a genuine block comment */',
    'const alsoSurvives = 2',
  ].join('\n')
  assert.match(stripComments(phantom), /const survivor = 1/, 'a `/*` inside a line comment must not swallow the code below it')
  assert.match(stripComments(phantom), /const alsoSurvives = 2/)
  assert.doesNotMatch(stripComments(phantom), /genuine block comment/, 'and real block comments must still go')

  // The wrong ORDER, kept executable so the claim is checkable rather than
  // asserted — exactly as the `.*$` form above is.
  const blockFirst = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1')
  assert.doesNotMatch(
    blockFirst(phantom),
    /const survivor = 1/,
    'the block-first order must still eat the code, or this lesson has moved',
  )

  // THE BLOCK-COMMENT half: no scanned file happens to carry a `/* … */`
  // containing a verdict, so without these cases the replacement that stops a
  // JSDoc from producing a false finding could become a no-op unnoticed.
  assert.doesNotMatch(stripComments('/* pass: x, then process.exit(0) */\nconst real = 1\n'), /process\.exit/)
  assert.match(stripComments('/* a note */\nconst real = 1\n'), /const real = 1/)
  // Multi-line, and NON-GREEDY: two block comments must not swallow the code
  // between them.
  assert.match(stripComments('/*\n pass: x\n*/\nconst mid = 1\n/* another */\n'), /const mid = 1/)
})

/** Declared `node --test` suites that the harness runner does not run.
 *  Pure, and taking both lists as arguments: the tree is CLEAN, so the scan
 *  below cannot tell a working rule from `missing = []`. The corpus has to be
 *  passable. */
export function unwiredSuites(declared, wired) {
  return declared.filter(({ name }) => !wired.has(name)).map(({ pkg, name }) => `${pkg}: ${name}`)
}

/** Suite files a `node --test` script names that do not exist. */
export function missingSuiteFiles(scripts, exists) {
  const missing = []
  for (const { pkg, name, cmd } of scripts) {
    if (!/\bnode --test\b/.test(cmd)) continue
    for (const token of cmd.split(/\s+/)) {
      if (!/\.(mjs|mts|js|ts)$/.test(token)) continue
      if (!exists(token)) missing.push(`${pkg}: ${name} names ${token}, which does not exist`)
    }
  }
  return missing
}

test('every `node --test` suite in a package.json is run by the harness runner', () => {
  // The predicate, on a synthetic corpus, BEFORE the tree — see `unwiredSuites`.
  assert.deepEqual(
    unwiredSuites([{ pkg: 'p', name: 'test:a', cmd: 'node --test a.mjs' }], new Set(['test:a'])),
    [], 'a wired suite must not be reported')
  assert.deepEqual(
    unwiredSuites([{ pkg: 'p', name: 'test:b', cmd: 'node --test b.mjs' }], new Set(['test:a'])),
    ['p: test:b'], 'an unwired suite must be reported')
  // A suite added to a package.json but not to `run-harness-suites.mjs` does
  // not run in CI; this is the detector for that.
  const runner = readFileSync(path.join(ROOT, 'scripts', 'run-harness-suites.mjs'), 'utf8')
  const wired = new Set([...runner.matchAll(/script: '([^']+)'/g)].map((m) => m[1]))

  const declared = [
    ...readPackageScripts('package.json').map(([name, cmd]) => ({ name, cmd, pkg: 'package.json' })),
    ...readPackageScripts('server/package.json').map(([name, cmd]) => ({ name, cmd, pkg: 'server/package.json' })),
  ].filter(({ cmd }) => /\bnode --test\b/.test(cmd))

  assert.ok(declared.length >= 12, `only ${declared.length} node --test suites found — the scan stopped matching`)
  assert.deepEqual(unwiredSuites(declared, wired), [], 'these suites are declared but run by nothing')
})

const FIXED_SUCCESS_PATTERNS = [/process\.exit\(\s*0\s*\)/, /process\.exitCode\s*=\s*0\b/]

/** Scripts that publish a verdict and then report success unconditionally. */
export function verdictThenFixedSuccess(files) {
  return files.filter(({ text }) => {
    const code = stripComments(text)
    // `pass:` / `outcome:` AND the shorthand `{ pass }` / `{ outcome }`:
    // `console.log({ outcome })` publishes a verdict too.
    const publishesVerdict = /\b(pass|outcome)\s*:/.test(code)
      || /[{,]\s*(pass|outcome)\s*[,}]/.test(code)
    return publishesVerdict && FIXED_SUCCESS_PATTERNS.some((pattern) => pattern.test(code))
  }).map(({ path: p }) => p)
}

/** Verdict expressions decided by a `DocHandle.state`, which cannot vary. */
export function stateDecidedVerdicts(files) {
  const offenders = []
  for (const { path: p, text } of files) {
    const lines = stripComments(text).split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      if (!/\bpass\s*[:=]/.test(lines[i])) continue
      // The verdict and its operands, which in this tree wrap across a few lines.
      if (/\.state\s*[!=]==/.test(lines.slice(i, i + 4).join(' '))) offenders.push(`${p}:${i + 1}`)
    }
  }
  return offenders
}

test('a script that computes a verdict does not then report success regardless', () => {
  // Synthetic first: on a clean tree nothing distinguishes this rule from
  // `if (false)`.
  assert.deepEqual(verdictThenFixedSuccess([
    { path: 'ok.mjs', text: 'const pass: true\nprocess.exitCode = pass ? 0 : 1\n' },
  ]), [], 'a verdict-driven exit code is the correct shape')
  assert.deepEqual(verdictThenFixedSuccess([
    { path: 'bad.mjs', text: 'console.log({ pass: verdict })\nprocess.exit(0)\n' },
  ]), ['bad.mjs'])
  // BOTH spellings: `process.exit(0)` and `process.exitCode = 0`.
  assert.deepEqual(verdictThenFixedSuccess([
    { path: 'bad2.mjs', text: 'console.log({ outcome })\nprocess.exitCode = 0\n' },
  ]), ['bad2.mjs'])
  // A file with a fixed success and NO verdict is not this rule's business.
  assert.deepEqual(verdictThenFixedSuccess([{ path: 'tool.mjs', text: 'process.exit(0)\n' }]), [])
  // And the comment stripper must be in the path, or the rule reports prose.
  assert.deepEqual(verdictThenFixedSuccess([
    { path: 'prose.mjs', text: '// { pass: x } then process.exit(0) would be wrong\nconst y = 1\n' },
  ]), [])
  // THEN the tree: no script may compute and publish a `pass` field and then
  // exit 0 unconditionally, which hides the verdict from every caller. The
  // correct shape is `process.exitCode = pass ? 0 : 1`.
  const scanned = verdictBearingScripts().map((file) => ({ path: rel(file), text: readFileSync(file, 'utf8') }))
  assert.ok(scanned.length >= 100, `only ${scanned.length} verdict-bearing scripts found — the walk stopped matching or the corpus shrank`)
  assert.deepEqual(verdictThenFixedSuccess(scanned), [],
    'these scripts compute a verdict and then report success unconditionally')
})

test('no verdict is decided by a DocHandle state, which cannot vary', () => {
  // `.state` is `ready` or `deleted` and nothing else in the pinned
  // automerge-repo, so a `pass` expression containing
  // `handle.state === 'ready'` carries a constant conjunct.
  //
  // Scoped to verdict lines on purpose. A dozen `handle.state !== 'ready'`
  // guards in `server/src` are deliberate; a blanket rule would fire on all of
  // them and be turned off. Synthetic cases first, for the same reason as above.
  assert.deepEqual(stateDecidedVerdicts([
    { path: 'bad.mjs', text: "const pass = serverAlive && handle.state === 'ready'\n" },
  ]), ['bad.mjs:1'])
  // THE COLON SPELLING (`pass: …` in an object literal), so the `[:=]`
  // character class cannot be narrowed to `=` unnoticed.
  assert.deepEqual(stateDecidedVerdicts([
    { path: 'colon.mjs', text: "report({ pass: handle.state === 'ready' })\n" },
  ]), ['colon.mjs:1'])
  // …and the `!==` half of the operand, on a line that carries a verdict.
  assert.deepEqual(stateDecidedVerdicts([
    { path: 'ne.mjs', text: "const pass = handle.state !== 'deleted'\n" },
  ]), ['ne.mjs:1'])
  // The operand may WRAP — this tree writes verdicts across several lines, and
  // a single-line rule would miss the shape it was written for.
  assert.deepEqual(stateDecidedVerdicts([
    { path: 'wrapped.mjs', text: 'const pass =\n  serverAlive &&\n  root.state === "ready"\n' },
  ]), ['wrapped.mjs:1'])
  // …but not FOREVER: a `.state` five lines below an unrelated `pass` is not
  // that verdict's operand, and a rule with no window reports the whole file.
  assert.deepEqual(stateDecidedVerdicts([
    { path: 'far.mjs', text: 'const pass = true\n\n\n\n\nif (h.state === "ready") {}\n' },
  ]), [])
  // A `.state` guard with no verdict on the line is the DELIBERATE shape this
  // rule must not fire on — a dozen live ones in `server/src`.
  assert.deepEqual(stateDecidedVerdicts([
    { path: 'guard.mjs', text: "if (handle.state !== 'ready') continue\n" },
  ]), [])
  // And prose about the rule is not a violation of it.
  assert.deepEqual(stateDecidedVerdicts([
    { path: 'prose.mjs', text: "// const pass = handle.state === 'ready' would be wrong\n" },
  ]), [])

  const scanned = verdictBearingScripts().map((file) => ({ path: rel(file), text: readFileSync(file, 'utf8') }))
  assert.ok(scanned.length >= 100, `only ${scanned.length} verdict-bearing scripts found — the walk stopped matching or the corpus shrank`)
  assert.deepEqual(stateDecidedVerdicts(scanned), [], 'a DocHandle state is being used as a verdict witness')
})

/** Every source file, for the line-citation rules below. Wider than
 *  `verdictBearingScripts()` on purpose: a citation rots the same way wherever
 *  it is written. */
function allSourceFiles() {
  return [
    ...walk(path.join(ROOT, 'src')),
    ...walk(path.join(ROOT, 'server', 'src')),
    ...walk(path.join(ROOT, 'server', 'qa')),
    ...walk(path.join(ROOT, 'server', 'scripts')),
    ...walk(path.join(ROOT, 'scripts')),
    ...walk(path.join(ROOT, 'e2e')),
  ]
}

const LINE_CITATION = /([A-Za-z0-9_.\-/]+\.(?:ts|tsx|mts|mjs|cjs|js|jsx)):(\d+)\b/g

/** Find `file.ext:NNN` citations whose line is blank or past the end.
 *
 * Takes the corpus as `[{ path, text }]` rather than reading the disk itself,
 * so it can be handed a synthetic tree that DOES contain a stale citation: on
 * a clean tree, a scanner that acquits everything is indistinguishable from a
 * working one. Returns `judged` (how many citations resolved) separately from
 * `stale`, because "it looked" and "it can tell" are different facts.
 */
export function staleLineCitations(files) {
  const byBasename = new Map()
  for (const file of files) {
    const base = file.path.split('/').pop()
    if (!byBasename.has(base)) byBasename.set(base, [])
    byBasename.get(base).push(file)
  }
  const linesCache = new Map()
  const linesOf = (file) => {
    if (!linesCache.has(file.path)) linesCache.set(file.path, file.text.split(/\r?\n/))
    return linesCache.get(file.path)
  }

  let judged = 0
  const stale = []
  for (const file of files) {
    for (const match of file.text.matchAll(LINE_CITATION)) {
      const cited = match[1]
      const line = Number(match[2])
      const base = cited.split('/').pop()
      // The path the citation actually gives, and NOTHING ELSE. A bare
      // `bridge.ts` resolves through `endsWith('/' + cited)`; there is no
      // basename fallback, because its only effect would be to acquit a
      // path-qualified citation of a missing file via an unrelated namesake.
      const namesake = byBasename.get(base) ?? []
      const candidates = namesake.filter((candidate) =>
        candidate.path === cited || candidate.path.endsWith('/' + cited))
      // Unresolvable basenames are SKIPPED, not failed. The skipped ones name
      // files inside `node_modules` — `Repo.js`, `DocHandle.js`,
      // `DocSynchronizer.js`, `DocumentQuery.js` — which the corpus excludes
      // and which comments cite constantly and correctly. Failing them would
      // make the rule fire on the healthy majority, which is how a gate gets
      // turned off. The only number anything depends on is the `judged` floor
      // in the test below.
      if (candidates.length === 0) continue
      judged += 1
      // With several candidates ONE acquits: `bridge.ts` exists twice here, and
      // a rule demanding every namesake agree would report on the wrong file.
      const acquitted = candidates.some((candidate) => (linesOf(candidate)[line - 1] ?? '').trim() !== '')
      if (!acquitted) stale.push(`${file.path} cites ${cited}:${line}, which is blank or past the end of the file`)
    }
  }
  return { judged, stale }
}

test('a `file:NNN` citation points at a line that exists and carries something', () => {
  // `scripts/test-citations.test.mjs` checks that a cited FILE exists. A line
  // number is the cheapest slice of relevance that is still mechanical, and it
  // rots silently on every edit ABOVE the cited line.
  //
  // TWO WAYS TO BE STALE: the line is past the end of the file, or it is
  // blank. Both are unambiguous, which keeps this at zero false positives.
  //
  // WHAT IT DELIBERATELY DOES NOT DO: judge whether the cited line says what
  // the citing comment claims. So it catches citations that drifted onto a
  // blank line or off the end, not one that slid by a few lines onto other code.

  // FIRST, on a synthetic corpus: a clean tree cannot tell a working scanner
  // from one that acquits everything.
  const synthetic = staleLineCitations([
    { path: 'a/citing.ts', text: [
      'cites b/target.ts:2 which is blank',      // stale — line 2 is empty
      'cites b/target.ts:99 which is past EOF',  // stale — past the end
      'cites b/target.ts:1 which is real',       // sound
      'cites b/target.ts:4 which is whitespace', // stale — whitespace-only line
    ].join('\n') },
    { path: 'b/target.ts', text: 'const real = 1\n\nconst alsoReal = 2\n   \n' },
  ])
  assert.equal(synthetic.judged, 4, 'the synthetic corpus must be fully judged, or it proves nothing')
  assert.equal(synthetic.stale.length, 3, `expected 3 stale, got ${JSON.stringify(synthetic.stale)}`)
  assert.match(synthetic.stale.join(' '), /target\.ts:2/)
  assert.match(synthetic.stale.join(' '), /target\.ts:99/)
  assert.match(synthetic.stale.join(' '), /target\.ts:4/)
  assert.doesNotMatch(synthetic.stale.join(' '), /target\.ts:1\b/, 'a sound citation must not be reported')

  // A BARE citation with two namesakes: one long enough acquits, because the
  // citation did not say which file it meant.
  const twoNamesakes = staleLineCitations([
    { path: 'a/citing.ts', text: 'cites target.ts:3' },
    { path: 'b/target.ts', text: 'one\n' },
    { path: 'c/target.ts', text: 'one\ntwo\nthree\n' },
  ])
  assert.deepEqual(twoNamesakes.stale, [], 'one long-enough namesake must acquit a BARE citation')

  // …but a citation that NAMES ITS DIRECTORY must be judged against that file
  // and no other, never acquitted by an unrelated namesake of the right length.
  const pathQualified = staleLineCitations([
    { path: 'a/citing.ts', text: 'cites b/target.ts:3' },
    { path: 'b/target.ts', text: 'one\n' },
    { path: 'c/target.ts', text: 'one\ntwo\nthree\n' },
  ])
  assert.equal(pathQualified.stale.length, 1, 'a path-qualified citation must be judged against THAT file')
  assert.match(pathQualified.stale.join(' '), /b\/target\.ts:3/)

  // A path-qualified citation naming a file that does NOT exist must be
  // skipped, never acquitted by a namesake elsewhere.
  const wrongDirectory = staleLineCitations([
    { path: 'a/citing.ts', text: 'cites server/src/foo.ts:900' },
    { path: 'src/foo.ts', text: 'x\n'.repeat(950) },
  ])
  assert.deepEqual(wrongDirectory.stale, [], 'an unresolvable path is skipped, not judged against a namesake')
  assert.equal(wrongDirectory.judged, 0, 'and it must not be COUNTED as judged either')

  // THEN the real tree.
  const { judged, stale } = staleLineCitations(
    allSourceFiles().map((file) => ({ path: rel(file), text: readFileSync(file, 'utf8') })),
  )
  // Source comments cite files without line numbers (a line number drifts on
  // every edit above it), so the real corpus may hold few or no `file:NNN`
  // citations. The scanner's liveness is proven by the synthetic corpus above;
  // here any citation that does exist must still point at a real line.
  assert.ok(judged >= 0)
  assert.deepEqual(stale, [], 'these line citations no longer point at anything')
})

test('every file a `node --test` script names actually exists', () => {
  // The cheap half of "the suite that runs nothing". `run-harness-suites.mjs`
  // already fails a suite that reports zero tests, but only once it has RUN it;
  // a renamed file is caught earlier and more clearly here.
  //
  // The synthetic corpus first, because this rule has ZERO hits on a healthy
  // tree and a body of `missing = []` would otherwise pass.
  const present = (token) => token !== 'gone.test.mjs'
  assert.deepEqual(
    missingSuiteFiles([{ pkg: 'p', name: 'test:a', cmd: 'node --test here.test.mjs' }], present),
    [], 'an existing file must not be reported')
  assert.deepEqual(
    missingSuiteFiles([{ pkg: 'p', name: 'test:b', cmd: 'node --test gone.test.mjs' }], present),
    ['p: test:b names gone.test.mjs, which does not exist'])
  // EVERY file in a multi-file script, not just the first — the real scripts
  // list several, and a rule that checked only `cmd.split(' ')[2]` would pass.
  assert.equal(
    missingSuiteFiles([{ pkg: 'p', name: 'test:c', cmd: 'node --test here.test.mjs gone.test.mjs' }], present).length,
    1, 'a later file in the same script must still be checked')
  // A script that is not a `node --test` script is not this rule's business.
  assert.deepEqual(
    missingSuiteFiles([{ pkg: 'p', name: 'build', cmd: 'tsc -b gone.test.mjs' }], present), [])

  const scripts = []
  for (const pkg of ['package.json', 'server/package.json']) {
    for (const [name, cmd] of readPackageScripts(pkg)) scripts.push({ pkg, name, cmd })
  }
  assert.ok(scripts.length >= 20, `only ${scripts.length} scripts read — the package scan stopped matching`)
  const onDisk = (token) => {
    // Resolved per package: `server/package.json`'s paths are relative to
    // `server/`, and resolving them all from the root would report every server
    // suite as missing.
    for (const pkg of ['package.json', 'server/package.json']) {
      if (existsSync(path.resolve(path.dirname(path.join(ROOT, pkg)), token))) return true
    }
    return false
  }
  assert.deepEqual(missingSuiteFiles(scripts, onDisk), [], 'these test suites name files that are not there')
})

/** Problems with a `CHECKS` witness/verdict pair, as literal regex SOURCES.
 *
 * Extracted because the runner has exactly ONE entry and it satisfies every
 * assertion, so dropping any one of them would change nothing observable. One
 * healthy example cannot exercise a rule. */
export function witnessVerdictProblems(pairs) {
  const problems = []
  for (const [witness, verdict] of pairs) {
    if (witness === verdict) {
      problems.push(`${witness}: a check whose witness IS its verdict cannot say whether it ran`)
      continue
    }
    // Anything matching the VERDICT must also match the WITNESS, or a check can
    // "agree" without having run. Comparing the witness's core against the
    // verdict's source tests that implication directly for the anchored shape
    // these entries use; length is only ever a proxy for it.
    // The ANCHOR is kept in the core: otherwise `/^QARESULT /m` against a
    // verdict of `/QARESULT /` (anchor dropped, so the verdict matches lines
    // the witness cannot) would pass.
    const core = witness.replace(/^\//, '').replace(/\/[gimsuy]*$/, '').replace(/\$$/, '')
    if (!verdict.includes(core)) {
      problems.push(`${verdict} must be a STRENGTHENING of ${witness}, but does not contain ${core}`)
    }
    // No length comparison: with the anchor kept in the core, it adds nothing
    // containment does not already check.
  }
  return problems
}

test('the harness runner keeps `witness` and `verdict` as different predicates', () => {
  // Synthetic pairs first — one real entry cannot exercise three rules.
  assert.deepEqual(witnessVerdictProblems([['/^QARESULT /m', '/^QARESULT .*"pass":true/m']]), [],
    'a strengthening pair is the correct shape')
  assert.match(witnessVerdictProblems([['/^QARESULT /m', '/^QARESULT /m']]).join(' '),
    /witness IS its verdict/, 'identical predicates leave "did it run" unasserted')
  assert.match(witnessVerdictProblems([['/^QARESULT /m', '/^DONE .*"pass":true/m']]).join(' '),
    /STRENGTHENING/, 'a verdict that can match where the witness cannot is not a strengthening')
  // Equal length but different, which is what the length check alone allows.
  assert.match(witnessVerdictProblems([['/^AAAA/m', '/^BBBB/m']]).join(' '), /STRENGTHENING/)
  // THE ANCHOR CASES. Each is a verdict that matches somewhere the witness
  // cannot, so "it agreed" no longer implies "it ran".
  for (const weakened of ['/QARESULT /', '/QARESULT .*"pass":true/', '/^XQARESULT .*"pass":true/m']) {
    assert.match(witnessVerdictProblems([['/^QARESULT /m', weakened]]).join(' '), /STRENGTHENING/,
      `${weakened} drops or moves the witness's anchor and must be reported`)
  }
  // `run-harness-suites.mjs` explains that folding the verdict into the witness
  // regex makes it the same predicate as the exit code, which leaves "did it
  // run at all" unasserted. This enforces that on the real CHECKS list.
  const runner = readFileSync(path.join(ROOT, 'scripts', 'run-harness-suites.mjs'), 'utf8')
  const checks = [...runner.matchAll(/witness:\s*(\/[^\n]*?\/[gimsuy]*),\s*\r?\n\s*verdict:\s*(\/[^\n]*?\/[gimsuy]*),/g)]
  assert.ok(checks.length >= 1, 'no CHECKS entry was parsed — the shape of the list changed')
  assert.deepEqual(witnessVerdictProblems(checks.map(([, witness, verdict]) => [witness, verdict])), [])
})
