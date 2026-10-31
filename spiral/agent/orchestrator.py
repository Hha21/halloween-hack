"""Deterministic design spiral orchestrator (Owner: Harry).

Runs the conceptual -> preliminary spar -> weight feedback loop against `spiral.tools`
and populates `DesignState`.
"""

from __future__ import annotations

from typing import Callable

from spiral.agent.gemini import propose_infeasible_relaxation
from spiral.contract import (
    AgentLogEntry,
    DesignState,
    LapRecord,
    MissionSpec,
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


def _merge_metadata(state: DesignState, result: ToolResult) -> None:
    for s in result.sources:
        if s not in state.sources:
            state.sources.append(s)
    for a in result.assumptions:
        if a not in state.assumptions:
            state.assumptions.append(a)
    for w in result.warnings:
        if w not in state.warnings:
            state.warnings.append(w)


def run_design_spiral(
    spec: MissionSpec,
    max_laps: int = 12,
    convergence_tol_pct: float = 0.5,
    on_event: Callable[[str, dict], None] | None = None,
) -> DesignState:
    """Run the conceptual + preliminary wing spar sizing loop until MTOW converges."""
    state = DesignState(spec=spec)

    def emit(event_type: str, payload: dict) -> None:
        if on_event is not None:
            on_event(event_type, payload)

    spar_mass_feedback_kg: float | None = None
    consecutive_growth_laps = 0

    for lap in range(max_laps):
        state.lap = lap
        try:
            sizing_res = conceptual_sizing(spec, spar_mass_kg=spar_mass_feedback_kg)
            _merge_metadata(state, sizing_res)
            sizing = sizing_res.value
            state.latest_sizing = sizing

            loads_res = spar_loads(
                mtow_kg=sizing.mtow_kg,
                span_m=sizing.span_m,
                root_chord_m=sizing.root_chord_m,
                tip_chord_m=sizing.tip_chord_m,
                n_ult=spec.n_ult,
            )
            _merge_metadata(state, loads_res)
            loads = loads_res.value
            state.latest_loads = loads

            spar_res = size_spar(
                loads=loads,
                thickness_to_chord=spec.thickness_to_chord,
                material_key=spec.spar_material,
            )
            _merge_metadata(state, spar_res)
            spar = spar_res.value
            state.latest_spar = spar

            geom_res = aircraft_geometry(spec=spec, sizing=sizing)
            _merge_metadata(state, geom_res)
            geom = geom_res.value
            state.latest_geometry = geom

        except ToolError as exc:
            state.infeasible_reason = exc.message
            state.proposed_relaxation = propose_infeasible_relaxation(state)
            err_entry = AgentLogEntry(
                lap=lap,
                stage="convergence",
                message=f"Infeasible design on lap {lap}: {exc.message}",
                citations=list(state.sources),
                level="error",
            )
            state.log.append(err_entry)
            emit("log", {"entry": err_entry})
            emit(
                "infeasible",
                {
                    "reason": state.infeasible_reason,
                    "proposed_relaxation": state.proposed_relaxation,
                    "state": state,
                },
            )
            return state

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

        log_entry = AgentLogEntry(
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
        state.log.append(log_entry)
        emit("log", {"entry": log_entry})
        emit(
            "lap",
            {
                "lap_record": record,
                "sizing": sizing,
                "spar": spar,
                "geometry": geom,
            },
        )

        # Check convergence after at least 1 feedback lap (lap >= 1)
        if lap >= 1 and abs(mtow_change_pct) < convergence_tol_pct:
            state.converged = True
            done_entry = AgentLogEntry(
                lap=lap,
                stage="convergence",
                message=(
                    f"Converged on lap {lap}: |ΔMTOW| = {abs(mtow_change_pct):.3f}% "
                    f"< {convergence_tol_pct:.2f}% threshold."
                ),
                citations=list(state.sources),
                level="info",
            )
            state.log.append(done_entry)
            emit("log", {"entry": done_entry})
            emit("converged", {"state": state})
            return state

        # Check divergence rule: MTOW grows > 2% for 4 consecutive laps
        if lap >= 1 and mtow_change_pct > 2.0:
            consecutive_growth_laps += 1
        else:
            consecutive_growth_laps = 0

        if consecutive_growth_laps >= 4:
            state.infeasible_reason = (
                "Spiral diverged: MTOW grew by > 2% for 4 consecutive laps."
            )
            state.proposed_relaxation = propose_infeasible_relaxation(state)
            emit(
                "infeasible",
                {
                    "reason": state.infeasible_reason,
                    "proposed_relaxation": state.proposed_relaxation,
                    "state": state,
                },
            )
            return state

        # Feedback computed preliminary spar mass into next lap's conceptual sizing
        spar_mass_feedback_kg = spar.mass_both_wings_kg

    state.infeasible_reason = f"Did not converge within {max_laps} laps."
    state.proposed_relaxation = propose_infeasible_relaxation(state)
    emit(
        "infeasible",
        {
            "reason": state.infeasible_reason,
            "proposed_relaxation": state.proposed_relaxation,
            "state": state,
        },
    )
    return state


def run_spar_detailed_design(
    state: DesignState,
    out_dir: str = "artifacts",
    on_event: Callable[[str, dict], None] | None = None,
) -> DesignState:
    """Run detailed CAD + FEA verification for the main wing spar."""
    if state.latest_spar is None or state.latest_loads is None:
        raise ToolError(
            "Cannot run detailed spar design before preliminary spiral has run.",
            tool_name="run_spar_detailed_design",
            recoverable=False,
        )

    def emit(event_type: str, payload: dict) -> None:
        if on_event is not None:
            on_event(event_type, payload)

    comp = state.components["main_wing_spar"]
    comp.status = "running_cad"
    emit(
        "component_step",
        {"component_id": "main_wing_spar", "step": "cad", "status": "running"},
    )

    cad_res = build_spar_cad(state.latest_spar, out_dir=out_dir)
    _merge_metadata(state, cad_res)
    comp.cad = cad_res.value
    emit(
        "component_step",
        {"component_id": "main_wing_spar", "step": "cad", "status": "done"},
    )

    comp.status = "running_fea"
    emit(
        "component_step",
        {"component_id": "main_wing_spar", "step": "fea", "status": "running"},
    )

    fea_res = run_fea(
        spar=state.latest_spar,
        loads=state.latest_loads,
        cad=comp.cad,
        material_key=state.spec.spar_material,
        out_dir=out_dir,
    )
    _merge_metadata(state, fea_res)
    comp.fea = fea_res.value
    comp.status = "completed"

    log_entry = AgentLogEntry(
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
    state.log.append(log_entry)
    emit("log", {"entry": log_entry})
    emit(
        "component_done",
        {"component_id": "main_wing_spar", "component": comp, "state": state},
    )
    return state
