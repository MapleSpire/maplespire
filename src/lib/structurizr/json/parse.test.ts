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

import { describe, expect, it } from 'vitest'
import { parseWorkspaceJson } from './parse'
import { StructurizrJsonError, type SzElementKind, type SzWorkspace } from './types'

import bigBankRaw from '../fixtures/json/big-bank-plc.json?raw'
import groupsRaw from '../fixtures/json/groups.json?raw'
import deploymentPositionedRaw from '../fixtures/json/deployment-positioned.json?raw'
import bigRealRaw from '../fixtures/json/big-real-workspace.json?raw'
import viewsWithoutOrderRaw from '../fixtures/json/views-without-order.json?raw'

const parse = (doc: unknown) => parseWorkspaceJson(JSON.stringify(doc))

function countByKind(workspace: SzWorkspace): Partial<Record<SzElementKind, number>> {
  const counts: Partial<Record<SzElementKind, number>> = {}
  for (const element of workspace.elements) {
    counts[element.kind] = (counts[element.kind] ?? 0) + 1
  }
  return counts
}

function countViews(workspace: SzWorkspace): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const view of workspace.views) counts[view.kind] = (counts[view.kind] ?? 0) + 1
  return counts
}

const byId = (workspace: SzWorkspace, id: string) => {
  const element = workspace.elements.find((e) => e.id === id)
  if (!element) throw new Error(`no element ${id}`)
  return element
}

// A workspace with one person, used wherever the test is about a single field.
const minimal = (overrides: Record<string, unknown> = {}) => ({
  name: 'Minimal',
  model: { people: [{ id: '1', name: 'User', tags: 'Element,Person' }] },
  ...overrides,
})

describe('refusing a document that is not an importable workspace', () => {
  const encrypted = {
    id: 1,
    name: 'Financial Risk System',
    description: 'Encrypted',
    ciphertext: 'RxG9dEnZm+9y1QqUiRk=',
    encryptionStrategy: {
      type: 'aes',
      keySize: 128,
      iterationCount: 1000,
      salt: '0b6f',
      iv: 'ab12',
      location: 'Client',
    },
  }

  it('refuses an encrypted workspace instead of importing it as an empty one', () => {
    // It deserialises perfectly: a plausible name, zero elements, zero views.
    // Anything short of a throw here ships an importer that reports success.
    expect(() => parse(encrypted)).toThrow(StructurizrJsonError)
    expect(() => parse(encrypted)).toThrow(/encrypted/i)
  })

  it('tells the user how to get a decrypted copy rather than just refusing', () => {
    let message = ''
    try {
      parse(encrypted)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/passphrase/i)
    expect(message).toMatch(/export/i)
  })

  it('says the server holds the key when the strategy was applied server-side', () => {
    const serverSide = {
      ...encrypted,
      encryptionStrategy: { ...encrypted.encryptionStrategy, location: 'Server' },
    }
    expect(() => parse(serverSide)).toThrow(/server/i)
  })

  it('still imports a workspace that merely mentions ciphertext in its own data', () => {
    // The Java client's unquoted `json.contains("ciphertext")` false-positives
    // here; detection has to be structural, on the parsed top-level object.
    const workspace = parse(
      minimal({
        properties: { 'notes.security': 'the ciphertext and encryptionStrategy live in vault' },
      }),
    )
    expect(workspace.elements).toHaveLength(1)
  })

  it('does not refuse a workspace carrying only one half of the encrypted pair', () => {
    expect(parse(minimal({ ciphertext: 'abc' })).elements).toHaveLength(1)
    expect(parse(minimal({ encryptionStrategy: { type: 'aes' } })).elements).toHaveLength(1)
  })

  it('says a workspace was expected when the file is not JSON at all', () => {
    expect(() => parseWorkspaceJson('workspace "Big Bank" {')).toThrow(StructurizrJsonError)
    expect(() => parseWorkspaceJson('workspace "Big Bank" {')).toThrow(/Structurizr workspace/i)
  })

  it('refuses a top-level JSON array and names what it found', () => {
    expect(() => parseWorkspaceJson('[{"model":{}}]')).toThrow(/array/i)
  })

  it('names MapleSpire’s own model export rather than calling it corrupt', () => {
    const ours = { format: 'maplespire-model', version: 3, objects: [], connections: [] }
    expect(() => parse(ours)).toThrow(/MapleSpire model export/i)
  })

  it('refuses an object that has neither a model nor any views', () => {
    expect(() => parse({ name: 'Nothing', id: 4 })).toThrow(/"model"/)
  })

  it('accepts a workspace that has views but no model', () => {
    const workspace = parse({ name: 'Views only', views: { systemLandscapeViews: [{ key: 'K' }] } })
    expect(workspace.views).toHaveLength(1)
    expect(workspace.elements).toEqual([])
  })
})

