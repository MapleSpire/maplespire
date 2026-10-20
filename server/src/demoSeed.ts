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

import type { Repo, DocHandle } from '@automerge/automerge-repo'
import { writeWorkspaceContent } from './automergeMigrate.js'
import { findReadyDocument } from './automergeRepoCompat.js'
import { DEMO_SEED, type DemoSeed } from './demoSeed.gen.js'

/**
 * Seed the demo into the default workspace's root while it is still
 * UNPUBLISHED — `ensureRootDoc` calls this before `repo.flush()` and before it
 * writes `root_url`, so the whole demo is durable before any client can reach
 * the root, and no client can ever see part of it.
 *
 * Why the browser no longer does this: it wrote the DiagramDocs, the model and
 * a registry entry as separate documents, which reach the server
 * independently. Measured 2026-10-18 (dev:local, AUTH off, fresh database), a
 * tab closed ~1.5 s after load left one of two partial seeds, depending on
 * timing: the model without its registry entries (every later client saw
 * objects, skipped the seed, and never showed a diagram), or registry entries
 * whose DiagramDocs never arrived ("Document … is unavailable"). Ordering the
 * client's writes cannot fix the first: two documents never land atomically.
 * Publishing the root is the one atomic act available, so the seed goes
 * before it.
 *
 * Seeds only an EMPTY workspace (no model object, no registry entry), the same
 * rule the client applied, so a legacy migration that produced content wins.
 * Returns whether it seeded.
 */
export async function seedDemoIntoUnpublishedRoot(
  repo: Repo,
  rootHandle: DocHandle<Record<string, unknown>>,
  modelHandle: DocHandle<Record<string, unknown>>,
  seed: DemoSeed = DEMO_SEED,
): Promise<boolean> {
  const model = modelHandle.doc() as { objects?: Record<string, unknown> } | undefined
  if (Object.keys(model?.objects ?? {}).length > 0) return false
  const root = rootHandle.doc() as { shardUrls?: string[] } | undefined
  for (const url of root?.shardUrls ?? []) {
    const shard = await findReadyDocument<{ diagrams?: Record<string, unknown> }>(repo, url)
    if (Object.keys(shard.doc()?.diagrams ?? {}).length > 0) return false
  }
  await writeWorkspaceContent(repo, rootHandle, modelHandle, seed.model, seed.diagrams)
  return true
}
