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

// End-to-end gates for the Structurizr JSON importer: what actually lands in the
// store after parse → map → layout, measured against the source workspace by the
// fidelity harness rather than by eye.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { structurizrJsonSource } from './structurizrJsonSource'
import { getImportSource, importSources } from './registry'
import type { ImportResult } from './types'
import { measureDiagram } from '../layout'
import { parseWorkspaceJson } from '../structurizr/json/parse'
import { StructurizrJsonError } from '../structurizr/json/types'
import { measureFidelity, formatFidelityReport, type FidelityReport } from './fidelity'
import { SOURCE_ID_PROPERTY } from '../structurizr/json/mapWorkspace'
import { useModelStore } from '../../stores/modelStore'
import bigBank from '../structurizr/fixtures/json/big-bank-plc.json?raw'
import groups from '../structurizr/fixtures/json/groups.json?raw'
import deploymentPositioned from '../structurizr/fixtures/json/deployment-positioned.json?raw'
import bigReal from '../structurizr/fixtures/json/big-real-workspace.json?raw'
import viewsWithoutOrder from '../structurizr/fixtures/json/views-without-order.json?raw'
import mixedRoutingRaw from '../structurizr/fixtures/json/mixed-preserved-and-auto.json?raw'
import noViewsRaw from '../structurizr/fixtures/json/no-views.json?raw'
import nestedGroupsSeparator from '../structurizr/fixtures/json/nested-groups-separator-positioned.json?raw'
import nestedGroupsOpaque from '../structurizr/fixtures/json/nested-groups-no-separator.json?raw'
import parallelEdges from '../structurizr/fixtures/json/parallel-edges-and-dynamic.json?raw'
import styledScope from '../structurizr/fixtures/json/styled-scope-listed-and-routed-edges.json?raw'
import positionedContainerAndDeployment from '../structurizr/fixtures/json/positioned-container-and-deployment.json?raw'

const FIXTURES: Record<string, string> = {
  'big-bank-plc': bigBank,
  groups,
  'deployment-positioned': deploymentPositioned,
  'big-real-workspace': bigReal,
  'views-without-order': viewsWithoutOrder,
  // Every fixture in `fixtures/json/` runs the whole sweep. A fixture nothing
  // imports is a file that documents a behaviour and gates none of it.
  'nested-groups-separator-positioned': nestedGroupsSeparator,
  'nested-groups-no-separator': nestedGroupsOpaque,
  'parallel-edges-and-dynamic': parallelEdges,
  'positioned-container-and-deployment': positionedContainerAndDeployment,
  'styled-scope-listed-and-routed-edges': styledScope,
  'mixed-preserved-and-auto': mixedRoutingRaw,
  'no-views': noViewsRaw,
  sample: structurizrJsonSource.placeholder!,
}

const run = (json: string) => structurizrJsonSource.run!(json)

/** The importer stamps the wire id, so the harness never has to guess. */
const report = (json: string, result: ImportResult): FidelityReport =>
  measureFidelity(parseWorkspaceJson(json), result, { sourceIdProperties: [SOURCE_ID_PROPERTY] })

