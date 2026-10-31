/**
 * Spiral 4-Screen Aerospace Design Workbench Controller (Owner: Tharm).
 */

import {
  fetchStressMesh,
  generateReport,
  parseIntake,
  resolveArtifactUrl,
  runSparDetailed,
  runSpiralSync,
  streamSparDetailed,
  streamSpiral,
} from "./api_client.js";
import {
  renderConvergenceChart,
  renderFeaComparisonCharts,
  renderLoadsChart,
  renderMassBreakdownChart,
} from "./charts.js";
import { AircraftScene, SparFeaScene } from "./scene3d.js";

const DEFAULT_SPEC = {
  crew_count: 1,
  passenger_count: 3,
  person_mass_kg: 86.0,
  baggage_mass_kg: 50.0,
  range_m: 1000000.0,
  cruise_speed_ms: 59.1611,
  cruise_altitude_m: 2500.0,
  stall_speed_ms: 28.2944,
  reserve_s: 2700.0,
  aspect_ratio: 7.6,
  taper_ratio: 0.45,
  thickness_to_chord: 0.15,
  cl_max: 1.6,
  ld_max: 11.0,
  prop_efficiency: 0.8,
  bsfc_kg_per_j: 6.8e-8,
  limit_load_factor: 3.8,
  ultimate_factor: 1.5,
  spar_material: "al_2024_t3",
  wing_position: "high",
  name: "GA-4 Touring",
  raw_description:
    "Four-seat touring aircraft, 1,000 km range with 45 min reserve, cruise 115 kt, stall under 55 kt.",
  defaulted_fields: {
    crew_count: "Assumed 1 pilot (single-pilot GA)",
    person_mass_kg: "Assumed 86 kg per occupant",
    baggage_mass_kg: "Assumed 50 kg total baggage",
    cruise_altitude_m: "Assumed 2,500 m (~8,200 ft) cruise altitude",
    aspect_ratio: "Assumed 7.6, typical GA single-engine (Raymer 2ed, Table 4.1 (p. 51))",
    taper_ratio: "Assumed 0.45, near-elliptical lift for an unswept wing (Raymer 2ed, Ch. 4 (p. 56))",
    thickness_to_chord: "Assumed 0.15 root aerofoil thickness (Raymer 2ed, Fig. 4.14 (p. 47): value read from chart trend, not a printed number)",
    cl_max: "Assumed 1.6 with simple flaps deployed",
    ld_max: "Assumed 11, typical fixed-gear GA (Raymer 2ed, Fig. 3.6 (p. 22): value estimated from chart, not a printed number)",
    prop_efficiency: "Assumed 0.80 cruise propeller efficiency",
    bsfc_kg_per_j: "Assumed 6.8e-8 kg/J (0.40 lb/hp/h) piston cruise SFC",
    limit_load_factor: "Assumed +3.8 g limit, CS-23 normal category",
    ultimate_factor: "Assumed 1.5 ultimate factor of safety (CS 23.303)",
    spar_material: "Assumed aluminium 2024-T3, standard spar alloy",
    wing_position: "Assumed high wing (Cessna 172-style touring baseline)",
  },
};

const PRESETS = {
  touring: {
    prompt: "Four-seat touring aircraft, 1,000 km range with 45 min reserve, cruise 115 kt, stall under 55 kt.",
    overrides: { range_m: 1000000.0, spar_material: "al_2024_t3" },
  },
  diverging: {
    prompt: "Four-seat tourer, London to New York non-stop, 5,570 km range, 45 min reserve, cruise 115 kt, stall under 55 kt.",
    overrides: { range_m: 5570000.0, spar_material: "al_2024_t3" },
  },
  high_ar: {
    prompt: "High-aspect-ratio aerial survey aircraft, 1,200 km range, AR 13.5 slender wing, 7075 aluminium spar.",
    overrides: { range_m: 1200000.0, aspect_ratio: 13.5, spar_material: "al_7075_t6" },
  },
};

