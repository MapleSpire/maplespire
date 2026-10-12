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
import {
  assignTechnologyUsage,
  assignTechnologyUsages,
  assertTechnologyUsageIdentityPreserved,
  canAssignTechnologyToShape,
  createTechnologyUsage,
  isTechnologyRecommendedForShape,
  orderedTechnologyUsages,
  removeTechnologyUsage,
  reorderTechnologyUsage,
  replaceTechnologyUsage,
  selectGenericShapeIcon,
  selectTechnologyAsIcon,
  seededTechnologyId,
  seededTechnologyUsages,
  technologyNamesOf,
} from './technologyUsage'

describe('technology usage contract', () => {
  it('uses the same deterministic starter-catalog ids as the server seed', () => {
    expect(seededTechnologyId('React')).toBe('tech_seed_react')
    expect(seededTechnologyId('Node.js')).toBe('tech_seed_nodejs')
    expect(seededTechnologyId('Apache Kafka')).toBe('tech_seed_kafka')
    expect(seededTechnologyId('C#')).toBe('tech_seed_csharp')
    expect(seededTechnologyId('C++')).toBe('tech_seed_cpp')
    expect(seededTechnologyUsages('seed', ['PostgreSQL']).tu_seed_0_postgresql.catalogRevision).toBe(2)
  })

  it('builds an immutable identity snapshot and keeps per-object version metadata separate', () => {
    const iconDarkPath = `/assets/technologies/${'a'.repeat(64)}.svg`
    const usage = createTechnologyUsage({
      id: 'usage-1',
      technologyId: 'tech_seed_angular',
      catalogRevision: 3,
      name: 'Angular',
      usedVersion: '21',
      role: 'framework',
      defaultRole: 'framework',
      recommendedShapeTypes: ['app', 'component'],
      iconDarkPath,
    })
    expect(usage).toEqual({
      id: 'usage-1',
      technologyId: 'tech_seed_angular',
      catalogRevision: 3,
      usedVersion: '21',
      role: 'framework',
      snapshot: {
        schemaVersion: 1,
        name: 'Angular',
        iconDarkPath,
        recommendedShapeTypes: ['app', 'component'],
        defaultRole: 'framework',
      },
    })
  })

  it('applies the catalog role as an editable per-object default', () => {
    const usage = createTechnologyUsage({
      id: 'postgres-on-store',
      name: 'PostgreSQL',
      recommendedShapeTypes: ['store'],
      defaultRole: 'database',
    })

    expect(usage.role).toBe('database')
    expect(usage.snapshot.defaultRole).toBe('database')
    expect(usage.snapshot.recommendedShapeTypes).toEqual(['store'])
    expect({ ...usage, role: 'storage' }.role).toBe('storage')
  })

  it('warns for non-recommended object and group types, including actors', () => {
    expect(isTechnologyRecommendedForShape(['store'], 'store')).toBe(true)
    expect(isTechnologyRecommendedForShape(['store', 'component'], 'component')).toBe(true)
    expect(isTechnologyRecommendedForShape(['store'], 'app')).toBe(false)
    expect(isTechnologyRecommendedForShape(['group'], 'group')).toBe(true)
    expect(isTechnologyRecommendedForShape(['system'], 'actor')).toBe(false)
    // Unknown guidance remains compatible for old imports/offline snapshots.
    expect(isTechnologyRecommendedForShape(undefined, 'actor')).toBe(true)
    expect(canAssignTechnologyToShape('actor')).toBe(false)
    expect(canAssignTechnologyToShape('group')).toBe(true)
  })

  it('uses the new catalog default on replacement unless the old role was customized', () => {
    const previousDefault = createTechnologyUsage({
      id: 'old-default', name: 'PostgreSQL', defaultRole: 'database', role: 'database',
    })
    const previousOverride = { ...previousDefault, id: 'old-override', role: 'storage' as const }
    const replacement = createTechnologyUsage({
      id: 'replacement', name: 'Angular', defaultRole: 'framework',
    })

    expect(replaceTechnologyUsage(previousDefault, replacement).role).toBe('framework')
    expect(replaceTechnologyUsage(previousOverride, replacement).role).toBe('storage')
  })

  it('creates id-keyed deterministic fixture records rendered from snapshots', () => {
    const technologyUsages = seededTechnologyUsages('checkout', ['Node.js', 'PostgreSQL'])
    expect(Object.keys(technologyUsages)).toEqual([
      'tu_checkout_0_nodejs',
      'tu_checkout_1_postgresql',
    ])
    expect(technologyNamesOf({ technologyUsages })).toEqual(['Node.js', 'PostgreSQL'])
    expect(technologyUsages.tu_checkout_1_postgresql).toMatchObject({
      catalogRevision: 2,
      role: 'database',
      snapshot: {
        recommendedShapeTypes: ['store'],
        defaultRole: 'database',
      },
    })
  })

  it('never emits incomplete governed metadata for the public starter catalog', () => {
    const publicNames = [
      '.NET', 'Angular', 'Apache Kafka', 'Azure Blob', 'Azure Functions', 'Azure SQL',
      'Blob Store', 'C#', 'C++', 'Cassandra', 'Docker', 'DynamoDB', 'Elasticsearch',
      'Envoy', 'Erlang', 'Flink', 'Go', 'Grafana', 'GraphQL', 'gRPC', 'Hack', 'Java',
      'Kotlin', 'Memcached', 'MongoDB', 'MySQL', 'NestJS', 'nginx', 'Node.js',
      'PostgreSQL', 'Power Platform', 'Prometheus', 'Python', 'RabbitMQ', 'React',
      'Redis', 'REST', 'Ruby', 'Rust', 'S3', 'Scala', 'Spark', 'Swift', 'Terraform',
      'TypeScript', 'Vue', 'Xamarin',
    ]
    const usages = seededTechnologyUsages('catalog', publicNames)
    for (const usage of Object.values(usages)) {
      expect(usage.catalogRevision).toBe(2)
      expect(usage.snapshot.recommendedShapeTypes?.length).toBeGreaterThan(0)
      expect(usage.snapshot.defaultRole).toBeTruthy()
      expect(usage.role).toBe(usage.snapshot.defaultRole)
    }

    // Older demo-only names still get neutral, explicit guidance rather than a
    // misleadingly incomplete rev2 snapshot.
    const fallback = Object.values(seededTechnologyUsages('legacy-demo', ['Firebase Auth']))[0]
    expect(fallback.snapshot.recommendedShapeTypes).toEqual(['system', 'app', 'store', 'component', 'group'])
    expect(fallback.snapshot.defaultRole).toBe('other')
    expect(fallback.role).toBe('other')
  })

  it('requires a fresh usage id when catalog identity, revision or snapshot changes', () => {
    const current = seededTechnologyUsages('api', ['Node.js'])
    const [id] = Object.keys(current)
    expect(() => assertTechnologyUsageIdentityPreserved(current, {
      [id]: { ...current[id], catalogRevision: 3 },
    })).toThrow(/immutable/)
    expect(() => assertTechnologyUsageIdentityPreserved(current, {
      [id]: { ...current[id], usedVersion: '22', role: 'runtime' },
    })).not.toThrow()
    expect(() => assertTechnologyUsageIdentityPreserved(current, {
      [id]: {
        ...current[id],
        snapshot: { ...current[id].snapshot, recommendedShapeTypes: ['system'] },
      },
    })).toThrow(/immutable/)
    expect(() => assertTechnologyUsageIdentityPreserved(current, {
      replacement: { ...current[id], id: 'replacement', catalogRevision: 3 },
    })).not.toThrow()
  })

  it('persists functional order independently from map key order', () => {
    const technologyUsages = seededTechnologyUsages('ordered', ['Node.js', 'PostgreSQL', 'Redis'])
    const ids = Object.keys(technologyUsages)
    const technologyUsageOrder = [ids[2], ids[0], ids[1]]

    expect(orderedTechnologyUsages(technologyUsages, technologyUsageOrder)
      .map((usage) => usage.snapshot.name)).toEqual(['Redis', 'Node.js', 'PostgreSQL'])
    expect(reorderTechnologyUsage(technologyUsages, technologyUsageOrder, ids[2], ids[1]))
      .toEqual([ids[0], ids[1], ids[2]])
  })

  it('adds a governed usage once and uses its artwork automatically only on an iconless shape', () => {
    const kimi = createTechnologyUsage({
      id: 'kimi-usage',
      technologyId: 'tech-private-kimi',
      catalogRevision: 4,
      name: 'Kimi',
      iconLightPath: '/assets/technologies/kimi-light.svg',
      iconDarkPath: '/assets/technologies/kimi-dark.svg',
      defaultRole: 'platform',
      recommendedShapeTypes: ['app'],
    })
    const assigned = assignTechnologyUsage({}, kimi)

    expect(Object.keys(assigned.technologyUsages)).toEqual(['kimi-usage'])
    expect(assigned.technologyUsageOrder).toEqual(['kimi-usage'])
    expect(assigned.selectedUsage.role).toBe('platform')
    expect(assigned.iconAssignment).toMatchObject({
      source: 'technology',
      mode: 'automatic',
      technologyUsageId: 'kimi-usage',
      catalogRevision: 4,
      iconDarkPath: '/assets/technologies/kimi-dark.svg',
    })
    expect(assigned.icon).toBe('Kimi')

    const duplicate = assignTechnologyUsage(assigned, { ...kimi, id: 'duplicate-kimi' })
    expect(Object.keys(duplicate.technologyUsages)).toEqual(['kimi-usage'])
    expect(duplicate.selectedUsage.id).toBe('kimi-usage')

    const existingIcon = assignTechnologyUsage({ icon: 'Cloud', iconAssignment: {
      source: 'generic', mode: 'explicit', displayName: 'Cloud',
    } }, kimi)
    expect(existingIcon.icon).toBe('Cloud')
    expect(existingIcon.iconAssignment?.source).toBe('generic')
  })

  it('selects technology or generic artwork with distinct provenance semantics', () => {
    const usages = seededTechnologyUsages('shape', ['Node.js'])
    const node = Object.values(usages)[0]
    const technologySelection = selectTechnologyAsIcon({
      technologyUsages: usages,
      technologyUsageOrder: [node.id],
    }, { ...node, id: 'unused-duplicate' })
    expect(Object.keys(technologySelection.technologyUsages)).toEqual([node.id])
    expect(technologySelection.iconAssignment).toMatchObject({
      source: 'technology', mode: 'explicit', technologyUsageId: node.id,
    })

    const genericSelection = selectGenericShapeIcon(technologySelection, {
      name: 'Cloud outline', iconLightPath: '/icons/light/cloud.svg',
    })
    expect(Object.keys(genericSelection.technologyUsages)).toEqual([node.id])
    expect(genericSelection.iconAssignment).toEqual({
      source: 'generic', mode: 'explicit', displayName: 'Cloud outline',
      iconLightPath: '/icons/light/cloud.svg',
    })
  })

  it('keeps icon provenance stable on reorder and handles source removal by assignment mode', () => {
    const technologyUsages = seededTechnologyUsages('remove', ['Node.js', 'PostgreSQL'])
    const [node, postgres] = Object.values(technologyUsages)
    const selected = selectTechnologyAsIcon({ technologyUsages }, node)
    const reordered = reorderTechnologyUsage(
      selected.technologyUsages,
      selected.technologyUsageOrder,
      node.id,
      postgres.id,
    )
    expect(selected.iconAssignment?.technologyUsageId).toBe(node.id)
    expect(reordered[1]).toBe(node.id)

    const blocked = removeTechnologyUsage({ ...selected, technologyUsageOrder: reordered }, node.id)
    expect(blocked.blocked).toBe(true)
    const confirmed = removeTechnologyUsage({ ...selected, technologyUsageOrder: reordered }, node.id, {
      allowExplicitIconRemoval: true,
    })
    expect(confirmed.blocked).toBe(false)
    if (!confirmed.blocked) {
      expect(confirmed.icon).toBeUndefined()
      expect(confirmed.iconAssignment).toBeUndefined()
    }

    const nodeAutomatic = assignTechnologyUsage({}, node)
    const automatic = assignTechnologyUsage(nodeAutomatic, postgres)
    const fallback = removeTechnologyUsage(automatic, node.id)
    expect(fallback.blocked).toBe(false)
    if (!fallback.blocked) {
      expect(fallback.icon).toBe('PostgreSQL')
      expect(fallback.iconAssignment?.technologyUsageId).toBe(postgres.id)
      expect(fallback.iconAssignment?.mode).toBe('automatic')
    }
  })
})

