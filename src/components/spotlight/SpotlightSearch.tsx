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

import { useCallback, useMemo, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Box, ClipboardList, Layers, Zap } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Spotlight } from './Spotlight'
import type { SpotlightPreview, SpotlightPreviewField, SpotlightRow, SpotlightRowKind, SpotlightScopeButton, SpotlightSection } from './Spotlight'
import { useUIStore } from '../../stores/uiStore'
import { getDiagramIndex, useModelStore } from '../../stores/modelStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { technologyNamesOf } from '../../lib/technologyUsage'
import { orderedTagIds } from '../../lib/tags/assignments'
import { parseSpotlightQuery } from '../../lib/search/spotlight/grammar'
import type { SpotlightKind, SpotlightQuery } from '../../lib/search/spotlight/grammar'
import type { SpotlightDoc, SpotlightHit } from '../../lib/search/spotlight/evaluate'
import { mergeSpotlightTiers } from '../../lib/search/spotlight/merge'
import type { SpotlightWireDoc } from '../../lib/search/spotlight/wire'
import {
  OBJECT_KINDS, SCOPES, SPOTLIGHT_TIPS, adrLabels, buildSpotlightDocs, groupSpotlightResult, perKindFor, rankForScope,
  residentDocsByKey, spotlightSearchSource, spotlightServerRequest, spotlightSuggestions, spotlightVocabFingerprint, titleHighlights,
} from '../../lib/search/spotlightModel'
import type { RankedSpotlight, SpotlightScopeId, SpotlightSnapshot, SpotlightTip } from '../../lib/search/spotlightModel'
import { openSpotlightResult, spotlightCommands, spotlightTargetExists } from '../../lib/search/spotlightCommands'
import type { SpotlightCommand, SpotlightOpenHint } from '../../lib/search/spotlightCommands'
import { readSpotlightRecent, rememberSpotlightRecent } from '../../lib/search/spotlightRecent'
import { isServerReadModelEnabled } from '../../lib/modelQuery/tierFlag'
import { isWorkspaceSummaryActive } from '../../lib/modelQuery/summaryTier'
import { hasDeleteTombstone, isBootFromServerActive } from '../../lib/automerge/bridge'
import { workspaceRefKey } from '../../lib/automerge/workspace'
import { spotlightWorkspace } from '../../lib/search/spotlightServer'
import { useSpotlightServerAnswer } from './useSpotlightServerSearch'
import type { C4Object, Connection, DecisionRecord, Diagram, Flow, Group } from '../../types'

const SCOPE_ICONS: Readonly<Record<Exclude<SpotlightScopeId, 'all'>, LucideIcon>> = {
  diagrams: Layers, objects: Box, decisions: ClipboardList, actions: Zap,
}

/** Tips shown under Recent on an empty field; `?` lists them all. */
const EMPTY_FIELD_TIPS = 4
const EMPTY: readonly never[] = []

/** What choosing a row does, keyed by row key. `wire` is the server's document
 *  for a hit the store does not hold: its row and preview are built from it. */
type RowAction =
  | {
    readonly type: 'open'
    readonly kind: SpotlightKind
    readonly id: string
    readonly title: string
    readonly hint: SpotlightOpenHint
    readonly wire?: SpotlightWireDoc
  }
  | { readonly type: 'command'; readonly command: SpotlightCommand; readonly title: string }
  | { readonly type: 'query'; readonly query: string }

interface Built {
  readonly sections: SpotlightSection[]
  readonly actions: ReadonlyMap<string, RowAction>
  readonly tips: ReadonlyMap<string, SpotlightTip>
}

const statusKey = (status: string) => (status === 'in-progress' ? 'inProgress' : status)

