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

// Lazy ELK instance. We use the bundled build (`elkjs/lib/elk.bundled.js`) which
// runs the layout on the calling thread inside a promise — fine for the one-shot
// import / "Auto-layout" actions, and works identically in the browser and in
// Node/vitest. The dynamic import keeps elkjs out of the main bundle (code-split).

export interface ElkPoint {
  x: number
  y: number
}
export interface ElkEdgeSection {
  startPoint: ElkPoint
  endPoint: ElkPoint
  bendPoints?: ElkPoint[]
}
export interface ElkExtEdge {
  id: string
  sources: string[]
  targets: string[]
  sections?: ElkEdgeSection[]
}
export interface ElkNode {
  id: string
  x?: number
  y?: number
  width?: number
  height?: number
  children?: ElkNode[]
  edges?: ElkExtEdge[]
  layoutOptions?: Record<string, string>
}
export interface ElkInstance {
  layout(graph: ElkNode): Promise<ElkNode>
}

let elkPromise: Promise<ElkInstance> | null = null

export function getElk(): Promise<ElkInstance> {
  if (!elkPromise) {
    elkPromise = import('elkjs/lib/elk.bundled.js').then((mod) => {
      const ELK = (mod as unknown as { default: new () => ElkInstance }).default
      return new ELK()
    })
  }
  return elkPromise
}
