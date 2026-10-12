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
 * REST client for the Org Admin console (`server/src/rbac/orgRoutes.ts` +
 * `server/src/auth/invites.ts`'s create-invite route). Matches the fetch style
 * of `src/lib/auth/api.ts` — same API_BASE resolution, `credentials: 'include'`
 * on every call (session is an httpOnly cookie).
 *
 * Every failure is surfaced as an `OrgAdminApiError` carrying `{status, code}`
 * so pages can branch on specific server codes (403 → forbidden screen,
 * 409 'last-admin' / 'stale' → friendly inline errors) instead of parsing
 * message strings.
 */

import type { TechnologyRole, TechnologyShapeType } from '../../types'
import { registerTechnologyCanonicalIds } from '../technologies/canonicalIds'

import { API_BASE } from '../api/base'

export class OrgAdminApiError extends Error {
  status: number
  code: string | null
  /** Full parsed error response body, so callers that need more than the
   * `{error}` code (e.g. the 409 `{error:'stale', conflicts}` shape from the
   * batched access-apply route) can read it without a second parse. */
  body: unknown

  constructor(status: number, code: string | null, message: string, body: unknown) {
    super(message)
    this.name = 'OrgAdminApiError'
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
    const message = typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message
      : code ?? `Request failed: HTTP ${res.status}`
    throw new OrgAdminApiError(res.status, code, message, body)
  }
  return body as T
}

// ── B1 — Overview ──────────────────────────────────────────────────────────

export interface AuditEntry {
  id: string
  at: string
  actorUserId: string
  impersonatorUserId: string | null
  action: string
  targetKind: string
  targetId: string
  detail: unknown
}

export interface OrgOverview {
  org: {
    id: string
    name: string
    slug: string
    status: string
    settings: { inviteTtlHours?: number }
  }
  memberCount: number
  teamCount: number
  pendingInviteCount: number
  landscapeCount: number
  recentAudit: AuditEntry[]
}

export function getOverview(orgId: string): Promise<OrgOverview> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/overview`)
}

export type ReadModelWorkspaceStatus =
  | 'healthy'
  | 'degraded'
  /** Durable Automerge writes exist that the projector never observed, while it
   * believes it is caught up — the shape an orphaned change watcher takes. */
  | 'stale'
  | 'catching_up'
  | 'failed'
  | 'idle'
  | 'uninitialized'

/** Subsystem that could not complete its projection while the workspace kept
 * serving its last coherent read model. */
export type ReadModelDegradationKind =
  | 'cold_build'
  | 'object_shard'
  | 'connection_shard'
  | 'registry'
  | 'metadata'
  | 'monolith'
  | 'document_resolution'

export interface ReadModelWorkspaceHealth {
  landscapeId: string
  landscapeName: string
  versionId: string
  versionName: string
  status: ReadModelWorkspaceStatus
  projectorAttached: boolean
  observedGeneration: number
  projectedGeneration: number
  pendingGenerations: number
  lagMs: number
  stalenessMs: number | null
  lastProjectedAt: string | null
  lastDurationMs: number | null
  lastErrorAt: string | null
  lastErrorCode: string | null
  degradedSince: string | null
  degradedKind: ReadModelDegradationKind | null
  degradedErrorCode: string | null
  /** Newest durable chunk write across the workspace's documents, read from
   * storage rather than from the projector's own counters. */
  newestDurableWriteAt: string | null
}

export interface OrgReadModelHealth {
  enabled: boolean
  generatedAt: string
  counts: Record<ReadModelWorkspaceStatus, number>
  worstLagMs: number
  totalWorkspaceCount: number
  listedWorkspaceCount: number
  workspaces: ReadModelWorkspaceHealth[]
}

export function getReadModelHealth(orgId: string, signal?: AbortSignal): Promise<OrgReadModelHealth> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/read-model-health`, { signal })
}

// ── B2 — Members ────────────────────────────────────────────────────────────

export interface MemberTeam {
  id: string
  name: string
}

export interface OrgMember {
  userId: string
  email: string
  name: string | null
  role: 'admin' | 'member'
  status: string
  teams: MemberTeam[]
}

export interface MembersPage {
  members: OrgMember[]
  nextCursor: string | null
}

