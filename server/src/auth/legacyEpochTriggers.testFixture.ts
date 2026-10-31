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

/**
 * TEST FIXTURE — the `ensureEpochTriggers` of the build deployed before the
 * revocation rework, copied VERBATIM from `git show c520678ae:server/src/auth/wsAuth.ts`
 * (develop, 2026-10-16). It is what an old process runs when it restarts in
 * the middle of a rolling deploy; the tests replay it against the new trigger
 * set to prove that set survives (epochDeadlock.integration.test.ts). Do not
 * "fix" or update it: its value is that it is the old code.
 */
export async function installLegacyEpochTriggersC520678ae(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Shared bump function: UPSERT-increment auth_epochs for one org + notify.
    await client.query(`
      CREATE OR REPLACE FUNCTION bump_auth_epoch(p_org_id TEXT) RETURNS void AS $$
      BEGIN
        IF p_org_id IS NULL THEN
          RETURN;
        END IF;
        INSERT INTO auth_epochs (org_id, epoch) VALUES (p_org_id, 2)
        ON CONFLICT (org_id) DO UPDATE SET epoch = auth_epochs.epoch + 1;
        PERFORM pg_notify('auth_epoch', p_org_id);
      END;
      $$ LANGUAGE plpgsql
    `)

    // org_members: org_id is a direct column.
    await client.query(`
      CREATE OR REPLACE FUNCTION trg_bump_epoch_org_members() RETURNS trigger AS $$
      BEGIN
        PERFORM bump_auth_epoch(COALESCE(NEW.org_id, OLD.org_id));
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `)
    await client.query(`DROP TRIGGER IF EXISTS trg_epoch_org_members ON org_members`)
    await client.query(`
      CREATE TRIGGER trg_epoch_org_members
      AFTER INSERT OR UPDATE OR DELETE ON org_members
      FOR EACH ROW EXECUTE FUNCTION trg_bump_epoch_org_members()
    `)

    // team_members: org_id via teams.org_id.
    await client.query(`
      CREATE OR REPLACE FUNCTION trg_bump_epoch_team_members() RETURNS trigger AS $$
      DECLARE
        v_team_id TEXT := COALESCE(NEW.team_id, OLD.team_id);
        v_org_id TEXT;
      BEGIN
        SELECT org_id INTO v_org_id FROM teams WHERE id = v_team_id;
        PERFORM bump_auth_epoch(v_org_id);
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `)
    await client.query(`DROP TRIGGER IF EXISTS trg_epoch_team_members ON team_members`)
    await client.query(`
      CREATE TRIGGER trg_epoch_team_members
      AFTER INSERT OR UPDATE OR DELETE ON team_members
      FOR EACH ROW EXECUTE FUNCTION trg_bump_epoch_team_members()
    `)

    // team_scope_permissions: org_id via teams.org_id.
    await client.query(`
      CREATE OR REPLACE FUNCTION trg_bump_epoch_tsp() RETURNS trigger AS $$
      DECLARE
        v_team_id TEXT := COALESCE(NEW.team_id, OLD.team_id);
        v_org_id TEXT;
      BEGIN
        SELECT org_id INTO v_org_id FROM teams WHERE id = v_team_id;
        PERFORM bump_auth_epoch(v_org_id);
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `)
    await client.query(`DROP TRIGGER IF EXISTS trg_epoch_tsp ON team_scope_permissions`)
    await client.query(`
      CREATE TRIGGER trg_epoch_tsp
      AFTER INSERT OR UPDATE OR DELETE ON team_scope_permissions
      FOR EACH ROW EXECUTE FUNCTION trg_bump_epoch_tsp()
    `)

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
