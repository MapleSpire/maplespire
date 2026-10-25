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

// Lazy ELK instance: the bundled build (`elkjs/lib/elk.bundled.js`), which lays out
// on the calling thread. In a browser that thread is a LAYOUT WORKER — the
// auto-layout runs whole candidates (ELK, routing, scoring) in a pool of them
// (layoutRunner.ts) — and in Node/vitest, or when those workers are unavailable,
// it is the calling thread itself. The dynamic import keeps elkjs out of the main
// bundle (code-split).

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
    elkPromise = loadElk().catch((error: unknown) => {
      // Without ELK every portfolio candidate is dropped and auto-layout falls back
      // to the custom engine, which nothing else reports (an elkjs missing from
      // node_modules once did exactly that, silently). Not cached: a chunk that failed to
      // load offline loads once the network is back.
      console.warn('[layout] elkjs failed to load; auto-layout uses the custom engine only', error)
      elkPromise = null
      throw error
    })
  }
  return elkPromise
}

async function loadElk(): Promise<ElkInstance> {
  const mod = await import('elkjs/lib/elk.bundled.js')
  const ELK = (mod as unknown as { default: new () => ElkInstance }).default
  // The first `new ELK()` requires elk.bundled.js's GWT module
  // (`require('./elk-worker.min.js')` in the ELKNode constructor), which decides
  // there whether it runs inside a worker — a `self` and no `document` — and
  // inside one becomes a worker of its own: it sets `self.onmessage` to its
  // dispatcher and exports no in-thread ELK. In a layout worker that took the
  // worker's messages: the first ELK job got no ELK, every job after it no answer
  // (layoutWorker.test.ts). A `document` present for that one synchronous call
  // sends it down its in-thread branch, the one Node takes.
  const inWorker = typeof document === 'undefined' && typeof self !== 'undefined'
  const scope = globalThis as { document?: unknown }
  if (inWorker) scope.document = {}
  try {
    return new ELK()
  } finally {
    if (inWorker) delete scope.document
  }
}
