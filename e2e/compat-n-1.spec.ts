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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { CompatDoor } from './support/compatDoor'

/**
 * N-1 <-> N compatibility harness (V0-09). Run through
 * `node scripts/compat-n-1.mjs`, which builds the N-1 bundle and stands up the
 * stack this needs; see `playwright.compat.config.ts`.
 *
 * Two real client builds against one server:
 *  - N   = THIS checkout, as a Vite dev server, behind the door on COMPAT_N_PORT;
 *  - N-1 = the production bundle in `.n-minus-1/` (`compat-build.json` names
 *          its commit), behind the door on COMPAT_N1_PORT.
 *
 * THE PROBE. The N client writes a field no build knows, `x-compat-probe`,
 * through its OWN Automerge handles, onto two entities of the open diagram:
 *  - its REGISTRY entry (`RegistryShard.diagrams[id]`) — the decisive site.
 *    Every client rebuilds that entry from a whitelist (`buildMeta` in
 *    bridge.ts), so a reconcile that deletes every key its target lacks
 *    deletes the probe on the first rename. That is the V0-08 defect class;
 *  - its DiagramDoc, top level — a site where the store spreads the document
 *    back into the reconcile target (`diagramDocToDiagram`), so the field is
 *    carried through even by the old reconcile. Reported, as the contrast.
 * Because the field is unknown to EVERY build, any N-1 at all is an
 * "older-schema client" with respect to it.
 *
 * THE HOOK. No hook exposes a DocHandle. The N client is a Vite dev server, so
 * the spec imports `/src/lib/automerge/repo.ts` by the URL the app itself
 * loaded it under: one ES module record per URL, i.e. the app's own `repo`.
 * The guard against a second instance (the trap `bridge.ts` documents for
 * store imports after an HMR pass) is that the module's repo already holds
 * the app's handles — a fresh instance would hold none. No app code changed.
 *
 * ORDERING, because a CRDT delete only removes what the deleting peer has
 * SEEN: the probe is confirmed on the SERVER (a fresh N context with an empty
 * IndexedDB reads it back) before the N-1 client is even opened. Without
 * that, an N-1 that never received the probe could not delete it, and a
 * broken reconcile would pass.
 */

