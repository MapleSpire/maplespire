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
 * The acceptance test for the whole exporter: a customer's file goes in, comes
 * out, and goes back in, and the second arrival has to be the first one.
 *
 * Every fixture in `structurizr/fixtures/json/` is imported through the real
 * pipeline (`structurizrJsonSource.run` — parse, map, ELK for the views the
 * file never laid out), exported, and imported again. Both imports are then
 * measured **against the original file** with `lib/import/fidelity.ts`, so the
 * question asked is not "did the exporter agree with itself" but "does the file
 * a customer would leave with still describe the workspace they arrived with".
 *
 * Three things are asserted, and they fail for different reasons:
 *
 *  1. the two fidelity reports are EQUAL, modulo the ids a fresh import mints —
 *     any element, edge, view, view member or label the export drops shows up
 *     here as a difference, named;
 *  2. the headline numbers match a table written down per fixture, so a
 *     regression that damages both imports equally still fails;
 *  3. every shape is in the same PLACE. Per view the displacement must be a
 *     SINGLE rigid translation — two displacements in one view means shapes
 *     moved relative to each other, which is the loss this whole feature exists
 *     to prevent — and which views translate at all is listed by key in the
 *     table, so "it only shifted a bit" is a failure unless it was already
 *     written down.
 *
 * Why any translation is tolerated: the importer anchors a view's top-left at
 * its own margin, so a view MapleSpire laid out itself is re-anchored once on
 * the way back. It is invisible on a canvas that fits content to the viewport,
 * and it does not accumulate — the third pass asserts the second is a fixed
 * point, because one pass cannot tell a stable transform from a creeping one.
 */

import { describe, expect, it } from 'vitest'
import { structurizrJsonSource } from '../../import/structurizrJsonSource'
import { measureFidelity, formatFidelityReport, type FidelityReport } from '../../import/fidelity'
import { parseWorkspaceJson } from '../../structurizr/json/parse'
import { resolveStyleForElement } from '../../structurizr/json/styles'
import type { ImportResult } from '../../import/types'
import type { Position } from '../../../types'
import type { ExportBundle } from '../types'
import { buildStructurizrJson } from '.'

import bigBank from '../../structurizr/fixtures/json/big-bank-plc.json'
import bigReal from '../../structurizr/fixtures/json/big-real-workspace.json'
import deploymentPositioned from '../../structurizr/fixtures/json/deployment-positioned.json'
import groupsFixture from '../../structurizr/fixtures/json/groups.json'
import mixed from '../../structurizr/fixtures/json/mixed-preserved-and-auto.json'
import nestedNoSeparator from '../../structurizr/fixtures/json/nested-groups-no-separator.json'
import nestedSeparator from '../../structurizr/fixtures/json/nested-groups-separator-positioned.json'
import noViews from '../../structurizr/fixtures/json/no-views.json'
import parallelDynamic from '../../structurizr/fixtures/json/parallel-edges-and-dynamic.json'
import positionedContainerDeployment from '../../structurizr/fixtures/json/positioned-container-and-deployment.json'
import styledRouted from '../../structurizr/fixtures/json/styled-scope-listed-and-routed-edges.json'
import viewsWithoutOrder from '../../structurizr/fixtures/json/views-without-order.json'

// ── what each fixture is expected to bring back ──────────────────────────────
//
// `[matched, expected]` against the ORIGINAL file, and `layout` is
// `[preserved, re-laid-out, source-unpositioned, indeterminate, not-imported]`.
// Written down rather than derived so a change that damages the import and the
// export by the same amount still fails; the shortfalls are annotated, and each
// one is an import-side limit this exporter cannot create or repair.

interface Headline {
  elements: [number, number]
  groups: [number, number]
  authored: [number, number]
  derived: [number, number]
  views: [number, number]
  members: [number, number]
  edges: [number, number]
  layout: [number, number, number, number, number]
  /** Shapes carrying a per-diagram position after the round trip. */
  placements: number
  /**
   * Views that came back somewhere other than where they were, BY KEY. A
   * translation is invisible to a customer — the canvas has no absolute origin
   * and fits the content to the viewport — but it is not nothing, so which
   * views hold absolutely still is written down rather than tolerated in bulk.
   */
  translated: string[]
}

