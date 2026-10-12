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
 * THE ONE FRAME THIS SOCKET CARRIES THAT IS NOT AUTOMERGE'S.
 *
 * The browser puts its workspace ref on the sync url VERBATIM, and the app's
 * default ref is `'current'` — a MOVING pointer. So after an admin repoints
 * `landscapes.default_version_id`, the next reconnect of an already-open tab is
 * canonicalised to the NEW version while that tab's Repo still holds the OLD
 * one's documents. Without this frame, every document that tab holds is denied
 * `workspace-mismatch`, permanently, and its later work is lost while the save
 * badge still reads as saving.
 *
 * The client cannot detect that by ASKING. A second resolution of `current`
 * answers "what would a fresh lookup return", not "what did THIS socket bind",
 * and the two diverge for exactly as long as any cache holds. Worse, under `syncCells/routerMain.ts` the
 * binding happens in a different PROCESS from the one an HTTP call would
 * reach. So the binding has to travel on the socket that was bound.
 *
 * ## Why a top-level type, against this repo's own precedent
 *
 * Diagram presence — the only other MapleSpire-specific traffic on `/automerge`
 * — deliberately rides INSIDE automerge-repo's `ephemeral` message with a
 * payload discriminator (`diagramPresenceGate.ts`'s `DIAGRAM_PRESENCE_CHANNEL`).
 * That precedent is real and it argues against this file. It is departed from
 * on purpose, for one reason: `ephemeral` is addressed to a DOCUMENT and fanned
 * out to that document's peers, and a workspace binding is a property of the
 * CONNECTION with exactly one recipient. There is no document to hang it on at
 * the moment the socket is bound, and borrowing one would be the worse layering
 * violation.
 *
 * Two things make the departure cheap: the browser adapter is ALREADY a demultiplexer (it filters `peer` and `error`
 * before emitting anything to the NetworkSubsystem), and an older client that
 * does not know this type hands it to `NetworkSubsystem`, which warns on
 * `!isRepoMessage(msg)` and returns — a logged no-op, not a crash. Rollout is
 * safe in both directions.
 *
 * The type is NAMESPACED so it can never collide with an automerge-repo message
 * type, present or future.
 */

import { encode } from 'cbor-x'
import type { WorkspaceKey } from '../rbac/docScope.js'

/** Namespaced, for the same reason `DIAGRAM_PRESENCE_CHANNEL` is. */
export const WORKSPACE_BINDING_TYPE = 'maplespire.workspace-binding'

export interface WorkspaceBindingFrame {
  type: typeof WORKSPACE_BINDING_TYPE
  landscapeId: string
  versionId: string
}

/**
 * The frame for a socket the server just bound to `workspace`.
 *
 * Takes the ALREADY-BOUND key rather than re-resolving anything: this module
 * must never become yet another place that answers "what does `current`
 * resolve to".
 */
export function encodeWorkspaceBinding(workspace: WorkspaceKey): Uint8Array {
  const frame: WorkspaceBindingFrame = {
    type: WORKSPACE_BINDING_TYPE,
    landscapeId: workspace.landscapeId,
    versionId: workspace.versionId,
  }
  return encode(frame)
}
