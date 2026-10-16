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

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { C4Object, Connection, Diagram } from '../../types'
import { getModelQuery } from '../../lib/modelQuery'
import { modelIndexChangesSince, useModelIndexVersion, type ModelIndexChange } from '../../lib/modelQuery/indexSync'
import { changedIdsSince, currentServerGeneration } from '../../lib/modelQuery/modelReadCacheChangeFeed'
import { currentWorkspaceRef, workspaceRefKey } from '../../lib/automerge/workspace'
import { isServerReadModelEnabled } from '../../lib/modelQuery/tierFlag'
import { subscribeCurrentWorkspaceInvalidations } from '../../lib/modelQuery/workspaceInvalidation'
import { getDiagramIndex } from '../../stores/modelStore'
import { openDiagramPlacement } from '../../lib/diagrams/duplicateSource'
import { readDerivedEdges, readEdgeEnds, type EdgeEnds } from '../../lib/diagrams/derivedEdges'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'

type Layouts = NonNullable<Diagram['layouts']>
type Composition = Pick<Diagram, 'objectIds' | 'connectionIds'> & Partial<Pick<Diagram, 'groupIds'>>

/** What `syncEngineFromStore` reads for the planner's lookup. */
export interface ExpandedContents {
  objects: Map<string, C4Object>
  connections: Map<string, Connection>
  /** Per target: every edge it draws, its derived (lower) ones included. */
  connectionIds: Map<string, string[]>
  /** `null` = unreadable (grid); absent = not read yet ('pending'). */
  layouts: Map<string, Layouts | null>
}

/**
 * One read of a target. A leg that could not be read THIS time is left
 * `undefined` (contents) or `null` (placement), and never overwrites what an
 * earlier read knew: a reload is not allowed to turn a correct arrangement back
 * into a grid, or an expansion back into a bare shape.
 */
export interface TargetRead {
  objects?: C4Object[]
  connections?: Connection[]
  /** The target's derived (lower) edges — not in a boot-from-server stub's
   *  `connectionIds` (`readDerivedEdges`). */
  derived?: Connection[]
  /** The derived edges, still being read when the rest was ready: merged when
   *  they land, so a slow render never holds the expansion back. */
  lateDerived?: Promise<Connection[] | undefined>
  layouts: Layouts | null
}

/** How long the rest of a read waits for the derived edges before going ahead
 *  without them. Not measured: a render answers in milliseconds on a local
 *  stack, and its fetch ceiling is 10 s (`fetchDiagramRender`). */
const DERIVED_GRACE_MS = 1_500

async function derivedOrLate(
  derived: Promise<Connection[] | undefined>,
): Promise<Pick<TargetRead, 'derived' | 'lateDerived'>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), DERIVED_GRACE_MS) })
  const settled = await Promise.race([derived.then((value) => ({ value })), late])
  clearTimeout(timer)
  return settled ? { derived: settled.value } : { lateDerived: derived }
}

/** A target held open for as long as it is expanded. */
export interface ExpansionTarget {
  /** Never rejects. `contents: false` re-reads the placement only. */
  load(composition: Composition, options: { contents: boolean }): Promise<TargetRead>
  /** The target's document changed, or arrived late. Called once, at open. */
  subscribe(onChange: () => void): () => void
  close(): void
}

export interface ExpansionTargetSource {
  /** The target's composition from the diagram index — a stub is enough. */
  composition: (diagramId: string) => Composition | undefined
  open: (diagramId: string) => ExpansionTarget
  /**
   * Follow the server's read-model changes, WITH the ids each touched (`null`
   * when they cannot be told). `null` instead of an unsubscribe when there is
   * no server tier to follow — the hook then counts the bridge's id-less
   * server revisions as "anything changed".
   */
  watchServerChanges?: (onChange: (change: ModelIndexChange | null) => void) => (() => void) | null
  /**
   * Each connection's two ends, each as its ancestor-or-self chain (`null`:
   * the connection cannot be read — deleted, or offline). How a change to an
   * edge the target does NOT hold is told apart from one that adds, moves or
   * removes one of its derived edges. Never rejects.
   */
  edgeEnds?: (connectionIds: readonly string[]) => Promise<Map<string, EdgeEnds | null>>
}

