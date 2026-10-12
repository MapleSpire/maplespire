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

import * as landscapesApi from '../landscapes/api'
import { checkWorkspaceReadAccess, myOrgs } from '../auth/api'
import {
  CURRENT_VERSION_ID,
  primeActiveWorkspaceRef,
  setActiveWorkspaceRef,
  setWorkspaceOrgScope,
  type WorkspaceRef,
} from './workspace'
import { readUrlWorkspaceRef, type UrlWorkspaceTarget } from './urlRef'

/**
 * Prime the active workspace synchronously from a versioned app URL. `main.tsx`
 * calls this before installing background services or mounting React, closing
 * the interval where consumers previously observed a prior tab's persisted ref.
 * The authenticated resolver below remains authoritative for access/fallback.
 */
export function primeBootWorkspaceRef(pathname: string): UrlWorkspaceTarget | null {
  const target = readUrlWorkspaceRef(pathname)
  if (target) primeActiveWorkspaceRef(target.ref)
  return target
}

/**
 * Boot-time workspace resolution for AUTHENTICATED sessions (stage 'dual'/'on').
 *
 * The legacy boot starts the bridge on the localStorage-persisted ref — fine in
 * a single-tenant world, but with org-scoped landscapes a stale/foreign ref
 * 403s at stage 'on' and bricks the boot, and the hardcoded `default/current`
 * fallback IS a foreign workspace for everyone outside the Default Org. So an
 * authenticated boot resolves its ref against the server instead, in order:
 *
 *   1. the PER-ORG persisted ref, iff it still exists in the org's landscape
 *      registry (`GET /api/landscapes` is org-filtered for a session);
 *   2. the org's `defaultLandscapeId` (from `GET /api/me/orgs`), at 'current';
 *   3. the first landscape in the registry, at 'current'.
 *
 * Offline / server unreachable → keep the persisted ref untouched: the bridge's
 * cached-root-URL offline boot handles it from there (offline-first contract).
 * Stage 'off' NEVER calls this — the synchronous legacy path stays byte-identical.
 *
 * `preferredRef` is the ref parsed from a deep-link URL (`/app/landscape/…/version/…`).
 * When present and valid it wins over the persisted ref, so opening a shared
 * link boots directly into that workspace (no boot-then-switch double-load).
 * Ordinary versions are present in the landscape registry; Drafts are not, so
 * their ref is validated through the authoritative workspace-access endpoint.
 * A foreign/inaccessible ref falls through to persisted/default while the route
 * layer surfaces the 403.
 */
export async function resolveBootWorkspaceRef(
  orgId: string | null,
  preferredRef?: WorkspaceRef | null
): Promise<WorkspaceRef> {
  // Keep a synchronously primed URL target active while listLandscapes() is in
  // flight. The returned persisted ref remains available for validated fallback.
  const persisted = setWorkspaceOrgScope(orgId, preferredRef)

  /** The workspace store captured its `ref` at module load — BEFORE the org
   * scope switched the persistence key — so EVERY resolution path must mirror
   * the final ref into it, or the org-band label falls back to "Workspace".
   * Dynamic import — same cycle-avoidance as bridge.ts (workspaceStore →
   * switchWorkspace → bridge). */
  const mirror = (ref: WorkspaceRef): WorkspaceRef => {
    // `bootResolved: true` unblocks workspace-scoped queries that must NOT fire
    // against the pre-resolution `default` placeholder at AUTH=on (they 403 —
    // e.g. EditorToolPill's drafts load). Set here, alongside the real ref, so
    // the flip and the ref update land in the same store write.
    void import('../../stores/workspaceStore').then(({ useWorkspaceStore }) =>
      useWorkspaceStore.setState({ ref, bootResolved: true })
    )
    return ref
  }

  let landscapes: landscapesApi.LandscapeInfo[]
  try {
    landscapes = await landscapesApi.listLandscapes()
  } catch {
    // Offline-first: no registry to validate against — boot the deep-linked ref if
    // one was given (its root URL may be cached locally), else the persisted ref.
    const offlineRef = preferredRef ?? persisted
    if (preferredRef) setActiveWorkspaceRef(preferredRef)
    return mirror(offlineRef)
  }

  const stillExists = (ref: WorkspaceRef): boolean => {
    const l = landscapes.find((x) => x.id === ref.landscapeId)
    if (!l) return false
    return ref.versionId === CURRENT_VERSION_ID || l.versions.some((v) => v.id === ref.versionId)
  }
  // A deep-linked URL ref wins over the persisted one when it's accessible in this org.
  if (preferredRef && stillExists(preferredRef)) {
    setActiveWorkspaceRef(preferredRef)
    return mirror(preferredRef)
  }
  if (preferredRef) {
    // Draft ids intentionally live outside LandscapeInfo.versions. Treat the
    // access endpoint as authoritative for any URL ref absent from that list;
    // 'unknown' keeps the offline-first contract (the cached root may exist),
    // while only an explicit forbidden result permits fallback.
    const access = await checkWorkspaceReadAccess(
      preferredRef.landscapeId,
      preferredRef.versionId,
    )
    if (access !== 'forbidden') {
      setActiveWorkspaceRef(preferredRef)
      return mirror(preferredRef)
    }
  }
  if (stillExists(persisted)) {
    setActiveWorkspaceRef(persisted)
    return mirror(persisted)
  }

  let defaultLandscapeId: string | null = null
  if (orgId) {
    try {
      const orgs = await myOrgs()
      defaultLandscapeId = orgs.find((o) => o.id === orgId)?.defaultLandscapeId ?? null
    } catch {
      // Non-fatal — fall through to "first landscape".
    }
  }

  const target =
    (defaultLandscapeId ? landscapes.find((l) => l.id === defaultLandscapeId) : undefined) ?? landscapes[0]
  if (!target) {
    // Zero visible landscapes (org-less invite-intent session, or an emptied
    // org) — nothing valid to point at; keep the persisted ref and let the
    // bridge surface its normal unavailable-workspace handling.
    setActiveWorkspaceRef(persisted)
    return mirror(persisted)
  }

  const ref: WorkspaceRef = { landscapeId: target.id, versionId: CURRENT_VERSION_ID }
  setActiveWorkspaceRef(ref)
  return mirror(ref)
}
