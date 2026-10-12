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

import type { AuthUser } from '../auth/api'

export const DIAGRAM_PRESENCE_CHANNEL = 'maplespire.diagram-presence' as const
export const DIAGRAM_PRESENCE_VERSION = 1 as const
export const PRESENCE_HEARTBEAT_MS = 15_000
export const PRESENCE_PEER_TTL_MS = 45_000
export const PRESENCE_CURSOR_INTERVAL_MS = 80

export type DiagramPresenceView = '2d' | '3d'

export interface DiagramPresenceCursor {
  x: number
  y: number
  view: DiagramPresenceView
  visible: boolean
}

export interface DiagramPresenceIdentity {
  participantId: string
  firstName: string
  initials: string
}

export interface DiagramPresenceClientMessage {
  channel: typeof DIAGRAM_PRESENCE_CHANNEL
  version: typeof DIAGRAM_PRESENCE_VERSION
  kind: 'state' | 'cursor' | 'heartbeat' | 'goodbye'
  sequence: number
  cursor?: DiagramPresenceCursor | null
}

export interface DiagramPresenceServerMessage extends DiagramPresenceClientMessage {
  participant: DiagramPresenceIdentity
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000
}

export function parseDiagramPresenceServerMessage(value: unknown): DiagramPresenceServerMessage | null {
  if (!plainObject(value)) return null
  if (value.channel !== DIAGRAM_PRESENCE_CHANNEL || value.version !== DIAGRAM_PRESENCE_VERSION) return null
  if (value.kind !== 'state' && value.kind !== 'cursor' && value.kind !== 'heartbeat' && value.kind !== 'goodbye') return null
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) return null
  if (!plainObject(value.participant)) return null
  const { participant } = value
  if (typeof participant.participantId !== 'string' || !/^p_[a-f0-9]{16}$/u.test(participant.participantId)) return null
  if (typeof participant.firstName !== 'string' || participant.firstName.length < 1 || participant.firstName.length > 32) return null
  if (typeof participant.initials !== 'string' || participant.initials.length < 1 || participant.initials.length > 4) return null

  const cursorValue = value.cursor
  let cursor: DiagramPresenceCursor | null | undefined
  if (cursorValue === null) {
    cursor = null
  } else if (cursorValue !== undefined) {
    if (!plainObject(cursorValue)) return null
    if (!boundedCoordinate(cursorValue.x) || !boundedCoordinate(cursorValue.y)) return null
    if (cursorValue.view !== '2d' && cursorValue.view !== '3d') return null
    if (typeof cursorValue.visible !== 'boolean') return null
    cursor = {
      x: cursorValue.x,
      y: cursorValue.y,
      view: cursorValue.view,
      visible: cursorValue.visible,
    }
  }
  if ((value.kind === 'cursor' || value.kind === 'state') && cursor === undefined) return null
  if ((value.kind === 'heartbeat' || value.kind === 'goodbye') && cursor !== undefined) return null

  return {
    channel: DIAGRAM_PRESENCE_CHANNEL,
    version: DIAGRAM_PRESENCE_VERSION,
    kind: value.kind,
    sequence: value.sequence as number,
    participant: {
      participantId: participant.participantId,
      firstName: participant.firstName,
      initials: participant.initials,
    },
    ...(cursor !== undefined ? { cursor } : {}),
  }
}

async function sha256Hex(value: string): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fallbackHash(value: string): string {
  let left = 0x811c9dc5
  let right = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    left = Math.imul(left ^ code, 0x01000193) >>> 0
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0
  }
  return `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`
}

/** Matches the server's opaque SHA-256 participant id without exposing the
 * authenticated user id to other collaborators. */
export async function participantIdForUser(userId: string): Promise<string> {
  const input = `maplespire-presence-v1:${userId}`
  return `p_${(await sha256Hex(input))?.slice(0, 16) ?? fallbackHash(input)}`
}

function cleanFirstName(value: string): string {
  return value.replace(/\p{Cc}/gu, '').trim().slice(0, 32)
}

export async function localPresenceIdentity(user: AuthUser | null): Promise<DiagramPresenceIdentity> {
  const userId = user?.id ?? 'anonymous-local'
  const emailLocalPart = user?.email?.trim().split('@')[0]?.split(/[._+-]/u)[0]
  const emailFirstName = emailLocalPart
    ? `${emailLocalPart.charAt(0).toLocaleUpperCase()}${emailLocalPart.slice(1)}`
    : undefined
  const nameCandidate = user?.givenName?.trim()
    || user?.name?.trim().split(/\s+/u)[0]
    || emailFirstName
    || 'Guest'
  const firstName = cleanFirstName(nameCandidate) || 'Guest'
  return {
    participantId: await participantIdForUser(userId),
    firstName,
    initials: Array.from(firstName)[0]?.toLocaleUpperCase() ?? 'G',
  }
}

export function clientPresenceMessage(
  kind: DiagramPresenceClientMessage['kind'],
  sequence: number,
  cursor?: DiagramPresenceCursor | null,
): DiagramPresenceClientMessage {
  return {
    channel: DIAGRAM_PRESENCE_CHANNEL,
    version: DIAGRAM_PRESENCE_VERSION,
    kind,
    sequence,
    ...(cursor !== undefined ? { cursor } : {}),
  }
}
