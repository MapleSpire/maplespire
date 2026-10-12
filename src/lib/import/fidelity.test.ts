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

// The harness is only worth anything if it FAILS on a broken import, so every
// test here starts from a result that reproduces a real corpus file exactly,
// proves the report is clean, then damages one specific thing and demands the
// report name that thing. A report that stays clean after the damage is the
// failure mode this file exists to prevent.

import { describe, expect, it } from 'vitest'

import type { C4Object, C4Type, Connection, Diagram, Group } from '../../types'
import type { ImportResult } from './types'
import { formatFidelityReport, measureFidelity } from './fidelity'
import type { SzElement, SzElementKind, SzRelationship, SzView, SzViewKind, SzWorkspace } from '../structurizr/json/types'

import bigBankJson from '../structurizr/fixtures/json/big-bank-plc.json'
import bigRealJson from '../structurizr/fixtures/json/big-real-workspace.json'
import deploymentPositionedJson from '../structurizr/fixtures/json/deployment-positioned.json'
import groupsJson from '../structurizr/fixtures/json/groups.json'
import withoutOrderJson from '../structurizr/fixtures/json/views-without-order.json'

// ── A minimal fixture reader ─────────────────────────────────────────────────
// Deliberately NOT the production parser: this file must be able to run before
// (and independently of) `parse.ts`, and a fidelity harness validated against
// the parser it is meant to police would be measuring agreement, not fidelity.
// It reads only the fields the report consumes.

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

const asStringMap = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (typeof raw === 'string') out[key] = raw
  }
  return out
}

const VIEW_COLLECTIONS: Record<string, SzViewKind> = {
  systemLandscapeViews: 'systemLandscape',
  systemContextViews: 'systemContext',
  containerViews: 'container',
  componentViews: 'component',
  dynamicViews: 'dynamic',
  deploymentViews: 'deployment',
  filteredViews: 'filtered',
  imageViews: 'image',
  customViews: 'custom',
}

function readWorkspace(raw: unknown): SzWorkspace {
  const root = asRecord(raw)
  const model = asRecord(root.model)
  const elements: SzElement[] = []
  const relationships: SzRelationship[] = []

  const take = (node: unknown, kind: SzElementKind, parentId?: string): string => {
    const record = asRecord(node)
    const id = asString(record.id) ?? ''
    elements.push({
      id,
      kind,
      name: asString(record.name) ?? '',
      description: asString(record.description),
      technology: asString(record.technology),
      tags: [],
      styleTags: [],
      group: asString(record.group),
      properties: asStringMap(record.properties),
      perspectives: [],
      parentId,
      instanceOfId: asString(record.containerId) ?? asString(record.softwareSystemId),
      deploymentGroups: [],
    })
    for (const edge of asArray(record.relationships)) {
      const rel = asRecord(edge)
      relationships.push({
        id: asString(rel.id) ?? '',
        sourceId: asString(rel.sourceId) ?? id,
        destinationId: asString(rel.destinationId) ?? '',
        description: asString(rel.description),
        technology: asString(rel.technology),
        tags: [],
        styleTags: [],
        properties: asStringMap(rel.properties),
        linkedRelationshipId: asString(rel.linkedRelationshipId),
      })
    }
    return id
  }

  for (const person of asArray(model.people)) take(person, 'person')
  for (const custom of asArray(model.customElements)) take(custom, 'customElement')
  for (const system of asArray(model.softwareSystems)) {
    const systemId = take(system, 'softwareSystem')
    for (const container of asArray(asRecord(system).containers)) {
      const containerId = take(container, 'container', systemId)
      for (const component of asArray(asRecord(container).components)) {
        take(component, 'component', containerId)
      }
    }
  }
  const walkNode = (node: unknown, parentId?: string) => {
    const id = take(node, 'deploymentNode', parentId)
    const record = asRecord(node)
    for (const child of asArray(record.children)) walkNode(child, id)
    for (const infra of asArray(record.infrastructureNodes)) take(infra, 'infrastructureNode', id)
    for (const instance of asArray(record.containerInstances)) take(instance, 'containerInstance', id)
    for (const instance of asArray(record.softwareSystemInstances)) take(instance, 'softwareSystemInstance', id)
  }
  for (const node of asArray(model.deploymentNodes)) walkNode(node)

  // Instances have no name of their own — resolve the label the customer sees.
  const nameById = new Map(elements.map((e) => [e.id, e.name]))
  for (const element of elements) {
    if (!element.name && element.instanceOfId) {
      element.name = `${nameById.get(element.instanceOfId) ?? 'instance'} [${element.id}]`
    }
  }

  const views: SzView[] = []
  for (const [collection, kind] of Object.entries(VIEW_COLLECTIONS)) {
    for (const entry of asArray(asRecord(root.views)[collection])) {
      const view = asRecord(entry)
      views.push({
        kind,
        key: asString(view.key) ?? '',
        scopeId: asString(view.softwareSystemId) ?? asString(view.containerId),
        title: asString(view.title),
        description: asString(view.description),
        order: asNumber(view.order),
        environment: asString(view.environment),
        baseViewKey: asString(view.baseViewKey),
        filterTags: [],
        elements: asArray(view.elements).map((raw) => {
          const member = asRecord(raw)
          return { id: asString(member.id) ?? '', x: asNumber(member.x), y: asNumber(member.y) }
        }),
        relationships: asArray(view.relationships).map((raw) => {
          const member = asRecord(raw)
          return {
            id: asString(member.id) ?? '',
            order: asString(member.order),
            description: asString(member.description),
            response: member.response === true,
            vertices: [],
          }
        }),
        automaticLayout: asRecord(view.automaticLayout).rankDirection !== undefined ? {} : undefined,
      })
    }
  }

  return {
    name: asString(root.name) ?? '',
    description: asString(root.description),
    groupSeparator: asStringMap(asRecord(model.properties))['structurizr.groupSeparator'],
    elements,
    relationships,
    views,
    elementStyles: [],
    relationshipStyles: [],
    themes: [],
    warnings: [],
  }
}

