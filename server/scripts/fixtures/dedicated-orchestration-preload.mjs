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

import childProcess from 'node:child_process'
import { register, syncBuiltinESMExports } from 'node:module'
import { isMainThread } from 'node:worker_threads'

if (isMainThread) {
  // A deleted dispatch must fail without reaching Docker or a live service.
  globalThis.fetch = async () => { throw new Error('Unexpected network access in dedicated CLI fixture') }
  childProcess.execFileSync = () => { throw new Error('Unexpected native command in dedicated CLI fixture') }
  syncBuiltinESMExports()
  register(import.meta.url)
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === './sync-cell-dedicated-runtime.mjs'
    && context.parentURL?.endsWith('/verify-sync-cell-dedicated.mjs')) {
    return { url: new URL('./dedicated-orchestration-runtime.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
