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

import { useEffect, useRef, useState } from 'react'
import {
  Layers, GitBranch, Check, ChevronDown, Plus, Star, Copy, Pencil, Trash2, Loader2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { CURRENT_VERSION_ID } from '../../lib/automerge/workspace'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useModelStore } from '../../stores/modelStore'

/**
 * Workspace context for the top header mega-menu: switch between
 * landscapes and between a landscape's editable versions; set a version as the
 * landscape default; create / rename / delete / duplicate landscapes and versions.
 * Each version is its own editable Automerge root, so switching loads a different
 * workspace.
 */
export function WorkspaceMenu({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<'landscape' | 'version' | null>(null)
  const [newLsName, setNewLsName] = useState('')
  const [newVerLabel, setNewVerLabel] = useState('')
  const [renaming, setRenaming] = useState<{ type: 'landscape' | 'version'; id: string } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const renameEscaped = useRef(false)

  // View-only session (a "View" grant on the booted workspace at AUTH stage
  // 'on'): the server 403s every landscape/version mutation, so don't offer the
  // controls at all — switching between landscapes/versions stays available
  // (those are reads). Mirrors the canvas/editor read-only lock; enforcement is
  // server-side regardless. Multi-landscape note: this reflects the CURRENT
  // workspace's write access; a viewer here who can edit ANOTHER landscape sees
  // its controls once they switch into it.
  const workspaceReadOnly = useModelStore((s) => s.workspaceReadOnly)
  const canManage = !workspaceReadOnly

  const ref = useWorkspaceStore((s) => s.ref)
  const landscapes = useWorkspaceStore((s) => s.landscapes)
  const loading = useWorkspaceStore((s) => s.loading)
  const busy = useWorkspaceStore((s) => s.busy)
  const error = useWorkspaceStore((s) => s.error)
  const load = useWorkspaceStore((s) => s.load)
  const switchTo = useWorkspaceStore((s) => s.switchTo)
  const newLandscape = useWorkspaceStore((s) => s.newLandscape)
  const newVersion = useWorkspaceStore((s) => s.newVersion)
  const makeDefault = useWorkspaceStore((s) => s.makeDefault)
  const renameLandscape = useWorkspaceStore((s) => s.renameLandscape)
  const renameVersion = useWorkspaceStore((s) => s.renameVersion)
  const removeLandscape = useWorkspaceStore((s) => s.removeLandscape)
  const removeVersion = useWorkspaceStore((s) => s.removeVersion)

  // NOTE: switching/creating/deleting a landscape or version now moves the URL to
  // the new ref itself (workspaceStore → navigateToWorkspaceRef), so the menu no
  // longer needs to clear a stale route after a switch.

  useEffect(() => { void load() }, [load])

  const activeLandscape = landscapes.find((l) => l.id === ref.landscapeId)
  const landscapeName = activeLandscape?.name ?? ref.landscapeId
  const versions = activeLandscape?.versions ?? []
  const followingDefault = ref.versionId === CURRENT_VERSION_ID
  const activeVersionId = followingDefault ? activeLandscape?.defaultVersionId : ref.versionId
  const activeVersion = versions.find((v) => v.id === activeVersionId)
  const versionLabel = activeVersion ? activeVersion.label : t('layoutNav.workspaceMenu.currentVersion')

  const rowClass = 'flex items-center justify-between w-full px-3 py-2 text-[12px] rounded-md hover:bg-surface-50'
  const itemClass = 'flex items-center justify-between gap-2 w-full px-3 py-1.5 text-[12px] rounded-md hover:bg-surface-50'
  const iconBtn = 'p-1 rounded hover:bg-surface-100 shrink-0 text-fg-subtle opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-40'

  const doSwitchLandscape = async (id: string) => {
    await switchTo(id, CURRENT_VERSION_ID)
    setExpanded('version')
  }
  const doSwitchVersion = async (versionId: string) => {
    await switchTo(ref.landscapeId, versionId)
    onClose()
  }
  const addLandscape = async () => {
    const n = newLsName.trim()
    if (!n) return
    setNewLsName('')
    await newLandscape(n)
    onClose()
  }
  const addVersion = async () => {
    const l = newVerLabel.trim()
    if (!l) return
    setNewVerLabel('')
    await newVersion(ref.landscapeId, l)
    onClose()
  }
  const duplicateVersion = async (versionId: string, label: string) => {
    await newVersion(ref.landscapeId, t('layoutNav.workspaceMenu.copySuffix', { label }), versionId)
    onClose()
  }
  const doMakeDefault = async (versionId: string) => {
    await makeDefault(ref.landscapeId, versionId)
  }

  const startRename = (type: 'landscape' | 'version', id: string, current: string) => {
    setRenaming({ type, id })
    setRenameDraft(current)
  }
  // Single commit path (called from onBlur). Enter blurs → commit; Escape sets the
  // skip flag then blurs → cancel. Avoids the Enter/Escape vs blur double-fire.
  const submitRename = async () => {
    const r = renaming
    if (!r) return
    setRenaming(null)
    if (renameEscaped.current) { renameEscaped.current = false; return }
    const value = renameDraft.trim()
    if (!value) return
    if (r.type === 'landscape') await renameLandscape(r.id, value)
    else await renameVersion(ref.landscapeId, r.id, value)
  }
  const doDeleteLandscape = async (id: string, name: string) => {
    if (!window.confirm(t('layoutNav.workspaceMenu.confirmDeleteLandscape', { name }))) return
    await removeLandscape(id)
  }
  const doDeleteVersion = async (versionId: string, label: string) => {
    if (!window.confirm(t('layoutNav.workspaceMenu.confirmDeleteVersion', { label }))) return
    await removeVersion(ref.landscapeId, versionId)
  }

  const renameInput = (
    <input
      autoFocus
      value={renameDraft}
      onChange={(e) => setRenameDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') { renameEscaped.current = true; e.currentTarget.blur() }
      }}
      onBlur={() => void submitRename()}
      className="flex-1 min-w-0 px-1.5 py-0.5 text-[12px] bg-surface-50 border border-line rounded focus:outline-none focus:ring-2 focus:ring-accent"
    />
  )

  return (
    <div className="p-2 border-b border-line">
      {/* Switch landscape */}
      <button
        data-testid="workspace-landscapes"
        onClick={() => setExpanded(expanded === 'landscape' ? null : 'landscape')}
        className={cn(rowClass, 'font-medium text-fg-secondary')}
      >
        <span className="flex items-center gap-2">
          <Layers className="w-3.5 h-3.5 text-fg-subtle" />
          {t('layoutNav.workspaceMenu.switchLandscape')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-[11px] text-fg-subtle max-w-[140px] truncate">{landscapeName}</span>
          {busy && <Loader2 className="w-3 h-3 text-fg-subtle animate-spin" />}
          <ChevronDown className={cn('w-3 h-3 text-fg-subtle transition-transform', expanded === 'landscape' && 'rotate-180')} />
        </span>
      </button>
      {expanded === 'landscape' && (
        <div className="pl-3 pr-1 pb-1">
          {loading && <Loading />}
          {landscapes.map((l) => {
            const isRenaming = renaming?.type === 'landscape' && renaming.id === l.id
            const isActive = l.id === ref.landscapeId
            return (
              <div key={l.id} data-testid={`landscape-row-${l.id}`} className={cn('group flex items-center gap-1 px-3 py-1.5 rounded-md hover:bg-surface-50', isActive && !isRenaming && 'bg-accent-subtle')}>
                {isRenaming ? renameInput : (
                  <>
                    <button
                      data-testid="landscape-switch"
                      data-landscape-id={l.id}
                      onClick={() => void doSwitchLandscape(l.id)}
                      disabled={busy}
                      className={cn('flex items-center gap-2 min-w-0 flex-1 text-left text-[12px]', isActive ? 'text-accent' : 'text-fg-secondary')}
                    >
                      <span className="truncate">{l.name}</span>
                      {isActive && <Check className="w-3.5 h-3.5 shrink-0" />}
                    </button>
                    {canManage && (
                      <>
                        <button onClick={() => startRename('landscape', l.id, l.name)} disabled={busy} title={t('layoutNav.workspaceMenu.renameLandscape')} className={iconBtn}>
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          data-testid="landscape-delete"
                          onClick={() => void doDeleteLandscape(l.id, l.name)}
                          disabled={busy || landscapes.length <= 1}
                          title={landscapes.length <= 1 ? t('layoutNav.workspaceMenu.cannotDeleteOnlyLandscape') : t('layoutNav.workspaceMenu.deleteLandscape')}
                          className={cn(iconBtn, 'hover:text-error-text')}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            )
          })}
          {canManage && (
            <div className="flex items-center gap-2 px-3 pt-2">
              <input
                type="text"
                data-testid="new-landscape-name"
                value={newLsName}
                onChange={(e) => setNewLsName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void addLandscape() }}
                placeholder={t('layoutNav.workspaceMenu.newLandscapePlaceholder')}
                className="flex-1 min-w-0 px-2 py-1.5 text-[12px] bg-surface-50 border border-line rounded-md focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
              />
              <button
                data-testid="new-landscape-add"
                onClick={() => void addLandscape()}
                disabled={busy || !newLsName.trim()}
                className="flex items-center gap-1 text-[11px] px-2 py-1.5 rounded-md bg-accent text-accent-text hover:bg-accent-hover disabled:opacity-40"
              >
                <Plus className="w-3 h-3" /> {t('layoutNav.workspaceMenu.add')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Version */}
      <button
        data-testid="workspace-versions"
        onClick={() => setExpanded(expanded === 'version' ? null : 'version')}
        className={cn(rowClass, 'font-medium text-fg-secondary')}
      >
        <span className="flex items-center gap-2">
          <GitBranch className="w-3.5 h-3.5 text-fg-subtle" />
          {t('layoutNav.workspaceMenu.version')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-[11px] text-fg-subtle max-w-[140px] truncate">
            {versionLabel}{followingDefault ? ` · ${t('layoutNav.workspaceMenu.defaultSuffix')}` : ''}
          </span>
          <ChevronDown className={cn('w-3 h-3 text-fg-subtle transition-transform', expanded === 'version' && 'rotate-180')} />
        </span>
      </button>
      {expanded === 'version' && (
        <div className="pl-3 pr-1 pb-1">
          {/* Follow-default entry */}
          <button
            data-testid="version-follow-default"
            onClick={() => void doSwitchVersion(CURRENT_VERSION_ID)}
            disabled={busy}
            className={cn(itemClass, followingDefault ? 'bg-accent-subtle text-accent' : 'text-fg-secondary')}
          >
            <span>{t('layoutNav.workspaceMenu.currentFollowDefault')}</span>
            {followingDefault && <Check className="w-3.5 h-3.5 shrink-0" />}
          </button>

          {loading && <Loading />}
          {versions.map((v) => {
            const isActive = !followingDefault && v.id === ref.versionId
            const isDefault = v.id === activeLandscape?.defaultVersionId
            const isRenaming = renaming?.type === 'version' && renaming.id === v.id
            return (
              <div key={v.id} data-testid={`version-row-${v.id}`} data-default={isDefault ? 'true' : 'false'} data-active={isActive ? 'true' : 'false'} className={cn('group flex items-center gap-1 px-3 py-1.5 rounded-md hover:bg-surface-50', isActive && !isRenaming && 'bg-accent-subtle')}>
                {isRenaming ? renameInput : (
                  <>
                    <button
                      data-testid="version-switch"
                      onClick={() => void doSwitchVersion(v.id)}
                      disabled={busy}
                      className={cn('flex items-center gap-2 min-w-0 flex-1 text-left text-[12px]', isActive ? 'text-accent' : 'text-fg-secondary')}
                    >
                      <span className="truncate">{v.label}</span>
                      {isDefault && <span className="text-[10px] text-fg-subtle shrink-0">{t('layoutNav.workspaceMenu.defaultBadge')}</span>}
                      {isActive && <Check className="w-3.5 h-3.5 shrink-0" />}
                    </button>
                    {canManage && (
                      <>
                        <button onClick={() => startRename('version', v.id, v.label)} disabled={busy} title={t('layoutNav.workspaceMenu.renameVersion')} className={iconBtn}>
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button data-testid="version-duplicate" onClick={() => void duplicateVersion(v.id, v.label)} disabled={busy} title={t('layoutNav.workspaceMenu.duplicateVersion')} className={iconBtn}>
                          <Copy className="w-3 h-3" />
                        </button>
                        <button
                          data-testid={`version-make-default-${v.id}`}
                          onClick={() => void doMakeDefault(v.id)}
                          disabled={busy || isDefault}
                          title={isDefault ? t('layoutNav.workspaceMenu.isDefaultVersion') : t('layoutNav.workspaceMenu.makeDefault')}
                          className={cn('p-1 rounded hover:bg-surface-100 shrink-0 disabled:opacity-40', isDefault ? 'text-accent' : 'text-fg-subtle opacity-0 group-hover:opacity-100 transition-opacity')}
                        >
                          <Star className={cn('w-3 h-3', isDefault && 'fill-current')} />
                        </button>
                        <button
                          data-testid="version-delete"
                          onClick={() => void doDeleteVersion(v.id, v.label)}
                          disabled={busy || isDefault || versions.length <= 1}
                          title={isDefault ? t('layoutNav.workspaceMenu.setAnotherDefaultFirst') : versions.length <= 1 ? t('layoutNav.workspaceMenu.cannotDeleteOnlyVersion') : t('layoutNav.workspaceMenu.deleteVersion')}
                          className={cn(iconBtn, 'hover:text-error-text')}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            )
          })}

          {/* New version */}
          {canManage && (
            <>
              <div className="flex items-center gap-2 px-3 pt-2">
                <input
                  type="text"
                  data-testid="new-version-label"
                  value={newVerLabel}
                  onChange={(e) => setNewVerLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addVersion() }}
                  placeholder={t('layoutNav.workspaceMenu.newVersionPlaceholder')}
                  className="flex-1 min-w-0 px-2 py-1.5 text-[12px] bg-surface-50 border border-line rounded-md focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                />
                <button
                  data-testid="new-version-add"
                  onClick={() => void addVersion()}
                  disabled={busy || !newVerLabel.trim()}
                  className="flex items-center gap-1 text-[11px] px-2 py-1.5 rounded-md bg-accent text-accent-text hover:bg-accent-hover disabled:opacity-40"
                >
                  <Plus className="w-3 h-3" /> {t('layoutNav.workspaceMenu.add')}
                </button>
              </div>
              <p className="px-3 pt-1.5 text-[10px] text-fg-subtle">{t('layoutNav.workspaceMenu.versionHoverHint')}</p>
            </>
          )}

          {error && <p data-testid="workspace-error" className="px-3 pt-1.5 text-[11px] text-error-text">{error}</p>}
        </div>
      )}
    </div>
  )
}

function Loading() {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-fg-subtle">
      <Loader2 className="w-3 h-3 animate-spin" /> {t('common.loading')}
    </div>
  )
}
