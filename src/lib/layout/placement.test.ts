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

// Placement regressions for the on-canvas Auto-layout (optimizeDiagram → bestLayout,
// no direction hint), driven on the real fixtures the reported diagrams came from.
// Defect reported 2026-10-21 on the SAOE landscape: Auto-layout scattered the people
// of `FSSystemContext` above AND below Microsoft Power Platform SAOE, with long
// S-curves and a braided reciprocal pair; the group views put a non-member inside a
// group box.

import { describe, it, expect } from 'vitest'
import { parseWorkspace } from '../structurizr/parser'
import { mapWorkspace } from '../structurizr/mapper'
import { applyAutoLayout, bestLayout, type LayoutContext } from './index'
import { buildLayoutGraph, deriveGroupBoxes, layeringEdges, nestGroups } from './graph'
import { layoutDiagramElk } from './elk/elkLayout'
import { STRATEGIES } from './elk/elkConfig'
import { autoSizedInnerGroupIds } from '../groupNesting'
import { computeMetrics, type Rect } from './metrics'
import { parseWorkspaceJson } from '../structurizr/json/parse'
import { mapWorkspace as mapWorkspaceJson } from '../structurizr/json/mapWorkspace'
import type { C4Object, Connection, Diagram, Group } from '../../types'
import saoe from '../structurizr/fixtures/saoe.dsl?raw'
import grouped from '../structurizr/fixtures/grouped.dsl?raw'
import bigBankJson from '../structurizr/fixtures/json/big-bank-plc.json?raw'

type Box = { x: number; y: number; width: number; height: number }

/** Map a fixture and add the `kind: 'lower'` connections the store derives, as
 * modelStore's deriveLowerConnections does: every direct connection whose endpoints
 * roll up to a different visible pair yields one lower connection per DIRECTED pair
 * (shared by diagrams) — EVEN when a direct connection already joins that pair. The
 * live app lays out with those present; the bare mapper output has none. */
function load(dsl: string): { diagrams: Diagram[]; ctx: LayoutContext } {
  let n = 0
  const m = mapWorkspace(parseWorkspace(dsl), { idFactory: () => `id${++n}` })
  const objectById = new Map(m.objects.map((o) => [o.id, o]))
  const connections: Connection[] = [...m.connections]
  const lowerByPair = new Map<string, string>()
  const diagrams = m.diagrams.map((d) => {
    const on = new Set(d.objectIds)
    const visible = (id: string): string | undefined => {
      let cur: string | undefined = id
      for (let guard = 0; cur && !on.has(cur) && guard < 50; guard++) cur = objectById.get(cur)?.parentId
      return cur && on.has(cur) ? cur : undefined
    }
    const extra: string[] = []
    for (const c of m.connections) {
      const vf = visible(c.fromId)
      const vt = visible(c.toId)
      if (!vf || !vt || vf === vt || (vf === c.fromId && vt === c.toId)) continue
      const key = `${vf}→${vt}`
      let id = lowerByPair.get(key)
      if (!id) {
        id = `lower${lowerByPair.size}`
        lowerByPair.set(key, id)
        connections.push({ id, fromId: vf, toId: vt, kind: 'lower', type: 'dashed', label: '' })
      }
      if (!extra.includes(id)) extra.push(id)
    }
    return { ...d, connectionIds: [...d.connectionIds, ...extra] }
  })
  return { diagrams, ctx: { objects: m.objects, connections, groups: m.groups } }
}

const boxOf = (layouts: Record<string, { position: { x: number; y: number }; size: { width: number; height: number } }>, id: string): Box => {
  const l = layouts[id]
  return { x: l.position.x, y: l.position.y, width: l.size.width, height: l.size.height }
}
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

