/**
 * hero3d.js - Spiral landing-page background: "the design spiral converging".
 *
 * Three arms of glowing points stream inward along a conical logarithmic
 * spiral onto one bright core (the converged design). A faint wireframe
 * aircraft turns slowly at its heart, above a perspective grid far below.
 * In "ready", ~1.4k of the spiral's own points fly out of the arms and
 * assemble into the aircraft, nose first.
 *
 *   const hero = mountHero(layerEl);   // layerEl: full-bleed layer behind the chat
 *   hero.setMode("idle" | "thinking" | "ready");
 *   hero.dispose();
 *
 * No network and no post-processing. About 6.6k points plus 700 trails are
 * updated on the CPU each frame; quality steps down by itself on slow GPUs.
 */
import * as THREE from "./vendor/three.module.js";

const NOOP = Object.freeze({ setMode() {}, dispose() {} });
const TAU = Math.PI * 2;

// Colours are authored as display values and the renderer outputs them
// untransformed, so additive glow blends predictably, like CSS colours.
const RAW = THREE.LinearSRGBColorSpace;
const C = (hex) => new THREE.Color().setStyle(hex, RAW);

// Spiral shape: r runs R_MAX (rim) -> R_MIN (core), theta = arm + TWIST * ln(R_MAX / r).
const R_MAX = 10.5;
const R_MIN = 0.16;
const TWIST = 1.9;
const ARMS = 3;
const EXP = 1.3; // r ~ (1 - p)^EXP; > 1 packs points toward the core
const FUNNEL = 1.5; // rim lift: a shallow vortex funnel draining into the core

const CAM = { x: 0, y: 9, z: 12 };
const LOOK = { x: 0, y: -2.8, z: 0 }; // aim below the core so it sits ~1/3 down the screen
const PLANE_SCALE = 0.78;
const ASSEMBLE = 1400; // spiral points that become the aircraft in "ready"
const TRAIL_LAG = 0.5; // seconds of history drawn behind each spark

// Per-mode targets; the live state eases toward them (settles in ~0.6 s).
const MODES = {
  idle: { speed: 1.0, spin: 0.05, bright: 0.85, violet: 0.06, tighten: 0.0, plane: 0.16, accent: 0.0, pulse: 0.0, dolly: 0.0, trail: 0.5, scan: 0.35 },
  thinking: { speed: 2.7, spin: 0.17, bright: 1.15, violet: 0.7, tighten: 0.06, plane: 0.22, accent: 0.2, pulse: 1.0, dolly: 1.0, trail: 1.0, scan: 1.0 },
  ready: { speed: 0.5, spin: 0.04, bright: 0.95, violet: 0.0, tighten: 0.25, plane: 0.4, accent: 1.0, pulse: 0.0, dolly: 0.3, trail: 0.3, scan: 0.0 },
};

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function gauss() {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * Math.random());
}

export function mountHero(container) {
  if (!container || typeof document === "undefined") return NOOP;
  try {
    return mount(container) || NOOP;
  } catch (err) {
    console.warn("[hero3d] background disabled:", err);
    return NOOP;
  }
}

