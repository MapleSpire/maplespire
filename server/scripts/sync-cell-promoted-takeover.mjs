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
 * G4-16h — the PROMOTED-TAKEOVER arm of the G4-7 rehearsal.
 *
 * Operator summary promotion is the chosen remedy for the freshness cost of
 * a takeover (measured: 3 919–4 062 ms at 12 000 ordinary objects, G4-17).
 * The rehearsal could not measure it: it refuses static workspaces. This arm
 * adds ONE promoted 12 000-object workspace to partition zero, next to the
 * ordinary 12 000-object hot workspace the rehearsal already seeds there, and
 * measures both from the SAME takeover and the SAME origin (`completedAt`).
 *
 * What is decided here, as pure functions the tests can drive:
 *
 *  - the explicit bench setting and the configuration it requires;
 *  - the ONE place the `staticWorkspaces` rule is relaxed, and only for the
 *    promoted arm (`expectedStaticWorkspaces`);
 *  - whether the promotion was ACCEPTED (otherwise the pass is VOID);
 *  - the promoted arm's freshness probe: an overlay edit issued after the
 *    takeover completed, and the first response from the replacement that is
 *    fresh by the witness's own rule AND shows that edit;
 *  - the validity of that answer, and the verdict against the pre-committed
 *    threshold, with the ordinary arm as the control.
 *
 * WHY THE EDIT IS ISSUED AFTER THE TAKEOVER. A summary workspace is served from
 * its kept SQL rows with no cold build (`ensureWorkspace` →
 * `staticReadModelQueryWorkspaceIfPresent`, `server/src/index.ts`). An edit
 * made before the pause was projected by the FORMER owner, so a response that
 * shows it proves only that the rows survived — the replacement may not be
 * projecting anything. An edit made after `completedAt` can only reach the
 * read model through the replacement's static plane, and until it does the
 * arrival watermark refuses `absenceProvable` (`getWorkspaceProjectionFreshness`).
 * The kept-rows answer is still recorded (`served`), labelled as what it is.
 *
 * THE WARM EDIT BEFORE THE PAUSE. Measured on the Mac trials (2026-11-21):
 * right after an accepted promotion the workspace answers `absenceProvable:
 * false` on its owner and stays so. The arm therefore takes one overlay edit
 * on the OWNER first (`warm`) and waits up to 60 s for the owner to answer
 * fresh with it — a reference for the static plane's steady-state edit→fresh
 * latency. It is RECORDED, not a gate: on those trials the owner never
 * answered fresh with it either (the current object head's queue row stayed
 * at `projected_revision = 0`, and the retired object head had no
 * `read_model_overlay_segments` row), and the takeover measurement then
 * reports a CENSORED wait rather than a number.
 */

import { performance } from 'node:perf_hooks'
import { freshnessIdentityValid, isFreshWitness } from './sync-cell-rehearsal.mjs'

/** The gate's variable; `sync-cell-bench.mjs --promoted-takeover=on` sets it. */
export const PROMOTED_TAKEOVER_FLAG = 'SYNC_LOAD_PROMOTED_TAKEOVER'
/** The control must be at least this slow, or it does not discriminate (G4-16h exit 3). */
export const CONTROL_MIN_MS = 3_000
/** The pre-committed threshold for the promoted arm, strict (G4-16h exit 4). */
export const PROMOTED_THRESHOLD_MS = 1_000
/** `read_model_static_workspaces.source` written by the promotion primitive. */
export const PROMOTED_STATIC_SOURCE = 'promoted'
/** The object count both arms carry (G4-17). */
export const ARM_OBJECTS = 12_000

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/** `on` or null. Blank and `off` are the run it was before the arm existed. */
export function parsePromotedTakeover(raw) {
  const value = typeof raw === 'string' ? raw.trim() : raw
  if (value === undefined || value === null || value === '' || value === 'off') return null
  if (value !== 'on') throw new Error(`${PROMOTED_TAKEOVER_FLAG} must be on or off`)
  return 'on'
}

/** The arm lives inside the posture soak rehearsal (the G4-17 command) and
 * nowhere else: that is where the 12 000-object seed, the fresh workspaces and
 * the dedicated calibration exist. Refused before any I/O. */
