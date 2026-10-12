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
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enumerateMaintainableWorkspaces } from './maintainableWorkspaces.js'

/**
 * Maintenance sweeps ONE named set of workspaces.
 *
 * Ownership enumerates `WHERE status = 'active'`; maintenance takes every row,
 * so a `merged` draft is inspected by maintenance but owned by no cell. See the
 * module docblock for why that difference is kept and where it is checked.
 */
describe('the maintainable-workspace enumeration', () => {
  it('returns the mapped shape every caller needs, in a stable order', async () => {
    const asked: string[] = []
    const db = {
      async query<R extends Record<string, unknown>>(text: string) {
        asked.push(text)
        return {
          rows: [
            { landscape_id: 'L1', id: 'v1', root_url: 'automerge:a' },
            { landscape_id: 'L1', id: 'v2', root_url: 'automerge:b' },
          ] as unknown as R[],
        }
      },
    }

    expect(await enumerateMaintainableWorkspaces(db)).toEqual([
      { landscapeId: 'L1', versionId: 'v1', rootUrl: 'automerge:a' },
      { landscapeId: 'L1', versionId: 'v2', rootUrl: 'automerge:b' },
    ])
    // ORDERED, so a report's row order does not depend on which caller
    // produced it (`fsckSharedRoots` groups by root).
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/ORDER BY landscape_id, id/)
  })

  it('is the ONLY whole-table read of `versions` in the server', () => {
    // TypeScript cannot express "nobody else may write this query", so this
    // source scan enforces it.
    //
    // SCOPED TO THE SWEEP SIGNATURE: a maintenance sweep reads `root_url` for
    // every row, because acting on a workspace means loading its root. So the
    // rule is "an unfiltered read that selects `root_url`". Counts
    // (`auth/platformRoutes.ts`), joins that only want `org_id`
    // (`rbac/docScope.ts`), `EXISTS` subqueries whose `WHERE` sits lines below,
    // and single-workspace lookups (`WHERE id = $1`) are all legitimate.
    const root = fileURLToPath(new URL('../', import.meta.url))

    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) files.push(path)
      }
    }
    walk(root)
    // The control: a walk that found nothing would make the assertion below
    // vacuous, and this gate asserts a NON-existence.
    expect(files.length, 'the source walk found nothing — the scan is broken, not the tree')
      .toBeGreaterThan(50)

    const offenders: string[] = []
    for (const file of files) {
      if (file.endsWith(join('maintenance', 'maintainableWorkspaces.ts'))) continue
      // COMMENTS STRIPPED FIRST, so prose mentioning `FROM versions` is not
      // read as code.
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split(/\r?\n/)
        .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
        .join('\n')

      for (const match of source.matchAll(/SELECT\b([\s\S]{0,400}?)\bFROM versions\b([\s\S]{0,400})/gi)) {
        const selected = match[1] ?? ''
        const tail = match[2] ?? ''
        // Only a sweep READS A ROOT for every row. A count, or a join that wants
        // `org_id`, is a different question about the same table.
        if (!/\broot_url\b/i.test(selected)) continue
        // Filtered to one workspace, or narrowed by a join predicate — the
        // window is generous because these clauses routinely sit lines below.
        if (/\bWHERE\b/i.test(tail)) continue
        offenders.push(`${file.slice(root.length)}: SELECT${selected.replace(/\s+/g, ' ').slice(0, 60)}… FROM versions`)
      }
    }

    expect(
      offenders,
      'these sweep `versions` without going through enumerateMaintainableWorkspaces — '
      + 'the set maintenance walks must have exactly one definition (decision D30)',
    ).toEqual([])
  })

  it('the enumeration and ownership DISAGREE, and the difference is the filter', () => {
    // Pinned so that closing the gap is a deliberate act rather than a silent
    // drift. Ownership narrows to `active`; maintenance does not narrow at all.
    // If this goes red, revisit the boot-time set parity check
    // (`workspaceSetParity.ts`) rather than deleting the assertion.
    const ownership = readFileSync(
      fileURLToPath(new URL('../syncCells/ownership.ts', import.meta.url)),
      'utf8',
    )
    expect(ownership, 'ownership no longer filters to active versions').toMatch(
      /FROM versions WHERE status = 'active'/,
    )
    const enumeration = readFileSync(
      fileURLToPath(new URL('./maintainableWorkspaces.ts', import.meta.url)),
      'utf8',
    )
    const sql = /const MAINTAINABLE_WORKSPACES_SQL =\s*\n?\s*'([^']+)'/.exec(enumeration)?.[1]
    expect(sql, 'the enumeration SQL moved — this assertion no longer reads it').toBeDefined()
    expect(sql, 'maintenance grew a filter: the two sets may now agree, which is T-21\'s business')
      .not.toMatch(/\bWHERE\b/i)
  })
})
