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

/**
 * The dev-only `window.__*` probes, declared ONCE for every spec.
 *
 * Per-spec `declare global` blocks are never compiled together, so nothing can
 * notice when they disagree with each other or with the app. A per-file
 * `declare global` is not a weak type — it is an UNFALSIFIABLE one.
 * The file that writes it is the only file that reads it, so it agrees with
 * itself by construction, whatever the app installs.
 *
 * ## Where each of these gets its truth
 *
 * `__scene3d` and `__scene3dDisposeResidue` import their types from
 * `src/canvas3d/scene3dProbe.ts`, and `Scene3D.mount()` assigns the literal with
 * `satisfies Scene3dProbe`. So those two are CHECKED against the object that is
 * really installed, by `npm run build`, on every run.
 *
 * `__modelStore` derives from `useModelStore`'s own state type, which is what
 * `bridge.ts` assigns.
 *
 * `__canvasEngine` stays a hand-written mirror: `CanvasEngine.skin` is
 * `private`, so declaring the real class here would make every spec that
 * reads it a compile error, and `CanvasView.tsx` installs it under a
 * `@ts-expect-error` for the same reason. Closing that loop means changing the
 * engine's own surface.
 *
 * ## And what NONE of this reaches
 *
 * A dozen specs read `__canvasEngine` through `(window as any)` or a local
 * `as never as {…}` cast. A cast bypasses every declaration in this file, so
 * those readers remain unchecked.
 *
 * Many `__modelStore` references in `e2e/` also go through a cast, and several
 * spec files still carry their own structural `__modelStore?: { … }` (e.g.
 * `entity-intent-journal`, `summary-workspace-functional`). Those are the same
 * unfalsifiable mirrors in different syntax; consolidate them one at a time,
 * since a blind cleanup can drop a field a spec depends on.
 *
 * Three gate/spec `declare global` pairs (`offlineDownloadRecoveryGate`, `modelReadCacheScaleGate`,
 * `renderedListConcurrencyGate`) now share one program, so TypeScript enforces
 * that each pair agrees (TS2717). They are no longer unfalsifiable either.
 */

// `__scene3d` and `__scene3dDisposeResidue` are NOT declared here. They are
// declared beside their type in `src/canvas3d/scene3dProbe.ts`, which
// `Scene3D.mount()` then assigns to directly — so the compiler owns the KEY as
// well as the shape. Restating them here would re-create the hand-copy this
// file exists to remove. The `import type` below is what keeps that module in
// the e2e program, so the augmentation reaches every spec.
import type { Scene3dProbe } from '../../src/canvas3d/scene3dProbe'
import type { useModelStore } from '../../src/stores/modelStore'

/** Referenced only so the import above cannot be pruned as unused — it is what
 *  pulls the global augmentation into this program. */
export type Scene3dProbeInThisProgram = Scene3dProbe

declare global {
  interface Window {
    __canvasEngine?: {
      getViewport(): { x: number; y: number; scale: number }
      /** Engine-resolved skin (read-only probe; TS-private, structurally readable). */
      skin?: { id: string }
    }
    // `getState()` ONLY, not `typeof useModelStore`.
    //
    // The store's own type is the accurate one — `bridge.ts` really does assign
    // the whole store — but it would widen the door: exposing `getState()` only
    // keeps `window.__modelStore.setState(…)` a compile error in every spec. This project's
    // standing rule is that every MUTATION in an e2e goes through pointer or
    // keyboard on the real UI; a probe that types the mutation door open is a
    // step toward the shortcut the rule exists to forbid.
    //
    // Accuracy is kept — the state shape is derived, not restated — while
    // `setState`, `subscribe` and `destroy` stay unreachable. (Zustand keeps
    // actions IN the state, so `getState().deleteObject(…)` still typechecks;
    // this narrows the door, it does not close it. `boot/helpers.ts` and
    // `entity-intent-journal.spec.ts` already drive actions through `as any`
    // casts, which no declaration here can reach.)
    __modelStore?: { getState(): ReturnType<typeof useModelStore.getState> }
  }
}

export {}
