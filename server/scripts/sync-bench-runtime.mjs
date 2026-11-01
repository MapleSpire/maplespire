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
 * B5.16c: the bench gates (failover, load-soak) drive their stack through a
 * handful of `docker compose` verbs — pause, unpause, `ps --status paused`,
 * `exec postgres psql`, `logs`. With `SYNC_BENCH_RUNTIME=kubernetes` the same
 * verbs are translated for the kubernetes-runtime module on a LOCAL Docker
 * Desktop cluster:
 *
 *   sync-cell-a/b/c   -> StatefulSet pods maplespire-sync-cell-0/1/2
 *   sync-ws-router    -> Deployment maplespire-sync-ws-router
 *   postgres          -> Deployment postgres in the dependency namespace
 *   pause / unpause   -> `ctr task pause|resume` of the pod's container, run
 *                        inside the kind node container that hosts it: a cgroup
 *                        freeze, like `docker compose pause` — BUT only while it
 *                        stays under the cell's liveness budget (30 s x 3 in
 *                        sync_cells.tf): a longer freeze becomes a kubelet
 *                        restart, which the gates' 20-30 s waits stay inside.
 *
 * Docker Desktop's nodes are containers reachable as `docker --context
 * desktop-linux exec <nodeName>`; that is what makes this local-only. The
 * Compose path is untouched when the variable is absent.
 */
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const KUBERNETES = 'kubernetes'

export function benchRuntime(env = process.env) {
  if (!env.SYNC_BENCH_RUNTIME) return null
  if (env.SYNC_BENCH_RUNTIME !== KUBERNETES) throw new Error('SYNC_BENCH_RUNTIME must be kubernetes or unset')
  const namespace = env.SYNC_BENCH_K8S_NAMESPACE?.trim()
  const depsNamespace = env.SYNC_BENCH_K8S_DEPS_NAMESPACE?.trim()
  const dbUser = env.SYNC_BENCH_K8S_DB_USER?.trim()
  const dbName = env.SYNC_BENCH_K8S_DB_NAME?.trim()
  for (const [name, value] of Object.entries({ namespace, depsNamespace, dbUser, dbName })) {
    if (!value || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value)) throw new Error(`SYNC_BENCH_K8S_* ${name} is missing or invalid`)
  }
  return { context: env.SYNC_BENCH_K8S_CONTEXT?.trim() || 'docker-desktop', namespace, depsNamespace, dbUser, dbName }
}

const CELL = /^sync-cell-([a-z])$/

/** Pure: which Kubernetes object a Compose service name stands for. */
export function kubernetesTarget(runtime, service) {
  const cell = CELL.exec(service)
  if (cell) return { namespace: runtime.namespace, pod: `maplespire-sync-cell-${cell[1].charCodeAt(0) - 97}` }
  if (service === 'sync-ws-router') return { namespace: runtime.namespace, workload: 'deployment/maplespire-sync-ws-router' }
  if (service === 'postgres') return { namespace: runtime.depsNamespace, workload: 'deployment/postgres' }
  throw new Error(`no Kubernetes target for compose service ${service}`)
}

/** Pure: the psql argv with the lab's role and database in place of Compose's. */
export function translatePsqlArgs(runtime, args) {
  const out = [...args]
  for (const [flag, value] of [['-U', runtime.dbUser], ['-d', runtime.dbName]]) {
    const at = out.indexOf(flag)
    if (at < 0 || at + 1 >= out.length) throw new Error(`psql call without ${flag}`)
    out[at + 1] = value
  }
  return out
}

/**
 * Pure: the commands that implement one compose verb, as [file, argv] pairs.
 * `containerOf(service)` resolves a pod to { node, id } (impure, injected).
 */
export function translateCompose(runtime, args, containerOf) {
  const kubectl = (...rest) => ['kubectl', ['--context', runtime.context, '--request-timeout=20s', ...rest]]
  const [verb, ...rest] = args
  if (verb === 'pause' || verb === 'unpause') {
    if (rest.length !== 1) throw new Error(`compose ${verb} expects exactly one service`)
    const { node, id } = containerOf(rest[0])
    return [['docker', ['--context', 'desktop-linux', 'exec', node, 'ctr', '--namespace', 'k8s.io', 'task', verb === 'pause' ? 'pause' : 'resume', id]]]
  }
  if (verb === 'exec') {
    const [flag, service, ...command] = rest
    if (flag !== '-T' || service !== 'postgres' || command[0] !== 'psql') throw new Error('only `exec -T postgres psql` is translated')
    const target = kubernetesTarget(runtime, service)
    return [kubectl('-n', target.namespace, 'exec', target.workload, '--', ...translatePsqlArgs(runtime, command))]
  }
  if (verb === 'logs') {
    const service = rest.at(-1)
    const at = rest.indexOf('--tail')
    const tail = at >= 0 ? rest[at + 1] : undefined
    const target = kubernetesTarget(runtime, service)
    return [kubectl('-n', target.namespace, 'logs', target.pod ?? target.workload, `--tail=${tail ?? 2000}`)]
  }
  throw new Error(`compose ${verb} has no Kubernetes translation`)
}

/**
 * The session file a run may use instead of dev-login (the module refuses
 * AUTH_DEV_LOGIN in production), or null. Refused without the runtime, so a
 * Compose run can never be handed someone else's session.
 */
export function benchSessionFile(runtime, env = process.env) {
  const file = env.SYNC_FAILOVER_SESSION_FILE
  if (!file) return null
  if (!runtime) throw new Error('SYNC_FAILOVER_SESSION_FILE is only for SYNC_BENCH_RUNTIME=kubernetes')
  return file
}

/**
 * `/api/auth/me` for a handed-in session must carry a SIGNED platform-admin
 * claim and an organization: the gates assert that other workspaces are
 * refused, which a non-admin or org-less session would satisfy vacuously.
 * The claim, which the routes trust — not the users row, which a grant after
 * the cookie was minted would already show.
 */
export function assertBenchSession(me) {
  if (me?.claims?.isPlatformAdmin !== true) throw new Error('bench session is not a platform admin')
  if (typeof me.claims.orgId !== 'string' || !me.claims.orgId) throw new Error('bench session has no organization')
  if (typeof me.user?.id !== 'string' || !me.user.id) throw new Error('bench session has no user')
  return { userId: me.user.id, orgId: me.claims.orgId }
}

export function containerOfFactory(runtime, exec = execFileSync) {
  return (service) => {
    const target = kubernetesTarget(runtime, service)
    if (!target.pod) throw new Error(`${service} is not a pod-backed cell`)
    const pod = JSON.parse(exec('kubectl', ['--context', runtime.context, '--request-timeout=20s', '-n', target.namespace,
      'get', 'pod', target.pod, '-o', 'json'], { encoding: 'utf8', timeout: 30_000, windowsHide: true }))
    // By name: kubelet orders statuses by name, so index 0 is only the cell
    // while no sidecar sorts before it.
    const status = pod.status?.containerStatuses?.find(entry => entry.name === 'sync-cell')
    const id = /^containerd:\/\/([0-9a-f]{64})$/.exec(status?.containerID ?? '')?.[1]
    if (!id || !pod.spec?.nodeName) throw new Error(`${target.pod} has no running containerd container`)
    return { node: pod.spec.nodeName, id }
  }
}

/** `docker compose ps --status paused --services`, answered from containerd. */
export function pausedServices(runtime, services, exec = execFileSync) {
  const containerOf = containerOfFactory(runtime, exec)
  const paused = []
  for (const service of services) {
    try {
      const { node, id } = containerOf(service)
      const tasks = exec('docker', ['--context', 'desktop-linux', 'exec', node, 'ctr', '--namespace', 'k8s.io', 'task', 'ls'],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true })
      if (tasks.split(/\r?\n/).some(line => line.startsWith(id) && /\bPAUS(ED|ING)\b/.test(line))) paused.push(service)
    } catch {
      // Unknown is not "not paused": the callers only unpause, best effort,
      // so reporting it lets them try instead of leaving a frozen cell behind.
      paused.push(service)
    }
  }
  return paused.join('\n')
}

const CELL_SERVICES = ['sync-cell-a', 'sync-cell-b', 'sync-cell-c']

/** Drop-in for `execFileSync('docker', ['compose', ...args])`. */
export function runComposeSync(runtime, args, options = {}) {
  if (args[0] === 'ps') return pausedServices(runtime, CELL_SERVICES)
  let output = ''
  for (const [file, argv] of translateCompose(runtime, args, containerOfFactory(runtime))) {
    output += execFileSync(file, argv, { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...options })
  }
  return output
}

/** Drop-in for `promisify(execFile)('docker', ['compose', ...args])`. */
export async function runCompose(runtime, args) {
  if (args[0] === 'ps') return { stdout: pausedServices(runtime, CELL_SERVICES), stderr: '' }
  let stdout = '', stderr = ''
  for (const [file, argv] of translateCompose(runtime, args, containerOfFactory(runtime))) {
    const result = await promisify(execFile)(file, argv, { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    stdout += result.stdout; stderr += result.stderr
  }
  return { stdout, stderr }
}
