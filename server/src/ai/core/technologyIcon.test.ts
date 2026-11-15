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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import type { Pool } from 'pg'
import { ModelSession, upsertModelEntities } from './modelOps.js'
import type { AiToolCtx } from './toolContext.js'
import { executeAiTool } from './toolRegistry.js'
import { TechnologyRepository } from '../../technologies/repository.js'
import type { TechnologyView } from '../../technologies/types.js'

/**
 * Regression: assign_technology / remove_technology must apply the editor's
 * shape-icon rules (src/lib/technologyUsage.ts assignTechnologyUsage /
 * removeTechnologyUsage). Before the fix an AI-assigned Technology never set
 * `icon` / `iconAssignment`, so its logo never reached the canvas.
 *
 * Every assertion reads the STORED document through a fresh ModelSession —
 * never the tool's return value or the ctx session cache.
 */

const ORG = 'org-test'

function technology(id: string, name: string, revision = 2, defaultRole = 'runtime'): TechnologyView {
  return {
    id,
    scope: 'public',
    ownerOrgId: null,
    lifecycleStatus: 'active',
    canonicalTechnologyId: null,
    canonicalTechnologyName: null,
    redirectedFromIds: [],
    revision: {
      revision,
      status: 'approved',
      privateApproved: true,
      name,
      description: null,
      websiteUrl: null,
      documentationUrl: null,
      aliases: [],
      category: 'Runtime',
      iconLightPath: `/icons/${id}-r${revision}-light.svg`,
      iconDarkPath: `/icons/${id}-r${revision}-dark.svg`,
      publisher: null,
      ecosystem: null,
      recommendedShapeTypes: ['app', 'component', 'group'],
      defaultRole,
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: null,
      submittedBy: null,
      decisionNote: null,
    },
    orgState: 'enabled',
    orgOverride: null,
  } as unknown as TechnologyView
}

let catalog: Record<string, TechnologyView> = {}
beforeEach(() => {
  catalog = {
    'tech-node': technology('tech-node', 'Node.js'),
    'tech-react': technology('tech-react', 'React'),
    'tech-rest': technology('tech-rest', 'REST', 2, 'protocol'),
  }
  vi.spyOn(TechnologyRepository.prototype, 'get').mockImplementation(async (_org, id) => {
    const found = catalog[id]
    return found
      ? { technology: found, resolution: { requestedId: id, canonicalTechnologyId: id, redirected: false, path: [id] } }
      : null
  })
})
afterEach(() => vi.restoreAllMocks())

const app = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'app', name: id, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  position: { x: 0, y: 0 }, size: { width: 160, height: 100 }, ...extra,
})
const group = (id: string) => ({ id, name: id, objectIds: [], position: { x: 0, y: 0 }, size: { width: 300, height: 200 } })
const connection = (id: string) => ({ id, fromId: 'a1', toId: 'a2', label: 'calls', tagAssignments: {}, tagOrder: [] })

