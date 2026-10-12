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

import type { ExportBundle, CsvContents, ExportScope, ImageTheme, SummaryScope } from './types'
import { buildModelJson } from './modelJson'
import { buildObjectsCsv, buildConnectionsCsv } from './csv'
import { buildSummaryModel, renderSummaryHtml, renderSummaryLlmsTxt, renderSummaryMarkdown, sliceForSummary } from './summary'
import { buildSummaryPdf, type PdfOrientation } from './pdf'
import { renderDiagramPngBlob, renderDiagramSvgText, renderLegendPngBlob, renderLegendSvgText, renderDiagramPdfImage, renderView3dPngBlob } from './image'
import type { LegendMode } from './legend'
import { buildStructurizrDsl } from './structurizr'
import { buildStructurizrJsonFile } from './structurizrJson'
import { buildMermaid } from './mermaid'
import { downloadBlob, downloadText, slug } from './download'
import i18n from '../i18n'
import { referencedTagSnapshots } from '../tags/assignments'

export type {
  ExportBundle,
  ExportModelProvenance,
  ExportModelSource,
  CsvContents,
  ExportScope,
  ImageTheme,
  SummaryScope,
} from './types'
export type { PdfOrientation } from './pdf'
export type { LegendMode } from './legend'
export { gatherExportBundle } from './gather'
export { slug } from './download'

export type ExportRequest =
  | { type: 'json'; scope: ExportScope }
  | { type: 'csv'; contents: CsvContents }
  | { type: 'pdf'; scope: SummaryScope; pickId?: string; orientation: PdfOrientation; includeDiagram?: boolean }
  | { type: 'markdown' | 'html' | 'llms'; scope: SummaryScope; pickId?: string }
  | { type: 'structurizr' | 'structurizr-json' | 'mermaid'; scope: ExportScope }
  // `source: '3d'` captures the live WebGL board at its current framing (PNG only);
  // '2d' (default) rasterises the flat diagram through the offscreen engine.
  | { type: 'svg' | 'png'; theme: ImageTheme; scale?: number; legend?: LegendMode; source?: '2d' | '3d' }

/** The name the download will save as — shown in the dialog footer before
 * downloading, and used verbatim by performExport. */
export function exportFileName(req: ExportRequest, bundle: ExportBundle): string {
  const activeDiagram = bundle.diagrams.find((d) => d.id === bundle.activeDiagramId) ?? bundle.diagrams[0]
  switch (req.type) {
    case 'json':
      return `${slug(req.scope === 'diagram' && activeDiagram ? activeDiagram.name : bundle.landscapeName)}.json`
    case 'csv':
      return `${slug(bundle.landscapeName)}-${req.contents === 'connections' ? 'connections' : 'objects'}.csv`
    case 'llms':
      return 'llms.txt'
    case 'markdown':
      return `${slug(bundle.landscapeName)}-summary.md`
    case 'html':
    case 'pdf':
      return `${slug(bundle.landscapeName)}-summary.${req.type}`
    case 'structurizr':
      return `${slug(req.scope === 'diagram' && activeDiagram ? activeDiagram.name : bundle.landscapeName)}.dsl`
    // `-structurizr` is not decoration: the plain 'json' export already owns
    // `<name>.json`, and two downloads that land on the same filename overwrite
    // each other in the browser's Downloads folder with no warning.
    case 'structurizr-json':
      return `${slug(req.scope === 'diagram' && activeDiagram ? activeDiagram.name : bundle.landscapeName)}-structurizr.json`
    case 'mermaid':
      return `${slug(req.scope === 'diagram' && activeDiagram ? activeDiagram.name : bundle.landscapeName)}.mmd`
    case 'svg':
    case 'png': {
      const base = slug(activeDiagram?.name ?? bundle.landscapeName)
      const suffix = req.type === 'png' && req.source === '3d' ? '-3d' : ''
      return `${base}${suffix}.${req.type}`
    }
  }
}

/**
 * What one download produced: the file name, and anything the exporter could not
 * say faithfully.
 *
 * `warnings` exists because an exporter that degrades something silently is
 * indistinguishable from one that did not degrade anything. The import side
 * shows its warnings in a visible panel; this is the same contract for the
 * other direction.
 */
export interface ExportOutcome {
  filename: string
  warnings?: string[]
}

/**
 * A landscape-wide export was asked for from a bundle that does not hold the
 * landscape. Thrown instead of writing the file: a Structurizr export missing 25
 * of 30 objects is not a smaller export, it is a wrong one, and nothing in the
 * file says so — it re-imports as a landscape whose model has been deleted.
 */
export class ExportModelIncompleteError extends Error {
  readonly missing: NonNullable<ExportBundle['model']>['missing']
  constructor(missing: NonNullable<ExportBundle['model']>['missing']) {
    super(i18n.t('exportEngine.errors.modelIncomplete', {
      objects: missing.objects,
      connections: missing.connections,
    }))
    this.name = 'ExportModelIncompleteError'
    this.missing = missing
  }
}

