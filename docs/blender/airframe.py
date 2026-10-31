OUT_GLB = '/home/lain/halloween-hack/artifacts/airframe_attempt_2.glb'
OUT_PNG = '/home/lain/halloween-hack/artifacts/airframe_attempt_2.png'
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

# 2. Materials helper
def make_mat(name, r, g, b, metallic=0.1, roughness=0.4):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (r, g, b, 1.0)
    try:
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
            if "Metallic" in bsdf.inputs:
                bsdf.inputs["Metallic"].default_value = metallic
            if "Roughness" in bsdf.inputs:
                bsdf.inputs["Roughness"].default_value = roughness
    except Exception:
        pass
    return mat

mat_white = make_mat("FuselageWhite", 0.92, 0.93, 0.95, 0.1, 0.25)
mat_blue = make_mat("WingTrimBlue", 0.10, 0.28, 0.65, 0.2, 0.35)
mat_dark = make_mat("PropDark", 0.15, 0.16, 0.18, 0.3, 0.5)
mat_glass = make_mat("CanopyGlass", 0.20, 0.35, 0.45, 0.8, 0.1)

# Design Parameters
fuse_len = 8.25
fuse_diam = 1.22
fuse_rad = fuse_diam / 2.0
nose_len = 1.815
cabin_len = 2.97
tail_len = 3.465

wing_span = 11.051
wing_rc = 2.006
wing_tc = 0.903
wing_tc_ratio = 0.15
wing_x_le = 2.64
wing_z = 0.52
wing_dihedral = 2.0

ht_span = 3.998
ht_rc = 1.211
ht_tc = 0.787
ht_x_le = 6.93
ht_z = 0.15

vt_height = 1.628
vt_rc = 1.313
vt_tc = 0.722
vt_x_le = 6.73
vt_z = 0.25

prop_diam = 1.9
prop_x = 0.05

def add_obj(name, bm, mat, smooth=True):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    if smooth:
        for poly in mesh.polygons:
            poly.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    if mat:
        obj.data.materials.append(mat)
    return obj

# 3. Build Fuselage (from x = 0.22 to x = 8.25, spinner takes x = 0.0 to 0.22)
spin_len = 0.22
bm_fuse = bmesh.new()
n_seg = 32
xs = []
for i in range(10):
    f = i / 9.0
    xs.append(spin_len + f * (nose_len - spin_len))
for i in range(1, 9):
    f = i / 8.0
    xs.append(nose_len + f * cabin_len)
for i in range(1, 13):
    f = i / 12.0
    xs.append(nose_len + cabin_len + f * tail_len)

rings = []
for x in xs:
    if x <= nose_len:
        u = (x - spin_len) / (nose_len - spin_len)
        r_base = 0.18 * fuse_rad
        r = r_base + (fuse_rad - r_base) * math.pow(max(0.0, u), 0.6)
        z_off = -0.08 * fuse_rad * (1.0 - u)
        ry = r
        rz = r * (0.85 + 0.15 * u)
    elif x <= nose_len + cabin_len:
        ry = fuse_rad
        rz = fuse_rad * 1.02
        z_off = 0.0
    else:
        u = (x - (nose_len + cabin_len)) / tail_len
        ry = fuse_rad * (1.0 - 0.85 * math.pow(u, 1.3))
        rz = fuse_rad * 1.02 * (1.0 - 0.78 * math.pow(u, 1.2))
        z_off = 0.12 * fuse_rad * u
    ring = []
    for j in range(n_seg):
        ang = 2.0 * math.pi * j / n_seg
        vy = ry * math.cos(ang)
        vz = z_off + rz * math.sin(ang)
        ring.append(bm_fuse.verts.new((x, vy, vz)))
    rings.append(ring)

for i in range(len(rings) - 1):
    r1, r2 = rings[i], rings[i + 1]
    for j in range(n_seg):
        jn = (j + 1) % n_seg
        bm_fuse.faces.new((r1[j], r1[jn], r2[jn], r2[j]))

