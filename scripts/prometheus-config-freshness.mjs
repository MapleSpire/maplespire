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

/**
 * Does the running Prometheus hold the rules that are on disk?
 *
 * `docker compose up -d` recreates a container when its own definition changes;
 * a bind-mounted FILE changing is not a change to the definition, and
 * Prometheus does not watch its config for edits. So a deployment that changes
 * `alerts.yml` or `prometheus.yml` can leave every container healthy while
 * Prometheus keeps serving the OLD rules and scraping the OLD targets — the
 * deployment that fixes an alerting gap is exactly the one that will not load
 * the fix.
 *
 * WHY `lastConfigTime` IS THE RIGHT WITNESS, and a signal is not. A SIGHUP that
 * Prometheus rejects — a malformed rule file, a bad scrape config — is not fatal:
 * it logs, keeps the previous configuration, and carries on. So "we sent the
 * reload" and "the reload landed" are different facts, and only the second one is
 * worth asserting. `lastConfigTime` advances on SUCCESS only, which makes a stale
 * value cover both "nobody reloaded" and "the reload was refused" without having
 * to tell them apart.
 *
 * WHY THE TIMES ARE READ INSIDE THE CONTAINER. `docker inspect` reports the host
 * side of a bind as a Docker Desktop path (`/run/desktop/mnt/host/c/...`) that
 * the Windows host cannot `stat`, and comparing a host mtime against a container
 * clock invites a skew nobody would ever debug. `stat` in the container and
 * `lastConfigTime` come from the same kernel and the same clock, so the
 * comparison is exact rather than approximately right.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Mounted files that are deliberately NOT part of the reload question.
 *
 *  A NEGATIVE list, on purpose. A positive list of files to watch would
 *  silently exempt every rule file added later. Anything mounted that is not
 *  named here is watched, so a new rule file fails closed.
 *
 *  `metrics-token` is excluded because Prometheus re-reads a `credentials_file`
 *  per scrape rather than at configuration load, so its mtime says nothing about
 *  whether a reload is owed — and the init script rewrites it on EVERY run,
 *  so watching it would make the check fail after a deploy that changed nothing. */
const NOT_A_RELOAD_INPUT = new Set(['metrics-token'])

/**
 * The whole verdict, as a pure function, so it can be tested without Docker.
 *
 * @param {{ lastConfigTime: string | null, files: { path: string, mtimeSeconds: number }[] }} input
 * @returns {{ verdict: 'fresh' | 'stale' | 'unknown', reason: string | null,
 *             lastConfigSeconds: number | null, stale: { path: string, mtimeSeconds: number, behindSeconds: number }[] }}
 */
export function configFreshness(input) {
  const { lastConfigTime, files } = input
  const unknown = (reason) => ({ verdict: 'unknown', reason, lastConfigSeconds: null, stale: [] })

  if (lastConfigTime === null || lastConfigTime === undefined || lastConfigTime === '') {
    return unknown('Prometheus did not report a lastConfigTime')
  }
  const parsed = Date.parse(lastConfigTime)
  if (Number.isNaN(parsed)) return unknown(`lastConfigTime is not a date: ${JSON.stringify(lastConfigTime)}`)

  // AN EMPTY FILE LIST IS `unknown`, NEVER `fresh`. "Every watched file is older
  // than the last reload" and "nothing was watched" produce the same empty stale
  // list, and one of them means the detector found nothing because it looked at
  // nothing — e.g. a container built with its config baked in rather than
  // mounted.
  if (!Array.isArray(files) || files.length === 0) {
    return unknown('no mounted configuration files were found to compare against')
  }
  for (const file of files) {
    if (!Number.isFinite(file?.mtimeSeconds)) {
      return unknown(`could not read a modification time for ${file?.path ?? '(unnamed file)'}`)
    }
  }

  const lastConfigSeconds = Math.floor(parsed / 1000)
  const stale = files
    .filter((file) => file.mtimeSeconds > lastConfigSeconds)
    .map((file) => ({ ...file, behindSeconds: file.mtimeSeconds - lastConfigSeconds }))
    .sort((a, b) => b.behindSeconds - a.behindSeconds)

  return { verdict: stale.length > 0 ? 'stale' : 'fresh', reason: null, lastConfigSeconds, stale }
}

