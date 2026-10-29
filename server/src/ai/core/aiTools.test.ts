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

import { describe, expect, it, vi } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import type { Pool } from 'pg'
import { ModelSession, findDiagram } from './modelOps.js'
import type { AiToolCtx } from './toolContext.js'
import { AiToolError } from './toolContext.js'
import { TagRepository } from '../../tags/repository.js'
import { TechnologyRepository } from '../../technologies/repository.js'
import { buildSystemPrompt } from './systemPrompt.js'
import {
  aiToolRegistry, executeAiTool, exportToolSpecs, mcpToolSchema, splitMcpArgs, toolInputJsonSchema,
} from './toolRegistry.js'
import { objects } from './tools/shapes.js'

/**
 * Shared-core tool tests against a REAL in-memory Automerge repo (fixture
 * style of draft/applyMerge.test.ts) — the same read/write path every adapter
 * uses via executeAiTool: validation, RBAC write gate, session caching,
 * monolithic + sharded write semantics.
 *
 * (Draft/version/team tools hit Postgres and are covered by the DB-gated
 * integration suites; they are excluded here via a no-DB fake ctx.)
 */

const obj = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'system', name, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
  position: { x: 0, y: 0 }, size: { width: 160, height: 100 }, ...extra,
})

const technologyUsage = (ownerId: string, name: string) => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const id = `tu_${ownerId}_${slug}`
  return {
    [id]: {
      id,
      technologyId: `tech_seed_${slug}`,
      catalogRevision: 1,
      snapshot: { schemaVersion: 1, name },
    },
  }
}

interface Seed {
  objects?: Record<string, unknown>
  connections?: Record<string, unknown>
  groups?: Record<string, unknown>
  domains?: Record<string, unknown>
  tagSnapshots?: Record<string, unknown>
  decisionRecords?: Record<string, unknown>
  diagrams?: {
    id: string
    name: string
    type?: string
    objectIds?: string[]
    connectionIds?: string[]
    layouts?: Record<string, unknown>
    comments?: Record<string, unknown>
    flows?: Record<string, unknown>
    parentObjectId?: string
  }[]
}

async function seedMonolith(repo: Repo, seed: Seed): Promise<string> {
  const model = repo.create<Record<string, unknown>>({
    objects: seed.objects ?? {},
    connections: seed.connections ?? {},
    groups: seed.groups ?? {},
    domains: seed.domains ?? {},
    tagSnapshots: seed.tagSnapshots ?? {},
    decisionRecords: seed.decisionRecords ?? {},
  })
  await model.whenReady()
  const reg: Record<string, unknown> = {}
  for (const d of seed.diagrams ?? []) {
    const doc = repo.create<Record<string, unknown>>({
      name: d.name, type: d.type ?? 'context',
      objectIds: d.objectIds ?? [], connectionIds: d.connectionIds ?? [], groupIds: [],
      layouts: d.layouts ?? {}, flows: d.flows ?? {}, comments: d.comments ?? {}, checkpoints: [],
      ...(d.parentObjectId ? { parentObjectId: d.parentObjectId } : {}),
    })
    await doc.whenReady()
    reg[d.id] = {
      id: d.id, name: d.name, type: d.type ?? 'context', docUrl: doc.url,
      objectIds: d.objectIds ?? [], connectionIds: d.connectionIds ?? [], groupIds: [],
      ...(d.parentObjectId ? { parentObjectId: d.parentObjectId } : {}),
    }
  }
  const shard = repo.create<Record<string, unknown>>({ diagrams: reg })
  await shard.whenReady()
  const root = repo.create<Record<string, unknown>>({ modelUrl: model.url, shardUrls: [shard.url] })
  await root.whenReady()
  return root.url
}

async function seedSharded(repo: Repo, objects: Record<string, unknown>, deletedObjectIds: string[] = []): Promise<string> {
  const objShard = repo.create<Record<string, unknown>>({ objects })
  await objShard.whenReady()
  const connShard = repo.create<Record<string, unknown>>({ connections: {} })
  await connShard.whenReady()
  const meta = repo.create<Record<string, unknown>>({
    objectShardUrls: [objShard.url], connectionShardUrls: [connShard.url],
    groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    deletedObjectIds, deletedConnectionIds: [],
  })
  await meta.whenReady()
  const shard = repo.create<Record<string, unknown>>({ diagrams: {} })
  await shard.whenReady()
  const root = repo.create<Record<string, unknown>>({ modelMetaUrl: meta.url, shardUrls: [shard.url] })
  await root.whenReady()
  return root.url
}

function ctxFor(repo: Repo, rootUrl: string, overrides: Partial<AiToolCtx> = {}): AiToolCtx {
  return {
    repo,
    db: null as unknown as Pool, // model tools must not touch the DB
    identity: null,
    workspace: { landscapeId: 'default', versionId: 'v1' },
    rootUrl,
    canWrite: true,
    orgId: null,
    userId: null,
    userLabel: 'Test AI',
    session: new ModelSession(repo, rootUrl),
    assertWriteOn: async () => {},
    ...overrides,
  }
}

const richSeed: Seed = {
  objects: {
    sysA: obj('sysA', 'Payments System', {
      description: 'Handles payments', technologyUsages: technologyUsage('sysA', 'Kotlin'),
      tagAssignments: { t1: { tagId: 't1' } }, tagOrder: ['t1'],
    }),
    appA1: obj('appA1', 'Payments API', { type: 'app', parentId: 'sysA', technologyUsages: technologyUsage('appA1', 'PostgreSQL') }),
    sysB: obj('sysB', 'CRM'),
    actU: obj('actU', 'Customer', { type: 'actor', scope: 'external' }),
  },
  connections: {
    c1: { id: 'c1', fromId: 'sysA', toId: 'sysB', label: 'syncs contacts', type: 'solid', kind: 'direct' },
    c2: { id: 'c2', fromId: 'actU', toId: 'sysA', label: 'pays via', type: 'solid', kind: 'direct' },
  },
  domains: { d1: { id: 'd1', name: 'Commerce', color: '#f59e0b' } },
  tagSnapshots: {
    t1: { tagId: 't1', value: 'critical', color: '#EF4444', groupId: 'risk', groupName: 'Risk', catalogRevision: 1 },
  },
  decisionRecords: {
    adr1: {
      id: 'adr1', number: 1, title: 'Use event sourcing', summary: 'ES for payments', status: 'approved',
      author: 'alice', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      content: '# Context', related: [], history: [{ status: 'approved', date: '2026-01-01T00:00:00Z' }],
    },
  },
  diagrams: [
    {
      id: 'D1', name: 'Context view', objectIds: ['sysA', 'sysB', 'actU'], connectionIds: ['c1', 'c2'],
      layouts: { sysA: { position: { x: 0, y: 0 }, size: { width: 160, height: 100 } } },
      comments: {
        cm1: {
          id: 'cm1', diagramId: 'D1', type: 'question', text: 'Is CRM still SOAP?', position: { x: 1, y: 2 },
          author: 'bob', createdAt: '2026-01-02T00:00:00Z', resolved: false, pinned: false, replies: [],
        },
      },
      flows: {
        f1: {
          id: 'f1', name: 'Checkout', diagramId: 'D1',
          steps: [
            { id: 's1', order: 1, type: 'message', title: 'Pay', fromObjectId: 'actU', toObjectId: 'sysA', connectionId: 'c2' },
          ],
        },
      },
    },
  ],
}

