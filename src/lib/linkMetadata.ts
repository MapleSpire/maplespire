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

import { apiFetch } from './api/http'

import { API_BASE } from './api/base'

/** Best-effort enrichment. Editing and saving links never depends on the
 * network, which preserves the app's offline-first behaviour. */
export async function fetchLinkMetadataTitle(url: string, signal?: AbortSignal): Promise<string | null> {
  const response = await apiFetch(`${API_BASE}/api/link-metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  })
  if (!response.ok) return null
  const payload = await response.json() as { label?: unknown }
  return typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : null
}
