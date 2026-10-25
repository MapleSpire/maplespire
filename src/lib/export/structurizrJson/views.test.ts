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
 * The claim under test is not "the exporter produces a valid workspace" — it is
 * that a customer's arrangement survives leaving and coming back. So the central
 * tests here run the REAL importer on both ends: fixture → MapleSpire → wire →
 * MapleSpire, and then once more, because a transform that is merely close
 * drifts a little further on every pass and only shows itself on the third.
 *
 * The model half of the round trip is the fixture's own `model`, verbatim. That
 * is legitimate and deliberate: our wire ids ARE the ids the model carries
 * (`structurizr.id` provenance), so reusing the source model isolates the
 * question these tests exist to answer — where the shapes land. What the model
 * emitter writes is measured in `model.test.ts`, and whether the two agree about
 * an element's KIND is measured in `roundTrip.test.ts`, which resolves every
 * view reference against the model this exporter actually emitted.
 */

import { describe, expect, it } from 'vitest'
import type { Flow, Position } from '../../../types'
import { parseWorkspaceJson } from '../../structurizr/json/parse'
import { mapWorkspace, SOURCE_ID_PROPERTY } from '../../structurizr/json/mapWorkspace'
import type { ExportBundle } from '../types'
import { buildExportContext } from './types'
import type { WireDeploymentView, WireDynamicView, WireElementView, WireViewSet } from './types'
import { buildWireViewSet } from './views'
import bigBankJson from '../../structurizr/fixtures/json/big-bank-plc.json?raw'
import positionedJson from '../../structurizr/fixtures/json/positioned-container-and-deployment.json?raw'
import dynamicJson from '../../structurizr/fixtures/json/parallel-edges-and-dynamic.json?raw'
import routedJson from '../../structurizr/fixtures/json/styled-scope-listed-and-routed-edges.json?raw'
import mixedJson from '../../structurizr/fixtures/json/mixed-preserved-and-auto.json?raw'

const counter = () => {
  let n = 0
  return () => `id${(n += 1)}`
}

type Mapped = ReturnType<typeof mapWorkspace>

const importWorkspace = (raw: string): Mapped => mapWorkspace(parseWorkspaceJson(raw), { idFactory: counter() })

const flowsByDiagram = (flows: readonly Flow[]): Record<string, Flow[]> => {
  const out: Record<string, Flow[]> = {}
  for (const flow of flows) (out[flow.diagramId] ??= []).push(flow)
  return out
}

const bundleOf = (mapped: Mapped): ExportBundle => ({
  landscapeName: mapped.landscapeName ?? 'Workspace',
  generatedAt: '2026-08-11T00:00:00.000Z',
  diagrams: mapped.diagrams,
  activeDiagramId: mapped.entryDiagramId,
  flowsByDiagram: flowsByDiagram(mapped.flows),
  objects: mapped.objects,
  connections: mapped.connections,
  groups: mapped.groups,
  domains: [],
  tags: mapped.tags,
  decisionRecords: [],
})

const viewsOf = (mapped: Mapped): WireViewSet => buildWireViewSet(buildExportContext(bundleOf(mapped)))

/** The workspace a re-import sees: our views over the source file's own model. */
const rebuild = (source: string, views: WireViewSet): string => {
  const original = JSON.parse(source) as { model: unknown; views?: { configuration?: unknown } }
  return JSON.stringify({
    id: 1,
    name: 'Round trip',
    model: original.model,
    views: { ...views, ...(original.views?.configuration ? { configuration: original.views.configuration } : {}) },
  })
}

/** Every shape's position on one diagram, keyed by the wire id it came from —
 *  the only channel that survives two imports with fresh MapleSpire ids. */
const positionsByWireId = (mapped: Mapped, viewKey: string): Record<string, Position> => {
  const diagram = mapped.diagrams.find((d) => d.sourceViewKey === viewKey)
  if (!diagram) throw new Error(`no diagram for view "${viewKey}"`)
  const objectById = new Map(mapped.objects.map((object) => [object.id, object]))
  const out: Record<string, Position> = {}
  for (const [id, layout] of Object.entries(diagram.layouts ?? {})) {
    const wireId = objectById.get(id)?.properties[SOURCE_ID_PROPERTY]
    if (wireId) out[wireId] = layout.position
  }
  return out
}

const allViews = (views: WireViewSet) => Object.values(views).flat()
const rowsOf = (views: WireViewSet, key: string): WireElementView[] =>
  allViews(views).find((view) => view.key === key)?.elements ?? []