let currentSpec = structuredClone(DEFAULT_SPEC);
let currentState = null;
let selectedLap = null;
let aircraftScene = null;
let sparFeaScene = null;

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setStatus(text, isBusy = false) {
  const pill = document.getElementById("status-pill");
  if (!pill) return;
  pill.textContent = isBusy ? `◌ ${text}` : `● ${text}`;
  pill.style.color = isBusy ? "#f59e0b" : "#10b981";
}

function provBadge(path) {
  const p = currentState?.provenance?.[path];
  if (!p) {
    const fieldName = path.replace(/^spec\./, "");
    const defReason = currentSpec?.defaulted_fields?.[fieldName];
    if (defReason) {
      return `<span class="prov-badge prov-gemini_default" title="${esc(defReason)}">[AI default]</span>`;
    }
    return `<span class="prov-badge prov-none" title="No provenance attached">[no source]</span>`;
  }
  const labels = {
    user_input: "[user]",
    gemini_default: "[AI default]",
    equation: "[eq]",
    table: "[tbl]",
    simulation: p.verified ? "[sim ✓]" : "[sim]",
    assumption: "[assume]",
  };
  const label = labels[p.kind] || `[${p.kind}]`;
  const tip = `${p.kind.toUpperCase()}: ${p.source}${p.warning ? " | WARNING: " + p.warning : ""}`;
  return `<span class="prov-badge prov-${esc(p.kind)}" title="${esc(tip)}">${esc(label)}</span>`;
}

function switchScreen(screenName) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".screen-tabs button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.screen === screenName);
  });
  const target = document.getElementById(`screen-${screenName}`);
  if (target) target.classList.add("active");

  if (screenName === "workspace") {
    if (!aircraftScene) {
      aircraftScene = new AircraftScene(document.getElementById("viewport-aircraft"));
    }
    aircraftScene.resize();
    renderWorkspace();
  } else if (screenName === "detailed") {
    if (!sparFeaScene) {
      sparFeaScene = new SparFeaScene(document.getElementById("viewport-spar-fea"));
    }
    sparFeaScene.resize();
    renderDetailedView();
  } else if (screenName === "report") {
    renderReportView();
  }
}

