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
 * Export a landscape as a Structurizr workspace JSON — the inverse of
 * `lib/structurizr/json/`.
 *
 * This file assembles the envelope and nothing else. The three emitters below
 * are the parts with judgement in them, and they are separate modules because
 * they fail differently: a model that loses an element is a data loss, a view
 * that loses coordinates is the failure this whole feature exists to prevent,
 * and a style that emits `#fff` instead of `#ffffff` aborts a Java read of the
 * entire workspace (§7.7).
 *
 * Why JSON at all, when a DSL exporter already exists: the DSL is a SOURCE
 * format. It states the model and lets a renderer place the boxes, so every DSL
 * export throws away the arrangement the customer made by hand. JSON carries
 * x/y per element per view — it is the only representation in which a customer
 * can leave with their diagrams intact, which is the same reason they are
 * willing to arrive.
 */

import type { ExportBundle } from '../types'
import { buildWireDocumentation, buildWireModel } from './model'
import { buildWireViewConfiguration } from './styles'
import { buildWireViewSet } from './views'
import {
  buildExportContext,
  type ExportContext,
  type StructurizrJsonExportOptions,
  type WireModel,
  type WireWorkspace,
} from './types'

export type {
  ExportContext,
  StructurizrJsonExportOptions,
  WireWorkspace,
} from './types'
export { buildExportContext, createExportIds } from './types'

export interface StructurizrJsonExportResult {
  workspace: WireWorkspace
  /** Everything the export could not say faithfully, for the export report.
   *  Silence here is a claim, so an emitter that degrades something says so. */
  warnings: string[]
}

/** `model.properties` key T5 makes mandatory the moment a `group` is a path. */
const GROUP_SEPARATOR_PROPERTY = 'structurizr.groupSeparator'

/** Drop `undefined`, `[]` and `{}` — Structurizr's own writer sets
 *  `NON_EMPTY`, so an empty collection is never on the wire and a reader that
 *  distinguishes absent from empty has nothing to distinguish. */
function pruned<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) continue
    if (Array.isArray(entry) && entry.length === 0) continue
    if (typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length === 0) continue
    out[key] = entry
  }
  return out as Partial<T>
}

/**
 * Walk every `group` string the model emitter actually wrote and answer whether
 * one of them is a path.
 *
 * `ctx.nestedGroupsUsed` answers the same question from the INPUT index, and
 * that is the wrong side of the emitter to ask: a group string can also reach
 * the wire from an instance's inherited path or from a wrapper the model
 * emitter synthesised, neither of which is in `groupPathByObjectId`. Undeclared
 * nesting has no diagnostic anywhere — every reader silently treats
 * `Payments/Core` as one flat group called "Payments/Core" — so this is checked
 * against the bytes rather than against the intent.
 *
 * `literalNames` carries the other half of the judgement (§13.6): a string that
 * is somebody's whole NAME is not a path, and declaring a separator for it
 * splits one of the customer's groups in two on the way back in.
 */
function groupsAreNested(model: WireModel, separator: string, literalNames: ReadonlySet<string>): boolean {
  let nested = false
  const visit = (node: unknown): void => {
    if (nested) return
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry)
      return
    }
    if (node === null || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    const group = record.group
    if (typeof group === 'string' && group.includes(separator) && !literalNames.has(group)) {
      nested = true
      return
    }
    for (const value of Object.values(record)) visit(value)
  }
  visit(model.people)
  visit(model.softwareSystems)
  visit(model.customElements)
  visit(model.deploymentNodes)
  return nested
}

function withGroupSeparator(model: WireModel, ctx: ExportContext): WireModel {
  const literalNames = new Set([...ctx.groupById.values()].map((group) => group.name.trim()))
  if (!groupsAreNested(model, ctx.groupSeparator, literalNames)) return model
  return {
    ...model,
    properties: { ...model.properties, [GROUP_SEPARATOR_PROPERTY]: ctx.groupSeparator },
  }
}

