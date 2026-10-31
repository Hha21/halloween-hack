/**
 * Viewport A: 3D Parametric Aircraft + Internal Main Spar + Schrenk Lift Curtain (Owner: Tharm).
 *
 * Renders with Three.js (WebGL) once the CDN module loads; the 2D canvas
 * projection renderer below stays as the instant / offline fallback.
 */

const THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js";
let threePromise = null;
function loadThree() {
  if (!threePromise) {
    threePromise = import(THREE_CDN).catch(() => null);
  }
  return threePromise;
}

function attachOrbitControls(canvas, cam, onChange) {
  let dragging = false;
  let mode = "orbit";
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    mode = e.shiftKey || e.button === 2 ? "pan" : "orbit";
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (mode === "orbit") {
      cam.yaw -= dx * 0.0085;
      cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + dy * 0.0075));
    } else {
      cam.panX += dx * 0.8;
      cam.panY += dy * 0.8;
    }
    onChange();
  });
  const stop = () => { dragging = false; };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      cam.zoom = Math.max(0.45, Math.min(3.0, cam.zoom * (e.deltaY < 0 ? 1.09 : 0.92)));
      onChange();
    },
    { passive: false }
  );
}

function project3D(x, y, z, cam, w, h) {
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);

  const x1 = x * cy - y * sy;
  const y1 = x * sy + y * cy;
  const z2 = z * cp - y1 * sp;
  const depth = z * sp + y1 * cp;

  const scale = cam.baseScale * cam.zoom * (24 / Math.max(12, 24 - depth * 0.35));
  return {
    sx: w * 0.5 + cam.panX + x1 * scale,
    sy: h * 0.54 + cam.panY - z2 * scale,
    depth,
    scale,
  };
}

const DEFAULT_GEOMETRY = {
  fuselage: { length_m: 8.2, diameter_m: 1.22, nose_length_m: 1.8, cabin_length_m: 3.0 },
  wing: { span_m: 10.8, root_chord_m: 1.8, tip_chord_m: 1.08, thickness_to_chord: 0.15, x_le_m: 2.6, z_m: 0.52, dihedral_deg: 2.0 },
  horizontal_tail: { span_m: 3.86, root_chord_m: 1.17, tip_chord_m: 0.76, x_le_m: 6.9, z_m: 0.15 },
  vertical_tail: { height_m: 1.62, root_chord_m: 1.3, tip_chord_m: 0.71, x_le_m: 6.7, z_m: 0.25 },
  propeller: { diameter_m: 1.9, x_m: 0.05 },
};

/* ---------------- WebGL (Three.js) aircraft model ----------------
 * Aircraft frame, metres: x aft from the nose, y to starboard, z up.
 */

const WING_CAMBER = 0.02; // NACA 24xx: 2% max camber
const WING_CAMBER_POS = 0.4; // at 40% chord
const TAIL_TC = 0.12; // NACA 0012 tail surfaces
const RIBS_PER_SIDE = 9;

function num(v, d) {
  if (v === null || v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** NACA 4-digit section, JS port of spiral/tools/geometry.py naca4_coordinates
 * (Abbott & von Doenhoff 1959, Ch. 6). Closed contour TE -> upper -> LE -> lower -> TE. */
function naca4(m, p, t, n = 28) {
  const up = [];
  const lo = [];
  for (let i = 0; i <= n; i++) {
    const xc = 0.5 * (1 - Math.cos((Math.PI * i) / n));
    const yt = 5 * t * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc ** 2 + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
    const yc = camberAt(m, p, xc);
    let th = 0;
    if (m > 1e-6) th = Math.atan(xc < p ? ((2 * m) / p ** 2) * (p - xc) : ((2 * m) / (1 - p) ** 2) * (p - xc));
    up.push({ x: xc - yt * Math.sin(th), z: yc + yt * Math.cos(th), xc, yc, upper: true });
    lo.push({ x: xc + yt * Math.sin(th), z: yc - yt * Math.cos(th), xc, yc, upper: false });
  }
  return [...up.reverse(), ...lo.slice(1)];
}

function camberAt(m, p, xc) {
  if (m <= 1e-6) return 0;
  return xc < p ? (m / p ** 2) * (2 * p * xc - xc ** 2) : (m / (1 - p) ** 2) * (1 - 2 * p + 2 * p * xc - xc ** 2);
}

function halfThicknessAt(t, xc) {
  return 5 * t * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc ** 2 + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
}

/** Illustrative Cp only: thin-airfoil-style loading shape scaled by the local
 * Schrenk section lift. Not a pressure solution; the HUD says so. */
function illustrativeCp(pt, clr) {
  const s = Math.sqrt((1 - pt.xc) / (pt.xc + 0.03));
  if (pt.upper) return Math.max(-2.2, -clr * 0.55 * (0.35 + 0.9 * s));
  return Math.min(1, clr * (1.05 * Math.exp(-pt.xc / 0.025) - 0.12 * Math.sin(Math.PI * pt.xc)));
}

const CP_STOPS = [
  [1.0, [0.11, 0.31, 0.85]],
  [0.3, [0.02, 0.71, 0.83]],
  [0.0, [0.8, 0.84, 0.88]],
  [-0.8, [0.96, 0.62, 0.04]],
  [-2.2, [0.94, 0.27, 0.27]],
];
function cpColor(cp) {
  for (let i = 0; i < CP_STOPS.length - 1; i++) {
    const [a, ca] = CP_STOPS[i];
    const [b, cb] = CP_STOPS[i + 1];
    if (cp <= a && cp >= b) {
      const u = (a - cp) / (a - b);
      return [0, 1, 2].map((k) => (ca[k] + (cb[k] - ca[k]) * u) ** 2.2); // sRGB stops -> linear vertex colours
    }
  }
  return (cp > 0 ? CP_STOPS[0][1] : CP_STOPS[CP_STOPS.length - 1][1]).map((v) => v ** 2.2);
}

/** Skin a list of equal-length point rings into one mesh geometry. */
function loftRings(THREE, rings, { colors = null, capStart = false, capEnd = false, flat = false } = {}) {
  const M = rings[0].length;
  const pos = [];
  const col = [];
  const idx = [];
  rings.forEach((ring, i) =>
    ring.forEach((p, j) => {
      pos.push(p[0], p[1], p[2]);
      if (colors) col.push(...colors[i][j]);
    })
  );
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < M; j++) {
      const a = i * M + j;
      const b = i * M + ((j + 1) % M);
      const c = (i + 1) * M + ((j + 1) % M);
      const d = (i + 1) * M + j;
      idx.push(a, b, c, a, c, d);
    }
  }
  const cap = (ri) => {
    const ring = rings[ri];
    const ctr = [0, 1, 2].map((k) => ring.reduce((s, p) => s + p[k], 0) / M);
    const ci = pos.length / 3;
    pos.push(...ctr);
    if (colors) col.push(...colors[ri][0]);
    for (let j = 0; j < M; j++) idx.push(ci, ri * M + j, ri * M + ((j + 1) % M));
  };
  if (capStart) cap(0);
  if (capEnd) cap(rings.length - 1);

  let geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  if (colors) geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  if (flat) geo = geo.toNonIndexed();
  geo.computeVertexNormals();
  return geo;
}

