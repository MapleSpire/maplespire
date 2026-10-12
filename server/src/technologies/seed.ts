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

import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { ICON_CATALOG, type IconCatalogEntry } from '../ai/core/tools/iconCatalog.gen.js'
import { searchDocument } from './normalize.js'
import type {
  TechnologyRole,
  TechnologySeedDefinition,
  TechnologyShapeType,
} from './types.js'

const SEEDED_TECHNOLOGY_ID_VALUES = {
  React: 'tech_seed_react',
  'Node.js': 'tech_seed_nodejs',
  PostgreSQL: 'tech_seed_postgresql',
  Redis: 'tech_seed_redis',
  MongoDB: 'tech_seed_mongodb',
  Kotlin: 'tech_seed_kotlin',
  Kafka: 'tech_seed_kafka',
  Angular: 'tech_seed_angular',
  NestJS: 'tech_seed_nestjs',
  '.NET': 'tech_seed_dotnet',
  'Azure Blob': 'tech_seed_azure_blob',
  'Azure Functions': 'tech_seed_azure_functions',
  'Azure SQL': 'tech_seed_azure_sql',
  'Blob Store': 'tech_seed_blob_store',
  'C#': 'tech_seed_csharp',
  'C++': 'tech_seed_cpp',
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
} as const

type SeededTechnologyName = keyof typeof SEEDED_TECHNOLOGY_ID_VALUES
type SeedDefinitionName = Exclude<SeededTechnologyName, 'Kafka'> | 'Apache Kafka'

/** String index compatibility is intentional for server-side import/seed
 * adapters, while the private literal map above keeps this module exhaustive. */
export const SEEDED_TECHNOLOGY_IDS: Readonly<Record<string, string>> = Object.freeze(SEEDED_TECHNOLOGY_ID_VALUES)

/** Revision 1 predates governed recommendations/default roles. Revision 2 is
 * append-only so existing installations can adopt the richer seed safely. */
export const SEEDED_TECHNOLOGY_CATALOG_REVISION = 3

/** Recommendations are catalog governance, not shape restrictions. They drive
 * an advisory warning and can cover more than one kind of shape. PostgreSQL is
 * intentionally Store-only, matching the product requirement. */
const RECOMMENDED_SHAPES: Record<SeedDefinitionName, readonly TechnologyShapeType[]> = {
  '.NET': ['app', 'component'],
  Angular: ['app', 'component'],
  'Apache Kafka': ['store'],
  'Azure Blob': ['store'],
  'Azure Functions': ['app', 'component'],
  'Azure SQL': ['store'],
  'Blob Store': ['store'],
  'C#': ['app', 'component'],
  'C++': ['app', 'component'],
  Cassandra: ['store'],
  Docker: ['app', 'component', 'group'],
  DynamoDB: ['store'],
  Elasticsearch: ['store'],
  Envoy: ['app', 'component'],
  Erlang: ['app', 'component'],
  Flink: ['app'],
  Go: ['app', 'component'],
  Grafana: ['system', 'app'],
  GraphQL: ['app', 'component'],
  gRPC: ['app', 'component'],
  Hack: ['app', 'component'],
  Java: ['app', 'component'],
  Kotlin: ['app', 'component'],
  Memcached: ['store'],
  MongoDB: ['store'],
  MySQL: ['store'],
  NestJS: ['app', 'component'],
  nginx: ['app', 'component'],
  'Node.js': ['app', 'component'],
  PostgreSQL: ['store'],
  'Power Platform': ['system', 'app'],
  Prometheus: ['system', 'app'],
  Python: ['app', 'component'],
  RabbitMQ: ['store'],
  React: ['app', 'component'],
  Redis: ['store'],
  REST: ['app', 'component'],
  Ruby: ['app', 'component'],
  Rust: ['app', 'component'],
  S3: ['store'],
  Scala: ['app', 'component'],
  Spark: ['app'],
  Swift: ['app', 'component'],
  Terraform: ['system', 'app', 'group'],
  TypeScript: ['app', 'component'],
  Vue: ['app', 'component'],
  Xamarin: ['app', 'component'],
}

