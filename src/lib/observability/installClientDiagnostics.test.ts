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

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { markClientTimeline, resetClientTimeline } from './clientTimeline'
import {
  installClientDiagnostics,
  publishClientDiagnosticsSnapshot,
  stopClientDiagnosticsMirror,
} from './installClientDiagnostics'
import { stopClientPerformanceDiagnostics } from './clientPerformance'

describe('client diagnostics DOM snapshot', () => {
  afterEach(() => {
    stopClientDiagnosticsMirror()
    stopClientPerformanceDiagnostics()
    vi.useRealTimers()
    document.getElementById('maplespire-client-diagnostics')?.remove()
    resetClientTimeline()
  })

  it('publishes a machine-readable snapshot without relying on an isolated window realm', () => {
    markClientTimeline('test.ready', { count: 1 })
    publishClientDiagnosticsSnapshot()

    const node = document.getElementById('maplespire-client-diagnostics')
    expect(node?.getAttribute('type')).toBe('application/json')
    const payload = JSON.parse(node?.textContent ?? '{}')
    expect(payload.timeline.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'test.ready' })]),
    )
    expect(payload.performance).toEqual(
      expect.objectContaining({ maxHeartbeatGapMs: expect.any(Number) }),
    )
  })

  it('refreshes the snapshot on the diagnostics interval', () => {
    vi.useFakeTimers()
    installClientDiagnostics()
    resetClientTimeline()
    markClientTimeline('test.after-install')

    vi.advanceTimersByTime(1_000)

    const node = document.getElementById('maplespire-client-diagnostics')
    const payload = JSON.parse(node?.textContent ?? '{}')
    expect(payload.timeline.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'test.after-install' })]),
    )
  })
})