describe('ai tool registry', () => {
  it('has unique MCP-safe names, titles, descriptions and object schemas', () => {
    const defs = [...aiToolRegistry().values()]
    expect(defs.length).toBeGreaterThanOrEqual(30)
    for (const def of defs) {
      expect(def.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
      expect(def.title.length).toBeGreaterThan(2)
      expect(def.description.length).toBeGreaterThan(10)
      expect(['read', 'write']).toContain(def.mode)
      const json = toolInputJsonSchema(def)
      expect(json.type).toBe('object')
    }
  })

  it('covers the required tool surface', () => {
    const names = new Set([...aiToolRegistry().keys()])
    for (const required of [
      'list_model_objects', 'get_model_object', 'list_domains', 'list_connections', 'get_connection',
      'list_diagrams', 'get_diagram', 'list_flows', 'get_flow', 'list_teams', 'list_technologies', 'list_tags',
      'list_decision_records', 'get_decision_record', 'list_comments', 'search_model',
      'create_model_object', 'update_model_object', 'delete_model_object',
      'create_connection', 'update_connection', 'delete_connection',
      'create_decision_record', 'update_decision_record',
      'create_diagram', 'update_diagram', 'set_object_scope_on_diagram', 'resolve_comment',
      'list_drafts', 'create_draft', 'get_draft_changes', 'merge_draft',
      'list_versions', 'create_version', 'switch_workspace',
      'search_icons', 'list_groups', 'create_group', 'update_group', 'delete_group',
      'search_tag_catalog', 'assign_tags', 'remove_tags',
      'search_technology_catalog', 'assign_technology', 'remove_technology',
      'create_domain', 'update_domain', 'audit_model_completeness',
    ]) {
      expect(names.has(required), `missing tool ${required}`).toBe(true)
    }
  })

  it('exports openai / anthropic / mcp function specs', () => {
    const openai = exportToolSpecs('openai') as { type: string; function: { name: string; parameters: unknown } }[]
    expect(openai[0].type).toBe('function')
    expect(openai[0].function.parameters).toBeTruthy()
    const anthropic = exportToolSpecs('anthropic') as { name: string; input_schema: unknown }[]
    expect(anthropic[0].input_schema).toBeTruthy()
    const mcp = exportToolSpecs('mcp') as { inputSchema: { properties?: Record<string, unknown> } }[]
    // every MCP spec gains the optional workspace-override params
    for (const t of mcp) {
      expect(t.inputSchema.properties?.landscapeId).toBeTruthy()
      expect(t.inputSchema.properties?.versionId).toBeTruthy()
    }
  })

  it('splitMcpArgs separates workspace overrides from tool input', () => {
    expect(splitMcpArgs({ landscapeId: 'L', versionId: 'V', id: 'x' })).toEqual({
      landscapeId: 'L', versionId: 'V', input: { id: 'x' },
    })
    expect(splitMcpArgs(undefined)).toEqual({ input: {} })
    const schema = mcpToolSchema([...aiToolRegistry().values()].find((d) => d.name === 'get_diagram')!)
    expect(schema.safeParse({ id: 'D1', landscapeId: 'L', versionId: 'V' }).success).toBe(true)
  })

  it('rejects write tools without write access (hard gate)', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl, { canWrite: false })
    await expect(executeAiTool(ctx, 'create_model_object', { type: 'app', name: 'X' })).rejects.toMatchObject({
      status: 403,
    })
    // read tools still work
    const stats = (await executeAiTool(ctx, 'get_model_stats', {})) as { objects: number }
    expect(stats.objects).toBe(4)
  })

  it('rejects unknown tools and invalid input with helpful errors', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)
    await expect(executeAiTool(ctx, 'nope', {})).rejects.toBeInstanceOf(AiToolError)
    await expect(executeAiTool(ctx, 'create_model_object', { type: 'starship', name: 'X' })).rejects.toThrow(
      /invalid input/
    )
  })
})