// ── A reference-faithful import ──────────────────────────────────────────────
// One object per element, one connection per relationship, one diagram per view
// carrying exactly the view's membership and the file's coordinates. Every test
// below damages a copy of this.

const TYPE_BY_KIND: Record<SzElementKind, C4Type> = {
  person: 'actor',
  softwareSystem: 'system',
  container: 'app',
  component: 'component',
  deploymentNode: 'app',
  infrastructureNode: 'app',
  containerInstance: 'app',
  softwareSystemInstance: 'system',
  customElement: 'system',
}

const objectIdFor = (elementId: string) => `obj-${elementId}`
const groupIdFor = (name: string) => `grp-${name.replace(/\W+/g, '-').toLowerCase()}`

function groupNamesOf(ws: SzWorkspace): string[] {
  const names = new Set<string>()
  for (const element of ws.elements) {
    const raw = element.group?.trim()
    if (!raw) continue
    if (ws.groupSeparator) {
      for (const part of raw.split(ws.groupSeparator)) if (part.trim()) names.add(part.trim())
    } else names.add(raw)
  }
  return [...names]
}

function buildFaithfulResult(ws: SzWorkspace): ImportResult {
  const known = new Set(ws.elements.map((e) => e.id))

  const objects: C4Object[] = ws.elements.map((element) => ({
    id: objectIdFor(element.id),
    type: TYPE_BY_KIND[element.kind],
    name: element.name,
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    parentId: element.parentId ? objectIdFor(element.parentId) : undefined,
    tagAssignments: {},
    tagOrder: [],
    scope: 'internal',
    status: 'live',
    properties: { 'structurizr.id': element.id },
  }))

  const groups: Group[] = groupNamesOf(ws).map((name) => ({
    id: groupIdFor(name),
    name,
    color: '#888888',
    objectIds: [],
    tagAssignments: {},
    tagOrder: [],
  }))

  const connections: Connection[] = ws.relationships
    .filter((rel) => known.has(rel.sourceId) && known.has(rel.destinationId))
    .map((rel) => ({
      id: `con-${rel.id}`,
      fromId: objectIdFor(rel.sourceId),
      toId: objectIdFor(rel.destinationId),
      label: rel.description,
      type: 'solid' as const,
    }))

  const diagrams: Diagram[] = ws.views.map((view) => {
    const members = view.elements.filter((m) => known.has(m.id))
    const layouts: Record<string, { position: { x: number; y: number }; size: { width: number; height: number } }> = {}
    for (const member of members) {
      layouts[objectIdFor(member.id)] = {
        position: { x: member.x ?? 0, y: member.y ?? 0 },
        size: { width: 200, height: 100 },
      }
    }
    return {
      id: `dia-${view.key}`,
      name: view.title ?? view.key,
      type: 'context',
      objectIds: members.map((m) => objectIdFor(m.id)),
      // A dynamic view names the same relationship once per step (T9); the
      // diagram carries the connection once.
      connectionIds: [...new Set(view.relationships.map((r) => `con-${r.id}`))],
      groupIds: [],
      sourceViewKey: view.key,
      layouts,
    }
  })

  return {
    objects,
    connections,
    groups,
    tags: [],
    diagrams,
    entryDiagramId: diagrams[0]?.id ?? null,
    warnings: [],
    stats: {
      objects: objects.length,
      connections: connections.length,
      groups: groups.length,
      diagrams: diagrams.length,
      byLevel: { context: diagrams.length, container: 0, component: 0 },
    },
  }
}

