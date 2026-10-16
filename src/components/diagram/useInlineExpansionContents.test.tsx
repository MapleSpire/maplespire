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
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { C4Object, Connection, Diagram } from '../../types'

// The real source's dependencies; every test injects its own source.
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
const connection = (id: string): Connection => ({ id, fromId: 'a', toId: 'b' } as Connection)
const PLACED = { inner: { position: { x: 10, y: 20 }, size: { width: 100, height: 60 } } }
const MOVED = { inner: { position: { x: 300, y: 20 }, size: { width: 100, height: 60 } } }

/** A source whose every read is answered by hand, in the order the test picks. */
function manualSource(compositions: Record<string, Composition>) {
  const loads: Array<{ diagramId: string; contents: boolean; resolve: (read: TargetRead) => void; reject: (e: unknown) => void }> = []
  const listeners = new Map<string, Set<() => void>>()
  const opened: string[] = []
  const closed: string[] = []
  const source: Source = {
    composition: (id) => compositions[id],
    open: (diagramId) => {
      opened.push(diagramId)
      return {
        load: (_composition, { contents }) =>
          new Promise<TargetRead>((resolve, reject) => { loads.push({ diagramId, contents, resolve, reject }) }),
        subscribe: (onChange) => {
          const set = listeners.get(diagramId) ?? new Set()
          set.add(onChange)
          listeners.set(diagramId, set)
          return () => set.delete(onChange)
        },
        close: () => { closed.push(diagramId) },
      }
    },
  }
  /** The target's document changed (as automerge-repo's 'change' would say). */
  const change = (diagramId: string) => act(() => { for (const fn of [...(listeners.get(diagramId) ?? [])]) fn() })
  const answer = (index: number, read: TargetRead) => act(async () => { loads[index].resolve(read) })
  return { source, loads, listeners, opened, closed, change, answer }
}

const full = (layouts: TargetRead['layouts'], objects = [object('inner')]): TargetRead =>
  ({ objects, connections: [], layouts })

const COMPOSITION = { B: { objectIds: ['inner'], connectionIds: [] as string[] } }

