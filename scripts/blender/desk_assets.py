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

"""Workbench desk props, authored in Blender and exported as glTF binaries.

    blender --background --factory-startup --python scripts/blender/desk_assets.py -- \
        --out src/canvas3d/decor/assets [--preview reports/view3d-quality/blender/<run>]

  desk-mug.glb    a white enamel camp mug with a rolled navy rim, a D handle
                  swept on a spline and flared into the wall, coffee with a
                  meniscus inside, and the OFFICIAL Flag of Canada leaf
                  printed on both sides from ONE shared print island at 15
                  texels per unit — the same traced construction path
                  canadiana_assets.py prints on the flag, never redrawn.
  desk-note.glb   two index cards, the top one with a curled corner, blue
                  ruling, a red margin line, handwriting-like scribble lines
                  and a little hand-drawn box-and-arrow sketch (it is an
                  architect's desk). Replaces the procedural note whose three
                  grey bars read as "!!!" at the fit framing (loop 4).
  desk-notebooks.glb  two pocket notebooks stacked askew (forest green and
                  oxblood cloth, cream page block, a black elastic, the
                  OFFICIAL leaf blind-debossed on the top cover) with a navy
                  pen across them — a near-field anchor (loop 4 r2: "the desk
                  around the board is mostly empty").
  desk-plant.glb  a snake plant in a terracotta pot: banded dark-green blades
                  with yellow margins — the tall near-field anchor.
  desk-pencil-cup.glb  a turned walnut pencil cup holding five pencils (three
                  sharpened tip-up, two eraser-up) and a steel 15 cm ruler —
                  a tall far-band anchor (loop 4 r3: "the whole far desk band
                  is bare streaked wood").
  desk-books.glb  three small cloth hardbacks stacked askew (forest, oxblood,
                  navy), gilt spine bands, a gilt title block on the top
                  cover and a red ribbon marker — the broad far-band anchor.
  desk-sketchbook.glb  an A6 spiral sketchbook lying open: graphite notes
                  and a cube on the left page, a sketch of a board (cards, a
                  datastore drum, arrows) and the OFFICIAL leaf in red pencil
                  on the right, a pencil across it — a mid-size anchor (loop
                  4 r4: "the scattered small objects read as debris").
  desk-blueprint.glb  a small blueprint half unrolled from its roll: a
                  Prussian-blue floor plan with door swings, dimension lines
                  and a title block, the free end curling, a rubber band
                  round the roll — the other mid-size anchor.

    --only mug|note|notebooks|plant|cup|books|sketchbook|blueprint   rebuild one prop

Real desk scale: the desk pencil is 78 units ~ 19 cm, i.e. ~4.1 units/cm. The
mug is a generous 11 cm camp mug; the cards are 12 x 7.8 cm index cards.

Deterministic: a fixed-seed RNG for the scribbles, no wall clock. Origins on
the desk at the centre of the plan-view box (the footprint is a rotation-safe
radius about it). Shares canadiana_assets.py's helpers, imported as a module.
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

ENAMEL = ca.hex_rgb("#F2EFE7")
NAVY = ca.hex_rgb("#1E2D4C")
COFFEE = ca.hex_rgb("#2B170C")
CREMA = ca.hex_rgb("#7A4D2B")

# ── the mug ─────────────────────────────────────────────────────────────────

MUG_R = 19.0        # outer wall radius at the top
MUG_H = 44.0        # base to lip
SEG = 36            # around the body; vertex k sits at (k + 0.5) * 10 deg, so
#                     the handle (+X, 0 deg) is mid-face and each print patch
#                     (45-135 and 225-315 deg) starts and ends on a vertex
# Quality pass "mug" (blind critic, workbench-desk-mug.png: "the maple decal
# is blurry/low-res"): the old print wrapped the WHOLE wall onto a 512 x 256
# map — 4.3 texels per world unit, while the harness close-up frames the mug
# at ~18 px per unit, a 4x magnification. Both leaves are the same leaf, so
# both printed patches now map onto ONE island of a 512 x 512 map at 15.3
# texels per unit (glbAssets.test.ts measures it); the rest of the mug, all
# plain enamel, shares a white strip under the island.
MUG_TEX = 512
PATCH_K = (4, 22)               # first vertex of each print patch
PATCH_N = 9                     # faces per patch: 90 deg of wall
PATCH_Z0, PATCH_Z1 = 8.0, 36.0  # the printed band (profile rings 3 and 4)
MUG_ISLAND = (0.0, 0.0, 0.875, None)   # u0, v0, u1, v1 (v down); v1 keeps texels square
MUG_STRIP = (0.02, 0.885, 0.98, 0.99)  # plain white: rims, inside, coffee, handle, base
MUG_ROUGHNESS = 0.2             # glazed enamel AND the coffee's wet surface


def mug_profile():
    """(r, z, colour) base -> wall -> rolled rim bead -> inner lip, in the
    order the lathe walks it (the material on the walk's left). A ring's
    colour is the band ABOVE it in walk order."""
    R = MUG_R
    prof = [(R - 2.2, 0.0, NAVY), (R - 1.05, 0.45, NAVY), (R - 0.62, 2.4, ENAMEL),
            (R - 0.5, PATCH_Z0, ENAMEL), (R - 0.2, PATCH_Z1, ENAMEL), (R + 0.12, 42.3, NAVY)]
    # the rolled rim: a 0.82 bead, navy enamel on the steel edge — a hair
    # proud of the wall (the old rim was a flat navy band 2 units deep)
    cx, cz, rb = R - 0.42, 43.2, 0.82
    for a in (20, 75, 130, 185):
        prof.append((cx + rb * math.cos(math.radians(a)), cz + rb * math.sin(math.radians(a)), NAVY))
    prof += [(R - 1.32, 41.2, ENAMEL), (R - 1.45, 37.0, ENAMEL)]
    return prof


def mug_island():
    """The leaf island's v1 so its texels are square on the wall: the patch
    spans 90 deg at the band's mean radius x the band's height."""
    w = (MUG_R - 0.35) * math.pi / 2
    h = PATCH_Z1 - PATCH_Z0
    u0, v0, u1, _ = MUG_ISLAND
    return (u0, v0, u1, v0 + (u1 - u0) * h / w), (u1 - u0) * MUG_TEX / w


def mug_texture():
    """White enamel (it multiplies COLOR_0) with the OFFICIAL leaf, flag red,
    once, on the shared island — row 0 = the top of the printed band."""
    S = MUG_TEX
    img = np.ones((S, S, 3))
    red = ca.hex_rgb(ca.FLAG_RED)
    (u0, v0, u1, v1), px_per_unit = mug_island()
    leaf_h = 0.46 * MUG_H                     # about half the wall tall, as before
    s = leaf_h * px_per_unit / 4030.0         # the path is 4030 units apex to stem foot
    cx = (u0 + u1) / 2 * S
    cy = v0 * S + (PATCH_Z1 - 23.3) * px_per_unit   # the leaf's centre at z 23.3, as before
    poly = [(cx + x * s, cy + y * s) for x, y in ca.official_leaf_polygon()]
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    bx0, by0 = int(min(xs)) - 2, int(min(ys)) - 2
    bx1, by1 = int(max(xs)) + 3, int(max(ys)) + 3
    # coverage only over the leaf's box (a whole-map 4x supersample is 4 M
    # samples per polygon edge)
    cov = ca.polygon_coverage([(x - bx0, y - by0) for x, y in poly], bx1 - bx0, by1 - by0, ss=4)[..., None]
    img[by0:by1, bx0:bx1] = img[by0:by1, bx0:bx1] * (1 - cov) + red * cov
    return np.clip(img, 0, 1)


def catmull_rom(pts, per=40):
    """A dense uniform Catmull-Rom polyline through 2D points (ends extrapolated)."""
    P = [np.asarray(p, float) for p in pts]
    P = [2 * P[0] - P[1]] + P + [2 * P[-1] - P[-2]]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(per):
            t = k / per
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(P[-2])
    return np.array(out)


# The handle's centre line (radial x, z): it leaves the wall nearly level just
# under the rim, sweeps out round a full D and tucks back in low — both roots
# sunk into the body. The old path was cos(a)^0.85: its slope is infinite at
# both roots, so the 8-sided tube kinked into a pinched hook at the lower curl
# ("visibly faceted at the lower curl, the handle joint is soft"). The upper
# root stays at z 34: from 35.2 its flared section reached r 16.7 at z 37.9,
# above the coffee there (37.6), and showed as a white chip in the coffee in
# tp-mug/workbench-desk-mug.png; now its highest interior point is z 36.6.
HANDLE_PTS = [(MUG_R - 0.9, 34.0), (MUG_R + 1.8, 35.5), (MUG_R + 6.2, 35.6), (MUG_R + 9.6, 33.0),
              (MUG_R + 11.3, 28.0), (MUG_R + 11.0, 22.2), (MUG_R + 9.0, 17.2), (MUG_R + 5.4, 14.0),
              (MUG_R + 1.6, 13.0), (MUG_R - 1.2, 12.9)]
HANDLE_SEGS = 23      # adaptive: spent where the line turns or the root flares
#                       (20 still kinked the outer silhouette of the lower curl
#                       in tp-mug/mug-handle.png; the coffee's second meniscus
#                       ring paid for the extra 3 x 24 triangles)
HANDLE_SIDES = 12
HANDLE_A, HANDLE_B = 2.7, 1.85   # the oval section: across (y) x in-plane depth
HANDLE_FLARE, HANDLE_FLARE_LEN = 0.6, 3.0   # the fillet: +60 % at the wall, ~3 units long


def handle_path():
    """(points (n, 2), flare per point): HANDLE_SEGS + 1 samples placed at
    equal steps of a cost that adds arc length, turning and flare change, so
    the bends and the fillets get the segments a uniform sweep wastes on the
    straight run."""
    d = catmull_rom(HANDLE_PTS)
    seg = np.linalg.norm(np.diff(d, axis=0), axis=1)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    # where the centre line crosses the wall (radius ~R - 0.3 on the band)
    out_wall = d[:, 0] > MUG_R - 0.3
    s_in, s_out = s[np.argmax(out_wall)], s[len(out_wall) - 1 - np.argmax(out_wall[::-1])]
    g = np.maximum(np.exp(-(np.maximum(0, s - s_in) / HANDLE_FLARE_LEN) ** 2),
                   np.exp(-(np.maximum(0, s_out - s) / HANDLE_FLARE_LEN) ** 2))
    flare = 1 + HANDLE_FLARE * g
    tang = np.diff(d, axis=0)
    ang = np.arctan2(tang[:, 1], tang[:, 0])
    dturn = np.abs(np.angle(np.exp(1j * np.diff(ang))))
    cost = seg[1:] / 3.2 + dturn / math.radians(13) + np.abs(np.diff(flare))[1:] / 0.12
    c = np.concatenate([[0.0, 0.0], np.cumsum(cost)])
    want = np.linspace(0, c[-1], HANDLE_SEGS + 1)
    idx = np.searchsorted(c, want).clip(0, len(d) - 1)
    idx[0], idx[-1] = 0, len(d) - 1
    idx = np.unique(idx)
    return d[idx], flare[idx], s[idx] / s[-1]


def build_mug():
    ca.reset_scene()
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    col_layer = bm.loops.layers.float_color.new("Color")
    island, _px = mug_island()

    def put(f, uvs, rgb, want):
        """Corner UVs + one colour; the face is flipped if its normal does not
        face `want` (authored winding, no recalc: the coffee is a lone disc
        and the handle an open tube, which recalc has no inside to orient by)."""
        c = ca.srgb_to_linear(rgb)
        for loop, uv in zip(f.loops, uvs):
            loop[uv_layer].uv = uv
            loop[col_layer] = (c[0], c[1], c[2], 1.0)
        f.normal_update()
        if f.normal.dot(want) < 0:
            f.normal_flip()

    ang = lambda k: 2 * math.pi * (k + 0.5) / SEG  # noqa: E731
    prof = mug_profile()
    rings = [[bm.verts.new((r * math.cos(ang(k)), r * math.sin(ang(k)), z)) for k in range(SEG)] for r, z, _c in prof]
    # the strip's v follows the profile's ARC LENGTH, not z: the bead's top
    # band climbs 0.16 in z over 0.76 of surface, which a z-mapped v squeezed
    # under glbAssets.test.ts's 5e-6 UV / surface floor (measured 4.2e-6)
    arc = [0.0]
    for (ra, za, _a), (rb, zb, _b) in zip(prof, prof[1:]):
        arc.append(arc[-1] + math.hypot(rb - ra, zb - za))
    vt = [a / arc[-1] for a in arc]
    for i in range(len(prof) - 1):
        # each band wears its LOWER ring's colour (walk order): navy foot,
        # white wall, navy bead and inner lip, white inside
        (ra, za, rgb), (rb, zb, _cb) = prof[i], prof[i + 1]
        tr, tz = rb - ra, zb - za
        printed = abs(za - PATCH_Z0) < 1e-6 and abs(zb - PATCH_Z1) < 1e-6
        for k in range(SEG):
            k2 = (k + 1) % SEG
            f = bm.faces.new((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]))
            patch = next((p for p in PATCH_K if printed and p <= k < p + PATCH_N), None)
            if patch is not None:
                uvs = [region_uv(island, (kk - patch) / PATCH_N, (PATCH_Z1 - z) / (PATCH_Z1 - PATCH_Z0))
                       for kk, z in ((k, za), (k + 1, za), (k + 1, zb), (k, zb))]
            else:
                uvs = [region_uv(MUG_STRIP, kk / SEG, t) for kk, t in ((k, vt[i]), (k + 1, vt[i]), (k + 1, vt[i + 1]), (k, vt[i + 1]))]
            th = ang(k + 0.5)
            put(f, uvs, rgb, Vector((tz * math.cos(th), tz * math.sin(th), -tr)))
    # the base: a navy disc under the foot
    bottom = bm.verts.new((0, 0, 0))
    disc = lambda co, rad: region_uv(MUG_STRIP, 0.5 + 0.5 * co.x / rad, 0.5 - 0.5 * co.y / rad)  # noqa: E731
    for k in range(SEG):
        f = bm.faces.new((rings[0][(k + 1) % SEG], rings[0][k], bottom))
        put(f, [disc(v.co, MUG_R) for v in f.verts], NAVY, Vector((0, 0, -1)))
    # the COFFEE — its own vertices (never smoothed into the wall), a thin
    # MENISCUS climbing 0.6 up the wall, the paler thin film at the wall, the
    # dark body. Quality pass "mug": "the coffee has no specular" — the flat
    # disc sat 7.5 under the rim at roughness 0.32; the meniscus's tilted ring
    # now catches the key light and the sky for most view directions.
    cof = [(MUG_R - 1.36, 38.15, CREMA * 0.6 + COFFEE * 0.4), (MUG_R - 2.3, 37.64, CREMA * 0.2 + COFFEE * 0.8)]
    crings = [[bm.verts.new((r * math.cos(ang(k)), r * math.sin(ang(k)), z)) for k in range(SEG)] for r, z, _c in cof]
    for i in range(len(cof) - 1):
        for k in range(SEG):
            k2 = (k + 1) % SEG
            f = bm.faces.new((crings[i][k], crings[i][k2], crings[i + 1][k2], crings[i + 1][k]))
            put(f, [disc(v.co, MUG_R) for v in f.verts], cof[i + 1][2], Vector((0, 0, 1)))
            # the corners on the outer ring wear the outer tone
            for loop in f.loops:
                if loop.vert in crings[i]:
                    c = ca.srgb_to_linear(cof[i][2])
                    loop[col_layer] = (c[0], c[1], c[2], 1.0)
    centre = bm.verts.new((0, 0, 37.55))
    for k in range(SEG):
        f = bm.faces.new((crings[-1][k], crings[-1][(k + 1) % SEG], centre))
        put(f, [disc(v.co, MUG_R) for v in f.verts], COFFEE, Vector((0, 0, 1)))

    # the HANDLE: an oval tube swept along handle_path(), flared into the wall
    # at both roots (the fillet), parallel-transported (a planar path: the
    # side axis is +Y throughout)
    pts, flare, sfrac = handle_path()
    side = Vector((0, 1, 0))
    loops = []
    for i, (p, fl) in enumerate(zip(pts, flare)):
        a = pts[max(0, i - 1)]
        b = pts[min(len(pts) - 1, i + 1)]
        tan = Vector((b[0] - a[0], 0.0, b[1] - a[1])).normalized()
        nrm = tan.cross(side).normalized()
        c = Vector((p[0], 0.0, p[1]))
        loops.append([(c, bm.verts.new(c + side * (HANDLE_A * fl * math.cos(2 * math.pi * j / HANDLE_SIDES))
                                         + nrm * (HANDLE_B * fl * math.sin(2 * math.pi * j / HANDLE_SIDES))))
                      for j in range(HANDLE_SIDES)])
    for i in range(len(loops) - 1):
        for j in range(HANDLE_SIDES):
            j2 = (j + 1) % HANDLE_SIDES
            f = bm.faces.new((loops[i][j][1], loops[i + 1][j][1], loops[i + 1][j2][1], loops[i][j2][1]))
            uvs = [region_uv(MUG_STRIP, 0.03 + 0.94 * sfrac[ii], 0.05 + 0.9 * jj / HANDLE_SIDES)
                   for ii, jj in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))]
            mid = (loops[i][j][0] + loops[i + 1][j][0]) / 2
            put(f, uvs, ENAMEL, f.calc_center_median() - mid)
    me = bpy.data.meshes.new("desk-mug")
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new("desk-mug", me)
    bpy.context.collection.objects.link(obj)
    me.color_attributes.active_color = me.color_attributes["Color"]
    # 80: the rolled bead turns ~55 deg per ring and must shade round; the
    # coffee is its own island, so nothing smooths across the liquid line
    ca.shade_smooth(obj, 80)
    recentre(obj)
    img = ca.image_from_array("desk-mug-print", mug_texture())
    me.materials.append(ca.make_material("desk-mug", img, roughness=MUG_ROUGHNESS, vertex_color=True))
    report(obj, "mug")
    return obj


# ── the note ────────────────────────────────────────────────────────────────

CARD_W, CARD_H = 50.0, 32.0
NOTE_TEX = 512
INK = ca.hex_rgb("#22356E")
RULE = ca.hex_rgb("#9DB7D6")
MARGIN = ca.hex_rgb("#D2574C")
PAPER = ca.hex_rgb("#F6F0E2")


def note_texture():
    """Top half = the written card, bottom half = the blank card under it.
    Card u across its width, v down its height; row 0 = top of the image."""
    rng = np.random.default_rng(20261009)
    S = NOTE_TEX
    img = np.ones((S, S, 3)) * PAPER
    half = S // 2
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float64)

    def ink(mask, colour, a=1.0):
        nonlocal img
        m = np.clip(mask, 0, 1)[..., None] * a
        img = img * (1 - m) + colour * m

    for top in (0, half):
        # blue ruling + the red margin
        rows = np.arange(top + 46, top + half - 10, 26)
        for ry in rows:
            ink(np.clip(1 - np.abs(yy - ry) / 1.1, 0, 1) * ((yy > top) & (yy < top + half)), RULE, 0.8)
        ink(np.clip(1 - np.abs(yy - (top + 24)) / 1.4, 0, 1), MARGIN, 0.7)
        ink(np.clip(1 - np.abs(xx - 60) / 1.2, 0, 1) * ((yy > top + 6) & (yy < top + half - 6)), MARGIN, 0.6)

    def stroke(points, width=1.6):
        pts = np.asarray(points)
        m = np.zeros((S, S))
        x0, y0 = pts.min(axis=0) - 4
        x1, y1 = pts.max(axis=0) + 4
        sl = (slice(max(0, int(y0)), min(S, int(y1))), slice(max(0, int(x0)), min(S, int(x1))))
        sx, sy = xx[sl], yy[sl]
        best = np.full(sx.shape, 1e9)
        for a, b in zip(pts[:-1], pts[1:]):
            d, _ = ca.segment_distance(sx, sy, a[0], a[1], b[0], b[1])
            best = np.minimum(best, d)
        m[sl] = np.clip(1 - (best - width * 0.5) / 0.9, 0, 1)
        return m

    # handwriting: cursive-like loops along each ruled line, words separated
    # by gaps, the last line short — reads as writing, never as glyphs
    rows = np.arange(46, half - 10, 26)
    for li, ry in enumerate(rows[:5]):
        x = 72.0
        end = S - 40 - (180 if li == 4 else rng.uniform(0, 70))
        while x < end:
            wl = rng.uniform(34, 90)
            pts = []
            t = 0.0
            while t < wl:
                amp = 7.5 if rng.uniform() < 0.18 else 4.2
                pts.append((x + t + 2.2 * math.sin(t * 0.9), ry - 4 - amp * (0.5 + 0.5 * math.sin(t * 0.75 + li))))
                t += 1.4
            img_m = stroke(pts, 1.5)
            ink(img_m, INK, 0.92)
            x += wl + rng.uniform(10, 18)
    # the sketch: two boxes and an arrow in the card's lower right
    def box(x0, y0, x1, y1):
        j = lambda: rng.uniform(-1.2, 1.2)  # noqa: E731
        return [(x0 + j(), y0 + j()), (x1 + j(), y0 + j()), (x1 + j(), y1 + j()), (x0 + j(), y1 + j()), (x0 + j(), y0 + j())]
    by = half - 74
    ink(stroke(box(300, by, 360, by + 40), 1.8), INK, 0.95)
    ink(stroke(box(410, by + 4, 470, by + 44), 1.8), INK, 0.95)
    ink(stroke([(361, by + 22), (408, by + 24)], 1.8), INK, 0.95)
    ink(stroke([(398, by + 17), (409, by + 24), (398, by + 31)], 1.8), INK, 0.95)
    return np.clip(img, 0, 1)


def card(name, w, h, v0, v1, curl=0.0, nx=14, ny=9):
    """A subdivided sheet in the XY plane; `curl` lifts the +X/+Y corner."""
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    col_layer = bm.loops.layers.float_color.new("Color")
    grid = []
    for j in range(ny + 1):
        row = []
        for i in range(nx + 1):
            u, v = i / nx, j / ny
            x, y = (u - 0.5) * w, (0.5 - v) * h
            # corner curl: distance past a diagonal line near the corner
            d = max(0.0, (u + (1 - v)) - 1.55) / 0.45
            z = curl * d * d
            row.append(bm.verts.new((x, y, z)))
        grid.append(row)
    for j in range(ny):
        for i in range(nx):
            f = bm.faces.new((grid[j + 1][i], grid[j + 1][i + 1], grid[j][i + 1], grid[j][i]))
            for loop, (ii, jj) in zip(f.loops, ((i, j + 1), (i + 1, j + 1), (i + 1, j), (i, j))):
                loop[uv_layer].uv = (0.02 + 0.96 * ii / nx, 1 - (v0 + (v1 - v0) * jj / ny))
                c = ca.srgb_to_linear((1.0, 1.0, 1.0))
                loop[col_layer] = (c[0], c[1], c[2], 1.0)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    me.color_attributes.active_color = me.color_attributes["Color"]
    return obj


def build_note():
    ca.reset_scene()
    under = card("card-under", CARD_W, CARD_H, 0.51, 0.99, nx=6, ny=4)
    under.data.transform(Matrix.Rotation(math.radians(-9), 4, "Z"))
    under.data.transform(Matrix.Translation((-2.5, -2.0, 0.0)))
    top = card("card-top", CARD_W, CARD_H, 0.01, 0.49, curl=3.2)
    top.data.transform(Matrix.Rotation(math.radians(4), 4, "Z"))
    top.data.transform(Matrix.Translation((1.5, 1.2, 0.35)))
    bpy.ops.object.select_all(action="DESELECT")
    under.select_set(True)
    top.select_set(True)
    bpy.context.view_layer.objects.active = top
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = "desk-note"
    ca.shade_smooth(obj, 60)
    recentre(obj)
    img = ca.image_from_array("desk-note-print", note_texture())
    obj.data.materials.append(ca.make_material("desk-note", img, roughness=0.78, vertex_color=True, double_sided=True))
    report(obj, "note")
    return obj


# ── the notebooks (loop 4 r2: "the desk around the board is mostly empty") ──
# Two pocket notebooks (13 x 8.3 cm, 1.2 cm thick) stacked askew, cloth
# covers in forest green and oxblood, the cream page block showing between
# the covers, a black elastic band round the top one, the official leaf
# blind-debossed on its cover, and a navy pen lying across. One mesh, one
# 256-px print: cover cloth | page edges | the debossed leaf | plain.

NB_W, NB_D, NB_T = 54.0, 34.0, 5.0
# 512 (was 256, quality pass "mug"): a cover is 0.46 of the map for 54 units —
# 2.2 texels per unit at 256, so the debossed leaf smeared at the close-up's
# ~4-5 px per unit. Pixel-scale patterns below divide by NB_K to keep their
# world-space size.
NB_TEX = 512
NB_K = NB_TEX / 256
NB_CLOTH_UV = (0.02, 0.02, 0.48, 0.48)    # u0, v0, u1, v1 (v down)
NB_LEAF_UV = (0.52, 0.02, 0.98, 0.48)     # the top cover: cloth + debossed leaf
NB_PAGES_UV = (0.02, 0.52, 0.48, 0.98)
NB_PLAIN_UV = (0.52, 0.52, 0.98, 0.98)
GREEN = ca.hex_rgb("#2F5A45")
OXBLOOD = ca.hex_rgb("#7C2A23")
PAGES = ca.hex_rgb("#EADFC4")
BAND = ca.hex_rgb("#1D1917")
PEN = ca.hex_rgb("#1F3766")
STEEL = ca.hex_rgb("#C7C9CC")


def notebook_texture():
    rng = np.random.default_rng(20261011)
    S = NB_TEX
    img = np.ones((S, S, 3))
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float64)

    def px(region):
        u0, v0, u1, v1 = region
        return int(u0 * S), int(v0 * S), int(u1 * S), int(v1 * S)

    # cloth: a fine woven crosshatch + mottling, near-white (it multiplies)
    for region in (NB_CLOTH_UV, NB_LEAF_UV):
        x0, y0, x1, y1 = px(region)
        sx, sy = xx[y0:y1, x0:x1], yy[y0:y1, x0:x1]
        weave = 0.5 + 0.25 * np.sin(sx * 2.1 / NB_K) + 0.25 * np.sin(sy * 2.1 / NB_K)
        mott = rng.normal(0, 0.025, sx.shape)
        img[y0:y1, x0:x1] = np.clip(0.9 + 0.06 * weave + mott, 0.8, 1.0)[..., None]
    # the debossed official leaf, centred on the top cover (a darker press)
    x0, y0, x1, y1 = px(NB_LEAF_UV)
    w, h = x1 - x0, y1 - y0
    s = 0.42 * h / 4030.0
    poly = [(x0 + w / 2 + x * s, y0 + h * 0.5 + y * s) for x, y in ca.official_leaf_polygon()]
    cov = ca.polygon_coverage(poly, S, S, ss=4)
    img = img * (1 - 0.32 * cov[..., None])
    # page edges: fine lines along u (the stacked leaves of paper)
    x0, y0, x1, y1 = px(NB_PAGES_UV)
    sy = yy[y0:y1, x0:x1]
    lines = 0.93 + 0.07 * np.sin(sy * 2.6 / NB_K + rng.uniform(0, 6)) * (0.6 + 0.4 * np.sin(sy * 0.37 / NB_K))
    img[y0:y1, x0:x1] = np.clip(lines, 0.82, 1.0)[..., None]
    return np.clip(img, 0, 1)


def rounded_rect(w, d, r, seg=3):
    """CCW outline of a w x d rectangle with r-rounded corners (centre origin)."""
    pts = []
    for cx, cy, a0 in ((w / 2 - r, d / 2 - r, 0), (-w / 2 + r, d / 2 - r, 90), (-w / 2 + r, -d / 2 + r, 180), (w / 2 - r, -d / 2 + r, 270)):
        for k in range(seg + 1):
            a = math.radians(a0 + 90 * k / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def notebook(name, cover_rgb, top_region, band=False, w=NB_W, d=NB_D, t=NB_T, cv=0.55):
    """One notebook (or a small hardback, desk-books): covers + inset page
    block as stacked rings of a rounded outline, each band coloured and UV'd
    for itself (per-corner colours, so a shared vertex can sit between the
    cover and the pages)."""
    NB_W, NB_D, NB_T = w, d, t  # noqa: N806  (the notebook's names, per call)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    col_layer = bm.loops.layers.float_color.new("Color")
    outline = rounded_rect(NB_W, NB_D, 2.2)
    n = len(outline)
    perim = [0.0]
    for i in range(n):
        a, b = outline[i], outline[(i + 1) % n]
        perim.append(perim[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    L = perim[-1]
    # cv: the cover board thickness
    # (z, inset, band) — the page block is inset 0.8 on every side but the spine (-X)
    rings = [(0.0, 0.0), (cv, 0.0), (cv, 0.8), (NB_T - cv, 0.8), (NB_T - cv, 0.0), (NB_T, 0.0)]
    parts = ["cover", "under", "pages", "under", "cover"]
    vrings = []
    for z, inset in rings:
        ring = []
        for (x, y) in outline:
            # inset toward the centre, except along the spine edge
            k = 1.0 if x > -NB_W / 2 + 2.3 else 0.0
            sx = x - math.copysign(inset * k, x) if abs(x) > 1e-6 else x
            sy = y - math.copysign(inset, y) * (1 if abs(y) > 1e-6 else 0)
            ring.append(bm.verts.new((sx, sy, z)))
        vrings.append(ring)

    def set_corner(loop, rgb, uv):
        c = ca.srgb_to_linear(rgb)
        loop[col_layer] = (c[0], c[1], c[2], 1.0)
        loop[uv_layer].uv = uv

    def region_uv(region, s, t):
        u0, v0, u1, v1 = region
        return (u0 + s * (u1 - u0), 1 - (v0 + t * (v1 - v0)))

    for bi in range(len(rings) - 1):
        part = parts[bi]
        z0, z1 = rings[bi][0], rings[bi + 1][0]
        for i in range(n):
            i2 = (i + 1) % n
            f = bm.faces.new((vrings[bi][i], vrings[bi][i2], vrings[bi + 1][i2], vrings[bi + 1][i]))
            for loop, (pi, ri) in zip(f.loops, ((i, 0), (i + 1, 0), (i + 1, 1), (i, 1))):
                s = perim[pi] / L
                if part == "pages":
                    set_corner(loop, PAGES, region_uv(NB_PAGES_UV, s, 0.1 + 0.8 * ri))
                elif part == "under":
                    set_corner(loop, cover_rgb * 0.8, region_uv(NB_CLOTH_UV, s, 0.9 + 0.08 * ri))
                else:
                    set_corner(loop, cover_rgb, region_uv(NB_CLOTH_UV, s, 0.05 + 0.1 * ri))
            _ = (z0, z1)
    # caps: bottom (cloth) and top (the cover region given)
    for ring, region, flip in ((vrings[0], NB_CLOTH_UV, True), (vrings[-1], top_region, False)):
        f = bm.faces.new(list(reversed(ring)) if flip else ring)
        for loop in f.loops:
            x, y = loop.vert.co.x, loop.vert.co.y
            set_corner(loop, cover_rgb, region_uv(region, x / NB_W + 0.5, 0.5 - y / NB_D))
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    if band:
        # the elastic: a thin loop round the cover, across the short axis
        bx = NB_W / 2 - 9.0
        sect = [(-0.9, -0.3), (0.9, -0.3), (0.9, 0.3), (-0.9, 0.3)]
        path = [(bx, -NB_D / 2 - 0.3, -0.05), (bx, -NB_D / 2 - 0.3, NB_T + 0.3), (bx, NB_D / 2 + 0.3, NB_T + 0.3), (bx, NB_D / 2 + 0.3, -0.05)]
        loops = []
        for p in path:
            loops.append([bm.verts.new((p[0] + sx, p[1] + (sy if abs(p[2]) < 0.1 or p[2] > NB_T else 0), p[2] + (0 if abs(p[2]) < 0.1 or p[2] > NB_T else sy))) for sx, sy in sect])
        for a, b in zip(loops, loops[1:]):
            for k in range(4):
                k2 = (k + 1) % 4
                f = bm.faces.new((a[k], a[k2], b[k2], b[k]))
                for li, loop in enumerate(f.loops):
                    set_corner(loop, BAND, region_uv(NB_PLAIN_UV, 0.1 + 0.2 * (li in (1, 2)), 0.1 + 0.2 * (li in (2, 3)) + 0.2 * k))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    me.color_attributes.active_color = me.color_attributes["Color"]
    return obj


def pen_mesh():
    """A capped ballpoint along +X: navy barrel, steel tip cone, steel clip."""
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    col_layer = bm.loops.layers.float_color.new("Color")
    seg = 14  # was 10: the steel cone and barrel showed flats up close
    # (x, r, colour)
    prof = [(-26.0, 0.0, STEEL), (-26.0, 1.3, STEEL), (-24.6, 1.55, PEN), (14.0, 1.55, PEN), (16.0, 1.45, STEEL),
            (21.0, 1.1, STEEL), (25.5, 0.35, STEEL), (26.0, 0.0, STEEL)]
    rings = []
    for x, r, _c in prof:
        rings.append([bm.verts.new((x, r * math.cos(2 * math.pi * k / seg), r * math.sin(2 * math.pi * k / seg))) for k in range(seg)])
    for i in range(len(prof) - 1):
        for k in range(seg):
            k2 = (k + 1) % seg
            f = bm.faces.new((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]))
            for li, loop in enumerate(f.loops):
                ii = i + (li in (2, 3))
                kk = k + (li in (1, 2))
                c = ca.srgb_to_linear(prof[ii][2] if prof[i][2] is prof[i + 1][2] else prof[i + 1][2])
                loop[col_layer] = (c[0], c[1], c[2], 1.0)
                u0, v0, u1, v1 = NB_PLAIN_UV
                loop[uv_layer].uv = (u0 + (u1 - u0) * (0.05 + 0.9 * ii / (len(prof) - 1)), 1 - (v0 + (v1 - v0) * (0.05 + 0.9 * kk / seg)))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    # the clip: a thin bar along the top of the cap end
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("pen")
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new("pen", me)
    bpy.context.collection.objects.link(obj)
    me.color_attributes.active_color = me.color_attributes["Color"]
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    clip = bpy.context.active_object
    clip.scale = (11.0, 0.7, 0.45)
    clip.location = (-18.5, 0.0, 1.85)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    cme = clip.data
    cme.uv_layers.new(name="UVMap")
    attr = cme.color_attributes.new(name="Color", type="FLOAT_COLOR", domain="CORNER")
    c = ca.srgb_to_linear(STEEL)
    for i in range(len(attr.data)):
        attr.data[i].color = (c[0], c[1], c[2], 1.0)
    cme.color_attributes.active_color = attr
    # per-face UVs into the plain region, never collapsed
    u0, v0, u1, v1 = NB_PLAIN_UV
    for poly in cme.polygons:
        for j, li in enumerate(poly.loop_indices):
            cme.uv_layers[0].data[li].uv = (u0 + (u1 - u0) * (0.1 + 0.3 * (j in (1, 2))), 1 - (v0 + (v1 - v0) * (0.6 + 0.3 * (j in (2, 3)))))
    bpy.ops.object.select_all(action="DESELECT")
    clip.select_set(True)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.join()
    return bpy.context.active_object


def build_notebooks():
    ca.reset_scene()
    lower = notebook("nb-lower", GREEN, NB_CLOTH_UV)
    lower.data.transform(Matrix.Rotation(math.radians(-7), 4, "Z"))
    upper = notebook("nb-upper", OXBLOOD, NB_LEAF_UV, band=True)
    upper.data.transform(Matrix.Rotation(math.radians(9), 4, "Z"))
    upper.data.transform(Matrix.Translation((1.8, 1.4, NB_T + 0.02)))
    pen = pen_mesh()
    pen.data.transform(Matrix.Rotation(math.radians(-24), 4, "Z"))
    pen.data.transform(Matrix.Translation((-1.5, -2.0, 2 * NB_T + 1.6)))
    bpy.ops.object.select_all(action="DESELECT")
    for o in (lower, upper, pen):
        o.select_set(True)
    bpy.context.view_layer.objects.active = upper
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = "desk-notebooks"
    ca.shade_smooth(obj, 35)
    recentre(obj)
    img = ca.image_from_array("desk-notebooks-print", notebook_texture())
    obj.data.materials.append(ca.make_material("desk-notebooks", img, roughness=0.7, vertex_color=True))
    report(obj, "notebooks")
    return obj


# ── the plant ───────────────────────────────────────────────────────────────
# A snake plant in a terracotta pot (pot 9 cm across, blades to ~14 cm): the
# tall banded blades are what reads "plant" from the iso camera at 60-100 px.

POT_TEX = 256
TERRACOTTA = ca.hex_rgb("#B5623A")
TERRA_RIM = ca.hex_rgb("#C9774D")
SOIL = ca.hex_rgb("#45301F")
LEAF_DARK = ca.hex_rgb("#234A2C")
LEAF_BAND = ca.hex_rgb("#5E8452")
LEAF_EDGE = ca.hex_rgb("#C9B65A")
WHITE = np.array([1.0, 1.0, 1.0])
POT_UV = (0.02, 0.02, 0.48, 0.98)
BLADE_UV = (0.52, 0.02, 0.98, 0.98)


def plant_texture():
    rng = np.random.default_rng(20261012)
    S = POT_TEX
    img = np.ones((S, S, 3))
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float64)
    # pot: fired-clay speckle
    x0, y0, x1, y1 = int(POT_UV[0] * S), int(POT_UV[1] * S), int(POT_UV[2] * S), int(POT_UV[3] * S)
    img[y0:y1, x0:x1] = np.clip(0.93 + rng.normal(0, 0.035, (y1 - y0, x1 - x0)), 0.8, 1.0)[..., None]
    # blades: the snake plant's colour lives HERE (the blade COLOR_0 is
    # white): deep green, pale wavy cross-bands, the yellow margins at the
    # region's u edges. (Vertex-coloured margins interpolated across the whole
    # 3-column blade and washed it olive — loop4-r2/d1/plant-iso.png.)
    x0, y0, x1, y1 = int(BLADE_UV[0] * S), int(BLADE_UV[1] * S), int(BLADE_UV[2] * S), int(BLADE_UV[3] * S)
    sx, sy = xx[y0:y1, x0:x1], yy[y0:y1, x0:x1]
    wave = np.sin(sy * 0.55 + 2.2 * np.sin(sx * 0.11))
    band = np.clip((wave - 0.35) / 0.65, 0, 1)[..., None]
    blade = LEAF_DARK * (1 - 0.45 * band) + LEAF_BAND * 0.45 * band
    u = (sx - x0) / (x1 - x0)                         # 0..1 across the region
    s = np.abs((u - 0.1) / 0.8 * 2 - 1)               # 0 midrib .. 1 blade edge
    margin = np.clip((s - 0.8) / 0.08, 0, 1)[..., None]
    img[y0:y1, x0:x1] = blade * (1 - margin) + LEAF_EDGE * margin
    return np.clip(img, 0, 1)


def build_plant():
    ca.reset_scene()
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    col_layer = bm.loops.layers.float_color.new("Color")
    # 36 (was 20): the rim and the flared wall read as a 20-gon up close
    # (quality pass "mug", tp-mug-before/plant-iso.png)
    seg = 36
    # pot profile (r, z, colour), base to rim to soil
    prof = [(0.0, 0.0, TERRACOTTA), (10.2, 0.0, TERRACOTTA), (10.6, 0.8, TERRACOTTA), (12.6, 18.0, TERRACOTTA),
            (12.8, 18.2, TERRA_RIM), (14.4, 18.6, TERRA_RIM), (14.6, 24.0, TERRA_RIM), (13.4, 24.4, TERRA_RIM),
            (12.9, 23.0, SOIL), (0.0, 22.6, SOIL)]
    rings = []
    for r, z, _c in prof:
        rings.append([bm.verts.new((r * math.cos(2 * math.pi * k / seg), r * math.sin(2 * math.pi * k / seg), z)) for k in range(seg)])
    for i in range(len(prof) - 1):
        for k in range(seg):
            k2 = (k + 1) % seg
            quad = (rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k])
            try:
                f = bm.faces.new(quad)
            except ValueError:
                continue
            for li, loop in enumerate(f.loops):
                ii = i + (li in (2, 3))
                kk = k + (li in (1, 2))
                c = ca.srgb_to_linear(prof[i + 1][2] if prof[i + 1][2] is SOIL else prof[i][2])
                loop[col_layer] = (c[0], c[1], c[2], 1.0)
                u0, v0, u1, v1 = POT_UV
                loop[uv_layer].uv = (u0 + (u1 - u0) * kk / seg, 1 - (v0 + (v1 - v0) * (0.02 + 0.96 * ii / (len(prof) - 1))))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    # blades: tapered, gently curved straps rising out of the soil, each a
    # closed sliver (two faces + edges) so no back face is ever missing
    rng = np.random.default_rng(7)
    blades = [(0.0, 0.0, 52, 5.2, 0.05), (2.6, 1.3, 44, 4.6, 0.95), (-2.4, 1.6, 39, 4.4, 2.2), (-1.6, -2.6, 47, 4.8, 3.4),
              (3.0, -2.0, 36, 4.2, 4.6), (-3.6, -0.6, 31, 3.9, 5.5), (0.8, 3.4, 34, 4.0, 1.6)]
    nv = 7
    for bx, by, hgt, wid, yaw in blades:
        lean = 0.2 + 0.14 * rng.uniform()
        twist = rng.uniform(-0.5, 0.5)
        front, back = [], []
        for j in range(nv + 1):
            t = j / nv
            w = wid * (1 - t ** 1.6) * (0.55 + 0.45 * math.sin(min(1.0, t * 3 + 0.35) * math.pi / 2)) + 0.05
            out = lean * hgt * t * t
            ang = yaw + twist * t
            cx = bx + math.cos(yaw) * out
            cy = by + math.sin(yaw) * out
            z = 22.6 + hgt * t
            tx, ty = -math.sin(ang), math.cos(ang)       # across the blade
            nx, ny = math.cos(ang), math.sin(ang)        # blade thickness
            th = 0.45 * (1 - t) + 0.12
            row_f, row_b = [], []
            for s in (-1.0, 0.0, 1.0):
                cup = 0.6 * (1 - abs(s)) * (1 - t)       # a shallow channel down the middle
                px, py = cx + tx * w * s / 2 + nx * cup, cy + ty * w * s / 2 + ny * cup
                row_f.append(bm.verts.new((px + nx * th, py + ny * th, z)))
                row_b.append(bm.verts.new((px - nx * th, py - ny * th, z)))
            front.append(row_f)
            back.append(row_b)
        def bface(vs, uvs, cols):
            f = bm.faces.new(vs)
            for loop, uv, c in zip(f.loops, uvs, cols):
                loop[uv_layer].uv = uv
                lc = ca.srgb_to_linear(c)
                loop[col_layer] = (lc[0], lc[1], lc[2], 1.0)
        u0, v0, u1, v1 = BLADE_UV
        U = lambda s, j: (u0 + (u1 - u0) * (0.1 + 0.4 * (s + 1)), 1 - (v0 + (v1 - v0) * (0.02 + 0.96 * j / nv)))  # noqa: E731
        C = lambda s: WHITE  # noqa: E731  (the print carries the blade colour)
        S3 = (-1.0, 0.0, 1.0)
        for j in range(nv):
            for k in range(2):
                bface((front[j][k], front[j][k + 1], front[j + 1][k + 1], front[j + 1][k]),
                      (U(S3[k], j), U(S3[k + 1], j), U(S3[k + 1], j + 1), U(S3[k], j + 1)),
                      (C(S3[k]), C(S3[k + 1]), C(S3[k + 1]), C(S3[k])))
                bface((back[j][k + 1], back[j][k], back[j + 1][k], back[j + 1][k + 1]),
                      (U(S3[k + 1], j), U(S3[k], j), U(S3[k], j + 1), U(S3[k + 1], j + 1)),
                      (C(S3[k + 1]), C(S3[k]), C(S3[k]), C(S3[k + 1])))
            for k in (0, 2):  # the edges (the yellow margins)
                a, b = (front, back) if k == 0 else (back, front)
                bface((a[j][k], b[j][k], b[j + 1][k], a[j + 1][k]),
                      ((u0 + 0.01, 1 - (v0 + 0.9 * j / nv)), (u0 + 0.03, 1 - (v0 + 0.9 * j / nv)), (u0 + 0.03, 1 - (v0 + 0.9 * (j + 1) / nv)), (u0 + 0.01, 1 - (v0 + 0.9 * (j + 1) / nv))),
                      (WHITE,) * 4)
        # the base sits in the soil (hidden); close the tip
        bface((front[nv][0], front[nv][1], front[nv][2]), (U(-1, nv), U(0, nv - 0.5), U(1, nv)), (WHITE,) * 3)
        bface((back[nv][2], back[nv][1], back[nv][0]), (U(1, nv), U(0, nv - 0.5), U(-1, nv)), (WHITE,) * 3)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("desk-plant")
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new("desk-plant", me)
    bpy.context.collection.objects.link(obj)
    me.color_attributes.active_color = me.color_attributes["Color"]
    ca.shade_smooth(obj, 40)
    recentre(obj)
    img = ca.image_from_array("desk-plant-print", plant_texture())
    # 0.8: at 0.62 the dark soil mirrored the sky and read grey (d1/plant-iso)
    obj.data.materials.append(ca.make_material("desk-plant", img, roughness=0.8, vertex_color=True))
    report(obj, "plant")
    return obj


# ── far-band anchors (loop 4 r3: "the whole far desk band is bare streaked
# wood, apart from a 10 px cable coil and a 10 px compass") ───────────────
# Both share the mug's material contract (print x COLOR_0, single-sided), so
# they link no new shader program, and both stay under the flag's 38-unit
# footprint (the showcase pick, build.test.ts).

class Sheet:
    """A bmesh with the UVMap + Color corner layers every desk prop carries;
    `face` writes one polygon's corners (uv per corner, one sRGB colour)."""

    def __init__(self):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.col = self.bm.loops.layers.float_color.new("Color")

    def face(self, verts, uvs, rgb):
        try:
            f = self.bm.faces.new(verts)
        except ValueError:
            return None
        c = ca.srgb_to_linear(rgb)
        for loop, uv in zip(f.loops, uvs):
            loop[self.uv].uv = uv
            loop[self.col] = (c[0], c[1], c[2], 1.0)
        return f

    def finish(self, name, recalc=True):
        """`recalc=False` for a lone open sheet, whose winding is authored:
        recalc_face_normals has no inside to orient it by."""
        if recalc:
            bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        obj = bpy.data.objects.new(name, me)
        bpy.context.collection.objects.link(obj)
        me.color_attributes.active_color = me.color_attributes["Color"]
        return obj


def region_uv(region, s, t):
    """(s, t) in [0, 1]^2 inside an atlas region given top-down (glTF v down)."""
    u0, v0, u1, v1 = region
    return (u0 + s * (u1 - u0), 1 - (v0 + t * (v1 - v0)))


CUP_TEX = 256
CUP_WOOD_UV = (0.02, 0.02, 0.48, 0.98)
CUP_RULER_UV = (0.52, 0.02, 0.98, 0.30)
CUP_PLAIN_UV = (0.52, 0.36, 0.98, 0.98)
WALNUT = ca.hex_rgb("#6A4329")
WALNUT_IN = ca.hex_rgb("#3A2617")
PENCIL_WOOD = ca.hex_rgb("#E2C08E")
GRAPHITE = ca.hex_rgb("#3B3936")
FERRULE = ca.hex_rgb("#B9B2A6")
ERASER = ca.hex_rgb("#E48C86")
RULER = ca.hex_rgb("#C9CCCF")
CUP_R, CUP_H, CUP_FLOOR = 15.0, 40.0, 6.0


def cup_texture():
    """Walnut grain (vertical, along the turned wall) | the ruler's ticks |
    plain. Near-white multipliers: the tones ride COLOR_0."""
    rng = np.random.default_rng(20261013)
    S = CUP_TEX
    img = np.ones((S, S, 3))
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float64)
    # the grain fills the WHOLE left half, margins included: the lathe's
    # seam column (u = 0.02 / 0.48) filtered in the white margin and drew a
    # pale chevron down the lip (tp-mug/cup-rim.png)
    x0, y0, x1, y1 = 0, 0, S // 2, S
    sx, sy = xx[y0:y1, x0:x1], yy[y0:y1, x0:x1]
    grain = np.zeros(sx.shape)
    for _ in range(26):
        cx = rng.uniform(x0, x1)
        amp = rng.uniform(1.5, 5.0)
        f = rng.uniform(0.015, 0.05)
        ph = rng.uniform(0, 2 * math.pi)
        w = rng.uniform(0.8, 2.2)
        d = np.abs(sx - (cx + amp * np.sin(sy * f + ph)))
        grain += np.clip(1 - d / w, 0, 1) * rng.uniform(0.25, 0.6)
    img[y0:y1, x0:x1] = np.clip(1.0 - 0.22 * grain + rng.normal(0, 0.02, sx.shape), 0.6, 1.0)[..., None]
    # the ruler: mm ticks along u, every 5th longer, every 10th longest
    x0, y0, x1, y1 = (int(c * S) for c in CUP_RULER_UV)
    n = 30  # 5 mm steps: at 256 px, mm ticks were a barcode (cup-iso.png)
    for k in range(n + 1):
        x = x0 + 3 + (x1 - x0 - 6) * k / n
        ln = (y1 - y0) * (0.5 if k % 2 == 0 else 0.28)
        m = (np.abs(xx - x) < 0.45) & (yy >= y0) & (yy < y0 + ln)
        img[m] = 0.18
    return np.clip(img, 0, 1)


