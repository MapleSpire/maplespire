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
import type { SzElementKind, SzElementStyle, SzView, SzViewKind } from './types'
import { resolveElementStyle } from './styles'
import {
  elementRole,
  planViewLayout,
  positionedElements,
  scaleFactorFor,
  structurizrSizeFor,
  viewHasSavedLayout,
} from './layoutPolicy'

import bigBankRaw from '../fixtures/json/big-bank-plc.json?raw'
import groupsRaw from '../fixtures/json/groups.json?raw'
import deploymentPositionedRaw from '../fixtures/json/deployment-positioned.json?raw'
import bigRealRaw from '../fixtures/json/big-real-workspace.json?raw'
import withoutOrderRaw from '../fixtures/json/views-without-order.json?raw'

// ── A deliberately minimal fixture reader ────────────────────────────────────
// `parse.ts` is a sibling module written in parallel; the layout policy must not
// depend on it, and neither must the evidence that the policy is right. This
// reads the two things the policy consumes — element kinds and element views —
// straight off the wire, narrowing `unknown` the same way the real parser has to.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : []
const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined

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

interface Fixture {
  views: SzView[]
  kindById: Map<string, SzElementKind>
}

function readFixture(json: string): Fixture {
  const root: unknown = JSON.parse(json)
  const workspace = isRecord(root) ? root : {}
  const kindById = new Map<string, SzElementKind>()

  const note = (element: Record<string, unknown>, kind: SzElementKind) => {
    const id = asString(element.id)
    if (id) kindById.set(id, kind)
  }
  const model = isRecord(workspace.model) ? workspace.model : {}
  for (const person of records(model.people)) note(person, 'person')
  for (const custom of records(model.customElements)) note(custom, 'customElement')
  for (const system of records(model.softwareSystems)) {
    note(system, 'softwareSystem')
    for (const container of records(system.containers)) {
      note(container, 'container')
      for (const component of records(container.components)) note(component, 'component')
    }
  }
  const walkNode = (node: Record<string, unknown>) => {
    note(node, 'deploymentNode')
    for (const infra of records(node.infrastructureNodes)) note(infra, 'infrastructureNode')
    for (const inst of records(node.containerInstances)) note(inst, 'containerInstance')
    for (const inst of records(node.softwareSystemInstances)) note(inst, 'softwareSystemInstance')
    for (const child of records(node.children)) walkNode(child)
  }
  for (const node of records(model.deploymentNodes)) walkNode(node)

  const views: SzView[] = []
  const viewsRoot = isRecord(workspace.views) ? workspace.views : {}
  for (const [collection, kind] of Object.entries(VIEW_COLLECTIONS)) {
    for (const view of records(viewsRoot[collection])) {
      views.push({
        kind,
        key: asString(view.key) ?? '',
        scopeId: asString(view.softwareSystemId) ?? asString(view.containerId),
        filterTags: [],
        elements: records(view.elements).map((element) => ({
          id: asString(element.id) ?? '',
          x: asNumber(element.x),
          y: asNumber(element.y),
        })),
        relationships: [],
        automaticLayout: isRecord(view.automaticLayout)
          ? { rankDirection: asString(view.automaticLayout.rankDirection) }
          : undefined,
      })
    }
  }
  return { views, kindById }
}

const bigBank = readFixture(bigBankRaw)
const groups = readFixture(groupsRaw)
const deploymentPositioned = readFixture(deploymentPositionedRaw)
const bigReal = readFixture(bigRealRaw)
const withoutOrder = readFixture(withoutOrderRaw)

const elementViews = (fixture: Fixture) => fixture.views.flatMap((v) => v.elements)
const onOrigin = (fixture: Fixture) =>
  elementViews(fixture).filter((e) => (e.x ?? 0) === 0 && (e.y ?? 0) === 0)
const withElements = (fixture: Fixture) => fixture.views.filter((v) => v.elements.length > 0)

