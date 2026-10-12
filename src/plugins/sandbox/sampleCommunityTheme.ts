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

import type { ThemePlugin } from '../sdk/contract'
import type { SkinConfig } from '../../skins/types'
import { defaultSkin } from '../../skins/defaultSkin'

/**
 * Sample community theme exercising the sandbox end-to-end. Authored
 * as a real TypeScript module — `import { defineTheme } from '@theme/sdk'` +
 * `export default` + a type annotation — which the worker compiles with Sucrase.
 * It reskins objects, connections and groups on the worker overlay (a near-full
 * "blueprint" reskin), and probes `fetch`/`indexedDB` to verify they're blocked.
 */
const CODE = `
import { defineTheme } from '@theme/sdk'

// Security probes — must be neutralized by the sandbox.
try { fetch('https://example.com') } catch (e) {}
try { const _ = indexedDB } catch (e) {}

export default defineTheme({
  meta: { id: 'community:demo:blueprint', name: 'Blueprint', version: '1.0.0', trust: 'community', sdkVersion: '1.0.0' },

  connectionLine: {
    mode: 'replace',
    draw(d, a) {
      const color = a.state.highlighted ? '#7dd3fc' : '#1d4ed8'
      d.save()
      // Dashed curve
      d.strokeStyle = color
      d.lineWidth = 1.5
      d.setLineDash([5, 4])
      d.beginPath()
      const p0 = a.bezierAt(0)
      d.moveTo(p0.x, p0.y)
      for (let t = 0.05; t <= 1.0001; t += 0.05) {
        const p = a.bezierAt(t)
        d.lineTo(p.x, p.y)
      }
      d.lineTo(a.to.x, a.to.y)
      d.stroke()
      // Arrowhead tip on the target edge, aligned with the final approach segment
      // (toLine -> toEdge), which is correct regardless of how curved the line is.
      const tip = a.to
      const end = a.bezierAt(1)
      let dx = tip.x - end.x
      let dy = tip.y - end.y
      if (dx * dx + dy * dy < 9) {
        const near = a.bezierAt(0.96)
        dx = end.x - near.x
        dy = end.y - near.y
      }
      const ang = Math.atan2(dy, dx)
      const len = 9
      const spread = 0.45
      d.setLineDash([])
      d.beginPath()
      d.moveTo(tip.x, tip.y)
      d.lineTo(tip.x - len * Math.cos(ang - spread), tip.y - len * Math.sin(ang - spread))
      d.lineTo(tip.x - len * Math.cos(ang + spread), tip.y - len * Math.sin(ang + spread))
      d.closePath()
      d.fillStyle = color
      d.fill()
      d.restore()
    }
  },

  group: {
    mode: 'replace',
    draw(d, a) {
      const g = a.geom
      d.save()
      d.strokeStyle = 'rgba(56,189,248,0.35)'
      d.lineWidth = 1
      d.setLineDash([2, 4])
      d.strokeRect(g.x, g.y, g.w, g.h)
      d.restore()
    }
  },

  object: {
    mode: 'replace',
    draw(d, a) {
      const g: { x: number; y: number; w: number; h: number } = a.geom
      const sel: boolean = a.state.selected
      d.save()
      d.fillStyle = sel ? 'rgba(56,189,248,0.32)' : 'rgba(15,42,99,0.65)'
      d.strokeStyle = sel ? '#7dd3fc' : '#38bdf8'
      d.lineWidth = 2
      d.beginPath()
      d.rect(g.x, g.y, g.w, g.h)
      d.fill()
      d.stroke()
      d.lineWidth = 1
      d.strokeStyle = '#7dd3fc'
      const s = 10
      d.beginPath()
      d.moveTo(g.x, g.y + s); d.lineTo(g.x, g.y); d.lineTo(g.x + s, g.y)
      d.moveTo(g.x + g.w - s, g.y); d.lineTo(g.x + g.w, g.y); d.lineTo(g.x + g.w, g.y + s)
      d.moveTo(g.x, g.y + g.h - s); d.lineTo(g.x, g.y + g.h); d.lineTo(g.x + s, g.y + g.h)
      d.moveTo(g.x + g.w - s, g.y + g.h); d.lineTo(g.x + g.w, g.y + g.h); d.lineTo(g.x + g.w, g.y + g.h - s)
      d.stroke()
      d.fillStyle = '#e0f2fe'
      d.font = '600 12px monospace'
      d.textAlign = 'center'
      d.textBaseline = 'middle'
      d.fillText(a.name, g.x + g.w / 2, g.y + g.h / 2)
      d.restore()
    }
  },

  // 3D board (plan §8): pure-data specs, executed in this same sandbox — the
  // blueprint look carried onto the WebGL scene: cyan edge lights + blue grid,
  // people as the pin MODEL and identity systems as the beacon BILLBOARD
  // (both from meta.assets, decoded + capped host-side).
  object3d(a) {
    if (a.type === 'actor') return { geometry: 'gltf', asset: 'pin', scale: 1.1 }
    if (a.type === 'system') return { geometry: 'billboard', asset: 'beacon', scale: 0.6 }
    return {
      edgeGlow: { color: a.selected ? '#7DD3FC' : '#2563EB', width: 1.2 },
      materials: a.external ? { opacity: 0.75 } : null,
    }
  },
  floor3d() {
    return { grid: 'dots', gridColor: '#3B82F6', cornerRadius: 24 }
  }
})
`

