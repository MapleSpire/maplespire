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

// Layout worker: lays out, routes and scores ONE auto-layout candidate per
// message (layoutRunner.ts). The same functions the calling thread runs when no
// worker is available — ELK included, on this worker's own thread.

import { runLayoutJob } from './layoutJob'
import type { LayoutJobAnswer, LayoutJobMessage } from './layoutRunner'

interface WorkerScope {
  onmessage: ((event: MessageEvent<LayoutJobMessage>) => void) | null
  postMessage(message: LayoutJobAnswer): void
}

const scope = globalThis as unknown as WorkerScope

scope.onmessage = (event) => {
  const { id, job } = event.data
  const answer = async (): Promise<LayoutJobAnswer> => {
    try {
      return { id, ok: true, solution: await runLayoutJob(job) }
    } catch (error) {
      return { id, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  void answer().then((message) => {
    // An answer that cannot be cloned would otherwise leave the job unanswered
    // until the pool's deadline calls this worker stuck.
    try {
      scope.postMessage(message)
    } catch (error) {
      scope.postMessage({ id, ok: false, error: `the answer could not be sent: ${error instanceof Error ? error.message : String(error)}` })
    }
  })
}
