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

import { describe, it, expect } from 'vitest'
import type { Group, MessageStep, Position, Size } from '../../../types'
import { parseWorkspaceJson } from './parse'
import { mapWorkspace, sizeGroupBoxes, SOURCE_ID_PROPERTY } from './mapWorkspace'
import { mapWorkspace as mapDsl } from '../mapper'
import { parseWorkspace as parseDsl } from '../parser'
import bigBankJson from '../fixtures/json/big-bank-plc.json?raw'
import bigBankDsl from '../fixtures/big-bank-plc.dsl?raw'
import groupsJson from '../fixtures/json/groups.json?raw'
import deploymentJson from '../fixtures/json/deployment-positioned.json?raw'
import bigRealJson from '../fixtures/json/big-real-workspace.json?raw'
import noOrderJson from '../fixtures/json/views-without-order.json?raw'
import styledJson from '../fixtures/json/styled-scope-listed-and-routed-edges.json?raw'
import positionedJson from '../fixtures/json/positioned-container-and-deployment.json?raw'
import noViewsJson from '../fixtures/json/no-views.json?raw'

const map = (raw: string) => mapWorkspace(parseWorkspaceJson(raw))

const bigBank = map(bigBankJson)
const groups = map(groupsJson)
const deployment = map(deploymentJson)
const bigReal = map(bigRealJson)
const noOrder = map(noOrderJson)
const styled = map(styledJson)
const positioned = map(positionedJson)

const source = parseWorkspaceJson(bigBankJson)

/** The wire id an imported object came from — the importer's own provenance. */
const wireId = (objectId: string, result = bigBank): string | undefined =>
  result.objects.find((o) => o.id === objectId)?.properties[SOURCE_ID_PROPERTY]

const objectFor = (result: ReturnType<typeof map>, elementId: string) =>
  result.objects.find((o) => o.properties[SOURCE_ID_PROPERTY] === elementId)

const groupNamed = (result: ReturnType<typeof map>, name: string) =>
  result.groups.filter((g) => g.name === name)

const diagramFor = (result: ReturnType<typeof map>, key: string) =>
  result.diagrams.find((d) => d.sourceViewKey === key)!

const box = (layouts: Record<string, { position: Position; size: Size }> | undefined, id: string) => {
  const l = layouts?.[id]
  if (!l) throw new Error(`no layout for ${id}`)
  return { x: l.position.x, y: l.position.y, right: l.position.x + l.size.width, bottom: l.position.y + l.size.height }
}

const contains = (outer: ReturnType<typeof box>, inner: ReturnType<typeof box>) =>
  outer.x < inner.x && outer.y < inner.y && outer.right > inner.right && outer.bottom > inner.bottom

describe('membership comes from the view, not from the graph', () => {
  it('puts exactly the elements a container view lists on its diagram', () => {
    // groups.json's Containers view lists the EXTERNAL system C alongside the two
    // containers of D. A synthesis pass would have derived a different set — the
    // DSL importer adds every neighbour of the focal system's whole subtree.
    const diagram = diagramFor(groups, 'Containers')
    expect(diagram.objectIds.map((id) => wireId(id, groups)).sort()).toEqual(['3', '5', '6'])
  })

  it('draws only the relationships the view lists, once each', () => {
    // The SignIn dynamic view repeats three relationship ids over six steps; a
    // diagram can hold each connection once.
    const diagram = diagramFor(bigBank, 'SignIn')
    expect(source.views.find((v) => v.key === 'SignIn')!.relationships).toHaveLength(6)
    expect(diagram.connectionIds).toHaveLength(3)
    expect(new Set(diagram.connectionIds).size).toBe(3)
  })

  it('leaves a view that lists an element the model never declared with a named warning', () => {
    const raw = JSON.parse(noOrderJson) as {
      views: { systemLandscapeViews: Array<{ elements: Array<{ id: string }> }> }
    }
    raw.views.systemLandscapeViews[0]!.elements.push({ id: '999' })
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(result.warnings.some((w) => w.includes('"999"'))).toBe(true)
    expect(diagramFor(result, 'SystemLandscape-001').objectIds).toHaveLength(1)
  })
})

describe('elements', () => {
  it('imports every element except the deployment nodes, which become boundaries', () => {
    const nodes = source.elements.filter((e) => e.kind === 'deploymentNode')
    expect(source.elements).toHaveLength(51)
    expect(nodes).toHaveLength(21)
    expect(bigBank.objects).toHaveLength(51 - 21)
  })

  it('gives a container instance the name, technology and type of the container it instantiates', () => {
    // Instances carry no name, description OR technology on the wire — Java
    // @JsonIgnores all three — so an importer that reads them off the instance
    // draws a row of blank boxes with no technology chips.
    const instance = source.elements.find((e) => e.kind === 'containerInstance' && e.instanceOfId === '18')!
    expect(instance.name).toBe('')
    expect(instance.technology).toBeUndefined()
    const container = source.elements.find((e) => e.id === '18')!
    expect(container.technology).toBe('Oracle Database Schema')
    const object = objectFor(bigBank, instance.id)!
    expect(object.name).toBe('Database')
    expect(object.type).toBe('store')
    // The assertion the old test was missing: the technology chips on every
    // deployment diagram come from here, and nothing else re-derives them.
    expect(Object.values(object.technologyUsages ?? {}).map((u) => u.snapshot.name)).toEqual([
      'Oracle Database Schema',
    ])
    expect(object.icon).toBe('Oracle Database Schema')
  })

  it('reads a Cylinder-styled element as a store even when its technology says nothing', () => {
    // The `Cylinder` rule is the ONE place the customer's STYLE overrides
    // word-sniffing, so it has to be exercised on a technology the datastore
    // regex does not already match — every fixture container styled that way is
    // also called "Database", which matches twice over and hides the rule.
    const raw = JSON.parse(groupsJson) as {
      model: { softwareSystems: Array<{ id: string; containers?: Array<Record<string, unknown>> }> }
      views: Record<string, unknown>
    }
    const host = raw.model.softwareSystems.find((sys) => sys.containers?.length)!
    host.containers!.push({
      id: '900',
      name: 'Ledger',
      technology: 'Go',
      tags: 'Element,Container,Ledger',
    })
    const unstyled = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(objectFor(unstyled, '900')!.type).toBe('app')
    raw.views.configuration = { styles: { elements: [{ tag: 'Ledger', shape: 'Cylinder' }] } }
    const styledResult = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(objectFor(styledResult, '900')!.type).toBe('store')
  })

  it('does not read an Elastic Load Balancer as a data store', () => {
    const elb = objectFor(deployment, '8')!
    expect(elb.name).toBe('Elastic Load Balancer')
    expect(elb.type).toBe('app')
  })

  it('places bank staff inside the enterprise and the customer outside it', () => {
    expect(objectFor(bigBank, '1')!.name).toBe('Personal Banking Customer')
    expect(objectFor(bigBank, '1')!.scope).toBe('external')
    expect(objectFor(bigBank, '2')!.scope).toBe('internal') // tagged "Bank Staff"
    expect(objectFor(bigBank, '6')!.name).toBe('ATM') // tagged "Existing System"
    expect(objectFor(bigBank, '6')!.scope).toBe('external')
  })

  it('stamps the wire id on every object so a second import can correlate', () => {
    for (const object of bigBank.objects) {
      expect(object.properties[SOURCE_ID_PROPERTY], object.name).toBeTruthy()
    }
    expect(new Set(bigBank.objects.map((o) => o.properties[SOURCE_ID_PROPERTY])).size).toBe(bigBank.objects.length)
  })

  it('mints the same tag ids as the DSL importer for the same workspace', () => {
    // The two importers read the two serialisations of ONE product. If their tag
    // ids diverge, importing both forms of a workspace mints two parallel tag
    // registries for the same strings.
    const dsl = mapDsl(parseDsl(bigBankDsl))
    const dslById = new Map(dsl.tags.map((t) => [t.value, t.tagId]))
    const shared = bigBank.tags.filter((t) => dslById.has(t.value))
    expect(shared.length).toBeGreaterThan(3)
    for (const tag of shared) expect(tag.tagId).toBe(dslById.get(tag.value))
  })
})

