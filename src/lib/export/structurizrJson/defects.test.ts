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
 * One regression test per known exporter defect, each written from the
 * reproduction rather than from the fix.
 *
 * They are together in one file on purpose. Each is a small hand-built
 * `ExportBundle` in MapleSpire's own terms — no `structurizr.id` anywhere unless
 * the defect is about provenance — because that is the case the fixture corpus
 * cannot reach: every fixture arrives through the importer, so a landscape
 * somebody DREW is the one shape of input nothing else here covers, and it is
 * where most of these live.
 */

import { describe, expect, it } from 'vitest'
import type { C4Object, Connection, DecisionRecord, Diagram, Group, Tag } from '../../../types'
import { importedTag } from '../../structurizr/mapper'
import type { ExportBundle } from '../types'
import { buildStructurizrJson, buildStructurizrJsonFile, buildStructurizrWorkspace } from '.'
import { buildExportContext } from './types'
import { buildWireViewSet } from './views'

// ── fixtures in MapleSpire's own terms ───────────────────────────────────────

const object = (id: string, over: Partial<C4Object> = {}): C4Object => ({
  id,
  type: 'app',
  name: id,
  position: { x: 0, y: 0 },
  size: { width: 185, height: 100 },
  tagAssignments: {},
  tagOrder: [],
  scope: 'internal',
  status: 'live',
  properties: {},
  ...over,
})

const group = (id: string, over: Partial<Group> = {}): Group => ({
  id,
  name: id,
  color: '#dbeafe',
  objectIds: [],
  autoSize: false,
  tagAssignments: {},
  tagOrder: [],
  properties: {},
  ...over,
})

const diagram = (id: string, over: Partial<Diagram> = {}): Diagram => ({
  id,
  name: id,
  type: 'context',
  objectIds: [],
  connectionIds: [],
  groupIds: [],
  ...over,
})

const bundle = (over: Partial<ExportBundle>): ExportBundle => ({
  landscapeName: 'Estate',
  generatedAt: '2026-08-13T00:00:00Z',
  diagrams: [],
  activeDiagramId: null,
  flowsByDiagram: {},
  objects: [],
  connections: [],
  groups: [],
  domains: [],
  tags: [],
  decisionRecords: [],
  ...over,
})

type Wire = Record<string, never>
const emit = (over: Partial<ExportBundle>): Wire => JSON.parse(buildStructurizrJson(bundle(over))) as Wire

/** Every element in an emitted model, flattened to `id → kind`. */
function kindsById(workspace: Wire): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (nodes: unknown, kind: string): void => {
    for (const node of (nodes ?? []) as Array<Record<string, unknown>>) {
      out.set(String(node.id), kind)
      walk(node.containers, 'container')
      walk(node.components, 'component')
      walk(node.children, 'deploymentNode')
      walk(node.infrastructureNodes, 'infrastructureNode')
      walk(node.containerInstances, 'containerInstance')
      walk(node.softwareSystemInstances, 'softwareSystemInstance')
    }
  }
  const model = (workspace as unknown as { model: Record<string, unknown> }).model
  walk(model.people, 'person')
  walk(model.softwareSystems, 'softwareSystem')
  walk(model.deploymentNodes, 'deploymentNode')
  return out
}

// ── 1. a view may never name an element the model put in the deployment tree ──

