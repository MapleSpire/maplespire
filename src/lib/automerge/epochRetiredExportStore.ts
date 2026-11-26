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

import { workspaceKvStore } from '../modelQuery/kvStore'
import type { RetiredExport } from './epochRetiredDiff'

/**
 * The `epoch-retired` export, PERSISTED (G4-16f). What a retired document's
 * local copy held that the new
 * epoch does not is offered in the banner; the copy itself is then never
 * read again (a retired document is never forwarded, an unlisted one leaves
 * the queue). Held in memory only, a reload, a crash or a closed window
 * before "Export" lost those offline edits in silence. So the export is
 * written into the workspace's KV store BEFORE the document is let go, stays
 * there until the user exports it or dismisses it (confirmed), and the boot
 * raises the banner again from it.
 */
export const RETIRED_EXPORT_KEY = 'epoch-retired-export:v1'

const entryKey = (d: { kind: string; id: string }) => `${d.kind}\u0000${d.id}`

/** `next` merged into `shown`: one line per entity, the one shown FIRST
 * kept (it is the copy the user may already have read). Either may be
 * absent; the metaUrl and the date are the first export's. */
export function mergeRetiredExports(shown: RetiredExport | null | undefined, next: RetiredExport): RetiredExport {
  if (!shown || shown.differences.length === 0) return { ...next, metaUrl: next.metaUrl || shown?.metaUrl || '' }
  const seen = new Set(shown.differences.map(entryKey))
  return {
    version: 1,
    metaUrl: shown.metaUrl || next.metaUrl,
    collectedAt: shown.collectedAt,
    differences: [...shown.differences, ...next.differences.filter((d) => !seen.has(entryKey(d)))],
  }
}

function isRetiredExport(value: unknown): value is RetiredExport {
  const v = value as Partial<RetiredExport> | undefined
  return !!v && v.version === 1 && typeof v.collectedAt === 'string' && Array.isArray(v.differences)
}

/** Merge `next` into the persisted export, ATOMICALLY (two tabs of the
 * workspace may both offer one); the merged export is returned. Rejects
 * when the store cannot be written: the caller then keeps what it would
 * have let go. */
export async function persistRetiredExport(next: RetiredExport): Promise<RetiredExport> {
  let merged = next
  await workspaceKvStore().update<RetiredExport>(RETIRED_EXPORT_KEY, (stored) => {
    merged = mergeRetiredExports(isRetiredExport(stored) ? stored : null, next)
    return merged
  })
  return merged
}

/** The persisted export, or null (none, unreadable, or empty). */
export async function loadRetiredExport(): Promise<RetiredExport | null> {
  let stored: unknown
  try {
    stored = await workspaceKvStore().get<unknown>(RETIRED_EXPORT_KEY)
  } catch {
    return null
  }
  return isRetiredExport(stored) && stored.differences.length > 0 ? stored : null
}

/** `stored` minus the lines of `shown` (by entity). Pure, exported for its
 * tests. */
export function withoutRetiredLines(stored: RetiredExport | null | undefined, shown: RetiredExport): RetiredExport {
  const gone = new Set(shown.differences.map(entryKey))
  const kept = (stored?.differences ?? []).filter((d) => !gone.has(entryKey(d)))
  return { version: 1, metaUrl: stored?.metaUrl ?? shown.metaUrl, collectedAt: stored?.collectedAt ?? shown.collectedAt, differences: kept }
}

/**
 * Dismissed: ONLY the lines `shown` showed leave the persisted copy, in one
 * atomic update. Another tab of the workspace may have merged its own export into
 * the key since this banner read it — and dequeued what it merged, the
 * persisted copy being its only one: deleting the whole key lost it. What
 * remains is raised again at the next boot. An emptied copy stays as an
 * empty export (`loadRetiredExport` reads it as none): `update` cannot
 * delete, and a `del` after it would race the next merge.
 */
export async function removeRetiredExportLines(shown: RetiredExport): Promise<void> {
  try {
    await workspaceKvStore().update<RetiredExport>(RETIRED_EXPORT_KEY, (stored) =>
      withoutRetiredLines(isRetiredExport(stored) ? stored : null, shown))
  } catch {
    // No store (a private window): there is nothing persisted to clear.
  }
}