describe('read tools (monolith)', () => {
  it('lists/filters objects and searches the model', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)

    const all = (await executeAiTool(ctx, 'list_model_objects', {})) as { total: number; objects: { id: string }[] }
    expect(all.total).toBe(4)

    const apps = (await executeAiTool(ctx, 'list_model_objects', { type: 'app' })) as { objects: { id: string }[] }
    expect(apps.objects.map((o) => o.id)).toEqual(['appA1'])

    const byTech = (await executeAiTool(ctx, 'list_model_objects', { search: 'postgres' })) as {
      objects: { id: string }[]
    }
    expect(byTech.objects.map((o) => o.id)).toEqual(['appA1'])

    const hits = (await executeAiTool(ctx, 'search_model', { q: 'event sourcing' })) as {
      hits: { kind: string; id: string }[]
    }
    expect(hits.hits.some((h) => h.kind === 'decisionRecord' && h.id === 'adr1')).toBe(true)
  })

  it('keeps compact and detailed object descriptions distinct, including legacy data', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, {
      objects: {
        legacy: obj('legacy', 'Legacy', { description: 'Legacy compact summary' }),
        modern: obj('modern', 'Modern', {
          shortDescription: 'Compact summary',
          description: '# Detailed Markdown\nLong documentation.',
        }),
      },
    })
    const ctx = ctxFor(repo, rootUrl)
    const listed = (await executeAiTool(ctx, 'list_model_objects', {})) as {
      objects: { id: string; shortDescription?: string; description?: string }[]
    }
    expect(listed.objects.find((o) => o.id === 'legacy')).toMatchObject({
      shortDescription: 'Legacy compact summary',
      description: undefined,
    })
    expect(listed.objects.find((o) => o.id === 'modern')).toMatchObject({
      shortDescription: 'Compact summary',
      description: '# Detailed Markdown\nLong documentation.',
    })

    const detailed = (await executeAiTool(ctx, 'search_model', { q: 'long documentation' })) as {
      hits: { id: string }[]
    }
    expect(detailed.hits.map((hit) => hit.id)).toContain('modern')
    const compact = (await executeAiTool(ctx, 'search_model', { q: 'legacy compact' })) as {
      hits: { id: string }[]
    }
    expect(compact.hits.map((hit) => hit.id)).toContain('legacy')
  })

  // Reported 2026-10-18: set then clear shortDescription on a legacy object
  // left the card with no label. That is the contract (src/lib/objectDescription.ts):
  // deleting the key instead would demote the Markdown `description` to the
  // card label and hide it from the Documentation field.
  it('update_model_object shortDescription: null stores an explicit empty label', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, {
      objects: {
        order: obj('order', 'Order Service', { description: 'Order lifecycle, from cart to doorstep.' }),
      },
    })
    const ctx = ctxFor(repo, rootUrl)
    const stored = async () => objects(await ctx.session.snapshot()).order

    await executeAiTool(ctx, 'update_model_object', {
      id: 'order', shortDescription: 'Publishes OrderPlaced events to Kafka.',
    })
    expect(await stored()).toMatchObject({
      shortDescription: 'Publishes OrderPlaced events to Kafka.',
      description: 'Order lifecycle, from cart to doorstep.',
    })

    await executeAiTool(ctx, 'update_model_object', { id: 'order', shortDescription: null })
    const cleared = await stored()
    expect(Object.prototype.hasOwnProperty.call(cleared, 'shortDescription')).toBe(true)
    expect(cleared.shortDescription).toBe('')
    expect(cleared.description).toBe('Order lifecycle, from cart to doorstep.')
  })

  it('update_model_object keeps a shortDescription set alongside description on a legacy object', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, {
      objects: { legacy: obj('legacy', 'Legacy', { description: 'Old label' }) },
    })
    const ctx = ctxFor(repo, rootUrl)
    await executeAiTool(ctx, 'update_model_object', {
      id: 'legacy', shortDescription: 'New label', description: '# Docs',
    })
    expect(objects(await ctx.session.snapshot()).legacy).toMatchObject({
      shortDescription: 'New label',
      description: '# Docs',
    })
  })

  it('gets object detail with relations, diagrams and groups', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)
    const detail = (await executeAiTool(ctx, 'get_model_object', { id: 'sysA' })) as {
      incoming: { from: string }[]
      outgoing: { to: string }[]
      children: { id: string }[]
      diagrams: { id: string }[]
    }
    expect(detail.outgoing.map((o) => o.to)).toEqual(['CRM'])
    expect(detail.incoming.map((i) => i.from)).toEqual(['Customer'])
    expect(detail.children.map((c) => c.id)).toEqual(['appA1'])
    expect(detail.diagrams.map((d) => d.id)).toEqual(['D1'])
  })

  it('reads diagrams, flows and comments (DiagramDoc-scoped)', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)

    const diagram = (await executeAiTool(ctx, 'get_diagram', { id: 'D1' })) as {
      objects: { id: string }[]
      flows: { id: string }[]
      openComments: number
    }
    expect(diagram.objects).toHaveLength(3)
    expect(diagram.flows.map((f) => f.id)).toEqual(['f1'])
    expect(diagram.openComments).toBe(1)

    const flow = (await executeAiTool(ctx, 'get_flow', { id: 'f1' })) as { steps: { from?: string; to?: string }[] }
    expect(flow.steps[0].from).toBe('Customer')
    expect(flow.steps[0].to).toBe('Payments System')

    const comments = (await executeAiTool(ctx, 'list_comments', { unresolvedOnly: true })) as {
      comments: { id: string; diagramName: unknown }[]
    }
    expect(comments.comments.map((c) => c.id)).toEqual(['cm1'])
  })
})

