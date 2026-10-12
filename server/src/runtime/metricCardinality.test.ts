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
 * BOUNDED METRIC LABELS ONLY, enforced instead of asserted.
 *
 * A label per workspace would put the fleet's whole key space into the time
 * series exactly when an incident is widespread. The single exception is the
 * sync cell identity, whose cardinality is bounded by the number of cells.
 *
 * ## Why a static scan rather than calling the builders
 *
 * Calling `docScopeMetricSamples()` and friends only sees the labels the stub's
 * state happens to produce. A scan sees EVERY branch, including the one a stub
 * would not reach — and an unbounded label added on a rare error path is exactly
 * the one that fires during a widespread incident, which is when the time series
 * can least afford it.
 *
 * ## The rule that does the work
 *
 * A label VALUE that is not a string literal is unbounded until proven
 * otherwise. `{ cause: 'belowLive' }` is bounded by construction;
 * `{ workspace: key }` is the fleet's key space. Keys are checked too, but the
 * value rule is the one that catches the dangerous edit, because a reviewer
 * adding `{ landscape_id: id }` would probably not think to add the key to an
 * allowlist either.
 *
 * ## SHORTHAND properties
 *
 * A pair parser that requires a colon silently skips an ES2015 shorthand
 * property — `labels: { workspaceId }` — the single most dangerous label in the
 * fleet. So shorthand is parsed explicitly.
 *
 * A shorthand property's VALUE *is* its key, which is why the key rules carry
 * real weight there and the string-literal rule cannot apply: the label name is
 * the variable name, so `{ workspaceId }` cannot hide behind a friendly key the
 * way `{ kind: workspaceId }` could. Shorthand is therefore exempt from the
 * literal rule and subject to `BOUNDED_SHORTHAND_LABELS` instead, which forces
 * the same deliberate act — name the bound — for each one.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(import.meta.dirname, '..')

/**
 * Every label key the fleet is allowed to emit, and what bounds its cardinality.
 *
 * Adding a key here is a deliberate act that must name its bound — which is the
 * point, because "how many values can this take" is the only question that
 * matters for a time series.
 */
const BOUNDED_LABEL_KEYS: ReadonlyMap<string, string> = new Map([
  ['cell_id', 'the configured cell identity, one value per process and shared by its workspaces; '
    + 'only ownership.ts snapshot.cellId is admitted as a computed value'],
  ['cause', 'five fixed fence-divergence causes'],
  ['quantile', 'a fixed set of quantile names'],
  ['state', 'a fixed lifecycle enumeration'],
  ['kind', 'a fixed kind enumeration'],
  ['scope', 'a fixed scope enumeration'],
  ['status', 'a fixed status enumeration'],
  ['outcome', 'a fixed outcome enumeration'],
  ['phase', 'a fixed phase enumeration'],
  ['result', 'a fixed result enumeration'],
  ['reason', 'a fixed reason enumeration'],
  ['tool', 'the AI tool REGISTRY — a build-time set of names (34 today) each matching '
    + 'toolRegistry.ts NAME_RE; the only emitter (aiToolCallRelay.ts) labels a name after '
    + 'aiToolRegistry().get() resolved it, and today only the three AI_TOOL_DOORS reach it'],
])

/**
 * Every SHORTHAND label the fleet is allowed to emit, and what bounds it.
 *
 * Separate from `BOUNDED_LABEL_KEYS` on purpose: a shorthand site escapes the
 * string-literal rule, so it must pay for that with an argument about the
 * IDENTIFIER's domain rather than about the key's name. Each entry below was
 * read at its call site, not inferred from the key.
 */
const BOUNDED_SHORTHAND_LABELS: ReadonlyMap<string, string> = new Map([
  ['state', 'index.ts maps over a literal 5-tuple of divergence outcomes; placementProposerHealth '
    + 'maps over the closed PROPOSER_HEALTH_STATES tuple (13 states), never an observed identity'],
  ['outcome', 'placementProposerHealth iterates its fixed results record: admitted, already-admitted, '
    + 'refused and unknown. Updates only increment one of those four ProposalWriteResult discriminants'],
  ['status', 'health.ts emptyCounts() zero-fills all 7 ReadModelWorkspaceStatus values and '
    + 'getFleetReadModelStatusCounts only overwrites keys already present, so the entry count '
    + 'is fixed at 7 whatever the fleet contains'],
  ['phase', 'schedulerHeartbeat emits only the CURRENT phase, drawn from a fixed 5-phase enumeration'],
  ['reason', 'ownershipMetrics iterates SYNC_CELL_OWNERSHIP_LOSS_REASONS, a closed six-member tuple; '
    + 'no workspace key or arbitrary error message enters this label'],
  ['tool', 'aiToolCallRelay.ts maps over relayedByTool, a Map whose keys are bumped only with '
    + '`def.name` from executeAiTool — a name the registry resolved — and only when the '
    + 'extractor placed it (AI_TOOL_DOORS): bounded by the registry, three names today'],
])

