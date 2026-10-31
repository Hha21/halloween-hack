/**
 * Screen 1: Mission intake & spec confirmation (Owner: Harry).
 *
 * Gemini reads the description (POST /api/intake); Python converts units and fills cited
 * defaults. This screen shows, for every field, where its value came from:
 *   [from your text]  stated in the description (quoted by Gemini, checked by Python)
 *   [Gemini inferred] crew / passengers / load factor implied by the words (e.g. "aerobatic")
 *   [cited default]   not stated: Python's default with its textbook citation
 *   [edited]          changed by hand in the form
 * Gemini never supplies a number: "cited default" values come from knowledge/*.yaml, not Gemini.
 *
 * app.js owns the shared state; it passes getters/setters in via initIntake().
 */

import { parseIntake, API_BASE } from "./api_client.js";

let ctx = null;
let lastIntake = null; // IntakeResponse from the last parse, or null
let parsedSpec = null; // the spec exactly as intake returned it (before presets, edits, sliders)
let lastError = null; // message if the last parse failed
const edited = new Set(); // spec fields changed by hand (or by a preset) since the last parse
let animateNext = false; // one-shot: the next render(s) in this tick play the entrance after a parse
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const FORM_KEY_TO_FIELD = { range_km: "range_m", cruise_kt: "cruise_speed_ms", stall_kt: "stall_speed_ms" };

/** Where a spec field's value came from, as {cls, label, title}. */
function origin(field) {
  const spec = ctx.getSpec();
  const changed = parsedSpec && JSON.stringify(parsedSpec[field]) !== JSON.stringify(spec?.[field]);
  if (edited.has(field) || changed) {
    return { cls: "prov-user", label: "edited", title: "Changed after parsing (form, preset, slider or an accepted relaxation)" };
  }
  const reason = spec?.defaulted_fields?.[field];
  if (reason && reason.startsWith("Inferred")) {
    return { cls: "prov-inferred", label: "Gemini inferred", title: reason };
  }
  if (reason) return { cls: "prov-cited", label: "cited default", title: reason };
  const quote = spec?.stated_fields?.[field];
  if (quote) return { cls: "prov-from-text", label: "from your text", title: `Your words: "${quote}"`, quote };
  const by = lastIntake?.sources?.[0] || "the description";
  return { cls: "prov-from-text", label: "from your text", title: `Stated in the description (${by})` };
}

/** The user's exact words for a field stated in the description, shown under the field. */
function quoteLine(field) {
  const q = origin(field).quote;
  return q ? `<q class="field-quote" title="Your words, quoted by Gemini and checked by Python">${esc(q)}</q>` : "";
}

function badge(field) {
  const o = origin(field);
  return `<span class="prov-badge ${o.cls}" title="${esc(o.title)}">${esc(o.label)}</span>`;
}

/** The user's description again, with each phrase Gemini quoted for a field marked and linked to that field. */
function echoHtml(spec) {
  const text = spec?.raw_description || document.getElementById("prompt-input")?.value || "";
  const stated = spec?.stated_fields || {};
  const lower = text.toLowerCase();
  const ranges = [];
  for (const [field, quote] of Object.entries(stated)) {
    const q = String(quote || "");
    const i = q ? lower.indexOf(q.toLowerCase()) : -1;
    if (i < 0 || ranges.some((r) => i < r.end && i + q.length > r.start)) continue;
    ranges.push({ start: i, end: i + q.length, field });
  }
  if (!ranges.length) return "";
  ranges.sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  ranges.forEach((r, n) => {
    const stale = origin(r.field).cls !== "prov-from-text" ? " is-stale" : "";
    out += esc(text.slice(pos, r.start));
    out += `<mark class="echo-mark${stale}" data-field="${esc(r.field)}" style="--i:${n}" title="${esc(r.field)}">${esc(text.slice(r.start, r.end))}</mark>`;
    pos = r.end;
  });
  out += esc(text.slice(pos));
  return `<p class="mission-echo"><span class="echo-label">Your words, as Gemini read them</span>${out}</p>`;
}

