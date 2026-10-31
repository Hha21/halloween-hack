OUT_GLB = '/home/lain/halloween-hack/artifacts/airframe_attempt_1.glb'
OUT_PNG = '/home/lain/halloween-hack/artifacts/airframe_attempt_1.png'
import bpy
import bmesh
import math
import mathutils
import json

# 1. Clear scene
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
for block in list(bpy.data.meshes):
    bpy.data.meshes.remove(block)
for block in list(bpy.data.materials):
    bpy.data.materials.remove(block)
for block in list(bpy.data.lights):
    bpy.data.lights.remove(block)
for block in list(bpy.data.cameras):
    bpy.data.cameras.remove(block)

# Design parameters
FUS_LEN = 8.25
FUS_DIA = 1.22
FUS_RAD = FUS_DIA / 2.0
NOSE_LEN = 1.815
CABIN_LEN = 2.97
TAIL_LEN = 3.465

WING_SPAN = 11.051
WING_RC = 2.006
WING_TC = 0.903
WING_TOC = 0.15
WING_X = 2.64
WING_Z = 0.52
WING_DIH = 2.0

HT_SPAN = 3.998
HT_RC = 1.211
HT_TC = 0.787
HT_X = 6.93
HT_Z = 0.15

VT_H = 1.628
VT_RC = 1.313
VT_TC = 0.722
VT_X = 6.73
VT_Z = 0.25

PROP_DIA = 1.9
PROP_X = 0.05

# Helper: Materials
def make_material(name, r, g, b, alpha=1.0):
    mat = bpy.data.materials.new(name=name)
    mat.diffuse_color = (r, g, b, alpha)
    try:
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (r, g, b, alpha)
            if alpha < 1.0:
                bsdf.inputs["Alpha"].default_value = alpha
    except Exception:
        pass
    return mat

mat_fus = make_material("FuselageWhite", 0.92, 0.93, 0.95)
mat_wing = make_material("WingBlue", 0.12, 0.30, 0.65)
mat_prop = make_material("PropDark", 0.15, 0.15, 0.17)
mat_canopy = make_material("CanopyGlass", 0.18, 0.28, 0.38, 0.8)

def link_mesh_obj(name, bm, mat, smooth=False):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    if smooth:
        for p in mesh.polygons:
            p.use_smooth = True
    if mat:
        mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj

# 2. Fuselage (x from 0.25 to FUS_LEN, spinner from 0.0 to 0.25)
SPINNER_LEN = 0.25
SPINNER_RAD = FUS_RAD * 0.35

bm_fus = bmesh.new()
num_segs = 32
x_stations = []
# Nose stations from SPINNER_LEN to NOSE_LEN
for i in range(10):
    f = i / 9.0
    x = SPINNER_LEN + f * (NOSE_LEN - SPINNER_LEN)
    r = SPINNER_RAD + (FUS_RAD - SPINNER_RAD) * math.sin(f * math.pi / 2.0)
    z_off = -0.05 * (1.0 - f)
    x_stations.append((x, r, r, z_off))

# Cabin stations
for i in range(1, 6):
    f = i / 5.0
    x = NOSE_LEN + f * CABIN_LEN
    x_stations.append((x, FUS_RAD, FUS_RAD * 1.05, 0.0))

# Tailcone stations up to FUS_LEN
for i in range(1, 11):
    f = i / 10.0
    x = NOSE_LEN + CABIN_LEN + f * TAIL_LEN
    r_y = FUS_RAD * (1.0 - 0.85 * (f ** 1.2))
    r_z = FUS_RAD * 1.05 * (1.0 - 0.80 * (f ** 1.1))
    z_off = 0.08 * f
    x_stations.append((x, r_y, r_z, z_off))

rings = []
for (x, ry, rz, z0) in x_stations:
    ring = []
    for j in range(num_segs):
        ang = 2.0 * math.pi * j / num_segs
        vy = ry * math.cos(ang)
        vz = z0 + rz * math.sin(ang)
        ring.append(bm_fus.verts.new((x, vy, vz)))
    rings.append(ring)

for i in range(len(rings) - 1):
    r1 = rings[i]
    r2 = rings[i + 1]
    for j in range(num_segs):
        jn = (j + 1) % num_segs
        bm_fus.faces.new((r1[j], r1[jn], r2[jn], r2[j]))

