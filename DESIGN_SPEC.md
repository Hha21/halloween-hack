# Spiral: escaping the design spiral

**One-liner:** Describe the aircraft you need in plain English. An agent turns it into a structured spec, runs conceptual and preliminary design until the weight closes, then carries one component all the way to verified detailed design, with every number traceable to a source.

**Hackathon:** Halloween at Imperial: Gemini Edition, Sat 31 Oct. Build 11:00–16:00, hard submission 16:00 via GitHub.

---

## 1. Problem

Aircraft design is a spiral:

1. **Conceptual:** the mission gives segment weight fractions, statistical empty weight and a first take-off mass (MTOW). Wing loading and power come from performance requirements; layout comes from heuristics.
2. **Preliminary:** rough parts are sized with beam theory and hand calcs. They reveal that the conceptual assumptions were wrong.
3. **Loop back:** heavier structure → higher MTOW → bigger wing, more fuel → re-size. In industry each lap takes days to weeks across tools and teams.
4. **Detailed:** only once the design closes do parts get full CAD and FEA.

## 2. Idea

An agent that runs the spiral **autonomously and traceably**:

- **Gemini decides:** parses the project, picks and cites heuristics, decides what to change when the design doesn't close, explains trade-offs, writes the report.
- **Python computes:** all maths runs in deterministic tools. Gemini never does arithmetic.
- **Fidelity rises** down the pipeline. One component goes all the way to CAD + FEA.
- **Every number** traces back to an equation, a table row, a simulation or a flagged assumption.

**Positioning**
- vs OpenVSP / SUAVE / RCAIDE: those need an expert to drive them. Spiral takes plain English, iterates on its own, cites every assumption and flags heuristics used outside their valid range.
- vs PhysicsX Ai.rplane (UX inspiration): Ai.rplane predicted physics with learned surrogate models. Spiral uses established textbook methods (Raymer et al.) with an agent doing the engineering reasoning: slower physics, but every number is explainable and citable.

## 3. Scope

**Aircraft class:** four-seat, single-engine piston general aviation aircraft (Cessna 172 class). Chosen because Raymer's statistical methods are calibrated on exactly this kind of aircraft, and Raymer's worked examples give a sanity check.

**Component carried to detailed design:** the **main wing spar**, idealised I-section (two caps + web), aluminium.
- Its load comes straight out of the sizing loop (MTOW × ultimate load factor), so it couples to the spiral.
- Beam theory is the right preliminary fidelity; FEA of the final part can be checked against it.

All other components appear in the UI as "coming soon": main landing gear, horizontal tail, engine mount, fuselage frames.

### Fidelity ladder

| Stage | Method | Output |
|---|---|---|
| Intake | Gemini parses project description → structured spec; user confirms | Mission spec + list of defaults chosen |
| Conceptual | Weight closure with statistical empty-weight fraction; Breguet range + loiter for fuel fraction; wing loading from stall speed; cruise power | MTOW, fuel, wing area, span, chords, power, mass breakdown |
| Layout | Cited heuristics (retrieval): wing position, tail volume coefficients, fuselage length regression | Configuration + rough 3D geometry |
| Preliminary | Schrenk lift distribution → shear and bending → spar cap and web sizing at ultimate load | Spar mass, root section, margin, tip deflection |
| Loop | Replace the statistical spar share of empty weight with computed spar mass; re-size | Converged MTOW, or "infeasible, because…" |
| Detailed (spar only) | CadQuery geometry → gmsh mesh → CalculiX static | STEP + STL files, FEA stress and deflection vs beam theory |

### Core methods (engineering side to confirm sources and fidelity)

- **Weight closure:** W0 = (crew + payload) / (1 − fuel fraction − empty fraction), solved iteratively.
- **Empty fraction:** statistical regression We/W0 = A · W0^C for GA single engine (Raymer ch.3).
- **Fuel fraction:** product of segment fractions (warm-up/take-off, climb, cruise by Breguet range for propeller aircraft, loiter reserve by endurance equation, landing) plus trapped/reserve allowance.
- **Wing:** W/S from stall speed and CLmax → area; aspect ratio → span; taper ratio → root and tip chords.
- **Spar loads:** Schrenk = average of elliptical and planform lift, scaled by limit load factor × 1.5; integrate from tip for shear and bending.
- **Spar sizing:** cap area = M / (spar depth × allowable stress); web thickness from shear; minimum gauges; integrate mass over both wings.
- **Feedback:** lap 0 assumes the spar is a fixed share of statistical empty weight; from lap 1 that share is replaced by the computed spar mass.
- **Convergence:** stop when MTOW changes by < 0.5% between laps. Infeasible if weight closure breaks down, fuel fraction is implausible (> 0.42), MTOW grows > 2% for 4 consecutive laps, or the spiral converges above the single-engine piston class limit (2,722 kg / 6,000 lb), where the Table 3.1 statistics stop applying. The weight closure is solved by bisection, so it never fails on a bad starting guess.

