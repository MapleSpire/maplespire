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

// @ts-check
import { parentPort } from 'node:worker_threads'
import * as Automerge from '@automerge/automerge'
import { decodeFailureResponse } from './durableDecodeFailure.mjs'

if (!parentPort) throw new Error('durable heads worker requires a parent port')
const port = parentPort
port.on('message', /** @param {{ id: number, documentId: string, bytes: Uint8Array, field?: string }} request */ request => {
  try {
    const durable = Automerge.load(request.bytes)
    let heads
    /** @type {string | undefined} */
    let json
    try {
      // A readable prefix with buffered, dependency-less arrivals is not a
      // proof of the complete durable document. Never use loadIncremental's
      // permissive fallback here, even when Repo can open those bytes.
      if (Automerge.getMissingDeps(durable, []).length) {
        throw new Error(`incomplete durable document dependencies: ${request.documentId}`)
      }
      heads = [...Automerge.getHeads(durable)]
      // G4-16f: the one top-level field asked for, as the projector copies a
      // sealed product's entity map (`JSON.stringify` of the document's
      // value; `null` when absent). Same strict load, same heads.
      if (typeof request.field === 'string') {
        try {
          json = JSON.stringify(/** @type {Record<string, unknown>} */ (durable)[request.field] ?? null)
        } catch (error) {
          // The bytes decoded and are complete; the VALUE has no JSON form
          // (a BigInt — an integer Automerge holds beyond 2^53). Not a refusal
          // of the bytes: `errorKind` tells the caller which it is.
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { errorKind: 'serialize' })
        }
      }
    } finally {
      Automerge.free(durable)
    }
    port.postMessage(json === undefined
      ? { id: request.id, documentId: request.documentId, heads }
      : { id: request.id, documentId: request.documentId, heads, json })
  } catch (error) {
    // `refused`, `serialize` or `transient`, and whether the module
    // trapped — `durableDecodeFailure.mjs`, `decodeFailureResponse`.
    port.postMessage(decodeFailureResponse(request, error))
  }
})