async function seedMonolith(repo: Repo, seed: {
  objects?: Record<string, unknown>; groups?: Record<string, unknown>; connections?: Record<string, unknown>
}): Promise<string> {
  const model = repo.create<Record<string, unknown>>({
    objects: seed.objects ?? {}, connections: seed.connections ?? {}, groups: seed.groups ?? {},
    domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  await model.whenReady()
  const shard = repo.create<Record<string, unknown>>({ diagrams: {} })
  await shard.whenReady()
  const root = repo.create<Record<string, unknown>>({ modelUrl: model.url, shardUrls: [shard.url] })
  await root.whenReady()
  return root.url
}

async function seedSharded(repo: Repo, objects: Record<string, unknown>): Promise<string> {
  const objShard = repo.create<Record<string, unknown>>({ objects })
  await objShard.whenReady()
  const connShard = repo.create<Record<string, unknown>>({ connections: {} })
  await connShard.whenReady()
  const meta = repo.create<Record<string, unknown>>({
    objectShardUrls: [objShard.url], connectionShardUrls: [connShard.url],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    deletedObjectIds: [], deletedConnectionIds: [],
  })
  await meta.whenReady()
  const shard = repo.create<Record<string, unknown>>({ diagrams: {} })
  await shard.whenReady()
  const root = repo.create<Record<string, unknown>>({ modelMetaUrl: meta.url, shardUrls: [shard.url] })
  await root.whenReady()
  return root.url
}

function ctxFor(repo: Repo, rootUrl: string): AiToolCtx {
  return {
    repo,
    db: null as unknown as Pool,
    identity: null,
    workspace: { landscapeId: 'default', versionId: 'v1' },
    rootUrl,
    canWrite: true,
    orgId: ORG,
    userId: null,
    userLabel: 'Test AI',
    session: new ModelSession(repo, rootUrl),
    assertWriteOn: async () => {},
  }
}

type Stored = {
  icon?: string
  iconAssignment?: Record<string, unknown>
  technologyUsages?: Record<string, { id: string; technologyId: string }>
  technologyUsageOrder?: string[]
}

/** The stored entity, read through a FRESH session (no ctx cache). */
async function stored(repo: Repo, rootUrl: string, kind: 'objects' | 'groups' | 'connections', id: string): Promise<Stored> {
  const model = await new ModelSession(repo, rootUrl).snapshot()
  return (model[kind] as Record<string, Stored>)[id]
}

function usageIdOf(entity: Stored, technologyId: string): string {
  const usage = Object.values(entity.technologyUsages ?? {}).find((u) => u.technologyId === technologyId)
  if (!usage) throw new Error(`no usage of ${technologyId}`)
  return usage.id
}

const assign = (ctx: AiToolCtx, targetKind: string, targetId: string, technologyId: string) =>
  executeAiTool(ctx, 'assign_technology', { targetKind, targetId, technologyId })
const remove = (ctx: AiToolCtx, targetKind: string, targetId: string, technologyId: string) =>
  executeAiTool(ctx, 'remove_technology', { targetKind, targetId, technologyId })

describe('AI Technology tools apply the editor shape-icon rules', () => {
  it('first Technology on an icon-less object supplies an AUTOMATIC assignment; the second does not take it', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, { objects: { a1: app('a1') } })
    const ctx = ctxFor(repo, rootUrl)

    await assign(ctx, 'object', 'a1', 'tech-node')
    let a1 = await stored(repo, rootUrl, 'objects', 'a1')
    const nodeUsage = usageIdOf(a1, 'tech-node')
    expect(a1.icon).toBe('Node.js')
    expect(a1.iconAssignment).toEqual({
      source: 'technology',
      mode: 'automatic',
      displayName: 'Node.js',
      technologyUsageId: nodeUsage,
      catalogRevision: 2,
      iconLightPath: '/icons/tech-node-r2-light.svg',
      iconDarkPath: '/icons/tech-node-r2-dark.svg',
    })

    await assign(ctx, 'object', 'a1', 'tech-react')
    a1 = await stored(repo, rootUrl, 'objects', 'a1')
    expect(a1.icon).toBe('Node.js')
    expect(a1.iconAssignment).toMatchObject({ mode: 'automatic', technologyUsageId: nodeUsage })
  })

  it('never overwrites an existing icon or assignment', async () => {
    const repo = new Repo({})
    const generic = { source: 'generic', mode: 'explicit', displayName: 'Cloud', iconLightPath: '/g/cloud.svg' }
    const rootUrl = await seedMonolith(repo, {
      objects: { bare: app('bare', { icon: 'Kafka' }), gen: app('gen', { icon: 'Cloud', iconAssignment: generic }) },
    })
    const ctx = ctxFor(repo, rootUrl)
    await assign(ctx, 'object', 'bare', 'tech-node')
    await assign(ctx, 'object', 'gen', 'tech-node')

    const bare = await stored(repo, rootUrl, 'objects', 'bare')
    expect(bare.icon).toBe('Kafka')
    expect(bare.iconAssignment).toBeUndefined()
    const gen = await stored(repo, rootUrl, 'objects', 'gen')
    expect(gen.icon).toBe('Cloud')
    expect(gen.iconAssignment).toEqual(generic)
  })

  it('applies to groups, and never gives a connection an icon', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, {
      objects: { a1: app('a1'), a2: app('a2') },
      groups: { g1: group('g1') },
      connections: { c1: connection('c1') },
    })
    const ctx = ctxFor(repo, rootUrl)
    await assign(ctx, 'group', 'g1', 'tech-node')
    await assign(ctx, 'connection', 'c1', 'tech-rest')

    const g1 = await stored(repo, rootUrl, 'groups', 'g1')
    expect(g1.icon).toBe('Node.js')
    expect(g1.iconAssignment).toMatchObject({ mode: 'automatic', technologyUsageId: usageIdOf(g1, 'tech-node') })
    const c1 = await stored(repo, rootUrl, 'connections', 'c1')
    expect(Object.keys(c1.technologyUsages ?? {})).toHaveLength(1)
    expect(c1.icon).toBeUndefined()
    expect(c1.iconAssignment).toBeUndefined()

    await remove(ctx, 'group', 'g1', 'tech-node')
    const cleared = await stored(repo, rootUrl, 'groups', 'g1')
    expect(cleared.icon).toBeUndefined()
    expect(cleared.iconAssignment).toBeUndefined()
  })

  it('removing the automatic source hands it to the next ORDERED usage, then clears it with the last', async () => {
    catalog['tech-rest'] = technology('tech-rest', 'REST')
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, { objects: { a1: app('a1') } })
    const ctx = ctxFor(repo, rootUrl)
    await assign(ctx, 'object', 'a1', 'tech-node')
    await assign(ctx, 'object', 'a1', 'tech-rest')
    await assign(ctx, 'object', 'a1', 'tech-react')
    // Usage ids are random, so the map's key order is too. Store an order that
    // puts the LAST remaining map key next: the hand-off must follow the stored
    // order, which a map-key-order implementation would get wrong every time.
    const before = await stored(repo, rootUrl, 'objects', 'a1')
    const nodeId = usageIdOf(before, 'tech-node')
    const remainingKeys = Object.keys(before.technologyUsages ?? {}).filter((id) => id !== nodeId)
    const [keyFirst, keyLast] = remainingKeys
    const techOf = (id: string) => before.technologyUsages![id].technologyId
    const nameOf = (id: string) => (techOf(id) === 'tech-react' ? 'React' : 'REST')
    const model = await new ModelSession(repo, rootUrl).snapshot()
    await upsertModelEntities(repo, rootUrl, 'objects', {
      a1: { ...(model.objects as Record<string, object>).a1, technologyUsageOrder: [nodeId, keyLast, keyFirst] },
    }, ctx.workspace)
    ctx.session.invalidate()

    await remove(ctx, 'object', 'a1', 'tech-node')
    let a1 = await stored(repo, rootUrl, 'objects', 'a1')
    expect(a1.icon).toBe(nameOf(keyLast))
    expect(a1.iconAssignment).toEqual({
      source: 'technology',
      mode: 'automatic',
      displayName: nameOf(keyLast),
      technologyUsageId: keyLast,
      catalogRevision: 2,
      iconLightPath: `/icons/${techOf(keyLast)}-r2-light.svg`,
      iconDarkPath: `/icons/${techOf(keyLast)}-r2-dark.svg`,
    })

    await remove(ctx, 'object', 'a1', techOf(keyLast))
    a1 = await stored(repo, rootUrl, 'objects', 'a1')
    expect(a1.icon).toBe(nameOf(keyFirst))
    expect(a1.iconAssignment).toMatchObject({ mode: 'automatic', technologyUsageId: keyFirst })

    await remove(ctx, 'object', 'a1', techOf(keyFirst))
    a1 = await stored(repo, rootUrl, 'objects', 'a1')
    expect(a1.technologyUsages).toEqual({})
    expect(a1.icon).toBeUndefined()
    expect(a1.iconAssignment).toBeUndefined()
  })

  it('removing the usage behind an EXPLICIT assignment clears it even when usages remain; unrelated removals leave it', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, { objects: { a1: app('a1') } })
    const ctx = ctxFor(repo, rootUrl)
    await assign(ctx, 'object', 'a1', 'tech-node')
    await assign(ctx, 'object', 'a1', 'tech-react')
    const seeded = await stored(repo, rootUrl, 'objects', 'a1')
    // Pin React as the explicit icon the way the editor's selectTechnologyAsIcon would.
    const explicit = {
      source: 'technology', mode: 'explicit', displayName: 'React',
      technologyUsageId: usageIdOf(seeded, 'tech-react'), catalogRevision: 2,
    }
    const model = await new ModelSession(repo, rootUrl).snapshot()
    await upsertModelEntities(repo, rootUrl, 'objects', {
      a1: { ...(model.objects as Record<string, object>).a1, icon: 'React', iconAssignment: explicit },
    }, ctx.workspace)
    ctx.session.invalidate()

    await remove(ctx, 'object', 'a1', 'tech-node')
    let a1 = await stored(repo, rootUrl, 'objects', 'a1')
    expect(a1.icon).toBe('React')
    expect(a1.iconAssignment).toEqual(explicit)

    await assign(ctx, 'object', 'a1', 'tech-node')
    await remove(ctx, 'object', 'a1', 'tech-react')
    a1 = await stored(repo, rootUrl, 'objects', 'a1')
    expect(Object.keys(a1.technologyUsages ?? {})).toHaveLength(1)
    expect(a1.icon).toBeUndefined()
    expect(a1.iconAssignment).toBeUndefined()
  })

  it('re-assigning the bound usage at a newer catalog revision refreshes the assignment in its own mode', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, { objects: { a1: app('a1') } })
    const ctx = ctxFor(repo, rootUrl)
    await assign(ctx, 'object', 'a1', 'tech-node')
    catalog['tech-node'] = technology('tech-node', 'Node.js', 3)
    await assign(ctx, 'object', 'a1', 'tech-node')

    const a1 = await stored(repo, rootUrl, 'objects', 'a1')
    expect(a1.iconAssignment).toMatchObject({
      mode: 'automatic',
      technologyUsageId: usageIdOf(a1, 'tech-node'),
      catalogRevision: 3,
      iconLightPath: '/icons/tech-node-r3-light.svg',
    })
  })

  it('an AI icon edit after an AI Technology assignment wins on the canvas and survives the Technology removal', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, { objects: { a1: app('a1'), a2: app('a2') }, groups: { g1: group('g1') } })
    const ctx = ctxFor(repo, rootUrl)
    await assign(ctx, 'object', 'a1', 'tech-node')
    await assign(ctx, 'group', 'g1', 'tech-node')

    await executeAiTool(ctx, 'update_model_object', { id: 'a1', icon: 'Docker' })
    await executeAiTool(ctx, 'update_group', { id: 'g1', icon: 'Docker' })
    // The canvas draws iconAssignment before icon, so a leftover automatic
    // Node.js assignment would keep showing Node.js. Choosing an icon replaces
    // it with the picker's GENERIC assignment, which no usage removal can touch.
    for (const [kind, id] of [['objects', 'a1'], ['groups', 'g1']] as const) {
      const entity = await stored(repo, rootUrl, kind, id)
      expect(entity.icon).toBe('Docker')
      expect(entity.iconAssignment).toMatchObject({ source: 'generic', mode: 'explicit', displayName: 'Docker' })
    }

    await remove(ctx, 'object', 'a1', 'tech-node')
    const afterRemoval = await stored(repo, rootUrl, 'objects', 'a1')
    expect(afterRemoval.icon).toBe('Docker')
    expect(afterRemoval.iconAssignment).toMatchObject({ source: 'generic', displayName: 'Docker' })

    await assign(ctx, 'object', 'a2', 'tech-node')
    await executeAiTool(ctx, 'update_model_object', { id: 'a2', icon: null })
    const a2 = await stored(repo, rootUrl, 'objects', 'a2')
    expect(a2.icon).toBeUndefined()
    expect(a2.iconAssignment).toBeUndefined()
  })

  it('sharded workspace: the overlay write stores the assignment and drops it on removal', async () => {
    const repo = new Repo({})
    const rootUrl = await seedSharded(repo, { a1: app('a1') })
    const ctx = ctxFor(repo, rootUrl)
    await assign(ctx, 'object', 'a1', 'tech-node')
    let a1 = await stored(repo, rootUrl, 'objects', 'a1')
    expect(a1.icon).toBe('Node.js')
    expect(a1.iconAssignment).toMatchObject({ mode: 'automatic', technologyUsageId: usageIdOf(a1, 'tech-node') })

    await remove(ctx, 'object', 'a1', 'tech-node')
    a1 = await stored(repo, rootUrl, 'objects', 'a1')
    expect(a1.icon).toBeUndefined()
    expect(a1.iconAssignment).toBeUndefined()
  })
})
