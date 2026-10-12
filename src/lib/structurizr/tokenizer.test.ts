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

import { describe, it, expect } from 'vitest'
import { tokenize } from './tokenizer'
import { StructurizrParseError } from './types'

// Convenience: tokenize and drop the trailing EOF for terser assertions.
const types = (src: string) => tokenize(src).filter((t) => t.type !== 'eof').map((t) => t.type)
const pairs = (src: string) =>
  tokenize(src)
    .filter((t) => t.type !== 'eof')
    .map((t) => [t.type, t.value] as const)

describe('tokenizer — arrows', () => {
  it('emits a standalone `->` arrow', () => {
    expect(pairs('a -> b')).toEqual([
      ['word', 'a'],
      ['arrow', '->'],
      ['word', 'b'],
    ])
  })

  it('splits a glued arrow `a->b` into word/arrow/word', () => {
    expect(pairs('a->b')).toEqual([
      ['word', 'a'],
      ['arrow', '->'],
      ['word', 'b'],
    ])
  })

  it('handles a half-glued arrow `a-> b`', () => {
    expect(pairs('a-> b')).toEqual([
      ['word', 'a'],
      ['arrow', '->'],
      ['word', 'b'],
    ])
  })

  it('recognises a typed arrow `--https->`', () => {
    expect(pairs('a --https-> b')).toEqual([
      ['word', 'a'],
      ['arrow', '--https->'],
      ['word', 'b'],
    ])
  })

  it('recognises a typed arrow standing on its own', () => {
    expect(pairs('--https->')).toEqual([['arrow', '--https->']])
  })

  it('splits a glued typed arrow `a--https->b`', () => {
    expect(pairs('a--https->b')).toEqual([
      ['word', 'a'],
      ['arrow', '--https->'],
      ['word', 'b'],
    ])
  })
})

describe('tokenizer — operators and braces', () => {
  it('emits an `=` equals token', () => {
    expect(pairs('x = person "Y"')).toEqual([
      ['word', 'x'],
      ['equals', '='],
      ['word', 'person'],
      ['string', 'Y'],
    ])
  })

  it('emits `{` and `}` brace tokens', () => {
    expect(types('model {\n}')).toEqual(['word', 'lbrace', 'newline', 'rbrace'])
  })
})

describe('tokenizer — comments', () => {
  it('skips `//` line comments to end of line', () => {
    expect(pairs('// a comment\nword')).toEqual([
      ['newline', '\n'],
      ['word', 'word'],
    ])
  })

  it('skips `#` line comments to end of line', () => {
    expect(pairs('# a comment\nword')).toEqual([
      ['newline', '\n'],
      ['word', 'word'],
    ])
  })

  it('skips `/* ... */` block comments and counts the newlines inside', () => {
    const toks = tokenize('/* c1\nc2 */ word').filter((t) => t.type !== 'eof')
    expect(toks.map((t) => [t.type, t.value])).toEqual([['word', 'word']])
    // The single newline inside the block comment advanced the line counter.
    expect(toks[0].line).toBe(2)
  })

  it('breaks a bareword at an inline `//` comment start', () => {
    expect(pairs('word//comment')).toEqual([['word', 'word']])
  })
})

describe('tokenizer — strings', () => {
  it('reads a double-quoted string', () => {
    expect(pairs('"hello world"')).toEqual([['string', 'hello world']])
  })

  it('reads a single-quoted string', () => {
    expect(pairs("'hello world'")).toEqual([['string', 'hello world']])
  })

  it('decodes \\n, \\t and \\" escape sequences', () => {
    // Source: "a\nb\t\"q"  → value: a<newline>b<tab>"q
    const src = '"a\\nb\\t\\"q"'
    const toks = tokenize(src).filter((t) => t.type !== 'eof')
    expect(toks).toHaveLength(1)
    expect(toks[0].type).toBe('string')
    expect(toks[0].value).toBe('a\nb\t"q')
  })

  it('throws a precise error on an unterminated string (correct line, clear message)', () => {
    const dsl = 'workspace {\n  model {\n    a = person "Alice\n  }\n}'
    let err: unknown
    try {
      tokenize(dsl)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(StructurizrParseError)
    expect((err as StructurizrParseError).line).toBe(3)
    expect((err as Error).message).toMatch(/unterminated string/i)
  })
})

describe('tokenizer — line tracking', () => {
  it('emits a newline token per line break and tracks line numbers', () => {
    const toks = tokenize('a\nb\nc')
    const words = toks.filter((t) => t.type === 'word')
    expect(words.map((t) => [t.value, t.line])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ])
    expect(toks.filter((t) => t.type === 'newline')).toHaveLength(2)
  })
})