export function assertPromotedTakeoverConfig(config) {
  if (config?.promotedTakeover !== 'on') return
  const reasons = []
  if (!config.benchPosture) reasons.push('it needs SYNC_BENCH_POSTURE (the posture rehearsal)')
  if (config.mode !== 'soak') reasons.push('it needs --mode=soak (the rehearsal that seeds 12 000 objects)')
  if (config.seedObjectCount !== ARM_OBJECTS) reasons.push(`it needs SYNC_LOAD_SEED_OBJECT_COUNT=${ARM_OBJECTS}`)
  if (config.freshWorkspaces !== true) reasons.push('it needs fresh workspaces (it creates and deletes its own)')
  if (config.partitionCount !== 2) reasons.push('it needs the two-partition load topology')
  if (reasons.length) throw new Error(`${PROMOTED_TAKEOVER_FLAG}=on refused: ${reasons.join('; ')}`)
}

/**
 * THE ONE PLACE the rehearsal's `staticWorkspaces === 0` rule is relaxed.
 * The ordinary arm is 0 whatever the setting; the promoted arm is 1, and only
 * when the bench asked for it. Everything that checks the inventory reads it
 * from here, so a relaxation cannot leak to the control.
 */
export function expectedStaticWorkspaces(arm, config) {
  if (arm === 'ordinary') return 0
  if (arm === 'promoted') {
    if (config?.promotedTakeover !== 'on') throw new Error(`the promoted arm needs ${PROMOTED_TAKEOVER_FLAG}=on`)
    return 1
  }
  throw new Error(`unknown rehearsal arm ${JSON.stringify(arm)}`)
}

/**
 * Was the promotion ACCEPTED? Anything else VOIDs the pass (G4-16h exit 1).
 * Read from the route's own report (`POST /api/platform/workspace/promote-summary`):
 * HTTP 200, an apply, this workspace, no blocker, no OVERRIDDEN blocker (an
 * override is an operator waving a precondition through, not an accepted
 * promotion), something applied under the `promoted` source, exclusion not
 * disproved.
 */
export function promotionVerdict(response, workspace) {
  const reasons = []
  const body = response?.body
  if (response?.status !== 200) reasons.push(`promote-summary answered HTTP ${response?.status ?? 'none'}`)
  if (!body || typeof body !== 'object') {
    reasons.push('no promotion report')
    return { accepted: false, reasons, blockers: [], applied: null }
  }
  if (body.mode !== 'apply') reasons.push(`report mode is ${JSON.stringify(body.mode)}, not apply`)
  if (body.workspace?.landscapeId !== workspace?.landscapeId || body.workspace?.versionId !== workspace?.versionId) {
    reasons.push('the report names another workspace')
  }
  const blockers = Array.isArray(body.blockers) ? body.blockers.map((blocker) => blocker?.code ?? String(blocker)) : null
  if (blockers === null) reasons.push('the report carries no blocker list')
  else if (blockers.length) reasons.push(`blocked: ${blockers.join(', ')}`)
  if (!Array.isArray(body.overridden)) reasons.push('the report carries no override list')
  else if (body.overridden.length) reasons.push(`overridden: ${body.overridden.map((blocker) => blocker?.code).join(', ')}`)
  if (!body.applied) reasons.push('nothing was applied')
  else {
    if (body.applied.staticSource !== PROMOTED_STATIC_SOURCE) reasons.push(`static source is ${JSON.stringify(body.applied.staticSource)}`)
    if (typeof body.applied.writeHeadUrl !== 'string' || !body.applied.writeHeadUrl) reasons.push('no minted write head')
  }
  if (body.exclusionProven === false) reasons.push('the apply could not prove it held the apply lock')
  return { accepted: reasons.length === 0, reasons, blockers: blockers ?? [], applied: body.applied ?? null }
}

/** Milliseconds since the takeover's `completedAt`, on the monotonic clock the
 * ordinary arm uses (`readRehearsalFreshness`: `performance.now() -
 * takeover.completedMonotonicMs`). Never `startedAt`, never the pause. */
export function sinceCompleted(takeover, monotonicNow) {
  const origin = takeover?.completedMonotonicMs
  if (!finite(origin)) throw new Error('the takeover carries no completedMonotonicMs origin')
  if (!finite(monotonicNow)) throw new Error('no monotonic reading')
  return monotonicNow - origin
}

/**
 * The overlay edit: one BASE object of the promoted seed (the last background
 * witness, which lives in a base shard, not in the writer head) gets a new
 * name through the current object overlay head. The other witness keeps its
 * seeded name, so a response has to carry both the edit and the untouched row.
 */
