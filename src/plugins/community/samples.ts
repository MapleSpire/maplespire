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

import { installCommunityTheme } from './registry'
import { sampleCommunityTheme, sampleCommunityBaseConfig } from '../sandbox/sampleCommunityTheme'
import { useSkinStore } from '../../stores/skinStore'

/**
 * Install the bundled sample community theme so it is selectable in the skin
 * picker. Runs after the skin store finishes hydrating from IndexedDB so the
 * `installSkin` call isn't clobbered by hydration.
 */
export function installSampleCommunityThemes(): void {
  const run = () => installCommunityTheme(sampleCommunityTheme, sampleCommunityBaseConfig)
  if (useSkinStore.persist.hasHydrated()) run()
  else useSkinStore.persist.onFinishHydration(run)
}
