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

import type { AuthUser } from '../auth/api'

/**
 * Who wrote a comment or a reply.
 *
 * Comments used to be stored with the literal author `'You'`, which identifies
 * nobody: with two users in one org, Sarah's comment rendered as "You" on
 * Olivier's screen and the "Yours" tab listed everyone's. The stable identity is
 * now `authorId` (`AuthUser.id`); `author` is only the display label captured at
 * write time. "You" is decided at RENDER time, against the signed-in user.
 */

/** The sentinel every comment and reply carried before `authorId` existed, and
 *  what an identity-less (AUTH off) session still writes. It names no one. */
export const LEGACY_COMMENT_AUTHOR = 'You'

export interface CommentAuthorship {
  author: string
  authorId?: string
}

type Viewer = Pick<AuthUser, 'id' | 'email' | 'name'> | null | undefined

/** The authorship to stamp on a comment or reply written by `user` now. */
export function commentAuthorshipFor(user: Viewer): CommentAuthorship {
  if (!user?.id) return { author: LEGACY_COMMENT_AUTHOR }
  return { author: user.name?.trim() || user.email || user.id, authorId: user.id }
}

/**
 * Whether `entry` was written by `viewer`.
 *
 * Signed in: only an exact `authorId` match — a legacy or identity-less entry is
 * nobody's, since it could have been written by anyone in the org.
 * Signed out (AUTH off, single local user): every entry WITHOUT an id is the
 * local user's, which keeps the pre-identity behaviour of that install.
 */
export function isOwnCommentEntry(entry: CommentAuthorship, viewer: Viewer): boolean {
  if (viewer?.id) return !!entry.authorId && entry.authorId === viewer.id
  return !entry.authorId
}

/** The label to render for `entry`'s author, as seen by `viewer`. */
export function commentAuthorLabel(
  entry: CommentAuthorship,
  viewer: Viewer,
  t: (key: string) => string
): string {
  if (isOwnCommentEntry(entry, viewer)) return t('comments.author.you')
  const author = entry.author?.trim()
  if (!author || (!entry.authorId && author === LEGACY_COMMENT_AUTHOR)) return t('comments.author.unknown')
  return author
}
