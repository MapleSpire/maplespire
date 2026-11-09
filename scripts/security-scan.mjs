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
 * Security scan runner (V0-12): SCA, SAST, secrets, IaC.
 *
 *   node scripts/security-scan.mjs                 # every scanner; a missing one FAILS
 *   node scripts/security-scan.mjs --allow-missing # laptop mode: missing = SKIPPED + INCOMPLETE
 *   node scripts/security-scan.mjs --only semgrep,gitleaks
 *   node scripts/security-scan.mjs --image name:tag  # also `trivy image`
 *   npm run security:scan
 *
 * Scanners:
 *   sca      osv-scanner on BOTH lockfiles when installed, else `npm audit`
 *            (root + server). Which one ran is printed.
 *   semgrep  .semgrep.yml + p/typescript + p/nodejs
 *   gitleaks .gitleaks.toml, git history
 *   trivy    `trivy config` on infra/, docker/, server/Dockerfile, compose files
 *
 * A scanner that is not installed is NOT a pass. By default it fails the run;
 * with --allow-missing it is listed as SKIPPED, the verdict is INCOMPLETE, and
 * the exit code is 0 only so a laptop without the binaries can still run the
 * rest. CI never passes --allow-missing.
 *
 * Verdict: findings of severity high / critical (or unknown) block; the rest
 * warn. Findings waived by a VALID entry in security-exceptions.yml are listed
 * by id. An invalid or expired exceptions file fails before anything runs.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { ROOT, applyExceptions, loadExceptions } from './security-exceptions.mjs'

/** Trivy config targets; findings elsewhere in the tree (e2e fixtures, ...) are ignored. */
export const TRIVY_TARGETS = ['infra/', 'docker/', 'server/Dockerfile', 'docker-compose.yml', 'compose.maplespire.yml']
export const SCANNERS = ['sca', 'semgrep', 'gitleaks', 'trivy']

export function parseScanArgs(argv) {
  const opts = { allowMissing: false, only: null, image: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--allow-missing') opts.allowMissing = true
    else if (arg === '--only') opts.only = (argv[++i] ?? '').split(',').filter(Boolean)
    else if (arg === '--image') opts.image = argv[++i] ?? null
    else return { error: `unknown argument ${arg}` }
  }
  if (opts.only?.some((name) => !SCANNERS.includes(name))) return { error: `--only takes ${SCANNERS.join(',')}` }
  if (opts.image === null && argv.includes('--image')) return { error: '--image needs a name' }
  return opts
}

const installed = (bin) => {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore' })
  return !r.error && r.status === 0
}

function exec(bin, args, extra = {}) {
  return spawnSync(bin, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...extra,
  })
}

function parseJson(text, label) {
  try {
    return { json: JSON.parse(text) }
  } catch (error) {
    return { error: `${label}: output is not JSON (${error.message})` }
  }
}

/** Each runner returns `{ runs: [{ tool, label, report }], errors: [] }` or `{ missing }`. */
const runners = {
  sca() {
    if (installed('osv-scanner')) {
      const r = exec('osv-scanner', ['scan', 'source', '--lockfile', 'package-lock.json', '--lockfile', 'server/package-lock.json', '--format', 'json'])
      // osv-scanner exits 1 when it FINDS vulnerabilities; 127+ / 128 mean it broke.
      if (r.status !== 0 && r.status !== 1) return { runs: [], errors: [`osv-scanner exited ${r.status}: ${(r.stderr ?? '').slice(0, 300)}`] }
      const parsed = parseJson(r.stdout, 'osv-scanner')
      if (parsed.error) return { runs: [], errors: [parsed.error] }
      return { runs: [{ tool: 'osv', label: 'osv-scanner (both lockfiles)', report: parsed.json }], errors: [] }
    }
    if (!installed('npm')) return { missing: 'osv-scanner (and npm for the npm-audit fallback)' }
    const runs = []
    const errors = []
    for (const dir of ['.', 'server']) {
      const r = exec('npm', ['audit', '--json'], { cwd: path.join(ROOT, dir) })
      const parsed = parseJson(r.stdout, `npm audit (${dir})`)
      if (parsed.error) errors.push(parsed.error)
      else if (parsed.json.error) errors.push(`npm audit (${dir}): ${parsed.json.error.summary ?? parsed.json.error.code}`)
      else runs.push({ tool: 'npm-audit', label: `npm audit (${dir === '.' ? 'root' : 'server'} lockfile)`, report: parsed.json })
    }
    return { runs, errors }
  },
  semgrep() {
    if (!installed('semgrep')) return { missing: 'semgrep' }
    const r = exec('semgrep', [
      'scan', '--config', '.semgrep.yml', '--config', 'p/typescript', '--config', 'p/nodejs',
      '--json', '--quiet', '--metrics=off', '--exclude', 'node_modules', 'server/src', 'src', 'scripts',
    ])
    if (r.status !== 0) return { runs: [], errors: [`semgrep exited ${r.status}: ${(r.stderr ?? '').slice(0, 300)}`] }
    const parsed = parseJson(r.stdout, 'semgrep')
    if (parsed.error) return { runs: [], errors: [parsed.error] }
    const errs = (parsed.json.errors ?? []).filter((e) => e.level === 'error').map((e) => `semgrep: ${e.message ?? e.type}`.slice(0, 300))
    return { runs: [{ tool: 'semgrep', label: 'semgrep', report: parsed.json }], errors: errs }
  },
  gitleaks() {
    if (!installed('gitleaks')) return { missing: 'gitleaks' }
    const dir = reportDir()
    const out = path.join(dir, 'gitleaks.json')
    const r = exec('gitleaks', ['git', '--config', '.gitleaks.toml', '--report-format', 'json', '--report-path', out, '--exit-code', '0', '--no-banner', '.'])
    if (r.status !== 0) return { runs: [], errors: [`gitleaks exited ${r.status}: ${(r.stderr ?? '').slice(0, 300)}`] }
    if (!existsSync(out)) return { runs: [], errors: ['gitleaks wrote no report'] }
    const parsed = parseJson(readFileSync(out, 'utf8') || '[]', 'gitleaks')
    if (parsed.error) return { runs: [], errors: [parsed.error] }
    return { runs: [{ tool: 'gitleaks', label: 'gitleaks (git history)', report: parsed.json }], errors: [] }
  },
  trivy(opts) {
    if (!installed('trivy')) return { missing: 'trivy' }
    const dir = reportDir()
    const out = path.join(dir, 'trivy-config.json')
    const r = exec('trivy', ['config', '--format', 'json', '--output', out, '--skip-dirs', '**/node_modules', '--quiet', '.'])
    if (r.status !== 0) return { runs: [], errors: [`trivy config exited ${r.status}: ${(r.stderr ?? '').slice(0, 300)}`] }
    const parsed = parseJson(readFileSync(out, 'utf8'), 'trivy config')
    if (parsed.error) return { runs: [], errors: [parsed.error] }
    parsed.json.Results = (parsed.json.Results ?? []).filter((res) => TRIVY_TARGETS.some((t) => (res.Target ?? '').replaceAll('\\', '/').startsWith(t)))
    const runs = [{ tool: 'trivy', label: 'trivy config (infra, docker, Dockerfiles, compose)', report: parsed.json }]
    const errors = []
    if (opts.image) {
      const img = path.join(dir, 'trivy-image.json')
      const ri = exec('trivy', ['image', '--format', 'json', '--output', img, '--severity', 'HIGH,CRITICAL', '--quiet', opts.image])
      if (ri.status !== 0) errors.push(`trivy image ${opts.image} exited ${ri.status}: ${(ri.stderr ?? '').slice(0, 300)}`)
      else runs.push({ tool: 'trivy', label: `trivy image ${opts.image}`, report: JSON.parse(readFileSync(img, 'utf8')) })
    }
    return { runs, errors }
  },
}