bm_fuse.faces.new(rings[0][::-1])
bm_fuse.faces.new(rings[-1])
add_obj("Fuselage", bm_fuse, mat_white, smooth=True)

# 4. Canopy / Windshield fairing
bm_can = bmesh.new()
can_xs = [1.35, 1.815, 2.5, 3.2, 3.9]
can_rings = []
for idx, x in enumerate(can_xs):
    if idx == 0:
        w, h, z0 = 0.36, 0.02, 0.35
    elif idx == 1:
        w, h, z0 = 0.52, 0.25, 0.42
    elif idx == 2:
        w, h, z0 = 0.54, 0.28, 0.44
    elif idx == 3:
        w, h, z0 = 0.48, 0.22, 0.44
    else:
        w, h, z0 = 0.30, 0.02, 0.42
    ring = []
    for j in range(13):
        ang = math.pi * j / 12.0
        vy = w * math.cos(ang)
        vz = z0 + h * math.sin(ang)
        ring.append(bm_can.verts.new((x, vy, vz)))
    can_rings.append(ring)

for i in range(len(can_rings) - 1):
    r1, r2 = can_rings[i], can_rings[i + 1]
    for j in range(12):
        bm_can.faces.new((r1[j], r1[j + 1], r2[j + 1], r2[j]))
bm_can.faces.new(can_rings[0][::-1])
bm_can.faces.new(can_rings[-1])
add_obj("Canopy", bm_can, mat_glass, smooth=True)

# 5. Airfoil helper (NACA 00xx closed TE)
def naca_coords(n_pts, tc):
    pts = []
    for i in range(n_pts + 1):
        beta = math.pi * i / n_pts
        xc = 0.5 * (1.0 + math.cos(beta))
        yt = 5.0 * tc * (0.2969 * math.sqrt(max(0.0, xc)) - 0.1260 * xc - 0.3516 * xc**2 + 0.2843 * xc**3 - 0.1036 * xc**4)
        pts.append((xc, yt))
    for i in range(1, n_pts):
        beta = math.pi * i / n_pts
        xc = 0.5 * (1.0 - math.cos(beta))
        yt = 5.0 * tc * (0.2969 * math.sqrt(max(0.0, xc)) - 0.1260 * xc - 0.3516 * xc**2 + 0.2843 * xc**3 - 0.1036 * xc**4)
        pts.append((xc, -yt))
    return pts

def build_symmetric_wing(name, span, rc, tc, tc_ratio, x_le, z_root, dihedral_deg, sweep_le_m, mat):
    bm = bmesh.new()
    af = naca_coords(16, tc_ratio)
    half_span = span / 2.0
    dz_tip = half_span * math.tan(math.radians(dihedral_deg))
    
    stations = [
        (-half_span, tc, x_le + sweep_le_m, z_root + dz_tip),
        (0.0, rc, x_le, z_root),
        (half_span, tc, x_le + sweep_le_m, z_root + dz_tip),
    ]
    rings = []
    for y_pos, chord, x0, z0 in stations:
        ring = []
        for xc, zc in af:
            vx = x0 + xc * chord
            vy = y_pos
            vz = z0 + zc * chord
            ring.append(bm.verts.new((vx, vy, vz)))
        rings.append(ring)
    
    n_p = len(af)
    for s in range(len(rings) - 1):
        r1, r2 = rings[s], rings[s + 1]
        for j in range(n_p):
            jn = (j + 1) % n_p
            bm.faces.new((r1[j], r1[jn], r2[jn], r2[j]))
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])
    return add_obj(name, bm, mat, smooth=False)

# 6. Build Main Wing (keep 25% chord line straight)
wing_sweep_le = 0.25 * (wing_rc - wing_tc)
build_symmetric_wing("MainWing", wing_span, wing_rc, wing_tc, wing_tc_ratio, wing_x_le, wing_z, wing_dihedral, wing_sweep_le, mat_blue)

