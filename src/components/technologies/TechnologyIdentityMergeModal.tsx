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

import { useCallback, useState } from 'react'
import { AlertTriangle, GitMerge, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { OrgTechnology } from '../../lib/orgAdmin/api'
import { Button } from '../ui/button'
import { Modal } from '../ui/modal'
import { TechnologyMergeTargetPicker } from './TechnologyMergeTargetPicker'

interface TechnologyIdentityMergeModalProps {
  source: OrgTechnology
  search: (query: string) => Promise<{ matches: OrgTechnology[] }>
  onMerge: (targetTechnologyId: string) => Promise<unknown>
  onClose: () => void
  onMerged: (target: OrgTechnology) => void
  targetFilter?: (technology: OrgTechnology) => boolean
}

export function TechnologyIdentityMergeModal({
  source,
  search,
  onMerge,
  onClose,
  onMerged,
  targetFilter,
}: TechnologyIdentityMergeModalProps) {
  const { t } = useTranslation()
  const [target, setTarget] = useState<OrgTechnology | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const searchTargets = useCallback((query: string) => search(query), [search])

  const merge = async () => {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      await onMerge(target.id)
      onMerged(target)
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : t('admin.technologies.mergeFailed', { defaultValue: 'Technology merge failed.' }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('admin.technologies.mergeIdentityTitle', {
        defaultValue: 'Merge {{name}}',
        name: source.revision.name,
      })}
      onClose={onClose}
      closeDisabled={busy}
      maxWidthClassName="max-w-[520px]"
      data-testid="technology-identity-merge-modal"
      footer={(
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={busy || !target} onClick={() => void merge()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <GitMerge className="h-3.5 w-3.5" aria-hidden="true" />}
            {t('admin.technologies.mergeIdentityAction', { defaultValue: 'Merge identity' })}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2.5 rounded-xl border border-warning-border bg-warning-bg p-3 text-[11px] leading-relaxed text-warning-text">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>
            {t('admin.technologies.mergeIdentityDescription', {
              defaultValue: 'The source becomes a redirect. The target content remains authoritative and existing object usages continue to resolve.',
            })}
          </p>
        </div>
        <TechnologyMergeTargetPicker
          sourceTechnologyId={source.id}
          value={target}
          onChange={setTarget}
          search={searchTargets}
          targetFilter={targetFilter}
          disabled={busy}
        />
        {target && (
          <div className="rounded-xl border border-line bg-surface-50 p-3 text-[11px] text-fg-secondary">
            <span className="font-semibold text-fg">{source.revision.name}</span>
            <span className="mx-2 text-fg-subtle" aria-hidden="true">→</span>
            <span className="font-semibold text-accent">{target.revision.name}</span>
          </div>
        )}
        {error && <p className="text-[11px] text-error-text">{error}</p>}
      </div>
    </Modal>
  )
}
