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
 * The verdict is a pure function so that the motivating case — a green
 * deployment over days-old rules — can be written down as a test rather than
 * reproduced by breaking a running host.
 *
 * The two-arm control against a REAL Prometheus (touch a rule file, watch this
 * report `stale`; reload, watch it report `fresh`) is manual: it needs Docker,
 * and a test that silently skipped without it would report green for not
 * having run.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { configFreshness } from './prometheus-config-freshness.mjs'

const AT = '2026-09-05T17:46:49Z'
const LOADED = Math.floor(Date.parse(AT) / 1000)

test('every watched file older than the load is fresh', () => {
  const report = configFreshness({
    lastConfigTime: AT,
    files: [
      { path: '/etc/prometheus/prometheus.yml', mtimeSeconds: LOADED - 3600 },
      { path: '/etc/prometheus/alerts.yml', mtimeSeconds: LOADED - 10 },
    ],
  })
  assert.equal(report.verdict, 'fresh')
  assert.deepEqual(report.stale, [])
  assert.equal(report.lastConfigSeconds, LOADED)
})

test('a file newer than the load is named, with how far ahead it is', () => {
  const report = configFreshness({
    lastConfigTime: AT,
    files: [
      { path: '/etc/prometheus/prometheus.yml', mtimeSeconds: LOADED - 3600 },
      { path: '/etc/prometheus/alerts.yml', mtimeSeconds: LOADED + 42 },
    ],
  })
  assert.equal(report.verdict, 'stale')
  assert.equal(report.stale.length, 1)
  assert.equal(report.stale[0].path, '/etc/prometheus/alerts.yml')
  assert.equal(report.stale[0].behindSeconds, 42)
})

test('the worst offender is reported first', () => {
  const report = configFreshness({
    lastConfigTime: AT,
    files: [
      { path: '/etc/prometheus/alerts.yml', mtimeSeconds: LOADED + 5 },
      { path: '/etc/prometheus/prometheus.yml', mtimeSeconds: LOADED + 900 },
    ],
  })
  assert.deepEqual(report.stale.map((file) => file.path), [
    '/etc/prometheus/prometheus.yml',
    '/etc/prometheus/alerts.yml',
  ])
})

// THE LOAD-BEARING CASE. An empty stale list is also what a detector that
// examined nothing produces, so the empty INPUT has to be separated from the
// clean RESULT before either can be trusted. Without this branch a Prometheus
// built with its configuration baked into the image — no binds, nothing to
// compare — would report `fresh` for ever, which is the strongest possible
// green for the weakest possible reason.
test('nothing to compare is `unknown`, never `fresh`', () => {
  const report = configFreshness({ lastConfigTime: AT, files: [] })
  assert.equal(report.verdict, 'unknown')
  assert.match(report.reason, /no mounted configuration files/)
  assert.notEqual(report.verdict, 'fresh')
})

// The REASON is asserted here, not just the verdict. `Date.parse(null)` is
// `NaN`, so deleting the absence guard leaves the verdict `unknown` either way;
// what it destroys is the distinction an operator needs: "the field was
// missing" points at an API or version change, "Prometheus answered with
// garbage" points at the value.
test('a missing lastConfigTime is `unknown`, and says the field was absent', () => {
  for (const absent of [null, undefined, '']) {
    const report = configFreshness({ lastConfigTime: absent, files: [{ path: '/a', mtimeSeconds: 1 }] })
    assert.equal(report.verdict, 'unknown', `for ${JSON.stringify(absent)}`)
    assert.equal(report.lastConfigSeconds, null)
    assert.match(report.reason, /did not report a lastConfigTime/, `for ${JSON.stringify(absent)}`)
  }
})

test('an unparseable lastConfigTime is `unknown`, and says so with the value', () => {
  const report = configFreshness({ lastConfigTime: 'never', files: [{ path: '/a', mtimeSeconds: 1 }] })
  assert.equal(report.verdict, 'unknown')
  assert.match(report.reason, /not a date.*never/)
})

test('an unreadable modification time is `unknown`, not an old file', () => {
  const report = configFreshness({
    lastConfigTime: AT,
    files: [{ path: '/etc/prometheus/alerts.yml', mtimeSeconds: Number.NaN }],
  })
  assert.equal(report.verdict, 'unknown')
  assert.match(report.reason, /alerts\.yml/)
})

// The boundary is `>` and not `>=`, deliberately, and it is worth pinning
// because both readings are defensible. Prometheus reports `lastConfigTime` to
// the second, so a file written in the same second as a successful reload is
// unorderable. Calling that STALE would leave a deploy failing on a tie that no
// further polling can break — `lastConfigTime` does not advance on its own. The
// blind window it costs instead requires a write that lands in the same second
// as, but after, a reload; `scripts/init-env.mjs` writes before `up`, so that
// ordering does not arise in the flow this guards.
test('a file written in the same second as the load counts as loaded', () => {
  const report = configFreshness({
    lastConfigTime: AT,
    files: [{ path: '/etc/prometheus/alerts.yml', mtimeSeconds: LOADED }],
  })
  assert.equal(report.verdict, 'fresh')
})

test('one second later is stale', () => {
  const report = configFreshness({
    lastConfigTime: AT,
    files: [{ path: '/etc/prometheus/alerts.yml', mtimeSeconds: LOADED + 1 }],
  })
  assert.equal(report.verdict, 'stale')
  assert.equal(report.stale[0].behindSeconds, 1)
})

// The motivating case, stated as data: a configuration loaded days before both
// mounted files were rewritten.
test('the 2026-09-05 demo host is reported stale', () => {
  const report = configFreshness({
    lastConfigTime: '2026-09-02T21:54:29Z',
    files: [
      { path: '/etc/prometheus/prometheus.yml', mtimeSeconds: Math.floor(Date.parse('2026-09-05T13:38:00Z') / 1000) },
      { path: '/etc/prometheus/alerts.yml', mtimeSeconds: Math.floor(Date.parse('2026-09-05T13:38:00Z') / 1000) },
    ],
  })
  assert.equal(report.verdict, 'stale')
  assert.equal(report.stale.length, 2)
})
