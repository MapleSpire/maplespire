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
 * Remove a workspace ALIAS — a `versions` row that points at a root document
 * ANOTHER workspace also points at (`npm run fsck` reports it as SHARED-ROOT).
 *
 *   npm run remove:workspace-alias -- --landscape-id default \
 *     --version-id 5lribOxaraJghToN --confirm-remove-alias
 *
 * STOP THE API FIRST (its projector holds per-workspace state for the alias).
 *
 * Why aliases must die rather than be tolerated: document admission is
 * first-owner-wins PER DOCUMENT, so the losing twin's docScope walk fails
 * "foreign" forever and every COLD boot of it hangs without an error (warm
 * clients hide it completely).
 *
 * What this deletes: the alias's ROWS only, scoped to the exact
 * (landscape, version) pair for every table that carries version_id.
 * Landscape-WIDE rows (RBAC scopes, restore manifests, retired-workspace
 * markers, AI conversations, …) belong to every version of the landscape:
 * they are touched only when the alias is the landscape's LAST version, after
 * their counts are printed, and only under `--confirm-drop-landscape-rows`.
 * It NEVER touches `automerge_storage`: the documents belong to the twin.
 *
 * Refusal gates, all load-bearing:
 *  1. The root MUST be shared with another workspace. On a unique root this
 *     tool would orphan real data — that is deletion, not alias removal, and
 *     it needs a different (non-existent, on purpose) tool.
 *  2. The alias must claim ZERO rows in `automerge_document_workspace`. If it
 *     claims any, the twins interleave ownership and a plain row-delete would
 *     strand those documents unadmitted anywhere; reassignment is a separate,
 *     deliberate act.
 *  3. Landscape-wide rows require the second flag (above) — deleting them for
 *     ALL versions of the landscape in one sweep would, on a multi-version
 *     landscape, destroy rights and manifests of versions that survive.
 */