beforeEach(() => {
  useAutomergeStatus.setState({ status: 'ready', transportEpoch: 0 })
  __resetModelIndexVersionForTest()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useInlineExpansionContents', () => {
  // The reported defect: offline, the target's DiagramDoc never synced here, so
  // its placement is unreadable and the expansion is laid on a grid. The load
  // ran only when the expansions changed, so reconnecting never upgraded it.
  it('re-reads a grid-placed expansion when the transport comes back', async () => {
    const { source, loads, answer } = manualSource(COMPOSITION)
    const { result } = renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full(null))
    expect(result.current.contentsRef.current.layouts.get('B')).toBeNull()

    act(() => { useAutomergeStatus.getState().noteTransportRestored() })
    expect(loads).toHaveLength(2)
    expect(loads[1].contents, 'a reconnect re-reads everything').toBe(true)
    // Until the new read lands, the grid stays on screen (not 'pending').
    expect(result.current.contentsRef.current.layouts.get('B')).toBeNull()

    await answer(1, full(PLACED))
    expect(result.current.contentsRef.current.layouts.get('B')).toEqual(PLACED)
  })

  // 2026-10-16, FoodDash: a target's derived (lower) edges are not in its
  // stub's connectionIds. They are published as part of its membership, and a
  // re-read that could not get them keeps the last set rather than erasing it.
  it('publishes the target\'s derived edges with its own, and keeps them through a re-read without them', async () => {
    const { source, answer } = manualSource({ B: { objectIds: ['inner'], connectionIds: ['c-in'] } })
    const { result } = renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    const derived = { ...connection('lower:inner→peer'), kind: 'lower' } as Connection
    await answer(0, { ...full(PLACED), connections: [connection('c-in')], derived: [derived] })
    const contents = () => result.current.contentsRef.current
    expect(contents().connectionIds.get('B')).toEqual(['c-in', 'lower:inner→peer'])
    expect(contents().connections.get('lower:inner→peer')).toEqual(derived)

    act(() => { useAutomergeStatus.getState().noteTransportRestored() })
    await answer(1, { ...full(PLACED), connections: [connection('c-in')] })
    expect(contents().connectionIds.get('B')).toEqual(['c-in', 'lower:inner→peer'])

    // A read that DID get them is the whole set: a roll-up gone over there goes here.
    act(() => { useAutomergeStatus.getState().noteTransportRestored() })
    await answer(2, { ...full(PLACED), connections: [connection('c-in')], derived: [] })
    expect(contents().connectionIds.get('B')).toEqual(['c-in'])
  })

  it('re-reads a target when one of its derived edges is named by a change', async () => {
    vi.useFakeTimers()
    const { source, loads, answer } = manualSource({ B: { objectIds: ['inner'], connectionIds: [] } })
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, { ...full(PLACED), derived: [{ ...connection('lower:inner→peer'), kind: 'lower' } as Connection] })
    act(() => { notifyModelIndexChanged({ objectIds: [], connectionIds: ['lower:inner→peer'] }) })
    act(() => { vi.advanceTimersByTime(160) })
    expect(loads).toHaveLength(2)
  })

  // A relationship declared between two shapes the target does not show (a
  // component of one of its containers to another container) is drawn there as
  // a derived edge no change names. It is followed through its ends.
  describe('a changed edge the target does not hold', () => {
    const ends = (map: Record<string, { from: string[]; to: string[] } | null>) =>
      vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, id in map ? map[id] : null])))
    const setup = async (edgeEnds: ReturnType<typeof ends>, derived: Connection[] = []) => {
      vi.useFakeTimers()
      const manual = manualSource({ B: { objectIds: ['mobile', 'orders'], connectionIds: [] } })
      const source = { ...manual.source, edgeEnds }
      renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
      await manual.answer(0, { ...full(PLACED), derived })
      return manual
    }
    const change = async (connectionIds: string[]) => {
      act(() => { notifyModelIndexChanged({ objectIds: [], connectionIds }) })
      await act(async () => {})
      act(() => { vi.advanceTimersByTime(160) })
    }

    it('re-reads a target both of whose shapes the new edge rolls up to', async () => {
      const edgeEnds = ends({ 'mobile-api': { from: ['mobile', 'foodDash'], to: ['api', 'orders', 'foodDash'] } })
      const { loads } = await setup(edgeEnds)
      await change(['mobile-api'])
      expect(edgeEnds).toHaveBeenCalledWith(['mobile-api'])
      expect(loads).toHaveLength(2)
    })

    it('leaves a target alone when only one end reaches it', async () => {
      const { loads } = await setup(ends({ 'mobile-x': { from: ['mobile'], to: ['x', 'elsewhere'] } }))
      await change(['mobile-x'])
      expect(loads).toHaveLength(1)
    })

    it('an unreadable (deleted) edge re-reads only a target that draws derived edges', async () => {
      const none = await setup(ends({}))
      await change(['gone'])
      expect(none.loads).toHaveLength(1)
      vi.useRealTimers()
      const some = await setup(ends({}), [{ ...connection('lower:mobile→orders'), kind: 'lower' } as Connection])
      await change(['gone'])
      expect(some.loads).toHaveLength(2)
    })

    it('does not ask about the ends when the change already names a held edge', async () => {
      const edgeEnds = ends({})
      vi.useFakeTimers()
      const manual = manualSource({ B: { objectIds: ['mobile'], connectionIds: ['c-in'] } })
      renderHook(() => useInlineExpansionContents({ host: 'B' }, null, { ...manual.source, edgeEnds }))
      await manual.answer(0, full(PLACED))
      await change(['c-in'])
      expect(edgeEnds).not.toHaveBeenCalled()
      expect(manual.loads).toHaveLength(2)
    })
  })

  // Architect lens, B1: with the backend down and the browser online, a failed
  // durable-heads acknowledgement sets 'saving' — a rising edge into
  // "connected" during the outage. The badge is not the transport.
  it('a badge that rises during an outage is not a reconnection', async () => {
    const { source, loads, answer } = manualSource(COMPOSITION)
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full(null))

    act(() => { useAutomergeStatus.getState().setStatus('offline') })
    act(() => { useAutomergeStatus.getState().setStatus('saving') })
    act(() => { useAutomergeStatus.getState().setStatus('ready') })
    expect(loads).toHaveLength(1)
  })

  // Architect lens, B2: a reload that cannot read must not replace what an
  // earlier read knew — a correct arrangement must not fall back to a grid,
  // nor an expansion to a bare shape.
  it('a reload that could not read keeps what the last one knew', async () => {
    const { source, answer } = manualSource({ B: { objectIds: ['inner', 'other'], connectionIds: ['c1'] } })
    const { result } = renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, { objects: [object('inner'), object('other')], connections: [connection('c1')], layouts: PLACED })
    const versionBefore = result.current.version

    act(() => { useAutomergeStatus.getState().noteTransportRestored() })
    // Nothing readable: no contents at all, placement unknown.
    await answer(1, { layouts: null })
    const contents = result.current.contentsRef.current
    expect(contents.layouts.get('B')).toEqual(PLACED)
    expect([...contents.objects.keys()].sort()).toEqual(['inner', 'other'])
    expect([...contents.connections.keys()]).toEqual(['c1'])
    expect(result.current.version, 'nothing changed, so nothing is redrawn').toBe(versionBefore)

    // Partly readable: what was read is fresh, what was not is kept.
    act(() => { useAutomergeStatus.getState().noteTransportRestored() })
    await answer(2, { objects: [object('inner', 'Renamed')], layouts: MOVED })
    expect(result.current.contentsRef.current.objects.get('inner')?.name).toBe('Renamed')
    expect(result.current.contentsRef.current.objects.has('other')).toBe(true)
    expect(result.current.contentsRef.current.layouts.get('B')).toEqual(MOVED)
  })

  it('re-reads only the PLACEMENT when the target document changes, once per burst', async () => {
    vi.useFakeTimers()
    const { source, loads, change, answer } = manualSource(COMPOSITION)
    const { result } = renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full({}))

    for (let i = 0; i < 5; i++) change('B')
    expect(loads).toHaveLength(1) // debounced
    act(() => { vi.advanceTimersByTime(200) })
    expect(loads).toHaveLength(2)
    expect(loads[1].contents, 'a placement change does not refetch every shape').toBe(false)

    await answer(1, { layouts: PLACED })
    expect(result.current.contentsRef.current.layouts.get('B')).toEqual(PLACED)
    expect(result.current.contentsRef.current.objects.has('inner'), 'contents kept across a placement read').toBe(true)
  })

  // QA lens: a burst fired in one tick and a 200 ms advance let a 0 ms and a
  // 199 ms debounce pass alike. Literal times, not the constant under test.
  it('waits 150 ms of quiet after the last change, not less', async () => {
    vi.useFakeTimers()
    const { source, loads, change, answer } = manualSource(COMPOSITION)
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full({}))

    change('B')
    act(() => { vi.advanceTimersByTime(100) })
    change('B') // restarts the window
    act(() => { vi.advanceTimersByTime(140) })
    expect(loads, 'reloaded before 150 ms of quiet').toHaveLength(1)
    act(() => { vi.advanceTimersByTime(20) })
    expect(loads).toHaveLength(2)
  })

  it('follows a remote user who never pauses (max wait)', async () => {
    vi.useFakeTimers()
    const { source, loads, change, answer } = manualSource(COMPOSITION)
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full({}))

    // A change every 100 ms: the trailing debounce alone never fires.
    const changesUntil = (ms: number) => {
      for (let t = 0; t < ms; t += 100) {
        change('B')
        act(() => { vi.advanceTimersByTime(100) })
      }
    }
    changesUntil(900)
    expect(loads, 'reloaded before the 1 s max wait').toHaveLength(1)
    changesUntil(200)
    expect(loads, 'no reload while the edits went on').toHaveLength(2)
  })

  // Reviewer lens, BLOCKING 1: replacing the entry used to cancel the old
  // listener's pending debounce before the new listener existed, so a change
  // arriving while a reload was landing was dropped for good.
  it('a change that arrives while a reload is in flight gets its own reload', async () => {
    vi.useFakeTimers()
    const { source, loads, change, answer } = manualSource(COMPOSITION)
    const { result } = renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full({}))

    change('B')
    act(() => { vi.advanceTimersByTime(200) })
    expect(loads).toHaveLength(2)
    change('B') // read #2 may have read before this
    await answer(1, { layouts: PLACED })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(loads, 'the change during the reload was lost').toHaveLength(3)
    await answer(2, { layouts: MOVED })
    expect(result.current.contentsRef.current.layouts.get('B')).toEqual(MOVED)
  })

  // Reviewer lens, BLOCKING 2: the listener used to be attached only once the
  // first read had landed, so a change during that read had nobody to hear it.
  it('a change during the FIRST read is heard', async () => {
    vi.useFakeTimers()
    const { source, loads, listeners, change, answer } = manualSource(COMPOSITION)
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    expect(listeners.get('B')?.size, 'subscribed before the first read').toBe(1)
    change('B')
    act(() => { vi.advanceTimersByTime(200) })
    await answer(0, full({}))
    expect(loads).toHaveLength(2)
  })

  // Architect lens, B3: a rename over there lives in the model, not in the
  // target's DiagramDoc; the model index's revision is what says it changed.
  it('re-reads the contents when the model index changes', async () => {
    vi.useFakeTimers()
    const { source, loads, answer } = manualSource(COMPOSITION)
    const { result } = renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full(PLACED))

    act(() => { notifyModelIndexChanged({ objectIds: ['inner'], connectionIds: [] }) })
    act(() => { vi.advanceTimersByTime(160) })
    expect(loads).toHaveLength(2)
    expect(loads[1].contents).toBe(true)
    await answer(1, full(PLACED, [object('inner', 'Renamed')]))
    expect(result.current.contentsRef.current.objects.get('inner')?.name).toBe('Renamed')
  })

  // The cost the first version left unmeasured: every model revision, a local
  // edit on the diagram on screen included, re-read EVERY expanded target.
  it('ignores a model revision that names only entities the target does not hold', async () => {
    vi.useFakeTimers()
    const { source, loads, answer } = manualSource({ B: { objectIds: ['inner'], connectionIds: ['c-in'] } })
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full(PLACED))

    act(() => { notifyModelIndexChanged({ objectIds: ['elsewhere'], connectionIds: ['c-elsewhere'] }) })
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(loads, 'an edit elsewhere re-read the expansion').toHaveLength(1)

    act(() => { notifyModelIndexChanged({ objectIds: [], connectionIds: ['c-in'] }) })
    act(() => { vi.advanceTimersByTime(160) })
    expect(loads, 'a change to one of ITS connections must re-read').toHaveLength(2)
  })

  it('a revision that cannot say what it touched re-reads on the slow lane', async () => {
    vi.useFakeTimers()
    const { source, loads, answer } = manualSource(COMPOSITION)
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full(PLACED))

    act(() => { notifyModelIndexChanged() })
    act(() => { vi.advanceTimersByTime(900) })
    expect(loads, 'an id-less revision re-read at the fast pace').toHaveLength(1)
    act(() => { vi.advanceTimersByTime(150) })
    expect(loads).toHaveLength(2)
    expect(loads[1].contents).toBe(true)
  })

  it('an id-less revision between two known ones makes the whole window unknown', async () => {
    vi.useFakeTimers()
    const { source, loads, answer } = manualSource(COMPOSITION)
    const { rerender } = renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full(PLACED))
    // Three revisions landing before the hook re-renders once: React batches.
    act(() => {
      notifyModelIndexChanged({ objectIds: ['elsewhere'], connectionIds: [] })
      notifyModelIndexChanged()
      notifyModelIndexChanged({ objectIds: ['other'], connectionIds: [] })
    })
    rerender()
    act(() => { vi.advanceTimersByTime(1100) })
    expect(loads, 'the id-less revision in the middle was skipped').toHaveLength(2)
  })

  it('under continuous id-less revisions, re-reads at most once per 5 s', async () => {
    vi.useFakeTimers()
    const { source, loads, answer } = manualSource(COMPOSITION)
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full(PLACED))
    for (let t = 0; t < 4500; t += 500) {
      act(() => { notifyModelIndexChanged() })
      act(() => { vi.advanceTimersByTime(500) })
    }
    expect(loads, 're-read before the 5 s max wait').toHaveLength(1)
    act(() => { vi.advanceTimersByTime(600) })
    expect(loads).toHaveLength(2)
  })

  it('a document change is not slowed by an id-less revision in the same window', async () => {
    vi.useFakeTimers()
    const { source, loads, change, answer } = manualSource(COMPOSITION)
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full(PLACED))
    change('B')
    act(() => { notifyModelIndexChanged() })
    act(() => { vi.advanceTimersByTime(160) })
    expect(loads).toHaveLength(2)
  })

  // QA lens, review 3: the 5 s test above ends its id-less revisions at 4 s,
  // so the plain 1 s debounce fires at 5 s too — it passed with NO max wait.
  // Here the revisions never pause: only the max wait can fire.
  it('under id-less revisions that never pause, the slow lane still re-reads at 5 s', async () => {
    vi.useFakeTimers()
    const { source, loads, answer } = manualSource(COMPOSITION)
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full(PLACED))
    act(() => { notifyModelIndexChanged() })
    for (let i = 0; i < 19; i++) {
      act(() => { vi.advanceTimersByTime(250) })
      act(() => { notifyModelIndexChanged() })
    }
    expect(loads, 're-read before the max wait').toHaveLength(1)
    act(() => { vi.advanceTimersByTime(250) })
    expect(loads, 'no re-read at the 5 s max wait').toHaveLength(2)
  })

  it('a window that fired leaves no lane behind: the next id-less revision is slow again', async () => {
    vi.useFakeTimers()
    const { source, loads, answer } = manualSource(COMPOSITION)
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await answer(0, full(PLACED))
    act(() => { notifyModelIndexChanged({ objectIds: ['inner'], connectionIds: [] }) })
    act(() => { vi.advanceTimersByTime(160) })
    expect(loads).toHaveLength(2)
    await answer(1, full(PLACED))

    act(() => { notifyModelIndexChanged() })
    act(() => { vi.advanceTimersByTime(900) })
    expect(loads, 'the fired FAST window left the slow lane fast').toHaveLength(2)
    act(() => { vi.advanceTimersByTime(150) })
    expect(loads).toHaveLength(3)
  })

  it('loads only the NEW target when another shape is expanded', async () => {
    const { source, loads, answer } = manualSource({
      B: { objectIds: ['inner'], connectionIds: [] },
      C: { objectIds: ['other'], connectionIds: [] },
    })
    const { result, rerender } = renderHook(
      ({ expansions }) => useInlineExpansionContents(expansions, null, source),
      { initialProps: { expansions: { host: 'B' } as Record<string, string> } },
    )
    await answer(0, full(PLACED))

    rerender({ expansions: { host: 'B', peer: 'C' } })
    expect(loads.map((l) => l.diagramId)).toEqual(['B', 'C'])
    // B is still on screen while C loads.
    expect(result.current.contentsRef.current.layouts.get('B')).toEqual(PLACED)
    expect(result.current.contentsRef.current.layouts.has('C')).toBe(false)
  })

  it('a slow target does not hold back the others', async () => {
    const { source, loads, answer } = manualSource({
      B: { objectIds: ['inner'], connectionIds: [] },
      C: { objectIds: ['other'], connectionIds: [] },
    })
    const { result } = renderHook(() => useInlineExpansionContents({ host: 'B', peer: 'C' }, null, source))
    expect(loads).toHaveLength(2)
    await answer(loads.findIndex((l) => l.diagramId === 'C'), full({}, [object('other')]))
    expect(result.current.contentsRef.current.objects.has('other')).toBe(true)
  })

  it('collapsing drops the contents and closes the target', async () => {
    const { source, listeners, closed, answer } = manualSource(COMPOSITION)
    const { result, rerender } = renderHook(
      ({ expansions }) => useInlineExpansionContents(expansions, null, source),
      { initialProps: { expansions: { host: 'B' } as Record<string, string> } },
    )
    await answer(0, full(PLACED))

    rerender({ expansions: {} })
    expect(result.current.contentsRef.current.objects.size).toBe(0)
    expect(result.current.contentsRef.current.layouts.size).toBe(0)
    expect(listeners.get('B')!.size).toBe(0)
    expect(closed, 'the lease on the target document was kept').toEqual(['B'])
  })

  it('unmounting closes every target', async () => {
    const { source, closed, listeners } = manualSource({
      B: { objectIds: ['inner'], connectionIds: [] },
      C: { objectIds: ['other'], connectionIds: [] },
    })
    const { unmount } = renderHook(() => useInlineExpansionContents({ host: 'B', peer: 'C' }, null, source))
    unmount()
    expect(closed.sort()).toEqual(['B', 'C'])
    expect(listeners.get('B')!.size + listeners.get('C')!.size).toBe(0)
  })

  it('ignores a load that lands after its expansion was collapsed and re-expanded', async () => {
    const { source, loads, answer } = manualSource(COMPOSITION)
    const { result, rerender } = renderHook(
      ({ expansions }) => useInlineExpansionContents(expansions, null, source),
      { initialProps: { expansions: { host: 'B' } as Record<string, string> } },
    )
    rerender({ expansions: {} })
    rerender({ expansions: { host: 'B' } })
    expect(loads).toHaveLength(2)

    await answer(0, full(null)) // the old one
    expect(result.current.contentsRef.current.layouts.has('B')).toBe(false)
    await answer(1, full(PLACED))
    expect(result.current.contentsRef.current.layouts.get('B')).toEqual(PLACED)
  })

  it('reloads the contents when the target\'s composition changes in the diagram index', async () => {
    const compositions = { B: { objectIds: ['inner'], connectionIds: [] as string[] } }
    const { source, loads, answer } = manualSource(compositions)
    const { rerender } = renderHook(
      ({ registry }) => useInlineExpansionContents({ host: 'B' }, registry, source),
      { initialProps: { registry: 1 } },
    )
    await answer(0, full(PLACED))

    rerender({ registry: 2 }) // same composition: nothing to do
    expect(loads).toHaveLength(1)
    compositions.B = { objectIds: ['inner', 'added'], connectionIds: [] }
    rerender({ registry: 3 })
    expect(loads).toHaveLength(2)
    expect(loads[1].contents).toBe(true)
  })

  // Reviewer lens, 3: A -> B -> A while the B read was in flight left the
  // entry holding B's data, marked fresh.
  it('a composition that moves on while its read is in flight is read again', async () => {
    const A = { objectIds: ['inner'], connectionIds: [] as string[] }
    const B = { objectIds: ['inner', 'added'], connectionIds: [] as string[] }
    const compositions = { B: A }
    const { source, loads, answer } = manualSource(compositions)
    const { rerender } = renderHook(
      ({ registry }) => useInlineExpansionContents({ host: 'B' }, registry, source),
      { initialProps: { registry: 1 } },
    )
    await answer(0, full(PLACED))
    compositions.B = B
    rerender({ registry: 2 })
    expect(loads).toHaveLength(2)
    compositions.B = A
    rerender({ registry: 3 })
    await answer(1, full(PLACED, [object('inner'), object('added')]))
    expect(loads, 'the read for the composition no longer shown was kept as current').toHaveLength(3)
  })

  // Reviewer lens, 4: once a read rejected, nothing could ever retry it.
  it('a read that failed is retried by the next trigger', async () => {
    const { source, loads } = manualSource(COMPOSITION)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderHook(() => useInlineExpansionContents({ host: 'B' }, null, source))
    await act(async () => { loads[0].reject(new Error('boom')) })
    act(() => { useAutomergeStatus.getState().noteTransportRestored() })
    expect(loads).toHaveLength(2)
    warn.mockRestore()
  })

  it('a target the index does not know is not opened until it does', async () => {
    const compositions: Record<string, Composition> = {}
    const { source, opened, loads } = manualSource(compositions)
    const { rerender } = renderHook(
      ({ registry }) => useInlineExpansionContents({ host: 'B' }, registry, source),
      { initialProps: { registry: 1 } },
    )
    expect(opened).toEqual([])
    compositions.B = COMPOSITION.B
    rerender({ registry: 2 })
    expect(opened).toEqual(['B'])
    expect(loads).toHaveLength(1)
  })
})