const bigBank = readWorkspace(bigBankJson)
const bigReal = readWorkspace(bigRealJson)
const deploymentPositioned = readWorkspace(deploymentPositionedJson)
const grouped = readWorkspace(groupsJson)
const withoutOrder = readWorkspace(withoutOrderJson)

const damage = (ws: SzWorkspace, mutate: (result: ImportResult) => void): ImportResult => {
  const result = structuredClone(buildFaithfulResult(ws))
  mutate(result)
  return result
}

const elementNamed = (ws: SzWorkspace, name: string): SzElement => {
  const found = ws.elements.find((e) => e.name === name)
  if (!found) throw new Error(`fixture changed: no element named ${name}`)
  return found
}

const diagramFor = (result: ImportResult, key: string): Diagram => {
  const found = result.diagrams.find((d) => d.sourceViewKey === key)
  if (!found) throw new Error(`fixture changed: no diagram for view ${key}`)
  return found
}

// ── Baselines ────────────────────────────────────────────────────────────────

describe('a result that reproduces the file exactly', () => {
  it('reports no loss anywhere for the canonical big-bank workspace', () => {
    const report = measureFidelity(bigBank, buildFaithfulResult(bigBank))

    expect(report.elements.missing).toEqual([])
    expect(report.elements.matched).toBe(bigBank.elements.length)
    expect(report.elements.unexplainedTargets).toEqual([])
    expect(report.relationships.authored.missing).toEqual([])
    expect(report.relationships.derived.missing).toEqual([])
    expect(report.relationships.unexplainedConnectionIds).toEqual([])
    expect(report.views.missing).toEqual([])
    expect(report.viewMembership.viewsWithLoss).toBe(0)
    expect(report.viewMembership.presentTotal).toBe(report.viewMembership.expectedTotal)
    expect(report.viewMembership.presentRelationshipTotal).toBe(report.viewMembership.expectedRelationshipTotal)
    expect(report.viewMembership.expectedRelationshipTotal).toBeGreaterThan(0)
    expect(report.labels.elementNames.changed).toEqual([])
    expect(report.labels.relationshipDescriptions.vanished).toEqual([])
  })

  it('separates the 15 derived edges from the 27 the author wrote', () => {
    const report = measureFidelity(bigBank, buildFaithfulResult(bigBank))

    expect(report.relationships.derived.expected).toBe(15)
    expect(report.relationships.authored.expected).toBe(27)
    expect(report.relationships.authored.expected + report.relationships.derived.expected).toBe(
      bigBank.relationships.length,
    )
  })

  it('calls every big-bank view unpositioned rather than preserved, because 67/67 coordinates are (0,0)', () => {
    const report = measureFidelity(bigBank, buildFaithfulResult(bigBank))

    // T10(b): all-zero means no layout was ever computed. Reading those as real
    // coordinates would report a stack-at-the-origin import as "preserved".
    expect(report.layout.preserved).toBe(0)
    expect(report.layout.relaidOut).toBe(0)
    expect(report.layout.sourceUnpositioned).toBe(bigBank.views.length)
  })

  it('treats an absent x/y as unpositioned rather than as the origin', () => {
    const report = measureFidelity(withoutOrder, buildFaithfulResult(withoutOrder))

    expect(report.views.matched).toBe(2)
    expect(report.layout.details.every((d) => d.classification === 'source-unpositioned')).toBe(true)
    expect(report.layout.details.every((d) => d.comparableInSource === 0)).toBe(true)
  })

  it('reports the real workspace as laid out, with the deployment boundaries excluded', () => {
    const report = measureFidelity(bigReal, buildFaithfulResult(bigReal))

    const live = report.layout.details.find((d) => d.key === 'LiveDeployment')
    // T10(c): 13 of the 20 members sit at (0,0) and every one is a deployment
    // node whose geometry comes from its children — real coordinates surround them.
    expect(live?.derivedBoundaries).toBe(13)
    expect(live?.comparableInSource).toBe(7)
    expect(live?.classification).toBe('preserved')
    expect(report.layout.preserved).toBe(6)
    expect(report.layout.relaidOut).toBe(0)
  })
})