## 4. User experience

Inspired by Ai.rplane: requirements first, a 3D model as the centrepiece, physics overlaid on geometry, uncertainty and warnings visible, export at the end.

### Screen 1: Project intake
- One large text box: "Describe the aircraft you're designing."
- Example: *"Four-seat touring aircraft, 1,000 km range with 45 min reserve, cruise 115 kt, stall under 55 kt."*
- Gemini parses it into a **structured spec form** (editable). Fields Gemini defaulted are highlighted with the reason. User confirms → workspace.

### Screen 2: Workspace

| Left sidebar | Centre / right |
|---|---|
| Stage menu: **Spec → Conceptual → Preliminary → Detailed** with status ticks | **3D render** of the aircraft, morphing each lap (three.js primitives: fuselage, tapered wing, tail) |
| Config panel for the selected stage (editable inputs, re-run button) | **Convergence plot:** MTOW and spar mass per lap |
| | **Agent log:** decisions with citations, streaming |

Every number shown carries a small badge: source on hover, amber warning if a heuristic was used outside its valid range or a table value isn't verified yet.

### Screen 3: Detailed design
- List of components with status. Only **Main wing spar** is clickable; the rest show "coming soon".
- Click → runs the component loop (CAD → FEA) with step indicators.
- Result: 3D spar coloured by stress, beam theory vs FEA comparison, margin, mass, download STEP.

### Screen 4: Report
- Summary, convergence plot, mass breakdown, spar result, full list of sources, assumptions and warnings. Gemini-written narrative.

## 5. Knowledge layer and books pipeline

Three forms, not one big RAG:

1. **Equations → Python tools.** Each tool's docstring cites its source. A curated registry (`knowledge/equations.yaml`) lists every equation, its source and which tool implements it.
2. **Typical values → YAML tables** (`knowledge/tables/`): materials, weight fractions, typical values by aircraft class with **valid ranges** (these power the out-of-range warnings). Every row has a `source` and a `verified` flag.
3. **Qualitative heuristics → retrieval.** Layout rules of thumb, via Gemini File Search (page-level citations) or simply long context.

### Extraction pipeline

```
books/  (PDFs, gitignored)
   │  scripts/extract_knowledge.py: split PDF into page chunks → Gemini → JSON
   ▼
knowledge/extracted/  (raw JSON per book: equations, tables, heuristics, page refs; gitignored)
   │  engineering side reviews and transcribes in own words, with citations
   ▼
knowledge/equations.yaml + knowledge/tables/*.yaml  (curated, committed)
   │
   ▼
spiral/tools/  (implemented equations, cite the registry)
```

- Extraction asks Gemini for: equations (LaTeX, variables with units, validity conditions, page), tables (as rows, page), heuristics (paraphrased, what they apply to, page).
- Raw extraction is a **drafting aid**, not a source of truth. Nothing goes into a tool until a human has checked it against the page.

**Copyright:** submissions go via GitHub. Never commit PDFs or raw extracted text. `books/` and `knowledge/extracted/` are gitignored. Only our own transcriptions with citations are committed.

## 6. Repository structure

```
spiral/
├── README.md                    # pitch, quickstart, demo GIF
├── DESIGN_SPEC.md               # this document
├── .gitignore                   # books/*, knowledge/extracted/*, artifacts/*, .env
├── .env.example                 # GEMINI_API_KEY, GEMINI_MODEL
├── requirements.txt
│
├── books/                       # [both] drop textbook PDFs here — GITIGNORED
│   └── README.md                # what to put here, copyright note
│
├── knowledge/                   # [Harry] RAG / textbook knowledge tables & equation registry
│   ├── equations.yaml           # curated equation registry with citations (committed)
│   ├── tables/
│   │   ├── materials.yaml       # density, E, allowables
│   │   ├── weight_fractions.yaml# segment fractions, empty-weight regression, spar share
│   │   └── aircraft_typical.yaml# typical values + valid ranges per aircraft class
│   └── extracted/               # raw Gemini extraction output — GITIGNORED
│
├── scripts/
│   └── extract_knowledge.py     # [Harry] books/ → knowledge/extracted/
│
├── spiral/                      # Python package
│   ├── __init__.py
│   ├── contract.py              # [both, frozen] shared schemas: MissionSpec, ToolResult, ToolError, DesignState, API payloads
│   ├── tools/                   # deterministic engineering tools
│   │   ├── __init__.py
│   │   ├── lookup.py            # [Harry] read knowledge tables for RAG / sizing agents
│   │   ├── sizing.py            # [Harry] mission & weight sizing agent calculations
│   │   ├── spar.py              # [Harry] wing & spar parameter agent calculations (Schrenk + I-beam parameters)
│   │   ├── geometry.py          # [Tharm] combine all agent outputs into 3D aircraft geometry primitives
│   │   ├── cad.py               # [Tharm] combine agent parameters into 3D CAD (CadQuery STEP/STL)
│   │   └── fea.py               # [Tharm] gmsh + CalculiX static FEA verification on the generated CAD
│   └── agent/                   # [Harry] NL intake → multi-agent / RAG / notebook orchestration
│       ├── __init__.py
│       ├── orchestrator.py      # multi-agent spiral loop + component design trigger
│       ├── gemini.py            # intake parsing, sub-agent reasoning, infeasible relaxation, report writing
│       └── prompts/             # system prompts for intake, sub-agents, infeasible, report
│           ├── intake.md
│           ├── infeasible.md
│           └── report.md
│
├── server/                      # [Harry] FastAPI: parse, run (streamed laps), components, report
│   ├── __init__.py
│   └── app.py
├── web/                         # [Tharm] frontend: intake, workspace (3D aircraft + plots), detailed CAD/FEA viewer, report
│   ├── index.html
│   ├── styles.css
│   ├── api_client.js            # typed wrapper around Harry's server endpoints & SSE stream
│   └── app.js
├── tests/                       # [Harry] test_orchestrator.py; [Tharm] test_tools.py (CAD/FEA/geometry)
│   ├── test_tools.py
│   └── test_orchestrator.py
└── artifacts/                   # [Tharm] generated STEP/STL/mesh JSON — GITIGNORED
```

