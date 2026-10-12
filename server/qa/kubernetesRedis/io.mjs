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


import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const CONTEXT = '--context=docker-desktop'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const dnsName = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const blockedFlags = /^(?:--(?:context|kubeconfig|server|cluster|user|token|username|password|client-certificate|client-key|certificate-authority|insecure-skip-tls-verify|as|as-group|as-uid)(?:=|$)|-s)/
function publicError(code, evidence) {
  const error = new Error(code)
  error.publicCode = code
  if (evidence !== undefined) error.evidence = evidence
  return error
}
function check(condition, code) { if (!condition) throw publicError(code) }
function integer(value, min, max, code) { check(Number.isSafeInteger(value) && value >= min && value <= max, code); return value }
function validateArgs(args) {
  check(Array.isArray(args) && args.length > 0 && args.length <= 100, 'INVALID_ARGUMENTS')
  check(args.every(arg => typeof arg === 'string' && arg.length > 0 && arg.length <= 4096 && !/[\0\r\n]/.test(arg)), 'INVALID_ARGUMENTS')
  check(args.every(arg => !blockedFlags.test(arg)), 'CONTEXT_OR_CREDENTIAL_OVERRIDE_REFUSED')
}
function validateSignal(signal) { check(signal === undefined || signal instanceof AbortSignal, 'INVALID_SIGNAL') }

