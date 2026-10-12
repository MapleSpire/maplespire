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

import details from './techIconDetails.json'

/**
 * Per-technology details that the public technology seed writes to the
 * database, keyed by the exact catalog name in `src/lib/techIcons.ts`.
 *
 * Kept OUT of the ICONS array on purpose: optional fields on a few of its
 * ~4 000 literals make `tsc` fail with TS2590 (measured 2026-10-11). Written by
 * `scripts/tech-icons/add.mjs`; see docs/tech-icons/README.md.
 */
export interface TechIconDetails {
  description?: string
  website?: string
  /** Seeded revision of this entry when above the catalog-wide
   * SEEDED_TECHNOLOGY_CATALOG_REVISION. Raised whenever an EXISTING entry's
   * artwork changes: the seed never overwrites an (id, revision) row. */
  revision?: number
  /** Artwork paths this entry used before a replace. They stay valid icon
   * input: earlier seeded revisions, private technologies and drafts still
   * reference them, and the files are kept and served. */
  retiredIcons?: string[]
}

export const TECH_ICON_DETAILS: Readonly<Record<string, TechIconDetails>> = details
