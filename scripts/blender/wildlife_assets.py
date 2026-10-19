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

"""Desk wildlife, authored in Blender and exported as glTF binaries.

    blender --background --factory-startup --python scripts/blender/wildlife_assets.py -- \
        --out src/canvas3d/decor/assets [--preview reports/view3d-quality/blender/<run>]

  beaver.glb    a sitting, hunched beaver gnawing a stick: the body is a
                metaball sculpt (haunches, belly, shoulders, head, cheeks,
                ears) converted, lightly displaced and decimated; the face
                carries eyes, a dark nose and two short amber incisors; forepaws
                hold a gnawed stick; big webbed hind feet; and the flat tail
                with a baked scale-pattern normal map. One mesh, one material:
                fur tones ride COLOR_0 (dark back, lighter belly and muzzle),
                multiplied by a near-white DETAIL map (fur clumps, tail
                scales), with a tangent-space NORMAL map and a metallic-
                roughness map (glossy eyes and nose, waxy tail, matte fur).

  moose.glb     a standing bull: the same pipeline, with tapered jointed legs
                (a muscular forearm and gaskin, knobby knees and hocks, slim
                cannon bones), a shoulder hump, the bell and palmate antlers
                — since loop 4 r5 a short beam with its burr into ONE smooth,
                cupped, lens-thick palm sheet whose outer rim carries eight
                tapered tines (antler_sheet: a CDT of the 2-D outline lifted
                onto the dish, Catmull-Clark smoothed, decimated), with
                export-time gates on their thickness and pose (antler_gates).

Loop 4 r3 ("faceted, lumpy low-poly shading up close"): each body is now TWO
meshes from one metaball field — a fine HIGH sculpt (smooth surface, the
muscle masses, a fur-clump displacement) and the LOW mesh that ships,
decimated to ~3.3-3.6k triangles, smooth-shaded with a WeightedNormal pass.
The high sculpt is BAKED onto the low one as a tangent-space normal map
(Cycles, selected-to-active), so the shading follows the smooth sculpt
instead of the decimated facets; the fine fur strokes ride on top of it.
The low mesh is never displaced (its lumps were the "patchwork" critique).

Deterministic: fixed-seed RNG for the texture strokes, no wall clock. Scene
units are the engine's world units (the desk pencil is 78 long). Blender is
Z-up and the glTF exporter converts to Y-up; the beaver faces Blender +X,
which stays +X — the procedural beaver's convention (head at +X). The origin
is on the ground at the centre of the plan-view bounding box, so the
footprint is a rotation-safe radius about it.

Shares its helpers (image packing, material, export, preview) with
canadiana_assets.py, imported as a module — the same args drive both.
"""

import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector
from mathutils.geometry import delaunay_2d_cdt

sys.dont_write_bytecode = True  # no __pycache__ beside the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import canadiana_assets as ca  # noqa: E402  (helpers; its __main__ does not run)

TEX = 256   # detail + metal-rough atlas side (low-frequency content)
NTEX = 512  # normal map side: the baked sculpt needs the texels (<= 512 gate)

# atlas regions (glTF u right, v DOWN from the top row): fur | tail scales |
# neutral (eyes, nose, teeth, stick, feet).
FUR_UV = (0.02, 0.02, 0.48, 0.98)      # u0, v0, u1, v1
SCALE_UV = (0.52, 0.02, 0.98, 0.56)
NEUTRAL_UV = (0.52, 0.62, 0.98, 0.98)
GLOSS_UV = (0.52, 0.62, 0.70, 0.78)   # inside NEUTRAL: eyes + nose (glossy)
# inside NEUTRAL, clear of GLOSS: the beaver's stick, in its own matte slot
# (loop 4 r5 workbench-beaver.png: "the stick's blown specular highlight" —
# it shared the neutral 0.7 roughness with the paws and the teeth)
STICK_UV = (0.74, 0.62, 0.98, 0.98)
# …so the beaver's other neutral parts (ears, teeth, paws, feet) keep to the
# strip between GLOSS and STICK instead of the whole NEUTRAL block (which
# spans both)
PARTS_UV = (0.52, 0.80, 0.72, 0.98)

# fur palette (sRGB)
FUR_BACK = ca.hex_rgb("#45291A")
FUR_BASE = ca.hex_rgb("#6E4326")
FUR_BELLY = ca.hex_rgb("#A27248")
FUR_MUZZLE = ca.hex_rgb("#A57650")
PAW = ca.hex_rgb("#3A2A20")
TAIL = ca.hex_rgb("#3C3532")
NOSE = ca.hex_rgb("#1A1412")
EYE = ca.hex_rgb("#0B0908")
LID = ca.hex_rgb("#24160E")  # the bare lid rim round the eye, darker than the fur
# a beaver's incisor enamel is iron-stained orange-AMBER, not neon (loop 4
# r5: "two long saturated-orange slabs" at #E3812B)
TOOTH = ca.hex_rgb("#C9782F")
BARK = ca.hex_rgb("#4C3C2B")
GNAWED = ca.hex_rgb("#D9BF8E")


# ── textures ────────────────────────────────────────────────────────────────

def _region_px(region, size=TEX):
    u0, v0, u1, v1 = region
    return int(u0 * size), int(v0 * size), int(u1 * size), int(v1 * size)


def fur_strokes(rng, shape, n, length, width, tone):
    """Overlapping short hair strokes in a (h, w) patch: (height, tone delta).
    Each stroke is drawn in its own small window (an all-patch distance field
    per stroke cost minutes at the 512-px normal map)."""
    h, w = shape
    fur_h = np.zeros(shape)
    fur_t = np.zeros(shape)
    for _ in range(n):
        cx = rng.uniform(0, w)
        cy = rng.uniform(0, h)
        a = rng.uniform(0, math.pi)
        ln = rng.uniform(*length)
        dx, dy = math.cos(a) * ln / 2, math.sin(a) * ln / 2
        bx0 = max(0, int(cx - abs(dx) - width - 1))
        bx1 = min(w, int(cx + abs(dx) + width + 2))
        by0 = max(0, int(cy - abs(dy) - width - 1))
        by1 = min(h, int(cy + abs(dy) + width + 2))
        if bx1 <= bx0 or by1 <= by0:
            continue
        yy, xx = np.mgrid[by0:by1, bx0:bx1].astype(np.float64)
        d, t = ca.segment_distance(xx, yy, cx - dx, cy - dy, cx + dx, cy + dy)
        # a hair is thicker at its root (t = 0) than at its tip
        wgt = np.clip(1.0 - d / (width * (1.15 - 0.5 * t)), 0.0, 1.0)
        fur_h[by0:by1, bx0:bx1] = np.maximum(fur_h[by0:by1, bx0:bx1], wgt * rng.uniform(0.5, 1.0))
        fur_t[by0:by1, bx0:bx1] += wgt * rng.uniform(*tone)
    return fur_h, fur_t


def height_normal(height, s):
    """Tangent-space normal (unit vectors) from a height field, row 0 = top:
    central differences, y down -> +v (OpenGL / glTF convention)."""
    gy, gx = np.gradient(height)
    n = np.dstack([-gx * s, gy * s, np.ones_like(height)])
    return n / np.linalg.norm(n, axis=2, keepdims=True)


def whiteout(base, detail):
    """Blend a detail normal onto a base normal (both unit, tangent space)."""
    n = np.dstack([base[..., 0] + detail[..., 0], base[..., 1] + detail[..., 1], base[..., 2] * detail[..., 2]])
    return n / np.linalg.norm(n, axis=2, keepdims=True)


def upsample(a, size):
    """Nearest-neighbour resize of a (TEX, TEX[, c]) field to size x size."""
    k = size // a.shape[0]
    return np.repeat(np.repeat(a, k, axis=0), k, axis=1)


def fauna_normal(height, baked, fur_region, fur_seed, fur_n, fur_len, fur_width, s=1.6, fur_relief=0.6,
                 baked_regions=()):
    """The shipped normal map at NTEX: the procedural relief (tail scales,
    antler grain…) everywhere, and inside the FUR region the BAKED sculpt
    with the fine hair strokes blended on top. Each of `baked_regions` (the
    moose's antler slot) also keeps the bake — the sculpt's curvature — with
    the procedural relief of that region blended on top of it."""
    proc = height_normal(upsample(height, NTEX), s / 2.0)
    n = proc.copy()
    if baked is not None:
        x0, y0, x1, y1 = _region_px(fur_region, NTEX)
        b = baked[y0:y1, x0:x1] * 2.0 - 1.0
        b /= np.linalg.norm(b, axis=2, keepdims=True)
        rng = np.random.default_rng(fur_seed)
        fh, _t = fur_strokes(rng, b.shape[:2], fur_n, fur_len, fur_width, (0.0, 0.0))
        n[y0:y1, x0:x1] = whiteout(b, height_normal(fh * fur_relief, 1.1))
        for region in baked_regions:
            x0, y0, x1, y1 = _region_px(region, NTEX)
            b = baked[y0:y1, x0:x1] * 2.0 - 1.0
            b /= np.linalg.norm(b, axis=2, keepdims=True)
            n[y0:y1, x0:x1] = whiteout(b, proc[y0:y1, x0:x1])
    return n * 0.5 + 0.5


