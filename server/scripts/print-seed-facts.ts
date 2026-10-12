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
 * Prints, as one JSON line, what scripts/tech-icons/add.mjs needs from the
 * technology seed: the catalog-wide seeded revision and the governed catalog
 * names. Imported rather than parsed, so the tool sees exactly what the seed
 * computes.
 *
 *   cd server && npx tsx scripts/print-seed-facts.ts
 */
import { GOVERNED_CATALOG_NAMES, SEEDED_TECHNOLOGY_CATALOG_REVISION } from '../src/technologies/seed.js'

console.log(JSON.stringify({ revision: SEEDED_TECHNOLOGY_CATALOG_REVISION, governed: GOVERNED_CATALOG_NAMES }))
