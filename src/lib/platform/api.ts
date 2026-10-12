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

/**
 * REST client for the Platform Admin console. Matches the fetch style of `src/lib/orgAdmin/api.ts` — same
 * API_BASE resolution, `credentials: 'include'` on every call (session is an
 * httpOnly cookie), `PlatformApiError` carrying `{status, code}` so pages can
 * branch on specific server codes (403 → forbidden screen, 409 'last-platform-admin'
 * → friendly inline error) instead of parsing message strings.
 */

import type {
  OrgTechnology,
  TechnologyAiProposal,
  TechnologyAiResearchContext,
  TechnologyDraftInput,
  TechnologyLifecycleStatus,
  TechnologyRevisionStatus,
} from '../orgAdmin/api'

import { API_BASE } from '../api/base'

export class PlatformApiError extends Error {
  status: number
  code: string | null
  body: unknown

  constructor(status: number, code: string | null, message: string, body: unknown) {
    super(message)
    this.name = 'PlatformApiError'
    this.status = status
    this.code = code
    this.body = body
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const code = typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : null
    throw new PlatformApiError(res.status, code, code ?? `Request failed: HTTP ${res.status}`, body)
  }
  return body as T
}

// ── C1 — Overview ────────────────────────────────────────────────────────────

export interface PlatformOverview {
  orgs: number
  users: number
  landscapes: number
  versions: number
  liveConnections: number
  activeImpersonations: number
}

export function getOverview(): Promise<PlatformOverview> {
  return request('/api/platform/overview')
}

export interface PlatformSettings {
  requireIndependentTechnologyReview: boolean
  activePlatformAdminCount: number
  independentTechnologyReviewEffective: boolean
}

export function getPlatformSettings(): Promise<PlatformSettings> {
  return request('/api/platform/settings')
}

