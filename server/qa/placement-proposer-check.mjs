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

import { pathToFileURL } from 'node:url'
import { evaluateProposalHistory } from './placement-proposer-qualification.mjs'

/** Synthetic temporal controls only. No invented six-hour native campaign is
 * smuggled into the short CI check. The standalone soak uses this same temporal
 * evaluator and supplies separate native duration, signal and lifetime proof. */
export function proposerTemporalControl(variant = 'healthy') {
  if (!['healthy', 'two-in-hour'].includes(variant)) throw new Error('invalid-control')
  const first = { proposal_id: 'control-first', landscape_id: 'control-landscape', at_us: '1000000000000000',
    payload: { evaluatedAtUs: '1000000000000000', members: [
      { landscapeId: 'control-landscape', versionId: 'main', fromPartition: 0, toPartition: 1 },
      { landscapeId: 'control-landscape', versionId: 'draft', fromPartition: 0, toPartition: 1 },
      { landscapeId: 'control-landscape', versionId: 'already-there', fromPartition: 1, toPartition: 1 },
    ] } }
  const proposals = [first]
  if (variant === 'two-in-hour') proposals.push({ ...structuredClone(first),
    proposal_id: 'control-second', at_us: '1000003600000000',
    payload: { ...structuredClone(first.payload), evaluatedAtUs: '1000003600000000' } })
  return { proposals, movements: [] }
}

export function runProposerCheck(args) {
  if (args.length > 1 || (args.length === 1 && !args[0].startsWith('--control='))) {
    throw new Error('invalid-check-arguments')
  }
  const variant = args[0]?.slice('--control='.length) ?? 'healthy'
  const result = evaluateProposalHistory(proposerTemporalControl(variant))
  const report = { test: 'placement-proposer', reached: result.reached, pass: result.pass,
    scope: 'synthetic temporal control, not a native campaign', control: variant, ...result }
  process.stdout.write('QARESULT ' + JSON.stringify(report) + '\n')
  return report.pass ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = runProposerCheck(process.argv.slice(2)) }
  catch {
    process.stderr.write('placement-proposer-check: invalid control or arguments\n')
    process.exitCode = 1
  }
}