describe('layeringEdges — the ranking graph', () => {
  const actor = (id: string) => id.startsWith('p')
  it('ranks people first: an edge into a person is turned around', () => {
    expect(layeringEdges([{ id: 'e', fromId: 'sys', toId: 'p1' }], actor)).toEqual([{ id: 'e', fromId: 'p1', toId: 'sys' }])
    expect(layeringEdges([{ id: 'e', fromId: 'p1', toId: 'p2' }], actor)).toEqual([{ id: 'e', fromId: 'p1', toId: 'p2' }])
  })
  it('counts a reciprocal pair once', () => {
    const out = layeringEdges(
      [
        { id: 'a', fromId: 'x', toId: 'y' },
        { id: 'b', fromId: 'y', toId: 'x' },
      ],
      actor,
    )
    expect(out).toEqual([{ id: 'a', fromId: 'x', toId: 'y' }])
  })
})

describe('Auto-layout placement — SAOE FSSystemContext (reported defect)', () => {
  const { diagrams, ctx } = load(saoe)
  const d = diagrams.find((x) => x.name === 'FSSystemContext')!
  const idOf = (name: string) => ctx.objects.find((o) => o.name === name && d.objectIds.includes(o.id))!.id

  it('puts every person on one side of the system and the external system on the other', async () => {
    const sol = await bestLayout(d, ctx)
    const hub = boxOf(sol.layouts, idOf('Microsoft Power Platform SAOE'))
    const people = ['Inspecteur', 'Répartiteur', 'Employé', 'Agent'].map((n) => boxOf(sol.layouts, idOf(n)))
    const sharePoint = boxOf(sol.layouts, idOf('SharePoint Online'))
    // People first: entirely above the hub (DOWN) or entirely left of it (RIGHT) —
    // never split around it, which is what the reported layout did.
    const above = people.every((p) => p.y + p.height <= hub.y)
    const left = people.every((p) => p.x + p.width <= hub.x)
    expect(above || left, JSON.stringify({ hub, people })).toBe(true)
    if (above) expect(sharePoint.y).toBeGreaterThanOrEqual(hub.y + hub.height)
    else expect(sharePoint.x).toBeGreaterThanOrEqual(hub.x + hub.width)
    expect(sol.metrics.edgeCrossings).toBe(0)
  })

  it('draws the Inspecteur ↔ Power Platform pair as two distinct lines', async () => {
    const sol = await bestLayout(d, ctx)
    const insp = idOf('Inspecteur')
    const hub = idOf('Microsoft Power Platform SAOE')
    const pair = sol.edgeGeoms.filter((e) => (e.fromId === insp && e.toId === hub) || (e.fromId === hub && e.toId === insp))
    expect(pair).toHaveLength(2)
    const [a, b] = pair
    // Like ends (the end on the same node) sit apart at both nodes.
    const at = (e: typeof a, node: string) => (e.fromId === node ? e.points[0] : e.points[e.points.length - 1])
    for (const node of [insp, hub]) {
      const p = at(a, node)
      const q = at(b, node)
      expect(Math.hypot(p.x - q.x, p.y - q.y), node).toBeGreaterThanOrEqual(20)
    }
  })
})

describe('Auto-layout placement — dense container views (free-order strategies)', () => {
  // Measured 2026-10-22 on THIS tree: with every strategy keeping the model order,
  // the best candidate scored 131 (4 crossings) on SAOEPermitContainers and 128 on
  // FSContainers; the free-order strategies bring them to 109 (3) and 85. These
  // pin the free-order pair (ignoring `freeOrder` fails both); they are not a
  // before/after against the parent commit, whose scoring differed and which
  // already met both thresholds (QA lens).
  const { diagrams, ctx } = load(saoe)
  const view = (name: string) => diagrams.find((x) => x.name === name)!

  it('SAOEPermitContainers: at most 3 crossings, score under 120', async () => {
    const sol = await bestLayout(view('SAOEPermitContainers'), ctx)
    expect(sol.metrics.edgeCrossings).toBeLessThanOrEqual(3)
    expect(sol.metrics.score).toBeLessThan(120)
  })

  it('FSContainers: score under 100', async () => {
    const sol = await bestLayout(view('FSContainers'), ctx)
    expect(sol.metrics.score).toBeLessThan(100)
  })
})

