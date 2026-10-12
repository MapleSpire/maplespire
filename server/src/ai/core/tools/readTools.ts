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
import { defineAiTool, type AiToolDef } from '../toolRegistry.js'
import type { AiToolCtx } from '../toolContext.js'
import {
  objects, connections, groups, domains, tagsOf, adrs,
  techNames, truncate, nameOf, orderedTechnologyUsages,
  shortDescriptionOf, detailedDescriptionOf,
  type CommentView, type FlowView,
} from './shapes.js'
import { ICON_COUNT, listIconPacks, searchIcons } from './icons.js'

/**
 * Read tools — list/detail over the workspace model: objects, domains,
 * connections, diagrams + flows, teams/technologies/tags, decision records,
 * comments. Outputs are deliberately COMPACT (id + the fields a model needs
 * to reason/answer), with `get_*` tools for full detail.
 */

const limitParam = z.number().int().min(1).max(200).optional()
  .describe('Max rows to return (default 50, cap 200)')

function objRow(ctx: Awaited<ReturnType<AiToolCtx['session']['snapshot']>>, o: ReturnType<typeof objects>[string]) {
  return {
    id: o.id,
    type: o.type,
    name: o.name,
    shortDescription: truncate(shortDescriptionOf(o), 120),
    description: truncate(detailedDescriptionOf(o)),
    domainId: o.domainId,
    parentId: o.parentId,
    technologyUsages: orderedTechnologyUsages(o).map((usage) => ({
      id: usage.id,
      technologyId: usage.technologyId,
      catalogRevision: usage.catalogRevision,
      name: usage.snapshot.name,
      role: usage.role,
      usedVersion: usage.usedVersion,
    })),
    icon: o.icon,
    tagIds: o.tagOrder ?? Object.keys(o.tagAssignments ?? {}),
    owners: (o.ownerAssignmentOrder ?? Object.keys(o.ownerAssignments ?? {}))
      .map((id) => o.ownerAssignments?.[id])
      .filter(Boolean)
      .map((owner) => ({ id: owner!.id, kind: owner!.kind, name: owner!.name, email: owner!.email })),
    links: o.links ?? [],
    scope: o.scope,
    status: o.status,
  }
}