describe('assignTechnologyUsages (staged basket)', () => {
  const usage = (id: string, technologyId: string, name: string) => createTechnologyUsage({
    id,
    technologyId,
    catalogRevision: 1,
    name,
  })

  it('keeps every staged technology, in the order it was staged', () => {
    const staged = [
      usage('u-1', 'tech_seed_react', 'React'),
      usage('u-2', 'tech_seed_postgresql', 'PostgreSQL'),
      usage('u-3', 'tech_seed_kafka', 'Apache Kafka'),
    ]
    const next = assignTechnologyUsages({}, staged)

    expect(next.technologyUsageOrder).toEqual(['u-1', 'u-2', 'u-3'])
    expect(technologyNamesOf(next)).toEqual(['React', 'PostgreSQL', 'Apache Kafka'])
    expect(next.addedCount).toBe(3)
  })

  it('is why the caller may not just loop the single-item assign', () => {
    // Each call reads the entity captured in the render closure, so looping
    // from the caller means every whole-map write is computed from the SAME
    // starting state and the last one wins. This is the regression the fold
    // exists to prevent — assert the broken shape really does lose data, so
    // nobody "simplifies" the fold back into a forEach.
    const staged = [
      usage('u-1', 'tech_seed_react', 'React'),
      usage('u-2', 'tech_seed_postgresql', 'PostgreSQL'),
    ]
    const looped = staged.map((entry) => assignTechnologyUsage({}, entry))
    expect(technologyNamesOf(looped[looped.length - 1])).toEqual(['PostgreSQL'])

    expect(technologyNamesOf(assignTechnologyUsages({}, staged))).toEqual(['React', 'PostgreSQL'])
  })

  it('takes the automatic shape icon once, from the first staged technology', () => {
    const next = assignTechnologyUsages({}, [
      usage('u-1', 'tech_seed_react', 'React'),
      usage('u-2', 'tech_seed_postgresql', 'PostgreSQL'),
    ])
    expect(next.icon).toBe('React')
    expect(next.iconAssignment?.technologyUsageId).toBe('u-1')
    expect(next.iconAssignment?.mode).toBe('automatic')
  })

  it('collapses a staged technology the entity already carries', () => {
    const existing = assignTechnologyUsages({}, [usage('u-1', 'tech_seed_react', 'React')])
    const next = assignTechnologyUsages(existing, [
      usage('u-2', 'tech_seed_react', 'React'),
      usage('u-3', 'tech_seed_postgresql', 'PostgreSQL'),
    ])
    expect(technologyNamesOf(next)).toEqual(['React', 'PostgreSQL'])
    expect(next.addedCount).toBe(1)
  })

  it('applies replaceUsageId to the first item only', () => {
    const existing = assignTechnologyUsages({}, [usage('u-1', 'tech_seed_react', 'React')])
    const next = assignTechnologyUsages(existing, [
      usage('u-2', 'tech_seed_vue', 'Vue'),
      usage('u-3', 'tech_seed_postgresql', 'PostgreSQL'),
    ], { replaceUsageId: 'u-1' })

    expect(technologyNamesOf(next)).toEqual(['Vue', 'PostgreSQL'])
    expect(next.technologyUsages['u-1']).toBeUndefined()
  })

  it('leaves the entity untouched for an empty basket', () => {
    const existing = assignTechnologyUsages({}, [usage('u-1', 'tech_seed_react', 'React')])
    const next = assignTechnologyUsages(existing, [])
    expect(technologyNamesOf(next)).toEqual(['React'])
    expect(next.addedCount).toBe(0)
  })
})