// ── Elements ─────────────────────────────────────────────────────────────────

describe('an import that lost model elements', () => {
  it('names the element that never arrived, and the kind tally it came from', () => {
    const mainframe = elementNamed(bigBank, 'Mainframe Banking System')
    const result = damage(bigBank, (r) => {
      r.objects = r.objects.filter((o) => o.id !== objectIdFor(mainframe.id))
    })

    const report = measureFidelity(bigBank, result)

    expect(report.elements.missing).toContainEqual({
      id: mainframe.id,
      name: 'Mainframe Banking System',
      kind: 'softwareSystem',
    })
    expect(report.elements.byKind.softwareSystem?.missingIds).toEqual([mainframe.id])
    expect(report.elements.matched).toBe(bigBank.elements.length - 1)
  })

  it('blames a lost endpoint for its edges instead of reporting them as separate losses', () => {
    const mainframe = elementNamed(bigBank, 'Mainframe Banking System')
    const result = damage(bigBank, (r) => {
      r.objects = r.objects.filter((o) => o.id !== objectIdFor(mainframe.id))
      r.connections = r.connections.filter(
        (c) => c.fromId !== objectIdFor(mainframe.id) && c.toId !== objectIdFor(mainframe.id),
      )
    })

    const report = measureFidelity(bigBank, result)
    const touching = [...report.relationships.authored.missing, ...report.relationships.derived.missing]

    expect(touching.length).toBeGreaterThan(0)
    expect(touching.every((m) => m.reason === 'endpoint-missing')).toBe(true)
  })

  it('names shapes the import invented that no element in the file explains', () => {
    const result = damage(bigBank, (r) => {
      r.objects.push({
        ...r.objects[0]!,
        id: 'obj-invented',
        name: 'Helpful Extra Box',
        properties: {},
      })
    })

    const report = measureFidelity(bigBank, result)

    expect(report.elements.unexplainedTargets).toEqual([
      { id: 'obj-invented', name: 'Helpful Extra Box', kind: 'object' },
    ])
  })

  it('flags correlation as a guess, and refuses to guess at all, when the import stamped no source id', () => {
    const result = damage(bigBank, (r) => {
      for (const object of r.objects) object.properties = {}
    })

    const report = measureFidelity(bigBank, result)

    // Names mostly line up, so the elements are still found — but a name match
    // must not be presented as the same evidence as a stamped id.
    expect(report.elements.matchedBy['source-id']).toBeUndefined()
    expect(report.elements.weaklyMatchedIds.length).toBe(report.elements.matched)

    // And where names are ambiguous the harness reports "I do not know" instead
    // of pairing arbitrarily: big-bank has two deployment nodes both named
    // "Big Bank plc" (one per environment) with identical parent paths.
    expect(report.elements.missing.map((m) => m.name)).toEqual(['Big Bank plc', 'Big Bank plc'])
    expect(report.elements.unexplainedTargets.map((t) => t.name)).toEqual(['Big Bank plc', 'Big Bank plc'])
  })
})

