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
 * Security exceptions that EXPIRE (V0-12).
 *
 * `security-exceptions.yml` is the only place a scanner finding may be waived.
 * Each entry names the tool, the finding id, why, who owns it and the last day
 * it is valid. This module:
 *
 *   1. parses the file (a deliberately tiny YAML subset: no dependency, and
 *      anything it does not understand is an ERROR, never silently ignored);
 *   2. validates every entry — a malformed entry fails, an EXPIRED entry fails;
 *   3. applies the VALID entries by filtering a tool's JSON report, and splits
 *      what is left into blocking (high / critical) and warning (the rest).
 *
 * Filtering the JSON report, rather than writing each tool's own ignore file,
 * is one mechanism for five tools, and it can be tested without any of them
 * installed. The trade-off is that the tool itself still sees the finding; what
 * is suppressed is the verdict, and the suppression is printed by id.
 *
 * Usage:
 *   node scripts/security-exceptions.mjs                  # validate the file
 *   node scripts/security-exceptions.mjs --now 2027-01-01 # validate as of a date
 *   node scripts/security-exceptions.mjs --file other.yml
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const ROOT = path.resolve(import.meta.dirname, '..')
export const EXCEPTIONS_FILE = path.join(ROOT, 'security-exceptions.yml')

/** Tools an exception may name. `trivy` covers both config and fs/image runs. */
export const TOOLS = ['npm-audit', 'osv', 'semgrep', 'gitleaks', 'trivy']
const REQUIRED = ['id', 'tool', 'justification', 'owner', 'expires']
const OPTIONAL = ['path']
/** An exception may not be dated further out than this: the point is that they expire. */
export const MAX_DAYS_AHEAD = 90
const DAY_MS = 86_400_000

/* ------------------------------------------------------------------ parsing */

