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
 * The lit board's connection EDIT HANDLES (selected spec v1, 2026-10-12, §4):
 * UI, not board decals. Every handle is a SCREEN-ALIGNED circle of constant
 * css size — a billboard quad grown in the vertex shader from its world
 * anchor, its rings drawn by a signed-distance fragment shader — so it stays
 * a crisp 10-px circle at every pose, never the flat world-sized oval the
 * old discs projected to (user-ref/selected-line-dark.webp: discs of r 6
 * world that ballooned to ~40 px at the user's framing and floated off the
 * line, lifted to the card tops).
 *
 * Anatomy (css px, design-system tokens): a warm drop shadow (0 1 3), a 1-px
 * outer HAIRLINE in the board's ink — white against the honey wood is only
 * 2.45:1, the hairline carries the silhouette — a 2-px ring and a 6-px body.
 *  - endpoint: coral body, white ring (2D: a solid coral anchor);
 *  - bend: white body, coral ring (2D: white with a coral ring);
 *  - drop anchor: 6-px coral body at 0.85, 1.5-px white ring; snapped 10.
 * Hover grows 10 → 12 over --duration-fast with --ease-out and adds the
 * --shadow-glow ring; pressed fills coral-800 (body for an endpoint, ring for
 * a bend).
 *
 * The pure helpers (handleStyle, discTriangleGap, editHandleVisibility,
 * handleHitRadius) are what the unit tests pin; the shader is what draws.
 */

import * as THREE from 'three'

export type EditHandleKind = 'endpoint' | 'bend' | 'anchor' | 'anchorSnapped'

/** One handle as the geometry carries it. */
export interface EditHandleSpec {
  /** Anchor, layer-local world px. */
  x: number
  y: number
  z: number
  kind: EditHandleKind
  /** Stable id for the hover / pressed uniforms (>= 0). */
  id: number
  /** Drawn at all (a hidden handle keeps its vertices, zero-sized). */
  visible: boolean
}

export interface HandleColours {
  body: string
  bodyAlpha: number
  ring: string
}

export interface HandleLook extends HandleColours {
  /** Outer diameter of the ring (css px) at rest. */
  diameter: number
  /** Ring width (css px). */
  ringW: number
}

/** Design-system tokens (tokens/colors.css, tokens/spacing.css). The light
 * hairline's alpha is 0.8, not the design spec's 0.55: blended over the
 * measured wood #D0995A, 0.55 reads 2.25:1 against it and the white ring
 * 2.50:1 — no part of the silhouette reached 3:1; 0.8 reads 3.43:1 (WCAG on
 * the alpha-blended hex, editHandle.test). On the dark stone the paper ring
 * carries it (12.7:1). */
export const HANDLE_TOKENS = {
  light: {
    coral: '#D97A3D',
    pressed: '#B85E26',
    paper: '#FFFFFF',
    hair: { css: '#3A362F', alpha: 0.8 },
    shadow: { css: '#26221C', alpha: 0.35 },
    glow: { alpha: 0.16 },
  },
  dark: {
    coral: '#E89456',
    pressed: '#F4B589',
    paper: '#F2F0EC',
    hair: { css: '#161513', alpha: 0.7 },
    shadow: { css: '#000000', alpha: 0.55 },
    glow: { alpha: 0.28 },
  },
} as const

/** Rest diameter, hover / pressed diameter (css px). */
export const HANDLE_D = 10
export const HANDLE_D_HOT = 12
export const HANDLE_RING_W = 2
export const ANCHOR_D = 6
export const ANCHOR_RING_W = 1.5
/** --duration-fast. */
export const HANDLE_HOVER_MS = 150

/** The look of one handle kind in one appearance. `coral` is the line's own
 * highlight (skin.connections.highlight), so the handle matches its core. */
