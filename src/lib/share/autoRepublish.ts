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

import { buildShareSnapshot } from './snapshot'
import { listShares, updateShare } from './api'
import { useModelStore } from '../../stores/modelStore'

/**
 * Keeps "current version" (mode: 'latest') share links pointing at the latest
 * diagram state. A latest link's stored snapshot is re-materialised + PATCHed
 * whenever the shared diagram changes (debounced, while the editor is open) and
 * whenever the Share modal opens. Pinned links are never touched here.
 *
 * The viewer reads a static snapshot, so "live" means "the most recently
 * published snapshot" — re-publishing is what makes the pointer track HEAD.
 */

const REPUBLISH_DEBOUNCE_MS = 2500

/** diagramId → token for enabled 'latest' shares. */
const latestTokens = new Map<string, string>()
/** diagramId → last published snapshot JSON, to skip redundant PATCHes. */
const lastPublished = new Map<string, string>()

let started = false
let unsub: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | null = null

/** The Share modal calls this so the watcher tracks (or stops tracking) a link. */
export function noteLatestShare(diagramId: string, token: string | null, enabled: boolean): void {
  if (token && enabled) latestTokens.set(diagramId, token)
  else latestTokens.delete(diagramId)
}

async function refreshLatestShares(): Promise<void> {
  try {
    const shares = await listShares()
    latestTokens.clear()
    for (const s of shares) {
      if (s.mode === 'latest' && s.enabled && s.diagramId) latestTokens.set(s.diagramId, s.token)
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Re-materialise + PATCH the diagram's latest share if its content changed.
 * Only valid for the ACTIVE diagram (the snapshot builds from the active handle).
 * Returns true if a new snapshot was published.
 */
export async function republishLatest(diagramId: string): Promise<boolean> {
  const token = latestTokens.get(diagramId)
  if (!token) return false
  // Authoritative guard: never overwrite a link that isn't a live current-version
  // one. The local cache can drift from the server when a link is pinned or
  // disabled concurrently (e.g. the user pins right after an edit), so confirm
  // against the server before touching the snapshot, and self-heal the cache.
  try {
    const shares = await listShares(diagramId)
    const meta = shares.find((s) => s.token === token)
    if (!meta || meta.mode !== 'latest' || !meta.enabled) {
      latestTokens.delete(diagramId)
      return false
    }
    // Build with the link's own scope (single diagram vs whole landscape).
    const snapshot = await buildShareSnapshot({ rootDiagramId: diagramId, limitToDiagram: meta.limitToDiagram })
    // The build is async — re-check the link wasn't pinned/disabled meanwhile.
    if (latestTokens.get(diagramId) !== token) return false
    const json = JSON.stringify(snapshot)
    if (lastPublished.get(diagramId) === json) return false // unchanged → no PATCH
    await updateShare(token, { snapshot })
    lastPublished.set(diagramId, json)
    return true
  } catch {
    return false
  }
}

export function startShareWatcher(): void {
  if (started) return
  started = true
  void refreshLatestShares()
  unsub = useModelStore.subscribe(() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      const id = useModelStore.getState().currentDiagramId
      if (id) void republishLatest(id)
    }, REPUBLISH_DEBOUNCE_MS)
  })
}

export function stopShareWatcher(): void {
  if (unsub) unsub()
  unsub = null
  if (timer) clearTimeout(timer)
  timer = null
  started = false
}