# 7. Build Horizontal Tail
ht_sweep_le = 0.5 * (ht_rc - ht_tc)
build_symmetric_wing("HorizontalTail", ht_span, ht_rc, ht_tc, 0.12, ht_x_le, ht_z, 0.0, ht_sweep_le, mat_blue)

# 8. Build Vertical Tail
bm_vt = bmesh.new()
af_vt = naca_coords(14, 0.12)
vt_sweep_le = 0.75 * (vt_rc - vt_tc)
vt_stations = [
    (vt_z, vt_rc, vt_x_le),
    (vt_z + vt_height, vt_tc, vt_x_le + vt_sweep_le),
]
vt_rings = []
for z_pos, chord, x0 in vt_stations:
    ring = []
    for xc, yc in af_vt:
        vx = x0 + xc * chord
        vy = yc * chord
        vz = z_pos
        ring.append(bm_vt.verts.new((vx, vy, vz)))
    vt_rings.append(ring)
n_pvt = len(af_vt)
for j in range(n_pvt):
    jn = (j + 1) % n_pvt
    bm_vt.faces.new((vt_rings[0][j], vt_rings[0][jn], vt_rings[1][jn], vt_rings[1][j]))
bm_vt.faces.new(vt_rings[0][::-1])
bm_vt.faces.new(vt_rings[1])
add_obj("VerticalTail", bm_vt, mat_blue, smooth=False)

# 9. Build Propeller and Spinner (nose tip at x = 0.0)
bm_spin = bmesh.new()
spin_xs = [0.0, 0.03, 0.08, 0.15, spin_len]
spin_rings = []
r_spin_base = 0.18 * fuse_rad
z_spin_off = -0.08 * fuse_rad
for x in spin_xs:
    u = x / spin_len
    r = max(0.005, r_spin_base * math.pow(u, 0.65))
    ring = []
    for j in range(24):
        ang = 2.0 * math.pi * j / 24
        ring.append(bm_spin.verts.new((x, r * math.cos(ang), z_spin_off + r * 0.85 * math.sin(ang))))
    spin_rings.append(ring)
for i in range(len(spin_rings) - 1):
    r1, r2 = spin_rings[i], spin_rings[i + 1]
    for j in range(24):
        jn = (j + 1) % 24
        bm_spin.faces.new((r1[j], r1[jn], r2[jn], r2[j]))
bm_spin.faces.new(spin_rings[0][::-1])
bm_spin.faces.new(spin_rings[-1])
add_obj("Spinner", bm_spin, mat_dark, smooth=True)

# Propeller Blades (3 blades, diameter 1.9m)
bm_prop = bmesh.new()
prop_rad = prop_diam / 2.0
n_blades = 3
for b in range(n_blades):
    base_ang = 2.0 * math.pi * b / n_blades
    ca = math.cos(base_ang)
    sa = math.sin(base_ang)
    b_rings = []
    for r_frac, bw, bt, pitch_deg in [(0.08, 0.06, 0.03, 35.0), (0.45, 0.13, 0.02, 22.0), (0.85, 0.10, 0.012, 12.0), (1.0, 0.05, 0.006, 8.0)]:
        rad = r_frac * prop_rad
        pr = math.radians(pitch_deg)
        sec_pts = [(-bw * 0.5, 0.0), (0.0, bt * 0.5), (bw * 0.5, 0.0), (0.0, -bt * 0.5)]
        ring = []
        for u_c, v_t in sec_pts:
            dx = u_c * math.sin(pr) + v_t * math.cos(pr)
            dt = u_c * math.cos(pr) - v_t * math.sin(pr)
            vx = prop_x + dx
            vy = rad * ca - dt * sa
            vz = z_spin_off + rad * sa + dt * ca
            ring.append(bm_prop.verts.new((vx, vy, vz)))
        b_rings.append(ring)
    for i in range(len(b_rings) - 1):
        r1, r2 = b_rings[i], b_rings[i + 1]
        for j in range(4):
            jn = (j + 1) % 4
            bm_prop.faces.new((r1[j], r1[jn], r2[jn], r2[j]))
    bm_prop.faces.new(b_rings[0][::-1])
    bm_prop.faces.new(b_rings[-1])
