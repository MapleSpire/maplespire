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

// Recursive-descent parser for the Structurizr DSL → typed Workspace AST.
//
// Scope: the structural subset we can import (model elements, groups,
// relationships, structural views and dynamic views). Deployment/filtered/image views,
// styles, and `!` directives are parsed-and-skipped, with a human-readable note
// pushed to `workspace.warnings`.

import { tokenize, type Token } from './tokenizer'
import {
  StructurizrParseError,
  type AutoLayoutSpec,
  type ElementKind,
  type RawElement,
  type RawGroup,
  type RawRelationship,
  type RawView,
  type ViewKind,
  type Workspace,
} from './types'

interface Statement {
  tokens: Token[]
  /** True when the statement opened a block (the `{` has been consumed). */
  blockFollows: boolean
  line: number
}

const ELEMENT_KEYWORDS: Record<string, ElementKind> = {
  person: 'person',
  softwaresystem: 'softwareSystem',
  container: 'container',
  component: 'component',
}

const VIEW_KEYWORDS: Record<string, ViewKind> = {
  systemlandscape: 'systemLandscape',
  systemcontext: 'systemContext',
  container: 'container',
  component: 'component',
  dynamic: 'dynamic',
  deployment: 'deployment',
  filtered: 'filtered',
  image: 'image',
  custom: 'custom',
}

class Parser {
  private toks: Token[]
  private pos = 0
  private idCounter = 0
  warnings: string[] = []
  // identifier (and dotted path) → element, for relationship resolution.
  private elementsByRef = new Map<string, RawElement>()
  private allElements: RawElement[] = []
  groups: RawGroup[] = []
  relationships: RawRelationship[] = []
  identifierScope: 'flat' | 'hierarchical' = 'flat'
  /** Whether the workspace used an `enterprise` boundary at all — outside-the-
   *  enterprise only means "external" when there IS an enterprise. */
  private sawEnterprise = false

  constructor(input: string) {
    this.toks = tokenize(input)
  }

  private peek(): Token {
    return this.toks[this.pos]
  }
  private next(): Token {
    return this.toks[this.pos++]
  }
  private atEnd(): boolean {
    return this.peek().type === 'eof'
  }

  private synthId(prefix = 'el'): string {
    return `__${prefix}${++this.idCounter}`
  }

  private warnOnce(msg: string): void {
    if (!this.warnings.includes(msg)) this.warnings.push(msg)
  }

  /**
   * Read one statement: collect non-structural tokens until a block opens, the
   * current block closes, or the statement ends at a newline. Consumes a `{`
   * (and any newlines before it) when a block follows; consumes the terminating
   * newline otherwise. Does NOT consume `}`.
   */
  private readStatement(): Statement | null {
    // Skip blank lines.
    while (this.peek().type === 'newline') this.next()
    if (this.peek().type === 'rbrace' || this.peek().type === 'eof') return null

    const tokens: Token[] = []
    const line = this.peek().line
    for (;;) {
      const t = this.peek()
      if (t.type === 'eof' || t.type === 'rbrace') {
        return { tokens, blockFollows: false, line }
      }
      if (t.type === 'lbrace') {
        this.next() // consume `{`
        return { tokens, blockFollows: true, line }
      }
      if (t.type === 'newline') {
        // A `{` on the next (possibly blank) line still opens this statement.
        let look = this.pos
        while (this.toks[look]?.type === 'newline') look++
        if (this.toks[look]?.type === 'lbrace') {
          this.pos = look + 1 // consume newlines + `{`
          return { tokens, blockFollows: true, line }
        }
        this.next() // consume the terminating newline
        return { tokens, blockFollows: false, line }
      }
      tokens.push(this.next())
    }
  }

  /** Consume tokens up to and including the matching `}` of an already-open block. */
  private skipBlock(): void {
    let depth = 1
    while (!this.atEnd() && depth > 0) {
      const t = this.next()
      if (t.type === 'lbrace') depth++
      else if (t.type === 'rbrace') depth--
    }
  }

