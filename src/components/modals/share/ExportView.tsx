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
import { Bot, Boxes, Braces, Download, FileCode, FileText, Image as ImageIcon, Info, Loader2, Table, CheckCircle2, Workflow } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { SegmentedTabs } from '../../ui/SegmentedTabs'
import { cn } from '../../../lib/utils'
import { useUIStore } from '../../../stores/uiStore'
import { useThemeStore } from '../../../stores/themeStore'
import {
  gatherExportBundle,
  performExport,
  exportFileName,
  type ExportBundle,
  type ExportRequest,
  type CsvContents,
  type ExportScope,
  type ImageTheme,
  type SummaryScope,
  type PdfOrientation,
  type LegendMode,
} from '../../../lib/export'

type FileTypeId =
  | 'json'
  | 'pdf'
  | 'markdown'
  | 'html'
  | 'llms'
  | 'csv'
  | 'structurizr'
  | 'structurizr-json'
  | 'mermaid'
  | 'svg'
  | 'png'
type FileTypeGroup = 'Full model' | 'Summary' | 'Data' | 'Code' | 'Image'

interface FileType {
  id: FileTypeId
  group: FileTypeGroup
  label: string
  ext: string
  icon: LucideIcon
  blurb: string
}

/** File-type metadata is localized (blurb text), so it's built from `t` inside
 * the component render rather than as a static module-level constant. Format
 * names (JSON, PDF, Structurizr…) are technical identifiers, kept as-is. */
function getTypes(t: TFunction): FileType[] {
  return [
    { id: 'json', group: 'Full model', label: 'JSON', ext: 'json', icon: Braces, blurb: t('shareExport.exportView.types.json.blurb') },
    { id: 'pdf', group: 'Summary', label: 'PDF', ext: 'pdf', icon: FileText, blurb: t('shareExport.exportView.types.pdf.blurb') },
    { id: 'markdown', group: 'Summary', label: 'Markdown', ext: 'md', icon: FileText, blurb: t('shareExport.exportView.types.markdown.blurb') },
    { id: 'html', group: 'Summary', label: 'HTML', ext: 'html', icon: FileCode, blurb: t('shareExport.exportView.types.html.blurb') },
    { id: 'llms', group: 'Summary', label: 'LLMs.txt', ext: 'txt', icon: Bot, blurb: t('shareExport.exportView.types.llms.blurb') },
    { id: 'csv', group: 'Data', label: 'CSV', ext: 'csv', icon: Table, blurb: t('shareExport.exportView.types.csv.blurb') },
    { id: 'structurizr', group: 'Code', label: 'Structurizr (DSL)', ext: 'dsl', icon: Boxes, blurb: t('shareExport.exportView.types.structurizr.blurb') },
    { id: 'structurizr-json', group: 'Code', label: 'Structurizr (JSON)', ext: 'json', icon: Boxes, blurb: t('shareExport.exportView.types.structurizrJson.blurb') },
    { id: 'mermaid', group: 'Code', label: 'Mermaid', ext: 'mmd', icon: Workflow, blurb: t('shareExport.exportView.types.mermaid.blurb') },
    { id: 'svg', group: 'Image', label: 'SVG', ext: 'svg', icon: ImageIcon, blurb: t('shareExport.exportView.types.svg.blurb') },
    { id: 'png', group: 'Image', label: 'PNG', ext: 'png', icon: ImageIcon, blurb: t('shareExport.exportView.types.png.blurb') },
  ]
}
const GROUPS: FileTypeGroup[] = ['Full model', 'Summary', 'Data', 'Code', 'Image']

/** Localized display label for a file-type group. */
function groupLabel(group: FileTypeGroup, t: TFunction): string {
  switch (group) {
    case 'Full model':
      return t('shareExport.exportView.groups.fullModel')
    case 'Summary':
      return t('shareExport.exportView.groups.summary')
    case 'Data':
      return t('shareExport.exportView.groups.data')
    case 'Code':
      return t('shareExport.exportView.groups.code')
    case 'Image':
      return t('shareExport.exportView.groups.image')
  }
}

/** The default file type adapts to the surface the Share button was pressed on. */
function defaultTypeFor(view: string): FileTypeId {
  switch (view) {
    case 'diagram':
      return 'png'
    case 'model-objects':
    case 'connections':
      return 'csv'
    default:
      return 'json'
  }
}

/** Diagram-image exports only make sense where a diagram is the subject —
 * the editor and the diagrams gallery. Model/table pages hide the Image group. */