/* ---------------- SCREEN 1: INTAKE CARDS ---------------- */
function renderIntakeCards() {
  const container = document.getElementById("intake-cards");
  if (!container) return;
  const s = currentSpec;

  const cards = [
    {
      title: "1. Cabin & Payload",
      fields: [
        { key: "crew_count", label: "Crew Count", val: s.crew_count, step: 1 },
        { key: "passenger_count", label: "Passengers", val: s.passenger_count, step: 1 },
        { key: "person_mass_kg", label: "Person Mass (kg)", val: s.person_mass_kg, step: 1 },
        { key: "baggage_mass_kg", label: "Baggage (kg)", val: s.baggage_mass_kg, step: 5 },
      ],
    },
    {
      title: "2. Mission Performance",
      fields: [
        { key: "range_km", label: "Range (km)", val: (s.range_m / 1000).toFixed(0), step: 50 },
        { key: "cruise_kt", label: "Cruise Speed (kt)", val: (s.cruise_speed_ms / 0.514444).toFixed(0), step: 5 },
        { key: "stall_kt", label: "Stall Speed (kt)", val: (s.stall_speed_ms / 0.514444).toFixed(0), step: 1 },
        { key: "cruise_altitude_m", label: "Cruise Alt (m)", val: s.cruise_altitude_m, step: 100 },
      ],
    },
    {
      title: "3. Wing & Aerodynamics",
      fields: [
        { key: "aspect_ratio", label: "Aspect Ratio (AR)", val: s.aspect_ratio, step: 0.5 },
        { key: "taper_ratio", label: "Taper Ratio (λ)", val: s.taper_ratio, step: 0.05 },
        { key: "thickness_to_chord", label: "Airfoil t/c", val: s.thickness_to_chord, step: 0.01 },
        { key: "ld_max", label: "Cruise (L/D)_max", val: s.ld_max, step: 0.5 },
      ],
    },
    {
      title: "4. Structures & Layout",
      fields: [
        { key: "limit_load_factor", label: "Limit Load (+g)", val: s.limit_load_factor, step: 0.2 },
        { key: "ultimate_factor", label: "Safety Factor", val: s.ultimate_factor, step: 0.1 },
        { key: "spar_material", label: "Spar Material", type: "select", options: ["al_2024_t3", "al_7075_t6"], val: s.spar_material },
        { key: "wing_position", label: "Wing Position", type: "select", options: ["high", "mid", "low"], val: s.wing_position },
      ],
    },
  ];

  container.innerHTML = cards
    .map(
      (c) => `
      <div class="panel">
        <h3>${esc(c.title)}</h3>
        ${c.fields
          .map((f) => {
            const rawKey = f.key === "range_km" ? "range_m" : f.key === "cruise_kt" ? "cruise_speed_ms" : f.key === "stall_kt" ? "stall_speed_ms" : f.key;
            const badge = provBadge(`spec.${rawKey}`);
            if (f.type === "select") {
              const opts = f.options
                .map((o) => `<option value="${o}" ${o === f.val ? "selected" : ""}>${o}</option>`)
                .join("");
              return `<div class="field-row"><span>${esc(f.label)} ${badge}</span><select data-spec-key="${f.key}">${opts}</select></div>`;
            }
            return `<div class="field-row"><span>${esc(f.label)} ${badge}</span><input type="number" step="${f.step}" value="${f.val}" data-spec-key="${f.key}" /></div>`;
          })
          .join("")}
      </div>`
    )
    .join("");

  container.querySelectorAll("[data-spec-key]").forEach((el) => {
    el.addEventListener("change", () => {
      const k = el.dataset.specKey;
      const v = el.tagName === "SELECT" ? el.value : Number(el.value);
      if (k === "range_km") currentSpec.range_m = v * 1000.0;
      else if (k === "cruise_kt") currentSpec.cruise_speed_ms = +(v * 0.514444).toFixed(2);
      else if (k === "stall_kt") currentSpec.stall_speed_ms = +(v * 0.514444).toFixed(2);
      else currentSpec[k] = v;
      if (currentSpec.defaulted_fields) delete currentSpec.defaulted_fields[k];
      syncSlidersFromSpec();
    });
  });
}

function syncSlidersFromSpec() {
  const s = currentSpec;
  const rKm = Math.round((s.range_m || 1000000) / 1000);
  const cKt = Math.round((s.cruise_speed_ms || 59.16) / 0.514444);
  const slRange = document.getElementById("sl-range");
  const slAr = document.getElementById("sl-ar");
  const slCruise = document.getElementById("sl-cruise");
  if (slRange) slRange.value = rKm;
  if (slAr) slAr.value = s.aspect_ratio;
  if (slCruise) slCruise.value = cKt;
  const lblR = document.getElementById("lbl-range");
  const lblAr = document.getElementById("lbl-ar");
  const lblC = document.getElementById("lbl-cruise");
  if (lblR) lblR.textContent = `${rKm} km`;
  if (lblAr) lblAr.textContent = Number(s.aspect_ratio).toFixed(1);
  if (lblC) lblC.textContent = `${cKt} kt`;
  const selMat = document.getElementById("sel-material");
  const selPos = document.getElementById("sel-wing-pos");
  if (selMat) selMat.value = s.spar_material;
  if (selPos) selPos.value = s.wing_position;
}

