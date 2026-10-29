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

import { describe, it, expect } from 'vitest'
import { parseWorkspace } from './parser'
import { mapWorkspace } from './mapper'
import bigBank from './fixtures/big-bank-plc.dsl?raw'
import grouped from './fixtures/grouped.dsl?raw'

describe('mapWorkspace — Big Bank plc', () => {
  // Deterministic ids for stable assertions.
  let n = 0
  const m = mapWorkspace(parseWorkspace(bigBank), { idFactory: () => `id${++n}` })
  const obj = (name: string) => m.objects.find((o) => o.name === name)

  it('creates one object per element', () => {
    expect(m.objects.length).toBe(18)
  })

  it('maps element kinds to C4 types', () => {
    expect(obj('Personal Banking Customer')?.type).toBe('actor')
    expect(obj('Internet Banking System')?.type).toBe('system')
    expect(obj('API Application')?.type).toBe('app')
    expect(obj('Database')?.type).toBe('store') // Oracle Database Schema → store
    expect(obj('Sign In Controller')?.type).toBe('component')
  })

  it('infers external scope from tags / person', () => {
    expect(obj('Personal Banking Customer')?.scope).toBe('external')
    expect(obj('Mainframe Banking System')?.scope).toBe('external') // "Existing System"
    expect(obj('Internet Banking System')?.scope).toBe('internal')
    // Staff carry a "Bank Staff" tag → internal employees, not external customers.
    expect(obj('Customer Service Staff')?.scope).toBe('internal')
    expect(obj('Back Office Staff')?.scope).toBe('internal')
  })

  it('wires parentId for nested elements', () => {
    const api = obj('API Application')!
    const signin = obj('Sign In Controller')!
    expect(signin.parentId).toBe(api.id)
  })

  it('produces context (x2), container, component diagrams + the SignIn dynamic view (component level)', () => {
    expect(m.stats.byLevel).toEqual({ context: 2, container: 1, component: 2 })
  })

  it('container diagram = focal containers + externals, with a system boundary group', () => {
    const container = m.diagrams.find((d) => d.type === 'container')!
    const ibs = obj('Internet Banking System')!
    expect(container.parentObjectId).toBe(ibs.id)
    // 5 containers + customer + mainframe + email
    expect(container.objectIds.length).toBe(8)
    const boundary = m.groups.find((g) => g.id === container.groupIds[0])!
    expect(boundary.parentObjectId).toBe(ibs.id)
    expect(boundary.objectIds.length).toBe(5)
  })

  it('component diagram = focal components + externals', () => {
    const component = m.diagrams.find((d) => d.type === 'component')!
    const api = obj('API Application')!
    expect(component.parentObjectId).toBe(api.id)
    // 6 components + spa + mobileApp + database + email + mainframe
    expect(component.objectIds.length).toBe(11)
  })

  it('connections resolve and dedupe', () => {
    expect(m.connections.length).toBeGreaterThanOrEqual(20)
    const customer = obj('Personal Banking Customer')!
    const ibs = obj('Internet Banking System')!
    expect(m.connections.some((c) => c.fromId === customer.id && c.toId === ibs.id)).toBe(true)
  })

  it('picks a System Landscape as the entry diagram', () => {
    const entry = m.diagrams.find((d) => d.id === m.entryDiagramId)!
    expect(entry.type).toBe('context')
    expect(entry.name.toLowerCase()).toContain('landscape')
  })
})

describe('mapWorkspace — autoLayout direction hint', () => {
  let n = 0
  const m = mapWorkspace(parseWorkspace(grouped), { idFactory: () => `id${++n}` })

  it('passes the `autoLayout lr` direction through to layoutHints for the landscape diagram', () => {
    // grouped.dsl declares `systemLandscape "Landscape" { include * autoLayout lr }`.
    const landscape = m.diagrams.find((d) => d.name === 'Landscape')!
    expect(landscape).toBeDefined()
    expect(m.layoutHints[landscape.id]?.direction).toBe('lr')
  })

  it('does not set a direction for diagrams whose view used a bare `autoLayout`', () => {
    // The container view in grouped.dsl uses a bare `autoLayout` (no direction).
    const container = m.diagrams.find((d) => d.type === 'container')!
    expect(m.layoutHints[container.id]?.direction).toBeUndefined()
  })
})

