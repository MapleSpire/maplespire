# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Olivier Albertini
#
# This file is part of MapleSpire.
# MapleSpire is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# MapleSpire is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.

"""The desk's small tools and its CN Tower ornament, authored in Blender and
exported as glTF binaries (quality pass "cntower").

    blender --background --factory-startup --python scripts/blender/desk_tools_assets.py -- \
        --out src/canvas3d/decor/assets [--preview reports/view3d-quality/blender/<run>] \
        [--only pencil|coil|tower]

  desk-pencil.glb   a yellow lacquered HB pencil lying on a flat: a bevelled
                    hex barrel (rounded corners, flat faces) with a black
                    stamp on the top flat, a crimped brass ferrule (two
                    groove bands and rolled lips), a pink eraser with a worn,
                    rounded end, and a sharpened cone that is the exact
                    intersection of the hex prism and a cone — so the
                    lacquer ends in the six scallops of a real sharpened
                    pencil — showing cedar grain and a graphite point.
                    Replaces "chunky faceted hex, flat untextured ferrule,
                    plain eraser" (blind critic, workbench-desk-pencil.png).
  desk-cable-coil.glb  a cream braided cable wound four turns into a 2 x 2
                    bundle, held by a red hook-and-loop tie, one tail running
                    out across the desk into a two-prong (NEMA 1-15) plug.
                    Replaces "a placeholder donut: single smooth torus, no
                    wire turns, no plug".
  cn-tower.glb      a souvenir CN Tower on a round granite plinth: the
                    Y-shaped base (three tapering legs round a hexagonal
                    core), the main pod (white lower skirt and bulge, two
                    dark glass observation bands, the roof), the shaft to the
                    SkyPod and its glass band, the antenna mast with collars
                    — slip-form concrete banding printed on the shaft. 124
                    units tall: a desk ornament, no longer the 281-unit
                    "featureless white cone that dominates the frame".

All three keep the desk props' material contract (print x COLOR_0, one
roughness, single-sided): no new shader program. Origins on the desk at the
centre of the plan-view box, like desk_assets.py.
"""

import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True  # no __pycache__ beside the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import canadiana_assets as ca  # noqa: E402  (helpers; its __main__ does not run)
import desk_assets as da  # noqa: E402  (region_uv, recentre, report, preview)

region_uv = da.region_uv


class Mesh:
    """A bmesh with the UVMap + Color corner layers every desk prop carries.
    Unlike desk_assets.Sheet, a face takes one colour PER CORNER (or one for
    all), so a shading ramp or a paint boundary can ride COLOR_0."""

    def __init__(self):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.col = self.bm.loops.layers.float_color.new("Color")

    def v(self, co):
        return self.bm.verts.new(co)

    def face(self, verts, uvs, rgbs):
        try:
            f = self.bm.faces.new(verts)
        except ValueError:
            return None
        if not isinstance(rgbs, list):
            rgbs = [rgbs] * len(verts)
        for loop, uv, rgb in zip(f.loops, uvs, rgbs):
            c = ca.srgb_to_linear(rgb)
            loop[self.uv].uv = uv
            loop[self.col] = (c[0], c[1], c[2], 1.0)
        return f

    def finish(self, name, recalc=True):
        if recalc:
            bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        obj = bpy.data.objects.new(name, me)
        bpy.context.collection.objects.link(obj)
        me.color_attributes.active_color = me.color_attributes["Color"]
        return obj


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def finish_material(obj, name, tex, roughness):
    img = ca.image_from_array(f"{name}-print", tex)
    obj.data.materials.append(ca.make_material(name, img, roughness=roughness, vertex_color=True))


# ── the pencil ──────────────────────────────────────────────────────────────
# Lying along +X (graphite) / -X (eraser) on its bottom flat, like the
# procedural fallback (build.ts pencilGeom): the same 101-unit length, so the
# registry footprint and every placement gate keep their meaning.

PEN_TEX = 512
LACQ_UV = (0.0, 0.0, 1.0, 0.25)        # u0, v0, u1, v1 (v down)
STAMP_UV = (0.0, 0.25, 1.0, 0.5)       # the top flat's printed run
WOOD_UV = (0.0, 0.5, 0.5, 1.0)
FERRULE_UV = (0.5, 0.5, 1.0, 0.75)
ERASER_UV = (0.5, 0.75, 0.75, 1.0)
GRAPHITE_UV = (0.75, 0.75, 1.0, 1.0)
LACQUER = ca.hex_rgb("#E9B32F")
CEDAR = ca.hex_rgb("#D9A56F")   # incense cedar, freshly cut
LEAD = ca.hex_rgb("#3A3937")
BRASS = ca.hex_rgb("#C99A3C")
PINK = ca.hex_rgb("#E58F8C")

HEX_R = 2.6          # circumradius of the sharp hex (across corners 5.2)
HEX_A = HEX_R * math.cos(math.pi / 6)   # apothem: across flats 4.5 (~11 mm)
HEX_ROUND = 0.42     # corner fillet radius — "a smooth bevelled hex"
BARREL_X0 = -39.0    # inside the ferrule
STAMP_X = (-33.0, -5.0)
CONE_X0 = 36.0       # where the sharpener's cone meets the corners
TIP_X = 50.4
LEAD_R = 0.78
FERRULE_X = (-45.2, -38.4)
ERASER_X0 = -50.4


def hex_section(sub_flat=4, sub_arc=3):
    """The bevelled hex as (theta, radius, kind) samples, counter-clockwise
    from the corner at 0 deg; corners at 0, 60 … 300 deg, so the flat centred
    on 270 deg lies on the desk and the one on 90 deg faces up. kind: 'arc'
    or ('flat', k, s) — flat k (centred on 30 + 60k deg), s in [0, 1] across."""
    pts = []
    cd = (HEX_A - HEX_ROUND) / math.cos(math.pi / 6)   # fillet centre distance
    for k in range(6):
        phi = math.radians(60 * k)
        cx, cy = cd * math.cos(phi), cd * math.sin(phi)
        for j in range(sub_arc + 1):
            psi = phi + math.radians(-30 + 60 * j / sub_arc)
            x, y = cx + HEX_ROUND * math.cos(psi), cy + HEX_ROUND * math.sin(psi)
            pts.append((math.atan2(y, x) % (2 * math.pi), math.hypot(x, y), "arc"))
        # the flat to the next corner: interior samples only (the arc ends
        # are its endpoints)
        psi = phi + math.radians(30)
        a = (cx + HEX_ROUND * math.cos(psi), cy + HEX_ROUND * math.sin(psi))
        phi2 = math.radians(60 * (k + 1))
        cx2, cy2 = cd * math.cos(phi2), cd * math.sin(phi2)
        psi2 = phi2 - math.radians(30)
        b = (cx2 + HEX_ROUND * math.cos(psi2), cy2 + HEX_ROUND * math.sin(psi2))
        for j in range(1, sub_flat):
            s = j / sub_flat
            x, y = a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s
            pts.append((math.atan2(y, x) % (2 * math.pi), math.hypot(x, y), ("flat", k, s)))
    return pts


