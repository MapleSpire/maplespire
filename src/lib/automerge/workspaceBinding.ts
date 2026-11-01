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
 * place a socket is bound. End to end on a live stack it is driven by
 * e2e/boot/repoint-live-tab.spec.ts, repoint-cached-root.spec.ts and
 * repoint-boot-fallback.spec.ts, through the DEV probe at the bottom of this
 * file (not a second dynamic import, which can resolve to a different module
 * instance after HMR).
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
 * Where a basis came from, which decides what it can vouch for.
 *
 *  - `root-fetch`: `/api/automerge/root` reported a canonical key beside a
 *    root url it resolved FROM that key (`resolveWorkspaceRoot` in
 *    `server/src/landscapes.ts`), so the basis names the workspace of the
 *    documents that root leads to — but only for THAT root url. This rests on
 *    a root url belonging to one version: every writer of `versions.root_url`
 *    mints or forks a fresh root, but no constraint enforces it.
 *  - `root-cache`: the same fact from an EARLIER session. The root fetch's key
 *    is persisted beside the cached root url once that root materializes
 *    (`repo.ts`, `rememberMaterializedRootUrl`), and restored when a boot
 *    resolves the cached root instead of asking the server (server down, or
 *    the boot fallback). It vouches for exactly what `root-fetch` vouches for,
 *    for the root url it was stored with.
 *  - `socket-binding`: the self-arm in `bridge.ts` `onWorkspaceBound` adopted
 *    the first binding frame. That names where the socket is bound, which after
 *    an offline boot from a cached root can be a version an admin repointed to
 *    while the tab was away. Good enough to arm the repoint detector; not
 *    evidence about the documents.
 */
export type ResolvedWorkspaceProvenance =
  | { from: 'root-fetch'; rootUrl: string }
  | { from: 'root-cache'; rootUrl: string }
  | { from: 'socket-binding' }

/**
 * What each ref resolved to, per ref key, and how that was learned.
 *
 * Written from a root resolution or from the binding self-arm, and only for a
 * ref that is actually an alias: a concrete ref resolves to itself and
 * comparing it to a binding would be asking whether V1 is V1.
 */
const resolved = new Map<string, { binding: WorkspaceBinding; provenance: ResolvedWorkspaceProvenance }>()

export function rememberResolvedWorkspace(
  ref: WorkspaceRef,
  canonical: WorkspaceBinding | null | undefined,
  provenance: ResolvedWorkspaceProvenance,
): void {
  if (!canonical || ref.versionId !== CURRENT_VERSION_ID) return
  resolved.set(workspaceRefKey(ref), {
    binding: { landscapeId: canonical.landscapeId, versionId: canonical.versionId },
    provenance,
  })
}

/** The self-arm (`bridge.ts` `onWorkspaceBound`): adopt the socket's binding
 * as the basis when no root fetch supplied one. Its provenance is fixed HERE,
 * not at the call site, so the bridge cannot record a binding as evidence
 * about the documents. */
export function adoptBindingAsBasis(ref: WorkspaceRef, bound: WorkspaceBinding): void {
  rememberResolvedWorkspace(ref, bound, { from: 'socket-binding' })
}

/** The comparison basis, or null when this tab never learned one — an offline
 * boot from the cached root url, for instance. Null means "cannot tell", and a
 * detector that cannot tell must do nothing rather than guess. */
export function resolvedWorkspaceFor(ref: WorkspaceRef): WorkspaceBinding | null {
  return resolved.get(workspaceRefKey(ref))?.binding ?? null
}

/**
 * The CONCRETE workspace that the documents this session booted for `ref`
 * belong to, or null when that cannot be stated.
 *
 * A concrete ref names it. An alias needs a basis from the root fetch that
 * returned the very root this session holds (`bootedRootUrl`: the bridge's
 * root handle url), in this session (`root-fetch`) or persisted beside that
 * root by an earlier one (`root-cache`): a basis adopted from a socket binding,
 * or one recorded beside a different root url (a later boot from the cached
 * root, which another tab may have moved on), describes something else.
 *
 * This is what a reader that must answer about THIS session's documents may
 * ask the server about: a durability decision (the crash replay's witness),
 * the Spotlight's server tier, and every `/api/model/*` read that goes through
 * `workspaceSearchParams`, which would otherwise draw another version's
 * entities over this session's documents. The repoint detector reads
 * `resolvedWorkspaceFor` instead, whose looser basis is enough to notice a
 * disagreement and is not used to prove anything.
 */
export function documentsWorkspaceFor(ref: WorkspaceRef, bootedRootUrl: string | null): WorkspaceRef | null {
  if (ref.versionId !== CURRENT_VERSION_ID) return { landscapeId: ref.landscapeId, versionId: ref.versionId }
  const entry = resolved.get(workspaceRefKey(ref))
  if (!entry || (entry.provenance.from !== 'root-fetch' && entry.provenance.from !== 'root-cache')) return null
  if (entry.provenance.rootUrl !== bootedRootUrl) return null
  if (entry.binding.landscapeId !== ref.landscapeId) return null
  return { landscapeId: entry.binding.landscapeId, versionId: entry.binding.versionId }
}

/**
 * The url of the root this session holds, as `bridge.ts`'s `sessionRootUrl`
 * reports it, for readers that cannot import the bridge: `workspaceParams.ts`
 * is imported BY the bridge (through every module that builds a request), so
 * importing it back would close a cycle. The bridge installs its accessor once,
 * at module load; until then — and in any test that never loads the bridge —
 * this reads null, which `documentsWorkspaceFor` answers with "cannot tell".
 */
