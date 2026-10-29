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

// Regression: a user imported fixtures/saoe.dsl (their real workspace). Its five
// `dynamic` views were dropped with a warning, and `employeeVille -> saoeWeb`,
// declared three times with three descriptions, came out as ONE connection
// wearing the first label. The JSON importer already did both right; the DSL
// importer is held to the same result here.

import { describe, expect, it } from 'vitest'
import type { MessageStep } from '../../types'
import { parseWorkspace } from './parser'
import { mapWorkspace } from './mapper'
import { parseWorkspaceJson } from './json/parse'
import { mapWorkspace as mapJsonWorkspace } from './json/mapWorkspace'
import saoe from './fixtures/saoe.dsl?raw'
import bigBankDsl from './fixtures/big-bank-plc.dsl?raw'
import bigBankJson from './fixtures/json/big-bank-plc.json?raw'

let n = 0
const m = mapWorkspace(parseWorkspace(saoe), { idFactory: () => `id${++n}` })
const nameOf = (id: string) => m.objects.find((o) => o.id === id)?.name
const flow = (name: string) => {
  const found = m.flows.find((f) => f.name === name)
  expect(found, name).toBeDefined()
  return found!
}
/** `from -> to : title` per step, the shape a reader checks a flow by. */
const walk = (name: string) =>
  (flow(name).steps as MessageStep[]).map((s) => `${nameOf(s.fromObjectId)} -> ${nameOf(s.toObjectId)} : ${s.title}`)

describe('saoe.dsl — parallel relationships', () => {
  it('keeps every description of employeeVille -> saoeWeb as its own connection', () => {
    const employe = m.objects.find((o) => o.name === 'Employé')!
    const web = m.objects.find((o) => o.name === 'SAOE Gestion Web')!
    const labels = m.connections.filter((c) => c.fromId === employe.id && c.toId === web.id).map((c) => c.label)
    expect(labels).toEqual([
      "consulte les données reliées à l'établissement",
      'traite les demandes de permis',
      'saisie les plaintes',
    ])
  })

  it('draws the parallel connections on a view that shows both ends', () => {
    const employe = m.objects.find((o) => o.name === 'Employé')!
    const web = m.objects.find((o) => o.name === 'SAOE Gestion Web')!
    const parallel = m.connections.filter((c) => c.fromId === employe.id && c.toId === web.id).map((c) => c.id)
    const showing = m.diagrams.filter((d) => d.objectIds.includes(employe.id) && d.objectIds.includes(web.id) && !m.flows.some((f) => f.diagramId === d.id))
    expect(showing.length).toBeGreaterThan(0)
    for (const d of showing) for (const id of parallel) expect(d.connectionIds, d.name).toContain(id)
  })

  it('still collapses an exact repeat (same ends, same description)', () => {
    const dsl = `workspace { model {
      a = person "A"
      b = softwareSystem "B"
      a -> b "uses"
      a -> b "uses"
      a -> b "administers"
    } }`
    const mapped = mapWorkspace(parseWorkspace(dsl))
    expect(mapped.connections.map((c) => c.label)).toEqual(['uses', 'administers'])
  })
})

