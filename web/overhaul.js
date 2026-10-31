// Cinematic overhaul for Screens 2-4 (Owner: Harry; overhaul agent). Kill switch: add ?classic to the URL.
// Rules: never remove/recreate nodes app.js writes to; only add classes, insert small decorative or toggle
// nodes, and fail soft (every selector may be missing while Tharm's screens change, or in static demo mode).
const OV_SCREENS = ["screen-workspace", "screen-detailed", "screen-report"];

if (!new URLSearchParams(location.search).has("classic")) {
  document.documentElement.classList.add("overhaul");
  const steps = [curtains, watchScreens, missionHud, declutterWorkspace, convergenceChart, declutterDetailed, foldReportLedger, dossierCover, statusStrip, relaxationCue];
  for (const step of steps) {
    try {
      step();
    } catch (err) {
      console.warn("[overhaul]", step.name, err);
    }
  }
}

function $(sel) {
  return document.querySelector(sel);
}

function panelOf(node) {
  return node && node.closest ? node.closest(".ws-panel") : null;
}

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html) n.innerHTML = html;
  return n;
}

/* Restart a one-shot CSS animation class on a node, then clear it. */
function pulseClass(node, cls, ms) {
  if (!node) return;
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
  clearTimeout(node[`_ov_${cls}`]);
  node[`_ov_${cls}`] = setTimeout(() => node.classList.remove(cls), ms);
}

