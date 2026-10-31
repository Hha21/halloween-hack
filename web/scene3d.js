/**
 * Dual 3D WebGL / Interactive 3D Canvas Scenes for Spiral (Owner: Tharm).
 *
 * Uses Three.js (loaded dynamically from CDN) with an instant, zero-latency
 * interactive 3D-projection Canvas renderer so it renders immediately and
 * never fails even offline.
 */

const THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.164.1/build/three.module.js";
let threePromise = null;
function loadThree() {
  if (!threePromise) {
    threePromise = import(THREE_CDN).catch(() => null);
  }
  return threePromise;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function rgbToHex(r, g, b) {
  const to2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/**
 * Map von Mises stress (Pa) vs allowable stress (Pa) to scientific turbo/jet hex colour.
 */
export function vonMisesColorHex(stressPa, allowablePa = 345e6) {
  const r = Math.max(0, Math.min(1.25, Number(stressPa || 0) / Math.max(Number(allowablePa || 345e6), 1)));
  const stops = [
    { t: 0.0, c: [29, 78, 216] },   // #1d4ed8 deep blue
    { t: 0.28, c: [6, 182, 212] },  // #06b6d4 cyan
    { t: 0.55, c: [16, 185, 129] }, // #10b981 emerald
    { t: 0.80, c: [245, 158, 11] }, // #f59e0b amber
    { t: 1.00, c: [239, 68, 68] },  // #ef4444 crimson
    { t: 1.25, c: [244, 63, 94] },  // #f43f5e magenta-red
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (r >= a.t && r <= b.t) {
      const u = (r - a.t) / Math.max(b.t - a.t, 1e-6);
      return rgbToHex(lerp(a.c[0], b.c[0], u), lerp(a.c[1], b.c[1], u), lerp(a.c[2], b.c[2], u));
    }
  }
  return "#f43f5e";
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

/**
 * Viewport A: 3D Parametric Aircraft + Internal Main Spar + Schrenk Lift Curtain
 */
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
    loadThree(); // Warm CDN cache in background

    this._anim = requestAnimationFrame(() => this._tick());
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
    this.render();
  }

  setShowLiftCurtain(visible) {
    this.showLiftCurtain = Boolean(visible);
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
    this.render();
  }

  render() {
    const ctx = this.ctx;
    if (!ctx || !this.w) return;
    const W = this.w;
    const H = this.h;
    ctx.clearRect(0, 0, W, H);

    // Studio background radial glow
    const bg = ctx.createRadialGradient(W * 0.5, H * 0.5, 20, W * 0.5, H * 0.5, Math.max(W, H) * 0.7);
    bg.addColorStop(0, "#111c2d");
    bg.addColorStop(1, "#070b14");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const g = this.geometry || {
      fuselage: { length_m: 8.2, diameter_m: 1.22, nose_length_m: 1.8, cabin_length_m: 3.0 },
      wing: { span_m: 10.8, root_chord_m: 1.8, tip_chord_m: 1.08, x_le_m: 2.6, z_m: 0.52, dihedral_deg: 2.0 },
      horizontal_tail: { span_m: 3.86, root_chord_m: 1.17, tip_chord_m: 0.76, x_le_m: 6.9, z_m: 0.15 },
      vertical_tail: { height_m: 1.62, root_chord_m: 1.3, tip_chord_m: 0.71, x_le_m: 6.7, z_m: 0.25 },
      propeller: { diameter_m: 1.9, x_m: 0.05 },
    };

    const fuseL = Number(g.fuselage?.length_m || 8.2);
    const cxOff = fuseL * 0.45;
    const P = (x, y, z) => project3D(x - cxOff, y, z, this.cam, W, H);

    // Floor Grid at z = -1.1m
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

    // Fuselage lofted panels
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
    // Cockpit canopy
    drawPoly(
      [[nL * 0.75, -rF * 0.72, rF * 0.55], [nL + cL * 0.55, -rF * 0.68, rF * 0.95], [nL + cL * 0.55, rF * 0.68, rF * 0.95], [nL * 0.75, rF * 0.72, rF * 0.55]],
      "rgba(56, 189, 248, 0.35)",
      "#7dd3fc",
      1.3
    );

    // Main Wing + Internal Golden I-Beam Spar
    const wSpan = Number(g.wing?.span_m || 10.8);
    const semi = wSpan * 0.5;
    const cRoot = Number(g.wing?.root_chord_m || 1.8);
    const cTip = Number(g.wing?.tip_chord_m || 1.08);
    const xLe = Number(g.wing?.x_le_m || 2.6);
    const zW = Number(g.wing?.z_m ?? 0.52);
    const dih = ((Number(g.wing?.dihedral_deg || 2.0) * Math.PI) / 180) * semi;
    const sweepTip = (cRoot - cTip) * 0.25;

    for (const sign of [-1, 1]) {
      // Internal golden I-beam spar at 25% chord
      const xSparR = xLe + 0.25 * cRoot;
      const xSparT = xLe + sweepTip + 0.25 * cTip;
      drawPoly(
        [[xSparR - 0.06, 0, zW - 0.09], [xSparT - 0.04, sign * semi, zW + dih - 0.05], [xSparT + 0.04, sign * semi, zW + dih + 0.05], [xSparR + 0.06, 0, zW + 0.09]],
        "rgba(245, 158, 11, 0.92)",
        "#fde68a",
        1.8
      );
      // Translucent wing skin
      drawPoly(
        [[xLe, 0, zW], [xLe + sweepTip, sign * semi, zW + dih], [xLe + sweepTip + cTip, sign * semi, zW + dih], [xLe + cRoot, 0, zW]],
        `rgba(56, 189, 248, ${this.wingOpacity})`,
        "#38bdf8",
        1.5
      );
    }

    // Horizontal & Vertical Tail
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

    // Spinning Propeller
    const propR = Number(g.propeller?.diameter_m || 1.9) * 0.5;
    for (let b = 0; b < 2; b++) {
      const ang = this.propAngle + b * Math.PI;
      const a = P(-0.08, Math.cos(ang) * propR, Math.sin(ang) * propR);
      const c = P(-0.08, -Math.cos(ang) * propR, -Math.sin(ang) * propR);
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(c.sx, c.sy);
      ctx.strokeStyle = "#e2e8f0"; ctx.lineWidth = 2.6; ctx.stroke();
    }

    // 3D Schrenk Aerodynamic Lift Curtain
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

    // HUD Overlay
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px monospace";
    ctx.fillText(`Span: ${wSpan.toFixed(2)} m | Length: ${fuseL.toFixed(2)} m | Internal Golden I-Spar @ 25% MAC`, 14, H - 12);
  }

  dispose() {
    if (this._anim) cancelAnimationFrame(this._anim);
    this._ro?.disconnect();
  }
}

/**
 * Viewport B: 3D von Mises Stress-Coloured Tapered I-Beam Spar & Deflection Viewer
 */
export class SparFeaScene {
  constructor(containerEl) {
    this.container = containerEl;
    this.spar = null;
    this.fea = null;
    this.stressMesh = null;
    this.deflectionScale = 3.0;
    this.showWireframe = true;
    this.cam = { yaw: -0.58, pitch: 0.36, zoom: 1.05, panX: -20, panY: 20, baseScale: 85 };

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
  }

  setViewPreset(preset) {
    const map = {
      iso: { yaw: -0.58, pitch: 0.36, zoom: 1.05, panX: -20, panY: 20 },
      root: { yaw: -1.35, pitch: 0.25, zoom: 1.65, panX: 80, panY: 20 },
      tip: { yaw: -0.35, pitch: 0.22, zoom: 1.5, panX: -110, panY: 15 },
      front: { yaw: 0.0, pitch: 0.05, zoom: 1.1, panX: 0, panY: 20 },
      top: { yaw: 0.0, pitch: 1.45, zoom: 1.05, panX: 0, panY: 0 },
      reset: { yaw: -0.58, pitch: 0.36, zoom: 1.05, panX: -20, panY: 20 },
    };
    Object.assign(this.cam, map[preset] || map.iso);
    this.render();
  }

  setDeflectionScale(scale) {
    this.deflectionScale = Math.max(0, Math.min(30, Number(scale)));
    this.render();
  }

  setShowWireframe(visible) {
    this.showWireframe = Boolean(visible);
    this.render();
  }

  updateSparMesh(opts = {}) {
    this.spar = opts.spar ?? this.spar;
    this.fea = opts.fea ?? this.fea;
    this.stressMesh = opts.stressMesh ?? this.stressMesh;
    if (opts.deflectionScale !== undefined) this.deflectionScale = Number(opts.deflectionScale);
    if (opts.showWireframe !== undefined) this.showWireframe = Boolean(opts.showWireframe);
    this.render();
  }

  resize() {
    if (!this.container) return;
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(320, rect.width || 620);
    const h = Math.max(260, rect.height || 380);
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
    this.cam.baseScale = Math.min(w, h) * 0.14;
    this.render();
  }

  render() {
    const ctx = this.ctx;
    if (!ctx || !this.w) return;
    const W = this.w;
    const H = this.h;
    ctx.clearRect(0, 0, W, H);

    const bg = ctx.createRadialGradient(W * 0.5, H * 0.5, 20, W * 0.5, H * 0.5, Math.max(W, H) * 0.72);
    bg.addColorStop(0, "#111b2e");
    bg.addColorStop(1, "#070b14");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const feaSt = this.stressMesh?.stations || this.fea?.stations || [];
    const sparSt = this.spar?.stations || [];
    const N = Math.max(feaSt.length, sparSt.length, 16);
    const maxY = feaSt.length
      ? Math.max(...feaSt.map((s) => Number(s.y_m || 0)), 1)
      : sparSt.length
      ? Math.max(...sparSt.map((s) => Number(s.y_m || 0)), 1)
      : 5.38;
    const allowPa = Number(
      this.stressMesh?.allowable_yield_stress_pa ||
        this.spar?.allowable_yield_stress_pa ||
        345e6
    );

    // Exaggerate cross-section height/width slightly for crisp 3D I-beam visibility
    const secScale = 3.2;
    const yCenter = maxY * 0.48;
    const P = (x, y, z) => project3D(y - yCenter, x * secScale, z * secScale, this.cam, W, H);

    const stations = [];
    for (let i = 0; i < N; i++) {
      const f = feaSt[i] || {};
      const sp = sparSt[i] || {};
      const eta = i / Math.max(N - 1, 1);
      const y = Number(f.y_m ?? sp.y_m ?? eta * maxY);
      const d = Number(f.depth_m ?? sp.depth_m ?? lerp(0.228, 0.137, eta));
      const bf = Number(f.cap_width_m ?? sp.cap_width_m ?? lerp(0.08, 0.048, eta));
      const tf = Number(f.cap_thickness_m ?? sp.cap_thickness_m ?? lerp(0.014, 0.002, eta));
      const tw = Number(f.web_thickness_m ?? sp.web_thickness_m ?? 0.0015);
      const vm = Number(f.fea_von_mises_pa ?? sp.bending_stress_pa ?? (1 - eta * eta) * 340e6);
      const defl = Number(f.fea_deflection_m ?? sp.deflection_m ?? eta * eta * 0.58);
      stations.push({ y, d, bf, tf, tw, vm, defl });
    }

    // Root Cantilever Wall Plate at y = 0
    const wallPts = [
      P(-0.22, 0, -0.28),
      P(0.22, 0, -0.28),
      P(0.22, 0, 0.28),
      P(-0.22, 0, 0.28),
    ];
    ctx.beginPath();
    wallPts.forEach((p, idx) => (idx === 0 ? ctx.moveTo(p.sx, p.sy) : ctx.lineTo(p.sx, p.sy)));
    ctx.closePath();
    ctx.fillStyle = "rgba(51, 65, 85, 0.55)";
    ctx.fill();
    ctx.strokeStyle = "#64748b";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Undeformed Ghost Wireframe Reference
    if (this.showWireframe) {
      ctx.strokeStyle = "rgba(148, 163, 184, 0.28)";
      ctx.lineWidth = 1;
      for (let i = 0; i < stations.length - 1; i++) {
        const s0 = stations[i];
        const s1 = stations[i + 1];
        for (const zSign of [-0.5, 0.5]) {
          for (const xSign of [-0.5, 0.5]) {
            const a = P(xSign * s0.bf, s0.y, zSign * s0.d);
            const b = P(xSign * s1.bf, s1.y, zSign * s1.d);
            ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
          }
        }
      }
    }

    // Render Deformed 3D Tapered I-Beam Segments Coloured by Local von Mises Stress
    const deflFactor = (this.deflectionScale * 0.18) / secScale;
    const drawQuad = (p0, p1, p2, p3, fill, stroke) => {
      ctx.beginPath();
      ctx.moveTo(p0.sx, p0.sy);
      ctx.lineTo(p1.sx, p1.sy);
      ctx.lineTo(p2.sx, p2.sy);
      ctx.lineTo(p3.sx, p3.sy);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 0.85;
        ctx.stroke();
      }
    };

    for (let i = 0; i < stations.length - 1; i++) {
      const s0 = stations[i];
      const s1 = stations[i + 1];
      const w0 = s0.defl * deflFactor;
      const w1 = s1.defl * deflFactor;
      const vmAvg = 0.5 * (s0.vm + s1.vm);
      const colFlange = vonMisesColorHex(vmAvg, allowPa);
      const colWeb = vonMisesColorHex(vmAvg * 0.42, allowPa);

      // Lower Flange
      drawQuad(
        P(-s0.bf * 0.5, s0.y, -s0.d * 0.5 + w0),
        P(-s1.bf * 0.5, s1.y, -s1.d * 0.5 + w1),
        P(s1.bf * 0.5, s1.y, -s1.d * 0.5 + w1),
        P(s0.bf * 0.5, s0.y, -s0.d * 0.5 + w0),
        colFlange,
        "rgba(15,23,42,0.55)"
      );
      // Shear Web
      drawQuad(
        P(0, s0.y, -s0.d * 0.5 + w0),
        P(0, s1.y, -s1.d * 0.5 + w1),
        P(0, s1.y, s1.d * 0.5 + w1),
        P(0, s0.y, s0.d * 0.5 + w0),
        colWeb,
        "rgba(15,23,42,0.5)"
      );
      // Upper Flange
      drawQuad(
        P(-s0.bf * 0.5, s0.y, s0.d * 0.5 + w0),
        P(-s1.bf * 0.5, s1.y, s1.d * 0.5 + w1),
        P(s1.bf * 0.5, s1.y, s1.d * 0.5 + w1),
        P(s0.bf * 0.5, s0.y, s0.d * 0.5 + w0),
        colFlange,
        "rgba(255,255,255,0.28)"
      );
    }

    const peakMpa = (stations[0]?.vm || 0) / 1e6;
    const tipMm = (stations[stations.length - 1]?.defl || 0) * 1000;
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px monospace";
    ctx.fillText(
      `Root Peak von Mises: ${peakMpa.toFixed(1)} MPa | Tip Deflection: ${tipMm.toFixed(1)} mm (${this.deflectionScale.toFixed(1)}x visual scale)`,
      14,
      H - 12
    );
  }

  dispose() {
    this._ro?.disconnect();
  }
}