const FIXTURES: Array<[name: string, workspace: unknown, expected: Headline]> = [
  [
    'big-bank-plc',
    bigBank,
    // The missing authored edge runs between two deployment NODES, which the
    // importer turns into boundary Groups; a Connection joins objects, so it was
    // never in the bundle to export. The missing view is an `image` view, which
    // the importer does not read.
    {
      elements: [51, 51],
      groups: [1, 1],
      authored: [26, 27],
      derived: [15, 15],
      views: [7, 8],
      members: [67, 67],
      edges: [49, 50],
      layout: [0, 0, 7, 0, 1],
      placements: 73,
      translated: ['Components', 'Containers', 'DevelopmentDeployment', 'LiveDeployment', 'SignIn', 'SystemContext', 'SystemLandscape'],
    },
  ],
  [
    'big-real-workspace',
    bigReal,
    {
      elements: [51, 51],
      groups: [1, 1],
      authored: [26, 27],
      derived: [15, 15],
      views: [6, 7],
      members: [60, 60],
      edges: [40, 41],
      layout: [6, 0, 0, 0, 1],
      placements: 65,
      translated: [],
    },
  ],
  [
    'deployment-positioned',
    deploymentPositioned,
    {
      elements: [13, 13],
      groups: [0, 0],
      authored: [3, 3],
      derived: [1, 1],
      views: [1, 1],
      members: [10, 10],
      edges: [3, 3],
      layout: [1, 0, 0, 0, 0],
      placements: 10,
      // The one view in the corpus that the FILE positioned and that still
      // moves. Its shapes sit inside deployment nodes, which the importer turns
      // into boundary Groups whose boxes it derives from their children rather
      // than reading — so the padding around them is re-applied on the way back
      // and the whole view shifts by it, rigidly, once.
      translated: ['AmazonWebServicesDeployment'],
    },
  ],
  [
    'groups',
    groupsFixture,
    {
      elements: [8, 8],
      groups: [5, 5],
      authored: [5, 5],
      derived: [2, 2],
      views: [3, 3],
      members: [10, 10],
      edges: [7, 7],
      layout: [0, 0, 3, 0, 0],
      placements: 19,
      translated: ['Components', 'Containers', 'SystemLandscape'],
    },
  ],
  [
    'mixed-preserved-and-auto',
    mixed,
    {
      elements: [3, 3],
      groups: [0, 0],
      authored: [2, 2],
      derived: [0, 0],
      views: [2, 2],
      members: [4, 4],
      edges: [2, 2],
      layout: [1, 0, 1, 0, 0],
      placements: 4,
      translated: ['NeverLaidOut'],
    },
  ],
  [
    'nested-groups-no-separator',
    nestedNoSeparator,
    // 4/4 groups is the interesting number: the file declares no separator, so
    // `Payments/Core` is ONE group with a slash in its name, and the export must
    // not declare a separator that would split it in two on the way back.
    {
      elements: [5, 5],
      groups: [4, 4],
      authored: [3, 3],
      derived: [0, 0],
      views: [1, 1],
      members: [5, 5],
      edges: [3, 3],
      layout: [0, 0, 1, 0, 0],
      placements: 9,
      translated: ['Landscape'],
    },
  ],
  [
    'nested-groups-separator-positioned',
    nestedSeparator,
    {
      elements: [5, 5],
      groups: [4, 4],
      authored: [3, 3],
      derived: [0, 0],
      views: [1, 1],
      members: [5, 5],
      edges: [3, 3],
      layout: [1, 0, 0, 0, 0],
      placements: 9,
      translated: [],
    },
  ],
  [
    'no-views',
    noViews,
    // A model with no views: the importer invents three, and the exporter emits
    // them with the coordinates MapleSpire computed for them.
    {
      elements: [6, 6],
      groups: [0, 0],
      authored: [2, 2],
      derived: [0, 0],
      views: [0, 0],
      members: [0, 0],
      edges: [0, 0],
      layout: [0, 0, 0, 0, 0],
      placements: 8,
      translated: ['Components-3', 'Containers-2', 'SystemLandscape'],
    },
  ],
  [
    'parallel-edges-and-dynamic',
    parallelDynamic,
    {
      elements: [4, 4],
      groups: [0, 0],
      authored: [5, 5],
      derived: [0, 0],
      views: [2, 2],
      members: [6, 6],
      edges: [8, 8],
      layout: [2, 0, 0, 0, 0],
      placements: 7,
      translated: [],
    },
  ],
  [
    'positioned-container-and-deployment',
    positionedContainerDeployment,
    {
      elements: [16, 16],
      groups: [0, 0],
      authored: [4, 4],
      derived: [2, 2],
      views: [3, 3],
      members: [15, 15],
      edges: [6, 6],
      layout: [2, 0, 1, 0, 0],
      placements: 20,
      translated: [],
    },
  ],
  [
    'styled-scope-listed-and-routed-edges',
    styledRouted,
    // 3/4 members: the container view lists its own scope as a member, which the
    // importer renders as the diagram's boundary rather than as a shape.
    {
      elements: [4, 4],
      groups: [0, 0],
      authored: [2, 2],
      derived: [0, 0],
      views: [1, 1],
      members: [3, 4],
      edges: [2, 2],
      layout: [1, 0, 0, 0, 0],
      placements: 4,
      translated: [],
    },
  ],
  [
    'views-without-order',
    viewsWithoutOrder,
    {
      elements: [1, 1],
      groups: [0, 0],
      authored: [0, 0],
      derived: [0, 0],
      views: [2, 2],
      members: [2, 2],
      edges: [0, 0],
      layout: [0, 0, 2, 0, 0],
      placements: 2,
      translated: ['SystemLandscape-001', 'SystemLandscape-002'],
    },
  ],
]

