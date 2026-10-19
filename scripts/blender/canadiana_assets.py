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

"""Canadiana decor assets, authored in Blender and exported as glTF binaries.

    blender --background --factory-startup --python scripts/blender/canadiana_assets.py -- \
        --out src/canvas3d/decor/assets [--preview reports/view3d-quality/blender]

Two props, both deterministic (no random seeds, no wall clock):

  canada-flag.glb   desk flag: weighted bevelled foot, smooth steel pole, brass
                    finial, and a banner whose folds come from a real cloth
                    simulation (hoist pinned to the pole, steady wind, gravity),
                    frozen at a fixed frame. The print is the OFFICIAL flag:
                    red-white-red 1:2:1 and the 11-point leaf traced from the
                    Flag of Canada construction (public-domain SVG geometry),
                    rasterised here into the embedded texture.
  maple-leaf.glb    one sugar-maple blade: five unequal lobes with teeth, a
                    cupped/curled surface on a constrained-Delaunay mesh, a
                    petiole, and two embedded maps — a near-white DETAIL map
                    (palmate veins lighter, margin darker; the engine multiplies
                    it with each blade's tone) and a tangent-space NORMAL map
                    raising the vein network.

Scene units: the engine's world units (a card is ~200 wide). The flag keeps the
engine's FLAG gabarit (pole radius 1.4, top 68.2, banner 52 x 26 centred at
47) so placement footprints and pose gates stay meaningful. Blender is Z-up;
the glTF exporter converts to Y-up, so Blender +Y (leaf apex) becomes glTF -Z,
which is the engine's "apex at local -Z" convention.
"""

import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.geometry import delaunay_2d_cdt

# ── args ─────────────────────────────────────────────────────────────────────

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    if f"--{name}" in argv:
        return argv[argv.index(f"--{name}") + 1]
    return default


OUT = os.path.abspath(arg("out", "src/canvas3d/decor/assets"))
PREVIEW = arg("preview")
os.makedirs(OUT, exist_ok=True)
if PREVIEW:
    os.makedirs(os.path.abspath(PREVIEW), exist_ok=True)


# ── generic helpers ──────────────────────────────────────────────────────────

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def hex_rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])


def image_from_array(name, rgb, alpha=None, non_color=False):
    """numpy (H, W, 3) in [0,1], row 0 = TOP of the picture -> packed bpy image.

    The colour space is fixed BEFORE the pixels are written. Switching a
    generated image to Non-Color afterwards makes Blender regenerate its
    buffer from the generator colour, i.e. black: that is how the first
    maple-leaf.glb shipped an all-zero normal map (every texel (0, 0, 0),
    measured 2026-10-08), which tilted each blade's shading normal ~55° and
    turned the blades pale or near-black by yaw. The read-back below makes
    that failure loud instead of silent."""
    h, w, _ = rgb.shape
    img = bpy.data.images.new(name, width=w, height=h, alpha=alpha is not None, is_data=non_color)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[..., :3] = rgb
    if alpha is not None:
        rgba[..., 3] = alpha
    img.pixels.foreach_set(np.flipud(rgba).ravel())  # bpy rows start at the bottom
    img.file_format = "PNG"
    img.pack()
    back = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(back)
    got = back.reshape(h, w, 4)[..., :3].mean(axis=(0, 1))
    want = np.asarray(rgb, dtype=np.float64).mean(axis=(0, 1))
    assert np.allclose(got, want, atol=0.02), f"{name}: packed pixels {got} != authored {want}"
    return img


def polygon_coverage(poly, width, height, ss=4):
    """Anti-aliased coverage of a closed polygon (pixel coords, y down) on a
    width x height grid: even-odd rule on an ss x ss supersample, box-filtered."""
    poly = np.asarray(poly, dtype=np.float64)
    xs = (np.arange(width * ss) + 0.5) / ss
    ys = (np.arange(height * ss) + 0.5) / ss
    X, Y = np.meshgrid(xs, ys)
    inside = np.zeros(X.shape, dtype=bool)
    x0, y0 = poly[:, 0], poly[:, 1]
    x1, y1 = np.roll(x0, -1), np.roll(y0, -1)
    for a, b, c, d in zip(x0, y0, x1, y1):
        if b == d:
            continue
        cond = (b > Y) != (d > Y)
        xint = a + (Y - b) * (c - a) / (d - b)
        inside ^= cond & (X < xint)
    cov = inside.reshape(height, ss, width, ss).mean(axis=(1, 3))
    return cov


def segment_distance(px, py, ax, ay, bx, by):
    """Distance from every (px, py) to segment a-b, plus the param t in [0,1]."""
    vx, vy = bx - ax, by - ay
    l2 = np.maximum(vx * vx + vy * vy, 1e-12)
    t = np.clip(((px - ax) * vx + (py - ay) * vy) / l2, 0.0, 1.0)
    dx, dy = px - (ax + t * vx), py - (ay + t * vy)
    return np.sqrt(dx * dx + dy * dy), t


# ── the official leaf (Flag of Canada) ───────────────────────────────────────
# Path data of the leaf as published with the public-domain construction
# drawing (Wikimedia "Flag of Canada"): relative moves/lines/arcs in a frame
# whose origin is the centre of the white square, y DOWN, square = 4800 wide.
LEAF_PATH = (
    "m-90 2030 45-863a95 95 0 0 0-111-98l-859 151 116-320a65 65 0 0 0-20-73"
    "l-941-762 212-99a65 65 0 0 0 34-79l-186-572 542 115a65 65 0 0 0 73-38"
    "l105-247 423 454a65 65 0 0 0 111-57l-204-1052 327 189a65 65 0 0 0 91-27"
    "l332-652 332 652a65 65 0 0 0 91 27l327-189-204 1052a65 65 0 0 0 111 57"
    "l423-454 105 247a65 65 0 0 0 73 38l542-115-186 572a65 65 0 0 0 34 79"
    "l212 99-941 762a65 65 0 0 0-20 73l116 320-859-151a95 95 0 0 0-111 98"
    "l45 863z"
)


def _tokens(d):
    import re
    return re.findall(r"[mlaz]|-?\d+(?:\.\d+)?", d)


def _arc_points(x1, y1, rx, ry, phi, fa, fs, x2, y2, n=8):
    """SVG endpoint arc -> n points (excluding the start). Circular arcs only
    (rx == ry, phi == 0), which is all this path uses."""
    r = rx
    dx, dy = (x1 - x2) / 2.0, (y1 - y2) / 2.0
    d2 = dx * dx + dy * dy
    r = max(r, math.sqrt(d2))
    coef = math.sqrt(max(0.0, (r * r - d2) / d2)) if d2 > 0 else 0.0
    if fa == fs:
        coef = -coef
    cx = coef * dy + (x1 + x2) / 2.0
    cy = -coef * dx + (y1 + y2) / 2.0
    a1 = math.atan2(y1 - cy, x1 - cx)
    a2 = math.atan2(y2 - cy, x2 - cx)
    da = a2 - a1
    if fs and da < 0:
        da += 2 * math.pi
    if not fs and da > 0:
        da -= 2 * math.pi
    return [(cx + r * math.cos(a1 + da * k / n), cy + r * math.sin(a1 + da * k / n)) for k in range(1, n + 1)]