describe('mapWorkspace — a container view shows the neighbours of its CONTAINERS (C4 / Structurizr include *)', () => {
  const dsl = `workspace "T" {
    model {
      mySystem = softwareSystem "My System" {
        web = container "Web" "" "Java"
        api = container "API" "" "Java"
      }
      externalCRM = softwareSystem "External CRM" "" "External"
      billing = softwareSystem "Billing" "" "External"
      mySystem -> externalCRM "Syncs"
      api -> billing "Charges"
      web -> api "Calls"
    }
    views {
      container mySystem { include * autoLayout }
    }
  }`
  let n = 0
  const m = mapWorkspace(parseWorkspace(dsl), { idFactory: () => `id${++n}` })
  const container = m.diagrams.find((d) => d.type === 'container')!

  it('leaves out a system reached only by a relationship on the focal system itself', () => {
    // Regression (user report, saoe.dsl): `mySystem -> externalCRM` is drawn
    // between the system and the CRM. Nothing on the container view stands for
    // `mySystem` but its boundary, so the CRM landed on the canvas with no edge
    // at all. Structurizr's `include *` does not add it either.
    const crm = m.objects.find((o) => o.name === 'External CRM')!
    expect(container.objectIds).not.toContain(crm.id)
    // The focal system itself is NOT rendered as a member of its own drill-down.
    const focal = m.objects.find((o) => o.name === 'My System')!
    expect(container.objectIds).not.toContain(focal.id)
  })

  it('includes a system connected to one of its containers', () => {
    const billing = m.objects.find((o) => o.name === 'Billing')!
    expect(container.objectIds).toContain(billing.id)
  })
})

describe('mapWorkspace — datastore detection from technology/tags (not display name)', () => {
  const dsl = `workspace "Stores" {
    model {
      sys = softwareSystem "Sys" {
        sqlRunner = container "SQL Runner Service" "" "Java"
        snsNotifier = container "SNS Notifier" "" "Go"
        s3Proxy = container "S3 Proxy" "" "Node.js"
        kafkaConsumer = container "Kafka Consumer Service" "" "Java"
        pg = container "Accounts" "" "PostgreSQL"
        maria = container "Ledger" "" "MariaDB"
        redis = container "Hot Data" "" "Redis"
      }
    }
  }`
  let n = 0
  const m = mapWorkspace(parseWorkspace(dsl), { idFactory: () => `id${++n}` })
  const typeOf = (name: string) => m.objects.find((o) => o.name === name)?.type

  it('does not type apps as stores just because the name contains a store keyword', () => {
    expect(typeOf('SQL Runner Service')).toBe('app')
    expect(typeOf('SNS Notifier')).toBe('app')
    expect(typeOf('S3 Proxy')).toBe('app')
    expect(typeOf('Kafka Consumer Service')).toBe('app')
  })

  it('types containers as stores from compound technology names', () => {
    expect(typeOf('Accounts')).toBe('store') // PostgreSQL
    expect(typeOf('Ledger')).toBe('store') // MariaDB
    expect(typeOf('Hot Data')).toBe('store') // Redis
  })
})

describe('mapWorkspace — entry diagram selection prefers a systemLandscape view kind', () => {
  // A systemContext view declared first, plus a systemLandscape view whose key
  // is "Overview" (does not contain "landscape").
  const dsl = `workspace "W" {
    model {
      a = softwareSystem "System A"
      b = softwareSystem "System B"
      a -> b "Uses"
    }
    views {
      systemContext a "ContextFirst" { include * autoLayout }
      systemLandscape "Overview" { include * autoLayout }
    }
  }`
  let n = 0
  const m = mapWorkspace(parseWorkspace(dsl), { idFactory: () => `id${++n}` })

  it('selects the landscape view as the entry even when it is declared last and is not named "landscape"', () => {
    const entry = m.diagrams.find((d) => d.id === m.entryDiagramId)!
    expect(entry.name).toBe('Overview')
  })
})

