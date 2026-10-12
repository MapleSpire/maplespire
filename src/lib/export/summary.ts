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

import type { C4Object, C4Type, Connection, Flow } from '../../types'
import type { ExportBundle, SummaryScope, SummarySlice } from './types'
import i18n from '../i18n'
import { orderedTechnologyUsages } from '../technologyUsage'
import { referencedTagSnapshots } from '../tags/assignments'

/** Pick the slice of the bundle a summary covers. `pickId` names the domain /
 * object / diagram when the scope needs one; ignored for `landscape`. */
export function sliceForSummary(bundle: ExportBundle, scope: SummaryScope, pickId?: string): SummarySlice {
  const allFlows = Object.values(bundle.flowsByDiagram).flat()
  const byId = new Map(bundle.objects.map((o) => [o.id, o]))

  let objects: C4Object[] = bundle.objects
  let flows: Flow[] = allFlows
  let scopeLabel = i18n.t('exportEngine.scope.landscape')

  if (scope === 'domain' && pickId) {
    const domain = bundle.domains.find((d) => d.id === pickId)
    objects = bundle.objects.filter((o) => o.domainId === pickId)
    scopeLabel = i18n.t('exportEngine.scope.domain', { name: domain?.name ?? i18n.t('exportEngine.scope.unknown') })
  } else if (scope === 'object' && pickId) {
    const root = byId.get(pickId)
    const inScope = new Set<string>()
    if (root) {
      inScope.add(root.id)
      // Descendants via parentId, in passes (the object tree is shallow).
      let grew = true
      while (grew) {
        grew = false
        for (const o of bundle.objects) {
          if (!inScope.has(o.id) && o.parentId && inScope.has(o.parentId)) {
            inScope.add(o.id)
            grew = true
          }
        }
      }
    }
    objects = bundle.objects.filter((o) => inScope.has(o.id))
    scopeLabel = i18n.t('exportEngine.scope.object', { name: root?.name ?? i18n.t('exportEngine.scope.unknown') })
  } else if (scope === 'diagram' && pickId) {
    const diagram = bundle.diagrams.find((d) => d.id === pickId)
    const ids = new Set(diagram?.objectIds ?? [])
    objects = bundle.objects.filter((o) => ids.has(o.id))
    flows = bundle.flowsByDiagram[pickId] ?? []
    scopeLabel = i18n.t('exportEngine.scope.diagram', { name: diagram?.name ?? i18n.t('exportEngine.scope.unknown') })
  }

  const objectIds = new Set(objects.map((o) => o.id))
  // Connections touching the scope; both endpoints resolve in the summary text.
  const connections = bundle.connections.filter((c) => objectIds.has(c.fromId) || objectIds.has(c.toId))
  if (scope !== 'diagram' && scope !== 'landscape') {
    flows = allFlows.filter((f) =>
      f.steps.some(
        (s) =>
          (s.type === 'process' && objectIds.has(s.objectId)) ||
          (s.type === 'message' && (objectIds.has(s.fromObjectId) || objectIds.has(s.toObjectId))),
      ),
    )
  }
  const tags = referencedTagSnapshots(objects, bundle.tags)
  const domainIds = new Set(objects.map((o) => o.domainId).filter(Boolean))
  const domains = bundle.domains.filter((d) => domainIds.has(d.id) || (scope === 'domain' && d.id === pickId))

  return { scopeLabel, objects, connections, flows, tags, domains }
}

// ── The structured summary all four renderers share ───────────────────────────

export interface SummaryModel {
  title: string
  landscapeName: string
  generatedAt: string
  scopeLabel: string
  counts: { objects: number; connections: number; flows: number; tags: number }
  domains: Array<{ name: string; description?: string; objectCount: number }>
  objectGroups: Array<{
    type: C4Type
    objects: Array<{
      name: string
      external: boolean
      status: string
      technology: string
      description?: string
      tags: string[]
      domain?: string
      parent?: string
    }>
  }>
  connections: Array<{ from: string; to: string; label?: string; status: string }>
  flows: Array<{ name: string; diagram?: string; steps: string[] }>
  tags: Array<{ name: string; count: number }>
}

const TYPE_ORDER: C4Type[] = ['actor', 'system', 'app', 'store', 'component']
export const TYPE_LABEL: Record<C4Type, string> = {
  actor: 'Actors',
  system: 'Systems',
  app: 'Apps',
  store: 'Stores',
  component: 'Components',
}

const technologyNames = (o: C4Object): string =>
  orderedTechnologyUsages(o.technologyUsages, o.technologyUsageOrder).map((usage) => usage.snapshot.name).join(', ')

function flowStepText(step: Flow['steps'][number], nameOf: (id: string) => string): string {
  switch (step.type) {
    case 'message':
      return i18n.t('exportEngine.flowStep.message', {
        from: nameOf(step.fromObjectId),
        to: nameOf(step.toObjectId),
        title: step.title,
      })
    case 'process':
      return i18n.t('exportEngine.flowStep.process', { obj: nameOf(step.objectId), title: step.title })
    default:
      return step.title
  }
}