/** True for the formats that claim to cover the whole landscape. Diagram-scope
 * and image exports read only the ACTIVE diagram, which the resident window
 * always holds in full — those stay available on a degraded bundle. */
function coversWholeLandscape(req: ExportRequest): boolean {
  switch (req.type) {
    case 'json':
    case 'structurizr':
    case 'structurizr-json':
    case 'mermaid':
      return req.scope === 'landscape'
    case 'csv':
      return true
    case 'pdf':
    case 'markdown':
    case 'html':
    case 'llms':
      return req.scope === 'landscape' || req.scope === 'domain'
    case 'svg':
    case 'png':
      return false
  }
}

/**
 * Refuse a landscape-wide export the bundle cannot honour.
 *
 * The test is deliberately BOTH terms: no whole-landscape source answered
 * (`source === 'window'`) AND the bundle's own diagrams name entities it does not
 * carry. Either alone would be wrong — a small single-diagram landscape gathered
 * offline is legitimately window-only and complete, and a landscape with stale
 * registry references is legitimately exportable from a good source.
 */
function assertExportable(req: ExportRequest, bundle: ExportBundle): void {
  const model = bundle.model
  if (!model || !coversWholeLandscape(req)) return
  if (model.source !== 'window') return
  if (model.missing.objects === 0 && model.missing.connections === 0) return
  throw new ExportModelIncompleteError(model.missing)
}

/** Build the requested file from an already-gathered bundle and download it. */
export async function performExport(req: ExportRequest, bundle: ExportBundle): Promise<ExportOutcome> {
  assertExportable(req, bundle)
  const filename = exportFileName(req, bundle)
  let warnings: string[] = []
  switch (req.type) {
    case 'json': {
      // The landscape bundle carries everything; a diagram-scope export slices
      // down to the active diagram's composition.
      const scoped = req.scope === 'diagram' ? sliceBundleToActiveDiagram(bundle) : bundle
      downloadText(buildModelJson(scoped), filename, 'application/json')
      break
    }
    case 'csv': {
      const csv = req.contents === 'connections' ? buildConnectionsCsv(bundle) : buildObjectsCsv(bundle)
      downloadText(csv, filename, 'text/csv;charset=utf-8')
      break
    }
    case 'structurizr': {
      // Diagram scope keeps the members' ANCESTORS: the DSL's nesting (container
      // inside its softwareSystem) and the view's scope both need the parents,
      // which are rarely members of their own drill-down diagram.
      const scoped = req.scope === 'diagram' ? withAncestors(bundle, sliceBundleToActiveDiagram(bundle)) : bundle
      // Icons are stored same-origin (`/icons/light/<hash>.png`), so the emitted
      // styles need this deployment's origin to be fetchable by another renderer.
      downloadText(
        buildStructurizrDsl(scoped, { iconOrigin: globalThis.location?.origin }),
        filename,
        'text/plain;charset=utf-8',
      )
      break
    }
    case 'structurizr-json': {
      // Same ancestor rule as the DSL: a container view is scoped by its
      // software system, which is rarely a member of its own drill-down.
      const scoped = req.scope === 'diagram' ? withAncestors(bundle, sliceBundleToActiveDiagram(bundle)) : bundle
      const built = buildStructurizrJsonFile(scoped, { iconOrigin: globalThis.location?.origin })
      warnings = built.warnings
      downloadText(built.text, filename, 'application/json')
      break
    }
    case 'mermaid': {
      const scoped = req.scope === 'diagram' ? withAncestors(bundle, sliceBundleToActiveDiagram(bundle)) : bundle
      downloadText(buildMermaid(scoped, req.scope), filename, 'text/plain;charset=utf-8')
      break
    }
    case 'markdown':
    case 'html':
    case 'llms':
    case 'pdf': {
      const model = buildSummaryModel(bundle, sliceForSummary(bundle, req.scope, req.pickId))
      if (req.type === 'pdf') {
        // The embedded diagram follows the scope: a diagram-scope summary embeds
        // THAT diagram; otherwise the active one.
        let image = null
        if (req.includeDiagram) {
          const diagramId =
            (req.scope === 'diagram' && req.pickId) || bundle.activeDiagramId || bundle.diagrams[0]?.id
          if (diagramId) image = await renderDiagramPdfImage(bundle, diagramId)
        }
        downloadBlob(new Blob([buildSummaryPdf(model, req.orientation, image).buffer as ArrayBuffer], { type: 'application/pdf' }), filename)
      } else if (req.type === 'markdown') {
        downloadText(renderSummaryMarkdown(model), filename, 'text/markdown;charset=utf-8')
      } else if (req.type === 'html') {
        downloadText(renderSummaryHtml(model), filename, 'text/html;charset=utf-8')
      } else {
        downloadText(renderSummaryLlmsTxt(model), filename, 'text/plain;charset=utf-8')
      }
      break
    }
    case 'svg': {
      if (!bundle.activeDiagramId) throw new Error(i18n.t('exportEngine.errors.openADiagramForImage'))
      const svg = await renderDiagramSvgText(bundle, bundle.activeDiagramId, req.theme, {
        embedLegend: req.legend === 'embedded',
      })
      downloadText(svg, filename, 'image/svg+xml')
      if (req.legend === 'separate') {
        const legendSvg = renderLegendSvgText(bundle, bundle.activeDiagramId, req.theme)
        if (legendSvg) {
          const legendName = filename.replace(/\.svg$/, '-legend.svg')
          downloadText(legendSvg, legendName, 'image/svg+xml')
          return { filename: `${filename} + ${legendName}` }
        }
      }
      break
    }
    case 'png': {
      // 3D source: snapshot the live board at its current framing (no diagram
      // re-render, no legend/theme reprojection — it's a GL readback).
      if (req.source === '3d') {
        downloadBlob(renderView3dPngBlob(req.scale ?? 2), filename)
        break
      }
      if (!bundle.activeDiagramId) throw new Error(i18n.t('exportEngine.errors.openADiagramForImage'))
      const blob = await renderDiagramPngBlob(bundle, bundle.activeDiagramId, req.theme, req.scale ?? 2, {
        embedLegend: req.legend === 'embedded',
      })
      downloadBlob(blob, filename)
      if (req.legend === 'separate') {
        const legendBlob = await renderLegendPngBlob(bundle, bundle.activeDiagramId, req.theme, req.scale ?? 2)
        if (legendBlob) {
          const legendName = filename.replace(/\.png$/, '-legend.png')
          downloadBlob(legendBlob, legendName)
          return { filename: `${filename} + ${legendName}` }
        }
      }
      break
    }
  }
  // Short of the refusal above, a landscape-wide file that omits something its own
  // diagrams reference still says so — silence is what made this defect survive.
  const missing = coversWholeLandscape(req) ? bundle.model?.missing : undefined
  if (missing && (missing.objects > 0 || missing.connections > 0)) {
    warnings = [
      ...warnings,
      i18n.t('exportEngine.warnings.missingReferences', {
        objects: missing.objects,
        connections: missing.connections,
      }),
    ]
  }
  return warnings.length > 0 ? { filename, warnings } : { filename }
}

