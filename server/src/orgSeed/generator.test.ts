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
import { generateSeedModel, ORG_SEED_TECHNOLOGY_NAMES } from './generator.js'
import { SEEDED_TECHNOLOGY_CATALOG_REVISION, SEEDED_TECHNOLOGY_IDS } from '../technologies/seed.js'

describe('organization demo seed technology usages', () => {
  it('references only deterministic identities installed in the central catalog', () => {
    const model = generateSeedModel()
    const usages = model.objects.flatMap((object) => Object.values(object.technologyUsages ?? {}))
    expect(new Set(usages.map((usage) => usage.snapshot.name))).toEqual(new Set(ORG_SEED_TECHNOLOGY_NAMES))
    for (const usage of usages) {
      expect(usage.technologyId).toBe(SEEDED_TECHNOLOGY_IDS[usage.snapshot.name])
      expect(usage.catalogRevision).toBe(SEEDED_TECHNOLOGY_CATALOG_REVISION)
      expect(usage.snapshot.schemaVersion).toBe(1)
      expect(usage.snapshot.recommendedShapeTypes.length).toBeGreaterThan(0)
      expect(usage.role).toBe(usage.snapshot.defaultRole)
      expect(usage.snapshot.iconLightPath ?? usage.snapshot.iconDarkPath).toMatch(/^\/icons\//)
    }
    const postgres = usages.find((usage) => usage.snapshot.name === 'PostgreSQL')
    expect(postgres?.snapshot).toMatchObject({
      recommendedShapeTypes: ['store'],
      defaultRole: 'database',
    })
    for (const object of model.objects.filter((candidate) => candidate.technologyUsages)) {
      const [usageId] = Object.keys(object.technologyUsages!)
      expect(object.technologyUsageOrder).toEqual([usageId])
      expect(object.iconAssignment).toMatchObject({
        source: 'technology',
        mode: 'automatic',
        technologyUsageId: usageId,
        catalogRevision: SEEDED_TECHNOLOGY_CATALOG_REVISION,
      })
      expect(object.icon).toBe(object.technologyUsages![usageId].snapshot.name)
    }
  })

  it('contains no legacy technology fields', () => {
    for (const object of generateSeedModel().objects) {
      expect(object).not.toHaveProperty('technology')
      expect(object).not.toHaveProperty('technologies')
    }
  })
})
