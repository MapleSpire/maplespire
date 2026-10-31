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
import { defineAiTool, type AiToolDef } from '../toolRegistry.js'
import type { AiToolCtx } from '../toolContext.js'
import { AiToolError } from '../toolContext.js'
import {
  upsertModelEntities, deleteModelEntities, upsertInlineEntities, deleteInlineEntities,
  createDiagramDoc, updateDiagramDoc, deleteDiagramDoc, stripIdsFromAllDiagrams,
  mutateComment, newEntityId,
} from '../modelOps.js'
import {
  objects, connections, groups, domains, adrs, nameOf,
  type ObjView, type GroupView, type DomainView,
} from './shapes.js'
import { requireIcon, resolveIconOrWarn } from './icons.js'
import { nameTypeWarning } from '../c4Rules.js'
import type { FullModel } from '../../../draft/materialize.js'

/**
 * Write tools — create/update/delete on model objects, connections, decision
 * records, diagrams, plus comment resolution. Every execute is
 * read-modify-write against the session snapshot, writes through modelOps
 * (edits-overlay/tombstone semantics), and ends with `session.invalidate()`.
 *
 * RBAC: `executeAiTool` hard-gates all of these on `ctx.canWrite`.
 */

const DEFAULT_SIZE = { width: 160, height: 100 }
const COLOR_PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6']
/** Client default group fill (CreateShapePalette). */
const GROUP_DEFAULT_COLOR = '#E0DBD2'

const objectType = z.enum(['actor', 'system', 'app', 'store', 'component'])
const objectStatus = z.enum(['live', 'draft', 'down', 'unstable'])
const connectionType = z.enum(['solid', 'dashed', 'dotted'])
const adrStatus = z.enum(['in-progress', 'approved', 'rejected'])

function requireObject(m: FullModel, id: string, what = 'object'): ObjView {
  const o = objects(m)[id]
  if (!o) throw new AiToolError(`no model ${what} with id "${id}" — use search_model or list_model_objects to find the right id`, 404)
  return o
}

/**
 * C4 nesting hard rules — AI/MCP tool path ONLY (the manual editor stays
 * free: nesting is a product recommendation, never a constraint on humans).
 */
function assertC4Structure(m: FullModel, type: string, parentId: string | undefined): void {
  if (type === 'component') {
    if (!parentId) {
      throw new AiToolError('a component must live inside an app — set parentId to its owning app', 400)
    }
    const parent = objects(m)[parentId]
    if (parent?.type !== 'app') {
      throw new AiToolError(
        `a component's parent must be an app — "${nameOf(m, parentId)}" is a ${parent?.type ?? 'missing object'}`,
        400
      )
    }
  }
  if ((type === 'app' || type === 'store') && parentId) {
    const parent = objects(m)[parentId]
    if (parent?.type !== 'system') {
      throw new AiToolError(
        `a ${type}'s parent must be a system — "${nameOf(m, parentId)}" is a ${parent?.type ?? 'missing object'}`,
        400
      )
    }
  }
}

/** Reject parentId chains that would loop back to `id` (same pattern as the domain-cycle guard). */
function assertNoParentCycle(m: FullModel, id: string, newParentId: string): void {
  const seen = new Set<string>()
  for (let p: string | undefined = newParentId; p; p = objects(m)[p]?.parentId) {
    if (p === id) throw new AiToolError('parentId would create a nesting cycle', 400)
    if (seen.has(p)) break
    seen.add(p)
  }
}

/** Positions for newly-placed entities: continue to the RIGHT of the diagram's
 * current content (or start a grid on an empty diagram). */
export function nextPlacements(m: FullModel, diagramId: string, ids: string[]): Record<string, unknown> {
  const detail = m.diagrams[diagramId]?.detail
  const layouts = (detail?.layouts ?? {}) as Record<string, { position?: { x: number; y: number }; size?: { width: number; height: number } }>
  let maxX = -Infinity
  let minY = Infinity
  for (const l of Object.values(layouts)) {
    if (!l?.position) continue
    maxX = Math.max(maxX, l.position.x + (l.size?.width ?? DEFAULT_SIZE.width))
    minY = Math.min(minY, l.position.y)
  }
  // Fall back to the objects' own model positions when the diagram has no layouts.
  if (!Number.isFinite(maxX)) {
    for (const oid of detail?.objectIds ?? []) {
      const o = objects(m)[oid]
      if (!o?.position) continue
      maxX = Math.max(maxX, o.position.x + (o.size?.width ?? DEFAULT_SIZE.width))
      minY = Math.min(minY, o.position.y)
    }
  }
  const startX = Number.isFinite(maxX) ? maxX + 100 : 80
  const startY = Number.isFinite(minY) ? Math.max(minY, 40) : 80
  const out: Record<string, unknown> = {}
  ids.forEach((id, i) => {
    const size = objects(m)[id]?.size ?? DEFAULT_SIZE
    out[id] = {
      position: { x: startX + (i % 3) * 240, y: startY + Math.floor(i / 3) * 150 },
      size,
    }
  })
  return out
}

/** Grid layout for a brand-new diagram's seeded objects. */
function gridPlacements(m: FullModel, ids: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  ids.forEach((id, i) => {
    const size = objects(m)[id]?.size ?? DEFAULT_SIZE
    out[id] = { position: { x: 80 + (i % 4) * 240, y: 80 + Math.floor(i / 4) * 160 }, size }
  })
  return out
}

/** Recursively gather `id` + all descendants (children, grandchildren…). */
function withDescendants(m: FullModel, id: string): string[] {
  const out = [id]
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const o of Object.values(objects(m))) {
      if (o.parentId === cur) {
        out.push(o.id)
        stack.push(o.id)
      }
    }
  }
  return out
}