/* Button that toggles `cls` on `target`; label flips Show/Hide. */
function makeFold(label, target, cls) {
  const btn = el("button", "ov-more");
  btn.type = "button";
  const sync = () => {
    const open = target.classList.contains(cls);
    btn.textContent = `${open ? "Hide" : "Show"} ${label} ${open ? "▴" : "▾"}`;
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.addEventListener("click", () => {
    target.classList.toggle(cls);
    sync();
  });
  sync();
  return btn;
}

/* A light sweep that plays across the window when a screen is entered. */
function curtains() {
  for (const id of OV_SCREENS) {
    const s = document.getElementById(id);
    if (s && !s.querySelector(":scope > .ov-curtain")) s.appendChild(el("div", "ov-curtain"));
  }
}

/* Entrance animation each time a screen gains .active. */
function watchScreens() {
  for (const id of OV_SCREENS) {
    const s = document.getElementById(id);
    if (!s) continue;
    let was = s.classList.contains("active");
    new MutationObserver(() => {
      const now = s.classList.contains("active");
      if (now && !was) pulseClass(s, "ov-enter", 1900);
      was = now;
    }).observe(s, { attributes: true, attributeFilter: ["class"] });
  }
}

/* Mission-control frame over each 3D viewport: corner brackets, reticle, grid, scanline, telemetry. */
function missionHud() {
  const t0 = performance.now();
  const specs = [
    ["#screen-workspace .viewport-card", "SPIRAL // DESIGN LOOP", "PARAMETRIC AIRFRAME · LIVE"],
    ["#screen-detailed .viewport-card", "SPAR // VON MISES FIELD", "3D FEA · CANTILEVER I-BEAM"],
  ];
  const clocks = [];
  for (const [sel, title, sub] of specs) {
    const card = $(sel);
    if (!card || card.querySelector(":scope > .ov-hud")) continue;
    const hud = el(
      "div",
      "ov-hud",
      `<i class="ov-br tl"></i><i class="ov-br tr"></i><i class="ov-br bl"></i><i class="ov-br br"></i>
       <i class="ov-reticle"></i><i class="ov-scan"></i>
       <div class="ov-hud-id"><b>${title}</b><span>${sub}</span></div>
       <div class="ov-hud-clock">T+00:00:00</div>
       <div class="ov-hud-stamp"><small></small><b></b><span></span></div>`
    );
    hud.setAttribute("aria-hidden", "true");
    card.appendChild(hud);
    clocks.push(hud.querySelector(".ov-hud-clock"));
  }
  if (!clocks.length) return;
  const pad = (n) => String(n).padStart(2, "0");
  setInterval(() => {
    const s = Math.floor((performance.now() - t0) / 1000);
    const txt = `T+${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
    for (const c of clocks) c.textContent = txt;
  }, 1000);
}

/* Big centred stamp on the Screen 2 HUD ("SPIRAL CLOSED" / "SPIRAL DIVERGED"). */
function stamp(kind, small, big, line) {
  const hud = $("#screen-workspace .ov-hud");
  const box = hud?.querySelector(".ov-hud-stamp");
  if (!box) return;
  box.dataset.kind = kind;
  box.querySelector("small").textContent = small;
  box.querySelector("b").textContent = big;
  box.querySelector("span").textContent = line || "";
  pulseClass(box, "show", 3600);
}

function kpiText(n) {
  return ($(`#workspace-kpis .kpi-card:nth-child(${n}) .kpi-val`)?.textContent || "").trim();
}

/* Screen 2: aircraft is the hero. Secondary content folds away but stays one click from view. */
function declutterWorkspace() {
  const kpis = $("#workspace-kpis");
  if (kpis) kpis.insertAdjacentElement("afterend", makeFold("all metrics", kpis, "ov-all"));

  const sidebar = $("#screen-workspace .sidebar");
  if (sidebar) sidebar.appendChild(makeFold("trade study & components", sidebar, "ov-open"));

  const log = $("#screen-workspace .right-col");
  if (log) {
    const fold = makeFold("agent log & warnings", log, "ov-open");
    const cta = $("#btn-goto-detailed");
    if (cta && cta.parentElement === log) log.insertBefore(fold, cta);
    else log.appendChild(fold);
  }

  panelOf($("#screen-workspace .viewport-toolbar"))?.classList.add("collapsed");
}

/* Screen 2: the convergence chart is a headline. Move Tharm's charts panel (once, ids intact) from the
 * bottom-centre slot, where it would cover the aircraft, into the right column, and switch it on via his chip. */
function convergenceChart() {
  const panel = panelOf($("#screen-workspace .charts-card"));
  const right = $("#screen-workspace .ws-right");
  if (!panel || !right) return;
  right.appendChild(panel);
  panel.classList.add("ov-charts");
  if (panel.classList.contains("off")) {
    const chip = [...document.querySelectorAll("#screen-workspace .ws-dock .ws-chip")].find((c) => /chart/i.test(c.textContent));
    if (chip) chip.click();
    else panel.classList.remove("off");
  }
}

/* Screen 3: stress-coloured spar is the hero; charts and tables fold away. */
function declutterDetailed() {
  const kpis = $("#detailed-kpis");
  if (kpis) kpis.insertAdjacentElement("afterend", makeFold("all metrics", kpis, "ov-all"));
  panelOf($("#screen-detailed .viewport-toolbar"))?.classList.add("collapsed");
  panelOf($("#screen-detailed .fea-charts-col"))?.classList.add("collapsed");
}

/* Screen 4: provenance and sources ledgers fold behind their headings. */
function foldReportLedger() {
  document.querySelectorAll("#screen-report .ledger-col > .panel").forEach((panel) => {
    const h = panel.querySelector(":scope > h3");
    if (!h || panel.classList.contains("ov-fold")) return;
    panel.classList.add("ov-fold", "ov-closed");
    h.setAttribute("role", "button");
    h.setAttribute("tabindex", "0");
    h.setAttribute("aria-expanded", "false");
    const toggle = () => {
      const closed = panel.classList.toggle("ov-closed");
      h.setAttribute("aria-expanded", String(!closed));
    };
    h.addEventListener("click", toggle);
    h.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
  });
}

/* Screen 2 headline status (lap + spiral state), mirrored from nodes app.js already updates.
 * Drives the cinematic moments: alarm when the spiral diverges, a stamp when it closes. */
function statusStrip() {
  const kpis = $("#workspace-kpis");
  const ws = document.getElementById("screen-workspace");
  if (!kpis || !kpis.parentElement) return;
  const strip = el("div", "ov-status", `<span class="ov-lap">Lap 0</span><span class="ov-state" data-state="ready">Ready</span>`);
  kpis.parentElement.insertBefore(strip, kpis);
  const lapEl = strip.querySelector(".ov-lap");
  const stateEl = strip.querySelector(".ov-state");
  let prev = null;

  const update = () => {
    const badge = $("#lap-badge");
    const lapText = (badge?.textContent || "").trim();
    const lapMatch = lapText.match(/lap\s*(\d+)/i);
    const lapNum = lapMatch ? parseInt(lapMatch[1], 10) : parseInt(lapText.replace(/\D+/g, ""), 10) || 0;
    lapEl.textContent = lapMatch || !lapText ? `Lap ${lapNum}` : lapText;
    const banner = $("#infeasible-banner");
    const failed = (banner && !banner.classList.contains("hidden")) || !!$("#stage-list li.failed");
    // The static HTML ships li.active on stage 01; it only means "running" once app.js has rendered the ladder.
    const ladderLive = !!$("#stage-list li.done, #stage-list li.pending, #stage-list li.failed");
    const running = ladderLive && !!$("#stage-list li.active");
    let state = "ready";
    let text = "Ready";
    if (failed) [state, text] = ["failed", "Did not close"];
    else if (running) [state, text] = ["running", "Iterating…"];
    else if (lapNum > 0) [state, text] = ["closed", "Spiral closed"];
    stateEl.dataset.state = state;
    stateEl.textContent = text;

    if (ws) {
      ws.classList.toggle("ov-alarm", state === "failed");
      ws.classList.toggle("ov-running", state === "running");
      const visible = ws.classList.contains("active");
      if (visible && state !== prev && prev !== null) {
        if (state === "closed" && (prev === "running" || prev === "failed")) {
          const mtow = kpiText(1);
          stamp("closed", lapNum ? `CONVERGED · LAP ${lapNum}` : "CONVERGED", "SPIRAL CLOSED", mtow ? `MTOW ${mtow}` : "");
          pulseClass(ws, "ov-converged", 2600);
        }
      }
    }
    prev = state;
  };

  let queued = false;
  const mo = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  });
  for (const sel of ["#lap-badge", "#infeasible-banner", "#stage-list"]) {
    const node = $(sel);
    if (node) mo.observe(node, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true, characterData: true });
  }
  update();
}