export function buildStructurizrWorkspace(
  bundle: ExportBundle,
  options: StructurizrJsonExportOptions = {},
): StructurizrJsonExportResult {
  const ctx = buildExportContext(bundle, options)

  // The model runs first on purpose. Two entities can carry the same
  // `structurizr.id` (duplicating an imported shape copies its provenance), and
  // `ExportIds` gives it to whoever asks first — which has to be the element
  // itself, not a view row referring to it.
  const model = withGroupSeparator(buildWireModel(ctx), ctx)
  const viewSet = buildWireViewSet(ctx)
  // Composed by the styles emitter rather than assembled here: it also stamps
  // the palette and the layout scale, which are the two questions asked of an
  // exported file that renders at the wrong size or in the wrong colours.
  const configuration = pruned(buildWireViewConfiguration(ctx))
  const documentation = buildWireDocumentation(ctx)

  const workspace: WireWorkspace = {
    id: ctx.workspaceId,
    name: bundle.landscapeName,
    lastModifiedDate: ctx.now,
    lastModifiedAgent: 'maplespire/structurizr-json-export',
    // Never 'SoftwareSystem': that scope makes `hydrate()` reject a workspace
    // holding more than one system, and a diagram-scope export still carries
    // the ancestors of its members.
    configuration: { scope: 'Landscape' },
    model,
    views: { ...viewSet, ...(Object.keys(configuration).length ? { configuration } : {}) },
    ...(documentation ? { documentation } : {}),
  }

  return { workspace, warnings: [...ctx.warnings] }
}

/**
 * Serialise the way Structurizr's own writer does (§4.1):
 * `SORT_PROPERTIES_ALPHABETICALLY` at every level and `NON_EMPTY`, so `null`,
 * `""`, `[]` and `{}` never reach the file while `0` and `false` do — the
 * coordinate `"x": 0` is a placement, not an absence.
 *
 * This is cosmetic to a reader and load-bearing to a customer: workspace JSON
 * lives in git, and a file whose key order matches the one Structurizr writes
 * diffs down to the lines that actually changed. Key order is also the
 * fingerprint that says which tool wrote a file.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonicalise).filter((item) => item !== undefined)
    return items.length === 0 ? undefined : items
  }
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'object') return value === '' ? undefined : value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = canonicalise((value as Record<string, unknown>)[key])
    if (entry !== undefined) out[key] = entry
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** The downloadable file, and the exporter's entry point. Two-space indent
 *  because a customer diffs this against the workspace their other tools write,
 *  and a single line cannot be diffed at all. */
export function buildStructurizrJson(
  bundle: ExportBundle,
  options: StructurizrJsonExportOptions = {},
): string {
  return buildStructurizrJsonFile(bundle, options).text
}

/**
 * The same file, WITH the report of everything the export could not say
 * faithfully.
 *
 * This exists because `buildStructurizrJson` returning only the text meant the
 * ~20 `ctx.warn(...)` sites had no production reader at all: a customer whose
 * export renamed two systems to satisfy rule 14, dropped three shapes into
 * "Ungrouped", left two edges off a view and could not express a colour was told
 * nothing. `StructurizrJsonExportResult.warnings` documents itself as
 * "silence here is a claim" — this is what makes that claim true.
 *
 * The messages are English strings rather than i18n keys, which is deliberate
 * and matches the IMPORT side exactly (`mapWorkspace.ts` pushes English into
 * `ImportResult.warnings`, and `ImportModal` renders them under a translated
 * heading). One convention for both directions beats two.
 */
export function buildStructurizrJsonFile(
  bundle: ExportBundle,
  options: StructurizrJsonExportOptions = {},
): { text: string; warnings: string[] } {
  const { workspace, warnings } = buildStructurizrWorkspace(bundle, options)
  return { text: `${JSON.stringify(canonicalise(workspace), null, 2)}\n`, warnings }
}
