"""Deterministic design spiral orchestrator (Owner: Harry).

Runs the conceptual -> preliminary spar -> weight feedback loop, hands the agent outputs to
Tharm's geometry/CAD/FEA tools, and populates `DesignState`. Events passed to `on_event` are
the SSE payload dataclasses from `spiral.contract`.
"""

from __future__ import annotations

import math
from dataclasses import fields, replace
from pathlib import Path
from typing import Callable

from spiral.agent.gemini import propose_infeasible_relaxation
from spiral.contract import (
    ARTIFACTS_URL_PREFIX,
    AgentLogEntry,
    ComponentDoneEvent,
    ComponentStepEvent,
    ConvergedEvent,
    DesignState,
    InfeasibleEvent,
    LapEvent,
    LapRecord,
    LogEvent,
    MissionSpec,
    Provenance,
    SpecRelaxationProposal,
    ToolError,
    ToolResult,
)
from spiral.tools import (
    aircraft_geometry,
    build_spar_cad,
    conceptual_sizing,
    run_fea,
    size_spar,
    spar_loads,
)
from spiral.tools.lookup import lookup

EventSink = Callable[[str, object], None]


def _merge_metadata(state: DesignState, result: ToolResult, prefix: str) -> None:
    for s in result.sources:
        if s not in state.sources:
            state.sources.append(s)
    for a in result.assumptions:
        if a not in state.assumptions:
            state.assumptions.append(a)
    for w in result.warnings:
        if w not in state.warnings:
            state.warnings.append(w)
    for key, prov in result.provenance.items():
        state.provenance[f"{prefix}.{key}"] = prov
    _fill_provenance(state, result, prefix)


# Kind of evidence a tool's numbers are, for fields the tool gave no provenance for.
_DEFAULT_KIND = {"latest_geometry": "assumption", "cad": "simulation", "fea": "simulation"}


def _numeric_paths(obj: object, path: str = "") -> list[str]:
    """Dotted paths of numeric leaves; list items collapse to `name[]` (one badge per column)."""
    if hasattr(obj, "to_dict"):
        obj = obj.to_dict()  # type: ignore[union-attr]
    out: list[str] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            out += _numeric_paths(v, f"{path}.{k}" if path else str(k))
    elif isinstance(obj, list):
        if obj and isinstance(obj[0], dict):
            out += _numeric_paths(obj[0], f"{path}[]")
    elif isinstance(obj, (int, float)) and not isinstance(obj, bool):
        out.append(path)
    return out


def _fill_provenance(state: DesignState, result: ToolResult, prefix: str) -> None:
    """Give every numeric field a provenance entry. Fields the tool didn't cite get an unverified
    entry naming the tool's own sources, so the UI shows "unverified" rather than nothing."""
    sources = "; ".join(result.sources) or "tool output (no source given)"
    kind = _DEFAULT_KIND.get(prefix.rsplit(".", 1)[-1], "equation")
    for path in _numeric_paths(result.value):
        key = f"{prefix}.{path}"
        if key not in state.provenance:
            state.provenance[key] = Provenance(kind, f"{sources} (no per-value citation)", verified=False)


def _spec_provenance(spec: MissionSpec) -> dict[str, Provenance]:
    skip = {"name", "raw_description", "defaulted_fields"}
    prov: dict[str, Provenance] = {}
    for f in fields(spec):
        if f.name in skip:
            continue
        reason = spec.defaulted_fields.get(f.name)
        if reason is not None:
            prov[f"spec.{f.name}"] = Provenance(kind="gemini_default", source=reason)
        else:
            prov[f"spec.{f.name}"] = Provenance(kind="user_input", source="Project description (confirmed by user)")
    return prov


def _artifact_url(path: str) -> str:
    return f"{ARTIFACTS_URL_PREFIX}/{Path(path).name}"


def mtow_class_limit() -> tuple[float, str]:
    """(max MTOW in kg, citation) for the aircraft class the statistics describe."""
    row = lookup("aircraft_typical", "ga_single_engine").value["mtow_class_limit"]
    return float(row["max_kg"]), str(row["source"])


