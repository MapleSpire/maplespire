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

import type { ObjectLink, ObjectLinkValue } from '../types'

export function objectLinkUrl(link: ObjectLinkValue): string {
  return typeof link === 'string' ? link : link.url
}

export function objectLinkLabel(link: ObjectLinkValue): string {
  return typeof link === 'string' ? '' : (link.label ?? '')
}

export function objectLinkDisplayLabel(link: ObjectLinkValue): string {
  return objectLinkLabel(link).trim() || objectLinkUrl(link)
}

/** Keep Automerge values free of undefined properties. */
export function objectLink(url: string, label = ''): ObjectLink {
  return label.trim() ? { url, label } : { url }
}

/** Only web links become anchors. This prevents persisted javascript:/data:
 * values from becoming executable while retaining them as editable text. */
export function safeExternalHref(link: ObjectLinkValue): string | null {
  const raw = objectLinkUrl(link).trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}
