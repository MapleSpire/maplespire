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

import { SDK_VERSION } from '../types'

/**
 * Shared semver helpers for theme compatibility. Lives in the SDK layer (no app
 * deps) so both the gallery client and the worker runtime can use them without a
 * circular import.
 */

/** Compare two semver strings: <0, 0, >0. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0)
  const pb = b.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

/** A theme is loadable if its targeted SDK major version is <= the app's. */
export function isSdkCompatible(themeSdkVersion: string): boolean {
  const themeMajor = Number(themeSdkVersion.split('.')[0]) || 0
  const appMajor = Number(SDK_VERSION.split('.')[0]) || 0
  return themeMajor <= appMajor
}