// ── Relationships ────────────────────────────────────────────────────────────

describe('an import that lost relationships', () => {
  it('names a dropped authored edge with both endpoints and its label', () => {
    const authored = bigBank.relationships.find((r) => !r.linkedRelationshipId && r.description)!
    const result = damage(bigBank, (r) => {
      r.connections = r.connections.filter((c) => c.id !== `con-${authored.id}`)
    })

    const report = measureFidelity(bigBank, result)

    expect(report.relationships.authored.missing).toContainEqual({
      id: authored.id,
      sourceId: authored.sourceId,
      destinationId: authored.destinationId,
      description: authored.description,
      reason: 'no-connection',
    })
    expect(report.relationships.derived.missing).toEqual([])
  })

  it('keeps a decision to drop derived edges out of the authored tally', () => {
    const derivedIds = new Set(
      bigBank.relationships.filter((r) => r.linkedRelationshipId).map((r) => `con-${r.id}`),
    )
    const result = damage(bigBank, (r) => {
      r.connections = r.connections.filter((c) => !derivedIds.has(c.id))
    })

    const report = measureFidelity(bigBank, result)

    expect(report.relationships.derived.missing.length).toBe(15)
    expect(report.relationships.authored.missing).toEqual([])
    expect(report.relationships.authored.matched).toBe(27)
  })

  it('reports an edge whose direction was flipped, rather than calling it missing and invented', () => {
    const authored = bigBank.relationships.find((r) => !r.linkedRelationshipId)!
    const result = damage(bigBank, (r) => {
      const connection = r.connections.find((c) => c.id === `con-${authored.id}`)!
      const { fromId, toId } = connection
      connection.fromId = toId
      connection.toId = fromId
    })

    const report = measureFidelity(bigBank, result)
    const missing = report.relationships.authored.missing.find((m) => m.id === authored.id)

    expect(missing?.reason).toBe('reversed')
    expect(report.relationships.unexplainedConnectionIds).not.toContain(`con-${authored.id}`)
  })

  it('names arrows the import invented', () => {
    const result = damage(bigBank, (r) => {
      r.connections.push({ ...r.connections[0]!, id: 'con-invented', label: 'Whispers to' })
    })

    const report = measureFidelity(bigBank, result)

    expect(report.relationships.unexplainedConnectionIds).toEqual(['con-invented'])
  })
})

// ── Views and membership ─────────────────────────────────────────────────────

describe('an import that lost views', () => {
  it('names the dropped view and the kind it was', () => {
    const result = damage(bigBank, (r) => {
      r.diagrams = r.diagrams.filter((d) => d.sourceViewKey !== 'SignIn')
    })

    const report = measureFidelity(bigBank, result)

    expect(report.views.missing).toContainEqual(
      expect.objectContaining({ key: 'SignIn', kind: 'dynamic' }),
    )
    expect(report.views.droppedByKind.dynamic).toBe(1)
    expect(report.layout.notImported).toBe(1)
  })

  it('credits a diagram matched only by title, and says the match was a guess', () => {
    const result = damage(bigBank, (r) => {
      const diagram = diagramFor(r, 'Containers')
      diagram.name = bigBank.views.find((v) => v.key === 'Containers')?.title ?? 'Containers'
      delete diagram.sourceViewKey
    })

    const report = measureFidelity(bigBank, result)

    expect(report.views.missing).toEqual([])
    expect(report.views.weaklyMatchedKeys).toEqual(['Containers'])
  })
})