const env = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set — run this spec through node scripts/compat-n-1.mjs`)
  return value
}
const BACKEND = env('COMPAT_BACKEND')
const N_DEV = env('COMPAT_N_DEV')
const N1_DIR = env('COMPAT_N1_DIR')
const N1_PORT = Number(env('COMPAT_N1_PORT'))
const N_PORT = Number(env('COMPAT_N_PORT'))
const PROBE = 'x-compat-probe'

const n1Build = JSON.parse(readFileSync(path.join(N1_DIR, 'compat-build.json'), 'utf8')) as { sha: string; ref: string; subject: string }

let n1Door: CompatDoor
let nDoor: CompatDoor
let nContext: BrowserContext
let n: Page
let diagramPath: string

type ProbeRead = { diagramId: string; metaName: string | null; registry: unknown; diagramDoc: unknown; storeName: string | null }

/** Open the app on `origin` and wait for the canvas editor. Returns the
 *  diagram path the address bar settled on. */
async function enterApp(page: Page, url: string): Promise<string> {
  await page.goto(url)
  const start = page.getByRole('button', { name: /Start designing free/ }).first()
  // The landing page or the editor, whichever this build shows first.
  await expect(start.or(page.getByTestId('diagram-name'))).toBeVisible({ timeout: 60_000 })
  if (await start.isVisible().catch(() => false)) await start.click()
  await expect(page.getByTestId('diagram-name')).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toMatch(/\/diagram\//)
  return new URL(page.url()).pathname
}

/** Write (`value` given) and/or read the probe through the N client's OWN
 *  Automerge handles. Only valid on a page served by the N dev server. */
async function nProbe(page: Page, value?: string): Promise<ProbeRead> {
  return page.evaluate(async ({ key, value }) => {
    type Handle = { doc(): Record<string, unknown> | undefined; change(fn: (d: Record<string, unknown>) => void): void }
    const mod = await import(/* @vite-ignore */ `${location.origin}/src/lib/automerge/repo.ts`) as {
      repo: { handles: Record<string, Handle> }
    }
    const handles = Object.values(mod.repo.handles)
    if (handles.length === 0) throw new Error('repo.ts resolved to a SECOND module instance (it holds no handles)')
    const w = window as unknown as {
      __modelStore: { getState(): { currentDiagramId: string | null; diagrams: Array<{ id: string; name: string }> } }
      __diagramDocUrl(id: string): string | undefined
    }
    const state = w.__modelStore.getState()
    const diagramId = state.currentDiagramId
    if (!diagramId) throw new Error('no current diagram')
    const shard = handles.find((h) => {
      const diagrams = h.doc()?.diagrams as Record<string, unknown> | undefined
      return !!diagrams && typeof diagrams === 'object' && diagramId in diagrams
    })
    if (!shard) throw new Error(`no loaded registry shard holds ${diagramId}`)
    const docUrl = w.__diagramDocUrl(diagramId)
    const diagramHandle = docUrl ? mod.repo.handles[docUrl.replace(/^automerge:/, '')] : undefined
    if (!diagramHandle) throw new Error(`the DiagramDoc of ${diagramId} is not loaded (${docUrl})`)
    if (value !== undefined) {
      shard.change((d) => { (d.diagrams as Record<string, Record<string, unknown>>)[diagramId][key] = value })
      diagramHandle.change((d) => { d[key] = value })
    }
    const meta = (shard.doc()!.diagrams as Record<string, Record<string, unknown>>)[diagramId]
    return {
      diagramId,
      metaName: typeof meta.name === 'string' ? meta.name : null,
      registry: meta[key] ?? null,
      diagramDoc: diagramHandle.doc()?.[key] ?? null,
      storeName: state.diagrams.find((d) => d.id === diagramId)?.name ?? null,
    }
  }, { key: PROBE, value })
}

/** The probe as the SERVER holds it: a brand-new N context (empty IndexedDB)
 *  boots the same diagram and reads it back. */
async function probeOnServer(browser: Browser): Promise<ProbeRead> {
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await enterApp(page, nDoor.origin + diagramPath)
    // The registry and the DiagramDoc both arrive by sync; wait until the
    // entry this spec writes is there at all before reading the probe.
    let read: ProbeRead | null = null
    await expect.poll(async () => {
      read = await nProbe(page).catch(() => null)
      return read?.metaName ?? null
    }, { timeout: 30_000 }).not.toBeNull()
    return read!
  } finally {
    await context.close()
  }
}

async function injectAndConfirm(browser: Browser, value: string): Promise<void> {
  const written = await nProbe(n, value)
  expect(written.registry, 'the N client could not write the probe into its own registry shard').toBe(value)
  expect(written.diagramDoc).toBe(value)
  await expect.poll(async () => {
    const seen = await probeOnServer(browser)
    return [seen.registry, seen.diagramDoc]
  }, { timeout: 60_000, message: 'the probe never reached the server, so the N-1 client could not have seen it' })
    .toEqual([value, value])
}

async function renameIn(page: Page, name: string): Promise<void> {
  const field = page.getByTestId('diagram-name')
  await field.fill(name)
  await field.blur()
  await expect(field).toHaveValue(name)
}

/** The verdict, for both sites, once N has received the N-1 rename. */
async function expectProbeKept(value: string, renamed: string, label: string): Promise<void> {
  await expect.poll(async () => (await nProbe(n)).metaName, {
    timeout: 60_000, message: `${label}: the N-1 rename never reached the N client`,
  }).toBe(renamed)
  const read = await nProbe(n)
  const line = `${label}: registry=${JSON.stringify(read.registry)} diagramDoc=${JSON.stringify(read.diagramDoc)} (wrote ${value})`
  test.info().annotations.push({ type: 'probe', description: line })
  console.log(`[compat] N-1 ${n1Build.sha.slice(0, 10)} ${line}`)
  expect.soft(read.diagramDoc, `${label}: DiagramDoc probe lost`).toBe(value)
  expect(read.registry, `${label}: the N-1 client's write DELETED the registry probe it does not know`).toBe(value)
}

async function openN1(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await enterApp(page, n1Door.origin + diagramPath)
  return { context, page }
}