// MapleSpire's own boxes (SIZE_BY_TYPE, ../mapper.ts), which this module is not
// allowed to import — the caller supplies them.
const APP = { width: 185, height: 100 }
const SYSTEM = { width: 200, height: 100 }
const ACTOR = { width: 150, height: 90 }

describe('the fixtures still say what the policy was measured against', () => {
  it('finds all 67 of big-bank-plc.json’s element views on the origin', () => {
    expect(elementViews(bigBank)).toHaveLength(67)
    expect(onOrigin(bigBank)).toHaveLength(67)
  })

  it('finds all 10 of groups.json’s element views on the origin', () => {
    expect(elementViews(groups)).toHaveLength(10)
    expect(onOrigin(groups)).toHaveLength(10)
  })

  it('finds real coordinates on all 10 of deployment-positioned.json’s elements, which also declares automaticLayout', () => {
    expect(elementViews(deploymentPositioned)).toHaveLength(10)
    expect(onOrigin(deploymentPositioned)).toHaveLength(0)
    expect(deploymentPositioned.views[0]?.automaticLayout).toBeDefined()
  })

  it('finds big-real-workspace.json’s 21 elements on the origin are every one of them a deployment node', () => {
    expect(elementViews(bigReal)).toHaveLength(60)
    const zeroKinds = new Set(onOrigin(bigReal).map((e) => bigReal.kindById.get(e.id)))
    expect(onOrigin(bigReal)).toHaveLength(21)
    expect([...zeroKinds]).toEqual(['deploymentNode'])
  })

  it('finds views-without-order.json’s element views carry no x/y at all', () => {
    expect(elementViews(withoutOrder)).toHaveLength(2)
    expect(elementViews(withoutOrder).every((e) => e.x === undefined && e.y === undefined)).toBe(
      true,
    )
  })
})

describe('viewHasSavedLayout — each corpus fixture lands on its own answer', () => {
  it('lays big-bank-plc.json out itself rather than stacking 67 shapes on the origin', () => {
    for (const view of withElements(bigBank)) {
      expect([view.key, viewHasSavedLayout(view, bigBank.kindById)]).toEqual([view.key, false])
    }
  })

  it('lays groups.json out itself', () => {
    for (const view of withElements(groups)) {
      expect([view.key, viewHasSavedLayout(view, groups.kindById)]).toEqual([view.key, false])
    }
  })

  it('lays views-without-order.json out itself, because absent x/y is not a position', () => {
    for (const view of withElements(withoutOrder)) {
      expect([view.key, viewHasSavedLayout(view, withoutOrder.kindById)]).toEqual([view.key, false])
    }
  })

  it('preserves deployment-positioned.json, whose automaticLayout does not make its coordinates junk', () => {
    for (const view of withElements(deploymentPositioned)) {
      expect([view.key, viewHasSavedLayout(view, deploymentPositioned.kindById)]).toEqual([
        view.key,
        true,
      ])
    }
  })

  it('preserves every view of big-real-workspace.json, including the two where all 21 zeros are boundaries', () => {
    for (const view of withElements(bigReal)) {
      expect([view.key, viewHasSavedLayout(view, bigReal.kindById)]).toEqual([view.key, true])
    }
  })
})

// ── Hand-built views for the cases the corpus does not contain ───────────────

const view = (over: Partial<SzView>): SzView => ({
  kind: 'container',
  key: 'K',
  filterTags: [],
  elements: [],
  relationships: [],
  ...over,
})