/** Server documents carry `extra`; resident ones never do. */
const isWireDoc = (doc: SpotlightDoc): doc is SpotlightWireDoc => 'extra' in doc
function extraString(doc: SpotlightWireDoc, key: string): string | undefined {
  const v = doc.extra[key]
  return typeof v === 'string' && v ? v : undefined
}
function extraNumber(doc: SpotlightWireDoc, key: string): number | undefined {
  const v = doc.extra[key]
  return typeof v === 'number' ? v : undefined
}
function wireAdrLabel(doc: SpotlightWireDoc): string | undefined {
  const n = extraNumber(doc, 'number')
  return n === undefined ? undefined : adrLabels({ number: n })[1]
}
function wireDiagramCount(doc: SpotlightWireDoc): number {
  return extraNumber(doc, 'diagramCount') ?? doc.diagrams?.length ?? 0
}

/** An entity this tab deleted whose deletion the server read model may not
 *  have projected yet: the bridge's tombstones, and the store's intents the
 *  bridge has not picked up. (Groups need no case: `completeKinds` already
 *  drops every server group the store does not hold.) */
function deletedHere(kind: SpotlightKind, id: string): boolean {
  const s = useModelStore.getState()
  if (OBJECT_KINDS.has(kind)) return hasDeleteTombstone('object', id) || s.pendingDeletedObjectIds.includes(id)
  switch (kind) {
    case 'connection': return hasDeleteTombstone('connection', id) || s.pendingDeletedConnectionIds.includes(id)
    case 'diagram':
      return hasDeleteTombstone('diagram', id) || s.pendingDeletedDiagramIds.includes(id) || s.deletedDiagramIds.includes(id)
    default: return false
  }
}

/** Kinds whose every ENTITY the store holds under the server-boot contract:
 *  groups live whole in ModelMeta, and so does the diagram registry unless the
 *  workspace is summary-only (then the store holds a window of it). Their
 *  placements can still be a window, which `mergeSpotlightTiers` handles. */
function completeKinds(): ReadonlySet<SpotlightKind> {
  return new Set<SpotlightKind>(isWorkspaceSummaryActive() ? ['group'] : ['group', 'diagram'])
}

function openHint(doc: SpotlightDoc): SpotlightOpenHint {
  const diagramId = isWireDoc(doc) && doc.kind === 'flow' ? extraString(doc, 'diagramId') : undefined
  return { ...(doc.name ? { name: doc.name } : {}), ...(diagramId ? { diagramId } : {}) }
}

/**
 * The global search: the Spotlight overlay wired to the model. Opened by the
 * tool pill's search button and ⌘K / Ctrl K. Ranking is the shared search core:
 * the RESIDENT model answers at once (`spotlightModel.ts`); when the tier
 * selection picked the server read model, the server's answer for the whole
 * workspace is merged in as it arrives (`spotlightServer.ts`,
 * `mergeSpotlightTiers`), and any failure of it leaves the resident results.
 * The query and scope survive a close, as the design specifies.
 */