def beaver_maps(baked=None):
    """(detail RGB @TEX, normal RGB @NTEX, metal-rough RGB @TEX), row 0 = top
    (glTF v = 0). `baked` is the sculpt's normal bake at NTEX (or None)."""
    rng = np.random.default_rng(20261009)
    detail = np.ones((TEX, TEX, 3))
    height = np.zeros((TEX, TEX))
    rough = np.full((TEX, TEX), 0.82)

    # FUR: overlapping short strokes, a few px long, light and dark — reads
    # as clumped guard hair at the 30-60 px a beaver is drawn at, and as a
    # soft mottling up close. Isotropic on purpose: smart-UV islands turn.
    x0, y0, x1, y1 = _region_px(FUR_UV)
    fur_h, fur_t = fur_strokes(rng, (y1 - y0, x1 - x0), 900, (3.0, 7.0), 1.1, (-0.10, 0.06))
    detail[y0:y1, x0:x1] = np.clip(0.92 + fur_t, 0.74, 1.0)[..., None]
    height[y0:y1, x0:x1] = fur_h * 0.6
    # a satin sheen along the guard hairs: the stroke crests are less rough
    rough[y0:y1, x0:x1] = 0.84 - 0.16 * fur_h

    # TAIL SCALES: a 45-degree diamond lattice, each scale a low dome with a
    # darker groove around it — the beaver tail's leathery crosshatch.
    x0, y0, x1, y1 = _region_px(SCALE_UV)
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float64)
    P = 9.0
    a = (xx + yy) / P
    b = (xx - yy) / P
    fa = a - np.floor(a) - 0.5
    fb = b - np.floor(b) - 0.5
    r = np.maximum(np.abs(fa), np.abs(fb)) * 2  # 0 centre .. 1 groove
    dome = np.clip(1.0 - r ** 2, 0.0, 1.0)
    cell = (np.floor(a) * 7 + np.floor(b) * 13) % 5
    tone = 0.9 + 0.04 * (cell / 4.0)
    groove = np.clip((r - 0.78) / 0.22, 0.0, 1.0)
    detail[y0:y1, x0:x1] = np.clip(tone - 0.42 * groove, 0.4, 1.0)[..., None]
    height[y0:y1, x0:x1] = dome * 1.4
    rough[y0:y1, x0:x1] = 0.58 + 0.12 * groove

    # NEUTRAL (stick, feet, teeth) and the GLOSS patch (eyes, nose)
    x0, y0, x1, y1 = _region_px(NEUTRAL_UV)
    rough[y0:y1, x0:x1] = 0.7
    gx0, gy0, gx1, gy1 = _region_px(GLOSS_UV)
    rough[gy0:gy1, gx0:gx1] = 0.12
    # the stick: dry bark and chewed wood are matte (no blown highlight)
    sx0, sy0, sx1, sy1 = _region_px(STICK_UV)
    rough[sy0:sy1, sx0:sx1] = 0.94

    normal = fauna_normal(height, baked, FUR_UV, 20261019, 3400, (6.0, 13.0), 1.3)
    mr = np.zeros((TEX, TEX, 3))
    mr[..., 1] = rough
    return detail, normal, mr


# ── geometry helpers ────────────────────────────────────────────────────────

def activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_modifiers(obj):
    activate(obj)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def smart_uv(obj, region, angle=66.0):
    """Smart-project the object, then fit its islands into an atlas region
    (glTF v down; Blender UV v up — flipped here). Islands are never
    collapsed, so derivative tangents stay sane on every triangle."""
    activate(obj)
    me = obj.data
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=0.02, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    u0, v0, u1, v1 = region
    for loop in me.uv_layers[0].data:
        u, v = loop.uv
        # region given top-down; Blender stores bottom-up
        loop.uv = (u0 + u * (u1 - u0), (1 - v1) + v * (v1 - v0))


def region_uv_planar(obj, region, axes=None):
    """UVs for the small flat-coloured parts (eyes, nose, teeth, paws): their
    islands smart-projected into a patch of the atlas. A single planar
    projection was tried first and glbAssets.test.ts caught it: ANY linear
    3D -> 2D map collapses the faces parallel to its kernel (the incisors'
    side faces mapped to a UV line, ratio 0) — and derivative tangents
    divide by that area. `axes` is kept for the call sites' readability."""
    smart_uv(obj, region)


def paint(obj, fn):
    """COLOR_0 per corner from (position, normal) — sRGB authored."""
    me = obj.data
    attr = me.color_attributes.get("Color") or me.color_attributes.new(name="Color", type="FLOAT_COLOR", domain="CORNER")
    for poly in me.polygons:
        for li in poly.loop_indices:
            v = me.vertices[me.loops[li].vertex_index]
            c = ca.srgb_to_linear(np.clip(fn(v.co, v.normal), 0, 1))
            attr.data[li].color = (c[0], c[1], c[2], 1.0)
    me.color_attributes.active_color = attr


def flat_color(obj, rgb):
    paint(obj, lambda co, n: rgb)


def ellipsoid(name, center, radii, segs=16, rings=10, rot=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=rings, radius=1.0, location=(0, 0, 0))
    o = bpy.context.active_object
    o.name = name
    o.scale = radii
    if rot is not None:
        o.rotation_euler = rot
    o.location = center
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return o


def capsule_between(name, a, b, r, segs=8):
    a, b = Vector(a), Vector(b)
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=segs, radius=r, depth=d.length, location=(0, 0, 0))
    o = bpy.context.active_object
    o.name = name
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = d.to_track_quat("Z", "Y")
    o.location = (a + b) / 2
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return o