def build_cup():
    ca.reset_scene()
    sh = Sheet()
    # 36 (was 24): the lip bead read as a polygon up close (quality pass
    # "mug", tp-mug-before/cup-iso.png) — 15 units of radius at 24 sides is a
    # 0.13-unit sagitta, 2-3 px at the harness close-up
    seg = 36
    # the turned walnut cup: (r, z, colour) base -> foot bead -> wall -> lip bead -> inside -> floor
    # the lip: a turned half-round (radius 1.0, 45 deg a ring) instead of
    # four flats — at 55-62 deg a turn, auto-smooth split them into a
    # faceted, notched ring (tp-mug/cup-rim.png before this change)
    lip = [(14.0 + math.cos(math.radians(a)), 39.0 + math.sin(math.radians(a)), WALNUT) for a in (-30, 15, 60, 105, 150)]
    prof = [(0.0, 0.0, WALNUT), (13.6, 0.0, WALNUT), (14.3, 0.7, WALNUT), (14.8, 2.6, WALNUT), (14.1, 4.2, WALNUT),
            (14.0, 20.0, WALNUT * 0.82), (14.2, 21.0, WALNUT), (14.6, 36.6, WALNUT)] + lip + [
            (14.0 + math.cos(math.radians(195)), 39.0 + math.sin(math.radians(195)), WALNUT_IN),
            (12.6, 36.0, WALNUT_IN), (12.5, CUP_FLOOR + 0.5, WALNUT_IN), (0.0, CUP_FLOOR, WALNUT_IN)]
    rings = [[sh.bm.verts.new((r * math.cos(2 * math.pi * k / seg), r * math.sin(2 * math.pi * k / seg), z)) for k in range(seg)]
             for r, z, _c in prof]
    for i in range(len(prof) - 1):
        for k in range(seg):
            k2 = (k + 1) % seg
            sh.face((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]),
                    [region_uv(CUP_WOOD_UV, (k + dk) / seg, 0.02 + 0.96 * (i + di) / (len(prof) - 1))
                     for dk, di in ((0, 0), (1, 0), (1, 1), (0, 1))], prof[i][2])
    bmesh.ops.remove_doubles(sh.bm, verts=sh.bm.verts, dist=1e-4)

    def prism(axis_o, axis_d, sections, sides=6, twist=0.0):
        """A pencil along axis_d from axis_o: sections = [(t, r, rgb)]; each
        band between sections takes the colour of its lower section."""
        axis_d = Vector(axis_d).normalized()
        q = axis_d.to_track_quat("Z", "Y")
        loops = []
        for t, r, _c in sections:
            c = Vector(axis_o) + axis_d * t
            loops.append([sh.bm.verts.new(c + q @ Vector((max(r, 1e-3) * math.cos(twist + 2 * math.pi * j / sides),
                                                          max(r, 1e-3) * math.sin(twist + 2 * math.pi * j / sides), 0)))
                          for j in range(sides)])
        for i in range(len(sections) - 1):
            for j in range(sides):
                j2 = (j + 1) % sides
                sh.face((loops[i][j], loops[i][j2], loops[i + 1][j2], loops[i + 1][j]),
                        [region_uv(CUP_PLAIN_UV, 0.05 + 0.9 * (j + dj) / sides, 0.05 + 0.9 * (i + di) / len(sections))
                         for dj, di in ((0, 0), (1, 0), (1, 1), (0, 1))], sections[i][2])
        # caps
        for i, flip in ((0, True), (len(sections) - 1, False)):
            ring = loops[i]
            sh.face(list(reversed(ring)) if flip else ring,
                    [region_uv(CUP_PLAIN_UV, 0.5 + 0.4 * math.cos(2 * math.pi * j / sides), 0.5 + 0.4 * math.sin(2 * math.pi * j / sides))
                     for j in range(sides)], sections[i][2])

    # five pencils: (base azimuth, base radius, lean, lean azimuth, length,
    # barrel colour, tip-up?) — splayed outward so they never cross the wall
    pencils = [(0.3, 3.0, 0.20, 0.35, 76.0, ca.hex_rgb("#E8B53A"), True),
               (1.6, 3.4, 0.17, 1.5, 72.0, ca.hex_rgb("#C8402F"), False),
               (2.8, 2.6, 0.21, 2.9, 78.0, ca.hex_rgb("#2F5A9A"), True),
               (4.1, 3.2, 0.15, 4.0, 70.0, ca.hex_rgb("#3F7A4A"), False),
               (5.3, 2.8, 0.19, 5.25, 74.0, ca.hex_rgb("#E8B53A"), True)]
    R = 1.9
    for az, br, lean, laz, L, rgb, tip_up in pencils:
        o = Vector((br * math.cos(az), br * math.sin(az), CUP_FLOOR + 0.2))
        d = Vector((math.sin(lean) * math.cos(laz), math.sin(lean) * math.sin(laz), math.cos(lean)))
        if tip_up:
            secs = [(0.0, R, rgb), (L - 9.0, R, PENCIL_WOOD), (L - 2.4, 0.6, GRAPHITE), (L, 0.05, GRAPHITE)]
        else:
            secs = [(0.0, R, rgb), (L - 7.6, R * 1.04, FERRULE), (L - 4.2, R * 1.04, ERASER), (L - 0.5, R * 0.97, ERASER), (L, R * 0.6, ERASER)]
        prism(o, d, secs, twist=az)
    # the steel ruler, standing in the cup and leaning back against the rim
    rl, rw, rt = 61.0, 6.4, 0.5
    lean, laz = 0.24, 3.55
    d = Vector((math.sin(lean) * math.cos(laz), math.sin(lean) * math.sin(laz), math.cos(lean)))
    side = Vector((-math.sin(laz), math.cos(laz), 0.0))
    nrm = d.cross(side).normalized()
    o = Vector((2.0 * math.cos(laz), 2.0 * math.sin(laz), CUP_FLOOR + 0.2))
    corners = []
    for a in (0.0, rl):
        for b in (-rw / 2, rw / 2):
            for c in (-rt / 2, rt / 2):
                corners.append(sh.bm.verts.new(o + d * a + side * b + nrm * c))
    # index: ((a * 2) + b) * 2 + c
    V = lambda a, b, c: corners[(a * 2 + b) * 2 + c]  # noqa: E731
    # the two printed faces (front + back), then the thin edges
    for c in (0, 1):
        quad = (V(0, 0, c), V(0, 1, c), V(1, 1, c), V(1, 0, c))
        uvs = [region_uv(CUP_RULER_UV, s, t) for s, t in ((0.02, 0.98), (0.02, 0.02), (0.98, 0.02), (0.98, 0.98))]
        sh.face(quad if c == 1 else tuple(reversed(quad)), uvs if c == 1 else list(reversed(uvs)), RULER)
    for quad in ((V(0, 0, 0), V(0, 0, 1), V(1, 0, 1), V(1, 0, 0)), (V(0, 1, 1), V(0, 1, 0), V(1, 1, 0), V(1, 1, 1)),
                 (V(1, 0, 0), V(1, 0, 1), V(1, 1, 1), V(1, 1, 0)), (V(0, 0, 1), V(0, 0, 0), V(0, 1, 0), V(0, 1, 1))):
        sh.face(quad, [region_uv(CUP_PLAIN_UV, s, t) for s, t in ((0.1, 0.1), (0.2, 0.1), (0.2, 0.9), (0.1, 0.9))], RULER * 0.85)
    obj = sh.finish("desk-pencil-cup")
    # 52: the lip turns 45 deg a ring and must shade round; the hex pencils
    # (60 deg) and the ruler's edges stay crisp
    ca.shade_smooth(obj, 52)
    recentre(obj)
    img = ca.image_from_array("desk-pencil-cup-print", cup_texture())
    obj.data.materials.append(ca.make_material("desk-pencil-cup", img, roughness=0.55, vertex_color=True))
    report(obj, "pencil cup")
    return obj


