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

"""The city world's Mont-Royal landmark, authored in Blender and exported as a
glTF binary (quality pass "montroyal": the user's "le décor du mont royal est
horrible", reports/view3d-quality/me-tp4/city-wide.png — a faceted green
cone; second iteration "montroyal2": tp5-final-dpr1/city-mont-royal.png read
as a SYMMETRIC hemispherical mound of identical round blobs on a square
lawn; third iteration "montroyal3": tp6-final-dpr1/city-mont-royal.png still
read as a near-round dome of lollipop trees, with a glassy sheen round the
chalet; fourth iteration "montroyal4": tp7-final-dpr1/city-mont-royal.png
still a ROUND dome dropped on a flat park, the canopy same-sized clumps in
solid one-colour STANDS — a red mass, a yellow mass, an olive mass — with
dark brown litter blotches between them and a hard forest edge on the lawn).

    blender --background --factory-startup --python scripts/blender/mont_royal_assets.py -- \
        --out src/canvas3d/decor/assets [--preview reports/view3d-quality/blender/<run>]

  mont-royal.glb    a maquette of the mountain in October: an elongated
                    RIDGE (long axis across the downtown view, Blender X,
                    roughly NE-SW on the real mountain) carrying three
                    separate summits at three heights — the Colline de la
                    Croix (the cross, the highest, east end), Outremont
                    (set back, north) and Westmount (the lowest, west end) —
                    with real saddles between them; a PLATEAU raised behind
                    a steep escarpment along the downtown face (the chalet
                    and the Kondiaronk belvedere stand on its lip); and
                    long, gentle foothills all round, whose slope and whose
                    normals run out flat into the park's lawn, so there is
                    no rim where the mountain meets the ground. The woods
                    are MIXED: maples of every size and three crown forms,
                    pointed conifers, slender birches, the species and the
                    leaf tone drawn per tree from fields that vary
                    continuously with elevation, exposure and a slow noise
                    (greens at the foot, reds and oranges on the slopes,
                    golds and conifers up high), so no slope is one solid
                    colour; the ground under them takes the colour of the
                    crowns above it, in shade (no brown litter lanes).
                    Open, crisp-edged meadows round the cross and the chalet
                    (the Chalet du Mont-Royal on its half-moon terrace), the
                    tall steel-LATTICE cross (lit), Beaver Lake on the west
                    saddle, the Olmsted road winding up the east face in two
                    hairpins with a small lookout on its upper bend, the
                    other paths, and at the foot the park's lawn in the
                    CITY's own lawn tone, sloping under the city's park pads
                    with UP normals.

Contract with the engine (decor/backgrounds.ts): the mesh is merged into the
CITY's one material (vertex colours over the facade atlas), so it carries
COLOR_0 for every tone and uses its UV only as a per-corner CODE —
  u = 0.1  plain (the atlas's white texel),
  u = 0.5  water (the atlas's glossy water texel: Beaver Lake),
  u = 0.9  lit (the cross: the engine brightens its albedo past the bloom
           threshold, the program has no emissive feature to key),
with v = 0.5 everywhere (glTF flips v; a code in u survives the flip). No
texture, no new program.

Units: the nominal mountain radius is R = 100 at the origin, the downtown
face (escarpment, belvedere) toward Blender -Y = glTF +Z; the engine scales
R onto its mount radius and yaws that face toward the iso camera. The lawn
skirt reaches APRON_R (< 1.2 R); nothing reaches farther, and nothing dips
under the street (z >= 0). Deterministic: one seeded numpy generator, no
wall clock.
"""

import math
import os
import sys

import bmesh
import bpy
import numpy as np

sys.dont_write_bytecode = True  # no __pycache__ beside the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import canadiana_assets as ca  # noqa: E402  (helpers; its __main__ does not run)

R = 100.0
LAWN_H = 1.4          # the park's lawn at the mountain's foot
SKIRT = 1.06          # the lawn skirt's outer edge, × the foot radius …
SKIRT_H = 0.3         # … and its height there: UNDER the city's lawn pads
                      # (0.95 maquette, backgrounds.ts fillCellBuilt), so the
                      # park runs on into the city's park cells with no seam —
                      # montroyal-m1/city-mont-royal.png: a round sidewalk ring
                      # with a curb made the whole landmark a cake on a plate.
                      # Its faces carry UP normals (custom normals, set after
                      # the join), and the foothills' own normals bend to UP
                      # over their last 18 % (montroyal4: a lit rim where the
                      # wooded slope met the lawn)

# The three summits (plan x, y; Blender -Y = the downtown face, +X = the
# ridge's east end), strung ALONG an elongated ridge seen broadside from the
# city, each its own peak with a saddle on either side of it.
CROIX = (44.0, -6.0)        # Colline de la Croix, 233 m — the cross, highest
OUTREMONT = (-6.0, 19.0)    # 211 m, set back
WESTMOUNT = (-64.0, 2.0)    # 201 m, the lowest, the west end

# the ridge's spine, west to east: the crest line the summits sit on
SPINE = [(-92.0, 4.0), (-64.0, 2.0), (-36.0, 8.0), (-6.0, 17.0), (20.0, 5.0), (44.0, -6.0), (74.0, -12.0),
         (94.0, -14.0)]


def _wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def _foot_raw(theta):
    """An elongated, lobed foot: an ellipse longer along the ridge (X), the
    downtown face (-Y) nearer the crest than the back slope (+Y), lobes
    toward the two ends, Outremont's back and two spurs, a few harmonics."""
    c, s = math.cos(theta), math.sin(theta)
    a, b = 1.0, (0.66 if s < 0 else 0.78)
    ell = a * b / math.sqrt((b * c) ** 2 + (a * s) ** 2)
    lobes = (0.10 * math.exp(-(_wrap(theta - math.pi) / 0.32) ** 2)
             + 0.07 * math.exp(-(_wrap(theta + 0.22) / 0.30) ** 2)
             + 0.07 * math.exp(-(_wrap(theta - 1.62) / 0.40) ** 2)
             + 0.05 * math.exp(-(_wrap(theta + 2.25) / 0.28) ** 2)
             + 0.04 * math.exp(-(_wrap(theta - 0.75) / 0.25) ** 2))
    harm = 1 + 0.035 * math.sin(3 * theta + 0.4) + 0.025 * math.sin(5 * theta + 1.7) + 0.015 * math.sin(7 * theta + 0.3)
    return (ell + lobes) * harm


_FOOT_MAX = max(_foot_raw(2 * math.pi * k / 720) for k in range(720))
FOOT_MAX = 1.10  # the foot's farthest lobe (the west end), × R


def foot(theta):
    """The mountain's irregular foot (plan radius at bearing theta),
    normalised so the farthest lobe stands at FOOT_MAX."""
    return R * FOOT_MAX * _foot_raw(theta) / _FOOT_MAX


APRON_R = max(foot(2 * math.pi * k / 720) for k in range(720)) * SKIRT   # the asset's plan radius
PARK_R = 1.08 * R    # the park trees off the foot stop here (the city's own start at 1.12)

UV_PLAIN = (0.1, 0.5)
UV_WATER = (0.5, 0.5)
UV_LIT = (0.9, 0.5)

RNG = np.random.default_rng(1876)  # the year Olmsted's park opened


def lin(h):
    return ca.srgb_to_linear(ca.hex_rgb(h))


# palette (sRGB authored, stored linear)
# the open ground between sparse trees: a late-October dry grass, the same
# family as the meadows and the lawn so the foothills fade into the park
# (#93925A, a khaki, lit as a bare brown mound in the app between crowns:
# tp8-montroyal4-m2/city-mont-royal.png)
OPEN = lin("#8A9556")
# the open meadows (summit, chalet lawn, lake shore): a late-October grass,
# a step lighter than the woods but not pale — a pale meadow tone smeared
# across the coarse terrain of iteration 2 was the "glassy sheen" round the
# chalet (tp6-final-dpr1/city-mont-royal.png)
MEADOW = lin("#9A9C5A")
# the park at the foot: EXACTLY the city's park lawn (backgrounds.ts
# CITY.lawn #97A97E × the park's 0.96 tone, fillCellBuilt's mount branch),
# so the skirt and the city's park pads are one lawn
LAWN = lin("#97A97E") * 0.96
GRAVEL = lin("#DED1AE")         # paths: light, so the Olmsted road reads
# grey limestone: the escarpment's bare band must read as ROCK, not as a
# bare brown slope (#8B8173 did, tp8-montroyal4-m3/city-mont-royal.png)
ROCK = lin("#8F8B83")
ROCK_DARK = lin("#79766F")
STONE = lin("#E8DFC6")          # chalet / belvedere limestone
STONE_SHADE = lin("#BFB49A")
ROOF = lin("#8C4A34")           # the chalet's red-brown tiles
WINDOW = lin("#3E342D")
# the cross: warm white steel (B >= 0.6 linear, so the GLB test's
# near-white check holds); the engine adds MONT_ROYAL_LIT_GAIN on top
CROSS = lin("#FFF1D4")
CONCRETE = lin("#B3AEA4")
WATER = lin("#6F8EA0")
BIRCH_BARK = lin("#E9E4D8")
BIRCH_GOLD = [lin("#E8C640"), lin("#DDBA3C"), lin("#EFD660")]
EVERGREEN = [lin("#2E4A35"), lin("#35573C"), lin("#2A4431"), lin("#3B5B3A")]