/** Loft an airfoil profile through stations {xle, c, k, map(x, zt) -> [X, Y, Z]}. */
function surfaceRings(prof, stations) {
  return stations.map((st) =>
    prof.map((p) => st.map(st.xle + p.x * st.c, (p.yc + (p.z - p.yc) * st.k) * st.c))
  );
}

function rectRing(cx, cz, w, h, y) {
  return [
    [cx - w / 2, y, cz - h / 2],
    [cx + w / 2, y, cz - h / 2],
    [cx + w / 2, y, cz + h / 2],
    [cx - w / 2, y, cz + h / 2],
  ];
}

function cylinderBetween(THREE, a, b, r, mat) {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const dir = vb.clone().sub(va);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, dir.length(), 12), mat);
  mesh.position.copy(va).add(vb).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

function wingPlanform(g) {
  const w = g.wing || {};
  const semi = num(w.span_m, 10.8) / 2;
  const cR = num(w.root_chord_m, 1.8);
  const cT = num(w.tip_chord_m, 1.08);
  const xLe = num(w.x_le_m, 2.6);
  const zW = num(w.z_m, 0.52);
  const tc = num(w.thickness_to_chord, 0.15);
  const tanG = Math.tan((num(w.dihedral_deg, 2) * Math.PI) / 180);
  // Geometry carries no sweep; GA wings are unswept at the quarter chord.
  const tanQC = Math.tan((num(w.sweep_quarter_chord_deg, 0) * Math.PI) / 180);
  const chord = (y) => cR + (cT - cR) * Math.min(y / semi, 1);
  return {
    semi, cR, cT, xLe, zW, tc, chord,
    xle: (y) => xLe + 0.25 * (cR - chord(y)) + Math.min(y, semi) * tanQC,
    z: (y) => zW + y * tanG,
  };
}

/** Spanwise Schrenk lift l(y)/l_max from loads; elliptic placeholder without loads. */
function liftFraction(loads, semi) {
  const st = (loads?.stations || [])
    .map((s) => [num(s.y_m, 0), num(s.schrenk_lift_n_per_m ?? s.l_schrenk_n_per_m, 0)])
    .sort((a, b) => a[0] - b[0]);
  if (st.length < 2) return { computed: false, f: (y) => Math.sqrt(Math.max(0, 1 - (y / semi) ** 2)) };
  const lMax = Math.max(...st.map((s) => s[1]), 1e-9);
  // Map by spanwise fraction: a scrubbed lap's span can differ from the latest loads.
  const yScale = st[st.length - 1][0] / semi;
  return {
    computed: true,
    f: (yGeom) => {
      const y = yGeom * yScale;
      if (y <= st[0][0]) return st[0][1] / lMax;
      for (let i = 0; i < st.length - 1; i++) {
        if (y <= st[i + 1][0]) {
          const u = (y - st[i][0]) / Math.max(st[i + 1][0] - st[i][0], 1e-9);
          return (st[i][1] + (st[i + 1][1] - st[i][1]) * u) / lMax;
        }
      }
      return st[st.length - 1][1] / lMax;
    },
  };
}