BOOK_TEX = 512   # 256 -> 512 with the notebooks (NB_TEX): the gilt title plate
BK_K = BOOK_TEX / 256
BOOK_NAVY = ca.hex_rgb("#22385E")
BOOK_OCHRE = ca.hex_rgb("#B07C2A")
BOOK_OXBLOOD = ca.hex_rgb("#7A2A26")
GILT = ca.hex_rgb("#D4AF55")
RIBBON = ca.hex_rgb("#B3282D")
# (w, d, t) of the three books, bottom to top — sized so the stack's
# rotation-safe radius stays under the flag's 38 (desk_assets prints it)
BOOKS = [(58.0, 38.0, 8.0), (54.0, 36.0, 7.0), (50.0, 33.0, 6.2)]


def books_texture():
    """The notebooks' atlas layout: cloth | the TOP book's title plate (gilt
    frame + gilt title bars on oxblood cloth) | page edges | plain."""
    rng = np.random.default_rng(20261014)
    S = BOOK_TEX
    img = np.ones((S, S, 3))
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float64)

    def px(region):
        u0, v0, u1, v1 = region
        return int(u0 * S), int(v0 * S), int(u1 * S), int(v1 * S)

    for region in (NB_CLOTH_UV, NB_LEAF_UV):
        x0, y0, x1, y1 = px(region)
        sx, sy = xx[y0:y1, x0:x1], yy[y0:y1, x0:x1]
        weave = 0.5 + 0.25 * np.sin(sx * 2.4 / BK_K) + 0.25 * np.sin(sy * 2.4 / BK_K)
        img[y0:y1, x0:x1] = np.clip(0.9 + 0.06 * weave + rng.normal(0, 0.02, sx.shape), 0.8, 1.0)[..., None]
    # the title plate: oxblood cloth (it is drawn on a WHITE-coloured quad)
    # with a gilt double frame and three gilt title bars
    x0, y0, x1, y1 = px(NB_LEAF_UV)
    plate = img[y0:y1, x0:x1] * BOOK_OXBLOOD
    h, w = y1 - y0, x1 - x0
    ly, lx = np.mgrid[0:h, 0:w].astype(np.float64)
    edge = np.minimum(np.minimum(lx, w - 1 - lx), np.minimum(ly, h - 1 - ly))
    frame = ((edge > 5 * BK_K) & (edge < 8 * BK_K)) | ((edge > 11 * BK_K) & (edge < 12.5 * BK_K))
    bars = np.zeros((h, w), dtype=bool)
    for cy, half in ((0.36, 0.30), (0.50, 0.22), (0.66, 0.16)):
        bars |= (np.abs(ly - cy * h) < 3.2 * BK_K) & (np.abs(lx - w / 2) < half * w)
    gilt = frame | bars
    plate[gilt] = GILT * (0.92 + 0.08 * rng.uniform(size=(int(gilt.sum()), 1)))
    img[y0:y1, x0:x1] = plate
    x0, y0, x1, y1 = px(NB_PAGES_UV)
    sy = yy[y0:y1, x0:x1]
    lines = 0.93 + 0.07 * np.sin(sy * 2.6 / BK_K + rng.uniform(0, 6)) * (0.6 + 0.4 * np.sin(sy * 0.37 / BK_K))
    img[y0:y1, x0:x1] = np.clip(lines, 0.82, 1.0)[..., None]
    return np.clip(img, 0, 1)


