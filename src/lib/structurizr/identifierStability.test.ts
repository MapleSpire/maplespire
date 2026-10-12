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

import { describe, expect, it } from 'vitest'
import { parseWorkspace } from './parser'
import { mapWorkspace } from './mapper'
import { buildStructurizrDsl } from '../export/structurizr'
import type { ExportBundle } from '../export/types'

/**
 * A round trip used to rename everything. The mapper never stored the DSL
 * identifier, so the exporter re-slugged the display name:
 * `internetBankingSystem` came back as `internet_banking_system`, and the view
 * key `SystemContext` came back as `systemcontext`. That makes an exported .dsl
 * undiffable against the source it came from, and breaks Structurizr deep links
 * and `filtered <baseKey>` references.
 */
const DSL = `workspace "Bank" {
    model {
        customer = person "Personal Banking Customer"
        internetBankingSystem = softwareSystem "Internet Banking System" {
            apiApplication = container "API Application"
            webApplication = container "Web Application"
        }
        customer -> webApplication "Uses"
    }
    views {
        systemContext internetBankingSystem "SystemContext" {
            include *
            autoLayout
        }
        container internetBankingSystem "Containers" {
            include *
            autoLayout
        }
    }
}`

const mapped = () => mapWorkspace(parseWorkspace(DSL), {
  idFactory: (() => { let n = 0; return () => `id${++n}` })(),
})

const bundleOf = (m: ReturnType<typeof mapped>): ExportBundle => ({
  landscapeName: 'Bank',
  generatedAt: '2026-08-08T00:00:00.000Z',
  diagrams: m.diagrams,
  activeDiagramId: m.entryDiagramId,
  flowsByDiagram: {},
  objects: m.objects,
  connections: m.connections,
  groups: m.groups,
  domains: [],
  tags: m.tags,
  decisionRecords: [],
})

describe('identifier and view-key stability', () => {
  it('re-emits the identifiers the source used, not slugs of the display name', () => {
    const dsl = buildStructurizrDsl(bundleOf(mapped()))
    expect(dsl).toContain('internetBankingSystem')
    expect(dsl).toContain('apiApplication')
    expect(dsl).toContain('webApplication')
    expect(dsl).not.toContain('internet_banking_system')
    expect(dsl).not.toContain('api_application')
  })

  it('re-emits the view keys the source used', () => {
    const dsl = buildStructurizrDsl(bundleOf(mapped()))
    expect(dsl).toContain('"SystemContext"')
    expect(dsl).toContain('"Containers"')
  })

  it('is idempotent — a second round trip changes nothing', () => {
    // The real test of stability: export, re-import, export again. Any churn in
    // identifiers or keys shows up as a diff here.
    const first = buildStructurizrDsl(bundleOf(mapped()))
    const second = buildStructurizrDsl(bundleOf(
      mapWorkspace(parseWorkspace(first), { idFactory: (() => { let n = 0; return () => `r${++n}` })() }),
    ))
    expect(second).toBe(first)
  })

  it('still uniquifies when two elements claim the same identifier', () => {
    const dsl = buildStructurizrDsl({
      ...bundleOf(mapped()),
      objects: [
        { ...mapped().objects[0], id: 'a', name: 'A', properties: { 'structurizr.identifier': 'dup' } },
        { ...mapped().objects[0], id: 'b', name: 'B', properties: { 'structurizr.identifier': 'dup' } },
      ],
      connections: [],
      diagrams: [],
      groups: [],
    })
    expect(dsl).toContain('dup ')
    expect(dsl).toContain('dup_2 ')
  })

  it('keeps the view description the source declared', () => {
    const m = mapWorkspace(parseWorkspace(`workspace {
      model { s = softwareSystem "S" { c = container "C" } }
      views {
        container s "Key" "A described view" { include * autoLayout }
      }
    }`), { idFactory: (() => { let n = 0; return () => `id${++n}` })() })
    expect(m.diagrams[0]?.description).toBe('A described view')
  })
})