function buildWingSide(THREE, wp, sign, lift, mats) {
  const group = new THREE.Group();
  const prof = naca4(WING_CAMBER, WING_CAMBER_POS, wp.tc);

  // Section lift coefficient shape l(y)/c(y), normalised to its spanwise peak.
  const clRaw = (y) => lift.f(y) / wp.chord(y);
  let clPeak = 1e-9;
  for (let i = 0; i <= 30; i++) clPeak = Math.max(clPeak, clRaw((wp.semi * i) / 30));

  const stations = [];
  const N = 26;
  for (let i = 0; i <= N; i++) {
    const y = wp.semi * Math.sin((Math.PI / 2) * (i / N)); // clustered toward the tip
    stations.push({ y, c: wp.chord(y), xle: wp.xle(y), zb: wp.z(y), k: 1, clr: clRaw(y) / clPeak });
  }
  // Rounded tip: chord and thickness close out over ~20% of the tip chord.
  const rTip = 0.2 * wp.cT;
  const xTip = wp.xle(wp.semi);
  const zTip = wp.z(wp.semi);
  for (let k = 1; k <= 6; k++) {
    const phi = (k / 6) * (Math.PI / 2) * 0.92;
    const c = wp.cT * (0.3 + 0.7 * Math.cos(phi));
    stations.push({
      y: wp.semi + rTip * Math.sin(phi),
      c,
      xle: xTip + 0.35 * (wp.cT - c),
      zb: zTip,
      k: Math.pow(Math.cos(phi), 0.6),
      clr: (clRaw(wp.semi) / clPeak) * Math.cos(phi),
    });
  }
  stations.forEach((st) => (st.map = (x, zt) => [x, sign * st.y, st.zb + zt]));

  const colors = stations.map((st) => prof.map((p) => cpColor(illustrativeCp(p, st.clr))));
  const skin = new THREE.Mesh(loftRings(THREE, surfaceRings(prof, stations), { colors, capStart: true, capEnd: true }), mats.skin);
  skin.renderOrder = 2;
  group.add(skin);

  // Chordwise ribs with lightening holes aft of the spar.
  const ribProf = prof.slice(0, -1);
  for (let i = 0; i < RIBS_PER_SIDE; i++) {
    const y = wp.semi * (0.04 + (0.94 * i) / (RIBS_PER_SIDE - 1));
    const c = wp.chord(y);
    const xle = wp.xle(y);
    const zb = wp.z(y);
    const shape = new THREE.Shape(ribProf.map((p) => new THREE.Vector2(xle + p.x * c, zb + p.z * c)));
    for (const xc of [0.42, 0.58, 0.74]) {
      const hole = new THREE.Path();
      hole.absarc(xle + xc * c, zb + camberAt(WING_CAMBER, WING_CAMBER_POS, xc) * c, 0.5 * halfThicknessAt(wp.tc, xc) * c, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    }
    const ribGeo = new THREE.ShapeGeometry(shape, 6);
    ribGeo.rotateX(Math.PI / 2); // shape (x, z) -> world x-z plane
    ribGeo.translate(0, sign * y, 0);
    group.add(new THREE.Mesh(ribGeo, mats.rib));

    const outline = new THREE.BufferGeometry().setFromPoints(
      ribProf.map((p) => new THREE.Vector3(xle + p.x * c, sign * y, zb + p.z * c))
    );
    group.add(new THREE.LineLoop(outline, mats.ribLine));
  }
  return group;
}

/** Tapered I-beam main spar at 25% local chord from the sized spar stations. */
function buildMainSpar(THREE, wp, spar, sign, mat) {
  let st = (spar?.stations || []).filter((s) => num(s.depth_m, 0) > 0);
  if (st.length < 2) {
    st = Array.from({ length: 12 }, (_, i) => {
      const y = (wp.semi * i) / 11;
      const c = wp.chord(y);
      return { y_m: y, depth_m: 0.8 * wp.tc * c, cap_width_m: 0.05 * c / wp.cR, cap_thickness_m: 0.008, web_thickness_m: 0.003 };
    });
  }
  st = st.slice().sort((a, b) => num(a.y_m, 0) - num(b.y_m, 0));
  // Map by spanwise fraction: a scrubbed lap's span can differ from the latest spar.
  const yScale = wp.semi / Math.max(num(st[st.length - 1].y_m, wp.semi), 1e-9);
  const zc0 = camberAt(WING_CAMBER, WING_CAMBER_POS, 0.25);
  const parts = { top: [], bot: [], web: [] };
  for (const s of st) {
    const y = num(s.y_m, 0) * yScale;
    const c = wp.chord(y);
    const xs = wp.xle(y) + 0.25 * c;
    const zc = wp.z(y) + zc0 * c;
    const d = num(s.depth_m, 0.2);
    const bw = num(s.cap_width_m, 0.08);
    const ct = num(s.cap_thickness_m, 0.01);
    const wt = Math.max(num(s.web_thickness_m, 0.003), 0.006); // web drawn >= 6 mm so it stays visible
    parts.top.push(rectRing(xs, zc + d / 2 - ct / 2, bw, ct, sign * y));
    parts.bot.push(rectRing(xs, zc - d / 2 + ct / 2, bw, ct, sign * y));
    parts.web.push(rectRing(xs, zc, wt, Math.max(d - 2 * ct, 0.01), sign * y));
  }
  const group = new THREE.Group();
  for (const rings of Object.values(parts)) {
    group.add(new THREE.Mesh(loftRings(THREE, rings, { capStart: true, capEnd: true, flat: true }), mat));
  }
  return group;
}

/** NACA 0012 tail surface with an internal spar at 25% chord. vertical=true lofts along +z. */
function buildTail(THREE, t, vertical, mats) {
  const group = new THREE.Group();
  const prof = naca4(0, 0.4, TAIL_TC, 20);
  const length = vertical ? num(t.height_m, 1.6) : num(t.span_m, 3.8) / 2;
  const cR = num(t.root_chord_m, vertical ? 1.3 : 1.15);
  const cT = num(t.tip_chord_m, vertical ? 0.7 : 0.75);
  const xLe = num(t.x_le_m, vertical ? 6.7 : 6.9);
  const z0 = num(t.z_m, vertical ? 0.25 : 0.15);
  const signs = vertical ? [1] : [-1, 1];
  for (const sign of signs) {
    const stations = [];
    const sparRings = [];
    for (let i = 0; i <= 10; i++) {
      const eta = i / 10;
      const s = eta * length;
      const c = cR + (cT - cR) * eta;
      const xle = vertical ? xLe + 0.45 * eta : xLe + 0.25 * (cR - c);
      const map = vertical ? (x, zt) => [x, zt, z0 + s] : (x, zt) => [x, sign * s, z0 + zt];
      stations.push({ xle, c, k: 1, map });
      const xs = xle + 0.25 * c;
      const d = 0.7 * TAIL_TC * c;
      sparRings.push(
        vertical
          ? rectRing(xs, 0, 0.025, d, 0).map(([x, , zz]) => [x, zz, z0 + s])
          : rectRing(xs, z0, 0.025, d, sign * s)
      );
    }
    const skin = new THREE.Mesh(loftRings(THREE, surfaceRings(prof, stations), { capStart: true, capEnd: true }), mats.tail);
    skin.renderOrder = 2;
    group.add(skin);
    group.add(new THREE.Mesh(loftRings(THREE, sparRings, { capStart: true, capEnd: true, flat: true }), mats.gold));
  }
  return group;
}

function fuselageSection(g) {
  const f = g.fuselage || {};
  const L = num(f.length_m, 8.2);
  const rF = num(f.diameter_m, 1.22) / 2;
  const nL = num(f.nose_length_m, 0.22 * L);
  const tailStart = nL + num(f.cabin_length_m, 0.36 * L);
  const tailL = Math.max(L - tailStart, 0.5);
  return {
    L, rF, nL, tailStart,
    at: (x) => {
      if (x <= nL) {
        const r = rF * (0.24 + 0.76 * Math.pow(Math.sin((Math.min(x / nL, 1) * Math.PI) / 2), 0.6));
        return { ry: r, rz: r * 1.04, zc: 0 };
      }
      if (x <= tailStart) return { ry: rF, rz: rF * 1.04, zc: 0 };
      const t = Math.min((x - tailStart) / tailL, 1);
      const r = Math.max(0.09, rF * (1 - 0.86 * Math.pow(t, 1.1)));
      return { ry: r * 0.95, rz: r, zc: (rF - r) * 0.72 }; // flat top, upswept tailcone
    },
  };
}

function buildFuselage(THREE, g, wp, mats) {
  const group = new THREE.Group();
  const fs = fuselageSection(g);
  const ringAt = (x, scale = 1, n = 36) => {
    const s = fs.at(x);
    return Array.from({ length: n }, (_, j) => {
      const th = (2 * Math.PI * j) / n;
      return [x, s.ry * scale * Math.cos(th), s.zc + s.rz * scale * Math.sin(th)];
    });
  };
  const xs = Array.from({ length: 48 }, (_, i) => fs.L * Math.pow(i / 47, 1.25));
  const skin = new THREE.Mesh(loftRings(THREE, xs.map((x) => ringAt(x)), { capEnd: true }), mats.fuse);
  skin.renderOrder = 3;
  group.add(skin);

  // Internal frames: light ring frames, plus heavy carry-through frames at the wing spars.
  const frame = (x, r, mat, scale) => {
    const curve = new THREE.CatmullRomCurve3(ringAt(x, scale, 24).map((p) => new THREE.Vector3(...p)), true);
    group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 48, r, 6, true), mat));
  };
  for (let x = fs.nL; x < fs.L - 0.6; x += 0.5) frame(x, 0.016, mats.frame, 0.94);
  frame(wp.xle(0) + 0.25 * wp.cR, 0.035, mats.gold, 0.92);
  frame(wp.xle(0) + 0.7 * wp.cR, 0.03, mats.gold, 0.92);

  // Glazed cabin canopy: upper half-ellipsoid over the forward cabin.
  const canopyGeo = new THREE.SphereGeometry(1, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  canopyGeo.rotateX(Math.PI / 2); // dome toward +z
  const xa = fs.nL * 0.82;
  const xb = Math.min(wp.xle(0) + 0.5 * wp.cR, fs.tailStart);
  canopyGeo.scale((xb - xa) / 2, fs.rF * 1.03, fs.rF * 0.88);
  canopyGeo.translate((xa + xb) / 2, 0, fs.rF * 0.05);
  const canopy = new THREE.Mesh(canopyGeo, mats.glass);
  canopy.renderOrder = 4;
  group.add(canopy);
  return { group, fs };
}

