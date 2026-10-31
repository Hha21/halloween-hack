/**
 * Frontend application controller placeholder (Owner: Tharm).
 *
 * TODO (Tharm): Mount Three.js aircraft scene (`state.latest_geometry`),
 * convergence plot (`state.history`), and 3D FEA stress mesh viewer (`components.main_wing_spar.fea`).
 */

import {
  generateReport,
  parseIntake,
  runSparDetailed,
  runSpiralSync,
} from "./api_client.js";

let currentSpec = null;
let currentState = null;

function switchScreen(screenName) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".screen-tabs button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.screen === screenName);
  });
  const target = document.getElementById(`screen-${screenName}`);
  if (target) target.classList.add("active");
}

document.querySelectorAll(".screen-tabs button").forEach((btn) => {
  btn.addEventListener("click", () => switchScreen(btn.dataset.screen));
});

document.getElementById("btn-parse")?.addEventListener("click", async () => {
  const desc = document.getElementById("prompt-input").value;
  const data = await parseIntake(desc);
  currentSpec = data.spec;
  document.getElementById("spec-preview").textContent = JSON.stringify(data, null, 2);
});

document.getElementById("btn-run-spiral")?.addEventListener("click", async () => {
  if (!currentSpec) {
    const desc = document.getElementById("prompt-input").value;
    const intake = await parseIntake(desc);
    currentSpec = intake.spec;
  }
  currentState = await runSpiralSync(currentSpec);
  document.getElementById("geometry-preview").textContent = JSON.stringify(
    currentState.latest_geometry,
    null,
    2
  );
  document.getElementById("convergence-preview").textContent = JSON.stringify(
    currentState.history.map((h) => ({
      lap: h.lap,
      mtow_kg: h.mtow_kg,
      spar_mass_kg: h.spar_mass_kg,
      mtow_change_pct: h.mtow_change_pct,
    })),
    null,
    2
  );
  document.getElementById("log-preview").textContent = JSON.stringify(
    currentState.log,
    null,
    2
  );
  switchScreen("workspace");
});

document.getElementById("btn-run-fea")?.addEventListener("click", async () => {
  currentState = await runSparDetailed(currentState || { spec: currentSpec || {} });
  document.getElementById("fea-preview").textContent = JSON.stringify(
    currentState.components.main_wing_spar,
    null,
    2
  );
});

document.getElementById("btn-generate-report")?.addEventListener("click", async () => {
  const data = await generateReport(currentState || { spec: currentSpec || {} });
  currentState = data.state;
  document.getElementById("report-preview").textContent = data.report_markdown;
});
