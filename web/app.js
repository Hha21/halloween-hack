/**
 * Spiral 4-Screen Aerospace Design Workbench Controller (Owner: Tharm).
 */

import {
  fetchStressMesh,
  generateReport,
  parseIntake,
  resolveArtifactUrl,
  runComponentDetailed,
  runSparDetailed,
  runSpiralSync,
  streamComponentDetailed,
  streamSpiral,
} from "./api_client.js";
import {
  renderConvergenceChart,
  renderFeaComparisonCharts,
  renderLoadsChart,
  renderMassBreakdownChart,
} from "./charts.js";
import { AircraftScene, SparFeaScene } from "./scene3d.js";
import { FEA_COMPONENTS } from "./fea3d.js";
import { initIntake, renderIntakeCards } from "./intake.js"; // Screen 1: owned by Harry (web/intake.js)

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
let selectedComponent = "main_wing_spar";

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
      return `<span class="prov-badge prov-cited" title="${esc(defReason)}">cited default</span>`;
    }
    return `<span class="prov-badge prov-none" title="No provenance attached">no source</span>`;
  }
  const labels = {
    user_input: "user",
    gemini_default: "Gemini inferred",
    equation: "eq",
    table: "tbl",
    simulation: "sim",
    assumption: "assume",
  };
  const label = labels[p.kind] || p.kind;
  const tip = `${p.kind.toUpperCase()}: ${p.source}${p.warning ? " | WARNING: " + p.warning : ""}`;
  const verifiedCls = p.verified ? " prov-verified" : "";
  return `<span class="prov-badge prov-${esc(p.kind)}${verifiedCls}" title="${esc(tip)}">${esc(label)}</span>`;
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
      sparFeaScene.onSelect = (id) => selectPart(id);
    }
    sparFeaScene.resize();
    renderDetailedView();
  } else if (screenName === "report") {
    renderReportView();
  }
}

/* ---------------- SCREEN 1: INTAKE CARDS ---------------- */
// renderIntakeCards() moved to web/intake.js (Screen 1, Harry).

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
      if (rel) {
        const fmtVal = (val, u) => {
          if (u === "m") return `${Math.round(val / 1000).toLocaleString()} km`;
          if (u === "-" || !u) return `${Math.round(val)}`;
          return `${val} ${u}`;
        };
        const oldStr = fmtVal(rel.old_value, rel.unit);
        const newStr = fmtVal(rel.new_value, rel.unit);
        const mtowStr = rel.estimated_mtow_kg ? ` (closes at ${Math.round(rel.estimated_mtow_kg).toLocaleString()} kg)` : "";
        document.getElementById("infeasible-proposal").textContent =
          `Gemini proposes: ${rel.field_name} ${oldStr} → ${newStr}${mtowStr} — ${rel.reasoning}`;
      } else {
        document.getElementById("infeasible-proposal").textContent = "";
      }
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
      { label: "Spar margin (beam)", val: `${Number(spar.safety_margin || 0) >= 0 ? "+" : ""}${Number(spar.safety_margin || 0).toFixed(2)}`, prov: "latest_spar.safety_margin" },
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

  // Component tree: the six analysed parts; each opens on Screen 3 and runs its analysis if needed
  renderPartList(document.getElementById("component-tree"));

  renderFidelityLadder();

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

/* Fidelity ladder: steps reached so far are done, the newest one is live while streaming. */
const LADDER = ["conceptual", "preliminary", "convergence", "detailed"];
let spiralStreaming = false;