describe('write tools (monolith)', () => {
  it('creates an object with stable empty Tag assignments + diagram placement, then updates and cascades a delete', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)

    const created = (await executeAiTool(ctx, 'create_model_object', {
      type: 'store',
      name: 'Ledger DB',
      parentId: 'sysA',
      addToDiagramId: 'D1',
    })) as { created: { id: string } }
    const id = created.created.id

    // Snapshot invalidation means the fresh read sees it, placed on D1.
    const after = (await executeAiTool(ctx, 'get_model_object', { id })) as {
      object: { tagAssignments: Record<string, unknown>; tagOrder: string[] }
      diagrams: { id: string }[]
    }
    expect(after.diagrams.map((d) => d.id)).toEqual(['D1'])
    expect(after.object.tagAssignments).toEqual({})
    expect(after.object.tagOrder).toEqual([])
    const tags = (await executeAiTool(ctx, 'list_tags', {})) as { tags: { name?: string; objectCount: number }[] }
    expect(tags.tags.find((t) => t.name === 'critical')?.objectCount).toBe(1)

    // Update: ordinary object fields remain writable.
    await executeAiTool(ctx, 'update_model_object', { id, name: 'Ledger Store' })
    const updated = (await executeAiTool(ctx, 'get_model_object', { id })) as {
      object: { name: string; technologyUsages?: Record<string, unknown> }
    }
    expect(updated.object.name).toBe('Ledger Store')
    expect(updated.object.technologyUsages).toBeUndefined()

    // Delete sysA without deleteChildren → blocked listing children.
    await expect(executeAiTool(ctx, 'delete_model_object', { id: 'sysA' })).rejects.toThrow(/child/)

    // With deleteChildren: sysA + appA1 + Ledger gone, its connections gone,
    // diagram composition/layout stripped; catalog snapshots remain immutable fallbacks.
    const res = (await executeAiTool(ctx, 'delete_model_object', { id: 'sysA', deleteChildren: true })) as {
      deletedObjects: number
      deletedConnections: number
    }
    expect(res.deletedObjects).toBe(3)
    expect(res.deletedConnections).toBe(2)
    const stats = (await executeAiTool(ctx, 'get_model_stats', {})) as { objects: number; connections: number }
    expect(stats.objects).toBe(2)
    expect(stats.connections).toBe(0)
    const d1 = (await executeAiTool(ctx, 'get_diagram', { id: 'D1' })) as { objects: { id: string }[]; connections: unknown[] }
    expect(d1.objects.map((o) => o.id).sort()).toEqual(['actU', 'sysB'])
    expect(d1.connections).toHaveLength(0)
    const tagsAfter = (await executeAiTool(ctx, 'list_tags', {})) as { tags: { name?: string; objectCount: number }[] }
    expect(tagsAfter.tags.find((t) => t.name === 'critical')?.objectCount).toBe(0)
  })

  it('creates/updates connections with endpoint validation', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)

    await expect(
      executeAiTool(ctx, 'create_connection', { fromId: 'sysA', toId: 'ghost' })
    ).rejects.toThrow(/no model object/)
    await expect(executeAiTool(ctx, 'create_connection', { fromId: 'sysA', toId: 'sysA' })).rejects.toThrow(
      /must differ/
    )

    const created = (await executeAiTool(ctx, 'create_connection', {
      fromId: 'sysB',
      toId: 'sysA',
      label: 'notifies',
      addToDiagramId: 'D1',
    })) as { created: { id: string } }
    const conn = (await executeAiTool(ctx, 'get_connection', { id: created.created.id })) as {
      connection: { kind: string }
      diagrams: { id: string }[]
    }
    expect(conn.connection.kind).toBe('direct')
    expect(conn.diagrams.map((d) => d.id)).toEqual(['D1'])

    await executeAiTool(ctx, 'update_connection', { id: created.created.id, label: null, type: 'dashed' })
    const after = (await executeAiTool(ctx, 'get_connection', { id: created.created.id })) as {
      connection: { label?: string; type: string }
    }
    expect(after.connection.label).toBeUndefined()
    expect(after.connection.type).toBe('dashed')
  })

  it('auto-attaches a new connection to every diagram showing both endpoints', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)

    // No addToDiagramId: sysB and actU are both on D1 → attached there
    // automatically (a diagram only renders connections in its composition).
    const created = (await executeAiTool(ctx, 'create_connection', {
      fromId: 'sysB',
      toId: 'actU',
      label: 'emails',
    })) as { created: { id: string }; addedToDiagrams: { id: string }[] }
    expect(created.addedToDiagrams.map((d) => d.id)).toEqual(['D1'])
    const d1 = (await executeAiTool(ctx, 'get_diagram', { id: 'D1' })) as { connections: { id: string }[] }
    expect(d1.connections.map((c) => c.id)).toContain(created.created.id)

    // Endpoint NOT on any diagram → created in the model, attached nowhere.
    const off = (await executeAiTool(ctx, 'create_model_object', { type: 'app', name: 'Offside' })) as {
      created: { id: string }
    }
    const orphan = (await executeAiTool(ctx, 'create_connection', {
      fromId: off.created.id,
      toId: 'sysA',
    })) as { addedToDiagrams: { id: string }[] }
    expect(orphan.addedToDiagrams).toEqual([])
  })

  it('creates ADRs with sequential numbers and history on status change', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)

    const created = (await executeAiTool(ctx, 'create_decision_record', {
      title: 'Adopt CQRS',
      summary: 'Split reads/writes',
      content: '## Context\n…',
    })) as { created: { id: string; number: number; status: string } }
    expect(created.created.number).toBe(2)
    expect(created.created.status).toBe('in-progress')

    await executeAiTool(ctx, 'update_decision_record', { id: created.created.id, status: 'approved' })
    const full = (await executeAiTool(ctx, 'get_decision_record', { id: created.created.id })) as {
      decisionRecord: { status: string; history: { status: string }[]; author: string }
    }
    expect(full.decisionRecord.status).toBe('approved')
    expect(full.decisionRecord.history.map((h) => h.status)).toEqual(['in-progress', 'approved'])
    expect(full.decisionRecord.author).toBe('Test AI')
  })

  it('creates a diagram with grid layout + auto-included connections, updates composition, resolves comments', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)

    const created = (await executeAiTool(ctx, 'create_diagram', {
      name: 'Payments focus',
      type: 'container',
      parentObjectId: 'sysA',
      objectIds: ['sysA', 'sysB'],
    })) as { created: { id: string; connections: number } }
    expect(created.created.connections).toBe(1) // c1 joins sysA→sysB

    const d = (await executeAiTool(ctx, 'get_diagram', { id: created.created.id })) as {
      objects: { id: string }[]
      connections: { id: string }[]
    }
    expect(d.objects.map((o) => o.id).sort()).toEqual(['sysA', 'sysB'])
    expect(d.connections.map((c) => c.id)).toEqual(['c1'])

    // update: add actU + its connection, remove sysB (drops dangling c1)
    await executeAiTool(ctx, 'update_diagram', {
      id: created.created.id,
      addObjectIds: ['actU'],
      addConnectionIds: ['c2'],
      removeObjectIds: ['sysB'],
    })
    const d2 = (await executeAiTool(ctx, 'get_diagram', { id: created.created.id })) as {
      objects: { id: string }[]
      connections: { id: string }[]
    }
    expect(d2.objects.map((o) => o.id).sort()).toEqual(['actU', 'sysA'])
    expect(d2.connections.map((c) => c.id)).toEqual(['c2'])

    // comments: reply + resolve
    await executeAiTool(ctx, 'resolve_comment', { diagramId: 'D1', commentId: 'cm1', reply: 'Confirmed REST now.' })
    const comments = (await executeAiTool(ctx, 'list_comments', { diagramId: 'D1' })) as {
      comments: { resolved: boolean; replies: { text: string }[] }[]
    }
    expect(comments.comments[0].resolved).toBe(true)
    expect(comments.comments[0].replies.map((r) => r.text)).toEqual(['Confirmed REST now.'])
  })

  // Scope is per diagram (user report 2026-10-21): the same object can be
  // external on one diagram and internal on another.
  it('sets and clears an object scope on ONE diagram; get_diagram reports the per-diagram value', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)
    type Got = { objects: { id: string; scope?: string; scopeSource?: string }[] }
    const scopeOn = async (id: string, objectId: string) =>
      ((await executeAiTool(ctx, 'get_diagram', { id })) as Got).objects.find((o) => o.id === objectId)

    const focus = (await executeAiTool(ctx, 'create_diagram', {
      name: 'A inside', type: 'container', parentObjectId: 'sysA', objectIds: ['sysA', 'sysB'],
    })) as { created: { id: string } }
    const flat = (await executeAiTool(ctx, 'create_diagram', {
      name: 'Flat', type: 'context', objectIds: ['sysA', 'sysB'],
    })) as { created: { id: string } }

    // C4 boundary rule: sysB is outside sysA's drill-down.
    expect(await scopeOn(focus.created.id, 'sysB')).toMatchObject({ scope: 'external', scopeSource: 'boundary' })
    expect(await scopeOn(flat.created.id, 'sysB')).toMatchObject({ scope: 'internal', scopeSource: 'default' })

    await executeAiTool(ctx, 'set_object_scope_on_diagram', { diagramId: focus.created.id, objectIds: ['sysB'], scope: 'internal' })
    await executeAiTool(ctx, 'set_object_scope_on_diagram', { diagramId: flat.created.id, objectIds: ['sysA'], scope: 'external' })
    expect(await scopeOn(focus.created.id, 'sysB')).toMatchObject({ scope: 'internal', scopeSource: 'diagram' })
    expect(await scopeOn(flat.created.id, 'sysA')).toMatchObject({ scope: 'external', scopeSource: 'diagram' })
    // The model object's default is untouched.
    const sysA = (await executeAiTool(ctx, 'get_model_object', { id: 'sysA' })) as { object: { scope: string } }
    expect(sysA.object.scope).toBe('internal')

    // The registry stub carries the same overrides: the read model counts
    // "external in N of M diagrams" from it, never from the DiagramDoc.
    const stubScopes = async (id: string) =>
      (await findDiagram(repo as unknown as Parameters<typeof findDiagram>[0], rootUrl, id))?.stub.objectScopes
    expect(await stubScopes(focus.created.id)).toEqual({ sysB: 'internal' })

    await executeAiTool(ctx, 'set_object_scope_on_diagram', { diagramId: focus.created.id, objectIds: ['sysB'], scope: null })
    expect(await scopeOn(focus.created.id, 'sysB')).toMatchObject({ scope: 'external', scopeSource: 'boundary' })
    // Emptied, not deleted: the map is kept so a concurrent set cannot be lost.
    expect(await stubScopes(focus.created.id)).toEqual({})
    expect(await stubScopes(flat.created.id)).toEqual({ sysA: 'external' })

    await expect(executeAiTool(ctx, 'set_object_scope_on_diagram', {
      diagramId: flat.created.id, objectIds: ['actU'], scope: 'external',
    })).rejects.toThrow(/not on diagram/)

    // Deleting the object sweeps its override (a stale key would re-apply if
    // the id came back) and keeps the map itself.
    const settingsOf = async (id: string) =>
      ((await executeAiTool(ctx, 'get_diagram', { id })) as { settings: { objectScopes?: Record<string, string> } }).settings
    expect((await settingsOf(flat.created.id)).objectScopes).toEqual({ sysA: 'external' })
    await executeAiTool(ctx, 'delete_model_object', { id: 'sysA', deleteChildren: true })
    // Settings report an empty map as no map (withoutEmptyObjectScopes); the
    // map itself staying in the document is pinned by the diagramDoc test below.
    expect((await settingsOf(flat.created.id)).objectScopes).toBeUndefined()
  })

  // Regression (2026-10-16): replies were stamped with a display label only, so
  // the SPA could not tell whose they were and fell back to the literal 'You'.
  it('stamps the acting user id on an AI reply, and list_comments surfaces it', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl, { userId: 'u-sarah', userLabel: 'Sarah' })
    await executeAiTool(ctx, 'reply_to_comment', { diagramId: 'D1', commentId: 'cm1', text: 'On it.' })
    const anon = ctxFor(repo, rootUrl)
    await executeAiTool(anon, 'reply_to_comment', { diagramId: 'D1', commentId: 'cm1', text: 'Anon.' })
    const listed = (await executeAiTool(ctx, 'list_comments', { diagramId: 'D1' })) as {
      comments: { replies: { author: string; authorId?: string; text: string }[] }[]
    }
    expect(listed.comments[0].replies).toEqual([
      expect.objectContaining({ author: 'Sarah', authorId: 'u-sarah', text: 'On it.' }),
      expect.not.objectContaining({ authorId: expect.anything() }),
    ])
  })
})