export function buildSummaryModel(bundle: ExportBundle, slice: SummarySlice): SummaryModel {
  const byId = new Map(bundle.objects.map((o) => [o.id, o]))
  const nameOf = (id: string) => byId.get(id)?.name ?? 'unknown'
  const domainName = (id?: string) => bundle.domains.find((d) => d.id === id)?.name
  const tagById = new Map(slice.tags.map((tag) => [tag.tagId, tag]))

  const objectGroups = TYPE_ORDER.map((type) => ({
    type,
    objects: slice.objects
      .filter((o) => o.type === type)
      .map((o) => ({
        name: o.name,
        external: o.scope === 'external',
        status: o.status,
        technology: technologyNames(o),
        description: o.description || undefined,
        tags: o.tagOrder.map((tagId) => tagById.get(tagId)?.value ?? tagId),
        domain: domainName(o.domainId),
        parent: o.parentId ? byId.get(o.parentId)?.name : undefined,
      })),
  })).filter((g) => g.objects.length > 0)

  const connections = slice.connections.map((c: Connection) => ({
    from: nameOf(c.fromId),
    to: nameOf(c.toId),
    label: c.label || undefined,
    status: c.status ?? 'live',
  }))

  const diagramName = (id: string) => bundle.diagrams.find((d) => d.id === id)?.name
  const flows = slice.flows.map((f) => ({
    name: f.name,
    diagram: diagramName(f.diagramId),
    steps: [...f.steps].sort((a, b) => a.order - b.order).map((s) => flowStepText(s, nameOf)),
  }))

  const tags = slice.tags.map((tag) => ({
    name: `${tag.groupName}: ${tag.value}`,
    count: slice.objects.filter((object) => object.tagAssignments?.[tag.tagId]).length,
  }))

  return {
    title: i18n.t('exportEngine.docTitle', { landscape: bundle.landscapeName }),
    landscapeName: bundle.landscapeName,
    generatedAt: bundle.generatedAt,
    scopeLabel: slice.scopeLabel,
    counts: {
      objects: slice.objects.length,
      connections: slice.connections.length,
      flows: slice.flows.length,
      tags: slice.tags.length,
    },
    domains: slice.domains.map((d) => ({
      name: d.name,
      description: d.description || undefined,
      objectCount: slice.objects.filter((o) => o.domainId === d.id).length,
    })),
    objectGroups,
    connections,
    flows,
    tags,
  }
}

// ── Renderers ──────────────────────────────────────────────────────────────────

const describeLine = (o: SummaryModel['objectGroups'][number]['objects'][number]): string => {
  const bits: string[] = []
  if (o.external) bits.push(i18n.t('exportEngine.describe.external'))
  if (o.status !== 'live') bits.push(o.status)
  if (o.technology) bits.push(o.technology)
  if (o.domain) bits.push(i18n.t('exportEngine.describe.domain', { name: o.domain }))
  if (o.parent) bits.push(i18n.t('exportEngine.describe.inside', { name: o.parent }))
  if (o.tags.length) bits.push(i18n.t('exportEngine.describe.tags', { names: o.tags.join(', ') }))
  return bits.join(' · ')
}

export function renderSummaryMarkdown(m: SummaryModel): string {
  const lines: string[] = []
  lines.push(`# ${m.title}`)
  lines.push('')
  lines.push(
    i18n.t('exportEngine.meta.markdown', {
      scope: m.scopeLabel,
      objects: m.counts.objects,
      connections: m.counts.connections,
      flows: m.counts.flows,
      date: m.generatedAt.slice(0, 10),
    }),
  )
  if (m.domains.length) {
    lines.push('', `## ${i18n.t('exportEngine.sections.domains')}`, '')
    for (const d of m.domains) {
      lines.push(`- **${d.name}** (${i18n.t('exportEngine.objectCount', { count: d.objectCount })})${d.description ? ` — ${d.description}` : ''}`)
    }
  }
  lines.push('', `## ${i18n.t('exportEngine.sections.modelObjects')}`)
  for (const g of m.objectGroups) {
    lines.push('', `### ${TYPE_LABEL[g.type]}`, '')
    for (const o of g.objects) {
      const meta = describeLine(o)
      lines.push(`- **${o.name}**${meta ? ` (${meta})` : ''}${o.description ? ` — ${o.description}` : ''}`)
    }
  }
  if (m.connections.length) {
    lines.push('', `## ${i18n.t('exportEngine.sections.connections')}`, '')
    for (const c of m.connections) {
      lines.push(`- ${c.from} → ${c.to}${c.label ? `: ${c.label}` : ''}${c.status !== 'live' ? ` (${c.status})` : ''}`)
    }
  }
  if (m.flows.length) {
    lines.push('', `## ${i18n.t('exportEngine.sections.flows')}`)
    for (const f of m.flows) {
      lines.push('', `### ${f.name}${f.diagram ? ` (${f.diagram})` : ''}`, '')
      f.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
    }
  }
  if (m.tags.length) {
    lines.push('', `## ${i18n.t('exportEngine.sections.tags')}`, '')
    for (const t of m.tags) lines.push(`- ${t.name} (${i18n.t('exportEngine.objectCount', { count: t.count })})`)
  }
  lines.push('')
  return lines.join('\n')
}

