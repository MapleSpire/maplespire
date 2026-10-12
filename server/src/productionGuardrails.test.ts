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
import { assertProductionGuardrails, inspectProductionGuardrails } from './productionGuardrails.js'

describe('production guardrails', () => {
  it('does not constrain development and test stacks', () => {
    expect(inspectProductionGuardrails({ NODE_ENV: 'development' })).toEqual({
      production: false,
      missing: [],
      unsafeEnabled: [],
    })
    expect(() => assertProductionGuardrails({ NODE_ENV: 'test' })).not.toThrow()
  })

  it('requires auth, read model and selective sync in production', () => {
    expect(() => assertProductionGuardrails({ NODE_ENV: 'production' })).toThrow(
      /AUTH, READ_MODEL, AM_SELECTIVE_SYNC, AUTH_SECRET/
    )
  })

  it('rejects development login and seed routes in production', () => {
    expect(() => assertProductionGuardrails({
      NODE_ENV: 'production',
      AUTH: 'on',
      READ_MODEL: 'on',
      AM_SELECTIVE_SYNC: 'on',
      AUTH_SECRET: 'test-production-secret',
      AUTH_DEV_LOGIN: 'on',
      ORG_SEED: 'on',
      PERFORMANCE_SEED: 'on',
    })).toThrow(/AUTH_DEV_LOGIN, ORG_SEED, PERFORMANCE_SEED/)
  })

  it('accepts the secure production profile', () => {
    expect(() => assertProductionGuardrails({
      NODE_ENV: 'production',
      AUTH: 'on',
      READ_MODEL: 'on',
      AM_SELECTIVE_SYNC: 'on',
      AUTH_SECRET: 'test-production-secret',
    })).not.toThrow()
  })
})
