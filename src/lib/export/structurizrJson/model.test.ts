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
 * The model emitter, measured against the file it came from.
 *
 * The interesting assertions here run a REAL round trip: `big-bank-plc.json` is
 * imported through `structurizrJsonSource` — the same path a customer's upload
 * takes, ELK and all — turned into an `ExportBundle`, and the model this file
 * emits is compared with the model in the original file. A hand-built fixture
 * cannot prove that, because the shape of what the importer produces (boundary
 * groups, instance objects, provenance stamps) is exactly what an exporter gets
 * wrong, and a fixture written by the same author who wrote the exporter agrees
 * with it by construction.
 *
 * `indexElements` deliberately walks the wire shape rather than our types, so
 * the very same function indexes the original file and our output.
 */

import { describe, expect, it } from 'vitest'
import bigBank from '../../structurizr/fixtures/json/big-bank-plc.json'
import nestedGroups from '../../structurizr/fixtures/json/nested-groups-separator-positioned.json'
import deploymentPositioned from '../../structurizr/fixtures/json/deployment-positioned.json'
import { structurizrJsonSource } from '../../import/structurizrJsonSource'
import { seededTechnologyUsages } from '../../technologyUsage'
import type { C4Object, Connection, DecisionRecord, Group } from '../../../types'
import type { ExportBundle } from '../types'
import { buildStructurizrWorkspace } from '.'
import { buildWireDocumentation, buildWireModel } from './model'
import { buildExportContext, type WireModel } from './types'

// ── the round-trip harness ───────────────────────────────────────────────────