# The October leaf ramp, one hue coordinate h in [0, 1]: the last greens,
# olive, gold, orange, burnt orange, red, crimson. A maple's tone is a point
# on it (montroyal4: one tone per STAND read as solid red / yellow / olive
# blocks; a per-tree draw from one weighted table, montroyal3, read as
# uniform confetti — a continuous field plus a per-tree spread is neither)
LEAF_RAMP = [(0.00, lin("#5E8442")), (0.14, lin("#7D9447")), (0.28, lin("#ADA03E")), (0.42, lin("#E0AA33")),
             (0.55, lin("#DE8A2C")), (0.67, lin("#D96A28")), (0.79, lin("#C8462A")), (0.90, lin("#B33729")),
             (1.00, lin("#913229"))]


def leaf_tone(h):
    h = min(1.0, max(0.0, h))
    for (h0, c0), (h1, c1) in zip(LEAF_RAMP, LEAF_RAMP[1:]):
        if h <= h1:
            f = (h - h0) / (h1 - h0)
            return c0 + (c1 - c0) * f
    return LEAF_RAMP[-1][1]


# ── the bmesh builder ─────────────────────────────────────────────────────────

class Mesh:
    """A bmesh with the UVMap + Color corner layers and a face flag for the
    ground (1 the lawn skirt, 2 the terrain: their normals are bent UP after
    the join). One part per instance; `finish` makes an object whose shading
    the caller sets."""

    def __init__(self):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.col = self.bm.loops.layers.float_color.new("Color")
        self.flag = self.bm.faces.layers.int.new("mr_ground")

    def v(self, co):
        return self.bm.verts.new(co)

    def face(self, verts, rgbs, uv=UV_PLAIN, ground=0):
        try:
            f = self.bm.faces.new(verts)
        except ValueError:
            return None
        if not isinstance(rgbs, list):
            rgbs = [rgbs] * len(verts)
        for loop, rgb in zip(f.loops, rgbs):
            loop[self.uv].uv = uv
            loop[self.col] = (float(rgb[0]), float(rgb[1]), float(rgb[2]), 1.0)
        f[self.flag] = ground
        return f

    def finish(self, name, smooth_angle=None):
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        obj = bpy.data.objects.new(name, me)
        bpy.context.collection.objects.link(obj)
        me.color_attributes.active_color = me.color_attributes["Color"]
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        if smooth_angle is None:
            bpy.ops.object.shade_flat()
        else:
            # marks sharp edges as an attribute (no modifier), so it survives
            # the join below
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(smooth_angle))
        return obj


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


# ── the terrain ──────────────────────────────────────────────────────────────
# Four terms, each readable on its own:
#   apron    a broad, low swell over the whole foot whose slope dies to zero
#            AT the foot (the long gentle foothills: no rim on the lawn);
#   plateau  the mass raised behind the escarpment along the downtown face,
#            fading out over the back slope and toward the west end;
#   ridge    a low crest along the spine;
#   summits  three peaks elongated along the ridge, far enough apart that
#            their tails meet in SADDLES well under each of them.
# montroyal4: the earlier massif summed a tall continuous ridge term (18.5)
# and a big base swell under three round bumps, so the saddles sat within a
# few units of the side summits and the whole read as one dome.

APRON_H = 9.5
RIDGE_H = 6.0
RIDGE_SIG_FRONT = 13.0    # the downtown (-Y) flank: steep
RIDGE_SIG_BACK = 26.0     # the back (+Y) slope: long and gentle
SUMMITS = [  # x, y, height, sigma along, sigma on the downtown (-Y) side, sigma behind
    (CROIX[0], CROIX[1], 35.0, 16.0, 13.0, 16.0),
    (OUTREMONT[0], OUTREMONT[1], 24.0, 15.0, 11.0, 15.0),
    (WESTMOUNT[0], WESTMOUNT[1], 31.0, 14.0, 10.5, 14.0),
]
# the escarpment: the plateau's front edge, a line across the downtown face
# (x, y), and the plateau's height behind it
# (under the Croix it runs well in front of the summit: at y -21 it lay
# right under the Olmsted road and, with the road and the summit meadow,
# left the Croix's whole face bare, montroyal4 it2 preview)
ESC = [(-50.0, -12.0), (-30.0, -22.0), (-10.0, -28.0), (6.0, -29.5), (22.0, -31.0), (38.0, -32.0),
       (54.0, -31.0), (70.0, -29.0), (90.0, -27.0)]
ESC_X = np.array([p[0] for p in ESC])
ESC_Y = np.array([p[1] for p in ESC])
ESC_H = 11.0
ESC_W = 2.3               # the sigmoid's width: ~9 units from foot to lip
# on the downtown shoulder between the Croix and Outremont, facing downtown,
# on the escarpment's lip
CHALET = (6.0, -6.0)
CHALET_W, CHALET_D = 20.0, 8.6
BELV = (6.0, -15.0)           # the belvedere's centre (its half-moon faces -Y)
BELV_R = 10.5
LAKE = (-30.0, 13.0)          # Beaver Lake on the west saddle
LAKE_R = 7.0
# a lookout on the Olmsted road's upper bend (the Camillien-Houde side),
# facing out over the east foot
LOOKOUT = (84.5, -23.0)
LOOKOUT_R = 4.6
LOOKOUT_FACE = math.atan2(-0.4, 0.92)

_SP = np.array(SPINE)
_SP_LENS = [float(np.hypot(*(_SP[i + 1] - _SP[i]))) for i in range(len(_SP) - 1)]
_SP_TOTAL = sum(_SP_LENS)


def spine_d(x, y):
    """Signed plan distance to the spine (negative on the downtown side) and
    the along-ridge fraction 0 (west end) … 1 (east end)."""
    best = (1e9, 0.0, 0.0)
    run = 0.0
    for i in range(len(_SP) - 1):
        p0, p1 = _SP[i], _SP[i + 1]
        d = p1 - p0
        u = max(0.0, min(1.0, ((x - p0[0]) * d[0] + (y - p0[1]) * d[1]) / (d[0] ** 2 + d[1] ** 2)))
        qx, qy = p0[0] + u * d[0], p0[1] + u * d[1]
        dist = math.hypot(x - qx, y - qy)
        if dist < best[0]:
            # side: the spine runs west → east, so its left (+Y) is the back
            side = d[0] * (y - qy) - d[1] * (x - qx)
            best = (dist, 1.0 if side >= 0 else -1.0, (run + u * _SP_LENS[i]) / _SP_TOTAL)
        run += _SP_LENS[i]
    return best[0] * best[1], best[2]


def foot_t(x, y):
    """How far out along its bearing a point lies: 1 at the foot."""
    return math.hypot(x, y) / foot(math.atan2(y, x))


def esc_y(x):
    return float(np.interp(x, ESC_X, ESC_Y))


def esc_window(x):
    return smoothstep(-52.0, -24.0, x) * smoothstep(96.0, 70.0, x)


def esc_band(x, y):
    """1 on the escarpment's face (within ~2 units of its line), 0 off it."""
    return smoothstep(4.5, 1.5, abs(y - esc_y(x))) * esc_window(x)


def plateau(x, y, sd):
    """The mass behind the escarpment: ESC_H behind its lip, 0 in front,
    fading over the back slope and toward the two ends."""
    win = esc_window(x)
    if win <= 0.0:
        return 0.0
    z = (y - esc_y(x)) / ESC_W
    front = 1.0 / (1.0 + math.exp(-max(-40.0, min(40.0, z))))
    back = math.exp(-0.5 * (max(0.0, sd) / 30.0) ** 2)
    return ESC_H * win * front * back


def raw_h(x, y):
    t = foot_t(x, y)
    if t >= 1:
        return 0.0
    # the apron: (1 - t^2)^2 has zero slope AT the foot, so the foothills run
    # out flat onto the lawn
    h = APRON_H * (1 - t * t) ** 2
    sd, along = spine_d(x, y)
    inner = smoothstep(1.0, 0.5, t)
    sg = RIDGE_SIG_FRONT if sd < 0 else RIDGE_SIG_BACK
    h += inner * RIDGE_H * (0.75 + 0.25 * math.sin(math.pi * along)) * math.exp(-0.5 * (sd / sg) ** 2)
    h += inner * plateau(x, y, sd)
    for sx, sy, sh, sa, sf, sb in SUMMITS:
        gy = sf if y < sy else sb
        h += inner * sh * math.exp(-0.5 * (((x - sx) / sa) ** 2 + ((y - sy) / gy) ** 2))
    # gullies and spurs on the flanks: the slopes are not a turned bowl
    rough = smoothstep(0.95, 0.5, t)
    h += rough * (1.6 * math.sin(0.085 * x + 0.6) * math.cos(0.075 * y - 0.4) + 1.0 * math.sin(0.16 * x + 0.11 * y + 1.1))
    return max(0.0, h)


SHELF_H = raw_h(BELV[0], BELV[1] + 4.0)
LAKE_H = raw_h(*LAKE) - 1.0