describe('tags', () => {
  it('splits on commas only, so a multi-word tag survives', () => {
    const workspace = parse({
      name: 'W',
      model: {
        softwareSystems: [{ id: '1', name: 'S', tags: 'Element,Software System,Existing System' }],
      },
    })
    expect(byId(workspace, '1').styleTags).toEqual(['Element', 'Software System', 'Existing System'])
    expect(byId(workspace, '1').tags).toEqual(['Existing System'])
  })

  it('accepts a producer that emits tags as an array everywhere', () => {
    const workspace = parse({
      name: 'W',
      model: { people: [{ id: '1', name: 'U', tags: ['Element', 'Person', 'Customer'] }] },
    })
    expect(byId(workspace, '1').styleTags).toEqual(['Element', 'Person', 'Customer'])
    expect(byId(workspace, '1').tags).toEqual(['Customer'])
  })

  it('reads an empty string, a null and an absent tags key as no tags', () => {
    const workspace = parse({
      name: 'W',
      model: {
        people: [
          { id: '1', name: 'A', tags: '' },
          { id: '2', name: 'B', tags: null },
          { id: '3', name: 'C' },
        ],
      },
    })
    for (const id of ['1', '2', '3']) {
      expect(byId(workspace, id).styleTags).toEqual([])
      expect(byId(workspace, id).tags).toEqual([])
    }
  })

  it('drops the phantom tag a trailing or doubled comma leaves behind', () => {
    const workspace = parse({
      name: 'W',
      model: {
        softwareSystems: [
          { id: '1', name: 'A', tags: 'Element,Software System,' },
          { id: '2', name: 'B', tags: 'Element,Software System,,External' },
        ],
      },
    })
    expect(byId(workspace, '1').styleTags).toEqual(['Element', 'Software System'])
    expect(byId(workspace, '2').tags).toEqual(['External'])
  })

  it('trims each token so a hand-written "Element, Person" still strips its defaults', () => {
    const workspace = parse({
      name: 'W',
      model: { people: [{ id: '1', name: 'U', tags: 'Element, Person , VIP ' }] },
    })
    expect(byId(workspace, '1').styleTags).toEqual(['Element', 'Person', 'VIP'])
    expect(byId(workspace, '1').tags).toEqual(['VIP'])
  })

  it('strips defaults by membership, not by position', () => {
    // structurizr-typescript writes the user's tags first.
    const workspace = parse({
      name: 'W',
      model: { softwareSystems: [{ id: '1', name: 'A', tags: 'Custom Tag,Element,Software System' }] },
    })
    expect(byId(workspace, '1').tags).toEqual(['Custom Tag'])
  })

  it('keeps "Container Instance" as an author tag, because instances have no defaults', () => {
    const workspace = parse({
      name: 'W',
      model: {
        deploymentNodes: [
          {
            id: '1',
            name: 'N',
            tags: 'Element,Deployment Node',
            containerInstances: [{ id: '2', containerId: '9', instanceId: 1, tags: 'Container Instance' }],
          },
        ],
      },
    })
    expect(byId(workspace, '2').tags).toEqual(['Container Instance'])
    expect(byId(workspace, '1').tags).toEqual([])
  })

  it('keeps Asynchronous off the author tag list when interactionStyle set it', () => {
    const workspace = parse({
      name: 'W',
      model: {
        people: [
          {
            id: '1',
            name: 'U',
            relationships: [
              {
                id: '2',
                sourceId: '1',
                destinationId: '3',
                tags: 'Relationship,Asynchronous,Critical',
                interactionStyle: 'Asynchronous',
              },
            ],
          },
        ],
      },
    })
    expect(workspace.relationships[0].tags).toEqual(['Critical'])
    expect(workspace.relationships[0].styleTags).toEqual(['Relationship', 'Asynchronous', 'Critical'])
  })

  it('leaves Asynchronous as an author tag when no interactionStyle declared it', () => {
    // structurizr-php tags every relationship Asynchronous while leaving the
    // field correct, so the tag alone must not be treated as machine-generated.
    const workspace = parse({
      name: 'W',
      model: {
        people: [
          {
            id: '1',
            name: 'U',
            relationships: [
              { id: '2', sourceId: '1', destinationId: '3', tags: 'Relationship,Asynchronous' },
            ],
          },
        ],
      },
    })
    expect(workspace.relationships[0].tags).toEqual(['Asynchronous'])
  })

  it('strips nothing from a derived edge, which carries no default tags at all', () => {
    const workspace = parse({
      name: 'W',
      model: {
        people: [
          {
            id: '1',
            name: 'U',
            relationships: [
              {
                id: '2',
                sourceId: '1',
                destinationId: '3',
                tags: 'Relationship,Critical',
                linkedRelationshipId: '9',
              },
            ],
          },
        ],
      },
    })
    expect(workspace.relationships[0].tags).toEqual(['Relationship', 'Critical'])
  })

  it('reads a filtered view’s tags from a real JSON array', () => {
    const workspace = parse({
      name: 'W',
      views: {
        filteredViews: [{ key: 'F', baseViewKey: 'Containers', mode: 'Include', tags: ['Demo', 'Person'] }],
      },
    })
    expect(workspace.views[0].filterTags).toEqual(['Demo', 'Person'])
    expect(workspace.views[0].filterMode).toBe('Include')
  })

  it('defaults a filtered view with no mode to Exclude', () => {
    const workspace = parse({
      name: 'W',
      views: { filteredViews: [{ key: 'F', baseViewKey: 'Containers', tags: ['Demo'] }] },
    })
    expect(workspace.views[0].filterMode).toBe('Exclude')
  })
})