describe('an import where the model is complete but a diagram is subtly wrong', () => {
  it('catches an element missing from one view even though every element and edge arrived', () => {
    const database = elementNamed(bigBank, 'Database')
    const result = damage(bigBank, (r) => {
      const containers = diagramFor(r, 'Containers')
      containers.objectIds = containers.objectIds.filter((id) => id !== objectIdFor(database.id))
    })

    const report = measureFidelity(bigBank, result)

    // The three headline numbers a shallow harness reports are all perfect here.
    expect(report.elements.missing).toEqual([])
    expect(report.relationships.authored.missing).toEqual([])
    expect(report.views.missing).toEqual([])

    const containers = report.viewMembership.details.find((d) => d.key === 'Containers')
    expect(containers?.missing).toEqual([{ id: database.id, name: 'Database', kind: 'container' }])
    expect(report.viewMembership.viewsWithLoss).toBe(1)
    expect(report.viewMembership.presentTotal).toBe(report.viewMembership.expectedTotal - 1)
  })

  it('catches a diagram that kept every box and drew none of the arrows', () => {
    const signIn = bigBank.views.find((v) => v.key === 'SignIn')!
    const result = damage(bigBank, (r) => {
      diagramFor(r, 'SignIn').connectionIds = []
    })

    const report = measureFidelity(bigBank, result)
    const view = report.viewMembership.details.find((d) => d.key === 'SignIn')

    expect(report.relationships.authored.missing).toEqual([])
    expect(view?.missing).toEqual([])
    expect(view?.missingRelationshipIds).toEqual([...new Set(signIn.relationships.map((r) => r.id))])
    expect(view?.presentRelationships).toBe(0)
    expect(report.viewMembership.viewsWithLoss).toBe(1)
  })

  it('counts a repeated dynamic step once, because the diagram can only hold the edge once', () => {
    const signIn = bigBank.views.find((v) => v.key === 'SignIn')!
    const report = measureFidelity(bigBank, buildFaithfulResult(bigBank))
    const view = report.viewMembership.details.find((d) => d.key === 'SignIn')

    // T9: SignIn lists ids 32,40,44,44,40,32 — request and response steps.
    expect(signIn.relationships.length).toBeGreaterThan(new Set(signIn.relationships.map((r) => r.id)).size)
    expect(view?.expectedRelationships).toBe(new Set(signIn.relationships.map((r) => r.id)).size)
    expect(view?.missingRelationshipIds).toEqual([])
  })

  it('names an element the import added to a view the file never listed on it', () => {
    const customer = elementNamed(bigBank, 'Personal Banking Customer')
    const result = damage(bigBank, (r) => {
      diagramFor(r, 'Components').objectIds.push(objectIdFor(customer.id))
    })

    const report = measureFidelity(bigBank, result)
    const components = report.viewMembership.details.find((d) => d.key === 'Components')

    expect(components?.extra).toEqual([
      { id: objectIdFor(customer.id), name: 'Personal Banking Customer' },
    ])
    expect(components?.missing).toEqual([])
  })

  it('counts a view that was not imported at all as a membership loss too', () => {
    const result = damage(bigBank, (r) => {
      r.diagrams = r.diagrams.filter((d) => d.sourceViewKey !== 'Containers')
    })

    const report = measureFidelity(bigBank, result)
    const containers = report.viewMembership.details.find((d) => d.key === 'Containers')

    expect(containers?.present).toBe(0)
    expect(containers?.expected).toBeGreaterThan(0)
    expect(report.viewMembership.presentTotal).toBeLessThan(report.viewMembership.expectedTotal)
  })
})

// ── Layout ───────────────────────────────────────────────────────────────────