def terrain_h(x, y):
    """Height over the lawn: the massif, the belvedere shelf, the lake
    basin, the lookout's pad."""
    h = raw_h(x, y)
    # the belvedere shelf: flat round the terrace and the chalet
    # — the chalet's footprint and the half-moon, and a few units round
    # them: a wide round shelf cut a dark rock wall into the Croix's west
    # flank (tp7-montroyal3-f/city-mont-royal.png), a narrow round one left
    # the terrace's front on a tall pale retaining wall (tp7-montroyal3-g);
    # in front of the terrace the escarpment drops straight off it
    d_box = math.hypot(max(abs(x - CHALET[0]) - CHALET_W / 2, 0.0), max(abs(y - CHALET[1]) - CHALET_D / 2, 0.0))
    d_belv = max(0.0, math.hypot(x - BELV[0], y - BELV[1]) - BELV_R)
    reach = 5.5 if y > BELV[1] else 3.0
    w = smoothstep(reach, 0.8, min(d_box, d_belv))
    h = h + (SHELF_H - h) * w
    # Beaver Lake's basin
    lw = smoothstep(LAKE_R + 7.0, LAKE_R + 1.5, math.hypot(x - LAKE[0], y - LAKE[1]))
    h = h + (LAKE_H - h) * lw
    return max(0.0, h)


def ground_z(x, y):
    t = foot_t(x, y)
    if t < 1:
        return LAWN_H + terrain_h(x, y)
    # the lawn skirt sloping down under the city's pads
    return LAWN_H + (SKIRT_H - LAWN_H) * min(1.0, (t - 1) / (SKIRT - 1))


def grad(x, y, e=1.5):
    gx = (ground_z(x + e, y) - ground_z(x - e, y)) / (2 * e)
    gy = (ground_z(x, y + e) - ground_z(x, y - e)) / (2 * e)
    return gx, gy


def slope(x, y, e=1.5):
    return math.hypot(*grad(x, y, e))


def downhill(x, y, e=2.0):
    gx, gy = grad(x, y, e)
    n = math.hypot(gx, gy) + 1e-9
    return -gx / n, -gy / n


# ── paths: Catmull-Rom polylines over the terrain ───────────────────────────

PATHS = [
    # the Olmsted road (chemin Olmsted): from the east foot at avenue des
    # Pins up the east face in two long hairpins, round under the summit, to
    # the chalet's east end — wide and light, the one road that must read.
    # Its upper reach runs along the escarpment's lip, well under the cross
    # (at y -15 it crossed the Croix's face half-way up and, with the summit
    # meadow, left that face bare: tp8-montroyal4-m2/city-mont-royal.png)
    ([(108, -30), (92, -38), (76, -47), (62, -50), (51, -45), (54, -37), (66, -32), (77, -26), (78, -21),
      (66, -22), (52, -25), (38, -24), (27, -18), (17, -8)], 3.2),
    # summit path from the chalet to the cross
    ([(17, -4), (25, -1), (33, 0), (39, -3)], 2.0),
    # the stair up the escarpment from the foot (Peel street's stair) to the
    # terrace's west end
    ([(-8, -76), (-5, -60), (-9, -47), (-3, -36), (-6, -27), (-4, -19)], 2.0),
    # from the chalet's west end over the saddle to the lake
    ([(-5, -3), (-12, 2), (-18, 6), (-22, 8)], 2.2),
    # the lake path, from the west foot along Westmount's front to the lake
    ([(-116, -6), (-98, -10), (-82, -15), (-66, -15), (-50, -8), (-40, 2), (-37, 8)], 2.4),
    # round Beaver Lake
    ([(-30, 24), (-20, 20), (-19, 8), (-29, 2), (-41, 6), (-41, 18), (-30, 24)], 1.8),
    # from the north foot (Outremont) over the back slope to the lake
    ([(-8, 90), (-2, 72), (-12, 56), (-6, 42), (-18, 30), (-26, 24)], 2.2),
]


def catmull(pts, step=3.0):
    out = []
    P = [pts[0]] + list(pts) + [pts[-1]]
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = (np.array(P[j], dtype=float) for j in (i - 1, i, i + 1, i + 2))
        n = max(2, int(np.linalg.norm(p2 - p1) / step))
        for k in range(n):
            t = k / n
            t2, t3 = t * t, t * t * t
            q = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
            out.append(q)
    out.append(np.array(pts[-1], dtype=float))
    return out


PATH_PTS = [(catmull(p), w) for p, w in PATHS]
PATH_ARR = np.concatenate([np.array(p) for p, _ in PATH_PTS])
PATH_W = np.concatenate([np.full(len(p), w) for p, w in PATH_PTS])


def path_clear(x, y):
    """Distance to the nearest path's EDGE (negative on the path)."""
    d = np.hypot(PATH_ARR[:, 0] - x, PATH_ARR[:, 1] - y) - PATH_W / 2
    return float(d.min())


# ── the open meadows: crisp-edged drapes ─────────────────────────────────────
# Iteration 2 painted the clearings into the terrain's vertex tones: across
# its ~10-unit triangles a pale meadow tone faded out over a whole triangle
# into the dark woods — a soft, round, pale disc with no edge, which read as
# a glassy translucent dome round the chalet (tp6-final-dpr1/
# city-mont-royal.png ~880-960,480-600; the lit gain was ruled out: with the
# cross at gain 1.0 the disc stayed, tp7-montroyal3-gain1). The meadows are
# their own draped polygons with a hard outline.

CROSS_AT = None  # the summit, found on the terrain


def meadow_shapes():
    cx, cy, _ = CROSS_AT
    return [
        # the summit meadow round the cross, reaching west toward the path
        # (8.5 left the summit a bald dome under the cross, tp7-final-dpr1)
        ((cx - 1.5, cy + 0.5), lambda a: 5.8 * (1 + 0.13 * math.sin(3 * a + 0.5) + 0.07 * math.sin(5 * a + 2.1)
                                                   + 0.18 * math.exp(-(_wrap(a - math.pi) / 0.6) ** 2)), 0.0),
        # the chalet's lawn: a rounded rectangle round the chalet and terrace
        ((CHALET[0], (CHALET[1] + BELV[1]) / 2 + 1.5), lambda a: _superellipse(a, 14.0, 9.0, 4.0), 0.0),
        # the lake's shore meadow (the lake itself drawn on top)
        (LAKE, lambda a: (LAKE_R + 5.0) * (1 + 0.08 * math.sin(3 * a + 1.0)), 0.0),
    ]


def _superellipse(a, hx, hy, p):
    c, s = abs(math.cos(a)), abs(math.sin(a))
    return 1.0 / (((c / hx) ** p + (s / hy) ** p) ** (1.0 / p))


def in_meadow(x, y, margin=0.0):
    """How far inside the nearest meadow outline a point lies (> 0 inside)."""
    best = -1e9
    for (mx, my), rad, _ in MEADOWS:
        a = math.atan2(y - my, x - mx)
        best = max(best, rad(a) - math.hypot(x - mx, y - my) - margin)
    return best


MEADOWS = None


def build_meadows(m):
    """Each meadow as a fan draped 0.3 over the terrain: rings close enough
    that a chord never dips under the summit's crown."""
    for (mx, my), rad, _ in MEADOWS:
        seg = 18
        fr = [0.0, 0.3, 0.6, 0.8, 1.0]
        rings = []
        for f in fr:
            if f == 0.0:
                rings.append([m.v((mx, my, ground_z(mx, my) + 0.3))] * seg)
                continue
            ring = []
            for k in range(seg):
                a = 2 * math.pi * k / seg
                x, y = mx + f * rad(a) * math.cos(a), my + f * rad(a) * math.sin(a)
                ring.append(m.v((x, y, ground_z(x, y) + 0.3)))
            rings.append(ring)

        def tone(v):
            x, y = v.co.x, v.co.y
            return MEADOW * (0.95 + 0.1 * RNG.random()) * (1 + 0.45 * (hillshade(x, y) - 1))

        tones = [[tone(v) for v in ring] for ring in rings]
        for i in range(len(rings) - 1):
            for k in range(seg):
                k2 = (k + 1) % seg
                if i == 0:
                    m.face((rings[0][k], rings[1][k], rings[1][k2]), [tones[0][k], tones[1][k], tones[1][k2]])
                else:
                    m.face((rings[i][k], rings[i + 1][k], rings[i + 1][k2], rings[i][k2]),
                           [tones[i][k], tones[i + 1][k], tones[i + 1][k2], tones[i][k2]])


def find_summit():
    best = (-1.0, 0.0, 0.0)
    sx, sy = CROIX
    for dx in np.linspace(-10, 10, 41):
        for dy in np.linspace(-10, 10, 41):
            z = ground_z(sx + dx, sy + dy)
            if z > best[0]:
                best = (z, sx + dx, sy + dy)
    return best[1], best[2], best[0]


ROCK_SLOPE = 1.9        # the slope where bare rock starts to show …
TREELESS_SLOPE = 2.6    # … and where no crown holds any more


def clearing(x, y):
    """Where no crown grows: the meadows, the belvedere, the lookout, the
    lake, the steepest rock (the escarpment's face)."""
    if in_meadow(x, y) > -1.0:
        return "meadow"
    if math.hypot(x - BELV[0], y - BELV[1]) < BELV_R + 3:
        return "shelf"
    if math.hypot(x - LOOKOUT[0], y - LOOKOUT[1]) < LOOKOUT_R + 2.5:
        return "lookout"
    s = slope(x, y)
    if s > TREELESS_SLOPE or (s > 1.7 and esc_band(x, y) > 0.75):
        return "cliff"
    return None