  /** Expect and consume the `}` that closes the current block. */
  private expectRBrace(line: number): void {
    while (this.peek().type === 'newline') this.next()
    if (this.peek().type !== 'rbrace') {
      throw new StructurizrParseError('expected "}" to close block', this.peek().line || line)
    }
    this.next()
  }

  // ── top level ────────────────────────────────────────────────────────────

  parse(): Workspace {
    let name: string | undefined
    let description: string | undefined

    // Optional leading `workspace [name] [desc] { ... }`. Be lenient: a bare
    // `model {}` / `views {}` at the top is also accepted.
    while (this.peek().type === 'newline') this.next()
    const first = this.peek()
    if (first.type === 'word' && first.value.toLowerCase() === 'workspace') {
      const stmt = this.readStatement()!
      const strings = stmt.tokens.filter((t) => t.type === 'string').map((t) => t.value)
      // `workspace extends <x>` — keep parsing the local body, note the extend.
      if (stmt.tokens.some((t) => t.type === 'word' && t.value.toLowerCase() === 'extends')) {
        this.warnOnce('`workspace extends` referenced an external workspace; only the inline content was imported.')
      } else {
        name = strings[0]
        description = strings[1]
      }
      if (stmt.blockFollows) {
        this.parseWorkspaceBody(stmt.line)
      }
    } else {
      // No workspace wrapper — parse top-level model/views statements directly.
      this.parseWorkspaceBody(-1, /*unwrapped*/ true)
    }

    if (this.sawEnterprise) {
      for (const el of this.allElements) {
        if (!el.enterpriseScope) el.enterpriseScope = 'external'
      }
    }

    return {
      name,
      description,
      elements: this.allElements.filter((e) => !e.parentRef),
      groups: this.groups,
      relationships: this.relationships,
      views: this.views,
      identifierScope: this.identifierScope,
      warnings: this.warnings,
    }
  }

  private views: RawView[] = []

  private parseWorkspaceBody(line: number, unwrapped = false): void {
    for (;;) {
      const stmt = this.readStatement()
      if (!stmt) {
        if (unwrapped) return
        this.expectRBrace(line)
        return
      }
      const head = stmt.tokens[0]
      const kw = head?.type === 'word' ? head.value.toLowerCase() : ''
      if (kw === 'model') {
        if (stmt.blockFollows) this.parseBody({ groupPath: [], groupIdPath: [], isElement: false }, stmt.line)
      } else if (kw === 'views') {
        if (stmt.blockFollows) this.parseViews(stmt.line)
      } else if (kw === '!identifiers') {
        const v = stmt.tokens[1]?.value?.toLowerCase()
        if (v === 'hierarchical' || v === 'flat') this.identifierScope = v
      } else if (kw.startsWith('!')) {
        // `!include` / `!constant` / `!docs` / `!adrs` / `!ref` etc. We cannot
        // resolve external files or macro substitutions, so warn that content
        // they would have pulled in is missing rather than dropping it silently.
        this.warnOnce(
          '"!include" / "!constant" / "!docs" and other "!" directives are not supported and were ignored. Content from referenced files is missing.',
        )
        if (stmt.blockFollows) this.skipBlock()
      } else {
        // name/description/properties/configuration/branding/etc.
        if (stmt.blockFollows) this.skipBlock()
      }
      if (unwrapped && this.atEnd()) return
    }
  }

  // ── model ──────────────────────────────────────────────────────────────────

  private parseBody(
    ctx: { parentRef?: string; parentPath?: string; groupPath: string[]; groupIdPath: string[]; parentGroupId?: string; scopeRef?: string; isElement: boolean; insideEnterprise?: boolean },
    line: number,
  ): void {
    for (;;) {
      const stmt = this.readStatement()
      if (!stmt) {
        this.expectRBrace(line)
        return
      }
      this.parseModelStatement(stmt, ctx)
    }
  }