/**
 * Dimensions that are unbounded by nature. Listed separately from "not in the
 * allowlist" so the failure MESSAGE can say why this one is fatal rather than
 * merely undeclared — these are the ones that put a tenant's key space into
 * Prometheus.
 */
const UNBOUNDED_DIMENSIONS = [
  'landscape', 'landscape_id', 'landscapeId',
  'version', 'version_id', 'versionId',
  'workspace', 'workspace_id', 'workspaceId',
  'document', 'document_id', 'documentId', 'doc_id', 'docId',
  'user', 'user_id', 'userId', 'org', 'org_id', 'orgId',
  'peer', 'peer_id', 'peerId', 'session', 'token', 'path', 'url', 'id',
]

interface LabelPair {
  key: string
  value: string
  /** True for `{ status }`, false for `{ status: 'healthy' }`. */
  shorthand: boolean
}

interface LabelSite extends LabelPair {
  file: string
  line: number
}

/**
 * The label pairs in one line of source, or `[]` if it carries no `labels: {…}`.
 *
 * Pulled out of the scan so the shorthand branch can be tested on a string
 * literal rather than on whatever the tree happens to contain today — a
 * filesystem-driven assertion cannot tell "the parser handles shorthand" from
 * "the tree has no shorthand this week".
 */
function labelPairsInLine(line: string): LabelPair[] {
  const block = /labels:\s*\{([^}]*)\}/.exec(line)
  if (!block) return []
  const pairs: LabelPair[] = []
  for (const pair of block[1]!.split(',')) {
    const explicit = /^\s*([A-Za-z_][\w]*)\s*:\s*(.+?)\s*$/.exec(pair)
    const shorthand = explicit ? null : /^\s*([A-Za-z_][\w]*)\s*$/.exec(pair)
    if (explicit) pairs.push({ key: explicit[1]!, value: explicit[2]!, shorthand: false })
    // The shorthand VALUE is the identifier itself. Recording it that way keeps
    // the unbounded-dimension rule honest: `{ workspaceId }` reports the label
    // name AND the expression, because here they are the same token.
    else if (shorthand) pairs.push({ key: shorthand[1]!, value: shorthand[1]!, shorthand: true })
  }
  return pairs
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) yield full
  }
}

/** Every `labels: { key: value, … }` literal in the server source. */
async function scanLabelSites(): Promise<LabelSite[]> {
  const sites: LabelSite[] = []
  for await (const file of walk(SRC)) {
    const source = await readFile(file, 'utf8')
    const lines = source.split('\n')
    lines.forEach((line, index) => {
      for (const pair of labelPairsInLine(line)) {
        sites.push({
          ...pair,
          file: path.relative(SRC, file).replace(/\\/g, '/'),
          line: index + 1,
        })
      }
    })
  }
  return sites
}

/** A value bounded by construction: a single- or double-quoted literal. */
const isStringLiteral = (value: string): boolean => /^'[^']*'$/.test(value) || /^"[^"]*"$/.test(value)

// The cell identity exception admits exactly one computed value, not arbitrary
// data disguised with its name.
const isBoundedCellIdentity = (site: LabelSite): boolean => !site.shorthand
  && site.file === 'syncCells/ownership.ts'
  && site.key === 'cell_id' && site.value === 'snapshot.cellId'

