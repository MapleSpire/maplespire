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

export interface DiagramFirstPaintPipeline<TVisual, TDocument> {
  loadVisual: () => Promise<TVisual>
  loadDocument: () => Promise<TDocument>
  paintVisual: (visual: TVisual) => void | Promise<void>
  afterVisualPaint?: () => void | Promise<void>
  activateEditing: (document: TDocument, visual: TVisual) => void | Promise<void>
}

/** Ceiling on the paint gate. Two frames is ~33ms at 60Hz; anything past this is
 *  a tab that is not painting, not a slow one. */
export const VISUAL_COMMIT_WAIT_MS = 500

/**
 * The default `afterVisualPaint`: let one real paint land before editing unlocks.
 *
 * **A hidden tab never fires `requestAnimationFrame`**, so waiting on it without a
 * ceiling is not a delay — it is a permanent hang, and it hangs far more than the
 * gate. This is awaited inside `switchActiveDiagram`, which `startBridge` awaits,
 * which `AutomergeBridge` awaits before setting `bridgeBooted`; with that flag
 * stuck false `RouteSync` never emits a URL either, so the address bar and the
 * browser history stop tracking the app at all. Backgrounding the tab during load
 * — a middle-click, a restored session, switching away while it loads — is enough
 * to trigger it, and the app simply never finishes booting.
 *
 * So: skip the gate outright when the document is already hidden (a tab that is
 * not painting has no paint to wait for), and put a wall-clock ceiling on the
 * case where it goes hidden mid-wait.
 */
export function waitForVisualCommit(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve()
  if (typeof document !== 'undefined' && document.hidden) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, VISUAL_COMMIT_WAIT_MS)
    requestAnimationFrame(() => requestAnimationFrame(finish))
  })
}

/** Start the visual and collaborative reads together, but expose editing only
 * after the bounded visual result has painted and the document is attached. */
export async function runDiagramFirstPaintPipeline<TVisual, TDocument>(
  pipeline: DiagramFirstPaintPipeline<TVisual, TDocument>,
): Promise<{ visual: TVisual; document: TDocument }> {
  const visualPromise = pipeline.loadVisual()
  // Observe document failure immediately even when the visual request is still
  // pending, so a fast metadata/doc rejection never becomes unhandled.
  const documentPromise = pipeline.loadDocument().then(
    (value) => ({ value } as const),
    (error: unknown) => ({ error } as const),
  )

  const visual = await visualPromise
  await pipeline.paintVisual(visual)
  await pipeline.afterVisualPaint?.()

  const documentOutcome = await documentPromise
  if ('error' in documentOutcome) throw documentOutcome.error
  const document = documentOutcome.value
  await pipeline.activateEditing(document, visual)
  return { visual, document }
}
