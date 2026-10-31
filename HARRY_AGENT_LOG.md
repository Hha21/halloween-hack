# Harry Agent Log (`harry/agents`)

> **READ FIRST, for any agent working on Tharm's part or integrating with Harry's.**
> Companion to [`THARM_AGENT_LOG.md`](THARM_AGENT_LOG.md). Harry's agent writes here; Tharm's agent writes there.
> Neither side edits the other's files: requests go in these logs.
> Read before touching code: [`DESIGN_SPEC.md`](DESIGN_SPEC.md) §7 (work split, final) and §8 (contract), [`spiral/contract.py`](spiral/contract.py), [`README.md`](README.md).

Last updated: 2026-10-31 14:30 GMT. Submission: `main` at 16:00.

**Status of requests:** R1–R6 all done (Tharm's `4e4f61a`, `a9fea6b`; thanks). All 27 tests pass.

---

## ⚠ R7: URGENT, demo-breaking (14:55): relaxation banner and accept button use the wrong field names
`web/app.js:193-196` and `:558-561` read `rel.parameter_path`, `rel.current_value`, `rel.proposed_value` and `rel.reason`. None of these exist. `SpecRelaxationProposal` (`spiral/contract.py`, unchanged since 91c92fc) has:
`field_name` (a MissionSpec field, e.g. `"range_m"` or `"passenger_count"`), `old_value`, `new_value`, `unit` (`"m"` or `"-"`), `reasoning`, `estimated_mtow_kg`.
On the London–New York twist the banner shows `undefined (undefined → undefined)`, and **accept throws a TypeError** (`undefined.replace`). Suggested fix:
```js
// banner (line ~195)
`Gemini proposes: ${rel.field_name} ${rel.old_value} → ${rel.new_value} ${rel.unit} (closes at ${Math.round(rel.estimated_mtow_kg)} kg) — ${rel.reasoning}`
// accept (line ~560)
currentSpec[rel.field_name] = Number(rel.new_value);
if (currentSpec.defaulted_fields) delete currentSpec.defaulted_fields[rel.field_name];
```
Coming next from Harry: `field_name` may be **`passenger_count`** as well as `range_m`. Python computes both options (e.g. "cut range to 4,670 km" or "keep London–NY and fly with 1 passenger, closes at 2,422 kg") and Gemini chooses between them, so the UI must not assume range. Format by `unit`: `"m"` → km, `"-"` → a plain count.

## 0. Screen 1 handover (14:55): now Harry's
Tharm handed Screen 1 (intake & spec confirmation) to Harry in `a9fea6b`. To avoid editing the same lines as Tharm:
- **New, Harry-owned:** `web/intake.js` (Screen 1 logic: presets → Gemini intake, parse, form, badges, summary strip, confirm button), `web/intake.css`, and `web/theme.css` (visual overrides for all screens).
- **One-time edits in Tharm's files** (please keep them, and don't edit these regions):
  - `web/app.js`: `import { initIntake, renderIntakeCards } from "./intake.js"`; the old `renderIntakeCards()` and the preset/parse/confirm click handlers are removed; boot calls `initIntake({...})`. `DEFAULT_SPEC` and `PRESETS` stay in `app.js`; `intake.js` reads them via `initIntake`. `renderIntakeCards()` can still be called from anywhere (sliders, relaxation).
  - `web/index.html`: `<link rel="stylesheet" href="intake.css">`, `<div id="intake-summary">` above `#intake-cards`, and the twist chip label is now "London → New York (5,570 km · Infeasible → AI Relaxation)".
- **Screen 1 badges** come from the spec itself, not from an earlier run:
  - `[from your text]` (`.prov-from-text`): stated in the description.
  - `[Gemini inferred]` (`.prov-inferred`): only crew, passengers or load factor.
  - `[cited default]` (`.prov-cited`): Python's default with its citation. These are not Gemini's: Gemini never supplies a number.
  - `[edited]` (`.prov-user`): changed after parsing.
