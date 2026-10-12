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
 * Reading a GitHub workflow as text, for the gates that assert what CI runs.
 *
 * Shared by the gates (e.g. `scripts/ci-local-parity.test.mjs`) rather than
 * copied, because the naive forms fail in known ways:
 *
 *   - `workflow.includes(name)` passes on a commented-out step
 *     (`# run: npm run …`) and on `run: echo skipping <name>` — prose naming
 *     the script is enough to hide that CI never runs it.
 *   - a hard-coded `npm run` misses `npm --prefix server run typecheck:all`.
 *
 * EVERYTHING HERE IS TEXT, NOT YAML. This repo ships no YAML parser and four
 * functions do not justify a dependency. The consequence is stated on each
 * function: shapes these cannot read must resolve to NOTHING, so that an
 * unreadable workflow reports a gate UNWIRED. Red on a shape this cannot parse
 * is a nuisance; green on one would be the defect the gates exist to prevent.
 */

/**
 * The `run:` lines of a workflow, with commented-out ones removed.
 *
 * THE COMMENT STRIP IS CURRENTLY REDUNDANT: a line whose first non-space
 * character is `#` can never satisfy the `run:` anchor on the next line, so
 * tests that appear to pin it pass for the other filter's reason.
 *
 * It is KEPT because it becomes load-bearing the moment the anchor is loosened
 * to reach a block scalar (`run: |`), which is a known gap.
 */
export function runLines(source) {
  return source.split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => /^\s*(-\s*)?run:/.test(line))
}

/**
 * A step that runs and cannot fail the job, in every spelling shell allows.
 *
 * Four spellings, not one: `|| true`, `|| exit 0`, `; true` and `; exit 0` are
 * the same green-wash in different idioms. `continue-on-error` is the
 * YAML spelling of the same idea and is checked separately, on the job body.
 */
export function isGreenWashed(line) {
  return /(\|\||;)\s*(true|exit\s+0)\s*$/.test(line.trimEnd())
}

/**
 * Whether any of those lines actually invokes `npm … run … <name>`.
 *
 * The flags between `npm` and `run` vary (`npm run lint`, `npm run --silent x`,
 * `npm --prefix server run typecheck:all`), so they are matched loosely; the
 * script NAME is anchored on whitespace so `verify:sync-load` cannot satisfy a
 * search for `verify:sync-load-soak`. `[^#]*` keeps a trailing comment on the
 * line from supplying the match.
 */
export function runsScript(lines, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `\bnpm\b`, not `npm\b`: without the leading boundary, `pnpm run lint`
  // would match on the `npm` inside `pnpm`.
  const pattern = new RegExp(String.raw`\bnpm\b[^#]*\brun\b[^#]*(^|\s)${escaped}(\s|$)`)
  return lines.some((line) => pattern.test(line) && !isGreenWashed(line))
}

/**
 * Whether any of those lines invokes `<script> -- --<flag>=<value>`.
 *
 * The bench is reached as `npm --prefix server run bench:sync-cell -- --leg=x`,
 * so "is this leg wired" is a question about the ARGUMENT, not the script name,
 * and `runsScript` alone would report all four legs wired the moment one was.
 *
 * A green-washed line is rejected outright: the step runs, the gate runs, and the
 * job is green whatever the gate said. See `isGreenWashed` for the spellings.
 *
 * The value may be quoted. `--leg="active-active"` is the same step as
 * `--leg=active-active`, and reporting it unwired would be a false red.
 */
export function runsScriptWithFlag(lines, name, flag, value) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedValue = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    String.raw`\bnpm\b[^#]*\brun\b[^#]*(^|\s)${escapedName}(\s|$)[^#]*--${flag}=["']?${escapedValue}["']?(\s|$)`,
  )
  return lines.some((line) => pattern.test(line) && !isGreenWashed(line))
}

