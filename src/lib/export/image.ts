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

import { CanvasEngine } from '../../canvas/engine/CanvasEngine'
import { useSkinStore } from '../../stores/skinStore'
import type { C4Object, Connection, Diagram, Flow, Group, Tag } from '../../types'
import type { SkinConfig } from '../../skins/types'
import type { ExportBundle, ImageTheme } from './types'
import { renderExportSvg, type SvgScene } from './svg'
import { buildLegendModel, drawLegendCanvas, legendSize, renderLegendSvg, type LegendModel } from './legend'
import type { PdfImage } from './pdf'
import { getActiveScene3D } from '../../canvas3d/activeScene'
import i18n from '../i18n'

/**
 * Diagram → image exports. Both formats read from the SAME offscreen
 * CanvasEngine so geometry always matches the editor: PNG rasterises the real
 * engine (pixel-faithful, 1×/2×/3×), SVG serialises the engine's connection
 * curves + group boxes through the product-styled vector renderer.
 */

const noop = () => {}
const NOOP_CALLBACKS = {
  onObjectSelect: noop,
  onGroupSelect: noop,
  onConnectionSelect: noop,
  onObjectMove: noop,
  onObjectResize: noop,
  onObjectDoubleClick: noop,
  onGroupDoubleClick: noop,
  onConnectionDoubleClick: noop,
  onConnectionLabelMove: noop,
  onConnectionWaypointsChange: noop,
  onConnectionStart: noop,
  onConnectionEnd: noop,
  onConnectionAnchorMove: noop,
  onZoom: noop,
  onCommentClick: noop,
  onCommentMove: noop,
  onContextMenu: noop,
  onGroupMove: noop,
  onGroupResize: noop,
  onCopyApply: noop,
  onExpandClick: noop,
}

interface DiagramScene {
  diagram: Diagram
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
  flows: Flow[]
  tags: Tag[]
}

/** Apply a diagram's composition + per-diagram layouts onto the bundle's
 * entities — the same projection CanvasView/ViewerCanvas feed the engine. */
export function sceneFromBundle(bundle: ExportBundle, diagramId: string): DiagramScene | null {
  const diagram = bundle.diagrams.find((d) => d.id === diagramId)
  if (!diagram) return null
  const objectIds = new Set(diagram.objectIds)
  const connectionIds = new Set(diagram.connectionIds)
  const groupIds = new Set(diagram.groupIds)
  const objects = bundle.objects
    .filter((o) => objectIds.has(o.id))
    .map((o) => {
      const l = diagram.layouts?.[o.id]
      return l ? { ...o, position: l.position, size: l.size } : o
    })
  const groups = bundle.groups
    .filter((g) => groupIds.has(g.id))
    .map((g) => {
      const l = diagram.layouts?.[g.id]
      return l ? { ...g, position: l.position, size: l.size } : g
    })
  return {
    diagram,
    objects,
    connections: bundle.connections.filter((c) => connectionIds.has(c.id)),
    groups,
    flows: bundle.flowsByDiagram[diagramId] ?? [],
    tags: bundle.tags,
  }
}

function resolveExportSkin(scene: DiagramScene, theme: ImageTheme): SkinConfig {
  return useSkinStore.getState().getResolvedSkin(scene.diagram.skinId, theme)
}

