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
import { parseServerTimingHeader, ServerTimingTrace } from './serverTiming.js'

describe('ServerTimingTrace', () => {
  it('formats asynchronous, synchronous and total durations', async () => {
    let now = 10
    const trace = new ServerTimingTrace(() => now)
    await trace.measure('workspace access', async () => {
      now = 22.34
    })
    trace.measureSync('query/db', () => {
      now = 30.01
    })
    now = 35

    expect(trace.headerValue()).toBe(
      'workspace_access;dur=12.3, query_db;dur=7.7, total;dur=25.0',
    )
  })

  it('records a failed operation before rethrowing', async () => {
    let now = 0
    const trace = new ServerTimingTrace(() => now)
    await expect(trace.measure('query', async () => {
      now = 8
      throw new Error('boom')
    })).rejects.toThrow('boom')
    now = 9
    expect(trace.headerValue()).toBe('query;dur=8.0, total;dur=9.0')
  })

  it('writes a privacy-minimal Server-Timing header', () => {
    let now = 0
    const trace = new ServerTimingTrace(() => now)
    trace.measureSync('render', () => { now = 4 })
    const headers = new Map<string, string>()
    trace.write({ setHeader: (name, value) => headers.set(name, value) })
    expect(headers.get('Server-Timing')).toBe('render;dur=4.0, total;dur=4.0')
  })

  it('parses emitted durations for capacity gates and ignores malformed entries', () => {
    expect(parseServerTimingHeader(
      'workspace;dur=1.2, pool_wait;dur=45.6, cache;desc="hit", broken;dur=nope, total;dur=52',
    )).toEqual({ workspace: 1.2, pool_wait: 45.6, total: 52 })
    expect(parseServerTimingHeader(null)).toEqual({})
  })
})