describe('saoe.dsl — dynamic views become flows', () => {
  it('imports all five dynamic views, each on its own diagram', () => {
    expect(m.flows.map((f) => f.name)).toEqual([
      'InspectionFlow',
      'SynchronizationFlow',
      'EnterpriseFlow',
      'IncidentFlow',
      'MobileOfflineFlow',
    ])
    for (const f of m.flows) {
      const d = m.diagrams.find((x) => x.id === f.diagramId)
      expect(d, f.name).toBeDefined()
      expect(d!.sourceViewKey).toBe(f.name)
    }
    expect(m.warnings.join(' ')).not.toMatch(/dynamic/i)
  })

  it('keeps the commented-out steps out and the step descriptions verbatim (EnterpriseFlow)', () => {
    expect(walk('EnterpriseFlow')).toEqual([
      'Employé -> SAOE Gestion Web : Saisie un nouvel établissement (Module Entreprise)',
      "Employé -> SAOE Gestion Web : Met à jour une adresse, un contact d'un établissement",
      "Employé -> SAOE Gestion Web : Consulte les données reliées à l'établissement",
      "Inspecteur -> SAOE Gestion Web : Consulte les données reliées à l'établissement",
      'SAOE Gestion Web -> Dataverse : Crée/Met à jour un Compte (via API)',
      'Power Automate Flows -> Dataverse : Déclenche flux pour obtenir les données du REQ (sur création)',
    ])
  })

  it('imports every step of the other four flows, in file order', () => {
    expect(walk('InspectionFlow')).toEqual([
      'Inspecteur -> SAOE Gestion Web : Modifie la planification',
      'Répartiteur -> SAOE Gestion Web : Planifie le travail',
      'Power Automate Flows -> Dataverse : Crée/Met à jour entités',
      'Dataverse -> SharePoint Online : Contient les documents sur les entreprises et établissement',
      'SAOE Gestion Web -> Dataverse : CRUD opérations',
    ])
    expect(walk('SynchronizationFlow')).toHaveLength(11)
    expect(walk('SynchronizationFlow')[7]).toBe('Power Automate Flows -> Dataverse : 8. Upsert account')
    expect(walk('IncidentFlow')).toEqual([
      'Employé -> SAOE Gestion Web : Saisie nouvelle plainte (Module Plainte)',
      'SAOE Gestion Web -> Dataverse : Crée incident (via API)',
      'Power Automate Flows -> Dataverse : Déclenche flux SLA (sur création)',
      'Power Automate Flows -> Inspecteur : Notifie réception (Courriel)',
      'Inspecteur -> SAOE Gestion Web : Consulte les données de la plainte',
    ])
    expect(walk('MobileOfflineFlow')).toEqual([
      "Inspecteur -> Application mobile d'inspection : 1. Ouvre app mobile (mode offline)",
      "Inspecteur -> Application mobile d'inspection : 2. Consulte entreprises/bâtiments (cache local SQLite)",
      "Inspecteur -> Application mobile d'inspection : 4. Crée/modifie ordre de travail (sauvegarde locale)",
      "Inspecteur -> Application mobile d'inspection : 5. Se reconnecte au réseau WiFi/4G",
      "Application mobile d'inspection -> Dataverse : 6. Synchronisation bidirectionnelle des données",
      "Dataverse -> Application mobile d'inspection : 7. Télécharge nouvelles données et documents",
      "Application mobile d'inspection -> Inspecteur : 8. Notifie synchronisation terminée",
    ])
  })

  it('resolves a step to the parallel relationship whose description it repeats', () => {
    // `inspecteur -> saoeWeb "Modifie la planification"` in InspectionFlow is
    // the model relationship of the same words, not merely the first one.
    const step = (flow('InspectionFlow').steps as MessageStep[])[0]!
    expect(m.connections.find((c) => c.id === step.connectionId)!.label).toBe('Modifie la planification')
    const twoOfThree = flow('EnterpriseFlow').steps as MessageStep[]
    const conn = m.connections.find((c) => c.id === twoOfThree[2]!.connectionId)!
    expect([nameOf(conn.fromId), nameOf(conn.toId)]).toEqual(['Employé', 'SAOE Gestion Web'])
  })

  it('walks a reverse-only relationship backwards (fsMobile -> inspecteur)', () => {
    const last = (flow('MobileOfflineFlow').steps as MessageStep[]).at(-1)!
    const conn = m.connections.find((c) => c.id === last.connectionId)!
    expect([nameOf(conn.fromId), nameOf(conn.toId)]).toEqual(['Inspecteur', "Application mobile d'inspection"])
    expect([nameOf(last.fromObjectId), nameOf(last.toObjectId)]).toEqual(["Application mobile d'inspection", 'Inspecteur'])
  })

  it('mints the implied powerAutomate -> inspecteur on the flow diagram only', () => {
    // Only complaintSLAFlow (a component of powerAutomate) -> inspecteur exists;
    // Structurizr implies the container-level relationship.
    const step = (flow('IncidentFlow').steps as MessageStep[])[3]!
    const implied = m.connections.find((c) => c.id === step.connectionId)!
    expect(implied.label).toBe('Notifie (Courriel)')
    const holders = m.diagrams.filter((d) => d.connectionIds.includes(implied.id)).map((d) => d.name)
    expect(holders).toEqual(['IncidentFlow'])
  })

  it('composes each flow diagram from exactly its participants and step edges', () => {
    for (const f of m.flows) {
      const d = m.diagrams.find((x) => x.id === f.diagramId)!
      const steps = f.steps as MessageStep[]
      expect(new Set(d.objectIds), f.name).toEqual(new Set(steps.flatMap((s) => [s.fromObjectId, s.toObjectId])))
      expect(new Set(d.connectionIds), f.name).toEqual(new Set(steps.map((s) => s.connectionId)))
      expect(d.type, f.name).toBe('container')
    }
  })
})

