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

import type {
  C4Object,
  ShapeIconAssignment,
  ShapeType,
  TechnologyRole,
  TechnologyShapeType,
  TechnologyUsage,
} from '../types'

/** Public demo-catalog ids are shared with server/src/technologies/seed.ts. */
const SEEDED_TECHNOLOGY_IDS: Record<string, string> = {
  React: 'tech_seed_react',
  'Node.js': 'tech_seed_nodejs',
  PostgreSQL: 'tech_seed_postgresql',
  Redis: 'tech_seed_redis',
  MongoDB: 'tech_seed_mongodb',
  Kotlin: 'tech_seed_kotlin',
  Kafka: 'tech_seed_kafka',
  'Apache Kafka': 'tech_seed_kafka',
  Angular: 'tech_seed_angular',
  NestJS: 'tech_seed_nestjs',
  '.NET': 'tech_seed_dotnet',
  'C#': 'tech_seed_csharp',
  'C++': 'tech_seed_cpp',
  'Azure Blob': 'tech_seed_azure_blob',
  'Azure Functions': 'tech_seed_azure_functions',
  'Azure SQL': 'tech_seed_azure_sql',
  'Blob Store': 'tech_seed_blob_store',
  Cassandra: 'tech_seed_cassandra',
  Docker: 'tech_seed_docker',
  DynamoDB: 'tech_seed_dynamodb',
  Elasticsearch: 'tech_seed_elasticsearch',
  Envoy: 'tech_seed_envoy',
  Erlang: 'tech_seed_erlang',
  Flink: 'tech_seed_flink',
  Go: 'tech_seed_go',
  Grafana: 'tech_seed_grafana',
  GraphQL: 'tech_seed_graphql',
  gRPC: 'tech_seed_grpc',
  Hack: 'tech_seed_hack',
  Java: 'tech_seed_java',
  Memcached: 'tech_seed_memcached',
  MySQL: 'tech_seed_mysql',
  nginx: 'tech_seed_nginx',
  'Power Platform': 'tech_seed_power_platform',
  Prometheus: 'tech_seed_prometheus',
  Python: 'tech_seed_python',
  RabbitMQ: 'tech_seed_rabbitmq',
  REST: 'tech_seed_rest',
  Ruby: 'tech_seed_ruby',
  Rust: 'tech_seed_rust',
  S3: 'tech_seed_s3',
  Scala: 'tech_seed_scala',
  Spark: 'tech_seed_spark',
  Swift: 'tech_seed_swift',
  Terraform: 'tech_seed_terraform',
  TypeScript: 'tech_seed_typescript',
  Vue: 'tech_seed_vue',
  Xamarin: 'tech_seed_xamarin',
}

/** Must match server/src/technologies/seed.ts. Revision 2 adds governed shape
 * recommendations and default roles; fresh usages must never point at rev1. */
export const SEEDED_TECHNOLOGY_CATALOG_REVISION = 2

interface SeededTechnologyMetadata {
  recommendedShapeTypes: readonly TechnologyShapeType[]
  defaultRole: TechnologyRole
}

/** Mirrors server/src/technologies/seed.ts. This deliberate client copy keeps
 * development/import fixtures self-contained and complete before catalog
 * hydration; tests pin the governed metadata on every public starter entry. */