def stick_mesh(a, b, r, rings=7, segs=7):
    """A slightly crooked branch from a to b: rings along the length (so the
    bark and the chewed ends can take different colours) and closed ends."""
    a, b = Vector(a), Vector(b)
    axis = b - a
    q = axis.to_track_quat("Z", "Y")
    bm = bmesh.new()
    loops = []
    for i in range(rings):
        t = i / (rings - 1)
        bend = Vector((0.6 * math.sin(t * math.pi), 0, 0.35 * math.sin(t * 2 * math.pi)))
        c = a + axis * t + bend
        rr = r * (0.88 if i in (0, rings - 1) else 1.0)
        ring = []
        for k in range(segs):
            ang = 2 * math.pi * k / segs
            ring.append(bm.verts.new(c + q @ Vector((rr * math.cos(ang), rr * math.sin(ang), 0))))
        loops.append(ring)
    for r0, r1 in zip(loops, loops[1:]):
        for k in range(segs):
            bm.faces.new((r0[k], r0[(k + 1) % segs], r1[(k + 1) % segs], r1[k]))
    bm.faces.new(list(reversed(loops[0])))
    bm.faces.new(loops[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("stick")
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new("stick", me)
    bpy.context.collection.objects.link(obj)
    smooth(obj, 50)
    return obj


def smooth(obj, angle=60):
    """Smooth shading with the edges sharper than `angle` marked sharp IN THE
    MESH. (The old shade_auto_smooth added a Smooth-by-Angle modifier, which
    `join` silently drops from every part but the active one — so the body's
    80-degree split ran over the whole joined mesh at export.)"""
    obj.data.shade_smooth()
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    lim = math.radians(angle)
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > lim:
            e.smooth = False
    bm.to_mesh(obj.data)
    bm.free()


def mb_to_mesh(mb_obj, res, name):
    """Polygonise a metaball field at `res` into a NEW mesh object; the
    metaball stays, so the same field converts again at another resolution
    (the low mesh and the high sculpt share one shape by construction)."""
    mb_obj.data.resolution = res
    mb_obj.data.render_resolution = res
    bpy.context.view_layer.update()
    activate(mb_obj)
    bpy.ops.object.convert(target="MESH", keep_original=True)
    o = bpy.context.active_object
    o.name = name
    return o


def seat_cut(obj):
    """Everything under the desk plane is cut away and capped flat."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    res = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-4,
                                 plane_co=(0, 0, 0.0), plane_no=(0, 0, 1), clear_inner=True)
    cut = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
    if cut:
        bmesh.ops.holes_fill(bm, edges=cut, sides=0)
    bm.to_mesh(obj.data)
    bm.free()


def collapsed_uv_faces(obj):
    """Faces with real area whose UV triangle(s) have none — derivative
    tangents divide by the UV area (glbAssets.test.ts gates the shipped GLB)."""
    me = obj.data
    uv = me.uv_layers[0].data
    bad = []
    for p in me.polygons:
        if p.area < 1e-6:
            continue
        li = list(p.loop_indices)
        for k in range(1, len(li) - 1):
            a, b, c = (uv[li[0]].uv, uv[li[k]].uv, uv[li[k + 1]].uv)
            if abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2 < 1e-12:
                bad.append(p.index)
                break
    return bad


def tris_of(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def decimate_to(obj, target):
    tris = tris_of(obj)
    if tris > target:
        dec = obj.modifiers.new("dec", "DECIMATE")
        dec.ratio = target / tris
        dec.use_collapse_triangulate = True
        apply_modifiers(obj)
    activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.quads_convert_to_tris()
    bpy.ops.object.mode_set(mode="OBJECT")
    return tris


def finish_body_normals(obj):
    """The shipped body: fully smooth (no split edge anywhere on the fur), then
    a face-area WeightedNormal pass — a decimated mesh's long thin triangles
    otherwise drag each vertex normal toward their own tilt (the facet
    patchwork of loop4-r3 workbench-moose.png)."""
    obj.data.shade_smooth()
    if ca.arg("no-wn"):
        return
    wn = obj.modifiers.new("wn", "WEIGHTED_NORMAL")
    wn.mode = "FACE_AREA"
    wn.weight = 50
    wn.keep_sharp = False
    apply_modifiers(obj)


def fur_clumps(obj, scale, strength, name):
    """The HIGH sculpt's fur: a Voronoi field of clumps pushed out along the
    normal (never applied to the shipped low mesh)."""
    tex = bpy.data.textures.new(name, type="VORONOI")
    tex.noise_scale = scale
    tex.distance_metric = "DISTANCE"
    disp = obj.modifiers.new("clumps", "DISPLACE")
    disp.texture = tex
    disp.strength = strength
    disp.mid_level = 0.5
    apply_modifiers(obj)


def bake_normals(lo, hi, extrusion, max_dist):
    """Tangent-space normal bake of `hi` onto `lo`'s UVs at NTEX x NTEX (row 0
    = top, RGB in [0, 1]). Texels no island covers stay flat (0.5, 0.5, 1)."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 4
    img = bpy.data.images.new("bake-normal", NTEX, NTEX, float_buffer=True, is_data=True)
    img.colorspace_settings.name = "Non-Color"
    flat = np.tile(np.array([0.5, 0.5, 1.0, 1.0], dtype=np.float32), NTEX * NTEX)
    img.pixels.foreach_set(flat)
    saved = list(lo.data.materials)
    mat = bpy.data.materials.new("bake-target")
    mat.use_nodes = True
    node = mat.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = img
    mat.node_tree.nodes.active = node
    lo.data.materials.clear()
    lo.data.materials.append(mat)
    bpy.ops.object.select_all(action="DESELECT")
    hi.select_set(True)
    lo.select_set(True)
    bpy.context.view_layer.objects.active = lo
    bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", use_selected_to_active=True,
                        cage_extrusion=extrusion, max_ray_distance=max_dist, margin=4, use_clear=False)
    px = np.empty(NTEX * NTEX * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    lo.data.materials.clear()
    for m in saved:
        lo.data.materials.append(m)
    out = np.flipud(px.reshape(NTEX, NTEX, 4))[..., :3].astype(np.float64)
    moved = np.abs(out - np.array([0.5, 0.5, 1.0])).max(axis=2) > 0.01
    print(f"[wildlife] bake: {moved.mean() * 100:.1f}% of texels off flat, mean {out.reshape(-1, 3).mean(axis=0)}")
    assert moved.mean() > 0.05, "the normal bake wrote nothing"
    if ca.PREVIEW:
        img.filepath_raw = os.path.join(os.path.abspath(ca.PREVIEW), f"{lo.name}-bake.png")
        img.file_format = "PNG"
        img.save()
    return out


# ── the beaver ──────────────────────────────────────────────────────────────
# Authored in a body frame (x forward, z up) with the haunches near x = 0;
# re-centred on the plan-view box at the end.

def beaver_body():
    """Metaball sculpt of the fur body: one continuous organic surface."""
    mb = bpy.data.metaballs.new("beaver-mb")
    mb.resolution = 0.9
    mb.render_resolution = 0.9
    mb.threshold = 0.6
    obj = bpy.data.objects.new("beaver-body", mb)
    bpy.context.collection.objects.link(obj)

    def el(co, size, radius=1.0, stiffness=2.0, rot=(0, 0, 0), negative=False):
        e = mb.elements.new(type="ELLIPSOID")
        e.co = co
        e.radius = radius
        e.size_x, e.size_y, e.size_z = size
        e.stiffness = stiffness
        e.rotation = Quaternion(Vector((0, 1, 0)), rot[1]) @ Quaternion(Vector((0, 0, 1)), rot[2]) @ Quaternion(Vector((1, 0, 0)), rot[0])
        e.use_negative = negative
        return e

    lean = -0.42  # the hunch: the trunk leans forward over the haunches
    # haunches: a broad pear seated ON the ground (the bottom is cut flat
    # at z = 0 after conversion — a sitting animal rests its weight there)
    el((0.0, 0.0, 6.8), (11.5, 10.5, 8.0), radius=1.5, stiffness=2.2)
    # belly / trunk, leaning forward
    el((2.6, 0.0, 15.5), (8.6, 8.4, 9.6), radius=1.4, stiffness=2.0, rot=(0, lean, 0))
    # shoulders / chest — a touch narrower than the head, so the skull
    # reads as its own mass (loop4-r3: "the head merges into the torso")
    el((5.4, 0.0, 22.0), (6.4, 6.6, 5.8), radius=1.3, stiffness=2.0, rot=(0, lean, 0))
    # head: rounded skull, a touch wider than tall, lifted and pushed forward
    el((9.0, 0.0, 29.4), (6.4, 6.6, 5.6), radius=1.35, stiffness=2.4)
    # the nape and the throat: two negative elements carve the neck, so a
    # shadowed crease separates the skull from the shoulders front and back
    el((3.0, 0.0, 28.4), (3.2, 7.0, 2.2), radius=1.0, stiffness=1.6, rot=(0, 0.5, 0), negative=True)
    el((11.6, 0.0, 23.0), (2.4, 5.0, 1.6), radius=1.0, stiffness=1.6, rot=(0, -0.3, 0), negative=True)
    # cheeks / muzzle pads (the beaver's blunt square snout) + the jowls
    for s in (-1, 1):
        el((13.8, s * 2.4, 27.6), (3.2, 2.8, 2.7), radius=1.2, stiffness=2.6)
        el((10.6, s * 4.4, 27.0), (3.0, 2.4, 2.6), radius=1.1, stiffness=2.4)
    # snout bridge
    el((14.6, 0.0, 29.4), (2.9, 2.2, 2.1), radius=1.1, stiffness=2.6)
    # thighs bulging at the sides of the haunches
    for s in (-1, 1):
        el((3.0, s * 7.0, 6.4), (6.5, 3.8, 5.2), radius=1.2, stiffness=2.0)
    # shins: the heel of each hind foot runs back INTO the haunch, so the feet
    # grow out of the body instead of lying beside it (t3 side preview)
    for s in (-1, 1):
        el((5.6, s * 6.6, 2.4), (3.6, 2.4, 2.0), radius=1.0, stiffness=2.0)
    # the arms: a short upper arm out of the shoulder, down to the elbow, and
    # the stubby forearm forward to the paws on the stick — capsules, so the
    # limb reads as one continuous arm (the single upper-arm ellipsoid read
    # as a ball stuck on the flank in loop4-r3 beaver-iso.png)
    def cap(a, b, r):
        a, b = Vector(a), Vector(b)
        e = mb.elements.new(type="CAPSULE")
        e.co = (a + b) / 2
        e.radius = r / 0.573  # surface radius r alone (stiffness 2, threshold 0.6)
        e.size_x = (b - a).length / 2
        e.stiffness = 2.0
        e.rotation = Vector((1, 0, 0)).rotation_difference((b - a).normalized())
        return e

    for s in (-1, 1):
        cap((6.2, s * 5.6, 22.4), (8.2, s * 6.2, 18.2), 2.0)
        cap((8.4, s * 6.0, 18.0), (12.6, s * 3.8, 19.2), 1.6)

    # the HIGH sculpt: the same field, fine, with fur clumps — baked, never shipped
    hi = mb_to_mesh(obj, 0.32, "beaver-hi")
    fur_clumps(hi, 0.9, 0.28, "beaver-clumps")
    seat_cut(hi)
    # the LOW mesh that ships: smooth (no displacement — the old cloud lumps
    # were the "lumpy patchwork"), decimated to the budget
    body = mb_to_mesh(obj, 0.5, "beaver-body")
    bpy.data.objects.remove(obj, do_unlink=True)
    seat_cut(body)
    tris = decimate_to(body, 2950)
    print(f"[wildlife] beaver body {tris} -> {tris_of(body)} tris; sculpt {tris_of(hi)} tris")
    finish_body_normals(body)
    return body, hi


def body_color(co, n):
    x, y, z = co
    n = Vector(n)
    # back + crown darker, belly / chest / throat lighter — the countershade
    front = max(0.0, n.x) * (1.0 if z < 26 else 0.4)
    belly = np.clip(front * 1.2 - abs(y) / 9.0, 0, 1)
    back = np.clip(-n.x * 0.8 + max(0.0, n.z) * 0.5, 0, 1)
    c = FUR_BASE * (1 - 0.55 * back) + FUR_BACK * 0.55 * back
    c = c * (1 - belly) + FUR_BELLY * belly
    # muzzle: lighter, slightly greyer
    if x > 11.0 and 24.0 < z < 31.2:
        m = np.clip((x - 11.0) / 2.5, 0, 1)
        c = c * (1 - m) + FUR_MUZZLE * m
    # crown darker
    if z > 31.8:
        c = c * 0.7
    return c


def eye_set(name, c, n, r, lid_rgb, region, part):
    """A glossy black cornea seated at `c` (surface normal `n`), a darker lid
    ring round it, and a white catchlight bead on the cornea toward the key
    light (up and forward) — loop4-r3 city-beaver.png: "the eyes are flat
    black bumps with no catchlight or lid"."""
    n = Vector(n).normalized()
    part(ellipsoid(f"{name}-cornea", c, (r, r, r * 1.05), segs=10, rings=7), EYE, region)
    q = Vector((0, 0, 1)).rotation_difference(n)
    bpy.ops.mesh.primitive_torus_add(major_radius=r * 0.98, minor_radius=r * 0.3, major_segments=10, minor_segments=4)
    lid = bpy.context.active_object
    lid.name = f"{name}-lid"
    lid.data.transform(Matrix.Translation(c + n * (r * 0.28)) @ q.to_matrix().to_4x4())
    part(lid, lid_rgb, NEUTRAL_UV)
    glint_dir = (n + Vector((0.25, 0.0, 0.85))).normalized()
    part(ellipsoid(f"{name}-glint", c + glint_dir * (r * 0.9), (r * 0.26, r * 0.26, r * 0.26), segs=6, rings=4),
         np.array([1.0, 1.0, 1.0]), region)


def build_beaver():
    ca.reset_scene()
    parts = []

    body, hi = beaver_body()
    smart_uv(body, FUR_UV)
    paint(body, body_color)
    parts.append(body)

    # every face part is SEATED on the sculpted surface (ray cast toward the
    # skull), never floated at a guessed coordinate — the first cut's eyes,
    # nose and ears hovered off the head
    bpy.context.view_layer.update()

    def seat(origin, toward, sink):
        o = Vector(origin)
        d = (Vector(toward) - o).normalized()
        hit, loc, nrm, _ = body.ray_cast(o, d)
        assert hit, f"no surface from {origin} toward {toward}"
        return loc - nrm * sink, nrm

    def part(obj, color, region, axes=(0, 1)):
        smooth(obj, 75)
        region_uv_planar(obj, region, axes=axes)
        if callable(color):
            paint(obj, color)
        else:
            flat_color(obj, color)
        parts.append(obj)
        return obj

    head = Vector((9.0, 0.0, 29.4))
    # eyes: glossy black corneas with a lid ring and a catchlight, high on
    # the sides of the head, a bit forward
    for s in (-1, 1):
        c, n = seat(head + Vector((7.0, s * 9.0, 3.4)), head + Vector((1.0, 0, 1.2)), 0.45)
        eye_set(f"eye{s}", c, n, 1.0, LID, GLOSS_UV, lambda o, col, reg: part(o, col, reg))
    # nose: the broad dark leathery pad on the tip of the snout
    c, _n = seat((30.0, 0.0, 29.8), (0.0, 0.0, 29.4), 0.6)
    part(ellipsoid("nose", c, (0.9, 1.7, 1.0), segs=8, rings=5), NOSE, GLOSS_UV, (1, 2))
    # ears: small round dark nubs set back on the skull
    for s in (-1, 1):
        c, n = seat(head + Vector((-2.5, s * 10.0, 8.0)), head + Vector((-2.0, 0, 1.0)), 0.5)
        ear = ellipsoid(f"ear{s}", (0, 0, 0), (1.55, 0.7, 1.55), segs=8, rings=5)
        ear.data.transform(Matrix.Translation(c))
        part(ear, lambda co, nn: FUR_BACK * 0.85, PARTS_UV, (0, 2))
    # incisors: the amber pair under the upper lip — the beaver signature.
    # Seated from BELOW on the underside of the snout, so they hang out of
    # the mouth instead of floating in front of it. Loop 4 r5
    # (workbench-beaver.png: "two long saturated-orange slabs"): a real
    # beaver shows two SHORT, narrow chisel teeth just under the lip — now
    # ~1.1 visible (a quarter of r3's 4.4), 0.62 wide each with a 0.3 gap,
    # the cutting edge bevelled back (a chisel, not a slab).
    for s in (-1, 1):
        cy = s * 0.46
        top, _n = seat((15.4, cy, 21.5), (15.4, cy, 31.0), 0.6)
        surface_z = top.z - 0.6
        print(f"[wildlife] incisor root z {top.z:.2f}")
        bm = bmesh.new()
        hw, d = 0.31, 0.26   # half width (y), half depth (x)
        z_top, z_bot = top.z + 0.2, surface_z - 1.1
        # a box whose BACK bottom edge is lifted: the chisel bevel
        corners = []
        for zz, back_lift in ((z_top, 0.0), (z_bot, 0.45)):
            for xx in (-d, d):
                for yy in (-hw, hw):
                    lift = back_lift if xx < 0 else 0.0
                    corners.append(bm.verts.new((top.x + 0.15 + xx, cy + yy, zz + lift)))
        # 0-3 top (x-,y-),(x-,y+),(x+,y-),(x+,y+); 4-7 bottom, same order
        for f in ((0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)):
            bm.faces.new([corners[i] for i in f])
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        me = bpy.data.meshes.new(f"incisor{s}")
        bm.to_mesh(me)
        bm.free()
        t = bpy.data.objects.new(f"incisor{s}", me)
        bpy.context.collection.objects.link(t)
        # raked forward a touch, about the root (where it leaves the lip)
        pivot = Vector((top.x + 0.15, cy, surface_z))
        me.transform(Matrix.Translation(pivot) @ Matrix.Rotation(-0.10, 4, "Y") @ Matrix.Translation(-pivot))
        bev = t.modifiers.new("bev", "BEVEL")
        bev.width = 0.08
        bev.segments = 2
        apply_modifiers(t)
        part(t, TOOTH, PARTS_UV, (1, 2))
    # the gnawed stick held across the chest: bark, with pale chewed ends
    stick = stick_mesh((15.2, -7.5, 18.6), (14.2, 7.5, 19.8), 1.0)
    part(stick, lambda co, n: GNAWED if abs(co[1]) > 6.8 else BARK, STICK_UV, (1, 2))
    # forepaws, dark, clasping the stick
    for s in (-1, 1):
        part(ellipsoid(f"paw{s}", (13.6, s * 3.4, 19.6), (1.9, 1.5, 1.7), segs=8, rings=5, rot=(0, 0.3, 0)), PAW, PARTS_UV)
        for k in range(3):
            part(ellipsoid(f"kn{s}{k}", (15.0, s * (2.5 + 0.85 * k), 20.6), (0.7, 0.5, 0.55), segs=5, rings=3), PAW, PARTS_UV)
    # hind feet: big, flat and webbed, tucked under the belly, toes forward
    for s in (-1, 1):
        part(ellipsoid(f"foot{s}", (6.8, s * 6.6, 0.9), (5.0, 3.0, 0.9), segs=10, rings=5, rot=(0, 0, s * 0.15)), PAW, PARTS_UV)
        for k in range(3):
            part(ellipsoid(f"toe{s}{k}", (11.4, s * (5.2 + 1.35 * k), 0.8), (1.3, 0.7, 0.75), segs=5, rings=3), PAW, PARTS_UV)
    # the TAIL: a flat leathery paddle behind, lying on the desk, tip lifting
    tail = build_tail()
    parts.append(tail)

    activate(body)
    for p in parts:
        p.select_set(True)
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = "beaver"
    # the bake runs on the mesh EXACTLY as it ships (joined, final normals),
    # so the tangent frame the map was baked in is the one the engine sees;
    # only the FUR region of it is kept (fauna_normal)
    baked = bake_normals(obj, hi, extrusion=0.7, max_dist=1.6)
    bpy.data.objects.remove(hi, do_unlink=True)

    # re-centre: origin on the ground at the centre of the plan-view box
    co = np.array([v.co[:] for v in obj.data.vertices])
    cx = (co[:, 0].min() + co[:, 0].max()) / 2
    cy = (co[:, 1].min() + co[:, 1].max()) / 2
    zmin = co[:, 2].min()
    obj.data.transform(Matrix.Translation((-cx, -cy, -zmin)))
    obj.data.update()

    detail, normal, mr = beaver_maps(baked)
    dimg = ca.image_from_array("beaver-detail", detail)
    nimg = ca.image_from_array("beaver-normal", normal, non_color=True)
    mimg = ca.image_from_array("beaver-mr", mr, non_color=True)
    obj.data.materials.clear()
    obj.data.materials.append(ca.make_material("beaver", dimg, roughness=0.8, normal=nimg, vertex_color=True, metal_rough=mimg))
    co = np.array([v.co[:] for v in obj.data.vertices])
    r = np.hypot(co[:, 0], co[:, 1]).max()
    print(f"[wildlife] beaver extent x {co[:, 0].min():.1f}..{co[:, 0].max():.1f} y {co[:, 1].min():.1f}..{co[:, 1].max():.1f} "
          f"h {co[:, 2].max():.1f} plan radius {r:.1f}")
    return obj


def build_tail():
    """A paddle: an ellipse in plan, thick at the root, thin at the rim,
    lying on the desk and curling up toward the tip."""
    L, W = 22.0, 13.0
    root_x = -6.5
    nu, nv = 12, 8
    bm = bmesh.new()
    top, bot = [], []
    for i in range(nu + 1):
        t = i / nu  # 0 root .. 1 tip
        rowt, rowb = [], []
        half = W / 2 * math.sqrt(max(0.0, 1 - (2 * t - 1) ** 2)) ** 0.8 if 0 < t < 1 else 0.0
        half = max(half, 1.6 if t == 0 else 0.25)
        x = root_x - t * L
        lift = 1.2 + 3.2 * t ** 2.2  # tip curls up off the desk
        thick = 2.2 * (1 - 0.65 * t)
        for j in range(nv + 1):
            s = j / nv * 2 - 1
            y = s * half
            edge = 1 - abs(s) ** 2
            zt = lift + thick * 0.5 * (0.35 + 0.65 * edge)
            zb = lift - thick * 0.5 * (0.35 + 0.65 * edge)
            rowt.append(bm.verts.new((x, y, zt)))
            rowb.append(bm.verts.new((x, y, max(0.0, zb))))
        top.append(rowt)
        bot.append(rowb)
    for i in range(nu):
        for j in range(nv):
            bm.faces.new((top[i][j], top[i + 1][j], top[i + 1][j + 1], top[i][j + 1]))
            bm.faces.new((bot[i][j + 1], bot[i + 1][j + 1], bot[i + 1][j], bot[i][j]))
    for i in range(nu):  # the rims
        for j in (0, nv):
            a, b = (top[i][j], top[i + 1][j]) if j == 0 else (top[i + 1][j], top[i][j])
            c, d = (bot[i + 1][j], bot[i][j]) if j == 0 else (bot[i][j], bot[i + 1][j])
            bm.faces.new((a, b, c, d) if j == 0 else (a, b, c, d))
    for j in range(nv):  # root + tip caps
        bm.faces.new((top[0][j + 1], bot[0][j + 1], bot[0][j], top[0][j]))
        bm.faces.new((top[nu][j], bot[nu][j], bot[nu][j + 1], top[nu][j + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("tail")
    bm.to_mesh(me)
    bm.free()
    tail = bpy.data.objects.new("tail", me)
    bpy.context.collection.objects.link(tail)
    # UV: the top and bottom faces from the plan, scaled into the scale
    # region with one texel density; the thin rims smart-projected into a
    # strip of it (never collapsed)
    tail.data.uv_layers.new(name="UVMap")
    smart_uv(tail, SCALE_UV, angle=50.0)
    smooth(tail, 50)
    flat_color(tail, TAIL)
    return tail


# ── the moose ───────────────────────────────────────────────────────────────
# A standing bull, authored in a body frame (x forward, z up, nose toward +x)
# and re-centred on the plan-view box at the end. Proportions after a bull
# moose: legs as long as the body is deep, a shoulder hump standing over
# slim hindquarters, a short thick neck, a long drooping muzzle with the
# overhanging upper lip, the bell (dewlap) under the throat, and palmate
# antlers spreading wider than the body. Height to the antler tips stays under
# the 64.6 the registry's city scale was measured against.

MOOSE_DARK = ca.hex_rgb("#2B1E15")     # flanks, belly
MOOSE_BASE = ca.hex_rgb("#3F2C1F")
MOOSE_SADDLE = ca.hex_rgb("#5C4331")   # the paler hump / withers
MOOSE_MUZZLE = ca.hex_rgb("#4E3A2C")
MOOSE_LEG = ca.hex_rgb("#8E7D68")      # the greyish "stockings" below the knee
HOOF = ca.hex_rgb("#1B1613")
# bone / ivory tan, paler toward the tine tips (loop 4 r5) — kept a mid
# tone: a bleached palm melts into the pale desk wood at wide framing (the
# procedural moose's #B99C71 lesson; glbAssets.test.ts "never bleached")
ANTLER_BASE = ca.hex_rgb("#8A7150")
ANTLER_TIP = ca.hex_rgb("#B8A27C")

# front (+1) and hind (-1) leg skeletons, one side (y > 0): joint centres and
# the surface radius of the segment that ENDS at each joint
# (loop 4 r3: the forearm / gaskin and the cannon are SLIM bones now — the
# muscle bellies, knees and hocks are their own elements in moose_body)
FRONT_LEG = [((9.5, 4.6, 32.0), 0.0), ((7.0, 4.4, 24.0), 2.7), ((8.0, 4.2, 13.2), 1.15),
             ((8.3, 4.2, 4.2), 0.82), ((9.1, 4.2, 1.6), 0.85)]
HIND_LEG = [((-18.5, 4.8, 35.0), 0.0), ((-14.0, 5.0, 24.5), 3.3), ((-20.0, 4.3, 14.0), 1.2),
            ((-18.6, 4.2, 4.2), 0.88), ((-17.8, 4.2, 1.6), 0.85)]
# loop 4 r4: the head carried HL higher (city-moose.png: with the head hung
# below the withers, the near antler palm lay ON the back in screen space —
# "a saddle"); a bull carries it about level with the shoulders
HL = 2.0
HEAD = Vector((21.5, 0.0, 43.0 + HL))
BURR = Vector((21.0, 2.6, 46.6 + HL))


def moose_maps(baked=None):
    """(detail RGB @TEX, normal RGB @NTEX, metal-rough RGB @TEX) on the
    beaver's atlas layout: FUR | ANTLER grain (in the tail-scale slot) |
    NEUTRAL with the GLOSS patch. `baked`: the sculpt's normal bake."""
    rng = np.random.default_rng(20261010)
    detail = np.ones((TEX, TEX, 3))
    height = np.zeros((TEX, TEX))
    rough = np.full((TEX, TEX), 0.86)

    # FUR: coarser, longer guard hair than the beaver's
    x0, y0, x1, y1 = _region_px(FUR_UV)
    fur_h, fur_t = fur_strokes(rng, (y1 - y0, x1 - x0), 700, (4.0, 9.0), 1.2, (-0.10, 0.07))
    detail[y0:y1, x0:x1] = np.clip(0.92 + fur_t, 0.74, 1.0)[..., None]
    height[y0:y1, x0:x1] = fur_h * 0.6
    # "a hide with no fur sheen" (loop 4 r3): the guard-hair crests are
    # satin, the undercoat between them matte
    rough[y0:y1, x0:x1] = 0.86 - 0.2 * fur_h

    # ANTLER: bone — fine wavy grooves and a few pits, a satin finish
    x0, y0, x1, y1 = _region_px(SCALE_UV)
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float64)
    groove = np.zeros(xx.shape)
    for k in range(5):
        f = rng.uniform(0.35, 0.9)
        ph = rng.uniform(0, 2 * math.pi)
        wob = rng.uniform(2.0, 5.0)
        groove += np.sin(yy * f + np.sin(xx * 0.08 + ph) * wob) * rng.uniform(0.06, 0.12)
    pits = np.zeros(xx.shape)
    for _ in range(60):
        cx = rng.uniform(x0, x1)
        cy = rng.uniform(y0, y1)
        rr = rng.uniform(0.8, 2.0)
        pits = np.maximum(pits, np.clip(1 - np.hypot(xx - cx, yy - cy) / rr, 0, 1))
    g = groove - pits * 0.35
    detail[y0:y1, x0:x1] = np.clip(0.95 + 0.04 * g, 0.78, 1.0)[..., None]
    # a FAINT relief (loop 4 r5: at 0.5 the grooves read as wrinkles across
    # the now-smooth palm; a moose palm is smooth bone with a fine grain)
    height[y0:y1, x0:x1] = g * 0.12
    rough[y0:y1, x0:x1] = 0.55 + 0.1 * pits

    # NEUTRAL (hooves, ears' insides) and the GLOSS patch (eyes, nostrils)
    x0, y0, x1, y1 = _region_px(NEUTRAL_UV)
    rough[y0:y1, x0:x1] = 0.55
    gx0, gy0, gx1, gy1 = _region_px(GLOSS_UV)
    rough[gy0:gy1, gx0:gx1] = 0.12

    # the antler slot keeps its BAKE too (loop 4 r4: the volumetric antler's
    # curvature — beam, burr, rounded tines — rides the sculpt, the bone
    # grooves and pits on top of it)
    normal = fauna_normal(height, baked, FUR_UV, 20261020, 3200, (5.0, 11.0), 1.3, fur_relief=0.35,
                          baked_regions=(SCALE_UV,))
    mr = np.zeros((TEX, TEX, 3))
    mr[..., 1] = rough
    return detail, normal, mr


def moose_body():
    """Metaball sculpt of the whole animal but the antlers, ears, eyes and
    hooves: torso, hump, neck, head, muzzle, bell, and the four jointed legs
    (the field's blend between segments is what swells the knees and hocks)."""
    mb = bpy.data.metaballs.new("moose-mb")
    mb.resolution = 0.42
    mb.render_resolution = 0.42
    mb.threshold = 0.6
    obj = bpy.data.objects.new("moose-body", mb)
    bpy.context.collection.objects.link(obj)
    K = 0.571  # surface half-extent per unit radius x size (stiffness 2, threshold 0.6)

    def ell(co, half, rot=(0.0, 0.0, 0.0)):
        """An ellipsoid with these SURFACE half-extents (alone; blends swell)."""
        e = mb.elements.new(type="ELLIPSOID")
        e.co = co
        e.radius = 1.0 / K
        e.size_x, e.size_y, e.size_z = half
        e.stiffness = 2.0
        e.rotation = Quaternion(Vector((0, 0, 1)), rot[2]) @ Quaternion(Vector((0, 1, 0)), rot[1]) @ Quaternion(Vector((1, 0, 0)), rot[0])
        return e

    def cap(a, b, r):
        """A capsule from a to b with surface radius r."""
        a, b = Vector(a), Vector(b)
        e = mb.elements.new(type="CAPSULE")
        e.co = (a + b) / 2
        e.radius = r / 0.573
        e.size_x = (b - a).length / 2
        e.stiffness = 2.0
        e.rotation = Vector((1, 0, 0)).rotation_difference((b - a).normalized())
        return e

    # torso: slim hindquarters, long barrel, DEEP chest, the hump over it
    ell((-19.5, 0.0, 34.0), (7.2, 5.7, 6.0))
    ell((-6.5, 0.0, 34.0), (12.5, 7.4, 7.6))
    ell((6.5, 0.0, 33.0), (7.6, 6.8, 9.2))
    ell((5.0, 0.0, 42.6), (9.0, 4.8, 5.4), rot=(0.0, 0.10, 0.0))
    # neck: short and thick, rising forward out of the hump
    cap((10.0, 0.0, 40.0), (18.5, 0.0, 42.0 + HL), 4.8)
    # head: a BIG head — skull, the long face sloping down, the bulbous
    # overhanging nose
    ell((HEAD.x, 0.0, HEAD.z), (4.6, 3.6, 4.2))
    cap((22.5, 0.0, 42.4 + HL), (29.8, 0.0, 37.6 + HL), 3.0)
    ell((31.6, 0.0, 36.4 + HL), (3.7, 2.8, 3.3), rot=(0.0, 0.35, 0.0))
    ell((33.2, 0.0, 34.4 + HL), (2.4, 2.4, 1.9))   # the drooping upper lip
    ell((30.0, 0.0, 33.4 + HL), (1.9, 1.6, 1.1))   # chin / lower lip
    # the bell: a flat flap of skin under the throat
    ell((19.0, 0.0, 34.5 + 0.6 * HL), (1.5, 0.75, 3.6), rot=(0.0, -0.25, 0.0))
    # tail: a stub
    ell((-26.0, 0.0, 36.0), (1.1, 0.9, 2.0), rot=(0.0, 0.25, 0.0))
    def ell_along(a, b, t, half):
        """An ellipsoid whose LONG axis (half[2]) runs along a -> b, centred
        at fraction t of the way: a muscle belly on a limb segment."""
        a, b = Vector(a), Vector(b)
        e = mb.elements.new(type="ELLIPSOID")
        e.co = a + (b - a) * t
        e.radius = 1.0 / K
        e.size_x, e.size_y, e.size_z = half
        e.stiffness = 2.0
        e.rotation = Vector((0, 0, 1)).rotation_difference((b - a).normalized())
        return e

    # legs (loop4-r3: "pipe-thin legs of even width with no knee or hock"):
    # each long bone is a SLIM capsule, and the shape comes from what a leg
    # really carries — the muscle belly high on the forearm / gaskin that
    # tapers into tendon, a knobby knee / hock, the slim cannon bone, a
    # fetlock knob, the short pastern
    for s in (-1, 1):
        for chain in (FRONT_LEG, HIND_LEG):
            front = chain is FRONT_LEG
            pts = [Vector((x, s * y, z)) for (x, y, z), _r in chain]
            for (a, b), (_p, r) in zip(zip(pts, pts[1:]), chain[1:]):
                cap(a, b, r)
            # the forearm / gaskin muscle: thick under the elbow / stifle,
            # gone by mid-segment
            ell_along(pts[1], pts[2], 0.3, (2.0, 1.75, 4.0) if front else (2.3, 1.9, 4.2))
            # the knee (carpus) / hock: knobby, a clear step off the cannon
            ell(pts[2], (1.45, 1.3, 1.55) if front else (1.55, 1.3, 1.6))
            if not front:
                # the point of the hock juts BEHIND the joint
                ell(pts[2] + Vector((-1.5, 0.0, 0.7)), (1.0, 0.8, 1.15))
            # the fetlock knob
            ell(pts[3], (1.15, 1.0, 1.1))
        # elbow and stifle muscle masses blending legs into the barrel, the
        # shoulder blade over the front leg, the haunch over the hind
        ell((8.0, s * 4.8, 27.0), (3.2, 2.4, 4.0))
        ell((-15.5, s * 5.0, 29.0), (4.5, 2.8, 5.0), rot=(0.0, 0.35, 0.0))
        ell((6.8, s * 5.2, 36.0), (4.4, 1.6, 5.6), rot=(0.0, -0.35, 0.0))
        ell((-19.0, s * 4.4, 33.0), (5.0, 2.0, 4.6), rot=(0.0, 0.2, 0.0))

    # the HIGH sculpt (baked, never shipped): fine, with a coarse coat
    hi = mb_to_mesh(obj, 0.24, "moose-hi")
    fur_clumps(hi, 1.1, 0.16, "moose-clumps")
    # the LOW mesh that ships: smooth, decimated to the budget
    body = mb_to_mesh(obj, 0.38, "moose-body")
    bpy.data.objects.remove(obj, do_unlink=True)
    tris = decimate_to(body, 3000)
    print(f"[wildlife] moose body {tris} -> {tris_of(body)} tris; sculpt {tris_of(hi)} tris")
    finish_body_normals(body)
    return body, hi


def moose_color(co, n):
    x, y, z = co
    n = Vector(n)
    c = MOOSE_BASE.copy()
    # the belly and the lower flanks fall to near-black, the saddle over the
    # hump and withers is paler and greyer — the bull's countershade
    under = np.clip((-n.z) * 0.9, 0, 1)
    c = c * (1 - under) + MOOSE_DARK * under
    saddle = np.clip((z - 40.0) / 5.0, 0, 1) * np.clip(1 - abs(x - 4.0) / 14.0, 0, 1) * max(0.0, n.z)
    c = c * (1 - saddle) + MOOSE_SADDLE * saddle
    # muzzle: a warmer, slightly paler brown toward the nose
    if x > 24.0:
        m = np.clip((x - 24.0) / 5.0, 0, 1) * 0.8
        c = c * (1 - m) + MOOSE_MUZZLE * m
    # legs: dark down to the knee / hock, then the pale stockings
    if z < 22.0 and abs(y) > 2.0:
        leg = np.clip((17.0 - z) / 5.0, 0, 1)
        c = c * (1 - leg) + MOOSE_LEG * leg
    return c


# ── the antlers (loop 4 r5) ──────────────────────────────────────────────────
# History: r2/r3 were a 2-D outline solidified to a plank 0.5-1.6 thick
# ("flat cardboard cut-outs"); r4 sculpted each antler as a metaball field
# of overlapping flattened ellipsoids, which loop4-r5 workbench-moose.png
# judged "lumpy cauliflower / coral blobs with stubby spikes" — a field of
# blobs reads as blobs, however it is baked.
#
# r5 builds what a bull's antler IS: a short round BEAM leaving the skull
# sideways (with the knobby burr ring), then ONE broad, smooth, slightly
# CUPPED sheet — the palm — whose 2-D outline carries the tines on its OUTER
# rim only, eight regular tapered points. The sheet is a constrained
# Delaunay triangulation of that outline (rim samples, a spine down each
# tine, a coarse interior lattice), lifted onto the curved dish
# (palm_point: the long axis out and a little up, the rear edge raised, the
# whole dish bowl-shaped toward its face) and given a lens-shaped
# thickness: about 1/8 of the palm's width over the plate, rounding to the
# rim (sqrt profile), so each tine is round in section and tapers to its
# point by construction. The tines also curl up toward the face.
#
# Frames are authored for the +Y antler; the -Y one mirrors every point.

ANTLER_SCALE = 0.88
BEAM_DIR = Vector((-0.20, 1.0, 0.85)).normalized()   # out, ~40 deg up, a touch back
BEAM_LEN = 2.6   # SHORT: the palm broadens right off the burr (r5 first cut, 3.6, read as an arm)
PALM_U = Vector((-0.10, 1.0, 0.40)).normalized()    # the palm's long axis: out, ~22 deg up
_PV = Vector((1.0, 0.0, -0.65))                     # forward, the REAR edge raised (~33 deg)
PALM_V = (_PV - PALM_U * _PV.dot(PALM_U)).normalized()
PALM_N = PALM_V.cross(PALM_U).normalized()          # the face: up, forward, inward
CUP_V = 0.040   # the rear / front edges curl toward the face
CUP_U = 0.015   # …and so does the outer rim

# the palm body's control outline (u out along PALM_U, v forward along
# PALM_V, authored units, counter-clockwise): the narrow root over the
# beam, the rear edge sweeping out to the rear corner, the broad OUTER rim
# (where the tines grow), the front corner, a modest brow lobe, back to
# the root. Smoothed by a closed Catmull-Rom spline (palm_outline).
PALM_CTRL = [(-0.8, -1.7), (1.4, -3.0), (3.8, -5.0), (6.6, -6.7), (9.6, -7.3),
             (12.0, -6.5), (13.8, -4.4), (14.7, -1.7), (14.6, 1.0), (13.5, 3.3),
             (11.4, 4.7), (8.8, 5.0), (6.0, 4.6), (3.4, 4.0), (1.0, 2.8), (-0.8, 1.7)]
RIM_FROM, RIM_TO = 4, 10       # the outer rim runs from the rear corner to the front one
TINE_COUNT = 8
TINE_HALF = 0.78               # half base width of a tine, along the rim (authored)
# tine length along the rim (authored): fairly regular, the middle ones
# a little longer, the corner ones a little shorter
TINE_LEN = [2.0, 2.4, 2.7, 2.9, 2.9, 2.7, 2.4, 2.0]
# curl toward the face: lift = k * reach^1.6. Gentle: at 0.42 the tines
# pointed at an elevated camera and foreshortened into shards
TINE_LIFT = 0.22
HALF_ROOT, HALF_RIM = 1.05, 0.86   # half-thickness (world) at the root / the outer palm
# the rim's rounding radius (authored). Tight: Catmull-Clark rounds the rim
# further, and at 1.15 the plate's p10 thickness fell to 0.88 over a 13.3
# width — 0.066, under glbAssets.test.ts's 0.08 "not cardboard" floor
ROUND_R = 0.7
# shipped triangles for BOTH antlers (r4's sculpt shipped 1 540). At 1 500
# the decimation cut each tine to a handful of facets (r5 moose-antler.png:
# "shards"); 2 000 keeps them round. glbAssets.test.ts carries the measured
# moose total and its caps.
ANTLER_TRIS = 2000

# kept for the gates: the palm body (no tines) as a polygon
PALM_OUTLINE = PALM_CTRL


def _antler_end():
    return BURR + BEAM_DIR * BEAM_LEN


def palm_point(u, v, lift=0.0):
    """A point on the +Y palm's dish (u, v in authored units)."""
    u *= ANTLER_SCALE
    v *= ANTLER_SCALE
    cup = CUP_V * v * v + CUP_U * u * u
    return _antler_end() + PALM_U * u + PALM_V * v + PALM_N * (cup + lift)


def palm_normal(u, v):
    u *= ANTLER_SCALE
    v *= ANTLER_SCALE
    return (PALM_N - PALM_U * (2 * CUP_U * u) - PALM_V * (2 * CUP_V * v)).normalized()


def _inside(poly, px, py):
    hit = False
    for i in range(len(poly)):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % len(poly)]
        if (ay > py) != (by > py) and px < ax + (py - ay) * (bx - ax) / (by - ay):
            hit = not hit
    return hit


def _edge_dist(poly, px, py):
    best = 1e9
    for i in range(len(poly)):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % len(poly)]
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(px - ax - t * dx, py - ay - t * dy))
    return best