  private parseModelStatement(
    stmt: Statement,
    ctx: { parentRef?: string; parentPath?: string; groupPath: string[]; groupIdPath: string[]; parentGroupId?: string; scopeRef?: string; isElement: boolean; insideEnterprise?: boolean },
  ): void {
    const tokens = stmt.tokens
    if (tokens.length === 0) {
      if (stmt.blockFollows) this.skipBlock()
      return
    }

    // Assignment: `IDENT = ...`
    let identifier: string | undefined
    let rest = tokens
    if (tokens.length >= 2 && tokens[1].type === 'equals' && tokens[0].type === 'word') {
      identifier = tokens[0].value
      rest = tokens.slice(2)
    }

    const head = rest[0]

    // Relationship: explicit `SRC -> DST ...` or implicit `-> DST ...`.
    if (head?.type === 'arrow') {
      const rel = this.parseRelationship(rest, ctx.parentRef, ctx.parentPath, stmt.line)
      if (stmt.blockFollows) this.parseRelationshipBody(rel, stmt.line)
      return
    }
    if (rest.length >= 2 && rest[1]?.type === 'arrow') {
      const rel = this.parseRelationship(rest, ctx.parentRef, ctx.parentPath, stmt.line)
      if (stmt.blockFollows) this.parseRelationshipBody(rel, stmt.line)
      return
    }

    const kw = head?.type === 'word' ? head.value.toLowerCase() : ''

    // `enterprise` — the pre-`group` organisational boundary. Deprecated in
    // current structurizr-dsl but pervasive in existing workspaces and in the
    // original Big Bank sample. It is a BOUNDARY, not an element: its contents
    // stay top-level, they just gain the internal/external distinction the
    // keyword exists to express (Location.Internal).
    //
    // Previously it fell through to the unknown-statement branch and its whole
    // body was skipped, so a workspace that used it imported as "No model
    // elements were found".
    if (kw === 'enterprise') {
      this.sawEnterprise = true
      if (stmt.blockFollows) {
        this.parseBody({ ...ctx, insideEnterprise: true }, stmt.line)
      }
      return
    }

    // Group block
    if (kw === 'group') {
      const gname = rest.find((t) => t.type === 'string')?.value ?? 'Group'
      const group: RawGroup = {
        id: this.synthId('grp'),
        name: gname,
        parentGroupId: ctx.parentGroupId,
        scopeRef: ctx.scopeRef,
        line: stmt.line,
      }
      this.groups.push(group)
      if (stmt.blockFollows) {
        this.parseBody(
          {
            parentRef: ctx.parentRef,
            parentPath: ctx.parentPath,
            scopeRef: ctx.scopeRef,
            insideEnterprise: ctx.insideEnterprise,
            groupPath: [...ctx.groupPath, gname],
            groupIdPath: [...ctx.groupIdPath, group.id],
            parentGroupId: group.id,
            isElement: false,
          },
          stmt.line,
        )
      }
      return
    }

    // Element declaration
    if (kw in ELEMENT_KEYWORDS) {
      const kind = ELEMENT_KEYWORDS[kw]
      const el = this.makeElement(kind, identifier, rest, ctx, stmt.line)
      if (stmt.blockFollows) {
        // Element body: nested elements + property statements.
        // groupPath resets on element entry — a group declared inside an element
        // is a fresh boundary scope, it does not inherit the model-level group.
        this.parseBody(
          {
            parentRef: el.identifier,
            parentPath: el.path,
            scopeRef: el.identifier,
            groupPath: [],
            groupIdPath: [],
            isElement: true,
            insideEnterprise: ctx.insideEnterprise,
          },
          stmt.line,
        )
      }
      return
    }

    // Deployment constructs — out of scope for import; skip cleanly.
    if (kw === 'deploymentenvironment' || kw === 'deploymentnode' || kw === 'infrastructurenode' || kw === 'containerinstance' || kw === 'softwaresysteminstance') {
      this.warnOnce('Deployment views/nodes were ignored (not supported by the importer yet).')
      if (stmt.blockFollows) this.skipBlock()
      return
    }

    // Element property statements (only meaningful inside an element block).
    if (ctx.isElement && ctx.parentRef) {
      const el = this.elementsByRef.get(ctx.parentRef)
      if (el) {
        this.applyElementProperty(el, kw, rest, stmt)
        return
      }
    }

    // Unknown / unsupported statement. Skipping the block is fine; doing it
    // WITHOUT saying so is not — a dropped block is content the user wrote and
    // will not find, and they have no way to know why.
    if (stmt.blockFollows) {
      if (kw) this.warnOnce(`"${kw}" was not recognised inside \`model\` and its block was ignored.`)
      this.skipBlock()
    }
  }

