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

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WasmMemoryGauge } from './wasmMemoryGauge.js'

// (module (memory (export "mem") 1))
const ONE_PAGE_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x05, 0x03, 0x01, 0x00, 0x01,
  0x07, 0x07, 0x01, 0x03, 0x6d, 0x65, 0x6d, 0x02, 0x00,
])
const PAGE = 64 * 1024
const serverRoot = fileURLToPath(new URL('..', import.meta.url))

describe('WasmMemoryGauge', () => {
  it('reports unknown, not zero, before any instance is observed', () => {
    const gauge = new WasmMemoryGauge()
    gauge.install({ Instance: WebAssembly.Instance })
    expect(gauge.snapshot()).toEqual({ bytes: null, instances: 0 })
  })

  it('tracks the live byte size of exported memories, including growth', () => {
    const gauge = new WasmMemoryGauge()
    const ns = { Instance: WebAssembly.Instance }
    const uninstall = gauge.install(ns)
    const module = new WebAssembly.Module(ONE_PAGE_MODULE)
    const instance = new ns.Instance(module, {})
    expect(instance).toBeInstanceOf(WebAssembly.Instance)
    expect(gauge.snapshot()).toEqual({ bytes: PAGE, instances: 1 })
    ;(instance.exports.mem as WebAssembly.Memory).grow(2)
    expect(gauge.snapshot()).toEqual({ bytes: 3 * PAGE, instances: 1 })
    new ns.Instance(module, {})
    expect(gauge.snapshot()).toEqual({ bytes: 4 * PAGE, instances: 2 })

    uninstall()
    expect(ns.Instance).toBe(WebAssembly.Instance)
    new ns.Instance(module, {})
    expect(gauge.snapshot().instances).toBe(2)
  })

  it('counts a memory exported under two names once', () => {
    // (module (memory 1) (export "mem" (memory 0)) (export "m2" (memory 0)))
    const twice = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x05, 0x03, 0x01, 0x00, 0x01,
      0x07, 0x0c, 0x02, 0x03, 0x6d, 0x65, 0x6d, 0x02, 0x00, 0x02, 0x6d, 0x32, 0x02, 0x00,
    ])
    const gauge = new WasmMemoryGauge()
    const ns = { Instance: WebAssembly.Instance }
    gauge.install(ns)
    const instance = new ns.Instance(new WebAssembly.Module(twice), {})
    expect(instance.exports.mem).toBe(instance.exports.m2)
    expect(gauge.snapshot()).toEqual({ bytes: PAGE, instances: 1 })
  })

  it('keeps the constructor contract: calling without new still throws', () => {
    const ns = { Instance: WebAssembly.Instance }
    new WasmMemoryGauge().install(ns)
    const module = new WebAssembly.Module(ONE_PAGE_MODULE)
    expect(() => (ns.Instance as unknown as (m: WebAssembly.Module) => unknown)(module)).toThrow(TypeError)
  })

  it('a memory grow is counted in process external, not in arrayBuffers', () => {
    // The premise of reporting `wasm` beside `external`: V8 accounts the grown
    // backing store as external memory (measured +32 MiB grow -> +33.7 MB
    // external, arrayBuffers unchanged, on macOS and node:22-alpine).
    const instance = new WebAssembly.Instance(new WebAssembly.Module(ONE_PAGE_MODULE), {})
    const before = process.memoryUsage()
    ;(instance.exports.mem as WebAssembly.Memory).grow(256) // +16 MiB
    const after = process.memoryUsage()
    expect(after.external - before.external).toBeGreaterThanOrEqual(256 * PAGE)
    expect(after.arrayBuffers - before.arrayBuffers).toBeLessThan(PAGE)
  })

  it('observes the real @automerge/automerge instance when installed first, and keeps its high-water mark', () => {
    const script = [
      "await import('./src/wasmMemoryGauge.install.ts')",
      "const { processWasmMemoryGauge } = await import('./src/wasmMemoryGauge.ts')",
      "const A = await import('@automerge/automerge')",
      'const before = processWasmMemoryGauge.snapshot()',
      'const docs = []',
      'for (let i = 0; i < 20; i++) { let d = A.from({ e: {} }); for (let c = 0; c < 256; c++) d = A.change(d, (x) => { x.e[`k${c}`] = { n: `v${i}-${c}` } }); docs.push(d) }',
      'const after = processWasmMemoryGauge.snapshot()',
      'for (const d of docs) A.free(d)',
      'const freed = processWasmMemoryGauge.snapshot()',
      'console.log(JSON.stringify({ before, after, freed }))',
    ].join('\n')
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: serverRoot,
      encoding: 'utf8',
    })
    const result = JSON.parse(out.trim().split('\n').pop()!)
    expect(result.before.instances).toBe(1)
    expect(result.before.bytes).toBeGreaterThan(0)
    expect(result.after.bytes).toBeGreaterThan(result.before.bytes)
    // a WebAssembly.Memory never shrinks: freeing documents keeps the high-water mark
    expect(result.freed.bytes).toBe(result.after.bytes)
  }, 60_000)

  it('sees nothing when installed after @automerge/automerge was loaded (late install reads null)', () => {
    const script = [
      "await import('@automerge/automerge')",
      "await import('./src/wasmMemoryGauge.install.ts')",
      "const { processWasmMemoryGauge } = await import('./src/wasmMemoryGauge.ts')",
      'console.log(JSON.stringify(processWasmMemoryGauge.snapshot()))',
    ].join('\n')
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: serverRoot,
      encoding: 'utf8',
    })
    expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual({ bytes: null, instances: 0 })
  }, 60_000)

  it('is the first import of the server entry point', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    const firstImport = source.split('\n').find((line) => /^import\b/.test(line))
    expect(firstImport).toMatch(/^import '\.\/wasmMemoryGauge\.install\.js'/)
  })
})
