// Cinematic overhaul for Screens 2-4 (Owner: Harry; overhaul agent). Kill switch: add ?classic to the URL.
// Rules: never remove/recreate nodes app.js writes to; only add classes, insert small decorative or toggle
// nodes, and fail soft (every selector may be missing while Tharm's screens change, or in static demo mode).
const OV_SCREENS = ["screen-workspace", "screen-detailed", "screen-report"];

if (!new URLSearchParams(location.search).has("classic")) {
  document.documentElement.classList.add("overhaul");
  const steps = [curtains, watchScreens, missionHud, declutterWorkspace, convergenceChart, declutterDetailed, foldReportLedger, dossierCover, statusStrip, relaxationCue, airframePanel];
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

/* ---------------------------------------------------------------------------------------------------------
 * Screen 3: agentic CAD. Gemini 4 Argon writes a bpy script from the converged design; the backend runs
 * Blender headless, checks the model's dimensions against the design, and sends failures back to Argon.
 * One POST does all of it, so the step list is animated on a clock and reconciled with `attempts` after.
 * Everything here is function-scoped (the steps run before any later top-level const would initialise).
 * --------------------------------------------------------------------------------------------------------- */
function afApiBase() {
  return location.port === "8000" ? "" : "http://localhost:8000";
}

function afDemoBase() {
  const b = window.__spiralStaticDemo?.demoBase;
  return b || new URL("demo/", location.href).href;
}

function afEsc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* "span_m" -> "Span (m)", "wing_area_m2" -> "Wing area (m²)". */
function afLabel(key) {
  const units = { m: "m", m2: "m²", m3: "m³", mm: "mm", deg: "°", kg: "kg", pct: "%" };
  const parts = String(key).split("_").filter(Boolean);
  const unit = parts.length > 1 && units[parts[parts.length - 1]] ? units[parts.pop()] : "";
  const name = parts.join(" ");
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}${unit ? ` (${unit})` : ""}`;
}

function afNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2);
  return v == null || v === "" ? "—" : String(v);
}

/* Artifact URLs: API_BASE-prefixed when live; in static demo mode they live under ./demo/. */
function afUrl(u, demo) {
  if (!u || typeof u !== "string") return "";
  if (/^(https?:|data:|blob:)/i.test(u)) return u;
  if (demo) return new URL(u.replace(/^\.?\//, "").replace(/^demo\//, ""), afDemoBase()).href;
  return `${afApiBase()}${u.startsWith("/") ? u : `/${u}`}`;
}

function afFetch() {
  // Bypass static-demo.js's wrapper: a 404 from this new route must not flip the whole app into demo mode.
  const real = window.__spiralStaticDemo?.realFetch;
  return typeof real === "function" ? real : window.fetch.bind(window);
}

function afLightbox(src, alt) {
  const box = el("div", "ov-af-lightbox");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", alt || "Airframe render");
  const img = el("img");
  img.src = src;
  img.alt = alt || "";
  box.appendChild(img);
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const close = () => {
    box.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  box.addEventListener("click", close);
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(box);
}

function afStyle() {
  if (document.getElementById("ov-af-style")) return;
  const css = `
html.overhaul .ws-panel.ov-af-panel { flex: 0 1 auto; }
html.overhaul .ov-af-card { margin-top: 0.75rem; padding: 0.85rem 1rem; }
html.overhaul .ov-af { display: grid; gap: 0.6rem; font-size: 0.78rem; color: #cbd5e1; }
html.overhaul .ov-af [hidden] { display: none !important; }
html.overhaul .ov-af-title { display: block; color: var(--ov-ice, #e0f2fe); font-size: 0.84rem; font-weight: 650; letter-spacing: 0.01em; }
html.overhaul .ov-af-intro p { margin: 0.3rem 0 0; color: var(--muted, #94a3b8); line-height: 1.5; font-size: 0.74rem; }
html.overhaul .ov-af-go { width: 100%; justify-content: center; }
html.overhaul .ov-af-go:disabled { opacity: 0.55; cursor: progress; filter: none; }
html.overhaul .ov-af-run { border: 1px solid var(--ov-edge, rgba(148, 197, 255, 0.14)); border-radius: 8px; padding: 0.55rem 0.65rem; background: rgba(8, 13, 25, 0.55); }
html.overhaul .ov-af-runhead { display: flex; align-items: center; gap: 0.45rem; font-family: var(--ov-mono, monospace); font-size: 0.66rem; letter-spacing: 0.05em; text-transform: uppercase; color: #fcd34d; }
html.overhaul .ov-af-run[data-st="ok"] .ov-af-runhead { color: #34d399; }
html.overhaul .ov-af-run[data-st="bad"] .ov-af-runhead { color: #fb7185; }
html.overhaul .ov-af-clock { margin-left: auto; color: var(--ov-ice, #e0f2fe); font-variant-numeric: tabular-nums; }
html.overhaul .ov-af-spin { width: 11px; height: 11px; border-radius: 50%; border: 2px solid rgba(252, 211, 77, 0.25); border-top-color: #fcd34d; animation: ov-af-spin 0.8s linear infinite; flex: none; }
html.overhaul .ov-af-run:not([data-st="busy"]) .ov-af-spin { display: none; }
@keyframes ov-af-spin { to { transform: rotate(360deg); } }
html.overhaul .ov-af-steps { list-style: none; margin: 0.5rem 0 0; padding: 0; display: grid; gap: 0.32rem; }
html.overhaul .ov-af-steps li { display: grid; grid-template-columns: 14px 1fr auto; gap: 0.45rem; align-items: center; color: #64748b; transition: color 0.3s; }
html.overhaul .ov-af-steps li i { width: 12px; height: 12px; border-radius: 50%; display: grid; place-items: center; font-style: normal; font-size: 11px; line-height: 1; justify-self: center; border: 1.5px solid #334155; box-sizing: border-box; }
html.overhaul .ov-af-steps small { font-family: var(--ov-mono, monospace); font-size: 0.62rem; color: var(--muted, #94a3b8); text-align: right; }
html.overhaul .ov-af-steps li[data-st="active"] { color: #fde68a; }
html.overhaul .ov-af-steps li[data-st="active"] i { border: 2px solid rgba(252, 211, 77, 0.25); border-top-color: #fcd34d; animation: ov-af-spin 0.8s linear infinite; }
html.overhaul .ov-af-steps li:is([data-st="past"], [data-st="ok"], [data-st="bad"], [data-st="skip"]) i { border: 0; }
html.overhaul .ov-af-steps li[data-st="past"] { color: #94a3b8; }
html.overhaul .ov-af-steps li[data-st="past"] i::after { content: "\\2713"; color: #64748b; }
html.overhaul .ov-af-steps li[data-st="ok"] { color: #d1fae5; }
html.overhaul .ov-af-steps li[data-st="ok"] i::after { content: "\\2713"; color: #34d399; }
html.overhaul .ov-af-steps li[data-st="bad"] { color: #fecdd3; }
html.overhaul .ov-af-steps li[data-st="bad"] i::after { content: "\\2717"; color: #fb7185; }
html.overhaul .ov-af-steps li[data-st="skip"] { color: #64748b; }
html.overhaul .ov-af-steps li[data-st="skip"] i::after { content: "\\2013"; color: #64748b; }
html.overhaul .ov-af-msg { border-left: 2px solid rgba(125, 211, 252, 0.5); background: rgba(56, 189, 248, 0.06); padding: 0.5rem 0.65rem; border-radius: 0 6px 6px 0; line-height: 1.5; font-size: 0.74rem; }
html.overhaul .ov-af-msg[data-kind="warn"] { border-left-color: rgba(252, 211, 77, 0.6); background: rgba(252, 211, 77, 0.06); }
html.overhaul .ov-af-msg b { display: block; color: var(--ov-ice, #e0f2fe); margin-bottom: 0.15rem; font-weight: 600; }
html.overhaul .ov-af-out { display: grid; gap: 0.7rem; }
html.overhaul .ov-af-meta { margin: 0; font-family: var(--ov-mono, monospace); font-size: 0.64rem; color: var(--muted, #94a3b8); letter-spacing: 0.03em; }
html.overhaul .ov-af-render { margin: 0; }
html.overhaul .ov-af-render img { display: block; width: 100%; border-radius: 8px; border: 1px solid var(--ov-edge, rgba(148, 197, 255, 0.14)); background: #050912; cursor: zoom-in; }
html.overhaul .ov-af-render figcaption { margin-top: 0.3rem; font-size: 0.64rem; color: var(--muted, #94a3b8); }
html.overhaul .ov-af-h { font-family: var(--ov-mono, monospace); font-size: 0.6rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted, #94a3b8); margin: 0 0 0.35rem; font-weight: 500; }
html.overhaul .ov-af-attempts { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; border-left: 1px solid rgba(148, 163, 184, 0.22); }
html.overhaul .ov-af-attempts li { padding-left: 0.65rem; }
html.overhaul .ov-af-attempts li > div { display: flex; justify-content: space-between; gap: 0.5rem; align-items: baseline; }
html.overhaul .ov-af-attempts li b { color: #6ee7b7; font-weight: 600; }
html.overhaul .ov-af-attempts li[data-ok="0"] b { color: #fda4af; }
html.overhaul .ov-af-attempts li > div span { font-family: var(--ov-mono, monospace); font-size: 0.62rem; color: var(--muted, #94a3b8); }
html.overhaul .ov-af-attempts ul { margin: 0.18rem 0 0; padding-left: 1rem; color: #cbd5e1; font-size: 0.72rem; }
html.overhaul .ov-af-table { width: 100%; border-collapse: collapse; font-size: 0.72rem; font-variant-numeric: tabular-nums; }
html.overhaul .ov-af-table th, html.overhaul .ov-af-table td { padding: 0.28rem 0.35rem; border-bottom: 1px solid rgba(148, 163, 184, 0.12); text-align: right; }
html.overhaul .ov-af-table tbody th { text-align: left; font-weight: 500; color: #cbd5e1; }
html.overhaul .ov-af-table thead th { font-family: var(--ov-mono, monospace); font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted, #94a3b8); font-weight: 500; }
html.overhaul .ov-af-table thead th:first-child { text-align: left; }
html.overhaul .ov-af-table td.ov-af-ok { text-align: center; color: #64748b; }
html.overhaul .ov-af-table tr[data-ok="1"] td.ov-af-ok { color: #34d399; }
html.overhaul .ov-af-table tr[data-ok="0"] td.ov-af-ok, html.overhaul .ov-af-table tr[data-ok="0"] td.ov-af-model { color: #fb7185; }
html.overhaul .ov-af-links { display: flex; flex-wrap: wrap; gap: 0.4rem; }
html.overhaul .ov-af-links .btn { font-size: 0.72rem; text-decoration: none; }
html.overhaul .ov-af-code { margin: 0; max-height: 260px; overflow: auto; padding: 0.55rem 0.65rem; border-radius: 8px; background: #050912; border: 1px solid var(--ov-edge, rgba(148, 197, 255, 0.14)); font: 0.64rem/1.5 var(--ov-mono, monospace); color: #cbd5e1; white-space: pre; }
html.overhaul .ov-af-lightbox { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; padding: 24px; background: rgba(2, 6, 15, 0.86); backdrop-filter: blur(6px); cursor: zoom-out; }
html.overhaul .ov-af-lightbox img { max-width: 100%; max-height: 100%; border-radius: 10px; box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6); }
`;
  const style = el("style");
  style.id = "ov-af-style";
  style.textContent = css;
  document.head.appendChild(style);
}

/* Mount: a glass panel (plus dock chip) in Screen 3's floating right column; a plain card if that is missing. */
function airframePanel() {
  const screen = document.getElementById("screen-detailed");
  if (!screen || screen.querySelector(".ov-af")) return;
  afStyle();
  const root = el(
    "div",
    "ov-af",
    `<div class="ov-af-intro">
       <b class="ov-af-title">Agentic CAD · Gemini 4 Argon drives Blender</b>
       <p>Argon writes a Blender script from the converged design; Python runs Blender headless and checks the model's dimensions against the design; failures go back to Argon to fix.</p>
     </div>
     <button type="button" class="btn primary ov-af-go">Build airframe in Blender</button>
     <div class="ov-af-run" hidden aria-live="polite">
       <div class="ov-af-runhead"><span class="ov-af-spin"></span><span class="ov-af-state">Working…</span><span class="ov-af-clock">0.0 s</span></div>
       <ol class="ov-af-steps"></ol>
     </div>
     <div class="ov-af-msg" hidden role="status"></div>
     <div class="ov-af-out" hidden></div>`
  );

  const right = screen.querySelector(".ws-right");
  if (right) {
    const panel = el("div", "ws-panel ov-af-panel");
    const head = el("button", "ws-head", `<span>Build the airframe in Blender · Gemini 4 Argon</span><span class="ws-chevron">▾</span>`);
    head.type = "button";
    head.addEventListener("click", () => panel.classList.toggle("collapsed"));
    const body = el("div", "ws-body");
    body.appendChild(root);
    panel.append(head, body);
    right.appendChild(panel);
    const dock = screen.querySelector(".ws-dock");
    if (dock) {
      const chip = el("button", "ws-chip on");
      chip.type = "button";
      chip.textContent = "Blender airframe";
      chip.addEventListener("click", () => {
        const hidden = panel.classList.toggle("off");
        if (!hidden) panel.classList.remove("collapsed");
        chip.classList.toggle("on", !hidden);
      });
      dock.appendChild(chip);
    }
  } else {
    const card = el("div", "panel ov-af-card");
    card.appendChild(root);
    (screen.querySelector(".fea-charts-col") || screen).appendChild(card);
  }

  wireAirframe(root);
}

function wireAirframe(root) {
  const q = (s) => root.querySelector(s);
  const go = q(".ov-af-go");
  const run = q(".ov-af-run");
  const stepsEl = q(".ov-af-steps");
  const stateEl = q(".ov-af-state");
  const clock = q(".ov-af-clock");
  const msg = q(".ov-af-msg");
  const out = q(".ov-af-out");
  const LABELS = ["Argon writes the bpy script", "Blender builds and renders, headless", "Verify dimensions against the design", "Retry if needed"];
  let busy = false;

  const setStep = (i, st, note) => {
    const li = stepsEl.children[i];
    if (!li) return;
    li.dataset.st = st;
    li.querySelector("small").textContent = note || "";
  };
  const say = (kind, title, line) => {
    msg.dataset.kind = kind;
    msg.innerHTML = `<b>${afEsc(title)}</b>${line ? afEsc(line) : ""}`;
    msg.hidden = false;
  };

  go.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    go.disabled = true;
    go.textContent = "Building in Blender…";
    msg.hidden = true;
    out.hidden = true;
    out.innerHTML = "";
    const demo = window.__spiralStaticDemo?.mode === "demo";
    // Seconds at which each step becomes the active one (compressed when replaying a recording).
    const at = demo ? [0, 1.2, 2.4, 3.4] : [0, 9, 20, 32];
    stepsEl.innerHTML = LABELS.map((t) => `<li data-st="wait"><i></i><span>${afEsc(t)}</span><small></small></li>`).join("");
    run.dataset.st = "busy";
    run.hidden = false;
    stateEl.textContent = demo ? "Replaying a recorded run…" : "Argon is working…";
    const t0 = performance.now();
    const elapsed = () => (performance.now() - t0) / 1000;
    const tick = () => {
      const s = elapsed();
      clock.textContent = `${s.toFixed(1)} s`;
      let cur = 0;
      at.forEach((t, i) => {
        if (s >= t) cur = i;
      });
      for (let i = 0; i < LABELS.length; i++) {
        const li = stepsEl.children[i];
        if (li) li.dataset.st = i < cur ? "past" : i === cur ? "active" : "wait";
      }
    };
    tick();
    const timer = setInterval(tick, 100);

    const doFetch = afFetch();
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const guard = ctl ? setTimeout(() => ctl.abort(), 180000) : 0;
    let result = null;
    let problem = null;
    try {
      if (demo) {
        const res = await doFetch(new URL("airframe.json", afDemoBase()).href, { cache: "no-store", signal: ctl?.signal });
        if (!res.ok) throw Object.assign(new Error("no recording"), { kind: "demo" });
        result = await res.json().catch(() => null);
        if (!result || typeof result !== "object") throw Object.assign(new Error("bad recording"), { kind: "demo" });
        const wait = 4.4 - elapsed();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
      } else {
        const res = await doFetch(`${afApiBase()}/api/components/airframe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: ctl?.signal,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: "http", status: res.status, detail: data?.detail ?? data?.error });
        if (!data || typeof data !== "object") throw Object.assign(new Error("bad reply"), { kind: "shape" });
        result = data;
      }
    } catch (err) {
      problem = err;
    } finally {
      clearTimeout(guard);
      clearInterval(timer);
    }

    const secs = elapsed().toFixed(1);
    clock.textContent = `${secs} s`;
    busy = false;
    go.disabled = false;

    if (problem) {
      go.textContent = "Build airframe in Blender";
      run.hidden = true;
      if (demo || problem.kind === "demo") {
        say("info", "Run locally with Blender to use this.", "This static demo has no backend, and no recorded Blender run is bundled yet.");
      } else if (problem.name === "AbortError") {
        say("warn", "Blender is taking longer than expected.", "The panel stopped waiting after 3 minutes. The server may still finish; try again in a moment.");
      } else if (problem.kind === "http" && [404, 405, 501].includes(problem.status)) {
        say("info", "The Blender build isn't available on this backend yet.", `The server answered HTTP ${problem.status}. Restart it with the latest code, with Blender installed, and try again.`);
      } else if (problem.kind === "http") {
        let detail = problem.detail;
        if (detail && typeof detail !== "string") {
          try {
            detail = JSON.stringify(detail);
          } catch (_) {
            detail = "";
          }
        }
        detail = detail ? String(detail).slice(0, 240) : "";
        say("warn", `The backend couldn't build the airframe (HTTP ${problem.status}).`, detail);
      } else if (problem.kind === "shape") {
        say("warn", "The backend replied, but not with an airframe result.", "Try again once the server has finished starting up.");
      } else {
        const where = afApiBase() || location.origin;
        say("info", "Couldn't reach the Spiral backend.", `Nothing answered at ${where}. Start the server locally, with Blender installed, and try again.`);
      }
      return;
    }

    try {
      renderAirframe(result, { demo, secs, setStep, run, stateEl, say, out, doFetch });
    } catch (err) {
      console.warn("[overhaul] airframe result", err);
      run.hidden = true;
      say("warn", "The airframe result couldn't be shown.", "The build finished, but its reply was in an unexpected shape.");
    }
    go.textContent = "Rebuild airframe in Blender";
  });
}

function renderAirframe(result, ctx) {
  const { demo, secs, setStep, run, stateEl, say, out, doFetch } = ctx;
  const attempts = Array.isArray(result.attempts) ? result.attempts.filter((a) => a && typeof a === "object") : [];
  const ok = result.status === "ok";
  const n = attempts.length;
  const last = attempts[n - 1];
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

  // Reconcile the animated steps with what actually happened.
  setStep(0, n || ok ? "ok" : "bad", n ? plural(n, "script", "scripts") : "");
  setStep(1, n || ok ? "ok" : "bad", n ? plural(n, "build", "builds") : "");
  const lastIssues = Array.isArray(last?.issues) ? last.issues.length : 0;
  setStep(2, ok ? "ok" : "bad", ok ? "matches design" : lastIssues ? plural(lastIssues, "issue left", "issues left") : "no match");
  if (n > 1) setStep(3, ok ? "ok" : "bad", ok ? `fixed in ${plural(n - 1, "retry", "retries")}` : `gave up after ${n}`);
  else setStep(3, ok ? "skip" : "bad", ok ? "not needed" : "gave up");
  run.dataset.st = ok ? "ok" : "bad";
  stateEl.textContent = ok ? `Built and verified · ${secs} s` : `Not verified · ${plural(n, "attempt", "attempts")}`;

  if (!ok) {
    say("warn", `Argon couldn't make the model match the design in ${plural(n, "attempt", "attempts")}.`, "The remaining issues are listed below.");
  }

  out.innerHTML = "";
  const model = typeof result.model === "string" && result.model ? result.model : "gemini-4-argon";
  out.appendChild(el("p", "ov-af-meta", afEsc(`${model} · ${plural(n, "attempt", "attempts")} · ${demo ? "recorded run" : `${secs} s`}`)));

  const renderUrl = afUrl(result.render_url, demo);
  if (renderUrl) {
    const fig = el("figure", "ov-af-render");
    const img = el("img");
    img.alt = "Headless Blender render of the airframe Gemini 4 Argon built";
    img.decoding = "async";
    img.src = demo ? renderUrl : `${renderUrl}${renderUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
    img.addEventListener("error", () => fig.replaceWith(el("p", "ov-af-meta", "Render image not available.")));
    img.addEventListener("click", () => afLightbox(img.currentSrc || img.src, img.alt));
    fig.append(img, el("figcaption", "", "Headless Blender render · click to enlarge"));
    out.appendChild(fig);
  }

  if (n) {
    const box = el("div");
    box.appendChild(el("p", "ov-af-h", "Attempts"));
    const ol = el("ol", "ov-af-attempts");
    attempts.forEach((a, i) => {
      const li = el("li");
      li.dataset.ok = a.ok ? "1" : "0";
      const s = typeof a.seconds === "number" && Number.isFinite(a.seconds) ? `${a.seconds.toFixed(1)} s` : "";
      const issues = Array.isArray(a.issues) ? a.issues : [];
      li.innerHTML =
        `<div><b>${a.ok ? "✓" : "✗"} Attempt ${afEsc(a.n ?? i + 1)}</b><span>${afEsc(s)}</span></div>` +
        (issues.length ? `<ul>${issues.map((t) => `<li>${afEsc(t)}</li>`).join("")}</ul>` : a.ok ? "" : "<ul><li>Did not pass the dimension check</li></ul>");
      ol.appendChild(li);
    });
    box.appendChild(ol);
    out.appendChild(box);
  }

  const checks = result.checks && typeof result.checks === "object" ? Object.entries(result.checks) : [];
  if (checks.length) {
    const rows = checks
      .map(([key, raw]) => {
        const c = raw && typeof raw === "object" ? raw : { model: raw };
        const flag = c.ok === true ? "1" : c.ok === false ? "0" : "";
        let delta = "—";
        if (typeof c.design === "number" && typeof c.model === "number" && c.design !== 0) {
          const pct = ((c.model - c.design) / Math.abs(c.design)) * 100;
          delta = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
        }
        return `<tr data-ok="${flag}"><th scope="row">${afEsc(afLabel(key))}</th><td>${afEsc(afNum(c.design))}</td><td class="ov-af-model">${afEsc(afNum(c.model))}</td><td>${afEsc(delta)}</td><td class="ov-af-ok">${flag === "1" ? "✓" : flag === "0" ? "✗" : "–"}</td></tr>`;
      })
      .join("");
    const box = el("div");
    box.appendChild(el("p", "ov-af-h", "Dimension checks · design vs Blender model"));
    box.appendChild(
      el("table", "ov-af-table", `<thead><tr><th>Check</th><th>Design</th><th>Model</th><th>Δ</th><th></th></tr></thead><tbody>${rows}</tbody>`)
    );
    out.appendChild(box);
  }

  const glb = afUrl(result.glb_url, demo);
  const py = afUrl(result.script_url, demo);
  if (glb || py) {
    const links = el("div", "ov-af-links");
    let code = null;
    if (glb) {
      const a = el("a", "btn secondary", "⬇ Download .glb");
      a.href = glb;
      a.setAttribute("download", "airframe.glb");
      links.appendChild(a);
    }
    if (py) {
      const a = el("a", "btn secondary", "View Blender script");
      a.href = py;
      a.target = "_blank";
      a.rel = "noopener";
      a.addEventListener("click", async (e) => {
        // Show the script inline; fall back to the plain link if it can't be fetched.
        e.preventDefault();
        if (code) {
          code.hidden = !code.hidden;
          a.textContent = code.hidden ? "View Blender script" : "Hide Blender script";
          return;
        }
        try {
          const res = await doFetch(a.href, { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          code = el("pre", "ov-af-code");
          code.textContent = await res.text();
          links.insertAdjacentElement("afterend", code);
          a.textContent = "Hide Blender script";
        } catch (_) {
          window.open(a.href, "_blank", "noopener");
        }
      });
      links.appendChild(a);
    }
    out.appendChild(links);
  }

  out.hidden = false;
}
