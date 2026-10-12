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

import { useSyncExternalStore } from 'react'
import { routedRetriesInFlight, subscribeRoutedRetries } from './retryable'

/**
 * How many routed reads are currently waiting out a `retryable: true` backoff.
 *
 * `useSyncExternalStore` rather than a zustand field, because the counter is
 * owned by the fetch layer and mirroring it into the store would give the same
 * fact two homes that can disagree. The subscribe callback fires once on
 * registration with the current value, which React tolerates and which removes
 * the window where a retry that began before mount goes unseen.
 */
/** Hoisted to module scope: React's subscribe effect keys on the function
 *  identity, so an inline arrow would tear down and re-add the listener on
 *  every render. */
const subscribe = (onChange: () => void) => subscribeRoutedRetries(onChange)

/** Server render: never mid-retry. */
const serverSnapshot = () => 0

export function useRoutedRetriesInFlight(): number {
  return useSyncExternalStore(subscribe, routedRetriesInFlight, serverSnapshot)
}
