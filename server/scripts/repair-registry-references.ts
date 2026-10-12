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

import 'dotenv/config'
import { Repo } from '@automerge/automerge-repo'
import { PostgresStorageAdapter } from '../src/automergeStorage.js'
import { pool } from '../src/db.js'
import { repairMissingRegistryReferences } from '../src/maintenance/registryReferenceRepair.js'

function createRepo(): Repo {
  return new Repo({ network: [], storage: new PostgresStorageAdapter({ db: pool }), saveDebounceRate: 0 })
}

async function main(): Promise<void> {
  const apply = process.env.REGISTRY_REFERENCE_APPLY === 'on'
  const repo = createRepo()
  let result
  try {
    result = await repairMissingRegistryReferences(pool, repo, { apply })
  } finally {
    await repo.shutdown()
  }
  if (apply && result.removed > 0) {
    const verifyRepo = createRepo()
    try {
      const verification = await repairMissingRegistryReferences(pool, verifyRepo)
      if (verification.missing.length > 0) {
        throw new Error(`cold verification still found ${verification.missing.length} missing registry reference(s)`)
      }
    } finally {
      await verifyRepo.shutdown()
    }
  }
  console.log(JSON.stringify({ event: 'maintenance.registry_reference_repair', ...result }))
  if (!result.safeToApply) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error('[registry-reference-repair] failed:', error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
