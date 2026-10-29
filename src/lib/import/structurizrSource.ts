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

import { parseWorkspace } from '../structurizr/parser'
import { mapWorkspace } from '../structurizr/mapper'
import { applyAutoLayout } from '../layout'
import type { ImportResult, ImportSource } from './types'

const SAMPLE = `workspace "My System" {
    model {
        user = person "User" "A user of the system."
        system = softwareSystem "My System" {
            web = container "Web App" "Delivers the UI." "React"
            api = container "API" "Business logic." "Node.js"
            db = container "Database" "Stores data." "PostgreSQL"
        }
        user -> web "Uses"
        web -> api "Calls" "JSON/HTTPS"
        api -> db "Reads/writes" "SQL"
    }
    views {
        systemContext system { include *  autoLayout }
        container system { include *  autoLayout }
    }
}`

/**
 * Import from Structurizr DSL. Parses the DSL, maps elements/relationships/views
 * to C4 diagrams, and auto-lays-out every generated diagram.
 */
export const structurizrSource: ImportSource = {
  id: 'structurizr',
  label: 'Structurizr',
  description: 'Paste a Structurizr DSL workspace (C4 model + views).',
  hint: 'Supports the model, structural views (System Landscape / Context / Container / Component) and dynamic views (imported as flows). Deployment and styling blocks are ignored. See docs.structurizr.com/dsl.',
  status: 'available',
  placeholder: SAMPLE,
  fileAccept: '.dsl,.txt',
  async run(input: string): Promise<ImportResult> {
    const ws = parseWorkspace(input)
    const mapped = mapWorkspace(ws)
    const { diagrams, connections } = await applyAutoLayout(
      mapped.diagrams,
      { objects: mapped.objects, connections: mapped.connections, groups: mapped.groups },
      mapped.layoutHints,
    )
    return {
      objects: mapped.objects,
      connections,
      groups: mapped.groups,
      tags: mapped.tags,
      diagrams,
      flows: mapped.flows,
      entryDiagramId: mapped.entryDiagramId,
      warnings: mapped.warnings,
      stats: mapped.stats,
    }
  },
}
