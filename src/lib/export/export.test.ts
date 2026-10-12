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

import { beforeAll, describe, expect, it } from 'vitest'
import type { C4Object, Connection, Diagram, Flow } from '../../types'
import { seededTechnologyUsages } from '../technologyUsage'
import { parseMapleSpireJson } from '../import/maplespireJson'
import type { ExportBundle } from './types'
import { buildModelJson } from './modelJson'
import { buildObjectsCsv, buildConnectionsCsv, OBJECTS_CSV_HEADER, CONNECTIONS_CSV_HEADER } from './csv'
import { buildSummaryModel, renderSummaryHtml, renderSummaryLlmsTxt, renderSummaryMarkdown, sliceForSummary } from './summary'
import { buildSummaryPdf } from './pdf'
import { renderExportSvg, type SvgScene } from './svg'
import { buildLegendModel, renderLegendSvg } from './legend'
import { buildStructurizrDsl } from './structurizr'
import { buildStructurizrJson } from './structurizrJson'
import {
  SYNTHETIC_UNGROUPED_SYSTEM_DESCRIPTION,
  SYNTHETIC_UNGROUPED_SYSTEM_NAME,
} from './structurizrJson/types'
import { buildMermaid } from './mermaid'
import { slug } from './download'
import { defaultSkin } from '../../skins/defaultSkin'
import { defaultSkinDark } from '../../skins/defaultSkinDark'
import i18n from '../i18n'

// These renderers pull their chrome text (section headers, "Legend", etc.) live from
// i18next, which auto-detects the machine's locale — on a non-English dev machine that
// resolves to French and every literal-string assertion below would fail. Pin the
// language so this test is deterministic regardless of where it runs (CI, a French-
// locale laptop, etc.), matching the project's off-environment test-stability rule.
beforeAll(async () => {
  await i18n.changeLanguage('en')
})

const obj = (partial: Partial<C4Object> & { id: string; name: string }): C4Object => ({
  type: 'app',
  description: undefined,
  position: { x: 0, y: 0 },
  size: { width: 180, height: 110 },
  tagAssignments: {}, tagOrder: [], scope: 'internal',
  status: 'live',
  properties: {},
  ...partial,
})

function fixtureBundle(): ExportBundle {
  const objects: C4Object[] = [
    obj({ id: 'sys', name: 'Platform', type: 'system', domainId: 'dom-a', description: 'The core platform' }),
    obj({
      id: 'web',
      name: 'Web app, storefront',
      type: 'app',
      parentId: 'sys',
      domainId: 'dom-a',
      technologyUsages: seededTechnologyUsages('web', ['React']),
      tagAssignments: { t1: { tagId: 't1' } },
      tagOrder: ['t1'],
      links: [{ url: 'https://example.com/repo', label: 'Source repository' }],
    }),
    obj({ id: 'db', name: 'Orders "DB"', type: 'store', parentId: 'sys', domainId: 'dom-b', scope: 'external', status: 'draft' }),
    obj({ id: 'other', name: 'Elsewhere', type: 'actor', domainId: 'dom-b' }),
  ]
  const connections: Connection[] = [
    { id: 'c1', fromId: 'web', toId: 'db', label: 'Reads, writes', type: 'solid', status: 'live' },
    { id: 'c2', fromId: 'other', toId: 'web', type: 'dashed' },
  ]
  const diagrams: Diagram[] = [
    {
      id: 'd1',
      name: 'Storefront · Context',
      type: 'context',
      objectIds: ['sys', 'web', 'db'],
      connectionIds: ['c1'],
      groupIds: [],
      layouts: { web: { position: { x: 40, y: 60 }, size: { width: 200, height: 120 } } },
    },
  ]
  const flows: Flow[] = [
    {
      id: 'f1',
      name: 'Checkout',
      diagramId: 'd1',
      steps: [
        { id: 's1', order: 1, type: 'introduction', title: 'A customer checks out' },
        { id: 's2', order: 2, type: 'message', title: 'Save order', fromObjectId: 'web', toObjectId: 'db', connectionId: 'c1' },
      ],
    },
  ]
  return {
    landscapeName: 'E-commerce platform',
    generatedAt: '2026-07-06T12:00:00.000Z',
    diagrams,
    activeDiagramId: 'd1',
    flowsByDiagram: { d1: flows },
    objects,
    connections,
    groups: [{
      id: 'platform-group', name: 'Platform group', color: '#888888', objectIds: ['web'],
      technologyUsages: {
        terraform: {
          id: 'terraform', technologyId: 'tech_seed_terraform', catalogRevision: 2,
          role: 'infrastructure',
          snapshot: {
            schemaVersion: 1, name: 'Terraform', recommendedShapeTypes: ['group'],
            defaultRole: 'infrastructure',
          },
        },
      },
      tagAssignments: {},
      tagOrder: [],
    }],
    domains: [
      { id: 'dom-a', name: 'Storefront' },
      { id: 'dom-b', name: 'Data', description: 'Data infrastructure' },
    ],
    tags: [{ tagId: 't1', value: 'frontend', color: '#D97A3D', groupId: 'taggrp-ui', groupName: 'Layer', catalogRevision: 1 }],
    decisionRecords: [],
  }
}