// ── the round trip ───────────────────────────────────────────────────────────

async function importWorkspace(text: string): Promise<ImportResult> {
  const run = structurizrJsonSource.run
  if (run === undefined) throw new Error('the Structurizr JSON source cannot run')
  return run(text)
}

function bundleOf(result: ImportResult): ExportBundle {
  const flowsByDiagram: Record<string, NonNullable<ImportResult['flows']>> = {}
  for (const flow of result.flows ?? []) (flowsByDiagram[flow.diagramId] ??= []).push(flow)
  return {
    landscapeName: result.landscapeName ?? 'Workspace',
    generatedAt: '2026-01-01T00:00:00Z',
    diagrams: result.diagrams,
    activeDiagramId: result.entryDiagramId,
    flowsByDiagram,
    objects: result.objects,
    connections: result.connections,
    groups: result.groups,
    domains: [],
    tags: result.tags,
    decisionRecords: [],
  }
}

interface Trip {
  before: FidelityReport
  after: FidelityReport
  settled: FidelityReport
  firstPlacements: ViewPlacements
  secondPlacements: ViewPlacements
  thirdPlacements: ViewPlacements
  sourceText: string
  firstText: string
  secondText: string
  thirdText: string
}

/** One import→export→import→export→import, run once per fixture. */
async function roundTrip(fixture: unknown): Promise<Trip> {
  const sourceText = JSON.stringify(fixture)
  const workspace = parseWorkspaceJson(sourceText)

  const first = await importWorkspace(sourceText)
  const firstText = buildStructurizrJson(bundleOf(first))
  const second = await importWorkspace(firstText)
  // A third pass, because one pass cannot tell a stable transform from a
  // creeping one: a scale applied twice and a scale applied once look identical
  // when you only ever look once.
  const secondText = buildStructurizrJson(bundleOf(second))
  const third = await importWorkspace(secondText)
  const thirdText = buildStructurizrJson(bundleOf(third))

  return {
    before: measureFidelity(workspace, first),
    after: measureFidelity(workspace, second),
    settled: measureFidelity(workspace, third),
    firstPlacements: placements(first),
    secondPlacements: placements(second),
    thirdPlacements: placements(third),
    sourceText,
    firstText,
    secondText,
    thirdText,
  }
}