describe('buildLayoutGraph — several connections on one pair', () => {
  const obj = (id: string): C4Object =>
    ({ id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 100, height: 60 }, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {} }) as C4Object
  const conn = (id: string): Connection => ({ id, fromId: 'a', toId: 'b', type: 'solid' })
  const graphFor = (drawnIds: string[]) => {
    const diagram = { id: 'd', name: 'd', type: 'container', objectIds: ['a', 'b'], connectionIds: drawnIds, groupIds: [] } as unknown as Diagram
    const objects = new Map([obj('a'), obj('b')].map((o) => [o.id, o]))
    return buildLayoutGraph(diagram, objects, [], [conn('c1'), conn('c2')]).edges.map((e) => e.id)
  }
  it('lays out both when both are drawn (each gets its own lane)', () => {
    expect(graphFor(['c1', 'c2'])).toEqual(['c1', 'c2'])
  })
  it('lays out only the drawn one when the first is not on this diagram', () => {
    expect(graphFor(['c2'])).toEqual(['c2'])
  })
})

describe('Auto-layout routing — a direct connection and its rolled-up twin (SAOE permit containers)', () => {
  // Angular Web App - Employé → Node.js API exists as a direct connection AND as the
  // store's `lower` roll-up of Enterprise Module → Enterprise Controller. Both are
  // drawn; the layout used to drop the second, leaving it unanchored on top of its twin.
  const { diagrams, ctx } = load(saoe)
  const d = diagrams.find((x) => x.name === 'SAOEPermitContainers')!
  const idOf = (name: string) => ctx.objects.find((o) => o.name === name && d.objectIds.includes(o.id))!.id

  it('lays out both connections of the pair as separate lines', async () => {
    const from = idOf('Angular Web App - Employé')
    const to = idOf('Node.js API')
    const twins = ctx.connections.filter((c) => c.fromId === from && c.toId === to && d.connectionIds.includes(c.id))
    expect(twins.map((c) => c.kind ?? 'direct').sort()).toEqual(['direct', 'lower'])
    const sol = await bestLayout(d, ctx)
    for (const c of twins) expect(sol.connPatches[c.id], c.kind ?? 'direct').toBeDefined()
    const geoms = sol.edgeGeoms.filter((e) => twins.some((c) => c.id === e.id))
    expect(geoms).toHaveLength(2)
    const [a, b] = geoms
    const gap = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y)
    expect(gap(a.points[0], b.points[0])).toBeGreaterThanOrEqual(20)
    expect(gap(a.points[a.points.length - 1], b.points[b.points.length - 1])).toBeGreaterThanOrEqual(20)
  })
})

describe('Auto-layout placement — groups keep non-members out (grouped.dsl)', () => {
  const { diagrams, ctx } = load(grouped)

  it('Landscape: Legacy ERP (not in "Cloud") never touches the Cloud box', async () => {
    const d = diagrams.find((x) => x.name === 'Landscape')!
    const sol = await bestLayout(d, ctx)
    const cloud = ctx.groups.find((g) => g.name === 'Cloud')!
    const legacy = ctx.objects.find((o) => o.name === 'Legacy ERP')!
    expect(overlaps(boxOf(sol.layouts, legacy.id), boxOf(sol.layouts, cloud.id))).toBe(false)
  })

  it('ApiContainers: the person sits above the system boundary', async () => {
    const d = diagrams.find((x) => x.name === 'ApiContainers')!
    const sol = await bestLayout(d, ctx)
    const user = boxOf(sol.layouts, ctx.objects.find((o) => o.name === 'End User')!.id)
    const boundary = boxOf(sol.layouts, d.groupIds.find((gid) => ctx.groups.find((g) => g.id === gid)?.parentObjectId)!)
    expect(user.y + user.height).toBeLessThanOrEqual(boundary.y)
  })
})

