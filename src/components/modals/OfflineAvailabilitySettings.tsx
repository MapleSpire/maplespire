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

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Database, Download, Loader2, Pause, Play, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ModelCacheOfflineDownload, ModelCacheWorkspaceMeta } from '../../lib/modelQuery/idbSchema'
import { OfflineCacheBusyError, type OfflineCacheProgress } from '../../lib/modelQuery/modelReadCacheBootstrap'
import {
  abandonWorkspaceOfflineDownload,
  makeWorkspaceAvailableOffline,
  readWorkspaceOfflineStatus,
  removeWorkspaceOfflineCopy,
  WorkspaceOfflineCapacityError,
} from '../../lib/offline/workspaceOfflineAvailability'
import { Button } from '../ui/button'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function activeBytes(meta: ModelCacheWorkspaceMeta | null): number {
  if (!meta) return 0
  const stats = meta.generationStats[String(meta.activeGeneration)]
  return Object.values(stats?.accountedBytes ?? {}).reduce((sum, bytes) => sum + bytes, 0)
}

function progressFromDownload(job: ModelCacheOfflineDownload | undefined): OfflineCacheProgress | null {
  if (!job) return null
  switch (job.phase) {
    case 'objects': return { phase: 'objects', processed: job.objectCount, total: job.objectTotal }
    case 'connections': return { phase: 'connections', processed: job.connectionCount, total: job.connectionTotal }
    case 'diagrams': return { phase: 'diagrams', processed: job.diagramCount, total: job.diagramTotal }
    case 'verifying': return {
      phase: 'verifying',
      processed: job.objectCount + job.connectionCount + job.diagramCount,
    }
  }
}