const DEFAULT_ROLES: Record<SeedDefinitionName, TechnologyRole> = {
  '.NET': 'framework',
  Angular: 'framework',
  'Apache Kafka': 'messaging',
  'Azure Blob': 'storage',
  'Azure Functions': 'platform',
  'Azure SQL': 'database',
  'Blob Store': 'storage',
  'C#': 'language',
  'C++': 'language',
  Cassandra: 'database',
  Docker: 'infrastructure',
  DynamoDB: 'database',
  Elasticsearch: 'database',
  Envoy: 'infrastructure',
  Erlang: 'language',
  Flink: 'platform',
  Go: 'language',
  Grafana: 'tooling',
  GraphQL: 'protocol',
  gRPC: 'protocol',
  Hack: 'language',
  Java: 'language',
  Kotlin: 'language',
  Memcached: 'database',
  MongoDB: 'database',
  MySQL: 'database',
  NestJS: 'framework',
  nginx: 'infrastructure',
  'Node.js': 'runtime',
  PostgreSQL: 'database',
  'Power Platform': 'platform',
  Prometheus: 'tooling',
  Python: 'language',
  RabbitMQ: 'messaging',
  React: 'framework',
  Redis: 'database',
  REST: 'protocol',
  Ruby: 'language',
  Rust: 'language',
  S3: 'storage',
  Scala: 'language',
  Spark: 'platform',
  Swift: 'language',
  Terraform: 'infrastructure',
  TypeScript: 'language',
  Vue: 'framework',
  Xamarin: 'framework',
}

export interface SeededTechnologyMetadata {
  recommendedShapeTypes: TechnologyShapeType[]
  defaultRole: TechnologyRole
  iconLightPath?: string
  iconDarkPath?: string
}

/** Shared by the central PostgreSQL seed and the Automerge demo seed so an
 * offline client sees the same advisory metadata before catalog hydration. */
export function seededTechnologyMetadata(name: string): SeededTechnologyMetadata | null {
  const definitionName = (name === 'Kafka' ? 'Apache Kafka' : name) as SeedDefinitionName
  const recommendedShapeTypes = RECOMMENDED_SHAPES[definitionName]
  const defaultRole = DEFAULT_ROLES[definitionName]
  if (!recommendedShapeTypes || !defaultRole) return null
  const icon = iconEntry(name)
  return {
    recommendedShapeTypes: [...recommendedShapeTypes],
    defaultRole,
    ...(icon?.iconLight ? { iconLightPath: icon.iconLight } : {}),
    ...(icon?.iconDark ? { iconDarkPath: icon.iconDark } : {}),
  }
}

const ADDITIONAL_SEED_NAMES = [
  '.NET', 'Azure Blob', 'Azure Functions', 'Azure SQL', 'Blob Store', 'C#', 'C++', 'Cassandra',
  'Docker', 'DynamoDB', 'Elasticsearch', 'Envoy', 'Erlang', 'Flink', 'Go', 'Grafana', 'GraphQL',
  'gRPC', 'Hack', 'Java', 'Memcached', 'MySQL', 'nginx', 'Power Platform', 'Prometheus', 'Python',
  'RabbitMQ', 'REST', 'Ruby', 'Rust', 'S3', 'Scala', 'Spark', 'Swift', 'Terraform', 'TypeScript',
  'Vue', 'Xamarin',
] as const