## 7. Roles & Work Split (Agentic Sizing → CAD, FEA & Frontend Synthesis)

The system is split along a clean two-stage pipeline: **Harry** converts natural-language requirements into multi-agent engineering parameter outputs, and **Tharm** reads and combines all agent outputs into **3D CAD, FEA structural analysis, and the interactive Frontend**.

```
[Plain-English Requirements]
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ PART 1 — HARRY: NL Intake → RAG / Notebook → Specialized Sub-Agents     │
│  • Intake Agent: parses natural language into structured MissionSpec    │
│  • RAG & Knowledge Layer: retrieves equations, tables & heuristics      │
│  • Sub-Agents (Mission/Weight Agent, Wing/Spar Agent, Layout Agent):    │
│    compute and output exact engineering parameters per component        │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ Frozen Schema (spiral/contract.py)
                                    │ ConceptualSizingResult + SparLoadsResult
                                    │ + SparSizingResult + AircraftGeometry
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ PART 2 — THARM: Parameter Synthesis → 3D CAD + FEA + Frontend UI        │
│  • Reads & combines parameter outputs from all of Harry's agents        │
│  • 3D Aircraft & CAD Assembly (geometry.py, cad.py → STEP / STL)        │
│  • Structural FEA Analysis (fea.py → gmsh + CalculiX 3D stress & defl.) │
│  • Interactive Frontend (web/ → Three.js 3D viewer, FEA stress map, UI) │
└─────────────────────────────────────────────────────────────────────────┘
```

| | **Harry: NL → Multi-Agent, RAG & Component Parameter Sizing** | **Tharm: Multi-Agent Synthesis → 3D CAD, FEA & Frontend** |
|---|---|---|
| **Role Summary** | **Upstream Agentic Brain & Sizing:** Converts plain-English aircraft requirements into specialized agents (RAG/textbook lookup, notebook calculations, Mission/Weight Agent, Wing & Spar Parameter Agent) and outputs structured component parameters. | **Downstream CAD, FEA & Visual Synthesis:** Reads the parameter outputs from all of Harry's agents, combines them into 3D aircraft geometry & solid CAD (STEP/STL), runs FEA structural verification, and renders the 3D frontend & stress plots. |
| **Owns** | • Plain-English intake → `MissionSpec`<br>• RAG / knowledge extraction (`scripts/extract_knowledge.py`, `knowledge/`, `lookup.py`)<br>• Specialized sizing & wing parameter agents (`spiral/agent/`, `sizing.py`, `spar.py`)<br>• FastAPI + SSE server (`server/app.py`) | • Combining all agent outputs into 3D aircraft geometry (`geometry.py`)<br>• Parametric 3D CAD generation (`cad.py` → CadQuery STEP/STL)<br>• Finite Element Analysis pipeline (`fea.py` → gmsh + CalculiX static stress/deflection)<br>• Frontend UI, Three.js 3D aircraft/FEA viewer & plots (`web/`) |
| **Folders & Files** | `spiral/agent/`, `server/`, `scripts/`, `knowledge/`, `spiral/tools/lookup.py`, `spiral/tools/sizing.py`, `spiral/tools/spar.py`, `tests/test_orchestrator.py` | `web/`, `spiral/tools/cad.py`, `spiral/tools/fea.py`, `spiral/tools/geometry.py`, `artifacts/`, `tests/test_tools.py` |
| **Handoff Output / Input** | **Outputs** populated `DesignState` containing `ConceptualSizingResult`, `SparLoadsResult`, and `SparSizingResult` (exact SI numbers + citations). | **Consumes** Harry's agent outputs from `DesignState` to build `AircraftGeometry`, `SparCadResult` (STEP/STL), and `FeaResult` (3D von Mises stress mesh). |
| **Reviews** | Prompt hygiene (agents never invent numbers outside `DesignState`); all agent outputs strictly match `spiral/contract.py`. | CAD geometry validity, FEA mesh/solver accuracy vs beam theory, 3D visual assembly, and UI traceability badges. |
| **Shared** | `spiral/contract.py` (frozen source of truth), `books/` | `spiral/contract.py` (frozen source of truth), `books/` |