/* Accepting the relaxation: banner collapses away, a sweep crosses the viewport. app.js still owns the click. */
function relaxationCue() {
  const btn = $("#btn-accept-relaxation");
  const ws = document.getElementById("screen-workspace");
  if (!btn) return;
  btn.addEventListener("click", () => {
    pulseClass(ws, "ov-relax", 2200);
    pulseClass($("#infeasible-banner"), "ov-accepted", 2200);
    stamp("relax", "CONSTRAINT RELAXED", "RE-RUNNING SPIRAL", "Closing the weight loop…");
  });
}

/* Screen 4 cover band: the headline figures, mirrored (as text) from the KPI nodes app.js renders. */
function dossierCover() {
  const report = document.getElementById("screen-report");
  const grid = report?.querySelector(".report-grid");
  if (!report || !grid || report.querySelector(".ov-cover")) return;
  const cover = el("div", "ov-cover");
  grid.parentElement.insertBefore(cover, grid);
  const read = (sel) => (document.querySelector(sel)?.textContent || "").trim();
  const figs = [
    ["MTOW", "#workspace-kpis .kpi-card:nth-child(1) .kpi-val"],
    ["Main spar mass", "#workspace-kpis .kpi-card:nth-child(4) .kpi-val"],
    ["Safety margin", "#workspace-kpis .kpi-card:nth-child(5) .kpi-val"],
    ["FEA vs beam theory", "#detailed-kpis .kpi-card:nth-child(3) .kpi-val"],
  ].map(([label, sel]) => {
    const fig = el("div", "ov-fig");
    const k = el("small");
    k.textContent = label;
    const v = el("b");
    fig.append(k, v);
    cover.appendChild(fig);
    return [v, sel];
  });
  const fill = () => {
    for (const [v, sel] of figs) v.textContent = read(sel) || "\u2014";
  };
  fill();
  new MutationObserver(() => {
    if (report.classList.contains("active")) fill();
  }).observe(report, { attributes: true, attributeFilter: ["class"] });
}