GLYPHS = {
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "I": ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
    "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    " ": ["00000"] * 7,
}


def stamp_text(img, region, text, x0_frac, h_frac, w_per_h, ink):
    """Blit a 5x7 bitmap string into an atlas region (fractions of the region,
    rows top-down), anti-aliased by 4x supersampling."""
    S = img.shape[0]
    u0, v0, u1, v1 = (int(round(c * S)) for c in region)
    rw, rh = u1 - u0, v1 - v0
    gh = h_frac * rh            # glyph height px
    gw = gh * w_per_h           # glyph width px (5 columns)
    gap = gw * 0.35
    top = v0 + (rh - gh) / 2
    x = u0 + x0_frac * rw
    ss = 4
    for ch in text:
        rows = GLYPHS[ch]
        assert x + gw < u1, f"stamp overruns its region at {ch!r}"
        ys, xs = np.mgrid[int(top):int(top + gh) + 1, int(x):int(x + gw) + 1]
        cov = np.zeros(ys.shape)
        for oy in range(ss):
            for ox in range(ss):
                py = (ys + (oy + 0.5) / ss - top) / gh * 7
                px = (xs + (ox + 0.5) / ss - x) / gw * 5
                inside = (py >= 0) & (py < 7) & (px >= 0) & (px < 5)
                r = np.clip(py.astype(int), 0, 6)
                c = np.clip(px.astype(int), 0, 4)
                on = np.array([[rows[rr][cc] == "1" for rr, cc in zip(rrow, crow)] for rrow, crow in zip(r, c)])
                cov += inside & on
        cov /= ss * ss
        sl = img[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        sl[:] = sl * (1 - cov[..., None]) + np.asarray(ink) * cov[..., None]
        x += gw + gap


def pencil_texture():
    rng = np.random.default_rng(20261021)
    S = PEN_TEX
    img = np.ones((S, S, 3))
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float64)

    def box(region):
        u0, v0, u1, v1 = (int(round(c * S)) for c in region)
        return slice(v0, v1), slice(u0, u1)

    # lacquer: a near-white multiplier with faint lengthwise drag lines (the
    # dipped paint) — u runs along the barrel
    for region in (LACQ_UV, STAMP_UV):
        sy, sx = box(region)
        h = sy.stop - sy.start
        streak = rng.normal(0, 1, h)
        streak = np.convolve(streak, np.ones(3) / 3, mode="same")
        img[sy, sx] = np.clip(0.97 + 0.018 * streak[:, None] + rng.normal(0, 0.006, (h, sx.stop - sx.start)), 0.9, 1.0)[..., None]
    # the stamp: black foil on the top flat — reads as a pencil maker's mark
    # (16 glyphs at 0.42 x 0.36: 26 px a glyph, the run ends at u ~0.88)
    stamp_text(img, STAMP_UV, "MAPLESPIRE  HB-2", 0.06, 0.42, 0.36, (0.08, 0.07, 0.06))
    # cedar: lengthwise grain along the cone's generators (v), growth lines
    # wandering slowly across u, darker latewood, a little figure
    sy, sx = box(WOOD_UV)
    gx, gy = xx[sy, sx], yy[sy, sx]
    grain = np.zeros(gx.shape)
    for _ in range(34):
        cx = rng.uniform(sx.start, sx.stop)
        amp = rng.uniform(1.0, 4.0)
        f = rng.uniform(0.01, 0.04)
        ph = rng.uniform(0, 2 * math.pi)
        w = rng.uniform(0.9, 2.6)
        d = np.abs(gx - (cx + amp * np.sin(gy * f + ph)))
        grain += np.clip(1 - d / w, 0, 1) * rng.uniform(0.3, 0.7)
    img[sy, sx] = np.clip(1.0 - 0.3 * grain + rng.normal(0, 0.025, gx.shape), 0.55, 1.0)[..., None]
    # brass: brushed — streaks run ROUND the ferrule (along u), plus a few
    # bright and dark rows for the crimps' sheen
    sy, sx = box(FERRULE_UV)
    h = sy.stop - sy.start
    brushed = np.convolve(rng.normal(0, 1, h), np.ones(2) / 2, mode="same")
    img[sy, sx] = np.clip(0.93 + 0.05 * brushed[:, None] + rng.normal(0, 0.012, (h, sx.stop - sx.start)), 0.75, 1.0)[..., None]
    # eraser: soft rubber speckle
    sy, sx = box(ERASER_UV)
    img[sy, sx] = np.clip(0.96 + rng.normal(0, 0.03, (sy.stop - sy.start, sx.stop - sx.start)), 0.8, 1.0)[..., None]
    # graphite: fine sparkle
    sy, sx = box(GRAPHITE_UV)
    img[sy, sx] = np.clip(0.95 + rng.normal(0, 0.08, (sy.stop - sy.start, sx.stop - sx.start)), 0.7, 1.15)[..., None]
    return np.clip(img, 0, 1)


