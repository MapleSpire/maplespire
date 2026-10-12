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
import { parseWorkspace } from './parser'
import { mapWorkspace } from './mapper'
import { buildStructurizrDsl } from '../export/structurizr'
import type { ExportBundle } from '../export/types'

/**
 * Tags are the linchpin of Structurizr: element and relationship styles, themes
 * and filtered views all key on them. They used to be read once as heuristic
 * fodder for the datastore/external guesses and then discarded —
 * `tagAssignments: {}` / `tagOrder: []` — so a round trip lost every one of
 * them and re-emitted only the synthetic External/Internal pair.
 */
const DSL = `workspace "Tagged" {
    model {
        customer = person "Customer" "Buys things" "External,Persona"
        shop = softwareSystem "Shop" "The storefront" "Core,PCI-DSS" {
            web = container "Web" "UI" "React" "Frontend"
            db = container "Database" "Data" "PostgreSQL" "Datastore,PCI-DSS"
        }
        customer -> web "Browses" "HTTPS" "Public,Critical"
    }
    views {
        container shop "ShopContainers" {
            include *
            autoLayout
        }
    }
}`

const build = () => {
  let n = 0
  return mapWorkspace(parseWorkspace(DSL), { idFactory: () => `id${++n}` })
}

describe('DSL tags survive import', () => {
  it('mints a snapshot per distinct declared tag', () => {
    const values = build().tags.map((t) => t.value).sort()
    expect(values).toEqual(
      ['Core', 'Critical', 'Datastore', 'External', 'Frontend', 'PCI-DSS', 'Persona', 'Public'].sort(),
    )
  })

  it('does not duplicate a tag used on more than one element', () => {
    const pci = build().tags.filter((t) => t.value === 'PCI-DSS')
    expect(pci).toHaveLength(1)
  })

  it('assigns them to the objects that declared them, in declaration order', () => {
    const m = build()
    const valueOf = (id: string) => m.tags.find((t) => t.tagId === id)?.value
    const shop = m.objects.find((o) => o.name === 'Shop')!
    expect(shop.tagOrder.map(valueOf)).toEqual(['Core', 'PCI-DSS'])
    // The assignment map and the order must agree — the order drives which tag
    // colours a shape.
    expect(Object.keys(shop.tagAssignments).sort()).toEqual([...shop.tagOrder].sort())
  })

  it('assigns relationship tags too', () => {
    const m = build()
    const valueOf = (id: string) => m.tags.find((t) => t.tagId === id)?.value
    const conn = m.connections.find((c) => c.label === 'Browses')!
    expect((conn.tagOrder ?? []).map(valueOf)).toEqual(['Public', 'Critical'])
  })

  it('keeps ids deterministic so a second import does not fork the registry', () => {
    expect(build().tags.map((t) => t.tagId)).toEqual(build().tags.map((t) => t.tagId))
    expect(build().tags.find((t) => t.value === 'PCI-DSS')?.tagId).toBe('tag-szr-pci-dss')
  })

  it('still uses tags for the scope and datastore heuristics', () => {
    const m = build()
    // Carrying the tag as real data must not stop it informing the mapping.
    expect(m.objects.find((o) => o.name === 'Customer')?.scope).toBe('external')
    expect(m.objects.find((o) => o.name === 'Database')?.type).toBe('store')
  })
})

describe('DSL tags survive export', () => {
  const bundle = (): ExportBundle => {
    const m = build()
    return {
      landscapeName: 'Tagged',
      generatedAt: '2026-08-08T00:00:00.000Z',
      diagrams: m.diagrams,
      activeDiagramId: m.entryDiagramId,
      flowsByDiagram: {},
      objects: m.objects,
      connections: m.connections,
      groups: m.groups,
      domains: [],
      tags: m.tags,
      decisionRecords: [],
    }
  }

  it('re-emits the tags the workspace came in with', () => {
    const dsl = buildStructurizrDsl(bundle())
    expect(dsl).toContain('Core')
    expect(dsl).toContain('PCI-DSS')
    expect(dsl).toContain('Frontend')
    expect(dsl).toContain('Persona')
  })

  it('round-trips a tag back onto the same element', () => {
    const reparsed = mapWorkspace(parseWorkspace(buildStructurizrDsl(bundle())), {
      idFactory: (() => { let n = 0; return () => `r${++n}` })(),
    })
    const valueOf = (id: string) => reparsed.tags.find((t) => t.tagId === id)?.value
    const shop = reparsed.objects.find((o) => o.name === 'Shop')!
    expect(shop.tagOrder.map(valueOf)).toContain('PCI-DSS')
    expect(shop.tagOrder.map(valueOf)).toContain('Core')
  })
})
