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
 * Workspace-bound document ids.
 *
 * ## Why
 *
 * Admission on the sync path asks "which workspace does this document belong
 * to?". For legacy ids the answer is DERIVED: `docScope`'s walk traverses the
 * workspace's reference graph and writes what it finds into
 * `automerge_document_workspace`, and `resolveDocWorkspace` reads that index.
 * The repair apparatus in `docScope` (`scheduleStaleRepair`, `routeBackfills`,
 * `staleGeneration`, `announceIndexRepaired`) exists because that index can be
 * incomplete for a document the admitting party has not seen referenced yet.
 *
 * Authority should travel with the identity or with the object's NAME rather
 * than be re-derived from the data at admission time (compare Zanzibar,
 * Liveblocks room tokens, Ditto signed ACLs).
 *
 * This module takes the name route: the server mints the document id, binding
 * it to a workspace with a MAC. Admission becomes "recompute the tag over the
 * peer's routed workspace and compare" — O(1), no database read, no graph, and
 * nothing to await. That satisfies the rule "no authorization decision on the
 * inbound sync path may await the resolution of an Automerge document"
 * structurally rather than by deadline-and-deny.
 *
 * ## Format
 *
 *   byte 0        scheme version (MINT_VERSION)
 *   bytes 1..8    nonce, 8 random bytes
 *   bytes 9..23   tag, HMAC-SHA256(key, version ‖ landscapeId ‖ 0 ‖ versionId ‖ 0 ‖ nonce)[0..15]
 *
 * 24 bytes, base58check-encoded by automerge-repo's `binaryToDocumentId`.
 * `isValidDocumentId` imposes no length rule — it only requires that
 * base58check decodes — so this coexists with the 16-byte UUID ids every
 * existing document already has. A legacy id fails `verifyDocumentId` on
 * length before any comparison, which is what makes the fallback to the index
 * unambiguous rather than a guess.
 *
 * The version byte is not decoration: it is the only thing that lets the tag
 * length, the hash, or the bound fields change later without every already
 * minted id becoming unverifiable.
 *
 * ## What this does and does not defend
 *
 * DOES: a peer routed to workspace B cannot present an id minted for workspace
 * A and have it verify, because the tag binds both ids. Forging one requires
 * the key.
 *
 * DOES NOT: stop a workspace's own member from minting as many ids as they
 * like for their own workspace — correct, that is their workspace — and does
 * not authenticate the CONTENT of the document, only its name. Content-level
 * rules stay where they are (`buildWriteCheck`, `isServerManagedRoot`).
 *
 * The key is derived from `AUTH_SECRET` rather than being a new secret to
 * manage, with a distinct HKDF-style info string so that a document id can
 * never be confused with a session token even if one is fed to the other.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { documentIdToBinary, type DocumentId } from '@automerge/automerge-repo'

export const MINT_VERSION = 1
const NONCE_BYTES = 8
const TAG_BYTES = 15
export const MINTED_ID_BYTES = 1 + NONCE_BYTES + TAG_BYTES

/** Upper bound, in characters, on a documentId the verifiers will decode.
 * A minted id encodes to 37-38 characters, a
 * legacy random one to 27-28. 64 leaves generous headroom for a future format
 * while keeping the quadratic base58 decode bounded — see `verifyDocumentId`. */
export const MAX_DOCUMENT_ID_CHARS = 64

/** Distinct from every other use of AUTH_SECRET in this server. */
const KEY_INFO = 'maplespire/document-id-mint/v1'

export interface WorkspaceRef {
  landscapeId: string
  versionId: string
}

/**
 * Keys are derived lazily, never at module load: `AUTH_SECRET` is set per
 * process and the tests supply their own key. Callers never derive from an
 * empty secret — an empty key would make every workspace's tags identical and
 * the binding worthless.
 */
function deriveKey(base: string): Buffer {
  return createHmac('sha256', base).update(KEY_INFO).digest()
}