/** Content bounds: objects plus computed group boxes (world coordinates). */
function contentBounds(engine: CanvasEngine, scene: DiagramScene) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const include = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h)
  }
  for (const o of scene.objects) include(o.position.x, o.position.y, o.size.width, o.size.height)
  for (const g of scene.groups) {
    const b = engine.getGroupBounds(g)
    if (b) include(b.x, b.y, b.width, b.height)
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 400, height: 300 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Stand up a throwaway engine on a detached canvas, hand it to `run`, always destroy. */
async function withExportEngine<T>(
  scene: DiagramScene,
  skin: SkinConfig,
  theme: ImageTheme,
  run: (engine: CanvasEngine, canvas: HTMLCanvasElement) => Promise<T>,
): Promise<T> {
  const canvas = document.createElement('canvas')
  const engine = new CanvasEngine(canvas, NOOP_CALLBACKS, skin)
  try {
    engine.setResolvedTheme(theme)
    engine.setReadonly(true)
    engine.setShowGrid(false)
    engine.setConnectionAnimationsEnabled(false)
    engine.setData(scene.objects, scene.connections, scene.groups, scene.flows, scene.tags)
    return await run(engine, canvas)
  } finally {
    engine.destroy()
  }
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

/** The current diagram as a themed, product-styled standalone SVG. */
export async function renderDiagramSvgText(
  bundle: ExportBundle,
  diagramId: string,
  theme: ImageTheme,
  opts?: { embedLegend?: boolean },
): Promise<string> {
  const scene = sceneFromBundle(bundle, diagramId)
  if (!scene) throw new Error(i18n.t('exportEngine.errors.noDiagramToExport'))
  const skin = resolveExportSkin(scene, theme)
  return withExportEngine(scene, skin, theme, async (engine) => {
    const svgScene: SvgScene = {
      diagramName: scene.diagram.name,
      objects: scene.objects,
      connections: scene.connections,
      groups: scene.groups
        .map((g) => ({ group: g, bounds: engine.getGroupBounds(g)! }))
        .filter((g) => g.bounds),
      connectionGeoms: engine.getExportConnectionGeometries(),
      skin,
    }
    return renderExportSvg(svgScene, { legend: opts?.embedLegend ? buildLegendModel(scene) : null })
  })
}

/** The diagram's legend alone, as a standalone SVG — null when the diagram
 * contains nothing to explain. */
export function renderLegendSvgText(bundle: ExportBundle, diagramId: string, theme: ImageTheme): string | null {
  const scene = sceneFromBundle(bundle, diagramId)
  if (!scene) return null
  const model = buildLegendModel(scene)
  if (model.entries.length === 0) return null
  return renderLegendSvg(model, resolveExportSkin(scene, theme))
}

/** The diagram's legend alone, rasterised — null when there's nothing to explain. */
export async function renderLegendPngBlob(
  bundle: ExportBundle,
  diagramId: string,
  theme: ImageTheme,
  scale: number,
): Promise<Blob | null> {
  const scene = sceneFromBundle(bundle, diagramId)
  if (!scene) return null
  const model = buildLegendModel(scene)
  if (model.entries.length === 0) return null
  const skin = resolveExportSkin(scene, theme)
  if (typeof document !== 'undefined' && document.fonts?.ready) await document.fonts.ready

  const probe = document.createElement('canvas').getContext('2d')!
  const fontFamily = skin.renderStyle.fontFamily ?? 'Inter, system-ui, sans-serif'
  const dims = legendSize(model, (t, size, weight) => {
    probe.font = `${weight} ${size}px ${fontFamily}`
    return probe.measureText(t).width
  })
  const pad = 12
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil((dims.width + pad * 2) * scale)
  canvas.height = Math.ceil((dims.height + pad * 2) * scale)
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.fillStyle = skin.canvas.bg
  ctx.fillRect(0, 0, dims.width + pad * 2, dims.height + pad * 2)
  drawLegendCanvas(ctx, model, skin, pad, pad)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error(i18n.t('exportEngine.errors.couldNotRasteriseLegend'))
  return blob
}

/** Longest canvas edge the raster export will allocate; the scale silently
 * clamps beneath it so a huge diagram downloads instead of throwing. */
const MAX_RASTER_EDGE = 8192

/**
 * The diagram rendered for embedding into the summary PDF: always the LIGHT
 * theme (the PDF is a light document), 2× density. Lossless zlib-deflated raw
 * RGB when CompressionStream exists (all modern browsers), JPEG fallback
 * otherwise. Returns null when the diagram doesn't exist.
 */
export async function renderDiagramPdfImage(bundle: ExportBundle, diagramId: string): Promise<PdfImage | null> {
  const scene = sceneFromBundle(bundle, diagramId)
  if (!scene) return null
  const skin = resolveExportSkin(scene, 'light')
  return withExportEngine(scene, skin, 'light', async (engine, canvas) => {
    const pad = 48
    const bounds = contentBounds(engine, scene)
    const cssW = Math.max(1, Math.round(bounds.width + pad * 2))
    const cssH = Math.max(1, Math.round(bounds.height + pad * 2))
    // 4096 edge cap: at raw-RGB embedding sizes, anything bigger bloats the PDF
    // for no visible gain once scaled to the page column.
    const ratio = Math.min(2, 4096 / cssW, 4096 / cssH)
    engine.setPixelRatio(ratio)
    engine.resize(cssW, cssH)
    engine.focusOnBounds(bounds, pad)
    if (typeof document !== 'undefined' && document.fonts?.ready) await document.fonts.ready
    await nextFrame()
    await engine.whenIconsSettled()
    await nextFrame()

    if (typeof CompressionStream !== 'undefined') {
      const ctx = canvas.getContext('2d')!
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const rgb = new Uint8Array(canvas.width * canvas.height * 3)
      for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
        rgb[j] = data[i]
        rgb[j + 1] = data[i + 1]
        rgb[j + 2] = data[i + 2]
      }
      const stream = new Blob([rgb]).stream().pipeThrough(new CompressionStream('deflate'))
      const deflated = new Uint8Array(await new Response(stream).arrayBuffer())
      return { data: deflated, width: canvas.width, height: canvas.height, filter: 'FlateDecode' }
    }
    const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95))
    if (!jpeg) throw new Error(i18n.t('exportEngine.errors.couldNotRasteriseDiagram'))
    return { data: new Uint8Array(await jpeg.arrayBuffer()), width: canvas.width, height: canvas.height, filter: 'DCTDecode' }
  })
}

