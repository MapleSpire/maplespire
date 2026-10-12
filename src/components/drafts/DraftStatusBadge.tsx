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

import { useTranslation } from 'react-i18next'
import { Badge, type BadgeProps } from '../ui/badge'
import type { DraftStatus } from '../../lib/drafts/api'

/** Maps a draft's lifecycle status to a labelled status pill. */
const STATUS_MAP: Record<DraftStatus, { variant: BadgeProps['variant']; labelKey: string }> = {
  active: { variant: 'warning', labelKey: 'drafts.status.active' },
  merged: { variant: 'success', labelKey: 'drafts.status.merged' },
  discarded: { variant: 'error', labelKey: 'drafts.status.discarded' },
  archived: { variant: 'info', labelKey: 'drafts.status.archived' },
}

export function DraftStatusBadge({ status }: { status: DraftStatus }) {
  const { t } = useTranslation()
  const { variant, labelKey } = STATUS_MAP[status] ?? STATUS_MAP.active
  return <Badge variant={variant}>{t(labelKey)}</Badge>
}