describe('every fixture imports into a diagram the canvas can draw', () => {
  for (const [name, json] of Object.entries(FIXTURES)) {
    describe(name, () => {
      let result: ImportResult
      beforeAll(async () => {
        result = await run(json)
      }, 60_000)

      it('produces objects, diagrams and an entry point', () => {
        expect(result.objects.length).toBeGreaterThan(0)
        expect(result.diagrams.length).toBeGreaterThan(0)
        expect(result.entryDiagramId).toBeTruthy()
        expect(result.diagrams.some((d) => d.id === result.entryDiagramId)).toBe(true)
      })

      it('gives every object and group on every diagram a layout', () => {
        // Both paths — the file's own coordinates and ELK — have to end here, or
        // the store treats the shape as absent from the diagram.
        for (const d of result.diagrams) {
          for (const id of d.objectIds) expect(d.layouts?.[id], `${d.name}:${id}`).toBeDefined()
          for (const gid of d.groupIds) expect(d.layouts?.[gid], `${d.name}:group ${gid}`).toBeDefined()
        }
      })

      it('only draws connections whose endpoints are both on the diagram', () => {
        const byId = new Map(result.connections.map((c) => [c.id, c]))
        for (const d of result.diagrams) {
          const on = new Set(d.objectIds)
          for (const cid of d.connectionIds) {
            const c = byId.get(cid)
            expect(c, `${d.name}:${cid}`).toBeDefined()
            expect(on.has(c!.fromId) && on.has(c!.toId), `${d.name}:${cid}`).toBe(true)
          }
        }
      })

      it('meets the layout quality gates on every diagram', () => {
        const ctx = { objects: result.objects, connections: result.connections, groups: result.groups }
        for (const d of result.diagrams) {
          const { metrics } = measureDiagram(d, ctx)
          const msg = `${name} / ${d.name}: ${JSON.stringify(metrics)}`
          expect(metrics.nodeOverlaps, msg).toBe(0)
          expect(metrics.edgeNodeOverlaps, msg).toBe(0)
          expect(metrics.boundaryViolations, msg).toBe(0)
          expect(metrics.edgeCrossings, msg).toBeLessThanOrEqual(Math.max(1, Math.ceil(metrics.edgeCount * 0.35)))
          if (d.objectIds.length > 1) expect(metrics.minGap, msg).toBeGreaterThan(0)
        }
      }, 30_000)

      it('hangs every flow off a diagram, over connections that diagram carries', () => {
        for (const flow of result.flows ?? []) {
          const diagram = result.diagrams.find((d) => d.id === flow.diagramId)
          expect(diagram, flow.name).toBeDefined()
          const drawn = new Set(diagram!.connectionIds)
          for (const step of flow.steps) {
            if (step.type !== 'message') continue
            expect(drawn.has(step.connectionId), `${flow.name}:${step.title}`).toBe(true)
            expect(diagram!.objectIds).toContain(step.fromObjectId)
            expect(diagram!.objectIds).toContain(step.toObjectId)
          }
        }
      })
    })
  }
})

describe('fidelity against the source workspace — big-bank-plc.json', () => {
  let imported: ImportResult
  let fidelity: FidelityReport
  beforeAll(async () => {
    imported = await run(bigBank)
    fidelity = report(bigBank, imported)
  }, 60_000)

  it('carries the dynamic view out of the importer as a flow', () => {
    // `ImportResult` had no `flows` field before this source existed; without one
    // the sign-in sequence is silently the one view kind that never arrives.
    expect(imported.flows).toHaveLength(1)
    expect(imported.flows![0]!.name).toBe('SignIn')
    expect(imported.flows![0]!.steps).toHaveLength(6)
  })

  it('loses no authored relationship except the one between two deployment nodes', () => {
    const message = () => formatFidelityReport(fidelity)
    expect(fidelity.relationships.authored.expected, message()).toBe(27)
    expect(fidelity.relationships.authored.missing.map((m) => m.id), message()).toEqual(['93'])
    expect(fidelity.relationships.authored.missing[0]!.reason).toBe('endpoint-is-group')
    // Deployment replicas and implied edges all arrive as ORDINARY connections
    // — see the store-level gate below for why `kind: 'lower'` cannot be used.
    expect(fidelity.relationships.derived.matched).toBe(15)
    expect(fidelity.relationships.derived.missing).toEqual([])
    expect(fidelity.relationships.unexplainedConnectionIds).toEqual([])
  })

  it('imports every view except the image one, keyed by the view key', () => {
    expect(fidelity.views.expected).toBe(8)
    expect(fidelity.views.missing.map((v) => v.kind)).toEqual(['image'])
    expect(fidelity.views.weaklyMatchedKeys).toEqual([]) // every diagram matched on sourceViewKey
  })

  it('puts every element a view listed on the diagram, boundaries included', () => {
    // All 67 rows, and all 51 elements. The 7 that used to be reported missing
    // were deployment nodes imported correctly as boundaries: `Group` had no
    // `properties`, so three nodes all called "Apache Tomcat" could not be told
    // apart by anything — not this harness, not an exporter, not a re-import.
    expect(fidelity.viewMembership.expectedTotal).toBe(67)
    expect(fidelity.viewMembership.presentTotal).toBe(67)
    expect(fidelity.viewMembership.details.flatMap((d) => d.missing)).toEqual([])
    expect(fidelity.elements.missing).toEqual([])
    expect(fidelity.elements.matched).toBe(51)
    expect(fidelity.elements.weaklyMatchedIds).toEqual([]) // every one by stamped id
  })

  it('keeps every element name and every relationship label unchanged', () => {
    expect(fidelity.labels.elementNames.changed).toEqual([])
    expect(fidelity.labels.elementNames.vanished).toEqual([])
    expect(fidelity.labels.relationshipDescriptions.changed).toEqual([])
    expect(fidelity.labels.relationshipDescriptions.vanished).toEqual([])
    expect(fidelity.labels.relationshipDescriptions.compared).toBe(41)
  })

  it('lays out every view, because the file laid out none of them', () => {
    expect(fidelity.layout.sourceUnpositioned).toBe(7)
    expect(fidelity.layout.relaidOut).toBe(0)
  })

  it('nests a laid-out deployment boundary inside its parent node', async () => {
    // The layout engine sizes each group from its own members, so a node and the
    // node inside it come back with one shared border. This is the auto-layout
    // half of the nesting — the preserved half is covered in mapWorkspace.test.
    const result = await run(bigBank)
    const diagram = result.diagrams.find((d) => d.sourceViewKey === 'LiveDeployment')!
    const at = (name: string) => {
      const group = result.groups.find((g) => g.name === name && diagram.groupIds.includes(g.id))!
      const l = diagram.layouts![group.id]!
      return { x: l.position.x, y: l.position.y, right: l.position.x + l.size.width, bottom: l.position.y + l.size.height }
    }
    const outer = at('bigbank-db01')
    const inner = at('Oracle - Primary')
    expect(outer.x).toBeLessThan(inner.x)
    expect(outer.y).toBeLessThan(inner.y)
    expect(outer.right).toBeGreaterThan(inner.right)
    expect(outer.bottom).toBeGreaterThan(inner.bottom)
  }, 60_000)
})

