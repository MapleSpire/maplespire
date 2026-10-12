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

import type { C4Object, Connection } from '../../types'
import { objectLinkUrl } from '../objectLinks'
import type { ExportBundle } from './types'
import { orderedTechnologyUsages } from '../technologyUsage'
import { orderedOwnerAssignments } from '../owners'
import { objectDetailedDescription, objectShortDescription } from '../objectDescription'

/** RFC-4180 field: quote when the value contains a comma, quote or newline. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function csvLine(fields: string[]): string {
  return fields.map(csvField).join(',')
}

const BOM = String.fromCharCode(0xfeff)
const CRLF = String.fromCharCode(13, 10)

/** Rows → CSV text with a UTF-8 BOM (so Excel opens accents correctly) and CRLF ends. */
function toCsv(header: string[], rows: string[][]): string {
  return BOM + [csvLine(header), ...rows.map(csvLine)].join(CRLF) + CRLF
}

type MetadataCarrier = Pick<
  C4Object,
  'technologyUsages' | 'technologyUsageOrder' | 'ownerAssignments' | 'ownerAssignmentOrder' | 'ownerTeamIds'
>

const technologyNames = (entity: MetadataCarrier): string =>
  orderedTechnologyUsages(entity.technologyUsages, entity.technologyUsageOrder).map((usage) => usage.snapshot.name).join('; ')

const ownerNames = (entity: MetadataCarrier): string =>
  orderedOwnerAssignments(entity).map((assignment) => assignment.name).join('; ')

/** Walk the parent chain to the nearest ancestor of the given type, if any. */
function ancestorOfType(
  o: C4Object,
  type: C4Object['type'],
  byId: Map<string, C4Object>,
): C4Object | undefined {
  let cur = o.parentId ? byId.get(o.parentId) : undefined
  for (let hop = 0; cur && hop < 100; hop++) {
    if (cur.type === type) return cur
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return undefined
}

export const OBJECTS_CSV_HEADER = [
  'Identifier',
  'Belongs Inside System',
  'Belongs Inside App',
  'Belongs Inside Store',
  'Object Name',
  'Object Type',
  'Object Status',
  'Object External',
  'Object Displayed Description',
  'Object Tags',
  'Object Technology',
  'Object Teams',
  'Object Link',
  'Object Share Link',
  'Object Description',
]

/** One row per model object. Connections and flows are not included. */
export function buildObjectsCsv(bundle: ExportBundle): string {
  const byId = new Map(bundle.objects.map((o) => [o.id, o]))
  const tagById = new Map(bundle.tags.map((tag) => [tag.tagId, tag]))
  const tagValues = (object: C4Object) => object.tagOrder
    .map((tagId) => tagById.get(tagId)?.value ?? tagId)
    .join('; ')
  const rows = bundle.objects.map((o) => {
    return [
      o.id,
      ancestorOfType(o, 'system', byId)?.name ?? '',
      ancestorOfType(o, 'app', byId)?.name ?? '',
      ancestorOfType(o, 'store', byId)?.name ?? '',
      o.name,
      o.type,
      o.status,
      o.scope === 'external' ? 'true' : 'false',
      objectShortDescription(o) ?? '',
      tagValues(o),
      technologyNames(o),
      ownerNames(o),
      o.links?.[0] ? objectLinkUrl(o.links[0]) : '',
      '', // Share links are per diagram, not per object
      objectDetailedDescription(o) ?? '',
    ]
  })
  return toCsv(OBJECTS_CSV_HEADER, rows)
}

export const CONNECTIONS_CSV_HEADER = [
  'Identifier',
  'Sender Belongs Inside',
  'Sender Object Name',
  'Sender Object Type',
  'Sender Object External',
  'Sender Object Tags',
  'Sender Object Technology',
  'Sender Object Teams',
  'Connection Name',
  'Connection Status',
  'Connection Direction',
  'Connection Tags',
  'Connection Technology',
  'Connection Teams',
  'Connection Description',
  'Receiver Belongs Inside',
  'Receiver Object Name',
  'Receiver Object Type',
  'Receiver Object External',
  'Receiver Object Tags',
  'Receiver Object Technology',
  'Receiver Object Teams',
]

/** One row per model connection, with its sender and receiver denormalised. */
export function buildConnectionsCsv(bundle: ExportBundle): string {
  const byId = new Map(bundle.objects.map((o) => [o.id, o]))
  const tagById = new Map(bundle.tags.map((tag) => [tag.tagId, tag]))
  const tagValues = (connection: Connection) => (connection.tagOrder ?? [])
    .map((tagId) => tagById.get(tagId)?.value ?? tagId)
    .join('; ')
  const endpoint = (id: string): string[] => {
    const o = byId.get(id)
    if (!o) return [id, '', '', '', '', '', '']
    return [
      o.parentId ? byId.get(o.parentId)?.name ?? '' : '',
      o.name,
      o.type,
      o.scope === 'external' ? 'true' : 'false',
      o.tagOrder.map((tagId) => tagById.get(tagId)?.value ?? tagId).join('; '),
      technologyNames(o),
      ownerNames(o),
    ]
  }
  const rows = bundle.connections.map((c) => [
    c.id,
    ...endpoint(c.fromId),
    c.label ?? '',
    c.status ?? 'live',
    'Outgoing',
    tagValues(c),
    technologyNames(c),
    ownerNames(c),
    c.description ?? '',
    ...endpoint(c.toId),
  ])
  return toCsv(CONNECTIONS_CSV_HEADER, rows)
}
