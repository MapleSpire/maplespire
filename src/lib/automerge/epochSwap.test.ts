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

import type { DocHandle } from '@automerge/automerge-repo'
import { describe, expect, it } from 'vitest'
import { runAtomically, unpublishedShards, withCarried } from './epochSwap'
import { collectRetiredDifferences } from './epochRetiredDiff'

/** G4-16f: the swap is atomic, the held overflow
 * shards are carried, and the retired export names what differs. */
describe('runAtomically (the epoch swap)', () => {
  it('a step that throws undoes the completed steps in REVERSE order and rethrows — the old epoch is re-attached', () => {
    const log: string[] = []
    const step = (name: string, fail = false) => ({
      name,
      run: () => { log.push(`run ${name}`); if (fail) throw new Error(`${name} threw`) },
      undo: () => { log.push(`undo ${name}`) },
    })
    expect(() => runAtomically([step('detach'), step('assign'), step('attach'), step('project', true)])).toThrow('project threw')
    expect(log).toEqual(['run detach', 'run assign', 'run attach', 'run project', 'undo attach', 'undo assign', 'undo detach'])
  })

  it('an undo that throws is reported and the remaining undos still run', () => {
    const log: string[] = []
    const failures: string[] = []
    expect(() => runAtomically([
      { name: 'a', run: () => log.push('run a'), undo: () => log.push('undo a') },
      { name: 'b', run: () => log.push('run b'), undo: () => { throw new Error('undo b') } },
      { name: 'c', run: () => { throw new Error('c') }, undo: () => log.push('undo c') },
    ], (step) => failures.push(step))).toThrow('c')
    expect(log).toEqual(['run a', 'run b', 'undo a'])
    expect(failures).toEqual(['b'])
  })

  it('all steps succeed: no undo', () => {
    const log: string[] = []
    runAtomically([{ name: 'a', run: () => log.push('a'), undo: () => log.push('undo') }])
    expect(log).toEqual(['a'])
  })
})

describe('carrying held overflow shards across the swap', () => {
  const h = (url: string) => ({ url }) as unknown as DocHandle<unknown>
  it('a shard the old meta does not list is carried, once', () => {
    const held = [h('automerge:a'), h('automerge:new-overflow')]
    const carried = unpublishedShards(held, ['automerge:a'])
    expect(carried.map((x) => x.url)).toEqual(['automerge:new-overflow'])
    expect(withCarried([h('automerge:t1')], carried).map((x) => x.url)).toEqual(['automerge:t1', 'automerge:new-overflow'])
    expect(withCarried([h('automerge:new-overflow')], carried).map((x) => x.url)).toEqual(['automerge:new-overflow'])
  })
})

describe('collectRetiredDifferences (the epoch-retired export)', () => {
  it('names every local entity that differs from, or is absent in, the new epoch — and nothing equal', () => {
    const differences = collectRetiredDifferences({
      retiredMeta: { groups: { g1: { id: 'g1', name: 'Local' } } },
      retiredObjectShards: [{ objects: { a: { id: 'a', name: 'same' }, b: { id: 'b', name: 'mine' }, c: { id: 'c', name: 'created offline' } } }],
      retiredConnectionShards: [],
      current: {
        meta: { groups: { g1: { id: 'g1', name: 'Server' } } },
        objects: { a: { id: 'a', name: 'same' }, b: { id: 'b', name: 'theirs' } },
        connections: {},
      },
    })
    expect(differences).toEqual([
      { kind: 'object', id: 'b', local: { id: 'b', name: 'mine' }, current: { id: 'b', name: 'theirs' } },
      { kind: 'object', id: 'c', local: { id: 'c', name: 'created offline' }, current: null },
      { kind: 'group', id: 'g1', local: { id: 'g1', name: 'Local' }, current: { id: 'g1', name: 'Server' } },
    ])
  })
})
