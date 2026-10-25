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

// QA lens 2026-10-25: the layout worker answers every job, even one that throws
// or whose answer cannot be sent.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { LayoutJob, LayoutJobAnswer, LayoutJobMessage } from './layoutRunner'

interface WorkerScope {
  onmessage: ((event: { data: LayoutJobMessage }) => void) | null
  postMessage?: (message: LayoutJobAnswer) => void
}
const scope = globalThis as unknown as WorkerScope
const answers: LayoutJobAnswer[] = []
let refuseNext = false

beforeAll(async () => {
  scope.postMessage = (message) => {
    if (refuseNext) {
      refuseNext = false
      throw new DOMException('could not be cloned', 'DataCloneError')
    }
    answers.push(message)
  }
  await import('./layoutWorker')
})

const tiny: LayoutJob = {
  kind: 'custom', direction: 'tb',
  diagram: { id: 'd', name: 'd', type: 'container', objectIds: ['a'], connectionIds: [], groupIds: [], layouts: {} } as unknown as LayoutJob['diagram'],
  ctx: {
    objects: [{ id: 'a', type: 'app', name: 'a', position: { x: 0, y: 0 }, size: { width: 100, height: 60 }, tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {} }] as unknown as LayoutJob['ctx']['objects'],
    connections: [], groups: [],
  },
}

describe('layout worker — every job is answered', () => {
  it('answers a job that throws with ok:false', async () => {
    answers.length = 0
    scope.onmessage?.({ data: { id: 1, job: { ...tiny, diagram: null as unknown as LayoutJob['diagram'] } } })
    await vi.waitFor(() => expect(answers).toHaveLength(1))
    expect(answers[0]).toMatchObject({ id: 1, ok: false })
  })

  it('answers ok:false when the answer itself cannot be sent', async () => {
    answers.length = 0
    refuseNext = true
    scope.onmessage?.({ data: { id: 2, job: tiny } })
    await vi.waitFor(() => expect(answers).toHaveLength(1))
    expect(answers[0]).toMatchObject({ id: 2, ok: false })
    expect((answers[0] as { error: string }).error).toMatch(/could not be sent/)
  })
})
