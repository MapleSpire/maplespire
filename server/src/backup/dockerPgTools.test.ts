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
import { DockerPgTools, parseDatabaseUrl, type CommandLimits } from './backupRestore.js'

/**
 * The container path: an abort must actually stop the remote process.
 *
 * ## Why killing the local client is not enough
 *
 * `docker exec <container> pg_dump …` runs `pg_dump` inside the container; the
 * local `docker` process is only a client. Killing that client — which is all
 * `runCommand`'s watchdog can do — does not stop the remote process. Probed
 * against a live daemon, `docker exec … sleep 120`, client killed with SIGTERM:
 *
 * ```
 *   remote process before the kill ........ ALIVE
 *   local client after SIGTERM ............ code: null, signal: SIGTERM
 *   remote process +1.5 s ................. ALIVE
 *   remote process +3 s ................... ALIVE
 *   remote process after a direct kill -9 . GONE      <- counter-control
 * ```
 *
 * The consequence is not a slow abort: `runCommand` rejects promptly,
 * `runBackupDrill` unwinds, the drill SETTLES inside the grace, and
 * `runDrillTick` takes the ordinary release path — handing the advisory key to
 * a rival while `pg_dump` is still running against production.
 *
 * ## Why these tests inject a runner instead of driving Docker
 *
 * Every alternative needs a live daemon, so on any machine without one the
 * remote-kill mechanism would be gated by nothing. `backupRestore.integration.test.ts` still exercises the
 * real thing where a container is available; this file makes the CONTRACT
 * checkable everywhere: that an abort produces a `kill` inside the container,
 * that the cleanup survives the abort, and that arguments are never handed to a
 * remote shell to re-split.
 */

interface Invocation {
  readonly args: readonly string[]
  readonly limits: CommandLimits
}

function recordingRunner(): {
  readonly calls: Invocation[]
  readonly runner: (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    limits?: CommandLimits,
  ) => Promise<void>
  readonly execs: () => Invocation[]
  readonly kills: () => Invocation[]
} {
  const calls: Invocation[] = []
  return {
    calls,
    runner: async (_command, args, _env, limits = {}) => {
      calls.push({ args: [...args], limits })
      // The subject's own contract: a child under an already-aborted signal is
      // never started. Modelling it is what makes the cleanup assertion mean
      // something — a runner that always succeeds would pass either way.
      if (limits.signal?.aborted && !args.some((a) => a.includes('kill -TERM') || a.startsWith('rm'))) {
        throw new Error('not started: the caller aborted')
      }
    },
    execs: () => calls.filter((c) => c.args[0] === 'exec'),
    kills: () => calls.filter((c) => c.args.some((a) => a.includes('kill -TERM'))),
  }
}

const CONNECTION = parseDatabaseUrl('postgres://u:p@db.internal:5432/maplespire')

function tools(runner: ReturnType<typeof recordingRunner>): DockerPgTools {
  return new DockerPgTools('pg-container', { runner: runner.runner })
}

