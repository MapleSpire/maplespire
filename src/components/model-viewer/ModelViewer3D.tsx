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

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import { useSkinStore } from '../../stores/skinStore'
import { useThemeStore } from '../../stores/themeStore'
import { resolveTheme3d, themeFor3d } from '../../plugins/theme3d'
import { CameraControls } from '../diagram/CameraControls'
import { WebglFallback } from '../diagram/WebglFallback'
import {
  childrenOf,
  connsAtLevel,
  hasChildren,
  type ParentId,
  type ViewerModel,
} from '../../lib/modelViewer/levels'
import { computeViewerLayout, type ViewerLayout } from '../../lib/modelViewer/layout'
import { ZOOM_K } from './ViewerGrid'
import type { ViewerSelection } from './ViewerGrid'
import type { Scene3D } from '../../canvas3d'
import type { ModelViewerOptions, CanvasCameraPreset } from '../../stores/uiStore'
import type { C4Object, Connection, Domain, Group } from '../../types'

/** Half of the two-phase drill choreography (dive → swap → bloom); the total
 * roughly matches the 2D zoom's 560ms while giving the camera room to travel. */
const HALF_MS = 340
/** Crossfade covering the data swap between the two halves. */
const FADE_MS = 140

const prefersReduced = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

const samePath = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])

interface LevelScene {
  layout: ViewerLayout
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
  /** Objects with a lower level — they get the corner expand glyph. */
  expandableIds: string[]
}

/**
 * The Model Viewer's 3D presentation: the SAME deterministic grid layout as the
 * 2D view, rendered as the WebGL board (read-only). Drilling keeps the 2D
 * transition's reading — the camera dives INTO the opened tile, the data swaps
 * under a short crossfade, and the lower level blooms out of the dived point;
 * ascending runs the exact reverse. Double-click a node, the panel's "Open
 * lower level", the boundary Back and the breadcrumb all drive the same path.
 */
