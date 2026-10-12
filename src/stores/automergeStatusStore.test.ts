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

import { beforeEach, describe, expect, it } from 'vitest'
import { useAutomergeStatus } from './automergeStatusStore'

describe('automerge diagram readiness', () => {
  beforeEach(() => {
    useAutomergeStatus.setState({
      status: 'connecting',
      ready: false,
      visualReady: false,
      editReady: false,
      error: null,
      bootFallbackActive: false,
    })
  })

  it('keeps first paint and editing readiness independent', () => {
    const state = useAutomergeStatus.getState()
    state.beginDiagramOpen()
    state.markVisualReady()
    expect(useAutomergeStatus.getState()).toMatchObject({ visualReady: true, editReady: false })

    useAutomergeStatus.getState().markEditReady()
    expect(useAutomergeStatus.getState()).toMatchObject({ visualReady: true, editReady: true })
  })

  it('re-arms both diagram gates on a diagram or workspace switch', () => {
    useAutomergeStatus.getState().markEditReady()
    useAutomergeStatus.getState().beginDiagramOpen()
    expect(useAutomergeStatus.getState()).toMatchObject({ visualReady: false, editReady: false })

    useAutomergeStatus.getState().markEditReady()
    useAutomergeStatus.getState().beginWorkspaceSwitch()
    expect(useAutomergeStatus.getState()).toMatchObject({
      ready: false,
      visualReady: false,
      editReady: false,
    })
  })

  it('does not latch PostgreSQL durability from the saving state', () => {
    useAutomergeStatus.getState().setStatus('saving')
    expect(useAutomergeStatus.getState()).toMatchObject({ status: 'saving', ready: false })
    useAutomergeStatus.getState().setStatus('ready')
    expect(useAutomergeStatus.getState()).toMatchObject({ status: 'ready', ready: true })
  })

  it('the boot-fallback marker survives status changes and resets on a workspace switch', () => {
    // The marker describes the SESSION (local content served while the
    // server warms up), so ordinary status churn must not clear it — only an
    // explicit switch (a new session) or the bridge's next successful
    // non-fallback boot may.
    useAutomergeStatus.getState().setBootFallbackActive(true)
    useAutomergeStatus.getState().setStatus('ready')
    expect(useAutomergeStatus.getState().bootFallbackActive).toBe(true)

    useAutomergeStatus.getState().beginWorkspaceSwitch()
    expect(useAutomergeStatus.getState().bootFallbackActive).toBe(false)
  })
})
