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

import type { C4Object } from '../types'

/**
 * The C4 hierarchy the model-object table can edit. Context-level actors and
 * systems stay at the root; systems own containers and containers own
 * components. Keeping this rule pure lets all UI affordances agree on which
 * drop targets are meaningful.
 */
export function canReparentObject(
  childType: C4Object['type'],
  parentType: C4Object['type']
): boolean {
  if (parentType === 'system') return childType === 'app' || childType === 'store'
  return (parentType === 'app' || parentType === 'store') && childType === 'component'
}
