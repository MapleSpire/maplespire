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

import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Plus, X, Link2, FileText, LayoutGrid, GitBranch, Loader2, Unlink2, CircleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { cn, generateId } from '../../lib/utils'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { isRegistrySummaryOnlyActive } from '../../lib/automerge/bridge'
import { isServerReadModelEnabled } from '../../lib/modelQuery/tierFlag'
import { fetchDiagramMeta } from '../../lib/modelQuery/diagramMeta'
import { fetchDecisionRecordDetail } from '../../lib/modelQuery/decisionRecords'
import { lookupFromArray } from '../../lib/refs/resolve'
import {
  decisionRecordLinkLabel,
  resolveADRLink,
  type ResolvedADRLink,
} from './adrLinkResolution'
import type { ADRLink, ADRLinkType } from '../../types'

interface ADRRelatedLinksProps {
  links: ADRLink[]
  editable?: boolean
  onChange: (links: ADRLink[]) => void
  /** The record these links belong to, excluded from the picker so a record
   *  cannot be made to link to itself. */
  selfId?: string
}

function linkTypeConfig(t: TFunction): Record<ADRLinkType, { label: string; icon: React.ElementType }> {
  return {
    url: { label: t('decisionRecords.relatedLinks.type.url'), icon: Link2 },
    adr: { label: t('decisionRecords.relatedLinks.type.adr'), icon: FileText },
    diagram: { label: t('decisionRecords.relatedLinks.type.diagram'), icon: LayoutGrid },
    draft: { label: t('decisionRecords.relatedLinks.type.draft'), icon: GitBranch },
  }
}

