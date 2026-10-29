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

import { layoutDiagramElk } from './elk/elkLayout'
import { layoutDiagram } from './index'
import type { LayoutSolution } from './graph'
import type { LayoutJob } from './layoutRunner'

/** Lay out, route and score one candidate, in a layout worker (layoutWorker.ts). */
export function runLayoutJob(job: LayoutJob): Promise<LayoutSolution | null> {
  return job.kind === 'elk'
    ? layoutDiagramElk(job.diagram, job.ctx, job.strategy)
    : Promise.resolve(layoutDiagram(job.diagram, job.ctx, job.direction))
}