export function getMembers(
  orgId: string,
  opts: { q?: string; after?: string | null; limit?: number; excludeTeamId?: string } = {}
): Promise<MembersPage> {
  const params = new URLSearchParams()
  if (opts.q) params.set('q', opts.q)
  if (opts.after) params.set('after', opts.after)
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.excludeTeamId) params.set('excludeTeamId', opts.excludeTeamId)
  const qs = params.toString()
  return request(`/api/orgs/${encodeURIComponent(orgId)}/members${qs ? `?${qs}` : ''}`)
}

export function updateMemberRole(orgId: string, userId: string, role: 'admin' | 'member'): Promise<{ userId: string; role: string }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  })
}

export function removeMember(orgId: string, userId: string): Promise<void> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  })
}

export interface OrgInvite {
  id: string
  email: string
  role: string
  expiresAt: string
  acceptedAt: string | null
  createdAt: string
  expired: boolean
  /** Pre-assigned teams (invites v2) — applied at acceptance. */
  teams: MemberTeam[]
}

export interface InvitesPage {
  invites: OrgInvite[]
  nextCursor: string | null
}

export function getInvites(
  orgId: string,
  opts: { after?: string | null; limit?: number; all?: boolean } = {}
): Promise<InvitesPage> {
  const params = new URLSearchParams()
  if (opts.after) params.set('after', opts.after)
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.all) params.set('all', '1')
  const qs = params.toString()
  return request(`/api/orgs/${encodeURIComponent(orgId)}/invites${qs ? `?${qs}` : ''}`)
}

export function createInvite(
  orgId: string,
  email: string,
  role: 'admin' | 'member',
  teamIds: string[] = []
): Promise<{ id: string; acceptUrl: string }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/invites`, {
    method: 'POST',
    body: JSON.stringify(teamIds.length > 0 ? { email, role, teamIds } : { email, role }),
  })
}

/** Edit a PENDING invite's role and/or pre-assigned teams — "configure the
 * account before they accept". */
export function updateInvite(
  orgId: string,
  inviteId: string,
  patch: { role?: 'admin' | 'member'; teamIds?: string[] }
): Promise<void> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function revokeInvite(orgId: string, inviteId: string): Promise<void> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`, {
    method: 'DELETE',
  })
}

// ── Org settings (name + whitelisted settings) ──────────────────────────────

export interface OrgSettings {
  inviteTtlHours?: number
}

export function updateOrg(
  orgId: string,
  patch: { name?: string; settings?: OrgSettings }
): Promise<{ org: { id: string; name: string; settings: OrgSettings } }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

// ── B3 — Teams ──────────────────────────────────────────────────────────────

export interface OrgTeam {
  id: string
  name: string
  archivedAt: string | null
  memberCount: number
}

export interface TeamsPage {
  teams: OrgTeam[]
  nextCursor: string | null
}

export function getTeams(orgId: string, opts: { after?: string | null; limit?: number } = {}): Promise<TeamsPage> {
  const params = new URLSearchParams()
  if (opts.after) params.set('after', opts.after)
  if (opts.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  return request(`/api/orgs/${encodeURIComponent(orgId)}/teams${qs ? `?${qs}` : ''}`)
}

export interface TeamMember {
  userId: string
  email: string
  name: string | null
}

export interface TeamDetailPage {
  team: { id: string; name: string; archivedAt: string | null }
  members: TeamMember[]
  nextCursor: string | null
}

export function getTeam(
  orgId: string,
  teamId: string,
  opts: { after?: string | null; limit?: number } = {},
): Promise<TeamDetailPage> {
  const params = new URLSearchParams()
  if (opts.after) params.set('after', opts.after)
  if (opts.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  return request(
    `/api/orgs/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}${qs ? `?${qs}` : ''}`,
  )
}

export function createTeam(orgId: string, name: string): Promise<OrgTeam> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/teams`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export function updateTeam(
  orgId: string,
  teamId: string,
  patch: { name?: string; archived?: boolean }
): Promise<{ id: string; name: string; archivedAt: string | null }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function addTeamMember(orgId: string, teamId: string, userId: string): Promise<void> {
  return request(
    `/api/orgs/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
    { method: 'PUT' }
  )
}

