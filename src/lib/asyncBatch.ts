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

export type BatchResult<T> =
  | { item: T; status: 'fulfilled' }
  | { item: T; status: 'rejected'; reason: unknown }

/**
 * Runs a potentially large bulk action without opening one request per item at once.
 * Results preserve the input order so callers can keep failed rows selected.
 */
export async function runInBatches<T>(
  items: readonly T[],
  worker: (item: T) => Promise<unknown>,
  concurrency = 6,
): Promise<BatchResult<T>[]> {
  const results: BatchResult<T>[] = []
  const size = Math.max(1, Math.floor(concurrency))

  for (let start = 0; start < items.length; start += size) {
    const batch = items.slice(start, start + size)
    const settled = await Promise.allSettled(batch.map(worker))
    settled.forEach((result, index) => {
      const item = batch[index]
      results.push(result.status === 'fulfilled'
        ? { item, status: 'fulfilled' }
        : { item, status: 'rejected', reason: result.reason })
    })
  }

  return results
}