# The engine's key light (lit/lighting.ts: azimuth -55°, elevation 38°, in
# three's frame (cos el sin az, sin el, cos el cos az)), carried into this
# asset's frame: the engine yaws the maquette +40° (backgrounds.ts
# MONT_ROYAL_YAW), so undo that yaw, then three (x, y, z) -> Blender
# (x, -z, y).
def _key_light():
    az, el, yaw = math.radians(-55), math.radians(38), math.radians(-40)
    lx, ly, lz = math.cos(el) * math.sin(az), math.sin(el), math.cos(el) * math.cos(az)
    x2 = lx * math.cos(yaw) + lz * math.sin(yaw)
    z2 = -lx * math.sin(yaw) + lz * math.cos(yaw)
    return np.array([x2, -z2, ly])


KEY = _key_light()


def hillshade(x, y, e=3.0):
    """Baked relief: a crown takes the light its SLOPE would get, relative to
    flat ground (1). Every crown's own dome faces up, so under the engine's
    light a forested slope away from the sun shaded exactly like one toward
    it, and from the iso camera the mountain read flat (tp5-montroyal-m2/
    city-mont-royal.png). The city bakes its own sun ramp the same way. The
    floor is 0.72, not 0.62: the deepest shade read as dark blotches on the
    back slopes (montroyal4)."""
    gx, gy = grad(x, y, e)
    n = np.array([-gx, -gy, 1.0])
    n /= np.linalg.norm(n)
    shade = float(np.dot(n, KEY)) / KEY[2]
    return min(1.2, max(0.72, 1 + 0.55 * (shade - 1)))


# ── slow noise: the fields the woods are drawn from ─────────────────────────

_NPH = RNG.random((6, 4)) * 2 * math.pi


def noise(x, y, k, f=1.0):
    """A smooth pseudo-noise in about [-1, 1], wavelengths ~50-110 units at
    f = 1: one field per k (species, hue, groves …)."""
    p = _NPH[k]
    a = math.sin(0.061 * f * x + 0.023 * f * y + p[0]) * math.cos(0.052 * f * y - 0.017 * f * x + p[1])
    b = math.sin(0.113 * f * x - 0.087 * f * y + p[2]) * math.cos(0.071 * f * x + 0.094 * f * y + p[3])
    return 0.75 * a + 0.55 * b


# ── the woods: a planned list, then its crowns ──────────────────────────────
# The trees are PLANNED first (where, which species, how big, which tone),
# so the terrain under them can take their colour; then each is built.

def elevation(x, y):
    return (ground_z(x, y) - LAWN_H) / max(1.0, CROSS_AT[2] - LAWN_H)


def exposure(x, y):
    """-1 a slope turned from the key light … +1 one turned to it."""
    return max(-1.0, min(1.0, (hillshade(x, y) - 1.0) / 0.16))


def summit_near(x, y):
    """1 on a summit top, falling to 0 a dozen units away (the summit
    meadows the woods thin toward)."""
    cx, cy, _ = CROSS_AT
    best = 0.0
    for (sx, sy), rr in (((cx, cy), 12.0), (OUTREMONT, 9.0), (WESTMOUNT, 9.0)):
        best = max(best, smoothstep(rr, rr * 0.4, math.hypot(x - sx, y - sy)))
    return best


def maple_hue(x, y, e, expo, back, t):
    """Where on the leaf ramp a maple stands: greens at the foot, reds and
    oranges on the slopes, golds up high; redder on the sunny faces, yellower
    on the cool back slope; a slow noise and a per-tree spread so no slope is
    one colour."""
    h = 0.22 + (0.72 - 0.22) * smoothstep(0.03, 0.30, e)
    h = h + (0.47 - h) * smoothstep(0.58, 0.92, e)
    h += 0.07 * expo - 0.10 * back
    h += 0.15 * noise(x, y, 1) + 0.07 * noise(x, y, 2, 2.6)
    h += 0.30 * (RNG.random() - 0.5)
    if t > 1.0:  # the park's own trees, on the lawn: any October tone
        h = 0.08 + 0.85 * RNG.random()
    return h


def pick_kind(x, y, e, back, t):
    pc = 0.05 + 0.30 * smoothstep(0.45, 0.95, e) + 0.14 * back + 0.10 * noise(x, y, 3)
    pc = min(0.5, max(0.03, pc if t < 0.9 else min(pc, 0.2)))
    pb = 0.04 + 0.11 * smoothstep(0.3, 0.85, e) + 0.05 * noise(x, y, 4)
    pb = min(0.18, max(0.02, pb))
    u = RNG.random()
    if u < pc:
        return "conifer"
    if u < pc + pb:
        return "birch"
    return "maple"


def plan_woods(budget):
    """Dart-throwing over the massif and the park ring round its foot. A
    dart's size, species and tone come from the place; its acceptance from
    a density that is full on the slopes, thins over the foothills (groves
    by a slow noise) and frays out over the lawn to PARK_R (the city's own
    park trees take over past it), thinner near the summits and on the back
    slope (the iso camera's far side), never on a path, a meadow or the
    escarpment's rock. Crowns overlap (spacing 0.6 × the two radii, in PLAN,
    divided by the slope's stretch sqrt(1 + s^2)): a small crown tucks in
    between two big ones and a conifer pokes up through them."""
    trees = []
    placed = np.zeros((0, 3))
    tris = 0
    tries = 0
    while tries < 150000 and tris < budget - 21:
        tries += 1
        a = RNG.random() * 2 * math.pi
        f = foot(a)
        if RNG.random() < 0.07:
            if f * 1.0 >= PARK_R:
                continue
            d = math.sqrt(f * f + RNG.random() * (PARK_R * PARK_R - f * f))
        else:
            # biased toward the core (u^0.7, not the area-uniform sqrt): with
            # the budget spent before the slopes filled, the upper faces were
            # left sparse (tp8-montroyal4-m4/city-mont-royal-low.png)
            d = RNG.random() ** 0.7 * f
        x, y = d * math.cos(a), d * math.sin(a)
        t = d / f
        sd, _ = spine_d(x, y)
        back = smoothstep(8.0, 40.0, sd)
        e = elevation(x, y) if t < 1 else 0.0
        sn = summit_near(x, y) if t < 1 else 0.0
        # the density: full on the slopes, thinning over the foothills to a
        # scatter of groves on the lawn (no forest EDGE: montroyal4's woods
        # stopped at 0.93 of the foot in a hard ring)
        grove = 0.5 + 0.5 * noise(x, y, 5, 2.2)
        dens = 1.0 if t < 0.6 else (1.0 - 0.85 * smoothstep(0.6, 1.0, t)) * (0.5 + 1.0 * grove)
        if t >= 1.0:
            dens = 0.10 + 0.45 * max(0.0, grove - 0.35)
        # the back slope past the crest is mostly hidden from the iso camera:
        # thin it so the triangles go to the faces that are seen (montroyal4
        # m1: the downtown face's upper slopes were bare ground between
        # sparse crowns)
        far = smoothstep(14.0, 40.0, sd)
        dens *= (1.0 - 0.15 * sn) * (1.0 - 0.15 * back) * (1.0 - 0.5 * far)
        if RNG.random() > dens:
            continue
        if t < 1.0 and clearing(x, y) is not None:
            continue
        kind = pick_kind(x, y, e, back, t)
        # sizes: many small, a few big; smaller up high, bigger on the
        # lower slopes (montroyal4: every crown 4.6-7.4 across)
        big = (1.06 - 0.22 * smoothstep(0.3, 0.95, e)) if t < 1.0 else 0.72
        u = RNG.random()
        if kind == "maple":
            r = (3.2 + 5.2 * u ** 1.2) * big
            form = "oval" if RNG.random() < 0.28 else ("spread" if RNG.random() < 0.3 else "round")
            cr = r
        elif kind == "conifer":
            r = (1.5 + 1.6 * u) * (0.9 + 0.2 * big)
            form = "tall"
            cr = r
        else:
            r = (2.0 + 1.2 * u) * big
            form = "birch"
            cr = 0.72 * r
        # keep the trees in front of (below) the terrace short: the chalet
        # and its lookout stay in view from the city
        if y < BELV[1] and abs(x - BELV[0]) < 24 and y > BELV[1] - 26:
            r *= 0.72
            cr *= 0.72
        if path_clear(x, y) < 0.55 * cr + 0.6:
            continue
        if len(placed):
            stretch = math.sqrt(1 + min(1.6, slope(x, y)) ** 2) if t < 1 else 1.0
            k = 0.45 if kind == "conifer" else 0.56
            dd = np.hypot(placed[:, 0] - x, placed[:, 1] - y) - k * (placed[:, 2] + cr) / stretch
            if dd.min() < 0:
                continue
        if kind == "maple":
            tone = leaf_tone(maple_hue(x, y, e, exposure(x, y), back, t)) * (0.94 + 0.12 * RNG.random())
            n = 4 if r < 4.4 else (5 if r < 6.6 else 6)
            cost = 3 * n
        elif kind == "conifer":
            tone = EVERGREEN[int(RNG.random() * len(EVERGREEN))] * (0.9 + 0.25 * RNG.random())
            n = 3 if r > 2.5 else 2
            cost = 5 * n
        else:
            tone = BIRCH_GOLD[int(RNG.random() * len(BIRCH_GOLD))] * (0.94 + 0.12 * RNG.random())
            n = 4
            cost = 18
        if tris + cost > budget:
            break
        placed = np.vstack([placed, [x, y, cr]])
        trees.append({"kind": kind, "x": x, "y": y, "r": r, "cr": cr, "form": form, "n": n, "tone": tone, "t": t})
        tris += cost
    counts = {}
    for tr in trees:
        counts[tr["kind"]] = counts.get(tr["kind"], 0) + 1
    sizes = np.array([tr["cr"] for tr in trees])
    print(f"[mont-royal] woods: {counts}  {tris} tris  ({tries} darts); crown radius "
          f"p10 {np.percentile(sizes, 10):.1f} p50 {np.percentile(sizes, 50):.1f} p90 {np.percentile(sizes, 90):.1f}; "
          f"{sum(1 for tr in trees if tr['t'] >= 1)} on the lawn")
    return trees