export function removeTeamMember(orgId: string, teamId: string, userId: string): Promise<void> {
  return request(
    `/api/orgs/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' }
  )
}

// ── B4/B5 — Access matrix ────────────────────────────────────────────────────

export type ScopeKind = 'org' | 'landscape' | 'version' | 'domain'

export interface AccessScope {
  id: string
  kind: ScopeKind
  landscapeId: string | null
  versionId: string | null
  domainId: string | null
  parentId: string | null
}

export interface AccessTeam {
  id: string
  name: string
}

export interface AccessGrant {
  teamId: string
  scopeId: string
  resourceType: string
  canRead: boolean
  canWrite: boolean
  updatedAt: string
}

export interface AccessMatrix {
  scopes: AccessScope[]
  teams: AccessTeam[]
  grants: AccessGrant[]
}

export function getAccessMatrix(orgId: string): Promise<AccessMatrix> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/access`)
}

export interface AccessChange {
  teamId: string
  scopeId: string
  resourceType: string
  canRead: boolean
  canWrite: boolean
  expectedUpdatedAt: string | null
}

export interface AccessApplyResult {
  applied: number
  warnings: Array<{ type: string; landscapeId: string }>
}

export interface AccessConflict {
  teamId: string
  scopeId: string
  resourceType: string
}