def official_leaf_polygon():
    toks = _tokens(LEAF_PATH)
    i, cmd = 0, None
    x = y = 0.0
    pts = []
    while i < len(toks):
        t = toks[i]
        if t in "mlaz":
            cmd = t
            i += 1
            if cmd == "z":
                break
            continue
        if cmd in ("m", "l"):
            x += float(toks[i]); y += float(toks[i + 1]); i += 2
            pts.append((x, y))
            if cmd == "m":
                cmd = "l"
        elif cmd == "a":
            rx, ry, phi, fa, fs, ex, ey = (float(v) for v in toks[i:i + 7])
            i += 7
            nx, ny = x + ex, y + ey
            pts.extend(_arc_points(x, y, rx, ry, phi, int(fa), int(fs), nx, ny))
            x, y = nx, ny
    # self-checks: the path is mirror-symmetric about x = 0 and closes on its
    # own start via 'z' (the two stem feet are +-90 at y = 2030)
    xs = [p[0] for p in pts]
    assert abs(max(xs) + min(xs)) < 1e-6, "leaf path not symmetric"
    assert abs(pts[-1][0] - 90) < 1e-6 and abs(pts[-1][1] - 2030) < 1e-6, pts[-1]
    apex = min(pts, key=lambda p: p[1])
    assert abs(apex[0]) < 1e-6 and abs(apex[1] + 2000) < 1e-6, apex
    return pts


# ── flag texture: official layout, rasterised ────────────────────────────────

FLAG_RED = "#D52B1E"   # the FIP red as printed (Pantone 032 equivalent)
FLAG_TEX_W, FLAG_TEX_H = 1024, 512
# VIEW3D QUALITY LOOP 3 r2 — the HARDWARE STRIP. The pole, foot, finial and
# clips used to sample one white texel at the top of the print's white square
# and wore the cloth's own material (roughness 0.62, metalness 0): "a grey
# plastic toy" (workbench-flag.png). One mesh carries one material, so the
# metal is a metallic-roughness MAP: the print now fills v in [0, PRINT_V1]
# and the top FLAG_TEX_H * (1 - PRINT_V1) = 32 rows are a white strip whose
# metallic-roughness texels give each hardware part its own finish. The parts
# sample the strip's MIDDLE row, 4 texels (of the 128-row MR map) from the
# print, so bilinear filtering never mixes cloth into metal until a mip level
# where the pole is under a pixel.
PRINT_V1 = 0.9375
STRIP_V = 0.97
# u of each hardware finish inside the strip (columns of the MR map below)
STEEL_UV = (0.36, STRIP_V)
BRASS_UV = (0.50, STRIP_V)
DARK_UV = (0.64, STRIP_V)
# (roughness, metalness) per finish. Brushed steel and brass per the critique
# (metalness ~0.9, roughness ~0.35); the clips and the foot's contact ring a
# darker, rougher anodised steel. The cloth keeps its 0.62 dielectric.
CLOTH_RM = (0.62, 0.0)
FINISHES = {
    "steel": ((0.25, 0.43), (0.35, 0.9)),
    "brass": ((0.43, 0.57), (0.38, 0.88)),
    "dark": ((0.57, 0.75), (0.5, 0.75)),
}
MR_TEX_W, MR_TEX_H = 256, 128


def flag_texture():
    w, h = FLAG_TEX_W, FLAG_TEX_H
    strip = int(round(h * (1 - PRINT_V1)))   # 32 rows at the TOP of the picture
    ph = h - strip                           # the print: 480 rows
    red = hex_rgb(FLAG_RED)
    img = np.ones((h, w, 3))
    img[strip:, : w // 4] = red
    img[strip:, 3 * w // 4:] = red
    # the white square is 4800 path units on a side: w/2 texels across, ph
    # texels down (the print's texels are not square; the UVs undo that)
    sx = (w / 2) / 4800.0
    sy = ph / 4800.0
    leaf = [(w / 2 + px * sx, strip + ph / 2 + py * sy) for px, py in official_leaf_polygon()]
    cov = polygon_coverage(leaf, w, h, ss=4)[..., None]
    img = img * (1 - cov) + red * cov
    # GUARD: the banner's top hem samples exactly v = PRINT_V1, i.e. the seam
    # between the strip and the print, where bilinear filtering takes half of
    # each. The strip rows nearest the print repeat the print's top row, so
    # the hem keeps its colour; the parts sample row ~15 (STRIP_V), still white.
    guard = strip // 3
    img[strip - guard:strip] = img[strip]
    # flat colour on purpose: the folds carry the cloth read, and a flat
    # three-colour print compresses to a few kB (a 2-px weave tripled the GLB)
    return np.clip(img, 0, 1)


def flag_mr_texture():
    """glTF metallic-roughness map (G = roughness, B = metalness): the cloth
    over the print, one column band per hardware finish in the strip.

    The finishes own only the strip's top 5 of its 8 rows (v > 0.96): the
    banner's top hem samples v = PRINT_V1 exactly, and with the finishes
    reaching the seam bilinear filtering made the hem half metal (measured on
    the first r2 export: hem vertex metalness 0.90). The parts sample
    STRIP_V = 0.97, row 3.8, between two finish rows."""
    w, h = MR_TEX_W, MR_TEX_H
    strip = int(round(h * (1 - 0.96)))  # 5 rows
    img = np.zeros((h, w, 3))
    img[..., 0] = 1.0  # R unused (no occlusion channel)
    img[:, :, 1] = CLOTH_RM[0]
    img[:, :, 2] = CLOTH_RM[1]
    u = (np.arange(w) + 0.5) / w
    # the strip defaults to steel, then each finish owns its column band
    img[:strip, :, 1], img[:strip, :, 2] = FINISHES["steel"][1]
    for (u0, u1), (rough, metal) in FINISHES.values():
        cols = (u >= u0) & (u < u1)
        img[:strip, cols, 1] = rough
        img[:strip, cols, 2] = metal
    return img


# ── flag geometry ────────────────────────────────────────────────────────────

FLAG = dict(BASE_R=15.0, BASE_H=2.2, RING_R=9.2, RING_H=1.4, POLE_R=1.4, POLE_TOP=68.2,
            FINIAL_R=1.7, SHEET_W=52.0, SHEET_H=26.0, SHEET_Y=47.0)
SIM_SCALE = 0.01  # simulate the cloth at real desk-flag size (0.52 m), then scale up


def set_vertex_colors(obj, rgb_fn):
    """Write a COLOR_0 (per-corner, sRGB authored -> linear stored) attribute."""
    me = obj.data
    attr = me.color_attributes.new(name="Color", type="FLOAT_COLOR", domain="CORNER")
    for poly in me.polygons:
        for li in poly.loop_indices:
            v = me.vertices[me.loops[li].vertex_index]
            c = srgb_to_linear(rgb_fn(v.co))
            attr.data[li].color = (c[0], c[1], c[2], 1.0)
    me.color_attributes.active_color = attr


def set_uv_constant(obj, uv):
    me = obj.data
    layer = me.uv_layers.new(name="UVMap") if not me.uv_layers else me.uv_layers[0]
    for loop in layer.data:
        loop.uv = uv


def set_uv_by(obj, uv_fn):
    """Per-corner UV chosen from the vertex position (a finish per part)."""
    me = obj.data
    layer = me.uv_layers.new(name="UVMap") if not me.uv_layers else me.uv_layers[0]
    for li, loop in enumerate(layer.data):
        loop.uv = uv_fn(me.vertices[me.loops[li].vertex_index].co)


def shade_smooth(obj, angle_deg=40):
    obj.data.shade_smooth()
    try:
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.shade_auto_smooth(angle=math.radians(angle_deg))
    except Exception:
        pass


def lathe(name, profile, segments):
    """Revolve an (r, z) profile around Z — bevelled foot, collar, finial."""
    bm = bmesh.new()
    rings = []
    for r, z in profile:
        ring = []
        for k in range(segments):
            a = 2 * math.pi * k / segments
            ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a), z)))
        rings.append(ring)
    for a_ring, b_ring in zip(rings, rings[1:]):
        for k in range(segments):
            k2 = (k + 1) % segments
            bm.faces.new((a_ring[k], a_ring[k2], b_ring[k2], b_ring[k]))
    # caps where the profile touches the axis are implicit (r = 0 rings collapse)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    return obj


