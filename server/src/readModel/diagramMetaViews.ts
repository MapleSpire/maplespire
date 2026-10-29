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

type Json = Record<string, unknown>

const FIRST_PAINT_FIELDS = [
  'id', 'name', 'type', 'docUrl', 'objectIds', 'connectionIds', 'groupIds',
  'parentObjectId', 'domainId', 'connectionHighlightStyle', 'connectionAnimationsEnabled',
  'defaultConnectionShape', 'readonly', 'skinId', 'layouts', 'layouts3d', 'lowerRouting', 'sceneDecor',
] as const

const EDITOR_FIELDS = ['id', 'description', 'comments', 'flows', 'checkpoints', 'shapeCount'] as const

function pick(source: Json, fields: readonly string[]): Json {
  return Object.fromEntries(fields.flatMap((field) => source[field] === undefined ? [] : [[field, source[field]]]))
}

/** The layout maps are paint-critical; comments, flows, checkpoints and the
 * diagram description are intentionally left to the lazy editor view. */
export const toFirstPaintDiagramMeta = (diagram: Json): Json => pick(diagram, FIRST_PAINT_FIELDS)
export const toDiagramEditorMeta = (diagram: Json): Json => pick(diagram, EDITOR_FIELDS)