bm_fus.faces.new(reversed(rings[0]))
bm_fus.faces.new(rings[-1])
link_mesh_obj("Fuselage", bm_fus, mat_fus, smooth=True)

# 3. Canopy / Windshield fairing
bm_can = bmesh.new()
can_stations = [
    (NOSE_LEN - 0.2, 0.35, 0.10, FUS_RAD * 0.70),
    (NOSE_LEN + 0.3, FUS_RAD * 0.88, 0.32, FUS_RAD * 0.75),
    (NOSE_LEN + 1.2, FUS_RAD * 0.88, 0.30, FUS_RAD * 0.75),
    (NOSE_LEN + 2.2, 0.35, 0.08, FUS_RAD * 0.70),
]
can_rings = []
can_segs = 16
for (x, wy, hz, z_base) in can_stations:
    ring = []
    for j in range(can_segs + 1):
        ang = math.pi * j / can_segs
        vy = wy * math.cos(ang)
        vz = z_base + hz * math.sin(ang)
        ring.append(bm_can.verts.new((x, vy, vz)))
    can_rings.append(ring)

for i in range(len(can_rings) - 1):
    r1 = can_rings[i]
    r2 = can_rings[i + 1]
    for j in range(can_segs):
        bm_can.faces.new((r1[j], r1[j + 1], r2[j + 1], r2[j]))
    bm_can.faces.new((r1[-1], r1[0], r2[0], r2[-1]))

bm_can.faces.new(reversed(can_rings[0]))
bm_can.faces.new(can_rings[-1])
link_mesh_obj("Canopy", bm_can, mat_canopy, smooth=True)

# Helper: NACA 00xx airfoil section coordinates (unit chord, x in [0, 1])
def naca00xx_coords(toc, n_pts=14):
    pts = []
    # From TE (x=1) over upper surface to LE (x=0) and back over lower surface to TE
    for i in range(n_pts, 0, -1):
        beta = math.pi * i / n_pts
        x = 0.5 * (1.0 - math.cos(beta))
        yt = 5.0 * toc * (0.2969 * math.sqrt(x) - 0.1260 * x - 0.3516 * x**2 + 0.2843 * x**3 - 0.1036 * x**4)
        pts.append((x, yt))
    for i in range(n_pts + 1):
        beta = math.pi * i / n_pts
        x = 0.5 * (1.0 - math.cos(beta))
        yt = 5.0 * toc * (0.2969 * math.sqrt(x) - 0.1260 * x - 0.3516 * x**2 + 0.2843 * x**3 - 0.1036 * x**4)
        pts.append((x, -yt))
    return pts[:-1]  # remove duplicate TE point

def build_symmetric_wing(name, span, rc, tc, toc, x_le, z_le, dih_deg, sweep_le_m, mat):
    bm = bmesh.new()
    prof = naca00xx_coords(toc, 14)
    n_p = len(prof)
    half_span = span / 2.0
    dz_tip = half_span * math.tan(math.radians(dih_deg))

    sections = [
        (-half_span, tc, x_le + sweep_le_m, z_le + dz_tip),
        (0.0, rc, x_le, z_le),
        (half_span, tc, x_le + sweep_le_m, z_le + dz_tip),
    ]
    rings = []
    for (y_pos, chord, x0, z0) in sections:
        ring = []
        for (px, pz) in prof:
            vx = x0 + px * chord
            vz = z0 + pz * chord
            ring.append(bm.verts.new((vx, y_pos, vz)))
        rings.append(ring)

    for s in range(len(rings) - 1):
        r1 = rings[s]
        r2 = rings[s + 1]
        for j in range(n_p):
            jn = (j + 1) % n_p
            bm.faces.new((r1[j], r1[jn], r2[jn], r2[j]))

    bm.faces.new(reversed(rings[0]))
    bm.faces.new(rings[-1])
    return link_mesh_obj(name, bm, mat, smooth=False)

# 4. Main Wing (exact span WING_SPAN)
wing_sweep = 0.25 * (WING_RC - WING_TC)
build_symmetric_wing("MainWing", WING_SPAN, WING_RC, WING_TC, WING_TOC, WING_X, WING_Z, WING_DIH, wing_sweep, mat_wing)

