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

// The verdict of `qa/eviction-peeraware.mjs`, extracted so a test can execute
// it, and founded on witnesses that can be false.
//
// WHY NOT CLIENT HANDLE STATE. "A document a connected client holds open is NOT
// evicted" cannot be proved with `viewed.state === 'ready'`: `DocHandle.state`
// in the pinned 2.6.0-alpha.2 is `deleted` or `ready` and nothing else, and both
// stay `ready` through the server evicting the document. With those conjuncts
// constant the verdict reduces to `after.totalHandles < before.totalHandles` —
// a predicate that gets MORE true the more indiscriminate eviction becomes. (The
// root is skipped by URL at `automergeServer.ts`, so it cannot be evicted
// either way.)
//
// WHY NOT THE CLIENT CACHE. `eviction-check.mts` asks the cache
// (`cachedHandles(repo)`) because it runs IN-PROCESS against its own Repo. Here
// the subject is the SERVER's residency and the handles are a CLIENT's.
//
// WHY NOT `evictionSkippedActivePeer`. That residency counter is incremented
// inside `AutomergeResidencyLeases.evict()` (`automergeResidency.ts`), and
// the idle sweep never calls `evict()` for a peer-held document — it
// short-circuits one frame earlier at `automergeServer.ts`, into a
// SWEEP-LOCAL variable that only reaches the `automerge.idle_eviction` log line.
// Only the lease path (`replaceOwner`/`releaseOwner`) reaches it, and this script
// runs no projector, so a healthy run would read `spared: 0` and fail. Fixtures
// must therefore follow the shapes the server really publishes.
//
// WHAT IS GRADED, and why it can be false. `/api/automerge/stats` publishes
// `synchronizer.documentsWithPeers` — the number of DocSynchronizers holding at
// least one live peer. `evict()` ends in `repo.removeFromCache()`
// (`automergeResidency.ts`), which in the pinned automerge-repo reaches
// `CollectionSynchronizer.detach` and DELETES the DocSynchronizer. So:
//
//   - the orphan has no peer after client A leaves, so evicting it — the correct
//     outcome — does not move `documentsWithPeers` at all;
//   - evicting a document client B is holding DOES move it, downward.
//
// That is the proposition, and it is nearly per-document without asking the
// server for a document identifier. `synchronizer.retiredDocuments` is read as
// the control, because synchronizer retirement is the other path that deletes a
// DocSynchronizer and would otherwise be indistinguishable from a wrong eviction.
//
// ── TWO CONFOUNDERS, AND HOW THEY ARE FENCED ────────────────────────────────
//
// (1) `documentsWithPeers` IS A NET COUNT. One held document wrongly evicted
// while a peer arrives elsewhere in the same window sums to zero. "The script
// connects exactly one client" is a property of the SCENARIO, not of the
// witness, so the precondition is made EXECUTABLE: `/api/automerge/stats`
// publishes `joinedConnections`, and the run VOIDS unless exactly one client
// was connected at both edges of the window. That also catches a browser tab
// left open on the port, which reconnects the instant it rebinds.
//
// `joinedConnections` bounds the number of CLIENTS, but the netting needs no
// second client:
//
//   one client, X wrongly evicted while Z is opened by that same client
//     -> peerBoundDelta 0, peerBindingDelta 0, evicted 1, reasons [], PASSED
//
// Every precondition satisfied, one process, a sweep that ran, no retirement —
// and a document lost. Scale-free: two evictions offset by two opens pass too.
// So the run also pins the client's OWN document set at each edge. That
// narrows the hole rather than closing it (bindings that land late, or a re-bind
// after the sweep, do not move the set — see `eviction-peeraware.mjs`). A
// SET rather than a count, because closing one document and opening another
// holds a count still while the bindings move.
//
// `totalPeerBindings` is graded beside it, but it is NOT an independent
// witness. Both numbers are reductions of the SAME array in
// `lightweightSynchronizerPeerSnapshot` (`automergeTransportTelemetry.ts`):
//
//   documentsWithPeers: peerCounts.filter((count) => count > 0).length
//   totalPeerBindings:  peerCounts.reduce((sum, count) => sum + count, 0)
//
// and `joinedConnections` is `peerToSocket.size` (`auth/wsAuth.ts`) while
// `peerCounts[i]` counts how many of `synchronizer.peers` hold document i. So
// the precondition directly above — void unless exactly ONE client is connected
// — forces every `peerCounts[i]` into {0, 1} and makes the two expressions
// ARITHMETICALLY IDENTICAL. The measured runs say so too: -1/-1 on the broken
// arm, 0/0 on the healthy one, every time.
//
// It is kept as a REDUNDANCY check on the two reductions, which is a real if
// much smaller thing: a defect in either `filter` or `reduce` shows up as a
// disagreement. It is NOT independent evidence — if `docSynchronizers` or
// `peers` ever stops being populated, both go to zero together and neither can
// warn about the other.
//
// (2) A RESTART IS NOT A RUN. Every residency counter is
// cumulative, so a server that restarts mid-window restarts them from zero and
// `after - before` is computed against a base that no longer exists. If the
// fresh process evicts anything at all before the second probe the delta comes
// out POSITIVE and reads as a valid pass — and a restart is exactly what the
// crash this gate exists to catch produces under a supervisor. The residency
// snapshot carries `processBootId` (`src/processIdentity.ts`); two snapshots
// with different ids describe two processes and are not subtractable. Identity,
// not arithmetic.

