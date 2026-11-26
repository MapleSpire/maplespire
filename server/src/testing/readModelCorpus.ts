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

import type { ConnectionInput, DiagramInput, FlowInput, GroupInput, ObjectInput } from '../readModel/types.js'

/**
 * TESTS AND BENCHES ONLY: a seeded, randomized read-model corpus — the
 * cold build's input — with every shape the projector derives something
 * from: parent chains (dangling parents, self-parents, cycles), group
 * memberships (an object in several groups, members that are not objects,
 * repeated ids), diagrams (object/group/connection ids, repeats, unknown
 * ids, a `parentObjectId`), connections between objects, groups and
 * nothing, governed tags (ordered, unordered, an assignment whose key does
 * not match), technology usages (valid and each invalid kind the posting
 * filter drops), teams (owner + member, repeated, empty), ids that sort
 * differently under byte order and a linguistic collation.
 */

export interface ReadModelCorpus {
  objects: ObjectInput[]
  connections: ConnectionInput[]
  groups: GroupInput[]
  diagrams: DiagramInput[]
  /** Each diagram's flows, as its DiagramDoc carries them. The cold build
   * writes none (it only deletes the flow tables); the flow projection
   * (`syncConnectionFlows`) writes them after it, as in production. */
  flows?: Array<{ diagramId: string; flows: FlowInput[] }>
  /** Decision records (their own projection: `upsertDecisionRecords`), which
   * the cold build keeps and `ro_workspace_stats` counts. */
  decisionRecords?: Array<Record<string, unknown>>
}

export interface ReadModelCorpusOptions {
  objects: number
  connections: number
  groups: number
  diagrams: number
  /** Share of objects carrying tags / technology usages / teams (0..1). */
  postingShare?: number
  /** Flows per diagram, 0..max (default 3) and decision records (default
   * 0..4). Drawn from a SECOND seeded stream, so adding them left every
   * other field of an existing seed's corpus unchanged. */
  maxFlowsPerDiagram?: number
  maxDecisionRecords?: number
  /** Append objects whose id is falsy ('' and the number 0), children of
   * them, and a group holding one — the ids `refreshEffectiveParents`'
   * `filter(Boolean)` drops on the by-deltas path. */
  falsyIds?: boolean
}

