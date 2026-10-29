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
 * MapleSpire facts Structurizr has no field for, in BOTH directions.
 *
 * The exporters (DSL and workspace JSON) write them as `properties` — the one
 * channel the format offers for facts it does not model, visible in
 * Structurizr's own UI — and the importers (DSL and JSON) read them back into
 * the real fields. The keys, the encoding and the decoding live together here
 * because a key written by one side and read by the other is a contract no
 * type checker sees: the exporter re-derives these keys from the live fields
 * and strips any stale copy, so an importer that left them as plain properties
 * lost them on the next export (export → import → export dropped status and
 * owners).
 *
 * This module sits on the import side of the dependency graph (the exporter
 * already depends on the importers, not the reverse), so the export modules
 * re-export the keys from here.
 */

import type { C4Object, OwnerAssignment, TechnologyUsage } from '../../types'
import { orderedTechnologyUsages, type SeededTechnologySpec } from '../technologyUsage'
import { parseTechnologies, type TechnologySpec } from './conventions'

export const DOMAIN_PROPERTY = 'maplespire.domain'
export const DOMAIN_ID_PROPERTY = 'maplespire.domainId'
export const STATUS_PROPERTY = 'maplespire.status'
export const OWNER_TEAMS_PROPERTY = 'maplespire.ownerTeamIds'
export const TEAMS_PROPERTY = 'maplespire.teamIds'
export const OWNERS_PROPERTY = 'maplespire.owners'
export const EXTRA_LINKS_PROPERTY = 'maplespire.links'
export const CONNECTION_KIND_PROPERTY = 'maplespire.connectionKind'
export const SKIN_PROPERTY = 'maplespire.skinId'
/** The compact on-shape summary, when the Markdown `description` went out as
 *  the wire description and the two differ. */
export const SHORT_DESCRIPTION_PROPERTY = 'maplespire.shortDescription'
/** A connection's Markdown documentation. Its wire `description` is the label. */
export const CONNECTION_DESCRIPTION_PROPERTY = 'maplespire.description'
/** `maplespire.technology.<name>.notes` / `.version`. */
export const TECHNOLOGY_PROPERTY_PREFIX = 'maplespire.technology.'
/**
 * On a connection a Structurizr DSL dynamic view needed but no author wrote —
 * the IMPLIED relationship between two containers whose children are related
 * (`complaintSLAFlow -> inspecteur` implies `powerAutomate -> inspecteur`).
 * Structurizr derives those itself, so the DSL exporter does not write them:
 * an explicit line would turn a derivation into an authored relationship and
 * draw it on every structural view of the next import.
 */
export const IMPLIED_RELATIONSHIP_PROPERTY = 'structurizr.implied'

/**
 * Keys the exporters DERIVE from a live field on every run. A copy of one read
 * back off a previous export is stale by construction, so the exporters drop
 * them from `properties` exactly as they drop the import's own stamps.
 */
export const MAPLESPIRE_DERIVED_PROPERTY_KEYS: readonly string[] = [
  DOMAIN_PROPERTY,
  DOMAIN_ID_PROPERTY,
  STATUS_PROPERTY,
  OWNER_TEAMS_PROPERTY,
  TEAMS_PROPERTY,
  OWNERS_PROPERTY,
  EXTRA_LINKS_PROPERTY,
  CONNECTION_KIND_PROPERTY,
  SKIN_PROPERTY,
  SHORT_DESCRIPTION_PROPERTY,
  CONNECTION_DESCRIPTION_PROPERTY,
]

/** Also derived: every per-technology key. */
export function isDerivedMapleSpireKey(key: string): boolean {
  return MAPLESPIRE_DERIVED_PROPERTY_KEYS.includes(key) || key.startsWith(TECHNOLOGY_PROPERTY_PREFIX)
}

// ── export side ──────────────────────────────────────────────────────────────

type TechnologyBearing = {
  technologyUsages?: Record<string, TechnologyUsage>
  technologyUsageOrder?: string[]
}

/** `name version` — the form Structurizr authors write (`"Node.js 20"`). */
function technologyLabel(usage: TechnologyUsage): string {
  const version = usage.usedVersion?.trim()
  return version ? `${usage.snapshot.name} ${version}` : usage.snapshot.name
}

/** The wire `technology` string, versions included. */
export function technologyStringOf(entity: TechnologyBearing): string | undefined {
  const joined = orderedTechnologyUsages(entity.technologyUsages, entity.technologyUsageOrder)
    .map(technologyLabel)
    .join(', ')
    .trim()
  return joined || undefined
}

/**
 * What the technology string cannot say: a usage's notes, and its version when
 * re-parsing `name version` would not give the version back (`Dynamics 365`
 * reads as a product name, so a version `365` on "Dynamics" is stated here).
 */
export function technologyDetailProperties(entity: TechnologyBearing): Record<string, string> {
  const out: Record<string, string> = {}
  for (const usage of orderedTechnologyUsages(entity.technologyUsages, entity.technologyUsageOrder)) {
    const name = usage.snapshot.name
    const notes = usage.notes?.trim()
    if (notes) out[`${TECHNOLOGY_PROPERTY_PREFIX}${name}.notes`] = notes
    const version = usage.usedVersion?.trim()
    if (version) {
      const [reparsed] = parseTechnologies(technologyLabel(usage))
      if (reparsed?.name !== name || reparsed.version !== version) {
        out[`${TECHNOLOGY_PROPERTY_PREFIX}${name}.version`] = version
      }
    }
  }
  return out
}

