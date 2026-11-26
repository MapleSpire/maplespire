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
  DEFAULT_MODEL_EPOCH_PERIOD_DAYS,
  DEFAULT_MODEL_EPOCH_RETAIN,
  MAX_MODEL_EPOCH_PERIOD_DAYS,
  MAX_MODEL_EPOCH_RETAIN,
  MODEL_EPOCHS_FLAG,
  MODEL_EPOCH_PERIOD_DAYS_ENV,
  MODEL_EPOCH_RETAIN_ENV,
  MODEL_EPOCH_RETAIN_FLOOR,
  ModelEpochConfigError,
  modelEpochConfig,
} from './modelEpochConfig.js'

describe('modelEpochConfig (G4-16f, retention floor)', () => {
  it('defaults: off, 3 previous epochs, 30 days', () => {
    expect(modelEpochConfig({})).toEqual({ enabled: false, retain: 3, periodDays: 30 })
    expect(DEFAULT_MODEL_EPOCH_RETAIN).toBe(3)
    expect(DEFAULT_MODEL_EPOCH_PERIOD_DAYS).toBe(30)
    expect(MODEL_EPOCH_RETAIN_FLOOR).toBe(3)
  })

  it('the flag: missing, blank and off are off; on is on; anything else refuses', () => {
    expect(modelEpochConfig({ [MODEL_EPOCHS_FLAG]: '' }).enabled).toBe(false)
    expect(modelEpochConfig({ [MODEL_EPOCHS_FLAG]: 'off' }).enabled).toBe(false)
    expect(modelEpochConfig({ [MODEL_EPOCHS_FLAG]: ' on ' }).enabled).toBe(true)
    for (const bad of ['true', '1', 'ON', 'shadow', 'yes']) {
      expect(() => modelEpochConfig({ [MODEL_EPOCHS_FLAG]: bad })).toThrow(ModelEpochConfigError)
    }
  })

  // Each of these is a value an operator
  // could write, and none may become a retention below 3 or a silent default.
  it.each(['0', '1', '2', '', ' 3', '3 ', '3.5', '-3', 'NaN', '1e1', '0x3', '+3', 'three', `${MAX_MODEL_EPOCH_RETAIN + 1}`])(
    'AM_MODEL_EPOCH_RETAIN=%j refuses to boot', (value) => {
      expect(() => modelEpochConfig({ [MODEL_EPOCH_RETAIN_ENV]: value })).toThrow(ModelEpochConfigError)
    })

  it('the refusal names the variable, the value and the rule', () => {
    expect(() => modelEpochConfig({ [MODEL_EPOCH_RETAIN_ENV]: '1' })).toThrow(/AM_MODEL_EPOCH_RETAIN=1 .*\[3, 120\].*never 0, 1 or 2/)
    expect(() => modelEpochConfig({ [MODEL_EPOCH_RETAIN_ENV]: '' })).toThrow(/AM_MODEL_EPOCH_RETAIN="" is not a decimal integer/)
  })

  it.each([['3', 3], ['10', 10], ['03', 3], [`${MAX_MODEL_EPOCH_RETAIN}`, MAX_MODEL_EPOCH_RETAIN]])(
    'AM_MODEL_EPOCH_RETAIN=%j is accepted as %d', (value, expected) => {
      expect(modelEpochConfig({ [MODEL_EPOCH_RETAIN_ENV]: value }).retain).toBe(expected)
    })

  it('the retention is checked whatever the flag: a bad value is refused while epochs are off', () => {
    expect(() => modelEpochConfig({ [MODEL_EPOCHS_FLAG]: 'off', [MODEL_EPOCH_RETAIN_ENV]: '2' })).toThrow(ModelEpochConfigError)
  })

  it.each(['0', '', '-1', '1.5', '7d', `${MAX_MODEL_EPOCH_PERIOD_DAYS + 1}`])(
    'AM_MODEL_EPOCH_PERIOD_DAYS=%j refuses to boot', (value) => {
      expect(() => modelEpochConfig({ [MODEL_EPOCH_PERIOD_DAYS_ENV]: value })).toThrow(ModelEpochConfigError)
    })

  it('AM_MODEL_EPOCH_PERIOD_DAYS accepts 1 and its maximum', () => {
    expect(modelEpochConfig({ [MODEL_EPOCH_PERIOD_DAYS_ENV]: '1' }).periodDays).toBe(1)
    expect(modelEpochConfig({ [MODEL_EPOCH_PERIOD_DAYS_ENV]: `${MAX_MODEL_EPOCH_PERIOD_DAYS}` }).periodDays)
      .toBe(MAX_MODEL_EPOCH_PERIOD_DAYS)
  })
})
