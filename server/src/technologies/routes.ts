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

import type { Express, Request, Response } from 'express'
import express from 'express'
import type { Pool } from 'pg'
import { listIconPacks, searchIcons } from '../ai/core/tools/icons.js'
import { requireTechnologyCapability } from './access.js'
import { getPlatformSettingsState } from '../platform/settings.js'
import {
  MAX_TECHNOLOGY_ICON_BYTES,
  TECHNOLOGY_ASSET_PUBLIC_PREFIX,
  TechnologyAssetError,
  storeGovernedTechnologyIcon,
  technologyAssetDirectory,
} from './assets.js'
import { TechnologyInputError, normalizeTechnologyTerm, validateTechnologyRevisionInput } from './normalize.js'
import { TechnologyRepository, TechnologyRepositoryError } from './repository.js'
import {
  TECHNOLOGY_CATALOG_VIEWS,
  TECHNOLOGY_LIFECYCLES,
  TECHNOLOGY_MERGE_CHOICES,
  TECHNOLOGY_MERGE_FIELDS,
  TECHNOLOGY_OVERRIDE_STATES,
  TECHNOLOGY_POLICIES,
  TECHNOLOGY_ROLES,
  TECHNOLOGY_SHAPE_TYPES,
  TECHNOLOGY_SCOPES,
  TECHNOLOGY_WORKFLOW_STATUSES,
  type CreateTechnologyDraftInput,
  type TechnologyCatalogView,
  type TechnologyLifecycle,
  type TechnologyMergeFieldDecisions,
  type TechnologyOverrideState,
  type TechnologyPolicy,
  type TechnologyRole,
  type TechnologyShapeType,
  type TechnologyScope,
  type TechnologyWorkflowStatus,
} from './types.js'

function parseMergeFieldDecisions(raw: unknown): TechnologyMergeFieldDecisions | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TechnologyInputError('fieldDecisions must be an object')
  }
  const record = raw as Record<string, unknown>
  return Object.fromEntries(TECHNOLOGY_MERGE_FIELDS.map((field) => [
    field,
    enumValue(record[field], TECHNOLOGY_MERGE_CHOICES, `fieldDecisions.${field}`),
  ])) as TechnologyMergeFieldDecisions
}

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function positiveInt(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TechnologyInputError(`${field} must be a positive integer`)
  return parsed
}

function optionalLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined
  return positiveInt(value, 'limit')
}

function decodeIconCursor(raw: unknown): number {
  if (raw === undefined) return 0
  if (typeof raw !== 'string') throw new TechnologyInputError('after must be an icon cursor')
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { offset?: unknown }
    if (!Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error('invalid')
    return Number(parsed.offset)
  } catch {
    throw new TechnologyInputError('after must be a valid icon cursor')
  }
}

function encodeIconCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url')
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TechnologyInputError(`${field} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

function sendError(res: Response, context: string, error: unknown): void {
  if (error instanceof TechnologyAssetError) {
    res.status(error.status).json({ error: error.code, message: error.message })
    return
  }
  if (error instanceof TechnologyRepositoryError) {
    res.status(error.status).json({ error: error.code, message: error.message, details: error.details })
    return
  }
  if (error instanceof TechnologyInputError) {
    res.status(error.status).json({ error: 'invalid_request', message: error.message })
    return
  }
  console.error(`[technologies] ${context}:`, error)
  res.status(500).json({ error: 'technology_operation_failed', message: context })
}

function parseDuplicateCheck(body: unknown): CreateTechnologyDraftInput['duplicateCheck'] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const check = (body as Record<string, unknown>).duplicateCheck
  if (!check || typeof check !== 'object' || Array.isArray(check)) return null
  const value = check as Record<string, unknown>
  if (typeof value.query !== 'string' || value.confirmedNoMatch !== true) return null
  if (value.overrideReason !== undefined && typeof value.overrideReason !== 'string') {
    throw new TechnologyInputError('duplicateCheck.overrideReason must be a string')
  }
  return {
    query: value.query,
    confirmedNoMatch: true,
    overrideReason: value.overrideReason as string | undefined,
  }
}

async function requireOrg(
  pool: Pool,
  req: Request,
  res: Response,
  capability: 'technology.view' | 'technology.manage' | 'technology.approve_private' | 'technology.submit_public' | 'technology.manage_policy'
) {
  const orgId = param(req.params.orgId)
  if (!orgId) {
    res.status(400).json({ error: 'org_id_required' })
    return null
  }
  const actor = await requireTechnologyCapability(pool, req, res, capability, orgId)
  return actor ? { actor, orgId } : null
}

export function registerTechnologyRoutes(app: Express, pool: Pool): void {
  const repository = new TechnologyRepository(pool)

  app.get('/api/icons/packs', (_req, res) => {
    res.json({ packs: listIconPacks() })
  })

  app.get('/api/icons', (req, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 160) : undefined
      const pack = typeof req.query.pack === 'string' ? req.query.pack.slice(0, 120) : undefined
      const offset = decodeIconCursor(req.query.after)
      const requestedLimit = optionalLimit(req.query.limit) ?? 50
      const limit = Math.min(requestedLimit, 50)
      const result = searchIcons({ q, pack, limit, offset })
      const nextOffset = offset + result.icons.length
      res.json({
        icons: result.icons,
        total: result.total,
        nextCursor: nextOffset < result.total ? encodeIconCursor(nextOffset) : null,
      })
    } catch (error) {
      sendError(res, 'Failed to list icons', error)
    }
  })

  // Public, immutable delivery path. In production nginx serves the same
  // shared volume directly; this route is the dev/self-hosted fallback and is
  // what Vite proxies for worktree-isolated stacks.
  app.use(TECHNOLOGY_ASSET_PUBLIC_PREFIX, express.static(technologyAssetDirectory(), {
    immutable: true,
    maxAge: '1y',
    fallthrough: false,
    index: false,
    dotfiles: 'deny',
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
    },
  }))

  app.post(
    '/api/orgs/:orgId/technology-assets',
    express.raw({
      type: ['application/octet-stream', 'image/svg+xml', 'image/png'],
      // Keep the parser limit just above the domain cap so the handler can
      // return the stable technology_icon_too_large error for normal excesses.
      limit: MAX_TECHNOLOGY_ICON_BYTES + 1,
    }),
    async (req, res) => {
      const access = await requireOrg(pool, req, res, 'technology.manage')
      if (!access) return
      try {
        if (!Buffer.isBuffer(req.body)) {
          throw new TechnologyAssetError(400, 'technology_icon_required', 'Technology icon file is required')
        }
        const asset = await storeGovernedTechnologyIcon(pool, {
          orgId: access.orgId,
          actorUserId: access.actor.userId,
          raw: req.body,
          declaredContentType: req.headers['content-type'],
        })
        res.status(201).json({ asset })
      } catch (error) {
        sendError(res, 'Failed to store technology icon', error)
      }
    }
  )

  app.get('/api/orgs/:orgId/technologies', async (req, res) => {
    const access = await requireOrg(pool, req, res, 'technology.view')
    if (!access) return
    try {
      const scope = req.query.scope === undefined
        ? 'all'
        : req.query.scope === 'all'
          ? 'all'
          : enumValue(req.query.scope, TECHNOLOGY_SCOPES, 'scope') as TechnologyScope
      const status = req.query.status === undefined
        ? undefined
        : enumValue(req.query.status, TECHNOLOGY_WORKFLOW_STATUSES, 'status') as TechnologyWorkflowStatus
      const lifecycle = req.query.lifecycle === undefined
        ? undefined
        : enumValue(req.query.lifecycle, TECHNOLOGY_LIFECYCLES, 'lifecycle') as TechnologyLifecycle
      const requestedSelectable = req.query.selectable === '1' || req.query.selectable === 'true'
      const shapeType = req.query.shapeType === undefined
        ? undefined
        : enumValue(req.query.shapeType, TECHNOLOGY_SHAPE_TYPES, 'shapeType') as TechnologyShapeType
      const role = req.query.role === undefined
        ? undefined
        : enumValue(req.query.role, TECHNOLOGY_ROLES, 'role') as TechnologyRole
      const requestedView = req.query.view === undefined
        ? 'effective'
        : enumValue(req.query.view, TECHNOLOGY_CATALOG_VIEWS, 'view') as TechnologyCatalogView
      const view = access.actor.isPlatformAdmin || access.actor.orgRole === 'admin'
        ? requestedView
        : 'effective'
      const result = await repository.list(access.orgId, {
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        scope,
        status,
        lifecycle,
        after: typeof req.query.after === 'string' ? req.query.after : undefined,
        limit: optionalLimit(req.query.limit),
        category: typeof req.query.category === 'string' ? req.query.category.trim() || undefined : undefined,
        shapeType,
        role,
        view,
        // Ordinary members use this endpoint as the diagram selector and may
        // never enumerate private drafts. Org/platform admins may explicitly
        // request the complete governance catalog.
        selectable: access.actor.isPlatformAdmin || access.actor.orgRole === 'admin' ? requestedSelectable : true,
      })
      res.json(result)
    } catch (error) {
      sendError(res, 'Failed to list technologies', error)
    }
  })

  app.get('/api/orgs/:orgId/technologies/search', async (req, res) => {
    const access = await requireOrg(pool, req, res, 'technology.view')
    if (!access) return
    try {
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
      if (!query) throw new TechnologyInputError('q is required')
      const requestedSelectable = req.query.selectable === '1' || req.query.selectable === 'true'
      const matches = await repository.search(
        access.orgId,
        query,
        optionalLimit(req.query.limit),
        access.actor.isPlatformAdmin || access.actor.orgRole === 'admin' ? requestedSelectable : true
      )
      res.json({ matches, query: normalizeTechnologyTerm(query) })
    } catch (error) {
      sendError(res, 'Failed to search technologies', error)
    }
  })

  app.get('/api/orgs/:orgId/technologies/facets', async (req, res) => {
    const access = await requireOrg(pool, req, res, 'technology.view')
    if (!access) return
    try {
      const requestedSelectable = req.query.selectable === '1' || req.query.selectable === 'true'
      const selectable = access.actor.isPlatformAdmin || access.actor.orgRole === 'admin'
        ? requestedSelectable
        : true
      res.json(await repository.facets(access.orgId, selectable))
    } catch (error) {
      sendError(res, 'Failed to list technology facets', error)
    }
  })

  app.get('/api/orgs/:orgId/technologies/:technologyId', async (req, res) => {
    const access = await requireOrg(pool, req, res, 'technology.view')
    if (!access) return
    try {
      const revision = req.query.revision === undefined ? undefined : positiveInt(req.query.revision, 'revision')
      const ordinaryMember = !access.actor.isPlatformAdmin && access.actor.orgRole === 'member'
      const result = await repository.get(
        access.orgId,
        param(req.params.technologyId),
        revision,
        { selectable: ordinaryMember }
      )
      if (!result) {
        res.status(404).json({ error: 'technology_not_found' })
        return
      }
      res.json(result)
    } catch (error) {
      sendError(res, 'Failed to resolve technology', error)
    }
  })

  app.post('/api/orgs/:orgId/technologies/drafts', async (req, res) => {
    const access = await requireOrg(pool, req, res, 'technology.manage')
    if (!access) return
    try {
      const revision = validateTechnologyRevisionInput(req.body)
      const duplicateCheck = parseDuplicateCheck(req.body)
      if (!duplicateCheck) {
        const matches = await repository.search(access.orgId, revision.name, 10)
        res.status(409).json({
          error: 'public_catalog_search_required',
          message: 'Search the catalog before creating a private technology draft',
          details: { matches },
        })
        return
      }
      const technology = await repository.createPrivateDraft(access.orgId, access.actor.userId, {
        ...revision,
        duplicateCheck,
      })
      res.status(201).json({ technology })
    } catch (error) {
      sendError(res, 'Failed to create technology draft', error)
    }
  })

  app.post('/api/orgs/:orgId/technologies/:technologyId/revisions', async (req, res) => {
    const access = await requireOrg(pool, req, res, 'technology.manage')
    if (!access) return
    try {
      const input = validateTechnologyRevisionInput(req.body)
      const duplicateCheck = parseDuplicateCheck(req.body)
      if (!duplicateCheck) {
        const matches = await repository.search(access.orgId, input.name, 10)
        res.status(409).json({
          error: 'public_catalog_search_required',
          message: 'Search the catalog before creating a technology revision',
          details: { matches },
        })
        return
      }
      const technology = await repository.createRevision(
        access.orgId,
        access.actor.userId,
        param(req.params.technologyId),
        { ...input, duplicateCheck }
      )
      res.status(201).json({ technology })
    } catch (error) {
      sendError(res, 'Failed to create technology revision', error)
    }
  })

  app.patch('/api/orgs/:orgId/technologies/:technologyId/lifecycle', async (req, res) => {
    const access = await requireOrg(pool, req, res, 'technology.manage')
    if (!access) return
    try {
      const lifecycle = enumValue(req.body?.lifecycleStatus, ['active', 'retired'] as const, 'lifecycleStatus')
      const technologyId = param(req.params.technologyId)
      await repository.setPrivateLifecycle(access.orgId, access.actor.userId, technologyId, lifecycle)
      res.json({ technologyId, lifecycleStatus: lifecycle })
    } catch (error) {
      sendError(res, 'Failed to change private technology lifecycle', error)
    }
  })

  app.post('/api/orgs/:orgId/technologies/:technologyId/merge', async (req, res) => {
    const access = await requireOrg(pool, req, res, 'technology.manage')
    if (!access) return
    try {
      const targetTechnologyId = typeof req.body?.targetTechnologyId === 'string'
        ? req.body.targetTechnologyId.trim()
        : ''
      if (!targetTechnologyId) throw new TechnologyInputError('targetTechnologyId is required')
      const sourceTechnologyId = param(req.params.technologyId)
      const result = await repository.mergePrivateIdentity(
        access.orgId,
        access.actor.userId,
        sourceTechnologyId,
        targetTechnologyId,
      )
      res.json({ sourceTechnologyId, ...result })
    } catch (error) {
      sendError(res, 'Failed to merge private technology identity', error)
    }
  })

  app.post('/api/orgs/:orgId/technologies/:technologyId/revisions/:revision/approve-private', async (req, res) => {
    const access = await requireOrg(pool, req, res, 'technology.approve_private')
    if (!access) return
    try {
      const technology = await repository.approvePrivate(
        access.orgId,
        access.actor.userId,
        param(req.params.technologyId),
        positiveInt(param(req.params.revision), 'revision')
      )
      res.json({ technology })
    } catch (error) {
      sendError(res, 'Failed to approve private technology', error)
    }
  })

  app.post('/api/orgs/:orgId/technologies/:technologyId/revisions/:revision/review-private', async (req, res) => {
    const access = await requireOrg(pool, req, res, 'technology.approve_private')
    if (!access) return
    try {
      const outcome = enumValue(req.body?.outcome, ['changes_requested', 'rejected'] as const, 'outcome')
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : ''
      const technology = await repository.decidePrivate(
        access.orgId,
        access.actor.userId,
        param(req.params.technologyId),
        positiveInt(param(req.params.revision), 'revision'),
        outcome,
        reason,
      )
      res.json({ technology })
    } catch (error) {
      sendError(res, 'Failed to review private technology', error)
    }
  })

  app.post('/api/orgs/:orgId/technologies/:technologyId/revisions/:revision/submit-public', async (req, res) => {
    const access = await requireOrg(pool, req, res, 'technology.submit_public')
    if (!access) return
    try {
      const technology = await repository.submitPublic(
        access.orgId,
        access.actor.userId,
        param(req.params.technologyId),
        positiveInt(param(req.params.revision), 'revision')
      )
      res.json({ technology })
    } catch (error) {
      sendError(res, 'Failed to submit public technology', error)
    }
  })

  app.get('/api/orgs/:orgId/technology-policy', async (req, res) => {
    const access = await requireOrg(pool, req, res, 'technology.view')
    if (!access) return
    try {
      res.json({ policy: await repository.getPolicy(access.orgId) })
    } catch (error) {
      sendError(res, 'Failed to read technology policy', error)
    }
  })

  app.patch('/api/orgs/:orgId/technology-policy', async (req, res) => {
    const access = await requireOrg(pool, req, res, 'technology.manage_policy')
    if (!access) return
    try {
      const policy = enumValue(req.body?.policy, TECHNOLOGY_POLICIES, 'policy') as TechnologyPolicy
      res.json({ policy: await repository.setPolicy(access.orgId, access.actor.userId, policy) })
    } catch (error) {
      sendError(res, 'Failed to change technology policy', error)
    }
  })

  app.put('/api/orgs/:orgId/technology-overrides/:technologyId', async (req, res) => {
    const access = await requireOrg(pool, req, res, 'technology.manage_policy')
    if (!access) return
    try {
      const state = enumValue(req.body?.state, TECHNOLOGY_OVERRIDE_STATES, 'state') as TechnologyOverrideState
      const technologyId = param(req.params.technologyId)
      const result = await repository.setOverride(access.orgId, access.actor.userId, technologyId, state)
      res.json({ technologyId: result.canonicalTechnologyId, requestedTechnologyId: technologyId, state })
    } catch (error) {
      sendError(res, 'Failed to set technology override', error)
    }
  })

  app.delete('/api/orgs/:orgId/technology-overrides/:technologyId', async (req, res) => {
    const access = await requireOrg(pool, req, res, 'technology.manage_policy')
    if (!access) return
    try {
      const technologyId = param(req.params.technologyId)
      const result = await repository.clearOverride(access.orgId, access.actor.userId, technologyId)
      res.json({ success: true, technologyId: result.canonicalTechnologyId, requestedTechnologyId: technologyId })
    } catch (error) {
      sendError(res, 'Failed to clear technology override', error)
    }
  })

  app.get('/api/platform/technologies', async (req, res) => {
    const actor = await requireTechnologyCapability(pool, req, res, 'technology.platform_publish')
    if (!actor) return
    try {
      const status = typeof req.query.status === 'string'
        ? enumValue(req.query.status, TECHNOLOGY_WORKFLOW_STATUSES, 'status') as TechnologyWorkflowStatus
        : undefined
      const lifecycle = typeof req.query.lifecycle === 'string'
        ? enumValue(req.query.lifecycle, TECHNOLOGY_LIFECYCLES, 'lifecycle') as TechnologyLifecycle
        : undefined
      res.json(await repository.listPlatform({
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        status,
        lifecycle,
        after: typeof req.query.after === 'string' ? req.query.after : undefined,
        limit: optionalLimit(req.query.limit),
      }))
    } catch (error) {
      sendError(res, 'Failed to list platform technologies', error)
    }
  })

  app.get('/api/platform/technologies/search', async (req, res) => {
    const actor = await requireTechnologyCapability(pool, req, res, 'technology.platform_publish')
    if (!actor) return
    try {
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
      if (!query) throw new TechnologyInputError('q is required')
      res.json({ query, matches: await repository.searchPlatform(query, optionalLimit(req.query.limit) ?? 12) })
    } catch (error) {
      sendError(res, 'Failed to search platform technologies', error)
    }
  })

  app.post('/api/platform/technologies/drafts', async (req, res) => {
    const actor = await requireTechnologyCapability(pool, req, res, 'technology.platform_publish')
    if (!actor) return
    try {
      const revision = validateTechnologyRevisionInput(req.body)
      const duplicateCheck = parseDuplicateCheck(req.body)
      if (!duplicateCheck) {
        const matches = await repository.searchPlatform(revision.name, 10)
        res.status(409).json({
          error: 'public_catalog_search_required',
          message: 'Search the public catalog before creating a public technology draft',
          details: { matches },
        })
        return
      }
      const assetOwnerOrgId = typeof req.body?.assetOwnerOrgId === 'string'
        ? req.body.assetOwnerOrgId.trim() || undefined
        : req.auth?.orgId ?? undefined
      const technology = await repository.createPublicDraft(
        actor.userId,
        { ...revision, duplicateCheck },
        assetOwnerOrgId,
      )
      res.status(201).json({ technology })
    } catch (error) {
      sendError(res, 'Failed to create public technology draft', error)
    }
  })

  app.post('/api/platform/technologies/:technologyId/revisions', async (req, res) => {
    const actor = await requireTechnologyCapability(pool, req, res, 'technology.platform_publish')
    if (!actor) return
    try {
      const revision = validateTechnologyRevisionInput(req.body)
      const duplicateCheck = parseDuplicateCheck(req.body)
      if (!duplicateCheck) {
        const matches = await repository.searchPlatform(revision.name, 10)
        res.status(409).json({
          error: 'public_catalog_search_required',
          message: 'Search the public catalog before creating a public technology revision',
          details: { matches },
        })
        return
      }
      const technology = await repository.createPublicRevision(
        actor.userId,
        param(req.params.technologyId),
        { ...revision, duplicateCheck },
        typeof req.body?.assetOwnerOrgId === 'string'
          ? req.body.assetOwnerOrgId.trim() || undefined
          : req.auth?.orgId ?? undefined,
      )
      res.status(201).json({ technology })
    } catch (error) {
      sendError(res, 'Failed to create public technology revision', error)
    }
  })

  app.post('/api/platform/technologies/:technologyId/revisions/:revision/submit-review', async (req, res) => {
    const actor = await requireTechnologyCapability(pool, req, res, 'technology.platform_publish')
    if (!actor) return
    try {
      const technology = await repository.submitPlatformReview(
        actor.userId,
        param(req.params.technologyId),
        positiveInt(param(req.params.revision), 'revision'),
      )
      res.json({ technology })
    } catch (error) {
      sendError(res, 'Failed to submit public technology review', error)
    }
  })

  app.get('/api/platform/technologies/reviews', async (req, res) => {
    const actor = await requireTechnologyCapability(pool, req, res, 'technology.platform_publish')
    if (!actor) return
    try {
      const page = await repository.listPublicReviews({
        after: typeof req.query.after === 'string' ? req.query.after : undefined,
        limit: optionalLimit(req.query.limit),
      })
      const settings = await getPlatformSettingsState(pool)
      res.json({
        ...page,
        reviews: page.reviews.map((review) => ({
          ...review,
          reviewerEligible: review.source === 'organization'
            || !settings.independentTechnologyReviewEffective
            || (review.technology.revision.createdBy !== actor.userId && review.submittedBy !== actor.userId),
        })),
      })
    } catch (error) {
      sendError(res, 'Failed to list public technology reviews', error)
    }
  })

  app.get('/api/platform/technologies/:technologyId', async (req, res) => {
    const actor = await requireTechnologyCapability(pool, req, res, 'technology.platform_publish')
    if (!actor) return
    try {
      const result = await repository.getPlatform(param(req.params.technologyId))
      if (!result) {
        res.status(404).json({ error: 'technology_not_found' })
        return
      }
      res.json(result)
    } catch (error) {
      sendError(res, 'Failed to resolve platform technology', error)
    }
  })

  app.post('/api/platform/technologies/:technologyId/merge', async (req, res) => {
    const actor = await requireTechnologyCapability(pool, req, res, 'technology.platform_merge')
    if (!actor) return
    try {
      const targetTechnologyId = typeof req.body?.targetTechnologyId === 'string'
        ? req.body.targetTechnologyId.trim()
        : ''
      if (!targetTechnologyId) throw new TechnologyInputError('targetTechnologyId is required')
      const sourceTechnologyId = param(req.params.technologyId)
      const result = await repository.mergePublicIdentity(
        actor.userId,
        sourceTechnologyId,
        targetTechnologyId,
      )
      res.json({ sourceTechnologyId, ...result })
    } catch (error) {
      sendError(res, 'Failed to merge public technology identity', error)
    }
  })

  app.post('/api/platform/technologies/:technologyId/revisions/:revision/publish', async (req, res) => {
    const actor = await requireTechnologyCapability(pool, req, res, 'technology.platform_publish')
    if (!actor) return
    try {
      const publicTechnologyId = typeof req.body?.publicTechnologyId === 'string' ? req.body.publicTechnologyId : undefined
      const result = await repository.publish(
        actor.userId,
        param(req.params.technologyId),
        positiveInt(param(req.params.revision), 'revision'),
        publicTechnologyId
      )
      res.status(201).json(result)
    } catch (error) {
      sendError(res, 'Failed to publish technology', error)
    }
  })

  app.post('/api/platform/technologies/:technologyId/revisions/:revision/merge', async (req, res) => {
    const actor = await requireTechnologyCapability(pool, req, res, 'technology.platform_merge')
    if (!actor) return
    try {
      const targetTechnologyId = typeof req.body?.targetTechnologyId === 'string' ? req.body.targetTechnologyId.trim() : ''
      if (!targetTechnologyId) throw new TechnologyInputError('targetTechnologyId is required')
      const mergedRevision = req.body?.mergedRevision === undefined
        ? undefined
        : validateTechnologyRevisionInput(req.body.mergedRevision)
      const fieldDecisions = parseMergeFieldDecisions(req.body?.fieldDecisions)
      const result = await repository.merge(
        actor.userId,
        param(req.params.technologyId),
        positiveInt(param(req.params.revision), 'revision'),
        targetTechnologyId,
        { mergedRevision, fieldDecisions },
      )
      res.json({ sourceTechnologyId: param(req.params.technologyId), ...result })
    } catch (error) {
      sendError(res, 'Failed to merge technology', error)
    }
  })

  app.post('/api/platform/technologies/:technologyId/revisions/:revision/reject', async (req, res) => {
    const actor = await requireTechnologyCapability(pool, req, res, 'technology.platform_reject')
    if (!actor) return
    try {
      const outcome = enumValue(req.body?.outcome ?? 'rejected', ['changes_requested', 'rejected'] as const, 'outcome')
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : ''
      await repository.reject(
        actor.userId,
        param(req.params.technologyId),
        positiveInt(param(req.params.revision), 'revision'),
        outcome,
        reason
      )
      res.json({ status: outcome })
    } catch (error) {
      sendError(res, 'Failed to reject technology', error)
    }
  })

  app.patch('/api/platform/technologies/:technologyId/lifecycle', async (req, res) => {
    const actor = await requireTechnologyCapability(pool, req, res, 'technology.platform_publish')
    if (!actor) return
    try {
      const lifecycle = enumValue(req.body?.lifecycleStatus, TECHNOLOGY_LIFECYCLES, 'lifecycleStatus') as TechnologyLifecycle
      if (lifecycle === 'merged') throw new TechnologyInputError('merged lifecycle is set only by a canonical merge')
      await repository.setLifecycle(actor.userId, param(req.params.technologyId), lifecycle)
      res.json({ technologyId: param(req.params.technologyId), lifecycleStatus: lifecycle })
    } catch (error) {
      sendError(res, 'Failed to change technology lifecycle', error)
    }
  })
}