def build_pencil():
    ca.reset_scene()
    m = Mesh()
    sec = hex_section()
    n = len(sec)

    def at(x, theta, r):
        return (x, r * math.cos(theta), r * math.sin(theta))

    # top-light ramp baked into COLOR_0: the pencil always lies on its bottom
    # flat (the placement only yaws it), so "up" is fixed in the asset
    def lit(rgb, theta, k=0.16):
        return np.clip(rgb * (1 - k + k * (0.5 + 0.5 * math.sin(theta))), 0, 1)

    # ── the barrel: x0 → stamp start → stamp end → the scalloped boundary ring
    slope = HEX_R / (TIP_X - CONE_X0)     # the cone: r(x) = slope * (TIP_X - x)
    xb = [TIP_X - r / slope for _t, r, _k in sec]  # where each sample leaves the paint
    rings_x = [BARREL_X0, STAMP_X[0], STAMP_X[1]]
    rows = [[m.v(at(x, t, r)) for t, r, _k in sec] for x in rings_x]
    rows.append([m.v(at(xb[j], sec[j][0], sec[j][1])) for j in range(n)])
    xs = rings_x + [None]
    for i in range(3):
        for j in range(n):
            j2 = (j + 1) % n
            quad = (rows[i][j], rows[i][j2], rows[i + 1][j2], rows[i + 1][j])
            # the stamped run: the TOP flat (centred on 90 deg) between the
            # stamp rings — its own UV island at 17 texels per unit
            top_flat = i == 1 and all(60 <= math.degrees(sec[jj][0]) <= 120 for jj in (j, j2))
            if top_flat:
                def suv(jj, ii):
                    th = sec[jj][0]
                    t = (math.degrees(th) - 60) / 60   # 60 deg (+Y side) is the glyph top
                    return region_uv(STAMP_UV, (rings_x[ii] - STAMP_X[0]) / (STAMP_X[1] - STAMP_X[0]), 0.04 + 0.92 * t)
                uvs = [suv(j, i), suv(j2, i), suv(j2, i + 1), suv(j, i + 1)]
            else:
                def luv(jj, ii, jn):
                    x = xs[ii] if xs[ii] is not None else xb[jj]
                    return region_uv(LACQ_UV, 0.02 + 0.96 * (x - BARREL_X0) / (TIP_X - BARREL_X0), 0.04 + 0.92 * jn / n)
                uvs = [luv(j, i, j), luv(j2, i, j + 1), luv(j2, i + 1, j + 1), luv(j, i + 1, j)]
            m.face(quad, uvs, [lit(LACQUER, sec[jj][0]) for jj in (j, j2, j2, j)])

    # ── the cone: boundary ring → the lead ring → the point (straight
    # generators of the cone, so every face lies on it exactly)
    lead_x = TIP_X - LEAD_R / slope
    lead_ring = [m.v(at(lead_x, t, LEAD_R)) for t, _r, _k in sec]
    tip_x = TIP_X - 0.12 / slope
    tip_ring = [m.v(at(tip_x, t, 0.12)) for t, _r, _k in sec]
    tip = m.v((TIP_X - 0.05, 0.0, 0.0))

    def wuv(j, x):
        return region_uv(WOOD_UV, 0.03 + 0.94 * j / n, 0.03 + 0.94 * (x - CONE_X0 + 2.5) / (TIP_X - CONE_X0 + 2.5))

    def guv(j, x):
        return region_uv(GRAPHITE_UV, 0.05 + 0.9 * j / n, 0.05 + 0.9 * (x - lead_x) / (TIP_X - lead_x))

    for j in range(n):
        j2 = (j + 1) % n
        ju = j + 1
        m.face((rows[3][j], rows[3][j2], lead_ring[j2], lead_ring[j]),
               [wuv(j, xb[j]), wuv(ju, xb[j2]), wuv(ju, lead_x), wuv(j, lead_x)],
               [lit(CEDAR, sec[jj][0], 0.12) for jj in (j, j2, j2, j)])
        m.face((lead_ring[j], lead_ring[j2], tip_ring[j2], tip_ring[j]),
               [guv(j, lead_x), guv(ju, lead_x), guv(ju, tip_x), guv(j, tip_x)], LEAD)
        m.face((tip_ring[j], tip_ring[j2], tip), [guv(j, tip_x), guv(ju, tip_x), guv(j + 0.5, TIP_X)], LEAD)

    # ── ferrule + eraser: lathes about the X axis (18 round: 20 put the
    # pencil at 1 602 triangles, over the desk props' 1 500 cap)
    SEG = 18

    def lathe_x(profile, region, rgb_of, v_range=(0.04, 0.96), cap_end=None):
        """profile: [(x, r)]; rgb_of(i, theta) per ring. cap_end: x of an
        axis point closing the LAST ring (a fan), or None."""
        rings = [[m.v(at(x, 2 * math.pi * k / SEG + math.pi / SEG, r)) for k in range(SEG)] for x, r in profile]
        L = len(profile) - 1

        def uv(i, k):
            return region_uv(region, 0.03 + 0.94 * k / SEG, v_range[0] + (v_range[1] - v_range[0]) * i / max(L, 1))

        for i in range(L):
            for k in range(SEG):
                k2 = (k + 1) % SEG
                th, th2 = 2 * math.pi * k / SEG + math.pi / SEG, 2 * math.pi * k2 / SEG + math.pi / SEG
                m.face((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]),
                       [uv(i, k), uv(i, k + 1), uv(i + 1, k + 1), uv(i + 1, k)],
                       [rgb_of(i, th), rgb_of(i, th2), rgb_of(i + 1, th2), rgb_of(i + 1, th)])
        if cap_end is not None:
            c = m.v((cap_end, 0.0, 0.0))
            for k in range(SEG):
                k2 = (k + 1) % SEG
                th, th2 = 2 * math.pi * k / SEG + math.pi / SEG, 2 * math.pi * k2 / SEG + math.pi / SEG
                m.face((rings[L][k], rings[L][k2], c), [uv(L, k), uv(L, k + 1), uv(L, k + 0.5)],
                       [rgb_of(L, th), rgb_of(L, th2), rgb_of(L, th)])

    # the ferrule: a rolled lip at each end, two bands of three crimps, a
    # plain band between them; RF clears the bevelled hex (max radius 2.55)
    RF = 2.66
    fx0, fx1 = FERRULE_X
    prof = [(fx1, 2.2), (fx1, RF + 0.02), (fx1 - 0.35, RF + 0.1), (fx1 - 0.7, RF)]
    groove_tone = []
    x = fx1 - 0.7
    for band in range(2):
        for _g in range(3):
            prof += [(x - 0.25, RF - 0.17), (x - 0.5, RF)]
            x -= 0.55
        if band == 0:
            prof += [(x - 1.6, RF)]
            x -= 1.6
    prof += [(fx0 + 0.6, RF), (fx0 + 0.3, RF + 0.1), (fx0, RF + 0.02), (fx0, 2.2)]
    for i, (_x, r) in enumerate(prof):
        groove_tone.append(0.72 if r < RF - 0.1 else (1.08 if r > RF + 0.05 else 1.0))

    def ferrule_rgb(i, th):
        # a polished cylinder mirrors its surroundings in bands along its
        # length: a hot streak on top, the dark desk reflected low on the
        # flanks, a bright rim of bounce light underneath. The pencil always
        # lies on its bottom flat, so "top" is fixed in the asset. (A smooth
        # top-light ramp read as tan plastic — tp2-cntower/pencil-ferrule.png,
        # first run.)
        s = math.sin(th)
        streak = math.exp(-((s - 0.97) / 0.06) ** 2)
        band = 0.55 + 0.55 * smoothstep(-0.1, 0.85, s) - 0.25 * math.exp(-((s - 0.35) / 0.18) ** 2)
        rgb = BRASS * groove_tone[i] * band + np.array([1.0, 0.95, 0.8]) * 0.45 * streak
        return np.clip(rgb, 0, 1)

    lathe_x(prof, FERRULE_UV, ferrule_rgb)
    # the eraser: into the ferrule, then a worn, rounded end
    ER = 2.42
    e_prof = [(fx0 + 0.6, ER - 0.3), (fx0 + 0.2, ER), (ERASER_X0 + 1.4, ER), (ERASER_X0 + 0.7, ER - 0.18),
              (ERASER_X0 + 0.28, ER - 0.6), (ERASER_X0 + 0.06, ER - 1.2), (ERASER_X0, 0.9)]

    def eraser_rgb(i, th):
        return np.clip(PINK * (0.9 + 0.12 * math.sin(th)), 0, 1)

    lathe_x(e_prof, ERASER_UV, eraser_rgb, cap_end=ERASER_X0 - 0.02)

    obj = m.finish("desk-pencil")
    # 50: the fillet steps 20 deg and the cone meets the flats at ~10, all
    # smooth; the crimps' and lips' 60-90 deg turns stay crisp
    ca.shade_smooth(obj, 50)
    da.recentre(obj)
    finish_material(obj, "desk-pencil", pencil_texture(), roughness=0.42)
    da.report(obj, "pencil")
    return obj


