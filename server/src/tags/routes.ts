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

import { createHash, randomUUID } from 'node:crypto'
import type { Express, Request, Response } from 'express'
import type { Pool } from 'pg'
import { requireTagCapability } from './access.js'
import {
  TagInputError,
  validateTagGroupInput,
  validateTagGroupPatchInput,
  validateTagInput,
  validateTagMoveInput,
  validateTagPatchInput,
  validateWorkspaceContext,
} from './normalize.js'
import { TagRepository, TagRepositoryError } from './repository.js'
import {
  consumeTagRateLimit,
  recordTagOperationEvents,
  tagOperationSummary,
  type TagRateBucket,
} from './operations.js'
import {
  TAG_BATCH_ACTIONS,
  TAG_GROUP_LIFECYCLES,
  TAG_LIFECYCLES,
  TAG_OPERATION_EVENT_TYPES,
  type TagBatchInput,
  type TagCapability,
  type TagOperationEventInput,
} from './types.js'

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}
function limit(raw: unknown): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new TagInputError('limit must be a positive integer')
  return Math.min(value, 100)
}

function expectedVersion(raw: unknown, field = 'expectedVersion'): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new TagInputError(`${field} must be a positive integer`)
  return value
}

function requiredId(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 200) throw new TagInputError(`${field} must be a valid ID`)
  return raw.trim()
}

function operationEvents(raw: unknown): TagOperationEventInput[] {
  const body = raw as { events?: unknown } | null
  if (!Array.isArray(body?.events) || body.events.length < 1 || body.events.length > 100) {
    throw new TagInputError('events must contain between 1 and 100 operations')
  }
  const now = Date.now()
  return body.events.map((rawEvent, index) => {
    const event = rawEvent as Record<string, unknown> | null
    if (!event || typeof event.id !== 'string' || !/^tagop_client_[0-9a-f]{32}$/.test(event.id)) {
      throw new TagInputError(`events[${index}].id must be a client-generated operation ID`)
    }
    if (typeof event.eventType !== 'string' || !TAG_OPERATION_EVENT_TYPES.includes(event.eventType as TagOperationEventInput['eventType'])) {
      throw new TagInputError(`events[${index}].eventType is invalid`)
    }
    if (event.itemKind !== 'tag' && event.itemKind !== 'group') {
      throw new TagInputError(`events[${index}].itemKind must be tag or group`)
    }
    const reasonCode = event.reasonCode === null || event.reasonCode === undefined ? null : event.reasonCode
    if (reasonCode !== null && (typeof reasonCode !== 'string' || !/^[a-z0-9_:-]{1,80}$/.test(reasonCode))) {
      throw new TagInputError(`events[${index}].reasonCode is invalid`)
    }
    if (!Number.isSafeInteger(event.ageMs) || Number(event.ageMs) < 0 || Number(event.ageMs) > 3_024_000_000) {
      throw new TagInputError(`events[${index}].ageMs is invalid`)
    }
    if (!Number.isSafeInteger(event.attemptCount) || Number(event.attemptCount) < 0 || Number(event.attemptCount) > 1_000) {
      throw new TagInputError(`events[${index}].attemptCount is invalid`)
    }
    if (typeof event.occurredAt !== 'string') throw new TagInputError(`events[${index}].occurredAt is invalid`)
    const occurredAt = new Date(event.occurredAt)
    if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > now + 5 * 60_000) {
      throw new TagInputError(`events[${index}].occurredAt is invalid`)
    }
    return {
      id: event.id,
      eventType: event.eventType as TagOperationEventInput['eventType'],
      itemKind: event.itemKind,
      reasonCode,
      ageMs: Number(event.ageMs),
      attemptCount: Number(event.attemptCount),
      occurredAt: occurredAt.toISOString(),
    }
  })
}

function operationWindow(raw: unknown): '24h' | '7d' | '30d' {
  if (raw === undefined || raw === '') return '7d'
  if (raw === '24h' || raw === '7d' || raw === '30d') return raw
  throw new TagInputError('window must be 24h, 7d, or 30d')
}