/** Embedded assets: a 752-byte low-poly pin GLB + tiny PNGs, generated
 * procedurally — data URIs only, well under the sanitizer caps. */
const PIN_GLB =
  'data:model/gltf-binary;base64,Z2xURgIAAADwAgAAXAIAAEpTT057ImFzc2V0Ijp7InZlcnNpb24iOiIyLjAiLCJnZW5lcmF0b3IiOiJiZWF2ZXJhcmNoLXBpbiJ9LCJzY2VuZSI6MCwic2NlbmVzIjpbeyJub2RlcyI6WzBdfV0sIm5vZGVzIjpbeyJtZXNoIjowLCJuYW1lIjoicGluIn1dLCJtZXNoZXMiOlt7InByaW1pdGl2ZXMiOlt7ImF0dHJpYnV0ZXMiOnsiUE9TSVRJT04iOjB9LCJpbmRpY2VzIjoxLCJtYXRlcmlhbCI6MH1dfV0sIm1hdGVyaWFscyI6W3sicGJyTWV0YWxsaWNSb3VnaG5lc3MiOnsiYmFzZUNvbG9yRmFjdG9yIjpbMC4yMywwLjUxLDAuOTYsMV19fV0sImFjY2Vzc29ycyI6W3siYnVmZmVyVmlldyI6MCwiY29tcG9uZW50VHlwZSI6NTEyNiwiY291bnQiOjYsInR5cGUiOiJWRUMzIiwibWluIjpbLTAuNSwwLC0wLjVdLCJtYXgiOlswLjUsMSwwLjVdfSx7ImJ1ZmZlclZpZXciOjEsImNvbXBvbmVudFR5cGUiOjUxMjMsImNvdW50IjoyNCwidHlwZSI6IlNDQUxBUiJ9XSwiYnVmZmVyVmlld3MiOlt7ImJ1ZmZlciI6MCwiYnl0ZU9mZnNldCI6MCwiYnl0ZUxlbmd0aCI6NzJ9LHsiYnVmZmVyIjowLCJieXRlT2Zmc2V0Ijo3MiwiYnl0ZUxlbmd0aCI6NDh9XSwiYnVmZmVycyI6W3siYnl0ZUxlbmd0aCI6MTIwfV19ICAgeAAAAEJJTgAAAAAAAACAPwAAAAAAAAA/ZmbmPgAAAAAAAAAAZmbmPgAAAD8AAAC/ZmbmPgAAAAAAAAAAZmbmPgAAAL8AAAAAAAAAAAAAAAAAAAIAAQAFAAEAAgAAAAMAAgAFAAIAAwAAAAQAAwAFAAMABAAAAAEABAAFAAQAAQA='

