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

// Regression: a user imported fixtures/saoe.dsl (their real workspace) and
// reported the views did not follow C4. On the component view of "Oracle Form"
// the person "Employé" was drawn although nothing connects it to a component,
// together with its edge to "fichiers Excels, PDF, Words" (a container of
// ANOTHER system), and "Database Oracle" / "PRIVE" sat on the canvas with no
// edge at all. The rule now is Structurizr's `include *`, at each view's level.

import { describe, expect, it } from 'vitest'
import { parseWorkspace } from './parser'
import { mapWorkspace } from './mapper'
import saoe from './fixtures/saoe.dsl?raw'
import bigBankJson from './fixtures/json/big-bank-plc.json?raw'
import { parseWorkspaceJson } from './json/parse'
import { mapWorkspace as mapJsonWorkspace } from './json/mapWorkspace'
import { DEFAULT_SHAPE_SIZE } from '../shapeDefaults'

let n = 0
const m = mapWorkspace(parseWorkspace(saoe), { idFactory: () => `id${++n}` })
const byName = (name: string) => {
  const found = m.objects.filter((o) => o.name === name)
  expect(found, name).toHaveLength(1)
  return found[0]
}
const view = (key: string) => {
  const d = m.diagrams.find((x) => x.sourceViewKey === key)
  expect(d, key).toBeDefined()
  return d!
}
const names = (key: string) => view(key).objectIds.map((id) => m.objects.find((o) => o.id === id)!.name).sort()

describe('C4 view scoping — component view (VuesDesFormulairesOracle)', () => {
  it('leaves out a person related only to the container, not to a component', () => {
    expect(names('VuesDesFormulairesOracle')).not.toContain('Employé')
  })

  it('leaves out containers related only to the focal container itself', () => {
    const shown = names('VuesDesFormulairesOracle')
    expect(shown).not.toContain('Database Oracle')
    expect(shown).not.toContain('PRIVE')
  })

  it("draws another system's container as its software system", () => {
    // `files -> activitybModule`: files lives in ssinsp, so the view draws ssinsp.
    const shown = names('VuesDesFormulairesOracle')
    expect(shown).not.toContain('fichiers Excels, PDF, Words')
    expect(shown).toContain("Système d'inspections en dehors de GAE")
  })

  it('keeps every component of the focal, inside the boundary', () => {
    const d = view('VuesDesFormulairesOracle')
    const oracle = byName('Oracle Form')
    const components = m.objects.filter((o) => o.parentId === oracle.id)
    expect(components).toHaveLength(11)
    for (const c of components) expect(d.objectIds).toContain(c.id)
    const boundary = m.groups.find((g) => g.id === d.groupIds[0])!
    expect(boundary.parentObjectId).toBe(oracle.id)
    expect([...boundary.objectIds].sort()).toEqual(components.map((c) => c.id).sort())
  })

  it('draws no edge from a box the view does not show', () => {
    const d = view('VuesDesFormulairesOracle')
    const onView = new Set(d.objectIds)
    for (const cid of d.connectionIds) {
      const c = m.connections.find((x) => x.id === cid)!
      expect(onView.has(c.fromId) && onView.has(c.toId)).toBe(true)
    }
  })
})

describe('C4 view scoping — context and container views', () => {
  it('a context view rolls container-level relationships up to their systems', () => {
    // Before: only Employé and Système GAE — `of -> repprivate`, `scripts -> db`
    // and `files -> activitybModule` connect GAE to three systems, all missing.
    expect(names('DiagramContextGAE')).toEqual(
      [
        'Employé',
        "Système d'inspections en dehors de GAE",
        "Système d'échantillonnage en dehors de GAE",
        'Système de répertoires partagés G',
        'Système GAE',
      ].sort(),
    )
  })

  it('a container view draws other systems, never their containers', () => {
    const shown = names('SAOEPermitContainers')
    expect(shown).toContain('AWS Infrastructure')
    expect(shown).toContain('Microsoft Power Platform SAOE')
    for (const container of ['AWS Queue Service', 'AWS Step function', 'Dataverse', 'Power Automate Flows']) {
      expect(shown).not.toContain(container)
    }
  })

  it('honours `exclude <identifier>`', () => {
    // `container powerPlatformSystem "FSContainers" { include * exclude fsMobile }`
    expect(names('FSContainers')).not.toContain("Application mobile d'inspection")
    const d = view('FSContainers')
    const boundary = m.groups.find((g) => g.id === d.groupIds[0])!
    expect(boundary.objectIds).not.toContain(byName("Application mobile d'inspection").id)
  })

  it('a component view draws containers of the same system as containers', () => {
    const shown = names('DataverseComponents')
    expect(shown).toContain('Power Automate Flows')
    expect(shown).toContain('SAOE Gestion Web')
    // Their components are not on a component view of another container.
    expect(shown).not.toContain('REQ Sync Flow')
    expect(shown).not.toContain('Offline Database')
  })
})

describe('imported shapes are the size of a shape drawn in the editor', () => {
  // Regression (user report, 2026-10-21): imported shapes were 150-200 × 90-100
  // depending on their type, while every shape the editor creates is 160 × 100,
  // so an imported diagram did not match what the user then drew on it.
  it('DSL: every C4 type', () => {
    const types = new Set(m.objects.map((o) => o.type))
    expect([...types].sort()).toEqual(['actor', 'app', 'component', 'store', 'system'])
    for (const o of m.objects) expect(o.size, `${o.type} ${o.name}`).toEqual(DEFAULT_SHAPE_SIZE)
  })

  it('JSON: every C4 type', () => {
    const mapped = mapJsonWorkspace(parseWorkspaceJson(bigBankJson))
    expect(mapped.objects.length).toBeGreaterThan(0)
    for (const o of mapped.objects) expect(o.size, `${o.type} ${o.name}`).toEqual(DEFAULT_SHAPE_SIZE)
  })
})

describe('C4 view scoping — explicit includes', () => {
  it('an explicit include list is the membership, which is what our exporter writes', () => {
    const dsl = `workspace {
      model {
        u = person "User"
        s = softwareSystem "S" {
          a = container "A"
          b = container "B"
        }
        u -> a "Uses"
        a -> b "Calls"
      }
      views {
        container s "Only" { include a b }
      }
    }`
    let k = 0
    const mm = mapWorkspace(parseWorkspace(dsl), { idFactory: () => `x${++k}` })
    const d = mm.diagrams[0]
    expect(d.objectIds.map((id) => mm.objects.find((o) => o.id === id)!.name).sort()).toEqual(['A', 'B'])
  })

  it('warns about expression forms it cannot evaluate instead of silently ignoring them', () => {
    const dsl = `workspace {
      model {
        s = softwareSystem "S" {
          a = container "A"
        }
      }
      views {
        container s { include * exclude "element.tag==Database" }
      }
    }`
    const mm = mapWorkspace(parseWorkspace(dsl))
    expect(mm.warnings.join('\n')).toMatch(/element\.tag==Database/)
  })
})
