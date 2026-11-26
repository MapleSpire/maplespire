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

/**
 * What a failed strict decode (`durableHeadsWorker.mjs`) says about the BYTES.
 *
 *  - `serialize`: the bytes decoded and are complete; the asked field has no
 *    JSON form (a BigInt). Deterministic for these bytes.
 *  - `transient`: the decode did not finish for a reason that is not a
 *    property of the bytes — the isolate ran out of memory. The same bytes
 *    may decode on a fresh isolate, so a caller must NOT remember it as a
 *    refusal (`sealedProductCache.ts`).
 *  - `refused`: everything else — the load or its dependency check
 *    rejected the bytes, or the decoder failed on them in a way the same
 *    bytes reproduce.
 *
 * NOT "every RangeError is transient": Automerge reports a malformed or
 * truncated document as a `RangeError` ("unable to parse chunk: …", "bad
 * checksum" — measured, @automerge/automerge as installed, 2026-11-08), so
 * that test would forget every genuine refusal. Transient is recognised
 * POSITIVELY, by a message naming memory exhaustion or a failed allocation
 * (`RangeError: Array buffer allocation failed`, `WebAssembly.Memory(): could
 * not allocate memory`, `WebAssembly.Memory.grow(): Maximum memory size
 * exceeded`, `out of memory`), whatever the error's class — a
 * `WebAssembly.RuntimeError` included.
 *
 * NOT transient, although they once were:
 *  - a `WebAssembly.RuntimeError` whose message names no memory exhaustion
 *    (`unreachable` after a Rust panic, an out-of-bounds access): a panic
 *    on given bytes is a property of the bytes. A manual test fed 827 truncated and
 *    bit-flipped documents through the real worker: 826 refused, none
 *    transient;
 *  - `Maximum call stack size exceeded`: a recursion deep enough to exhaust
 *    the stack on given bytes exhausts it again on the same bytes.
 * The cost of the boundary, both ways: a failed allocation that Rust turns
 * into an `unreachable` trap is remembered as a refusal (the product is not
 * cached until its rows change); a memory message that is in fact
 * deterministic is retried, which the foreground proof bounds
 * (`arrivalWatermark.ts`, TRANSIENT_DECODE_LIMIT); the background writer
 * does not retry it within a job (`decoder-failed`, `sealedProductCache.ts`)
 * and remembers nothing, so it is tried again only when the product is
 * offered again.
 *
 * @param {unknown} error
 * @returns {'serialize' | 'transient' | 'refused'}
 */
export function decodeFailureKind(error) {
  if (/** @type {{ errorKind?: unknown }} */ (error)?.errorKind === 'serialize') return 'serialize'
  const message = error instanceof Error ? error.message : String(error)
  if (/out of memory|allocation failed|could not allocate|cannot allocate|failed to grow|memory size exceeded/i.test(message)) {
    return 'transient'
  }
  return 'refused'
}

/**
 * The worker's answer for a failed decode of `request` (`durableHeadsWorker.mjs`):
 * the message, its kind ({@link decodeFailureKind}), and `trapped` — the wasm
 * module trapped (a panic, whatever the kind), so the isolate's module state
 * is not trusted with the next document and the decoder retires it
 * (`durableHeadsDecoder.ts`). Pure, so it is tested where the worker is not.
 *
 * @param {{ id: number, documentId: string }} request
 * @param {unknown} error
 * @returns {{ id: number, documentId: string, error: string, errorKind: 'serialize' | 'transient' | 'refused', trapped: boolean }}
 */
export function decodeFailureResponse(request, error) {
  return {
    id: request.id,
    documentId: request.documentId,
    error: error instanceof Error ? error.message : String(error),
    errorKind: decodeFailureKind(error),
    trapped: typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError,
  }
}