export function applyAccessChanges(orgId: string, changes: AccessChange[]): Promise<AccessApplyResult> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/access`, {
    method: 'PUT',
    body: JSON.stringify({ changes }),
  })
}

export interface AccessPreviewResult {
  allowed: boolean
  canRead: boolean
  canWrite: boolean
  via: string
  grantScopeId: string | null
}

export function getAccessPreview(orgId: string, userId: string, scopeId: string, resourceType = '*'): Promise<AccessPreviewResult> {
  const params = new URLSearchParams({ userId, scopeId, resourceType })
  return request(`/api/orgs/${encodeURIComponent(orgId)}/access/preview?${params.toString()}`)
}

// ── Landscapes (public — used to map scope landscape/version ids to names) ──

export interface VersionInfo {
  id: string
  landscapeId: string
  label: string
  rootUrl: string
  parentVersionId: string | null
  kind: string
  status: string
  createdAt: string
}

export interface LandscapeInfo {
  id: string
  name: string
  defaultVersionId: string | null
  createdAt: string
  versions: VersionInfo[]
}

export async function getLandscapes(): Promise<LandscapeInfo[]> {
  const result = await request<{ landscapes: LandscapeInfo[] }>('/api/landscapes')
  return result.landscapes
}

// ── Demo seed (ORG_SEED=on only) ─────────────────────────────────────────────

export interface SeedResult {
  landscapeId: string
  landscapeName: string
  versions: number
  diagrams: number
  objects: number
  connections: number
  teams: number
  users: number
}

export async function seedDemoEnvironment(orgId: string): Promise<SeedResult> {
  const result = await request<{ result: SeedResult }>(`/api/orgs/${encodeURIComponent(orgId)}/seed`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return result.result
}

// ── Technologies ────────────────────────────────────────────────────────────

export type TechnologyScope = 'public' | 'org_private'
export type TechnologyRevisionStatus = 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'rejected'
export type TechnologyLifecycleStatus = 'active' | 'deprecated' | 'retired' | 'merged'
export type OrgTechnologyState = 'enabled' | 'hidden'
export type OrgTechnologyOverride = 'enabled' | 'hidden' | null

export interface TechnologyRevision {
  revision: number
  status: TechnologyRevisionStatus
  privateApproved: boolean
  name: string
  description: string | null
  websiteUrl: string | null
  documentationUrl: string | null
  aliases: string[]
  category: string | null
  iconLightPath: string | null
  iconDarkPath: string | null
  publisher: string | null
  ecosystem: string | null
  recommendedShapeTypes: TechnologyShapeType[]
  defaultRole: TechnologyRole
  createdAt?: string
  createdBy?: string | null
  submittedBy?: string | null
  decisionNote?: string | null
}

export interface OrgTechnology {
  id: string
  scope: TechnologyScope
  ownerOrgId: string | null
  lifecycleStatus: TechnologyLifecycleStatus
  canonicalTechnologyId: string | null
  canonicalTechnologyName?: string | null
  redirectedFromIds?: string[]
  revision: TechnologyRevision
  orgState: OrgTechnologyState
  orgOverride: OrgTechnologyOverride
  matchKind?: 'exact_name' | 'exact_alias' | 'name_prefix' | 'alias_prefix' | 'contains'
  score?: number
  usageCount?: number
}

export interface TechnologyPage {
  technologies: OrgTechnology[]
  nextCursor: string | null
  policy: 'all' | 'none'
}

export interface TechnologyDraftInput {
  name: string
  description?: string
  websiteUrl?: string
  documentationUrl?: string
  aliases?: string[]
  category?: string
  iconLightPath?: string
  iconDarkPath?: string
  publisher?: string
  ecosystem?: string
  recommendedShapeTypes?: TechnologyShapeType[]
  defaultRole?: TechnologyRole
}

export interface TechnologyIconAsset {
  path: string
  contentType: 'image/svg+xml' | 'image/png'
  bytes: number
  sha256: string
}

export const MAX_TECHNOLOGY_ICON_BYTES = 256 * 1024

export async function uploadTechnologyIcon(
  orgId: string,
  file: File,
  signal?: AbortSignal
): Promise<TechnologyIconAsset> {
  if (file.size > MAX_TECHNOLOGY_ICON_BYTES) {
    throw new OrgAdminApiError(
      413,
      'technology_icon_too_large',
      'Technology icon must not exceed 256 KB',
      null
    )
  }
  const contentType = file.type || 'application/octet-stream'
  const res = await fetch(`${API_BASE}/api/orgs/${encodeURIComponent(orgId)}/technology-assets`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': contentType },
    body: file,
    signal,
  })
  const body = await res.json().catch(() => ({})) as {
    asset?: TechnologyIconAsset
    error?: string
    message?: string
  }
  if (!res.ok || !body.asset) {
    throw new OrgAdminApiError(
      res.status,
      body.error ?? null,
      body.message ?? body.error ?? `Request failed: HTTP ${res.status}`,
      body
    )
  }
  return body.asset
}

export interface TechnologyDuplicateCheck {
  query: string
  confirmedNoMatch: true
  overrideReason?: string
}

export interface TechnologyAiProposal extends TechnologyDraftInput {
  sources: Array<{ url: string; title?: string; retrievedAt: string }>
  confidence: number
  warnings: string[]
}

export type TechnologyAiResearchContext = Partial<Pick<TechnologyDraftInput,
  | 'name'
  | 'description'
  | 'websiteUrl'
  | 'documentationUrl'
  | 'aliases'
  | 'category'
  | 'publisher'
  | 'ecosystem'
  | 'recommendedShapeTypes'
  | 'defaultRole'
>>

export function getTechnologies(
  orgId: string,
  opts: {
    q?: string
    scope?: TechnologyScope | 'all'
    status?: string
    lifecycle?: TechnologyLifecycleStatus | 'all'
    view?: 'effective' | 'submissions'
    after?: string | null
    limit?: number
    duplicateSearch?: boolean
  } = {}
): Promise<TechnologyPage> {
  const params = new URLSearchParams()
  if (opts.q) params.set('q', opts.q)
  if (opts.scope && opts.scope !== 'all') params.set('scope', opts.scope)
  if (opts.status && opts.status !== 'all') params.set('status', opts.status)
  if (opts.lifecycle && opts.lifecycle !== 'all') params.set('lifecycle', opts.lifecycle)
  if (opts.view) params.set('view', opts.view)
  if (opts.after) params.set('after', opts.after)
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.duplicateSearch) params.set('duplicateSearch', '1')
  const qs = params.toString()
  return request<TechnologyPage>(`/api/orgs/${encodeURIComponent(orgId)}/technologies${qs ? `?${qs}` : ''}`)
    .then((page) => {
      registerTechnologyCanonicalIds(page.technologies)
      return page
    })
}

export function searchTechnologies(
  orgId: string,
  query: string,
  limit = 12
): Promise<{ matches: OrgTechnology[]; query: string; searchId?: string }> {
  const params = new URLSearchParams({ q: query, limit: String(limit) })
  return request<{ matches: OrgTechnology[]; query: string; searchId?: string }>(
    `/api/orgs/${encodeURIComponent(orgId)}/technologies/search?${params.toString()}`,
  ).then((result) => {
    registerTechnologyCanonicalIds(result.matches)
    return result
  })
}

export function createTechnologyDraft(
  orgId: string,
  input: TechnologyDraftInput & { duplicateCheck: TechnologyDuplicateCheck }
): Promise<{ technology: OrgTechnology }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/technologies/drafts`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function createTechnologyRevision(
  orgId: string,
  technologyId: string,
  input: TechnologyDraftInput & { duplicateCheck: TechnologyDuplicateCheck }
): Promise<{ technology: OrgTechnology }> {
  return request(
    `/api/orgs/${encodeURIComponent(orgId)}/technologies/${encodeURIComponent(technologyId)}/revisions`,
    { method: 'POST', body: JSON.stringify(input) }
  )
}