function renderFidelityLadder() {
  const items = document.querySelectorAll("#stage-list li[data-stage]");
  if (!items.length || !currentState) return;
  const seen = new Set((currentState.log || []).map((e) => e.stage));
  const spar = currentState.components?.main_wing_spar;
  let reached = -1;
  LADDER.forEach((s, i) => { if (seen.has(s)) reached = Math.max(reached, i); });
  if (currentState.converged || currentState.infeasible_reason) reached = Math.max(reached, 2);
  if (spar?.status === "completed") reached = 3;
  const detailRunning = spar && ["running_cad", "running_fea"].includes(spar.status);

  items.forEach((li) => {
    const i = LADDER.indexOf(li.dataset.stage);
    let state = "pending";
    if (i < reached) state = "done";
    else if (i === reached) state = spiralStreaming || (i === 3 && detailRunning) ? "active" : "done";
    if (i === 2 && currentState.infeasible_reason) state = "failed";
    li.classList.remove("active", "done", "failed", "pending");
    li.classList.add(state);

    let note = "";
    if (i === 2 && reached >= 2) {
      note = currentState.infeasible_reason ? `infeasible after lap ${currentState.lap}` : currentState.converged ? `converged on lap ${currentState.lap}` : `lap ${currentState.lap}`;
    }
    if (i === 3) note = spar?.status === "completed" ? "CAD + FEA done" : detailRunning ? "running…" : "click to run →";
    let noteEl = li.querySelector(".stage-note");
    if (!noteEl) {
      noteEl = document.createElement("em");
      noteEl.className = "stage-note";
      li.appendChild(noteEl);
    }
    noteEl.textContent = note;
  });
}

document.querySelector('#stage-list li[data-stage="detailed"]')?.addEventListener("click", () => {
  if (!currentState?.latest_spar) return;
  switchScreen("detailed");
  if (currentState.components?.main_wing_spar?.status !== "completed") startDetailedSparStream();
});

async function startSpiralStream() {
  setStatus("Streaming Design Spiral...", true);
  spiralStreaming = true;
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
  } finally {
    spiralStreaming = false;
    renderWorkspace();
  }
}

/* ---------------- SCREEN 3: DETAILED COMPONENT DESIGN ---------------- */
// Each part is solved by one run: the main spar run (spar, wing box, ring frames, engine mount), the tail run
// (Raymer load case -> spar sizing -> CAD -> FEA) or the gear run (Raymer oleo sizing -> FEA of the strut).
const RUN_OF = Object.fromEntries(FEA_COMPONENTS.map((c) => [c.id, c.run]));
const COMPONENT_VIEWS = {
  main_wing_spar: { steps: ["cad", "fea"], resultKey: null },
  horizontal_tail: { steps: ["loads", "cad", "fea"], resultKey: "horizontal_tail" },
  main_landing_gear: { steps: ["loads", "fea"], resultKey: "landing_gear" },
};
const meshCache = new Map(); // stress-mesh JSON by URL, cleared whenever a run finishes

function partSolved(id) {
  return currentState?.components?.[RUN_OF[id]]?.status === "completed";
}

function renderPartList(el) {
  if (!el || !currentState) return;
  el.innerHTML = FEA_COMPONENTS.map(
    (c) => `<div class="comp-item active-comp" data-comp="${c.id}" title="${esc(c.name)}">
        <span><strong>${esc(c.short)}</strong></span>
        <span class="prov-badge prov-simulation">${partSolved(c.id) ? "solved" : "run"} →</span>
      </div>`
  ).join("");
  el.querySelectorAll("[data-comp]").forEach((item) =>
    item.addEventListener("click", () => {
      switchScreen("detailed");
      selectPart(item.dataset.comp);
    })
  );
}

/** Show one part on Screen 3, running the analysis that solves it if it has not run yet. */
function selectPart(id) {
  if (!RUN_OF[id]) return;
  selectedComponent = id;
  sparFeaScene?.selectComponent(id);
  renderDetailedView();
  if (currentState?.latest_spar && !partSolved(id)) startDetailedComponentStream(RUN_OF[id]);
}

function setFloatingPanel(el, visible) {
  if (!el) return;
  el.classList.remove("hidden");
  (el.closest(".ws-panel") || el).classList.toggle("off", !visible);
  if (!el.closest(".ws-panel")) el.classList.toggle("hidden", !visible);
}

