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

/*
 * Delete the LEGACY, un-namespaced CACHES once this browser uses per-user
 * storage (src/lib/auth/accountNamespace.ts).
 *
 * Before 2026-10-11 every account on a browser shared one set of databases,
 * which is how a new account was shown the previous account's objects. Each
 * user now has `<name>@<userId>` databases. A namespaced page never opens the
 * legacy names, so nothing in them reaches a signed-in user again.
 *
 * Only what the server can rebuild is deleted here. The legacy DURABLE stores
 * are left on disk untouched (owner decision, 2026-10-11): they may hold work
 * the server never received, and deleting it would contradict
 * docs/plan-zero-perte-et-performance.md and docs/tag-outbox-operations.md.
 *   DURABLE, KEPT: 'maplespire-automerge' (local document changes),
 *                  'maplespire-model-index' (entity/placement crash journals,
 *                  durable-heads ledger), 'maplespire-tag-catalog-v1' and
 *                  'maplespire-technology-catalog-v2' (governed-creation outboxes).
 *
 * Runs only when a namespace is set: a page with no namespace (signed out,
 * never signed in, AUTH=off) still USES the legacy names, and an AUTH=off
 * install must open exactly what it opened before.
 *
 * A classic, parser-blocking script, ES5, no imports: copied verbatim by Vite
 * and run before the module bundle. (Vite merges every `type="module"` script
 * into one entry, so a module would run in bundle order, not document order.)
 */
(function () {
  var NAMESPACE_KEY = 'maplespire:accountNamespace'
  var SAFE_NAMESPACE = /^[A-Za-z0-9_-]{1,128}$/
  var LEGACY_CACHES = [
    'maplespire-model-read-cache',
    'maplespire-tag-postings-v1',
    'maplespire-technology-postings-v2',
  ]
  try {
    // Same validity rule as the app (accountNamespace.ts): a value the app
    // would ignore means the app is still on the legacy names.
    var namespace = localStorage.getItem(NAMESPACE_KEY)
    if (namespace === null || !SAFE_NAMESPACE.test(namespace)) return
    for (var n = 0; n < LEGACY_CACHES.length; n += 1) {
      // One try per database: a synchronous throw on one must not skip the rest.
      try {
        var request = indexedDB.deleteDatabase(LEGACY_CACHES[n])
        request.onerror = (function (name, req) {
          return function () { console.error('[account] failed to delete legacy ' + name, req.error) }
        })(LEGACY_CACHES[n], request)
      } catch (error) {
        console.error('[account] could not delete legacy ' + LEGACY_CACHES[n], error)
      }
    }
  } catch (error) {
    console.error('[account] legacy cache cleanup failed', error)
  }
})()