// NOT serial: in the RED control every scenario must report on its own,
// not be skipped behind the first loss. Each test injects its own probe.
test.describe.configure({ mode: 'default' })

test.beforeAll(async ({ browser }) => {
  n1Door = new CompatDoor({ port: N1_PORT, backend: BACKEND, target: { kind: 'static', dir: N1_DIR } })
  nDoor = new CompatDoor({ port: N_PORT, backend: BACKEND, target: { kind: 'proxy', origin: N_DEV } })
  await Promise.all([n1Door.listen(), nDoor.listen()])
  nContext = await browser.newContext()
  n = await nContext.newPage()
  diagramPath = await enterApp(n, nDoor.origin + '/')
  test.info().annotations.push({ type: 'n-1', description: `${n1Build.sha.slice(0, 10)} (${n1Build.ref}): ${n1Build.subject}` })
})

test.afterAll(async () => {
  await nContext?.close()
  await Promise.all([n1Door?.close(), nDoor?.close()])
})

test('online: an N-1 rename keeps the fields only N knows', async ({ browser }) => {
  const value = `online-${Date.now()}`
  await injectAndConfirm(browser, value)
  const { context, page } = await openN1(browser)
  try {
    const renamed = `compat-online-${Date.now()}`
    await renameIn(page, renamed)
    await expectProbeKept(value, renamed, 'online')
  } finally {
    await context.close()
  }
})

test('offline then replayed: an N-1 rename made without the server keeps them too', async ({ browser }) => {
  const value = `offline-${Date.now()}`
  await injectAndConfirm(browser, value)
  const { context, page } = await openN1(browser)
  try {
    n1Door.setOffline(true)
    const renamed = `compat-offline-${Date.now()}`
    await renameIn(page, renamed)
    // Proof the edit really was offline: it must NOT reach N while the door is shut.
    await page.waitForTimeout(3_000)
    expect((await nProbe(n)).metaName, 'the offline rename reached N: the client was not offline').not.toBe(renamed)
    n1Door.setOffline(false)
    await expectProbeKept(value, renamed, 'offline-replay')
  } finally {
    n1Door.setOffline(false)
    await context.close()
  }
})

test('IndexedDB upgrade: N opens the databases N-1 wrote and replays its offline edit', async ({ browser }) => {
  const value = `idb-${Date.now()}`
  await injectAndConfirm(browser, value)
  const { context, page } = await openN1(browser)
  try {
    n1Door.setOffline(true)
    const renamed = `compat-idb-${Date.now()}`
    await renameIn(page, renamed)
    // Long enough for automerge-repo's debounced IndexedDB save.
    await page.waitForTimeout(3_000)
    const n1Databases = await page.evaluate(async () =>
      (await indexedDB.databases()).map((db) => `${db.name}@${db.version}`).sort())
    await page.close()
    expect((await nProbe(n)).metaName, 'the offline rename reached the server before the upgrade').not.toBe(renamed)

    // The SAME origin now serves N — a deploy — and the backend comes back.
    n1Door.setTarget({ kind: 'proxy', origin: N_DEV })
    n1Door.setOffline(false)
    const upgraded = await context.newPage()
    await enterApp(upgraded, n1Door.origin + diagramPath)
    const nDatabases = await upgraded.evaluate(async () =>
      (await indexedDB.databases()).map((db) => `${db.name}@${db.version}`).sort())
    const databases = `N-1 wrote [${n1Databases.join(', ')}]; N opened [${nDatabases.join(', ')}]`
    test.info().annotations.push({ type: 'indexeddb', description: databases })
    console.log(`[compat] ${databases}`)
    // The rename lives ONLY in the IndexedDB the N-1 build wrote: the server
    // never received it. N finding it — here and on the other client — is N
    // reading N-1's storage and replaying it.
    await expect.poll(async () => (await nProbe(upgraded)).metaName, {
      timeout: 60_000, message: 'N, booted on the N-1 IndexedDB, does not show the offline N-1 rename',
    }).toBe(renamed)
    await expectProbeKept(value, renamed, 'indexeddb-upgrade')
  } finally {
    n1Door.setOffline(false)
    n1Door.setTarget({ kind: 'static', dir: N1_DIR })
    await context.close()
  }
})