describe('DockerPgTools — an abort must reach INSIDE the container', () => {
  it('kills the remote process by pid when the caller aborts', async () => {
    const recorder = recordingRunner()
    const stopper = new AbortController()
    // Aborted up front: `addEventListener` on an aborted signal never fires, so
    // this is the interleaving that a naive implementation misses entirely.
    stopper.abort(new Error('the scheduler was asked to stop'))

    await expect(tools(recorder).dump({
      connection: CONNECTION,
      snapshotId: '00000003-0000006B-1',
      outputFile: '/bundles/x.dump',
      signal: stopper.signal,
    })).rejects.toThrow()

    const kills = recorder.kills()
    expect(kills).toHaveLength(1)
    const script = kills[0]!.args.join(' ')
    // TERM first, then KILL: a bound a process can decline is not a bound.
    expect(script).toContain('kill -TERM')
    expect(script).toContain('kill -KILL')
    // Read from a pid file the remote process wrote itself, so the kill cannot
    // hit a pid that has been recycled by something else.
    expect(script).toMatch(/maplespire-exec-[0-9a-f]+\.pid/)
  })

  it('does not kill anything when nothing was aborted', async () => {
    // The negative control. A dump that kills its own `pg_dump` on the happy
    // path would be a far worse defect than the one being fixed.
    const recorder = recordingRunner()
    await tools(recorder).dump({
      connection: CONNECTION,
      snapshotId: '00000003-0000006B-1',
      outputFile: '/bundles/x.dump',
    })
    expect(recorder.kills()).toHaveLength(0)
  })

  it('wraps the command so the remote pid is knowable at all', async () => {
    const recorder = recordingRunner()
    await tools(recorder).dump({
      connection: CONNECTION,
      snapshotId: '00000003-0000006B-1',
      outputFile: '/bundles/x.dump',
    })
    const exec = recorder.execs()[0]!
    const script = exec.args[exec.args.indexOf('-c') + 1]!
    // `exec` replaces the shell, so `$$` — written before it — is the pid of
    // `pg_dump` itself rather than of a shell that is about to disappear.
    expect(script).toMatch(/^echo \$\$ > \/tmp\/maplespire-exec-[0-9a-f]+\.pid; exec "\$@"$/)
  })

  it('passes arguments as $@, never through a remote shell', async () => {
    // A database name containing a space or a quote must not become two
    // arguments inside the container. The `sh -c <script> sh <argv…>` form
    // makes that structural rather than a quoting discipline.
    const recorder = recordingRunner()
    await tools(recorder).dump({
      connection: { ...CONNECTION, database: 'main db; rm -rf /' },
      snapshotId: '00000003-0000006B-1',
      outputFile: '/bundles/x.dump',
    })
    const exec = recorder.execs()[0]!
    expect(exec.args).toContain('main db; rm -rf /')
    const script = exec.args[exec.args.indexOf('-c') + 1]!
    expect(script).not.toContain('main db')
  })
})

describe('DockerPgTools — the cleanup survives the abort that skipped past it', () => {
  it('still removes the remote files after an aborted dump', async () => {
    // A STOP may never skip its own cleanup. `runCommand` refuses to start a
    // child under an aborted signal, so a cleanup carrying the caller's signal
    // would leak a file in the container on every cancelled dump.
    const recorder = recordingRunner()
    const stopper = new AbortController()
    stopper.abort(new Error('the scheduler was asked to stop'))

    await expect(tools(recorder).dump({
      connection: CONNECTION,
      snapshotId: '00000003-0000006B-1',
      outputFile: '/bundles/x.dump',
      signal: stopper.signal,
    })).rejects.toThrow()

    const removals = recorder.calls.filter((c) => c.args.includes('rm'))
    expect(removals.length).toBeGreaterThanOrEqual(1)
    // The load-bearing half: none of them carries the signal that would stop
    // them from running at all.
    for (const removal of removals) {
      expect(removal.limits.signal?.aborted).not.toBe(true)
    }
    // …and each is bounded, so the exemption cannot become a new way to hang
    // while the advisory lock is still held.
    for (const removal of removals) {
      expect(removal.limits.timeoutMs).toBeGreaterThan(0)
      expect(removal.limits.timeoutMs).toBeLessThanOrEqual(60_000)
    }
  })

  it('restore takes the same killable path as dump', async () => {
    // `pg_restore` runs against the ISOLATED database, so an unstoppable one is
    // less dangerous than an unstoppable dump — but it holds the same key for
    // the same duration, so it gets the same mechanism rather than a comment
    // explaining why it does not need one.
    const recorder = recordingRunner()
    const stopper = new AbortController()
    stopper.abort(new Error('the scheduler was asked to stop'))

    await expect(tools(recorder).restore({
      connection: CONNECTION,
      inputFile: '/bundles/x.dump',
      signal: stopper.signal,
    })).rejects.toThrow()

    expect(recorder.kills().length + recorder.calls.filter((c) => c.args.includes('cp')).length)
      .toBeGreaterThan(0)
  })
})