/* ---------------- SCREEN 2: WORKSPACE ---------------- */
function renderWorkspace() {
  if (!currentState) return;
  const hist = currentState.history || [];
  const activeRec =
    hist.find((h) => h.lap === selectedLap) || hist[hist.length - 1] || null;
  const sizing = currentState.latest_sizing || {};
  const spar = currentState.latest_spar || {};
  const loads = currentState.latest_loads || {};
  const geom = activeRec?.geometry || currentState.latest_geometry;

  // Infeasible Banner
  const banner = document.getElementById("infeasible-banner");
  if (banner) {
    if (currentState.infeasible_reason) {
      banner.classList.remove("hidden");
      document.getElementById("infeasible-reason").textContent = currentState.infeasible_reason;
      const rel = currentState.proposed_relaxation;
      document.getElementById("infeasible-proposal").textContent = rel
        ? `Gemini Proposed Relaxation: ${rel.parameter_path} (${rel.current_value} → ${rel.proposed_value}) — ${rel.reason}`
        : "";
    } else {
      banner.classList.add("hidden");
    }
  }

  // KPI Strip with Provenance Badges
  const mtowVal = activeRec ? activeRec.mtow_kg : sizing.mtow_kg;
  const areaVal = activeRec ? activeRec.wing_area_m2 : sizing.wing_area_m2;
  const spanVal = activeRec ? activeRec.span_m : sizing.span_m;
  const sparVal = activeRec ? activeRec.spar_mass_kg : spar.mass_both_wings_kg;
  const kpiEl = document.getElementById("workspace-kpis");
  if (kpiEl) {
    kpiEl.innerHTML = [
      { label: "MTOW", val: `${Number(mtowVal || 0).toFixed(1)} kg`, prov: "latest_sizing.mtow_kg" },
      { label: "Wing Area", val: `${Number(areaVal || 0).toFixed(2)} m²`, prov: "latest_sizing.wing_area_m2" },
      { label: "Wingspan", val: `${Number(spanVal || 0).toFixed(2)} m`, prov: "latest_sizing.span_m" },
      { label: "Main Spar Mass", val: `${Number(sparVal || 0).toFixed(1)} kg`, prov: "latest_spar.mass_both_wings_kg" },
      { label: "Safety Margin", val: `${Number(spar.safety_margin || 0) >= 0 ? "+" : ""}${Number(spar.safety_margin || 0).toFixed(2)}`, prov: "latest_spar.safety_margin" },
      { label: "Cruise Power", val: `${(Number(sizing.cruise_power_w || 0) / 1000).toFixed(1)} kW`, prov: "latest_sizing.cruise_power_w" },
    ]
      .map(
        (k) => `
        <div class="kpi-card">
          <div class="kpi-label"><span>${esc(k.label)}</span>${provBadge(k.prov)}</div>
          <div class="kpi-val">${esc(k.val)}</div>
        </div>`
      )
      .join("");
  }

  // Lap Pills
  const pillsEl = document.getElementById("lap-pills");
  if (pillsEl) {
    const curLap = activeRec ? activeRec.lap : 0;
    pillsEl.innerHTML = hist
      .map(
        (h) =>
          `<button class="lap-pill ${h.lap === curLap ? "active" : ""}" data-lap="${h.lap}">Lap ${h.lap} (${h.mtow_kg.toFixed(0)} kg)</button>`
      )
      .join("");
    pillsEl.querySelectorAll(".lap-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedLap = Number(btn.dataset.lap);
        renderWorkspace();
      });
    });
  }

  // 3D Aircraft Scene
  if (aircraftScene && geom) {
    aircraftScene.updateAircraft(geom, loads, spar);
  }

  // Charts
  renderConvergenceChart(
    document.getElementById("chart-convergence"),
    hist,
    activeRec ? activeRec.lap : null,
    (lapIdx) => {
      selectedLap = lapIdx;
      renderWorkspace();
    }
  );
  renderLoadsChart(document.getElementById("chart-loads"), loads);
  renderMassBreakdownChart(document.getElementById("chart-mass"), sizing, spar);

  // Component Tree (§4.3)
  const treeEl = document.getElementById("component-tree");
  if (treeEl && currentState.components) {
    treeEl.innerHTML = Object.values(currentState.components)
      .map((c) => {
        if (c.available) {
          return `<div class="comp-item active-comp" id="comp-main-spar">
            <span><strong>${esc(c.name)}</strong></span>
            <span class="prov-badge prov-simulation">${esc(c.status)} →</span>
          </div>`;
        }
        return `<div class="comp-item disabled-comp">
          <span>${esc(c.name)}</span>
          <span class="prov-badge prov-none">Coming Soon</span>
        </div>`;
      })
      .join("");
    document.getElementById("comp-main-spar")?.addEventListener("click", () => {
      switchScreen("detailed");
      startDetailedSparStream();
    });
  }

  // Agent Log & Warnings
  const badge = document.getElementById("lap-badge");
  if (badge) badge.textContent = currentState.converged ? `Converged · Lap ${currentState.lap}` : `Lap ${currentState.lap}`;
  const logEl = document.getElementById("agent-log-list");
  if (logEl) {
    logEl.innerHTML = (currentState.log || [])
      .map(
        (e) => `
        <div class="log-entry level-${esc(e.level || "info")}">
          <div><strong>[Lap ${e.lap} · ${esc(e.stage)}]</strong> ${esc(e.message)}</div>
          <div class="cite-chips">${(e.citations || []).slice(0, 4).map((c) => `<span class="cite-chip">${esc(c)}</span>`).join("")}</div>
        </div>`
      )
      .join("");
    logEl.scrollTop = logEl.scrollHeight;
  }
  const warnEl = document.getElementById("warnings-box");
  if (warnEl) {
    warnEl.innerHTML = (currentState.warnings || []).map((w) => `<div>⚠ ${esc(w)}</div>`).join("");
  }
}

