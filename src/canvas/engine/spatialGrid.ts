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

export interface SpatialBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Small uniform-grid index for dense diagram scenes. Values may span several
 * buckets, so callers receive a de-duplicated set and remain responsible for
 * applying their semantic z-order.
 */
export class SpatialGridIndex<T> {
  private readonly buckets = new Map<string, T[]>()
  private readonly allValues = new Set<T>()
  private readonly globalValues = new Set<T>()
  private readonly keysByValue = new Map<T, string[]>()
  private readonly cellSize: number
  private readonly maxCellsPerValue: number

  constructor(cellSize: number, maxCellsPerValue = 4096) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new Error('SpatialGridIndex cellSize must be positive')
    }
    this.cellSize = cellSize
    this.maxCellsPerValue = maxCellsPerValue
  }

  insert(bounds: SpatialBounds, value: T): void {
    this.remove(value)
    this.allValues.add(value)
    const { minX, minY, maxX, maxY } = this.cellRange(bounds)
    const occupiedCells = (maxX - minX + 1) * (maxY - minY + 1)
    // Very long diagonal connections have a huge bounding rectangle but touch
    // relatively few pixels. Keeping them as global candidates is bounded and
    // exact after the caller's final geometry test; bucketing every cell could
    // otherwise allocate hundreds of thousands of arrays for one edge.
    if (occupiedCells > this.maxCellsPerValue) {
      this.globalValues.add(value)
      this.keysByValue.set(value, [])
      return
    }
    const keys: string[] = []
    for (let cellX = minX; cellX <= maxX; cellX += 1) {
      for (let cellY = minY; cellY <= maxY; cellY += 1) {
        const key = `${cellX},${cellY}`
        keys.push(key)
        const bucket = this.buckets.get(key)
        if (bucket) bucket.push(value)
        else this.buckets.set(key, [value])
      }
    }
    this.keysByValue.set(value, keys)
  }

  remove(value: T): void {
    const keys = this.keysByValue.get(value)
    if (!keys) return
    for (const key of keys) {
      const bucket = this.buckets.get(key)
      if (!bucket) continue
      const index = bucket.indexOf(value)
      if (index >= 0) bucket.splice(index, 1)
      if (bucket.length === 0) this.buckets.delete(key)
    }
    this.keysByValue.delete(value)
    this.globalValues.delete(value)
    this.allValues.delete(value)
  }

  query(bounds: SpatialBounds): Set<T> {
    const { minX, minY, maxX, maxY } = this.cellRange(bounds)
    const requestedCells = (maxX - minX + 1) * (maxY - minY + 1)
    // A zoomed-out viewport can span more empty cells than the whole index.
    // Returning the already-known population avoids an O(view-area) grid walk.
    if (requestedCells > Math.max(this.buckets.size * 2, 256)) {
      return new Set(this.allValues)
    }

    const values = new Set<T>(this.globalValues)
    for (let cellX = minX; cellX <= maxX; cellX += 1) {
      for (let cellY = minY; cellY <= maxY; cellY += 1) {
        const bucket = this.buckets.get(`${cellX},${cellY}`)
        if (!bucket) continue
        for (const value of bucket) values.add(value)
      }
    }
    return values
  }

  private cellRange(bounds: SpatialBounds) {
    const right = bounds.x + Math.max(0, bounds.width)
    const bottom = bounds.y + Math.max(0, bounds.height)
    return {
      minX: Math.floor(bounds.x / this.cellSize),
      minY: Math.floor(bounds.y / this.cellSize),
      maxX: Math.floor(right / this.cellSize),
      maxY: Math.floor(bottom / this.cellSize),
    }
  }
}
