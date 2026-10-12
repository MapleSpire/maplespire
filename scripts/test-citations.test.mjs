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
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

/**
 * That every test file a source comment CITES actually exists.
 *
 * The rule this enforces: a comment claiming a test exists is worse than no
 * comment when the test does not — every reader who checks sees the sentence
 * and stops. A citation that names a missing file goes red here instead of
 * waiting for a reader.
 *
 * This gate scans every source file INCLUDING ITSELF, so fixture names of
 * files that do not exist are built from parts in string literals and never
 * spelled out in a comment.
 *
 * ── What this gate does NOT check ──
 *
 * 1. **That the cited test asserts what the comment says it asserts.** It checks
 *    the file exists. Only a reader (or the suite the citation points at) can
 *    judge relevance; this gate closes the cheapest and commonest half.
 * 2. **Documentation.** Only source extensions are walked. `docs/**` cites test
 *    files constantly and churns.
 * 3. **Ambiguity.** Resolution is by BASENAME anywhere in the tree, because that
 *    is how the corpus writes citations: about a third resolve only by basename,
 *    some with a path that resolves from neither the citing file nor the root.
 *    While no cited basename exists in more than one place, basename and
 *    path-aware resolution agree, but nothing notices when that stops being
 *    true. A citation pointing at the wrong PACKAGE is invisible here.
 * 4. **This is a LINE scanner, not a parser.** A line inside a template literal
 *    that happens to start with `//` or `*` is read as a comment. Nothing in
 *    the corpus trips it today; a TypeScript parser would be disproportionate
 *    for a gate whose whole job is to stay at zero.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', 'build', 'coverage', 'target',
  '.vite', 'test-results', 'playwright-report', '.claude', 'refroot',
])

const SOURCE_EXT = /\.(ts|tsx|mts|mjs|js|jsx)$/

/**
 * A citation: a test-file name, with or without a leading path.
 *
 * `.mts`/`.mjs`/`.cjs` are in the list without a `test`/`spec` infix because
 * `server/qa/*.mts` and `scripts/*.mjs` are where this repository keeps its
 * executable checks and harnesses, and those are cited the same way (e.g.
 * `run-harness-suites.mjs`).
 *
 * Two non-name shapes are handled elsewhere: citations of out-of-tree probes
 * that say so (`SCRATCHPAD_CITATION` below), and bare suffix patterns in a
 * glob (the leading-dot rule in `collectCitations`).
 */
const CITATION = /[A-Za-z0-9_.\-/]+\.(?:test|spec)\.[a-z]+\b|[A-Za-z0-9_.\-/]+\.(?:mts|mjs|cjs)\b/g

/**
 * A line that declares its citation is deliberately outside the tree.
 *
 * The corpus uses one word for this — a probe that lived in a scratchpad, was
 * never committed, and is named so the reader knows the number came from
 * somewhere. That is a true statement about an absent file, not a
 * broken pointer, and a gate that reddens on it teaches people to delete the
 * provenance.
 *
 * It is an explicit, reviewable declaration, in the same spirit as
 * `test-skip-allowlist.json`: it costs a word, and the word has to be true.
 */
const SCRATCHPAD_CITATION = /scratchpad|uncommitted/i

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (stat.isDirectory()) walk(full, out)
    else if (SOURCE_EXT.test(entry)) out.push(full)
  }
  return out
}

/**
 * Splice a wrapped block-comment citation back together before matching.
 *
 * A citation name split across a line break is carried whole by neither
 * physical line; reporting it as missing would be a red on a correct comment,
 * whose cheapest resolution is to DELETE the citation.
 *
 * ## Why the rule is BACKTICK PARITY and not "the line ended mid-word"
 *
 * Gluing whenever a comment line ends on a token character is unsafe on prose:
 * a sentence wrapping after a short word welds that word onto a citation that
 * opens the next line, which then resolves to nothing. The case is pinned
 * below, in the join's own control.
 *
 * So: glue only while the accumulated text has an ODD number of backticks — i.e.
 * the wrap happens INSIDE a code span, which is how this corpus writes every
 * citation. Ordinary prose has no backticks and is never touched.
 *
 * The returned array keeps the ORIGINAL line number of the line a citation
 * starts on, because that is what a reader needs in order to go fix it.
 * (A wrap also defeats `grep`, so prefer reflowing such comments too.)
 */
