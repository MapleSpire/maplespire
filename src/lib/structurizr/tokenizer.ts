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

// Tokenizer for the Structurizr DSL.
//
// The DSL is statement-oriented: statements are separated by newlines, blocks
// are delimited by `{`/`}`, tokens are whitespace-separated words or quoted
// strings, and there are three comment styles (`//`, `#`, `/* */`). We emit a
// flat token stream (with NEWLINE as an explicit separator) that the parser
// consumes statement by statement.

import { StructurizrParseError } from './types'

export type TokenType = 'word' | 'string' | 'arrow' | 'equals' | 'lbrace' | 'rbrace' | 'newline' | 'eof'

export interface Token {
  type: TokenType
  /** For `word`/`string`: the literal value. For `arrow`: the archetype text between dashes (usually ''). */
  value: string
  line: number
}

const ARROW_RE = /^(--?[A-Za-z0-9]*->|->)$/

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v'
}

/**
 * Split a raw whitespace-delimited word into sub-tokens, handling arrows that
 * are glued to identifiers (`a->b`, `a-> b`, `a --https-> b`). Returns a list of
 * `{ value, isArrow }`.
 */
function splitWord(word: string): Array<{ value: string; isArrow: boolean }> {
  const out: Array<{ value: string; isArrow: boolean }> = []
  let rest = word
  const embedded = /(--?[A-Za-z0-9]*->|->)/
  while (rest.length > 0) {
    const m = embedded.exec(rest)
    if (!m) {
      out.push({ value: rest, isArrow: false })
      break
    }
    const idx = m.index
    if (idx > 0) out.push({ value: rest.slice(0, idx), isArrow: false })
    out.push({ value: m[0], isArrow: true })
    rest = rest.slice(idx + m[0].length)
  }
  return out.filter((t) => t.value.length > 0 || t.isArrow)
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let line = 1
  let i = 0
  const n = input.length

  const pushWord = (raw: string, ln: number) => {
    if (raw === '=') {
      tokens.push({ type: 'equals', value: '=', line: ln })
      return
    }
    if (ARROW_RE.test(raw)) {
      tokens.push({ type: 'arrow', value: raw, line: ln })
      return
    }
    // Handle arrows glued onto identifiers.
    if (raw.includes('->')) {
      for (const part of splitWord(raw)) {
        if (part.isArrow) tokens.push({ type: 'arrow', value: part.value, line: ln })
        else if (part.value === '=') tokens.push({ type: 'equals', value: '=', line: ln })
        else tokens.push({ type: 'word', value: part.value, line: ln })
      }
      return
    }
    tokens.push({ type: 'word', value: raw, line: ln })
  }

  while (i < n) {
    const ch = input[i]

    // Newlines (collapse handled by parser; we still emit one per line break).
    if (ch === '\n') {
      tokens.push({ type: 'newline', value: '\n', line })
      line++
      i++
      continue
    }
    if (isSpace(ch)) {
      i++
      continue
    }

    // Comments: // ... and # ... (to end of line)
    if ((ch === '/' && input[i + 1] === '/') || ch === '#') {
      while (i < n && input[i] !== '\n') i++
      continue
    }
    // Block comment /* ... */
    if (ch === '/' && input[i + 1] === '*') {
      i += 2
      while (i < n && !(input[i] === '*' && input[i + 1] === '/')) {
        if (input[i] === '\n') line++
        i++
      }
      i += 2
      continue
    }

    // Braces
    if (ch === '{') {
      tokens.push({ type: 'lbrace', value: '{', line })
      i++
      continue
    }
    if (ch === '}') {
      tokens.push({ type: 'rbrace', value: '}', line })
      i++
      continue
    }

    // Quoted string (double or single quotes), supporting \" escapes. Structurizr
    // string literals are single-line: a newline before the closing quote means
    // the string was never terminated, so we surface a precise error pointing at
    // the line the string opened on (rather than letting the consumed `}` chars
    // cause a confusing "expected }" error further down).
    if (ch === '"' || ch === "'") {
      const quote = ch
      const startLine = line
      i++
      let str = ''
      while (i < n && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < n) {
          // Preserve common escapes literally enough for labels.
          const next = input[i + 1]
          str += next === 'n' ? '\n' : next === 't' ? '\t' : next
          i += 2
          continue
        }
        if (input[i] === '\n') {
          throw new StructurizrParseError('Unterminated string literal.', startLine)
        }
        str += input[i]
        i++
      }
      if (i >= n) {
        throw new StructurizrParseError('Unterminated string literal.', startLine)
      }
      i++ // closing quote
      tokens.push({ type: 'string', value: str, line: startLine })
      continue
    }

    // Bareword: run until whitespace, brace, quote, or comment start.
    let word = ''
    const wordLine = line
    while (i < n) {
      const c = input[i]
      if (isSpace(c) || c === '\n' || c === '{' || c === '}' || c === '"' || c === "'") break
      if (c === '/' && (input[i + 1] === '/' || input[i + 1] === '*')) break
      if (c === '#') break
      word += c
      i++
    }
    if (word.length > 0) pushWord(word, wordLine)
  }

  tokens.push({ type: 'eof', value: '', line })
  return tokens
}