const BASE_DEFINITIONS: Array<Omit<TechnologySeedDefinition, 'recommendedShapeTypes' | 'defaultRole'>> = [
  {
    id: SEEDED_TECHNOLOGY_IDS.React,
    name: 'React',
    description: 'A library for building web and native user interfaces.',
    websiteUrl: 'https://react.dev/',
    documentationUrl: 'https://react.dev/learn',
    aliases: ['React.js', 'ReactJS'],
    category: 'Frontend framework',
    publisher: 'Meta',
    ecosystem: 'JavaScript',
  },
  {
    id: SEEDED_TECHNOLOGY_IDS['Node.js'],
    name: 'Node.js',
    description: 'A cross-platform JavaScript runtime environment.',
    websiteUrl: 'https://nodejs.org/',
    documentationUrl: 'https://nodejs.org/docs/latest/api/',
    aliases: ['Node', 'NodeJS'],
    category: 'Runtime',
    publisher: 'OpenJS Foundation',
    ecosystem: 'JavaScript',
  },
  {
    id: SEEDED_TECHNOLOGY_IDS.PostgreSQL,
    name: 'PostgreSQL',
    description: 'An open source object-relational database system.',
    websiteUrl: 'https://www.postgresql.org/',
    documentationUrl: 'https://www.postgresql.org/docs/',
    aliases: ['Postgres'],
    category: 'Database',
    publisher: 'PostgreSQL Global Development Group',
    ecosystem: 'Data',
  },
  {
    id: SEEDED_TECHNOLOGY_IDS.Redis,
    name: 'Redis',
    description: 'An in-memory data store used as a cache, database, and message broker.',
    websiteUrl: 'https://redis.io/',
    documentationUrl: 'https://redis.io/docs/latest/',
    aliases: [],
    category: 'Data store',
    publisher: 'Redis',
    ecosystem: 'Data',
  },
  {
    id: SEEDED_TECHNOLOGY_IDS.MongoDB,
    name: 'MongoDB',
    description: 'A document-oriented operational database.',
    websiteUrl: 'https://www.mongodb.com/',
    documentationUrl: 'https://www.mongodb.com/docs/',
    aliases: ['Mongo DB'],
    category: 'Database',
    publisher: 'MongoDB, Inc.',
    ecosystem: 'Data',
  },
  {
    id: SEEDED_TECHNOLOGY_IDS.Kotlin,
    name: 'Kotlin',
    description: 'A statically typed programming language for multiplatform applications.',
    websiteUrl: 'https://kotlinlang.org/',
    documentationUrl: 'https://kotlinlang.org/docs/home.html',
    aliases: [],
    category: 'Programming language',
    publisher: 'JetBrains',
    ecosystem: 'JVM',
  },
  {
    id: SEEDED_TECHNOLOGY_IDS.Kafka,
    name: 'Apache Kafka',
    description: 'A distributed event streaming platform.',
    websiteUrl: 'https://kafka.apache.org/',
    documentationUrl: 'https://kafka.apache.org/documentation/',
    aliases: ['Kafka'],
    category: 'Event streaming',
    publisher: 'Apache Software Foundation',
    ecosystem: 'Data',
  },
  {
    id: SEEDED_TECHNOLOGY_IDS.Angular,
    name: 'Angular',
    description: 'A web application framework for building scalable applications.',
    websiteUrl: 'https://angular.dev/',
    documentationUrl: 'https://angular.dev/overview',
    aliases: ['Angular framework'],
    category: 'Frontend framework',
    publisher: 'Google',
    ecosystem: 'JavaScript',
  },
  {
    id: SEEDED_TECHNOLOGY_IDS.NestJS,
    name: 'NestJS',
    description: 'A framework for building scalable Node.js server applications.',
    websiteUrl: 'https://nestjs.com/',
    documentationUrl: 'https://docs.nestjs.com/',
    aliases: ['Nest.js', 'Nest'],
    category: 'Backend framework',
    publisher: 'NestJS',
    ecosystem: 'JavaScript',
  },
  ...ADDITIONAL_SEED_NAMES.map((name): TechnologySeedDefinition => ({
    id: SEEDED_TECHNOLOGY_IDS[name],
    name,
    aliases: [],
    category: ['REST', 'GraphQL', 'gRPC'].includes(name) ? 'Protocol' : 'Technology',
  })),
]

const ICON_NAME_ALIASES: Readonly<Record<string, string>> = {
  'Azure Blob': 'Azure Blob Storage',
  'C#': 'C# (Sharp)',
  'C++': 'C++ (PlusPlus)',
  Cassandra: 'Apache Cassandra',
  DynamoDB: 'Amazon DynamoDB',
  Elasticsearch: 'Elastic Search',
  Flink: 'Apache Flink',
  Go: 'Golang',
  nginx: 'NGINX',
  'Node.js': 'NodeJS',
  REST: 'REST (Representational State Transfer)',
  S3: 'Amazon Simple Storage Service Bucket',
  Spark: 'Apache Spark',
  Terraform: 'HashiCorp Terraform',
  Vue: 'Vue.js',
}

const SUPPORTED_SHAPES: readonly TechnologyShapeType[] = ['system', 'app', 'store', 'component', 'group']
const iconByName = new Map(ICON_CATALOG.map((entry) => [entry.name.toLocaleLowerCase(), entry]))

function iconEntry(name: string): IconCatalogEntry | undefined {
  return iconByName.get((ICON_NAME_ALIASES[name] ?? name).toLocaleLowerCase())
}

function recommendedShapes(entry: IconCatalogEntry): TechnologyShapeType[] {
  if (entry.compatibleWith.includes('all')) return [...SUPPORTED_SHAPES]
  const supported = entry.compatibleWith.filter(
    (shape): shape is TechnologyShapeType => SUPPORTED_SHAPES.includes(shape as TechnologyShapeType),
  )
  const unique = [...new Set(supported)]
  return unique.length > 0 ? unique : [...SUPPORTED_SHAPES]
}