async function done(ctx: AiToolCtx, result: Record<string, unknown>): Promise<Record<string, unknown>> {
  ctx.session.invalidate()
  return result
}

export const writeTools: AiToolDef[] = [
  defineAiTool({
    name: 'create_model_object',
    title: 'Create model object',
    description:
      'Create a model object (actor/system/app/store/component). Optionally place it on a diagram in the same call. Children: apps/stores/components usually set parentId to their containing system/app.',
    mode: 'write',
    schema: z.object({
      type: objectType,
      name: z.string().min(1),
      shortDescription: z.string().max(120).optional(),
      description: z.string().optional(),
      domainId: z.string().optional().describe('Domain id (see list_domains)'),
      parentId: z.string().optional().describe('Containing object id (e.g. the system an app belongs to)'),
      icon: z.string().optional()
        .describe('Icon catalog name (find the EXACT name with search_icons; must be compatible with the object type)'),
      scope: z.enum(['internal', 'external']).optional()
        .describe('DEFAULT scope used on diagrams that do not override it (default internal). Use set_object_scope_on_diagram for one diagram.'),
      status: objectStatus.optional().describe('Default live'),
      addToDiagramId: z.string().optional().describe('Also place the new object on this diagram'),
      position: z.object({ x: z.number(), y: z.number() }).optional()
        .describe('Position when placing on the diagram (auto-placed if omitted)'),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      if (input.parentId) requireObject(m, input.parentId, 'object (parentId)')
      assertC4Structure(m, input.type, input.parentId)
      if (input.domainId && !domains(m)[input.domainId]) {
        throw new AiToolError(`no domain with id "${input.domainId}" — see list_domains`, 404)
      }
      if (input.addToDiagramId && !m.diagrams[input.addToDiagramId]) {
        throw new AiToolError(`no diagram with id "${input.addToDiagramId}" — see list_diagrams`, 404)
      }
      // Lenient on create: a hallucinated icon must not sink object creation.
      // Technology assignment is intentionally absent here: only the catalog
      // endpoint may validate availability and construct an immutable snapshot.
      const { warning: iconWarning, ...iconFields } = input.icon
        ? resolveIconOrWarn(input.icon, input.type)
        : { warning: undefined }
      const structureWarning =
        (input.type === 'app' || input.type === 'store') &&
        !input.parentId &&
        (input.scope ?? 'internal') === 'internal'
          ? `${input.type}s usually live inside a system — set parentId to the owning system, or model it as a system if it stands alone`
          : undefined
      const namingWarning = nameTypeWarning(input.name, input.type)
      const id = newEntityId()
      const entity: ObjView = {
        id,
        type: input.type,
        name: input.name,
        shortDescription: input.shortDescription ?? '',
        ...(input.description ? { description: input.description } : {}),
        ...iconFields,
        position: input.position ?? { x: 0, y: 0 },
        size: DEFAULT_SIZE,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        ...(input.domainId ? { domainId: input.domainId } : {}),
        tagAssignments: {},
        tagOrder: [],
        scope: input.scope ?? 'internal',
        status: input.status ?? 'live',
        properties: {},
      }
      await upsertModelEntities(ctx.repo, ctx.rootUrl, 'objects', { [id]: entity }, ctx.workspace)
      let placed = false
      if (input.addToDiagramId) {
        const placement = input.position
          ? { [id]: { position: input.position, size: DEFAULT_SIZE } }
          : nextPlacements(m, input.addToDiagramId, [id])
        placed = await updateDiagramDoc(ctx.repo, ctx.rootUrl, input.addToDiagramId, {
          addObjectIds: [id],
          layoutUpserts: placement,
        })
      }
      return done(ctx, {
        created: { id, type: input.type, name: input.name },
        ...(input.addToDiagramId ? { addedToDiagram: placed ? input.addToDiagramId : 'failed' } : {}),
        ...(iconWarning ? { iconWarning } : {}),
        ...(structureWarning ? { structureWarning } : {}),
        ...(namingWarning ? { namingWarning } : {}),
      })
    },
  }),
  defineAiTool({
    name: 'update_model_object',
    title: 'Update model object',
    description:
      'Update fields of a model object. shortDescription is the 120-character diagram label; description is unbounded Markdown documentation. Pass null to clear either field: a cleared shortDescription leaves the diagram card with NO label (it never falls back to description). Governed Tag and Technology assignments are managed through their catalog UIs.',
    mode: 'write',
    schema: z.object({
      id: z.string(),
      name: z.string().min(1).optional(),
      shortDescription: z.string().max(120).nullable().optional(),
      description: z.string().nullable().optional(),
      type: objectType.optional(),
      domainId: z.string().nullable().optional(),
      parentId: z.string().nullable().optional(),
      scope: z.enum(['internal', 'external']).optional()
        .describe('DEFAULT scope (diagrams can override it — see set_object_scope_on_diagram)'),
      status: objectStatus.optional(),
      icon: z.string().nullable().optional()
        .describe('Icon catalog name (search_icons for exact names); null clears the icon'),
      properties: z.record(z.string(), z.string()).optional().describe('Merged into existing properties'),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const current = requireObject(m, input.id)
      if (input.parentId) requireObject(m, input.parentId, 'object (parentId)')
      if (input.parentId === input.id) throw new AiToolError('an object cannot be its own parent')
      if (input.parentId) assertNoParentCycle(m, input.id, input.parentId)
      // Structural rules against the EFFECTIVE post-patch type/parent.
      const effType = input.type ?? current.type
      const effParent = input.parentId === null ? undefined : (input.parentId ?? current.parentId)
      if (effType) assertC4Structure(m, effType, effParent)
      if (input.domainId && !domains(m)[input.domainId]) {
        throw new AiToolError(`no domain with id "${input.domainId}" — see list_domains`, 404)
      }
      const next: ObjView = { ...current }
      if (input.name !== undefined) next.name = input.name
      // null stores '' rather than deleting the key: an absent key puts the
      // object back in the legacy shape, where `description` IS the card label
      // and is hidden from the Documentation field (src/lib/objectDescription.ts).
      if (input.shortDescription !== undefined) {
        if (input.shortDescription === null) next.shortDescription = ''
        else next.shortDescription = input.shortDescription
      }
      if (input.description !== undefined) {
        // Materialize the legacy label only when this call does not set one.
        if (input.shortDescription === undefined
          && !Object.prototype.hasOwnProperty.call(current, 'shortDescription')) {
          next.shortDescription = current.description ?? ''
        }
        if (input.description === null) delete next.description
        else next.description = input.description
      }
      if (input.type !== undefined) next.type = input.type
      if (input.domainId !== undefined) {
        if (input.domainId === null) delete next.domainId
        else next.domainId = input.domainId
      }
      if (input.parentId !== undefined) {
        if (input.parentId === null) delete next.parentId
        else next.parentId = input.parentId
      }
      if (input.scope !== undefined) next.scope = input.scope
      if (input.status !== undefined) next.status = input.status
      if (input.icon !== undefined) {
        // Same as the editor's icon picker: choosing replaces any assignment
        // (a technology-supplied one included), clearing removes both.
        if (input.icon === null) {
          delete next.icon
          delete next.iconAssignment
        } else Object.assign(next, requireIcon(input.icon, next.type ?? current.type ?? 'app'))
      }
      if (input.properties) next.properties = { ...(current.properties ?? {}), ...input.properties }

      await upsertModelEntities(ctx.repo, ctx.rootUrl, 'objects', { [input.id]: next }, ctx.workspace)
      const namingWarning =
        input.name !== undefined || input.type !== undefined
          ? nameTypeWarning(next.name ?? '', next.type)
          : undefined
      return done(ctx, {
        updated: { id: input.id, name: next.name },
        ...(namingWarning ? { namingWarning } : {}),
      })
    },
  }),
  defineAiTool({
    name: 'set_object_scope_on_diagram',
    title: 'Set object scope on a diagram',
    description:
      'Mark objects internal or external ON ONE DIAGRAM, overriding their default scope there. Pass scope=null to clear the override: the object then follows the C4 boundary rule (on a drill-down diagram, anything outside the drilled-into element is external) and then its default scope.',
    mode: 'write',
    schema: z.object({
      diagramId: z.string(),
      objectIds: z.array(z.string()).min(1),
      scope: z.enum(['internal', 'external']).nullable(),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const diagram = m.diagrams[input.diagramId]
      if (!diagram) throw new AiToolError(`no diagram with id "${input.diagramId}" — see list_diagrams`, 404)
      const onDiagram = new Set(diagram.detail?.objectIds ?? ((diagram.meta.objectIds as string[] | undefined) ?? []))
      const missing = input.objectIds.filter((id) => !onDiagram.has(id))
      if (missing.length) {
        throw new AiToolError(`not on diagram "${input.diagramId}": ${missing.join(', ')}`, 404)
      }
      const scopeUpserts = Object.fromEntries(input.objectIds.map((id) => [id, input.scope]))
      const ok = await updateDiagramDoc(ctx.repo, ctx.rootUrl, input.diagramId, { scopeUpserts })
      if (!ok) throw new AiToolError(`could not open diagram "${input.diagramId}"`, 404)
      return done(ctx, { diagramId: input.diagramId, objectIds: input.objectIds, scope: input.scope })
    },
  }),
  defineAiTool({
    name: 'delete_model_object',
    title: 'Delete model object',
    description:
      'Delete a model object. Cascades: its connections are deleted and it is removed from every diagram, group and tag. Fails if the object has children unless deleteChildren=true (which deletes ALL descendants). Destructive — only when the user explicitly asked.',
    mode: 'write',
    schema: z.object({
      id: z.string(),
      deleteChildren: z.boolean().optional().describe('Also delete all nested children (default false)'),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      requireObject(m, input.id)
      const targets = withDescendants(m, input.id)
      if (targets.length > 1 && !input.deleteChildren) {
        const children = targets.slice(1).map((cid) => `${nameOf(m, cid)} (${cid})`)
        throw new AiToolError(
          `object has ${children.length} nested child(ren): ${children.slice(0, 8).join(', ')}${children.length > 8 ? '…' : ''}. Pass deleteChildren=true to delete them too, or re-parent them first.`
        )
      }
      const targetSet = new Set(targets)
      const connIds = Object.values(connections(m))
        .filter((c) => targetSet.has(c.fromId) || targetSet.has(c.toId))
        .map((c) => c.id)

      await deleteModelEntities(ctx.repo, ctx.rootUrl, 'objects', targets)
      if (connIds.length) await deleteModelEntities(ctx.repo, ctx.rootUrl, 'connections', connIds)
      await stripIdsFromAllDiagrams(ctx.repo, ctx.rootUrl, [...targets, ...connIds])

      // Reverse-index maintenance: groups + tags that referenced the deleted ids.
      const groupUpserts: Record<string, unknown> = {}
      for (const g of Object.values(groups(m))) {
        if ((g.objectIds ?? []).some((oid) => targetSet.has(oid))) {
          groupUpserts[g.id] = { ...g, objectIds: (g.objectIds ?? []).filter((oid) => !targetSet.has(oid)) }
        }
      }
      if (Object.keys(groupUpserts).length) await upsertInlineEntities(ctx.repo, ctx.rootUrl, 'groups', groupUpserts)
      return done(ctx, {
        deletedObjects: targets.length,
        deletedConnections: connIds.length,
      })
    },
  }),
  defineAiTool({
    name: 'create_connection',
    title: 'Create connection',
    description:
      'Create a directed connection between two model objects. It is automatically shown on every diagram that displays both endpoints (a diagram only renders connections attached to it); pass addToDiagramId to restrict it to one diagram instead.',
    mode: 'write',
    schema: z.object({
      fromId: z.string(),
      toId: z.string(),
      label: z.string().optional().describe('e.g. "reads from", "publishes events to"'),
      description: z.string().optional().describe('Markdown documentation for the relationship'),
      type: connectionType.optional().describe('Line style, default solid'),
      status: objectStatus.optional(),
      addToDiagramId: z.string().optional()
        .describe('Attach ONLY to this diagram (default: every diagram showing both endpoints)'),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      requireObject(m, input.fromId, 'object (fromId)')
      requireObject(m, input.toId, 'object (toId)')
      if (input.fromId === input.toId) throw new AiToolError('fromId and toId must differ')
      const id = newEntityId()
      const entity = {
        id,
        fromId: input.fromId,
        toId: input.toId,
        ...(input.label ? { label: input.label } : {}),
        ...(input.description ? { description: input.description } : {}),
        type: input.type ?? 'solid',
        kind: 'direct',
        ...(input.status ? { status: input.status } : {}),
      }
      await upsertModelEntities(ctx.repo, ctx.rootUrl, 'connections', { [id]: entity }, ctx.workspace)

      // Diagrams only render connections in their composition (the client's
      // sync pass skips pairs whose endpoints are both directly visible on the
      // assumption the direct connection is already attached) — so a model-only
      // write would show up on the Model Connections page but never on canvas.
      const onDiagramIds = (d: (typeof m.diagrams)[string]): string[] =>
        d.detail?.objectIds ?? ((d.meta.objectIds as string[] | undefined) ?? [])
      const added: string[] = []
      if (input.addToDiagramId) {
        const d = m.diagrams[input.addToDiagramId]
        if (!d) throw new AiToolError(`no diagram with id "${input.addToDiagramId}"`, 404)
        const onDiagram = new Set(onDiagramIds(d))
        if (!onDiagram.has(input.fromId) || !onDiagram.has(input.toId)) {
          throw new AiToolError(
            'both endpoints must already be on that diagram — add them with update_diagram first'
          )
        }
        await updateDiagramDoc(ctx.repo, ctx.rootUrl, input.addToDiagramId, { addConnectionIds: [id] })
        added.push(input.addToDiagramId)
      } else {
        for (const d of Object.values(m.diagrams)) {
          const onDiagram = new Set(onDiagramIds(d))
          if (!onDiagram.has(input.fromId) || !onDiagram.has(input.toId)) continue
          await updateDiagramDoc(ctx.repo, ctx.rootUrl, d.id, { addConnectionIds: [id] })
          added.push(d.id)
        }
      }
      return done(ctx, {
        created: { id, from: nameOf(m, input.fromId), to: nameOf(m, input.toId), label: input.label },
        addedToDiagrams: added.map((did) => ({ id: did, name: m.diagrams[did]?.meta.name })),
      })
    },
  }),
  defineAiTool({
    name: 'update_connection',
    title: 'Update connection',
    description: 'Update a connection (label/description/type/status/endpoints). Pass null for label or description to clear it.',
    mode: 'write',
    schema: z.object({
      id: z.string(),
      label: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      type: connectionType.optional(),
      status: objectStatus.nullable().optional(),
      fromId: z.string().optional(),
      toId: z.string().optional(),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const current = connections(m)[input.id]
      if (!current) throw new AiToolError(`no connection with id "${input.id}"`, 404)
      if (input.fromId) requireObject(m, input.fromId, 'object (fromId)')
      if (input.toId) requireObject(m, input.toId, 'object (toId)')
      const next = { ...current }
      if (input.label !== undefined) {
        if (input.label === null) delete next.label
        else next.label = input.label
      }
      if (input.description !== undefined) {
        if (input.description === null) delete next.description
        else next.description = input.description
      }
      if (input.type !== undefined) next.type = input.type
      if (input.status !== undefined) {
        if (input.status === null) delete next.status
        else next.status = input.status
      }
      if (input.fromId) next.fromId = input.fromId
      if (input.toId) next.toId = input.toId
      if (next.fromId === next.toId) throw new AiToolError('fromId and toId must differ')
      await upsertModelEntities(ctx.repo, ctx.rootUrl, 'connections', { [input.id]: next }, ctx.workspace)
      return done(ctx, { updated: { id: input.id } })
    },
  }),
  defineAiTool({
    name: 'delete_connection',
    title: 'Delete connection',
    description: 'Delete a connection from the model and every diagram showing it.',
    mode: 'write',
    schema: z.object({ id: z.string() }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      if (!connections(m)[input.id]) throw new AiToolError(`no connection with id "${input.id}"`, 404)
      await deleteModelEntities(ctx.repo, ctx.rootUrl, 'connections', [input.id])
      await stripIdsFromAllDiagrams(ctx.repo, ctx.rootUrl, [input.id])
      return done(ctx, { deleted: input.id })
    },
  }),
  defineAiTool({
    name: 'create_group',
    title: 'Create group',
    description:
      'Create a group — a visual container drawn around related objects on a diagram (domain boundary, network zone, team scope…). A group only renders on diagrams it is attached to; by default it is attached to every diagram already showing at least one member object.',
    mode: 'write',
    schema: z.object({
      name: z.string().min(1),
      objectIds: z.array(z.string()).optional().describe('Member object ids the group is drawn around'),
      description: z.string().optional(),
      color: z.string().optional().describe('Hex fill color (default "#E0DBD2")'),
      icon: z.string().optional().describe('Icon catalog name (search_icons with compatibleWith=group)'),
      domainId: z.string().optional().describe('Domain id (see list_domains)'),
      addToDiagramId: z.string().optional().describe('Attach ONLY to this diagram instead of the default'),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      for (const oid of input.objectIds ?? []) requireObject(m, oid)
      if (input.domainId && !domains(m)[input.domainId]) {
        throw new AiToolError(`no domain with id "${input.domainId}" — see list_domains`, 404)
      }
      if (input.addToDiagramId && !m.diagrams[input.addToDiagramId]) {
        throw new AiToolError(`no diagram with id "${input.addToDiagramId}" — see list_diagrams`, 404)
      }
      // Lenient on create (see create_model_object): drop a bad icon, warn.
      const { warning: iconWarning, ...iconFields } = input.icon
        ? resolveIconOrWarn(input.icon, 'group')
        : { warning: undefined }
      const id = newEntityId()
      const entity: GroupView = {
        id,
        name: input.name,
        color: input.color ?? GROUP_DEFAULT_COLOR,
        objectIds: input.objectIds ?? [],
        tagAssignments: {},
        tagOrder: [],
        autoSize: true,
        ...iconFields,
        ...(input.domainId ? { domainId: input.domainId } : {}),
        ...(input.description ? { description: input.description } : {}),
      }
      await upsertInlineEntities(ctx.repo, ctx.rootUrl, 'groups', { [id]: entity })

      const memberSet = new Set(input.objectIds ?? [])
      const onDiagramIds = (d: (typeof m.diagrams)[string]): string[] =>
        d.detail?.objectIds ?? ((d.meta.objectIds as string[] | undefined) ?? [])
      const targets = input.addToDiagramId
        ? [m.diagrams[input.addToDiagramId]]
        : Object.values(m.diagrams).filter((d) => onDiagramIds(d).some((oid) => memberSet.has(oid)))
      const added: { id: string; name?: unknown }[] = []
      for (const d of targets) {
        // Mirror the client's addGroupToDiagram: a group with NO members on the
        // diagram needs an explicit default box or the canvas computes a null
        // bbox and it renders invisible.
        const hasMemberOnDiagram = onDiagramIds(d).some((oid) => memberSet.has(oid))
        const n = Object.keys(d.detail?.layouts ?? {}).length
        const ok = await updateDiagramDoc(ctx.repo, ctx.rootUrl, d.id, {
          addGroupIds: [id],
          ...(hasMemberOnDiagram
            ? {}
            : {
                layoutUpserts: {
                  [id]: {
                    position: { x: 200 + (n % 6) * 40, y: 200 + (n % 6) * 40 },
                    size: { width: 240, height: 160 },
                  },
                },
              }),
        })
        if (ok) added.push({ id: d.id, name: d.meta.name })
      }
      return done(ctx, {
        created: { id, name: input.name },
        addedToDiagrams: added,
        ...(iconWarning ? { iconWarning } : {}),
        ...(added.length === 0
          ? { note: 'group is not attached to any diagram yet — groups only render on attached diagrams (update_group addToDiagramId)' }
          : {}),
      })
    },
  }),
  defineAiTool({
    name: 'update_group',
    title: 'Update group',
    description:
      'Update a group: rename, set icon/color/domain/description, add or remove member objects, attach to / detach from a diagram. Pass null for icon/domainId/description to clear them.',
    mode: 'write',
    schema: z.object({
      id: z.string(),
      name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      color: z.string().optional(),
      icon: z.string().nullable().optional().describe('Icon catalog name (search_icons); null clears it'),
      domainId: z.string().nullable().optional(),
      addObjectIds: z.array(z.string()).optional(),
      removeObjectIds: z.array(z.string()).optional(),
      addToDiagramId: z.string().optional().describe('Also attach the group to this diagram'),
      removeFromDiagramId: z.string().optional().describe('Detach the group from this diagram'),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const current = groups(m)[input.id]
      if (!current) throw new AiToolError(`no group with id "${input.id}" — see list_groups`, 404)
      for (const oid of input.addObjectIds ?? []) requireObject(m, oid)
      if (input.domainId && !domains(m)[input.domainId]) {
        throw new AiToolError(`no domain with id "${input.domainId}" — see list_domains`, 404)
      }
      for (const did of [input.addToDiagramId, input.removeFromDiagramId]) {
        if (did && !m.diagrams[did]) throw new AiToolError(`no diagram with id "${did}" — see list_diagrams`, 404)
      }
      const next: GroupView = { ...current }
      if (input.name !== undefined) next.name = input.name
      if (input.description !== undefined) {
        if (input.description === null) delete next.description
        else next.description = input.description
      }
      if (input.color !== undefined) next.color = input.color
      if (input.icon !== undefined) {
        if (input.icon === null) {
          delete next.icon
          delete next.iconAssignment
        } else Object.assign(next, requireIcon(input.icon, 'group'))
      }
      if (input.domainId !== undefined) {
        if (input.domainId === null) delete next.domainId
        else next.domainId = input.domainId
      }
      const members = new Set(current.objectIds ?? [])
      for (const oid of input.addObjectIds ?? []) members.add(oid)
      for (const oid of input.removeObjectIds ?? []) members.delete(oid)
      next.objectIds = [...members]
      await upsertInlineEntities(ctx.repo, ctx.rootUrl, 'groups', { [input.id]: next })

      if (input.addToDiagramId) {
        const d = m.diagrams[input.addToDiagramId]
        const onDiagram = new Set(d.detail?.objectIds ?? ((d.meta.objectIds as string[] | undefined) ?? []))
        const hasMemberOnDiagram = next.objectIds.some((oid) => onDiagram.has(oid))
        const n = Object.keys(d.detail?.layouts ?? {}).length
        await updateDiagramDoc(ctx.repo, ctx.rootUrl, d.id, {
          addGroupIds: [input.id],
          ...(hasMemberOnDiagram
            ? {}
            : {
                layoutUpserts: {
                  [input.id]: {
                    position: { x: 200 + (n % 6) * 40, y: 200 + (n % 6) * 40 },
                    size: { width: 240, height: 160 },
                  },
                },
              }),
        })
      }
      if (input.removeFromDiagramId) {
        await updateDiagramDoc(ctx.repo, ctx.rootUrl, input.removeFromDiagramId, {
          removeGroupIds: [input.id],
          layoutDeletes: [input.id],
        })
      }
      return done(ctx, { updated: { id: input.id, name: next.name, members: next.objectIds.length } })
    },
  }),
  defineAiTool({
    name: 'delete_group',
    title: 'Delete group',
    description:
      'Delete a group (the container only — its member objects are NOT deleted). Connections that start or end on the group are deleted with it. Removed from every diagram showing it. Destructive — only when the user explicitly asked.',
    mode: 'write',
    schema: z.object({ id: z.string() }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      if (!groups(m)[input.id]) throw new AiToolError(`no group with id "${input.id}"`, 404)
      // A connection endpoint may be a GROUP, not just an object. Leaving those
      // behind is what makes Model Connections show `Unknown → Unknown`; the
      // client's deleteGroup sweeps them, so this must too or the two writers
      // disagree on the same edit.
      const connIds = Object.values(connections(m))
        .filter((c) => c.fromId === input.id || c.toId === input.id)
        .map((c) => c.id)
      await deleteInlineEntities(ctx.repo, ctx.rootUrl, 'groups', [input.id])
      if (connIds.length) await deleteModelEntities(ctx.repo, ctx.rootUrl, 'connections', connIds)
      await stripIdsFromAllDiagrams(ctx.repo, ctx.rootUrl, [input.id, ...connIds])
      return done(ctx, {
        deleted: input.id,
        deletedConnections: connIds.length,
        note: 'member objects were not deleted',
      })
    },
  }),
  defineAiTool({
    name: 'create_domain',
    title: 'Create domain',
    description:
      'Create a domain (business area used to organize objects, groups and diagrams). Check list_domains first and reuse an existing domain rather than creating near-duplicates.',
    mode: 'write',
    schema: z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      color: z.string().optional().describe('Hex color; defaults from a palette'),
      parentId: z.string().optional().describe('Parent domain id (for sub-domains)'),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const existing = Object.values(domains(m))
      const dup = existing.find((d) => (d.name ?? '').toLowerCase() === input.name.toLowerCase())
      if (dup) throw new AiToolError(`domain "${dup.name}" already exists (id ${dup.id}) — reuse it`)
      if (input.parentId && !domains(m)[input.parentId]) {
        throw new AiToolError(`no domain with id "${input.parentId}" — see list_domains`, 404)
      }
      const id = newEntityId()
      const entity: DomainView = {
        id,
        name: input.name,
        color: input.color ?? COLOR_PALETTE[existing.length % COLOR_PALETTE.length],
        ...(input.description ? { description: input.description } : {}),
        ...(input.parentId ? { parentId: input.parentId } : {}),
      }
      await upsertInlineEntities(ctx.repo, ctx.rootUrl, 'domains', { [id]: entity })
      return done(ctx, { created: { id, name: input.name } })
    },
  }),
  defineAiTool({
    name: 'update_domain',
    title: 'Update domain',
    description: 'Update a domain (rename, description, color, parent). Pass null for description/parentId to clear them.',
    mode: 'write',
    schema: z.object({
      id: z.string(),
      name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      color: z.string().optional(),
      parentId: z.string().nullable().optional(),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const current = domains(m)[input.id]
      if (!current) throw new AiToolError(`no domain with id "${input.id}" — see list_domains`, 404)
      if (input.name) {
        const dup = Object.values(domains(m)).find(
          (d) => d.id !== input.id && (d.name ?? '').toLowerCase() === input.name!.toLowerCase()
        )
        if (dup) throw new AiToolError(`domain "${dup.name}" already exists (id ${dup.id})`)
      }
      if (input.parentId) {
        if (input.parentId === input.id) throw new AiToolError('a domain cannot be its own parent')
        if (!domains(m)[input.parentId]) throw new AiToolError(`no domain with id "${input.parentId}"`, 404)
        // Reject cycles: walking up from the new parent must never reach this domain.
        const seen = new Set<string>()
        for (let p: string | undefined = input.parentId; p; p = domains(m)[p]?.parentId) {
          if (p === input.id) throw new AiToolError('parentId would create a domain cycle')
          if (seen.has(p)) break
          seen.add(p)
        }
      }
      const next: DomainView = { ...current }
      if (input.name !== undefined) next.name = input.name
      if (input.description !== undefined) {
        if (input.description === null) delete next.description
        else next.description = input.description
      }
      if (input.color !== undefined) next.color = input.color
      if (input.parentId !== undefined) {
        if (input.parentId === null) delete next.parentId
        else next.parentId = input.parentId
      }
      await upsertInlineEntities(ctx.repo, ctx.rootUrl, 'domains', { [input.id]: next })
      return done(ctx, { updated: { id: input.id, name: next.name } })
    },
  }),
  defineAiTool({
    name: 'create_decision_record',
    title: 'Create decision record (ADR)',
    description:
      'Create an architecture decision record. content is markdown (typical sections: Context, Decision, Consequences).',
    mode: 'write',
    schema: z.object({
      title: z.string().min(1),
      summary: z.string().optional().describe('One-paragraph summary shown in lists'),
      content: z.string().optional().describe('Full markdown body'),
      status: adrStatus.optional().describe('Default in-progress'),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const existing = Object.values(adrs(m))
      const number = existing.reduce((mx, a) => Math.max(mx, a.number ?? 0), 0) + 1
      const id = newEntityId()
      const now = new Date().toISOString()
      const status = input.status ?? 'in-progress'
      const record = {
        id,
        number,
        title: input.title,
        summary: input.summary ?? '',
        status,
        author: ctx.userLabel,
        // The person the assistant is acting for owns the record, so the same
        // owner-gated delete rule applies to it as to one created in the UI.
        ...(ctx.userId ? { ownerId: ctx.userId } : {}),
        createdAt: now,
        updatedAt: now,
        content: input.content ?? '',
        related: [],
        history: [{ status, date: now }],
      }
      await upsertInlineEntities(ctx.repo, ctx.rootUrl, 'decisionRecords', { [id]: record })
      return done(ctx, { created: { id, number, title: input.title, status } })
    },
  }),
  defineAiTool({
    name: 'update_decision_record',
    title: 'Update decision record (ADR)',
    description: 'Update an ADR. A status change is appended to its history timeline.',
    mode: 'write',
    schema: z.object({
      id: z.string(),
      title: z.string().min(1).optional(),
      summary: z.string().optional(),
      content: z.string().optional(),
      status: adrStatus.optional(),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const current = adrs(m)[input.id]
      if (!current) throw new AiToolError(`no decision record with id "${input.id}"`, 404)
      const now = new Date().toISOString()
      const next = { ...current, updatedAt: now }
      if (input.title !== undefined) next.title = input.title
      if (input.summary !== undefined) next.summary = input.summary
      if (input.content !== undefined) next.content = input.content
      if (input.status !== undefined && input.status !== current.status) {
        next.status = input.status
        next.history = [...(current.history ?? []), { status: input.status, date: now }]
      }
      await upsertInlineEntities(ctx.repo, ctx.rootUrl, 'decisionRecords', { [input.id]: next })
      return done(ctx, { updated: { id: input.id, number: next.number, status: next.status } })
    },
  }),
  defineAiTool({
    name: 'delete_decision_record',
    title: 'Delete decision record (ADR)',
    description: 'Delete an ADR. Destructive — only when the user explicitly asked.',
    mode: 'write',
    schema: z.object({ id: z.string() }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const record = adrs(m)[input.id]
      if (!record) throw new AiToolError(`no decision record with id "${input.id}"`, 404)
      // The assistant must not be a way around a rule the UI enforces. An
      // approved ADR records something the team decided; it is withdrawn by
      // moving it to rejected, not by deleting it.
      if (record.status === 'approved') {
        throw new AiToolError(
          `decision record "${input.id}" is approved and cannot be deleted — set its status to rejected to withdraw it`,
          409,
        )
      }
      // Unlike the client, the server knows who is asking, so ownership is a
      // real check here rather than an affordance.
      const ownerId = (record as { ownerId?: string }).ownerId
      if (ownerId && ctx.userId && ownerId !== ctx.userId) {
        throw new AiToolError(`decision record "${input.id}" belongs to someone else`, 403)
      }
      await deleteInlineEntities(ctx.repo, ctx.rootUrl, 'decisionRecords', [input.id])
      return done(ctx, { deleted: input.id })
    },
  }),
  defineAiTool({
    name: 'create_diagram',
    title: 'Create diagram',
    description:
      'Create a diagram (context/container/component view). Seeded objects are laid out in a grid, and direct connections between them are included automatically. A container/component diagram usually sets parentObjectId to the object it drills into.',
    mode: 'write',
    schema: z.object({
      name: z.string().min(1),
      type: z.enum(['context', 'container', 'component']),
      description: z.string().optional(),
      parentObjectId: z.string().optional().describe('The object this diagram zooms into'),
      domainId: z.string().optional(),
      objectIds: z.array(z.string()).optional().describe('Objects to show initially'),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      if (input.parentObjectId) requireObject(m, input.parentObjectId, 'object (parentObjectId)')
      if (input.domainId && !domains(m)[input.domainId]) {
        throw new AiToolError(`no domain with id "${input.domainId}" — see list_domains`, 404)
      }
      for (const oid of input.objectIds ?? []) requireObject(m, oid)
      const seed = input.objectIds ?? []
      const seedSet = new Set(seed)
      const connectionIds = Object.values(connections(m))
        .filter((c) => (c.kind ?? 'direct') === 'direct' && seedSet.has(c.fromId) && seedSet.has(c.toId))
        .map((c) => c.id)
      const id = await createDiagramDoc(ctx.repo, ctx.rootUrl, {
        name: input.name,
        type: input.type,
        description: input.description,
        parentObjectId: input.parentObjectId,
        domainId: input.domainId,
        objectIds: seed,
        connectionIds,
        layouts: gridPlacements(m, seed),
      }, ctx.workspace)
      const diagramWarnings: string[] = []
      if ((input.type === 'container' || input.type === 'component') && !input.parentObjectId) {
        diagramWarnings.push(`${input.type} diagrams usually zoom into an object — set parentObjectId`)
      }
      if (input.type === 'context' && seed.some((oid) => objects(m)[oid]?.type === 'component')) {
        diagramWarnings.push('a context diagram shows systems and actors — components belong on component diagrams')
      }
      return done(ctx, {
        created: { id, name: input.name, type: input.type, objects: seed.length, connections: connectionIds.length },
        ...(diagramWarnings.length ? { diagramWarnings } : {}),
      })
    },
  }),
  defineAiTool({
    name: 'update_diagram',
    title: 'Update diagram',
    description:
      'Update a diagram: rename/re-describe, add/remove objects and connections, position entities. Added objects are auto-placed unless placements gives coordinates. A connection can only be added when both endpoints are on the diagram.',
    mode: 'write',
    schema: z.object({
      id: z.string(),
      name: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      addObjectIds: z.array(z.string()).optional(),
      removeObjectIds: z.array(z.string()).optional(),
      addConnectionIds: z.array(z.string()).optional(),
      removeConnectionIds: z.array(z.string()).optional(),
      placements: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional()
        .describe('Explicit positions keyed by object id (world coordinates)'),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const d = m.diagrams[input.id]
      if (!d) throw new AiToolError(`no diagram with id "${input.id}"`, 404)
      for (const oid of input.addObjectIds ?? []) requireObject(m, oid)
      const onDiagram = new Set([
        ...(d.detail?.objectIds ?? ((d.meta.objectIds as string[] | undefined) ?? [])),
        ...(input.addObjectIds ?? []),
      ])
      for (const rid of input.removeObjectIds ?? []) onDiagram.delete(rid)
      for (const cid of input.addConnectionIds ?? []) {
        const c = connections(m)[cid]
        if (!c) throw new AiToolError(`no connection with id "${cid}"`, 404)
        if (!onDiagram.has(c.fromId) || !onDiagram.has(c.toId)) {
          throw new AiToolError(`connection ${cid} endpoints are not both on the diagram — add the objects first`)
        }
      }

      const layoutUpserts: Record<string, unknown> = {}
      const placed = new Set<string>()
      for (const [oid, pos] of Object.entries(input.placements ?? {})) {
        layoutUpserts[oid] = { position: pos, size: objects(m)[oid]?.size ?? DEFAULT_SIZE }
        placed.add(oid)
      }
      const autoIds = (input.addObjectIds ?? []).filter((oid) => !placed.has(oid))
      Object.assign(layoutUpserts, nextPlacements(m, input.id, autoIds))

      const settings: Record<string, unknown> = {}
      if (input.name !== undefined) settings.name = input.name
      if (input.description !== undefined) settings.description = input.description

      // Removing an object also drops its layout + any connections left dangling.
      const removeSet = new Set(input.removeObjectIds ?? [])
      const danglingConns = removeSet.size
        ? (d.detail?.connectionIds ?? ((d.meta.connectionIds as string[] | undefined) ?? [])).filter((cid) => {
            const c = connections(m)[cid]
            return c && (removeSet.has(c.fromId) || removeSet.has(c.toId))
          })
        : []

      const ok = await updateDiagramDoc(ctx.repo, ctx.rootUrl, input.id, {
        ...(Object.keys(settings).length ? { settings } : {}),
        addObjectIds: input.addObjectIds,
        removeObjectIds: input.removeObjectIds,
        addConnectionIds: input.addConnectionIds,
        removeConnectionIds: [...(input.removeConnectionIds ?? []), ...danglingConns],
        ...(Object.keys(layoutUpserts).length ? { layoutUpserts } : {}),
        layoutDeletes: input.removeObjectIds,
      })
      if (!ok) throw new AiToolError(`failed to update diagram "${input.id}"`, 500)
      return done(ctx, { updated: { id: input.id } })
    },
  }),
  defineAiTool({
    name: 'delete_diagram',
    title: 'Delete diagram',
    description: 'Delete a diagram (the model objects on it are NOT deleted). Destructive — only when the user explicitly asked.',
    mode: 'write',
    schema: z.object({ id: z.string() }),
    execute: async (ctx, input) => {
      const ok = await deleteDiagramDoc(ctx.repo, ctx.rootUrl, input.id)
      if (!ok) throw new AiToolError(`no diagram with id "${input.id}"`, 404)
      return done(ctx, { deleted: input.id })
    },
  }),
  defineAiTool({
    name: 'resolve_comment',
    title: 'Resolve comment',
    description: 'Mark a diagram comment as resolved, optionally posting a reply first (e.g. after addressing the feedback).',
    mode: 'write',
    schema: z.object({
      diagramId: z.string(),
      commentId: z.string(),
      reply: z.string().optional().describe('Reply text posted before resolving'),
    }),
    execute: async (ctx, input) => {
      const ok = await mutateComment(ctx.repo, ctx.rootUrl, input.diagramId, input.commentId, {
        resolve: true,
        ...(input.reply ? { reply: { text: input.reply, author: ctx.userLabel, authorId: ctx.userId } } : {}),
      })
      if (!ok) throw new AiToolError(`comment "${input.commentId}" not found on diagram "${input.diagramId}"`, 404)
      return done(ctx, { resolved: input.commentId })
    },
  }),
  defineAiTool({
    name: 'reply_to_comment',
    title: 'Reply to comment',
    description: 'Post a reply on a diagram comment without resolving it.',
    mode: 'write',
    schema: z.object({
      diagramId: z.string(),
      commentId: z.string(),
      text: z.string().min(1),
    }),
    execute: async (ctx, input) => {
      const ok = await mutateComment(ctx.repo, ctx.rootUrl, input.diagramId, input.commentId, {
        reply: { text: input.text, author: ctx.userLabel, authorId: ctx.userId },
      })
      if (!ok) throw new AiToolError(`comment "${input.commentId}" not found on diagram "${input.diagramId}"`, 404)
      return done(ctx, { replied: input.commentId })
    },
  }),
]