export function joinWrappedComments(lines) {
  const oddBackticks = (s) => ((s.match(/`/g) ?? []).length % 2) === 1
  // A markdown FENCE is three backticks — odd, so parity alone would glue a
  // fence to its body and weld tokens (`npm runfsck`). A fence never
  // continues a token.
  const isFence = (s) => /^(\/\/+|\*+)?\s*`{3,}/.test(s.trim())
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
    if (!isComment) { out.push({ line: i + 1, text: lines[i] }); continue }
    let text = lines[i]
    let j = i
    // ONE continuation line, never more. Every real wrapped citation in this
    // corpus splits across exactly two lines, so a longer reach buys nothing
    // and is only more surface for the gate to invent a name on.
    if (!isFence(lines[i]) && j + 1 < lines.length && oddBackticks(text)) {
      const nextTrimmed = lines[j + 1].trim()
      const nextIsComment = nextTrimmed.startsWith('//') || nextTrimmed.startsWith('*')
      if (nextIsComment && !isFence(lines[j + 1])) {
        // Strip the comment marker AND the one space that follows it: the token
        // continues at the first non-marker character, which is what the author
        // meant by wrapping there.
        text += nextTrimmed.replace(/^(\/\/+|\*+)\s?/, '')
        j += 1
      }
    }
    out.push({ line: i + 1, text })
    i = j
  }
  return out
}

const isCommentLine = (line) => {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

/**
 * Which 1-based lines carry a declaration that their citation is out of tree.
 *
 * ## Why the window is ONE LINE and not the comment block
 *
 * Scoping the exemption to a whole comment BLOCK would silently stop checking
 * ordinary, live citations far down a long block. Every legitimate case is at
 * distance 0 or 1 — the marker is on the citation's own line or on the line
 * directly above it, because the name wrapped — so a one-line, DIRECTIONAL
 * window is enough.
 *
 * The count is asserted against a literal below, so adding an exemption shows
 * up in a diff as a number, like `test-skip-allowlist.json`: an allowlist you
 * cannot count is a silence.
 */
function exemptLines(lines) {
  const exempt = new Set()
  for (let i = 0; i < lines.length; i += 1) {
    if (!isCommentLine(lines[i])) continue
    const here = SCRATCHPAD_CITATION.test(lines[i])
    const above = i > 0 && isCommentLine(lines[i - 1]) && SCRATCHPAD_CITATION.test(lines[i - 1])
    if (here || above) exempt.add(i + 1)
  }
  return exempt
}

/** Is this match a PATTERN rather than a name — something no reader can open?
 *
 * Two forms:
 *   - a basename opening on a dot (`.test.mjs`), the suffix a runner's comment
 *     quotes when it describes which files it collects;
 *   - a basename glued to a leading `*` (`*Core.mjs`), which is a glob. A JSDoc
 *     continuation marker cannot be confused with it: that is `* ` with a space,
 *     and this looks at the character IMMEDIATELY before the match.
 * Reporting either as a missing file is noise, and noise is how a gate gets
 * switched off.
 */
export function isCitationPattern(joined, match) {
  if (path.basename(match[0]).startsWith('.')) return true
  return match.index > 0 && joined[match.index - 1] === '*'
}

/** Every citation an exemption is currently silencing, so the total can be
 *  asserted rather than trusted. */
export function exemptedCitations(text) {
  const lines = text.split(/\r?\n/)
  const exempt = exemptLines(lines)
  const found = []
  for (const { line, text: joined } of joinWrappedComments(lines)) {
    if (!isCommentLine(joined) || !exempt.has(line)) continue
    for (const match of joined.matchAll(CITATION)) {
      if (isCitationPattern(joined, match)) continue
      found.push({ line, cited: match[0] })
    }
  }
  return found
}

/** Every citation in one file's text, as {line, cited}. */
export function collectCitations(text) {
  const found = []
  const lines = text.split(/\r?\n/)
  const exempt = exemptLines(lines)
  for (const { line, text: joined } of joinWrappedComments(lines)) {
    // Comments only. An import specifier is not a citation, and a vitest
    // `describe` naming a sibling file is not one either.
    if (!isCommentLine(joined)) continue
    if (exempt.has(line)) continue
    for (const match of joined.matchAll(CITATION)) {
      if (isCitationPattern(joined, match)) continue
      found.push({ line, cited: match[0] })
    }
  }
  return found
}

/** Does a citation name something that exists? */
export function resolveCitation(cited, citingFile, basenames) {
  if (existsSync(path.resolve(path.dirname(citingFile), cited))) return true
  if (existsSync(path.resolve(ROOT, cited))) return true
  return basenames.has(path.basename(cited))
}

const files = walk(ROOT)
const basenames = new Set(files.map((f) => path.basename(f)))
// Test files are source files, so the walk already indexes them; nothing else
// is needed to resolve a citation of one.

const citations = []
const exempted = []
let unreadable = 0
for (const file of files) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { unreadable += 1; continue }
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  for (const c of collectCitations(text)) {
    citations.push({ file: rel, line: c.line, cited: c.cited, resolved: resolveCitation(c.cited, file, basenames) })
  }
  // EVERY exempted citation, resolving or not. A resolving citation inside an
  // exemption is not harmless; it is a citation the gate has stopped watching.
  // Counting only unresolved ones would let a widened exemption silence live
  // citations with the budget unchanged.
  for (const c of exemptedCitations(text)) exempted.push({ file: rel, line: c.line, cited: c.cited })
}

describe('test-file citations in source comments', () => {
  it('looked at a corpus, rather than reporting zero from an empty walk', () => {
    // "Nothing outstanding" is only true once everything has been looked at: a
    // walker broken by a rename would report zero stale citations and pass.
    //
    // The floors are LITERALS, well under the observed ~1 450 files / ~280
    // citations: a floor computed from the scan agrees with any number the scan
    // produces.
    assert.ok(files.length > 800, `walked only ${files.length} source files`)
    assert.ok(citations.length > 150, `found only ${citations.length} citations`)
    assert.equal(unreadable, 0, `${unreadable} source files could not be read`)
  })

  it('can fail — a citation of a file that does not exist is reported', () => {
    // THE CONTROL. Without it every assertion in this file is satisfied by a
    // resolver that returns `true` unconditionally, and the gate is the same
    // shape as the comments it exists to police: a claim nothing checks.
    //
    // The fixture name is BUILT FROM PARTS on purpose. Spelled out literally it
    // would be a citation, in a source file, of a file that does not exist —
    // this gate would find it while scanning itself and go red on its own
    // control.
    const missing = 'thisFileDoesNot' + 'Exist' + '.test.ts'
    const found = collectCitations(`// see \`${missing}\` for the gate`)
    assert.deepEqual(found.map((f) => f.cited), [missing])
    assert.equal(resolveCitation(missing, path.join(ROOT, 'scripts', 'x.mjs'), basenames), false)

    // And the other direction, so "reported" cannot mean "reports everything":
    // a real file resolves.
    assert.equal(resolveCitation('gate-liveness.test.mjs', path.join(ROOT, 'scripts', 'x.mjs'), basenames), true)

    // EVERY arm of `CITATION`, each extension separately: an alternation arm
    // that no fixture exercises can be deleted without a red (the corpus has no
    // `.cjs` citation, for instance).
    const seen = collectCitations([
      ' // see `someSuite.test.ts` and `otherSuite.spec.tsx`',
      ' // and `server/qa/someCheck.mts` and `scripts/someHarness.test.mjs`',
      ' // plus `tools/legacyHarness.cjs`',
    ].join('\n')).map((c) => c.cited)
    assert.deepEqual(seen, [
      'someSuite.test.ts',
      'otherSuite.spec.tsx',
      'server/qa/someCheck.mts',
      'scripts/someHarness.test.mjs',
      'tools/legacyHarness.cjs',
    ])
  })

  it('reads a GLOB as a pattern, not as a file it can go and open', () => {
    // Prose describing a family of modules with a leading wildcard must not be
    // read as a missing file: a wildcard in a comment recurs wherever a runner
    // describes what it collects.
    const star = String.fromCharCode(42)
    assert.deepEqual(collectCitations(` // the ${star}Core.mjs modules are imported`).map((c) => c.cited), [])
    assert.deepEqual(collectCitations(` // ${star}.test.mjs is collected by the runner`).map((c) => c.cited), [])
    // A path-shaped glob too, since the citation pattern admits `/`.
    assert.deepEqual(collectCitations(` // qa/${star}Core.mjs and nothing else`).map((c) => c.cited), [])

    // And the exemption is exactly one character wide. A JSDoc continuation is
    // `* ` WITH a space, so a real citation on such a line is still reported —
    // otherwise this rule would silence every JSDoc in the tree.
    assert.deepEqual(
      collectCitations(' * see diagramPeersCore.test.mjs for the battery').map((c) => c.cited),
      ['diagramPeersCore.test.mjs'],
    )
    // A star EARLIER in the path is exempt too: `[A-Za-z0-9_.\-/]+` admits `/`
    // but not `*`, so the match begins after the star and the star is still
    // the character immediately before it. Both are globs.
    assert.deepEqual(collectCitations(` // see a${star}b/thing.test.mjs`).map((c) => c.cited), [])
  })

  it('joins a citation wrapped inside a code span, and ONLY inside one', () => {
    // Without the join the gate reports a correct comment as broken, and the
    // cheapest way to clear that red is to delete the citation.
    const marker = String.fromCharCode(96)
    const wrapped = ` * COMPILED BY THE CLIENT TOO. ${marker}overlayWriteHead\n * .conformance.test.ts${marker} imports it, and it lives under src.`
    assert.deepEqual(
      collectCitations(wrapped).map((f) => f.cited),
      ['overlayWriteHead.conformance.test.ts'],
    )

    // THE CONTROL ON THE JOIN ITSELF. A join keyed on "the line ended mid-word" glues ordinary prose, welding
    // the trailing word of one line onto the citation that opens the next — a
    // name that resolves to nothing, invented by the gate out of a comment that
    // was correct. Backtick parity leaves prose alone, so the name below must
    // come back INTACT and alone.
    //
    // The fixture names stay inside STRING literals and are never written into
    // a comment. This gate scans itself and reads comment lines only, so a
    // deliberately-nonexistent name spelled out in prose here is a real finding
    // about this file.
    const prose = ' * the suite covering this lives next door and is\n * fine.spec.ts is not what that sentence said'
    assert.deepEqual(collectCitations(prose).map((f) => f.cited), ['fine.spec.ts'])
  })

  it('exempts a citation the line above declares out of tree, and reaches no further', () => {
    // ── READ THIS BEFORE EDITING ─────────────────────────────────────────────
    // Fixtures at distance 0 or 1 pass under BOTH a one-line window and a
    // whole-block exemption, so they cannot pin the choice. The discriminating
    // case is the LAST one below: a citation far enough down the same comment
    // block that the two rules disagree.
    const marker = String.fromCharCode(96)
    const gone = 'neverCommitted' + 'Probe' + '.mjs'

    // Same line as the declaration.
    const sameLine = ` * Measured out-of-process (UNCOMMITTED scratchpad probe ${marker}${gone}${marker}).`
    assert.deepEqual(collectCitations(sameLine), [], 'a declared out-of-tree probe must not be reported')

    // The line directly below it — the real shape, because the name wraps.
    const wrapped = ` * They lived in UNCOMMITTED scratchpad probes\n * (${marker}${gone}${marker}) — so nobody can replay them.`
    assert.deepEqual(collectCitations(wrapped), [])

    // The SAME text without the declaration must still be reported, or the
    // exemption is indistinguishable from switching the gate off.
    const undeclared = ` * Measured out-of-process:\n * ${marker}${gone}${marker} reported 2 500 ms.`
    assert.deepEqual(collectCitations(undeclared).map((c) => c.cited), [gone])

    // ── THE DISCRIMINATOR ────────────────────────────────────────────────────
    // Three lines below the declaration, inside ONE unbroken comment block.
    // The one-line window reports it; a block rule would silence it.
    const farBelow = [
      ' * They lived in UNCOMMITTED scratchpad probes.',
      ' * Some intervening prose about what they measured.',
      ' * More prose, still the same comment block.',
      ` * see ${marker}${gone}${marker} for the real suite`,
    ].join('\n')
    assert.deepEqual(
      collectCitations(farBelow).map((c) => c.cited),
      [gone],
      'a citation three lines below the declaration is NOT covered by it',
    )
  })

  it('ignores a suffix pattern, which is not a name anyone can go and read', () => {
    // `scripts/ci-local.mjs` and `run-harness-suites.mjs` both describe the glob
    // they run. Reporting that as a missing file is noise, and noise is how a
    // gate stops being run at all.
    assert.deepEqual(collectCitations(' // every .test.mjs suite in the repo'), [])
    // The rule is about the BASENAME opening on a dot, so a hidden DIRECTORY in
    // the path must not exempt a real name inside it.
    const hidden = collectCitations(' // see .probes/someProbe.mjs for the histogram')
    assert.deepEqual(hidden.map((c) => c.cited), ['.probes/someProbe.mjs'])
  })

  it('is silencing a COUNTED number of citations, and no more', () => {
    // What `test-skip-allowlist.json` has and a bare regex does not: the
    // suppression is visible in a diff as a number. Adding a scratchpad
    // declaration is fine — it just cannot be invisible.
    //
    // The literal is the point. Derived from the scan it would agree with any
    // value the scan produces — a bound taken from the constant under test.
    // When this goes red, read the list it prints
    // and decide; do not update the number reflexively.
    const report = exempted.map((e) => `  ${e.file}:${e.line}  ->  ${e.cited}`).join('\n')
    assert.equal(exempted.length, 0, `the out-of-tree exemption is silencing ${exempted.length} citations:\n${report}`)
  })

  it('names no test file that does not exist', () => {
    const stale = citations.filter((c) => !c.resolved)
    const report = stale.map((c) => `  ${c.file}:${c.line}  ->  ${c.cited}`).join('\n')
    assert.equal(stale.length, 0, `${stale.length} comment(s) cite a test file that does not exist:\n${report}`)
  })
})