// ── what a renderer actually draws ───────────────────────────────────────────

/**
 * Every element's RESOLVED appearance, keyed by wire id.
 *
 * Resolved with the import side's own resolver — the algorithm structurizr-ui
 * paints with — so this asks the only question that matters about a styles
 * block: does a reader draw the customer's workspace the way their file drew it.
 *
 * It exists because the fidelity report measures topology and geometry and
 * nothing else, so a build that emitted every element with an empty tag string
 * and no styles block at all would pass every assertion above while shapes
 * came back white, in invented colours, or without their queue shape and icon.
 */
interface Appearance {
  background: string
  color: string
  stroke: string
  shape: string
  icon: string
  /** Whether the file itself named a shape, as opposed to falling back to `Box`. */
  shapeStated: boolean
}

function appearanceByWireId(text: string): Map<string, Appearance> {
  const workspace = parseWorkspaceJson(text)
  const byId = new Map(workspace.elements.map((element) => [element.id, element]))
  const out = new Map<string, Appearance>()
  for (const element of workspace.elements) {
    const style = resolveStyleForElement(element, byId, workspace.elementStyles, {})
    out.set(element.id, {
      background: style.background,
      color: style.color,
      stroke: style.stroke,
      shape: style.shape,
      icon: style.icon ?? '-',
      shapeStated: style.explicit.shape !== undefined,
    })
  }
  return out
}

/**
 * How the export's appearance may differ from the file's.
 *
 * COLOUR may not, in either direction — a colour the file had and we lost is a
 * loss, and one we state that the file never had is an invention that repaints a
 * workspace we were asked to preserve.
 *
 * SHAPE may be ADDED where the file named none. That is the one deliberate
 * addition this exporter makes: MapleSpire distinguishes people, components and
 * data stores at the C4 level and Structurizr distinguishes them by shape, so a
 * workspace that never said anything about shape leaves with `Person`,
 * `Component` and `Cylinder` on the tags that mean those levels. It may not
 * OVERRIDE a shape the file did name.
 */
function appearanceDifferences(before: Appearance, after: Appearance): string[] {
  const out: string[] = []
  for (const key of ['background', 'color', 'stroke', 'icon'] as const) {
    if (before[key] !== after[key]) out.push(`${key} ${before[key]} → ${after[key]}`)
  }
  if (before.shapeStated && before.shape !== after.shape) out.push(`shape ${before.shape} → ${after.shape}`)
  return out
}

/**
 * Every id a view row names, and what kind of element it has to resolve to.
 *
 * `ViewSet.hydrate` is not tolerant here. A `softwareSystemId` naming nothing is
 * rule 4 and the workspace refuses to open; a `containerId` naming a
 * `DeploymentNode` is worse — `ViewSet.java` casts BEFORE its null check, so it
 * is an unchecked `ClassCastException` escaping `WorkspaceReaderException`.
 * Neither is visible to a fidelity report: the file is simply one a customer
 * cannot open, and both were reachable from an ordinary imported workspace.
 */
