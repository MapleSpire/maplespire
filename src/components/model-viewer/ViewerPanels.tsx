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

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  ArrowUpRight,
  CornerDownRight,
  ExternalLink,
  LayoutGrid,
  Link2,
  Lock,
  Pencil,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { ShellRightPanel, ShellFieldRow } from '../layout/WorkspaceShell'
import { TechIconBadge } from '../shared/TechIconBadge'
import {
  connsForObject,
  directConns,
  hasChildren,
  type ViewerModel,
  type ObjectConn,
} from '../../lib/modelViewer/levels'
import { useLowerConns } from './useLowerConns'
import { TYPE_ICONS, TYPE_COLORS, typeTint } from './typeVisuals'
import type { C4Object, C4Type, Connection, Domain } from '../../types'
import { orderedTechnologyUsages } from '../../lib/technologyUsage'
import { objectLinkDisplayLabel, objectLinkUrl, safeExternalHref } from '../../lib/objectLinks'

/** Read-only right-panel bodies (design kit `mv-panels.jsx`): the viewer never
 * edits — every affordance links out to Model objects / Model connections /
 * the diagram editor instead. */

/** Stable empty list — keeps memo deps quiet while the rollup fetch is inflight. */
const NO_CONNS: Connection[] = []

const STATUS_COLORS: Record<C4Object['status'], string> = {
  live: 'var(--color-success)',
  draft: 'var(--color-fg-subtle)',
  down: 'var(--color-error)',
  unstable: 'var(--color-warning)',
}

function TypeGlyph({ type, size = 13 }: { type: C4Type; size?: number }) {
  const Icon = TYPE_ICONS[type]
  return <Icon style={{ width: size, height: size, color: TYPE_COLORS[type], flexShrink: 0 }} />
}

function ViewOnlyChip() {
  const { t } = useTranslation()
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-200 px-2.5 py-1 text-[9.5px] font-semibold uppercase tracking-wide text-fg-muted">
      <Lock className="h-[11px] w-[11px]" />
      {t('modelViewer.panel.viewOnly')}
    </span>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 mt-3 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle first:mt-0">{children}</div>
  )
}

function EditLink({ label, onClick, testid }: { label: string; onClick: () => void; testid?: string }) {
  return (
    <button
      data-testid={testid}
      onClick={onClick}
      className={cn(
        'mt-3 flex w-full items-center gap-2 rounded-[9px] border border-accent/25 bg-accent-subtle px-3 py-2.5',
        'text-left text-[12.5px] font-medium text-accent transition-colors hover:border-accent/40'
      )}
    >
      <Pencil className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
    </button>
  )
}