/** mulberry32 — small, seeded, good enough for test data. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Ids whose order differs between byte order (C) and a linguistic collation
// (en_US: case-folded first, punctuation ignored) — `min(group_id)` and every
// `ORDER BY` in the projector must come out of the DATABASE, not of JS.
const ID_PREFIXES = ['a', 'B', 'b', 'Z', '_x', '-y', 'é', 'E', '0', 'a-b', 'aB']

export function randomReadModelCorpus(seed: number, options: ReadModelCorpusOptions): ReadModelCorpus {
  const random = seededRandom(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
  const chance = (p: number) => random() < p
  const share = options.postingShare ?? 0.3
  const idOf = (kind: string, index: number) => `${pick(ID_PREFIXES)}${kind}${index.toString(36)}`

  const objectIds = Array.from({ length: options.objects }, (_, i) => idOf('o', i))
  const groupIds = Array.from({ length: options.groups }, (_, i) => idOf('g', i))
  const connectionIds = Array.from({ length: options.connections }, (_, i) => idOf('c', i))
  const tagIds = Array.from({ length: 12 }, (_, i) => idOf('t', i))
  const teamIds = Array.from({ length: 8 }, (_, i) => idOf('team', i))
  const types = ['system', 'container', 'component', 'person', 'external', '']

  const objects: ObjectInput[] = objectIds.map((id, index) => {
    const object: ObjectInput = { id, type: pick(types), name: `Object ${index}` }
    if (chance(0.7)) object.description = `Description of ${id} `.repeat(1 + Math.floor(random() * 4))
    // Parent chains: mostly an EARLIER object (a forest), sometimes a later
    // one, a dangling id, itself, a group id, or none.
    const roll = random()
    if (index > 0 && roll < 0.55) object.parentId = objectIds[Math.floor(random() * index)]
    else if (roll < 0.62 && objectIds.length > 1) object.parentId = pick(objectIds)
    else if (roll < 0.67) object.parentId = `dangling-${index}`
    else if (roll < 0.69) object.parentId = id
    else if (roll < 0.72 && groupIds.length) object.parentId = pick(groupIds)
    if (chance(0.3)) object.domainId = `domain-${Math.floor(random() * 5)}`
    if (chance(0.2)) object.scope = pick(['internal', 'external'])
    if (chance(0.2)) object.status = pick(['active', 'deprecated'])
    if (chance(0.15)) object.technology = pick(['Go', 'Rust', 'TypeScript'])
    if (chance(0.15)) object.technologies = [{ name: pick(['Postgres', 'Redis']) }, {}, { name: 'Kafka' }]
    if (chance(share)) {
      const assignments: Record<string, { tagId: string }> = {}
      for (let t = 0; t < 1 + Math.floor(random() * 4); t++) {
        const tagId = pick(tagIds)
        // An assignment whose key does not match its tagId is dropped.
        assignments[tagId] = { tagId: chance(0.1) ? `${tagId}-other` : tagId }
      }
      object.tagAssignments = assignments
      if (chance(0.6)) object.tagOrder = [...Object.keys(assignments)].reverse().concat(chance(0.3) ? [pick(tagIds)] : [])
    }
    if (chance(share)) {
      const usages: ObjectInput['technologyUsages'] = {}
      for (let u = 0; u < 1 + Math.floor(random() * 3); u++) {
        const usageKey = `u${u}-${index}`
        const invalid = random()
        usages[usageKey] = {
          id: invalid < 0.1 ? '' : usageKey,
          technologyId: invalid > 0.9 ? '' : `tech-${Math.floor(random() * 6)}`,
          catalogRevision: invalid > 0.85 && invalid <= 0.9 ? 0 : 1 + Math.floor(random() * 3),
          ...(chance(0.5) ? { usedVersion: `v${Math.floor(random() * 9)}` } : {}),
          ...(chance(0.3) ? { role: pick(['runtime', 'build']) } : {}),
          snapshot: { name: `Tech ${u}`, ...(chance(0.3) ? { iconLightPath: '/i.svg' } : {}) },
        }
      }
      object.technologyUsages = usages
    }
    if (chance(share)) {
      object.ownerTeamIds = [pick(teamIds), pick(teamIds)]
      if (chance(0.5)) object.teamIds = [pick(teamIds), '', pick(teamIds)]
    }
    return object
  })

  const endpoints = [...objectIds, ...groupIds, 'nowhere']
  const connections: ConnectionInput[] = connectionIds.map((id) => ({
    id,
    fromId: pick(endpoints),
    toId: chance(0.05) ? 'self' : pick(endpoints),
    ...(chance(0.6) ? { label: `uses ${id}` } : {}),
    ...(chance(0.3) ? { kind: pick(['sync', 'async']) } : {}),
  }))

  const groups: GroupInput[] = groupIds.map((id, index) => {
    const members = objectIds.length
      ? Array.from({ length: Math.floor(random() * 6) }, () => (chance(0.05) ? `ghost-${index}` : pick(objectIds)))
      : []
    const group: GroupInput = { id, name: `Group ${index}`, objectIds: members }
    if (chance(0.3)) group.icon = 'box'
    if (chance(0.3)) group.domainId = `domain-${Math.floor(random() * 5)}`
    if (chance(share)) group.tagAssignments = { [pick(tagIds)]: { tagId: pick(tagIds) } }
    if (chance(share)) {
      group.technologyUsages = {
        gu: { id: 'gu', technologyId: `tech-${Math.floor(random() * 6)}`, catalogRevision: 1, snapshot: { name: 'G' } },
      }
    }
    return group
  })

  const diagrams: DiagramInput[] = Array.from({ length: options.diagrams }, (_, index) => {
    const some = (ids: readonly string[], extra: string) => ids.length
      ? Array.from({ length: Math.floor(random() * 15) }, () => (chance(0.05) ? extra : pick(ids)))
      : []
    const diagram: DiagramInput = {
      id: idOf('d', index),
      name: `Diagram ${index}`,
      type: pick(['context', 'container', 'component']),
      objectIds: some(objectIds, `missing-object-${index}`),
      connectionIds: some(connectionIds, `missing-connection-${index}`),
      groupIds: some(groupIds, `missing-group-${index}`),
      layouts: { default: { x: 1 } },
    }
    if (chance(0.5) && objectIds.length) diagram.parentObjectId = pick(objectIds)
    if (chance(0.3)) diagram.domainId = `domain-${Math.floor(random() * 5)}`
    return diagram
  })

  // The second stream: flows and decision records.
  const extra = seededRandom(seed ^ 0x5eed5eed)
  const extraPick = <T>(items: readonly T[]): T => items[Math.floor(extra() * items.length)]
  const maxFlows = options.maxFlowsPerDiagram ?? 3
  const flows = diagrams.map((diagram, index) => ({
    diagramId: diagram.id,
    flows: Array.from({ length: Math.floor(extra() * (maxFlows + 1)) }, (_, f): FlowInput => ({
      id: `flow-${index}-${f}`,
      name: `Flow ${f}`,
      steps: Array.from({ length: Math.floor(extra() * 5) }, () => {
        const roll = extra()
        // A step on a real connection (repeated within a flow sometimes), on
        // a missing one, a step with none, and a process step on an object.
        if (roll < 0.6 && connectionIds.length) return { connectionId: extraPick(connectionIds) }
        if (roll < 0.7) return { connectionId: `missing-connection-flow-${index}` }
        if (roll < 0.8) return { connectionId: '' }
        return objectIds.length ? { type: 'process', objectId: extraPick(objectIds) } : {}
      }),
    })),
  })).filter((entry) => entry.flows.length > 0)
  const decisionRecords = Array.from({ length: Math.floor(extra() * ((options.maxDecisionRecords ?? 4) + 1)) }, (_, r) => ({
    id: `adr-${seed}-${r}`, title: `Decision ${r}`, status: extraPick(['proposed', 'accepted']),
    createdAt: '2026-01-01', updatedAt: '2026-01-02', number: r + 1,
  }))

  if (options.falsyIds) {
    // '' and 0 as ids, each with a parent that does not exist (so its levels
    // must be NULL) and a child (whose levels must name it); '' in a group.
    objects.push(
      { id: '', name: 'empty id', parentId: 'nowhere-empty' },
      { id: 0 as unknown as string, name: 'zero id', parentId: 'nowhere-zero' },
      { id: 'child-of-empty', name: 'child of empty', parentId: '' },
      { id: 'child-of-zero', name: 'child of zero', parentId: 0 as unknown as string },
    )
    groups.push({ id: 'g-holds-empty', name: 'holds empty', objectIds: [''] })
  }

  return { objects, connections, groups, diagrams, flows, decisionRecords }
}
