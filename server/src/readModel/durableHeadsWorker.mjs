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

if (!parentPort) throw new Error('durable heads worker requires a parent port')
const port = parentPort
port.on('message', /** @param {{ id: number, documentId: string, bytes: Uint8Array }} request */ request => {
  try {
    const durable = Automerge.load(request.bytes)
    let heads
    try {
      // A readable prefix with buffered, dependency-less arrivals is not a
      // proof of the complete durable document. Never use loadIncremental's
      // permissive fallback here, even when Repo can open those bytes.
      if (Automerge.getMissingDeps(durable, []).length) {
        throw new Error(`incomplete durable document dependencies: ${request.documentId}`)
      }
      heads = [...Automerge.getHeads(durable)]
    } finally {
      Automerge.free(durable)
    }
    port.postMessage({ id: request.id, documentId: request.documentId, heads })
  } catch (error) {
    port.postMessage({ id: request.id, documentId: request.documentId,
      error: error instanceof Error ? error.message : String(error) })
  }
})