const at = (rows: readonly WireElementView[], id: string) => rows.find((row) => row.id === id)

describe('Structurizr JSON views — coordinates', () => {
  it('places every element of every view, including a diagram nothing ever laid out', () => {
    // big-bank-plc has 67 element views and all 67 on the origin, so the import
    // hands the diagrams to auto-layout and leaves `layouts` unset. An element
    // view with no coordinate is re-laid-out by the reader, which is the whole
    // failure this exporter exists to prevent — so they still have to be placed.
    const views = viewsOf(importWorkspace(bigBankJson))
    const rows = allViews(views).flatMap((view) => view.elements)

    expect(rows.length).toBeGreaterThan(30)
    for (const row of rows) {
      expect(Number.isFinite(row.x)).toBe(true)
      expect(Number.isFinite(row.y)).toBe(true)
    }
    const landscape = rowsOf(views, 'SystemLandscape')
    const distinct = new Set(landscape.map((row) => `${row.x},${row.y}`))
    expect(distinct.size).toBe(landscape.length)
  })

  it('never leaves a shape on the origin, where every reader calls it unplaced', () => {
    const views = viewsOf(importWorkspace(positionedJson))
    const container = rowsOf(views, 'Containers')
    expect(container.length).toBeGreaterThan(0)
    for (const row of container) expect(`${row.x},${row.y}`).not.toBe('0,0')
  })

  it('puts the coordinates back where the file had them', () => {
    // The file's container view runs x 150…1000, y 150…1650. Import scales it
    // down by 185/450 and translates the top-left to the canvas origin; the
    // export has to undo exactly that, so the shape at (1000,1650) comes back
    // 850 right and 1500 below the top-left one. Two roundings through a 2.4x
    // scale cost at most a pixel or so, which is why this is not exact equality.
    const views = viewsOf(importWorkspace(positionedJson))
    const rows = rowsOf(views, 'Containers')
    const person = at(rows, '1')!
    const web = at(rows, '3')!
    const database = at(rows, '5')!

    expect(Math.abs(web.x - person.x - 850)).toBeLessThanOrEqual(2)
    expect(Math.abs(database.y - person.y - 1500)).toBeLessThanOrEqual(2)
    expect(web.y).toBe(person.y)
  })

  it('scales each view by what that view will be divided by, not by one constant', () => {
    // The importer's factor is the MAXIMUM of (our box / their box) over a
    // view's own leaves, so it differs per view: a landscape of software systems
    // (200 wide) is scaled by 200/450, an ordinary container view (185) by
    // 185/450. Exporting everything at the container view's 2.43x would spread
    // this landscape by 8% on every round trip — a diagram that grows a little
    // each time the customer moves their workspace between two tools.
    const views = viewsOf(importWorkspace(mixedJson))
    const rows = rowsOf(views, 'Arranged')
    const gap = at(rows, '2')!.x - at(rows, '1')!.x

    expect(Math.abs(gap - 1400)).toBeLessThanOrEqual(2)
  })

  it('leaves a deployment boundary on the origin and places what is inside it', () => {
    // (0,0) is the wire's word for "this box is derived from its children"; the
    // importer read the file's nodes that way, and inventing a coordinate for
    // one on the way out would pin a box Structurizr computes.
    const views = viewsOf(importWorkspace(positionedJson))
    const deployment = views.deploymentViews?.[0] as WireDeploymentView
    expect(deployment.environment).toBe('Live')

    const nodes = deployment.elements.filter((row) => row.x === 0 && row.y === 0)
    expect(nodes.map((row) => row.id).sort()).toEqual(['10', '11', '12', '13', '15', '17'])
    // The instances and the infrastructure node are shapes and carry real places.
    for (const id of ['14', '16', '18', '19', '20']) {
      expect(at(deployment.elements, id)).toBeDefined()
      expect(`${at(deployment.elements, id)!.x},${at(deployment.elements, id)!.y}`).not.toBe('0,0')
    }
  })

  it('never emits automaticLayout, which would discard the coordinates it just wrote', () => {
    const serialised = JSON.stringify(viewsOf(importWorkspace(bigBankJson)))
    expect(serialised).not.toContain('automaticLayout')
    expect(serialised).not.toContain('"applied"')
  })
})