// ── WHY THIS IS A TABLE AND NOT A FUNCTION BODY ──────────────────────────────
//
// The hard part of this verdict is ORDERING, not the predicates: a void must
// not outrank a server failure (a crash would read as "this run did not
// happen"), an inference must not outrank the void that says its precondition
// is unmet (a foreign browser tab would turn CI red against a healthy server).
// Encoded as the order of a dozen statements, precedence is defended only by
// prose no test can check.
//
// So precedence is DATA here, and three properties fall out that if/else
// chains cannot have:
//
//   1. Every `when` is SELF-SUFFICIENT. It does not rely on an earlier branch
//      having returned or an `else if` having excluded it. Moving a row cannot
//      change what it means, and `peerAwareTableInvariants` asserts the one
//      place where order still decides anything (the terminal rows).
//   2. A kind becomes a verdict in exactly ONE place, `rankOutcome`. There is no
//      second expression anywhere that can disagree with it about precedence.
//   3. Each row is independently testable: deleting one `when` kills a named
//      case, instead of mutating a statement whose meaning depends on the
//      statements above it.
//
// What a table does NOT buy: the rows still have to be RIGHT. Each predicate
// carries its justification with it.

/** How a finding's kind becomes a verdict — the ONLY such rule in this module.
 *
 *  - `server-fact`  a fact about the SUBJECT that holds whether or not any peer
 *                   witness is legible: the server died, restarted, or dropped a
 *                   client this run was holding open. Fails the run AND sets
 *                   `serverFault`.
 *  - `attributable` an INFERENCE from the peer witnesses that no confounder in
 *                   this window can explain. Fails the run; does NOT set
 *                   `serverFault` — a correct detection is not a crash.
 *  - `void`         the run could not be read. Outranked by both of the above,
 *                   because the instrument's doubt must never silence a finding
 *                   about the subject.
 */
const FAILING_KINDS = new Set(['server-fact', 'attributable'])
const FINDING_KINDS = new Set([...FAILING_KINDS, 'void'])

/** The verdict of a finding list: any failing kind -> `failed`, else any void
 * -> `void`, else `passed`. */
export function rankOutcome(findings) {
  if (findings.some((finding) => FAILING_KINDS.has(finding.kind))) return 'failed'
  if (findings.some((finding) => finding.kind === 'void')) return 'void'
  return 'passed'
}

/** Rows that end the run where they fire, because nothing below them is
 * readable once they are true.
 *
 * THIS is the one array whose ORDER still decides something — the first match
 * wins and returns — and it is three rows long, adjacent, with the precedence
 * argument stated on each. */
const TERMINAL_CHECKS = [
  {
    id: 'server-not-alive',
    kind: 'server-fact',
    // FIRST, and returning: a dead server poisons every counter below, and
    // grading it after the deltas would let a void ("this run did not happen")
    // stand in for the one outcome the check exists to catch.
    when: (context) => context.serverAlive !== true,
    reason: (context) =>
      `the server was not healthy after the sweep (serverAlive=${JSON.stringify(context.serverAlive)})`,
  },
  {
    id: 'snapshot-missing',
    kind: 'void',
    when: (context) => !context.before || !context.after || !context.statsBefore || !context.statsAfter,
    reason: () => 'VOID: a snapshot is missing — the run has no before/after to compare',
  },
  {
    id: 'server-restarted',
    kind: 'server-fact',
    // A FAILURE, not a void: a finding is classified by its ORIGIN: "the server did not identify itself"
    // is about the instrument's ability to check, but "the server is a DIFFERENT
    // PROCESS than the one this run started against" is about the SUBJECT — it
    // died and something restarted it.
    //
    // `processIdentity.ts` states the scenario in its own words: a restart is
    // exactly what the crash this gate exists to catch produces under a
    // supervisor. Both committed compose files run the app under `restart:
    // always` / `unless-stopped`, so the sequence is: the sweep evicts a
    // peer-held document, the server dies, the supervisor
    // restarts it inside the 9 s window, `/api/health` answers `ok` by the time
    // the `after` probe runs — so `server-not-alive` does NOT fire — and the
    // boot-id change is the only surviving evidence.
    //
    // TERMINAL, and that is not a style choice: the restart zeroes the counters,
    // so `evicted` comes out negative and would trip the `sweep-did-not-run`
    // void. There is also nothing left to say: every remaining number is a
    // subtraction across two processes.
    //
    // SELF-SUFFICIENT: the disagreement is only meaningful when every snapshot
    // published an identity, so the row says so itself rather than inheriting
    // it from the row above.
    when: (context) => !context.bootIds.some((id) => id === null) && !context.bootIdsAgree,
    reason: (context) =>
      `the server RESTARTED during the window (processBootId ${JSON.stringify(context.bootIds)} across ` +
      'residency-before, residency-after, stats-before, stats-after) — ' +
      'it did not survive, and a supervisor brought it back; the counters restarted from zero with it, ' +
      'so nothing below is readable, but the restart itself is the finding',
  },
]

/** Rows that ACCUMULATE. Each may also mark the peer witnesses unreadable
 * (`netting: false`) or contribute to the confounder capacity (`capacity`), and
 * a row contributes those effects only when it fires.
 *
 * Order here is presentation only — it decides the sequence of `reasons` in the
 * report and nothing else. `peerAwareTableInvariants` pins that. */