**Golden Rule for the Split:** However Harry structures his internal sub-agents (RAG, notebook execution, wing agent, fuselage/tail agent), their final output **must populate the frozen dataclasses in `spiral/contract.py`** so Tharm's CAD builder (`cad.py`), FEA solver (`fea.py`), and 3D frontend (`web/`) can consume them without breaking.

---

## 8. The Explicit Contract (`spiral/contract.py`)

`spiral/contract.py` is frozen at the start and serves as the single source of truth for **both boundaries** between Harry's agents and Tharm's CAD/FEA/Frontend:
1. **Agent-to-CAD/FEA Boundary:** Harry's agents output `ConceptualSizingResult`, `SparLoadsResult`, and `SparSizingResult`; Tharm's functions (`geometry.py`, `cad.py`, `fea.py`) consume those agent results to build the 3D geometry, CAD files, and FEA stress solution.
2. **HTTP / SSE Boundary:** Tharm's `web/` frontend calls Harry's `server/app.py` FastAPI endpoints.

### 8.1 Conventions
- **SI units everywhere** (`kg`, `m`, `s`, `N`, `W`, `Pa`, `J`). Every numeric field name ends with its unit suffix (`mtow_kg`, `span_m`, `root_moment_nm`, `max_bending_stress_pa`).
- Tools are **pure, deterministic Python functions**. Dataclasses in, `ToolResult[T]` out, 100% JSON-serialisable via `.to_dict()`.
- On unrecoverable physical/mathematical failure, a tool raises **`ToolError`** with an actionable message for Gemini (`"Fuel fraction 0.62 exceeds plausible limit 0.45: reduce range_m or increase ld_max"`).
- **Never return `NaN`, `inf`, or silently clamp.** Out-of-range heuristic inputs still compute, and append a human-readable string to `ToolResult.warnings`.
- Every contract dataclass has `.to_dict()` and `.from_dict()`, so any payload survives a JSON round trip (the frontend posts `DesignState` back unchanged).
- **Fixtures:** `fixtures/` holds one real example of every payload (intake response, converged/detailed `DesignState`, report, all three SSE streams, stress mesh). Build against them with no backend running. Regenerate with `python3 scripts/generate_fixtures.py` after any contract change; `tests/test_contract.py` fails if they drift.

### 8.2 Envelope Types: `ToolResult[T]`, `Provenance` and `ToolError`

```python
@dataclass
class ToolResult(Generic[T]):
    value: T
    sources: list[str] = field(default_factory=list)      # e.g. ["Raymer 2ed, Eq. 3.4 (p. 12)", "knowledge/tables/materials.yaml#al_2024_t3"]
    assumptions: list[str] = field(default_factory=list)  # e.g. ["Cruise at L/D_max = 11.0"]
    warnings: list[str] = field(default_factory=list)     # e.g. ["aspect_ratio=11.0 outside typical GA range [6.0, 9.0]"]
    provenance: dict[str, Provenance] = field(default_factory=dict)  # per field of `value`, e.g. "mtow_kg"

@dataclass
class Provenance:                 # drives the per-number source badge in the UI
    kind: str                     # "equation" | "table" | "simulation" | "assumption" | "user_input" | "gemini_default"
    source: str                   # e.g. "Raymer 2ed, Eq. 3.4 (p. 12)"
    verified: bool = True         # False -> amber badge (citation not yet checked against the page)
    warning: str | None = None    # set -> amber badge (e.g. heuristic outside valid range)

class ToolError(Exception):
    tool_name: str
    message: str
    recoverable: bool = True
    suggested_field: str | None = None
```

### 8.3 `MissionSpec` (Gemini parses on intake → user confirms in Tharm's UI)