function batchInput(raw: unknown): TagBatchInput {
  const body = raw as Record<string, unknown> | null
  if (!body || typeof body.action !== 'string' || !TAG_BATCH_ACTIONS.includes(body.action as TagBatchInput['action'])) {
    throw new TagInputError(`action must be one of: ${TAG_BATCH_ACTIONS.join(', ')}`)
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
    throw new TagInputError('items must contain between 1 and 100 Tags')
  }
  const items = body.items.map((rawItem, index) => {
    const item = rawItem as Record<string, unknown> | null
    return {
      id: requiredId(item?.id, `items[${index}].id`),
      expectedVersion: expectedVersion(item?.expectedVersion, `items[${index}].expectedVersion`),
    }
  })
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new TagInputError('items must not contain duplicate Tag IDs')
  }
  const action = body.action as TagBatchInput['action']
  if (action === 'recolor') {
    const color = validateTagPatchInput({ color: body.color }).color
    if (!color) throw new TagInputError('color is required for a recolor batch')
    return { action, items, color }
  }
  if (action === 'move') return { action, items, groupId: requiredId(body.groupId, 'groupId') }
  return { action, items }
}

function lifecycle<T extends string>(raw: unknown, values: readonly T[], field: string): T | undefined {
  if (raw === undefined || raw === '') return undefined
  if (typeof raw !== 'string' || !values.includes(raw as T)) {
    throw new TagInputError(`${field} must be one of: ${values.join(', ')}`)
  }
  return raw as T
}

function requestId(req: Request): string {
  const header = req.get('x-request-id')
  return header && header.length <= 160 ? header : randomUUID()
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function mutationContext(req: Request, actorUserId: string, operation: string) {
  const key = req.get('idempotency-key')
  const context: {
    actorUserId: string
    requestId: string
    idempotency?: { key: string; operation: string; requestHash: string }
  } = { actorUserId, requestId: requestId(req) }
  if (key === undefined) return context
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    throw new TagInputError('Idempotency-Key must contain 1 to 128 safe ASCII characters')
  }
  context.idempotency = {
    key,
    operation,
    requestHash: createHash('sha256').update(stableJson({
      method: req.method,
      path: req.path,
      body: req.body ?? null,
    })).digest('hex'),
  }
  return context
}

function sendError(res: Response, context: string, error: unknown): void {
  if (error instanceof TagRepositoryError) {
    res.status(error.status).json({ error: error.code, message: error.message, details: error.details })
    return
  }
  if (error instanceof TagInputError) {
    res.status(error.status).json({ error: 'invalid_request', message: error.message })
    return
  }
  console.error(`[tags] ${context}:`, error)
  res.status(500).json({ error: 'tag_operation_failed', message: context })
}

async function authorize(
  pool: Pool,
  req: Request,
  res: Response,
  capability: TagCapability,
  workspace = null as ReturnType<typeof validateWorkspaceContext>,
  rateBucket: TagRateBucket = capability === 'tag.view' || capability === 'tag.audit_view' ? 'read' : 'mutation',
) {
  const orgId = param(req.params.orgId)
  if (!orgId) {
    res.status(400).json({ error: 'org_id_required' })
    return null
  }
  const actor = await requireTagCapability(pool, req, res, capability, orgId, workspace)
  if (!actor) return null
  if (!actor.userId.startsWith('system:')) {
    const rate = await consumeTagRateLimit(pool, { orgId, actorUserId: actor.userId, bucket: rateBucket })
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds))
      res.status(429).json({
        error: 'tag_rate_limited',
        message: `Tag catalog ${rateBucket} rate limit reached`,
      })
      return null
    }
  }
  return { actor, orgId }
}

