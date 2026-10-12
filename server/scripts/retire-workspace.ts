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
 * Record — or withdraw — a decision to stop gating backups on one workspace.
 *
 * This is the escape hatch for a root document that cannot be repaired. It is
 * deliberately a per-workspace command with a mandatory reason and operator
 * rather than a `--skip-broken` flag on the drill: a flag applies to whatever
 * happens to be broken on the day it runs, which is how a gate stops being one.
 *
 *   npm run backup:retire-workspace -- --list
 *   npm run backup:retire-workspace -- --landscape L --version V \
 *     --reason "chunks lost before 2026-07 backup; draft abandoned" --operator olivier
 *   npm run backup:retire-workspace -- --landscape L --version V --reinstate
 *   npm run backup:retire-workspace -- --document <documentId> \
 *     --reason "chunks incomplete; diagram never finished syncing" --operator olivier
 */

import 'dotenv/config'
import { pool } from '../src/db.js'
import {
  listRetiredDocuments,
  listRetiredWorkspaces,
  reinstateDocument,
  reinstateWorkspace,
  retireDocument,
  retireWorkspace,
} from '../src/backup/workspaceRetirement.js'

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

async function main(): Promise<void> {
  if (process.argv.includes('--list')) {
    console.log(JSON.stringify({
      event: 'backup.retired_workspaces',
      workspaces: await listRetiredWorkspaces(pool),
      documents: await listRetiredDocuments(pool),
    }, null, 2))
    return
  }

  // A leaf document gets a leaf-sized exemption. Retiring a whole workspace to
  // excuse one unloadable diagram would also exempt that landscape's root and
  // registry — the over-broad exemption this command exists to avoid.
  const documentId = option('--document')
  if (documentId) {
    if (process.argv.includes('--reinstate')) {
      const removed = await reinstateDocument(pool, documentId)
      console.log(JSON.stringify({
        event: removed ? 'backup.document_reinstated' : 'backup.document_not_retired',
        documentId,
      }))
      if (!removed) process.exitCode = 1
      return
    }
    const reason = option('--reason')
    const operator = option('--operator')
    if (!reason || !operator) {
      throw new Error('--reason and --operator are required: a retirement nobody signed is not a decision')
    }
    console.log(JSON.stringify({
      event: 'backup.document_retired',
      ...await retireDocument(pool, { documentId, reason, retiredBy: operator }),
    }))
    return
  }

  const landscapeId = option('--landscape')
  const versionId = option('--version')
  if (!landscapeId || !versionId) {
    throw new Error('--landscape and --version are required (or --document, or --list)')
  }

  if (process.argv.includes('--reinstate')) {
    const removed = await reinstateWorkspace(pool, { landscapeId, versionId })
    console.log(JSON.stringify({
      event: removed ? 'backup.workspace_reinstated' : 'backup.workspace_not_retired',
      landscapeId,
      versionId,
    }))
    if (!removed) process.exitCode = 1
    return
  }

  const reason = option('--reason')
  const operator = option('--operator')
  if (!reason || !operator) {
    throw new Error('--reason and --operator are required: a retirement nobody signed is not a decision')
  }
  const retired = await retireWorkspace(pool, {
    landscapeId,
    versionId,
    reason,
    retiredBy: operator,
  })
  console.log(JSON.stringify({ event: 'backup.workspace_retired', ...retired }))
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      event: 'backup.workspace_retire_failed',
      error: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
  .finally(() => pool.end())
