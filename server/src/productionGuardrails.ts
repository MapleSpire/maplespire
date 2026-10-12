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

export interface ProductionGuardrailResult {
  production: boolean
  missing: string[]
  unsafeEnabled: string[]
}

/** Enterprise production invariants. Development/test stacks stay configurable,
 * but a production process must not silently fall back to full sync or no auth. */
export function inspectProductionGuardrails(env: NodeJS.ProcessEnv): ProductionGuardrailResult {
  if (env.NODE_ENV !== 'production') return { production: false, missing: [], unsafeEnabled: [] }

  const required: Array<[string, string]> = [
    ['AUTH', 'on'],
    ['READ_MODEL', 'on'],
    ['AM_SELECTIVE_SYNC', 'on'],
  ]
  const unsafe: Array<[string, string]> = [
    ['AUTH_DEV_LOGIN', 'on'],
    ['ORG_SEED', 'on'],
    ['PERFORMANCE_SEED', 'on'],
  ]
  return {
    production: true,
    missing: [
      ...required.filter(([name, value]) => env[name] !== value).map(([name]) => name),
      ...(!env.AUTH_SECRET?.trim() ? ['AUTH_SECRET'] : []),
    ],
    unsafeEnabled: unsafe.filter(([name, value]) => env[name] === value).map(([name]) => name),
  }
}

export function assertProductionGuardrails(env: NodeJS.ProcessEnv): void {
  const result = inspectProductionGuardrails(env)
  if (!result.production || (result.missing.length === 0 && result.unsafeEnabled.length === 0)) return

  const problems = [
    ...(result.missing.length ? [`required flags not enabled: ${result.missing.join(', ')}`] : []),
    ...(result.unsafeEnabled.length ? [`development-only flags enabled: ${result.unsafeEnabled.join(', ')}`] : []),
  ]
  throw new Error(`[production guardrails] refusing to start — ${problems.join('; ')}`)
}
