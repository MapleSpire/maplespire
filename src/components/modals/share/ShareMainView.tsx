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
import { RefreshCw, Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../ui/badge'
import { ShareToggleRow } from './ShareToggleRow'
import { ShareLinkRow } from './ShareLinkRow'
import { ShareAudienceControl } from './ShareAudienceControl'
import { EmbedGrid } from './EmbedGrid'
import { VersionPicker } from './VersionPicker'
import { useModelStore } from '../../../stores/modelStore'
import { buildShareSnapshot } from '../../../lib/share/snapshot'
import { createShare, updateShare, listShares } from '../../../lib/share/api'
import { noteLatestShare, republishLatest } from '../../../lib/share/autoRepublish'
import { listCheckpoints, addCheckpoint } from '../../../lib/automerge/history'
import { getActiveDiagramHandle } from '../../../lib/automerge/bridge'
import type { ShareLinkMeta, ShareAudience } from '../../../lib/share/types'
import type { Checkpoint } from '../../../lib/automerge/types'

/**
 * Main Share view. Each version has its OWN link: the live "Current version" link
 * (one per diagram, auto-updating) plus one frozen link per pinned checkpoint.
 * Selecting/saving a version finds-or-creates its link without ever repointing
 * the others, so links people already hold keep working. Deactivate any of them
 * from Manage sharing.
 */
export function ShareMainView() {
  const { t } = useTranslation()
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  // Managing links (create/enable/audience/revoke) EXPOSES the workspace — the server
  // requires RBAC write, so a View-only session can't. Mirror that in the UI: existing
  // links stay visible (a read), but the management controls are disabled.
  const canManage = !useModelStore((s) => s.workspaceReadOnly)
  const [shares, setShares] = useState<ShareLinkMeta[]>([])
  const [selectedVersion, setSelectedVersion] = useState<string>('current') // 'current' | checkpointId
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [snapshotBytes, setSnapshotBytes] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const findShare = (version: string, list: ShareLinkMeta[] = shares) =>
    version === 'current'
      ? list.find((s) => s.mode === 'latest')
      : list.find((s) => s.mode === 'pinned' && s.checkpointId === version)

  const activeShare = findShare(selectedVersion)
  const enabled = activeShare?.enabled ?? false
  const token = activeShare?.token ?? null
  const publicUrl = token ? `${window.location.origin}/share/${token}` : ''
  const versionName =
    selectedVersion === 'current'
      ? t('shareDialog.mainView.currentVersionLower')
      : checkpoints.find((c) => c.id === selectedVersion)?.label ??
        activeShare?.checkpointLabel ??
        t('shareDialog.mainView.thisVersion')

  const loadCheckpoints = () => {
    const h = getActiveDiagramHandle()
    setCheckpoints(h ? listCheckpoints(h) : [])
  }
  const refreshShares = async () => {
    if (!currentDiagramId) return
    setShares(await listShares(currentDiagramId))
  }
  // Build a snapshot and remember its size, so we can warn on very large shares.
  const buildTracked = async (opts: Parameters<typeof buildShareSnapshot>[0]) => {
    const snapshot = await buildShareSnapshot(opts)
    setSnapshotBytes(JSON.stringify(snapshot).length)
    return snapshot
  }

  // Rehydrate all links for this diagram; register + refresh the live one.
  useEffect(() => {
    if (!currentDiagramId) return
    let cancelled = false
    listShares(currentDiagramId)
      .then(async (list) => {
        if (cancelled) return
        loadCheckpoints()
        setShares(list)
        const latest = list.find((s) => s.mode === 'latest')
        // Only auto-republish when we may write — a View-only session would just 403.
        if (latest?.enabled && canManage) {
          noteLatestShare(currentDiagramId, latest.token, true)
          setRefreshing(true)
          await republishLatest(currentDiagramId)
          if (!cancelled) setRefreshing(false)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [currentDiagramId, canManage])

  // Find-or-create + enable the live current-version link.
  const ensureCurrentLink = async () => {
    if (!currentDiagramId) return
    const existing = findShare('current')
    const snapshot = await buildTracked({ rootDiagramId: currentDiagramId, limitToDiagram: true })
    if (existing) {
      await updateShare(existing.token, { enabled: true, snapshot })
      noteLatestShare(currentDiagramId, existing.token, true)
    } else {
      const res = await createShare({ mode: 'latest', scope: 'diagram', diagramId: currentDiagramId, limitToDiagram: true, snapshot })
      noteLatestShare(currentDiagramId, res.token, true)
    }
  }

  // Find-or-create + enable a frozen link for a checkpoint (new token; never
  // touches the current-version link).
  const ensurePinnedLink = async (cp: Checkpoint) => {
    if (!currentDiagramId) return
    const existing = shares.find((s) => s.mode === 'pinned' && s.checkpointId === cp.id)
    if (existing) {
      if (!existing.enabled) await updateShare(existing.token, { enabled: true })
      return
    }
    // Inherit "who can open this link" from the live current-version link we're
    // freezing FROM. Without this a brand-new pinned link would fall back to the
    // create-time default and could silently WIDEN exposure (e.g. an org-only
    // current link → a public snapshot) — the sharer can't even see the new
    // link's audience yet, so it must never be looser than its source.
    const source = findShare('current')
    const snapshot = await buildTracked({
      rootDiagramId: currentDiagramId,
      limitToDiagram: true,
      heads: cp.heads,
      checkpointLabel: cp.label,
    })
    await createShare({
      mode: 'pinned',
      scope: 'diagram',
      diagramId: currentDiagramId,
      limitToDiagram: true,
      checkpointId: cp.id,
      checkpointLabel: cp.label,
      heads: cp.heads,
      snapshot,
      audience: source?.audience,
      allowedEmailDomain: source?.allowedEmailDomain ?? null,
    })
  }

  const onToggleEnabled = async (next: boolean) => {
    if (!currentDiagramId) {
      setError(t('shareDialog.mainView.openDiagramToShare'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (next) {
        if (selectedVersion === 'current') {
          await ensureCurrentLink()
        } else {
          const cp = checkpoints.find((c) => c.id === selectedVersion)
          if (cp) await ensurePinnedLink(cp)
        }
      } else if (activeShare) {
        await updateShare(activeShare.token, { enabled: false })
        if (activeShare.mode === 'latest') noteLatestShare(currentDiagramId, activeShare.token, false)
      }
      await refreshShares()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('shareDialog.mainView.somethingWentWrong'))
    } finally {
      setBusy(false)
    }
  }

  // Change WHO may open the link. 'domain' carries the entered email domain (a
  // switch to 'domain' with an empty domain stays fail-closed until one is saved).
  const changeAudience = async (audience: ShareAudience, domain?: string) => {
    if (!activeShare) return
    setBusy(true)
    setError(null)
    try {
      await updateShare(activeShare.token, {
        audience,
        allowedEmailDomain: audience === 'domain' ? (domain ?? '').trim() || null : null,
      })
      await refreshShares()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('shareDialog.mainView.somethingWentWrong'))
    } finally {
      setBusy(false)
    }
  }

  // Toggle the active link between single-diagram and whole-landscape scope.
  const onToggleLimit = async (next: boolean) => {
    if (!currentDiagramId || !activeShare) return
    setBusy(true)
    setError(null)
    try {
      const heads =
        activeShare.mode === 'pinned' && activeShare.checkpointId
          ? checkpoints.find((c) => c.id === activeShare.checkpointId)?.heads
          : undefined
      const snapshot = await buildTracked({ rootDiagramId: currentDiagramId, limitToDiagram: next, heads })
      await updateShare(activeShare.token, { limitToDiagram: next, scope: next ? 'diagram' : 'landscape', snapshot })
      await refreshShares()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('shareDialog.mainView.somethingWentWrong'))
    } finally {
      setBusy(false)
    }
  }

  // Allow/deny the viewer's 3D board toggle on this link (render-only setting —
  // the snapshot already carries the 3D layer either way).
  const onToggleAllow3d = async (next: boolean) => {
    if (!activeShare) return
    setBusy(true)
    setError(null)
    try {
      await updateShare(activeShare.token, { allow3d: next })
      await refreshShares()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('shareDialog.mainView.somethingWentWrong'))
    } finally {
      setBusy(false)
    }
  }

  const onSelectCurrent = () => setSelectedVersion('current')

  // Selecting a specific version creates its own link if one doesn't exist yet.
  const onSelectCheckpoint = async (cp: Checkpoint) => {
    setSelectedVersion(cp.id)
    if (shares.find((s) => s.mode === 'pinned' && s.checkpointId === cp.id)) return
    setBusy(true)
    setError(null)
    try {
      await ensurePinnedLink(cp)
      await refreshShares()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('shareDialog.mainView.somethingWentWrong'))
    } finally {
      setBusy(false)
    }
  }

  const onSaveNewVersion = async (label: string) => {
    const h = getActiveDiagramHandle()
    if (!h) return
    addCheckpoint(h, label)
    const cps = listCheckpoints(h)
    setCheckpoints(cps)
    const created = cps[cps.length - 1]
    if (created) await onSelectCheckpoint(created)
  }

  return (
    <div className="space-y-3">
      <ShareToggleRow
        testid="share-enable-toggle"
        label={t('shareDialog.mainView.enableShareLink', { version: versionName })}
        badge={<Badge variant="warning">{t('shareDialog.mainView.readOnly')}</Badge>}
        checked={enabled}
        onChange={onToggleEnabled}
        disabled={busy || !currentDiagramId || !canManage}
      />

      {!canManage && (
        <p className="text-[11px] text-fg-subtle">{t('shareDialog.mainView.viewOnlyNote')}</p>
      )}

      {(enabled || shares.length > 0) && (
        <>
          <VersionPicker
            selectedVersion={selectedVersion}
            checkpoints={checkpoints}
            busy={busy}
            onSelectCurrent={onSelectCurrent}
            onSelectCheckpoint={onSelectCheckpoint}
            onSaveNewVersion={onSaveNewVersion}
          />

          {enabled && activeShare ? (
            <>
              <ShareToggleRow
                testid="share-limit-toggle"
                label={t('shareDialog.mainView.limitToThisDiagram')}
                help={t('shareDialog.mainView.limitToThisDiagramHelp')}
                checked={activeShare.limitToDiagram}
                onChange={onToggleLimit}
                disabled={busy || !canManage}
              />

              {/* 3D board — may visitors flip the viewer into the perspective view? */}
              <ShareToggleRow
                testid="share-allow3d-toggle"
                label={t('shareDialog.mainView.allow3d')}
                help={t('shareDialog.mainView.allow3dHelp')}
                checked={activeShare.allow3d ?? true}
                onChange={(next) => void onToggleAllow3d(next)}
                disabled={busy || !canManage}
              />

              {/* Audience — who may open the link. */}
              <ShareAudienceControl
                audience={activeShare.audience}
                allowedEmailDomain={activeShare.allowedEmailDomain}
                disabled={busy || !canManage}
                onChange={(a, domain) => void changeAudience(a, domain)}
              />

              {publicUrl && <ShareLinkRow url={publicUrl} />}
              {activeShare.mode === 'latest' ? (
                <p className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
                  <RefreshCw className={refreshing ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
                  {refreshing
                    ? t('shareDialog.mainView.updatingToCurrentVersion')
                    : t('shareDialog.mainView.alwaysReflectsCurrentVersion')}
                </p>
              ) : (
                <p className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
                  <Lock className="h-3 w-3" />
                  {t('shareDialog.mainView.pinnedTo', { label: activeShare.checkpointLabel ?? versionName })}
                </p>
              )}
              {snapshotBytes !== null && snapshotBytes > 1_500_000 && (
                <p className="text-[11px] text-warning-text">
                  {t('shareDialog.mainView.largeShareWarning', { size: (snapshotBytes / 1_000_000).toFixed(1) })}
                </p>
              )}
              {token && <EmbedGrid token={token} />}
            </>
          ) : (
            selectedVersion !== 'current' && (
              <p className="text-[12px] text-fg-subtle">{t('shareDialog.mainView.versionLinkOff')}</p>
            )
          )}
        </>
      )}

      {!currentDiagramId && <p className="text-[12px] text-fg-subtle">{t('shareDialog.mainView.openDiagramToCreate')}</p>}
      {error && <p className="text-[12px] text-error-text">{error}</p>}
    </div>
  )
}
