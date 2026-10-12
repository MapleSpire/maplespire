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

import { OWNABLE_WORKSPACES_SQL } from '../syncCells/ownership.js'
import { enumerateMaintainableWorkspaces } from './maintainableWorkspaces.js'

/**
 * BOOT PARITY between the set maintenance sweeps and the set ownership may own.
 *
 * Not `a === b`: the two sets differ permanently and by intent. Ownership
 * filters to `status = 'active'`, maintenance does not filter at all, so e.g. a
 * merged draft is swept by maintenance and ownable by nobody.
 *
 * The assertion is: THE DIFFERENCE IS EXACTLY THE NON-ACTIVE VERSIONS. Anything
 * maintenance sweeps that ownership cannot own, and that is not explained by
 * its status, is a structural divergence — a workspace nobody owns is one whose
 * scheduled fsck never runs on any cell.
 *
 * It calls the REAL enumerators (`OWNABLE_WORKSPACES_SQL` is exported for this)
 * rather than re-deriving both sets, which would only prove that filtering by
 * status filters by status.
 */

export interface WorkspaceSetParity {
  maintainable: number
  ownable: number
  /** Swept but not ownable, WITH the status that explains it. */
  explained: Array<{ landscapeId: string; versionId: string; status: string }>
  /** Swept but not ownable, and NOT explained by a status. The incident. */
  unexplained: Array<{ landscapeId: string; versionId: string }>
  /** Ownable but never swept — maintenance would skip a live workspace. */
  unswept: Array<{ landscapeId: string; versionId: string }>
}

export class WorkspaceSetParityError extends Error {
  readonly code = 'workspace_set_parity'
  constructor(readonly parity: WorkspaceSetParity) {
    const unexplained = parity.unexplained.map((w) => `${w.landscapeId}/${w.versionId}`).join(', ')
    const unswept = parity.unswept.map((w) => `${w.landscapeId}/${w.versionId}`).join(', ')
    super(
      'The set maintenance sweeps and the set a cell may own diverge for a reason status does not explain. '
      + `Swept but unownable: [${unexplained || 'none'}]. Ownable but never swept: [${unswept || 'none'}]. `
      + 'A workspace nobody can own is a workspace whose scheduled fsck runs on no cell; a workspace nobody '
      + 'sweeps is one whose corruption is never looked for. Both enumerations are named — '
      + 'enumerateMaintainableWorkspaces and OWNABLE_WORKSPACES_SQL — so this is a real disagreement between '
      + 'them, not two spellings of one question.',
    )
    this.name = 'WorkspaceSetParityError'
  }
}

interface ParityDb {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>
}

interface ParityPool {
  connect(): Promise<ParityDb & { release(err?: unknown): void }>
}

/** A space separator is safe: workspace ids are validated against a
 *  conservative character class that cannot contain one, so the joined key
 *  stays unique. */
const key = (landscapeId: string, versionId: string): string => `${landscapeId} ${versionId}`

/**
 * Run `read` against ONE REPEATABLE READ snapshot.
 *
 * The awaits between checkout and hand-back are `BEGIN`, the read itself, and
 * `ROLLBACK` — all inside the `try`, so `finally` returns the
 * client whichever of them throws. A `BEGIN` that fails leaves no transaction,
 * and `ROLLBACK` with no transaction is a warning rather than an error, so the
 * cleanup cannot itself become the thing that strands the client.
 *
 * ROLLBACK and not COMMIT: this reads and writes nothing, and a rollback cannot
 * fail the way a commit can. There is nothing to keep.
 */
async function inOneSnapshot<T>(
  pool: ParityPool,
  read: (db: ParityDb) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    return await read(client)
  } finally {
    try {
      await client.query('ROLLBACK')
    } catch {
      // The transaction is already gone. Returning the client is what matters,
      // and that happens on the next line either way.
    }
    client.release()
  }
}