def build_books():
    ca.reset_scene()
    tones = [BOOK_NAVY, BOOK_OCHRE, BOOK_OXBLOOD]
    poses = [(0.0, (0.0, 0.0)), (math.radians(7), (1.4, 0.8)), (math.radians(-6), (-1.2, 0.4))]
    parts = []
    z = 0.0
    for (w, d, t), rgb, (yaw, (ox, oy)) in zip(BOOKS, tones, poses):
        b = notebook(f"book{len(parts)}", rgb, NB_CLOTH_UV, w=w, d=d, t=t, cv=0.9)
        # gilt bands across the spine (-X): two raised bars near head and tail
        sh = Sheet()
        for yb in (-d * 0.36, d * 0.36):
            x_a, x_b = -w / 2 - 0.35, -w / 2 + 0.25
            y_a, y_b = yb - 0.9, yb + 0.9
            vs = [sh.bm.verts.new((x, y, zz)) for x in (x_a, x_b) for y in (y_a, y_b) for zz in (0.9, t - 0.9)]
            Vb = lambda i, j, k: vs[(i * 2 + j) * 2 + k]  # noqa: E731
            for quad in ((Vb(0, 0, 0), Vb(0, 1, 0), Vb(0, 1, 1), Vb(0, 0, 1)), (Vb(0, 0, 0), Vb(0, 0, 1), Vb(1, 0, 1), Vb(1, 0, 0)),
                         (Vb(0, 1, 1), Vb(0, 1, 0), Vb(1, 1, 0), Vb(1, 1, 1)), (Vb(0, 0, 1), Vb(0, 1, 1), Vb(1, 1, 1), Vb(1, 0, 1)),
                         (Vb(0, 1, 0), Vb(0, 0, 0), Vb(1, 0, 0), Vb(1, 1, 0))):
                sh.face(quad, [region_uv(NB_PLAIN_UV, s, tt) for s, tt in ((0.1, 0.1), (0.3, 0.1), (0.3, 0.3), (0.1, 0.3))], GILT)
        bands = sh.finish(f"bands{len(parts)}")
        for o in (b, bands):
            o.data.transform(Matrix.Rotation(yaw, 4, "Z"))
            o.data.transform(Matrix.Translation((ox, oy, z)))
            parts.append(o)
        top_z = z + t
        top_pose = (w, d, yaw, ox, oy)
        z += t + 0.02
    # the title plate on the top cover: a white quad a hair proud of the cloth
    w, d, yaw, ox, oy = top_pose
    sh = Sheet()
    pw, pd = w * 0.62, d * 0.62
    vs = [sh.bm.verts.new((x, y, top_z + 0.06)) for x, y in ((-pw / 2, -pd / 2), (pw / 2, -pd / 2), (pw / 2, pd / 2), (-pw / 2, pd / 2))]
    sh.face(vs, [region_uv(NB_LEAF_UV, s, tt) for s, tt in ((0.03, 0.97), (0.97, 0.97), (0.97, 0.03), (0.03, 0.03))], np.array([1.0, 1.0, 1.0]))
    plate = sh.finish("title", recalc=False)
    plate.data.transform(Matrix.Rotation(yaw, 4, "Z"))
    plate.data.transform(Matrix.Translation((ox + 2.5, oy, 0.0)))
    parts.append(plate)
    # the red ribbon marker: out of the middle book's head edge (+Y), over
    # the lower book's edge and down onto the desk
    w1, d1, t1 = BOOKS[1]
    sh = Sheet()
    x_r = 9.0
    path = [(x_r, d1 / 2 - 2.0, BOOKS[0][2] + t1 * 0.55), (x_r + 0.3, d1 / 2 + 0.8, BOOKS[0][2] + t1 * 0.5),
            (x_r + 0.7, d1 / 2 + 2.6, BOOKS[0][2] - 1.5), (x_r + 1.2, d1 / 2 + 3.4, 3.0), (x_r + 1.8, d1 / 2 + 6.5, 0.15)]
    # a thin closed strip (1.7 x 0.3 section), so the single-sided material
    # shows it from above and below and recalc has an inside to orient by
    rw, rt = 1.7, 0.3
    sect = [(-rw / 2, -rt / 2), (rw / 2, -rt / 2), (rw / 2, rt / 2), (-rw / 2, rt / 2)]
    rows = [[sh.bm.verts.new((px_ + sx_, py_, pz_ + sz_)) for sx_, sz_ in sect] for px_, py_, pz_ in path]
    for i in range(len(rows) - 1):
        a, b = rows[i], rows[i + 1]
        for k in range(4):
            k2 = (k + 1) % 4
            uvs = [region_uv(NB_PLAIN_UV, s, tt) for s, tt in ((0.6 + 0.05 * k, 0.1 + 0.15 * i), (0.65 + 0.05 * k, 0.1 + 0.15 * i),
                                                                (0.65 + 0.05 * k, 0.25 + 0.15 * i), (0.6 + 0.05 * k, 0.25 + 0.15 * i))]
            sh.face((a[k], a[k2], b[k2], b[k]), uvs, RIBBON)
    for ring, flip in ((rows[0], True), (rows[-1], False)):
        sh.face(list(reversed(ring)) if flip else ring, [region_uv(NB_PLAIN_UV, s, tt) for s, tt in ((0.9, 0.1), (0.95, 0.1), (0.95, 0.2), (0.9, 0.2))], RIBBON)
    ribbon = sh.finish("ribbon")
    ribbon.data.transform(Matrix.Rotation(poses[1][0], 4, "Z"))
    ribbon.data.transform(Matrix.Translation((poses[1][1][0], poses[1][1][1], 0.0)))
    parts.append(ribbon)
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = "desk-books"
    ca.shade_smooth(obj, 35)
    recentre(obj)
    img = ca.image_from_array("desk-books-print", books_texture())
    obj.data.materials.append(ca.make_material("desk-books", img, roughness=0.72, vertex_color=True))
    report(obj, "books")
    return obj