describe('the element tree', () => {
  const nested = {
    name: 'Nested',
    model: {
      softwareSystems: [
        {
          id: '1',
          name: 'S',
          containers: [
            {
              id: '2',
              name: 'C',
              components: [{ id: '3', name: 'Comp' }],
              relationships: [{ id: '20', sourceId: '2', destinationId: '3', description: 'Calls' }],
            },
          ],
        },
      ],
      deploymentNodes: [
        {
          id: '4',
          name: 'AWS',
          children: [
            {
              id: '5',
              name: 'EC2',
              containerInstances: [
                {
                  id: '6',
                  containerId: '2',
                  instanceId: 1,
                  relationships: [{ id: '21', sourceId: '6', destinationId: '7' }],
                },
              ],
              softwareSystemInstances: [{ id: '7', softwareSystemId: '1', instanceId: 1 }],
            },
          ],
          infrastructureNodes: [{ id: '8', name: 'ELB' }],
        },
      ],
    },
  }

  it('recurses every nested collection the format uses', () => {
    expect(countByKind(parse(nested))).toEqual({
      softwareSystem: 1,
      container: 1,
      component: 1,
      deploymentNode: 2,
      containerInstance: 1,
      softwareSystemInstance: 1,
      infrastructureNode: 1,
    })
  })

  it('takes parentage from nesting alone, since the wire has no parent pointer', () => {
    const workspace = parse(nested)
    expect(byId(workspace, '3').parentId).toBe('2')
    expect(byId(workspace, '2').parentId).toBe('1')
    expect(byId(workspace, '1').parentId).toBeUndefined()
    expect(byId(workspace, '5').parentId).toBe('4')
    expect(byId(workspace, '6').parentId).toBe('5')
    expect(byId(workspace, '8').parentId).toBe('4')
  })

  it('collects relationships nested at any depth', () => {
    // There is no model.relationships; an importer reading one gets boxes and
    // no arrows while every element imports fine.
    expect(parse(nested).relationships.map((r) => r.id).sort()).toEqual(['20', '21'])
  })

  it('resolves what an instance is an instance of, since instances carry no name', () => {
    const workspace = parse(nested)
    expect(byId(workspace, '6').instanceOfId).toBe('2')
    expect(byId(workspace, '6').name).toBe('')
    expect(byId(workspace, '7').instanceOfId).toBe('1')
  })

  it('drops an edge with no destination and keeps its siblings', () => {
    const workspace = parse({
      name: 'W',
      model: {
        people: [
          {
            id: '1',
            name: 'U',
            relationships: [
              { id: '2', sourceId: '1' },
              { id: '3', sourceId: '1', destinationId: '4' },
            ],
          },
        ],
      },
    })
    expect(workspace.relationships.map((r) => r.id)).toEqual(['3'])
    expect(workspace.warnings.join('\n')).toMatch(/destinationId/)
  })

  it('reports a nested edge whose sourceId disagrees with the element it sits under', () => {
    const workspace = parse({
      name: 'W',
      model: {
        people: [{ id: '1', name: 'U', relationships: [{ id: '2', sourceId: '99', destinationId: '3' }] }],
      },
    })
    expect(workspace.relationships[0].sourceId).toBe('99')
    expect(workspace.warnings.join('\n')).toMatch(/nested under "1"/)
  })

  it('falls back to the enclosing element when an edge omits its sourceId', () => {
    const workspace = parse({
      name: 'W',
      model: { people: [{ id: '1', name: 'U', relationships: [{ id: '2', destinationId: '3' }] }] },
    })
    expect(workspace.relationships[0].sourceId).toBe('1')
  })
})

