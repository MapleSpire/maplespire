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

import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import type { Express, Request, Response as ExpressResponse } from 'express'

const MAX_URL_LENGTH = 2048
const MAX_HTML_BYTES = 512 * 1024
const MAX_REDIRECTS = 3
const FETCH_TIMEOUT_MS = 5000

type LookupResult = { address: string; family: number }
type Lookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupResult[]>
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<globalThis.Response>

export interface LinkMetadataDependencies {
  lookup?: Lookup
  fetch?: Fetcher
}

const blockedIpv6 = new BlockList()
blockedIpv6.addAddress('::', 'ipv6')
blockedIpv6.addAddress('::1', 'ipv6')
blockedIpv6.addSubnet('fc00::', 7, 'ipv6')
blockedIpv6.addSubnet('fe80::', 10, 'ipv6')
// Avoid alternate IPv4 spellings bypassing the IPv4 checks. DNS normally
// returns ordinary A records, so rejecting mapped literals is harmless.
blockedIpv6.addSubnet('::ffff:0:0', 96, 'ipv6')

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true
  const [a, b] = octets
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
}

function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized)
  if (isIP(normalized) !== 6) return true
  return blockedIpv6.check(normalized, 'ipv6')
}

async function assertPublicHttpUrl(rawUrl: string, lookup: Lookup): Promise<URL> {
  if (!rawUrl || rawUrl.length > MAX_URL_LENGTH) throw new Error('invalid url')
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
  if (url.username || url.password) throw new Error('url credentials are not allowed')
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('private host')
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) throw new Error('private address')
  return url
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  }
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] === '#') {
      const numeric = code[1].toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10)
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity
    }
    return named[code.toLowerCase()] ?? entity
  })
}

function cleanTitle(value: string | undefined): string | null {
  if (!value) return null
  const cleaned = decodeHtmlEntities(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  return cleaned ? cleaned.slice(0, 240) : null
}

function attributesOf(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  for (const match of tag.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return attributes
}

/** Resolve the standard page-title metadata in social-preview priority order. */
export function extractLinkLabel(html: string): string | null {
  const candidates = new Map<string, string>()
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributesOf(tag)
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase()
    if (key && attrs.content && !candidates.has(key)) candidates.set(key, attrs.content)
  }
  return cleanTitle(candidates.get('og:title')) ??
    cleanTitle(candidates.get('twitter:title')) ??
    cleanTitle(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1])
}

async function readLimitedHtml(response: globalThis.Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let html = ''
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const remaining = MAX_HTML_BYTES - total
    const accepted = value.subarray(0, Math.max(0, remaining))
    total += accepted.byteLength
    html += decoder.decode(accepted, { stream: true })
    // Page-title metadata belongs in <head>. Stop as soon as it is complete so
    // large application bundles or documentation bodies are never downloaded.
    if (/<\/head\s*>/i.test(html) || accepted.byteLength < value.byteLength || total >= MAX_HTML_BYTES) {
      await reader.cancel()
      break
    }
  }
  return html + decoder.decode()
}

export async function resolveLinkMetadata(rawUrl: string, dependencies: LinkMetadataDependencies = {}): Promise<string | null> {
  const lookup = dependencies.lookup ?? dnsLookup
  const fetcher = dependencies.fetch ?? fetch
  let url = await assertPublicHttpUrl(rawUrl, lookup)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const response = await fetcher(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'MapleSpire-LinkMetadata/1.0',
        },
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location || redirect === MAX_REDIRECTS) throw new Error('too many redirects')
        url = await assertPublicHttpUrl(new URL(location, url).href, lookup)
        continue
      }
      if (!response.ok) return null
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) return null
      return extractLinkLabel(await readLimitedHtml(response))
    }
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export function registerLinkMetadataRoutes(app: Express, dependencies: LinkMetadataDependencies = {}): void {
  app.post('/api/link-metadata', async (req: Request, res: ExpressResponse) => {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
    try {
      res.json({ label: await resolveLinkMetadata(url, dependencies) })
    } catch {
      // Metadata is deliberately optional. Avoid leaking DNS/network details and
      // let the client keep a normal clickable URL when enrichment is impossible.
      res.json({ label: null })
    }
  })
}
