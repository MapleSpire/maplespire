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

/**
 * WHICH WORKSPACE IS THIS TAB ACTUALLY ON.
 *
 * `versionId: 'current'` is a MOVING pointer, and this tab puts it on the sync
 * url verbatim. So the server re-resolves it on every upgrade, and after an
 * admin repoints the landscape's default version the next reconnect binds this
 * socket to a DIFFERENT workspace than the one this tab's documents belong to.
 * Every document the tab holds is then denied `workspace-mismatch`,
 * permanently, and everything the user does afterwards is lost while the sync
 * badge reads "Saving…".
 *
 * Two facts are needed to notice that, and this module holds both:
 *
 *  - the CONCRETE version this tab resolved when it booted
 *    (`rememberResolvedWorkspace`, fed from `/api/automerge/root`, which
 *    returns the canonical key);
 *  - the workspace the server says it bound the current socket to
 *    (`parseWorkspaceBindingFrame`, fed from the adapter on every connect).
 *
 * The second deliberately does NOT come from asking the server to resolve
 * `current` again. That answers "what would a fresh lookup return", not "what
 * did THIS socket bind" — and the two diverge for as long as any cache holds,
 * which is precisely the window the defect lives in. Under a multi-cell router
 * they are resolved in different processes entirely.
 *
 * The POLICY — what to do when they disagree — is not here. It needs the
 * bridge's view of what is still unsaved, so it lives there and arrives through
 * `installWorkspaceBindingHandler`.
 *
 * Every piece below is unit-tested and the server's half is wired at the one
 * place a socket is bound. The client half arming and firing end to end on a
 * live stack is not yet confirmed; use the DEV probe at the bottom of this file
 * (not a second dynamic import, which can resolve to a different module
 * instance after HMR) to observe it.
 */

import { CURRENT_VERSION_ID, workspaceRefKey, type WorkspaceRef } from './workspace'

/**
 * Must equal `WORKSPACE_BINDING_TYPE` in
 * `server/src/syncCells/workspaceBinding.ts`. A copy, because the two packages
 * do not share a module — and a copy that drifts would make the detector stop
 * recognising the frame SILENTLY, which is the failure this whole file exists
 * to prevent.
 *
 * `workspaceBinding.conformance.test.ts` imports the server's constant and
 * asserts they are the same string, then drives the server's real encoder into
 * the real adapter, so two assertions go red on a drift — the equality and the
 * round trip.
 */
export const WORKSPACE_BINDING_TYPE = 'maplespire.workspace-binding'

export interface WorkspaceBinding {
  landscapeId: string
  versionId: string
}

/** The frame, or null for anything else on the wire. */
export function parseWorkspaceBindingFrame(value: unknown): WorkspaceBinding | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<WorkspaceBinding> & { type?: unknown }
  if (candidate.type !== WORKSPACE_BINDING_TYPE) return null
  if (typeof candidate.landscapeId !== 'string' || !candidate.landscapeId) return null
  if (typeof candidate.versionId !== 'string' || !candidate.versionId) return null
  return { landscapeId: candidate.landscapeId, versionId: candidate.versionId }
}

/**
 * What each ref resolved to, per ref key.
 *
 * Only ever written from a root resolution, and only for a ref that is actually
 * an alias: a concrete ref resolves to itself and comparing it to a binding
 * would be asking whether V1 is V1.
 */
const resolved = new Map<string, WorkspaceBinding>()

export function rememberResolvedWorkspace(
  ref: WorkspaceRef,
  canonical: WorkspaceBinding | null | undefined,
): void {
  if (!canonical || ref.versionId !== CURRENT_VERSION_ID) return
  resolved.set(workspaceRefKey(ref), canonical)
}

/** The comparison basis, or null when this tab never learned one — an offline
 * boot from the cached root url, for instance. Null means "cannot tell", and a
 * detector that cannot tell must do nothing rather than guess. */
export function resolvedWorkspaceFor(ref: WorkspaceRef): WorkspaceBinding | null {
  return resolved.get(workspaceRefKey(ref)) ?? null
}

/**
 * Drop a ref's basis, so the detector reads "cannot tell" until a fresh root
 * resolution supplies a new one.
 *
 * The FOLLOW branch needs this and it is not cosmetic. Following re-resolves
 * `current`, which reconnects, which produces another binding frame — and that
 * frame can arrive before the root fetch has written the new basis. Comparing
 * the new binding against the OLD basis would disagree a second time and follow
 * again, forever. Clearing the basis first makes the intervening frames inert.
 */