describe('deployment', () => {
  const tree = {
    name: 'Deploy',
    model: {
      deploymentNodes: [
        {
          id: '1',
          name: 'AWS',
          deploymentGroups: ['prod'],
          children: [
            {
              id: '2',
              name: 'Region',
              deploymentGroups: ['eu-west'],
              containerInstances: [
                { id: '3', containerId: '9', instanceId: 1, deploymentGroups: ['db'] },
                { id: '4', containerId: '9', instanceId: 2 },
              ],
            },
          ],
        },
      ],
    },
  }

  it('unions an instance’s deployment groups with every ancestor node’s', () => {
    const workspace = parse(tree)
    expect(byId(workspace, '3').deploymentGroups).toEqual(['prod', 'eu-west', 'db'])
  })

  it('gives an instance with no groups of its own the inherited ones', () => {
    expect(byId(parse(tree), '4').deploymentGroups).toEqual(['prod', 'eu-west'])
  })

  it('leaves deployment groups empty rather than materialising "Default"', () => {
    // v6.2.0 deleted the default; inventing it puts a group in the customer's
    // UI that their Structurizr does not have, and exports it back to them.
    const workspace = parse({
      name: 'W',
      model: {
        deploymentNodes: [
          { id: '1', name: 'N', containerInstances: [{ id: '2', containerId: '9', instanceId: 1 }] },
        ],
      },
    })
    expect(byId(workspace, '2').deploymentGroups).toEqual([])
    expect(byId(workspace, '1').deploymentGroups).toEqual([])
  })

  it('reads the legacy singular deploymentGroup as one entry of the array', () => {
    const workspace = parse({
      name: 'W',
      model: {
        deploymentNodes: [
          {
            id: '1',
            name: 'N',
            containerInstances: [
              { id: '2', containerId: '9', instanceId: 1, deploymentGroup: 'Default' },
            ],
          },
        ],
      },
    })
    expect(byId(workspace, '2').deploymentGroups).toEqual(['Default'])
  })

  it('keeps instances as a string when a producer writes it as a number', () => {
    const workspace = parse({
      name: 'W',
      model: { deploymentNodes: [{ id: '1', name: 'N', instances: 4 }] },
    })
    expect(byId(workspace, '1').instances).toBe('4')
  })

  it('keeps an instance range intact instead of parsing it to an int', () => {
    const workspace = parse({
      name: 'W',
      model: {
        deploymentNodes: [
          { id: '1', name: 'A', instances: '0..N' },
          { id: '2', name: 'B', instances: '1..*' },
        ],
      },
    })
    expect(byId(workspace, '1').instances).toBe('0..N')
    expect(byId(workspace, '2').instances).toBe('1..*')
  })
})

describe('legacy keys', () => {
  it('reads enterpriseContextViews as system landscape views', () => {
    const workspace = parse({
      name: 'W',
      views: { enterpriseContextViews: [{ key: 'Landscape', elements: [{ id: '1' }] }] },
    })
    expect(workspace.views[0].kind).toBe('systemLandscape')
    expect(workspace.views[0].key).toBe('Landscape')
  })

  it('reads the misspelled interactionStlye, so async edges stay async', () => {
    const workspace = parse({
      name: 'W',
      model: {
        people: [
          {
            id: '1',
            name: 'U',
            relationships: [
              { id: '2', sourceId: '1', destinationId: '3', interactionStlye: 'Asynchronous' },
            ],
          },
        ],
      },
    })
    expect(workspace.relationships[0].interactionStyle).toBe('Asynchronous')
  })

  it('reads the singular theme alias alongside the plural array', () => {
    const singular = parse({
      name: 'W',
      views: { configuration: { theme: 'https://example.test/theme.json' } },
    })
    expect(singular.themes).toEqual(['https://example.test/theme.json'])

    const both = parse({
      name: 'W',
      views: {
        configuration: {
          themes: ['amazon-web-services-2025.07'],
          theme: 'https://example.test/theme.json',
        },
      },
    })
    expect(both.themes).toEqual(['amazon-web-services-2025.07', 'https://example.test/theme.json'])
  })

  it('keeps a v5 automaticLayout even though applied and implementation are gone', () => {
    const workspace = parse({
      name: 'W',
      views: {
        systemLandscapeViews: [
          {
            key: 'K',
            automaticLayout: {
              implementation: 'Graphviz',
              rankDirection: 'TopBottom',
              applied: false,
            },
          },
        ],
      },
    })
    expect(workspace.views[0].automaticLayout).toEqual({ rankDirection: 'TopBottom' })
  })

  it('keeps a location on a person, a concept the model dropped', () => {
    const workspace = parse({
      name: 'W',
      model: { people: [{ id: '1', name: 'U', location: 'External' }] },
    })
    expect(byId(workspace, '1').location).toBe('External')
  })

  it('accepts either component-view boundary spelling without losing the view', () => {
    const workspace = parse({
      name: 'W',
      views: {
        componentViews: [
          { key: 'A', containerId: '1', externalSoftwareSystemBoundariesVisible: true },
          { key: 'B', containerId: '1', externalContainerBoundariesVisible: false },
        ],
      },
    })
    expect(workspace.views.map((v) => v.key)).toEqual(['A', 'B'])
    expect(workspace.views.map((v) => v.scopeId)).toEqual(['1', '1'])
  })
})