describe('Structurizr JSON views — the round trip is a fixed point', () => {
  const fixedPoint = (fixture: string, viewKeys: readonly string[]) => {
    const first = importWorkspace(fixture)
    const exported = viewsOf(first)
    const second = importWorkspace(rebuild(fixture, exported))
    const reExported = viewsOf(second)
    return { first, exported, second, reExported, viewKeys }
  }

  it('leaves every shape exactly where it was after import → export → import', () => {
    const { first, second } = fixedPoint(positionedJson, ['Containers', 'LiveDeployment'])
    for (const key of ['Containers', 'LiveDeployment']) {
      expect(positionsByWireId(second, key)).toEqual(positionsByWireId(first, key))
    }
  })

  it('writes the same file the second time — a diagram that drifts fails on the third pass', () => {
    const { exported, reExported } = fixedPoint(positionedJson, [])
    expect(reExported).toEqual(exported)
  })

  it('holds for a workspace whose views are a container view and a dynamic one', () => {
    const { first, second, exported, reExported } = fixedPoint(dynamicJson, ['Containers'])
    expect(positionsByWireId(second, 'Containers')).toEqual(positionsByWireId(first, 'Containers'))
    expect(reExported).toEqual(exported)
  })

  it('holds for a landscape of systems, whose scale is not the container-view one', () => {
    const { first, second, exported, reExported } = fixedPoint(mixedJson, ['Arranged'])
    expect(positionsByWireId(second, 'Arranged')).toEqual(positionsByWireId(first, 'Arranged'))
    // "NeverLaidOut" carried no layout at all, so the first export placed it in
    // a grid. That grid is a real arrangement on the way back in, and it must
    // survive the next pass unchanged like any other.
    expect(reExported).toEqual(exported)
  })

  it('holds for a view whose scope is listed among its own elements and whose edges are routed', () => {
    const { first, second, exported, reExported } = fixedPoint(routedJson, ['Containers'])
    expect(positionsByWireId(second, 'Containers')).toEqual(positionsByWireId(first, 'Containers'))
    expect(reExported).toEqual(exported)
  })
})