function danglingViewReferences(text: string): string[] {
  const raw = JSON.parse(text) as Record<string, never>
  const kindById = new Map<string, string>()
  const walk = (node: unknown, kind: string): void => {
    for (const entry of (node ?? []) as Array<Record<string, unknown>>) {
      kindById.set(String(entry.id), kind)
      walk(entry.containers, 'container')
      walk(entry.components, 'component')
      walk(entry.children, 'deploymentNode')
      walk(entry.infrastructureNodes, 'infrastructureNode')
      walk(entry.containerInstances, 'containerInstance')
      walk(entry.softwareSystemInstances, 'softwareSystemInstance')
    }
  }
  const model = (raw.model ?? {}) as Record<string, unknown>
  walk(model.people, 'person')
  walk(model.softwareSystems, 'softwareSystem')
  walk(model.customElements, 'customElement')
  walk(model.deploymentNodes, 'deploymentNode')

  const problems: string[] = []
  const require = (where: string, id: unknown, kinds: readonly string[]): void => {
    if (id === undefined) return
    const kind = kindById.get(String(id))
    if (kind === undefined) problems.push(`${where} names "${String(id)}", which is in no element of the model`)
    else if (!kinds.includes(kind)) problems.push(`${where} names "${String(id)}", which is a ${kind}`)
  }
  const views = (raw.views ?? {}) as Record<string, Array<Record<string, unknown>>>
  for (const [collection, rows] of Object.entries(views)) {
    if (!Array.isArray(rows)) continue
    for (const view of rows) {
      const where = `${collection}["${String(view.key)}"]`
      if (collection === 'componentViews') require(`${where}.containerId`, view.containerId, ['container'])
      else if (collection !== 'dynamicViews') {
        require(`${where}.softwareSystemId`, view.softwareSystemId, ['softwareSystem'])
      }
      if (collection === 'dynamicViews') {
        require(`${where}.elementId`, view.elementId, ['softwareSystem', 'container'])
      }
      for (const row of (view.elements ?? []) as Array<Record<string, unknown>>) {
        // A member row may name any kind; it may not name nothing.
        if (!kindById.has(String(row.id))) {
          problems.push(`${where}.elements names "${String(row.id)}", which is in no element of the model`)
        }
      }
    }
  }
  return problems
}

const trips = new Map<string, Promise<Trip>>()
function tripFor(name: string, fixture: unknown): Promise<Trip> {
  const existing = trips.get(name)
  if (existing) return existing
  const started = roundTrip(fixture)
  trips.set(name, started)
  return started
}

// ── placements ───────────────────────────────────────────────────────────────

/** view key → wire id → where that shape sits on that diagram. Both halves of
 *  the key survive an import; the entity ids either side of one do not. */
type ViewPlacements = Map<string, Map<string, Position>>

function placements(result: ImportResult): ViewPlacements {
  const wireIdOf = new Map<string, string>()
  for (const object of result.objects) {
    wireIdOf.set(object.id, object.properties?.['structurizr.id'] ?? `name:${object.name}`)
  }
  for (const group of result.groups) {
    wireIdOf.set(group.id, group.properties?.['structurizr.id'] ?? `name:${group.name}`)
  }
  const out: ViewPlacements = new Map()
  for (const diagram of result.diagrams) {
    const view = diagram.sourceViewKey ?? `name:${diagram.name}`
    const shapes = out.get(view) ?? new Map<string, Position>()
    for (const [entityId, layout] of Object.entries(diagram.layouts ?? {})) {
      const wireId = wireIdOf.get(entityId)
      if (wireId) shapes.set(wireId, layout.position)
    }
    out.set(view, shapes)
  }
  return out
}

function totalPlacements(views: ViewPlacements): number {
  let total = 0
  for (const shapes of views.values()) total += shapes.size
  return total
}

/** The distinct displacements a view underwent, as `"dx,dy"`. More than one
 *  means the view was reshaped, not moved — the failure this measures. */
function displacementsOf(before: Map<string, Position>, after: Map<string, Position>): string[] {
  const deltas = new Set<string>()
  for (const [wireId, from] of before) {
    const to = after.get(wireId)
    if (to) deltas.add(`${to.x - from.x},${to.y - from.y}`)
  }
  return [...deltas].sort()
}

/** The views that came back somewhere other than where they were, by key. */
function translatedViews(before: ViewPlacements, after: ViewPlacements): string[] {
  const moved: string[] = []
  for (const [view, shapes] of before) {
    const now = after.get(view)
    if (!now) continue
    const deltas = displacementsOf(shapes, now)
    if (deltas.some((delta) => delta !== '0,0')) moved.push(view)
  }
  return moved.sort()
}

// ── normalisation ────────────────────────────────────────────────────────────