/**
 * The real source. A diagram that is not the active one is not in the store
 * (windowed) and its index entry is a layout-less stub, so its shapes come
 * through the ModelQuery seam and its placement from its own DiagramDoc.
 */
export const defaultExpansionTargetSource: ExpansionTargetSource = {
  composition: (diagramId) => getDiagramIndex().diagramById.get(diagramId),
  open: (diagramId) => {
    const placement = openDiagramPlacement(diagramId)
    return {
      load: async (composition, { contents }) => {
        const layouts = placement.read().catch((error: unknown) => {
          console.warn(`inline expansion: placement of ${diagramId} unreadable`, error)
          return null
        })
        if (!contents) return { layouts: await layouts }
        const derived = readDerivedEdges(diagramId, composition)
        try {
          const query = getModelQuery()
          const [resolved, connections] = await Promise.all([
            query.lookupMany(composition.objectIds),
            // One request per batch, not one per connection.
            query.connectionsMany(composition.connectionIds),
          ])
          const objects: C4Object[] = []
          for (const [, entity] of resolved) {
            // `lookupMany` answers for objects AND groups; only a C4Object carries
            // a scope, which is also the field the expansion filters on.
            if (entity && 'scope' in entity) objects.push(entity as C4Object)
          }
          return {
            objects,
            connections: [...connections.values()],
            layouts: await layouts,
            ...await derivedOrLate(derived),
          }
        } catch (error) {
          // Unknown this time, not empty: what an earlier read found stays.
          console.warn(`inline expansion: contents of ${diagramId} unavailable`, error)
          return { layouts: await layouts, ...await derivedOrLate(derived) }
        }
      },
      subscribe: (onChange) => placement.subscribe(onChange),
      close: () => placement.close(),
    }
  },
  // The SSE stream names a generation only; the change feed says what changed
  // between two. Generations count PER WORKSPACE, so the baseline is one
  // workspace's: an event from another (a switch that kept the diagram on
  // screen) re-baselines and reports "unknown" — never "nothing of mine".
  watchServerChanges: (onChange) => {
    if (!isServerReadModelEnabled()) return null
    let baseline: { key: string; generation: number } | null = null
    const controller = new AbortController()
    const unknown = () => {
      if (!controller.signal.aborted) onChange(null)
    }
    // Seeded at once, so the first edit after expanding is answered with ids
    // (the shared stream is usually open already: no 'ready' will come).
    const seed = currentWorkspaceRef()
    void currentServerGeneration(seed, controller.signal).then((generation) => {
      if (baseline === null) baseline = { key: workspaceRefKey(seed), generation }
    }, () => { /* no seed: the first event says "unknown" instead */ })
    const unsubscribe = subscribeCurrentWorkspaceInvalidations((event) => {
      const key = workspaceRefKey(event.workspace)
      const since = baseline
      if (!since || since.key !== key) {
        baseline = { key, generation: event.generation }
        unknown()
        return
      }
      if (event.generation <= since.generation) {
        // A stream that came back BELOW what was seen (a restart, a rebuilt
        // projection) may have skipped anything in between.
        if (event.generation < since.generation) {
          baseline = { key, generation: event.generation }
          unknown()
        }
        return
      }
      baseline = { key, generation: event.generation }
      void changedIdsSince(event.workspace, since.generation, event.generation, controller.signal).then((change) => {
        if (!controller.signal.aborted) onChange(change)
      }, unknown)
    })
    return () => {
      controller.abort()
      unsubscribe()
    }
  },
  edgeEnds: (connectionIds) => readEdgeEnds(connectionIds, getModelQuery()),
}

/** How long to wait for a burst to end, and the longest to wait regardless. */
interface Timing { debounce: number; maxWait: number }
/** A change known to concern the target: a burst of document changes (a sync
 *  delivers many) becomes one reload, and a remote user dragging without pause
 *  is still followed. */
