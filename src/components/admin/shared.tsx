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
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/button'
import { Modal } from '../ui/modal'
import { cn } from '../../lib/utils'

/** Counter card used on the admin Overview. */
export function StatCard({ label, value, testid }: { label: string; value: number | string; testid?: string }) {
  return (
    <div data-testid={testid} className="rounded-xl border border-line bg-surface-100 px-5 py-4">
      <p className="text-[12px] font-medium text-fg-subtle">{label}</p>
      <p className="mt-1.5 text-[24px] font-semibold tabular-nums text-fg">{value}</p>
    </div>
  )
}

/** Inline retry banner for a failed fetch — pages never render blank on error. */
export function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-error-bg px-4 py-3">
      <div className="flex items-center gap-2 text-[13px] text-error-text">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>{message}</span>
      </div>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {t('admin.shared.retry')}
      </Button>
    </div>
  )
}

/** Loading skeleton rows — generic width-varying bars, used across list pages. */
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-11 animate-pulse rounded-[10px] bg-surface-200" />
      ))}
    </div>
  )
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line px-6 py-12 text-center">
      <p className="text-[13px] font-medium text-fg-secondary">{title}</p>
      {description && <p className="text-[12px] text-fg-subtle">{description}</p>}
    </div>
  )
}

/**
 * Typed-confirmation danger modal — "type <expected> to confirm" reused by
 * member-remove (email) and any future destructive action. The admin
 * "danger pattern" (typed confirmation, pessimistic mutation with a busy
 * spinner on the confirm button).
 */
export function TypedConfirmModal({
  title,
  description,
  expected,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
  testidPrefix,
}: {
  title: string
  description: React.ReactNode
  expected: string
  confirmLabel?: string
  busy: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
  testidPrefix: string
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const matches = value === expected

  return (
    <Modal
      title={title}
      onClose={onCancel}
      data-testid={`${testidPrefix}-confirm`}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={!matches || busy}
            onClick={onConfirm}
            data-testid={`${testidPrefix}-confirm-submit`}
          >
            {busy ? t('admin.shared.working') : (confirmLabel ?? t('common.delete'))}
          </Button>
        </>
      }
    >
      <div className="mb-4 text-[13px] leading-relaxed text-fg-secondary">{description}</div>
      <p className="mb-1.5 text-[12px] text-fg-subtle">
        {t('admin.shared.typeToConfirmPrefix')} <span className="font-semibold text-fg">{expected}</span>{' '}
        {t('admin.shared.typeToConfirmSuffix')}
      </p>
      <input
        autoFocus
        data-testid={`${testidPrefix}-confirm-input`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-9 w-full rounded-md border border-line bg-surface-50 px-3 text-[13px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
      />
      {error && <p className="mt-2 text-[12px] text-error-text">{error}</p>}
    </Modal>
  )
}

export function SectionCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('rounded-xl border border-line bg-surface-100', className)}>{children}</div>
}