function renderSummary() {
  const el = document.getElementById("intake-summary");
  if (!el) return;
  const spec = ctx.getSpec();
  const screen = document.getElementById("screen-intake");
  if (screen) screen.dataset.intakeState = lastError ? "error" : lastIntake ? "parsed" : "idle";
  el.classList.toggle("is-entering", animateNext && !reducedMotion());
  if (lastError) {
    el.innerHTML = `<div class="intake-summary-line warn">⚠ Intake failed: ${esc(lastError)}. Showing the local spec; check every field.</div>`;
    return;
  }
  if (!lastIntake) {
    el.innerHTML = `<div class="intake-summary-line muted">Describe the aircraft and press <b>Parse</b>, or pick a demo scenario. Every field below shows where its value comes from.</div>`;
    return;
  }
  const fields = Object.keys(spec).filter((k) => !["name", "raw_description", "defaulted_fields", "stated_fields"].includes(k));
  const counts = { "prov-from-text": 0, "prov-inferred": 0, "prov-cited": 0, "prov-user": 0 };
  fields.forEach((f) => (counts[origin(f).cls] = (counts[origin(f).cls] || 0) + 1));
  const parser = lastIntake.sources?.[0]?.replace(/^Project description, parsed by /, "") || "parser";
  const parts = [
    `<span class="intake-summary-title"><b>${esc(spec.name || "Project")}</b> <span class="muted">parsed by ${esc(parser)}</span></span>`,
    `<span class="prov-badge prov-from-text">${counts["prov-from-text"]} from your text</span>`,
    `<span class="prov-badge prov-inferred">${counts["prov-inferred"]} Gemini inferred</span>`,
    `<span class="prov-badge prov-cited">${counts["prov-cited"]} cited defaults</span>`,
  ];
  if (counts["prov-user"]) parts.push(`<span class="prov-badge prov-user">${counts["prov-user"]} edited</span>`);
  const warnings = (lastIntake.warnings || []).map((w) => `<div class="intake-summary-line warn">⚠ ${esc(w)}</div>`).join("");
  el.innerHTML = `<div class="intake-summary-line intake-summary-legend">${parts.join(" ")}</div>${warnings}
    <div class="intake-summary-line muted">Hover a badge for its source. Gemini only reads your text; every number is converted, checked or defaulted by Python with a citation.</div>`;
}

