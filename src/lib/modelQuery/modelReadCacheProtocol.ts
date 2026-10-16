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

import type {
  CachedConnectionRecord,
  CachedConnectionInput,
  CachedDiagramRenderRecord,
  CachedDiagramManifestInput,
  ModelCacheEvictionResult,
  CachedModelEntityInput,
  CachedModelEntityRecord,
  ModelCacheOfflineDownloadCheckpoint,
  ModelCacheWorkspaceMeta,
  OfflineDownloadStatus,
  OfflineCoverage,
} from './idbSchema'

export interface ModelCachePage<T> {
  items: T[]
  nextCursor: string | null
  generation: number
  coverage: OfflineCoverage
  total?: number
}

export interface ModelCacheSearchItem extends CachedModelEntityRecord {
  matchKind: 'exact' | 'prefix' | 'contains'
}

export interface ModelCacheConnectionPage {
  items: CachedConnectionRecord[]
  nextCursor: string | null
  generation: number
  coverage: OfflineCoverage
  total: number
}

export interface ModelCacheDependencyPeer {
  peerId: string
  peer: CachedModelEntityRecord | null
  representativeConnection: CachedConnectionRecord
  connectionCount: number
  directCount: number
  lowerCount: number
}

export interface ModelCacheDependencyPage {
  items: ModelCacheDependencyPeer[]
  nextCursor: string | null
  totalPeers: number
  totalConnections: number
  generation: number
  coverage: OfflineCoverage
}

export interface ModelCacheViewerLevel {
  ancestors: CachedModelEntityRecord[]
  objects: CachedModelEntityRecord[]
  connections: CachedConnectionRecord[]
  nextCursor: string | null
  totalObjects: number
  connectionsTruncated: boolean
  generation: number
  coverage: OfflineCoverage
}

export type ModelReadCacheRequest =
  | { id: number; op: 'activateGeneration'; workspaceKey: string; generation: number; serverGeneration: number; coverage: OfflineCoverage; pinned?: boolean; preserveFull?: boolean }
  | { id: number; op: 'beginOfflineDownload'; workspaceKey: string; generation: number; serverGeneration: number; pinned: boolean; ownerId: string }
  | { id: number; op: 'upsertObjects'; workspaceKey: string; generation: number; items: CachedModelEntityInput[]; assumeAbsent?: boolean; downloadCheckpoint?: ModelCacheOfflineDownloadCheckpoint }
  | { id: number; op: 'upsertConnections'; workspaceKey: string; generation: number; items: CachedConnectionInput[]; assumeAbsent?: boolean; downloadCheckpoint?: ModelCacheOfflineDownloadCheckpoint }
  | { id: number; op: 'upsertDiagramManifests'; workspaceKey: string; generation: number; items: CachedDiagramManifestInput[]; downloadCheckpoint?: ModelCacheOfflineDownloadCheckpoint }
  | { id: number; op: 'queryChildren'; workspaceKey: string; parentId: string | null; limit: number; after?: string | null }
  | { id: number; op: 'searchObjects'; workspaceKey: string; query: string; limit: number; after?: string | null }
  | { id: number; op: 'queryConnections'; workspaceKey: string; query?: string; domainId?: string | null; sortBy?: 'name' | 'sender' | 'receiver' | 'diagrams' | 'flows'; sortAsc?: boolean; limit: number; after?: string | null }
  | { id: number; op: 'queryDependencyPeers'; workspaceKey: string; focusId: string; direction: 'incoming' | 'outgoing'; search?: string; globalSearch?: string; domainId?: string | null; limit: number; after?: string | null }
  | { id: number; op: 'queryViewerLevel'; workspaceKey: string; parentId?: string | null; query?: string; domainIds?: string[]; limit: number; connectionLimit: number; after?: string | null }
  | { id: number; op: 'deleteEntities'; workspaceKey: string; generation?: number; objectIds?: string[]; connectionIds?: string[]; diagramIds?: string[]; dropRenders?: boolean }
  | { id: number; op: 'commitServerGeneration'; workspaceKey: string; serverGeneration: number }
  | { id: number; op: 'putDiagramRender'; record: CachedDiagramRenderRecord }
  | { id: number; op: 'getDiagramRender'; workspaceKey: string; diagramId: string; generation?: number; allowLatest?: boolean }
  | { id: number; op: 'buildDiagramRender'; workspaceKey: string; diagramId: string }
  | { id: number; op: 'setOfflineDownloadState'; workspaceKey: string; ownerId: string; status: Exclude<OfflineDownloadStatus, 'running'>; errorCode?: string; errorMessage?: string }
  | { id: number; op: 'completeOfflineDownload'; workspaceKey: string; ownerId: string; generation: number }
  | { id: number; op: 'discardOfflineDownload'; workspaceKey: string }
  | { id: number; op: 'setWorkspacePolicy'; workspaceKey: string; pinned: boolean }
  | { id: number; op: 'evictDerived'; bytesToFree: number; protectWorkspaceKey?: string; maxGenerations?: number }
  | { id: number; op: 'storageStatus'; workspaceKey?: string }
  | { id: number; op: 'clearWorkspace'; workspaceKey: string }
  | { id: number; op: 'cancel'; targetId: number }