describe('views', () => {
  it('reads the scope from the key that view kind actually uses', () => {
    const workspace = parse({
      name: 'W',
      views: {
        systemContextViews: [{ key: 'ctx', softwareSystemId: '7' }],
        componentViews: [{ key: 'comp', containerId: '11' }],
        dynamicViews: [{ key: 'dyn', elementId: '11' }],
        deploymentViews: [{ key: 'dep', softwareSystemId: '7', environment: 'Live' }],
      },
    })
    const scope = Object.fromEntries(workspace.views.map((v) => [v.key, v.scopeId]))
    expect(scope).toEqual({ ctx: '7', comp: '11', dyn: '11', dep: '7' })
    expect(workspace.views.find((v) => v.key === 'dep')?.environment).toBe('Live')
  })

  it('keeps an absent view order absent and clamps an explicit zero to one', () => {
    const workspace = parse({
      name: 'W',
      views: {
        systemLandscapeViews: [
          { key: 'none' },
          { key: 'zero', order: 0 },
          { key: 'three', order: 3 },
        ],
      },
    })
    const orders = Object.fromEntries(workspace.views.map((v) => [v.key, v.order]))
    expect(orders).toEqual({ none: undefined, zero: 1, three: 3 })
  })

  it('keeps x = 0 distinct from an absent x', () => {
    const workspace = parse({
      name: 'W',
      views: {
        systemLandscapeViews: [
          {
            key: 'K',
            elements: [
              { id: '1', x: 0, y: 0 },
              { id: '2' },
              { id: '3', x: null, y: null },
            ],
          },
        ],
      },
    })
    expect(workspace.views[0].elements).toEqual([
      { id: '1', x: 0, y: 0 },
      { id: '2', x: undefined, y: undefined },
      { id: '3', x: undefined, y: undefined },
    ])
  })

  it('keeps a dynamic view’s repeated relationship ids as separate steps', () => {
    const workspace = parse({
      name: 'W',
      views: {
        dynamicViews: [
          {
            key: 'SignIn',
            elementId: '11',
            relationships: [
              { id: '32', order: '1', description: 'Submits credentials to' },
              { id: '32', order: '6', description: 'Sends back a token to', response: true },
            ],
          },
        ],
      },
    })
    expect(workspace.views[0].relationships).toHaveLength(2)
    expect(workspace.views[0].relationships[1].response).toBe(true)
  })

  it('keeps a nested step number as a string rather than parsing it', () => {
    const workspace = parse({
      name: 'W',
      views: {
        dynamicViews: [{ key: 'D', relationships: [{ id: '1', order: '1.1' }, { id: '2', order: 2 }] }],
      },
    })
    expect(workspace.views[0].relationships.map((r) => r.order)).toEqual(['1.1', '2'])
  })

  it('keeps vertices in path order and drops only the malformed points', () => {
    const workspace = parse({
      name: 'W',
      views: {
        containerViews: [
          {
            key: 'C',
            relationships: [
              {
                id: '1',
                vertices: [{ x: 1238, y: 236 }, { x: 'nope', y: 1 }, { x: 40, y: 50 }],
              },
            ],
          },
        ],
      },
    })
    expect(workspace.views[0].relationships[0].vertices).toEqual([
      { x: 1238, y: 236 },
      { x: 40, y: 50 },
    ])
    expect(workspace.warnings.join('\n')).toMatch(/vertex/)
  })

  it('falls back to the computed name when a view has no user title', () => {
    const workspace = parse({
      name: 'W',
      views: {
        containerViews: [
          { key: 'A', name: 'Container View: Shop' },
          { key: 'B', name: 'Container View: Shop', title: '[Container] Shop' },
        ],
      },
    })
    expect(workspace.views.map((v) => v.title)).toEqual([
      'Container View: Shop',
      '[Container] Shop',
    ])
  })
})

describe('styles and themes', () => {
  it('keeps element styles in file order and does not merge duplicate tags', () => {
    // Jackson field-injects an ArrayList here, so file order is authoring
    // order, and resolution merges duplicates per property downstream —
    // collapsing them here would change the colours the customer saw.
    const workspace = parse({
      name: 'W',
      views: {
        configuration: {
          styles: {
            elements: [
              { tag: 'Database', shape: 'Cylinder' },
              { tag: 'Element', background: '#ffffff' },
              { tag: 'Database', background: '#00d230' },
            ],
            relationships: [{ tag: 'Relationship', style: 'Dotted', dashed: false, thickness: 2 }],
          },
        },
      },
    })
    expect(workspace.elementStyles.map((s) => s.tag)).toEqual(['Database', 'Element', 'Database'])
    expect(workspace.elementStyles[0].shape).toBe('Cylinder')
    expect(workspace.elementStyles[2].background).toBe('#00d230')
    expect(workspace.relationshipStyles[0]).toEqual({
      tag: 'Relationship',
      color: undefined,
      dashed: false,
      style: 'Dotted',
      thickness: 2,
      colorScheme: undefined,
    })
  })

  it('warns about a style tag with stray whitespace, which matches nothing', () => {
    const workspace = parse({
      name: 'W',
      views: { configuration: { styles: { elements: [{ tag: ' Database', shape: 'Cylinder' }] } } },
    })
    expect(workspace.elementStyles[0].tag).toBe('Database')
    expect(workspace.warnings.join('\n')).toMatch(/stray whitespace/)
  })
})

describe('groups', () => {
  it('reads the declared group separator off the model properties', () => {
    const workspace = parse({
      name: 'W',
      model: {
        properties: { 'structurizr.groupSeparator': '/' },
        softwareSystems: [{ id: '1', name: 'A', group: 'Group 2/Group 3' }],
      },
    })
    expect(workspace.groupSeparator).toBe('/')
    expect(byId(workspace, '1').group).toBe('Group 2/Group 3')
  })

  it('keeps a group named Payments/Billing intact when no separator is declared', () => {
    const workspace = parse({
      name: 'W',
      model: { softwareSystems: [{ id: '1', name: 'A', group: 'Payments/Billing' }] },
    })
    expect(workspace.groupSeparator).toBeUndefined()
    expect(byId(workspace, '1').group).toBe('Payments/Billing')
  })

  it('accepts a legacy multi-character separator, which the JSON path never validated', () => {
    const workspace = parse({
      name: 'W',
      model: { properties: { 'structurizr.groupSeparator': '::' }, softwareSystems: [] },
    })
    expect(workspace.groupSeparator).toBe('::')
  })
})