export function renderIntakeCards() {
  const container = document.getElementById("intake-cards");
  if (!container || !ctx) return;
  const s = ctx.getSpec();

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
        { key: "reserve_min", label: "Reserve (min)", val: (s.reserve_s / 60).toFixed(0), step: 5 },
      ],
    },
    {
      title: "3. Wing & Aerodynamics",
      fields: [
        { key: "aspect_ratio", label: "Aspect Ratio (AR)", val: s.aspect_ratio, step: 0.1 },
        { key: "taper_ratio", label: "Taper Ratio (λ)", val: s.taper_ratio, step: 0.05 },
        { key: "thickness_to_chord", label: "Airfoil t/c", val: s.thickness_to_chord, step: 0.01 },
        { key: "cl_max", label: "CL max", val: s.cl_max, step: 0.1 },
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

  const fieldOf = (key) => FORM_KEY_TO_FIELD[key] || (key === "reserve_min" ? "reserve_s" : key);

  const GROUP_DELAY = { "prov-from-text": 0, "prov-user": 0, "prov-inferred": 450, "prov-cited": 900 };
  let rowIdx = 0;
  const rowAttrs = (key) => {
    const field = fieldOf(key);
    const delay = (GROUP_DELAY[origin(field).cls] ?? 900) + rowIdx++ * 35;
    return `data-field="${esc(field)}" style="--d:${delay}ms"`;
  };
  container.classList.toggle("is-entering", animateNext && !reducedMotion());
  container.innerHTML = cards
    .map(
      (c) => `
      <div class="panel intake-card">
        <h3>${esc(c.title)}</h3>
        ${c.fields
          .map((f) => {
            const b = badge(fieldOf(f.key));
            if (f.type === "select") {
              const opts = f.options.map((o) => `<option value="${o}" ${o === f.val ? "selected" : ""}>${o}</option>`).join("");
              return `<div class="field-row" ${rowAttrs(f.key)}><span class="field-label">${esc(f.label)}</span>${b}<select data-spec-key="${f.key}">${opts}</select>${quoteLine(fieldOf(f.key))}</div>`;
            }
            return `<div class="field-row" ${rowAttrs(f.key)}><span class="field-label">${esc(f.label)}</span>${b}<input type="number" step="${f.step}" value="${f.val}" data-spec-key="${f.key}" />${quoteLine(fieldOf(f.key))}</div>`;
          })
          .join("")}
      </div>`
    )
    .join("");

  if (animateNext && !reducedMotion()) countUp(container);
  const lbl = document.getElementById("spec-summary-label");
  if (lbl) lbl.innerHTML = disclosureLabel(ctx.getSpec());
  container.querySelectorAll("[data-spec-key]").forEach((el) => {
    el.addEventListener("change", () => {
      const spec = ctx.getSpec();
      const k = el.dataset.specKey;
      const v = el.tagName === "SELECT" ? el.value : Number(el.value);
      if (k === "range_km") spec.range_m = v * 1000.0;
      else if (k === "cruise_kt") spec.cruise_speed_ms = +(v * 0.514444).toFixed(2);
      else if (k === "stall_kt") spec.stall_speed_ms = +(v * 0.514444).toFixed(2);
      else if (k === "reserve_min") spec.reserve_s = v * 60.0;
      else spec[k] = v;
      const field = fieldOf(k);
      if (spec.defaulted_fields) delete spec.defaulted_fields[field]; // now the user's value
      edited.add(field);
      renderIntakeCards();
      ctx.onSpecChanged?.();
    });
  });
  renderSummary();
}

/** Values count up into the number fields after a parse (display only: no change events fire). */
function countUp(container) {
  container.querySelectorAll('input[type="number"]').forEach((input) => {
    const finalStr = input.value;
    const target = Number(finalStr);
    if (!Number.isFinite(target) || target === 0) return;
    const decimals = (finalStr.split(".")[1] || "").length;
    const delay = parseFloat(input.closest(".field-row")?.style.getPropertyValue("--d")) || 0;
    const dur = 750;
    let t0 = null;
    const step = (t) => {
      if (!input.isConnected) return;
      if (t0 === null) t0 = t + delay;
      const k = Math.min(1, Math.max(0, (t - t0) / dur));
      const e = 1 - Math.pow(1 - k, 3);
      input.value = k >= 1 ? finalStr : (target * e).toFixed(decimals);
      if (k < 1) requestAnimationFrame(step);
    };
    input.value = (0).toFixed(decimals);
    requestAnimationFrame(step);
  });
}

/** Hovering a marked phrase lights its field, and the other way round. */
function wireLinking() {
  const screen = document.getElementById("screen-intake");
  if (!screen || screen.dataset.linkWired) return;
  screen.dataset.linkWired = "1";
  const set = (field, on) =>
    screen.querySelectorAll(`[data-field="${CSS.escape(field)}"]`).forEach((n) => n.classList.toggle("is-linked", on));
  screen.addEventListener("pointerover", (e) => {
    const f = e.target.closest?.("[data-field]")?.dataset.field;
    if (f) set(f, true);
  });
  screen.addEventListener("pointerout", (e) => {
    const f = e.target.closest?.("[data-field]")?.dataset.field;
    if (f) set(f, false);
  });
}

/** Parse `description` with Gemini (server-side), then optionally apply preset overrides. */
async function parse(description, overrides = null) {
  ctx.setStatus?.("Parsing mission with Gemini...", true);
  const screen = document.getElementById("screen-intake");
  if (screen) screen.dataset.intakeState = "parsing";
  const btn = document.getElementById("btn-parse");
  if (btn) btn.disabled = true;
  try {
    const res = await parseIntake(description);
    lastIntake = res;
    lastError = null;
    edited.clear();
    parsedSpec = structuredClone(res.spec);
    const spec = res.spec;
    for (const [k, v] of Object.entries(overrides || {})) {
      if (spec[k] !== v) {
        spec[k] = v;
        if (spec.defaulted_fields) delete spec.defaulted_fields[k];
        edited.add(k);
      }
    }
    ctx.setSpec(spec);
    animateNext = true;
    setTimeout(() => (animateNext = false), 0);
    ctx.setStatus?.("Spec parsed: confirm to run the spiral", false);
  } catch (err) {
    lastIntake = null;
    parsedSpec = null;
    lastError = err?.message || String(err);
    const fallback = { ...structuredClone(ctx.defaultSpec), ...(overrides || {}), raw_description: description };
    ctx.setSpec(fallback);
    ctx.setStatus?.("Intake failed: local spec", false);
  } finally {
    if (btn) btn.disabled = false;
    renderIntakeCards();
    ctx.onSpecChanged?.();
  }
}

/** Favicon: the Spiral mark on a dark tile, inline so it works offline (index.html has no icon link). */
function installFavicon() {
  if (document.querySelector('link[rel="icon"]')) return;
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.href = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'><rect width='256' height='256' rx='56' fill='#0c121b'/><path d='M38 146A90 90 0 0 1 218 146A56 56 0 0 1 106 146' fill='none' stroke='#e7edf4' stroke-width='30' stroke-linecap='round'/><circle cx='162' cy='146' r='17' fill='#38bdf8'/></svg>");
  document.head.appendChild(link);
}

/**
 * Screen 4 readability: app.js's mdToHtml has no table syntax, so the report's markdown tables
 * ("Textbook items behind the numbers") arrive as pipe text. Turn them into real tables.
 * Idempotent: once converted there are no pipe rows left, so the observer does nothing.
 */
function mdTableHtml(block) {
  const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const lines = block.split("\n").filter((l) => l.trim() && !/^\|[\s:|-]+\|$/.test(l.trim()));
  if (lines.length < 2) return block;
  const [head, ...body] = lines;
  const td = (c) => {
    const cls = /^✓/.test(c) ? ' class="verdict-ok"' : /^(✗|✘|×)/.test(c) ? ' class="verdict-bad"' : "";
    return `<td${cls}>${c}</td>`;
  };
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${cells(head)
    .map((c) => `<th>${c}</th>`)
    .join("")}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map(td).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function enhanceReportTables() {
  const el = document.getElementById("report-markdown");
  if (!el || el.dataset.tablesWired) return;
  el.dataset.tablesWired = "1";
  const ROWS = /\|(?:[^\n|]*\|)+(?:\n\|(?:[^\n|]*\|)+)+/g;
  const convert = () => {
    const html = el.innerHTML;
    ROWS.lastIndex = 0;
    if (!ROWS.test(html)) return;
    const out = html.replace(ROWS, (block) => mdTableHtml(block));
    if (out !== html) el.innerHTML = out;
  };
  new MutationObserver(convert).observe(el, { childList: true });
  convert();
}

const SPIRAL_D = "M24 139A104 104 0 0 1 232 139A82 82 0 0 1 68 139A60 60 0 0 1 188 139A38 38 0 0 1 112 139";

/** Screen 1 opener, built at init: animated spiral hero, scenario cards, and the prompt shell (thinking state). */
function buildHero() {
  const screen = document.getElementById("screen-intake");
  const host = screen?.querySelector(".intake-hero") || screen;
  if (!host || host.querySelector(".mission-hero")) return;
  const hero = document.createElement("div");
  hero.className = "mission-hero";
  hero.innerHTML = `
    <svg class="hero-spiral" viewBox="0 0 256 256" aria-hidden="true">
      <circle class="hero-orbit" cx="128" cy="134" r="122" pathLength="1" />
      <path class="hero-spiral-path" d="${SPIRAL_D}" pathLength="1" />
      <circle class="hero-spiral-dot" cx="150" cy="139" r="15" />
    </svg>
    <div class="hero-copy">
      <h1 class="hero-title">Describe the aircraft.<br />Watch the design spiral close.</h1>
      <p class="hero-sub">Gemini reads your mission; Python sizes it from Raymer, citing every number.</p>
    </div>`;
  host.prepend(hero);

  host.querySelectorAll("[data-preset]").forEach((btn) => {
    if (btn.dataset.cardified) return;
    const text = btn.textContent.trim();
    const m = text.match(/^(.*?)\s*\((.*)\)\s*$/);
    btn.dataset.cardified = "1";
    btn.classList.add("scenario-card");
    btn.innerHTML = `<span class="sc-title">${esc(m ? m[1] : text)}</span>${m ? `<span class="sc-meta">${esc(m[2])}</span>` : ""}`;
  });

  const input = document.getElementById("prompt-input");
  if (input && !input.parentElement.classList.contains("prompt-shell")) {
    const shell = document.createElement("div");
    shell.className = "prompt-shell";
    input.parentNode.insertBefore(shell, input);
    shell.appendChild(input);
    shell.insertAdjacentHTML(
      "beforeend",
      `<div class="prompt-scan" aria-hidden="true"></div><div class="prompt-status" aria-live="polite">✦ Gemini is reading your mission…</div>`
    );
  }
}

/* ======================= Chat landing (Screen 1) ======================= */
const SUGGEST = {
  touring: { title: "4-seat touring aircraft", meta: "1,000 km, 115 kt cruise. Converges in a few laps." },
  diverging: { title: "London → New York, non-stop", meta: "5,570 km in a 4-seat tourer. Infeasible: watch Gemini propose a fix." },
  high_ar: { title: "High-aspect-ratio survey wing", meta: "AR 13.5 slender wing. Trips a textbook range warning." },
};
let hero = null;
let thread = null;
let busy = false;

const typeOut = (el, text) =>
  new Promise((resolve) => {
    if (reducedMotion()) { el.textContent = text; return resolve(); }
    let i = 0;
    const step = () => {
      i = Math.min(text.length, i + 3);
      el.textContent = text.slice(0, i);
      if (i < text.length) setTimeout(step, 14); else resolve();
    };
    step();
  });

function scrollChat() {
  const end = document.getElementById("chat-end");
  end?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "end" });
}

