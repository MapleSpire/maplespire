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
import { useTranslation } from 'react-i18next'
import * as api from '../../lib/auth/api'
import { Modal } from '../ui/modal'
import { Input } from '../ui/input'
import { Button } from '../ui/button'

/** Create-organization dialog (account menu → "New organization"). On success
 * it switches the session to the new org and HARD-reloads into /app — see
 * api.switchOrg's contract (the WS claims are bound at upgrade time). */
export function NewOrgDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const org = await api.createOrg(name.trim())
      await api.switchOrg(org.id)
      window.location.assign('/app')
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={t('account.newOrg')} onClose={onClose} data-testid="new-org-dialog">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <p className="text-[12.5px] text-fg-secondary">
          {t('accountSettings.newOrg.description')}
        </p>
        <div className="flex flex-col gap-1">
          <label htmlFor="new-org-name" className="text-[12px] font-medium text-fg-secondary">
            {t('accountSettings.newOrg.name')}
          </label>
          <Input
            id="new-org-name"
            data-testid="new-org-name"
            value={name}
            maxLength={200}
            placeholder="Acme Corp"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {error && (
          <div className="rounded-lg border border-line bg-error-bg px-3 py-2 text-[12.5px] text-error-text">{error}</div>
        )}
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" data-testid="new-org-create" disabled={busy || !name.trim()}>
            {busy ? t('accountSettings.newOrg.creating') : t('accountSettings.newOrg.create')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
