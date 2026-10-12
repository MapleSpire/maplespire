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
  C4Object, Connection, Group, Domain, Tag, Diagram, Comment, Flow,
} from '../../types'
import { generateRichWorkspace, type RichWorkspace } from './richWorkspace'
import { seededTechnologyUsages } from '../technologyUsage'

/**
 * Realistic, recognizable enterprise workspace for the dev/test seed.
 *
 * Hand-authored, recognizable C4 architectures (Netflix, Meta, Microsoft Dynamics
 * Field Service, Uber, Spotify, Stripe) — each a System Context diagram + a Container
 * diagram with a real service breakdown, tech stack, groups and flows — PREPENDED to
 * the deterministic heavy workspace (`generateRichWorkspace`) which supplies bulk
 * objects, hub fan-outs and big component diagrams for performance testing.
 *
 * The FIRST diagram is deliberately small + clean (Netflix — System Context, ~6
 * shapes) so it's what the boot client opens by default: reliable canvas interaction.
 * All hand-authored ids are prefixed `re-`; bulk ids stay `rs-` (so `__clearLoad`
 * removes both). Deterministic (no RNG) → reproducible.
 */

interface ContainerDef {
  name: string
  type: 'app' | 'store'
  tech: string
  /** Optional group bucket on the container diagram (e.g. 'Data'). */
  group?: string
}
interface ArchDef {
  key: string
  system: string
  /** Short blurb for the system object description. */
  blurb: string
  actors: string[]
  /** Neighbouring external systems shown on the context diagram. */
  externals: string[]
  containers: ContainerDef[]
}

const ARCHS: ArchDef[] = [
  {
    key: 'netflix',
    system: 'Netflix',
    blurb: 'Global subscription streaming platform.',
    actors: ['Member', 'Partner Device'],
    externals: ['Open Connect CDN', 'AWS', 'Payment Provider'],
    containers: [
      { name: 'Zuul API Gateway', type: 'app', tech: 'Java' },
      { name: 'Playback Service', type: 'app', tech: 'Java' },
      { name: 'Recommendations', type: 'app', tech: 'Python, Spark' },
      { name: 'Billing Service', type: 'app', tech: 'Java' },
      { name: 'Membership Service', type: 'app', tech: 'Java' },
      { name: 'Cassandra', type: 'store', tech: 'Cassandra', group: 'Data' },
      { name: 'EVCache', type: 'store', tech: 'Memcached', group: 'Data' },
      { name: 'Kafka Pipeline', type: 'store', tech: 'Kafka', group: 'Data' },
    ],
  },
  {
    key: 'meta',
    system: 'Facebook',
    blurb: 'Social network connecting billions of people.',
    actors: ['User', 'Advertiser'],
    externals: ['Mobile App', 'Ad Exchange', 'CDN'],
    containers: [
      { name: 'Web Frontend', type: 'app', tech: 'Hack, React' },
      { name: 'News Feed', type: 'app', tech: 'C++' },
      { name: 'Graph API', type: 'app', tech: 'Hack' },
      { name: 'Ads Engine', type: 'app', tech: 'C++' },
      { name: 'Messenger', type: 'app', tech: 'Erlang' },
      { name: 'TAO Cache', type: 'store', tech: 'Memcached', group: 'Data' },
      { name: 'MySQL Fleet', type: 'store', tech: 'MySQL', group: 'Data' },
      { name: 'Haystack', type: 'store', tech: 'Blob Store', group: 'Data' },
    ],
  },
  {
    key: 'msfs',
    system: 'Dynamics 365 Field Service',
    blurb: 'Microsoft field service management for on-site work.',
    actors: ['Dispatcher', 'Field Technician', 'Customer'],
    externals: ['Azure IoT', 'Outlook', 'Power BI'],
    containers: [
      { name: 'Scheduling Engine', type: 'app', tech: 'C#, .NET' },
      { name: 'Work Order Service', type: 'app', tech: 'C#, .NET' },
      { name: 'Mobile App', type: 'app', tech: 'Xamarin' },
      { name: 'IoT Connector', type: 'app', tech: 'Azure Functions' },
      { name: 'Power Automate Flows', type: 'app', tech: 'Power Platform' },
      { name: 'Dataverse', type: 'store', tech: 'Azure SQL', group: 'Data' },
      { name: 'Blob Storage', type: 'store', tech: 'Azure Blob', group: 'Data' },
    ],
  },
  {
    key: 'uber',
    system: 'Uber',
    blurb: 'On-demand ride-hailing and delivery marketplace.',
    actors: ['Rider', 'Driver'],
    externals: ['Maps Provider', 'Payment Gateway', 'SMS Provider'],
    containers: [
      { name: 'Rider App', type: 'app', tech: 'Swift, Kotlin' },
      { name: 'Driver App', type: 'app', tech: 'Swift, Kotlin' },
      { name: 'Dispatch Service', type: 'app', tech: 'Go' },
      { name: 'Pricing Service', type: 'app', tech: 'Go' },
      { name: 'Trip Service', type: 'app', tech: 'Java' },
      { name: 'Payments Service', type: 'app', tech: 'Java' },
      { name: 'Schemaless', type: 'store', tech: 'MySQL', group: 'Data' },
      { name: 'Geospatial Index', type: 'store', tech: 'Redis', group: 'Data' },
    ],
  },
  {
    key: 'spotify',
    system: 'Spotify',
    blurb: 'Audio streaming and media services.',
    actors: ['Listener', 'Artist'],
    externals: ['Mobile App', 'Smart Speaker', 'Ad Network'],
    containers: [
      { name: 'Streaming Gateway', type: 'app', tech: 'Java' },
      { name: 'Search Service', type: 'app', tech: 'Java, Elasticsearch' },
      { name: 'Playlist Service', type: 'app', tech: 'Scala' },
      { name: 'Recommendations', type: 'app', tech: 'Python, Spark' },
      { name: 'Ad Engine', type: 'app', tech: 'Java' },
      { name: 'Cassandra', type: 'store', tech: 'Cassandra', group: 'Data' },
      { name: 'Event Delivery', type: 'store', tech: 'Kafka', group: 'Data' },
    ],
  },
  {
    key: 'stripe',
    system: 'Stripe',
    blurb: 'Payments infrastructure for the internet.',
    actors: ['Merchant', 'Cardholder'],
    externals: ['Card Networks', 'Bank', 'Webhook Consumer'],
    containers: [
      { name: 'API Gateway', type: 'app', tech: 'Ruby' },
      { name: 'Payments Processing', type: 'app', tech: 'Ruby, Go' },
      { name: 'Radar Fraud', type: 'app', tech: 'Python' },
      { name: 'Billing Service', type: 'app', tech: 'Ruby' },
      { name: 'Connect Platform', type: 'app', tech: 'Ruby' },
      { name: 'Ledger', type: 'store', tech: 'PostgreSQL', group: 'Data' },
      { name: 'Event Bus', type: 'store', tech: 'Kafka', group: 'Data' },
    ],
  },
]

