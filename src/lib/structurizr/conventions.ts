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
 * The judgements both Structurizr importers must make identically.
 *
 * A customer's workspace exists in two serialisations — `.dsl` and
 * `workspace.json` — and the same workspace has to land the same way whichever
 * one they hand us. That is only true if the JUDGEMENTS live in one place, not
 * just the constants they read: two copies of "is this a data store" drift the
 * first time one of them learns a new word, and the drift is invisible because
 * each importer's own tests stay green.
 *
 * `../structurizr/mapper.ts` (DSL) and `./json/mapWorkspace.ts` (JSON) are the
 * two callers. Neither may re-implement anything in here.
 */

import type { C4Type } from '../../types'
import { isSeededTechnologyName } from '../technologyUsage'
import { defaultShapeSize } from '../shapeDefaults'

/** Our box for each C4 level. Both importers size an imported shape from this,
 *  so the same element is the same size whichever file it came from — and the
 *  same size as a shape drawn in the editor (`DEFAULT_SHAPE_SIZE`). It used to be
 *  a per-type table of its own, which made every imported shape a different
 *  size from the ones a user then added by hand. */
export const SIZE_BY_TYPE: Record<C4Type, { width: number; height: number }> = {
  actor: defaultShapeSize(),
  system: defaultShapeSize(),
  app: defaultShapeSize(),
  store: defaultShapeSize(),
  component: defaultShapeSize(),
}

// Compound names like "PostgreSQL" must match even though a `\b` after "postgres"
// would not fire (it is followed by another word char), so the long-prefix
// alternatives appear first and are left-anchored on a word boundary only.
//
// Bare `elastic` is deliberately NOT here: it made every AWS "Elastic Load
// Balancer" / "Elastic Beanstalk" a database, which the deployment fixture
// carries as an infrastructure node tagged "Amazon Web Services - Elastic Load
// Balancing". The products that really are stores name themselves in full
// (`elasticsearch`, `elasticache`), and both spellings are listed.
export const DATASTORE_RE =
  /\b(postgresql|postgres|postgre|database|db|sql|mysql|mariadb|oracle|mongodb|mongo|dynamodb|dynamo|cassandra|redis|memcached|memcache|cache|elasticsearch|elasticache|opensearch|queue|kafka|rabbitmq|rabbit|sqs|sns|pubsub|pub\/sub|topic|bus|eventbus|kinesis|s3|bucket|blob|storage|datastore|data store|warehouse|bigquery|snowflake|cosmosdb|cosmos|firestore|firebase|filesystem|file system|cold ?storage|object ?store)\b/i

export const EXTERNAL_TAG_RE = /\b(external|existing system|saas)\b/i
export const INTERNAL_TAG_RE = /\b(internal|employee|staff)\b/i

/**
 * Technology and tags only — NEVER the display name. "SQL Runner Service",
 * "SNS Notifier", "S3 Proxy" and "Kafka Consumer Service" are applications that
 * happen to be named after the store they talk to.
 */
export function isDatastore(technology: string | undefined, tags: readonly string[]): boolean {
  return DATASTORE_RE.test([technology ?? '', ...tags].join(' '))
}

/** `"Java, Spring MVC"` / `"React/Redux"` → the individual technology names. */
export function technologyNames(tech?: string): string[] {
  if (!tech) return []
  return tech
    .split(/[,/]/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/** One technology named in a Structurizr `technology` string. */
export interface TechnologySpec {
  name: string
  version?: string
}

/** `17`, `20.1`, `v3.11`, `5.x`, `2.0.0-rc1` — a trailing word that is a version. */
const VERSION_TOKEN_RE = /^v?\d+(?:\.(?:\d+|x))*(?:[-+][0-9A-Za-z.]+)?$/i

/**
 * `"Angular 17, TypeScript"` → `[{ name: 'Angular', version: '17' }, { name: 'TypeScript' }]`.
 *
 * Structurizr has one free-text technology field, so a version is written into
 * it (`"Node.js 20, Express"`). Importing `Angular 17` as a technology NAMED
 * "Angular 17" mints a separate catalog entry per version and leaves the
 * version field empty; the exporter writes `name version` back, so this is
 * also what closes the round trip.
 *
 * A trailing number is a version only when it is unambiguous: dotted (`3.11`),
 * `v`-prefixed, or after a name the seeded catalog knows. "Office 365" and
 * "Dynamics 365" are product names, not Office version 365.
 */
export function parseTechnologies(tech?: string): TechnologySpec[] {
  return technologyNames(tech).map((raw) => {
    const match = /^(.*\S)\s+(\S+)$/.exec(raw)
    if (!match || !VERSION_TOKEN_RE.test(match[2])) return { name: raw }
    const [, base, version] = match
    const unambiguous = /\.|^v/i.test(version) || isSeededTechnologyName(base)
    return unambiguous ? { name: base, version } : { name: raw }
  })
}

/** Which side of the enterprise boundary rule an element is judged by. */
export type ScopeLevel = 'person' | 'softwareSystem' | 'containerLevel'

/**
 * Which side of the enterprise boundary an element sits on.
 *
 * Precedence, and why this order rather than the obvious one:
 *
 *  1. Containers, components and everything running inside a system are always
 *     internal. They inherit their system's placement and are never
 *     independently external — an "External" tag on a container names the
 *     system it talks to, not the container's own side of the line.
 *  2. Then a scope-flavoured TAG, which in both formats is something the author
 *     typed on this one element.
 *  3. Only then the file's own scope STATEMENT (the DSL's `enterprise` block,
 *     the JSON's `location`).
 *
 * Step 3 sits below step 2 because the DSL's `enterprise { … }` sets exactly
 * that statement on every element inside it, so an element inside the block
 * tagged "External" is an override, not a contradiction. Reading the statement
 * first would make the same workspace land differently depending on whether the
 * customer exported the DSL or the JSON, which is what this module exists to
 * prevent — and step 1 is the same divergence in the other direction: the JSON
 * side used to let a container tagged "External" leave the enterprise while the
 * DSL side never did.
 */
export function detectScope(
  level: ScopeLevel,
  tags: readonly string[],
  declared?: 'internal' | 'external',
): 'internal' | 'external' {
  if (level === 'containerLevel') return 'internal'
  if (tags.some((t) => EXTERNAL_TAG_RE.test(t))) return 'external'
  if (tags.some((t) => INTERNAL_TAG_RE.test(t))) return 'internal'
  if (declared) return declared
  // People default to external (customers); everything else to internal.
  return level === 'person' ? 'external' : 'internal'
}

/**
 * Compare two Structurizr step orders.
 *
 * The order is a STRING because nested sequences are real: "1.1" comes after "1"
 * and before "2", and `parseFloat` would put "1.10" before "1.9". So it is
 * compared segment by segment, numerically where both segments are numbers.
 */
export function compareOrder(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i]
    const r = right[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = Number(l)
    const rn = Number(r)
    if (Number.isFinite(ln) && Number.isFinite(rn)) {
      if (ln !== rn) return ln - rn
    } else if (l !== r) {
      return l < r ? -1 : 1
    }
  }
  return 0
}
