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

import type { C4Object, OwnerAssignment, OwnerPersonSnapshot } from '../types'
import type { OrgMember, OrgTeam, TeamMember } from './orgAdmin/api'
import { generateId } from './utils'

type OwnerCarrier = Pick<C4Object, 'ownerAssignments' | 'ownerAssignmentOrder' | 'ownerTeamIds'>

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

export function orderedOwnerAssignments(carrier: OwnerCarrier): OwnerAssignment[] {
  const assignments = carrier.ownerAssignments ?? {}
  const orderedIds = unique([
    ...(carrier.ownerAssignmentOrder ?? []),
    ...Object.keys(assignments),
  ])
  const result = orderedIds.flatMap((id) => assignments[id] ? [assignments[id]] : [])
  const representedTeamIds = new Set(
    result.filter((assignment) => assignment.kind === 'team').map((assignment) => assignment.catalogId ?? assignment.id),
  )
  for (const teamId of unique(carrier.ownerTeamIds ?? [])) {
    if (representedTeamIds.has(teamId)) continue
    result.push({
      id: teamId,
      kind: 'team',
      source: 'platform',
      catalogId: teamId,
      name: teamId,
    })
  }
  return result
}

export function assignOwner(
  carrier: OwnerCarrier,
  assignment: OwnerAssignment,
): Pick<C4Object, 'ownerAssignments' | 'ownerAssignmentOrder' | 'ownerTeamIds'> {
  const assignments = { ...(carrier.ownerAssignments ?? {}), [assignment.id]: assignment }
  const order = unique([...(carrier.ownerAssignmentOrder ?? []), assignment.id])
  const teamId = assignment.kind === 'team' ? assignment.catalogId ?? assignment.id : null
  return {
    ownerAssignments: assignments,
    ownerAssignmentOrder: order,
    ownerTeamIds: unique([...(carrier.ownerTeamIds ?? []), ...(teamId ? [teamId] : [])]),
  }
}

export function removeOwner(
  carrier: OwnerCarrier,
  assignmentId: string,
): Pick<C4Object, 'ownerAssignments' | 'ownerAssignmentOrder' | 'ownerTeamIds'> {
  const assignments = { ...(carrier.ownerAssignments ?? {}) }
  const removed = assignments[assignmentId]
  delete assignments[assignmentId]
  const removedTeamId = removed?.kind === 'team' ? removed.catalogId ?? removed.id : assignmentId
  return {
    ownerAssignments: assignments,
    ownerAssignmentOrder: (carrier.ownerAssignmentOrder ?? []).filter((id) => id !== assignmentId),
    ownerTeamIds: (carrier.ownerTeamIds ?? []).filter((id) => id !== removedTeamId),
  }
}

function memberSnapshot(member: TeamMember | OrgMember): OwnerPersonSnapshot {
  return {
    id: member.userId,
    name: member.name?.trim() || member.email,
    email: member.email,
  }
}

export function teamOwnerAssignment(team: OrgTeam, members: readonly TeamMember[] = []): OwnerAssignment {
  return {
    id: team.id,
    kind: 'team',
    source: 'platform',
    catalogId: team.id,
    name: team.name,
    memberCount: team.memberCount,
    members: members.map(memberSnapshot),
  }
}

export function platformPersonOwnerAssignment(member: OrgMember): OwnerAssignment {
  return {
    id: `user:${member.userId}`,
    kind: 'person',
    source: 'platform',
    catalogId: member.userId,
    name: member.name?.trim() || member.email,
    email: member.email,
  }
}

export function externalContactOwnerAssignment(input: {
  name: string
  email?: string
  title?: string
  organization?: string
}): OwnerAssignment {
  return {
    id: `contact:${generateId()}`,
    kind: 'person',
    source: 'external',
    name: input.name.trim(),
    ...(input.email?.trim() ? { email: input.email.trim() } : {}),
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    ...(input.organization?.trim() ? { organization: input.organization.trim() } : {}),
  }
}
