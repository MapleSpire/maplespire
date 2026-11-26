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
 * The verdict logic of `scripts/e2e-summary-visibility.mjs` — the part of the
 * T-SUM-0 harness that decides GREEN without a browser. The harness exists
 * because its spec SKIPPED everywhere for three months; the one thing it must
 * never do is call a skipped, empty or retried run green.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { isProvisioningBootRefusal, judgeObjectFacts, judgeReport, judgeServerFacts, parseArgs } from './e2e-summary-visibility.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stats = (over) => ({ stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0, ...over } })

describe('judgeReport', () => {
  it('passes exactly the declared number of passed tests, nothing else', () => {
    assert.equal(judgeReport(stats({})).ok, true)
    assert.equal(judgeReport(stats({ expected: 4 }), 4).ok, true)
  })
  it('a SKIP is red — the defect this harness was written against', () => {
    const verdict = judgeReport(stats({ expected: 0, skipped: 1 }))
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /SKIPPED/)
  })
  it('a skip is red even beside a pass', () => {
    assert.equal(judgeReport(stats({ expected: 1, skipped: 1 })).ok, false)
  })
  it('a failure, a flaky retry, zero tests or too many tests are red', () => {
    assert.equal(judgeReport(stats({ expected: 0, unexpected: 1 })).ok, false)
    assert.equal(judgeReport(stats({ flaky: 1, expected: 0 })).ok, false)
    assert.equal(judgeReport(stats({ expected: 0 })).ok, false)
    assert.equal(judgeReport(stats({ expected: 2 })).ok, false)
    assert.equal(judgeReport(stats({ expected: 3 }), 4).ok, false)
  })
  it('no report, or a report without stats, is red (Playwright never reached its reporter)', () => {
    assert.equal(judgeReport(null).ok, false)
    assert.equal(judgeReport({}).ok, false)
    assert.equal(judgeReport({ stats: {} }).ok, false)
  })
  it('a report for ANOTHER spec is red (a stray E2E_SUMMARY_SPEC would run a different file)', () => {
    const spec = 'summary-workspace-diagram-visible.spec.ts'
    assert.equal(judgeReport({ ...stats({}), suites: [{ file: spec }] }, 1, spec).ok, true)
    assert.equal(judgeReport({ ...stats({}), suites: [{ file: 'smoke.spec.ts' }] }, 1, spec).ok, false)
    assert.equal(judgeReport({ ...stats({}), suites: [] }, 1, spec).ok, false)
    assert.equal(judgeReport({ ...stats({}), suites: [{ file: spec }, { file: 'other.spec.ts' }] }, 1, spec).ok, false)
  })
  it('reads the shape Playwright 1.x actually writes', () => {
    // The keys the JSON reporter emits (`stats.expected/skipped/unexpected/
    // flaky`), from a real report of this spec — not an invented shape.
    const real = {
      stats: { startTime: '2026-11-22T02:38:12.000Z', duration: 21000, expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
    }
    assert.equal(judgeReport(real).ok, true)
  })
})

