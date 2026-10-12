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
 * The offline half of the technology search ranking — an APPROXIMATION of the
 * server's order, not a reproduction of it.
 *
 * Without this the cached path returned matches in cache insertion order, so
 * going offline reshuffled the picker into nonsense. Ranking it is a large
 * improvement. Claiming the two agree would not be true, and an earlier version
 * of this comment did claim it:
 *
 *  - the server ranks `normalized_name` (punctuation stripped by
 *    `normalizeTechnologyTerm`) and orders under the database collation; this
 *    ranks the raw name lowercased and orders with ICU `localeCompare`. They
 *    disagree wherever punctuation or leading symbols decide the order —
 *    "React-Admin" sorts second on the server and fourth here.
 *  - they disagree on MEMBERSHIP before order even matters: the server matches
 *    `search_document`, which folds in publisher, ecosystem and URL, while the
 *    cached filter does a raw `includes` over name and aliases. "adobe commerce
 *    magento" finds `Adobe Commerce (Magento)` online and nothing offline.
 *
 * Closing that would mean reproducing `search_document` in the client, which is
 * a different feature. Until then: same rule, same intent, best effort — and
 * `ranking.test.ts` pins THIS implementation rather than pretending to pin both.
 */

/** Lower is better, matching the SQL's inverted rank exactly. */
export function technologyMatchRank(
  name: string,
  aliases: readonly string[],
  query: string,
): number {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return 0
  const normalizedName = name.toLocaleLowerCase()
  const normalizedAliases = aliases.map((alias) => alias.toLocaleLowerCase())
  if (normalizedName === q) return 0
  if (normalizedAliases.includes(q)) return 1
  if (normalizedName.startsWith(q)) return 2
  if (normalizedAliases.some((alias) => alias.startsWith(q))) return 3
  return 4
}

/**
 * Sort key order is (rank, name) — the same two the SQL orders by.
 *
 * Ties inside a rank stay alphabetical. A shorter-name-first tie-break was tried
 * and measured worse against the running catalog: "kub" put Kuberun and Kubecost
 * above Kubernetes. Without a popularity signal nothing sorts Kubernetes to the
 * top of "kub", and length only demotes long canonical names.
 */
export function compareTechnologyMatches<T>(
  query: string,
  nameOf: (item: T) => string,
  aliasesOf: (item: T) => readonly string[],
): (a: T, b: T) => number {
  return (a, b) => {
    const rankA = technologyMatchRank(nameOf(a), aliasesOf(a), query)
    const rankB = technologyMatchRank(nameOf(b), aliasesOf(b), query)
    if (rankA !== rankB) return rankA - rankB
    return nameOf(a).toLocaleLowerCase().localeCompare(nameOf(b).toLocaleLowerCase())
  }
}
