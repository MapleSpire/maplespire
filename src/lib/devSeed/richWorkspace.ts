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

import type {
  C4Object, Connection, Group, Domain, Tag, DecisionRecord, Diagram, Comment, Flow, TechnologyUsage,
} from '../../types'
import { seededTechnologyUsages } from '../technologyUsage'

/**
 * Deterministic generator for a realistic enterprise workspace, for stress-testing
 * sharding + the server read model at scale. Pure (seeded PRNG → reproducible) so it
 * is unit-testable; a DEV bridge hook (`__seedRich`) applies the result to the store.
 *
 * All ids are prefixed `rs-` so `__clearLoad` removes them. Defaults match the
 * requested shape: 200 diagrams, 20k objects (C4 system→container→component with
 * drill-down diagrams), 30k connections incl. two hubs (10k + 5k), 5 technologies +
 * a description per object, ~10 tags/diagram, 400 ADRs linked to diagrams, 100
 * comments on a few diagrams, 2 flows/diagram.
 */

export interface RichSeedOptions {
  diagrams?: number
  objects?: number
  connections?: number
  hubDegrees?: number[]
  adrs?: number
  commentDiagrams?: number
  commentsPerDiagram?: number
  bigDiagrams?: number
  bigDiagramSize?: number
  tagPool?: number
  technologiesPerObject?: number
  tagsPerObject?: number
  flowsPerDiagram?: number
  seed?: number
}

export interface RichWorkspace {
  domains: Domain[]
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
  tags: Tag[]
  decisionRecords: DecisionRecord[]
  diagrams: Diagram[]
  comments: Comment[]
  flows: Flow[]
}