import 'dotenv/config'
import { pool } from '../src/db.js'

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`${flag} is required`)
  return value
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (!args.includes('--confirm-remove-alias')) {
    throw new Error('--confirm-remove-alias is required')
  }
  const landscapeId = valueAfter(args, '--landscape-id')
  const versionId = valueAfter(args, '--version-id')

  const { rows: target } = await pool.query<{ root_url: string }>(
    'SELECT root_url FROM versions WHERE landscape_id = $1 AND id = $2',
    [landscapeId, versionId],
  )
  if (target.length === 0) throw new Error(`no such workspace: ${landscapeId}/${versionId}`)
  const rootUrl = target[0].root_url

  // Gate 1: alias proof.
  const { rows: twins } = await pool.query<{ landscape_id: string; id: string }>(
    'SELECT landscape_id, id FROM versions WHERE root_url = $1 AND NOT (landscape_id = $2 AND id = $3)',
    [rootUrl, landscapeId, versionId],
  )
  if (twins.length === 0) {
    throw new Error(
      `refusing: ${landscapeId}/${versionId} is the ONLY workspace on root ${rootUrl}. `
      + 'Removing it would orphan real data; this tool removes aliases only.',
    )
  }

  // Gate 2: the alias must own no documents.
  const { rows: claimed } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM automerge_document_workspace WHERE landscape_id = $1 AND version_id = $2',
    [landscapeId, versionId],
  )
  if (claimed[0].n !== '0') {
    throw new Error(
      `refusing: the alias claims ${claimed[0].n} document(s) in automerge_document_workspace. `
      + 'Reassign them to the surviving twin first — deleting the rows would strand those documents.',
    )
  }

  console.log(`[alias] removing ${landscapeId}/${versionId} (root ${rootUrl} survives via `
    + twins.map((twin) => `${twin.landscape_id}/${twin.id}`).join(', ') + ')')

  // Deletion scope, decided BEFORE any write (deleting by landscape_id across
  // every table would, on a multi-version landscape, destroy RBAC scopes,
  // restore manifests and AI conversations belonging to versions that
  // SURVIVE):
  //  - tables carrying BOTH landscape_id and version_id → delete by the pair;
  //  - tables carrying only landscape_id (scopes, landscape_versions,
  //    backup_retired_workspaces, …) hold rows owned by every version of the
  //    landscape. They are touched ONLY when the alias is the landscape's LAST
  //    version, and only under the second explicit flag, after their counts
  //    were printed.
  const { rows: otherVersions } = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM versions WHERE landscape_id = $1 AND id <> $2',
    [landscapeId, versionId],
  )
  const lastVersion = otherVersions[0].n === '0'

  const { rows: scopedTables } = await pool.query<{ table_name: string; has_version: boolean }>(
    `SELECT c1.table_name,
            bool_or(c2.column_name IS NOT NULL) AS has_version
     FROM information_schema.columns c1
     LEFT JOIN information_schema.columns c2
       ON c2.table_schema = c1.table_schema
      AND c2.table_name = c1.table_name
      AND c2.column_name = 'version_id'
     WHERE c1.table_schema = 'public' AND c1.column_name = 'landscape_id'
       AND c1.table_name NOT IN ('versions', 'landscapes', 'automerge_document_workspace')
     GROUP BY c1.table_name
     ORDER BY c1.table_name`,
  )
  const versionScoped = scopedTables.filter((table) => table.has_version)
  const landscapeOnly = scopedTables.filter((table) => !table.has_version)

  if (lastVersion) {
    const inventory: Array<{ table: string; rows: number }> = []
    for (const { table_name } of landscapeOnly) {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${table_name}" WHERE landscape_id = $1`,
        [landscapeId],
      )
      if (rows[0].n !== '0') inventory.push({ table: table_name, rows: Number(rows[0].n) })
    }
    if (inventory.length > 0 && !args.includes('--confirm-drop-landscape-rows')) {
      for (const item of inventory) {
        console.log(`[alias] landscape-wide: ${item.table} holds ${item.rows} row(s) for '${landscapeId}'`)
      }
      throw new Error(
        'this is the landscape\'s LAST version; the landscape-wide rows above (RBAC scopes, '
        + 'restore manifests, …) would go with it. Re-run with --confirm-drop-landscape-rows '
        + 'to accept that, or stop here.',
      )
    }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const { table_name } of versionScoped) {
      const result = await client.query(
        `DELETE FROM "${table_name}" WHERE landscape_id = $1 AND version_id = $2`,
        [landscapeId, versionId],
      )
      if ((result.rowCount ?? 0) > 0) {
        console.log(`[alias] ${table_name}: ${result.rowCount} row(s) deleted`)
      }
    }
    if (lastVersion) {
      for (const { table_name } of landscapeOnly) {
        const result = await client.query(
          `DELETE FROM "${table_name}" WHERE landscape_id = $1`,
          [landscapeId],
        )
        if ((result.rowCount ?? 0) > 0) {
          console.log(`[alias] ${table_name} (landscape-wide, last version): ${result.rowCount} row(s) deleted`)
        }
      }
    } else {
      console.log(`[alias] landscape '${landscapeId}' keeps ${otherVersions[0].n} other version(s); `
        + 'landscape-wide tables (scopes, manifests, …) left untouched')
    }
    await client.query('DELETE FROM sync_workspace_ownership WHERE version_id = $1', [versionId])
    await client.query('DELETE FROM versions WHERE landscape_id = $1 AND id = $2', [landscapeId, versionId])
    if (lastVersion) {
      await client.query('DELETE FROM landscapes WHERE id = $1', [landscapeId])
      console.log(`[alias] landscape row '${landscapeId}' deleted (no versions remain)`)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
  console.log('[alias] done — restart the API, then `npm run fsck` must show no SHARED-ROOT')
}

main()
  .catch((error) => {
    console.error('[alias] failed:', error)
    process.exitCode = 2
  })
  .finally(async () => pool.end().catch(() => undefined))
