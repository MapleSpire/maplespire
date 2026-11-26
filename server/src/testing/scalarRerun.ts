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
 * TEST-ONLY: is this suite running a second time over SCALAR-ruled ModelMetas
 * (`modelMetaUrls.scalarAuthority.test.ts`)? A suite whose fixtures build a
 * ModelMeta asks this and, when true, builds it scalar-ruled — the shape an
 * epoch meta is BORN with (G4-16f, `modelEpochs.ts` `buildEpochMeta`).
 *
 * This replaces the retired `AM_META_URL_SCALAR` switch, under which the code
 * under test cut each document over IN PLACE on its first write — a path
 * production no longer has. Here
 * nothing in production reads the flag: only fixtures do.
 */
const FLAG = Symbol.for('maplespire.test.scalarRerun')

export function scalarRerun(): boolean {
  return (globalThis as Record<symbol, unknown>)[FLAG] === true
}

export function setScalarRerun(on: boolean): void {
  (globalThis as Record<symbol, unknown>)[FLAG] = on
}
