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

import type { FullModel } from '../../../draft/materialize.js'

/**
 * Loose entity views over the materialized FullModel (the server deliberately
 * does not import client types — same convention as readModel/types.ts).
 */

export interface TechnologyUsageView {
  id: string
  technologyId: string
  catalogRevision: number
  usedVersion?: string
  role?: string
  notes?: string
  snapshot: {
    schemaVersion: 1
    name: string
    iconLightPath?: string
    iconDarkPath?: string
    recommendedShapeTypes?: string[]
    defaultRole?: string
  }
}

export interface OwnerAssignmentView {
  id: string
  kind: 'team' | 'person'
  source: 'platform' | 'external'
  name: string
  catalogId?: string
  email?: string
  title?: string
  organization?: string
  memberCount?: number
  members?: { id: string; name: string; email?: string }[]
}

export type LinkView = string | { url: string; label?: string }

export interface TechnologyBearingView {
  technologyUsages?: Record<string, TechnologyUsageView>
  technologyUsageOrder?: string[]
}

export interface TagAssignableView {
  tagAssignments?: Record<string, { tagId: string }>
  tagOrder?: string[]
}

export interface ObjView extends TechnologyBearingView, TagAssignableView {
  id: string
  type?: string
  name?: string
  shortDescription?: string
  description?: string
  icon?: string
  domainId?: string
  parentId?: string
  scope?: string
  status?: string
  ownerAssignments?: Record<string, OwnerAssignmentView>
  ownerAssignmentOrder?: string[]
  ownerTeamIds?: string[]
  teamIds?: string[]
  position?: { x: number; y: number }
  size?: { width: number; height: number }
  properties?: Record<string, string>
  links?: LinkView[]
  [k: string]: unknown
}

export interface ConnView extends TechnologyBearingView, TagAssignableView {
  id: string
  fromId: string
  toId: string
  label?: string
  description?: string
  type?: string
  kind?: string
  status?: string
  ownerAssignments?: Record<string, OwnerAssignmentView>
  ownerAssignmentOrder?: string[]
  ownerTeamIds?: string[]
  [k: string]: unknown
}

export interface GroupView extends TechnologyBearingView, TagAssignableView {
  id: string
  name?: string
  color?: string
  icon?: string
  description?: string
  objectIds?: string[]
  domainId?: string
  autoSize?: boolean
  position?: { x: number; y: number }
  size?: { width: number; height: number }
  [k: string]: unknown
}

export interface DomainView {
  id: string
  name?: string
  description?: string
  parentId?: string
  color?: string
  [k: string]: unknown
}

export interface TagView {
  tagId: string
  value?: string
  color?: string
  groupId?: string
  groupName?: string
  catalogRevision?: number
  [k: string]: unknown
}

export interface AdrView {
  id: string
  number?: number
  title?: string
  summary?: string
  status?: string
  author?: string
  createdAt?: string
  updatedAt?: string
  content?: string
  related?: unknown[]
  history?: { status: string; date: string }[]
  [k: string]: unknown
}

export interface FlowStepView {
  id: string
  order?: number
  type?: string
  title?: string
  description?: string
  fromObjectId?: string
  toObjectId?: string
  connectionId?: string
  objectId?: string
  [k: string]: unknown
}

export interface FlowView {
  id: string
  name?: string
  diagramId?: string
  steps?: FlowStepView[]
  domainId?: string
  [k: string]: unknown
}

export interface CommentView {
  id: string
  diagramId?: string
  type?: string
  text?: string
  author?: string
  createdAt?: string
  resolved?: boolean
  pinned?: boolean
  replies?: { id: string; text: string; author: string; createdAt: string }[]
  position?: { x: number; y: number }
  [k: string]: unknown
}

export const objects = (m: FullModel) => m.objects as Record<string, ObjView>
export const connections = (m: FullModel) => m.connections as Record<string, ConnView>
export const groups = (m: FullModel) => m.groups as Record<string, GroupView>
export const domains = (m: FullModel) => m.domains as Record<string, DomainView>
export const tagsOf = (m: FullModel) => m.tagSnapshots as Record<string, TagView>
export const adrs = (m: FullModel) => m.decisionRecords as Record<string, AdrView>

export function truncate(s: string | undefined, n = 160): string | undefined {
  if (!s) return undefined
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** Snapshot names are safe for immediate/offline rendering and compact AI reads. */
export function techNames(entity: TechnologyBearingView): string[] {
  return orderedTechnologyUsages(entity).map((usage) => usage.snapshot.name)
}

export function orderedTechnologyUsages(entity: TechnologyBearingView): TechnologyUsageView[] {
  const usages = entity.technologyUsages ?? {}
  const seen = new Set<string>()
  const ids = [...(entity.technologyUsageOrder ?? []), ...Object.keys(usages)]
    .filter((id) => usages[id] && !seen.has(id) && Boolean(seen.add(id)))
  return ids.map((id) => usages[id])
}

/** Match the client migration semantics: a legacy `description` is the shape
 * summary until the separate shortDescription property is materialized. */
export function shortDescriptionOf(object: Pick<ObjView, 'shortDescription' | 'description'>): string | undefined {
  return Object.prototype.hasOwnProperty.call(object, 'shortDescription')
    ? object.shortDescription || undefined
    : object.description || undefined
}

export function detailedDescriptionOf(object: Pick<ObjView, 'shortDescription' | 'description'>): string | undefined {
  return Object.prototype.hasOwnProperty.call(object, 'shortDescription')
    ? object.description || undefined
    : undefined
}

export function nameOf(m: FullModel, id: string): string {
  const o = objects(m)[id]
  return (o?.name as string | undefined) ?? id
}