| Group | Field | Type | Default | Description |
|---|---|---|---|---|
| **Payload** | `crew_count` | `int` | `1` | Number of flight crew |
| | `passenger_count` | `int` | `3` | Number of passengers |
| | `person_mass_kg` | `float` | `86.0` | Mass per person (crew or passenger) |
| | `baggage_mass_kg` | `float` | `50.0` | Total baggage mass |
| **Mission** | `range_m` | `float` | `1_000_000.0` | Design cruise range (1,000 km) |
| | `cruise_speed_ms` | `float` | `60.0` | Cruise true airspeed (~117 kt) |
| | `cruise_altitude_m` | `float` | `2_500.0` | Cruise altitude above sea level |
| | `stall_speed_ms` | `float` | `28.0` | Maximum stall speed (~54 kt) |
| | `reserve_s` | `float` | `2_700.0` | Loiter reserve endurance (45 min) |
| **Wing / Aero** | `aspect_ratio` | `float` | `7.6` | Wing aspect ratio $b^2 / S$ |
| | `taper_ratio` | `float` | `0.45` | Wing taper ratio $c_{\text{tip}} / c_{\text{root}}$ |
| | `thickness_to_chord` | `float` | `0.15` | Airfoil maximum $t/c$ ratio |
| | `cl_max` | `float` | `1.6` | Maximum clean/landing lift coefficient |
| | `ld_max` | `float` | `11.0` | Maximum lift-to-drag ratio in cruise |
| **Propulsion** | `prop_efficiency` | `float` | `0.80` | Propeller efficiency $\eta_p$ |
| | `bsfc_kg_per_j` | `float` | `6.8e-8` | Brake specific fuel consumption (kg/J) |
| **Structure** | `limit_load_factor` | `float` | `3.8` | Positive limit manoeuvring load factor $n_{\text{lim}}$ |
| | `ultimate_factor` | `float` | `1.5` | Factor of safety ($n_{\text{ult}} = n_{\text{lim}} \times 1.5 = 5.7$) |
| | `spar_material` | `str` | `"al_2024_t3"` | Key in `knowledge/tables/materials.yaml` |
| **Layout** | `wing_position` | `str` | `"high"` | `"high"`, `"mid"`, or `"low"` |
| **Meta** | `name` | `str` | `"GA-4 Touring"` | Project title |
| | `raw_description` | `str` | `""` | Original plain-English prompt |
| | `defaulted_fields` | `dict[str, str]` | `{}` | Map of `field_name -> reason` for every field not stated: Python's cited defaults, plus values Gemini inferred (reason starts "Inferred by") |
| | `stated_fields` | `dict[str, str]` | `{}` | Map of `field_name -> the user's exact words` for values stated in the description (checked against the text by Python) |

### 8.4 Python Tool Signatures & Return Schemas (`spiral/tools/`)

> **Ownership:** Tools 1–4 (`lookup.py`, `sizing.py`, `spar.py`) belong to **Harry's** agentic/RAG sizing layer; Tools 5–7 (`cad.py`, `fea.py`, `geometry.py`) belong to **Tharm's** CAD, FEA & 3D synthesis layer.

#### 1. `spiral.tools.lookup.lookup(table: str, key: str) -> ToolResult[dict[str, Any]]`
Reads `knowledge/tables/{table}.yaml` and returns row `key`. Appends a warning if `verified` is `False`.

#### 2. `spiral.tools.sizing.conceptual_sizing(spec: MissionSpec, spar_mass_kg: float | None = None) -> ToolResult[ConceptualSizingResult]`
Runs iterative weight closure, Breguet range + loiter fuel fraction, stall wing loading, and cruise/installed power. On lap 0 (`spar_mass_kg=None`), uses statistical spar fraction of empty weight; on lap $\ge 1$, replaces the statistical spar share with `spar_mass_kg`.

`ConceptualSizingResult` fields:
- `mtow_kg: float`
- `empty_mass_kg: float`
- `fuel_mass_kg: float`
- `payload_mass_kg: float`
- `empty_fraction: float`
- `fuel_fraction: float`
- `spar_mass_used_kg: float`
- `statistical_spar_mass_kg: float`
- `wing_loading_pa: float`
- `wing_area_m2: float`
- `span_m: float`
- `root_chord_m: float`
- `tip_chord_m: float`
- `mac_m: float`
- `cruise_power_w: float`
- `installed_power_w: float`
- `segment_fractions: dict[str, float]` (`warmup_takeoff`, `climb`, `cruise`, `loiter`, `landing`)
- `mass_breakdown_kg: dict[str, float]` (`wing_spar`, `remaining_empty`, `fuel`, `crew`, `passengers`, `baggage`)

#### 3. `spiral.tools.spar.spar_loads(mtow_kg: float, span_m: float, root_chord_m: float, tip_chord_m: float, n_ult: float, n_stations: int = 21) -> ToolResult[SparLoadsResult]`
Computes Schrenk spanwise lift distribution across one semi-span ($y \in [0, b/2]$) at ultimate load ($n_{\text{ult}} \cdot W_0$) and integrates from tip to root for shear force and bending moment.