const SEEDED_TECHNOLOGY_METADATA: Record<string, SeededTechnologyMetadata> = {
  '.NET': { recommendedShapeTypes: ['app', 'component'], defaultRole: 'framework' },
  Angular: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'framework' },
  'Apache Kafka': { recommendedShapeTypes: ['store'], defaultRole: 'messaging' },
  Kafka: { recommendedShapeTypes: ['store'], defaultRole: 'messaging' },
  'Azure Blob': { recommendedShapeTypes: ['store'], defaultRole: 'storage' },
  'Azure Functions': { recommendedShapeTypes: ['app', 'component'], defaultRole: 'platform' },
  'Azure SQL': { recommendedShapeTypes: ['store'], defaultRole: 'database' },
  'Blob Store': { recommendedShapeTypes: ['store'], defaultRole: 'storage' },
  'C#': { recommendedShapeTypes: ['app', 'component'], defaultRole: 'language' },
  'C++': { recommendedShapeTypes: ['app', 'component'], defaultRole: 'language' },
  Cassandra: { recommendedShapeTypes: ['store'], defaultRole: 'database' },
  Docker: { recommendedShapeTypes: ['app', 'component', 'group'], defaultRole: 'infrastructure' },
  DynamoDB: { recommendedShapeTypes: ['store'], defaultRole: 'database' },
  Elasticsearch: { recommendedShapeTypes: ['store'], defaultRole: 'database' },
  Envoy: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'infrastructure' },
  Erlang: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'language' },
  Flink: { recommendedShapeTypes: ['app'], defaultRole: 'platform' },
  Go: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'language' },
  Grafana: { recommendedShapeTypes: ['system', 'app'], defaultRole: 'tooling' },
  GraphQL: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'protocol' },
  gRPC: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'protocol' },
  Hack: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'language' },
  Java: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'language' },
  Kotlin: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'language' },
  Memcached: { recommendedShapeTypes: ['store'], defaultRole: 'database' },
  MongoDB: { recommendedShapeTypes: ['store'], defaultRole: 'database' },
  MySQL: { recommendedShapeTypes: ['store'], defaultRole: 'database' },
  NestJS: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'framework' },
  nginx: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'infrastructure' },
  'Node.js': { recommendedShapeTypes: ['app', 'component'], defaultRole: 'runtime' },
  PostgreSQL: { recommendedShapeTypes: ['store'], defaultRole: 'database' },
  'Power Platform': { recommendedShapeTypes: ['system', 'app'], defaultRole: 'platform' },
  Prometheus: { recommendedShapeTypes: ['system', 'app'], defaultRole: 'tooling' },
  Python: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'language' },
  RabbitMQ: { recommendedShapeTypes: ['store'], defaultRole: 'messaging' },
  React: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'framework' },
  Redis: { recommendedShapeTypes: ['store'], defaultRole: 'database' },
  REST: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'protocol' },
  Ruby: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'language' },
  Rust: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'language' },
  S3: { recommendedShapeTypes: ['store'], defaultRole: 'storage' },
  Scala: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'language' },
  Spark: { recommendedShapeTypes: ['app'], defaultRole: 'platform' },
  Swift: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'language' },
  Terraform: { recommendedShapeTypes: ['system', 'app', 'group'], defaultRole: 'infrastructure' },
  TypeScript: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'language' },
  Vue: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'framework' },
  Xamarin: { recommendedShapeTypes: ['app', 'component'], defaultRole: 'framework' },
}

const UNKNOWN_SEEDED_TECHNOLOGY_METADATA: SeededTechnologyMetadata = {
  recommendedShapeTypes: ['system', 'app', 'store', 'component', 'group'],
  defaultRole: 'other',
}

export function seededTechnologyMetadata(name: string): SeededTechnologyMetadata {
  return SEEDED_TECHNOLOGY_METADATA[name] ?? UNKNOWN_SEEDED_TECHNOLOGY_METADATA
}

const SEEDED_NAMES_LOWER = new Set(Object.keys(SEEDED_TECHNOLOGY_IDS).map((name) => name.toLowerCase()))

/** Whether the public starter catalog knows this technology name. */
export function isSeededTechnologyName(name: string): boolean {
  return SEEDED_NAMES_LOWER.has(name.trim().toLowerCase())
}

export function seededTechnologyId(name: string): string {
  const seeded = SEEDED_TECHNOLOGY_IDS[name]
  if (seeded) return seeded
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `tech_seed_${slug}`
}

export interface TechnologyUsageInput {
  id: string
  name: string
  technologyId?: string
  catalogRevision?: number
  usedVersion?: string
  role?: TechnologyRole
  defaultRole?: TechnologyRole
  notes?: string
  iconLightPath?: string
  iconDarkPath?: string
  recommendedShapeTypes?: readonly TechnologyShapeType[]
}

