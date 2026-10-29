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

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/shallow'
import { cn } from '../../lib/utils'
import { useModelStore, getDiagramIndex } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { useSkinStore } from '../../stores/skinStore'
import { useThemeStore } from '../../stores/themeStore'
import { filterAndMergeDiagramData } from '../../lib/viewLayouts'
import { parentLookup } from '../../lib/diagrams/objectScope'
import { resolveTheme3d, themeFor3d } from '../../plugins/theme3d'
import { resolveSceneDecor } from '../../canvas3d/decor/decorSpec'
import { DecorPopover } from './DecorPopover'
import { CameraControls } from './CameraControls'
import { WebglFallback } from './WebglFallback'
import { measureCanvasSafeInsets } from './canvasSafeArea'
import type { Scene3D } from '../../canvas3d'
import { undoHistory } from '../../lib/history/undoHistory'
import type { C4Object, Connection, Group } from '../../types'

/** The 2D↔3D morph choreography, as overlay phases:
 * boot  — chunk/scene loading, canvas transparent, the flat canvas shows through
 * enter — first GL frame matches the 2D framing; ~150ms crossfade covers it
 * live  — the board; the 2D canvas beneath is hidden ("covered")
 * exit  — reverse camera tween to the flat reading (2D canvas revealed beneath)
 * bye   — ~150ms crossfade back, then the host unmounts us */
type MorphPhase = 'boot' | 'enter' | 'live' | 'exit' | 'bye'

const prefersReduced = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * The WebGL 3D board host — mounted by CanvasView (as an overlay above the 2D
 * canvas) while `uiStore.canvasViewMode === '3d'` (and kept mounted through the
 * exit morph). Owns the Scene3D lifecycle: the `canvas3d` chunk (three + SDF
 * fonts) lazy-loads on first entry, data is resolved through the 3D layout
 * layer (3D ?? 2D), and every edit callback lands on the SAME store actions the
 * 2D engine uses — the store routes writes to the diagram's separate 3D layer
 * (fork-on-first-3D-edit) because the view mode is '3d'.
 */