describe('view scope vs the deployment tree', () => {
  it('does not scope a component view to a DeploymentNode', () => {
    // Reachable from an ordinary import: `mapWorkspace` stamps
    // `structurizr.environment` on a childless deployment node, and somebody
    // drills into it. `kindByObjectId` still calls the host a `container`, so a
    // views emitter that cannot see the model's deployment claim writes
    // `componentViews[].containerId` naming a `DeploymentNode` — and
    // `ViewSet.java` casts BEFORE its null check, so that is an unchecked
    // `ClassCastException` escaping `WorkspaceReaderException`, not a message.
    const workspace = emit({
      objects: [
        object('node', {
          name: 'Host',
          properties: { 'structurizr.environment': 'Live', 'structurizr.instances': '1' },
        }),
        object('comp', { type: 'component', name: 'Widget', parentId: 'node' }),
      ],
      diagrams: [
        diagram('d1', {
          name: 'Components',
          type: 'component',
          objectIds: ['comp'],
          layouts: { comp: { position: { x: 10, y: 10 }, size: { width: 185, height: 100 } } },
        }),
      ],
    })

    const kinds = kindsById(workspace)
    const views = (workspace as unknown as { views: Record<string, Array<Record<string, string>>> }).views
    for (const view of views.componentViews ?? []) {
      expect(kinds.get(view.containerId), `containerId "${view.containerId}"`).toBe('container')
    }
  })

  it('does not scope a view to a wrapper system the model never emitted', () => {
    // The mirror image: `belongsToWrapper` read `kindByObjectId` alone, so a
    // shape claimed for the deployment tree still counted as an orphan and the
    // view named the synthetic "Ungrouped" system — which the model emitter, who
    // knew better, never allocated. `hydrate` rule 4: the file does not open.
    const workspace = emit({
      objects: [object('loose', { name: 'Loose App' })],
      groups: [
        group('node', {
          name: 'Server',
          type: 'Deployment node',
          objectIds: ['loose'],
          properties: { 'structurizr.id': '1' },
        }),
      ],
      diagrams: [
        diagram('d1', {
          name: 'Containers',
          type: 'container',
          objectIds: ['loose'],
          layouts: { loose: { position: { x: 10, y: 10 }, size: { width: 200, height: 100 } } },
        }),
      ],
    })

    const kinds = kindsById(workspace)
    const views = (workspace as unknown as { views: Record<string, Array<Record<string, string>>> }).views
    for (const [collection, rows] of Object.entries(views)) {
      if (!Array.isArray(rows)) continue
      for (const view of rows) {
        if (view.softwareSystemId === undefined) continue
        expect(kinds.get(view.softwareSystemId), `${collection} softwareSystemId`).toBe('softwareSystem')
      }
    }
  })
})

// ── 2. groups ────────────────────────────────────────────────────────────────

describe('groups', () => {
  it('declares the separator the workspace actually used, not always "/"', () => {
    // The importer records the separator alongside the path it joined with it.
    // Without that the export re-emits `Payments|Core` and declares nothing, so
    // every reader — ours included — sees ONE flat group literally named
    // "Payments|Core" and the hierarchy is gone with no diagnostic (T5, §13.6).
    const separated = {
      'structurizr.group': 'Payments|Core',
      'structurizr.groupSeparator': '|',
    }
    const workspace = emit({
      objects: [object('o1', { name: 'Ledger' })],
      groups: [
        group('g1', { name: 'Payments', objectIds: ['o1'], properties: { 'structurizr.group': 'Payments', 'structurizr.groupSeparator': '|' } }),
        group('g2', { name: 'Core', objectIds: ['o1'], properties: separated }),
      ],
    })

    const model = workspace as unknown as {
      model: {
        properties: Record<string, string>
        softwareSystems: Array<{ group?: string; containers?: Array<{ group?: string }> }>
      }
    }
    expect(model.model.properties['structurizr.groupSeparator']).toBe('|')
    const system = model.model.softwareSystems[0]
    expect(system?.containers?.[0]?.group ?? system?.group).toBe('Payments|Core')
  })

  it('composes a path for groups drawn in MapleSpire, which carry no path of their own', () => {
    // A group created here has only a name. The nesting is in the MEMBERSHIP,
    // which the deployment tree next door already reads out of exactly that —
    // so a shape inside three nested groups must not leave with ONE `group`
    // string chosen by whichever NAME happens to be longest ("Payments").
    const workspace = emit({
      objects: [object('o1', { type: 'system', name: 'Ledger' })],
      groups: [
        group('g1', { name: 'Payments', objectIds: ['o1'] }),
        group('g2', { name: 'Core', objectIds: ['o1'] }),
        group('g3', { name: 'Ledgers', objectIds: ['o1'] }),
      ],
    })

    const model = workspace as unknown as {
      model: { properties?: Record<string, string>; softwareSystems: Array<Record<string, string>> }
    }
    expect(model.model.softwareSystems[0]?.group).toBe('Payments/Core/Ledgers')
    expect(model.model.properties?.['structurizr.groupSeparator']).toBe('/')
  })
})

