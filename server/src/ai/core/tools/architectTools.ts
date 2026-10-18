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
import { AiToolError } from '../toolContext.js'
import {
  upsertModelEntities, upsertInlineEntities, createDiagramDoc, newEntityId, updateDiagramDoc,
} from '../modelOps.js'
import { nextPlacements } from './writeTools.js'
import {
  objects, domains,
  type ObjView, type ConnView, type DomainView,
} from './shapes.js'
import { resolveIconOrWarn, type ResolvedIcon } from './icons.js'

/**
 * create_architecture — atomic from-scratch generation. The NESTED schema is
 * the anti-hallucination guardrail: types and parentId are assigned by
 * construction (something listed under `systems[]` can only be a system, a
 * container can only be an app/store inside its system), descriptions and
 * connection labels are required by schema, every icon is resolved against
 * the visual catalog, and connections reference NAMES so ids can't be
 * invented. Validate-everything-then-write: a bad payload writes NOTHING.
 */

const DEFAULT_SIZE = { width: 160, height: 100 }
const COLOR_PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6']

const min1 = z.string().min(1)
const componentSpec = z.object({
  name: min1,
  description: min1,
  icon: z.string().optional().describe('Icon catalog name'),
})
const containerSpec = z.object({
  kind: z.enum(['app', 'store']).describe('app = service/API/UI; store = database/cache/queue/bucket'),
  name: min1,
  description: min1,
  icon: z.string().optional().describe('Icon catalog name'),
  components: z.array(componentSpec).optional().describe('Only valid for kind "app"'),
})
const systemSpec = z.object({
  name: min1,
  description: min1,
  external: z.boolean().optional().describe('true for third-party SaaS/vendor systems (Google Ads, Stripe, Auth0…)'),
  domain: z.string().optional().describe('Domain NAME — reused if it exists, created otherwise'),
  icon: z.string().optional(),
  containers: z.array(containerSpec).optional(),
})

interface PlannedObject { entity: ObjView }

/** Tag-registry upserts for many (tag name, objectId) pairs at once — a
 * working map so two new objects sharing a NEW tag get ONE registry entry
 * (the per-call helper in writeTools would mint two). */
function grid(ids: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  ids.forEach((id, i) => {
    out[id] = { position: { x: 80 + (i % 4) * 240, y: 80 + Math.floor(i / 4) * 170 }, size: DEFAULT_SIZE }
  })
  return out
}

