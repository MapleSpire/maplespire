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

import type { Pool } from 'pg'
import { WORKSPACE_ROUTE_CHANGED_CHANNEL } from '../rbac/workspaceCacheInvalidation.js'

/** Installed by the ownership baseline, after landscapes and versions exist.
 * Payloads invalidate cached routes only: readers still obtain canonical keys
 * from SQL. Database triggers cover sibling processes and manual SQL writers;
 * the listener is an acceleration of the resolver's existing TTL fallback. */
export async function ensureWorkspaceRouteInvalidationSchema(db: Pick<Pool, 'query'>): Promise<void> {
  await db.query(`
    CREATE OR REPLACE FUNCTION notify_workspace_version_route_changed() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF OLD.id IS NOT DISTINCT FROM NEW.id
          AND OLD.landscape_id IS NOT DISTINCT FROM NEW.landscape_id
          AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
          RETURN NULL;
        END IF;
      END IF;
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('${WORKSPACE_ROUTE_CHANGED_CHANNEL}', json_build_object('schema', TG_TABLE_SCHEMA, 'landscapeId', OLD.landscape_id)::text);
      ELSE
        PERFORM pg_notify('${WORKSPACE_ROUTE_CHANGED_CHANNEL}', json_build_object('schema', TG_TABLE_SCHEMA, 'landscapeId', NEW.landscape_id)::text);
        IF TG_OP = 'UPDATE' THEN
          IF OLD.landscape_id IS DISTINCT FROM NEW.landscape_id THEN
            PERFORM pg_notify('${WORKSPACE_ROUTE_CHANGED_CHANNEL}', json_build_object('schema', TG_TABLE_SCHEMA, 'landscapeId', OLD.landscape_id)::text);
          END IF;
        END IF;
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `)
  await db.query(`
    CREATE OR REPLACE FUNCTION notify_workspace_landscape_route_changed() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF OLD.id IS NOT DISTINCT FROM NEW.id
          AND OLD.default_version_id IS NOT DISTINCT FROM NEW.default_version_id THEN
          RETURN NULL;
        END IF;
      END IF;
      IF TG_OP = 'DELETE' THEN
        PERFORM pg_notify('${WORKSPACE_ROUTE_CHANGED_CHANNEL}', json_build_object('schema', TG_TABLE_SCHEMA, 'landscapeId', OLD.id)::text);
      ELSE
        PERFORM pg_notify('${WORKSPACE_ROUTE_CHANGED_CHANNEL}', json_build_object('schema', TG_TABLE_SCHEMA, 'landscapeId', NEW.id)::text);
        IF TG_OP = 'UPDATE' THEN
          IF OLD.id IS DISTINCT FROM NEW.id THEN
            PERFORM pg_notify('${WORKSPACE_ROUTE_CHANGED_CHANNEL}', json_build_object('schema', TG_TABLE_SCHEMA, 'landscapeId', OLD.id)::text);
          END IF;
        END IF;
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `)
  await db.query(`
    CREATE OR REPLACE FUNCTION notify_workspace_routes_truncated() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('${WORKSPACE_ROUTE_CHANGED_CHANNEL}', json_build_object('schema', TG_TABLE_SCHEMA, 'landscapeId', NULL)::text);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `)
  // Watch only routing columns; unrelated writes must not detoast or serialize
  // versions.base_manifest merely to compare lifecycle status.
  for (const [table, kind, columns] of [
    ['versions', 'version', 'id, landscape_id, status'],
    ['landscapes', 'landscape', 'id, default_version_id'],
  ] as const) {
    await db.query(`DROP TRIGGER IF EXISTS trg_workspace_${kind}_route_changed ON ${table}`)
    await db.query(`
      CREATE TRIGGER trg_workspace_${kind}_route_changed
      AFTER INSERT OR UPDATE OF ${columns} OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION notify_workspace_${kind}_route_changed()
    `)
    await db.query(`DROP TRIGGER IF EXISTS trg_workspace_${kind}_routes_truncated ON ${table}`)
    await db.query(`
      CREATE TRIGGER trg_workspace_${kind}_routes_truncated
      AFTER TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION notify_workspace_routes_truncated()
    `)
  }
}