# ── mid-size anchors (loop 4 r4: "the desk still reads empty, and every prop
# is a 15-50 px speck at the default framing — the scattered small objects
# read as debris rather than a lived-in desk") ─────────────────────────────
# Two flat, broad pieces at real scale — an A6 spiral sketchbook lying open
# (86 x 61 units, 21 x 15 cm) and a small blueprint half unrolled from its
# roll (100 units across, 24 cm) — big enough to read as objects at the
# default framing (~60-120 units), low enough never to hide the board. Both
# on the mug's material contract (print x COLOR_0, single-sided), so they
# link no new shader program.

GRAPHITE_INK = ca.hex_rgb("#45464B")
SKETCH_PAPER = ca.hex_rgb("#F4EFE3")
COVER_BLACK = ca.hex_rgb("#2A2B2F")
SPIRAL = ca.hex_rgb("#A9ABAE")


def draw_strokes(img, polylines, width, rgb, alpha=0.9):
    """Anti-aliased polylines (pixel coords, y down) inked onto img in place:
    each stroke is drawn in its own window (an all-image distance field per
    stroke costs seconds at 512 px)."""
    h, w = img.shape[:2]
    for pts in polylines:
        pts = np.asarray(pts, dtype=np.float64)
        x0, y0 = np.maximum(np.floor(pts.min(axis=0) - width - 2), 0).astype(int)
        x1, y1 = np.minimum(np.ceil(pts.max(axis=0) + width + 2), (w, h)).astype(int)
        if x1 <= x0 or y1 <= y0:
            continue
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float64)
        best = np.full(xx.shape, 1e9)
        for a, b in zip(pts[:-1], pts[1:]):
            d, _t = ca.segment_distance(xx, yy, a[0], a[1], b[0], b[1])
            best = np.minimum(best, d)
        m = (np.clip(1 - (best - width * 0.5) / 0.9, 0, 1) * alpha)[..., None]
        img[y0:y1, x0:x1] = img[y0:y1, x0:x1] * (1 - m) + rgb * m


