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
import { buildDemoSeed } from './demoSeed'
import { DEMO_SEED } from '../../server/src/demoSeed.gen'

describe('the demo the server seeds', () => {
  it('is exactly what the client builds — regenerate with `cd server && npx tsx scripts/gen-demo-seed.ts`', () => {
    expect(DEMO_SEED).toEqual(buildDemoSeed())
  })

  it('is a usable workspace: every diagram draws from objects and connections the model holds', () => {
    const seed = buildDemoSeed()
    expect(Object.keys(seed.model.objects).length).toBeGreaterThan(0)
    expect(seed.diagrams.length).toBeGreaterThan(0)
    for (const { meta, doc } of seed.diagrams) {
      for (const id of meta.objectIds) expect(seed.model.objects[id], `${meta.id} → object ${id}`).toBeDefined()
      for (const id of meta.connectionIds) expect(seed.model.connections[id], `${meta.id} → connection ${id}`).toBeDefined()
      expect(doc.objectIds).toEqual(meta.objectIds)
    }
  })

  it('carries no `undefined` (Automerge rejects it, so the server write would throw)', () => {
    const walk = (value: unknown, path: string): void => {
      expect(value, path).not.toBeUndefined()
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`)
      }
    }
    walk(DEMO_SEED, 'DEMO_SEED')
  })
})