describe('fidelity against the source workspace — big-real-workspace.json', () => {
  let fidelity: FidelityReport
  beforeAll(async () => {
    fidelity = report(bigReal, await run(bigReal))
  }, 60_000)

  it('keeps the hand-made layout of all six views', () => {
    // The one number that decides whether a migration is worth doing: this
    // workspace was arranged by hand, and re-laying it out would throw that away.
    expect(fidelity.layout.preserved, formatFidelityReport(fidelity)).toBe(6)
    expect(fidelity.layout.relaidOut).toBe(0)
    // The only ordering flip in the whole workspace is between two containers
    // the file placed 1px apart, which our scale rounds onto the same row. A
    // flip over a real distance would mean the arrangement moved.
    const flips = fidelity.layout.details.flatMap((d) => d.inversions)
    expect(flips.every((i) => Math.abs(i.sourceDelta) <= 2), JSON.stringify(flips)).toBe(true)
  })

  it('draws every relationship its views reference', () => {
    // 40 of 41: the LiveDeployment view draws the node-to-node replication edge.
    expect(fidelity.viewMembership.expectedRelationshipTotal).toBe(41)
    expect(fidelity.viewMembership.presentRelationshipTotal).toBe(40)
  })
})

describe('fidelity against the source workspace — the smaller fixtures', () => {
  it('loses nothing at all from groups.json', async () => {
    const fidelity = report(groups, await run(groups))
    const message = formatFidelityReport(fidelity)
    expect(fidelity.elements.matched, message).toBe(8)
    expect(fidelity.elements.missing, message).toEqual([])
    // One boundary per nesting LEVEL, because the workspace declares a separator.
    expect(fidelity.groups.separatorDeclared).toBe(true)
    expect(fidelity.groups.expected).toBe(5)
    expect(fidelity.groups.missing).toEqual([])
    expect(fidelity.relationships.authored.missing, message).toEqual([])
    expect(fidelity.relationships.derived.missing, message).toEqual([])
    expect(fidelity.views.missing, message).toEqual([])
    expect(fidelity.viewMembership.presentTotal).toBe(fidelity.viewMembership.expectedTotal)
  })

  it('loses nothing at all from deployment-positioned.json', async () => {
    const fidelity = report(deploymentPositioned, await run(deploymentPositioned))
    const message = formatFidelityReport(fidelity)
    expect(fidelity.elements.missing, message).toEqual([])
    expect(fidelity.relationships.authored.missing, message).toEqual([])
    expect(fidelity.viewMembership.presentTotal).toBe(10)
    // All six deployment nodes carry the SAME placeholder coordinate (175,175).
    // Reading those as six real positions made the harness report a perfectly
    // preserved view as SCRAMBLED — every inversion it found was between a node
    // and something else, never between two leaves. It now asks `elementRole`
    // which rows are boundaries instead of filtering on the literal (0,0), so
    // the four leaves (Route 53 → ELB → web instance → database instance) are
    // compared and nothing flips.
    const detail = fidelity.layout.details[0]!
    const nodeIds = new Set(
      parseWorkspaceJson(deploymentPositioned)
        .elements.filter((e) => e.kind === 'deploymentNode')
        .map((e) => e.id),
    )
    expect(detail.derivedBoundaries, message).toBe(nodeIds.size)
    expect(detail.comparableInSource, message).toBe(4)
    expect(detail.inversionCount, message).toBe(0)
    expect(detail.classification, message).toBe('preserved')
  })

  it('keeps both views of views-without-order.json', async () => {
    const fidelity = report(viewsWithoutOrder, await run(viewsWithoutOrder))
    expect(fidelity.views.matched).toBe(2)
    expect(fidelity.viewMembership.presentTotal).toBe(2)
    expect(fidelity.elements.missing).toEqual([])
  })
})