describe('an import that did not keep the layout the customer drew', () => {
  it('reports a mirrored view as re-laid-out and names the pairs that swapped sides', () => {
    const result = damage(bigReal, (r) => {
      const layouts = diagramFor(r, 'SystemContext').layouts!
      for (const entry of Object.values(layouts)) entry.position.x = -entry.position.x
    })

    const report = measureFidelity(bigReal, result)
    const context = report.layout.details.find((d) => d.key === 'SystemContext')

    expect(context?.classification).toBe('relaid-out')
    expect(context?.orderingAgreementX).toBe(0)
    expect(context?.orderingAgreementY).toBe(1)
    expect(context?.inversions.length).toBeGreaterThan(0)
    expect(context?.inversions.every((i) => i.axis === 'x')).toBe(true)
    // The other five positioned views are untouched, so a single broken view
    // must not drag the whole report down with it.
    expect(report.layout.preserved).toBe(5)
  })

  it('survives a boundary element moving, because the file put it at (0,0) on purpose', () => {
    const boundaryZero = bigReal.views
      .find((v) => v.key === 'LiveDeployment')!
      .elements.find((e) => e.x === 0 && e.y === 0)!
    const result = damage(bigReal, (r) => {
      const layouts = diagramFor(r, 'LiveDeployment').layouts!
      layouts[objectIdFor(boundaryZero.id)]!.position = { x: 9999, y: 9999 }
    })

    const report = measureFidelity(bigReal, result)

    expect(report.layout.details.find((d) => d.key === 'LiveDeployment')?.classification).toBe('preserved')
  })

  it('still catches a positioned element in that same view being moved across its neighbours', () => {
    // Guards the test above from being vacuous: the exclusion is for (0,0)
    // boundaries only, not a blanket "deployment views are never checked".
    const positioned = bigReal.views
      .find((v) => v.key === 'LiveDeployment')!
      .elements.filter((e) => e.x !== 0 || e.y !== 0)
    const result = damage(bigReal, (r) => {
      const layouts = diagramFor(r, 'LiveDeployment').layouts!
      for (const member of positioned) {
        layouts[objectIdFor(member.id)]!.position = { x: -(member.x ?? 0), y: -(member.y ?? 0) }
      }
    })

    const report = measureFidelity(bigReal, result)
    const live = report.layout.details.find((d) => d.key === 'LiveDeployment')

    expect(live?.classification).toBe('relaid-out')
    expect(live?.inversions.some((i) => i.a === positioned[0]?.id || i.b === positioned[0]?.id)).toBe(true)
  })

  it('names shapes a diagram never placed', () => {
    const view = deploymentPositioned.views[0]!
    const orphan = view.elements[0]!
    const result = damage(deploymentPositioned, (r) => {
      delete diagramFor(r, view.key).layouts![objectIdFor(orphan.id)]
    })

    const report = measureFidelity(deploymentPositioned, result)

    expect(report.layout.details[0]?.missingLayoutIds).toEqual([objectIdFor(orphan.id)])
  })

  it('trusts real coordinates in a view that also declares automaticLayout', () => {
    // `deployment-positioned.json` has automaticLayout AND 10/10 real
    // coordinates (T11), so presence of the key must not downgrade the view.
    const report = measureFidelity(deploymentPositioned, buildFaithfulResult(deploymentPositioned))

    expect(deploymentPositioned.views[0]?.automaticLayout).toBeDefined()
    expect(report.layout.preserved).toBe(1)
    expect(report.layout.sourceUnpositioned).toBe(0)
  })
})

// ── Groups ───────────────────────────────────────────────────────────────────

describe('groups', () => {
  it('expects one boundary per nesting level when the file declares a separator', () => {
    const report = measureFidelity(grouped, buildFaithfulResult(grouped))

    expect(grouped.groupSeparator).toBe('/')
    // Five distinct boundaries: Groups 1, 2, 4, 5 as written plus Group 3,
    // which only ever appears inside the path "Group 2/Group 3".
    expect(report.groups.expected).toBe(5)
    expect(report.groups.missing).toEqual([])
  })

  it('names the group that never arrived', () => {
    const result = damage(grouped, (r) => {
      r.groups = r.groups.filter((g) => g.name !== 'Group 3')
    })

    const report = measureFidelity(grouped, result)

    expect(report.groups.missing).toEqual(['Group 3'])
  })

  it('keeps a group named Group 2/Group 3 intact when no separator is declared', () => {
    const opaque: SzWorkspace = { ...grouped, groupSeparator: undefined }
    // The result still split on a guessed "/", which is the defect §13.6 warns
    // about: the customer's one boundary became two the file never asked for.
    const report = measureFidelity(opaque, buildFaithfulResult(grouped))

    expect(report.groups.missing).toEqual(['Group 2/Group 3'])
    expect(report.elements.unexplainedTargets.map((t) => t.name)).toContain('Group 3')
  })
})