  private makeElement(
    kind: ElementKind,
    identifier: string | undefined,
    rest: Token[],
    ctx: { parentRef?: string; parentPath?: string; groupPath: string[]; groupIdPath?: string[]; insideEnterprise?: boolean },
    line: number,
  ): RawElement {
    const strings = rest.slice(1).filter((t) => t.type === 'string').map((t) => t.value)
    let name = strings[0] ?? '(unnamed)'
    let description: string | undefined
    let technology: string | undefined
    let tagStr: string | undefined
    if (kind === 'container' || kind === 'component') {
      description = strings[1]
      technology = strings[2]
      tagStr = strings.slice(3).join(',')
    } else {
      description = strings[1]
      tagStr = strings.slice(2).join(',')
    }
    name = name.trim()
    const id = identifier ?? this.synthId()
    const el: RawElement = {
      kind,
      identifier: id,
      synthetic: !identifier,
      name,
      description: description?.trim() || undefined,
      technology: technology?.trim() || undefined,
      tags: splitTags(tagStr),
      children: [],
      parentRef: ctx.parentRef,
      path: ctx.parentPath ? `${ctx.parentPath}.${id}` : id,
      parentPath: ctx.parentPath,
      ...(ctx.insideEnterprise ? { enterpriseScope: 'internal' as const } : {}),
      groupPath: [...ctx.groupPath],
      groupIds: [...(ctx.groupIdPath ?? [])],
      properties: {},
      line,
    }
    this.allElements.push(el)
    this.registerRef(el)
    if (ctx.parentRef) {
      const parent = this.elementsByRef.get(ctx.parentRef)
      if (parent) parent.children.push(el)
    }
    return el
  }

  private registerRef(el: RawElement): void {
    if (!this.elementsByRef.has(el.identifier)) this.elementsByRef.set(el.identifier, el)
    // The FULL ancestor path, not just parent.child — otherwise a three-level
    // reference like `system.container.component` resolves to nothing and the
    // statement using it is dropped.
    if (el.path !== el.identifier && !this.elementsByRef.has(el.path)) {
      this.elementsByRef.set(el.path, el)
    }
  }

  private applyElementProperty(el: RawElement, kw: string, rest: Token[], stmt: Statement): void {
    const strings = rest.slice(1).filter((t) => t.type === 'string').map((t) => t.value)
    switch (kw) {
      case 'description':
        if (strings[0]) el.description = strings[0]
        break
      case 'technology':
        if (strings[0]) el.technology = strings[0]
        break
      case 'tags':
        for (const s of strings) el.tags.push(...splitTags(s))
        break
      case 'url':
        el.url = strings[0] ?? rest[1]?.value
        break
      case 'properties':
        if (stmt.blockFollows) this.parseProperties(el.properties, stmt.line)
        return
      case 'perspectives':
        if (stmt.blockFollows) this.skipBlock()
        return
      default:
        if (stmt.blockFollows) this.skipBlock()
        return
    }
    if (stmt.blockFollows) this.skipBlock()
  }

  private parseProperties(target: Record<string, string>, line: number): void {
    for (;;) {
      const stmt = this.readStatement()
      if (!stmt) {
        this.expectRBrace(line)
        return
      }
      const parts = stmt.tokens.map((t) => t.value)
      if (parts.length >= 2) target[parts[0]] = parts.slice(1).join(' ')
      if (stmt.blockFollows) this.skipBlock()
    }
  }

