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

import { describe, expect, it } from 'vitest'
import { metricsTokenMatches, renderPrometheus } from './metrics.js'

describe('renderPrometheus', () => {
  it('emits HELP, TYPE and one line per labelled sample', () => {
    expect(renderPrometheus([{
      name: 'maplespire_read_model_workspaces',
      help: 'Workspaces by status.',
      type: 'gauge',
      values: [
        { labels: { status: 'healthy' }, value: 3 },
        { labels: { status: 'stale' }, value: 1 },
      ],
    }])).toBe(
      '# HELP maplespire_read_model_workspaces Workspaces by status.\n' +
      '# TYPE maplespire_read_model_workspaces gauge\n' +
      'maplespire_read_model_workspaces{status="healthy"} 3\n' +
      'maplespire_read_model_workspaces{status="stale"} 1\n'
    )
  })

  it('emits an unlabelled sample without braces', () => {
    // `metric{} 1` is accepted by Prometheus but not by every downstream parser,
    // and it reads as a mistake in a scrape someone is debugging at 3am.
    expect(renderPrometheus([{ name: 'm', help: 'h', type: 'gauge', values: [{ value: 1 }] }]))
      .toContain('\nm 1\n')
  })

  it('escapes the three characters Prometheus escapes in a label value, and no others', () => {
    const out = renderPrometheus([{
      name: 'm', help: 'h', type: 'gauge',
      values: [{ labels: { k: 'a"b\\c\nd e=f' }, value: 1 }],
    }])
    expect(out).toContain('m{k="a\\"b\\\\c\\nd e=f"} 1')
  })

  it('keeps a multi-line help string on one line', () => {
    // A newline inside HELP silently ends the metric's metadata and the rest is
    // parsed as a metric line — a scrape that fails on a comment.
    const out = renderPrometheus([{ name: 'm', help: 'first\nsecond', type: 'gauge', values: [] }])
    expect(out).toContain('# HELP m first second')
    expect(out.split('\n').filter((line) => line.startsWith('# HELP'))).toHaveLength(1)
  })

  it('renders a non-finite value as NaN, not as 0', () => {
    // Zero is a legitimate reading. A collector that failed must not look like a
    // subsystem that is quiet.
    const out = renderPrometheus([{
      name: 'm', help: 'h', type: 'gauge',
      values: [{ value: Number.NaN }, { labels: { k: 'v' }, value: Number.POSITIVE_INFINITY }],
    }])
    expect(out).toContain('\nm NaN\n')
    expect(out).toContain('m{k="v"} NaN')
    expect(out).not.toContain(' 0\n')
  })
})

describe('metricsTokenMatches', () => {
  it('rejects everything when no token is configured', () => {
    // The endpoint 404s in this case; this is the second lock on the same door,
    // because "unset means open" is the default that leaks scrape endpoints.
    expect(metricsTokenMatches('Bearer anything', undefined)).toBe(false)
    expect(metricsTokenMatches('Bearer anything', '')).toBe(false)
  })

  it('accepts the exact bearer token', () => {
    expect(metricsTokenMatches('Bearer s3cret', 's3cret')).toBe(true)
  })

  it('rejects a wrong token, a wrong scheme, a missing header and a prefix of the token', () => {
    expect(metricsTokenMatches('Bearer wrong', 's3cret')).toBe(false)
    expect(metricsTokenMatches('Basic s3cret', 's3cret')).toBe(false)
    expect(metricsTokenMatches(undefined, 's3cret')).toBe(false)
    expect(metricsTokenMatches('Bearer s3cre', 's3cret')).toBe(false)
    expect(metricsTokenMatches('Bearer s3cretX', 's3cret')).toBe(false)
  })

  it('does not throw on a length mismatch', () => {
    // `timingSafeEqual` throws on unequal lengths; an uncaught throw here would
    // become a 500 that tells an attacker the length was wrong.
    expect(() => metricsTokenMatches('Bearer ' + 'x'.repeat(1000), 'short')).not.toThrow()
  })
})
