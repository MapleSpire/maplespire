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

import { z } from 'zod'
import { defineAiTool, type AiToolDef } from '../toolRegistry.js'
import { AiToolError } from '../toolContext.js'
import {
  createDraft, listDrafts, getLandscape, createVersion, setDefaultVersion,
  type VersionRow,
} from '../../../landscapes.js'
import { computeDraftChanges } from '../../../draft/changes.js'
import { applyMerge } from '../../../draft/applyMerge.js'
import type { Repo } from '@automerge/automerge-repo'
import type { AiToolCtx } from '../toolContext.js'

/**
 * THE BOUNDARY WITH THE BOOTSTRAP FAMILY.
 *
 * `AiToolCtx.repo` is sealed so an AI tool cannot create a document that
 * nobody claims. Three operations in this file legitimately need the unsealed
 * repo, and they are not exceptions to the rule — they belong to a DIFFERENT
 * claiming discipline, the one `createClaimedDocument`'s docblock excludes by
 * name: when a draft or a version is created there is no `versions` row yet to
 * claim against, so the bootstrap family traces document ids and claims them at
 * PUBLICATION instead of at creation.
 *
 * Sealing into that family would mean adding an opening at each of its
 * **seventeen** `repo.create` sites — `forkRoot.ts` (1), `automergeServer.ts`
 * `createEmptyRoot` (7), `draft/sparse.ts` `createSparseDraftRoot` (6),
 * `applyMerge.ts` (3) — which trades one honest boundary for seventeen.
 *
 * This is also the WIDEST of the seal's three widenings, and the only one
 * outside a module that owns claiming — `sealedRepo.ts` lists all three.
 *
 * The three are `createDraft`, `createVersion` and `applyMerge`. Every other
 * workflow operation in this file is a read and takes the sealed repo
 * unchanged.
 *
 * ⚠ THAT IS A CONVENTION, NOT A GATE: a new write tool added below that calls
 * this function compiles, lints and passes, and receives the FULL `Repo`
 * permanently. Enforcing it would need an eslint `files:` allow-list — as
 * its OWN rule entry, because the exemption blocks in `eslint.config.js`
 * disable a rule id rather than a selector, so a selector appended to the
 * existing `no-restricted-syntax` array would ship dead. Not covered today.
 */
function bootstrapRepo(ctx: AiToolCtx): Repo {
  return ctx.repo as Repo
}

/**
 * Workflow tools — drafts (fork/diff/merge) and versions. These operate on the
 * LANDSCAPE the current workspace belongs to, reusing the same server code the
 * REST endpoints use (landscapes.ts, draft/*).
 *
 * Workspace switching: the server cannot switch a client's open workspace, so
 * `switch_workspace` (and draft/version creation) return a structured
 * `{ action: 'switch-workspace', … }` payload. The web sidepanel renders it as
 * a switch button; MCP/REST callers instead pass `versionId` on later calls.
 */

function draftRow(d: VersionRow) {
  return {
    id: d.id,
    label: d.label,
    status: d.status,
    parentVersionId: d.parentVersionId,
    createdAt: d.createdAt,
  }
}

function switchPayload(landscapeId: string, versionId: string, note: string) {
  return {
    action: 'switch-workspace',
    landscapeId,
    versionId,
    note,
  }
}