describe('groups', () => {
  it('splits a nested group path only because the workspace declares a separator', () => {
    expect(parseWorkspaceJson(groupsJson).groupSeparator).toBe('/')
    expect(groupNamed(groups, 'Group 2')).toHaveLength(1)
    expect(groupNamed(groups, 'Group 3')).toHaveLength(1)
    expect(groupNamed(groups, 'Group 2/Group 3')).toHaveLength(0)
    // "Group 2/Group 3" belongs to D, so D is a member of BOTH levels.
    const d = objectFor(groups, '4')!
    expect(groupNamed(groups, 'Group 2')[0]!.objectIds).toContain(d.id)
    expect(groupNamed(groups, 'Group 3')[0]!.objectIds).toContain(d.id)
  })

  it('keeps a group named Group 2/Group 3 intact when no separator is declared', () => {
    // Guessing "/" would shatter a group a customer legitimately named
    // "Payments/Billing" into two groups they never had.
    const raw = JSON.parse(groupsJson) as { model: { properties?: unknown } }
    delete raw.model.properties
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(parseWorkspaceJson(JSON.stringify(raw)).groupSeparator).toBeUndefined()
    expect(groupNamed(result, 'Group 2/Group 3')).toHaveLength(1)
    expect(groupNamed(result, 'Group 3')).toHaveLength(0)
  })

  it('turns each deployment node into its own boundary holding every instance below it', () => {
    const aws = groupNamed(deployment, 'Amazon Web Services')[0]!
    const rds = groupNamed(deployment, 'Amazon RDS')[0]!
    const mysql = groupNamed(deployment, 'MySQL')[0]!
    expect(aws.objectIds).toHaveLength(4) // both instances + both infrastructure nodes
    expect(rds.objectIds).toEqual(mysql.objectIds) // a node whose only child is a node
    expect(aws.type).toBe('Deployment node')
  })

  it('draws a group that has a single member on the view', () => {
    // Structurizr draws the box around one element as readily as around five.
    // The DSL importer's "at least two members" rule exists only because it was
    // guessing membership; here the file says who is on the view.
    const landscape = diagramFor(groups, 'SystemLandscape')
    const names = landscape.groupIds.map((id) => groups.groups.find((g) => g.id === id)!.name)
    expect(groupNamed(groups, 'Group 1')[0]!.objectIds).toHaveLength(1)
    expect(names).toContain('Group 1')
    expect(names.sort()).toEqual(['Group 1', 'Group 2', 'Group 3'])
  })

  it('wraps a container view in the boundary of the system it is scoped to', () => {
    const boundary = groups.groups.find((g) => g.parentObjectId === objectFor(groups, '4')!.id)!
    expect(boundary.name).toBe('D')
    expect(boundary.objectIds.map((id) => wireId(id, groups)).sort()).toEqual(['5', '6'])
    expect(diagramFor(groups, 'Containers').parentObjectId).toBe(objectFor(groups, '4')!.id)
  })

  it('lists the tightest boundary first so the layout clusters at the deepest level', () => {
    // `buildLayoutGraph` assigns a shape to the FIRST group on the diagram that
    // claims it; listing the outermost node first would cluster every instance
    // into one flat box and lose the nesting entirely.
    const diagram = diagramFor(deployment, 'AmazonWebServicesDeployment')
    const names = diagram.groupIds.map((id) => deployment.groups.find((g) => g.id === id)!.name)
    expect(names.indexOf('MySQL')).toBeLessThan(names.indexOf('Amazon RDS'))
    expect(names.indexOf('Amazon RDS')).toBeLessThan(names.indexOf('US-East-1'))
    expect(names.indexOf('US-East-1')).toBeLessThan(names.indexOf('Amazon Web Services'))
  })
})