def _layout_log(spec: MissionSpec) -> list[AgentLogEntry]:
    """The configuration choices behind lap 0, each with the table row it comes from."""
    typical = lookup("aircraft_typical", "ga_single_engine").value
    material = lookup("materials", spec.spar_material).value

    def cite(*rows: dict) -> list[str]:
        return [r["source"] + ("" if r.get("verified") else " (unverified)") for r in rows if r]

    def basis(field_name: str) -> str:
        reason = spec.defaulted_fields.get(field_name)
        return "from the description" if reason is None else ("inferred" if reason.startswith("Inferred") else "default")

    limit_kg, _ = mtow_class_limit()
    tails = typical.get("tail_volume_coefficients", {})
    fus = typical.get("fuselage_length_regression", {})
    return [
        AgentLogEntry(
            lap=0, stage="conceptual",
            message=(f"Class: single-engine piston general aviation. All statistics use the 'General aviation - single "
                     f"engine' rows, valid up to an MTOW of {limit_kg:,.0f} kg."),
            citations=cite(typical.get("mtow_class_limit", {})),
        ),
        AgentLogEntry(
            lap=0, stage="conceptual",
            message=(f"Wing: {spec.wing_position} wing ({basis('wing_position')}), aspect ratio {spec.aspect_ratio:g} "
                     f"({basis('aspect_ratio')}), taper {spec.taper_ratio:g} ({basis('taper_ratio')}), "
                     f"t/c {spec.thickness_to_chord:g} ({basis('thickness_to_chord')})."),
            citations=cite(typical.get("aspect_ratio", {}), typical.get("taper_ratio", {}), typical.get("thickness_to_chord", {})),
        ),
        AgentLogEntry(
            lap=0, stage="conceptual",
            message=(f"Tail sized by volume coefficients C_HT = {tails.get('c_ht', 0):g} and C_VT = {tails.get('c_vt', 0):g}; "
                     f"fuselage length from L = {fus.get('a', 0):g} W0^{fus.get('C', 0):g} (ft, lb)."),
            citations=cite(tails, fus),
        ),
        AgentLogEntry(
            lap=0, stage="conceptual",
            message=(f"Structure: +{spec.limit_load_factor:g} g limit ({basis('limit_load_factor')}), x {spec.ultimate_factor:g} "
                     f"= {spec.n_ult:.2f} g ultimate; main spar in {material.get('name', spec.spar_material)}."),
            citations=cite(typical.get("limit_load_factor", {}), material),
        ),
    ]


def nearest_feasible_range(spec: MissionSpec, step_m: float = 10_000.0) -> SpecRelaxationProposal | None:
    """Longest range (rounded down to `step_m`) at which the full spiral converges, all else unchanged.

    MTOW only grows with range, so bisection applies. Every number in the proposal comes from a
    real spiral run; the reasoning text is left for the agent to write.
    """

    def closes(range_m: float) -> DesignState | None:
        state = run_design_spiral(replace(spec, range_m=range_m), propose_relaxation=False)
        return state if state.converged else None

    lo, hi = 50_000.0, spec.range_m
    if hi <= lo or closes(lo) is None:
        return None
    while hi - lo > step_m / 2:
        mid = 0.5 * (lo + hi)
        lo, hi = (mid, hi) if closes(mid) else (lo, mid)
    new_range = math.floor(lo / step_m) * step_m
    best = closes(new_range)
    if best is None or best.latest_sizing is None:
        return None
    return SpecRelaxationProposal(
        field_name="range_m",
        old_value=spec.range_m,
        new_value=new_range,
        unit="m",
        reasoning="",
        estimated_mtow_kg=best.latest_sizing.mtow_kg,
    )


