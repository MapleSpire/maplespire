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

import { useTranslation } from 'react-i18next'

/**
 * Full-panel loading state shown inside the AppShell until the Automerge bridge
 * has hydrated and the first projection has landed (`useAutomergeStatus.ready`).
 *
 * Without it, non-canvas views (model objects, connections, dependencies, …)
 * render against an empty-then-suddenly-full store, and on a large model the
 * synchronous boot work blocks the main thread with no feedback. Gating the view
 * here gives every view a consistent loading indicator. Mirrors the canvas
 * spinner so the experience is identical across views.
 */
export function AppLoading() {
  const { t } = useTranslation()
  return (
    <div className="w-full h-full bg-surface-50 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-line border-t-accent rounded-full animate-spin" />
        <span className="text-[13px] text-fg-subtle">{t('layoutChrome.loading.model')}</span>
      </div>
    </div>
  )
}