const PRECONDITION_CHECKS = [
  {
    id: 'boot-id-missing',
    kind: 'void',
    // ACCUMULATED, not terminal: a validity check that returns early makes
    // itself the sole finding of every run it fires on, hiding e.g. that the
    // counters were absent too.
    //
    // Absence is not agreement: a server too old to publish the field is a
    // server this run cannot establish the validity of (nulls, never zeros).
    when: (context) => context.bootIds.some((id) => id === null),
    reason: (context) =>
      'VOID: a snapshot did not publish `processBootId`, so this run cannot tell one process from two — ' +
      'the cumulative counters below are only subtractable within a single process ' +
      `(residency ${JSON.stringify([context.bootIds[0], context.bootIds[1]])}, ` +
      `stats ${JSON.stringify([context.bootIds[2], context.bootIds[3]])})`,
  },

  // ── THE NETTING PRECONDITION, made executable ──────────────────────────────
  // Both peer witnesses are LEVELS, so they net: a wrong eviction and an
  // arriving peer cancel. Exactly one connected client is what makes them
  // readable, and it is a fact the server publishes rather than one this file
  // may assume.
  {
    id: 'connections-unpublished',
    kind: 'void',
    netting: false,
    when: (context) => context.connectionsBefore === null || context.connectionsAfter === null,
    reason: () =>
      'VOID: `joinedConnections` was not published by one of the stats snapshots — ' +
      'the netting precondition cannot be checked',
  },
  {
    id: 'connections-not-one-at-open',
    kind: 'void',
    netting: false,
    // PRECEDENCE lives in the predicate itself: the drop rule below is only sound when the window OPENED with
    // exactly our one client. If two were connected at the start, a fall to one
    // is just as likely to be the FOREIGN client leaving, and blaming the server
    // for that is a false accusation.
    when: (context) => context.connectionsBefore !== null
      && context.connectionsAfter !== null
      && context.connectionsBefore !== 1,
    reason: (context) =>
      `VOID: ${context.connectionsBefore} client(s) were connected when the window opened, not exactly 1 — ` +
      'the scenario was never set up, so neither peer witness can be attributed to anything',
  },
  {
    id: 'server-dropped-client',
    kind: 'server-fact',
    // A FAILURE, not a void, though the two look alike in the count alone (a
    // client arriving vs. a client dropped). The script holds its client open across
    // the whole window and shuts it down only AFTER the verdict, so a drop in
    // the count means the SERVER disconnected a live client. That is a fact
    // about the subject, and it is a plausible consequence of the very defect
    // under test: an eviction that takes the socket with it lowers
    // `joinedConnections` AND the peer witnesses together.
    //
    // A SERVER fact: it holds whether or not the peer witnesses are legible, so
    // no void may silence it — which is what `rankOutcome` guarantees.
    when: (context) => context.connectionsBefore === 1
      && context.connectionsAfter !== null
      && context.connectionsAfter < 1,
    reason: (context) =>
      'the server DISCONNECTED a client this run was holding open ' +
      `(joinedConnections ${context.connectionsBefore} -> ${context.connectionsAfter}) — ` +
      'the script keeps its peer connected until after the verdict, so the drop came from the server side',
  },
  {
    id: 'client-arrived',
    kind: 'void',
    netting: false,
    // A client ARRIVED inside the window. That is about the scenario, not the
    // server, and it is the case that makes the levels net: both witnesses are
    // levels, so an arrival offsets a wrong eviction exactly.
    when: (context) => context.connectionsBefore === 1
      && context.connectionsAfter !== null
      && context.connectionsAfter > 1,
    reason: (context) =>
      `VOID: a client arrived during the window (joinedConnections ${context.connectionsBefore} -> ` +
      `${context.connectionsAfter}) — \`documentsWithPeers\` and \`totalPeerBindings\` are levels, ` +
      'so its bindings net against a wrong eviction and neither witness can be read',
  },

  // ── THE SCENARIO MUST EXIST AT ALL ─────────────────────────────────────────
  // Two shapes that would otherwise report `passed`:
  //
  //   client held NOTHING, documentsWithPeers 0 -> 0, evicted 1
  //   client held two documents, documentsWithPeers 0 -> 0
  //
  // The first is the empty set — "nothing a connected client was holding got
  // evicted" is trivially true when it was holding nothing (cf. the
  // `objectsTested` floor in `evaluateConcurrentResult`). In the second the
  // client says it holds two documents and the server says no document has a
  // peer: the witnesses contradict each other because the server-side one is not
  // being populated (`AM_SELECTIVE_SYNC` is read process-wide and can silence
  // the announce on the wrong side).
  {
    id: 'client-held-nothing',
    kind: 'void',
    netting: false,
    when: (context) => Array.isArray(context.clientDocumentsBefore)
      && context.clientDocumentsBefore.length === 0,
    reason: () =>
      'VOID: the client held NO documents at the start of the window — "nothing a connected client was holding ' +
      'was evicted" is true of the empty set, which is the shape this gate exists to stop reporting as health',
  },
  {
    id: 'server-saw-no-peer',
    kind: 'void',
    netting: false,
    // THE TOTAL COLLAPSE ONLY. Voiding on any shortfall
    // (`peersBefore < clientDocumentsBefore.length`) would be UNSOUND. Under
    // `AM_SELECTIVE_SYNC=on` — which this gate's scenario requires — a peer is
    // bound to a document when its first sync message arrives, NOT when the
    // client acquires the handle. So a client legitimately holds a handle whose
    // binding has not landed yet, and "client holds 3, server sees 2" is an
    // ordinary mid-sync reading rather than a contradiction. The measured
    // healthy run sits at exactly 2 and 2 — zero margin — so the shortfall form
    // would void the healthy arm on any timing drift.
    //
    // Zero is the unambiguous case: the client holds documents and the server
    // sees NO document anywhere with a peer, so the server-side witness both
    // other checks read is dead and every one of them reports health.
    when: (context) => Array.isArray(context.clientDocumentsBefore)
      && context.clientDocumentsBefore.length > 0
      && context.peersBefore === 0,
    reason: (context) =>
      `VOID: the client reported holding ${context.clientDocumentsBefore.length} document(s) and the server saw NO ` +
      'document with a peer at all — the server-side witness is not being populated, and a witness reading zero ' +
      'satisfies every other check here as a clean run',
  },

  // ── THE OTHER HALF OF THE NETTING PRECONDITION ─────────────────────────────
  // `joinedConnections === 1` bounds the number of CLIENTS, but the netting
  // needs no second client at all. One client suffices: the
  // sweep wrongly evicts held document X (-1 binding) while the SAME client
  // opens document Z (+1), both levels come out at exactly zero, every other
  // precondition holds, and the gate reports `passed` on a run that lost a
  // document. Scale-free — two evictions offset by two opens pass too.
  //
  // With a second client excluded above, the ONLY remaining source of a new peer
  // binding visible in `repo.handles` is this client opening something, so its
  // document SET is pinned. (Bindings that land late, or a re-bind after the
  // sweep, can still net — see `eviction-peeraware.mjs`.) A set and not a count: closing one document and opening
  // another holds the count still while the bindings move.
  {
    id: 'client-documents-unreported',
    kind: 'void',
    netting: false,
    // `!clientSetKnown` rather than a pair of `=== null` comparisons, so a
    // non-ARRAY lands here as a void instead of throwing out of the context
    // builder. See `buildContext` for the measurement.
    when: (context) => !context.clientSetKnown,
    reason: () =>
      'VOID: the run did not report which documents its client held at each edge — without that, one client ' +
      'opening a document nets exactly against a wrongly-evicted one and both peer witnesses read zero',
  },
  {
    id: 'client-document-set-changed',
    kind: 'void',
    // A BOUNDED confounder, so it stays in the capacity arithmetic rather than
    // clearing `netting`: its size is known (`closed.length`) and the residue
    // past it is genuinely attributable. The row always fires while
    // `closed.length > 0`, so the capacity is always counted.
    capacity: (context) => context.closed.length,
    when: (context) => context.clientSetKnown
      && (context.opened.length > 0 || context.closed.length > 0),
    reason: (context) =>
      `VOID: the client's own document set changed during the window (+${context.opened.length} opened, ` +
      `-${context.closed.length} closed) — its bindings net against a wrongly-evicted document, so neither ` +
      'peer witness can be read',
  },

  // A counter the server did not publish is not a counter that read zero:
  // nulls, never zeros, when a count could not be taken.
  {
    id: 'capacity-not-computable',
    kind: 'void',
    // A row's `capacity` returned something that is neither `null` nor a finite
    // number. That is a TABLE defect rather than a fact about the run, and it is
    // reported as a void for the same reason as nulls: the alternative
    // is a NaN capacity, which passes `!== null`, makes every residue comparison
    // false, and lets the gate report `passed` over a real binding loss with no
    // finding at all. `deriveAccumulators` records the offending row id.
    when: (context) => context.capacityDefect !== null,
    reason: (context) =>
      `VOID: the confounder capacity could not be computed — row ${JSON.stringify(context.capacityDefect)} ` +
      'contributed a value that is neither null nor a finite number, so no residue can be attributed',
  },
  {
    id: 'evicted-unpublished',
    kind: 'void',
    when: (context) => context.evicted === null,
    reason: () => 'VOID: `evictedDocuments` was not published by one of the residency snapshots',
  },
  {
    id: 'peer-bound-unpublished',
    kind: 'void',
    when: (context) => context.peerBoundDelta === null,
    reason: () => 'VOID: `synchronizer.documentsWithPeers` was not published by one of the stats snapshots',
  },
  {
    id: 'peer-binding-unpublished',
    kind: 'void',
    when: (context) => context.peerBindingDelta === null,
    reason: () => 'VOID: `synchronizer.totalPeerBindings` was not published by one of the stats snapshots',
  },
  {
    id: 'sweep-did-not-run',
    kind: 'void',
    // The sweep must have RUN. Without this, a server whose eviction never fired
    // satisfies "nothing was wrongly evicted" trivially — the empty set again,
    // and the reason the orphan is created in the first place. Kept at `>= 1`
    // rather than `=== 1`: an extra eviction is not by itself wrong, and the
    // assertion that matters about WHICH documents went is the residue one.
    when: (context) => context.evicted !== null && context.evicted < 1,
    reason: (context) =>
      `VOID: the sweep evicted ${context.evicted} document(s) — the orphan was never collected, ` +
      'so no eviction pass is being observed',
  },

  // ── THE RETIREMENT CONTROL ─────────────────────────────────────────────────
  // Synchronizer retirement also deletes a DocSynchronizer, so a drop
  // attributable to it is not evidence about eviction either way — and a check
  // that cannot tell them apart would report the wrong subsystem.
  {
    id: 'retirement-unreadable',
    kind: 'void',
    // Nulls-never-zeros, applied to the CAPACITY and not just to the counters.
    // `retiredDocuments` comes from `synchronizer.retirementMetrics?.() ?? null`,
    // and `retirementMetrics` is added by the VENDORED PATCH: on an unpatched or
    // drifted install the field is null. Treating that as a capacity of 0 would
    // publish a drop genuinely caused by retirement as an ATTRIBUTABLE failure.
    capacity: () => null,
    when: (context) => context.retiredBefore === null || context.retiredAfter === null,
    reason: () =>
      'VOID: `synchronizer.retiredDocuments.count` was not published, so the retirement control could not be ' +
      'taken — retirement deletes a DocSynchronizer too, and without its size a binding drop cannot be attributed',
  },
  {
    id: 'documents-retired',
    kind: 'void',
    capacity: (context) => context.retiredAfter - context.retiredBefore,
    when: (context) => context.retiredBefore !== null
      && context.retiredAfter !== null
      && context.retiredAfter > context.retiredBefore,
    reason: (context) =>
      `VOID: the synchronizer retired ${context.retiredAfter - context.retiredBefore} document(s) during the ` +
      'window — retirement deletes a DocSynchronizer too, so a peer-binding drop of that size cannot be ' +
      'attributed to eviction',
  },
]

