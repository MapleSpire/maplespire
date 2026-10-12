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

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  assertWorkspaceSetParity,
  readWorkspaceSetParity,
  WorkspaceSetParityError,
} from './workspaceSetParity.js'

/**
 * The two workspace sets are compared at boot.
 *
 * Not an equality: ownership filters to `status = 'active'`, maintenance does
 * not filter at all, so a merged draft is swept but not ownable. The claim is
 * that the difference is EXACTLY the non-active versions.
 */
describe('boot parity between the maintainable and ownable workspace sets', () => {
  /** Rows as the real tables would return them, from one fake. */
  function db(rows: Array<{ landscape: string; version: string; status: string }>) {
    const asked: string[] = []
    return {
      asked,
      query: async <R extends Record<string, unknown>>(text: string) => {
        asked.push(text.replace(/\s+/g, ' ').trim())
        if (/WHERE status = 'active'/.test(text)) {
          return {
            rows: rows.filter((row) => row.status === 'active')
              .map((row) => ({ landscape_id: row.landscape, id: row.version })) as unknown as R[],
          }
        }
        if (/\bstatus\b/.test(text)) {
          return {
            rows: rows.map((row) => ({
              landscape_id: row.landscape, id: row.version, status: row.status,
            })) as unknown as R[],
          }
        }
        return {
          rows: rows.map((row) => ({
            landscape_id: row.landscape, id: row.version, root_url: `automerge:${row.version}`,
          })) as unknown as R[],
        }
      },
    }
  }

  const pool = (queryable: { query: unknown }) => ({
    connect: async () => ({ ...queryable, release: () => {} }) as never,
  })

  it('the ordinary fleet: a merged draft is swept, unownable, and EXPLAINED', async () => {
    // Five active versions and one merged draft: 6 swept vs 5 ownable.
    const parity = await readWorkspaceSetParity(db([
      { landscape: 'L1', version: 'v1', status: 'active' },
      { landscape: 'L1', version: 'v2', status: 'active' },
      { landscape: 'L2', version: 'v1', status: 'active' },
      { landscape: 'L2', version: 'v2', status: 'active' },
      { landscape: 'L3', version: 'v1', status: 'active' },
      { landscape: 'L3', version: 'draft-1', status: 'merged' },
    ]))

    expect(parity.maintainable).toBe(6)
    expect(parity.ownable).toBe(5)
    expect(parity.explained).toEqual([
      { landscapeId: 'L3', versionId: 'draft-1', status: 'merged' },
    ])
    expect(parity.unexplained).toEqual([])
    expect(parity.unswept).toEqual([])
  })

  it('does NOT throw on that fleet — the assertion must survive its own database', async () => {
    // The control that matters most. A parity check that refuses to start on the
    // ordinary production shape is a check nobody keeps.
    const lines: string[] = []
    const rows = [
      { landscape: 'L1', version: 'v1', status: 'active' },
      { landscape: 'L1', version: 'draft-1', status: 'merged' },
    ]
    await expect(assertWorkspaceSetParity(pool(db(rows)), (line) => lines.push(line)))
      .resolves.toMatchObject({ maintainable: 2, ownable: 1 })

    // ...and the expected difference is REPORTED on the healthy boot, so an
    // operator sees the gap instead of inferring it from silence.
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'maintenance.workspace_set_parity',
      maintainable: 2,
      ownable: 1,
      explainedByStatus: { merged: 1 },
      unexplained: 0,
      unswept: 0,
    })
  })

  it('THROWS when a swept workspace is unownable for no reason status explains', async () => {
    // The incident: the two enumerations disagree about a row they both call
    // `active`. A workspace no cell can own is one whose scheduled fsck runs on
    // no cell at all, and nothing else reports that.
    const rows = [{ landscape: 'L1', version: 'v1', status: 'active' }]
    // The ownable query answers nothing while the sweep still returns the row —
    // a structural divergence rather than a status difference.
    const broken = {
      query: async <R extends Record<string, unknown>>(text: string) => {
        if (/WHERE status = 'active'/.test(text)) return { rows: [] as unknown as R[] }
        if (/\bstatus\b/.test(text)) {
          return { rows: rows.map((r) => ({ landscape_id: r.landscape, id: r.version, status: r.status })) as unknown as R[] }
        }
        return { rows: rows.map((r) => ({ landscape_id: r.landscape, id: r.version, root_url: 'automerge:x' })) as unknown as R[] }
      },
    }

    const error = await assertWorkspaceSetParity(pool(broken), () => {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WorkspaceSetParityError)
    expect((error as Error).message).toContain('L1/v1')
    expect((error as Error).message).toContain('scheduled fsck runs on no cell')
  })

  it('THROWS in the other direction too — ownable but never swept', async () => {
    // Maintenance is currently the superset, so this is asserted rather than
    // assumed: a workspace a cell owns but maintenance never visits is one whose
    // corruption is never looked for.
    const rows = [{ landscape: 'L1', version: 'v1', status: 'active' }]
    const broken = {
      query: async <R extends Record<string, unknown>>(text: string) => {
        if (/WHERE status = 'active'/.test(text)) {
          return { rows: rows.map((r) => ({ landscape_id: r.landscape, id: r.version })) as unknown as R[] }
        }
        if (/\bstatus\b/.test(text)) {
          return { rows: rows.map((r) => ({ landscape_id: r.landscape, id: r.version, status: r.status })) as unknown as R[] }
        }
        // The sweep sees nothing.
        return { rows: [] as unknown as R[] }
      },
    }

    const error = await assertWorkspaceSetParity(pool(broken), () => {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WorkspaceSetParityError)
    expect((error as Error).message).toContain('Ownable but never swept: [L1/v1]')
  })

  it('reads BOTH real enumerations, not a re-derivation of its own', async () => {
    // If it computed both sets from one query it wrote itself, it would only
    // prove that filtering by status filters by status. It must issue the
    // maintenance sweep AND the ownership query, as those modules define them.
    const fake = db([{ landscape: 'L1', version: 'v1', status: 'active' }])
    await readWorkspaceSetParity(fake)

    expect(fake.asked.some((sql) => /FROM versions ORDER BY landscape_id, id$/.test(sql)),
      'the maintenance enumeration was not issued').toBe(true)
    expect(fake.asked.some((sql) => /FROM versions WHERE status = 'active'$/.test(sql)),
      'the ownership enumeration was not issued').toBe(true)

    // PROVENANCE, not text: inlining ownership's SQL instead of importing the
    // constant issues a byte-identical statement, so the assertions above stay
    // green while the check would drift the moment `ownership.ts` changed its
    // filter.
    const source = readFileSync(
      fileURLToPath(new URL('./workspaceSetParity.ts', import.meta.url)),
      'utf8',
    )
    expect(
      source,
      'the ownership enumeration is not imported — this check would compare a copy',
    ).toMatch(/import \{ OWNABLE_WORKSPACES_SQL \} from '\.\.\/syncCells\/ownership\.js'/)

    // THE CONSTANT MUST BE PASSED AS AN ARGUMENT. Searching for the SQL text
    // misses a copy spelled with escaped quotes, and counting the identifier
    // is fooled by its mentions in prose and in the error message. What cannot
    // be faked is the constant appearing where an argument goes, in source
    // with comments removed.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n')
    expect(
      code,
      'OWNABLE_WORKSPACES_SQL is imported but never passed — the ownership query has been inlined here, '
      + 'so this check compares a copy that drifts the moment ownership.ts changes its filter',
    ).toMatch(/^\s*OWNABLE_WORKSPACES_SQL,?\s*$/m)
  })

  it('runs inside ONE repeatable-read snapshot, and gives the client back', async () => {
    // Two independent reads of a live table are a race: a version created
    // between them appears in the later one and not the earlier, and would be
    // reported as a structural divergence — a spurious refusal to start, on the
    // busiest database. And the client must come back whatever happens, or
    // `pool.end()` never resolves.
    const statements: string[] = []
    let released = 0
    const client = {
      query: async <R extends Record<string, unknown>>(text: string) => {
        statements.push(text.replace(/\s+/g, ' ').trim())
        if (/^(BEGIN|ROLLBACK|COMMIT)/.test(text)) return { rows: [] as unknown as R[] }
        if (/WHERE status = 'active'/.test(text)) return { rows: [] as unknown as R[] }
        return { rows: [] as unknown as R[] }
      },
      release: () => { released += 1 },
    }

    await assertWorkspaceSetParity({ connect: async () => client as never }, () => {})
    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ')
    expect(statements.at(-1)).toBe('ROLLBACK')
    expect(released).toBe(1)
  })

  it('gives the client back even when the read throws', async () => {
    // Every await between checkout and hand-back is inside the `try`.
    let released = 0
    const client = {
      query: async (text: string) => {
        if (text.startsWith('BEGIN')) return { rows: [] }
        if (text.startsWith('ROLLBACK')) return { rows: [] }
        throw new Error('the database went away mid-parity')
      },
      release: () => { released += 1 },
    }

    await expect(assertWorkspaceSetParity({ connect: async () => client as never }, () => {}))
      .rejects.toThrow('went away')
    expect(released, 'a leaked client makes pool.end() never resolve').toBe(1)
  })

  it('boot calls it, after ownership has started', () => {
    // `index.ts` is a top-level script with side effects, so the CALL SITE is
    // read from source while the policy above is executed. Order matters: a cell
    // that could not confirm the fleet topology has bigger problems than set
    // parity, and `start()` is what decides that.
    const source = readFileSync(
      fileURLToPath(new URL('../index.ts', import.meta.url)),
      'utf8',
    )
    const startAt = source.indexOf('await syncCellOwnership.start()')
    const parityAt = source.indexOf('await assertWorkspaceSetParity(')
    expect(startAt, 'ownership no longer starts in index.ts').toBeGreaterThan(-1)
    expect(parityAt, 'boot never asserts workspace-set parity').toBeGreaterThan(-1)
    expect(startAt).toBeLessThan(parityAt)
    // AWAITED — a floating promise would let boot continue past a divergence.
    expect(source).toMatch(/await assertWorkspaceSetParity\(/)
  })
})
