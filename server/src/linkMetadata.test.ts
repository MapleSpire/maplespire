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

import { describe, expect, it, vi } from 'vitest'
import { extractLinkLabel, resolveLinkMetadata } from './linkMetadata.js'

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]

describe('link metadata', () => {
  it('prefers Open Graph, then Twitter and finally the document title', () => {
    expect(extractLinkLabel(`
      <html><head>
        <title>Fallback title</title>
        <meta content="Twitter title" name="twitter:title">
        <meta content="Architecture &amp; APIs" property="og:title">
      </head></html>
    `)).toBe('Architecture & APIs')
    expect(extractLinkLabel('<title>  Plain\n page  </title>')).toBe('Plain page')
    expect(extractLinkLabel('<html><body>No metadata</body></html>')).toBeNull()
  })

  it('fetches HTML and extracts its standard label', async () => {
    const fetcher = vi.fn(async () => new Response(
      '<meta property="og:title" content="System catalogue">',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ))
    await expect(resolveLinkMetadata('https://example.com/catalogue', {
      lookup: publicLookup,
      fetch: fetcher,
    })).resolves.toBe('System catalogue')
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'manual' }))
  })

  it('keeps a title found in the head when the page body exceeds the scan limit', async () => {
    const html = [
      '<!doctype html><html><head><title>Node.js — Run JavaScript Everywhere</title></head><body>',
      'x'.repeat(600 * 1024),
      '</body></html>',
    ].join('')
    const fetcher = vi.fn(async () => new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }))

    await expect(resolveLinkMetadata('https://nodejs.org', {
      lookup: publicLookup,
      fetch: fetcher,
    })).resolves.toBe('Node.js — Run JavaScript Everywhere')
  })

  it('rejects private destinations, including redirects, before fetching them', async () => {
    const fetcher = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/internal' },
    }))
    await expect(resolveLinkMetadata('https://example.com/redirect', {
      lookup: publicLookup,
      fetch: fetcher,
    })).rejects.toThrow('private address')
    expect(fetcher).toHaveBeenCalledTimes(1)

    await expect(resolveLinkMetadata('http://localhost/admin', {
      lookup: publicLookup,
      fetch: fetcher,
    })).rejects.toThrow('private host')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
