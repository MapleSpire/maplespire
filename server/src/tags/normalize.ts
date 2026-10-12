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

import type {
  TagGroupInput,
  TagGroupPatchInput,
  TagInput,
  TagMoveInput,
  TagPatchInput,
  TagWorkspaceContext,
} from './types.js'

const MAX_LABEL_GRAPHEMES = 80
const MAX_LABEL_BYTES = 256
const MAX_DESCRIPTION_GRAPHEMES = 1_000
const MAX_ICON_KEY_BYTES = 160
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/
const CLIENT_GROUP_ID = /^taggrp_client_[0-9a-f]{32}$/
const CLIENT_TAG_ID = /^tag_client_[0-9a-f]{32}$/
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

function containsForbiddenControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (
      codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) return true
  }
  return false
}

export class TagInputError extends Error {
  readonly status = 400
}
function requireObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TagInputError('body must be an object')
  return raw as Record<string, unknown>
}

function hasOwn(input: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, field)
}

function graphemeCount(value: string): number {
  return [...segmenter.segment(value)].length
}

function cleanText(value: unknown, field: string, options: { required: boolean; maxGraphemes: number; maxBytes: number }): string | null {
  if (value === undefined || value === null || value === '') {
    if (options.required) throw new TagInputError(`${field} is required`)
    return null
  }
  if (typeof value !== 'string') throw new TagInputError(`${field} must be a string`)
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (!normalized && options.required) throw new TagInputError(`${field} is required`)
  if (containsForbiddenControl(normalized)) throw new TagInputError(`${field} contains forbidden control characters`)
  if (graphemeCount(normalized) > options.maxGraphemes || Buffer.byteLength(normalized, 'utf8') > options.maxBytes) {
    throw new TagInputError(`${field} is too long`)
  }
  return normalized || null
}

export function normalizeTagIdentity(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

export function validateTagGroupInput(raw: unknown): TagGroupInput {
  const input = requireObject(raw)
  const name = cleanText(input.name, 'name', {
    required: true,
    maxGraphemes: MAX_LABEL_GRAPHEMES,
    maxBytes: MAX_LABEL_BYTES,
  })!
  const description = cleanText(input.description, 'description', {
    required: false,
    maxGraphemes: MAX_DESCRIPTION_GRAPHEMES,
    maxBytes: 8_000,
  })
  const iconKey = cleanText(input.iconKey, 'iconKey', {
    required: false,
    maxGraphemes: MAX_ICON_KEY_BYTES,
    maxBytes: MAX_ICON_KEY_BYTES,
  })
  const clientId = input.clientId === undefined ? undefined : cleanText(input.clientId, 'clientId', {
    required: true,
    maxGraphemes: 80,
    maxBytes: 100,
  })!
  if (clientId && !CLIENT_GROUP_ID.test(clientId)) throw new TagInputError('clientId must be a client-generated Tag Group ID')
  return { clientId, name, normalizedName: normalizeTagIdentity(name), description, iconKey }
}

export function validateTagGroupPatchInput(raw: unknown): TagGroupPatchInput {
  const input = requireObject(raw)
  const patch: TagGroupPatchInput = {}
  if (hasOwn(input, 'name')) {
    const name = cleanText(input.name, 'name', {
      required: true,
      maxGraphemes: MAX_LABEL_GRAPHEMES,
      maxBytes: MAX_LABEL_BYTES,
    })!
    patch.name = name
    patch.normalizedName = normalizeTagIdentity(name)
  }
  if (hasOwn(input, 'description')) {
    patch.description = cleanText(input.description, 'description', {
      required: false,
      maxGraphemes: MAX_DESCRIPTION_GRAPHEMES,
      maxBytes: 8_000,
    })
  }
  if (hasOwn(input, 'iconKey')) {
    patch.iconKey = cleanText(input.iconKey, 'iconKey', {
      required: false,
      maxGraphemes: MAX_ICON_KEY_BYTES,
      maxBytes: MAX_ICON_KEY_BYTES,
    })
  }
  if (Object.keys(patch).length === 0) throw new TagInputError('at least one Tag Group field must be provided')
  return patch
}

export function validateTagInput(raw: unknown): TagInput {
  const input = requireObject(raw)
  const groupId = cleanText(input.groupId, 'groupId', { required: true, maxGraphemes: 160, maxBytes: 200 })!
  const value = cleanText(input.value, 'value', {
    required: true,
    maxGraphemes: MAX_LABEL_GRAPHEMES,
    maxBytes: MAX_LABEL_BYTES,
  })!
  if (typeof input.color !== 'string' || !HEX_COLOR.test(input.color)) {
    throw new TagInputError('color must use #RRGGBB')
  }
  const clientId = input.clientId === undefined ? undefined : cleanText(input.clientId, 'clientId', {
    required: true,
    maxGraphemes: 80,
    maxBytes: 100,
  })!
  if (clientId && !CLIENT_TAG_ID.test(clientId)) throw new TagInputError('clientId must be a client-generated Tag ID')
  return { clientId, groupId, value, normalizedValue: normalizeTagIdentity(value), color: input.color.toUpperCase() }
}

export function validateTagPatchInput(raw: unknown): TagPatchInput {
  const input = requireObject(raw)
  const patch: TagPatchInput = {}
  if (hasOwn(input, 'groupId')) {
    patch.groupId = cleanText(input.groupId, 'groupId', { required: true, maxGraphemes: 160, maxBytes: 200 })!
  }
  if (hasOwn(input, 'value')) {
    const value = cleanText(input.value, 'value', {
      required: true,
      maxGraphemes: MAX_LABEL_GRAPHEMES,
      maxBytes: MAX_LABEL_BYTES,
    })!
    patch.value = value
    patch.normalizedValue = normalizeTagIdentity(value)
  }
  if (hasOwn(input, 'color')) {
    if (typeof input.color !== 'string' || !HEX_COLOR.test(input.color)) {
      throw new TagInputError('color must use #RRGGBB')
    }
    patch.color = input.color.toUpperCase()
  }
  if (Object.keys(patch).length === 0) throw new TagInputError('at least one Tag field must be provided')
  return patch
}

export function validateTagMoveInput(raw: unknown): TagMoveInput {
  const input = requireObject(raw)
  const beforeId = hasOwn(input, 'beforeId') && input.beforeId !== null
    ? cleanText(input.beforeId, 'beforeId', { required: true, maxGraphemes: 160, maxBytes: 200 })
    : null
  const afterId = hasOwn(input, 'afterId') && input.afterId !== null
    ? cleanText(input.afterId, 'afterId', { required: true, maxGraphemes: 160, maxBytes: 200 })
    : null
  if ((beforeId === null) === (afterId === null)) {
    throw new TagInputError('provide exactly one of beforeId or afterId')
  }
  return { beforeId, afterId }
}

export function validateWorkspaceContext(raw: unknown): TagWorkspaceContext | null {
  if (raw === undefined || raw === null) return null
  const input = requireObject(raw)
  const landscapeId = cleanText(input.landscapeId, 'workspace.landscapeId', { required: true, maxGraphemes: 200, maxBytes: 256 })!
  const versionId = cleanText(input.versionId, 'workspace.versionId', { required: true, maxGraphemes: 200, maxBytes: 256 })!
  return { landscapeId, versionId }
}