export function Canvas3DView({
  readonly: readonlyProp = false,
  active = true,
  onCoveredChange,
  onExited,
  get2dViewport,
  set2dViewport,
  sharedSceneRef,
}: {
  readonly?: boolean
  /** false → run the exit choreography, then fire onExited so the host unmounts us. */
  active?: boolean
  /** true once the overlay fully covers the 2D canvas (host may hide it),
   * false the moment the exit starts (host reveals it beneath the crossfade). */
  onCoveredChange?: (covered: boolean) => void
  onExited?: () => void
  /** 2D engine viewport bridges for the framing identity (enter) / handoff (exit). */
  get2dViewport?: () => { x: number; y: number; scale: number } | null
  set2dViewport?: (v: { x: number; y: number; scale: number }) => void
  /** Lets the host's shared zoom cluster control the live 3D camera. */
  sharedSceneRef?: MutableRefObject<Scene3D | null>
}) {
  const { t } = useTranslation()
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<Scene3D | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [phase, setPhase] = useState<MorphPhase>('boot')
  const phaseRef = useRef(phase)

  // Latest-ref the morph bridges: the scene-lifecycle effect mounts once.
  // Synced in an (ordered-first) effect so later effects read current values.
  const getViewportRef = useRef(get2dViewport)
  const setViewportRef = useRef(set2dViewport)
  const onCoveredChangeRef = useRef(onCoveredChange)
  const onExitedRef = useRef(onExited)
  useEffect(() => {
    phaseRef.current = phase
    getViewportRef.current = get2dViewport
    setViewportRef.current = set2dViewport
    onCoveredChangeRef.current = onCoveredChange
    onExitedRef.current = onExited
  })

  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const currentDiagram = useModelStore((s) => s.diagrams.find((d) => d.id === s.currentDiagramId))
  const objects = useModelStore(
    useShallow((s) => {
      const d = s.diagrams.find((d) => d.id === s.currentDiagramId)
      if (!d) return [] as C4Object[]
      const idx = getDiagramIndex()
      return d.objectIds.map((id) => idx.objectById.get(id)).filter((o): o is C4Object => !!o)
    })
  )
  const connections = useModelStore(
    useShallow((s) => {
      const d = s.diagrams.find((d) => d.id === s.currentDiagramId)
      if (!d) return [] as Connection[]
      const idx = getDiagramIndex()
      return d.connectionIds.map((id) => idx.connectionById.get(id)).filter((c): c is Connection => !!c)
    })
  )
  const groups = useModelStore(
    useShallow((s) => {
      const d = s.diagrams.find((d) => d.id === s.currentDiagramId)
      if (!d) return [] as Group[]
      const idx = getDiagramIndex()
      return d.groupIds.map((id) => idx.groupById.get(id)).filter((g): g is Group => !!g)
    })
  )
  const selectedItems = useModelStore((s) => s.selectedItems)
  const selectObjects = useModelStore((s) => s.selectObjects)
  const selectGroup = useModelStore((s) => s.selectGroup)
  const selectConnection = useModelStore((s) => s.selectConnection)
  const toggleSelectItem = useModelStore((s) => s.toggleSelectItem)
  const clearSelection = useModelStore((s) => s.clearSelection)
  const moveObject = useModelStore((s) => s.moveObject)
  const updateGroup = useModelStore((s) => s.updateGroup)
  const updateConnection = useModelStore((s) => s.updateConnection)
  const resetDiagram3dLayout = useModelStore((s) => s.resetDiagram3dLayout)

  const bottomTab = useUIStore((s) => s.bottomTab)
  const activeTagGroupId = useUIStore((s) => s.activeTagGroupId)
  const hoveredTagId = useUIStore((s) => s.hoveredTagId)
  const pinnedTagIds = useUIStore((s) => s.pinnedTagIds)
  const focusedTagId = useUIStore((s) => s.focusedTagId)
  const hiddenTagIds = useUIStore((s) => s.hiddenTagIds)
  const technologyPerspective = useUIStore((s) => s.managedPerspectiveInteractions.technology)
  const statusPerspective = useUIStore((s) => s.managedPerspectiveInteractions.status)
  const teamsPerspective = useUIStore((s) => s.managedPerspectiveInteractions.teams)
  const showGrid = useUIStore((s) => s.showGrid)
  const cameraPreset = useUIStore((s) => s.cameraPreset)
  const setCameraPreset = useUIStore((s) => s.setCameraPreset)
  const cameraResetRequestId = useUIStore((s) => s.cameraResetRequestId)
  const rightSidebarOpen = useUIStore((s) => s.rightSidebarOpen)
  const setCanvasViewMode = useUIStore((s) => s.setCanvasViewMode)

  const appTheme = useThemeStore((s) => s.resolved)
  const resolvedSkin = useSkinStore((s) => s.getResolvedSkin(currentDiagram?.skinId, appTheme))

  const isReadonly = readonlyProp || (currentDiagram?.readonly ?? false)

  // Push the 3D-resolved composition (3D ?? 2D per shape/connection) into the scene.
  const syncData = useCallback(() => {
    const scene = sceneRef.current
    if (!scene) return
    const store = useModelStore.getState()
    const diagram = store.getCurrentDiagram()
    const { filteredObjects, filteredConnections, filteredGroups } = filterAndMergeDiagramData(
      diagram,
      store.objects,
      store.connections,
      store.groups,
      '3d',
      parentLookup((id) => getDiagramIndex().objectById.get(id)),
    )
    scene.setData(filteredObjects, filteredConnections, filteredGroups, store.tags)
  }, [])

  // Scene lifecycle — chunk lazy-loads on the FIRST 3D toggle of the session.
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
          onObjectSelect: (id, multi) => {
            if (id === null) {
              clearSelection()
            } else if (multi) {
              toggleSelectItem({ id, type: 'object' })
            } else {
              const current = useModelStore.getState().selectedItems
              const alreadySelected = current.some((s) => s.type === 'object' && s.id === id)
              if (!(alreadySelected && current.filter((s) => s.type === 'object').length > 1)) {
                selectObjects([id])
              }
            }
          },
          onGroupSelect: (id) => {
            if (id === null) clearSelection()
            else selectGroup(id)
          },
          onConnectionSelect: (id) => {
            if (id === null) clearSelection()
            else selectConnection(id)
          },
          onObjectMove: (id, position) => moveObject(id, position),
          onGroupMove: (id, position) => updateGroup(id, { position }),
          // Same handlers as CanvasView; in 3D mode the store redirects the
          // routing fields to their *3d twins (fork-on-first-3D-edit).
          onConnectionAnchorMove: (connId, end, targetId, anchorIndex) => {
            if (end === 'source') {
              updateConnection(connId, { fromId: targetId, fromAnchor: anchorIndex, lockedToAnchors: true })
            } else {
              updateConnection(connId, { toId: targetId, toAnchor: anchorIndex, lockedToAnchors: true })
            }
          },
          onConnectionWaypointsChange: (connId, waypoints) => {
            updateConnection(connId, { waypoints: waypoints.length > 0 ? waypoints : undefined })
          },
          onConnectionLabelMove: (connId, position, offset) => {
            updateConnection(connId, { labelPosition: position, labelOffset: offset })
          },
          // The board writes a drag on every pointermove; its end closes the
          // undo entry, so one drag is one Ctrl+Z.
          onDragEnd: () => undoHistory.seal(),
        })
        sceneRef.current = scene
        if (sharedSceneRef) sharedSceneRef.current = scene
        // fit-to-screen frames inside what the floating chrome leaves
        // visible, measured from the DOM when the fit runs (canvasSafeArea.ts)
        scene.setSafeAreaProvider(() => measureCanvasSafeInsets(canvas))
        const mounted = scene
        // the e2e/readiness probe reads "animating" from here until the enter
        // tween starts — the build + compile wait below are part of the enter
        mounted.holdForEnter()
        // Two tasks, not one: the renderer/context creation above, then — after
        // yielding to the event loop — the configuration and the ONE scene
        // build it batches. Back to back they were a single 114-123 ms task
        // (enter3d import.then, view3d quality loop 2026-10-08); split and
        // batched, the longest enter task read 66-86 ms over eight runs — still
        // above 50: the CDP profile puts slab geometry, paper-board textures
        // and room-environment setup inside that one build.
        return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
          if (disposed || sceneRef.current !== mounted) return
          configure(mounted)
          return afterBuild(mounted)
        })
      })
      .catch((err) => {
        console.error('3D view failed to load', err)
        setFailed(true)
      })

    function configure(target: Scene3D): void {
      target.batch(() => {
        target.setResolvedTheme(useThemeStore.getState().resolved)
        target.setReadonly(isReadonly)
        target.setSize(wrap!.clientWidth, wrap!.clientHeight)
        const skin = useSkinStore.getState().getResolvedSkin(
          useModelStore.getState().getCurrentDiagram()?.skinId,
          useThemeStore.getState().resolved,
        )
        target.setSkin(skin)
        target.setTheme3d(themeFor3d(skin))
        const diag = useModelStore.getState().getCurrentDiagram()
        target.setConnectionHighlightStyle(diag?.connectionHighlightStyle ?? 'traveling-dot')
        target.setConnectionAnimationsEnabled(diag?.connectionAnimationsEnabled ?? true)
        target.setSceneDecor(resolveSceneDecor(diag))
        target.setBottomTab(useUIStore.getState().bottomTab)
        target.setActiveTagGroup(useUIStore.getState().activeTagGroupId)
        {
          const ui = useUIStore.getState()
          target.setTagInteractions(ui.hoveredTagId, ui.pinnedTagIds, ui.focusedTagId, ui.hiddenTagIds)
          for (const kind of ['technology', 'status', 'teams'] as const) {
            const interaction = ui.managedPerspectiveInteractions[kind]
            target.setManagedPerspectiveInteractions(
              kind,
              interaction.hoveredId,
              interaction.pinnedIds,
              interaction.focusedId,
              interaction.hiddenIds,
            )
          }
        }
        target.setShowGrid(useUIStore.getState().showGrid)
        target.setCameraPreset(useUIStore.getState().cameraPreset)
        syncData()
        target.setSelection(useModelStore.getState().selectedItems.map((s) => s.id))
      })
    }

    function afterBuild(mounted: Scene3D): Promise<void> {
      // The scene's shaders link asynchronously (Scene3D.scheduleCompile):
      // the 2D board stays on screen and the page stays responsive until
      // they are ready, then the morph plays from its first frame instead
      // of a tween that already ran while the main thread was frozen.
      // the user may leave 3D while the programs link (seconds on a cold
      // GPU): the exit choreography then owns the camera and the phase
      const leaving = () => phaseRef.current === 'exit' || phaseRef.current === 'bye'
      return mounted.whenCompiled().then(() => {
        if (disposed || sceneRef.current !== mounted || leaving()) return
        // §5 enter morph: first frame = the flat canvas reading (framing
        // identity with the 2D viewport, floor undressed), one design tween up.
        mounted.enterMorph(getViewportRef.current?.() ?? null, {
          width: wrap!.clientWidth,
          height: wrap!.clientHeight,
        })
        // …and the faded-floor variants enterMorph just asked for
        return mounted.whenCompiled().then(() => {
          if (disposed || sceneRef.current !== mounted || leaving()) return
          setReady(true)
          // Start the crossfade only once the scene has real pixels — its rAF
          // (queued by enterMorph) renders before this one fires.
          requestAnimationFrame(() => {
            if (!disposed) setPhase('enter')
          })
        })
      })
    }

    const observer = new ResizeObserver(() => {
      if (wrapRef.current && sceneRef.current) {
        sceneRef.current.setSize(wrapRef.current.clientWidth, wrapRef.current.clientHeight)
      }
    })
    observer.observe(wrap)

    return () => {
      disposed = true
      observer.disconnect()
      sceneRef.current = null
      if (sharedSceneRef) sharedSceneRef.current = null
      scene?.dispose()
      setReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // enter → live: the ~150ms crossfade has covered the 2D canvas.
  useEffect(() => {
    if (phase !== 'enter') return
    const timer = window.setTimeout(() => {
      onCoveredChangeRef.current?.(true)
      setPhase('live')
    }, prefersReduced() ? 0 : 200)
    return () => window.clearTimeout(timer)
  }, [phase])

  // Exit choreography: reveal the 2D canvas beneath, hand it the camera's
  // framing, reverse-tween flat, then crossfade out and let the host unmount.
  useEffect(() => {
    if (active) {
      // Re-entered mid-exit (rare): abort the goodbye and tween back up.
      if (phaseRef.current === 'exit' || phaseRef.current === 'bye') {
        sceneRef.current?.enterMorph(null)
        onCoveredChangeRef.current?.(true)
        setPhase('live')
      }
      return
    }
    onCoveredChangeRef.current?.(false)
    const scene = sceneRef.current
    const wrap = wrapRef.current
    if (!scene || !wrap) {
      onExitedRef.current?.()
      return
    }
    setPhase('exit')
    let finished = false
    let byeTimer: number | undefined
    const finish = () => {
      if (finished) return
      finished = true
      setPhase('bye')
      byeTimer = window.setTimeout(() => onExitedRef.current?.(), prefersReduced() ? 0 : 200)
    }
    const view = scene.exitMorph({ width: wrap.clientWidth, height: wrap.clientHeight }, finish)
    setViewportRef.current?.(view)
    // Fallback: a free-nav interrupt drops the tween's completion callback.
    const safety = window.setTimeout(finish, 1600)
    return () => {
      window.clearTimeout(safety)
      if (byeTimer) window.clearTimeout(byeTimer)
    }
  }, [active])

  // Data / skin / selection / readonly follow the stores.
  useEffect(() => {
    if (ready) syncData()
  }, [ready, syncData, objects, connections, groups, currentDiagram?.layouts, currentDiagram?.layouts3d])
  useEffect(() => {
    if (ready && resolvedSkin) {
      sceneRef.current?.setSkin(resolvedSkin)
      // Community skins run their 3D hooks in the sandbox worker: specs land
      // async, onUpdate re-pushes the same source so the rebuild hits the cache.
      const resolved = resolveTheme3d(resolvedSkin, () => {
        sceneRef.current?.setTheme3d(resolved.source)
      })
      sceneRef.current?.setTheme3d(resolved.source)
      return () => resolved.dispose()
    }
  }, [ready, resolvedSkin])
  useEffect(() => {
    if (ready) sceneRef.current?.setResolvedTheme(appTheme)
  }, [appTheme, ready])
  useEffect(() => {
    if (ready) sceneRef.current?.setSelection(selectedItems.map((s) => s.id))
  }, [ready, selectedItems])
  // Focus-animation settings follow the diagram (same values the 2D engine gets).
  const highlightStyle = currentDiagram?.connectionHighlightStyle ?? 'traveling-dot'
  const connAnimationsEnabled = currentDiagram?.connectionAnimationsEnabled ?? true
  const sceneDecor = currentDiagram?.sceneDecor
  const diagramIdForDecor = currentDiagram?.id
  useEffect(() => {
    if (!ready) return
    sceneRef.current?.setSceneDecor(resolveSceneDecor(useModelStore.getState().getCurrentDiagram()))
  }, [ready, sceneDecor, diagramIdForDecor])
  useEffect(() => {
    if (!ready) return
    sceneRef.current?.setConnectionHighlightStyle(highlightStyle)
    sceneRef.current?.setConnectionAnimationsEnabled(connAnimationsEnabled)
  }, [ready, highlightStyle, connAnimationsEnabled])
  // BottomBar "color by" tab drives the accent bars, like the 2D engine.
  useEffect(() => {
    if (ready) sceneRef.current?.setBottomTab(bottomTab)
  }, [ready, bottomTab])
  useEffect(() => {
    if (ready) sceneRef.current?.setActiveTagGroup(activeTagGroupId)
  }, [ready, activeTagGroupId])
  useEffect(() => {
    if (ready) {
      sceneRef.current?.setTagInteractions(hoveredTagId, pinnedTagIds, focusedTagId, hiddenTagIds)
    }
  }, [ready, hoveredTagId, pinnedTagIds, focusedTagId, hiddenTagIds])
  useEffect(() => {
    if (!ready) return
    sceneRef.current?.setManagedPerspectiveInteractions(
      'technology',
      technologyPerspective.hoveredId,
      technologyPerspective.pinnedIds,
      technologyPerspective.focusedId,
      technologyPerspective.hiddenIds,
    )
  }, [ready, technologyPerspective])
  useEffect(() => {
    if (!ready) return
    sceneRef.current?.setManagedPerspectiveInteractions(
      'status',
      statusPerspective.hoveredId,
      statusPerspective.pinnedIds,
      statusPerspective.focusedId,
      statusPerspective.hiddenIds,
    )
  }, [ready, statusPerspective])
  useEffect(() => {
    if (!ready) return
    sceneRef.current?.setManagedPerspectiveInteractions(
      'teams',
      teamsPerspective.hoveredId,
      teamsPerspective.pinnedIds,
      teamsPerspective.focusedId,
      teamsPerspective.hiddenIds,
    )
  }, [ready, teamsPerspective])
  // The grid toggle hides the floor dots (visual only — snapping stays on).
  useEffect(() => {
    if (ready) sceneRef.current?.setShowGrid(showGrid)
  }, [ready, showGrid])
  useEffect(() => {
    sceneRef.current?.setReadonly(isReadonly)
  }, [isReadonly])

  // Camera preset chips + the reset request (pill's "3D again = reset").
  useEffect(() => {
    if (ready && sceneRef.current && sceneRef.current.getPreset() !== cameraPreset) {
      sceneRef.current.setCameraPreset(cameraPreset)
    }
  }, [ready, cameraPreset])
  useEffect(() => {
    if (cameraResetRequestId > 0) sceneRef.current?.resetCamera()
  }, [cameraResetRequestId])

  if (failed) {
    // WebGL-absent fallback: the 2D canvas is intact beneath — offer the
    // way back instead of a dead board. Flipping the mode unmounts us.
    return <WebglFallback onBackTo2d={() => setCanvasViewMode('2d', currentDiagramId)} />
  }

  const leaving = phase === 'exit' || phase === 'bye'
  const faded = phase === 'boot' || phase === 'bye'

  return (
    <div
      ref={wrapRef}
      data-testid="canvas-3d"
      data-morph={phase}
      className={cn('absolute inset-0 z-20', leaving && 'pointer-events-none')}
    >
      <canvas
        ref={canvasRef}
        className={cn(
          'block h-full w-full transition-opacity duration-150 motion-reduce:transition-none',
          faded ? 'opacity-0' : 'opacity-100'
        )}
        style={{ touchAction: 'none' }}
      />
      {/* pointer-events-none: the spinner is not chrome. The safe-area
          measurement (canvasSafeArea.ts) hit-tests what floats over the
          canvas, and the enter framing (Scene3D.enterTargetPose) is measured
          while this is still up: a 40-px sample grid that lands on the 24-px
          centred spinner would clear it from one side, as if a panel sat in
          the middle of the board. Not observed at 1280x720 or 1600x1000 (no
          sample point falls on it there) — a hazard at other sizes. */}
      {!ready && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-fg-subtle border-t-transparent" />
        </div>
      )}
      {/* Sits left of the floating right panel like the 2D zoom cluster (which
          lives at bottom-3.5; stack above it). Crossfades with the canvas. */}
      <div
        className={cn(
          'absolute bottom-[60px] z-30 transition-opacity duration-150 motion-reduce:transition-none',
          rightSidebarOpen ? 'right-[338px]' : 'right-3',
          (faded || leaving) && 'pointer-events-none opacity-0'
        )}
      >
        <CameraControls
          preset={cameraPreset}
          onPresetChange={(p) => setCameraPreset(p, currentDiagramId)}
          onReset={() => sceneRef.current?.resetCamera()}
        >
          {!isReadonly && currentDiagramId && <DecorPopover diagramId={currentDiagramId} />}
          {!isReadonly && currentDiagram?.layouts3d && (
            <button
              data-testid="camera-align-2d"
              onClick={() => {
                if (window.confirm(t('canvasViewChrome.camera.alignConfirm'))) {
                  resetDiagram3dLayout()
                }
              }}
              title={t('canvasViewChrome.camera.alignTitle')}
              className={cn(
                'ml-0.5 flex h-8 items-center justify-center rounded-lg px-2.5 text-[11px] font-semibold',
                'text-fg-secondary hover:bg-surface-50'
              )}
            >
              {t('canvasViewChrome.camera.align')}
            </button>
          )}
        </CameraControls>
      </div>
    </div>
  )
}