/** Rows that INFER, from what the precondition pass left readable.
 *
 * They read `residueReadable` and `confounderCapacity`, which
 * `deriveAccumulators` computes from the precondition rows BEFORE any row
 * fires, so precondition and residue rows run in one order-free pass. */
const RESIDUE_CHECKS = [
  {
    id: 'held-documents-lost-peer',
    kind: 'attributable',
    // THE RESIDUE, which no confounder reaches. A drop larger than everything
    // that could legitimately explain it is a real finding, and it must outrank
    // the voids those same confounders raised — otherwise one retirement hides a
    // loss of five (`documentsWithPeers 8 -> 3` with ONE retirement).
    //
    // GUARDED on `residueReadable`: with two clients at the window's open and
    // the foreign one leaving, an unguarded inference would report `failed`
    // against a healthy server — and failures outrank voids, so the inference
    // would beat its own precondition (a browser tab left open on the port).
    //
    // The SAFETY PROPERTY, measured over a 4x4x7 sweep of (closed, retired,
    // drop): there is no combination that yields `passed` over a nonzero
    // drop, because any nonzero capacity also pushes its own void. So a miscount
    // can degrade `failed` to `void` — it can never reach `passed`.
    when: (context) => context.residueReadable
      && context.peerBoundDelta !== null
      && -context.peerBoundDelta > context.confounderCapacity,
    reason: (context) => {
      const unexplained = -context.peerBoundDelta - context.confounderCapacity
      // The ATTRIBUTION is conditioned on there having been an eviction at all,
      // so the verdict cannot say "the sweep evicted a document with an active
      // peer" beside "VOID: the sweep evicted 0 document(s)". The FINDING holds
      // either way (a binding vanished while the client stayed put).
      const agent = context.evicted !== null && context.evicted > 0
        ? 'the sweep evicted a document with an active peer'
        : 'no eviction was observed in this window, so something else detached a peer that should have been spared'
      return context.confounderCapacity === 0
        ? `${unexplained} document(s) that a connected client was holding lost their peer binding ` +
          `(documentsWithPeers ${context.peersBefore} -> ${context.peersAfter}) — ${agent}`
        : `${unexplained} peer binding(s) were lost that NOTHING in this window explains ` +
          `(documentsWithPeers ${context.peersBefore} -> ${context.peersAfter}; retirement and the client's own ` +
          `closures together account for at most ${context.confounderCapacity}) — ` +
          'that residue is a wrongly-evicted document'
    },
  },
  {
    id: 'peer-bindings-lost',
    kind: 'attributable',
    // The OTHER reduction of the same array, held to the same capacity. Under
    // the one-client precondition it is arithmetically equal to the row above
    // (see the header), so a DISAGREEMENT between them is a defect in the
    // telemetry rather than in the sweep — which is the only thing this
    // redundancy buys and the reason it is graded rather than merely published.
    //
    // It needs the netting guard MORE than its sibling, not less:
    // `confounderCapacity` is counted in DOCUMENTS while `totalPeerBindings`
    // counts (document, peer) PAIRS, and those coincide only under the
    // one-client precondition. With two clients, one retirement of a document
    // both held gives `peerBindingDelta -2` against a capacity of 1 — a
    // confident `failed` on a healthy server.
    when: (context) => context.residueReadable
      && context.peerBindingDelta !== null
      && -context.peerBindingDelta > context.confounderCapacity,
    reason: (context) =>
      `${-context.peerBindingDelta - context.confounderCapacity} peer binding(s) were lost while their client ` +
      `stayed connected (totalPeerBindings ${context.bindingsBefore} -> ${context.bindingsAfter}) — ` +
      'the sweep detached a peer it should have spared',
  },
]