  private parseRelationship(
    rest: Token[],
    implicitSource: string | undefined,
    scopeRef: string | undefined,
    line: number,
  ): RawRelationship | undefined {
    let source: string | undefined
    let idx: number // set unconditionally in both branches below
    if (rest[0].type === 'arrow') {
      source = implicitSource
      idx = 1
    } else {
      source = rest[0].value
      idx = 2 // skip source + arrow
    }
    const dest = rest[idx]?.value
    if (!source || !dest) {
      this.warnOnce('A relationship was skipped because its source or destination could not be resolved.')
      return undefined
    }
    const strings = rest.slice(idx + 1).filter((t) => t.type === 'string').map((t) => t.value)
    const rel: RawRelationship = {
      sourceRef: source,
      destRef: dest,
      description: strings[0]?.trim() || undefined,
      technology: strings[1]?.trim() || undefined,
      tags: splitTags(strings[2]),
      ...(scopeRef ? { scopeRef } : {}),
      line,
    }
    this.relationships.push(rel)
    return rel
  }

  /**
   * A relationship's `{ … }` body. It was skipped wholesale, so tags, url and
   * properties written in block form — which is how our own exporter writes
   * them, and the only form `properties` has — were dropped on import.
   */
  private parseRelationshipBody(rel: RawRelationship | undefined, line: number): void {
    for (;;) {
      const stmt = this.readStatement()
      if (!stmt) {
        this.expectRBrace(line)
        return
      }
      const head = stmt.tokens[0]
      const kw = head?.type === 'word' ? head.value.toLowerCase() : ''
      const strings = stmt.tokens.slice(1).filter((t) => t.type === 'string').map((t) => t.value)
      if (rel && kw === 'properties' && stmt.blockFollows) {
        rel.properties ??= {}
        this.parseProperties(rel.properties, stmt.line)
        continue
      }
      if (rel) {
        switch (kw) {
          case 'tags':
            for (const value of strings) rel.tags.push(...splitTags(value))
            break
          case 'url':
            rel.url = strings[0] ?? stmt.tokens[1]?.value
            break
          case 'description':
            if (strings[0]?.trim()) rel.description = strings[0].trim()
            break
          case 'technology':
            if (strings[0]?.trim()) rel.technology = strings[0].trim()
            break
          default:
            break
        }
      }
      if (stmt.blockFollows) this.skipBlock()
    }
  }

  // ── views ────────────────────────────────────────────────────────────────

  private parseViews(line: number): void {
    for (;;) {
      const stmt = this.readStatement()
      if (!stmt) {
        this.expectRBrace(line)
        return
      }
      const head = stmt.tokens[0]
      const kw = head?.type === 'word' ? head.value.toLowerCase() : ''

      if (kw in VIEW_KEYWORDS) {
        const kind = VIEW_KEYWORDS[kw]
        if (kind === 'systemLandscape' || kind === 'systemContext' || kind === 'container' || kind === 'component') {
          this.parseStructuralView(kind, stmt)
        } else if (kind === 'dynamic') {
          this.parseDynamicView(stmt)
        } else {
          // deployment / filtered / image / custom → not imported.
          this.warnOnce(`"${kw}" views were ignored (not supported by the importer yet).`)
          if (stmt.blockFollows) this.skipBlock()
        }
        continue
      }

      // styles / theme / themes / branding / terminology / properties / configuration
      if (stmt.blockFollows) {
        if (kw) this.warnOnce(`"${kw}" was ignored — the importer does not read it yet.`)
        this.skipBlock()
      }
    }
  }

  private parseStructuralView(kind: ViewKind, stmt: Statement): void {
    const rest = stmt.tokens.slice(1)
    let scopeRef: string | undefined
    let strings: string[]
    if (kind === 'systemLandscape') {
      strings = rest.filter((t) => t.type === 'string').map((t) => t.value)
    } else {
      // First token is the scope identifier (unquoted word); `*` allowed for some.
      scopeRef = rest[0]?.value
      strings = rest.slice(1).filter((t) => t.type === 'string').map((t) => t.value)
    }
    const view: RawView = {
      kind,
      scopeRef,
      key: strings[0],
      description: strings[1],
      includes: [],
      excludes: [],
      line: stmt.line,
    }
    if (stmt.blockFollows) this.parseViewBody(view, stmt.line)
    this.views.push(view)
  }

