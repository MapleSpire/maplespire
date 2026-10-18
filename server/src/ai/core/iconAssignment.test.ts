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
import { findIcon } from './tools/icons.js'

/**
 * Regression, defect 2026-10-17: the AI tools stored `icon: <catalog name>`
 * alone, and the canvas draws a logo only from `iconAssignment` paths — so
 * every shape the AI "gave a logo" rendered a letter badge. Each icon write
 * must persist the same generic assignment the editor's icon picker writes
 * (src/lib/technologyUsage.ts genericIconAssignment), read back from the
 * STORED document, not from a tool's echo.
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

/** The stored entity, through a FRESH session (no tool-side cache). */
async function stored(repo: Repo, rootUrl: string, kind: 'objects' | 'groups', id: string) {
  const model = await new ModelSession(repo, rootUrl).snapshot()
  return (model[kind] as Record<string, Record<string, unknown>>)[id]
}

async function storedByName(repo: Repo, rootUrl: string, name: string) {
  const model = await new ModelSession(repo, rootUrl).snapshot()
  return Object.values(model.objects as Record<string, Record<string, unknown>>).find((o) => o.name === name)
}

/** What the editor writes when the user picks `name` in the icon picker. */
function pickerAssignment(name: string) {
  const entry = findIcon(name)!
  expect(entry.iconLight ?? entry.iconDark).toBeTruthy()
  return {
    source: 'generic',
    mode: 'explicit',
    displayName: entry.name,
    ...(entry.iconLight ? { iconLightPath: entry.iconLight } : {}),
    ...(entry.iconDark ? { iconDarkPath: entry.iconDark } : {}),
  }
}

describe('AI icon writes carry the artwork assignment the renderer draws', () => {
  it('create_architecture: systems, containers and components (the FoodDash shape)', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, {})
    const ctx = ctxFor(repo, rootUrl)

    const result = (await executeAiTool(ctx, 'create_architecture', {
      systems: [
        {
          name: 'FoodDash Platform',
          description: 'Ordering platform',
          icon: 'kubernetes', // lowercase: canonicalized
          containers: [
            {
              kind: 'app', name: 'Order API', description: 'Orders', icon: 'NodeJS',
              components: [{ name: 'Checkout', description: 'Checkout flow', icon: 'Java' }],
            },
            { kind: 'store', name: 'Order DB', description: 'Orders store', icon: 'PostgreSQL' },
          ],
        },
        { name: 'Stripe', description: 'Payments', external: true, icon: 'Stripe' },
        { name: 'Ghost', description: 'Unknown icon', icon: 'NotARealIconXYZ' },
      ],
    })) as { warnings?: string[] }

    expect((await storedByName(repo, rootUrl, 'FoodDash Platform'))).toMatchObject({
      icon: 'Kubernetes', iconAssignment: pickerAssignment('Kubernetes'),
    })
    expect(await storedByName(repo, rootUrl, 'Order API')).toMatchObject({
      icon: 'NodeJS', iconAssignment: pickerAssignment('NodeJS'),
    })
    expect(await storedByName(repo, rootUrl, 'Checkout')).toMatchObject({
      icon: 'Java', iconAssignment: pickerAssignment('Java'),
    })
    expect(await storedByName(repo, rootUrl, 'Order DB')).toMatchObject({
      icon: 'PostgreSQL', iconAssignment: pickerAssignment('PostgreSQL'),
    })
    expect(await storedByName(repo, rootUrl, 'Stripe')).toMatchObject({
      icon: 'Stripe', iconAssignment: pickerAssignment('Stripe'),
    })

    // A name not in the catalog: entity created, neither field written, warned.
    const ghost = await storedByName(repo, rootUrl, 'Ghost')
    expect(ghost).toBeDefined()
    expect(ghost!.icon).toBeUndefined()
    expect(ghost!.iconAssignment).toBeUndefined()
    expect(JSON.stringify(result)).toMatch(/Ghost: icon ignored/)
  })

  it('create_model_object writes the assignment; update replaces a technology one; null clears both', async () => {
    const repo = new Repo({})
    const technologyAssignment = {
      source: 'technology', mode: 'automatic', displayName: 'Kotlin', technologyUsageId: 'tu_sysA_kotlin',
    }
    const rootUrl = await seedMonolith(repo, {
      sysA: obj('sysA', 'Payments', { icon: 'Kotlin', iconAssignment: technologyAssignment }),
    })
    const ctx = ctxFor(repo, rootUrl)

    const created = (await executeAiTool(ctx, 'create_model_object', {
      type: 'store', name: 'Ledger DB', icon: 'postgresql',
    })) as { created: { id: string } }
    expect(await stored(repo, rootUrl, 'objects', created.created.id)).toMatchObject({
      icon: 'PostgreSQL', iconAssignment: pickerAssignment('PostgreSQL'),
    })

    const unknown = (await executeAiTool(ctx, 'create_model_object', {
      type: 'app', name: 'Mystery', icon: 'NotARealIconXYZ',
    })) as { created: { id: string } }
    const mystery = await stored(repo, rootUrl, 'objects', unknown.created.id)
    expect(mystery.icon).toBeUndefined()
    expect(mystery.iconAssignment).toBeUndefined()

    await executeAiTool(ctx, 'update_model_object', { id: 'sysA', icon: 'Stripe' })
    expect(await stored(repo, rootUrl, 'objects', 'sysA')).toMatchObject({
      icon: 'Stripe', iconAssignment: pickerAssignment('Stripe'),
    })

    await executeAiTool(ctx, 'update_model_object', { id: 'sysA', icon: null })
    const cleared = await stored(repo, rootUrl, 'objects', 'sysA')
    expect(cleared.icon).toBeUndefined()
    expect(cleared.iconAssignment).toBeUndefined()
  })

  it('create_group / update_group write, replace and clear the assignment', async () => {
    const repo = new Repo({})
    const rootUrl = await seedMonolith(repo, { sysA: obj('sysA', 'Payments') })
    const ctx = ctxFor(repo, rootUrl)

    const created = (await executeAiTool(ctx, 'create_group', {
      name: 'Cluster', objectIds: ['sysA'], icon: 'Kubernetes',
    })) as { created: { id: string } }
    const id = created.created.id
    expect(await stored(repo, rootUrl, 'groups', id)).toMatchObject({
      icon: 'Kubernetes', iconAssignment: pickerAssignment('Kubernetes'),
    })

    await executeAiTool(ctx, 'update_group', { id, icon: 'PostgreSQL' })
    expect(await stored(repo, rootUrl, 'groups', id)).toMatchObject({
      icon: 'PostgreSQL', iconAssignment: pickerAssignment('PostgreSQL'),
    })

    await executeAiTool(ctx, 'update_group', { id, icon: null })
    const cleared = await stored(repo, rootUrl, 'groups', id)
    expect(cleared.icon).toBeUndefined()
    expect(cleared.iconAssignment).toBeUndefined()
  })
})