# ── the cable coil ──────────────────────────────────────────────────────────

COIL_TEX = 256
BRAID_UV = (0.0, 0.0, 1.0, 0.5)    # full width: u repeats along the cable
PLUG_UV = (0.02, 0.55, 0.48, 0.98)
STRAP_UV = (0.52, 0.55, 0.98, 0.98)
CABLE = ca.hex_rgb("#E7DFCF")
PLUG_BODY = ca.hex_rgb("#33343A")
PRONG = ca.hex_rgb("#D3B262")
STRAP = ca.hex_rgb("#B3282D")
CABLE_R = 1.15
COIL_R = 14.6
BRAID_P = 1.5        # braid repeat along the cable (units)
SIDES = 6


def coil_texture():
    rng = np.random.default_rng(20261022)
    S = COIL_TEX
    img = np.ones((S, S, 3))
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float64)
    # braid: two families of diagonal strands crossing (a herringbone weave),
    # u along the cable (one repeat across the full width), v around it
    y0, y1 = 0, S // 2
    u = xx[y0:y1] / S
    v = (yy[y0:y1] - y0) / (y1 - y0)
    a = np.abs(((u * 4 + v * 2) % 1.0) - 0.5) * 2
    b = np.abs(((u * 4 - v * 2) % 1.0) - 0.5) * 2
    over = ((np.floor(u * 8) + np.floor(v * 4)) % 2) == 0
    strand = np.where(over, a, b)
    # 0.88-1.0: at 0.8-1.0 the weave read as a corrugated hose
    # (tp2-cntower/coil-plug.png, first run)
    img[y0:y1] = np.clip(0.88 + 0.12 * strand + rng.normal(0, 0.02, u.shape), 0.7, 1.0)[..., None]
    # the plug: moulded plastic with a faint texture
    x0, ya, x1, yb = (int(c * S) for c in PLUG_UV)
    img[ya:yb, x0:x1] = np.clip(0.95 + rng.normal(0, 0.02, (yb - ya, x1 - x0)), 0.85, 1.0)[..., None]
    # the strap: hook-and-loop fuzz
    x0, ya, x1, yb = (int(c * S) for c in STRAP_UV)
    img[ya:yb, x0:x1] = np.clip(0.88 + rng.normal(0, 0.07, (yb - ya, x1 - x0)), 0.65, 1.0)[..., None]
    return np.clip(img, 0, 1)


def coil_path():
    """The wound cable's centreline, inner end first: four turns, each in its
    own slot of a 2 x 2 bundle — inner lower, inner upper, outer upper, outer
    lower — with a quarter-turn crossover into the next slot, which is always
    still empty (no turn passes through another); then the tail leaves the
    outer LOWER turn at desk level and runs out to the plug."""
    pts = []
    dz_up = 2 * CABLE_R * 0.95
    dr_io = CABLE_R * 1.02
    slots = [(-dr_io, 0.0), (-dr_io, dz_up), (dr_io, dz_up), (dr_io, 0.0)]
    # 25 a turn (14.4 deg): 22 showed polygon corners on the outer turn in
    # the close-up; the whole prop stays under the desk props' 1 500 cap
    per_turn = 25
    turns = len(slots)
    for i in range(turns * per_turn + 1):
        t = i / per_turn                 # turns elapsed
        k = min(int(t), turns - 1)
        f = t - k
        dr, dz = slots[k]
        if k + 1 < turns and f > 0.75:   # the crossover into the next slot
            s = smoothstep(0.75, 1.0, f)
            dr = dr + (slots[k + 1][0] - dr) * s
            dz = dz + (slots[k + 1][1] - dz) * s
        ang = 2 * math.pi * t + 0.35
        # hand-wound: a little out of round — the SAME wobble for every turn,
        # so neighbouring slots stay a cable apart
        r = COIL_R + dr + 0.45 * math.sin(2 * ang + 0.7) + 0.25 * math.sin(3 * ang + 1.3)
        pts.append(Vector((r * math.cos(ang), 0.94 * r * math.sin(ang), CABLE_R + dz)))
    # the tail: tangent off the last point, then peeling outward across the
    # desk (the plug ends up beyond the coil's +X+Y side)
    end = pts[-1]
    d = (pts[-1] - pts[-2]).normalized()
    p0 = end
    p1 = end + d * 6.0
    p2 = Vector((COIL_R + 9.5, 17.0, CABLE_R))
    p3 = Vector((COIL_R + 10.5, 22.5, CABLE_R))
    for i in range(1, 10):
        s = i / 9
        q = (1 - s) ** 3 * p0 + 3 * (1 - s) ** 2 * s * p1 + 3 * (1 - s) * s ** 2 * p2 + s ** 3 * p3
        pts.append(q)
    return pts