def run_design_spiral(
    spec: MissionSpec,
    max_laps: int = 12,
    convergence_tol_pct: float = 0.5,
    on_event: EventSink | None = None,
    propose_relaxation: bool = True,
) -> DesignState:
    """Run the conceptual + preliminary wing spar sizing loop until MTOW converges.

    Infeasible if a tool fails (e.g. implausible fuel fraction), the spiral diverges, or it
    converges above the single-engine class MTOW limit. Then, if `propose_relaxation`, the
    longest range that does close is computed by re-running the spiral.
    """
    state = DesignState(spec=spec)
    state.provenance.update(_spec_provenance(spec))

    def emit(event_type: str, payload: object) -> None:
        if on_event is not None:
            on_event(event_type, payload)

    def log(entry: AgentLogEntry) -> None:
        state.log.append(entry)
        emit("log", LogEvent(entry=entry))

    def finish_infeasible(lap: int, reason: str) -> DesignState:
        state.infeasible_reason = reason
        log(
            AgentLogEntry(
                lap=lap,
                stage="convergence",
                message=f"Infeasible design on lap {lap}: {reason}",
                citations=list(state.sources),
                level="error",
            )
        )
        if propose_relaxation:
            state.proposed_relaxation = propose_infeasible_relaxation(state, nearest_feasible_range(spec))
            if state.proposed_relaxation is not None:
                log(
                    AgentLogEntry(
                        lap=lap,
                        stage="convergence",
                        message=f"Proposed change: {state.proposed_relaxation.reasoning}",
                        citations=["Spiral re-run at the proposed value (bisection on range)"],
                        level="warning",
                    )
                )
        emit(
            "infeasible",
            InfeasibleEvent(reason=reason, proposed_relaxation=state.proposed_relaxation, state=state),
        )
        return state

    try:
        for entry in _layout_log(spec):
            log(entry)
    except (ToolError, KeyError):
        pass  # the layout log is commentary; never block the spiral on it

    spar_mass_feedback_kg: float | None = None
    consecutive_growth_laps = 0

    for lap in range(max_laps):
        state.lap = lap
        try:
            sizing_res = conceptual_sizing(spec, spar_mass_kg=spar_mass_feedback_kg)
            _merge_metadata(state, sizing_res, "latest_sizing")
            sizing = sizing_res.value
            state.latest_sizing = sizing

            loads_res = spar_loads(
                mtow_kg=sizing.mtow_kg,
                span_m=sizing.span_m,
                root_chord_m=sizing.root_chord_m,
                tip_chord_m=sizing.tip_chord_m,
                n_ult=spec.n_ult,
            )
            _merge_metadata(state, loads_res, "latest_loads")
            loads = loads_res.value
            state.latest_loads = loads

            spar_res = size_spar(
                loads=loads,
                thickness_to_chord=spec.thickness_to_chord,
                material_key=spec.spar_material,
            )
            _merge_metadata(state, spar_res, "latest_spar")
            spar = spar_res.value
            state.latest_spar = spar

            geom_res = aircraft_geometry(spec=spec, sizing=sizing)
            _merge_metadata(state, geom_res, "latest_geometry")
            geom = geom_res.value
            state.latest_geometry = geom

        except ToolError as exc:
            return finish_infeasible(lap, exc.message)

        prev_mtow = state.history[-1].mtow_kg if state.history else sizing.mtow_kg
        mtow_change_pct = (
            ((sizing.mtow_kg - prev_mtow) / prev_mtow) * 100.0 if lap > 0 else 0.0
        )

        record = LapRecord(
            lap=lap,
            mtow_kg=sizing.mtow_kg,
            empty_mass_kg=sizing.empty_mass_kg,
            fuel_mass_kg=sizing.fuel_mass_kg,
            spar_mass_kg=spar.mass_both_wings_kg,
            mtow_change_pct=round(mtow_change_pct, 3),
            wing_area_m2=sizing.wing_area_m2,
            span_m=sizing.span_m,
            max_bending_stress_pa=spar.max_bending_stress_pa,
            tip_deflection_m=spar.tip_deflection_m,
            geometry=geom,
        )
        state.history.append(record)

        log(
            AgentLogEntry(
                lap=lap,
                stage="preliminary",
                message=(
                    f"Lap {lap}: MTOW = {sizing.mtow_kg:.1f} kg ({mtow_change_pct:+.2f}%), "
                    f"Spar mass = {spar.mass_both_wings_kg:.1f} kg, "
                    f"Safety margin = {spar.safety_margin:+.2f}"
                ),
                citations=sizing_res.sources + spar_res.sources,
                level="info",
            )
        )
        emit(
            "lap",
            LapEvent(lap_record=record, sizing=sizing, loads=loads, spar=spar, geometry=geom),
        )

        # Check convergence after at least 1 feedback lap (lap >= 1)
        if lap >= 1 and abs(mtow_change_pct) < convergence_tol_pct:
            limit_kg, limit_source = mtow_class_limit()
            if sizing.mtow_kg > limit_kg:
                return finish_infeasible(
                    lap,
                    f"The spiral closes at MTOW {sizing.mtow_kg:,.0f} kg, above the {limit_kg:,.0f} kg limit for a "
                    f"single-engine piston aircraft ({limit_source}). The statistical methods don't apply that far out.",
                )
            state.converged = True
            log(
                AgentLogEntry(
                    lap=lap,
                    stage="convergence",
                    message=(
                        f"Converged on lap {lap}: |ΔMTOW| = {abs(mtow_change_pct):.3f}% "
                        f"< {convergence_tol_pct:.2f}% threshold."
                    ),
                    citations=list(state.sources),
                    level="info",
                )
            )
            emit("converged", ConvergedEvent(state=state))
            return state

        # Check divergence rule: MTOW grows > 2% for 4 consecutive laps
        if lap >= 1 and mtow_change_pct > 2.0:
            consecutive_growth_laps += 1
        else:
            consecutive_growth_laps = 0

        if consecutive_growth_laps >= 4:
            return finish_infeasible(lap, "Spiral diverged: MTOW grew by > 2% for 4 consecutive laps.")

        # Feedback computed preliminary spar mass into next lap's conceptual sizing
        spar_mass_feedback_kg = spar.mass_both_wings_kg

    return finish_infeasible(max_laps - 1, f"Did not converge within {max_laps} laps.")


