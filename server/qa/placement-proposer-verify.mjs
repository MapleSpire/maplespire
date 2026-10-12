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
import { pathToFileURL } from 'node:url'
import { loadProposerCampaign } from './placement-proposer-artifacts.mjs'
import { evaluateProposerCampaign } from './placement-proposer-campaign.mjs'

export function verifyProposerCampaign(args) {
  assert.ok((args.length === 2 || (args.length === 3 && args[2] === '--history=native-frames'))
    && /^[a-f0-9]{64}$/.test(args[1]), 'directory-and-external-manifest-sha-required')
  const historySource = args.length === 3 ? 'native-frames' : 'sql-snapshots'
  const loaded = loadProposerCampaign(args[0], args[1]), result = evaluateProposerCampaign(loaded.campaign, { historySource })
  return { test: 'placement-proposer-native', reached: result.reached, pass: result.pass,
    status: result.status, reasons: result.reasons, creditedUs: result.creditedUs,
    observedCreditUs: result.observedCreditUs, unknownCreditUs: result.unknownCreditUs,
    proposalCount: result.temporal?.proposalCount ?? null, manifestSha256: loaded.manifestSha256,
    sourceFileCount: loaded.sourceFileCount, ...(result.historyEvidence ? { historyEvidence: result.historyEvidence } : {}) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = verifyProposerCampaign(process.argv.slice(2))
    process.stdout.write('QARESULT ' + JSON.stringify(result) + '\n')
    if (!result.pass) process.exitCode = 1
  } catch {
    process.stderr.write('placement-proposer-verify: arguments or closed artifacts invalid\n')
    process.exitCode = 1
  }
}
