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
 * Minimal typings for troika-three-text (no official @types package).
 * Only the surface the 3D board uses.
 */
declare module 'troika-three-text' {
  import type { Mesh, Color } from 'three'

  export class Text extends Mesh {
    text: string
    font: string | null
    fontSize: number
    color: string | number | Color
    anchorX: number | string
    anchorY: number | string
    maxWidth: number
    whiteSpace: 'normal' | 'nowrap'
    overflowWrap: 'normal' | 'break-word'
    textAlign: 'left' | 'right' | 'center' | 'justify'
    letterSpacing: number
    lineHeight: number | 'normal'
    clipRect: [number, number, number, number] | null
    depthOffset: number
    fillOpacity: number
    outlineWidth: number | string
    sync(callback?: () => void): void
    dispose(): void
  }

  export function preloadFont(
    options: { font: string; characters?: string },
    callback: () => void,
  ): void
}

declare module '@fontsource/inter/files/*.woff' {
  const url: string
  export default url
}

declare module '@fontsource/jetbrains-mono/files/*.woff' {
  const url: string
  export default url
}