export function ADRRelatedLinks({ links, editable = false, onChange, selfId }: ADRRelatedLinksProps) {
  const { t } = useTranslation()
  const LINK_TYPE_CONFIG = useMemo(() => linkTypeConfig(t), [t])
  const [open, setOpen] = useState(false)
  const [linkType, setLinkType] = useState<ADRLinkType>('url')
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [targetId, setTargetId] = useState('')
  const popoverRef = useRef<HTMLDivElement>(null)

  const decisionRecords = useModelStore((s) => s.decisionRecords)
  const diagrams = useModelStore((s) => s.diagrams)

  /** Targets a resolve-on-click probe found missing. A 404 from the server —
   *  which sees the whole collection — is the proof a windowed client cannot
   *  derive for itself, so it is what lets `unknown` become `dangling` here. */
  const [deadTargetIds, setDeadTargetIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Both resident collections can be a WINDOW rather than the whole thing: the
  // diagram registry is a single server-fed entry under a summary-only
  // workspace, and the ADR list is a bounded page once the server tier answers.
  // Where that is true a miss proves nothing and must resolve to `unknown`.
  //
  // Both flags are read HERE, into the dependency arrays, and not
  // inside the memo bodies. A `useMemo` keyed on props alone whose body reads
  // module state serves the stale answer for ever after that state changes —
  // and `isRegistrySummaryOnlyActive()` is a plain module value in the bridge,
  // not a subscribed store value, so it flips on a workspace switch with no
  // prop moving with it. The lookup would then keep saying "complete" about a
  // window, i.e. keep resolving a live diagram to "missing". The Diagrams page
  // follows the same rule.
  const registrySummaryOnly = isRegistrySummaryOnlyActive()
  const serverReadModel = isServerReadModelEnabled()
  const diagramLookup = useMemo(
    () => lookupFromArray(diagrams, { complete: !registrySummaryOnly, deleted: deadTargetIds }),
    [diagrams, deadTargetIds, registrySummaryOnly],
  )
  const recordLookup = useMemo(
    () => lookupFromArray(decisionRecords, { complete: !serverReadModel, deleted: deadTargetIds }),
    [decisionRecords, deadTargetIds, serverReadModel],
  )
  const resolved = useMemo(
    () => new Map(links.map((link) => [link.id, resolveADRLink(link, { diagram: diagramLookup, record: recordLookup })])),
    [links, diagramLookup, recordLookup],
  )

  const targetOptions = useMemo(() => {
    switch (linkType) {
      case 'adr':
        return decisionRecords
          .filter((r) => r.id !== selfId)
          .map((r) => ({ id: r.id, label: decisionRecordLinkLabel(r) }))
      case 'diagram':
        return diagrams.map((d) => ({ id: d.id, label: d.name }))
      case 'draft':
        return decisionRecords
          .filter((r) => r.status === 'in-progress' && r.id !== selfId)
          .map((r) => ({ id: r.id, label: decisionRecordLinkLabel(r) }))
      default:
        return []
    }
  }, [linkType, decisionRecords, diagrams, selfId])

  const handleAdd = () => {
    if (!label.trim()) return
    if (linkType === 'url' && !url.trim()) return
    if (linkType !== 'url' && !targetId) return

    const newLink: ADRLink = {
      id: generateId(),
      type: linkType,
      label: label.trim(),
      ...(linkType === 'url' ? { url: url.trim() } : { targetId }),
    }
    onChange([...links, newLink])
    setUrl('')
    setLabel('')
    setTargetId('')
    setOpen(false)
  }

  const handleRemove = (id: string) => {
    onChange(links.filter((l) => l.id !== id))
  }

  /** Ask the server whether an off-window target exists. `true`/`false` are
   *  answers; `undefined` means the question could not be asked (offline, or the
   *  endpoint is unreachable) and must NOT be recorded as death. */
  const probeTarget = useCallback(async (kind: ResolvedADRLink['kind'], id: string): Promise<boolean | undefined> => {
    try {
      if (kind === 'diagram') return Boolean(await fetchDiagramMeta(id))
      await fetchDecisionRecordDetail(id)
      return true
    } catch (error) {
      if ((error as { status?: number } | null)?.status === 404) return false
      return undefined
    }
  }, [])

  const handleNavigate = useCallback(async (link: ADRLink, target: ResolvedADRLink) => {
    if (target.state === 'dangling') return
    if (target.kind === 'url') {
      if (target.href) window.open(target.href, '_blank', 'noopener,noreferrer')
      return
    }
    const id = link.targetId
    if (!id) return

    if (target.state === 'unknown') {
      // The click is what resolves an unknown reference. Navigating first would
      // deselect the record the user is reading and land them on the "nothing
      // selected" pane with no way back.
      setResolvingId(link.id)
      const exists = await probeTarget(target.kind, id)
      if (!mountedRef.current) return
      setResolvingId(null)
      if (exists === false) {
        setDeadTargetIds((prev) => new Set(prev).add(id))
        return
      }
      // `undefined` — unproven. Fall through and let the destination report.
    }

    if (target.kind === 'diagram') {
      useModelStore.getState().setCurrentDiagram(id)
      useUIStore.getState().setCurrentView('diagram')
      return
    }
    useUIStore.getState().setSelectedADRId(id)
  }, [probeTarget])

  const issueTitle = (target: ResolvedADRLink): string | undefined => {
    switch (target.issue) {
      case 'deleted': return t('decisionRecords.relatedLinks.deletedTarget')
      case 'unsupported-type': return t('decisionRecords.relatedLinks.unsupportedType')
      case 'invalid-url': return t('decisionRecords.relatedLinks.invalidUrl')
      default: return undefined
    }
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div
        data-testid="adr-related-links-track"
        className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {links.map((link) => {
          const target = resolved.get(link.id)
          if (!target) return null
          // A type this build has no config for still gets a chip; indexing the
          // config map with it would throw.
          const config = target.kind === 'unsupported' ? undefined : LINK_TYPE_CONFIG[target.kind]
          // The icon carries the state, because colour cannot: `--color-line` is
          // 1.26:1 against the chip fill in dark mode, so a dashed border is a
          // supporting cue at best. A different SHAPE reads at any contrast.
          const Icon = target.issue === 'deleted' ? Unlink2
            : target.issue !== 'none' ? CircleAlert
            : config?.icon ?? Link2
          const checking = resolvingId === link.id
          const actionable = target.state !== 'dangling'
          const text = target.label || t('decisionRecords.relatedLinks.untitled')
          const tooltip = issueTitle(target) ?? text

          // The chip is a SPAN (with a clickable label inside), never a <button>:
          // the remove × is its own button and nested buttons are invalid HTML.
          return (
            <span
              key={link.id}
              data-testid="adr-related-link"
              data-link-state={target.state}
              data-link-issue={target.issue}
              className={cn(
                'inline-flex max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-[11px]',
                actionable
                  ? 'border-line bg-surface-200 text-fg-secondary'
                  // Same text colour as a live chip, deliberately. Measured on
                  // this fill: fg-subtle 3.02:1 (dark), fg-muted 3.57:1 (light)
                  // — both under AA at 11px, and the broken chip is the ONE the
                  // user has to read to know which link to remove. The state is
                  // carried by the icon, the strike-through, the dashed border
                  // and the flatter fill; dimming it would put the message in
                  // the only channel that fails a low-vision reader.
                  : 'border-dashed border-line-strong bg-surface-100 text-fg-secondary',
              )}
            >
              {checking
                ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-fg-subtle" aria-hidden />
                // The broken-state icon inherits the chip colour rather than
                // dimming further: it is the primary signal, not decoration.
                : <Icon className={cn('h-3 w-3 shrink-0', actionable && 'text-fg-subtle')} aria-hidden />}
              {actionable ? (
                <button
                  onClick={() => { void handleNavigate(link, target) }}
                  disabled={checking}
                  title={tooltip}
                  className="block max-w-[320px] truncate whitespace-nowrap hover:text-accent hover:underline"
                >
                  {text}
                </button>
              ) : (
                <span
                  aria-disabled="true"
                  title={tooltip}
                  className={cn(
                    'block max-w-[320px] cursor-not-allowed truncate whitespace-nowrap',
                    // Only a target that USED to exist is struck through. A
                    // malformed URL or an unknown type is broken data, not a
                    // dead reference, and must not read as one.
                    target.issue === 'deleted' && 'line-through',
                  )}
                >
                  {text}
                </span>
              )}
              {editable && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleRemove(link.id)
                  }}
                  title={t('decisionRecords.relatedLinks.removeLink')}
                  className="ml-0.5 shrink-0 text-fg-subtle hover:text-error-text"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          )
        })}
      </div>

      {editable && (
        <div className="relative shrink-0" ref={popoverRef}>
          <button
            onClick={() => setOpen(!open)}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-line bg-surface-100 text-fg-subtle hover:text-fg-secondary hover:bg-surface-50 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>

          {open && (
            <div className="absolute top-full left-0 mt-1 bg-surface-100 border border-line rounded-lg shadow-xl z-50 w-[280px] p-3">
              <h4 className="text-[12px] font-semibold text-fg mb-2">{t('decisionRecords.relatedLinks.addItem')}</h4>

              <div className="space-y-2">
                <div>
                  <label className="block text-[11px] font-medium text-fg-muted mb-1">{t('decisionRecords.relatedLinks.typeLabel')}</label>
                  <div className="grid grid-cols-2 gap-1">
                    {(Object.keys(LINK_TYPE_CONFIG) as ADRLinkType[]).map((type) => {
                      const config = LINK_TYPE_CONFIG[type]
                      const TIcon = config.icon
                      return (
                        <button
                          key={type}
                          onClick={() => {
                            setLinkType(type)
                            setTargetId('')
                            setUrl('')
                          }}
                          className={cn(
                            'flex items-center gap-1.5 px-2 py-1.5 text-[11px] rounded-md border transition-colors',
                            linkType === type
                              ? 'bg-accent-subtle border-accent text-accent'
                              : 'bg-surface-100 border-line text-fg-secondary hover:bg-surface-50'
                          )}
                        >
                          <TIcon className="w-3 h-3" />
                          {config.label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {linkType === 'url' ? (
                  <div>
                    <label className="block text-[11px] font-medium text-fg-muted mb-1">{t('decisionRecords.relatedLinks.urlLabel')}</label>
                    <input
                      type="text"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://…"
                      className="w-full px-2 py-1.5 text-[12px] bg-surface-100 border border-line rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-[11px] font-medium text-fg-muted mb-1">{t('decisionRecords.relatedLinks.selectLabel')}</label>
                    <select
                      value={targetId}
                      onChange={(e) => {
                        setTargetId(e.target.value)
                        const opt = targetOptions.find((o) => o.id === e.target.value)
                        if (opt) setLabel(opt.label)
                      }}
                      className="w-full px-2 py-1.5 text-[12px] bg-surface-100 border border-line rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
                    >
                      <option value="">{t('decisionRecords.relatedLinks.choose')}</option>
                      {targetOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="block text-[11px] font-medium text-fg-muted mb-1">{t('decisionRecords.relatedLinks.labelLabel')}</label>
                  <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={t('decisionRecords.relatedLinks.displayNamePlaceholder')}
                    className="w-full px-2 py-1.5 text-[12px] bg-surface-100 border border-line rounded-md focus:outline-none focus:ring-2 focus:ring-accent"
                  />
                </div>

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    onClick={() => setOpen(false)}
                    className="px-3 py-1.5 text-[11px] text-fg-secondary hover:bg-surface-200 rounded-md transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={handleAdd}
                    className="px-3 py-1.5 text-[11px] font-medium text-on-inverse bg-inverse hover:bg-inverse-hover rounded-md transition-colors"
                  >
                    {t('decisionRecords.relatedLinks.add')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