export function OfflineAvailabilitySettings() {
  const { t } = useTranslation()
  const [meta, setMeta] = useState<ModelCacheWorkspaceMeta | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'download' | 'remove' | 'discard' | null>(null)
  const [progress, setProgress] = useState<OfflineCacheProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [persistenceWarning, setPersistenceWarning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  const refresh = async () => {
    const status = await readWorkspaceOfflineStatus()
    if (mountedRef.current) {
      setMeta(status)
      setLoading(false)
    }
  }

  useEffect(() => {
    let mounted = true
    mountedRef.current = true
    readWorkspaceOfflineStatus()
      .then((status) => { if (mounted) setMeta(status) })
      .catch(() => { if (mounted) setError(t('modalsCore.settings.offline.statusFailed')) })
      .finally(() => { if (mounted) setLoading(false) })
    return () => {
      mounted = false
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [t])

  const bytes = useMemo(() => activeBytes(meta), [meta])
  const downloadJob = meta?.offlineDownload
  const complete = meta?.coverage === 'full' && meta.pinned
  const partial = !complete && Boolean(meta && (meta.objectCount > 0 || meta.connectionCount > 0))
  const visibleProgress = progress ?? progressFromDownload(downloadJob)
  const percent = visibleProgress?.total && visibleProgress.total > 0
    ? Math.min(100, Math.round((visibleProgress.processed / visibleProgress.total) * 100))
    : null

  const download = async () => {
    const controller = new AbortController()
    abortRef.current = controller
    setBusy('download')
    setError(null)
    setPersistenceWarning(false)
    setProgress({ phase: 'preparing', processed: 0 })
    try {
      const result = await makeWorkspaceAvailableOffline({
        signal: controller.signal,
        onProgress: setProgress,
      })
      setPersistenceWarning(!result.persisted)
    } catch (cause) {
      if (controller.signal.aborted) {
        setError(null)
      } else if (cause instanceof WorkspaceOfflineCapacityError) {
        setError(t('modalsCore.settings.offline.insufficientStorage', {
          required: formatBytes(cause.capacity.desiredDerivedBytes),
          available: formatBytes(cause.capacity.budgetBytes),
        }))
      } else if (cause instanceof OfflineCacheBusyError) {
        setError(t('modalsCore.settings.offline.busyElsewhere'))
      } else {
        setError(cause instanceof Error ? cause.message : t('modalsCore.settings.offline.downloadFailed'))
      }
    } finally {
      abortRef.current = null
      setBusy(null)
      setProgress(null)
      await refresh().catch(() => undefined)
    }
  }

  const discard = async () => {
    setBusy('discard')
    setError(null)
    try {
      await abandonWorkspaceOfflineDownload()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('modalsCore.settings.offline.discardFailed'))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setBusy('remove')
    setError(null)
    try {
      await removeWorkspaceOfflineCopy()
      setPersistenceWarning(false)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('modalsCore.settings.offline.removeFailed'))
    } finally {
      setBusy(null)
    }
  }

  const phaseLabel = visibleProgress
    ? t(`modalsCore.settings.offline.phases.${visibleProgress.phase}`)
    : null

  const stateKey = busy === 'download'
    ? 'downloading'
    : downloadJob?.status === 'blocked-quota'
      ? 'quotaBlocked'
      : downloadJob?.status === 'failed'
        ? 'failed'
        : downloadJob?.status === 'paused'
          ? 'paused'
          : downloadJob
            ? 'interrupted'
            : complete
              ? 'complete'
              : partial
                ? 'partial'
                : 'onlineOnly'

  return (
    <section data-testid="settings-offline-section">
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
        <Database className="h-3 w-3" /> {t('modalsCore.settings.offline.title')}
      </h3>
      <div className="rounded-lg border border-line bg-surface-50 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-fg">{t('modalsCore.settings.offline.versionTitle')}</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-fg-subtle">
              {t('modalsCore.settings.offline.description')}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-1 text-[10px] text-fg-secondary">
            {loading || busy === 'remove' || busy === 'discard' ? <Loader2 className="h-3 w-3 animate-spin" />
              : stateKey === 'complete' ? <CheckCircle2 className="h-3 w-3 text-success-text" />
                : stateKey === 'onlineOnly' ? <Database className="h-3 w-3" />
                  : stateKey === 'downloading' ? <Download className="h-3 w-3 text-accent" />
                    : <AlertTriangle className="h-3 w-3 text-warning-text" />}
            {t(`modalsCore.settings.offline.states.${stateKey}`)}
          </span>
        </div>

        {meta && bytes > 0 && (
          <p className="mt-2 text-[10.5px] text-fg-subtle">
            {t('modalsCore.settings.offline.cachedSize', {
              size: formatBytes(bytes),
              objects: meta.objectCount,
              connections: meta.connectionCount,
            })}
          </p>
        )}

        {visibleProgress && (busy === 'download' || Boolean(downloadJob)) && (
          <div className="mt-3" aria-live="polite">
            <div className="mb-1 flex items-center justify-between text-[10.5px] text-fg-secondary">
              <span>{phaseLabel}</span>
              <span>{percent !== null ? `${percent}%` : visibleProgress.processed.toLocaleString()}</span>
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-surface-200"
              role="progressbar"
              aria-label={phaseLabel ?? undefined}
              aria-valuemin={0}
              aria-valuemax={visibleProgress.total ?? undefined}
              aria-valuenow={visibleProgress.total !== undefined ? visibleProgress.processed : undefined}
            >
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${percent ?? 12}%` }}
              />
            </div>
          </div>
        )}

        {persistenceWarning && (
          <p className="mt-2 flex items-start gap-1.5 text-[10.5px] text-warning-text">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            {t('modalsCore.settings.offline.persistenceWarning')}
          </p>
        )}
        {downloadJob?.status === 'blocked-quota' && !error && (
          <p className="mt-2 flex items-start gap-1.5 text-[10.5px] text-warning-text">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            {t('modalsCore.settings.offline.quotaPaused')}
          </p>
        )}
        {error && <p className="mt-2 text-[10.5px] text-error-text" role="alert">{error}</p>}

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {busy === 'download' ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => abortRef.current?.abort()}>
              <Pause className="h-3 w-3" />
              {t('modalsCore.settings.offline.pause')}
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={() => void download()} disabled={loading || Boolean(busy)}>
              {downloadJob ? <Play className="h-3 w-3" /> : <Download className="h-3 w-3" />}
              {downloadJob
                ? t('modalsCore.settings.offline.resume')
                : complete
                ? t('modalsCore.settings.offline.refresh')
                : t('modalsCore.settings.offline.makeAvailable')}
            </Button>
          )}
          {downloadJob && busy !== 'download' && (
            <Button type="button" variant="ghost" size="sm" onClick={() => void discard()} disabled={Boolean(busy)}>
              {busy === 'discard' ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
              {t('modalsCore.settings.offline.abandon')}
            </Button>
          )}
          {(complete || partial) && !downloadJob && busy !== 'download' && (
            <Button type="button" variant="ghost" size="sm" onClick={() => void remove()} disabled={Boolean(busy)}>
              {busy === 'remove' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              {t('modalsCore.settings.offline.remove')}
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
