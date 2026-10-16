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

/**
 * QA lens battery (round 2) for `useInlineExpansionContents`. Each case names
 * the mutant it was written to kill; all were verified to fail against it and
 * pass on the reviewed tree.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { C4Object, Diagram } from '../../types'

vi.mock('../../lib/modelQuery', () => ({ getModelQuery: () => { throw new Error('not in this test') } }))
vi.mock('../../stores/modelStore', () => ({ getDiagramIndex: () => { throw new Error('not in this test') } }))
vi.mock('../../lib/diagrams/duplicateSource', () => ({ openDiagramPlacement: () => { throw new Error('not in this test') } }))

const { useInlineExpansionContents } = await import('./useInlineExpansionContents')
const { useAutomergeStatus } = await import('../../stores/automergeStatusStore')
const { notifyModelIndexChanged, __resetModelIndexVersionForTest } = await import('../../lib/modelQuery/indexSync')
type Source = import('./useInlineExpansionContents').ExpansionTargetSource
type TargetRead = import('./useInlineExpansionContents').TargetRead
type Composition = Pick<Diagram, 'objectIds' | 'connectionIds'>

const object = (id: string, name = id): C4Object => ({ id, name, scope: 'internal' } as C4Object)
const PLACED = { inner: { position: { x: 10, y: 20 }, size: { width: 100, height: 60 } } }
const MOVED = { inner: { position: { x: 300, y: 20 }, size: { width: 100, height: 60 } } }

function manualSource(compositions: Record<string, Composition>) {
  const loads: Array<{ diagramId: string; contents: boolean; resolve: (read: TargetRead) => void }> = []
  const listeners = new Map<string, Set<() => void>>()
  const source: Source = {
    composition: (id) => compositions[id],
    open: (diagramId) => ({
      load: (_composition, { contents }) =>
        new Promise<TargetRead>((resolve) => { loads.push({ diagramId, contents, resolve }) }),
      subscribe: (onChange) => {
        const set = listeners.get(diagramId) ?? new Set()
        set.add(onChange)
        listeners.set(diagramId, set)
        return () => set.delete(onChange)
      },
      close: () => {},
    }),
  }
  const fire = (diagramId: string) => { for (const fn of [...(listeners.get(diagramId) ?? [])]) fn() }
  const change = (diagramId: string) => act(() => { fire(diagramId) })
  const answer = (index: number, read: TargetRead) => act(async () => { loads[index].resolve(read) })
  return { source, loads, listeners, fire, change, answer }
}

const full = (layouts: TargetRead['layouts'], objects = [object('inner')]): TargetRead =>
  ({ objects, connections: [], layouts })
const B = { objectIds: ['inner'], connectionIds: [] as string[] }
const withProps = (source: Source) => renderHook(
  ({ expansions, registry }) => useInlineExpansionContents(expansions, registry, source),
  { initialProps: { expansions: { host: 'B' } as Record<string, string>, registry: 1 as unknown } },
)
/** A model revision that touched B's shape: the FAST lane. */
const bumpIndex = () => act(() => { notifyModelIndexChanged({ objectIds: ['inner'], connectionIds: [] }) })
const reconnect = () => act(() => { useAutomergeStatus.getState().noteTransportRestored() })

beforeEach(() => {
  useAutomergeStatus.setState({ status: 'ready', transportEpoch: 0 })
  __resetModelIndexVersionForTest()
})
afterEach(() => { vi.useRealTimers() })

