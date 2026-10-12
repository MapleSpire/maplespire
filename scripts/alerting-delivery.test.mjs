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

import assert from 'node:assert/strict'
import test from 'node:test'
import { runDeliveryArm } from './alerting-delivery-harness.mjs'

test('native Watchdog, explicit SMTP failure and expiry preserve the shipped delivery contract', { timeout: 560000 }, async t => {
  const result = await runDeliveryArm({ arm: 'positive', signal: t.signal })
  assert.equal(result.verdict, 'passed')
  assert.equal(result.cleanup.verified, true)
})

test('without alerting, a live Watchdog delivers nothing; the same collector still accepts a control', { timeout: 240000 }, async t => {
  const result = await runDeliveryArm({ arm: 'without-alerting', signal: t.signal })
  assert.equal(result.verdict, 'passed')
  assert.equal(result.cleanup.verified, true)
})