def build_coil():
    ca.reset_scene()
    m = Mesh()
    pts = coil_path()
    # parallel-transport frames along the path
    tangents = []
    for i in range(len(pts)):
        a = pts[max(i - 1, 0)]
        b = pts[min(i + 1, len(pts) - 1)]
        tangents.append((b - a).normalized())
    nrm = tangents[0].cross(Vector((0, 0, 1))).normalized()
    frames = []
    for i, t in enumerate(tangents):
        if i > 0:
            nrm = (nrm - t * nrm.dot(t)).normalized()
        frames.append((nrm.copy(), t.cross(nrm).normalized()))
    s_acc = [0.0]
    for i in range(1, len(pts)):
        s_acc.append(s_acc[-1] + (pts[i] - pts[i - 1]).length)
    rings = []
    for p, (n1, n2) in zip(pts, frames):
        rings.append([m.v(p + (n1 * math.cos(2 * math.pi * k / SIDES) + n2 * math.sin(2 * math.pi * k / SIDES)) * CABLE_R)
                      for k in range(SIDES)])

    def buv(i, k):
        # u repeats (the image's sampler wraps) — the braid pitch is constant
        u0, v0, u1, v1 = BRAID_UV
        return (s_acc[i] / BRAID_P, 1 - (v0 + 0.04 + (v1 - v0 - 0.08) * k / SIDES))

    def shade(p):
        # the bundle's lower inner turns sit in each other's shadow
        return np.clip(CABLE * (0.82 + 0.18 * min(1.0, (p.z - CABLE_R * 0.5) / (2.5 * CABLE_R))), 0, 1)

    for i in range(len(pts) - 1):
        for k in range(SIDES):
            k2 = (k + 1) % SIDES
            m.face((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]),
                   [buv(i, k), buv(i, k + 1), buv(i + 1, k + 1), buv(i + 1, k)],
                   [shade(pts[i]), shade(pts[i]), shade(pts[i + 1]), shade(pts[i + 1])])
    # the inner end: capped where it hides in the bundle
    c0 = m.v(pts[0])
    for k in range(SIDES):
        m.face((rings[0][(k + 1) % SIDES], rings[0][k], c0), [buv(0, k + 1), buv(0, k), buv(0, k + 0.5)], CABLE * 0.8)

    # ── the plug at the tail: strain relief → body → two flat prongs
    end = pts[-1]
    d = (pts[-1] - pts[-2]).normalized()
    d.z = 0
    d.normalize()
    side = Vector((-d.y, d.x, 0.0))
    up = Vector((0, 0, 1))

    def pv(a, b, c):
        return end + d * a + side * b + up * c

    def puv(s, t):
        return region_uv(PLUG_UV, s, t)

    def block(a0, a1, hw0, hw1, hh0, hh1, zc0, zc1, rgb, region=PLUG_UV):
        """A tapered box along d: (a, half-width, half-height, centre z) at
        each end; bottom face skipped when it lies on the desk."""
        vs = [[pv(a, sx * hw, zc + sz * hh) for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
              for a, hw, hh, zc in ((a0, hw0, hh0, zc0), (a1, hw1, hh1, zc1))]
        vv = [[m.v(p) for p in ring] for ring in vs]
        for k in range(4):
            k2 = (k + 1) % 4
            m.face((vv[0][k], vv[0][k2], vv[1][k2], vv[1][k]),
                   [region_uv(region, 0.1 + 0.2 * k, 0.1), region_uv(region, 0.3 + 0.2 * k, 0.1),
                    region_uv(region, 0.3 + 0.2 * k, 0.9), region_uv(region, 0.1 + 0.2 * k, 0.9)], rgb)
        m.face(list(reversed(vv[0])), [region_uv(region, s, t) for s, t in ((0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9))], rgb)
        m.face(vv[1], [region_uv(region, s, t) for s, t in ((0.1, 0.1), (0.9, 0.1), (0.9, 0.9), (0.1, 0.9))], rgb)

    # strain relief: a taper from the cable to the body, in three ribs
    for j, (a0, a1, r0, r1) in enumerate(((0.0, 1.0, 1.2, 1.35), (1.0, 2.0, 1.35, 1.55), (2.0, 3.0, 1.55, 1.75))):
        block(a0, a1, r0, r1, r0, r1, CABLE_R + 0.05 * j, CABLE_R + 0.1 + 0.05 * j, PLUG_BODY * (0.92 + 0.06 * j))
    # the body: a moulded block a little wider than tall, bevelled front
    bh = 1.75
    block(3.0, 3.5, 2.4, 2.8, 1.5, bh, bh, bh, PLUG_BODY)
    block(3.5, 8.6, 2.8, 2.8, bh, bh, bh, bh, PLUG_BODY)
    block(8.6, 9.2, 2.8, 2.45, bh, 1.45, bh, bh, PLUG_BODY * 0.9)
    # the prongs: two flat brass blades, 1.25 apart (NEMA 1-15)
    for sgn in (-1, 1):
        a0, a1, hw, hh = 9.2, 13.4, 0.13, 0.62
        vs = [[m.v(pv(a, sgn * 1.25 + sx * hw, bh + sz * hh)) for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))] for a in (a0, a1)]
        for k in range(4):
            k2 = (k + 1) % 4
            m.face((vs[0][k], vs[0][k2], vs[1][k2], vs[1][k]),
                   [puv(0.1, 0.1), puv(0.2, 0.1), puv(0.2, 0.2), puv(0.1, 0.2)], PRONG * (1.0 if k in (1, 3) else 0.85))
        m.face(vs[1], [puv(0.1, 0.1), puv(0.2, 0.1), puv(0.2, 0.2), puv(0.1, 0.2)], PRONG)

    # ── the tie: a red hook-and-loop strap round the bundle at one bearing
    bearing = math.radians(205)
    cdir = Vector((math.cos(bearing), 0.94 * math.sin(bearing), 0.0))
    tang = Vector((-cdir.y, cdir.x, 0.0)).normalized()
    # the bundle's cross-section: 2 x 2 cables, radial half-extent 2.3,
    # vertical 2.2 about its centre; the strap clears it by ~0.4
    centre = cdir * COIL_R + Vector((0, 0, CABLE_R + CABLE_R * 0.95))
    ra, rb = 2 * CABLE_R + 0.75, 2 * CABLE_R * 0.95 + 0.45      # radial / vertical half-axes
    w, t = 1.6, 0.35
    N = 10
    loops = []
    for i in range(N):
        a = 2 * math.pi * i / N
        nrm2 = (cdir.normalized() * (math.cos(a) / ra) + up * (math.sin(a) / rb)).normalized()
        base = centre + cdir.normalized() * (ra * math.cos(a)) + up * (rb * math.sin(a))
        base.z = max(base.z, 0.18)
        loops.append([m.v(base + tang * sw + nrm2 * st) for sw, st in ((-w / 2, 0), (w / 2, 0), (w / 2, t), (-w / 2, t))])
    for i in range(N):
        i2 = (i + 1) % N
        for k in range(4):
            k2 = (k + 1) % 4
            m.face((loops[i][k], loops[i][k2], loops[i2][k2], loops[i2][k]),
                   [region_uv(STRAP_UV, 0.05 + 0.9 * i / N, 0.1 + 0.2 * k), region_uv(STRAP_UV, 0.05 + 0.9 * i / N, 0.3 + 0.2 * k),
                    region_uv(STRAP_UV, 0.05 + 0.9 * (i + 1) / N, 0.3 + 0.2 * k), region_uv(STRAP_UV, 0.05 + 0.9 * (i + 1) / N, 0.1 + 0.2 * k)],
                   STRAP)
    obj = m.finish("desk-cable-coil")
    # 65: a 6-sided cable turns 60 deg between faces and must read round;
    # the plug's and the prongs' 90 deg edges stay crisp
    ca.shade_smooth(obj, 65)
    da.recentre(obj)
    finish_material(obj, "desk-cable-coil", coil_texture(), roughness=0.62)
    da.report(obj, "cable coil")
    return obj


