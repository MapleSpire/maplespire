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
 * A tiny registry for the currently-mounted 3D board so surfaces OUTSIDE the
 * canvas3d chunk (the Export tab) can capture it without importing three.js.
 *
 * The interface stays value-free (no `import` of Scene3D at runtime) so the
 * export bundle that reads `getActiveScene3D()` never pulls in the WebGL chunk —
 * it only ever holds the live instance the 3D view already loaded. Scene3D
 * registers itself on construct and clears itself on dispose.
 */
export interface Capturable3DScene {
  /** Same-frame supersampled GL readback of the live board → PNG blob. */
  capturePng(scale?: number): Blob
}

let active: Capturable3DScene | null = null

export function setActiveScene3D(scene: Capturable3DScene | null): void {
  active = scene
}

/** The live 3D board, or null when the 2D canvas is showing. */
export function getActiveScene3D(): Capturable3DScene | null {
  return active
}
