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

import { parseWorkspaceJson } from '../structurizr/json/parse'
import { mapWorkspace, sizeGroupBoxes } from '../structurizr/json/mapWorkspace'
import { applyAutoLayout } from '../layout'
import type { ImportResult, ImportSource } from './types'

const SAMPLE = `{
  "name" : "My System",
  "model" : {
    "people" : [ {
      "id" : "1", "name" : "User", "tags" : "Element,Person",
      "relationships" : [ { "id" : "5", "sourceId" : "1", "destinationId" : "3", "description" : "Uses" } ]
    } ],
    "softwareSystems" : [ {
      "id" : "2", "name" : "My System", "tags" : "Element,Software System",
      "containers" : [
        { "id" : "3", "name" : "Web App", "technology" : "React", "tags" : "Element,Container",
          "relationships" : [ { "id" : "6", "sourceId" : "3", "destinationId" : "4", "description" : "Reads from", "technology" : "SQL" } ] },
        { "id" : "4", "name" : "Database", "technology" : "PostgreSQL", "tags" : "Element,Container,Database" }
      ]
    } ]
  },
  "views" : {
    "systemLandscapeViews" : [ {
      "key" : "SystemLandscape",
      "elements" : [ { "id" : "1", "x" : 0, "y" : 200 }, { "id" : "2", "x" : 600, "y" : 200 } ],
      "relationships" : [ { "id" : "5" } ]
    } ],
    "containerViews" : [ {
      "key" : "Containers", "softwareSystemId" : "2",
      "elements" : [ { "id" : "1", "x" : 0, "y" : 200 }, { "id" : "3", "x" : 600, "y" : 100 }, { "id" : "4", "x" : 600, "y" : 700 } ],
      "relationships" : [ { "id" : "5" }, { "id" : "6" } ]
    } ],
    "configuration" : { "styles" : { "elements" : [ { "tag" : "Database", "shape" : "Cylinder" } ] } }
  }
}`

/**
 * Import a Structurizr workspace JSON export.
 *
 * The layout split is the point of this file. A view that carries coordinates
 * keeps them — `mapWorkspace` has already turned them into `layouts` — and only
 * the views that never had a layout (67 of 67 element rows on the origin, in the
 * canonical example) go through ELK. Running auto-layout over the whole set
 * would discard exactly the work a customer is migrating for; running none of it
 * would import those 67 shapes stacked on the origin.
 */
export const structurizrJsonSource: ImportSource = {
  id: 'structurizr-json',
  label: 'Structurizr JSON',
  description: 'Paste or upload a Structurizr workspace JSON export (model + views + layout).',
  hint: 'Keeps each view exactly as the file has it — element positions, groups, deployment boundaries and dynamic views (imported as flows). Views the file never laid out are laid out here. Export it from Structurizr with Workspace → JSON, or take workspace.json from the CLI.',
  status: 'available',
  placeholder: SAMPLE,
  fileAccept: '.json,application/json',
  chooseTarget: true,
  async run(input: string): Promise<ImportResult> {
    const workspace = parseWorkspaceJson(input)
    const mapped = mapWorkspace(workspace)

    const preserved = new Set(mapped.preservedDiagramIds)
    const ctx = { objects: mapped.objects, connections: mapped.connections, groups: mapped.groups }
    const { diagrams: laidOut, connections: routed } = await applyAutoLayout(
      mapped.diagrams.filter((d) => !preserved.has(d.id)),
      ctx,
      mapped.layoutHints,
    )

    // `applyAutoLayout` patches `waypoints` / `labelPosition` / `shape` on the
    // CONNECTION, and a connection is shared by every diagram that draws it —
    // measured on big-bank-plc, where 7 edges appear on more than one view. So
    // in a mixed workspace (some views hand-arranged, some never laid out — the
    // whole reason this file splits the set) the ELK run over the auto half was
    // writing its bends onto edges the customer had routed by hand on the other
    // half. Anything a preserved view routed keeps what the file said.
    const handRouted = new Set(mapped.preservedConnectionIds)
    const mappedById = new Map(mapped.connections.map((c) => [c.id, c]))
    const connections = handRouted.size
      ? routed.map((c) => (handRouted.has(c.id) ? (mappedById.get(c.id) ?? c) : c))
      : routed

    const laidOutById = new Map(laidOut.map((d) => [d.id, d]))
    const diagrams = mapped.diagrams.map((diagram) => {
      const resolved = laidOutById.get(diagram.id) ?? diagram
      // The layout engine sizes every group from its own members alone, so a
      // deployment node and the node inside it come back sharing one border.
      // Expanding (never rewriting) the boxes it produced restores the nesting
      // without handing the canvas a layout no candidate was ever scored on.
      const groups = mapped.groups.filter((g) => resolved.groupIds.includes(g.id))
      if (groups.length === 0 || !resolved.layouts) return resolved
      return { ...resolved, layouts: sizeGroupBoxes(groups, resolved.layouts, 'expand', mapped.groupDepths) }
    })

    return {
      objects: mapped.objects,
      connections,
      groups: mapped.groups,
      tags: mapped.tags,
      diagrams,
      flows: mapped.flows,
      entryDiagramId: mapped.entryDiagramId,
      landscapeName: mapped.landscapeName,
      warnings: mapped.warnings,
      stats: mapped.stats,
    }
  },
}