export function handleStyle(kind: EditHandleKind, dark: boolean, coral?: string): HandleLook {
  const t = dark ? HANDLE_TOKENS.dark : HANDLE_TOKENS.light
  const c = coral ?? t.coral
  switch (kind) {
    case 'endpoint':
      return { body: c, bodyAlpha: 1, ring: t.paper, diameter: HANDLE_D, ringW: HANDLE_RING_W }
    case 'bend':
      return { body: t.paper, bodyAlpha: 1, ring: c, diameter: HANDLE_D, ringW: HANDLE_RING_W }
    case 'anchor':
      return { body: c, bodyAlpha: 0.85, ring: t.paper, diameter: ANCHOR_D + 2 * ANCHOR_RING_W, ringW: ANCHOR_RING_W }
    case 'anchorSnapped':
      return { body: c, bodyAlpha: 1, ring: t.paper, diameter: HANDLE_D, ringW: HANDLE_RING_W }
  }
}

/** A handle's pick radius (css px): its drawn radius + 4, at least 9. */
export function handleHitRadius(diameterCss: number): number {
  return Math.max(diameterCss / 2 + 4, 9)
}

/** --ease-out cubic-bezier(.16, 1, .3, 1), solved for x (Newton). */
export function easeOut(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  const bez = (p1: number, p2: number, u: number) => 3 * (1 - u) * (1 - u) * u * p1 + 3 * (1 - u) * u * u * p2 + u * u * u
  let u = x
  for (let i = 0; i < 8; i++) {
    const fx = bez(0.16, 0.3, u) - x
    const d = 3 * (1 - u) * (1 - u) * 0.16 + 6 * (1 - u) * u * (0.3 - 0.16) + 3 * u * u * (1 - 0.3)
    if (Math.abs(d) < 1e-6) break
    u = Math.min(1, Math.max(0, u - fx / d))
  }
  return bez(1, 1, u)
}

/** Screen distance (css px) from a disc (centre `c`, radius `r`) to a
 * triangle: > 0 clear of it, <= 0 touching or overlapping. */
export function discTriangleGap(
  c: { x: number; y: number },
  r: number,
  tri: readonly { x: number; y: number }[],
): number {
  const segD = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / l2)) : 0
    return Math.hypot(a.x + dx * t - c.x, a.y + dy * t - c.y)
  }
  const side = (a: { x: number; y: number }, b: { x: number; y: number }) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  const s1 = side(tri[0], tri[1])
  const s2 = side(tri[1], tri[2])
  const s3 = side(tri[2], tri[0])
  const inside = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)
  const edge = Math.min(segD(tri[0], tri[1]), segD(tri[1], tri[2]), segD(tri[2], tri[0]))
  return (inside ? -edge : edge) - r
}

/** Which endpoint handles a selected line shows (§4.2): the target knob
 * hides when it would land within 18 css px of the source handle (or past
 * it), the head alone then being the target grip; under 24 css px of drawn
 * line only the source handle shows. */
export function editHandleVisibility(input: {
  /** On-screen distance between the source and knob centres (css px), null
   * when the knob has no place on the line. */
  knobToSourcePx: number | null
  /** On-screen length of the drawn line, source to tip (css px). */
  linePx: number
}): { source: boolean; knob: boolean } {
  if (input.linePx < 24) return { source: true, knob: false }
  return { source: true, knob: input.knobToSourcePx !== null && input.knobToSourcePx >= 18 }
}

// ── the material ────────────────────────────────────────────────────────────

/** Uniforms every handle material shares (one object per scene). */
export interface HandleUniforms {
  uHoverId: THREE.IUniform<number>
  uHoverT: THREE.IUniform<number>
  uPressId: THREE.IUniform<number>
  uPressCol: THREE.IUniform<THREE.Color>
  uHair: THREE.IUniform<THREE.Vector4>
  uShadow: THREE.IUniform<THREE.Vector4>
  uGlow: THREE.IUniform<THREE.Vector4>
}

export function createHandleUniforms(): HandleUniforms {
  return {
    uHoverId: { value: -1 },
    uHoverT: { value: 0 },
    uPressId: { value: -1 },
    uPressCol: { value: new THREE.Color(HANDLE_TOKENS.light.pressed) },
    uHair: { value: new THREE.Vector4(0, 0, 0, 0.55) },
    uShadow: { value: new THREE.Vector4(0, 0, 0, 0.35) },
    uGlow: { value: new THREE.Vector4(1, 0.5, 0.2, 0.16) },
  }
}

