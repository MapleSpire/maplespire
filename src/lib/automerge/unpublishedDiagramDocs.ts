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

/**
 * DiagramDocs this session created whose registry meta does not name them yet.
 *
 * The bridge's id → doc-url index is REBUILT from the registry shards on every
 * shard-changing projection — and on the classic path `projectAll` runs
 * synchronously on the echo of flushWrite's own model write. The
 * create→flush→publish gate holds a new diagram's meta back until its document
 * is durable, so in that window the shards do not name the document and a
 * rebuild used to drop it from the index. The next flush then minted a second
 * document, and a meta could be published with `docUrl: ''` — after which every
 * flush minted yet another position-less document for that diagram (traced on
 * a dev stack 2026-10-21: a 15-view Structurizr import, 14 documents every
 * ~730 ms). `bridgeImportDocUrl.test.ts` reproduces the duplicate documents and
 * the empty-docUrl publish, and pins the heal of an already-empty meta to ONE
 * new document; the open-ended loop itself was only observed live.
 *
 * The registry stays the authority: a meta that names a document wins and
 * retires the session's record. Only a meta that names NONE — absent, or
 * published empty by that defect — falls back to the session's document.
 */
export class UnpublishedDiagramDocs {
  private urls = new Map<string, string>()

  get size(): number {
    return this.urls.size
  }

  /** A document was just created for `diagramId`; its meta is not placed yet. */
  record(diagramId: string, docUrl: string): void {
    this.urls.set(diagramId, docUrl)
  }

  /** The diagram was deleted, or its meta now names a document. */
  forget(diagramId: string): void {
    this.urls.delete(diagramId)
  }

  clear(): void {
    this.urls.clear()
  }

  /** Drop the records of diagrams no longer in `residentIds` — deleted before
   *  their meta was ever placed, so no registry removal will retire them. */
  retainOnly(residentIds: ReadonlySet<string>): void {
    for (const diagramId of [...this.urls.keys()]) {
      if (!residentIds.has(diagramId)) this.urls.delete(diagramId)
    }
  }

  /**
   * The url the index must hold for a registry meta. A non-empty `metaDocUrl`
   * wins and retires the record; an empty one keeps the session's document.
   */
  resolve(diagramId: string, metaDocUrl: string | undefined): string {
    if (metaDocUrl) {
      this.urls.delete(diagramId)
      return metaDocUrl
    }
    return this.urls.get(diagramId) ?? ''
  }

  /** Put back every recorded document the rebuilt index does not name — and
   *  retire, without putting back, the record of a diagram `isDeleted` names: a
   *  deleted diagram must have no resolvable url. */
  readmit(index: Map<string, string>, isDeleted: (diagramId: string) => boolean = () => false): void {
    for (const [diagramId, docUrl] of [...this.urls]) {
      if (isDeleted(diagramId)) this.urls.delete(diagramId)
      else if (!index.get(diagramId)) index.set(diagramId, docUrl)
    }
  }
}
