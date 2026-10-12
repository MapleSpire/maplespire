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

import { useState } from 'react'
import { Copy, Check, Link2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button'
import { copyToClipboard } from '../../../lib/clipboard'

/** Read-only link field + "Copy link" button with transient "Copied!" feedback. */
export function ShareLinkRow({ url }: { url: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const onCopy = async () => {
    if (await copyToClipboard(url)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-50 px-3 py-2">
      <Link2 className="h-4 w-4 shrink-0 text-fg-subtle" />
      <span data-testid="share-link-url" className="flex-1 truncate text-[13px] text-fg-secondary" title={url}>
        {url}
      </span>
      <Button variant="secondary" size="sm" onClick={onCopy} className="shrink-0 gap-1">
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? t('shareDialog.linkRow.copied') : t('shareDialog.linkRow.copyLink')}
      </Button>
    </div>
  )
}
