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

/**
 * The kill switch of the base-shard storage compaction (G4-16f):
 * `AM_BASE_SHARD_STORAGE_COMPACTION`.
 *
 * ON BY DEFAULT, unlike the read model's activation flags: missing, blank
 * and `on` compact each base shard's stored rows to one snapshot after the
 * fold (and feed the proof memo); `off` leaves the rows as automerge-repo
 * writes them, which is the behaviour before this compaction existed,
 * statement for statement.
 * Any other value refuses to boot (a typo must not silently pick a side).
 * The mode is printed in every `compaction.base_storage` log line.
 */
export const BASE_SHARD_STORAGE_COMPACTION_FLAG = 'AM_BASE_SHARD_STORAGE_COMPACTION'

export type BaseShardStorageCompactionMode = 'on' | 'off'

export class BaseShardStorageCompactionConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BaseShardStorageCompactionConfigError'
  }
}

export function baseShardStorageCompactionMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BaseShardStorageCompactionMode {
  const value = env[BASE_SHARD_STORAGE_COMPACTION_FLAG]?.trim()
  if (value === undefined || value === '' || value === 'on') return 'on'
  if (value === 'off') return 'off'
  throw new BaseShardStorageCompactionConfigError(
    `${BASE_SHARD_STORAGE_COMPACTION_FLAG}=${JSON.stringify(value)} is neither on nor off`,
  )
}