function bubble(role, html) {
  const el = document.createElement("div");
  el.className = `chat-msg chat-${role}`;
  el.innerHTML = role === "assistant" ? `<div class="chat-avatar" aria-hidden="true">${spiralSvg("avatar")}</div><div class="chat-body">${html}</div>` : `<div class="chat-body">${html}</div>`;
  thread.appendChild(el);
  scrollChat();
  return el;
}

function spiralSvg(cls) {
  return `<svg class="spiral-${cls}" viewBox="0 0 256 256" aria-hidden="true"><path class="sp-path" d="${SPIRAL_D}" pathLength="1"/><circle class="sp-dot" cx="150" cy="139" r="15"/></svg>`;
}

function specCounts(spec) {
  const fields = Object.keys(spec || {}).filter((k) => !["name", "raw_description", "defaulted_fields", "stated_fields"].includes(k));
  const c = { total: fields.length, "prov-from-text": 0, "prov-inferred": 0, "prov-cited": 0, "prov-user": 0 };
  fields.forEach((f) => (c[origin(f).cls] = (c[origin(f).cls] || 0) + 1));
  return c;
}

function disclosureLabel(spec) {
  const c = specCounts(spec);
  const edited = c["prov-user"] ? `, ${c["prov-user"]} edited` : "";
  return `View full spec: ${c.total} parameters <span class="muted">(${c["prov-from-text"]} from you, ${c["prov-inferred"]} inferred, ${c["prov-cited"]} cited defaults${edited})</span>`;
}

