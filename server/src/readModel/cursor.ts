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

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export class ReadModelCursorError extends Error {
  constructor(message = 'Invalid or expired cursor') {
    super(message)
    this.name = 'ReadModelCursorError'
  }
}
function secret(): string {
  const configured = process.env.AUTH_SECRET?.trim()
  if (configured) return configured
  if (process.env.NODE_ENV === 'production') throw new ReadModelCursorError('Cursor signing is unavailable')
  return 'maplespire-read-model-development-cursor'
}

export function readModelQueryHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 22)
}

export function encodeReadModelCursor(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify({ v: 1, ...payload }), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret()).update(body).digest('base64url')
  return `${body}.${signature}`
}

export function decodeReadModelCursor<T extends Record<string, unknown>>(
  cursor: string,
  expected: { kind: string; queryHash: string },
): T {
  if (cursor.length > 2048) throw new ReadModelCursorError()
  const [body, signature, extra] = cursor.split('.')
  if (!body || !signature || extra) throw new ReadModelCursorError()
  const expectedSignature = createHmac('sha256', secret()).update(body).digest()
  let supplied: Buffer
  try {
    supplied = Buffer.from(signature, 'base64url')
  } catch {
    throw new ReadModelCursorError()
  }
  if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) {
    throw new ReadModelCursorError()
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    throw new ReadModelCursorError()
  }
  if (payload.v !== 1 || payload.kind !== expected.kind || payload.queryHash !== expected.queryHash) {
    throw new ReadModelCursorError()
  }
  return payload as T
}