export function promotedEditPlan(seed, runId, phase = 'takeover') {
  if (!/^[a-z]+$/.test(phase)) throw new Error('an edit phase is one lowercase word')
  const ids = Object.keys(seed?.expectedObjects ?? {})
  if (ids.length !== 2) throw new Error('the promoted seed must carry exactly two witness objects')
  const [headWitness, baseWitness] = ids
  if (headWitness === baseWitness) throw new Error('the promoted seed witnesses are not distinct')
  const name = `G4-16h ${phase} edit ${runId}`
  if (seed.expectedObjects[baseWitness]?.name === name) throw new Error('the edit would not change the witness')
  return {
    phase,
    objectId: baseWitness,
    name,
    batchId: `${runId}-g416h-${phase}`,
    expectedObjects: { [headWitness]: { ...seed.expectedObjects[headWitness] }, [baseWitness]: { name } },
  }
}

function summarize(response) {
  return {
    status: response?.status ?? null,
    route: response?.route ?? null,
    freshness: response?.body?.status ?? null,
    caughtUp: response?.body?.caughtUp ?? null,
    absenceProvable: response?.body?.absenceProvable ?? null,
    projectionGeneration: response?.body?.projectionGeneration ?? null,
  }
}

/**
 * The promoted arm's probe. Called in the takeover's `fresh` turn.
 *
 * `edit.apply()` resolves to `{ appliedMonotonicMs, ... }` once the overlay
 * head carries the change locally; `probe(ids)` reads the replacement's
 * durability witness; `served` is one read of the UNEDITED witness taken at
 * once, to record what the kept rows answer before anything is projected.
 *
 * The measurement is the first response that `isFreshWitness` accepts for the
 * EDITED expectation: owner route, this workspace, `absenceProvable`, the edit
 * and the untouched witness both visible. Its value is `receivedAt -
 * completedAt`, the ordinary arm's formula.
 */
export async function probePromotedFreshness({ takeover, workspace, seed, plan, edit, probe,
  monotonic = () => performance.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 120_000, intervalMs = 250 }) {
  if (!plan || !plan.expectedObjects) throw new Error('no edit plan')
  sinceCompleted(takeover, monotonic())
  const requests = []
  let editOutcome = null
  let editError = null
  const editing = Promise.resolve().then(() => edit.apply()).then((value) => {
    if (!finite(value?.appliedMonotonicMs)) throw new Error('the edit reported no applied time')
    editOutcome = { ...value, appliedAfterMs: sinceCompleted(takeover, value.appliedMonotonicMs) }
    return editOutcome
  }, (error) => { editError = error; throw error })
  editing.catch(() => {})
  const read = async (ids, kind) => {
    const requestedAfterMs = sinceCompleted(takeover, monotonic())
    const response = await probe(ids)
    const receivedAfterMs = sinceCompleted(takeover, monotonic())
    return { kind, requestedAfterMs, receivedAfterMs, response }
  }
  const servedRead = read(Object.keys(seed.expectedObjects), 'served').then((entry) => ({
    requestedAfterMs: entry.requestedAfterMs, receivedAfterMs: entry.receivedAfterMs, ...summarize(entry.response),
    keptRowsFresh: isFreshWitness(entry.response, workspace, seed.expectedObjects),
  }), (error) => ({ error: error?.message ?? String(error) }))
  const deadline = monotonic() + timeoutMs
  let fresh = null
  while (monotonic() < deadline) {
    if (editError) break
    let entry
    try {
      entry = await read(Object.keys(plan.expectedObjects), 'edited')
    } catch (error) {
      requests.push({ error: error?.message ?? String(error), atAfterMs: sinceCompleted(takeover, monotonic()) })
      await sleep(intervalMs)
      continue
    }
    const observed = entry.response?.body?.objects?.[plan.objectId]
    const row = { requestedAfterMs: entry.requestedAfterMs, receivedAfterMs: entry.receivedAfterMs,
      ...summarize(entry.response), editVisible: observed?.name === plan.name }
    requests.push(row)
    if (isFreshWitness(entry.response, workspace, plan.expectedObjects)) { fresh = row; break }
    await sleep(intervalMs)
  }
  const served = await servedRead
  const firstVisible = requests.find((row) => row.editVisible === true && row.status === 200 && row.route === 'owner')
  const editVisibleAfterMs = firstVisible ? firstVisible.receivedAfterMs : null
  if (editError) {
    const error = new Error(`the promoted overlay edit failed: ${editError?.message ?? editError}`)
    error.requests = requests
    error.served = served
    throw error
  }
  if (!fresh) {
    // CENSORED, not VOID: the edit was applied and the replacement answered,
    // but never fresh with it. The value is only known to exceed the wait —
    // which is enough to judge a 1 000 ms threshold, and is recorded as such.
    if (!editOutcome) {
      const error = new Error('the promoted overlay edit never reported applied before the deadline')
      error.requests = requests
      error.served = served
      throw error
    }
    return { freshAfterTakeoverMs: null, censored: true, censoredAfterMs: sinceCompleted(takeover, monotonic()),
      editVisibleAfterMs, firstFresh: null, edit: editOutcome, served, requests }
  }
  // The edit is visible, so it was applied; its settle can still be pending in
  // this turn. Wait for it so the record carries its time.
  await editing
  return { freshAfterTakeoverMs: fresh.receivedAfterMs, censored: false, editVisibleAfterMs, firstFresh: fresh, edit: editOutcome, served, requests }
}