function chip(label, value, field) {
  const o = origin(field);
  return `<span class="kv-chip ${o.cls}" data-field="${esc(field)}" title="${esc(o.title)}"><span class="kv-k">${esc(label)}</span><span class="kv-v">${esc(value)}</span></span>`;
}

function chipsHtml(s) {
  const kt = (ms) => Math.round(ms / 0.514444);
  return [
    chip("Range", `${Math.round(s.range_m / 1000).toLocaleString()} km`, "range_m"),
    chip("Cruise", `${kt(s.cruise_speed_ms)} kt`, "cruise_speed_ms"),
    chip("Stall", `${kt(s.stall_speed_ms)} kt`, "stall_speed_ms"),
    chip("Passengers", `${s.passenger_count}`, "passenger_count"),
    chip("Reserve", `${Math.round(s.reserve_s / 60)} min`, "reserve_s"),
  ].join("");
}

/** Mark the user's own phrases (stated_fields) inside their bubble. */
function markUserBubble(el, text, spec) {
  const html = echoHtml({ ...spec, raw_description: text });
  const body = el.querySelector(".chat-body");
  if (html && body) body.innerHTML = html.replace(/^<p class="mission-echo"><span class="echo-label">[^<]*<\/span>/, "").replace(/<\/p>$/, "");
}

/* ---------------------- Ask the textbook (POST /api/ask) ---------------------- */
const ASK_PREFIX = /^ask raymer:?\s*/i;
function isQuestion(text) {
  const t = String(text || "").trim().replace(ASK_PREFIX, "");
  return /\?\s*$/.test(t) || /^(what|which|how|why|when|should|can)\b/i.test(t);
}

async function askTextbook(question) {
  const res = await fetch(`${API_BASE}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

/** Small, safe markdown: paragraphs, headings, lists, tables, **bold**, *italic*, `code`. Escapes first. */
function mdLite(md) {
  const inline = (t) =>
    t
      .split(/(`[^`]+`|\$[^$\n]+\$)/g)
      .map((part) =>
        part.length > 1 && part.startsWith("`") && part.endsWith("`")
          ? `<code>${part.slice(1, -1)}</code>`
          : part.length > 2 && part.startsWith("$") && part.endsWith("$")
          ? `<span class="tex">${part.slice(1, -1)}</span>`
          : part.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>")
      )
      .join("");
  const block = (b) => {
    const lines = b.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) return "";
    const head = lines[0].match(/^#{1,6}\s+(.*)$/);
    if (head) return `<h4>${inline(head[1])}</h4>` + block(lines.slice(1).join("\n"));
    if (lines.length >= 2 && lines.every((l) => /^\s*\|.*\|\s*$/.test(l))) return mdTableHtml(lines.map(inline).join("\n"));
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ""))}</li>`).join("")}</ul>`;
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  };
  return esc(String(md || "")).replace(/\r\n/g, "\n").split(/\n{2,}/).map(block).join("");
}

const KIND_LABEL = { equations: "Equation", tables: "Table", rules_of_thumb: "Rule of thumb" };