export const architectTools: AiToolDef[] = [
  defineAiTool({
    name: 'create_architecture',
    title: 'Create a whole architecture (atomic)',
    description:
      'Create a complete architecture in ONE call: domains, actors, systems with nested containers (apps/stores) and components, plus named connections. Nesting sets types and parents correctly by construction; icons are validated against the icon catalog; one container diagram per system is created automatically, and the actors and systems go on a new context diagram — or on an EXISTING diagram when diagramId is given (use the id of the diagram the user is on when they say "this diagram", "here" or "the current diagram"). Technology assignments are managed separately through the governed catalog UI. Names must not collide with existing objects — use the unit tools to modify an existing model. Preferred over many create_model_object calls when building from scratch.',
    mode: 'write',
    schema: z.object({
      domains: z.array(z.object({ name: min1, description: z.string().optional() })).optional(),
      actors: z.array(z.object({ name: min1, description: min1 })).optional(),
      systems: z.array(systemSpec).min(1),
      connections: z.array(z.object({
        from: min1.describe('Object NAME from this payload or the existing model'),
        to: min1.describe('Object NAME from this payload or the existing model'),
        label: min1.describe('Verb phrase, e.g. "publishes events to"'),
        type: z.enum(['solid', 'dashed', 'dotted']).optional(),
      })).optional(),
      diagramId: z.string().optional()
        .describe('Existing context diagram to place the actors and systems on, instead of creating a new one'),
    }),
    execute: async (ctx, input) => {
      const m = await ctx.session.snapshot()
      const warnings: string[] = []

      // 0) The target diagram, when given, must exist and hold a context view:
      //    actors and systems on a container or component diagram break C4.
      if (input.diagramId !== undefined) {
        const target = m.diagrams[input.diagramId]
        if (!target) {
          throw new AiToolError(`no diagram with id "${input.diagramId}" — see list_diagrams`, 404)
        }
        const type = String(target.meta.type ?? 'context')
        if (type !== 'context') {
          throw new AiToolError(`diagram "${input.diagramId}" is a ${type} diagram — create_architecture places actors and systems, which belong on a context diagram; omit diagramId or pass a context diagram`, 400)
        }
      }

      // ── Validate everything BEFORE any write ──────────────────────────────
      // 1) Unique names within the payload (connections resolve by name).
      const payloadNames = new Map<string, { id: string; kind: string }>()
      const claim = (name: string, kind: string): string => {
        const key = name.trim().toLowerCase()
        if (payloadNames.has(key)) {
          throw new AiToolError(`duplicate name "${name}" in the payload — every actor/system/container/component name must be unique so connections can reference them`, 400)
        }
        const id = newEntityId()
        payloadNames.set(key, { id, kind })
        return id
      }

      // 2) No collision with the existing model.
      const existingByName = new Map<string, string[]>()
      for (const o of Object.values(objects(m))) {
        const key = (o.name ?? '').trim().toLowerCase()
        existingByName.set(key, [...(existingByName.get(key) ?? []), o.id])
      }

      const planned: PlannedObject[] = []
      const domainIdByName = new Map<string, string>()
      const newDomains: Record<string, DomainView> = {}
      const existingDomainCount = Object.keys(domains(m)).length
      const resolveDomain = (name: string | undefined, description?: string): string | undefined => {
        if (!name) return undefined
        const key = name.trim().toLowerCase()
        const cached = domainIdByName.get(key)
        if (cached) return cached
        const existing = Object.values(domains(m)).find((d) => (d.name ?? '').toLowerCase() === key)
        if (existing) {
          domainIdByName.set(key, existing.id)
          return existing.id
        }
        const id = newEntityId()
        newDomains[id] = {
          id,
          name: name.trim(),
          color: COLOR_PALETTE[(existingDomainCount + Object.keys(newDomains).length) % COLOR_PALETTE.length],
          ...(description ? { description } : {}),
        }
        domainIdByName.set(key, id)
        return id
      }
      for (const d of input.domains ?? []) resolveDomain(d.name, d.description)

      const baseEntity = (id: string, type: string, name: string, description: string): ObjView => ({
        id, type, name, description,
        position: { x: 0, y: 0 }, size: DEFAULT_SIZE,
        tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
      })

      const collisions: string[] = []
      const noteCollision = (name: string) => {
        if (existingByName.has(name.trim().toLowerCase())) collisions.push(name)
      }

      const actorIds: string[] = []
      for (const a of input.actors ?? []) {
        noteCollision(a.name)
        const id = claim(a.name, 'actor')
        planned.push({ entity: baseEntity(id, 'actor', a.name, a.description) })
        actorIds.push(id)
      }

      const systemIds: string[] = []
      const containersBySystem = new Map<string, string[]>()
      for (const sys of input.systems) {
        noteCollision(sys.name)
        const sysId = claim(sys.name, 'system')
        systemIds.push(sysId)
        const sysDomainId = resolveDomain(sys.domain)
        let sysIcon: Partial<ResolvedIcon> = {}
        if (sys.icon) {
          const { warning, ...resolved } = resolveIconOrWarn(sys.icon, 'system')
          sysIcon = resolved
          if (warning) warnings.push(`${sys.name}: ${warning}`)
        }
        planned.push({
          entity: {
            ...baseEntity(sysId, 'system', sys.name, sys.description),
            ...(sys.external ? { scope: 'external' } : {}),
            ...(sysDomainId ? { domainId: sysDomainId } : {}),
            ...sysIcon,
          },
        })

        const containerIds: string[] = []
        for (const c of sys.containers ?? []) {
          if (c.kind === 'store' && c.components?.length) {
            throw new AiToolError(`"${c.name}": components can only live inside an app, not a store`, 400)
          }
          noteCollision(c.name)
          const cId = claim(c.name, c.kind)
          containerIds.push(cId)
          let cIcon: Partial<ResolvedIcon> = {}
          if (c.icon) {
            const { warning, ...resolved } = resolveIconOrWarn(c.icon, c.kind)
            cIcon = resolved
            if (warning) warnings.push(`${c.name}: ${warning}`)
          }
          planned.push({
            entity: {
              ...baseEntity(cId, c.kind, c.name, c.description),
              parentId: sysId,
              ...(sysDomainId ? { domainId: sysDomainId } : {}),
              ...cIcon,
            },
          })
          for (const comp of c.components ?? []) {
            noteCollision(comp.name)
            const compId = claim(comp.name, 'component')
            let compIcon: Partial<ResolvedIcon> = {}
            if (comp.icon) {
              const { warning, ...resolved } = resolveIconOrWarn(comp.icon, 'component')
              compIcon = resolved
              if (warning) warnings.push(`${comp.name}: ${warning}`)
            }
            planned.push({
              entity: {
                ...baseEntity(compId, 'component', comp.name, comp.description),
                parentId: cId,
                ...(sysDomainId ? { domainId: sysDomainId } : {}),
                ...compIcon,
              },
            })
          }
        }
        containersBySystem.set(sysId, containerIds)
      }

      if (collisions.length) {
        throw new AiToolError(
          `these names already exist in the model: ${collisions.join(', ')} — create_architecture only builds NEW content; use the unit tools (update_model_object, create_connection…) to modify existing objects`,
          409
        )
      }

      // 3) Connections resolve by name against payload + existing model.
      const parentOf = new Map<string, string>()
      for (const p of planned) if (p.entity.parentId) parentOf.set(p.entity.id, p.entity.parentId)
      const resolveEndpoint = (name: string): string => {
        const key = name.trim().toLowerCase()
        const inPayload = payloadNames.get(key)
        if (inPayload) return inPayload.id
        const existing = existingByName.get(key) ?? []
        if (existing.length === 1) return existing[0]
        if (existing.length > 1) {
          throw new AiToolError(`connection endpoint "${name}" is ambiguous (${existing.length} existing objects share that name) — use the unit tools with ids instead`, 400)
        }
        throw new AiToolError(`connection endpoint "${name}" matches nothing in this payload or the existing model — check the spelling`, 400)
      }
      const plannedConnections: ConnView[] = []
      for (const conn of input.connections ?? []) {
        const fromId = resolveEndpoint(conn.from)
        const toId = resolveEndpoint(conn.to)
        if (fromId === toId) throw new AiToolError(`connection "${conn.from}" → "${conn.to}" resolves to the same object`, 400)
        if (parentOf.get(fromId) === toId || parentOf.get(toId) === fromId) {
          throw new AiToolError(`connection "${conn.from}" → "${conn.to}" links a parent to its own child — nesting already expresses containment`, 400)
        }
        plannedConnections.push({
          id: newEntityId(),
          fromId,
          toId,
          label: conn.label,
          type: conn.type ?? 'solid',
          kind: 'direct',
        })
      }

      // ── Write phase (validation passed — nothing above mutated state) ────
      if (Object.keys(newDomains).length) {
        await upsertInlineEntities(ctx.repo, ctx.rootUrl, 'domains', newDomains)
      }
      const objectUpserts: Record<string, unknown> = {}
      for (const p of planned) objectUpserts[p.entity.id] = p.entity
      await upsertModelEntities(ctx.repo, ctx.rootUrl, 'objects', objectUpserts, ctx.workspace)
      if (plannedConnections.length) {
        const connUpserts: Record<string, unknown> = {}
        for (const c of plannedConnections) connUpserts[c.id] = c
        await upsertModelEntities(ctx.repo, ctx.rootUrl, 'connections', connUpserts, ctx.workspace)
      }
      // Auto-diagrams: context (systems + actors) + one container view per
      // system that has containers. The client's auto-layout can prettify.
      const diagrams: { id: string; name: string; type: string }[] = []
      const contextIds = [...systemIds, ...actorIds]
      const contextSet = new Set(contextIds)
      const contextConns = plannedConnections
        .filter((c) => contextSet.has(c.fromId) && contextSet.has(c.toId))
        .map((c) => c.id)
      if (input.diagramId !== undefined) {
        // A diagram renders only the connections attached to it, so a new
        // connection to an object ALREADY on the target diagram is attached too.
        const shown = new Set([...contextIds, ...(m.diagrams[input.diagramId]!.detail?.objectIds ?? [])])
        const placed = await updateDiagramDoc(ctx.repo, ctx.rootUrl, input.diagramId, {
          addObjectIds: contextIds,
          addConnectionIds: plannedConnections
            .filter((c) => shown.has(c.fromId) && shown.has(c.toId))
            .map((c) => c.id),
          layoutUpserts: nextPlacements(m, input.diagramId, contextIds),
        })
        if (!placed) {
          // The model is written; only the placement failed. Say so instead of
          // reporting a diagram the user will find empty.
          warnings.push(`the objects were created but could not be placed on diagram "${input.diagramId}" — add them with update_diagram`)
        } else {
          diagrams.push({ id: input.diagramId, name: String(m.diagrams[input.diagramId]!.meta.name ?? input.diagramId), type: 'context' })
        }
      } else {
        const contextName = 'System context'
        const contextId = await createDiagramDoc(ctx.repo, ctx.rootUrl, {
          name: contextName,
          type: 'context',
          objectIds: contextIds,
          connectionIds: contextConns,
          layouts: grid(contextIds),
        }, ctx.workspace)
        diagrams.push({ id: contextId, name: contextName, type: 'context' })
      }

      for (const sys of input.systems) {
        const sysId = payloadNames.get(sys.name.trim().toLowerCase())!.id
        const containerIds = containersBySystem.get(sysId) ?? []
        if (containerIds.length === 0) continue
        const memberSet = new Set(containerIds)
        const connIds = plannedConnections
          .filter((c) => memberSet.has(c.fromId) && memberSet.has(c.toId))
          .map((c) => c.id)
        const name = `${sys.name} containers`
        const id = await createDiagramDoc(ctx.repo, ctx.rootUrl, {
          name,
          type: 'container',
          parentObjectId: sysId,
          objectIds: containerIds,
          connectionIds: connIds,
          layouts: grid(containerIds),
        }, ctx.workspace)
        diagrams.push({ id, name, type: 'container' })
      }

      ctx.session.invalidate()
      const byKind = (kind: string) =>
        [...payloadNames.values()].filter((v) => v.kind === kind || (kind === 'container' && (v.kind === 'app' || v.kind === 'store'))).length
      return {
        created: {
          domains: Object.keys(newDomains).length,
          actors: byKind('actor'),
          systems: byKind('system'),
          containers: byKind('container'),
          components: byKind('component'),
          connections: plannedConnections.length,
          diagrams,
        },
        ...(warnings.length ? { warnings } : {}),
        next: 'Run validate_architecture and audit_model_completeness, fix any findings in this content, then summarize.',
      }
    },
  }),
]
