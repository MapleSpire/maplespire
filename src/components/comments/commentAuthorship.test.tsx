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

// @vitest-environment jsdom
//
// Regression (2026-10-16): comments and replies were stored with the literal
// author 'You', so with two users in one org Sarah's comment rendered as "You"
// on Olivier's screen and the "Yours" tab listed everyone's comments.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from '../../lib/i18n'
import { useAuthStore } from '../../stores/authStore'
import { useModelStore } from '../../stores/modelStore'
import type { AuthUser } from '../../lib/auth/api'
import type { Comment } from '../../types'
import {
  commentAuthorLabel,
  commentAuthorshipFor,
  isOwnCommentEntry,
  LEGACY_COMMENT_AUTHOR,
} from '../../lib/comments/authorship'
import { CommentsDropdown } from './CommentsDropdown'
import { CommentDetail } from './CommentDetail'

const olivier = { id: 'u-olivier', email: 'olivier@example.com', name: null, isPlatformAdmin: false } as AuthUser
const sarah = { id: 'u-sarah', email: 'sarah@example.com', name: 'Sarah Connor', isPlatformAdmin: false } as AuthUser
const t = (k: string) => i18n.t(k)

function comment(id: string, author: string, authorId?: string, replies: Comment['replies'] = []): Comment {
  return {
    id, diagramId: 'D1', type: 'question', text: `text ${id}`, position: { x: 0, y: 0 },
    author, ...(authorId ? { authorId } : {}),
    createdAt: '2026-10-16T00:00:00.000Z', resolved: false, pinned: false, replies,
  }
}

describe('comment authorship', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })
  afterEach(() => {
    cleanup()
    useAuthStore.setState({ user: null })
  })

  it('stamps the signed-in identity, and the legacy sentinel only without one', () => {
    expect(commentAuthorshipFor(sarah)).toEqual({ author: 'Sarah Connor', authorId: 'u-sarah' })
    expect(commentAuthorshipFor(olivier)).toEqual({ author: 'olivier@example.com', authorId: 'u-olivier' })
    expect(commentAuthorshipFor(null)).toEqual({ author: LEGACY_COMMENT_AUTHOR })
  })

  it("renders another user's comment by name, never as You", () => {
    const bySarah = commentAuthorshipFor(sarah)
    expect(commentAuthorLabel(bySarah, olivier, t)).toBe('Sarah Connor')
    expect(commentAuthorLabel(bySarah, sarah, t)).toBe('You')
    expect(isOwnCommentEntry(bySarah, olivier)).toBe(false)
    expect(isOwnCommentEntry(bySarah, sarah)).toBe(true)
  })

  it('renders a legacy "You" comment as an unknown author when signed in, as You when not', () => {
    const legacy = { author: LEGACY_COMMENT_AUTHOR }
    expect(commentAuthorLabel(legacy, olivier, t)).toBe('Unknown author')
    expect(isOwnCommentEntry(legacy, olivier)).toBe(false)
    // AUTH off: one local user, who wrote every identity-less comment.
    expect(commentAuthorLabel(legacy, null, t)).toBe('You')
    expect(isOwnCommentEntry(legacy, null)).toBe(true)
    // ...but not one stamped with an identity in an earlier signed-in session.
    expect(isOwnCommentEntry(commentAuthorshipFor(sarah), null)).toBe(false)
  })

  it('"Yours" lists only the viewer\'s comments, and rows name their authors', () => {
    useAuthStore.setState({ user: olivier })
    useModelStore.setState({
      currentDiagramId: 'D1',
      comments: [
        comment('c-olivier', 'olivier@example.com', 'u-olivier'),
        comment('c-sarah', 'Sarah Connor', 'u-sarah'),
        comment('c-legacy', LEGACY_COMMENT_AUTHOR),
      ],
    })
    render(<CommentsDropdown onClose={() => {}} onSelectComment={() => {}} />)

    const authorOf = (id: string) =>
      within(document.querySelector(`[data-comment-id="${id}"]`) as HTMLElement).getByTestId('comment-row-author').textContent
    expect(authorOf('c-olivier')).toBe('You')
    expect(authorOf('c-sarah')).toBe('Sarah Connor')
    expect(authorOf('c-legacy')).toBe('Unknown author')

    fireEvent.click(screen.getByText('Your comments'))
    const ids = [...document.querySelectorAll('[data-comment-id]')].map((e) => e.getAttribute('data-comment-id'))
    expect(ids).toEqual(['c-olivier'])
  })

  it('a reply is stored with its writer and rendered by name to everyone else', () => {
    useModelStore.setState({ currentDiagramId: 'D1', comments: [comment('c1', 'olivier@example.com', 'u-olivier')] })
    useAuthStore.setState({ user: sarah })
    const view = render(
      <CommentDetail comment={useModelStore.getState().comments[0]} screenX={0} screenY={0} onClose={() => {}} />
    )
    fireEvent.change(screen.getByTestId('comment-reply-input'), { target: { value: 'Looks right' } })
    fireEvent.keyDown(screen.getByTestId('comment-reply-input'), { key: 'Enter' })
    const stored = useModelStore.getState().comments[0].replies
    expect(stored).toEqual([expect.objectContaining({ text: 'Looks right', author: 'Sarah Connor', authorId: 'u-sarah' })])

    // Olivier's screen: the reply is Sarah's, not "You".
    act(() => useAuthStore.setState({ user: olivier }))
    view.rerender(
      <CommentDetail comment={useModelStore.getState().comments[0]} screenX={0} screenY={0} onClose={() => {}} />
    )
    expect(screen.getByTestId('comment-reply-author').textContent).toBe('Sarah Connor')
  })
})
