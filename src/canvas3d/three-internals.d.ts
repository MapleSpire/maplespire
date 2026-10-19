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
//
// three's internal WebGLBackground ships no typings (@types/three covers the
// other webgl/ modules). Only the parity test (backdrop.test.ts) imports it,
// as an oracle for the background quad three would draw; never app code.

declare module 'three/src/renderers/webgl/WebGLBackground.js' {
  export const WebGLBackground: new (...args: unknown[]) => {
    addToRenderList(renderList: unknown, scene: unknown): void
  }
}
