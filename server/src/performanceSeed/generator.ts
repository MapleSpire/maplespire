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

import {
  SEEDED_TECHNOLOGY_CATALOG_REVISION,
  SEEDED_TECHNOLOGY_IDS,
  seededTechnologyMetadata,
} from '../technologies/seed.js'
import { REFERENCE_ARCHITECTURES } from './referenceArchitectures.js'
import type {
  PerformanceConnection,
  PerformanceDecisionRecord,
  PerformanceDiagram,
  PerformanceDiagramIdentity,
  PerformanceDomain,
  PerformanceObject,
  PerformanceSeedScale,
  PerformanceSeedSummary,
  PerformanceTagSnapshot,
  PerformanceTechnologyUsage,
} from './types.js'

const REGIONS = ['ca-central-1', 'us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1'] as const
const STATUSES: PerformanceObject['status'][] = ['live', 'live', 'live', 'live', 'draft', 'unstable', 'down']
const ADR_STATUSES: PerformanceDecisionRecord['status'][] = ['approved', 'approved', 'approved', 'in-progress', 'rejected']
const SHAPE_SIZE = { width: 180, height: 110 }
const PAD = 6
const GOVERNANCE_COVERAGE = 0.8
const GOVERNANCE_TECHNOLOGY = 'Prometheus'
const DENSE_CONNECTION_LABELS = [
  'publishes domain event',
  'queries governed state',
  'validates transaction policy',
  'replicates operational signal',
  'coordinates idempotent workflow',
] as const

const TECHNOLOGY_DOCUMENTATION: Readonly<Record<string, string>> = {
  '.NET': 'https://learn.microsoft.com/dotnet/',
  'C#': 'https://learn.microsoft.com/dotnet/csharp/',
  Docker: 'https://docs.docker.com/',
  Flink: 'https://nightlies.apache.org/flink/flink-docs-stable/',
  Go: 'https://go.dev/doc/',
  GraphQL: 'https://graphql.org/learn/',
  gRPC: 'https://grpc.io/docs/',
  Java: 'https://docs.oracle.com/en/java/',
  Kafka: 'https://kafka.apache.org/documentation/',
  Kotlin: 'https://kotlinlang.org/docs/home.html',
  NestJS: 'https://docs.nestjs.com/',
  'Node.js': 'https://nodejs.org/docs/latest/api/',
  PostgreSQL: 'https://www.postgresql.org/docs/current/',
  Prometheus: 'https://prometheus.io/docs/introduction/overview/',
  Python: 'https://docs.python.org/3/',
  Redis: 'https://redis.io/docs/latest/',
  REST: 'https://www.rfc-editor.org/rfc/rfc9110',
  Rust: 'https://doc.rust-lang.org/book/',
  S3: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html',
  Scala: 'https://docs.scala-lang.org/',
  Spark: 'https://spark.apache.org/docs/latest/',
  Terraform: 'https://developer.hashicorp.com/terraform/docs',
  TypeScript: 'https://www.typescriptlang.org/docs/',
}

export interface PerformanceSeedPlanOptions {
  scale: PerformanceSeedScale
  tags: readonly PerformanceTagSnapshot[]
  teamIds: readonly string[]
  seed?: number
}

interface TierCounts {
  actors: number
  systems: number
  containers: number
  components: number
}

interface ConnectionPhases {
  actorStart: number
  actorCount: number
  systemStart: number
  systemCount: number
  containerStart: number
  containerCount: number
  componentStart: number
  componentCount: number
}

function assertInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}; got ${value}`)
  }
}

function stableNumber(value: number): number {
  let x = value | 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return x >>> 0
}

function recordById<T extends { id: string }>(values: readonly T[]): Record<string, T> {
  return Object.fromEntries(values.map((value) => [value.id, value]))
}

function colorFor(index: number): string {
  const hue = (index * 47) % 360
  return `hsl(${hue} 58% 48%)`
}

export class PerformanceSeedPlan {
  readonly scale: PerformanceSeedScale
  readonly seed: number
  readonly tierCounts: TierCounts
  readonly connectionPhases: ConnectionPhases
  readonly diagramCount: number
  readonly tags: readonly PerformanceTagSnapshot[]
  readonly teamIds: readonly string[]
  /** The last 500-shape view is the stable adversarial Canvas fixture. */
  readonly denseDiagramIndex: number
  readonly denseConnectionStart: number
  readonly denseConnectionCount: number
  readonly denseGovernanceObjectCount: number
  private readonly actorOffset = 0
  private readonly systemOffset: number
  private readonly containerOffset: number
  private readonly componentOffset: number
  private readonly denseObjectIndexes: readonly number[]
  private readonly denseObjectPositions: ReadonlyMap<number, number>

  constructor(options: PerformanceSeedPlanOptions) {
    this.scale = options.scale
    this.seed = options.seed ?? 2_026_0723
    this.tags = [...options.tags]
    this.teamIds = [...options.teamIds]
    assertInteger('objects', this.scale.objects, 500)
    assertInteger('connections', this.scale.connections)
    assertInteger('decisionRecords', this.scale.decisionRecords)
    assertInteger('users', this.scale.users)
    assertInteger('teams', this.scale.teams)
    assertInteger('denseDiagramConnections', this.scale.denseDiagramConnections, 0)
    if (this.tags.length < 3) throw new Error('performance seed requires at least three governed Tags')
    if (this.teamIds.length !== this.scale.teams) {
      throw new Error(`performance seed expected ${this.scale.teams} team ids, got ${this.teamIds.length}`)
    }
    if (!this.scale.diagramBuckets.length) throw new Error('performance seed requires diagram buckets')
    for (const bucket of this.scale.diagramBuckets) {
      assertInteger(`diagram bucket ${bucket.shapes}`, bucket.count)
      if (bucket.shapes > this.scale.objects) throw new Error(`diagram size ${bucket.shapes} exceeds object count`)
    }
    this.diagramCount = this.scale.diagramBuckets.reduce((sum, bucket) => sum + bucket.count, 0)
    let denseDiagramIndex = -1
    let diagramOffset = 0
    for (const bucket of this.scale.diagramBuckets) {
      if (bucket.shapes === 500 && bucket.count > 0) denseDiagramIndex = diagramOffset + bucket.count - 1
      diagramOffset += bucket.count
    }
    this.denseDiagramIndex = denseDiagramIndex
    this.denseConnectionCount = denseDiagramIndex >= 0 ? this.scale.denseDiagramConnections : 0

    const actors = Math.max(4, Math.floor(this.scale.objects * 0.005))
    const systems = Math.max(12, Math.floor(this.scale.objects * 0.025))
    const containers = Math.max(systems, Math.floor(this.scale.objects * 0.20))
    const components = this.scale.objects - actors - systems - containers
    if (components < Math.max(100, containers)) throw new Error('performance seed scale leaves too few C4 components')
    this.tierCounts = { actors, systems, containers, components }
    this.systemOffset = actors
    this.containerOffset = actors + systems
    this.componentOffset = actors + systems + containers

    const actorCount = Math.min(this.scale.connections, actors * 5)
    const systemCount = Math.min(this.scale.connections - actorCount, systems * 5)
    const containerCount = Math.min(this.scale.connections - actorCount - systemCount, containers * 3)
    const componentCount = this.scale.connections - actorCount - systemCount - containerCount
    this.connectionPhases = {
      actorStart: 0,
      actorCount,
      systemStart: actorCount,
      systemCount,
      containerStart: actorCount + systemCount,
      containerCount,
      componentStart: actorCount + systemCount + containerCount,
      componentCount,
    }
    if (this.denseConnectionCount > componentCount) {
      throw new Error(
        `dense diagram requires ${this.denseConnectionCount} component-phase connections; only ${componentCount} are available`,
      )
    }
    this.denseConnectionStart = this.scale.connections - this.denseConnectionCount
    this.denseGovernanceObjectCount = Math.min(
      this.scale.objects - this.systemOffset,
      Math.ceil(this.scale.objects * GOVERNANCE_COVERAGE),
    )
    this.denseObjectIndexes = denseDiagramIndex >= 0 ? this.buildDenseObjectIndexes(500) : []
    this.denseObjectPositions = new Map(this.denseObjectIndexes.map((objectIndex, position) => [objectIndex, position]))
  }

  objectId(index: number): string {
    this.assertObjectIndex(index)
    return `perf-o-${String(index).padStart(PAD, '0')}`
  }

  connectionId(index: number): string {
    this.assertConnectionIndex(index)
    return `perf-c-${String(index).padStart(PAD, '0')}`
  }

  diagramId(index: number): string {
    this.assertDiagramIndex(index)
    return `perf-dg-${String(index).padStart(PAD, '0')}`
  }

  decisionRecordId(index: number): string {
    if (!Number.isInteger(index) || index < 0 || index >= this.scale.decisionRecords) throw new Error(`invalid ADR index ${index}`)
    return `perf-adr-${String(index + 1).padStart(PAD, '0')}`
  }

  domains(): PerformanceDomain[] {
    return REFERENCE_ARCHITECTURES.flatMap((architecture, architectureIndex) => (
      architecture.capabilities.map((capability, capabilityIndex) => ({
        id: this.domainId(architectureIndex, capabilityIndex),
        name: `${architecture.name} / ${capability}`,
        description: `${capability} business capability in the ${architecture.name} reference architecture.`,
        color: colorFor(architectureIndex * 8 + capabilityIndex),
      }))
    ))
  }

  tagSnapshots(): Record<string, PerformanceTagSnapshot> {
    return Object.fromEntries(this.tags.map((tag) => [tag.tagId, tag]))
  }

  summary(): PerformanceSeedSummary {
    return {
      profile: this.scale.name,
      objects: this.scale.objects,
      connections: this.scale.connections,
      diagrams: this.diagramCount,
      diagramShapeAppearances: this.scale.diagramBuckets.reduce((sum, bucket) => sum + bucket.shapes * bucket.count, 0),
      decisionRecords: this.scale.decisionRecords,
      users: this.scale.users,
      teams: this.scale.teams,
      domains: this.domains().length,
    }
  }

  objectAt(index: number): PerformanceObject {
    this.assertObjectIndex(index)
    if (index < this.systemOffset) return this.actorAt(index)
    if (index < this.containerOffset) return this.systemAt(index - this.systemOffset)
    if (index < this.componentOffset) return this.containerAt(index - this.containerOffset)
    return this.componentAt(index - this.componentOffset)
  }

  connectionAt(index: number): PerformanceConnection {
    this.assertConnectionIndex(index)
    if (index >= this.denseConnectionStart) return this.denseConnectionAt(index)
    const p = this.connectionPhases
    if (index < p.systemStart) return this.actorConnectionAt(index)
    if (index < p.containerStart) return this.systemConnectionAt(index - p.systemStart, index)
    if (index < p.componentStart) return this.containerConnectionAt(index - p.containerStart, index)
    return this.componentConnectionAt(index - p.componentStart, index)
  }

  diagramIdentityAt(index: number): PerformanceDiagramIdentity {
    this.assertDiagramIndex(index)
    const shapeCount = this.diagramShapeCount(index)
    const type = (['context', 'container', 'component'] as const)[index % 3]
    const architectureIndex = (index + this.seed) % REFERENCE_ARCHITECTURES.length
    const architecture = REFERENCE_ARCHITECTURES[architectureIndex]
    const capabilityIndex = Math.floor(index / REFERENCE_ARCHITECTURES.length) % architecture.capabilities.length
    const capability = architecture.capabilities[capabilityIndex]
    const region = REGIONS[Math.floor(index / (REFERENCE_ARCHITECTURES.length * 8)) % REGIONS.length]
    const typeLabel = type === 'context' ? 'System Context' : type === 'container' ? 'Container View' : 'Component Interaction View'
    const identity: PerformanceDiagramIdentity = {
      id: this.diagramId(index),
      name: `${architecture.name} / ${capability} / ${region} — ${typeLabel} ${String(index + 1).padStart(5, '0')}`,
      type,
      description: `${shapeCount}-shape production reference view for ${capability} in ${region}. ` +
        'The view is synthetic but follows established C4 hierarchy and distributed-system patterns.',
      shapeCount,
      domainId: this.domainId(architectureIndex, capabilityIndex),
    }
    const compositionSeed = stableNumber(index + this.seed)
    if (type === 'container') {
      const system = compositionSeed % this.tierCounts.systems
      identity.parentObjectId = this.objectId(this.systemOffset + system)
    } else if (type === 'component') {
      const container = compositionSeed % this.tierCounts.containers
      identity.parentObjectId = this.objectId(this.containerOffset + container)
    }
    return identity
  }

  diagramAt(index: number): PerformanceDiagram {
    const identity = this.diagramIdentityAt(index)
    const objectIndexes = this.diagramObjectIndexes(index, identity)
    const objectIds = objectIndexes.map((objectIndex) => this.objectId(objectIndex))
    const selected = new Set(objectIds)
    const connectionIds: string[] = []
    if (index === this.denseDiagramIndex) {
      for (let connectionIndex = this.denseConnectionStart; connectionIndex < this.scale.connections; connectionIndex++) {
        connectionIds.push(this.connectionId(connectionIndex))
      }
    } else {
      const seenConnections = new Set<number>()
      for (const objectIndex of objectIndexes) {
        for (const connectionIndex of this.outgoingConnectionIndexes(objectIndex)) {
          if (seenConnections.has(connectionIndex)) continue
          const connection = this.connectionAt(connectionIndex)
          if (!selected.has(connection.toId)) continue
          seenConnections.add(connectionIndex)
          connectionIds.push(connection.id)
          if (connectionIds.length >= identity.shapeCount * 3) break
        }
        if (connectionIds.length >= identity.shapeCount * 3) break
      }
    }

    const layouts: PerformanceDiagram['layouts'] = {}
    const columns = identity.shapeCount <= 10 ? 4 : identity.shapeCount <= 50 ? 8 : identity.shapeCount <= 100 ? 12 : 25
    objectIds.forEach((objectId, objectIndex) => {
      layouts[objectId] = {
        position: { x: (objectIndex % columns) * 240, y: Math.floor(objectIndex / columns) * 160 },
        size: SHAPE_SIZE,
      }
    })
    const comments = this.commentsForDiagram(index, identity)
    const flows = this.flowsForDiagram(index, identity, objectIds, connectionIds)
    const styles = ['none', 'traveling-dot', 'gradient-flow', 'pulse'] as const
    return {
      ...identity,
      objectIds,
      connectionIds,
      groupIds: [],
      layouts,
      comments: recordById(comments),
      flows: recordById(flows),
      connectionHighlightStyle: styles[index % styles.length],
      connectionAnimationsEnabled: index % 7 !== 0,
      defaultConnectionShape: index % 4 === 0 ? 'straight' : 'curved',
      skinId: index % 5 === 0 ? 'studio' : 'default',
    }
  }

  decisionRecordAt(index: number): PerformanceDecisionRecord {
    if (!Number.isInteger(index) || index < 0 || index >= this.scale.decisionRecords) throw new Error(`invalid ADR index ${index}`)
    const architectureIndex = (index + this.seed) % REFERENCE_ARCHITECTURES.length
    const architecture = REFERENCE_ARCHITECTURES[architectureIndex]
    const capability = architecture.capabilities[Math.floor(index / REFERENCE_ARCHITECTURES.length) % architecture.capabilities.length]
    const container = architecture.containers[index % architecture.containers.length]
    const technology = container.technologies[index % container.technologies.length]
    const diagramIndex = index % this.diagramCount
    const diagram = this.diagramIdentityAt(diagramIndex)
    const status = ADR_STATUSES[index % ADR_STATUSES.length]
    const month = 1 + (index % 12)
    const day = 1 + (index % 27)
    const createdAt = `2025-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T09:00:00.000Z`
    const updatedAt = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T15:30:00.000Z`
    const related: PerformanceDecisionRecord['related'] = [
      { id: `perf-adrl-${index}-diagram`, type: 'diagram', label: diagram.name, targetId: diagram.id },
      { id: `perf-adrl-${index}-url`, type: 'url', label: `${technology} documentation`, url: TECHNOLOGY_DOCUMENTATION[technology] ?? architecture.documentationUrl },
    ]
    if (index > 0) {
      related.push({
        id: `perf-adrl-${index}-adr`,
        type: 'adr',
        label: `Preceding decision ADR-${index}`,
        targetId: this.decisionRecordId(index - 1),
      })
    }
    return {
      id: this.decisionRecordId(index),
      number: index + 1,
      title: `Adopt ${technology} for ${architecture.name} ${capability}`,
      summary: `Standardize ${container.name} on ${technology} to ${container.responsibility}.`,
      status,
      author: `performance-architect-${String(index % Math.min(250, this.scale.users)).padStart(4, '0')}`,
      createdAt,
      updatedAt,
      content: `## Context\n${architecture.description} The ${capability} capability needs a repeatable implementation for ${container.responsibility}.\n\n` +
        `## Decision\nUse ${technology} for the ${container.name}. Apply tenant isolation, idempotency, bounded retries, ` +
        `structured telemetry and automated recovery.\n\n## Consequences\nTeams gain a governed default and shared operational tooling. ` +
        `They must measure saturation, failure recovery and data consistency before production rollout.`,
      related,
      history: status === 'in-progress'
        ? [{ status: 'in-progress', date: createdAt }]
        : [{ status: 'in-progress', date: createdAt }, { status, date: updatedAt }],
    }
  }

  outgoingConnectionIndexes(objectIndex: number): number[] {
    this.assertObjectIndex(objectIndex)
    const p = this.connectionPhases
    let local: number
    let phaseStart: number
    let phaseCount: number
    let tierSize: number
    if (objectIndex < this.systemOffset) {
      local = objectIndex
      phaseStart = p.actorStart
      phaseCount = p.actorCount
      tierSize = this.tierCounts.actors
    } else if (objectIndex < this.containerOffset) {
      local = objectIndex - this.systemOffset
      phaseStart = p.systemStart
      phaseCount = p.systemCount
      tierSize = this.tierCounts.systems
    } else if (objectIndex < this.componentOffset) {
      local = objectIndex - this.containerOffset
      phaseStart = p.containerStart
      phaseCount = p.containerCount
      tierSize = this.tierCounts.containers
    } else {
      local = objectIndex - this.componentOffset
      phaseStart = p.componentStart
      phaseCount = p.componentCount - this.denseConnectionCount
      tierSize = this.tierCounts.components
    }
    const indexes: number[] = []
    for (let pass = 0; pass * tierSize + local < phaseCount; pass++) {
      indexes.push(phaseStart + pass * tierSize + local)
    }
    const densePosition = this.denseObjectPositions.get(objectIndex)
    if (densePosition !== undefined) {
      for (
        let denseLocal = densePosition;
        denseLocal < this.denseConnectionCount;
        denseLocal += this.denseObjectIndexes.length
      ) {
        indexes.push(this.denseConnectionStart + denseLocal)
      }
    }
    return indexes
  }

  private actorAt(local: number): PerformanceObject {
    const architecture = REFERENCE_ARCHITECTURES[local % REFERENCE_ARCHITECTURES.length]
    const actor = architecture.actors[Math.floor(local / REFERENCE_ARCHITECTURES.length) % architecture.actors.length]
    const capabilityIndex = local % architecture.capabilities.length
    return this.baseObject(local, 'actor', `${actor} / cohort ${String(Math.floor(local / 36) + 1).padStart(3, '0')}`, {
      description: `${actor} interacting with ${architecture.name}.`,
      architectureIndex: local % REFERENCE_ARCHITECTURES.length,
      capabilityIndex,
      scope: 'external',
      technologies: [],
      properties: { persona: actor, channel: local % 2 ? 'mobile' : 'web' },
    })
  }

  private systemAt(local: number): PerformanceObject {
    const global = this.systemOffset + local
    const architectureIndex = local % REFERENCE_ARCHITECTURES.length
    const architecture = REFERENCE_ARCHITECTURES[architectureIndex]
    const capabilityIndex = Math.floor(local / REFERENCE_ARCHITECTURES.length) % architecture.capabilities.length
    const capability = architecture.capabilities[capabilityIndex]
    const cell = Math.floor(local / (REFERENCE_ARCHITECTURES.length * architecture.capabilities.length)) + 1
    return this.baseObject(global, 'system', `${architecture.name} / ${capability} / cell ${String(cell).padStart(3, '0')}`, {
      description: `${capability} software system in ${architecture.name}. ${architecture.description}`,
      architectureIndex,
      capabilityIndex,
      scope: local % 23 === 0 ? 'external' : 'internal',
      technologies: ['Prometheus', 'Terraform'],
      properties: { architecture: architecture.name, capability, cell: String(cell) },
    })
  }

  private containerAt(local: number): PerformanceObject {
    const global = this.containerOffset + local
    const parentLocal = local % this.tierCounts.systems
    const parent = this.systemAt(parentLocal)
    const architectureIndex = parentLocal % REFERENCE_ARCHITECTURES.length
    const architecture = REFERENCE_ARCHITECTURES[architectureIndex]
    const capabilityIndex = Math.floor(parentLocal / REFERENCE_ARCHITECTURES.length) % architecture.capabilities.length
    const ordinal = Math.floor(local / this.tierCounts.systems)
    const role = architecture.containers[ordinal % architecture.containers.length]
    return this.baseObject(global, role.type, `${role.name} / ${parent.properties.cell}`, {
      description: `${role.name} ${role.responsibility} for ${parent.name}.`,
      architectureIndex,
      capabilityIndex,
      parentId: parent.id,
      scope: 'internal',
      technologies: role.technologies,
      properties: { responsibility: role.responsibility, containerRole: role.name, parentSystem: parent.name },
    })
  }

  private componentAt(local: number): PerformanceObject {
    const global = this.componentOffset + local
    const parentLocal = local % this.tierCounts.containers
    const parent = this.containerAt(parentLocal)
    const parentSystemLocal = parentLocal % this.tierCounts.systems
    const architectureIndex = parentSystemLocal % REFERENCE_ARCHITECTURES.length
    const architecture = REFERENCE_ARCHITECTURES[architectureIndex]
    const capabilityIndex = Math.floor(parentSystemLocal / REFERENCE_ARCHITECTURES.length) % architecture.capabilities.length
    const ordinal = Math.floor(local / this.tierCounts.containers)
    const componentRole = architecture.componentRoles[ordinal % architecture.componentRoles.length]
    const parentTechnologies = Object.values(parent.technologyUsages ?? {}).map((usage) => usage.snapshot.name)
    const technologies = parentTechnologies.slice(0, 2)
    return this.baseObject(global, 'component', `${componentRole} / ${parent.name}`, {
      description: `${componentRole} inside ${parent.name}; implements ${architecture.capabilities[capabilityIndex]} rules and operational safeguards.`,
      architectureIndex,
      capabilityIndex,
      parentId: parent.id,
      scope: 'internal',
      technologies,
      properties: { componentRole, parentContainer: parent.name, deploymentUnit: `unit-${String(parentLocal).padStart(5, '0')}` },
    })
  }

  private baseObject(
    globalIndex: number,
    type: PerformanceObject['type'],
    name: string,
    input: {
      description: string
      architectureIndex: number
      capabilityIndex: number
      parentId?: string
      scope: PerformanceObject['scope']
      technologies: readonly string[]
      properties: Record<string, string>
    },
  ): PerformanceObject {
    const id = this.objectId(globalIndex)
    const architecture = REFERENCE_ARCHITECTURES[input.architectureIndex]
    const tags = this.tagsFor(globalIndex)
    const technologyNames = [...new Set(input.technologies)]
    if (this.hasDenseGovernance(globalIndex) && !technologyNames.includes(GOVERNANCE_TECHNOLOGY)) {
      technologyNames.push(GOVERNANCE_TECHNOLOGY)
    }
    const usages = technologyNames.map((name, usageIndex) => this.technologyUsage(id, name, usageIndex))
    const usageMap = recordById(usages)
    const firstUsage = usages[0]
    const team = this.teamIds[globalIndex % this.teamIds.length]
    const secondaryTeam = this.teamIds[(globalIndex * 17 + 3) % this.teamIds.length]
    const region = REGIONS[globalIndex % REGIONS.length]
    return {
      id,
      type,
      name,
      description: input.description,
      ...(usages.length ? { technologyUsages: usageMap, technologyUsageOrder: usages.map((usage) => usage.id) } : {}),
      ...(firstUsage ? {
        icon: firstUsage.snapshot.name,
        iconAssignment: {
          source: 'technology' as const,
          mode: 'automatic' as const,
          displayName: firstUsage.snapshot.name,
          technologyUsageId: firstUsage.id,
          catalogRevision: firstUsage.catalogRevision,
          ...(firstUsage.snapshot.iconLightPath ? { iconLightPath: firstUsage.snapshot.iconLightPath } : {}),
          ...(firstUsage.snapshot.iconDarkPath ? { iconDarkPath: firstUsage.snapshot.iconDarkPath } : {}),
        },
      } : {}),
      position: { x: (globalIndex % 40) * 220, y: Math.floor(globalIndex / 40) * 140 },
      size: SHAPE_SIZE,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      domainId: this.domainId(input.architectureIndex, input.capabilityIndex),
      tagAssignments: Object.fromEntries(tags.map((tag) => [tag.tagId, { tagId: tag.tagId }])),
      tagOrder: tags.map((tag) => tag.tagId),
      ownerTeamIds: [team],
      teamIds: team === secondaryTeam ? [team] : [team, secondaryTeam],
      links: [
        architecture.documentationUrl,
        ...(firstUsage ? [TECHNOLOGY_DOCUMENTATION[firstUsage.snapshot.name] ?? architecture.documentationUrl] : []),
      ],
      scope: input.scope,
      status: STATUSES[stableNumber(globalIndex + this.seed) % STATUSES.length],
      properties: {
        ...input.properties,
        region,
        ownerTeamId: team,
        serviceTier: String(1 + (globalIndex % 4)),
        availabilityTarget: globalIndex % 5 === 0 ? '99.99%' : '99.9%',
        runbook: `RB-${String(globalIndex).padStart(PAD, '0')}`,
      },
    }
  }

  private technologyUsage(ownerId: string, name: string, index: number): PerformanceTechnologyUsage {
    const technologyId = SEEDED_TECHNOLOGY_IDS[name]
    const metadata = seededTechnologyMetadata(name)
    if (!technologyId || !metadata) throw new Error(`Missing governed technology seed metadata for ${name}`)
    const id = `perf-tu-${ownerId}-${index}`
    return {
      id,
      technologyId,
      catalogRevision: SEEDED_TECHNOLOGY_CATALOG_REVISION,
      role: metadata.defaultRole,
      snapshot: { schemaVersion: 1, name, ...metadata },
    }
  }

  private tagsFor(index: number): PerformanceTagSnapshot[] {
    const selected: PerformanceTagSnapshot[] = []
    const seen = new Set<number>()
    if (this.hasDenseGovernance(index)) {
      selected.push(this.tags[0])
      seen.add(0)
    }
    for (let step = 0; selected.length < 3; step++) {
      const tagIndex = stableNumber(index * 31 + step * 997 + this.seed) % this.tags.length
      if (seen.has(tagIndex)) continue
      seen.add(tagIndex)
      selected.push(this.tags[tagIndex])
    }
    return selected
  }

  private hasDenseGovernance(index: number): boolean {
    return index >= this.systemOffset && index < this.systemOffset + this.denseGovernanceObjectCount
  }

  private denseConnectionAt(index: number): PerformanceConnection {
    const local = index - this.denseConnectionStart
    const sourcePosition = local % this.denseObjectIndexes.length
    const pass = Math.floor(local / this.denseObjectIndexes.length)
    const targetShift = 1 + ((pass * 37) % (this.denseObjectIndexes.length - 1))
    const targetPosition = (sourcePosition + targetShift) % this.denseObjectIndexes.length
    return this.makeConnection(
      index,
      this.denseObjectIndexes[sourcePosition],
      this.denseObjectIndexes[targetPosition],
      DENSE_CONNECTION_LABELS[pass % DENSE_CONNECTION_LABELS.length],
    )
  }

  private actorConnectionAt(local: number): PerformanceConnection {
    const actor = local % this.tierCounts.actors
    const pass = Math.floor(local / this.tierCounts.actors)
    const target = (actor * 17 + pass * 97 + this.seed) % this.tierCounts.systems
    return this.makeConnection(local, this.actorOffset + actor, this.systemOffset + target, ['uses', 'administers', 'observes', 'receives notifications from', 'submits work to'][pass % 5])
  }

  private systemConnectionAt(local: number, globalConnectionIndex: number): PerformanceConnection {
    const source = local % this.tierCounts.systems
    const pass = Math.floor(local / this.tierCounts.systems)
    let target = (source + 1 + pass * 997) % this.tierCounts.systems
    if (target === source) target = (target + 1) % this.tierCounts.systems
    const labels = ['calls public API', 'publishes business events', 'consumes reference data', 'requests authorization', 'exports operational telemetry']
    return this.makeConnection(globalConnectionIndex, this.systemOffset + source, this.systemOffset + target, labels[pass % labels.length])
  }

  private containerConnectionAt(local: number, globalConnectionIndex: number): PerformanceConnection {
    const source = local % this.tierCounts.containers
    const pass = Math.floor(local / this.tierCounts.containers)
    const parent = source % this.tierCounts.systems
    const ordinal = Math.floor(source / this.tierCounts.systems)
    const siblings = this.containerChildren(parent)
    let target: number
    if (pass < Math.max(1, siblings.length - 1)) {
      target = siblings[(siblings.indexOf(source) + pass + 1) % siblings.length]
    } else {
      const nextParent = (parent + 1 + pass) % this.tierCounts.systems
      const targets = this.containerChildren(nextParent)
      target = targets[ordinal % targets.length]
    }
    const labels = ['invokes via REST', 'publishes to event stream', 'reads and writes', 'replicates state to']
    return this.makeConnection(globalConnectionIndex, this.containerOffset + source, this.containerOffset + target, labels[pass % labels.length])
  }

  private componentConnectionAt(local: number, globalConnectionIndex: number): PerformanceConnection {
    const source = local % this.tierCounts.components
    const pass = Math.floor(local / this.tierCounts.components)
    const parent = source % this.tierCounts.containers
    const siblings = this.componentChildren(parent)
    const sourcePosition = siblings.indexOf(source)
    const target = siblings[(sourcePosition + 1 + pass) % siblings.length]
    const labels = ['delegates command', 'queries state', 'emits event', 'validates policy']
    return this.makeConnection(globalConnectionIndex, this.componentOffset + source, this.componentOffset + target, labels[pass % labels.length])
  }

  private makeConnection(index: number, sourceObjectIndex: number, targetObjectIndex: number, label: string): PerformanceConnection {
    if (sourceObjectIndex === targetObjectIndex) throw new Error(`self connection at ${index}`)
    return {
      id: this.connectionId(index),
      fromId: this.objectId(sourceObjectIndex),
      toId: this.objectId(targetObjectIndex),
      label,
      type: index % 11 === 0 ? 'dashed' : index % 17 === 0 ? 'dotted' : 'solid',
      shape: index % 4 === 0 ? 'straight' : 'curved',
      status: STATUSES[stableNumber(index + this.seed) % STATUSES.length],
    }
  }

  private diagramObjectIndexes(index: number, identity: PerformanceDiagramIdentity): number[] {
    if (index === this.denseDiagramIndex) return [...this.denseObjectIndexes]
    const selected = new Set<number>()
    const add = (value: number) => {
      if (selected.size < identity.shapeCount && value >= 0 && value < this.scale.objects) selected.add(value)
    }
    const seed = stableNumber(index + this.seed)
    if (identity.type === 'context') {
      const actorTarget = Math.max(1, Math.floor(identity.shapeCount / 10))
      for (let actorIndex = 0; actorIndex < actorTarget; actorIndex++) {
        const actor = (seed + actorIndex * 37) % this.tierCounts.actors
        add(actor)
        for (const connectionIndex of this.outgoingConnectionIndexes(actor)) {
          const targetId = this.connectionAt(connectionIndex).toId
          add(this.objectIndexFromId(targetId))
        }
      }
      let system = seed % this.tierCounts.systems
      let visitedSystems = 0
      while (selected.size < identity.shapeCount && visitedSystems < this.tierCounts.systems) {
        const globalSystem = this.systemOffset + system
        add(globalSystem)
        for (const connectionIndex of this.outgoingConnectionIndexes(globalSystem)) {
          add(this.objectIndexFromId(this.connectionAt(connectionIndex).toId))
          if (selected.size >= identity.shapeCount) break
        }
        system = (system + 1) % this.tierCounts.systems
        visitedSystems++
      }
    } else if (identity.type === 'container') {
      let system = seed % this.tierCounts.systems
      let visitedSystems = 0
      while (selected.size < identity.shapeCount && visitedSystems < this.tierCounts.systems) {
        for (const container of this.containerChildren(system)) add(this.containerOffset + container)
        if (selected.size < identity.shapeCount) add(this.systemOffset + ((system + 1) % this.tierCounts.systems))
        system = (system + 1) % this.tierCounts.systems
        visitedSystems++
      }
    } else {
      let container = seed % this.tierCounts.containers
      while (selected.size < identity.shapeCount) {
        for (const component of this.componentChildren(container)) add(this.componentOffset + component)
        container = (container + 1) % this.tierCounts.containers
        if (selected.size === this.tierCounts.components && selected.size < identity.shapeCount) break
      }
    }
    let fallback = seed % this.scale.objects
    while (selected.size < identity.shapeCount) {
      add(fallback)
      fallback = (fallback + 7_919) % this.scale.objects
    }
    return [...selected]
  }

  private buildDenseObjectIndexes(shapeCount: number): number[] {
    const selected: number[] = []
    const seen = new Set<number>()
    const add = (value: number) => {
      if (selected.length >= shapeCount || value < 0 || value >= this.scale.objects || seen.has(value)) return
      seen.add(value)
      selected.push(value)
    }
    const componentStart = stableNumber(this.seed + this.denseDiagramIndex) % this.tierCounts.components
    for (let offset = 0; offset < this.tierCounts.components && selected.length < shapeCount; offset++) {
      add(this.componentOffset + ((componentStart + offset) % this.tierCounts.components))
    }
    let fallback = stableNumber(this.seed ^ this.denseDiagramIndex) % this.scale.objects
    while (selected.length < shapeCount) {
      add(fallback)
      fallback = (fallback + 7_919) % this.scale.objects
    }
    return selected
  }

  private commentsForDiagram(index: number, identity: PerformanceDiagramIdentity): Array<PerformanceDiagram['comments'][string]> {
    const count = identity.shapeCount === 10 ? 2 : identity.shapeCount === 50 ? 4 : identity.shapeCount === 100 ? 6 : 10
    const prompts = [
      'Confirm the recovery time objective with the owning team.',
      'Validate that this dependency has an idempotent retry policy.',
      'Document the data classification and retention period.',
      'Review whether the synchronous call should become an event.',
      'Add the saturation signal used by the autoscaling policy.',
    ]
    return Array.from({ length: count }, (_, commentIndex) => {
      const authorIndex = (index * 13 + commentIndex * 101) % this.scale.users
      const createdAt = `2026-06-${String(1 + ((index + commentIndex) % 27)).padStart(2, '0')}T12:00:00.000Z`
      const id = `perf-cm-${index}-${commentIndex}`
      return {
        id,
        diagramId: identity.id,
        type: (['question', 'inaccuracy', 'idea'] as const)[(index + commentIndex) % 3],
        text: prompts[(index + commentIndex) % prompts.length],
        position: { x: 30 + (commentIndex % 5) * 260, y: 30 + Math.floor(commentIndex / 5) * 180 },
        author: `perf-user-${String(authorIndex + 1).padStart(5, '0')}@load.example.test`,
        createdAt,
        resolved: commentIndex % 4 === 0,
        pinned: commentIndex % 5 === 0,
        replies: commentIndex % 3 === 0 ? [{
          id: `${id}-reply`,
          text: 'Owner acknowledged; evidence is linked in the runbook.',
          author: `perf-user-${String(((authorIndex + 1) % this.scale.users) + 1).padStart(5, '0')}@load.example.test`,
          createdAt,
        }] : [],
      }
    })
  }

  private flowsForDiagram(
    index: number,
    identity: PerformanceDiagramIdentity,
    objectIds: string[],
    connectionIds: string[],
  ): Array<PerformanceDiagram['flows'][string]> {
    const steps: PerformanceDiagram['flows'][string]['steps'] = [{
      id: `perf-flow-step-${index}-start`, order: 0, type: 'introduction', title: 'Request enters the architecture',
    }]
    if (connectionIds[0]) {
      const connectionIndex = Number(connectionIds[0].slice('perf-c-'.length))
      const connection = this.connectionAt(connectionIndex)
      steps.push({
        id: `perf-flow-step-${index}-message`, order: 1, type: 'message', title: connection.label,
        fromObjectId: connection.fromId, toObjectId: connection.toId, connectionId: connection.id,
      })
    } else if (objectIds[0]) {
      steps.push({
        id: `perf-flow-step-${index}-process`, order: 1, type: 'process', title: 'Process the request', objectId: objectIds[0],
      })
    }
    steps.push({ id: `perf-flow-step-${index}-done`, order: steps.length, type: 'conclusion', title: 'Outcome is observed' })
    return [{ id: `perf-flow-${index}`, name: `${identity.name} / principal flow`, diagramId: identity.id, steps }]
  }

  private diagramShapeCount(index: number): number {
    let offset = 0
    for (const bucket of this.scale.diagramBuckets) {
      if (index < offset + bucket.count) return bucket.shapes
      offset += bucket.count
    }
    throw new Error(`invalid diagram index ${index}`)
  }

  private containerChildren(systemLocal: number): number[] {
    const values: number[] = []
    for (let index = systemLocal; index < this.tierCounts.containers; index += this.tierCounts.systems) values.push(index)
    return values
  }

  private componentChildren(containerLocal: number): number[] {
    const values: number[] = []
    for (let index = containerLocal; index < this.tierCounts.components; index += this.tierCounts.containers) values.push(index)
    return values
  }

  private domainId(architectureIndex: number, capabilityIndex: number): string {
    const architecture = REFERENCE_ARCHITECTURES[architectureIndex % REFERENCE_ARCHITECTURES.length]
    return `perf-dom-${architecture.key}-${capabilityIndex % architecture.capabilities.length}`
  }

  private objectIndexFromId(id: string): number {
    if (!id.startsWith('perf-o-')) throw new Error(`invalid performance object id ${id}`)
    const index = Number(id.slice('perf-o-'.length))
    this.assertObjectIndex(index)
    return index
  }

  private assertObjectIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.scale.objects) throw new Error(`invalid object index ${index}`)
  }

  private assertConnectionIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.scale.connections) throw new Error(`invalid connection index ${index}`)
  }

  private assertDiagramIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.diagramCount) throw new Error(`invalid diagram index ${index}`)
  }
}