async function startSpiralStream() {
  setStatus("Streaming Design Spiral...", true);
  selectedLap = null;
  currentState = {
    spec: currentSpec,
    lap: 0,
    history: [],
    log: [],
    warnings: [],
    sources: [],
    assumptions: [],
    provenance: {},
    components: {},
  };
  switchScreen("workspace");

  try {
    await streamSpiral(currentSpec, {
      onLog: (entry) => {
        currentState.log.push(entry);
        renderWorkspace();
      },
      onLap: (ev) => {
        currentState.lap = ev.lap_record.lap;
        currentState.history.push(ev.lap_record);
        currentState.latest_sizing = ev.sizing;
        currentState.latest_loads = ev.loads;
        currentState.latest_spar = ev.spar;
        currentState.latest_geometry = ev.geometry;
        selectedLap = ev.lap_record.lap;
        renderWorkspace();
      },
      onConverged: (state) => {
        currentState = state;
        selectedLap = state.lap;
        setStatus(`Converged on Lap ${state.lap}`, false);
        renderWorkspace();
      },
      onInfeasible: (ev) => {
        if (ev.state) currentState = ev.state;
        currentState.infeasible_reason = ev.reason;
        currentState.proposed_relaxation = ev.proposed_relaxation;
        setStatus("Spiral Diverged — Relaxation Proposed", false);
        renderWorkspace();
      },
    });
  } catch (err) {
    console.warn("Stream fallback to sync:", err);
    currentState = await runSpiralSync(currentSpec);
    setStatus("Spiral Complete", false);
    renderWorkspace();
  }
}