/** Point the shared uniforms at an appearance (and the line's coral). */
export function setHandleAppearance(u: HandleUniforms, dark: boolean, coral: string): void {
  const t = dark ? HANDLE_TOKENS.dark : HANDLE_TOKENS.light
  const v4 = (css: string, a: number) => {
    const c = new THREE.Color(css)
    return new THREE.Vector4(c.r, c.g, c.b, a)
  }
  u.uPressCol.value.set(t.pressed)
  u.uHair.value.copy(v4(t.hair.css, t.hair.alpha))
  u.uShadow.value.copy(v4(t.shadow.css, t.shadow.alpha))
  u.uGlow.value.copy(v4(coral, t.glow.alpha))
}

const KIND_CODE: Record<EditHandleKind, number> = { endpoint: 0, bend: 1, anchor: 2, anchorSnapped: 3 }

/** The handles as ONE geometry: four vertices per handle on its anchor. */
export function buildHandleGeometry(handles: readonly EditHandleSpec[], dark: boolean, coral: string): THREE.BufferGeometry {
  const pos: number[] = []
  const corner: number[] = []
  const size: number[] = []
  const body: number[] = []
  const ring: number[] = []
  const index: number[] = []
  const c = new THREE.Color()
  handles.forEach((h, k) => {
    const look = handleStyle(h.kind, dark, coral)
    c.set(look.body)
    const b = [c.r, c.g, c.b, look.bodyAlpha]
    c.set(look.ring)
    const r = [c.r, c.g, c.b, 1]
    for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      pos.push(h.x, h.y, h.z)
      corner.push(cx, cy)
      size.push(h.visible ? look.diameter : 0, look.ringW, KIND_CODE[h.kind], h.id)
      body.push(...b)
      ring.push(...r)
    }
    const o = k * 4
    index.push(o, o + 1, o + 2, o, o + 2, o + 3)
  })
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2))
  geo.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 4))
  geo.setAttribute('aBody', new THREE.Float32BufferAttribute(body, 4))
  geo.setAttribute('aRing', new THREE.Float32BufferAttribute(ring, 4))
  geo.setIndex(index)
  geo.computeBoundingSphere()
  if (geo.boundingSphere) geo.boundingSphere.radius += 64
  return geo
}

/** Move handle `k`'s anchor (and show / hide it) in a built geometry. */
export function setHandleAnchor(geo: THREE.BufferGeometry, k: number, x: number, y: number, z: number, diameter: number): void {
  const p = geo.getAttribute('position') as THREE.BufferAttribute
  const s = geo.getAttribute('aSize') as THREE.BufferAttribute
  for (let v = k * 4; v < k * 4 + 4; v++) {
    p.setXYZ(v, x, y, z)
    s.setX(v, diameter)
  }
  p.needsUpdate = true
  s.needsUpdate = true
}

const VERTEX = /* glsl */ `
attribute vec2 aCorner;
attribute vec4 aSize;
attribute vec4 aBody;
attribute vec4 aRing;
uniform float uInkViewH;
uniform float uInkViewW;
uniform float uHoverId;
uniform float uHoverT;
uniform float uPressId;
varying vec2 vPx;
varying float vRadius;
varying float vRingW;
varying float vKind;
varying float vHover;
varying float vPress;
varying vec4 vBody;
varying vec4 vRing;
void main() {
  float hov = abs(aSize.w - uHoverId) < 0.5 ? uHoverT : 0.0;
  float press = abs(aSize.w - uPressId) < 0.5 ? 1.0 : 0.0;
  // 10 -> 12 hovered or pressed (anchors grow alike, by the same ratio)
  float d = aSize.x * (1.0 + ${(HANDLE_D_HOT / HANDLE_D - 1).toFixed(4)} * max(hov, press));
  // room for the hairline, the glow ring and the shadow's offset blur
  float pad = d * 0.5 + 1.0 + 3.5 + 4.0;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // pulled toward the camera along its own ray (same screen point) so the
  // tilted board round the anchor never cuts the disc
  float wpp = 2.0 * max(-mv.z, 1e-3) / (projectionMatrix[1][1] * uInkViewH);
  mv.xyz += normalize(-mv.xyz) * 6.0 * pad * wpp;
  vec4 clip = projectionMatrix * mv;
  clip.xy += aCorner * pad * vec2(2.0 / uInkViewW, 2.0 / uInkViewH) * clip.w;
  gl_Position = d > 0.0 ? clip : vec4(2.0, 2.0, 2.0, 1.0);
  vPx = aCorner * pad;
  vRadius = d * 0.5;
  vRingW = aSize.y;
  vKind = aSize.z;
  vHover = hov;
  vPress = press;
  vBody = aBody;
  vRing = aRing;
}
`