/**
 * The keys a presented id may have been minted under: the current one, then any
 * retired ones still inside their overlap window.
 *
 * Rotation is why this is a list: verifying under the current secret alone
 * would make every already-minted id return `foreign` after `AUTH_SECRET` is
 * rotated — a permanent hard deny with no index fallback. An id minted under a
 * key that is not ours must be refused, and one minted under a key that WAS
 * ours must be honoured; only the retired keys listed in
 * `AUTH_SECRET_PREVIOUS` (comma-separated) tell them apart.
 *
 * Blank entries are dropped rather than derived: an empty string would produce
 * a real, deterministic key that every deployment shares.
 */
function mintKeys(secret?: string): Buffer[] {
  if (secret) return [deriveKey(secret)]
  const current = process.env.AUTH_SECRET
  const retired = (process.env.AUTH_SECRET_PREVIOUS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  return [current, ...retired].filter((s): s is string => Boolean(s)).map(deriveKey)
}

/**
 * Whether this process can mint or verify at all. The bootstrap family
 * (`bootstrapMint.ts`) names its documents only when this is true, and the
 * minted-orphan reaper REFUSES TO RUN when it is false — with no key every id
 * reads `unminted`, so "verifies against no version" would be vacuously true
 * for every candidate and the reaper would delete on a verdict it never
 * computed. A probe rather than a throw, because both callers need a decision
 * and not a fault.
 */
export function hasMintKey(): boolean {
  return mintKeys().length > 0
}

/**
 * Whether this process can MINT — which needs the CURRENT key, not any key.
 * `hasMintKey` counts retired keys too, because verifying under them is
 * correct; minting under one is not, and `currentMintKey` throws. Gate minting
 * on this, not on `hasMintKey`: a blank `AUTH_SECRET=` beside a populated
 * `AUTH_SECRET_PREVIOUS` would otherwise turn every mint into a 500.
 */
export function hasCurrentMintKey(): boolean {
  return Boolean(process.env.AUTH_SECRET)
}

/** The key new ids are minted under — always the current one, never a retired. */
function currentMintKey(secret?: string): Buffer {
  const keys = mintKeys(secret)
  if (keys.length === 0 || (!secret && !process.env.AUTH_SECRET)) {
    throw new Error(
      'AUTH_SECRET is required to mint workspace-bound document ids (see docs/auth-setup.md)',
    )
  }
  return keys[0]!
}

/** The bytes the tag is computed over. Length-delimited by NUL separators so
 * that ("ab","c") and ("a","bc") cannot collide — a workspace id is opaque and
 * nothing forbids one containing the other's suffix. */
function tagInput(workspace: WorkspaceRef, nonce: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([MINT_VERSION]),
    Buffer.from(workspace.landscapeId, 'utf8'), Buffer.from([0]),
    Buffer.from(workspace.versionId, 'utf8'), Buffer.from([0]),
    nonce,
  ])
}

function tagWith(key: Buffer, workspace: WorkspaceRef, nonce: Buffer): Buffer {
  return createHmac('sha256', key).update(tagInput(workspace, nonce)).digest().subarray(0, TAG_BYTES)
}

/**
 * Mint the raw id bytes for a workspace. The caller is expected to write the
 * `automerge_document_workspace` row in the same transaction — the MAC is what
 * makes admission cheap, the row is what keeps every existing reader (the
 * projector, the residency snapshot, the reference-integrity scan) working
 * without knowing this scheme exists.
 */
export function mintDocumentIdBytes(workspace: WorkspaceRef, secret?: string): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES)
  return Uint8Array.from(Buffer.concat([
    Buffer.from([MINT_VERSION]), nonce, tagWith(currentMintKey(secret), workspace, nonce),
  ]))
}