/* ---------------- SCREEN 3: DETAILED SPAR CAD & FEA ---------------- */
async function renderDetailedView() {
  if (!currentState) return;
  const comp = currentState.components?.main_wing_spar || {};
  const cad = comp.cad;
  const fea = comp.fea;
  const spar = currentState.latest_spar || {};

  // Update download links using ComponentStatus.artifact_urls (§8.5)
  const urls = comp.artifact_urls || {};
  const dlStep = document.getElementById("dl-step");
  const dlStl = document.getElementById("dl-stl");
  const dlMesh = document.getElementById("dl-mesh");
  if (dlStep && urls.step) dlStep.href = resolveArtifactUrl(urls.step);
  if (dlStl && urls.stl) dlStl.href = resolveArtifactUrl(urls.stl);
  if (dlMesh && urls.stress_mesh) dlMesh.href = resolveArtifactUrl(urls.stress_mesh);

  const kpiEl = document.getElementById("detailed-kpis");
  if (kpiEl) {
    kpiEl.innerHTML = [
      { label: "FEA Peak von Mises", val: fea ? `${(fea.fea_max_von_mises_pa / 1e6).toFixed(1)} MPa` : "—", prov: "components.main_wing_spar.fea.fea_max_von_mises_pa" },
      { label: "Beam Theory Stress", val: fea ? `${(fea.beam_max_stress_pa / 1e6).toFixed(1)} MPa` : "—", prov: "components.main_wing_spar.fea.beam_max_stress_pa" },
      { label: "Stress Agreement", val: fea ? `${fea.stress_agreement_pct.toFixed(1)}%` : "—", prov: "components.main_wing_spar.fea.stress_agreement_pct" },
      { label: "FEA Tip Deflection", val: fea ? `${(fea.fea_tip_deflection_m * 1000).toFixed(1)} mm` : "—", prov: "components.main_wing_spar.fea.fea_tip_deflection_m" },
      { label: "Deflection Agreement", val: fea ? `${fea.deflection_agreement_pct.toFixed(1)}%` : "—", prov: "components.main_wing_spar.fea.deflection_agreement_pct" },
      { label: "CAD Spar Mass (2x)", val: cad ? `${cad.cad_mass_both_wings_kg.toFixed(2)} kg` : "—", prov: "components.main_wing_spar.cad.cad_mass_both_wings_kg" },
    ]
      .map(
        (k) => `
        <div class="kpi-card">
          <div class="kpi-label"><span>${esc(k.label)}</span>${provBadge(k.prov)}</div>
          <div class="kpi-val">${esc(k.val)}</div>
        </div>`
      )
      .join("");
  }

  let stressMesh = null;
  if (urls.stress_mesh) {
    try {
      stressMesh = await fetchStressMesh(urls.stress_mesh);
    } catch {
      stressMesh = null;
    }
  }

  if (sparFeaScene) {
    sparFeaScene.updateSparMesh({ spar, fea, stressMesh });
  }
  if (fea) {
    renderFeaComparisonCharts(
      document.getElementById("chart-fea-stress"),
      document.getElementById("chart-fea-deflection"),
      fea,
      spar
    );
  }

  // Tapered I-Beam Stations Table
  const tblEl = document.getElementById("spar-stations-table");
  if (tblEl && Array.isArray(spar.stations)) {
    const rows = spar.stations
      .filter((_, i, arr) => i % 3 === 0 || i === arr.length - 1)
      .map(
        (s) => `
        <tr>
          <td>${s.y_m.toFixed(2)} m</td>
          <td>${(s.depth_m * 1000).toFixed(1)} mm</td>
          <td>${(s.cap_width_m * 1000).toFixed(1)} mm</td>
          <td>${(s.cap_thickness_m * 1000).toFixed(2)} mm</td>
          <td>${(s.web_thickness_m * 1000).toFixed(2)} mm</td>
          <td>${(s.bending_stress_pa / 1e6).toFixed(1)} MPa</td>
        </tr>`
      )
      .join("");
    tblEl.innerHTML = `
      <table class="eng-table">
        <thead><tr><th>Station y</th><th>Depth h</th><th>Cap b_f</th><th>Cap t_f</th><th>Web t_w</th><th>σ_beam</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }
}

async function startDetailedSparStream() {
  if (!currentState) return;
  setStatus("Streaming Spar CAD + 3D FEA...", true);
  const sCad = document.getElementById("step-cad");
  const sFea = document.getElementById("step-fea");
  const sVer = document.getElementById("step-verify");
  [sCad, sFea, sVer].forEach((el) => el?.classList.remove("running", "done"));

  try {
    await streamSparDetailed(currentState, {
      onStep: (ev) => {
        const el = ev.step === "cad" ? sCad : sFea;
        if (el) {
          el.classList.toggle("running", ev.status === "running");
          el.classList.toggle("done", ev.status === "done");
        }
      },
      onLog: (entry) => {
        currentState.log = currentState.log || [];
        currentState.log.push(entry);
      },
      onDone: (ev) => {
        currentState = ev.state;
        sCad?.classList.add("done");
        sFea?.classList.add("done");
        sVer?.classList.add("done");
        setStatus("Detailed CAD & FEA Verified", false);
        renderDetailedView();
      },
    });
  } catch (err) {
    console.warn("Detailed stream fallback to sync:", err);
    currentState = await runSparDetailed(currentState);
    [sCad, sFea, sVer].forEach((el) => el?.classList.add("done"));
    setStatus("Detailed CAD & FEA Complete", false);
    renderDetailedView();
  }
}

/* ---------------- SCREEN 4: REPORT & PROVENANCE LEDGER ---------------- */
function mdToHtml(md) {
  if (!md) return "<p class='muted'>Click 'Generate / Refresh Full Report' to synthesize the traceable engineering report.</p>";
  return esc(md)
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^- (.*)$/gm, "• $1<br/>")
    .replace(/\n\n/g, "<br/><br/>");
}

function renderReportView() {
  if (!currentState) return;
  document.getElementById("report-markdown").innerHTML = mdToHtml(currentState.report_markdown);

  const provEntries = Object.entries(currentState.provenance || {});
  const countEl = document.getElementById("prov-count");
  if (countEl) countEl.textContent = provEntries.length;

  const provEl = document.getElementById("provenance-ledger");
  if (provEl) {
    provEl.innerHTML = provEntries
      .map(
        ([k, p]) => `
        <div class="prov-row">
          <span class="mono">${esc(k)}</span>
          <span>${provBadge(k)} <span class="muted">${esc(p.source)}</span></span>
        </div>`
      )
      .join("");
  }

  const srcEl = document.getElementById("sources-ledger");
  if (srcEl) {
    const srcs = (currentState.sources || []).map((s) => `<div>📘 ${esc(s)}</div>`).join("");
    const asms = (currentState.assumptions || []).map((a) => `<div>⚙ ${esc(a)}</div>`).join("");
    const wrns = (currentState.warnings || []).map((w) => `<div style="color:#fcd34d">⚠ ${esc(w)}</div>`).join("");
    srcEl.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:0.35rem;font-size:0.8rem">
        <strong>Cited Equations &amp; Tables</strong>${srcs}
        <strong style="margin-top:0.5rem">Engineering Assumptions</strong>${asms}
        ${wrns ? `<strong style="margin-top:0.5rem">Heuristic Range Warnings</strong>${wrns}` : ""}
      </div>`;
  }
}

