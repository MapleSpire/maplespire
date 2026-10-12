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

import type { IconDefinition } from '../techIcons'

import { API_BASE } from '../api/base'

interface IconPayload {
  name: string
  packs?: string[]
  compatibleWith: IconDefinition['compatibleWith']
  iconLight?: string
  iconDark?: string
  framework?: string[]
  protocol?: string[]
}

export interface IconPage {
  icons: IconDefinition[]
  nextCursor: string | null
  total: number
}

function toIconDefinition(icon: IconPayload): IconDefinition {
  const words = icon.name.trim().split(/\s+/)
  const abbr = words.length > 1
    ? words.slice(0, 2).map((word) => word[0]).join('').toUpperCase()
    : icon.name.slice(0, 2).toUpperCase()
  return {
    ...icon,
    bg: '#64748B',
    text: '#FFFFFF',
    abbr,
    packs: ['All', ...(icon.packs ?? [])],
  }
}

async function json<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { credentials: 'include', signal })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message
      : `Icon catalog request failed: HTTP ${response.status}`
    throw new Error(message)
  }
  return body as T
}

export async function getIconPage(options: {
  q?: string
  pack?: string
  after?: string | null
  limit?: number
  signal?: AbortSignal
} = {}): Promise<IconPage> {
  const params = new URLSearchParams()
  if (options.q) params.set('q', options.q)
  if (options.pack && options.pack !== 'All') params.set('pack', options.pack)
  if (options.after) params.set('after', options.after)
  params.set('limit', String(options.limit ?? 50))
  const page = await json<{ icons: IconPayload[]; nextCursor: string | null; total: number }>(
    `/api/icons?${params.toString()}`,
    options.signal,
  )
  return { ...page, icons: page.icons.map(toIconDefinition) }
}

export async function getIconPacks(signal?: AbortSignal): Promise<Array<{ name: string; iconCount: number }>> {
  const result = await json<{ packs: Array<{ name: string; iconCount: number }> }>('/api/icons/packs', signal)
  return result.packs
}