describe('relationships', () => {
  it('keeps every relationship, and never stamps a derived one as `lower`', () => {
    const derived = source.relationships.filter((r) => r.linkedRelationshipId)
    expect(source.relationships).toHaveLength(42)
    expect(derived).toHaveLength(15)
    // 41, not 42: one authored edge runs between two deployment nodes.
    expect(bigBank.connections).toHaveLength(41)
    // `lower` in this app means "a roll-up the client recomputes and never
    // persists" — see the store-level regression test in
    // `lib/import/structurizrJsonSource.test.ts`. An imported edge stamped that
    // way is deleted on the first canvas open, so the DERIVATION is carried as
    // provenance instead and the edge is an ordinary connection.
    expect(bigBank.connections.filter((c) => c.kind === 'lower')).toHaveLength(0)
    expect(bigBank.connections.every((c) => c.kind === undefined)).toBe(true)
    const derivedConnections = bigBank.connections.filter(
      (c) => c.properties?.['structurizr.linkedRelationshipId'] !== undefined,
    )
    expect(derivedConnections).toHaveLength(15)
    expect(derivedConnections[0]!.properties!['structurizr.linkedRelationshipId']).toBe(
      derived.find((r) => r.id === derivedConnections[0]!.properties![SOURCE_ID_PROPERTY])!.linkedRelationshipId,
    )
  })

  it('keeps two relationships that join the same pair of elements', () => {
    // Structurizr allows parallel edges and the views reference them BY ID, so
    // collapsing them (as the DSL importer does, having no ids to preserve)
    // empties whichever view drew the one that lost.
    const raw = JSON.parse(groupsJson) as {
      model: { softwareSystems: Array<{ relationships?: Array<Record<string, unknown>> }> }
      views: { systemLandscapeViews: Array<{ relationships: Array<{ id: string }> }> }
    }
    raw.model.softwareSystems[0]!.relationships!.push({
      id: '99',
      sourceId: '1',
      destinationId: '2',
      description: 'Also notifies',
    })
    raw.views.systemLandscapeViews[0]!.relationships.push({ id: '99' })
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    const a = objectFor(result, '1')!
    const b = objectFor(result, '2')!
    const between = result.connections.filter((c) => c.fromId === a.id && c.toId === b.id)
    expect(between.map((c) => c.label).sort()).toEqual(['', 'Also notifies'])
    expect(diagramFor(result, 'SystemLandscape').connectionIds).toHaveLength(4)
  })

  it('names the relationship it cannot draw between two deployment nodes', () => {
    const warning = bigBank.warnings.find((w) => w.includes('deployment nodes'))
    expect(warning).toContain('Replicates data to')
    expect(warning).toContain('Oracle - Primary')
    expect(warning).toContain('Oracle - Secondary')
  })

  it('draws an unstyled Structurizr relationship dashed, because that is what Structurizr draws', () => {
    expect(parseWorkspaceJson(bigBankJson).relationshipStyles).toHaveLength(0)
    expect(bigBank.connections.every((c) => c.type === 'dashed')).toBe(true)
  })

  it('honours a Solid relationship style over the dashed default', () => {
    const raw = JSON.parse(bigBankJson) as {
      views: { configuration: { styles: { relationships?: unknown } } }
    }
    raw.views.configuration.styles.relationships = [{ tag: 'Relationship', style: 'Solid' }]
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(result.connections.filter((c) => c.type === 'solid').length).toBeGreaterThan(20)
  })

  it('labels an edge with its description, falling back to its technology', () => {
    const raw = JSON.parse(groupsJson) as {
      model: { softwareSystems: Array<{ relationships?: Array<Record<string, unknown>> }> }
    }
    const relationship = raw.model.softwareSystems[0]!.relationships![0]!
    relationship.technology = 'HTTPS'
    const technologyOnly = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(technologyOnly.connections[0]!.label).toBe('HTTPS')
    relationship.description = 'Sends orders to'
    const described = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(described.connections[0]!.label).toBe('Sends orders to')
    // The technology survives as a governed usage rather than being folded into
    // the label, so an export can put it back where it came from.
    expect(Object.values(described.connections[0]!.technologyUsages ?? {})[0]?.snapshot.name).toBe('HTTPS')
  })
})

describe('dynamic views become flows', () => {
  const flow = bigBank.flows[0]!
  const steps = flow.steps as MessageStep[]

  it('orders the steps by the view order, not by file order or id', () => {
    expect(bigBank.flows).toHaveLength(1)
    expect(flow.name).toBe('SignIn')
    expect(flow.diagramId).toBe(diagramFor(bigBank, 'SignIn').id)
    expect(steps.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6])
    expect(steps.map((s) => s.title)).toEqual([
      'Submits credentials to',
      'Validates credentials using',
      'select * from users where username = ?',
      'Returns user data to',
      'Returns true if the hashed password matches',
      'Sends back an authentication token to',
    ])
  })

  it('walks the same edge backwards for a response step', () => {
    const request = steps[2]!
    const response = steps[3]!
    expect(response.connectionId).toBe(request.connectionId)
    expect(response.fromObjectId).toBe(request.toObjectId)
    expect(response.toObjectId).toBe(request.fromObjectId)
  })

  it('keeps every step on a connection the diagram actually carries', () => {
    const drawn = new Set(diagramFor(bigBank, 'SignIn').connectionIds)
    for (const step of steps) expect(drawn.has(step.connectionId)).toBe(true)
  })

  it('keeps the steps in file order when the view declares no order at all', () => {
    // views-without-order.json is the fixture that pins "absent" as a real state;
    // a producer that omits `order` has still written its steps in sequence.
    const raw = JSON.parse(noOrderJson) as { model: Record<string, unknown>; views: Record<string, unknown> }
    raw.model.softwareSystems = [
      {
        id: '2',
        name: 'S',
        tags: 'Element,Software System',
        relationships: [
          { id: '10', sourceId: '2', destinationId: '3', description: 'second' },
          { id: '11', sourceId: '2', destinationId: '1', description: 'third' },
        ],
        containers: [{ id: '3', name: 'C', tags: 'Element,Container' }],
      },
    ]
    ;(raw.model.people as Array<{ relationships?: unknown }>)[0]!.relationships = [
      { id: '9', sourceId: '1', destinationId: '2', description: 'first' },
    ]
    raw.views.dynamicViews = [
      {
        key: 'Unordered',
        elements: [{ id: '1' }, { id: '2' }, { id: '3' }],
        relationships: [{ id: '9' }, { id: '10' }, { id: '11' }],
      },
    ]
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(result.flows[0]!.steps.map((s) => s.title)).toEqual(['first', 'second', 'third'])
    expect(result.warnings.some((w) => w.includes('no order'))).toBe(true)
  })

  it('sorts a nested step order numerically per segment, so 1.10 follows 1.9', () => {
    const raw = JSON.parse(noOrderJson) as { model: Record<string, unknown>; views: Record<string, unknown> }
    raw.model.softwareSystems = [
      { id: '2', name: 'S', tags: 'Element,Software System' },
      { id: '3', name: 'T', tags: 'Element,Software System' },
    ]
    ;(raw.model.people as Array<{ relationships?: unknown }>)[0]!.relationships = [
      { id: '9', sourceId: '1', destinationId: '2', description: 'a' },
      { id: '10', sourceId: '1', destinationId: '3', description: 'b' },
    ]
    raw.views.dynamicViews = [
      {
        key: 'Nested',
        elements: [{ id: '1' }, { id: '2' }, { id: '3' }],
        relationships: [
          { id: '10', order: '1.10', description: 'tenth' },
          { id: '9', order: '1.9', description: 'ninth' },
        ],
      },
    ]
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(result.flows[0]!.steps.map((s) => s.title)).toEqual(['ninth', 'tenth'])
  })
})