describe('surviving a malformed sub-object', () => {
  it('keeps the workspace when a perspective has no name', () => {
    const workspace = parse({
      name: 'W',
      model: {
        people: [
          {
            id: '1',
            name: 'U',
            perspectives: [{ description: 'High' }, { name: 'Security', description: 'High' }],
          },
        ],
      },
    })
    expect(byId(workspace, '1').perspectives).toEqual([
      { name: 'Security', description: 'High', value: undefined, url: undefined },
    ])
    expect(workspace.warnings.join('\n')).toMatch(/perspective with no name/)
  })

  it('keeps a view whose key is missing by synthesising one', () => {
    const workspace = parse({
      name: 'W',
      views: { deploymentViews: [{ environment: 'Live', elements: [{ id: '1' }] }] },
    })
    expect(workspace.views).toHaveLength(1)
    expect(workspace.views[0].key).toBe('deployment-1')
    expect(workspace.warnings.join('\n')).toMatch(/no key/)
  })

  it('keeps an element whose id is missing by synthesising one', () => {
    const workspace = parse({ name: 'W', model: { people: [{ name: 'U' }] } })
    expect(workspace.elements).toHaveLength(1)
    expect(workspace.elements[0].id).toMatch(/synthesised/)
  })

  it('reports duplicate ids instead of silently dropping one, as the TreeSet would', () => {
    const workspace = parse({
      name: 'W',
      model: {
        people: [
          { id: '1', name: 'A' },
          { id: '1', name: 'B' },
        ],
      },
    })
    expect(workspace.elements.map((e) => e.name)).toEqual(['A', 'B'])
    expect(workspace.warnings.join('\n')).toMatch(/duplicate element id "1"/)
  })

  it('walks past an element entry that is not an object at all', () => {
    const workspace = parse({
      name: 'W',
      model: { people: [null, 'User', { id: '1', name: 'Real' }] },
    })
    expect(workspace.elements.map((e) => e.id)).toEqual(['1'])
    expect(workspace.warnings.filter((w) => w.includes('not an object'))).toHaveLength(2)
  })

  it('ignores a non-scalar property value rather than failing the element', () => {
    const workspace = parse({
      name: 'W',
      model: {
        people: [{ id: '1', name: 'U', properties: { good: 'yes', count: 3, bad: { nested: true } } }],
      },
    })
    expect(byId(workspace, '1').properties).toEqual({ good: 'yes', count: '3' })
    expect(workspace.warnings.join('\n')).toMatch(/non-scalar property "bad"/)
  })

  it('treats an unknown interactionStyle as absent rather than guessing its case', () => {
    const workspace = parse({
      name: 'W',
      model: {
        people: [
          {
            id: '1',
            name: 'U',
            relationships: [
              { id: '2', sourceId: '1', destinationId: '3', interactionStyle: 'asynchronous' },
            ],
          },
        ],
      },
    })
    expect(workspace.relationships[0].interactionStyle).toBeUndefined()
    expect(workspace.warnings.join('\n')).toMatch(/unknown interactionStyle/)
  })

  it('reports a workspace with no name instead of inventing one', () => {
    const workspace = parse({ model: { people: [{ id: '1', name: 'U' }] } })
    expect(workspace.name).toBe('')
    expect(workspace.warnings).toContain('workspace: no name')
  })
})

// ── The real corpus ──────────────────────────────────────────────────────────
// Counts below were taken from the fixtures themselves; they are the whole
// point of the file, because a hand-written fixture only proves the reader
// agrees with its author.