/**
 * Read both sets and classify the difference.
 *
 * THREE READS, and they must see ONE SNAPSHOT — which is the caller's job, not
 * this function's. A version created between two of them appears in the later
 * one and not the earlier, and would be reported as a structural divergence: a
 * spurious refusal to start, likeliest on the busiest database. This signature
 * takes any queryable so a test can drive it with a fake; `assertWorkspaceSetParity`
 * is what supplies a REPEATABLE READ transaction in production.
 */
export async function readWorkspaceSetParity(db: ParityDb): Promise<WorkspaceSetParity> {
  const maintainable = await enumerateMaintainableWorkspaces(db)
  const { rows: ownableRows } = await db.query<{ landscape_id: string; id: string }>(
    OWNABLE_WORKSPACES_SQL,
  )
  // Read from the same snapshot as the two sets above, so a status cannot
  // change between "why is this swept but unownable" and the answer.
  const { rows: statusRows } = await db.query<{ landscape_id: string; id: string; status: string }>(
    'SELECT landscape_id, id, status FROM versions',
  )

  const ownable = new Set(ownableRows.map((row) => key(row.landscape_id, row.id)))
  const swept = new Set(maintainable.map((w) => key(w.landscapeId, w.versionId)))
  const statuses = new Map(statusRows.map((row) => [key(row.landscape_id, row.id), row.status]))

  const explained: WorkspaceSetParity['explained'] = []
  const unexplained: WorkspaceSetParity['unexplained'] = []
  for (const workspace of maintainable) {
    const id = key(workspace.landscapeId, workspace.versionId)
    if (ownable.has(id)) continue
    const status = statuses.get(id)
    // `active` here would mean the two enumerations disagree about a row they
    // both classify the same way — a genuine structural divergence. A missing
    // status means the row vanished mid-read, which the snapshot is meant to
    // prevent and which is therefore also unexplained.
    if (status !== undefined && status !== 'active') {
      explained.push({ landscapeId: workspace.landscapeId, versionId: workspace.versionId, status })
    } else {
      unexplained.push({ landscapeId: workspace.landscapeId, versionId: workspace.versionId })
    }
  }

  // THE OTHER DIRECTION: a workspace a cell may own but maintenance never
  // sweeps is one whose corruption is never looked for. Maintenance is
  // currently the superset, so this is asserted rather than assumed.
  const unswept = ownableRows
    .filter((row) => !swept.has(key(row.landscape_id, row.id)))
    .map((row) => ({ landscapeId: row.landscape_id, versionId: row.id }))

  return { maintainable: maintainable.length, ownable: ownableRows.length, explained, unexplained, unswept }
}

/**
 * Refuse to start on an unexplained divergence.
 *
 * LOUD, and fatal, because the failure it names is silent and permanent by
 * nature: a workspace no cell owns is one whose scheduled fsck runs nowhere, and
 * nothing else in the system reports that. `log` receives the parity on every
 * boot — including the healthy one — so an operator can see the expected
 * difference rather than inferring it from silence.
 */
export async function assertWorkspaceSetParity(
  pool: ParityPool,
  log: (line: string) => void = console.log,
): Promise<WorkspaceSetParity> {
  const parity = await inOneSnapshot(pool, readWorkspaceSetParity)
  log(JSON.stringify({
    event: 'maintenance.workspace_set_parity',
    maintainable: parity.maintainable,
    ownable: parity.ownable,
    // Counted by status rather than listed: on a large fleet the list is the
    // whole table, and the COUNT is what a reader compares between boots.
    explainedByStatus: parity.explained.reduce<Record<string, number>>((tally, entry) => {
      tally[entry.status] = (tally[entry.status] ?? 0) + 1
      return tally
    }, {}),
    unexplained: parity.unexplained.length,
    unswept: parity.unswept.length,
  }))
  if (parity.unexplained.length > 0 || parity.unswept.length > 0) {
    throw new WorkspaceSetParityError(parity)
  }
  return parity
}