function imageExportsRelevant(view: string): boolean {
  return view === 'diagram' || view === 'diagrams'
}

const OVERLINE = 'mb-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-fg-subtle'
const SELECT =
  'h-[34px] w-full appearance-none rounded-lg border border-line bg-surface-50 px-2.5 text-[12.5px] text-fg outline-none focus:border-accent'

export function ExportView() {
  const { t } = useTranslation()
  const currentView = useUIStore((s) => s.currentView)
  const in3dMode = useUIStore((s) => s.canvasViewMode === '3d')
  const appTheme = useThemeStore((s) => s.resolved)

  const [fileType, setFileType] = useState<FileTypeId>(() => defaultTypeFor(useUIStore.getState().currentView))
  const [jsonScope, setJsonScope] = useState<ExportScope>('landscape')
  const [codeScope, setCodeScope] = useState<ExportScope>('landscape')
  const [pdfDiagram, setPdfDiagram] = useState(false)
  const [summaryScope, setSummaryScope] = useState<SummaryScope>('landscape')
  const [summaryPickId, setSummaryPickId] = useState<string>('')
  const [orientation, setOrientation] = useState<PdfOrientation>('portrait')
  const [csvContents, setCsvContents] = useState<CsvContents>(() =>
    useUIStore.getState().currentView === 'connections' ? 'connections' : 'objects',
  )
  const [imgTheme, setImgTheme] = useState<ImageTheme>(appTheme)
  const [pngScale, setPngScale] = useState('2')
  const [legendMode, setLegendMode] = useState<LegendMode>('none')
  // PNG source: the live 3D board or the flat 2D diagram. Defaults to 3D when the
  // Share button was pressed while the 3D view is open (capture what you see).
  const [imgSource, setImgSource] = useState<'2d' | '3d'>(() =>
    useUIStore.getState().canvasViewMode === '3d' ? '3d' : '2d',
  )

  const [bundle, setBundle] = useState<ExportBundle | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  // What the exporter could not say faithfully. Cleared on every download, so a
  // note from the previous one can never be read as a note about this one.
  const [notes, setNotes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)

  // One gather per dialog open feeds every download and the scope pick lists.
  useEffect(() => {
    let cancelled = false
    gatherExportBundle('landscape')
      .then((b) => {
        if (!cancelled) setBundle(b)
      })
      .catch(() => {
        if (!cancelled) setError(t('shareExport.exportView.errors.readModel'))
      })
    return () => {
      cancelled = true
    }
  }, [t])

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
  }, [])

  const types = useMemo(() => getTypes(t), [t])
  const selected = types.find((ft) => ft.id === fileType) ?? types[0]
  const isSummary = fileType === 'pdf' || fileType === 'markdown' || fileType === 'html' || fileType === 'llms'
  const isCode = fileType === 'structurizr' || fileType === 'structurizr-json' || fileType === 'mermaid'
  const isImage = fileType === 'svg' || fileType === 'png'
  // The "capture the live 3D board" path (PNG only, offered only while the 3D
  // view is open). It reads the mounted scene, so 2D-only options (theme,
  // legend, the schematic preview) don't apply and the bundle's diagram-presence
  // gate doesn't block it.
  const png3d = fileType === 'png' && in3dMode && imgSource === '3d'
  const needsPick = isSummary && summaryScope !== 'landscape'
  const hasDiagram = !!bundle?.activeDiagramId && (bundle?.diagrams.length ?? 0) > 0
  const imageBlocked = isImage && !png3d && bundle !== null && !hasDiagram
  // The gather could not read the whole landscape (no source answered and the
  // diagrams name entities the window lacks). Landscape-wide formats would write
  // a file that looks complete and isn't, so performExport refuses them — say so
  // here rather than only after the click.
  const modelIncomplete =
    bundle?.model?.source === 'window' &&
    (bundle.model.missing.objects > 0 || bundle.model.missing.connections > 0)
  const landscapeWide =
    (fileType === 'json' && jsonScope === 'landscape') ||
    (isCode && codeScope === 'landscape') ||
    fileType === 'csv' ||
    (isSummary && (summaryScope === 'landscape' || summaryScope === 'domain'))
  const modelBlocked = !!modelIncomplete && landscapeWide

  const pickOptions = useMemo(() => {
    if (!bundle) return []
    if (summaryScope === 'domain') return bundle.domains.map((d) => ({ id: d.id, name: d.name }))
    if (summaryScope === 'object')
      return [...bundle.objects].sort((a, b) => a.name.localeCompare(b.name)).map((o) => ({ id: o.id, name: o.name }))
    if (summaryScope === 'diagram') return bundle.diagrams.map((d) => ({ id: d.id, name: d.name }))
    return []
  }, [bundle, summaryScope])

  // '' means "first option" — so a scope change never carries a stale pick, and
  // the pick list works the moment the bundle loads without an effect.
  const effectivePickId = pickOptions.some((o) => o.id === summaryPickId)
    ? summaryPickId
    : pickOptions[0]?.id ?? ''

  const request: ExportRequest = useMemo(() => {
    if (fileType === 'json') return { type: 'json', scope: jsonScope }
    if (fileType === 'csv') return { type: 'csv', contents: csvContents }
    if (fileType === 'structurizr' || fileType === 'structurizr-json' || fileType === 'mermaid')
      return { type: fileType, scope: codeScope }
    if (fileType === 'pdf')
      return { type: 'pdf', scope: summaryScope, pickId: effectivePickId || undefined, orientation, includeDiagram: pdfDiagram }
    if (fileType === 'markdown' || fileType === 'html' || fileType === 'llms')
      return { type: fileType, scope: summaryScope, pickId: effectivePickId || undefined }
    return {
      type: fileType,
      theme: imgTheme,
      scale: Number(pngScale),
      legend: legendMode,
      source: fileType === 'png' && in3dMode ? imgSource : undefined,
    }
  }, [fileType, jsonScope, codeScope, csvContents, summaryScope, effectivePickId, orientation, pdfDiagram, imgTheme, pngScale, legendMode, in3dMode, imgSource])

  const baseFilename = bundle ? exportFileName(request, bundle) : '…'
  const filename = isImage && legendMode === 'separate' && bundle ? `${baseFilename} + legend` : baseFilename

  const scopeName = (id: string) => pickOptions.find((o) => o.id === id)?.name ?? t('shareExport.exportView.unknown')
  const summaryScopeLabel =
    summaryScope === 'landscape'
      ? t('shareExport.exportView.scopeLabel.landscape')
      : summaryScope === 'domain'
        ? t('shareExport.exportView.scopeLabel.domain', { name: scopeName(effectivePickId) })
        : summaryScope === 'object'
          ? t('shareExport.exportView.scopeLabel.object', { name: scopeName(effectivePickId) })
          : t('shareExport.exportView.scopeLabel.diagram', { name: scopeName(effectivePickId) })
  const activeDiagramName = bundle?.diagrams.find((d) => d.id === bundle.activeDiagramId)?.name ?? t('shareExport.exportView.currentDiagram')

  const includedText = imageBlocked
    ? t('shareExport.exportView.included.imageBlocked')
    : fileType === 'json'
      ? t('shareExport.exportView.included.json', {
          scope: jsonScope === 'diagram' ? t('shareExport.exportView.included.thisDiagram') : t('shareExport.exportView.included.wholeLandscape'),
        })
      : fileType === 'structurizr'
        ? t('shareExport.exportView.included.structurizr', {
            scope:
              codeScope === 'diagram'
                ? t('shareExport.exportView.included.namedDiagram', { name: activeDiagramName })
                : t('shareExport.exportView.included.wholeLandscape'),
          })
        : fileType === 'structurizr-json'
        ? t('shareExport.exportView.included.structurizrJson', {
            scope:
              codeScope === 'diagram'
                ? t('shareExport.exportView.included.namedDiagram', { name: activeDiagramName })
                : t('shareExport.exportView.included.wholeLandscape'),
          })
        : fileType === 'mermaid'
          ? codeScope === 'diagram'
            ? t('shareExport.exportView.included.mermaidDiagram', { name: activeDiagramName })
            : t('shareExport.exportView.included.mermaidLandscape')
          : isSummary
            ? t('shareExport.exportView.included.summary', {
                scope: summaryScopeLabel,
                diagramNote:
                  fileType === 'pdf' && pdfDiagram
                    ? t('shareExport.exportView.included.summaryDiagramNote', {
                        name: summaryScope === 'diagram' ? scopeName(effectivePickId) : activeDiagramName,
                      })
                    : '',
              })
            : fileType === 'csv'
              ? csvContents === 'connections'
                ? t('shareExport.exportView.included.csvConnections')
                : t('shareExport.exportView.included.csvObjects')
              : png3d
                ? t('shareExport.exportView.included.png3d', { name: activeDiagramName, scale: pngScale })
                : (fileType === 'svg'
                    ? t('shareExport.exportView.included.svg', { name: activeDiagramName, theme: imgTheme })
                    : t('shareExport.exportView.included.png', { name: activeDiagramName, theme: imgTheme, scale: pngScale })) +
                  (legendMode === 'separate'
                    ? ` ${t('shareExport.exportView.included.legendSeparate')}`
                    : legendMode === 'embedded'
                      ? ` ${t('shareExport.exportView.included.legendEmbedded')}`
                      : '')

  const onDownload = async () => {
    if (!bundle || downloading) return
    setDownloading(true)
    setError(null)
    setToast(null)
    setNotes([])
    try {
      const { filename: name, warnings } = await performExport(request, bundle)
      setToast(name)
      setNotes(warnings ?? [])
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
      toastTimer.current = window.setTimeout(() => setToast(null), 3600)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('shareExport.exportView.errors.exportFailed'))
    } finally {
      setDownloading(false)
    }
  }

  const railItem = (ft: FileType) => {
    const active = ft.id === fileType
    const IconCmp = ft.icon
    return (
      <button
        key={ft.id}
        data-testid={`export-type-${ft.id}`}
        onClick={() => {
          setFileType(ft.id)
          setToast(null)
          setError(null)
        }}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-[12.5px] transition-colors',
          active
            ? 'border-accent/35 bg-accent-subtle font-semibold text-accent'
            : 'border-transparent font-medium text-fg-secondary hover:bg-surface-hover hover:text-fg',
        )}
      >
        <IconCmp className="h-4 w-4 shrink-0" />
        <span className="flex-1">{ft.label}</span>
        <span className="font-mono text-[10px] text-fg-subtle">{ft.ext}</span>
      </button>
    )
  }

  return (
    <div className="flex flex-wrap items-stretch gap-4" data-view={currentView}>
      {/* File-type rail, grouped — only the groups relevant to this surface. */}
      <div className="flex w-[186px] shrink-0 flex-col gap-0.5 border-r border-line pr-3.5">
        {GROUPS.filter((g) => g !== 'Image' || imageExportsRelevant(currentView)).map((g) => (
          <div key={g}>
            <div className="px-1 pb-1.5 pt-2.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-fg-subtle first:pt-0">
              {groupLabel(g, t)}
            </div>
            <div className="flex flex-col gap-0.5">{types.filter((ft) => ft.group === g).map(railItem)}</div>
          </div>
        ))}
      </div>

      {/* Selected-type pane */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start gap-2.5">
          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] bg-accent-subtle text-accent">
            <selected.icon className="h-[19px] w-[19px]" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[14.5px] font-semibold text-fg">{selected.label}</span>
              <span className="rounded-[5px] bg-surface-200 px-1.5 py-px font-mono text-[10.5px] text-fg-subtle">
                .{selected.ext}
              </span>
            </div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-fg-secondary">{selected.blurb}</p>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3.5">
          {fileType === 'json' && (
            <div>
              <div className={OVERLINE}>{t('shareExport.exportView.labels.scope')}</div>
              <SegmentedTabs
                size="sm"
                tabs={[
                  { id: 'landscape', label: t('shareExport.exportView.labels.landscape'), testid: 'export-json-landscape' },
                  { id: 'diagram', label: t('shareExport.exportView.labels.diagram'), testid: 'export-json-diagram' },
                ]}
                value={jsonScope}
                onChange={setJsonScope}
              />
            </div>
          )}

          {isSummary && (
            <>
              <div>
                <div className={OVERLINE}>{t('shareExport.exportView.labels.scope')}</div>
                <select
                  data-testid="export-summary-scope"
                  value={summaryScope}
                  onChange={(e) => {
                    setSummaryScope(e.target.value as SummaryScope)
                    setSummaryPickId('')
                  }}
                  className={SELECT}
                >
                  <option value="landscape">{t('shareExport.exportView.labels.landscape')}</option>
                  <option value="domain">{t('shareExport.exportView.labels.domain')}</option>
                  <option value="object">{t('shareExport.exportView.labels.modelObject')}</option>
                  <option value="diagram">{t('shareExport.exportView.labels.diagram')}</option>
                </select>
              </div>
              {needsPick && (
                <div>
                  <div className={OVERLINE}>
                    {summaryScope === 'domain'
                      ? t('shareExport.exportView.labels.domain')
                      : summaryScope === 'object'
                        ? t('shareExport.exportView.labels.modelObject')
                        : t('shareExport.exportView.labels.diagram')}
                  </div>
                  <select
                    data-testid="export-summary-pick"
                    value={effectivePickId}
                    onChange={(e) => setSummaryPickId(e.target.value)}
                    className={SELECT}
                  >
                    {pickOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {fileType === 'pdf' && (
                <>
                  <div>
                    <div className={OVERLINE}>{t('shareExport.exportView.labels.orientation')}</div>
                    <SegmentedTabs
                      size="sm"
                      tabs={[
                        { id: 'portrait', label: t('shareExport.exportView.labels.portrait') },
                        { id: 'landscape', label: t('shareExport.exportView.labels.landscape') },
                      ]}
                      value={orientation}
                      onChange={setOrientation}
                    />
                  </div>
                  <div>
                    <div className={OVERLINE}>{t('shareExport.exportView.labels.diagramImage')}</div>
                    <SegmentedTabs
                      size="sm"
                      tabs={[
                        { id: 'off', label: t('shareExport.exportView.labels.none'), testid: 'export-pdf-diagram-off' },
                        { id: 'on', label: t('shareExport.exportView.labels.include'), testid: 'export-pdf-diagram-on' },
                      ]}
                      value={pdfDiagram ? 'on' : 'off'}
                      onChange={(id) => setPdfDiagram(id === 'on')}
                    />
                  </div>
                </>
              )}
            </>
          )}

          {isCode && (
            <div>
              <div className={OVERLINE}>{t('shareExport.exportView.labels.scope')}</div>
              <SegmentedTabs
                size="sm"
                tabs={[
                  { id: 'landscape', label: t('shareExport.exportView.labels.landscape'), testid: 'export-code-landscape' },
                  { id: 'diagram', label: t('shareExport.exportView.labels.diagram'), testid: 'export-code-diagram' },
                ]}
                value={codeScope}
                onChange={setCodeScope}
              />
            </div>
          )}

          {fileType === 'csv' && (
            <div>
              <div className={OVERLINE}>{t('shareExport.exportView.labels.contents')}</div>
              <SegmentedTabs
                size="sm"
                tabs={[
                  { id: 'objects', label: t('shareExport.exportView.labels.modelObjects'), testid: 'export-csv-objects' },
                  { id: 'connections', label: t('shareExport.exportView.labels.connections'), testid: 'export-csv-connections' },
                ]}
                value={csvContents}
                onChange={setCsvContents}
              />
            </div>
          )}

          {isImage && (
            <>
              {/* Source: capture the live 3D board or rasterise the flat 2D
                  diagram (PNG only, offered while the 3D view is open). */}
              {fileType === 'png' && in3dMode && (
                <div>
                  <div className={OVERLINE}>{t('shareExport.exportView.labels.view')}</div>
                  <SegmentedTabs
                    size="sm"
                    tabs={[
                      { id: '2d', label: t('shareExport.exportView.labels.view2d'), testid: 'export-source-2d' },
                      { id: '3d', label: t('shareExport.exportView.labels.view3d'), testid: 'export-source-3d' },
                    ]}
                    value={imgSource}
                    onChange={setImgSource}
                  />
                </div>
              )}
              {!png3d && (
              <>
              <div>
                <div className={OVERLINE}>{t('shareExport.exportView.labels.theme')}</div>
                <SegmentedTabs
                  size="sm"
                  tabs={[
                    { id: 'light', label: t('appearance.light'), testid: 'export-theme-light' },
                    { id: 'dark', label: t('appearance.dark'), testid: 'export-theme-dark' },
                  ]}
                  value={imgTheme}
                  onChange={setImgTheme}
                />
              </div>
              <div>
                <div className={OVERLINE}>{t('shareExport.exportView.labels.legend')}</div>
                <SegmentedTabs
                  size="sm"
                  tabs={[
                    { id: 'none', label: t('shareExport.exportView.labels.none'), testid: 'export-legend-none' },
                    { id: 'separate', label: t('shareExport.exportView.labels.separateFile'), testid: 'export-legend-separate' },
                    { id: 'embedded', label: t('shareExport.exportView.labels.inImage'), testid: 'export-legend-embedded' },
                  ]}
                  value={legendMode}
                  onChange={setLegendMode}
                />
              </div>
              {/* Theme preview — a schematic two-node thumbnail in the chosen appearance. */}
              <div
                className="relative h-[104px] overflow-hidden rounded-[9px] border"
                style={{
                  borderColor: imgTheme === 'dark' ? '#3A352F' : 'var(--color-line)',
                  background: `${imgTheme === 'dark' ? '#26231F' : '#E7E6E2'} radial-gradient(${imgTheme === 'dark' ? '#3A352F' : '#D3CFC7'} 1px, transparent 1px)`,
                  backgroundSize: '14px 14px',
                }}
              >
                {[24, undefined].map((left, i) => (
                  <div
                    key={i}
                    className="absolute top-[35px] h-[34px] w-[72px] rounded-[7px]"
                    style={{
                      left: left !== undefined ? left : undefined,
                      right: left === undefined ? 24 : undefined,
                      background: imgTheme === 'dark' ? '#332F29' : '#FFFFFF',
                      boxShadow: imgTheme === 'dark' ? '0 1px 3px rgba(0,0,0,.4)' : '0 1px 3px rgba(0,0,0,.2)',
                    }}
                  />
                ))}
                <div className="absolute left-[96px] right-[96px] top-[52px] h-[2px] bg-accent" />
              </div>
              </>
              )}
              {fileType === 'png' && (
                <div>
                  <div className={OVERLINE}>{t('shareExport.exportView.labels.resolution')}</div>
                  <select
                    data-testid="export-png-scale"
                    value={pngScale}
                    onChange={(e) => setPngScale(e.target.value)}
                    className={SELECT}
                  >
                    <option value="1">{t('shareExport.exportView.labels.resolutionStandard')}</option>
                    <option value="2">{t('shareExport.exportView.labels.resolutionRetina')}</option>
                    <option value="3">{t('shareExport.exportView.labels.resolutionPrint')}</option>
                  </select>
                </div>
              )}
            </>
          )}
        </div>

        {/* What's included */}
        <div className="mt-4 flex gap-2.5 rounded-[9px] border border-line bg-surface-50 px-3 py-2.5">
          <Info className="mt-px h-3.5 w-3.5 shrink-0 text-fg-subtle" />
          <span className="text-[11.5px] leading-relaxed text-fg-secondary" data-testid="export-included">
            {includedText}
          </span>
        </div>

        {modelIncomplete && (
          <div
            data-testid="export-model-incomplete"
            className="mt-3 rounded-[9px] border border-warning bg-warning-bg px-3 py-2.5 text-[11.5px] leading-relaxed text-warning-text"
          >
            {t('shareExport.exportView.modelIncomplete', {
              objects: bundle?.model?.missing.objects ?? 0,
              connections: bundle?.model?.missing.connections ?? 0,
            })}
          </div>
        )}
        {toast && (
          <div
            data-testid="export-toast"
            className="mt-3 flex items-center gap-2.5 rounded-[9px] border border-success bg-success-bg px-3 py-2.5 text-success-text"
          >
            <CheckCircle2 className="h-[15px] w-[15px] shrink-0" />
            <span className="text-[12px]">
              {t('shareExport.exportView.downloaded')} <strong className="font-mono font-semibold">{toast}</strong>
            </span>
          </div>
        )}
        {notes.length > 0 && (
          <div
            data-testid="export-notes"
            className="mt-3 rounded-[9px] border border-warning bg-warning-bg px-3 py-2.5"
          >
            <div className="mb-1 text-[11px] font-semibold text-warning-text">
              {t('shareExport.exportView.notes')}
            </div>
            <ul className="list-inside list-disc space-y-0.5">
              {notes.map((note, at) => (
                <li key={at} className="text-[11px] text-warning-text">
                  {note}
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <p className="mt-3 text-[12px] text-error-text">{error}</p>}

        {/* Footer: filename + download */}
        <div className="mt-4 flex items-center gap-3 border-t border-line pt-3.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden font-mono text-[11.5px] text-fg-subtle">
            <Download className="h-[13px] w-[13px] shrink-0" />
            <span className="truncate" data-testid="export-filename">
              {filename}
            </span>
          </div>
          <button
            data-testid="export-download"
            onClick={onDownload}
            disabled={!bundle || downloading || imageBlocked || modelBlocked}
            className="flex h-8 items-center gap-1.5 rounded-[10px] bg-accent px-3.5 text-[12.5px] font-semibold text-accent-text transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {downloading ? t('shareExport.exportView.preparing') : t('shareExport.exportView.downloadType', { label: selected.label })}
          </button>
        </div>
      </div>
    </div>
  )
}