/** Every row, in the order the runner consults them. Exported so a test can
 * assert properties OF THE TABLE rather than only of its outputs — see
 * `peerAwareTableInvariants`. */
export const PEER_AWARE_CHECKS = Object.freeze({
  terminal: Object.freeze(TERMINAL_CHECKS),
  precondition: Object.freeze(PRECONDITION_CHECKS),
  residue: Object.freeze(RESIDUE_CHECKS),
})

/** Structural properties of the table, computed rather than asserted, so the
 * test that grades them cannot drift from the table it grades.
 *
 * The check that matters most is `terminalOverlaps`: the terminal rows are the
 * only place where position still decides an outcome, so a fixture in which two
 * of them fire at once is a precedence question the table answers by accident.
 * The runner cannot detect that — it returns on the first match — so the test
 * drives real inputs through this instead. */
export function peerAwareTableInvariants(table = PEER_AWARE_CHECKS, contexts = []) {
  // PARAMETERISED, and that is not a convenience: the real table has no
  // duplicate and no bad kind, so every assertion over it alone is vacuous. The
  // test passes a deliberately broken table here, the same way
  // `gate-liveness.test.mjs` runs each detector over a synthetic corpus.
  const all = [...table.terminal, ...table.precondition, ...table.residue]
  const ids = all.map((check) => check.id)
  return {
    ids,
    duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
    badKinds: all.filter((check) => !FINDING_KINDS.has(check.kind)).map((check) => check.id),
    missingWhen: all.filter((check) => typeof check.when !== 'function').map((check) => check.id),
    missingReason: all.filter((check) => typeof check.reason !== 'function').map((check) => check.id),
    // A terminal row may not carry accumulating effects: it returns, so they
    // would be written and never read — decoration of the kind this file
    // deletes elsewhere.
    terminalWithEffects: table.terminal
      .filter((check) => check.netting !== undefined || check.capacity !== undefined)
      .map((check) => check.id),
    // A row that clears `netting` AND contributes capacity is stating both "this
    // confounder is unbounded" and "its size is exactly N", which cannot both be
    // true. The residue is skipped either way, so the capacity would be dead.
    nettingAndCapacity: table.precondition
      .filter((check) => check.netting === false && check.capacity !== undefined)
      .map((check) => check.id),
    // A residue row carrying an effect would be CIRCULAR: `deriveAccumulators`
    // computes `residueReadable` from the precondition rows before any residue
    // `when` runs, so a residue row's contribution would be read before it
    // existed. Refused structurally rather than by a comment asking nobody to.
    residueWithEffects: table.residue
      .filter((check) => check.netting !== undefined || check.capacity !== undefined)
      .map((check) => check.id),
    // "The check that matters most" (see the docblock). The terminal rows are the only place position still decides an outcome, so
    // a context in which two of them fire at once is a precedence question the
    // table answers by accident. The RUNNER cannot see it (it returns on the
    // first match), so the caller supplies contexts built from real inputs via
    // `peerAwareContext` and this reports the pairs.
    //
    // An overlap is tolerable because `restarted` and every other published
    // boolean are derived from the context rather than from which row fired, so
    // an overlap can only change the reason TEXT.
    terminalOverlaps: contexts
      .map((context) => table.terminal.filter((check) => check.when(context)).map((check) => check.id))
      .filter((matched) => matched.length > 1),
  }
}