def wobble(rng, pts, amp=0.8, step=6.0):
    """A hand-drawn line: resampled every `step` px with a small jitter."""
    out = []
    for a, b in zip(pts[:-1], pts[1:]):
        a, b = np.asarray(a, float), np.asarray(b, float)
        n = max(1, int(np.linalg.norm(b - a) / step))
        for k in range(n):
            p = a + (b - a) * k / n
            out.append(p + rng.uniform(-amp, amp, 2))
    out.append(np.asarray(pts[-1], float) + rng.uniform(-amp, amp, 2))
    return out


# ── the sketchbook ──────────────────────────────────────────────────────────

SK_TEX = 512
SK_PAGE_W, SK_PAGE_H = 42.0, 60.0      # one page, A6-ish (x across, y up the page)
SK_GAP = 1.4                           # half the spine gap (the coil row)
SK_LEFT_UV = (0.0, 0.0, 0.5, 0.70)     # u0, v0, u1, v1 (v down): the written page
SK_RIGHT_UV = (0.5, 0.0, 1.0, 0.70)    # the drawing
SK_PLAIN_UV = (0.04, 0.76, 0.96, 0.98)


def sketchbook_texture():
    """Two pages (row 0 = the page tops) + a plain white strip. Graphite only:
    the left page notes and a little cube, the right page an architect's
    sketch of the kind of board the desk carries — boxes, a datastore drum,
    arrows, a hatched side — and the official leaf drawn in red pencil."""
    rng = np.random.default_rng(20261015)
    S = SK_TEX
    img = np.ones((S, S, 3))
    pw, ph = S // 2, int(S * 0.70)
    for x0 in (0, pw):
        # plain paper: a per-texel "tooth" noise tripled the PNG (284 kB) for
        # a grain nobody sees at 60-120 px
        img[0:ph, x0:x0 + pw] = SKETCH_PAPER
    ink = lambda lines, wd=1.6, a=0.85: draw_strokes(img, lines, wd, GRAPHITE_INK, a)  # noqa: E731

    # LEFT page: a heading, six lines of notes, a checklist, a cube
    L = 0
    ink([wobble(rng, [(L + 26, 34), (L + 150, 32)], 0.6)], 2.4)
    for i, y in enumerate(range(62, 62 + 6 * 22, 22)):
        x = L + 26.0
        end = L + pw - 30 - (90 if i == 5 else rng.uniform(0, 50))
        while x < end:
            wl = rng.uniform(22, 60)
            pts = [(x + t, y - 3 - 3.5 * (0.5 + 0.5 * math.sin(t * 0.8 + i))) for t in np.arange(0, wl, 1.6)]
            ink([pts], 1.3, 0.8)
            x += wl + rng.uniform(7, 12)
    for k in range(3):
        y = 214 + k * 24
        ink([wobble(rng, [(L + 28, y - 7), (L + 40, y - 7), (L + 40, y + 5), (L + 28, y + 5), (L + 28, y - 7)], 0.5)], 1.5)
        ink([wobble(rng, [(L + 50, y), (L + 50 + rng.uniform(70, 140), y)], 0.6)], 1.3, 0.75)
    ink([[(L + 30, 223), (L + 34, 228), (L + 42, 214)]], 1.8)        # one ticked
    cx, cy, s = L + 180, 270, 34
    cube = [[(cx, cy), (cx + s, cy - s * 0.45), (cx + s, cy + s * 0.65), (cx, cy + s * 1.1), (cx, cy)],
            [(cx, cy), (cx - s, cy - s * 0.45), (cx - s, cy + s * 0.65), (cx, cy + s * 1.1)],
            [(cx - s, cy - s * 0.45), (cx, cy - s * 0.9), (cx + s, cy - s * 0.45)]]
    ink([wobble(rng, c, 0.6) for c in cube], 2.4)

    # RIGHT page: the board, sketched — three cards, a drum, arrows
    R = pw

    def card(x, y, w, h, d=9):
        pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)]
        ink([wobble(rng, pts, 0.7)], 2.8)
        # the card's thickness, and hatching on its shaded side
        ink([wobble(rng, [(x, y + h), (x + d, y + h + d * 0.6), (x + w + d, y + h + d * 0.6), (x + w, y + h)], 0.5)], 1.4)
        ink([wobble(rng, [(x + w, y), (x + w + d, y + d * 0.6), (x + w + d, y + h + d * 0.6)], 0.5)], 1.4)
        for t in np.arange(4, w, 6):
            ink([[(x + t, y + h + 1), (x + t + d - 2, y + h + d * 0.6 - 1)]], 0.9, 0.55)
        # a title scribble on the card
        ink([[(x + 8 + t, y + 14 + 2.2 * math.sin(t * 0.9)) for t in np.arange(0, w * 0.55, 1.6)]], 1.2, 0.8)

    card(R + 24, 46, 86, 50)
    card(R + 140, 46, 86, 50)
    card(R + 24, 150, 86, 50)
    # the datastore drum
    dx, dy, rx, ry, hh = R + 182, 168, 34, 11, 48
    ell = lambda yc: [(dx + rx * math.cos(a), yc + ry * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 40)]  # noqa: E731
    ink([ell(dy)], 2.8)
    ink([[(dx - rx, dy), (dx - rx, dy + hh)], [(dx + rx, dy), (dx + rx, dy + hh)]], 2.8)
    ink([[(dx + rx * math.cos(a), dy + hh + ry * math.sin(a)) for a in np.linspace(0, math.pi, 22)]], 2.8)

    def arrow(a, b):
        a, b = np.asarray(a, float), np.asarray(b, float)
        ink([wobble(rng, [a, b], 0.5)], 2.2)
        d = (b - a) / np.linalg.norm(b - a)
        n = np.array([-d[1], d[0]])
        ink([[b - d * 9 + n * 5, b, b - d * 9 - n * 5]], 1.6)

    arrow((R + 112, 70), (R + 138, 70))
    arrow((R + 66, 100), (R + 66, 146))
    arrow((R + 184, 100), (R + 184, 152))
    arrow((R + 112, 176), (R + 146, 186))
    # labels under the arrows, and the page's caption
    for x, y, ln in ((R + 112, 62, 22), (R + 72, 124, 28), (R + 190, 128, 26)):
        ink([[(x + t, y + 1.6 * math.sin(t)) for t in np.arange(0, ln, 1.5)]], 1.0, 0.7)
    ink([wobble(rng, [(R + 24, 28), (R + 140, 26)], 0.5)], 2.3)
    # the official leaf, in red pencil, by the caption — the same traced
    # construction path the flag prints, never redrawn
    s = 30.0 / 4030.0
    poly = [(R + 206 + x * s, 252 + y * s) for x, y in ca.official_leaf_polygon()]
    draw_strokes(img, [poly + [poly[0]]], 1.6, ca.hex_rgb("#B8352C"), 0.85)
    # dimension line under the cards
    ink([[(R + 24, 232), (R + 110, 232)], [(R + 24, 226), (R + 24, 238)], [(R + 110, 226), (R + 110, 238)]], 1.1, 0.7)
    for k in range(4):
        y = 286 + k * 18
        ink([[(R + 24 + t, y + 1.6 * math.sin(t * 0.7 + k)) for t in np.arange(0, rng.uniform(90, 170), 1.5)]], 1.2, 0.75)
    return np.clip(img, 0, 1)