describe('judgeServerFacts — the row CONTENT, against witnesses the projector does not write', () => {
  const created = { diagramId: 'd1', name: 'New Context diagram', type: 'context', creationStartedAt: '2026-11-21T10:00:00.000Z' }
  const good = () => ({
    rows: [{ org_id: 'org-paul', doc_url: 'automerge:docA', name: 'New Context diagram', type: 'context' }],
    carriers: [{ documentId: 'head1', kind: 'registry-shard', meta: { name: 'New Context diagram', type: 'context', docUrl: 'automerge:docA' } }],
    queue: { revision: 3, projected_revision: 3, projected_at: '2026-11-21T10:00:02.000Z' },
    diagramDoc: { stored: true, admittedAs: { kind: 'diagram', entityId: 'd1' } },
  })
  const judge = (mutate) => {
    const facts = good()
    mutate(facts)
    return judgeServerFacts(facts, created, 'org-paul')
  }
  it('the control is green', () => assert.equal(judge(() => {}).ok, true))
  it('N2 — an empty docUrl is red', () => assert.equal(judge((f) => { f.rows[0].doc_url = null }).ok, false))
  it('a docUrl other than the registry\'s is red', () => assert.equal(judge((f) => { f.rows[0].doc_url = 'automerge:other' }).ok, false))
  it('a docUrl that resolves to nothing stored is red', () => assert.equal(judge((f) => { f.diagramDoc.stored = false }).ok, false))
  it('a DiagramDoc admitted as something else is red', () => assert.equal(judge((f) => { f.diagramDoc.admittedAs = { kind: 'diagram', entityId: 'd2' } }).ok, false))
  it('N3 — a NULL org_id, or another org, is red', () => {
    assert.equal(judge((f) => { f.rows[0].org_id = null }).ok, false)
    assert.equal(judge((f) => { f.rows[0].org_id = 'org-x' }).ok, false)
    assert.equal(judgeServerFacts(good(), created, null).ok, false)
  })
  it('a wrong name or type is red', () => {
    assert.equal(judge((f) => { f.rows[0].name = 'x' }).ok, false)
    assert.equal(judge((f) => { f.carriers[0].meta.name = 'x' }).ok, false)
    assert.equal(judge((f) => { f.rows[0].type = 'container' }).ok, false)
  })
  it('no row, or two, is red', () => {
    assert.equal(judge((f) => { f.rows = [] }).ok, false)
    assert.equal(judge((f) => { f.rows.push(f.rows[0]) }).ok, false)
  })
  it('the queue row must be the CARRIER\'s: none, two or a frozen registry carrier is red', () => {
    assert.equal(judge((f) => { f.carriers = [] }).ok, false)
    assert.equal(judge((f) => { f.carriers.push({ ...f.carriers[0], documentId: 'head2' }) }).ok, false)
    assert.equal(judge((f) => { f.carriers[0].kind = 'registry' }).ok, false)
    assert.equal(judge((f) => { f.queue = null }).ok, false)
  })
  it('an unprojected or stale carrier queue row is red', () => {
    assert.equal(judge((f) => { f.queue.projected_revision = 2 }).ok, false)
    assert.equal(judge((f) => { f.queue.revision = 0; f.queue.projected_revision = 0 }).ok, false)
    assert.equal(judge((f) => { f.queue.projected_at = '2026-11-21T09:00:00.000Z' }).ok, false)
    assert.equal(judge((f) => { f.queue.projected_at = null }).ok, false)
  })
})

describe('judgeObjectFacts — T-SUM-0b: Paul\'s rename, judged on the row\'s CONTENT', () => {
  const renamed = { id: 'o1', previousName: 'Carrier API', name: 'T-SUM-0b renamed 1', renameStartedAt: '2026-11-22T10:00:00.000Z' }
  const good = () => ({
    rows: [{ org_id: 'org-paul', name: 'T-SUM-0b renamed 1', data_name: 'T-SUM-0b renamed 1' }],
    carriers: [{ documentId: 'old', name: 'Carrier API' }, { documentId: 'head', name: 'T-SUM-0b renamed 1' }],
    holders: [{ documentId: 'head', name: 'T-SUM-0b renamed 1' }],
    queue: { revision: 3, projected_revision: 3, projected_at: '2026-11-22T10:00:01.000Z' },
    rotations: [{ old_document_id: 'old', new_document_id: 'head', status: 'published', published_at: '2026-11-22T09:59:00.000Z' }],
  })
  const judge = (mutate) => {
    const facts = good()
    mutate(facts)
    return judgeObjectFacts(facts, renamed, 'org-paul')
  }
  it('the control is green', () => assert.equal(judge(() => {}).ok, true))
  it('THE DEFECT — the row still under the old name, the head holding the new one, is red', () => {
    const verdict = judge((f) => { f.rows[0].name = 'Carrier API'; f.rows[0].data_name = 'Carrier API' })
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /never projected/)
  })
  it('the JSON name and the column are both judged', () => {
    assert.equal(judge((f) => { f.rows[0].data_name = 'Carrier API' }).ok, false)
    assert.equal(judge((f) => { f.rows[0].name = 'Carrier API' }).ok, false)
  })
  it('a NULL org_id, another org, or no expected org is red', () => {
    assert.equal(judge((f) => { f.rows[0].org_id = null }).ok, false)
    assert.equal(judge((f) => { f.rows[0].org_id = 'org-x' }).ok, false)
    assert.equal(judgeObjectFacts(good(), renamed, null).ok, false)
  })
  it('no row, or two, is red', () => {
    assert.equal(judge((f) => { f.rows = [] }).ok, false)
    assert.equal(judge((f) => { f.rows.push(f.rows[0]) }).ok, false)
  })
  it('the new name must be durable in exactly ONE admitted head (else the write never reached the server)', () => {
    assert.equal(judge((f) => { f.holders = [] }).ok, false)
    assert.equal(judge((f) => { f.holders.push({ documentId: 'other', name: renamed.name }) }).ok, false)
  })
  it('the holder\'s queue row must exist, be projected, and after the rename', () => {
    assert.equal(judge((f) => { f.queue = null }).ok, false)
    assert.equal(judge((f) => { f.queue.projected_revision = 0 }).ok, false)
    assert.equal(judge((f) => { f.queue.revision = 0; f.queue.projected_revision = 0 }).ok, false)
    assert.equal(judge((f) => { f.queue.projected_at = '2026-11-22T09:00:00.000Z' }).ok, false)
    assert.equal(judge((f) => { f.queue.projected_at = null }).ok, false)
  })
  it('a run whose holder is not a head a rotation published BEFORE the rename exercises nothing: red', () => {
    assert.equal(judge((f) => { f.rotations = [] }).ok, false)
    assert.equal(judge((f) => { f.rotations[0].published_at = '2026-11-22T10:00:05.000Z' }).ok, false)
    assert.equal(judge((f) => { f.rotations[0].status = 'admitted' }).ok, false)
    assert.equal(judge((f) => { f.rotations[0].new_document_id = 'elsewhere' }).ok, false)
  })
  it('a spec that never wrote the rename is red', () => {
    assert.equal(judgeObjectFacts(good(), null, 'org-paul').ok, false)
    assert.equal(judgeObjectFacts(good(), { ...renamed, name: '' }, 'org-paul').ok, false)
  })
})