const dockerJson = async (args) => {
  const { stdout } = await exec('docker', args, { maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

/** The files Prometheus actually has mounted, asked of the RUNNING container
 *  rather than of the compose file — the compose file states an intention, and
 *  the intention is what this check exists to doubt. */
export async function mountedConfigPaths(container) {
  const raw = await dockerJson(['inspect', container, '--format', '{{json .Mounts}}'])
  const mounts = JSON.parse(raw)
  return mounts
    .filter((mount) => mount.Type === 'bind')
    .map((mount) => String(mount.Destination))
    .filter((destination) => !NOT_A_RELOAD_INPUT.has(destination.split('/').pop()))
    .sort()
}

export async function readMtimes(container, paths) {
  if (paths.length === 0) return []
  const { stdout } = await exec('docker', ['exec', container, 'stat', '-c', '%Y %n', ...paths])
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const gap = line.indexOf(' ')
      return { path: line.slice(gap + 1), mtimeSeconds: Number(line.slice(0, gap)) }
    })
}

export async function readLastConfigTime(container, port) {
  try {
    const { stdout } = await exec('docker', [
      'exec', container, 'wget', '-qO-', `http://127.0.0.1:${port}/api/v1/status/runtimeinfo`,
    ])
    return JSON.parse(stdout)?.data?.lastConfigTime ?? null
  } catch {
    // Not answering yet is not the same as stale, and must not be reported as
    // either. The caller retries; the deadline is what turns it into a failure.
    return null
  }
}

export async function reload(container, port) {
  await exec('docker', [
    'exec', container, 'wget', '-q', '--post-data', '', '-O', '-',
    `http://127.0.0.1:${port}/-/reload`,
  ]).catch(async () => {
    // `--web.enable-lifecycle` is off by default, so the POST door may not exist.
    // SIGHUP always works and means the same thing.
    await exec('docker', ['kill', '--signal', 'SIGHUP', container])
  })
}

const flag = (argv, name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback
}

async function main(argv) {
  const container = flag(argv, '--container', 'maplespire-prometheus-1')
  const port = flag(argv, '--port', '9090')
  const deadlineMs = Number(flag(argv, '--deadline-ms', '60000'))
  const shouldReload = argv.includes('--reload')

  let paths
  try {
    paths = await mountedConfigPaths(container)
  } catch (error) {
    console.error(`prometheus-config: cannot inspect ${container} — ${error.message}`)
    return 2
  }
  console.log(`prometheus-config: watching ${paths.length} mounted file(s) in ${container}`)
  for (const path of paths) console.log(`  ${path}`)

  if (shouldReload) {
    await reload(container, port).catch((error) => {
      console.error(`prometheus-config: reload could not be delivered — ${error.message}`)
    })
  }

  const started = Date.now()
  let report = { verdict: 'unknown', reason: 'not measured yet', stale: [], lastConfigSeconds: null }
  // Poll rather than sleep-then-check: a container that has just been recreated
  // needs a moment to answer, and a reload it DID accept lands in well under a
  // second. The deadline exists for the case where neither ever happens.
  for (;;) {
    const [lastConfigTime, files] = await Promise.all([
      readLastConfigTime(container, port),
      readMtimes(container, paths).catch(() => []),
    ])
    report = configFreshness({ lastConfigTime, files })
    if (report.verdict === 'fresh') break
    if (Date.now() - started >= deadlineMs) break
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  if (report.verdict === 'fresh') {
    const loaded = new Date(report.lastConfigSeconds * 1000).toISOString()
    console.log(`prometheus-config: OK — configuration loaded at ${loaded}, newer than every watched file`)
    return 0
  }
  if (report.verdict === 'unknown') {
    console.error(`prometheus-config: COULD NOT MEASURE — ${report.reason}`)
    console.error('  `incomplete` is not `clean`: this is a failure, not a pass.')
    return 2
  }
  const loaded = new Date(report.lastConfigSeconds * 1000).toISOString()
  console.error(`prometheus-config: STALE — configuration last loaded at ${loaded}, but these are newer:`)
  for (const file of report.stale) {
    console.error(`  ${file.path} — ${file.behindSeconds}s newer than the loaded configuration`)
  }
  console.error('  Prometheus is serving rules and scrape targets that are not the ones on disk.')
  console.error(`  Reload it with:  node scripts/prometheus-config-freshness.mjs --reload --container ${container}`)
  return 1
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('prometheus-config-freshness.mjs')) {
  process.exitCode = await main(process.argv.slice(2))
}