const FAST: Timing = { debounce: 150, maxWait: 1000 }
/** A model revision that cannot say what it touched (a server invalidation, an
 *  index rebuild) — it fires on every edit anywhere in the workspace, local ones
 *  included, so it is followed, but at a pace that does not re-read every
 *  expanded diagram per keystroke. */
const SLOW: Timing = { debounce: 1000, maxWait: 5000 }

type Staleness = false | 'placement' | 'all'

interface CacheEntry {
  objects: C4Object[]
  connections: Connection[]
  /** The composition's own edge ids when loaded: the target's membership even
   *  when its contents could not be read (resolved through the window index). */
  membership: string[]
  derived: Connection[]
  layouts: Layouts | null
  /** The composition this was loaded for; a different one means reload. */
  signature: string
  /** What is out of date. Still shown until the reload lands. */
  stale: Staleness
  /** What `publish` last saw, so a reload that changed nothing redraws nothing. */
  fingerprint: string
}

interface Session {
  target: ExpansionTarget
  unsubscribe: () => void
  timer?: ReturnType<typeof setTimeout>
  /** When the current debounce window must fire at the latest. */
  deadline?: number
  /** A FAST request is in the window: it is not slowed by a later SLOW one. */
  fast?: boolean
  /** The strongest staleness asked for during the current window. */
  pending: Staleness
}

function compositionSignature(composition: Composition | undefined): string {
  return composition ? `${composition.objectIds.join(',')}|${composition.connectionIds.join(',')}` : ''
}

const strongest = (a: Staleness, b: Staleness): Staleness => (a === 'all' || b === 'all' ? 'all' : a || b)

/** Known beats unknown, per id; membership comes from the composition. */
function mergeById<T extends { id: string }>(ids: readonly string[], next: T[] | undefined, previous: readonly T[]): T[] {
  const fresh = new Map((next ?? []).map((item) => [item.id, item]))
  const old = new Map(previous.map((item) => [item.id, item]))
  return ids.flatMap((id) => {
    const item = fresh.get(id) ?? old.get(id)
    return item ? [item] : []
  })
}

/**
 * The shapes and placement of the diagrams currently expanded in place, cached
 * per target and held open while expanded.
 *
 * A target is (re)loaded when it is first expanded; when its composition in
 * the diagram index changes; when its DiagramDoc changes or arrives late
 * (placement only); when the model index changes (contents: a rename over
 * there); and when the sync transport comes back (`transportEpoch` — not the
 * badge's `status`, which can rise during an outage) — the last is what
 * upgrades an expansion laid on a GRID offline to the arrangement the user made.
 * While a reload is in flight the previous contents stay on screen, and a
 * reload never replaces something it knew with something it could not read.
 *
 * Returned as a ref (read imperatively by the canvas sync) and a version that
 * changes whenever the ref's contents do.
 *
 * @param expansions host objectId → target diagramId, ONLY for the diagram on
 *   screen; pass an empty record elsewhere so nothing is held for a diagram the
 *   user left (coming back re-reads, which picks up edits made over there).
 * @param registry anything whose identity changes with the diagram index.
 */