export function updatePlatformSettings(input: {
  requireIndependentTechnologyReview: boolean
}): Promise<PlatformSettings> {
  return request('/api/platform/settings', {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

// ── Technology public-review queue ──────────────────────────────────────────

export interface PlatformTechnologyReview {
  technology: OrgTechnology
  organization: { id: string; name: string }
  source: 'organization' | 'platform'
  submittedAt: string
  submittedBy: string
  reviewerEligible: boolean
}

export interface PlatformTechnologyReviewPage {
  reviews: PlatformTechnologyReview[]
  nextCursor: string | null
}

export function getTechnologyReviews(opts: { after?: string | null; limit?: number } = {}): Promise<PlatformTechnologyReviewPage> {
  const params = new URLSearchParams()
  if (opts.after) params.set('after', opts.after)
  if (opts.limit) params.set('limit', String(opts.limit))
  const query = params.toString()
  return request(`/api/platform/technologies/reviews${query ? `?${query}` : ''}`)
}

export function publishTechnologyReview(technologyId: string, revision: number): Promise<{ sourceId: string; publicTechnologyId: string }> {
  return request(`/api/platform/technologies/${encodeURIComponent(technologyId)}/revisions/${revision}/publish`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export type TechnologyMergeField =
  | 'name' | 'description' | 'websiteUrl' | 'documentationUrl' | 'aliases'
  | 'category' | 'iconLightPath' | 'iconDarkPath' | 'recommendedShapeTypes' | 'defaultRole'
export type TechnologyMergeChoice = 'keep_public' | 'take_proposal' | 'edit'

export interface TechnologyMergeInput {
  mergedRevision: TechnologyDraftInput
  fieldDecisions: Record<TechnologyMergeField, TechnologyMergeChoice>
}

export function getPlatformTechnology(technologyId: string): Promise<{
  technology: OrgTechnology
  resolution: { requestedId: string; canonicalTechnologyId: string; redirected: boolean; path: string[] }
}> {
  return request(`/api/platform/technologies/${encodeURIComponent(technologyId)}`)
}

export function mergeTechnologyReview(
  technologyId: string,
  revision: number,
  targetTechnologyId: string,
  input?: TechnologyMergeInput,
): Promise<{ sourceTechnologyId: string; canonicalTechnologyId: string; canonicalRevision: number }> {
  return request(`/api/platform/technologies/${encodeURIComponent(technologyId)}/revisions/${revision}/merge`, {
    method: 'POST',
    body: JSON.stringify({ targetTechnologyId, ...input }),
  })
}

export function mergePublicTechnologyIdentity(
  sourceTechnologyId: string,
  targetTechnologyId: string,
): Promise<{ sourceTechnologyId: string; canonicalTechnologyId: string }> {
  return request(`/api/platform/technologies/${encodeURIComponent(sourceTechnologyId)}/merge`, {
    method: 'POST',
    body: JSON.stringify({ targetTechnologyId }),
  })
}

export function decideTechnologyReview(
  technologyId: string,
  revision: number,
  outcome: 'changes_requested' | 'rejected',
  reason: string,
): Promise<{ status: typeof outcome }> {
  return request(`/api/platform/technologies/${encodeURIComponent(technologyId)}/revisions/${revision}/reject`, {
    method: 'POST',
    body: JSON.stringify({ outcome, reason }),
  })
}

export interface PlatformTechnologyPage {
  technologies: OrgTechnology[]
  nextCursor: string | null
  policy: 'all'
}

export function getPlatformTechnologies(opts: {
  q?: string
  status?: TechnologyRevisionStatus | 'all'
  lifecycle?: TechnologyLifecycleStatus | 'all'
  after?: string | null
  limit?: number
} = {}): Promise<PlatformTechnologyPage> {
  const params = new URLSearchParams()
  if (opts.q) params.set('q', opts.q)
  if (opts.status && opts.status !== 'all') params.set('status', opts.status)
  if (opts.lifecycle && opts.lifecycle !== 'all') params.set('lifecycle', opts.lifecycle)
  if (opts.after) params.set('after', opts.after)
  if (opts.limit) params.set('limit', String(opts.limit))
  const query = params.toString()
  return request(`/api/platform/technologies${query ? `?${query}` : ''}`)
}

export function searchPlatformTechnologies(query: string, limit = 12): Promise<{ query: string; matches: OrgTechnology[] }> {
  const params = new URLSearchParams({ q: query, limit: String(limit) })
  return request(`/api/platform/technologies/search?${params.toString()}`)
}

type PublicTechnologyDraft = TechnologyDraftInput & {
  assetOwnerOrgId?: string
  duplicateCheck: { query: string; confirmedNoMatch: true; overrideReason?: string }
}

export function createPublicTechnologyDraft(input: PublicTechnologyDraft): Promise<{ technology: OrgTechnology }> {
  return request('/api/platform/technologies/drafts', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function createPublicTechnologyRevision(
  technologyId: string,
  input: PublicTechnologyDraft,
): Promise<{ technology: OrgTechnology }> {
  return request(`/api/platform/technologies/${encodeURIComponent(technologyId)}/revisions`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function submitPublicTechnologyReview(technologyId: string, revision: number): Promise<{ technology: OrgTechnology }> {
  return request(`/api/platform/technologies/${encodeURIComponent(technologyId)}/revisions/${revision}/submit-review`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export function researchPlatformTechnologyMetadata(
  orgId: string,
  query: string,
  context: TechnologyAiResearchContext,
  signal?: AbortSignal,
): Promise<{ proposal: TechnologyAiProposal }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/technologies/ai/research`, {
    method: 'POST',
    body: JSON.stringify({ query, context }),
    ...(signal ? { signal } : {}),
  })
}

// ── C2 — Organizations ───────────────────────────────────────────────────────

export interface PlatformOrg {
  id: string
  name: string
  slug: string
  status: 'active' | 'suspended'
  memberCount: number
  createdAt: string
}

export interface OrgsPage {
  orgs: PlatformOrg[]
  nextCursor: string | null
}

export function getOrgs(opts: { q?: string; after?: string | null; limit?: number } = {}): Promise<OrgsPage> {
  const params = new URLSearchParams()
  if (opts.q) params.set('q', opts.q)
  if (opts.after) params.set('after', opts.after)
  if (opts.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  return request(`/api/platform/orgs${qs ? `?${qs}` : ''}`)
}

export function createOrg(name: string, slug: string): Promise<PlatformOrg> {
  return request('/api/platform/orgs', {
    method: 'POST',
    body: JSON.stringify({ name, slug }),
  })
}

export function updateOrgStatus(orgId: string, status: 'active' | 'suspended'): Promise<{ id: string; status: string }> {
  return request(`/api/platform/orgs/${encodeURIComponent(orgId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

// ── C3 — Users (global) ──────────────────────────────────────────────────────

export interface PlatformUserOrg {
  orgId: string
  role: string
  /** Org display name/slug (null when the org row no longer exists). */
  name: string | null
  slug: string | null
}

export interface PlatformUser {
  id: string
  email: string
  name: string | null
  status: string
  isPlatformAdmin: boolean
  orgs: PlatformUserOrg[]
}

export interface UsersPage {
  users: PlatformUser[]
  nextCursor: string | null
}

export function getUsers(opts: { q?: string; after?: string | null; limit?: number } = {}): Promise<UsersPage> {
  const params = new URLSearchParams()
  if (opts.q) params.set('q', opts.q)
  if (opts.after) params.set('after', opts.after)
  if (opts.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  return request(`/api/platform/users${qs ? `?${qs}` : ''}`)
}

export function updateUserStatus(userId: string, status: 'active' | 'deactivated'): Promise<{ id: string; status: string }> {
  return request(`/api/platform/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

export function setPlatformAdmin(userId: string, grant: boolean): Promise<{ id: string; isPlatformAdmin: boolean }> {
  return request(`/api/platform/users/${encodeURIComponent(userId)}/platform-admin`, {
    method: 'PATCH',
    body: JSON.stringify({ grant }),
  })
}

// ── C4 — Impersonation ───────────────────────────────────────────────────────

export function startImpersonation(userId: string): Promise<{ target: { id: string; email: string } }> {
  return request('/api/platform/impersonate', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  })
}

export function exitImpersonation(): Promise<void> {
  return request('/api/auth/impersonate/exit', { method: 'POST' })
}

export interface ActiveImpersonation {
  id: string
  adminEmail: string
  targetEmail: string
  startedAt: string
}

export function getActiveImpersonations(): Promise<{ impersonations: ActiveImpersonation[] }> {
  return request('/api/platform/impersonations?active=1')
}

/** Force-end someone else's "view as" session (marks the row ended; the target's
 * imp cookie simply expires — socket/epoch cleanup is a later hardening item). */
export function forceEndImpersonation(id: string): Promise<void> {
  return request(`/api/platform/impersonations/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ── C6 — Access debugger ─────────────────────────────────────────────────────

export interface AccessDebugResult {
  allowed?: boolean
  canRead?: boolean
  canWrite?: boolean
  via?: string
  grantScopeId?: string | null
  scope?: unknown
  userEmail?: string
  [key: string]: unknown
}

export function getAccessDebug(userId: string, scopeId: string): Promise<AccessDebugResult> {
  const params = new URLSearchParams({ userId, scopeId })
  return request(`/api/platform/access-debug?${params.toString()}`)
}

// ── C8 — Global audit ────────────────────────────────────────────────────────

export interface PlatformAuditEntry {
  id: string
  at: string
  actorUserId?: string
  actorEmail?: string
  impersonatorUserId?: string | null
  impersonatorEmail?: string | null
  action: string
  targetKind?: string
  targetId?: string
  orgId?: string | null
  orgName?: string | null
  detail?: unknown
}

export interface AuditPage {
  entries: PlatformAuditEntry[]
  nextCursor: string | null
}

export function getAudit(opts: { orgId?: string; action?: string; after?: string | null; limit?: number } = {}): Promise<AuditPage> {
  const params = new URLSearchParams()
  if (opts.orgId) params.set('orgId', opts.orgId)
  if (opts.action) params.set('action', opts.action)
  if (opts.after) params.set('after', opts.after)
  if (opts.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  return request(`/api/platform/audit${qs ? `?${qs}` : ''}`)
}

// ── Reference integrity ──────────────────────────────────────────────────────

export interface ReferenceFinding {
  landscapeId: string
  versionId: string
  kind: string
  severity: 'dangling' | 'orphaned' | 'unreadable' | 'expected'
  sourceId: string
  field: string
  targetId: string
  repairIsRemoval: boolean
}

export interface ReferenceIntegrityReport {
  reportOnly: true
  scannedAt: string
  workspaces: number
  findings: ReferenceFinding[]
  countsByKind: Record<string, number>
  checkedKinds: string[]
  /** Reference kinds NEITHER leg looked at. Always render these. */
  uncheckedKinds: string[]
  truncated: boolean
  /** Present only when the walk was requested. */
  documents?: {
    findings: ReferenceFinding[]
    countsByKind: Record<string, number>
    checkedKinds: string[]
    diagramsWalked: number
    diagramsSkipped: number
    truncated: boolean
  }
}

export interface ReferenceRepairPlan {
  finding: ReferenceFinding
  action: string
  safeToApply: boolean
  reason?: string
}

export interface ReferenceRepairResult {
  reportOnly: boolean
  landscapeId: string
  versionId: string
  plans: ReferenceRepairPlan[]
  applied: number
  skipped: number
  truncated: boolean
}

export function scanReferenceIntegrity(options: {
  landscapeId?: string
  versionId?: string
  documents?: boolean
} = {}): Promise<ReferenceIntegrityReport> {
  const params = new URLSearchParams()
  if (options.landscapeId) params.set('landscapeId', options.landscapeId)
  if (options.versionId) params.set('versionId', options.versionId)
  if (options.documents) params.set('documents', 'true')
  const query = params.toString()
  return request<ReferenceIntegrityReport>(`/api/platform/reference-integrity${query ? `?${query}` : ''}`)
}

/** `apply` defaults to false server-side; the workspace is required there too,
 *  so a fleet-wide apply cannot be expressed from here either. */
export function repairReferenceIntegrity(body: {
  landscapeId: string
  versionId: string
  documents?: boolean
  apply?: boolean
}): Promise<ReferenceRepairResult> {
  return request<ReferenceRepairResult>('/api/platform/reference-integrity/repair', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
