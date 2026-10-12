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

import type { Pool } from 'pg'
import { ensureTechnologySchema } from './schema.js'
import { seedTechnologyCatalog } from './seed.js'

/**
 * Installs the platform-managed technology catalog during every normal server
 * boot. Public technologies are global; organizations inherit them through the
 * default `all` policy, so this single idempotent bootstrap covers both
 * existing organizations and organizations provisioned later.
 */
export async function ensureManagedTechnologyCatalog(
  pool: Pool,
  bootstrapOrgId: string,
): Promise<void> {
  await ensureTechnologySchema(pool)
  await seedTechnologyCatalog(pool, bootstrapOrgId)
}