# 5. Horizontal Tail (clamped so trailing edge stays <= FUS_LEN)
ht_sweep = min(0.25, FUS_LEN - HT_X - HT_TC)
ht_sweep = max(0.0, ht_sweep)
build_symmetric_wing("HorizontalTail", HT_SPAN, HT_RC, HT_TC, 0.12, HT_X, HT_Z, 0.0, ht_sweep, mat_wing)

# 6. Vertical Tail (clamped so trailing edge stays <= FUS_LEN)
bm_vt = bmesh.new()
vt_prof = naca00xx_coords(0.12, 12)
n_vp = len(vt_prof)
vt_sweep = min(0.55, FUS_LEN - VT_X - VT_TC)
vt_sweep = max(0.0, vt_sweep)
vt_sections = [
    (VT_Z, VT_RC, VT_X),
    (VT_Z + VT_H, VT_TC, VT_X + vt_sweep),
]
vt_rings = []
for (z_pos, chord, x0) in vt_sections:
    ring = []
    for (px, py) in vt_prof:
        vx = x0 + px * chord
        vy = py * chord
        ring.append(bm_vt.verts.new((vx, vy, z_pos)))
    vt_rings.append(ring)

for j in range(n_vp):
    jn = (j + 1) % n_vp
    bm_vt.faces.new((vt_rings[0][j], vt_rings[0][jn], vt_rings[1][jn], vt_rings[1][j]))
bm_vt.faces.new(reversed(vt_rings[0]))
bm_vt.faces.new(vt_rings[1])
link_mesh_obj("VerticalTail", bm_vt, mat_wing, smooth=False)

# 7. Spinner (from x=0.0 to x=SPINNER_LEN) & Propeller (at x=PROP_X)
bm_spin = bmesh.new()
spin_segs = 24
spin_rings = []
for i in range(1, 7):
    f = i / 6.0
    x = f * SPINNER_LEN
    r = SPINNER_RAD * (f ** 0.7)
    z_off = -0.05 * (1.0 - (x - SPINNER_LEN) / (NOSE_LEN - SPINNER_LEN))
    ring = []
    for j in range(spin_segs):
        ang = 2.0 * math.pi * j / spin_segs
        ring.append(bm_spin.verts.new((x, r * math.cos(ang), z_off + r * math.sin(ang))))
    spin_rings.append(ring)

tip_v = bm_spin.verts.new((0.0, 0.0, -0.05))
for j in range(spin_segs):
    jn = (j + 1) % spin_segs
    bm_spin.faces.new((tip_v, spin_rings[0][jn], spin_rings[0][j]))
for i in range(len(spin_rings) - 1):
    r1 = spin_rings[i]
    r2 = spin_rings[i + 1]
    for j in range(spin_segs):
        jn = (j + 1) % spin_segs
        bm_spin.faces.new((r1[j], r1[jn], r2[jn], r2[j]))
bm_spin.faces.new(spin_rings[-1])
link_mesh_obj("Spinner", bm_spin, mat_prop, smooth=True)

# 3-blade Propeller in YZ plane
bm_prop = bmesh.new()
prop_rad = PROP_DIA / 2.0
n_blades = 3
for b in range(n_blades):
    base_ang = 2.0 * math.pi * b / n_blades
    dir_y = math.cos(base_ang)
    dir_z = math.sin(base_ang)
    perp_y = -dir_z
    perp_z = dir_y

    b_rings = []
    for r_frac, w_chord, thick, pitch_deg in [
        (0.12, 0.09, 0.025, 25.0),
        (0.45, 0.14, 0.018, 18.0),
        (0.80, 0.11, 0.012, 12.0),
        (1.00, 0.05, 0.006, 8.0),
    ]:
        rad_d = r_frac * prop_rad
        cy = dir_y * rad_d
        cz = -0.05 + dir_z * rad_d
        pitch = math.radians(pitch_deg)
        dx = 0.5 * w_chord * math.sin(pitch)
        dp = 0.5 * w_chord * math.cos(pitch)
        dt = 0.5 * thick
        pts = [
            (PROP_X - dx, cy - perp_y * dp - dir_y * 0.0, cz - perp_z * dp),
            (PROP_X + dt, cy, cz),
            (PROP_X + dx, cy + perp_y * dp, cz + perp_z * dp),
            (PROP_X - dt, cy, cz),
        ]
        b_rings.append([bm_prop.verts.new(p) for p in pts])

    for i in range(len(b_rings) - 1):
        r1 = b_rings[i]
        r2 = b_rings[i + 1]
        for j in range(4):
            jn = (j + 1) % 4
            bm_prop.faces.new((r1[j], r1[jn], r2[jn], r2[j]))
    bm_prop.faces.new(reversed(b_rings[0]))
    bm_prop.faces.new(b_rings[-1])

