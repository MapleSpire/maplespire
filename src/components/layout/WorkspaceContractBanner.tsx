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

import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { useAuthStore } from '../../stores/authStore'
import { cn } from '../../lib/utils'

/**
 * The epoch guard's face. Shown when the active
 * workspace's BOOT CONTRACT changed under a live session — a classic session
 * whose workspace was promoted to the server-registry (summary) contract while
 * the tab was open.
 *
 * By the time this renders the bridge has latched `workspaceContractStale`, and
 * that latch freezes TWO things: the root-change projection (`syncShardHandles`
 * + `projectAll`) and — the half that matters — `flushWrite`'s model,
 * `ensureDiagramDoc` and registry passes, which would otherwise keep writing
 * into the baseline documents the promotion has just handed to the server. The
 * banner exists because a frozen session that says nothing is the
 * silent-failure class. Mounted at the ROOT route beside `ImpersonationBanner`,
 * whose shape it follows (fixed strip + in-flow spacer, so nothing sits
 * underneath it unreachable) — offset below it when both are up, since two
 * `fixed top-0` strips otherwise hide one another.
 *
 * The reload is USER-TRIGGERED, not automatic, and that is a deliberate
 * departure from "banner + reload". Note what a classic tab actually holds: a
 * COMPLETE resident store, so nothing here is about a windowed store being
 * mistaken for the model. The danger is durability — a classic session does not
 * journal its entity writes (the entity-intent capture is gated on `bfsActive`),
 * so an edit made after the promotion is refused by the server's baseline fence
 * and leaves no trace to replay. That is the loss the promotion's quiesce
 * precondition exists to prevent, and an automatic reload would simply
 * guarantee it at a moment the user did not choose. Freezing the dangerous verb
 * immediately and letting the user pick the instant loses nothing the freeze
 * does not already stop.
 *
 * `role="status"` + `aria-live="polite"`, unlike `ImpersonationBanner`: this one
 * APPEARS mid-session, on a remote event, with focus somewhere else entirely —
 * a screen-reader user gets no other cue that the tab stopped saving.
 */
export function WorkspaceContractBanner() {
  const { t } = useTranslation()
  const stale = useAutomergeStatus((s) => s.workspaceContractStale)
  // Both strips are `fixed top-0 h-9`; rendered together they land on top of
  // each other and the lower z-index simply disappears. The in-flow spacers
  // already stack (one per banner), so only the fixed strip needs the offset.
  const stackedUnderImpersonation = useAuthStore((s) => !!s.impersonation)

  if (!stale) return null

  return (
    <>
      <div
        data-testid="workspace-contract-banner"
        role="status"
        aria-live="polite"
        className={cn(
          'fixed inset-x-0 z-[9998] flex h-9 items-center justify-center gap-3 bg-warning-bg px-4 text-warning-text shadow-md',
          stackedUnderImpersonation ? 'top-9' : 'top-0',
        )}
      >
        <RefreshCw className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate text-[12.5px] font-medium">
          {t('workspace.contractChanged.message')}
        </span>
        <button
          data-testid="workspace-contract-reload"
          onClick={() => window.location.reload()}
          className="rounded-md border border-warning-text/30 bg-warning-text/10 px-2.5 py-1 text-[11.5px] font-semibold text-warning-text transition-colors hover:bg-warning-text/20"
        >
          {t('workspace.contractChanged.reload')}
        </button>
      </div>
      {/* Spacer so the fixed banner never overlaps app content underneath it. */}
      <div aria-hidden className="h-9 shrink-0" />
    </>
  )
}
