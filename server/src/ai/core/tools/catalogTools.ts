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

import { z } from 'zod'
import { ensureDefaultOrg } from '../../../auth/schema.js'
import { TagRepository } from '../../../tags/repository.js'
import { TechnologyRepository } from '../../../technologies/repository.js'
import type { TechnologyRole, TechnologyView } from '../../../technologies/types.js'
import { defineAiTool, type AiToolDef } from '../toolRegistry.js'
import type { AiToolCtx } from '../toolContext.js'
import { AiToolError } from '../toolContext.js'
import { newEntityId, upsertInlineEntities, upsertModelEntities } from '../modelOps.js'
import {
  connections,
  groups,
  objects,
  type ConnView,
  type GroupView,
  type ObjView,
  type TagAssignableView,
  type TechnologyBearingView,
  type TechnologyUsageView,
} from './shapes.js'

/**
 * Governed catalog tools deliberately expose no create operation. The model
 * chooses an existing catalog id, then the server resolves it and constructs
 * the durable offline snapshot. Raw LLM-authored snapshots never cross this
 * boundary.
 */

const targetKind = z.enum(['object', 'connection', 'group'])
const technologyTargetType = z.enum(['system', 'app', 'store', 'component', 'group', 'connection'])
const technologyRole = z.enum([
  'primary', 'language', 'runtime', 'framework', 'library', 'database', 'storage',
  'messaging', 'protocol', 'platform', 'infrastructure', 'tooling', 'other',
])

type TargetKind = z.infer<typeof targetKind>
type CatalogTarget = (ObjView | ConnView | GroupView) & TagAssignableView & TechnologyBearingView

async function organizationId(ctx: AiToolCtx): Promise<string> {
  return ctx.orgId ?? ensureDefaultOrg(ctx.db)
}

function requireTarget(
  model: Awaited<ReturnType<AiToolCtx['session']['snapshot']>>,
  kind: TargetKind,
  id: string,
): CatalogTarget {
  const entity = kind === 'object' ? objects(model)[id] : kind === 'connection' ? connections(model)[id] : groups(model)[id]
  if (!entity) throw new AiToolError(`no ${kind} with id "${id}"`, 404)
  return entity
}

async function persistTarget(ctx: AiToolCtx, kind: TargetKind, id: string, entity: CatalogTarget): Promise<void> {
  if (kind === 'object') await upsertModelEntities(ctx.repo, ctx.rootUrl, 'objects', { [id]: entity }, ctx.workspace)
  else if (kind === 'connection') await upsertModelEntities(ctx.repo, ctx.rootUrl, 'connections', { [id]: entity }, ctx.workspace)
  else await upsertInlineEntities(ctx.repo, ctx.rootUrl, 'groups', { [id]: entity })
}

function orderedIds<T>(values: Record<string, T> | undefined, order: string[] | undefined): string[] {
  const source = values ?? {}
  const seen = new Set<string>()
  return [...(order ?? []), ...Object.keys(source)]
    .filter((id) => source[id] && !seen.has(id) && Boolean(seen.add(id)))
}

function technologyResult(technology: TechnologyView) {
  return {
    id: technology.id,
    name: technology.revision.name,
    scope: technology.scope,
    lifecycleStatus: technology.lifecycleStatus,
    catalogRevision: technology.revision.revision,
    category: technology.revision.category,
    defaultRole: technology.revision.defaultRole,
    recommendedShapeTypes: technology.revision.recommendedShapeTypes,
    description: technology.revision.description,
  }
}

function technologyUsage(
  technology: TechnologyView,
  id: string,
  input: { usedVersion?: string; role?: TechnologyRole; notes?: string },
): TechnologyUsageView {
  const revision = technology.revision
  return {
    id,
    technologyId: technology.id,
    catalogRevision: revision.revision,
    ...(input.usedVersion ? { usedVersion: input.usedVersion } : {}),
    role: input.role ?? revision.defaultRole,
    ...(input.notes ? { notes: input.notes } : {}),
    snapshot: {
      schemaVersion: 1,
      name: revision.name,
      ...(revision.iconLightPath ? { iconLightPath: revision.iconLightPath } : {}),
      ...(revision.iconDarkPath ? { iconDarkPath: revision.iconDarkPath } : {}),
      recommendedShapeTypes: [...revision.recommendedShapeTypes],
      defaultRole: revision.defaultRole,
    },
  }
}

