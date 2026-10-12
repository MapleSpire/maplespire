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
 * Deterministic mini C4 model for the org-admin "seed demo environment"
 * feature (ORG_SEED=on): a small, realistic e-commerce landscape — 3 domains,
 * ~15 objects across context/container levels, connections, groups, tags and
 * 3 diagrams with tidy grid layouts.
 *
 * Shapes mirror the CLIENT's types (src/types/index.ts C4Object/Connection/
 * Group/Domain/Tag + src/lib/automerge/types.ts DiagramDoc/DiagramMeta),
 * inlined here — the server deliberately never imports client source (same
 * convention as automergeServer.ts's emptyRoot).
 *
 * Content is invented demo data ("Storefront platform") — it does not model
 * any real system.
 */

import {
  SEEDED_TECHNOLOGY_CATALOG_REVISION,
  SEEDED_TECHNOLOGY_IDS,
  seededTechnologyMetadata,
} from '../technologies/seed.js'
import type { TechnologyRole, TechnologyShapeType } from '../technologies/types.js'
import {
  SEEDED_TAG_DEFINITIONS,
  seededTagGroupId,
  seededTagId,
} from '../tags/seed.js'

export interface SeedObject {
  id: string
  type: 'actor' | 'system' | 'app' | 'store' | 'component'
  name: string
  description?: string
  technologyUsages?: Record<string, {
    id: string
    technologyId: string
    catalogRevision: number
    role?: TechnologyRole
    snapshot: {
      schemaVersion: 1
      name: string
      recommendedShapeTypes: TechnologyShapeType[]
      defaultRole: TechnologyRole
      iconLightPath?: string
      iconDarkPath?: string
    }
  }>
  technologyUsageOrder?: string[]
  icon?: string
  iconAssignment?: {
    source: 'technology'
    mode: 'automatic'
    displayName: string
    technologyUsageId: string
    catalogRevision: number
    iconLightPath?: string
    iconDarkPath?: string
  }
  position: { x: number; y: number }
  size: { width: number; height: number }
  parentId?: string
  domainId?: string
  tagAssignments: Record<string, { tagId: string }>
  tagOrder: string[]
  scope: 'internal' | 'external'
  status: 'live' | 'draft' | 'down' | 'unstable'
  properties: Record<string, string>
}

export interface SeedConnection {
  id: string
  fromId: string
  toId: string
  label?: string
  type: 'solid' | 'dashed' | 'dotted'
}

export interface SeedDiagram {
  id: string
  name: string
  type: 'context' | 'container'
  objectIds: string[]
  connectionIds: string[]
  groupIds: string[]
  parentObjectId?: string
  layouts: Record<string, { position: { x: number; y: number }; size: { width: number; height: number } }>
}

export interface SeedModel {
  domains: Record<string, { id: string; name: string; color?: string }>
  objects: SeedObject[]
  connections: SeedConnection[]
  groups: Record<string, never>
  tagSnapshots: Record<string, {
    tagId: string
    value: string
    color: string
    groupId: string
    groupName: string
    catalogRevision: number
  }>
  diagrams: SeedDiagram[]
}

const CELL_W = 220
const CELL_H = 150

function at(col: number, row: number): { x: number; y: number } {
  return { x: 120 + col * CELL_W, y: 100 + row * CELL_H }
}

const SIZE = { width: 160, height: 100 }

export const ORG_SEED_TECHNOLOGY_NAMES = ['React', 'Node.js', 'PostgreSQL', 'Redis'] as const

function technologyId(name: string): string {
  const id = SEEDED_TECHNOLOGY_IDS[name]
  if (!id) throw new Error(`Missing central catalog seed id for ${name}`)
  return id
}

function technologyUsage(
  ownerId: string,
  name: typeof ORG_SEED_TECHNOLOGY_NAMES[number],
): SeedObject['technologyUsages'] {
  const slug = technologyId(name).slice('tech_seed_'.length)
  const id = `tu_${ownerId}_${slug}`
  const metadata = seededTechnologyMetadata(name)
  if (!metadata) throw new Error(`Missing central catalog metadata for ${name}`)
  return {
    [id]: {
      id,
      technologyId: technologyId(name),
      catalogRevision: SEEDED_TECHNOLOGY_CATALOG_REVISION,
      role: metadata.defaultRole,
      snapshot: { schemaVersion: 1, name, ...metadata },
    },
  }
}

export function generateSeedModel(orgId: string): SeedModel {
  const domains = {
    'seed-dom-storefront': { id: 'seed-dom-storefront', name: 'Storefront', color: '#7E8AA3' },
    'seed-dom-payments': { id: 'seed-dom-payments', name: 'Payments', color: '#C06A2C' },
    'seed-dom-logistics': { id: 'seed-dom-logistics', name: 'Logistics', color: '#6F6A62' },
  }

  const obj = (
    id: string,
    type: SeedObject['type'],
    name: string,
    o: Partial<SeedObject> & { position: { x: number; y: number } }
  ): SeedObject => {
    const seeded: SeedObject = {
      id,
      type,
      name,
      tagAssignments: {},
      tagOrder: [],
      scope: 'internal',
      status: 'live',
      properties: {},
      size: SIZE,
      ...o,
    }
    const usageIds = Object.keys(seeded.technologyUsages ?? {})
    if (usageIds.length > 0) {
      seeded.technologyUsageOrder = usageIds
      if (!seeded.icon) {
        const usage = seeded.technologyUsages![usageIds[0]]
        seeded.icon = usage.snapshot.name
        seeded.iconAssignment = {
          source: 'technology',
          mode: 'automatic',
          displayName: usage.snapshot.name,
          technologyUsageId: usage.id,
          catalogRevision: usage.catalogRevision,
          ...(usage.snapshot.iconLightPath ? { iconLightPath: usage.snapshot.iconLightPath } : {}),
          ...(usage.snapshot.iconDarkPath ? { iconDarkPath: usage.snapshot.iconDarkPath } : {}),
        }
      }
    }
    return seeded
  }

  const objects: SeedObject[] = [
    obj('seed-actor-shopper', 'actor', 'Shopper', {
      description: 'A customer browsing and buying online.',
      position: at(0, 0),
    }),
    obj('seed-sys-storefront', 'system', 'Storefront platform', {
      description: 'The e-commerce web platform: catalog, cart, checkout.',
      domainId: 'seed-dom-storefront',
      position: at(1, 0),
    }),
    obj('seed-sys-payments', 'system', 'Payment service', {
      description: 'Card processing and refunds.',
      domainId: 'seed-dom-payments',
      position: at(2, 0),
    }),
    obj('seed-sys-warehouse', 'system', 'Warehouse system', {
      description: 'Inventory and fulfilment.',
      domainId: 'seed-dom-logistics',
      position: at(1, 1),
    }),
    obj('seed-sys-email', 'system', 'Email provider', {
      description: 'Transactional email delivery.',
      scope: 'external',
      position: at(2, 1),
    }),
    obj('seed-sys-carrier', 'system', 'Carrier API', {
      description: 'Shipping labels and tracking.',
      scope: 'external',
      position: at(0, 1),
    }),
    // Containers inside the storefront platform
    obj('seed-app-web', 'app', 'Web app', {
      description: 'Server-rendered storefront UI.',
      technologyUsages: technologyUsage('seed-app-web', 'React'),
      parentId: 'seed-sys-storefront',
      domainId: 'seed-dom-storefront',
      position: at(0, 0),
    }),
    obj('seed-app-api', 'app', 'Commerce API', {
      description: 'Catalog, cart and order APIs.',
      technologyUsages: technologyUsage('seed-app-api', 'Node.js'),
      parentId: 'seed-sys-storefront',
      domainId: 'seed-dom-storefront',
      position: at(1, 0),
    }),
    obj('seed-app-checkout', 'app', 'Checkout service', {
      description: 'Order placement and payment orchestration.',
      technologyUsages: technologyUsage('seed-app-checkout', 'Node.js'),
      parentId: 'seed-sys-storefront',
      domainId: 'seed-dom-payments',
      position: at(2, 0),
    }),
    obj('seed-store-orders', 'store', 'Orders DB', {
      description: 'Orders and order events.',
      technologyUsages: technologyUsage('seed-store-orders', 'PostgreSQL'),
      parentId: 'seed-sys-storefront',
      domainId: 'seed-dom-storefront',
      position: at(1, 1),
    }),
    obj('seed-store-catalog', 'store', 'Catalog DB', {
      description: 'Products, prices, stock snapshots.',
      technologyUsages: technologyUsage('seed-store-catalog', 'PostgreSQL'),
      parentId: 'seed-sys-storefront',
      domainId: 'seed-dom-storefront',
      position: at(0, 1),
    }),
    obj('seed-store-cache', 'store', 'Session cache', {
      description: 'Carts and sessions.',
      technologyUsages: technologyUsage('seed-store-cache', 'Redis'),
      parentId: 'seed-sys-storefront',
      domainId: 'seed-dom-storefront',
      status: 'unstable',
      position: at(2, 1),
    }),
  ]

  const conn = (id: string, fromId: string, toId: string, label: string, type: SeedConnection['type'] = 'solid'): SeedConnection => ({
    id,
    fromId,
    toId,
    label,
    type,
  })

  const connections: SeedConnection[] = [
    conn('seed-con-1', 'seed-actor-shopper', 'seed-sys-storefront', 'Browses and buys'),
    conn('seed-con-2', 'seed-sys-storefront', 'seed-sys-payments', 'Charges cards'),
    conn('seed-con-3', 'seed-sys-storefront', 'seed-sys-warehouse', 'Reserves stock'),
    conn('seed-con-4', 'seed-sys-storefront', 'seed-sys-email', 'Sends receipts', 'dashed'),
    conn('seed-con-5', 'seed-sys-warehouse', 'seed-sys-carrier', 'Books shipments'),
    conn('seed-con-6', 'seed-app-web', 'seed-app-api', 'REST'),
    conn('seed-con-7', 'seed-app-api', 'seed-store-catalog', 'Reads'),
    conn('seed-con-8', 'seed-app-api', 'seed-store-orders', 'Reads/writes'),
    conn('seed-con-9', 'seed-app-web', 'seed-store-cache', 'Sessions'),
    conn('seed-con-10', 'seed-app-checkout', 'seed-store-orders', 'Writes orders'),
    conn('seed-con-11', 'seed-app-api', 'seed-app-checkout', 'Places order'),
  ]

  const tagSnapshots: SeedModel['tagSnapshots'] = {}
  for (const definition of SEEDED_TAG_DEFINITIONS) {
    const tagId = seededTagId(orgId, definition.groupName, definition.value)
    tagSnapshots[tagId] = {
      tagId,
      value: definition.value,
      color: definition.color,
      groupId: seededTagGroupId(orgId, definition.groupName),
      groupName: definition.groupName,
      catalogRevision: 1,
    }
  }
  const assign = (objectId: string, definitions: Array<[groupName: string, value: string]>) => {
    const object = objects.find((candidate) => candidate.id === objectId)
    if (!object) throw new Error(`Missing seed object ${objectId}`)
    for (const [groupName, value] of definitions) {
      const tagId = seededTagId(orgId, groupName, value)
      object.tagAssignments[tagId] = { tagId }
      object.tagOrder.push(tagId)
    }
  }
  assign('seed-sys-storefront', [['Risk', 'Medium'], ['Cost', 'Tier 1'], ['Deployment', 'Multi-region']])
  assign('seed-app-web', [['Accessibility', 'WCAG AA'], ['Hostnames', 'shop.example.test'], ['Release', '2026.7']])
  assign('seed-app-checkout', [['Security', 'PCI scope'], ['Risk', 'High']])
  assign('seed-sys-payments', [['Security', 'PCI scope'], ['Region', 'us-east-1']])
  assign('seed-store-orders', [['Security', 'Encrypted'], ['Cost', 'Tier 1'], ['Region', 'ca-central-1']])
  assign('seed-store-catalog', [['Security', 'Encrypted'], ['Cost', 'Tier 2']])
  assign('seed-store-cache', [['Risk', 'High'], ['Deployment', 'Public cloud']])

  const layoutOf = (ids: string[], perRow: number): SeedDiagram['layouts'] => {
    const layouts: SeedDiagram['layouts'] = {}
    ids.forEach((id, i) => {
      layouts[id] = { position: at(i % perRow, Math.floor(i / perRow)), size: SIZE }
    })
    return layouts
  }

  const contextIds = [
    'seed-actor-shopper',
    'seed-sys-storefront',
    'seed-sys-payments',
    'seed-sys-warehouse',
    'seed-sys-email',
    'seed-sys-carrier',
  ]
  const containerIds = ['seed-app-web', 'seed-app-api', 'seed-app-checkout', 'seed-store-catalog', 'seed-store-orders', 'seed-store-cache']
  const checkoutIds = ['seed-app-checkout', 'seed-store-orders', 'seed-sys-payments', 'seed-app-api']

  const diagrams: SeedDiagram[] = [
    {
      id: 'seed-dg-context',
      name: 'System context',
      type: 'context',
      objectIds: contextIds,
      connectionIds: ['seed-con-1', 'seed-con-2', 'seed-con-3', 'seed-con-4', 'seed-con-5'],
      groupIds: [],
      layouts: layoutOf(contextIds, 3),
    },
    {
      id: 'seed-dg-containers',
      name: 'Storefront containers',
      type: 'container',
      parentObjectId: 'seed-sys-storefront',
      objectIds: containerIds,
      connectionIds: ['seed-con-6', 'seed-con-7', 'seed-con-8', 'seed-con-9', 'seed-con-10', 'seed-con-11'],
      groupIds: [],
      layouts: layoutOf(containerIds, 3),
    },
    {
      id: 'seed-dg-checkout',
      name: 'Checkout flow',
      type: 'container',
      objectIds: checkoutIds,
      connectionIds: ['seed-con-10', 'seed-con-11', 'seed-con-2'],
      groupIds: [],
      layouts: layoutOf(checkoutIds, 2),
    },
  ]

  return { domains, objects, connections, groups: {}, tagSnapshots, diagrams }
}