async function bundleFor(fixture: unknown): Promise<ExportBundle> {
  const run = structurizrJsonSource.run
  if (run === undefined) throw new Error('the Structurizr JSON source cannot run')
  const result = await run(JSON.stringify(fixture))
  const flowsByDiagram: Record<string, typeof result.flows extends undefined ? never : NonNullable<typeof result.flows>> =
    {}
  for (const flow of result.flows ?? []) {
    flowsByDiagram[flow.diagramId] ??= []
    flowsByDiagram[flow.diagramId].push(flow)
  }
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

function modelOf(bundle: ExportBundle): WireModel {
  return buildWireModel(buildExportContext(bundle, { now: '2026-01-01T00:00:00Z' }))
}

/** Every collection an element can nest a child in, and what that child is. */
const CHILD_COLLECTIONS = [
  ['containers', 'container'],
  ['components', 'component'],
  ['children', 'deploymentNode'],
  ['infrastructureNodes', 'infrastructureNode'],
  ['containerInstances', 'containerInstance'],
  ['softwareSystemInstances', 'softwareSystemInstance'],
] as const

interface IndexedElement {
  kind: string
  name?: string
  parentId?: string
  tags?: string
  technology?: string
  group?: string
  instances?: string
  environment?: string
  instantiates?: string
}

type WireRecord = Record<string, unknown>

/** T3: the corpus really does contain `"Element,Deployment Node,"`. Trimming
 *  converges with what the renderer draws, so an empty token on either side of
 *  a comparison is noise, not a difference. */
function normalisedTags(value: string): string {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .join(',')
}

/** Flatten a `model` — ours or the file's — into `id → facts`, keeping the
 *  nesting as a parent id so two trees can be compared without walking twice. */
function indexElements(model: WireRecord): Map<string, IndexedElement> {
  const out = new Map<string, IndexedElement>()
  const walk = (raw: WireRecord, kind: string, parentId: string | undefined) => {
    const id = String(raw.id)
    out.set(id, {
      kind,
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(parentId === undefined ? {} : { parentId }),
      ...(typeof raw.tags === 'string' ? { tags: normalisedTags(raw.tags) } : {}),
      ...(typeof raw.technology === 'string' ? { technology: raw.technology } : {}),
      ...(typeof raw.group === 'string' ? { group: raw.group } : {}),
      ...(raw.instances === undefined ? {} : { instances: String(raw.instances) }),
      ...(typeof raw.environment === 'string' ? { environment: raw.environment } : {}),
      ...(typeof raw.containerId === 'string' ? { instantiates: raw.containerId } : {}),
      ...(typeof raw.softwareSystemId === 'string' ? { instantiates: raw.softwareSystemId } : {}),
    })
    for (const [key, childKind] of CHILD_COLLECTIONS) {
      for (const child of (raw[key] as WireRecord[] | undefined) ?? []) walk(child, childKind, id)
    }
  }
  for (const raw of (model.people as WireRecord[] | undefined) ?? []) walk(raw, 'person', undefined)
  for (const raw of (model.softwareSystems as WireRecord[] | undefined) ?? []) walk(raw, 'softwareSystem', undefined)
  for (const raw of (model.customElements as WireRecord[] | undefined) ?? []) walk(raw, 'customElement', undefined)
  for (const raw of (model.deploymentNodes as WireRecord[] | undefined) ?? []) walk(raw, 'deploymentNode', undefined)
  return out
}

/** Every id the walk visits, duplicates included — `indexElements` keys by id
 *  and would quietly hide an element emitted in two places at once. */
function elementIds(model: WireRecord): string[] {
  const out: string[] = []
  const walk = (raw: WireRecord) => {
    out.push(String(raw.id))
    for (const [key] of CHILD_COLLECTIONS) {
      for (const child of (raw[key] as WireRecord[] | undefined) ?? []) walk(child)
    }
  }
  for (const key of ['people', 'softwareSystems', 'customElements', 'deploymentNodes'] as const) {
    for (const raw of (model[key] as WireRecord[] | undefined) ?? []) walk(raw)
  }
  return out
}

/** `(source, destination, description)` — the identity of a relationship (§5.4),
 *  gathered from wherever it is nested. */
function indexRelationships(model: WireRecord): Set<string> {
  const out = new Set<string>()
  const walk = (raw: WireRecord) => {
    for (const rel of (raw.relationships as WireRecord[] | undefined) ?? []) {
      out.add(`${String(rel.sourceId)} -> ${String(rel.destinationId)} : ${String(rel.description ?? '')}`)
    }
    for (const [key] of CHILD_COLLECTIONS) {
      for (const child of (raw[key] as WireRecord[] | undefined) ?? []) walk(child)
    }
  }
  for (const key of ['people', 'softwareSystems', 'customElements', 'deploymentNodes'] as const) {
    for (const raw of (model[key] as WireRecord[] | undefined) ?? []) walk(raw)
  }
  return out
}

// ── hand-built bundles, for the cases no fixture contains ────────────────────

function object(id: string, partial: Partial<C4Object> = {}): C4Object {
  return {
    id,
    type: 'system',
    name: id,
    position: { x: 0, y: 0 },
    size: { width: 200, height: 100 },
    tagAssignments: {},
    tagOrder: [],
    links: [],
    scope: 'internal',
    status: 'live',
    properties: {},
    ...partial,
  }
}

function emptyBundle(partial: Partial<ExportBundle> = {}): ExportBundle {
  return {
    landscapeName: 'Test',
    generatedAt: '2026-01-01T00:00:00Z',
    diagrams: [],
    activeDiagramId: null,
    flowsByDiagram: {},
    objects: [],
    connections: [],
    groups: [],
    domains: [],
    tags: [],
    decisionRecords: [],
    ...partial,
  }
}

function group(id: string, partial: Partial<Group> = {}): Group {
  return {
    id,
    name: id,
    color: '#ffffff',
    objectIds: [],
    tagAssignments: {},
    tagOrder: [],
    ...partial,
  }
}

function connection(id: string, fromId: string, toId: string, partial: Partial<Connection> = {}): Connection {
  return { id, fromId, toId, type: 'solid', ...partial }
}

// ── the round trip ───────────────────────────────────────────────────────────

describe('the model a round trip of big-bank-plc.json produces', () => {
  it('carries every element back, with the same id, kind and place in the tree', async () => {
    const model = modelOf(await bundleFor(bigBank))

    const original = indexElements(bigBank.model as unknown as WireRecord)
    const exported = indexElements(model as unknown as WireRecord)

    expect([...exported.keys()].sort()).toEqual([...original.keys()].sort())
    for (const [id, before] of original) {
      expect({ id, ...exported.get(id)! }).toEqual({ id, ...before })
    }
    // Rule 12 rejects a duplicate element id outright, and the `TreeSet` above
    // it drops one of the pair before the rule can fire — so an element emitted
    // in the static tree AND in the deployment tree costs the customer a shape
    // with no message anywhere.
    const emitted = elementIds(model as unknown as WireRecord)
    expect(emitted.length).toBe(new Set(emitted).size)
  })

  it('keeps every relationship on its source element, with both endpoints intact', async () => {
    const model = modelOf(await bundleFor(bigBank))

    const original = indexRelationships(bigBank.model as unknown as WireRecord)
    const exported = indexRelationships(model as unknown as WireRecord)

    // The one that does not come back is the edge between two deployment NODES.
    // The importer turns a node with children into a boundary Group, and a
    // Connection joins two shapes, so "Oracle - Primary replicates data to
    // Oracle - Secondary" has no shape to leave from — a loss the IMPORT warns
    // about, not one this file introduces.
    const missing = [...original].filter((edge) => !exported.has(edge))
    expect(missing).toEqual(['83 -> 87 : Replicates data to'])
    expect(exported.size).toBe(original.size - 1)
  })

  it('puts back the type default tags the importer stripped', async () => {
    const model = modelOf(await bundleFor(bigBank))
    const exported = indexElements(model as unknown as WireRecord)

    // Structurizr's own stylesheet keys on these. Without them the customer's
    // workspace re-opens as undifferentiated boxes.
    expect(exported.get('1')!.tags).toBe('Element,Person,Customer')
    expect(exported.get('9')!.tags).toBe('Element,Container,Mobile App')
    // An instance gets its stored tag and NOT `Element` (§5.5), and none of the
    // tags of the container it instantiates.
    expect(exported.get('55')!.tags).toBe('Container Instance')
  })

  it('re-emits a model group as the `group` string on each of its members', async () => {
    const model = modelOf(await bundleFor(bigBank))
    const exported = indexElements(model as unknown as WireRecord)

    expect(exported.get('4')!.group).toBe('Big Bank plc')
    expect(exported.get('2')!.group).toBe('Big Bank plc')
    // A boundary group is a per-view rendering of an element already emitted,
    // so it must not turn into a group string on anything.
    expect(exported.get('10')!.group).toBeUndefined()
  })

  it('never emits a boundary group as an element of its own', async () => {
    const bundle = await bundleFor(bigBank)
    const model = modelOf(bundle)
    const exported = indexElements(model as unknown as WireRecord)

    const boundaries = bundle.groups.filter((g) => g.properties?.['structurizr.boundaryFor'] !== undefined)
    expect(boundaries.length).toBeGreaterThan(0)
    for (const boundary of boundaries) {
      // The wire id it names belongs to the element it wraps, and that element
      // is a shape — emitting the boundary too would duplicate it.
      const wrapped = boundary.properties!['structurizr.boundaryFor']!
      expect(exported.get(wrapped)!.kind).not.toBe('deploymentNode')
    }
    expect(exported.size).toBe(indexElements(bigBank.model as unknown as WireRecord).size)
  })

  it('rebuilds the deployment tree, nesting a node whose members its parent also holds', async () => {
    const model = modelOf(await bundleFor(bigBank))
    const exported = indexElements(model as unknown as WireRecord)

    // "bigbank-web***" and the "Apache Tomcat" inside it hold exactly the same
    // instance, so a strict-superset test finds no nesting between them.
    expect(exported.get('74')!.parentId).toBe('73')
    expect(exported.get('73')!.parentId).toBe('72')
    expect(exported.get('72')!.parentId).toBeUndefined()
    expect(exported.get('72')!.environment).toBe('Live')
    expect(exported.get('77')!.instances).toBe('8')
  })

  it('points every instance back at what it instantiates, and gives it no name', async () => {
    const model = modelOf(await bundleFor(bigBank))
    const exported = indexElements(model as unknown as WireRecord)

    expect(exported.get('55')).toMatchObject({ kind: 'containerInstance', instantiates: '10', parentId: '54' })
    expect(exported.get('55')!.name).toBeUndefined()
    // A system instance references `softwareSystemId`, not `containerId`.
    expect(exported.get('65')).toMatchObject({ kind: 'softwareSystemInstance', instantiates: '4' })
  })

  it('recovers a deployment node\'s own facts from the description the import joined them into', async () => {
    const model = modelOf(await bundleFor(bigBank))
    const nodes = (model.deploymentNodes ?? []) as unknown as WireRecord[]
    const laptop = nodes.find((node) => node.id === '50')!

    expect(laptop.technology).toBe('Microsoft Windows 10 or Apple macOS')
    expect(laptop.environment).toBe('Development')
    // The import displayed "<technology> · Environment: <env>" as the group's
    // description; the node never had one, so neither should the export.
    expect(laptop.description).toBeUndefined()
  })

  it('never echoes the import\'s own provenance back as element properties', async () => {
    const model = modelOf(await bundleFor(bigBank))
    const seen = new Set<string>()
    const walk = (raw: WireRecord) => {
      for (const key of Object.keys((raw.properties as WireRecord | undefined) ?? {})) seen.add(key)
      for (const [collection] of CHILD_COLLECTIONS) {
        for (const child of (raw[collection] as WireRecord[] | undefined) ?? []) walk(child)
      }
    }
    for (const key of ['people', 'softwareSystems', 'deploymentNodes'] as const) {
      for (const raw of (model as unknown as WireRecord)[key] as WireRecord[]) walk(raw)
    }

    // The DSL identifier is the customer's and goes back where Structurizr's own
    // exporter puts it; every other `structurizr.*` key we wrote is a field
    // somewhere else in this file and would be a second, staler copy here.
    expect([...seen].sort()).toEqual(['structurizr.dsl.identifier'])
  })
})

describe('deployment nodes with infrastructure and no boundary of their own', () => {
  it('keeps an infrastructure node inside the node that hosts it', async () => {
    const model = modelOf(await bundleFor(deploymentPositioned))
    const exported = indexElements(model as unknown as WireRecord)
    const original = indexElements(deploymentPositioned.model as unknown as WireRecord)

    expect([...exported.keys()].sort()).toEqual([...original.keys()].sort())
    // 8 is the Elastic Load Balancer, an infrastructure node directly under
    // US-East-1 — which holds every instance in the file, exactly as the
    // Amazon Web Services node above it does.
    expect(exported.get('8')).toMatchObject({ kind: 'infrastructureNode', parentId: '6', environment: 'Live' })
    expect(exported.get('6')!.parentId).toBe('5')
    expect(exported.get('13')!.parentId).toBe('12')
  })

  it('re-derives deployment groups per node instead of echoing the inherited union', async () => {
    // The importer materialises `ancestors ∪ own` on every level so nothing has
    // to re-walk parents. Writing that back out re-declares an ancestor's groups
    // at every depth, which is T27's damage in a different place.
    const bundle = emptyBundle({
      objects: [
        object('target', { type: 'app', name: 'Web App', properties: { 'structurizr.id': '2' } }),
        object('instance', {
          type: 'app',
          name: 'Web App',
          properties: {
            'structurizr.id': '3',
            'structurizr.instanceOf': '2',
            'structurizr.environment': 'Live',
            'structurizr.deploymentGroups': 'prod, canary',
          },
        }),
      ],
      groups: [
        group('node', {
          name: 'Server',
          type: 'Deployment node',
          objectIds: ['instance'],
          properties: {
            'structurizr.id': '1',
            'structurizr.environment': 'Live',
            'structurizr.deploymentGroups': 'prod',
          },
        }),
      ],
    })

    const model = modelOf(bundle)
    const node = (model.deploymentNodes ?? [])[0]!
    expect(node.deploymentGroups).toEqual(['prod'])
    expect(node.containerInstances?.[0]?.deploymentGroups).toEqual(['canary'])
  })
})

describe('nested model groups', () => {
  // T5's declaration is a statement about the BYTES — "one of the `group`
  // strings in this file is a path" — so it is written by the envelope, from the
  // emitted model, and asserted here through the whole workspace rather than
  // through `buildWireModel` alone. The model emitter must not answer the same
  // question a second time from the input index.
  it('declares the separator whenever it emits a nested group path', async () => {
    const workspace = buildStructurizrWorkspace(await bundleFor(nestedGroups)).workspace
    const exported = indexElements(workspace.model as unknown as WireRecord)

    const nested = [...exported.values()].filter((element) => element.group?.includes('/'))
    expect(nested.length).toBeGreaterThan(0)
    // Without the declaration every reader treats the whole path as one flat
    // group name and the hierarchy is gone with no diagnostic.
    expect(workspace.model.properties?.['structurizr.groupSeparator']).toBe('/')
  })

  it('leaves the separator undeclared when no group is nested', () => {
    const bundle = emptyBundle({
      objects: [object('a', { name: 'A' })],
      groups: [group('g', { name: 'Payments', objectIds: ['a'] })],
    })
    const workspace = buildStructurizrWorkspace(bundle).workspace

    expect(workspace.model.softwareSystems?.[0]?.group).toBe('Payments')
    expect(workspace.model.properties).toBeUndefined()
  })
})

describe('shapes the format has no place for', () => {
  it('wraps a parentless container in a synthetic system rather than dropping it', () => {
    const bundle = emptyBundle({ objects: [object('loose', { type: 'app', name: 'Loose App' })] })
    const model = modelOf(bundle)

    expect(model.softwareSystems).toHaveLength(1)
    expect(model.softwareSystems![0]!.name).toBe('Ungrouped')
    expect(model.softwareSystems![0]!.containers?.map((c) => c.name)).toEqual(['Loose App'])
  })

  it('disambiguates two systems sharing a name, which Structurizr refuses to open', () => {
    const bundle = emptyBundle({ objects: [object('a', { name: 'Payments' }), object('b', { name: 'Payments' })] })
    const ctx = buildExportContext(bundle, { now: 'now' })
    const model = buildWireModel(ctx)

    expect(model.softwareSystems!.map((system) => system.name)).toEqual(['Payments', 'Payments (2)'])
    expect(ctx.warnings.join(' ')).toContain('Payments (2)')
  })

  it('keeps both of two identically labelled edges between one pair', () => {
    // `(destination, description)` uniqueness is a HARD read failure upstream,
    // so the second edge has to change or the whole file stops opening.
    const bundle = emptyBundle({
      objects: [object('a', { name: 'A' }), object('b', { name: 'B' })],
      connections: [connection('c1', 'a', 'b', { label: 'Uses' }), connection('c2', 'a', 'b', { label: 'Uses' })],
    })
    const model = modelOf(bundle)
    const relationships = model.softwareSystems![0]!.relationships!

    expect(relationships).toHaveLength(2)
    expect(relationships.map((r) => r.description)).toEqual(['Uses', 'Uses (2)'])
  })
})

describe('scope, technology and the tags that carry them', () => {
  it('tags an external system and an internal person so the import reads the scope back', () => {
    const bundle = emptyBundle({
      objects: [
        object('sys', { name: 'Partner', scope: 'external' }),
        object('who', { type: 'actor', name: 'Staff', scope: 'internal' }),
      ],
    })
    const model = modelOf(bundle)

    // `location` is in the legacy register and has no declaration to emit into,
    // so the tag is the only channel `detectScope` can read.
    expect(model.softwareSystems![0]!.tags).toBe('Element,Software System,External')
    expect(model.people![0]!.tags).toBe('Element,Person,Internal')
  })

  it('does not add a scope tag the author already wrote', () => {
    const bundle = emptyBundle({
      objects: [
        object('sys', {
          name: 'Partner',
          scope: 'external',
          tagAssignments: { t: { tagId: 't' } },
          tagOrder: ['t'],
        }),
      ],
      tags: [{ tagId: 't', value: 'Existing System', color: '#000000', groupId: 'g', groupName: 'G', catalogRevision: 1 }],
    })
    const model = modelOf(bundle)

    expect(model.softwareSystems![0]!.tags).toBe('Element,Software System,Existing System')
  })

  it('joins technology usages in order, on the element kinds that have the field', () => {
    // The importer splits a technology string on `,` and `/` into governed
    // usages; the export puts them back in application order, not in whatever
    // order the usage map happens to iterate in.
    const usages = seededTechnologyUsages('a', ['Spring MVC', 'Java'])
    const bundle = emptyBundle({
      objects: [
        object('a', {
          type: 'app',
          name: 'Web App',
          technologyUsages: usages,
          // Deliberately not the key order of the map: an export that iterates
          // `Object.keys` would emit "Spring MVC, Java" and pass a weaker test.
          technologyUsageOrder: Object.keys(usages).reverse(),
        }),
        object('who', { type: 'actor', name: 'Staff' }),
      ],
    })
    const model = modelOf(bundle)

    expect(model.softwareSystems![0]!.containers![0]!.technology).toBe('Java, Spring MVC')
    // A person has no `technology` field at all (§5.2), so nothing to put there.
    expect(model.people![0]).not.toHaveProperty('technology')
  })

  it('carries the tags the styles emitter keys its shapes and icons on', () => {
    // Structurizr matches styles on tags and nothing else, so a `Cylinder` or an
    // `icon` in the stylesheet draws nothing unless the element says the word.
    // The set is `styleTagsFor`'s to decide; the model's job is to emit it.
    const bundle = emptyBundle({
      objects: [
        object('db', { type: 'store', name: 'Ledger' }),
        object('app', {
          type: 'app',
          name: 'Web App',
          iconAssignment: { source: 'technology', mode: 'explicit', displayName: 'React', iconLightPath: '/icons/light/a.png' },
        }),
      ],
    })
    const containers = modelOf(bundle).softwareSystems![0]!.containers!

    expect(containers.find((c) => c.name === 'Ledger')!.tags).toBe('Element,Container,Database')
    expect(containers.find((c) => c.name === 'Web App')!.tags).toBe('Element,Container,ms-icon-react')
  })

  it('round-trips a technology string the importer could not split', async () => {
    const model = modelOf(await bundleFor(bigBank))
    const exported = indexElements(model as unknown as WireRecord)

    expect(exported.get('10')!.technology).toBe('Java and Spring MVC')
    // A deployment node's technology never became governed usages at all — it
    // is provenance on the Group — so the commas inside it survive verbatim.
    expect(exported.get('51')!.technology).toBe('Chrome, Firefox, Safari, or Edge')
  })
})

describe('relationship provenance', () => {
  it('marks a derived edge with the CURRENT id of the edge it was derived from', async () => {
    const model = modelOf(await bundleFor(bigBank))
    const derived: Record<string, string> = {}
    const walk = (raw: WireRecord) => {
      for (const rel of (raw.relationships as WireRecord[] | undefined) ?? []) {
        if (rel.linkedRelationshipId !== undefined) derived[String(rel.id)] = String(rel.linkedRelationshipId)
      }
      for (const [collection] of CHILD_COLLECTIONS) {
        for (const child of (raw[collection] as WireRecord[] | undefined) ?? []) walk(child)
      }
    }
    for (const raw of (model.deploymentNodes ?? []) as unknown as WireRecord[]) walk(raw)

    expect(derived['56']).toBe('31')
    // §5.4: a derived edge carries no default tags, not even `Relationship`.
    const relationships = indexRelationships(model as unknown as WireRecord)
    expect(relationships.has('55 -> 52 : Delivers to the customer\'s web browser')).toBe(true)
  })

  it('drops a linked-relationship pointer whose target is gone rather than dangling it', () => {
    // A dangling `linkedRelationshipId` is a hard read failure upstream (rule 16).
    const bundle = emptyBundle({
      objects: [object('a', { name: 'A' }), object('b', { name: 'B' })],
      connections: [
        connection('c1', 'a', 'b', {
          label: 'Uses',
          properties: { 'structurizr.linkedRelationshipId': '999' },
        }),
      ],
    })
    const ctx = buildExportContext(bundle, { now: 'now' })
    const model = buildWireModel(ctx)

    expect(model.softwareSystems![0]!.relationships![0]!.linkedRelationshipId).toBeUndefined()
    expect(ctx.warnings.join(' ')).toContain('no longer in the model')
  })

  it('carries the interaction style back out of the property the importer parked it in', () => {
    const bundle = emptyBundle({
      objects: [object('a', { name: 'A' }), object('b', { name: 'B' })],
      connections: [
        connection('c1', 'a', 'b', {
          label: 'Sends',
          properties: { 'structurizr.interactionStyle': 'Asynchronous' },
        }),
      ],
    })
    const relationship = modelOf(bundle).softwareSystems![0]!.relationships![0]!

    expect(relationship.interactionStyle).toBe('Asynchronous')
    // `Asynchronous` is a DEFAULT tag when the style is set, so it belongs in
    // the tag string too — `parse.ts` strips it by membership on the way back.
    expect(relationship.tags).toBe('Relationship,Asynchronous')
  })
})

describe('perspectives and customer properties', () => {
  it('rebuilds a perspective from the two properties the importer split it into', () => {
    const bundle = emptyBundle({
      objects: [
        object('a', {
          name: 'A',
          properties: {
            'structurizr.perspective.Security': 'Confidential',
            'structurizr.perspective.Security.description': 'Handling classification',
            team: 'payments',
          },
        }),
      ],
    })
    const system = modelOf(bundle).softwareSystems![0]!

    expect(system.perspectives).toEqual([
      { name: 'Security', value: 'Confidential', description: 'Handling classification' },
    ])
    expect(system.properties).toEqual({ team: 'payments' })
  })

  it('gives a customer their own property name back when the import had to move it', () => {
    // `withProvenance` parks a colliding customer value at `<key>.original`.
    const bundle = emptyBundle({
      objects: [
        object('a', {
          name: 'A',
          properties: { 'structurizr.id': '7', 'structurizr.id.original': 'theirs' },
        }),
      ],
    })
    const system = modelOf(bundle).softwareSystems![0]!

    expect(system.id).toBe('7')
    expect(system.properties).toEqual({ 'structurizr.id': 'theirs' })
  })
})

describe('documentation', () => {
  const record = (partial: Partial<DecisionRecord> = {}): DecisionRecord => ({
    id: 'adr-1',
    number: 1,
    title: 'Use Postgres',
    summary: '',
    status: 'approved',
    author: 'You',
    createdAt: '2026-03-04T05:06:07.891Z',
    updatedAt: '2026-03-04T05:06:07.891Z',
    content: '# Context',
    related: [],
    ...partial,
  })

  it('emits decisions with the date pattern the format specifies', () => {
    const ctx = buildExportContext(emptyBundle({ decisionRecords: [record()] }), { now: 'now' })
    const documentation = buildWireDocumentation(ctx)!

    expect(documentation.decisions).toEqual([
      {
        id: '1',
        title: 'Use Postgres',
        // yyyy-MM-dd'T'HH:mm:ss'Z' — no millisecond field.
        date: '2026-03-04T05:06:07Z',
        status: 'Accepted',
        content: '# Context',
        format: 'Markdown',
      },
    ])
  })

  it('resolves a link between two decisions to the id the other one was emitted under', () => {
    const ctx = buildExportContext(
      emptyBundle({
        decisionRecords: [
          record({ id: 'adr-1', number: 1 }),
          record({
            id: 'adr-2',
            number: 2,
            status: 'in-progress',
            related: [{ id: 'l1', type: 'adr', label: 'Supersedes', targetId: 'adr-1' }],
          }),
        ],
      }),
      { now: 'now' },
    )
    const documentation = buildWireDocumentation(ctx)!

    expect(documentation.decisions![1]).toMatchObject({
      id: '2',
      status: 'Proposed',
      links: [{ id: '1', description: 'Supersedes' }],
    })
  })

  it('says nothing at all when there are no decisions', () => {
    expect(buildWireDocumentation(buildExportContext(emptyBundle(), { now: 'now' }))).toBeUndefined()
  })
})