/** Fixed tricycle gear. Placement is visual only, not a sized gear. */
function buildGear(THREE, fs, wp, ground, mats) {
  const group = new THREE.Group();
  const wheel = (x, y, r) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, r * 0.6, 20), mats.tire);
    m.position.set(x, y, ground + r);
    group.add(m);
  };
  const xMain = wp.xle(0) + 0.75 * wp.cR;
  const track = Math.max(2.0, Math.min(3.2, 0.24 * wp.semi * 2));
  for (const s of [-1, 1]) {
    group.add(cylinderBetween(THREE, [xMain, s * 0.35, -fs.rF * 0.85], [xMain + 0.05, (s * track) / 2, ground + 0.2], 0.028, mats.gear));
    wheel(xMain + 0.05, (s * track) / 2, 0.2);
  }
  const xNose = fs.nL * 0.55;
  group.add(cylinderBetween(THREE, [xNose, 0, -fs.rF * 0.55], [xNose, 0, ground + 0.17], 0.03, mats.gear));
  wheel(xNose, 0, 0.17);
  return group;
}

/** Two-blade tractor propeller with twisted, tapered blades and spinner. */
function buildPropeller(THREE, g, mats) {
  const R = num(g.propeller?.diameter_m, 1.9) / 2;
  const xProp = -num(g.propeller?.x_m, 0.05) - 0.09;
  const rotor = new THREE.Group();
  rotor.position.x = xProp;
  const bladeRings = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const r = 0.12 + ((R - 0.12) * i) / n;
    const c = 0.16 * (1 - (0.55 * i) / n);
    const th = Math.atan(1.6 / (2 * Math.PI * r)); // constant-pitch twist, P = 1.6 m
    const dx = -Math.sin(th) * c * 0.5;
    const dy = Math.cos(th) * c * 0.5;
    bladeRings.push([[-dx, -dy, r], [dx, dy, r]]);
  }
  for (const rot of [0, Math.PI]) {
    const pos = [];
    const idx = [];
    bladeRings.forEach(([a, b]) => pos.push(...a, ...b));
    for (let i = 0; i < n; i++) idx.push(2 * i, 2 * i + 1, 2 * i + 3, 2 * i, 2 * i + 3, 2 * i + 2);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.rotateX(rot);
    rotor.add(new THREE.Mesh(geo, mats.prop));
  }
  const discGeo = new THREE.CircleGeometry(R, 48);
  discGeo.rotateY(Math.PI / 2);
  rotor.add(new THREE.Mesh(discGeo, mats.disc));

  const spinnerGeo = new THREE.ConeGeometry(0.16, 0.36, 24);
  spinnerGeo.rotateZ(Math.PI / 2); // apex toward -x
  const spinner = new THREE.Mesh(spinnerGeo, mats.spinner);
  spinner.position.x = xProp + 0.06;
  const group = new THREE.Group();
  group.add(rotor, spinner);
  return { group, rotor };
}

