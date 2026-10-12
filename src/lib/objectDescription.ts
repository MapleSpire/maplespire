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

type DescriptionCarrier = Pick<C4Object, 'shortDescription' | 'description'>

/**
 * The canvas used `description` as its compact label before detailed Markdown
 * documentation became a separate field. Keep old workspaces readable, but as
 * soon as `shortDescription` exists (including an intentional empty string), it
 * is the only value rendered on the shape.
 */
export function objectShortDescription(object: DescriptionCarrier): string | undefined {
  if (Object.prototype.hasOwnProperty.call(object, 'shortDescription')) {
    return object.shortDescription || undefined
  }
  return object.description || undefined
}

/** Legacy `description` values were compact labels, not detailed documentation. */
export function objectDetailedDescription(object: DescriptionCarrier): string | undefined {
  return Object.prototype.hasOwnProperty.call(object, 'shortDescription')
    ? object.description || undefined
    : undefined
}

/** Materialize the legacy compact value before the first detailed-description edit. */
export function separateObjectDescription(
  object: DescriptionCarrier,
  description: string,
): Pick<C4Object, 'shortDescription' | 'description'> {
  return {
    shortDescription: objectShortDescription(object) ?? '',
    description,
  }
}

/** Materialize a compact-field edit and retire the legacy overloaded value. */
export function separateObjectShortDescription(
  object: DescriptionCarrier,
  shortDescription: string,
): Pick<C4Object, 'shortDescription' | 'description'> {
  return {
    shortDescription,
    description: objectDetailedDescription(object) ?? '',
  }
}
