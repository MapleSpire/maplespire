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

/** Coalesce only overlapping work. Results are removed as soon as they settle,
 * so callers never receive a time-cached or stale read-model response. */
export class AsyncSingleFlight {
  private readonly pending = new Map<string, Promise<unknown>>()

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key)
    if (existing) return existing as Promise<T>
    const running = Promise.resolve().then(operation).finally(() => {
      if (this.pending.get(key) === running) this.pending.delete(key)
    })
    this.pending.set(key, running)
    return running
  }

  size(): number {
    return this.pending.size
  }
}