def _catmull(ctrl, per_seg):
    """Closed Catmull-Rom through `ctrl`: (points, index of each control)."""
    n = len(ctrl)
    pts, at = [], []
    for i in range(n):
        p0, p1, p2, p3 = (np.array(ctrl[(i + k) % n]) for k in (-1, 0, 1, 2))
        at.append(len(pts))
        for k in range(per_seg):
            t = k / per_seg
            t2, t3 = t * t, t * t * t
            pts.append(0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    return np.array(pts), at


def palm_outline():
    """The full 2-D outline, tines included, CCW: (outline points, tine
    list [(base point, outward unit, length)], body polyline)."""
    body, at = _catmull(PALM_CTRL, 24)
    seg = np.linalg.norm(np.roll(body, -1, axis=0) - body, axis=1)
    s = np.concatenate([[0.0], np.cumsum(seg)])[:-1]
    s0, s1 = s[at[RIM_FROM]], s[at[RIM_TO]]
    total = s[-1] + seg[-1]
    # resample by arclength: fine along the rim (the tines need the
    # samples), coarse elsewhere; every tine centre lands ON a sample
    centres = [s0 + (k + 0.5) / TINE_COUNT * (s1 - s0) for k in range(TINE_COUNT)]
    targets = []
    x = 0.0
    while x < total - 1e-6:
        targets.append(x)
        x += 0.3 if s0 - TINE_HALF <= x <= s1 + TINE_HALF else 0.75
    targets = sorted(set([round(t, 4) for t in targets + centres]))

    def at_s(x):
        return np.array([np.interp(x, np.append(s, total), np.append(body[:, k], body[0, k])) for k in (0, 1)])

    out, tines = [], []
    for x in targets:
        p = at_s(x)
        d = at_s(x + 0.05) - at_s(x - 0.05)
        nrm = np.array([d[1], -d[0]]) / np.linalg.norm(d)   # CCW: outward = tangent rotated -90
        off = 0.0
        for k, c in enumerate(centres):
            w = (x - c) / TINE_HALF
            if abs(w) < 1.0:
                off = max(off, TINE_LEN[k] * (1.0 - w * w) ** 1.5)
        out.append(p + nrm * off)
    for k, c in enumerate(centres):
        p = at_s(c)
        d = at_s(c + 0.05) - at_s(c - 0.05)
        tines.append((p, np.array([d[1], -d[0]]) / np.linalg.norm(d), TINE_LEN[k]))
    return np.array(out), tines, body


def antler_sheet(side):
    """One antler's palm as a closed, lens-thick, cupped sheet (bmesh)."""
    outline, tines, body = palm_outline()
    poly = [tuple(p) for p in outline]
    body_poly = [tuple(p) for p in body]
    nb = len(outline)
    inner = []
    # a spine down each tine (so the tine has thickness inside its outline)
    for p, n, ln in tines:
        for t in (0.15, 0.45, 0.75):
            inner.append(p + n * (ln * t))
    # an inset ring just inside the rim (the rounding), and a coarse lattice
    # EVERY rim sample gets its inset twin: with one every third, the
    # subdivided rim thickness oscillated into scallops (r5 workbench-moose)
    for i in range(nb):
        p = outline[i]
        q = outline[(i + 1) % nb] - outline[i - 1]
        nrm = np.array([q[1], -q[0]]) / max(1e-9, np.linalg.norm(q))
        c = p - nrm * 0.55
        if _inside(poly, *c) and _edge_dist(poly, *c) > 0.42:
            inner.append(c)
    step = 1.6
    for i in range(-1, 13):
        for j in range(-7, 6):
            u = i * step + (0.5 * step if j % 2 else 0.0)
            v = j * step
            if _inside(poly, u, v) and _edge_dist(poly, u, v) > 0.95:
                inner.append(np.array([u, v]))
    pts = [Vector((float(p[0]), float(p[1]))) for p in outline] + [Vector((float(p[0]), float(p[1]))) for p in inner]
    verts, _e, faces, orig_v, _oe, _of = delaunay_2d_cdt(pts, [], [list(range(nb))], 1, 1e-5)
    on_rim = [any(o < nb for o in ov) for ov in orig_v]

    def mir(p):
        return Vector((p.x, side * p.y, p.z))

    bm = bmesh.new()
    top, bot = [], []
    for k, uv in enumerate(verts):
        u, v = uv.x, uv.y
        # reach beyond the palm body: the tines curl up toward the face
        reach = 0.0 if _inside(body_poly, u, v) else _edge_dist(body_poly, u, v)
        lift = TINE_LIFT * reach ** 1.6
        base = palm_point(u, v, lift)
        nrm = palm_normal(u, v)
        if on_rim[k]:
            vt = bm.verts.new(mir(base))
            top.append(vt)
            bot.append(vt)
            continue
        f = min(1.0, max(0.0, u / 13.0))
        half = HALF_ROOT * (1 - f) + HALF_RIM * f
        half *= math.sqrt(min(1.0, _edge_dist(poly, u, v) / ROUND_R))
        top.append(bm.verts.new(mir(base + nrm * half)))
        bot.append(bm.verts.new(mir(base - nrm * half)))
    for f in faces:
        a, b, c = f
        for tri in ((top[a], top[b], top[c]), (bot[c], bot[b], bot[a])):
            if len(set(tri)) == 3:
                try:
                    bm.faces.new(tri)
                except ValueError:
                    pass  # a rim-only triangle: top and bottom are the same face
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def beam_and_burr(bm, side):
    """The beam (a slightly tapered round tube from inside the skull into
    the palm's root) and the burr ring, into `bm`."""
    def mir(p):
        return Vector((p.x, side * p.y, p.z))

    a = BURR - BEAM_DIR * 1.2
    b = palm_point(1.4, 0.0)
    axis = (b - a)
    q = axis.normalized().to_track_quat("Z", "Y")
    sides, rings = 8, 4
    loops = []
    for i in range(rings):
        t = i / (rings - 1)
        r = 1.18 * (1 - t) + 0.95 * t
        c = a + axis * t
        loops.append([bm.verts.new(mir(c + q @ Vector((r * math.cos(2 * math.pi * k / sides), r * math.sin(2 * math.pi * k / sides), 0))))
                      for k in range(sides)])
    for r0, r1 in zip(loops, loops[1:]):
        for k in range(sides):
            bm.faces.new((r0[k], r0[(k + 1) % sides], r1[(k + 1) % sides], r1[k]))
    for ring, tip in ((loops[0], mir(a - axis.normalized() * 0.4)), (loops[-1], mir(b + axis.normalized() * 0.4))):
        apex = bm.verts.new(tip)
        for k in range(sides):
            bm.faces.new((ring[k], ring[(k + 1) % sides], apex))
    # the burr: a knobby coronet ring where the beam leaves the skull
    c = BURR + BEAM_DIR * 0.7
    qb = BEAM_DIR.to_track_quat("Z", "Y")
    maj, segs, msegs = 1.22, 12, 5
    grid = []
    for i in range(segs):
        th = 2 * math.pi * i / segs
        minor = 0.42 + 0.10 * (1 if i % 2 else -1)   # the pearling
        ring = []
        for k in range(msegs):
            ph = 2 * math.pi * k / msegs
            local = Vector(((maj + minor * math.cos(ph)) * math.cos(th), (maj + minor * math.cos(ph)) * math.sin(th), minor * math.sin(ph)))
            ring.append(bm.verts.new(mir(c + qb @ local)))
        grid.append(ring)
    for i in range(segs):
        for k in range(msegs):
            bm.faces.new((grid[i][k], grid[(i + 1) % segs][k], grid[(i + 1) % segs][(k + 1) % msegs], grid[i][(k + 1) % msegs]))


def build_antlers():
    """(low, high) meshes of both antlers, the body's pipeline: the CDT
    sheets + beams are a CAGE; two Catmull-Clark levels give the smooth
    HIGH surface (rounded rim, rounded tine points; baked, never shipped);
    the LOW mesh that ships is that surface decimated to the budget, so its
    vertices sit on the smooth surface and the bake restores the rest.
    (r5 first cut shipped the cage itself: its coarse triangles shaded as
    radial ridges and crystal-faceted tine bases up close.)"""
    bm = bmesh.new()
    for side in (-1, 1):
        part = antler_sheet(side)
        beam_and_burr(part, side)
        me = bpy.data.meshes.new("tmp")
        part.to_mesh(me)
        part.free()
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("antlers-hi")
    bm.to_mesh(me)
    bm.free()
    hi = bpy.data.objects.new("antlers-hi", me)
    bpy.context.collection.objects.link(hi)
    cage_tris = tris_of(hi)
    sub = hi.modifiers.new("sub", "SUBSURF")
    sub.levels = 2
    sub.render_levels = 2
    apply_modifiers(hi)
    hi.data.shade_smooth()
    activate(hi)
    bpy.ops.object.duplicate()
    low = bpy.context.active_object
    low.name = "antlers"
    decimate_to(low, ANTLER_TRIS)
    # the collapse can leave slivers that smart-project maps to a UV line
    # (a 0 UV-area ratio in glbAssets.test.ts): dissolve them first
    bm = bmesh.new()
    bm.from_mesh(low.data)
    bmesh.ops.dissolve_degenerate(bm, dist=0.02, edges=bm.edges[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(low.data)
    bm.free()
    # plain smooth normals, written as CUSTOM normals: the body carries
    # custom (weighted) normals, and a part without them joins it with FLAT
    # face normals (the faceted shards of the r5 second cut). (Not the
    # body's face-area WeightedNormal: it favours the big triangles and
    # creased the r5 cage into radial ridges.)
    low.data.shade_smooth()
    low.data.normals_split_custom_set_from_vertices([v.normal.copy() for v in low.data.vertices])
    print(f"[wildlife] antlers: cage {cage_tris} -> smooth {tris_of(hi)} -> shipped {tris_of(low)} tris "
          f"(two cupped palms, {TINE_COUNT} rim tines each, beams, burrs)")
    return low, hi


def antler_gates(antlers, ears_top_z):
    """Asserted on the shipped LOW antlers before they join the body:
      · volume — the palm's thickness, ray-cast along its face normal at
        sample points of the dish, over the palm's width, >= 0.08 (the r3
        plank measured ~0.03-0.09 by construction: 0.5-1.6 over 17);
      · the crown rides ABOVE the ears: every antler vertex out past the
        beam (the palm and its tines) stands higher than the top of the ears
        (the r3 near palm drooped to the neck line). The beam itself leaves
        the skull at ear level, as a bull's does;
      · nothing reaches back over the withers (the hump's crest, x = 5)."""
    bpy.context.view_layer.update()
    co = np.array([v.co[:] for v in antlers.data.vertices])
    out = co[np.abs(co[:, 1]) > _antler_end().y]
    assert out[:, 2].min() > ears_top_z, f"antler {out[:, 2].min():.2f} droops below the ears {ears_top_z:.2f}"
    assert co[:, 0].min() > 5.0 + 6.0, f"antler reaches back over the withers: x {co[:, 0].min():.2f}"
    th = []
    for i in range(1, 12):
        for j in range(-5, 4):
            u, v = i * 1.1, j * 1.3
            if not _inside(PALM_OUTLINE, u, v) or _edge_dist(PALM_OUTLINE, u, v) < 1.6:
                continue
            p, n = palm_point(u, v), palm_normal(u, v)
            hit_a, la, _n, _i = antlers.ray_cast(p + n * 6.0, -n)
            hit_b, lb, _n, _i = antlers.ray_cast(p - n * 6.0, n)
            if hit_a and hit_b:
                th.append((la - lb).length)
    assert len(th) > 10, f"only {len(th)} palm thickness samples"
    # the palm's width: its extent across the dish (rear edge to brow palm)
    vs = [v for _u, v in PALM_OUTLINE]
    width = (max(vs) - min(vs)) * ANTLER_SCALE
    ratio = min(th) / width
    print(f"[wildlife] antler palm thickness {min(th):.2f}..{max(th):.2f} (median {np.median(th):.2f}) over width {width:.1f}: "
          f"ratio {ratio:.3f}; lowest out-of-skull point z {out[:, 2].min():.2f} (at {out[out[:, 2].argmin()].round(1)}) "
          f"vs ears {ears_top_z:.2f}")
    assert ratio >= 0.08, f"the palm is a plank again: thickness / width {ratio:.3f}"


def antler_color(co, n):
    # distance from the beam's end (the palm's root): the plate stays bone
    # tan, the tines (beyond ~10 out) pale toward their tips
    end = _antler_end()
    d = (Vector((co[0], abs(co[1]), co[2])) - end).length
    t = float(np.clip((d - 9.0) / 4.5, 0, 1)) ** 1.4
    c = ANTLER_BASE * (1 - t) + ANTLER_TIP * t
    # the underside of the palm in its own shade: volume at 60-100 px
    return c * (0.7 if n[2] < -0.2 else 1.0)


def build_moose():
    ca.reset_scene()
    parts = []
    body, hi = moose_body()
    smart_uv(body, FUR_UV)
    paint(body, moose_color)
    parts.append(body)
    bpy.context.view_layer.update()

    def seat(origin, toward, sink):
        o = Vector(origin)
        d = (Vector(toward) - o).normalized()
        hit, loc, nrm, _ = body.ray_cast(o, d)
        assert hit, f"no surface from {origin} toward {toward}"
        return loc - nrm * sink, nrm

    def part(obj, color, region):
        smooth(obj, 75)
        region_uv_planar(obj, region)
        if callable(color):
            paint(obj, color)
        else:
            flat_color(obj, color)
        parts.append(obj)
        return obj

    ears_top = -1e9
    for s in (-1, 1):
        # eyes: small, set high on the sides of the head, forward of the ears
        # — a glossy cornea, a dark lid ring, a catchlight
        c, n = seat((24.2, s * 12.0, 44.0 + HL), (23.6, 0.0, 43.2 + HL), 0.3)
        eye_set(f"eye{s}", c, n, 0.7, MOOSE_DARK * 0.6, GLOSS_UV, lambda o, col, reg: part(o, col, reg))
        # nostrils: dark slits on the bulbous nose
        c, _n = seat((38.0, s * 1.5, 37.2 + HL), (30.0, s * 1.2, 36.4 + HL), 0.3)
        part(ellipsoid(f"nostril{s}", c, (0.5, 0.55, 0.85), segs=6, rings=4, rot=(0, 0.3, 0)), NOSE, GLOSS_UV)
        # ears: long, pointed, held out sideways below and behind the antlers
        ear = ellipsoid(f"ear{s}", (0, 0, 3.0), (1.55, 0.55, 3.9), segs=10, rings=6)
        ear.data.transform(Matrix.Rotation(s * -1.15, 4, "X"))
        ear.data.transform(Matrix.Translation((18.4, s * 3.2, 44.0 + HL)))
        ears_top = max(ears_top, max(v.co.z for v in ear.data.vertices))
        part(ear, lambda co, nn: MOOSE_BASE * 1.05, NEUTRAL_UV)
        # hooves: dark cloven wedges under each pastern, cut flat on the desk
        for chain in (FRONT_LEG, HIND_LEG):
            (hx, hy, _hz), _r = chain[-1]
            for k in (-1, 1):
                hoof = ellipsoid(f"hoof{s}{k}{chain is FRONT_LEG}", (hx + 0.7, s * hy + k * 0.55, 0.75),
                                 (1.5, 0.62, 1.1), segs=8, rings=5, rot=(0, -0.25, k * 0.12))
                # stand: each hoof's sole is cut flat on the desk plane HERE —
                # a bmesh pass over the joined mesh would drop the body's
                # weighted custom normals
                seat_cut(hoof)
                part(hoof, HOOF, NEUTRAL_UV)
    # the palmate antlers: one sculpt for both (antler_field), gated for
    # volume and pose before they join
    antlers, antlers_hi = build_antlers()
    antler_gates(antlers, ears_top)
    smart_uv(antlers, SCALE_UV, angle=50.0)
    bad = collapsed_uv_faces(antlers)
    assert not bad, f"antler faces with a collapsed UV triangle: {bad[:12]}"
    paint(antlers, antler_color)
    parts.append(antlers)
    # the bake's HIGH sculpt is body + antlers (their grain and curvature)
    activate(hi)
    antlers_hi.select_set(True)
    bpy.ops.object.join()
    hi = bpy.context.active_object

    activate(body)
    for p in parts:
        p.select_set(True)
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = "moose"
    co = np.array([v.co[:] for v in obj.data.vertices])
    assert co[:, 2].min() > -1e-4, f"something stands under the desk: z {co[:, 2].min():.3f}"
    # baked on the mesh exactly as it ships (see build_beaver)
    baked = bake_normals(obj, hi, extrusion=0.9, max_dist=2.2)
    bpy.data.objects.remove(hi, do_unlink=True)

    co = np.array([v.co[:] for v in obj.data.vertices])
    cx = (co[:, 0].min() + co[:, 0].max()) / 2
    cy = (co[:, 1].min() + co[:, 1].max()) / 2
    zmin = co[:, 2].min()
    obj.data.transform(Matrix.Translation((-cx, -cy, -zmin)))
    obj.data.update()

    detail, normal, mr = moose_maps(baked)
    dimg = ca.image_from_array("moose-detail", detail)
    nimg = ca.image_from_array("moose-normal", normal, non_color=True)
    mimg = ca.image_from_array("moose-mr", mr, non_color=True)
    obj.data.materials.clear()
    obj.data.materials.append(ca.make_material("moose", dimg, roughness=0.8, normal=nimg, vertex_color=True, metal_rough=mimg))
    co = np.array([v.co[:] for v in obj.data.vertices])
    r = np.hypot(co[:, 0], co[:, 1]).max()
    print(f"[wildlife] moose extent x {co[:, 0].min():.1f}..{co[:, 0].max():.1f} y {co[:, 1].min():.1f}..{co[:, 1].max():.1f} "
          f"h {co[:, 2].max():.1f} plan radius {r:.1f}")
    return obj


def preview(obj, filename, cam_loc, target, **kw):
    """ca.preview adds a camera and a sun per call: drop the previous pair
    first, or every later shot is lit by the sum of all earlier suns."""
    for o in list(bpy.data.objects):
        if o.name.startswith(("cam", "sun")):
            bpy.data.objects.remove(o, do_unlink=True)
    ca.preview(obj, filename, cam_loc, target, **kw)


def desk_ground():
    """AFTER export only: a plane in the desk's wood tone, so a preview judges
    the prop's contrast against what it will actually stand on."""
    if not ca.PREVIEW or "desk-ground" in bpy.data.objects:
        return
    bpy.ops.mesh.primitive_plane_add(size=600, location=(0, 0, 0))
    g = bpy.context.active_object
    g.name = "desk-ground"
    mat = bpy.data.materials.new("desk-ground")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*ca.srgb_to_linear(ca.hex_rgb("#D29A5E")), 1.0)
    bsdf.inputs["Roughness"].default_value = 0.6
    g.data.materials.append(mat)


if __name__ == "__main__":
    only = ca.arg("only")
    if only in (None, "beaver"):
        beaver = build_beaver()
        ca.export(beaver, "beaver.glb")
        # judged at the engine's own iso angle (35 deg elevation), then up close
        preview(beaver, "beaver-iso.png", (70, 58, 62), (0, 0, 14))
        preview(beaver, "beaver-front.png", (60, -18, 30), (0, 0, 16))
        preview(beaver, "beaver-side.png", (8, -78, 26), (0, 0, 14))
        preview(beaver, "beaver-back.png", (-60, 40, 50), (0, 0, 12))
        preview(beaver, "beaver-far.png", (210, 175, 185), (0, 0, 12), size=(500, 400))
    if only in (None, "moose"):
        moose = build_moose()
        ca.export(moose, "moose.glb")
        desk_ground()
        preview(moose, "moose-iso.png", (125, 105, 110), (0, 0, 30))
        preview(moose, "moose-side.png", (0, -150, 34), (0, 0, 30))
        preview(moose, "moose-front.png", (120, -45, 48), (8, 0, 34))
        preview(moose, "moose-back.png", (-105, 80, 85), (0, 0, 28))
        preview(moose, "moose-far.png", (380, 320, 330), (0, 0, 26), size=(500, 400))
        preview(moose, "moose-top.png", (0.1, 0, 220), (0, 0, 0))
        # the close-ups the critic judges (workbench-moose.png): the flank
        # and rump shading, the legs' joints, the eye
        preview(moose, "moose-close.png", (-55, -60, 40), (-4, 0, 26))
        preview(moose, "moose-head.png", (40, -28, 50), (12, 0, 42))
        # the near palm, from the engine's elevated 3/4 (loop 4 r5)
        preview(moose, "moose-antler.png", (48, 34, 80), (14, 9, 52))
