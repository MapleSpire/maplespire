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

import { describe, expect, it } from 'vitest'
import {
  formatTopologyContract,
  parseTopologyContract,
  SyncCellTopologyContractFormatError,
  type TopologyContractFailureReason,
} from './topologyContract.js'

describe('B3d2 topology contract codec', () => {
  it.each(['v1', 'maplespire-v1', 'v1.ce1461953e2b8ac2'])(
    'preserves the two-part contract and opaque generation %s', generation => {
      expect(formatTopologyContract({ generation, partitionCount: 2 })).toBe(generation + '|2')
      expect(parseTopologyContract(generation + '|2')).toEqual({
        encoding: 'legacy',
        contract: { generation, partitionCount: 2, placementMode: 'shadow', reservedPartitions: [] },
      })
    },
  )

  it.each([
    ['g|4|v1|mode=placed|reserved=1,3', 'placed', [1, 3]],
    ['g|4|v1|mode=shadow|reserved=0,2', 'shadow', [0, 2]],
    ['g|4|v1|mode=placed|reserved=', 'placed', []],
  ] as const)('pins the extension bytes %s', (raw, placementMode, reservedPartitions) => {
    const contract = { generation: 'g', partitionCount: 4, placementMode, reservedPartitions }
    expect(parseTopologyContract(raw)).toEqual({ encoding: 'v1', contract })
    expect(formatTopologyContract(contract)).toBe(raw)
    expect(parseTopologyContract(raw).contract.generation).toBe('g')
  })

  it('sorts a copy, rejects duplicate reservations and keeps the short default unique', () => {
    const reserved = [3, 1]
    expect(formatTopologyContract({ generation: 'g', partitionCount: 4, reservedPartitions: reserved }))
      .toBe('g|4|v1|mode=shadow|reserved=1,3')
    expect(reserved).toEqual([3, 1])
    expect(formatTopologyContract({ generation: 'g', partitionCount: 4, placementMode: 'shadow', reservedPartitions: [] }))
      .toBe('g|4')
    expect(() => formatTopologyContract({ generation: 'g', partitionCount: 4, reservedPartitions: [1, 1] }))
      .toThrow(SyncCellTopologyContractFormatError)
  })

  const malformed: Array<[unknown, TopologyContractFailureReason]> = [
    [null, 'input-invalid'], [undefined, 'input-invalid'], [{}, 'input-invalid'],
    [true, 'input-invalid'], [Buffer.from('g|1'), 'input-invalid'], ['', 'input-invalid'],
    ['g'.repeat(8_193), 'input-too-long'], ['g', 'arity-invalid'], ['g|1|ce1461953e2b8ac2', 'arity-invalid'],
    ['|1', 'generation-invalid'], ['G|1', 'generation-invalid'], [' g|1', 'generation-invalid'],
    ['../g|1', 'generation-invalid'], ['g'.repeat(65) + '|1', 'generation-invalid'],
    ['g|0', 'count-invalid'], ['g|1025', 'count-invalid'], ['g|01', 'count-invalid'],
    ['g|1e0', 'count-invalid'], ['g|1.0', 'count-invalid'], ['g|+1', 'count-invalid'],
    ['g|1 ', 'count-invalid'], ['g|NaN', 'count-invalid'],
    ['g|1\n', 'count-invalid'], ['g|1\r\n', 'count-invalid'],
    ['g\n|1', 'generation-invalid'], ['g\r\n|1', 'generation-invalid'],
    ['g|4|v2|mode=placed|reserved=1', 'version-unsupported'],
    ['g|4|v1|reserved=1|mode=placed', 'fields-invalid'],
    ['g|4|v1|mode=placed|unknown=1', 'fields-invalid'],
    ['g|4|v1|mode=placed|mode=shadow', 'fields-invalid'],
    ['g|4|v1|mode=PLACED|reserved=1', 'mode-invalid'],
    ['g|4|v1|mode=placed|reserved=-1', 'reserved-invalid'],
    ['g|4|v1|mode=placed|reserved=4', 'reserved-invalid'],
    ['g|4|v1|mode=placed|reserved=01', 'reserved-invalid'],
    ['g|4|v1|mode=placed|reserved=1,1', 'reserved-invalid'],
    ['g|4|v1|mode=placed|reserved=1,', 'reserved-invalid'],
    ['g|4|v1|mode=placed|reserved=2,1', 'non-canonical'],
    ['g|4|v1|mode=shadow|reserved=', 'non-canonical'],
    ['g|4|v1|mode=placed|reserved=1|extra=x', 'arity-invalid'],
  ]
  it.each(malformed)('refuses malformed presence %j as %s', (raw, reason) => {
    expect(() => parseTopologyContract(raw)).toThrow(SyncCellTopologyContractFormatError)
    try { parseTopologyContract(raw) }
    catch (error) { expect(error).toMatchObject({ code: 'sync_cell_topology_contract_invalid', reason }) }
  })

  it('validates formatter inputs instead of coercing missing or invalid values', () => {
    const valid = { generation: 'g', partitionCount: 4 }
    for (const invalid of [
      null, { ...valid, generation: 'G' }, { ...valid, partitionCount: '4' },
      { ...valid, partitionCount: 0 }, { ...valid, placementMode: null },
      { ...valid, reservedPartitions: null }, { ...valid, reservedPartitions: ['1'] },
      { ...valid, reservedPartitions: [Number.NaN] }, { ...valid, reservedPartitions: new Array(1) },
    ]) expect(() => formatTopologyContract(invalid as never)).toThrow(SyncCellTopologyContractFormatError)
  })

  it('round-trips the largest reserved set without changing the generation', () => {
    const reservedPartitions = Array.from({ length: 1_024 }, (_, index) => index)
    const contract = { generation: 'g'.repeat(64), partitionCount: 1_024, reservedPartitions, placementMode: 'placed' as const }
    const raw = formatTopologyContract(contract)
    expect(raw.length).toBeLessThan(8_192)
    expect(parseTopologyContract(raw)).toEqual({ encoding: 'v1', contract })
  })
})
