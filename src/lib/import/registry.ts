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

import type { ImportSource } from './types'
import { structurizrSource } from './structurizrSource'
import { structurizrJsonSource } from './structurizrJsonSource'
import { jsonSource } from './jsonSource'

// Future sources slot in here. "coming-soon" entries render in the picker
// (disabled) so users can see the roadmap.
const comingSoon: ImportSource[] = [
  { id: 'mermaid', label: 'Mermaid', description: 'Mermaid flowchart / C4 diagrams.', status: 'coming-soon' },
  { id: 'plantuml', label: 'PlantUML', description: 'PlantUML / C4-PlantUML diagrams.', status: 'coming-soon' },
]

export const importSources: ImportSource[] = [
  structurizrSource,
  structurizrJsonSource,
  jsonSource,
  ...comingSoon,
]

export function getImportSource(id: string): ImportSource | undefined {
  return importSources.find((s) => s.id === id)
}