/** A few rows of a cited table; rows mentioning "single engine" are highlighted and kept. */
function miniTable(columns, rows) {
  const str = (v) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const cols = (Array.isArray(columns) ? columns : []).map(str);
  const HL = /single[\s-]?engine/i;
  const all = rows.map((r, i) => {
    const cells = Array.isArray(r) ? r : r && typeof r === "object" ? (cols.length ? cols.map((c) => r[c]) : Object.values(r)) : [r];
    return { cells, i, hl: HL.test(cells.map(str).join(" ")) };
  });
  const hl = all.filter((x) => x.hl).slice(0, 3);
  const rest = all.filter((x) => !x.hl).slice(0, Math.max(0, 4 - hl.length));
  const shown = [...hl, ...rest].sort((a, b) => a.i - b.i);
  const head = cols.length ? `<thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>` : "";
  const body = shown.map((x) => `<tr${x.hl ? ' class="is-hl"' : ""}>${x.cells.map((v) => `<td>${esc(str(v))}</td>`).join("")}</tr>`).join("");
  const more =
    all.length > shown.length
      ? `<div class="cite-more">Showing ${shown.length} of ${all.length} rows${hl.length ? "; single-engine rows highlighted" : ""}</div>`
      : "";
  return `<div class="cite-table-wrap"><table class="cite-table">${head}<tbody>${body}</tbody></table></div>${more}`;
}

function citeDetail(c, verdict) {
  const has = (v) => v !== undefined && v !== null && v !== "";
  const kind = KIND_LABEL[c.kind] || "";
  const page = has(c.book_page) ? `book page ${esc(c.book_page)}` : "";
  const name = c.name || c.title || c.quantity;
  const out = [];
  if (name && name !== c.citation) out.push(`<div class="cite-title">${esc(name)}</div>`);
  if (has(c.value)) out.push(`<div class="cite-value">${esc(c.value)}${has(c.units) ? ` <span class="muted">${esc(c.units)}</span>` : ""}</div>`);
  if (c.latex) out.push(`<pre class="cite-latex">${esc(c.latex)}</pre>`);
  if (Array.isArray(c.rows) && c.rows.length) out.push(miniTable(c.columns, c.rows));
  const applies = c.applicability || c.applies_to;
  if (applies) out.push(`<p class="cite-para"><span class="muted">Applies to:</span> ${esc(typeof applies === "string" ? applies : JSON.stringify(applies))}</p>`);
  if (c.paraphrase) out.push(`<p class="cite-para">${esc(c.paraphrase)}</p>`);
  out.push(`<div class="cite-meta">${[kind, page, verdict].filter(Boolean).join(", ")}</div>`);
  return out.join("");
}

/** One expandable chip per textbook item; a green check means the critic confirmed it against the page. */
function citeChips(citations) {
  const list = (Array.isArray(citations) ? citations : []).filter((c) => c && typeof c === "object");
  if (!list.length) return "";
  return `<div class="cite-list">${list
    .map((c, i) => {
      const status = String(c.status || "");
      const ok = status.startsWith("verified");
      const n = c.n ?? i + 1;
      const kind = KIND_LABEL[c.kind] || "";
      const label = c.citation || c.title || c.name || `Source ${n}`;
      const verdict = ok
        ? status === "verified_minor_fix"
          ? "critic verified after a minor fix"
          : "critic verified against the page"
        : "not verified by the critic";
      return `<details class="cite-item${ok ? " is-verified" : ""}" data-n="${esc(n)}"><summary class="cite-pill" title="${esc(verdict)}"><span class="cite-mark">${ok ? "✓" : "§"}</span><span class="cite-num">${esc(n)}</span><span class="cite-label">${esc(label)}</span>${kind ? `<span class="cite-kind">${kind}</span>` : ""}</summary><div class="cite-detail">${citeDetail(c, verdict)}</div></details>`;
    })
    .join("")}</div>`;
}

/** Turn [n] / [1, 2] markers into small buttons that open the matching citation. */
function linkRefs(html, citations) {
  const known = new Set((Array.isArray(citations) ? citations : []).map((c, i) => String(c?.n ?? i + 1)));
  if (!known.size) return html;
  return html.replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g, (m, list) => {
    const ns = list.split(/\s*,\s*/);
    if (!ns.every((n) => known.has(n))) return m;
    return ns.map((n) => `<button type="button" class="cite-ref" data-cite="${n}" title="Show source ${n}">${n}</button>`).join("");
  });
}