link_mesh_obj("Propeller", bm_prop, mat_prop, smooth=False)

# 8. World, Light, and Camera
scene = bpy.context.scene
if scene.world is None:
    scene.world = bpy.data.worlds.new("World")
scene.world.color = (0.85, 0.89, 0.94)
try:
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.85, 0.89, 0.94, 1.0)
except Exception:
    pass

light_data = bpy.data.lights.new(name="SunLight", type='SUN')
light_data.energy = 3.5
light_obj = bpy.data.objects.new(name="SunLight", object_data=light_data)
light_obj.location = (2.0, -6.0, 10.0)
light_obj.rotation_euler = (math.radians(35), math.radians(-20), math.radians(30))
bpy.context.collection.objects.link(light_obj)

target = bpy.data.objects.new("CamTarget", None)
target.location = (FUS_LEN * 0.45, 0.0, 0.25)
bpy.context.collection.objects.link(target)

cam_data = bpy.data.cameras.new(name="Camera")
cam_data.lens = 45.0
cam_obj = bpy.data.objects.new(name="Camera", object_data=cam_data)
cam_obj.location = (-FUS_LEN * 0.75, -WING_SPAN * 0.95, WING_SPAN * 0.48)
bpy.context.collection.objects.link(cam_obj)

trk = cam_obj.constraints.new(type='TRACK_TO')
trk.target = target
trk.track_axis = 'TRACK_NEGATIVE_Z'
trk.up_axis = 'UP_Y'
scene.camera = cam_obj

# 9. Export GLB and Render PNG
bpy.context.view_layer.update()
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format='GLB')

scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'MATERIAL'
try:
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
except Exception:
    pass
scene.render.resolution_x = 1280
scene.render.resolution_y = 720
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = OUT_PNG
bpy.ops.render.render(write_still=True)

# 10. Measure and report bounding box
bpy.context.view_layer.update()
min_x = min_y = min_z = float('inf')
max_x = max_y = max_z = float('-inf')
for obj in bpy.data.objects:
    if obj.type == 'MESH':
        for corner in obj.bound_box:
            wc = obj.matrix_world @ mathutils.Vector(corner)
            min_x = min(min_x, wc.x)
            max_x = max(max_x, wc.x)
            min_y = min(min_y, wc.y)
            max_y = max(max_y, wc.y)
            min_z = min(min_z, wc.z)
            max_z = max(max_z, wc.z)

dims = {
    "span_m": round(max_y - min_y, 4),
    "length_m": round(max_x - min_x, 4),
    "height_m": round(max_z - min_z, 4),
}
print("SPIRAL_DIMS " + json.dumps(dims))


# --- appended by Spiral: independent bounding-box measurement -------------------------------------
import bpy as _sp_bpy, json as _sp_json
from mathutils import Vector as _SpV
_sp_bpy.context.view_layer.update()
_sp_pts = [o.matrix_world @ _SpV(c) for o in _sp_bpy.context.scene.objects if o.type == "MESH" for c in o.bound_box]
if _sp_pts:
    _sp_ext = [max(p[i] for p in _sp_pts) - min(p[i] for p in _sp_pts) for i in range(3)]
    print("SPIRAL_VERIFY " + _sp_json.dumps({"length_m": _sp_ext[0], "span_m": _sp_ext[1], "height_m": _sp_ext[2],
                                            "mesh_objects": sum(1 for o in _sp_bpy.context.scene.objects if o.type == "MESH")}))
