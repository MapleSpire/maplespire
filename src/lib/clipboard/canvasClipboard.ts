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

import type { C4Object, Connection, Diagram, Group, SelectedItem } from '../../types'
import type { Placement } from '../history/modelDiff'
import { validatedTechnologyUsages } from '../import/maplespireJson'

/**
 * The canvas clipboard format: what Ctrl+C / Ctrl+X put on the system
 * clipboard and Ctrl+V reads back, across diagrams, tabs and workspaces.
 *
 * Three representations are written, the richest first:
 * - `application/x-maplespire-canvas+json` — the payload. Chromium carries
 *   custom formats between its own tabs; Safari and Firefox drop them.
 * - `text/html` — the same payload base64-encoded inside an HTML comment, which
 *   every browser keeps (a rich-text editor shows nothing for it).
 * - `text/plain` — the shape names, one per line, for pasting into a document.
 *
 * Anything read back is UNTRUSTED (a page can put any text/html on the
 * clipboard): `decodeClipboardPayload` validates structure, caps the size, keeps
 * only known fields and drops links that are not http(s)/mailto.
 */

export const CANVAS_CLIPBOARD_MIME = 'application/x-maplespire-canvas+json'
const HTML_MARKER = 'maplespire-canvas:'
const VERSION = 1
/** Roughly a thousand fully decorated shapes. A larger blob is not ours. */
export const MAX_PAYLOAD_BYTES = 2_000_000

export interface CanvasClipboardPayload {
  app: 'maplespire'
  version: typeof VERSION
  /** Random per copy: lets repeated pastes of the same copy cascade. */
  copyId: string
  /** `workspaceRefKey` of the source — references only resolve inside it. */
  workspaceKey: string
  sourceDiagramId: string
  objects: C4Object[]
  groups: Group[]
  connections: Connection[]
  /** Where each shape was SHOWN when copied (the active 2D/3D layer). */
  placements: Record<string, Placement>
}

export interface ClipboardSource {
  objects: readonly C4Object[]
  connections: readonly Connection[]
  groups: readonly Group[]
}

/**
 * What a copy of `selection` on `diagram` contains: the selected shapes, the
 * members of selected groups that are drawn on the diagram, and every
 * connection of the diagram whose BOTH ends are in the copy (a connection with
 * one end left behind has nowhere to attach on paste). Diagram wrapper groups
 * (`parentObjectId`) are structure, not content, and are never copied.
 */