describe('D13 — every metric label is bounded', () => {
  it('admits only the ownership snapshot cell identity, not a renamed workspace label', () => {
    const site: LabelSite = { file: 'syncCells/ownership.ts', line: 1,
      key: 'cell_id', value: 'snapshot.cellId', shorthand: false }
    expect(isBoundedCellIdentity(site)).toBe(true)
    expect(isBoundedCellIdentity({ ...site, value: 'snapshot.workspaceId' })).toBe(false)
    expect(isBoundedCellIdentity({ ...site, value: 'workspaceId' })).toBe(false)
    expect(isBoundedCellIdentity({ ...site, file: 'index.ts' })).toBe(false)
    expect(isBoundedCellIdentity({ ...site, shorthand: true })).toBe(false)
  })
  it('the scan finds the label sites at all', async () => {
    // The vacuity control. A scan that matched nothing would make both
    // assertions below pass over an empty set.
    const sites = await scanLabelSites()
    expect(sites.length, 'the label scan found nothing — it is broken, not the tree')
      .toBeGreaterThan(30)
  })

  it('the pair parser recognises SHORTHAND, which it once did not', () => {
    // THE REGRESSION PIN, and the vacuity control for the rule below. Asserted
    // on string literals rather than on the tree, because a tree-counting
    // assertion cannot distinguish "the parser handles shorthand" from "there
    // happens to be shorthand in the tree this week".
    expect(labelPairsInLine('values: [{ labels: { workspaceId }, value: 1 }]'))
      .toEqual([{ key: 'workspaceId', value: 'workspaceId', shorthand: true }])
    expect(labelPairsInLine("      { labels: { quantile: 'p50' }, value: service.p50Ms },"))
      .toEqual([{ key: 'quantile', value: "'p50'", shorthand: false }])
    expect(labelPairsInLine('const x = 1')).toEqual([])
  })

  it('every SHORTHAND label declares the bound its identifier is drawn from', async () => {
    const sites = await scanLabelSites()
    const undeclared = sites
      .filter((site) => site.shorthand && !BOUNDED_SHORTHAND_LABELS.has(site.key))
      .map((site) => `${site.file}:${site.line}  labels: { ${site.key} }`)
    expect(
      undeclared,
      'these shorthand labels are not in BOUNDED_SHORTHAND_LABELS. A shorthand property is '
      + 'exempt from the string-literal rule because its value IS its key, so it must instead '
      + 'carry a written argument about the IDENTIFIER’s domain — read at the call site, not '
      + 'inferred from the key’s name',
    ).toEqual([])
  })

  it('no metric carries an UNBOUNDED dimension as a label', async () => {
    const sites = await scanLabelSites()
    const fatal = sites
      .filter((site) => UNBOUNDED_DIMENSIONS.includes(site.key))
      .map((site) => `${site.file}:${site.line}  labels.${site.key}`)
    expect(
      fatal,
      'D13 is `établie`: bounded labels only. These put an unbounded dimension into '
      + 'the time series — a label per workspace writes the fleet’s whole key space '
      + 'into Prometheus exactly when an incident is widespread, which is when it can '
      + 'least be afforded. Put the identity in the LOG LINE, which is what '
      + '`ownership.ts` already does',
    ).toEqual([])
  })

  it('every label KEY is declared with the bound that makes it safe', async () => {
    const sites = await scanLabelSites()
    const undeclared = sites
      .filter((site) => !BOUNDED_LABEL_KEYS.has(site.key))
      .map((site) => `${site.file}:${site.line}  labels.${site.key}`)
    expect(
      undeclared,
      'these label keys are not in BOUNDED_LABEL_KEYS. Add each with the bound on its '
      + 'value domain — "how many values can this take" is the only question a time '
      + 'series cares about',
    ).toEqual([])
  })

  it('every label VALUE is a string LITERAL, because anything else is unbounded until proven', async () => {
    // The rule that catches the dangerous edit. A reviewer adding
    // `{ landscape_id: id }` would probably not add the key to an allowlist
    // either — but they cannot avoid this one, because the VALUE is the thing
    // that carries the cardinality.
    const sites = await scanLabelSites()
    const computed = sites
      // Shorthand cannot satisfy a literal rule — its value is an identifier by
      // definition. It pays instead under BOUNDED_SHORTHAND_LABELS below.
      .filter((site) => !site.shorthand && !isStringLiteral(site.value) && !isBoundedCellIdentity(site))
      .map((site) => `${site.file}:${site.line}  labels.${site.key} = ${site.value}`)
    expect(
      computed,
      'these label values are computed rather than literal, so their cardinality is '
      + 'whatever the expression yields. If the value really is drawn from a bounded '
      + 'enumeration, say so by mapping it through a literal',
    ).toEqual([])
  })
})
