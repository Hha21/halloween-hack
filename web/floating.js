/**
 * Full-bleed floating layout for Screen 2 (workspace) and Screen 3 (detailed) (Owner: Tharm).
 *
 * The 3D viewport fills the window. Existing panels are moved (not copied, so
 * ids and app.js listeners keep working) into glass side columns with a
 * collapsible header, and a dock of chips at the top shows or hides each one.
 */

const LAYOUTS = {
  "screen-workspace": [
    { key: "kpis", title: "Design KPIs", sel: "#workspace-kpis", col: "left" },
    { key: "trade", title: "Fidelity & trade study", sel: "#screen-workspace .sidebar", col: "left", grow: true },
    { key: "view", title: "View", sel: "#screen-workspace .viewport-toolbar", col: "right" },
    { key: "log", title: "Agent log", sel: "#screen-workspace .right-col", col: "right", grow: true },
    { key: "charts", title: "Engineering charts", sel: "#screen-workspace .charts-card", col: "bottom", off: true },
  ],
  "screen-detailed": [
    { key: "pipeline", title: "CAD & FEA pipeline", sel: "#screen-detailed .detailed-header", col: "left" },
    { key: "kpis", title: "FEA vs beam theory", sel: "#detailed-kpis", col: "left", grow: true },
    { key: "view", title: "View", sel: "#screen-detailed .viewport-toolbar", col: "right" },
    { key: "charts", title: "Spanwise charts & stations", sel: "#screen-detailed .fea-charts-col", col: "right", grow: true },
  ],
};

function makePanel(spec, node) {
  const panel = document.createElement("div");
  panel.className = `ws-panel${spec.grow ? " grow" : ""}${spec.off ? " off" : ""}`;
  const head = document.createElement("button");
  head.type = "button";
  head.className = "ws-head";
  head.innerHTML = `<span>${spec.title}</span><span class="ws-chevron">▾</span>`;
  head.addEventListener("click", () => panel.classList.toggle("collapsed"));
  const body = document.createElement("div");
  body.className = "ws-body";
  body.appendChild(node);
  panel.append(head, body);
  return panel;
}

function layoutScreen(id, specs) {
  const section = document.getElementById(id);
  if (!section) return;
  section.classList.add("ws-floating");
  const cols = {};
  for (const name of ["left", "right", "bottom"]) {
    cols[name] = document.createElement("div");
    cols[name].className = `ws-col ws-${name}`;
  }
  const dock = document.createElement("div");
  dock.className = "ws-dock";

  for (const spec of specs) {
    const node = document.querySelector(spec.sel);
    if (!node) continue;
    const panel = makePanel(spec, node);
    cols[spec.col].appendChild(panel);

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `ws-chip${spec.off ? "" : " on"}`;
    chip.textContent = spec.title;
    chip.addEventListener("click", () => {
      const hidden = panel.classList.toggle("off");
      if (!hidden) panel.classList.remove("collapsed");
      chip.classList.toggle("on", !hidden);
    });
    dock.appendChild(chip);
  }
  section.append(cols.left, cols.right, cols.bottom, dock);
}

function syncTopOffset() {
  const bar = document.querySelector(".topbar");
  const h = bar ? bar.getBoundingClientRect().height : 56;
  document.documentElement.style.setProperty("--ws-top", `${Math.round(h + 12)}px`);
}

for (const [id, specs] of Object.entries(LAYOUTS)) layoutScreen(id, specs);
syncTopOffset();
window.addEventListener("resize", syncTopOffset);