// ── Labels ───────────────────────────────────────────────────────────────────

describe('labels', () => {
  it('reports an element renamed by the import, with both spellings', () => {
    const customer = elementNamed(bigBank, 'Personal Banking Customer')
    const result = damage(bigBank, (r) => {
      r.objects.find((o) => o.id === objectIdFor(customer.id))!.name = 'Customer'
    })

    const report = measureFidelity(bigBank, result)

    expect(report.labels.elementNames.changed).toEqual([
      { id: customer.id, from: 'Personal Banking Customer', to: 'Customer' },
    ])
  })

  it('reports a relationship description that vanished, and never counts an edge the file left blank', () => {
    const described = bigBank.relationships.find((r) => !r.linkedRelationshipId && r.description)!
    const result = damage(bigBank, (r) => {
      const connection = r.connections.find((c) => c.id === `con-${described.id}`)!
      connection.label = undefined
      connection.description = undefined
    })

    const report = measureFidelity(bigBank, result)

    expect(report.labels.relationshipDescriptions.vanished).toEqual([
      { id: described.id, from: described.description! },
    ])
    expect(report.labels.relationshipDescriptions.compared).toBe(
      bigBank.relationships.filter((r) => (r.description ?? '').trim()).length,
    )
  })

  it('accepts a description that landed in description instead of label', () => {
    const described = bigBank.relationships.find((r) => !r.linkedRelationshipId && r.description)!
    const result = damage(bigBank, (r) => {
      const connection = r.connections.find((c) => c.id === `con-${described.id}`)!
      connection.description = connection.label
      connection.label = undefined
    })

    const report = measureFidelity(bigBank, result)

    expect(report.labels.relationshipDescriptions.changed).toEqual([])
    expect(report.labels.relationshipDescriptions.vanished).toEqual([])
  })
})

// ── Rendering ────────────────────────────────────────────────────────────────

describe('the text rendering of a report', () => {
  it('names the lost element and edge rather than only counting them', () => {
    const mainframe = elementNamed(bigBank, 'Mainframe Banking System')
    const authored = bigBank.relationships.find((r) => !r.linkedRelationshipId && r.description)!
    const result = damage(bigBank, (r) => {
      r.objects = r.objects.filter((o) => o.id !== objectIdFor(mainframe.id))
      r.connections = r.connections.filter((c) => c.id !== `con-${authored.id}`)
    })

    const text = formatFidelityReport(measureFidelity(bigBank, result))

    expect(text).toContain('MISSING ELEMENTS')
    expect(text).toContain(`${mainframe.id} "Mainframe Banking System" (softwareSystem)`)
    expect(text).toContain('MISSING AUTHORED RELATIONSHIPS')
    expect(text).toContain(`${authored.id} ${authored.sourceId} → ${authored.destinationId}`)
  })

  it('summarises the tail instead of printing hundreds of lines', () => {
    const result = damage(bigBank, (r) => {
      r.objects = r.objects.slice(0, 5)
    })

    const text = formatFidelityReport(measureFidelity(bigBank, result), { maxItems: 3 })
    const lines = text.split('\n')
    const start = lines.findIndex((l) => l.startsWith('MISSING ELEMENTS'))
    const block = lines.slice(start + 1, lines.indexOf('', start))

    expect(start).toBeGreaterThan(0)
    expect(block.length).toBe(4)
    expect(block[3]).toContain(`… and ${bigBank.elements.length - 5 - 3} more`)
  })

  it('leads with the headline counts a reviewer reads first', () => {
    const text = formatFidelityReport(measureFidelity(bigBank, buildFaithfulResult(bigBank)))

    expect(text.split('\n')[0]).toContain(bigBank.name)
    expect(text).toContain(`elements:      ${bigBank.elements.length}/${bigBank.elements.length} (100%)`)
    expect(text).toContain('authored 27/27 (100%)')
  })
})
