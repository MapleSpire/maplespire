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

import { useEffect, useState, useSyncExternalStore } from 'react'
import { SpotlightServerSearch } from '../../lib/search/spotlightServer'
import type { SpotlightServerAnswer, SpotlightServerState } from '../../lib/search/spotlightServer'
import type { SpotlightWireRequest } from '../../lib/search/spotlight/wire'

/**
 * The Spotlight's server-tier answer for `key`, or null while there is none to
 * use: nothing asked, still pending, or the request failed or was refused (the
 * resident results then stand alone). An answer is returned only for the key it
 * was asked with, so a render for a newer query never sees an older answer.
 */
export function useSpotlightServerAnswer(key: string | null, request: SpotlightWireRequest | null): {
  readonly answer: SpotlightServerAnswer | null
  readonly state: SpotlightServerState
} {
  const [search] = useState(() => new SpotlightServerSearch())
  const state = useSyncExternalStore(search.subscribe, search.getState, search.getState)
  // `request` is derived from `key` (the caller memoizes them together).
  useEffect(() => { search.update(key, request) }, [search, key, request])
  useEffect(() => () => search.cancel(), [search])
  // Back online: the query on screen gets its server answer without a keystroke.
  useEffect(() => {
    const onOnline = () => search.retry()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [search])
  const answer = key !== null && state.key === key && state.outcome?.kind === 'answer' ? state.outcome.answer : null
  return { answer, state }
}