function kpiCards(items) {
  return items
    .map(
      (k) => `
        <div class="kpi-card">
          <div class="kpi-label"><span>${esc(k.label)}</span>${provBadge(k.prov)}</div>
          <div class="kpi-val">${esc(k.val)}</div>
        </div>`
    )
    .join("");
}

function fmt(v, scale, digits, unit) {
  return typeof v === "number" ? `${(v * scale).toFixed(digits)} ${unit}`.trim() : "—";
}

function renderDetailedPipeline(run) {
  const view = COMPONENT_VIEWS[run];
  const verify = "3. Gemini gauge proposals, solver-verified";
  const labels = {
    main_wing_spar: { cad: "1. Spar CAD loft (STEP AP214, STL)", fea: "2. Fine-mesh FEA: spar, wing box, frames, engine mount", verify },
    horizontal_tail: {
      loads: "0. Tail load case (Raymer Eqs. 14.12-14.13, p. 347)",
      cad: "1. Tail spar sizing and CAD (STEP, STL)",
      fea: "2. Fine-mesh FEA of the tail spar",
      verify,
    },
    main_landing_gear: { loads: "1. Oleo strut sizing (Raymer Ch. 11)", fea: "2. FEA of the oleo cylinder (pressure + column)", verify },
  }[run];
  const pills = { loads: "step-loads", cad: "step-cad", fea: "step-fea", verify: "step-verify" };
  for (const [step, pillId] of Object.entries(pills)) {
    const el = document.getElementById(pillId);
    if (!el) continue;
    el.classList.toggle("hidden", step !== "verify" && !view.steps.includes(step));
    if (labels[step]) el.textContent = labels[step];
  }
  const btn = document.getElementById("btn-run-fea");
  const btnText = { main_wing_spar: "▶ Run CAD + FEA", horizontal_tail: "▶ Run tail loads, CAD + FEA", main_landing_gear: "▶ Run gear sizing + FEA" };
  if (btn) btn.textContent = btnText[run];
  const part = run === "horizontal_tail" ? "Tail spar" : "Spar";
  const dlText = { "dl-step": `⬇ ${part} STEP`, "dl-stl": `⬇ ${part} STL`, "dl-mesh": "⬇ Stress field JSON" };
  for (const [elId, text] of Object.entries(dlText)) {
    const el = document.getElementById(elId);
    if (el) el.textContent = text;
  }
}