def run_spar_detailed_design(
    state: DesignState,
    out_dir: str = "artifacts",
    on_event: EventSink | None = None,
) -> DesignState:
    """Run detailed CAD + FEA verification for the main wing spar."""
    if state.latest_spar is None or state.latest_loads is None:
        raise ToolError(
            "Cannot run detailed spar design before preliminary spiral has run.",
            tool_name="run_spar_detailed_design",
            recoverable=False,
        )

    def emit(event_type: str, payload: object) -> None:
        if on_event is not None:
            on_event(event_type, payload)

    prefix = "components.main_wing_spar"
    comp = state.components["main_wing_spar"]
    comp.status = "running_cad"
    emit("component_step", ComponentStepEvent(component_id="main_wing_spar", step="cad", status="running"))

    cad_res = build_spar_cad(state.latest_spar, out_dir=out_dir)
    _merge_metadata(state, cad_res, f"{prefix}.cad")
    comp.cad = cad_res.value
    comp.artifact_urls["step"] = _artifact_url(comp.cad.step_path)
    comp.artifact_urls["stl"] = _artifact_url(comp.cad.stl_path)
    emit("component_step", ComponentStepEvent(component_id="main_wing_spar", step="cad", status="done"))

    comp.status = "running_fea"
    emit("component_step", ComponentStepEvent(component_id="main_wing_spar", step="fea", status="running"))

    fea_res = run_fea(
        spar=state.latest_spar,
        loads=state.latest_loads,
        cad=comp.cad,
        material_key=state.spec.spar_material,
        out_dir=out_dir,
    )
    _merge_metadata(state, fea_res, f"{prefix}.fea")
    comp.fea = fea_res.value
    if comp.fea.stress_mesh_path:
        comp.artifact_urls["stress_mesh"] = _artifact_url(comp.fea.stress_mesh_path)
    comp.status = "completed"
    emit("component_step", ComponentStepEvent(component_id="main_wing_spar", step="fea", status="done"))

    entry = AgentLogEntry(
        lap=state.lap,
        stage="detailed",
        message=(
            f"Detailed Spar FEA complete ({comp.fea.solver_name}): "
            f"Peak von Mises = {comp.fea.fea_max_von_mises_pa / 1e6:.1f} MPa vs "
            f"Beam Theory = {comp.fea.beam_max_stress_pa / 1e6:.1f} MPa "
            f"({comp.fea.stress_agreement_pct:.1f}% agreement)."
        ),
        citations=cad_res.sources + fea_res.sources,
        level="info",
    )
    state.log.append(entry)
    emit("log", LogEvent(entry=entry))
    emit("component_done", ComponentDoneEvent(component_id="main_wing_spar", component=comp, state=state))
    return state