# ── the CN Tower ────────────────────────────────────────────────────────────
# Proportions from the real tower (553 m): main pod ~0.60-0.65 H, SkyPod
# ~0.80 H, the antenna the top ~0.18 H; widths ~1.35x the real ratios, the
# way a souvenir model is cast (a true-ratio needle reads as a pin at the
# 100-px fit framing).

TOWER_TEX = 512
CONCRETE_UV = (0.0, 0.0, 1.0, 0.56)
GLASS_UV = (0.0, 0.6, 1.0, 0.76)
WHITE_UV = (0.0, 0.8, 0.48, 0.98)
GRANITE_UV = (0.52, 0.8, 1.0, 0.98)
CONCRETE = ca.hex_rgb("#D3CCBF")   # a step under the pod's white cladding
POD_WHITE = ca.hex_rgb("#EEECE6")
GLASS = ca.hex_rgb("#C9D6E2")
MAST = ca.hex_rgb("#C9C6BF")
GRANITE = ca.hex_rgb("#2E2D30")
PLINTH_R, PLINTH_H = 13.6, 3.4
TOWER_H = 120.0       # above the plinth


def tower_texture():
    rng = np.random.default_rng(20261023)
    S = TOWER_TEX
    img = np.ones((S, S, 3))
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float64)

    def box(region):
        u0, v0, u1, v1 = (int(round(c * S)) for c in region)
        return slice(v0, v1), slice(u0, u1)

    # slip-formed concrete: a faint horizontal lift line every ~1.6 units of
    # height, tone drifting lift to lift, and soft vertical weathering streaks
    sy, sx = box(CONCRETE_UV)
    h, w = sy.stop - sy.start, sx.stop - sx.start
    lift_px = h / (0.62 * TOWER_H) * 1.6
    rows = np.arange(h)
    lift = np.floor(rows / lift_px)
    tone = 1.0 + 0.035 * np.sin(lift * 2.39 + 0.7) + 0.02 * rng.normal(0, 1, int(lift.max()) + 1)[lift.astype(int)]
    line = np.clip(1 - np.abs((rows % lift_px) - 0.5) / 0.9, 0, 1)
    streak = np.convolve(rng.normal(0, 1, w), np.ones(9) / 9, mode="same")
    # (0.09 deep lift lines read as wood growth rings in the first close-up)
    img[sy, sx] = np.clip((tone - 0.045 * line)[:, None] - 0.025 * streak[None, :] + rng.normal(0, 0.012, (h, w)), 0.7, 1.05)[..., None]
    # glass: dark panes, light mullions — 48 round the pod; one transom
    sy, sx = box(GLASS_UV)
    gu = (xx[sy, sx] - sx.start) / (sx.stop - sx.start)
    gv = (yy[sy, sx] - sy.start) / (sy.stop - sy.start)
    mull = np.abs(((gu * 48) % 1.0) - 0.5) > 0.42
    transom = np.abs(gv - 0.5) < 0.05
    pane = 0.2 + 0.1 * gv + rng.normal(0, 0.01, gu.shape)    # sky reflection darkening down
    img[sy, sx] = np.where(mull | transom, 0.86, pane)[..., None]
    # white pod cladding: plain with faint panel joints
    sy, sx = box(WHITE_UV)
    pu = (xx[sy, sx] - sx.start) / (sx.stop - sx.start)
    joint = np.abs(((pu * 32) % 1.0) - 0.5) > 0.47
    img[sy, sx] = np.where(joint, 0.9, 0.98)[..., None]
    # granite: salt-and-pepper speckle
    sy, sx = box(GRANITE_UV)
    sp = rng.random((sy.stop - sy.start, sx.stop - sx.start))
    img[sy, sx] = np.where(sp > 0.93, 2.2, np.where(sp < 0.2, 0.7, 1.0))[..., None] * 0.45
    return np.clip(img, 0, 1)