def broadleaf(m, tr):
    """A broadleaf crown: a sunk base ring, a bulging shoulder and a domed
    top — 4 to 6 sides by size (3n triangles), the underside darker (the
    only contact shade there is). Three forms: round, a tall oval (a sugar
    maple) and a low spreading dome (an oak); height, shoulder and lean
    vary per tree so no two crowns are the same blob."""
    x, y, r, n, tone = tr["x"], tr["y"], tr["r"], tr["n"], tr["tone"]
    z0 = max(0.0, ground_z(x, y) - 0.25 * r)  # never under the street (the city seats every part on it)
    form = tr["form"]
    if form == "oval":
        hc, wr, shoulder = r * (1.5 + 0.4 * RNG.random()), 0.86, 0.38 + 0.1 * RNG.random()
    elif form == "spread":
        hc, wr, shoulder = r * (0.72 + 0.2 * RNG.random()), 1.0, 0.5 + 0.1 * RNG.random()
    else:
        hc, wr, shoulder = r * (0.95 + 0.35 * RNG.random()), 1.0, 0.42 + 0.16 * RNG.random()
    ph = RNG.random() * 6.283
    jit = [0.8 + 0.4 * RNG.random() for _ in range(n)]
    base = [m.v((x + r * wr * 0.76 * jit[k] * math.cos(ph + 6.283 * k / n),
                 y + r * wr * 0.76 * jit[k] * math.sin(ph + 6.283 * k / n), z0)) for k in range(n)]
    sh = [m.v((x + r * wr * jit[k] * math.cos(ph + 6.283 * (k + 0.5) / n),
               y + r * wr * jit[k] * math.sin(ph + 6.283 * (k + 0.5) / n), z0 + hc * (shoulder + 0.08 * RNG.random())))
          for k in range(n)]
    top = m.v((x + (RNG.random() - 0.5) * 0.4 * r, y + (RNG.random() - 0.5) * 0.4 * r, z0 + hc))
    v = (0.93 + 0.14 * RNG.random()) * hillshade(x, y)
    lo, mid, hi = tone * 0.72 * v, tone * 0.98 * v, tone * 1.08 * v
    for k in range(n):
        k2 = (k + 1) % n
        m.face((base[k], base[k2], sh[k]), [lo, lo, mid])
        m.face((sh[k], base[k2], sh[k2]), [mid, lo, mid])
        m.face((sh[k], sh[k2], top), [mid, mid, hi])


def conifer(m, tr):
    """A dark evergreen spire: two or three stacked 5-sided cones (10 or 15
    triangles), tall and pointed — a different silhouette from every
    broadleaf."""
    x, y, r, tone = tr["x"], tr["y"], tr["r"], tr["tone"]
    z0 = max(0.0, ground_z(x, y) - 0.3 * r)
    v = (0.92 + 0.16 * RNG.random()) * hillshade(x, y)
    hgt = r * (3.1 + 1.0 * RNG.random())
    tiers = ((r, 0.0, 0.5 * hgt), (0.74 * r, 0.3 * hgt, 0.78 * hgt), (0.46 * r, 0.58 * hgt, hgt)) if tr["n"] == 3 \
        else ((r, 0.0, 0.62 * hgt), (0.6 * r, 0.4 * hgt, hgt))
    for (rr, zb, zt) in tiers:
        n = 5
        ph = RNG.random() * 6.283
        ring = [m.v((x + rr * math.cos(ph + 6.283 * k / n), y + rr * math.sin(ph + 6.283 * k / n), z0 + zb)) for k in range(n)]
        apex = m.v((x, y, z0 + zt))
        for k in range(n):
            m.face((ring[k], ring[(k + 1) % n], apex), [tone * 0.6 * v, tone * 0.6 * v, tone * 1.22 * v])


def trunk(m, x, y, z0, z1, w, rgb):
    """A 3-sided trunk (6 triangles)."""
    ph = RNG.random() * 6.283
    lo = [m.v((x + w * math.cos(ph + 2.094 * k), y + w * math.sin(ph + 2.094 * k), z0)) for k in range(3)]
    hi = [m.v((x + 0.7 * w * math.cos(ph + 2.094 * k), y + 0.7 * w * math.sin(ph + 2.094 * k), z1)) for k in range(3)]
    for k in range(3):
        k2 = (k + 1) % 3
        m.face((lo[k], lo[k2], hi[k2], hi[k]), [rgb * 0.8, rgb * 0.8, rgb, rgb])


def birch(m, tr):
    """A paper birch: a slender white trunk under a narrow, tall gold crown
    (4 sides; 18 triangles in all)."""
    x, y, r, tone = tr["x"], tr["y"], tr["r"], tr["tone"]
    g = ground_z(x, y)
    hs = hillshade(x, y)
    trunk(m, x, y, max(0.0, g - 0.2), g + 1.3 * r, 0.16 * r + 0.2, BIRCH_BARK * hs)
    n = 4
    ph = RNG.random() * 6.283
    v = (0.93 + 0.14 * RNG.random()) * hs
    zc = g + 0.9 * r
    hc = r * (1.9 + 0.5 * RNG.random())
    w = 0.72 * r
    base = [m.v((x + w * 0.55 * math.cos(ph + 6.283 * k / n), y + w * 0.55 * math.sin(ph + 6.283 * k / n), zc)) for k in range(n)]
    sh = [m.v((x + w * math.cos(ph + 6.283 * (k + 0.5) / n), y + w * math.sin(ph + 6.283 * (k + 0.5) / n), zc + hc * 0.42))
          for k in range(n)]
    top = m.v((x, y, zc + hc))
    lo, mid, hi = tone * 0.72 * v, tone * 0.98 * v, tone * 1.08 * v
    for k in range(n):
        k2 = (k + 1) % n
        m.face((base[k], base[k2], sh[k]), [lo, lo, mid])
        m.face((sh[k], base[k2], sh[k2]), [mid, lo, mid])
        m.face((sh[k], sh[k2], top), [mid, mid, hi])


def build_canopy(m, trees):
    for tr in trees:
        if tr["kind"] == "conifer":
            conifer(m, tr)
        elif tr["kind"] == "birch":
            birch(m, tr)
        else:
            broadleaf(m, tr)


# ── the terrain mesh ─────────────────────────────────────────────────────────

TERRAIN_SEG = 64
TERRAIN_FRACS = [0.0, 0.05, 0.1, 0.15, 0.2, 0.26, 0.32, 0.38, 0.44, 0.5, 0.56, 0.62, 0.68, 0.74,
                 0.8, 0.86, 0.92, 0.97, 1.0, SKIRT]


def terrain_tris():
    return TERRAIN_SEG + 2 * TERRAIN_SEG * (len(TERRAIN_FRACS) - 2)


class FloorField:
    """The ground's colour under the woods: the crowns' own tones, in shade,
    weighted by how near and how big each crown is — so a gap between two
    red crowns is a deeper red, not a brown hole (montroyal4: litter lanes
    and a #5E4A30 floor read as dark brown blotches between the stands)."""

    def __init__(self, trees):
        self.xy = np.array([[tr["x"], tr["y"]] for tr in trees])
        self.r = np.array([tr["cr"] for tr in trees])
        cols = []
        for tr in trees:
            c = np.array(tr["tone"], dtype=float)
            if tr["kind"] == "conifer":
                c = c * 1.45   # a conifer's floor: needles, not a black hole
            cols.append(c)
        self.c = np.array(cols)

    def at(self, x, y):
        d2 = (self.xy[:, 0] - x) ** 2 + (self.xy[:, 1] - y) ** 2
        w = np.exp(-d2 / (1.25 * self.r) ** 2)
        s = float(w.sum())
        if s < 1e-4:
            return None, 0.0
        return (w[:, None] * self.c).sum(0) / s, min(1.0, s)


