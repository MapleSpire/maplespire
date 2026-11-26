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
import { QUARANTINE_CLI_HELP, parseQuarantineCommand } from './modelEpochQuarantine.js'

/**
 * G4-16f: the quarantine CLI's arguments. A bare `--release`
 * used to fall into LIST mode (the operator believed they had released);
 * `--release` and `--discard` together silently picked one.
 */
describe('repair:epoch-forward-quarantine arguments', () => {
  const ws = ['--landscape', 'l', '--version', 'v']

  it('no action: list', () => {
    expect(parseQuarantineCommand(ws)).toEqual({ action: 'list' })
  })

  it('a journal id for each action, and the export directory for a discard', () => {
    expect(parseQuarantineCommand([...ws, '--release', 'j1'])).toEqual({ action: 'release', journal: 'j1' })
    expect(parseQuarantineCommand([...ws, '--discard', 'j1'])).toEqual({ action: 'discard', journal: 'j1' })
    expect(parseQuarantineCommand([...ws, '--discard', 'j1', '--export-dir', '/x'])).toEqual({ action: 'discard', journal: 'j1', exportDir: '/x' })
  })

  it('--release or --discard WITHOUT a value is an error, not list mode', () => {
    expect(() => parseQuarantineCommand([...ws, '--release'])).toThrow(/--release needs a journal id/)
    expect(() => parseQuarantineCommand(['--release', '--landscape', 'l'])).toThrow(/--release needs a journal id/)
    expect(() => parseQuarantineCommand([...ws, '--discard'])).toThrow(/--discard needs a journal id/)
    expect(() => parseQuarantineCommand([...ws, '--discard', 'j', '--export-dir'])).toThrow(/--export-dir needs/)
  })

  it('--release and --discard together is an error', () => {
    expect(() => parseQuarantineCommand([...ws, '--release', 'a', '--discard', 'b'])).toThrow(/exclusive/)
    expect(() => parseQuarantineCommand([...ws, '--discard', 'a', '--show-export', 'b'])).toThrow(/exclusive/)
  })

  it('--show-export reads a recorded discard', () => {
    expect(parseQuarantineCommand([...ws, '--show-export', 'j1'])).toEqual({ action: 'show-export', journal: 'j1' })
    expect(() => parseQuarantineCommand([...ws, '--show-export'])).toThrow(/needs a journal id/)
  })

  it('the help STATES THE WINDOW — storage alone, and what to do before release or discard', () => {
    expect(QUARANTINE_CLI_HELP).toMatch(/from STORAGE ALONE/)
    expect(QUARANTINE_CLI_HELP).toMatch(/BEFORE --release OR --discard: restart \(or stop\) every cell that ran the journal's attempts/)
    expect(QUARANTINE_CLI_HELP).toMatch(/can land twice/)
  })
})
