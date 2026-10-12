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

/**
 * Lazy entry for the WebGL 3D board. This module (and everything it pulls in —
 * three, troika, the fonts) loads only on the first 2D→3D toggle; eager code
 * reads camera facts from `./presets` instead.
 *
 *   const { Scene3D } = await import('../canvas3d')
 *
 * HMR guard: a stale mixed-module engine renders subtly torn scenes — any
 * edit under canvas3d/ force-reloads.
 */

export { Scene3D, type Scene3DCallbacks } from './Scene3D'

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot?.invalidate()
  })
}