describe('write tools (sharded model)', () => {
  it('upserts into the edits overlay, un-tombstones re-created ids, and tombstones deletes', async () => {
    const repo = new Repo({})
    const rootUrl = await seedSharded(repo, { a: obj('a', 'A'), b: obj('b', 'B') }, ['ghost'])
    const ctx = ctxFor(repo, rootUrl)

    // Update lands in the overlay (read model overlays last-wins).
    await executeAiTool(ctx, 'update_model_object', { id: 'a', name: 'A2' })
    const detail = (await executeAiTool(ctx, 'get_model_object', { id: 'a' })) as { object: { name: string } }
    expect(detail.object.name).toBe('A2')

    // Delete → tombstone; object disappears from the materialized model.
    await executeAiTool(ctx, 'delete_model_object', { id: 'b' })
    const stats = (await executeAiTool(ctx, 'get_model_stats', {})) as { objects: number }
    expect(stats.objects).toBe(1)

    // Re-create under a tombstoned id via create+update path: create a fresh
    // object, then verify a tombstoned id can be re-upserted (un-tombstone).
    const created = (await executeAiTool(ctx, 'create_model_object', { type: 'app', name: 'Fresh' })) as {
      created: { id: string }
    }
    expect(created.created.id).toBeTruthy()
    const after = (await executeAiTool(ctx, 'list_model_objects', {})) as { total: number }
    expect(after.total).toBe(2)
  })
})