/* ---------------- WIRE UP EVENT LISTENERS & INITIAL BOOT ---------------- */
document.querySelectorAll(".screen-tabs button").forEach((btn) => {
  btn.addEventListener("click", () => switchScreen(btn.dataset.screen));
});

document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const p = PRESETS[btn.dataset.preset];
    if (!p) return;
    document.getElementById("prompt-input").value = p.prompt;
    currentSpec = { ...structuredClone(DEFAULT_SPEC), ...p.overrides, raw_description: p.prompt };
    renderIntakeCards();
    syncSlidersFromSpec();
  });
});

document.getElementById("btn-parse")?.addEventListener("click", async () => {
  setStatus("Parsing Mission with Gemini...", true);
  try {
    const desc = document.getElementById("prompt-input").value;
    const res = await parseIntake(desc);
    currentSpec = res.spec;
    renderIntakeCards();
    syncSlidersFromSpec();
    setStatus("Spec Parsed", false);
  } catch (err) {
    setStatus("Spec Ready (Local)", false);
  }
});

document.getElementById("btn-run-spiral")?.addEventListener("click", () => startSpiralStream());

document.getElementById("btn-rerun-sliders")?.addEventListener("click", () => {
  currentSpec.range_m = Number(document.getElementById("sl-range").value) * 1000.0;
  currentSpec.aspect_ratio = Number(document.getElementById("sl-ar").value);
  currentSpec.cruise_speed_ms = +(Number(document.getElementById("sl-cruise").value) * 0.514444).toFixed(2);
  currentSpec.spar_material = document.getElementById("sel-material").value;
  currentSpec.wing_position = document.getElementById("sel-wing-pos").value;
  renderIntakeCards();
  startSpiralStream();
});

