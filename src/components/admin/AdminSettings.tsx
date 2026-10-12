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
import { Settings2, Tags } from 'lucide-react'
import { useParams } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { getTagSettings, updateTagSettings, type TagSettings } from '../../lib/tags/api'
import { InlineError, SectionCard } from './shared'
import { Switch } from '../ui/switch'

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: TagSettings }

export function AdminSettings() {
  const { orgId } = useParams({ from: '/org/$orgId/admin/settings' })
  const { t } = useTranslation()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const loadFailedMessage = t('admin.settings.loadFailed')

  const load = () => {
    setState({ status: 'loading' })
    setSaveError(null)
    void getTagSettings(orgId)
      .then((data) => setState({ status: 'ok', data }))
      .catch((cause) => setState({
        status: 'error',
        message: cause instanceof Error ? cause.message : loadFailedMessage,
      }))
  }

  useEffect(() => {
    const controller = new AbortController()
    void getTagSettings(orgId, controller.signal)
      .then((data) => setState({ status: 'ok', data }))
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setState({
            status: 'error',
            message: cause instanceof Error ? cause.message : loadFailedMessage,
          })
        }
      })
    return () => controller.abort()
  }, [loadFailedMessage, orgId])

  const update = async (patch: Partial<Pick<TagSettings, 'allowMemberTagCreation' | 'allowEditorTagGroupCreation'>>) => {
    if (state.status !== 'ok' || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const data = await updateTagSettings(orgId, {
        allowMemberTagCreation: patch.allowMemberTagCreation ?? state.data.allowMemberTagCreation,
        allowEditorTagGroupCreation: patch.allowEditorTagGroupCreation ?? state.data.allowEditorTagGroupCreation,
      }, state.data.version)
      setState({ status: 'ok', data })
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : t('admin.settings.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div data-testid="admin-settings" className="mx-auto w-full max-w-5xl px-8 py-8">
      <div className="mb-6 flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-100">
          <Settings2 className="h-4 w-4 text-fg-secondary" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-[20px] font-semibold text-fg">{t('admin.settings.title')}</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-fg-secondary">{t('admin.settings.subtitle')}</p>
        </div>
      </div>

      {state.status === 'error' && <InlineError message={state.message} onRetry={load} />}
      {state.status === 'loading' && <div className="h-[260px] animate-pulse rounded-xl border border-line bg-surface-100" />}

      {state.status === 'ok' && (
        <SectionCard>
          <div className="flex items-center gap-2 border-b border-line px-5 py-4">
            <Tags className="h-4 w-4 text-fg-secondary" aria-hidden="true" />
            <div>
              <h2 className="text-[13px] font-semibold text-fg">{t('admin.settings.tags.title')}</h2>
              <p className="mt-0.5 text-[11.5px] text-fg-subtle">{t('admin.settings.tags.description')}</p>
            </div>
          </div>
          <div className="divide-y divide-line px-5">
            <PolicyRow
              title={t('admin.settings.tags.memberCreationTitle')}
              description={t('admin.settings.tags.memberCreationDescription')}
              checked={state.data.allowMemberTagCreation}
              disabled={saving}
              onChange={(checked) => void update({ allowMemberTagCreation: checked })}
            />
            <PolicyRow
              title={t('admin.settings.tags.editorGroupCreationTitle')}
              description={t('admin.settings.tags.editorGroupCreationDescription')}
              checked={state.data.allowEditorTagGroupCreation}
              disabled={saving}
              onChange={(checked) => void update({ allowEditorTagGroupCreation: checked })}
            />
          </div>
          <div className="flex min-h-10 items-center justify-between border-t border-line px-5 py-2.5">
            <span className="text-[10.5px] text-fg-subtle">{t('admin.settings.tags.serverEnforced')}</span>
            {saving && <span className="text-[11px] text-fg-subtle">{t('admin.settings.saving')}</span>}
            {saveError && <span role="alert" className="text-[11px] text-error-text">{saveError}</span>}
          </div>
        </SectionCard>
      )}
    </div>
  )
}

function PolicyRow({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string
  description: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-8 py-5">
      <div className="max-w-2xl">
        <p className="text-[13px] font-medium text-fg">{title}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-fg-secondary">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-label={title}
        className="mt-0.5"
      />
    </div>
  )
}
