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

import { useState } from 'react'

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
}

/**
 * True on the first render and on every render whose `deps` differ (by
 * `Object.is`, element-wise) from the previous render's — the same rule
 * `useEffect` uses to decide whether to re-run.
 *
 * It is the render-phase replacement for an effect whose job was to RESET
 * this component's own state when its inputs change
 * (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes):
 *
 *   const changed = useDepsChanged([orgId])
 *   if (changed) { setStatus('loading'); setError(null) }
 *
 * React re-runs the component immediately with the adjusted state, before
 * anything is committed, so the reset lands one commit EARLIER than the
 * effect it replaces did and no frame shows the stale state. Only this
 * component's own setters may be called there — never a store action or
 * another component's setter, which still belong in an effect.
 */
export function useDepsChanged(deps: readonly unknown[]): boolean {
  const [previous, setPrevious] = useState<readonly unknown[] | null>(null)
  const changed = previous === null || !sameDeps(previous, deps)
  if (changed) setPrevious(deps)
  return changed
}