/** Re-add the ancestor chain (parents, grandparents, and the diagram's own
 * drill-down parent) that a diagram slice drops — code exports need them for
 * hierarchy/scoping even though they aren't diagram members. */
function withAncestors(bundle: ExportBundle, sliced: ExportBundle): ExportBundle {
  const byId = new Map(bundle.objects.map((o) => [o.id, o]))
  const present = new Set(sliced.objects.map((o) => o.id))
  const extras: typeof sliced.objects = []
  const pull = (id: string | undefined) => {
    for (let cur = id; cur && !present.has(cur); ) {
      const o = byId.get(cur)
      if (!o) break
      present.add(cur)
      extras.push(o)
      cur = o.parentId
    }
  }
  for (const o of sliced.objects) pull(o.parentId)
  const d = sliced.diagrams[0]
  if (d?.parentObjectId) pull(d.parentObjectId)
  return extras.length ? { ...sliced, objects: [...extras, ...sliced.objects] } : sliced
}

/** Reduce a landscape bundle to just the active diagram's slice (JSON diagram scope). */
function sliceBundleToActiveDiagram(bundle: ExportBundle): ExportBundle {
  const diagram = bundle.diagrams.find((d) => d.id === bundle.activeDiagramId) ?? bundle.diagrams[0]
  if (!diagram) return bundle
  const objectIds = new Set(diagram.objectIds)
  const connectionIds = new Set(diagram.connectionIds)
  const groupIds = new Set(diagram.groupIds)
  const objects = bundle.objects.filter((o) => objectIds.has(o.id))
  // Decision records follow the slice like everything else; passing them
  // through on `...bundle` would give a user exporting ONE diagram every ADR in
  // the landscape — the opposite of what "this diagram" says on the dialog. An ADR
  // link can name a diagram (`ADRLinkType`), which is the only association the
  // model offers, so that is what a diagram-scope export keeps.
  const decisionRecords = bundle.decisionRecords.filter((record) =>
    (record.related ?? []).some((link) => link.type === 'diagram' && link.targetId === diagram.id),
  )
  const domainIds = new Set(objects.map((o) => o.domainId).filter((id): id is string => Boolean(id)))
  return {
    ...bundle,
    diagrams: [diagram],
    flowsByDiagram: { [diagram.id]: bundle.flowsByDiagram[diagram.id] ?? [] },
    objects,
    connections: bundle.connections.filter((c) => connectionIds.has(c.id)),
    groups: bundle.groups.filter((g) => groupIds.has(g.id)),
    tags: referencedTagSnapshots(objects, bundle.tags),
    domains: bundle.domains.filter((domain) => domainIds.has(domain.id)),
    decisionRecords,
  }
}

