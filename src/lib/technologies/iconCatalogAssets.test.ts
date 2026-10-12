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

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ICONS } from '../techIcons'
import { TECH_ICON_DETAILS } from './techIconDetails'

const iconFile = (path: string) => resolve('docker', path.replace(/^\/icons\//, 'icons/'))

interface ProvenanceRecord {
  source: string
  license: string
  light: string
  files: string[]
}

describe('technology icon catalog assets', () => {
  it('never publishes an immutable icon URL that the image server cannot serve', () => {
    const missing = ICONS.flatMap((icon) => [icon.iconLight, icon.iconDark])
      .filter((path): path is string => Boolean(path))
      .filter((path) => !existsSync(resolve('docker', path.replace(/^\/icons\//, 'icons/'))))

    expect(missing).toEqual([])
  })

  it('uses the available dark .NET asset for both themes', () => {
    const dotnet = ICONS.find((icon) => icon.name === '.NET')
    expect(dotnet?.iconLight).toBe('/icons/dark/net-ec7556fb.png')
    expect(dotnet?.iconDark).toBe(dotnet?.iconLight)
  })

  it('gives every re-artworked entry a revision the seed has not already written', () => {
    // The seed inserts (id, revision) with ON CONFLICT DO NOTHING: an entry
    // whose icon changed at the catalog-wide revision would never reach a
    // database that already holds it.
    const seed = readFileSync(resolve('server/src/technologies/seed.ts'), 'utf8')
    const catalogRevision = Number(seed.match(/SEEDED_TECHNOLOGY_CATALOG_REVISION = (\d+)/)?.[1])
    expect(catalogRevision).toBeGreaterThan(0)
    const stale = Object.entries(TECH_ICON_DETAILS)
      .filter(([, details]) => details.revision !== undefined && details.revision <= catalogRevision)
    expect(stale.map(([name]) => name)).toEqual([])
    const names = new Set(ICONS.map((icon) => icon.name))
    expect(Object.keys(TECH_ICON_DETAILS).filter((name) => !names.has(name))).toEqual([])
  })

  it('records where every tooling-added icon came from, and ships it in the house format', () => {
    const provenance = JSON.parse(readFileSync(resolve('docs/tech-icons/provenance.json'), 'utf8')) as Record<string, ProvenanceRecord>
    const byName = new Map(ICONS.map((icon) => [icon.name, icon]))
    const problems: string[] = []
    for (const [name, record] of Object.entries(provenance)) {
      const icon = byName.get(name)
      if (!icon) { problems.push(`${name}: not in the catalog`); continue }
      if (!record.license || !record.source || !record.light) problems.push(`${name}: incomplete provenance`)
      if (icon.iconLight !== record.files[0] || icon.iconDark !== record.files[1]) problems.push(`${name}: catalog points elsewhere`)
      for (const file of record.files) {
        const png = readFileSync(iconFile(file))
        // IHDR width/height at bytes 16..23.
        if (png.readUInt32BE(16) !== 128 || png.readUInt32BE(20) !== 128) problems.push(`${file}: not 128×128`)
      }
    }
    expect(Object.keys(provenance).length).toBeGreaterThanOrEqual(77)
    expect(problems).toEqual([])
  })

  it('keeps the file of every retired path, which stays valid icon input', () => {
    const retired = Object.values(TECH_ICON_DETAILS).flatMap((details) => details.retiredIcons ?? [])
    expect(retired.length).toBeGreaterThanOrEqual(18)
    expect(retired.filter((path) => !existsSync(iconFile(path)))).toEqual([])
  })

  it('shows Oracle products with the Oracle mark, not the six-to-one ORACLE wordmark', () => {
    const oracle = ICONS.filter((icon) => /^Oracle (Database|Cloud Infrastructure|APEX|Forms|Reports|ATG Commerce|JD Edwards|Essbase)$/.test(icon.name))
    expect(oracle).toHaveLength(8)
    for (const icon of oracle) {
      const png = readFileSync(iconFile(icon.iconLight!))
      expect(png.readUInt32BE(16)).toBe(128)
      expect(TECH_ICON_DETAILS[icon.name]?.revision).toBeGreaterThan(3)
    }
    // One artwork for the family: the light files are byte-identical renders.
    const bytes = new Set(oracle.map((icon) => readFileSync(iconFile(icon.iconLight!)).toString('base64')))
    expect(bytes.size).toBe(1)
  })
})
