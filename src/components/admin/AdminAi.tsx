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

import { useParams } from '@tanstack/react-router'
import { Sparkles, TerminalSquare, Globe } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { AiConfigForm } from '../ai-assist/AiConfigForm'
import { resolveAiPublicBaseUrl } from '../../lib/ai/api'

/**
 * Org admin console — AI page: the org's model configuration (BYOK, key
 * encrypted at rest) plus connection recipes for external AI agents (remote
 * MCP with Bearer/OAuth, local stdio MCP, tool REST API).
 */
export function AdminAi() {
  const { orgId } = useParams({ from: '/org/$orgId/admin' })
  const { t } = useTranslation()
  const apiBase = resolveAiPublicBaseUrl()

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-6 p-6" data-testid="admin-ai">
      <section className="rounded-xl border border-line bg-surface-100 p-5">
        <div className="mb-1 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-accent" />
          <h2 className="text-[15px] font-semibold text-fg">{t('admin.ai.modelTitle')}</h2>
        </div>
        <p className="mb-4 text-[12.5px] leading-relaxed text-fg-secondary">{t('admin.ai.modelDescription')}</p>
        <AiConfigForm orgId={orgId} />
      </section>

      <section className="rounded-xl border border-line bg-surface-100 p-5">
        <div className="mb-1 flex items-center gap-2">
          <Globe className="h-4 w-4 text-fg-secondary" />
          <h2 className="text-[15px] font-semibold text-fg">{t('admin.ai.connectAgentsTitle')}</h2>
        </div>
        <p className="mb-3 text-[12.5px] leading-relaxed text-fg-secondary">
          <Trans i18nKey="admin.ai.connectAgentsDescription" components={{ strong: <strong /> }} />
        </p>
        <Snippet
          label={t('admin.ai.remoteMcpLabel')}
          code={`claude mcp add --transport http maplespire ${apiBase}/mcp \\\n  --header "Authorization: Bearer bvr_YOUR_TOKEN"`}
        />
        <Snippet
          label={t('admin.ai.localMcpLabel')}
          code={`claude mcp add maplespire \\\n  -e MAPLESPIRE_URL=${apiBase} -e MAPLESPIRE_TOKEN=bvr_YOUR_TOKEN \\\n  -- npx tsx server/src/ai/adapters/mcp/stdio.ts`}
        />
        <Snippet
          label={t('admin.ai.agentInstructionsLabel')}
          code={`curl -H "Authorization: Bearer bvr_YOUR_TOKEN" ${apiBase}/api/ai/skill`}
        />
      </section>

      <section className="rounded-xl border border-line bg-surface-100 p-5">
        <div className="mb-1 flex items-center gap-2">
          <TerminalSquare className="h-4 w-4 text-fg-secondary" />
          <h2 className="text-[15px] font-semibold text-fg">{t('admin.ai.functionCallApiTitle')}</h2>
        </div>
        <p className="mb-3 text-[12.5px] leading-relaxed text-fg-secondary">{t('admin.ai.functionCallApiDescription')}</p>
        <Snippet label={t('admin.ai.listToolsLabel')} code={`GET ${apiBase}/api/ai/tools?format=openai`} />
        <Snippet label={t('admin.ai.executeOneToolLabel')} code={`POST ${apiBase}/api/ai/tools/list_model_objects\n{"input": {"type": "system"}}`} />
        <Snippet
          label={t('admin.ai.runFullSequenceLabel')}
          code={`POST ${apiBase}/api/ai/run\n{"prompt": "How many systems are there?", "thinking": true}`}
        />
      </section>
    </div>
  )
}

function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{label}</div>
      <pre className="m-0 overflow-x-auto rounded-lg border border-line bg-surface-50 px-3 py-2 font-mono text-[11.5px] leading-[1.5] text-fg-secondary">
        {code}
      </pre>
    </div>
  )
}
