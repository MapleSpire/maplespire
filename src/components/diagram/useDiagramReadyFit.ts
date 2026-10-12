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

import { useEffect, useRef } from 'react'

/**
 * Run one authoritative viewport fit after the collaborative DiagramDoc is
 * attached, not merely after the temporary server-render paint.
 *
 * A draft can paint model objects before its diagram-local layouts arrive. If
 * that temporary paint consumes the normal "fit once" guard, the final layouts
 * may all land outside the old viewport and the canvas looks empty until a flow
 * focuses an object. The edit-ready edge is the first point where both sources
 * are available.
 */
export function useDiagramReadyFit(
  editReady: boolean,
  diagramId: string | null,
  fit: () => void,
): void {
  const fittedDiagramId = useRef<string | null>(null)

  useEffect(() => {
    if (!editReady || !diagramId || fittedDiagramId.current === diagramId) return
    fittedDiagramId.current = diagramId
    fit()
  }, [diagramId, editReady, fit])
}
