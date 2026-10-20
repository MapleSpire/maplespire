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
 * Max diagrams per registry shard. Override via VITE_SHARD_SIZE env var (client).
 * The server uses AM_SHARD_SIZE (see server/src/automergeServer.ts).
 */
export const SHARD_SIZE = import.meta.env.VITE_SHARD_SIZE
  ? Number(import.meta.env.VITE_SHARD_SIZE)
  : 200

/**
 * Max objects/connections per MODEL shard. Balances per-edit reconcile
 * cost (linear in shard) against handle count (100k/512 ≈ 200 shards). Override via
 * VITE_MODEL_SHARD_SIZE. Only used when model sharding is enabled.
 */
export const MODEL_SHARD_SIZE = import.meta.env.VITE_MODEL_SHARD_SIZE
  ? Number(import.meta.env.VITE_MODEL_SHARD_SIZE)
  : 512

/**
 * How many documents one import can create in its flush: one DiagramDoc per
 * view, plus every registry and model shard the new entries can overflow into.
 * An UPPER bound — placement fills shards with room first, so it is reached
 * only when every existing shard is full — because an id short of the burst
 * falls back to a random id, and a random-id SHARD is the one kind whose
 * pointer cannot be held until the server has it (deferredReferences.ts). An
 * unused minted id costs nothing; it stays in the reserve.
 */
export function importDocumentIdBudget(
  counts: { diagrams: number; objects: number; connections: number },
  sizes: { registry: number; model: number } = { registry: SHARD_SIZE, model: MODEL_SHARD_SIZE },
): number {
  const shards = (count: number, size: number) =>
    count > 0 && size > 0 ? Math.ceil(count / size) : 0
  return counts.diagrams
    + shards(counts.diagrams, sizes.registry)
    + shards(counts.objects, sizes.model)
    + shards(counts.connections, sizes.model)
}
