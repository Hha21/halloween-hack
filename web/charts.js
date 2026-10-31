/**
 * Responsive SVG Engineering Charts for Spiral Workbench (Owner: Tharm).
 */

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 1. Dual-Axis Convergence Chart (MTOW kg + Spar Mass kg across laps)
 */
export function renderConvergenceChart(containerEl, history = [], selectedLap = null, onSelectLap = null) {
  if (!containerEl) return;
  if (!Array.isArray(history) || history.length === 0) {
    containerEl.innerHTML = `<div class="chart-empty">Run the design spiral to plot MTOW &amp; Spar Mass convergence.</div>`;
    return;
  }

  const W = 680;
  const H = 240;
  const pad = { l: 58, r: 58, t: 26, b: 38 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const mtows = history.map((d) => Number(d.mtow_kg || 0));
  const spars = history.map((d) => Number(d.spar_mass_kg || 0));
  const minM = Math.min(...mtows) * 0.96;
  const maxM = Math.max(...mtows) * 1.04 || 1;
  const minS = Math.min(...spars) * 0.9;
  const maxS = Math.max(...spars) * 1.1 || 1;

  const xAt = (i) =>
    history.length === 1 ? pad.l + plotW / 2 : pad.l + (i / (history.length - 1)) * plotW;
  const yMtow = (v) => pad.t + plotH - ((v - minM) / Math.max(maxM - minM, 1e-6)) * plotH;
  const ySpar = (v) => pad.t + plotH - ((v - minS) / Math.max(maxS - minS, 1e-6)) * plotH;

  const mtowPts = history.map((d, i) => `${xAt(i).toFixed(1)},${yMtow(d.mtow_kg).toFixed(1)}`).join(" ");
  const sparPts = history.map((d, i) => `${xAt(i).toFixed(1)},${ySpar(d.spar_mass_kg).toFixed(1)}`).join(" ");

  const activeLap = selectedLap !== null ? selectedLap : history[history.length - 1].lap;

  let gridSvg = "";
  for (let g = 0; g <= 4; g++) {
    const y = pad.t + (g / 4) * plotH;
    const mVal = maxM - (g / 4) * (maxM - minM);
    const sVal = maxS - (g / 4) * (maxS - minS);
    gridSvg += `
      <line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="#1e293b" stroke-dasharray="3,3" />
      <text x="${pad.l - 8}" y="${y + 4}" text-anchor="end" fill="#38bdf8" font-size="10" font-family="monospace">${mVal.toFixed(0)}</text>
      <text x="${W - pad.r + 8}" y="${y + 4}" text-anchor="start" fill="#f59e0b" font-size="10" font-family="monospace">${sVal.toFixed(1)}</text>
    `;
  }

  let nodesSvg = "";
  history.forEach((d, i) => {
    const cx = xAt(i);
    const cyM = yMtow(d.mtow_kg);
    const cyS = ySpar(d.spar_mass_kg);
    const isSel = d.lap === activeLap;
    const pct = Number(d.mtow_change_pct || 0);
    const pctText = i === 0 ? "init" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
    const pctColor = i > 0 && Math.abs(pct) < 0.5 ? "#10b981" : Math.abs(pct) > 2.0 ? "#f43f5e" : "#94a3b8";

    if (isSel) {
      nodesSvg += `<line x1="${cx}" y1="${pad.t}" x2="${cx}" y2="${H - pad.b}" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="4,2" opacity="0.65" />`;
    }
    nodesSvg += `
      <g class="lap-node" data-lap="${d.lap}" style="cursor:pointer">
        <circle cx="${cx}" cy="${cyM}" r="${isSel ? 6 : 4.5}" fill="#0f172a" stroke="#38bdf8" stroke-width="${isSel ? 2.5 : 1.8}" />
        <circle cx="${cx}" cy="${cyS}" r="${isSel ? 5.5 : 4}" fill="#0f172a" stroke="#f59e0b" stroke-width="${isSel ? 2.5 : 1.8}" />
        <text x="${cx}" y="${cyM - 10}" text-anchor="middle" fill="${pctColor}" font-size="10" font-family="monospace">${pctText}</text>
        <text x="${cx}" y="${H - 12}" text-anchor="middle" fill="${isSel ? "#f8fafc" : "#94a3b8"}" font-weight="${isSel ? "700" : "400"}" font-size="11" font-family="monospace">Lap ${d.lap}</text>
      </g>
    `;
  });

  containerEl.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="eng-svg">
      <text x="${pad.l}" y="15" fill="#38bdf8" font-size="11" font-family="monospace">● MTOW (kg)</text>
      <text x="${W - pad.r}" y="15" text-anchor="end" fill="#f59e0b" font-size="11" font-family="monospace">● Main Spar Mass (kg) [|ΔMTOW| &lt; 0.5% target]</text>
      ${gridSvg}
      <polyline fill="none" stroke="#38bdf8" stroke-width="2.4" points="${mtowPts}" />
      <polyline fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-dasharray="5,3" points="${sparPts}" />
      ${nodesSvg}
    </svg>
  `;

  if (typeof onSelectLap === "function") {
    containerEl.querySelectorAll(".lap-node").forEach((el) => {
      el.addEventListener("click", () => onSelectLap(Number(el.dataset.lap)));
    });
  }
}

/**
 * 2. Schrenk Spanwise Aerodynamic Lift, Shear & Bending Moment Chart
 */
export function renderLoadsChart(containerEl, loads) {
  if (!containerEl) return;
  const st = loads?.stations;
  if (!Array.isArray(st) || st.length === 0) {
    containerEl.innerHTML = `<div class="chart-empty">No spanwise aerodynamic load data yet.</div>`;
    return;
  }

  const W = 680;
  const H = 240;
  const pad = { l: 58, r: 58, t: 26, b: 36 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const maxY = Math.max(...st.map((s) => Number(s.y_m || 0)), 0.1);
  const getSchrenk = (s) => Number(s.schrenk_lift_n_per_m ?? s.l_schrenk_n_per_m ?? 0);
  const getEllip = (s) => Number(s.elliptical_lift_n_per_m ?? s.l_elliptic_n_per_m ?? 0);
  const getPlan = (s) => Number(s.planform_lift_n_per_m ?? s.l_planform_n_per_m ?? 0);
  const getMom = (s) => Number(s.bending_moment_nm ?? 0) / 1000.0; // kN*m

  const maxL = Math.max(...st.map((s) => Math.max(getSchrenk(s), getEllip(s), getPlan(s))), 1) * 1.08;
  const maxM = Math.max(...st.map((s) => getMom(s)), 0.1) * 1.08;

  const xAt = (y) => pad.l + (y / maxY) * plotW;
  const yLift = (l) => pad.t + plotH - (l / maxL) * plotH;
  const yMom = (m) => pad.t + plotH - (m / maxM) * plotH;

  const schrenkPts = st.map((s) => `${xAt(s.y_m).toFixed(1)},${yLift(getSchrenk(s)).toFixed(1)}`).join(" ");
  const ellipPts = st.map((s) => `${xAt(s.y_m).toFixed(1)},${yLift(getEllip(s)).toFixed(1)}`).join(" ");
  const planPts = st.map((s) => `${xAt(s.y_m).toFixed(1)},${yLift(getPlan(s)).toFixed(1)}`).join(" ");
  const momPts = st.map((s) => `${xAt(s.y_m).toFixed(1)},${yMom(getMom(s)).toFixed(1)}`).join(" ");
  const momArea = `${pad.l},${pad.t + plotH} ${momPts} ${xAt(maxY).toFixed(1)},${pad.t + plotH}`;

  let grid = "";
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (i / 4) * plotH;
    const lVal = maxL * (1 - i / 4);
    const mVal = maxM * (1 - i / 4);
    grid += `
      <line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="#1e293b" stroke-dasharray="3,3" />
      <text x="${pad.l - 6}" y="${y + 4}" text-anchor="end" fill="#38bdf8" font-size="10" font-family="monospace">${lVal.toFixed(0)}</text>
      <text x="${W - pad.r + 6}" y="${y + 4}" text-anchor="start" fill="#f59e0b" font-size="10" font-family="monospace">${mVal.toFixed(1)}</text>
    `;
  }

  containerEl.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="eng-svg">
      <text x="${pad.l}" y="15" fill="#38bdf8" font-size="11" font-family="monospace">━ Schrenk Lift (N/m)  ┄ Elliptical  ┈ Planform</text>
      <text x="${W - pad.r}" y="15" text-anchor="end" fill="#f59e0b" font-size="11" font-family="monospace">━ Bending Moment M(y) (kN·m)</text>
      ${grid}
      <polygon points="${momArea}" fill="#f59e0b" opacity="0.12" />
      <polyline fill="none" stroke="#94a3b8" stroke-width="1.3" stroke-dasharray="2,3" points="${planPts}" />
      <polyline fill="none" stroke="#10b981" stroke-width="1.5" stroke-dasharray="5,3" points="${ellipPts}" />
      <polyline fill="none" stroke="#38bdf8" stroke-width="2.4" points="${schrenkPts}" />
      <polyline fill="none" stroke="#f59e0b" stroke-width="2.2" points="${momPts}" />
      <text x="${pad.l + plotW / 2}" y="${H - 8}" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="monospace">Semi-Span Station y (0.0 m Root → ${maxY.toFixed(2)} m Tip)</text>
    </svg>
  `;
}

/**
 * 3. Mass Breakdown Stacked Bar & Table
 */
export function renderMassBreakdownChart(containerEl, sizing, spar) {
  if (!containerEl || !sizing) return;
  const mtow = Number(sizing.mtow_kg || 1);
  const payload = Number(sizing.payload_mass_kg || 0);
  const fuel = Number(sizing.fuel_mass_kg || 0);
  const sparMass = Number(spar?.mass_both_wings_kg ?? sizing.spar_mass_kg ?? 0);
  const otherEmpty = Math.max(0, Number(sizing.empty_mass_kg || 0) - sparMass);

  const items = [
    { label: "Payload (Crew + Pax + Bags)", kg: payload, color: "#38bdf8" },
    { label: "Mission + Reserve Fuel", kg: fuel, color: "#10b981" },
    { label: "Main Wing Spar (Both Wings)", kg: sparMass, color: "#f59e0b" },
    { label: "Other Airframe, Propulsion & Systems", kg: otherEmpty, color: "#6366f1" },
  ];

  const barHtml = items
    .map((it) => {
      const pct = Math.max(1, (it.kg / mtow) * 100);
      return `<div style="width:${pct.toFixed(1)}%;background:${it.color};height:100%" title="${esc(it.label)}: ${it.kg.toFixed(1)} kg (${pct.toFixed(1)}%)"></div>`;
    })
    .join("");

  const rowsHtml = items
    .map((it) => {
      const pct = ((it.kg / mtow) * 100).toFixed(1);
      return `
        <div class="mass-row">
          <span><i class="dot" style="background:${it.color}"></i>${esc(it.label)}</span>
          <span class="mono">${it.kg.toFixed(1)} kg (${pct}%)</span>
        </div>`;
    })
    .join("");

  containerEl.innerHTML = `
    <div class="mass-breakdown-box">
      <div class="mass-stacked-bar">${barHtml}</div>
      <div class="mass-legend-grid">${rowsHtml}</div>
    </div>
  `;
}

/**
 * 4. Detailed FEA vs. Euler-Bernoulli Spanwise Comparison Charts
 */
export function renderFeaComparisonCharts(stressContainerEl, deflectionContainerEl, fea, spar) {
  const st = fea?.stations;
  if (!Array.isArray(st) || st.length === 0) return;

  const W = 520;
  const H = 205;
  const pad = { l: 52, r: 24, t: 26, b: 34 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const maxY = Math.max(...st.map((s) => Number(s.y_m || 0)), 0.1);
  const xAt = (y) => pad.l + (y / maxY) * plotW;

  if (stressContainerEl) {
    const allowMpa = Number(spar?.allowable_yield_stress_pa || 345e6) / 1e6;
    const maxS = Math.max(
      allowMpa * 1.12,
      ...st.map((s) => Math.max(Number(s.fea_von_mises_pa || 0), Number(s.beam_stress_pa || 0)) / 1e6),
      10
    );
    const yS = (mpa) => pad.t + plotH - (mpa / maxS) * plotH;
    const feaPts = st.map((s) => `${xAt(s.y_m).toFixed(1)},${yS(s.fea_von_mises_pa / 1e6).toFixed(1)}`).join(" ");
    const beamPts = st.map((s) => `${xAt(s.y_m).toFixed(1)},${yS(s.beam_stress_pa / 1e6).toFixed(1)}`).join(" ");
    const yAllow = yS(allowMpa);

    stressContainerEl.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="eng-svg">
        <text x="${pad.l}" y="15" fill="#f43f5e" font-size="11" font-family="monospace">━ 3D FEA von Mises (MPa)</text>
        <text x="${W - pad.r}" y="15" text-anchor="end" fill="#38bdf8" font-size="11" font-family="monospace">┄ Euler-Bernoulli (${Number(fea.stress_agreement_pct || 0).toFixed(1)}% agree)</text>
        <line x1="${pad.l}" y1="${yAllow.toFixed(1)}" x2="${W - pad.r}" y2="${yAllow.toFixed(1)}" stroke="#ef4444" stroke-width="1.3" stroke-dasharray="4,3" />
        <text x="${W - pad.r - 4}" y="${(yAllow - 5).toFixed(1)}" text-anchor="end" fill="#ef4444" font-size="9.5" font-family="monospace">σ_yield = ${allowMpa.toFixed(0)} MPa</text>
        <polyline fill="none" stroke="#38bdf8" stroke-width="2" stroke-dasharray="5,3" points="${beamPts}" />
        <polyline fill="none" stroke="#f43f5e" stroke-width="2.4" points="${feaPts}" />
        <text x="${pad.l - 6}" y="${pad.t + 8}" text-anchor="end" fill="#94a3b8" font-size="10" font-family="monospace">${maxS.toFixed(0)}</text>
        <text x="${pad.l - 6}" y="${pad.t + plotH}" text-anchor="end" fill="#94a3b8" font-size="10" font-family="monospace">0</text>
        <text x="${pad.l + plotW / 2}" y="${H - 8}" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="monospace">Semi-Span y (0 → ${maxY.toFixed(2)} m)</text>
      </svg>
    `;
  }

  if (deflectionContainerEl) {
    const maxD = Math.max(
      ...st.map((s) => Math.max(Number(s.fea_deflection_m || 0), Number(s.beam_deflection_m || 0)) * 1000),
      1
    ) * 1.1;
    const yD = (mm) => pad.t + plotH - (mm / maxD) * plotH;
    const feaPts = st.map((s) => `${xAt(s.y_m).toFixed(1)},${yD(s.fea_deflection_m * 1000).toFixed(1)}`).join(" ");
    const beamPts = st.map((s) => `${xAt(s.y_m).toFixed(1)},${yD(s.beam_deflection_m * 1000).toFixed(1)}`).join(" ");

    deflectionContainerEl.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="eng-svg">
        <text x="${pad.l}" y="15" fill="#10b981" font-size="11" font-family="monospace">━ 3D FEA Deflection (mm)</text>
        <text x="${W - pad.r}" y="15" text-anchor="end" fill="#f59e0b" font-size="11" font-family="monospace">┄ Beam Theory (${Number(fea.deflection_agreement_pct || 0).toFixed(1)}% agree)</text>
        <polyline fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="5,3" points="${beamPts}" />
        <polyline fill="none" stroke="#10b981" stroke-width="2.4" points="${feaPts}" />
        <text x="${pad.l - 6}" y="${pad.t + 8}" text-anchor="end" fill="#94a3b8" font-size="10" font-family="monospace">${maxD.toFixed(0)}</text>
        <text x="${pad.l - 6}" y="${pad.t + plotH}" text-anchor="end" fill="#94a3b8" font-size="10" font-family="monospace">0</text>
        <text x="${pad.l + plotW / 2}" y="${H - 8}" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="monospace">Semi-Span y (0 → ${maxY.toFixed(2)} m)</text>
      </svg>
    `;
  }
}
