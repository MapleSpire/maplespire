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
 * An admin repointed this landscape's default version while the tab was open,
 * and the tab was HELD on the version it was already editing instead of being
 * carried to the new one — because it had unsaved work here, or because this
 * session booted from its cached root after the new default's did not arrive
 * (`notice.reason`; the button is then a retry of that boot).
 *
 * This must not be silent. The ref is untouched (still `'current'`, nothing in
 * localStorage, same address bar); only the TRANSPORT was re-pointed, so the tab
 * edits a version that is no longer the default while colleagues who boot land
 * on the new one — invisible on screen until their work stops meeting.
 *
 * Same shape as `WorkspaceContractBanner` (fixed strip + in-flow spacer, below
 * `ImpersonationBanner`, `role="status"` + `aria-live="polite"`) because it
 * appears mid-session on a remote event. Unlike that banner, the corrective
 * action (the hold) has already happened by the time this renders; the button
 * offers the move the user might still want, not a repair.
 *
 * Shown while the tab is still on the alias in this landscape — a reload or any
 * real move away ends the hold and hides it, so no dismissal rule is needed.
 */

import { useTranslation } from 'react-i18next'
import { GitBranch, X } from 'lucide-react'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { reloadWorkspace } from '../../lib/automerge/switchWorkspace'
import { useAuthStore } from '../../stores/authStore'
import { CURRENT_VERSION_ID } from '../../lib/automerge/workspace'
import { cn } from '../../lib/utils'

export function WorkspaceRepointBanner() {
  const { t } = useTranslation()
  const notice = useAutomergeStatus((s) => s.workspaceRepointNotice)
  const dismiss = useAutomergeStatus((s) => s.dismissWorkspaceRepointNotice)
  const ref = useWorkspaceStore((s) => s.ref)
  const stackedUnderImpersonation = useAuthStore((s) => !!s.impersonation)

  // Only while the tab is still following the alias in this landscape. The hold
  // never moved the ref — it re-pointed the transport — so "still on `current`
  // here" is exactly the state the notice describes, and any real move away
  // hides it without a rule to forget.
  if (!notice) return null
  if (ref.landscapeId !== notice.landscapeId || ref.versionId !== CURRENT_VERSION_ID) return null

  return (
    <>
      <div
        data-testid="workspace-repoint-banner"
        data-reason={notice.reason}
        role="status"
        aria-live="polite"
        className={cn(
          'fixed inset-x-0 z-[9998] flex h-9 items-center justify-center gap-3 bg-info-bg px-4 text-info-text shadow-md',
          stackedUnderImpersonation ? 'top-9' : 'top-0',
        )}
      >
        <GitBranch className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate text-[12.5px] font-medium">
          {notice.reason === 'boot-fallback'
            ? t('workspace.repointed.messageBootFallback')
            : t('workspace.repointed.message')}
        </span>
        <button
          data-testid="workspace-repoint-follow"
          onClick={() => {
            dismiss()
            // `reloadWorkspace`, not `switchTo`: the ref is ALREADY `'current'`
            // — the hold never moved it — and `switchWorkspace` early-returns on
            // an unchanged ref. This is the function that exists for exactly
            // this, "re-resolve what `current` points at now".
            void reloadWorkspace()
          }}
          className="rounded-md border border-info-text/30 bg-info-text/10 px-2.5 py-1 text-[11.5px] font-semibold text-info-text transition-colors hover:bg-info-text/20"
        >
          {t('workspace.repointed.follow')}
        </button>
        <button
          data-testid="workspace-repoint-dismiss"
          aria-label={t('workspace.repointed.dismiss')}
          onClick={dismiss}
          className="rounded-md p-1 text-info-text/70 transition-colors hover:bg-info-text/10 hover:text-info-text"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* Spacer so the fixed banner never overlaps app content underneath it. */}
      <div aria-hidden className="h-9 shrink-0" />
    </>
  )
}