- **Presets** now go through `POST /api/intake` (live Gemini), then apply their overrides.
- **Front-end design agent (Harry's side, running now):** restyles all four screens through a new **`web/theme.css`** (Harry-owned). `intake.css` imports it with `@import`, so it loads after `styles.css` and overrides it. Mostly it overrides your `:root` tokens. It does **not** edit `styles.css`, `index.html` or any of your JS, and doesn't rename ids or classes. Tharm, if a theme rule fights your Screen 2–3 work, say so in your log and we'll drop that rule.
- **Ownership lists:** please add `web/intake.js` and `web/intake.css` to Harry's list in `THARM_AGENT_LOG.md` §3.

## 1. Git & branch status
- `main` = submission. Harry works on `harry/agents` and fast-forwards `main` after the tests pass. Tharm's `de557e7` (CAD loft, Timoshenko FEA, 4-screen UI) is merged; `main` was at `301e465` when this was written.
- Ownership as in `DESIGN_SPEC.md` §7 and `THARM_AGENT_LOG.md` §1. Harry owns `spiral/agent/*`, `server/*`, `scripts/*`, `knowledge/*`, `spiral/tools/{lookup,sizing,spar}.py`, `tests/test_{contract,orchestrator,intake,report}.py`, `fixtures/*` and this file.

## 2. Requests for Tharm (most important first)

| # | Where | Problem | Suggested fix |
|---|---|---|---|
| **R1** | `spiral/tools/fea.py:240-243` | **Demo-critical.** When `ccx` and `gmsh` are on the PATH, `solver_name` becomes "CalculiX + gmsh & Timoshenko...", but `ccx` is never run: the result still comes from the NumPy solver. CalculiX 2.21 is now installed on Harry's laptop (`/usr/bin/ccx`), and `gmsh` is in `.venv/bin`, so a server started with the venv activated will label a NumPy result as CalculiX. | Either run CalculiX for real, or keep the label to what ran (e.g. always "Timoshenko beam FEA (NumPy direct stiffness)"). |
| **R2** | `web/app.js:70` and `:182` | Preset `high_ar` and the material dropdown offer `spar_material: "cfrp_ud"`. It isn't in `knowledge/tables/materials.yaml`, so the run fails on lap 0: `Key 'cfrp_ud' not found`. The spar model is an isotropic metal I-beam; a composite spar would need a laminate model, so Harry isn't adding it. | Use `al_7075_t6` (works: AR 13.5 converges at 1,369 kg, spar 65.8 kg, margin +0.00) and drop `cfrp_ud` from the dropdown. |
| **R3** | `web/app.js:23-56`, `:62` | `DEFAULT_SPEC` still has the old defaults (AR 7.5, taper 0.6) and old reason strings ("Raymer Table 4.1", "MIL-HDBK-5J"). The touring preset overrides `aspect_ratio: 7.5`, so after intake the form shows 7.5 beside the server's reason "Assumed 7.6...". | Take the spec from `POST /api/intake`, or `fixtures/intake_response.json`, and drop the `aspect_ratio` overrides. Current defaults: AR 7.6 (Raymer 2ed Table 4.1), taper 0.45 (p. 56). |
| **R4** | `web/app.js:64-66` | The `diverging` preset (5,500 km, AR 8.5) works: infeasible, with a proposal of 4,580 km at 2,721 kg. The demo script and README use London to New York instead. | Suggest prompt "Four-seat tourer, London to New York non-stop, 5,570 km range, 45 min reserve, cruise 115 kt, stall under 55 kt." with no AR override. Intake never infers a range from city names, so the 5,570 km must be in the text. |
| ~~R5~~ done | `tests/test_tools.py:75` (and `:74`) | Reads the STL with `read_text(encoding="utf-8")`. With CadQuery installed (CadQuery 2.8 is in Harry's `.venv`), the STL is binary and the test fails with `UnicodeDecodeError`. It passes only where CadQuery is absent. | Read bytes, or check for an ASCII `solid` header or the binary 80-byte header + triangle count. |
| ~~R6~~ done | `spiral/tools/geometry.py:99-123`, `fea.py:356-366`, `cad.py` | Citations say "Raymer 6ed". The values are right: they match Raymer **2ed** Table 6.3 (p. 110, GA single a = 4.37, C = 0.23) and Table 6.4 (p. 112, C_HT 0.70, C_VT 0.04) exactly. Also, `verified=True` is set on geometry, CAD and FEA outputs. On Harry's side `verified` means "checked against the cited source" (critic-confirmed book item plus a number match), so the UI's ✓ means "checked against the book". | Read the coefficients from `lookup("aircraft_typical", "ga_single_engine").value["tail_volume_coefficients"]` and `["fuselage_length_regression"]`, and use each row's `source` and `verified` (both verified). Use `verified=False` for solver outputs, or define a separate meaning. |

## 3. What Harry's side does now (on `main`)
- **Intake** (`spiral/agent/gemini.py`, `gemini-3.5-flash`)
  - Gemini reports each requirement with its unit as written and a quote from the description.
  - Python converts the units, applies range checks, and rejects quotes that aren't in the text.
  - Gemini may only infer crew, passengers and load factor.
  - Every unstated field gets a cited default in `defaulted_fields`.
  - There is an offline fallback.
- **Conceptual** (`spiral/tools/sizing.py`): Raymer 2ed Ch. 3 and 5. Every constant comes from `knowledge/tables/*.yaml` with its citation. The weight closure is solved by bisection.
- **Preliminary** (`spiral/tools/spar.py`): Raymer 2ed Ch. 14.
  - Loads: Schrenk (Fig. 14.10), at ultimate load (n = 5.7).
  - Caps: sized to compression yield F_cy. The tension margin against F_tu is reported.
  - Web: thickness = max(shear strength F_su, no shear buckling by Eq. 14.37 with K = 4.8, minimum gauge).
  - New: if a shallow spar still exceeds F_cy, the caps are thickened, so a sized spar never has a negative margin.
- **Materials** (`materials.yaml`): from Raymer Table 14.3.
  - New keys: `compression_yield_strength_pa`, `shear_modulus_pa`.
  - `density_kg_m3` is still there, for `cad.py`.
  - `SparSizingResult.allowable_yield_stress_pa` is now **F_cy = 337.8 MPa**; your FEA margin uses it.
- **Loop and infeasibility** (`spiral/agent/orchestrator.py`): converged when |ΔMTOW| < 0.5%. Infeasible when:
  - the fuel fraction is above 0.42;
  - MTOW grows more than 2% for 4 laps; or
  - the spiral converges above the single-engine class limit of 2,722 kg.

  The relaxation is **computed**: bisection on range, re-running the spiral each time. Gemini only writes the reasoning, which must pass a number check.
- **Report** (`generate_report_markdown`): Python writes every table; Gemini writes the "Summary" and "Discussion" paragraphs, checked so they contain no numbers that aren't in the state. It has tables now, so render it as markdown (you already do, with `mdToHtml`).
- **Provenance:** all 101 numeric fields in `DesignState` have an entry. If a tool gives no per-value provenance, the orchestrator adds an unverified entry naming that tool's `sources`.
- **Knowledge base** (`scripts/extract_knowledge.py`): the whole of Raymer 2ed, extracted by Gemini and checked by an independent critic model. It lives in `knowledge/extracted/` (gitignored). `search_knowledge()` is in `lookup.py`.

## 4. Stream order the UI will see
- **`/api/spiral/stream`:** 4 `log` entries with `stage="conceptual"` (cited layout choices), then a `log` + `lap` pair for each lap, then `converged`.
- **When infeasible:** a `log` (level `error`, the reason), then about 4 s while Gemini writes, then a `log` (level `warning`, "Proposed change: ..."), then `infeasible`.
- **`/api/components/spar/stream`:** `component_step` (cad running/done, fea running/done), then `log`, then `component_done`.

## 5. Demo inputs (measured on `main`, live Gemini)

| Input | Result |
|---|---|
| "Four-seat touring aircraft, 1,000 km range with 45 min reserve, cruise 115 kt, stall under 55 kt." | Converges in 3 laps: 1,319 → 1,262 → 1,257 kg. Spar 35.5 kg, margin +0.10. Your FEA agrees with beam theory to 99.3% (stress) and 98.9% (deflection). Report with Gemini narrative in ~3 s. |
| Same spec, range edited to 5,570 km | Infeasible after 4 laps (3,377 → 3,467 kg, above 2,722 kg). Proposal: 4,670 km at 2,719 kg. |
| "London to New York non-stop, 5,570 km range." (other values default) | 3,379 → 3,484 kg, then infeasible. Proposal: 4,660 km at 2,720 kg. |

## 6. How to run (Harry's laptop)
```
source .venv/bin/activate          # Python 3.12 venv; puts gmsh on the PATH (see R1)
uvicorn server.app:app --port 8000
python -m pytest -q                # 27 tests, all pass
python3 -m unittest discover -s tests   # system Python: all pass
```

## 7. REA verification (Harry, 14:30)
- `python3 -m unittest discover -s tests`: 27 tests, OK. `.venv` pytest after merging `4e4f61a`: 27 passed.
- Live smoke test (`uvicorn` + live Gemini, all endpoints, both demo paths): passed. Artifacts: `spar.step` 129 kB, `spar.stl`, `spar_stress_mesh.json` 38.6 kB, all `200 OK`.
- Frontend check: `web/api_client.js` calls all 6 endpoints and handles every SSE event type.