export function useInlineExpansionContents(
  expansions: Record<string, string>,
  registry: unknown,
  source: ExpansionTargetSource = defaultExpansionTargetSource,
): { contentsRef: MutableRefObject<ExpandedContents>; version: number } {
  const contentsRef = useRef<ExpandedContents>({
    objects: new Map(), connections: new Map(), connectionIds: new Map(), layouts: new Map(),
  })
  const [version, setVersion] = useState(0)
  const cacheRef = useRef(new Map<string, CacheEntry>())
  const sessionsRef = useRef(new Map<string, Session>())
  /** Per-target load generation: a result is kept only if nothing superseded it. */
  const generationRef = useRef(new Map<string, number>())
  /** diagramId -> composition signature of the load in flight for it. */
  const inflightRef = useRef(new Map<string, string>())
  const [reloadTick, setReloadTick] = useState(0)

  const targetsKey = useMemo(() => [...new Set(Object.values(expansions))].sort().join('\n'), [expansions])

  // These touch only refs and state setters, so they are stable for the hook's life.
  const publish = useCallback(() => {
    const objects = new Map<string, C4Object>()
    const connections = new Map<string, Connection>()
    const connectionIds = new Map<string, string[]>()
    const layouts = new Map<string, Layouts | null>()
    for (const [diagramId, entry] of cacheRef.current) {
      for (const object of entry.objects) objects.set(object.id, object)
      const drawn = [...entry.connections, ...entry.derived]
      for (const connection of drawn) connections.set(connection.id, connection)
      connectionIds.set(diagramId, [...new Set([...entry.membership, ...entry.derived.map((connection) => connection.id)])])
      layouts.set(diagramId, entry.layouts)
    }
    contentsRef.current = { objects, connections, connectionIds, layouts }
    setVersion((v) => v + 1)
  }, [])

  const markStale = useCallback((diagramIds: Iterable<string>, staleness: Exclude<Staleness, false>) => {
    let any = false
    for (const id of diagramIds) {
      if (!sessionsRef.current.has(id)) continue // not held: nothing to reload
      // A load already running may have read before this change.
      inflightRef.current.delete(id)
      const entry = cacheRef.current.get(id)
      if (entry) entry.stale = strongest(entry.stale, staleness)
      any = true
    }
    if (any) setReloadTick((t) => t + 1)
  }, [])

  /** Debounced `markStale` for one target: trailing, with a max wait. */
  const scheduleStale = useCallback((diagramId: string, staleness: Exclude<Staleness, false>, timing: Timing = FAST) => {
    const session = sessionsRef.current.get(diagramId)
    if (!session) return
    const now = Date.now()
    if (timing === FAST) session.fast = true
    const lane = session.fast ? FAST : timing
    session.deadline = Math.min(session.deadline ?? Infinity, now + lane.maxWait)
    session.pending = strongest(session.pending, staleness)
    clearTimeout(session.timer)
    const wait = Math.max(0, Math.min(now + lane.debounce, session.deadline) - now)
    session.timer = setTimeout(() => {
      const pending = session.pending || 'placement'
      session.timer = undefined
      session.deadline = undefined
      session.fast = undefined
      session.pending = false
      markStale([diagramId], pending)
    }, wait)
  }, [markStale])

  const closeSession = useCallback((diagramId: string) => {
    const session = sessionsRef.current.get(diagramId)
    if (!session) return
    clearTimeout(session.timer)
    session.unsubscribe()
    session.target.close()
    sessionsRef.current.delete(diagramId)
  }, [])

  // The transport came back: whatever was read without it may be a grid
  // fallback, or out of date.
  const transportEpoch = useAutomergeStatus((s) => s.transportEpoch)
  const lastEpochRef = useRef(transportEpoch)
  useEffect(() => {
    if (transportEpoch === lastEpochRef.current) return
    lastEpochRef.current = transportEpoch
    markStale([...sessionsRef.current.keys()], 'all')
  }, [transportEpoch, markStale])

  /** The model changed: only the targets holding a changed entity re-read,
   *  promptly; when what changed is unknown, every target, on the SLOW lane. */
  /** Connection ids named by recent changes and held by no target, asked about
   *  in ONE batch per burst (`edgeEnds` reads them and their ancestors). */
  const pendingEdgeIdsRef = useRef(new Set<string>())
  const edgeEndsTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const askEdgeEnds = useCallback(() => {
    edgeEndsTimerRef.current = undefined
    const ids = [...pendingEdgeIdsRef.current]
    pendingEdgeIdsRef.current.clear()
    if (ids.length === 0 || !source.edgeEnds || sessionsRef.current.size === 0) return
    void source.edgeEnds(ids).then((ends) => {
      for (const id of sessionsRef.current.keys()) {
        const composition = source.composition(id)
        if (!composition) continue
        const shown = new Set(composition.objectIds)
        const reaches = [...ends.values()].some((edge) => edge === null
          // Unreadable (most often deleted): it can only have been drawn here
          // as one of the derived edges, if the target has any.
          ? (cacheRef.current.get(id)?.derived.length ?? 0) > 0
          // EITHER end: an edge re-pointed away from the target keeps one end
          // in it, and the roll-up it used to make must go.
          : edge.from.some((end) => shown.has(end)) || edge.to.some((end) => shown.has(end)))
        if (reaches) scheduleStale(id, 'all', FAST)
      }
    })
  }, [scheduleStale, source])

  /** The model changed: only the targets holding a changed entity re-read,
   *  promptly; when what changed is unknown, every target, on the SLOW lane. */
  const scheduleForChange = useCallback((change: ModelIndexChange | null) => {
    let undecided = false
    for (const id of sessionsRef.current.keys()) {
      if (!change) {
        scheduleStale(id, 'all', SLOW)
        continue
      }
      const composition = source.composition(id)
      const touched = !composition
        || change.objectIds.some((changed) => composition.objectIds.includes(changed))
        || change.connectionIds.some((changed) => composition.connectionIds.includes(changed))
      if (touched) scheduleStale(id, 'all', FAST)
      else if (change.connectionIds.length > 0) undecided = true
    }
    if (!change || !undecided || !source.edgeEnds) return
    // A relationship declared between shapes the target does not show — two
    // components of one of its containers — is drawn there as a derived edge,
    // whose id no change names. It is followed through its ends. Not followed:
    // a re-parented shape (its change names no edge) and an end that rolls up
    // through a group on the target — both wait for another trigger.
    for (const id of change.connectionIds) pendingEdgeIdsRef.current.add(id)
    if (edgeEndsTimerRef.current === undefined) edgeEndsTimerRef.current = setTimeout(askEdgeEnds, FAST.debounce)
  }, [scheduleStale, source, askEdgeEnds])

  // The server's changes, with their ids, while anything is expanded. Every
  // edit — the user's own included — reaches the client as an id-less server
  // invalidation. Measured 2026-10-15 (five renames of a shape OUTSIDE the
  // expansion, isolated stack): five re-reads before AND after this, because
  // the server's change feed named all 10 objects of the touched model shard
  // for each rename. The filtering is only as precise as the feed's ids.
  const holding = targetsKey !== ''
  const serverFeedRef = useRef(false)
  useEffect(() => {
    if (!holding || !source.watchServerChanges) return
    const stop = source.watchServerChanges(scheduleForChange)
    if (!stop) return
    serverFeedRef.current = true
    return () => {
      serverFeedRef.current = false
      stop()
    }
  }, [holding, source, scheduleForChange])

  // The model index changed (a local write, the offline copy's feed, or the
  // bridge's id-less server invalidation — left out while the server feed above
  // answers for those).
  const indexVersion = useModelIndexVersion((s) => s.version)
  const lastIndexVersionRef = useRef(indexVersion)
  useEffect(() => {
    if (indexVersion === lastIndexVersionRef.current) return
    const change = modelIndexChangesSince(lastIndexVersionRef.current, {
      skipServerInvalidations: serverFeedRef.current,
    })
    lastIndexVersionRef.current = indexVersion
    scheduleForChange(change)
  }, [indexVersion, scheduleForChange])

  useEffect(() => {
    const compositions = new Map<string, Composition>()
    for (const id of targetsKey ? targetsKey.split('\n') : []) {
      const composition = source.composition(id)
      // Unknown to the index: the planner reports it 'missing'. Not held, so
      // nothing listens for a target that cannot be drawn; retried when the
      // index changes.
      if (composition) compositions.set(id, composition)
    }

    // Collapsed (or gone from the index): drop the contents and the session.
    let changed = false
    for (const id of [...sessionsRef.current.keys()]) {
      if (!compositions.has(id)) closeSession(id)
    }
    for (const id of [...cacheRef.current.keys()]) {
      if (!compositions.has(id)) {
        cacheRef.current.delete(id)
        changed = true
      }
    }
    // Generations are NOT reset: a load still in flight from before a collapse
    // must not be mistaken for the load of a re-expansion.
    for (const id of [...inflightRef.current.keys()]) {
      if (!compositions.has(id)) inflightRef.current.delete(id)
    }
    if (changed) publish()

    for (const [diagramId, composition] of compositions) {
      let session = sessionsRef.current.get(diagramId)
      if (!session) {
        // Opened, and listened to, BEFORE the first read: a change landing
        // while that read is in flight marks it stale instead of being lost.
        const opened: Session = { target: source.open(diagramId), unsubscribe: () => {}, pending: false }
        sessionsRef.current.set(diagramId, opened)
        opened.unsubscribe = opened.target.subscribe(() => scheduleStale(diagramId, 'placement'))
        session = opened
      }

      const signature = compositionSignature(composition)
      const entry = cacheRef.current.get(diagramId)
      if (entry && !entry.stale && entry.signature === signature) continue
      // Already loading exactly this, and nothing has gone stale since it started.
      if (inflightRef.current.get(diagramId) === signature) continue
      const contents = !entry || entry.stale === 'all' || entry.signature !== signature
      inflightRef.current.set(diagramId, signature)
      const generation = (generationRef.current.get(diagramId) ?? 0) + 1
      generationRef.current.set(diagramId, generation)
      const target = session.target
      void target.load(composition, { contents }).then(
        (read) => {
          if (generationRef.current.get(diagramId) !== generation) return
          if (sessionsRef.current.get(diagramId)?.target !== target) return
          // Superseded = `markStale` deleted our in-flight marker; a newer load
          // would have bumped the generation and been refused above. So the
          // delete is ours either way (unconditional: a guard here could never
          // be taken, measured by the QA lens).
          const superseded = inflightRef.current.get(diagramId) !== signature
          inflightRef.current.delete(diagramId)
          const previous = cacheRef.current.get(diagramId)
          const objects = mergeById(composition.objectIds, read.objects, previous?.objects ?? [])
          const connections = mergeById(composition.connectionIds, read.connections, previous?.connections ?? [])
          // Derived edges have no membership list to merge against: a read
          // that got them is the whole set, one that did not keeps the last.
          const derived = read.derived ?? previous?.derived ?? []
          const layouts = read.layouts ?? previous?.layouts ?? null
          // Marked stale while this was loading: kept (better than nothing on
          // screen) but left stale, so the reload already asked for runs. And
          // if the composition moved on meanwhile (A -> B -> A), this data is
          // for a set that is no longer the one on screen.
          const outOfDate = compositionSignature(source.composition(diagramId)) !== signature
          const stale: Staleness = outOfDate ? 'all' : superseded ? (previous?.stale || 'all') : false
          const membership = [...composition.connectionIds]
          const fingerprint = JSON.stringify([objects, connections, derived, layouts])
          const entry: CacheEntry = { objects, connections, membership, derived, layouts, signature, stale, fingerprint }
          cacheRef.current.set(diagramId, entry)
          if (outOfDate && !superseded) setReloadTick((t) => t + 1)
          if (fingerprint !== previous?.fingerprint) publish()
          // Derived edges that missed the read: merged into THIS entry when they
          // land, unless a newer read replaced it meanwhile.
          void read.lateDerived?.then((late) => {
            if (!late || cacheRef.current.get(diagramId) !== entry) return
            entry.derived = late
            entry.fingerprint = JSON.stringify([objects, connections, late, layouts])
            publish()
          })
        },
        (error: unknown) => {
          // The default source never rejects; an injected one that does is a
          // bug in it. The next trigger retries it.
          if (generationRef.current.get(diagramId) === generation) inflightRef.current.delete(diagramId)
          console.warn(`inline expansion: loading ${diagramId} failed`, error)
        },
      )
    }
    // `registry` and `reloadTick` are read by nothing here: they are what
    // re-runs this when a composition may have changed, or a target went stale.
  }, [targetsKey, registry, reloadTick, source, publish, scheduleStale, closeSession])

  useEffect(() => () => {
    for (const id of [...sessionsRef.current.keys()]) closeSession(id)
    cacheRef.current.clear()
    inflightRef.current.clear()
    clearTimeout(edgeEndsTimerRef.current)
    pendingEdgeIdsRef.current.clear()
  }, [closeSession])

  return { contentsRef, version }
}