function parseScalar(raw, lineNo) {
  const value = raw.trim()
  if (value === '') return ''
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) throw new Error(`line ${lineNo}: unterminated double-quoted string`)
    const inner = value.slice(1, -1)
    if (/(^|[^\\])"/.test(inner)) throw new Error(`line ${lineNo}: unescaped quote inside a double-quoted string`)
    return inner.replace(/\\(["\\])/g, '$1')
  }
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) throw new Error(`line ${lineNo}: unterminated single-quoted string`)
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (/^[[{|>&*!]/.test(value)) throw new Error(`line ${lineNo}: unsupported YAML construct "${value[0]}" (quote the value)`)
  // A plain scalar ends at " #" (a comment).
  return value.replace(/\s+#.*$/, '').trim()
}

/**
 * Parse `exceptions:` followed by a list of flat maps. Returns the entries as
 * plain objects, each carrying its 1-based `line`. Throws on anything else.
 */
export function parseExceptionsYaml(text) {
  const entries = []
  let sawRoot = false
  let current = null
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1
    const line = lines[i]
    if (/^\s*(#.*)?$/.test(line)) continue
    if (line.includes('\t')) throw new Error(`line ${lineNo}: tab character (use spaces)`)
    if (/^exceptions:\s*(\[\]\s*)?(#.*)?$/.test(line)) {
      if (sawRoot) throw new Error(`line ${lineNo}: "exceptions:" appears twice`)
      sawRoot = true
      continue
    }
    if (!sawRoot) throw new Error(`line ${lineNo}: expected the top-level "exceptions:" key first`)
    const item = /^ {2}- ([A-Za-z_][\w-]*):(?: (.*))?$/.exec(line)
    const field = /^ {4}([A-Za-z_][\w-]*):(?: (.*))?$/.exec(line)
    let key
    let raw
    if (item) {
      current = { line: lineNo }
      entries.push(current)
      ;[, key, raw] = item
    } else if (field) {
      if (!current) throw new Error(`line ${lineNo}: field before any "- " list item`)
      ;[, key, raw] = field
    } else {
      throw new Error(`line ${lineNo}: not a recognised shape (expected "  - key: value" or "    key: value")`)
    }
    if (key === 'line') throw new Error(`line ${lineNo}: "line" is reserved`)
    if (Object.hasOwn(current, key)) throw new Error(`line ${lineNo}: duplicate key "${key}" in one entry`)
    current[key] = parseScalar(raw ?? '', lineNo)
  }
  if (!sawRoot) throw new Error('missing the top-level "exceptions:" key')
  return entries
}

/* --------------------------------------------------------------- validation */

/** `YYYY-MM-DD` that is a real calendar day, as UTC midnight ms; else null. */
export function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const ms = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : null
}

const todayMs = (now) => {
  const d = now instanceof Date ? now : new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/**
 * Classify entries. `expires` is the LAST valid day (inclusive): an entry that
 * expires 2026-12-01 still applies on 2026-12-01 and fails from 2026-12-02.
 *
 * @returns {{ valid: object[], errors: string[] }} `errors` is non-empty for a
 *   malformed OR expired entry — both fail the gate.
 */
export function validateExceptions(entries, now = new Date()) {
  const errors = []
  const valid = []
  const seen = new Set()
  const today = todayMs(now)
  for (const entry of entries) {
    const label = `entry at line ${entry.line}${typeof entry.id === 'string' && entry.id ? ` (${entry.id})` : ''}`
    const problems = []
    for (const key of REQUIRED) {
      if (typeof entry[key] !== 'string' || entry[key].trim() === '') problems.push(`missing or empty "${key}"`)
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'line' && !REQUIRED.includes(key) && !OPTIONAL.includes(key)) problems.push(`unknown key "${key}"`)
    }
    if (typeof entry.tool === 'string' && entry.tool && !TOOLS.includes(entry.tool)) {
      problems.push(`tool "${entry.tool}" is not one of ${TOOLS.join(', ')}`)
    }
    if (typeof entry.justification === 'string' && entry.justification.trim().length > 0 && entry.justification.trim().length < 20) {
      problems.push('justification is too short to be a justification (min 20 characters)')
    }
    let expiryProblem = null
    if (typeof entry.expires === 'string' && entry.expires) {
      const expires = parseIsoDate(entry.expires)
      if (expires === null) problems.push(`"expires" must be a real ISO date YYYY-MM-DD, got "${entry.expires}"`)
      else if (expires < today) expiryProblem = `EXPIRED on ${entry.expires}`
      else if (expires - today > MAX_DAYS_AHEAD * DAY_MS) {
        problems.push(`"expires" ${entry.expires} is more than ${MAX_DAYS_AHEAD} days away`)
      }
    }
    const dup = `${entry.tool}\u0000${entry.id}\u0000${entry.path ?? ''}`
    if (typeof entry.id === 'string' && seen.has(dup)) problems.push('duplicate (tool, id, path)')
    seen.add(dup)

    if (problems.length > 0) errors.push(`${label}: malformed — ${problems.join('; ')}`)
    else if (expiryProblem) errors.push(`${label}: ${expiryProblem} (owner ${entry.owner}) — renew it with a fresh review, or fix the finding`)
    else valid.push(entry)
  }
  return { valid, errors }
}

/** Read, parse and validate a file. A parse error is reported as an error, not thrown. */
export function loadExceptions(file = EXCEPTIONS_FILE, now = new Date()) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { valid: [], errors: [`cannot read ${file}: ${error.message}`] }
  }
  let entries
  try {
    entries = parseExceptionsYaml(text)
  } catch (error) {
    return { valid: [], errors: [`${path.basename(file)}: malformed — ${error.message}`] }
  }
  return validateExceptions(entries, now)
}

/* ----------------------------------------------------------------- findings */

const SEVERITY_RANK = { unknown: 0, low: 1, medium: 2, high: 3, critical: 4 }
const normSeverity = (value) => {
  const s = String(value ?? '').toLowerCase()
  if (s === 'moderate') return 'medium'
  if (s === 'error') return 'high'
  if (s === 'warning') return 'medium'
  if (s === 'info') return 'low'
  return s in SEVERITY_RANK ? s : 'unknown'
}
/** Unknown severity BLOCKS: a scanner that cannot say how bad it is has not said it is fine. */
export const blocks = (severity) => severity === 'high' || severity === 'critical' || severity === 'unknown'

const advisoryId = (url) => /GHSA-[\w-]+|CVE-\d+-\d+/i.exec(String(url ?? ''))?.[0]

/**
 * Turn one tool's JSON report into a flat list of
 * `{ tool, ids, severity, path, title }`. An exception matches when its `id`
 * equals any of `ids`. For npm-audit the package is also an id, as `pkg:<name>`,
 * so one entry can waive a package whose advisory list is long and moving.
 */
export function extractFindings(tool, report) {
  const out = []
  if (tool === 'npm-audit') {
    for (const [name, vuln] of Object.entries(report?.vulnerabilities ?? {})) {
      // A string in `via` only points at another package; the advisory lives
      // on that package's own entry, so counting it here would double-report.
      for (const via of vuln.via ?? []) {
        if (typeof via !== 'object' || via === null) continue
        const ids = [`pkg:${name}`, advisoryId(via.url), ...(via.cwe ?? [])].filter(Boolean).filter((id) => !id.startsWith('CWE'))
        out.push({ tool, ids, severity: normSeverity(via.severity), path: name, title: via.title ?? name })
      }
    }
  } else if (tool === 'osv') {
    for (const result of report?.results ?? []) {
      for (const pkg of result.packages ?? []) {
        for (const vuln of pkg.vulnerabilities ?? []) {
          const group = (pkg.groups ?? []).find((g) => (g.ids ?? []).includes(vuln.id))
          const score = Number.parseFloat(group?.max_severity)
          let severity = normSeverity(vuln.database_specific?.severity)
          if (severity === 'unknown' && Number.isFinite(score)) {
            severity = score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low'
          }
          out.push({
            tool,
            ids: [vuln.id, ...(vuln.aliases ?? []), `pkg:${pkg.package?.name}`],
            severity,
            path: result.source?.path ?? '',
            title: vuln.summary ?? vuln.id,
          })
        }
      }
    }
  } else if (tool === 'semgrep') {
    for (const r of report?.results ?? []) {
      // `check_id` is dotted by directory for registry rules; the last segment
      // is also accepted so `sr-ssrf-fetch` works for a rule in `.semgrep.yml`.
      const id = String(r.check_id ?? '')
      out.push({
        tool,
        ids: [id, id.split('.').pop()],
        severity: normSeverity(r.extra?.severity),
        path: r.path ?? '',
        title: r.extra?.message ?? id,
      })
    }
  } else if (tool === 'gitleaks') {
    for (const r of Array.isArray(report) ? report : []) {
      // Every committed secret is high: there is no "low" leaked credential.
      out.push({ tool, ids: [r.Fingerprint, r.RuleID].filter(Boolean), severity: 'high', path: r.File ?? '', title: r.Description ?? r.RuleID })
    }
  } else if (tool === 'trivy') {
    for (const res of report?.Results ?? []) {
      const target = res.Target ?? ''
      for (const v of res.Vulnerabilities ?? []) {
        out.push({ tool, ids: [v.VulnerabilityID, `pkg:${v.PkgName}`], severity: normSeverity(v.Severity), path: target, title: v.Title ?? v.VulnerabilityID })
      }
      for (const m of res.Misconfigurations ?? []) {
        out.push({ tool, ids: [m.ID, m.AVDID].filter(Boolean), severity: normSeverity(m.Severity), path: target, title: m.Title ?? m.ID })
      }
      for (const s of res.Secrets ?? []) {
        out.push({ tool, ids: [s.RuleID], severity: normSeverity(s.Severity === 'UNKNOWN' ? 'high' : s.Severity), path: target, title: s.Title ?? s.RuleID })
      }
    }
  } else {
    throw new Error(`unknown tool "${tool}"`)
  }
  return out
}

const pathMatches = (exceptionPath, findingPath) =>
  !exceptionPath || String(findingPath).replaceAll('\\', '/').startsWith(exceptionPath.replaceAll('\\', '/'))

/**
 * Apply VALID exceptions to a tool's report.
 *
 * @returns {{ blocking: object[], warnings: object[], suppressed: object[], unused: object[] }}
 *   `unused` are valid exceptions of this tool that matched nothing: stale,
 *   reported as a warning so they get deleted rather than accumulate.
 */
export function applyExceptions(tool, report, validExceptions) {
  const mine = validExceptions.filter((e) => e.tool === tool)
  const used = new Set()
  const blocking = []
  const warnings = []
  const suppressed = []
  for (const finding of extractFindings(tool, report)) {
    const hit = mine.find((e) => finding.ids.includes(e.id) && pathMatches(e.path, finding.path))
    if (hit) {
      used.add(hit)
      suppressed.push({ ...finding, exception: hit })
    } else if (blocks(finding.severity)) blocking.push(finding)
    else warnings.push(finding)
  }
  return { blocking, warnings, suppressed, unused: mine.filter((e) => !used.has(e)) }
}

/* ---------------------------------------------------------------------- CLI */

function main(argv) {
  let file = EXCEPTIONS_FILE
  let now = new Date()
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') file = path.resolve(argv[++i] ?? '')
    else if (argv[i] === '--now') now = new Date(`${argv[++i]}T00:00:00Z`)
    else {
      console.error(`unknown argument ${argv[i]}\nusage: security-exceptions.mjs [--file f.yml] [--now YYYY-MM-DD]`)
      return 2
    }
  }
  if (Number.isNaN(now.getTime())) {
    console.error('--now needs YYYY-MM-DD')
    return 2
  }
  const { valid, errors } = loadExceptions(file, now)
  for (const e of errors) console.error(`FAIL ${e}`)
  console.log(`security-exceptions: ${valid.length} valid, ${errors.length} failing (${path.relative(ROOT, file)})`)
  return errors.length === 0 ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2))
