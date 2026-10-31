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

import { parseIntake } from "./api_client.js";

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
  el.innerHTML = `${echoHtml(spec)}<div class="intake-summary-line intake-summary-legend">${parts.join(" ")}</div>${warnings}
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
  buildHero();
  wireLinking();
  enhanceReportTables();
  document.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = ctx.presets?.[btn.dataset.preset];
      if (!p) return;
      document.querySelectorAll("[data-preset]").forEach((b) => b.classList.toggle("is-active", b === btn));
      const input = document.getElementById("prompt-input");
      if (input) input.value = p.prompt;
      parse(p.prompt, p.overrides);
    });
  });
  document.getElementById("btn-parse")?.addEventListener("click", () => {
    parse(document.getElementById("prompt-input")?.value || "");
  });
  document.getElementById("btn-run-spiral")?.addEventListener("click", () => ctx.onConfirm?.());
  renderIntakeCards();
}