`SparLoadsResult` fields:
- `n_ult: float`
- `semi_span_m: float`
- `root_shear_n: float`
- `root_moment_nm: float`
- `stations: list[SparStationLoad]`
  - `SparStationLoad`: `y_m`, `chord_m`, `elliptical_lift_n_per_m`, `planform_lift_n_per_m`, `schrenk_lift_n_per_m`, `shear_n`, `moment_nm`

#### 4. `spiral.tools.spar.size_spar(loads: SparLoadsResult, thickness_to_chord: float, material_key: str = "al_2024_t3") -> ToolResult[SparSizingResult]`
Sizes an I-section main spar (two caps + shear web) along the semi-span with minimum gauge constraints, integrates Euler-Bernoulli curvature for tip deflection, and returns total spar mass for **both wings**.

`SparSizingResult` fields:
- `material_key: str`
- `mass_both_wings_kg: float`
- `semi_span_mass_kg: float`
- `root_depth_m: float`
- `tip_depth_m: float`
- `root_cap_area_m2: float`
- `root_cap_width_m: float`
- `root_cap_thickness_m: float`
- `root_web_thickness_m: float`
- `max_bending_stress_pa: float`
- `max_shear_stress_pa: float`
- `allowable_yield_stress_pa: float`
- `safety_margin: float` ($\sigma_{\text{allow}} / \sigma_{\max} - 1$)
- `tip_deflection_m: float`
- `stations: list[SparStationSection]`
  - `SparStationSection`: `y_m`, `depth_m`, `cap_area_m2`, `cap_width_m`, `cap_thickness_m`, `web_thickness_m`, `bending_stress_pa`, `shear_stress_pa`, `deflection_m`

#### 5. `spiral.tools.cad.build_spar_cad(spar: SparSizingResult, out_dir: str = "artifacts") -> ToolResult[SparCadResult]`
Generates tapered I-beam CAD geometry using CadQuery (or fallback mesh exporter) and writes STEP + STL files to `out_dir`.

`SparCadResult` fields:
- `step_path: str` (e.g. `"artifacts/spar.step"`)
- `stl_path: str` (e.g. `"artifacts/spar.stl"`)
- `volume_single_wing_m3: float`
- `cad_mass_both_wings_kg: float`
- `bounding_box_m: dict[str, float]` (`x_width_m`, `y_semi_span_m`, `z_depth_m`)

#### 6. `spiral.tools.fea.run_fea(spar: SparSizingResult, loads: SparLoadsResult, cad: SparCadResult, material_key: str = "al_2024_t3", out_dir: str = "artifacts") -> ToolResult[FeaResult]`
Meshes the CAD geometry (gmsh) and runs linear static FEA under the Schrenk ultimate load (CalculiX), comparing peak von Mises stress and tip deflection against Euler-Bernoulli beam theory. Also outputs station-by-station stress & deflection so Tharm's 3D frontend can colour the spar immediately.

`FeaResult` fields:
- `solver_name: str` (`"CalculiX + gmsh"` or `"3D-FE-Fallback"`)
- `fea_max_von_mises_pa: float`
- `fea_tip_deflection_m: float`
- `beam_max_stress_pa: float`
- `beam_tip_deflection_m: float`
- `stress_agreement_pct: float`
- `deflection_agreement_pct: float`
- `safety_margin_fea: float`
- `stress_mesh_path: str | None` (e.g. `"artifacts/spar_stress_mesh.json"`)
- `stations: list[FeaStationResult]`
  - `FeaStationResult`: `y_m`, `fea_von_mises_pa`, `beam_stress_pa`, `fea_deflection_m`, `beam_deflection_m`

#### 7. `spiral.tools.geometry.aircraft_geometry(spec: MissionSpec, sizing: ConceptualSizingResult) -> ToolResult[AircraftGeometry]`
Computes parametric 3D primitive dimensions (in metres) for Three.js rendering in `web/`.

`AircraftGeometry` fields:
- `fuselage: dict[str, float]` (`length_m`, `diameter_m`, `nose_length_m`, `cabin_length_m`, `tailcone_length_m`)
- `wing: dict[str, float | str]` (`span_m`, `root_chord_m`, `tip_chord_m`, `thickness_to_chord`, `x_le_m`, `z_m`, `dihedral_deg`, `position`)
- `horizontal_tail: dict[str, float]` (`span_m`, `root_chord_m`, `tip_chord_m`, `x_le_m`, `z_m`)
- `vertical_tail: dict[str, float]` (`height_m`, `root_chord_m`, `tip_chord_m`, `x_le_m`, `z_m`)
- `propeller: dict[str, float]` (`diameter_m`, `x_m`)

---

### 8.5 `DesignState` (Harry's Orchestrator produces; Tharm's Frontend renders)