describe('slug', () => {
  it('kebab-cases names and middle dots', () => {
    expect(slug('Storefront · Context')).toBe('storefront-context')
    expect(slug('E-commerce platform')).toBe('e-commerce-platform')
    expect(slug('***')).toBe('export')
  })
})

describe('buildModelJson', () => {
  it('exports every top-level collection with a format header', () => {
    const parsed = JSON.parse(buildModelJson(fixtureBundle()))
    expect(parsed.format).toBe('maplespire-model')
    expect(parsed.version).toBe(3)
    expect(parsed.landscape).toBe('E-commerce platform')
    expect(parsed.domains).toHaveLength(2)
    expect(parsed.objects).toHaveLength(4)
    expect(parsed.connections).toHaveLength(2)
    expect(parsed.tags).toHaveLength(1)
    expect(parsed.flows).toHaveLength(1)
    expect(parsed.diagrams).toHaveLength(1)
    // Granular metadata survives — layouts, technology usages, links.
    expect(parsed.diagrams[0].layouts.web.size.width).toBe(200)
    const parsedWeb = parsed.objects.find((o: C4Object) => o.id === 'web') as C4Object
    expect(Object.values(parsedWeb.technologyUsages ?? {})[0].snapshot.name).toBe('React')
    expect(parsedWeb.links).toEqual([{ url: 'https://example.com/repo', label: 'Source repository' }])
    const imported = parseMapleSpireJson(buildModelJson(fixtureBundle()))
    expect(imported.groups[0].technologyUsages?.terraform).toMatchObject({
      technologyId: 'tech_seed_terraform',
      role: 'infrastructure',
      snapshot: { recommendedShapeTypes: ['group'], defaultRole: 'infrastructure' },
    })
  })
})

describe('CSV exports', () => {
  it('objects CSV has the spec columns and quotes embedded commas/quotes', () => {
    const csv = buildObjectsCsv(fixtureBundle())
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n')
    expect(lines[0]).toBe(OBJECTS_CSV_HEADER.join(','))
    const web = lines.find((l) => l.includes('Web app'))!
    expect(web).toContain('"Web app, storefront"')
    expect(web).toContain('Platform') // Belongs Inside System via parent chain
    expect(web).toContain('React')
    expect(web).toContain('https://example.com/repo')
    const db = lines.find((l) => l.includes('Orders'))!
    expect(db).toContain('"Orders ""DB"""')
    expect(db).toContain('true') // external
    expect(db).toContain('draft')
  })

  it('connections CSV denormalises sender and receiver', () => {
    const csv = buildConnectionsCsv(fixtureBundle())
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n')
    expect(lines[0]).toBe(CONNECTIONS_CSV_HEADER.join(','))
    expect(lines[0].split(',')).toHaveLength(22)
    const c1 = lines.find((l) => l.startsWith('c1'))!
    expect(c1).toContain('"Web app, storefront"')
    expect(c1).toContain('"Reads, writes"')
    expect(c1).toContain('Outgoing')
    expect(c1).toContain('store')
  })
})