describe('nestGroups — nesting read from membership', () => {
  const group = (id: string, objectIds: string[]): Group => ({ id, name: id, color: '#fff', objectIds }) as Group
  const diagram = (groupIds: string[], layouts: Diagram['layouts'] = {}) =>
    ({ id: 'd', name: 'd', type: 'deployment', objectIds: ['a', 'b', 'c', 'x'], connectionIds: [], groupIds, layouts }) as unknown as Diagram
  const nodes = new Set(['a', 'b', 'c', 'x'])

  it('nests a subset inside its superset, members in the innermost group', () => {
    const n = nestGroups(diagram(['outer', 'inner']), [group('outer', ['a', 'b', 'c']), group('inner', ['a', 'b'])], nodes)
    expect(n.compoundParent.get('inner')).toBe('outer')
    expect(n.compoundOf.get('a')).toBe('inner')
    expect(n.compoundOf.get('c')).toBe('outer')
    expect(n.loose.size).toBe(0)
  })

  it('orders equal auto-sized member sets by id, the smaller outside, as the canvas draws them', () => {
    const gs = [group('q', ['a']), group('p', ['a'])]
    const boxes = { q: { position: { x: 0, y: 0 }, size: { width: 400, height: 300 } }, p: { position: { x: 30, y: 52 }, size: { width: 200, height: 150 } } }
    expect(nestGroups(diagram(['q', 'p'], boxes), gs, nodes, { p: 11, q: 10 }).compoundParent.get('q')).toBe('p')
  })

  it('orders equal STORED member sets by the depth hint, then the current box, then diagram order', () => {
    const gs = [{ ...group('p', ['a']), autoSize: false }, { ...group('q', ['a']), autoSize: false }]
    // Diagram order alone: earlier is outer.
    expect(nestGroups(diagram(['p', 'q']), gs, nodes).compoundParent.get('q')).toBe('p')
    // A bigger current box is outer, whatever the order.
    const boxes = { q: { position: { x: 0, y: 0 }, size: { width: 400, height: 300 } }, p: { position: { x: 30, y: 52 }, size: { width: 200, height: 150 } } }
    expect(nestGroups(diagram(['p', 'q'], boxes), gs, nodes).compoundParent.get('p')).toBe('q')
    // The caller's depth hint wins over both.
    expect(nestGroups(diagram(['p', 'q'], boxes), gs, nodes, { p: 10, q: 11 }).compoundParent.get('q')).toBe('p')
  })

  it('leaves partly overlapping groups loose (a node has one parent)', () => {
    const n = nestGroups(diagram(['l', 'r']), [group('l', ['a', 'b']), group('r', ['b', 'c'])], nodes)
    expect([...n.loose].sort()).toEqual(['l', 'r'])
    expect(n.compoundOf.size).toBe(0)
  })
})