const techs = (ownerId: string, csv: string) => seededTechnologyUsages(ownerId, csv.split(',').map((t) => t.trim()))
const SIZE = { width: 180, height: 110 }
/** Spread N shapes on a roomy grid so zoom-to-fit keeps them large + clickable. */
const gridPos = (i: number, perRow = 4, dx = 260, dy = 180) => ({
  position: { x: (i % perRow) * dx, y: Math.floor(i / perRow) * dy },
  size: SIZE,
})
const layoutOf = (ids: string[], perRow = 4): NonNullable<Diagram['layouts']> => {
  const l: NonNullable<Diagram['layouts']> = {}
  ids.forEach((id, i) => (l[id] = gridPos(i, perRow)))
  return l
}

interface Built {
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
  diagrams: Diagram[]
  comments: Comment[]
  flows: Flow[]
}

function buildArch(a: ArchDef, di: number, domainId: string): Built {
  const objects: C4Object[] = []
  const connections: Connection[] = []
  const groups: Group[] = []
  const diagrams: Diagram[] = []
  const comments: Comment[] = []
  const flows: Flow[] = []
  let cn = 0
  const conn = (from: string, to: string, label: string) =>
    connections.push({ id: `re-${a.key}-c${cn++}`, fromId: from, toId: to, type: 'solid', label })

  // System
  const sysId = `re-${a.key}-sys`
  objects.push({
    id: sysId, type: 'system', name: a.system, description: a.blurb,
    ...gridPos(0), tagAssignments: {}, tagOrder: [], domainId, scope: 'internal', status: 'live', properties: {},
  })

  // Actors + external systems (context neighbours)
  const actorIds = a.actors.map((name, i) => {
    const id = `re-${a.key}-act${i}`
    objects.push({ id, type: 'actor', name, description: `${name} of ${a.system}.`, ...gridPos(i), tagAssignments: {}, tagOrder: [], scope: 'external', status: 'live', properties: {} })
    return id
  })
  const extIds = a.externals.map((name, i) => {
    const id = `re-${a.key}-ext${i}`
    objects.push({ id, type: 'system', name, description: `${name} (external).`, ...gridPos(i), tagAssignments: {}, tagOrder: [], scope: 'external', status: 'live', properties: {} })
    return id
  })

  // Containers (children of the system) + components for the first two containers
  const contIds: string[] = []
  a.containers.forEach((c, i) => {
    const id = `re-${a.key}-cnt${i}`
    contIds.push(id)
    objects.push({
      id, type: c.type, name: c.name, description: `${c.name} — part of ${a.system}.`,
      technologyUsages: techs(id, c.tech), ...gridPos(i), tagAssignments: {}, tagOrder: [], parentId: sysId,
      domainId, scope: 'internal', status: 'live', properties: { owner: `team-${a.key}` },
    })
  })

  // ── Context connections (actors → system, system → externals) ──
  for (const aid of actorIds) conn(aid, sysId, 'uses')
  for (const eid of extIds) conn(sysId, eid, 'integrates with')

  // ── Container connections (gateway → services → stores) ──
  const apps = contIds.filter((_, i) => a.containers[i].type === 'app')
  const stores = contIds.filter((_, i) => a.containers[i].type === 'store')
  const gateway = apps[0]
  for (let i = 1; i < apps.length; i++) conn(gateway, apps[i], 'routes to')
  apps.slice(1).forEach((app, i) => conn(app, stores[i % stores.length], 'reads/writes'))

  // ── Groups: bucket the stores into a "Data" group on the container diagram ──
  const dataStores = contIds.filter((_, i) => a.containers[i].group === 'Data')
  const groupId = `re-${a.key}-grp-data`
  if (dataStores.length) {
    groups.push({ id: groupId, name: `${a.system} — Data`, objectIds: dataStores, color: '#5b8def', tagAssignments: {}, tagOrder: [] })
  }

  // ── Context diagram (small + clean: system + actors + externals) ──
  const ctxObjects = [sysId, ...actorIds, ...extIds]
  const ctxId = `re-${a.key}-dg-ctx`
  const ctxConnIds = connections.filter((c) => ctxObjects.includes(c.fromId) && ctxObjects.includes(c.toId)).map((c) => c.id)
  diagrams.push({
    id: ctxId, name: `${a.system} — System Context`, type: 'context',
    objectIds: ctxObjects, connectionIds: ctxConnIds, groupIds: [],
    description: `${a.system} and the actors + systems it interacts with.`,
    domainId, layouts: layoutOf(ctxObjects, 3),
  })

  // ── Container diagram (the system's containers + the Data group) ──
  const contId = `re-${a.key}-dg-cnt`
  const contConnIds = connections.filter((c) => contIds.includes(c.fromId) && contIds.includes(c.toId)).map((c) => c.id)
  diagrams.push({
    id: contId, name: `${a.system} — Containers`, type: 'container', parentObjectId: sysId,
    objectIds: contIds, connectionIds: contConnIds, groupIds: dataStores.length ? [groupId] : [],
    description: `Internal containers of ${a.system}.`,
    domainId, layouts: layoutOf(contIds, 4),
  })

  // ── A flow on the container diagram (gateway → first two services) ──
  const flowObjs = [gateway, ...apps.slice(1, 3)]
  flows.push({
    id: `re-${a.key}-fl0`, name: `${a.system} request flow`, diagramId: contId,
    steps: [
      { id: `re-${a.key}-fs0`, order: 0, type: 'introduction', title: 'Request arrives' },
      ...flowObjs.slice(0, -1).map((o, i) => {
        const target = flowObjs[i + 1]
        const c = connections.find((cc) => cc.fromId === o && cc.toId === target)
        return c
          ? { id: `re-${a.key}-fs${i + 1}`, order: i + 1, type: 'message' as const, title: `Step ${i + 1}`, fromObjectId: o, toObjectId: target, connectionId: c.id }
          : { id: `re-${a.key}-fs${i + 1}`, order: i + 1, type: 'process' as const, title: `Process ${i + 1}`, objectId: o }
      }),
      { id: `re-${a.key}-fsN`, order: flowObjs.length, type: 'conclusion', title: 'Response returned' },
    ],
  })

  // ── A couple of comments on the context diagram ──
  comments.push({
    id: `re-${a.key}-cm0`, diagramId: ctxId, type: 'idea',
    text: `Should ${a.system} expose a public API tier here?`,
    position: { x: 40, y: 40 }, author: 'architect', createdAt: '2026-06-01T00:00:00.000Z',
    resolved: false, pinned: false, replies: [],
  })

  void di
  return { objects, connections, groups, diagrams, comments, flows }
}

