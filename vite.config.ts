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

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import wasm from 'vite-plugin-wasm'

/**
 * Serve the technology icon catalog from the repo in dev.
 *
 * `techIcons.ts` stores every icon as `http://localhost:8080/icons/...` and
 * rewrites the host away at import time (`LEGACY_ICON_BASE_URL` -> `/icons`), so
 * the browser always asks THIS origin. Production nginx serves that directory;
 * `docker compose up icons` is the documented local equivalent. But that service
 * binds host 8080 under a fixed `container_name`, which no isolated worktree can
 * claim without fighting every other one — so in practice the container is not
 * running and all 7,555 catalogued icons 502.
 *
 * The bytes are already in the worktree (`docker/icons`, 7,665 files). Serve them
 * straight from disk: no container, no port, nothing shared between worktrees.
 * `VITE_DEV_PROXY_ICON_URL` still wins when it is set, which is the case this
 * indirection exists for (Vite in Docker reaching a real icon host).
 *
 * This also stops `/icons` shadowing `public/icons`: a blanket proxy on that
 * prefix swallowed `icon-192.png` and the other PWA icons, which are committed
 * and which Vite would otherwise serve itself. The two sets do not overlap
 * (`docker/icons` holds only `light/` and `dark/`), so falling through to Vite's
 * own static handling is enough.
 */
function devIconAssets(roots: readonly string[]): Plugin {
  const contentTypes: Record<string, string> = {
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  }
  const resolveIcon = async (pathname: string): Promise<string | null> => {
    for (const root of roots) {
      // `normalize` collapses `..` before the prefix check, so a request can
      // never address anything outside an icon directory.
      const target = normalize(join(root, pathname))
      if (!target.startsWith(root + sep)) continue
      const info = await stat(target).catch(() => null)
      if (info?.isFile()) return target
    }
    return null
  }
  return {
    name: 'maplespire:dev-icon-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/icons', (req, res, next) => {
        const pathname = decodeURIComponent((req.url ?? '').split('?')[0])
        void resolveIcon(pathname).then((target) => {
          if (!target) {
            // Deliberately NOT `next()`. Vite's SPA fallback answers an unknown
            // path with index.html and a 200, so a missing icon would report
            // itself as a successful HTML response — the exact shape of failure
            // that hides a broken catalog entry. Own the whole prefix instead.
            res.statusCode = 404
            res.end(`No icon asset for ${pathname}`)
            return
          }
          res.setHeader('Content-Type', contentTypes[extname(target).toLowerCase()] ?? 'application/octet-stream')
          createReadStream(target).pipe(res)
        }, next)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Per-worktree isolation: a gitignored .env.local can point this instance at its
  // own sync server (VITE_SYNC_API_URL / VITE_AUTOMERGE_URL) and dev port
  // (VITE_DEV_PORT) so parallel branches don't collide. Defaults preserve 3001/5173.
  const env = loadEnv(mode, process.cwd(), '')
  // The browser-facing sync URL and Vite's server-side proxy target can differ
  // when Vite itself runs in Docker. Keep the override worktree-local so the
  // browser can use localhost while the container reaches the host gateway.
  const apiTarget = env.VITE_DEV_PROXY_API_URL || env.VITE_SYNC_API_URL || 'http://localhost:3001'
  // No default. The old `|| 'http://localhost:8080'` made every worktree proxy
  // /icons at a container none of them can run, which reads as "icons are broken"
  // rather than as a missing service. Unset now means: serve them from the repo.
  const iconTarget = env.VITE_DEV_PROXY_ICON_URL
  const devPort = env.VITE_DEV_PORT ? Number(env.VITE_DEV_PORT) : undefined

  return {
    // Automerge ships its core as WebAssembly and loads it with a top-level await.
    // `vite-plugin-wasm` lets Vite bundle the .wasm. We do NOT use
    // vite-plugin-top-level-await: it depends on `rollup`, which Vite 8 (rolldown)
    // no longer installs. Instead we target `esnext` so top-level await is emitted
    // natively (browsers and rolldown both support it). The Automerge wasm packages
    // must stay out of dep pre-bundling or their async init gets mangled.
    plugins: [
      wasm(),
      react(),
      tailwindcss(),
      ...(iconTarget ? [] : [devIconAssets([
        normalize(join(process.cwd(), 'docker', 'icons')),
        // The committed PWA icons (icon-192 / icon-512 / maskable) live here and
        // do not overlap `docker/icons`, which holds only `light/` and `dark/`.
        normalize(join(process.cwd(), 'public', 'icons')),
      ])]),
    ],
    optimizeDeps: {
      // Exclude ONLY the wasm package (esbuild/rolldown can't pre-bundle .wasm;
      // vite-plugin-wasm loads it at runtime). automerge-repo and its deps (e.g.
      // eventemitter3) MUST stay optimized so Vite fixes their CJS→ESM interop.
      exclude: ['@automerge/automerge-wasm'],
      // Pin the CJS→ESM interop for eventemitter3 (an Automerge transitive dep)
      // even if Automerge's peer deps shuffle.
      include: ['eventemitter3'],
    },
    build: { target: 'esnext' },
    server: {
      port: devPort,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
        // Technology revisions store same-origin, immutable paths rather than
        // environment-specific API URLs. Proxy the asset namespace to this
        // worktree's isolated server so previews and offline cache warm-up use
        // the exact path that nginx serves in production.
        '/assets/technologies': {
          target: apiTarget,
          changeOrigin: true,
        },
        // The generated icon catalog uses same-origin /icons paths in every
        // environment. Production nginx serves the directory directly; in dev
        // this proxy is OPT-IN (see `devIconAssets` above for why), and without
        // it the icons come off disk.
        ...(iconTarget ? { '/icons': { target: iconTarget, changeOrigin: true } } : {}),
      },
    },
  }
})