/** Schrenk lift curtain l(y) standing on the wing upper surface along the quarter chord. */
function buildLiftCurtain(THREE, wp, lift, mats) {
  const group = new THREE.Group();
  const zUp = camberAt(WING_CAMBER, WING_CAMBER_POS, 0.25) + halfThicknessAt(wp.tc, 0.25);
  for (const sign of [-1, 1]) {
    const n = 64;
    const base = [];
    const top = [];
    for (let i = 0; i <= n; i++) {
      const y = (wp.semi * i) / n;
      const c = wp.chord(y);
      const x = wp.xle(y) + 0.25 * c;
      const zb = wp.z(y) + zUp * c;
      base.push([x, sign * y, zb]);
      top.push([x, sign * y, zb + 0.25 + 1.35 * lift.f(y)]);
    }
    const pos = [];
    const idx = [];
    for (let i = 0; i <= n; i++) pos.push(...base[i], ...top[i]);
    for (let i = 0; i < n; i++) idx.push(2 * i, 2 * i + 2, 2 * i + 3, 2 * i, 2 * i + 3, 2 * i + 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    group.add(new THREE.Mesh(geo, mats.curtain));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(top.map((p) => new THREE.Vector3(...p))), mats.curtainLine));
    const hair = [];
    for (let i = 0; i <= n; i += 4) hair.push(new THREE.Vector3(...base[i]), new THREE.Vector3(...top[i]));
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(hair), mats.curtainHair));
  }
  return group;
}

function makeMaterials(THREE, wingOpacity) {
  const D = THREE.DoubleSide;
  return {
    skin: new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: wingOpacity, side: D, depthWrite: false, roughness: 0.35, metalness: 0.1 }),
    fuse: new THREE.MeshStandardMaterial({ color: 0xe2e8f0, transparent: true, opacity: fuselageOpacity(wingOpacity), side: D, depthWrite: false, roughness: 0.4, metalness: 0.25 }),
    tail: new THREE.MeshStandardMaterial({ color: 0xdbe4ee, transparent: true, opacity: fuselageOpacity(wingOpacity), side: D, depthWrite: false, roughness: 0.4, metalness: 0.2 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.38, roughness: 0.05, metalness: 0, clearcoat: 1, side: D, depthWrite: false }),
    gold: new THREE.MeshStandardMaterial({ color: 0xf5b301, metalness: 0.65, roughness: 0.28, emissive: 0x3a2600, side: D }),
    rib: new THREE.MeshStandardMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.72, side: D, metalness: 0.3, roughness: 0.5 }),
    ribLine: new THREE.LineBasicMaterial({ color: 0xcbd5e1, transparent: true, opacity: 0.85 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x64748b, metalness: 0.4, roughness: 0.5 }),
    gear: new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.6, roughness: 0.4 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.85 }),
    prop: new THREE.MeshStandardMaterial({ color: 0x1f2937, metalness: 0.3, roughness: 0.5, side: D }),
    spinner: new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.6, roughness: 0.25 }),
    disc: new THREE.MeshBasicMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.05, side: D, depthWrite: false }),
    curtain: new THREE.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.22, side: D, depthWrite: false }),
    curtainLine: new THREE.LineBasicMaterial({ color: 0x34d399 }),
    curtainHair: new THREE.LineBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.35 }),
  };
}

function fuselageOpacity(wingOpacity) {
  return Math.min(0.95, 0.3 + 0.65 * wingOpacity);
}

