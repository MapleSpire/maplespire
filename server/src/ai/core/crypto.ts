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

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Secret-at-rest encryption for org AI provider keys (AES-256-GCM).
 *
 * The 32-byte key is derived (SHA-256) from `AI_KEY_SECRET`, falling back to
 * `AUTH_SECRET` so a stack that already runs auth needs no extra config; with
 * NEITHER set, storing a key is refused loudly (`aiCryptoAvailable()` gates the
 * settings route) — an API key must never be persisted in plaintext or under a
 * hardcoded default key.
 *
 * Blob format: `v1:<iv b64url>:<tag b64url>:<ciphertext b64url>` — versioned so
 * a future KMS/rotation scheme can coexist with old rows.
 */

function keyMaterial(): string | null {
  const aiSecret = process.env.AI_KEY_SECRET
  if (aiSecret?.trim()) return aiSecret
  const authSecret = process.env.AUTH_SECRET
  return authSecret?.trim() ? authSecret : null
}

export function aiCryptoAvailable(): boolean {
  return keyMaterial() !== null
}

function deriveKey(): Buffer {
  const material = keyMaterial()
  if (!material) {
    throw new Error(
      'AI_KEY_SECRET (or AUTH_SECRET) is required to encrypt stored AI provider keys — refusing to store plaintext'
    )
  }
  return createHash('sha256').update(material).digest()
}

export function encryptSecret(plain: string): string {
  const key = deriveKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`
}

/** Returns null on ANY failure (wrong secret, tampered blob, unknown version) —
 * callers treat null as "key unavailable" and surface a re-enter-key error,
 * never a crash. */
export function decryptSecret(blob: string): string | null {
  try {
    const [version, ivB64, tagB64, ctB64] = blob.split(':')
    if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) return null
    const key = deriveKey()
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/** Display hint for a stored key: `…abcd` (last 4). Never enough to recover it. */
export function keyHint(plain: string): string {
  const tail = plain.slice(-4)
  return plain.length > 4 ? `…${tail}` : '…'
}

/** SHA-256 hex of a bearer token — the only form ever stored in the DB. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Constant-time hex-hash comparison (both inputs are our own sha256 hex). */
export function tokenHashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