export function SpotlightSearch() {
  const { t, i18n } = useTranslation()
  const open = useUIStore((s) => s.searchOpen)
  const setOpen = useUIStore((s) => s.setSearchOpen)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SpotlightScopeId>('all')
  const [recentVersion, setRecentVersion] = useState(0)
  const ref = useWorkspaceStore((s) => s.ref)
  const workspaceKey = `${ref.landscapeId}:${ref.versionId}`

  // Closed, the selectors return a constant, so model edits do not re-render this.
  const objects = useModelStore((s) => (open ? s.objects : EMPTY))
  const connections = useModelStore((s) => (open ? s.connections : EMPTY))
  const groups = useModelStore((s) => (open ? s.groups : EMPTY))
  const diagrams = useModelStore((s) => (open ? s.diagrams : EMPTY))
  const flows = useModelStore((s) => (open ? s.flows : EMPTY))
  const decisionRecords = useModelStore((s) => (open ? s.decisionRecords : EMPTY))
  const domains = useModelStore((s) => (open ? s.domains : EMPTY))
  const tags = useModelStore((s) => (open ? s.tags : EMPTY))

  const snapshot = useMemo<SpotlightSnapshot>(
    () => ({ objects, connections, groups, diagrams, flows, decisionRecords, domains, tags, index: getDiagramIndex() }),
    [objects, connections, groups, diagrams, flows, decisionRecords, domains, tags],
  )

  const commands = useMemo(
    () => (open ? spotlightCommands({ blankDiagramName: t('diagramChrome.toolPill.addMenu.blankDefaultName') }) : []),
    [open, t],
  )
  const commandById = useMemo(() => new Map(commands.map((c) => [c.id, c])), [commands])
  const docs = useMemo(() => {
    if (!open) return []
    const actionDocs = commands.map((c) => ({
      id: c.id,
      title: t(`spotlight.commands.${c.id}.title`),
      keywords: t(`spotlight.commands.${c.id}.keywords`).split(/\s+/),
    }))
    return buildSpotlightDocs(snapshot, actionDocs)
  }, [open, snapshot, commands, t])
  const docByKey = useMemo(() => residentDocsByKey(docs), [docs])

  const parsed = useMemo(() => parseSpotlightQuery(query), [query])
  // What both tiers rank: the typed query, or a whole scope on an empty field.
  const source = useMemo(() => spotlightSearchSource(query, parsed, scope), [query, parsed, scope])
  const sourceQuery = useMemo(
    () => (source === null ? null : source === query ? parsed : parseSpotlightQuery(source)),
    [source, query, parsed],
  )

  // The server tier, asked when the tier selection picked it — the same
  // predicate as every other server rung (paged.ts), so the summary contract
  // enters it too — AND the store is a window (boot-from-server active). A
  // store holding the whole model already answers for everything; the server
  // could only add rows the projection has not caught up on.
  const serverTier = open && isServerReadModelEnabled() && isBootFromServerActive()
  // The server resolves `tag:` / `domain:` with the names it is sent, so a
  // renamed tag or domain is a different request.
  const vocabKey = useMemo(() => spotlightVocabFingerprint({ domains, tags }), [domains, tags])
  // What is asked about, as the request will address it: the concrete
  // workspace of this session's documents, null when it cannot be named.
  const askedRef = spotlightWorkspace()
  const askedWorkspace = askedRef ? workspaceRefKey(askedRef) : null
  const serverAsk = useMemo(() => {
    const request = serverTier && source !== null && sourceQuery !== null
      ? spotlightServerRequest(source, sourceQuery, scope, { domains, tags })
      : null
    return request
      ? { key: JSON.stringify([workspaceKey, askedWorkspace, scope, source, vocabKey]), request }
      : { key: null, request: null }
  }, [serverTier, source, sourceQuery, scope, domains, tags, workspaceKey, askedWorkspace, vocabKey])
  const { answer: serverAnswer, state: serverState } = useSpotlightServerAnswer(serverAsk.key, serverAsk.request)
  // Asked and not answered: say the results are this tab's only.
  const partial = serverAsk.key !== null && serverState.key === serverAsk.key && serverState.phase === 'done'
    && serverState.outcome?.kind !== 'answer'

  // recentVersion re-reads the list after an entry is remembered.
  const recents = useMemo(
    () => (open && recentVersion >= 0 ? readSpotlightRecent(workspaceKey) : []),
    [open, workspaceKey, recentVersion],
  )

  const kindLabel = useCallback((kind: SpotlightRowKind) => t(`spotlight.kinds.${kind}`), [t])
  /** A model value's label (`live`, `container`...), or the value itself. */
  const valueLabel = useCallback((value: string) => t(`spotlight.values.${statusKey(value)}`, { defaultValue: value }), [t])

  const entity = useCallback((kind: SpotlightKind, id: string): C4Object | Group | Connection | Diagram | Flow | DecisionRecord | undefined => {
    const index = snapshot.index
    if (OBJECT_KINDS.has(kind)) return index.objectById.get(id)
    switch (kind) {
      case 'group': return index.groupById.get(id)
      case 'connection': return getDiagramIndex().connectionById.get(id)
      case 'diagram': return index.diagramById.get(id)
      case 'flow': return snapshot.flows.find((f) => f.id === id)
      case 'adr': return snapshot.decisionRecords.find((r) => r.id === id)
      default: return undefined
    }
  }, [snapshot])

  const domainName = useCallback(
    (id: string | undefined) => (id ? snapshot.domains.find((d) => d.id === id)?.name : undefined),
    [snapshot],
  )
  const endpointName = useCallback(
    (id: string) => snapshot.index.objectById.get(id)?.name ?? snapshot.index.groupById.get(id)?.name ?? '—',
    [snapshot],
  )

  /** Title shown for a result; an unlabeled connection reads as its endpoints. */
  const displayTitle = useCallback((kind: SpotlightKind, id: string, fallback: string, wire?: SpotlightWireDoc): string => {
    if (kind === 'connection') {
      const c = entity(kind, id) as Connection | undefined
      if (c && !c.label) return `${endpointName(c.fromId)} → ${endpointName(c.toId)}`
      if (!c && wire && !wire.name) return `${wire.from || '—'} → ${wire.to || '—'}`
    }
    if (kind === 'page') return commandById.has(id) ? t(`spotlight.commands.${id}.title`) : fallback
    return fallback
  }, [entity, endpointName, commandById, t])

  /** Second line of a server hit the store does not hold, from what it carried. */
  const wireSubtitle = useCallback((kind: SpotlightKind, w: SpotlightWireDoc): string | undefined => {
    if (OBJECT_KINDS.has(kind)) {
      const where = extraString(w, 'parentName') ?? w.domain
      return [where, w.scope === 'external' ? t('spotlight.values.external') : undefined].filter(Boolean).join(' · ') || undefined
    }
    switch (kind) {
      case 'group': {
        const count = wireDiagramCount(w)
        return count ? t('spotlight.counts.diagrams', { count }) : undefined
      }
      case 'connection': return w.name ? `${w.from || '—'} → ${w.to || '—'}` : undefined
      case 'diagram': {
        const type = extraString(w, 'type')
        const where = extraString(w, 'parentName') ?? domainName(extraString(w, 'domainId'))
        return [type ? valueLabel(type) : undefined, where].filter(Boolean).join(' · ') || undefined
      }
      case 'flow': return w.diagrams?.[0]
      case 'adr': return [wireAdrLabel(w), w.status ? valueLabel(w.status) : undefined].filter(Boolean).join(' · ') || undefined
      default: return undefined
    }
  }, [domainName, valueLabel, t])

  /** Second line of a row; never repeats the kind (the view adds it to the top hit). */
  const subtitleOf = useCallback((kind: SpotlightKind, id: string, wire?: SpotlightWireDoc): string | undefined => {
    const e = entity(kind, id)
    if (!e) return wire ? wireSubtitle(kind, wire) : undefined
    if (OBJECT_KINDS.has(kind)) {
      const o = e as C4Object
      const parent = o.parentId ? snapshot.index.objectById.get(o.parentId)?.name : undefined
      const where = parent ?? domainName(o.domainId)
      return [where, o.scope === 'external' ? t('spotlight.values.external') : undefined].filter(Boolean).join(' · ') || undefined
    }
    switch (kind) {
      case 'group': {
        const count = snapshot.index.groupToDiagramIds.get(id)?.size ?? 0
        return count ? t('spotlight.counts.diagrams', { count }) : undefined
      }
      case 'connection': {
        const c = e as Connection
        return c.label ? `${endpointName(c.fromId)} → ${endpointName(c.toId)}` : undefined
      }
      case 'diagram': {
        const d = e as Diagram
        const where = d.parentObjectId ? snapshot.index.objectById.get(d.parentObjectId)?.name : domainName(d.domainId)
        return [t(`spotlight.values.${d.type}`), where].filter(Boolean).join(' · ')
      }
      case 'flow': return snapshot.index.diagramById.get((e as Flow).diagramId)?.name
      case 'adr': {
        const r = e as DecisionRecord
        return [adrLabels(r)[1], t(`spotlight.values.${statusKey(r.status)}`)].filter(Boolean).join(' · ')
      }
      default: return undefined
    }
  }, [entity, wireSubtitle, snapshot, domainName, endpointName, t])

  const built = useMemo<Built>(() => {
    const sections: SpotlightSection[] = []
    const actions = new Map<string, RowAction>()
    const tips = new Map<string, SpotlightTip>()
    if (!open) return { sections, actions, tips }
    const label = (id: string) => t(`spotlight.sections.${id}`)

    const hitRow = (hit: SpotlightHit, q: SpotlightQuery): SpotlightRow => {
      const { kind, id, name } = hit.doc
      const wire = isWireDoc(hit.doc) ? hit.doc : undefined
      const title = displayTitle(kind, id, name, wire)
      const command = kind === 'page' ? commandById.get(id) : undefined
      const key = `${kind}:${id}`
      actions.set(key, command ? { type: 'command', command, title } : { type: 'open', kind, id, title, hint: openHint(hit.doc), wire })
      return {
        key,
        kind,
        title,
        subtitle: subtitleOf(kind, id, wire),
        highlight: title === name ? titleHighlights(q, title) : undefined,
        icon: command?.icon,
        shortcut: command?.shortcut,
      }
    }
    const tipRow = (tip: SpotlightTip): SpotlightRow => {
      const key = `tip:${tip.id}`
      tips.set(key, tip)
      actions.set(key, { type: 'query', query: tip.insert || tip.example })
      return { key, kind: 'tip', title: tip.example, mono: true, completion: tip.insert || tip.example }
    }
    /** The resident ranking, with the server's answer for the same query merged in. */
    const rank = (q: SpotlightQuery): RankedSpotlight => {
      const resident = rankForScope(q, docs, scope)
      if (!serverAnswer) return resident
      return mergeSpotlightTiers(q, {
        result: resident,
        doc: (key) => docByKey.get(key),
        deleted: deletedHere,
        completeKinds: completeKinds(),
      }, serverAnswer, perKindFor(scope))
    }
    const pushGroups = (q: SpotlightQuery) => {
      const result = groupSpotlightResult(rank(q), scope)
      if (result.topHit) sections.push({ id: 'top', label: label('top'), rows: [hitRow(result.topHit, q)], top: true })
      for (const g of result.groups) {
        sections.push({ id: g.id, label: label(g.id), rows: g.hits.map((h) => hitRow(h, q)), total: g.total, totalCapped: g.totalCapped })
      }
    }

    const trimmed = query.trim()
    if (trimmed === '?') {
      sections.push({ id: 'tips', label: label('tips'), rows: SPOTLIGHT_TIPS.map(tipRow) })
      return { sections, actions, tips }
    }
    if (!trimmed) {
      if (sourceQuery) {
        // An empty field inside a scope lists the scope, name order.
        pushGroups(sourceQuery)
        return { sections, actions, tips }
      }
      const recentRows: SpotlightRow[] = []
      for (const r of recents) {
        const command = r.kind === 'page' ? commandById.get(r.id) : undefined
        if (r.kind === 'page' ? !command : !spotlightTargetExists(r.kind, r.id)) continue
        const key = `${r.kind}:${r.id}`
        // The live name when the entity is resident (it may have been renamed).
        const title = r.kind === 'page'
          ? t(`spotlight.commands.${r.id}.title`)
          : displayTitle(r.kind, r.id, nameOf(entity(r.kind, r.id)) ?? r.title)
        actions.set(key, command ? { type: 'command', command, title } : { type: 'open', kind: r.kind, id: r.id, title, hint: {} })
        recentRows.push({ key, kind: r.kind, title, subtitle: subtitleOf(r.kind, r.id), icon: command?.icon })
      }
      if (recentRows.length) sections.push({ id: 'recent', label: label('recent'), rows: recentRows })
      sections.push({ id: 'tips', label: label('tips'), rows: SPOTLIGHT_TIPS.slice(0, EMPTY_FIELD_TIPS).map(tipRow) })
      return { sections, actions, tips }
    }

    // Typing: fixes for mistakes, then values for the filter being typed, then results.
    const fixes: SpotlightRow[] = []
    for (const w of parsed.warnings) {
      if (w.code === 'unknownKey' && w.suggestion) {
        const fixed = `${query.slice(0, w.start)}${w.suggestion}${query.slice(w.end)}`
        const key = `fix:${w.start}`
        actions.set(key, { type: 'query', query: fixed })
        fixes.push({ key, kind: 'tip', title: t('spotlight.fix.key', { key: w.suggestion }), mono: true, completion: fixed,
          subtitle: t('spotlight.fix.keyHint', { typed: w.key, key: w.suggestion }) })
      } else if (w.code === 'unknownValue') {
        const fixed = `${query.slice(0, w.start)}${query.slice(w.end)}`.replace(/\s+$/, '')
        const key = `fix:${w.start}`
        actions.set(key, { type: 'query', query: fixed })
        fixes.push({ key, kind: 'tip', title: t('spotlight.fix.value', { key: w.key }), mono: true, completion: fixed,
          subtitle: t('spotlight.fix.valueHint', { value: w.value, key: w.key, expected: w.expected.join(', ') }) })
      }
    }
    if (fixes.length) sections.push({ id: 'fixes', label: label('fixes'), rows: fixes })

    const suggestions = spotlightSuggestions(parsed, snapshot).map((s): SpotlightRow => {
      const key = `suggestion:${s.insert}`
      actions.set(key, { type: 'query', query: s.insert })
      return { key, kind: 'suggestion', title: s.value, mono: true, completion: s.insert,
        subtitle: t('spotlight.suggestionMeta', { key: s.key }) }
    })
    if (suggestions.length) sections.push({ id: 'suggestions', label: label('suggestions'), rows: suggestions })

    if (sourceQuery) pushGroups(sourceQuery)
    return { sections, actions, tips }
  }, [open, query, scope, parsed, sourceQuery, docs, docByKey, serverAnswer, recents, snapshot, commandById, displayTitle, subtitleOf, entity, t])

  const scopes = useMemo<SpotlightScopeButton[]>(
    () => SCOPES.map((id) => ({ id, label: t(`spotlight.scopes.${id}`), icon: SCOPE_ICONS[id] })),
    [t],
  )

  const preview = useCallback((row: SpotlightRow): SpotlightPreview | null => {
    const action = built.actions.get(row.key)
    if (!action) return null
    if (action.type === 'query') {
      const tip = built.tips.get(row.key)
      if (tip) {
        return {
          title: tip.example,
          meta: t('spotlight.tipMeta'),
          description: t(`spotlight.tips.${tip.id}`),
          fields: [{ label: t('spotlight.fields.example'), value: tip.example, mono: true }],
          primaryLabel: t('spotlight.actions.use'),
          secondaryLabel: null,
        }
      }
      // A filter value (meta "Value for tech:") or a "did you mean" fix (its hint is the description).
      const suggestion = row.kind === 'suggestion'
      return {
        title: row.title,
        meta: suggestion ? row.subtitle ?? kindLabel(row.kind) : t('spotlight.tipMeta'),
        description: suggestion ? t('spotlight.suggestionHint') : row.subtitle,
        fields: [{ label: t('spotlight.fields.query'), value: action.query, mono: true }],
        primaryLabel: t('spotlight.actions.use'),
        secondaryLabel: null,
      }
    }
    if (action.type === 'command') {
      return {
        title: action.title,
        meta: kindLabel('page'),
        description: t(`spotlight.commands.${action.command.id}.description`),
        fields: [],
        primaryLabel: t('spotlight.actions.run'),
        secondaryLabel: null,
      }
    }
    const { kind, id, title } = action
    const e = entity(kind, id)
    // The server's document stands in only for an entity the store does not hold.
    const w = e ? undefined : action.wire
    const meta = [kindLabel(kind), subtitleOf(kind, id, w)].filter(Boolean).join(' · ')
    const fields: SpotlightPreviewField[] = []
    const index = getDiagramIndex()
    let description: string | undefined
    let secondaryLabel: string | null = null
    const techField = (tech: readonly string[] | undefined) => {
      if (tech?.length) fields.push({ label: t('spotlight.fields.technology'), value: tech.join(' · '), mono: true })
    }
    const appearsIn = (count: number) => fields.push({ label: t('spotlight.fields.appearsIn'), value: t('spotlight.counts.diagrams', { count }) })
    if (OBJECT_KINDS.has(kind) && e) {
      const o = e as C4Object
      description = o.shortDescription || o.description
      techField(technologyNamesOf(o))
      fields.push({ label: t('spotlight.fields.scope'), value: t(`spotlight.values.${o.scope}`) })
      fields.push({ label: t('spotlight.fields.status'), value: t(`spotlight.values.${statusKey(o.status)}`) })
      const domain = domainName(o.domainId)
      if (domain) fields.push({ label: t('spotlight.fields.domain'), value: domain })
      const tagNames = orderedTagIds(o).map((tid) => snapshot.tags.find((x) => x.tagId === tid)?.value).filter(Boolean)
      if (tagNames.length) fields.push({ label: t('spotlight.fields.tags'), value: tagNames.join(', ') })
      appearsIn(index.objectToDiagramIds.get(id)?.size ?? 0)
      // Two counts, two plurals: one string cannot agree with both ("1 entrante · 2 sortantes").
      fields.push({
        label: t('spotlight.fields.connections'),
        value: `${t('spotlight.counts.in', { count: index.connectionsByToId.get(id)?.length ?? 0 })} · ${t('spotlight.counts.out', { count: index.connectionsByFromId.get(id)?.length ?? 0 })}`,
        mono: true,
      })
      secondaryLabel = t('spotlight.actions.reveal')
    } else if (OBJECT_KINDS.has(kind) && w) {
      // No connection counts: the server sends none, and the store's would count the window.
      description = w.description
      techField(w.tech)
      if (w.scope) fields.push({ label: t('spotlight.fields.scope'), value: valueLabel(w.scope) })
      if (w.status) fields.push({ label: t('spotlight.fields.status'), value: valueLabel(w.status) })
      if (w.domain) fields.push({ label: t('spotlight.fields.domain'), value: w.domain })
      if (w.tags?.length) fields.push({ label: t('spotlight.fields.tags'), value: w.tags.join(', ') })
      appearsIn(wireDiagramCount(w))
      secondaryLabel = t('spotlight.actions.reveal')
    } else if (kind === 'group' && e) {
      techField(technologyNamesOf(e as Group))
      appearsIn(index.groupToDiagramIds.get(id)?.size ?? 0)
    } else if (kind === 'group' && w) {
      techField(w.tech)
      appearsIn(wireDiagramCount(w))
    } else if (kind === 'connection' && e) {
      const c = e as Connection
      description = c.description
      fields.push({ label: t('spotlight.fields.from'), value: endpointName(c.fromId) })
      fields.push({ label: t('spotlight.fields.to'), value: endpointName(c.toId) })
      techField(technologyNamesOf(c))
      appearsIn(index.connectionToDiagramIds.get(id)?.size ?? 0)
      secondaryLabel = t('spotlight.actions.showConnections')
    } else if (kind === 'connection' && w) {
      description = w.description
      fields.push({ label: t('spotlight.fields.from'), value: w.from || '—' })
      fields.push({ label: t('spotlight.fields.to'), value: w.to || '—' })
      techField(w.tech)
      appearsIn(wireDiagramCount(w))
      secondaryLabel = t('spotlight.actions.showConnections')
    } else if (kind === 'diagram' && e) {
      const d = e as Diagram
      description = d.description
      fields.push({ label: t('spotlight.fields.level'), value: t(`spotlight.values.${d.type}`) })
      fields.push({
        label: t('spotlight.fields.contents'),
        value: t('spotlight.counts.contents', { objects: d.objectIds.length, connections: d.connectionIds.length }),
        mono: true,
      })
      const domain = domainName(d.domainId)
      if (domain) fields.push({ label: t('spotlight.fields.domain'), value: domain })
      secondaryLabel = t('spotlight.actions.newTab')
    } else if (kind === 'diagram' && w) {
      const type = extraString(w, 'type')
      if (type) fields.push({ label: t('spotlight.fields.level'), value: valueLabel(type) })
      fields.push({
        label: t('spotlight.fields.contents'),
        value: t('spotlight.counts.contents', { objects: extraNumber(w, 'objectCount') ?? 0, connections: extraNumber(w, 'connectionCount') ?? 0 }),
        mono: true,
      })
      const domain = domainName(extraString(w, 'domainId'))
      if (domain) fields.push({ label: t('spotlight.fields.domain'), value: domain })
      secondaryLabel = t('spotlight.actions.newTab')
    } else if (kind === 'flow' && e) {
      const f = e as Flow
      const diagram = index.diagramById.get(f.diagramId)?.name
      if (diagram) fields.push({ label: t('spotlight.fields.diagram'), value: diagram })
      fields.push({ label: t('spotlight.fields.steps'), value: t('spotlight.counts.steps', { count: f.steps.length }), mono: true })
    } else if (kind === 'flow' && w) {
      const diagram = w.diagrams?.[0]
      if (diagram) fields.push({ label: t('spotlight.fields.diagram'), value: diagram })
    } else if (kind === 'adr' && (e || w)) {
      const r = e as DecisionRecord | undefined
      description = r ? r.summary : w && extraString(w, 'summary')
      const adrLabel = r ? adrLabels(r)[1] : w && wireAdrLabel(w)
      if (adrLabel) fields.push({ label: t('spotlight.fields.id'), value: adrLabel, mono: true })
      const status = r?.status ?? w?.status
      if (status) fields.push({ label: t('spotlight.fields.status'), value: valueLabel(status) })
      const updated = new Date((r ? r.updatedAt : w && extraString(w, 'updatedAt')) ?? '')
      if (!Number.isNaN(updated.getTime())) {
        fields.push({ label: t('spotlight.fields.updated'), value: updated.toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric' }) })
      }
    }
    return { title, meta, description: description?.slice(0, 600), fields, primaryLabel: t('spotlight.actions.open'), secondaryLabel }
  }, [built, entity, subtitleOf, kindLabel, valueLabel, domainName, endpointName, snapshot, i18n.language, t])

  const onChoose = useCallback((row: SpotlightRow, modifier: 'none' | 'meta') => {
    const action = built.actions.get(row.key)
    if (!action) return
    if (action.type === 'query') {
      setQuery(action.query)
      return
    }
    setOpen(false)
    if (action.type === 'command') {
      rememberSpotlightRecent(workspaceKey, { kind: 'page', id: action.command.id, title: action.title })
      setRecentVersion((v) => v + 1)
      action.command.run()
      return
    }
    rememberSpotlightRecent(workspaceKey, { kind: action.kind, id: action.id, title: action.title })
    setRecentVersion((v) => v + 1)
    openSpotlightResult(action.kind, action.id, modifier, action.hint)
  }, [built, setOpen, workspaceKey])

  const onScopeChange = useCallback((next: string) => {
    setScope(next === 'all' || (SCOPES as readonly string[]).includes(next) ? (next as SpotlightScopeId) : 'all')
  }, [])

  return (
    <Spotlight
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQueryChange={setQuery}
      scope={scope}
      onScopeChange={onScopeChange}
      scopes={scopes}
      sections={built.sections}
      onChoose={onChoose}
      preview={preview}
      kindLabel={kindLabel}
      emptyHint={t('spotlight.emptyHint')}
      notice={partial && source !== null ? t('spotlight.partialNotice') : undefined}
    />
  )
}

function nameOf(e: unknown): string | undefined {
  if (!e || typeof e !== 'object') return undefined
  const v = e as { name?: unknown; title?: unknown; label?: unknown }
  const name = v.name ?? v.title ?? v.label
  return typeof name === 'string' ? name : undefined
}