def build_tower():
    ca.reset_scene()
    m = Mesh()
    H = TOWER_H
    z0 = PLINTH_H

    # ── the plinth: a stepped granite drum (souvenir base)
    SEGP = 24

    def lathe_z(profile, region, rgb_of, seg, phase=0.0, v_of=None, cap_top=None):
        """profile [(r, z)] bottom→top; u round, v along the profile (or
        v_of(i)); cap_top: z of an axis point closing the last ring."""
        rings = [[m.v((r * math.cos(phase + 2 * math.pi * k / seg), r * math.sin(phase + 2 * math.pi * k / seg), z))
                  for k in range(seg)] for r, z in profile]
        L = len(profile) - 1
        vf = v_of or (lambda i: 0.05 + 0.9 * i / max(L, 1))
        for i in range(L):
            for k in range(seg):
                k2 = (k + 1) % seg
                m.face((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]),
                       [region_uv(region, k / seg, vf(i)), region_uv(region, (k + 1) / seg, vf(i)),
                        region_uv(region, (k + 1) / seg, vf(i + 1)), region_uv(region, k / seg, vf(i + 1))],
                       [rgb_of(i), rgb_of(i), rgb_of(i + 1), rgb_of(i + 1)])
        if cap_top is not None:
            c = m.v((0.0, 0.0, cap_top))
            R = max(profile[L][0], 1e-6)

            def puv(vert):
                # planar on the cap: a fan at (k / seg, v) smeared the
                # granite into radial streaks (tower-base.png, first run)
                return region_uv(region, 0.5 + 0.45 * vert.co.x / R, 0.5 + 0.45 * vert.co.y / R)

            for k in range(seg):
                k2 = (k + 1) % seg
                m.face((rings[L][k], rings[L][k2], c), [puv(rings[L][k]), puv(rings[L][k2]), puv(c)], rgb_of(L))
        return rings

    plinth = [(PLINTH_R - 0.4, 0.0), (PLINTH_R, 0.4), (PLINTH_R, 1.7), (PLINTH_R - 0.5, 2.0), (PLINTH_R - 2.4, 2.2),
              (PLINTH_R - 2.4, PLINTH_H - 0.3), (PLINTH_R - 2.7, PLINTH_H)]
    lathe_z(plinth, GRANITE_UV, lambda i: GRANITE, SEGP, cap_top=PLINTH_H)

    # ── the Y-shaped base: three legs round a hexagonal core, tapering from a
    # wide flare at the foot until they merge into the core under the pod
    MERGE = 0.585 * H
    # a slim core and long, narrow legs flaring at the foot (power 1.5): the
    # first cut's stubby legs on a fat core read as one tapered wedge
    # (tp2-cntower/tower-iso.png, first run)
    core_r = lambda h: 2.05 - 0.4 * (h / MERGE)             # noqa: E731
    leg_len = lambda h: core_r(h) + 8.6 * (1 - h / MERGE) ** 1.5 + 0.45  # noqa: E731
    leg_hw = lambda h: 0.8 - 0.3 * (h / MERGE)               # noqa: E731
    legs = [math.radians(90 + 120 * i) for i in range(3)]
    # baked occlusion per section point: the notches between the legs sit in
    # the legs' shadow, the tips catch the light — the Y reads in any light
    Y_AO = [0.6, 0.76, 0.92, 1.0, 1.0, 1.0, 1.0, 0.92, 0.76]

    def y_section(h):
        """(x, y) loop, counter-clockwise: for each leg, the core notch
        before it, the leg's left root, the flank's mid, the tip's rounded
        corners, the right flank mid and root."""
        rc, L, hw = core_r(h), leg_len(h), leg_hw(h)
        pts = []
        for a in legs:
            n_ = Vector((math.cos(a), math.sin(a)))
            t_ = Vector((-math.sin(a), math.cos(a)))
            pre = a - math.radians(60)
            pts.append(Vector((rc * math.cos(pre), rc * math.sin(pre))))   # the notch
            root = rc * 0.98
            mid = rc + (L - rc) * 0.5
            for p in (n_ * root - t_ * (hw * 1.9), n_ * mid - t_ * (hw * 1.15), n_ * L - t_ * hw,
                      n_ * (L + 0.3) - t_ * hw * 0.45, n_ * (L + 0.3) + t_ * hw * 0.45, n_ * L + t_ * hw,
                      n_ * mid + t_ * (hw * 1.15), n_ * root + t_ * (hw * 1.9)):
                pts.append(p)
        return pts

    heights = [0.0, 0.06, 0.15, 0.27, 0.41, 0.56, 0.72, 0.88, 1.0]
    sections = [(MERGE * f, y_section(MERGE * f)) for f in heights]
    npts = len(sections[0][1])
    vrange = CONCRETE_UV

    def cuv(j, h):
        # u: round the section; v: height over the lower 0.62 H
        return region_uv(vrange, j / npts, 1 - 0.02 - 0.96 * h / (0.62 * H))

    def yao(j, i):
        # the occlusion fades as the legs merge into the core
        f = heights[i]
        return np.clip(CONCRETE * (1 - (1 - Y_AO[j % 9]) * (1 - f) ** 0.7), 0, 1)

    srows = [[m.v((p.x, p.y, z0 + h)) for p in pts] for h, pts in sections]
    for i in range(len(sections) - 1):
        for j in range(npts):
            j2 = (j + 1) % npts
            m.face((srows[i][j], srows[i][j2], srows[i + 1][j2], srows[i + 1][j]),
                   [cuv(j, sections[i][0]), cuv(j + 1, sections[i][0]), cuv(j + 1, sections[i + 1][0]), cuv(j, sections[i + 1][0])],
                   [yao(j, i), yao(j2, i), yao(j2, i + 1), yao(j, i + 1)])
    # cap the merged top (inside the pod's skirt — never seen, keeps it closed)
    top = m.v((0.0, 0.0, z0 + MERGE))
    for j in range(npts):
        j2 = (j + 1) % npts
        m.face((srows[-1][j], srows[-1][j2], top), [cuv(j, MERGE), cuv(j + 1, MERGE), cuv(j + 0.5, MERGE)], CONCRETE)

    # ── the main pod (32 round): skirt flare, the white bulge, two glass
    # bands (the lower leaning out, the upper in) with a white deck between,
    # the roof up to the shaft. (r, z, part)
    SEG = 24
    zp = z0 + 0.585 * H
    pod = [(core_r(MERGE) - 0.15, zp - 0.4, "w"), (3.6, zp + 0.8, "w"), (6.0, zp + 2.0, "w"),
           (7.3, zp + 3.2, "w"), (7.2, zp + 4.1, "w"),
           (7.0, zp + 4.15, "g"), (7.55, zp + 5.9, "g"),
           (7.8, zp + 6.0, "w"), (7.8, zp + 6.6, "w"),
           (7.5, zp + 6.65, "g"), (7.05, zp + 8.0, "g"),
           (7.0, zp + 8.05, "w"), (5.2, zp + 8.9, "w"), (1.75, zp + 9.5, "w")]

    # each band gets its own region and v range; a ring shared by two bands
    # is duplicated (the parts meet at a crease, so their UVs need not agree)
    def band(rows_, region, rgb, seg=SEG):
        prof = [(r, z) for r, z, _p in rows_]
        zs = [z for _r, z in prof]
        return lathe_z(prof, region, lambda i: rgb, seg, phase=math.pi / seg,
                       v_of=lambda i: 0.06 + 0.88 * (zs[i] - zs[0]) / max(zs[-1] - zs[0], 1e-6))

    parts, cur = [], [pod[0]]
    for row in pod[1:]:
        if row[2] != cur[-1][2]:
            parts.append(cur)
            cur = [row]
        else:
            cur.append(row)
    parts.append(cur)
    # stitch: each band starts at the previous band's last row (a crease)
    prev_last = None
    for p in parts:
        rows_ = ([prev_last] if prev_last else []) + p
        kind = p[0][2]
        if kind == "g":
            band(rows_, GLASS_UV, GLASS)
        else:
            band(rows_, WHITE_UV, POD_WHITE)
        prev_last = p[-1]

    # ── the upper shaft to the SkyPod (concrete, 16 round), the SkyPod, the
    # mast with two collars and a slim tip
    zs0 = zp + 9.4
    zsky = z0 + 0.80 * H
    shaft = [(1.75, zs0), (1.62, zs0 + (zsky - zs0) * 0.5), (1.5, zsky)]
    lathe_z(shaft, CONCRETE_UV, lambda i: CONCRETE, 16, phase=math.pi / 16,
            v_of=lambda i: 1 - 0.02 - 0.96 * min(1.0, (shaft[i][1] - z0) / (0.62 * H)) * 0.999)
    sky = [(1.5, zsky - 0.1, "w"), (2.4, zsky + 0.7, "w"), (2.75, zsky + 1.3, "w"),
           (2.7, zsky + 1.35, "g"), (2.85, zsky + 2.6, "g"),
           (2.7, zsky + 2.65, "w"), (2.0, zsky + 3.2, "w"), (1.1, zsky + 3.6, "w")]
    band(sky[:3], WHITE_UV, POD_WHITE, seg=16)
    band(sky[2:5], GLASS_UV, GLASS, seg=16)
    band(sky[4:], WHITE_UV, POD_WHITE, seg=16)
    zm = zsky + 3.55
    mast = [(1.05, zm), (0.95, zm + 5.0), (1.25, zm + 5.2), (1.25, zm + 5.9), (0.82, zm + 6.1), (0.7, zm + 11.5),
            (0.95, zm + 11.7), (0.95, zm + 12.2), (0.55, zm + 12.4), (0.3, z0 + H - 0.8), (0.12, z0 + H)]
    zm0, zm1 = mast[0][1], mast[-1][1]
    lathe_z(mast, WHITE_UV, lambda i: MAST * (0.92 if 2 <= i <= 3 or 6 <= i <= 7 else 1.0), 8, phase=math.pi / 8,
            v_of=lambda i: 0.06 + 0.88 * (mast[i][1] - zm0) / (zm1 - zm0), cap_top=z0 + H + 0.05)

    # every part is authored outward (profiles bottom → top, sections
    # counter-clockwise); recalc on these open, stitched shells flipped the
    # pod's lower bulge and glass band inward (first run: see-through)
    obj = m.finish("cn-tower", recalc=False)
    # 45: the pod's profile is smooth inside each band; the bands' creases,
    # the leg tips and the plinth steps stay crisp
    ca.shade_smooth(obj, 45)
    da.recentre(obj)
    finish_material(obj, "cn-tower", tower_texture(), roughness=0.6)
    da.report(obj, "cn tower")
    return obj