/** llms.txt — the markdown summary under the llms.txt convention: an H1, a one-line
 * `>` blurb, then flat H2 sections a model can chunk cleanly. */
export function renderSummaryLlmsTxt(m: SummaryModel): string {
  const md = renderSummaryMarkdown(m)
  const blurb = `> ${i18n.t('exportEngine.llmsBlurb', { landscape: m.landscapeName, scope: m.scopeLabel })}`
  const [firstLine, ...rest] = md.split('\n')
  return [firstLine, '', blurb, ...rest].join('\n')
}

const escHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A self-contained HTML page (inline styles only — no external assets). */
export function renderSummaryHtml(m: SummaryModel): string {
  const parts: string[] = []
  parts.push('<!doctype html>')
  parts.push(`<html lang="${i18n.language}"><head><meta charset="utf-8">`)
  parts.push(`<title>${escHtml(m.title)}</title>`)
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">')
  parts.push(
    '<style>body{font-family:Inter,system-ui,sans-serif;color:#1E1D1B;background:#FFFFFF;margin:0;padding:48px 24px;line-height:1.55}main{max-width:760px;margin:0 auto}h1{font-size:24px;letter-spacing:-.02em;margin:0 0 6px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid #ECEAE6;padding-bottom:6px}h3{font-size:13.5px;margin:16px 0 6px;color:#4A463F}p.meta{color:#6E6961;font-size:12.5px;margin:0 0 18px}ul,ol{margin:6px 0;padding-left:22px}li{font-size:13px;margin:3px 0}li b{font-weight:600}.muted{color:#6E6961}.chip{display:inline-block;font-size:11px;color:#4A463F;background:#F1EFEB;border-radius:999px;padding:1px 8px;margin-left:6px}</style>',
  )
  parts.push('</head><body><main>')
  parts.push(`<h1>${escHtml(m.title)}</h1>`)
  parts.push(
    `<p class="meta">${escHtml(
      i18n.t('exportEngine.meta.htmlOrPdf', {
        scope: m.scopeLabel,
        objects: m.counts.objects,
        connections: m.counts.connections,
        flows: m.counts.flows,
        date: m.generatedAt.slice(0, 10),
      }),
    )}</p>`,
  )
  if (m.domains.length) {
    parts.push(`<h2>${escHtml(i18n.t('exportEngine.sections.domains'))}</h2><ul>`)
    for (const d of m.domains) {
      parts.push(
        `<li><b>${escHtml(d.name)}</b><span class="chip">${escHtml(i18n.t('exportEngine.objectCount', { count: d.objectCount }))}</span>${d.description ? ` <span class="muted">— ${escHtml(d.description)}</span>` : ''}</li>`,
      )
    }
    parts.push('</ul>')
  }
  parts.push(`<h2>${escHtml(i18n.t('exportEngine.sections.modelObjects'))}</h2>`)
  for (const g of m.objectGroups) {
    parts.push(`<h3>${TYPE_LABEL[g.type]}</h3><ul>`)
    for (const o of g.objects) {
      const meta = describeLine(o)
      parts.push(
        `<li><b>${escHtml(o.name)}</b>${meta ? ` <span class="muted">(${escHtml(meta)})</span>` : ''}${o.description ? ` — ${escHtml(o.description)}` : ''}</li>`,
      )
    }
    parts.push('</ul>')
  }
  if (m.connections.length) {
    parts.push(`<h2>${escHtml(i18n.t('exportEngine.sections.connections'))}</h2><ul>`)
    for (const c of m.connections) {
      parts.push(
        `<li>${escHtml(c.from)} → ${escHtml(c.to)}${c.label ? `: ${escHtml(c.label)}` : ''}${c.status !== 'live' ? ` <span class="muted">(${escHtml(c.status)})</span>` : ''}</li>`,
      )
    }
    parts.push('</ul>')
  }
  if (m.flows.length) {
    parts.push(`<h2>${escHtml(i18n.t('exportEngine.sections.flows'))}</h2>`)
    for (const f of m.flows) {
      parts.push(`<h3>${escHtml(f.name)}${f.diagram ? ` <span class="muted">(${escHtml(f.diagram)})</span>` : ''}</h3><ol>`)
      for (const s of f.steps) parts.push(`<li>${escHtml(s)}</li>`)
      parts.push('</ol>')
    }
  }
  if (m.tags.length) {
    parts.push(`<h2>${escHtml(i18n.t('exportEngine.sections.tags'))}</h2><ul>`)
    for (const t of m.tags)
      parts.push(`<li>${escHtml(t.name)}<span class="chip">${escHtml(i18n.t('exportEngine.objectCount', { count: t.count }))}</span></li>`)
    parts.push('</ul>')
  }
  parts.push('</main></body></html>')
  return parts.join('\n')
}
