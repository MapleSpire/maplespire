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

// These entry points can run while the fan-out drain is yielding. Calling
// #evaluate directly there processes every dirty peer in one synchronous turn,
// bypassing the drain's per-peer yield. Keep state changes and denial messages
// immediate; coalesce the subsequent protocol/availability evaluation.
const entryPoints = [
  ['network-ready', `            this.#networkReady = true;
            this.#evaluate();`],
  ['peer-removal', `            status: "unavailable",
        });
        this.#evaluate();`],
  ['non-sync-message', `                throw new Error(\`unknown message type: \${message.type}\`);
        }
        this.#evaluate();`],
  ['share-policy', `                peer.dirty = true;
                this.#evaluate();`],
  ['explicit-sync', `            if (peer.syncState)
                peer.dirty = true;
        }
        this.#evaluate();`],
  ['denied-activation', `            this.#evaluate();
            return;
        }
        // Only emit "open-doc"`],
]

export function patchCooperativeEventsSource(source) {
  let patched = source
  let changed = false
  for (const [name, before] of entryPoints) {
    const after = before.replace('this.#evaluate();', 'this.scheduleInboundEvaluation();')
    const oldCount = patched.split(before).length - 1
    const newCount = patched.split(after).length - 1
    if (oldCount === 0 && newCount === 1) continue
    if (oldCount !== 1 || newCount !== 0) {
      throw new Error(`Unsupported automerge-repo cooperative ${name} source; review its event entry point before upgrading.`)
    }
    patched = patched.replace(before, after)
    changed = true
  }
  if (patched.includes('this.#evaluate();')) {
    throw new Error('Unsupported automerge-repo direct evaluation entry point; review it before upgrading.')
  }
  return { source: patched, changed }
}
