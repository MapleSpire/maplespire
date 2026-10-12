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
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { composeGateEnvironment, ROOT } from './deployment-placement.mjs'

const HEARTBEAT = 'arn:aws:sns:ca-central-1:123456789012:maplespire-watchdog'
const NOTIFICATION = 'arn:aws:sns:ca-central-1:123456789012:maplespire-alerting-notifications'
let processInterrupted = false
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function counter(source, name, integration) {
  const samples = source.split('\n')
    .filter(line => line.startsWith(name + '{') && line.includes('integration="' + integration + '"'))
    .map(line => Number(line.slice(line.lastIndexOf(' ') + 1)))
  assert.ok(samples.length > 0 && samples.every(Number.isFinite), 'Missing or invalid metric: ' + name)
  return samples.reduce((sum, value) => sum + value, 0)
}

function ruleGroups(source) {
  const starts = [...source.matchAll(/^  - name: (\S+)\n/gm)]
  return starts.map((match, index) => ({ name: match[1],
    text: source.slice(match.index, starts[index + 1]?.index ?? source.length) }))
}

export async function runDeliveryArm({ arm, signal: parentSignal }) {
  assert.equal(processInterrupted, false, 'Process was interrupted; do not acquire a second arm')
  assert.ok(['positive', 'without-alerting'].includes(arm))
  const owner = 'maplespire-delivery-' + randomUUID().slice(0, 12)
  const directory = path.join(ROOT, 'reports', owner)
  const names = { network: owner, sink: owner + '-sink', am: owner + '-am', prom: owner + '-prom' }
  const label = 'maplespire.qa.owner=' + owner
  const environment = composeGateEnvironment()
  const deadline = Date.now() + (arm === 'positive' ? 480000 : 155000)
  const report = { owner, arm, startedAt: new Date().toISOString(), sources: {}, copies: {}, observations: [], verdict: 'running' }
  const volumes = new Set()
  let uncertainAcquisition = false
  let dockerContext
  await mkdir(directory, { recursive: true })
  const controller = new AbortController()
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal
  const executionTimer = setTimeout(() => controller.abort(new Error('Arm execution deadline exceeded')), deadline - Date.now())
  const interrupt = () => { processInterrupted = true; process.exitCode = 1; controller.abort(new Error('Delivery arm interrupted')) }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  let cleanupDeadline
  const record = (kind, data = {}) => report.observations.push({ kind, at: new Date().toISOString(), ...data })
  const check = () => { signal?.throwIfAborted(); assert.ok(Date.now() < deadline, 'Arm execution deadline exceeded') }

  // Await process close even on timeout/abort. A Docker create timeout still
  // leaves daemon-side acquisition uncertain, so cleanup cannot turn it green.
  async function docker(args, { cleanup = false, timeoutMs = 20000 } = {}) {
    if (!cleanup) check()
    const remaining = (cleanup ? cleanupDeadline : deadline) - Date.now()
    assert.ok(remaining > 0, cleanup ? 'Cleanup deadline exceeded; inspect owned resources' : 'Arm deadline exceeded')
    const limit = Math.max(1, Math.min(timeoutMs, remaining))
    return new Promise((resolve, reject) => {
      const child = spawn('docker', dockerContext ? ['--context', dockerContext, ...args] : args,
        { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = '', killedFor = null, settled = false, forceTimer, unconfirmedTimer
      const finish = code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(forceTimer)
        clearTimeout(unconfirmedTimer)
        signal.removeEventListener('abort', abort)
        if (killedFor || code !== 0) reject(new Error('docker ' + args[0] + ': ' + (killedFor ?? code) + '\n' + stderr.slice(-4000)))
        else resolve(stdout.trim())
      }
      const kill = reason => {
        if (killedFor) return
        killedFor = reason
        if (args[0] === 'create' || (args[0] === 'network' && args[1] === 'create')) uncertainAcquisition = true
        child.kill()
        forceTimer = setTimeout(() => child.kill('SIGKILL'), 1000)
        unconfirmedTimer = setTimeout(() => {
          uncertainAcquisition = true
          killedFor = 'CLI termination unconfirmed after forced kill; inspect owned resources'
          child.stdout.destroy(); child.stderr.destroy(); child.unref()
          finish(null)
        }, 5000)
      }
      const abort = () => kill('aborted')
      const timer = setTimeout(() => kill('timeout'), limit)
      if (!cleanup) {
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      }
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.on('error', error => { killedFor ??= error.message })
      child.on('close', finish)
    })
  }
  const request = async (url, options = {}, expectedStatus = 200) => docker(['exec', names.sink, 'node', '-e',
    'fetch(' + JSON.stringify(url) + ',{...' + JSON.stringify(options)
    + ',signal:AbortSignal.timeout(4000)}).then(async r=>{const t=await r.text();if(r.status!=='+ expectedStatus +')throw Error(r.status+":"+t);process.stdout.write(t)})'])
  const json = async url => JSON.parse(await request(url))
  const sink = () => json('http://localhost:8080/events')
  const query = expr => json('http://prometheus:9090/api/v1/query?query=' + encodeURIComponent(expr))
  const beats = snapshot => snapshot.events.filter(e => e.kind === 'sns-publish' && e.topic === HEARTBEAT)
  const notifications = snapshot => snapshot.events.filter(e => e.kind === 'sns-publish' && e.topic === NOTIFICATION)
  async function until(predicate, durationMs, message) {
    const end = Math.min(deadline, Date.now() + durationMs)
    while (Date.now() < end) {
      check()
      const result = await predicate()
      if (result) return result
      await sleep(1000, undefined, { signal })
    }
    throw new Error(message)
  }
  const postAlert = async (alertname, deployment = owner) => {
    const now = Date.now()
    await request('http://alertmanager:9093/api/v2/alerts', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ labels: { alertname, severity: 'page', deployment },
        startsAt: new Date(now - 1000).toISOString(), endsAt: new Date(now + 300000).toISOString() }]) })
  }
  const start = async (name, image, command, mounts, alias) => {
    await docker(['create', '--name', name, '--network', names.network, '--label', label,
      '--network-alias', alias, ...mounts.flatMap(([source, target]) => ['-v', source + ':' + target + ':ro']), image, ...command], { timeoutMs: 45000 })
    const [created] = JSON.parse(await docker(['inspect', name]))
    for (const mount of created.Mounts) if (mount.Type === 'volume') volumes.add(mount.Name)
    assert.equal(Object.keys(created.HostConfig.PortBindings ?? {}).length, 0)
    await docker(['start', name])
  }
  let failure
  try {
    dockerContext = await docker(['context', 'show'])
    assert.ok(dockerContext)
    report.docker = { context: dockerContext, daemonId: await docker(['info', '--format', '{{.ID}}']) }
    const empty = path.join(directory, 'empty.env')
    await writeFile(empty, '')
    const config = JSON.parse(await docker(['compose', '--env-file', empty, '-f', path.join(ROOT, 'compose.maplespire.yml'), '--profile', 'alerting',
      'config', '--no-env-resolution', '--format', 'json']))
    for (const file of ['compose.maplespire.yml', 'infra/monitoring/prometheus.yml', 'infra/monitoring/alerts.yml', 'infra/monitoring/deadman-contract.json', 'scripts/fixtures/alerting-delivery-sink.mjs']) {
      report.sources[file] = hash(await readFile(path.join(ROOT, file)))
    }
    const promSource = await readFile(path.join(ROOT, 'infra/monitoring/prometheus.yml'), 'utf8')
    const rulesSource = await readFile(path.join(ROOT, 'infra/monitoring/alerts.yml'), 'utf8')
    const job = promSource.match(/  - job_name: alertmanager\n[\s\S]*?(?=  - job_name:)/)?.[0]
    assert.ok(job, 'Shipped Alertmanager scrape job missing')
    let prom = promSource.split('scrape_configs:')[0] + 'scrape_configs:\n' + job
    if (arm === 'without-alerting') prom = prom.replace(/^alerting:\n[\s\S]*?(?=^scrape_configs:)/m, '')
    let am = config.configs.alertmanager.content
    assert.equal((am.match(/      - topic_arn:/g) ?? []).length, 2)
    assert.ok(!am.includes('api_url:'), 'Review new production transport customization')
    am = am.replaceAll('      - topic_arn:', '      - api_url: http://sink:8080\n        topic_arn:')
    assert.ok(am.includes("smarthost: 'email-smtp.ca-central-1.amazonaws.com:587'"))
    am = am.replace("smarthost: 'email-smtp.ca-central-1.amazonaws.com:587'", "smarthost: 'sink:1025'")
    const selected = ruleGroups(rulesSource).filter(g => ['maplespire-meta', 'maplespire-alert-delivery'].includes(g.name))
    assert.equal(selected.length, 2)
    const ruleFile = path.join(directory, 'rules.yml')
    const copies = { 'am.yml': am, 'prom.yml': prom, 'rules.yml': 'groups:\n' + selected.map(g => g.text).join('') }
    for (const [file, content] of Object.entries(copies)) {
      await writeFile(path.join(directory, file), content)
      report.copies[file] = hash(content)
    }
    await writeFile(path.join(directory, 'rules-initial.yml'), copies['rules.yml'])
    report.copies['rules-initial.yml'] = hash(copies['rules.yml'])
    report.transformations = ['Fake Compose environment and empty env file',
      'Only Watchdog and SMTP-delivery rule groups; only Alertmanager scrape',
      'SNS API URL -> local sink; SMTP host -> local 421 server; TLS requirement unchanged',
      ...(arm === 'without-alerting' ? ['Remove alerting block from this Prometheus copy'] : [])]
    report.images = { prometheus: config.services.prometheus.image, alertmanager: config.services.alertmanager.image, sink: 'node:22-alpine' }
    await docker(['network', 'create', '--internal', '--label', label, names.network])
    const [network] = JSON.parse(await docker(['network', 'inspect', names.network]))
    assert.equal(network.Internal, true)
    await start(names.sink, report.images.sink, ['node', '/sink.mjs'],
      [[path.join(ROOT, 'scripts/fixtures/alerting-delivery-sink.mjs'), '/sink.mjs']], 'sink')
    const readyRequest = async url => { try { return await request(url) } catch (error) { check(); record('readiness-retry', { message: error.message.slice(0, 180) }); return false } }
    await until(() => readyRequest('http://localhost:8080/events'), 25000, 'Sink not ready')
    await start(names.am, report.images.alertmanager, config.services.alertmanager.command.map(x =>
      x.startsWith('--config.file=') ? '--config.file=/config.yml' : x.startsWith('--storage.path=') ? '--storage.path=/tmp/am' : x),
    [[path.join(directory, 'am.yml'), '/config.yml']], 'alertmanager')
    await start(names.prom, report.images.prometheus, config.services.prometheus.command.map(x =>
      x.startsWith('--config.file=') ? '--config.file=/config.yml' : x.startsWith('--storage.tsdb.path=') ? '--storage.tsdb.path=/tmp/prom' : x),
    [[path.join(directory, 'prom.yml'), '/config.yml'], [ruleFile, '/etc/prometheus/alerts.yml']], 'prometheus')
    await until(() => readyRequest('http://prometheus:9090/-/ready'), 45000, 'Prometheus not ready')
    await until(() => readyRequest('http://alertmanager:9093/-/ready'), 20000, 'Alertmanager not ready')
    const initialSink = await sink()
    const bootId = initialSink.bootId
    const alive = async () => {
      assert.equal((await sink()).bootId, bootId, 'Collector restarted')
      assert.ok(await request('http://prometheus:9090/-/ready'))
      assert.ok(await request('http://alertmanager:9093/-/ready'))
    }
    // Prometheus 3.1.0 sends alerts during restoration but writes ALERTS samples
    // only afterward (rules/group.go run; alerting.go Eval). With 15s ticks,
    // series availability can exceed 40s. Observe the rule itself at startup;
    // later delivery and the silent-arm query remain independent witnesses.
    await until(async () => {
      const groups = (await json('http://prometheus:9090/api/v1/rules')).data.groups
      const rules = groups.flatMap(group => group.rules).filter(rule => rule.name === 'Watchdog')
      report.lastWatchdogRules = rules
      return rules.length === 1 && rules[0].health === 'ok' && rules[0].state === 'firing'
        && rules[0].alerts.length === 1 && Number(rules[0].alerts[0].value) === 1
    }, 40000, 'No live Watchdog')
    const observedReadyAt = Date.now()
    record('ready', { collectorBootId: bootId })
    if (arm === 'without-alerting') {
      const discovery = await json('http://prometheus:9090/api/v1/alertmanagers')
      assert.equal(discovery.data.activeAlertmanagers.length, 0)
      await sleep(80000, undefined, { signal })
      await alive()
      assert.ok(Date.now() - observedReadyAt >= 80000, 'Silent-arm exposure shorter than 80 seconds')
      const witness = await query('ALERTS{alertname="Watchdog",alertstate="firing"}')
      assert.equal(witness.data.result.length, 1)
      assert.equal(witness.data.result[0].value[1], '1')
      assert.equal((await sink()).events.length, 0, 'Silent arm delivered something')
      record('silent-arm-observed', { elapsedMs: Date.now() - observedReadyAt, witness: witness.data.result })
      await postAlert('AlertmanagerEmailDeliveryFailed', 'negative-arm-positive-control')
      await until(async () => notifications(await sink()).some(e => e.message.includes('negative-arm-positive-control')), 20000, 'Silent-arm collector had no positive control')
      assert.equal((await sink()).bootId, bootId)
      record('silent-arm-positive-control')
    } else {
      // A healthy rule is not yet a delivered notification. Cold startup can
      // precede the first SNS publication by 45s (measured). Bound startup and
      // cadence separately, using event timestamps, not the polling instant.
      // The 5s read margin stays inside the arm budget and cannot admit a late
      // publication: the physical deadlines are asserted below.
      const firstSnapshot = await until(async () => { const s = await sink(); return beats(s).length > 0 && s },
        Math.max(1, observedReadyAt + 65000 + 5000 - Date.now()), 'No initial native Watchdog publication')
      const firstPublication = beats(firstSnapshot)[0]
      const firstAt = Date.parse(firstPublication.at)
      assert.ok(Number.isFinite(firstAt) && firstAt <= observedReadyAt + 65000, 'Watchdog startup publication exceeded 65 seconds')
      record('native-watchdog-startup', { publicationAt: firstPublication.at, relativeToReadyMs: firstAt - observedReadyAt })
      const snapshot = await until(async () => { const s = await sink(); return beats(s).length >= 3 && s },
        Math.max(1, firstAt + 130000 + 5000 - Date.now()), 'Fewer than three native Watchdog publications')
      assert.equal(snapshot.events.filter(e => e.kind === 'smtp-refusal').length, 0, 'Watchdog reached SMTP')
      assert.equal(notifications(snapshot).length, 0, 'Watchdog reached notification topic')
      assert.equal(snapshot.events.filter(e => e.kind === 'sns-rejected').length, 0)
      const first = beats(snapshot).slice(0, 3)
      assert.ok(Date.parse(first[2].at) - firstAt <= 130000, 'Third Watchdog publication exceeded two 65-second intervals')
      const intervalsMs = first.slice(1).map((e, i) => Date.parse(e.at) - Date.parse(first[i].at))
      for (const ms of intervalsMs) assert.ok(ms >= 55000 && ms <= 65000, 'Watchdog cadence outside 55-65 seconds: ' + ms)
      record('native-watchdog-cadence', { intervalsMs })
      await postAlert('DeliveryGateSmtpRefusal')
      const delivered = await until(async () => {
        const s = await sink()
        const notification = notifications(s).find(e => e.message.includes('alertname = AlertmanagerEmailDeliveryFailed'))
        return notification && { s, notification }
      }, 145000, 'No SNS publication after native SMTP refusal')
      const refusal = delivered.s.events.find(e => e.kind === 'smtp-refusal')
      assert.ok(refusal)
      const latencyMs = Date.parse(delivered.notification.at) - Date.parse(refusal.at)
      assert.ok(latencyMs >= 0 && latencyMs < 95000, 'Failure path latency exceeds 95 seconds: ' + latencyMs)
      const metrics = await request('http://alertmanager:9093/metrics')
      assert.ok(counter(metrics, 'alertmanager_notification_requests_failed_total', 'email') > 0)
      assert.equal(counter(metrics, 'alertmanager_notifications_failed_total', 'email'), 0, 'Signal waited for terminal retries')
      const firing = (await query('ALERTS{alertname="AlertmanagerEmailDeliveryFailed",alertstate="firing"}')).data.result
      assert.equal(firing.length, 1)
      record('smtp-failure-notification', { refusalAt: refusal.at, publicationAt: delivered.notification.at, latencyMs })
      const continuing = await until(async () => {
        const current = await sink()
        return beats(current).some(e => Date.parse(e.at) > Date.parse(refusal.at)) && current
      }, Math.max(1000, Date.parse(refusal.at) + 65000 - Date.now()), 'Watchdog stopped during SMTP retries')
      const continuingBeats = beats(continuing)
      assert.ok(Date.now() - Date.parse(continuingBeats.at(-1).at) <= 65000, 'Watchdog stale before deliberate removal')
      for (let i = 1; i < continuingBeats.length; i++) {
        const interval = Date.parse(continuingBeats[i].at) - Date.parse(continuingBeats[i - 1].at)
        assert.ok(interval >= 55000 && interval <= 65000, 'Watchdog cadence broke during SMTP retries: ' + interval)
      }
      const remaining = selected.filter(g => g.name !== 'maplespire-meta')
      const removedAt = new Date().toISOString()
      const removedRules = 'groups:\n' + remaining.map(g => g.text).join('')
      await writeFile(ruleFile, removedRules)
      report.copies['rules.yml'] = hash(removedRules)
      report.copies['rules-after-removal.yml'] = hash(removedRules)
      await writeFile(path.join(directory, 'rules-after-removal.yml'), removedRules)
      await docker(['kill', '--signal', 'HUP', names.prom])
      await until(async () => {
        const groups = (await json('http://prometheus:9090/api/v1/rules')).data.groups
        return groups.length === 1 && groups[0].name === 'maplespire-alert-delivery'
      }, 15000, 'Watchdog removal was not loaded')
      record('watchdog-removed', { requestedAt: removedAt })
      await sleep(140000, undefined, { signal })
      await alive()
      const expired = await sink()
      const priorBeats = beats(expired)
      assert.ok(Date.now() - Date.parse(removedAt) >= 140000, 'Expiry exposure shorter than 140 seconds')
      assert.ok(Date.now() - Date.parse(priorBeats.at(-1).at) >= 75000, 'Heartbeat silence shorter than 75 seconds')
      assert.ok(Date.parse(priorBeats.at(-1).at) - Date.parse(removedAt) <= 65000, 'Watchdog publication outlived its 60s validity lease')
      for (const e of priorBeats) {
        assert.match(e.message, /alertname = Watchdog/)
        assert.match(e.message, /severity = watchdog/)
        assert.match(e.message, /Alerts Firing:/, 'Resolved Watchdog fed the heartbeat')
        assert.doesNotMatch(e.message, /Alerts Resolved:/)
      }
      await postAlert('AlertmanagerEmailDeliveryFailed', 'expiry-positive-control')
      await until(async () => notifications(await sink()).some(e => e.message.includes('expiry-positive-control')), 20000, 'No independent delivery after expiry')
      const controlled = await sink()
      assert.equal(controlled.bootId, bootId)
      assert.equal(beats(controlled).length, priorBeats.length)
      assert.equal(controlled.events.filter(e => e.kind === 'sns-rejected').length, 0)
      record('expiry-positive-control', { lastWatchdogAt: priorBeats.at(-1).at, publications: priorBeats.length, collectorBootId: bootId })
    }
    // Exercise the fixture's own AWS boundary, after the scenario's quiet
    // windows. Successful short subjects alone cannot detect a permissive sink.
    for (const length of [99, 100, 102]) {
      await request('http://localhost:8080/', { method: 'POST', headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'AWS4-HMAC-SHA256 Credential=AKIAABCDEFGHIJKLMNOP/fixture',
      }, body: new URLSearchParams({ Action: 'Publish', TopicArn: NOTIFICATION,
        Message: 'collector-subject-control-' + length, Subject: 'x'.repeat(length) }).toString() }, length < 100 ? 200 : 400)
    }
    report.sink = await sink()
    assert.equal(report.sink.bootId, bootId)
    for (const length of [99, 100, 102]) {
      const event = report.sink.events.find(e => e.message === 'collector-subject-control-' + length)
      assert.equal(event?.kind, length < 100 ? 'sns-publish' : 'sns-rejected')
    }
    record('collector-subject-boundary', { acceptedLength: 99, rejectedLengths: [100, 102] })
    report.verdict = 'passed'
  } catch (error) {
    failure = error
    report.verdict = 'failed'
    report.error = error.message
    try { report.sink = await sink() } catch { /* Primary failure already retained; cleanup owns resources. */ }
    try { report.rulesAtFailure = await json('http://prometheus:9090/api/v1/rules') } catch { /* The failure may precede startup. */ }
  } finally {
    clearTimeout(executionTimer)
    cleanupDeadline = Date.now() + 60000
    const errors = []
    let ids = []
    const cleanupStep = async action => { try { await action() } catch (error) { errors.push(error.message) } }
    await cleanupStep(async () => {
      assert.ok(report.docker?.daemonId, 'No initial daemon identity; cleanup cannot be certified')
      assert.equal(await docker(['info', '--format', '{{.ID}}'], { cleanup: true }), report.docker.daemonId, 'Docker daemon changed')
    })
    await cleanupStep(async () => {
      ids = (await docker(['ps', '-aq', '--filter', 'label=' + label], { cleanup: true })).split(/\s+/).filter(Boolean)
      assert.ok(ids.every(id => /^[a-f0-9]{12,64}$/.test(id)))
    })
    // Discovery by our unique owner label authorizes deletion even if a later
    // inspect fails. Preserve that error but still attempt release and proof.
    if (ids.length) {
      await cleanupStep(async () => {
        for (const c of JSON.parse(await docker(['inspect', ...ids], { cleanup: true }))) {
          assert.equal(c.Config.Labels['maplespire.qa.owner'], owner)
          for (const m of c.Mounts) if (m.Type === 'volume') volumes.add(m.Name)
        }
      })
      await cleanupStep(() => docker(['rm', '-f', '-v', ...ids], { cleanup: true, timeoutMs: 30000 }))
    }
    await cleanupStep(async () => {
      assert.equal(await docker(['ps', '-aq', '--filter', 'label=' + label], { cleanup: true }), '')
    })
    await cleanupStep(async () => {
      const networks = (await docker(['network', 'ls', '-q', '--filter', 'label=' + label], { cleanup: true })).split(/\s+/).filter(Boolean)
      if (networks.length) await docker(['network', 'rm', ...networks], { cleanup: true })
    })
    await cleanupStep(async () => {
      assert.equal(await docker(['network', 'ls', '-q', '--filter', 'label=' + label], { cleanup: true }), '')
    })
    await cleanupStep(async () => {
      const currentVolumes = new Set((await docker(['volume', 'ls', '--format', '{{.Name}}'], { cleanup: true })).split('\n'))
      for (const volume of volumes) assert.ok(!currentVolumes.has(volume), 'Owned anonymous volume remains: ' + volume)
    })
    if (uncertainAcquisition) errors.push('Docker acquisition timed out/aborted: daemon completion uncertain; no clean verdict')
    report.cleanup = { verified: errors.length === 0, anonymousVolumes: [...volumes], errors }
    if (errors.length) { report.verdict = 'failed'; failure = new AggregateError([...(failure ? [failure] : []), ...errors.map(e => new Error(e))], 'Delivery arm cleanup failed') }
    report.finishedAt = new Date().toISOString()
    try {
      await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n')
      console.log('ALERT_DELIVERY_ARM ' + JSON.stringify({ arm, verdict: report.verdict, cleanupVerified: report.cleanup.verified, evidence: path.relative(ROOT, path.join(directory, 'result.json')).replaceAll('\\', '/') }))
    } finally {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', interrupt)
    }
  }
  if (failure) throw failure
  return report
}