```python
@dataclass
class LapRecord:
    lap: int
    mtow_kg: float
    empty_mass_kg: float
    fuel_mass_kg: float
    spar_mass_kg: float
    mtow_change_pct: float
    wing_area_m2: float
    span_m: float
    max_bending_stress_pa: float
    tip_deflection_m: float
    geometry: AircraftGeometry

@dataclass
class DesignState:
    spec: MissionSpec
    lap: int
    history: list[LapRecord]
    latest_sizing: ConceptualSizingResult | None
    latest_loads: SparLoadsResult | None
    latest_spar: SparSizingResult | None
    latest_geometry: AircraftGeometry | None
    converged: bool
    infeasible_reason: str | None
    proposed_relaxation: SpecRelaxationProposal | None
    sources: list[str]
    assumptions: list[str]
    warnings: list[str]
    provenance: dict[str, Provenance]  # see below
    log: list[AgentLogEntry]           # each entry has an ISO 8601 UTC `timestamp`
    components: dict[str, ComponentStatus]  # "main_wing_spar", "main_landing_gear", "horizontal_tail", "engine_mount", "fuselage_frames"
    report_markdown: str | None

@dataclass
class ComponentStatus:
    component_id: str
    name: str
    available: bool                    # False -> "coming soon"
    status: str                        # "pending" | "running_cad" | "running_fea" | "completed" | "coming_soon"
    cad: SparCadResult | None
    fea: FeaResult | None
    artifact_urls: dict[str, str]      # "step" | "stl" | "stress_mesh" -> "/artifacts/<file>"
```

- **Provenance keys** are dotted paths into the `DesignState` JSON: `spec.range_m`, `latest_sizing.mtow_kg`, `latest_spar.safety_margin`, `components.main_wing_spar.fea.fea_max_von_mises_pa`. List items use `[]` (`latest_spar.stations[].bending_stress_pa`); values in `history[]` reuse the matching `latest_*` key. The orchestrator builds this from each tool's `ToolResult.provenance`. A displayed number with no entry gets a grey "no source" badge so the gap is visible.
- **Files:** the frontend uses only `artifact_urls`. `SparCadResult.step_path` and `FeaResult.stress_mesh_path` are server filesystem paths.

---

### 8.6 HTTP & SSE API Contract (`server/app.py` ↔ `web/api_client.js`)

Harry's FastAPI server runs on `http://localhost:8000` (with CORS enabled for local dev and static serving for `/artifacts` and `/web`).

| Method & Path | Request JSON | Response / Stream | Description |
|---|---|---|---|
| `POST /api/intake` | `{ "description": str }` | `{ "spec": MissionSpec, "sources": list[str], "assumptions": list[str], "warnings": list[str] }` | Gemini parses plain-English prompt into `MissionSpec` and records defaulted fields. |
| `POST /api/spiral/run-sync` | `{ "spec": MissionSpec }` | `DesignState` (JSON) | Runs the full conceptual + preliminary spar spiral loop and returns the final `DesignState`. |
| `POST /api/spiral/stream` | `{ "spec": MissionSpec }` | `text/event-stream` (SSE) | Streams live events (`lap`, `log`, `converged`, `infeasible`) during the spiral loop. |
| `POST /api/components/spar` | `{ "state": DesignState }` | `DesignState` (with `components["main_wing_spar"]` populated with `cad`, `fea` and `artifact_urls`) | Runs `build_spar_cad` + `run_fea` on the converged spar and updates `DesignState`. |
| `POST /api/components/spar/stream` | `{ "state": DesignState }` | `text/event-stream` (SSE) | Same as above, streaming `component_step` events for the CAD → FEA step indicators. |
| `POST /api/report` | `{ "state": DesignState }` | `{ "report_markdown": str, "state": DesignState }` | Generates the source-cited markdown design report from the posted `DesignState` (does not re-run the spiral). |
| `GET /artifacts/{filename}` | — | Binary/JSON file | Serves generated `spar.step`, `spar.stl`, and `spar_stress_mesh.json` (use `ComponentStatus.artifact_urls`). |

Request and response types are the dataclasses in `spiral/contract.py` §7 (`IntakeRequest`, `IntakeResponse`, `SpiralRequest`, `StateRequest`, `ReportResponse`).

#### SSE Event Payloads
Each SSE frame is `event: <type>\ndata: <json>\n\n`, built by `format_sse()`; `SSE_EVENTS` maps each type to its dataclass. `EventSource` cannot POST, so read the stream with `fetch()` and a `ReadableStream` reader, splitting frames on blank lines.
- `lap`: `{ "lap_record": LapRecord, "sizing": ConceptualSizingResult, "loads": SparLoadsResult, "spar": SparSizingResult, "geometry": AircraftGeometry }`
- `log`: `{ "entry": AgentLogEntry }` (`lap`, `stage`, `message`, `citations`, `level`, `timestamp`)
- `converged`: `{ "state": DesignState }`
- `infeasible`: `{ "reason": str, "proposed_relaxation": SpecRelaxationProposal | None, "state": DesignState }`
- `component_step`: `{ "component_id": "main_wing_spar", "step": "cad" | "fea", "status": "running" | "done" }`
- `component_done`: `{ "component_id": "main_wing_spar", "component": ComponentStatus, "state": DesignState }`
- `error`: `{ "message": str, "tool_error": ToolError.to_dict() | None }`