/** The context a row sees, for tests that need to ask the table questions the
 * runner cannot answer — `terminalOverlaps` above is the only caller. Exported
 * rather than duplicated, so a test cannot drift from what production builds. */
export function peerAwareContext(input = {}) {
  return buildContext(input)
}

/** Everything every row reads, computed ONCE.
 *
 * Built before any row runs, and therefore null-safe throughout: the
 * `snapshot-missing` row is what reports an absent body, but it cannot do so if
 * building the context threw first. */
function buildContext({
  before, after, statsBefore, statsAfter, serverAlive,
  clientDocumentsBefore = null, clientDocumentsAfter = null,
}) {
  const num = (value) => (Number.isFinite(value) ? value : null)
  const delta = (from, to) => (num(from) === null || num(to) === null ? null : to - from)

  const bootIds = [before, after, statsBefore, statsAfter]
    .map((snapshot) => (typeof snapshot?.processBootId === 'string' ? snapshot.processBootId : null))
  const bootBefore = bootIds[0]

  // `Array.isArray`, not `!== null`. The context is built eagerly, before the
  // terminal rows run, so a non-array (a string, a number) reaching
  // `.filter`/`.includes` here would throw ahead of them and turn a clean
  // `failed` or `void` into a TypeError — an oracle that crashes instead of
  // reporting. A non-array instead falls to `client-documents-unreported`, a
  // void. (Production passes `Object.keys(repoB.handles).sort()`, so only an
  // adversarial case reaches it.)
  const clientSetKnown = Array.isArray(clientDocumentsBefore) && Array.isArray(clientDocumentsAfter)
  const opened = clientSetKnown ? clientDocumentsAfter.filter((id) => !clientDocumentsBefore.includes(id)) : []
  const closed = clientSetKnown ? clientDocumentsBefore.filter((id) => !clientDocumentsAfter.includes(id)) : []

  const peersBefore = num(statsBefore?.synchronizer?.documentsWithPeers)
  const peersAfter = num(statsAfter?.synchronizer?.documentsWithPeers)
  const bindingsBefore = num(statsBefore?.synchronizer?.totalPeerBindings)
  const bindingsAfter = num(statsAfter?.synchronizer?.totalPeerBindings)

  return {
    before, after, statsBefore, statsAfter, serverAlive,
    clientDocumentsBefore, clientDocumentsAfter, clientSetKnown, opened, closed,
    bootIds,
    bootBefore,
    // `every`, not `find(...) ?? bootBefore`: `find` legitimately RETURNS null
    // when the differing element IS null, and `??` would treat that as "nothing
    // found", so a snapshot with no identity would compare equal to one that
    // had it.
    bootIdsAgree: bootIds.every((id) => id === bootBefore),
    evicted: delta(before?.evictedDocuments, after?.evictedDocuments),
    // Published, never graded — see the header. Kept in the report because it is
    // the right witness for the LEASE path, and a reader comparing this file
    // with the residency snapshot should not have to wonder why it is absent.
    spared: delta(before?.evictionSkippedActivePeer, after?.evictionSkippedActivePeer),
    peersBefore,
    peersAfter,
    peerBoundDelta: peersBefore === null || peersAfter === null ? null : peersAfter - peersBefore,
    bindingsBefore,
    bindingsAfter,
    peerBindingDelta: bindingsBefore === null || bindingsAfter === null ? null : bindingsAfter - bindingsBefore,
    connectionsBefore: num(statsBefore?.joinedConnections),
    connectionsAfter: num(statsAfter?.joinedConnections),
    retiredBefore: num(statsBefore?.synchronizer?.retiredDocuments?.count),
    retiredAfter: num(statsAfter?.synchronizer?.retiredDocuments?.count),
    // ── written by the precondition pass, read by the residue pass ──
    // `confounderCapacity` is how many binding losses something OTHER than a
    // wrong eviction could account for. `null` means NOT KNOWN, which is not
    // zero — for the accumulator as for the counters feeding it.
    confounderCapacity: 0,
    // Can the peer witnesses be read AT ALL in this window? The residue infers a
    // wrong eviction from a LEVEL, and that inference is only available when
    // nothing UNBOUNDED is moving the level. Bounded confounders — the client's
    // own closures, retirement — stay in the capacity arithmetic instead.
    nettingReadable: true,
    residueReadable: false,
    // The id of a row whose `capacity` returned an unusable value, or null.
    // Written by `deriveAccumulators`, read by `capacity-not-computable`.
    capacityDefect: null,
  }
}