describe('group boxes — what ELK reserves, what the canvas draws (review lenses, 2026-10-22)', () => {
  const object = (id: string, type = 'app'): C4Object =>
    ({ id, type, name: id, position: { x: 0, y: 0 }, size: { width: 150, height: 90 }, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {} }) as unknown as C4Object
  const link = (id: string, fromId: string, toId: string): Connection => ({ id, fromId, toId, type: 'solid', label: 'uses' })
  const view = (objectIds: string[], connectionIds: string[], groupIds: string[]) =>
    ({ id: 'v', name: 'v', type: 'container', objectIds, connectionIds, groupIds, layouts: {} }) as unknown as Diagram
  const group = (id: string, objectIds: string[], extra: Partial<Group> = {}): Group =>
    ({ id, name: id, color: '#fff', objectIds, autoSize: false, ...extra }) as Group

  // Reviewer lens: a title wider than the group's content. ELK applied the width
  // floor on the HEIGHT axis under DOWN, and the box was then widened over its
  // neighbours; the `tb` hint picked exactly that candidate.
  it('a group titled wider than its content never covers a neighbour — with or without a tb hint', async () => {
    const long = 'A deliberately long group title that is far wider than its member'
    const objects = ['hub', 'm1', 'm2', 's1', 's2', 's3'].map((id) => object(id))
    const connections = ['m1', 'm2', 's1', 's2', 's3'].map((to, i) => link(`e${i}`, 'hub', to))
    const groups = [group('g1', ['m1'], { name: long }), group('g2', ['m2'], { name: `${long}!` })]
    const d = view(objects.map((o) => o.id), connections.map((c) => c.id), ['g1', 'g2'])
    for (const hint of [undefined, 'tb', 'lr'] as const) {
      const sol = await bestLayout(d, { objects, connections, groups }, hint)
      const g1 = boxOf(sol.layouts, 'g1')
      const g2 = boxOf(sol.layouts, 'g2')
      expect(overlaps(g1, g2), `[${hint}] g1 over g2`).toBe(false)
      for (const id of ['hub', 'm2', 's1', 's2', 's3']) expect(overlaps(boxOf(sol.layouts, id), g1), `[${hint}] ${id} in g1`).toBe(false)
      for (const id of ['hub', 'm1', 's1', 's2', 's3']) expect(overlaps(boxOf(sol.layouts, id), g2), `[${hint}] ${id} in g2`).toBe(false)
    }
  })

  // Architect lens: a model group that only partly overlaps a system boundary
  // must not demote the boundary — before nesting, every boundary was a compound.
  it('a system boundary stays a compound when a model group partly overlaps it', async () => {
    const objects = [object('person', 'actor'), object('c1'), object('c2'), object('c3'), object('ext')]
    const connections = [link('e1', 'person', 'c1'), link('e2', 'c1', 'c2'), link('e3', 'c2', 'c3'), link('e4', 'c3', 'ext'), link('e5', 'person', 'ext')]
    const boundary = group('sys', ['c1', 'c2', 'c3'], { parentObjectId: 'system', autoSize: undefined })
    const pci = group('pci', ['c3', 'ext'])
    const d = view(objects.map((o) => o.id), connections.map((c) => c.id), ['sys', 'pci'])
    const nesting = nestGroups(d, [boundary, pci], new Set(d.objectIds))
    expect([...nesting.loose]).toEqual(['pci'])
    const sol = await bestLayout(d, { objects, connections, groups: [boundary, pci] })
    const sys = boxOf(sol.layouts, 'sys')
    for (const id of ['person', 'ext']) expect(overlaps(boxOf(sol.layouts, id), sys), `${id} in the boundary`).toBe(false)
  })

  // Architect lens: score the box the canvas DRAWS. A stored (autoSize:false) box
  // and an auto-sized group alike enclose the groups nested in them — the canvas
  // draws both that way (lib/groupNesting.ts); equal member sets nest by id.
  it('a group box, stored or auto-sized, encloses the groups nested in it as the canvas draws it', () => {
    const objectBoxes = new Map([
      ['a', { x: 0, y: 200, width: 100, height: 60 }],
      ['b', { x: 0, y: 300, width: 100, height: 60 }],
    ])
    const d = view(['a', 'b'], [], ['outer', 'inner'])
    const derive = (outerAutoSize: boolean | undefined, innerMembers: string[]) => {
      const groups = [group('outer', ['a', 'b'], { autoSize: outerAutoSize }), group('inner', innerMembers, { autoSize: outerAutoSize })]
      return deriveGroupBoxes(nestGroups(d, groups, new Set(['a', 'b'])), groups, objectBoxes)
    }
    for (const autoSize of [false, undefined]) {
      const subset = derive(autoSize, ['a'])
      expect(subset.get('outer')!.y, `${autoSize}: subset`).toBeLessThan(subset.get('inner')!.y)
    }
    // Equal member sets, auto-sized: the smaller id ('inner' < 'outer') is outside.
    const equal = derive(undefined, ['a', 'b'])
    expect(equal.get('inner')!.y).toBeLessThan(equal.get('outer')!.y)
  })

  // Review lens, 2026-10-25: two stored groups and one auto-sized group, equal
  // members. Ordering a mixed pair by id while two stored boxes went by area made
  // c ⊃ a (area), a ⊃ b ('a' < 'b'), b ⊃ c ('b' < 'c'): a cycle, the shape fell
  // out of the ELK graph, and every ELK strategy returned nothing.
  it('three groups with equal members nest in one order, the auto-sized one outside, and ELK still lays them out', async () => {
    const d = { ...view(['x'], [], ['c', 'a', 'b']), layouts: {
      c: { position: { x: 0, y: 0 }, size: { width: 400, height: 300 } },
      a: { position: { x: 20, y: 40 }, size: { width: 200, height: 150 } },
    } } as Diagram
    const groups = [group('c', ['x']), group('a', ['x']), group('b', ['x'], { autoSize: undefined })]
    const nesting = nestGroups(d, groups, new Set(['x']))
    for (const id of ['a', 'b', 'c']) {
      const seen = new Set<string>()
      for (let cur: string | undefined = id; cur; cur = nesting.compoundParent.get(cur)) {
        expect(seen.has(cur), `compound chain from ${id} loops`).toBe(false)
        seen.add(cur)
      }
    }
    expect(nesting.compoundParent.get('c')).toBe('b')
    expect(nesting.compoundParent.get('a')).toBe('c')
    // The canvas draws the auto-sized group around both stored boxes too.
    expect(autoSizedInnerGroupIds(groups[2], groups, () => true).sort()).toEqual(['a', 'c'])
    const ctx: LayoutContext = { objects: [object('x')], connections: [], groups }
    for (const strategy of STRATEGIES) {
      const sol = await layoutDiagramElk(d, ctx, strategy)
      expect(sol?.layouts.x, strategy.id).toBeDefined()
    }
  })

  // Review lenses, 2026-10-25: equal members, one stored and one auto-sized. The
  // canvas draws the auto-sized 'inner' around the stored 'outer' (larger id);
  // the compound tree broke the tie by list order and planned it the other way,
  // so the layout scored one nesting and the canvas drew the other.
  it('nests an auto-sized and a stored group with equal members as the canvas does, whatever the list order', () => {
    const objectBoxes = new Map([
      ['a', { x: 0, y: 200, width: 100, height: 60 }],
      ['b', { x: 0, y: 300, width: 100, height: 60 }],
    ])
    const groups = [group('outer', ['a', 'b'], { autoSize: false }), group('inner', ['a', 'b'], { autoSize: undefined })]
    for (const order of [['outer', 'inner'], ['inner', 'outer']]) {
      const nesting = nestGroups(view(['a', 'b'], [], order), groups, new Set(['a', 'b']))
      expect(nesting.enclosed.get('inner'), order.join()).toEqual(['outer'])
      expect(nesting.enclosed.get('outer'), order.join()).toEqual([])
      const boxes = deriveGroupBoxes(nesting, groups, objectBoxes)
      expect(boxes.get('inner')!.y, order.join()).toBeLessThan(boxes.get('outer')!.y)
    }
  })
})