def build_sketchbook():
    ca.reset_scene()
    sh = Sheet()
    W, H = SK_PAGE_W, SK_PAGE_H
    CV = 0.6                       # cover board
    over = 1.0                     # the board's overhang past the pages
    thick = {-1: 1.3, 1: 2.1}      # used pages on the left are fewer

    def box(xa, xb, ya, yb, za, zb, rgb):
        """An axis-aligned box, every face UV'd over the whole plain strip
        (plain white, so faces may share it): a 44 x 62 cover board on a
        tenth of the strip measured a UV / surface ratio of 4.4e-6, under
        glbAssets.test.ts's 5e-6 floor."""
        v = [[[sh.bm.verts.new((x, y, z)) for z in (za, zb)] for y in (ya, yb)] for x in (xa, xb)]
        quads = [(v[0][0][0], v[0][1][0], v[1][1][0], v[1][0][0]),   # bottom
                 (v[0][0][1], v[1][0][1], v[1][1][1], v[0][1][1]),   # top
                 (v[0][0][0], v[1][0][0], v[1][0][1], v[0][0][1]),
                 (v[1][1][0], v[0][1][0], v[0][1][1], v[1][1][1]),
                 (v[0][1][0], v[0][0][0], v[0][0][1], v[0][1][1]),
                 (v[1][0][0], v[1][1][0], v[1][1][1], v[1][0][1])]
        for q in quads:
            sh.face(q, [region_uv(SK_PLAIN_UV, s, t) for s, t in ((0.02, 0.05), (0.98, 0.05), (0.98, 0.95), (0.02, 0.95))], rgb)

    for side in (-1, 1):
        xin, xout = side * SK_GAP, side * (SK_GAP + W)
        xa, xb = min(xin, xout), max(xin, xout)
        # the cover board, overhanging the pages on the three free edges
        box(xa - over if side < 0 else xa, xb + over if side > 0 else xb,
            -H / 2 - over, H / 2 + over, 0.0, CV, COVER_BLACK)
        # the page block: a top sheet that dips into the gutter by the coil
        # row, its sides cream page edges
        t = thick[side]
        cols = 7
        xs = [xin + side * W * (k / cols) ** 1.5 for k in range(cols + 1)]   # finer by the spine
        top = []
        for x in xs:
            g = math.exp(-abs(x - xin) / 2.2)
            z = CV + t - 0.9 * g
            top.append([sh.bm.verts.new((x, y, z)) for y in (-H / 2, H / 2)])
        bot = [[sh.bm.verts.new((x, y, CV)) for y in (-H / 2, H / 2)] for x in xs]
        region = SK_RIGHT_UV if side > 0 else SK_LEFT_UV
        # u across the page, left edge to right edge as the page is read
        page_u = lambda x: (x - xa) / (xb - xa)  # noqa: E731
        for k in range(cols):
            a, b = (k, k + 1) if side > 0 else (k + 1, k)    # always west -> east
            ua, ub = page_u(xs[a]), page_u(xs[b])
            sh.face((top[a][0], top[b][0], top[b][1], top[a][1]),
                    [region_uv(region, ua, 0.995), region_uv(region, ub, 0.995), region_uv(region, ub, 0.005), region_uv(region, ua, 0.005)],
                    np.array([1.0, 1.0, 1.0]))
            # the page edges at head and tail
            for j, flip in ((0, False), (1, True)):
                q = (bot[a][j], bot[b][j], top[b][j], top[a][j])
                uvs = [region_uv(SK_PLAIN_UV, 0.1 + 0.05 * k, 0.1), region_uv(SK_PLAIN_UV, 0.15 + 0.05 * k, 0.1),
                       region_uv(SK_PLAIN_UV, 0.15 + 0.05 * k, 0.3), region_uv(SK_PLAIN_UV, 0.1 + 0.05 * k, 0.3)]
                sh.face(tuple(reversed(q)) if flip else q, list(reversed(uvs)) if flip else uvs, PAGES)
        # the fore-edge and the gutter wall
        for col, flip in ((cols, side > 0), (0, side < 0)):
            q = (bot[col][1], bot[col][0], top[col][0], top[col][1])
            uvs = [region_uv(SK_PLAIN_UV, 0.6, 0.1), region_uv(SK_PLAIN_UV, 0.8, 0.1), region_uv(SK_PLAIN_UV, 0.8, 0.3), region_uv(SK_PLAIN_UV, 0.6, 0.3)]
            sh.face(tuple(reversed(q)) if flip else q, list(reversed(uvs)) if flip else uvs, PAGES)
    # the wire coils standing up along the spine
    n_coils, maj, mino = 15, 2.3, 0.26
    for c in range(n_coils):
        y = -H / 2 + 2.5 + (H - 5.0) * c / (n_coils - 1)
        ring = []
        segs, ms = 8, 3
        for i in range(segs):
            a = math.pi * i / (segs - 1)          # a half loop over the spine
            cxz = Vector((maj * math.cos(a), 0.0, CV + 0.4 + maj * math.sin(a)))
            nrm = Vector((math.cos(a), 0.0, math.sin(a)))
            ring.append([sh.bm.verts.new(cxz + nrm * (mino * math.cos(2 * math.pi * j / ms)) + Vector((0, y + mino * math.sin(2 * math.pi * j / ms), 0)))
                         for j in range(ms)])
        for i in range(segs - 1):
            for j in range(ms):
                j2 = (j + 1) % ms
                sh.face((ring[i][j], ring[i + 1][j], ring[i + 1][j2], ring[i][j2]),
                        [region_uv(SK_PLAIN_UV, 0.85 + 0.01 * i, 0.5 + 0.1 * j), region_uv(SK_PLAIN_UV, 0.86 + 0.01 * i, 0.5 + 0.1 * j),
                         region_uv(SK_PLAIN_UV, 0.86 + 0.01 * i, 0.6 + 0.1 * j), region_uv(SK_PLAIN_UV, 0.85 + 0.01 * i, 0.6 + 0.1 * j)], SPIRAL)
    # a pencil left across the drawing, tip toward the reader
    R, L = 1.15, 50.0
    o = Vector((12.0, 16.0, CV + thick[1] + R * 0.87))
    d = Vector((0.55, -0.83, 0.0)).normalized()
    secs = [(0.0, R * 0.96, ERASER), (2.6, R * 1.02, FERRULE), (6.0, R, ca.hex_rgb("#2F6B45")), (L - 7.5, R, PENCIL_WOOD),
            (L - 1.8, 0.42, GRAPHITE), (L, 0.05, GRAPHITE)]
    q = d.to_track_quat("Z", "Y")
    sides = 6
    # vertices at 0, 60, … deg: a flat face down (its depth 0.87 R), resting
    # on the page
    loops = [[sh.bm.verts.new(o + d * t + q @ Vector((r * math.cos(2 * math.pi * j / sides), r * math.sin(2 * math.pi * j / sides), 0)))
              for j in range(sides)] for t, r, _c in secs]
    for i in range(len(secs) - 1):
        for j in range(sides):
            j2 = (j + 1) % sides
            sh.face((loops[i][j], loops[i][j2], loops[i + 1][j2], loops[i + 1][j]),
                    [region_uv(SK_PLAIN_UV, 0.05 + 0.1 * i + dj * 0.08, 0.05 + 0.12 * (j + di)) for dj, di in ((0, 0), (1, 0), (1, 1), (0, 1))],
                    secs[i][2])
    sh.face(list(reversed(loops[0])), [region_uv(SK_PLAIN_UV, 0.5 + 0.08 * math.cos(2 * math.pi * j / sides), 0.5 + 0.3 * math.sin(2 * math.pi * j / sides)) for j in range(sides)], ERASER)
    obj = sh.finish("desk-sketchbook")
    # the pencil rests ON the page: nothing under the desk, the hex's lowest
    # flat a hair above the paper
    ca.shade_smooth(obj, 40)
    recentre(obj)
    img = ca.image_from_array("desk-sketchbook-print", sketchbook_texture())
    obj.data.materials.append(ca.make_material("desk-sketchbook", img, roughness=0.8, vertex_color=True))
    report(obj, "sketchbook")
    return obj


# ── the blueprint ───────────────────────────────────────────────────────────

# 512 x 512 (was x 256, quality pass "mug"): across the sheet the print had
# 220 rows for 92 units — 2.4 texels per unit, half its density along it
BP_TEX_W, BP_TEX_H = 512, 512
BP_W = 92.0          # across the sheet = the roll's length (y)
BP_FLAT = 40.0       # the unrolled run lying on the desk (x)
BP_CURL = 8.0        # the free end lifting
BP_R0 = 5.2          # the roll's outer radius
BP_PITCH = 0.75      # one paper layer per turn
BP_TURNS = 2.6
BP_T = 0.32          # sheet thickness
BLUEPRINT = ca.hex_rgb("#1F4E8E")
BP_LINE = ca.hex_rgb("#EEF3FA")
BP_GRID = ca.hex_rgb("#3D6CAA")
BP_BACK = ca.hex_rgb("#E6E3D8")
RUBBER = ca.hex_rgb("#A64A30")
BP_PRINT_V = 0.86    # the print fills v in [0, BP_PRINT_V]; below, plain white


def blueprint_texture(visible_u0):
    """Prussian-blue print (u along the sheet from the roll's core to the free
    end; v across it), a fine grid, and — on the part that lies unrolled
    (u >= visible_u0) — a white floor plan with door swings, dimension lines
    and a title block. Below BP_PRINT_V: plain white (back, edges, band)."""
    rng = np.random.default_rng(20261016)
    W, H = BP_TEX_W, BP_TEX_H
    # every y below was authored for a 256-row map: ky keeps its world layout
    # while the 512-row map doubles the texels across the sheet. The grid,
    # the door swings and the wall offsets are now square in px — and so
    # square in world (at 256 rows a 12-px cell was a 2.7 x 5-unit oblong)
    ky = H / 256
    ph = int(H * BP_PRINT_V)
    img = np.ones((H, W, 3))
    img[:ph] = BLUEPRINT
    yy, xx = np.mgrid[0:ph, 0:W].astype(np.float64)
    grid = (np.abs(((xx + 0.5) % 12) - 6) > 5.4) | (np.abs(((yy + 0.5) % 12) - 6) > 5.4)
    img[:ph][grid] = BLUEPRINT * 0.6 + BP_GRID * 0.4
    sub = img[:ph]
    line = lambda pts, wd=1.4, a=0.95: draw_strokes(sub, [pts], wd, BP_LINE, a)  # noqa: E731
    # the plan, inside the visible run (texture px)
    u0 = int(visible_u0 * W) + 10
    u1 = W - 14
    v0, v1 = 16 * ky, ph - 16 * ky
    # outer walls (double line), rooms, door swings
    for off in (0, 4):
        line([(u0 + off, v0 + off), (u1 - off, v0 + off), (u1 - off, v1 - off), (u0 + off, v1 - off), (u0 + off, v0 + off)], 1.6)
    mx = u0 + (u1 - u0) * 0.48
    my = v0 + (v1 - v0) * 0.55
    line([(mx, v0 + 4), (mx, my - 14 * ky)], 1.6)
    line([(mx, my + 10 * ky), (mx, v1 - 4)], 1.6)
    line([(u0 + 4, my), (mx - 16, my)], 1.6)
    line([(mx, my), (u1 - 4, my)], 1.6)
    for (cx, cy, r, a0) in ((mx, my - 14 * ky, 24, 0.0), (mx - 16, my, 18, math.pi / 2)):
        line([(cx + r * math.cos(a0 + t), cy + r * math.sin(a0 + t)) for t in np.linspace(0, math.pi / 2, 16)], 1.0, 0.8)
    # stairs in one room, a table in another
    for k in range(7):
        x = mx + 14 + k * 7
        line([(x, my + 14 * ky), (x, my + 46 * ky)], 0.9, 0.85)
    line([(u0 + 30, v0 + 30 * ky), (u0 + 70, v0 + 30 * ky), (u0 + 70, v0 + 56 * ky), (u0 + 30, v0 + 56 * ky), (u0 + 30, v0 + 30 * ky)], 1.1)
    # dimension lines outside the walls, with ticks
    for x in (u0, mx, u1):
        line([(x, v1 + 5 * ky), (x, v1 + 12 * ky)], 0.9, 0.8)
    line([(u0, v1 + 8 * ky), (u1, v1 + 8 * ky)], 0.9, 0.8)
    # the title block, bottom right
    tx0, ty0 = u1 - 70, v1 - 40 * ky
    line([(tx0, ty0), (u1 - 6, ty0), (u1 - 6, v1 - 6), (tx0, v1 - 6), (tx0, ty0)], 1.1)
    line([(tx0, ty0 + 14 * ky), (u1 - 6, ty0 + 14 * ky)], 0.9)
    for k, ln in enumerate((40, 28)):
        y = ty0 + (7 + 14 * k + (6 if k else 0)) * ky
        line([(tx0 + 6 + t, y + 1.2 * math.sin(t)) for t in np.arange(0, ln, 1.6)], 0.9, 0.85)
    # faint plan notes on the part that hides inside the roll
    for k in range(5):
        y = (30 + k * 34) * ky
        line([(20 + t, y + 1.4 * math.sin(t * 0.7)) for t in np.arange(0, rng.uniform(60, 140), 1.6)], 0.9, 0.5)
    img[:ph] = sub
    return np.clip(img, 0, 1)