/** Owner names, in order. */
export function ownerNamesOf(entity: Pick<C4Object, 'ownerAssignments' | 'ownerAssignmentOrder'>): string[] {
  return (entity.ownerAssignmentOrder ?? [])
    .map((key) => entity.ownerAssignments?.[key]?.name?.trim())
    .filter((name): name is string => Boolean(name))
}

/**
 * The `maplespire.owners` value: a JSON array of names (`["Payments, Core","Alice"]`).
 *
 * Any separator is also a legal character inside a name, and guessing the
 * separator from the content split a lone "Payments, Core" into two owners
 * (reviewer lens, 2026-10-21). JSON is unambiguous and still readable in
 * Structurizr's properties table.
 */
export function encodeOwners(names: readonly string[]): string {
  return JSON.stringify(names)
}

/** The inverse of `encodeOwners`; also reads the comma-joined form older
 *  exports wrote, which is the best that form allows. */
export function decodeOwners(value: string): string[] {
  const trimmed = value.trim()
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed.filter((name): name is string => typeof name === 'string').map((n) => n.trim()).filter(Boolean)
      }
    } catch {
      // Not our JSON: a name that happens to start with `[`. Fall through.
    }
  }
  return trimmed.split(',').map((name) => name.trim()).filter(Boolean)
}

// ── import side ──────────────────────────────────────────────────────────────

const STATUSES = new Set(['live', 'draft', 'down', 'unstable'])

export interface RevivedFacts {
  /** The properties with every revived key removed. */
  properties: Record<string, string>
  status?: 'live' | 'draft' | 'down' | 'unstable'
  shortDescription?: string
  description?: string
  owners: string[]
  extraLinks: string[]
  /** Per technology name. */
  technologies: Map<string, { version?: string; notes?: string }>
}

export function reviveMapleSpireFacts(properties: Readonly<Record<string, string>>): RevivedFacts {
  const out: RevivedFacts = { properties: {}, owners: [], extraLinks: [], technologies: new Map() }
  for (const [key, raw] of Object.entries(properties)) {
    const value = raw.trim()
    if (key === STATUS_PROPERTY && STATUSES.has(value)) {
      out.status = value as RevivedFacts['status']
    } else if (key === SHORT_DESCRIPTION_PROPERTY && value) {
      out.shortDescription = value
    } else if (key === CONNECTION_DESCRIPTION_PROPERTY && value) {
      out.description = value
    } else if (key === OWNERS_PROPERTY) {
      out.owners = decodeOwners(value)
    } else if (key === EXTRA_LINKS_PROPERTY) {
      out.extraLinks = value.split(/\s+/).filter(Boolean)
    } else if (key.startsWith(TECHNOLOGY_PROPERTY_PREFIX) && /\.(notes|version)$/.test(key)) {
      const rest = key.slice(TECHNOLOGY_PROPERTY_PREFIX.length)
      const field = rest.endsWith('.notes') ? 'notes' : 'version'
      const name = rest.slice(0, -(field.length + 1))
      const entry = out.technologies.get(name) ?? {}
      entry[field] = value
      out.technologies.set(name, entry)
    } else {
      out.properties[key] = raw
    }
  }
  return out
}

/** Parsed technologies, with the per-technology properties applied. */
export function withTechnologyDetails(
  specs: readonly TechnologySpec[],
  details: RevivedFacts['technologies'],
): SeededTechnologySpec[] {
  return specs.map((parsed) => {
    // A `.version` property exists exactly when the string did not parse back
    // (`Dynamics 365` read as one product name), so it also says where to split.
    let spec = parsed
    if (!details.has(spec.name)) {
      for (const [name, detail] of details) {
        if (detail.version && spec.name === `${name} ${detail.version}`) spec = { name, version: detail.version }
      }
    }
    const detail = details.get(spec.name)
    const usedVersion = detail?.version ?? spec.version
    return {
      name: spec.name,
      ...(usedVersion ? { usedVersion } : {}),
      ...(detail?.notes ? { notes: detail.notes } : {}),
    }
  })
}

/**
 * Owners read back from a file are names only, so they land as external
 * contacts: the file cannot say which organisation team or platform user a
 * name was, and guessing would attach a stranger's team to the shape.
 * Deterministic ids keep a re-import idempotent.
 */
export function ownerFields(
  names: readonly string[],
): Pick<C4Object, 'ownerAssignments' | 'ownerAssignmentOrder'> | Record<string, never> {
  if (names.length === 0) return {}
  const assignments: Record<string, OwnerAssignment> = {}
  const order: string[] = []
  names.forEach((name, index) => {
    const id = `contact:import-${index}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    assignments[id] = { id, kind: 'person', source: 'external', name }
    order.push(id)
  })
  return { ownerAssignments: assignments, ownerAssignmentOrder: order }
}