describe('Structurizr JSON views — view kinds and scopes', () => {
  it('gives each view kind the scope id that kind requires', () => {
    const views = viewsOf(importWorkspace(bigBankJson))

    expect(views.systemLandscapeViews?.map((view) => view.key)).toContain('SystemLandscape')
    expect(views.containerViews?.[0]?.softwareSystemId).toBe('7')
    // A component view is scoped by a container id ONLY — it has no
    // softwareSystemId at all upstream.
    expect(views.componentViews?.[0]?.containerId).toBe('11')
    expect(views.componentViews?.[0]).not.toHaveProperty('softwareSystemId')
    expect(views.deploymentViews?.map((view) => view.environment).sort()).toEqual(['Development', 'Live'])
  })

  it('makes a system context diagram a context view only when it drills into a system', () => {
    // The scope of a system CONTEXT view is not kept by the JSON importer
    // (`mapWorkspace` reads `scopeId` for container/component views only), so
    // nothing on the diagram remembers it and there is nothing here to recover:
    // big-bank's "SystemContext" comes back as a landscape view — every shape
    // and every coordinate intact, the view kind downgraded. A diagram that
    // MapleSpire itself drilled into a system does carry `parentObjectId`, and
    // that one is emitted as a system context view.
    const mapped = importWorkspace(bigBankJson)
    const context = mapped.diagrams.find((d) => d.sourceViewKey === 'SystemContext')!
    expect(context.parentObjectId).toBeUndefined()
    expect(viewsOf(mapped).systemLandscapeViews?.map((view) => view.key)).toContain('SystemContext')

    const bundle = bundleOf(mapped)
    const system = mapped.objects.find((object) => object.properties[SOURCE_ID_PROPERTY] === '7')!
    bundle.diagrams = bundle.diagrams.map((d) =>
      d.id === context.id ? { ...d, parentObjectId: system.id } : d,
    )
    const drilled = buildWireViewSet(buildExportContext(bundle))
    expect(drilled.systemContextViews?.map((view) => [view.key, view.softwareSystemId])).toEqual([
      ['SystemContext', '7'],
    ])
  })

  it('scopes a deployment view to the system its instances instantiate', () => {
    // An instance has no parent among the shapes — its parent is a deployment
    // node, which is a group — so walking the hierarchy from one reaches the top
    // and lands on the wrapper the orphan containers use. `structurizr.instanceOf`
    // is the channel that answers it properly.
    const views = viewsOf(importWorkspace(positionedJson))
    expect(views.deploymentViews?.[0]?.softwareSystemId).toBe('2')
  })

  it('honours a layout scale the caller named', () => {
    const bundle = bundleOf(importWorkspace(positionedJson))
    const views = buildWireViewSet(buildExportContext(bundle, { layoutScale: 1 }))
    const rows = rowsOf(views, 'Containers')
    // Unscaled, the 850 wire px between two of these shapes come back as the
    // ~349 canvas px the import turned them into.
    expect(at(rows, '3')!.x - at(rows, '1')!.x).toBe(349)
  })

  it('keeps the view key each diagram was imported under', () => {
    const views = viewsOf(importWorkspace(bigBankJson))
    const keys = allViews(views).map((view) => view.key)
    expect(keys).toContain('Containers')
    expect(keys).toContain('Components')
    expect(keys).toContain('LiveDeployment')
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('Structurizr JSON views — flows become dynamic views', () => {
  const dynamicOf = (raw: string): WireDynamicView => {
    const views = viewsOf(importWorkspace(raw))
    const view = views.dynamicViews?.[0]
    if (!view) throw new Error('no dynamic view was emitted')
    return view
  }

  it('numbers the steps as strings and marks a return leg as a response', () => {
    const view = dynamicOf(dynamicJson)
    expect(view.key).toBe('PlaceOrder')
    expect(view.relationships?.map((row) => row.order)).toEqual(['1', '2', '3', '4', '5', '6'])
    for (const row of view.relationships ?? []) expect(typeof row.order).toBe('string')

    const responses = (view.relationships ?? []).filter((row) => row.response === true)
    expect(responses.map((row) => row.description)).toEqual(['Returns the stored order', 'Confirms the order'])
    // v6.2.0 refuses a response with no request, so every response must be
    // preceded by a forward row on the same relationship.
    for (const response of responses) {
      const before = (view.relationships ?? []).slice(0, view.relationships!.indexOf(response))
      expect(before.some((row) => row.id === response.id && row.response !== true)).toBe(true)
    }
  })

  it('leaves out a backwards step it cannot state, rather than drawing it forwards', () => {
    // v6.2.0 refuses a response with no request, and a flow can legitimately
    // start on the return leg — MapleSpire lets a step run either way down an
    // edge. Emitting it as an ORDINARY step would make a reader draw it
    // source → destination: "the store acknowledges the service" would be
    // exported as "the service notifies the store". A missing step is recoverable; a step pointing the wrong way is a
    // diagram that states the opposite of what was drawn.
    const mapped = importWorkspace(dynamicJson)
    const diagram = mapped.diagrams.find((d) => d.sourceViewKey === 'Containers')!
    const notifies = mapped.connections.find((c) => c.label === 'Notifies')!
    const bundle = bundleOf(mapped)
    bundle.flowsByDiagram = {
      [diagram.id]: [
        {
          id: 'flow-backwards',
          name: 'Acknowledgement first',
          diagramId: diagram.id,
          steps: [
            {
              id: 'step-1',
              order: 1,
              type: 'message',
              title: 'Acknowledges',
              // The edge runs store → service; this step runs service → store.
              fromObjectId: notifies.toId,
              toObjectId: notifies.fromId,
              connectionId: notifies.id,
            },
          ],
        },
      ],
    }
    const ctx = buildExportContext(bundle)
    const views = buildWireViewSet(ctx)

    // No row at all, and therefore no dynamic view: the one step it had could
    // not be stated. Emitting a forward row here would reverse the interaction.
    // The diagram still leaves as an ordinary view — which draws the edge the
    // way the MODEL has it, source to destination, and claims nothing about
    // order.
    expect(views.dynamicViews).toBeUndefined()
    expect(
      ctx.warnings.some((warning) => warning.includes('drawn pointing the other way')),
      ctx.warnings.join('\n'),
    ).toBe(true)
  })

  it('still marks a backwards step as a response once the flow has used the edge forwards', () => {
    // The rule is not "backwards steps are dropped" — it is that a response
    // needs its request. With one, the return leg is expressible and is kept.
    const mapped = importWorkspace(dynamicJson)
    const diagram = mapped.diagrams.find((d) => d.sourceViewKey === 'Containers')!
    const notifies = mapped.connections.find((c) => c.label === 'Notifies')!
    const bundle = bundleOf(mapped)
    bundle.flowsByDiagram = {
      [diagram.id]: [
        {
          id: 'flow-both-ways',
          name: 'Notify then acknowledge',
          diagramId: diagram.id,
          steps: [
            {
              id: 'step-1',
              order: 1,
              type: 'message',
              title: 'Notifies',
              fromObjectId: notifies.fromId,
              toObjectId: notifies.toId,
              connectionId: notifies.id,
            },
            {
              id: 'step-2',
              order: 2,
              type: 'message',
              title: 'Acknowledges',
              fromObjectId: notifies.toId,
              toObjectId: notifies.fromId,
              connectionId: notifies.id,
            },
          ],
        },
      ],
    }
    const rows = buildWireViewSet(buildExportContext(bundle)).dynamicViews?.[0]?.relationships ?? []

    expect(rows.map((row) => [row.order, row.description, row.response ?? false])).toEqual([
      ['1', 'Notifies', false],
      ['2', 'Acknowledges', true],
    ])
  })

  it('carries the same coordinates as any other view', () => {
    const view = dynamicOf(dynamicJson)
    expect(view.elements.length).toBe(3)
    for (const row of view.elements) expect(`${row.x},${row.y}`).not.toBe('0,0')
  })

  it('does not also emit a static view for the diagram it came from', () => {
    // A dynamic view re-imports as a diagram AND a flow, so emitting both would
    // double the diagram on every round trip.
    const views = viewsOf(importWorkspace(dynamicJson))
    const keys = allViews(views).map((view) => view.key)
    expect(keys.filter((key) => key === 'PlaceOrder')).toEqual(['PlaceOrder'])
    expect(views.containerViews?.map((view) => view.key)).toEqual(['Containers'])
  })
})

describe('Structurizr JSON views — drawn edges', () => {
  it('re-emits the bends, the label position and a line shape for a routed edge', () => {
    const views = viewsOf(importWorkspace(routedJson))
    const rows = views.containerViews?.[0]?.relationships ?? []
    const routed = rows.find((row) => row.id === '20')!
    const plain = rows.find((row) => row.id === '22')!

    expect(routed.vertices).toHaveLength(2)
    // The bends are stored in the same space as the shapes, so they go through
    // the view's transform too or the line detaches from what it joins.
    const web = at(rowsOf(views, 'Containers'), '2')!
    const queue = at(rowsOf(views, 'Containers'), '3')!
    for (const vertex of routed.vertices ?? []) {
      expect(vertex.x).toBeGreaterThan(Math.min(web.x, queue.x))
      expect(vertex.y).toBeGreaterThan(Math.min(web.y, queue.y))
    }
    // 0–100 ALONG the line upstream, a 0–1 fraction here.
    expect(routed.position).toBe(80)
    expect(plain.position).toBe(20)
    // `Orthogonal` came in as a straight line, and straight is what goes back.
    expect(routed.routing).toBe('Direct')
  })

  it('routes a derived (lower) edge as its diagram draws it — from `lowerRouting`, not the shared object', () => {
    const mapped = importWorkspace(routedJson)
    const diagram = mapped.diagrams.find((d) => d.sourceViewKey === 'Containers')!
    const plain = mapped.connections.find((c) => c.properties?.[SOURCE_ID_PROPERTY] === '22')!
    const bundle = bundleOf(mapped)
    const asLower = { ...plain, kind: 'lower' as const, waypoints: undefined, labelPosition: 0.2 }
    bundle.connections = bundle.connections.map((c) => (c.id === plain.id ? asLower : c))
    const bends: Position[] = [{ x: 300, y: 300 }, { x: 400, y: 300 }]
    bundle.diagrams = bundle.diagrams.map((d) => d.id === diagram.id
      ? { ...d, lowerRouting: { [`${plain.fromId}→${plain.toId}`]: { waypoints: bends, labelPosition: 0.8, shape: 'straight' } } }
      : d)

    const row = buildWireViewSet(buildExportContext(bundle)).containerViews?.[0]?.relationships?.find((r) => r.id === '22')

    expect(row?.vertices).toHaveLength(2)
    expect(row?.position).toBe(80)
    expect(row?.routing).toBe('Direct')
  })

  it('leaves an edge off a view that does not draw both of its ends', () => {
    const mapped = importWorkspace(routedJson)
    const diagram = mapped.diagrams.find((d) => d.sourceViewKey === 'Containers')!
    const bundle = bundleOf(mapped)
    // Take the operator off the diagram but leave the connection on it: the
    // remaining line would be drawn into empty space.
    const operator = mapped.objects.find((object) => object.name === 'Operator')!
    bundle.diagrams = bundle.diagrams.map((d) =>
      d.id === diagram.id ? { ...d, objectIds: d.objectIds.filter((id) => id !== operator.id) } : d,
    )
    const ctx = buildExportContext(bundle)
    const views = buildWireViewSet(ctx)

    expect(views.containerViews?.[0]?.relationships?.map((row) => row.id)).toEqual(['20'])
    expect(ctx.warnings.some((warning) => warning.includes('Administers'))).toBe(true)
  })
})
