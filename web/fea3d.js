/**
 * Screen 3: multi-component fine-mesh FEA viewer + AI structural optimiser (Owner: Tharm).
 *
 * Every number comes from spar_stress_mesh.json -> components_fea, solved in spiral/tools/fea.py.
 * This file only sweeps each member's cross-section along its centreline (one structured,
 * vertex-welded quad grid per member, Catmull-Rom between solver stations), deforms it by the
 * nodal displacement d + r x offset, and evaluates sigma_vM at each vertex from the per-station
 * stress coefficients k = [sigma_N, M_u/I, M_v/I, tau_torsion, tau_shear_max, v_max]:
 *   sigma = k0 + k1*v - k2*u ;  tau = k3 + k4*max(0, 1 - (v/k5)^2) ;  vM = sqrt(sigma^2 + 3 tau^2)
 * (the same formula _vm_at() uses for the solver peaks; an optional k6 adds the oleo hoop stress).
 */

// Three.js r164 is vendored in web/vendor/ so the 3D works with no network (venue wifi);
// the CDN is only a fallback if the local copy is missing.
const THREE_LOCAL = "./vendor/three.module.js";
const THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js";
let threePromise = null;
function loadThree() {
  if (!threePromise) {
    threePromise = import(THREE_LOCAL)
      .catch(() => import(THREE_CDN))
      .catch(() => null);
  }
  return threePromise;
}

// `run` = the component analysis (POST /api/components/{run}) that solves the part.
export const FEA_COMPONENTS = [
  { id: "main_wing_spar", name: "Tapered I-beam main spar", short: "Main spar", run: "main_wing_spar" },
  { id: "wing_skin_box", name: "NACA 2415 wing torsion box", short: "Wing box", run: "main_wing_spar" },
  { id: "horizontal_tail", name: "Horizontal tail spar", short: "Tailplane", run: "horizontal_tail" },
  { id: "fuselage_frames", name: "Carry-through ring frames and bridge", short: "Fuselage frames", run: "main_wing_spar" },
  { id: "main_landing_gear", name: "Main gear oleo strut", short: "Main gear", run: "main_landing_gear" },
  { id: "engine_mount", name: "Engine mount spaceframe truss", short: "Engine mount", run: "main_wing_spar" },
];

const DENSITY = {
  medium: { label: "Medium", span: 40, f: 1 },
  fine: { label: "Fine", span: 90, f: 2 },
  ultra: { label: "Ultra-Fine", span: 180, f: 3 },
};

const STOPS = [
  [0.0, [29, 78, 216]],
  [0.28, [6, 182, 212]],
  [0.55, [16, 185, 129]],
  [0.8, [245, 158, 11]],
  [1.0, [239, 68, 68]],
  [1.25, [244, 63, 94]],
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function stressRgb(stressPa, allowablePa) {
  const r = Math.max(0, Math.min(1.25, Number(stressPa || 0) / Math.max(Number(allowablePa || 345e6), 1)));
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [ta, ca] = STOPS[i];
    const [tb, cb] = STOPS[i + 1];
    if (r <= tb) {
      const u = (r - ta) / Math.max(tb - ta, 1e-6);
      return [lerp(ca[0], cb[0], u) / 255, lerp(ca[1], cb[1], u) / 255, lerp(ca[2], cb[2], u) / 255];
    }
  }
  return STOPS[STOPS.length - 1][1].map((c) => c / 255);
}

