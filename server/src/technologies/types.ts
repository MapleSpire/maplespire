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

export const TECHNOLOGY_SCOPES = ['public', 'org_private'] as const
export type TechnologyScope = (typeof TECHNOLOGY_SCOPES)[number]

export const TECHNOLOGY_LIFECYCLES = ['active', 'deprecated', 'retired', 'merged'] as const
export type TechnologyLifecycle = (typeof TECHNOLOGY_LIFECYCLES)[number]

export const TECHNOLOGY_WORKFLOW_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'rejected',
] as const
export type TechnologyWorkflowStatus = (typeof TECHNOLOGY_WORKFLOW_STATUSES)[number]

export const TECHNOLOGY_POLICIES = ['all', 'none'] as const
export type TechnologyPolicy = (typeof TECHNOLOGY_POLICIES)[number]

export const TECHNOLOGY_OVERRIDE_STATES = ['enabled', 'hidden'] as const
export type TechnologyOverrideState = (typeof TECHNOLOGY_OVERRIDE_STATES)[number]

/** C4 shape types that can carry a governed technology recommendation.
 * Actors are intentionally excluded: a person is never an implementation
 * target. `group` is kept because groups are first-class diagram shapes. */
export const TECHNOLOGY_SHAPE_TYPES = ['system', 'app', 'store', 'component', 'group'] as const
export type TechnologyShapeType = (typeof TECHNOLOGY_SHAPE_TYPES)[number]

/** Governed default applied when a technology is first assigned. A usage may
 * override this role without mutating the central catalog revision. */
export const TECHNOLOGY_ROLES = [
  'primary',
  'language',
  'runtime',
  'framework',
  'library',
  'database',
  'storage',
  'messaging',
  'protocol',
  'platform',
  'infrastructure',
  'tooling',
  'other',
] as const
export type TechnologyRole = (typeof TECHNOLOGY_ROLES)[number]

export interface TechnologyRevisionInput {
  name: string
  description?: string | null
  websiteUrl?: string | null
  documentationUrl?: string | null
  aliases?: string[]
  category?: string | null
  iconLightPath?: string | null
  iconDarkPath?: string | null
  publisher?: string | null
  ecosystem?: string | null
  /** Required at the HTTP boundary. Internal seed/import callers that omit it
   * are conservatively treated as compatible with every supported shape. */
  recommendedShapeTypes?: TechnologyShapeType[]
  /** Required at the HTTP boundary; internal callers default to `other`. */
  defaultRole?: TechnologyRole
}

export interface TechnologyRevision extends Required<Omit<TechnologyRevisionInput, 'description' | 'websiteUrl' | 'documentationUrl' | 'category' | 'iconLightPath' | 'iconDarkPath' | 'publisher' | 'ecosystem'>> {
  revision: number
  status: TechnologyWorkflowStatus
  /** Organization approval, independent from the public-review workflow. */
  privateApproved: boolean
  description: string | null
  websiteUrl: string | null
  documentationUrl: string | null
  category: string | null
  iconLightPath: string | null
  iconDarkPath: string | null
  publisher: string | null
  ecosystem: string | null
  createdAt: string
  createdBy: string | null
  submittedBy: string | null
  decisionNote: string | null
}

export interface TechnologyView {
  id: string
  scope: TechnologyScope
  ownerOrgId: string | null
  lifecycleStatus: TechnologyLifecycle
  canonicalTechnologyId: string | null
  /** Display name of the canonical target for merged identities. */
  canonicalTechnologyName: string | null
  /** Legacy IDs visible to this reader that resolve to this identity. */
  redirectedFromIds: string[]
  revision: TechnologyRevision
  orgState: TechnologyOverrideState
  /** Sparse explicit org override; null means orgState is inherited from policy. */
  orgOverride: TechnologyOverrideState | null
}

export const TECHNOLOGY_CATALOG_VIEWS = ['effective', 'submissions'] as const
export type TechnologyCatalogView = (typeof TECHNOLOGY_CATALOG_VIEWS)[number]

export const TECHNOLOGY_MERGE_FIELDS = [
  'name',
  'description',
  'websiteUrl',
  'documentationUrl',
  'aliases',
  'category',
  'iconLightPath',
  'iconDarkPath',
  'recommendedShapeTypes',
  'defaultRole',
] as const
export type TechnologyMergeField = (typeof TECHNOLOGY_MERGE_FIELDS)[number]

export const TECHNOLOGY_MERGE_CHOICES = ['keep_public', 'take_proposal', 'edit'] as const
export type TechnologyMergeChoice = (typeof TECHNOLOGY_MERGE_CHOICES)[number]
export type TechnologyMergeFieldDecisions = Record<TechnologyMergeField, TechnologyMergeChoice>

export interface TechnologyMergeInput {
  /** Fully validated materialized result of the field-by-field comparison. */
  mergedRevision?: TechnologyRevisionInput
  fieldDecisions?: TechnologyMergeFieldDecisions
}

export interface TechnologySearchMatch extends TechnologyView {
  matchKind: 'exact_name' | 'exact_alias' | 'name_prefix' | 'alias_prefix' | 'contains'
  score: number
}

export interface TechnologyListResult {
  technologies: TechnologyView[]
  nextCursor: string | null
  policy: TechnologyPolicy
}

export interface TechnologyCatalogFacets {
  categories: Array<{ value: string; count: number }>
  shapeTypes: Array<{ value: TechnologyShapeType; count: number }>
  roles: Array<{ value: TechnologyRole; count: number }>
}

export interface PlatformTechnologyReview {
  technology: TechnologyView
  organization: { id: string; name: string }
  source: 'organization' | 'platform'
  submittedAt: string
  submittedBy: string
}

export interface PlatformTechnologyReviewPage {
  reviews: PlatformTechnologyReview[]
  nextCursor: string | null
}

export interface DuplicateCheck {
  query: string
  confirmedNoMatch: true
  overrideReason?: string
}

export interface CreateTechnologyDraftInput extends TechnologyRevisionInput {
  duplicateCheck: DuplicateCheck
}

export interface CreateTechnologyRevisionInput extends TechnologyRevisionInput {
  duplicateCheck: DuplicateCheck
}

export interface TechnologySeedDefinition extends TechnologyRevisionInput {
  id: string
  /** Per-entry seeded revision when above the catalog-wide one; set when an
   * existing catalog entry's artwork or description changed. */
  seedRevision?: number
}

export type TechnologyCapability =
  | 'technology.view'
  | 'technology.manage'
  | 'technology.approve_private'
  | 'technology.submit_public'
  | 'technology.manage_policy'
  | 'technology.platform_publish'
  | 'technology.platform_merge'
  | 'technology.platform_reject'
