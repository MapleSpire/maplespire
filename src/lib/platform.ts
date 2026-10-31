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

/** True on macOS and iOS, where the command key is the shortcut modifier. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
}

/** The modifier prefix for a keyboard hint: the command glyph on Apple
 *  platforms, `Ctrl ` elsewhere (so `Ctrl K` reads as one combo). */
export function modifierLabel(): string {
  return isApplePlatform() ? '⌘' : 'Ctrl '
}