function fire(check, context, findings) {
  findings.push({ id: check.id, kind: check.kind, reason: check.reason(context) })
}

/** The two accumulators, derived as PURE FUNCTIONS of the immutable context
 * rather than written as side effects of rows firing.
 *
 * Every effect here is a pure predicate over `context` (`closed.length`,
 * `retiredAfter - retiredBefore`, `null`), so both values can be computed
 * BEFORE anything fires, after which precondition and residue rows are one
 * order-free pass. Deriving from `when` directly also keeps a row's predicate
 * and its capacity contribution the same expression, so tightening a `when`
 * cannot silently drop capacity and make the gate accuse a healthy server.
 *
 * Derived from the PRECONDITION rows only. A residue row carrying an effect
 * would be circular — its `when` reads what it would contribute to — and
 * `peerAwareTableInvariants().residueWithEffects` refuses one.
 */
function deriveAccumulators(context, preconditions) {
  // `nettingReadable` is false as soon as any UNBOUNDED confounder is present.
  context.nettingReadable = !preconditions.some(
    (check) => check.netting === false && check.when(context),
  )
  // `confounderCapacity` is how many binding losses something OTHER than a wrong
  // eviction could account for. `null` ABSORBS: not known is not zero.
  //
  // `check.capacity === undefined` is tested BEFORE `check.when`, so a row with
  // no effect never has its predicate run during derivation — which is what lets
  // `capacity-not-computable` below read a value this function writes.
  context.confounderCapacity = preconditions.reduce((total, check) => {
    if (check.capacity === undefined || !check.when(context)) return total
    const contribution = check.capacity(context)
    if (contribution === null || total === null) return null
    // THE THIRD VALUE. `null` means not known and a number means known; anything
    // else — `undefined` from a row that forgot to return, a `NaN` from an
    // arithmetic over an unparsed counter — would make the capacity NaN.
    // `NaN !== null` is true, so `residueReadable` would stay TRUE and every
    // residue comparison against NaN is false: both inferences would silently
    // never fire and the run could report `passed` over a real binding loss.
    //
    // Folded into `null` (not known) rather than 0 — and
    // `capacity-not-computable` turns that into a VOID.
    if (!Number.isFinite(contribution)) {
      context.capacityDefect = check.id
      return null
    }
    return total + contribution
  }, 0)
  context.residueReadable = context.nettingReadable && context.confounderCapacity !== null
}