/**
 * Is the promoted answer the REPLACEMENT's? Same identity and cold-reserve
 * rules as the ordinary arm (`readRehearsalFreshness`), with the inventory rule
 * inverted for this arm only, and one rule the static plane needs: the
 * projection row must name a projector instance other than the one that held
 * it before the pause — otherwise the rows may be the former owner's.
 */
export function promotedFreshnessValidity({ before, after, replacement, expectedTopology, inventory, seed, preTakeover, config, measured }) {
  const reasons = []
  if (!freshnessIdentityValid(before, after, replacement, expectedTopology)) reasons.push('replacement identity or topology changed')
  if (before?.fleet?.residentProjectors !== 0 || before?.fleet?.inFlightWorkspaces !== 0) reasons.push('the reserve was not cold before the pause')
  if (after?.ownership?.ready !== true || after?.ownership?.partitionIndex !== 0) reasons.push('the replacement does not own partition zero')
  if (after?.fleet?.foreignResidentProjectors !== 0) reasons.push('a foreign projector is resident on the replacement')
  let expectedStatic = null
  try { expectedStatic = expectedStaticWorkspaces('promoted', config) } catch (error) { reasons.push(error.message) }
  if (expectedStatic !== null && inventory?.staticWorkspaces !== expectedStatic) {
    reasons.push(`staticWorkspaces is ${inventory?.staticWorkspaces}, the promoted arm requires ${expectedStatic}`)
  }
  if (!Number.isSafeInteger(seed?.totalObjects) || inventory?.objects !== seed.totalObjects) {
    reasons.push(`ro_objects holds ${inventory?.objects}, the seed published ${seed?.totalObjects}`)
  }
  if (!inventory?.projectorInstanceId) reasons.push('no projector instance names the workspace')
  else if (!preTakeover?.inventory?.projectorInstanceId) reasons.push('no pre-takeover projector instance to compare against')
  else if (inventory.projectorInstanceId === preTakeover.inventory.projectorInstanceId) {
    reasons.push('the projection row still names the former owner\'s projector instance')
  }
  if (measured?.edit?.rootSummaryOnly !== true) reasons.push('the root the edit resolved is not in the summary world')
  if (measured?.censored === true) {
    // No fresh answer: the wait itself is the observation, and it must be real.
    if (!finite(measured.censoredAfterMs) || measured.censoredAfterMs < PROMOTED_THRESHOLD_MS) reasons.push('a censored wait shorter than the threshold')
    if (!Array.isArray(measured.requests) || !measured.requests.some((row) => row.status === 200 && row.route === 'owner')) {
      reasons.push('the replacement never answered the promoted arm during the wait')
    }
  } else if (!finite(measured?.freshAfterTakeoverMs) || measured.freshAfterTakeoverMs < 0) reasons.push('no measured freshness')
  if (!finite(measured?.edit?.appliedAfterMs) || measured.edit.appliedAfterMs < 0) {
    reasons.push('the overlay edit was not applied after completedAt')
  } else if (finite(measured?.freshAfterTakeoverMs) && measured.freshAfterTakeoverMs < measured.edit.appliedAfterMs) {
    reasons.push('a response showed the edit before it was applied')
  }
  return { valid: reasons.length === 0, reasons }
}

/**
 * The pass verdict. VOID: the instrument did not run as specified (promotion
 * refused, an arm invalid, the two arms measured from different origins).
 * INCONCLUSIVE: the control did not discriminate (ordinary < 3 000 ms).
 * MEASURED: both valid, control discriminating; `remedy` says whether the
 * promoted arm met the strict 1 000 ms threshold. Only a MEASURED pass that
 * meets it is `outcome: 'passed'` — a miss is a valid result, not a pass.
 */
