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
 * Build the CLIENT of a pinned older commit (the "N-1" build) into
 * `.n-minus-1/`, for the N-1 <-> N compatibility harness (V0-09,
 * `e2e/compat-n-1.spec.ts`).
 *
 * How:
 *  1. resolve the ref to a commit;
 *  2. `git worktree add --detach` it into a fresh temp directory;
 *  3. give it dependencies: a symlink to this checkout's `node_modules` when
 *     the ref's `package-lock.json` is byte-identical to ours, `npm ci`
 *     otherwise;
 *  4. `vite build` it (production mode, SAME-ORIGIN: `VITE_SYNC_API_URL` and
 *     `VITE_AUTOMERGE_URL` forced empty, exactly as the nginx image builds it),
 *     so the bundle does not depend on any stack's ports;
 *  5. swap the result into `.n-minus-1/` and write `compat-build.json` beside
 *     it, naming the commit the bundle came from;
 *  6. ALWAYS remove the temp worktree (and `git worktree prune`), on success,
 *     on failure and on SIGINT/SIGTERM.
 *
 * Refs:
 *   --ref v0-08       (default) the merge commit of `feat/v0-08` — the OLDEST
 *                     build whose reconcile keeps fields it does not know, so
 *                     the oldest N-1 the harness can be green against
 *   --ref pre-v0-08   that merge's FIRST PARENT — the last develop commit
 *                     without V0-08, i.e. the deleting reconcile. This is the
 *                     harness's RED control, not a supported N-1.
 *   --ref <any rev>   a tag, branch or sha
 *
 * Usage:
 *   node scripts/build-n-minus-1.mjs [--ref <rev>] [--force] [--out <dir>]
 *   node scripts/build-n-minus-1.mjs --help
 *
 * A build whose `compat-build.json` already names the resolved commit is kept
 * unless `--force` is given.
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_OUT = path.join(ROOT, '.n-minus-1')
export const STAMP = 'compat-build.json'
/** The merge whose message names this branch delimits pre/post V0-08. */
const V008_BRANCH = 'feat/v0-08'

export const USAGE = `Usage:
  node scripts/build-n-minus-1.mjs [--ref <rev>] [--force] [--out <dir>]

  --ref v0-08       (default) the feat/v0-08 merge commit: the oldest build
                    whose reconcile keeps unknown fields
  --ref pre-v0-08   its first parent: the deleting reconcile (RED control)
  --ref <rev>       any tag, branch or sha
  --force           rebuild even if the output already names that commit
  --out <dir>       output directory (default .n-minus-1/)`

/** @returns {{ ref: string, force: boolean, out: string, help: boolean } | { error: string }} */
export function parseBuildArgs(argv) {
  const parsed = { ref: 'v0-08', force: false, out: DEFAULT_OUT, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--force') parsed.force = true
    else if (arg === '--ref' || arg === '--out') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) return { error: `${arg} needs a value` }
      if (arg === '--ref') parsed.ref = value
      else parsed.out = path.resolve(value)
      i += 1
    } else if (arg.startsWith('--ref=')) parsed.ref = arg.slice('--ref='.length)
    else return { error: `Unknown argument: ${arg}` }
  }
  if (!parsed.ref) return { error: '--ref needs a value' }
  return parsed
}

/**
 * The `feat/v0-08` merge among `git log --merges --format=%H%x09%P%x09%s`
 * lines, newest first: the first whose SUBJECT names the branch (a body that
 * merely mentions it does not count). Returns its sha and first parent.
 */
export function pickV008Merge(logText) {
  for (const line of logText.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [sha, parents = '', ...subjectParts] = line.split('\t')
    const subject = subjectParts.join('\t')
    if (!subject.includes(V008_BRANCH)) continue
    const [firstParent] = parents.trim().split(/\s+/)
    if (!/^[0-9a-f]{40}$/.test(sha) || !/^[0-9a-f]{40}$/.test(firstParent ?? '')) continue
    return { merge: sha, firstParent }
  }
  return null
}