function ConnRow({ c, other, onOpen }: { c: ObjectConn; other: C4Object | undefined; onOpen: (id: string) => void }) {
  const out = c.dir === 'out'
  return (
    <button
      className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-50"
      onClick={() => onOpen(c.connection.id)}
    >
      <span className="mt-0.5 shrink-0" style={{ color: out ? 'var(--color-accent)' : 'var(--color-info)' }}>
        {out ? <ArrowUpRight className="h-[15px] w-[15px]" /> : <CornerDownRight className="h-[15px] w-[15px]" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg">
          {other && <TypeGlyph type={other.type} />}
          <span className="truncate">{other?.name ?? '—'}</span>
        </span>
        {c.connection.label && <span className="mt-0.5 block truncate text-[11px] text-fg-subtle">{c.connection.label}</span>}
      </span>
    </button>
  )
}

/* ── Object details (Details / Connections tabs) ─────────────────────────── */

export function ViewerObjectPanel({
  id,
  model,
  connections,
  domainById,
  onOpenConn,
  onOpenLower,
}: {
  id: string
  model: ViewerModel
  connections: Connection[]
  domainById: Map<string, Domain>
  onOpenConn: (id: string) => void
  /** Drill into this object's lower level (undefined = no lower level). */
  onOpenLower?: () => void
}) {
  const { t } = useTranslation()
  const setCurrentView = useUIStore((s) => s.setCurrentView)
  const setModelObjectsSearchQuery = useUIStore((s) => s.setModelObjectsSearchQuery)
  const diagrams = useModelStore((s) => s.diagrams)
  const tagSnapshots = useModelStore((s) => s.tags)
  const [tab, setTab] = useState<'details' | 'connections'>('details')

  const o = model.objectById.get(id)
  const conns = useMemo(() => connsForObject(connections, id), [connections, id])
  const diagramCount = useMemo(() => diagrams.filter((d) => d.objectIds.includes(id)).length, [diagrams, id])
  if (!o) return null
  const outs = conns.filter((c) => c.dir === 'out')
  const ins = conns.filter((c) => c.dir === 'in')
  const parent = o.parentId ? model.objectById.get(o.parentId) : undefined
  const domain = o.domainId ? domainById.get(o.domainId) : undefined

  return (
    <ShellRightPanel title={t('modelViewer.panel.objectTitle')}>
      <div data-testid="mv-object-panel" className="flex flex-col">
        <div className="flex items-start gap-2.5">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
            style={{ background: typeTint(o.type) }}
          >
            <TypeGlyph type={o.type} size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-fg">{o.name}</div>
            <div className="text-[11.5px] text-fg-subtle">
              {t(`dataViewsB.view.types.${o.type}`)} · {t(`dataViewsB.view.scope.${o.scope}`)}
            </div>
          </div>
          <ViewOnlyChip />
        </div>

        <div className="mt-3">
          <SegmentedTabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'details', label: t('modelViewer.panel.tabDetails') },
              { id: 'connections', label: t('modelViewer.panel.tabConnections', { count: conns.length }) },
            ]}
          />
        </div>

        {tab === 'details' ? (
          <div className="mt-3">
            {o.description && <p className="mb-2 text-[12px] leading-relaxed text-fg-secondary">{o.description}</p>}
            <ShellFieldRow label={t('modelViewer.panel.type')}>{t(`dataViewsB.view.types.${o.type}`)}</ShellFieldRow>
            <ShellFieldRow label={t('modelViewer.panel.scope')}>{t(`dataViewsB.view.scope.${o.scope}`)}</ShellFieldRow>
            <ShellFieldRow label={t('modelViewer.panel.status')}>
              <span className="inline-flex items-center gap-1.5">
                <i className="h-2 w-2 rounded-full" style={{ background: STATUS_COLORS[o.status] }} />
                {t(`layoutNav.rightSidebar.status.${o.status}`)}
              </span>
            </ShellFieldRow>
            {parent && (
              <ShellFieldRow label={t('modelViewer.panel.belongsTo')}>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <TypeGlyph type={parent.type} />
                  <span className="truncate">{parent.name}</span>
                </span>
              </ShellFieldRow>
            )}
            <ShellFieldRow label={t('modelViewer.panel.domain')}>
              <span className="inline-flex items-center gap-1.5">
                <i
                  className="h-2 w-2 rounded-full"
                  style={{ background: domain?.color ?? 'var(--color-fg-subtle)' }}
                />
                {domain?.name ?? t('modelViewer.panel.noDomain')}
              </span>
            </ShellFieldRow>
            <ShellFieldRow label={t('modelViewer.panel.connectionsRow')}>
              <button className="font-semibold text-accent hover:underline" onClick={() => setTab('connections')}>
                {t('modelViewer.panel.connectionsCount', { count: conns.length })}
              </button>
            </ShellFieldRow>
            <ShellFieldRow label={t('modelViewer.panel.inDiagramsRow')}>
              {t('modelViewer.panel.diagramsCount', { count: diagramCount })}
            </ShellFieldRow>

            {Object.keys(o.technologyUsages ?? {}).length > 0 && (
              <>
                <SectionTitle>{t('modelViewer.panel.technology')}</SectionTitle>
                <div className="flex flex-col gap-1.5">
                  {orderedTechnologyUsages(o.technologyUsages, o.technologyUsageOrder).map((usage) => (
                    <span key={usage.id} className="inline-flex items-center gap-2 text-[12.5px] text-fg-secondary">
                      <TechIconBadge
                        name={usage.snapshot.name}
                        iconLightPath={usage.snapshot.iconLightPath}
                        iconDarkPath={usage.snapshot.iconDarkPath}
                        size="sm"
                      />
                      {usage.snapshot.name}
                      {usage.usedVersion ? ` ${usage.usedVersion}` : ''}
                    </span>
                  ))}
                </div>
              </>
            )}

            {o.tagOrder.length > 0 && (
              <>
                <SectionTitle>{t('modelViewer.panel.tags')}</SectionTitle>
                <div className="flex flex-wrap gap-1.5">
                  {o.tagOrder.map((tagId) => (
                    <span key={tagId} className="rounded-full bg-surface-200 px-2 py-0.5 text-[11px] text-fg-secondary">
                      {tagSnapshots.find((snapshot) => snapshot.tagId === tagId)?.value ?? tagId}
                    </span>
                  ))}
                </div>
              </>
            )}

            {(o.links?.length ?? 0) > 0 && (
              <>
                <SectionTitle>{t('modelViewer.panel.links')}</SectionTitle>
                <div className="flex flex-col gap-1">
                  {o.links!.map((link, index) => {
                    const href = safeExternalHref(link)
                    const content = (
                      <>
                        <ExternalLink className="h-[13px] w-[13px] shrink-0" />
                        <span className="min-w-0">
                          <span className="block truncate">{objectLinkDisplayLabel(link)}</span>
                          {objectLinkDisplayLabel(link) !== objectLinkUrl(link) && (
                            <span className="block truncate text-[10px] text-fg-subtle">{objectLinkUrl(link)}</span>
                          )}
                        </span>
                      </>
                    )
                    return href ? (
                      <a
                        key={index}
                        href={href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1.5 text-[12.5px] text-accent hover:underline"
                      >
                        {content}
                      </a>
                    ) : <div key={index} className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-subtle">{content}</div>
                  })}
                </div>
              </>
            )}

            {onOpenLower && hasChildren(model, id) && (
              <button
                data-testid="mv-panel-open-lower"
                onClick={onOpenLower}
                className={cn(
                  'mt-3 flex w-full items-center gap-2 rounded-[9px] border border-line bg-surface-50 px-3 py-2.5',
                  'text-left text-[12.5px] font-medium text-fg-secondary transition-colors hover:border-line-strong hover:text-fg'
                )}
              >
                <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t('modelViewer.panel.openLower')}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0" />
              </button>
            )}

            <EditLink
              testid="mv-edit-object"
              label={t('modelViewer.panel.editInModelObjects')}
              onClick={() => {
                setModelObjectsSearchQuery(o.name)
                setCurrentView('model-objects')
              }}
            />
          </div>
        ) : (
          <div className="mt-3">
            {outs.length > 0 && (
              <>
                <SectionTitle>{t('modelViewer.panel.outgoing', { count: outs.length })}</SectionTitle>
                {outs.map((c) => (
                  <ConnRow key={c.connection.id} c={c} other={model.objectById.get(c.otherId)} onOpen={onOpenConn} />
                ))}
              </>
            )}
            {ins.length > 0 && (
              <>
                <SectionTitle>{t('modelViewer.panel.incoming', { count: ins.length })}</SectionTitle>
                {ins.map((c) => (
                  <ConnRow key={c.connection.id} c={c} other={model.objectById.get(c.otherId)} onOpen={onOpenConn} />
                ))}
              </>
            )}
            {conns.length === 0 && (
              <div className="py-8 text-center text-[12px] text-fg-subtle">{t('modelViewer.panel.noConnections')}</div>
            )}
            <EditLink
              label={t('modelViewer.panel.editInConnections')}
              onClick={() => setCurrentView('connections')}
            />
          </div>
        )}
      </div>
    </ShellRightPanel>
  )
}

