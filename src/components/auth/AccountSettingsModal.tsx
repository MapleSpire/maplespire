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
import { Copy, KeyRound, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../stores/authStore'
import * as api from '../../lib/auth/api'
import { listAiTokens, createAiToken, revokeAiToken, resolveAiPublicBaseUrl, type AiTokenInfo } from '../../lib/ai/api'
import { Modal } from '../ui/modal'
import { Input } from '../ui/input'
import { Button } from '../ui/button'

/** Small profile editor (first/last name) opened from the account menu.
 * Email and display name stay IdP-owned and read-only here. */
export function AccountSettingsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)

  const [givenName, setGivenName] = useState(user?.givenName ?? '')
  const [familyName, setFamilyName] = useState(user?.familyName ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  if (!user) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const updated = await api.updateProfile({ givenName: givenName.trim(), familyName: familyName.trim() })
      setUser(updated)
      setSaved(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('account.settings')} onClose={onClose} data-testid="account-settings-modal">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-fg-secondary">{t('accountSettings.email')}</span>
          <p className="truncate text-[13px] text-fg" data-testid="account-settings-email">
            {user.email}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="account-given-name" className="text-[12px] font-medium text-fg-secondary">
            {t('accountSettings.firstName')}
          </label>
          <Input
            id="account-given-name"
            data-testid="account-given-name"
            value={givenName}
            maxLength={100}
            onChange={(e) => {
              setGivenName(e.target.value)
              setSaved(false)
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="account-family-name" className="text-[12px] font-medium text-fg-secondary">
            {t('accountSettings.lastName')}
          </label>
          <Input
            id="account-family-name"
            data-testid="account-family-name"
            value={familyName}
            maxLength={100}
            onChange={(e) => {
              setFamilyName(e.target.value)
              setSaved(false)
            }}
          />
        </div>

        {error && (
          <div className="rounded-lg border border-line bg-error-bg px-3 py-2 text-[12.5px] text-error-text">{error}</div>
        )}
        {saved && !error && (
          <p className="text-[12.5px] text-success-text" data-testid="account-settings-saved">
            {t('accountSettings.profileSaved')}
          </p>
        )}

        <div className="mt-2 flex items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button type="submit" data-testid="account-settings-save" disabled={busy}>
            {busy ? t('accountSettings.saving') : t('common.save')}
          </Button>
        </div>
      </form>

      <ApiTokensSection />
    </Modal>
  )
}

/**
 * Personal API tokens for AI agents (MCP / tool REST API). The plaintext
 * token is displayed exactly once at creation; only a hash is stored.
 */
function ApiTokensSection() {
  const { t, i18n } = useTranslation()
  const apiBase = resolveAiPublicBaseUrl()
  const [tokens, setTokens] = useState<AiTokenInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [freshToken, setFreshToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = () => {
    listAiTokens()
      .then((res) => setTokens(res.tokens))
      .catch((err) => setError(err instanceof Error ? err.message : t('accountSettings.errors.loadTokens')))
  }
  // t is only read for the rare non-Error fallback message; refiring on every language
  // switch would be wasteful.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, [])

  const handleCreate = async () => {
    if (!name.trim() || creating) return
    setCreating(true)
    setError(null)
    try {
      const { token } = await createAiToken(name.trim())
      setFreshToken(token)
      setCopied(false)
      setName('')
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('accountSettings.errors.createToken'))
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (id: string) => {
    setError(null)
    try {
      await revokeAiToken(id)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('accountSettings.errors.revokeToken'))
    }
  }

  return (
    <div className="mt-5 border-t border-line pt-4" data-testid="api-tokens-section">
      <div className="mb-1 flex items-center gap-1.5">
        <KeyRound className="h-3.5 w-3.5 text-fg-secondary" />
        <h3 className="text-[13px] font-semibold text-fg">{t('accountSettings.apiTokens.title')}</h3>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-fg-secondary">
        {t('accountSettings.apiTokens.description')}{' '}
        <code className="rounded bg-surface-50 px-1 py-0.5 font-mono text-[11px]">{apiBase}/mcp</code>.
      </p>

      {freshToken && (
        <div className="mb-3 rounded-lg border border-accent/40 bg-accent-subtle p-3" data-testid="fresh-token">
          <p className="m-0 mb-1.5 text-[11.5px] font-medium text-fg">
            {t('accountSettings.apiTokens.copyNowWarning')}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-line bg-surface-100 px-2 py-1.5 font-mono text-[11px] text-fg">
              {freshToken}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(freshToken).then(() => setCopied(true))
              }}
              title={t('accountSettings.apiTokens.copyToken')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface-100 text-fg-secondary hover:bg-surface-hover"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
          {copied && <p className="m-0 mt-1 text-[11px] text-fg-secondary">{t('accountSettings.apiTokens.copied')}</p>}
        </div>
      )}

      <div className="mb-3 flex items-center gap-2">
        <Input
          value={name}
          data-testid="token-name-input"
          placeholder={t('accountSettings.apiTokens.namePlaceholder')}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void handleCreate()
            }
          }}
        />
        <Button type="button" data-testid="token-create" disabled={!name.trim() || creating} onClick={() => void handleCreate()}>
          {creating ? t('accountSettings.apiTokens.creating') : t('accountSettings.apiTokens.create')}
        </Button>
      </div>

      {error && (
        <div className="mb-2 rounded-lg border border-line bg-error-bg px-3 py-2 text-[12px] text-error-text">{error}</div>
      )}

      {tokens && tokens.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {tokens.map((token) => (
            <li
              key={token.id}
              className="flex items-center gap-2 rounded-lg border border-line bg-surface-50 px-2.5 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-fg">{token.name}</div>
                <div className="font-mono text-[10.5px] text-fg-muted">
                  {t('accountSettings.apiTokens.createdOn', {
                    prefix: token.tokenPrefix,
                    date: new Date(token.createdAt).toLocaleDateString(i18n.language),
                  })}
                  {token.lastUsedAt
                    ? t('accountSettings.apiTokens.lastUsedOn', { date: new Date(token.lastUsedAt).toLocaleDateString(i18n.language) })
                    : t('accountSettings.apiTokens.neverUsed')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleRevoke(token.id)}
                title={t('accountSettings.apiTokens.revokeToken')}
                data-testid={`token-revoke-${token.name}`}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-hover hover:text-error-text"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {tokens && tokens.length === 0 && !freshToken && (
        <p className="m-0 text-[12px] text-fg-subtle">{t('accountSettings.apiTokens.noTokensYet')}</p>
      )}
    </div>
  )
}
