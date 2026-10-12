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
import { desiredPathname, popHold, type RouteSyncState } from './routeSyncTarget'
import type { AppView } from '../stores/uiStore'

const WS = '/app/landscape/L1/version/V1'
const state = (over: Partial<RouteSyncState> = {}): RouteSyncState => ({
  currentView: 'diagram', currentDiagramId: 'dA', wsPrefix: WS, ...over,
})

describe('desiredPathname', () => {
  it('pins the path for every view that owns a route', () => {
    // These literals are duplicated in RouteSync's navigate() targets. Pinning
    // them is what keeps the pop-hold's idea of "converged" and the emitter's
    // idea of "already there" from drifting apart.
    const cases: [AppView, string][] = [
      ['diagrams', `${WS}/diagrams`],
      ['model-objects', `${WS}/model`],       // NOT /model-objects
      ['model-viewer', `${WS}/model-viewer`],
      ['connections', `${WS}/connections`],
      ['dependencies', `${WS}/dependencies`],
      ['decision-records', `${WS}/decision-records`],
      ['drafts', `${WS}/drafts`],
    ]
    for (const [view, path] of cases) {
      expect(desiredPathname(state({ currentView: view })), view).toBe(path)
    }
  })

  it('names the open diagram', () => {
    expect(desiredPathname(state())).toBe(`${WS}/diagram/dA`)
  })

  it('pins nothing while the diagram view has no diagram open', () => {
    // Before the bridge opens one there is no id to compare against, so a hold
    // here would never release.
    expect(desiredPathname(state({ currentDiagramId: null }))).toBeNull()
  })
})

/**
 * Browser Back between diagrams must work. RouteSync mirrors store → URL from a
 * RENDER-time snapshot, while the route component applies URL → store in a
 * sibling effect of the same commit — so without the hold, on a pop it still
 * holds the previous diagram and pushes the page the user just left. That push
 * also truncates the forward entry, so `history.length` never moves and Back
 * looks inert rather than bouncy.
 */
describe('popHold', () => {
  it('holds while the store still describes the page the user left', () => {
    const result = popHold({
      pathname: `${WS}/diagram/dA`,        // Back landed here
      poppedPath: `${WS}/diagram/dA`,
      state: state({ currentDiagramId: 'dB' }), // store is still on the newer one
    })
    expect(result).toEqual({ hold: true, poppedPath: `${WS}/diagram/dA` })
  })

  it('releases the moment the store agrees, so the NEXT navigation is not swallowed', () => {
    // Holding past convergence would be the same bug with the sign flipped: the
    // user opens another diagram from the app and the URL never follows.
    const result = popHold({
      pathname: `${WS}/diagram/dA`,
      poppedPath: `${WS}/diagram/dA`,
      state: state({ currentDiagramId: 'dA' }),
    })
    expect(result).toEqual({ hold: false, poppedPath: null })
  })

  it('releases as soon as the URL moves off the popped path', () => {
    const result = popHold({
      pathname: `${WS}/connections`,
      poppedPath: `${WS}/diagram/dA`,
      state: state({ currentView: 'connections' }),
    })
    expect(result).toEqual({ hold: false, poppedPath: null })
  })

  it('never holds when the last history action was an ordinary navigation', () => {
    const result = popHold({
      pathname: `${WS}/diagram/dA`,
      poppedPath: null,
      state: state({ currentDiagramId: 'dB' }),
    })
    expect(result).toEqual({ hold: false, poppedPath: null })
  })

  it('holds across a view change too, not only between diagrams', () => {
    // Back from the ADR page to Model Connections: same race, different views.
    const result = popHold({
      pathname: `${WS}/connections`,
      poppedPath: `${WS}/connections`,
      state: state({ currentView: 'decision-records' }),
    })
    expect(result.hold).toBe(true)
  })

  it('does not hold forever on a view the store cannot pin', () => {
    // desiredPathname is null here; a hold would never release and would freeze
    // the address bar for the rest of the session.
    const result = popHold({
      pathname: `${WS}/diagram/dA`,
      poppedPath: `${WS}/diagram/dA`,
      state: state({ currentDiagramId: null }),
    })
    expect(result.hold).toBe(true)
    // …but the very next run, once a diagram opens, releases it.
    expect(popHold({
      pathname: `${WS}/diagram/dA`,
      poppedPath: result.poppedPath,
      state: state({ currentDiagramId: 'dA' }),
    })).toEqual({ hold: false, poppedPath: null })
  })
})