/* ── Connection details: direct + rolled-up lower + in-diagrams ──────────── */

export function ViewerConnectionPanel({
  id,
  model,
  connections,
  onOpenObject,
}: {
  id: string
  model: ViewerModel
  connections: Connection[]
  onOpenObject: (id: string) => void
}) {
  const { t } = useTranslation()
  const setCurrentView = useUIStore((s) => s.setCurrentView)
  const setCurrentDiagram = useModelStore((s) => s.setCurrentDiagram)
  const diagrams = useModelStore((s) => s.diagrams)

  const conn = connections.find((c) => c.id === id)
  const fromId = conn?.fromId
  const toId = conn?.toId
  const from = fromId ? model.objectById.get(fromId) : undefined
  const to = toId ? model.objectById.get(toId) : undefined
  // The level window carries neither subtree objects nor cross-boundary edges,
  // so the rollup is fetched on demand through the seam when the panel opens.
  // Plain derivations (no manual useMemo): the React Compiler memoizes them,
  // and preserve-manual-memoization rejects hand-rolled memo around the hook.
  const lowerData = useLowerConns(fromId, toId)
  const lower = lowerData?.connections ?? NO_CONNS
  const direct = fromId && toId ? directConns(connections, fromId, toId) : NO_CONNS
  const summarizedIds = new Set([...direct, ...lower].map((c) => c.id))
  const inDiagrams = diagrams.filter((d) => d.connectionIds.some((cid) => summarizedIds.has(cid)))
  const lowerObject = (objectId: string) =>
    model.objectById.get(objectId) ?? lowerData?.objectById.get(objectId)
  if (!conn) return null

  const endpoint = (o: C4Object | undefined, fallbackId: string) => (
    <button
      className="inline-flex min-w-0 items-center gap-1.5 rounded-lg bg-surface-200 px-2 py-1 text-[12.5px] font-medium text-fg transition-colors hover:bg-surface-300"
      onClick={() => o && onOpenObject(o.id)}
    >
      {o && <TypeGlyph type={o.type} />}
      <span className="max-w-[110px] truncate">{o?.name ?? fallbackId}</span>
    </button>
  )

  return (
    <ShellRightPanel title={t('modelViewer.panel.connectionTitle')}>
      <div data-testid="mv-conn-panel" className="flex flex-col">
        <div className="flex items-start gap-2.5">
          <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[7px] bg-accent-subtle">
            <Link2 className="h-[13px] w-[13px] text-accent" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-fg">
              {conn.label || t('modelViewer.panel.connectionTitle')}
            </div>
            <div className="text-[11.5px] text-fg-subtle">{t('modelViewer.panel.connectionTitle')}</div>
          </div>
          <ViewOnlyChip />
        </div>

        <SectionTitle>{t('modelViewer.panel.flow')}</SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          {endpoint(from, conn.fromId)}
          <ArrowRight className="h-[15px] w-[15px] shrink-0 text-accent" />
          {endpoint(to, conn.toId)}
        </div>

        <SectionTitle>
          {direct.length > 1
            ? t('modelViewer.panel.directMany', { count: direct.length })
            : t('modelViewer.panel.direct')}
        </SectionTitle>
        <div className="flex flex-col gap-1.5">
          {direct.map((c) => (
            <div key={c.id} className="rounded-lg border border-line px-2.5 py-2">
              <div className="text-[12.5px] font-medium text-fg">{c.label || t('modelViewer.panel.directFallback')}</div>
              {c.label && <div className="mt-0.5 text-[11px] text-fg-subtle">{t('modelViewer.panel.directFallback')}</div>}
            </div>
          ))}
        </div>

        <SectionTitle>
          {lower.length > 0 ? t('modelViewer.panel.lowerCount', { count: lower.length }) : t('modelViewer.panel.lower')}
        </SectionTitle>
        {lowerData === null ? (
          // Still resolving the subtrees — stay quiet instead of claiming
          // "deepest level" before the walk lands.
          <div className="text-[12px] text-fg-subtle">…</div>
        ) : lower.length === 0 ? (
          <div className="text-[12px] text-fg-subtle">
            {lowerData.truncated ? t('modelViewer.panel.lowerTruncated') : t('modelViewer.panel.noLower')}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {lower.map((c) => {
              const a = lowerObject(c.fromId)
              const b = lowerObject(c.toId)
              return (
                <div key={c.id} className="flex items-start gap-2 px-1 py-1.5">
                  <CornerDownRight className="mt-0.5 h-[15px] w-[15px] shrink-0 text-fg-subtle" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-[12px] font-medium text-fg">
                      {a && <TypeGlyph type={a.type} />}
                      <span className="truncate">{a?.name ?? c.fromId}</span>
                      <ArrowRight className="h-3 w-3 shrink-0 text-fg-subtle" />
                      {b && <TypeGlyph type={b.type} />}
                      <span className="truncate">{b?.name ?? c.toId}</span>
                    </div>
                    {c.label && <div className="mt-0.5 truncate text-[11px] text-fg-subtle">{c.label}</div>}
                  </div>
                </div>
              )
            })}
            {lowerData.truncated && (
              <div className="px-1 py-1 text-[11px] text-fg-subtle">{t('modelViewer.panel.lowerTruncated')}</div>
            )}
          </div>
        )}

        <SectionTitle>{t('modelViewer.panel.inDiagrams', { count: inDiagrams.length })}</SectionTitle>
        {inDiagrams.length === 0 ? (
          <div className="text-[12px] text-fg-subtle">{t('modelViewer.panel.notInDiagrams')}</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {inDiagrams.map((d) => (
              <button
                key={d.id}
                data-testid="mv-conn-diagram"
                className={cn(
                  'group flex w-full items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-left',
                  'transition-colors hover:border-line-strong hover:bg-surface-50'
                )}
                onClick={() => {
                  setCurrentDiagram(d.id)
                  setCurrentView('diagram')
                }}
              >
                <LayoutGrid className="h-[15px] w-[15px] shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">{d.name}</span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-fg-subtle transition-colors group-hover:text-accent" />
              </button>
            ))}
          </div>
        )}

        <EditLink label={t('modelViewer.panel.editInConnections')} onClick={() => setCurrentView('connections')} />
      </div>
    </ShellRightPanel>
  )
}