/** The report with everything a fresh import re-mints stripped out, so two
 *  reports can be compared for equality rather than for plausibility. Source
 *  ids and view keys stay: those are the file's, and the file does not change. */
function normalise(report: FidelityReport): unknown {
  const names = (items: ReadonlyArray<{ name: string }>) => items.map((i) => i.name).sort()
  return {
    elements: {
      expected: report.elements.expected,
      matched: report.elements.matched,
      missing: report.elements.missing.map((m) => m.id).sort(),
      byKind: report.elements.byKind,
      matchedBy: report.elements.matchedBy,
      weaklyMatchedIds: [...report.elements.weaklyMatchedIds].sort(),
      unexplainedTargets: names(report.elements.unexplainedTargets),
    },
    groups: report.groups,
    relationships: {
      authored: {
        expected: report.relationships.authored.expected,
        matched: report.relationships.authored.matched,
        missing: report.relationships.authored.missing.map((m) => `${m.id}:${m.reason}`).sort(),
      },
      derived: {
        expected: report.relationships.derived.expected,
        matched: report.relationships.derived.matched,
        missing: report.relationships.derived.missing.map((m) => `${m.id}:${m.reason}`).sort(),
      },
      unexplainedConnections: report.relationships.unexplainedConnectionIds.length,
    },
    views: {
      expected: report.views.expected,
      matched: report.views.matched,
      missing: report.views.missing.map((v) => v.key).sort(),
      droppedByKind: report.views.droppedByKind,
      weaklyMatchedKeys: [...report.views.weaklyMatchedKeys].sort(),
      unexplainedDiagrams: names(report.views.unexplainedDiagrams),
    },
    viewMembership: {
      expectedTotal: report.viewMembership.expectedTotal,
      presentTotal: report.viewMembership.presentTotal,
      expectedRelationshipTotal: report.viewMembership.expectedRelationshipTotal,
      presentRelationshipTotal: report.viewMembership.presentRelationshipTotal,
      viewsWithLoss: report.viewMembership.viewsWithLoss,
      details: report.viewMembership.details.map((d) => ({
        key: d.key,
        expected: d.expected,
        present: d.present,
        missing: d.missing.map((m) => m.id).sort(),
        extra: names(d.extra),
        expectedRelationships: d.expectedRelationships,
        presentRelationships: d.presentRelationships,
        missingRelationshipIds: [...d.missingRelationshipIds].sort(),
      })),
    },
    layout: {
      preserved: report.layout.preserved,
      relaidOut: report.layout.relaidOut,
      sourceUnpositioned: report.layout.sourceUnpositioned,
      indeterminate: report.layout.indeterminate,
      notImported: report.layout.notImported,
      details: report.layout.details.map((d) => ({
        key: d.key,
        classification: d.classification,
        comparableInSource: d.comparableInSource,
        positionedInResult: d.positionedInResult,
        derivedBoundaries: d.derivedBoundaries,
        missingLayouts: d.missingLayoutIds.length,
        orderingAgreementX: d.orderingAgreementX,
        orderingAgreementY: d.orderingAgreementY,
        inversionCount: d.inversionCount,
      })),
    },
    labels: {
      elementNames: {
        compared: report.labels.elementNames.compared,
        changed: report.labels.elementNames.changed.map((c) => `${c.id}:${c.from}→${c.to}`).sort(),
        vanished: report.labels.elementNames.vanished.map((v) => v.id).sort(),
      },
      relationshipDescriptions: {
        compared: report.labels.relationshipDescriptions.compared,
        changed: report.labels.relationshipDescriptions.changed.map((c) => `${c.id}:${c.from}→${c.to}`).sort(),
        vanished: report.labels.relationshipDescriptions.vanished.map((v) => v.id).sort(),
      },
    },
  }
}