describe('layout', () => {
  it('sends a view whose elements all sit on the origin to auto-layout', () => {
    // All 67 element rows in big-bank-plc.json are at (0,0): no layout was ever
    // computed, and copying those coordinates stacks the whole workspace.
    expect(source.views.flatMap((v) => v.elements).filter((e) => e.x === 0 && e.y === 0)).toHaveLength(67)
    expect(bigBank.preservedDiagramIds).toHaveLength(0)
    expect(bigBank.diagrams.every((d) => d.layouts === undefined)).toBe(true)
  })

  it('keeps the coordinates of a view that has them', () => {
    const diagram = diagramFor(deployment, 'AmazonWebServicesDeployment')
    expect(deployment.preservedDiagramIds).toEqual([diagram.id])
    // Route 53 (487) → ELB (1237) → web instance (1987) → database instance (2887)
    // in the file; the same left-to-right order after scaling to our box sizes.
    const order = ['7', '8', '11', '14'].map((elementId) => box(diagram.layouts, objectFor(deployment, elementId)!.id).x)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(new Set(order).size).toBe(4)
  })

  it('places a shape the file left on the origin clear of the arrangement it did lay out', () => {
    // Dropping it at (0,0) would bury it under a shape the customer positioned;
    // dropping it altogether would take a box off their diagram.
    const raw = JSON.parse(deploymentJson) as {
      views: { deploymentViews: Array<{ elements: Array<{ id: string; x?: number; y?: number }> }> }
    }
    const stray = raw.views.deploymentViews[0]!.elements.find((e) => e.id === '7')!
    stray.x = 0
    stray.y = 0
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    const diagram = diagramFor(result, 'AmazonWebServicesDeployment')
    expect(result.preservedDiagramIds).toEqual([diagram.id])
    const placed = box(diagram.layouts, objectFor(result, '8')!.id)
    const packed = box(diagram.layouts, objectFor(result, '7')!.id)
    expect(packed.y).toBeGreaterThan(placed.bottom)
  })

  it('preserves every view of a workspace that was laid out by hand', () => {
    expect(bigReal.preservedDiagramIds).toHaveLength(6)
    expect(bigReal.diagrams).toHaveLength(6)
  })

  it('keeps the scoped system of a system-context view as a shape, not a boundary', () => {
    // `layoutPolicy` calls the scope element a boundary — right for a container
    // view, wrong here — and a boundary is kept out of `layouts`, which parked
    // the Internet Banking System below the diagram instead of at (607,659).
    const diagram = diagramFor(bigReal, 'SystemContext')
    const scoped = objectFor(bigReal, '7')!
    expect(scoped.name).toBe('Internet Banking System')
    const customer = objectFor(bigReal, '1')!
    const staff = objectFor(bigReal, '4')!
    expect(box(diagram.layouts, scoped.id).y).toBeGreaterThan(box(diagram.layouts, customer.id).y)
    expect(box(diagram.layouts, scoped.id).y).toBeLessThan(box(diagram.layouts, staff.id).y)
  })

  it('gives every object and group on a preserved diagram a layout', () => {
    for (const diagram of [...deployment.diagrams, ...bigReal.diagrams]) {
      for (const id of [...diagram.objectIds, ...diagram.groupIds]) {
        expect(diagram.layouts?.[id], `${diagram.name}:${id}`).toBeDefined()
      }
    }
  })

  it('nests a deployment boundary strictly inside its parent instead of drawing both the same size', () => {
    // A node whose only child is another node holds exactly the same instances,
    // so sizing from members alone gives two identical boxes — one border with
    // two titles stacked on it.
    const diagram = diagramFor(deployment, 'AmazonWebServicesDeployment')
    const at = (name: string) => box(diagram.layouts, groupNamed(deployment, name)[0]!.id)
    expect(contains(at('Amazon Web Services'), at('US-East-1'))).toBe(true)
    expect(contains(at('US-East-1'), at('Amazon RDS'))).toBe(true)
    expect(contains(at('Amazon RDS'), at('MySQL'))).toBe(true)
    expect(contains(at('MySQL'), box(diagram.layouts, objectFor(deployment, '14')!.id))).toBe(true)
  })

  it('passes the view rank direction through as a layout hint for the views it must lay out', () => {
    expect(Object.keys(bigBank.layoutHints)).toHaveLength(bigBank.diagrams.length)
    expect(Object.values(bigBank.layoutHints).every((h) => h.direction === 'tb')).toBe(true)
    // Nothing to hint about a view we are not laying out.
    expect(bigReal.layoutHints).toEqual({})
  })
})

