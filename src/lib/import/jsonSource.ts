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

import type { ImportResult, ImportSource } from './types'
import { parseMapleSpireJson } from './maplespireJson'

const SAMPLE = `{
  "format": "maplespire-model",
  "version": 2,
  "landscape": "Sample landscape",
  "domains": [],
  "objects": [
    { "id": "user-1", "type": "actor", "name": "User", "position": { "x": 0, "y": 0 }, "size": { "width": 150, "height": 90 }, "tags": [], "scope": "external", "status": "live", "properties": {} },
    { "id": "web-1", "type": "app", "name": "Web app", "description": "Storefront UI", "technologyUsages": { "tu_web_react": { "id": "tu_web_react", "technologyId": "tech_seed_react", "catalogRevision": 1, "role": "framework", "snapshot": { "schemaVersion": 1, "name": "React" } } }, "position": { "x": 300, "y": 0 }, "size": { "width": 185, "height": 100 }, "tags": [], "scope": "internal", "status": "live", "properties": {} }
  ],
  "connections": [
    { "id": "conn-1", "fromId": "user-1", "toId": "web-1", "label": "Uses", "type": "solid" }
  ],
  "groups": [],
  "tags": [],
  "flows": [],
  "diagrams": [
    { "id": "diag-1", "name": "Sample context", "type": "context", "objectIds": ["user-1", "web-1"], "connectionIds": ["conn-1"], "groupIds": [],
      "layouts": { "user-1": { "position": { "x": 0, "y": 20 }, "size": { "width": 150, "height": 90 } }, "web-1": { "position": { "x": 320, "y": 0 }, "size": { "width": 185, "height": 100 } } } }
  ]
}`

/**
 * Import a MapleSpire JSON export (Share → Export → JSON). Parsing here powers
 * the shared preview; the modal plans the actual merge per import target
 * (current landscape / new landscape / review draft) at generate time.
 */
export const jsonSource: ImportSource = {
  id: 'json',
  label: 'JSON model',
  description: 'Paste or upload a MapleSpire JSON export (Share → Export → JSON).',
  hint: 'Pick where it lands: this landscape, a new landscape, or a review draft. Model objects whose id already exists are reused as-is — their properties are never updated.',
  status: 'available',
  placeholder: SAMPLE,
  fileAccept: '.json,application/json',
  chooseTarget: true,
  mergesById: true,
  async run(input: string): Promise<ImportResult> {
    const parsed = parseMapleSpireJson(input)
    const warnings: string[] = []
    if (parsed.diagrams.length === 0) {
      warnings.push('The file contains no diagrams — only model entities will be imported.')
    }
    return {
      objects: parsed.objects,
      connections: parsed.connections,
      groups: parsed.groups,
      // The JSON path does not route through `importModel` — it has its own
      // `applyJsonImport`, which already carries the file's tags.
      tags: parsed.tags ?? [],
      diagrams: parsed.diagrams,
      entryDiagramId: parsed.diagrams.find((d) => d.type === 'context')?.id ?? parsed.diagrams[0]?.id ?? null,
      warnings,
      stats: {
        objects: parsed.objects.length,
        connections: parsed.connections.length,
        groups: parsed.groups.length,
        diagrams: parsed.diagrams.length,
        byLevel: {
          context: parsed.diagrams.filter((d) => d.type === 'context').length,
          container: parsed.diagrams.filter((d) => d.type === 'container').length,
          component: parsed.diagrams.filter((d) => d.type === 'component').length,
        },
      },
    }
  },
}
