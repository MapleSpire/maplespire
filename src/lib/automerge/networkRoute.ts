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

import type { WorkspaceRef } from './workspace'

export interface NetworkAdapterLike {
  disconnect(): void
}

export interface NetworkSubsystemLike<TAdapter extends NetworkAdapterLike> {
  addNetworkAdapter(adapter: TAdapter): void
  removeNetworkAdapter(adapter: TAdapter): void
}

/** Build the only supported browser sync URL: every socket declares exactly
 * one workspace. Existing deployment query parameters are preserved. */
export function workspaceWebSocketUrl(baseUrl: string, ref: WorkspaceRef): string {
  const url = new URL(baseUrl)
  url.searchParams.set('landscapeId', ref.landscapeId)
  url.searchParams.set('versionId', ref.versionId)
  return url.toString()
}

/** Keeps one network adapter attached to the offline-first Repo. Switching a
 * workspace removes the old transport before the new one can announce local
 * documents, so one Automerge peer never spans two routed workspaces at once. */
export class WorkspaceNetworkRouter<TAdapter extends NetworkAdapterLike> {
  private adapter: TAdapter | null = null
  private routeKey: string | null = null
  private readonly network: NetworkSubsystemLike<TAdapter>
  private readonly createAdapter: (url: string) => TAdapter
  private readonly baseUrl: string

  constructor(
    network: NetworkSubsystemLike<TAdapter>,
    createAdapter: (url: string) => TAdapter,
    baseUrl: string,
  ) {
    this.network = network
    this.createAdapter = createAdapter
    this.baseUrl = baseUrl
  }

  async route(ref: WorkspaceRef, force = false): Promise<void> {
    const nextKey = `${ref.landscapeId}\0${ref.versionId}`
    if (!force && this.routeKey === nextKey && this.adapter) return

    const previous = this.adapter
    this.adapter = null
    this.routeKey = null
    if (previous) this.network.removeNetworkAdapter(previous)

    const next = this.createAdapter(workspaceWebSocketUrl(this.baseUrl, ref))
    this.adapter = next
    this.routeKey = nextKey
    this.network.addNetworkAdapter(next)
    // NetworkSubsystem schedules adapter.connect() through its peer-metadata
    // promise. Yield once so a serialized workspace switch cannot immediately
    // remove an adapter before that initialization microtask has run.
    await Promise.resolve()
  }
}