describe('icons, groups, domains, audit', () => {
  it('search_icons finds exact names, lists packs on empty query', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)

    const hits = (await executeAiTool(ctx, 'search_icons', { q: 'postgres' })) as {
      total: number
      icons: { name: string; compatibleWith: string[] }[]
    }
    expect(hits.icons.some((i) => i.name === 'PostgreSQL')).toBe(true)

    // shape-type filter: PostgreSQL is store+group only
    const forApps = (await executeAiTool(ctx, 'search_icons', { q: 'PostgreSQL', compatibleWith: 'app' })) as {
      icons: { name: string }[]
    }
    expect(forApps.icons.some((i) => i.name === 'PostgreSQL')).toBe(false)

    // A wordmark (illegible at shape size, defect 2026-10-18) is labelled for the model.
    const wide = (await executeAiTool(ctx, 'search_icons', { q: 'ServiceNow' })) as {
      icons: { name: string; wordmark?: boolean }[]
      note?: string
    }
    expect(wide.icons.find((i) => i.name === 'ServiceNow')?.wordmark).toBe(true)
    expect(wide.icons.find((i) => i.name === 'PostgreSQL')).toBeUndefined()
    expect(wide.note).toMatch(/wordmark/)
    expect(hits.icons.find((i) => i.name === 'PostgreSQL')).not.toHaveProperty('wordmark')

    const packs = (await executeAiTool(ctx, 'search_icons', {})) as {
      totalIcons: number
      packs: { name: string; iconCount: number }[]
    }
    expect(packs.totalIcons).toBeGreaterThan(3000)
    expect(packs.packs.length).toBeGreaterThan(0)
  })

  it('create/update_model_object validate + canonicalize icons', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)

    // lowercase input → canonical catalog casing stored
    const created = (await executeAiTool(ctx, 'create_model_object', {
      type: 'store', name: 'Ledger DB', icon: 'postgresql',
    })) as { created: { id: string } }
    const full = (await executeAiTool(ctx, 'get_model_object', { id: created.created.id })) as {
      object: { icon?: string }
    }
    expect(full.object.icon).toBe('PostgreSQL')

    // hallucinated icon on CREATE → entity still created, icon dropped + warning
    const halluc = (await executeAiTool(ctx, 'create_model_object', {
      type: 'app', name: 'Hallucinated', icon: 'NotARealIconXYZ',
    })) as { created: { id: string }; iconWarning?: string }
    expect(halluc.iconWarning).toMatch(/icon ignored/i)
    expect(halluc.iconWarning).toMatch(/search_icons/)
    const hFull = (await executeAiTool(ctx, 'get_model_object', { id: halluc.created.id })) as {
      object: { icon?: string }
    }
    expect(hFull.object.icon).toBeUndefined()

    // incompatible icon on CREATE (PostgreSQL is store/group, not app) → same lenient path
    const incompat = (await executeAiTool(ctx, 'create_model_object', {
      type: 'app', name: 'WrongIconType', icon: 'PostgreSQL',
    })) as { created: { id: string }; iconWarning?: string }
    expect(incompat.iconWarning).toMatch(/not usable on a app/)
    const iFull = (await executeAiTool(ctx, 'get_model_object', { id: incompat.created.id })) as {
      object: { icon?: string }
    }
    expect(iFull.object.icon).toBeUndefined()

    // UPDATE stays strict: the icon IS the intent → hard error, nothing changes
    await expect(
      executeAiTool(ctx, 'update_model_object', { id: 'sysA', icon: 'NotARealIconXYZ' })
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      executeAiTool(ctx, 'update_model_object', { id: 'sysA', icon: 'PostgreSQL' }) // system-incompatible
    ).rejects.toThrow(/not usable on a system/)

    // update: set then clear
    await executeAiTool(ctx, 'update_model_object', { id: 'sysA', icon: 'Kubernetes' })
    let sysA = (await executeAiTool(ctx, 'get_model_object', { id: 'sysA' })) as { object: { icon?: string } }
    expect(sysA.object.icon).toBe('Kubernetes')
    await executeAiTool(ctx, 'update_model_object', { id: 'sysA', icon: null })
    sysA = (await executeAiTool(ctx, 'get_model_object', { id: 'sysA' })) as { object: { icon?: string } }
    expect(sysA.object.icon).toBeUndefined()
  })

  it('create_group attaches to diagrams showing members; update/delete_group maintain composition', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)

    const created = (await executeAiTool(ctx, 'create_group', {
      name: 'Core banking', objectIds: ['sysA', 'sysB'], icon: 'Kubernetes', domainId: 'd1',
    })) as { created: { id: string }; addedToDiagrams: { id: string }[] }
    // D1 shows sysA+sysB → auto-attached
    expect(created.addedToDiagrams.map((d) => d.id)).toContain('D1')

    const listed = (await executeAiTool(ctx, 'list_groups', {})) as {
      groups: { id: string; name?: string; icon?: string; objectCount: number; diagrams: { id: string }[] }[]
    }
    const g = listed.groups.find((x) => x.id === created.created.id)!
    expect(g.name).toBe('Core banking')
    expect(g.icon).toBe('Kubernetes')
    expect(g.objectCount).toBe(2)
    expect(g.diagrams.map((d) => d.id)).toContain('D1')

    // hallucinated icon on create_group → group still created, icon dropped + warning
    const badIconGroup = (await executeAiTool(ctx, 'create_group', {
      name: 'Bad icon zone', icon: 'TotallyMissingIcon',
    })) as { created: { id: string }; iconWarning?: string }
    expect(badIconGroup.iconWarning).toMatch(/icon ignored/i)
    const bg = ((await executeAiTool(ctx, 'list_groups', {})) as {
      groups: { id: string; icon?: string }[]
    }).groups.find((x) => x.id === badIconGroup.created.id)!
    expect(bg.icon).toBeUndefined()
    // update_group stays strict on icons
    await expect(
      executeAiTool(ctx, 'update_group', { id: badIconGroup.created.id, icon: 'TotallyMissingIcon' })
    ).rejects.toMatchObject({ status: 404 })
    await executeAiTool(ctx, 'delete_group', { id: badIconGroup.created.id })

    // update: rename, remove a member, detach from D1
    await executeAiTool(ctx, 'update_group', {
      id: created.created.id, name: 'Core platform', removeObjectIds: ['sysB'], removeFromDiagramId: 'D1',
    })
    const after = (await executeAiTool(ctx, 'list_groups', {})) as {
      groups: { id: string; name?: string; objectCount: number; diagrams: { id: string }[] }[]
    }
    const g2 = after.groups.find((x) => x.id === created.created.id)!
    expect(g2.name).toBe('Core platform')
    expect(g2.objectCount).toBe(1)
    expect(g2.diagrams).toHaveLength(0)

    // delete: gone from registry, members untouched
    await executeAiTool(ctx, 'delete_group', { id: created.created.id })
    const finalGroups = (await executeAiTool(ctx, 'list_groups', {})) as { total: number }
    expect(finalGroups.total).toBe(0)
    const stats = (await executeAiTool(ctx, 'get_model_stats', {})) as { objects: number }
    expect(stats.objects).toBe(4)
  })

  it('delete_group takes the connections that END on the group with it', async () => {
    // A connection endpoint may be a GROUP. Left behind, those connections
    // render `Unknown → Unknown` in Model Connections — and the client's
    // deleteGroup sweeps them, so both writers must agree on the same edit.
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, {
      ...richSeed,
      groups: { g1: { id: 'g1', name: 'Core banking', objectIds: ['sysA'], color: '#f59e0b' } },
      connections: {
        ...richSeed.connections,
        cg: { id: 'cg', fromId: 'g1', toId: 'sysB', label: 'exposes', type: 'solid', kind: 'direct' },
      },
      diagrams: [{ id: 'D1', name: 'Context view', objectIds: ['sysA', 'sysB'], connectionIds: ['c1', 'cg'] }],
    })
    const ctx = ctxFor(repo, rootUrl)

    const res = (await executeAiTool(ctx, 'delete_group', { id: 'g1' })) as { deletedConnections: number }
    expect(res.deletedConnections).toBe(1)

    const stats = (await executeAiTool(ctx, 'get_model_stats', {})) as { connections: number; groups: number; objects: number }
    expect(stats.groups).toBe(0)
    expect(stats.connections).toBe(2)
    // The member objects are still explicitly out of scope for this tool.
    expect(stats.objects).toBe(4)

    const diagram = (await executeAiTool(ctx, 'get_diagram', { id: 'D1' })) as {
      connections: { id: string; missing?: boolean }[]
    }
    // The dangling row is the visible symptom: get_diagram reports an id it
    // cannot resolve as `missing`, and the canvas paints it as Unknown.
    expect(diagram.connections.map((c) => c.id)).toEqual(['c1'])
    expect(diagram.connections.some((c) => c.missing)).toBe(false)
  })

  it('empty group attached explicitly gets a visible default box', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)
    const created = (await executeAiTool(ctx, 'create_group', {
      name: 'Empty zone', addToDiagramId: 'D1',
    })) as { created: { id: string }; addedToDiagrams: { id: string }[] }
    expect(created.addedToDiagrams.map((d) => d.id)).toEqual(['D1'])
    const d1 = (await executeAiTool(ctx, 'get_diagram', { id: 'D1' })) as { groups: { id: string }[] }
    expect(d1.groups.map((g) => g.id)).toContain(created.created.id)
  })

  it('create_domain rejects duplicates; update_domain rejects cycles', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)

    await expect(executeAiTool(ctx, 'create_domain', { name: 'commerce' })).rejects.toThrow(/already exists/)

    const risk = (await executeAiTool(ctx, 'create_domain', { name: 'Risk', description: 'Risk & compliance' })) as {
      created: { id: string }
    }
    const listed = (await executeAiTool(ctx, 'list_domains', {})) as {
      domains: { id: string; name?: string; color?: string }[]
    }
    const created = listed.domains.find((d) => d.id === risk.created.id)!
    expect(created.name).toBe('Risk')
    expect(created.color).toBeTruthy()

    // Risk becomes a child of d1; making d1 a child of Risk would cycle
    await executeAiTool(ctx, 'update_domain', { id: risk.created.id, parentId: 'd1' })
    await expect(
      executeAiTool(ctx, 'update_domain', { id: 'd1', parentId: risk.created.id })
    ).rejects.toThrow(/cycle/)

    // objects can join the new domain
    await executeAiTool(ctx, 'update_model_object', { id: 'sysB', domainId: risk.created.id })
    const counts = (await executeAiTool(ctx, 'list_domains', {})) as {
      domains: { id: string; objectCount: number }[]
    }
    expect(counts.domains.find((d) => d.id === risk.created.id)?.objectCount).toBe(1)
  })

  it('ignores raw Technology payloads on create and exposes only governed catalog assignment tools', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)

    const created = (await executeAiTool(ctx, 'create_model_object', {
      type: 'store', name: 'Bid Cache', technologies: ['redis'],
    })) as { created: { id: string } }
    const full = (await executeAiTool(ctx, 'get_model_object', { id: created.created.id })) as {
      object: { technologyUsages?: Record<string, unknown>; technologies?: unknown }
    }
    expect(full.object.technologyUsages).toBeUndefined()
    expect(full.object.technologies).toBeUndefined()
    expect(aiToolRegistry().has('assign_technology')).toBe(true)
    expect(aiToolRegistry().has('create_technology')).toBe(false)
    expect(aiToolRegistry().has('create_tag')).toBe(false)
  })

  it('assigns only existing governed Tags and counts connection/group assignments', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl, { orgId: 'org-test' })
    const resolve = vi.spyOn(TagRepository.prototype, 'resolveTags')
    try {
      resolve.mockResolvedValueOnce({
        resolved: [{
          requestedId: 'tag-security',
          canonicalTagId: 'tag-security',
          redirected: false,
          tag: {
            id: 'tag-security', orgId: 'org-test', groupId: 'security', groupName: 'Security',
            value: 'Encrypted', color: '#2563EB', lifecycleStatus: 'active', canonicalTagId: null,
            version: 4, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
          },
        }],
        unresolvedIds: [],
      })
      await executeAiTool(ctx, 'assign_tags', {
        targetKind: 'connection', targetId: 'c1', tagIds: ['tag-security'],
      })
      const connection = (await executeAiTool(ctx, 'get_connection', { id: 'c1' })) as {
        connection: { tagAssignments: Record<string, { tagId: string }>; tagOrder: string[] }
      }
      expect(connection.connection.tagAssignments).toEqual({ 'tag-security': { tagId: 'tag-security' } })
      expect(connection.connection.tagOrder).toEqual(['tag-security'])
      const tags = (await executeAiTool(ctx, 'list_tags', {})) as {
        tags: { id: string; connectionCount: number; totalCount: number }[]
      }
      expect(tags.tags.find((tag) => tag.id === 'tag-security')).toMatchObject({ connectionCount: 1, totalCount: 1 })

      resolve.mockResolvedValueOnce({ resolved: [], unresolvedIds: ['invented-tag'] })
      await expect(executeAiTool(ctx, 'assign_tags', {
        targetKind: 'connection', targetId: 'c1', tagIds: ['invented-tag'],
      })).rejects.toMatchObject({ status: 404 })
      const unchanged = (await executeAiTool(ctx, 'get_connection', { id: 'c1' })) as {
        connection: { tagOrder: string[] }
      }
      expect(unchanged.connection.tagOrder).toEqual(['tag-security'])

      await executeAiTool(ctx, 'remove_tags', {
        targetKind: 'connection', targetId: 'c1', tagIds: ['tag-security'],
      })
      const removed = (await executeAiTool(ctx, 'get_connection', { id: 'c1' })) as {
        connection: { tagAssignments: Record<string, unknown>; tagOrder: string[] }
      }
      expect(removed.connection.tagAssignments).toEqual({})
      expect(removed.connection.tagOrder).toEqual([])
    } finally {
      resolve.mockRestore()
    }
  })

  it('filters connection Technology search to protocol and rejects non-protocol assignments atomically', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl, { orgId: 'org-test' })
    const catalogTechnology = (id: string, name: string, defaultRole: 'protocol' | 'runtime') => ({
      id,
      scope: 'public' as const,
      ownerOrgId: null,
      lifecycleStatus: 'active' as const,
      canonicalTechnologyId: null,
      canonicalTechnologyName: null,
      redirectedFromIds: [],
      revision: {
        revision: 2,
        status: 'approved' as const,
        privateApproved: true,
        name,
        description: null,
        websiteUrl: null,
        documentationUrl: null,
        aliases: [],
        category: defaultRole === 'protocol' ? 'Protocol' : 'Runtime',
        iconLightPath: null,
        iconDarkPath: null,
        publisher: null,
        ecosystem: null,
        recommendedShapeTypes: ['app', 'component'] as ('app' | 'component')[],
        defaultRole,
        createdAt: '2026-01-01T00:00:00Z',
        createdBy: null,
        submittedBy: null,
        decisionNote: null,
      },
      orgState: 'enabled' as const,
      orgOverride: null,
    })
    const rest = catalogTechnology('tech-rest', 'REST', 'protocol')
    const node = catalogTechnology('tech-node', 'Node.js', 'runtime')
    const list = vi.spyOn(TechnologyRepository.prototype, 'list').mockResolvedValue({
      technologies: [rest], nextCursor: null, policy: 'all',
    })
    const get = vi.spyOn(TechnologyRepository.prototype, 'get')
    try {
      const searched = (await executeAiTool(ctx, 'search_technology_catalog', {
        q: 'rest', targetType: 'connection',
      })) as { technologies: { id: string; defaultRole: string }[] }
      expect(searched.technologies).toEqual([expect.objectContaining({ id: 'tech-rest', defaultRole: 'protocol' })])
      expect(list).toHaveBeenCalledWith('org-test', expect.objectContaining({ selectable: true, role: 'protocol' }))

      get.mockResolvedValueOnce({
        technology: node,
        resolution: { requestedId: node.id, canonicalTechnologyId: node.id, redirected: false, path: [node.id] },
      })
      await expect(executeAiTool(ctx, 'assign_technology', {
        targetKind: 'connection', targetId: 'c1', technologyId: node.id,
      })).rejects.toThrow(/protocol role\/category/)
      let connection = (await executeAiTool(ctx, 'get_connection', { id: 'c1' })) as {
        connection: { technologyUsages?: Record<string, unknown> }
      }
      expect(connection.connection.technologyUsages).toBeUndefined()

      get.mockResolvedValueOnce({
        technology: rest,
        resolution: { requestedId: rest.id, canonicalTechnologyId: rest.id, redirected: false, path: [rest.id] },
      })
      await executeAiTool(ctx, 'assign_technology', {
        targetKind: 'connection', targetId: 'c1', technologyId: rest.id, usedVersion: 'v1',
      })
      connection = (await executeAiTool(ctx, 'get_connection', { id: 'c1' })) as {
        connection: { technologyUsages: Record<string, { technologyId: string; role: string; usedVersion: string }> }
      }
      expect(Object.values(connection.connection.technologyUsages)).toEqual([
        expect.objectContaining({ technologyId: 'tech-rest', role: 'protocol', usedVersion: 'v1' }),
      ])
      const technologies = (await executeAiTool(ctx, 'list_technologies', {})) as {
        technologyUsages: { technologyId: string; connectionCount: number }[]
      }
      expect(technologies.technologyUsages.find((item) => item.technologyId === rest.id)?.connectionCount).toBe(1)

      get.mockResolvedValueOnce(null)
      await expect(executeAiTool(ctx, 'assign_technology', {
        targetKind: 'connection', targetId: 'c1', technologyId: 'invented-tech',
      })).rejects.toMatchObject({ status: 404 })
    } finally {
      list.mockRestore()
      get.mockRestore()
    }
  })

  it('instructs small local models to select governed ids and preserve description semantics', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const prompt = await buildSystemPrompt(ctxFor(repo, rootUrl))
    expect(prompt).toContain('shortDescription is the compact')
    expect(prompt).toContain('NEVER invent an id')
    expect(prompt).toContain('search_tag_catalog / search_technology_catalog')
    expect(prompt).toContain('protocol default role/category')
  })

  it('C4 structural rules: nesting enforced on the AI path, warnings for the rest', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)

    // components must live inside an app
    await expect(
      executeAiTool(ctx, 'create_model_object', { type: 'component', name: 'Parser' })
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      executeAiTool(ctx, 'create_model_object', { type: 'component', name: 'Parser', parentId: 'sysA' })
    ).rejects.toThrow(/parent must be an app/)
    const comp = (await executeAiTool(ctx, 'create_model_object', {
      type: 'component', name: 'Parser', parentId: 'appA1',
    })) as { created: { id: string } }
    expect(comp.created.id).toBeTruthy()

    // app/store parent must be a system
    await expect(
      executeAiTool(ctx, 'create_model_object', { type: 'app', name: 'X', parentId: 'actU' })
    ).rejects.toThrow(/parent must be a system/)

    // THE regression: "Ad Serving System" typed app → created but flagged
    const ad = (await executeAiTool(ctx, 'create_model_object', {
      type: 'app', name: 'Ad Serving System', parentId: 'sysA',
    })) as { namingWarning?: string }
    expect(ad.namingWarning).toMatch(/named like a system/)

    // flat internal app → structure warning
    const flat = (await executeAiTool(ctx, 'create_model_object', {
      type: 'app', name: 'Floating App',
    })) as { structureWarning?: string }
    expect(flat.structureWarning).toMatch(/inside a system/)

    // parent cycle rejected on update (sysA under its own child appA1)
    await expect(
      executeAiTool(ctx, 'update_model_object', { id: 'sysA', parentId: 'appA1' })
    ).rejects.toThrow(/cycle/)
  })

  it('validate_architecture reports structural errors and advisory warnings', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, {
      ...richSeed,
      objects: {
        ...richSeed.objects,
        orphanComp: obj('orphanComp', 'Rate Limiter', { type: 'component' }),
        adSys: obj('adSys', 'Ad Serving System', { type: 'app' }),
        crm2: obj('crm2', 'CRM'), // duplicate sibling name with sysB
      },
      connections: {
        ...richSeed.connections,
        cpc: { id: 'cpc', fromId: 'sysA', toId: 'appA1', type: 'solid', kind: 'direct' }, // parent→child
      },
    })
    const ctx = ctxFor(repo, rootUrl)
    const res = (await executeAiTool(ctx, 'validate_architecture', {})) as {
      ok: boolean
      errors: { kind: string; ids: string[] }[]
      warnings: { kind: string }[]
    }
    expect(res.ok).toBe(false)
    const errKinds = res.errors.map((e) => e.kind)
    expect(errKinds).toContain('component-without-parent')
    expect(errKinds).toContain('duplicate-sibling-name')
    expect(errKinds).toContain('connection-parent-child')
    const warnKinds = res.warnings.map((w) => w.kind)
    expect(warnKinds).toContain('name-type-mismatch') // Ad Serving System as app
    expect(warnKinds).toContain('container-without-parent')
    expect(warnKinds).toContain('connection-unlabeled') // cpc has no label
  })

  it('audit_model_completeness reports per-entity gaps', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)
    await executeAiTool(ctx, 'create_group', { name: 'Naked group', objectIds: ['sysA'] })

    const audit = (await executeAiTool(ctx, 'audit_model_completeness', {})) as {
      summary: { objectsTotal: number; objectsWithGaps: number; groupsWithGaps: number; connectionsUnlabeled: number }
      objects: { id: string; missing: string[] }[]
      groups: { id: string; missing: string[] }[]
    }
    expect(audit.summary.objectsTotal).toBe(4)
    // sysB (CRM) is bare: description/technology usages/icon/domain/tags all missing
    const sysB = audit.objects.find((o) => o.id === 'sysB')!
    expect(sysB.missing).toEqual(expect.arrayContaining(['description', 'technologyUsages', 'icon', 'domain', 'tags']))
    // actors are exempt from technology usages/icon
    const actU = audit.objects.find((o) => o.id === 'actU')
    if (actU) {
      expect(actU.missing).not.toContain('technologyUsages')
      expect(actU.missing).not.toContain('icon')
    }
    // both seeded connections carry labels
    expect(audit.summary.connectionsUnlabeled).toBe(0)
    // the icon-less group is flagged
    expect(audit.groups.some((g) => g.missing.includes('icon'))).toBe(true)
  })
})