/**
 * The job blocks of a workflow, as raw text, keyed by job id.
 *
 * SCOPING IS THE WHOLE POINT. Reading every `matrix:` block in the FILE into
 * one map would union two jobs' `leg:` values: with job A's matrix
 * `[active-active]` and job B's `[failover, …]`, `failover` would be reported
 * WIRED through job A's bench line — a gate reported running when it is not.
 *
 * A job is a two-space key under `jobs:`; its block runs to the next such key or
 * to the next top-level key. A `run:` line outside every job block is not
 * returned by `expandedRunLines`, because GitHub would not execute one.
 */
export function jobBlocks(source) {
  const blocks = new Map()
  let inJobs = false
  let current = null
  for (const line of source.split(/\r?\n/)) {
    if (/^jobs:[ \t]*$/.test(line)) { inJobs = true; current = null; continue }
    if (!inJobs) continue
    if (/^[A-Za-z_]/.test(line)) { inJobs = false; current = null; continue }
    const header = /^ {2}([A-Za-z0-9_-]+):[ \t]*$/.exec(line)
    if (header) { current = header[1]; blocks.set(current, []); continue }
    if (current) blocks.get(current).push(line)
  }
  return new Map([...blocks].map(([id, body]) => [id, body.join('\n')]))
}

/**
 * The values ONE job's `strategy.matrix` declares, keyed by matrix variable.
 *
 * WITHOUT THIS, A MATRIX IS A BLIND SPOT: the run line says
 * `--leg=${{ matrix.leg }}` and the literal `--leg=failover` appears nowhere in
 * the file. The substitution is resolved rather than the assertion loosened.
 *
 * EVERYTHING IT CANNOT RESOLVE EXACTLY, IT DROPS. Dropping is what leaves an
 * unresolvable reference holding its `${{ … }}`, matching nothing, and reporting
 * the leg UNWIRED. Dropped on purpose:
 *
 *   - a matrix carrying `exclude:` or `include:`, because which combination
 *     those remove is not computed here (an excluded leg would read as wired).
 *   - any value that is not a bare token: `'load,soak'` would split into `load`
 *     and `soak`, inventing two legs and losing the real one.
 *   - `fromJSON()` and block-sequence matrices, which this does not parse.
 */
export function matrixValues(jobBody) {
  const values = new Map()
  for (const block of jobBody.matchAll(/^([ \t]*)matrix:[ \t]*$/gm)) {
    const indent = block[1].length
    const rest = jobBody.slice(block.index + block[0].length)
    const body = []
    for (const line of rest.split(/\r?\n/)) {
      if (line.trim() === '') continue
      if (line.length - line.trimStart().length <= indent) break
      body.push(line)
    }
    // One `exclude:`/`include:` anywhere in the block disqualifies the whole
    // matrix: which key it filters is exactly the thing not computed here.
    if (body.some((line) => /^[ \t]*(exclude|include):/.test(line))) continue
    for (const line of body) {
      const entry = /^[ \t]*([A-Za-z_][\w-]*):[ \t]*\[([^\]]*)\][ \t]*$/.exec(line)
      if (!entry) continue
      const raw = entry[2].split(',').map((value) => value.trim()).filter(Boolean)
      if (raw.length === 0 || !raw.every((value) => /^[A-Za-z0-9._-]+$/.test(value))) continue
      values.set(entry[1], [...(values.get(entry[1]) ?? []), ...raw])
    }
  }
  return values
}

/** Every concrete line a set of run lines stands for, once the matrix is applied. */
export function expandMatrix(lines, values) {
  return lines.flatMap((line) => {
    let expanded = [line]
    for (const reference of line.matchAll(/\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/g)) {
      const options = values.get(reference[1])
      if (!options?.length) continue
      expanded = expanded.flatMap((one) => options.map((value) => one.split(reference[0]).join(value)))
    }
    return expanded
  })
}

/**
 * Every run line a workflow really executes, with each job's OWN matrix applied.
 *
 * This is what callers should use. `matrixValues` and `expandMatrix` stay
 * exported for the tests that attack them directly.
 */
export function expandedRunLines(source) {
  return [...jobBlocks(source)].flatMap(([, body]) => expandMatrix(runLines(body), matrixValues(body)))
}