def build_flag():
    reset_scene()
    F = FLAG
    # base colours are the METALS' specular tint now (metallic-roughness map):
    # a bright, faintly blue steel and a warm brass. Under the old dielectric
    # finish the same greys read as painted plastic.
    steel = hex_rgb("#C9CDD3")
    steel_dark = hex_rgb("#4C5158")
    brass = hex_rgb("#C8A04A")

    # weighted foot: a bevelled plate on a darker contact ring, collar on top
    foot_profile = [
        (0.0, 0.0), (F["BASE_R"], 0.0), (F["BASE_R"], F["RING_H"] * 0.6),
        (F["BASE_R"] - 0.4, F["RING_H"]), (F["BASE_R"] - 0.9, F["RING_H"] + 0.25),
        (F["BASE_R"] - 1.4, F["RING_H"] + F["BASE_H"] * 0.85),
        (F["BASE_R"] - 2.2, F["RING_H"] + F["BASE_H"]),
        (F["RING_R"], F["RING_H"] + F["BASE_H"] + 0.15),
        (F["RING_R"] * 0.62, F["RING_H"] + F["BASE_H"] + 0.9),
        (F["POLE_R"] * 1.6, F["RING_H"] + F["BASE_H"] + 1.7),
        (0.0, F["RING_H"] + F["BASE_H"] + 1.7),
    ]
    foot = lathe("foot", foot_profile, 36)  # smooth-shaded: 36 facets read round
    ring_top = F["RING_H"]
    # a turned BRASS plate on a dark contact ring (was steel on steel-dark —
    # "a plain matte disc"): the finish is per vertex through the strip UV
    set_vertex_colors(foot, lambda co: steel_dark if co.z < ring_top * 0.95 else brass)
    set_uv_by(foot, lambda co: DARK_UV if co.z < ring_top * 0.95 else BRASS_UV)

    foot_top = F["RING_H"] + F["BASE_H"] + 1.7
    pole_profile = [(0.0, foot_top - 0.5), (F["POLE_R"], foot_top - 0.5), (F["POLE_R"], F["POLE_TOP"]),
                    (F["POLE_R"] * 0.7, F["POLE_TOP"] + 0.3), (0.0, F["POLE_TOP"] + 0.3)]
    pole = lathe("pole", pole_profile, 14)
    set_vertex_colors(pole, lambda co: steel)
    set_uv_constant(pole, STEEL_UV)

    # brass ball CENTRED at POLE_TOP + 0.6, like the procedural prop: its top
    # is exactly FLAG_HEIGHT (= POLE_TOP + 0.6 + FINIAL_R), which the leaf
    # caps (LEAF_MAX_SPAN) and the placement footprints are derived from
    fr = F["FINIAL_R"]
    fc = F["POLE_TOP"] + 0.6
    fin_profile = [(0.0, fc - fr)]
    for k in range(1, 10):
        a = -math.pi / 2 + math.pi * k / 10
        fin_profile.append((fr * math.cos(a), fc + fr * math.sin(a)))
    fin_profile.append((0.0, fc + fr))
    finial = lathe("finial", fin_profile, 12)
    set_vertex_colors(finial, lambda co: brass)
    set_uv_constant(finial, BRASS_UV)

    # two hoist clips
    clips = []
    for dz in (-F["SHEET_H"] / 2 + 1.6, F["SHEET_H"] / 2 - 1.6):
        clip = lathe("clip", [(0, -0.9), (F["POLE_R"] + 0.55, -0.9), (F["POLE_R"] + 0.55, 0.9), (0, 0.9)], 10)
        clip.location.z = F["SHEET_Y"] + dz
        set_vertex_colors(clip, lambda co: steel_dark)
        set_uv_constant(clip, DARK_UV)
        clips.append(clip)

    banner = simulate_banner()

    for o in (foot, pole, finial, *clips):
        shade_smooth(o, 50)
    bpy.ops.object.select_all(action="DESELECT")
    for o in (foot, pole, finial, banner, *clips):
        o.select_set(True)
    bpy.context.view_layer.objects.active = banner
    bpy.ops.object.convert(target="MESH")
    bpy.ops.object.join()
    flag = bpy.context.view_layer.objects.active
    flag.name = "canada-flag"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    tex = image_from_array("canada-flag-print", flag_texture())
    mr = image_from_array("canada-flag-mr", flag_mr_texture(), non_color=True)
    flag.data.materials.clear()
    flag.data.materials.append(make_material("canada-flag", tex, roughness=0.62, vertex_color=True, metal_rough=mr))
    return flag