// Production defaults invoke native kubectl. The only seam is a spawn function
// for local process tests; an injected factory labels all evidence accordingly.
// No shell, detached process, arbitrary error string, argv or stdin is published.
export function createFaultIo({ spawnProcess = spawn, kubectlPath = 'kubectl', apiServer, now = () => performance.now() } = {}) {
  check(typeof spawnProcess === 'function' && typeof now === 'function', 'INVALID_DEPENDENCY')
  check(apiServer === undefined || /^https:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(apiServer), 'LOCAL_API_REQUIRED')
  check(typeof kubectlPath === 'string' && kubectlPath.length > 0 && !/[\0\r\n]/.test(kubectlPath), 'INVALID_EXECUTABLE')
  const backend = spawnProcess === spawn ? 'native-kubectl' : 'injected-local-process'
  let lastAt = -Infinity
  function clock() {
    const at = now()
    check(Number.isFinite(at) && at >= lastAt, 'INVALID_MONOTONIC_CLOCK')
    lastAt = at
    return at
  }

  function startProcess(args, { input, timeoutMs, signal } = {}) {
    validateArgs(args)
    validateSignal(signal)
    integer(timeoutMs, 10, 600000, 'INVALID_TIMEOUT')
    check(input === undefined || typeof input === 'string' || Buffer.isBuffer(input), 'INVALID_INPUT')
    const bytes = input === undefined ? Buffer.alloc(0) : Buffer.from(input)
    check(bytes.length <= 4 * 1024 * 1024, 'INPUT_LIMIT')
    const events = [], stdout = [], stderr = [], listeners = new Set()
    let reason = null, child, closed = false, stdoutBytes = 0, stderrBytes = 0, stdinFinished = false
    let timer, escalation, stopFlight, closeResolve, clockFailed = false
    const startedAt = clock(), deadline = startedAt + timeoutMs
    const done = new Promise(resolveDone => { closeResolve = resolveDone })
    const at = () => {
      try { return clock() } catch { clockFailed = true; reason ??= 'INVALID_MONOTONIC_CLOCK'; return null }
    }
    const record = kind => { const stamp = at(); events.push({ kind, at: stamp }); return stamp }
    const cancel = () => terminate('ABORTED')
    function finish(code, signalName, nativeCloseConfirmed) {
      if (closed) return
      closed = true
      clearTimeout(timer)
      clearTimeout(escalation)
      signal?.removeEventListener('abort', cancel)
      const closedAt = record(nativeCloseConfirmed ? 'child-close' : 'no-child-created')
      const out = Buffer.concat(stdout), err = Buffer.concat(stderr)
      const error = reason ?? (code === 0 && !signalName ? stdinFinished ? null : 'STDIN_INCOMPLETE' : 'CHILD_FAILED')
      const summary = { backend, context: 'docker-desktop', pid: child?.pid ?? null, spawned: Boolean(child),
        startedAt, closedAt, code, signal: signalName, error, timedOut: error === 'TIMEOUT',
        nativeCloseConfirmed, stdinFinished, inputBytes: bytes.length, stdoutBytes, stderrBytes,
        stdoutCapturedBytes: out.length, stderrCapturedBytes: err.length,
        stdoutSha256: sha(out), stderrSha256: sha(err), clockValid: !clockFailed, events: [...events] }
      closeResolve({ ...summary, ok: error === null && nativeCloseConfirmed && !clockFailed,
        stdout: out.toString('utf8'), public: summary })
    }
    function terminate(cause = 'STOPPED') {
      if (closed) return done
      reason ??= cause
      if (!child) { finish(null, null, false); return done }
      record('termination-requested')
      try { child.kill() } catch { reason = 'CHILD_KILL_FAILED' }
      escalation ??= setTimeout(() => {
        if (closed) return
        record('kill-escalated')
        try { child.kill('SIGKILL') } catch { reason = 'CHILD_KILL_FAILED' }
      }, 500)
      return done
    }
    if (signal?.aborted) { reason = 'ABORTED'; finish(null, null, false) }
    else {
      try {
        child = spawnProcess(kubectlPath, [CONTEXT, ...(apiServer ? ['--server=' + apiServer] : []), ...args], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        record('spawn-returned')
        child.once('error', () => { reason ??= 'SPAWN_FAILED' })
        child.once('close', (code, signalName) => finish(code, signalName, true))
        child.stdout.on('data', chunk => {
          stdoutBytes += chunk.length
          if (stdoutBytes > 8 * 1024 * 1024) { terminate('STDOUT_LIMIT'); return }
          stdout.push(Buffer.from(chunk))
          for (const listener of listeners) {
            try { listener(chunk.toString('utf8')) } catch { terminate('COLLECTOR_FAILED') }
          }
        })
        child.stderr.on('data', chunk => {
          stderrBytes += chunk.length
          if (stderrBytes > 1024 * 1024) { terminate('STDERR_LIMIT'); return }
          stderr.push(Buffer.from(chunk))
        })
        child.stdin.once('finish', () => { stdinFinished = true; record('stdin-finish') })
        child.stdin.once('error', () => { reason ??= 'STDIN_FAILED' })
        signal?.addEventListener('abort', cancel, { once: true })
        timer = setTimeout(() => terminate('TIMEOUT'), Math.max(1, deadline - (at() ?? deadline)))
        if (signal?.aborted) cancel()
        if (clockFailed || (at() ?? deadline) >= deadline) terminate(clockFailed ? 'INVALID_MONOTONIC_CLOCK' : 'TIMEOUT')
        else if (!reason) child.stdin.end(bytes)
      } catch {
        reason ??= 'SPAWN_FAILED'
        if (child) terminate(reason)
        else finish(null, null, false)
      }
    }
    return {
      done, pid: child?.pid ?? null, get closed() { return closed },
      get text() { return Buffer.concat(stdout).toString('utf8') },
      subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback) },
      stop(cause = 'STOPPED') { stopFlight ??= terminate(cause); return stopFlight },
    }
  }

  async function runKubectl(args, { input, timeoutMs = 15000, signal } = {}) {
    return startProcess(args, { input, timeoutMs, signal }).done
  }

  async function assertPortFree(port, signal) {
    check(!signal?.aborted, 'ABORTED')
    const beganAt = clock()
    return new Promise((resolveFree, reject) => {
      // A racing local client must not keep this temporary listener alive.
      // Server 'close' still waits until every accepted socket has ended.
      const server = createServer(socket => {
        socket.on('error', () => undefined)
        socket.destroy()
      })
      let timer, settled = false, failure = null, bound = false, closeRequested = false
      const finish = (error, nativeCloseConfirmed) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        let closedAt
        try { closedAt = clock() } catch { error ??= 'INVALID_MONOTONIC_CLOCK' }
        const evidence = { beganAt, closedAt: closedAt ?? null, host: '127.0.0.1', port, nativeCloseConfirmed }
        if (error) reject(publicError(error, evidence)); else resolveFree(evidence)
      }
      const close = () => { if (server.listening && !closeRequested) { closeRequested = true; server.close() } }
      const abort = () => { failure ??= 'ABORTED'; close() }
      server.once('error', error => finish(error?.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'LOCAL_BIND_FAILED', false))
      server.once('listening', () => { bound = true; close() })
      server.once('close', () => finish(failure, bound))
      timer = setTimeout(() => { failure ??= 'LOCAL_BIND_TIMEOUT'; close() }, 2000)
      signal?.addEventListener('abort', abort, { once: true })
      server.listen({ host: '127.0.0.1', port, exclusive: true })
      if (signal?.aborted) abort()
    })
  }

  async function probePort(port, signal, timeoutMs) {
    check(!signal?.aborted, 'ABORTED')
    const beganAt = clock()
    return new Promise((resolveProbe, reject) => {
      let connected = false, error = null, timer
      const socket = connect({ host: '127.0.0.1', port, family: 4 })
      const abort = () => { error ??= 'ABORTED'; socket.destroy() }
      socket.once('connect', () => { connected = true; socket.destroy() })
      socket.once('error', () => { error ??= 'LOCAL_CONNECT_FAILED'; socket.destroy() })
      socket.once('close', () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        let closedAt
        try { closedAt = clock() } catch { error ??= 'INVALID_MONOTONIC_CLOCK' }
        const evidence = { beganAt, closedAt: closedAt ?? null, connected, nativeCloseConfirmed: true }
        if (error || !connected) reject(publicError(error ?? 'LOCAL_CONNECT_FAILED', evidence))
        else resolveProbe(evidence)
      })
      timer = setTimeout(() => { error ??= 'LOCAL_CONNECT_TIMEOUT'; socket.destroy() }, timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }

  async function startPodPortForward({ namespace, podName, podUid, port, remotePort, timeoutMs = 10000, lifetimeMs = 180000, signal } = {}) {
    for (const value of [namespace, podName]) check(typeof value === 'string' && value.length <= 253 && dnsName.test(value), 'INVALID_POD_NAME')
    check(uuid.test(podUid ?? ''), 'INVALID_POD_UID')
    integer(port, 1024, 65535, 'INVALID_LOCAL_PORT')
    integer(remotePort, 1, 65535, 'INVALID_REMOTE_PORT')
    integer(timeoutMs, 100, 60000, 'INVALID_TIMEOUT')
    integer(lifetimeMs, timeoutMs, 600000, 'INVALID_LIFETIME')
    validateSignal(signal)
    const startedAt = clock(), deadline = startedAt + timeoutMs
    const evidence = { backend, context: 'docker-desktop', namespace, podName, podUid, port, remotePort, startedAt,
      before: null, freePort: null, bindAt: null, localProbe: null, after: null, readyAt: null }
    const remaining = () => {
      const left = Math.floor(deadline - clock())
      check(left >= 10 && !signal?.aborted, signal?.aborted ? 'ABORTED' : 'PORT_FORWARD_START_TIMEOUT')
      return left
    }
    const readPod = async () => {
      const result = await runKubectl(['--namespace=' + namespace, 'get', 'pod/' + podName, '--output=json'], { timeoutMs: remaining(), signal })
      check(result.ok, result.error ?? 'POD_GET_FAILED')
      let pod
      try { pod = JSON.parse(result.stdout) } catch { throw publicError('POD_GET_INVALID_JSON', result.public) }
      check(pod?.kind === 'Pod' && pod.metadata?.name === podName && pod.metadata?.namespace === namespace && pod.metadata?.uid === podUid
        && !pod.metadata?.deletionTimestamp, 'POD_UID_MISMATCH')
      return { ...result.public, pod: { name: pod.metadata.name, namespace: pod.metadata.namespace, uid: pod.metadata.uid,
        resourceVersion: pod.metadata.resourceVersion ?? null } }
    }
    let processControl
    try {
      evidence.before = await readPod()
      evidence.freePort = await assertPortFree(port, signal)
      remaining()
      processControl = startProcess(['--namespace=' + namespace, 'port-forward', 'pod/' + podName,
        port + ':' + remotePort, '--address=127.0.0.1'], { timeoutMs: lifetimeMs, signal })
      await new Promise((resolveBind, reject) => {
        let timer, text = processControl.text, unsubscribe = () => undefined, settled = false
        const expected = 'Forwarding from 127.0.0.1:' + port + ' -> ' + remotePort
        const finish = error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unsubscribe()
          if (error) reject(publicError(error)); else resolveBind()
        }
        const inspect = () => {
          if (text.split(/\r?\n/).some(line => line.trim() === expected)) {
            try { evidence.bindAt = clock(); finish() } catch { finish('INVALID_MONOTONIC_CLOCK') }
          }
        }
        unsubscribe = processControl.subscribe(chunk => { text = (text + chunk).slice(-8192); inspect() })
        timer = setTimeout(() => finish('PORT_FORWARD_START_TIMEOUT'), remaining())
        void processControl.done.then(() => finish('PORT_FORWARD_EXITED'))
        inspect()
      })
      evidence.localProbe = await probePort(port, signal, Math.min(1000, remaining()))
      evidence.after = await readPod()
      check(!processControl.closed, 'PORT_FORWARD_EXITED')
      evidence.readyAt = clock()
      remaining()
      let stopFlight
      const stop = () => {
        if (!stopFlight) {
          let requestedAt = null, clockValid = true
          try { requestedAt = clock() } catch { clockValid = false }
          stopFlight = processControl.stop(clockValid ? 'PORT_FORWARD_STOPPED' : 'INVALID_MONOTONIC_CLOCK').then(result => ({
            requestedAt, closed: result.nativeCloseConfirmed, nativeCloseConfirmed: result.nativeCloseConfirmed,
            closedAt: result.closedAt, clockValid: clockValid && result.clockValid, process: result.public,
          }))
        }
        return stopFlight
      }
      return { origin: 'http://127.0.0.1:' + port, pid: processControl.pid, admission: evidence, readyAt: evidence.readyAt,
        done: processControl.done, stop, isRunning: () => !processControl.closed }
    } catch (error) {
      const cleanup = processControl ? await processControl.stop('PORT_FORWARD_SETUP_FAILED') : null
      throw publicError(error?.publicCode ?? 'PORT_FORWARD_SETUP_FAILED', { admission: evidence,
        cleanup: cleanup?.public ?? { spawned: false, nativeCloseConfirmed: null } })
    }
  }

  return { runKubectl, startPodPortForward }
}

const native = createFaultIo()
export const runKubectl = native.runKubectl
export const startPodPortForward = native.startPodPortForward
