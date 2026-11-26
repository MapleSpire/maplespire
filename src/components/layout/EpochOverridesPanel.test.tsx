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

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEpochOverridesStore } from '../../stores/epochOverridesStore'
import { useEpochHopStore } from '../../stores/epochHopStore'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { undoHistory } from '../../lib/history/undoHistory'
import type { OverrideRow } from '../../lib/automerge/epochOverrides'

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, o?: Record<string, unknown>) => (o?.value !== undefined ? `${key}:${String(o.value)}` : key),
    i18n: { language: 'en' },
  }),
}))

const resolveCalls: unknown[] = []
let revertGate: Promise<void> | null = null
/** The server's pending rows: a resolve takes rows out, a revert puts them back. */
let serverRows: OverrideRow[] = []
let allRows: OverrideRow[] = []
vi.mock('../../lib/automerge/epochOverrides', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/automerge/epochOverrides')>(),
  fetchOverrides: vi.fn(async () => { fetches += 1; return serverRows }),
  resolveOverrides: vi.fn(async (request: { revert?: string; reapplied?: string[]; dismissed?: string[] }) => {
    resolveCalls.push(request)
    // A revert that never returns: the tab "crashes" before it does.
    if (request.revert && revertGate) await revertGate
    if (request.revert) serverRows = allRows
    else serverRows = serverRows.filter((r) => !request.reapplied?.includes(r.id) && !request.dismissed?.includes(r.id))
    return { reapplied: 0, dismissed: 0, reverted: 0 }
  }),
}))

const kv = new Map<string, unknown>()
/** What "another tab" does while this one awaits its journal write. */
let duringJournalWrite: (() => void) | null = null
vi.mock('../../lib/modelQuery/kvStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/modelQuery/kvStore')>(),
  workspaceKvStore: () => ({
    get: async (key: string) => kv.get(key),
    set: async (key: string, value: unknown) => { kv.set(key, value) },
    del: async (key: string) => { kv.delete(key) },
    // Atomic, as the real one (one IndexedDB readwrite transaction).
    update: async (key: string, updater: (old: unknown) => unknown) => {
      kv.set(key, updater(kv.get(key)))
      const other = duringJournalWrite
      duringJournalWrite = null
      other?.()
    },
  }),
}))

const JOURNAL = 'epoch-reapply-batches:v2'
/** The journal's slots, batch id → journaled batch. */
const journal = () => (kv.get(JOURNAL) ?? {}) as Record<string, { batchId: string; attempts?: number; carriers?: unknown }>

const { EpochOverridesPanel } = await import('./EpochOverridesPanel')
const controller = await import('../../lib/automerge/epochOverridesController')

/** G4-16f: the review panel, rendered — all checked by
 * default, uncheckable, changed-since pulled out, undo reverting the rows. */
const row = (id: string, entity: string, field: string, late: string, current: string): OverrideRow => ({
  id, entityKind: 'object', entityId: entity, path: ['objects', entity, field], reason: 'leaf', lateValue: late,
  currentValueAtForward: current, currentHeadsAtForward: ['h'], targetDoc: 'T', state: 'pending', createdAt: '2026-11-14T00:00:00Z',
})

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const msg = (n: number) => JSON.stringify({ reapplyBatch: uuid(n) })

const flushed: string[] = []
let durable: (carriers: readonly string[]) => Promise<boolean> = async () => true
let uuidCounter = 0
let uninstall: () => void = () => undefined
const host = { scope: () => 'test', apply: vi.fn(() => ({ applied: new Map([['k', {}]]) as never, skipped: 0 })) }

const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

// The bridge, as the ports see it: configurable per test.
let writable = true
let localChanges: Array<{ documentId: string; actor: string }> = []
let carriersOwed = false
/** What "another tab" does while the recovery checks durability. */
let onCarriersDurable: (() => void) | null = null
let serverHasCarriers: boolean | 'retired' = false
/** What each `serverHolds` was asked (the journaled heads, not the current ones). */
const serverHoldsAsked: unknown[] = []
/** The documents the tagged flush wrote (empty: it wrote nothing). */
let flushCarriers = ['carrier-doc']
let fetches = 0
/** The journal as the tagged flush found it. */
let journalAtFlush: Record<string, { reapplied?: string[] }> | null = null
const carrierHeads = (ids: readonly string[]) => ids.map((documentId) => ({ documentId, heads: ['h-after-flush'] }))
const ports = () => ({
  actorIds: () => ['aa'],
  writable: () => writable,
  flushPending: () => undefined,
  flushTagged: (message: string) => { flushed.push(message); journalAtFlush = JSON.parse(JSON.stringify(journal())); return [...flushCarriers] },
  whenDurable: (carriers: readonly string[]) => durable(carriers),
  changesWithMessage: () => localChanges,
  carriersDurable: () => { onCarriersDurable?.(); return !carriersOwed },
  carrierHeads,
  serverHolds: async (heads: ReadonlyArray<{ documentId: string; heads: string[] }>) => { serverHoldsAsked.push(heads); return serverHasCarriers },
})