/** The single wire encoding of a minted id (base64). The mint endpoint's
 * response field (index.ts) and the browser reserve's `atob`
 * (src/lib/automerge/mintedIdReserve.ts) are the two ends of this function;
 * documentIdMint.wire.test.ts drives this encoder to pin the round trip. */
export function encodeMintedIdForWire(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export type MintVerdict =
  /** The id is bound to this workspace by the server's key. Admit. */
  | { kind: 'bound' }
  /** Not a minted id at all — a legacy random one, or a different scheme
   * version. The caller must fall back to the durable index; this is NOT a
   * denial. */
  | { kind: 'unminted' }
  /** A minted id of this version whose tag does not match this workspace.
   * Falling back to the index would be wrong: the id CLAIMS a binding and the
   * binding is not to the workspace asking.
   *
   * From the synchronous `verifyDocumentId` this is the coarse verdict — "not
   * bound to (L, V)". `verifyDocumentIdWithDisplacement` refines it: after the
   * sibling-version scan, `foreign` means INTER-LANDSCAPE — the security
   * boundary — and stays a hard deny. */
  | { kind: 'foreign' }
  /** A minted id whose tag does not match the asking
   * workspace but DOES match a sibling version of the same landscape — the
   * repoint shape: an id minted offline for (L, V1) presented on a socket the
   * server canonicalised to (L, V2) after `setDefaultVersion`. Not an
   * admission and not a denial: the MAC has answered WHICH LANDSCAPE, and
   * intra-landscape version placement belongs to the durable
   * first-owner-wins table, which the route gate consults next. Only
   * `verifyDocumentIdWithDisplacement` produces this. */
  | { kind: 'displaced' }

/** The decoded shape of a well-formed minted id, shared by the synchronous
 * verify and the displaced scan so the two cannot drift on the format. Returns
 * null for anything that is not a version-1 minted id — the same inputs
 * `verifyDocumentId` calls `unminted`. The type/length guard is repeated here
 * on purpose: this helper performs the quadratic decode (see `verifyDocumentId`),
 * so it must be safe to call directly. */
function decodeMintedId(documentId: string): { nonce: Buffer; presented: Buffer } | null {
  if (typeof documentId !== 'string' || documentId.length > MAX_DOCUMENT_ID_CHARS) return null
  // The cast is deliberate: `DocumentId` asserts an already-decoded id, but
  // here the string is whatever a peer sent and decoding is the question.
  // `documentIdToBinary` answers it by returning undefined on failure.
  const raw = documentIdToBinary(documentId as DocumentId)
  if (!raw || raw.length !== MINTED_ID_BYTES) return null
  const bytes = Buffer.from(raw)
  if (bytes[0] !== MINT_VERSION) return null
  return {
    nonce: bytes.subarray(1, 1 + NONCE_BYTES),
    presented: bytes.subarray(1 + NONCE_BYTES),
  }
}

/**
 * Format-only test: is this a well-formed version-1 minted id? No key, no
 * workspace, no verdict about WHICH workspace — that is `verifyDocumentId`.
 *
 * What it separates is server-minted from everything else: a legacy 16-byte
 * UUID id (every browser document created without a reserve, every document
 * predating minting) fails on length. The minted-orphan reaper's safety
 * rests on this split — it never considers a document that could have been
 * born in a browser, whose registry link may still be on its way (the
 * offline-first case `gcOrphanedDocs`' 24 h floor exists for). Same guards as
 * `verifyDocumentId` before the quadratic decode.
 */
export function isMintedDocumentId(documentId: string): boolean {
  return decodeMintedId(documentId) !== null
}

/**
 * Constant-time verification that `documentId` was minted for `workspace`.
 *
 * Returns three outcomes rather than a boolean on purpose. "Not minted" and
 * "minted for someone else" are opposite instructions to the caller — the first
 * says consult the index, the second says do not — and collapsing them into
 * `false` would either break every legacy document or turn a forged id into a
 * lookup that might succeed for the wrong reason.
 */
export function verifyDocumentId(
  workspace: WorkspaceRef,
  documentId: string,
  secret?: string,
): MintVerdict {
  // Asymmetric on purpose: minting without a key THROWS (an empty key makes
  // every workspace's tag identical and the binding worthless), but verifying
  // without one returns `unminted` rather than throwing. This runs inside the
  // sync gate, where an exception is a fault, not a verdict — and it is safe,
  // because with no key configured nothing can have been minted, so falling
  // through to the durable index is the whole truth rather than a downgrade.
  // A forged id falls through too, and the index denies it: it was never
  // claimed.
  //
  // GUARD BEFORE DECODING — this prevents a denial of service.
  // `documentIdToBinary` is `bs58check.decodeUnsafe`, whose inner loop is O(n²)
  // in the input length, and nothing upstream bounds a documentId:
  // `CollectionSynchronizer.onSyncMessage` only checks that it is truthy, and
  // `syncWriteGate`'s `documentId` is the raw CBOR field off the wire. Measured
  // decode cost:
  //
  //     n=1,000  ->    3.6 ms      n=50,000  -> 1,214 ms
  //     n=20,000 ->  193.6 ms      n=100,000 -> 4,458 ms
  //
  // A minted id is 37-38 characters and a legacy one 27-28; anything longer
  // than MAX_DOCUMENT_ID_CHARS cannot be either.
  //
  // The type check matters too: `decodeUnsafe` throws `TypeError: Expected
  // String` for a non-string, and inside the gate an exception is a fault, not
  // a verdict (`stageAwareAccessCheck` awaits the raw check).
  if (typeof documentId !== 'string' || documentId.length > MAX_DOCUMENT_ID_CHARS) {
    return { kind: 'unminted' }
  }
  const keys = mintKeys(secret)
  if (keys.length === 0) return { kind: 'unminted' }
  const decoded = decodeMintedId(documentId)
  if (!decoded) return { kind: 'unminted' }
  // Every key in the overlap window, not just the current one — see `mintKeys`.
  // Lengths are fixed by the format check above, so timingSafeEqual cannot throw.
  for (const key of keys) {
    if (timingSafeEqual(decoded.presented, tagWith(key, workspace, decoded.nonce))) return { kind: 'bound' }
  }
  return { kind: 'foreign' }
}

/**
 * Does `documentId` verify `bound` for ANY of `workspaces`? The minted-orphan
 * reaper's check 6, over every version that exists.
 *
 * One decode and one key derivation for the whole list, not one per
 * candidate: `verifyDocumentId` re-runs both on every call (it is built for
 * one verdict on the admission path), which would cost
 * V × (1 quadratic decode + 2K HMACs) instead of V × K. Same guards, same
 * constant-time compare, same rotation-window semantics.
 * `false` for anything that is not a minted id.
 */
export function verifyDocumentIdAgainstAny(
  documentId: string,
  workspaces: readonly WorkspaceRef[],
  secret?: string,
): boolean {
  if (typeof documentId !== 'string' || documentId.length > MAX_DOCUMENT_ID_CHARS) return false
  const keys = mintKeys(secret)
  if (keys.length === 0) return false
  const decoded = decodeMintedId(documentId)
  if (!decoded) return false
  for (const workspace of workspaces) {
    for (const key of keys) {
      if (timingSafeEqual(decoded.presented, tagWith(key, workspace, decoded.nonce))) return true
    }
  }
  return false
}

/** The shape of the sibling-version list `verifyDocumentIdWithDisplacement`
 * consults on a mismatch: the version ids of ONE landscape. In production this
 * is `WorkspaceDocIndex.listLandscapeVersionIds` — a single-flight, TTL-cached
 * `SELECT id FROM versions WHERE landscape_id = $1 ORDER BY created_at DESC,
 * id LIMIT {DISPLACED_SCAN_MAX_CANDIDATES + 1}` — so a burst of mismatches
 * costs one SQL round trip, not one per message, and a pathological landscape
 * never ships its whole tail across the wire (the +1 row is what keeps the
 * truncation detectable below).
 *
 * ORDER IS PART OF THE CONTRACT: the scan consumes only the first
 * {@link DISPLACED_SCAN_MAX_CANDIDATES} entries, so the source must list
 * candidates newest version first. The displaced shape is "an id minted
 * against the landscape's recently-current default version", so recency keeps
 * the true match inside the cap on a landscape big enough to truncate. */
export type LandscapeVersionsSource = (landscapeId: string) => Promise<readonly string[]>

/**
 * Ceiling on displaced-scan candidates.
 *
 * The scan recomputes the tag over versions-of-the-landscape × mint keys, so a
 * landscape with N versions costs N×K HMACs per scanned mismatch, on the sync
 * thread, synchronously once the list has arrived. The gate's
 * DISPLACED_SCAN_DEADLINE_MS (docScope.ts) does NOT bound that: a deadline
 * stops the wait on the SQL, never a CPU loop already running. This constant
 * bounds the loop itself, independent of what the database contains.
 *
 * Why 500: one HMAC-SHA256 over the ~50-byte tag input costs single-digit
 * microseconds in Node, so the worst case at the cap is
 * 500 × (1 current + a few retired keys) ≈ 1–3 ms, while 500 live versions in
 * ONE landscape (drafts included) is far beyond normal use; the version-list
 * TTL (3 s) means even a mismatch storm re-pays this at most every 3 s per
 * landscape.
 *
 * Past the cap: only the first 500 candidates — newest first, see the source contract above
 * — are scanned; the truncation is counted ({@link displacedScanTruncationsTotal},
 * exported to /metrics by docScope) and warned once a minute per landscape;
 * and a minted sibling beyond the cut verdicts `foreign` — a hard deny that
 * stays LIFTABLE exactly as every other `foreign`: the moment its holder
 * reconnects routed to the version the id was minted for, the O(1) `bound`
 * path admits it without any scan at all.
 */
export const DISPLACED_SCAN_MAX_CANDIDATES = 500

let displacedScanTruncations = 0
/** Process-lifetime truncation counter, exposed as
 * `maplespire_docscope_displaced_scan_truncations_total` (docScope.ts). A
 * non-zero rate is the observable trace of a landscape past the cap — the
 * signal to raise the cap or prune versions BEFORE a repoint onto a beyond-cap
 * version turns into user-visible `foreign` denies. */
export function displacedScanTruncationsTotal(): number {
  return displacedScanTruncations
}

const truncationLoggedAt = new Map<string, number>()
function recordDisplacedScanTruncation(landscapeId: string, candidateCount: number): void {
  displacedScanTruncations += 1
  const now = Date.now()
  if (now - (truncationLoggedAt.get(landscapeId) ?? 0) < 60_000) return
  if (truncationLoggedAt.size > 1_000) truncationLoggedAt.clear()
  truncationLoggedAt.set(landscapeId, now)
  // Production's source SELECT carries `LIMIT cap+1`
  // (docScope.listLandscapeVersionIds), so a count of exactly cap+1 is a
  // floor, not a total. Injected sources (tests) may hand the full list,
  // whose count stays exact.
  const atLeast = candidateCount === DISPLACED_SCAN_MAX_CANDIDATES + 1 ? 'at least ' : ''
  console.warn(
    `[documentIdMint] displaced scan truncated for landscape ${landscapeId}: `
    + `${atLeast}${candidateCount} candidate versions, scanning the ${DISPLACED_SCAN_MAX_CANDIDATES} newest only `
    + '— a minted sibling beyond the cut reads foreign until its holder reconnects on its minted route',
  )
}

/**
 * The four-way verdict.
 *
 * The synchronous `verifyDocumentId` cannot tell two very different peers
 * apart: an id minted for ANOTHER LANDSCAPE (a forgery target, an org
 * boundary — the reason `foreign` is a hard deny) and an id minted for a
 * SIBLING VERSION of the route's own landscape (the repoint shape: a client
 * minted ids while the landscape's default version was V1, worked offline
 * through a `setDefaultVersion(L, V2)`, and reconnected on a socket the server
 * canonicalised to V2). Both mismatch the tag for (L, V_route).
 *
 * This function refines the mismatch WITHOUT changing the id format: recompute
 * the tag over every version of the route's landscape × every key in the
 * rotation overlap window (`mintKeys` — an id minted under a retired-but-
 * declared key must displace exactly like a current-key one, or rotation plus
 * repoint would produce a permanent deny). One match →
 * `displaced`. None → `foreign`, at full precision.
 *
 * Order is load-bearing, twice:
 *
 *  - The DoS guards run FIRST, inside `verifyDocumentId`: length and type
 *    before the quadratic base58 decode, decode before any HMAC. The version
 *    list is only consulted AFTER the id proved to be a well-formed minted id
 *    that mismatched — so a garbage flood costs the attacker the same O(1)
 *    `unminted` it always did, and never a SQL round trip.
 *  - The landscape is ALWAYS the route's own (`workspace.landscapeId`), never
 *    something derived from the candidate list. The tag binds (L, V) jointly,
 *    so even a poisoned or unfiltered candidate list cannot make an
 *    inter-landscape id scan as `displaced` — the recomputed tag would need
 *    the OTHER landscape's bytes, which this function never feeds it.
 *
 * The nominal path is untouched: `bound` and `unminted` return without the
 * list ever being fetched, so this stays O(1) answered-not-consulted at full
 * (L, V) precision, and the scan runs only on the rare mismatch.
 *
 * The `listLandscapeVersionIds` await is SQL (or a cache hit), never an
 * Automerge document — the admission rule forbids awaiting documents on the
 * sync path, not database reads (`resolveDocWorkspace` is the precedent). A
 * rejection propagates to the caller: inside the route gate that is
 * `gateFault`, which converts it into a fail-closed verdict plus a share-policy
 * re-evaluation instead of letting the exception escape.
 */
export async function verifyDocumentIdWithDisplacement(
  workspace: WorkspaceRef,
  documentId: string,
  listLandscapeVersionIds: LandscapeVersionsSource,
  secret?: string,
): Promise<MintVerdict> {
  const verdict = verifyDocumentId(workspace, documentId, secret)
  if (verdict.kind !== 'foreign') return verdict
  // `foreign` implies the decode succeeded a moment ago; the re-decode is
  // bounded (≤ MAX_DOCUMENT_ID_CHARS) and keeps the two functions free to be
  // called independently.
  const decoded = decodeMintedId(documentId)
  if (!decoded) return verdict
  const candidates = await listLandscapeVersionIds(workspace.landscapeId)
  // The candidate ceiling — see DISPLACED_SCAN_MAX_CANDIDATES. An index bound,
  // not a slice: a copy would read the whole oversized list just to drop its
  // tail (the tests count element reads to pin this).
  const scanBound = Math.min(candidates.length, DISPLACED_SCAN_MAX_CANDIDATES)
  if (candidates.length > DISPLACED_SCAN_MAX_CANDIDATES) {
    recordDisplacedScanTruncation(workspace.landscapeId, candidates.length)
  }
  const keys = mintKeys(secret)
  for (let i = 0; i < scanBound; i += 1) {
    const versionId = candidates[i]!
    // The route's own version already failed inside `verifyDocumentId`.
    if (versionId === workspace.versionId) continue
    for (const key of keys) {
      if (timingSafeEqual(
        decoded.presented,
        tagWith(key, { landscapeId: workspace.landscapeId, versionId }, decoded.nonce),
      )) {
        return { kind: 'displaced' }
      }
    }
  }
  return { kind: 'foreign' }
}
