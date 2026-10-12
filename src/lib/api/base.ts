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
 * Where the sync/API server lives, resolved ONCE.
 *
 * Empty means same origin: every call site spells `${API_BASE}/api/...`, so an
 * empty prefix yields a relative URL. This is the deployment convention:
 * `docker/nginx/Dockerfile` declares `ARG VITE_SYNC_API_URL=""`, the compose
 * files pass `""`, and `resolveAiPublicBaseUrl` in `lib/ai/api.ts` relies on it.
 * CI deliberately builds WITHOUT the variable so `verify:same-origin-dist` can
 * check that no `localhost` default is baked into the bundle — which is why
 * there must be no `?? 'http://localhost:3001'` fallback anywhere.
 *
 * Cross-origin production is still supported: a build that sets
 * `VITE_SYNC_API_URL` to a separate API origin keeps it (`??`).
 *
 * In dev, a stack that sets `VITE_SYNC_API_URL` keeps an ABSOLUTE `API_BASE`;
 * a checkout that sets nothing gets the relative form, and `vite.config.ts`
 * proxies `/api` to
 * `VITE_DEV_PROXY_API_URL || VITE_SYNC_API_URL || 'http://localhost:3001'`.
 *
 * The WebSocket sibling in `lib/automerge/repo.ts` cannot be empty (a WebSocket
 * needs an absolute URL) and derives its default from `window.location`. Keep
 * this the ONLY place the HTTP decision is made (`base.test.ts` enforces it).
 */
export const API_BASE: string = import.meta.env.VITE_SYNC_API_URL ?? ''