describe('EpochOverridesPanel', () => {
  beforeEach(async () => {
    resolveCalls.length = 0
    flushed.length = 0
    kv.clear()
    uuidCounter = 0
    durable = async () => true
    host.apply.mockClear()
    undoHistory.clear()
    undoHistory.configure(host as never)
    useModelStore.setState({
      objects: [
        { id: 'y', name: 'Paul' } as never,
        { id: 'w', name: 'W', description: 'theirs' } as never,
        { id: 'u', name: 'U', status: 'deprecated' } as never,
      ],
    })
    allRows = [row('r-y', 'y', 'name', 'Marie', 'Paul'), row('r-w', 'w', 'description', 'mine', 'theirs'), row('r-u', 'u', 'status', 'live', 'deprecated')]
    serverRows = allRows
    useEpochOverridesStore.setState({
      rows: [],
      checked: new Set(), touched: new Set(), statuses: new Map(), pulled: new Set(), panelOpen: false, noticeCollapsed: false,
      highlight: false, busy: false, error: null, lastBatch: null, compact: false, refusal: null, lastDiscard: null,
    })
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => uuid(++uuidCounter) })
    writable = true
    localChanges = []
    carriersOwed = false
    onCarriersDurable = null
    serverHasCarriers = false
    serverHoldsAsked.length = 0
    flushCarriers = ['carrier-doc']
    revertGate = null
    duringJournalWrite = null
    useUIStore.setState({ rightSidebarOpen: true, leftSidebarOpen: true, canvasViewMode: '2d' })
    // A desktop window (jsdom's default 1024 is the NARROW editor).
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
    useEpochHopStore.setState({ retired: null })
    fetches = 0
    journalAtFlush = null
    uninstall = controller.installEpochOverrides(ports())
    await act(async () => { await controller.refreshOverrides() })
  })

  afterEach(() => {
    cleanup()
    uninstall()
    undoHistory.clear()
    undoHistory.configure(null)
    vi.unstubAllGlobals()
  })

  it('the notice opens a panel where EVERY row is checked by default, each uncheckable', async () => {
    render(<EpochOverridesPanel />)
    fireEvent.click(screen.getByTestId('epoch-overrides-review'))
    for (const id of ['r-y', 'r-w', 'r-u']) expect((screen.getByTestId(`override-check-${id}`) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByTestId('override-check-r-w'))
    expect((screen.getByTestId('override-check-r-w') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByTestId('override-yours-r-y').textContent).toBe('Marie')
    expect(screen.getByTestId('override-current-r-y').textContent).toBe('Paul')
  })

  it('a device with NO actor of its own asks with the session when signed in (the rows of her other devices), never signed out', async () => {
    const epochOverrides = await import('../../lib/automerge/epochOverrides')
    const fetch = vi.mocked(epochOverrides.fetchOverrides)
    for (const signedIn of [true, false]) {
      uninstall()
      fetch.mockClear()
      uninstall = controller.installEpochOverrides({ ...ports(), actorIds: () => [], signedIn: async () => signedIn })
      await act(async () => { await controller.refreshOverrides({ force: true }) })
      expect(fetch).toHaveBeenCalled()
      expect(fetch.mock.calls.every((call) => (call as unknown[])[2] === signedIn)).toBe(true)
    }
  })

  it('Review moves the focus into the panel; Escape closes it', async () => {
    render(<EpochOverridesPanel />)
    fireEvent.click(screen.getByTestId('epoch-overrides-review'))
    await act(async () => { await settle() })
    expect(screen.getByTestId('epoch-overrides-panel').contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(screen.getByTestId('epoch-overrides-panel'), { key: 'Escape' })
    expect(screen.queryByTestId('epoch-overrides-panel')).toBeNull()
  })

  it('Re-apply: a row changed since is pulled out and unchecked; the others are ONE tagged edit, then resolved by batch id', async () => {
    render(<EpochOverridesPanel />)
    fireEvent.click(screen.getByTestId('epoch-overrides-review'))
    fireEvent.click(screen.getByTestId('override-check-r-w'))
    // Paul edits U again after the notice.
    act(() => { useModelStore.getState().updateObject('u', { status: 'retired' } as never) })
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-reapply')) })
    await act(async () => { await settle() })
    expect(screen.getByTestId('override-changed-r-u').textContent).toContain('retired')
    expect((screen.getByTestId('override-check-r-u') as HTMLInputElement).checked).toBe(false)
    expect(useModelStore.getState().objects.find((o) => o.id === 'y')?.name).toBe('Marie')
    expect(useModelStore.getState().objects.find((o) => o.id === 'u')?.status).toBe('retired')
    expect(flushed).toEqual([msg(1)])
    expect(resolveCalls).toEqual([{ batchId: uuid(1), reapplied: ['r-y'], dismissed: ['r-w'] }])
  })

  it('ANOTHER TAB re-applied the same rows while this one awaited its journal — idempotent: nothing written twice, nothing resolved here, no alert; that tab resolves them', async () => {
    render(<EpochOverridesPanel />)
    fireEvent.click(screen.getByTestId('epoch-overrides-review'))
    // Marie's other tab, 300 ms ahead: its values arrive through the sync.
    duringJournalWrite = () => {
      useModelStore.getState().updateObject('y', { name: 'Marie' } as never)
      useModelStore.getState().updateObject('w', { description: 'mine' } as never)
      useModelStore.getState().updateObject('u', { status: 'live' } as never)
    }
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-reapply')) })
    await act(async () => { await settle() })
    expect(useEpochOverridesStore.getState().error).toBeNull()
    expect(useEpochOverridesStore.getState().refusal).toBeNull()
    expect(screen.queryAllByRole('alert')).toEqual([])
    expect(flushed).toEqual([]) // no tagged write: the values are the other tab's
    expect(resolveCalls).toEqual([]) // resolved by the tab that wrote them
    expect(journal()).toEqual({})
    expect(useModelStore.getState().objects.find((o) => o.id === 'y')?.name).toBe('Marie')
  })

  it('PART of the batch re-applied elsewhere — the rest is ONE tagged edit, resolved without the rows the other tab owns', async () => {
    render(<EpochOverridesPanel />)
    fireEvent.click(screen.getByTestId('epoch-overrides-review'))
    duringJournalWrite = () => { useModelStore.getState().updateObject('y', { name: 'Marie' } as never) }
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-reapply')) })
    await act(async () => { await settle() })
    expect(useEpochOverridesStore.getState().error).toBeNull()
    expect(flushed).toEqual([msg(1)])
    expect(resolveCalls).toEqual([{ batchId: uuid(1), reapplied: ['r-w', 'r-u'], dismissed: [] }])
    expect(useModelStore.getState().objects.find((o) => o.id === 'w')?.description).toBe('mine')
  })

  it('the rows re-applied ELSEWHERE leave this review (pulled, unchecked, touched, changed since), the journal names only this batch\'s rows from the replan on, and a refresh follows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      durable = async () => false // the slot stays: what it names is read after
      render(<EpochOverridesPanel />)
      fireEvent.click(screen.getByTestId('epoch-overrides-review'))
      duringJournalWrite = () => { useModelStore.getState().updateObject('y', { name: 'Marie' } as never) }
      await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-reapply')) })
      await act(async () => { await settle() })
      const s = useEpochOverridesStore.getState()
      expect(s.pulled.has('r-y')).toBe(true)
      expect(s.checked.has('r-y')).toBe(false)
      expect(s.touched.has('r-y')).toBe(true)
      expect(s.statuses.get('r-y')).toEqual({ kind: 'changed-since', now: 'Marie' })
      // The slot named this batch's rows only, already when the
      // tagged flush ran (a crash there recovers no row of the other tab).
      expect(journalAtFlush?.[uuid(1)]?.reapplied).toEqual(['r-w', 'r-u'])
      expect(journal()[uuid(1)]).toMatchObject({ reapplied: ['r-w', 'r-u'] })
      // The other tab's rows leave at a refresh, scheduled here.
      const before = fetches
      await act(async () => { vi.advanceTimersByTime(controller.ELSEWHERE_REFRESH_MS); await settle() })
      expect(fetches).toBe(before + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the view LEAVES the diagram during the journal\'s await — refused as "needs the diagram" BEFORE anything is written, the model unchanged', async () => {
    render(<EpochOverridesPanel />)
    fireEvent.click(screen.getByTestId('epoch-overrides-review'))
    duringJournalWrite = () => { undoHistory.configure({ ...host, scope: () => null } as never) }
    let result: unknown
    await act(async () => { result = await controller.reapplyChecked() })
    await act(async () => { await settle() })
    expect(result).toBeNull()
    expect(useEpochOverridesStore.getState().refusal).toBe('needsDiagram')
    const objects = useModelStore.getState().objects
    expect(objects.find((o) => o.id === 'y')?.name).toBe('Paul')
    expect(objects.find((o) => o.id === 'w')?.description).toBe('theirs')
    expect(objects.find((o) => o.id === 'u')?.status).toBe('deprecated')
    expect(flushed).toEqual([])
    expect(resolveCalls).toEqual([])
    expect(journal()).toEqual({})
  })

  it('a re-apply the undo history did not record is refused IN WORDS (localized, actionable) — nothing resolved, no journal left', async () => {
    const top = vi.spyOn(undoHistory, 'top').mockReturnValue(null)
    try {
      render(<EpochOverridesPanel />)
      fireEvent.click(screen.getByTestId('epoch-overrides-review'))
      await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-reapply')) })
      await act(async () => { await settle() })
      expect(useEpochOverridesStore.getState().error).toBeNull()
      expect(screen.getByRole('alert').textContent).toContain('epochs.overrides.refusal.notRecorded')
      expect(screen.getByRole('alert').textContent).not.toMatch(/undoable step/)
      expect(resolveCalls).toEqual([])
      expect(journal()).toEqual({})
    } finally {
      top.mockRestore()
    }
  })

  it('outside a diagram (no undo scope) the re-apply is REFUSED, nothing written', async () => {
    undoHistory.configure({ ...host, scope: () => null } as never)
    expect(await controller.reapplyChecked()).toBeNull()
    expect(useEpochOverridesStore.getState().refusal).toBe('needsDiagram')
    expect(flushed).toEqual([])
    expect(resolveCalls).toEqual([])
    expect(useModelStore.getState().objects.find((o) => o.id === 'y')?.name).toBe('Paul')
  })

  it('UNDO of the batch returns its rows to pending (resolve {revert: batchId})', async () => {
    await act(async () => { await controller.reapplyChecked() })
    expect(resolveCalls).toEqual([{ batchId: uuid(1), reapplied: ['r-y', 'r-w', 'r-u'], dismissed: [] }])
    expect(undoHistory.sizes('test').undo).toBe(1)
    await act(async () => { undoHistory.undo(); await settle() })
    expect(host.apply).toHaveBeenCalledTimes(1)
    expect(resolveCalls).toContainEqual({ revert: uuid(1) })
  })

  it('NOT durable in time: the journal STAYS and nothing is resolved', async () => {
    durable = async () => false
    await act(async () => { await controller.reapplyChecked() })
    expect(flushed).toEqual([msg(1)])
    expect(resolveCalls).toEqual([])
    // Journaled with its carriers' heads after the flush.
    expect(journal()[uuid(1)]).toMatchObject({ batchId: uuid(1), reapplied: ['r-y', 'r-w', 'r-u'], carriers: carrierHeads(['carrier-doc']) })
    expect(useEpochOverridesStore.getState().error).toMatch(/not durable/)
    expect(useEpochOverridesStore.getState().lastBatch).toBeNull()
  })

  it('a tagged flush that wrote NOTHING is never durable: nothing resolved, the journal stays', async () => {
    flushCarriers = []
    await act(async () => { await controller.reapplyChecked() })
    expect(flushed).toEqual([msg(1)])
    expect(resolveCalls).toEqual([])
    expect(journal()[uuid(1)]).toMatchObject({ batchId: uuid(1) })
    expect(useEpochOverridesStore.getState().error).toMatch(/not durable/)
  })

  it('UNDONE while the in-session recovery waits for durability: never resolved as re-applied', async () => {
    durable = async () => false
    await act(async () => { await controller.reapplyChecked() })
    expect(resolveCalls).toEqual([])
    let release: (v: boolean) => void = () => undefined
    durable = () => new Promise<boolean>((r) => { release = r })
    let review: Promise<void> = Promise.resolve()
    // The later review waits again, briefly, for the batch's carriers…
    await act(async () => { review = controller.refreshOverrides({ force: true }); await settle() })
    // …and the user undoes the batch during that wait.
    await act(async () => { undoHistory.undo(); await settle() })
    await act(async () => { release(true); await review; await settle(); await settle() })
    expect(resolveCalls).toEqual([{ revert: uuid(1) }])
    expect(journal()[uuid(1)]).toBeUndefined()
  })

  it('the recovery asks the server for the JOURNALED carrier heads', async () => {
    durable = async () => false
    await act(async () => { await controller.reapplyChecked() })
    // Reloaded after a roll: the message is gone, the server holds the heads.
    localChanges = []
    serverHasCarriers = true
    await reinstall()
    expect(serverHoldsAsked[0]).toEqual(carrierHeads(['carrier-doc']))
    expect(resolveCalls).toEqual([{ batchId: uuid(1), reapplied: ['r-y', 'r-w', 'r-u'], dismissed: [] }])
  })

  it('an undo followed AT ONCE by a re-apply never erases the new batch\'s journal', async () => {
    durable = async () => false
    await act(async () => { await controller.reapplyChecked() })
    expect(journal()[uuid(1)]).toBeDefined()
    // What the undo does to the store (the test host's `apply` does not).
    const original = useModelStore.getState().objects.map((o) => (o.id === 'y' ? { ...o, name: 'Paul' } : o.id === 'w' ? { ...o, description: 'theirs' } : { ...o, status: 'deprecated' }))
    // The other tab's batch below is still owed: a review keeps its slot.
    localChanges = [{ documentId: 'carrier-doc', actor: 'aa' }]
    carriersOwed = true
    let next: Promise<unknown> = Promise.resolve()
    await act(async () => {
      undoHistory.undo()
      // Another tab journals its own batch while the undo drops this one
      // (its write is one transaction, as this tab's are).
      kv.set(JOURNAL, { ...journal(), 'b-other-tab': { batchId: 'b-other-tab', reapplied: ['r-w'], dismissed: [] } })
      useModelStore.setState({ objects: original as never })
      next = controller.reapplyChecked()
      await next
      await settle()
    })
    expect(journal()[uuid(1)]).toBeUndefined()
    expect(journal()[uuid(2)]).toMatchObject({ batchId: uuid(2), carriers: carrierHeads(['carrier-doc']) })
    expect(journal()['b-other-tab']).toMatchObject({ batchId: 'b-other-tab' })
  })

  it('ONE SLOT PER BATCH: a new batch does not overwrite another still journaled; a reload recovers both', async () => {
    kv.set(JOURNAL, { 'b-earlier': { batchId: 'b-earlier', reapplied: ['r-w'], dismissed: [] } })
    durable = async () => false
    await act(async () => { await controller.reapplyChecked() })
    expect(Object.keys(journal()).sort()).toEqual(['b-earlier', uuid(1)].sort())
    localChanges = [{ documentId: 'carrier-doc', actor: 'aa' }]
    await reinstall()
    expect(resolveCalls).toContainEqual({ batchId: 'b-earlier', reapplied: ['r-w'], dismissed: [] })
    expect(resolveCalls).toContainEqual({ batchId: uuid(1), reapplied: ['r-y', 'r-w', 'r-u'], dismissed: [] })
    expect(journal()).toEqual({})
  })

  it('the single-slot journal of an earlier build is moved into its slot and recovered', async () => {
    kv.set('epoch-reapply-batch:v1', { batchId: 'b-legacy', reapplied: ['r-y'], dismissed: [] })
    localChanges = [{ documentId: 'carrier-doc', actor: 'aa' }]
    await reinstall()
    expect(resolveCalls).toEqual([{ batchId: 'b-legacy', reapplied: ['r-y'], dismissed: [] }])
    expect(kv.has('epoch-reapply-batch:v1')).toBe(false)
    expect(journal()).toEqual({})
  })

  it('a refresh of a workspace left, ending AFTER the new one\'s started, does not free the new one\'s slot', async () => {
    const fetch = (await import('../../lib/automerge/epochOverrides')).fetchOverrides as unknown as ReturnType<typeof vi.fn>
    let releaseOld: () => void = () => undefined
    let releaseNew: () => void = () => undefined
    fetch.mockImplementationOnce(async () => { fetches += 1; await new Promise<void>((r) => { releaseOld = r }); return serverRows })
    fetch.mockImplementationOnce(async () => { fetches += 1; await new Promise<void>((r) => { releaseNew = r }); return serverRows })
    fetches = 0
    let old: Promise<void> = Promise.resolve()
    await act(async () => { old = controller.refreshOverrides(); await settle() })
    expect(fetches).toBe(1)
    uninstall()
    uninstall = controller.installEpochOverrides(ports())
    await act(async () => { await settle() })
    expect(fetches).toBe(2) // the new workspace's own refresh, in flight
    await act(async () => { releaseOld(); await old; await settle() })
    // A refresh asked now JOINS the one in flight: no third fetch.
    let joined: Promise<void> = Promise.resolve()
    await act(async () => { joined = controller.refreshOverrides(); await settle() })
    expect(fetches).toBe(2)
    await act(async () => { releaseNew(); await joined })
  })

  it('undone while it became durable: never resolved', async () => {
    let release: (v: boolean) => void = () => undefined
    durable = () => new Promise<boolean>((r) => { release = r })
    let done: Promise<unknown> = Promise.resolve()
    await act(async () => { done = controller.reapplyChecked(); await settle() })
    await act(async () => { undoHistory.undo(); await settle() })
    await act(async () => { release(true); await done; await settle() })
    expect(resolveCalls).toEqual([{ revert: uuid(1) }])
  })

  it('REDO re-applies under a NEW batch id, tagged, journaled and resolved once durable', async () => {
    await act(async () => { await controller.reapplyChecked() })
    await act(async () => { undoHistory.undo(); await settle() })
    resolveCalls.length = 0
    flushed.length = 0
    await act(async () => { undoHistory.redo(); await settle() })
    expect(flushed).toEqual([msg(2)])
    expect(resolveCalls).toEqual([{ batchId: uuid(2), reapplied: ['r-y', 'r-w', 'r-u'], dismissed: [] }])
    // A second undo reverts the NEW id, not the first one.
    resolveCalls.length = 0
    await act(async () => { undoHistory.undo(); await settle() })
    expect(resolveCalls).toEqual([{ revert: uuid(2) }])
  })

  it('a redo not durable in time is NOT resolved', async () => {
    await act(async () => { await controller.reapplyChecked() })
    await act(async () => { undoHistory.undo(); await settle() })
    resolveCalls.length = 0
    durable = async () => false
    await act(async () => { undoHistory.redo(); await settle() })
    expect(resolveCalls).toEqual([])
    // Journaled WITH its carriers' heads, as a re-apply is.
    expect(journal()[uuid(2)]).toMatchObject({ batchId: uuid(2), carriers: carrierHeads(['carrier-doc']) })
  })

  it('a redo UNDONE between its two journal writes is never resolved after a reload', async () => {
    await act(async () => { await controller.reapplyChecked() })
    await act(async () => { undoHistory.undo(); await settle() })
    resolveCalls.length = 0
    // The undo's revert never returns: the tab dies right after it.
    revertGate = new Promise<void>(() => undefined)
    await act(async () => { undoHistory.redo(); undoHistory.undo(); await settle(); await settle() })
    expect(journal()[uuid(2)]).toBeUndefined()
    revertGate = null
    // The reload finds the message on the documents and everything durable.
    localChanges = [{ documentId: 'carrier-doc', actor: 'aa' }]
    await reinstall()
    expect(resolveCalls).not.toContainEqual(expect.objectContaining({ batchId: uuid(2) }))
  })

  it('an UNCHECKED row stays unchecked across a refresh', async () => {
    controller.setRowChecked('r-w', false)
    await act(async () => { await controller.refreshOverrides({ force: true }) })
    const checked = useEpochOverridesStore.getState().checked
    expect(checked.has('r-w')).toBe(false)
    expect(checked.has('r-y')).toBe(true)
    // And a re-apply then dismisses it rather than writing it.
    await act(async () => { await controller.reapplyChecked() })
    expect(resolveCalls).toEqual([{ batchId: uuid(1), reapplied: ['r-y', 'r-u'], dismissed: ['r-w'] }])
    expect(useModelStore.getState().objects.find((o) => o.id === 'w')?.description).toBe('theirs')
  })

  it('DURING A HOP the re-apply is refused: nothing written, nothing resolved', async () => {
    writable = false
    expect(await controller.reapplyChecked()).toBeNull()
    expect(useEpochOverridesStore.getState().refusal).toBe('hop')
    expect(flushed).toEqual([])
    expect(resolveCalls).toEqual([])
    expect(useModelStore.getState().objects.find((o) => o.id === 'y')?.name).toBe('Paul')
  })

  it('a REDO during a hop is REFUSED for real: undone again, neither tagged nor resolved; redone after the hop', async () => {
    await act(async () => { await controller.reapplyChecked() })
    await act(async () => { undoHistory.undo(); await settle() })
    flushed.length = 0
    resolveCalls.length = 0
    host.apply.mockClear()
    writable = false
    await act(async () => { undoHistory.redo(); await settle() })
    expect(flushed).toEqual([])
    expect(resolveCalls).toEqual([])
    expect(useEpochOverridesStore.getState().refusal).toBe('hop')
    // The history redid it, then undid it at once: back on the redo stack.
    expect(host.apply.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['redo', 'undo'])
    expect(undoHistory.getSnapshot()).toEqual({ canUndo: false, canRedo: true })
    // After the hop the same redo goes through, under a new batch id.
    writable = true
    await act(async () => { undoHistory.redo(); await settle() })
    expect(flushed).toEqual([msg(2)])
    expect(resolveCalls).toEqual([{ batchId: uuid(2), reapplied: ['r-y', 'r-w', 'r-u'], dismissed: [] }])
  })

  const reinstall = async () => {
    uninstall()
    uninstall = controller.installEpochOverrides(ports())
    await act(async () => { await controller.refreshOverrides({ force: true }); await settle() })
  }

  it('undoing ONE batch drops its slot only — another batch still owed keeps its own', async () => {
    kv.set(JOURNAL, { 'b-owed': { batchId: 'b-owed', reapplied: ['r-w'], dismissed: [] } })
    localChanges = [{ documentId: 'carrier-doc', actor: 'aa' }]
    carriersOwed = true
    durable = async () => false
    await act(async () => { await controller.reapplyChecked() })
    expect(Object.keys(journal()).sort()).toEqual(['b-owed', uuid(1)].sort())
    await act(async () => { undoHistory.undo(); await settle(); await settle() })
    expect(journal()[uuid(1)]).toBeUndefined()
    expect(journal()['b-owed']).toMatchObject({ batchId: 'b-owed' })
  })

  it('ONE recovery pass resolves EVERY journaled batch, not only the first', async () => {
    kv.set(JOURNAL, {
      'b-one': { batchId: 'b-one', reapplied: ['r-y'], dismissed: [] },
      'b-two': { batchId: 'b-two', reapplied: ['r-w'], dismissed: [] },
    })
    localChanges = [{ documentId: 'carrier-doc', actor: 'aa' }]
    uninstall()
    // install() starts ONE refresh; joining it (not forced) runs no other.
    uninstall = controller.installEpochOverrides(ports())
    await act(async () => { await controller.refreshOverrides(); await settle() })
    expect(resolveCalls).toContainEqual({ batchId: 'b-one', reapplied: ['r-y'], dismissed: [] })
    expect(resolveCalls).toContainEqual({ batchId: 'b-two', reapplied: ['r-w'], dismissed: [] })
    expect(journal()).toEqual({})
  })

  it('a slot dropped (by another tab) while its attempt is counted is NOT re-created', async () => {
    kv.set(JOURNAL, { 'b-crashed': { batchId: 'b-crashed', reapplied: ['r-y'], dismissed: [] } })
    localChanges = [{ documentId: 'carrier-doc', actor: 'aa' }]
    carriersOwed = true
    // The other tab resolves and drops it right as this one finds it owed.
    onCarriersDurable = () => { kv.set(JOURNAL, {}) }
    await reinstall()
    expect(journal()['b-crashed']).toBeUndefined()
  })

  it('UNDONE before its resolve: the journal goes, and a reload never resolves it', async () => {
    let release: (v: boolean) => void = () => undefined
    durable = () => new Promise<boolean>((r) => { release = r })
    let done: Promise<unknown> = Promise.resolve()
    await act(async () => { done = controller.reapplyChecked(); await settle() })
    expect(journal()[uuid(1)]).toMatchObject({ batchId: uuid(1) })
    await act(async () => { undoHistory.undo(); await settle() })
    expect(journal()[uuid(1)]).toBeUndefined()
    // The "crash": the tab dies before the wait ends; a reload finds the
    // message on the documents and everything durable.
    localChanges = [{ documentId: 'carrier-doc', actor: 'aa' }]
    await reinstall()
    expect(resolveCalls).toEqual([{ revert: uuid(1) }])
    release(true)
    await act(async () => { await done })
  })

  it('a journal whose carriers are still OWED is not resolved, its attempt counted; durable, it is', async () => {
    kv.set(JOURNAL, { 'b-crashed': { batchId: 'b-crashed', reapplied: ['r-y'], dismissed: [] } })
    localChanges = [{ documentId: 'carrier-doc', actor: 'aa' }]
    carriersOwed = true
    await reinstall()
    expect(resolveCalls).toEqual([])
    // Counted (the reinstall's review and the forced one: two attempts).
    expect(journal()['b-crashed']).toMatchObject({ batchId: 'b-crashed' })
    expect(journal()['b-crashed'].attempts).toBeGreaterThanOrEqual(1)
    carriersOwed = false
    await reinstall()
    expect(resolveCalls).toEqual([{ batchId: 'b-crashed', reapplied: ['r-y'], dismissed: [] }])
    expect(journal()).toEqual({})
  })

  it('message GONE (a roll copied the changes without it): resolved when the server holds the journaled carrier heads, dropped when not', async () => {
    const journaled = { batchId: 'b-rolled', reapplied: ['r-y'], dismissed: [], carriers: [{ documentId: 'old-doc', heads: ['h'] }] }
    kv.set(JOURNAL, { 'b-rolled': journaled })
    localChanges = []
    serverHasCarriers = true
    await reinstall()
    expect(serverHoldsAsked[0]).toEqual(journaled.carriers)
    expect(resolveCalls).toEqual([{ batchId: 'b-rolled', reapplied: ['r-y'], dismissed: [] }])
    resolveCalls.length = 0
    kv.set(JOURNAL, { 'b-never-written': { ...journaled, batchId: 'b-never-written' } })
    serverHasCarriers = false
    await reinstall()
    expect(resolveCalls).toEqual([])
    expect(journal()).toEqual({})
  })

  it('message GONE and the carriers\' epoch RETIRED: resolved as written, never offered again', async () => {
    const journaled = { batchId: 'b-retired', reapplied: ['r-y'], dismissed: ['r-w'], carriers: [{ documentId: 'old-doc', heads: ['h'] }] }
    kv.set(JOURNAL, { 'b-retired': journaled })
    localChanges = []
    serverHasCarriers = 'retired'
    await reinstall()
    expect(serverHoldsAsked[0]).toEqual(journaled.carriers)
    expect(resolveCalls).toEqual([{ batchId: 'b-retired', reapplied: ['r-y'], dismissed: ['r-w'] }])
    expect(journal()).toEqual({})
    expect(useEpochOverridesStore.getState().rows.map((r) => r.id)).toEqual(['r-u'])
  })

  it('IN SESSION, a batch whose wait ran out is resolved by a later review once durable', async () => {
    durable = async () => false
    await act(async () => { await controller.reapplyChecked() })
    expect(resolveCalls).toEqual([])
    durable = async () => true
    await act(async () => { await controller.refreshOverrides({ force: true }); await settle() })
    expect(resolveCalls).toEqual([{ batchId: uuid(1), reapplied: ['r-y', 'r-w', 'r-u'], dismissed: [] }])
  })

  it('a FORCED refresh during one in flight runs again after it; a reinstall gets its own refresh', async () => {
    let releaseFetch: () => void = () => undefined
    const fetch = (await import('../../lib/automerge/epochOverrides')).fetchOverrides as unknown as ReturnType<typeof vi.fn>
    fetch.mockImplementationOnce(async () => { fetches += 1; await new Promise<void>((r) => { releaseFetch = r }); return serverRows })
    fetches = 0
    let first: Promise<void> = Promise.resolve()
    await act(async () => { first = controller.refreshOverrides(); await settle() })
    expect(fetches).toBe(1)
    let forced: Promise<void> = Promise.resolve()
    await act(async () => { forced = controller.refreshOverrides({ force: true }); await settle() })
    expect(fetches).toBe(1) // waits for the one in flight…
    releaseFetch()
    await act(async () => { await first; await forced })
    expect(fetches).toBe(2) // …then runs its own
    // Uninstalled with a refresh in flight, reinstalled: a NEW refresh runs.
    fetch.mockImplementationOnce(async () => { fetches += 1; await new Promise<void>((r) => { releaseFetch = r }); return serverRows })
    await act(async () => { void controller.refreshOverrides(); await settle() })
    expect(fetches).toBe(3)
    uninstall()
    uninstall = controller.installEpochOverrides(ports())
    await act(async () => { await settle() })
    expect(fetches).toBe(4)
    releaseFetch()
  })

  it('a tagged-step listener that THROWS does not cut the undo short: the others still hear it, availability is updated', async () => {
    await act(async () => { await controller.reapplyChecked() })
    const off = undoHistory.onTaggedStep(() => { throw new Error('a broken listener') })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await act(async () => { undoHistory.undo(); await settle() })
      expect(resolveCalls).toContainEqual({ revert: uuid(1) })
      expect(undoHistory.getSnapshot()).toEqual({ canUndo: false, canRedo: true })
      expect(errors).toHaveBeenCalled()
    } finally {
      off()
      errors.mockRestore()
    }
  })

  it('Escape closes the full panel, never the compact strip', async () => {
    render(<EpochOverridesPanel />)
    fireEvent.click(screen.getByTestId('epoch-overrides-review'))
    act(() => { useEpochOverridesStore.setState({ compact: true }) })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('epoch-overrides-strip')).toBeTruthy()
    act(() => { useEpochOverridesStore.setState({ compact: false }) })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('epoch-overrides-panel')).toBeNull()
  })

  it('"Discard my edits" asks first with a VISIBLE inline confirmation (no browser dialog): nothing goes before "Confirm discard"; "Keep them" cancels', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    render(<EpochOverridesPanel />)
    fireEvent.click(screen.getByTestId('epoch-overrides-review'))
    expect(screen.queryByTestId('epoch-overrides-discard-confirm')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-dismiss-all')); await settle() })
    // The question is on screen and nothing has left yet.
    expect(screen.getByTestId('epoch-overrides-discard-confirm')).toBeTruthy()
    expect(resolveCalls).toEqual([])
    expect(confirm).not.toHaveBeenCalled()
    // Cancel: the question goes, nothing was discarded, the panel is intact.
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-discard-no')); await settle() })
    expect(screen.queryByTestId('epoch-overrides-discard-confirm')).toBeNull()
    expect(resolveCalls).toEqual([])
    expect(screen.getByTestId('epoch-overrides-panel')).toBeTruthy()
  })

  it('"Discard my edits": the discard leaves on "Confirm discard" only, then offers Undo', async () => {
    render(<EpochOverridesPanel />)
    fireEvent.click(screen.getByTestId('epoch-overrides-review'))
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-dismiss-all')); await settle() })
    expect(resolveCalls).toEqual([])
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-discard-yes')); await settle() })
    expect(resolveCalls).toEqual([{ batchId: uuid(1), reapplied: [], dismissed: ['r-y', 'r-w', 'r-u'] }])
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-undo-discard')); await settle() })
    expect(resolveCalls).toContainEqual({ revert: uuid(1) })
  })

  it('a pending discard question does not survive closing the panel (reopened, it is asked again)', async () => {
    render(<EpochOverridesPanel />)
    fireEvent.click(screen.getByTestId('epoch-overrides-review'))
    fireEvent.click(screen.getByTestId('epoch-overrides-dismiss-all'))
    expect(screen.getByTestId('epoch-overrides-discard-confirm')).toBeTruthy()
    fireEvent.click(screen.getByTestId('epoch-overrides-close'))
    fireEvent.click(screen.getByTestId('epoch-overrides-pill'))
    expect(screen.getByTestId('epoch-overrides-panel')).toBeTruthy()
    expect(screen.queryByTestId('epoch-overrides-discard-confirm')).toBeNull()
  })

  // An earlier layout put the panel bottom-left over the object list and the
  // strip over the status bar. The classes ARE the layout contract here (jsdom
  // has no layout): right column / centered above the bottom bar, never `left-`.
  // Another covered 74-100 % of the inspector and Share, and the notice the
  // zoom cluster (measured in a real browser); here the classes are the contract.
  it('the full panel is a DRAWER of the inspector\'s column — docked against it on the canvas side (340 px), between the tool pill\'s row and the zoom cluster\'s; never over the inspector, Share or the list', () => {
    render(<EpochOverridesPanel />)
    fireEvent.click(screen.getByTestId('epoch-overrides-review'))
    const classes = screen.getByTestId('epoch-overrides-panel').className.split(/\s+/)
    expect(classes).toContain('lg:right-[340px]')
    expect(classes).toContain('top-[4.75rem]')
    expect(classes).toContain('bottom-[4.75rem]')
    expect(classes).toContain('w-[312px]')
    expect(classes).toContain('rounded-[20px]') // the floating columns' chrome
    expect(classes).not.toContain('top-3.5')
    expect(classes.some((c) => /^left-/.test(c))).toBe(false)
  })

  it('the inspector CLOSED, the drawer takes its column; the retired banner up, the drawer starts below it', () => {
    act(() => { useUIStore.setState({ rightSidebarOpen: false }) })
    render(<EpochOverridesPanel />)
    fireEvent.click(screen.getByTestId('epoch-overrides-review'))
    const classes = screen.getByTestId('epoch-overrides-panel').className.split(/\s+/)
    expect(classes).toContain('right-3.5')
    expect(classes).not.toContain('lg:right-[340px]')
    act(() => { useUIStore.setState({ rightSidebarOpen: true }); useEpochHopStore.setState({ retired: { version: 1, metaUrl: '', collectedAt: '', differences: [] } }) })
    const panel = screen.getByTestId('epoch-overrides-panel')
    expect(panel.className.split(/\s+/)).not.toContain('top-[4.75rem]')
    // The banner's MEASURED bottom edge (its text wraps at 1280×720), plus the gutter.
    expect(panel.style.top).toBe('calc(var(--epoch-retired-bottom, 7.25rem) + 0.875rem)')
    act(() => { useEpochHopStore.setState({ retired: null }) })
  })

  it('the notice (and the pill, and the Discard toast) sit in the drawer\'s bottom corner, above the zoom cluster — not in the window\'s corner over it and the inspector', async () => {
    render(<EpochOverridesPanel />)
    const corner = screen.getByTestId('epoch-overrides-corner').className.split(/\s+/)
    expect(corner).toContain('bottom-[4.75rem]')
    expect(corner).toContain('lg:right-[340px]')
    expect(corner).not.toContain('bottom-4')
    expect(corner).not.toContain('right-4')
    fireEvent.click(screen.getByTestId('epoch-overrides-review'))
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-dismiss-all')); await settle() })
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-discard-yes')); await settle() })
    const toast = screen.getByTestId('epoch-overrides-discard-toast').className.split(/\s+/)
    expect(toast).toContain('bottom-[4.75rem]')
    expect(toast).toContain('lg:right-[340px]')
  })

  describe('the NARROW editor — the perspective bar stacked above the zoom (1024×768, both columns open)', () => {
    const at = (width: number) => act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
      window.dispatchEvent(new Event('resize'))
    })

    it('the rule is the bar\'s own: narrow at 1024 with both columns, not at 1280 or 1440, not with the inspector closed, not under lg', async () => {
      const { narrowEditor } = await import('./epochOverrideLayout')
      expect(narrowEditor(1024, true, true, '2d')).toBe(true)
      expect(narrowEditor(1280, true, true, '2d')).toBe(false)
      expect(narrowEditor(1440, true, true, '2d')).toBe(false)
      expect(narrowEditor(1024, true, false, '2d')).toBe(false)
      expect(narrowEditor(900, true, true, '2d')).toBe(false)
    })

    it('the drawer takes the inspector\'s column below the tool row; the notice, the toast and the preview strip go to the top of the canvas — never the bottom, where the bar and the zoom are', async () => {
      render(<EpochOverridesPanel />)
      at(1024)
      const corner = screen.getByTestId('epoch-overrides-corner').className.split(/\s+/)
      // At most 100vw − 744 px wide, its left edge clear of the canvas's
      // tool rail (340 + 48 + 16).
      expect(corner).toEqual(expect.arrayContaining(['top-[4.75rem]', 'right-[340px]', 'max-w-[calc(100vw-744px)]']))
      expect(corner).not.toContain('bottom-[4.75rem]')
      fireEvent.click(screen.getByTestId('epoch-overrides-review'))
      const drawer = screen.getByTestId('epoch-overrides-panel').className.split(/\s+/)
      expect(drawer).toEqual(expect.arrayContaining(['right-3.5', 'top-[4.75rem]', 'bottom-3.5', 'w-[312px]']))
      expect(drawer).not.toContain('lg:right-[340px]')
      expect(drawer).not.toContain('bottom-[4.75rem]')
      // The preview strip: the top of the canvas, between the columns, wrapping.
      act(() => { useEpochOverridesStore.setState({ compact: true }) })
      const strip = screen.getByTestId('epoch-overrides-strip').className.split(/\s+/)
      // …in the notice's own band: never from 340 px, over the rail.
      expect(strip).toEqual(expect.arrayContaining(['top-[4.75rem]', 'left-[404px]', 'right-[340px]', 'max-w-[calc(100vw-744px)]', 'flex-wrap']))
      expect(strip).not.toContain('inset-x-[340px]')
      expect(strip).not.toContain('bottom-[4.75rem]')
      act(() => { useEpochOverridesStore.setState({ compact: false }) })
      // The retired banner up: the notice slot moves below its measured edge;
      // the drawer (in the inspector's column) does not.
      act(() => { useEpochHopStore.setState({ retired: { version: 1, metaUrl: '', collectedAt: '', differences: [] } }) })
      expect(screen.getByTestId('epoch-overrides-panel').style.top).toBe('')
      act(() => { useEpochOverridesStore.setState({ panelOpen: false }) })
      expect(screen.getByTestId('epoch-overrides-corner').style.top).toBe('calc(var(--epoch-retired-bottom, 7.25rem) + 0.875rem)')
      act(() => { useEpochHopStore.setState({ retired: null }) })
      // Back to 1280: the desktop places, at once.
      at(1280)
      expect(screen.getByTestId('epoch-overrides-corner').className.split(/\s+/)).toEqual(expect.arrayContaining(['bottom-[4.75rem]', 'lg:right-[340px]']))
    })
  })

  it('"Keep them" gives the focus back to "Discard my edits", not to the page', async () => {
    render(<EpochOverridesPanel />)
    fireEvent.click(screen.getByTestId('epoch-overrides-review'))
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-dismiss-all')); await settle() })
    expect(document.activeElement).toBe(screen.getByTestId('epoch-overrides-discard-no'))
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-discard-no')); await settle() })
    expect(document.activeElement).toBe(screen.getByTestId('epoch-overrides-dismiss-all'))
  })

  it('"Keep them", then "Discard my edits" again and "Confirm discard" — the focus is NOT sent back to "Discard my edits", which is leaving', async () => {
    render(<EpochOverridesPanel />)
    fireEvent.click(screen.getByTestId('epoch-overrides-review'))
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-dismiss-all')); await settle() })
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-discard-no')); await settle() })
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-dismiss-all')); await settle() })
    const leaving = screen.getByTestId('epoch-overrides-dismiss-all')
    await act(async () => { fireEvent.click(screen.getByTestId('epoch-overrides-discard-yes')) })
    expect(document.activeElement).not.toBe(leaving)
    await act(async () => { await settle() })
    expect(document.activeElement).not.toBe(leaving)
  })

  it('the compact strip floats centered ABOVE the bottom bar (not at the corner it used to hide behind)', () => {
    act(() => { useEpochOverridesStore.setState({ panelOpen: true, compact: true }) })
    render(<EpochOverridesPanel />)
    const classes = screen.getByTestId('epoch-overrides-strip').className.split(/\s+/)
    expect(classes).toContain('bottom-[4.75rem]')
    expect(classes).toContain('left-1/2')
    expect(classes).toContain('-translate-x-1/2')
    expect(classes).not.toContain('bottom-4')
    expect(classes).not.toContain('left-4')
  })
})
