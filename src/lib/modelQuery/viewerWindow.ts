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

import type { ViewerLevelResult } from './types'
import { mergeUniquePageItems } from './pageMerge'

export interface ViewerLevelWindow extends ViewerLevelResult {
  loaded: boolean
}

export const EMPTY_VIEWER_WINDOW: ViewerLevelWindow = {
  ancestors: [],
  objects: [],
  connections: [],
  nextCursor: null,
  totalObjects: 0,
  connectionsTruncated: false,
  projectionGeneration: 0,
  coverage: 'working-set',
  loaded: false,
}

/** Merge a subsequent level page without ever consulting whole resident model
 * arrays. Cross-page edges are not part of the current server contract, so an
 * appended object window is explicitly marked connection-truncated. */
export function mergeViewerLevelWindow(
  current: ViewerLevelWindow,
  page: ViewerLevelResult,
  append: boolean,
): ViewerLevelWindow {
  const hadObjectPage = append && current.objects.length > 0
  return {
    ancestors: mergeUniquePageItems(append ? current.ancestors : [], page.ancestors, !append),
    objects: mergeUniquePageItems(append ? current.objects : [], page.objects, !append, (item) => item.object.id),
    connections: mergeUniquePageItems(append ? current.connections : [], page.connections, !append),
    nextCursor: page.nextCursor,
    totalObjects: page.totalObjects,
    connectionsTruncated: current.connectionsTruncated || page.connectionsTruncated || hadObjectPage,
    projectionGeneration: page.projectionGeneration,
    coverage: page.coverage === 'working-set' || (append && current.coverage === 'working-set') ? 'working-set' : 'full',
    loaded: true,
  }
}