describe('isProvisioningBootRefusal — the ONE retried dev-login failure', () => {
  it('matches the boot refusal when it is the last dev-login error', () => {
    assert.equal(isProvisioningBootRefusal('POST /api/auth/dev-login error: Error: provisioning unavailable: Automerge repo not ready (booting)\n'), true)
  })
  it('does not match any other dev-login error, nor a boot refusal followed by another error', () => {
    assert.equal(isProvisioningBootRefusal('POST /api/auth/dev-login error: error: relation "users" does not exist\n'), false)
    assert.equal(isProvisioningBootRefusal(
      'POST /api/auth/dev-login error: Error: provisioning unavailable: Automerge repo not ready (booting)\n'
      + 'POST /api/auth/dev-login error: Error: boom\n'), false)
    assert.equal(isProvisioningBootRefusal(''), false)
  })
})

describe('parseArgs', () => {
  it('defaults to the visibility suite, both arms', () => {
    assert.deepEqual(parseArgs([]), { suite: 'visibility', arm: 'both', client: 'both', stackOnly: false, help: false, playwright: [] })
  })
  it('refuses an unknown argument or arm instead of running something else', () => {
    assert.ok('error' in parseArgs(['--arms=fixture']))
    assert.ok('error' in parseArgs(['--arm=all']))
    assert.ok('error' in parseArgs(['--suite=everything']))
  })
  it('passes what follows -- to Playwright', () => {
    assert.deepEqual(parseArgs(['--arm=fixture', '--', '--headed']).playwright, ['--headed'])
  })
})

describe('the harness is wired where it claims to be', () => {
  const ciLocal = readFileSync(path.join(ROOT, 'scripts', 'ci-local.mjs'), 'utf8')
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  it('`npm run e2e:summary-visibility` runs this script and nothing else', () => {
    assert.equal(pkg.scripts['e2e:summary-visibility'], 'node scripts/e2e-summary-visibility.mjs')
  })
  it('ci-local runs it by default (not behind a flag) and counts its status', () => {
    assert.match(ciLocal, /runStreamed\('npm', \['run', '--silent', 'e2e:summary-visibility'\]/)
    assert.doesNotMatch(ciLocal, /if \(args\.[a-z]+\) \{\n[^}]*e2e:summary-visibility/)
    assert.match(ciLocal, /summaryVisibility\.status !== 0/)
  })
  it('the harness pairs every visibility arm with its SQL post-check', () => {
    const harness = readFileSync(path.join(ROOT, 'scripts', 'e2e-summary-visibility.mjs'), 'utf8')
    assert.match(harness, /const serverOk = await postCheck\(label, target, env\.E2E_SUMMARY_CREATED_FILE\)/)
    assert.match(harness, /return browserOk && serverOk/)
  })
  it('the post-check judges the object rename too, and needs both verdicts (T-SUM-0b)', () => {
    const harness = readFileSync(path.join(ROOT, 'scripts', 'e2e-summary-visibility.mjs'), 'utf8')
    assert.match(harness, /objectVerdict = judgeObjectFacts\(facts, created\.object, paulOrgId\)/)
    assert.match(harness, /return verdict\.ok && objectVerdict\.ok/)
  })
})
