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

import type { WorkspaceKey } from './projector.js'

/**
 * THE PROTOCOL PARTICIPANT MARKER (G4-16f): a SESSION setting every
 * connection of a process of this version carries, set by
 * `guardIdleClientErrors` (`db/poolErrorGuard.ts`) on every physical
 * connection of every pool — the one function every pg pool of the server
 * enters through, which `db/poolErrorGuard.test.ts` enforces by a source
 * scan (pools, and a bare `pg.Client` in production code).
 *
 * Its value is the PROTOCOL VERSION of the process: an integer, this
 * version writes {@link READ_MODEL_PROTOCOL_VERSION}. The protocol tables'
 * statement trigger (`schema.ts`, `ADOPT_PROTOCOL_TOUCHED_BODY`) parses it
 * ({@link PARTICIPANT_VERSION_SQL}: anything but 1-9 decimal digits, the
 * empty string and an absent setting are version 0, a non-participant) and
 * applies each rule only to a connection whose version is at least the one
 * that introduced the rule — THE LOCK ORDER (`adoptState.ts`) since
 * {@link LOCK_ORDER_RULE_SINCE}. Without it the trigger still keeps the
 * adopt digests, and does not refuse: a process that does not know the
 * protocol — the previous release, whose writers write the
 * retirement row and THEN assert the fence) still running against a
 * database this version has booted on, during a rolling deploy or after a
 * rollback — is never refused by a trigger it never installed.
 *
 * THE FORWARD CONTRACT. Every function body this version installs is
 * tagged with its version (`COMMENT ON FUNCTION … IS
 * '{@link PROTOCOL_TAG_PREFIX}2'`), and a boot never replaces a body tagged
 * with a HIGHER version (`schema.ts`, `ensureFunction`): a rollback from a
 * later version keeps the later bodies, which this version's connections
 * (marker 2) then run. So a later version's bodies must refuse nothing a
 * version-2 participant does — its lock order must be a superset-compatible
 * extension of this one — or the stricter rule must be introduced at a NEW
 * version number and gated on `version >= <that number>`, so a version-2
 * connection is judged by the version-2 rules only. Same for every earlier
 * rule: it applies to every version at or above its own.
 *
 * The tag is part of the same contract. A later version MUST write the
 * `COMMENT` tag in the SAME transaction as the body replacement, under the
 * SAME transaction-scoped advisory lock (`hashtextextended(
 * 'maplespire:read-model-protocol-functions', 0)`, `schema.ts`,
 * `ensureFunction`), re-reading the tag under it: a body replaced without
 * its tag, or tagged outside that lock, can be overwritten by a concurrent
 * boot of a lower version. The tag is read ANCHORED — the comment must be
 * exactly `maplespire-protocol=<digits>`, anything else is untagged.
 * OPERATORS must never `COMMENT ON` these functions: a hand-written tag
 * would freeze a body (a higher number) or hand it to the next boot to
 * replace. (Earlier, unreleased G4-16f builds replaced these bodies without
 * re-tagging them; a database one of them booted on carries untagged or
 * stale-tagged bodies, which this version replaces as older.)
 *
 * Why the pool and not the fence assertion: the marker must be on a
 * connection whether or not its transaction took the fence, so that a
 * writer of THIS version that omits `assertReadModelWriteFence` is still
 * refused. Set by the assertion itself, omitting the assertion would omit
 * the marker and admit the write. A pool cannot be built without it
 * (`guardIdleClientErrors` is mandatory); a bare `pg.Client` opened by hand
 * is a non-participant, which is how the tests simulate the old version.
 *
 * FAIL CLOSED ON A LOST MARKER. The marker is session state, set once per
 * physical connection, and a session reset removes it for the rest of that
 * connection's life: `RESET ALL`, `DISCARD ALL` and `SET … = ''` drop it
 * (measured by tests), and a transaction-mode
 * PgBouncer cannot be relied on to carry it (the session a SET lands on
 * need not be the one the next transaction runs on). A write on such a connection would be silently
 * unenforced, so `assertReadModelWriteFence` (`health.ts`), which every
 * writer of this version calls, REFUSES with
 * {@link ReadModelProtocolMarkerError} when the connection's version is
 * below {@link LOCK_ORDER_RULE_SINCE}. Develop's writers never call it.
 *
 * THE DEPLOYMENT REQUIREMENT that follows: read-model writers need a DIRECT
 * PostgreSQL connection or a SESSION-mode pooler, and no session-reset
 * query while a pool connection is in use — no `DISCARD ALL` / `RESET ALL`
 * from code, no transaction or statement pooling, no PgBouncer
 * `server_reset_query_always`. (PgBouncer's `server_reset_query` in session
 * mode runs when our client disconnects; the pool's next connection is a
 * new client and is marked again.)
 *
 * OPERATOR FOOTGUN: never `ALTER ROLE … SET` or `ALTER DATABASE … SET`
 * this setting (nor put it in a startup option or `postgresql.conf`). It
 * would mark every connection of that role or database — the previous
 * release's too — as a participant, and the trigger would then refuse its
 * write-then-fence writers, the very rollback this marker exists to admit.
 * A transaction-mode pooler shared by both versions can leak this version's
 * session SET onto a server connection a previous-release client later uses, with
 * the same effect: one more reason the requirement above is not optional.
 */