async function ask(text) {
  busy = true;
  document.getElementById("screen-intake")?.classList.add("chat-started");
  clearComposer();
  const question = String(text).trim().replace(ASK_PREFIX, "").trim() || String(text).trim();
  bubble("user", esc(text));
  const botEl = bubble("assistant", `<div class="typing">§ Looking it up in Raymer<span class="dots"><i></i><i></i><i></i></span></div>`);
  const body = botEl.querySelector(".chat-body");
  hero?.setMode?.("thinking");
  ctx.setStatus?.("Asking the textbook...", true);
  try {
    const res = await askTextbook(question);
    const md = typeof res?.answer_markdown === "string" ? res.answer_markdown : typeof res?.answer === "string" ? res.answer : "";
    const chips = citeChips(res?.citations);
    if (!md.trim() && !chips) throw Object.assign(new Error("The textbook returned an empty answer"), { status: 0 });
    const nVer = (Array.isArray(res?.citations) ? res.citations : []).filter((c) => String(c?.status || "").startsWith("verified")).length;
    const src = typeof res?.source === "string" ? res.source : "";
    const srcLine =
      src && src !== "unavailable"
        ? `<div class="answer-source reveal">${src === "retrieval only" ? "Retrieved straight from the book's extracted items." : `Answered by ${esc(src)}, grounded in the book items below.`}</div>`
        : "";
    body.innerHTML = `<div class="answer-md reveal">${linkRefs(mdLite(md), res?.citations)}</div>${srcLine}${
      chips ? `<div class="cite-head reveal">From the book${nVer ? `: ${nVer} item${nVer === 1 ? "" : "s"} checked against the page by the critic` : ""}</div><div class="reveal">${chips}</div>` : ""
    }`;
    hero?.setMode?.("ready");
    ctx.setStatus?.("Answered from the textbook", false);
  } catch (err) {
    const offline = [404, 405, 501, 502, 503].includes(err?.status) || err instanceof TypeError || err instanceof SyntaxError;
    body.innerHTML = `<p class="reply-text">${
      offline
        ? "The textbook is offline right now, so I can't look that up. You can still describe a mission and I'll size it."
        : `I couldn't get an answer from the textbook (${esc(err?.message || err)}). Try rephrasing the question.`
    }</p>`;
    hero?.setMode?.("idle");
    ctx.setStatus?.(offline ? "Textbook offline" : "Ask failed", false);
  } finally {
    busy = false;
    scrollChat();
  }
}

function clearComposer() {
  const input = document.getElementById("chat-input");
  if (input) {
    input.value = "";
    input.style.height = "";
  }
}

async function send(text, overrides = null) {
  text = String(text || "").trim();
  if (!text || busy) return;
  if (!overrides && isQuestion(text)) return ask(text);
  busy = true;
  document.getElementById("screen-intake")?.classList.add("chat-started");
  clearComposer();
  // retire the previous reply's live form so only one #intake-cards exists
  thread.querySelectorAll(".chat-live").forEach((n) => n.remove());
  const userEl = bubble("user", esc(text));
  const botEl = bubble("assistant", `<div class="typing">✦ Gemini is reading your mission<span class="dots"><i></i><i></i><i></i></span></div>`);
  hero?.setMode?.("thinking");
  ctx.setStatus?.("Parsing mission with Gemini...", true);
  const body = botEl.querySelector(".chat-body");
  try {
    const res = await parseIntake(text);
    lastIntake = res;
    lastError = null;
    edited.clear();
    parsedSpec = structuredClone(res.spec);
    const spec = res.spec;
    for (const [k, v] of Object.entries(overrides || {})) {
      if (spec[k] !== v) {
        spec[k] = v;
        if (spec.defaulted_fields) delete spec.defaulted_fields[k];
        edited.add(k);
      }
    }
    ctx.setSpec(spec);
    markUserBubble(userEl, text, spec);
    const c = specCounts(spec);
    const people = (spec.crew_count || 0) + (spec.passenger_count || 0);
    const summary = `Here's the mission as I read it: a ${people}-seat aircraft flying ${Math.round(spec.range_m / 1000).toLocaleString()} km at ${Math.round(spec.cruise_speed_ms / 0.514444)} kt. ${c["prov-from-text"]} values come from your words, ${c["prov-inferred"]} I inferred, and ${c["prov-cited"]} are cited textbook defaults.`;
    body.innerHTML = `<p class="reply-text"></p>`;
    await typeOut(body.querySelector(".reply-text"), summary);
    const warns = (res.warnings || []).map((w) => `<div class="chat-warn">⚠ ${esc(w)}</div>`).join("");
    body.insertAdjacentHTML(
      "beforeend",
      `<div class="kv-chips reveal">${chipsHtml(spec)}</div>${warns}
      <details class="spec-details chat-live reveal"><summary id="spec-summary-label">${disclosureLabel(spec)}</summary><div id="intake-summary" class="intake-summary"></div><div id="intake-cards" class="spec-cards-grid"></div></details>
      <div class="chat-actions chat-live reveal"><button type="button" class="btn primary chat-run">Run the design spiral →</button><button type="button" class="btn secondary chat-edit">Edit spec</button></div>`
    );
    renderIntakeCards();
    ctx.onSpecChanged?.();
    hero?.setMode?.("ready");
    ctx.setStatus?.("Spec parsed: run the design spiral", false);
  } catch (err) {
    lastIntake = null;
    parsedSpec = null;
    lastError = err?.message || String(err);
    const fallback = { ...structuredClone(ctx.defaultSpec), ...(overrides || {}), raw_description: text };
    ctx.setSpec(fallback);
    ctx.onSpecChanged?.();
    body.innerHTML = `<p class="reply-text">I couldn't read that mission just now (${esc(lastError)}). I've loaded the baseline touring spec instead, so you can still run the spiral, or try rephrasing.</p>
      <div class="chat-actions chat-live"><button type="button" class="btn secondary chat-run">Run with the baseline spec</button></div>`;
    hero?.setMode?.("idle");
    ctx.setStatus?.("Intake failed: baseline spec loaded", false);
  } finally {
    busy = false;
    scrollChat();
  }
}

