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

import { accountStorageKey } from '../auth/accountNamespace'

/**
 * WorkspaceRef — the compound addressing key for a single editable workspace.
 *
 * The data model is a spine Organization → Landscape → Version, where everything
 * beneath a Version is version-scoped: every workspace document (root →
 * model/shards → diagrams) is addressed by BOTH a `landscapeId` and a
 * `versionId`. Call sites resolve documents through a ref; the active one comes
 * from `currentWorkspaceRef()`.
 */
export interface WorkspaceRef {
  landscapeId: string
  versionId: string
}

/** The implicit default landscape (single-workspace installs use only this). */
export const DEFAULT_LANDSCAPE_ID = 'default'

/** The live, editable "current" version (vs named/frozen versions). */
export const CURRENT_VERSION_ID = 'current'

/** The default workspace: the default landscape at its current version. The
 * ACTIVE workspace is `currentWorkspaceRef()`, which may differ. */
export const DEFAULT_WORKSPACE_REF: WorkspaceRef = {
  landscapeId: DEFAULT_LANDSCAPE_ID,
  versionId: CURRENT_VERSION_ID,
}

/** Stable, collision-free key for caching handles/promises per workspace. Ids are
 * app-level slugs that never contain '/', so a '/'-joined key is unambiguous. */
export function workspaceRefKey(ref: WorkspaceRef): string {
  return `${ref.landscapeId}/${ref.versionId}`
}

export function workspaceRefEquals(a: WorkspaceRef, b: WorkspaceRef): boolean {
  return a.landscapeId === b.landscapeId && a.versionId === b.versionId
}

/** True for the default workspace — lets the resolver keep the legacy path
 * (bare server endpoint, legacy localStorage key) for existing installs. */
export function isDefaultWorkspaceRef(ref: WorkspaceRef): boolean {
  return workspaceRefEquals(ref, DEFAULT_WORKSPACE_REF)
}

// The active workspace ref — the single source of truth every call site reads via
// `currentWorkspaceRef()`. Persisted to localStorage so a reload reopens the same
// landscape/version. Initialised from storage (or the default on first ever load).
//
// PERSISTENCE IS PER-ORG once auth is active: each org gets its own storage key
// (`maplespire:workspaceRef:<orgId>`) so switching orgs can never leak one org's
// last-open landscape into another org's session (a foreign ref would 403 at
// stage 'on' and brick the boot). The legacy un-suffixed key is kept EXACTLY
// as-is for stage 'off' / signed-out sessions — the AUTH=off boot path stays
// byte-identical (bootRef.ts is the only caller of setWorkspaceOrgScope).
const ACTIVE_REF_KEY = 'maplespire:workspaceRef'

let orgScope: string | null = null

function activeRefKey(): string {
  // Per user too (accountNamespace.ts): two members of one org on a browser,
  // or a signed-out page, must not hand each other a last-open landscape.
  return accountStorageKey(orgScope ? `${ACTIVE_REF_KEY}:${orgScope}` : ACTIVE_REF_KEY)
}

function readPersistedRef(): WorkspaceRef {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(activeRefKey()) : null
    if (raw) {
      const p = JSON.parse(raw) as Partial<WorkspaceRef>
      if (typeof p?.landscapeId === 'string' && typeof p?.versionId === 'string') {
        return { landscapeId: p.landscapeId, versionId: p.versionId }
      }
    }
  } catch {
    /* corrupt/unavailable storage — fall back to the default */
  }
  return DEFAULT_WORKSPACE_REF
}

let activeRef: WorkspaceRef = readPersistedRef()
type WorkspaceRefListener = (ref: WorkspaceRef) => void
const workspaceRefListeners = new Set<WorkspaceRefListener>()

/** Scope workspace-ref persistence to an org (auth boots only — see the key
 * comment above). Returns the scoped persisted ref so boot resolution can still
 * validate/fall back to it. When a URL ref was synchronously primed, keep that
 * ref active while the authenticated registry request is in flight: reverting
 * to the previous tab's persisted ref in that interval lets mounted consumers
 * issue cross-workspace requests before the deep link wins again. */
export function setWorkspaceOrgScope(
  orgId: string | null,
  preferredRef?: WorkspaceRef | null,
): WorkspaceRef {
  orgScope = orgId
  const persisted = readPersistedRef()
  activeRef = preferredRef ?? persisted
  return persisted
}

/**
 * Seed the URL workspace before React, background polling, or any request builder
 * starts. This intentionally does not persist or notify: authenticated boot still
 * validates the target and writes it under the correct org-scoped key; stage-off
 * boot persists it through its existing `setActiveWorkspaceRef` path.
 */
export function primeActiveWorkspaceRef(ref: WorkspaceRef): void {
  activeRef = ref
}

/**
 * The workspace the app is currently pointed at — the single read point for every
 * caller (repo handle caches, the bridge, version capture, …). Defaults to the
 * 'default' landscape's 'current' (default) version until the user switches.
 */
export function currentWorkspaceRef(): WorkspaceRef {
  return activeRef
}

/** Observe active workspace switches without coupling long-lived background
 * services to the React workspace store. The current ref is deliberately not
 * emitted on subscription; callers can read it synchronously first. */
export function subscribeWorkspaceRef(listener: WorkspaceRefListener): () => void {
  workspaceRefListeners.add(listener)
  return () => workspaceRefListeners.delete(listener)
}

/** Point the app at a workspace (persisted). The caller is responsible for the
 * bridge restart + store reset that actually loads it (see switchWorkspace). */
export function setActiveWorkspaceRef(ref: WorkspaceRef): void {
  const changed = !workspaceRefEquals(activeRef, ref)
  activeRef = ref
  if (changed) {
    for (const listener of workspaceRefListeners) {
      try {
        listener(ref)
      } catch (error) {
        console.warn('[workspace] active-ref listener failed', error)
      }
    }
  }
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(activeRefKey(), JSON.stringify(ref))
  } catch {
    /* private mode / quota — non-fatal, just no persistence */
  }
}