describe('positionedElements', () => {
  it('hands a deployment node on the origin back to be sized from its children instead of moving it there', () => {
    const kinds = new Map<string, SzElementKind>([
      ['node', 'deploymentNode'],
      ['instance', 'containerInstance'],
    ])
    const placements = positionedElements(
      view({
        kind: 'deployment',
        elements: [
          { id: 'node', x: 0, y: 0 },
          { id: 'instance', x: 1000, y: 500 },
        ],
      }),
      kinds,
    )
    expect(placements.derivedBoundaries).toEqual(['node'])
    expect(placements.positioned).toEqual([{ id: 'instance', role: 'leaf', x: 1000, y: 500 }])
    expect(placements.unpositioned).toEqual([])
  })

  it('keeps a deployment node’s own coordinate when the file gave it one', () => {
    const kinds = new Map<string, SzElementKind>([['node', 'deploymentNode']])
    const placements = positionedElements(
      view({ kind: 'deployment', elements: [{ id: 'node', x: 240, y: 120 }] }),
      kinds,
    )
    expect(placements.positioned).toEqual([{ id: 'node', role: 'boundary', x: 240, y: 120 }])
    expect(placements.derivedBoundaries).toEqual([])
  })

  it('treats the container a component view is scoped to as a boundary, not as a shape on the origin', () => {
    const kinds = new Map<string, SzElementKind>([
      ['c1', 'container'],
      ['comp1', 'component'],
    ])
    const scoped = view({
      kind: 'component',
      scopeId: 'c1',
      elements: [
        { id: 'c1', x: 0, y: 0 },
        { id: 'comp1', x: 600, y: 300 },
      ],
    })
    expect(elementRole(scoped, 'c1', kinds)).toBe('boundary')
    expect(elementRole(scoped, 'comp1', kinds)).toBe('leaf')
    expect(positionedElements(scoped, kinds).derivedBoundaries).toEqual(['c1'])
  })

  it('treats an id the model never declared as a leaf, so a dangling reference is not silently dropped', () => {
    const placements = positionedElements(
      view({ elements: [{ id: 'ghost', x: 0, y: 0 }] }),
      new Map<string, SzElementKind>(),
    )
    expect(placements.unpositioned).toEqual(['ghost'])
    expect(placements.derivedBoundaries).toEqual([])
  })
})

describe('viewHasSavedLayout — the two directions it can be wrong in', () => {
  const kinds = new Map<string, SzElementKind>([
    ['a', 'container'],
    ['b', 'container'],
    ['c', 'container'],
    ['d', 'container'],
    ['e', 'container'],
  ])

  it('lays out a view where a single stray leaf was dragged off the origin', () => {
    expect(
      viewHasSavedLayout(
        view({
          elements: [
            { id: 'a', x: 900, y: 400 },
            { id: 'b', x: 0, y: 0 },
            { id: 'c', x: 0, y: 0 },
            { id: 'd', x: 0, y: 0 },
            { id: 'e', x: 0, y: 0 },
          ],
        }),
        kinds,
      ),
    ).toBe(false)
  })

  it('keeps a hand-arranged view where one leaf was left on the origin', () => {
    expect(
      viewHasSavedLayout(
        view({
          elements: [
            { id: 'a', x: 900, y: 400 },
            { id: 'b', x: 1400, y: 400 },
            { id: 'c', x: 1900, y: 400 },
            { id: 'd', x: 0, y: 0 },
          ],
        }),
        kinds,
      ),
    ).toBe(true)
  })

  it('keeps a deployment view made of nothing but positioned nodes, which has no leaves to count', () => {
    expect(
      viewHasSavedLayout(
        view({ kind: 'deployment', elements: [{ id: 'n', x: 300, y: 300 }] }),
        new Map<string, SzElementKind>([['n', 'deploymentNode']]),
      ),
    ).toBe(true)
  })
})

describe('structurizrSizeFor', () => {
  // The Person/Robot square and the MobileDevice orientation swaps are applied by
  // `resolveElementStyle`, so they are exercised against the PRODUCTION path here
  // rather than re-derived from the shape name a second time in this module.
  const sizeOfStyledElement = (shape: string, extra: Partial<SzElementStyle> = {}) =>
    structurizrSizeFor(
      resolveElementStyle(['Element'], [{ tag: 'Element', shape, ...extra }]),
    )

  it('gives an unstyled element the renderer’s 450x300 box', () => {
    expect(structurizrSizeFor()).toEqual({ width: 450, height: 300 })
    expect(sizeOfStyledElement('Box')).toEqual({ width: 450, height: 300 })
  })

  it('gives a Person-shaped element the renderer’s 400x400 square', () => {
    expect(sizeOfStyledElement('Person')).toEqual({ width: 400, height: 400 })
    expect(sizeOfStyledElement('Robot')).toEqual({ width: 400, height: 400 })
  })

  it('lets an explicit width suppress the Person square, as the renderer’s post-processing does', () => {
    expect(sizeOfStyledElement('Person', { width: 600 })).toEqual({ width: 600, height: 300 })
  })

  it('stands a portrait mobile device on its end', () => {
    expect(sizeOfStyledElement('MobileDevicePortrait')).toEqual({ width: 300, height: 450 })
    expect(sizeOfStyledElement('MobileDeviceLandscape')).toEqual({ width: 450, height: 300 })
  })

  it('ignores a zero width, which producers emit for "unset"', () => {
    expect(structurizrSizeFor({ width: 0, height: 0 })).toEqual({ width: 450, height: 300 })
  })
})