  private parseViewBody(view: RawView, line: number): void {
    for (;;) {
      const stmt = this.readStatement()
      if (!stmt) {
        this.expectRBrace(line)
        return
      }
      // A single line may chain several directives, e.g. `include * autoLayout lr`.
      // Split the statement into clauses, each starting at a known view keyword,
      // so a trailing `autoLayout` after `include *` is still recognised.
      for (const clause of splitViewClauses(stmt.tokens)) {
        const kw = clause[0]?.type === 'word' ? clause[0].value.toLowerCase() : ''
        const args = clause.slice(1).map((t) => t.value)
        switch (kw) {
          case 'include':
            view.includes.push(...args)
            break
          case 'exclude':
            view.excludes.push(...args)
            break
          case 'autolayout':
            view.autoLayout = parseAutoLayout(args)
            break
          case 'description':
            if (clause[1]?.type === 'string') view.description = clause[1].value
            break
          default:
            break
        }
      }
      if (stmt.blockFollows) this.skipBlock() // animation {}, properties {}, etc.
    }
  }

  /**
   * `dynamic <scope|*> ["key"] ["description"] { … }` — an ordered sequence of
   * interactions, each `[order:] a -> b ["description" ["technology"]]`. The
   * mapper resolves every step to a model relationship, the way Structurizr does.
   */
  private parseDynamicView(stmt: Statement): void {
    const rest = stmt.tokens.slice(1)
    const strings = rest.slice(1).filter((t) => t.type === 'string').map((t) => t.value)
    const view: RawView = {
      kind: 'dynamic',
      scopeRef: rest[0]?.type === 'word' && rest[0].value !== '*' ? rest[0].value : undefined,
      key: strings[0],
      description: strings[1],
      includes: [],
      excludes: [],
      steps: [],
      line: stmt.line,
    }
    if (stmt.blockFollows) this.parseDynamicBody(view, stmt.line)
    this.views.push(view)
  }

  private parseDynamicBody(view: RawView, line: number): void {
    for (;;) {
      const stmt = this.readStatement()
      if (!stmt) {
        this.expectRBrace(line)
        return
      }
      const tokens = stmt.tokens
      // A bare `{ … }` is a parallel sequence. Its steps are kept, in file order:
      // a flow is one ordered list, and dropping them would lose interactions.
      if (tokens.length === 0) {
        if (stmt.blockFollows) {
          this.warnOnce('Parallel sequences in dynamic views were flattened into file order.')
          this.parseDynamicBody(view, stmt.line)
        }
        continue
      }
      let order: string | undefined
      let at = 0
      if (tokens[0].type === 'word' && /^[\d.]+:$/.test(tokens[0].value)) {
        order = tokens[0].value.slice(0, -1)
        at = 1
      }
      if (tokens[at + 1]?.type === 'arrow' && tokens[at]?.type === 'word' && tokens[at + 2]?.type === 'word') {
        const strings = tokens.slice(at + 3).filter((t) => t.type === 'string').map((t) => t.value.trim())
        view.steps!.push({
          sourceRef: tokens[at].value,
          destRef: tokens[at + 2].value,
          ...(strings[0] ? { description: strings[0] } : {}),
          ...(strings[1] ? { technology: strings[1] } : {}),
          ...(order ? { order } : {}),
          line: stmt.line,
        })
        // A step has no body of its own. `readStatement` hands it a `{` written
        // on the NEXT line, which is a parallel sequence opening after it.
        if (stmt.blockFollows) {
          this.warnOnce('Parallel sequences in dynamic views were flattened into file order.')
          this.parseDynamicBody(view, stmt.line)
        }
        continue
      }
      const kw = tokens[0].type === 'word' ? tokens[0].value.toLowerCase() : ''
      const firstString = tokens.find((t) => t.type === 'string')?.value
      if (kw === 'autolayout') view.autoLayout = parseAutoLayout(tokens.slice(1).map((t) => t.value))
      else if (kw === 'title' && firstString) view.title = firstString
      else if (kw === 'description' && firstString) view.description = firstString
      else if (kw === 'include' || kw === 'exclude' || kw === 'animation' || kw === 'properties' || kw === 'default') {
        // Element includes add nothing a flow can show; the rest is presentation.
      } else if (tokens[0].type === 'word') {
        // `relationshipIdentifier "description"` — the step names a relationship
        // by its identifier. Relationship identifiers are not tracked, so it is
        // named instead of silently dropped.
        this.warnOnce(
          'A dynamic-view step that names a relationship by its identifier (rather than `a -> b`) is not supported and was skipped.',
        )
      }
      if (stmt.blockFollows) this.skipBlock()
    }
  }