export const workflowTools: AiToolDef[] = [
  defineAiTool({
    name: 'list_drafts',
    title: 'List drafts',
    description:
      "List this landscape's drafts (isolated forks of the live model with lifecycle status: active/merged/discarded/archived).",
    mode: 'read',
    schema: z.object({}),
    execute: async (ctx) => {
      const drafts = await listDrafts(ctx.workspace.landscapeId)
      return { drafts: drafts.map(draftRow) }
    },
  }),
  defineAiTool({
    name: 'create_draft',
    title: 'Create draft',
    description:
      'Create a draft — an isolated fork of the live model to make changes safely, review them, then merge. After creating, make your edits INSIDE the draft (web: switch workspace; MCP: pass versionId=<draft id> on subsequent tool calls).',
    mode: 'write',
    schema: z.object({ label: z.string().min(1).describe('Draft name, e.g. "AI: add payments service"') }),
    execute: async (ctx, input) => {
      const draft = await createDraft(bootstrapRepo(ctx), ctx.workspace.landscapeId, input.label)
      if (!draft) throw new AiToolError('landscape or its default version not found', 404)
      return {
        draft: draftRow(draft),
        switch: switchPayload(
          ctx.workspace.landscapeId,
          draft.id,
          `Draft "${input.label}" created. Work inside it by using versionId="${draft.id}".`
        ),
      }
    },
  }),
  defineAiTool({
    name: 'get_draft_changes',
    title: 'Get draft changes',
    description:
      "A draft's 3-way diff against the live model: created/updated/deleted entities, diagram changes, and any conflicts that would block a merge.",
    mode: 'read',
    schema: z.object({ draftId: z.string() }),
    execute: async (ctx, input) => {
      const result = await computeDraftChanges(ctx.repo, ctx.workspace.landscapeId, input.draftId)
      if (!result) throw new AiToolError('draft not found or has no captured base', 404)
      return result
    },
  }),
  defineAiTool({
    name: 'merge_draft',
    title: 'Merge draft',
    description:
      'Merge a draft into the live model. Blocked (with the conflict list) when the live model changed the same things — pass resolutions keyed "<collection>:<id>" (+":<diagramId>" for diagram-scoped entries) with "draft" or "live" to settle each conflict.',
    mode: 'write',
    schema: z.object({
      draftId: z.string(),
      resolutions: z.record(z.string(), z.enum(['draft', 'live'])).optional(),
    }),
    execute: async (ctx, input) => {
      // The merge writes into the draft's PARENT version — require write there
      // (mirrors the REST route's requireVersionWrite on parent_version_id).
      const { rows } = await ctx.db.query<{ parent_version_id: string | null }>(
        `SELECT parent_version_id FROM versions WHERE id = $1 AND landscape_id = $2 AND kind = 'draft'`,
        [input.draftId, ctx.workspace.landscapeId]
      )
      if (rows.length === 0) throw new AiToolError(`no draft with id "${input.draftId}"`, 404)
      const parent = rows[0].parent_version_id
      if (parent) await ctx.assertWriteOn({ landscapeId: ctx.workspace.landscapeId, versionId: parent })

      const result = await applyMerge(bootstrapRepo(ctx), ctx.workspace.landscapeId, input.draftId, input.resolutions ?? {})
      if (!result) throw new AiToolError('draft not found or not mergeable (discarded/archived?)', 404)
      if (!result.ok) {
        if ('blocked' in result) return { merged: false, blocked: result.blocked }
        return {
          merged: false,
          conflicts: result.conflicts,
          hint: 'Re-call merge_draft with resolutions choosing "draft" or "live" per conflict key.',
        }
      }
      ctx.session.invalidate()
      return { merged: true, snapshotVersionId: result.versionId }
    },
  }),
  defineAiTool({
    name: 'list_versions',
    title: 'List versions',
    description:
      "List this landscape's editable versions (each is an independent copy of the model) and which one is the default (live).",
    mode: 'read',
    schema: z.object({}),
    execute: async (ctx) => {
      const landscape = await getLandscape(ctx.workspace.landscapeId)
      if (!landscape) throw new AiToolError('landscape not found', 404)
      return {
        landscapeId: landscape.id,
        landscapeName: landscape.name,
        defaultVersionId: landscape.defaultVersionId,
        currentVersionId: ctx.workspace.versionId,
        versions: landscape.versions
          .filter((v) => v.kind !== 'draft')
          .map((v) => ({
            id: v.id,
            label: v.label,
            isDefault: v.id === landscape.defaultVersionId,
            createdAt: v.createdAt,
          })),
      }
    },
  }),
  defineAiTool({
    name: 'create_version',
    title: 'Create version',
    description:
      'Create a new editable version of the landscape (a full independent copy, e.g. "Target architecture Q3"). Fork from the default version, or from another version via forkFromVersionId. To then build diagrams in it, use versionId=<new id> on subsequent calls (web: switch workspace).',
    mode: 'write',
    schema: z.object({
      label: z.string().min(1),
      forkFromVersionId: z.string().optional(),
    }),
    execute: async (ctx, input) => {
      const version = await createVersion(bootstrapRepo(ctx), ctx.workspace.landscapeId, input.label, input.forkFromVersionId)
      if (!version) throw new AiToolError('landscape or source version not found', 404)
      return {
        version: { id: version.id, label: version.label, createdAt: version.createdAt },
        switch: switchPayload(
          ctx.workspace.landscapeId,
          version.id,
          `Version "${input.label}" created. Work inside it by using versionId="${version.id}".`
        ),
      }
    },
  }),
  defineAiTool({
    name: 'set_default_version',
    title: 'Set default version',
    description:
      "Make a version the landscape's default (what everyone opens as the live model). High impact — only when the user explicitly asked.",
    mode: 'write',
    schema: z.object({ versionId: z.string() }),
    execute: async (ctx, input) => {
      const ok = await setDefaultVersion(ctx.workspace.landscapeId, input.versionId)
      if (!ok) throw new AiToolError(`version "${input.versionId}" not found in this landscape`, 404)
      ctx.session.invalidate()
      return { defaultVersionId: input.versionId }
    },
  }),
  defineAiTool({
    name: 'switch_workspace',
    title: 'Switch workspace',
    description:
      'Ask the client to switch to another landscape/version/draft. Tool calls in THIS conversation keep operating on the current workspace until the user actually switches (web) or you pass versionId explicitly (MCP/REST).',
    mode: 'read',
    schema: z.object({
      landscapeId: z.string().optional().describe('Defaults to the current landscape'),
      versionId: z.string().describe('Version or draft id to switch to'),
    }),
    execute: async (ctx, input) => {
      return switchPayload(
        input.landscapeId ?? ctx.workspace.landscapeId,
        input.versionId,
        'Ask the user to confirm the switch (web renders a switch button for this payload).'
      )
    },
  }),
]