export function setTechnologyPolicy(orgId: string, policy: 'all' | 'none'): Promise<{ policy: 'all' | 'none' }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/technology-policy`, {
    method: 'PATCH',
    body: JSON.stringify({ policy }),
  })
}

export function setTechnologyOverride(
  orgId: string,
  technologyId: string,
  state: 'enabled' | 'hidden' | null
): Promise<unknown> {
  const path = `/api/orgs/${encodeURIComponent(orgId)}/technology-overrides/${encodeURIComponent(technologyId)}`
  if (state === null) return request(path, { method: 'DELETE' })
  return request(path, { method: 'PUT', body: JSON.stringify({ state }) })
}

export function setPrivateTechnologyLifecycle(
  orgId: string,
  technologyId: string,
  lifecycleStatus: 'active' | 'retired',
): Promise<{ technologyId: string; lifecycleStatus: 'active' | 'retired' }> {
  return request(
    `/api/orgs/${encodeURIComponent(orgId)}/technologies/${encodeURIComponent(technologyId)}/lifecycle`,
    { method: 'PATCH', body: JSON.stringify({ lifecycleStatus }) },
  )
}

export function mergePrivateTechnologyIdentity(
  orgId: string,
  sourceTechnologyId: string,
  targetTechnologyId: string,
): Promise<{ sourceTechnologyId: string; canonicalTechnologyId: string }> {
  return request(
    `/api/orgs/${encodeURIComponent(orgId)}/technologies/${encodeURIComponent(sourceTechnologyId)}/merge`,
    { method: 'POST', body: JSON.stringify({ targetTechnologyId }) },
  )
}

export function approvePrivateTechnology(orgId: string, technologyId: string, revision: number): Promise<{ technology: OrgTechnology }> {
  return request(
    `/api/orgs/${encodeURIComponent(orgId)}/technologies/${encodeURIComponent(technologyId)}/revisions/${revision}/approve-private`,
    { method: 'POST', body: JSON.stringify({}) }
  )
}

export function decidePrivateTechnology(
  orgId: string,
  technologyId: string,
  revision: number,
  outcome: 'changes_requested' | 'rejected',
  reason: string,
): Promise<{ technology: OrgTechnology }> {
  return request(
    `/api/orgs/${encodeURIComponent(orgId)}/technologies/${encodeURIComponent(technologyId)}/revisions/${revision}/review-private`,
    { method: 'POST', body: JSON.stringify({ outcome, reason }) },
  )
}

export function submitTechnologyPublic(orgId: string, technologyId: string, revision: number): Promise<{ technology: OrgTechnology }> {
  return request(
    `/api/orgs/${encodeURIComponent(orgId)}/technologies/${encodeURIComponent(technologyId)}/revisions/${revision}/submit-public`,
    { method: 'POST', body: JSON.stringify({}) }
  )
}

export function researchTechnologyMetadata(
  orgId: string,
  query: string,
  signal?: AbortSignal,
  context?: TechnologyAiResearchContext,
): Promise<{ proposal: TechnologyAiProposal }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/technologies/ai/research`, {
    method: 'POST',
    body: JSON.stringify({ query, ...(context && Object.keys(context).length > 0 ? { context } : {}) }),
    ...(signal ? { signal } : {}),
  })
}