describe('useInlineExpansionContents — QA round 2', () => {
  // Kills: `session.pending = false` deleted — one model-index bump then made
  // EVERY later document change refetch every shape.
  it('a document change after an index-driven reload re-reads the placement only', async () => {
    vi.useFakeTimers()
    const { source, loads, change, answer } = manualSource({ B })
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full({}))
    bumpIndex()
    act(() => { vi.advanceTimersByTime(200) })
    expect(loads[1].contents).toBe(true)
    await answer(1, full(PLACED))
    change('B')
    act(() => { vi.advanceTimersByTime(200) })
    expect(loads).toHaveLength(3)
    expect(loads[2].contents).toBe(false)
  })

  // Kills: `strongest` letting the LATER kind win — an index bump followed by a
  // document change inside one window lost the contents read.
  it('an index change and a document change in one window still re-read the contents', async () => {
    vi.useFakeTimers()
    const { source, loads, change, answer } = manualSource({ B })
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full({}))
    bumpIndex()
    change('B')
    act(() => { vi.advanceTimersByTime(200) })
    expect(loads).toHaveLength(2)
    expect(loads[1].contents).toBe(true)
  })

  // Kills: `markStale` overwriting the entry's staleness instead of keeping the
  // strongest — a document change during a reconnect's FULL read downgraded the
  // follow-up to placement-only, and the reconnect's contents never landed.
  it('a document change during a reconnect read does not downgrade it to placement-only', async () => {
    vi.useFakeTimers()
    const { source, loads, change, answer } = manualSource({ B })
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full({}))
    reconnect()
    expect(loads[1].contents).toBe(true)
    change('B')
    act(() => { vi.advanceTimersByTime(200) })
    expect(loads).toHaveLength(3)
    expect(loads[2].contents, 'the reconnect\'s contents read was superseded by a placement-only one').toBe(true)
  })

  // Kills: the generation check removed. The target check cannot stand in for
  // it: both reads belong to the SAME session.
  it('an older read landing after a newer one does not overwrite it', async () => {
    vi.useFakeTimers()
    const { source, loads, change, answer } = manualSource({ B })
    const { result } = renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full({}))
    change('B')
    act(() => { vi.advanceTimersByTime(200) })
    change('B')
    act(() => { vi.advanceTimersByTime(200) })
    expect(loads).toHaveLength(3)
    await answer(2, { layouts: MOVED })
    await answer(1, { layouts: PLACED })
    expect(result.current.contentsRef.current.layouts.get('B')).toEqual(MOVED)
  })

  // Kills: the session (target) check removed. Collapsing does not bump the
  // generation, so only that check refuses a read for a target no longer held.
  it('a read that lands after its expansion was collapsed is not shown', async () => {
    const { source, answer } = manualSource({ B })
    const { result, rerender } = withProps(source)
    rerender({ expansions: {}, registry: 1 })
    await answer(0, full(PLACED))
    expect(result.current.contentsRef.current.layouts.has('B')).toBe(false)
    expect(result.current.contentsRef.current.objects.has('inner')).toBe(false)
  })

  // Kills: superseded → `stale: false`, and superseded → always 'all'. The
  // debounce firing and the read resolving are both async: when the read lands
  // BEFORE the re-render it must stay stale (so the asked-for reload runs), with
  // the staleness that was asked for (a placement change: placement-only).
  it('a read that lands after a newer change, before the re-render, is re-read with the right kind', async () => {
    vi.useFakeTimers()
    const { source, loads, fire, change, answer } = manualSource({ B })
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full({}))
    change('B')
    act(() => { vi.advanceTimersByTime(200) })
    expect(loads).toHaveLength(2)
    await act(async () => {
      fire('B')
      vi.advanceTimersByTime(200)
      loads[1].resolve({ layouts: PLACED })
    })
    expect(loads).toHaveLength(3)
    expect(loads[2].contents).toBe(false)
  })

  // Kills: `mergeById` keeping an id the composition no longer lists.
  it('a shape removed from the target\'s composition leaves the expansion', async () => {
    const compositions = { B: { objectIds: ['inner', 'other'], connectionIds: [] as string[] } }
    const { source, loads, answer } = manualSource(compositions)
    const { result, rerender } = withProps(source)
    await answer(0, full(PLACED, [object('inner'), object('other')]))
    compositions.B = { objectIds: ['inner'], connectionIds: [] }
    rerender({ expansions: { host: 'B' }, registry: 2 })
    expect(loads).toHaveLength(2)
    await answer(1, full(PLACED, [object('inner')]))
    expect(result.current.contentsRef.current.objects.has('other')).toBe(false)
  })

  // Kills: closing a session without clearing its pending debounce. The old
  // timer then fired into the re-expansion's session and doubled its read.
  it('a change pending at collapse does not fire into the re-expansion', async () => {
    vi.useFakeTimers()
    const { source, loads, change, answer } = manualSource({ B })
    const { rerender } = withProps(source)
    await answer(0, full(PLACED))
    change('B')
    rerender({ expansions: {}, registry: 1 })
    rerender({ expansions: { host: 'B' }, registry: 1 })
    expect(loads).toHaveLength(2)
    act(() => { vi.advanceTimersByTime(500) })
    expect(loads).toHaveLength(2)
  })

  // Kills: the in-flight dedupe removed — every index change re-read every
  // target still loading.
  it('does not start a second read of a target already loading', () => {
    const { source, loads } = manualSource({ B })
    const { rerender } = withProps(source)
    rerender({ expansions: { host: 'B' }, registry: 2 })
    rerender({ expansions: { host: 'B', other: 'B' }, registry: 3 })
    expect(loads).toHaveLength(1)
  })

  // Kills: the error branch not clearing `inflight`. The author's retry case
  // goes through a reconnect, whose `markStale` clears it anyway; an index
  // change (no `markStale`) is the trigger that needs the branch.
  it('a read that threw is retried when the diagram index next changes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const loads: Array<{ reject: (e: unknown) => void }> = []
      const source: Source = {
        composition: () => B,
        open: () => ({
          load: () => new Promise<TargetRead>((_resolve, reject) => { loads.push({ reject }) }),
          subscribe: () => () => {},
          close: () => {},
        }),
      }
      const { rerender } = withProps(source)
      await act(async () => { loads[0].reject(new Error('loader bug')) })
      rerender({ expansions: { host: 'B' }, registry: 2 })
      expect(loads).toHaveLength(2)
    } finally {
      warn.mockRestore()
    }
  })

  // Kills: `closeSession` not forgetting the session. A re-expansion then
  // reused the CLOSED target — whose real placement read answers null for ever
  // and whose subscription is gone.
  it('re-expanding opens a fresh session, never the closed one', () => {
    const opened: string[] = []
    const closed: string[] = []
    const reads: string[] = []
    let sessions = 0
    const source: Source = {
      composition: () => B,
      open: (diagramId) => {
        const id = `${diagramId}#${++sessions}`
        opened.push(id)
        return {
          load: () => { reads.push(id); return new Promise<TargetRead>(() => {}) },
          subscribe: () => () => {},
          close: () => { closed.push(id) },
        }
      },
    }
    const { rerender } = withProps(source)
    rerender({ expansions: {}, registry: 1 })
    rerender({ expansions: { host: 'B' }, registry: 1 })
    expect(opened).toEqual(['B#1', 'B#2'])
    expect(closed).toEqual(['B#1'])
    expect(reads.at(-1)).toBe('B#2')
  })

  it('a read that lands after unmount publishes nothing', async () => {
    const { source, answer } = manualSource({ B })
    const { result, unmount } = renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    const ref = result.current.contentsRef
    unmount()
    await answer(0, full(PLACED))
    expect(ref.current.layouts.size).toBe(0)
  })
})