def simulate_banner():
    """The banner as a cloth simulation at real size (0.52 x 0.26 m): the hoist
    column is pinned to the pole, a steady wind with mild turbulence blows along
    +X, and the sheet is frozen at a fixed frame. 40 x 20 quads ~ 1 600 tris."""
    F = FLAG
    w, h = F["SHEET_W"] * SIM_SCALE, F["SHEET_H"] * SIM_SCALE
    # 46 x 21 quads, ~1 930 tris (was 34 x 16): the deeper folds below need
    # the columns, and at 16 rows the bottom hem showed polygonal kinks and the
    # fly edge stair-stepped (loop1 flag critique). Flag total stays under the
    # 3 500 per-archetype cap (glbAssets.test.ts).
    nx, ny = int(arg("nx", "46")), int(arg("ny", "21"))
    bm = bmesh.new()
    grid = []
    for j in range(ny + 1):
        row = []
        for i in range(nx + 1):
            u, v = i / nx, j / ny
            row.append(bm.verts.new((F["POLE_R"] * SIM_SCALE + u * w, 0.0, (F["SHEET_Y"] - F["SHEET_H"] / 2) * SIM_SCALE + v * h)))
        grid.append(row)
    uv_of = {}
    for j in range(ny):
        for i in range(nx):
            f = bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
            uv_of[f.index] = None
    bm.verts.index_update()
    me = bpy.data.meshes.new("banner")
    bm.to_mesh(me)
    bm.free()
    banner = bpy.data.objects.new("banner", me)
    bpy.context.collection.objects.link(banner)

    # UVs straight from the flat sheet (u along the fly, v up): the print maps
    # 1:1 onto v in [0, PRINT_V1] (the hardware strip owns the rest)
    uv = me.uv_layers.new(name="UVMap")
    x0 = F["POLE_R"] * SIM_SCALE
    z0 = (F["SHEET_Y"] - F["SHEET_H"] / 2) * SIM_SCALE
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            uv.data[li].uv = ((co.x - x0) / w, (co.z - z0) / h * PRINT_V1)
    set_vertex_colors(banner, lambda co: np.array([1.0, 1.0, 1.0]))

    pin = banner.vertex_groups.new(name="hoist")
    pin.add([v.index for v in me.vertices if abs(v.co.x - x0) < 1e-6], 1.0, "REPLACE")

    # 1. FLY SHAPE. Blender's cloth feels wind only as pressure on faces, and a
    #    breeze along a pinned sheet barely lifts it (measured: banner extent
    #    unchanged from wind 0 to 300). So the flying pose is authored: a wave
    #    TRAVELLING down the fly (amplitude 0 at the hoist, growing toward the
    #    free edge), a diagonal second harmonic, and a sag that grows with
    #    distance from the pole and toward the bottom hem. Each row is then
    #    re-spaced so its 3D arc length equals the flat width — the cloth is
    #    inextensible, it only folds.
    W = F["SHEET_W"] * SIM_SCALE
    # VIEW3D QUALITY LOOP 3 r2 — REAL FOLDS. Round 2 still read as "one soft
    # wave": a single 1.25-cycle swing of ±10.5 % W, the hoist half flat, no
    # fold shading across the leaf (workbench-flag.png). Its height-field form
    # y = f(u) could not go deeper: past a ~0.9 surface slope the arc-length
    # respacing could not fit a row back into the flat width.
    #
    # So each row is now authored by its TANGENT ANGLE along the arc length,
    # theta(s) = A(u) sin(2 pi FOLDS u - phase(v)), and integrated
    # (x' = cos theta, y' = sin theta): the row is EXACTLY as long as the flat
    # cloth whatever the slope, so the folds can be as deep as cloth folds
    # are. A(u) grows from a small hoist ripple to FOLD_AMP rad at the fly —
    # the travelling wave of a flag in a breeze, folds deepest where the cloth
    # is free. The phase advances with height (diagonal folds), and the
    # row's mean angle is removed so the sheet stays square to the pole (the
    # engine's FLAG_YAW_BAND turns its mean plane to the camera).
    #
    # FOLDS 3.4, FOLD_AMP 1.15 rad: y swings ~±(A/k) = ±0.054 W at the fly
    # (the critique's "~0.06·x"), ~3.4 crests across the sheet.
    folds = float(arg("folds", "3.4"))
    fold_amp = float(arg("fold-amp", "1.15"))
    sag = float(arg("sag", "0.07")) * W
    rows = {}
    for vtx in me.vertices:
        rows.setdefault(round((vtx.co.z - z0) / h * ny), []).append(vtx)
    step = w / nx
    for j, row in rows.items():
        row.sort(key=lambda q: q.co.x)
        v_ = j / ny
        thetas = []
        for i in range(1, len(row)):
            u = (i - 0.5) / nx  # midpoint of the segment
            a = 0.12 + (fold_amp - 0.12) * u ** 0.85
            thetas.append(a * math.sin(2 * math.pi * folds * u - 0.4 + 1.3 * v_))
        mean = sum(thetas) / len(thetas)
        x, y = x0, 0.0
        row[0].co.x, row[0].co.y = x0, 0.0
        for i, vtx in enumerate(row[1:], start=1):
            t = thetas[i - 1] - mean
            x += step * math.cos(t)
            y += step * math.sin(t)
            u = i / nx
            vtx.co.x, vtx.co.y = x, y
            # secondary vertical SAG: the free corner droops, more at the hem
            vtx.co.z -= sag * u * u * (1.2 - 0.4 * v_)
    me.update()

    # 2. RELAX in Blender's cloth solver: the hoist stays pinned, a light
    #    gravity settles the sheet for a few frames, and the solver turns the
    #    smooth analytic surface into cloth (soft secondary wrinkles, no
    #    stretch). Deterministic: no wind, no noise seed.
    cloth = banner.modifiers.new("cloth", "CLOTH")
    s = cloth.settings
    s.quality = int(arg("quality", "12"))
    s.mass = float(arg("mass", "0.02"))
    s.tension_stiffness = 22
    s.compression_stiffness = 22
    s.shear_stiffness = 8
    # stiff enough that the finer 46 x 21 grid does not buckle at grid scale
    # (0.06 crumpled it into blotches); the authored folds are far larger
    s.bending_stiffness = float(arg("bending", "0.6"))
    s.air_damping = 2.0
    s.vertex_group_mass = "hoist"
    s.effector_weights.gravity = float(arg("gravity", "0.25"))
    cloth.collision_settings.use_self_collision = False
    scene = bpy.context.scene
    frames = int(arg("frame", "10"))
    scene.frame_start, scene.frame_end = 1, max(2, frames)
    cloth.point_cache.frame_start, cloth.point_cache.frame_end = 1, max(2, frames)
    for f in range(1, frames + 1):
        scene.frame_set(f)
    bpy.context.view_layer.objects.active = banner
    bpy.ops.object.modifier_apply(modifier="cloth")
    xs = [v.co.x / SIM_SCALE for v in me.vertices]
    zs = [v.co.z / SIM_SCALE for v in me.vertices]
    ys = [v.co.y / SIM_SCALE for v in me.vertices]
    print(f"[canadiana] banner extent x {min(xs):.1f}..{max(xs):.1f}  y {min(ys):.1f}..{max(ys):.1f}  z {min(zs):.1f}..{max(zs):.1f}")

    # back to world units: scale about the origin (the pole axis), then pin the
    # hoist column EXACTLY onto the pole surface again (the sim leaves it there,
    # this removes float drift so the engine's "hoist pinned" gate holds)
    for v in me.vertices:
        v.co = v.co / SIM_SCALE
    hoist_x = F["POLE_R"]
    for v in me.vertices:
        if abs(v.co.x - hoist_x) < 0.05:
            v.co.x = hoist_x
            v.co.y = 0.0
    me.update()
    # 0.38 (was 0.32): with real folds the valleys are narrow, and the white
    # band has to show dark/lit alternation, not a grey drift (loop 3 r2)
    bake_fold_occlusion(banner, strength=float(arg("fold-ao", "0.38")))
    shade_smooth(banner, 80)
    return banner


