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

export const TAG_LIFECYCLES = ['active', 'archived', 'merged'] as const
export type TagLifecycle = (typeof TAG_LIFECYCLES)[number]

export const TAG_GROUP_LIFECYCLES = ['active', 'archived'] as const
export type TagGroupLifecycle = (typeof TAG_GROUP_LIFECYCLES)[number]

export type TagCapability =
  | 'tag.view'
  | 'tag.audit_view'
  | 'tag.create'
  | 'tag_group.create'
  | 'tag.catalog_edit'
  | 'tag.archive'
  | 'tag.merge'
  | 'tag.restore'
  | 'tag.manage_policy'

export const TAG_OPERATION_EVENT_TYPES = [
  'queued',
  'replay_succeeded',
  'attention',
  'discarded',
  'reconciled',
] as const
export type TagOperationEventType = (typeof TAG_OPERATION_EVENT_TYPES)[number]
export type TagOperationItemKind = 'tag' | 'group'

export interface TagOperationEventInput {
  id: string
  eventType: TagOperationEventType
  itemKind: TagOperationItemKind
  reasonCode: string | null
  ageMs: number
  attemptCount: number
  occurredAt: string
}

export interface TagOperationSummary {
  window: '24h' | '7d' | '30d'
  from: string
  to: string
  counts: Record<TagOperationEventType, number>
  p50ResolutionMs: number | null
  p95ResolutionMs: number | null
  topAttentionReasons: Array<{ code: string; count: number }>
  lastEventAt: string | null
}

export interface TagWorkspaceContext {
  landscapeId: string
  versionId: string
}
export interface TagActor {
  userId: string
  orgId: string
  orgRole: 'admin' | 'member'
  capability: TagCapability
}

export interface TagSettings {
  allowMemberTagCreation: boolean
  allowEditorTagGroupCreation: boolean
  version: number
  updatedAt: string | null
  updatedBy: string | null
}

export interface TagGroupInput {
  clientId?: string
  name: string
  normalizedName: string
  description: string | null
  iconKey: string | null
}

export interface TagInput {
  clientId?: string
  groupId: string
  value: string
  normalizedValue: string
  color: string
}

export interface TagGroupPatchInput {
  name?: string
  normalizedName?: string
  description?: string | null
  iconKey?: string | null
}

export interface TagPatchInput {
  groupId?: string
  value?: string
  normalizedValue?: string
  color?: string
}

export const TAG_BATCH_ACTIONS = ['recolor', 'move', 'archive', 'restore'] as const
export type TagBatchAction = (typeof TAG_BATCH_ACTIONS)[number]

export interface TagBatchItem {
  id: string
  expectedVersion: number
}

export interface TagBatchInput {
  action: TagBatchAction
  items: TagBatchItem[]
  color?: string
  groupId?: string
}

export interface TagUsageCount {
  tagId: string
  objectAssignments: number
  groupAssignments: number
  totalAssignments: number
}

export interface TagAuditEntry {
  id: string
  at: string
  actorUserId: string
  actorEmail: string | null
  impersonatorUserId: string | null
  impersonatorEmail: string | null
  action: string
  targetKind: string
  targetId: string
  detail: unknown
}

export type TagAssignmentKind = 'object' | 'group'

export interface TagAssignmentView {
  kind: TagAssignmentKind
  landscapeId: string
  landscapeName: string
  versionId: string
  versionName: string
  entityId: string
  entityName: string
  entityType: string | null
}

export interface TagMoveInput {
  beforeId: string | null
  afterId: string | null
}

export interface ResolvedTag {
  requestedId: string
  canonicalTagId: string
  redirected: boolean
  tag: TagView
}

export interface ResolveTagsResult {
  resolved: ResolvedTag[]
  unresolvedIds: string[]
}

export interface TagGroupView {
  id: string
  orgId: string
  name: string
  description: string | null
  iconKey: string | null
  lifecycleStatus: TagGroupLifecycle
  version: number
  createdAt: string
  updatedAt: string
  /** Active Tag count, populated by paged list queries without loading values. */
  tagCount?: number
}

export interface TagView {
  id: string
  orgId: string
  groupId: string
  groupName: string
  value: string
  color: string
  lifecycleStatus: TagLifecycle
  canonicalTagId: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface KeysetPage<T> {
  items: T[]
  nextCursor: string | null
}