export const READ_MODEL_PROTOCOL_SETTING = 'maplespire.read_model_protocol'
/** The protocol version this process writes into the marker and tags its
 * function bodies with. */
export const READ_MODEL_PROTOCOL_VERSION = 2
/** The version that introduced THE LOCK ORDER (`adoptState.ts`): the
 * trigger enforces it on connections whose version is at least this. */
export const LOCK_ORDER_RULE_SINCE = 2
/** The prefix of the version tag on every protocol function body
 * (`COMMENT ON FUNCTION`), followed by the decimal version. */
export const PROTOCOL_TAG_PREFIX = 'maplespire-protocol='

/** This connection's protocol version, as an SQL integer expression: the
 * marker when it is 1-9 decimal digits, else 0 (absent, empty, or anything
 * else — a non-participant). Read by the trigger and by the fence
 * assertion, so the two cannot disagree about what a version is. */
export const PARTICIPANT_VERSION_SQL = `(CASE WHEN coalesce(current_setting('${READ_MODEL_PROTOCOL_SETTING}', true), '') ~ '^[0-9]{1,9}$'
  THEN current_setting('${READ_MODEL_PROTOCOL_SETTING}', true)::integer ELSE 0 END)`

/** A writer of this version on a connection that is not (or no longer) a
 * participant of at least {@link LOCK_ORDER_RULE_SINCE}: its protocol
 * writes would not be checked, so it is refused instead. A configuration
 * fault (a session reset, a transaction-mode pooler, a hand-opened client),
 * never an authority loss: it is not a `ReadModelWriteFenceError`. */
export class ReadModelProtocolMarkerError extends Error {
  /** Bounded, snake_case: `last_error_code` fits it. */
  readonly code = 'protocol_marker_missing'
  constructor(key: WorkspaceKey, readonly participantVersion: number) {
    super(
      `read-model write refused for ${key.landscapeId}/${key.versionId}: this connection's protocol marker `
      + `(${READ_MODEL_PROTOCOL_SETTING}) is ${participantVersion === 0 ? 'absent' : `version ${participantVersion}`}, `
      + `below ${LOCK_ORDER_RULE_SINCE}, so the lock order would not be enforced on it. A session reset `
      + '(RESET ALL, DISCARD ALL, SET to empty) or a transaction-mode pooler drops it: read-model writers need a '
      + 'direct or session-mode connection with no session-reset query (protocolParticipant.ts)',
    )
    this.name = 'ReadModelProtocolMarkerError'
  }
}

/** Throws {@link ReadModelProtocolMarkerError} unless `participantVersion`
 * (the value of {@link PARTICIPANT_VERSION_SQL} on the writer's connection)
 * is at least {@link LOCK_ORDER_RULE_SINCE}. */
export function assertProtocolParticipant(key: WorkspaceKey, participantVersion: number): void {
  if (!(participantVersion >= LOCK_ORDER_RULE_SINCE)) throw new ReadModelProtocolMarkerError(key, participantVersion)
}

/**
 * A LOST MARKER ENDS THE CONNECTION. The marker is set once per physical
 * connection (`guardIdleClientErrors`), so a connection that lost it never
 * gets it back: handed back to the pool, it would refuse every later
 * writer that draws it (measured: a pool of one, the same backend
 * pid after `DISCARD ALL`, every writer refused). The fence assertion
 * records the client it refused here, keyed by the client object itself —
 * not carried on the error, which a caller may wrap or replace on its way
 * out — and every site that checks out its own client and can reach the
 * assertion passes `lostMarkerOf(client)` to `release`, which DESTROYS it
 * (pg-pool removes a client released with a truthy argument): the
 * projection transaction (`projectionTransaction.ts`) and every holder of
 * an `overlay-rotation` key — the rotator, the fold writer, the compaction
 * settle — through `releaseOverlayRotationLock` (`overlayRotationLock.ts`).
 * Ending the session also returns any advisory lock it held. A client
 * released clean despite the mark (a site not listed here) stays marked,
 * and the next of those sites to hand it back destroys it.
 */
const lostMarkers = new WeakMap<object, ReadModelProtocolMarkerError>()

/** Records `connection` (a checked-out client, never a pool) as having
 * lost its marker. Called by the fence assertion when it refuses. */
export function recordLostMarker(connection: object, error: ReadModelProtocolMarkerError): void {
  lostMarkers.set(connection, error)
}

/** The refusal recorded for `connection`, if its marker was found lost:
 * the value to `release` it with, so the pool destroys it. */
export function lostMarkerOf(connection: object): ReadModelProtocolMarkerError | undefined {
  return lostMarkers.get(connection)
}