export function judgePromotedTakeover({ promotion, ordinary, promoted, takeover }) {
  const reasons = []
  if (!promotion?.accepted) reasons.push(`promotion not accepted: ${(promotion?.reasons ?? ['no verdict']).join('; ')}`)
  if (takeover?.verified !== true || !finite(takeover?.completedAt)) reasons.push('no verified takeover')
  if (!ordinary?.valid) reasons.push('the ordinary control is invalid')
  if (!promoted?.valid) reasons.push(`the promoted arm is invalid: ${(promoted?.reasons ?? ['not measured']).join('; ')}`)
  if (finite(takeover?.completedAt) && (ordinary?.completedAt !== takeover.completedAt || promoted?.completedAt !== takeover.completedAt)) {
    reasons.push('the arms were not measured from the same completedAt')
  }
  const ordinaryMs = ordinary?.freshAfterTakeoverMs
  const promotedMs = promoted?.freshAfterTakeoverMs
  const censored = promoted?.censored === true
  if (!finite(ordinaryMs)) reasons.push('the control carries no freshAfterTakeoverMs')
  // G4-16h measurement, 2026-11-21. A client edit issued after
  // completedAt cannot be fresh before it is applied: an edit applied at or
  // after the threshold makes the threshold unreachable by construction, so
  // the instrument cannot judge it (measured: applied at 1 599–1 862 ms).
  const appliedAfterMs = promoted?.edit?.appliedAfterMs
  if (finite(appliedAfterMs) && appliedAfterMs >= PROMOTED_THRESHOLD_MS) {
    reasons.push(`the overlay edit was applied ${Math.round(appliedAfterMs)} ms after completedAt, at or past the ${PROMOTED_THRESHOLD_MS} ms threshold: unreachable by construction`)
  }
  // And a censored wait is a TAKEOVER effect only if the owner could answer
  // fresh before the pause; otherwise the miss predates the takeover.
  if (censored && promoted?.preTakeover?.warm?.fresh !== true) {
    reasons.push('absence was never provable on the owner before the pause either: a censored wait is not a takeover effect')
  }
  if (censored) {
    if (!finite(promoted?.censoredAfterMs) || promoted.censoredAfterMs < PROMOTED_THRESHOLD_MS) reasons.push('the promoted arm carries no usable censored wait')
  } else if (!finite(promotedMs)) reasons.push('the promoted arm carries no freshAfterTakeoverMs')
  const base = {
    task: 'G4-16h', origin: 'takeover completedAt (replacement ready), monotonic',
    completedAt: takeover?.completedAt ?? null, takeoverMs: takeover?.takeoverMs ?? null,
    controlMinMs: CONTROL_MIN_MS, thresholdMs: PROMOTED_THRESHOLD_MS,
    ordinaryFreshAfterTakeoverMs: finite(ordinaryMs) ? ordinaryMs : null,
    promotedFreshAfterTakeoverMs: !censored && finite(promotedMs) ? promotedMs : null,
    // Censored: no fresh answer with the edit within this many ms of completedAt.
    promotedCensoredAfterMs: censored && finite(promoted?.censoredAfterMs) ? promoted.censoredAfterMs : null,
    // Decomposition, never a verdict input: when the edit was applied, and
    // the first owner answer that showed it whether or not it proved absence.
    promotedEditAppliedAfterMs: finite(appliedAfterMs) ? appliedAfterMs : null,
    promotedEditVisibleAfterMs: finite(promoted?.editVisibleAfterMs) ? promoted.editVisibleAfterMs : null,
  }
  if (reasons.length) {
    return { ...base, status: 'VOID', outcome: 'failed', controlDiscriminates: null, thresholdMet: null, remedy: null, reasons }
  }
  const controlDiscriminates = ordinaryMs >= CONTROL_MIN_MS
  if (!controlDiscriminates) {
    return { ...base, status: 'INCONCLUSIVE', outcome: 'failed', controlDiscriminates, thresholdMet: null, remedy: null,
      reasons: [`the control answered fresh at ${ordinaryMs} ms, under ${CONTROL_MIN_MS} ms: it does not discriminate`] }
  }
  // A censored arm waited past the threshold without a fresh answer: a miss.
  const thresholdMet = !censored && promotedMs < PROMOTED_THRESHOLD_MS
  return { ...base, status: 'MEASURED', outcome: thresholdMet ? 'passed' : 'failed', controlDiscriminates, thresholdMet,
    remedy: thresholdMet ? 'proven' : 'not-proven', reasons: [] }
}