function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr?.trim()}`)
  }
  return result.stdout.trim()
}

export function resolveRef(ref) {
  if (ref === 'v0-08' || ref === 'pre-v0-08') {
    const found = pickV008Merge(git(['log', '--merges', '--format=%H%x09%P%x09%s', `--grep=${V008_BRANCH}`, 'HEAD']))
    if (!found) throw new Error(`no merge of ${V008_BRANCH} is reachable from HEAD`)
    return ref === 'v0-08' ? found.merge : found.firstParent
  }
  return git(['rev-parse', '--verify', `${ref}^{commit}`])
}

function readStamp(out) {
  try {
    return JSON.parse(readFileSync(path.join(out, STAMP), 'utf8'))
  } catch {
    return null
  }
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.signal})`)
}

export function buildNMinus1({ ref, force, out }) {
  const sha = resolveRef(ref)
  const subject = git(['log', '-1', '--format=%s', sha])
  const existing = readStamp(out)
  if (!force && existing?.sha === sha && existsSync(path.join(out, 'index.html'))) {
    console.log(`[n-1] ${path.relative(ROOT, out) || out} already holds ${sha.slice(0, 10)} (${subject}); --force to rebuild`)
    return existing
  }

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'maplespire-n-minus-1-'))
  const tree = path.join(tmp, 'tree')
  const staging = `${out}.staging`
  let worktreeAdded = false
  const cleanup = () => {
    // The symlink first, by hand: never let a recursive delete walk into it.
    try { unlinkSync(path.join(tree, 'node_modules')) } catch { /* absent, or a real npm ci tree */ }
    if (worktreeAdded) spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: ROOT, stdio: 'ignore' })
    rmSync(tmp, { recursive: true, force: true })
    spawnSync('git', ['worktree', 'prune'], { cwd: ROOT, stdio: 'ignore' })
    rmSync(staging, { recursive: true, force: true })
  }
  const onSignal = (signal) => {
    cleanup()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const started = Date.now()
  try {
    console.log(`[n-1] worktree ${sha.slice(0, 10)} (${subject}) -> ${tree}`)
    git(['worktree', 'add', '--detach', tree, sha])
    worktreeAdded = true

    const ourLock = readFileSync(path.join(ROOT, 'package-lock.json'))
    const theirLock = readFileSync(path.join(tree, 'package-lock.json'))
    let deps
    if (ourLock.equals(theirLock) && existsSync(path.join(ROOT, 'node_modules'))) {
      symlinkSync(realpathSync(path.join(ROOT, 'node_modules')), path.join(tree, 'node_modules'), 'dir')
      deps = 'symlink (identical package-lock.json)'
    } else {
      run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: tree, shell: process.platform === 'win32' })
      deps = 'npm ci (package-lock.json differs)'
    }
    console.log(`[n-1] dependencies: ${deps}`)

    rmSync(staging, { recursive: true, force: true })
    const viteStarted = Date.now()
    run(process.execPath, [path.join(tree, 'node_modules', 'vite', 'bin', 'vite.js'), 'build',
      '--outDir', staging, '--emptyOutDir'], {
      cwd: tree,
      // Inline env wins over any .env file (a fresh worktree has none anyway).
      env: { ...process.env, NODE_ENV: 'production', VITE_SYNC_API_URL: '', VITE_AUTOMERGE_URL: '' },
    })
    const viteMs = Date.now() - viteStarted
    if (!existsSync(path.join(staging, 'index.html'))) throw new Error('vite build produced no index.html')

    const stamp = { ref, sha, subject, deps, builtAt: new Date().toISOString(), viteMs, totalMs: Date.now() - started }
    writeFileSync(path.join(staging, STAMP), `${JSON.stringify(stamp, null, 2)}\n`)
    rmSync(out, { recursive: true, force: true })
    renameSync(staging, out)
    console.log(`[n-1] built ${sha.slice(0, 10)} into ${path.relative(ROOT, out) || out} in ${Math.round(stamp.totalMs / 1000)} s`)
    return stamp
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    cleanup()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseBuildArgs(process.argv.slice(2))
  if ('error' in args) {
    console.error(`${args.error}\n\n${USAGE}`)
    process.exit(2)
  }
  if (args.help) {
    console.log(USAGE)
    process.exit(0)
  }
  try {
    buildNMinus1(args)
  } catch (error) {
    console.error(`[n-1] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