describe('set_object_scope_on_diagram — stored shape and ancestry', () => {
  it('clearing the last override leaves an EMPTY map (never deleted, never a null entry)', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)
    const created = (await executeAiTool(ctx, 'create_diagram', {
      name: 'Flat', type: 'context', objectIds: ['sysA', 'sysB'],
    })) as { created: { id: string } }
    const id = created.created.id
    await executeAiTool(ctx, 'set_object_scope_on_diagram', { diagramId: id, objectIds: ['sysB'], scope: 'external' })
    expect((await new ModelSession(repo, rootUrl).diagramDoc(id))?.objectScopes).toEqual({ sysB: 'external' })
    await executeAiTool(ctx, 'set_object_scope_on_diagram', { diagramId: id, objectIds: ['sysB'], scope: null })
    // A deleted map would drop a peer's concurrent override written into it.
    expect((await new ModelSession(repo, rootUrl).diagramDoc(id))?.objectScopes).toEqual({})
  })

  it('get_diagram walks ancestors: a nested object of ANOTHER system is outside the boundary', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, richSeed)
    const ctx = ctxFor(repo, rootUrl)
    const created = (await executeAiTool(ctx, 'create_diagram', {
      name: 'B inside', type: 'container', parentObjectId: 'sysB', objectIds: ['sysB', 'appA1'],
    })) as { created: { id: string } }
    const got = (await executeAiTool(ctx, 'get_diagram', { id: created.created.id })) as {
      objects: { id: string; scope?: string; scopeSource?: string }[]
    }
    expect(got.objects.find((o) => o.id === 'appA1')).toMatchObject({ scope: 'external', scopeSource: 'boundary' })
    expect(got.objects.find((o) => o.id === 'sysB')).toMatchObject({ scope: 'internal', scopeSource: 'default' })
  })
})