Stream order: `/api/spiral/stream` sends `log`/`lap` pairs, then exactly one of `converged`, `infeasible` or `error`. `/api/components/spar/stream` sends `component_step` events and a `log`, then `component_done` or `error`.

---

## 9. Agent behaviour

1. **Intake:** parse description → `MissionSpec`. State every default chosen in `defaulted_fields`. User confirms.
2. **Layout:** retrieve heuristics, log cited choices.
3. **Spiral:** `conceptual_sizing` → `spar_loads` → `size_spar` → `aircraft_geometry` → loop with `spar_mass_kg`, until converged ($|\Delta \text{MTOW}| < 0.5\%$) or infeasible.
4. **If infeasible:** Gemini reads `infeasible_reason` and `history` and proposes **one** `SpecRelaxationProposal` with reasoning (e.g. "range 5,570 km → 4,660 km closes at 2,720 kg"). Python computes the numbers by re-running the spiral (bisection on range); Gemini only writes the reasoning. User accepts → re-run.
5. **Detailed:** on user click, `build_spar_cad` → `run_fea` → compare with beam theory.
6. **Report:** narrative from `DesignState` only. Gemini may not introduce numbers that aren't in the state.

**Fallback:** if Gemini function calling is flaky, the deterministic orchestrator runs steps 3 and 5; Gemini does intake, the infeasible decision and the report only.

## 10. Timeline (from 12:00)

| Time | Harry (NL → Multi-Agent, RAG & Sizing Parameters) | Tharm (Agent Outputs → 3D CAD, FEA & Frontend) |
|---|---|---|
| 12:00–12:25 | Repo, frozen `spiral/contract.py`, skeleton folders | Agree contract; verify stub tools & frontend shell |
| 12:25–13:15 | Intake agent + RAG/knowledge lookup + Mission/Wing parameter agents (`sizing.py`, `spar.py`) | 3D aircraft geometry assembly (`geometry.py`) + Frontend shell + CadQuery CAD (`cad.py`) |
| 13:15–14:00 | Lunch → **Integration 1:** Harry's agents output converged parameters into Tharm's 3D geometry & CAD | |
| 14:00–15:00 | Multi-agent refinement, infeasible relaxation, report generator & SSE polish | CalculiX + gmsh FEA pipeline (`fea.py`) + Three.js 3D morphing & FEA stress viewer (`web/`) |
| 15:00–15:30 | **Integration 2:** full agent → CAD → FEA loop live in UI; demo rehearsal ×2 | |
| 15:30–16:00 | Freeze, README, backup screen recording, **submit** | |

## 11. Demo script (3 minutes)

1. **Problem (30 s):** the design spiral, weeks per lap.
2. **Live (90 s):** type the touring-aircraft description → spec form appears with defaults explained → workspace: the aircraft morphs, MTOW converges on the plot, log fills with cited decisions → Detailed: click the wing spar → stress-coloured part, FEA vs beam theory.
3. **Twist (30 s):** "Make it fly London to New York non-stop" (5,570 km). MTOW climbs lap by lap (3.38 → 3.48 t) as the sized spar feeds back, ending above the single-engine class limit; the agent explains why and proposes the nearest feasible mission (4,660 km at 2,720 kg). (2,500 km closes at about 1.66 t, so it is not a failure case.)
4. **Close (30 s):** traceability (hover any number → its source), who it's for (small aircraft startups, student design teams, early trade studies), next steps (more components, higher fidelity, export to real CAD tools).

## 12. Risks and fallbacks

| Risk | Fallback |
|---|---|
| CadQuery / gmsh / CalculiX setup breaks | `cad.py` and `fea.py` fall back to analytical/3D-mesh generator so UI and STL/stress plot still work |
| Loop doesn't converge with real numbers | Tune spar share and defaults; cap laps; demo the infeasible path deliberately |
| Gemini mis-parses the spec | Editable spec form with confirmation |
| Frontend 3D overruns | Three.js primitives consume `AircraftGeometry` directly; fallback to 2D planform + convergence plot |
| Track turns out unrelated | Reframe: "model proposes, physics verifies" agent pattern |

## 13. Definition of done

- [ ] Plain-English description → confirmed spec
- [ ] Spiral converges for the default mission and diverges, with explanation, for an extreme one
- [ ] Convergence plot + agent log + 3D render in the workspace
- [ ] Wing spar detailed design runs from the component list (at least CAD; FEA if time)
- [ ] Every displayed number has a source or a flagged assumption
- [ ] No textbook content committed; README with quickstart; submitted by 16:00