def bake_fold_occlusion(banner, strength=0.32):
    """Cavity shading baked into the banner's COLOR_0 (it multiplies the
    print), so the folds read even under a flat key light — the critique saw
    the white band "uniformly lit".

    Which face does the camera see? The engine yaws the flag so its sheet
    normal faces the default view (FLAG_YAW_BAND), and the published shots
    show the hoist on the LEFT: we look down glTF −Z, i.e. at the Blender −Y
    face. On that face a VALLEY is a vertex lying farther along +Y than the
    cloth a few columns either side of it; its depth relative to the
    strongest valleys is the occlusion.

    Measured on the FOLD scale only, on the banner's own (u, v) grid: depth
    smoothed down the height of the sheet first, then a ±3-column second
    difference across it. A first try used the 1-ring Laplacian, which also
    picked up the solver's mid-scale ripples and rendered in the engine as
    grey blotches on the white band (leaf-after/workbench-flag.png).
    Deterministic: pure geometry."""
    me = banner.data
    uvl = me.uv_layers[0].data
    vuv = {}
    for loop in me.loops:
        vuv[loop.vertex_index] = tuple(uvl[loop.index].uv)
    us = sorted({round(u, 4) for u, _ in vuv.values()})
    vs = sorted({round(v, 4) for _, v in vuv.values()})
    col_of = {u: i for i, u in enumerate(us)}
    row_of = {v: j for j, v in enumerate(vs)}
    grid = np.full((len(vs), len(us)), np.nan)
    for vi, (u, v) in vuv.items():
        grid[row_of[round(v, 4)], col_of[round(u, 4)]] = me.vertices[vi].co.y
    assert not np.isnan(grid).any(), "banner is not a full (u, v) grid"
    # smooth DOWN the sheet (folds run top to bottom, leaning diagonally)
    for _ in range(4):
        grid[1:-1] = (grid[:-2] + 2 * grid[1:-1] + grid[2:]) / 4
    k = 3
    pad = np.pad(grid, ((0, 0), (k, k)), mode="edge")
    valley = grid - (pad[:, : -2 * k] + pad[:, 2 * k:]) / 2
    occ = np.clip(valley, 0.0, None)
    for _ in range(2):
        occ[:, 1:-1] = (occ[:, :-2] + 2 * occ[:, 1:-1] + occ[:, 2:]) / 4
    ref = np.percentile(occ[occ > 0], 92) if np.any(occ > 0) else 1.0
    occ = np.clip(occ / max(ref, 1e-6), 0.0, 1.0) ** 0.9
    tone = {vi: 1.0 - strength * occ[row_of[round(v, 4)], col_of[round(u, 4)]] for vi, (u, v) in vuv.items()}
    attr = me.color_attributes["Color"]
    for poly in me.polygons:
        for li in poly.loop_indices:
            c = float(srgb_to_linear(tone[me.loops[li].vertex_index]))
            attr.data[li].color = (c, c, c, 1.0)
    occ = np.array(list(tone.values()))
    occ = (1.0 - occ) / max(strength, 1e-6)
    print(f"[canadiana] fold occlusion: {np.count_nonzero(occ > 0.25)} of {len(occ)} banner vertices darkened >{strength * 0.25:.0%}")


# ── maple leaf ───────────────────────────────────────────────────────────────
# USER ASK 2026-10-09: the hand-drawn sugar-maple outline "does not look like
# a maple leaf — the leaf on the Canadian flag is much better". So the blade IS
# the flag's leaf: the same official 11-point silhouette `official_leaf_polygon`
# rasterises into the flag print, without its heraldic stem (the 3D blade gets
# a real petiole below). Clean points, no saw teeth — the flag leaf's read.
#
# Half outline, apex at (0, 1), petiole junction at the origin, x >= 0, drawn
# from the apex DOWN the right margin (clockwise), in units of the leaf's own
# apex-to-junction height.
FLAG_LEAF_JUNCTION_Y = 1167  # path units: where the official stem meets the blade


def official_leaf_half():
    pts = official_leaf_polygon()
    apex = min(range(len(pts)), key=lambda i: pts[i][1])
    # the polygon runs left side UP to the apex, then the right side DOWN to
    # the right stem foot; the blade's right margin ends where the stem starts
    # (the basal points hang BELOW the junction line, so stop at the stem's
    # own top corner, not at the first point past that height)
    right = []
    for x, y in pts[apex:]:
        right.append((x, y))
        if abs(y - FLAG_LEAF_JUNCTION_Y) < 1e-6 and abs(x) < 60:
            break
    s = FLAG_LEAF_JUNCTION_Y + 2000.0  # apex at y = −2000 → leaf height 1.0
    half = [(x / s, (FLAG_LEAF_JUNCTION_Y - y) / s) for x, y in right]
    assert abs(half[0][0]) < 1e-9 and abs(half[0][1] - 1.0) < 1e-9, half[0]
    assert abs(half[-1][1]) < 1e-9, half[-1]  # ends ON the junction line
    return half


LEAF_HALF = official_leaf_half()
# The official stem, from LEAF_PATH: "m-90 2030 45-863" runs from the left
# foot (-90, 2030) to the junction corner (-45, 1167). In leaf units (apex to
# junction = FLAG_LEAF_JUNCTION_Y + 2000 path units = 1.0):
_STEM_UNIT = FLAG_LEAF_JUNCTION_Y + 2000.0
PETIOLE_LEN = (2030 - FLAG_LEAF_JUNCTION_Y) / _STEM_UNIT   # 0.2725 (was a 0.30 bowed tail)
FLAG_STEM_TOP = 45 / _STEM_UNIT                             # half-width at the junction, 0.0142
FLAG_STEM_FOOT = 90 / _STEM_UNIT                            # half-width at the foot, 0.0284
LEAF_TEX = 512
# Margin points of LEAF_HALF that stay ENTIRE (no secondary teeth): the apex,
# both U sinuses (a sugar-maple sinus is smooth and rounded) and the truncate
# base. Every other margin edge long enough carries fine forward teeth.
LEAF_SMOOTH = {0, 7, 8, 9, 21, 22, 23, 29, 30, 31}
TOOTH_PITCH = 0.048   # one fine tooth per this much margin
TOOTH_MIN_EDGE = 0.07  # the sides of the coarse teeth stay clean
TOOTH_ORIGIN = (0.0, 0.03)
# Texture rectangle of the petiole island ((u0, u1), (v0, v1)): a strip in the
# map's left margin, outside the blade (leaf_uv puts x = -0.66 at u = 0.038).
PETIOLE_UV = ((0.010, 0.036), (0.020, 0.300))
# The five primary veins run from the petiole junction to the flag leaf's lobe
# tips: the apex, the upper point of each lateral lobe, each basal point
# (coordinates of official_leaf_half, measured, see LEAF_TEETH below).
LEAF_TIPS = [(0.0, 1.0), (0.568, 0.585), (-0.568, 0.585), (0.320, -0.017), (-0.320, -0.017)]
# The secondary points the side veins reach: the central lobe's shoulders, the
# lateral lobe's inner and lower points, the basal lobe's upper point.
LEAF_TEETH = [(0.237, 0.845), (0.341, 0.638), (0.587, 0.348), (0.284, 0.084)]
# Lift of the lobe tips off the leaf's resting plane, in leaf heights (see
# bend() in build_leaf), and how far the petiole's cut end rises off the desk.
TIP_LIFT = 0.048
STEM_RISE = 0.05


def serrate_half(half):
    """Secondary teeth between the coarse lobe points (critique: "between lobe
    tips the margin is smooth"). Each long margin edge becomes a short saw:
    tips pushed OUTWARD by a fraction of the tooth pitch and leaning toward the
    edge's lobe-tip end (maple teeth point forward, toward the lobe apex). The
    half runs clockwise, so the outward normal of an edge d is (-dy, dx)."""
    out = [half[0]]
    teeth = 0
    for k in range(1, len(half)):
        (ax, ay), (bx, by) = half[k - 1], half[k]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        smooth = (k - 1) in LEAF_SMOOTH or k in LEAF_SMOOTH or length < TOOTH_MIN_EDGE
        n = 0 if smooth else max(1, int(length / TOOTH_PITCH))
        if n:
            ux, uy = dx / length, dy / length
            nx, ny = -uy, ux
            far_b = math.hypot(bx - TOOTH_ORIGIN[0], by - TOOTH_ORIGIN[1]) > math.hypot(ax - TOOTH_ORIGIN[0], ay - TOOTH_ORIGIN[1])
            # a SAW, not a crenel: the tip leans forward (rise ~25°, fall ~40°
            # off the margin line) and the notch dips a hair INSIDE the margin,
            # which is what makes a tooth read sharp rather than stepped (the
            # first try, tips at 0.82 of the pitch and notches on the line,
            # rendered as battlements in leaf-top.png). Alternate teeth are
            # smaller — a fixed rhythm, still deterministic, less mechanical.
            # Teeth stay well clear of the edge's DISTAL end (the lobe or
            # coarse-tooth point): a fine tooth beside it turned the point into
            # a flat-topped shoulder (zoomed leaf-top.png, second and third
            # tries) — so they occupy [0.12, 0.62] of the edge measured from its
            # proximal end.
            lean = 0.66 if far_b else 0.34
            s0, s1 = (0.12, 0.62) if far_b else (0.38, 0.88)
            pitch = length * (s1 - s0) / n
            for i in range(n):
                amp = min(0.016, 0.3 * pitch) * (1.0 if (i + k) % 2 == 0 else 0.72)
                if i > 0:  # the edge's own ends serve as the outer notches
                    t = s0 + (s1 - s0) * i / n
                    out.append((ax + dx * t - nx * 0.25 * amp, ay + dy * t - ny * 0.25 * amp))
                t = s0 + (s1 - s0) * (i + lean) / n
                out.append((ax + dx * t + nx * amp, ay + dy * t + ny * amp))
                teeth += 1
        out.append((bx, by))
    return out, teeth