let cachedReportDir
function reportDir() {
  if (!cachedReportDir) {
    cachedReportDir = path.join(ROOT, 'reports', `security-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`)
    mkdirSync(cachedReportDir, { recursive: true })
  }
  return cachedReportDir
}

const fmt = (f) => `${f.severity.toUpperCase().padEnd(8)} ${f.ids[0]}  ${f.path}  ${String(f.title).split('\n')[0].slice(0, 100)}`

export function main(argv) {
  const opts = parseScanArgs(argv)
  if ('error' in opts) {
    console.error(`${opts.error}\nusage: security-scan.mjs [--allow-missing] [--only sca,semgrep,gitleaks,trivy] [--image name]`)
    return 2
  }
  const { valid, errors: exceptionErrors } = loadExceptions()
  if (exceptionErrors.length > 0) {
    for (const e of exceptionErrors) console.error(`FAIL security-exceptions.yml: ${e}`)
    console.error('security-scan: FAIL — the exceptions file is invalid or has an expired entry; nothing was scanned.')
    return 1
  }

  const wanted = opts.only ?? SCANNERS
  const missing = []
  const toolErrors = []
  const blocking = []
  const warnings = []
  const suppressed = []
  const unused = []
  const ran = []

  for (const name of wanted) {
    const result = runners[name](opts)
    if (result.missing) {
      missing.push(name)
      console.log(`SKIPPED ${name}: ${result.missing} is not installed. A missing tool is NOT a pass.`)
      continue
    }
    toolErrors.push(...result.errors.map((e) => `${name}: ${e}`))
    for (const run of result.runs) {
      const verdict = applyExceptions(run.tool, run.report, valid)
      ran.push(run.label)
      console.log(`RAN     ${run.label}: ${verdict.blocking.length} blocking, ${verdict.warnings.length} warning, ${verdict.suppressed.length} waived`)
      blocking.push(...verdict.blocking.map((f) => ({ ...f, run: run.label })))
      warnings.push(...verdict.warnings)
      suppressed.push(...verdict.suppressed)
      unused.push(...verdict.unused)
    }
  }

  for (const f of warnings) console.log(`warn    ${fmt(f)}`)
  for (const f of suppressed) console.log(`waived  ${fmt(f)}  [until ${f.exception.expires}, ${f.exception.owner}]`)
  // Unused = matched nothing in ANY run of its tool (root and server audits are separate runs).
  const used = new Set(suppressed.map((f) => f.exception))
  for (const e of new Set(unused)) if (!used.has(e)) console.log(`warn    unused exception ${e.tool}/${e.id} (matched nothing; delete it)`)
  for (const f of blocking) console.log(`BLOCK   ${fmt(f)}  (${f.run})`)
  for (const e of toolErrors) console.log(`ERROR   ${e}`)

  const failed = blocking.length > 0 || toolErrors.length > 0 || (missing.length > 0 && !opts.allowMissing)
  const incomplete = missing.length > 0
  console.log(
    `\nsecurity-scan: ${failed ? 'FAIL' : incomplete ? 'INCOMPLETE' : 'PASS'} — ran ${ran.length} scan(s), ` +
    `${blocking.length} blocking, ${warnings.length} warning, ${suppressed.length} waived` +
    (incomplete ? `, SKIPPED (not installed): ${missing.join(', ')}` : ''),
  )
  return failed ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2))
