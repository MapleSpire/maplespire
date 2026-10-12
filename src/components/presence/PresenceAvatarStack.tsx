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

import { useEffect, useRef, useState } from 'react'
import { Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { assignPresenceAppearances, type PresenceAppearance } from '../../lib/presence/colors'
import { diagramPresenceParticipants, useDiagramPresenceStore, type DiagramPresenceParticipant } from '../../stores/diagramPresenceStore'

function ParticipantAvatar({
  participant,
  appearance,
  overlap = false,
}: {
  participant: DiagramPresenceParticipant
  appearance: PresenceAppearance
  overlap?: boolean
}) {
  return (
    <span
      data-presence-participant={participant.participantId}
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-surface-100 text-[10px] font-bold shadow-sm',
        overlap && '-ml-2',
      )}
      style={{ backgroundColor: appearance.background, color: appearance.foreground }}
      aria-hidden="true"
    >
      {participant.initials}
    </span>
  )
}

export function PresenceAvatarStack() {
  const { t } = useTranslation()
  const rosterVersion = useDiagramPresenceStore((state) => state.rosterVersion)
  const participants = diagramPresenceParticipants()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const appearances = assignPresenceAppearances(participants.map((participant) => participant.participantId))
  const visible = participants.slice(0, 3)
  const overflow = Math.max(0, participants.length - visible.length)

  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  void rosterVersion
  if (participants.length === 0) return null

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('presence.connectedUsersWithCount', { count: participants.length })}
        title={t('presence.connectedUsersWithCount', { count: participants.length })}
        className="flex items-center rounded-lg px-0.5 py-1 transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {visible.map((participant, index) => (
          <ParticipantAvatar
            key={participant.participantId}
            participant={participant}
            appearance={appearances.get(participant.participantId)!}
            overlap={index > 0}
          />
        ))}
        {overflow > 0 && (
          <span className="-ml-2 flex h-7 min-w-7 items-center justify-center rounded-full border-2 border-surface-100 bg-surface-200 px-1 text-[10px] font-semibold text-fg-muted">
            +{overflow}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('presence.connectedUsers')}
          className="absolute left-0 top-[38px] z-50 w-[248px] rounded-[14px] border border-line bg-surface-100 p-2 shadow-xl"
        >
          <div className="flex items-center gap-2 border-b border-line px-2 pb-2 pt-1">
            <Users className="h-3.5 w-3.5 text-fg-subtle" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-secondary">
              {t('presence.connectedUsers')}
            </span>
            <span className="ml-auto rounded-full bg-surface-200 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-fg-muted">
              {participants.length}
            </span>
          </div>
          <ul className="max-h-[260px] overflow-y-auto py-1">
            {participants.map((participant) => (
              <li key={participant.participantId} className="flex items-center gap-2.5 rounded-[10px] px-2 py-2 hover:bg-surface-50">
                <ParticipantAvatar
                  participant={participant}
                  appearance={appearances.get(participant.participantId)!}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold text-fg">
                    {participant.firstName}
                    {participant.isLocal && <span className="ml-1 font-normal text-fg-subtle">({t('presence.you')})</span>}
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] text-fg-subtle">
                    <span className="h-1.5 w-1.5 rounded-full bg-success" />
                    {t('presence.online')}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