describe('summary exports', () => {
  it('slices by domain including connections that touch the scope', () => {
    const bundle = fixtureBundle()
    const slice = sliceForSummary(bundle, 'domain', 'dom-b')
    expect(slice.objects.map((o) => o.id).sort()).toEqual(['db', 'other'])
    // c1 touches db, c2 touches other — both cross into the domain.
    expect(slice.connections.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
    expect(slice.scopeLabel).toContain('Data')
  })

  it('slices by object including descendants', () => {
    const slice = sliceForSummary(fixtureBundle(), 'object', 'sys')
    expect(slice.objects.map((o) => o.id).sort()).toEqual(['db', 'sys', 'web'])
  })

  it('renders markdown with objects, connections, flows and tags', () => {
    const bundle = fixtureBundle()
    const md = renderSummaryMarkdown(buildSummaryModel(bundle, sliceForSummary(bundle, 'landscape')))
    expect(md).toContain('# E-commerce platform — model summary')
    expect(md).toContain('## Model objects')
    expect(md).toContain('### Apps')
    expect(md).toContain('**Web app, storefront**')
    expect(md).toContain('Web app, storefront → Orders "DB": Reads, writes')
    expect(md).toContain('### Checkout')
    expect(md).toContain('2. Web app, storefront → Orders "DB": Save order')
    expect(md).toContain('- Layer: frontend (1 objects)')
  })

  it('llms.txt opens with the H1 then a > blurb', () => {
    const bundle = fixtureBundle()
    const txt = renderSummaryLlmsTxt(buildSummaryModel(bundle, sliceForSummary(bundle, 'landscape')))
    const lines = txt.split('\n')
    expect(lines[0]).toMatch(/^# /)
    expect(lines[2]).toMatch(/^> A C4 architecture model/)
  })

  it('html is self-contained and escapes entity names', () => {
    const bundle = fixtureBundle()
    const html = renderSummaryHtml(buildSummaryModel(bundle, sliceForSummary(bundle, 'landscape')))
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('Orders &quot;DB&quot;')
    expect(html).not.toContain('<script')
  })
})

describe('buildSummaryPdf', () => {
  const model = () => buildSummaryModel(fixtureBundle(), sliceForSummary(fixtureBundle(), 'landscape'))

  const asText = (bytes: Uint8Array) => {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return s
  }

  it('produces a valid single-page PDF skeleton', () => {
    const text = asText(buildSummaryPdf(model(), 'portrait'))
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.endsWith('%%EOF')).toBe(true)
    expect(text).toContain('/MediaBox [0 0 612 792]')
    expect(text).toContain('/BaseFont /Helvetica')
    expect(text).toContain('xref')
  })

  it('landscape swaps the media box and escapes PDF specials', () => {
    const text = asText(buildSummaryPdf(model(), 'landscape'))
    expect(text).toContain('/MediaBox [0 0 792 612]')
    // "(1 objects)" etc. must escape parens inside content streams.
    expect(text).toContain('\\(1 objects\\)')
  })

  it('paginates long models', () => {
    const bundle = fixtureBundle()
    bundle.objects = Array.from({ length: 200 }, (_, i) => obj({ id: `o${i}`, name: `Object ${i}`, description: 'A described thing' }))
    const text = asText(buildSummaryPdf(buildSummaryModel(bundle, sliceForSummary(bundle, 'landscape')), 'portrait'))
    const pageCount = Number(text.match(/\/Count (\d+)/)?.[1])
    expect(pageCount).toBeGreaterThan(1)
  })
})

describe('renderExportSvg', () => {
  const scene = (dark = false): SvgScene => {
    const bundle = fixtureBundle()
    return {
      diagramName: 'Storefront · Context',
      objects: bundle.objects.filter((o) => o.id !== 'other'),
      connections: bundle.connections,
      groups: [],
      connectionGeoms: [
        {
          id: 'c1',
          segments: [{ x0: 100, y0: 100, cp1x: 150, cp1y: 100, cp2x: 200, cp2y: 160, x1: 250, y1: 160 }],
          fromEdge: { x: 100, y: 100 },
          toEdge: { x: 250, y: 160 },
          preTip: { x: 240, y: 158 },
          labelAt: { x: 175, y: 130 },
        },
      ],
      skin: dark ? defaultSkinDark : defaultSkin,
    }
  }

  it('draws themed nodes, curves, arrowheads and labels', () => {
    const svg = renderExportSvg(scene(), { measure: (t, size) => t.length * size * 0.55 })
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain(`fill="${defaultSkin.canvas.bg}"`)
    // The engine's cubic segment is serialised verbatim (translated coords).
    expect(svg).toContain('C ')
    expect(svg).toContain('Reads, writes')
    // Store renders as a cylinder (elliptical caps → arc commands).
    expect(svg).toContain('A ')
    // External store keeps the quieter external fill.
    expect(svg).toContain(defaultSkin.objects.store.fillExternal)
  })

  it('follows the dark skin for the dark theme', () => {
    const svg = renderExportSvg(scene(true), { measure: (t, size) => t.length * size * 0.55 })
    expect(svg).toContain(`fill="${defaultSkinDark.canvas.bg}"`)
  })

  it('uses localized shape types in badges instead of technology names', async () => {
    const render = () => renderExportSvg(scene(), { measure: (t, size) => t.length * size * 0.55 })

    await i18n.changeLanguage('en')
    const english = render()
    expect(english).toContain('>System</text>')
    expect(english).toContain('>App</text>')
    expect(english).toContain('>Data store</text>')
    expect(english).not.toContain('>React</text>')

    await i18n.changeLanguage('fr')
    const french = render()
    expect(french).toContain('>Système</text>')
    expect(french).toContain('>Stockage</text>')

    await i18n.changeLanguage('en')
  })

  it('embeds the legend below the content when asked', () => {
    const s = scene()
    const legend = buildLegendModel({ objects: s.objects, connections: s.connections, groups: [] })
    const plain = renderExportSvg(s, { measure: (t, size) => t.length * size * 0.55 })
    const withLegend = renderExportSvg(s, { measure: (t, size) => t.length * size * 0.55, legend })
    expect(withLegend).toContain('>Legend</text>')
    const height = (svg: string) => Number(svg.match(/height="(\d+)"/)?.[1])
    expect(height(withLegend)).toBeGreaterThan(height(plain))
  })
})

describe('legend', () => {
  it('describes only what the diagram contains, in order', () => {
    const bundle = fixtureBundle()
    const model = buildLegendModel({ objects: bundle.objects, connections: bundle.connections, groups: [] })
    expect(model.entries.map((e) => e.label)).toEqual([
      'Actor',
      'System',
      'App',
      'Store',
      'External',
      'Connection',
      'Dashed connection',
    ])
    // No components, no groups in the fixture → no such entries.
    expect(model.entries.some((e) => e.label === 'Component' || e.label === 'Group')).toBe(false)
  })

  it('renders a standalone themed legend SVG', () => {
    const bundle = fixtureBundle()
    const model = buildLegendModel({ objects: bundle.objects, connections: bundle.connections, groups: [] })
    const svg = renderLegendSvg(model, defaultSkin)
    expect(svg).toContain('<svg xmlns')
    expect(svg).toContain(`fill="${defaultSkin.canvas.bg}"`)
    expect(svg).toContain('>Legend</text>')
    expect(svg).toContain('Dashed connection')
    // Store swatch renders as a small cylinder (elliptical arc).
    expect(svg).toContain('A ')
  })
})

describe('buildStructurizrDsl — the two exporters describe ONE landscape', () => {
  // The DSL and the workspace JSON are two serialisations of the same estate. A
  // customer who takes both has to get the same answers out of them, and used
  // not to: the DSL re-derived C4Type→kind, the nesting rules, the scope tags,
  // the orphan wrapper, the shape-tag set and the view key, each a second
  // spelling of a rule the JSON side already had.

  const object = (over: Partial<C4Object> & { id: string }): C4Object => ({
    type: 'app',
    name: over.id,
    position: { x: 0, y: 0 },
    size: { width: 185, height: 100 },
    tagAssignments: {},
    tagOrder: [],
    scope: 'internal',
    status: 'live',
    properties: {},
    ...over,
  })

  const minimal = (objects: C4Object[]): ExportBundle => ({
    landscapeName: 'Estate',
    generatedAt: '2026-08-13T00:00:00Z',
    diagrams: [],
    activeDiagramId: null,
    flowsByDiagram: {},
    objects,
    connections: [],
    groups: [],
    domains: [],
    tags: [],
    decisionRecords: [],
  })

  it('applies the Database tag it styles, so a store survives a DSL round trip', () => {
    // `element "Database" { shape Cylinder }` was emitted whenever any object
    // was a store, and `tagsOf` never applied the tag — so the style matched
    // nothing and the store re-imported as a plain application unless its
    // technology string happened to trip `isDatastore`. The JSON exporter had
    // this right, which is precisely the divergence.
    const dsl = buildStructurizrDsl(minimal([object({ id: 'ledger', type: 'store', name: 'Ledger' })]))

    expect(dsl).toContain('element "Database" {')
    expect(dsl).toMatch(/tags "Database"/)
  })

  it('hoists a person out of a software system instead of emitting DSL that will not parse', () => {
    // `person` is not legal inside `softwareSystem`. The nesting rule here kept
    // both `person` and `softwareSystem` un-demoted, so a landscape that nests
    // either produced a .dsl no parser accepts.
    const dsl = buildStructurizrDsl(
      minimal([
        object({ id: 'platform', type: 'system', name: 'Platform' }),
        object({ id: 'operator', type: 'actor', name: 'Operator', parentId: 'platform' }),
      ]),
    )

    const personLine = dsl.split('\n').find((line) => line.includes('= person'))!
    const systemLine = dsl.split('\n').find((line) => line.includes('= softwareSystem'))!
    // Same indentation = same level: the person is a sibling of the system, not
    // a child of it.
    expect(personLine.length - personLine.trimStart().length).toBe(
      systemLine.length - systemLine.trimStart().length,
    )
  })

  it('demotes a software system nested in another to a container, as the JSON export does', () => {
    const dsl = buildStructurizrDsl(
      minimal([
        object({ id: 'platform', type: 'system', name: 'Platform' }),
        object({ id: 'sub', type: 'system', name: 'Sub', parentId: 'platform' }),
      ]),
    )

    expect(dsl).toContain('sub = container "Sub"')
    expect(dsl).not.toMatch(/sub = softwareSystem/)
  })

  it('wraps orphans in the same system the JSON export wraps them in', () => {
    // Two exports of one landscape that disagree about the wrapper give the
    // customer two different systems.
    const dsl = buildStructurizrDsl(minimal([object({ id: 'loose', name: 'Loose App' })]))
    const json = JSON.parse(buildStructurizrJson(minimal([object({ id: 'loose', name: 'Loose App' })]))) as {
      model: { softwareSystems: Array<{ name: string; description?: string }> }
    }

    const wrapper = json.model.softwareSystems.find((system) => system.name === SYNTHETIC_UNGROUPED_SYSTEM_NAME)!
    expect(wrapper.description).toBe(SYNTHETIC_UNGROUPED_SYSTEM_DESCRIPTION)
    expect(dsl).toContain(`softwareSystem "${SYNTHETIC_UNGROUPED_SYSTEM_NAME}"`)
    expect(dsl).toContain(`"${SYNTHETIC_UNGROUPED_SYSTEM_DESCRIPTION}"`)
  })

  it('gives one diagram one view key in both files', () => {
    // View keys are deep-link targets, `filtered <baseKey>` references and
    // `defaultView` values. This slugged to lower case and deduped
    // case-SENSITIVELY while the JSON preserved case and deduped
    // case-INSENSITIVELY, as `View.compareTo` does.
    const drawn: Diagram = {
      id: 'd1',
      name: 'Ctx View',
      type: 'context',
      objectIds: ['a'],
      connectionIds: [],
      groupIds: [],
      layouts: { a: { position: { x: 10, y: 10 }, size: { width: 200, height: 100 } } },
    }
    const withView: ExportBundle = {
      ...minimal([object({ id: 'a', type: 'system', name: 'Alpha' })]),
      diagrams: [drawn],
    }

    const dsl = buildStructurizrDsl(withView)
    const json = JSON.parse(buildStructurizrJson(withView)) as {
      views: Record<string, Array<{ key: string }>>
    }
    const jsonKey = Object.values(json.views).flat().find((view) => typeof view?.key === 'string')!.key

    expect(dsl).toContain(`"${jsonKey}" {`)
  })
})

describe('buildStructurizrDsl', () => {
  it('emits a nested workspace mirroring the import mapper conventions', () => {
    const dsl = buildStructurizrDsl(fixtureBundle())
    expect(dsl).toContain('workspace "E-commerce platform" {')
    // Actor -> person; system contains its containers.
    expect(dsl).toContain('elsewhere = person "Elsewhere"')
    expect(dsl).toMatch(/platform = softwareSystem "Platform" "The core platform" \{/)
    expect(dsl).toContain('web_app_storefront = container "Web app, storefront"')
    // Store keeps its type via container + no crash on quotes in names.
    expect(dsl).toContain('orders_db = container "Orders \\"DB\\""')
    // Tags emitted for the tagged app.
    expect(dsl).toContain('tags "frontend"')
    // Relationship uses identifiers + escaped label.
    expect(dsl).toContain('web_app_storefront -> orders_db "Reads, writes"')
    // Context diagram without a parent object -> systemLandscape view. The key
    // is minted by `ExportIds`, the same allocator the workspace-JSON exporter
    // uses, so the two files a customer holds for one landscape name the view
    // identically (not lower-cased in one and case-preserved in the other,
    // which would be two names for one deep-link target).
    expect(dsl).toContain('systemLandscape "Storefront-Context" {')
    // Sorted, not in objectIds order: membership comes from a Set, so the
    // insertion order differs between an import and a re-import of our own
    // export and produced a spurious diff on every round trip. The set is the
    // meaning; the order is not.
    expect(dsl).toContain('include orders_db platform web_app_storefront')
    expect(dsl).toContain('autoLayout')
  })

  it('round-trips through the Structurizr parser+mapper', async () => {
    const { parseWorkspace } = await import('../structurizr/parser')
    const { mapWorkspace } = await import('../structurizr/mapper')
    const dsl = buildStructurizrDsl(fixtureBundle())
    const mapped = mapWorkspace(parseWorkspace(dsl))
    expect(mapped.objects.map((o) => o.name)).toContain('Web app, storefront')
    const web = mapped.objects.find((o) => o.name === 'Web app, storefront')!
    expect(web.type).toBe('app')
    expect(Object.values(web.technologyUsages ?? {})[0]?.snapshot.name).toBe('React')
    const platform = mapped.objects.find((o) => o.name === 'Platform')!
    expect(web.parentId).toBe(platform.id)
    expect(mapped.connections.length).toBeGreaterThan(0)
  })
})

describe('buildMermaid', () => {
  it('landscape scope emits one C4Context with boundaries', () => {
    const mmd = buildMermaid(fixtureBundle(), 'landscape')
    expect(mmd.startsWith('C4Context')).toBe(true)
    expect(mmd).toContain('title E-commerce platform')
    // Platform has children -> becomes a System_Boundary containing them.
    expect(mmd).toContain('System_Boundary(sys, "Platform") {')
    expect(mmd).toContain('Container(web, "Web app, storefront", "React"')
    // External store -> ContainerDb_Ext inside the boundary; quotes sanitised.
    expect(mmd).toContain('ContainerDb_Ext(db, "Orders ”DB”"')
    expect(mmd).toContain('Person(other, "Elsewhere")')
    expect(mmd).toContain('Rel(web, db, "Reads, writes")')
  })

  it('diagram scope emits the diagram at its own level', () => {
    const bundle = fixtureBundle()
    const mmd = buildMermaid(bundle, 'diagram')
    expect(mmd.startsWith('C4Context')).toBe(true) // d1 is a context diagram
    expect(mmd).toContain('title Storefront · Context')
    // Only diagram members appear ('other' is not on d1).
    expect(mmd).not.toContain('Elsewhere')
    // c1 is on the diagram; its endpoints render inside the Platform boundary.
    expect(mmd).toContain('Rel(web, db, "Reads, writes")')
  })
})

describe('buildSummaryPdf with an embedded diagram image', () => {
  const model = () => buildSummaryModel(fixtureBundle(), sliceForSummary(fixtureBundle(), 'landscape'))
  const asText = (bytes: Uint8Array) => {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return s
  }

  it('adds the image XObject, resources and draw op', () => {
    const image = { data: new Uint8Array([1, 2, 3, 4]), width: 200, height: 100, filter: 'FlateDecode' as const }
    const text = asText(buildSummaryPdf(model(), 'portrait', image))
    expect(text).toContain('/Subtype /Image /Width 200 /Height 100')
    expect(text).toContain('/Filter /FlateDecode')
    expect(text).toContain('/XObject << /Im1 5 0 R >>')
    expect(text).toMatch(/q [\d.]+ 0 0 [\d.]+ 56 [\d.]+ cm \/Im1 Do Q/)
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.endsWith('%%EOF')).toBe(true)
  })

  it('stays valid without an image (object ids unshifted)', () => {
    const text = asText(buildSummaryPdf(model(), 'portrait'))
    expect(text).not.toContain('/XObject')
    expect(text).toContain('5 0 obj\n<< /Type /Page')
  })
})
