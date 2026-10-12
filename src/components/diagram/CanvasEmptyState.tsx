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

import { FilePlus2 } from 'lucide-react'

interface CanvasEmptyStateProps {
  title: string
  body: string
  action: string
  onCreate: () => void
}

/**
 * A canvas-level empty state, deliberately kept below the editor chrome.
 * The full-size positioning layer is click-through; only the action card is
 * interactive, so navigation and floating canvas controls remain available.
 */
export function CanvasEmptyState({ title, body, action, onCreate }: CanvasEmptyStateProps) {
  return (
    <div
      data-testid="no-diagrams"
      aria-live="polite"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6 text-center"
    >
      <div className="pointer-events-auto flex w-full max-w-[390px] flex-col items-center rounded-[18px] border border-line bg-surface-100/95 px-7 py-6 shadow-xl backdrop-blur-sm">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-[14px] border border-line-soft bg-surface-50 text-fg-secondary shadow-sm">
          <FilePlus2 className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{title}</div>
        <div className="mt-1.5 max-w-sm text-[13px] leading-5 text-fg-secondary">{body}</div>
        <button
          type="button"
          data-testid="no-diagrams-create"
          onClick={onCreate}
          className="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-[10px] bg-accent px-4 text-[13px] font-semibold text-accent-text shadow-sm transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-100"
        >
          <FilePlus2 className="h-4 w-4" aria-hidden="true" />
          {action}
        </button>
      </div>
    </div>
  )
}