export const catalogTools: AiToolDef[] = [
  defineAiTool({
    name: 'search_tag_catalog',
    title: 'Search governed Tag catalog',
    description:
      'Search or list existing active organization Tags. Returns governed ids for assign_tags; it never creates a Tag.',
    mode: 'read',
    schema: z.object({
      q: z.string().optional().describe('Optional value or group-name search'),
      groupId: z.string().optional().describe('Optional governed Tag Group id'),
      limit: z.number().int().min(1).max(100).optional().describe('Default 50'),
    }),
    execute: async (ctx, input) => {
      const orgId = await organizationId(ctx)
      const result = await new TagRepository(ctx.db).listTags({
        orgId,
        q: input.q,
        groupIds: input.groupId ? [input.groupId] : undefined,
        status: 'active',
        limit: input.limit ?? 50,
      })
      return {
        tags: result.items.map((tag) => ({
          id: tag.id,
          value: tag.value,
          groupId: tag.groupId,
          groupName: tag.groupName,
          color: tag.color,
          catalogRevision: tag.version,
        })),
        nextCursor: result.nextCursor,
        note: 'Use only these governed ids with assign_tags. No Tag creation tool is available.',
      }
    },
  }),
  defineAiTool({
    name: 'assign_tags',
    title: 'Assign existing governed Tags',
    description:
      'Assign existing organization Tags to an object, connection, or group. Every id is resolved from the catalog first; unknown or inactive Tags reject the entire call.',
    mode: 'write',
    schema: z.object({
      targetKind,
      targetId: z.string(),
      tagIds: z.array(z.string().min(1)).min(1).max(50).describe('Governed ids from search_tag_catalog'),
    }),
    execute: async (ctx, input) => {
      const model = await ctx.session.snapshot()
      const current = requireTarget(model, input.targetKind, input.targetId)
      const requested = [...new Set(input.tagIds)]
      const orgId = await organizationId(ctx)
      const resolved = await new TagRepository(ctx.db).resolveTags(orgId, requested)
      const inactive = resolved.resolved.filter(({ tag }) => tag.lifecycleStatus !== 'active')
      if (resolved.unresolvedIds.length || inactive.length) {
        const invalid = [...resolved.unresolvedIds, ...inactive.map(({ requestedId }) => requestedId)]
        throw new AiToolError(
          `Tags must already exist and be active in the organization catalog; invalid ids: ${invalid.join(', ')}`,
          404,
        )
      }

      const assignments = { ...(current.tagAssignments ?? {}) }
      const order = orderedIds(assignments, current.tagOrder)
      const snapshots: Record<string, unknown> = {}
      const assigned: { id: string; value: string; groupName: string }[] = []
      for (const item of resolved.resolved) {
        const tag = item.tag
        if (!assignments[tag.id]) {
          assignments[tag.id] = { tagId: tag.id }
          order.push(tag.id)
        }
        snapshots[tag.id] = {
          tagId: tag.id,
          value: tag.value,
          color: tag.color,
          groupId: tag.groupId,
          groupName: tag.groupName,
          catalogRevision: tag.version,
        }
        assigned.push({ id: tag.id, value: tag.value, groupName: tag.groupName })
      }
      await upsertInlineEntities(ctx.repo, ctx.rootUrl, 'tagSnapshots', snapshots)
      await persistTarget(ctx, input.targetKind, input.targetId, {
        ...current,
        tagAssignments: assignments,
        tagOrder: orderedIds(assignments, order),
      })
      ctx.session.invalidate()
      return { target: { kind: input.targetKind, id: input.targetId }, assigned }
    },
  }),
  defineAiTool({
    name: 'remove_tags',
    title: 'Remove Tag assignments',
    description: 'Remove Tag assignments from an object, connection, or group without changing or deleting the governed Tag catalog.',
    mode: 'write',
    schema: z.object({
      targetKind,
      targetId: z.string(),
      tagIds: z.array(z.string().min(1)).min(1).max(50),
    }),
    execute: async (ctx, input) => {
      const model = await ctx.session.snapshot()
      const current = requireTarget(model, input.targetKind, input.targetId)
      const removals = new Set(input.tagIds)
      const assignments = { ...(current.tagAssignments ?? {}) }
      for (const id of removals) delete assignments[id]
      await persistTarget(ctx, input.targetKind, input.targetId, {
        ...current,
        tagAssignments: assignments,
        tagOrder: orderedIds(assignments, current.tagOrder?.filter((id) => !removals.has(id))),
      })
      ctx.session.invalidate()
      return { target: { kind: input.targetKind, id: input.targetId }, removedTagIds: [...removals] }
    },
  }),
  defineAiTool({
    name: 'search_technology_catalog',
    title: 'Search governed Technology catalog',
    description:
      'Search or list existing selectable organization Technologies. targetType filters compatibility; connection returns only Technologies governed with the protocol role/category.',
    mode: 'read',
    schema: z.object({
      q: z.string().optional().describe('Optional name, alias, publisher, ecosystem, or description search'),
      targetType: technologyTargetType.optional(),
      limit: z.number().int().min(1).max(50).optional().describe('Default 20'),
    }),
    execute: async (ctx, input) => {
      const orgId = await organizationId(ctx)
      const result = await new TechnologyRepository(ctx.db).list(orgId, {
        q: input.q,
        selectable: true,
        limit: input.limit ?? 20,
        ...(input.targetType === 'connection'
          ? { role: 'protocol' as const }
          : input.targetType
            ? { shapeType: input.targetType }
            : {}),
      })
      return {
        technologies: result.technologies.map(technologyResult),
        nextCursor: result.nextCursor,
        note: input.targetType === 'connection'
          ? 'Only governed protocol Technologies are valid for connections.'
          : 'Use only these governed ids with assign_technology. No Technology creation tool is available.',
      }
    },
  }),
  defineAiTool({
    name: 'assign_technology',
    title: 'Assign an existing governed Technology',
    description:
      'Assign one existing selectable Technology to an object, connection, or group. Connections accept only catalog Technologies whose governed default role/category is protocol.',
    mode: 'write',
    schema: z.object({
      targetKind,
      targetId: z.string(),
      technologyId: z.string().min(1).describe('Governed id from search_technology_catalog'),
      usedVersion: z.string().max(120).optional(),
      role: technologyRole.optional().describe('Usage override; connections permit only protocol'),
      notes: z.string().max(2_000).optional(),
    }),
    execute: async (ctx, input) => {
      const model = await ctx.session.snapshot()
      const current = requireTarget(model, input.targetKind, input.targetId)
      const orgId = await organizationId(ctx)
      const resolved = await new TechnologyRepository(ctx.db).get(orgId, input.technologyId, undefined, { selectable: true })
      if (!resolved) {
        throw new AiToolError(
          `Technology "${input.technologyId}" must already exist and be selectable in the organization catalog`,
          404,
        )
      }
      const technology = resolved.technology
      const revision = technology.revision

      if (input.targetKind === 'connection') {
        if (revision.defaultRole !== 'protocol' || (input.role && input.role !== 'protocol')) {
          throw new AiToolError(
            `connections accept only Technologies governed with the protocol role/category; "${revision.name}" is ${revision.defaultRole}`,
            400,
          )
        }
      } else {
        const shapeType = input.targetKind === 'group' ? 'group' : String((current as ObjView).type ?? '')
        if (shapeType === 'actor') throw new AiToolError('actors cannot carry Technology assignments', 400)
        if (!revision.recommendedShapeTypes.includes(shapeType as never)) {
          throw new AiToolError(
            `Technology "${revision.name}" is not governed for ${shapeType || input.targetKind} shapes`,
            400,
          )
        }
      }

      const usages = { ...(current.technologyUsages ?? {}) }
      const existing = Object.values(usages).find((usage) => usage.technologyId === technology.id)
      const usageId = existing?.id ?? `tu_${newEntityId()}`
      const usage = technologyUsage(technology, usageId, {
        usedVersion: input.usedVersion,
        role: input.targetKind === 'connection' ? 'protocol' : input.role,
        notes: input.notes,
      })
      usages[usageId] = usage
      const order = orderedIds(usages, current.technologyUsageOrder)
      if (!order.includes(usageId)) order.push(usageId)
      await persistTarget(ctx, input.targetKind, input.targetId, {
        ...current,
        technologyUsages: usages,
        technologyUsageOrder: order,
      })
      ctx.session.invalidate()
      return {
        target: { kind: input.targetKind, id: input.targetId },
        assigned: { ...technologyResult(technology), usageId, role: usage.role },
        alreadyAssigned: Boolean(existing),
      }
    },
  }),
  defineAiTool({
    name: 'remove_technology',
    title: 'Remove a Technology assignment',
    description: 'Remove a Technology usage from an object, connection, or group without changing or deleting the governed catalog Technology.',
    mode: 'write',
    schema: z.object({
      targetKind,
      targetId: z.string(),
      technologyId: z.string().min(1),
    }),
    execute: async (ctx, input) => {
      const model = await ctx.session.snapshot()
      const current = requireTarget(model, input.targetKind, input.targetId)
      const usages = { ...(current.technologyUsages ?? {}) }
      const removed = Object.values(usages)
        .filter((usage) => usage.technologyId === input.technologyId)
        .map((usage) => usage.id)
      for (const id of removed) delete usages[id]
      await persistTarget(ctx, input.targetKind, input.targetId, {
        ...current,
        technologyUsages: usages,
        technologyUsageOrder: orderedIds(usages, current.technologyUsageOrder?.filter((id) => !removed.includes(id))),
      })
      ctx.session.invalidate()
      return { target: { kind: input.targetKind, id: input.targetId }, removedUsageIds: removed }
    },
  }),
]