/**
 * The LIVE 3D board captured at its current camera framing, as a PNG.
 * Unlike the 2D exporters this reads the mounted Scene3D (registered in the
 * activeScene registry) rather than standing up a throwaway engine: a 3D export
 * IS "what I'm looking at", supersampled. Throws when no 3D board is mounted
 * (the Export tab only offers this while the 3D view is open).
 */
export function renderView3dPngBlob(scale: number): Blob {
  const scene = getActiveScene3D()
  if (!scene) throw new Error(i18n.t('exportEngine.errors.no3dView'))
  return scene.capturePng(scale)
}

/** The current diagram rendered by the real engine to a PNG blob at 1×/2×/3×.
 * With `embedLegend`, the raster grows below the content and the legend card
 * is composed onto the final image bottom-left. */
export async function renderDiagramPngBlob(
  bundle: ExportBundle,
  diagramId: string,
  theme: ImageTheme,
  scale: number,
  opts?: { embedLegend?: boolean },
): Promise<Blob> {
  const scene = sceneFromBundle(bundle, diagramId)
  if (!scene) throw new Error(i18n.t('exportEngine.errors.noDiagramToExport'))
  const skin = resolveExportSkin(scene, theme)
  const legend: LegendModel | null = opts?.embedLegend ? buildLegendModel(scene) : null
  return withExportEngine(scene, skin, theme, async (engine, canvas) => {
    const pad = 48
    const bounds = contentBounds(engine, scene)
    const cssW = Math.max(1, Math.round(bounds.width + pad * 2))
    const cssH = Math.max(1, Math.round(bounds.height + pad * 2))
    const ratio = Math.min(scale, MAX_RASTER_EDGE / cssW, MAX_RASTER_EDGE / cssH)
    engine.setPixelRatio(ratio)
    engine.resize(cssW, cssH)
    // Canvas sized to bounds + 2·pad with the same focus padding → viewport scale
    // is exactly 1, so the raster density is purely the pixel ratio.
    engine.focusOnBounds(bounds, pad)
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      await document.fonts.ready
    }
    await nextFrame()
    await engine.whenIconsSettled()
    await nextFrame()

    let out: HTMLCanvasElement = canvas
    if (legend && legend.entries.length) {
      const probe = document.createElement('canvas').getContext('2d')!
      const fontFamily = skin.renderStyle.fontFamily ?? 'Inter, system-ui, sans-serif'
      const dims = legendSize(legend, (t, size, weight) => {
        probe.font = `${weight} ${size}px ${fontFamily}`
        return probe.measureText(t).width
      })
      const legendX = 16
      const legendY = cssH - 28
      const totalW = Math.max(cssW, legendX + dims.width + 16)
      const totalH = legendY + dims.height + 16
      const composed = document.createElement('canvas')
      composed.width = Math.ceil(totalW * ratio)
      composed.height = Math.ceil(totalH * ratio)
      const ctx = composed.getContext('2d')!
      ctx.scale(ratio, ratio)
      ctx.fillStyle = skin.canvas.bg
      ctx.fillRect(0, 0, totalW, totalH)
      ctx.drawImage(canvas, 0, 0, cssW, cssH)
      drawLegendCanvas(ctx, legend, skin, legendX, legendY)
      out = composed
    }

    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error(i18n.t('exportEngine.errors.couldNotRasteriseDiagram'))
    return blob
  })
}
