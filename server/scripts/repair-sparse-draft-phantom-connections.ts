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
import { repairSparseDraftPhantomConnections } from '../src/maintenance/sparseDraftPhantomConnections.js'

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${flag} is required`)
  return value
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  if (apply && process.env.SPARSE_DRAFT_REPAIR_OFFLINE_CONFIRMED !== 'on') {
    throw new Error('stop every sync cell for this workspace, then set SPARSE_DRAFT_REPAIR_OFFLINE_CONFIRMED=on')
  }
  const landscapeId = valueAfter(args, '--landscape-id')
  const draftId = valueAfter(args, '--draft-id')
  const expectedRepairCount = apply
    ? Number(valueAfter(args, '--expected-count'))
    : undefined
  if (expectedRepairCount !== undefined
      && (!Number.isSafeInteger(expectedRepairCount) || expectedRepairCount < 1)) {
    throw new Error('--expected-count must be a positive integer')
  }
  const includeCapturedUnreferenced = args.includes('--confirm-layout-only-draft')
  if (apply && !includeCapturedUnreferenced) {
    throw new Error('--confirm-layout-only-draft is required for an applied legacy repair')
  }

  const repo = new Repo({
    network: [],
    storage: new PostgresStorageAdapter({ db: pool }),
    saveDebounceRate: 0,
  })
  try {
    const result = await repairSparseDraftPhantomConnections(
      pool,
      repo,
      landscapeId,
      draftId,
      { apply, expectedRepairCount, includeCapturedUnreferenced },
    )
    console.log(JSON.stringify({
      event: 'maintenance.sparse_draft_phantom_connections',
      reportOnly: !apply,
      ...result,
    }, null, 2))
  } finally {
    await repo.shutdown()
  }
}

main()
  .catch((error) => {
    console.error('[sparse-draft-phantom-connections] failed:', error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
