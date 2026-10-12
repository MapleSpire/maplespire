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

import i18n from '../i18n'

/** Minimal relative-time formatter for audit lists / invite expiries — no new
 * dependency for a handful of "3m ago" / "in 2 days" strings. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const diffMs = Date.now() - then
  const future = diffMs < 0
  const abs = Math.abs(diffMs)

  const sec = Math.round(abs / 1000)
  const min = Math.round(sec / 60)
  const hr = Math.round(min / 60)
  const day = Math.round(hr / 24)

  if (sec < 45) return i18n.t('dateTime.justNow')

  let out: string
  if (min < 60) out = i18n.t('dateTime.unitMinutes', { count: min })
  else if (hr < 24) out = i18n.t('dateTime.unitHours', { count: hr })
  else if (day < 30) out = i18n.t('dateTime.unitDays', { count: day })
  else out = new Date(then).toLocaleDateString(i18n.language)

  return future ? i18n.t('dateTime.relativeFuture', { value: out }) : i18n.t('dateTime.relativePast', { value: out })
}
