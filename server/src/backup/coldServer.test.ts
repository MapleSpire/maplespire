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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serverEntrypoint } from './coldServer.js'

describe('cold server entrypoint selection', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'maplespire-cold-server-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const withSources = async () => {
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'index.ts'), '')
    await mkdir(join(root, 'node_modules', 'tsx', 'dist'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '')
  }
  const withDist = async () => {
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'dist', 'index.js'), '')
  }

  it('prefers the sources when BOTH are present', async () => {
    // The one that matters. Every source checkout carries a dist/ from whenever
    // somebody last ran the build, so preferring it would verify a restore
    // against code that is not the code under test — silently, and forever.
    await withSources()
    await withDist()
    expect(serverEntrypoint(root).kind).toBe('src/index.ts (tsx)')
  })

  it('falls back to dist when there are no sources — a real deployment', async () => {
    await withDist()
    expect(serverEntrypoint(root).kind).toBe('dist/index.js')
  })

  it('falls back to dist when sources are present but tsx is not installed', async () => {
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'index.ts'), '')
    await withDist()
    expect(serverEntrypoint(root).kind).toBe('dist/index.js')
  })

  it('refuses to guess when neither exists', () => {
    expect(() => serverEntrypoint(root)).toThrow(/cannot boot a cold server/)
  })
})
