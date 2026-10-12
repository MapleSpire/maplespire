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
import { Repo } from '@automerge/automerge-repo'
import type { Pool } from 'pg'
import { ModelSession } from './modelOps.js'
import type { AiToolCtx } from './toolContext.js'
import { executeAiTool } from './toolRegistry.js'

/**
 * create_architecture — the atomic nested generator. What matters here:
 * types/parents by construction, name-based connection resolution,
 * validate-all-then-write
 * atomicity, auto diagrams, and a clean validate_architecture afterwards.
 */

const obj = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'system', name, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  position: { x: 0, y: 0 }, size: { width: 160, height: 100 }, ...extra,
})

async function seedMonolith(repo: Repo, objects: Record<string, unknown>): Promise<string> {
  const model = repo.create<Record<string, unknown>>({
    objects, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  await model.whenReady()
  const shard = repo.create<Record<string, unknown>>({ diagrams: {} })
  await shard.whenReady()
  const root = repo.create<Record<string, unknown>>({ modelUrl: model.url, shardUrls: [shard.url] })
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
    orgId: null,
    userId: null,
    userLabel: 'Test AI',
    session: new ModelSession(repo, rootUrl),
    assertWriteOn: async () => {},
  }
}

const uberPayload = {
  domains: [{ name: 'Mobility', description: 'Ride hailing' }],
  actors: [{ name: 'Rider', description: 'Requests and pays for rides' }],
  systems: [
    {
      name: 'Ride Platform',
      description: 'Core ride-hailing platform',
      domain: 'Mobility',
      containers: [
        {
          kind: 'app' as const,
          name: 'Trip API',
          description: 'Trip lifecycle API',
          components: [{ name: 'Fare Calculator', description: 'Computes fares' }],
        },
        {
          kind: 'store' as const,
          name: 'Trip DB',
          description: 'Trips and fares',
          icon: 'PostgreSQL',
        },
      ],
    },
    {
      name: 'Stripe',
      description: 'Payment processing SaaS',
      external: true,
      icon: 'Stripe',
    },
  ],
  connections: [
    { from: 'Rider', to: 'Ride Platform', label: 'requests rides via' },
    { from: 'Trip API', to: 'Trip DB', label: 'reads and writes trips' },
    { from: 'Ride Platform', to: 'Stripe', label: 'charges riders through' },
  ],
}

describe('create_architecture', () => {
  it('builds a complete, valid architecture in one atomic call', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, {})
    const ctx = ctxFor(repo, rootUrl)

    const res = (await executeAiTool(ctx, 'create_architecture', uberPayload)) as {
      created: {
        domains: number; actors: number; systems: number; containers: number
        components: number; connections: number
        diagrams: { id: string; name: string; type: string }[]
      }
      warnings?: string[]
    }
    expect(res.created).toMatchObject({ domains: 1, actors: 1, systems: 2, containers: 2, components: 1, connections: 3 })
    // types + parents by construction, domain inherited, explicit icons validated
    const list = (await executeAiTool(ctx, 'list_model_objects', {})) as {
      objects: { id: string; type: string; name: string; parentId?: string; domainId?: string; icon?: string }[]
    }
    const byName = new Map(list.objects.map((o) => [o.name, o]))
    const platform = byName.get('Ride Platform')!
    const tripApi = byName.get('Trip API')!
    const tripDb = byName.get('Trip DB')!
    const fare = byName.get('Fare Calculator')!
    const stripe = byName.get('Stripe')!
    expect(platform.type).toBe('system')
    expect(tripApi.type).toBe('app')
    expect(tripApi.parentId).toBe(platform.id)
    expect(tripDb.type).toBe('store')
    expect(tripDb.parentId).toBe(platform.id)
    expect(fare.type).toBe('component')
    expect(fare.parentId).toBe(tripApi.id)
    expect(tripApi.domainId).toBe(platform.domainId) // inherited
    expect(tripDb.icon).toBe('PostgreSQL')
    const stripeFull = (await executeAiTool(ctx, 'get_model_object', { id: stripe.id })) as {
      object: { scope: string; icon?: string }
    }
    expect(stripeFull.object.scope).toBe('external')
    expect(stripeFull.object.icon).toBe('Stripe')

    // The architecture generator cannot bypass governed Tag creation with free text.
    const tags = (await executeAiTool(ctx, 'list_tags', {})) as { tags: { name?: string; objectCount: number }[] }
    expect(tags.tags).toEqual([])

    // auto diagrams: context (systems+actors) + one container view
    expect(res.created.diagrams.map((d) => d.type).sort()).toEqual(['container', 'context'])
    const context = res.created.diagrams.find((d) => d.type === 'context')!
    const ctxDiagram = (await executeAiTool(ctx, 'get_diagram', { id: context.id })) as {
      objects: { id: string }[]
      connections: { id: string }[]
    }
    const ctxIds = new Set(ctxDiagram.objects.map((o) => o.id))
    expect(ctxIds).toEqual(new Set([platform.id, stripe.id, byName.get('Rider')!.id]))
    expect(ctxDiagram.connections).toHaveLength(2) // rider→platform, platform→stripe

    // the generated architecture passes the C4 lint with zero errors
    const lint = (await executeAiTool(ctx, 'validate_architecture', {})) as {
      ok: boolean
      errors: unknown[]
    }
    expect(lint.errors).toEqual([])
    expect(lint.ok).toBe(true)
  })

  it('is atomic: a bad connection endpoint writes NOTHING', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, { sysX: obj('sysX', 'Legacy CRM') })
    const ctx = ctxFor(repo, rootUrl)
    await expect(
      executeAiTool(ctx, 'create_architecture', {
        ...uberPayload,
        connections: [{ from: 'Rider', to: 'Tripp API' /* typo */, label: 'uses' }],
      })
    ).rejects.toThrow(/matches nothing/)
    const stats = (await executeAiTool(ctx, 'get_model_stats', {})) as { objects: number; domains: number; diagrams: number }
    expect(stats).toMatchObject({ objects: 1, domains: 0, diagrams: 0 })
  })

  it('rejects name collisions with the existing model, payload duplicates and store components', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, { sysX: obj('sysX', 'Stripe') })
    const ctx = ctxFor(repo, rootUrl)
    await expect(executeAiTool(ctx, 'create_architecture', uberPayload)).rejects.toMatchObject({ status: 409 })

    const fresh = ctxFor(repo, await seedMonolith(repo, {}))
    await expect(
      executeAiTool(fresh, 'create_architecture', {
        systems: [
          { name: 'Twin', description: 'a' },
          { name: 'twin', description: 'b' },
        ],
      })
    ).rejects.toThrow(/duplicate name/)

    await expect(
      executeAiTool(fresh, 'create_architecture', {
        systems: [{
          name: 'S', description: 's',
          containers: [{
            kind: 'store' as const, name: 'DB', description: 'db',
            components: [{ name: 'C', description: 'c' }],
          }],
        }],
      })
    ).rejects.toThrow(/inside an app/)
  })

  it('rejects parent-child connections and resolves endpoints against the existing model', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, { sysX: obj('sysX', 'Legacy CRM') })
    const ctx = ctxFor(repo, rootUrl)
    await expect(
      executeAiTool(ctx, 'create_architecture', {
        systems: [{
          name: 'Shop', description: 's',
          containers: [{ kind: 'app' as const, name: 'Shop API', description: 'a' }],
        }],
        connections: [{ from: 'Shop', to: 'Shop API', label: 'contains' }],
      })
    ).rejects.toThrow(/parent to its own child/)

    // connecting a NEW system to an EXISTING object by name works
    const ok = (await executeAiTool(ctx, 'create_architecture', {
      systems: [{ name: 'Shop', description: 'storefront' }],
      connections: [{ from: 'Shop', to: 'Legacy CRM', label: 'syncs customers to' }],
    })) as { created: { connections: number } }
    expect(ok.created.connections).toBe(1)
  })
})