/** Cited tail load case / oleo sizing next to the 3D view: the FEA of those parts uses these inputs. */
function renderSizingResults(analysisEl, run, comp, base) {
  if (!analysisEl) return;
  const key = COMPONENT_VIEWS[run].resultKey;
  const res = key ? comp[key] : null;
  setFloatingPanel(analysisEl, Boolean(key));
  if (!key) return;
  const p = `${base}.${key}`;
  const rows =
    run === "horizontal_tail"
      ? res && [
          ["Manoeuvre speed V_p", fmt(res.maneuver_speed_ms, 1, 1, "m/s"), "maneuver_speed_ms"],
          ["Tail C_n (down)", res.normal_force_coefficient.toFixed(2), "normal_force_coefficient"],
          ["Ultimate tail load", fmt(res.ultimate_tail_load_n, 1e-3, 2, "kN"), "ultimate_tail_load_n"],
          ["Stall speed V_s", fmt(res.stall_speed_ms, 1, 1, "m/s"), "stall_speed_ms"],
          ["Level speed V_L", fmt(res.level_speed_ms, 1, 1, "m/s"), "level_speed_ms"],
          ["K_p", res.kp.toFixed(3), "kp"],
          ["Dynamic pressure q", fmt(res.dynamic_pressure_pa, 1, 0, "Pa"), "dynamic_pressure_pa"],
          ["Tail area S_HT", fmt(res.tail_area_m2, 1, 2, "m²"), "tail_area_m2"],
          ["Tail t/c", res.thickness_to_chord.toFixed(2), "thickness_to_chord"],
          ["Limit tail load", fmt(res.limit_tail_load_n, 1e-3, 2, "kN"), "limit_tail_load_n"],
          ["Root moment (ultimate)", fmt(res.loads.root_moment_nm, 1, 0, "N·m"), "loads.root_moment_nm"],
          ["Sized spar margin (beam)", res.spar.safety_margin.toFixed(2), "spar.safety_margin"],
          ["Spar mass (both halves)", fmt(res.spar.mass_both_wings_kg, 1, 2, "kg"), "spar.mass_both_wings_kg"],
        ]
      : res && [
          ["Landing load per strut", fmt(res.landing_load_per_strut_n, 1e-3, 2, "kN"), "landing_load_per_strut_n"],
          ["Static load per strut", fmt(res.static_load_per_strut_n, 1e-3, 2, "kN"), "static_load_per_strut_n"],
          ["Gear load factor N_gear", `${res.gear_load_factor}`, "gear_load_factor"],
          ["Stroke (with margin)", fmt(res.stroke_m, 1000, 0, "mm"), "stroke_m"],
          ["Oleo length", fmt(res.oleo_length_m, 1000, 0, "mm"), "oleo_length_m"],
          ["Oleo diameter", fmt(res.oleo_diameter_m, 1000, 1, "mm"), "oleo_diameter_m"],
          ["Oleo internal pressure", fmt(res.oleo_internal_pressure_pa, 1e-6, 1, "MPa"), "oleo_internal_pressure_pa"],
          ["Landing mass", fmt(res.landing_mass_kg, 1, 0, "kg"), "landing_mass_kg"],
          ["Sink speed", fmt(res.sink_speed_ms, 1, 2, "m/s"), "sink_speed_ms"],
          ["Shock-absorber efficiency η", `${res.shock_efficiency}`, "shock_efficiency"],
          ["Main-gear load share", fmt(res.main_gear_load_share, 100, 0, "%"), "main_gear_load_share"],
          ["Main struts", `${res.main_strut_count}`, "main_strut_count"],
          ["Vertical kinetic energy", fmt(res.vertical_kinetic_energy_j, 1e-3, 2, "kJ"), "vertical_kinetic_energy_j"],
          ["Stroke, Eq. 11.12", fmt(res.stroke_required_m, 1000, 0, "mm"), "stroke_required_m"],
        ];
  const head = run === "horizontal_tail" ? "Load case" : "Quantity";
  const note =
    run === "horizontal_tail"
      ? "The tail spar FEA in the 3D view uses this load case and the Table 4.3 planform."
      : "The oleo cylinder FEA in the 3D view uses this bore, length, landing load and pressure. Spin-up, braking and side loads are not analysed.";
  analysisEl.innerHTML = rows
    ? `<table class="eng-table"><thead><tr><th>${head}</th><th>Value</th><th>Source</th></tr></thead><tbody>
        ${rows.map(([l, v, k]) => `<tr><td>${esc(l)}</td><td>${esc(v)}</td><td>${provBadge(`${p}.${k}`)} <span class="muted">${esc(currentState.provenance?.[`${p}.${k}`]?.source || "")}</span></td></tr>`).join("")}
      </tbody></table><p class="analysis-note">${esc(note)}</p>`
    : `<p class='muted'>Run the ${run === "horizontal_tail" ? "tail load case" : "gear sizing"} to see the cited inputs.</p>`;
}

async function fetchMeshCached(url) {
  if (!meshCache.has(url)) meshCache.set(url, fetchStressMesh(url).catch(() => null));
  return meshCache.get(url);
}

