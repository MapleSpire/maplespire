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

import { useEffect } from 'react'
import { startShareWatcher, stopShareWatcher } from '../lib/share/autoRepublish'

/**
 * Keeps "current version" share links up to date while the editor is open by
 * re-publishing their snapshot on (debounced) diagram changes. Mounted in the
 * app shell only — never in the public viewer.
 */
export function ShareAutoPublisher() {
  useEffect(() => {
    startShareWatcher()
    return () => stopShareWatcher()
  }, [])
  return null
}
