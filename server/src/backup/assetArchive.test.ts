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

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  archiveAssets,
  assetFilenameFromPath,
  collectAssetInventory,
  EMPTY_ASSET_ARCHIVE,
  restoreAssets,
  verifyAssetArchive,
  type AssetQueryable,
} from './assetArchive.js'

function blob(content: string, extension: 'svg' | 'png' = 'svg'): { name: string; body: Buffer } {
  const body = Buffer.from(content)
  return { name: `${createHash('sha256').update(body).digest('hex')}.${extension}`, body }
}

/** Answers only what the archive asks: relation existence, then one union. */
function fakeDb(rows: Array<{ path: string; referenced: boolean }>, tables = [
  'technology_assets', 'technology_revisions',
]): AssetQueryable {
  return {
    async query<R extends Record<string, unknown>>(text: string, values?: unknown[]) {
      if (text.includes('to_regclass')) {
        const relation = String(values?.[0] ?? '').replace('public.', '')
        return { rows: [{ present: tables.includes(relation) }] as unknown as R[] }
      }
      return { rows: rows as unknown as R[] }
    },
  }
}

describe('technology asset archive', () => {
  let volume: string
  let bundle: string
  let restored: string

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'maplespire-assets-'))
    volume = join(root, 'volume')
    bundle = join(root, 'bundle')
    restored = join(root, 'restored')
    await mkdir(volume, { recursive: true })
    await mkdir(bundle, { recursive: true })
  })

  afterEach(async () => {
    await rm(join(volume, '..'), { recursive: true, force: true })
  })

  it('archives, verifies and restores a NON-EMPTY volume', async () => {
    // The exit criterion this test exists for says an empty-volume pass is not
    // evidence, so every assertion below is on files that actually exist.
    const light = blob('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const dark = blob('<svg xmlns="http://www.w3.org/2000/svg" fill="#fff"/>')
    const pending = blob('<svg xmlns="http://www.w3.org/2000/svg" id="pending"/>')
    for (const asset of [light, dark, pending]) {
      await writeFile(join(volume, asset.name), asset.body)
    }
    const inventory = await collectAssetInventory(fakeDb([
      { path: `/assets/technologies/${light.name}`, referenced: true },
      { path: `/assets/technologies/${dark.name}`, referenced: true },
      { path: `/assets/technologies/${pending.name}`, referenced: false },
    ]))
    expect(inventory).toHaveLength(3)

    const summary = await archiveAssets({ inventory, sourceDirectory: volume, bundleDirectory: bundle })
    expect(summary.files).toBe(3)
    expect(summary.referencedByRevision).toBe(2)
    expect(summary.bytes).toBe(light.body.length + dark.body.length + pending.body.length)
    expect(await verifyAssetArchive(bundle, summary)).toEqual([])

    const result = await restoreAssets({ bundleDirectory: bundle, targetDirectory: restored })
    expect(result).toEqual({ written: 3, alreadyPresent: 0, bytes: summary.bytes })
    expect(await readFile(join(restored, light.name))).toEqual(light.body)
  })

  it('fails the backup when a blob a revision renders is missing from the volume', async () => {
    const present = blob('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const gone = blob('<svg xmlns="http://www.w3.org/2000/svg" id="gone"/>')
    await writeFile(join(volume, present.name), present.body)
    const inventory = await collectAssetInventory(fakeDb([
      { path: `/assets/technologies/${present.name}`, referenced: true },
      { path: `/assets/technologies/${gone.name}`, referenced: true },
    ]))
    await expect(archiveAssets({ inventory, sourceDirectory: volume, bundleDirectory: bundle }))
      .rejects.toThrow(gone.name)
  })

  it('tolerates a missing pending upload, because the GC sweep is entitled to remove one', async () => {
    const present = blob('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const swept = blob('<svg xmlns="http://www.w3.org/2000/svg" id="swept"/>')
    await writeFile(join(volume, present.name), present.body)
    const inventory = await collectAssetInventory(fakeDb([
      { path: `/assets/technologies/${present.name}`, referenced: true },
      { path: `/assets/technologies/${swept.name}`, referenced: false },
    ]))
    const summary = await archiveAssets({ inventory, sourceDirectory: volume, bundleDirectory: bundle })
    expect(summary.files).toBe(1)
    expect(summary.missingPendingUploads).toEqual([swept.name])
  })

  it('refuses to launder a corrupt blob into the bundle', async () => {
    const asset = blob('<svg xmlns="http://www.w3.org/2000/svg"/>')
    // Same name, different bytes: exactly what a partial write or bit rot leaves.
    await writeFile(join(volume, asset.name), Buffer.from('<svg id="tampered"/>'))
    const inventory = await collectAssetInventory(fakeDb([
      { path: `/assets/technologies/${asset.name}`, referenced: true },
    ]))
    await expect(archiveAssets({ inventory, sourceDirectory: volume, bundleDirectory: bundle }))
      .rejects.toThrow(/content-addressed filename/)
    expect(await readdir(join(bundle, 'assets')).catch(() => [])).not.toContain(asset.name)
  })

  it('counts volume files no database row names, and does not archive them', async () => {
    const known = blob('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const orphan = blob('<svg xmlns="http://www.w3.org/2000/svg" id="orphan"/>')
    await writeFile(join(volume, known.name), known.body)
    await writeFile(join(volume, orphan.name), orphan.body)
    const inventory = await collectAssetInventory(fakeDb([
      { path: `/assets/technologies/${known.name}`, referenced: true },
    ]))
    const summary = await archiveAssets({ inventory, sourceDirectory: volume, bundleDirectory: bundle })
    expect(summary.files).toBe(1)
    expect(summary.unreferencedFiles).toBe(1)
    expect(await readdir(join(bundle, 'assets'))).toEqual([known.name])
  })

  it('catches a blob that went missing from the bundle after the manifest was written', async () => {
    const asset = blob('<svg xmlns="http://www.w3.org/2000/svg"/>')
    await writeFile(join(volume, asset.name), asset.body)
    const inventory = await collectAssetInventory(fakeDb([
      { path: `/assets/technologies/${asset.name}`, referenced: true },
    ]))
    const summary = await archiveAssets({ inventory, sourceDirectory: volume, bundleDirectory: bundle })
    await rm(join(bundle, 'assets', asset.name))
    const errors = await verifyAssetArchive(bundle, summary)
    expect(errors.join('\n')).toMatch(/holds 0 files, manifest says 1/)
  })

  it('checks a manifest with no assets section against an EMPTY archive, not against nothing', async () => {
    // A bundle full of blobs whose manifest lost its `assets` key must not pass:
    // skipping the check on an absent section is the silent-restore failure.
    const asset = blob('<svg xmlns="http://www.w3.org/2000/svg"/>')
    await mkdir(join(bundle, 'assets'), { recursive: true })
    await writeFile(join(bundle, 'assets', asset.name), asset.body)
    expect(await verifyAssetArchive(bundle, EMPTY_ASSET_ARCHIVE)).not.toEqual([])
    // ...while a bundle that genuinely has none still verifies clean.
    await rm(join(bundle, 'assets'), { recursive: true, force: true })
    expect(await verifyAssetArchive(bundle, EMPTY_ASSET_ARCHIVE)).toEqual([])
  })

  it('never lets a hand-edited asset path escape the volume directory', () => {
    expect(assetFilenameFromPath('/assets/technologies/../../../etc/passwd')).toBeNull()
    expect(assetFilenameFromPath('/assets/technologies/not-a-hash.svg')).toBeNull()
    expect(assetFilenameFromPath(`/assets/technologies/${'a'.repeat(64)}.svg`)).toBe(`${'a'.repeat(64)}.svg`)
  })

  it('returns an empty inventory when the technology tables were never created', async () => {
    expect(await collectAssetInventory(fakeDb([], []))).toEqual([])
  })
})
