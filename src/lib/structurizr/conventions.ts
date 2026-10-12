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

/** Our box for each C4 level. Both importers size an imported shape from this,
 *  so the same element is the same size whichever file it came from. */
export const SIZE_BY_TYPE: Record<C4Type, { width: number; height: number }> = {
  actor: { width: 150, height: 90 },
  system: { width: 200, height: 100 },
  app: { width: 185, height: 100 },
  store: { width: 185, height: 100 },
  component: { width: 170, height: 90 },
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
