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
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  EXCEPTIONS_FILE,
  applyExceptions,
  extractFindings,
  loadExceptions,
  parseExceptionsYaml,
  validateExceptions,
} from './security-exceptions.mjs'

/**
 * The exception gate, attacked directly. Everything here runs without any of
 * the scanners installed: the reports are synthetic JSON in each tool's shape.
 */

const NOW = new Date('2026-11-08T12:00:00Z')

const entryYaml = (over = {}) => {
  const e = {
    id: 'pkg:left-pad',
    tool: 'npm-audit',
    justification: '"Dev-only helper; no production exposure; upgrade scheduled."',
    owner: 'someone',
    expires: '2026-12-01',
    ...over,
  }
  return ['exceptions:', ...Object.entries(e).filter(([, v]) => v !== undefined).map(([k, v], i) => `${i === 0 ? '  - ' : '    '}${k}: ${v}`)].join('\n')
}

const check = (yaml, now = NOW) => validateExceptions(parseExceptionsYaml(yaml), now)

describe('exception validation', () => {
  it('a valid entry passes', () => {
    const { valid, errors } = check(entryYaml())
    assert.deepEqual(errors, [])
    assert.equal(valid.length, 1)
    assert.equal(valid[0].id, 'pkg:left-pad')
  })

  it('an EXPIRED entry fails, and says when', () => {
    const { valid, errors } = check(entryYaml({ expires: '2026-11-07' }))
    assert.equal(valid.length, 0)
    assert.equal(errors.length, 1)
    assert.match(errors[0], /EXPIRED on 2026-11-07/)
  })

  it('the expiry day itself is still valid, the next day is not', () => {
    assert.deepEqual(check(entryYaml({ expires: '2026-11-08' })).errors, [])
    assert.equal(check(entryYaml({ expires: '2026-11-08' }), new Date('2026-11-09T00:00:00Z')).errors.length, 1)
  })

  const malformed = {
    'a missing owner': entryYaml({ owner: undefined }),
    'an empty justification': entryYaml({ justification: '""' }),
    'a one-word justification': entryYaml({ justification: 'ok' }),
    'an unknown tool': entryYaml({ tool: 'sonarqube' }),
    'an impossible date': entryYaml({ expires: '2026-02-30' }),
    'a non-ISO date': entryYaml({ expires: '12/01/2026' }),
    'a date more than 90 days out': entryYaml({ expires: '2027-06-01' }),
    'an unknown key': `${entryYaml()}\n    severity: low`,
  }
  for (const [name, yaml] of Object.entries(malformed)) {
    it(`a malformed entry fails: ${name}`, () => {
      const { valid, errors } = check(yaml)
      assert.equal(valid.length, 0, 'a malformed entry must never be treated as valid')
      assert.equal(errors.length, 1)
      assert.match(errors[0], /malformed/)
    })
  }

  it('a duplicate (tool, id, path) fails', () => {
    const one = entryYaml()
    const { errors } = check(`${one}\n${one.split('\n').slice(1).join('\n').replace(/^ {2}- /, '  - ')}`)
    assert.ok(errors.some((e) => /duplicate/.test(e)), errors.join('|'))
  })

  it('a file the parser cannot read fails instead of being treated as empty', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'secex-'))
    try {
      const file = path.join(dir, 'bad.yml')
      writeFileSync(file, 'exceptions:\n  - id: x\n  \tbroken\n')
      const { valid, errors } = loadExceptions(file, NOW)
      assert.equal(valid.length, 0)
      assert.equal(errors.length, 1)
      assert.match(errors[0], /malformed/)
      assert.equal(loadExceptions(path.join(dir, 'missing.yml'), NOW).errors.length, 1, 'a missing file is an error')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the committed security-exceptions.yml is valid today', () => {
    const { errors, valid } = loadExceptions(EXCEPTIONS_FILE)
    assert.deepEqual(errors, [])
    // An empty list (`exceptions: []`) is the goal state; the parser's handling of real
    // entries is covered by the tests above, so only require a well-formed result here.
    assert.ok(Array.isArray(valid))
  })
})