// ── 3. what the wire has a field for and we were not writing ─────────────────

describe('fields that were dropped', () => {
  it("writes a connection's Markdown description, not only its label", () => {
    // `Connection.description` is "unbounded Markdown documentation for the
    // relationship" and the wire's `description` is the only field there is for
    // it. This read `label` alone. No round trip could see it, because the
    // importer only ever fills `label` — it is exactly the MapleSpire-authored
    // case the fixture corpus cannot reach.
    const workspace = emit({
      objects: [object('a', { type: 'system' }), object('b', { type: 'system' })],
      connections: [{ id: 'c1', fromId: 'a', toId: 'b', type: 'solid', label: 'Uses', description: 'The long story' }],
    })

    const systems = (workspace as unknown as { model: { softwareSystems: Array<Record<string, never>> } }).model
      .softwareSystems
    const relationship = (systems[0] as unknown as { relationships: Array<{ description: string }> }).relationships[0]
    expect(relationship.description).toContain('Uses')
    expect(relationship.description).toContain('The long story')
  })

  it('folds a decision record’s summary into its content and normalises CRLF', () => {
    // §5.6 requires CR/CRLF normalised to LF — a Windows-authored ADR otherwise
    // reads back CHANGED on every round trip and shows in git as a diff that is
    // not a change. And `summary` has no field of its own on the wire, so it is
    // folded into `content` or it is dropped.
    const record: DecisionRecord = {
      id: 'adr-1',
      number: 1,
      title: 'Use Postgres',
      status: 'approved',
      summary: 'The one-line summary of Use Postgres',
      content: '# Use Postgres\r\n\r\nBody line one.\r\nBody line two.',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as DecisionRecord

    const workspace = emit({ decisionRecords: [record] })
    const decision = (workspace as unknown as { documentation: { decisions: Array<{ content: string }> } })
      .documentation.decisions[0]

    expect(decision.content).toContain('The one-line summary of Use Postgres')
    expect(decision.content).toContain('Body line one.')
    expect(decision.content).not.toContain('\r')
  })

  it('carries the domain an estate is organised by', () => {
    // Not one line of the exporter read `bundle.domains` or `object.domainId`,
    // so a domain-organised estate left with that whole dimension erased and no
    // warning. `properties` is the channel the format offers for a fact it does
    // not model.
    const workspace = emit({
      objects: [object('o1', { type: 'system', name: 'Ledger', domainId: 'dom-a' })],
      domains: [{ id: 'dom-a', name: 'Payments' }],
    })

    const model = workspace as unknown as {
      model: { properties: Record<string, string>; softwareSystems: Array<{ properties: Record<string, string> }> }
    }
    expect(model.model.properties['maplespire.domain.dom-a']).toBe('Payments')
    expect(model.model.softwareSystems[0]?.properties['maplespire.domain']).toBe('Payments')
  })

  it('carries a shape’s status, its owning teams and the links after the first', () => {
    const workspace = emit({
      objects: [
        object('o1', {
          type: 'system',
          name: 'Ledger',
          status: 'draft',
          ownerTeamIds: ['team-a', 'team-b'],
          links: [{ url: 'https://one.example.com' }, { url: 'https://two.example.com' }],
        }),
      ],
    })

    const system = (workspace as unknown as { model: { softwareSystems: Array<Record<string, never>> } }).model
      .softwareSystems[0] as unknown as { url: string; properties: Record<string, string> }
    expect(system.url).toBe('https://one.example.com')
    expect(system.properties['maplespire.status']).toBe('draft')
    expect(system.properties['maplespire.ownerTeamIds']).toBe('team-a, team-b')
    expect(system.properties['maplespire.links']).toContain('https://two.example.com')
  })
})

// ── 4. styles: never repaint, never invent ───────────────────────────────────

describe('styles', () => {
  const tag = (value: string, color: string): Tag => ({
    tagId: `tag-${value}`,
    value,
    color,
    groupId: 'g',
    groupName: 'G',
    catalogRevision: 1,
  })

  it('does not repaint the workspace over a customer tag named after a wire default', () => {
    // `Element` is on every element in the format. A MapleSpire tag that happens
    // to be spelled the same, on ONE shape, must not produce
    // `{ tag: "Element", background: … }` — every element, person,
    // deployment node and instance in the workspace would change colour.
    const reserved = tag('Element', '#73b234')
    const workspace = emit({
      tags: [reserved],
      objects: [
        object('a', { type: 'system', tagOrder: [reserved.tagId], tagAssignments: { [reserved.tagId]: { tagId: reserved.tagId } } }),
        object('b', { type: 'system' }),
      ],
    })

    const styles = (workspace as unknown as { views: { configuration?: { styles?: { elements?: Array<{ tag: string }> } } } })
      .views.configuration?.styles?.elements ?? []
    expect(styles.map((style) => style.tag)).not.toContain('Element')
  })

  it('does not write the chip colour an import assigned a tag into the file as a background', () => {
    // Every tag an import mints gets an `hsl(...)` from `importedTagColor`,
    // whatever the file said. Writing it out as an element `background` invented
    // a palette for every imported workspace there is — a landscape drawn by
    // hand and round-tripped came back with a mustard person.
    const auto = importedTag('Queue')
    const workspace = emit({
      tags: [auto],
      objects: [object('a', { type: 'system', tagOrder: [auto.tagId], tagAssignments: { [auto.tagId]: { tagId: auto.tagId } } })],
    })

    const styles = (workspace as unknown as { views: { configuration?: { styles?: { elements?: Array<{ tag: string }> } } } })
      .views.configuration?.styles?.elements ?? []
    expect(styles.find((style) => style.tag === 'Queue')).toBeUndefined()
  })

  it('still paints a tag someone chose a colour for', () => {
    // The rule is not "ignore tag colours" — it is "ignore the ones nobody
    // chose". A colour a person picked is the only statement about appearance a
    // hand-drawn landscape has.
    const chosen = tag('Critical', '#e05252')
    const workspace = emit({
      tags: [chosen],
      objects: [object('a', { type: 'system', tagOrder: [chosen.tagId], tagAssignments: { [chosen.tagId]: { tagId: chosen.tagId } } })],
    })

    const styles = (workspace as unknown as { views: { configuration?: { styles?: { elements?: Array<{ tag: string; background?: string }> } } } })
      .views.configuration?.styles?.elements ?? []
    expect(styles.find((style) => style.tag === 'Critical')?.background).toBe('#e05252')
  })

  it('keeps the icon an import recorded on a shape', () => {
    // `recordedElementStyle` read background/color/stroke/shape and not `icon`,
    // so an imported RabbitMQ logo left the workspace on the way in and never
    // came back — only artwork MapleSpire holds itself was re-emitted.
    const queue = tag('Queue', '#e05252')
    const workspace = emit({
      tags: [queue],
      objects: [
        object('a', {
          type: 'system',
          tagOrder: [queue.tagId],
          tagAssignments: { [queue.tagId]: { tagId: queue.tagId } },
          properties: { 'structurizr.style.icon': 'https://static.structurizr.com/icons/rabbitmq.png' },
        }),
      ],
    })

    const styles = (workspace as unknown as { views: { configuration?: { styles?: { elements?: Array<{ tag: string; icon?: string }> } } } })
      .views.configuration?.styles?.elements ?? []
    expect(styles.find((style) => style.tag === 'Queue')?.icon).toBe(
      'https://static.structurizr.com/icons/rabbitmq.png',
    )
  })

  it('puts the synthetic Database tag BEFORE the author’s, so their shape wins', () => {
    // Styles resolve left to right and the rightmost match wins, so appending
    // `Database` after the author's tags let our `Cylinder` beat the `Pipe` they
    // set upstream. `Order Queue` came back a cylinder after one round trip.
    const queue = tag('Queue', '#e05252')
    const workspace = emit({
      tags: [queue],
      objects: [
        object('q', {
          type: 'store',
          name: 'Order Queue',
          tagOrder: [queue.tagId],
          tagAssignments: { [queue.tagId]: { tagId: queue.tagId } },
          properties: { 'structurizr.style.shape': 'Pipe' },
        }),
      ],
    })

    const system = (workspace as unknown as { model: { softwareSystems: Array<{ containers: Array<{ tags: string }> }> } })
      .model.softwareSystems[0]!.containers[0]!
    const tags = system.tags.split(',')
    expect(tags.indexOf('Database')).toBeLessThan(tags.indexOf('Queue'))
  })
})

// ── 5. the warnings are reachable ────────────────────────────────────────────

describe('the export report', () => {
  it('hands the caller what it could not say faithfully', () => {
    // ~20 `ctx.warn` sites had no production reader at all: `buildStructurizrJson`
    // returned the text and dropped `.warnings` on the floor, and
    // `buildStructurizrWorkspace` had no production caller. A customer whose
    // export renamed two systems to satisfy rule 14 was told nothing.
    const duplicated = bundle({
      objects: [object('a', { type: 'system', name: 'Payments' }), object('b', { type: 'system', name: 'Payments' })],
    })

    const built = buildStructurizrJsonFile(duplicated)
    expect(built.warnings.join('\n')).toContain('Payments')
    expect(built.warnings.length).toBeGreaterThan(0)
    // …and the same report the workspace builder produces, not a second one.
    expect(built.warnings).toEqual(buildStructurizrWorkspace(duplicated).warnings)
  })
})

// ── 6. judgements with a paragraph of reasoning and no assertion ─────────────

describe('the judgement calls', () => {
  it('never scopes the workspace to a single software system', () => {
    // `configuration.scope: "SoftwareSystem"` makes `hydrate()` REJECT a
    // workspace holding more than one system, and a diagram-scope export still
    // carries its members' ancestors. Nothing pinned the one field that would
    // make every multi-system export unopenable.
    const workspace = emit({ objects: [object('a', { type: 'system' }), object('b', { type: 'system' })] })
    expect((workspace as unknown as { configuration: { scope: string } }).configuration.scope).toBe('Landscape')
  })

  it('numbers dynamic steps by emitted row, so two steps on one edge never tie', () => {
    // `RelationshipView.compareTo` is `id + "/" + order`, so two rows on one
    // relationship sharing an order are ONE row to the reference reader's
    // `TreeSet` — dropped before any validation fires. Two steps that tie on
    // `order` are legal in MapleSpire.
    const objects = [object('a', { type: 'system' }), object('b', { type: 'system' })]
    const connection: Connection = { id: 'c1', fromId: 'a', toId: 'b', type: 'solid', label: 'Calls' }
    const drawn = diagram('d1', {
      name: 'Flow',
      objectIds: ['a', 'b'],
      connectionIds: ['c1'],
      layouts: {
        a: { position: { x: 0, y: 0 }, size: { width: 200, height: 100 } },
        b: { position: { x: 400, y: 0 }, size: { width: 200, height: 100 } },
      },
    })
    const step = (id: string, order: number, title: string) => ({
      id,
      order,
      type: 'message' as const,
      title,
      fromObjectId: 'a',
      toObjectId: 'b',
      connectionId: 'c1',
    })
    const ctx = buildExportContext(
      bundle({
        objects,
        connections: [connection],
        diagrams: [drawn],
        // Both steps claim order 1 — legal here, fatal upstream.
        flowsByDiagram: { d1: [{ id: 'f1', name: 'Flow', diagramId: 'd1', steps: [step('s1', 1, 'First'), step('s2', 1, 'Second')] }] },
      }),
    )

    const rows = buildWireViewSet(ctx).dynamicViews?.[0]?.relationships ?? []
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => `${row.id}/${row.order ?? ''}`)).size).toBe(2)
  })

  it('scopes a container view by a STRICT ancestor, never by a participant', () => {
    // A system drawn ON a container view is a neighbour, not the view's scope.
    // Matching an element against itself scopes the view to whichever
    // participant the loop reached first.
    const workspace = emit({
      objects: [
        object('sysA', { type: 'system', name: 'Owner' }),
        object('sysB', { type: 'system', name: 'Neighbour' }),
        object('c1', { name: 'API', parentId: 'sysA' }),
      ],
      diagrams: [
        diagram('d1', {
          name: 'Containers',
          type: 'container',
          // `Neighbour` comes FIRST, so a scope taken from the members
          // themselves picks it.
          objectIds: ['sysB', 'c1'],
          layouts: {
            sysB: { position: { x: 0, y: 0 }, size: { width: 200, height: 100 } },
            c1: { position: { x: 400, y: 0 }, size: { width: 185, height: 100 } },
          },
        }),
      ],
    })

    const kinds = kindsById(workspace)
    const view = (workspace as unknown as { views: { containerViews: Array<{ softwareSystemId: string }> } }).views
      .containerViews[0]!
    expect(kinds.get(view.softwareSystemId)).toBe('softwareSystem')
    // The owner of the container on the view, not the neighbour standing on it.
    const systems = (workspace as unknown as { model: { softwareSystems: Array<{ id: string; name: string }> } }).model
      .softwareSystems
    expect(systems.find((system) => system.id === view.softwareSystemId)?.name).toBe('Owner')
  })

  it('keeps the coordinate 0, which is a placement and not an absence', () => {
    // The serialiser drops `null`, `""`, `[]` and `{}` and must NOT drop `0` or
    // `false`. `connection.labelPosition === 0` becoming an absent `position`
    // moves the label to mid-line, because a reader defaults it to 50.
    const workspace = emit({
      objects: [object('a', { type: 'system' }), object('b', { type: 'system' })],
      connections: [{ id: 'c1', fromId: 'a', toId: 'b', type: 'solid', label: 'Calls', labelPosition: 0 }],
      diagrams: [
        diagram('d1', {
          name: 'Context',
          objectIds: ['a', 'b'],
          connectionIds: ['c1'],
          layouts: {
            a: { position: { x: 0, y: 0 }, size: { width: 200, height: 100 } },
            b: { position: { x: 400, y: 0 }, size: { width: 200, height: 100 } },
          },
        }),
      ],
    })

    const view = (workspace as unknown as {
      views: { systemLandscapeViews: Array<{ relationships: Array<{ position?: number }> }> }
    }).views.systemLandscapeViews[0]!
    expect(view.relationships[0]?.position).toBe(0)
  })

  it('emits `instances` as a STRING, which may legally be a range', () => {
    // T15. Asserted on the raw value — coercing with `String(...)` in the test
    // would make it unable to fail on type.
    const workspace = emit({
      objects: [
        object('node', {
          name: 'Host',
          properties: { 'structurizr.environment': 'Live', 'structurizr.instances': '0..5' },
        }),
      ],
    })

    const node = (workspace as unknown as { model: { deploymentNodes: Array<{ instances: unknown }> } }).model
      .deploymentNodes[0]!
    expect(typeof node.instances).toBe('string')
    expect(node.instances).toBe('0..5')
  })

  it('keeps a childless deployment node a node, not an infrastructure node', () => {
    // `instances` is the only surviving trace of which kind a childless node
    // was; without the discriminator it silently becomes a different element.
    const workspace = emit({
      objects: [
        object('node', {
          name: 'Host',
          properties: { 'structurizr.environment': 'Live', 'structurizr.instances': '1' },
        }),
        object('infra', {
          name: 'Route 53',
          properties: { 'structurizr.environment': 'Live' },
        }),
      ],
      groups: [group('n1', { name: 'Region', type: 'Deployment node', objectIds: ['node', 'infra'] })],
    })

    const kinds = kindsById(workspace)
    const named = new Map<string, string>()
    const walk = (nodes: unknown): void => {
      for (const node of (nodes ?? []) as Array<Record<string, unknown>>) {
        if (typeof node.name === 'string') named.set(node.name, kinds.get(String(node.id))!)
        walk(node.children)
        walk(node.infrastructureNodes)
      }
    }
    walk((workspace as unknown as { model: { deploymentNodes: unknown } }).model.deploymentNodes)
    expect(named.get('Host')).toBe('deploymentNode')
    expect(named.get('Route 53')).toBe('infrastructureNode')
  })

  it('scopes container names per software system, as rule 14 does', () => {
    // Two systems may each hold an "API"; the same system may not. Scoping the
    // uniqueness check globally renames one of the customer's containers for no
    // reason, and scoping it not at all writes a file that will not open.
    const workspace = emit({
      objects: [
        object('s1', { type: 'system', name: 'Alpha' }),
        object('s2', { type: 'system', name: 'Beta' }),
        object('a1', { name: 'API', parentId: 's1' }),
        object('a2', { name: 'API', parentId: 's2' }),
      ],
    })

    const systems = (workspace as unknown as {
      model: { softwareSystems: Array<{ containers: Array<{ name: string }> }> }
    }).model.softwareSystems
    expect(systems.map((system) => system.containers[0]?.name)).toEqual(['API', 'API'])
  })

  it('falls back to the compact description when a shape has only that', () => {
    const workspace = emit({
      objects: [object('a', { type: 'system', shortDescription: 'Drawn on the box' })],
    })
    const system = (workspace as unknown as { model: { softwareSystems: Array<{ description?: string }> } }).model
      .softwareSystems[0]!
    expect(system.description).toBe('Drawn on the box')
  })

  it('does not let one enlarged shape pack the whole view into a pile', () => {
    // The export scale is the reciprocal of the importer's, and a reciprocal of
    // a MAXIMUM is a MINIMUM — so the biggest box on the view decided the
    // spacing for everyone. A shape dragged bigger than the 450x300 Structurizr
    // draws needs LESS room upstream, not more, and letting it set the factor
    // packed the other three 150px apart while each was drawn 450 wide.
    const sized = (id: string, x: number, y: number, width: number, height: number) => ({
      id,
      position: { x, y },
      size: { width, height },
    })
    const members = [
      sized('a', 0, 0, 200, 100),
      sized('b', 300, 0, 200, 100),
      sized('c', 600, 0, 200, 100),
      sized('big', 0, 400, 900, 600),
    ]
    const workspace = emit({
      objects: members.map((member) => object(member.id, { type: 'system', size: member.size })),
      diagrams: [
        diagram('d1', {
          name: 'Context',
          objectIds: members.map((member) => member.id),
          layouts: Object.fromEntries(
            members.map((member) => [member.id, { position: member.position, size: member.size }]),
          ),
        }),
      ],
    })

    const rows = (workspace as unknown as {
      views: { systemLandscapeViews: Array<{ elements: Array<{ id: string; x: number; y: number }> }> }
    }).views.systemLandscapeViews[0]!.elements
    const box = { width: 450, height: 300 }
    const overlaps: string[] = []
    for (const one of rows) {
      for (const other of rows) {
        if (one.id >= other.id) continue
        const apart =
          Math.abs(one.x - other.x) >= box.width || Math.abs(one.y - other.y) >= box.height
        if (!apart) overlaps.push(`${one.id}/${other.id}`)
      }
    }
    expect(overlaps).toEqual([])
  })

  it('names MapleSpire as the agent that wrote the file', () => {
    // Provenance: a customer holding a workspace.json has to be able to tell who
    // produced it.
    expect((emit({}) as unknown as { lastModifiedAgent: string }).lastModifiedAgent).toContain('maplespire')
  })
})
