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
 * Regression, defect 2026-10-17: Structurizr imports set `icon:
 * technologies[0]` with no `iconAssignment`, and the renderers drew a logo
 * only from assignment paths, so every imported shape showed a letter badge.
 *
 * The importer deliberately writes the NAME only: writing artwork into the
 * data would make a Structurizr round trip add logos the source file never
 * drew (structurizrJson/roundTrip.test.ts pins that contract). The logo comes
 * from the renderers' catalog resolution (shapeIconArtwork), which the 2D
 * engine, the 3D board and the raster exports all go through — so what this
 * pins is the importer's output fed to that exact resolver.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import type { C4Object } from '../../types'
import { loadIconCatalog, shapeIconArtwork } from '../technologies/shapeIconArtwork'
import { getIconByName } from '../techIcons'
import { structurizrSource } from './structurizrSource'
import { structurizrJsonSource } from './structurizrJsonSource'

/** Expected artwork, read from the catalog itself: the artwork files differ
 * between distributions, the resolution rule does not. */
function catalogArtwork(name: string) {
  const entry = getIconByName(name)
  expect(entry?.iconLight ?? entry?.iconDark, `${name} has catalog artwork`).toMatch(/^\/icons\//)
  return {
    ...(entry!.iconLight ? { iconLightPath: entry!.iconLight } : {}),
    ...(entry!.iconDark ? { iconDarkPath: entry!.iconDark } : {}),
  }
}

const DSL = `workspace "Icons" {
    model {
        user = person "User"
        system = softwareSystem "Shop" {
            web = container "Web App" "UI" "React"
            api = container "API" "Logic" "Node.js, Kotlin"
            db = container "Database" "Data" "PostgreSQL"
            legacy = container "Mainframe" "Old" "Cobol-ish 9000"
        }
        user -> web "Uses"
    }
    views {
        container system { include *  autoLayout }
    }
}`

beforeAll(() => loadIconCatalog())

const named = (objects: C4Object[], name: string) => {
  const found = objects.find((o) => o.name === name)
  expect(found, name).toBeDefined()
  return found!
}

describe('Structurizr DSL import: imported technology icons render as logos', () => {
  it('resolves each imported icon name to its catalog artwork; unknown names keep the badge', async () => {
    const { objects } = await structurizrSource.run!(DSL)

    expect(shapeIconArtwork(named(objects, 'Web App'))).toEqual(catalogArtwork('React'))
    expect(shapeIconArtwork(named(objects, 'Database'))).toEqual(catalogArtwork('PostgreSQL'))
    // "Node.js" is the governed name; the visual catalog calls it "NodeJS".
    expect(shapeIconArtwork(named(objects, 'API'))).toEqual(catalogArtwork('NodeJS'))

    const legacy = named(objects, 'Mainframe')
    expect(legacy.icon).toBe('Cobol-ish 9000')
    expect(shapeIconArtwork(legacy)).toBeUndefined()
    expect(shapeIconArtwork(named(objects, 'User'))).toBeUndefined()
  }, 60_000)
})

describe('Structurizr JSON import: imported technology icons render as logos', () => {
  it('resolves each imported icon name to its catalog artwork', async () => {
    const { objects } = await structurizrJsonSource.run!(structurizrJsonSource.placeholder!)
    expect(shapeIconArtwork(named(objects, 'Web App'))).toEqual(catalogArtwork('React'))
    expect(shapeIconArtwork(named(objects, 'Database'))).toEqual(catalogArtwork('PostgreSQL'))
  }, 60_000)
})
