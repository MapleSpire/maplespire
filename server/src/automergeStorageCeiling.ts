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

import { LOCK_NOT_AVAILABLE, QUERY_CANCELED } from './db/statementTimeout.js'

/**
 * A storage write stopped by one of the storage write pool's own ceilings
 * (`storageWritePoolConfig`, `dbConfig.ts`): `statement_timeout` (57014),
 * `lock_timeout` (55P03), `idle_in_transaction_session_timeout` (25P03).
 *
 * None of them is in `withDbRetry`'s transient set, on purpose: a statement
 * that ran out its 120 s would run out the immediate retry too. They are
 * COUNTED here (`maplespire_automerge_storage_write_ceiling_total{code}`,
 * alert `AutomergeStorageWriteCeiling`), logged with the document, and a
 * failed CONTENT save is retried by the adapter on a backoff
 * (`PostgresStorageAdapter`, `scheduleCeilingRetry`) — the Repo would
 * otherwise only save it again on the next edit or flush.
 *
 * 57014 is also what `pg_cancel_backend()` raises: counted the same, it is a
 * cancelled storage write either way.
 */
export const IDLE_IN_TRANSACTION_TIMEOUT = '25P03'
export const STORAGE_WRITE_CEILING_CODES = [QUERY_CANCELED, LOCK_NOT_AVAILABLE, IDLE_IN_TRANSACTION_TIMEOUT] as const
export type StorageWriteCeilingCode = (typeof STORAGE_WRITE_CEILING_CODES)[number]

/** The ceiling that stopped this write, or null for any other failure. */
export function storageWriteCeilingCode(error: unknown): StorageWriteCeilingCode | null {
  const code = (error as { code?: unknown })?.code
  return (STORAGE_WRITE_CEILING_CODES as readonly unknown[]).includes(code) ? code as StorageWriteCeilingCode : null
}

const ceilingCounts = new Map<StorageWriteCeilingCode, number>(STORAGE_WRITE_CEILING_CODES.map((code) => [code, 0]))

/** Count one ceiling failure (process-wide, every adapter). */
export function noteStorageWriteCeiling(code: StorageWriteCeilingCode): void {
  ceilingCounts.set(code, (ceilingCounts.get(code) ?? 0) + 1)
}

/** `maplespire_automerge_storage_write_ceiling_total{code}`: every code, zeros
 * included, so a rate over the series is defined from the first scrape. */
export function storageWriteCeilingCounts(): ReadonlyArray<{ code: StorageWriteCeilingCode; count: number }> {
  return STORAGE_WRITE_CEILING_CODES.map((code) => ({ code, count: ceilingCounts.get(code) ?? 0 }))
}

/** The adapter's retry delays after a ceiling failure of a content save: five
 * attempts over about a minute. Past them the document stays marked unsaved
 * (eviction refuses it and flushes it, `hasUnsavedWrite`) until a later save
 * of it succeeds, the fence refuses this cell, or its content is removed. */
export const STORAGE_WRITE_CEILING_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 15_000, 30_000]