describe('what the STORE keeps, once the canvas has run over it', () => {
  // The fidelity harness stops at the `ImportResult`. Everything below runs the
  // result through `importModel` and then through the pass every diagram open
  // triggers (`CanvasView` calls `syncLowerConnections`; `scheduleSyncAll` calls
  // it for all of them), because that pass is allowed to DELETE connections.
  const load = (result: ImportResult) => {
    useModelStore.setState({
      objects: [], connections: [], groups: [], diagrams: [], flows: [],
      domains: [{ id: 'd0', name: 'Default', color: '#3B82F6' }],
      currentDiagramId: null, selectedItems: [],
    })
    useModelStore.getState().importModel({
      objects: result.objects,
      connections: result.connections,
      groups: result.groups,
      tags: result.tags,
      diagrams: result.diagrams,
      flows: result.flows,
    })
  }

  it('keeps every arrow on every imported diagram after a canvas-open sync', async () => {
    // The defect this pins: derived edges (deployment replicas, implied
    // relationships) were stamped `kind: 'lower'` because Structurizr calls them
    // derived. In THIS app `lower` means "a per-diagram roll-up the client
    // recomputes and never persists" — `bridge.ts` strips them from the model
    // doc and from every diagram's `connectionIds`, and `syncLowerConnections`
    // prunes any it did not just re-derive. It cannot re-derive these: it walks
    // `parentId`, and an instance deliberately has none. Measured before the
    // fix, big-bank-plc: LiveDeployment 6 -> 0 arrows, DevelopmentDeployment
    // 4 -> 0, and the loss survives a reload.
    const result = await run(bigBank)
    load(result)
    const before = new Map(useModelStore.getState().diagrams.map((d) => [d.name, d.connectionIds.length]))
    expect([...before.values()].every((n) => n > 0)).toBe(true)

    for (const diagram of useModelStore.getState().diagrams) {
      useModelStore.getState().syncLowerConnections(diagram.id)
    }

    const after = useModelStore.getState().diagrams
    for (const diagram of after) {
      // A roll-up may be ADDED (that is what the pass is for); nothing the
      // importer put on the diagram may disappear.
      expect(diagram.connectionIds.length, diagram.name).toBeGreaterThanOrEqual(before.get(diagram.name)!)
    }
    const live = after.find((d) => d.sourceViewKey === 'LiveDeployment')!
    const dev = after.find((d) => d.sourceViewKey === 'DevelopmentDeployment')!
    expect(live.connectionIds.length).toBeGreaterThanOrEqual(6)
    expect(dev.connectionIds.length).toBeGreaterThanOrEqual(4)
    // And every imported connection is still in the model, so a flush persists it.
    const kept = new Set(useModelStore.getState().connections.map((c) => c.id))
    for (const c of result.connections) expect(kept.has(c.id), c.label).toBe(true)
  }, 60_000)

  it('leaves a dynamic view’s steps on connections the diagram still carries', async () => {
    const result = await run(bigBank)
    load(result)
    for (const diagram of useModelStore.getState().diagrams) {
      useModelStore.getState().syncLowerConnections(diagram.id)
    }
    const state = useModelStore.getState()
    const flow = state.flows[0]!
    const diagram = state.diagrams.find((d) => d.id === flow.diagramId)!
    const drawn = new Set(diagram.connectionIds)
    for (const step of flow.steps) {
      if (step.type !== 'message') continue
      expect(drawn.has(step.connectionId), step.title).toBe(true)
    }
  }, 60_000)
})

describe('a workspace with some views arranged and some never laid out', () => {
  it('does not let the layout engine reroute an edge the file routed by hand', async () => {
    // `applyAutoLayout` patches `waypoints` / `labelPosition` / `shape` on the
    // CONNECTION, and a connection is shared by every diagram that draws it — 7
    // of big-bank's are on more than one view. So without a guard the ELK run
    // over the un-laid-out half draws its bends on the hand-arranged half. Every
    // other fixture is all-preserved or all-auto, which is exactly why this one
    // exists.
    const result = await run(mixedRoutingRaw)
    const arranged = result.diagrams.find((d) => d.sourceViewKey === 'Arranged')!
    const auto = result.diagrams.find((d) => d.sourceViewKey === 'NeverLaidOut')!
    expect(arranged.layouts).toBeDefined()

    const shared = result.connections.find((c) => c.label === 'Banks with')!
    expect(arranged.connectionIds).toContain(shared.id)
    expect(auto.connectionIds).toContain(shared.id)

    // The file's two bends, put through the arranged view's own transform.
    expect(shared.waypoints).toHaveLength(2)
    expect(shared.shape).toBe('straight')
    expect(shared.labelPosition).toBeCloseTo(0.3, 5)
    const [first, second] = shared.waypoints!
    expect(first!.y).toBe(second!.y) // orthogonal: the customer's two bends are level
    expect(first!.x).toBeLessThan(second!.x)
  }, 60_000)
})

