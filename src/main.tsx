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

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { installSampleCommunityThemes } from './plugins/community/samples'
// Side-effect import: initializes i18next (bundled FR/EN resources + browser
// language detection) and sets <html lang> before the app renders.
import './lib/i18n'
// Side-effect import: creates the theme store, applies <html data-theme>, and
// starts listening for OS light/dark changes before the app renders.
import './stores/themeStore'
import { exposeBootHealth, installClientDiagnostics } from './lib/observability/installClientDiagnostics'
import { installModelReadCacheChangeFeed } from './lib/modelQuery/modelReadCacheChangeFeed'
import { primeBootWorkspaceRef } from './lib/automerge/bootRef'
import { useModelStore } from './stores/modelStore'
import { useWorkspaceStore } from './stores/workspaceStore'

// A direct versioned URL is authoritative from the first synchronous turn. Do
// this before background services or React effects can build workspace-scoped
// requests from a previous tab's persisted ref. Authenticated boot validates it
// afterward without temporarily reverting to that stale ref.
const initialWorkspaceTarget = primeBootWorkspaceRef(window.location.pathname)
if (initialWorkspaceTarget) {
  useWorkspaceStore.setState({ ref: initialWorkspaceTarget.ref })
  if (initialWorkspaceTarget.diagramId) {
    useModelStore.setState({ currentDiagramId: initialWorkspaceTarget.diagramId })
  }
}

// Demo only — ships the sample community theme in dev so the sandbox is testable
// from the skin picker. Production installs come from the theme gallery.
if (import.meta.env.DEV) installSampleCommunityThemes()

// Dev is always instrumented. Production enables this through a sampled/configured
// VITE_CLIENT_PERF_DIAGNOSTICS build flag; no model content or search text is kept.
// Aggregate boot-wall counters, in every build: an early warning readable only
// on machines with the diagnostics flag set would be useless.
exposeBootHealth()
installClientDiagnostics()
const stopModelReadCacheChangeFeed = installModelReadCacheChangeFeed()
if (import.meta.hot) import.meta.hot.dispose(stopModelReadCacheChangeFeed)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
