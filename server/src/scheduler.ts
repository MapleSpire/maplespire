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
 * A tiny dependency-free daily scheduler that fires at a wall-clock time in a given IANA
 * timezone (DST-aware via Intl), re-arming itself after each run.
 *
 * It computes "seconds until the next HH:MM in `timeZone`" from the zone's CURRENT
 * wall-clock (so it follows DST without a cron library). On the two DST-transition days a
 * 23h/25h day can shift the fire time by up to an hour; since it re-arms by recomputing
 * each day, that self-corrects and a daily maintenance job being ±1h twice a year is fine.
 */

/** ms from `now` until the next `hour:minute` in `timeZone`. */
export function msUntilNextDaily(
  hour: number,
  minute: number,
  timeZone: string,
  now: number = Date.now(),
): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(now))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0')
  let h = get('hour')
  if (h === 24) h = 0 // some ICU builds render midnight as 24
  const secondsNow = h * 3600 + get('minute') * 60 + get('second')
  const target = hour * 3600 + minute * 60
  let deltaSec = target - secondsNow
  if (deltaSec <= 0) deltaSec += 86_400 // already past today → next day
  return deltaSec * 1000
}

/** Run `task` every day at `hour:minute` in `timeZone`. Returns a cancel function.
 * The task's resolved value is ignored (awaited only so a throw is logged). */
export function scheduleDailyAt(
  hour: number,
  minute: number,
  timeZone: string,
  task: () => unknown,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false

  const arm = () => {
    if (cancelled) return
    const delay = msUntilNextDaily(hour, minute, timeZone)
    timer = setTimeout(async () => {
      if (cancelled) return
      try {
        await task()
      } catch (err) {
        console.error('[scheduler] daily task failed:', err)
      }
      arm()
    }, delay)
  }

  arm()
  return () => {
    cancelled = true
    if (timer) clearTimeout(timer)
  }
}