if __name__ == "__main__":
    only = ca.arg("only")
    if only in (None, "pencil"):
        pencil = build_pencil()
        ca.export(pencil, "desk-pencil.glb")
        da.desk_ground()
        da.preview(pencil, "pencil-iso.png", (70, 60, 55), (0, 0, 2))
        da.preview(pencil, "pencil-tip.png", (58, -16, 12), (43, 0, 2))
        da.preview(pencil, "pencil-ferrule.png", (-36, -16, 12), (-44, 0, 2))
        da.preview(pencil, "pencil-stamp.png", (-18, -6, 24), (-18, 0, 2))
        da.preview(pencil, "pencil-far.png", (230, 190, 210), (0, 0, 2), size=(500, 400))
    if only in (None, "coil"):
        coil = build_coil()
        ca.export(coil, "desk-cable-coil.glb")
        da.desk_ground()
        da.preview(coil, "coil-iso.png", (70, 58, 62), (0, 0, 2))
        da.preview(coil, "coil-top.png", (0, 0.1, 110), (0, 0, 0))
        da.preview(coil, "coil-plug.png", (30, -45, 18), (12, -12, 2))
        da.preview(coil, "coil-far.png", (240, 200, 220), (0, 0, 2), size=(500, 400))
    if only in (None, "tower"):
        tower = build_tower()
        ca.export(tower, "cn-tower.glb")
        da.desk_ground()
        da.preview(tower, "tower-side.png", (0, -230, 70), (0, 0, 62))
        da.preview(tower, "tower-iso.png", (150, -150, 160), (0, 0, 55))
        da.preview(tower, "tower-pod.png", (24, -36, 86), (0, 0, 79))
        da.preview(tower, "tower-base.png", (30, -38, 22), (0, 0, 10))
        da.preview(tower, "tower-far.png", (420, -380, 400), (0, 0, 55), size=(500, 400))
