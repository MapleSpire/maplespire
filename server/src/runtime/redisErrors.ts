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
 * The distributed runtime's unavailability, in a module that imports nothing.
 *
 * The sibling of `automergeStorageErrors.ts`, for the same reason. `redis.ts`
 * constructs TWO `RedisRuntime`s at import time (at the bottom of the file),
 * each building a client and registering listeners, and `redisRuntimeConfig()`
 * can THROW at import on a contradictory environment. Naming this class in an
 * `instanceof` — as `dependencyOutageResponse.ts`, consulted by every error
 * door, does — should not cost any of that.
 *
 * `redis.ts` re-exports the class.
 */
export class RedisUnavailableError extends Error {
  constructor(message = 'Distributed runtime is unavailable') {
    super(message)
    this.name = 'RedisUnavailableError'
  }
}