describe('big-bank-plc.json — the canonical example', () => {
  const workspace = parseWorkspaceJson(bigBankRaw)

  it('imports all 51 elements with the right kind breakdown', () => {
    expect(workspace.elements).toHaveLength(51)
    expect(countByKind(workspace)).toEqual({
      person: 3,
      softwareSystem: 4,
      container: 5,
      component: 6,
      deploymentNode: 21,
      containerInstance: 10,
      softwareSystemInstance: 2,
    })
  })

  it('finds all 42 relationships, none of which is at the top of the model', () => {
    expect(workspace.relationships).toHaveLength(42)
    expect(workspace.relationships.filter((r) => r.linkedRelationshipId !== undefined)).toHaveLength(
      15,
    )
  })

  it('imports all eight views across seven kinds', () => {
    expect(workspace.views).toHaveLength(8)
    expect(countViews(workspace)).toEqual({
      systemLandscape: 1,
      systemContext: 1,
      container: 1,
      component: 1,
      dynamic: 1,
      deployment: 2,
      image: 1,
    })
  })

  it('keeps all 67 element views at the origin rather than calling them unpositioned', () => {
    const rows = workspace.views.flatMap((v) => v.elements)
    expect(rows).toHaveLength(67)
    expect(rows.filter((r) => r.x === 0 && r.y === 0)).toHaveLength(67)
  })

  it('reads the eleven element styles in file order', () => {
    expect(workspace.elementStyles.map((s) => s.tag)).toEqual([
      'Person',
      'Customer',
      'Bank Staff',
      'Software System',
      'Existing System',
      'Container',
      'Web Browser',
      'Mobile App',
      'Database',
      'Component',
      'Failover',
    ])
    expect(workspace.relationshipStyles).toEqual([])
  })

  it('drops the phantom tag off the deployment node written "Element,Deployment Node,"', () => {
    const dirty = workspace.elements.filter((e) => e.styleTags.includes('Deployment Node'))
    expect(dirty.length).toBeGreaterThan(0)
    for (const element of dirty) expect(element.styleTags).not.toContain('')
  })

  it('parents the six components on their container and the container on its system', () => {
    const components = workspace.elements.filter((e) => e.kind === 'component')
    expect(new Set(components.map((c) => c.parentId))).toEqual(new Set(['11']))
    expect(byId(workspace, '11').parentId).toBe('7')
  })

  it('reads the sign-in dynamic view as six ordered steps over three edges', () => {
    const dynamic = workspace.views.find((v) => v.kind === 'dynamic')
    expect(dynamic?.relationships.map((r) => r.order)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(new Set(dynamic?.relationships.map((r) => r.id)).size).toBe(3)
    expect(dynamic?.relationships.filter((r) => r.response === true)).toHaveLength(3)
  })
})

describe('groups.json — nested groups behind a declared separator', () => {
  const workspace = parseWorkspaceJson(groupsRaw)

  it('imports 8 elements and 7 relationships', () => {
    expect(workspace.elements).toHaveLength(8)
    expect(countByKind(workspace)).toEqual({ softwareSystem: 4, container: 2, component: 2 })
    expect(workspace.relationships).toHaveLength(7)
  })

  it('reads the declared separator but leaves the group path unsplit', () => {
    expect(workspace.groupSeparator).toBe('/')
    expect(byId(workspace, '4').group).toBe('Group 2/Group 3')
    expect(byId(workspace, '8').group).toBe('Group 5')
  })

  it('reads the four-key minimal relationship that carries only a linked id', () => {
    const derived = workspace.relationships.find((r) => r.id === '12')
    expect(derived).toMatchObject({
      sourceId: '3',
      destinationId: '4',
      linkedRelationshipId: '11',
      tags: [],
      styleTags: [],
    })
    expect(derived?.description).toBeUndefined()
  })

  it('keeps all three views and their v5 automatic layout', () => {
    expect(countViews(workspace)).toEqual({ systemLandscape: 1, container: 1, component: 1 })
    for (const view of workspace.views) {
      expect(view.automaticLayout).toEqual({ rankDirection: 'TopBottom' })
    }
  })
})

describe('deployment-positioned.json — real coordinates alongside automaticLayout', () => {
  const workspace = parseWorkspaceJson(deploymentPositionedRaw)

  it('imports 13 elements including both infrastructure nodes', () => {
    expect(countByKind(workspace)).toEqual({
      softwareSystem: 1,
      container: 2,
      deploymentNode: 6,
      containerInstance: 2,
      infrastructureNode: 2,
    })
  })

  it('keeps all ten real coordinates even though the view declares automaticLayout', () => {
    const view = workspace.views[0]
    expect(view.kind).toBe('deployment')
    expect(view.environment).toBe('Live')
    expect(view.automaticLayout).toEqual({ rankDirection: 'LeftRight' })
    expect(view.elements).toHaveLength(10)
    expect(view.elements.filter((e) => e.x === 0 && e.y === 0)).toHaveLength(0)
    expect(view.elements.every((e) => e.x !== undefined && e.y !== undefined)).toBe(true)
  })

  it('reads this producer’s numeric instances back as strings', () => {
    const nodes = workspace.elements.filter((e) => e.kind === 'deploymentNode')
    expect(nodes.map((n) => n.instances)).toEqual(['1', '1', '1', '1', '1', '1'])
  })

  it('reads the deployment groups this file actually declares, without inventing more', () => {
    expect(byId(workspace, '14').deploymentGroups).toEqual(['Default'])
    expect(byId(workspace, '13').deploymentGroups).toEqual([])
  })

  it('keeps the single theme reference without fetching it', () => {
    expect(workspace.themes).toEqual([
      'https://static.structurizr.com/themes/amazon-web-services-2020.04.30/theme.json',
    ])
  })

  it('nests the AWS deployment tree six levels deep by nesting alone', () => {
    expect(byId(workspace, '14').parentId).toBe('13')
    expect(byId(workspace, '13').parentId).toBe('12')
    expect(byId(workspace, '12').parentId).toBe('6')
    expect(byId(workspace, '6').parentId).toBe('5')
    expect(byId(workspace, '5').parentId).toBeUndefined()
  })
})

describe('big-real-workspace.json — a 436 KB workspace from the cloud service', () => {
  const workspace = parseWorkspaceJson(bigRealRaw)

  it('imports the whole model without losing anything to a malformed sub-object', () => {
    expect(workspace.elements).toHaveLength(51)
    expect(workspace.relationships).toHaveLength(42)
    expect(countByKind(workspace)).toEqual({
      person: 3,
      softwareSystem: 4,
      container: 5,
      component: 6,
      deploymentNode: 21,
      containerInstance: 10,
      softwareSystemInstance: 2,
    })
  })

  it('imports seven views — this file has no system landscape', () => {
    expect(countViews(workspace)).toEqual({
      systemContext: 1,
      container: 1,
      component: 1,
      dynamic: 1,
      deployment: 2,
      image: 1,
    })
  })

  it('keeps the 39 hand-placed positions and the 21 that sit at the origin', () => {
    const rows = workspace.views.flatMap((v) => v.elements)
    expect(rows).toHaveLength(60)
    expect(rows.filter((r) => r.x === 0 && r.y === 0)).toHaveLength(21)
    expect(rows.filter((r) => r.x === undefined)).toHaveLength(0)
  })

  it('keeps the embedded DSL source out of the way of the model', () => {
    // `properties["structurizr.dsl"]` is workspace-level and 14 KB here; it must
    // not end up as an element property or a tag.
    expect(workspace.elements.some((e) => 'structurizr.dsl' in e.properties)).toBe(false)
  })
})

describe('the corpus as a whole', () => {
  it('reports no diagnostics for any of the five real files', () => {
    // Every warning is shown to the user as an import problem, so a reader that
    // warns about ordinary v5/v6 output is as broken as one that stays silent
    // about a real loss. All five of these parse clean today.
    const noise = Object.fromEntries(
      (
        [
          ['big-bank-plc', bigBankRaw],
          ['groups', groupsRaw],
          ['deployment-positioned', deploymentPositionedRaw],
          ['big-real-workspace', bigRealRaw],
          ['views-without-order', viewsWithoutOrderRaw],
        ] as const
      ).map(([name, raw]) => [name, parseWorkspaceJson(raw).warnings]),
    )
    expect(noise).toEqual({
      'big-bank-plc': [],
      groups: [],
      'deployment-positioned': [],
      'big-real-workspace': [],
      'views-without-order': [],
    })
  })
})

describe('views-without-order.json', () => {
  const workspace = parseWorkspaceJson(viewsWithoutOrderRaw)

  it('keeps both landscape views although neither declares an order', () => {
    expect(workspace.views.map((v) => v.key)).toEqual([
      'SystemLandscape-001',
      'SystemLandscape-002',
    ])
    expect(workspace.views.map((v) => v.order)).toEqual([undefined, undefined])
  })

  it('reads the single person and its element rows with no coordinates', () => {
    expect(workspace.elements).toHaveLength(1)
    expect(workspace.views[0].elements).toEqual([{ id: '1', x: undefined, y: undefined }])
  })
})

describe('a producer that numbers its ids', () => {
  // §4.5 says ids are opaque STRINGS, and Java writes them that way — but at
  // least one producer emits JSON numbers, and reading only strings there loses
  // every element it wrote AND every view row that points at one. This is a
  // total-loss guard, so it is exercised end to end rather than on the helper.
  const numeric = JSON.stringify({
    name: 'numbered',
    model: {
      people: [{ id: 1, name: 'User', tags: 'Element,Person' }],
      softwareSystems: [
        {
          id: 2,
          name: 'A',
          tags: 'Element,Software System',
          relationships: [{ id: 9, sourceId: 2, destinationId: 1, description: 'Notifies' }],
        },
      ],
    },
    views: {
      systemLandscapeViews: [
        { key: 'L', elements: [{ id: 1, x: 100, y: 100 }, { id: 2 }], relationships: [{ id: 9 }] },
      ],
    },
  })

  it('reads a numeric element id as the string every reference compares against', () => {
    const workspace = parseWorkspaceJson(numeric)
    expect(workspace.elements.map((e) => e.id)).toEqual(['1', '2'])
    expect(workspace.relationships[0]).toMatchObject({ id: '9', sourceId: '2', destinationId: '1' })
    expect(workspace.views[0].elements.map((e) => e.id)).toEqual(['1', '2'])
    expect(workspace.views[0].relationships.map((r) => r.id)).toEqual(['9'])
  })

  it('still refuses an id that is not a scalar at all', () => {
    const broken = JSON.stringify({
      name: 'broken',
      model: { people: [{ id: { nested: true }, name: 'User', tags: 'Element,Person' }] },
    })
    const workspace = parseWorkspaceJson(broken)
    // Synthesised rather than dropped — losing a 436 KB workspace over one bad
    // id is the failure this parser exists to prevent — but never `[object Object]`.
    expect(workspace.elements[0]?.id).not.toBe('[object Object]')
    expect(workspace.warnings.length).toBeGreaterThan(0)
  })
})
