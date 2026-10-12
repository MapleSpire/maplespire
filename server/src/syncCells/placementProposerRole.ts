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

import type { Queryable } from '../readModel/types.js'
import { COVERAGE_TABLE, PROPOSAL_TABLE, proposerSchemaName } from './placementProposerSchema.js'

export const PROPOSER_READ_TABLES = [
  'versions', 'landscapes', 'orgs', 'workspace_placement',
  'workspace_claim_coverage', 'automerge_document_workspace',
  'sync_workspace_placement_moves', 'sync_topology_contract', COVERAGE_TABLE, PROPOSAL_TABLE,
] as const
export interface ProposerRoleAudit {
  readonly role: string
  readonly database: string
  readonly schema: string
  readonly checkedTables: number
}

/** Audit the connected LOGIN, including PUBLIC/column grants and SET ROLE
 * membership. This is a refusal gate; it never changes privileges. Re-run in
 * every admission transaction. An administrator changing ACLs concurrently is
 * outside the trust boundary, as is an administrator falsifying capture. */
export async function auditPlacementProposerRole(
  db: Queryable, schema: string, expectedRole: string,
): Promise<ProposerRoleAudit> {
  const s = proposerSchemaName(schema)
  const result = await db.query<{
    session_role: string; actual_role: string; database: string
    unsafe_identity: boolean; membership: boolean; database_owner: boolean
    database_create: boolean; schema_create: boolean; definer: boolean; object_owner: boolean
    unsafe_relations: string[]; unsafe_sequences: string[]; unsafe_readers: string[]
    missing_readers: string[]; storage_read: boolean; proposal_insert: boolean
    safe_path: boolean; safe_timeouts: boolean
  }>(`SELECT session_user::text AS session_role, current_user::text AS actual_role,
    current_database() AS database,
    (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
      OR r.rolbypassrls OR NOT r.rolcanlogin) AS unsafe_identity,
    EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) AS membership,
    EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database()
      AND datdba = r.oid) AS database_owner,
    has_database_privilege(current_database(), 'CREATE') AS database_create,
    EXISTS (SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_(temp|toast)'
      AND (nspowner = r.oid OR has_schema_privilege(oid, 'CREATE'))) AS schema_create,
    EXISTS (SELECT 1 FROM pg_proc WHERE prosecdef
      AND has_function_privilege(oid, 'EXECUTE')) AS definer,
    EXISTS (SELECT 1 FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass
      AND refobjid = r.oid AND deptype = 'o'
      AND dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))) AS object_owner,
    ARRAY(SELECT n.nspname || '.' || c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (c.relowner = r.oid
          OR has_table_privilege(c.oid, 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(c.oid, 'UPDATE,REFERENCES')
          OR ((n.nspname <> $1 OR c.relname <> $2)
            AND (has_table_privilege(c.oid, 'INSERT')
              OR has_any_column_privilege(c.oid, 'INSERT'))))) AS unsafe_relations,
    ARRAY(SELECT n.nspname || '.' || c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'S' AND n.nspname !~ '^pg_'
        AND (c.relowner = r.oid OR has_sequence_privilege(c.oid, 'USAGE,UPDATE'))) AS unsafe_sequences,
    ARRAY(SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = ANY(array_append($3::text[], 'automerge_storage'))
        AND (c.relkind <> 'r' OR c.relrowsecurity OR c.relforcerowsecurity)) AS unsafe_readers,
    ARRAY(SELECT name FROM unnest($3::text[]) AS name
      WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = name
          AND has_table_privilege(c.oid, 'SELECT'))) AS missing_readers,
    has_column_privilege('${s}.automerge_storage', 'key', 'SELECT')
      AND has_column_privilege('${s}.automerge_storage', 'updated_at', 'SELECT') AS storage_read,
    has_table_privilege('${s}.${PROPOSAL_TABLE}', 'INSERT') AS proposal_insert,
    current_setting('search_path') = $4 AS safe_path,
    current_setting('statement_timeout')::interval > interval '0'
      AND current_setting('statement_timeout')::interval <= interval '5 seconds'
      AND current_setting('lock_timeout')::interval > interval '0'
      AND current_setting('lock_timeout')::interval <= interval '2 seconds'
      AND current_setting('idle_in_transaction_session_timeout')::interval > interval '0'
      AND current_setting('idle_in_transaction_session_timeout')::interval <= interval '5 seconds'
      AS safe_timeouts
    FROM pg_roles r WHERE rolname = current_user`,
  [schema, PROPOSAL_TABLE, [...PROPOSER_READ_TABLES], `pg_catalog,${s},pg_temp`])
  const row = result.rows[0]
  if (!row || row.session_role !== expectedRole || row.actual_role !== expectedRole
    || row.unsafe_identity || row.membership || row.database_owner || row.database_create
    || row.schema_create || row.definer || row.object_owner || row.unsafe_relations.length || row.unsafe_sequences.length
    || row.unsafe_readers.length || row.missing_readers.length || !row.storage_read
    || !row.proposal_insert || !row.safe_path || !row.safe_timeouts) {
    // Metadata only. SQL and DSNs can contain local credentials.
    throw new Error('unsafe-placement-proposer-role')
  }
  return { role: row.actual_role, database: row.database, schema, checkedTables: PROPOSER_READ_TABLES.length }
}

/** Operator-owned provisioning fragment, after creating a distinct LOGIN.
 * The executable never calls this. Global privileges (PUBLIC, role membership,
 * SECURITY DEFINER) still need the live audit; these GRANTs are not a certificate. */
export function placementProposerGrants(schema: string, role: string): string {
  const s = proposerSchemaName(schema)
  const r = proposerSchemaName(role)
  return `GRANT USAGE ON SCHEMA ${s} TO ${r};
GRANT SELECT ON ${PROPOSER_READ_TABLES.map(name => `${s}.${name}`).join(', ')} TO ${r};
GRANT SELECT (key, updated_at) ON ${s}.automerge_storage TO ${r};
GRANT INSERT ON ${s}.${PROPOSAL_TABLE} TO ${r};`
}