describe('a workspace whose views live in another file', () => {
  it('imports a model that declares no views at all, and says it generated them', async () => {
    // Routine: `workspace.json` is often the model half of a pair. Reading it as
    // "0 diagrams" left the Import button permanently disabled and the whole
    // model unimportable, while the DSL importer handled the same content.
    const result = await run(noViewsRaw)
    expect(result.stats.objects).toBe(6)
    expect(result.stats.diagrams).toBeGreaterThan(0)
    expect(result.diagrams.map((d) => d.sourceViewKey)).toEqual([
      'SystemLandscape',
      'Containers-2',
      'Components-3',
    ])
    expect(result.entryDiagramId).toBe(result.diagrams[0]!.id)
    expect(result.warnings.some((w) => w.includes('declares no views'))).toBe(true)
    // Synthesis fills a gap; it never overrules a stated answer. A file WITH
    // views gets exactly the views it wrote.
    const declared = await run(groups)
    expect(declared.warnings.some((w) => w.includes('declares no views'))).toBe(false)
    for (const d of result.diagrams) {
      for (const id of [...d.objectIds, ...d.groupIds]) expect(d.layouts?.[id], `${d.name}:${id}`).toBeDefined()
    }
  }, 60_000)
})

describe('the source is wired into the app', () => {
  it('is registered as an available source that accepts .json files', () => {
    const registered = getImportSource('structurizr-json')
    expect(registered).toBe(structurizrJsonSource)
    expect(registered!.status).toBe('available')
    expect(registered!.fileAccept).toBe('.json,application/json')
    expect(importSources.filter((s) => s.status === 'available').every((s) => s.fileAccept)).toBe(true)
  })

  it('imports its own sample, which is the only thing the empty paste box shows', async () => {
    const result = await run(structurizrJsonSource.placeholder!)
    expect(result.stats.objects).toBe(4)
    expect(result.stats.diagrams).toBe(2)
    // The sample carries real coordinates, so it demonstrates the preserved path.
    const landscape = result.diagrams.find((d) => d.sourceViewKey === 'SystemLandscape')!
    const [user, system] = landscape.objectIds.map((id) => landscape.layouts![id]!.position.x)
    expect(user).toBeLessThan(system!)
  })

  it('rejects a file that is not a Structurizr workspace, naming what it found', async () => {
    await expect(run('not json at all')).rejects.toBeInstanceOf(StructurizrJsonError)
    await expect(run('{"format":"maplespire-model","objects":[]}')).rejects.toThrow(/MapleSpire model export/)
  })

  it('carries the dynamic view into the store as a flow, in the same transaction as its diagram', () => {
    // `ensureDiagramDoc` reads `state.flows` while flushing the new diagram, so a
    // flow that lands a beat later never reaches the document it belongs to.
    useModelStore.setState({
      objects: [], connections: [], groups: [], diagrams: [], flows: [],
      domains: [{ id: 'd0', name: 'Default', color: '#3B82F6' }],
      currentDiagramId: null, selectedItems: [],
    })
    const flow = {
      id: 'flow-1',
      name: 'SignIn',
      diagramId: 'diagram-1',
      steps: [
        { id: 's1', order: 1, type: 'message' as const, title: 'Submits credentials to', fromObjectId: 'o1', toObjectId: 'o2', connectionId: 'c1' },
      ],
    }
    useModelStore.getState().importModel({
      objects: [], connections: [], groups: [],
      diagrams: [{ id: 'diagram-1', name: 'SignIn', type: 'component', objectIds: [], connectionIds: [], groupIds: [] }],
      flows: [flow],
    })
    const state = useModelStore.getState()
    expect(state.flows).toHaveLength(1)
    expect(state.flows[0]!.diagramId).toBe('diagram-1')
    expect(state.flows[0]!.domainId).toBe('d0')
  })

  beforeEach(() => {
    useModelStore.setState({ flows: [] })
  })
})