export const readTools: AiToolDef[] = [
  defineAiTool({
    name: 'list_model_objects',
    title: 'List model objects',
    description:
      'List model objects (actors, systems, apps, stores, components) with optional filters. Returns compact rows; use get_model_object for full detail of one object.',
    mode: 'read',
    schema: z.object({
      type: z.enum(['actor', 'system', 'app', 'store', 'component']).optional()
        .describe('Only objects of this C4 type'),
      domainId: z.string().optional().describe('Only objects in this domain'),
      parentId: z.string().optional().describe('Only direct children of this object'),
      search: z.string().optional().describe('Case-insensitive substring on name/short description/detailed description/technology snapshot'),
      tagId: z.string().optional().describe('Only objects carrying this governed Tag id'),
      tag: z.string().optional().describe('Deprecated compatibility filter: governed Tag id, value, or group name'),
      limit: limitParam,
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const q = input.search?.toLowerCase()
      let rows = Object.values(objects(m))
      if (input.type) rows = rows.filter((o) => o.type === input.type)
      if (input.domainId) rows = rows.filter((o) => o.domainId === input.domainId)
      if (input.parentId) rows = rows.filter((o) => o.parentId === input.parentId)
      if (input.tagId) rows = rows.filter((o) => Boolean(o.tagAssignments?.[input.tagId!]))
      if (input.tag) {
        const wanted = input.tag.toLowerCase()
        const ids = new Set(Object.values(tagsOf(m))
          .filter((tag) => [tag.tagId, tag.value, tag.groupName].some((value) => value?.toLowerCase() === wanted))
          .map((tag) => tag.tagId))
        rows = rows.filter((o) => Boolean(o.tagAssignments?.[input.tag!])
          || Object.keys(o.tagAssignments ?? {}).some((id) => ids.has(id)))
      }
      if (q) {
        rows = rows.filter((o) =>
          [o.name, shortDescriptionOf(o), detailedDescriptionOf(o), ...techNames(o)]
            .some((s) => s?.toLowerCase().includes(q))
        )
      }
      rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      const limit = input.limit ?? 50
      return {
        total: rows.length,
        returned: Math.min(limit, rows.length),
        objects: rows.slice(0, limit).map((o) => objRow(m, o)),
      }
    },
  }),
  defineAiTool({
    name: 'get_model_object',
    title: 'Get model object details',
    description:
      'Full detail of one model object: all fields, its parent/children, incoming+outgoing connections (with peer names), the diagrams it appears on, and its group memberships.',
    mode: 'read',
    schema: z.object({ id: z.string().describe('Object id') }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const o = objects(m)[input.id]
      if (!o) return { error: `no model object with id "${input.id}"` }
      const conns = Object.values(connections(m))
      const incoming = conns
        .filter((c) => c.toId === input.id)
        .map((c) => ({ connectionId: c.id, fromId: c.fromId, from: nameOf(m, c.fromId), label: c.label, kind: c.kind }))
      const outgoing = conns
        .filter((c) => c.fromId === input.id)
        .map((c) => ({ connectionId: c.id, toId: c.toId, to: nameOf(m, c.toId), label: c.label, kind: c.kind }))
      const children = Object.values(objects(m))
        .filter((x) => x.parentId === input.id)
        .map((x) => ({ id: x.id, type: x.type, name: x.name }))
      const onDiagrams = Object.values(m.diagrams)
        .filter((d) => ((d.meta.objectIds as string[] | undefined) ?? []).includes(input.id))
        .map((d) => ({ id: d.id, name: d.meta.name, type: d.meta.type }))
      const inGroups = Object.values(groups(m))
        .filter((g) => (g.objectIds ?? []).includes(input.id))
        .map((g) => ({ id: g.id, name: g.name }))
      const domain = o.domainId ? domains(m)[o.domainId] : undefined
      return {
        object: o,
        domain: domain ? { id: domain.id, name: domain.name } : null,
        parent: o.parentId ? { id: o.parentId, name: nameOf(m, o.parentId) } : null,
        children,
        incoming,
        outgoing,
        diagrams: onDiagrams,
        groups: inGroups,
      }
    },
  }),
  defineAiTool({
    name: 'list_domains',
    title: 'List domains',
    description: 'List all domains (business areas grouping model objects) with object counts.',
    mode: 'read',
    schema: z.object({}),
    execute: async (ctx) => {
      const m = await ctx.session.snapshot()
      const counts = new Map<string, number>()
      for (const o of Object.values(objects(m))) {
        if (o.domainId) counts.set(o.domainId, (counts.get(o.domainId) ?? 0) + 1)
      }
      return {
        domains: Object.values(domains(m)).map((d) => ({
          id: d.id,
          name: d.name,
          description: truncate(d.description),
          parentId: d.parentId,
          color: d.color,
          objectCount: counts.get(d.id) ?? 0,
        })),
      }
    },
  }),
  defineAiTool({
    name: 'list_connections',
    title: 'List model connections',
    description:
      'List model connections (edges between objects), including detailed description, Tags, Technologies and owners. Filter by an object id to get everything touching it.',
    mode: 'read',
    schema: z.object({
      objectId: z.string().optional().describe('Only connections from/to this object'),
      search: z.string().optional().describe('Case-insensitive substring on label, description, endpoint names, or Technology'),
      limit: limitParam,
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      let rows = Object.values(connections(m))
      if (input.objectId) rows = rows.filter((c) => c.fromId === input.objectId || c.toId === input.objectId)
      if (input.search) {
        const q = input.search.toLowerCase()
        rows = rows.filter((c) =>
          [c.label, c.description, nameOf(m, c.fromId), nameOf(m, c.toId), ...techNames(c)]
            .some((s) => s?.toLowerCase().includes(q))
        )
      }
      const limit = input.limit ?? 50
      return {
        total: rows.length,
        returned: Math.min(limit, rows.length),
        connections: rows.slice(0, limit).map((c) => ({
          id: c.id,
          fromId: c.fromId,
          from: nameOf(m, c.fromId),
          toId: c.toId,
          to: nameOf(m, c.toId),
          label: c.label,
          description: truncate(c.description),
          type: c.type,
          kind: c.kind ?? 'direct',
          status: c.status,
          technologyUsages: orderedTechnologyUsages(c).map((usage) => ({
            id: usage.id,
            technologyId: usage.technologyId,
            name: usage.snapshot.name,
            role: usage.role,
            usedVersion: usage.usedVersion,
          })),
          tagIds: c.tagOrder ?? Object.keys(c.tagAssignments ?? {}),
          owners: (c.ownerAssignmentOrder ?? Object.keys(c.ownerAssignments ?? {}))
            .map((id) => c.ownerAssignments?.[id])
            .filter(Boolean)
            .map((owner) => ({ id: owner!.id, kind: owner!.kind, name: owner!.name, email: owner!.email })),
        })),
      }
    },
  }),
  defineAiTool({
    name: 'get_connection',
    title: 'Get connection details',
    description: 'Full detail of one connection, including which diagrams show it.',
    mode: 'read',
    schema: z.object({ id: z.string().describe('Connection id') }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const c = connections(m)[input.id]
      if (!c) return { error: `no connection with id "${input.id}"` }
      const onDiagrams = Object.values(m.diagrams)
        .filter((d) => ((d.meta.connectionIds as string[] | undefined) ?? []).includes(input.id))
        .map((d) => ({ id: d.id, name: d.meta.name }))
      return {
        connection: c,
        from: { id: c.fromId, name: nameOf(m, c.fromId) },
        to: { id: c.toId, name: nameOf(m, c.toId) },
        diagrams: onDiagrams,
      }
    },
  }),
  defineAiTool({
    name: 'list_diagrams',
    title: 'List diagrams',
    description: 'List all diagrams (context/container/component views) with composition counts.',
    mode: 'read',
    schema: z.object({}),
    execute: async (ctx) => {
      const m = await ctx.session.snapshot()
      return {
        diagrams: Object.values(m.diagrams).map((d) => ({
          id: d.id,
          name: d.meta.name,
          type: d.meta.type,
          parentObjectId: d.meta.parentObjectId,
          parentObject: d.meta.parentObjectId ? nameOf(m, d.meta.parentObjectId as string) : undefined,
          objectCount: ((d.meta.objectIds as string[] | undefined) ?? []).length,
          connectionCount: ((d.meta.connectionIds as string[] | undefined) ?? []).length,
          flowCount: Object.keys(d.detail?.flows ?? {}).length,
        })),
      }
    },
  }),
  defineAiTool({
    name: 'get_diagram',
    title: 'Get diagram contents',
    description:
      'Full contents of one diagram: settings, the objects/connections/groups on it (resolved to names), its flows, and open comment count.',
    mode: 'read',
    schema: z.object({ id: z.string().describe('Diagram id') }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const d = m.diagrams[input.id]
      if (!d) return { error: `no diagram with id "${input.id}"` }
      const detail = d.detail
      const doc = await ctx.session.diagramDoc(input.id)
      const comments = Object.values((doc?.comments ?? {}) as Record<string, CommentView>)
      const objIds = detail?.objectIds ?? ((d.meta.objectIds as string[] | undefined) ?? [])
      const connIds = detail?.connectionIds ?? ((d.meta.connectionIds as string[] | undefined) ?? [])
      return {
        id: d.id,
        settings: detail?.settings ?? { name: d.meta.name, type: d.meta.type },
        objects: objIds.map((id) => {
          const o = objects(m)[id]
          return o ? { id, type: o.type, name: o.name } : { id, missing: true }
        }),
        connections: connIds.map((id) => {
          const c = connections(m)[id]
          return c
            ? { id, from: nameOf(m, c.fromId), to: nameOf(m, c.toId), label: c.label }
            : { id, missing: true }
        }),
        groups: (detail?.groupIds ?? []).map((id) => {
          const g = groups(m)[id]
          return g ? { id, name: g.name } : { id, missing: true }
        }),
        flows: Object.values((detail?.flows ?? {}) as Record<string, FlowView>).map((f) => ({
          id: f.id,
          name: f.name,
          stepCount: f.steps?.length ?? 0,
        })),
        openComments: comments.filter((c) => !c.resolved).length,
        totalComments: comments.length,
      }
    },
  }),
  defineAiTool({
    name: 'list_flows',
    title: 'List flows',
    description: 'List sequence flows (step-by-step walkthroughs attached to diagrams).',
    mode: 'read',
    schema: z.object({
      diagramId: z.string().optional().describe('Only flows on this diagram'),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const rows: { id: string; name?: string; diagramId: string; diagramName?: unknown; stepCount: number }[] = []
      for (const d of Object.values(m.diagrams)) {
        if (input.diagramId && d.id !== input.diagramId) continue
        for (const f of Object.values((d.detail?.flows ?? {}) as Record<string, FlowView>)) {
          rows.push({ id: f.id, name: f.name, diagramId: d.id, diagramName: d.meta.name, stepCount: f.steps?.length ?? 0 })
        }
      }
      return { flows: rows }
    },
  }),
  defineAiTool({
    name: 'get_flow',
    title: 'Get flow steps',
    description: 'Full step list of one flow, with object/connection names resolved per step.',
    mode: 'read',
    schema: z.object({ id: z.string().describe('Flow id') }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      for (const d of Object.values(m.diagrams)) {
        const f = ((d.detail?.flows ?? {}) as Record<string, FlowView>)[input.id]
        if (!f) continue
        const steps = [...(f.steps ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        return {
          id: f.id,
          name: f.name,
          diagramId: d.id,
          diagramName: d.meta.name,
          steps: steps.map((s) => ({
            order: s.order,
            type: s.type,
            title: s.title,
            description: s.description,
            ...(s.fromObjectId ? { from: nameOf(m, s.fromObjectId) } : {}),
            ...(s.toObjectId ? { to: nameOf(m, s.toObjectId) } : {}),
            ...(s.objectId ? { object: nameOf(m, s.objectId) } : {}),
          })),
        }
      }
      return { error: `no flow with id "${input.id}"` }
    },
  }),
  defineAiTool({
    name: 'list_tags',
    title: 'List tags',
    description: 'List governed Tag snapshots used or available in this workspace, with assignment counts by entity kind. Use search_tag_catalog before assigning.',
    mode: 'read',
    schema: z.object({}),
    execute: async (ctx) => {
      const m = await ctx.session.snapshot()
      return {
        tags: Object.values(tagsOf(m)).map((t) => ({
          id: t.tagId,
          name: t.value,
          groupId: t.groupId,
          groupName: t.groupName,
          color: t.color,
          objectCount: Object.values(objects(m)).filter((object) => object.tagAssignments?.[t.tagId]).length,
          connectionCount: Object.values(connections(m)).filter((connection) => connection.tagAssignments?.[t.tagId]).length,
          groupCount: Object.values(groups(m)).filter((group) => group.tagAssignments?.[t.tagId]).length,
          totalCount: [
            ...Object.values(objects(m)),
            ...Object.values(connections(m)),
            ...Object.values(groups(m)),
          ].filter((entity) => entity.tagAssignments?.[t.tagId]).length,
        })),
      }
    },
  }),
  defineAiTool({
    name: 'list_technologies',
    title: 'List technology usages',
    description: 'Aggregate governed Technology ids already used across objects, connections and groups. Use search_technology_catalog to select a new assignment.',
    mode: 'read',
    schema: z.object({}),
    execute: async (ctx) => {
      const m = await ctx.session.snapshot()
      const usage = new Map<string, {
        technologyId: string
        name: string
        revisions: Set<number>
        count: number
        usedBy: Set<string>
        objectCount: number
        connectionCount: number
        groupCount: number
      }>()
      const carriers = [
        ...Object.values(objects(m)).map((entity) => ({ entity, kind: entity.type ?? 'object', entityKind: 'object' })),
        ...Object.values(connections(m)).map((entity) => ({ entity, kind: 'connection', entityKind: 'connection' })),
        ...Object.values(groups(m)).map((entity) => ({ entity, kind: 'group', entityKind: 'group' })),
      ]
      for (const carrier of carriers) {
        for (const assigned of Object.values(carrier.entity.technologyUsages ?? {})) {
          const key = assigned.technologyId
          const u = usage.get(key) ?? {
            technologyId: assigned.technologyId,
            name: assigned.snapshot.name,
            revisions: new Set<number>(),
            count: 0,
            usedBy: new Set<string>(),
            objectCount: 0,
            connectionCount: 0,
            groupCount: 0,
          }
          u.revisions.add(assigned.catalogRevision)
          u.count++
          u.usedBy.add(carrier.kind)
          if (carrier.entityKind === 'object') u.objectCount++
          else if (carrier.entityKind === 'connection') u.connectionCount++
          else u.groupCount++
          usage.set(key, u)
        }
      }
      return {
        technologyUsages: [...usage.values()]
          .sort((a, b) => b.count - a.count)
          .map((u) => ({
            technologyId: u.technologyId,
            name: u.name,
            catalogRevisions: [...u.revisions].sort((a, b) => a - b),
            totalCount: u.count,
            objectCount: u.objectCount,
            connectionCount: u.connectionCount,
            groupCount: u.groupCount,
            usedBy: [...u.usedBy],
          })),
      }
    },
  }),
  defineAiTool({
    name: 'list_teams',
    title: 'List teams',
    description: "List the organization's teams and member counts.",
    mode: 'read',
    schema: z.object({}),
    execute: async (ctx) => {
      const orgId = ctx.orgId ?? (await ensureDefaultOrg(ctx.db))
      const { rows } = await ctx.db.query<{ id: string; name: string; members: string }>(
        `SELECT t.id, t.name, COUNT(m.user_id)::int AS members
         FROM teams t LEFT JOIN team_members m ON m.team_id = t.id
         WHERE t.org_id = $1 AND t.archived_at IS NULL
         GROUP BY t.id, t.name ORDER BY t.name`,
        [orgId]
      )
      return { teams: rows.map((r) => ({ id: r.id, name: r.name, memberCount: Number(r.members) })) }
    },
  }),
  defineAiTool({
    name: 'list_decision_records',
    title: 'List decision records (ADRs)',
    description: 'List architecture decision records, optionally filtered by status.',
    mode: 'read',
    schema: z.object({
      status: z.enum(['in-progress', 'approved', 'rejected']).optional(),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      let rows = Object.values(adrs(m))
      if (input.status) rows = rows.filter((a) => a.status === input.status)
      rows.sort((a, b) => (b.number ?? 0) - (a.number ?? 0))
      return {
        decisionRecords: rows.map((a) => ({
          id: a.id,
          number: a.number,
          title: a.title,
          status: a.status,
          author: a.author,
          updatedAt: a.updatedAt,
          summary: truncate(a.summary, 200),
        })),
      }
    },
  }),
  defineAiTool({
    name: 'get_decision_record',
    title: 'Get decision record',
    description: 'Full detail of one ADR including its markdown content, related links and status history.',
    mode: 'read',
    schema: z.object({ id: z.string().describe('Decision record id') }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const a = adrs(m)[input.id]
      if (!a) return { error: `no decision record with id "${input.id}"` }
      return { decisionRecord: a }
    },
  }),
  defineAiTool({
    name: 'list_comments',
    title: 'List diagram comments',
    description: 'List comments across diagrams (or one diagram). Comments carry a type (question/inaccuracy/idea), author, replies and resolved state.',
    mode: 'read',
    schema: z.object({
      diagramId: z.string().optional().describe('Only comments on this diagram'),
      unresolvedOnly: z.boolean().optional().describe('Only open (unresolved) comments — default false'),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const out: unknown[] = []
      for (const d of Object.values(m.diagrams)) {
        if (input.diagramId && d.id !== input.diagramId) continue
        const doc = await ctx.session.diagramDoc(d.id)
        for (const c of Object.values((doc?.comments ?? {}) as Record<string, CommentView>)) {
          if (input.unresolvedOnly && c.resolved) continue
          out.push({
            id: c.id,
            diagramId: d.id,
            diagramName: d.meta.name,
            type: c.type,
            text: c.text,
            author: c.author,
            createdAt: c.createdAt,
            resolved: !!c.resolved,
            replies: (c.replies ?? []).map((r) => ({ author: r.author, text: r.text, createdAt: r.createdAt })),
          })
        }
      }
      return { total: out.length, comments: out }
    },
  }),
  defineAiTool({
    name: 'get_model_stats',
    title: 'Get model statistics',
    description: 'Counts of every entity kind in the current workspace — cheap orientation call.',
    mode: 'read',
    schema: z.object({}),
    execute: async (ctx) => {
      const m = await ctx.session.snapshot()
      const byType = new Map<string, number>()
      for (const o of Object.values(objects(m))) {
        byType.set(o.type ?? 'unknown', (byType.get(o.type ?? 'unknown') ?? 0) + 1)
      }
      return {
        objects: Object.keys(m.objects).length,
        objectsByType: Object.fromEntries(byType),
        connections: Object.keys(m.connections).length,
        diagrams: Object.keys(m.diagrams).length,
        domains: Object.keys(m.domains).length,
        groups: Object.keys(m.groups).length,
        tags: Object.keys(m.tagSnapshots).length,
        decisionRecords: Object.keys(m.decisionRecords).length,
      }
    },
  }),
  defineAiTool({
    name: 'search_model',
    title: 'Search the whole model',
    description:
      'Case-insensitive substring search across objects, connections, diagrams, domains and decision records. The fastest way to find an entity by name.',
    mode: 'read',
    schema: z.object({
      q: z.string().min(1).describe('Search text'),
      limit: limitParam,
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const q = input.q.toLowerCase()
      const limit = input.limit ?? 25
      const hits: { kind: string; id: string; name?: string; extra?: string }[] = []
      const push = (kind: string, id: string, name?: string, extra?: string) => {
        if (hits.length < limit) hits.push({ kind, id, name, extra })
      }
      for (const o of Object.values(objects(m))) {
        if ([o.name, shortDescriptionOf(o), detailedDescriptionOf(o), ...techNames(o)]
          .some((s) => s?.toLowerCase().includes(q)))
          push('object', o.id, o.name, o.type)
      }
      for (const c of Object.values(connections(m))) {
        if ([c.label, c.description, nameOf(m, c.fromId), nameOf(m, c.toId), ...techNames(c)]
          .some((s) => s?.toLowerCase().includes(q)))
          push('connection', c.id, c.label ?? `${nameOf(m, c.fromId)} → ${nameOf(m, c.toId)}`)
      }
      for (const d of Object.values(m.diagrams)) {
        if (String(d.meta.name ?? '').toLowerCase().includes(q)) push('diagram', d.id, String(d.meta.name))
      }
      for (const dm of Object.values(domains(m))) {
        if ([dm.name, dm.description].some((s) => s?.toLowerCase().includes(q))) push('domain', dm.id, dm.name)
      }
      for (const a of Object.values(adrs(m))) {
        if ([a.title, a.summary].some((s) => s?.toLowerCase().includes(q)))
          push('decisionRecord', a.id, a.title, a.status)
      }
      return { hits }
    },
  }),
  defineAiTool({
    name: 'list_groups',
    title: 'List groups',
    description:
      'List groups (visual containers drawn around related objects on diagrams) with their icon, domain, members and the diagrams showing them.',
    mode: 'read',
    schema: z.object({
      search: z.string().optional().describe('Case-insensitive substring on the group name'),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const q = input.search?.toLowerCase()
      let rows = Object.values(groups(m))
      if (q) rows = rows.filter((g) => (g.name ?? '').toLowerCase().includes(q))
      rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      return {
        total: rows.length,
        groups: rows.map((g) => {
          const memberIds = g.objectIds ?? []
          const onDiagrams = Object.values(m.diagrams)
            .filter((d) => ((d.meta.groupIds as string[] | undefined) ?? []).includes(g.id))
            .map((d) => ({ id: d.id, name: d.meta.name }))
          return {
            id: g.id,
            name: g.name,
            icon: g.icon,
            color: g.color,
            description: truncate(g.description),
            domainId: g.domainId,
            objectCount: memberIds.length,
            members: memberIds.slice(0, 8).map((oid) => nameOf(m, oid)),
            technologyUsages: orderedTechnologyUsages(g).map((usage) => ({
              id: usage.id,
              technologyId: usage.technologyId,
              name: usage.snapshot.name,
              role: usage.role,
              usedVersion: usage.usedVersion,
            })),
            tagIds: g.tagOrder ?? Object.keys(g.tagAssignments ?? {}),
            diagrams: onDiagrams,
          }
        }),
      }
    },
  }),
  defineAiTool({
    name: 'search_icons',
    title: 'Search icon catalog',
    description:
      'Search the built-in visual icon catalog used by object and group icon fields. It is separate from the governed technology catalog and cannot assign technologies. Call with no query to list the available packs.',
    mode: 'read',
    schema: z.object({
      q: z.string().optional().describe('Search text — ranked name match (exact, prefix, substring)'),
      pack: z.string().optional().describe('Only icons from this pack (e.g. "AWS", "Azure Pack", "GCP")'),
      compatibleWith: z.enum(['actor', 'system', 'app', 'store', 'component', 'group']).optional()
        .describe('Only icons usable on this shape type'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20)'),
    }),
    execute: async (_ctx, input) => {
      if (!input.q && !input.pack) {
        return {
          totalIcons: ICON_COUNT,
          packs: listIconPacks(),
          hint: 'Pass q (and optionally compatibleWith) to search icons by name.',
        }
      }
      const { total, icons } = searchIcons({
        q: input.q,
        pack: input.pack,
        shapeType: input.compatibleWith,
        limit: input.limit ?? 20,
      })
      return {
        total,
        returned: icons.length,
        icons: icons.map((e) => ({
          name: e.name,
          ...(e.packs?.length ? { packs: e.packs } : {}),
          compatibleWith: e.compatibleWith,
        })),
      }
    },
  }),
  defineAiTool({
    name: 'audit_model_completeness',
    title: 'Audit model completeness',
    description:
      'Data-quality audit: finds objects with missing short/detailed descriptions, Technology usages, icon, domain or Tags; groups with structural gaps; and connections missing labels or detailed descriptions.',
    mode: 'read',
    schema: z.object({
      limit: z.number().int().min(1).max(100).optional()
        .describe('Max detailed rows per category (default 25)'),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const limit = input.limit ?? 25
      const domainsExist = Object.keys(domains(m)).length > 0
      const techBearing = new Set(['system', 'app', 'store', 'component'])

      const objectGaps: { id: string; type?: string; name?: string; missing: string[] }[] = []
      for (const o of Object.values(objects(m))) {
        const missing: string[] = []
        if (!shortDescriptionOf(o)?.trim()) missing.push('shortDescription')
        if (!detailedDescriptionOf(o)?.trim()) missing.push('description')
        if (techBearing.has(o.type ?? '') && techNames(o).length === 0) missing.push('technologyUsages')
        if (techBearing.has(o.type ?? '') && !o.icon) missing.push('icon')
        if (domainsExist && !o.domainId) missing.push('domain')
        if (Object.keys(o.tagAssignments ?? {}).length === 0) missing.push('tags')
        if (missing.length) objectGaps.push({ id: o.id, type: o.type, name: o.name, missing })
      }
      objectGaps.sort((a, b) => b.missing.length - a.missing.length)

      const groupGaps: { id: string; name?: string; missing: string[] }[] = []
      for (const g of Object.values(groups(m))) {
        const missing: string[] = []
        if (!g.icon) missing.push('icon')
        if (domainsExist && !g.domainId) missing.push('domain')
        if ((g.objectIds ?? []).length === 0) missing.push('members')
        if (missing.length) groupGaps.push({ id: g.id, name: g.name, missing })
      }

      const connectionGaps = Object.values(connections(m)).map((c) => {
        const missing: string[] = []
        if (!c.label?.trim()) missing.push('label')
        if (!c.description?.trim()) missing.push('description')
        return { id: c.id, from: nameOf(m, c.fromId), to: nameOf(m, c.toId), missing }
      }).filter((connection) => connection.missing.length > 0)

      const diagramGaps = Object.values(m.diagrams)
        .filter((d) => d.detail && !String((d.detail.settings as { description?: string }).description ?? '').trim())
        .map((d) => ({ id: d.id, name: d.meta.name }))

      return {
        summary: {
          objectsTotal: Object.keys(m.objects).length,
          objectsWithGaps: objectGaps.length,
          groupsWithGaps: groupGaps.length,
          connectionsWithGaps: connectionGaps.length,
          connectionsUnlabeled: connectionGaps.filter((connection) => connection.missing.includes('label')).length,
          diagramsWithoutDescription: diagramGaps.length,
          ...(domainsExist ? {} : { note: 'no domains exist yet — create_domain to organize by business area' }),
        },
        objects: objectGaps.slice(0, limit),
        groups: groupGaps.slice(0, limit),
        connections: connectionGaps.slice(0, limit),
        diagrams: diagramGaps.slice(0, limit),
      }
    },
  }),
]