describe('applying exceptions to a tool report', () => {
  const audit = {
    vulnerabilities: {
      foo: { via: [{ source: 1, severity: 'critical', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', title: 'foo RCE' }] },
      bar: { via: [{ source: 2, severity: 'moderate', url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', title: 'bar meh' }] },
      baz: { via: ['foo'] },
    },
  }
  const exception = (over) => ({ id: 'pkg:foo', tool: 'npm-audit', ...over })

  it('blocks high and critical, warns on the rest, ignores transitive pointers', () => {
    const r = applyExceptions('npm-audit', audit, [])
    assert.deepEqual(r.blocking.map((f) => f.path), ['foo'])
    assert.deepEqual(r.warnings.map((f) => f.path), ['bar'])
  })

  it('a valid exception removes the finding from the verdict, by package or advisory id', () => {
    for (const id of ['pkg:foo', 'GHSA-aaaa-bbbb-cccc']) {
      const r = applyExceptions('npm-audit', audit, [exception({ id })])
      assert.deepEqual(r.blocking, [], id)
      assert.equal(r.suppressed.length, 1)
    }
  })

  it('an exception for another tool, or another id, does not hide it', () => {
    assert.equal(applyExceptions('npm-audit', audit, [exception({ tool: 'osv' })]).blocking.length, 1)
    assert.equal(applyExceptions('npm-audit', audit, [exception({ id: 'pkg:bar' })]).blocking.length, 1)
  })

  it('reports an exception that matched nothing', () => {
    const stale = exception({ id: 'pkg:gone' })
    assert.deepEqual(applyExceptions('npm-audit', audit, [stale]).unused, [stale])
  })

  it('semgrep: ERROR blocks, WARNING warns, rule id matches by suffix, path narrows', () => {
    const report = { results: [
      { check_id: 'server.src.sr-crypto-weak-hash', path: 'server/src/auth/a.ts', extra: { severity: 'ERROR', message: 'md5' } },
      { check_id: 'x.sr-authz-route-without-middleware', path: 'server/src/ai/b.ts', extra: { severity: 'WARNING' } },
    ] }
    const r = applyExceptions('semgrep', report, [])
    assert.equal(r.blocking.length, 1)
    assert.equal(r.warnings.length, 1)
    const waived = applyExceptions('semgrep', report, [{ id: 'sr-crypto-weak-hash', tool: 'semgrep', path: 'server/src/auth/' }])
    assert.equal(waived.blocking.length, 0)
    const wrongPath = applyExceptions('semgrep', report, [{ id: 'sr-crypto-weak-hash', tool: 'semgrep', path: 'server/src/ai/' }])
    assert.equal(wrongPath.blocking.length, 1, 'a path-scoped exception must not waive another directory')
  })

  it('gitleaks findings always block; trivy and osv severities are read', () => {
    assert.equal(applyExceptions('gitleaks', [{ RuleID: 'github-pat', File: 'a', Fingerprint: 'a:github-pat:1' }], []).blocking.length, 1)
    const trivy = { Results: [{ Target: 'docker/nginx/Dockerfile', Misconfigurations: [
      { ID: 'DS002', Severity: 'HIGH', Title: 'root user' }, { ID: 'DS026', Severity: 'LOW', Title: 'no healthcheck' },
    ] }] }
    const t = applyExceptions('trivy', trivy, [])
    assert.deepEqual([t.blocking.length, t.warnings.length], [1, 1])
    const osv = { results: [{ source: { path: 'package-lock.json' }, packages: [{ package: { name: 'p' }, vulnerabilities: [
      { id: 'GHSA-1', database_specific: { severity: 'HIGH' } }, { id: 'GHSA-2', database_specific: { severity: 'LOW' } },
    ] }] }] }
    assert.deepEqual(extractFindings('osv', osv).map((f) => f.severity), ['high', 'low'])
  })

  it('a finding whose severity is unknown BLOCKS', () => {
    assert.equal(applyExceptions('trivy', { Results: [{ Target: 't', Misconfigurations: [{ ID: 'X', Severity: 'WEIRD' }] }] }, []).blocking.length, 1)
  })
})

describe('the scan runner does not treat a missing tool as a pass', () => {
  // PATH is a directory that does not exist, so semgrep/gitleaks/trivy cannot
  // be found whatever this machine has installed. `npm` is absent too, which
  // is why sca is not exercised here.
  const run = (...args) => spawnSync(process.execPath, [path.join(import.meta.dirname, 'security-scan.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '/nonexistent' },
  })

  it('exits non-zero and says SKIPPED', () => {
    const r = run('--only', 'gitleaks')
    assert.notEqual(r.status, 0)
    assert.match(r.stdout, /SKIPPED gitleaks/)
    assert.match(r.stdout, /security-scan: FAIL/)
  })

  it('--allow-missing is INCOMPLETE, never PASS', () => {
    const r = run('--only', 'gitleaks,semgrep,trivy', '--allow-missing')
    assert.equal(r.status, 0)
    assert.match(r.stdout, /security-scan: INCOMPLETE/)
    assert.doesNotMatch(r.stdout, /security-scan: PASS/)
    assert.match(r.stdout, /SKIPPED \(not installed\): gitleaks, semgrep, trivy/)
  })
})
