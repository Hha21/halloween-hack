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
- **Convergence:** stop when MTOW changes by < 0.5% between laps. Infeasible if weight closure breaks down, fuel fraction is implausible, or MTOW grows > 2% for 4 consecutive laps.

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
   │  scripts/extract_knowledge: split PDF into page chunks → Gemini → JSON
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
├── knowledge/                   # [engineering]
│   ├── equations.yaml           # curated equation registry with citations (committed)
│   ├── tables/
│   │   ├── materials.yaml       # density, E, allowables
│   │   ├── weight_fractions.yaml# segment fractions, empty-weight regression, spar share
│   │   └── aircraft_typical.yaml# typical values + valid ranges per aircraft class
│   └── extracted/               # raw Gemini extraction output — GITIGNORED
│
├── scripts/
│   └── extract_knowledge        # [Harry] books/ → knowledge/extracted/
│
├── spiral/                      # Python package
│   ├── contract                 # [both, frozen] shared schemas: MissionSpec, ToolResult, ToolError, DesignState, components
│   ├── tools/                   # [engineering] deterministic tools
│   │   ├── lookup               # read knowledge tables
│   │   ├── sizing               # conceptual sizing
│   │   ├── spar                 # spar loads + spar sizing
│   │   ├── cad                  # CadQuery spar geometry → STEP/STL
│   │   ├── fea                  # gmsh + CalculiX check
│   │   └── geometry             # [Harry] rough aircraft geometry for the 3D render
│   └── agent/                   # [Harry]
│       ├── orchestrator         # deterministic spiral loop + component design (always works)
│       ├── gemini               # intake parsing, decisions on infeasible, report writing
│       └── prompts/             # system prompts
│
├── server/                      # [Harry] FastAPI: parse, run (streamed laps), components, report
├── web/                         # [Harry] frontend: intake, workspace, detailed, report
├── tests/                       # [engineering] tools vs hand calcs / Raymer examples; [Harry] end-to-end
└── artifacts/                   # generated STEP/STL/plots — GITIGNORED
```

## 7. Work split

| | **Harry: agent + product** | **Friend: engineering + knowledge** |
|---|---|---|
| Owns | Gemini layer, orchestrator, server, frontend, 3D render geometry, extraction script, report, demo | Sizing and spar tools, knowledge tables and equation registry, CadQuery + FEA, engineering tests |
| Folders | `spiral/agent/`, `server/`, `web/`, `scripts/`, `spiral/tools/geometry` | `spiral/tools/` (except geometry), `knowledge/`, `tests/` (tools) |
| First deliverable | Orchestrator running end-to-end against stubs | **Stub tools matching the contract**, returning plausible values |
| Reviews | Friend's tool outputs make sense in the UI | Harry's prompts don't let Gemini invent numbers |
| Shared | `spiral/contract` (frozen), `books/` | |

**Rule:** neither person edits the other's folders. Problems go through the contract or a message.

## 8. The contract

Frozen at the start. Changes need both people to agree. The `spiral/contract` module is the source of truth once written; this section describes it.

### Conventions
- **SI units everywhere** (kg, m, s, N, W, Pa, J). Field names carry units: `mtow_kg`, `span_m`.
- Tools are **pure, deterministic Python functions**. JSON-serialisable in and out.
- Every tool returns a **ToolResult**. On failure it raises **ToolError** with a message the agent can act on ("fuel fraction implausible: reduce range or raise L/D").
- **Never return NaN or silently clamp.** Out-of-range inputs still compute but add a warning.

### ToolResult (every tool)
| Field | Meaning |
|---|---|
| `value` | Tool-specific payload (below) |
| `sources` | e.g. "Raymer ch.3", "knowledge/tables/materials.yaml#al_2024_t3" |
| `assumptions` | e.g. "Cruise at L/D max = 11" |
| `warnings` | e.g. "AR = 11 outside heuristic range 6–9" |

### MissionSpec (Gemini fills, user confirms)
| Group | Fields (defaults in brackets) |
|---|---|
| Payload | crew [1], passengers [3], person_mass_kg [86], baggage_kg [50] |
| Mission | range_m [1,000 km], cruise_speed_ms [60], cruise_altitude_m [2,500], stall_speed_ms [28], reserve_s [2,700] |
| Wing / aero | aspect_ratio [7.5], taper_ratio [0.6], thickness_to_chord [0.15], cl_max [1.6], ld_max [11] |
| Propulsion | prop_efficiency [0.8], bsfc_kg_per_J [6.8e-8] |
| Structure | limit_load_factor [3.8], ultimate_factor [1.5], spar_material [al_2024_t3] |
| Layout | wing_position [high] |
| Meta | name, notes (defaults the parser chose and why) |

### Tools
| Tool | Inputs | `value` returns | Owner |
|---|---|---|---|
| `conceptual_sizing` | spec, spar_mass_kg (none on lap 0) | mtow_kg, empty/fuel/payload mass, fuel & empty fractions, wing_loading_Nm2, wing_area_m2, span_m, root/tip chord, mac_m, cruise & installed power, segment fractions, mass breakdown | Friend |
| `spar_loads` | mtow_kg, span_m, root/tip chord, n_ult | per station: y_m, chord_m, lift_Npm, shear_N, moment_Nm; root shear and moment | Friend |
| `size_spar` | loads, thickness_to_chord, material | mass_kg (both wings), root depth / cap area / web thickness, max stress, allowable, margin, tip deflection, per-station arrays | Friend |
| `build_spar_cad` | spar, out_dir | step_path, stl_path | Friend |
| `run_fea` | spar, loads, cad, material, out_dir | FEA max stress & tip deflection, beam-theory values, agreement %, stress field file, solver name | Friend |
| `lookup` | table, key | the row, with its source | Friend |
| `aircraft_geometry` | spec, sizing | fuselage, wing, tails, engine as simple primitives for three.js | Harry |

### DesignState (Harry owns; tools never touch it)
spec · lap · history (per lap: MTOW, spar mass, % change) · latest sizing / loads / spar / geometry · converged · infeasible_reason · accumulated sources, assumptions, warnings · log (decisions + citations) · components (detailed results per component).

### Server events (streamed to the frontend)
`lap` (MTOW, spar mass, % change, geometry) · `converged` · `infeasible` (reason) · `component_step` (cad / fea) · `component_done` (result) · `log` (agent message).

## 9. Agent behaviour

1. **Intake:** parse description → spec. State every default chosen. User confirms.
2. **Layout:** retrieve heuristics, log cited choices.
3. **Spiral:** sizing → loads → spar → sizing with spar mass, until converged or infeasible.
4. **If infeasible:** Gemini reads the reason and the history and proposes **one** spec relaxation with reasoning (e.g. "range 2,000 km → 1,400 km closes at 1,150 kg"). User accepts → re-run.
5. **Detailed:** on user click, spar → CAD → FEA → compare with beam theory.
6. **Report:** narrative from the DesignState only. Gemini may not introduce numbers that aren't in the state.

**Fallback:** if Gemini function calling is flaky, the deterministic orchestrator runs steps 3 and 5; Gemini does intake, the infeasible decision and the report only.

## 10. Timeline (from 12:00)

| Time | Harry | Friend |
|---|---|---|
| 12:00–12:20 | Repo, contract module, skeleton folders | Agree contract; start stub tools |
| 12:20–13:00 | Orchestrator + server against stubs; Gemini intake | Real `conceptual_sizing` + tables; check vs Raymer example |
| 13:00–14:00 | Lunch → **Integration 1:** spiral converges end-to-end with real tools | |
| 14:00–15:00 | Frontend: intake, workspace (3D + convergence plot + log), detailed screen | `spar_loads`, `size_spar`, then CadQuery; FEA if time |
| 15:00–15:30 | **Integration 2:** detailed spar in UI; demo rehearsal ×2 | |
| 15:30–16:00 | Freeze, README, backup screen recording, **submit** | |

**Extraction pipeline** runs in the background whenever there's a spare moment; it's a nice-to-show, not on the critical path. Tables can be hand-transcribed if it isn't ready.

## 11. Demo script (3 minutes)

1. **Problem (30 s):** the design spiral, weeks per lap.
2. **Live (90 s):** type the touring-aircraft description → spec form appears with defaults explained → workspace: the aircraft morphs, MTOW converges on the plot, log fills with cited decisions → Detailed: click the wing spar → stress-coloured part, FEA vs beam theory.
3. **Twist (30 s):** raise range to 2,500 km. The spiral diverges; the agent explains why and proposes the nearest feasible mission.
4. **Close (30 s):** traceability (hover any number → its source), who it's for (small aircraft startups, student design teams, early trade studies), next steps (more components, higher fidelity, export to real CAD tools).

## 12. Risks and fallbacks

| Risk | Fallback |
|---|---|
| CadQuery / gmsh / CalculiX setup breaks | Show preliminary spar + beam theory; FEA as "next step" |
| Loop doesn't converge with real numbers | Tune spar share and defaults; cap laps; demo the infeasible path deliberately |
| Gemini mis-parses the spec | Editable spec form with confirmation |
| Frontend overruns | Minimal page: spec panel + convergence plot + log; drop 3D |
| Track turns out unrelated | Reframe: "model proposes, physics verifies" agent pattern |

## 13. Definition of done

- [ ] Plain-English description → confirmed spec
- [ ] Spiral converges for the default mission and diverges, with explanation, for an extreme one
- [ ] Convergence plot + agent log + 3D render in the workspace
- [ ] Wing spar detailed design runs from the component list (at least CAD; FEA if time)
- [ ] Every displayed number has a source or a flagged assumption
- [ ] No textbook content committed; README with quickstart; submitted by 16:00
