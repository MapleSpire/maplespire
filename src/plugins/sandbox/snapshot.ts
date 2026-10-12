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

import type { C4Type } from '../../types'

/**
 * Per-frame scene snapshot posted from the main thread to the sandbox worker.
 * Must be structured-cloneable (plain data only). A transferable ArrayBuffer
 * (struct-of-arrays) would cut copy cost on large diagrams if that becomes a
 * bottleneck.
 */

export interface SnapshotObject {
  id: string
  type: C4Type
  name: string
  x: number
  y: number
  w: number
  h: number
  cornerRadius: number
  selected: boolean
  hovered: boolean
  external: boolean
  alpha: number
}

export interface SnapshotGroup {
  id: string
  isParentWrapper: boolean
  x: number
  y: number
  w: number
  h: number
  cornerRadius: number
  selected: boolean
}

export interface SnapshotConnection {
  id: string
  type: 'solid' | 'dashed' | 'dotted'
  /** Bézier control points in world space (curve from `from` to `to`). */
  fromX: number
  fromY: number
  cp1x: number
  cp1y: number
  cp2x: number
  cp2y: number
  toX: number
  toY: number
  /** Actual object edge attach points (the curve ends are inset from these). */
  fromEdgeX: number
  fromEdgeY: number
  toEdgeX: number
  toEdgeY: number
  hovered: boolean
  highlighted: boolean
  alpha: number
}

export interface FrameSnapshot {
  viewport: { x: number; y: number; scale: number }
  dpr: number
  /** CSS pixel size of the canvas. */
  canvas: { width: number; height: number }
  timeMs: number
  fastMode: boolean
  bg: string
  objects: SnapshotObject[]
  groups: SnapshotGroup[]
  connections: SnapshotConnection[]
}

/** Per-object args for a 3D spec request (mirrors Theme3dSource.objectSpec). */
export interface Spec3dObjectArgs {
  id: string
  type: string
  name: string
  fill: string
  selected: boolean
  external: boolean
  zBase: number
  zTop: number
}

/** Floor args for a 3D spec request (mirrors Theme3dSource.floorSpec). */
export interface Spec3dFloorArgs {
  bounds: { x: number; y: number; w: number; h: number }
  dark: boolean
}

/** Messages host → worker. */
export type HostToWorker =
  | { type: 'init'; canvas: OffscreenCanvas; code: string; sdkVersion: string }
  | { type: 'frame'; snapshot: FrameSnapshot }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'thumbnail'; code: string; width: number; height: number; dpr: number; snapshot: FrameSnapshot }
  /** 3D-spec mode: compile the theme WITHOUT an overlay canvas or render loop —
   * the worker only answers `spec3d` requests (community 3D execution). */
  | { type: 'init3d'; code: string; sdkVersion: string }
  /** Batched 3D spec request: run the theme's object3d/floor3d PURE-DATA hooks.
   * Results come back RAW — the host sanitizes (never trust worker output). */
  | { type: 'spec3d'; requestId: number; timeMs: number; dark: boolean; objects: Spec3dObjectArgs[]; floor: Spec3dFloorArgs | null }
  | { type: 'dispose' }

/** Messages worker → host. */
export type WorkerToHost =
  | { type: 'ready'; seams: string[] }
  | { type: 'error'; message: string }
  | { type: 'tick'; frame: number }
  | { type: 'blocked'; api: string }
  | { type: 'thumbnail'; bitmap: ImageBitmap }
  | { type: 'ready3d'; hasObject3d: boolean; hasFloor3d: boolean }
  | { type: 'spec3d'; requestId: number; objects: Record<string, unknown>; floor: unknown }