export class AircraftScene {
  constructor(containerEl) {
    this.container = containerEl;
    this.wingOpacity = 0.52;
    this.showLiftCurtain = true;
    this.geometry = null;
    this.loads = null;
    this.spar = null;
    this.propAngle = 0;
    this.cam = { yaw: -0.68, pitch: 0.42, zoom: 1.0, panX: 0, panY: 12, baseScale: 42 };

    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";
    this.canvas.style.cursor = "grab";
    if (this.container) {
      this.container.innerHTML = "";
      this.container.appendChild(this.canvas);
    }
    this.ctx = this.canvas.getContext("2d");
    attachOrbitControls(this.canvas, this.cam, () => this.render());

    this._ro = new ResizeObserver(() => this.resize());
    if (this.container) this._ro.observe(this.container);
    this.resize();
    this.gl = null;
    this._glKey = null;
    loadThree().then((THREE) => {
      if (THREE && !this._disposed) this._initWebGL(THREE);
    });

    this._anim = requestAnimationFrame(() => this._tick());
  }

  _initWebGL(THREE) {
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return; // no WebGL: keep the 2D canvas renderer
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const el = renderer.domElement;
    Object.assign(el.style, {
      width: "100%",
      height: "100%",
      display: "block",
      cursor: "grab",
      background: "radial-gradient(ellipse at center, #111c2d 0%, #070b14 75%)",
    });
    this.canvas.style.display = "none";
    this.container?.appendChild(el);
    attachOrbitControls(el, this.cam, () => this.render());

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdbeafe, 0x0b1220, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-6, -8, 12);
    const rim = new THREE.DirectionalLight(0x7dd3fc, 0.9);
    rim.position.set(10, 8, 4);
    scene.add(key, rim);

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
    camera.up.set(0, 0, 1);

    const hud = document.createElement("div");
    Object.assign(hud.style, {
      position: "absolute",
      left: "12px",
      bottom: "8px",
      font: "11px monospace",
      color: "#94a3b8",
      pointerEvents: "none",
      lineHeight: "1.5",
    });
    this.container?.appendChild(hud);