describe('mapWorkspace — degenerate models still produce a single fallback diagram', () => {
  it('persons-only model with a relationship: one diagram containing both persons', () => {
    const dsl = `workspace "P" {
      model {
        alice = person "Alice"
        bob = person "Bob"
        alice -> bob "Talks to"
      }
    }`
    let n = 0
    const m = mapWorkspace(parseWorkspace(dsl), { idFactory: () => `id${++n}` })
    expect(m.diagrams.length).toBe(1)
    const alice = m.objects.find((o) => o.name === 'Alice')!
    const bob = m.objects.find((o) => o.name === 'Bob')!
    expect(m.diagrams[0].objectIds).toContain(alice.id)
    expect(m.diagrams[0].objectIds).toContain(bob.id)
    expect(m.entryDiagramId).toBe(m.diagrams[0].id)
  })

  it('warns when a relationship references an unknown element and skips it', () => {
    const dsl = `workspace "U" {
      model {
        a = person "A"
        a -> ghost "Uses"
      }
    }`
    let n = 0
    const m = mapWorkspace(parseWorkspace(dsl), { idFactory: () => `id${++n}` })
    expect(m.warnings.join(' ')).toMatch(/referenced unknown elements/i)
    expect(m.connections).toHaveLength(0)
  })

  it('orphan-container model (no system, no person, no views): one catch-all diagram with all objects', () => {
    // No top-level system/person and no views → exercises the degenerate
    // catch-all branch that emits a single diagram with every object.
    const dsl = `workspace "Orphans" {
      model {
        c1 = container "Lonely 1" "" "Java"
        c2 = container "Lonely 2" "" "Go"
      }
    }`
    let n = 0
    const m = mapWorkspace(parseWorkspace(dsl), { idFactory: () => `id${++n}` })
    expect(m.diagrams.length).toBe(1)
    expect(m.diagrams[0].objectIds.length).toBe(m.objects.length)
    expect(m.diagrams[0].objectIds.length).toBe(2)
    expect(m.entryDiagramId).toBe(m.diagrams[0].id)
  })
})

describe('the shared data-store judgement, from the DSL side', () => {
  // `DATASTORE_RE` moved into `structurizr/conventions.ts` so the DSL and JSON
  // importers cannot drift, and the move changed it: bare `elastic` came out
  // (it made every "Elastic Load Balancer" a database) and `elasticache` went
  // in. That is a behaviour change to a SHIPPED importer, so it is asserted on
  // the DSL path too — the JSON fixtures cannot gate this file.
  const workspace = (containers: string) => `workspace {
  model {
    s = softwareSystem "S" {
${containers}
    }
  }
  views {}
}`

  const typeOf = (name: string, technology: string) => {
    const m = mapWorkspace(
      parseWorkspace(workspace(`      c = container "${name}" "" "${technology}"`)),
    )
    return m.objects.find((o) => o.name === name)?.type
  }

  it('does not read an AWS Elastic* product as a data store', () => {
    expect(typeOf('Load balancer', 'Amazon Web Services - Elastic Load Balancing')).toBe('app')
    expect(typeOf('Runtime', 'Elastic Beanstalk')).toBe('app')
  })

  it('still reads the Elastic products that really are stores', () => {
    expect(typeOf('Search', 'Elasticsearch')).toBe('store')
    expect(typeOf('Session cache', 'Amazon ElastiCache')).toBe('store')
  })

  it('never reads the store word off the display NAME', () => {
    expect(typeOf('SQL Runner Service', 'Java')).toBe('app')
    expect(typeOf('Kafka Consumer Service', 'Go')).toBe('app')
  })
})