def leaf_outline():
    # the flag silhouette as is: its points ARE the read (serrate_half stays
    # available for a natural-leaf variant, but is not applied)
    half = LEAF_HALF
    right = half
    left = [(-x, y) for x, y in reversed(half[1:])]
    pts = right + [(0.0, 0.0)] + left
    return [p for k, p in enumerate(pts) if k == 0 or p != pts[k - 1]]


def leaf_uv(x, y):
    """Leaf space -> texture space: the blade's bbox mapped into [0.06, 0.94]^2
    so a white, flat margin stays outside it (WHITE corner for decals)."""
    return (0.5 + x * 0.70, 0.06 + y * 0.88)


def leaf_maps():
    """DETAIL map (near-white luminance, multiplied with the blade tone) and a
    tangent-space NORMAL map, both from one height field of the palmate vein
    network: 5 primaries from the petiole to the lobe tips, secondaries to the
    teeth, a thin margin rim. Rows top-down, v up -> flip at the end."""
    n = LEAF_TEX
    ys, xs = np.mgrid[0:n, 0:n]
    u = (xs + 0.5) / n
    v = 1.0 - (ys + 0.5) / n
    # back to leaf space
    lx = (u - 0.5) / 0.70
    ly = (v - 0.06) / 0.88

    tips = LEAF_TIPS
    teeth = list(LEAF_TEETH) + [(-x, y) for x, y in LEAF_TEETH]
    origin = (0.0, 0.03)
    height = np.zeros((n, n))
    # blade body at 0.80, veins lifted to 1.00: a 25 % value step, so the
    # veins survive on the DARK tones too (critique: "faint on the red blade,
    # invisible on the dark ones" — the old 0.86 → 0.99 step was 15 %)
    detail = np.full((n, n), 0.80)

    def vein(ax, ay, bx, by, width, lift):
        nonlocal height, detail
        d, t = segment_distance(lx, ly, ax, ay, bx, by)
        wv = width * (1.0 - 0.6 * t)          # veins taper toward the margin
        prof = np.clip(1.0 - d / wv, 0.0, 1.0)
        height = np.maximum(height, lift * prof ** 1.5)
        detail = np.maximum(detail, 0.80 + 0.20 * prof * lift)

    # primaries 0.020 wide (was 0.016): with the normal strength below they
    # catch the key light as ridges instead of "faint lines" (loop 3 r2)
    for tx, ty in tips:
        vein(origin[0], origin[1], tx, ty, 0.020, 1.0)
    # secondaries: one per lobe point, branching from the primary of ITS lobe
    # (central → shoulders, lateral → inner and lower points). The old
    # nearest-tooth rule fanned lines across the basal lobes of the flag
    # silhouette (flagleaf1/leaf-top.png).
    branches = []
    for sx in (1.0, -1.0):
        branches += [
            ((0.0, 1.0), 0.55, (sx * 0.237, 0.845)),
            ((sx * 0.568, 0.585), 0.45, (sx * 0.341, 0.638)),
            ((sx * 0.568, 0.585), 0.55, (sx * 0.587, 0.348)),
        ]
    for (tx, ty), k, (qx, qy) in branches:
        px, py = origin[0] + (tx - origin[0]) * k, origin[1] + (ty - origin[1]) * k
        vein(px, py, qx, qy, 0.008, 0.55)
    assert teeth  # the lobe points the branches above reach (LEAF_TEETH)
    # cross veinlets: a faint fixed lattice (sum of sines), never a noise seed
    # (relief only: in the DETAIL map this high-frequency term cost 70 kB of
    # PNG for a ±1 % tone change nobody sees at 75 px)
    lattice = 0.5 + 0.5 * np.sin(lx * 90.0 + np.sin(ly * 23.0) * 2.0) * np.sin(ly * 85.0)
    height += 0.05 * lattice

    outline = leaf_outline()
    cov = polygon_coverage([(leaf_uv(x, y)[0] * n, (1 - leaf_uv(x, y)[1]) * n) for x, y in outline], n, n, ss=2)
    # darker rim at the margin (a drying edge) — the coverage ramp drawn inward
    rim = np.clip((0.55 - cov) * 3.0, 0.0, 1.0) * (cov > 0.01)
    detail = detail * (1.0 - 0.12 * rim)
    detail = np.where(cov > 0.001, detail, 1.0)       # pure white outside the blade
    height = np.where(cov > 0.001, height, 0.0)
    # the PETIOLE's own island (see PETIOLE_UV): a solid stalk tone with a
    # slight darkening toward the cut end, and a FLAT normal (height 0). Its
    # UVs vary in both directions, so the derivative tangent frame is never
    # degenerate — the old constant-UV petiole is what speckled.
    (u0, u1), (v0, v1) = PETIOLE_UV
    pu = (u >= u0 - 0.004) & (u <= u1 + 0.004) & (v >= v0 - 0.004) & (v <= v1 + 0.004)
    stalk = 0.74 - 0.08 * np.clip((v1 - v) / (v1 - v0), 0.0, 1.0)
    detail = np.where(pu, stalk, detail)

    # normal from the height field (central differences), strength tuned for
    # world-unit blades ~ 50 units across a 512 map
    gy, gx = np.gradient(height)
    # 3.6 (was 2.2): the veins were "visible only as faint lines" in the
    # engine (workbench-leaf.png / city-leaf.png, loop 3 r2)
    strength = float(arg("vein-strength", "3.6"))
    nx_, ny_ = -gx * strength, gy * strength   # image rows run DOWN, v runs up
    nz_ = np.ones_like(nx_)
    norm = np.sqrt(nx_ ** 2 + ny_ ** 2 + nz_ ** 2)
    normal = np.stack([nx_ / norm, ny_ / norm, nz_ / norm], axis=-1)
    # half resolution for the normal map: the relief survives a 2x2 box filter
    # and the file drops from ~75 kB to ~20 kB (the veinlet lattice is high-
    # frequency and PNG cannot compress it at full size)
    normal = normal.reshape(n // 2, 2, n // 2, 2, 3).mean(axis=(1, 3))
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    normal = normal * 0.5 + 0.5
    det_rgb = np.stack([detail, detail * 0.985, detail * 0.94], axis=-1)  # veins a touch warmer
    return np.clip(det_rgb, 0, 1), normal


def build_leaf():
    reset_scene()
    outline = leaf_outline()
    # constrained Delaunay: outline edges + an interior lattice, so the blade
    # can BEND (cup + curl) instead of being a flat fan
    pts = [Vector((x, y)) for x, y in outline]
    nb = len(pts)
    edges = [(k, (k + 1) % nb) for k in range(nb)]
    poly = np.array(outline)
    # PRIMARY VEINS as constraint polylines: the blade creases along them (the
    # pleat in bend() puts every vein in a valley), and a crease only reads if
    # the mesh has an edge ON the vein — a lattice triangle spanning it would
    # average the fold away.
    hub = (0.0, 0.06)
    inner = [Vector(hub)]
    vein_edges = []
    for tx, ty in LEAF_TIPS:
        fracs = (0.22, 0.42, 0.62, 0.8) if tx == 0.0 else (0.3, 0.55, 0.78) if ty > 0.5 else (0.35, 0.68)
        prev = 0
        for f in fracs:
            x, y = hub[0] + (tx - hub[0]) * f, hub[1] + (ty - hub[1]) * f
            if not (_inside(poly, x, y) and _edge_clear(poly, x, y, 0.03)):
                break
            inner.append(Vector((x, y)))
            vein_edges.append((nb + prev, nb + len(inner) - 1))
            prev = len(inner) - 1
    veins_pts = np.array([(v.x, v.y) for v in inner])
    # …plus a SPARSE lattice between the veins (coarser than the round-1 0.11
    # pitch, which went into budget for the teeth and the veins)
    step = 0.10  # dense enough that the margin curl does not facet (flagleaf1 previews)
    for gy in np.arange(0.05, 1.0, step):
        for gx in np.arange(-0.62, 0.62, step):
            x = gx + (step / 2 if int(round(gy / step)) % 2 else 0.0)
            if not (_inside(poly, x, gy) and _edge_clear(poly, x, gy, step * 0.3)):
                continue
            if np.min(np.hypot(veins_pts[:, 0] - x, veins_pts[:, 1] - gy)) < step * 0.55:
                continue
            inner.append(Vector((x, gy)))
    # the outline runs apex -> right margin -> base -> left margin: clockwise,
    # so the constraint FACE is given reversed (CCW); output 1 keeps only the
    # triangles inside it — every sinus stays cut, every lobe stays filled
    outline_face = list(reversed(range(nb)))
    verts, cdt_edges, faces, orig_v, orig_e, orig_f = delaunay_2d_cdt(pts + inner, edges + vein_edges, [outline_face], 1, 1e-6)
    print(f"[canadiana] leaf: {nb} margin points (official flag silhouette), {len(inner)} interior, {len(faces)} blade tris")

    vein_ang = sorted(math.atan2(tx, ty - hub[1]) for tx, ty in LEAF_TIPS)
    vein_ang = [vein_ang[0] - 0.7] + vein_ang + [vein_ang[-1] + 0.7]  # bound the base gaps
    ox, oy = poly[:, 0], poly[:, 1]
    ox1, oy1 = np.roll(ox, -1), np.roll(oy, -1)

    def bend(x, y):
        """A dry sugar-maple blade, not a die-cut (critique: "almost planar").
        Three terms, all smooth functions of position:
          V-FOLD  — both halves rise from the midrib, like a half-open book;
          PLEATS  — every primary vein sits in a valley, the blade between two
                    veins bulges up (the palmate relief a real leaf has);
          CURL    — the margin rolls UP as a drying leaf's does, so the
                    silhouette lifts off the surface it lies on."""
        r = math.hypot(x - hub[0], y - hub[1])
        th = math.atan2(x - hub[0], y - hub[1])
        # VIEW3D QUALITY LOOP 3 halves all three amplitudes (vfold 0.12, pleat
        # 0.045, curl 0.045 before): seen at the iso camera's 35-45 degrees, the
        # cupped blade folded its own lateral lobes behind the central one and
        # the flag outline read as "a wide, flattened star" (workbench-leaf.png).
        # Nearly planar, the 11 points survive the oblique view; the relief
        # that remains is enough to catch the light along the veins.
        #
        # LOOP 3 r2 puts back a relief that SHOWS, without the cup: the
        # halved blade "lies perfectly flat, no curl, no lift, no contact
        # shadow under the tips" (workbench-leaf.png). The V-fold and the
        # pleats stay low (they are what folded the lateral lobes behind the
        # central one); what returns is LIFT AT THE LOBE TIPS — a dry leaf
        # rests on its midrib and its points rise — plus a margin curl of
        # 0.035. TIP_LIFT 0.048 of the leaf height at the apex, ~0.045 at the
        # lateral points, ~0 at the basal lobes (they hug the petiole): the
        # outline still reads flat-on from the iso camera, and every point
        # stands off its contact decal.
        vfold = 0.06 * abs(x) * (1.0 - 0.25 * max(0.0, y))
        k = next((i for i in range(1, len(vein_ang)) if th <= vein_ang[i]), len(vein_ang) - 1)
        lo, hi = vein_ang[k - 1], vein_ang[k]
        s = min(1.0, max(0.0, (th - lo) / max(1e-6, hi - lo)))
        pleat = 0.022 * min(r, 0.9) * math.sin(math.pi * s) ** 2
        dm = float(np.min(segment_distance(np.array(x), np.array(y), ox, oy, ox1, oy1)[0]))
        curl = 0.035 * max(0.0, 1.0 - dm / 0.12) ** 2 * min(1.0, r / 0.35)
        lift = TIP_LIFT * min(1.0, max(0.0, (r - 0.3) / 0.5)) ** 1.6
        return vfold + pleat + curl + lift

    me = bpy.data.meshes.new("maple-leaf")
    co = [(v.x, v.y, bend(v.x, v.y)) for v in verts]
    me.from_pydata(co, [], [tuple(f) for f in faces])
    me.update()
    obj = bpy.data.objects.new("maple-leaf", me)
    bpy.context.collection.objects.link(obj)
    uvl = me.uv_layers.new(name="UVMap")
    for p in me.polygons:
        for li in p.loop_indices:
            vco = me.vertices[me.loops[li].vertex_index].co
            uvl.data[li].uv = leaf_uv(vco.x, vco.y)
    shade_smooth(obj, 180)

    # petiole: THE FLAG'S STEM (view3d quality loop 3). The bowed tube that
    # tapered to a 0.011 tip read as "long, curved hair-thin tails" and, where
    # one blade lay on another, as a thorn (workbench-leaf.png). The flag's
    # stem is a short straight WEDGE that WIDENS toward its foot, and the
    # official path gives it exactly: half-width FLAG_STEM_TOP at the junction
    # to FLAG_STEM_FOOT at the foot, over PETIOLE_LEN. The section is a
    # flattened ellipse (a stalk lying on a surface reads by its plan width).
    # It maps onto its own UV island (PETIOLE_UV) with u around the stalk and
    # v along it — a seam column of duplicate vertices keeps u continuous — so
    # the detail map paints it a solid stalk tone and the derivative tangent
    # frame is well defined everywhere on it.
    seg, rings = 6, 4
    (pu0, pu1), (pv0, pv1) = PETIOLE_UV
    z_join = bend(0.0, 0.04)
    y_in = 0.04  # the stalk starts INSIDE the blade, so the join never gaps
    p_co, p_uv, p_faces = [], [], []
    for k in range(rings):
        t = k / (rings - 1)
        cy = y_in - (PETIOLE_LEN + y_in) * t
        hw = FLAG_STEM_TOP + (FLAG_STEM_FOOT - FLAG_STEM_TOP) * (-cy / PETIOLE_LEN)  # linear in y, like the path
        rz = 0.5 * hw + 0.004
        # the stalk BENDS UP off the desk toward its cut end (loop 3 r2: a
        # straight stalk lying on the surface read as a pin through the
        # neighbouring blade); quadratic, so it leaves the blade tangentially
        tb = max(0.0, -cy / PETIOLE_LEN)
        cz = z_join - 0.004 + STEM_RISE * tb * tb
        for s in range(seg + 1):
            a = 2 * math.pi * s / seg
            p_co.append((hw * math.cos(a), cy, cz + rz * math.sin(a)))
            p_uv.append((pu0 + (pu1 - pu0) * s / seg, pv1 - (pv1 - pv0) * t))
    row = seg + 1
    for k in range(rings - 1):
        for s in range(seg):
            a0, a1 = k * row + s, k * row + s + 1
            b0, b1 = a0 + row, a1 + row
            p_faces.append((a0, a1, b1, b0))
    end = (rings - 1) * row
    p_faces.append(tuple(end + s for s in range(seg)))  # cut end cap, facing −Y (outward)
    pme = bpy.data.meshes.new("petiole")
    pme.from_pydata(p_co, [], p_faces)
    pme.update()
    petiole = bpy.data.objects.new("petiole", pme)
    bpy.context.collection.objects.link(petiole)
    puv = pme.uv_layers.new(name="UVMap")
    cap_c = ((pu0 + pu1) / 2, pv0 + 0.012)
    cap_r = min(pu1 - pu0, 0.02) * 0.4
    for p in pme.polygons:
        is_cap = len(p.vertices) == seg
        for j, li in enumerate(p.loop_indices):
            if is_cap:
                # the cap's ring has ONE v: mapped like the side it would be
                # a UV line, i.e. the collapsed-UV triangles this island
                # exists to remove. A small disc of its own instead.
                a = 2 * math.pi * j / seg
                puv.data[li].uv = (cap_c[0] + cap_r * math.cos(a), cap_c[1] + cap_r * math.sin(a))
            else:
                puv.data[li].uv = p_uv[pme.loops[li].vertex_index]
    shade_smooth(petiole, 180)

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    petiole.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.join()

    detail, normal = leaf_maps()
    dimg = image_from_array("maple-leaf-detail", detail)
    nimg = image_from_array("maple-leaf-normal", normal, non_color=True)
    obj.data.materials.clear()
    # roughness 0.72 (was 0.55): a dry leaf is matte. At 0.55 a blade lying
    # flat under the key mirrored it toward the iso camera and the sheen
    # washed the vermilion into salmon and the brown into grey (loop 3 r2)
    obj.data.materials.append(make_material("maple-leaf", dimg, roughness=0.72, normal=nimg, double_sided=True))
    return obj


def _inside(poly, x, y):
    x0, y0 = poly[:, 0], poly[:, 1]
    x1, y1 = np.roll(x0, -1), np.roll(y0, -1)
    cond = (y0 > y) != (y1 > y)
    xint = x0 + (y - y0) * (x1 - x0) / np.where(y1 - y0 == 0, 1e-12, y1 - y0)
    return bool(np.count_nonzero(cond & (x < xint)) % 2)


def _edge_clear(poly, x, y, dmin):
    x0, y0 = poly[:, 0], poly[:, 1]
    x1, y1 = np.roll(x0, -1), np.roll(y0, -1)
    d, _ = segment_distance(np.array(x), np.array(y), x0, y0, x1, y1)
    return bool(np.min(d) > dmin)


# ── material + export ────────────────────────────────────────────────────────

def make_material(name, base_img, roughness=0.6, normal=None, vertex_color=False, double_sided=False, metal_rough=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = base_img
    if vertex_color:
        vc = nt.nodes.new("ShaderNodeVertexColor")
        vc.layer_name = "Color"
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        nt.links.new(tex.outputs["Color"], mix.inputs[6])
        nt.links.new(vc.outputs["Color"], mix.inputs[7])
        nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
    else:
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = 0.0
    if metal_rough is not None:
        # the glTF exporter recognises Separate Color G -> Roughness and
        # B -> Metallic from ONE image and writes it as the material's
        # metallicRoughnessTexture (factors 1.0: the texels carry the values)
        mtex = nt.nodes.new("ShaderNodeTexImage")
        mtex.image = metal_rough
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(mtex.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    if normal is not None:
        ntex = nt.nodes.new("ShaderNodeTexImage")
        ntex.image = normal
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(ntex.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    mat.use_backface_culling = not double_sided
    return mat


def export(obj, filename):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    path = os.path.join(OUT, filename)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_vertex_color="ACTIVE",
        export_all_vertex_colors=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
    )
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print(f"[canadiana] wrote {path}  {os.path.getsize(path)} bytes  {tris} tris")


def preview(obj, filename, cam_loc, target, ortho_scale=None, size=(900, 700)):
    if not PREVIEW:
        return
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = size
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.82, 0.74, 0.62, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.9
    scene.world = world
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    cam.location = cam_loc
    direction = Vector(target) - Vector(cam_loc)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    if ortho_scale:
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = ortho_scale
    scene.camera = cam
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), 0, math.radians(-40))
    scene.collection.objects.link(sun)
    scene.render.filepath = os.path.join(os.path.abspath(PREVIEW), filename)
    bpy.ops.render.render(write_still=True)
    print(f"[canadiana] preview {scene.render.filepath}")


def tint_for_preview(obj, rgb):
    """AFTER export only: multiply the base colour by a blade tone, the way the
    engine's vertex colours will, so the preview judges what ships."""
    nt = obj.data.materials[0].node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    link = bsdf.inputs["Base Color"].links[0]
    src = link.from_socket
    nt.links.remove(link)
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    nt.links.new(src, mix.inputs[6])
    mix.inputs[7].default_value = (*srgb_to_linear(rgb), 1.0)
    nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])


if __name__ == "__main__":
    flag = build_flag()
    export(flag, "canada-flag.glb")
    preview(flag, "flag.png", (95, -120, 75), (24, 0, 40))
    preview(flag, "flag-oblique.png", (150, -55, 62), (26, 0, 45))  # fold depth
    leaf = build_leaf()
    export(leaf, "maple-leaf.glb")
    tint_for_preview(leaf, hex_rgb("#C0392B"))
    preview(leaf, "leaf-top.png", (0, 0.4, 3), (0, 0.4, 0), ortho_scale=1.5)
    preview(leaf, "leaf-34.png", (0.9, -0.9, 1.1), (0, 0.45, 0))
    preview(leaf, "leaf-low.png", (1.6, -0.6, 0.35), (0, 0.45, 0.02))
    # the DARK break too: the veins must survive on the ochre blade
    mix = next(n for n in leaf.data.materials[0].node_tree.nodes if n.bl_idname == "ShaderNodeMix")
    mix.inputs[7].default_value = (*srgb_to_linear(hex_rgb("#8A5A2B")), 1.0)
    preview(leaf, "leaf-ochre.png", (0.9, -0.9, 1.1), (0, 0.45, 0))