    this.gl = { THREE, renderer, scene, camera, hud, mats: makeMaterials(THREE, this.wingOpacity), model: null, grid: null, rotor: null, curtain: null };
    this._rebuildModel();
    this.resize();
  }

  _rebuildModel() {
    const gl = this.gl;
    if (!gl) return;
    const g = this.geometry || DEFAULT_GEOMETRY;
    const key = JSON.stringify([g, this.loads?.stations, this.spar?.stations]);
    if (key === this._glKey) return;
    this._glKey = key;

    const { THREE, scene, mats } = gl;
    if (gl.model) {
      scene.remove(gl.model);
      gl.model.traverse((o) => o.geometry?.dispose());
    }
    const model = new THREE.Group();
    const wp = wingPlanform(g);
    const lift = liftFraction(this.loads, wp.semi);
    for (const sign of [-1, 1]) {
      model.add(buildWingSide(THREE, wp, sign, lift, mats));
      model.add(buildMainSpar(THREE, wp, this.spar, sign, mats.gold));
    }
    const { group: fuse, fs } = buildFuselage(THREE, g, wp, mats);
    model.add(fuse);
    model.add(buildTail(THREE, g.horizontal_tail || {}, false, mats));
    model.add(buildTail(THREE, g.vertical_tail || {}, true, mats));
    const ground = -fs.rF * 1.04 - 0.62;
    model.add(buildGear(THREE, fs, wp, ground, mats));
    const prop = buildPropeller(THREE, g, mats);
    model.add(prop.group);
    gl.rotor = prop.rotor;
    gl.curtain = buildLiftCurtain(THREE, wp, lift, mats);
    gl.curtain.visible = this.showLiftCurtain;
    model.add(gl.curtain);
    scene.add(model);
    gl.model = model;

    if (!gl.grid) {
      gl.grid = new THREE.GridHelper(24, 24, 0x1e3a5f, 0x13233a);
      gl.grid.rotateX(Math.PI / 2);
      gl.grid.material.transparent = true;
      gl.grid.material.opacity = 0.6;
      scene.add(gl.grid);
    }
    gl.grid.position.set(fs.L * 0.45, 0, ground);
    gl.center = new THREE.Vector3(fs.L * 0.45, 0, 0.1);
    gl.extent = Math.max(wp.semi * 2, fs.L);

    const tPct = Math.round(wp.tc * 100);
    const cpBar = CP_STOPS.map(([, c]) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`).reverse().join(",");
    gl.hud.innerHTML =
      `Span ${(wp.semi * 2).toFixed(2)} m | Length ${fs.L.toFixed(2)} m | NACA 24${String(tPct).padStart(2, "0")} skin · ${RIBS_PER_SIDE} ribs/side · golden I-spar @ 25% chord<br>` +
      `<span style="display:inline-block;width:90px;height:7px;vertical-align:middle;border-radius:2px;background:linear-gradient(90deg,${cpBar})"></span>` +
      ` C<sub>p</sub> −2.2 … +1: illustrative estimate, not computed · ` +
      `<span style="color:#34d399">lift curtain: ${lift.computed ? "Schrenk l(y), computed" : "elliptic placeholder (no loads yet)"}</span>`;
  }

  _renderGL() {
    const gl = this.gl;
    if (!gl.center) return;
    const { camera, renderer } = gl;
    const { yaw, pitch, zoom, panX, panY } = this.cam;
    const aspect = this.w / this.h;
    camera.aspect = aspect;
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    const R = (1.2 * gl.extent) / (2 * tanHalf * Math.min(aspect, 1.6)) / zoom;
    const cp = Math.cos(pitch);
    const dir = new gl.THREE.Vector3(Math.sin(yaw) * cp, -Math.cos(yaw) * cp, Math.sin(pitch));
    const target = gl.center.clone();
    camera.position.copy(target).addScaledVector(dir, R);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    // Pan in screen pixels, as in the 2D renderer.
    const k = (2 * R * tanHalf) / this.h;
    const shift = new gl.THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(-panX * k);
    shift.addScaledVector(new gl.THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1), panY * k);
    camera.position.add(shift);
    camera.lookAt(target.add(shift));
    camera.updateProjectionMatrix();
    if (gl.rotor) gl.rotor.rotation.x = this.propAngle;
    renderer.render(gl.scene, camera);
  }

  _tick() {
    this.propAngle = (this.propAngle + 0.18) % (Math.PI * 2);
    this.render();
    this._anim = requestAnimationFrame(() => this._tick());
  }

  setViewPreset(preset) {
    const map = {
      iso: { yaw: -0.68, pitch: 0.42, zoom: 1.0, panX: 0, panY: 12 },
      top: { yaw: 0.0, pitch: 1.42, zoom: 1.05, panX: 0, panY: 0 },
      front: { yaw: -1.57, pitch: 0.08, zoom: 1.1, panX: 0, panY: 10 },
      side: { yaw: 0.0, pitch: 0.06, zoom: 1.1, panX: 0, panY: 10 },
      reset: { yaw: -0.68, pitch: 0.42, zoom: 1.0, panX: 0, panY: 12 },
    };
    Object.assign(this.cam, map[preset] || map.iso);
    this.render();
  }

  setWingOpacity(opacity) {
    this.wingOpacity = Math.max(0.1, Math.min(0.95, Number(opacity)));
    if (this.gl) {
      this.gl.mats.skin.opacity = this.wingOpacity;
      this.gl.mats.fuse.opacity = fuselageOpacity(this.wingOpacity);
      this.gl.mats.tail.opacity = fuselageOpacity(this.wingOpacity);
    }
    this.render();
  }

  setShowLiftCurtain(visible) {
    this.showLiftCurtain = Boolean(visible);
    if (this.gl?.curtain) this.gl.curtain.visible = this.showLiftCurtain;
    this.render();
  }

  updateAircraft(geometry, loads = null, spar = null) {
    if (geometry && geometry.geometry && !geometry.fuselage) {
      this.geometry = geometry.geometry;
      this.loads = geometry.loads || loads;
      this.spar = geometry.spar || spar;
    } else {
      this.geometry = geometry;
      this.loads = loads;
      this.spar = spar;
    }
    this._rebuildModel();
    this.render();
  }

  resize() {
    if (!this.container) return;
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(320, rect.width || 640);
    const h = Math.max(260, rect.height || 380);
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
    this.cam.baseScale = Math.min(w, h) * 0.072;
    this.gl?.renderer.setSize(w, h, false);
    this.render();
  }

  render() {
    if (!this.w) return;
    if (this.gl) this._renderGL();
    else this._render2D();
  }

  _render2D() {
    const ctx = this.ctx;
    if (!ctx || !this.w) return;
    const W = this.w;
    const H = this.h;
    ctx.clearRect(0, 0, W, H);

    const bg = ctx.createRadialGradient(W * 0.5, H * 0.5, 20, W * 0.5, H * 0.5, Math.max(W, H) * 0.7);
    bg.addColorStop(0, "#111c2d");
    bg.addColorStop(1, "#070b14");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const g = this.geometry || DEFAULT_GEOMETRY;

    const fuseL = Number(g.fuselage?.length_m || 8.2);
    const cxOff = fuseL * 0.45;
    const P = (x, y, z) => project3D(x - cxOff, y, z, this.cam, W, H);

    ctx.strokeStyle = "rgba(56, 189, 248, 0.11)";
    ctx.lineWidth = 1;
    for (let i = -6; i <= 6; i += 1.5) {
      const a = P(cxOff + i, -6, -1.1);
      const b = P(cxOff + i, 6, -1.1);
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      const c = P(cxOff - 6, i, -1.1);
      const d = P(cxOff + 6, i, -1.1);
      ctx.beginPath(); ctx.moveTo(c.sx, c.sy); ctx.lineTo(d.sx, d.sy); ctx.stroke();
    }

    const drawPoly = (pts3d, fill, stroke, lw = 1.4) => {
      const pts = pts3d.map(([x, y, z]) => P(x, y, z));
      ctx.beginPath();
      pts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.sx, p.sy) : ctx.lineTo(p.sx, p.sy)));
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
    };

    const rF = Number(g.fuselage?.diameter_m || 1.22) * 0.5;
    const nL = Number(g.fuselage?.nose_length_m || 1.8);
    const cL = Number(g.fuselage?.cabin_length_m || 3.0);
    const stations = [
      [0, 0.14, -0.05],
      [nL, rF, 0.08],
      [nL + cL, rF * 0.92, 0.06],
      [fuseL, 0.12, 0.18],
    ];
    for (let i = 0; i < stations.length - 1; i++) {
      const [x0, r0, z0] = stations[i];
      const [x1, r1, z1] = stations[i + 1];
      drawPoly([[x0, -r0, z0 + r0], [x1, -r1, z1 + r1], [x1, r1, z1 + r1], [x0, r0, z0 + r0]], "rgba(30, 58, 95, 0.86)", "#38bdf8", 1.1);
      drawPoly([[x0, r0, z0 - r0], [x1, r1, z1 - r1], [x1, r1, z1 + r1], [x0, r0, z0 + r0]], "rgba(15, 23, 42, 0.88)", "#334155", 1.0);
      drawPoly([[x0, -r0, z0 - r0], [x1, -r1, z1 - r1], [x1, -r1, z1 + r1], [x0, -r0, z0 + r0]], "rgba(15, 23, 42, 0.88)", "#334155", 1.0);
    }
    drawPoly(
      [[nL * 0.75, -rF * 0.72, rF * 0.55], [nL + cL * 0.55, -rF * 0.68, rF * 0.95], [nL + cL * 0.55, rF * 0.68, rF * 0.95], [nL * 0.75, rF * 0.72, rF * 0.55]],
      "rgba(56, 189, 248, 0.35)",
      "#7dd3fc",
      1.3
    );

    const wSpan = Number(g.wing?.span_m || 10.8);
    const semi = wSpan * 0.5;
    const cRoot = Number(g.wing?.root_chord_m || 1.8);
    const cTip = Number(g.wing?.tip_chord_m || 1.08);
    const xLe = Number(g.wing?.x_le_m || 2.6);
    const zW = Number(g.wing?.z_m ?? 0.52);
    const dih = ((Number(g.wing?.dihedral_deg || 2.0) * Math.PI) / 180) * semi;
    const sweepTip = (cRoot - cTip) * 0.25;

    for (const sign of [-1, 1]) {
      const xSparR = xLe + 0.25 * cRoot;
      const xSparT = xLe + sweepTip + 0.25 * cTip;
      drawPoly(
        [[xSparR - 0.06, 0, zW - 0.09], [xSparT - 0.04, sign * semi, zW + dih - 0.05], [xSparT + 0.04, sign * semi, zW + dih + 0.05], [xSparR + 0.06, 0, zW + 0.09]],
        "rgba(245, 158, 11, 0.92)",
        "#fde68a",
        1.8
      );
      drawPoly(
        [[xLe, 0, zW], [xLe + sweepTip, sign * semi, zW + dih], [xLe + sweepTip + cTip, sign * semi, zW + dih], [xLe + cRoot, 0, zW]],
        `rgba(56, 189, 248, ${this.wingOpacity})`,
        "#38bdf8",
        1.5
      );
    }

    const ht = g.horizontal_tail || {};
    const htSemi = Number(ht.span_m || 3.8) * 0.5;
    const htX = Number(ht.x_le_m || 6.9);
    const htZ = Number(ht.z_m || 0.15);
    const htCr = Number(ht.root_chord_m || 1.15);
    const htCt = Number(ht.tip_chord_m || 0.75);
    for (const s of [-1, 1]) {
      drawPoly(
        [[htX, 0, htZ], [htX + 0.15, s * htSemi, htZ], [htX + 0.15 + htCt, s * htSemi, htZ], [htX + htCr, 0, htZ]],
        "rgba(56, 189, 248, 0.42)",
        "#38bdf8",
        1.2
      );
    }
    const vt = g.vertical_tail || {};
    const vtX = Number(vt.x_le_m || 6.7);
    const vtZ = Number(vt.z_m || 0.25);
    const vtH = Number(vt.height_m || 1.6);
    drawPoly(
      [[vtX, 0, vtZ], [vtX + 0.45, 0, vtZ + vtH], [vtX + 0.45 + Number(vt.tip_chord_m || 0.7), 0, vtZ + vtH], [vtX + Number(vt.root_chord_m || 1.3), 0, vtZ]],
      "rgba(56, 189, 248, 0.5)",
      "#7dd3fc",
      1.3
    );

    const propR = Number(g.propeller?.diameter_m || 1.9) * 0.5;
    for (let b = 0; b < 2; b++) {
      const ang = this.propAngle + b * Math.PI;
      const a = P(-0.08, Math.cos(ang) * propR, Math.sin(ang) * propR);
      const c = P(-0.08, -Math.cos(ang) * propR, -Math.sin(ang) * propR);
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(c.sx, c.sy);
      ctx.strokeStyle = "#e2e8f0"; ctx.lineWidth = 2.6; ctx.stroke();
    }

    if (this.showLiftCurtain) {
      const st = this.loads?.stations || [];
      const maxL = st.length ? Math.max(...st.map((s) => Number(s.schrenk_lift_n_per_m ?? s.l_schrenk_n_per_m ?? 1)), 1) : 1;
      for (const sign of [-1, 1]) {
        const N = st.length || 12;
        const topPts = [];
        const basePts = [];
        for (let i = 0; i < N; i++) {
          const eta = i / Math.max(N - 1, 1);
          const y = sign * semi * eta;
          const liftFrac = st.length
            ? Number(st[i].schrenk_lift_n_per_m ?? st[i].l_schrenk_n_per_m ?? 0) / maxL
            : Math.sqrt(Math.max(0, 1 - eta * eta));
          const x = xLe + 0.25 * cRoot + eta * sweepTip;
          const zBase = zW + Math.abs(eta) * dih;
          const zTop = zBase + 0.35 + liftFrac * 1.35;
          basePts.push([x, y, zBase]);
          topPts.push([x, y, zTop]);
        }
        drawPoly([...basePts, ...topPts.slice().reverse()], "rgba(16, 185, 129, 0.22)", "#10b981", 1.4);
      }
    }

    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px monospace";
    ctx.fillText(`Span: ${wSpan.toFixed(2)} m | Length: ${fuseL.toFixed(2)} m | Internal Golden I-Spar @ 25% MAC`, 14, H - 12);
  }

  dispose() {
    this._disposed = true;
    if (this._anim) cancelAnimationFrame(this._anim);
    this._ro?.disconnect();
    if (this.gl) {
      this.gl.scene.traverse((o) => o.geometry?.dispose());
      Object.values(this.gl.mats).forEach((m) => m.dispose());
      this.gl.renderer.dispose();
      this.gl.renderer.domElement.remove();
      this.gl.hud.remove();
      this.gl = null;
    }
  }
}