export function ModelViewer3D({
  model,
  connections,
  domainById,
  path,
  onPath,
  selection,
  onSelectObject,
  onSelectConn,
  onClear,
  opts,
  onBackTo2d,
  insets,
}: {
  model: ViewerModel
  connections: Connection[]
  domainById: Map<string, Domain>
  path: string[]
  onPath: (path: string[]) => void
  selection: ViewerSelection
  onSelectObject: (id: string) => void
  onSelectConn: (id: string) => void
  onClear: () => void
  opts: ModelViewerOptions
  onBackTo2d: () => void
  insets: { left: number; right: number }
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<Scene3D | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [faded, setFaded] = useState(false)
  const [preset, setPreset] = useState<CanvasCameraPreset>('iso')

  // The level the BOARD currently shows; `path` may run ahead during a drill.
  const [renderPath, setRenderPath] = useState<string[]>(path)
  const drilling = useRef(false)
  const timers = useRef<number[]>([])

  const appTheme = useThemeStore((s) => s.resolved)
  const resolvedSkin = useSkinStore((s) => s.getResolvedSkin(undefined, appTheme))

  // Latest-refs for values the (mount-once) scene callbacks need.
  const modelRef = useRef(model)
  const pathRef = useRef(path)
  const renderPathRef = useRef(renderPath)
  const onPathRef = useRef(onPath)
  const onSelectObjectRef = useRef(onSelectObject)
  const onSelectConnRef = useRef(onSelectConn)
  const onClearRef = useRef(onClear)
  useEffect(() => {
    modelRef.current = model
    pathRef.current = path
    renderPathRef.current = renderPath
    onPathRef.current = onPath
    onSelectObjectRef.current = onSelectObject
    onSelectConnRef.current = onSelectConn
    onClearRef.current = onClear
  })

  /** A level as board data: grid-layout positions, level connections stripped
   * of their per-diagram routing, and (when drilled) a boundary group plate. */
  const levelScene = useCallback(
    (parentId: ParentId): LevelScene => {
      const m = modelRef.current
      let kids = childrenOf(m, parentId)
      if (!opts.showEmpty) {
        const nonEmpty = kids.filter((o) => hasChildren(m, o.id))
        if (nonEmpty.length) kids = nonEmpty
      }
      // A fixed generous area: the layout's internal (unscaled) tile coords are
      // the world coords — the camera does the fitting, not the layout scale.
      const layout = computeViewerLayout(kids, parentId, { x: 0, y: 0, w: 4000, h: 3000 }, { density: opts.density })
      const objects = layout.tiles.map((t) => ({
        ...t.o,
        position: { x: t.x, y: t.y },
        size: { width: t.w, height: t.h },
      }))
      const conns = connsAtLevel(m, connections, parentId).map((c) => ({
        id: c.id,
        fromId: c.fromId,
        toId: c.toId,
        label: c.label,
        type: c.type,
        status: c.status,
      }))
      const groups: Group[] = []
      const parent = parentId ? m.objectById.get(parentId) : undefined
      if (parent) {
        groups.push({
          id: `mv-boundary-${parent.id}`,
          name: parent.name,
          color: domainById.get(parent.domainId ?? '')?.color ?? '#8B857B',
          fillOpacity: 0.06,
          objectIds: objects.map((o) => o.id),
          position: { x: -layout.padX, y: -layout.padT },
          size: { width: layout.fullW, height: layout.fullH },
          autoSize: false,
          description: parent.description,
          tagAssignments: {},
          tagOrder: [],
        })
      }
      return {
        layout,
        objects,
        connections: conns,
        groups,
        expandableIds: objects.filter((o) => hasChildren(m, o.id)).map((o) => o.id),
      }
    },
    [connections, domainById, opts.density, opts.showEmpty]
  )

  const pushLevel = useCallback(
    (parentId: ParentId): LevelScene => {
      const lvl = levelScene(parentId)
      sceneRef.current?.setData(lvl.objects, lvl.connections, lvl.groups, [], { expandableIds: lvl.expandableIds })
      return lvl
    },
    [levelScene]
  )

  const clearTimers = () => {
    for (const id of timers.current) window.clearTimeout(id)
    timers.current = []
  }

  // Scene lifecycle — the canvas3d chunk lazy-loads on first 3D entry.
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    let disposed = false
    let scene: Scene3D | null = null

    import('../../canvas3d')
      .then(({ Scene3D }) => {
        if (disposed) return
        scene = new Scene3D(canvas, {
          onObjectSelect: (id) => {
            if (id === null) onClearRef.current()
            else onSelectObjectRef.current(id)
          },
          onGroupSelect: () => onClearRef.current(),
          onConnectionSelect: (id) => {
            if (id === null) onClearRef.current()
            else onSelectConnRef.current(id)
          },
          onObjectMove: () => {},
          onGroupMove: () => {},
          onObjectOpen: (id) => {
            // Double-click = the 2D tile's expand: drill only when a lower
            // level exists. The path change drives the drill effect below.
            if (drilling.current) return
            if (hasChildren(modelRef.current, id)) {
              onPathRef.current([...renderPathRef.current, id])
            }
          },
        })
        sceneRef.current = scene
        scene.setReadonly(true)
        // Names are the point of this page — keep them past the editor's LOD
        // cut-off (they still cull once genuinely unreadable).
        scene.setLodThresholds(40, 120)
        scene.setSize(wrap.clientWidth, wrap.clientHeight)
        const skin = useSkinStore.getState().getResolvedSkin(undefined, useThemeStore.getState().resolved)
        scene.setSkin(skin)
        scene.setTheme3d(themeFor3d(skin))
        scene.setShowGrid(true)
        scene.setCameraPreset('iso')
        const lvl = levelScene(renderPathRef.current.length ? renderPathRef.current[renderPathRef.current.length - 1] : null)
        scene.setData(lvl.objects, lvl.connections, lvl.groups, [], { expandableIds: lvl.expandableIds })
        scene.frame(true)
        setReady(true)
      })
      .catch((err) => {
        console.error('Model viewer 3D failed to load', err)
        setFailed(true)
      })

    const observer = new ResizeObserver(() => {
      if (wrapRef.current && sceneRef.current) {
        sceneRef.current.setSize(wrapRef.current.clientWidth, wrapRef.current.clientHeight)
      }
    })
    observer.observe(wrap)

    return () => {
      disposed = true
      observer.disconnect()
      clearTimers()
      sceneRef.current = null
      scene?.dispose()
      setReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once; live values via refs
  }, [])

  // Drill choreography: a path change dives the camera into the opened tile
  // (or pulls back out), swaps the level under a short crossfade, then lands
  // on the new level's framing — the 3D twin of the 2D twin-layer zoom.
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene) return
    if (samePath(path, renderPath) || drilling.current) return

    const speed = opts.speed || 1
    const half = Math.round(HALF_MS / speed)
    const deeper = path.length > renderPath.length
    const curParent: ParentId = renderPath.length ? renderPath[renderPath.length - 1] : null
    const curLevel = levelScene(curParent)
    const toParent: ParentId = path.length ? path[path.length - 1] : null

    const commit = (arrive: (nextLevel: LevelScene) => void) => {
      // Release the latch BEFORE setRenderPath: the state change re-runs this
      // effect, and a path change queued mid-drill must be admitted then (the
      // bloom half keeps animating; a new dive simply interrupts it, like the
      // 2D grid starting its next queued transition right after a commit).
      drilling.current = false
      const nextLevel = pushLevel(toParent)
      setRenderPath(path)
      arrive(nextLevel)
      requestAnimationFrame(() => setFaded(false))
    }

    drilling.current = true
    if (prefersReduced()) {
      // Jump-cut: swap and frame, no travel, no fades.
      const nextLevel = pushLevel(toParent)
      void nextLevel
      setRenderPath(path)
      scene.frame(false)
      drilling.current = false
      return
    }

    let done = false
    const firstHalfDone = deeper
      ? () => {
          if (done) return
          done = true
          commit((next) => {
            // Bloom: the new level grows out of the point we dove into — the
            // camera arrives at the content centre from ZOOM_K× afar.
            const cx = next.layout.worldW / 2
            const cz = next.layout.worldH / 2
            scene.arriveFrom(cx, cz, ZOOM_K, half)
          })
        }
      : () => {
          if (done) return
          done = true
          commit((next) => {
            // Ascend: start zoomed-in ON the tile we came from, pull out to fit.
            const from = renderPath[path.length]
            const tile = from ? next.layout.byId.get(from) : undefined
            const cx = tile ? tile.cx : next.layout.worldW / 2
            const cz = tile ? tile.cy : next.layout.worldH / 2
            scene.arriveFrom(cx, cz, 1 / ZOOM_K, half)
          })
        }

    if (deeper) {
      // Dive INTO the opened tile (2D: the outgoing layer scales up into it).
      const openedId = path[path.length - 1]
      const tile = curLevel.layout.byId.get(openedId)
      const cx = tile ? tile.cx : curLevel.layout.worldW / 2
      const cz = tile ? tile.cy : curLevel.layout.worldH / 2
      scene.flyTo(cx, cz, Math.max(160, diveDistance(scene)), half, firstHalfDone)
    } else {
      // Pull back ABOVE the level (2D: the outgoing layer shrinks into its tile).
      const cx = curLevel.layout.worldW / 2
      const cz = curLevel.layout.worldH / 2
      scene.flyTo(cx, cz, retreatDistance(scene), half, firstHalfDone)
    }
    // Crossfade window centred on the swap; also the tween-interrupt fallback.
    // NO cleanup here: the timers must survive effect re-runs (a mid-drill path
    // change) or a dropped tween callback would leave `drilling` latched — they
    // are cleared on unmount by the scene-lifecycle cleanup.
    timers.current.push(window.setTimeout(() => setFaded(true), Math.max(0, half - FADE_MS)))
    timers.current.push(window.setTimeout(firstHalfDone, half + 60))
    // renderPath is a dep so a path change that arrived MID-drill (guarded out
    // above) is re-examined once this drill commits, instead of being lost.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, path, renderPath])

  // Model/options changes outside a drill re-push the rendered level.
  useEffect(() => {
    if (!ready || drilling.current) return
    pushLevel(renderPath.length ? renderPath[renderPath.length - 1] : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, model, connections, opts.density, opts.showEmpty])

  // Skin/theme + selection follow the app stores.
  useEffect(() => {
    if (!ready || !resolvedSkin) return
    sceneRef.current?.setSkin(resolvedSkin)
    const resolved = resolveTheme3d(resolvedSkin, () => {
      sceneRef.current?.setTheme3d(resolved.source)
    })
    sceneRef.current?.setTheme3d(resolved.source)
    return () => resolved.dispose()
  }, [ready, resolvedSkin])
  useEffect(() => {
    if (ready) sceneRef.current?.setSelection(selection ? [selection.id] : [])
  }, [ready, selection])

  if (failed) {
    return <WebglFallback onBackTo2d={onBackTo2d} />
  }

  return (
    <div ref={wrapRef} data-testid="mv-canvas-3d" className="absolute inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        className={cn(
          'block h-full w-full transition-opacity duration-150 motion-reduce:transition-none',
          (faded || !ready) && 'opacity-0'
        )}
        style={{ touchAction: 'none' }}
      />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-fg-subtle border-t-transparent" />
        </div>
      )}
      <div
        className="absolute bottom-4 z-30 transition-[right] duration-300"
        style={{ right: insets.right ? `${insets.right}px` : 'var(--pad-r)' }}
      >
        <CameraControls
          preset={preset}
          onPresetChange={(p) => {
            setPreset(p)
            sceneRef.current?.setCameraPreset(p)
          }}
          onReset={() => sceneRef.current?.resetCamera()}
        />
      </div>
    </div>
  )
}

/** Dive-in end distance: ZOOM_K× closer than the current framing. */
function diveDistance(scene: Scene3D): number {
  return scene.getCameraPose().distance / ZOOM_K
}

/** Pull-back end distance: ZOOM_K× farther than the current framing. */
function retreatDistance(scene: Scene3D): number {
  return scene.getCameraPose().distance * ZOOM_K
}