/** mulberry32 — tiny deterministic PRNG so a given seed reproduces the workspace. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TECHS = [
  'Node.js', 'Go', 'Java', 'Python', 'Rust', 'TypeScript', 'PostgreSQL', 'Redis', 'Kafka', 'RabbitMQ',
  'gRPC', 'GraphQL', 'REST', 'React', 'Vue', 'Kubernetes', 'Docker', 'Terraform', 'Elasticsearch', 'S3',
  'DynamoDB', 'Cassandra', 'Spark', 'Flink', 'Envoy', 'nginx', 'Prometheus', 'Grafana', 'Kotlin', 'C#',
]
const VERBS = ['calls', 'reads from', 'writes to', 'publishes to', 'subscribes to', 'queries', 'notifies', 'authenticates with', 'streams to', 'caches in']
const TAG_WORDS = ['payments', 'auth', 'core', 'legacy', 'pii', 'external', 'critical', 'beta', 'deprecated', 'gdpr', 'realtime', 'batch', 'public-api', 'internal', 'observability']
const STATUSES: C4Object['status'][] = ['live', 'live', 'live', 'draft', 'unstable', 'down']
const ADR_STATUS: DecisionRecord['status'][] = ['approved', 'approved', 'in-progress', 'rejected']

const pick = <T>(r: () => number, arr: readonly T[]): T => arr[Math.floor(r() * arr.length) % arr.length]

export function generateRichWorkspace(opts: RichSeedOptions = {}): RichWorkspace {
  const {
    diagrams: nDiagrams = 200,
    objects: nObjects = 20000,
    connections: nConnections = 30000,
    hubDegrees = [10000, 5000],
    adrs = 400,
    commentDiagrams = 5,
    commentsPerDiagram = 100,
    bigDiagrams = 8,
    bigDiagramSize = 100,
    tagPool = 60,
    technologiesPerObject = 5,
    tagsPerObject = 3,
    flowsPerDiagram = 2,
    seed = 1,
  } = opts
  const r = rng(seed)
  const id = (p: string, n: number) => `rs-${p}${n}`

  // ── domains + tags ──────────────────────────────────────────────────────────
  const domains: Domain[] = Array.from({ length: 8 }, (_, i) => ({
    id: id('dom', i), name: `Domain ${i}`, color: `hsl(${(i * 45) % 360} 60% 50%)`,
  }))
  const tags: Tag[] = Array.from({ length: tagPool }, (_, i) => ({
    tagId: id('tag', i), value: `${TAG_WORDS[i % TAG_WORDS.length]}-${i}`,
    color: `hsl(${(i * 37) % 360} 55% 45%)`, groupId: 'rs-taggrp-load-test',
    groupName: 'Load test', catalogRevision: 1,
  }))

  // ── objects: C4 hierarchy actors → systems → containers → components ─────────
  const objects: C4Object[] = []
  const actors: string[] = []
  const systems: string[] = []
  const containers: string[] = []
  const components: string[] = []
  const childrenOf = new Map<string, string[]>()

  const nActors = 20
  const nSystems = Math.max(1, Math.round(nObjects * 0.009))
  const nContainers = Math.max(1, Math.round(nObjects * 0.09))
  const nComponents = nObjects - nActors - nSystems - nContainers

  const techsFor = (ownerId: string): Record<string, TechnologyUsage> => {
    const names: string[] = []
    const seen = new Set<string>()
    while (names.length < technologiesPerObject) {
      const t = pick(r, TECHS)
      if (!seen.has(t)) { seen.add(t); names.push(t) }
    }
    return seededTechnologyUsages(ownerId, names)
  }
  const tagsFor = (): Pick<C4Object, 'tagAssignments' | 'tagOrder'> => {
    const tagOrder: string[] = []
    const seen = new Set<number>()
    while (tagOrder.length < tagsPerObject) {
      const ti = Math.floor(r() * tagPool)
      if (!seen.has(ti)) { seen.add(ti); tagOrder.push(tags[ti].tagId) }
    }
    return {
      tagAssignments: Object.fromEntries(tagOrder.map((tagId) => [tagId, { tagId }])),
      tagOrder,
    }
  }
  const mkObject = (oid: string, type: C4Object['type'], name: string, parentId: string | undefined, i: number): C4Object => {
    const o: C4Object = {
      id: oid, type, name,
      description: `${name} — ${pick(r, VERBS)} downstream services; owns part of ${pick(r, TAG_WORDS)} concerns.`,
      technologyUsages: techsFor(oid),
      position: { x: (i % 40) * 220, y: Math.floor(i / 40) * 140 },
      size: { width: 170, height: 100 },
      ...tagsFor(),
      domainId: domains[Math.floor(r() * domains.length)].id,
      scope: r() < 0.85 ? 'internal' : 'external',
      status: pick(r, STATUSES),
      properties: { owner: `team-${Math.floor(r() * 30)}`, tier: `${1 + Math.floor(r() * 3)}` },
    }
    if (parentId) o.parentId = parentId
    return o
  }

  let oi = 0
  for (let i = 0; i < nActors; i++) { const oid = id('act', i); actors.push(oid); objects.push(mkObject(oid, 'actor', `Actor ${i}`, undefined, oi++)) }
  for (let i = 0; i < nSystems; i++) { const oid = id('sys', i); systems.push(oid); childrenOf.set(oid, []); objects.push(mkObject(oid, 'system', `System ${i}`, undefined, oi++)) }
  for (let i = 0; i < nContainers; i++) {
    const oid = id('con', i); containers.push(oid); childrenOf.set(oid, [])
    const parent = systems[Math.floor(r() * systems.length)]
    childrenOf.get(parent)!.push(oid)
    objects.push(mkObject(oid, r() < 0.7 ? 'app' : 'store', `Container ${i}`, parent, oi++))
  }
  for (let i = 0; i < nComponents; i++) {
    const oid = id('cmp', i); components.push(oid)
    const parent = containers[Math.floor(r() * containers.length)]
    childrenOf.get(parent)!.push(oid)
    objects.push(mkObject(oid, 'component', `Component ${i}`, parent, oi++))
  }
  const byId = new Map(objects.map((o) => [o.id, o]))

  // ── connections: hubs + regular ─────────────────────────────────────────────
  const connections: Connection[] = []
  let ci = 0
  const addConn = (from: string, to: string, kind?: Connection['kind']) => {
    connections.push({ id: id('c', ci++), fromId: from, toId: to, type: 'solid', label: pick(r, VERBS), ...(kind ? { kind } : {}) })
  }
  // Hubs: high-degree components.
  const hubs = hubDegrees.map((_, h) => components[h] ?? components[0])
  hubDegrees.forEach((deg, h) => {
    const hub = hubs[h]
    for (let i = 0; i < deg && ci < nConnections; i++) addConn(hub, components[(i * 7 + h) % components.length])
  })
  // Regular connections among components (and some container→container / system→system).
  while (ci < nConnections) {
    const roll = r()
    if (roll < 0.08) addConn(pick(r, actors), pick(r, systems))
    else if (roll < 0.2) addConn(pick(r, systems), pick(r, systems))
    else if (roll < 0.4) addConn(pick(r, containers), pick(r, containers))
    else addConn(pick(r, components), pick(r, components))
  }

  // ── groups (a handful per some diagrams) ────────────────────────────────────
  const groups: Group[] = []

  // ── diagrams: context + container (drill into systems) + component (into containers) ─
  const diagrams: Diagram[] = []
  const connsAmong = (ids: Set<string>, cap: number): string[] => {
    const out: string[] = []
    for (const c of connections) { if (ids.has(c.fromId) && ids.has(c.toId)) { out.push(c.id); if (out.length >= cap) break } }
    return out
  }
  const layoutFor = (ids: string[]): Diagram['layouts'] => {
    const l: NonNullable<Diagram['layouts']> = {}
    ids.forEach((oid, i) => { l[oid] = { position: { x: (i % 12) * 220, y: Math.floor(i / 12) * 150 }, size: { width: 170, height: 100 } } })
    return l
  }
  const mkDiagram = (
    did: string, name: string, type: Diagram['type'], objectIds: string[], parentObjectId: string | undefined, di: number
  ): Diagram => {
    const oset = new Set(objectIds)
    const d: Diagram = {
      id: did, name, type, objectIds,
      connectionIds: connsAmong(oset, 200),
      groupIds: [],
      description: `${type} view: ${name}`,
      domainId: domains[di % domains.length].id,
      layouts: layoutFor(objectIds),
    }
    if (parentObjectId) d.parentObjectId = parentObjectId
    return d
  }

  let di = 0
  // 1 context diagram of (a sample of) systems + actors.
  diagrams.push(mkDiagram(id('dg', di), 'Landscape Context', 'context', [...actors, ...systems.slice(0, 60)], undefined, di)); di++
  // A few BIG diagrams (~100 objects + their connections) — flat component slices.
  for (let b = 0; b < bigDiagrams && diagrams.length < nDiagrams; b++) {
    const objs = components.slice(b * bigDiagramSize, b * bigDiagramSize + bigDiagramSize)
    diagrams.push(mkDiagram(id('dg', di), `Big component view ${b}`, 'component', objs, containers[b % containers.length], di)); di++
  }
  // Container diagrams drilling into systems (parentObjectId = system) — up to half.
  for (let s = 0; s < systems.length && diagrams.length < Math.floor(nDiagrams / 2); s++) {
    const kids = childrenOf.get(systems[s]) ?? []
    if (kids.length === 0) continue
    diagrams.push(mkDiagram(id('dg', di), `${byId.get(systems[s])!.name} — Containers`, 'container', kids.slice(0, 12 + Math.floor(r() * 10)), systems[s], di)); di++
  }
  // Component diagrams drilling into containers (parentObjectId = container) — fill.
  for (let c = 0; c < containers.length && diagrams.length < nDiagrams; c++) {
    const kids = childrenOf.get(containers[c]) ?? []
    if (kids.length === 0) continue
    diagrams.push(mkDiagram(id('dg', di), `${byId.get(containers[c])!.name} — Components`, 'component', kids.slice(0, 10 + Math.floor(r() * 8)), containers[c], di)); di++
  }
  // Pad to exactly nDiagrams if the hierarchy ran short.
  while (diagrams.length < nDiagrams) {
    const off = diagrams.length * 7
    diagrams.push(mkDiagram(id('dg', di), `Component view ${di}`, 'component', components.slice(off, off + 9), undefined, di)); di++
  }

  // ── comments: a few heavy diagrams ──────────────────────────────────────────
  const comments: Comment[] = []
  const CTYPES: Comment['type'][] = ['question', 'inaccuracy', 'idea']
  let cmi = 0
  for (let d = 0; d < Math.min(commentDiagrams, diagrams.length); d++) {
    const dg = diagrams[diagrams.length - 1 - d]
    for (let k = 0; k < commentsPerDiagram; k++) {
      comments.push({
        id: id('cm', cmi++), diagramId: dg.id, type: pick(r, CTYPES),
        text: `Comment ${k}: should we ${pick(r, VERBS)} here instead?`,
        position: { x: (k % 10) * 80, y: Math.floor(k / 10) * 60 },
        author: `user-${Math.floor(r() * 40)}`, createdAt: '2026-06-01T00:00:00.000Z',
        resolved: r() < 0.3, pinned: r() < 0.15,
        replies: r() < 0.4 ? [{ id: id('rp', cmi), text: 'Agreed.', author: `user-${Math.floor(r() * 40)}`, createdAt: '2026-06-02T00:00:00.000Z' }] : [],
      })
    }
  }

  // ── ADRs (decisionRecords) linked to diagrams ───────────────────────────────
  const decisionRecords: DecisionRecord[] = Array.from({ length: adrs }, (_, i) => {
    const related = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, k) => {
      const dg = diagrams[Math.floor(r() * diagrams.length)]
      return { id: id('adl', i * 4 + k), type: 'diagram' as const, label: dg.name, targetId: dg.id }
    })
    return {
      id: id('adr', i), number: i + 1, title: `ADR ${i + 1}: adopt ${pick(r, TECHS)} for ${pick(r, TAG_WORDS)}`,
      summary: `Decision to standardise ${pick(r, TECHS)} across ${pick(r, TAG_WORDS)} services.`,
      status: pick(r, ADR_STATUS), author: `arch-${Math.floor(r() * 12)}`,
      createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-15T00:00:00.000Z',
      content: `## Context\nWe needed to choose a technology.\n## Decision\nUse ${pick(r, TECHS)}.\n## Consequences\nBetter ${pick(r, TAG_WORDS)}.`,
      related,
    }
  })

  // ── flows: 2 per diagram ────────────────────────────────────────────────────
  const flows: Flow[] = []
  let fi = 0
  for (const dg of diagrams) {
    for (let f = 0; f < flowsPerDiagram; f++) {
      const objs = dg.objectIds.slice(0, 4)
      const steps: Flow['steps'] = [{ id: id('fs', fi * 10), order: 0, type: 'introduction', title: 'Start' }]
      for (let s = 0; s + 1 < objs.length; s++) {
        const conn = connections.find((c) => c.fromId === objs[s] && c.toId === objs[s + 1])
        steps.push(conn
          ? { id: id('fs', fi * 10 + s + 1), order: s + 1, type: 'message', title: `Step ${s + 1}`, fromObjectId: objs[s], toObjectId: objs[s + 1], connectionId: conn.id }
          : { id: id('fs', fi * 10 + s + 1), order: s + 1, type: 'process', title: `Process ${s + 1}`, objectId: objs[s] })
      }
      steps.push({ id: id('fs', fi * 10 + 9), order: steps.length, type: 'conclusion', title: 'Done' })
      flows.push({ id: id('fl', fi++), name: `${dg.name} flow ${f + 1}`, diagramId: dg.id, steps })
    }
  }

  // Keep only sanitized snapshots referenced by a stable assignment.
  const referencedTagIds = new Set(objects.flatMap((object) => Object.keys(object.tagAssignments)))
  const usedTags = tags.filter((tag) => referencedTagIds.has(tag.tagId))

  return { domains, objects, connections, groups, tags: usedTags, decisionRecords, diagrams, comments, flows }
}