describe('sizeGroupBoxes', () => {
  const grp = (id: string, objectIds: string[]): Group => ({
    id,
    name: id,
    color: '#fff',
    objectIds,
    autoSize: false,
    tagAssignments: {},
    tagOrder: [],
  })
  const layouts = {
    a: { position: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
  }

  it('grows an existing box rather than replacing what the layout engine scored', () => {
    const existing = {
      ...layouts,
      outer: { position: { x: -500, y: -500 }, size: { width: 2000, height: 2000 } },
    }
    const out = sizeGroupBoxes([grp('outer', ['a'])], existing, 'expand')
    expect(out.outer).toEqual(existing.outer)
  })

  it('sizes a fresh box to its members plus the room the canvas draws the title in', () => {
    const out = sizeGroupBoxes([grp('outer', ['a'])], layouts, 'fresh')
    expect(out.outer!.position.y).toBeLessThan(0)
    expect(out.outer!.size.height).toBeGreaterThan(100)
  })

  it('leaves a group whose members are nowhere on the diagram without a box', () => {
    expect(sizeGroupBoxes([grp('ghost', ['nobody'])], layouts, 'fresh').ghost).toBeUndefined()
  })

  it('does not let two groups holding the same members swallow each other', () => {
    // A deployment node whose only child is another node holds EXACTLY the same
    // instances, so a membership test alone finds nesting in BOTH directions:
    // each grows to wrap the other and the pair ends up as one border with two
    // titles stacked on it. Depth is the tie-break. Measured on
    // deployment-positioned.json ("Amazon Web Services" → "US-East-1").
    const existing = {
      ...layouts,
      // Both already wrap member `a` with room to spare, so nothing grows for
      // an honest reason and only the nesting rule can move them.
      inner: { position: { x: -40, y: -60 }, size: { width: 200, height: 220 } },
      outer: { position: { x: -80, y: -100 }, size: { width: 300, height: 340 } },
    }
    const depths = { inner: 2, outer: 1 }
    const out = sizeGroupBoxes([grp('inner', ['a']), grp('outer', ['a'])], existing, 'expand', depths)
    // The inner box must not have grown to the outer one; the outer must still
    // strictly contain it.
    expect(out.inner).toEqual(existing.inner)
    expect(out.outer!.position.x).toBeLessThan(out.inner!.position.x)
    expect(out.outer!.position.y).toBeLessThan(out.inner!.position.y)
    expect(out.outer!.size.width).toBeGreaterThan(out.inner!.size.width)
    expect(out.outer!.size.height).toBeGreaterThan(out.inner!.size.height)
  })
})

describe('views that cannot be rebuilt are reported, never dropped silently', () => {
  it('names the image view it did not import', () => {
    const image = source.views.find((v) => v.kind === 'image')!
    expect(bigBank.diagrams.some((d) => d.sourceViewKey === image.key)).toBe(false)
    expect(bigBank.warnings.some((w) => w.includes('image view') && w.includes(image.title!))).toBe(true)
  })

  it('rebuilds a filtered view from its base view and says the filter is a reading, not a fact', () => {
    const raw = JSON.parse(groupsJson) as { views: Record<string, unknown> }
    raw.views.filteredViews = [
      { key: 'Filtered', baseViewKey: 'SystemLandscape', mode: 'Exclude', tags: 'Software System' },
    ]
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    const filtered = result.diagrams.find((d) => d.sourceViewKey === 'Filtered')!
    // Every element of that landscape is a software system, so Exclude empties it.
    expect(filtered.objectIds).toHaveLength(0)
    expect(result.warnings.some((w) => w.includes('Filtered') && w.includes('SystemLandscape'))).toBe(true)
  })

  it('skips a filtered view whose base view the file does not contain, naming both', () => {
    const raw = JSON.parse(groupsJson) as { views: Record<string, unknown> }
    raw.views.filteredViews = [{ key: 'Orphan', baseViewKey: 'Missing', mode: 'Include', tags: 'x' }]
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(result.diagrams.some((d) => d.sourceViewKey === 'Orphan')).toBe(false)
    expect(result.warnings.some((w) => w.includes('Orphan') && w.includes('Missing'))).toBe(true)
  })
})

describe('diagram identity', () => {
  it('records the view key so an export re-emits the same one', () => {
    expect(bigBank.diagrams.map((d) => d.sourceViewKey)).toEqual([
      'SystemLandscape',
      'SystemContext',
      'Containers',
      'Components',
      'SignIn',
      'LiveDeployment',
      'DevelopmentDeployment',
    ])
  })

  it('maps each view kind onto the C4 level it belongs to', () => {
    const typeOf = (key: string) => diagramFor(bigBank, key).type
    expect(typeOf('SystemLandscape')).toBe('context')
    expect(typeOf('SystemContext')).toBe('context')
    expect(typeOf('Containers')).toBe('container')
    expect(typeOf('Components')).toBe('component')
    expect(typeOf('LiveDeployment')).toBe('container')
    // A dynamic view has no level of its own; SignIn is drawn over components.
    expect(typeOf('SignIn')).toBe('component')
  })

  it('enters on the landscape view, and on the first context view when there is none', () => {
    expect(diagramFor(bigBank, 'SystemLandscape').id).toBe(bigBank.entryDiagramId)
    expect(bigReal.diagrams.some((d) => d.sourceViewKey === 'SystemLandscape')).toBe(false)
    expect(diagramFor(bigReal, 'SystemContext').id).toBe(bigReal.entryDiagramId)
  })

  it('keeps two views that draw the same single element as two diagrams', () => {
    expect(noOrder.diagrams).toHaveLength(2)
    expect(noOrder.objects).toHaveLength(1)
    expect(noOrder.diagrams.every((d) => d.objectIds.length === 1)).toBe(true)
  })
})

describe('a view that lists the element it is scoped to', () => {
  // structurizr-ui writes that row as soon as the boundary has been dragged, and
  // nl-wallet ships workspaces that carry it. `layoutPolicy` calls the scope a
  // boundary, so it never entered `layouts` — and the diagram still listed its
  // objectId, which parked a stray copy of the system in a grid BELOW the
  // arrangement, with its real coordinate discarded and no warning.
  const containers = diagramFor(styled, 'Containers')
  const ordering = objectFor(styled, '1')!

  it('draws it once, as the boundary, and not a second time as a shape', () => {
    expect(ordering.name).toBe('Ordering')
    expect(containers.objectIds).not.toContain(ordering.id)
    expect(containers.objectIds.map((id) => wireId(id, styled)).sort()).toEqual(['2', '3', '4'])
    expect(containers.parentObjectId).toBe(ordering.id)
    const boundary = styled.groups.find((g) => g.parentObjectId === ordering.id)!
    expect(containers.groupIds).toContain(boundary.id)
    expect(containers.layouts![ordering.id]).toBeUndefined()
    // Nothing sits below the arrangement, because nothing was left unplaced.
    const bottoms = containers.objectIds.map((id) => box(containers.layouts, id).bottom)
    const boundaryBox = box(containers.layouts, boundary.id)
    expect(Math.max(...bottoms)).toBeLessThanOrEqual(boundaryBox.bottom)
  })

  it('still keeps the scope element as a SHAPE when the view draws nothing inside it', () => {
    // The boundary only exists if something is in it. A container view listing
    // its system with no children of that system on it is the system as an
    // ordinary box, and it has to be placed like one.
    const raw = JSON.parse(styledJson) as {
      views: { containerViews: Array<{ elements: Array<{ id: string; x?: number; y?: number }> }> }
    }
    raw.views.containerViews[0]!.elements = raw.views.containerViews[0]!.elements.filter(
      (e) => e.id === '1' || e.id === '4',
    )
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    const diagram = diagramFor(result, 'Containers')
    const system = objectFor(result, '1')!
    expect(diagram.parentObjectId).toBeUndefined()
    expect(diagram.objectIds).toContain(system.id)
    expect(diagram.layouts![system.id]).toBeDefined()
    // (700,600) is right of and below the operator at (150,150) — a real
    // coordinate, not a packed-below-the-diagram slot.
    const operator = objectFor(result, '4')!
    expect(box(diagram.layouts, system.id).x).toBeGreaterThan(box(diagram.layouts, operator.id).x)
  })
})

describe('the customer’s styling', () => {
  it('colours the tag the stylesheet keyed the style on', () => {
    // Structurizr styles ARE keyed by tag, and `Tag.color` is what this app
    // colours a chip and a bottom bar with, so this is the same statement in the
    // same terms. Before, every colour was resolved and thrown away and the tag
    // took a colour hashed from its own name.
    expect(styled.tags.find((t) => t.value === 'Queue')!.color).toBe('#ff0000')
  })

  it('keeps every resolved colour, stroke and icon on the object that had one', () => {
    const queue = objectFor(styled, '3')!
    expect(queue.name).toBe('Order Queue')
    expect(queue.properties['structurizr.style.background']).toBe('#ff0000')
    expect(queue.properties['structurizr.style.color']).toBe('#000000')
    expect(queue.properties['structurizr.style.stroke']).toBe('#2e6295')
    expect(queue.properties['structurizr.style.icon']).toBe('https://static.structurizr.com/icons/rabbitmq.png')
    expect(queue.properties['structurizr.style.shape']).toBe('Pipe')
    // Only what the STYLESHEET set: an element the customer never styled must
    // not be frozen to the resolver's seeded defaults.
    const plain = objectFor(groups, '1')!
    expect(Object.keys(plain.properties).filter((k) => k.startsWith('structurizr.style.'))).toEqual([])
  })

  it('paints a boundary the colour its element style says, not the next palette entry', () => {
    const boundary = styled.groups.find((g) => g.parentObjectId === objectFor(styled, '1')!.id)!
    expect(boundary.color).toBe('#438dd5')
    expect(boundary.borderColor).toBe('#2e6295')
  })

  it('paints a model group from its Group:<name> style', () => {
    const raw = JSON.parse(groupsJson) as { views: Record<string, unknown> }
    raw.views.configuration = {
      styles: { elements: [{ tag: 'Group:Group 1', background: '#123456', stroke: '#654321' }] },
    }
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(groupNamed(result, 'Group 1')[0]!.color).toBe('#123456')
    expect(groupNamed(result, 'Group 1')[0]!.borderColor).toBe('#654321')
    // Unstyled groups still get the palette, so nothing turns colourless.
    expect(groupNamed(result, 'Group 2')[0]!.color).toMatch(/^#[0-9A-F]{6}$/i)
  })

  it('keeps a relationship’s style colour and thickness', () => {
    const async = styled.connections.find((c) => c.label === 'Publishes orders to')!
    expect(async.properties!['structurizr.style.color']).toBe('#ff0000')
    expect(async.properties!['structurizr.style.thickness']).toBe('4')
    expect(async.type).toBe('dotted')
  })
})

describe('metadata MapleSpire has no field of its own for', () => {
  it('keeps the perspectives a regulated workspace is migrated FOR', () => {
    const database = objectFor(positioned, '5')!
    expect(database.properties['structurizr.perspective.Security']).toBe('High')
    expect(database.properties['structurizr.perspective.Security.description']).toBe(
      'Holds personally identifiable information',
    )
    expect(database.properties['structurizr.perspective.Ownership']).toBe('platform@example.com')
  })

  it('keeps the deployment groups that decide which replicas Structurizr generates', () => {
    // §5.5 inheritance is parsed (node 10 declares "banking", every descendant
    // inherits it); dropping it silently changes deployment semantics on the way
    // back out, and the workspace stops round-tripping.
    const instance = objectFor(positioned, '14')!
    expect(instance.properties['structurizr.deploymentGroups']).toBe('banking')
    const node = positioned.groups.find((g) => g.properties?.['structurizr.id'] === '10')!
    expect(node.name).toBe('Amazon Web Services')
    expect(node.properties!['structurizr.deploymentGroups']).toBe('banking')
  })

  it('keeps a relationship’s interaction style, url, wire id and own properties', () => {
    const raw = JSON.parse(groupsJson) as {
      model: { softwareSystems: Array<{ relationships?: Array<Record<string, unknown>> }> }
    }
    const relationship = raw.model.softwareSystems[0]!.relationships![0]!
    relationship.interactionStyle = 'Asynchronous'
    relationship.url = 'https://example.com/runbooks/edge'
    relationship.properties = { owner: 'team-a' }
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    const connection = result.connections[0]!
    expect(connection.properties!['structurizr.interactionStyle']).toBe('Asynchronous')
    expect(connection.properties!['structurizr.url']).toBe('https://example.com/runbooks/edge')
    expect(connection.properties!.owner).toBe('team-a')
    expect(connection.properties![SOURCE_ID_PROPERTY]).toBe(relationship.id)
    // `Asynchronous` is stripped from `tags` by the parser because it is a
    // machine-generated default there; `interactionStyle` is the only channel.
    expect(parseWorkspaceJson(JSON.stringify(raw)).relationships[0]!.tags).not.toContain('Asynchronous')
  })

  it('tells a deployment node from another one with the same name', () => {
    // big-bank-plc has three nodes called "Apache Tomcat", two "Web Browser" and
    // two "Big Bank plc". Flattening environment/instances into a display string
    // left nothing — not an exporter, not a re-import — able to pair them up.
    const tomcats = groupNamed(bigBank, 'Apache Tomcat')
    expect(tomcats).toHaveLength(3)
    expect(new Set(tomcats.map((g) => g.properties?.[SOURCE_ID_PROPERTY])).size).toBe(3)
    expect(tomcats.every((g) => g.properties?.['structurizr.environment'])).toBe(true)
  })

  it('keeps a customer property that collides with a key the import reserves', () => {
    const raw = JSON.parse(groupsJson) as {
      model: { softwareSystems: Array<{ properties?: Record<string, string> }> }
    }
    raw.model.softwareSystems[0]!.properties = { 'structurizr.id': 'the customer’s own value' }
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    const object = objectFor(result, '1')!
    expect(object.properties[SOURCE_ID_PROPERTY]).toBe('1')
    expect(object.properties['structurizr.id.original']).toBe('the customer’s own value')
    expect(result.warnings.some((w) => w.includes('structurizr.id.original'))).toBe(true)
  })

  it('reports the workspace name so an import can offer to create a landscape from it', () => {
    expect(styled.landscapeName).toBe(
      'Styled workspace whose container view lists its own scope and routes its edges',
    )
  })
})

describe('hand-routed edges', () => {
  const containers = diagramFor(styled, 'Containers')
  const routed = styled.connections.find((c) => c.label === 'Publishes orders to')!

  it('keeps the bends, the routing and the label placement the file drew', () => {
    expect(styled.preservedDiagramIds).toEqual([containers.id])
    expect(routed.waypoints).toHaveLength(2)
    expect(routed.shape).toBe('straight') // Orthogonal — straight segments through the bends
    expect(routed.labelPosition).toBeCloseTo(0.8, 5)
    const plain = styled.connections.find((c) => c.label === 'Administers')!
    expect(plain.waypoints).toBeUndefined()
    expect(plain.labelPosition).toBeCloseTo(0.2, 5)
  })

  it('puts the bends through the SAME transform as the shapes they run between', () => {
    // The view is scaled to our box sizes; copying the wire vertices verbatim
    // detaches the line from both of its endpoints.
    const web = box(containers.layouts, objectFor(styled, '2')!.id)
    const queue = box(containers.layouts, objectFor(styled, '3')!.id)
    for (const point of routed.waypoints!) {
      expect(point.x).toBeGreaterThan(web.x)
      expect(point.y).toBeGreaterThan(web.y)
      expect(point.y).toBeLessThan(queue.bottom)
    }
    // Wire (1500,1200) and (1100,1500) with the arrangement's own origin at
    // (150,150): the first bend is right of and above the second.
    const [first, second] = routed.waypoints!
    expect(first!.x).toBeGreaterThan(second!.x)
    expect(first!.y).toBeLessThan(second!.y)
  })

  it('names the view whose routing it could not also honour', () => {
    // Bends live on the connection, not on the diagram. Two preserved views that
    // route the same edge differently cannot both be satisfied, so the first
    // wins and the customer is told which one lost.
    const raw = JSON.parse(styledJson) as {
      views: { containerViews: Array<Record<string, unknown>> }
    }
    const second = JSON.parse(JSON.stringify(raw.views.containerViews[0])) as Record<string, unknown>
    second.key = 'ContainersAgain'
    second.title = 'The same containers, routed differently'
    ;(second.relationships as Array<Record<string, unknown>>)[1]!.vertices = [{ x: 100, y: 100 }]
    raw.views.containerViews.push(second)
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    const connection = result.connections.find((c) => c.label === 'Publishes orders to')!
    expect(connection.waypoints).toHaveLength(2) // the FIRST view's routing
    expect(result.warnings.some((w) => w.includes('routes the connection') && w.includes('The same containers'))).toBe(
      true,
    )
  })
})

describe('filtered views', () => {
  it('draws the base view’s relationships, not the empty array the wire carries', () => {
    // A filtered view has no elements and no relationships of its own on the
    // wire. Reading its own arrays imported three boxes and NO lines.
    const filtered = diagramFor(positioned, 'ContainersWithoutDatabase')
    expect(filtered.objectIds.map((id) => wireId(id, positioned)).sort()).toEqual(['1', '3', '4'])
    expect(filtered.connectionIds).toHaveLength(2)
    const labels = filtered.connectionIds
      .map((id) => positioned.connections.find((c) => c.id === id)!.label)
      .sort()
    expect(labels).toEqual(['Makes API calls to', 'Uses'])
  })

  it('inherits the base view’s placements instead of being re-laid-out beside it', () => {
    const base = diagramFor(positioned, 'Containers')
    const filtered = diagramFor(positioned, 'ContainersWithoutDatabase')
    expect(positioned.preservedDiagramIds).toContain(filtered.id)
    for (const id of filtered.objectIds) {
      expect(filtered.layouts![id], wireId(id, positioned)).toEqual(base.layouts![id])
    }
    // It is still a container view of the same system, so it keeps the boundary.
    expect(filtered.type).toBe('container')
    expect(filtered.parentObjectId).toBe(objectFor(positioned, '2')!.id)
  })

  it('reads "include nothing" as nothing, not as everything', () => {
    // `mode: Include` with no tags kept the whole base view while the warning
    // said it had kept the elements tagged "(nothing)".
    const raw = JSON.parse(groupsJson) as { views: Record<string, unknown> }
    raw.views.filteredViews = [{ key: 'Filtered', baseViewKey: 'SystemLandscape', mode: 'Include', tags: '' }]
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    const filtered = result.diagrams.find((d) => d.sourceViewKey === 'Filtered')!
    expect(diagramFor(result, 'SystemLandscape').objectIds.length).toBeGreaterThan(0)
    expect(filtered.objectIds).toEqual([])
    expect(filtered.connectionIds).toEqual([])
  })
})

describe('a file that does not say what it looks like it says', () => {
  it('imports both views that share a key, and says which one a reference resolves to', () => {
    // Structurizr keys are unique PER VIEW TYPE, not globally, so this file is
    // legal. Last-wins collapsed the pair silently: two diagrams, one base-view
    // resolution, and no way to tell which had been picked.
    const raw = JSON.parse(groupsJson) as { views: Record<string, unknown> }
    const landscape = (raw.views.systemLandscapeViews as Array<{ key: string }>)[0]!
    landscape.key = 'Dup'
    ;(raw.views.containerViews as Array<{ key: string }>)[0]!.key = 'Dup'
    raw.views.filteredViews = [{ key: 'F', baseViewKey: 'Dup', mode: 'Exclude', tags: 'nothing-matches' }]
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(result.diagrams.filter((d) => d.sourceViewKey === 'Dup')).toHaveLength(2)
    expect(result.warnings.some((w) => w.includes('share the key "Dup"'))).toBe(true)
    // The filtered view resolved against the FIRST — the landscape — and says so.
    const filtered = result.diagrams.find((d) => d.sourceViewKey === 'F')!
    const first = result.diagrams.find((d) => d.sourceViewKey === 'Dup')!
    expect(filtered.objectIds).toEqual(first.objectIds)
  })

  it('draws the FIRST of two elements that share an id, and names both', () => {
    // Both stay in the model (the Model Objects page shows them), but a view row
    // can only mean one of them. Last-wins left the first as an object no
    // diagram could ever draw, while the parse warning said "both kept".
    const raw = JSON.parse(groupsJson) as {
      model: { softwareSystems: Array<Record<string, unknown>> }
    }
    raw.model.softwareSystems.push({ id: '1', name: 'Impostor', tags: 'Element,Software System' })
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    const both = result.objects.filter((o) => o.properties[SOURCE_ID_PROPERTY] === '1')
    expect(both).toHaveLength(2)
    expect(both[1]!.name).toBe('Impostor')
    const landscape = diagramFor(result, 'SystemLandscape')
    expect(landscape.objectIds).toContain(both[0]!.id)
    expect(landscape.objectIds).not.toContain(both[1]!.id)
    expect(result.warnings.some((w) => w.includes('share the id "1"') && w.includes('Impostor'))).toBe(true)
  })

  it('generates a default view set for a model that declares no views', () => {
    const result = map(noViewsJson)
    expect(parseWorkspaceJson(noViewsJson).views).toEqual([])
    expect(result.diagrams.map((d) => d.name)).toEqual([
      'System Landscape',
      'Internet Banking — Containers',
      'Web Application — Components',
    ])
    expect(result.warnings.some((w) => w.includes('declares no views'))).toBe(true)
    // The landscape holds the top-level elements and the edge between them.
    const landscape = diagramFor(result, 'SystemLandscape')
    expect(landscape.objectIds.map((id) => wireId(id, result)).sort()).toEqual(['1', '2', '6'])
    expect(landscape.connectionIds).toHaveLength(1)
  })
})

describe('the two importers make the same judgements', () => {
  it('never makes a container external, whichever serialisation it came from', () => {
    // `../mapper.ts` forces containers and components internal — they inherit
    // their system's placement — and the JSON side did not, so the same
    // workspace landed differently depending on which file was exported.
    const raw = JSON.parse(groupsJson) as {
      model: { softwareSystems: Array<{ containers?: Array<Record<string, unknown>> }> }
    }
    const host = raw.model.softwareSystems.find((sys) => sys.containers?.length)!
    host.containers!.push({
      id: '901',
      name: 'Edge',
      tags: 'Element,Container,External',
      location: 'External',
    })
    const result = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(objectFor(result, '901')!.scope).toBe('internal')
  })

  it('lets `location` decide a system’s side when no tag does', () => {
    // The precedence the docstring claims and nothing tested: a tag is the
    // author's statement about THIS element and outranks the file's scope
    // field, but with no scope tag the field is all there is.
    const raw = JSON.parse(groupsJson) as {
      model: { softwareSystems: Array<Record<string, unknown>> }
    }
    raw.model.softwareSystems.push({ id: '902', name: 'Partner', tags: 'Element,Software System' })
    const untagged = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(objectFor(untagged, '902')!.scope).toBe('internal')
    raw.model.softwareSystems.at(-1)!.location = 'External'
    const external = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(objectFor(external, '902')!.scope).toBe('external')
    // …and a tag still wins over it, in both directions.
    raw.model.softwareSystems.at(-1)!.tags = 'Element,Software System,Internal'
    const overridden = mapWorkspace(parseWorkspaceJson(JSON.stringify(raw)))
    expect(objectFor(overridden, '902')!.scope).toBe('internal')
  })
})

describe('deployment nodes', () => {
  it('imports a node with nothing under it as a shape, at the coordinate the view gave it', () => {
    // Structurizr draws a childless node as a plain box. Importing it as a
    // boundary lost it entirely — a Group with no members has no geometry — so
    // it vanished from the model AND from a view that had placed it by hand.
    const firewall = objectFor(positioned, '20')!
    expect(firewall.name).toBe('Corporate firewall')
    expect(firewall.description).toBe('Filters inbound traffic')
    const deploymentDiagram = diagramFor(positioned, 'LiveDeployment')
    expect(deploymentDiagram.objectIds).toContain(firewall.id)
    expect(positioned.groups.some((g) => g.name === 'Corporate firewall')).toBe(false)
    // (200,1100) in wire space: below Route 53 at (200,300), left of the
    // instances at x=1100. Not packed below the diagram.
    const at = box(deploymentDiagram.layouts, firewall.id)
    const route53 = box(deploymentDiagram.layouts, objectFor(positioned, '19')!.id)
    const instance = box(deploymentDiagram.layouts, objectFor(positioned, '14')!.id)
    expect(at.x).toBe(route53.x)
    expect(at.y).toBeGreaterThan(route53.y)
    expect(at.x).toBeLessThan(instance.x)
    // It is inside its parent node's box, which is where the file drew it.
    const usEast = positioned.groups.find((g) => g.properties?.[SOURCE_ID_PROPERTY] === '11')!
    expect(contains(box(deploymentDiagram.layouts, usEast.id), at)).toBe(true)
    expect(positioned.warnings.some((w) => w.includes('Corporate firewall'))).toBe(false)
  })
})
