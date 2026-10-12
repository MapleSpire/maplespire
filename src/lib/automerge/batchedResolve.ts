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

export const CLIENT_SHARD_RESOLVE_BATCH_SIZE = 3

/** Resolve durable documents without flooding the sync server's bounded DB pool. */
export async function resolveInBatches<TInput, TResult>(
  values: readonly TInput[],
  resolve: (value: TInput) => Promise<TResult>,
  batchSize = CLIENT_SHARD_RESOLVE_BATCH_SIZE,
): Promise<TResult[]> {
  const boundedSize = Math.max(1, Math.floor(batchSize))
  const results: TResult[] = []
  for (let start = 0; start < values.length; start += boundedSize) {
    results.push(...await Promise.all(values.slice(start, start + boundedSize).map(resolve)))
  }
  return results
}
