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

import { useEffect, useState } from 'react'
import type { DocHandle } from '@automerge/automerge-repo'
import type { DiagramDoc } from '../../lib/automerge/types'
import { subscribeActiveDiagramHandle } from '../../lib/automerge/bridge'
import { localPresenceIdentity } from '../../lib/presence/protocol'
import { startDiagramPresence } from '../../lib/presence/diagramPresence'
import { useAuthStore } from '../../stores/authStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'

/**
 * Activates presence only after the DiagramDoc write path is ready. It does not
 * find, materialize or persist another document, so the optimized boot path is
 * untouched and offline editing remains independent from this enhancement.
 */
export function DiagramPresenceBridge() {
  const editReady = useAutomergeStatus((state) => state.editReady)
  const user = useAuthStore((state) => state.user)
  const [handle, setHandle] = useState<DocHandle<DiagramDoc> | null>(null)

  useEffect(() => subscribeActiveDiagramHandle(setHandle), [])

  useEffect(() => {
    if (!editReady || !handle) return
    let cancelled = false
    let stop: (() => void) | null = null
    void localPresenceIdentity(user).then((identity) => {
      if (cancelled) return
      stop = startDiagramPresence(handle, identity)
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [editReady, handle, user])

  return null
}
