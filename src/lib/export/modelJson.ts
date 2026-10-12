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

import type { ExportBundle } from './types'

/**
 * The raw full-model export — every entity with every field of metadata, plus a
 * small format header so the import side (`lib/import/registry.ts` "JSON model")
 * can recognise and round-trip it later.
 */
export function buildModelJson(bundle: ExportBundle): string {
  const flows = Object.values(bundle.flowsByDiagram).flat()
  return JSON.stringify(
    {
      format: 'maplespire-model',
      version: 3,
      generatedAt: bundle.generatedAt,
      landscape: bundle.landscapeName,
      scope: bundle.diagrams.length === 1 ? 'diagram' : 'landscape',
      domains: bundle.domains,
      objects: bundle.objects,
      connections: bundle.connections,
      groups: bundle.groups,
      tags: bundle.tags,
      flows,
      diagrams: bundle.diagrams,
      decisionRecords: bundle.decisionRecords,
    },
    null,
    2,
  )
}