const PAPER_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAHUlEQVR42mPQ9mojCTFoe7UJyBgTj0Y1jGoYOhoANkRx5dCFPbIAAAAASUVORK5CYII='

const BEACON_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAADFElEQVR42t2av0sjQRTHtYqN2uilUxuJf4HF2iSV2AgWgpDCXCN2ATFVeBZWaiEkhdiI3dYWVwiBXBVI/8DuuiPcH/HAM/A5CGF3ZqOJ3k4xEGZn3vt+Z96vmcmcqM3luc1SeEHUlmiF/53AiqhFolYVtYaoXYvanag90O7oazAmYs6XEpgHSB2QPVH7LWp9UfsharGoPdJi+vqM6TGnjoz5zyZQEbVLUeuK2gsAm6J2JGo7orYpakVRW6YV6dthTJM5L8i4RObMCZQwgy6reSNqB6K29g7la8y9QVYX2aVZEdhl23+JWkvU9kRtYQp2vICsFrIf0DVVAkPHe34zgY6onWAS044oRWR30FWdFoHvOF3MSs06tu+hq4fuDxGoIugRB/ysBLWDzp5vJ3w2/8xqZAX/jbB4KGqnonZGO6UvYkxWEjEYdiclUMKZOhnNZkvUjt+y7q2oPYlaW9QuRO2cdkHfE2OOmZPFnDpgKU1CoEFEOPEoWGRl7wFYE7VtUVtNGLvKtxpj75m76NFxApZGVgIVYnLLE23WMY8YUBsT2PgGc2JkrHuiUwtMFR+BebJi32M662TT4UqWP+CsZWQ0PST2wHQ5XnaMD4xgeuNIUousWhuT+GjE2UbWmcOcFsDUBWMqgTr1yYFD4SFbX55i2Cwj89Ax5gBs9TQCK3h77KhttnC+2gxifw3ZW47aKQbjShKBiMTRdCg5Zrt9Drv/tu1XKIz5vZ/BsdvoSBvTBGOURKBKrX7kSFK3ntUvAnbw88/r62gb9vGt6NmFW0eyOwJjNYlAA09Py7oRicjluFfjwBOIXHkc+mncUceyc380J4x+vObUtOlw3nZKkvpnNoMMBAYOc1pFR5ozb4LxepxAgXNr7NjiU0qCd69+xl24QFeaicZgLYwSWMK7HzkCJk0+o65JUxxPQCB2yDlHV9K3ZTA+gDkcArk3odw7cRBhNPeJLPelRO6LudyX00EcaHJ/pMz9oT6Ia5UgLrZyf7UYxOVuENfrQTxwBPHEFMQjXxDPrME8dAfxV4Og/uzxZe0v2qU7O4MPbvsAAAAASUVORK5CYII='

export const sampleCommunityTheme: ThemePlugin = {
  code: CODE,
  meta: {
    id: 'community:demo:blueprint',
    name: 'Blueprint',
    version: '1.0.0',
    trust: 'community',
    // 3D assets referenced by the object3d specs + the env floorTexture —
    // declared HOST-SIDE and gated by the same manifest caps as official packs
    assets: {
      pin: { kind: 'gltf', dataUri: PIN_GLB },
      beacon: { kind: 'texture', dataUri: BEACON_PNG },
      paper: { kind: 'texture', dataUri: PAPER_PNG },
    },
  },
}

/** Base look rendered under the overlay (dark blueprint backdrop + grid). */
export const sampleCommunityBaseConfig: SkinConfig = {
  ...defaultSkin,
  id: 'community:demo:blueprint',
  name: 'Blueprint',
  canvas: { bg: '#0b1220', grid: '#1e293b' },
  three: { environment: { floorTexture: 'paper' } },
}