def blueprint_path():
    """(s, x, z, nx, nz) samples along the sheet's midline, s from the roll's
    core to the free end; (nx, nz) is the print side's normal."""
    pts = []
    # the roll: an Archimedean spiral round C = (0, R0), wound so the sheet
    # leaves its bottom heading +x (print side inward)
    n_roll = int(BP_TURNS * 18)
    for i in range(n_roll + 1):
        turn = BP_TURNS * (1 - i / n_roll)            # turns remaining to the outer layer
        th = -math.pi / 2 - 2 * math.pi * turn
        r = BP_R0 - BP_PITCH * turn
        pts.append((r * math.cos(th), BP_R0 + r * math.sin(th)))
    # the flat run, then the free end curling up
    for k in (1, 2):
        pts.append((BP_FLAT * k / 2, 0.0))
    rc = BP_CURL / 1.1
    for k in range(1, 5):
        a = 1.1 * k / 4
        pts.append((BP_FLAT + rc * math.sin(a), rc * (1 - math.cos(a))))
    out = []
    s = 0.0
    for i, (x, z) in enumerate(pts):
        if i:
            s += math.hypot(x - pts[i - 1][0], z - pts[i - 1][1])
        a = pts[max(0, i - 1)]
        b = pts[min(len(pts) - 1, i + 1)]
        tx, tz = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(tx, tz)
        out.append((s, x, z + BP_T / 2, -tz / ln, tx / ln))
    return out


def build_blueprint():
    ca.reset_scene()
    sh = Sheet()
    path = blueprint_path()
    S = path[-1][0]
    s_flat = next(s for s, x, z, _a, _b in path if abs(x) < 1e-6 and abs(z - BP_T / 2) < 1e-6)
    visible_u0 = s_flat / S
    W = BP_W
    top, bot = [], []
    for s, x, z, nx, nz in path:
        top.append([sh.bm.verts.new((x + nx * BP_T / 2, y, z + nz * BP_T / 2)) for y in (-W / 2, W / 2)])
        bot.append([sh.bm.verts.new((x - nx * BP_T / 2, y, z - nz * BP_T / 2)) for y in (-W / 2, W / 2)])
    pv = lambda t: BP_PRINT_V * t  # noqa: E731

    def plain(s0, s1, t0, t1):
        """A patch of the plain white strip under the print (it may be shared:
        the faces that use it carry their tone in COLOR_0). t spans the
        strip's whole height: the sheet's back on half of it measured a UV /
        surface ratio near glbAssets.test.ts's 5e-6 floor."""
        v0, v1 = BP_PRINT_V + 0.02, 0.99
        return [(0.04 + 0.92 * s0, 1 - (v0 + (v1 - v0) * t0)), (0.04 + 0.92 * s1, 1 - (v0 + (v1 - v0) * t0)),
                (0.04 + 0.92 * s1, 1 - (v0 + (v1 - v0) * t1)), (0.04 + 0.92 * s0, 1 - (v0 + (v1 - v0) * t1))]

    for i in range(len(path) - 1):
        ua, ub = path[i][0] / S, path[i + 1][0] / S
        # the print side (+n): v runs across the sheet, y = -W/2 at the top row
        sh.face((top[i][0], top[i + 1][0], top[i + 1][1], top[i][1]),
                [(ua, 1 - pv(0.995)), (ub, 1 - pv(0.995)), (ub, 1 - pv(0.005)), (ua, 1 - pv(0.005))], np.array([1.0, 1.0, 1.0]))
        # the back of the sheet, and the two cut edges
        sh.face((bot[i][1], bot[i + 1][1], bot[i + 1][0], bot[i][0]), plain(ua, ub, 0.0, 1.0), BP_BACK)
        sh.face((bot[i][0], bot[i + 1][0], top[i + 1][0], top[i][0]), plain(ua, ub, 0.55, 0.7), BP_BACK * 0.92)
        sh.face((top[i][1], top[i + 1][1], bot[i + 1][1], bot[i][1]), plain(ua, ub, 0.75, 0.9), BP_BACK * 0.92)
    for i, flip in ((0, True), (len(path) - 1, False)):
        q = (bot[i][0], top[i][0], top[i][1], bot[i][1])
        sh.face(tuple(reversed(q)) if flip else q, plain(0.1, 0.2, 0.1, 0.4), BP_BACK)
    # the rubber band round the roll, a hand's width in from one end
    yb, R, r = W / 2 - 14.0, BP_R0 + BP_T + 0.25, 0.42
    segs, ms = 20, 4
    rings = [[sh.bm.verts.new((math.cos(a) * (R + r * math.cos(b)), yb + r * math.sin(b), BP_R0 + BP_T / 2 + math.sin(a) * (R + r * math.cos(b))))
              for b in (2 * math.pi * j / ms for j in range(ms))] for a in (2 * math.pi * i / segs for i in range(segs))]
    for i in range(segs):
        i2 = (i + 1) % segs
        for j in range(ms):
            j2 = (j + 1) % ms
            sh.face((rings[i][j], rings[i2][j], rings[i2][j2], rings[i][j2]), plain(i / segs, (i + 1) / segs, 0.1 + 0.2 * j / ms, 0.1 + 0.2 * (j + 1) / ms), RUBBER)
    obj = sh.finish("desk-blueprint")
    ca.shade_smooth(obj, 40)
    recentre(obj)
    img = ca.image_from_array("desk-blueprint-print", blueprint_texture(visible_u0))
    obj.data.materials.append(ca.make_material("desk-blueprint", img, roughness=0.75, vertex_color=True))
    report(obj, "blueprint")
    return obj


# ── shared ──────────────────────────────────────────────────────────────────

def desk_ground():
    """AFTER export only: a plane in the desk's wood tone (contrast check)."""
    if not ca.PREVIEW or "desk-ground" in bpy.data.objects:
        return
    bpy.ops.mesh.primitive_plane_add(size=600, location=(0, 0, 0))
    g = bpy.context.active_object
    g.name = "desk-ground"
    mat = bpy.data.materials.new("desk-ground")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*ca.srgb_to_linear(ca.hex_rgb("#D29A5E")), 1.0)
    g.data.materials.append(mat)


def recentre(obj):
    co = np.array([v.co[:] for v in obj.data.vertices])
    cx = (co[:, 0].min() + co[:, 0].max()) / 2
    cy = (co[:, 1].min() + co[:, 1].max()) / 2
    obj.data.transform(Matrix.Translation((-cx, -cy, -co[:, 2].min())))
    obj.data.update()


def report(obj, label):
    co = np.array([v.co[:] for v in obj.data.vertices])
    r = np.hypot(co[:, 0], co[:, 1]).max()
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print(f"[desk] {label}: plan radius {r:.1f}  height {co[:, 2].max():.1f}  {tris} tris")


def preview(obj, filename, cam_loc, target, **kw):
    for o in list(bpy.data.objects):
        if o.name.startswith(("cam", "sun")):
            bpy.data.objects.remove(o, do_unlink=True)
    ca.preview(obj, filename, cam_loc, target, **kw)


if __name__ == "__main__":
    only = ca.arg("only")
    if only in (None, "mug"):
        mug = build_mug()
        ca.export(mug, "desk-mug.glb")
        preview(mug, "mug-iso.png", (95, 80, 85), (0, 0, 18))
        preview(mug, "mug-side.png", (0, -110, 40), (0, 0, 20))
        preview(mug, "mug-far.png", (300, 250, 270), (0, 0, 18), size=(500, 400))
        # close-ups at the harness close-up's ~18 px per unit: the handle's
        # lower curl and roots, the print's edge, the coffee's meniscus
        preview(mug, "mug-handle.png", (34, -58, 42), (8, 0, 24))
        preview(mug, "mug-print.png", (-6, -62, 26), (-6, 0, 23))
        preview(mug, "mug-coffee.png", (20, -30, 90), (-6, 0, 38))
    if only in (None, "note"):
        note = build_note()
        ca.export(note, "desk-note.glb")
        preview(note, "note-iso.png", (60, 50, 55), (0, 0, 0))
        preview(note, "note-top.png", (0, 0.1, 70), (0, 0, 0))
        preview(note, "note-far.png", (220, 185, 200), (0, 0, 0), size=(500, 400))
    if only in (None, "notebooks"):
        nb = build_notebooks()
        ca.export(nb, "desk-notebooks.glb")
        desk_ground()
        preview(nb, "notebooks-iso.png", (75, 62, 68), (0, 0, 4))
        preview(nb, "notebooks-top.png", (0, 0.1, 110), (0, 0, 0))
        preview(nb, "notebooks-far.png", (260, 215, 235), (0, 0, 4), size=(500, 400))
    if only in (None, "plant"):
        plant = build_plant()
        ca.export(plant, "desk-plant.glb")
        desk_ground()
        preview(plant, "plant-iso.png", (95, 80, 95), (0, 0, 30))
        preview(plant, "plant-side.png", (0, -120, 40), (0, 0, 32))
        preview(plant, "plant-far.png", (300, 250, 280), (0, 0, 28), size=(500, 400))
    if only in (None, "cup"):
        cup = build_cup()
        ca.export(cup, "desk-pencil-cup.glb")
        desk_ground()
        preview(cup, "cup-iso.png", (95, 80, 100), (0, 0, 38))
        preview(cup, "cup-side.png", (0, -130, 45), (0, 0, 40))
        preview(cup, "cup-far.png", (320, 270, 300), (0, 0, 36), size=(500, 400))
        preview(cup, "cup-rim.png", (30, -32, 62), (0, 0, 38))
    if only in (None, "books"):
        books = build_books()
        ca.export(books, "desk-books.glb")
        desk_ground()
        preview(books, "books-iso.png", (85, 70, 75), (0, 0, 8))
        preview(books, "books-top.png", (0, 0.1, 120), (0, 0, 0))
        preview(books, "books-far.png", (280, 235, 255), (0, 0, 8), size=(500, 400))
    if only in (None, "sketchbook"):
        sk = build_sketchbook()
        ca.export(sk, "desk-sketchbook.glb")
        desk_ground()
        preview(sk, "sketchbook-iso.png", (95, 80, 85), (0, 0, 2))
        preview(sk, "sketchbook-top.png", (0, 0.1, 140), (0, 0, 0))
        preview(sk, "sketchbook-far.png", (330, 280, 300), (0, 0, 2), size=(500, 400))
    if only in (None, "blueprint"):
        bp = build_blueprint()
        ca.export(bp, "desk-blueprint.glb")
        desk_ground()
        preview(bp, "blueprint-iso.png", (95, 80, 85), (0, 0, 4))
        preview(bp, "blueprint-top.png", (0, 0.1, 140), (0, 0, 0))
        preview(bp, "blueprint-far.png", (330, 280, 300), (0, 0, 4), size=(500, 400))