export function buildClipboardPayload(
  source: ClipboardSource,
  diagram: Diagram,
  selection: readonly SelectedItem[],
  space: '2d' | '3d',
  workspaceKey: string,
  copyId: string,
): CanvasClipboardPayload | null {
  const onDiagramObjects = new Set(diagram.objectIds)
  const onDiagramGroups = new Set(diagram.groupIds)
  const objectById = new Map(source.objects.map((o) => [o.id, o]))
  const groupById = new Map(source.groups.map((g) => [g.id, g]))

  const objectIds = new Set<string>()
  const groupIds = new Set<string>()
  for (const item of selection) {
    if (item.type === 'object' && onDiagramObjects.has(item.id) && objectById.has(item.id)) objectIds.add(item.id)
    if (item.type === 'group' && onDiagramGroups.has(item.id)) {
      const group = groupById.get(item.id)
      if (!group || group.parentObjectId) continue
      groupIds.add(group.id)
      for (const member of group.objectIds) {
        if (onDiagramObjects.has(member) && objectById.has(member)) objectIds.add(member)
      }
    }
  }
  if (objectIds.size === 0 && groupIds.size === 0) return null

  const shapeIds = new Set([...objectIds, ...groupIds])
  const connections = source.connections.filter((c) =>
    c.kind !== 'lower'
    && diagram.connectionIds.includes(c.id)
    && shapeIds.has(c.fromId)
    && shapeIds.has(c.toId))

  const placements: Record<string, Placement> = {}
  for (const id of shapeIds) {
    const entity = objectById.get(id) ?? groupById.get(id)
    const shown = (space === '3d' ? diagram.layouts3d?.[id] : undefined) ?? diagram.layouts?.[id]
    const position = shown?.position ?? entity?.position
    const size = shown?.size ?? entity?.size
    if (position && size) placements[id] = { position: { ...position }, size: { ...size } }
  }

  return {
    app: 'maplespire',
    version: VERSION,
    copyId,
    workspaceKey,
    sourceDiagramId: diagram.id,
    objects: [...objectIds].map((id) => objectById.get(id)!),
    groups: [...groupIds].map((id) => groupById.get(id)!),
    connections,
    placements,
  }
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(encoded: string): string {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export interface EncodedClipboard {
  json: string
  html: string
  text: string
}

export function encodeClipboardPayload(payload: CanvasClipboardPayload): EncodedClipboard {
  const json = JSON.stringify(payload)
  const names = [...payload.objects.map((o) => o.name), ...payload.groups.map((g) => g.name)]
  const text = names.join('\n')
  const escaped = names.map((n) => n.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>')
  const html = `<!--${HTML_MARKER}${toBase64(json)}--><span>${escaped}</span>`
  return { json, html, text }
}

/** Read our payload out of whichever representation survived. */
export function readClipboardPayload(read: (type: string) => string | undefined | null): CanvasClipboardPayload | null {
  const json = read(CANVAS_CLIPBOARD_MIME)
  if (json) return decodeClipboardPayload(json)
  const html = read('text/html')
  if (html) {
    const start = html.indexOf(`<!--${HTML_MARKER}`)
    if (start >= 0) {
      const from = start + 4 + HTML_MARKER.length
      const end = html.indexOf('-->', from)
      if (end > from && end - from <= MAX_PAYLOAD_BYTES * 2) {
        try {
          return decodeClipboardPayload(fromBase64(html.slice(from, end).trim()))
        } catch {
          return null // not base64: not ours
        }
      }
    }
  }
  return null
}

// ── validation ───────────────────────────────────────────────────────────────

const OBJECT_FIELDS = [
  'id', 'type', 'name', 'shortDescription', 'description', 'technologyUsages', 'technologyUsageOrder',
  'icon', 'iconAssignment', 'position', 'size', 'parentId', 'domainId', 'tagAssignments', 'tagOrder',
  'ownerAssignments', 'ownerAssignmentOrder', 'ownerTeamIds', 'teamIds', 'links', 'scope', 'status', 'properties',
] as const
const GROUP_FIELDS = [
  'id', 'name', 'technologyUsages', 'technologyUsageOrder', 'color', 'borderColor', 'borderWidth',
  'fillOpacity', 'fillTransparent', 'icon', 'iconAssignment', 'objectIds', 'position', 'size', 'autoSize',
  'domainId', 'description', 'type', 'properties', 'tagAssignments', 'tagOrder',
] as const
const CONNECTION_FIELDS = [
  'id', 'fromId', 'toId', 'label', 'description', 'technologyUsages', 'technologyUsageOrder',
  'tagAssignments', 'tagOrder', 'ownerAssignments', 'ownerAssignmentOrder', 'ownerTeamIds',
  'labelPosition', 'labelOffset', 'type', 'shape', 'waypoints', 'fromAnchor', 'toAnchor', 'lockedToAnchors',
  'hidden', 'showOnFocus', 'properties', 'status',
  'waypoints3d', 'fromAnchor3d', 'toAnchor3d', 'lockedToAnchors3d', 'labelPosition3d', 'labelOffset3d', 'shape3d',
] as const

const C4_TYPES = new Set(['actor', 'system', 'app', 'store', 'component'])
const STATUSES = new Set(['live', 'draft', 'down', 'unstable'])
const LINE_TYPES = new Set(['solid', 'dashed', 'dotted'])

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isPoint = (v: unknown): boolean => isRecord(v) && isNum(v.x) && isNum(v.y)
const isSize = (v: unknown): boolean => isRecord(v) && isNum(v.width) && isNum(v.height) && v.width >= 0 && v.height >= 0

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) if (source[field] !== undefined) out[field] = source[field]
  return out
}

const SAFE_LINK = /^(https?:|mailto:)/i

function safeLinks(links: unknown): C4Object['links'] {
  if (!Array.isArray(links)) return undefined
  const out = links.filter((link) => {
    const url = typeof link === 'string' ? link : isRecord(link) ? link.url : undefined
    return typeof url === 'string' && SAFE_LINK.test(url.trim())
  }) as C4Object['links']
  return out && out.length ? out : undefined
}

const isOptString = (v: unknown): boolean => v === undefined || typeof v === 'string'
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** String-valued properties only. */
function safeProperties(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {}
  return Object.fromEntries(Object.entries(v).filter(([, value]) => typeof value === 'string')) as Record<string, string>
}

/** Tag assignments keyed by their own tag id, and an order over them. */
function safeTags(raw: Record<string, unknown>): { tagAssignments: Record<string, { tagId: string }>; tagOrder: string[] } {
  const tagAssignments: Record<string, { tagId: string }> = {}
  if (isRecord(raw.tagAssignments)) {
    for (const [key, value] of Object.entries(raw.tagAssignments)) {
      if (isRecord(value) && value.tagId === key && isId(key)) tagAssignments[key] = { tagId: key }
    }
  }
  const order = Array.isArray(raw.tagOrder) ? raw.tagOrder.filter((id): id is string => isId(id) && id in tagAssignments) : []
  const tagOrder = [...new Set(order)]
  for (const id of Object.keys(tagAssignments)) if (!tagOrder.includes(id)) tagOrder.push(id)
  return { tagAssignments, tagOrder }
}

function validOwner(v: unknown): boolean {
  if (!isRecord(v) || !isId(v.id) || typeof v.name !== 'string') return false
  if (v.kind !== 'team' && v.kind !== 'person') return false
  if (v.source !== 'platform' && v.source !== 'external') return false
  if (!isOptString(v.catalogId) || !isOptString(v.email) || !isOptString(v.title) || !isOptString(v.organization)) return false
  if (v.memberCount !== undefined && !isNum(v.memberCount)) return false
  return v.members === undefined
    || (Array.isArray(v.members) && v.members.every((m) => isRecord(m) && isId(m.id) && typeof m.name === 'string' && isOptString(m.email)))
}

/**
 * The nested, renderer-read fields — technologies, icon, owners — are kept
 * only when they have the exact shape the app writes; otherwise they are
 * dropped (the shape still pastes). A malformed one would be written to the
 * model and throw in every renderer that reads it, on every peer.
 */
function sanitizeNested(target: Record<string, unknown>): void {
  let usages: Record<string, unknown> | undefined
  try {
    usages = validatedTechnologyUsages(target.technologyUsages, 'Object', String(target.id)) as Record<string, unknown> | undefined
  } catch {
    usages = undefined
  }
  if (usages && Object.keys(usages).length > 0) {
    target.technologyUsages = usages
    const order = isStringArray(target.technologyUsageOrder) ? target.technologyUsageOrder.filter((id) => id in usages!) : []
    target.technologyUsageOrder = [...new Set(order)]
  } else {
    delete target.technologyUsages
    delete target.technologyUsageOrder
  }

  const icon = target.iconAssignment
  const iconOk = isRecord(icon)
    && (icon.source === 'technology' || icon.source === 'generic')
    && (icon.mode === 'automatic' || icon.mode === 'explicit')
    && typeof icon.displayName === 'string'
    && isOptString(icon.iconLightPath) && isOptString(icon.iconDarkPath)
    && (icon.catalogRevision === undefined || isNum(icon.catalogRevision))
    && (icon.technologyUsageId === undefined || (typeof icon.technologyUsageId === 'string' && !!usages && icon.technologyUsageId in usages))
  if (!iconOk) delete target.iconAssignment
  if (target.icon !== undefined && typeof target.icon !== 'string') delete target.icon

  if (isRecord(target.ownerAssignments) && Object.entries(target.ownerAssignments).every(([key, owner]) => validOwner(owner) && (owner as { id: string }).id === key)) {
    const owners = target.ownerAssignments
    target.ownerAssignmentOrder = isStringArray(target.ownerAssignmentOrder)
      ? target.ownerAssignmentOrder.filter((id) => id in owners)
      : Object.keys(owners)
  } else {
    delete target.ownerAssignments
    delete target.ownerAssignmentOrder
  }
  for (const field of ['ownerTeamIds', 'teamIds']) {
    if (target[field] !== undefined && !isStringArray(target[field])) delete target[field]
  }
  for (const field of ['shortDescription', 'description', 'parentId', 'domainId', 'label']) {
    if (!isOptString(target[field])) delete target[field]
  }
}

function validObject(raw: unknown): C4Object | null {
  if (!isRecord(raw) || !isId(raw.id) || typeof raw.name !== 'string' || !C4_TYPES.has(raw.type as string)) return null
  if (!isPoint(raw.position) || !isSize(raw.size)) return null
  const o = pick(raw, OBJECT_FIELDS) as unknown as C4Object
  o.scope = raw.scope === 'external' ? 'external' : 'internal'
  o.status = STATUSES.has(raw.status as string) ? (raw.status as C4Object['status']) : 'live'
  o.properties = safeProperties(raw.properties)
  Object.assign(o, safeTags(raw))
  const links = safeLinks(raw.links)
  if (links) o.links = links
  else delete o.links
  sanitizeNested(o as unknown as Record<string, unknown>)
  return o
}

function validGroup(raw: unknown): Group | null {
  if (!isRecord(raw) || !isId(raw.id) || typeof raw.name !== 'string' || !Array.isArray(raw.objectIds)) return null
  const g = pick(raw, GROUP_FIELDS) as unknown as Group
  g.objectIds = raw.objectIds.filter(isId)
  g.color = typeof raw.color === 'string' ? raw.color : '#888888'
  Object.assign(g, safeTags(raw))
  if (g.properties !== undefined) g.properties = safeProperties(g.properties)
  if (g.position !== undefined && !isPoint(g.position)) delete g.position
  if (g.size !== undefined && !isSize(g.size)) delete g.size
  for (const field of ['borderWidth', 'fillOpacity'] as const) {
    if (g[field] !== undefined && !isNum(g[field])) delete g[field]
  }
  if (g.borderColor !== undefined && typeof g.borderColor !== 'string') delete g.borderColor
  if (g.type !== undefined && typeof g.type !== 'string') delete g.type
  sanitizeNested(g as unknown as Record<string, unknown>)
  return g
}

function validConnection(raw: unknown): Connection | null {
  if (!isRecord(raw) || !isId(raw.id) || !isId(raw.fromId) || !isId(raw.toId)) return null
  const c = pick(raw, CONNECTION_FIELDS) as unknown as Connection
  c.type = LINE_TYPES.has(raw.type as string) ? (raw.type as Connection['type']) : 'solid'
  if (c.properties !== undefined) c.properties = safeProperties(c.properties)
  if (c.tagAssignments !== undefined || c.tagOrder !== undefined) Object.assign(c, safeTags(raw))
  sanitizeNested(c as unknown as Record<string, unknown>)
  for (const field of ['labelPosition', 'labelOffset', 'fromAnchor', 'toAnchor', 'labelPosition3d', 'labelOffset3d', 'fromAnchor3d', 'toAnchor3d'] as const) {
    if (c[field] !== undefined && !isNum(c[field])) delete c[field]
  }
  if (c.waypoints !== undefined && !(Array.isArray(c.waypoints) && c.waypoints.every(isPoint))) delete c.waypoints
  if (c.waypoints3d !== undefined && !(Array.isArray(c.waypoints3d) && c.waypoints3d.every(isPoint))) delete c.waypoints3d
  return c
}

export function decodeClipboardPayload(json: string): CanvasClipboardPayload | null {
  if (json.length > MAX_PAYLOAD_BYTES) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.app !== 'maplespire' || raw.version !== VERSION) return null
  if (!isId(raw.workspaceKey) || !isId(raw.sourceDiagramId) || !isId(raw.copyId)) return null
  if (!Array.isArray(raw.objects) || !Array.isArray(raw.groups) || !Array.isArray(raw.connections)) return null
  if (!isRecord(raw.placements)) return null

  // One id, one shape: a payload naming an id twice (or an object and a group
  // with one id) would mint two new entities under ONE fresh id on paste.
  const seen = new Set<string>()
  const firstOf = <T extends { id: string }>(entity: T | null): entity is T => {
    if (!entity || seen.has(entity.id)) return false
    seen.add(entity.id)
    return true
  }
  const objects = raw.objects.map(validObject).filter(firstOf)
  const groups = raw.groups.map(validGroup).filter(firstOf)
  const shapeIds = new Set([...objects.map((o) => o.id), ...groups.map((g) => g.id)])
  if (shapeIds.size === 0) return null
  const connections = raw.connections
    .map(validConnection)
    .filter((c): c is Connection => c !== null && shapeIds.has(c.fromId) && shapeIds.has(c.toId))
    .filter(firstOf)
  const placements: Record<string, Placement> = {}
  for (const [id, value] of Object.entries(raw.placements)) {
    if (!shapeIds.has(id) || !isRecord(value) || !isPoint(value.position) || !isSize(value.size)) continue
    const position = value.position as { x: number; y: number }
    const size = value.size as { width: number; height: number }
    placements[id] = { position: { x: position.x, y: position.y }, size: { width: size.width, height: size.height } }
  }
  return {
    app: 'maplespire',
    version: VERSION,
    copyId: raw.copyId,
    workspaceKey: raw.workspaceKey,
    sourceDiagramId: raw.sourceDiagramId,
    objects,
    groups,
    connections,
    placements,
  }
}