async function renderDetailedView() {
  if (!currentState) return;
  const id = RUN_OF[selectedComponent] ? selectedComponent : "main_wing_spar";
  const run = RUN_OF[id];
  const comp = currentState.components?.[run] || {};
  const base = `components.${run}`;
  renderDetailedPipeline(run);
  publishMainSparSummary();
  const screenEl = document.getElementById("screen-detailed");
  if (screenEl) screenEl.dataset.compKind = "fea";

  // Download links from ComponentStatus.artifact_urls (§8.5)
  const urls = comp.artifact_urls || {};
  const dl = { "dl-step": urls.step, "dl-stl": urls.stl, "dl-mesh": urls.stress_mesh };
  for (const [elId, url] of Object.entries(dl)) {
    const el = document.getElementById(elId);
    if (el) {
      el.classList.toggle("hidden", !url);
      if (url) el.href = resolveArtifactUrl(url);
    }
  }
  renderSizingResults(document.getElementById("detailed-analysis"), run, comp, base);

  // Stress fields from every run that has finished, merged so the viewer can show any part
  const runs = Object.keys(COMPONENT_VIEWS);
  const meshes = await Promise.all(
    runs.map((r) => {
      const url = currentState.components?.[r]?.artifact_urls?.stress_mesh;
      return url ? fetchMeshCached(url) : null;
    })
  );
  const parts = Object.assign({}, ...meshes.map((m) => m?.components_fea || {}));
  const first = meshes[runs.indexOf(run)] || meshes.find(Boolean);
  const stressMesh = first ? { ...first, components_fea: Object.keys(parts).length ? parts : undefined } : null;
  const fea = comp.fea;
  const spar = (run === "horizontal_tail" ? comp.horizontal_tail?.spar : currentState.latest_spar) || {};
  if (sparFeaScene) {
    sparFeaScene.selectComponent(id);
    sparFeaScene.updateSparMesh({ spar, fea, stressMesh });
  }
  // With fine-mesh FEA for this part the scene renders KPIs, charts and the station table.
  if (sparFeaScene?.ownsPanels) return;

  const kpiEl = document.getElementById("detailed-kpis");
  if (kpiEl) {
    kpiEl.innerHTML = kpiCards([
      { label: "FEA peak von Mises", val: fea ? `${(fea.fea_max_von_mises_pa / 1e6).toFixed(1)} MPa` : "—", prov: `${base}.fea.fea_max_von_mises_pa` },
      { label: "Beam theory stress", val: fea ? `${(fea.beam_max_stress_pa / 1e6).toFixed(1)} MPa` : "—", prov: `${base}.fea.beam_max_stress_pa` },
      { label: "Stress agreement", val: fea ? `${fea.stress_agreement_pct.toFixed(1)}%` : "—", prov: `${base}.fea.stress_agreement_pct` },
      { label: "FEA tip deflection", val: fea ? `${(fea.fea_tip_deflection_m * 1000).toFixed(1)} mm` : "—", prov: `${base}.fea.fea_tip_deflection_m` },
    ]);
  }
  if (fea) {
    renderFeaComparisonCharts(document.getElementById("chart-fea-stress"), document.getElementById("chart-fea-deflection"), fea, spar);
  }
}

async function startDetailedComponentStream(componentId = RUN_OF[selectedComponent] || "main_wing_spar") {
  if (!currentState) return;
  const name = currentState.components?.[componentId]?.name || componentId;
  setStatus(`Streaming ${name}...`, true);
  const pills = { loads: "step-loads", sizing: "step-loads", cad: "step-cad", fea: "step-fea" };
  const allPills = ["step-loads", "step-cad", "step-fea", "step-verify"].map((id) => document.getElementById(id));
  allPills.forEach((el) => el?.classList.remove("running", "done"));
  renderDetailedPipeline(componentId);
  sparFeaScene?.solveStart(componentId);

  const finish = (label) => {
    allPills.forEach((el) => el?.classList.add("done"));
    setStatus(label, false);
    sparFeaScene?.solveEnd(true);
    meshCache.clear();
    renderDetailedView();
    renderPartList(document.getElementById("component-tree"));
  };

  try {
    await streamComponentDetailed(currentState, componentId, {
      onStep: (ev) => {
        sparFeaScene?.solveEvent(ev);
        const pillId = ev.component_id === componentId ? pills[ev.step] : ev.component_id === "optimiser" && ev.step === "verify" ? "step-verify" : null;
        const el = pillId && document.getElementById(pillId);
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
        finish(`${name}: complete`);
      },
      onError: (ev) => {
        setStatus(`${name}: ${ev?.message || "failed"}`, false);
        sparFeaScene?.solveEnd(false);
      },
    });
  } catch (err) {
    console.warn("Detailed stream fallback to sync:", err);
    currentState = await runComponentDetailed(currentState, componentId);
    finish(`${name}: complete`);
  }
}

