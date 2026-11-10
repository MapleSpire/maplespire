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
 * Size of every WebAssembly linear memory created through the synchronous
 * `new WebAssembly.Instance` on the MAIN thread — in practice Automerge's.
 *
 * What it does NOT count (probed 2026-11-04, Node 22.23, uncommitted scratch
 * probe): Node's `fetch` (undici's llhttp) instantiates its wasm through the
 * async `WebAssembly.instantiate`, which this hook does not see — 0 instances
 * recorded after a fetch, 1 after importing @automerge/automerge. Nor does it
 * count a worker thread's isolate (durableHeadsWorker.mjs loads Automerge in a
 * `worker_threads` Worker): that memory shows only in RSS. Both stay inside
 * `rss - external` or `external - wasm`, not in this number.
 *
 * Why it is worth a gauge. Measured 2026-11-04 (Node 22.23, @automerge/automerge
 * 3.2.6, uncommitted scratch probe, plain node with --expose-gc): building 40
 * docs x 512 changes grew the wasm memory by 12.6 MiB and
 * `process.memoryUsage().external` by 12.6 MiB, `arrayBuffers` by 0.0; after
 * `A.free` of every doc the memory stayed at its high-water mark (a
 * `WebAssembly.Memory` never shrinks). The accounting (grow -> external, not
 * arrayBuffers) and the high-water mark are pinned by wasmMemoryGauge.test.ts.
 * So a growing `external` cannot be told apart from a native leak elsewhere
 * without this number.
 *
 * Why a constructor hook. `@automerge/automerge`'s Node build keeps the instance
 * exports in a module-local (`let wasm = new WebAssembly.Instance(...)` in the
 * package's wasm-bindgen glue under `dist/mjs/wasm_bindgen_output/nodejs/`) and never exports
 * `memory`. The only point where the `Memory` object is reachable from outside
 * is that synchronous `new WebAssembly.Instance` call, so the hook MUST be
 * installed before the package is first imported — see
 * `wasmMemoryGauge.install.ts`, which `index.ts` imports first. A late install
 * is not silent: `wasmMemoryBytes()` reports `null` (unknown), never 0.
 *
 * Cost: reading `memory.buffer.byteLength` is O(1) per observed instance.
 */

export interface WasmMemorySnapshot {
  /** Sum of `buffer.byteLength` over observed instances; null if none observed. */
  bytes: number | null
  /** Instances observed. One is Automerge's; a second one is a second wasm
   * module built through the constructor (e.g. a second copy of the package) —
   * the gauge sums them and does not say which. */
  instances: number
}

type WasmNamespace = { Instance: typeof WebAssembly.Instance }

const MAX_TRACKED = 16

export class WasmMemoryGauge {
  private readonly memories: WebAssembly.Memory[] = []

  /** Wraps `target.Instance` so each new instance's exported memories are recorded. */
  install(target: WasmNamespace = WebAssembly): () => void {
    const original = target.Instance
    const record = (instance: WebAssembly.Instance) => {
      for (const value of Object.values(instance.exports)) {
        if (value instanceof WebAssembly.Memory && !this.memories.includes(value) && this.memories.length < MAX_TRACKED) {
          this.memories.push(value)
        }
      }
    }
    const proxy: typeof WebAssembly.Instance = new Proxy(original, {
      construct(ctor, args, newTarget) {
        const instance = Reflect.construct(ctor, args, newTarget) as WebAssembly.Instance
        record(instance)
        return instance
      },
    })
    target.Instance = proxy
    return () => {
      if (target.Instance === proxy) target.Instance = original
    }
  }

  snapshot(): WasmMemorySnapshot {
    if (this.memories.length === 0) return { bytes: null, instances: 0 }
    let bytes = 0
    for (const memory of this.memories) bytes += memory.buffer.byteLength
    return { bytes, instances: this.memories.length }
  }
}

export const processWasmMemoryGauge = new WasmMemoryGauge()