export interface RealWorkspaceOptions {
  /** Add a large bulk (thousands of objects, hubs, big diagrams) for PERFORMANCE testing.
   * Default (false) keeps the workspace SMALL so the boot E2E suite is fast + reliable — each
   * boot's background read-model index build stays cheap, so 30+ serial tests don't degrade the
   * stack into cascading interaction flakes. Heavy perf data is opt-in (`seed-workspace.ts heavy`). */
  heavy?: boolean
}

export function generateRealWorkspace(opts: RealWorkspaceOptions = {}): RichWorkspace {
  const domains: Domain[] = ARCHS.map((a, i) => ({ id: `re-dom-${a.key}`, name: a.system, color: `hsl(${(i * 57) % 360} 60% 50%)` }))

  const built: Built[] = ARCHS.map((a, i) => buildArch(a, i, `re-dom-${a.key}`))
  const realObjects = built.flatMap((b) => b.objects)
  const realConnections = built.flatMap((b) => b.connections)
  const realGroups = built.flatMap((b) => b.groups)
  const realDiagrams = built.flatMap((b) => b.diagrams)
  const realComments = built.flatMap((b) => b.comments)
  const realFlows = built.flatMap((b) => b.flows)

  // ── Enterprise Landscape — a CLEAN top-level context (all six systems + two actors +
  // cross-system relationships, NO groups, NO container internals). Its id sorts FIRST
  // ('0-' precedes every other id incl. random test ids), so the boot opens it: a simple,
  // reliably-interactive diagram for the canvas/connection/group E2E coverage.
  const landActors: C4Object[] = [
    { id: 're-land-act0', type: 'actor', name: 'End User', description: 'A person using the products.', ...gridPos(0), tagAssignments: {}, tagOrder: [], scope: 'external', status: 'live', properties: {} },
    { id: 're-land-act1', type: 'actor', name: 'Platform Operator', description: 'Runs and observes the platforms.', ...gridPos(1), tagAssignments: {}, tagOrder: [], scope: 'external', status: 'live', properties: {} },
  ] as C4Object[]
  const sysIds = ARCHS.map((a) => `re-${a.key}-sys`)
  const landConns: Connection[] = [
    { id: 're-land-c0', fromId: 're-land-act0', toId: 're-netflix-sys', type: 'solid', label: 'streams from' },
    { id: 're-land-c1', fromId: 're-land-act0', toId: 're-meta-sys', type: 'solid', label: 'posts to' },
    { id: 're-land-c2', fromId: 're-land-act0', toId: 're-uber-sys', type: 'solid', label: 'books with' },
    { id: 're-land-c3', fromId: 're-netflix-sys', toId: 're-stripe-sys', type: 'solid', label: 'charges via' },
    { id: 're-land-c4', fromId: 're-uber-sys', toId: 're-stripe-sys', type: 'solid', label: 'charges via' },
    { id: 're-land-c5', fromId: 're-spotify-sys', toId: 're-stripe-sys', type: 'solid', label: 'charges via' },
    { id: 're-land-c6', fromId: 're-land-act1', toId: 're-msfs-sys', type: 'solid', label: 'operates' },
  ] as Connection[]
  const landObjectIds = [...sysIds, 're-land-act0', 're-land-act1']
  const landscape: Diagram = {
    id: '0-landscape', name: 'Enterprise Landscape', type: 'context',
    objectIds: landObjectIds, connectionIds: landConns.map((c) => c.id), groupIds: [],
    description: 'All systems and the key relationships between them.',
    layouts: layoutOf(landObjectIds, 4),
  }

  // Bulk: provides off-window objects (for the off-window / read-model E2E) + perf artifacts.
  // DEFAULT is SMALL so each boot is fast and the serial suite doesn't degrade into flakes
  // (the index build trigram-indexes every object + connection, so connection count dominates
  // boot cost). `heavy` opts into a large dataset (thousands of objects, two high-degree hubs,
  // 200-object "Big component view" diagrams) for performance testing — NOT the E2E default.
  const bulk = opts.heavy
    ? generateRichWorkspace({
        objects: 5000,
        connections: 30000,
        diagrams: 120,
        bigDiagrams: 8,
        bigDiagramSize: 200,
        hubDegrees: [800, 400],
        commentDiagrams: 4,
        flowsPerDiagram: 1,
      })
    : generateRichWorkspace({
        objects: 400,
        connections: 700,
        diagrams: 14,
        bigDiagrams: 1,
        bigDiagramSize: 60,
        hubDegrees: [40, 20],
        commentDiagrams: 2,
        flowsPerDiagram: 1,
      })

  // Tags from the bulk (real objects reuse simple literal tags that don't need a registry
  // entry; the bulk already builds a used-tag set). Add the real groups' bucket tags too.
  const tags: Tag[] = bulk.tags

  // The Landscape diagram sorts first by id ('0-landscape'), so the boot opens that clean
  // top-level context; its objects/connections are prepended too.
  return {
    domains: [...domains, ...bulk.domains],
    objects: [...landActors, ...realObjects, ...bulk.objects],
    connections: [...landConns, ...realConnections, ...bulk.connections],
    groups: [...realGroups, ...bulk.groups],
    tags,
    decisionRecords: bulk.decisionRecords,
    diagrams: [landscape, ...realDiagrams, ...bulk.diagrams],
    comments: [...realComments, ...bulk.comments],
    flows: [...realFlows, ...bulk.flows],
  }
}