def build_terrain(m, trees):
    """Polar heightfield, smooth-shaded (72 bearings × 19 rings), out to the
    lobed foot, then the park's lawn skirt sloping under the city's lawn pads
    (flag 1: UP normals after the join; the terrain is flag 2, its normals
    bent to UP over the foothills' last 18 %). Vertex tones: the crowns'
    shaded colour where the woods are, dry grass between sparse trees, the
    city's lawn toward the foot (and exactly it from 0.96 out), meadow under
    the drapes, rock on the escarpment's face. The baked relief here is a
    third of the crowns' (the engine lights the terrain's own normals; a full
    bake on top shaded it twice, the dome's glassy look), and it fades out
    with the lawn."""
    floor = FloorField(trees)
    SEG = TERRAIN_SEG
    rings = []
    for f in TERRAIN_FRACS:
        if f == 0.0:
            z = ground_z(0.0, 0.0)
            rings.append([(m.v((0.0, 0.0, z)), (0.0, 0.0))] * SEG)
            continue
        ring = []
        for k in range(SEG):
            a = 2 * math.pi * k / SEG
            r = f * foot(a)
            x, y = r * math.cos(a), r * math.sin(a)
            ring.append((m.v((x, y, ground_z(x, y))), (x, y)))
        rings.append(ring)

    def tone(x, y):
        t = foot_t(x, y)
        if t > 0.96:
            return LAWN
        lawnish = smoothstep(0.55, 0.95, t)
        open_ = OPEN + (LAWN - OPEN) * lawnish
        if in_meadow(x, y, margin=2.0) > 0:
            base = MEADOW * 0.92   # hidden under the drape; only its rim shows
        else:
            c, dens = floor.at(x, y)
            # the crowns' tone in shade, half-way to the open ground's: a
            # full-strength crown tone on the floor glowed round every
            # sparse tree like a halo (montroyal4 it1 preview), and at 0.62
            # the bare upper slopes read as an orange-brown mound in the app
            # (tp8-montroyal4-m1/city-mont-royal.png)
            # (0.45 / 0.45 still read tan under the orange crowns,
            # tp8-montroyal4-m3: the floor leans to the grass now)
            shade = c * 0.3 + open_ * 0.55
            base = open_ if c is None else open_ + (shade - open_) * (0.8 * dens * (1 - 0.85 * lawnish))
            base = base * (0.96 + 0.08 * RNG.random())
        s = slope(x, y)
        rock = 0.85 * smoothstep(ROCK_SLOPE, TREELESS_SLOPE + 0.3, s) * (1 - lawnish)
        # the escarpment's face reads as a grey limestone band (an olive
        # smooth face under the belvedere read as one more bare slope,
        # tp8-montroyal4-m4/city-mont-royal-low.png)
        rock = max(rock, 0.7 * esc_band(x, y) * smoothstep(1.2, 1.9, s))
        rk = ROCK if s < 2.2 else ROCK_DARK
        hs = 1 + 0.33 * (1 - lawnish) * (hillshade(x, y) - 1)
        return (base * (1 - rock) + rk * rock) * hs

    tones = [[tone(x, y) for (_, (x, y)) in ring] for ring in rings]
    last = len(rings) - 2
    for i in range(len(rings) - 1):
        for k in range(SEG):
            k2 = (k + 1) % SEG
            a, b = rings[i][k][0], rings[i][k2][0]
            c, d = rings[i + 1][k2][0], rings[i + 1][k][0]
            if i == 0:
                m.face((a, d, c), [tones[0][k], tones[1][k], tones[1][k2]], ground=2)
            else:
                m.face((a, d, c, b), [tones[i][k], tones[i + 1][k], tones[i + 1][k2], tones[i][k2]],
                       ground=1 if i == last else 2)


def build_paths(m):
    """Gravel ribbons laid 0.45 over the terrain (over the meadow drapes too;
    crowns keep clear of them)."""
    for pts, w in PATH_PTS:
        left, right = [], []
        for i, p in enumerate(pts):
            q0 = pts[max(0, i - 1)]
            q1 = pts[min(len(pts) - 1, i + 1)]
            t = q1 - q0
            t = t / (np.linalg.norm(t) + 1e-9)
            n = np.array([-t[1], t[0]])
            for side, lst in ((1, left), (-1, right)):
                x, y = p + n * side * w / 2
                tt = foot_t(x, y)
                if tt > 1.02:  # the paths run out onto the park lawn, no farther
                    x, y = x * 1.02 / tt, y * 1.02 / tt
                lst.append(m.v((x, y, ground_z(x, y) + 0.45)))
        for i in range(len(pts) - 1):
            shade = GRAVEL * (0.95 + 0.05 * math.sin(i * 0.7))
            m.face((left[i], right[i], right[i + 1], left[i + 1]), shade)


def build_lake(m):
    """Beaver Lake: an irregular pool on the atlas's glossy water texel."""
    n = 16
    z = LAKE_H + LAWN_H + 0.6
    c = m.v((LAKE[0], LAKE[1], z))
    ring = []
    for k in range(n):
        a = 2 * math.pi * k / n
        r = LAKE_R * (1 + 0.16 * math.sin(3 * a + 0.6) + 0.08 * math.cos(5 * a))
        ring.append(m.v((LAKE[0] + r * math.cos(a), LAKE[1] + r * math.sin(a), z)))
    for k in range(n):
        m.face((c, ring[k], ring[(k + 1) % n]), [WATER * 1.06, WATER * 0.86, WATER * 0.86], uv=UV_WATER)


# ── the escarpment rocks and the outcrops ───────────────────────────────────

def build_rocks(m):
    """Faceted limestone ledges strung along the escarpment's face (a crest
    row on its lip and a lower staggered row), and rock OUTCROPS on the
    other steep faces — Croix's east face, Westmount's front, Outremont's
    shoulder. Each slab hugs the slope: its top a little proud of the
    UPHILL ground, its face down to the downhill ground, so the face is the
    slope's own drop, never a column (montroyal-1/mont-royal-front.png: a
    13-unit stone bastion)."""
    for x0 in np.arange(-24.0, 70.0, 5.5):
        for row, (dy, proud) in enumerate(((1.2, 0.1), (-3.8, 0.3))):
            if RNG.random() < 0.3:
                continue
            x = x0 + (RNG.random() - 0.5) * 3.0
            y = esc_y(x) + dy + (RNG.random() - 0.5) * 1.6
            if path_clear(x, y) < 3.0 or abs(x - BELV[0]) < BELV_R + 1.0 and row == 0:
                continue
            nx, ny = downhill(x, y)
            build_rock(m, x, y, nx, ny, 1.2 + RNG.random() * 1.4, 0.9 + RNG.random() * 0.8, proud)
    for (ox, oy, k) in ((66, -8, 2), (72, -2, 2), (-58, -12, 3), (-70, -8, 2),
                        (8, 36, 2), (-46, -2, 2), (50, 10, 2)):
        for j in range(k):
            x = ox + (RNG.random() - 0.5) * 7
            y = oy + (RNG.random() - 0.5) * 7
            if path_clear(x, y) < 2.5:
                continue
            nx, ny = downhill(x, y)
            build_rock(m, x, y, nx, ny, 1.3 + RNG.random() * 1.4, 1.0 + RNG.random() * 0.8, 0.5)


def build_rock(m, cx, cy, nx, ny, hw, dp, proud):
    tx, ty = -ny, nx                          # along the contour
    top = ground_z(cx - nx * dp, cy - ny * dp) + proud + RNG.random() * 0.6
    bot = max(0.0, ground_z(cx + nx * (dp + 1.2), cy + ny * (dp + 1.2)) - 0.8)
    corners = []
    # (along, out) — (t, n) is a LEFT-handed pair in plan, so this order
    # runs counter-clockwise seen from above: every side faces outward
    for (s, o) in ((-1, -1), (-1, 1), (1, 1), (1, -1)):
        jx = (RNG.random() - 0.5) * 0.8
        px = cx + tx * s * hw + nx * o * dp + jx
        py = cy + ty * s * hw + ny * o * dp + jx
        corners.append((px, py))
    lo = [m.v((px, py, bot)) for px, py in corners]
    # the downhill top edge (corners 1, 2) drops a little: a ledge tilted
    # with the slope, its face leaning back, the top drawn in toward the
    # slab's middle and uphill: a weathered, leaning slab, not a stone
    # column (montroyal-9 chalet close-up: square-topped pillars read as a
    # castle wall)
    hi = [m.v((px - nx * 0.9 - (px - cx) * 0.22, py - ny * 0.9 - (py - cy) * 0.22,
               top - (0.5 + 0.8 * RNG.random() if 1 <= k <= 2 else 0)))
          for k, (px, py) in enumerate(corners)]
    t = 0.9 + 0.2 * RNG.random()
    face_t, side_t, top_t = ROCK * t, ROCK_DARK * t, ROCK * 1.12 * t
    for k in range(4):
        k2 = (k + 1) % 4
        col = face_t if k == 1 else side_t  # side 1 is the downhill face
        m.face((lo[k], lo[k2], hi[k2], hi[k]), col)
    m.face((hi[0], hi[1], hi[2], hi[3]), top_t)


# ── the chalet, the belvedere and the lookout ───────────────────────────────