function glowTexture(size, stops) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, a] of stops) grad.addColorStop(o, `rgba(255,255,255,${a})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

// Additive glow that never writes canvas alpha: the transparent canvas then
// adds light over the page instead of also dimming the page behind dim lines.
function glow(m) {
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.SrcAlphaFactor;
  m.blendDst = THREE.OneFactor;
  m.blendSrcAlpha = THREE.ZeroFactor;
  m.blendDstAlpha = THREE.OneFactor;
  return m;
}

// PointsMaterial plus a per-point size multiplier (attribute aSize).
function pointsMaterial(size, map) {
  const m = glow(new THREE.PointsMaterial({ size, map, vertexColors: true, sizeAttenuation: true }));
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("uniform float size;", "uniform float size;\nattribute float aSize;")
      .replace("gl_PointSize = size;", "gl_PointSize = size * aSize;");
  };
  return m;
}

function dynAttr(array, itemSize) {
  return new THREE.BufferAttribute(array, itemSize).setUsage(THREE.DynamicDrawUsage);
}

function makeLayer(opts, tex) {
  const n = opts.count;
  const L = {
    n,
    drawN: n,
    gain: opts.gain,
    spread: opts.spread,
    pos: new Float32Array(n * 3),
    col: new Float32Array(n * 3),
    size: new Float32Array(n),
    p: new Float32Array(n), // progress: 0 = rim, 1 = core
    arm: new Float32Array(n),
    off: new Float32Array(n * 3),
    spd: new Float32Array(n),
    base: new Float32Array(n * 3),
    vw: new Float32Array(n), // how strongly this point turns violet when thinking
    twf: new Float32Array(n),
    twp: new Float32Array(n),
    sz: new Float32Array(n),
    asm: new Int32Array(n).fill(-1), // index into the aircraft targets, or -1
    trail: null,
  };
  const blueA = C("#0ea5e9");
  const blueB = C("#7dd3fc");
  const white = C("#e8f6ff");
  const vioA = C("#a78bfa");
  const vioB = C("#c4b5fd");
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const haze = Math.random() < opts.haze;
    L.arm[i] = haze ? Math.random() * TAU : ((i % ARMS) / ARMS) * TAU + gauss() * 0.1;
    L.p[i] = Math.random();
    const sc = haze ? 2.4 : 1;
    L.off[i * 3] = gauss() * sc;
    L.off[i * 3 + 1] = gauss() * sc;
    L.off[i * 3 + 2] = gauss() * sc;
    L.spd[i] = 0.75 + Math.random() * 0.5;
    const roll = Math.random();
    if (roll < opts.white) c.copy(white);
    else if (roll < opts.white + opts.violet) c.copy(vioA).lerp(vioB, Math.random());
    else c.copy(blueA).lerp(blueB, Math.random());
    L.base[i * 3] = c.r;
    L.base[i * 3 + 1] = c.g;
    L.base[i * 3 + 2] = c.b;
    L.vw[i] = 0.4 + 0.6 * Math.random();
    L.twf[i] = 0.5 + 2.2 * Math.random();
    L.twp[i] = Math.random() * TAU;
    L.sz[i] = 0.6 + 0.8 * Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", dynAttr(L.pos, 3));
  geo.setAttribute("color", dynAttr(L.col, 3));
  geo.setAttribute("aSize", dynAttr(L.size, 1));
  L.geo = geo;
  L.points = new THREE.Points(geo, pointsMaterial(opts.size, tex));
  L.points.frustumCulled = false; // positions move every frame

  if (opts.trails) {
    const tPos = new Float32Array(n * 12); // 2 segments (4 vertices) per point
    const tCol = new Float32Array(n * 12);
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute("position", dynAttr(tPos, 3));
    tGeo.setAttribute("color", dynAttr(tCol, 3));
    const tMat = glow(new THREE.LineBasicMaterial({ vertexColors: true }));
    const lines = new THREE.LineSegments(tGeo, tMat);
    lines.frustumCulled = false;
    L.trail = { pos: tPos, col: tCol, geo: tGeo, mat: tMat, lines };
  }
  return L;
}

// Wireframe airliner from primitives, merged into one LineSegments geometry.
// Nose points along +X, span along Z, up is +Y.
function buildAircraftEdges() {
  const chunks = [];
  const add = (geo, threshold) => {
    const edges = new THREE.EdgesGeometry(geo, threshold);
    chunks.push(edges.getAttribute("position").array);
    edges.dispose();
    geo.dispose();
  };

  // Fuselage: lathe profile revolved about Y, then laid along +X.
  const profile = [
    [0.02, 2.62], [0.12, 2.45], [0.23, 2.16], [0.3, 1.72], [0.335, 1.05],
    [0.335, -0.35], [0.3, -1.2], [0.22, -1.92], [0.12, -2.42], [0.04, -2.62],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const fus = new THREE.LatheGeometry(profile, 14);
  fus.rotateZ(-Math.PI / 2);
  add(fus, 8);

  // Lifting surfaces: tapered, swept planforms (x along fuselage, y = span),
  // extruded thin, laid flat and given a little dihedral.
  const panel = (rootLE, rootTE, tipLE, tipTE, span, thick) => {
    const s = new THREE.Shape();
    s.moveTo(rootLE, 0);
    s.lineTo(tipLE, span);
    s.lineTo(tipTE, span);
    s.lineTo(rootTE, 0);
    const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false, steps: 1 });
    g.translate(0, 0, -thick / 2);
    return g;
  };
  const surface = (rootLE, rootTE, tipLE, tipTE, span, thick, dihedral, x, y) => {
    for (const side of [1, -1]) {
      const g = panel(rootLE, rootTE, tipLE, tipTE, span * side, thick);
      g.rotateX(Math.PI / 2); // span -> +/-Z, thickness -> Y
      g.rotateX(-side * dihedral); // tips up
      g.translate(x, y, 0);
      add(g, 10);
    }
  };
  surface(0.78, -0.58, -0.55, -0.98, 3.25, 0.05, 0.07, 0.05, -0.16); // wing
  surface(-1.78, -2.42, -2.3, -2.6, 1.25, 0.035, 0.03, 0, 0.08); // tailplane

  // Fin, drawn directly in the XY plane.
  const fin = new THREE.Shape();
  fin.moveTo(-1.62, 0);
  fin.lineTo(-2.28, 1.18);
  fin.lineTo(-2.62, 1.18);
  fin.lineTo(-2.52, 0);
  const finGeo = new THREE.ExtrudeGeometry(fin, { depth: 0.035, bevelEnabled: false, steps: 1 });
  finGeo.translate(0, 0.2, -0.0175);
  add(finGeo, 10);

  // Engine nacelles under the wing (wider intake forward).
  for (const side of [1, -1]) {
    const nac = new THREE.CylinderGeometry(0.15, 0.12, 0.82, 10, 1, true);
    nac.rotateZ(-Math.PI / 2);
    nac.translate(0.62, -0.42, 1.15 * side);
    add(nac, 20);
  }

  let total = 0;
  for (const ch of chunks) total += ch.length;
  const all = new Float32Array(total);
  let o = 0;
  for (const ch of chunks) {
    all.set(ch, o);
    o += ch.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(all, 3));
  geo.setAttribute("color", dynAttr(new Float32Array(total).fill(1), 3));
  return geo;
}

// Sample points along the wireframe's edges, evenly by length.
function sampleEdges(positions, count) {
  const segs = positions.length / 6;
  const cum = new Float32Array(segs);
  let total = 0;
  for (let s = 0; s < segs; s++) {
    const o = s * 6;
    total += Math.hypot(positions[o + 3] - positions[o], positions[o + 4] - positions[o + 1], positions[o + 5] - positions[o + 2]);
    cum[s] = total;
  }
  const out = new Float32Array(count * 3);
  let s = 0;
  for (let j = 0; j < count; j++) {
    const u = ((j + Math.random()) / count) * total;
    while (s < segs - 1 && cum[s] < u) s++;
    const start = s > 0 ? cum[s - 1] : 0;
    const len = cum[s] - start || 1;
    const t = Math.min(1, Math.max(0, (u - start) / len));
    const o = s * 6;
    for (let k = 0; k < 3; k++) out[j * 3 + k] = positions[o + k] + (positions[o + 3 + k] - positions[o + k]) * t;
  }
  return out;
}

// Perspective grid far below, faded by vertex colour: brightest under and
// behind the core, dark under the camera (the bottom of the screen, where the
// composer sits) and toward the edges.
function buildGrid(color) {
  const STEP = 2.5;
  const Y = -6;
  const X0 = -51.25, X1 = 51.25, Z0 = -45, Z1 = 12.5; // x offset: no line straight under the core
  const pos = [];
  const col = [];
  const weight = (x, z) => 0.13 * Math.exp(-(x * x + (z + 8) * (z + 8)) / 260) * (1 - smooth(-2, 7, z));
  const push = (x, z) => {
    const w = weight(x, z);
    pos.push(x, Y, z);
    col.push(color.r * w, color.g * w, color.b * w);
  };
  for (let z = Z0; z <= Z1 + 1e-6; z += STEP) {
    for (let x = X0; x < X1 - 1e-6; x += STEP) { push(x, z); push(x + STEP, z); }
  }
  for (let x = X0; x <= X1 + 1e-6; x += STEP) {
    for (let z = Z0; z < Z1 - 1e-6; z += STEP) { push(x, z); push(x, z + STEP); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return new THREE.LineSegments(geo, glow(new THREE.LineBasicMaterial({ vertexColors: true })));
}

function mount(container) {
  const reduced =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;";

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
  } catch (err) {
    console.warn("[hero3d] WebGL unavailable:", err && err.message);
    return null;
  }

  const textures = [];
  try {
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = RAW;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x000000, 20, 44); // black fog + additive blending = fade to nothing
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    camera.position.set(CAM.x, CAM.y, CAM.z);
    camera.lookAt(LOOK.x, LOOK.y, LOOK.z);

    const dotTex = glowTexture(64, [[0, 1], [0.2, 0.9], [0.45, 0.28], [1, 0]]);
    const glowTex = glowTexture(128, [[0, 1], [0.1, 0.75], [0.3, 0.22], [0.65, 0.04], [1, 0]]);
    const bokehTex = glowTexture(64, [[0, 0.5], [0.55, 0.42], [0.8, 0.18], [1, 0]]);
    textures.push(dotTex, glowTex, bokehTex);

    const cSky = C("#38bdf8");
    const cVio = C("#a78bfa");
    const cGreen = C("#34d399");
    const cWhite = C("#ffffff");
    const cMuted = C("#7d9cc0");

    // ---- spiral -------------------------------------------------------------
    const spiral = new THREE.Group();
    spiral.rotation.set(0.05, 0, -0.08);
    scene.add(spiral);
    spiral.updateMatrixWorld(true);
    const spiralInv = spiral.matrixWorld.clone().invert();

    const dust = makeLayer({ count: 5200, size: 0.09, gain: 0.8, spread: 1, white: 0.14, violet: 0.07, haze: 0.12 }, dotTex);
    const sparks = makeLayer({ count: 700, size: 0.17, gain: 0.75, spread: 0.7, white: 0.4, violet: 0.08, haze: 0.03, trails: true }, dotTex);
    const layers = [dust, sparks];
    spiral.add(dust.points, sparks.points, sparks.trail.lines);

    // "ready" shock ring (verified green), expanding across the disc.
    const ringPts = new Float32Array(129 * 3);
    for (let k = 0; k <= 128; k++) {
      const a = (k / 128) * TAU;
      ringPts[k * 3] = Math.cos(a);
      ringPts[k * 3 + 2] = Math.sin(a);
    }
    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute("position", new THREE.BufferAttribute(ringPts, 3));
    const ringMat = glow(new THREE.LineBasicMaterial({ color: cGreen.clone(), opacity: 0, fog: false }));
    const ring = new THREE.Line(ringGeo, ringMat);
    ring.visible = false;
    ring.frustumCulled = false;
    spiral.add(ring);

    // Core: a tight white point inside a soft blue halo.
    const haloMat = glow(new THREE.SpriteMaterial({ map: glowTex, color: cSky.clone(), opacity: 0.25, fog: false }));
    const halo = new THREE.Sprite(haloMat);
    const coreMat = glow(new THREE.SpriteMaterial({ map: glowTex, color: 0xffffff, opacity: 0.8, fog: false }));
    const core = new THREE.Sprite(coreMat);
    spiral.add(halo, core);

    // ---- aircraft -------------------------------------------------------------
    const planeGeo = buildAircraftEdges();
    const planePos = planeGeo.getAttribute("position").array;
    const planeCol = planeGeo.getAttribute("color");
    const planeMat = glow(new THREE.LineBasicMaterial({ color: cMuted.clone(), vertexColors: true, opacity: 0.16, fog: false }));
    const echoMat = planeMat.clone();
    echoMat.color.copy(cSky);
    echoMat.opacity = 0;
    const plane = new THREE.Group();
    const echo = new THREE.LineSegments(planeGeo, echoMat);
    echo.visible = false;
    plane.add(new THREE.LineSegments(planeGeo, planeMat), echo);
    plane.position.set(0, 0.3, 0);
    plane.rotation.y = -0.6;
    plane.scale.setScalar(PLANE_SCALE);
    scene.add(plane);

    // Assembly: every other dust point (from the start of the buffer, so it
    // survives quality cuts) gets a target on the wireframe and a nose-first delay.
    const asmLocal = sampleEdges(planePos, ASSEMBLE);
    const asmT = new Float32Array(ASSEMBLE * 3); // targets in spiral space, per frame
    const asmW = new Float32Array(ASSEMBLE); // 0 = in the spiral, 1 = on the aircraft
    const asmDelay = new Float32Array(ASSEMBLE);
    for (let j = 0; j < ASSEMBLE; j++) {
      dust.asm[j * 2] = j;
      asmDelay[j] = 0.1 + 0.6 * ((2.7 - asmLocal[j * 3]) / 5.4) + 0.15 * Math.random();
    }
    const asmMatrix = new THREE.Matrix4();

    // ---- atmosphere ---------------------------------------------------------------
    const grid = buildGrid(cSky);
    scene.add(grid);

    // Out-of-focus motes drifting between the camera and the spiral.
    const MOTES = 70;
    const moteBase = new Float32Array(MOTES * 4);
    const motePos = new Float32Array(MOTES * 3);
    const moteCol = new Float32Array(MOTES * 3);
    const moteSize = new Float32Array(MOTES);
    for (let i = 0; i < MOTES; i++) {
      const a = Math.random() * TAU;
      const r = 5 + Math.random() * 12;
      moteBase[i * 4] = Math.cos(a) * r;
      moteBase[i * 4 + 1] = -1 + Math.random() * 7;
      moteBase[i * 4 + 2] = Math.sin(a) * r;
      moteBase[i * 4 + 3] = Math.random() * TAU;
      moteSize[i] = 0.6 + Math.random() * 1.1;
    }
    const moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute("position", dynAttr(motePos, 3));
    moteGeo.setAttribute("color", dynAttr(moteCol, 3));
    moteGeo.setAttribute("aSize", new THREE.BufferAttribute(moteSize, 1));
    const motes = new THREE.Points(moteGeo, pointsMaterial(0.55, bokehTex));
    motes.frustumCulled = false;
    scene.add(motes);

    // ---- state --------------------------------------------------------------------
    let mode = "idle";
    const S = { ...MODES.idle };
    const T = { ...MODES.idle };
    let time = 0;
    let spin = 0;
    let scanPhase = 0;
    let readyAge = Infinity;
    let landedAt = Infinity; // readyAge at which the aircraft finished assembling
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const camLocal = new THREE.Vector3();
    const tmp = new Float32Array(9);
    const vr = cVio.r, vg = cVio.g, vb = cVio.b;

    function spiralXYZ(L, i, q, sp, rScale, sScale, out, o) {
      const r0 = R_MIN + (R_MAX - R_MIN) * Math.pow(1 - q, EXP);
      const th = L.arm[i] + sp + TWIST * Math.log(R_MAX / r0);
      const r = r0 * rScale;
      const s = (0.035 + 0.05 * r0) * sScale;
      const i3 = i * 3;
      const rn = r0 / R_MAX;
      out[o] = r * Math.cos(th) + L.off[i3] * s;
      out[o + 1] = FUNNEL * rn * Math.sqrt(rn) * rScale + L.off[i3 + 1] * s * 0.35;
      out[o + 2] = r * Math.sin(th) + L.off[i3 + 2] * s;
    }

    function updateLayer(L, dt, speed, tighten, spinRate, focus) {
      const flow = 0.026 * speed;
      const rScale = 1 - 0.5 * tighten;
      const sScale = (1 - 0.45 * tighten) * L.spread;
      const gain = S.bright * L.gain;
      const vMix = S.violet;
      const { pos, col, size, p, off, spd, base, vw, twf, twp, sz, asm, trail } = L;
      const cx = camLocal.x, cy = camLocal.y, cz = camLocal.z;
      const trailGain = S.trail;
      for (let i = 0, n = L.drawN; i < n; i++) {
        const j = asm[i];
        const w = j >= 0 ? asmW[j] : 0;
        let q = p[i];
        if (w <= 0) {
          q += flow * spd[i] * dt;
          if (q >= 1) q -= 1; // respawn at the rim (invisible: faded at both ends)
          p[i] = q;
        }
        spiralXYZ(L, i, q, spin, rScale, sScale, tmp, 0);
        let x = tmp[0], y = tmp[1], z = tmp[2];
        // Fade in at the rim, out into the core.
        let a = smooth(0, 0.06, q) * (1 - smooth(0.86, 0.985, q));
        // Calm zone: the near side of the disc, centred, is where the chat sits on screen.
        a *= 1 - 0.85 * smooth(0.5, 4.5, z) * Math.exp(-(x * x) / 26);
        // Depth of field: away from the core's distance, points grow and dim.
        const dx = x - cx, dy = y - cy, dz = z - cz;
        const blur = Math.min(1, Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - focus) / 8);
        a *= 1 - 0.6 * blur;
        let sm = sz[i] * (1 + 1.4 * blur * blur);
        const tw = 0.8 + 0.2 * Math.sin(time * twf[i] + twp[i]);
        // Colour: base -> violet (thinking) -> white as it nears the core.
        const i3 = i * 3;
        const m = vMix * vw[i];
        let cr = base[i3] + (vr - base[i3]) * m;
        let cg = base[i3 + 1] + (vg - base[i3 + 1]) * m;
        let cb = base[i3 + 2] + (vb - base[i3 + 2]) * m;
        const wm = smooth(0.6, 0.95, q) * 0.5;
        cr += (1 - cr) * wm;
        cg += (1 - cg) * wm;
        cb += (1 - cb) * wm;
        if (w > 0) {
          // Fly out of the arm and onto the aircraft, swirling and lifting en route.
          const e = w * w * (3 - 2 * w);
          const t3 = j * 3;
          const arc = e * (1 - e);
          let mx = x + (asmT[t3] - x) * e;
          let mz = z + (asmT[t3 + 2] - z) * e;
          y += (asmT[t3 + 1] - y) * e + 1.6 * arc;
          const ph = 2.2 * arc;
          const cph = Math.cos(ph), sph = Math.sin(ph);
          x = mx * cph - mz * sph;
          z = mx * sph + mz * cph;
          a += (1.1 - a) * e;
          sm += (1.0 - sm) * e;
          cr += (0.72 - cr) * e * 0.85;
          cg += (0.94 - cg) * e * 0.85;
          cb += (1.0 - cb) * e * 0.85;
        }
        pos[i3] = x;
        pos[i3 + 1] = y;
        pos[i3 + 2] = z;
        size[i] = sm;
        const k = a * tw * gain;
        col[i3] = cr * k;
        col[i3 + 1] = cg * k;
        col[i3 + 2] = cb * k;

        if (trail) {
          // Two segments back along the path this point travelled.
          const dq = flow * spd[i] * TRAIL_LAG;
          spiralXYZ(L, i, Math.max(0, q - dq * 0.5), spin - spinRate * TRAIL_LAG * 0.5, rScale, sScale, tmp, 3);
          spiralXYZ(L, i, Math.max(0, q - dq), spin - spinRate * TRAIL_LAG, rScale, sScale, tmp, 6);
          const o = i * 12;
          const tp = trail.pos, tc = trail.col;
          tp[o] = x; tp[o + 1] = y; tp[o + 2] = z;
          tp[o + 3] = tmp[3]; tp[o + 4] = tmp[4]; tp[o + 5] = tmp[5];
          tp[o + 6] = tmp[3]; tp[o + 7] = tmp[4]; tp[o + 8] = tmp[5];
          tp[o + 9] = tmp[6]; tp[o + 10] = tmp[7]; tp[o + 11] = tmp[8];
          const kh = k * 0.55 * trailGain, km = k * 0.2 * trailGain;
          tc[o] = cr * kh; tc[o + 1] = cg * kh; tc[o + 2] = cb * kh;
          tc[o + 3] = cr * km; tc[o + 4] = cg * km; tc[o + 5] = cb * km;
          tc[o + 6] = cr * km; tc[o + 7] = cg * km; tc[o + 8] = cb * km;
          tc[o + 9] = 0; tc[o + 10] = 0; tc[o + 11] = 0;
        }
      }
      const g = L.geo.attributes;
      g.position.needsUpdate = true;
      g.color.needsUpdate = true;
      g.aSize.needsUpdate = true;
      if (trail) {
        trail.geo.attributes.position.needsUpdate = true;
        trail.geo.attributes.color.needsUpdate = true;
      }
    }

    function step(dt) {
      time += dt;
      readyAge += dt;
      const ease = dt > 0 ? 1 - Math.exp(-dt / 0.2) : 0;
      for (const key in T) S[key] += (T[key] - S[key]) * ease;

      // "ready" burst envelope: fast rise, ~1 s decay, peak 1.
      const env = readyAge < 8
        ? Math.min(1, ((1 - Math.exp(-readyAge / 0.12)) * Math.exp(-readyAge / 1.1)) / 0.7)
        : 0;
      const since = readyAge - landedAt;
      const bloom = since >= 0 ? Math.exp(-since / 0.45) : 0;
      const speed = S.speed + 2.4 * env;
      const tighten = Math.min(0.85, S.tighten + 0.42 * env);
      const spinRate = S.spin * (1 + 1.5 * env);
      spin += dt * spinRate;

      // Camera: slow drift plus a small, lerped mouse parallax.
      const km = dt > 0 ? 1 - Math.exp(-dt * 2.2) : 0;
      mouse.x += (mouse.tx - mouse.x) * km;
      mouse.y += (mouse.ty - mouse.y) * km;
      camera.position.set(
        CAM.x + Math.sin(time * 0.09) * 0.6 + mouse.x * 0.9,
        CAM.y + Math.sin(time * 0.063 + 1.3) * 0.28 - mouse.y * 0.45,
        CAM.z + Math.cos(time * 0.05) * 0.3 - S.dolly * 0.9,
      );
      camera.lookAt(LOOK.x + mouse.x * 0.3, LOOK.y, LOOK.z);
      camLocal.copy(camera.position).applyMatrix4(spiralInv);
      const focus = camLocal.length();

      // Aircraft: turns slowly, as if on the drawing board.
      plane.rotation.y += dt * (0.075 + 0.06 * S.pulse);
      plane.rotation.x = Math.sin(time * 0.23) * 0.05;
      plane.rotation.z = Math.sin(time * 0.31 + 0.7) * 0.035;
      plane.scale.setScalar(PLANE_SCALE * (1 + 0.05 * bloom));
      plane.updateMatrixWorld(true);
      // Scan line sweeping nose to tail ("being read" while thinking).
      scanPhase += dt * (0.12 + 0.3 * S.pulse);
      const xs = 3.0 - (scanPhase % 1) * 6.0;
      const pc = planeCol.array;
      const baseV = 1 - 0.45 * S.scan;
      for (let v = 0, nv = pc.length / 3; v < nv; v++) {
        const d = (planePos[v * 3] - xs) / 0.35;
        const val = baseV + 2.2 * S.scan * Math.exp(-d * d);
        pc[v * 3] = val; pc[v * 3 + 1] = val; pc[v * 3 + 2] = val;
      }
      planeCol.needsUpdate = true;

      // Assembly weights and this frame's targets in spiral space.
      const assembling = mode === "ready";
      let any = false;
      let sum = 0;
      for (let j = 0; j < ASSEMBLE; j++) {
        let w = asmW[j];
        if (assembling) {
          if (readyAge > asmDelay[j]) w = Math.min(1, w + dt / 0.9);
        } else if (w > 0) {
          w = Math.max(0, w - dt / (0.8 + 0.4 * asmDelay[j]));
        }
        asmW[j] = w;
        sum += w;
        if (w > 0) any = true;
      }
      const built = sum / ASSEMBLE;
      if (assembling && landedAt === Infinity && built > 0.985) landedAt = readyAge;

      // Wireframe: brightens as the points land, then a bloom-like pulse and echo.
      const gate = assembling ? 0.35 + 0.65 * built : 1;
      planeMat.opacity = Math.min(1, S.plane * gate + 0.45 * bloom);
      planeMat.color.copy(cMuted).lerp(cSky, S.accent).lerp(cVio, S.violet * 0.35).lerp(cWhite, 0.35 * bloom);
      if (bloom > 0.003) {
        echo.visible = true;
        echo.scale.setScalar(1 + 0.35 * (1 - bloom));
        echoMat.opacity = 0.5 * bloom * bloom;
      } else {
        echo.visible = false;
      }
      if (any) {
        asmMatrix.multiplyMatrices(spiralInv, plane.matrixWorld);
        const me = asmMatrix.elements;
        for (let j = 0; j < ASSEMBLE; j++) {
          if (asmW[j] <= 0) continue;
          const lx = asmLocal[j * 3], ly = asmLocal[j * 3 + 1], lz = asmLocal[j * 3 + 2];
          asmT[j * 3] = me[0] * lx + me[4] * ly + me[8] * lz + me[12];
          asmT[j * 3 + 1] = me[1] * lx + me[5] * ly + me[9] * lz + me[13];
          asmT[j * 3 + 2] = me[2] * lx + me[6] * ly + me[10] * lz + me[14];
        }
      }

      for (const L of layers) updateLayer(L, dt, speed, tighten, spinRate, focus);
      sparks.trail.mat.opacity = 0.8;

      // Motes: slow drift, bigger and dimmer away from focus.
      const ma = spin * 0.35;
      const cma = Math.cos(ma), sma = Math.sin(ma);
      for (let i = 0; i < MOTES; i++) {
        const bx = moteBase[i * 4], bz = moteBase[i * 4 + 2];
        const x = bx * cma - bz * sma;
        const z = bx * sma + bz * cma;
        const y = moteBase[i * 4 + 1] + 0.35 * Math.sin(time * 0.2 + moteBase[i * 4 + 3]);
        motePos[i * 3] = x;
        motePos[i * 3 + 1] = y;
        motePos[i * 3 + 2] = z;
        const calm = 1 - 0.8 * smooth(0.5, 5, z) * Math.exp(-(x * x) / 30);
        const k = (0.05 + 0.03 * Math.sin(time * 0.5 + moteBase[i * 4 + 3])) * calm * (0.8 + 0.4 * S.bright);
        const vm = S.violet * 0.8;
        moteCol[i * 3] = (cSky.r + (vr - cSky.r) * vm) * k;
        moteCol[i * 3 + 1] = (cSky.g + (vg - cSky.g) * vm) * k;
        moteCol[i * 3 + 2] = (cSky.b + (vb - cSky.b) * vm) * k;
      }
      moteGeo.attributes.position.needsUpdate = true;
      moteGeo.attributes.color.needsUpdate = true;

      // Core.
      const beat = S.pulse * Math.pow(0.5 + 0.5 * Math.sin(time * 5.0), 2);
      const flare = 1 + 1.5 * env + 0.7 * bloom;
      core.scale.setScalar((0.7 + 0.35 * beat) * flare);
      coreMat.opacity = Math.min(1, 0.5 + 0.3 * S.bright + 0.2 * env);
      coreMat.color.copy(cWhite).lerp(cVio, S.violet * 0.3);
      halo.scale.setScalar((4.6 + 1.6 * beat + 0.8 * S.tighten) * (1 + 0.6 * env));
      haloMat.opacity = Math.min(1, 0.1 + 0.08 * S.bright + 0.12 * beat + 0.25 * env);
      haloMat.color.copy(cSky).lerp(cVio, S.violet * 0.85).lerp(cGreen, 0.25 * env);

      // Shock ring.
      if (readyAge < 3.2) {
        const rr = 0.35 + 10 * (1 - Math.exp(-readyAge / 0.7));
        ring.visible = true;
        ring.scale.set(rr, 1, rr);
        ring.position.y = FUNNEL * Math.pow(Math.min(1, rr / R_MAX), 1.5);
        ringMat.opacity = 0.6 * Math.exp(-readyAge / 0.6) * (1 - Math.exp(-readyAge / 0.04));
      } else {
        ring.visible = false;
      }

      grid.material.opacity = 0.75 + 0.25 * S.bright;
    }

    // ---- sizing, visibility, loop ---------------------------------------------------
    let width = 0;
    let height = 0;
    let inView = true;
    let lost = false;
    let disposed = false;
    let raf = 0;
    let last = 0;
    let maxRatio = 1.5;
    let quality = 1;
    let emaMs = 16.7;
    let sampled = 0;

    function resize() {
      width = container.clientWidth;
      height = container.clientHeight;
      if (!width || !height) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxRatio));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.fov = width / height < 0.8 ? 54 : 42; // portrait: widen so the arms still read
      camera.updateProjectionMatrix();
    }

    // Frame-cost cap: if frames run slow, draw fewer points and drop resolution.
    function degrade() {
      quality = Math.max(0.45, quality * 0.75);
      for (const L of layers) {
        L.drawN = Math.floor(L.n * quality);
        L.geo.setDrawRange(0, L.drawN);
        if (L.trail) L.trail.geo.setDrawRange(0, L.drawN * 4);
      }
      maxRatio = 1;
      resize();
    }

    // Visible = tab shown, laid out with a size, and on screen. (IntersectionObserver
    // stands in for offsetParent, which is always null for a position:fixed layer.)
    const visible = () => !disposed && !lost && !document.hidden && inView && width > 0 && height > 0;

    function frame(now) {
      raf = 0;
      if (!visible()) return; // paused; observers / visibilitychange restart it
      raf = requestAnimationFrame(frame);
      const ms = Math.max(0, now - last);
      last = now;
      if (ms < 250) {
        emaMs += (ms - emaMs) * 0.05;
        if (++sampled > 150 && emaMs > 26 && quality > 0.45) {
          degrade();
          sampled = 0;
          emaMs = 16.7;
        }
      }
      step(Math.min(0.05, ms / 1000));
      renderer.render(scene, camera);
    }

    let stillPrimed = false;
    function renderStill() {
      if (!visible()) return;
      Object.assign(S, T);
      asmW.fill(mode === "ready" ? 1 : 0);
      if (!stillPrimed) {
        stillPrimed = true;
        time = 9;
        spin = 0.4;
      }
      step(0);
      renderer.render(scene, camera);
    }

    function start() {
      if (reduced) {
        renderStill();
        return;
      }
      if (!raf && visible()) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    }

    const onVisibility = () => start();
    const onPointer = (e) => {
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      mouse.tx = Math.max(-1, Math.min(1, (e.clientX / w) * 2 - 1));
      mouse.ty = Math.max(-1, Math.min(1, (e.clientY / h) * 2 - 1));
    };
    const onLost = (e) => {
      e.preventDefault();
      lost = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const onRestored = () => {
      lost = false;
      start();
    };

    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    container.appendChild(canvas);
    resize();

    const ro = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => { resize(); start(); })
      : null;
    if (ro) ro.observe(container);
    else window.addEventListener("resize", onVisibility);

    const io = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
        inView = entries[entries.length - 1].isIntersecting;
        start();
      })
      : null;
    if (io) io.observe(container);

    document.addEventListener("visibilitychange", onVisibility);
    canvas.addEventListener("webglcontextlost", onLost, false);
    canvas.addEventListener("webglcontextrestored", onRestored, false);
    if (!reduced) window.addEventListener("pointermove", onPointer, { passive: true });

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", onVisibility);
      if (io) io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointer);
      canvas.removeEventListener("webglcontextlost", onLost, false);
      canvas.removeEventListener("webglcontextrestored", onRestored, false);
      scene.traverse((o) => {
        if (o.geometry && !o.isSprite) o.geometry.dispose(); // sprite geometry is shared by three.js
        if (o.material) o.material.dispose();
      });
      for (const t of textures) t.dispose();
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* already gone */ }
      canvas.remove();
    }

    start();

    return {
      setMode(next) {
        if (disposed || !MODES[next]) return;
        if (next === "ready" && mode !== "ready" && !reduced) {
          readyAge = 0;
          landedAt = Infinity;
        }
        mode = next;
        Object.assign(T, MODES[next]);
        start();
      },
      dispose,
    };
  } catch (err) {
    for (const t of textures) t.dispose();
    try { renderer.dispose(); } catch { /* ignore */ }
    canvas.remove();
    throw err;
  }
}
