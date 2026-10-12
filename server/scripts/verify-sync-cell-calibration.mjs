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
import { writeFileSync } from 'node:fs'
import { abandonRun, createVerdictGuard, currentGatePhase, parseLoadSoakConfig, runFreshnessCalibration } from './verify-sync-cell-load-soak.mjs'
import { assertCalibrationMeasurement, calibrationHostHashes } from './sync-cell-calibration.mjs'

let config
const guard = createVerdictGuard({ deadlineMs: 330_000, phase: currentGatePhase,
  onAbandon: () => { if (config) abandonRun(config) } })
guard.arm()
async function run() {
  const destination = process.argv[2]
  assert.ok(destination, 'calibration requires an output path')
  config = parseLoadSoakConfig(process.env, ['--mode=soak'])
  assert.ok(config.benchPosture, 'calibration requires a resolved bench posture')
  const hostSources = calibrationHostHashes()
  const measurement = { ...await runFreshnessCalibration(config), hostSources }
  assert.deepEqual(calibrationHostHashes(), hostSources, 'host calibration code changed during measurement')
  // Preserve an invalid threshold result before deciding the native exit code.
  writeFileSync(destination, JSON.stringify(measurement), { flag: 'wx', mode: 0o600 })
  assertCalibrationMeasurement(measurement)
  return { outcome: 'passed', calibration: { freshAfterTakeoverMs: measurement.freshness.freshAfterTakeoverMs } }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  const forward = () => {
    if (config) abandonRun(config)
    process.removeListener(signal, forward)
    process.kill(process.pid, signal)
  }
  process.on(signal, forward)
}
run().then(verdict => guard.settle(verdict), error => guard.fail(error))