let sessionRootUrlSource: () => string | null = () => null

export function installSessionRootUrlSource(source: () => string | null): void {
  sessionRootUrlSource = source
}

export function installedSessionRootUrl(): string | null {
  return sessionRootUrlSource()
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
 * the `landscapeId`/`versionId` of the `/api/model/*` calls that address the
 * active workspace, from `documentsWorkspaceFor` when it can name the
 * documents' workspace and from this hold otherwise (a basis self-armed from a
 * binding names nothing, and the hold still has to reach the reads). A hold
 * that only re-routed the transport would leave those reads asking about the
 * NEW default while the socket talked to the held one — the durable-heads
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

/**
 * The policy. `defer` hands the frame BACK instead of taking it: the module
 * keeps it as it keeps a frame no handler was installed for, until
 * `redeliverWorkspaceBinding` offers it again or a newer frame replaces it.
 * Only a synchronous call counts — the handler has taken the frame once it
 * returns.
 */
export type WorkspaceBindingHandler = (binding: WorkspaceBinding, defer: () => void) => void

let handler: WorkspaceBindingHandler | null = null

/**
 * THE FRAME NO POLICY HAS TAKEN YET, and the transport that sent it.
 *
 * The frame states a LEVEL — "this socket is bound to V", true for as long as
 * the socket lives — but it arrives once per connect, as an edge, and the
 * bridge installs its handler only in `wireConnectionStatus`, at the END of a
 * successful boot. A boot's socket is routed before its root is fetched, so its
 * frame usually lands before there is anyone to tell. Dropping it was harmless
 * only while some later reconnect resent it; the boot FALLBACK does not
 * reconnect (its re-entry routes the same ref, a no-op), so a fallback session
 * whose socket was bound to a repointed default was neither held nor followed —
 * measured 2026-10-29, routing enforced: every document of the cached root
 * refused `workspace-mismatch`, an edit never durable
 * (e2e/boot/repoint-boot-fallback.spec.ts).
 *
 * So the most recent frame nobody took is kept and handed to the next handler
 * installed. One slot, not a queue: one adapter is attached at a time and each
 * frame supersedes the last. Keyed to its SOURCE, because what it states is
 * about that transport only — `forgetWorkspaceBindingFrom` drops it when the
 * router replaces the adapter (`networkRoute.ts`) and when the adapter's socket
 * closes (its reconnect sends a frame of its own). A frame from a superseded
 * transport, replayed into a new session, would compare that session's basis
 * with a socket that no longer exists: after a HOLD and then a reload, the
 * held socket's frame names the held version.
 */
let undelivered: { binding: WorkspaceBinding; source: object } | null = null

/**
 * Point the frame at the policy, and hand it the frame no handler took, if any.
 * Returns the uninstaller.
 *
 * A seam rather than an import so the adapter — which is constructed at module
 * load, long before the bridge exists — does not have to reach into the bridge.
 * Same shape as the server's install seams, and for the same reason.
 *
 * The replay is synchronous: the handler runs inside this call.
 */
export function installWorkspaceBindingHandler(next: WorkspaceBindingHandler | null): () => void {
  handler = next
  deliverUndelivered()
  return () => { handler = null }
}

/** Offer the kept frame to the installed handler again — for a handler that
 * deferred it, once whatever made it defer is over. */
export function redeliverWorkspaceBinding(): void {
  deliverUndelivered()
}

/** `source`'s transport is gone: a frame it sent and nobody took describes
 * nothing that exists any more. A frame from any other source is kept. */
export function forgetWorkspaceBindingFrom(source: object): void {
  if (undelivered?.source === source) undelivered = null
}

/**
 * Deliver a binding. Called from the adapter's message path, so it must never
 * throw into it: a policy fault would otherwise take down the socket's whole
 * inbound handling, which is strictly worse than not noticing a repoint.
 *
 * `source` is the adapter that received it: the key `forgetWorkspaceBindingFrom`
 * retires it by.
 */
let framesSeen = 0
let lastBinding: WorkspaceBinding | null = null

export function noteWorkspaceBinding(binding: WorkspaceBinding, source: object): void {
  // Counted BEFORE the handler check, and outside the try. "A frame arrived"
  // and "something acted on it" are different facts, and the probe must be
  // able to tell them apart.
  framesSeen += 1
  lastBinding = binding
  undelivered = { binding, source }
  deliverUndelivered()
}

function deliverUndelivered(): void {
  const current = handler
  const frame = undelivered
  if (!current || !frame) return
  undelivered = null
  let deferred = false
  try {
    current(frame.binding, () => { deferred = true })
  } catch (error) {
    // Taken, not deferred: a policy that throws on this frame would throw on
    // every re-offer of it too.
    console.warn('[workspace-binding] handler failed', error)
    return
  }
  // Handed back — unless a newer frame arrived while the handler ran. (A
  // handler that retires the frame's own transport must not also defer it:
  // the retirement found the slot empty. The bridge's defers before doing
  // anything.)
  if (deferred && undelivered === null) undelivered = frame
}

/** Test seam only: the handler and the kept frame are module state. */
export function __resetWorkspaceBindingFramesForTest(): void {
  handler = null
  undelivered = null
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