const FRAGMENT = /* glsl */ `
uniform vec3 uPressCol;
uniform vec4 uHair;
uniform vec4 uShadow;
uniform vec4 uGlow;
uniform float uOpacity;
varying vec2 vPx;
varying float vRadius;
varying float vRingW;
varying float vKind;
varying float vHover;
varying float vPress;
varying vec4 vBody;
varying vec4 vRing;
vec4 over(vec4 dst, vec4 src) {
  float a = src.a + dst.a * (1.0 - src.a);
  vec3 c = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / max(a, 1e-4);
  return vec4(c, a);
}
float disc(float d, float r, float aa) {
  return 1.0 - smoothstep(r - aa, r + aa, d);
}
void main() {
  float d = length(vPx);
  float aa = max(fwidth(d) * 0.5, 0.35);
  float rRing = vRadius;
  float rBody = vRadius - vRingW;
  float rHair = vRadius + 1.0;
  vec4 col = vec4(0.0);
  // shadow 0 1px 3px (screen y is up: 1 px DOWN)
  float sd = length(vPx + vec2(0.0, 1.0));
  col = over(col, vec4(uShadow.rgb, uShadow.a * (1.0 - smoothstep(rHair - 1.5, rHair + 3.0, sd))));
  // hover glow: --shadow-glow, 3 px outside the hairline
  float glow = vHover * uGlow.a * disc(d, rHair + 3.0, aa) * (1.0 - disc(d, rHair, aa));
  col = over(col, vec4(uGlow.rgb, glow));
  col = over(col, vec4(uHair.rgb, uHair.a * disc(d, rHair, aa)));
  vec3 ringCol = vKind > 0.5 && vKind < 1.5 ? mix(vRing.rgb, uPressCol, vPress) : vRing.rgb;
  col = over(col, vec4(ringCol, vRing.a * disc(d, rRing, aa)));
  vec3 bodyCol = vKind < 0.5 ? mix(vBody.rgb, uPressCol, vPress) : vBody.rgb;
  col = over(col, vec4(bodyCol, vBody.a * disc(d, rBody, aa)));
  if (col.a < 0.003) discard;
  gl_FragColor = vec4(col.rgb, col.a * uOpacity);
  #include <colorspace_fragment>
}
`

/**
 * The handle material: `xray` draws only where the handle is BEHIND
 * something (depthFunc GreaterDepth) at 0.4 — a handle behind its own card
 * at the low pose still shows, as a ghost. Both variants are the same
 * program (same source; depthFunc and the opacity uniform are not part of
 * the key).
 */
export function createHandleMaterial(
  ink: { uInkViewH: THREE.IUniform<number>; uInkViewW: THREE.IUniform<number> },
  shared: HandleUniforms,
  xray: boolean,
): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    name: 'editHandle',
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uInkViewH: ink.uInkViewH,
      uInkViewW: ink.uInkViewW,
      uHoverId: shared.uHoverId,
      uHoverT: shared.uHoverT,
      uPressId: shared.uPressId,
      uPressCol: shared.uPressCol,
      uHair: shared.uHair,
      uShadow: shared.uShadow,
      uGlow: shared.uGlow,
      uOpacity: { value: xray ? 0.4 : 1 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    depthFunc: xray ? THREE.GreaterDepth : THREE.LessEqualDepth,
    toneMapped: false,
    fog: false,
  })
  m.userData.editHandle = xray ? 'xray' : 'front'
  return m
}
