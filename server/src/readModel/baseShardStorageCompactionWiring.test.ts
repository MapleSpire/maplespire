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
 * THE WIRING OF AM_BASE_SHARD_STORAGE_COMPACTION, asserted on the source —
 * `index.ts` cannot be loaded in a unit test (`workspaceRootRouteWiring.test.ts`
 * does the same). The parse is tested in `baseShardStorageCompactionConfig.test.ts`
 * and the pass's behaviour under each mode in `workspaceCompaction.test.ts`;
 * neither sees index.ts drop the mode from the pass's deps (a mutant that
 * survived them), which would silently turn the kill switch into a no-op.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const INDEX = path.resolve(import.meta.dirname, '..', 'index.ts')

/** Source with whole-line `//` comments dropped. */
const code = (source: string) => source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n')

describe('index.ts wires AM_BASE_SHARD_STORAGE_COMPACTION into the compaction pass', () => {
  it('parses the mode at load and passes it, with the adapter compaction, to runWorkspaceCompaction', async () => {
    const source = code(await readFile(INDEX, 'utf8'))
    expect(source).toMatch(/const baseShardStorageCompaction = baseShardStorageCompactionMode\(\)/)
    const start = source.indexOf('runWorkspaceCompaction(key, {')
    expect(start).toBeGreaterThan(0)
    const end = source.indexOf('}))', start)
    const deps = source.slice(start, end)
    expect(deps).toMatch(/\n\s*compactDocumentStorage,\n/)
    expect(deps).toMatch(/\n\s*baseShardStorageCompaction,\n/)
  })
})