export type ModelReadCacheCommand = Exclude<ModelReadCacheRequest, { op: 'cancel' }>
export type ModelReadCacheCommandInput = ModelReadCacheCommand extends infer Command
  ? Command extends { id: number }
    ? Omit<Command, 'id'>
    : never
  : never

export type ModelReadCacheResponse =
  | { id: number; ok: true; result: unknown; durationMs: number; rowsRead: number }
  | { id: number; ok: false; error: string; errorCode?: string; durationMs: number; rowsRead: number }

export interface ModelReadCacheApi {
  activateGeneration(input: Omit<Extract<ModelReadCacheCommand, { op: 'activateGeneration' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<ModelCacheWorkspaceMeta>
  beginOfflineDownload(input: Omit<Extract<ModelReadCacheCommand, { op: 'beginOfflineDownload' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<ModelCacheWorkspaceMeta>
  upsertObjects(input: Omit<Extract<ModelReadCacheCommand, { op: 'upsertObjects' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<{ count: number }>
  upsertConnections(input: Omit<Extract<ModelReadCacheCommand, { op: 'upsertConnections' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<{ count: number }>
  upsertDiagramManifests(input: Omit<Extract<ModelReadCacheCommand, { op: 'upsertDiagramManifests' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<{ count: number }>
  queryChildren(input: Omit<Extract<ModelReadCacheCommand, { op: 'queryChildren' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<ModelCachePage<CachedModelEntityRecord>>
  searchObjects(input: Omit<Extract<ModelReadCacheCommand, { op: 'searchObjects' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<ModelCachePage<ModelCacheSearchItem>>
  queryConnections(input: Omit<Extract<ModelReadCacheCommand, { op: 'queryConnections' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<ModelCacheConnectionPage>
  queryDependencyPeers(input: Omit<Extract<ModelReadCacheCommand, { op: 'queryDependencyPeers' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<ModelCacheDependencyPage>
  queryViewerLevel(input: Omit<Extract<ModelReadCacheCommand, { op: 'queryViewerLevel' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<ModelCacheViewerLevel>
  deleteEntities(input: Omit<Extract<ModelReadCacheCommand, { op: 'deleteEntities' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<{ objectsDeleted: number; connectionsDeleted: number; diagramsDeleted: number }>
  commitServerGeneration(input: Omit<Extract<ModelReadCacheCommand, { op: 'commitServerGeneration' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<ModelCacheWorkspaceMeta>
  putDiagramRender(input: Omit<Extract<ModelReadCacheCommand, { op: 'putDiagramRender' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<{ stored: true }>
  getDiagramRender(input: Omit<Extract<ModelReadCacheCommand, { op: 'getDiagramRender' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<CachedDiagramRenderRecord | null>
  buildDiagramRender(input: Omit<Extract<ModelReadCacheCommand, { op: 'buildDiagramRender' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<CachedDiagramRenderRecord | null>
  setOfflineDownloadState(input: Omit<Extract<ModelReadCacheCommand, { op: 'setOfflineDownloadState' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<ModelCacheWorkspaceMeta>
  completeOfflineDownload(input: Omit<Extract<ModelReadCacheCommand, { op: 'completeOfflineDownload' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<ModelCacheWorkspaceMeta>
  discardOfflineDownload(input: Omit<Extract<ModelReadCacheCommand, { op: 'discardOfflineDownload' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<{ discarded: boolean }>
  setWorkspacePolicy(input: Omit<Extract<ModelReadCacheCommand, { op: 'setWorkspacePolicy' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<ModelCacheWorkspaceMeta>
  evictDerived(input: Omit<Extract<ModelReadCacheCommand, { op: 'evictDerived' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<ModelCacheEvictionResult>
  storageStatus(input?: Omit<Extract<ModelReadCacheCommand, { op: 'storageStatus' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<ModelCacheWorkspaceMeta[]>
  clearWorkspace(input: Omit<Extract<ModelReadCacheCommand, { op: 'clearWorkspace' }>, 'id' | 'op'>, signal?: AbortSignal): Promise<{ cleared: true }>
}

export type { CachedConnectionRecord }