/** Map von Mises stress (Pa) vs allowable stress (Pa) to the turbo-style hex colour of the colour bar. */
export function vonMisesColorHex(stressPa, allowablePa = 345e6) {
  const to2 = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${stressRgb(stressPa, allowablePa).map(to2).join("")}`;
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const mpa = (pa) => `${(Number(pa) / 1e6).toFixed(1)} MPa`;
const mm = (m) => `${(Number(m) * 1000).toFixed(1)} mm`;
const sgn = (x, d = 2) => `${x >= 0 ? "+" : ""}${Number(x).toFixed(d)}`;

/* ---------------- cross-section outlines (mirror spiral/tools/fea.py) ---------------- */

function arc(cx, cz, r, a0, a1, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + ((a1 - a0) * i) / (n - 1);
    out.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  return out;
}

/** Key polygon of the I-section with four web-flange root fillets (u across the flange, v up). */
function iKey(sec, f) {
  const hh = sec.h / 2;
  const hb = sec.b / 2;
  const hw = sec.tw / 2;
  const zi = Math.max(hh - sec.tf, 1e-4);
  const r = Math.max(1e-5, Math.min(sec.r, 0.45 * (hb - hw), 0.45 * zi));
  const n = 2 + 2 * f;
  const pi = Math.PI;
  return [
    [hb, hh], [-hb, hh], [-hb, zi],
    ...arc(-hw - r, zi - r, r, pi / 2, 0, n), [-hw, 0],
    ...arc(-hw - r, -zi + r, r, 0, -pi / 2, n),
    [-hb, -zi], [-hb, -hh], [hb, -hh], [hb, -zi],
    ...arc(hw + r, -zi + r, r, -pi / 2, -pi, n), [hw, 0],
    ...arc(hw + r, zi - r, r, pi, pi / 2, n), [hb, zi],
  ];
}

/** NACA 4-digit closed contour TE -> upper -> LE -> lower (x/c, z/c), as _naca4_contour(). */
function naca4(m, p, t, n) {
  const up = [];
  const lo = [];
  for (let i = 0; i <= n; i++) {
    const xc = 0.5 * (1 - Math.cos((Math.PI * i) / n));
    const yt = 5 * t * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc ** 2 + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
    let yc = 0;
    let th = 0;
    if (m > 1e-6) {
      yc = xc < p ? (m / p ** 2) * (2 * p * xc - xc ** 2) : (m / (1 - p) ** 2) * (1 - 2 * p + 2 * p * xc - xc ** 2);
      th = Math.atan(xc < p ? ((2 * m) / p ** 2) * (p - xc) : ((2 * m) / (1 - p) ** 2) * (p - xc));
    }
    up.push([xc - yt * Math.sin(th), yc + yt * Math.cos(th)]);
    lo.push([xc + yt * Math.sin(th), yc - yt * Math.cos(th)]);
  }
  return [...up.reverse(), ...lo.slice(1, -1)];
}

function surfaceZ(sec, xc) {
  const yt = 5 * sec.tc * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc ** 2 + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
  const { m, p } = sec;
  const yc = m > 1e-6 ? (xc < p ? (m / p ** 2) * (2 * p * xc - xc ** 2) : (m / (1 - p) ** 2) * (1 - 2 * p + 2 * p * xc - xc ** 2)) : 0;
  return [yc + yt, yc - yt];
}

function sectionKey(sec, f) {
  if (sec.type === "i") return iKey(sec, f);
  if (sec.type === "af") {
    return naca4(sec.m, sec.p, sec.tc, 12 + 10 * f).map(([x, z]) => [(x - sec.xr) * sec.c, z * sec.c - sec.zb]);
  }
  const n = 12 + 10 * f;
  const out = [];
  for (let j = 0; j < n; j++) out.push([sec.ro * Math.cos((2 * Math.PI * j) / n), sec.ro * Math.sin((2 * Math.PI * j) / n)]);
  return out;
}

/** Edge subdivision counts, fixed per member (from its first station) so every ring has the same node count. */
function keyCounts(sec, f) {
  const key = sectionKey(sec, f);
  if (sec.type !== "i") return key.map(() => 1);
  const step = sec.h / (6 * f);
  return key.map((a, i) => {
    const b = key[(i + 1) % key.length];
    return Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
  });
}

function outline(sec, f, counts) {
  const key = sectionKey(sec, f);
  const out = [];
  key.forEach((a, i) => {
    const b = key[(i + 1) % key.length];
    const n = counts[i] || 1;
    for (let j = 0; j < n; j++) out.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
  });
  return out;
}

function vmAt(u, v, k) {
  const sig = k[0] + k[1] * v - k[2] * u;
  const hoop = k[6] || 0; // oleo strut: internal-pressure hoop stress (biaxial von Mises)
  const tau = k[3] + k[4] * Math.max(0, 1 - (v / Math.max(k[5], 1e-9)) ** 2);
  return Math.sqrt(sig * sig - sig * hoop + hoop * hoop + 3 * tau * tau);
}

/* ---------------- station interpolation ---------------- */

function lerpStation(a, b, t) {
  const L = (x, y) => x.map((v, i) => lerp(v, y[i], t));
  const sec = { ...a.sec };
  for (const key of Object.keys(sec)) if (typeof sec[key] === "number") sec[key] = lerp(a.sec[key], b.sec[key], t);
  return {
    s: lerp(a.s, b.s, t), p: L(a.p, b.p), v: L(a.v, b.v), d: L(a.d, b.d), r: L(a.r, b.r), k: L(a.k, b.k),
    vm: lerp(a.vm, b.vm, t), web_vm: lerp(a.web_vm || 0, b.web_vm || 0, t), sec,
  };
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return p1.map((_, i) => 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3));
}

function sampleStation(S, tau, closed) {
  const N = S.length;
  const at = (j) => S[closed ? ((j % N) + N) % N : Math.max(0, Math.min(N - 1, j))];
  const i = Math.min(Math.floor(tau), closed ? N - 1 : N - 2);
  const f = tau - i;
  const st = lerpStation(at(i), at(i + 1), f);
  if (N > 2) {
    st.p = catmull(at(i - 1).p, at(i).p, at(i + 1).p, at(i + 2).p, f);
    st.d = catmull(at(i - 1).d, at(i).d, at(i + 1).d, at(i + 2).d, f);
  }
  return st;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => scl(a, 1 / Math.max(Math.hypot(a[0], a[1], a[2]), 1e-12));

function memberLength(m) {
  const S = m.stations;
  let L = 0;
  for (let i = 1; i < S.length; i++) L += Math.hypot(...sub(S[i].p, S[i - 1].p));
  if (m.closed) L += Math.hypot(...sub(S[0].p, S[S.length - 1].p));
  return L;
}

/* ---------------- orbit controls (same feel as aircraft3d.js) ---------------- */

function attachOrbitControls(el, cam, onChange, onHover) {
  let dragging = false;
  let mode = "orbit";
  let lastX = 0;
  let lastY = 0;
  el.addEventListener("pointerdown", (e) => {
    dragging = true;
    mode = e.shiftKey || e.button === 2 ? "pan" : "orbit";
    lastX = e.clientX;
    lastY = e.clientY;
    el.setPointerCapture?.(e.pointerId);
    el.style.cursor = "grabbing";
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) {
      onHover?.(e);
      return;
    }
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (mode === "orbit") {
      cam.yaw -= dx * 0.0085;
      cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + dy * 0.0075));
    } else {
      cam.panX += dx;
      cam.panY += dy;
    }
    onChange();
  });
  const stop = () => {
    dragging = false;
    el.style.cursor = "crosshair";
  };
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
  el.addEventListener("pointerleave", () => onHover?.(null));
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      cam.zoom = Math.max(0.35, Math.min(8, cam.zoom * (e.deltaY < 0 ? 1.1 : 0.91)));
      onChange();
    },
    { passive: false }
  );
}

/* ---------------- injected styles for the optimiser panel and HUD ---------------- */

const STYLE = `
.fea-opt-panel .ws-body { display: flex; flex-direction: column; gap: 0.55rem; }
.fea-comp-list { display: grid; grid-template-columns: 1fr 1fr; gap: 0.35rem; }
.fea-comp { text-align: left; background: rgba(8,13,25,0.7); border: 1px solid rgba(148,163,184,0.16); border-radius: 8px;
  color: var(--text,#e2e8f0); padding: 0.4rem 0.5rem; cursor: pointer; font: inherit; display: flex; flex-direction: column; gap: 2px; }
.fea-comp:hover { border-color: rgba(56,189,248,0.45); }
.fea-comp.on { border-color: var(--cyan,#38bdf8); background: rgba(56,189,248,0.14); }
.fea-comp-name { font-size: 0.76rem; font-weight: 600; line-height: 1.2; }
.fea-comp-meta { font: 0.66rem/1.2 ui-monospace, monospace; color: var(--muted,#94a3b8); }
.fea-comp-meta .ok { color: #34d399; } .fea-comp-meta .bad { color: #fb7185; }
.fea-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.fea-lbl { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted,#94a3b8); }
.fea-seg { display: inline-flex; border: 1px solid rgba(148,163,184,0.2); border-radius: 999px; overflow: hidden; }
.fea-seg button { background: transparent; border: 0; color: var(--muted,#94a3b8); font: inherit; font-size: 0.72rem; padding: 0.22rem 0.6rem; cursor: pointer; }
.fea-seg button.on { background: rgba(56,189,248,0.2); color: var(--text,#e2e8f0); }
.fea-opt-panel select { background: rgba(8,13,25,0.8); color: var(--text,#e2e8f0); border: 1px solid rgba(148,163,184,0.2);
  border-radius: 6px; padding: 0.25rem 0.4rem; font: inherit; font-size: 0.76rem; max-width: 62%; }
.fea-mono { font: 0.68rem/1.45 ui-monospace, monospace; color: var(--muted,#94a3b8); }
.fea-opt-btn { width: 100%; background: linear-gradient(90deg,#38bdf8,#818cf8); color: #04101e; border: 0; border-radius: 8px;
  padding: 0.5rem; font-weight: 700; cursor: pointer; font-size: 0.82rem; }
.fea-opt-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.fea-trace { margin: 0; padding-left: 1.1rem; font-size: 0.72rem; color: var(--text,#e2e8f0); }
.fea-trace li { margin: 0.12rem 0; } .fea-trace li.rej { color: #fb7185; } .fea-trace li.acc { color: #34d399; }
.fea-ba { width: 100%; border-collapse: collapse; font: 0.72rem ui-monospace, monospace; }
.fea-ba th { text-align: right; color: var(--muted,#94a3b8); font-weight: 500; padding: 0.15rem 0.2rem; }
.fea-ba th:first-child, .fea-ba td:first-child { text-align: left; }
.fea-ba td { text-align: right; padding: 0.15rem 0.2rem; border-top: 1px solid rgba(148,163,184,0.1); color: var(--text,#e2e8f0); }
.fea-ba .good { color: #34d399; } .fea-ba .worse { color: #fb7185; }
.fea-src { display: inline-block; font-size: 0.66rem; padding: 0.1rem 0.45rem; border-radius: 999px; border: 1px solid; }
.fea-src.ai { color: #c4b5fd; border-color: rgba(167,139,250,0.5); background: rgba(139,92,246,0.12); }
.fea-src.det { color: #fbbf24; border-color: rgba(245,158,11,0.45); background: rgba(245,158,11,0.1); }
.fea-why { font-size: 0.74rem; line-height: 1.45; color: var(--text,#e2e8f0); background: rgba(8,13,25,0.6);
  border-left: 2px solid #818cf8; padding: 0.4rem 0.55rem; border-radius: 4px; }
.fea-scrub { display: flex; align-items: center; gap: 0.4rem; }
.fea-scrub input { flex: 1; accent-color: #818cf8; }
.fea-assume summary { cursor: pointer; font-size: 0.7rem; color: var(--muted,#94a3b8); text-transform: uppercase; letter-spacing: 0.06em; }
.fea-assume ul { margin: 0.35rem 0 0; padding-left: 1rem; font-size: 0.7rem; color: var(--muted,#94a3b8); }
.fea-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none;
  color: var(--muted,#94a3b8); font: 0.85rem/1.5 ui-monospace, monospace; text-align: center; z-index: 2; }
.fea-hud b { color: #e2e8f0; font-weight: 600; } .fea-hud .hot { color: #fb7185; } .fea-hud .ok { color: #34d399; }
.fea-kpi-sub { font: 0.66rem ui-monospace, monospace; color: var(--muted,#94a3b8); margin-top: 2px; }
.fea-kpi-sub.good { color: #34d399; } .fea-kpi-sub.worse { color: #fb7185; }
.fea-gov { grid-column: 1 / -1; font-size: 0.72rem; color: var(--muted,#94a3b8); line-height: 1.4; }
.fea-solve { position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%); z-index: 4; width: min(560px, calc(100% - 32px));
  display: grid; grid-template-columns: 170px 1fr; gap: 1rem; align-items: center; padding: 0.95rem 1.1rem; border-radius: 14px;
  background: rgba(10, 15, 26, 0.88); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--ov-edge, rgba(148,197,255,0.16)); box-shadow: 0 18px 40px rgba(0,0,0,0.5);
  color: #cbd5e1; font-size: 0.78rem; transition: opacity 0.5s ease, transform 0.5s ease; }
.fea-solve.out { opacity: 0; transform: translate(-50%, -46%); pointer-events: none; }
.fea-solve svg { width: 100%; height: auto; display: block; }
.fea-solve .pl-body { fill: none; stroke: rgba(148,163,184,0.45); stroke-width: 1; }
.fea-solve .pl-part { fill: rgba(30,41,59,0.8); stroke: rgba(148,163,184,0.5); stroke-width: 1; transition: fill 0.35s, stroke 0.35s; }
.fea-solve .pl-part.ring { fill: none; stroke-dasharray: 3 2; }
.fea-solve .pl-part[data-st="active"] { fill: rgba(252,211,77,0.3); stroke: #fcd34d; animation: fea-pulse 0.9s ease-in-out infinite; }
.fea-solve .pl-part[data-st="done"] { fill: rgba(52,211,153,0.28); stroke: #34d399; }
.fea-solve .pl-part[data-st="error"] { fill: rgba(251,113,133,0.3); stroke: #fb7185; }
.fea-solve .pl-part.ring[data-st] { fill: none; }
.fea-solve .pl-cap { fill: #94a3b8; font: 10px ui-monospace, monospace; }
@keyframes fea-pulse { 50% { stroke-opacity: 0.35; } }
.fea-solve-head { display: flex; align-items: center; gap: 0.45rem; font: 0.66rem ui-monospace, monospace; letter-spacing: 0.05em;
  text-transform: uppercase; color: #fcd34d; margin-bottom: 0.5rem; }
.fea-solve[data-st="ok"] .fea-solve-head { color: #34d399; }
.fea-solve-clock { margin-left: auto; color: var(--ov-ice, #e0f2fe); font-variant-numeric: tabular-nums; }
.fea-solve-x { background: none; border: 0; color: #64748b; cursor: pointer; font-size: 0.9rem; padding: 0 0 0 0.3rem; }
.fea-spin { width: 11px; height: 11px; border-radius: 50%; border: 2px solid rgba(252,211,77,0.25); border-top-color: #fcd34d;
  animation: fea-spin 0.8s linear infinite; flex: none; }
.fea-solve:not([data-st="busy"]) .fea-spin { display: none; }
@keyframes fea-spin { to { transform: rotate(360deg); } }
.fea-solve-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.34rem; }
.fea-solve-steps li { display: grid; grid-template-columns: 14px 1fr auto; gap: 0.45rem; align-items: center; color: #64748b; transition: color 0.3s; }
.fea-solve-steps li i { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid #334155; box-sizing: border-box; display: grid;
  place-items: center; font-style: normal; font-size: 11px; line-height: 1; justify-self: center; }
.fea-solve-steps li small { font: 0.62rem ui-monospace, monospace; color: #94a3b8; text-align: right; }
.fea-solve-steps li[data-st="active"] { color: #fde68a; }
.fea-solve-steps li[data-st="active"] i { border: 2px solid rgba(252,211,77,0.25); border-top-color: #fcd34d; animation: fea-spin 0.8s linear infinite; }
.fea-solve-steps li:is([data-st="ok"], [data-st="bad"], [data-st="skip"]) i { border: 0; }
.fea-solve-steps li[data-st="ok"] { color: #d1fae5; } .fea-solve-steps li[data-st="ok"] i::after { content: "\\2713"; color: #34d399; }
.fea-solve-steps li[data-st="bad"] { color: #fecdd3; } .fea-solve-steps li[data-st="bad"] i::after { content: "\\2717"; color: #fb7185; }
.fea-solve-steps li[data-st="skip"] { color: #94a3b8; } .fea-solve-steps li[data-st="skip"] i::after { content: "\\2013"; color: #64748b; }
.fea-solve-log { margin-top: 0.55rem; border-left: 2px solid rgba(125,211,252,0.5); padding: 0.25rem 0 0.25rem 0.55rem;
  font: 0.68rem/1.45 ui-monospace, monospace; color: #94a3b8; min-height: 1.4em; }
@media (prefers-reduced-motion: reduce) { .fea-spin, .fea-solve-steps li i, .fea-solve .pl-part { animation: none !important; } }
`;

/* Solver box: which outline part lights up for each component, and how each is solved */
const PLANE_PARTS = {
  main_wing_spar: ["pl-spar"],
  wing_skin_box: ["pl-wing"],
  horizontal_tail: ["pl-tail"],
  fuselage_frames: ["pl-frames"],
  main_landing_gear: ["pl-gear-l", "pl-gear-r"],
  engine_mount: ["pl-engine"],
};
const SOLVE_METHOD = {
  main_wing_spar: "Timoshenko beam + root-warping stress recovery",
  wing_skin_box: "thin-wall box: bending + Bredt-Batho torsion",
  horizontal_tail: "Timoshenko beam on the Raymer-sized tail spar",
  fuselage_frames: "closed-ring force method + carry-through beam",
  main_landing_gear: "pressure vessel + Euler column on the sized oleo",
  engine_mount: "3D truss direct stiffness + Euler buckling",
};
const PLANE_SVG = `<svg viewBox="0 0 200 172" role="img" aria-label="Airframe parts lit as each FEA model is solved">
  <path class="pl-body" d="M100 6 C107 6 110 24 110 50 L110 130 C110 145 105 158 100 162 C95 158 90 145 90 130 L90 50 C90 24 93 6 100 6 Z"/>
  <rect id="pl-engine" class="pl-part" x="92" y="9" width="16" height="18" rx="3"/>
  <rect id="pl-wing" class="pl-part" x="10" y="56" width="180" height="24" rx="6"/>
  <rect id="pl-spar" class="pl-part" x="12" y="62" width="176" height="5" rx="2"/>
  <rect id="pl-frames" class="pl-part ring" x="89" y="49" width="22" height="38" rx="4"/>
  <circle id="pl-gear-l" class="pl-part" cx="80" cy="96" r="5"/>
  <circle id="pl-gear-r" class="pl-part" cx="120" cy="96" r="5"/>
  <rect id="pl-tail" class="pl-part" x="66" y="137" width="68" height="13" rx="4"/>
  <text class="pl-cap" x="100" y="171" text-anchor="middle">waiting for solver</text>
</svg>`;

function injectStyle() {
  if (document.getElementById("fea3d-style")) return;
  const el = document.createElement("style");
  el.id = "fea3d-style";
  el.textContent = STYLE;
  document.head.appendChild(el);
}

/* ---------------- the scene ---------------- */

export class SparFeaScene {
  constructor(containerEl) {
    this.container = containerEl;
    this.spar = null;
    this.fea = null;
    this.stressMesh = null;
    this.deflectionScale = 3.0;
    this.showWireframe = true;
    this.componentId = "main_wing_spar";
    this.density = "fine";
    this.goal = "min_mass";
    this.morph = 0; // 0 = baseline, 1 = AI-optimised
    this.showResult = false;
    this.cam = { yaw: -0.62, pitch: 0.38, zoom: 1.0, panX: 0, panY: 0, target: null };
    this.gl = null;
    this.stats = { elements: 0, nodes: 0 };
    this.onSelect = null; // app.js hook: called with the component id when FEA has not run yet

    injectStyle();
    if (this.container) {
      this.container.innerHTML = "";
      this.container.style.position = this.container.style.position || "relative";
      this.empty = document.createElement("div");
      this.empty.className = "fea-empty";
      this.container.appendChild(this.empty);
    }
    this._buildPanel();
    this._ro = new ResizeObserver(() => this.resize());
    if (this.container) this._ro.observe(this.container);
    loadThree().then((THREE) => {
      if (THREE && !this._disposed) this._initWebGL(THREE);
      else this._setEmpty("WebGL / Three.js unavailable in this browser.");
    });
    this._refreshAll();
  }

  /* ----- public API used by app.js ----- */

  /** True when the selected part has fine-mesh FEA results (then this scene renders Screen 3's panels). */
  get ownsPanels() {
    return Boolean(this._comp());
  }

  setViewPreset(preset) {
    const c = this._comp();
    const variant = c?.baseline;
    const map = {
      iso: { yaw: -0.62, pitch: 0.38, zoom: 1.0 },
      front: { yaw: -1.57, pitch: 0.08, zoom: 1.0 },
      top: { yaw: 0.0, pitch: 1.42, zoom: 1.0 },
      root: { yaw: -1.05, pitch: 0.3, zoom: 2.4 },
      tip: { yaw: -0.3, pitch: 0.3, zoom: 2.4 },
    };
    Object.assign(this.cam, map[preset] || map.iso, { panX: 0, panY: 0, target: null });
    if (variant && preset === "root" && variant.bc?.[0]) this.cam.target = variant.bc[0].p;
    if (variant && preset === "tip") {
      const S = variant.members[0].stations;
      this.cam.target = S[variant.members[0].closed ? Math.floor(S.length / 4) : S.length - 1].p;
    }
    this.render();
  }

  setDeflectionScale(scale) {
    this.deflectionScale = Math.max(0, Math.min(30, Number(scale)));
    this._rebuild();
  }

  setShowWireframe(visible) {
    this.showWireframe = Boolean(visible);
    if (this.gl?.ghost) this.gl.ghost.visible = this.showWireframe;
    this.render();
  }

  updateSparMesh(opts = {}) {
    this.spar = opts.spar ?? this.spar;
    this.fea = opts.fea ?? this.fea;
    if (opts.stressMesh !== undefined) this.stressMesh = opts.stressMesh;
    if (opts.deflectionScale !== undefined) this.deflectionScale = Number(opts.deflectionScale);
    if (opts.showWireframe !== undefined) this.showWireframe = Boolean(opts.showWireframe);
    this._refreshAll(true);
    if (this._solve?.ended && !this._solve.finished && this.stressMesh?.components_fea?.[this._solve.parts[0]]) this._solveFinish();
  }

  /* ----- solver box: driven by the CAD + FEA stream's component_step events ----- */

  solveStart(run = "main_wing_spar") {
    if (!this.container) return;
    clearTimeout(this._solveFade);
    if (!this.solveBox) {
      const box = document.createElement("div");
      box.className = "fea-solve";
      box.setAttribute("aria-live", "polite");
      box.innerHTML = `${PLANE_SVG}<div>
        <div class="fea-solve-head"><span class="fea-spin"></span><span class="fea-solve-state"></span><span class="fea-solve-clock">0.0 s</span><button type="button" class="fea-solve-x" aria-label="Hide solver progress">×</button></div>
        <ol class="fea-solve-steps"></ol>
        <div class="fea-solve-log"></div></div>`;
      box.querySelector(".fea-solve-x").addEventListener("click", () => box.classList.add("out"));
      this.container.appendChild(box);
      this.solveBox = box;
    }
    const box = this.solveBox;
    const parts = FEA_COMPONENTS.filter((c) => c.run === run).map((c) => c.id);
    const n = parts.length;
    const first = { main_wing_spar: "Loft spar CAD (STEP, STL)", horizontal_tail: "Raymer tail load case, spar sizing and CAD", main_landing_gear: "Raymer oleo strut sizing" }[run];
    const labels = [first, n > 1 ? `Solve ${n} FEA models` : `Solve the ${FEA_COMPONENTS.find((c) => c.id === parts[0]).short.toLowerCase()} FEA`, "Gemini agent proposes gauges", "Solver re-checks every proposal"];
    box.querySelector(".fea-solve-steps").innerHTML = labels.map((t) => `<li data-st="wait"><i></i><span>${esc(t)}</span><small></small></li>`).join("");
    box.querySelectorAll(".pl-part").forEach((p) => p.removeAttribute("data-st"));
    box.classList.remove("out");
    box.dataset.st = "busy";
    this._solve = { t0: performance.now(), run, parts, solved: new Set(), live: false };
    this._solveText(".fea-solve-state", "Solving the airframe…");
    this._solveText(".fea-solve-log", "Starting the analysis stream");
    this._solveText(".pl-cap", "waiting for solver");
    this._setEmpty("");
    clearInterval(this._solveTimer);
    this._solveTimer = setInterval(() => this._solveText(".fea-solve-clock", `${((performance.now() - this._solve.t0) / 1000).toFixed(1)} s`), 100);
  }

  solveEvent(ev) {
    const s = this._solve;
    if (!s || s.ended || !this.solveBox) return;
    const { component_id: cid, step, status } = ev || {};
    const comp = FEA_COMPONENTS.find((c) => c.id === cid);
    const n = s.parts.length;
    if (cid === s.run && ["loads", "sizing", "cad"].includes(step)) {
      const last = s.run === "main_landing_gear" ? "sizing" : "cad"; // the run's last step before the FEA
      this._solveStep(0, status === "done" && step === last ? "ok" : "active");
      if (status === "running") {
        const msg = { loads: "Raymer tail load case (Eqs. 14.12-14.13) and spar sizing", sizing: "Raymer oleo sizing: stroke, length, bore, landing load (Ch. 11)", cad: "Lofting the spar; exporting STEP AP214 and STL" };
        this._solveText(".fea-solve-log", msg[step]);
      }
    } else if (cid === s.run && step === "fea" && status === "running") {
      this._solveStep(0, "ok");
      this._solveStep(1, "active", `0/${n}`);
      this._solveParts(s.parts, "active"); // refined per part once "solve" events arrive
      this._solveText(".fea-solve-log", "Assembling stiffness matrices");
    } else if (step === "solve" && comp) {
      if (!s.live) this._solveParts(s.parts, null);
      s.live = true;
      if (status === "running") {
        this._solveParts([cid], "active");
        this._solveText(".fea-solve-log", `${comp.name}: ${SOLVE_METHOD[cid]}`);
        this._solveText(".pl-cap", `solving ${comp.short.toLowerCase()}`);
      } else {
        this._solveParts([cid], status === "error" ? "error" : "done");
        s.solved.add(cid);
        this._solveStep(1, "active", `${s.solved.size}/${n}`);
      }
    } else if (cid === "optimiser" && step === "agent") {
      this._solveStep(1, "ok", `${s.solved.size || n}/${n}`);
      this._solveText(".pl-cap", n > 1 ? `${n} parts solved` : "part solved");
      if (status === "running") {
        this._solveStep(2, "active");
        this._solveText(".fea-solve-state", "Agent is thinking…");
        this._solveText(".fea-solve-log", `Gemini agent is proposing gauges: ${n} part${n > 1 ? "s" : ""} × 3 goals`);
      } else if (status === "done") this._solveStep(2, "ok");
      else if (status === "skipped") this._solveStep(2, "skip", "offline");
      else this._solveStep(2, "bad", "call failed");
    } else if (cid === "optimiser" && step === "verify") {
      if (status === "running") {
        this._solveStep(3, "active");
        this._solveText(".fea-solve-state", "Verifying…");
        this._solveText(".fea-solve-log", "Re-solving every proposal against its goal constraint");
      } else this._solveStep(3, "ok");
    }
  }

  solveEnd(ok = true) {
    const s = this._solve;
    if (!s || !this.solveBox) return;
    clearInterval(this._solveTimer);
    s.secs = (performance.now() - s.t0) / 1000;
    s.ended = true;
    if (!s.live) {
      // Server without live progress (or a static-demo replay): only the run's own step events arrived.
      this._solveParts(s.parts, ok ? "done" : "error");
      this._solveStep(1, ok ? "ok" : "bad", "");
      [2, 3].forEach((i) => this._solveStep(i, "skip", "no live events"));
    }
    this.solveBox.querySelectorAll('.fea-solve-steps li[data-st="active"], .fea-solve-steps li[data-st="wait"]').forEach((li) => (li.dataset.st = ok ? "ok" : "skip"));
    this.solveBox.dataset.st = "ok";
    this._solveText(".fea-solve-state", ok ? "Solved and verified" : "Stopped: see the status bar");
    this._solveText(".fea-solve-clock", `${s.secs.toFixed(1)} s`);
    this._solveText(".fea-solve-log", ok ? "Loading the stress field" : "The analysis did not finish");
    this._solveFade = setTimeout(() => this.solveBox?.classList.add("out"), ok ? 6000 : 4000);
  }

  _solveFinish() {
    const s = this._solve;
    s.finished = true;
    const ai = this.stressMesh?.components_fea?.[s.parts[0]]?.ai || this.stressMesh?.ai_optimization;
    if (ai) {
      const li = this.solveBox.querySelectorAll(".fea-solve-steps li");
      if (ai.source === "ai") li[2].querySelector("span").textContent = `${ai.engine} proposed gauges`;
      this._solveStep(3, "ok", ai.proposals ? `${ai.accepted}/${ai.proposals} accepted` : "grid search");
      this._solveText(".fea-solve-log", ai.status);
    }
    this._renderPanel();
    clearTimeout(this._solveFade);
    this._solveFade = setTimeout(() => this.solveBox?.classList.add("out"), 3200);
  }

  _solveText(sel, text) {
    const n = this.solveBox?.querySelector(sel);
    if (n) n.textContent = text;
  }

  _solveStep(i, st, note) {
    const li = this.solveBox?.querySelectorAll(".fea-solve-steps li")[i];
    if (!li) return;
    li.dataset.st = st;
    if (note !== undefined) li.querySelector("small").textContent = note;
  }

  _solveParts(ids, st) {
    for (const id of ids) {
      for (const pid of PLANE_PARTS[id] || []) {
        const el = this.solveBox?.querySelector(`#${pid}`);
        if (!el) continue;
        if (st) el.dataset.st = st;
        else el.removeAttribute("data-st");
      }
    }
  }

  selectComponent(id) {
    if (!FEA_COMPONENTS.some((c) => c.id === id)) return;
    const changed = id !== this.componentId;
    this.componentId = id;
    if (changed) {
      this.morph = 0;
      this.showResult = false;
    }
    this._refreshAll(changed);
  }

  resize() {
    if (!this.container) return;
    const rect = this.container.getBoundingClientRect();
    this.w = Math.max(320, rect.width || 640);
    this.h = Math.max(260, rect.height || 400);
    this.gl?.renderer.setSize(this.w, this.h, false);
    this.render();
  }

  render() {
    if (!this.gl || this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._renderGL();
    });
  }

  dispose() {
    this._disposed = true;
    this._ro?.disconnect();
    if (this.gl) {
      this._clearModel();
      this.gl.renderer.dispose();
      this.gl.renderer.domElement.remove();
    }
    this.panel?.remove();
  }

  /* ----- data helpers ----- */

  _comp(id = this.componentId) {
    const c = this.stressMesh?.components_fea?.[id];
    return c && !c.error ? c : null;
  }

  _opt(c = this._comp()) {
    return c?.optimized?.[this.goal] || null;
  }

  /** Members with stations blended between baseline and optimised by this.morph. */
  _blendedVariant(c) {
    const base = c.baseline;
    const opt = this._opt(c)?.variant;
    const t = this.morph;
    if (!opt || t <= 0) return base;
    if (t >= 1) return opt;
    return {
      ...base,
      members: base.members.map((m, mi) => ({
        ...m,
        stations: m.stations.map((s, si) => lerpStation(s, opt.members[mi].stations[si], t)),
        ribs: m.ribs?.map((r, ri) => ({ s: r.s, vm: lerp(r.vm, opt.members[mi].ribs[ri].vm, t) })),
      })),
    };
  }

  /* ----- WebGL ----- */

  _initWebGL(THREE) {
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      this._setEmpty("WebGL unavailable in this browser.");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const el = renderer.domElement;
    Object.assign(el.style, { width: "100%", height: "100%", display: "block", cursor: "crosshair" });
    this.container?.appendChild(el);

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdbeafe, 0x0b1220, 1.25));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(-6, -8, 12);
    const rim = new THREE.DirectionalLight(0x7dd3fc, 0.8);
    rim.position.set(10, 8, 4);
    scene.add(key, rim);
    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 400);
    camera.up.set(0, 0, 1);

    const hud = document.createElement("div");
    hud.className = "aircraft-hud fea-hud";
    Object.assign(hud.style, { position: "absolute", left: "12px", bottom: "8px", font: "11px/1.5 monospace", color: "#94a3b8", pointerEvents: "none" });
    this.container?.appendChild(hud);

    const probe = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    probe.visible = false;
    scene.add(probe);

    this.gl = { THREE, renderer, scene, camera, hud, probe, model: null, ghost: null, meshes: [], raycaster: new THREE.Raycaster() };
    attachOrbitControls(el, this.cam, () => this.render(), (e) => this._hover(e));
    this.resize();
    this._rebuild(true);
  }

  _clearModel() {
    const gl = this.gl;
    for (const key of ["model", "ghost", "grid"]) {
      if (!gl[key]) continue;
      gl.scene.remove(gl[key]);
      gl[key].traverse((o) => {
        o.geometry?.dispose();
        if (o.material && !o.material._shared) o.material.dispose?.();
      });
      gl[key] = null;
    }
    gl.meshes = [];
  }

  _rebuild(reframe = false) {
    if (!this.gl) return;
    const c = this._comp();
    this._clearModel();
    if (!c) {
      this.gl.hud.innerHTML = "";
      this.render();
      return;
    }
    const { THREE, scene } = this.gl;
    const variant = this._blendedVariant(c);
    // Harry's overhaul HUD frame (overhaul.js missionHud) names the part in view; keep it on the selected one.
    const hudId = this.container?.closest(".viewport-card")?.querySelector(".ov-hud-id");
    const short = FEA_COMPONENTS.find((x) => x.id === c.id)?.short || c.name;
    if (hudId) hudId.innerHTML = `<b>${esc(short.toUpperCase())} // VON MISES FIELD</b><span>3D FEA · ${esc(SOLVE_METHOD[c.id].split(":")[0].toUpperCase())}</span>`;
    const allow = c.baseline.metrics.allowable_pa;
    const D = DENSITY[this.density];
    const model = new THREE.Group();
    const ghost = new THREE.Group();
    const surf = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.12, side: THREE.DoubleSide, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const wireMat = new THREE.LineBasicMaterial({ color: 0x0b1220, transparent: true, opacity: D.f === 3 ? 0.35 : 0.55 });
    const ghostMat = new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.28 });
    const Lref = Math.max(...variant.members.map(memberLength), 1e-6);
    let nodeBase = 0;
    let elemBase = 0;
    this.stats = { elements: 0, nodes: 0 };

    for (const member of variant.members) {
      const S = member.stations;
      const counts = keyCounts(S[0].sec, D.f);
      const nS = Math.max(member.closed ? 24 : 8, Math.round((D.span * memberLength(member)) / Lref));
      const span = member.closed ? nS : nS - 1;
      const samples = [];
      for (let j = 0; j < nS; j++) {
        const tau = member.closed ? (j * S.length) / nS : (j * (S.length - 1)) / (nS - 1);
        samples.push(sampleStation(S, tau, member.closed));
      }
      const rings = [];
      for (let j = 0; j < nS; j++) {
        const st = samples[j];
        const prev = samples[member.closed ? (j - 1 + nS) % nS : Math.max(0, j - 1)];
        const next = samples[member.closed ? (j + 1) % nS : Math.min(nS - 1, j + 1)];
        const t = norm(sub(next.p, prev.p));
        const U = norm(cross(t, st.v));
        const V = cross(U, t);
        rings.push({ st, U, V, pts: outline(st.sec, D.f, counts) });
      }
      const M = rings[0].pts.length;
      const pos = [];
      const base = [];
      const col = [];
      const vms = [];
      const dmag = [];
      const place = (ring, u, v, vm) => {
        const off = add(scl(ring.U, u), scl(ring.V, v));
        const b = add(ring.st.p, off);
        const def = add(ring.st.d, cross(ring.st.r, off));
        const p = add(b, scl(def, this.deflectionScale));
        pos.push(...p);
        base.push(...b);
        col.push(...stressRgb(vm, allow));
        vms.push(vm);
        dmag.push(Math.hypot(...def));
      };
      for (const ring of rings) for (const [u, v] of ring.pts) place(ring, u, v, vmAt(u, v, ring.st.k));

      const idx = [];
      const lines = [];
      for (let j = 0; j < span; j++) {
        const j2 = (j + 1) % nS;
        for (let i = 0; i < M; i++) {
          const i2 = (i + 1) % M;
          const a = j * M + i;
          const b = j * M + i2;
          const cc = j2 * M + i2;
          const d = j2 * M + i;
          idx.push(a, b, cc, a, cc, d);
          lines.push(a, b, a, d);
        }
      }
      if (!member.closed) for (let i = 0; i < M; i++) lines.push((nS - 1) * M + i, (nS - 1) * M + ((i + 1) % M));
      const gridFaces = idx.length / 3;

      // End caps (earcut handles the non-convex I-section)
      if (!member.closed) {
        for (const j of [0, nS - 1]) {
          const ring = rings[j];
          const tris = THREE.ShapeUtils.triangulateShape(ring.pts.map(([u, v]) => new THREE.Vector2(u, v)), []);
          const start = pos.length / 3;
          for (const [u, v] of ring.pts) place(ring, u, v, vmAt(u, v, ring.st.k));
          for (const [a, b, cc] of tris) idx.push(start + a, start + b, start + cc);
        }
      }
      // Internal spar webs of airfoil boxes
      if (S[0].sec.type === "af") {
        for (const xw of S[0].sec.webs || []) {
          const start = pos.length / 3;
          for (const ring of rings) {
            const sec = ring.st.sec;
            const [zu, zl] = surfaceZ(sec, xw);
            const u = (xw - sec.xr) * sec.c;
            place(ring, u, zl * sec.c - sec.zb, ring.st.web_vm);
            place(ring, u, zu * sec.c - sec.zb, ring.st.web_vm);
          }
          for (let j = 0; j < nS - 1; j++) {
            const a = start + 2 * j;
            idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
            lines.push(a, a + 2, a + 1, a + 3);
          }
        }
      }
      // Ribs as stressed planar caps
      for (const rib of member.ribs || []) {
        let i = 0;
        while (i < S.length - 2 && S[i + 1].s < rib.s) i++;
        const tau = Math.min(S.length - 1, i + (rib.s - S[i].s) / Math.max(S[i + 1].s - S[i].s, 1e-9));
        const st = sampleStation(S, tau, false);
        const k = Math.min(nS - 1, Math.round((tau / (S.length - 1)) * (nS - 1)));
        const ring = { st, U: rings[k].U, V: rings[k].V, pts: outline(st.sec, D.f, counts) };
        const tris = THREE.ShapeUtils.triangulateShape(ring.pts.map(([u, v]) => new THREE.Vector2(u, v)), []);
        const start = pos.length / 3;
        for (const [u, v] of ring.pts) place(ring, u, v, rib.vm);
        for (const [a, b, cc] of tris) idx.push(start + a, start + b, start + cc);
        for (let q = 0; q < ring.pts.length; q++) lines.push(start + q, start + ((q + 1) % ring.pts.length));
      }

      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geom.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      geom.setIndex(idx);
      geom.computeVertexNormals();
      const mesh = new THREE.Mesh(geom, surf);
      mesh.userData = { member: member.label, vms, base, dmag, gridFaces, M, nodeBase, elemBase, allow };
      model.add(mesh);
      this.gl.meshes.push(mesh);

      const wgeo = new THREE.BufferGeometry();
      wgeo.setAttribute("position", geom.getAttribute("position"));
      wgeo.setIndex(lines);
      model.add(new THREE.LineSegments(wgeo, wireMat));

      // Undeformed ghost: every few rings plus every few perimeter lines
      const gpos = [];
      const ringStep = Math.max(1, Math.round(nS / 14));
      const perStep = Math.max(1, Math.round(M / 12));
      for (let j = 0; j < nS; j += ringStep) {
        for (let i = 0; i < M; i++) {
          const a = (j * M + i) * 3;
          const b = (j * M + ((i + 1) % M)) * 3;
          gpos.push(base[a], base[a + 1], base[a + 2], base[b], base[b + 1], base[b + 2]);
        }
      }
      for (let i = 0; i < M; i += perStep) {
        for (let j = 0; j < span; j++) {
          const a = (j * M + i) * 3;
          const b = (((j + 1) % nS) * M + i) * 3;
          gpos.push(base[a], base[a + 1], base[a + 2], base[b], base[b + 1], base[b + 2]);
        }
      }
      const ggeo = new THREE.BufferGeometry();
      ggeo.setAttribute("position", new THREE.Float32BufferAttribute(gpos, 3));
      ghost.add(new THREE.LineSegments(ggeo, ghostMat));

      const elems = span * M;
      nodeBase += nS * M;
      elemBase += elems;
      this.stats.elements += elems;
      this.stats.nodes += nS * M;
    }

    // Bounding box of the undeformed structure for framing, ground grid and glyph sizes
    const box = new THREE.Box3();
    for (const m of variant.members) {
      for (const s of m.stations) {
        box.expandByPoint(new THREE.Vector3(...s.p));
        box.expandByPoint(new THREE.Vector3(...add(s.p, scl(s.d, this.deflectionScale))));
      }
    }
    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 0.3);
    this._addSupports(model, variant, extent);
    this._addContext(model, variant, extent);

    ghost.visible = this.showWireframe;
    scene.add(model, ghost);
    const grid = new THREE.GridHelper(extent * 2.4, 24, 0x1e3a5f, 0x13233a);
    grid.rotateX(Math.PI / 2);
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    const center = box.getCenter(new THREE.Vector3());
    grid.position.set(center.x, center.y, box.min.z - extent * 0.12);
    scene.add(grid);
    // Horizontal and vertical extents frame tall parts (the oleo strut) as well as long ones (the spar).
    Object.assign(this.gl, { model, ghost, grid, center, extent, extH: Math.max(size.x, size.y, 0.05), extV: Math.max(size.z, 0.05) });
    this.gl.probe.scale.setScalar(extent * 0.006);
    this.gl.probe.visible = false;
    if (reframe) Object.assign(this.cam, { yaw: -0.62, pitch: 0.38, zoom: 1.0, panX: 0, panY: 0, target: null });
    const cbar = document.getElementById("lbl-colorbar-max");
    if (cbar) cbar.textContent = `${(allow / 1e6).toFixed(0)} MPa (allowable)`;
    this._idleHud();
    this._renderMeshInfo();
    this.render();
  }

  _addSupports(model, variant, extent) {
    const { THREE } = this.gl;
    const plateMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.8, transparent: true, opacity: 0.88, side: THREE.DoubleSide });
    const hatchMat = new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.7 });
    for (const bc of variant.bc || []) {
      const n = norm(bc.n);
      const e1 = norm(Math.abs(n[2]) > 0.9 ? cross(n, [0, 1, 0]) : cross(n, [0, 0, 1]));
      const e2 = cross(n, e1);
      const [a, b] = bc.size;
      const th = extent * 0.012;
      const geo = new THREE.BoxGeometry(a, b, th);
      const plate = new THREE.Mesh(geo, plateMat);
      plate.matrixAutoUpdate = false;
      const c = add(bc.p, scl(n, th / 2));
      plate.matrix.makeBasis(new THREE.Vector3(...e1), new THREE.Vector3(...e2), new THREE.Vector3(...n)).setPosition(...c);
      model.add(plate);
      // Hatching on the outer face marks the fixed support
      const hp = [];
      const face = add(bc.p, scl(n, th * 1.05));
      for (let q = -6; q <= 6; q++) {
        const o = (q / 6) * a * 0.5;
        const p0 = add(face, add(scl(e1, o - b * 0.25), scl(e2, -b * 0.5)));
        const p1 = add(face, add(scl(e1, o + b * 0.25), scl(e2, b * 0.5)));
        hp.push(...p0, ...p1);
      }
      const hg = new THREE.BufferGeometry();
      hg.setAttribute("position", new THREE.Float32BufferAttribute(hp, 3));
      model.add(new THREE.LineSegments(hg, hatchMat));
    }
    const loads = variant.loads || [];
    const maxMag = Math.max(...loads.map((l) => Math.abs(l.mag_n)), 1);
    for (const l of loads) {
      const dir = new THREE.Vector3(...norm(l.dir));
      const len = extent * 0.14 * (0.45 + 0.55 * Math.abs(l.mag_n) / maxMag);
      const distributed = /q\(/.test(l.label);
      const origin = new THREE.Vector3(...l.p).addScaledVector(dir, distributed ? 0 : -len);
      model.add(new THREE.ArrowHelper(dir, origin, len, distributed ? 0x34d399 : 0xf59e0b, len * 0.22, len * 0.12));
    }
  }

  _addContext(model, variant, extent) {
    const { THREE } = this.gl;
    const ghostMat = new THREE.MeshStandardMaterial({ color: 0x64748b, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.45 });
    const tipD = (() => {
      const S = variant.members[0].stations;
      return scl(S[S.length - 1].d, this.deflectionScale);
    })();
    for (const c of variant.context || []) {
      let obj = null;
      if (c.type === "wheel") {
        const g = new THREE.CylinderGeometry(c.r, c.r, c.w, 36, 1);
        obj = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.9 }));
        obj.position.set(...add(c.p, tipD));
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), edgeMat);
        e.position.copy(obj.position);
        model.add(e);
      } else if (c.type === "engine") {
        const g = new THREE.BoxGeometry(...c.size);
        obj = new THREE.Mesh(g, ghostMat);
        obj.position.set(...c.p);
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), edgeMat);
        e.position.set(...c.p);
        model.add(e);
      } else if (c.type === "fuselage") {
        const g = new THREE.CylinderGeometry(c.r, c.r, c.x1 - c.x0, 40, 1, true);
        obj = new THREE.Mesh(g, ghostMat);
        obj.rotation.z = Math.PI / 2;
        obj.position.set((c.x0 + c.x1) / 2, 0, 0);
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(g, 1), edgeMat);
        e.rotation.copy(obj.rotation);
        e.position.copy(obj.position);
        model.add(e);
      }
      if (obj) model.add(obj);
    }
  }

  _renderGL() {
    const gl = this.gl;
    if (!gl?.center) {
      gl?.renderer.render(gl.scene, gl.camera);
      return;
    }
    const { camera, renderer, THREE } = gl;
    const { yaw, pitch, zoom, panX, panY } = this.cam;
    const aspect = this.w / this.h;
    camera.aspect = aspect;
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    // ~62% of the width is clear between the side panels; fit both extents with some margin
    const R = (1.25 * Math.max(gl.extH / (Math.min(aspect, 1.6) * 0.62), gl.extV / 0.85)) / (2 * tanHalf) / zoom;
    const cp = Math.cos(pitch);
    const dir = new THREE.Vector3(Math.sin(yaw) * cp, -Math.cos(yaw) * cp, Math.sin(pitch));
    const target = this.cam.target ? new THREE.Vector3(...this.cam.target) : gl.center.clone();
    camera.position.copy(target).addScaledVector(dir, R);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    const k = (2 * R * tanHalf) / this.h;
    const shift = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(-panX * k);
    shift.addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1), panY * k);
    camera.position.add(shift);
    camera.lookAt(target.add(shift));
    camera.near = R / 200;
    camera.far = R * 20;
    camera.updateProjectionMatrix();
    renderer.render(gl.scene, camera);
  }

  /* ----- hover probe ----- */

  _hover(e) {
    const gl = this.gl;
    if (!gl?.meshes.length) return;
    if (!e) {
      gl.probe.visible = false;
      this._idleHud();
      this.render();
      return;
    }
    const rect = gl.renderer.domElement.getBoundingClientRect();
    const ndc = new gl.THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    gl.raycaster.setFromCamera(ndc, gl.camera);
    const hit = gl.raycaster.intersectObjects(gl.meshes, false)[0];
    if (!hit) {
      if (gl.probe.visible) {
        gl.probe.visible = false;
        this._idleHud();
        this.render();
      }
      return;
    }
    const ud = hit.object.userData;
    const posAttr = hit.object.geometry.getAttribute("position");
    const { a, b, c } = hit.face;
    let best = a;
    let bestD = Infinity;
    for (const v of [a, b, c]) {
      const d = hit.point.distanceToSquared(new gl.THREE.Vector3().fromBufferAttribute(posAttr, v));
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    gl.probe.position.fromBufferAttribute(posAttr, best);
    gl.probe.visible = true;
    const vm = ud.vms[best];
    const margin = ud.allow / Math.max(vm, 1) - 1;
    const elem = hit.faceIndex < ud.gridFaces ? `E${ud.elemBase + Math.floor(hit.faceIndex / 2) + 1}` : "cap / web / rib";
    const [x, y, z] = [ud.base[3 * best], ud.base[3 * best + 1], ud.base[3 * best + 2]];
    gl.hud.innerHTML =
      `<b>${esc(ud.member)}</b> · element <b>${elem}</b> · node <b>N${ud.nodeBase + best + 1}</b><br>` +
      `(x, y, z) = (${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}) m<br>` +
      `σ<sub>vM</sub> <b class="${margin < 0 ? "hot" : ""}">${(vm / 1e6).toFixed(1)} MPa</b> · |δ| <b>${(ud.dmag[best] * 1000).toFixed(2)} mm</b> · ` +
      `local margin <b class="${margin < 0 ? "hot" : "ok"}">${sgn(margin)}</b>`;
    this.render();
  }

  _idleHud() {
    const gl = this.gl;
    const c = this._comp();
    if (!gl || !c) return;
    const view = this.morph >= 1 ? "AI-optimised" : this.morph <= 0 ? "baseline" : `blend ${(this.morph * 100).toFixed(0)}%`;
    gl.hud.innerHTML =
      `${esc(c.name)} · ${view} · ${this.stats.elements.toLocaleString()} quad elements · ${this.stats.nodes.toLocaleString()} nodes<br>` +
      `deformed ×${this.deflectionScale.toFixed(1)} · ghost = undeformed · hover the mesh to probe σ<sub>vM</sub>, δ and margin`;
  }

  _setEmpty(msg) {
    if (this.empty) {
      this.empty.innerHTML = msg;
      this.empty.style.display = msg ? "flex" : "none";
    }
  }

  /* ----- panels: optimiser card, KPIs, charts, table ----- */

  _buildPanel() {
    const col = document.querySelector("#screen-detailed .ws-left");
    const panel = document.createElement("div");
    panel.className = "ws-panel fea-opt-panel";
    panel.innerHTML = `
      <button type="button" class="ws-head"><span>Component &amp; AI optimiser</span><span class="ws-chevron">▾</span></button>
      <div class="ws-body">
        <div class="fea-comp-list">${FEA_COMPONENTS.map(
          (c) => `<button type="button" class="fea-comp" data-comp="${c.id}"><span class="fea-comp-name">${esc(c.short)}</span><span class="fea-comp-meta">not solved</span></button>`
        ).join("")}</div>
        <div class="fea-row"><span class="fea-lbl">Mesh density</span><div class="fea-seg">${Object.entries(DENSITY)
          .map(([k, d]) => `<button type="button" data-density="${k}">${d.label}</button>`)
          .join("")}</div></div>
        <div class="fea-mono fea-mesh-info"></div>
        <div class="fea-row"><span class="fea-lbl">Goal</span><select class="fea-goal">
          <option value="min_mass">Minimise mass</option>
          <option value="max_margin">Maximise safety margin</option>
          <option value="reduce_root_stress">Reduce root peak stress</option>
        </select></div>
        <button type="button" class="fea-opt-btn">✦ Optimise part with AI agent</button>
        <div class="fea-mono fea-ai-status"></div>
        <div class="fea-result" hidden></div>
        <details class="fea-assume"><summary>Model &amp; assumptions</summary><div class="fea-assume-body"></div></details>
      </div>`;
    panel.querySelector(".ws-head").addEventListener("click", () => panel.classList.toggle("collapsed"));
    panel.querySelectorAll(".fea-comp").forEach((b) =>
      b.addEventListener("click", () => {
        this.selectComponent(b.dataset.comp);
        this.onSelect?.(b.dataset.comp);
      })
    );
    panel.querySelectorAll("[data-density]").forEach((b) =>
      b.addEventListener("click", () => {
        this.density = b.dataset.density;
        this._rebuild();
        this._renderPanel();
      })
    );
    panel.querySelector(".fea-goal").addEventListener("change", (e) => {
      this.goal = e.target.value;
      if (this.showResult) {
        this._rebuild();
        this._refreshPanels();
      }
    });
    panel.querySelector(".fea-opt-btn").addEventListener("click", () => this._optimize());
    this.panel = panel;
    if (col) {
      col.prepend(panel);
      const dock = document.querySelector("#screen-detailed .ws-dock");
      if (dock) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "ws-chip on";
        chip.textContent = "Component & AI";
        chip.addEventListener("click", () => {
          const hidden = panel.classList.toggle("off");
          if (!hidden) panel.classList.remove("collapsed");
          chip.classList.toggle("on", !hidden);
        });
        dock.prepend(chip);
      }
      // The pipeline card is secondary now; start it collapsed to give the optimiser room.
      col.querySelector(".ws-panel:not(.fea-opt-panel)")?.classList.add("collapsed");
    }
  }

  _optimize() {
    if (!this._opt()) return;
    this.showResult = true;
    this._animateMorph(1);
    this._refreshPanels();
  }

  _animateMorph(to) {
    const from = this.morph;
    const t0 = performance.now();
    const step = (now) => {
      const u = Math.min(1, (now - t0) / 700);
      this.morph = from + (to - from) * (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
      this._rebuild();
      this._syncScrub();
      if (u < 1) requestAnimationFrame(step);
      else this._refreshPanels();
    };
    requestAnimationFrame(step);
  }

  _syncScrub() {
    const s = this.panel?.querySelector(".fea-scrub input");
    if (s) s.value = String(this.morph);
    this.panel?.querySelectorAll("[data-variant]").forEach((b) => b.classList.toggle("on", Number(b.dataset.variant) === Math.round(this.morph)));
  }

  _refreshAll(reframe = false) {
    const part = FEA_COMPONENTS.find((c) => c.id === this.componentId);
    const err = this.stressMesh?.components_fea?.[this.componentId]?.error;
    const busy = this._solve && !this._solve.ended;
    this._setEmpty(
      this.ownsPanels || busy
        ? ""
        : err
          ? `${esc(part.name)}: the solver failed (${esc(err)}).`
          : `${esc(part.name)}: no fine-mesh FEA results yet.<br>Press ▶ Run in the analysis pipeline to solve it.`
    );
    this._rebuild(reframe);
    this._refreshPanels();
  }

  _refreshPanels() {
    this._renderPanel();
    if (!this.ownsPanels) return;
    this._renderKpis();
    this._renderCharts();
    this._renderTable();
    this._idleHud();
  }

  _renderMeshInfo() {
    const info = this.panel?.querySelector(".fea-mesh-info");
    const c = this._comp();
    if (!info) return;
    if (!c) {
      info.textContent = "";
      return;
    }
    let conv = c.convergence_note || "";
    if (Array.isArray(c.convergence) && c.convergence.length > 1) {
      const a = c.convergence[c.convergence.length - 2].peak_vm_pa;
      const b = c.convergence[c.convergence.length - 1].peak_vm_pa;
      conv = `solver convergence: peak ${c.convergence.map((x) => `${x.n}→${(x.peak_vm_pa / 1e6).toFixed(1)}`).join(" · ")} MPa (Δ ${((100 * Math.abs(b - a)) / Math.max(b, 1)).toFixed(2)}%)`;
    }
    info.innerHTML = `${this.stats.elements.toLocaleString()} display elements · ${this.stats.nodes.toLocaleString()} nodes, interpolated from the solver stations<br>${esc(conv)}`;
  }

  _renderPanel() {
    const p = this.panel;
    if (!p) return;
    p.querySelectorAll(".fea-comp").forEach((b) => {
      const c = this._comp(b.dataset.comp);
      const err = this.stressMesh?.components_fea?.[b.dataset.comp]?.error;
      b.classList.toggle("on", b.dataset.comp === this.componentId);
      const meta = b.querySelector(".fea-comp-meta");
      if (c) {
        const m = c.baseline.metrics;
        meta.innerHTML = `<span class="${m.margin < 0 ? "bad" : "ok"}">MS ${sgn(m.margin)}</span> · ${(m.peak_vm_pa / 1e6).toFixed(0)} MPa · ${m.mass_kg.toFixed(1)} kg`;
      } else meta.textContent = err ? "solver error" : "not solved";
    });
    p.querySelectorAll("[data-density]").forEach((b) => b.classList.toggle("on", b.dataset.density === this.density));
    p.querySelector(".fea-goal").value = this.goal;
    const c = this._comp();
    const opt = this._opt(c);
    p.querySelector(".fea-opt-btn").disabled = !opt;
    const ai = c?.ai || this.stressMesh?.ai_optimization;
    const lastRun = this._solve?.finished ? ` · last run ${this._solve.secs.toFixed(1)} s` : "";
    p.querySelector(".fea-ai-status").textContent = ai ? `${ai.status}${lastRun}` : "Optimiser runs with the CAD + FEA stream.";
    this._renderMeshInfo();

    const body = p.querySelector(".fea-assume-body");
    body.innerHTML = c
      ? `<div class="fea-mono" style="margin-top:0.3rem">${esc(c.model)} · ${esc(c.material)}</div><ul>${c.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` +
        `<div class="fea-mono">Sources: ${c.sources.map(esc).join("; ")}</div>`
      : "";

    const res = p.querySelector(".fea-result");
    if (!c || !opt || !this.showResult) {
      res.hidden = true;
      return;
    }
    res.hidden = false;
    const b = c.baseline.metrics;
    const a = opt.variant.metrics;
    const row = (label, bv, av, fmt, betterLow) => {
      const better = betterLow ? av < bv - 1e-9 : av > bv + 1e-9;
      const worse = betterLow ? av > bv + 1e-9 : av < bv - 1e-9;
      return `<tr><td>${label}</td><td>${fmt(bv)}</td><td class="${better ? "good" : worse ? "worse" : ""}">${fmt(av)}</td></tr>`;
    };
    const ap = opt.ai_proposal;
    const engine = ai?.engine || "optimiser";
    const trace = [];
    if (ap) {
      trace.push(`<li>${esc(engine)} proposed ${esc(c.zones[0])} ×${ap.k[0]}, ${esc(c.zones[1])} ×${ap.k[1]}</li>`);
      trace.push(`<li>FEA re-solve: MS ${sgn(ap.verified_metrics.margin)}, ${ap.verified_metrics.mass_kg.toFixed(2)} kg, peak ${mpa(ap.verified_metrics.peak_vm_pa)}</li>`);
      trace.push(`<li class="${ap.accepted ? "acc" : "rej"}">${esc(ap.verdict)}${ap.accepted ? "" : " → deterministic optimum used"}</li>`);
    } else {
      trace.push(`<li>${esc(ai?.source === "ai" ? "No AI proposal for this part/goal" : ai?.status || "AI offline")}</li>`);
      trace.push(`<li>Grid search: ${ai?.grid?.runs_per_component ?? 169} FEA re-solves, constraint ${esc(ai?.constraints?.[this.goal] || "")}</li>`);
      trace.push(`<li class="acc">Optimum ${esc(c.zones[0])} ×${opt.k[0]}, ${esc(c.zones[1])} ×${opt.k[1]}</li>`);
    }
    res.innerHTML = `
      <div class="fea-row"><span class="fea-lbl">${esc(opt.goal_label)}</span>
        <span class="fea-src ${opt.source === "ai" ? "ai" : "det"}">${opt.source === "ai" ? `✦ ${esc(engine)} · solver-verified` : "deterministic optimiser"}</span></div>
      <ol class="fea-trace">${trace.join("")}</ol>
      <table class="fea-ba"><thead><tr><th></th><th>Baseline</th><th>AI-optimised</th></tr></thead><tbody>
        ${row("Mass", b.mass_kg, a.mass_kg, (v) => `${v.toFixed(2)} kg`, true)}
        ${row("Peak σ_vM", b.peak_vm_pa, a.peak_vm_pa, (v) => `${(v / 1e6).toFixed(1)} MPa`, true)}
        ${row("Root σ_vM", b.root_peak_vm_pa, a.root_peak_vm_pa, (v) => `${(v / 1e6).toFixed(1)} MPa`, true)}
        ${row("Max deflection", b.max_deflection_m, a.max_deflection_m, (v) => `${(v * 1000).toFixed(1)} mm`, true)}
        ${row("Safety margin", b.margin, a.margin, (v) => sgn(v), false)}
      </tbody></table>
      <div class="fea-mono">Mass saved ${sgn(-opt.delta.mass_kg, 2)} kg (${sgn(-opt.delta.mass_pct, 1)}%) · ${Object.entries(opt.variant.gauges || {})
        .map(([k, v]) => `${esc(k)} ${v}`)
        .join(" · ")}</div>
      <div class="fea-why">${esc(opt.rationale)}</div>
      <div class="fea-row"><div class="fea-seg"><button type="button" data-variant="0">Baseline</button><button type="button" data-variant="1">AI-optimised</button></div></div>
      <div class="fea-scrub"><span class="fea-mono">base</span><input type="range" min="0" max="1" step="0.01" value="${this.morph}" /><span class="fea-mono">opt</span></div>`;
    res.querySelectorAll("[data-variant]").forEach((btn) => btn.addEventListener("click", () => this._animateMorph(Number(btn.dataset.variant))));
    res.querySelector(".fea-scrub input").addEventListener("input", (e) => {
      this.morph = Number(e.target.value);
      this._rebuild();
      this._syncScrub();
    });
    res.querySelector(".fea-scrub input").addEventListener("change", () => this._refreshPanels());
    this._syncScrub();
  }

  _renderKpis() {
    const el = document.getElementById("detailed-kpis");
    const c = this._comp();
    if (!el || !c) return;
    const b = c.baseline.metrics;
    const opt = this.showResult && this.morph > 0.5 ? this._opt(c) : null;
    const m = opt ? opt.variant.metrics : b;
    const sim = `<span class="prov-badge prov-simulation prov-verified" title="${esc(c.model)}">sim</span>`;
    const tbl = `<span class="prov-badge prov-table prov-verified" title="${esc(c.material)}: Raymer 2ed Table 14.3 (verified materials table)">tbl</span>`;
    const delta = (cur, base, fmt, lowGood = true) => {
      if (!opt) return "";
      const d = cur - base;
      const good = lowGood ? d < 0 : d > 0;
      return `<div class="fea-kpi-sub ${Math.abs(d) < 1e-9 ? "" : good ? "good" : "worse"}">${fmt(d)} vs baseline</div>`;
    };
    const card = (label, val, sub = "", badge = sim) => `<div class="kpi-card"><div class="kpi-label"><span>${esc(label)}</span>${badge}</div><div class="kpi-val">${val}</div>${sub}</div>`;
    const allowNote = ["engine_mount", "main_landing_gear"].includes(c.id) ? " (incl. buckling)" : "";
    // Order matters: Harry's overhaul.css folds children 2, 4 and 5 behind "Show all metrics" and
    // promotes child 3, so the secondary cards sit in those slots and margin is the hero.
    el.innerHTML = [
      card("Peak σ_vM", mpa(m.peak_vm_pa), delta(m.peak_vm_pa, b.peak_vm_pa, (d) => `${sgn(d / 1e6, 1)} MPa`)),
      card("Allowable", mpa(m.allowable_pa), "", tbl),
      card(`Safety margin, FEA${allowNote}`, `<span style="color:${m.margin < 0 ? "#fb7185" : "#34d399"}">${sgn(m.margin)}</span>`, delta(m.margin, b.margin, (d) => sgn(d), false)),
      card("FE mesh", `${this.stats.elements.toLocaleString()}`, `<div class="fea-kpi-sub">${DENSITY[this.density].label} · ${this.stats.nodes.toLocaleString()} nodes</div>`, ""),
      card("Solver", `<span style="font-size:0.72rem">${esc(c.model.split(":")[0].split(",")[0])}</span>`, "", ""),
      card(c.id === "main_wing_spar" ? "Mass (one side)" : c.id === "horizontal_tail" ? "Mass (one half)" : "Mass", `${m.mass_kg.toFixed(2)} kg`, delta(m.mass_kg, b.mass_kg, (d) => `${sgn(d, 2)} kg`)),
      card("Max deflection", mm(m.max_deflection_m), delta(m.max_deflection_m, b.max_deflection_m, (d) => `${sgn(d * 1000, 1)} mm`)),
      `<div class="fea-gov">Governing: <b>${esc(m.governing)}</b><br>${esc(c.model)}</div>`,
    ].join("");
  }

  _renderCharts() {
    const c = this._comp();
    if (!c) return;
    const base = c.baseline.chart;
    const opt = this.showResult ? this._opt(c)?.variant.chart : null;
    const sEl = document.getElementById("chart-fea-stress");
    const dEl = document.getElementById("chart-fea-deflection");
    const title = (el, text) => {
      const h = el?.previousElementSibling;
      if (h && h.tagName === "H3") h.textContent = text;
    };
    const allowMpa = c.baseline.metrics.allowable_pa / 1e6;
    if (base.kind === "bars") {
      title(sEl, `${c.name}: member axial stress vs buckling`);
      title(dEl, "Member end displacement");
      if (sEl) sEl.innerHTML = barChart(base.labels, base.vm_pa.map((v) => v / 1e6), opt?.vm_pa.map((v) => v / 1e6), base.ref_pa.map((v) => (v == null ? null : v / 1e6)), allowMpa, "MPa", base.sign);
      if (dEl) dEl.innerHTML = barChart(base.labels, base.defl_m.map((v) => v * 1000), opt?.defl_m.map((v) => v * 1000), null, null, "mm");
    } else {
      title(sEl, `${c.name}: σ_vM along the member`);
      title(dEl, base.defl_label ? `${c.name}: ${base.defl_label}` : `${c.name}: deflection`);
      if (sEl) {
        sEl.innerHTML = lineChart(base.x, [
          { y: base.vm_pa.map((v) => v / 1e6), color: "#f43f5e", label: "FEA σ_vM baseline" },
          opt && { y: opt.vm_pa.map((v) => v / 1e6), color: "#a78bfa", label: "AI-optimised" },
          base.ref_pa && { y: base.ref_pa.map((v) => v / 1e6), color: "#38bdf8", dash: true, label: base.ref_label },
        ], base.x_label, "MPa", allowMpa);
      }
      if (dEl) {
        dEl.innerHTML = lineChart(base.x, [
          { y: base.defl_m.map((v) => v * 1000), color: "#10b981", label: "FEA baseline" },
          opt && { y: opt.defl_m.map((v) => v * 1000), color: "#a78bfa", label: "AI-optimised" },
          base.ref_defl_m && { y: base.ref_defl_m.map((v) => v * 1000), color: "#f59e0b", dash: true, label: base.ref_defl_label },
        ], base.x_label, "mm");
      }
    }
  }

  _renderTable() {
    const el = document.getElementById("spar-stations-table");
    const c = this._comp();
    if (!el || !c) return;
    const h = el.previousElementSibling;
    const opt = this.showResult && this.morph > 0.5 ? this._opt(c) : null;
    const t = (opt ? opt.variant : c.baseline).table;
    if (h && h.tagName === "H3") h.textContent = `${c.name}: ${opt ? "AI-optimised" : "baseline"} gauges & stations`;
    el.innerHTML = `<table class="eng-table"><thead><tr>${t.columns.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead>
      <tbody>${t.rows.map((r) => `<tr>${r.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
}

/* ---------------- small SVG charts (same look as charts.js) ---------------- */

const W = 520;
const H = 205;
const PAD = { l: 52, r: 18, t: 30, b: 34 };

function legend(series) {
  let x = PAD.l;
  return series
    .map((s) => {
      const txt = `${s.dash ? "┄" : "━"} ${s.label}`;
      const out = `<text x="${x}" y="14" fill="${s.color}" font-size="10" font-family="monospace">${esc(txt)}</text>`;
      x += txt.length * 6.1 + 10;
      return out;
    })
    .join("");
}

function lineChart(xs, seriesIn, xLabel, unit, allow = null) {
  const series = seriesIn.filter(Boolean);
  const pw = W - PAD.l - PAD.r;
  const ph = H - PAD.t - PAD.b;
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs, x0 + 1e-9);
  const yMax = Math.max(...series.flatMap((s) => s.y.map(Math.abs)), allow ? allow * 1.1 : 0, 1e-6) * 1.05;
  const yMin = Math.min(0, ...series.flatMap((s) => s.y));
  const X = (x) => PAD.l + ((x - x0) / (x1 - x0)) * pw;
  const Y = (y) => PAD.t + ph - ((y - yMin) / (yMax - yMin)) * ph;
  const lines = series
    .map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="${s.dash ? 1.8 : 2.3}" ${s.dash ? 'stroke-dasharray="5,3"' : ""} points="${s.y.map((y, i) => `${X(xs[i]).toFixed(1)},${Y(y).toFixed(1)}`).join(" ")}" />`)
    .join("");
  const allowLine = allow
    ? `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(allow).toFixed(1)}" y2="${Y(allow).toFixed(1)}" stroke="#ef4444" stroke-dasharray="4,3" stroke-width="1.2"/>
       <text x="${W - PAD.r - 2}" y="${(Y(allow) - 4).toFixed(1)}" text-anchor="end" fill="#ef4444" font-size="9.5" font-family="monospace">allowable ${allow.toFixed(0)} ${unit}</text>`
    : "";
  return `<svg viewBox="0 0 ${W} ${H}" class="eng-svg">${legend(series)}
    <line x1="${PAD.l}" y1="${PAD.t + ph}" x2="${W - PAD.r}" y2="${PAD.t + ph}" stroke="#334155"/>
    <line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${PAD.t + ph}" stroke="#334155"/>
    ${allowLine}${lines}
    <text x="${PAD.l - 6}" y="${PAD.t + 8}" text-anchor="end" fill="#94a3b8" font-size="10" font-family="monospace">${yMax.toFixed(yMax < 10 ? 1 : 0)}</text>
    <text x="${PAD.l - 6}" y="${PAD.t + ph}" text-anchor="end" fill="#94a3b8" font-size="10" font-family="monospace">${yMin.toFixed(0)}</text>
    <text x="${PAD.l - 30}" y="${PAD.t + ph / 2}" fill="#94a3b8" font-size="10" font-family="monospace" transform="rotate(-90 ${PAD.l - 30} ${PAD.t + ph / 2})" text-anchor="middle">${unit}</text>
    <text x="${PAD.l + pw / 2}" y="${H - 8}" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="monospace">${esc(xLabel)} · ${x0.toFixed(1)} → ${x1.toFixed(1)}</text>
  </svg>`;
}

function barChart(labels, base, opt, ref, allow, unit, signs = null) {
  const pw = W - PAD.l - PAD.r;
  const ph = H - PAD.t - PAD.b;
  const yMax = Math.max(...base, ...(opt || []), ...(ref || []).filter((v) => v != null).map((v) => Math.min(v, (allow || 1e9) * 1.4)), allow ? allow * 1.08 : 0, 1e-6) * 1.05;
  const Y = (y) => PAD.t + ph - (Math.min(y, yMax) / yMax) * ph;
  const slot = pw / labels.length;
  const bw = opt ? slot * 0.36 : slot * 0.6;
  let bars = "";
  labels.forEach((lab, i) => {
    const x = PAD.l + slot * i + slot * 0.5;
    const col = signs ? (signs[i] < 0 ? "#38bdf8" : "#f59e0b") : "#10b981";
    bars += `<rect x="${(x - (opt ? bw : bw / 2)).toFixed(1)}" y="${Y(base[i]).toFixed(1)}" width="${bw.toFixed(1)}" height="${(PAD.t + ph - Y(base[i])).toFixed(1)}" fill="${col}" opacity="0.85"/>`;
    if (opt) bars += `<rect x="${x.toFixed(1)}" y="${Y(opt[i]).toFixed(1)}" width="${bw.toFixed(1)}" height="${(PAD.t + ph - Y(opt[i])).toFixed(1)}" fill="#a78bfa" opacity="0.9"/>`;
    if (ref && ref[i] != null) bars += `<line x1="${(x - slot * 0.42).toFixed(1)}" x2="${(x + slot * 0.42).toFixed(1)}" y1="${Y(ref[i]).toFixed(1)}" y2="${Y(ref[i]).toFixed(1)}" stroke="#f43f5e" stroke-width="2"/>`;
    bars += `<text x="${x.toFixed(1)}" y="${H - 18}" text-anchor="middle" fill="#94a3b8" font-size="9" font-family="monospace">${esc(lab)}</text>`;
  });
  const leg = [
    signs ? { label: "tension", color: "#f59e0b" } : { label: "baseline", color: "#10b981" },
    signs && { label: "compression", color: "#38bdf8" },
    opt && { label: "AI-optimised", color: "#a78bfa" },
    ref && { label: "σ_cr buckling", color: "#f43f5e" },
  ].filter(Boolean);
  const allowLine = allow
    ? `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(allow).toFixed(1)}" y2="${Y(allow).toFixed(1)}" stroke="#ef4444" stroke-dasharray="4,3"/>`
    : "";
  return `<svg viewBox="0 0 ${W} ${H}" class="eng-svg">${legend(leg)}
    <line x1="${PAD.l}" y1="${PAD.t + ph}" x2="${W - PAD.r}" y2="${PAD.t + ph}" stroke="#334155"/>
    ${allowLine}${bars}
    <text x="${PAD.l - 6}" y="${PAD.t + 8}" text-anchor="end" fill="#94a3b8" font-size="10" font-family="monospace">${yMax.toFixed(yMax < 10 ? 1 : 0)}</text>
    <text x="${PAD.l - 6}" y="${PAD.t + ph}" text-anchor="end" fill="#94a3b8" font-size="10" font-family="monospace">0 ${unit}</text>
  </svg>`;
}