function headlineOf(trip: Trip): Headline {
  const report = trip.after
  return {
    elements: [report.elements.matched, report.elements.expected],
    groups: [report.groups.matched, report.groups.expected],
    authored: [report.relationships.authored.matched, report.relationships.authored.expected],
    derived: [report.relationships.derived.matched, report.relationships.derived.expected],
    views: [report.views.matched, report.views.expected],
    members: [report.viewMembership.presentTotal, report.viewMembership.expectedTotal],
    edges: [report.viewMembership.presentRelationshipTotal, report.viewMembership.expectedRelationshipTotal],
    layout: [
      report.layout.preserved,
      report.layout.relaidOut,
      report.layout.sourceUnpositioned,
      report.layout.indeterminate,
      report.layout.notImported,
    ],
    placements: totalPlacements(trip.secondPlacements),
    translated: translatedViews(trip.firstPlacements, trip.secondPlacements),
  }
}

// ── the tests ────────────────────────────────────────────────────────────────

describe.each(FIXTURES)('%s', (name, fixture, expected) => {
  it('re-imports to the workspace the first import produced', async () => {
    const trip = await tripFor(name, fixture)
    expect(normalise(trip.after), formatFidelityReport(trip.after)).toEqual(normalise(trip.before))
  })

  it('brings back the numbers the file asked for', async () => {
    const trip = await tripFor(name, fixture)
    expect(headlineOf(trip), formatFidelityReport(trip.after)).toEqual(expected)
    // A view classified `relaid-out` is one whose arrangement the customer would
    // no longer recognise, and no fixture may produce one.
    expect(trip.after.layout.relaidOut).toBe(0)
  })

  it('keeps every shape on the same view, in the same place', async () => {
    const trip = await tripFor(name, fixture)

    expect([...trip.secondPlacements.keys()].sort()).toEqual([...trip.firstPlacements.keys()].sort())
    for (const [view, before] of trip.firstPlacements) {
      const after = trip.secondPlacements.get(view)
      expect(after, `view "${view}" lost its diagram`).toBeDefined()
      expect([...after!.keys()].sort(), `view "${view}" lost or gained shapes`).toEqual([...before.keys()].sort())
      // One displacement for the whole view = the arrangement is untouched;
      // several = shapes moved relative to each other, which is the layout loss
      // this exporter exists to prevent.
      const deltas = displacementsOf(before, after!)
      expect(deltas.length, `view "${view}" was reshaped, not moved: ${deltas.join(' ')}`).toBeLessThanOrEqual(1)
    }
  })

  it('is a file Structurizr will open: every view reference resolves, and to the right kind', async () => {
    const trip = await tripFor(name, fixture)
    // Asserted on the file we WRITE, not on the fixtures — the fixtures are
    // always clean, so checking them would catch nothing.
    expect(danglingViewReferences(trip.firstText)).toEqual([])
    expect(danglingViewReferences(trip.secondText)).toEqual([])
  })

  it('is drawn the way the file it came from is drawn', async () => {
    const trip = await tripFor(name, fixture)
    const before = appearanceByWireId(trip.sourceText)
    const after = appearanceByWireId(trip.firstText)
    const differences: string[] = []
    for (const [wireId, appearance] of before) {
      const now = after.get(wireId)
      if (now === undefined) {
        differences.push(`${wireId}: no longer in the model`)
        continue
      }
      const changed = appearanceDifferences(appearance, now)
      if (changed.length > 0) differences.push(`${wireId}: ${changed.join('; ')}`)
    }
    expect(differences).toEqual([])
  })

  it('is a fixed point from the second pass on', async () => {
    const trip = await tripFor(name, fixture)
    // Byte for byte, not merely report for report: the styles block is not in
    // the fidelity report at all, and it is the half prone to drift — e.g. a
    // stroke migrating from one tag to another between passes, or an element
    // style appearing that pass 1 never wrote.
    expect(trip.thirdText).toEqual(trip.secondText)
    expect(normalise(trip.settled)).toEqual(normalise(trip.after))
    for (const [view, second] of trip.secondPlacements) {
      const third = trip.thirdPlacements.get(view)
      expect(third, `view "${view}" disappeared on the third pass`).toBeDefined()
      expect(Object.fromEntries(third!), `view "${view}" drifted between passes`).toEqual(
        Object.fromEntries(second),
      )
    }
  })
})