["sl-range", "sl-ar", "sl-cruise"].forEach((id) => {
  document.getElementById(id)?.addEventListener("input", () => {
    document.getElementById("lbl-range").textContent = `${document.getElementById("sl-range").value} km`;
    document.getElementById("lbl-ar").textContent = Number(document.getElementById("sl-ar").value).toFixed(1);
    document.getElementById("lbl-cruise").textContent = `${document.getElementById("sl-cruise").value} kt`;
  });
});

document.getElementById("btn-accept-relaxation")?.addEventListener("click", () => {
  const rel = currentState?.proposed_relaxation;
  if (rel) {
    const key = rel.parameter_path.replace(/^spec\./, "");
    currentSpec[key] = Number(rel.proposed_value);
  } else {
    currentSpec.range_m = 1200000.0;
  }
  renderIntakeCards();
  syncSlidersFromSpec();
  startSpiralStream();
});

document.querySelectorAll(".vp-btn").forEach((b) => {
  b.addEventListener("click", () => aircraftScene?.setViewPreset(b.dataset.cam));
});
document.getElementById("chk-lift-curtain")?.addEventListener("change", (e) => {
  aircraftScene?.setShowLiftCurtain(e.target.checked);
});
document.getElementById("sl-wing-opacity")?.addEventListener("input", (e) => {
  aircraftScene?.setWingOpacity(Number(e.target.value));
});

document.querySelectorAll(".chart-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".chart-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".chart-pane").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`chart-${tab.dataset.chart}`)?.classList.add("active");
  });
});

document.getElementById("btn-goto-detailed")?.addEventListener("click", () => {
  switchScreen("detailed");
  startDetailedSparStream();
});
document.getElementById("btn-run-fea")?.addEventListener("click", () => startDetailedSparStream());

document.querySelectorAll(".vp-btn-fea").forEach((b) => {
  b.addEventListener("click", () => sparFeaScene?.setViewPreset(b.dataset.cam));
});
document.getElementById("chk-fea-wire")?.addEventListener("change", (e) => {
  sparFeaScene?.setShowWireframe(e.target.checked);
});
document.getElementById("sl-defl-scale")?.addEventListener("input", (e) => {
  const v = Number(e.target.value);
  document.getElementById("lbl-defl-scale").textContent = `${v.toFixed(1)}x`;
  sparFeaScene?.setDeflectionScale(v);
});

document.getElementById("btn-generate-report")?.addEventListener("click", async () => {
  if (!currentState) return;
  setStatus("Generating Engineering Report...", true);
  const res = await generateReport(currentState);
  currentState = res.state || currentState;
  currentState.report_markdown = res.report_markdown;
  setStatus("Report Ready", false);
  renderReportView();
});

// Boot: render intake cards & pre-populate baseline state in background
renderIntakeCards();
syncSlidersFromSpec();
runSpiralSync(currentSpec)
  .then((st) => {
    currentState = st;
    selectedLap = st.lap;
    return runSparDetailed(st);
  })
  .then((stDetailed) => {
    currentState = stDetailed;
    setStatus(`Ready · Baseline Converged (${stDetailed.latest_sizing.mtow_kg.toFixed(0)} kg)`, false);
  })
  .catch(() => {});
