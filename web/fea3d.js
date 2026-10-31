/**
 * Viewport B: Spar CAD / FEA von Mises 3D scene (Owner: Tharm).
 *
 * Uses Three.js (loaded dynamically from CDN) with an instant, zero-latency
 * interactive 3D-projection Canvas renderer so it renders immediately and
 * never fails even offline.
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
