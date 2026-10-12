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

import type { AppView } from '../stores/uiStore'

/**
 * View → path suffix under the workspace prefix.
 *
 * A table rather than a template because the two names disagree:
 * `model-objects` lives at `/model`. Views with no route of their own (they
 * render inside another) map to nothing and are left alone.
 *
 * These literals MUST stay in step with the `navigate()` targets in `RouteSync`
 * — that is the coupling this module exists to make checkable.
 */
const VIEW_PATH: Partial<Record<AppView, string>> = {
  diagrams: '/diagrams',
  'model-objects': '/model',
  'model-viewer': '/model-viewer',
  connections: '/connections',
  dependencies: '/dependencies',
  'decision-records': '/decision-records',
  drafts: '/drafts',
}

export interface RouteSyncState {
  currentView: AppView
  currentDiagramId: string | null
  /** `/app/landscape/<lid>/version/<vid>` for the live workspace. */
  wsPrefix: string
}

/**
 * The pathname the store currently describes, or `null` when the store does not
 * pin one (a view with no route of its own, or the diagram view before any
 * diagram has opened).
 *
 * `RouteSync` mirrors store → URL. It needs to answer a second question too:
 * *has the store caught up with a URL the user navigated to?* On Back, the
 * route component applies URL → store in a sibling effect of the same commit,
 * so `RouteSync` still holds the PREVIOUS store value and would happily emit it
 * — pushing the user right back to the page they just left. Comparing this
 * against the live pathname is how it tells "the store moved" from "the URL
 * moved and the store has not caught up yet".
 */
export function desiredPathname(state: RouteSyncState): string | null {
  if (state.currentView === 'diagram') {
    return state.currentDiagramId ? `${state.wsPrefix}/diagram/${state.currentDiagramId}` : null
  }
  const suffix = VIEW_PATH[state.currentView]
  return suffix ? `${state.wsPrefix}${suffix}` : null
}

export interface PopHoldInput {
  /** The live URL. */
  pathname: string
  /** The path the user reached with Back/Forward, or null if the last history
   *  action was an ordinary navigation. */
  poppedPath: string | null
  state: RouteSyncState
}

export interface PopHoldResult {
  /** True when `RouteSync` must emit nothing on this run. */
  hold: boolean
  /** The value to write back to the hold, so it releases exactly once. */
  poppedPath: string | null
}

/**
 * Decide whether store → URL mirroring is allowed right now.
 *
 * Back and Forward are the user speaking through the URL, and the store has not
 * heard yet: the route component applies URL → store in a sibling effect of the
 * same commit, so `RouteSync` is still holding the PREVIOUS render's view and
 * diagram. Emitting then pushes the page the user just left, making browser
 * Back do nothing at all — silently, because that push also truncates the
 * forward entry so even `history.length` never moves.
 *
 * So the rule is: while the URL is one the user popped to and the store still
 * describes somewhere else, say nothing. The moment they agree, release — every
 * emission is a no-op at that point anyway, and holding any longer would swallow
 * the user's NEXT in-app navigation.
 */
export function popHold(input: PopHoldInput): PopHoldResult {
  if (input.poppedPath === null) return { hold: false, poppedPath: null }
  // The URL moved on from the popped one: whatever happens next is not this
  // hold's business.
  if (input.poppedPath !== input.pathname) return { hold: false, poppedPath: null }
  const desired = desiredPathname(input.state)
  if (desired === input.pathname) return { hold: false, poppedPath: null }
  return { hold: true, poppedPath: input.poppedPath }
}
