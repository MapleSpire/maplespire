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

import { useEffect, useMemo, useRef } from 'react'
import { assignPresenceAppearances } from '../../lib/presence/colors'
import type { DiagramPresenceCursor } from '../../lib/presence/protocol'
import {
  diagramPresenceParticipants,
  diagramPresenceRemoteCursors,
  useDiagramPresenceStore,
} from '../../stores/diagramPresenceStore'

export interface ProjectedPresenceCursor {
  x: number
  y: number
  visible: boolean
}

export function RemoteCursorOverlay({
  project,
}: {
  project: (cursor: DiagramPresenceCursor) => ProjectedPresenceCursor | null
}) {
  const cursorVersion = useDiagramPresenceStore((state) => state.cursorVersion)
  const rosterVersion = useDiagramPresenceStore((state) => state.rosterVersion)
  const cursors = diagramPresenceRemoteCursors()
  const appearances = useMemo(() => {
    void rosterVersion
    const participants = diagramPresenceParticipants()
    return assignPresenceAppearances(participants.map((participant) => participant.participantId))
  }, [rosterVersion])
  void cursorVersion
  const elements = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    if (cursors.length === 0) return
    let frame = 0
    const render = () => {
      for (const peer of cursors) {
        const element = elements.current.get(peer.peerId)
        const cursor = peer.cursor
        if (!element || !cursor) continue
        const projected = project(cursor)
        const visible = projected?.visible && Number.isFinite(projected.x) && Number.isFinite(projected.y)
        element.style.display = visible ? 'block' : 'none'
        if (visible && projected) {
          element.style.transform = `translate3d(${Math.round(projected.x)}px, ${Math.round(projected.y)}px, 0)`
        }
      }
      frame = requestAnimationFrame(render)
    }
    frame = requestAnimationFrame(render)
    return () => cancelAnimationFrame(frame)
  }, [cursors, project])

  if (cursors.length === 0) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-[25] overflow-hidden" aria-hidden="true">
      {cursors.map((peer) => {
        const appearance = appearances.get(peer.participant.participantId)
        if (!appearance) return null
        return (
          <div
            key={peer.peerId}
            data-presence-cursor={peer.participant.participantId}
            data-presence-name={peer.participant.firstName}
            ref={(element) => {
              if (element) elements.current.set(peer.peerId, element)
              else elements.current.delete(peer.peerId)
            }}
            className="absolute left-0 top-0 will-change-transform"
          >
            <svg width="18" height="22" viewBox="0 0 18 22" className="drop-shadow-sm">
              <path
                d="M2 1.75v15.6l4.45-4.1 3.15 6.35 3.2-1.6-3.05-6.1h6.05L2 1.75Z"
                fill={appearance.background}
                stroke="var(--color-surface-100)"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
            <span
              className="absolute left-[13px] top-[14px] max-w-[150px] truncate rounded-[7px] px-2 py-1 text-[10px] font-semibold leading-none shadow-md"
              style={{ backgroundColor: appearance.background, color: appearance.foreground }}
            >
              {peer.participant.firstName}
            </span>
          </div>
        )
      })}
    </div>
  )
}