describe('Auto-layout placement — nested deployment nodes (big-bank-plc.json)', () => {
  const mapped = mapWorkspaceJson(parseWorkspaceJson(bigBankJson))
  const depth = (id: string) => mapped.groupDepths[id] ?? 0

  /** Every group boxed; every truly nested node inside its parent, below the
   *  parent's header; no shape inside a group it is not a member of. */
  function expectGroupsSound(d: Diagram, layouts: Record<string, { position: { x: number; y: number }; size: { width: number; height: number } }>) {
    const on = new Set(d.objectIds)
    const groups = d.groupIds.map((id) => mapped.groups.find((g) => g.id === id)!)
    const members = new Map(groups.map((g) => [g.id, new Set(g.objectIds.filter((id) => on.has(id)))]))
    for (const g of groups) if (members.get(g.id)!.size) expect(layouts[g.id], `${g.name}: boxed`).toBeDefined()
    for (const outer of groups) {
      for (const inner of groups) {
        if (depth(inner.id) <= depth(outer.id)) continue
        if (![...members.get(inner.id)!].every((id) => members.get(outer.id)!.has(id))) continue
        const o = boxOf(layouts, outer.id)
        const i = boxOf(layouts, inner.id)
        const inside = i.x >= o.x && i.y >= o.y + 20 && i.x + i.width <= o.x + o.width && i.y + i.height <= o.y + o.height
        expect(inside, `${inner.name} inside ${outer.name}`).toBe(true)
      }
      for (const oid of d.objectIds) {
        if (members.get(outer.id)!.has(oid)) continue
        const name = mapped.objects.find((o) => o.id === oid)?.name
        expect(overlaps(boxOf(layouts, oid), boxOf(layouts, outer.id)), `${name} outside ${outer.name}`).toBe(false)
      }
    }
  }

  for (const view of ['LiveDeployment', 'DevelopmentDeployment']) {
    it(`${view}: the import nests every node and keeps non-members out`, async () => {
      const d = mapped.diagrams.find((x) => x.name === view)!
      const ctx = { objects: mapped.objects, connections: mapped.connections, groups: mapped.groups, groupDepths: mapped.groupDepths }
      const [laid] = (await applyAutoLayout([d], ctx, mapped.layoutHints)).diagrams
      expectGroupsSound(laid, laid.layouts!)
    })

    it(`${view}: Auto-layout on the imported view keeps it so`, async () => {
      const d = mapped.diagrams.find((x) => x.name === view)!
      const ctx = { objects: mapped.objects, connections: mapped.connections, groups: mapped.groups, groupDepths: mapped.groupDepths }
      const [imported] = (await applyAutoLayout([d], ctx, mapped.layoutHints)).diagrams
      // The button: no hints, no depths — only what the diagram itself holds.
      const sol = await bestLayout(imported, { objects: mapped.objects, connections: mapped.connections, groups: mapped.groups })
      expectGroupsSound(imported, sol.layouts)
    })
  }
})

describe('metrics — crowding and group straddles', () => {
  const r = (id: string, x: number, y: number, w = 150, h = 90): Rect => ({ id, x, y, width: w, height: h })

  it('does not count ordinary spacing as crowding', () => {
    // ELK root spacing: 60px gaps between 150px-wide shapes (centres 210px apart).
    expect(computeMetrics([r('a', 0, 0), r('b', 210, 0), r('c', 420, 0), r('d', 210, 150)], []).localDensity).toBe(0)
    // 10px apart is crowded.
    expect(computeMetrics([r('a', 0, 0), r('b', 160, 0), r('c', 0, 100)], []).localDensity).toBe(2)
  })

  it('separates a non-member straddling a group box from one inside it', () => {
    const group = { x: 0, y: 0, width: 400, height: 300, memberIds: new Set(['m']) }
    const member = r('m', 30, 50)
    const inside = r('in', 200, 150)
    const straddler = r('half', 340, 100) // 60px inside the right edge, centre outside
    const grazing = r('graze', 396, 100) // 4px — a hand-placed near miss, not a straddle
    const m = computeMetrics([member, inside, straddler, grazing], [], 0, [group])
    expect(m.boundaryViolations).toBe(1)
    expect(m.groupStraddles).toBe(1)
  })
})
