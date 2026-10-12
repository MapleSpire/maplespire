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

import * as React from "react"
import { X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "../../lib/utils"

export interface ModalProps {
  /** Sentence-case heading shown in the modal header. */
  title: string
  onClose: () => void
  children: React.ReactNode
  /** Footer slot (action buttons, right-aligned by the caller). */
  footer?: React.ReactNode
  /** Prevent dismissal while an irreversible/pending operation must finish. */
  closeDisabled?: boolean
  /** Card width; defaults to the design system's standard 420px dialog. */
  maxWidthClassName?: string
  /** Optional sizing/layout hook for complex virtualized dialog bodies. */
  contentClassName?: string
  "data-testid"?: string
}

/**
 * Design-system modal: white raised surface, hairline border, 12px radius,
 * warm-ink scrim (`--color-modal-backdrop`), Escape + scrim-click to close.
 * Small and dependency-free on purpose — it renders in place (no portal) since
 * every caller mounts it at screen level where `fixed` already wins.
 */
export function Modal({ title, onClose, children, footer, closeDisabled = false, maxWidthClassName = "max-w-[420px]", contentClassName, ...rest }: ModalProps) {
  const { t } = useTranslation()
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !closeDisabled) onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [closeDisabled, onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-modal-backdrop px-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !closeDisabled) onClose()
      }}
      data-testid={rest["data-testid"]}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn("w-full rounded-xl border border-line bg-surface-100 p-5 shadow-xl", maxWidthClassName)}
      >
        <div className="mb-4 flex items-start justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label={t("common.close")}
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className={contentClassName}>{children}</div>
        {footer && <div className="mt-5 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}
