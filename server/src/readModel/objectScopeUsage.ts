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
 * SQL twin of the per-diagram scope rule (`src/lib/diagrams/objectScope.ts`,
 * server copy `server/src/ai/core/objectScope.ts`) for the derived usage the
 * model-wide pages show: "external in N of M diagrams".
 *
 * Inputs, all already in the read model:
 *  - membership: `ro_diagram_objects` (the same rows `diagramCount` counts);
 *  - the override: `ro_diagrams.data->'objectScopes'`, denormalised from the
 *    DiagramDoc into the registry meta (client `buildMeta`, server
 *    `syncStubObjectScopes`) and, on static workspaces, merged from the doc
 *    itself (`staticDeltaProjector.projectDiagram`);
 *  - the drill-down focus: `ro_diagrams.parent_object_id`;
 *  - the default and the ancestry: `ro_objects.scope`, `ro_objects.parent_id`.
 *
 * Same order as the resolver, first match wins: a valid override; else
 * external when the default is external or the object is NOT PROVABLY inside
 * the focus — its `parent_id` chain never reaches the focus. Inside must be
 * proven, exactly as `isInsideFocus` does: a chain that reaches a root, runs
 * into a missing object, or passes the depth cap (a cycle) counts as outside.
 * Actors are exempt from the boundary walk, as in both resolvers.
 */

/** The ancestor walk's cap, same as `MAX_DEPTH` in both resolver copies. */
export const SCOPE_WALK_MAX_DEPTH = 64

/**
 * A boolean SQL expression: does the object resolve EXTERNAL on this diagram?
 * `m` is a `ro_diagram_objects` alias, `d` a `ro_diagrams` alias joined on it
 * (LEFT JOIN allowed: a missing diagram row has no override and no focus), `o`
 * the member's `ro_objects` row.
 */
export function externalOnDiagramSql(m: string, d: string, o: string): string {
  const override = `(${d}.data->'objectScopes'->>${m}.object_id)`
  return `(CASE
    WHEN ${override} IN ('internal', 'external') THEN ${override} = 'external'
    WHEN ${o}.scope = 'external' THEN true
    WHEN ${d}.parent_object_id IS NULL OR ${o}.id = ${d}.parent_object_id OR ${o}.type = 'actor' THEN false
    ELSE NOT EXISTS (
      WITH RECURSIVE walk(cursor, depth) AS (
        -- NULLIF: an empty parentId is a root to the JS resolvers (falsy).
        SELECT NULLIF(${o}.parent_id, ''), 0
        UNION ALL
        SELECT NULLIF(ancestor.parent_id, ''), walk.depth + 1
        FROM walk
        JOIN ro_objects ancestor
          ON ancestor.landscape_id = ${o}.landscape_id AND ancestor.version_id = ${o}.version_id
         AND ancestor.id = walk.cursor
        WHERE walk.cursor <> ${d}.parent_object_id AND walk.depth < ${SCOPE_WALK_MAX_DEPTH}
      )
      SELECT 1 FROM walk WHERE walk.cursor = ${d}.parent_object_id
    )
  END)`
}

/**
 * A boolean SQL predicate for the "external on some diagram" filter, on an
 * `ro_objects` row aliased `o`. The aliases inside are private to the EXISTS.
 */
export function externalOnSomeDiagramSql(o: string): string {
  return `EXISTS (
    SELECT 1 FROM ro_diagram_objects scope_m
    LEFT JOIN ro_diagrams scope_d
      ON scope_d.landscape_id = scope_m.landscape_id AND scope_d.version_id = scope_m.version_id
     AND scope_d.id = scope_m.diagram_id
    WHERE scope_m.landscape_id = ${o}.landscape_id AND scope_m.version_id = ${o}.version_id
      AND scope_m.object_id = ${o}.id
      AND ${externalOnDiagramSql('scope_m', 'scope_d', o)}
  )`
}
