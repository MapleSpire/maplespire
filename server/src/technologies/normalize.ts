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

import {
  TECHNOLOGY_ROLES,
  TECHNOLOGY_SHAPE_TYPES,
  type TechnologyRevisionInput,
  type TechnologyRole,
  type TechnologyShapeType,
} from './types.js'
import { ICON_CATALOG, RETIRED_ICON_PATHS } from '../ai/core/tools/iconCatalog.gen.js'

const MAX_NAME = 160
const MAX_TEXT = 10_000
const MAX_SHORT_TEXT = 240
const MAX_ALIASES = 50
// A re-artworked entry's previous paths stay accepted: revisions, private
// technologies and drafts saved before the change still carry them, and
// refusing them would make any later edit of those records a 400.
const PUBLIC_ICON_PATHS = new Set([
  ...ICON_CATALOG.flatMap((icon) => [icon.iconLight, icon.iconDark]).filter((path): path is string => Boolean(path)),
  ...RETIRED_ICON_PATHS,
])

/** Stable, locale-independent identity key used by deterministic duplicate search. */
export function normalizeTechnologyTerm(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new TechnologyInputError(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new TechnologyInputError(`${field} is too long`)
  return trimmed || null
}

function optionalUrl(value: unknown, field: string): string | null {
  const text = optionalString(value, field, 2_048)
  if (!text) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new TechnologyInputError(`${field} must be a valid URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TechnologyInputError(`${field} must use http or https`)
  }
  return url.toString()
}

function optionalAssetPath(value: unknown, field: string): string | null {
  const path = optionalString(value, field, 1_024)
  if (!path) return null
  // Catalog records only reference immutable, content-addressed assets. They
  // never store icon binaries and never accept active/data URL payloads.
  const governedAsset = /^\/assets\/technologies\/[a-f0-9]{64}\.(?:svg|png)$/.test(path)
  if (!governedAsset && !PUBLIC_ICON_PATHS.has(path)) {
    throw new TechnologyInputError(`${field} must reference an immutable governed or public catalog icon`)
  }
  return path
}

function recommendedShapeTypes(value: unknown): TechnologyShapeType[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > TECHNOLOGY_SHAPE_TYPES.length) {
    throw new TechnologyInputError(
      `recommendedShapeTypes must contain between 1 and ${TECHNOLOGY_SHAPE_TYPES.length} values`
    )
  }
  const selected = new Set<TechnologyShapeType>()
  for (const shapeType of value) {
    if (typeof shapeType !== 'string' || !TECHNOLOGY_SHAPE_TYPES.includes(shapeType as TechnologyShapeType)) {
      throw new TechnologyInputError(
        `recommendedShapeTypes values must be one of: ${TECHNOLOGY_SHAPE_TYPES.join(', ')}`
      )
    }
    selected.add(shapeType as TechnologyShapeType)
  }
  // Store and return one canonical ordering so revision JSON and audit diffs
  // remain stable regardless of checkbox interaction order in the client.
  return TECHNOLOGY_SHAPE_TYPES.filter((shapeType) => selected.has(shapeType))
}

function requiredDefaultRole(value: unknown): TechnologyRole {
  if (typeof value !== 'string' || !TECHNOLOGY_ROLES.includes(value as TechnologyRole)) {
    throw new TechnologyInputError(`defaultRole must be one of: ${TECHNOLOGY_ROLES.join(', ')}`)
  }
  return value as TechnologyRole
}

export class TechnologyInputError extends Error {
  readonly status = 400
}

export function validateTechnologyRevisionInput(raw: unknown): TechnologyRevisionInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TechnologyInputError('body must be an object')
  const input = raw as Record<string, unknown>
  const name = optionalString(input.name, 'name', MAX_NAME)
  if (!name) throw new TechnologyInputError('name is required')
  const normalizedName = normalizeTechnologyTerm(name)
  if (!normalizedName) throw new TechnologyInputError('name must contain searchable characters')

  const aliasesRaw = input.aliases ?? []
  if (!Array.isArray(aliasesRaw) || aliasesRaw.length > MAX_ALIASES) {
    throw new TechnologyInputError(`aliases must contain at most ${MAX_ALIASES} values`)
  }
  const aliases = [...new Set(aliasesRaw.map((v) => {
    const alias = optionalString(v, 'alias', MAX_NAME)
    if (!alias) throw new TechnologyInputError('aliases cannot be empty')
    return alias
  }))]

  return {
    name,
    description: optionalString(input.description, 'description', MAX_TEXT),
    websiteUrl: optionalUrl(input.websiteUrl, 'websiteUrl'),
    documentationUrl: optionalUrl(input.documentationUrl, 'documentationUrl'),
    aliases,
    category: optionalString(input.category, 'category', MAX_SHORT_TEXT),
    iconLightPath: optionalAssetPath(input.iconLightPath, 'iconLightPath'),
    iconDarkPath: optionalAssetPath(input.iconDarkPath, 'iconDarkPath'),
    publisher: optionalString(input.publisher, 'publisher', MAX_SHORT_TEXT),
    ecosystem: optionalString(input.ecosystem, 'ecosystem', MAX_SHORT_TEXT),
    recommendedShapeTypes: recommendedShapeTypes(input.recommendedShapeTypes),
    defaultRole: requiredDefaultRole(input.defaultRole),
  }
}

export function searchDocument(input: TechnologyRevisionInput): {
  normalizedName: string
  normalizedAliases: string[]
  searchText: string
} {
  const normalizedName = normalizeTechnologyTerm(input.name)
  const normalizedAliases = (input.aliases ?? []).map(normalizeTechnologyTerm).filter(Boolean)
  const searchText = [
    normalizedName,
    ...normalizedAliases,
    normalizeTechnologyTerm(input.publisher ?? ''),
    normalizeTechnologyTerm(input.ecosystem ?? ''),
    normalizeTechnologyTerm(input.websiteUrl ?? ''),
  ].filter(Boolean).join(' ')
  return { normalizedName, normalizedAliases, searchText }
}