function startDetailedSparStream() {
  return startDetailedComponentStream("main_wing_spar");
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

/* The main wing spar's FEA agreement, kept in a fixed node whichever component Screen 3 shows,
 * so the overhaul's report cover never reads another component's KPI card. */
function publishMainSparSummary() {
  const el = document.getElementById("summary-main-spar-agreement");
  const fea = currentState?.components?.main_wing_spar?.fea;
  if (el) el.textContent = fea ? `${fea.stress_agreement_pct.toFixed(1)}%` : "";
}

function renderReportView() {
  if (!currentState) return;
  publishMainSparSummary();
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
    const srcs = (currentState.sources || []).map((s) => `<div class="source-item source-cited">${esc(s)}</div>`).join("");
    const asms = (currentState.assumptions || []).map((a) => `<div class="source-item source-assumption">${esc(a)}</div>`).join("");
    const wrns = (currentState.warnings || []).map((w) => `<div class="source-item source-warning">${esc(w)}</div>`).join("");
    srcEl.innerHTML = `
      <div class="sources-ledger-list">
        <strong class="ledger-heading">Cited Equations &amp; Tables</strong>${srcs}
        <strong class="ledger-heading">Engineering Assumptions</strong>${asms}
        ${wrns ? `<strong class="ledger-heading warning-heading">Heuristic Range Warnings</strong>${wrns}` : ""}
      </div>`;
  }
}

/* ---------------- WIRE UP EVENT LISTENERS & INITIAL BOOT ---------------- */
document.querySelectorAll(".screen-tabs button").forEach((btn) => {
  btn.addEventListener("click", () => switchScreen(btn.dataset.screen));
});

// Screen 1 handlers (presets, parse, confirm) live in web/intake.js.

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
  if (rel && rel.field_name) {
    currentSpec[rel.field_name] = Number(rel.new_value);
    if (currentSpec.defaulted_fields) delete currentSpec.defaulted_fields[rel.field_name];
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
  selectedComponent = "main_wing_spar";
  switchScreen("detailed");
  startDetailedSparStream();
});
document.getElementById("btn-run-fea")?.addEventListener("click", () => startDetailedComponentStream(RUN_OF[selectedComponent] || "main_wing_spar"));

document.querySelectorAll(".vp-btn-fea").forEach((b) => {
  b.addEventListener("click", () => sparFeaScene?.setViewPreset(b.dataset.cam));
});
document.getElementById("chk-fea-wire")?.addEventListener("change", (e) => {
  sparFeaScene?.setShowWireframe(e.target.checked);
});
document.getElementById("sl-defl-scale")?.addEventListener("input", (e) => {
  const v = Number(e.target.value);
  document.getElementById("lbl-defl-scale").textContent = `×${v.toFixed(1)}`;
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

// Boot: wire Screen 1 (web/intake.js) & pre-populate baseline state in background
initIntake({
  getSpec: () => currentSpec,
  setSpec: (spec) => {
    currentSpec = spec;
  },
  defaultSpec: DEFAULT_SPEC,
  presets: PRESETS,
  setStatus,
  onSpecChanged: () => syncSlidersFromSpec(),
  onConfirm: () => startSpiralStream(),
});
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