function report(context, findings, { readable }) {
  const failures = findings.filter((finding) => FAILING_KINDS.has(finding.kind)).map((finding) => finding.reason)
  const voids = findings.filter((finding) => finding.kind === 'void').map((finding) => finding.reason)
  return {
    outcome: rankOutcome(findings),
    failures,
    voids,
    // The findings as STRUCTURE — `{id, kind, reason}` — beside the prose the
    // report has always carried. Two things read it. `qaGates.test.mjs` asserts
    // that every row in the table is exercised by some fixture, which is the
    // "unwired suite" detector applied to the table itself: adding a row and
    // forgetting to test it now fails a test instead of shipping a predicate
    // nothing has ever run. And a consumer that needs to classify a verdict can
    // match an ID rather than prose — which is what `serverFault` and
    // `restarted` exist to avoid having to do, and what they would be derived
    // from if the drill ever needs a third such fact.
    //
    // NOT on the wire (`peerAwareReport`) today, deliberately: nothing across
    // that boundary reads it, and a field the far side ignores is decoration.
    findings,
    // Failures first, always — one ordering for every return path.
    reasons: [...failures, ...voids],
    // Server LIVENESS only, derived from the kind. Never `|| failures.length >
    // 0`: a correct peer-binding detection is an attributable failure, not a
    // crashed server.
    serverFault: findings.some((finding) => finding.kind === 'server-fact'),
    // Published on EVERY verdict, so "no restart" cannot be confused with "this
    // verdict does not carry the field".
    //
    // DERIVED FROM THE BOOT IDS, not from which row fired: the terminal rows are
    // first-match-wins, so a server that DIED and was replaced (`serverAlive:
    // false` with the boot ids already disagreeing) matches `server-not-alive`
    // first. `evictionFireDrillCore.mjs` tests `restarted === true` FIRST to
    // stop a restart being reported as a missing identity, so it must be true
    // here too. No consumer-visible boolean depends on terminal ordering.
    restarted: !context.bootIds.some((id) => id === null) && !context.bootIdsAgree,
    // A terminal row means nothing below it was read, so the numbers are not
    // this run's to publish — including when they happen to be present.
    evicted: readable ? context.evicted : null,
    spared: readable ? context.spared : null,
    peerBoundDelta: readable ? context.peerBoundDelta : null,
    peerBindingDelta: readable ? context.peerBindingDelta : null,
    // The identity of the ONE process this reading describes, or null when there
    // was not one. Publishing `bootBefore` unconditionally would name a process
    // that only produced half the numbers beside it.
    bootId: readable && context.bootBefore !== null && context.bootIdsAgree ? context.bootBefore : null,
  }
}

/** Grade a peer-aware eviction run.
 *
 * `before`/`after` are `/api/platform/automerge-residency` bodies; `statsBefore`
 * and `statsAfter` are `/api/automerge/stats` bodies. Residency counters are
 * cumulative, so they are graded on deltas; the peer witnesses are levels.
 */
export function evaluatePeerAwareEviction(input = {}, table = PEER_AWARE_CHECKS) {
  const context = buildContext(input)
  const findings = []

  // The ONLY order-dependent step, three rows long: first match returns.
  for (const check of table.terminal) {
    if (!check.when(context)) continue
    fire(check, context, findings)
    return report(context, findings, { readable: false })
  }

  deriveAccumulators(context, table.precondition)

  // ONE pass, and the order within it decides only the sequence of `reasons`.
  // `peerAwareOrderInvariance` asserts that by SHUFFLING this array, so
  // "moving a row cannot change what it means" is tested, not just stated.
  // `table` is a parameter so a test can pass a permutation;
  // production always takes the default.
  for (const check of [...table.precondition, ...table.residue]) {
    if (check.when(context)) fire(check, context, findings)
  }

  return report(context, findings, { readable: true })
}

/** Is the verdict invariant under reordering the order-free rows?
 *
 * Returns the fields that DIFFER between the table as written and a permutation
 * of it, ignoring the sequence of `reasons` (which is presentation, and is
 * pinned separately by the failures-first test). An empty array is the
 * property the table design claims; anything else means a row has started
 * depending on a neighbour.
 */
export function peerAwareOrderInvariance(input, permute) {
  const straight = evaluatePeerAwareEviction(input)
  const shuffled = evaluatePeerAwareEviction(input, {
    terminal: PEER_AWARE_CHECKS.terminal,
    precondition: permute([...PEER_AWARE_CHECKS.precondition]),
    residue: permute([...PEER_AWARE_CHECKS.residue]),
  })
  const differing = []
  for (const field of ['outcome', 'serverFault', 'restarted', 'evicted', 'spared', 'peerBoundDelta', 'peerBindingDelta', 'bootId']) {
    if (!Object.is(straight[field], shuffled[field])) differing.push(field)
  }
  const ids = (verdict) => verdict.findings.map((finding) => finding.id).sort().join(',')
  if (ids(straight) !== ids(shuffled)) differing.push('findings')
  return differing
}

/** The QARESULT payload for a peer-aware eviction run.
 *
 * Built HERE, beside the evaluation it describes, rather than as a hand-built
 * per-field literal in `qa/eviction-peeraware.mjs`: a field added to the
 * verdict (e.g. `serverFault`, read by `evictionFireDrillCore.mjs`) is on the
 * wire by construction. `qaGates.test.mjs` carries the contract test that
 * round-trips this through JSON into `evaluateFireDrill`.
 */
export function peerAwareReport(evaluation, extras = {}) {
  return {
    test: 'eviction-peeraware',
    ...extras,
    evicted: evaluation.evicted,
    // Published, not graded — the idle sweep cannot reach the counter this
    // comes from. The header above carries the trace.
    sparedForActivePeer: evaluation.spared,
    peerBoundDelta: evaluation.peerBoundDelta,
    peerBindingDelta: evaluation.peerBindingDelta,
    // The identity that says these two snapshots came from ONE server. The
    // drill reads it to prove its two arms measured two different processes,
    // which on Windows is not a formality.
    processBootId: evaluation.bootId,
    // The two classification facts the drill grades. Typed, so rewording a
    // reason cannot flip a verdict a module away.
    serverFault: evaluation.serverFault === true,
    restarted: evaluation.restarted === true,
    outcome: evaluation.outcome,
    reasons: evaluation.reasons,
    pass: evaluation.outcome === 'passed',
  }
}

export { exitCodeForOutcome } from './diagramPeersCore.mjs'
