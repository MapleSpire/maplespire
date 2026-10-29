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

// A VOID arm for tests that drive the REAL-TIME Redis pause instruments.
//
// The pre-pause admissions refuse, correctly, when the host starves them: a
// sampler read older than two periods (100 ms at the tests' 50 ms cadence), a
// witness reply older than 50 ms, fewer than two Engine reads in the window, or
// a wall/monotonic pair more than 2 ms apart because the process was preempted
// between the two reads. Measured 2026-10-25 on this suite (Windows, 32 cores),
// beside a looping root `vitest run`: 5 of 10 runs red before any void, every
// remaining red one of these refusals; 10 of 10 red under 40 spinning threads.
// The instrument told the truth; the positive arm did not reach the mechanism
// it checks. With this void: 10 of 10 green at the vitest load, 3 attempts
// voided and re-run, each re-run admitted.
//
// So a refusal whose issues are ALL host-starvation issues makes the attempt
// VOID, not green and not red: it is disclosed and re-run, at most `attempts`
// times (default below). Any other refusal fails at once, and consecutive voids exhaust the
// attempts, which also fails. A mutant that breaks an admission therefore
// fails either way.
import assert from 'node:assert/strict'

const STARVATION = [
  /^(?:a|b|engine): no recent completed clock request within two sampling periods$/,
  /^(?:a|b|engine): need at least two completed clock samples before injection$/,
  /^(?:a|b|engine): sample \d+: wall clock differs from monotonic clock$/,
  /^current wall clock differs from monotonic clock$/,
  /^admission-stale$/,
  /^admission-insufficient-replies$/,
  /^wall-monotonic-disagreement$/,
]

// The witness HALTS on its first unusable stamp: a preempted wall/monotonic
// pair is reported as wall-monotonic-disagreement, then clock-unusable, then
// admission-not-active (measured in the gate child, 2026-10-25). These two are
// consequences, never causes: they are void only beside that root issue.
const HALT_CASCADE = new Set(['clock-unusable', 'admission-not-active'])

/** True only for a non-empty list made entirely of host-starvation issues. */
export function onlyHostStarvation(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return false
  const roots = issues.filter(issue => !HALT_CASCADE.has(issue))
  if (roots.length < issues.length && !roots.includes('wall-monotonic-disagreement')) return false
  return roots.length > 0 && roots.every(issue => STARVATION.some(pattern => pattern.test(issue)))
}

/**
 * Runs `attempt(index)` until it returns `{ void: null, value }`.
 * `void` is the admission's issue list when the attempt was refused; the
 * attempt decides which admission that is. A refusal that is not purely host
 * starvation FAILS here, at once: attempts usually return early on a refusal,
 * before their own assertions, so returning would pass having checked nothing
 * (a mutant that skewed a request clock by 50 ms survived exactly that way).
 */
// Five, from 40 suite runs beside a root vitest run: 9 first attempts voided
// across 7 arms (worst arm 2 in 40), and 1 of those 9 voided again, so voids
// cluster. Three attempts at that conditional rate is ~0.7 % of suite runs
// red on starvation alone; five is ~0.01 %. A void costs one attempt's time.
export async function untilAdmitted(t, label, attempt, { attempts = 5 } = {}) {
  const voids = []
  for (let index = 1; index <= attempts; index += 1) {
    const outcome = await attempt(index)
    if (outcome.void === null || outcome.void === undefined) return outcome.value
    if (!onlyHostStarvation(outcome.void)) {
      assert.fail(`${label}: admission refused for a reason other than host starvation: ${JSON.stringify(outcome.void)}`)
    }
    voids.push(outcome.void)
    t.diagnostic(`${label}: attempt ${index} VOID, host starved the real-time admission: ${outcome.void.join('; ')}`)
  }
  assert.fail(`${label}: ${attempts} consecutive VOID attempts, the arm never reached its mechanism: ${JSON.stringify(voids)}`)
}