function buildChat() {
  const screen = document.getElementById("screen-intake");
  if (!screen || screen.querySelector(".chat-wrap")) return;
  const suggestions = Object.keys(ctx.presets || {})
    .map((k) => {
      const t = SUGGEST[k] || { title: k, meta: ctx.presets[k].prompt };
      return `<button type="button" class="suggest-card${k === "diverging" ? " is-dramatic" : ""}" data-preset="${esc(k)}"><span class="sc-title">${esc(t.title)}</span><span class="sc-meta">${esc(t.meta)}</span></button>`;
    })
    .join("") +
    `<button type="button" class="suggest-card is-ask" data-ask="Ask Raymer: what tail volume coefficients suit a GA single?"><span class="sc-title">Ask Raymer</span><span class="sc-meta">What tail volume coefficients suit a GA single?</span></button>`;
  screen.innerHTML = `
    <div class="chat-bg" aria-hidden="true"></div>
    <div class="chat-wrap">
      <div class="chat-thread" id="chat-thread" aria-live="polite">
        <div class="chat-empty">
          ${spiralSvg("hero")}
          <h1 class="chat-greeting">What are we designing today?</h1>
          <p class="chat-sub">Describe a mission in plain English. Gemini reads it; Python sizes the aircraft from Raymer and cites every number.</p>
          <div class="chat-suggestions">${suggestions}</div>
        </div>
      </div>
      <div id="chat-end"></div>
      <form class="chat-composer" id="chat-form">
        <textarea id="chat-input" rows="1" placeholder="Describe a mission, or ask Raymer a question…" aria-label="Describe your aircraft mission"></textarea>
        <button type="submit" id="chat-send" class="chat-send" aria-label="Send">↑</button>
      </form>
      <p class="chat-hint">Enter sends, Shift+Enter adds a line. End with a question mark to ask the textbook.</p>
    </div>`;
  thread = document.getElementById("chat-thread");
  const input = document.getElementById("chat-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; });
  document.getElementById("chat-form").addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });
  screen.addEventListener("click", (e) => {
    const ref = e.target.closest(".cite-ref");
    if (ref) {
      const item = ref.closest(".chat-msg")?.querySelector(`.cite-item[data-n="${CSS.escape(ref.dataset.cite)}"]`);
      if (item) {
        item.open = true;
        item.classList.remove("flash");
        void item.offsetWidth;
        item.classList.add("flash");
        item.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest" });
      }
      return;
    }
    const askCard = e.target.closest("[data-ask]");
    if (askCard) {
      send(askCard.dataset.ask);
      return;
    }
    const preset = e.target.closest("[data-preset]");
    if (preset) {
      const p = ctx.presets?.[preset.dataset.preset];
      if (p) send(p.prompt, p.overrides);
      return;
    }
    if (e.target.closest(".chat-run")) { ctx.onConfirm?.(); return; }
    if (e.target.closest(".chat-edit")) {
      const d = thread.querySelector(".spec-details");
      if (d) { d.open = true; d.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" }); }
    }
  });
  const layer = screen.querySelector(".chat-bg");
  import("./hero3d.js")
    .then((m) => { hero = m.mountHero?.(layer) || null; hero?.setMode?.("idle"); })
    .catch(() => {});
}

/**
 * Wire Screen 1. `options`:
 *   getSpec(), setSpec(spec)   shared MissionSpec state (owned by app.js)
 *   defaultSpec, presets       DEFAULT_SPEC and PRESETS from app.js
 *   setStatus(text, busy)      status pill
 *   onSpecChanged()            e.g. sync Screen 2 sliders
 *   onConfirm()                start the spiral stream (Screen 2)
 */
export function initIntake(options) {
  ctx = options;
  installFavicon();
  enhanceReportTables();
  buildChat();
  wireLinking();
  renderIntakeCards();
}