add_obj("PropellerBlades", bm_prop, mat_dark, smooth=False)

# 10. World, Light, and Camera
scene = bpy.context.scene
if scene.world is None:
    scene.world = bpy.data.worlds.new("World")
scene.world.color = (0.85, 0.89, 0.94)
try:
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.85, 0.89, 0.94, 1.0)
except Exception:
    pass

light_data = bpy.data.lights.new(name="SunLight", type='SUN')
light_data.energy = 3.5
light_obj = bpy.data.objects.new(name="SunLight", object_data=light_data)
scene.collection.objects.link(light_obj)
light_obj.location = (-5.0, -8.0, 10.0)
light_obj.rotation_euler = (math.radians(45), math.radians(-30), math.radians(-35))

target = bpy.data.objects.new("CamTarget", None)
scene.collection.objects.link(target)
target.location = (fuse_len * 0.45, 0.0, 0.25)

cam_data = bpy.data.cameras.new("Camera")
cam_data.lens = 45.0
cam_obj = bpy.data.objects.new("Camera", cam_data)
scene.collection.objects.link(cam_obj)
cam_obj.location = (-8.5, -11.5, 5.2)

track = cam_obj.constraints.new(type='TRACK_TO')
track.target = target
track.track_axis = 'TRACK_NEGATIVE_Z'
track.up_axis = 'UP_Y'
scene.camera = cam_obj

# 11. Export GLB
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format='GLB')

# 12. Render PNG with Workbench
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'MATERIAL'
try:
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.background_type = 'WORLD'
except Exception:
    pass
scene.render.resolution_x = 1280
scene.render.resolution_y = 720
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = OUT_PNG
bpy.ops.render.render(write_still=True)

# 13. Measure and report bounding box
bpy.context.view_layer.update()
min_x = min_y = min_z = float('inf')
max_x = max_y = max_z = float('-inf')
for obj in scene.objects:
    if obj.type == 'MESH':
        for corner in obj.bound_box:
            wc = obj.matrix_world @ mathutils.Vector(corner)
            if wc.x < min_x: min_x = wc.x
            if wc.x > max_x: max_x = wc.x
            if wc.y < min_y: min_y = wc.y
            if wc.y > max_y: max_y = wc.y
            if wc.z < min_z: min_z = wc.z
            if wc.z > max_z: max_z = wc.z

span_m = round(max_y - min_y, 4)
length_m = round(max_x - min_x, 4)
height_m = round(max_z - min_z, 4)
print("SPIRAL_DIMS " + json.dumps({"span_m": span_m, "length_m": length_m, "height_m": height_m}))


# --- appended by Spiral: independent bounding-box measurement -------------------------------------
import bpy as _sp_bpy, json as _sp_json
from mathutils import Vector as _SpV
_sp_bpy.context.view_layer.update()
_sp_pts = [o.matrix_world @ _SpV(c) for o in _sp_bpy.context.scene.objects if o.type == "MESH" for c in o.bound_box]
if _sp_pts:
    _sp_ext = [max(p[i] for p in _sp_pts) - min(p[i] for p in _sp_pts) for i in range(3)]
    print("SPIRAL_VERIFY " + _sp_json.dumps({"length_m": _sp_ext[0], "span_m": _sp_ext[1], "height_m": _sp_ext[2],
                                            "mesh_objects": sum(1 for o in _sp_bpy.context.scene.objects if o.type == "MESH")}))