def box(m, x0, x1, y0, y1, z0, z1, rgb, top=None, uv=UV_PLAIN, caps=True):
    v = [m.v((x, y, z)) for z in (z0, z1) for (x, y) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
    sides = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    for s in sides:
        m.face([v[i] for i in s], rgb, uv=uv)
    if caps:
        m.face([v[4], v[5], v[6], v[7]], top if top is not None else rgb, uv=uv)
    return v


def build_chalet(m):
    """The Chalet du Mont-Royal (1932): a long limestone hall under a broad
    hipped red-brown roof, five tall arched windows on the downtown face,
    behind the Kondiaronk belvedere's half-moon terrace and its balustrade —
    the lookout over the city."""
    cx, cy = CHALET
    z0 = SHELF_H + LAWN_H - 2.0
    zt = SHELF_H + LAWN_H + 7.0
    hx, hy = CHALET_W / 2, CHALET_D / 2
    box(m, cx - hx, cx + hx, cy - hy, cy + hy, z0, zt, STONE)
    # the cornice band
    box(m, cx - hx - 0.35, cx + hx + 0.35, cy - hy - 0.35, cy + hy + 0.35, zt - 0.6, zt, STONE_SHADE, caps=False)
    # five arched windows, proud of the downtown face
    zf = SHELF_H + LAWN_H + 0.4
    for i in range(5):
        wx = cx - hx + CHALET_W * (i + 0.5) / 5
        ww = 1.25
        a = m.v((wx - ww, cy - hy - 0.06, zf))
        b = m.v((wx + ww, cy - hy - 0.06, zf))
        # a ROUND arch (the chalet's tall arched bays; one apex vertex read
        # as a Gothic point, montroyal-9/mont-royal-chalet.png)
        arc = [m.v((wx + ww * math.cos(math.pi * j / 4), cy - hy - 0.06, zf + 3.9 + ww * math.sin(math.pi * j / 4)))
               for j in range(5)]
        m.face([a, b] + arc, WINDOW)
    # the hipped roof
    rz = 5.2
    ins = 4.4
    p = [m.v((x, y, zt)) for (x, y) in ((cx - hx - 0.7, cy - hy - 0.7), (cx + hx + 0.7, cy - hy - 0.7),
                                         (cx + hx + 0.7, cy + hy + 0.7), (cx - hx - 0.7, cy + hy + 0.7))]
    q = [m.v((cx - hx + ins, cy, zt + rz)), m.v((cx + hx - ins, cy, zt + rz))]
    m.face((p[0], p[1], q[1], q[0]), ROOF * 1.1)
    m.face((p[2], p[3], q[0], q[1]), ROOF * 0.88)
    m.face((p[1], p[2], q[1]), ROOF)
    m.face((p[3], p[0], q[0]), ROOF)
    # the belvedere: a half-moon terrace of pale stone over the escarpment
    bx, by = BELV
    zb = SHELF_H + LAWN_H + 0.4
    n = 14
    c = m.v((bx, by + 1.0, zb))
    rim = []
    for k in range(n + 1):
        a = math.pi + math.pi * k / n  # the half toward -Y
        rim.append(m.v((bx + BELV_R * math.cos(a), by + 1.0 + BELV_R * math.sin(a), zb)))
    for k in range(n):
        m.face((c, rim[k], rim[k + 1]), STONE * (0.96 if k % 2 else 1.0))
    # the terrace's straight back edge up to the chalet front
    back = [m.v((bx - BELV_R, by + 1.0, zb)), m.v((bx + BELV_R, by + 1.0, zb)),
            m.v((bx + BELV_R, cy - hy, zb)), m.v((bx - BELV_R, cy - hy, zb))]
    m.face(back, STONE * 0.97)
    parapet_and_wall(m, bx, by + 1.0, BELV_R, math.pi, n, zb)


def parapet_and_wall(m, bx, by, rad, a_start, n, zb):
    """A low balustrade round a half-moon (from a_start, half a turn) and its
    retaining wall dropping to the ground below it."""
    for k in range(n):
        a0 = a_start + math.pi * k / n
        a1 = a_start + math.pi * (k + 1) / n
        pts = []
        for rr in (rad, rad - 0.45):
            for a in (a0, a1):
                pts.append((bx + rr * math.cos(a), by + rr * math.sin(a)))
        lo = [m.v((x, y, zb - 0.1)) for x, y in pts]
        hi = [m.v((x, y, zb + 0.95)) for x, y in pts]
        m.face((lo[0], lo[1], hi[1], hi[0]), STONE_SHADE)          # outer face
        m.face((hi[0], hi[1], hi[3], hi[2]), STONE * 1.05)         # coping
        m.face((lo[3], lo[2], hi[2], hi[3]), STONE)                # inner face
        p0, p1 = pts[0], pts[1]
        g0 = min(ground_z(*p0), zb) - 1.2
        g1 = min(ground_z(*p1), zb) - 1.2
        m.face((m.v((p0[0], p0[1], g0)), m.v((p1[0], p1[1], g1)), m.v((p1[0], p1[1], zb - 0.1)), m.v((p0[0], p0[1], zb - 0.1))),
               STONE_SHADE * 0.92)


def build_lookout(m):
    """A small stone lookout on the Olmsted road's upper bend: a half-moon
    pad facing out over the east foot, level with the road, its parapet and
    its retaining wall (~70 triangles)."""
    lx, ly = LOOKOUT
    zb = ground_z(lx, ly) + 0.55
    n = 7
    a_start = LOOKOUT_FACE - math.pi / 2
    c = m.v((lx, ly, zb))
    rim = [m.v((lx + LOOKOUT_R * math.cos(a_start + math.pi * k / n), ly + LOOKOUT_R * math.sin(a_start + math.pi * k / n), zb))
           for k in range(n + 1)]
    for k in range(n):
        m.face((c, rim[k], rim[k + 1]), STONE * (0.95 if k % 2 else 1.0))
    parapet_and_wall(m, lx, ly, LOOKOUT_R, a_start, n, zb)


# ── the cross ────────────────────────────────────────────────────────────────

def member(m, p0, p1, t, rgb, caps=False, uv=UV_LIT):
    """A square-section member from p0 to p1, `t` across."""
    p0 = np.array(p0, dtype=float)
    p1 = np.array(p1, dtype=float)
    ax = p1 - p0
    ax /= np.linalg.norm(ax)
    ref = np.array([0.0, 0.0, 1.0]) if abs(ax[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(ax, ref)
    u /= np.linalg.norm(u)
    w = np.cross(ax, u)
    h = t / 2
    offs = [(-h, -h), (h, -h), (h, h), (-h, h)]
    a = [m.v(tuple(p0 + u * ou + w * ow)) for ou, ow in offs]
    b = [m.v(tuple(p1 + u * ou + w * ow)) for ou, ow in offs]
    for k in range(4):
        k2 = (k + 1) % 4
        m.face((a[k], a[k2], b[k2], b[k]), rgb, uv=uv)
    if caps:
        m.face((b[0], b[1], b[2], b[3]), rgb, uv=uv)
        m.face((a[3], a[2], a[1], a[0]), rgb, uv=uv)


def build_cross(m):
    """The Mont-Royal cross (1924): a tall square steel LATTICE post with
    lattice arms high up — the arms at 0.72 of the height, spanning ~0.55 of
    it, so the silhouette is a cross before it is a tower (tp5-final-dpr1:
    arms at 0.66 spanning 0.6 of a 27-unit post read as a utility pylon).
    Four chords per member, X-bracing on every face, warm white and lit,
    on a small concrete footing in the summit meadow."""
    sx, sy, sz = CROSS_AT
    z0 = sz - 0.6
    box(m, sx - 3.0, sx + 3.0, sy - 3.0, sy + 3.0, z0 - 1.0, z0 + 1.0, CONCRETE)
    zb = z0 + 1.0
    HC = 36.0
    HW = 1.7           # chord centres at ±HW: a 3.4 square section
    CH = 0.78          # chord section
    DG = 0.38          # bracing section
    hi, lo = CROSS * 1.0, CROSS * 0.94  # bracing a shade under the chords, still near-white (B > 0.6 linear)
    # the post: four chords, zig-zag bracing on each face
    for sx_, sy_ in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        member(m, (sx + sx_ * HW, sy + sy_ * HW, zb), (sx + sx_ * HW, sy + sy_ * HW, zb + HC), CH, hi, caps=True)
    panels = 10
    for k in range(panels):
        za = zb + HC * k / panels
        zc = zb + HC * (k + 1) / panels
        f = 1 if k % 2 == 0 else -1
        for yy in (-HW, HW):
            member(m, (sx - f * HW, sy + yy, za), (sx + f * HW, sy + yy, zc), DG, lo)
        for xx in (-HW, HW):
            member(m, (sx + xx, sy - f * HW, za), (sx + xx, sy + f * HW, zc), DG, lo)
    # the arms: high on the post, 8.2 out each side of it
    za = zb + HC * 0.72
    reach = 8.2
    for side in (-1, 1):
        x0 = sx + side * HW
        x1 = sx + side * (HW + reach)
        for dy, dz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            member(m, (x0, sy + dy * HW, za + dz * HW), (x1, sy + dy * HW, za + dz * HW), CH, hi, caps=True)
        ap = 3
        for k in range(ap):
            xa = x0 + side * reach * k / ap
            xb = x0 + side * reach * (k + 1) / ap
            f = 1 if k % 2 == 0 else -1
            for yy in (-HW, HW):          # front/back faces: diagonals in z
                member(m, (xa, sy + yy, za - f * HW), (xb, sy + yy, za + f * HW), DG, lo)
            for zz in (-HW, HW):          # top/bottom faces: diagonals in y
                member(m, (xa, sy - f * HW, za + zz), (xb, sy + f * HW, za + zz), DG, lo)
        # end frame closing the arm
        for (a0, a1) in (((-1, -1), (1, -1)), ((1, -1), (1, 1)), ((1, 1), (-1, 1)), ((-1, 1), (-1, -1))):
            member(m, (x1, sy + a0[0] * HW, za + a0[1] * HW), (x1, sy + a1[0] * HW, za + a1[1] * HW), DG, hi)
    # cap frame on the post's top
    for (a0, a1) in (((-1, -1), (1, -1)), ((1, -1), (1, 1)), ((1, 1), (-1, 1)), ((-1, 1), (-1, -1))):
        member(m, (sx + a0[0] * HW, sy + a0[1] * HW, zb + HC), (sx + a1[0] * HW, sy + a1[1] * HW, zb + HC), DG, hi)


# ── measurements printed for the record ─────────────────────────────────────

def report_shape():
    """The silhouette's numbers: the crest profile along the spine (three
    summits, two saddles), and the ridge's plan proportions — the extent of
    the ground over 40 % of the summit's height along the ridge's principal
    axis against across it."""
    prof = []
    for s in np.linspace(0.0, 1.0, 41):
        # walk the spine; at each point take the highest ground within 14
        # units across it (Outremont stands off the spine)
        run = s * _SP_TOTAL
        i = 0
        while i < len(_SP_LENS) - 1 and run > _SP_LENS[i]:
            run -= _SP_LENS[i]
            i += 1
        p = _SP[i] + (_SP[i + 1] - _SP[i]) * min(1.0, run / _SP_LENS[i])
        d = _SP[i + 1] - _SP[i]
        nrm = np.array([-d[1], d[0]]) / np.linalg.norm(d)
        prof.append(max(ground_z(*(p + nrm * o)) for o in np.linspace(-14, 14, 15)) - LAWN_H)
    print("[mont-royal] crest profile W→E: " + " ".join(f"{h:.0f}" for h in prof))
    hmax = CROSS_AT[2] - LAWN_H
    pts = []
    for x in np.arange(-115, 116, 2.0):
        for y in np.arange(-90, 100, 2.0):
            if ground_z(x, y) - LAWN_H > 0.4 * hmax:
                pts.append((x, y))
    P = np.array(pts)
    P0 = P - P.mean(0)
    w, V = np.linalg.eigh(np.cov(P0.T))
    major, minor = V[:, 1], V[:, 0]
    L = np.ptp(P0 @ major)
    W = np.ptp(P0 @ minor)
    print(f"[mont-royal] ridge over 40 % height: length {L:.0f} × width {W:.0f} = {L / W:.2f}:1, "
          f"axis bearing {math.degrees(math.atan2(major[1], major[0])):.0f}° from +X")


# ── assembly ─────────────────────────────────────────────────────────────────

TRIS_MAX = 11950     # the landmark budget (glbAssets.test.ts MOUNT_TRIS_MAX 12 000)


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def ground_normals(obj):
    """The lawn skirt's corners get UP normals, and the terrain's corners
    bend toward UP over the foothills' last stretch (t 0.82 → 1); every other
    corner keeps the normal Blender computed — so the foot is lit exactly
    like the city's flat park pad it slides under, with no rim of light or
    shade where the slope meets the lawn."""
    me = obj.data
    attr = me.attributes.get("mr_ground")
    flags = [0] * len(me.polygons)
    attr.data.foreach_get("value", flags)
    normals = [tuple(cn.vector) for cn in me.corner_normals]
    n_up = n_bent = 0
    for p in me.polygons:
        fl = flags[p.index]
        if not fl:
            continue
        for li in p.loop_indices:
            if fl == 1:
                normals[li] = (0.0, 0.0, 1.0)
                n_up += 1
                continue
            co = me.vertices[me.loops[li].vertex_index].co
            w = smoothstep(0.82, 1.0, foot_t(co.x, co.y))
            if w <= 0.0:
                continue
            nv = np.array(normals[li]) * (1 - w) + np.array([0.0, 0.0, 1.0]) * w
            normals[li] = tuple(nv / np.linalg.norm(nv))
            n_bent += 1
    me.normals_split_custom_set(normals)
    me.attributes.remove(attr)
    print(f"[mont-royal] ground: {n_up} skirt corners UP, {n_bent} foothill corners bent toward UP")


def build():
    global CROSS_AT, MEADOWS
    ca.reset_scene()
    CROSS_AT = find_summit()
    MEADOWS = meadow_shapes()
    print(f"[mont-royal] summit at ({CROSS_AT[0]:.1f}, {CROSS_AT[1]:.1f}) z {CROSS_AT[2]:.1f}; shelf {SHELF_H:.1f}; "
          f"foot {min(foot(2 * math.pi * k / 360) for k in range(360)):.1f}-{max(foot(2 * math.pi * k / 360) for k in range(360)):.1f}; apron {APRON_R:.1f}")
    for name, (x, y) in (("outremont", OUTREMONT), ("westmount", WESTMOUNT), ("saddle W-O", (-36, 8)),
                         ("saddle O-C", (18, 6)), ("lake", LAKE), ("belvedere", BELV),
                         ("escarpment foot", (6, -36)), ("lookout", LOOKOUT)):
        print(f"[mont-royal] {name} z {ground_z(x, y):.1f}")
    report_shape()
    parts = []
    for fn, name in ((build_meadows, "mr-meadows"), (build_paths, "mr-paths"), (build_lake, "mr-lake"),
                     (build_rocks, "mr-rocks"), (build_chalet, "mr-chalet"), (build_lookout, "mr-lookout"),
                     (build_cross, "mr-cross")):
        m = Mesh()
        fn(m)
        parts.append(m.finish(name, smooth_angle=60 if name in ("mr-paths", "mr-meadows") else None))
    fixed = sum(tri_count(o) for o in parts) + terrain_tris()
    trees = plan_woods(TRIS_MAX - fixed - 10)
    m = Mesh()
    build_terrain(m, trees)
    parts.insert(0, m.finish("mr-terrain", smooth_angle=60))
    print(f"[mont-royal] fixed parts {fixed} tris: " + ", ".join(f"{o.name} {tri_count(o)}" for o in parts))
    m = Mesh()
    build_canopy(m, trees)
    parts.append(m.finish("mr-canopy", smooth_angle=75))
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = "mont-royal"
    obj.data.name = "mont-royal"
    obj.data.color_attributes.active_color = obj.data.color_attributes["Color"]
    ground_normals(obj)
    obj.data.materials.append(vertex_colour_material())
    co = np.array([v.co[:] for v in obj.data.vertices])
    tris = tri_count(obj)
    print(f"[mont-royal] plan radius {np.hypot(co[:, 0], co[:, 1]).max():.1f}  height {co[:, 2].max():.1f}  {tris} tris")
    assert tris <= TRIS_MAX, tris
    return obj


def vertex_colour_material():
    """COLOR_0 as the base colour (the engine reads only the vertex colours;
    this keeps the preview honest)."""
    mat = bpy.data.materials.new("mont-royal")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    vc = nt.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Color"
    nt.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.88
    bsdf.inputs["Metallic"].default_value = 0.0
    mat.use_backface_culling = True
    return mat


def street_ground():
    """AFTER export only: the city's park lawn round the mountain, then the
    street tone (contrast)."""
    if not ca.PREVIEW or "street" in bpy.data.objects:
        return
    bpy.ops.mesh.primitive_plane_add(size=900, location=(0, 0, -0.05))
    g = bpy.context.active_object
    g.name = "street"
    mat = bpy.data.materials.new("street")
    mat.use_nodes = True
    mat.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (*lin("#8A7F6C"), 1.0)
    g.data.materials.append(mat)
    bpy.ops.mesh.primitive_plane_add(size=250, location=(0, 0, 0.95))
    p = bpy.context.active_object
    p.name = "park"
    pm = bpy.data.materials.new("park")
    pm.use_nodes = True
    pm.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (*LAWN, 1.0)
    p.data.materials.append(pm)


def preview(obj, filename, cam_loc, target, **kw):
    for o in list(bpy.data.objects):
        if o.name.startswith(("cam", "sun")):
            bpy.data.objects.remove(o, do_unlink=True)
    ca.preview(obj, filename, cam_loc, target, **kw)


if __name__ == "__main__":
    mr = build()
    ca.export(mr, "mont-royal.glb")
    street_ground()
    # the engine's iso camera looks straight at the downtown face (-Y) from
    # ~35-40° over the horizon; the low shot is the skyline silhouette
    preview(mr, "mont-royal-iso.png", (0, -290, 210), (0, 0, 18))
    preview(mr, "mont-royal-front.png", (0, -320, 50), (0, 0, 26))
    preview(mr, "mont-royal-side.png", (320, 40, 70), (0, 0, 24))
    preview(mr, "mont-royal-top.png", (0, -1, 420), (0, 0, 0))
    preview(mr, "mont-royal-cross.png", (CROSS_AT[0] + 34, CROSS_AT[1] - 60, CROSS_AT[2] + 34), (CROSS_AT[0], CROSS_AT[1], CROSS_AT[2] + 16))
    preview(mr, "mont-royal-chalet.png", (CHALET[0] + 30, CHALET[1] - 80, SHELF_H + 42), (CHALET[0], CHALET[1] - 6, SHELF_H))
    preview(mr, "mont-royal-far.png", (420, -900, 640), (0, 0, 20), size=(500, 400))