  // expose for resolution by the mapper
  getElementsByRef(): Map<string, RawElement> {
    return this.elementsByRef
  }
  getAllElements(): RawElement[] {
    return this.allElements
  }
}

// View-body directive keywords that can begin a clause within a single line.
const VIEW_CLAUSE_KEYWORDS = new Set(['include', 'exclude', 'autolayout', 'description'])

/**
 * Split a view-body statement's tokens into one clause per directive. The first
 * token is always the start of the first clause; any subsequent token matching a
 * view directive keyword starts a new clause. This lets `include * autoLayout lr`
 * (all on one line) parse as two clauses rather than dumping `autoLayout`/`lr`
 * into the include list.
 */
function splitViewClauses(tokens: Token[]): Token[][] {
  if (tokens.length === 0) return []
  const clauses: Token[][] = []
  let current: Token[] = []
  tokens.forEach((t, i) => {
    const isKw = t.type === 'word' && VIEW_CLAUSE_KEYWORDS.has(t.value.toLowerCase())
    if (i > 0 && isKw) {
      clauses.push(current)
      current = []
    }
    current.push(t)
  })
  if (current.length > 0) clauses.push(current)
  return clauses
}

function parseAutoLayout(args: string[]): AutoLayoutSpec {
  const spec: AutoLayoutSpec = {}
  const dir = args[0]?.toLowerCase()
  if (dir === 'tb' || dir === 'bt' || dir === 'lr' || dir === 'rl') spec.direction = dir
  const nums = args.filter((a) => /^\d+$/.test(a)).map(Number)
  if (dir && (dir === 'tb' || dir === 'bt' || dir === 'lr' || dir === 'rl')) {
    if (nums[0] != null) spec.rankSeparation = nums[0]
    if (nums[1] != null) spec.nodeSeparation = nums[1]
  } else {
    if (nums[0] != null) spec.rankSeparation = nums[0]
    if (nums[1] != null) spec.nodeSeparation = nums[1]
  }
  return spec
}

function splitTags(s: string | undefined): string[] {
  if (!s) return []
  return s
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/**
 * Parse Structurizr DSL into a typed Workspace AST. Throws StructurizrParseError
 * with a line number on malformed input.
 */
export function parseWorkspace(input: string): Workspace {
  if (!input || !input.trim()) {
    throw new StructurizrParseError('The DSL is empty.', 0)
  }
  const parser = new Parser(input)
  const ws = parser.parse()
  if (ws.elements.length === 0 && parser.getAllElements().length === 0) {
    throw new StructurizrParseError('No model elements were found. Is this a Structurizr DSL workspace?', 0)
  }
  return ws
}

/** Lower-level access for callers (e.g. the mapper) that need the ref map. */
export function parseWorkspaceWithRefs(input: string): { workspace: Workspace; elementsByRef: Map<string, RawElement>; allElements: RawElement[] } {
  const parser = new Parser(input)
  const workspace = parser.parse()
  return { workspace, elementsByRef: parser.getElementsByRef(), allElements: parser.getAllElements() }
}