export function registerTagRoutes(app: Express, pool: Pool): void {
  const repository = new TagRepository(pool)

  app.get('/api/orgs/:orgId/tag-settings', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.view')
      if (!access) return
      res.json({ settings: await repository.getSettings(access.orgId) })
    } catch (error) {
      sendError(res, 'Unable to load Tag settings', error)
    }
  })

  app.patch('/api/orgs/:orgId/tag-settings', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.manage_policy')
      if (!access) return
      const body = req.body as Record<string, unknown>
      if (typeof body?.allowMemberTagCreation !== 'boolean' || typeof body?.allowEditorTagGroupCreation !== 'boolean') {
        throw new TagInputError('both Tag policy values must be booleans')
      }
      if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) {
        throw new TagInputError('expectedVersion must be a non-negative integer')
      }
      const settings = await repository.updateSettings(access.orgId, {
        allowMemberTagCreation: body.allowMemberTagCreation,
        allowEditorTagGroupCreation: body.allowEditorTagGroupCreation,
      }, Number(body.expectedVersion), mutationContext(req, access.actor.userId, 'tag.settings.update'))
      res.json({ settings })
    } catch (error) {
      sendError(res, 'Unable to update Tag settings', error)
    }
  })

  app.post('/api/orgs/:orgId/tag-operations/events', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.view', null, 'mutation')
      if (!access) return
      const result = await recordTagOperationEvents(pool, {
        orgId: access.orgId,
        actorUserId: access.actor.userId,
        events: operationEvents(req.body),
      })
      res.status(202).json(result)
    } catch (error) {
      sendError(res, 'Unable to record Tag outbox operations', error)
    }
  })

  app.get('/api/orgs/:orgId/tag-operations/summary', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.audit_view')
      if (!access) return
      res.json({ summary: await tagOperationSummary(pool, access.orgId, operationWindow(req.query.window)) })
    } catch (error) {
      sendError(res, 'Unable to load Tag outbox operations', error)
    }
  })

  app.get('/api/orgs/:orgId/tag-groups', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.view')
      if (!access) return
      res.json(await repository.listGroups({
        orgId: access.orgId,
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        status: lifecycle(req.query.status, TAG_GROUP_LIFECYCLES, 'status'),
        after: typeof req.query.after === 'string' ? req.query.after : undefined,
        limit: limit(req.query.limit),
      }))
    } catch (error) {
      sendError(res, 'Unable to list Tag Groups', error)
    }
  })

  app.post('/api/orgs/:orgId/tag-groups', async (req, res) => {
    try {
      const workspace = validateWorkspaceContext(req.body?.workspace)
      const access = await authorize(pool, req, res, 'tag_group.create', workspace)
      if (!access) return
      const group = await repository.createGroup(
        access.orgId,
        validateTagGroupInput(req.body),
        mutationContext(req, access.actor.userId, 'tag_group.create'),
      )
      res.status(201).json({ group })
    } catch (error) {
      sendError(res, 'Unable to create Tag Group', error)
    }
  })

  app.post('/api/orgs/:orgId/tag-groups/reconcile-local', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.merge')
      if (!access) return
      const group = await repository.reconcileLocalGroup(
        access.orgId,
        validateTagGroupInput(req.body),
        requiredId(req.body?.targetGroupId, 'targetGroupId'),
        mutationContext(req, access.actor.userId, 'tag_group.outbox.reconcile'),
      )
      res.json({ group })
    } catch (error) {
      sendError(res, 'Unable to reconcile the offline Tag Group', error)
    }
  })

  app.patch('/api/orgs/:orgId/tag-groups/:groupId', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.catalog_edit')
      if (!access) return
      const group = await repository.updateGroup(
        access.orgId,
        requiredId(param(req.params.groupId), 'groupId'),
        validateTagGroupPatchInput(req.body),
        expectedVersion(req.body?.expectedVersion),
        mutationContext(req, access.actor.userId, 'tag_group.update'),
      )
      res.json({ group })
    } catch (error) {
      sendError(res, 'Unable to update Tag Group', error)
    }
  })

  app.post('/api/orgs/:orgId/tag-groups/:groupId/archive', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.archive')
      if (!access) return
      const group = await repository.setGroupLifecycle(
        access.orgId,
        requiredId(param(req.params.groupId), 'groupId'),
        'archived',
        expectedVersion(req.body?.expectedVersion),
        mutationContext(req, access.actor.userId, 'tag_group.archive'),
      )
      res.json({ group })
    } catch (error) {
      sendError(res, 'Unable to archive Tag Group', error)
    }
  })

  app.post('/api/orgs/:orgId/tag-groups/:groupId/restore', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.restore')
      if (!access) return
      const group = await repository.setGroupLifecycle(
        access.orgId,
        requiredId(param(req.params.groupId), 'groupId'),
        'active',
        expectedVersion(req.body?.expectedVersion),
        mutationContext(req, access.actor.userId, 'tag_group.restore'),
      )
      res.json({ group })
    } catch (error) {
      sendError(res, 'Unable to restore Tag Group', error)
    }
  })

  app.post('/api/orgs/:orgId/tag-groups/reorder', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.catalog_edit')
      if (!access) return
      const group = await repository.moveGroup(
        access.orgId,
        requiredId(req.body?.groupId, 'groupId'),
        validateTagMoveInput(req.body),
        expectedVersion(req.body?.expectedVersion),
        mutationContext(req, access.actor.userId, 'tag_group.reorder'),
      )
      res.json({ group })
    } catch (error) {
      sendError(res, 'Unable to reorder Tag Group', error)
    }
  })

  app.get('/api/orgs/:orgId/tags', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.view')
      if (!access) return
      const groupIds = typeof req.query.groupIds === 'string'
        ? req.query.groupIds.split(',').map((value) => value.trim()).filter(Boolean).slice(0, 100)
        : undefined
      res.json(await repository.listTags({
        orgId: access.orgId,
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        groupIds,
        status: lifecycle(req.query.status, TAG_LIFECYCLES, 'status'),
        after: typeof req.query.after === 'string' ? req.query.after : undefined,
        limit: limit(req.query.limit),
      }))
    } catch (error) {
      sendError(res, 'Unable to list Tags', error)
    }
  })

  app.post('/api/orgs/:orgId/tags', async (req, res) => {
    try {
      const workspace = validateWorkspaceContext(req.body?.workspace)
      const access = await authorize(pool, req, res, 'tag.create', workspace)
      if (!access) return
      const tag = await repository.createTag(
        access.orgId,
        validateTagInput(req.body),
        mutationContext(req, access.actor.userId, 'tag.create'),
      )
      res.status(201).json({ tag })
    } catch (error) {
      sendError(res, 'Unable to create Tag', error)
    }
  })

  app.post('/api/orgs/:orgId/tags/reconcile-local', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.merge')
      if (!access) return
      const result = await repository.reconcileLocalTag(
        access.orgId,
        validateTagInput(req.body),
        requiredId(req.body?.targetTagId, 'targetTagId'),
        mutationContext(req, access.actor.userId, 'tag.outbox.reconcile'),
      )
      res.json(result)
    } catch (error) {
      sendError(res, 'Unable to reconcile the offline Tag', error)
    }
  })

  app.get('/api/orgs/:orgId/tags/:tagId/audit', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.audit_view')
      if (!access) return
      const action = typeof req.query.action === 'string' ? req.query.action.trim() : ''
      if (action.length > 120) throw new TagInputError('action must not exceed 120 characters')
      res.json(await repository.listTagAudit({
        orgId: access.orgId,
        tagId: requiredId(param(req.params.tagId), 'tagId'),
        action: action || undefined,
        after: typeof req.query.after === 'string' ? req.query.after : undefined,
        limit: limit(req.query.limit),
      }))
    } catch (error) {
      sendError(res, 'Unable to load Tag audit history', error)
    }
  })

  app.get('/api/orgs/:orgId/tags/:tagId/assignments', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.audit_view')
      if (!access) return
      const kind = typeof req.query.kind === 'string' && req.query.kind !== 'all' ? req.query.kind : undefined
      if (kind !== undefined && kind !== 'object' && kind !== 'group') {
        throw new TagInputError('kind must be object, group, or all')
      }
      res.json(await repository.listTagAssignments({
        orgId: access.orgId,
        tagId: requiredId(param(req.params.tagId), 'tagId'),
        kind,
        after: typeof req.query.after === 'string' ? req.query.after : undefined,
        limit: limit(req.query.limit),
      }))
    } catch (error) {
      sendError(res, 'Unable to load Tag assignments', error)
    }
  })

  app.post('/api/orgs/:orgId/tags/resolve', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.view')
      if (!access) return
      if (!Array.isArray(req.body?.tagIds) || req.body.tagIds.length > 100
        || !req.body.tagIds.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 200)) {
        throw new TagInputError('tagIds must contain at most 100 valid IDs')
      }
      res.json(await repository.resolveTags(access.orgId, req.body.tagIds))
    } catch (error) {
      sendError(res, 'Unable to resolve Tags', error)
    }
  })

  app.post('/api/orgs/:orgId/tags/usage-summary', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.view')
      if (!access) return
      if (!Array.isArray(req.body?.tagIds) || req.body.tagIds.length < 1 || req.body.tagIds.length > 100
        || !req.body.tagIds.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 200)) {
        throw new TagInputError('tagIds must contain between 1 and 100 valid IDs')
      }
      res.json({ usage: await repository.tagUsageSummary(access.orgId, req.body.tagIds) })
    } catch (error) {
      sendError(res, 'Unable to load Tag usage summary', error)
    }
  })

  app.post('/api/orgs/:orgId/tags/batch', async (req, res) => {
    try {
      const input = batchInput(req.body)
      const capability: TagCapability = input.action === 'archive'
        ? 'tag.archive'
        : input.action === 'restore'
          ? 'tag.restore'
          : 'tag.catalog_edit'
      const access = await authorize(pool, req, res, capability)
      if (!access) return
      const tags = await repository.batchMutateTags(
        access.orgId,
        input,
        mutationContext(req, access.actor.userId, `tag.batch.${input.action}`),
      )
      res.json({ tags })
    } catch (error) {
      sendError(res, 'Unable to update Tags in bulk', error)
    }
  })

  app.post('/api/orgs/:orgId/tags/reorder', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.catalog_edit')
      if (!access) return
      const tag = await repository.moveTag(
        access.orgId,
        requiredId(req.body?.tagId, 'tagId'),
        validateTagMoveInput(req.body),
        expectedVersion(req.body?.expectedVersion),
        mutationContext(req, access.actor.userId, 'tag.reorder'),
      )
      res.json({ tag })
    } catch (error) {
      sendError(res, 'Unable to reorder Tag', error)
    }
  })

  app.patch('/api/orgs/:orgId/tags/:tagId', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.catalog_edit')
      if (!access) return
      const tag = await repository.updateTag(
        access.orgId,
        requiredId(param(req.params.tagId), 'tagId'),
        validateTagPatchInput(req.body),
        expectedVersion(req.body?.expectedVersion),
        mutationContext(req, access.actor.userId, 'tag.update'),
      )
      res.json({ tag })
    } catch (error) {
      sendError(res, 'Unable to update Tag', error)
    }
  })

  app.post('/api/orgs/:orgId/tags/:tagId/archive', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.archive')
      if (!access) return
      const tag = await repository.setTagLifecycle(
        access.orgId,
        requiredId(param(req.params.tagId), 'tagId'),
        'archived',
        expectedVersion(req.body?.expectedVersion),
        mutationContext(req, access.actor.userId, 'tag.archive'),
      )
      res.json({ tag })
    } catch (error) {
      sendError(res, 'Unable to archive Tag', error)
    }
  })

  app.post('/api/orgs/:orgId/tags/:tagId/restore', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.restore')
      if (!access) return
      const tag = await repository.setTagLifecycle(
        access.orgId,
        requiredId(param(req.params.tagId), 'tagId'),
        'active',
        expectedVersion(req.body?.expectedVersion),
        mutationContext(req, access.actor.userId, 'tag.restore'),
      )
      res.json({ tag })
    } catch (error) {
      sendError(res, 'Unable to restore Tag', error)
    }
  })

  app.post('/api/orgs/:orgId/tags/:tagId/merge', async (req, res) => {
    try {
      const access = await authorize(pool, req, res, 'tag.merge')
      if (!access) return
      const result = await repository.mergeTags(
        access.orgId,
        requiredId(param(req.params.tagId), 'tagId'),
        requiredId(req.body?.targetTagId, 'targetTagId'),
        expectedVersion(req.body?.expectedSourceVersion, 'expectedSourceVersion'),
        expectedVersion(req.body?.expectedTargetVersion, 'expectedTargetVersion'),
        mutationContext(req, access.actor.userId, 'tag.merge'),
      )
      res.json(result)
    } catch (error) {
      sendError(res, 'Unable to merge Tags', error)
    }
  })
}