export function forgetResolvedWorkspace(ref: WorkspaceRef): void {
  resolved.delete(workspaceRefKey(ref))
}

/** Test seam only — module state outlives a test file otherwise. */
export function __resetResolvedWorkspacesForTest(): void {
  resolved.clear()
}

/**
 * THE HOLD: where this session's transport is pointed when it differs from the
 * ref the user is following. Null whenever they agree, which is almost always.
 *
 * A repoint under an open tab with unsaved work re-points the socket at the
 * concrete version the tab was already editing, WITHOUT moving the ref — moving
 * it would orphan the intent journals, which are keyed by ref, and lose the
 * very work the hold exists to protect.
 *
 * But the ref addresses more than the socket. `workspaceSearchParams()` builds
 * the `landscapeId`/`versionId` on every `/api/model/*` call from it, so a hold
 * that only re-routed the transport would leave every HTTP read asking about
 * the NEW default while the socket talked to the held one — the durable-heads
 * acknowledgement would never resolve and the badge would sit on "Saving…"
 * with everything already durable.
 *
 * So the hold is expressed ONCE, here, and read by both sides: the adapter's
 * route and the HTTP params. Two consumers, one value; not two sources of truth.
 */
let held: WorkspaceBinding | null = null

export function holdWorkspaceOn(binding: WorkspaceBinding | null): void {
  held = binding
}

/** What the tab is ACTUALLY on: the ref, unless a hold re-pointed it. A hold
 * only ever applies to an ALIAS ref in its own landscape — a concrete ref names
 * its own version and nothing may override that. */
export function effectiveWorkspaceRef(ref: WorkspaceRef): WorkspaceRef {
  if (!held) return ref
  if (ref.landscapeId !== held.landscapeId || ref.versionId !== CURRENT_VERSION_ID) return ref
  return { landscapeId: held.landscapeId, versionId: held.versionId }
}

export function heldWorkspace(): WorkspaceBinding | null {
  return held
}

export type WorkspaceBindingHandler = (binding: WorkspaceBinding) => void

let handler: WorkspaceBindingHandler | null = null

/**
 * Point the frame at the policy. Returns the uninstaller.
 *
 * A seam rather than an import so the adapter — which is constructed at module
 * load, long before the bridge exists — does not have to reach into the bridge.
 * Same shape as the server's install seams, and for the same reason.
 */
export function installWorkspaceBindingHandler(next: WorkspaceBindingHandler | null): () => void {
  handler = next
  return () => { handler = null }
}

/**
 * Deliver a binding. Called from the adapter's message path, so it must never
 * throw into it: a policy fault would otherwise take down the socket's whole
 * inbound handling, which is strictly worse than not noticing a repoint.
 */
let framesSeen = 0
let lastBinding: WorkspaceBinding | null = null

export function noteWorkspaceBinding(binding: WorkspaceBinding): void {
  // Counted BEFORE the handler check, and outside the try. "A frame arrived"
  // and "something acted on it" are different facts, and the probe must be
  // able to tell them apart.
  framesSeen += 1
  lastBinding = binding
  const current = handler
  if (!current) return
  try {
    current(binding)
  } catch (error) {
    console.warn('[workspace-binding] handler failed', error)
  }
}

/**
 * DEV/E2E probe (the `__repoFlush` / `__mintedIdSupply` idiom). Not an API.
 *
 * A probe that reaches this module through a dynamic `/src/...` import can,
 * after an HMR pass, get a DIFFERENT module instance with its own state, and
 * cannot distinguish "unarmed" from "wrong copy". A hook installed by the
 * module itself has no such ambiguity: there is exactly one of it, and it is
 * the one the app uses.
 *
 * `framesSeen` is a per-PAGE counter — it goes back to zero with the document,
 * so read it on the near side of any reload rather than as a delta across one.
 */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __workspaceBinding?: unknown }).__workspaceBinding = {
    handlerInstalled: () => handler !== null,
    framesSeen: () => framesSeen,
    lastBinding: () => lastBinding,
    basisFor: (ref: WorkspaceRef) => resolvedWorkspaceFor(ref),
    knownBases: () => Object.fromEntries(resolved),
    // The hold is what an e2e has to tell the two responses apart: a FOLLOW and
    // a HOLD both leave `currentWorkspaceRef()` on the alias, so the ref cannot
    // distinguish them and a test reading it would pass either way.
    held: () => held,
  }
}