describe('scaleFactorFor', () => {
  it('takes the ratio that needs the most room, so no pair of boxes can start to overlap', () => {
    // 185/450 = 0.411 horizontally, 100/300 = 0.333 vertically.
    expect(
      scaleFactorFor([{ source: { width: 450, height: 300 }, target: APP }]),
    ).toBeCloseTo(185 / 450)
  })

  it('copies coordinates through unchanged when nothing is measurable', () => {
    expect(scaleFactorFor([])).toBe(1)
    expect(scaleFactorFor([{ source: { width: 0, height: 0 }, target: APP }])).toBe(1)
  })
})

describe('planViewLayout', () => {
  const kinds = new Map<string, SzElementKind>([
    ['a', 'container'],
    ['b', 'container'],
    ['c', 'container'],
    ['sys', 'softwareSystem'],
    ['person', 'person'],
    ['node', 'deploymentNode'],
  ])
  const sized = (byId: Record<string, { width: number; height: number }>) => ({
    targetSizeFor: (id: string) => byId[id] ?? APP,
  })

  it('refuses to place big-bank-plc’s container view and says why', () => {
    const containers = bigBank.views.find((v) => v.key === 'Containers')
    expect(containers).toBeDefined()
    const plan = planViewLayout(containers as SzView, bigBank.kindById, sized({}))
    expect(plan.kind).toBe('auto')
    if (plan.kind === 'auto') expect(plan.reason).toContain('8 of 8 elements sit on the origin')
  })

  it('packs a 450-apart row shoulder to shoulder instead of leaving 2.4x gaps', () => {
    const plan = planViewLayout(
      view({
        elements: [
          { id: 'a', x: 1000, y: 1000 },
          { id: 'b', x: 1450, y: 1000 },
        ],
      }),
      kinds,
      sized({}),
    )
    expect(plan.kind).toBe('preserved')
    if (plan.kind !== 'preserved') return
    expect(plan.scale).toBeCloseTo(185 / 450)
    const gap = plan.layouts.b.position.x - (plan.layouts.a.position.x + APP.width)
    expect(gap).toBeGreaterThanOrEqual(0)
    // Verbatim coordinates would leave 265px between two 185px boxes.
    expect(gap).toBeLessThan(APP.width / 4)
  })

  it('derives the scale from the element that needs the most room, so the widest neighbours still clear each other', () => {
    const plan = planViewLayout(
      view({
        elements: [
          { id: 'sys', x: 1000, y: 1000 },
          { id: 'a', x: 1450, y: 1000 },
          { id: 'person', x: 1900, y: 1000 },
        ],
      }),
      kinds,
      {
        ...sized({ sys: SYSTEM, person: ACTOR }),
        sourceSizeFor: (id) =>
          id === 'person' ? { width: 400, height: 400 } : { width: 450, height: 300 },
      },
    )
    expect(plan.kind).toBe('preserved')
    if (plan.kind !== 'preserved') return
    expect(plan.scale).toBeCloseTo(200 / 450)
    // The system's own ratio is the binding one: scaling by the person's (0.375)
    // would put its 200px box in a 168px slot.
    expect(plan.layouts.a.position.x - plan.layouts.sys.position.x).toBeGreaterThanOrEqual(
      SYSTEM.width,
    )
  })

  it('preserves the shape of the arrangement and translates it to the origin', () => {
    const plan = planViewLayout(
      view({
        elements: [
          { id: 'a', x: 2000, y: 1000 },
          { id: 'b', x: 2450, y: 1000 },
          { id: 'c', x: 2000, y: 1600 },
        ],
      }),
      kinds,
      sized({}),
    )
    expect(plan.kind).toBe('preserved')
    if (plan.kind !== 'preserved') return
    expect(plan.layouts.a.position).toEqual({ x: 0, y: 0 })
    expect(plan.layouts.b.position.y).toBe(0)
    expect(plan.layouts.c.position.x).toBe(0)
    // A similarity transform: the arrangement's proportions survive intact.
    const source = 600 / 450
    expect(plan.layouts.c.position.y / plan.layouts.b.position.x).toBeCloseTo(source, 2)
  })

  it('starts the arrangement from the placed elements, not from a boundary’s marker zero', () => {
    const plan = planViewLayout(
      view({
        kind: 'deployment',
        elements: [
          { id: 'node', x: 0, y: 0 },
          { id: 'a', x: 2000, y: 1000 },
          { id: 'b', x: 2450, y: 1000 },
        ],
      }),
      kinds,
      sized({}),
    )
    expect(plan.kind).toBe('preserved')
    if (plan.kind !== 'preserved') return
    expect(plan.layouts.a.position).toEqual({ x: 0, y: 0 })
    expect(plan.sourceOrigin).toEqual({ x: 2000, y: 1000 })
    expect(plan.layouts.node).toBeUndefined()
  })

  it('honours a caller-supplied origin', () => {
    const plan = planViewLayout(
      view({ elements: [{ id: 'a', x: 2000, y: 1000 }] }),
      kinds,
      { ...sized({}), origin: { x: 40, y: 24 } },
    )
    expect(plan.kind).toBe('preserved')
    if (plan.kind !== 'preserved') return
    expect(plan.layouts.a.position).toEqual({ x: 40, y: 24 })
  })

  it('reports a leaf the file never placed instead of laying it on the origin', () => {
    const plan = planViewLayout(
      view({
        elements: [
          { id: 'a', x: 1000, y: 1000 },
          { id: 'b', x: 1450, y: 1000 },
          { id: 'c', x: 0, y: 0 },
        ],
      }),
      kinds,
      sized({}),
    )
    expect(plan.kind).toBe('preserved')
    if (plan.kind !== 'preserved') return
    expect(plan.unpositionedIds).toEqual(['c'])
    expect(plan.layouts.c).toBeUndefined()
  })

  it('gives every element of deployment-positioned.json a home: instances placed, nodes derived', () => {
    const [only] = deploymentPositioned.views.filter((v) => v.elements.length > 0)
    const plan = planViewLayout(only, deploymentPositioned.kindById, {
      targetSizeFor: () => APP,
    })
    expect(plan.kind).toBe('preserved')
    if (plan.kind !== 'preserved') return
    expect(Object.keys(plan.layouts)).toHaveLength(4) // 2 container instances + 2 infrastructure nodes
    // The 6 deployment nodes each carry their own top-left in this file and are
    // still kept out of `layouts` — a boundary's box comes from its children.
    expect(plan.unpositionedIds).toEqual([])
    expect(Object.values(plan.layouts).every((l) => l.position.x >= 0 && l.position.y >= 0)).toBe(
      true,
    )
  })

  it('places big-real-workspace’s live deployment view from its instances alone', () => {
    const live = bigReal.views.find((v) => v.key === 'LiveDeployment')
    expect(live).toBeDefined()
    const plan = planViewLayout(live as SzView, bigReal.kindById, { targetSizeFor: () => APP })
    expect(plan.kind).toBe('preserved')
    if (plan.kind !== 'preserved') return
    expect(Object.keys(plan.layouts)).toHaveLength(7)
    // 13 deployment nodes, all on the origin marker, none of them a layout.
    expect(plan.unpositionedIds).toEqual([])
  })
})