function inferDefaultRole(entry: IconCatalogEntry): TechnologyRole {
  const name = entry.name.toLocaleLowerCase()
  if (entry.protocol?.length || /\b(rest|grpc|graphql|websocket|soap|mqtt|amqp|tcp|udp|oauth|openid)\b/.test(name)) return 'protocol'
  if (/\b(kafka|rabbitmq|activemq|event bus|message queue|pub.?sub|zeromq|nats)\b/.test(name)) return 'messaging'
  if (/\b(postgre|mysql|mariadb|mongodb|cassandra|dynamodb|database|\bdb\b|sql|redis|memcached|elasticsearch|datastore)\b/.test(name)) return 'database'
  if (/\b(blob|bucket|storage|file system|filesystem|data lake|warehouse|s3)\b/.test(name)) return 'storage'
  if (/\b(javascript|typescript|python|java|kotlin|golang|\bgo\b|ruby|rust|scala|swift|erlang|elixir|php|c#|c\+\+)\b/.test(name)) return 'language'
  if (entry.framework?.length || /\b(framework|react|angular|vue|svelte|django|flask|spring|nestjs|express)\b/.test(name)) return 'framework'
  if (/\b(runtime|nodejs|node\.js|jvm|\.net|webassembly)\b/.test(name)) return 'runtime'
  if (/\b(prometheus|grafana|monitor|observability|logging|tracing|ide|studio|test|ci\/cd)\b/.test(name)) return 'tooling'
  if (/\b(terraform|kubernetes|docker|container|network|gateway|firewall|load balancer|proxy|nginx|envoy)\b/.test(name)) return 'infrastructure'
  if (entry.packs?.some((pack) => /aws|azure|google cloud|gcp/i.test(pack))) return 'platform'
  const shapes = recommendedShapes(entry)
  if (shapes.length <= 2 && shapes.includes('store')) return 'storage'
  return 'other'
}

function inferredCategory(entry: IconCatalogEntry, role: TechnologyRole): string {
  if (entry.packs?.length) return entry.packs[0]
  const labels: Partial<Record<TechnologyRole, string>> = {
    language: 'Programming language', runtime: 'Runtime', framework: 'Framework', library: 'Library',
    database: 'Database', storage: 'Storage', messaging: 'Messaging', protocol: 'Protocol',
    platform: 'Platform', infrastructure: 'Infrastructure', tooling: 'Tooling',
  }
  return labels[role] ?? 'General technology'
}

export function iconSeedId(name: string): string {
  return `tech_catalog_${createHash('sha256').update(name.toLocaleLowerCase()).digest('hex').slice(0, 24)}`
}

const baseDefinitions: TechnologySeedDefinition[] = BASE_DEFINITIONS.map((definition) => {
  const metadata = seededTechnologyMetadata(definition.name)
  if (!metadata) throw new Error(`Missing governed technology metadata for ${definition.name}`)
  const icon = iconEntry(definition.name)
  return {
    ...definition,
    ...metadata,
    iconLightPath: icon?.iconLight,
    iconDarkPath: icon?.iconDark,
    seedRevision: icon?.revision,
  }
})

const governedIconNames = new Set(baseDefinitions.flatMap((definition) => [
  definition.name.toLocaleLowerCase(),
  (ICON_NAME_ALIASES[definition.name] ?? definition.name).toLocaleLowerCase(),
]))

/** Catalog names seeded from BASE_DEFINITIONS rather than from the icon
 * catalog (lower-cased). scripts/tech-icons/add.mjs refuses to re-artwork
 * them: their ids are pinned at the catalog-wide revision elsewhere. */
export const GOVERNED_CATALOG_NAMES: readonly string[] = [...governedIconNames].sort()

const catalogDefinitions: TechnologySeedDefinition[] = ICON_CATALOG
  .filter((entry) => !governedIconNames.has(entry.name.toLocaleLowerCase()))
  .map((entry) => {
    const defaultRole = inferDefaultRole(entry)
    return {
      id: iconSeedId(entry.name),
      name: entry.name,
      aliases: [...new Set([...(entry.framework ?? []), ...(entry.protocol ?? [])])]
        .filter((alias) => alias.toLocaleLowerCase() !== entry.name.toLocaleLowerCase()),
      category: inferredCategory(entry, defaultRole),
      description: entry.description,
      websiteUrl: entry.website,
      iconLightPath: entry.iconLight,
      iconDarkPath: entry.iconDark,
      recommendedShapeTypes: recommendedShapes(entry),
      defaultRole,
      seedRevision: entry.revision,
    }
  })

/** Author of every revision the boot-time seed writes. */
export const DEFAULT_SEED_ACTOR = 'system:technology-seed'

const DEFINITIONS: TechnologySeedDefinition[] = [...baseDefinitions, ...catalogDefinitions]
export const SEEDED_TECHNOLOGY_CATALOG_SIZE = DEFINITIONS.length

/**
 * Idempotently installs the deterministic public starter catalog and the
 * organization's default `all` policy. Existing immutable revisions are never
 * overwritten; a repeated seed only installs a newer deterministic revision
 * and any catalog entries that are still missing.
 */
export async function seedTechnologyCatalog(
  db: Pool,
  orgId: string,
  actorUserId = DEFAULT_SEED_ACTOR
): Promise<Record<string, string>> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const seedRows = DEFINITIONS.map((definition) => {
      const searchable = searchDocument(definition)
      return {
        id: definition.id,
        // An entry whose artwork changed carries a higher revision of its own:
        // the inserts below never overwrite an existing (id, revision) row.
        revision: Math.max(SEEDED_TECHNOLOGY_CATALOG_REVISION, definition.seedRevision ?? 0),
        name: definition.name,
        normalizedName: searchable.normalizedName,
        description: definition.description ?? null,
        websiteUrl: definition.websiteUrl ?? null,
        documentationUrl: definition.documentationUrl ?? null,
        aliases: definition.aliases ?? [],
        normalizedAliases: searchable.normalizedAliases,
        category: definition.category ?? null,
        iconLightPath: definition.iconLightPath ?? null,
        iconDarkPath: definition.iconDarkPath ?? null,
        publisher: definition.publisher ?? null,
        ecosystem: definition.ecosystem ?? null,
        recommendedShapeTypes: definition.recommendedShapeTypes ?? [...SUPPORTED_SHAPES],
        defaultRole: definition.defaultRole ?? 'other',
        searchText: searchable.searchText,
      }
    })
    const payload = JSON.stringify(seedRows)
    const recordset = `jsonb_to_recordset($1::jsonb) AS d(
      id text, revision integer, name text, "normalizedName" text, description text,
      "websiteUrl" text, "documentationUrl" text, aliases jsonb, "normalizedAliases" jsonb,
      category text, "iconLightPath" text, "iconDarkPath" text, publisher text, ecosystem text,
      "recommendedShapeTypes" jsonb, "defaultRole" text, "searchText" text
    )`
    const insertedIdentities = await client.query<{ id: string }>(
      `INSERT INTO technology_identities
         (id, scope, owner_org_id, lifecycle_status, latest_revision, current_revision, created_by)
       SELECT d.id, 'public', NULL, 'active', d.revision, d.revision, $2
       FROM ${recordset}
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [payload, actorUserId],
    )
    const insertedRevisions = await client.query<{ technology_id: string }>(
      `INSERT INTO technology_revisions
         (technology_id, revision, name, normalized_name, description, website_url, documentation_url,
          aliases, normalized_aliases, category, icon_light_path, icon_dark_path, publisher, ecosystem,
          recommended_shape_types, default_role, search_document, created_by)
       SELECT d.id, d.revision, d.name, d."normalizedName", d.description, d."websiteUrl", d."documentationUrl",
              ARRAY(SELECT jsonb_array_elements_text(d.aliases)),
              ARRAY(SELECT jsonb_array_elements_text(d."normalizedAliases")),
              d.category, d."iconLightPath", d."iconDarkPath", d.publisher, d.ecosystem,
              ARRAY(SELECT jsonb_array_elements_text(d."recommendedShapeTypes")),
              d."defaultRole", d."searchText", $2
       FROM ${recordset}
       ON CONFLICT (technology_id, revision) DO NOTHING
       RETURNING technology_id`,
      [payload, actorUserId],
    )
    await client.query(
      `INSERT INTO technology_revision_workflows
         (technology_id, revision, status, decided_by, decided_at)
       SELECT d.id, d.revision, 'approved', $2, now()
       FROM ${recordset}
       ON CONFLICT (technology_id, revision) DO NOTHING`,
      [payload, actorUserId],
    )
    // Publish pointers only after every referenced revision and workflow row is durable.
    await client.query(
      `UPDATE technology_identities i
       SET latest_revision = GREATEST(i.latest_revision, d.revision),
           current_revision = d.revision,
           updated_at = now()
       FROM ${recordset}
       WHERE i.id = d.id AND i.scope = 'public'
         AND i.lifecycle_status <> 'merged'
         AND i.latest_revision <= d.revision
         AND (i.latest_revision < d.revision OR i.current_revision IS DISTINCT FROM d.revision)
         -- A platform admin's public revision takes latest_revision + 1 as a
         -- DRAFT. When that number equals a seed revision the seed's insert is
         -- a no-op, and without this guard the pointer would publish the draft.
         AND EXISTS (
           SELECT 1 FROM technology_revision_workflows w
           WHERE w.technology_id = d.id AND w.revision = d.revision AND w.status = 'approved'
         )
         -- A revision a platform admin curated and published stays current:
         -- a later re-artworked seed revision must not silently replace it.
         AND NOT EXISTS (
           SELECT 1 FROM technology_revisions cr
           WHERE cr.technology_id = i.id AND cr.revision = i.current_revision
             AND cr.created_by NOT IN ($3, $2)
         )`,
      [payload, actorUserId, DEFAULT_SEED_ACTOR],
    )
    // When a guard above kept the pointer, the seed's revision row still
    // exists. latest_revision must cover it: createPublicRevision allocates
    // latest_revision + 1, and would otherwise collide with the seed's row on
    // every attempt — an admin locked out of the entry they curated.
    await client.query(
      `UPDATE technology_identities i
       SET latest_revision = d.revision, updated_at = now()
       FROM ${recordset}
       WHERE i.id = d.id AND i.scope = 'public' AND i.latest_revision < d.revision
         AND EXISTS (SELECT 1 FROM technology_revisions r WHERE r.technology_id = d.id AND r.revision = d.revision)`,
      [payload],
    )
    // Every reason above leaves the database on an older revision than the
    // catalog ships. Say so: a skip that nobody sees reads as "the new icon
    // is live".
    const behind = await client.query<{ name: string; current: number; seeded: number; lifecycle: string }>(
      `SELECT d.name, i.current_revision AS current, d.revision AS seeded, i.lifecycle_status AS lifecycle
       FROM ${recordset}
       JOIN technology_identities i ON i.id = d.id AND i.scope = 'public'
       WHERE i.current_revision < d.revision
       ORDER BY d.name`,
      [payload],
    )
    if (behind.rows.length > 0) {
      console.warn(JSON.stringify({
        event: 'technology.seed_revision_not_current',
        count: behind.rows.length,
        reason: 'merged identity, a non-approved revision at the seeded number, or an admin-curated current revision',
        entries: behind.rows.slice(0, 20),
      }))
    }
    const newIdentityIds = new Set(insertedIdentities.rows.map((row) => row.id))
    const definitionById = new Map(seedRows.map((row) => [row.id, row]))
    const auditRows = insertedRevisions.rows.map((row) => {
      const definition = definitionById.get(row.technology_id)!
      return {
        id: `techaudit_${randomUUID().replace(/-/g, '')}`,
        action: newIdentityIds.has(row.technology_id) ? 'technology.seeded' : 'technology.seed_revision_added',
        technologyId: row.technology_id,
        revision: definition.revision,
        detail: { seedOrgId: orgId, name: definition.name, catalogRevision: definition.revision },
      }
    })
    if (auditRows.length > 0) {
      await client.query(
        `INSERT INTO technology_audit
           (id, actor_user_id, org_id, action, technology_id, revision, detail)
         SELECT a.id, $2, NULL, a.action, a."technologyId", a.revision, a.detail
         FROM jsonb_to_recordset($1::jsonb) AS a(
           id text, action text, "technologyId" text, revision integer, detail jsonb
         )`,
        [JSON.stringify(auditRows), actorUserId],
      )
    }
    await client.query(
      `INSERT INTO technology_org_policies (org_id, policy, updated_by)
       VALUES ($1, 'all', $2)
       ON CONFLICT (org_id) DO NOTHING`,
      [orgId, actorUserId]
    )
    await client.query('COMMIT')
    return SEEDED_TECHNOLOGY_IDS
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