describe('dynamic views — DSL syntax', () => {
  const base = `
    workspace { model {
      u = person "U"
      s = softwareSystem "S" {
        a = container "A"
        b = container "B"
      }
      u -> a "uses"
      a -> b "calls"
    }
    views {
      dynamic s "D" "desc" {
        STEPS
        autoLayout lr
      }
    } }`
  const run = (steps: string) => mapWorkspace(parseWorkspace(base.replace('STEPS', steps)))
  const titles = (r: ReturnType<typeof run>) => r.flows[0]!.steps.map((s) => s.title)

  it('sorts by explicit `n:` order, numerically per segment', () => {
    const r = run(`2: a -> b "second"\n1.10: u -> a "after nine"\n1.9: u -> a "nine"`)
    expect(titles(r)).toEqual(['nine', 'after nine', 'second'])
  })

  it('flattens a parallel `{ }` block into file order, and says so', () => {
    const r = run(`u -> a "first"\n{\n  a -> b "inner"\n}\na -> b "last"`)
    expect(titles(r)).toEqual(['first', 'inner', 'last'])
    expect(r.warnings.some((w) => /parallel/i.test(w))).toBe(true)
  })

  it('falls back to the relationship label when the step has no description', () => {
    expect(titles(run('u -> a'))).toEqual(['uses'])
  })

  it('names a step no relationship explains instead of inventing one', () => {
    const r = run(`u -> a "ok"\nu -> b "nothing"`)
    expect(titles(r)).toEqual(['ok'])
    expect(r.warnings.some((w) => w.includes('u -> b'))).toBe(true)
  })

  it('carries the view autoLayout direction as a layout hint', () => {
    const r = run('u -> a')
    expect(r.layoutHints[r.flows[0]!.diagramId]).toEqual({ direction: 'lr' })
  })
})

describe('dynamic views — parity with the JSON importer (Big Bank SignIn)', () => {
  const dsl = mapWorkspace(parseWorkspace(bigBankDsl))
  const json = mapJsonWorkspace(parseWorkspaceJson(bigBankJson))
  const describeFlow = (r: typeof dsl | typeof json) =>
    (r.flows[0]!.steps as MessageStep[]).map((s) => {
      const name = (id: string) => r.objects.find((o) => o.id === id)!.name
      const c = r.connections.find((x) => x.id === s.connectionId)!
      return `${name(s.fromObjectId)} -> ${name(s.toObjectId)} : ${s.title} [${name(c.fromId)} -> ${name(c.toId)}]`
    })

  it('produces the same flow, step for step, over the same edges', () => {
    expect(dsl.flows).toHaveLength(1)
    expect(dsl.flows[0]!.name).toBe(json.flows[0]!.name)
    expect(describeFlow(dsl)).toEqual(describeFlow(json))
  })
})