export function createTechnologyUsage(input: TechnologyUsageInput): TechnologyUsage {
  const role = input.role ?? input.defaultRole
  return {
    id: input.id,
    technologyId: input.technologyId ?? seededTechnologyId(input.name),
    catalogRevision: input.catalogRevision ?? SEEDED_TECHNOLOGY_CATALOG_REVISION,
    ...(input.usedVersion ? { usedVersion: input.usedVersion } : {}),
    ...(role ? { role } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    snapshot: {
      schemaVersion: 1,
      name: input.name,
      ...(input.iconLightPath ? { iconLightPath: input.iconLightPath } : {}),
      ...(input.iconDarkPath ? { iconDarkPath: input.iconDarkPath } : {}),
      ...(input.recommendedShapeTypes
        ? { recommendedShapeTypes: [...input.recommendedShapeTypes] }
        : {}),
      ...(input.defaultRole ? { defaultRole: input.defaultRole } : {}),
    },
  }
}

/** Empty/absent guidance is treated as unknown rather than incompatible. This
 * keeps legacy/imported snapshots usable while every governed catalog revision
 * is required to provide at least one recommendation. */
export function isTechnologyRecommendedForShape(
  recommendedShapeTypes: readonly TechnologyShapeType[] | undefined,
  shapeType: ShapeType,
): boolean {
  return !recommendedShapeTypes?.length
    || recommendedShapeTypes.includes(shapeType as TechnologyShapeType)
}

export function canAssignTechnologyToShape(
  shapeType: ShapeType,
): shapeType is TechnologyShapeType {
  return shapeType !== 'actor'
}

/** Keep per-object metadata when changing catalog identity, but only carry a
 * role forward when it was actually customized. A role equal to the previous
 * catalog default yields to the replacement technology's new default. */
export function replaceTechnologyUsage(
  previous: TechnologyUsage | undefined,
  replacement: TechnologyUsage,
): TechnologyUsage {
  if (!previous) return replacement
  const previousRoleWasOverridden = previous.role !== undefined
    && previous.role !== previous.snapshot.defaultRole
  return {
    ...replacement,
    ...(previous.usedVersion ? { usedVersion: previous.usedVersion } : {}),
    ...(previousRoleWasOverridden ? { role: previous.role } : {}),
    ...(previous.notes ? { notes: previous.notes } : {}),
  }
}

export interface TechnologyBearingState {
  technologyUsages?: Record<string, TechnologyUsage>
  technologyUsageOrder?: string[]
  icon?: string
  iconAssignment?: ShapeIconAssignment
}

export interface TechnologyBearingResult extends TechnologyBearingState {
  technologyUsages: Record<string, TechnologyUsage>
  technologyUsageOrder: string[]
}

/** Resolve a complete, duplicate-free order without alphabetically sorting the
 * map. Missing ids are appended once so the next edit can persist a clean
 * explicit order in Automerge. */
export function orderedTechnologyUsageIds(
  usages: Record<string, TechnologyUsage> | undefined,
  order: readonly string[] | undefined,
): string[] {
  const source = usages ?? {}
  const seen = new Set<string>()
  const ids: string[] = []
  for (const id of order ?? []) {
    if (!source[id] || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  for (const id of Object.keys(source)) {
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

export function orderedTechnologyUsages(
  usages: Record<string, TechnologyUsage> | undefined,
  order: readonly string[] | undefined,
): TechnologyUsage[] {
  const source = usages ?? {}
  return orderedTechnologyUsageIds(source, order).map((id) => source[id])
}

/** Move one usage to the target row's position. Moving down lands after the
 * target; moving up lands before it, matching direct-manipulation lists. */
export function reorderTechnologyUsage(
  usages: Record<string, TechnologyUsage> | undefined,
  order: readonly string[] | undefined,
  sourceId: string,
  targetId: string,
): string[] {
  const ids = orderedTechnologyUsageIds(usages, order)
  const sourceIndex = ids.indexOf(sourceId)
  const targetIndex = ids.indexOf(targetId)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return ids
  ids.splice(sourceIndex, 1)
  ids.splice(Math.min(targetIndex, ids.length), 0, sourceId)
  return ids
}

export function moveTechnologyUsage(
  usages: Record<string, TechnologyUsage> | undefined,
  order: readonly string[] | undefined,
  usageId: string,
  direction: -1 | 1,
): string[] {
  const ids = orderedTechnologyUsageIds(usages, order)
  const index = ids.indexOf(usageId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= ids.length) return ids
  ;[ids[index], ids[target]] = [ids[target], ids[index]]
  return ids
}

export function technologyIconAssignment(
  usage: TechnologyUsage,
  mode: ShapeIconAssignment['mode'],
): ShapeIconAssignment {
  return {
    source: 'technology',
    mode,
    displayName: usage.snapshot.name,
    technologyUsageId: usage.id,
    catalogRevision: usage.catalogRevision,
    ...(usage.snapshot.iconLightPath ? { iconLightPath: usage.snapshot.iconLightPath } : {}),
    ...(usage.snapshot.iconDarkPath ? { iconDarkPath: usage.snapshot.iconDarkPath } : {}),
  }
}

export function genericIconAssignment(input: {
  name: string
  iconLightPath?: string
  iconDarkPath?: string
}): ShapeIconAssignment {
  return {
    source: 'generic',
    mode: 'explicit',
    displayName: input.name,
    ...(input.iconLightPath ? { iconLightPath: input.iconLightPath } : {}),
    ...(input.iconDarkPath ? { iconDarkPath: input.iconDarkPath } : {}),
  }
}

/** Add or replace a governed usage. Duplicate technology identities reuse the
 * existing usage. The first technology supplies an automatic shape icon only
 * when the shape does not already have one. */
export function assignTechnologyUsage(
  state: TechnologyBearingState,
  incoming: TechnologyUsage,
  options: { replaceUsageId?: string | null } = {},
): TechnologyBearingResult & { selectedUsage: TechnologyUsage; added: boolean } {
  const usages = { ...(state.technologyUsages ?? {}) }
  const order = orderedTechnologyUsageIds(usages, state.technologyUsageOrder)
  const replaceUsageId = options.replaceUsageId ?? null
  const duplicate = Object.values(usages).find((usage) => (
    usage.technologyId === incoming.technologyId && usage.id !== replaceUsageId
  ))

  let selectedUsage = duplicate
  let added = false
  let nextOrder = [...order]
  let replacedUsage: TechnologyUsage | undefined
  if (replaceUsageId && usages[replaceUsageId]) {
    replacedUsage = usages[replaceUsageId]
    const replacementIndex = nextOrder.indexOf(replaceUsageId)
    delete usages[replaceUsageId]
    nextOrder = nextOrder.filter((id) => id !== replaceUsageId)
    if (!duplicate) {
      selectedUsage = replaceTechnologyUsage(replacedUsage, incoming)
      usages[selectedUsage.id] = selectedUsage
      nextOrder.splice(replacementIndex < 0 ? nextOrder.length : replacementIndex, 0, selectedUsage.id)
      added = true
    }
  }
  if (!selectedUsage) {
    selectedUsage = incoming
    usages[incoming.id] = incoming
    nextOrder.push(incoming.id)
    added = true
  }

  let icon = state.icon
  let iconAssignment = state.iconAssignment
  const replacedIconSource = replacedUsage && iconAssignment?.source === 'technology'
    && iconAssignment.technologyUsageId === replacedUsage.id
  if (replacedIconSource) {
    icon = selectedUsage.snapshot.name
    iconAssignment = technologyIconAssignment(selectedUsage, iconAssignment!.mode)
  } else if (!icon && !iconAssignment) {
    icon = selectedUsage.snapshot.name
    iconAssignment = technologyIconAssignment(selectedUsage, 'automatic')
  }

  return {
    technologyUsages: usages,
    technologyUsageOrder: orderedTechnologyUsageIds(usages, nextOrder),
    ...(icon ? { icon } : {}),
    ...(iconAssignment ? { iconAssignment } : {}),
    selectedUsage,
    added,
  }
}

/** Add several governed usages in one pass.
 *
 * The picker can now stage a whole basket before committing, and the caller
 * writes the result back with a single `updateObject`/`updateGroup`. Calling
 * `assignTechnologyUsage` once per staged item from the caller would not work:
 * every call would read the same entity captured in the render closure, so each
 * whole-map write would clobber the one before it and only the last technology
 * would survive. Folding here keeps every rule — duplicate collapsing, order,
 * and the automatic shape icon being taken once from the first item that
 * supplies one — in the module that already owns them.
 *
 * `replaceUsageId` applies to the first item only: replacing is a swap of one
 * usage, and anything staged after it is an addition. */
export function assignTechnologyUsages(
  state: TechnologyBearingState,
  incoming: readonly TechnologyUsage[],
  options: { replaceUsageId?: string | null } = {},
): TechnologyBearingResult & { selectedUsages: TechnologyUsage[]; addedCount: number } {
  const selectedUsages: TechnologyUsage[] = []
  let addedCount = 0
  let next: TechnologyBearingResult = {
    technologyUsages: { ...(state.technologyUsages ?? {}) },
    technologyUsageOrder: orderedTechnologyUsageIds(
      state.technologyUsages ?? {},
      state.technologyUsageOrder,
    ),
    ...(state.icon ? { icon: state.icon } : {}),
    ...(state.iconAssignment ? { iconAssignment: state.iconAssignment } : {}),
  }

  incoming.forEach((usage, index) => {
    const step = assignTechnologyUsage(next, usage, {
      replaceUsageId: index === 0 ? options.replaceUsageId ?? null : null,
    })
    selectedUsages.push(step.selectedUsage)
    if (step.added) addedCount += 1
    next = {
      technologyUsages: step.technologyUsages,
      technologyUsageOrder: step.technologyUsageOrder,
      ...(step.icon ? { icon: step.icon } : {}),
      ...(step.iconAssignment ? { iconAssignment: step.iconAssignment } : {}),
    }
  })

  return { ...next, selectedUsages, addedCount }
}

/** Explicitly choosing a governed technology as the shape icon reuses its
 * existing usage or creates one, then pins provenance to that stable usage id. */
export function selectTechnologyAsIcon(
  state: TechnologyBearingState,
  incoming: TechnologyUsage,
): TechnologyBearingResult & { selectedUsage: TechnologyUsage; added: boolean } {
  const assigned = assignTechnologyUsage(state, incoming)
  return {
    ...assigned,
    icon: assigned.selectedUsage.snapshot.name,
    iconAssignment: technologyIconAssignment(assigned.selectedUsage, 'explicit'),
  }
}

export function selectGenericShapeIcon(
  state: TechnologyBearingState,
  input: { name: string; iconLightPath?: string; iconDarkPath?: string },
): TechnologyBearingResult {
  return {
    technologyUsages: { ...(state.technologyUsages ?? {}) },
    technologyUsageOrder: orderedTechnologyUsageIds(state.technologyUsages, state.technologyUsageOrder),
    icon: input.name,
    iconAssignment: genericIconAssignment(input),
  }
}

export function explicitTechnologyIconDependsOnUsage(
  state: TechnologyBearingState,
  usageId: string,
): boolean {
  return state.iconAssignment?.source === 'technology'
    && state.iconAssignment.mode === 'explicit'
    && state.iconAssignment.technologyUsageId === usageId
}

/** Remove a usage without coupling icon behavior to map order. Explicit icon
 * sources are blocked until the caller confirms; automatic sources move to the
 * first remaining governed usage. */
export function removeTechnologyUsage(
  state: TechnologyBearingState,
  usageId: string,
  options: { allowExplicitIconRemoval?: boolean } = {},
): (TechnologyBearingResult & { blocked: false }) | ({ blocked: true } & TechnologyBearingState) {
  if (explicitTechnologyIconDependsOnUsage(state, usageId) && !options.allowExplicitIconRemoval) {
    return { ...state, blocked: true }
  }
  const usages = { ...(state.technologyUsages ?? {}) }
  delete usages[usageId]
  const order = orderedTechnologyUsageIds(usages, state.technologyUsageOrder?.filter((id) => id !== usageId))
  let icon = state.icon
  let iconAssignment = state.iconAssignment
  if (iconAssignment?.source === 'technology' && iconAssignment.technologyUsageId === usageId) {
    if (iconAssignment.mode === 'automatic' && order.length > 0) {
      const fallback = usages[order[0]]
      icon = fallback.snapshot.name
      iconAssignment = technologyIconAssignment(fallback, 'automatic')
    } else {
      icon = undefined
      iconAssignment = undefined
    }
  }
  return {
    blocked: false,
    technologyUsages: usages,
    technologyUsageOrder: order,
    ...(icon ? { icon } : {}),
    ...(iconAssignment ? { iconAssignment } : {}),
  }
}

/** Deterministic usages for fixtures, imports and development seeds. */
/** A technology to seed, optionally with the per-usage facts an import carries. */
export interface SeededTechnologySpec {
  name: string
  usedVersion?: string
  notes?: string
}

export function seededTechnologyUsages(
  ownerId: string,
  names: readonly (string | SeededTechnologySpec)[],
  role?: TechnologyRole,
): Record<string, TechnologyUsage> {
  return Object.fromEntries(names.map((entry, index) => {
    const spec = typeof entry === 'string' ? { name: entry } : entry
    const name = spec.name
    const id = `tu_${ownerId}_${index}_${seededTechnologyId(name).slice('tech_seed_'.length)}`
    const metadata = seededTechnologyMetadata(name)
    return [id, createTechnologyUsage({
      id,
      name,
      role,
      ...metadata,
      ...(spec.usedVersion ? { usedVersion: spec.usedVersion } : {}),
      ...(spec.notes ? { notes: spec.notes } : {}),
    })]
  }))
}

export function technologyUsagesOf(
  object: Pick<C4Object, 'technologyUsages' | 'technologyUsageOrder'>,
): TechnologyUsage[] {
  return orderedTechnologyUsages(object.technologyUsages, object.technologyUsageOrder)
}

export function technologyNamesOf(
  object: Pick<C4Object, 'technologyUsages' | 'technologyUsageOrder'>,
): string[] {
  return technologyUsagesOf(object).map((usage) => usage.snapshot.name)
}

/** Prevent in-place identity/revision/snapshot edits on an existing usage id. */
export function assertTechnologyUsageIdentityPreserved(
  current: Record<string, TechnologyUsage> | undefined,
  next: Record<string, TechnologyUsage> | undefined,
): void {
  if (!current || !next) return
  for (const [id, previous] of Object.entries(current)) {
    const replacement = next[id]
    if (!replacement) continue
    const immutableChanged = previous.technologyId !== replacement.technologyId
      || previous.catalogRevision !== replacement.catalogRevision
      || previous.snapshot.schemaVersion !== replacement.snapshot.schemaVersion
      || previous.snapshot.name !== replacement.snapshot.name
      || previous.snapshot.iconLightPath !== replacement.snapshot.iconLightPath
      || previous.snapshot.iconDarkPath !== replacement.snapshot.iconDarkPath
      || previous.snapshot.defaultRole !== replacement.snapshot.defaultRole
      || (previous.snapshot.recommendedShapeTypes ?? []).join('\u0000')
        !== (replacement.snapshot.recommendedShapeTypes ?? []).join('\u0000')
    if (immutableChanged) {
      throw new Error(`Technology usage "${id}" identity is immutable; replace it with a new usage id.`)
    }
  }
}
